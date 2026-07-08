window.__ajrmMarineAudioAppStarted = true;

const API = "/signalk/v1/api/ajrmMarineAudio";
const LOGIN_URL = "/admin/#/login";
const LOGIN_STATUS_URLS = ["/skServer/loginStatus", "/loginStatus"];
const ACCESS_REQUEST_URL = "/signalk/v1/access/requests";
const ACCESS_TOKEN_STORAGE_KEY = "ajrmMarineAudio.accessToken";
const ACCESS_REQUEST_STORAGE_KEY = "ajrmMarineAudio.accessRequestHref";
const CLIENT_ID_STORAGE_KEY = "ajrmMarineAudio.clientId";
const BROWSER_OUTPUT_STORAGE_KEY = "ajrmMarineAudio.browserOutput";
const BROWSER_OUTPUT_MODE_STORAGE_KEY = "ajrmMarineAudio.browserOutputMode";
const BROWSER_MUTE_STORAGE_KEY = "ajrmMarineAudio.browserMuted";
const LEGACY_BROWSER_SPEECH_STORAGE_KEYS = ["checkBrowserSpeech"];
const BROWSER_OUTPUT_MODES = ["off", "speech", "piper"];
const SOUND_CHECK_MESSAGE = "Sound Check. Testing 1, 2, 3.";
const CONSOLE_AUDIO_HOSTED =
  new URLSearchParams(window.location.search).get("consoleAudioHost") === "1";
const STATUS_REFRESH_MS = CONSOLE_AUDIO_HOSTED ? 10000 : 5000;
const STATUS_AUTH_RETRY_MS = 60000;
const REQUEST_TIMEOUT_MS = 8000;
const statusPill = document.getElementById("statusPill");
const queueLength = document.getElementById("queueLength");
const renderedCount = document.getElementById("renderedCount");
const filteredCount = document.getElementById("filteredCount");
const streamCount = document.getElementById("streamCount");
const droppedStreamCount = document.getElementById("droppedStreamCount");
const serverTime = document.getElementById("serverTime");
const streamConnectedTotal = document.getElementById("streamConnectedTotal");
const streamDisconnectedTotal = document.getElementById("streamDisconnectedTotal");
const lastAnnouncement = document.getElementById("lastAnnouncement");
const lastAudio = document.getElementById("lastAudio");
const streamUrl = document.getElementById("streamUrl");
const streamStatus = document.getElementById("streamStatus");
const streamDiagnostics = document.getElementById("streamDiagnostics");
const events = document.getElementById("events");
const checkPingEnabled = document.getElementById("checkPingEnabled");
const browserOutputModeInputs = Array.from(
  document.querySelectorAll('input[name="browserOutputMode"]'),
);
const browserOutputPiper = document.getElementById("browserOutputPiper");
const checkDesktopPlayerOutput = document.getElementById("checkDesktopPlayerOutput");
const checkPiOutput = document.getElementById("checkPiOutput");
const checkStreamOutput = document.getElementById("checkStreamOutput");
const checkMuteAll = document.getElementById("checkMuteAll");
const outputStatus = document.getElementById("outputStatus");
const dependencyPanel = document.getElementById("dependencyPanel");
const dependencyStatus = document.getElementById("dependencyStatus");
const buttonInstallPiper = document.getElementById("buttonInstallPiper");
const buttonRestartStreams = document.getElementById("buttonRestartStreams");
const buttonStreamTimeCheck = document.getElementById("buttonStreamTimeCheck");
const voiceSelect = document.getElementById("voiceSelect");
const voiceStatus = document.getElementById("voiceStatus");
const aplayVolumeRange = document.getElementById("aplayVolumeRange");
const aplayVolumeValue = document.getElementById("aplayVolumeValue");
const aplayVolumeStatus = document.getElementById("aplayVolumeStatus");
let accessToken = readStoredValue(ACCESS_TOKEN_STORAGE_KEY);
let accessRequestTimer = null;
let localNotice = null;
let browserOutputMode = initialBrowserOutputMode();
let browserMuted = readStoredValue(BROWSER_MUTE_STORAGE_KEY) === "true";
let lastBrowserAudioUrl = "";
let lastBrowserSpeechKey = "";
let lastStatus = null;
let nextStatusRefreshAt = 0;
let firstStatusRender = true;

window.addEventListener("error", (event) => {
  renderStartupError(event.message || "AJRM Marine Audio browser script failed");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason || {};
  renderStartupError(reason.message || String(reason) || "AJRM Marine Audio request failed");
});

