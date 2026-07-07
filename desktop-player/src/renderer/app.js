"use strict";

const STORAGE_KEY = "ajrmMarineAudioPlayer.settings";
const POLL_MS = 1500;
const AUTO_RETRY_MS = 60000;
const PLAYBACK_RETRY_MS = 3000;
const MAX_SEEN = 120;
const MAX_HISTORY = 30;
const MAX_DIAGNOSTICS = 120;

const els = {
  serverUrl: document.getElementById("serverUrl"),
  autoConnect: document.getElementById("autoConnect"),
  connectButton: document.getElementById("connectButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  muteButton: document.getElementById("muteButton"),
  soundCheckButton: document.getElementById("soundCheckButton"),
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
  logPath: document.getElementById("logPath"),
  announcements: document.getElementById("announcements"),
  diagnostics: document.getElementById("diagnostics"),
  message: document.getElementById("message"),
};

let pollTimer = null;
let retryTimer = null;
let pollInFlight = false;
let statusFailureCount = 0;
let connected = false;
let connecting = false;
let connectAttemptId = 0;
let muted = false;
let playing = false;
let queue = [];
let history = [];
let seenKeys = [];
let pendingKeys = new Set();
let playbackRetryTimers = new Set();
let lastAnnouncement = null;
let currentItem = null;
let diagnostics = [];
let lastStatusSummary = "";

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
els.soundCheckButton.addEventListener("click", playCachedSoundCheck);
els.repeatButton.addEventListener("click", () => {
  if (!lastAnnouncement) {
    setMessage("No announcement has been received yet.");
    return;
  }
  enqueue(lastAnnouncement, { force: true });
});
els.clearButton.addEventListener("click", () => {
  for (const item of queue) releasePending(item);
  clearPlaybackRetryTimers();
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
  logDiagnostic("playback-ended", currentItem?.message || "Audio ended");
  if (currentItem) {
    rememberSeen(currentItem.key);
    releasePending(currentItem);
  }
  currentItem = null;
  playing = false;
  playNext();
});
els.audio.addEventListener("error", () => {
  logDiagnostic("playback-error", "Audio element reported an error", {
    message: currentItem?.message || "",
    code: els.audio.error?.code || "",
  });
  schedulePlaybackRetry(currentItem, "Audio playback failed.");
  currentItem = null;
  playing = false;
  renderState();
});
els.audio.addEventListener("playing", () => {
  logDiagnostic("playback-playing", currentItem?.message || "Audio playback started");
});
window.addEventListener("focus", () => logDiagnostic("window-focus", "Audio player window gained focus"));
window.addEventListener("blur", () => logDiagnostic("window-blur", "Audio player window lost focus"));
document.addEventListener("visibilitychange", () => {
  logDiagnostic("visibility", `Document visibility changed to ${document.visibilityState}`);
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
  pollInFlight = false;
  statusFailureCount = 0;
  seenKeys = [];
  pendingKeys = new Set();
  setMessage("Connecting...");
  logDiagnostic("connect", `${automatic ? "Auto-c" : "C"}onnecting to ${settings.serverUrl}`);
  renderState();
  const ok = await poll({ markExistingSeen: true, initialConnect: true });
  if (attemptId !== connectAttemptId) return;
  connecting = false;
  if (ok) {
    logDiagnostic("connect-ok", `Connected to ${settings.serverUrl}`);
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
  logDiagnostic("disconnect", "Disconnected by user or app shutdown");
  connectAttemptId += 1;
  connecting = false;
  connected = false;
  pollInFlight = false;
  statusFailureCount = 0;
  clearRetry();
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  clearPlaybackRetryTimers();
  releasePending(currentItem);
  currentItem = null;
  pendingKeys = new Set();
  queue = [];
  playing = false;
  els.audio.pause();
  renderState();
  setMessage("Disconnected.");
}

async function poll({ markExistingSeen = false, initialConnect = false } = {}) {
  if (!connected) return;
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const status = await fetchStatus(settings.serverUrl);
    statusFailureCount = 0;
    renderStatus(status);
    const announcements = status.recentAnnouncements?.length
      ? status.recentAnnouncements
      : [status.lastAnnouncement].filter(Boolean);
    if (markExistingSeen) {
      if (announcements.length) {
        logDiagnostic("connect-seen", `Marked ${announcements.length} existing announcement(s) as already seen on connect`);
      }
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
    statusFailureCount += 1;
    if (initialConnect) {
      els.connectionPill.textContent = "Offline";
      els.connectionPill.className = "pill bad";
    }
    setMessage(`Audio status poll failed${statusFailureCount > 1 ? ` ${statusFailureCount} times` : ""}: ${formatErrorMessage(error)}`);
    logDiagnostic("status-failed", formatErrorMessage(error), {
      count: statusFailureCount,
      initialConnect,
    });
    renderState();
    return false;
  } finally {
    pollInFlight = false;
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
    logDiagnostic("auto-retry", `Retrying connection in ${Math.round(AUTO_RETRY_MS / 1000)} seconds`);
  }
}

function clearRetry() {
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = null;
}

async function fetchStatus(serverUrl) {
  if (window.ajrmPlayer?.fetchStatus) {
    return unwrapPlayerResult(await window.ajrmPlayer.fetchStatus(serverUrl));
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
  if (!audioUrl) {
    logDiagnostic("announcement-skipped", "Announcement has no audio URL", {
      message: announcement.message || "",
    });
    return false;
  }
  const key = announcementKey(announcement);
  if (!force && (seenKeys.includes(key) || pendingKeys.has(key))) {
    return false;
  }
  if (!force) pendingKeys.add(key);
  const absoluteAudioUrl = absoluteUrl(settings.serverUrl, audioUrl);
  const item = {
    key,
    audioUrl: absoluteAudioUrl,
    playbackUrl: "",
    message: String(announcement.message || ""),
    receivedAt: new Date().toISOString(),
  };
  if (isSoundCheckAnnouncement(item.message)) {
    settings.soundCheckMessage = item.message;
    saveSettings(settings);
  }
  queue.push(item);
  lastAnnouncement = item;
  history.unshift(item);
  history = history.slice(0, MAX_HISTORY);
  logDiagnostic("announcement-queued", item.message, {
    queueLength: queue.length,
    force,
  });
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
  currentItem = item;
  els.nowPlaying.textContent = item.message;
  els.nowPlaying.classList.remove("muted");
  logDiagnostic("download-start", item.message);
  try {
    els.audio.src = await resolveAudioUrl(item);
    cacheSoundCheckIfNeeded(item);
    logDiagnostic("download-ok", item.message);
  } catch (error) {
    logDiagnostic("download-failed", formatErrorMessage(error), {
      message: item.message,
    });
    schedulePlaybackRetry(item, `Audio download failed: ${formatErrorMessage(error)}`);
    currentItem = null;
    playing = false;
    renderState();
    return;
  }
  logDiagnostic("playback-start", item.message);
  els.audio.play().catch((error) => {
    logDiagnostic("playback-rejected", error.message || String(error), {
      message: item.message,
    });
    schedulePlaybackRetry(item, `Playback needs user interaction or an available output device: ${error.message || error}`);
    currentItem = null;
    playing = false;
    renderState();
  });
  renderState();
}

function playCachedSoundCheck() {
  if (!settings.soundCheckDataUrl) {
    setMessage("No cached Sound Check audio yet. Run Sound Check from AJRM Marine Audio once while this player is connected.");
    logDiagnostic("sound-check-missing", "No cached Sound Check audio is available");
    return;
  }
  const item = {
    key: `local-sound-check:${Date.now()}`,
    audioUrl: "",
    playbackUrl: settings.soundCheckDataUrl,
    message: settings.soundCheckMessage || "Sound Check. Testing 1, 2, 3.",
    receivedAt: new Date().toISOString(),
  };
  if (playing) {
    els.audio.pause();
    playing = false;
  }
  queue.unshift(item);
  setMessage("Playing cached Sound Check.");
  logDiagnostic("sound-check", "Playing cached Sound Check");
  playNext();
}

async function resolveAudioUrl(item) {
  if (item.playbackUrl) return item.playbackUrl;
  if (window.ajrmPlayer?.fetchAudioDataUrl) {
    item.playbackUrl = unwrapPlayerResult(await window.ajrmPlayer.fetchAudioDataUrl(item.audioUrl));
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
  const summary = [
    status.version || "-",
    status.muted === true ? "muted" : "unmuted",
    status.pluginMuted === true ? "plugin-muted" : "plugin-unmuted",
    status.engineMuted === true ? "traffic-muted" : "traffic-unmuted",
    `recent:${status.recentAnnouncements?.length || 0}`,
  ].join("|");
  if (lastStatusSummary && lastStatusSummary !== summary) {
    logDiagnostic("status-change", "Audio status changed", {
      version: status.version || "",
      muted: status.muted === true,
      pluginMuted: status.pluginMuted === true,
      trafficMuted: status.engineMuted === true,
      recentAnnouncements: status.recentAnnouncements?.length || 0,
    });
  }
  lastStatusSummary = summary;
}

function renderState() {
  els.connectionPill.textContent = connecting
    ? "Connecting"
    : connected
      ? statusFailureCount > 0
        ? "Status delayed"
        : muted
        ? "Muted"
        : "Connected"
      : "Disconnected";
  els.connectionPill.className = `pill ${connecting ? "warn" : connected ? (muted || statusFailureCount > 0 ? "warn" : "good") : "bad"}`;
  els.connectButton.disabled = connecting || connected;
  els.disconnectButton.disabled = !connected;
  els.soundCheckButton.disabled = !settings.soundCheckDataUrl;
  els.muteButton.textContent = muted ? "Unmute" : "Mute";
  els.queueLength.textContent = String(queue.length);
  if (!playing && !queue.length) {
    els.nowPlaying.textContent = "No announcement playing.";
    els.nowPlaying.classList.add("muted");
  }
}

function cacheSoundCheckIfNeeded(item) {
  if (!item?.playbackUrl || !isSoundCheckAnnouncement(item.message)) return;
  settings.soundCheckDataUrl = item.playbackUrl;
  settings.soundCheckMessage = item.message;
  settings.soundCheckCachedAt = new Date().toISOString();
  saveSettings(settings);
  renderState();
}

function isSoundCheckAnnouncement(message) {
  return /\bsound\s*check\b/i.test(String(message || ""));
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

function unwrapPlayerResult(result) {
  if (!result || result.ok !== false) {
    return result && Object.prototype.hasOwnProperty.call(result, "value")
      ? result.value
      : result;
  }
  const error = new Error(result.error || "Audio player request failed.");
  if (result.code) error.code = result.code;
  throw error;
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

function releasePending(item) {
  if (item?.key) pendingKeys.delete(item.key);
}

function schedulePlaybackRetry(item, reason) {
  if (!item) return;
  if (!connected || seenKeys.includes(item.key)) {
    releasePending(item);
    return;
  }
  item.retryCount = Number(item.retryCount || 0) + 1;
  logDiagnostic("playback-retry", reason, {
    message: item.message,
    retryCount: item.retryCount,
  });
  setMessage(`${reason} Retrying in ${Math.round(PLAYBACK_RETRY_MS / 1000)} seconds.`);
  const timer = window.setTimeout(() => {
    playbackRetryTimers.delete(timer);
    if (!connected || seenKeys.includes(item.key)) {
      releasePending(item);
      renderState();
      return;
    }
    queue.unshift(item);
    renderState();
    playNext();
  }, PLAYBACK_RETRY_MS);
  playbackRetryTimers.add(timer);
}

function logDiagnostic(type, message, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message: String(message || ""),
    details,
  };
  diagnostics.unshift(entry);
  diagnostics = diagnostics.slice(0, MAX_DIAGNOSTICS);
  renderDiagnostics();
  window.ajrmPlayer?.logEvent?.(entry).catch(() => {});
}

function renderDiagnostics() {
  if (!els.diagnostics) return;
  els.diagnostics.innerHTML = diagnostics.length
    ? diagnostics
        .map((item) => {
          const detailText = item.details && Object.keys(item.details).length
            ? ` ${JSON.stringify(item.details)}`
            : "";
          return `<li><strong>${escapeHtml(new Date(item.time).toLocaleTimeString())}</strong> ${escapeHtml(item.type)}: ${escapeHtml(item.message)}${escapeHtml(detailText)}</li>`;
        })
        .join("")
    : "";
}

function clearPlaybackRetryTimers() {
  for (const timer of playbackRetryTimers) window.clearTimeout(timer);
  playbackRetryTimers = new Set();
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
window.ajrmPlayer?.diagnosticLogPath?.().then((logPath) => {
  if (els.logPath) els.logPath.textContent = logPath || "-";
  logDiagnostic("startup", "Audio player started", { logPath });
});
