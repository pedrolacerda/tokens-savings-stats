"use strict";
// Reads rtk's own SQLite history via the stock sqlite3 CLI (-json).
// ponytail: CLI over a native sqlite module — zero deps, no electron-rebuild.
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

// rtk stores history under the OS config dir (same convention as the `directories`
// crate). ponytail: best-effort per-OS paths; override with RTK_DB if rtk differs.
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
const claudeCache = new Map();

function dbExists() {
  return fs.existsSync(DB);
}

function copilotDbPath() {
  if (process.env.COPILOT_DB) return process.env.COPILOT_DB;
  return path.join(os.homedir(), ".copilot", "data.db");
}

function claudeDir() {
  if (process.env.CLAUDE_DIR) return process.env.CLAUDE_DIR;
  return path.join(os.homedir(), ".claude", "projects");
}

function codexDbPath() {
  if (process.env.CODEX_DB) return process.env.CODEX_DB;
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

function copilotStateDir() {
  if (process.env.COPILOT_STATE_DIR) return process.env.COPILOT_STATE_DIR;
  return path.join(os.homedir(), ".copilot", "session-state");
}

// Copilot's data.db only stores the routing token ("auto", or null/empty); the
// model that actually ran lives per-session in session-state/<id>/events.jsonl.
// Resolve once per session id, keyed on the events.jsonl mtime.
const copilotModelCache = new Map();

// Returns { model, viaAuto }. data.db records a concrete name when a model was
// pinned, the literal "auto" when Copilot routed, and NULL/empty when it simply
// wasn't persisted. The real model always lives in the session's events.jsonl, so
// resolve there for BOTH "auto" and NULL/empty -- but only literal "auto" is truly
// Auto-routed. NULL/empty is just unrecorded (often a pinned model data.db didn't
// store), so it must NOT be labeled "(via Auto)".
function resolveCopilotModel(id, rawModel) {
  const raw = rawModel == null ? "" : String(rawModel);
  if (raw !== "" && raw !== "auto") return { model: raw, viaAuto: false };
  const resolved = copilotEventModel(id);
  return { model: resolved || "(unknown)", viaAuto: raw === "auto" };
}

// First assistant.message model in a session's events.jsonl (representative model).
// ponytail: first message only; Auto rarely switches mid-session.
function copilotEventModel(id) {
  if (!id) return null;
  let file;
  try {
    file = path.join(copilotStateDir(), id, "events.jsonl");
    const st = fs.statSync(file);
    const cached = copilotModelCache.get(id);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.model;
    let model = null;
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      if (!l.includes('"assistant.message"') || !l.includes('"model"')) continue;
      try {
        const o = JSON.parse(l);
        if (o.type === "assistant.message" && o.data && o.data.model) {
          model = o.data.model;
          break;
        }
      } catch {
        // tolerate a truncated final JSONL line
      }
    }
    copilotModelCache.set(id, { mtimeMs: st.mtimeMs, model });
    return model;
  } catch {
    return null;
  }
}

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
  let s = String(t).trim().replace(" ", "T");
  if (!/[Z+]/.test(s.slice(10))) s += "Z";
  return Date.parse(s);
}

// project filter values come from the DB (getProjects). Validate membership and
// escape quotes before interpolation — trust boundary, not simplified away.
// Empty list = no filter (all projects).
function whereProjects(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const valid = getProjects();
  const sel = list.filter((p) => valid.includes(p));
  if (!sel.length) return "";
  const vals = sel.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
  return ` WHERE project_path IN (${vals})`;
}

function getProjects() {
  return q(
    "SELECT DISTINCT project_path FROM commands WHERE project_path != '' ORDER BY project_path"
  ).map((r) => r.project_path);
}

function summary(projects) {
  const w = whereProjects(projects);
  const r = q(
    `SELECT COUNT(*) commands,
            COALESCE(SUM(input_tokens),0) input,
            COALESCE(SUM(output_tokens),0) output,
            COALESCE(SUM(saved_tokens),0) saved,
            COALESCE(SUM(exec_time_ms),0) time_ms,
            MIN(timestamp) since
     FROM commands${w}`
  )[0] || {};
  const input = r.input || 0;
  const saved = r.saved || 0;
  return {
    commands: r.commands || 0,
    input,
    output: r.output || 0,
    saved,
    // ponytail: overall ratio (matches `rtk gain`), not mean of per-row pct.
    pct: input > 0 ? (saved / input) * 100 : 0,
    time_ms: r.time_ms || 0,
    since: r.since || null,
  };
}

