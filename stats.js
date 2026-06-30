"use strict";
// Reads rtk's SQLite history and the local AI-harness session logs, then attributes
// each rtk command to the model / harness / workspace that was active when it ran.
//
// Harness capture rules are ported from the ai-engineering-coach parsers
// (src/core/parser-*.ts): GitHub Copilot CLI vs App via session.start, Codex via
// rollout JSONL, Claude via projects JSONL, OpenCode via local storage.
// ponytail: sqlite via the stock CLI (-json) — zero native deps, no electron-rebuild.
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Paths (per-OS, env-overridable)
// ---------------------------------------------------------------------------
function rtkDbPath() {
  if (process.env.RTK_DB) return process.env.RTK_DB;
  const home = os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library/Application Support/rtk/history.db");
  if (process.platform === "win32")
    return path.join(
      process.env.APPDATA || path.join(home, "AppData/Roaming"),
      "rtk/history.db"
    );
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
    "rtk/history.db"
  );
}

const DB = rtkDbPath();
// macOS: absolute path (Finder-launched apps get a minimal PATH); else rely on PATH.
const SQLITE = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
const MAX_GAP_MS = 4 * 3600 * 1000;
// ponytail: a single command saving more than this is treated as an outlier — e.g. a
// recursive `grep -rn` that walked node_modules and "saved" 11M tokens of output.
// One tunable knob; raise it if a real workload legitimately saves >1M per command.
const OUTLIER_SAVED = 1000000;

function dbExists() {
  return fs.existsSync(DB);
}

function copilotStateDir() {
  return process.env.COPILOT_STATE_DIR || path.join(os.homedir(), ".copilot", "session-state");
}
function claudeDir() {
  return process.env.CLAUDE_DIR || path.join(os.homedir(), ".claude", "projects");
}
function codexSessionsDirs() {
  const home = os.homedir();
  const dirs = [];
  for (const name of ["sessions", "archived_sessions", "archived-sessions"]) {
    const d = path.join(home, ".codex", name);
    if (fs.existsSync(d)) dirs.push(d);
  }
  return dirs;
}
function codexDbPath() {
  return process.env.CODEX_DB || path.join(os.homedir(), ".codex", "state_5.sqlite");
}
function opencodeStorageDir() {
  return process.env.OPENCODE_DIR || path.join(os.homedir(), ".local", "share", "opencode", "storage");
}

