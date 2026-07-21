use serde::Serialize;
use serde_json::{json, Value};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CodexService {
    client: Option<RpcClient>,
}

impl CodexService {
    pub fn new() -> Self {
        Self { client: None }
    }

    pub fn refresh(&mut self) -> UsageSnapshot {
        match self.fetch_with_reconnect() {
            Ok(snapshot) => snapshot,
            Err(error) => UsageSnapshot::unavailable(error),
        }
    }

    fn fetch_with_reconnect(&mut self) -> Result<UsageSnapshot, String> {
        if self.client.is_none() {
            self.client = Some(RpcClient::connect()?);
        }

        let first = self.client.as_mut().expect("client was connected").fetch();
        if first.is_ok() {
            return first;
        }

        // A sleeping laptop can leave stdio open while the child has exited.
        self.client = Some(RpcClient::connect()?);
        self.client
            .as_mut()
            .expect("client was reconnected")
            .fetch()
    }
}

struct RpcClient {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
    next_id: u64,
}

impl RpcClient {
    fn connect() -> Result<Self, String> {
        let mut last_error = String::new();
        for program in codex_candidates() {
            match Self::connect_to(&program) {
                Ok(client) => return Ok(client),
                Err(error) => last_error = format!("{program}: {error}"),
            }
        }

        #[cfg(target_os = "windows")]
        let help = "Codex Desktop 的 WindowsApps 内置程序不能作为外部 CLI 调用；请安装独立 Codex CLI 并登录，或把 CODEX_METER_CODEX_PATH 设为可执行文件路径";
        #[cfg(not(target_os = "windows"))]
        let help = "请安装新版 ChatGPT/Codex 桌面程序或独立 Codex CLI 并登录，也可以把 CODEX_METER_CODEX_PATH 设为可执行文件路径";

        Err(format!("无法启动 Codex CLI（{last_error}）。{help}。"))
    }

    fn connect_to(program: &str) -> Result<Self, String> {
        let mut child = Command::new(program)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Codex app-server stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Codex app-server stdout unavailable")?;
        let (sender, messages) = mpsc::channel();

        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if sender.send(message).is_err() {
                        break;
                    }
                }
            }
        });

        let mut client = Self {
            child,
            stdin,
            messages,
            next_id: 1,
        };
        client
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "codex-meter",
                        "title": "Codex Meter",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .map_err(|error| format!("Could not initialize: {error}"))?;
        client.notify("initialized", json!({}))?;
        Ok(client)
    }

    fn fetch(&mut self) -> Result<UsageSnapshot, String> {
        let account = self.request("account/read", json!({ "refreshToken": false }))?;
        let account_type = account
            .pointer("/account/type")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let account_plan_type = account
            .pointer("/account/planType")
            .or_else(|| account.pointer("/account/plan_type"))
            .and_then(Value::as_str)
            .map(str::to_owned);

        if account_type.as_deref() == Some("apiKey") {
            return Ok(UsageSnapshot::without_quota(
                account_type,
                account_plan_type,
                "api_key_unsupported",
            ));
        }
        if account.get("account").is_none() || account.get("account") == Some(&Value::Null) {
            return Ok(UsageSnapshot::without_quota(
                account_type,
                account_plan_type,
                "signed_out",
            ));
        }

        let response = self.request("account/rateLimits/read", json!({}))?;
        let limits = response.get("rateLimits").unwrap_or(&response);
        let plan_type = preferred_plan_type(limits, account_plan_type);
        let primary = limits.get("primary").and_then(UsageWindow::from_value);
        let secondary = limits.get("secondary").and_then(UsageWindow::from_value);
        let credits_balance = limits
            .pointer("/credits/balance")
            .and_then(Value::as_f64)
            .or_else(|| {
                limits
                    .pointer("/credits/balance")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse().ok())
            })
            .or_else(|| limits.get("creditsBalance").and_then(Value::as_f64));
        let reached = limits
            .get("rateLimitReachedType")
            .and_then(Value::as_str)
            .is_some();
        let status = if primary.is_none() && secondary.is_none() {
            "unavailable"
        } else if reached {
            "limit_reached"
        } else {
            "ok"
        };

        Ok(UsageSnapshot {
            account_type,
            plan_type,
            primary,
            secondary,
            credits_balance,
            status: status.into(),
            fetched_at: unix_seconds(),
            error: None,
        })
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({ "method": method, "id": id, "params": params }))?;

        loop {
            let response = self
                .messages
                .recv_timeout(RESPONSE_TIMEOUT)
                .map_err(|_| format!("Timed out waiting for {method}"))?;
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                // Notifications are intentionally ignored in v0.1; the UI performs a full read every 60s.
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(format!("{method} failed: {error}"));
            }
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| format!("{method} returned no result"));
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({ "method": method, "params": params }))
    }

    fn write(&mut self, value: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{value}").map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())
    }
}