const BUCKET_SQL = {
  daily: "strftime('%Y-%m-%d', timestamp)",
  weekly: "strftime('%Y-W%W', timestamp)",
  monthly: "strftime('%Y-%m', timestamp)",
};

function timeseries(bucket, projects) {
  const expr = BUCKET_SQL[bucket] || BUCKET_SQL.daily;
  const w = whereProjects(projects);
  return q(
    `SELECT ${expr} period,
            COALESCE(SUM(saved_tokens),0) saved,
            COALESCE(SUM(input_tokens),0) input,
            COUNT(*) commands
     FROM commands${w}
     GROUP BY period ORDER BY period`
  );
}

// per-project breakdown per bucket, for stacked bars.
function timeseriesByProject(bucket, projects) {
  const expr = BUCKET_SQL[bucket] || BUCKET_SQL.daily;
  const w = whereProjects(projects);
  return q(
    `SELECT ${expr} period,
            project_path project,
            COALESCE(SUM(saved_tokens),0) saved
     FROM commands${w}
     GROUP BY period, project_path
     HAVING saved <> 0
     ORDER BY period`
  );
}

// Normalize "rtk read /some/file" -> "rtk read". ponytail: naive first-two-token
// grouping; widen if commands need finer buckets.
function normalizeCmd(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return parts.slice(0, 2).join(" ") || cmd;
}

function byCommand(projects, limit = 15) {
  const w = whereProjects(projects);
  const rows = q(
    `SELECT rtk_cmd,
            COUNT(*) n,
            COALESCE(SUM(saved_tokens),0) saved,
            COALESCE(SUM(input_tokens),0) input
     FROM commands${w}
     GROUP BY rtk_cmd`
  );
  const merged = new Map();
  for (const r of rows) {
    const key = normalizeCmd(r.rtk_cmd);
    const m = merged.get(key) || { command: key, n: 0, saved: 0, input: 0 };
    m.n += r.n;
    m.saved += r.saved;
    m.input += r.input;
    merged.set(key, m);
  }
  return [...merged.values()]
    .sort((a, b) => b.saved - a.saved)
    .slice(0, limit);
}

function recent(projects, limit = 50) {
  const w = whereProjects(projects);
  return q(
    `SELECT timestamp, rtk_cmd, saved_tokens, savings_pct
     FROM commands${w} ORDER BY id DESC LIMIT ${Number(limit) || 50}`
  );
}

function copilotActivity() {
  try {
    return qDb(
      copilotDbPath(),
      "SELECT id, created_at ts, model FROM sessions"
    )
      .map((r) => {
        const { model, viaAuto } = resolveCopilotModel(r.id, r.model);
        return {
          ts: toMs(r.ts),
          model,
          viaAuto,
          harness: "copilot",
          cwd: undefined,
        };
      })
      .filter((r) => Number.isFinite(r.ts));
  } catch {
    return [];
  }
}

function codexActivity() {
  try {
    return qDb(
      codexDbPath(),
      `SELECT strftime('%Y-%m-%dT%H:%M:%S', created_at, 'unixepoch') ts,
              COALESCE(NULLIF(model,''),'(unknown)') model, cwd
       FROM threads WHERE model IS NOT NULL`
    )
      .map((r) => ({
        ts: toMs(r.ts),
        model: r.model,
        harness: "codex",
        cwd: r.cwd,
      }))
      .filter((r) => Number.isFinite(r.ts));
  } catch {
    return [];
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
          model: o.message.model,
          harness: "claude",
          cwd: o.cwd,
        });
      }
    } catch {
      // tolerate a truncated final JSONL line
    }
  }
  const filtered = records.filter((r) => Number.isFinite(r.ts));
  claudeCache.set(file, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    records: filtered,
  });
  return filtered;
}