bindSoundCheckButton();
bindRepeatLastButton();
bindCommandButton("buttonClearQueue", "clear-queue", "Clear queue sent.");
bindStreamCommandButton("buttonRestartStreams", "restart-streams", "Restart streams sent.");
bindStreamCommandButton("buttonStreamTimeCheck", "stream-time-check", "Stream time check sent.");
buttonInstallPiper.addEventListener("click", installPiperWithPiController);
checkPingEnabled.addEventListener("change", () => {
  if (checkPingEnabled.disabled) {
    renderPingControl(lastStatus);
    return;
  }
  postJson(`ping-enabled?enabled=${checkPingEnabled.checked ? "true" : "false"}`).catch(
    renderCommandError,
  );
});
for (const input of browserOutputModeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    if (input.value === "piper" && input.disabled) {
      renderBrowserOutputMode();
      outputStatus.textContent =
        "Piper browser playback is unavailable until Piper, a voice model, and FFmpeg are installed.";
      return;
    }
    browserOutputMode = normalizeBrowserOutputMode(input.value);
    saveBrowserOutputMode(browserOutputMode);
    renderPingControl(lastStatus);
    disableCompetingBrowserSpeech();
    outputStatus.textContent = browserOutputModeStatusText(browserOutputMode);
    if (CONSOLE_AUDIO_HOSTED && browserOutputMode !== "off") {
      outputStatus.textContent += " Console will play browser audio while embedded.";
      return;
    }
    if (browserOutputMode === "piper" && lastAudio.getAttribute("src")) {
      playLastAudioInBrowser(true);
    } else if (browserOutputMode === "speech") {
      speakLastAnnouncementInBrowser(true);
    } else {
      stopBrowserOutputs();
    }
  });
}
checkPiOutput.addEventListener("change", saveOutputRouting);
checkDesktopPlayerOutput.addEventListener("change", saveOutputRouting);
checkStreamOutput.addEventListener("change", saveOutputRouting);
checkMuteAll.addEventListener("change", () => {
  browserMuted = checkMuteAll.checked;
  writeStoredValue(BROWSER_MUTE_STORAGE_KEY, browserMuted ? "true" : "false");
  if (browserMuted) stopBrowserOutputs();
  renderOutputRouting(lastStatus || {});
});
voiceSelect.addEventListener("change", saveVoiceSelection);
aplayVolumeRange.addEventListener("input", () => {
  renderAplayVolumeValue(aplayVolumeRange.value);
});
aplayVolumeRange.addEventListener("change", () => {
  postJson(`aplay-volume?volume=${encodeURIComponent(aplayVolumeRange.value)}`).catch(
    renderCommandError,
  );
});

refresh({ force: true });
resumeAccessRequestPolling();
setInterval(() => refresh(), STATUS_REFRESH_MS);

async function refresh({ force = false } = {}) {
  if (!force && Date.now() < nextStatusRefreshAt) return;
  try {
    const status = await getStatusJson();
    nextStatusRefreshAt = 0;
    renderStatus(status);
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      nextStatusRefreshAt = Date.now() + STATUS_AUTH_RETRY_MS;
    }
    statusPill.textContent = "Offline";
    statusPill.className = "status-pill bad";
    renderEvents([{ event: "error", message: audioOfflineMessage(error), ts: new Date().toISOString() }]);
  }
}

async function getStatusJson() {
  const response = await fetchWithTimeout(`${API}/status`, {
    credentials: "include",
    cache: "no-store",
    headers: authHeaders(),
  });
  return readStatusResponse(response);
}

