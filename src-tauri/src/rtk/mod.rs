use chrono::{DateTime, Datelike, Local, LocalResult, NaiveDateTime, TimeZone, Utc};
use rusqlite::{Connection, Row};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const MAX_GAP_MS: i64 = 4 * 3600 * 1000;
const TRAY_ID: &str = "pake-tray";

/// Handle to the disabled tray menu item that shows the savings readout.
/// macOS shows the live text in the menu-bar title; on Windows/Linux (no
/// menu-bar title support) this menu item + the tooltip are the readout.
pub struct SavingsTrayItem(pub tauri::menu::MenuItem<tauri::Wry>);

static COPILOT_MODEL_CACHE: OnceLock<Mutex<HashMap<String, CopilotModelCacheEntry>>> =
    OnceLock::new();
static CLAUDE_CACHE: OnceLock<Mutex<HashMap<PathBuf, ClaudeCacheEntry>>> = OnceLock::new();

#[derive(Clone, Debug)]
struct CopilotModelCacheEntry {
    mtime_ms: u128,
    model: Option<String>,
}

#[derive(Clone, Debug)]
struct ClaudeCacheEntry {
    mtime_ms: u128,
    size: u64,
    records: Vec<Activity>,
}

#[derive(Clone, Debug)]
struct Activity {
    ts: i64,
    model: String,
    via_auto: bool,
    harness: String,
    #[allow(dead_code)]
    cwd: Option<String>,
}

#[derive(Clone, Debug)]
struct CommandActivityRow {
    #[allow(dead_code)]
    timestamp: String,
    ts: Option<i64>,
    saved: i64,
    input: i64,
    #[allow(dead_code)]
    project_path: Option<String>,
    model: String,
    harness: String,
    #[allow(dead_code)]
    via_auto: bool,
    gap_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Summary {
    pub commands: i64,
    pub input: i64,
    pub output: i64,
    pub saved: i64,
    pub pct: f64,
    pub time_ms: i64,
    pub since: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct SeriesRow {
    period: String,
    saved: i64,
    input: i64,
    commands: i64,
}

#[derive(Clone, Debug, Serialize)]
struct ProjectSeriesRow {
    period: String,
    project: String,
    saved: i64,
}

#[derive(Clone, Debug, Serialize)]
struct ByModelRow {
    model: String,
    cmds: i64,
    saved: i64,
    input: i64,
    pct: f64,
}

#[derive(Clone, Debug, Serialize)]
struct ByHarnessRow {
    harness: String,
    cmds: i64,
    saved: i64,
    input: i64,
    pct: f64,
}

#[derive(Clone, Debug, Serialize)]
struct ModelSeriesRow {
    period: String,
    model: String,
    saved: i64,
}

#[derive(Clone, Debug, Serialize)]
struct ByCommandRow {
    command: String,
    n: i64,
    saved: i64,
    input: i64,
}

#[derive(Clone, Debug, Serialize)]
struct RecentRow {
    timestamp: String,
    rtk_cmd: String,
    saved_tokens: i64,
    savings_pct: f64,
}

#[derive(Clone, Copy)]
enum Bucket {
    Daily,
    Weekly,
    Monthly,
}

impl Bucket {
    fn from_name(name: &str) -> Self {
        match name {
            "weekly" => Self::Weekly,
            "monthly" => Self::Monthly,
            _ => Self::Daily,
        }
    }

    fn sql_expr(self) -> &'static str {
        match self {
            Self::Daily => "strftime('%Y-%m-%d', timestamp, 'localtime')",
            Self::Weekly => "strftime('%Y-W%W', timestamp, 'localtime')",
            Self::Monthly => "strftime('%Y-%m', timestamp, 'localtime')",
        }
    }
}

fn copilot_cache() -> &'static Mutex<HashMap<String, CopilotModelCacheEntry>> {
    COPILOT_MODEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn claude_cache() -> &'static Mutex<HashMap<PathBuf, ClaudeCacheEntry>> {
    CLAUDE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn rtk_db_path() -> PathBuf {
    if let Some(path) = env::var_os("RTK_DB") {
        return PathBuf::from(path);
    }
    // ponytail: per-OS config dir (mirrors the `directories` convention rtk uses);
    // runtime OS match so every branch compiles/builds on all targets.
    match std::env::consts::OS {
        "macos" => home_dir()
            .join("Library")
            .join("Application Support")
            .join("rtk")
            .join("history.db"),
        "windows" => env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("rtk")
            .join("history.db"),
        _ => env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("rtk")
            .join("history.db"),
    }
}

fn copilot_db_path() -> PathBuf {
    env::var_os("COPILOT_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".copilot").join("data.db"))
}

fn claude_dir() -> PathBuf {
    env::var_os("CLAUDE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".claude").join("projects"))
}

fn codex_db_path() -> PathBuf {
    env::var_os("CODEX_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex").join("state_5.sqlite"))
}

fn copilot_state_dir() -> PathBuf {
    env::var_os("COPILOT_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".copilot").join("session-state"))
}

pub fn db_exists() -> bool {
    rtk_db_path().exists()
}

fn query_db<T, F>(db_path: &Path, sql: &str, mut mapper: F) -> Vec<T>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    if !db_path.exists() {
        return Vec::new();
    }

    let Ok(conn) = Connection::open(db_path) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| mapper(row)) else {
        return Vec::new();
    };

    rows.filter_map(Result::ok).collect()
}

fn query_rtk<T, F>(sql: &str, mapper: F) -> Vec<T>
where
    F: FnMut(&Row<'_>) -> rusqlite::Result<T>,
{
    query_db(&rtk_db_path(), sql, mapper)
}

fn metadata_mtime_ms(metadata: &Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn to_ms(value: &str) -> Option<i64> {
    let mut s = value.trim().replacen(' ', "T", 1);
    if s.is_empty() {
        return None;
    }

    let tail = s.get(10..).unwrap_or("");
    if !tail.contains('Z') && !tail.contains('+') {
        s.push('Z');
    }

    if let Ok(dt) = DateTime::parse_from_rfc3339(&s) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = DateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f%z") {
        return Some(dt.timestamp_millis());
    }

    let without_z = s.strip_suffix('Z').unwrap_or(&s);
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(without_z, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(dt, Utc).timestamp_millis());
        }
    }

