"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rtk", {
  getStats: (opts) => ipcRenderer.invoke("get-stats", opts),
  onRefresh: (cb) => ipcRenderer.on("refresh", () => cb()),
});
