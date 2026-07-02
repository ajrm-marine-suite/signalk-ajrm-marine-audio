"use strict";

const STORAGE_KEY = "ajrmMarineAudioPlayer.settings";
const POLL_MS = 1500;
const AUTO_RETRY_MS = 60000;
const MAX_SEEN = 120;
const MAX_HISTORY = 30;

const els = {
  serverUrl: document.getElementById("serverUrl"),
  autoConnect: document.getElementById("autoConnect"),
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
let retryTimer = null;
let connected = false;
let connecting = false;
let connectAttemptId = 0;
let muted = false;
let playing = false;
let queue = [];
let history = [];
let seenKeys = [];
let lastAnnouncement = null;

const settings = loadSettings();
els.serverUrl.value = settings.serverUrl || "http://localhost:3000";
els.autoConnect.checked = Boolean(settings.autoConnect);
els.volume.value = String(settings.volume ?? 100);
els.audio.volume = Number(els.volume.value) / 100;
renderVolume();
renderState();

els.connectButton.addEventListener("click", () => connect({ automatic: false }));
els.disconnectButton.addEventListener("click", disconnect);
els.autoConnect.addEventListener("change", () => {
  settings.autoConnect = els.autoConnect.checked;
  saveSettings(settings);
  if (els.autoConnect.checked && !connected && !connecting) {
    scheduleAutoRetry({ immediate: true });
  } else {
    clearRetry();
  }
});
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

if (settings.autoConnect) {
  window.setTimeout(() => connect({ automatic: true }), 0);
}

async function connect({ automatic = false } = {}) {
  if (connecting || connected) return;
  clearRetry();
  const attemptId = ++connectAttemptId;
  settings.serverUrl = normalizeServerUrl(els.serverUrl.value);
  els.serverUrl.value = settings.serverUrl;
  saveSettings(settings);
  connecting = true;
  connected = true;
  seenKeys = [];
  setMessage("Connecting...");
  renderState();
  const ok = await poll({ markExistingSeen: true, initialConnect: true });
  if (attemptId !== connectAttemptId) return;
  connecting = false;
  if (ok) {
    pollTimer = window.setInterval(() => poll(), POLL_MS);
  } else {
    connected = false;
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    if (automatic || settings.autoConnect) scheduleAutoRetry();
  }
  renderState();
}

function disconnect() {
  connectAttemptId += 1;
  connecting = false;
  connected = false;
  clearRetry();
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  queue = [];
  playing = false;
  els.audio.pause();
  renderState();
  setMessage("Disconnected.");
}

async function poll({ markExistingSeen = false, initialConnect = false } = {}) {
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
    return true;
  } catch (error) {
    if (initialConnect) connected = false;
    els.connectionPill.textContent = "Offline";
    els.connectionPill.className = "pill bad";
    setMessage(error.message || String(error));
    if (!initialConnect && settings.autoConnect) {
      connected = false;
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
      scheduleAutoRetry();
      renderState();
    }
    setMessage(formatErrorMessage(error));
    return false;
  }
}

function scheduleAutoRetry({ immediate = false } = {}) {
  clearRetry();
  if (!settings.autoConnect || connected || connecting) return;
  const delay = immediate ? 0 : AUTO_RETRY_MS;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    connect({ automatic: true });
  }, delay);
  if (!immediate) {
    setMessage(`Auto-connect failed. Retrying in ${Math.round(AUTO_RETRY_MS / 1000)} seconds.`);
  }
}

function clearRetry() {
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = null;
}

async function fetchStatus(serverUrl) {
  if (window.ajrmPlayer?.fetchStatus) {
    return window.ajrmPlayer.fetchStatus(serverUrl);
  }
  const response = await fetch(`${serverUrl}/signalk/v1/api/ajrmMarineAudio/status`, {
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(response.status === 401
      ? "Signal K rejected the status request (HTTP 401). Enable Signal K read-only access, or disable security for testing."
      : `Audio status failed: HTTP ${response.status}`);
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
    playbackUrl: "",
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

async function playNext() {
  if (playing || muted) return;
  const item = queue.shift();
  if (!item) {
    renderState();
    return;
  }
  playing = true;
  els.nowPlaying.textContent = item.message;
  els.nowPlaying.classList.remove("muted");
  try {
    els.audio.src = await resolveAudioUrl(item);
  } catch (error) {
    playing = false;
    setMessage(`Audio download failed: ${formatErrorMessage(error)}`);
    playNext();
    return;
  }
  els.audio.play().catch((error) => {
    playing = false;
    setMessage(`Playback needs user interaction or an available output device: ${error.message || error}`);
  });
  renderState();
}

async function resolveAudioUrl(item) {
  if (item.playbackUrl) return item.playbackUrl;
  if (window.ajrmPlayer?.fetchAudioDataUrl) {
    item.playbackUrl = await window.ajrmPlayer.fetchAudioDataUrl(item.audioUrl);
    return item.playbackUrl;
  }
  item.playbackUrl = item.audioUrl;
  return item.playbackUrl;
}

function renderStatus(status) {
  els.pluginVersion.textContent = status.version || "-";
  els.serverTime.textContent = status.serverTime
    ? new Date(status.serverTime).toLocaleTimeString()
    : "-";
}

function renderState() {
  els.connectionPill.textContent = connecting
    ? "Connecting"
    : connected
      ? muted
        ? "Muted"
        : "Connected"
      : "Disconnected";
  els.connectionPill.className = `pill ${connecting ? "warn" : connected ? (muted ? "warn" : "good") : "bad"}`;
  els.connectButton.disabled = connecting || connected;
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

function formatErrorMessage(error) {
  if (error?.message) return error.message;
  if (Array.isArray(error?.errors) && error.errors.length) {
    const first = error.errors.find((item) => item?.message) || error.errors[0];
    if (first?.message) return first.message;
  }
  if (error?.code) return error.code;
  return String(error || "Unknown error");
}

window.ajrmPlayer?.appVersion?.().then((version) => {
  document.title = `AJRM Marine Audio Player ${version}`;
});
