use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const RECENT_FILE_FALLBACK_COUNT: usize = 8;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageBreakdown {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
}

impl TokenUsageBreakdown {
    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            input_tokens: value.get("input_tokens")?.as_u64()?,
            cached_input_tokens: value
                .get("cached_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            output_tokens: value.get("output_tokens")?.as_u64()?,
            reasoning_output_tokens: value
                .get("reasoning_output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            total_tokens: value.get("total_tokens")?.as_u64()?,
        })
    }

    fn delta_since(&self, previous: &Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(previous.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(previous.cached_input_tokens),
            output_tokens: self.output_tokens.saturating_sub(previous.output_tokens),
            reasoning_output_tokens: self
                .reasoning_output_tokens
                .saturating_sub(previous.reasoning_output_tokens),
            total_tokens: self.total_tokens.saturating_sub(previous.total_tokens),
        }
    }

    fn add(&mut self, value: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(value.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(value.cached_input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(value.output_tokens);
        self.reasoning_output_tokens = self
            .reasoning_output_tokens
            .saturating_add(value.reasoning_output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(value.total_tokens);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsagePeriod {
    #[serde(flatten)]
    pub usage: TokenUsageBreakdown,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSnapshot {
    pub recent_turn: Option<TokenUsagePeriod>,
    pub today: TokenUsageBreakdown,
    pub current_session: Option<TokenUsagePeriod>,
    pub fetched_at: u64,
    pub source_available: bool,
}

#[derive(Default)]
struct FileTokenStats {
    today: TokenUsageBreakdown,
    recent_turn: Option<TokenUsagePeriod>,
    current_session: Option<TokenUsagePeriod>,
}

struct TurnTracker {
    baseline: TokenUsageBreakdown,
    started_at: String,
    latest: Option<TokenUsageBreakdown>,
    updated_at: String,
}

impl TurnTracker {
    fn period(&self, active: bool) -> Option<TokenUsagePeriod> {
        let latest = self.latest.as_ref()?;
        Some(TokenUsagePeriod {
            usage: latest.delta_since(&self.baseline),
            started_at: Some(self.started_at.clone()),
            updated_at: self.updated_at.clone(),
            active,
        })
    }
}

pub fn read(day_start_iso: &str, day_start_unix: u64) -> Result<TokenUsageSnapshot, String> {
    if day_start_iso.len() < 20 {
        return Err("今日统计起始时间无效".into());
    }

    let Some(codex_home) = codex_home() else {
        return Ok(empty_snapshot(false));
    };
    let files = candidate_session_files(&codex_home, day_start_unix)?;
    if files.is_empty() {
        return Ok(empty_snapshot(false));
    }

    let mut today = TokenUsageBreakdown::default();
    let mut recent_turn: Option<TokenUsagePeriod> = None;
    let mut current_session: Option<TokenUsagePeriod> = None;

    for path in files {
        let stats = scan_file(&path, day_start_iso);
        today.add(&stats.today);
        choose_latest(&mut recent_turn, stats.recent_turn);
        choose_latest(&mut current_session, stats.current_session);
    }

    let source_available = recent_turn.is_some() || current_session.is_some();
    Ok(TokenUsageSnapshot {
        recent_turn,
        today,
        current_session,
        fetched_at: unix_seconds(),
        source_available,
    })
}

fn empty_snapshot(source_available: bool) -> TokenUsageSnapshot {
    TokenUsageSnapshot {
        recent_turn: None,
        today: TokenUsageBreakdown::default(),
        current_session: None,
        fetched_at: unix_seconds(),
        source_available,
    }
}

fn codex_home() -> Option<PathBuf> {
    if let Some(path) = env::var_os("CODEX_HOME") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }

    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".codex"))
}

fn candidate_session_files(codex_home: &Path, day_start_unix: u64) -> Result<Vec<PathBuf>, String> {
    let mut discovered = Vec::new();
    for directory in ["sessions", "archived_sessions"] {
        collect_jsonl_files(&codex_home.join(directory), &mut discovered)
            .map_err(|error| error.to_string())?;
    }

    let mut by_name: HashMap<String, (PathBuf, u64)> = HashMap::new();
    for path in discovered {
        let modified = path
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(system_time_seconds)
            .unwrap_or_default();
        let key = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        match by_name.get(&key) {
            Some((_, existing_modified)) if *existing_modified >= modified => {}
            _ => {
                by_name.insert(key, (path, modified));
            }
        }
    }

    let mut files: Vec<_> = by_name.into_values().collect();
    files.sort_by(|left, right| right.1.cmp(&left.1));
    Ok(files
        .into_iter()
        .enumerate()
        .filter(|(index, (_, modified))| {
            *modified >= day_start_unix || *index < RECENT_FILE_FALLBACK_COUNT
        })
        .map(|(_, (path, _))| path)
        .collect())
}

fn collect_jsonl_files(directory: &Path, output: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let path = entry.path();
        if file_type.is_dir() {
            let _ = collect_jsonl_files(&path, output);
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            output.push(path);
        }
    }
    Ok(())
}

fn scan_file(path: &Path, day_start_iso: &str) -> FileTokenStats {
    let Ok(file) = File::open(path) else {
        return FileTokenStats::default();
    };
    let mut stats = FileTokenStats::default();
    let mut previous = TokenUsageBreakdown::default();
    let mut has_previous = false;
    let mut active_turn: Option<TurnTracker> = None;
    let mut fallback_last: Option<TokenUsagePeriod> = None;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !is_relevant_event_line(&line) {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(event_type) = message.pointer("/payload/type").and_then(Value::as_str) else {
            continue;
        };
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        match event_type {
            "task_started" | "turn_started" => {
                active_turn = Some(TurnTracker {
                    baseline: previous.clone(),
                    started_at: timestamp.clone(),
                    latest: None,
                    updated_at: timestamp,
                });
            }
            "token_count" => {
                let Some(total) = message
                    .pointer("/payload/info/total_token_usage")
                    .and_then(TokenUsageBreakdown::from_value)
                else {
                    continue;
                };

                if timestamp.as_str() >= day_start_iso {
                    let delta = if has_previous {
                        total.delta_since(&previous)
                    } else {
                        total.clone()
                    };
                    stats.today.add(&delta);
                }
                previous = total.clone();
                has_previous = true;

                stats.current_session = Some(TokenUsagePeriod {
                    usage: total,
                    started_at: None,
                    updated_at: timestamp.clone(),
                    active: active_turn.is_some(),
                });

                if let Some(last) = message
                    .pointer("/payload/info/last_token_usage")
                    .and_then(TokenUsageBreakdown::from_value)
                {
                    fallback_last = Some(TokenUsagePeriod {
                        usage: last,
                        started_at: None,
                        updated_at: timestamp.clone(),
                        active: false,
                    });
                }

                if let Some(turn) = active_turn.as_mut() {
                    turn.latest = Some(previous.clone());
                    turn.updated_at = timestamp;
                    stats.recent_turn = turn.period(true);
                }
            }
            "task_complete" | "turn_complete" => {
                if let Some(mut turn) = active_turn.take() {
                    if !timestamp.is_empty() {
                        turn.updated_at = timestamp;
                    }
                    if let Some(period) = turn.period(false) {
                        stats.recent_turn = Some(period);
                    }
                }
            }
            _ => {}
        }
    }

    if stats.recent_turn.is_none() {
        stats.recent_turn = fallback_last;
    }
    stats
}

fn is_relevant_event_line(line: &str) -> bool {
    line.contains(r#""type":"event_msg""#)
        && [
            r#""type":"token_count""#,
            r#""type":"task_started""#,
            r#""type":"turn_started""#,
            r#""type":"task_complete""#,
            r#""type":"turn_complete""#,
        ]
        .iter()
        .any(|event_type| line.contains(event_type))
}

fn choose_latest(target: &mut Option<TokenUsagePeriod>, candidate: Option<TokenUsagePeriod>) {
    let Some(candidate) = candidate else {
        return;
    };
    let replace = target
        .as_ref()
        .map(|current| candidate.updated_at > current.updated_at)
        .unwrap_or(true);
    if replace {
        *target = Some(candidate);
    }
}

fn system_time_seconds(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_secs())
}

fn unix_seconds() -> u64 {
    system_time_seconds(SystemTime::now()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_turn_and_today_from_cumulative_token_events() {
        let path = env::temp_dir().join(format!(
            "codex-meter-token-{}-{}.jsonl",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let content = [
            event(
                "2026-07-26T15:59:00.000Z",
                "token_count",
                Some((80, 20, 10, 5, 100)),
            ),
            event("2026-07-26T16:00:01.000Z", "task_started", None),
            event(
                "2026-07-26T16:00:10.000Z",
                "token_count",
                Some((120, 30, 20, 8, 150)),
            ),
            event(
                "2026-07-26T16:00:12.000Z",
                "token_count",
                Some((120, 30, 20, 8, 150)),
            ),
            event(
                "2026-07-26T16:00:20.000Z",
                "token_count",
                Some((150, 40, 30, 12, 190)),
            ),
            event("2026-07-26T16:00:21.000Z", "task_complete", None),
        ]
        .join("\n");
        fs::write(&path, content).unwrap();

        let stats = scan_file(&path, "2026-07-26T16:00:00.000Z");
        let _ = fs::remove_file(&path);

        assert_eq!(stats.today.total_tokens, 90);
        assert_eq!(stats.today.input_tokens, 70);
        let turn = stats.recent_turn.unwrap();
        assert_eq!(turn.usage.total_tokens, 90);
        assert_eq!(turn.usage.input_tokens, 70);
        assert!(!turn.active);
        assert_eq!(stats.current_session.unwrap().usage.total_tokens, 190);
    }

    fn event(
        timestamp: &str,
        event_type: &str,
        usage: Option<(u64, u64, u64, u64, u64)>,
    ) -> String {
        let info = usage.map(|(input, cached, output, reasoning, total)| {
            serde_json::json!({
                "total_token_usage": {
                    "input_tokens": input,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                    "total_tokens": total
                },
                "last_token_usage": {
                    "input_tokens": input,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                    "total_tokens": total
                }
            })
        });
        serde_json::json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": event_type,
                "info": info
            }
        })
        .to_string()
    }
}
