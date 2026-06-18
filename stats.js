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

function dbExists() {
  return fs.existsSync(DB);
}

function q(sql) {
  if (!dbExists()) return [];
  // ponytail: normal open (SELECT-only) — WAL mode rejects a read-only open when
  // the -shm sidecar is absent; concurrent SELECTs are safe and never mutate data.
  const out = execFileSync(SQLITE, ["-json", DB, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
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

function getAll(opts = {}) {
  const projects = Array.isArray(opts.projectPaths) ? opts.projectPaths : [];
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
    byCommand: byCommand(projects),
    recent: recent(projects),
  };
}

module.exports = { getAll, summary, getProjects, DB, dbExists };

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