async function getJson(path) {
  const response = await fetchWithTimeout(`${API}/${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: authHeaders(),
  });
  return readResponse(response, path);
}

async function readStatusResponse(response) {
  const text = await response.text();
  const body = text ? parseJson(text) : {};
  if (!response.ok) {
    if (response.status === 401 && accessToken) {
      accessToken = "";
      removeStoredValue(ACCESS_TOKEN_STORAGE_KEY);
    }
    const message =
      response.status === 401 || response.status === 403
        ? "AJRM Marine Audio needs a Signal K login or approved device token."
        : body.error || `status failed: ${friendlyHttpError(response.status, text)}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function audioOfflineMessage(error) {
  const message = String(error?.message || error || "Audio status request failed");
  if (/HTTP 404|Cannot GET|not found/i.test(message)) {
    return `${message}. AJRM Marine Audio is installed but its Signal K plugin route is not active; enable the AJRM Marine Audio plugin and restart Signal K.`;
  }
  if (/HTTP 401|HTTP 403|read\/write|admin|access/i.test(message)) {
    return message;
  }
  return `${message}. Check that the AJRM Marine Audio plugin is enabled and Signal K has restarted.`;
}

async function postJson(path, body = null) {
  const response = await fetchWithTimeout(`${API}/${path}`, {
    credentials: "include",
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  await readResponse(response, path);
  await refresh({ force: true });
}

function bindCommandButton(id, path, message) {
  const button = document.getElementById(id);
  button.addEventListener("click", () => {
    signalCommandButton(button, message);
    postJson(path).catch(renderCommandError);
  });
}

function bindSoundCheckButton() {
  const button = document.getElementById("buttonSoundCheck");
  button.addEventListener("click", () => {
    if (!hasSoundCheckOutput()) {
      outputStatus.textContent =
        "No audio output is selected. Choose browser speech, server speaker, or radio stream first.";
      return;
    }
    if (browserOutputMode === "speech" && !hasServerRenderedOutput()) {
      if (speakMessageInBrowser(SOUND_CHECK_MESSAGE, true)) {
        lastBrowserSpeechKey = `${SOUND_CHECK_MESSAGE}:sound-check`;
      }
      return;
    }
    signalCommandButton(button, "Sound check sent.");
    postJson("sound-check").catch(renderCommandError);
  });
}

function hasSoundCheckOutput() {
  if (browserOutputMode === "speech") return true;
  return hasServerRenderedOutput();
}

function hasServerRenderedOutput() {
  if (
    browserOutputMode === "piper" &&
    lastStatus?.dependencies?.piperPlaybackAvailable === true
  ) {
    return true;
  }
  if (lastStatus?.localPlayback === true && lastStatus?.localPlaybackAvailable === true) {
    return true;
  }
  if (
    lastStatus?.liveStream === true &&
    lastStatus?.dependencies?.piperPlaybackAvailable === true
  ) {
    return true;
  }
  return false;
}

function bindRepeatLastButton() {
  const button = document.getElementById("buttonRepeatLast");
  button.addEventListener("click", () => {
    if (browserOutputMode === "speech" && !hasServerRenderedOutput()) {
      if (!speakLastAnnouncementInBrowser(true)) {
        outputStatus.textContent = "No announcement has been received yet.";
      }
      return;
    }
    if (browserOutputMode === "piper" && !hasServerRenderedOutput()) {
      playLastAudioInBrowser(true);
      return;
    }
    if (!hasServerRenderedOutput()) {
      outputStatus.textContent =
        "No audio output is selected. Choose browser speech, server speaker, or radio stream first.";
      return;
    }
    signalCommandButton(button, "Repeat last sent.");
    postJson("repeat-last").catch(renderCommandError);
  });
}

function bindStreamCommandButton(id, path, message) {
  const button = document.getElementById(id);
  button.addEventListener("click", () => {
    if (!isRadioStreamUsable(lastStatus)) {
      outputStatus.textContent =
        "Radio stream is off or unavailable. Enable radio stream output after Piper, a voice model, and FFmpeg are installed.";
      return;
    }
    signalCommandButton(button, message);
    postJson(path).catch(renderCommandError);
  });
}

function signalCommandButton(button, message) {
  button.classList.remove("command-sent");
  void button.offsetWidth;
  button.classList.add("command-sent");
  outputStatus.textContent = message;
  window.setTimeout(() => button.classList.remove("command-sent"), 700);
}

async function readResponse(response, path) {
  const text = await response.text();
  const body = text ? parseJson(text) : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw await audioAccessError(response.status, body, text);
    }
    throw new Error(body.error || `${path} failed: ${friendlyHttpError(response.status, text)}`);
  }
  return body;
}

function renderStatus(status) {
  lastStatus = status;
  statusPill.textContent = status.muted ? "Muted" : status.enabled ? "Ready" : "Disabled";
  statusPill.className = `status-pill ${status.muted || !status.enabled ? "warn" : "good"}`;
  const stats = status.stats || {};
  const streamStats = status.streamStats || {};
  queueLength.textContent = status.queueLength != null ? status.queueLength : 0;
  renderedCount.textContent = stats.rendered != null ? stats.rendered : 0;
  filteredCount.textContent = stats.filtered != null ? stats.filtered : 0;
  streamCount.textContent = status.liveStreamClients != null ? status.liveStreamClients : 0;
  droppedStreamCount.textContent = status.droppedLaggingClients != null ? status.droppedLaggingClients : 0;
  serverTime.textContent = formatTime(status.serverTime);
  streamConnectedTotal.textContent = streamStats.connectedTotal != null ? streamStats.connectedTotal : 0;
  streamDisconnectedTotal.textContent = streamStats.disconnectedTotal != null ? streamStats.disconnectedTotal : 0;
  renderOutputRouting(status);
  renderPingControl(status);
  renderDependencies(status.dependencies || null);
  renderVoiceSelector(status);
  renderAplayVolumeControl(status);
  renderRadioStreamPanel(status);
  streamDiagnostics.textContent = formatStreamDiagnostics(status);

  if (status.lastAnnouncement && status.lastAnnouncement.message) {
    lastAnnouncement.classList.remove("muted");
    lastAnnouncement.textContent = status.lastAnnouncement.message;
    const announcementAudioUrl =
      status.lastAnnouncement.audioUrl || status.lastAnnouncement.publicAudioUrl;
    if (announcementAudioUrl) {
      lastAudio.hidden = false;
      if (lastAudio.getAttribute("src") !== announcementAudioUrl) {
        lastAudio.setAttribute("src", announcementAudioUrl);
        playBrowserAnnouncement(false, status.lastAnnouncement);
      }
    } else {
      lastAudio.hidden = true;
      lastAudio.removeAttribute("src");
    }
  } else {
    lastAnnouncement.classList.add("muted");
    lastAnnouncement.textContent = "No announcement received yet.";
    lastAudio.hidden = true;
    lastAudio.removeAttribute("src");
  }

  renderEvents(status.recentEvents || []);
  firstStatusRender = false;
}

async function saveOutputRouting() {
  try {
    outputStatus.textContent = "Saving output routing…";
    await postJson("outputs", {
      desktopPlayerOutput: checkDesktopPlayerOutput.checked,
      localPlayback: checkPiOutput.checked,
      liveStream: checkStreamOutput.checked,
    });
  } catch (error) {
    renderCommandError(error);
  }
}

async function saveVoiceSelection() {
  if (!voiceSelect.value) return;
  try {
    voiceSelect.disabled = true;
    voiceStatus.textContent = "Saving Piper voice...";
    const result = await postJson("voice", { voice: voiceSelect.value });
    renderStatus(result.status || lastStatus);
    voiceStatus.textContent = `Piper voice set to ${voiceSelect.value}.`;
  } catch (error) {
    renderCommandError(error);
  } finally {
    voiceSelect.disabled = false;
  }
}

function renderVoiceSelector(status) {
  const voices = Array.isArray(status.voices) ? status.voices : [];
  const selected = voices.find((voice) => voice.selected) || null;
  const currentValue = voiceSelect.value;
  const shouldKeepFocusValue = document.activeElement === voiceSelect && currentValue;
  voiceSelect.innerHTML = "";
  if (!voices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No installed voices found";
    voiceSelect.appendChild(option);
    voiceSelect.disabled = true;
    voiceStatus.textContent = "No Piper voice models found in the configured voices directory.";
    return;
  }
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.id;
    voiceSelect.appendChild(option);
  }
  voiceSelect.disabled = false;
  voiceSelect.value = shouldKeepFocusValue ? currentValue : selected?.id || voices[0].id;
  const selectedVoice = voices.find((voice) => voice.id === voiceSelect.value) || selected;
  voiceStatus.textContent = selectedVoice
    ? `Using ${selectedVoice.id}.`
    : `${voices.length} Piper voice${voices.length === 1 ? "" : "s"} installed.`;
}

function renderOutputRouting(status) {
  disableCompetingBrowserSpeech();
  const piperPlaybackAvailable = status.dependencies?.piperPlaybackAvailable === true;
  if (browserOutputMode === "piper" && !piperPlaybackAvailable) {
    browserOutputMode = "off";
    saveBrowserOutputMode(browserOutputMode);
    stopBrowserOutputs();
  }
  renderBrowserOutputMode();
  renderPingControl(status);
  browserOutputPiper.disabled = !piperPlaybackAvailable;
  browserOutputPiper.title = piperPlaybackAvailable
    ? ""
    : "Piper browser playback needs Piper, a voice model, and FFmpeg on the Signal K server.";
  if (document.activeElement !== checkPiOutput) {
    checkPiOutput.checked = status.localPlayback !== false;
  }
  if (document.activeElement !== checkDesktopPlayerOutput) {
    checkDesktopPlayerOutput.checked = status.desktopPlayerOutput !== false;
  }
  const desktopPlayerAvailable = status.desktopPlayerOutputAvailable === true;
  checkDesktopPlayerOutput.disabled = !desktopPlayerAvailable && !checkDesktopPlayerOutput.checked;
  checkDesktopPlayerOutput.title =
    desktopPlayerAvailable || checkDesktopPlayerOutput.checked
      ? ""
      : status.desktopPlayerOutputUnavailableReason ||
        "Desktop Player output needs Piper, a voice model, and FFmpeg on the Signal K server.";
  const serverSpeakerAvailable = status.localPlaybackAvailable === true;
  checkPiOutput.disabled = !serverSpeakerAvailable && !checkPiOutput.checked;
  checkPiOutput.title =
    serverSpeakerAvailable || checkPiOutput.checked
      ? ""
      : status.localPlaybackUnavailableReason ||
        "Server speaker output needs Piper, a voice model, and a local audio player.";
  if (document.activeElement !== checkStreamOutput) {
    checkStreamOutput.checked = status.liveStream !== false;
  }
  checkStreamOutput.disabled = !piperPlaybackAvailable && !checkStreamOutput.checked;
  checkStreamOutput.title =
    piperPlaybackAvailable || checkStreamOutput.checked
      ? ""
      : "Radio stream output needs Piper, a voice model, and FFmpeg on the Signal K server.";
  if (document.activeElement !== checkMuteAll) {
    checkMuteAll.checked = browserMuted === true;
  }
  const mutedReasons = [];
  if (browserMuted) mutedReasons.push("browser muted on this device");
  if (status.engineMuted) mutedReasons.push("muted by Traffic");
  outputStatus.textContent = [
    `Browser ${browserOutputModeLabel(browserOutputMode)}`,
    piperPlaybackAvailable
      ? `desktop player ${status.desktopPlayerOutput !== false ? "on" : "off"}`
      : "desktop player unavailable",
    serverSpeakerAvailable
      ? `server speaker ${status.localPlayback !== false ? "on" : "off"}`
      : `server speaker unavailable${status.localPlaybackUnavailableReason ? ` (${status.localPlaybackUnavailableReason})` : ""}`,
    piperPlaybackAvailable
      ? `radio stream ${status.liveStream !== false ? "on" : "off"}`
      : "radio stream unavailable",
    mutedReasons.length ? mutedReasons.join(", ") : "not muted",
  ].join(" · ");
}

function renderPingControl(status) {
  const piperPlaybackAvailable = status?.dependencies?.piperPlaybackAvailable === true;
  const enabledForBrowserPiper = browserOutputMode === "piper" && piperPlaybackAvailable;
  checkPingEnabled.disabled = !enabledForBrowserPiper;
  checkPingEnabled.checked =
    enabledForBrowserPiper && status?.pingEnabled === true;
  checkPingEnabled.title = enabledForBrowserPiper
    ? ""
    : "Directional ping is available when AJRM Marine Piper playback is selected and Piper, a voice model, and FFmpeg are installed.";
}

function renderRadioStreamPanel(status) {
  const piperPlaybackAvailable = status.dependencies?.piperPlaybackAvailable === true;
  const url =
    status.publicStreamUrl ||
    `${window.location.origin}${status.streamUrl || "/plugins/signalk-ajrm-marine-audio/live.mp3"}`;
  streamUrl.textContent = isRadioStreamUsable(status) ? url : "";
  if (!piperPlaybackAvailable) {
    streamStatus.textContent =
      "Radio stream unavailable until Piper, a voice model, and FFmpeg are installed.";
  } else if (status.liveStream !== true) {
    streamStatus.textContent = "Radio stream output is off.";
  } else {
    streamStatus.textContent = "Radio stream output is available.";
  }
  buttonRestartStreams.disabled = !isRadioStreamUsable(status);
  buttonStreamTimeCheck.disabled = !isRadioStreamUsable(status);
  const streamButtonTitle = isRadioStreamUsable(status)
    ? ""
    : "Radio stream is off or unavailable.";
  buttonRestartStreams.title = streamButtonTitle;
  buttonStreamTimeCheck.title = streamButtonTitle;
}

function isRadioStreamUsable(status) {
  return Boolean(status?.liveStream === true && status.dependencies?.piperPlaybackAvailable === true);
}

function renderDependencies(dependencies) {
  if (!dependencies) {
    dependencyPanel.classList.remove("warn");
    dependencyStatus.textContent = "Speech dependency status unavailable.";
    buttonInstallPiper.hidden = true;
    return;
  }
  dependencyPanel.classList.toggle("warn", dependencies.ok === false);
  dependencyStatus.textContent = dependencies.summary || "Speech dependency status unavailable.";
  const canInstallPiper = dependencies.install?.available === true;
  if (dependencies.install?.message) {
    dependencyStatus.textContent = joinSentences(
      dependencyStatus.textContent,
      dependencies.install.message,
    );
  }
  buttonInstallPiper.hidden = !canInstallPiper;
  buttonInstallPiper.disabled = !canInstallPiper;
  buttonInstallPiper.dataset.endpoint = dependencies.install?.endpoint || "";
}

function joinSentences(first, second) {
  const prefix = String(first || "").trim();
  const suffix = String(second || "").trim();
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  return /[.!?]$/.test(prefix) ? `${prefix} ${suffix}` : `${prefix}. ${suffix}`;
}

async function installPiperWithPiController() {
  const endpoint = buttonInstallPiper.dataset.endpoint || "/plugins/signalk-ajrm-marine-pi-controller/actions/install-piper";
  if (
    !window.confirm(
      "Install Piper on this Raspberry Pi Signal K server using AJRM Marine Pi Controller? This downloads the Linux aarch64 Piper binary and voice models and may require sudo permissions. Do not use this on Windows or macOS.",
    )
  ) {
    return;
  }
  try {
    signalCommandButton(buttonInstallPiper, "Piper install requested through AJRM Marine Pi Controller.");
    const response = await fetchWithTimeout(endpoint, {
      credentials: "include",
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ confirmed: true }),
    });
    await readResponse(response, "install-piper");
    outputStatus.textContent =
      "Piper install started. Refreshing status while AJRM Marine Pi Controller works.";
    window.setTimeout(refresh, 2000);
  } catch (error) {
    outputStatus.textContent =
      `Piper install request failed: ${error.message || error}`;
  }
}