impl Drop for RpcClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn codex_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("CODEX_METER_CODEX_PATH") {
        if !path.trim().is_empty() {
            candidates.push(path);
        }
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        "/Applications/ChatGPT.app/Contents/Resources/codex".into(),
        "/Applications/Codex.app/Contents/Resources/codex".into(),
    ]);
    #[cfg(target_os = "macos")]
    if let Ok(home) = env::var("HOME") {
        let home = home.trim_end_matches('/');
        if !home.is_empty() {
            candidates.extend([
                format!("{home}/Applications/ChatGPT.app/Contents/Resources/codex"),
                format!("{home}/Applications/Codex.app/Contents/Resources/codex"),
            ]);
        }
    }
    #[cfg(target_os = "windows")]
    candidates.extend(["codex.exe".into(), "codex.cmd".into(), "codex".into()]);
    #[cfg(target_os = "linux")]
    candidates.push("codex".into());
    #[cfg(target_os = "macos")]
    candidates.extend([
        "codex".into(),
        "/opt/homebrew/bin/codex".into(),
        "/usr/local/bin/codex".into(),
    ]);

    candidates
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub account_type: Option<String>,
    pub plan_type: Option<String>,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub credits_balance: Option<f64>,
    pub status: String,
    pub fetched_at: i64,
    pub error: Option<String>,
}

impl UsageSnapshot {
    fn unavailable(error: String) -> Self {
        Self {
            account_type: None,
            plan_type: None,
            primary: None,
            secondary: None,
            credits_balance: None,
            status: "unavailable".into(),
            fetched_at: unix_seconds(),
            error: Some(error),
        }
    }

    fn without_quota(
        account_type: Option<String>,
        plan_type: Option<String>,
        status: &str,
    ) -> Self {
        Self {
            account_type,
            plan_type,
            primary: None,
            secondary: None,
            credits_balance: None,
            status: status.into(),
            fetched_at: unix_seconds(),
            error: None,
        }
    }

    pub(crate) fn service_error(error: &str) -> Self {
        Self::unavailable(error.into())
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub window_duration_mins: i64,
    pub resets_at: Option<i64>,
}

impl UsageWindow {
    fn from_value(value: &Value) -> Option<Self> {
        let used_percent = value.get("usedPercent")?.as_f64()?.clamp(0.0, 100.0);
        let window_duration_mins = value.get("windowDurationMins")?.as_i64()?;
        Some(Self {
            label: window_label(window_duration_mins),
            used_percent,
            remaining_percent: 100.0 - used_percent,
            window_duration_mins,
            resets_at: value.get("resetsAt").and_then(Value::as_i64),
        })
    }
}

fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5 小时".into(),
        10_080 => "每周".into(),
        value if value > 0 && value % 1_440 == 0 => format!("{} 天", value / 1_440),
        value if value > 0 && value % 60 == 0 => format!("{} 小时", value / 60),
        value => format!("{value} 分钟"),
    }
}

fn preferred_plan_type(limits: &Value, account_plan_type: Option<String>) -> Option<String> {
    limits
        .get("planType")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(account_plan_type)
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_backend_window_and_clamps_percent() {
        let window = UsageWindow::from_value(&json!({
            "usedPercent": 120.0,
            "windowDurationMins": 300,
            "resetsAt": 1_780_000_000
        }))
        .unwrap();

        assert_eq!(window.label, "5 小时");
        assert_eq!(window.used_percent, 100.0);
        assert_eq!(window.remaining_percent, 0.0);
        assert_eq!(window.resets_at, Some(1_780_000_000));
    }

    #[test]
    fn labels_windows_from_duration_instead_of_position() {
        assert_eq!(window_label(10_080), "每周");
        assert_eq!(window_label(1_440), "1 天");
        assert_eq!(window_label(90), "90 分钟");
    }

    #[test]
    fn prefers_live_rate_limit_plan_over_stale_account_plan() {
        let plan = preferred_plan_type(&json!({ "planType": "plus" }), Some("free".into()));

        assert_eq!(plan.as_deref(), Some("plus"));
    }
}