// ---------------------------------------------------------------------------
// sqlite + small IO/time helpers
// ---------------------------------------------------------------------------
function qDb(dbPath, sql) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  // ponytail: normal open (SELECT-only) — WAL mode rejects a read-only open when
  // the -shm sidecar is absent; concurrent SELECTs are safe and never mutate data.
  const out = execFileSync(SQLITE, ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function q(sql) {
  return qDb(DB, sql);
}

function toMs(t) {
  if (t == null) return NaN;
  if (typeof t === "number") return t;
  let s = String(t).trim().replace(" ", "T");
  if (!/[Z+]/.test(s.slice(10))) s += "Z";
  return Date.parse(s);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ponytail: read only the first chunk — session_meta is line 1 and the first
// turn_context is early, so we never need the whole (possibly huge) rollout file.
function readHead(file, maxBytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function jsonlFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) jsonlFiles(p, out);
    else if (ent.isFile() && p.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model name normalization (ported from ai-engineering-coach helpers.normalizeModel).
// Clean display labels: strip vendor prefixes, claude hyphen->dot versions, and a
// known set of reasoning-effort suffixes.
// ponytail: effort-suffix stripping is limited to explicit effort words so it never
// eats -mini/-flash/-nano; widen the suffix list if a new reasoning tier appears.
// ---------------------------------------------------------------------------
function normalizeModel(modelId) {
  let m = String(modelId == null ? "" : modelId).trim();
  if (!m) return m;
  for (const prefix of ["copilot/", "github.copilot-chat/", "github/"]) {
    if (m.startsWith(prefix)) {
      m = m.slice(prefix.length);
      break;
    }
  }
  m = m.replace(/-thought$/, "").replace(/-preview$/, "").replace(/-latest$/, "");
  if (m.startsWith("claude-")) {
    m = m.replace(/-\d{8}$/, "");
    m = m.replace(/(\d)-(\d)/, "$1.$2");
  }
  m = m.replace(/-(?:xhigh|high|medium|low|minimal)$/i, "");
  return m.trim() || "(unknown)";
}

// ---------------------------------------------------------------------------
// Harness activity collectors — each yields rows of:
//   { ts, model, cwd, harness, viaAuto }
// best-effort: a missing source returns []. mtime caches keep repeated refreshes
// cheap. `minMs` skips sessions whose file mtime predates the earliest rtk command
// by more than one attribution gap (they can never be the nearest activity).
// ---------------------------------------------------------------------------
function staleCutoff(minMs) {
  return minMs ? minMs - MAX_GAP_MS : 0;
}

// --- GitHub Copilot CLI / App: ~/.copilot/session-state/<id>/events.jsonl ---
const copilotCache = new Map();

function parseCopilotSession(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let isApp = false;
  let cwd = "";
  let selectedModel = "";
  let startTime = null;
  let lastChange = "";
  let firstAssistant = "";
  let firstMetric = "";
  let firstTs = null;
  for (const l of text.split("\n")) {
    if (!l || !l.includes('"type"')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // tolerate a truncated final JSONL line
    }
    const d = o.data || {};
    if (firstTs == null && o.timestamp) {
      const t = toMs(o.timestamp);
      if (Number.isFinite(t)) firstTs = t;
    }
    switch (o.type) {
      case "session.start":
        // ponytail: CLI emits remoteSteerable:false, so check the value, not mere
        // presence (a presence check misclassifies the CLI as the App).
        isApp = d.remoteSteerable === true;
        if (d.context && typeof d.context.cwd === "string") cwd = d.context.cwd;
        if (typeof d.selectedModel === "string") selectedModel = d.selectedModel;
        if (typeof d.startTime === "string") startTime = d.startTime;
        break;
      case "session.model_change":
        if (typeof d.newModel === "string" && d.newModel) lastChange = d.newModel;
        break;
      case "assistant.message":
        if (!firstAssistant && typeof d.model === "string" && d.model) firstAssistant = d.model;
        break;
      case "session.shutdown":
        if (!firstMetric && d.modelMetrics && typeof d.modelMetrics === "object") {
          const keys = Object.keys(d.modelMetrics);
          if (keys.length) firstMetric = keys[0];
        }
        break;
    }
  }
  // A literal "auto" routing token resolves to the model that actually ran (from
  // assistant.message / modelMetrics) and is flagged viaAuto; a concrete pin is used
  // as-is. An empty token also resolves from events but is NOT "via Auto".
  const raw = lastChange || selectedModel || "";
  let model;
  let viaAuto;
  if (raw && raw !== "auto") {
    model = raw;
    viaAuto = false;
  } else {
    model = firstAssistant || firstMetric || "(unknown)";
    viaAuto = raw === "auto";
  }
  const startMs = startTime ? toMs(startTime) : NaN;
  const ts = Number.isFinite(startMs) ? startMs : firstTs;
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    model: normalizeModel(model),
    cwd,
    harness: isApp ? "copilot-app" : "copilot-cli",
    viaAuto,
  };
}

function copilotActivity(minMs) {
  let entries;
  try {
    entries = fs.readdirSync(copilotStateDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = staleCutoff(minMs);
  const rows = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(copilotStateDir(), ent.name, "events.jsonl");
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) {
      copilotCache.delete(ent.name);
      continue;
    }
    const cached = copilotCache.get(ent.name);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      if (cached.row) rows.push(cached.row);
      continue;
    }
    const row = parseCopilotSession(file);
    copilotCache.set(ent.name, { mtimeMs: st.mtimeMs, row });
    if (row) rows.push(row);
  }
  return rows;
}

// --- Codex CLI: ~/.codex/sessions/**/rollout-*.jsonl (state_5.sqlite fallback) ---
const codexCache = new Map();

function parseCodexRollout(file) {
  let text;
  try {
    text = readHead(file);
  } catch {
    return null;
  }
  let cwd = "";
  let model = "";
  let ts = null;
  for (const l of text.split("\n")) {
    if (!l || !l.includes('"type"')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // last line in a head read is often truncated
    }
    const p = o.payload || {};
    if (ts == null && o.timestamp) {
      const t = toMs(o.timestamp);
      if (Number.isFinite(t)) ts = t;
    }
    if (o.type === "session_meta" && typeof p.cwd === "string") cwd = p.cwd;
    else if (o.type === "turn_context" && !model && typeof p.model === "string") model = p.model;
    if (cwd && model) break;
  }
  if (!Number.isFinite(ts)) return null;
  return { ts, model: normalizeModel(model), cwd, harness: "codex", viaAuto: false };
}

function codexActivityFromDb() {
  try {
    return qDb(
      codexDbPath(),
      `SELECT strftime('%Y-%m-%dT%H:%M:%S', created_at, 'unixepoch') ts,
              COALESCE(NULLIF(model,''),'(unknown)') model, cwd
       FROM threads WHERE model IS NOT NULL`
    )
      .map((r) => ({
        ts: toMs(r.ts),
        model: normalizeModel(r.model),
        cwd: r.cwd || "",
        harness: "codex",
        viaAuto: false,
      }))
      .filter((r) => Number.isFinite(r.ts));
  } catch {
    return [];
  }
}

function codexActivity(minMs) {
  const dirs = codexSessionsDirs();
  if (!dirs.length) return codexActivityFromDb();
  const cutoff = staleCutoff(minMs);
  const rows = [];
  for (const dir of dirs) {
    let files;
    try {
      files = jsonlFiles(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) {
        codexCache.delete(file);
        continue;
      }
      const cached = codexCache.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        if (cached.row) rows.push(cached.row);
        continue;
      }
      const row = parseCodexRollout(file);
      codexCache.set(file, { mtimeMs: st.mtimeMs, row });
      if (row) rows.push(row);
    }
  }
  return rows;
}

