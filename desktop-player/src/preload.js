"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ajrmPlayer", {
  appVersion: () => ipcRenderer.invoke("app-version"),
  fetchAudioDataUrl: (audioUrl) => ipcRenderer.invoke("fetch-audio-data-url", audioUrl),
  fetchStatus: (serverUrl) => ipcRenderer.invoke("fetch-audio-status", serverUrl),
});
