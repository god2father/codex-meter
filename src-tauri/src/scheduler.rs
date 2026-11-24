//! Background usage refresh. Polling used to live in webview `setInterval` timers, which
//! macOS WebKit and Windows WebView2 suspend or throttle while the tray panel is hidden, so
//! the tray only updated after a click. This thread owns the cadence instead and pushes
//! snapshots to the webview as events.

use crate::{
    antigravity::{AntigravityService, AntigravitySnapshot},
    claude_quota::{ClaudeQuotaService, ClaudeQuotaSnapshot},
    claude_usage::{self, ClaudeUsageService},
    codex::{CodexService, UsageSnapshot},
    token_usage,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cadence {
    pub visible: Duration,
    pub hidden: Duration,
    pub retry: Duration,
}

pub const CODEX_QUOTA: Cadence = Cadence {
    visible: Duration::from_secs(30),
    hidden: Duration::from_secs(60),
    retry: Duration::from_secs(30),
};
pub const LOCAL_TOKENS: Cadence = Cadence {
    visible: Duration::from_secs(10),
    hidden: Duration::from_secs(30),
    retry: Duration::from_secs(30),
};
/// Claude's usage endpoint is undocumented and shared with Claude Code; poll it gently.
pub const CLAUDE_QUOTA: Cadence = Cadence {
    visible: Duration::from_secs(120),
    hidden: Duration::from_secs(300),
    retry: Duration::from_secs(300),
};
const CLAUDE_QUOTA_RATE_LIMITED: Duration = Duration::from_secs(600);
/// Local loopback RPC to Antigravity's language_server.
pub const ANTIGRAVITY_QUOTA: Cadence = Cadence {
    visible: Duration::from_secs(30),
    hidden: Duration::from_secs(60),
    retry: Duration::from_secs(60),
};
const ANTIGRAVITY_RATE_LIMITED: Duration = Duration::from_secs(300);
/// Opening the panel refetches quota when it is older than this.
const SHOW_STALE_AFTER: Duration = Duration::from_secs(20);
/// Wall clock moving this far ahead of the monotonic clock means the machine slept.
const WAKE_THRESHOLD: Duration = Duration::from_secs(20);

impl Cadence {
    pub fn next(&self, visible: bool, succeeded: bool) -> Duration {
        let base = if visible { self.visible } else { self.hidden };
        if succeeded {
            base
        } else {
            base.min(self.retry)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Codex,
    Claude,
    /// Claude subscription windows, read with Claude Code's own login. Requires `Claude`.
    ClaudeQuota,
    /// Local Antigravity desktop hub quota windows.
    Antigravity,
}

/// Which sources are monitored. Codex keeps its previous always-on behaviour by default;
/// Claude and Antigravity stay off until the user turns them on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Monitoring {
    pub codex: bool,
    pub claude: bool,
    pub claude_quota: bool,
    pub antigravity: bool,
}

impl Default for Monitoring {
    fn default() -> Self {
        Self {
            codex: true,
            claude: false,
            claude_quota: false,
            antigravity: false,
        }
    }
}

#[derive(Default)]
struct Due {
    codex: Option<Instant>,
    local: Option<Instant>,
    last_codex: Option<Instant>,
    /// None means due now; checked on each local tick.
    claude_quota: Option<Instant>,
    last_claude_quota: Option<Instant>,
    /// None means due now; checked on each local tick.
    antigravity: Option<Instant>,
    last_antigravity: Option<Instant>,
    wake: bool,
}

pub struct UsageHub {
    pub codex: Arc<Mutex<CodexService>>,
    claude: Mutex<ClaudeUsageService>,
    claude_quota: Mutex<ClaudeQuotaService>,
    antigravity: Mutex<AntigravityService>,
    last_antigravity: Mutex<Option<AntigravitySnapshot>>,
    offset_east_seconds: AtomicI64,
    codex_enabled: AtomicBool,
    claude_enabled: AtomicBool,
    claude_quota_enabled: AtomicBool,
    antigravity_enabled: AtomicBool,
    preferences_path: Mutex<Option<PathBuf>>,
    due: Mutex<Due>,
    signal: Condvar,
}

impl UsageHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            codex: Arc::new(Mutex::new(CodexService::new())),
            claude: Mutex::new(ClaudeUsageService::new()),
            claude_quota: Mutex::new(ClaudeQuotaService::new()),
            antigravity: Mutex::new(AntigravityService::new()),
            last_antigravity: Mutex::new(None),
            offset_east_seconds: AtomicI64::new(0),
            codex_enabled: AtomicBool::new(Monitoring::default().codex),
            claude_enabled: AtomicBool::new(Monitoring::default().claude),
            claude_quota_enabled: AtomicBool::new(Monitoring::default().claude_quota),
            antigravity_enabled: AtomicBool::new(Monitoring::default().antigravity),
            preferences_path: Mutex::new(None),
            due: Mutex::new(Due::default()),
            signal: Condvar::new(),
        })
    }

    pub fn monitoring(&self) -> Monitoring {
        Monitoring {
            codex: self.codex_enabled.load(Ordering::Relaxed),
            claude: self.claude_enabled.load(Ordering::Relaxed),
            claude_quota: self.claude_quota_enabled.load(Ordering::Relaxed),
            antigravity: self.antigravity_enabled.load(Ordering::Relaxed),
        }
    }

    pub fn is_enabled(&self, source: Source) -> bool {
        match source {
            Source::Codex => self.codex_enabled.load(Ordering::Relaxed),
            Source::Claude => self.claude_enabled.load(Ordering::Relaxed),
            Source::ClaudeQuota => {
                self.claude_enabled.load(Ordering::Relaxed)
                    && self.claude_quota_enabled.load(Ordering::Relaxed)
            }
            Source::Antigravity => self.antigravity_enabled.load(Ordering::Relaxed),
        }
    }

    fn apply(&self, monitoring: Monitoring) {
        self.codex_enabled
            .store(monitoring.codex, Ordering::Relaxed);
        self.claude_enabled
            .store(monitoring.claude, Ordering::Relaxed);
        self.claude_quota_enabled
            .store(monitoring.claude_quota, Ordering::Relaxed);
        self.antigravity_enabled
            .store(monitoring.antigravity, Ordering::Relaxed);
    }

    /// Reads saved switches from `<config dir>/monitoring.json`; a missing or broken file keeps defaults.
    pub fn load_preferences(&self, directory: Option<PathBuf>) {
        let path = directory.map(|directory| directory.join("monitoring.json"));
        if let Some(saved) = path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Monitoring>(&bytes).ok())
        {
            self.apply(saved);
        }
        if let Ok(mut stored) = self.preferences_path.lock() {
            *stored = path;
        }
    }

    pub fn set_enabled(&self, source: Source, enabled: bool) -> Result<(), String> {
        let mut next = self.monitoring();
        match source {
            Source::Codex => next.codex = enabled,
            Source::Claude => next.claude = enabled,
            Source::ClaudeQuota => next.claude_quota = enabled,
            Source::Antigravity => next.antigravity = enabled,
        }
        let path = self
            .preferences_path
            .lock()
            .ok()
            .and_then(|path| path.clone());
        if let Some(path) = path {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("无法保存监测设置：{error}"))?;
            }
            let bytes = serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?;
            fs::write(&path, bytes).map_err(|error| format!("无法保存监测设置：{error}"))?;
        }
        self.apply(next);
        if source == Source::Codex && !enabled {
            // Stop the background `codex app-server` instead of leaving it idle.
            if let Ok(mut service) = self.codex.lock() {
                service.disconnect();
            }
        }
        if source == Source::Antigravity && !enabled {
            if let Ok(mut cached) = self.last_antigravity.lock() {
                *cached = None;
            }
        }
        if enabled {
            if let Ok(mut due) = self.due.lock() {
                match source {
                    Source::Claude | Source::ClaudeQuota => due.claude_quota = None,
                    Source::Antigravity => due.antigravity = None,
                    Source::Codex => {}
                }
            }
            self.kick(source == Source::Codex);
        }
        Ok(())
    }

    pub fn set_timezone(&self, offset_east_seconds: i64) {
        if (-14 * 3600..=14 * 3600).contains(&offset_east_seconds) {
            self.offset_east_seconds
                .store(offset_east_seconds, Ordering::Relaxed);
        }
    }

    /// Asks the worker to refresh local token stats now, and quota too when requested.
    pub fn kick(&self, include_codex: bool) {
        if let Ok(mut due) = self.due.lock() {
            let now = Instant::now();
            due.local = Some(now);
            if include_codex {
                due.codex = Some(now);
                due.antigravity = None;
            }
        }
        self.signal.notify_all();
    }

    /// Called when the panel opens: refresh everything that is not fresh.
    pub fn panel_shown(&self) {
        let stale = self
            .due
            .lock()
            .map(|mut due| {
                if due
                    .last_claude_quota
                    .is_none_or(|last| last.elapsed() >= CLAUDE_QUOTA.visible)
                {
                    due.claude_quota = None;
                }
                if due
                    .last_antigravity
                    .is_none_or(|last| last.elapsed() >= SHOW_STALE_AFTER)
                {
                    due.antigravity = None;
                }
                due.last_codex
                    .is_none_or(|last| last.elapsed() >= SHOW_STALE_AFTER)
            })
            .unwrap_or(true);
        self.kick(stale);
    }

    /// Records a quota fetch made outside the worker (manual refresh) so it is not repeated.
    pub fn codex_refreshed(&self, visible: bool, succeeded: bool) {
        if let Ok(mut due) = self.due.lock() {
            let now = Instant::now();
            due.last_codex = Some(now);
            due.codex = Some(now + CODEX_QUOTA.next(visible, succeeded));
        }
    }

    pub fn refresh_codex(&self) -> UsageSnapshot {
        match self.codex.lock() {
            Ok(mut service) => service.refresh(),
            Err(_) => UsageSnapshot::service_error("Usage service is unavailable"),
        }
    }

    pub fn cached_antigravity(&self) -> Option<AntigravitySnapshot> {
        if !self.is_enabled(Source::Antigravity) {
            return None;
        }
        self.last_antigravity
            .lock()
            .ok()
            .and_then(|cached| cached.clone())
    }

    pub fn refresh_antigravity(&self, visible: bool) -> AntigravitySnapshot {
        let snapshot = match self.antigravity.lock() {
            Ok(mut service) => service.fetch(),
            Err(_) => AntigravitySnapshot {
                status: "error".into(),
                plan: None,
                ai_credits: None,
                version: None,
                groups: Vec::new(),
                models: Vec::new(),
                fetched_at: claude_usage::unix_now(),
                message: Some("Antigravity 服务暂时不可用".into()),
            },
        };
        let delay = antigravity_delay(visible, &snapshot);
        if let Ok(mut due) = self.due.lock() {
            let now = Instant::now();
            due.last_antigravity = Some(now);
            due.antigravity = Some(now + delay);
        }
        if self.is_enabled(Source::Antigravity) {
            if let Ok(mut cached) = self.last_antigravity.lock() {
                *cached = Some(snapshot.clone());
            }
        }
        snapshot
    }

    fn day_start(&self, now: i64) -> i64 {
        claude_usage::local_day_start(now, self.offset_east_seconds.load(Ordering::Relaxed))
    }

    pub fn read_local(
        &self,
    ) -> (
        Option<Result<token_usage::TokenUsageSnapshot, String>>,
        Option<claude_usage::ClaudeUsageSnapshot>,
    ) {
        let now = claude_usage::unix_now();
        let day_start = self.day_start(now);
        let codex_tokens = self.is_enabled(Source::Codex).then(|| {
            token_usage::read(
                &claude_usage::format_iso_utc(day_start),
                day_start.max(0) as u64,
            )
        });
        let claude = if self.is_enabled(Source::Claude) {
            self.claude
                .lock()
                .ok()
                .map(|mut service| service.read(now, day_start))
        } else {
            None
        };
        (codex_tokens, claude)
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let hub = Arc::clone(self);
        thread::Builder::new()
            .name("usage-scheduler".into())
            .spawn(move || hub.run(app))
            .expect("usage scheduler thread");
    }

    fn run(&self, app: AppHandle) {
        let mut last_tick = (Instant::now(), SystemTime::now());
        loop {
            let (run_codex, run_local) = self.wait_for_work(&mut last_tick);
            let visible = panel_visible(&app);
            if run_codex && self.is_enabled(Source::Codex) {
                let snapshot = self.refresh_codex();
                let succeeded = snapshot.error.is_none()
                    && matches!(snapshot.status.as_str(), "ok" | "limit_reached");
                self.codex_refreshed(visible, succeeded);
                let _ = app.emit("usage://codex", &snapshot);
            }
            if run_local {
                let (tokens, claude) = self.read_local();
                let succeeded = !matches!(tokens, Some(Err(_)));
                match tokens {
                    Some(Ok(snapshot)) => {
                        let _ = app.emit("usage://tokens", &snapshot);
                    }
                    Some(Err(error)) => {
                        let _ = app.emit("usage://tokens-error", error);
                    }
                    None => {}
                }
                if let Some(snapshot) = claude {
                    let _ = app.emit("usage://claude", &snapshot);
                }
                // Run fast local loopback Antigravity fetch before remote ClaudeQuota so network
                // latency never delays local quota updates.
                if let Some(snapshot) = self.antigravity_if_due(visible) {
                    let _ = app.emit("usage://antigravity", &snapshot);
                }
                if let Some(snapshot) = self.claude_quota_if_due(visible) {
                    let _ = app.emit("usage://claude-quota", &snapshot);
                }
                if let Ok(mut due) = self.due.lock() {
                    due.local = Some(Instant::now() + LOCAL_TOKENS.next(visible, succeeded));
                }
            }
        }
    }

    /// Fetches the Claude subscription windows when enabled and due; the network call happens
    /// without holding the schedule lock.
    fn claude_quota_if_due(&self, visible: bool) -> Option<ClaudeQuotaSnapshot> {
        if !self.is_enabled(Source::ClaudeQuota) {
            return None;
        }
        let due = self
            .due
            .lock()
            .map(|due| due.claude_quota.is_none_or(|at| at <= Instant::now()))
            .unwrap_or(false);
        if !due {
            return None;
        }
        let snapshot = self.claude_quota.lock().ok()?.fetch();
        let delay = if snapshot.status == "rate_limited" {
            CLAUDE_QUOTA_RATE_LIMITED
        } else {
            CLAUDE_QUOTA.next(visible, snapshot.succeeded())
        };
        if let Ok(mut due) = self.due.lock() {
            let now = Instant::now();
            due.last_claude_quota = Some(now);
            due.claude_quota = Some(now + delay);
        }
        Some(snapshot)
    }

    /// Fetches Antigravity quota when enabled and due; the loopback request runs without holding
    /// the schedule lock so other sources are never blocked.
    fn antigravity_if_due(&self, visible: bool) -> Option<AntigravitySnapshot> {
        if !self.is_enabled(Source::Antigravity) {
            return None;
        }
        let due = self
            .due
            .lock()
            .map(|due| due.antigravity.is_none_or(|at| at <= Instant::now()))
            .unwrap_or(false);
        if !due {
            return None;
        }
        Some(self.refresh_antigravity(visible))
    }

    fn wait_for_work(&self, last_tick: &mut (Instant, SystemTime)) -> (bool, bool) {
        let mut due = match self.due.lock() {
            Ok(due) => due,
            Err(poisoned) => poisoned.into_inner(),
        };
        loop {
            let now = Instant::now();
            // Instant stops during sleep on macOS; a wall-clock jump means we just woke up.
            let wall = SystemTime::now();
            let monotonic = now.duration_since(last_tick.0);
            let elapsed_wall = wall.duration_since(last_tick.1).unwrap_or_default();
            if elapsed_wall > monotonic + WAKE_THRESHOLD {
                due.wake = true;
            }
            *last_tick = (now, wall);
            if std::mem::take(&mut due.wake) {
                due.codex = Some(now);
                due.local = Some(now);
                due.antigravity = None;
            }

            let codex_due = due.codex.is_none_or(|at| at <= now);
            let local_due = due.local.is_none_or(|at| at <= now);
            if codex_due || local_due {
                if codex_due {
                    due.codex = Some(now + CODEX_QUOTA.hidden);
                }
                if local_due {
                    due.local = Some(now + LOCAL_TOKENS.hidden);
                }
                return (codex_due, local_due);
            }
            let next = [due.codex, due.local]
                .into_iter()
                .flatten()
                .min()
                .unwrap_or(now + LOCAL_TOKENS.hidden);
            // Wake at least every 15s so a sleep/wake jump is noticed promptly.
            let timeout = next
                .saturating_duration_since(now)
                .min(Duration::from_secs(15));
            due = match self.signal.wait_timeout(due, timeout) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

fn antigravity_delay(visible: bool, snapshot: &AntigravitySnapshot) -> Duration {
    if snapshot.status == "rate_limited" {
        ANTIGRAVITY_RATE_LIMITED
    } else if matches!(snapshot.status.as_str(), "not_installed" | "not_running") {
        // Check gently when the app is not open instead of spinning every 30s.
        ANTIGRAVITY_QUOTA.hidden
    } else {
        ANTIGRAVITY_QUOTA.next(visible, snapshot.succeeded())
    }
}

pub fn panel_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cadence_is_faster_when_visible_and_retries_failures() {
        assert_eq!(CODEX_QUOTA.next(false, true), Duration::from_secs(60));
        assert_eq!(CODEX_QUOTA.next(true, true), Duration::from_secs(30));
        assert_eq!(CODEX_QUOTA.next(false, false), Duration::from_secs(30));
        assert_eq!(LOCAL_TOKENS.next(true, true), Duration::from_secs(10));
        assert_eq!(LOCAL_TOKENS.next(false, true), Duration::from_secs(30));
        assert_eq!(ANTIGRAVITY_QUOTA.next(true, true), Duration::from_secs(30));
        assert_eq!(ANTIGRAVITY_QUOTA.next(false, true), Duration::from_secs(60));
    }

    #[test]
    fn kick_makes_work_due_immediately() {
        let hub = UsageHub::new();
        {
            let mut due = hub.due.lock().unwrap();
            due.codex = Some(Instant::now() + Duration::from_secs(600));
            due.local = Some(Instant::now() + Duration::from_secs(600));
        }
        hub.kick(false);
        let mut tick = (Instant::now(), SystemTime::now());
        assert_eq!(hub.wait_for_work(&mut tick), (false, true));
        hub.kick(true);
        assert_eq!(hub.wait_for_work(&mut tick), (true, true));
    }

    #[test]
    fn monitoring_switches_persist_and_default_to_codex_only() {
        let directory = std::env::temp_dir().join(format!(
            "codex-meter-monitoring-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let hub = UsageHub::new();
        hub.load_preferences(Some(directory.clone()));
        assert_eq!(
            hub.monitoring(),
            Monitoring {
                codex: true,
                claude: false,
                claude_quota: false,
                antigravity: false,
            }
        );
        hub.set_enabled(Source::Claude, true).unwrap();
        hub.set_enabled(Source::Codex, false).unwrap();
        hub.set_enabled(Source::ClaudeQuota, true).unwrap();
        hub.set_enabled(Source::Antigravity, true).unwrap();

        let reloaded = UsageHub::new();
        reloaded.load_preferences(Some(directory.clone()));
        assert_eq!(
            reloaded.monitoring(),
            Monitoring {
                codex: false,
                claude: true,
                claude_quota: true,
                antigravity: true,
            }
        );
        let (tokens, _) = reloaded.read_local();
        assert!(
            tokens.is_none(),
            "Codex token stats are skipped while Codex is off"
        );
        assert!(reloaded.is_enabled(Source::ClaudeQuota));
        assert!(reloaded.is_enabled(Source::Antigravity));
        reloaded.set_enabled(Source::Claude, false).unwrap();
        assert!(
            !reloaded.is_enabled(Source::ClaudeQuota),
            "quota follows the Claude switch"
        );
        assert!(reloaded.claude_quota_if_due(false).is_none());
        reloaded.set_enabled(Source::Antigravity, false).unwrap();
        assert!(
            reloaded.antigravity_if_due(false).is_none(),
            "Antigravity stops polling once switched off"
        );
        assert!(
            reloaded.cached_antigravity().is_none(),
            "cached Antigravity snapshot is cleared when switched off"
        );
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn legacy_monitoring_config_defaults_antigravity_to_off() {
        let directory = std::env::temp_dir().join(format!(
            "codex-meter-legacy-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("monitoring.json"),
            br#"{"codex":true,"claude":true,"claudeQuota":true}"#,
        )
        .unwrap();

        let hub = UsageHub::new();
        hub.load_preferences(Some(directory.clone()));
        assert_eq!(
            hub.monitoring(),
            Monitoring {
                codex: true,
                claude: true,
                claude_quota: true,
                antigravity: false,
            }
        );
        assert!(hub.antigravity_if_due(true).is_none());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn antigravity_rate_limit_backs_off_without_affecting_other_sources() {
        let rate_limited = AntigravitySnapshot {
            status: "rate_limited".into(),
            plan: None,
            ai_credits: None,
            version: None,
            groups: Vec::new(),
            models: Vec::new(),
            fetched_at: 0,
            message: Some("too many requests".into()),
        };
        assert_eq!(
            antigravity_delay(true, &rate_limited),
            ANTIGRAVITY_RATE_LIMITED
        );

        let hub = UsageHub::new();
        assert!(hub.is_enabled(Source::Codex));
        assert!(!hub.is_enabled(Source::Antigravity));
        // Even while Antigravity is disabled or fails, Codex remains due independently.
        let mut tick = (Instant::now(), SystemTime::now());
        assert_eq!(hub.wait_for_work(&mut tick), (true, true));
    }

    #[test]
    fn opening_panel_skips_quota_when_recent() {
        let hub = UsageHub::new();
        hub.codex_refreshed(true, true);
        hub.panel_shown();
        let mut tick = (Instant::now(), SystemTime::now());
        assert_eq!(hub.wait_for_work(&mut tick), (false, true));
    }
}
