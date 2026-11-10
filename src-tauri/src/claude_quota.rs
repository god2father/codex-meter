//! Claude subscription quota (5-hour and weekly windows), read the same way Claude Code's
//! `/usage` does: an OAuth bearer request to Anthropic's usage endpoint.
//!
//! The credential belongs to Claude Code. Meter only reads it — from the macOS keychain item
//! `Claude Code-credentials`, or from `~/.claude/.credentials.json` — and never refreshes or
//! writes it, so it cannot invalidate the token Claude Code itself is using. The token never
//! leaves this module: it is not logged, emitted to the webview, or stored.
//!
//! The endpoint is not publicly documented and may change; every failure degrades to a status
//! the UI can explain instead of an error.

use serde::Serialize;
use serde_json::Value;
use std::{
    env,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

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

struct Credential {
    access_token: String,
    expires_at_ms: Option<u64>,
    plan: Option<String>,
}

pub struct ClaudeQuotaService {
    client: Option<reqwest::blocking::Client>,
}

impl ClaudeQuotaService {
    pub fn new() -> Self {
        Self { client: None }
    }

    pub fn fetch(&mut self) -> ClaudeQuotaSnapshot {
        let Some(credential) = read_credential() else {
            return ClaudeQuotaSnapshot::failed(
                "no_credentials",
                None,
                "未找到 Claude Code 登录信息：请在终端安装并登录 claude 命令行",
            );
        };
        let now_ms = unix_now().max(0) as u64 * 1000;
        if credential
            .expires_at_ms
            .is_some_and(|expires| expires <= now_ms)
        {
            return ClaudeQuotaSnapshot::failed(
                "expired",
                credential.plan,
                "Claude Code 登录已过期：在终端运行一次 claude 即可自动续期",
            );
        }
        let client = match self.client.as_ref() {
            Some(client) => client.clone(),
            None => {
                let Ok(client) = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(10))
                    .user_agent(concat!("codex-meter/", env!("CARGO_PKG_VERSION")))
                    .build()
                else {
                    return ClaudeQuotaSnapshot::failed(
                        "error",
                        credential.plan,
                        "无法创建网络连接",
                    );
                };
                self.client = Some(client.clone());
                client
            }
        };
        let response = client
            .get(USAGE_URL)
            .bearer_auth(&credential.access_token)
            .header("anthropic-beta", OAUTH_BETA)
            .header("accept", "application/json")
            .send();
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                return ClaudeQuotaSnapshot::failed("error", credential.plan, "无法连接 Anthropic")
            }
        };
        match response.status().as_u16() {
            200 => {}
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
        match response.json::<Value>() {
            Ok(value) => parse_usage(&value, credential.plan),
            Err(_) => ClaudeQuotaSnapshot::failed("error", credential.plan, "额度数据格式无法识别"),
        }
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

/// Reads the generic password Claude Code stores on macOS. Uses the system `security` tool, the
/// same one Claude Code writes with, so the keychain's access rules apply as usual.
#[cfg(target_os = "macos")]
fn keychain_credential() -> Option<Credential> {
    let account = env::var("USER").ok().filter(|user| !user.is_empty());
    let mut command = std::process::Command::new("/usr/bin/security");
    command.args(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
    if let Some(account) = &account {
        command.args(["-a", account]);
    }
    let output = command
        .arg("-w")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_credential(&output.stdout)
}

fn file_credential() -> Option<Credential> {
    let roots: Vec<PathBuf> = match env::var_os("CLAUDE_CONFIG_DIR") {
        Some(value) if !value.is_empty() => env::split_paths(&value).collect(),
        _ => env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(|home| vec![PathBuf::from(home).join(".claude")])
            .unwrap_or_default(),
    };
    roots.iter().find_map(|root| {
        let bytes = std::fs::read(root.join(".credentials.json")).ok()?;
        parse_credential(&bytes)
    })
}

fn parse_credential(bytes: &[u8]) -> Option<Credential> {
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_slice(trim_ascii(bytes)).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken")?.as_str()?.trim().to_owned();
    if access_token.is_empty() {
        return None;
    }
    Some(Credential {
        access_token,
        expires_at_ms: oauth.get("expiresAt").and_then(Value::as_u64),
        plan: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .filter(|plan| !plan.is_empty())
            .map(str::to_owned),
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
        let credential = parse_credential(raw).unwrap();
        assert_eq!(credential.access_token, "test-token");
        assert_eq!(credential.expires_at_ms, Some(1_893_456_000_000));
        assert_eq!(credential.plan.as_deref(), Some("max"));
        assert!(parse_credential(br#"{"other":{}}"#).is_none());
        assert!(parse_credential(br#"{"claudeAiOauth":{"accessToken":"  "}}"#).is_none());
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
}
