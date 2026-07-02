"use strict";

const STORAGE_KEY = "ajrmMarineAudioPlayer.settings";
const POLL_MS = 1500;
const MAX_SEEN = 120;
const MAX_HISTORY = 30;

const els = {
  serverUrl: document.getElementById("serverUrl"),
  connectButton: document.getElementById("connectButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  muteButton: document.getElementById("muteButton"),
  repeatButton: document.getElementById("repeatButton"),
  clearButton: document.getElementById("clearButton"),
  volume: document.getElementById("volume"),
  volumeValue: document.getElementById("volumeValue"),
  audio: document.getElementById("audio"),
  connectionPill: document.getElementById("connectionPill"),
  nowPlaying: document.getElementById("nowPlaying"),
  pluginVersion: document.getElementById("pluginVersion"),
  serverTime: document.getElementById("serverTime"),
  queueLength: document.getElementById("queueLength"),
  lastPoll: document.getElementById("lastPoll"),
  announcements: document.getElementById("announcements"),
  message: document.getElementById("message"),
};

let pollTimer = null;
let connected = false;
let muted = false;
let playing = false;
let queue = [];
let history = [];
let seenKeys = [];
let lastAnnouncement = null;

const settings = loadSettings();
els.serverUrl.value = settings.serverUrl || "http://localhost:3000";
els.volume.value = String(settings.volume ?? 100);
els.audio.volume = Number(els.volume.value) / 100;
renderVolume();
renderState();

els.connectButton.addEventListener("click", connect);
els.disconnectButton.addEventListener("click", disconnect);
els.muteButton.addEventListener("click", () => {
  muted = !muted;
  if (muted) els.audio.pause();
  renderState();
  if (!muted) playNext();
});
els.repeatButton.addEventListener("click", () => {
  if (!lastAnnouncement) {
    setMessage("No announcement has been received yet.");
    return;
  }
  enqueue(lastAnnouncement, { force: true });
});
els.clearButton.addEventListener("click", () => {
  queue = [];
  renderState();
  setMessage("Queue cleared.");
});
els.volume.addEventListener("input", () => {
  els.audio.volume = Number(els.volume.value) / 100;
  settings.volume = Number(els.volume.value);
  saveSettings(settings);
  renderVolume();
});
els.audio.addEventListener("ended", () => {
  playing = false;
  playNext();
});
els.audio.addEventListener("error", () => {
  playing = false;
  setMessage("Audio playback failed. Skipping to the next announcement.");
  playNext();
});

async function connect() {
  settings.serverUrl = normalizeServerUrl(els.serverUrl.value);
  els.serverUrl.value = settings.serverUrl;
  saveSettings(settings);
  connected = true;
  seenKeys = [];
  setMessage("Connecting...");
  renderState();
  await poll({ markExistingSeen: true });
  pollTimer = window.setInterval(() => poll(), POLL_MS);
}

function disconnect() {
  connected = false;
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  queue = [];
  playing = false;
  els.audio.pause();
  renderState();
  setMessage("Disconnected.");
}

async function poll({ markExistingSeen = false } = {}) {
  if (!connected) return;
  try {
    const status = await fetchStatus(settings.serverUrl);
    renderStatus(status);
    const announcements = status.recentAnnouncements?.length
      ? status.recentAnnouncements
      : [status.lastAnnouncement].filter(Boolean);
    if (markExistingSeen) {
      for (const item of announcements) rememberSeen(announcementKey(item));
      setMessage("Connected. Waiting for new announcements.");
    } else {
      for (const item of announcements) enqueue(item);
    }
    els.lastPoll.textContent = new Date().toLocaleTimeString();
    renderState();
  } catch (error) {
    els.connectionPill.textContent = "Offline";
    els.connectionPill.className = "pill bad";
    setMessage(error.message || String(error));
  }
}

async function fetchStatus(serverUrl) {
  const response = await fetch(`${serverUrl}/signalk/v1/api/ajrmMarineAudio/status`, {
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Audio status failed: HTTP ${response.status}`);
  }
  return response.json();
}

function enqueue(announcement, { force = false } = {}) {
  if (!announcement || !announcement.message) return false;
  const audioUrl = announcement.audioUrl || announcement.publicAudioUrl || "";
  if (!audioUrl) return false;
  const key = announcementKey(announcement);
  if (!force && seenKeys.includes(key)) return false;
  rememberSeen(key);
  const absoluteAudioUrl = absoluteUrl(settings.serverUrl, audioUrl);
  const item = {
    key,
    audioUrl: absoluteAudioUrl,
    message: String(announcement.message || ""),
    receivedAt: new Date().toISOString(),
  };
  queue.push(item);
  lastAnnouncement = item;
  history.unshift(item);
  history = history.slice(0, MAX_HISTORY);
  renderHistory();
  renderState();
  playNext();
  return true;
}

function playNext() {
  if (playing || muted) return;
  const item = queue.shift();
  if (!item) {
    renderState();
    return;
  }
  playing = true;
  els.nowPlaying.textContent = item.message;
  els.nowPlaying.classList.remove("muted");
  els.audio.src = item.audioUrl;
  els.audio.play().catch((error) => {
    playing = false;
    setMessage(`Playback needs user interaction or an available output device: ${error.message || error}`);
  });
  renderState();
}

function renderStatus(status) {
  els.pluginVersion.textContent = status.version || "-";
  els.serverTime.textContent = status.serverTime
    ? new Date(status.serverTime).toLocaleTimeString()
    : "-";
}

function renderState() {
  els.connectionPill.textContent = connected ? (muted ? "Muted" : "Connected") : "Disconnected";
  els.connectionPill.className = `pill ${connected ? (muted ? "warn" : "good") : "bad"}`;
  els.connectButton.disabled = connected;
  els.disconnectButton.disabled = !connected;
  els.muteButton.textContent = muted ? "Unmute" : "Mute";
  els.queueLength.textContent = String(queue.length);
  if (!playing && !queue.length) {
    els.nowPlaying.textContent = "No announcement playing.";
    els.nowPlaying.classList.add("muted");
  }
}

function renderHistory() {
  els.announcements.innerHTML = history.length
    ? history
        .map((item) => `<li><strong>${escapeHtml(new Date(item.receivedAt).toLocaleTimeString())}</strong> ${escapeHtml(item.message)}</li>`)
        .join("")
    : "";
}

function renderVolume() {
  els.volumeValue.textContent = `${els.volume.value}%`;
}

function setMessage(message) {
  els.message.textContent = message;
}

function announcementKey(announcement) {
  return String(
    announcement?.playbackId ||
      announcement?.requestId ||
      announcement?.audioUrl ||
      announcement?.publicAudioUrl ||
      announcement?.message ||
      "",
  );
}

function rememberSeen(key) {
  if (!key || seenKeys.includes(key)) return;
  seenKeys.push(key);
  if (seenKeys.length > MAX_SEEN) seenKeys = seenKeys.slice(-MAX_SEEN);
}

function normalizeServerUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  return trimmed || "http://localhost:3000";
}

function absoluteUrl(serverUrl, value) {
  if (/^https?:\/\//i.test(value)) return value;
  return `${serverUrl}${value.startsWith("/") ? "" : "/"}${value}`;
}

function loadSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_error) {
    return {};
  }
}

function saveSettings(value) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.ajrmPlayer?.appVersion?.().then((version) => {
  document.title = `AJRM Marine Audio Player ${version}`;
});