    None
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn where_projects(list: &[String]) -> String {
    if list.is_empty() {
        return String::new();
    }

    let valid = get_projects();
    let valid: HashSet<&str> = valid.iter().map(String::as_str).collect();
    let selected = list
        .iter()
        .filter(|project| valid.contains(project.as_str()))
        .map(|project| sql_string(project))
        .collect::<Vec<_>>();

    if selected.is_empty() {
        String::new()
    } else {
        format!(" WHERE project_path IN ({})", selected.join(","))
    }
}

pub fn get_projects() -> Vec<String> {
    query_rtk(
        "SELECT DISTINCT project_path FROM commands WHERE project_path != '' ORDER BY project_path",
        |row| row.get::<_, String>(0),
    )
}

pub fn summary(project_paths: &[String]) -> Summary {
    let where_clause = where_projects(project_paths);
    let sql = format!(
        "SELECT COUNT(*) commands,
                COALESCE(SUM(input_tokens),0) input,
                COALESCE(SUM(output_tokens),0) output,
                COALESCE(SUM(saved_tokens),0) saved,
                COALESCE(SUM(exec_time_ms),0) time_ms,
                MIN(timestamp) since
         FROM commands{where_clause}"
    );

    let row = query_rtk(&sql, |row| {
        Ok(Summary {
            commands: row.get::<_, i64>(0)?,
            input: row.get::<_, i64>(1)?,
            output: row.get::<_, i64>(2)?,
            saved: row.get::<_, i64>(3)?,
            pct: 0.0,
            time_ms: row.get::<_, i64>(4)?,
            since: row.get::<_, Option<String>>(5)?,
        })
    })
    .into_iter()
    .next()
    .unwrap_or_default();

    let pct = if row.input > 0 {
        (row.saved as f64 / row.input as f64) * 100.0
    } else {
        0.0
    };

    Summary { pct, ..row }
}

fn timeseries(bucket: &str, project_paths: &[String]) -> Vec<SeriesRow> {
    let expr = Bucket::from_name(bucket).sql_expr();
    let where_clause = where_projects(project_paths);
    let sql = format!(
        "SELECT {expr} period,
                COALESCE(SUM(saved_tokens),0) saved,
                COALESCE(SUM(input_tokens),0) input,
                COUNT(*) commands
         FROM commands{where_clause}
         GROUP BY period ORDER BY period"
    );

    query_rtk(&sql, |row| {
        Ok(SeriesRow {
            period: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            saved: row.get::<_, i64>(1)?,
            input: row.get::<_, i64>(2)?,
            commands: row.get::<_, i64>(3)?,
        })
    })
}

fn timeseries_by_project(bucket: &str, project_paths: &[String]) -> Vec<ProjectSeriesRow> {
    let expr = Bucket::from_name(bucket).sql_expr();
    let where_clause = where_projects(project_paths);
    let sql = format!(
        "SELECT {expr} period,
                project_path project,
                COALESCE(SUM(saved_tokens),0) saved
         FROM commands{where_clause}
         GROUP BY period, project_path
         HAVING saved <> 0
         ORDER BY period"
    );

    query_rtk(&sql, |row| {
        Ok(ProjectSeriesRow {
            period: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            project: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            saved: row.get::<_, i64>(2)?,
        })
    })
}

fn normalize_cmd(cmd: &str) -> String {
    let key = cmd
        .trim()
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    if key.is_empty() {
        cmd.to_string()
    } else {
        key
    }
}

fn by_command(project_paths: &[String], limit: usize) -> Vec<ByCommandRow> {
    let where_clause = where_projects(project_paths);
    let sql = format!(
        "SELECT rtk_cmd,
                COUNT(*) n,
                COALESCE(SUM(saved_tokens),0) saved,
                COALESCE(SUM(input_tokens),0) input
         FROM commands{where_clause}
         GROUP BY rtk_cmd"
    );

    let rows = query_rtk(&sql, |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    });