// --- Claude Code: ~/.claude/projects/**/*.jsonl ---
const claudeCache = new Map();

function parseClaudeFile(file, st) {
  const cached = claudeCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.records;
  }
  const records = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.includes('"assistant"') || !l.includes('"model"')) continue;
    try {
      const o = JSON.parse(l);
      if (o.type === "assistant" && o.message && o.message.model) {
        records.push({
          ts: toMs(o.timestamp),
          model: normalizeModel(o.message.model),
          cwd: o.cwd || "",
          harness: "claude",
          viaAuto: false,
        });
      }
    } catch {
      // tolerate a truncated final JSONL line
    }
  }
  const filtered = records.filter((r) => Number.isFinite(r.ts));
  claudeCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, records: filtered });
  return filtered;
}

function claudeActivity(minMs) {
  try {
    const dir = claudeDir();
    if (!fs.existsSync(dir)) return [];
    const cutoff = staleCutoff(minMs);
    const rows = [];
    for (const file of jsonlFiles(dir)) {
      const st = fs.statSync(file);
      if (st.mtimeMs < cutoff) {
        claudeCache.delete(file);
        continue;
      }
      rows.push(...parseClaudeFile(file, st));
    }
    return rows;
  } catch {
    return [];
  }
}

// --- OpenCode: ~/.local/share/opencode/storage ---
const opencodeCache = new Map();

function parseOpencodeSession(storage, sessionFile) {
  const s = readJsonSafe(sessionFile);
  if (!s || !s.id) return null;
  const cwd = typeof s.directory === "string" ? s.directory : "";
  let ts = s.time && Number.isFinite(s.time.created) ? s.time.created : null;
  let model = "";
  let firstMsgTs = Infinity;
  let msgs;
  try {
    msgs = fs.readdirSync(path.join(storage, "message", s.id)).filter((f) => f.endsWith(".json"));
  } catch {
    msgs = [];
  }
  for (const mf of msgs) {
    const m = readJsonSafe(path.join(storage, "message", s.id, mf));
    if (!m || m.role !== "assistant") continue;
    const created = m.time && Number.isFinite(m.time.created) ? m.time.created : Infinity;
    const mid = m.modelID || (m.model && m.model.modelID) || "";
    if (mid && created < firstMsgTs) {
      firstMsgTs = created;
      model = mid;
    }
  }
  if (ts == null && Number.isFinite(firstMsgTs)) ts = firstMsgTs;
  if (!Number.isFinite(ts)) return null;
  return { ts, model: normalizeModel(model), cwd, harness: "opencode", viaAuto: false };
}

