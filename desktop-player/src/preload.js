"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ajrmPlayer", {
  appVersion: () => ipcRenderer.invoke("app-version"),
});
