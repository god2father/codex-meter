//! Local Claude Code usage, read from the JSONL transcripts Claude Code writes under
//! `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). Only the `usage` block of
//! assistant messages is parsed; message content is never kept.

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Claude subscription windows reset five hours after the first message of a block.
pub const BLOCK_SECONDS: i64 = 5 * 60 * 60;
const LOOKBACK_SECONDS: i64 = 24 * 60 * 60;
const MAX_MODELS: usize = 4;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTokenBreakdown {
    pub input_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

impl ClaudeTokenBreakdown {
    fn from_usage(value: &Value) -> Option<Self> {
        let field = |name: &str| value.get(name).and_then(Value::as_u64).unwrap_or_default();
        let input_tokens = value.get("input_tokens")?.as_u64()?;
        let output_tokens = value.get("output_tokens")?.as_u64()?;
        let cache_creation_tokens = field("cache_creation_input_tokens");
        let cache_read_tokens = field("cache_read_input_tokens");
        Some(Self {
            input_tokens,
            cache_creation_tokens,
            cache_read_tokens,
            output_tokens,
            total_tokens: input_tokens
                .saturating_add(output_tokens)
                .saturating_add(cache_creation_tokens)
                .saturating_add(cache_read_tokens),
        })
    }

    fn add(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeBlock {
    #[serde(flatten)]
    pub usage: ClaudeTokenBreakdown,
    pub started_at: i64,
    pub resets_at: i64,
    pub messages: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    #[serde(flatten)]
    pub usage: ClaudeTokenBreakdown,
    pub updated_at: i64,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelUsage {
    pub model: String,
    pub total_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageSnapshot {
    pub source_available: bool,
    pub today: ClaudeTokenBreakdown,
    pub current_block: Option<ClaudeBlock>,
    pub current_session: Option<ClaudeSession>,
    pub models: Vec<ClaudeModelUsage>,
    pub fetched_at: u64,
}

#[derive(Clone, Debug)]
struct Entry {
    timestamp: i64,
    key: Option<String>,
    session: String,
    model: Option<String>,
    usage: ClaudeTokenBreakdown,
}

#[derive(Default)]
struct CachedFile {
    offset: u64,
    modified: u64,
    entries: Vec<Entry>,
}

/// Keeps parsed entries per file and only reads bytes appended since the last scan,
/// so a frequent background refresh stays cheap even with large transcripts.
#[derive(Default)]
pub struct ClaudeUsageService {
    files: HashMap<PathBuf, CachedFile>,
}

impl ClaudeUsageService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn read(&mut self, now: i64, day_start: i64) -> ClaudeUsageSnapshot {
        let roots = claude_roots();
        let cutoff = day_start.min(now - LOOKBACK_SECONDS);
        let mut seen = HashSet::new();
        for root in &roots {
            let mut paths = Vec::new();
            collect_jsonl_files(&root.join("projects"), cutoff, &mut paths);
            for (path, modified) in paths {
                self.update_file(&path, modified);
                seen.insert(path);
            }
        }
        self.files.retain(|path, _| seen.contains(path));
        let entries = self.files.values().flat_map(|file| file.entries.iter());
        summarize(
            entries,
            now,
            day_start,
            !roots.is_empty() && !seen.is_empty(),
        )
    }

    fn update_file(&mut self, path: &Path, modified: u64) {
        let length = path.metadata().map(|meta| meta.len()).unwrap_or_default();
        let cached = self.files.entry(path.to_path_buf()).or_default();
        if length < cached.offset {
            *cached = CachedFile::default();
        }
        if length == cached.offset && cached.modified == modified {
            return;
        }
        cached.modified = modified;
        let fallback_session = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_owned();
        let Ok(mut file) = File::open(path) else {
            return;
        };
        if file.seek(SeekFrom::Start(cached.offset)).is_err() {
            return;
        }
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        loop {
            line.clear();
            let Ok(read) = reader.read_line(&mut line) else {
                break;
            };
            // Stop before a partially written last line; it is re-read on the next scan.
            if read == 0 || !line.ends_with('\n') {
                break;
            }
            cached.offset += read as u64;
            if let Some(entry) = parse_line(&line, &fallback_session) {
                cached.entries.push(entry);
            }
        }
    }
}

fn parse_line(line: &str, fallback_session: &str) -> Option<Entry> {
    if !line.contains(r#""usage""#) || !line.contains(r#""assistant""#) {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = value.get("message")?;
    let usage = ClaudeTokenBreakdown::from_usage(message.get("usage")?)?;
    let timestamp = parse_iso_utc(value.get("timestamp")?.as_str()?)?;
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.starts_with('<'))
        .map(str::to_owned);
    let message_id = message.get("id").and_then(Value::as_str);
    let request_id = value.get("requestId").and_then(Value::as_str);
    // Claude Code writes one line per content block with the same usage; count it once.
    let key = message_id.map(|id| format!("{id}:{}", request_id.unwrap_or_default()));
    let session = value
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or(fallback_session)
        .to_owned();
    Some(Entry {
        timestamp,
        key,
        session,
        model,
        usage,
    })
}

fn summarize<'a>(
    entries: impl Iterator<Item = &'a Entry>,
    now: i64,
    day_start: i64,
    source_available: bool,
) -> ClaudeUsageSnapshot {
    let mut seen = HashSet::new();
    let mut unique: Vec<&Entry> = entries
        .filter(|entry| match &entry.key {
            Some(key) => seen.insert(key.as_str()),
            None => true,
        })
        .collect();
    unique.sort_by_key(|entry| entry.timestamp);

    let mut today = ClaudeTokenBreakdown::default();
    let mut models: HashMap<&str, ClaudeModelUsage> = HashMap::new();
    let mut sessions: HashMap<&str, ClaudeSession> = HashMap::new();
    let mut block: Option<ClaudeBlock> = None;
    let mut last_timestamp: Option<i64> = None;

    for entry in &unique {
        if entry.timestamp >= day_start {
            today.add(&entry.usage);
            if let Some(model) = entry.model.as_deref() {
                let item = models.entry(model).or_insert_with(|| ClaudeModelUsage {
                    model: model.to_owned(),
                    total_tokens: 0,
                    output_tokens: 0,
                });
                item.total_tokens = item.total_tokens.saturating_add(entry.usage.total_tokens);
                item.output_tokens = item.output_tokens.saturating_add(entry.usage.output_tokens);
            }
        }

        let session = sessions
            .entry(entry.session.as_str())
            .or_insert_with(|| ClaudeSession {
                usage: ClaudeTokenBreakdown::default(),
                updated_at: entry.timestamp,
                model: None,
            });
        session.usage.add(&entry.usage);
        session.updated_at = session.updated_at.max(entry.timestamp);
        if entry.model.is_some() {
            session.model = entry.model.clone();
        }

        let starts_new_block = match (&block, last_timestamp) {
            (Some(current), Some(last)) => {
                entry.timestamp >= current.resets_at || entry.timestamp - last >= BLOCK_SECONDS
            }
            _ => true,
        };
        if starts_new_block {
            let started_at = entry.timestamp - entry.timestamp.rem_euclid(3600);
            block = Some(ClaudeBlock {
                usage: ClaudeTokenBreakdown::default(),
                started_at,
                resets_at: started_at + BLOCK_SECONDS,
                messages: 0,
            });
        }
        if let Some(current) = block.as_mut() {
            current.usage.add(&entry.usage);
            current.messages += 1;
        }
        last_timestamp = Some(entry.timestamp);
    }

    let current_block = block.filter(|current| now < current.resets_at);
    let current_session = sessions
        .into_values()
        .max_by_key(|session| session.updated_at);
    let mut models: Vec<_> = models.into_values().collect();
    models.sort_by_key(|item| std::cmp::Reverse(item.total_tokens));
    models.truncate(MAX_MODELS);

    ClaudeUsageSnapshot {
        source_available: source_available || !unique.is_empty(),
        today,
        current_block,
        current_session,
        models,
        fetched_at: now.max(0) as u64,
    }
}

fn claude_roots() -> Vec<PathBuf> {
    if let Some(value) = env::var_os("CLAUDE_CONFIG_DIR") {
        let roots: Vec<_> = env::split_paths(&value)
            .flat_map(|path| {
                path.to_string_lossy()
                    .split(',')
                    .map(|part| PathBuf::from(part.trim()))
                    .collect::<Vec<_>>()
            })
            .filter(|path| !path.as_os_str().is_empty() && path.is_dir())
            .collect();
        if !roots.is_empty() {
            return roots;
        }
    }
    let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    [home.join(".config").join("claude"), home.join(".claude")]
        .into_iter()
        .filter(|path| path.join("projects").is_dir())
        .collect()
}

fn collect_jsonl_files(directory: &Path, cutoff: i64, output: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_jsonl_files(&path, cutoff, output);
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs())
                .unwrap_or_default();
            if modified as i64 >= cutoff {
                output.push((path, modified));
            }
        }
    }
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs() as i64)
        .unwrap_or_default()
}