function opencodeActivity(minMs) {
  const storage = opencodeStorageDir();
  const sessDir = path.join(storage, "session", "global");
  let files;
  try {
    files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const cutoff = staleCutoff(minMs);
  const rows = [];
  for (const f of files) {
    const sf = path.join(sessDir, f);
    let st;
    try {
      st = fs.statSync(sf);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) {
      opencodeCache.delete(sf);
      continue;
    }
    const cached = opencodeCache.get(sf);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      if (cached.row) rows.push(cached.row);
      continue;
    }
    const row = parseOpencodeSession(storage, sf);
    opencodeCache.set(sf, { mtimeMs: st.mtimeMs, row });
    if (row) rows.push(row);
  }
  return rows;
}

function modelActivity(minMs = 0) {
  return [
    ...copilotActivity(minMs),
    ...codexActivity(minMs),
    ...claudeActivity(minMs),
    ...opencodeActivity(minMs),
  ]
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------------------
// Attribution: match each rtk command to the active harness session.
// ---------------------------------------------------------------------------
// Display/aggregation key: Auto-routed models stay distinct from pinned ones, so
// "claude-sonnet-4.6 (via Auto)" never merges with a directly-chosen one.
function modelKey(model, viaAuto) {
  return viaAuto ? `${model} (via Auto)` : model;
}

// True when two filesystem paths refer to the same workspace (equal, or one nested
// in the other). ponytail: prefix match, not git-root aware — fine for attribution.
function cwdMatch(cwd, projectPath) {
  if (!cwd || !projectPath) return false;
  const a = cwd.replace(/\/+$/, "");
  const b = projectPath.replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

// For each command, among the activity events within MAX_GAP_MS *before* it, prefer
// the one whose cwd matches the command's project_path; otherwise the nearest in
// time. The command's workspace becomes the matched session's real cwd (cleaner than
// rtk's own project_path), falling back to project_path, then "(unknown)".
function attribute(commands, activity) {
  const tss = activity.map((a) => a.ts);
  for (const cmd of commands) {
    let lo = 0;
    let hi = tss.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tss[mid] <= cmd.ts) {
        i = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let best = null;
    let bestGap = Infinity;
    for (let j = i; j >= 0; j--) {
      const gap = cmd.ts - activity[j].ts;
      if (gap > MAX_GAP_MS) break; // activity is sorted asc → older only widens the gap
      if (!best) {
        best = activity[j];
        bestGap = gap;
      }
      if (cwdMatch(activity[j].cwd, cmd.project_path)) {
        best = activity[j];
        bestGap = gap;
        break; // nearest cwd match wins
      }
    }
    if (!best) {
      cmd.model = "(unknown)";
      cmd.harness = "(unknown)";
      cmd.viaAuto = false;
      cmd.gapMs = null;
      cmd.workspace = cmd.project_path || "(unknown)";
    } else {
      cmd.model = modelKey(best.model, best.viaAuto);
      cmd.harness = best.harness;
      cmd.viaAuto = !!best.viaAuto;
      cmd.gapMs = bestGap;
      cmd.workspace = best.cwd && best.cwd.trim() ? best.cwd : cmd.project_path || "(unknown)";
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Single source of truth: every rtk command, attributed. All dashboard
// aggregations are derived from this array (workspace is the project axis).
// ---------------------------------------------------------------------------
function commandRows() {
  return q(
    `SELECT id, timestamp, saved_tokens, input_tokens, output_tokens,
            savings_pct, exec_time_ms, rtk_cmd, project_path
     FROM commands`
  ).map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    ts: toMs(r.timestamp),
    saved: r.saved_tokens || 0,
    input: r.input_tokens || 0,
    output: r.output_tokens || 0,
    time_ms: r.exec_time_ms || 0,
    savings_pct: r.savings_pct || 0,
    rtk_cmd: r.rtk_cmd || "",
    project_path: r.project_path || "",
  }));
}

function minCommandMs(rows) {
  let minMs = Infinity;
  for (const r of rows) {
    if (Number.isFinite(r.ts) && r.ts < minMs) minMs = r.ts;
  }
  return minMs === Infinity ? Date.now() : minMs;
}

function attributedAll() {
  const rows = commandRows();
  return attribute(rows, modelActivity(minCommandMs(rows)));
}

function filterByWorkspace(rows, projects) {
  if (!Array.isArray(projects) || !projects.length) return rows;
  const set = new Set(projects);
  return rows.filter((r) => set.has(r.workspace));
}

function getProjects(rows) {
  const r = rows || attributedAll();
  return [...new Set(r.map((x) => x.workspace).filter((w) => w && w !== "(unknown)"))].sort();
}

// ---------------------------------------------------------------------------
// Aggregations (all operate on an attributed, workspace-filtered command array)
// ---------------------------------------------------------------------------
function summarize(rows) {
  let input = 0;
  let output = 0;
  let saved = 0;
  let time_ms = 0;
  let since = null;
  let sinceMs = Infinity;
  for (const r of rows) {
    input += r.input;
    output += r.output;
    saved += r.saved;
    time_ms += r.time_ms;
    if (Number.isFinite(r.ts) && r.ts < sinceMs) {
      sinceMs = r.ts;
      since = r.timestamp;
    }
  }
  return {
    commands: rows.length,
    input,
    output,
    saved,
    // ponytail: overall ratio (matches `rtk gain`), not the mean of per-row pct.
    pct: input > 0 ? (saved / input) * 100 : 0,
    time_ms,
    since,
  };
}

// caveman output savings have no workspace axis, so they're always the global
// total regardless of the project filter.
function withCaveman(base, cav) {
  base.outputSaved = cav.outputSaved;
  base.totalSaved = base.saved + cav.outputSaved;
  return base;
}

function summary(projects) {
  const list = Array.isArray(projects) ? projects : [];
  // Empty filter → pure command totals (no harness file reads): keeps the tray cheap.
  const base = !list.length
    ? summarize(commandRows())
    : summarize(filterByWorkspace(attributedAll(), list));
  return withCaveman(base, cavemanActivity());
}

function sqliteWeekPeriod(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const year = d.getFullYear();
  const yday = Math.floor(
    (new Date(year, d.getMonth(), d.getDate()) - new Date(year, 0, 1)) / 86400000
  );
  const mondayDay = (d.getDay() + 6) % 7;
  const week = Math.floor((yday + 7 - mondayDay) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function periodFor(bucket, r) {
  const d = new Date(r.ts);
  if (bucket === "monthly")
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  if (bucket === "weekly") return sqliteWeekPeriod(r.ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeseries(bucket, rows) {
  const g = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.ts)) continue;
    const period = periodFor(bucket, r);
    const m = g.get(period) || { period, saved: 0, input: 0, commands: 0 };
    m.saved += r.saved;
    m.input += r.input;
    m.commands += 1;
    g.set(period, m);
  }
  return [...g.values()].sort((a, b) => a.period.localeCompare(b.period));
}

// per-workspace breakdown per bucket, for stacked bars. `project` carries the full
// cwd path; the renderer displays its basename.
function timeseriesByProject(bucket, rows) {
  const g = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.ts)) continue;
    const period = periodFor(bucket, r);
    const ws = r.workspace || "";
    const key = `${period}\n${ws}`;
    const m = g.get(key) || { period, project: ws, saved: 0 };
    m.saved += r.saved;
    g.set(key, m);
  }
  return [...g.values()]
    .filter((r) => r.saved !== 0)
    .sort((a, b) => a.period.localeCompare(b.period));
}

