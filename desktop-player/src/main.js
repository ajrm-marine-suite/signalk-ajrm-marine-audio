"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { isLocalSignalKHost } = require("./local-hosts");
const { requestAudioDataUrl, requestErrorMessage, requestJson, statusUrl } = require("./status-client");

let mainWindow = null;

function installLocalCertificatePolicy() {
  app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (_error) {
      callback(false);
      return;
    }
    if (isLocalSignalKHost(hostname)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: "AJRM Marine Audio Player",
    backgroundColor: "#071317",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  installLocalCertificatePolicy();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("app-version", () => app.getVersion());
ipcMain.handle("fetch-audio-status", async (_event, serverUrl) => safeResult(() => requestJson(statusUrl(serverUrl))));
ipcMain.handle("fetch-audio-data-url", async (_event, audioUrl) => safeResult(() => requestAudioDataUrl(audioUrl)));

async function safeResult(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return {
      ok: false,
      error: requestErrorMessage(error),
      code: error?.code || "",
    };
  }
}