    let mut merged: HashMap<String, ByCommandRow> = HashMap::new();
    for (cmd, n, saved, input) in rows {
        let key = normalize_cmd(&cmd);
        let entry = merged.entry(key.clone()).or_insert(ByCommandRow {
            command: key,
            n: 0,
            saved: 0,
            input: 0,
        });
        entry.n += n;
        entry.saved += saved;
        entry.input += input;
    }

    let mut out = merged.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| b.saved.cmp(&a.saved));
    out.truncate(limit);
    out
}

fn recent(project_paths: &[String], limit: usize) -> Vec<RecentRow> {
    let where_clause = where_projects(project_paths);
    let sql = format!(
        "SELECT timestamp, rtk_cmd, saved_tokens, savings_pct
         FROM commands{where_clause} ORDER BY id DESC LIMIT {}",
        if limit == 0 { 50 } else { limit }
    );

    query_rtk(&sql, |row| {
        Ok(RecentRow {
            timestamp: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            rtk_cmd: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            saved_tokens: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            savings_pct: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
        })
    })
}

fn resolve_copilot_model(id: &str, raw_model: Option<String>) -> (String, bool) {
    let raw = raw_model.unwrap_or_default();
    if !raw.is_empty() && raw != "auto" {
        return (raw, false);
    }

    let model = copilot_event_model(id).unwrap_or_else(|| "(unknown)".to_string());
    (model, raw == "auto")
}