function timeseriesByModel(bucket, rows) {
  const g = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.ts)) continue;
    const period = periodFor(bucket, r);
    const model = r.model || "(unknown)";
    const key = `${period}\n${model}`;
    const m = g.get(key) || { period, model, saved: 0 };
    m.saved += r.saved;
    g.set(key, m);
  }
  return [...g.values()]
    .filter((r) => r.saved !== 0)
    .sort((a, b) => a.period.localeCompare(b.period) || a.model.localeCompare(b.model));
}

// Normalize "rtk read /some/file" -> "rtk read". ponytail: naive first-two-token
// grouping; widen if commands need finer buckets.
function normalizeCmd(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return parts.slice(0, 2).join(" ") || cmd;
}

function byCommand(rows, limit = 15) {
  const merged = new Map();
  for (const r of rows) {
    const key = normalizeCmd(r.rtk_cmd || "");
    const m = merged.get(key) || { command: key, n: 0, saved: 0, input: 0 };
    m.n += 1;
    m.saved += r.saved;
    m.input += r.input;
    merged.set(key, m);
  }
  return [...merged.values()].sort((a, b) => b.saved - a.saved).slice(0, limit);
}

function recent(rows, limit = 50) {
  return [...rows]
    .sort((a, b) => (b.id || 0) - (a.id || 0))
    .slice(0, Number(limit) || 50)
    .map((r) => ({
      timestamp: r.timestamp,
      rtk_cmd: r.rtk_cmd,
      saved_tokens: r.saved,
      savings_pct: r.savings_pct,
    }));
}

