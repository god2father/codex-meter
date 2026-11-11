//! Claude subscription quota (5-hour and weekly windows), read the same way Claude Code's
//! `/usage` does: an OAuth bearer request to Anthropic's usage endpoint.
//!
//! The credential belongs to Claude Code: the macOS keychain item `Claude Code-credentials`, or
//! `~/.claude/.credentials.json`. Its access token lives about three hours and Claude Code renews
//! it only while it runs, so Meter renews it too — using exactly Claude Code's own protocol:
//!
//! * it takes Claude Code's refresh lock (`~/.claude/.oauth_refresh.lock`, a directory that is
//!   stale after 60 s), so the two never renew at the same moment;
//! * under the lock it re-reads the credential and stops if another process already renewed it;
//! * it posts the same request to the same endpoint, then writes the result back to the same
//!   keychain item through `security -i` (the secret goes over stdin, never on a command line),
//!   keeping every field it does not change.
//!
//! The token never leaves this module: it is not logged, emitted to the webview, or stored
//! anywhere except back where Claude Code keeps it. Both endpoints are undocumented and may
//! change; every failure degrades to a status the UI can explain.

use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
// Values below match Claude Code 2.1.x (its `TOKEN_URL`, `CLIENT_ID` and refresh lock).
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_LOCK: &str = ".oauth_refresh.lock";
const REFRESH_LOCK_STALE: Duration = Duration::from_secs(60);
/// After a failed renewal, leave the credential alone for a while instead of hammering it.
const REFRESH_FAILURE_BACKOFF: Duration = Duration::from_secs(600);
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// `security -i` reads one command line; keep well under its buffer.
#[cfg(target_os = "macos")]
const SECURITY_STDIN_LIMIT: usize = 4000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used_percent: f64,
    pub remaining_percent: f64,
    /// Unix seconds, when Anthropic reports it.
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuotaSnapshot {
    /// ok | no_credentials | expired | unauthorized | rate_limited | error
    pub status: String,
    pub plan: Option<String>,
    pub five_hour: Option<QuotaWindow>,
    pub seven_day: Option<QuotaWindow>,
    pub seven_day_opus: Option<QuotaWindow>,
    pub seven_day_sonnet: Option<QuotaWindow>,
    pub fetched_at: i64,
    pub message: Option<String>,
}

impl ClaudeQuotaSnapshot {
    fn failed(status: &str, plan: Option<String>, message: &str) -> Self {
        Self {
            status: status.into(),
            plan,
            five_hour: None,
            seven_day: None,
            seven_day_opus: None,
            seven_day_sonnet: None,
            fetched_at: unix_now(),
            message: Some(message.into()),
        }
    }