function initialBrowserOutputMode() {
  const storedMode = normalizeBrowserOutputMode(readStoredValue(BROWSER_OUTPUT_MODE_STORAGE_KEY));
  if (storedMode) return storedMode;
  return readStoredValue(BROWSER_OUTPUT_STORAGE_KEY) === "true" ? "piper" : "off";
}

function normalizeBrowserOutputMode(mode) {
  return BROWSER_OUTPUT_MODES.includes(mode) ? mode : "";
}

function saveBrowserOutputMode(mode) {
  writeStoredValue(BROWSER_OUTPUT_MODE_STORAGE_KEY, mode);
  writeStoredValue(BROWSER_OUTPUT_STORAGE_KEY, mode === "piper" ? "true" : "false");
}

function renderBrowserOutputMode() {
  for (const input of browserOutputModeInputs) {
    input.checked = input.value === browserOutputMode;
  }
}

function disableCompetingBrowserSpeech() {
  for (const key of LEGACY_BROWSER_SPEECH_STORAGE_KEYS) {
    writeStoredValue(key, "false");
  }
}

function browserOutputModeLabel(mode) {
  if (mode === "speech") return "speech synthesis";
  if (mode === "piper") return "Piper playback";
  return "off";
}

function browserOutputModeStatusText(mode) {
  if (mode === "speech") return "Browser speech synthesis selected for this device.";
  if (mode === "piper") return "AJRM Marine Piper browser playback selected for this device.";
  return "Browser output disabled for this device.";
}