function groupedAttributed(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const name = r[key] || "(unknown)";
    const m = out.get(name) || { [key]: name, cmds: 0, saved: 0, input: 0 };
    m.cmds += 1;
    m.saved += r.saved || 0;
    m.input += r.input || 0;
    out.set(name, m);
  }
  return [...out.values()]
    .map((r) => ({ ...r, pct: r.input > 0 ? (r.saved / r.input) * 100 : 0 }))
    .sort((a, b) => b.saved - a.saved);
}

function byModel(rows) {
  return groupedAttributed(rows || attributedAll(), "model");
}

function byHarness(rows) {
  return groupedAttributed(rows || attributedAll(), "harness");
}

// ---------------------------------------------------------------------------
// caveman: output-token savings (separate dataset from rtk's per-command input
// savings). caveman maintains its own lifetime log; we only read + roll it up.
// ---------------------------------------------------------------------------
function cavemanHistoryPath() {
  if (process.env.CAVEMAN_HISTORY) return process.env.CAVEMAN_HISTORY;
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, ".caveman-history.jsonl");
}

// Read caveman's lifetime savings log. Each line is one /caveman-stats snapshot:
// {ts, session_id, mode, model, output_tokens, est_saved_tokens, est_saved_usd}.
// Dedup to the latest snapshot per session_id (matches caveman's own aggregation),
// then roll up output-token savings by period and model. Missing file -> zeros.
// ponytail: plain read + JSON.parse per line, no deps; tolerant of partial lines.
function cavemanActivity() {
  const empty = {
    sessions: 0,
    outputTokens: 0,
    outputSaved: 0,
    byPeriod: { daily: [], weekly: [], monthly: [] },
    byModel: [],
  };
  let raw;
  try {
    raw = fs.readFileSync(cavemanHistoryPath(), "utf8");
  } catch {
    return empty;
  }

  const latest = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const id = e.session_id || "_";
    const prev = latest.get(id);
    if (!prev || (e.ts || 0) >= (prev.ts || 0)) latest.set(id, e);
  }

  const entries = [...latest.values()];
  let outputTokens = 0;
  let outputSaved = 0;
  const periodMaps = { daily: new Map(), weekly: new Map(), monthly: new Map() };
  const modelMap = new Map();
  for (const e of entries) {
    const saved = e.est_saved_tokens || 0;
    outputTokens += e.output_tokens || 0;
    outputSaved += saved;
    const ts = e.ts || 0;
    if (Number.isFinite(ts) && ts > 0 && saved) {
      for (const bucket of ["daily", "weekly", "monthly"]) {
        const period = periodFor(bucket, { ts });
        const m = periodMaps[bucket];
        m.set(period, (m.get(period) || 0) + saved);
      }
    }
    if (saved) {
      const model = normalizeModel(e.model) || "(unknown)";
      modelMap.set(model, (modelMap.get(model) || 0) + saved);
    }
  }

  const toSeries = (m) =>
    [...m.entries()]
      .map(([period, saved]) => ({ period, saved }))
      .sort((a, b) => a.period.localeCompare(b.period));

  return {
    sessions: entries.length,
    outputTokens,
    outputSaved,
    byPeriod: {
      daily: toSeries(periodMaps.daily),
      weekly: toSeries(periodMaps.weekly),
      monthly: toSeries(periodMaps.monthly),
    },
    byModel: [...modelMap.entries()]
      .map(([model, saved]) => ({ model, saved }))
      .sort((a, b) => b.saved - a.saved),
  };
}