    pub fn succeeded(&self) -> bool {
        self.status == "ok"
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Store {
    #[cfg(target_os = "macos")]
    Keychain {
        account: String,
    },
    File(PathBuf),
}

#[derive(Clone, Debug)]
struct Credential {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_ms: Option<u64>,
    scopes: Vec<String>,
    client_id: Option<String>,
    plan: Option<String>,
    /// The whole stored document, so a write-back preserves fields Meter does not know about.
    document: Value,
    store: Store,
}

impl Credential {
    fn looks_expired(&self) -> bool {
        self.expires_at_ms
            .is_some_and(|expires| expires <= unix_now().max(0) as u64 * 1000)
    }
}

enum Renewal {
    Renewed(Credential),
    /// Claude Code is renewing right now; try again on the next tick.
    Busy,
    Failed(&'static str),
}

pub struct ClaudeQuotaService {
    client: Option<reqwest::blocking::Client>,
    last_refresh_failure: Option<Instant>,
}

impl ClaudeQuotaService {
    pub fn new() -> Self {
        Self {
            client: None,
            last_refresh_failure: None,
        }
    }

    fn client(&mut self) -> Option<reqwest::blocking::Client> {
        if self.client.is_none() {
            self.client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(20))
                .user_agent(concat!("codex-meter/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok();
        }
        self.client.clone()
    }

    pub fn fetch(&mut self) -> ClaudeQuotaSnapshot {
        let Some(mut credential) = read_credential() else {
            return ClaudeQuotaSnapshot::failed(
                "no_credentials",
                None,
                "未找到 Claude Code 登录信息：请在终端安装并登录 claude 命令行",
            );
        };
        let Some(client) = self.client() else {
            return ClaudeQuotaSnapshot::failed("error", credential.plan, "无法创建网络连接");
        };
        // Renew up front when the token is plainly expired; otherwise let a 401 trigger it.
        let mut renewed = false;
        if credential.looks_expired() {
            match self.renew(&client, &credential) {
                Renewal::Renewed(next) => {
                    credential = next;
                    renewed = true;
                }
                Renewal::Busy => {}
                Renewal::Failed(message) => {
                    return ClaudeQuotaSnapshot::failed("expired", credential.plan, message)
                }
            }
        }
        loop {
            let response = client
                .get(USAGE_URL)
                .bearer_auth(&credential.access_token)
                .header("anthropic-beta", OAUTH_BETA)
                .header("accept", "application/json")
                .send();
            let response = match response {
                Ok(response) => response,
                Err(_) => {
                    return ClaudeQuotaSnapshot::failed(
                        "error",
                        credential.plan,
                        "无法连接 Anthropic",
                    )
                }
            };
            match response.status().as_u16() {
                200 => {
                    return match response.json::<Value>() {
                        Ok(value) => parse_usage(&value, credential.plan),
                        Err(_) => ClaudeQuotaSnapshot::failed(
                            "error",
                            credential.plan,
                            "额度数据格式无法识别",
                        ),
                    }
                }
                401 | 403 if !renewed => match self.renew(&client, &credential) {
                    Renewal::Renewed(next) => {
                        credential = next;
                        renewed = true;
                    }
                    Renewal::Busy => {
                        return ClaudeQuotaSnapshot::failed(
                            "expired",
                            credential.plan,
                            "Claude Code 正在续期登录，稍后自动重试",
                        )
                    }
                    Renewal::Failed(message) => {
                        return ClaudeQuotaSnapshot::failed("expired", credential.plan, message)
                    }
                },
                401 | 403 => {
                    return ClaudeQuotaSnapshot::failed(
                        "unauthorized",
                        credential.plan,
                        "Claude Code 登录已失效：请在终端重新登录 claude",
                    )
                }
                429 => {
                    return ClaudeQuotaSnapshot::failed(
                        "rate_limited",
                        credential.plan,
                        "查询过于频繁，稍后自动重试",
                    )
                }
                code => {
                    return ClaudeQuotaSnapshot::failed(
                        "error",
                        credential.plan,
                        &format!("Anthropic 返回了 {code}"),
                    )
                }
            }
        }
    }

    /// Renews the access token the way Claude Code does. `stale` is the credential whose token
    /// was rejected or expired.
    fn renew(&mut self, client: &reqwest::blocking::Client, stale: &Credential) -> Renewal {
        if self
            .last_refresh_failure
            .is_some_and(|at| at.elapsed() < REFRESH_FAILURE_BACKOFF)
        {
            return Renewal::Failed("Claude Code 的登录续期失败，请在终端运行一次 claude");
        }
        let Some(lock) = RefreshLock::acquire(&claude_config_dir()) else {
            return Renewal::Busy;
        };
        let result = self.renew_locked(client, stale);
        drop(lock);
        if matches!(result, Renewal::Failed(_)) {
            self.last_refresh_failure = Some(Instant::now());
        }
        result
    }

    fn renew_locked(&mut self, client: &reqwest::blocking::Client, stale: &Credential) -> Renewal {
        // Another process may have renewed while we waited for the lock.
        let Some(current) = read_credential() else {
            return Renewal::Failed("未找到 Claude Code 登录信息");
        };
        if current.access_token != stale.access_token {
            return Renewal::Renewed(current);
        }
        let Some(refresh_token) = current.refresh_token.clone() else {
            return Renewal::Failed("Claude Code 登录不支持自动续期：请在终端重新登录 claude");
        };
        let body = serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": current.client_id.as_deref().unwrap_or(CLAUDE_CODE_CLIENT_ID),
            "scope": current.scopes.join(" "),
        });
        let response = client
            .post(TOKEN_URL)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .json(&body)
            .send();
        let Ok(response) = response else {
            return Renewal::Failed("无法连接 Anthropic 续期登录");
        };
        if !response.status().is_success() {
            return Renewal::Failed("Claude Code 登录续期被拒绝：请在终端重新登录 claude");
        }
        let Ok(tokens) = response.json::<Value>() else {
            return Renewal::Failed("续期结果无法识别");
        };
        let Some(next) = renewed_document(&current.document, &tokens, unix_now()) else {
            return Renewal::Failed("续期结果缺少访问令牌");
        };
        if write_document(&current.store, &next).is_err() {
            // The server already rotated the refresh token; without saving it Claude Code would
            // be signed out, so treat this as a hard failure and say so.
            return Renewal::Failed("续期成功但无法写回钥匙串：请在终端运行一次 claude");
        }
        match parse_credential(next.to_string().as_bytes(), current.store) {
            Some(credential) => Renewal::Renewed(credential),
            None => Renewal::Failed("续期结果无法识别"),
        }
    }
}

/// Applies a token response to the stored document, keeping every other field.
fn renewed_document(document: &Value, tokens: &Value, now_secs: i64) -> Option<Value> {
    let access_token = tokens.get("access_token")?.as_str()?.trim();
    if access_token.is_empty() {
        return None;
    }
    let mut next = document.clone();
    let oauth = next.get_mut("claudeAiOauth")?.as_object_mut()?;
    oauth.insert("accessToken".into(), access_token.into());
    if let Some(refresh) = tokens.get("refresh_token").and_then(Value::as_str) {
        oauth.insert("refreshToken".into(), refresh.into());
    }
    if let Some(expires_in) = tokens.get("expires_in").and_then(Value::as_i64) {
        let expires_at = (now_secs + expires_in.clamp(60, 7 * 86_400)) * 1000;
        oauth.insert("expiresAt".into(), expires_at.into());
    }
    if let Some(expires_in) = tokens
        .get("refresh_token_expires_in")
        .and_then(Value::as_i64)
    {
        if expires_in > 0 {
            oauth.insert(
                "refreshTokenExpiresAt".into(),
                ((now_secs + expires_in) * 1000).into(),
            );
        }
    }
    if let Some(scope) = tokens.get("scope").and_then(Value::as_str) {
        let scopes: Vec<Value> = scope.split_whitespace().map(Value::from).collect();
        if !scopes.is_empty() {
            oauth.insert("scopes".into(), Value::Array(scopes));
        }
    }
    Some(next)
}

/// Claude Code's refresh lock: a directory created atomically, treated as abandoned after 60 s.
struct RefreshLock(PathBuf);

impl RefreshLock {
    fn acquire(config_dir: &Path) -> Option<Self> {
        let _ = fs::create_dir_all(config_dir);
        let path = config_dir.join(REFRESH_LOCK);
        for _ in 0..2 {
            match fs::create_dir(&path) {
                Ok(()) => return Some(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let abandoned = fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > REFRESH_LOCK_STALE);
                    if !abandoned || fs::remove_dir_all(&path).is_err() {
                        return None;
                    }
                }
                Err(_) => return None,
            }
        }
        None
    }
}

impl Drop for RefreshLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn claude_config_dir() -> PathBuf {
    match env::var_os("CLAUDE_CONFIG_DIR") {
        Some(value) if !value.is_empty() => env::split_paths(&value)
            .next()
            .unwrap_or_else(|| PathBuf::from(value)),
        _ => crate::claude_usage::home_dir()
            .map(|home| PathBuf::from(home).join(".claude"))
            .unwrap_or_else(|| PathBuf::from(".claude")),
    }
}

fn parse_usage(value: &Value, plan: Option<String>) -> ClaudeQuotaSnapshot {
    let window = |key: &str| value.get(key).and_then(parse_window);
    let snapshot = ClaudeQuotaSnapshot {
        status: "ok".into(),
        plan,
        five_hour: window("five_hour"),
        seven_day: window("seven_day"),
        seven_day_opus: window("seven_day_opus"),
        seven_day_sonnet: window("seven_day_sonnet"),
        fetched_at: unix_now(),
        message: None,
    };
    if snapshot.five_hour.is_none() && snapshot.seven_day.is_none() {
        return ClaudeQuotaSnapshot::failed("error", snapshot.plan, "Anthropic 未返回额度窗口");
    }
    snapshot
}

fn parse_window(value: &Value) -> Option<QuotaWindow> {
    // `utilization` is a percentage (0-100) of the window already used.
    let used = value.get("utilization")?.as_f64()?;
    if !used.is_finite() {
        return None;
    }
    let used = used.clamp(0.0, 100.0);
    let resets_at = match value.get("resets_at") {
        Some(Value::String(text)) => crate::claude_usage::parse_iso_utc(text),
        Some(Value::Number(number)) => number.as_i64().map(|raw| {
            // Accept seconds or milliseconds.
            if raw > 10_000_000_000 {
                raw / 1000
            } else {
                raw
            }
        }),
        _ => None,
    };
    Some(QuotaWindow {
        used_percent: used,
        remaining_percent: 100.0 - used,
        resets_at,
    })
}

fn read_credential() -> Option<Credential> {
    #[cfg(target_os = "macos")]
    if let Some(credential) = keychain_credential() {
        return Some(credential);
    }
    file_credential()
}

#[cfg(target_os = "macos")]
fn keychain_account() -> Option<String> {
    env::var("USER")
        .ok()
        .or_else(|| env::var("LOGNAME").ok())
        .filter(|user| !user.is_empty() && !user.contains('"'))
}

/// Reads the generic password Claude Code stores on macOS, with the same `security` tool it uses.
#[cfg(target_os = "macos")]
fn keychain_credential() -> Option<Credential> {
    let account = keychain_account()?;
    let output = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &account,
            "-w",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_credential(&output.stdout, Store::Keychain { account })
}

fn file_credential() -> Option<Credential> {
    let path = claude_config_dir().join(".credentials.json");
    let bytes = fs::read(&path).ok()?;
    parse_credential(&bytes, Store::File(path))
}

fn write_document(store: &Store, document: &Value) -> Result<(), ()> {
    let json = serde_json::to_string(document).map_err(|_| ())?;
    match store {
        #[cfg(target_os = "macos")]
        Store::Keychain { account } => {
            use std::io::Write;
            let hex: String = json.bytes().map(|b| format!("{b:02x}")).collect();
            let command = keychain_update_command(account, &hex);
            if command.len() > SECURITY_STDIN_LIMIT {
                return Err(());
            }
            let mut child = std::process::Command::new("/usr/bin/security")
                .arg("-i")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|_| ())?;
            child
                .stdin
                .take()
                .ok_or(())?
                .write_all(command.as_bytes())
                .map_err(|_| ())?;
            let status = child.wait().map_err(|_| ())?;
            if !status.success() {
                return Err(());
            }
            // `security -i` can exit 0 after a failed command; confirm by reading it back.
            match keychain_credential() {
                Some(saved) if saved.document == *document => Ok(()),
                _ => Err(()),
            }
        }
        Store::File(path) => {
            let staged = path.with_extension(format!("json.meter-{}", std::process::id()));
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            {
                use std::io::Write;
                let mut file = options.open(&staged).map_err(|_| ())?;
                file.write_all(json.as_bytes()).map_err(|_| ())?;
                file.sync_all().map_err(|_| ())?;
            }
            fs::rename(&staged, path).map_err(|_| {
                let _ = fs::remove_file(&staged);
            })
        }
    }
}