function claudeActivity(minMs) {
  try {
    const dir = claudeDir();
    if (!fs.existsSync(dir)) return [];
    const rows = [];
    for (const file of jsonlFiles(dir)) {
      const st = fs.statSync(file);
      if (st.mtimeMs < minMs) {
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

function modelActivity(minMs = 0) {
  return [
    ...copilotActivity(),
    ...codexActivity(),
    ...claudeActivity(minMs),
  ]
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);
}

// Display/aggregation key: Auto-routed models are kept distinct from pinned ones,
// so "claude-sonnet-4.6 (via Auto)" never merges with a directly-chosen "claude-sonnet-4.6".
function modelKey(model, viaAuto) {
  return viaAuto ? `${model} (via Auto)` : model;
}

function attribute(commands, activity) {
  const tss = activity.map((a) => a.ts);
  for (const cmd of commands) {
    let lo = 0;
    let hi = tss.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (tss[mid] <= cmd.ts) {
        i = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const a = i >= 0 ? activity[i] : null;
    const gapMs = a ? cmd.ts - a.ts : Infinity;
    if (!a || gapMs > MAX_GAP_MS) {
      cmd.model = "(unknown)";
      cmd.harness = "(unknown)";
      cmd.viaAuto = false;
      cmd.gapMs = null;
    } else {
      cmd.model = modelKey(a.model, a.viaAuto);
      cmd.harness = a.harness;
      cmd.viaAuto = !!a.viaAuto;
      cmd.gapMs = gapMs;
    }
  }
  return commands;
}

function commandRows(projects) {
  const w = whereProjects(projects);
  return q(
    `SELECT timestamp, saved_tokens, input_tokens, project_path
     FROM commands${w}`
  ).map((r) => ({
    timestamp: r.timestamp,
    ts: toMs(r.timestamp),
    saved: r.saved_tokens || 0,
    input: r.input_tokens || 0,
    project_path: r.project_path,
  }));
}

function minCommandMs(rows) {
  let minMs = Infinity;
  for (const r of rows) {
    if (Number.isFinite(r.ts) && r.ts < minMs) minMs = r.ts;
  }
  return minMs === Infinity ? Date.now() : minMs;
}

function attributedCommands(projects) {
  const rows = commandRows(projects);
  return attribute(rows, modelActivity(minCommandMs(rows)));
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

function byModel(projects, rows) {
  return groupedAttributed(rows || attributedCommands(projects), "model");
}

function byHarness(projects, rows) {
  return groupedAttributed(rows || attributedCommands(projects), "harness");
}

function sqliteWeekPeriod(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const day = Date.UTC(year, d.getUTCMonth(), d.getUTCDate());
  const yday = Math.floor((day - Date.UTC(year, 0, 1)) / 86400000);
  const mondayDay = (d.getUTCDay() + 6) % 7;
  const week = Math.floor((yday + 7 - mondayDay) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function periodFor(bucket, r) {
  const s = String(r.timestamp || "");
  if (bucket === "monthly") return s.slice(0, 7);
  if (bucket === "weekly") {
    // ponytail: JS bucket after attribution; formula matches SQLite strftime('%W').
    return sqliteWeekPeriod(r.ts);
  }
  return s.slice(0, 10);
}

function timeseriesByModel(bucket, projects, rows) {
  const grouped = new Map();
  for (const r of rows || attributedCommands(projects)) {
    const period = periodFor(bucket, r);
    const key = `${period}\n${r.model || "(unknown)"}`;
    const m = grouped.get(key) || {
      period,
      model: r.model || "(unknown)",
      saved: 0,
    };
    m.saved += r.saved || 0;
    grouped.set(key, m);
  }
  return [...grouped.values()]
    .filter((r) => r.saved !== 0)
    .sort(
      (a, b) => a.period.localeCompare(b.period) || a.model.localeCompare(b.model)
    );
}

function getAll(opts = {}) {
  const projects = Array.isArray(opts.projectPaths) ? opts.projectPaths : [];
  const attributed = attributedCommands(projects);
  return {
    available: dbExists(),
    projectPaths: projects,
    projects: getProjects(),
    summary: summary(projects),
    series: {
      daily: timeseries("daily", projects),
      weekly: timeseries("weekly", projects),
      monthly: timeseries("monthly", projects),
    },
    stacked: {
      daily: timeseriesByProject("daily", projects),
      weekly: timeseriesByProject("weekly", projects),
      monthly: timeseriesByProject("monthly", projects),
    },
    byModel: byModel(projects, attributed),
    byHarness: byHarness(projects, attributed),
    stackedByModel: {
      daily: timeseriesByModel("daily", projects, attributed),
      weekly: timeseriesByModel("weekly", projects, attributed),
      monthly: timeseriesByModel("monthly", projects, attributed),
    },
    harnessesAvailable: {
      copilot: fs.existsSync(copilotDbPath()),
      claude: fs.existsSync(claudeDir()),
      codex: fs.existsSync(codexDbPath()),
    },
    byCommand: byCommand(projects),
    recent: recent(projects),
  };
}

module.exports = {
  getAll,
  summary,
  getProjects,
  byModel,
  byHarness,
  modelActivity,
  DB,
  dbExists,
};

if (require.main === module) {
  // self-check: the only non-trivial logic is the SQL/aggregation.
  const all = getAll();
  const s = all.summary;
  console.log("db:", DB, "exists:", all.available);
  console.log("since:", s.since, "commands:", s.commands);
  console.log(
    "saved:",
    s.saved,
    "tokens  savings:",
    s.pct.toFixed(1) + "%"
  );
  console.log("projects:", all.projects.length, "top cmd:", all.byCommand[0]);
  console.assert(s.saved >= 0 && s.commands >= 0, "non-negative totals");
  console.assert(
    all.byCommand.reduce((a, c) => a + c.saved, 0) <= s.saved + 1,
    "by-command saved <= total saved"
  );
  const stackTotal = all.stacked.daily.reduce((a, r) => a + r.saved, 0);
  const dailyTotal = all.series.daily.reduce((a, r) => a + r.saved, 0);
  console.assert(
    Math.abs(stackTotal - dailyTotal) <= 1,
    "stacked daily saved == series daily saved"
  );
  const byModelTotal = all.byModel.reduce((a, r) => a + r.saved, 0);
  const byHarnessTotal = all.byHarness.reduce((a, r) => a + r.saved, 0);
  const modelDailyTotal = all.stackedByModel.daily.reduce(
    (a, r) => a + r.saved,
    0
  );
  console.assert(
    Math.abs(byModelTotal - s.saved) <= 1,
    "by-model saved == total saved"
  );
  console.assert(
    Math.abs(byHarnessTotal - s.saved) <= 1,
    "by-harness saved == total saved"
  );
  console.assert(
    Math.abs(modelDailyTotal - dailyTotal) <= 1,
    "stacked model daily saved == series daily saved"
  );
  const activity = modelActivity(0);
  console.assert(
    activity.every((a) => Number.isFinite(a.ts)),
    "activity timestamps are finite"
  );
  console.assert(
    activity.every((a, i) => i === 0 || activity[i - 1].ts <= a.ts),
    "activity sorted ascending"
  );
  const rows = commandRows();
  const reattributed = attribute(rows, modelActivity(minCommandMs(rows)));
  console.assert(
    reattributed.every((r) => r.gapMs == null || r.gapMs <= MAX_GAP_MS),
    "attributed commands stay within max gap"
  );
  console.log(
    "by-model:",
    all.byModel
      .slice(0, 5)
      .map((r) => `${r.model}:${r.saved}`)
      .join(", ")
  );
  console.log(
    "by-harness:",
    all.byHarness.map((r) => `${r.harness}:${r.saved}`).join(", ")
  );
  if (all.projects[0]) {
    const ps = summary([all.projects[0]]);
    console.assert(
      ps.saved <= s.saved + 1,
      "single project saved <= global saved"
    );
    if (all.projects[1]) {
      const two = summary([all.projects[0], all.projects[1]]);
      console.assert(
        two.saved >= ps.saved && two.saved <= s.saved + 1,
        "two projects saved between one and global"
      );
    }
  }
  console.log("self-check ok");
}
