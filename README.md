# rtk Savings

A cross-platform menu bar / tray app + dashboard that tracks how many tokens
you've saved with [`rtk`](https://github.com/) since you started using it.

- **Menu bar / tray:** shows live `66% · 256K` (overall savings % + total tokens saved).
- **Dashboard:** opens on launch (and from the Dock/tray or menu bar icon) — summary cards, tokens-saved over time (daily/weekly/monthly, or a **custom** date range), top commands, and a recent-activity feed — with a **Global / multi-project** scope filter. Data refreshes on launch, on re-open, and via the **↻ Refresh** button (no background polling).

It reads rtk's own SQLite history via the `sqlite3` CLI (`-json`) — no native
modules, nothing to rebuild. The DB path is resolved per-OS (override with the
`RTK_DB` env var):

| OS | rtk history DB |
|----|----------------|
| macOS | `~/Library/Application Support/rtk/history.db` |
| Linux | `~/.config/rtk/history.db` |
| Windows | `%APPDATA%\rtk\history.db` |

> macOS ships `sqlite3` at `/usr/bin/sqlite3`. On **Linux/Windows** make sure
> `sqlite3` is on `PATH` (e.g. `apt install sqlite3`, or the SQLite tools on Windows).

## Develop / run from source

```bash
npm install
npm start          # launches the app (Dock icon + menu bar item, opens the dashboard)
node stats.js      # data-layer self-check against the real rtk DB
```

## Build installers

```bash
npm run dist         # builds for the current OS
# or target explicitly:
npm run dist:mac     # → dist/*.dmg, *.zip  (+ dist/mac*/rtk Savings.app)
npm run dist:win     # → dist/*.exe (NSIS), *.zip
npm run dist:linux   # → dist/*.AppImage, *.deb
```

CI builds all three via GitHub Actions (`.github/workflows/build.yml`) on every
push/PR and on `v*` tags, uploading the installers as workflow artifacts.

On macOS, drag **rtk Savings.app** to `/Applications`.

> Builds are unsigned. On macOS, first launch: right-click the app → **Open**, or
> run `xattr -dr com.apple.quarantine "/Applications/rtk Savings.app"`.

## Launch at login

Pick one:

1. **In-app toggle** — menu bar icon → **Start at Login** (uses macOS login items). Easiest.
2. **System Settings** → General → Login Items → add *rtk Savings*.
3. **launchd** — copy the provided agent:
   ```bash
   cp launchd/rtk-savings.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/rtk-savings.plist
   ```
   (Assumes the app is in `/Applications`. Edit the path in the plist if not.)

## Notes

- "Savings %" matches `rtk gain` (overall `saved / input`, not the mean of per-command percentages).
- Replace `build/icon.png` / `build/trayTemplate.png` to customize the icons.