/// The exact command Claude Code sends to `security -i` when it updates its credential.
#[cfg(target_os = "macos")]
fn keychain_update_command(account: &str, hex: &str) -> String {
    format!("add-generic-password -U -a \"{account}\" -s \"{KEYCHAIN_SERVICE}\" -X \"{hex}\"\n")
}

fn parse_credential(bytes: &[u8], store: Store) -> Option<Credential> {
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let document: Value = serde_json::from_slice(trim_ascii(bytes)).ok()?;
    let oauth = document.get("claudeAiOauth")?;
    let text = |key: &str| {
        oauth
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let access_token = text("accessToken")?;
    Some(Credential {
        access_token,
        refresh_token: text("refreshToken"),
        expires_at_ms: oauth.get("expiresAt").and_then(Value::as_u64),
        scopes: oauth
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        client_id: text("clientId"),
        plan: text("subscriptionType"),
        document: document.clone(),
        store,
    })
}

fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |end| end + 1);
    &bytes[start..end]
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_credential_without_exposing_extra_fields() {
        let raw = br#"
            {"claudeAiOauth":{"accessToken":"test-token","refreshToken":"r","expiresAt":1893456000000,
             "scopes":["user:inference","user:profile"],"subscriptionType":"max"}}
        "#;
        let credential = parse_credential(raw, Store::File(PathBuf::from("x"))).unwrap();
        assert_eq!(credential.access_token, "test-token");
        assert_eq!(credential.expires_at_ms, Some(1_893_456_000_000));
        assert_eq!(credential.plan.as_deref(), Some("max"));
        assert_eq!(credential.refresh_token.as_deref(), Some("r"));
        assert_eq!(credential.scopes, ["user:inference", "user:profile"]);
        let store = || Store::File(PathBuf::from("x"));
        assert!(parse_credential(br#"{"other":{}}"#, store()).is_none());
        assert!(parse_credential(br#"{"claudeAiOauth":{"accessToken":"  "}}"#, store()).is_none());
    }

    #[test]
    fn parses_usage_windows_and_reset_formats() {
        let value = serde_json::json!({
            "five_hour": { "utilization": 12.5, "resets_at": "2026-11-10T18:00:00.123456+00:00" },
            "seven_day": { "utilization": 140.0, "resets_at": "2026-11-14T00:00:00Z" },
            "seven_day_opus": { "utilization": 3.0, "resets_at": 1_794_000_000_000_i64 },
            "seven_day_sonnet": null
        });
        let snapshot = parse_usage(&value, Some("pro".into()));
        assert!(snapshot.succeeded());
        let five = snapshot.five_hour.unwrap();
        assert_eq!(five.remaining_percent, 87.5);
        assert_eq!(
            five.resets_at,
            crate::claude_usage::parse_iso_utc("2026-11-10T18:00:00Z")
        );
        let week = snapshot.seven_day.unwrap();
        assert_eq!(week.used_percent, 100.0, "utilization is clamped");
        assert_eq!(
            snapshot.seven_day_opus.unwrap().resets_at,
            Some(1_794_000_000)
        );
        assert!(snapshot.seven_day_sonnet.is_none());
        assert_eq!(snapshot.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn missing_windows_is_an_error_status() {
        let snapshot = parse_usage(&serde_json::json!({ "extra_usage": {} }), None);
        assert_eq!(snapshot.status, "error");
        assert!(snapshot.message.is_some());
    }

    #[test]
    fn renewal_updates_tokens_and_keeps_unknown_fields() {
        let document = serde_json::json!({
            "claudeAiOauth": { "accessToken": "old", "refreshToken": "r1", "expiresAt": 1,
                "scopes": ["user:inference"], "subscriptionType": "pro", "rateLimitTier": "t" },
            "otherTool": { "keep": true }
        });
        let tokens = serde_json::json!({ "access_token": "new", "refresh_token": "r2",
            "expires_in": 28800, "refresh_token_expires_in": 86400, "scope": "user:inference user:profile" });
        let next = renewed_document(&document, &tokens, 1_000).unwrap();
        let oauth = &next["claudeAiOauth"];
        assert_eq!(oauth["accessToken"], "new");
        assert_eq!(oauth["refreshToken"], "r2");
        assert_eq!(oauth["expiresAt"], (1_000 + 28_800) * 1000);
        assert_eq!(
            oauth["scopes"],
            serde_json::json!(["user:inference", "user:profile"])
        );
        assert_eq!(oauth["refreshTokenExpiresAt"], (1_000 + 86_400) * 1000);
        assert_eq!(oauth["rateLimitTier"], "t");
        assert_eq!(next["otherTool"]["keep"], true);
        // A response without a new refresh token keeps the old one.
        let kept =
            renewed_document(&document, &serde_json::json!({ "access_token": "n" }), 0).unwrap();
        assert_eq!(kept["claudeAiOauth"]["refreshToken"], "r1");
        assert!(renewed_document(&document, &serde_json::json!({}), 0).is_none());
    }

    #[test]
    fn refresh_lock_is_exclusive_and_recovers_abandoned_locks() {
        let dir = std::env::temp_dir().join(format!(
            "codex-meter-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let first = RefreshLock::acquire(&dir).expect("first lock");
        assert!(
            RefreshLock::acquire(&dir).is_none(),
            "a held lock blocks others"
        );
        drop(first);
        assert!(!dir.join(REFRESH_LOCK).exists());
        let second = RefreshLock::acquire(&dir).expect("lock after release");
        std::mem::forget(second);
        let old = SystemTime::now() - Duration::from_secs(120);
        open_directory_for_times(&dir.join(REFRESH_LOCK))
            .and_then(|file| file.set_modified(old))
            .unwrap();
        assert!(
            RefreshLock::acquire(&dir).is_some(),
            "abandoned lock is taken over"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Directories need backup semantics to be opened on Windows.
    fn open_directory_for_times(path: &Path) -> std::io::Result<fs::File> {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
            fs::OpenOptions::new()
                .access_mode(FILE_WRITE_ATTRIBUTES)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
        }
        #[cfg(not(windows))]
        {
            fs::File::open(path)
        }
    }

    #[test]
    fn file_store_round_trip_keeps_private_permissions() {
        let dir = std::env::temp_dir().join(format!("codex-meter-cred-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".credentials.json");
        let document = serde_json::json!({ "claudeAiOauth": { "accessToken": "a" } });
        write_document(&Store::File(path.clone()), &document).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
            document
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_command_matches_claude_code() {
        assert_eq!(
            keychain_update_command("me", "7b7d"),
            "add-generic-password -U -a \"me\" -s \"Claude Code-credentials\" -X \"7b7d\"\n"
        );
    }
}

#[cfg(test)]
mod live {
    /// Manual check against the real endpoint with this machine's Claude Code login.
    /// Prints only the status and percentages, never the credential.
    #[test]
    #[ignore]
    fn live_quota_probe() {
        let snapshot = super::ClaudeQuotaService::new().fetch();
        println!(
            "status={} plan={:?} five_hour={:?} seven_day={:?} opus={:?} message={:?}",
            snapshot.status,
            snapshot.plan,
            snapshot
                .five_hour
                .map(|w| (w.remaining_percent, w.resets_at)),
            snapshot
                .seven_day
                .map(|w| (w.remaining_percent, w.resets_at)),
            snapshot.seven_day_opus.map(|w| w.remaining_percent),
            snapshot.message
        );
    }
}
