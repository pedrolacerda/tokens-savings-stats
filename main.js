"use strict";
const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("path");
const stats = require("./stats");

let tray = null;
let win = null;

function humanK(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function trayIcon() {
  const img = nativeImage.createFromPath(
    path.join(__dirname, "build", "trayTemplate.png")
  );
  img.setTemplateImage(true); // adapts to light/dark menu bar
  return img;
}

function updateTray() {
  try {
    const s = stats.summary([]);
    if (!stats.dbExists()) {
      tray.setTitle(" rtk: no data");
      tray.setToolTip("rtk history.db not found yet");
      return;
    }
    tray.setTitle(` ${Math.round(s.pct)}% · ${humanK(s.saved)}`);
    tray.setToolTip(
      `${humanK(s.saved)} tokens saved (${s.pct.toFixed(1)}%) over ${s.commands} commands`
    );
  } catch (e) {
    tray.setTitle(" rtk: err");
    tray.setToolTip("Error reading rtk stats: " + e.message);
  }
}

function showDashboard() {
  if (!win) {
    win = new BrowserWindow({
      width: 1140,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: "rtk Savings",
      backgroundColor: "#0d1117",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadFile(path.join(__dirname, "renderer", "index.html"));
    win.on("close", (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        win.hide();
      }
    });
  } else {
    win.webContents.send("refresh"); // re-opening a hidden window → reload data
  }
  win.show();
  win.focus();
}

function buildMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showDashboard },
    { type: "separator" },
    {
      label: "Start at Login",
      type: "checkbox",
      checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { label: "Refresh Now", click: updateTray },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "Cmd+Q",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

app.whenReady().then(() => {
  // dashboard refresh also updates the tray number (no background polling)
  ipcMain.handle("get-stats", (_e, opts) => {
    const all = stats.getAll(opts || {});
    updateTray();
    return all;
  });

  tray = new Tray(trayIcon());
  tray.setContextMenu(buildMenu());
  tray.on("click", showDashboard);
  updateTray();

  showDashboard(); // open the dashboard on launch (has a Dock icon)
});

// clicking the Dock icon re-opens the dashboard
app.on("activate", showDashboard);

// stays alive in the menu bar even with no window open
app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
  app.isQuitting = true;
});