/// Local midnight for a timezone given in seconds east of UTC.
pub fn local_day_start(now: i64, offset_east_seconds: i64) -> i64 {
    (now + offset_east_seconds).div_euclid(86_400) * 86_400 - offset_east_seconds
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` into unix seconds.
pub fn parse_iso_utc(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| value.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let mut rest = &value[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        rest = &fraction[digits..];
    }
    let offset = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) => {
            let hours = rest.get(1..3)?.parse::<i64>().ok()?;
            let minutes = rest.get(4..6)?.parse::<i64>().ok()?;
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            sign * (hours * 3600 + minutes * 60)
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Formats unix seconds the way `Date.prototype.toISOString` does.
pub fn format_iso_utc(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let seconds = unix.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(timestamp: &str, id: &str, session: &str, input: u64, output: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": timestamp,
            "sessionId": session,
            "requestId": format!("req-{id}"),
            "message": {
                "id": id,
                "model": "claude-opus-5-5",
                "content": [{"type": "text", "text": "never stored"}],
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 100
                }
            }
        })
        .to_string()
    }

    #[test]
    fn parses_and_formats_iso_timestamps() {
        let value = parse_iso_utc("2026-11-10T13:42:14.584Z").unwrap();
        assert_eq!(format_iso_utc(value), "2026-11-10T13:42:14.000Z");
        assert_eq!(parse_iso_utc("2026-11-10T21:42:14+08:00"), Some(value));
        assert_eq!(parse_iso_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_utc("not a date"), None);
        // UTC+8 midnight on 2026-11-10 is 16:00 UTC the day before.
        assert_eq!(
            format_iso_utc(local_day_start(value, 8 * 3600)),
            "2026-11-09T16:00:00.000Z"
        );
    }

    #[test]
    fn dedupes_messages_and_tracks_block_session_and_today() {
        let directory = env::temp_dir().join(format!(
            "codex-meter-claude-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let project = directory.join("projects").join("demo");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("session-a.jsonl");
        let content = [
            // Yesterday, outside today and outside the active block.
            line("2026-11-09T01:00:00.000Z", "m0", "a", 1_000, 1_000),
            line("2026-11-10T10:15:00.000Z", "m1", "a", 5, 50),
            // Same message split across two lines must count once.
            line("2026-11-10T10:15:01.000Z", "m1", "a", 5, 50),
            r#"{"type":"user","message":{"content":"hi"}}"#.to_owned(),
            line("2026-11-10T11:00:00.000Z", "m2", "b", 7, 70),
        ]
        .join("\n")
            + "\n";
        fs::write(&path, &content).unwrap();

        let mut service = ClaudeUsageService::new();
        let mut paths = Vec::new();
        collect_jsonl_files(&directory.join("projects"), 0, &mut paths);
        for (path, modified) in &paths {
            service.update_file(path, *modified);
        }
        let now = parse_iso_utc("2026-11-10T12:00:00Z").unwrap();
        let day_start = parse_iso_utc("2026-11-10T00:00:00Z").unwrap();
        let snapshot = summarize(
            service.files.values().flat_map(|file| file.entries.iter()),
            now,
            day_start,
            true,
        );

        assert_eq!(snapshot.today.input_tokens, 12);
        assert_eq!(snapshot.today.output_tokens, 120);
        assert_eq!(snapshot.today.total_tokens, 12 + 120 + 2 * 110);
        let block = snapshot.current_block.unwrap();
        assert_eq!(block.messages, 2);
        assert_eq!(
            block.started_at,
            parse_iso_utc("2026-11-10T10:00:00Z").unwrap()
        );
        assert_eq!(
            block.resets_at,
            parse_iso_utc("2026-11-10T15:00:00Z").unwrap()
        );
        let session = snapshot.current_session.unwrap();
        assert_eq!(session.usage.output_tokens, 70);
        assert_eq!(snapshot.models[0].model, "claude-opus-5-5");

        // Appending a line only parses the new bytes.
        let appended = line("2026-11-10T11:30:00.000Z", "m3", "b", 1, 1) + "\n";
        fs::write(&path, content + &appended).unwrap();
        let before = service.files[&path].offset;
        service.update_file(&path, u64::MAX);
        assert!(service.files[&path].offset > before);
        // Raw entries keep the duplicate line; dedupe happens when summarizing.
        assert_eq!(service.files[&path].entries.len(), 5);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn expired_block_is_not_reported() {
        let entry = Entry {
            timestamp: parse_iso_utc("2026-11-10T01:00:00Z").unwrap(),
            key: None,
            session: "a".into(),
            model: None,
            usage: ClaudeTokenBreakdown::default(),
        };
        let now = parse_iso_utc("2026-11-10T07:00:00Z").unwrap();
        let snapshot = summarize([entry].iter(), now, 0, true);
        assert!(snapshot.current_block.is_none());
    }
}