fn copilot_event_model(id: &str) -> Option<String> {
    if id.is_empty() {
        return None;
    }

    let file = copilot_state_dir().join(id).join("events.jsonl");
    let metadata = fs::metadata(&file).ok()?;
    let mtime_ms = metadata_mtime_ms(&metadata);

    if let Ok(cache) = copilot_cache().lock() {
        if let Some(cached) = cache.get(id) {
            if cached.mtime_ms == mtime_ms {
                return cached.model.clone();
            }
        }
    }

    let reader = BufReader::new(File::open(&file).ok()?);
    let mut model = None;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"assistant.message\"") || !line.contains("\"model\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("assistant.message") {
            if let Some(found) = value
                .get("data")
                .and_then(|data| data.get("model"))
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
            {
                model = Some(found.to_string());
                break;
            }
        }
    }

    if let Ok(mut cache) = copilot_cache().lock() {
        cache.insert(
            id.to_string(),
            CopilotModelCacheEntry {
                mtime_ms,
                model: model.clone(),
            },
        );
    }

    model
}

fn copilot_activity() -> Vec<Activity> {
    #[derive(Debug)]
    struct RawCopilot {
        id: String,
        ts: String,
        model: Option<String>,
    }

    query_db(
        &copilot_db_path(),
        "SELECT id, created_at ts, model FROM sessions",
        |row| {
            Ok(RawCopilot {
                id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                ts: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                model: row.get::<_, Option<String>>(2)?,
            })
        },
    )
    .into_iter()
    .filter_map(|row| {
        let ts = to_ms(&row.ts)?;
        let (model, via_auto) = resolve_copilot_model(&row.id, row.model);
        Some(Activity {
            ts,
            model,
            via_auto,
            harness: "copilot".to_string(),
            cwd: None,
        })
    })
    .collect()
}

fn codex_activity() -> Vec<Activity> {
    #[derive(Debug)]
    struct RawCodex {
        ts: String,
        model: String,
        cwd: Option<String>,
    }

    query_db(
        &codex_db_path(),
        "SELECT strftime('%Y-%m-%dT%H:%M:%S', created_at, 'unixepoch') ts,
                COALESCE(NULLIF(model,''),'(unknown)') model, cwd
         FROM threads WHERE model IS NOT NULL",
        |row| {
            Ok(RawCodex {
                ts: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                model: row
                    .get::<_, Option<String>>(1)?
                    .unwrap_or_else(|| "(unknown)".to_string()),
                cwd: row.get::<_, Option<String>>(2)?,
            })
        },
    )
    .into_iter()
    .filter_map(|row| {
        Some(Activity {
            ts: to_ms(&row.ts)?,
            model: row.model,
            via_auto: false,
            harness: "codex".to_string(),
            cwd: row.cwd,
        })
    })
    .collect()
}

fn jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            jsonl_files(&path, out);
        } else if file_type.is_file() && path.to_string_lossy().ends_with(".jsonl") {
            out.push(path);
        }
    }
}

