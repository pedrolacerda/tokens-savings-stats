# rtk Savings

A native **macOS / Windows / Linux** menu bar / tray app + dashboard that tracks
how many tokens you've saved with [`rtk`](https://github.com/) since you started
using it. Built with [Tauri v2](https://v2.tauri.app/) on top of
[Pake](https://github.com/tw93/Pake) — a lightweight Rust/WebView shell (no
Electron, ~single-digit-MB binary).

- **Tray:** shows the live savings readout `66% · 256K` (overall savings % +
  total tokens saved). On **macOS** this is the menu-bar title text; on
  **Windows/Linux** (where tray icons have no text label) the same readout appears
  as the first item of the tray menu and in the icon tooltip.
- **Dashboard:** opens on launch (and from the Dock / tray / menu bar icon) — summary
  cards, tokens-saved over time (daily/weekly/monthly, or a **custom** date range),
  top commands, per-model and per-harness breakdowns, and a recent-activity feed,
  with a **multi-project** scope filter. Data refreshes on launch, on re-open, and
  via the **↻ Refresh** button (no background polling).

The data layer is implemented in Rust (`src-tauri/src/rtk/`) and reads local
SQLite/JSONL directly via the bundled `rusqlite` crate — nothing to install, no
`sqlite3` CLI dependency. The dashboard calls the Rust `get_stats` Tauri command
through `window.rtk` (see the shim in `renderer/index.html`).

## Data sources

Paths can be overridden via environment variables. The rtk history DB location
is OS-specific; the model sources use the same home-relative dot-dirs on every OS:

| Source | Default path | Env override |
|--------|--------------|--------------|
| rtk history (savings) — macOS | `~/Library/Application Support/rtk/history.db` | `RTK_DB` |
| rtk history (savings) — Windows | `%APPDATA%\rtk\history.db` | `RTK_DB` |
| rtk history (savings) — Linux | `$XDG_CONFIG_HOME/rtk/history.db` (or `~/.config/rtk/history.db`) | `RTK_DB` |
| Copilot sessions (model) | `~/.copilot/data.db` | `COPILOT_DB` |
| Copilot session state | `~/.copilot/session-state/` | `COPILOT_STATE_DIR` |
| Codex threads (model) | `~/.codex/state_5.sqlite` | `CODEX_DB` |
| Claude projects (model) | `~/.claude/projects/` | `CLAUDE_DIR` |

The rtk history DB is required; the others are optional and only power the
per-model / per-harness attribution (each is skipped gracefully if absent).

## Develop / run from source

Requires **Rust ≥ 1.85**, **Node ≥ 18** (22 LTS recommended), and **pnpm**.

```bash
pnpm install
pnpm dev            # native dev shell (Dock icon + menu bar item, opens the dashboard)
```

Data-layer self-check (runs the aggregation invariants against your real DBs):

```bash
cd src-tauri && cargo test
```

## Build the app

Common prerequisites (all platforms): **Rust ≥ 1.85**, **Node ≥ 18** (22 LTS
recommended), and **pnpm**. Tauri builds are **native per-OS** — each installer is
produced on its own operating system (no cross-compiling).

```bash
pnpm install        # once, to fetch the Tauri CLI
pnpm build:mac      # macOS installers (or build:win / build:linux on those hosts)
```

Use the **per-OS script** for your host — each emits that platform's installers.
(`pnpm build` alone runs a plain `tauri build`, which only produces the app
bundle; the `build:*` scripts pass explicit `--bundles` for the full installer set
and are what CI runs.)

| Host | Command | Outputs (under `src-tauri/target/release/bundle/`) | Extra prerequisites |
|------|---------|----------------------------------------------------|---------------------|
| macOS | `pnpm build:mac` | `macos/rtk Savings.app`, `dmg/*.dmg` | Xcode CLT (`xcode-select --install`) |
| Windows | `pnpm build:win` | `nsis/*.exe`, `msi/*.msi` | MSVC Build Tools + WebView2 (preinstalled on Win 11) |
| Linux | `pnpm build:linux` | `deb/*.deb`, `appimage/*.AppImage`, `rpm/*.rpm` | system packages below |

On **Linux**, install the WebKitGTK / tray / packaging dependencies first (Debian/Ubuntu):

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev patchelf build-essential
```

The first build compiles all Rust crates and is slow (a few minutes); subsequent
builds are fast.

CI builds **macOS, Windows, and Linux** in parallel via a GitHub Actions matrix
(`.github/workflows/build.yml`) on every push/PR and on `v*` tags, uploading each
platform's installers as workflow artifacts.

### Install

- **macOS** — drag **rtk Savings.app** to `/Applications`.
  > Builds are unsigned / not notarized. On first launch: right-click the app →
  > **Open**, or run
  > `xattr -dr com.apple.quarantine "/Applications/rtk Savings.app"`.
- **Windows** — run the `.exe` (NSIS) or `.msi`. SmartScreen may warn on unsigned
  builds: **More info → Run anyway**.
- **Linux** — install the `.deb`/`.rpm`, or `chmod +x` and run the `.AppImage`.

## Launch at login

Pick one:

1. **System Settings** → General → Login Items → add *rtk Savings*.
2. **launchd** — copy the provided agent:
   ```bash
   cp launchd/rtk-savings.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/rtk-savings.plist
   ```
   (Assumes the app is in `/Applications`. Edit the path in the plist if not.)

## Native edit points

- **Data / command:** `src-tauri/src/rtk/mod.rs` (the port of the old `stats.js`);
  the `get_stats` command lives in `src-tauri/src/app/invoke.rs` and is registered
  in `src-tauri/src/lib.rs` at the `tauri::generate_handler![...]` block.
- **Tray:** enabled via `system_tray.macos` in `src-tauri/pake.json`; the live
  title is set by `rtk::update_tray` (`src-tauri/src/rtk/mod.rs`), wired in
  `setup` and on every `get_stats` call.
- **Window / local URL:** `src-tauri/pake.json` (`windows[0]`) and
  `src-tauri/tauri.conf.json` (`build.frontendDist` → `../renderer`).
- Pinned to Pake `V3.12.0`, Tauri `2.10.x`.

## Notes

- "Savings %" matches `rtk gain` (overall `saved / input`, not the mean of per-command percentages).
- Replace `build/icon.png` / `build/trayTemplate.png` to customize the icons
  (regenerate `src-tauri/icons/`).
