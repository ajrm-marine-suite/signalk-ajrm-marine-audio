"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { isLocalSignalKHost } = require("./local-hosts");
const { requestAudioDataUrl, requestErrorMessage, requestJson, statusUrl } = require("./status-client");

let mainWindow = null;
let logFile = "";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

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
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  logFile = path.join(app.getPath("userData"), "audio-player.log");
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
ipcMain.handle("diagnostic-log-path", () => logFile);
ipcMain.handle("write-diagnostic-log", async (_event, entry) => {
  const line = formatDiagnosticEntry(entry);
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  await fs.promises.appendFile(logFile, `${line}\n`, "utf8");
  return { ok: true };
});
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

function formatDiagnosticEntry(entry) {
  const stamp = new Date().toISOString();
  const type = String(entry?.type || "event").replace(/[\r\n]/g, " ");
  const message = String(entry?.message || "").replace(/[\r\n]/g, " ");
  const details = entry?.details && typeof entry.details === "object"
    ? ` ${JSON.stringify(entry.details)}`
    : "";
  return `${stamp} ${type} ${message}${details}`.trim();
}
