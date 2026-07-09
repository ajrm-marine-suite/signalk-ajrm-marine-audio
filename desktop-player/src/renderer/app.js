"use strict";

const STORAGE_KEY = "ajrmMarineAudioPlayer.settings";
const POLL_MS = 1500;
const AUTO_RETRY_MS = 60000;
const PLAYBACK_RETRY_MS = 3000;
const AUDIO_URL_WAIT_MS = 15000;
const DEFAULT_KEEP_ALIVE_SECONDS = 60;
const MIN_KEEP_ALIVE_SECONDS = 10;
const MAX_KEEP_ALIVE_SECONDS = 3600;
const KEEP_ALIVE_DATA_URL = createKeepAliveDataUrl();
const AUDIBLE_KEEP_ALIVE_DATA_URL = createKeepAliveDataUrl({ audible: true });
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
  keepAliveEnabled: document.getElementById("keepAliveEnabled"),
  keepAliveSeconds: document.getElementById("keepAliveSeconds"),
  keepAliveAudible: document.getElementById("keepAliveAudible"),
  keepAliveVolume: document.getElementById("keepAliveVolume"),
  keepAliveVolumeValue: document.getElementById("keepAliveVolumeValue"),
  volume: document.getElementById("volume"),
  volumeValue: document.getElementById("volumeValue"),
  audio: document.getElementById("audio"),
  keepAliveAudio: document.getElementById("keepAliveAudio"),
  connectionPill: document.getElementById("connectionPill"),
  nowPlaying: document.getElementById("nowPlaying"),
  pluginVersion: document.getElementById("pluginVersion"),
  serverTime: document.getElementById("serverTime"),
  desktopOutput: document.getElementById("desktopOutput"),
  queueLength: document.getElementById("queueLength"),
  lastPoll: document.getElementById("lastPoll"),
  logPath: document.getElementById("logPath"),
  announcements: document.getElementById("announcements"),
  diagnostics: document.getElementById("diagnostics"),
  message: document.getElementById("message"),
};
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));

let pollTimer = null;
let retryTimer = null;
let keepAliveTimer = null;
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
let waitingForAudioUrl = new Map();
let playbackRetryTimers = new Set();
let lastAnnouncement = null;
let currentItem = null;
let diagnostics = [];
let lastStatusSummary = "";
let statusFailureMessageActive = false;

const settings = loadSettings();
els.serverUrl.value = settings.serverUrl || "http://localhost:3000";
els.autoConnect.checked = Boolean(settings.autoConnect);
els.keepAliveEnabled.checked = settings.keepAliveEnabled !== false;
els.keepAliveAudible.checked = settings.keepAliveAudible === true;
settings.keepAliveSeconds = clampKeepAliveSeconds(settings.keepAliveSeconds);
els.keepAliveSeconds.value = String(settings.keepAliveSeconds);
settings.keepAliveVolume = clampPercent(settings.keepAliveVolume, 50);
els.keepAliveVolume.value = String(settings.keepAliveVolume);
els.volume.value = String(settings.volume ?? 100);
els.audio.volume = Number(els.volume.value) / 100;
els.keepAliveAudio.volume = settings.keepAliveVolume / 100;
renderVolume();
renderState();
configureKeepAliveTimer();