fn parse_claude_file(file: &Path, metadata: &Metadata) -> Vec<Activity> {
    let mtime_ms = metadata_mtime_ms(metadata);
    let size = metadata.len();

    if let Ok(cache) = claude_cache().lock() {
        if let Some(cached) = cache.get(file) {
            if cached.mtime_ms == mtime_ms && cached.size == size {
                return cached.records.clone();
            }
        }
    }

    let Ok(handle) = File::open(file) else {
        return Vec::new();
    };

    let mut records = Vec::new();
    for line in BufReader::new(handle).lines().map_while(Result::ok) {
        if !line.contains("\"assistant\"") || !line.contains("\"model\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(model) = value
            .get("message")
            .and_then(|message| message.get("model"))
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
        else {
            continue;
        };
        let Some(ts) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(to_ms)
        else {
            continue;
        };
        records.push(Activity {
            ts,
            model: model.to_string(),
            via_auto: false,
            harness: "claude".to_string(),
            cwd: value
                .get("cwd")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        });
    }

    if let Ok(mut cache) = claude_cache().lock() {
        cache.insert(
            file.to_path_buf(),
            ClaudeCacheEntry {
                mtime_ms,
                size,
                records: records.clone(),
            },
        );
    }

    records
}

fn claude_activity(min_ms: i64) -> Vec<Activity> {
    let dir = claude_dir();
    if !dir.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    jsonl_files(&dir, &mut files);

    let min_ms = min_ms.max(0) as u128;
    let mut rows = Vec::new();
    for file in files {
        let Ok(metadata) = fs::metadata(&file) else {
            continue;
        };
        if metadata_mtime_ms(&metadata) < min_ms {
            if let Ok(mut cache) = claude_cache().lock() {
                cache.remove(&file);
            }
            continue;
        }
        rows.extend(parse_claude_file(&file, &metadata));
    }

    rows
}

fn model_activity(min_ms: i64) -> Vec<Activity> {
    let mut rows = Vec::new();
    rows.extend(copilot_activity());
    rows.extend(codex_activity());
    rows.extend(claude_activity(min_ms));
    rows.sort_by(|a, b| a.ts.cmp(&b.ts));
    rows
}

fn model_key(model: &str, via_auto: bool) -> String {
    if via_auto {
        format!("{model} (via Auto)")
    } else {
        model.to_string()
    }
}

fn attribute(
    mut commands: Vec<CommandActivityRow>,
    activity: &[Activity],
) -> Vec<CommandActivityRow> {
    let tss = activity.iter().map(|a| a.ts).collect::<Vec<_>>();

    for command in &mut commands {
        let Some(ts) = command.ts else {
            command.model = "(unknown)".to_string();
            command.harness = "(unknown)".to_string();
            command.via_auto = false;
            command.gap_ms = None;
            continue;
        };

        let i = tss.partition_point(|activity_ts| *activity_ts <= ts);
        let Some(activity_row) = i.checked_sub(1).and_then(|idx| activity.get(idx)) else {
            command.model = "(unknown)".to_string();
            command.harness = "(unknown)".to_string();
            command.via_auto = false;
            command.gap_ms = None;
            continue;
        };

        let gap_ms = ts - activity_row.ts;
        if gap_ms > MAX_GAP_MS {
            command.model = "(unknown)".to_string();
            command.harness = "(unknown)".to_string();
            command.via_auto = false;
            command.gap_ms = None;
        } else {
            command.model = model_key(&activity_row.model, activity_row.via_auto);
            command.harness = activity_row.harness.clone();
            command.via_auto = activity_row.via_auto;
            command.gap_ms = Some(gap_ms);
        }
    }

    commands
}

fn command_rows(project_paths: &[String]) -> Vec<CommandActivityRow> {
    let where_clause = where_projects(project_paths);
    let sql = format!(
        "SELECT timestamp, saved_tokens, input_tokens, project_path
         FROM commands{where_clause}"
    );

    query_rtk(&sql, |row| {
        let timestamp = row.get::<_, Option<String>>(0)?.unwrap_or_default();
        Ok(CommandActivityRow {
            ts: to_ms(&timestamp),
            timestamp,
            saved: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            input: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            project_path: row.get::<_, Option<String>>(3)?,
            model: "(unknown)".to_string(),
            harness: "(unknown)".to_string(),
            via_auto: false,
            gap_ms: None,
        })
    })
}

fn min_command_ms(rows: &[CommandActivityRow]) -> i64 {
    rows.iter()
        .filter_map(|row| row.ts)
        .min()
        .unwrap_or_else(now_ms)
}

fn attributed_commands(project_paths: &[String]) -> Vec<CommandActivityRow> {
    let rows = command_rows(project_paths);
    let activity = model_activity(min_command_ms(&rows));
    attribute(rows, &activity)
}

fn by_model_from_rows(rows: &[CommandActivityRow]) -> Vec<ByModelRow> {
    let mut grouped: HashMap<String, ByModelRow> = HashMap::new();
    for row in rows {
        let name = if row.model.is_empty() {
            "(unknown)"
        } else {
            &row.model
        };
        let entry = grouped.entry(name.to_string()).or_insert(ByModelRow {
            model: name.to_string(),
            cmds: 0,
            saved: 0,
            input: 0,
            pct: 0.0,
        });
        entry.cmds += 1;
        entry.saved += row.saved;
        entry.input += row.input;
    }

    let mut out = grouped
        .into_values()
        .map(|mut row| {
            row.pct = if row.input > 0 {
                (row.saved as f64 / row.input as f64) * 100.0
            } else {
                0.0
            };
            row
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.saved.cmp(&a.saved));
    out
}

fn by_harness_from_rows(rows: &[CommandActivityRow]) -> Vec<ByHarnessRow> {
    let mut grouped: HashMap<String, ByHarnessRow> = HashMap::new();
    for row in rows {
        let name = if row.harness.is_empty() {
            "(unknown)"
        } else {
            &row.harness
        };
        let entry = grouped.entry(name.to_string()).or_insert(ByHarnessRow {
            harness: name.to_string(),
            cmds: 0,
            saved: 0,
            input: 0,
            pct: 0.0,
        });
        entry.cmds += 1;
        entry.saved += row.saved;
        entry.input += row.input;
    }

    let mut out = grouped
        .into_values()
        .map(|mut row| {
            row.pct = if row.input > 0 {
                (row.saved as f64 / row.input as f64) * 100.0
            } else {
                0.0
            };
            row
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.saved.cmp(&a.saved));
    out
}

fn local_datetime(ms: i64) -> Option<DateTime<Local>> {
    match Local.timestamp_millis_opt(ms) {
        LocalResult::Single(dt) => Some(dt),
        LocalResult::Ambiguous(dt, _) => Some(dt),
        LocalResult::None => None,
    }
}

fn sqlite_week_period(ms: i64) -> String {
    let Some(date) = local_datetime(ms) else {
        return String::new();
    };
    let yday = date.ordinal0() as i32;
    let monday_day = date.weekday().num_days_from_monday() as i32;
    let week = (yday + 7 - monday_day) / 7;
    format!("{}-W{week:02}", date.year())
}

fn period_for(bucket: &str, row: &CommandActivityRow) -> String {
    let Some(ts) = row.ts else {
        return String::new();
    };
    let Some(date) = local_datetime(ts) else {
        return String::new();
    };

    match Bucket::from_name(bucket) {
        Bucket::Monthly => format!("{}-{:02}", date.year(), date.month()),
        Bucket::Weekly => sqlite_week_period(ts),
        Bucket::Daily => format!("{}-{:02}-{:02}", date.year(), date.month(), date.day()),
    }
}

fn timeseries_by_model(
    bucket: &str,
    project_paths: &[String],
    rows: Option<&[CommandActivityRow]>,
) -> Vec<ModelSeriesRow> {
    let owned_rows;
    let rows = if let Some(rows) = rows {
        rows
    } else {
        owned_rows = attributed_commands(project_paths);
        &owned_rows
    };

    let mut grouped: HashMap<(String, String), ModelSeriesRow> = HashMap::new();
    for row in rows {
        let period = period_for(bucket, row);
        let model = if row.model.is_empty() {
            "(unknown)".to_string()
        } else {
            row.model.clone()
        };
        let entry = grouped
            .entry((period.clone(), model.clone()))
            .or_insert(ModelSeriesRow {
                period,
                model,
                saved: 0,
            });
        entry.saved += row.saved;
    }

    let mut out = grouped
        .into_values()
        .filter(|row| row.saved != 0)
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.period.cmp(&b.period).then_with(|| a.model.cmp(&b.model)));
    out
}

fn human_k(n: i64) -> String {
    fn one_decimal(value: f64, suffix: &str) -> String {
        let mut s = format!("{value:.1}");
        if s.ends_with(".0") {
            s.truncate(s.len() - 2);
        }
        format!("{s}{suffix}")
    }

    if n >= 1_000_000 {
        one_decimal(n as f64 / 1_000_000.0, "M")
    } else if n >= 1_000 {
        one_decimal(n as f64 / 1_000.0, "K")
    } else {
        n.to_string()
    }
}

fn set_savings_menu(app: &AppHandle, text: &str) {
    if let Some(item) = app.try_state::<SavingsTrayItem>() {
        let _ = item.0.set_text(text);
    }
}

pub fn update_tray(app: &AppHandle, summary: &Summary) -> Result<(), String> {
    let (title, tooltip, menu_text) = if !db_exists() {
        (
            " rtk: no data".to_string(),
            "rtk history.db not found yet".to_string(),
            "rtk: no data".to_string(),
        )
    } else {
        (
            format!(" {:.0}% · {}", summary.pct.round(), human_k(summary.saved)),
            format!(
                "{} tokens saved ({:.1}%) over {} commands",
                human_k(summary.saved),
                summary.pct,
                summary.commands
            ),
            format!("{:.0}% · {} saved", summary.pct.round(), human_k(summary.saved)),
        )
    };

    // Cross-platform readout: the disabled menu item is visible on every OS.
    set_savings_menu(app, &menu_text);

    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    // The live menu-bar text title is macOS-only in Tauri.
    #[cfg(target_os = "macos")]
    tray.set_title(Some(title.as_str()))
        .map_err(|error| format!("Failed to set tray title: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    let _ = &title;

    tray.set_tooltip(Some(tooltip.as_str()))
        .map_err(|error| format!("Failed to set tray tooltip: {error}"))?;
    Ok(())
}

fn set_tray_error(app: &AppHandle, error: &str) {
    set_savings_menu(app, "rtk: error");
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(" rtk: err"));
        let _ = tray.set_tooltip(Some(format!("Error reading rtk stats: {error}")));
    }
}

pub fn refresh_tray(app: &AppHandle) {
    let summary = summary(&[]);
    if let Err(error) = update_tray(app, &summary) {
        eprintln!("[rtk] Failed to update tray: {error}");
        set_tray_error(app, &error);
    }
}

pub fn get_all(project_paths: Vec<String>) -> Value {
    let attributed = attributed_commands(&project_paths);
    let summary = summary(&project_paths);
    let series_daily = timeseries("daily", &project_paths);
    let series_weekly = timeseries("weekly", &project_paths);
    let series_monthly = timeseries("monthly", &project_paths);
    let stacked_daily = timeseries_by_project("daily", &project_paths);
    let stacked_weekly = timeseries_by_project("weekly", &project_paths);
    let stacked_monthly = timeseries_by_project("monthly", &project_paths);
    let stacked_by_model_daily = timeseries_by_model("daily", &project_paths, Some(&attributed));
    let stacked_by_model_weekly = timeseries_by_model("weekly", &project_paths, Some(&attributed));
    let stacked_by_model_monthly =
        timeseries_by_model("monthly", &project_paths, Some(&attributed));
    let by_command = by_command(&project_paths, 15);
    let recent = recent(&project_paths, 50);

    json!({
        "available": db_exists(),
        "projectPaths": project_paths,
        "projects": get_projects(),
        "summary": summary,
        "series": {
            "daily": series_daily,
            "weekly": series_weekly,
            "monthly": series_monthly,
        },
        "stacked": {
            "daily": stacked_daily,
            "weekly": stacked_weekly,
            "monthly": stacked_monthly,
        },
        "byModel": by_model_from_rows(&attributed),
        "byHarness": by_harness_from_rows(&attributed),
        "stackedByModel": {
            "daily": stacked_by_model_daily,
            "weekly": stacked_by_model_weekly,
            "monthly": stacked_by_model_monthly,
        },
        "harnessesAvailable": {
            "copilot": copilot_db_path().exists(),
            "claude": claude_dir().exists(),
            "codex": codex_db_path().exists(),
        },
        "byCommand": by_command,
        "recent": recent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close_enough(left: i64, right: i64) -> bool {
        (left - right).abs() <= 1
    }

    #[test]
    fn rust_selfcheck() {
        let empty_projects: Vec<String> = Vec::new();
        let all = get_all(Vec::new());
        let s = summary(&empty_projects);

        println!(
            "db: {} exists: {}",
            rtk_db_path().display(),
            all.get("available")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        );
        println!("since: {:?} commands: {}", s.since, s.commands);
        println!("saved: {} tokens  savings: {:.1}%", s.saved, s.pct);

        if !db_exists() {
            return;
        }

        assert!(s.saved >= 0 && s.commands >= 0, "non-negative totals");

        let command_total = by_command(&empty_projects, 15)
            .iter()
            .map(|row| row.saved)
            .sum::<i64>();
        assert!(
            command_total <= s.saved + 1,
            "by-command saved <= total saved"
        );

        let stack_total = timeseries_by_project("daily", &empty_projects)
            .iter()
            .map(|row| row.saved)
            .sum::<i64>();
        let daily_total = timeseries("daily", &empty_projects)
            .iter()
            .map(|row| row.saved)
            .sum::<i64>();
        assert!(
            close_enough(stack_total, daily_total),
            "stacked daily saved == series daily saved"
        );

        let attributed = attributed_commands(&empty_projects);
        let by_model = by_model_from_rows(&attributed);
        let by_harness = by_harness_from_rows(&attributed);
        let by_model_total = by_model.iter().map(|row| row.saved).sum::<i64>();
        let by_harness_total = by_harness.iter().map(|row| row.saved).sum::<i64>();
        let model_daily_total = timeseries_by_model("daily", &empty_projects, Some(&attributed))
            .iter()
            .map(|row| row.saved)
            .sum::<i64>();

        assert!(
            close_enough(by_model_total, s.saved),
            "by-model saved == total saved"
        );
        assert!(
            close_enough(by_harness_total, s.saved),
            "by-harness saved == total saved"
        );
        assert!(
            close_enough(model_daily_total, daily_total),
            "stacked model daily saved == series daily saved"
        );

        let activity = model_activity(0);
        assert!(
            activity.windows(2).all(|pair| pair[0].ts <= pair[1].ts),
            "activity sorted ascending"
        );

        let rows = command_rows(&empty_projects);
        let min_ms = min_command_ms(&rows);
        let reattributed = attribute(rows, &model_activity(min_ms));
        assert!(
            reattributed
                .iter()
                .all(|row| row.gap_ms.map(|gap| gap <= MAX_GAP_MS).unwrap_or(true)),
            "attributed commands stay within max gap"
        );

        println!(
            "by-model: {}",
            by_model
                .iter()
                .take(5)
                .map(|row| format!("{}:{}", row.model, row.saved))
                .collect::<Vec<_>>()
                .join(", ")
        );
        println!(
            "by-harness: {}",
            by_harness
                .iter()
                .map(|row| format!("{}:{}", row.harness, row.saved))
                .collect::<Vec<_>>()
                .join(", ")
        );

        let projects = get_projects();
        if let Some(first) = projects.first() {
            let one_project = vec![first.clone()];
            let one_summary = summary(&one_project);
            assert!(
                one_summary.saved <= s.saved + 1,
                "single project saved <= global saved"
            );

            if let Some(second) = projects.get(1) {
                let two_projects = vec![first.clone(), second.clone()];
                let two_summary = summary(&two_projects);
                assert!(
                    two_summary.saved >= one_summary.saved && two_summary.saved <= s.saved + 1,
                    "two projects saved between one and global"
                );
            }
        }
    }
}
