//! Antigravity quota reader using the local `language_server` ConnectRPC endpoint.
//!
//! Antigravity's desktop hub writes discovery metadata (`pid`, `httpPort`, `lsVersion`,
//! `csrfToken`) under `~/.gemini/antigravity/daemon/*.json`. Meter reads the local
//! `GetUserStatus` RPC over loopback (`127.0.0.1`, bypassing system proxies) to display
//! real per-model / shared-pool remaining fractions and reset timestamps.
//!
//! Secrets (`csrfToken`) and account identifiers (`name`, `email`, `profilePictureUrl`)
//! never leave this module. The RPC protocol is undocumented and tied to Antigravity's
//! local language server (verified on Antigravity 2.34.0); every failure degrades to a
//! clear UI status.

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const GET_USER_STATUS_PATH: &str = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DISCOVERY_BYTES: u64 = 64 * 1024;
const FRACTION_SCALE: f64 = 1_000_000.0;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityModelQuota {
    pub label: String,
    pub model_id: Option<String>,
    /// Remaining quota percentage (0.0–100.0). `None` when the backend omits it.
    pub remaining_percent: Option<f64>,
    pub used_percent: Option<f64>,
    /// Unix seconds parsed from `quotaInfo.resetTime`.
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaGroup {
    pub id: String,
    pub label: String,
    /// Shared remaining percentage (0.0–100.0) when every model in the group reports the same value.
    pub remaining_percent: Option<f64>,
    pub used_percent: Option<f64>,
    pub resets_at: Option<i64>,
    /// Distinct base model names in this group, in server order.
    pub models: Vec<String>,
    /// Raw model config entries collapsed into this group (including thinking tiers).
    pub model_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravitySnapshot {
    /// ok | limit_reached | not_installed | not_running | signed_out | no_data | rate_limited | error
    pub status: String,
    pub plan: Option<String>,
    pub ai_credits: Option<i64>,
    pub version: Option<String>,
    pub groups: Vec<AntigravityQuotaGroup>,
    pub models: Vec<AntigravityModelQuota>,
    pub fetched_at: i64,
    pub message: Option<String>,
}

impl AntigravitySnapshot {
    fn with_status(status: &str, version: Option<String>, message: impl Into<String>) -> Self {
        Self {
            status: status.into(),
            plan: None,
            ai_credits: None,
            version,
            groups: Vec::new(),
            models: Vec::new(),
            fetched_at: unix_now(),
            message: Some(message.into()),
        }
    }

    pub fn succeeded(&self) -> bool {
        matches!(self.status.as_str(), "ok" | "limit_reached")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DaemonEndpoint {
    pid: Option<u32>,
    http_port: u16,
    ls_version: Option<String>,
    csrf_token: String,
    modified_secs: u64,
}

pub struct AntigravityService {
    client: Option<reqwest::blocking::Client>,
}

impl AntigravityService {
    pub fn new() -> Self {
        Self { client: None }
    }

    fn client(&mut self) -> Option<reqwest::blocking::Client> {
        if self.client.is_none() {
            // Loopback requests must bypass system HTTP/SOCKS proxies.
            self.client = reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(REQUEST_TIMEOUT)
                .user_agent(concat!("codex-meter/", env!("CARGO_PKG_VERSION")))
                .build()
                .ok();
        }
        self.client.clone()
    }

    pub fn fetch(&mut self) -> AntigravitySnapshot {
        let daemon_dir = daemon_dir();
        let endpoints = discover_endpoints(&daemon_dir);
        if endpoints.is_empty() {
            return unavailable_without_daemon();
        }
        let Some(client) = self.client() else {
            return AntigravitySnapshot::with_status("error", None, "无法创建本机网络连接");
        };

        let mut last_error: Option<AntigravitySnapshot> = None;
        let mut had_connection_failure = false;
        for endpoint in endpoints {
            match self.fetch_endpoint(&client, &endpoint) {
                EndpointOutcome::Response(snapshot) => return snapshot,
                EndpointOutcome::Unreachable => {
                    had_connection_failure = true;
                }
                EndpointOutcome::Failed(snapshot) => {
                    last_error = Some(snapshot);
                }
            }
        }

        if let Some(snapshot) = last_error {
            return snapshot;
        }
        if had_connection_failure {
            return AntigravitySnapshot::with_status(
                "not_running",
                None,
                "Antigravity 后台服务未响应，请先打开 Antigravity",
            );
        }
        unavailable_without_daemon()
    }

    fn fetch_endpoint(
        &self,
        client: &reqwest::blocking::Client,
        endpoint: &DaemonEndpoint,
    ) -> EndpointOutcome {
        let url = format!(
            "http://127.0.0.1:{}{GET_USER_STATUS_PATH}",
            endpoint.http_port
        );
        let body = json!({
            "metadata": {
                "ideName": "antigravity",
                "extensionName": "antigravity",
                "locale": "en"
            }
        });
        let response = client
            .post(&url)
            .header("content-type", "application/json")
            .header("connect-protocol-version", "1")
            .header("x-codeium-csrf-token", &endpoint.csrf_token)
            .json(&body)
            .send();

        let response = match response {
            Ok(response) => response,
            Err(error) if error.is_connect() => return EndpointOutcome::Unreachable,
            Err(error) if error.is_timeout() => {
                return EndpointOutcome::Failed(AntigravitySnapshot::with_status(
                    "error",
                    endpoint.ls_version.clone(),
                    "连接本机 Antigravity 超时",
                ));
            }
            Err(_) => {
                return EndpointOutcome::Failed(AntigravitySnapshot::with_status(
                    "error",
                    endpoint.ls_version.clone(),
                    "无法连接本机 Antigravity 服务",
                ));
            }
        };

        let status_code = response.status().as_u16();
        match status_code {
            200 => match response.json::<Value>() {
                Ok(value) => EndpointOutcome::Response(parse_user_status(
                    &value,
                    endpoint.ls_version.clone(),
                    unix_now(),
                )),
                Err(_) => EndpointOutcome::Failed(AntigravitySnapshot::with_status(
                    "error",
                    endpoint.ls_version.clone(),
                    "Antigravity 返回了无法识别的数据格式",
                )),
            },
            401 | 403 => EndpointOutcome::Response(AntigravitySnapshot::with_status(
                "signed_out",
                endpoint.ls_version.clone(),
                "Antigravity 尚未登录或登录已失效，请在应用中重新登录",
            )),
            429 => EndpointOutcome::Response(AntigravitySnapshot::with_status(
                "rate_limited",
                endpoint.ls_version.clone(),
                "Antigravity 配额查询过于频繁，稍后自动重试",
            )),
            code => {
                let connect_code = response
                    .json::<Value>()
                    .ok()
                    .and_then(|value| value.get("code").and_then(Value::as_str).map(str::to_owned));
                if matches!(
                    connect_code.as_deref(),
                    Some("unauthenticated" | "permission_denied")
                ) {
                    return EndpointOutcome::Response(AntigravitySnapshot::with_status(
                        "signed_out",
                        endpoint.ls_version.clone(),
                        "Antigravity 尚未登录，请先在应用中登录账号",
                    ));
                }
                if connect_code.as_deref() == Some("resource_exhausted") {
                    return EndpointOutcome::Response(AntigravitySnapshot::with_status(
                        "rate_limited",
                        endpoint.ls_version.clone(),
                        "Antigravity 配额查询过于频繁，稍后自动重试",
                    ));
                }
                EndpointOutcome::Failed(AntigravitySnapshot::with_status(
                    "error",
                    endpoint.ls_version.clone(),
                    format!("Antigravity 本地服务返回了 {code}"),
                ))
            }
        }
    }
}

enum EndpointOutcome {
    Response(AntigravitySnapshot),
    Unreachable,
    Failed(AntigravitySnapshot),
}

fn daemon_dir() -> PathBuf {
    if let Some(override_dir) = env::var_os("CODEX_METER_ANTIGRAVITY_DAEMON_DIR") {
        if !override_dir.is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    antigravity_data_dir().join("daemon")
}

fn antigravity_data_dir() -> PathBuf {
    crate::claude_usage::home_dir()
        .map(|home| PathBuf::from(home).join(".gemini").join("antigravity"))
        .unwrap_or_else(|| PathBuf::from(".gemini").join("antigravity"))
}

fn is_installed() -> bool {
    if antigravity_data_dir().exists() {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/Antigravity.app").exists() {
            return true;
        }
        if let Some(home) = crate::claude_usage::home_dir() {
            if Path::new(&home)
                .join("Applications")
                .join("Antigravity.app")
                .exists()
            {
                return true;
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = env::var("LOCALAPPDATA") {
            let root = Path::new(&local).join("Programs").join("Antigravity");
            if root.exists() {
                return true;
            }
        }
    }
    false
}

fn unavailable_without_daemon() -> AntigravitySnapshot {
    if is_installed() {
        AntigravitySnapshot::with_status(
            "not_running",
            None,
            "Antigravity 未运行，打开应用后会自动同步额度",
        )
    } else {
        AntigravitySnapshot::with_status(
            "not_installed",
            None,
            "未检测到本机 Antigravity，请先安装并登录",
        )
    }
}

fn discover_endpoints(directory: &Path) -> Vec<DaemonEndpoint> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut endpoints = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_DISCOVERY_BYTES {
            continue;
        }
        let modified_secs = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        if let Some(endpoint) = parse_daemon_discovery(&bytes, modified_secs) {
            endpoints.push(endpoint);
        }
    }
    // Prefer endpoints whose recorded PID is alive, then newest discovery file first.
    endpoints.sort_by(|a, b| {
        let a_alive = a.pid.is_none_or(pid_is_alive);
        let b_alive = b.pid.is_none_or(pid_is_alive);
        b_alive
            .cmp(&a_alive)
            .then_with(|| b.modified_secs.cmp(&a.modified_secs))
    });
    endpoints
}

fn parse_daemon_discovery(bytes: &[u8], modified_secs: u64) -> Option<DaemonEndpoint> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let http_port = value
        .get("httpPort")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)?;
    let csrf_token = value
        .get("csrfToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())?
        .to_owned();
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0);
    let ls_version = value
        .get("lsVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_owned);
    Some(DaemonEndpoint {
        pid,
        http_port,
        ls_version,
        csrf_token,
        modified_secs,
    })
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // Signal 0 checks process existence without sending a signal.
    let result = unsafe { kill(pid, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(1) // EPERM still means process exists
}

#[cfg(not(unix))]
fn pid_is_alive(_pid: u32) -> bool {
    true
}

#[derive(Clone, Debug)]
struct RawModelEntry {
    label: String,
    base_label: String,
    model_id: Option<String>,
    family: ModelFamily,
    remaining_percent: Option<f64>,
    used_percent: Option<f64>,
    /// Quantized fraction key (1e-6 precision) so only strictly identical quotas group together.
    fraction_key: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum ModelFamily {
    Google,
    Partner,
    Other(String),
}

fn parse_user_status(
    value: &Value,
    version: Option<String>,
    fetched_at: i64,
) -> AntigravitySnapshot {
    let Some(user_status) = value.get("userStatus").and_then(Value::as_object) else {
        return AntigravitySnapshot {
            status: "signed_out".into(),
            plan: None,
            ai_credits: None,
            version,
            groups: Vec::new(),
            models: Vec::new(),
            fetched_at,
            message: Some("Antigravity 尚未登录或未返回账户状态".into()),
        };
    };

    let plan = extract_plan(user_status);
    let ai_credits = extract_ai_credits(user_status);
    let configs = user_status
        .get("cascadeModelConfigData")
        .and_then(|data| data.get("clientModelConfigs"))
        .and_then(Value::as_array);

    let has_identity_or_plan = user_status.contains_key("userTier")
        || user_status.contains_key("planStatus")
        || user_status
            .get("email")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
        || configs.is_some_and(|items| !items.is_empty());

    if !has_identity_or_plan {
        return AntigravitySnapshot {
            status: "signed_out".into(),
            plan,
            ai_credits,
            version,
            groups: Vec::new(),
            models: Vec::new(),
            fetched_at,
            message: Some("Antigravity 尚未登录，请先在应用中登录账号".into()),
        };
    }

    let raw_models = configs
        .map(|items| {
            items
                .iter()
                .filter_map(parse_model_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let has_any_quota = raw_models
        .iter()
        .any(|model| model.remaining_percent.is_some() || model.resets_at.is_some());

    if raw_models.is_empty() || !has_any_quota {
        return AntigravitySnapshot {
            status: "no_data".into(),
            plan,
            ai_credits,
            version,
            groups: Vec::new(),
            models: collapse_model_variants(&raw_models),
            fetched_at,
            message: Some("Antigravity 暂未返回可用模型额度数据".into()),
        };
    }

    let models = collapse_model_variants(&raw_models);
    let groups = build_quota_groups(&raw_models);

    let known_percents: Vec<f64> = groups
        .iter()
        .filter_map(|group| group.remaining_percent)
        .collect();
    let status = if !known_percents.is_empty() && known_percents.iter().all(|value| *value <= 0.0) {
        "limit_reached"
    } else {
        "ok"
    };

    AntigravitySnapshot {
        status: status.into(),
        plan,
        ai_credits,
        version,
        groups,
        models,
        fetched_at,
        message: None,
    }
}

fn extract_plan(user_status: &serde_json::Map<String, Value>) -> Option<String> {
    let from_tier = user_status.get("userTier").and_then(|tier| {
        non_empty_str(tier.get("name")).or_else(|| non_empty_str(tier.get("description")))
    });
    from_tier.or_else(|| {
        user_status
            .get("planStatus")
            .and_then(|plan| plan.get("planInfo"))
            .and_then(|info| non_empty_str(info.get("planName")))
    })
}

fn extract_ai_credits(user_status: &serde_json::Map<String, Value>) -> Option<i64> {
    let credits = user_status
        .get("userTier")
        .and_then(|tier| tier.get("availableCredits"))
        .and_then(Value::as_array)?;
    for item in credits {
        if let Some(amount) = item.get("creditAmount").and_then(|value| match value {
            Value::Number(num) => num.as_i64(),
            Value::String(text) => text.trim().parse::<i64>().ok(),
            _ => None,
        }) {
            return Some(amount.max(0));
        }
    }
    None
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn parse_model_entry(value: &Value) -> Option<RawModelEntry> {
    let label = non_empty_str(value.get("label"))?;
    let model_id = non_empty_str(value.get("modelId")).or_else(|| {
        value
            .get("modelOrAlias")
            .and_then(|item| non_empty_str(item.get("model")))
    });
    let quota = value.get("quotaInfo");
    let fraction = quota
        .and_then(|info| info.get("remainingFraction"))
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .map(|number| number.clamp(0.0, 1.0));
    let remaining_percent = fraction.map(|value| value * 100.0);
    let used_percent = remaining_percent.map(|remaining| (100.0 - remaining).clamp(0.0, 100.0));
    let fraction_key = fraction.map(|value| (value * FRACTION_SCALE).round() as i64);
    let resets_at = quota
        .and_then(|info| info.get("resetTime"))
        .and_then(parse_timestamp);

    let base_label = strip_thinking_suffix(&label);
    let family = classify_family(&base_label, model_id.as_deref());

    Some(RawModelEntry {
        label,
        base_label,
        model_id,
        family,
        remaining_percent,
        used_percent,
        fraction_key,
        resets_at,
    })
}

fn parse_timestamp(value: &Value) -> Option<i64> {
    match value {
        Value::String(text) => crate::claude_usage::parse_iso_utc(text),
        Value::Number(number) => number.as_i64().map(|raw| {
            if raw > 10_000_000_000 {
                raw / 1000
            } else {
                raw
            }
        }),
        _ => None,
    }
}

/// Strips thinking-level suffixes like ` (High)` or ` (XHigh)` while keeping variant names like ` (Neon)`.
fn strip_thinking_suffix(label: &str) -> String {
    let trimmed = label.trim();
    for suffix in [
        " (Minimal)",
        " (Low)",
        " (Medium)",
        " (High)",
        " (XHigh)",
        " (Extra High)",
    ] {
        if let Some(prefix) = trimmed.strip_suffix(suffix) {
            if !prefix.trim().is_empty() {
                return prefix.trim().to_owned();
            }
        }
    }
    trimmed.to_owned()
}

fn classify_family(base_label: &str, model_id: Option<&str>) -> ModelFamily {
    let lower_label = base_label.to_ascii_lowercase();
    let lower_id = model_id.unwrap_or("").to_ascii_lowercase();
    if lower_label.contains("gemini")
        || lower_id.contains("gemini")
        || lower_label.starts_with("orchestrator")
    {
        return ModelFamily::Google;
    }
    if lower_label.contains("claude")
        || lower_id.contains("claude")
        || lower_label.contains("gpt")
        || lower_id.contains("gpt")
        || lower_id.contains("openai")
    {
        return ModelFamily::Partner;
    }
    ModelFamily::Other(lower_label)
}

/// Collapses thinking-level variants of the same base model ONLY when they report identical quota values.
fn collapse_model_variants(entries: &[RawModelEntry]) -> Vec<AntigravityModelQuota> {
    let mut by_base: HashMap<&str, Vec<&RawModelEntry>> = HashMap::new();
    let mut base_order: Vec<&str> = Vec::new();
    for entry in entries {
        if !by_base.contains_key(entry.base_label.as_str()) {
            base_order.push(entry.base_label.as_str());
        }
        by_base
            .entry(entry.base_label.as_str())
            .or_default()
            .push(entry);
    }

    let mut result = Vec::new();
    for base in base_order {
        let group = &by_base[base];
        let first = group[0];
        let all_identical = group.iter().all(|item| {
            item.fraction_key == first.fraction_key && item.resets_at == first.resets_at
        });
        if all_identical {
            result.push(AntigravityModelQuota {
                label: if group.len() > 1 {
                    first.base_label.clone()
                } else {
                    first.label.clone()
                },
                model_id: first.model_id.clone(),
                remaining_percent: first.remaining_percent,
                used_percent: first.used_percent,
                resets_at: first.resets_at,
            });
        } else {
            for item in group {
                result.push(AntigravityModelQuota {
                    label: item.label.clone(),
                    model_id: item.model_id.clone(),
                    remaining_percent: item.remaining_percent,
                    used_percent: item.used_percent,
                    resets_at: item.resets_at,
                });
            }
        }
    }
    result
}

/// Groups models into shared quota pools ONLY when they belong to the same provider family AND
/// report the exact same `remainingFraction` and `resetTime`. Never averages or guesses.
fn build_quota_groups(entries: &[RawModelEntry]) -> Vec<AntigravityQuotaGroup> {
    struct Bucket<'a> {
        family: ModelFamily,
        remaining_percent: Option<f64>,
        used_percent: Option<f64>,
        resets_at: Option<i64>,
        base_models: Vec<String>,
        raw_count: usize,
        first_seen: usize,
        _marker: std::marker::PhantomData<&'a ()>,
    }

    let mut index_by_key: HashMap<(ModelFamily, Option<i64>, Option<i64>), usize> = HashMap::new();
    let mut buckets: Vec<Bucket<'_>> = Vec::new();

    for (idx, entry) in entries.iter().enumerate() {
        // Ignore models that carry neither remaining quota nor reset time when other models have data.
        if entry.remaining_percent.is_none() && entry.resets_at.is_none() {
            continue;
        }
        let key = (entry.family.clone(), entry.fraction_key, entry.resets_at);
        if let Some(&bucket_idx) = index_by_key.get(&key) {
            let bucket = &mut buckets[bucket_idx];
            bucket.raw_count += 1;
            if !bucket.base_models.contains(&entry.base_label) {
                bucket.base_models.push(entry.base_label.clone());
            }
        } else {
            let bucket_idx = buckets.len();
            index_by_key.insert(key, bucket_idx);
            buckets.push(Bucket {
                family: entry.family.clone(),
                remaining_percent: entry.remaining_percent,
                used_percent: entry.used_percent,
                resets_at: entry.resets_at,
                base_models: vec![entry.base_label.clone()],
                raw_count: 1,
                first_seen: idx,
                _marker: std::marker::PhantomData,
            });
        }
    }

    buckets.sort_by_key(|bucket| bucket.first_seen);

    let mut label_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut provisional: Vec<(String, Bucket<'_>)> = buckets
        .into_iter()
        .map(|bucket| {
            let label = group_label(&bucket.family, &bucket.base_models);
            *label_counts.entry(label.clone()).or_insert(0) += 1;
            (label, bucket)
        })
        .collect();

    // Disambiguate if two distinct quota pools ended up with the same generic label.
    let mut seen_labels: HashMap<String, usize> = HashMap::new();
    for (label, bucket) in &mut provisional {
        if label_counts.get(label).copied().unwrap_or(0) > 1 {
            let ordinal = seen_labels.entry(label.clone()).or_insert(0);
            *ordinal += 1;
            if let Some(first_model) = bucket.base_models.first() {
                if bucket.base_models.len() == 1 {
                    *label = first_model.clone();
                } else {
                    *label = format!("{first_model} 等 {} 项", bucket.base_models.len());
                }
            }
        }
    }

    provisional
        .into_iter()
        .enumerate()
        .map(|(index, (label, bucket))| AntigravityQuotaGroup {
            id: format!("group-{}", index + 1),
            label,
            remaining_percent: bucket.remaining_percent,
            used_percent: bucket.used_percent,
            resets_at: bucket.resets_at,
            models: bucket.base_models,
            model_count: bucket.raw_count,
        })
        .collect()
}

fn group_label(family: &ModelFamily, base_models: &[String]) -> String {
    if base_models.len() == 1 {
        return base_models[0].clone();
    }
    match family {
        ModelFamily::Google => {
            let all_flash = base_models
                .iter()
                .all(|name| name.to_ascii_lowercase().contains("flash"));
            let all_pro = base_models
                .iter()
                .all(|name| name.to_ascii_lowercase().contains("pro"));
            if all_flash {
                "Gemini Flash".into()
            } else if all_pro {
                "Gemini Pro".into()
            } else {
                "Gemini".into()
            }
        }
        ModelFamily::Partner => {
            let has_claude = base_models
                .iter()
                .any(|name| name.to_ascii_lowercase().contains("claude"));
            let has_gpt = base_models
                .iter()
                .any(|name| name.to_ascii_lowercase().contains("gpt"));
            match (has_claude, has_gpt) {
                (true, true) => "Claude/GPT".into(),
                (true, false) => "Claude".into(),
                (false, true) => "GPT".into(),
                (false, false) => format!("{} 等 {} 项", base_models[0], base_models.len()),
            }
        }
        ModelFamily::Other(_) => format!("{} 等 {} 项", base_models[0], base_models.len()),
    }
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

    fn sample_response() -> Value {
        json!({
            "userStatus": {
                "name": "Redacted User",
                "email": "redacted@example.com",
                "userTier": {
                    "id": "g1-pro-tier",
                    "name": "Google AI Pro",
                    "description": "Google AI Pro",
                    "availableCredits": [
                        {
                            "creditType": "GOOGLE_ONE_AI",
                            "creditAmount": "120",
                            "minimumCreditAmountForUsage": "50"
                        }
                    ]
                },
                "planStatus": {
                    "planInfo": {
                        "planName": "Pro",
                        "monthlyPromptCredits": 50000
                    },
                    "availablePromptCredits": 500
                },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Gemini 4 Neon (High)",
                            "modelId": "gemini-4-neon-high",
                            "quotaInfo": {
                                "remainingFraction": 0.895,
                                "resetTime": "2026-11-24T17:36:44Z"
                            }
                        },
                        {
                            "label": "Gemini 4 Neon (Low)",
                            "modelId": "gemini-4-neon-low",
                            "quotaInfo": {
                                "remainingFraction": 0.895,
                                "resetTime": "2026-11-24T17:36:44Z"
                            }
                        },
                        {
                            "label": "Gemini 3.8 Flash (High)",
                            "modelId": "gemini-3.8-flash-high",
                            "quotaInfo": {
                                "remainingFraction": 0.895,
                                "resetTime": "2026-11-24T17:36:44Z"
                            }
                        },
                        {
                            "label": "Claude Opus 5.5 (High)",
                            "modelId": "claude-opus-5-5-high",
                            "quotaInfo": {
                                "remainingFraction": 1.0,
                                "resetTime": "2026-11-24T18:45:49Z"
                            }
                        },
                        {
                            "label": "Claude Sonnet 5.5 (Medium)",
                            "modelId": "claude-sonnet-5-5-medium",
                            "quotaInfo": {
                                "remainingFraction": 1.0,
                                "resetTime": "2026-11-24T18:45:49Z"
                            }
                        },
                        {
                            "label": "GPT-OSS 120B (Medium)",
                            "modelId": "gpt-oss-120b-medium",
                            "quotaInfo": {
                                "remainingFraction": 1.0,
                                "resetTime": "2026-11-24T18:45:49Z"
                            }
                        }
                    ]
                }
            }
        })
    }

    #[test]
    fn parses_shared_quota_pools_and_collapses_thinking_variants() {
        let snapshot = parse_user_status(&sample_response(), Some("2.34.0".into()), 1_795_528_000);
        assert_eq!(snapshot.status, "ok");
        assert_eq!(snapshot.plan.as_deref(), Some("Google AI Pro"));
        assert_eq!(snapshot.ai_credits, Some(120));
        assert_eq!(snapshot.version.as_deref(), Some("2.34.0"));
        assert_eq!(snapshot.groups.len(), 2);

        let gemini = &snapshot.groups[0];
        assert_eq!(gemini.label, "Gemini");
        assert_eq!(gemini.remaining_percent, Some(89.5));
        assert_eq!(gemini.used_percent, Some(10.5));
        assert_eq!(
            gemini.resets_at,
            crate::claude_usage::parse_iso_utc("2026-11-24T17:36:44Z")
        );
        assert_eq!(gemini.models, vec!["Gemini 4 Neon", "Gemini 3.8 Flash"]);
        assert_eq!(gemini.model_count, 3);

        let partner = &snapshot.groups[1];
        assert_eq!(partner.label, "Claude/GPT");
        assert_eq!(partner.remaining_percent, Some(100.0));
        assert_eq!(partner.used_percent, Some(0.0));
        assert_eq!(
            partner.models,
            vec!["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"]
        );

        // Two Gemini 4 Neon thinking levels collapsed into one base model entry.
        assert_eq!(snapshot.models.len(), 5);
        assert_eq!(snapshot.models[0].label, "Gemini 4 Neon");
    }

    #[test]
    fn splits_models_with_different_quotas_without_averaging() {
        let payload = json!({
            "userStatus": {
                "userTier": { "name": "Google AI Pro" },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Gemini 4 Pro (High)",
                            "modelId": "gemini-4-pro-high",
                            "quotaInfo": { "remainingFraction": 0.4, "resetTime": "2026-11-24T17:00:00Z" }
                        },
                        {
                            "label": "Gemini 3.8 Flash (High)",
                            "modelId": "gemini-3.8-flash-high",
                            "quotaInfo": { "remainingFraction": 0.9, "resetTime": "2026-11-24T19:00:00Z" }
                        },
                        {
                            "label": "Claude Opus 5.5 (High)",
                            "modelId": "claude-opus-5-5-high",
                            "quotaInfo": { "remainingFraction": 0.2, "resetTime": "2026-11-24T18:00:00Z" }
                        },
                        {
                            "label": "GPT-OSS 120B (Medium)",
                            "modelId": "gpt-oss-120b-medium",
                            "quotaInfo": { "remainingFraction": 0.75, "resetTime": "2026-11-24T20:00:00Z" }
                        }
                    ]
                }
            }
        });
        let snapshot = parse_user_status(&payload, None, 1_000);
        assert_eq!(snapshot.status, "ok");
        assert_eq!(snapshot.groups.len(), 4);
        assert_eq!(snapshot.groups[0].label, "Gemini 4 Pro");
        assert_eq!(snapshot.groups[0].remaining_percent, Some(40.0));
        assert_eq!(snapshot.groups[1].label, "Gemini 3.8 Flash");
        assert_eq!(snapshot.groups[1].remaining_percent, Some(90.0));
        assert_eq!(snapshot.groups[2].label, "Claude Opus 5.5");
        assert_eq!(snapshot.groups[2].remaining_percent, Some(20.0));
        assert_eq!(snapshot.groups[3].label, "GPT-OSS 120B");
        assert_eq!(snapshot.groups[3].remaining_percent, Some(75.0));
    }

    #[test]
    fn never_fabricates_zero_or_hundred_when_fraction_is_missing() {
        let payload = json!({
            "userStatus": {
                "userTier": { "name": "Free" },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Gemini 4 Neon (High)",
                            "modelId": "gemini-4-neon-high",
                            "quotaInfo": { "resetTime": "2026-11-24T17:00:00Z" }
                        }
                    ]
                }
            }
        });
        let snapshot = parse_user_status(&payload, None, 1_000);
        assert_eq!(snapshot.status, "ok");
        assert_eq!(snapshot.groups.len(), 1);
        assert_eq!(snapshot.groups[0].remaining_percent, None);
        assert_eq!(snapshot.groups[0].used_percent, None);
        assert!(snapshot.groups[0].resets_at.is_some());
    }

    #[test]
    fn clamps_fraction_and_reports_limit_reached_only_when_all_known_pools_are_empty() {
        let exhausted = json!({
            "userStatus": {
                "userTier": { "name": "Google AI Pro" },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Gemini 4 Neon (High)",
                            "quotaInfo": { "remainingFraction": -0.2, "resetTime": 1_795_000_000_000_i64 }
                        }
                    ]
                }
            }
        });
        let snapshot = parse_user_status(&exhausted, None, 1_000);
        assert_eq!(snapshot.status, "limit_reached");
        assert_eq!(snapshot.groups[0].remaining_percent, Some(0.0));
        assert_eq!(snapshot.groups[0].used_percent, Some(100.0));
        assert_eq!(snapshot.groups[0].resets_at, Some(1_795_000_000));

        let partial = json!({
            "userStatus": {
                "userTier": { "name": "Google AI Pro" },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Gemini 4 Neon (High)",
                            "quotaInfo": { "remainingFraction": 0.0, "resetTime": "2026-11-24T17:00:00Z" }
                        },
                        {
                            "label": "Claude Opus 5.5 (High)",
                            "quotaInfo": { "remainingFraction": 1.4, "resetTime": "2026-11-24T18:00:00Z" }
                        }
                    ]
                }
            }
        });
        let partial_snapshot = parse_user_status(&partial, None, 1_000);
        assert_eq!(partial_snapshot.status, "ok");
        assert_eq!(partial_snapshot.groups[0].remaining_percent, Some(0.0));
        assert_eq!(partial_snapshot.groups[1].remaining_percent, Some(100.0));
    }

    #[test]
    fn handles_signed_out_and_no_data_responses() {
        let missing_status = parse_user_status(&json!({}), None, 1_000);
        assert_eq!(missing_status.status, "signed_out");

        let empty_status = parse_user_status(&json!({ "userStatus": {} }), None, 1_000);
        assert_eq!(empty_status.status, "signed_out");

        let no_quota = parse_user_status(
            &json!({
                "userStatus": {
                    "userTier": { "name": "Google AI Pro" },
                    "cascadeModelConfigData": {
                        "clientModelConfigs": [
                            { "label": "Gemini 4 Neon (High)" }
                        ]
                    }
                }
            }),
            None,
            1_000,
        );
        assert_eq!(no_quota.status, "no_data");
        assert!(no_quota.groups.is_empty());
    }

    #[test]
    fn keeps_google_and_partner_pools_separate_even_when_both_are_full_at_same_second() {
        let same_time = "2026-11-24T18:00:00Z";
        let payload = json!({
            "userStatus": {
                "userTier": { "name": "Google AI Pro" },
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "Gemini 4 Neon (High)",
                            "quotaInfo": { "remainingFraction": 1.0, "resetTime": same_time }
                        },
                        {
                            "label": "Claude Opus 5.5 (High)",
                            "quotaInfo": { "remainingFraction": 1.0, "resetTime": same_time }
                        }
                    ]
                }
            }
        });
        let snapshot = parse_user_status(&payload, None, 1_000);
        assert_eq!(snapshot.groups.len(), 2);
        assert_eq!(snapshot.groups[0].label, "Gemini 4 Neon");
        assert_eq!(snapshot.groups[1].label, "Claude Opus 5.5");
    }

    #[test]
    fn discovers_valid_daemon_files_and_skips_malformed_ones() {
        let dir = env::temp_dir().join(format!(
            "codex-meter-agy-daemon-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("broken.json"), b"{not json").unwrap();
        fs::write(dir.join("no_token.json"), br#"{"httpPort": 50000}"#).unwrap();
        fs::write(
            dir.join("hub_50001.json"),
            format!(
                r#"{{"pid": {}, "httpPort": 50001, "lsVersion": "2.34.0", "csrfToken": "demo-csrf"}}"#,
                std::process::id()
            ),
        )
        .unwrap();

        let endpoints = discover_endpoints(&dir);
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0].http_port, 50001);
        assert_eq!(endpoints[0].ls_version.as_deref(), Some("2.34.0"));
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod live {
    /// Manual read-only check against this machine's running Antigravity language server.
    /// Prints only redacted status, tier, and pool percentages—never credentials or personal info.
    #[test]
    #[ignore]
    fn live_antigravity_probe() {
        let snapshot = super::AntigravityService::new().fetch();
        println!(
            "status={} plan={:?} version={:?} ai_credits={:?} groups={} models={} message={:?}",
            snapshot.status,
            snapshot.plan,
            snapshot.version,
            snapshot.ai_credits,
            snapshot.groups.len(),
            snapshot.models.len(),
            snapshot.message
        );
        for group in &snapshot.groups {
            println!(
                "  group={} remaining={:?}% resets_at={:?} models={:?} (raw={})",
                group.label,
                group.remaining_percent,
                group.resets_at,
                group.models,
                group.model_count
            );
        }
    }
}
