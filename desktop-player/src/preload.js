"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ajrmPlayer", {
  appVersion: () => ipcRenderer.invoke("app-version"),
  fetchStatus: (serverUrl) => ipcRenderer.invoke("fetch-audio-status", serverUrl),
});