function getAll(opts = {}) {
  const projects = Array.isArray(opts.projectPaths) ? opts.projectPaths : [];
  const hideOutliers = !!opts.hideOutliers;
  const all = attributedAll();
  // An outlier is a single command whose saved tokens dwarf normal usage (a recursive
  // grep over node_modules, a huge `ps`/log dump). Surfaced always so the dashboard can
  // hint at it; excluded from every aggregation when the user opts to hide them.
  const outlierRows = all.filter((r) => r.saved > OUTLIER_SAVED);
  const kept = hideOutliers ? all.filter((r) => r.saved <= OUTLIER_SAVED) : all;
  const rows = filterByWorkspace(kept, projects);
  const cav = cavemanActivity();
  return {
    available: dbExists(),
    projectPaths: projects,
    projects: getProjects(kept),
    outliers: {
      threshold: OUTLIER_SAVED,
      count: outlierRows.length,
      saved: outlierRows.reduce((a, r) => a + r.saved, 0),
      hidden: hideOutliers,
    },
    summary: withCaveman(summarize(rows), cav),
    caveman: cav,
    series: {
      daily: timeseries("daily", rows),
      weekly: timeseries("weekly", rows),
      monthly: timeseries("monthly", rows),
    },
    stacked: {
      daily: timeseriesByProject("daily", rows),
      weekly: timeseriesByProject("weekly", rows),
      monthly: timeseriesByProject("monthly", rows),
    },
    byModel: byModel(rows),
    byHarness: byHarness(rows),
    stackedByModel: {
      daily: timeseriesByModel("daily", rows),
      weekly: timeseriesByModel("weekly", rows),
      monthly: timeseriesByModel("monthly", rows),
    },
    harnessesAvailable: {
      copilot: fs.existsSync(copilotStateDir()),
      claude: fs.existsSync(claudeDir()),
      codex: codexSessionsDirs().length > 0 || fs.existsSync(codexDbPath()),
      opencode: fs.existsSync(opencodeStorageDir()),
    },
    byCommand: byCommand(rows),
    recent: recent(rows),
  };
}

module.exports = {
  getAll,
  summary,
  getProjects,
  byModel,
  byHarness,
  cavemanActivity,
  modelActivity,
  normalizeModel,
  DB,
  dbExists,
};

