//! Background usage refresh. Polling used to live in webview `setInterval` timers, which
//! macOS WebKit and Windows WebView2 suspend or throttle while the tray panel is hidden, so
//! the tray only updated after a click. This thread owns the cadence instead and pushes
//! snapshots to the webview as events.

use crate::{
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
}

/// Which sources are monitored. Codex keeps its previous always-on behaviour by default;
/// Claude reads local transcripts, so it stays off until the user turns it on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Monitoring {
    pub codex: bool,
    pub claude: bool,
}

impl Default for Monitoring {
    fn default() -> Self {
        Self {
            codex: true,
            claude: false,
        }
    }
}

#[derive(Default)]
struct Due {
    codex: Option<Instant>,
    local: Option<Instant>,
    last_codex: Option<Instant>,
    wake: bool,
}

pub struct UsageHub {
    pub codex: Arc<Mutex<CodexService>>,
    claude: Mutex<ClaudeUsageService>,
    offset_east_seconds: AtomicI64,
    codex_enabled: AtomicBool,
    claude_enabled: AtomicBool,
    preferences_path: Mutex<Option<PathBuf>>,
    due: Mutex<Due>,
    signal: Condvar,
}

impl UsageHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            codex: Arc::new(Mutex::new(CodexService::new())),
            claude: Mutex::new(ClaudeUsageService::new()),
            offset_east_seconds: AtomicI64::new(0),
            codex_enabled: AtomicBool::new(Monitoring::default().codex),
            claude_enabled: AtomicBool::new(Monitoring::default().claude),
            preferences_path: Mutex::new(None),
            due: Mutex::new(Due::default()),
            signal: Condvar::new(),
        })
    }

    pub fn monitoring(&self) -> Monitoring {
        Monitoring {
            codex: self.codex_enabled.load(Ordering::Relaxed),
            claude: self.claude_enabled.load(Ordering::Relaxed),
        }
    }

    pub fn is_enabled(&self, source: Source) -> bool {
        match source {
            Source::Codex => self.codex_enabled.load(Ordering::Relaxed),
            Source::Claude => self.claude_enabled.load(Ordering::Relaxed),
        }
    }

    fn apply(&self, monitoring: Monitoring) {
        self.codex_enabled
            .store(monitoring.codex, Ordering::Relaxed);
        self.claude_enabled
            .store(monitoring.claude, Ordering::Relaxed);
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
        if enabled {
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
            }
        }
        self.signal.notify_all();
    }

    /// Called when the panel opens: refresh everything that is not fresh.
    pub fn panel_shown(&self) {
        let stale = self
            .due
            .lock()
            .map(|due| {
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
                if let Ok(mut due) = self.due.lock() {
                    due.local = Some(Instant::now() + LOCAL_TOKENS.next(visible, succeeded));
                }
            }
        }
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
            "codex-meter-monitoring-{}-{:?}",
            std::process::id(),
            Instant::now()
        ));
        let hub = UsageHub::new();
        hub.load_preferences(Some(directory.clone()));
        assert_eq!(
            hub.monitoring(),
            Monitoring {
                codex: true,
                claude: false
            }
        );
        hub.set_enabled(Source::Claude, true).unwrap();
        hub.set_enabled(Source::Codex, false).unwrap();

        let reloaded = UsageHub::new();
        reloaded.load_preferences(Some(directory.clone()));
        assert_eq!(
            reloaded.monitoring(),
            Monitoring {
                codex: false,
                claude: true
            }
        );
        let (tokens, _) = reloaded.read_local();
        assert!(
            tokens.is_none(),
            "Codex token stats are skipped while Codex is off"
        );
        let _ = fs::remove_dir_all(&directory);
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