function playBrowserAnnouncement(userInitiated, announcement) {
  if (CONSOLE_AUDIO_HOSTED) return;
  if (firstStatusRender && !userInitiated) return;
  if (browserMuted && !userInitiated) return;
  if (browserOutputMode === "piper") {
    playLastAudioInBrowser(userInitiated);
  } else if (browserOutputMode === "speech") {
    speakLastAnnouncementInBrowser(userInitiated, announcement);
  }
}

function playLastAudioInBrowser(userInitiated) {
  const audioUrl = lastAudio.getAttribute("src") || "";
  if (!audioUrl || (!userInitiated && audioUrl === lastBrowserAudioUrl)) return false;
  lastBrowserAudioUrl = audioUrl;
  lastAudio
    .play()
    .then(() => {
      outputStatus.textContent = userInitiated
        ? "Browser playback enabled and last announcement played."
        : "Browser announcement playback started.";
    })
    .catch((error) => {
      lastBrowserAudioUrl = "";
      outputStatus.textContent =
        `Browser playback needs a tap here first: ${error.message || error}`;
    });
  return true;
}

function speakLastAnnouncementInBrowser(userInitiated, announcement = null) {
  const message = String(
    announcement?.message || lastAnnouncement.textContent || "",
  ).trim();
  if (!message || message === "No announcement received yet.") return false;
  const speechKey = `${message}:${announcement?.audioUrl || announcement?.publicAudioUrl || ""}`;
  if (!userInitiated && speechKey === lastBrowserSpeechKey) return false;
  if (speakMessageInBrowser(message, userInitiated)) {
    lastBrowserSpeechKey = speechKey;
    return true;
  }
  return false;
}