if (require.main === module) {
  // self-check: the non-trivial logic is the activity extraction + attribution +
  // aggregation. Asserts fail loudly if any invariant breaks.
  const all = getAll();
  const s = all.summary;
  console.log("db:", DB, "exists:", all.available);
  console.log(
    "since:", s.since, "commands:", s.commands,
    "saved:", s.saved, "savings:", s.pct.toFixed(1) + "%"
  );
  console.log("workspaces:", all.projects.length);
  console.log("by-harness:", all.byHarness.map((r) => `${r.harness}:${r.saved}`).join(", "));
  console.log("by-model:", all.byModel.slice(0, 6).map((r) => `${r.model}:${r.saved}`).join(", "));

  console.assert(s.saved >= 0 && s.commands >= 0, "non-negative totals");

  const wsDaily = all.stacked.daily.reduce((a, r) => a + r.saved, 0);
  const seriesDaily = all.series.daily.reduce((a, r) => a + r.saved, 0);
  console.assert(Math.abs(wsDaily - seriesDaily) <= 1, "stacked-by-workspace daily == series daily");

  const modelDaily = all.stackedByModel.daily.reduce((a, r) => a + r.saved, 0);
  console.assert(Math.abs(modelDaily - seriesDaily) <= 1, "stacked-by-model daily == series daily");

  const byHarnessTotal = all.byHarness.reduce((a, r) => a + r.saved, 0);
  const byModelTotal = all.byModel.reduce((a, r) => a + r.saved, 0);
  console.assert(Math.abs(byHarnessTotal - s.saved) <= 1, "by-harness saved == total saved");
  console.assert(Math.abs(byModelTotal - s.saved) <= 1, "by-model saved == total saved");

  const knownHarness = new Set(["copilot-cli", "copilot-app", "claude", "codex", "opencode", "(unknown)"]);
  console.assert(all.byHarness.every((r) => knownHarness.has(r.harness)), "harness values are known");
  console.assert(all.byHarness.every((r) => r.harness !== "copilot"), "Copilot is split into CLI/App, not merged");

  const act = modelActivity(0);
  console.assert(act.every((a) => Number.isFinite(a.ts)), "activity timestamps are finite");
  console.assert(act.every((a, i) => i === 0 || act[i - 1].ts <= a.ts), "activity sorted ascending");
  console.assert(
    act.every((a) => a.model === a.model.trim() && !a.model.startsWith("copilot/")),
    "models are normalized"
  );
  console.assert(
    act.every((a) => ["copilot-cli", "copilot-app", "claude", "codex", "opencode"].includes(a.harness)),
    "activity harness values are known"
  );

  const attributed = attributedAll();
  console.assert(
    attributed.every((r) => typeof r.workspace === "string" && r.workspace.length > 0),
    "every command has a workspace"
  );
  console.assert(
    attributed.every((r) => r.gapMs == null || r.gapMs <= MAX_GAP_MS),
    "attributed commands stay within max gap"
  );

  console.assert(
    Array.isArray(copilotActivity(0)) &&
      Array.isArray(codexActivity(0)) &&
      Array.isArray(claudeActivity(0)) &&
      Array.isArray(opencodeActivity(0)),
    "collectors return arrays even when a source is absent"
  );

  if (all.projects[0]) {
    const one = summary([all.projects[0]]);
    console.assert(one.saved <= s.saved + 1, "single workspace saved <= global saved");
  }

  const hidden = getAll({ hideOutliers: true });
  console.assert(hidden.summary.saved <= s.saved, "hiding outliers never increases saved");
  console.assert(hidden.outliers.hidden === true, "outliers flagged as hidden");
  const outlierSaved = attributed.filter((r) => r.saved > OUTLIER_SAVED).reduce((a, r) => a + r.saved, 0);
  console.assert(
    Math.abs(s.saved - hidden.summary.saved - outlierSaved) <= 1,
    "hidden total == full total minus outlier saved"
  );
  console.log("outliers:", all.outliers.count, "accounting for", all.outliers.saved, "saved");

  // caveman output-savings: synthetic log → assert dedup + rollup invariants.
  {
    const tmp = path.join(os.tmpdir(), `caveman-selfcheck-${process.pid}.jsonl`);
    const synthetic = [
      { ts: Date.parse("2025-01-01T10:00:00Z"), session_id: "a", model: "claude-sonnet-4-20250514", output_tokens: 100, est_saved_tokens: 50 },
      { ts: Date.parse("2025-01-01T11:00:00Z"), session_id: "a", model: "claude-sonnet-4-20250514", output_tokens: 200, est_saved_tokens: 120 },
      { ts: Date.parse("2025-01-02T09:00:00Z"), session_id: "b", model: "claude-opus-4-1", output_tokens: 80, est_saved_tokens: 40 },
    ].map((o) => JSON.stringify(o)).join("\n");
    fs.writeFileSync(tmp, synthetic);
    const prevEnv = process.env.CAVEMAN_HISTORY;
    process.env.CAVEMAN_HISTORY = tmp;
    const cav = cavemanActivity();
    if (prevEnv === undefined) delete process.env.CAVEMAN_HISTORY;
    else process.env.CAVEMAN_HISTORY = prevEnv;
    fs.unlinkSync(tmp);

    console.assert(cav.sessions === 2, "caveman dedup → latest snapshot per session_id");
    console.assert(cav.outputSaved === 160, "caveman outputSaved == 120 + 40");
    const cavDaily = cav.byPeriod.daily.reduce((a, r) => a + r.saved, 0);
    console.assert(cavDaily === cav.outputSaved, "caveman byPeriod daily == outputSaved");
    const cavModel = cav.byModel.reduce((a, r) => a + r.saved, 0);
    console.assert(cavModel === cav.outputSaved, "caveman byModel == outputSaved");
    console.assert(cav.byModel.some((r) => r.model === "claude-sonnet-4"), "caveman model ids normalized");
  }

  const totalSafe = summary([]);
  console.assert(
    totalSafe.totalSaved >= totalSafe.saved && totalSafe.outputSaved >= 0,
    "totalSaved == rtk input saved + caveman output saved"
  );
  console.log("self-check ok");
}