els.connectButton.addEventListener("click", () => connect({ automatic: false }));
els.disconnectButton.addEventListener("click", disconnect);
for (const button of tabButtons) {
  button.addEventListener("click", () => selectTab(button.dataset.tab));
}
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
els.keepAliveEnabled.addEventListener("change", () => {
  settings.keepAliveEnabled = els.keepAliveEnabled.checked;
  saveSettings(settings);
  configureKeepAliveTimer();
  logDiagnostic(
    "keep-alive-setting",
    settings.keepAliveEnabled ? "Bluetooth keep-alive enabled" : "Bluetooth keep-alive disabled",
    { seconds: settings.keepAliveSeconds },
  );
});
els.keepAliveSeconds.addEventListener("input", applyKeepAliveIntervalInput);
els.keepAliveSeconds.addEventListener("change", applyKeepAliveIntervalInput);
function applyKeepAliveIntervalInput() {
  settings.keepAliveSeconds = clampKeepAliveSeconds(els.keepAliveSeconds.value);
  els.keepAliveSeconds.value = String(settings.keepAliveSeconds);
  saveSettings(settings);
  configureKeepAliveTimer();
  logDiagnostic("keep-alive-setting", "Bluetooth keep-alive interval changed", {
    seconds: settings.keepAliveSeconds,
  });
}
els.keepAliveAudible.addEventListener("change", () => {
  settings.keepAliveAudible = els.keepAliveAudible.checked;
  if (settings.keepAliveAudible && !settings.keepAliveEnabled) {
    settings.keepAliveEnabled = true;
    els.keepAliveEnabled.checked = true;
  }
  saveSettings(settings);
  configureKeepAliveTimer();
  logDiagnostic(
    "keep-alive-setting",
    settings.keepAliveAudible ? "Bluetooth keep-alive audible test enabled" : "Bluetooth keep-alive audible test disabled",
    {
      seconds: settings.keepAliveSeconds,
      enabled: settings.keepAliveEnabled,
    },
  );
  if (settings.keepAliveAudible) {
    playKeepAlivePulse({ force: true });
  }
});
els.keepAliveVolume.addEventListener("input", () => {
  settings.keepAliveVolume = clampPercent(els.keepAliveVolume.value, 50);
  els.keepAliveVolume.value = String(settings.keepAliveVolume);
  els.keepAliveAudio.volume = settings.keepAliveVolume / 100;
  saveSettings(settings);
  renderVolume();
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

function selectTab(tabName) {
  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.tab === tabName);
  }
  for (const panel of tabPanels) {
    const active = panel.dataset.tabPanel === tabName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  }
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
  waitingForAudioUrl = new Map();
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
  waitingForAudioUrl = new Map();
  queue = [];
  playing = false;
  statusFailureMessageActive = false;
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
    const recoveredFromStatusFailure = statusFailureCount > 0 || statusFailureMessageActive;
    statusFailureCount = 0;
    renderStatus(status);
    const announcements = status.recentAnnouncements?.length
      ? status.recentAnnouncements
      : [status.lastAnnouncement].filter(Boolean);
    if (status.desktopPlayerOutput === false) {
      for (const item of announcements) rememberSeen(announcementKey(item));
      clearAutomaticAnnouncements("Desktop Player output is disabled in AJRM Marine Audio.");
      setMessage("Desktop Player output is disabled in AJRM Marine Audio.");
      statusFailureMessageActive = false;
      els.lastPoll.textContent = new Date().toLocaleTimeString();
      renderState();
      return true;
    }
    if (markExistingSeen) {
      if (announcements.length) {
        logDiagnostic("connect-seen", `Marked ${announcements.length} existing announcement(s) as already seen on connect`);
      }
      for (const item of announcements) rememberSeen(announcementKey(item));
      setMessage("Connected. Waiting for new announcements.");
      statusFailureMessageActive = false;
    } else {
      for (const item of announcements) enqueue(item);
      if (recoveredFromStatusFailure && statusFailureMessageActive) {
        setMessage("Audio status poll recovered.");
        logDiagnostic("status-recovered", "Audio status polling recovered");
        statusFailureMessageActive = false;
      }
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
    statusFailureMessageActive = true;
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

function configureKeepAliveTimer() {
  if (keepAliveTimer) window.clearTimeout(keepAliveTimer);
  keepAliveTimer = null;
  if (!settings.keepAliveEnabled) return;
  scheduleNextKeepAlivePulse();
}

function scheduleNextKeepAlivePulse() {
  if (keepAliveTimer) window.clearTimeout(keepAliveTimer);
  keepAliveTimer = null;
  if (!settings.keepAliveEnabled) return;
  const seconds = clampKeepAliveSeconds(settings.keepAliveSeconds);
  settings.keepAliveSeconds = seconds;
  els.keepAliveSeconds.value = String(seconds);
  keepAliveTimer = window.setTimeout(() => {
    keepAliveTimer = null;
    playKeepAlivePulse();
    scheduleNextKeepAlivePulse();
  }, seconds * 1000);
  logDiagnostic("keep-alive-armed", "Bluetooth keep-alive timer armed", {
    seconds,
    milliseconds: seconds * 1000,
    audible: settings.keepAliveAudible === true,
  });
}

function playKeepAlivePulse({ force = false } = {}) {
  if ((!force && !settings.keepAliveEnabled) || playing) return;
  els.keepAliveAudio.pause();
  els.keepAliveAudio.currentTime = 0;
  els.keepAliveAudio.volume = clampPercent(settings.keepAliveVolume, 50) / 100;
  els.keepAliveAudio.src = settings.keepAliveAudible
    ? AUDIBLE_KEEP_ALIVE_DATA_URL
    : KEEP_ALIVE_DATA_URL;
  els.keepAliveAudio.play().then(() => {
    logDiagnostic("keep-alive", settings.keepAliveAudible
      ? "Sent audible Bluetooth keep-alive test pulse"
      : "Sent Bluetooth keep-alive pulse", {
      seconds: settings.keepAliveSeconds,
      audible: settings.keepAliveAudible === true,
      volume: clampPercent(settings.keepAliveVolume, 50),
    });
  }).catch((error) => {
    logDiagnostic("keep-alive-failed", error.message || String(error));
  });
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
    waitForAnnouncementAudioUrl(announcement);
    return false;
  }
  releaseWaitingForAudioUrl(announcement);
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
    manual: force === true,
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

function waitForAnnouncementAudioUrl(announcement) {
  const key = announcementWaitKey(announcement);
  const now = Date.now();
  const existing = waitingForAudioUrl.get(key);
  if (existing?.expired) return;
  if (!existing) {
    waitingForAudioUrl.set(key, {
      firstSeenAt: now,
      lastSeenAt: now,
      message: String(announcement.message || ""),
      polls: 1,
      expired: false,
    });
    logDiagnostic("announcement-waiting-audio-url", "Announcement is waiting for generated audio URL", {
      message: announcement.message || "",
      waitSeconds: Math.round(AUDIO_URL_WAIT_MS / 1000),
    });
    return;
  }
  existing.lastSeenAt = now;
  existing.polls += 1;
  if (now - existing.firstSeenAt < AUDIO_URL_WAIT_MS) return;
  existing.expired = true;
  logDiagnostic("announcement-skipped", "Announcement still has no audio URL after wait window", {
    message: existing.message,
    polls: existing.polls,
    waitedMs: now - existing.firstSeenAt,
  });
}

function releaseWaitingForAudioUrl(announcement) {
  const key = announcementWaitKey(announcement);
  const existing = waitingForAudioUrl.get(key);
  if (!existing) return;
  waitingForAudioUrl.delete(key);
  if (!existing.expired) {
    logDiagnostic("announcement-audio-url-ready", "Announcement audio URL became available", {
      message: announcement.message || "",
      waitedMs: Date.now() - existing.firstSeenAt,
      polls: existing.polls,
    });
  }
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
    manual: true,
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
  if (els.desktopOutput) {
    els.desktopOutput.textContent = status.desktopPlayerOutput === false
      ? "Disabled by Audio"
      : status.desktopPlayerOutputAvailable === false
        ? `Unavailable${status.desktopPlayerOutputUnavailableReason ? `: ${status.desktopPlayerOutputUnavailableReason}` : ""}`
        : "Enabled";
  }
  const summary = [
    status.version || "-",
    status.muted === true ? "muted" : "unmuted",
    status.pluginMuted === true ? "plugin-muted" : "plugin-unmuted",
    status.trafficMuted === true ? "traffic-muted" : "traffic-unmuted",
    status.desktopPlayerOutput === false ? "desktop-off" : "desktop-on",
    `recent:${status.recentAnnouncements?.length || 0}`,
  ].join("|");
  if (lastStatusSummary && lastStatusSummary !== summary) {
    logDiagnostic("status-change", "Audio status changed", {
      version: status.version || "",
      muted: status.muted === true,
      pluginMuted: status.pluginMuted === true,
      trafficMuted: status.trafficMuted === true,
      desktopPlayerOutput: status.desktopPlayerOutput !== false,
      recentAnnouncements: status.recentAnnouncements?.length || 0,
    });
  }
  lastStatusSummary = summary;
}

function clearAutomaticAnnouncements(message) {
  for (const item of queue) {
    if (!item.manual) releasePending(item);
  }
  queue = queue.filter((item) => item.manual);
  for (const [key, waiting] of waitingForAudioUrl.entries()) {
    logDiagnostic("announcement-disabled", message, {
      message: waiting.message || "",
    });
    waitingForAudioUrl.delete(key);
  }
  if (currentItem && !currentItem.manual) {
    releasePending(currentItem);
    els.audio.pause();
    currentItem = null;
    playing = false;
  }
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
  els.keepAliveVolumeValue.textContent = `${els.keepAliveVolume.value}%`;
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

function announcementWaitKey(announcement) {
  return String(
    announcement?.playbackId ||
      announcement?.requestId ||
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

function clampKeepAliveSeconds(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_KEEP_ALIVE_SECONDS;
  return Math.min(MAX_KEEP_ALIVE_SECONDS, Math.max(MIN_KEEP_ALIVE_SECONDS, number));
}

function clampPercent(value, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(0, number));
}

function createKeepAliveDataUrl({ audible = false } = {}) {
  const sampleRate = 8000;
  const seconds = audible ? 0.3 : 0.25;
  const samples = Math.floor(sampleRate * seconds);
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples; index += 1) {
    const sample = audible
      ? Math.round(Math.sin((2 * Math.PI * 880 * index) / sampleRate) * 2600)
      : 0;
    view.setInt16(44 + index * 2, sample, true);
  }
  return `data:audio/wav;base64,${arrayBufferToBase64(buffer)}`;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
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