function speakMessageInBrowser(message, userInitiated) {
  const speech = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!speech || !Utterance) {
    outputStatus.textContent = "Browser speech synthesis is not available on this device.";
    return false;
  }
  speech.cancel();
  speech.speak(new Utterance(message));
  outputStatus.textContent = userInitiated
    ? "Browser speech synthesis played."
    : "Browser speech synthesis started.";
  return true;
}

function stopBrowserOutputs() {
  lastAudio.pause();
  lastBrowserAudioUrl = "";
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function renderAplayVolumeControl(status) {
  const minimum = Number(status.aplayVolumeMinimumPercent) || 0;
  const maximum = Number(status.aplayVolumeMaximumPercent) || 100;
  const value = Math.max(
    minimum,
    Math.min(
      maximum,
      Number(
        status.aplayVolumeLevelPercent != null
          ? status.aplayVolumeLevelPercent
          : status.aplayVolumePercent,
      ) || 0,
    ),
  );
  aplayVolumeRange.min = String(minimum);
  aplayVolumeRange.max = String(maximum);
  if (document.activeElement !== aplayVolumeRange) {
    aplayVolumeRange.value = String(Math.round(value));
  }
  const localSpeakerAvailable = status.localPlaybackAvailable === true;
  aplayVolumeRange.disabled = !localSpeakerAvailable;
  aplayVolumeRange.title = localSpeakerAvailable
    ? ""
    : status.localPlaybackUnavailableReason ||
      "Local speaker level needs Piper, a voice model, and a local audio player.";
  renderAplayVolumeValue(aplayVolumeRange.value);
  if (!localSpeakerAvailable) {
    aplayVolumeStatus.textContent =
      status.localPlaybackUnavailableReason ||
      "Local speaker level is unavailable until server speaker output can work.";
    aplayVolumeStatus.classList.remove("warning");
  } else if (status.lastAplayVolumeError) {
    aplayVolumeStatus.textContent = `Last apply failed: ${status.lastAplayVolumeError}`;
    aplayVolumeStatus.classList.add("warning");
  } else if (!status.aplayVolumeEnabled) {
    aplayVolumeStatus.textContent = "Hardware mixer control is disabled.";
    aplayVolumeStatus.classList.remove("warning");
  } else {
    const control = status.lastAplayVolumeControl || status.aplayVolumeControl || "PCM";
    const mixerPercent = Math.round(
      Number(
        status.aplayMixerVolumePercent != null
          ? status.aplayMixerVolumePercent
          : status.aplayVolumePercent,
      ) || 66,
    );
    aplayVolumeStatus.textContent = status.lastAplayVolumeSetAt
      ? `Applied ${formatTime(status.lastAplayVolumeSetAt)}: ${mixerPercent}% mixer on ${control}.`
      : `Will apply ${mixerPercent}% mixer on ${control} at startup.`;
    aplayVolumeStatus.classList.remove("warning");
  }
}

function renderAplayVolumeValue(value) {
  const minimum = Number(aplayVolumeRange.min) || 0;
  const maximum = Number(aplayVolumeRange.max) || 100;
  const numeric = Math.max(minimum, Math.min(maximum, Number(value) || 0));
  aplayVolumeValue.textContent = `${Math.round(numeric)}%`;
}

function formatStreamDiagnostics(status) {
  const connections = status.liveStreamConnections || [];
  if (connections.length) {
    return connections
      .map(
        (client) =>
          `Client ${client.id} from ${client.remote}, connected ${formatDuration(client.uptimeSeconds)}, buffer ${client.writableLength} bytes`,
      )
      .join(" | ");
  }
  const last = status.streamStats || {};
  if (!last.lastDisconnectedAt) return "No stream clients have connected yet.";
  return `Last disconnect ${formatTime(last.lastDisconnectedAt)} from ${last.lastDisconnectedRemote || "unknown"} after ${formatDuration(last.lastClientUptimeSeconds)}: ${last.lastDisconnectReason || "closed"}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(value / 60);
  const secs = Math.round(value % 60);
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

function renderEvents(items) {
  const allItems = localNotice ? [localNotice].concat(items) : items;
  events.classList.toggle("empty", allItems.length === 0);
  events.innerHTML = allItems.length
    ? allItems
        .map(
          (item) => `
            <article>
              <time>${escapeHtml(formatTime(item.ts))}</time>
              <strong>${escapeHtml(item.event)}</strong>
              <span>${escapeHtml(item.message)}</span>
            </article>
          `,
        )
        .join("")
    : "No events yet.";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCommandError(error) {
  if (error.canRequestAccess) {
    requestSignalKAccess(error.commandLabel || "AJRM Marine Audio control");
    return;
  }
  localNotice = { event: "error", message: error.message, ts: new Date().toISOString() };
  renderEvents([]);
}

function renderStartupError(message) {
  statusPill.textContent = "Error";
  statusPill.className = "status-pill bad";
  renderEvents([
    {
      event: "error",
      message: `AJRM Marine Audio cannot update the page: ${message}`,
      ts: new Date().toISOString(),
    },
  ]);
}

function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (typeof AbortController === "function") {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const fetchOptions = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, fetchOptions)
      .then((response) => {
        window.clearTimeout(timer);
        return response;
      })
      .catch((error) => {
        window.clearTimeout(timer);
        if (error && error.name === "AbortError") {
          throw new Error(`Timed out waiting for ${url}`);
        }
        throw error;
      });
  }

  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(`Timed out waiting for ${url}`)), timeoutMs);
    }),
  ]);
}

function authHeaders(headers = {}) {
  return accessToken
    ? Object.assign({}, headers, { Authorization: `Bearer ${accessToken}` })
    : headers;
}

async function audioAccessError(status, body, text) {
  const loginStatus = await readLoginStatus();
  const error = new Error(audioAccessMessage(status, body, text, loginStatus));
  error.status = status;
  error.canRequestAccess = loginStatus && loginStatus.allowDeviceAccessRequests === true;
  error.loginUrl = LOGIN_URL;
  if (status === 401 && accessToken) {
    accessToken = "";
    removeStoredValue(ACCESS_TOKEN_STORAGE_KEY);
  }
  return error;
}

async function readLoginStatus() {
  for (const url of LOGIN_STATUS_URLS) {
    try {
      const response = await fetchWithTimeout(url, {
        cache: "no-store",
        credentials: "include",
      }, 4000);
      if (response.ok) return await response.json();
    } catch (_error) {
      // Try the next Signal K login-status route.
    }
  }
  return null;
}

function audioAccessMessage(status, body, text, loginStatus) {
  if (body && body.error) return body.error;
  if (loginStatus && loginStatus.authenticationRequired === false) {
    return `Signal K refused AJRM Marine Audio access: ${friendlyHttpError(status, text)}`;
  }
  if (status === 403) {
    return "AJRM Marine Audio controls require Signal K read/write or admin access.";
  }
  if (!loginStatus || loginStatus.status !== "loggedIn") {
    return "AJRM Marine Audio needs a Signal K login or approved device token.";
  }
  const userLevel = (loginStatus && loginStatus.userLevel) || "non-admin";
  return `AJRM Marine Audio controls require Signal K read/write or admin access. Current user level: ${userLevel}.`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return {};
  }
}

function friendlyHttpError(status, text) {
  if (status === 401 || status === 403) {
    return "Signal K login required or this user is not allowed to control AJRM Marine Audio.";
  }
  const cleaned = String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || `HTTP ${status}`;
}

async function requestSignalKAccess(label) {
  const pendingHref = readStoredValue(ACCESS_REQUEST_STORAGE_KEY);
  if (pendingHref) {
    pollAccessRequest(pendingHref);
    localNotice = {
      event: "access",
      message: `${label} needs write access. Approve the pending AJRM Marine Audio request in Signal K Access Requests.`,
      ts: new Date().toISOString(),
    };
    renderEvents([]);
    return true;
  }
  try {
    const response = await fetchWithTimeout(ACCESS_REQUEST_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: getClientId(),
        description: "AJRM Marine Audio browser",
        permissions: "readwrite",
      }),
    });
    const text = await response.text();
    const body = text ? parseJson(text) : {};
    if (!response.ok) {
      const duplicate = String(body.message || body.error || text || "").includes(
        "already requested",
      );
      if (!duplicate) {
        throw new Error(body.message || body.error || friendlyHttpError(response.status, text));
      }
    }
    if (body.href) {
      writeStoredValue(ACCESS_REQUEST_STORAGE_KEY, body.href);
      pollAccessRequest(body.href);
    }
    localNotice = {
      event: "access",
      message: `${label} needs write access. Approve AJRM Marine Audio in Signal K Access Requests, then try again.`,
      ts: new Date().toISOString(),
    };
    renderEvents([]);
    return true;
  } catch (requestError) {
    localNotice = {
      event: "error",
      message: `${label} failed: ${requestError.message}`,
      ts: new Date().toISOString(),
    };
    renderEvents([]);
    return true;
  }
}

function resumeAccessRequestPolling() {
  const pendingHref = readStoredValue(ACCESS_REQUEST_STORAGE_KEY);
  if (pendingHref) pollAccessRequest(pendingHref);
}

function pollAccessRequest(href) {
  window.clearTimeout(accessRequestTimer);
  accessRequestTimer = window.setTimeout(async () => {
    try {
      const response = await fetchWithTimeout(href, {
        cache: "no-store",
        credentials: "include",
      }, 4000);
      const body = await response.json();
      if (body.state === "PENDING") {
        pollAccessRequest(href);
        return;
      }
      removeStoredValue(ACCESS_REQUEST_STORAGE_KEY);
      const token = body.accessRequest && body.accessRequest.token;
      if (token) {
        accessToken = token;
        writeStoredValue(ACCESS_TOKEN_STORAGE_KEY, token);
        localNotice = {
          event: "access",
          message: "AJRM Marine Audio write access approved.",
          ts: new Date().toISOString(),
        };
        await refresh({ force: true });
        return;
      }
      localNotice = {
        event: "access",
        message: "AJRM Marine Audio write access was not approved.",
        ts: new Date().toISOString(),
      };
      renderEvents([]);
    } catch (_error) {
      pollAccessRequest(href);
    }
  }, 2000);
}

function getClientId() {
  const existing = readStoredValue(CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clientId = `ajrm-marine-audio-${generated}`;
  writeStoredValue(CLIENT_ID_STORAGE_KEY, clientId);
  return clientId;
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch (_error) {
    return "";
  }
}

function writeStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (_error) {
    // Private browsing or locked-down clients can still use an admin session.
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (_error) {
    // Ignore storage failures.
  }
}
