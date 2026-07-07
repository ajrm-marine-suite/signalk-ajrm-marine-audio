const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createPlugin = require("../plugin");

const RUN_EXTERNAL_AUDIO_PROCESS_TESTS = process.platform !== "win32" && process.arch !== "arm";

function createHarness(initialOptions = {}, harnessOptions = {}) {
  const savedOptions = [];
  const subscriptionCallbacks = [];
  const errors = [];
  const app = {
    config: { configPath: "/tmp" },
    debug() {},
    error(message) {
      errors.push(String(message || ""));
    },
    setPluginStatus() {},
    handleMessage() {},
    getSelfPath(pathName) {
      if (pathName === "plugins.ajrmMarinePiController.version") {
        return harnessOptions.piControllerVersion || null;
      }
      return null;
    },
    savePluginOptions(nextOptions, callback) {
      savedOptions.push(nextOptions);
      callback();
    },
    subscriptionmanager: {
      subscribe(_subscription, _unsubscribes, _onError, onDelta) {
        subscriptionCallbacks.push(onDelta);
      },
    },
  };
  const plugin = createPlugin(app);
  const baseOptions = {
    speakerReleaseGapMs: 10,
    ...initialOptions,
  };
  if (harnessOptions.disableMixer !== false && initialOptions.aplayVolumeCommand == null) {
    baseOptions.aplayVolumeCommand = "";
  }
  plugin.start(baseOptions);

  const posts = new Map();
  const gets = new Map();
  plugin.registerWithRouter({
    post(path, handler) {
      posts.set(path, handler);
    },
    get(path, handler) {
      gets.set(path, handler);
    },
  });

  return {
    plugin,
    savedOptions,
    errors,
    posts,
    gets,
    subscriptionCallbacks,
    brokerSequence: 0,
  };
}

function withPlatform(platform, fn) {
  const original = os.platform;
  os.platform = () => platform;
  try {
    return fn();
  } finally {
    os.platform = original;
  }
}

function withHostname(hostname, fn) {
  const original = os.hostname;
  os.hostname = () => hostname;
  try {
    return fn();
  } finally {
    os.hostname = original;
  }
}

function withoutExternalHost(fn) {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, "EXTERNALHOST");
  const original = process.env.EXTERNALHOST;
  delete process.env.EXTERNALHOST;
  try {
    return fn();
  } finally {
    if (hadValue) {
      process.env.EXTERNALHOST = original;
    } else {
      delete process.env.EXTERNALHOST;
    }
  }
}

function statusOf(harness) {
  let status;
  harness.gets.get("/status")({}, { json(body) { status = body; } });
  return status;
}

function sendNotification(
  harness,
  pathName,
  value,
  priorityScore = 500,
  lifecycle = "event",
  activeSubjects = [],
  preempt = true,
) {
  assert.ok(harness.subscriptionCallbacks.length > 0, "subscription callback registered");
  harness.brokerSequence += 1;
  const alertEvent = value?.data?.alertEvent || {};
  const muteState =
    typeof value?.data?.muted === "boolean" ? value.data.muted : null;
  const audioSequence = harness.brokerSequence;
  const audioRequest = value?.data?.audioRequest || {
    requestId: `test-broker:${audioSequence}`,
  };
  if (value?.data?.force === true) {
    audioRequest.force = true;
  }
  const audioEvent = {
    schemaVersion: 1,
    provider: "ajrm-marine-traffic",
    subjectKey: pathName,
    eventId: alertEvent.id || `${pathName}-${audioSequence}`,
    lifecycle,
    timestamp: new Date().toISOString(),
    audioSequence,
    priority: { level: "warning", score: priorityScore },
    delivery: {
      audio: true,
      localPlayback: true,
      streamOutput: true,
      muteState,
      preempt,
      force: value?.data?.force === true,
    },
    expiresAt: value?.data?.audioExpiresAt || undefined,
    audioExpiresAt: value?.data?.audioExpiresAt || undefined,
    presentation: {
      title: alertEvent.vesselName || "AJRM Marine",
      message: alertEvent.message || value?.message || "",
      category: value?.data?.category || "notification",
    },
    context: {
      mmsi: alertEvent.mmsi || "",
    },
  };
  harness.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.ajrmMarineNotifications",
            value: {
              active: activeSubjects.map((subjectKey) => ({ subjectKey })),
            },
          },
          {
            path: "plugins.ajrmMarineNotifications.audio",
            value: {
              contract: "notifications-plus-audio-delivery",
              contractVersion: 1,
              sessionId: "test-broker-session",
              sequence: audioSequence,
              audioSequence,
              audioRequest,
              event: audioEvent,
            },
          },
        ],
      },
    ],
  });
}

function vesselNotification(mmsi, message) {
  return {
    state: "warning",
    method: ["sound"],
    message,
    data: {
      category: "cpa",
      alertEvent: {
        mmsi,
        vesselName: `Vessel ${mmsi}`,
        methods: ["sound"],
        message,
      },
      announcement: {},
    },
  };
}

function soundStateNotification(muted) {
  return {
    state: "normal",
    method: ["sound"],
    message: muted ? "Sounds disabled." : "Sounds enabled.",
    data: {
      category: "system",
      muted,
      announcement: {},
    },
  };
}

function sendEngineAudioPolicy(harness, {
  muted,
  sequence,
  sessionId = "engine-session",
  correlationId = "engine-policy",
  mode = "engine",
} = {}) {
  harness.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.ajrmMarineTraffic.audioPolicy",
            value: {
              contract: "ajrm-marine-traffic-audio-policy",
              contractVersion: 1,
              sessionId,
              sequence,
              correlationId,
              mode,
              authoritative: true,
              muted,
            },
          },
        ],
      },
    ],
  });
}

function createSlowRenderHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajrm-marine-audio-test-"));
  const voicesDir = path.join(tempDir, "voices");
  fs.mkdirSync(voicesDir, { recursive: true });
  fs.writeFileSync(path.join(voicesDir, "en_GB-alan-medium.onnx"), "");
  const piperBinary = path.join(tempDir, "slow-piper.sh");
  fs.writeFileSync(piperBinary, "#!/bin/sh\nsleep 1\nexit 1\n");
  fs.chmodSync(piperBinary, 0o755);
  const harness = createHarness({
    audioDirectory: path.join(tempDir, "audio"),
    liveStream: false,
    localPlayback: false,
    piperBinary,
    publicHttpStream: false,
    voicesDir,
  });
  return { ...harness, tempDir };
}

function createPipelineHarness({ piperDelaySeconds = 0, piperJavascript = "" } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajrm-marine-audio-pipeline-"));
  const voicesDir = path.join(tempDir, "voices");
  fs.mkdirSync(voicesDir, { recursive: true });
  fs.writeFileSync(path.join(voicesDir, "en_GB-alan-medium.onnx"), "");
  const piperBinary = writeFakeCommand(
    tempDir,
    "piper",
    piperJavascript || `const fs = require("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output_file");
const output = outputIndex >= 0 ? args[outputIndex + 1] : "";
setTimeout(() => {
  if (output) fs.writeFileSync(output, "wav");
}, ${Math.round(piperDelaySeconds * 1000)});
`,
  );
  const ffmpegBinary = writeFakeCommand(
    tempDir,
    "ffmpeg",
    `const fs = require("node:fs");
const output = process.argv[process.argv.length - 1];
if (output) fs.writeFileSync(output, "wav");
`,
  );
  const audioPlayer = writeFakeCommand(
    tempDir,
    "aplay",
    "setTimeout(() => {}, 500);\n",
  );
  const harness = createHarness({
    audioDirectory: path.join(tempDir, "audio"),
    audioPlayer,
    ffmpegBinary,
    liveStream: false,
    localPlayback: true,
    piperBinary,
    publicHttpStream: false,
    voicesDir,
  });
  return { ...harness, tempDir };
}

function writeFakeCommand(directory, name, javascript) {
  const script = path.join(directory, `${name}.js`);
  fs.writeFileSync(script, javascript);
  if (process.platform === "win32") {
    const command = path.join(directory, `${name}.cmd`);
    fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return command;
  }
  const command = path.join(directory, `${name}.sh`);
  fs.writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(command, 0o755);
  return command;
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for audio pipeline state");
}

async function withAudioProcessTimeout(timeoutMs, fn) {
  const hadValue = Object.prototype.hasOwnProperty.call(
    process.env,
    "AJRM_MARINE_AUDIO_PROCESS_TIMEOUT_MS",
  );
  const original = process.env.AJRM_MARINE_AUDIO_PROCESS_TIMEOUT_MS;
  process.env.AJRM_MARINE_AUDIO_PROCESS_TIMEOUT_MS = String(timeoutMs);
  try {
    return await fn();
  } finally {
    if (hadValue) {
      process.env.AJRM_MARINE_AUDIO_PROCESS_TIMEOUT_MS = original;
    } else {
      delete process.env.AJRM_MARINE_AUDIO_PROCESS_TIMEOUT_MS;
    }
  }
}

async function postVolume(harness, volume) {
  let body;
  await harness.posts.get("/aplay-volume")(
    { query: { volume: String(volume) } },
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        body = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return body;
}

async function postOutputs(harness, body) {
  let responseBody;
  await harness.posts.get("/outputs")(
    { body },
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        responseBody = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return responseBody;
}

async function postRepeatLast(harness) {
  let responseBody;
  await harness.posts.get("/repeat-last")(
    {},
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        responseBody = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return responseBody;
}

async function postRoute(harness, pathName) {
  let responseBody;
  await harness.posts.get(pathName)(
    {},
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        responseBody = { statusCode: this.statusCode, ...value };
      },
    },
  );
  return responseBody;
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const browserApp = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const browserCss = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pluginSource = fs.readFileSync(path.join(__dirname, "..", "plugin", "index.js"), "utf8");
  assert.match(html, /Output routing/);
  assert.match(html, /browserOutputOff/);
  assert.match(html, /browserOutputSpeech/);
  assert.match(html, /browserOutputPiper/);
  assert.ok(
    html.indexOf("browserOutputPiper") < html.indexOf("checkPingEnabled"),
    "directional ping control is grouped with Piper browser playback",
  );
  assert.match(html, /checkPiOutput/);
  assert.match(html, /checkStreamOutput/);
  assert.match(html, /checkMuteAll/);
  assert.match(html, /Mute browser output on this device/);
  assert.match(html, /dependencyPanel/);
  assert.match(html, /buttonInstallPiper/);
  assert.match(html, /voiceSelect/);
  assert.match(html, /Piper voice/);
  assert.doesNotMatch(html, />Renderer<\/h2>/);
  assert.doesNotMatch(html, /audioDirectory/);
  assert.doesNotMatch(browserApp, /audioDirectory/);
  assert.match(browserApp, /BROWSER_OUTPUT_MODE_STORAGE_KEY/);
  assert.match(browserApp, /BROWSER_MUTE_STORAGE_KEY/);
  assert.match(browserApp, /BROWSER_OUTPUT_MODES/);
  assert.match(browserApp, /STATUS_AUTH_RETRY_MS/);
  assert.match(browserApp, /readStatusResponse/);
  assert.match(browserApp, /nextStatusRefreshAt/);
  assert.match(browserApp, /CONSOLE_AUDIO_HOSTED/);
  assert.match(browserApp, /consoleAudioHost/);
  assert.match(browserApp, /LEGACY_BROWSER_SPEECH_STORAGE_KEYS/);
  assert.match(browserApp, /checkBrowserSpeech/);
  assert.match(browserApp, /disableCompetingBrowserSpeech/);
  assert.match(browserApp, /speakLastAnnouncementInBrowser/);
  assert.match(browserApp, /speech\.cancel\(\);\s*speech\.speak/);
  assert.match(browserApp, /bindSoundCheckButton/);
  assert.match(browserApp, /No audio output is selected/);
  assert.match(browserApp, /hasSoundCheckOutput/);
  assert.match(browserApp, /speakMessageInBrowser\(SOUND_CHECK_MESSAGE/);
  assert.match(browserApp, /bindRepeatLastButton/);
  assert.match(browserApp, /bindStreamCommandButton/);
  assert.match(browserApp, /Radio stream is off or unavailable/);
  assert.match(browserApp, /renderRadioStreamPanel/);
  assert.match(browserApp, /checkPingEnabled\.disabled/);
  assert.match(browserApp, /enabledForBrowserPiper/);
  assert.doesNotMatch(browserApp, /muted by notification provider/);
  assert.doesNotMatch(browserApp, /muted by AJRM Marine/);
  assert.match(browserApp, /bindCommandButton/);
  assert.match(browserApp, /signalCommandButton/);
  assert.match(browserApp, /postJson\("outputs"/);
  assert.match(browserApp, /postJson\("voice"/);
  assert.match(browserApp, /renderVoiceSelector/);
  assert.match(browserApp, /installPiperWithPiController/);
  assert.match(browserApp, /localPlaybackAvailable/);
  assert.match(browserApp, /Server speaker output needs Piper/);
  assert.match(browserApp, /piperPlaybackAvailable/);
  assert.match(browserApp, /Piper browser playback is unavailable/);
  assert.match(browserApp, /aplayVolumeRange\.disabled/);
  assert.match(browserApp, /joinSentences/);
  assert.match(browserApp, /signalk-ajrm-marine-pi-controller\/actions\/install-piper/);
  assert.match(
    browserApp,
    /status\.lastAnnouncement\.audioUrl \|\| status\.lastAnnouncement\.publicAudioUrl/,
  );
  const desktopPlayerApp = fs.readFileSync(
    path.join(__dirname, "..", "desktop-player", "src", "renderer", "app.js"),
    "utf8",
  );
  assert.match(
    desktopPlayerApp,
    /announcement\.audioUrl \|\| announcement\.publicAudioUrl/,
    "desktop player prefers the authenticated Signal K audio route before the public stream URL",
  );
  assert.match(
    pluginSource,
    /\/signalk\/v1\/api\/ajrmMarineAudio\/audio\/\$\{mp3FileName\}/,
    "Audio publishes generated MP3s on the Signal K API read route as audioUrl",
  );
  assert.match(desktopPlayerApp, /pendingKeys = new Set/);
  assert.match(desktopPlayerApp, /playbackRetryTimers = new Set/);
  assert.match(desktopPlayerApp, /function schedulePlaybackRetry/);
  assert.match(desktopPlayerApp, /pollInFlight = false/);
  assert.match(desktopPlayerApp, /if \(pollInFlight\) return/);
  assert.match(desktopPlayerApp, /finally \{\s*pollInFlight = false;\s*\}/s);
  assert.match(desktopPlayerApp, /rememberSeen\(currentItem\.key\)/);
  assert.doesNotMatch(
    desktopPlayerApp,
    /rememberSeen\(key\);\s*const absoluteAudioUrl/s,
    "desktop player must not mark an announcement seen before successful playback",
  );
  assert.match(browserCss, /button\.command-sent/);
  assert.match(browserCss, /button:not\(:disabled\):active/);
  assert.match(browserCss, /button:disabled/);
  assert.match(browserCss, /dependency-panel/);
  assert.match(browserCss, /select-control/);
  assert.match(browserCss, /input:disabled \+ span/);
  assert.match(browserCss, /transform:\s*translateY\(4px\)/);
  assert.match(browserCss, /box-shadow/);

  const defaults = createHarness();
  assert.equal(statusOf(defaults).localPlayback, false);
  assert.equal(statusOf(defaults).liveStream, false);
  assert.equal(statusOf(defaults).publicHttpStream, false);
  assert.equal(statusOf(defaults).pingEnabled, false);
  assert.equal(statusOf(defaults).localPlaybackAvailable, false);
  assert.equal(statusOf(defaults).dependencies.piperPlaybackAvailable, false);
  assert.match(statusOf(defaults).localPlaybackUnavailableReason, /Speech engine Piper/);
  assert.equal(statusOf(defaults).dependencies.install.supportedByPiController, true);
  assert.equal(statusOf(defaults).dependencies.install.piControllerRunning, false);
  assert.equal(statusOf(defaults).dependencies.install.available, false);
  assert.match(statusOf(defaults).dependencies.install.endpoint, /install-piper/);
  assert.match(statusOf(defaults).dependencies.install.message, /AJRM Marine Pi Controller/);
  assert.match(statusOf(defaults).dependencies.install.message, /Signal K app/);
  assert.match(statusOf(defaults).dependencies.install.message, /plugin configuration/);
  assert.match(statusOf(defaults).dependencies.summary, /Speech engine Piper is not installed yet/);
  assert.deepEqual(
    {
      level: statusOf(defaults).aplayVolumeLevelPercent,
      mixer: statusOf(defaults).aplayMixerVolumePercent,
    },
    { level: 53, mixer: 75 },
  );
  defaults.plugin.stop();

  const textOnly = createHarness();
  sendNotification(
    textOnly,
    "notifications.system.browser-speech",
    vesselNotification("browser-speech", "Browser speech only announcement."),
  );
  const textOnlyStatus = await waitFor(() => {
    const status = statusOf(textOnly);
    return status.lastAnnouncement && status.stats.rendered >= 1 ? status : null;
  });
  assert.equal(textOnlyStatus.stats.rendered, 1);
  assert.equal(textOnlyStatus.stats.failed, 0);
  assert.equal(textOnlyStatus.lastAnnouncement.message, "Browser speech only announcement.");
  assert.equal(textOnlyStatus.lastAnnouncement.renderMode, "text-only");
  assert.equal(textOnlyStatus.lastAnnouncement.audioUrl, "");
  assert.equal(textOnlyStatus.recentAnnouncements.length, 1);
  assert.equal(
    textOnlyStatus.recentAnnouncements[0].message,
    "Browser speech only announcement.",
  );
  assert.equal(textOnly.errors.length, 0);
  textOnly.plugin.stop();

  const nestedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajrm-marine-audio-nested-voices-"));
  const nestedVoicesDir = path.join(nestedTempDir, "voices");
  fs.mkdirSync(path.join(nestedVoicesDir, "en_GB-alba-medium"), { recursive: true });
  fs.writeFileSync(
    path.join(nestedVoicesDir, "en_GB-alba-medium", "en_GB-alba-medium.onnx"),
    "",
  );
  const nestedVoice = createHarness({
    localPlayback: false,
    piperBinary: process.execPath,
    ffmpegBinary: process.execPath,
    publicHttpStream: false,
    voice: "en_GB-alba-medium",
    voicesDir: nestedVoicesDir,
  });
  assert.equal(statusOf(nestedVoice).dependencies.voice.status, "ok");
  assert.equal(statusOf(nestedVoice).dependencies.voice.id, "en_GB-alba-medium");
  assert.match(
    statusOf(nestedVoice).dependencies.voice.file.replace(/\\/g, "/"),
    /en_GB-alba-medium\/en_GB-alba-medium\.onnx$/,
  );
  assert.equal(statusOf(nestedVoice).voices.length, 1);
  assert.equal(statusOf(nestedVoice).voices[0].selected, true);
  let voiceSaveBody;
  await nestedVoice.posts.get("/voice")(
    { body: { voice: "en_GB-alba-medium" }, query: {} },
    {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        voiceSaveBody = { statusCode: this.statusCode, ...body };
      },
    },
  );
  assert.equal(voiceSaveBody.ok, true);
  assert.equal(voiceSaveBody.voice, "en_GB-alba-medium");
  nestedVoice.plugin.stop();

  const withPiController = createHarness({}, { piControllerVersion: "0.5.3" });
  assert.equal(statusOf(withPiController).localPlayback, false);
  assert.equal(statusOf(withPiController).dependencies.install.piControllerRunning, true);
  assert.equal(statusOf(withPiController).dependencies.install.available, true);
  assert.match(statusOf(withPiController).dependencies.install.message, /64-bit Raspberry Pi OS/);
  withPiController.plugin.stop();

  const stateOnly = createHarness();
  stateOnly.subscriptionCallbacks[0]({
    updates: [
      {
        values: [
          {
            path: "plugins.ajrmMarineNotifications",
            value: {
              sessionId: "state-only-session",
              audioSequence: 1,
              audioRequest: { requestId: "sticky-legacy-request" },
              lastAudioEvent: {
                eventId: "sticky-legacy-event",
                timestamp: new Date().toISOString(),
                delivery: { audio: true },
                priority: { level: "information", score: 100 },
                presentation: { message: "Sticky state projection should not speak." },
              },
              active: [],
            },
          },
        ],
      },
    ],
  });
  assert.equal(
    statusOf(stateOnly).stats.queued,
    0,
    "sticky broker state projections do not queue audio",
  );
  stateOnly.plugin.stop();

  const audioMessageOverride = createHarness();
  const writtenMmsiNotification = vesselNotification(
    "235900007",
    "Traffic advisory. Small craft 235900007 at 1 o'clock.",
  );
  writtenMmsiNotification.data.audioRequest = {
    requestId: "speech-friendly-request",
    message: "Traffic advisory. Small craft at 1 o'clock.",
  };
  sendNotification(
    audioMessageOverride,
    "notifications.collision.235900007",
    writtenMmsiNotification,
  );
  assert.equal(
    statusOf(audioMessageOverride).lastAnnouncement.message,
    "Traffic advisory. Small craft at 1 o'clock.",
  );
  audioMessageOverride.plugin.stop();

  const legacyMinimum = createHarness({ aplayVolumePercent: 66 });
  assert.deepEqual(
    {
      level: statusOf(legacyMinimum).aplayVolumeLevelPercent,
      mixer: statusOf(legacyMinimum).aplayMixerVolumePercent,
    },
    { level: 0, mixer: 66 },
  );
  legacyMinimum.plugin.stop();

  const routeMinimum = createHarness();
  const minimumBody = await postVolume(routeMinimum, 0);
  assert.equal(minimumBody.statusCode, 200);
  assert.equal(minimumBody.applied, false);
  assert.equal(minimumBody.aplayVolumeLevelPercent, 0);
  assert.equal(minimumBody.aplayVolumePercent, 66);
  assert.equal(routeMinimum.savedOptions.at(-1).aplayVolumeLevelPercent, 0);
  assert.equal(routeMinimum.savedOptions.at(-1).aplayVolumePercent, 66);
  routeMinimum.plugin.stop();

  const routeMaximum = createHarness();
  const maximumBody = await postVolume(routeMaximum, 100);
  assert.equal(maximumBody.statusCode, 200);
  assert.equal(maximumBody.aplayVolumeLevelPercent, 100);
  assert.equal(maximumBody.aplayVolumePercent, 100);
  assert.equal(routeMaximum.savedOptions.at(-1).aplayVolumeLevelPercent, 100);
  assert.equal(routeMaximum.savedOptions.at(-1).aplayVolumePercent, 100);
  routeMaximum.plugin.stop();

  const outputRouting = createHarness({
    localPlayback: true,
    liveStream: true,
  });
  const outputBody = await postOutputs(outputRouting, {
    localPlayback: false,
    liveStream: false,
  });
  assert.equal(outputBody.statusCode, 200);
  assert.deepEqual(outputBody.outputs, {
    localPlayback: false,
    liveStream: false,
  });
  assert.equal(statusOf(outputRouting).pluginMuted, false);
  assert.equal(statusOf(outputRouting).localPlayback, false);
  assert.equal(statusOf(outputRouting).liveStream, false);
  assert.equal(outputRouting.savedOptions.at(-1).localPlayback, false);
  assert.equal(outputRouting.savedOptions.at(-1).liveStream, false);
  assert.equal(Object.prototype.hasOwnProperty.call(outputRouting.savedOptions.at(-1), "muted"), false);
  outputRouting.plugin.stop();

  const unavailableLocalPlayback = createHarness({
    liveStream: true,
  });
  const unavailableLocalPlaybackBody = await postOutputs(unavailableLocalPlayback, {
    localPlayback: true,
    liveStream: true,
  });
  assert.equal(unavailableLocalPlaybackBody.statusCode, 409);
  assert.match(unavailableLocalPlaybackBody.error, /Server speaker output is not available/);
  assert.equal(statusOf(unavailableLocalPlayback).localPlayback, false);
  assert.equal(unavailableLocalPlayback.savedOptions.length, 0);
  unavailableLocalPlayback.plugin.stop();

  const unavailableRadioStream = createHarness({
    liveStream: false,
  });
  const unavailableRadioStreamBody = await postOutputs(unavailableRadioStream, {
    localPlayback: false,
    liveStream: true,
  });
  assert.equal(unavailableRadioStreamBody.statusCode, 409);
  assert.match(unavailableRadioStreamBody.error, /Radio stream output is not available/);
  assert.equal(statusOf(unavailableRadioStream).liveStream, false);
  assert.equal(unavailableRadioStream.savedOptions.length, 0);
  unavailableRadioStream.plugin.stop();

  const unavailableStreamCommand = createHarness({
    liveStream: false,
  });
  const restartBody = await postRoute(unavailableStreamCommand, "/restart-streams");
  assert.equal(restartBody.statusCode, 409);
  assert.match(restartBody.error, /Radio stream is off or unavailable/);
  const streamTimeBody = await postRoute(unavailableStreamCommand, "/stream-time-check");
  assert.equal(streamTimeBody.statusCode, 409);
  assert.match(streamTimeBody.error, /Radio stream is off or unavailable/);
  unavailableStreamCommand.plugin.stop();

  const darwinDefault = withPlatform("darwin", () =>
    createHarness({}, { disableMixer: false }),
  );
  assert.equal(statusOf(darwinDefault).aplayVolumeCommand, "");
  assert.equal(statusOf(darwinDefault).aplayVolumeEnabled, false);
  const darwinDefaultBody = await postVolume(darwinDefault, 40);
  assert.equal(darwinDefaultBody.statusCode, 200);
  assert.equal(darwinDefaultBody.applied, false);
  assert.equal(darwinDefaultBody.error, "");
  darwinDefault.plugin.stop();

  const darwinSavedAmixer = withPlatform("darwin", () =>
    createHarness({ aplayVolumeCommand: "amixer" }, { disableMixer: false }),
  );
  assert.equal(statusOf(darwinSavedAmixer).aplayVolumeCommand, "");
  assert.equal(statusOf(darwinSavedAmixer).aplayVolumeEnabled, false);
  darwinSavedAmixer.plugin.stop();

  if (RUN_EXTERNAL_AUDIO_PROCESS_TESTS) {
    const pipeline = createPipelineHarness();
    assert.equal(statusOf(pipeline).dependencies.ok, true);
    assert.equal(statusOf(pipeline).dependencies.piperPlaybackAvailable, true);
    assert.equal(statusOf(pipeline).dependencies.install.available, false);
    assert.equal(statusOf(pipeline).dependencies.voice.status, "ok");
    sendNotification(
      pipeline,
      "notifications.system.first",
      vesselNotification("pipeline-first", "First pipeline announcement."),
      100,
      "active",
      ["notifications.system.first"],
    );
    await waitFor(() => statusOf(pipeline).active);
    sendNotification(
      pipeline,
      "notifications.system.second",
      vesselNotification("pipeline-second", "Second pipeline announcement."),
      900,
      "event",
      ["notifications.system.first"],
    );
    const waitingPipelineStatus = await waitFor(() => {
      const status = statusOf(pipeline);
      return status.active && status.queueLength >= 1 ? status : null;
    });
    assert.equal(
      waitingPipelineStatus.active.message,
      "First pipeline announcement.",
      "higher-priority announcement does not interrupt current speaker playback",
    );
    assert.equal(
      waitingPipelineStatus.recentEvents.some((event) => event.event === "preempting"),
      false,
    );
    const completedPipelineStatus = await waitFor(
      () => {
        const status = statusOf(pipeline);
        return status.stats.rendered >= 2 ? status : null;
      },
      8000,
    );
    const pipelineStarts = completedPipelineStatus.recentEvents
      .slice()
      .reverse()
      .filter((event) => event.event === "speaker-started")
      .map((event) => event.message);
    assert.match(pipelineStarts[0], /First pipeline announcement/);
    assert.match(pipelineStarts[1], /Second pipeline announcement/);
    assert.equal(
      completedPipelineStatus.stats.failed,
      0,
      "queued priority handoff is not counted as a rendering failure",
    );
    pipeline.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(pipeline.tempDir, { recursive: true, force: true });

    const speechCaptureFile = path.join(os.tmpdir(), `ajrm-marine-speech-${Date.now()}.txt`);
    const speechFriendly = createPipelineHarness({
      piperJavascript: `const fs = require("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output_file");
const output = outputIndex >= 0 ? args[outputIndex + 1] : "";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(speechCaptureFile)}, input);
  if (output) fs.writeFileSync(output, "wav");
});
`,
    });
    sendNotification(
      speechFriendly,
      "notifications.system.speech-friendly-units",
      vesselNotification(
        "speech-friendly-units",
        "Position jump implies 54.6 kn over ground. Tide 1.2 m/s. Drift 300 m. Bearing 62 deg.",
      ),
      100,
    );
    await waitFor(() => statusOf(speechFriendly).stats.rendered >= 1, 2500);
    const speechText = fs.readFileSync(speechCaptureFile, "utf8");
    assert.match(speechText, /54\.6 knots over ground/);
    assert.match(speechText, /1\.2 meters per second/);
    assert.match(speechText, /300 meters/);
    assert.match(speechText, /62 degrees/);
    assert.doesNotMatch(speechText, /\bkn\b|m\/s\b|\bdeg\b/);
    speechFriendly.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(speechFriendly.tempDir, { recursive: true, force: true });
    fs.rmSync(speechCaptureFile, { force: true });

    await withAudioProcessTimeout(150, async () => {
      const hungRenderer = createPipelineHarness({
        piperJavascript: "setInterval(() => {}, 1000);\n",
      });
      sendNotification(
        hungRenderer,
        "notifications.system.hung-renderer-one",
        vesselNotification("hung-renderer-one", "This renderer will hang."),
        100,
      );
      sendNotification(
        hungRenderer,
        "notifications.system.hung-renderer-two",
        vesselNotification("hung-renderer-two", "The queue must still move on."),
        100,
      );
      const failedStatus = await waitFor(
        () => {
          const status = statusOf(hungRenderer);
          return status.stats.failed >= 2 && !status.preparing ? status : null;
        },
        3000,
      );
      assert.equal(failedStatus.queueLength, 0);
      assert.equal(
        failedStatus.recentEvents.some(
          (event) => event.event === "error" && /timed out/.test(event.message),
        ),
        true,
        "hung external renderers are timed out instead of blocking the announcement queue",
      );
      hungRenderer.plugin.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.rmSync(hungRenderer.tempDir, { recursive: true, force: true });
    });

    const nonPreempting = createPipelineHarness();
    sendNotification(
      nonPreempting,
      "notifications.system.playing",
      vesselNotification("non-preempting-first", "Message already playing."),
      100,
    );
    await waitFor(() => statusOf(nonPreempting).active);
    sendNotification(
      nonPreempting,
      "notifications.system.information",
      vesselNotification("non-preempting-second", "Routine information."),
      900,
      "event",
      [],
      false,
    );
    const waitingInformation = await waitFor(() => {
      const status = statusOf(nonPreempting);
      return status.active && status.queueLength >= 1 ? status : null;
    });
    assert.equal(
      waitingInformation.active.message,
      "Message already playing.",
      "non-preempting provider instruction leaves current audio uninterrupted",
    );
    assert.equal(
      waitingInformation.recentEvents.some((event) => event.event === "preempting"),
      false,
    );
    await waitFor(() => statusOf(nonPreempting).stats.rendered >= 2, 2500);
    nonPreempting.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(nonPreempting.tempDir, { recursive: true, force: true });

    const depthSupersede = createPipelineHarness();
    sendNotification(
      depthSupersede,
      "notifications.system.playing-depth-test",
      vesselNotification("depth-blocker", "Current announcement is already playing."),
      100,
    );
    await waitFor(() => statusOf(depthSupersede).active);
    for (const [message, score] of [
      ["Information. Depth below keel 4.5 metres.", 250],
      ["Information. Depth below keel 4.4 metres.", 250],
      ["Warning. Depth below keel 2.9 metres.", 550],
    ]) {
      sendNotification(
        depthSupersede,
        "audible-instruments:depth-below-keel",
        {
          state: score >= 500 ? "warn" : "alert",
          method: ["visual", "sound"],
          message,
          data: {
            category: "audible-instrument",
            alertEvent: {
              id: `depth-${score}-${message.match(/[0-9.]+/)?.[0]}`,
              message,
            },
          },
        },
        score,
        "active",
        ["audible-instruments:depth-below-keel"],
      );
    }
    const depthQueued = statusOf(depthSupersede);
    assert.equal(depthQueued.queueLength, 1);
    assert.equal(
      depthQueued.recentEvents.some(
        (event) =>
          event.event === "queued" &&
          /Warning\. Depth below keel 2\.9 metres/.test(event.message),
      ),
      true,
    );
    assert.equal(
      depthQueued.recentEvents.some((event) => event.event === "superseded"),
      true,
      "falling depth updates drop intermediate queued instrument announcements",
    );
    depthSupersede.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(depthSupersede.tempDir, { recursive: true, force: true });

    const trafficSupersede = createPipelineHarness();
    sendNotification(
      trafficSupersede,
      "notifications.system.playing-traffic-test",
      vesselNotification("traffic-blocker", "Current traffic announcement is already playing."),
      100,
    );
    await waitFor(() => statusOf(trafficSupersede).active);
    sendNotification(
      trafficSupersede,
      "ajrm-marine:traffic:vessel:235900004",
      vesselNotification("235900004", "Traffic advisory. Ferry Alpha at 10 o'clock."),
      550,
      "active",
      ["ajrm-marine:traffic:vessel:235900004"],
    );
    sendNotification(
      trafficSupersede,
      "ajrm-marine:traffic:vessel:235900004",
      vesselNotification("235900004", "Collision alarm. Ferry Alpha at 10 o'clock."),
      800,
      "active",
      ["ajrm-marine:traffic:vessel:235900004"],
    );
    const trafficQueued = statusOf(trafficSupersede);
    assert.equal(trafficQueued.queueLength, 1);
    assert.equal(
      trafficQueued.recentEvents.some(
        (event) => event.event === "queued" && /Collision alarm/.test(event.message),
      ),
      true,
    );
    assert.equal(
      trafficQueued.recentEvents.some((event) => event.event === "superseded"),
      true,
      "traffic escalation drops the stale queued advisory",
    );
    trafficSupersede.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(trafficSupersede.tempDir, { recursive: true, force: true });

    const lowerPriority = createPipelineHarness();
    sendNotification(
      lowerPriority,
      "notifications.collision.high",
      vesselNotification("higher-priority", "Higher priority announcement."),
      900,
    );
    await waitFor(() => statusOf(lowerPriority).active);
    sendNotification(
      lowerPriority,
      "notifications.system.low",
      vesselNotification("lower-priority", "Lower priority announcement."),
      100,
      "event",
      [],
      true,
    );
    const lowerWaiting = await waitFor(() => {
      const status = statusOf(lowerPriority);
      return status.active && status.queueLength >= 1 ? status : null;
    });
    assert.equal(
      lowerWaiting.active.message,
      "Higher priority announcement.",
      "lower-priority prepared audio cannot replace the active speaker owner",
    );
    assert.equal(
      lowerWaiting.recentEvents.some((event) => event.event === "preempting"),
      false,
      "lower-priority preempt permission does not override score ordering",
    );
    await waitFor(() => statusOf(lowerPriority).stats.rendered >= 2, 2500);
    lowerPriority.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(lowerPriority.tempDir, { recursive: true, force: true });

    const preparationRace = createPipelineHarness({ piperDelaySeconds: 0.2 });
    sendNotification(
      preparationRace,
      "notifications.collision.warning",
      vesselNotification("preparing-warning", "Warning preparing first."),
      500,
    );
    await waitFor(() => statusOf(preparationRace).preparing);
    sendNotification(
      preparationRace,
      "notifications.collision.alarm",
      vesselNotification("queued-alarm", "Alarm arrived during synthesis."),
      800,
    );
    const synthesisRaceStatus = await waitFor(
      () => (statusOf(preparationRace).stats.rendered >= 2 ? statusOf(preparationRace) : null),
      5000,
    );
    const synthesisStarts = synthesisRaceStatus.recentEvents
      .slice()
      .reverse()
      .filter((event) => event.event === "speaker-started")
      .map((event) => event.message);
    assert.match(
      synthesisStarts[0],
      /Alarm arrived during synthesis/,
      "a higher-priority announcement queued during synthesis gets the next speaker lane",
    );
    assert.match(synthesisStarts[1], /Warning preparing first/);
    assert.equal(
      synthesisRaceStatus.recentEvents.some((event) => event.event === "reprioritized"),
      true,
    );
    preparationRace.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(preparationRace.tempDir, { recursive: true, force: true });

    const expiredPrepared = createPipelineHarness({ piperDelaySeconds: 0.05 });
    sendNotification(
      expiredPrepared,
      "notifications.system.expired-prepared",
      {
        ...vesselNotification("expired-prepared", "This prepared announcement will expire."),
        data: {
          ...vesselNotification("expired-prepared", "This prepared announcement will expire.").data,
          audioExpiresAt: new Date(Date.now() + 10).toISOString(),
        },
      },
      500,
    );
    sendNotification(
      expiredPrepared,
      "notifications.system.valid-after-expired",
      {
        ...vesselNotification("valid-after-expired", "This valid announcement must still render."),
        data: {
          ...vesselNotification("valid-after-expired", "This valid announcement must still render.").data,
          audioExpiresAt: new Date(Date.now() + 5000).toISOString(),
        },
      },
      500,
    );
    const expiredPreparedStatus = await waitFor(
      () => {
        const status = statusOf(expiredPrepared);
        return status.stats.rendered >= 1 && status.stats.filtered >= 1 ? status : null;
      },
      5000,
    );
    assert.equal(expiredPreparedStatus.queueLength, 0);
    assert.equal(
      expiredPreparedStatus.recentEvents.some(
        (event) =>
          event.event === "rendered" &&
          /valid announcement must still render/i.test(event.message),
      ),
      true,
      "dropping an expired prepared announcement continues the queue",
    );
    expiredPrepared.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(expiredPrepared.tempDir, { recursive: true, force: true });

    const queuedMute = createSlowRenderHarness();
    sendNotification(
      queuedMute,
      "notifications.collision.235900001",
      vesselNotification("235900001", "Traffic advisory. First vessel."),
    );
    const activeTimingStatus = statusOf(queuedMute);
    const firstPending =
      activeTimingStatus.active ||
      activeTimingStatus.preparing ||
      activeTimingStatus.prepared;
    assert.ok(firstPending, "first announcement is being prepared or played");
    assert.ok(firstPending.receivedAt, "receipt timestamp is recorded");
    assert.ok(firstPending.queuedAt, "queue timestamp is recorded");
    assert.ok(
      firstPending.processingStartedAt,
      "processing timestamp is recorded",
    );
    assert.ok(
      Number.isFinite(firstPending.queueWaitMs),
      "queue wait is measured",
    );
    sendNotification(
      queuedMute,
      "notifications.collision.235900002",
      vesselNotification("235900002", "Traffic advisory. Second vessel."),
    );
    sendNotification(
      queuedMute,
      "notifications.collision.235900003",
      vesselNotification("235900003", "Traffic advisory. Third vessel."),
    );
    assert.equal(statusOf(queuedMute).queueLength, 2);
    sendNotification(
      queuedMute,
      "notifications.collision.soundState",
      soundStateNotification(true),
    );
    assert.ok(statusOf(queuedMute).queueLength >= 2);
    assert.equal(statusOf(queuedMute).aisPlusMuted, false);
    assert.equal(statusOf(queuedMute).muted, false);
    assert.equal(
      statusOf(queuedMute).recentEvents.filter((event) => event.event === "queue-cleared").length,
      0,
      "provider mute does not clear the queue",
    );
    sendNotification(
      queuedMute,
      "notifications.collision.soundState",
      soundStateNotification(true),
    );
    assert.equal(
      statusOf(queuedMute).recentEvents.filter((event) => event.event === "queue-cleared").length,
      0,
      "repeated provider mute is ignored by Audio",
    );
    sendNotification(
      queuedMute,
      "notifications.collision.235900004",
      vesselNotification("235900004", "Traffic advisory. Fourth vessel."),
    );
    assert.ok(statusOf(queuedMute).queueLength >= 3);
    sendNotification(
      queuedMute,
      "notifications.collision.soundState",
      soundStateNotification(false),
    );
    assert.equal(statusOf(queuedMute).aisPlusMuted, false);
    assert.equal(statusOf(queuedMute).muted, false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    queuedMute.plugin.stop();
    fs.rmSync(queuedMute.tempDir, { recursive: true, force: true });
  }

  const repeatedCollision = createHarness();
  const firstCollision = vesselNotification(
    "235900004",
    "Collision alarm. Medium vessel HARBOUR TUG at 9 o'clock.",
  );
  firstCollision.data.alertEvent.id = "traffic-collision-235900004-1";
  firstCollision.data.audioRequest = {
    requestId: "broker-session:1",
    eventId: "traffic-collision-235900004-1",
    message: "Collision alarm. Medium vessel HARBOUR TUG at 9 o'clock.",
  };
  sendNotification(
    repeatedCollision,
    "notifications.collision.235900004",
    firstCollision,
    800,
    "active",
    ["ajrm-marine:traffic:vessel:235900004"],
    true,
  );
  const repeatCollision = vesselNotification(
    "235900004",
    "Collision alarm. Medium vessel HARBOUR TUG at 9 o'clock.",
  );
  repeatCollision.data.alertEvent.id = "traffic-collision-235900004-2";
  repeatCollision.data.audioRequest = {
    requestId: "broker-session:2",
    eventId: "traffic-collision-235900004-2",
    message: "Collision alarm. Medium vessel HARBOUR TUG at 9 o'clock.",
  };
  sendNotification(
    repeatedCollision,
    "notifications.collision.235900004",
    repeatCollision,
    800,
    "active",
    ["ajrm-marine:traffic:vessel:235900004"],
    false,
  );
  assert.equal(
    statusOf(repeatedCollision).stats.queued,
    2,
    "same active collision subject with new broker audio events must queue repeated warnings",
  );
  repeatedCollision.plugin.stop();

  const duplicateRequest = createHarness();
  const duplicatedNotification = vesselNotification(
    "duplicate-audio",
    "This duplicate should only queue once.",
  );
  duplicatedNotification.data.audioRequest = {
    requestId: "same-notifications-plus-request",
  };
  sendNotification(
    duplicateRequest,
    "notifications.collision.duplicate",
    duplicatedNotification,
  );
  assert.equal(statusOf(duplicateRequest).stats.queued, 1);
  sendNotification(
    duplicateRequest,
    "notifications.collision.duplicate",
    duplicatedNotification,
  );
  assert.equal(
    statusOf(duplicateRequest).stats.queued,
    1,
    "same Notifications Plus requestId is not queued twice",
  );
  assert.equal(statusOf(duplicateRequest).stats.filtered, 1);
  duplicateRequest.plugin.stop();

  const duplicateEvent = createHarness();
  const duplicatedEventNotification = vesselNotification(
    "duplicate-event",
    "This event should only queue once.",
  );
  duplicatedEventNotification.data.alertEvent.id = "stable-provider-event";
  sendNotification(
    duplicateEvent,
    "notifications.collision.duplicate-event",
    duplicatedEventNotification,
  );
  assert.equal(statusOf(duplicateEvent).stats.queued, 1);
  duplicatedEventNotification.data.audioRequest = {
    requestId: "new-broker-request-after-republish",
  };
  sendNotification(
    duplicateEvent,
    "notifications.collision.duplicate-event",
    duplicatedEventNotification,
  );
  assert.equal(
    statusOf(duplicateEvent).stats.queued,
    1,
    "same provider eventId is not queued twice after a broker request id changes",
  );
  assert.equal(statusOf(duplicateEvent).stats.filtered, 1);
  duplicateEvent.plugin.stop();

  if (RUN_EXTERNAL_AUDIO_PROCESS_TESTS) {
    const gpsStateSupersede = createPipelineHarness({ piperDelaySeconds: 0.2 });
    sendNotification(
      gpsStateSupersede,
      "ajrm-marine:traffic:system:gps-received",
      {
        state: "alert",
        method: ["sound"],
        message: "GPS received.",
        data: { category: "gps", alertEvent: { message: "GPS received." } },
      },
      200,
    );
    await waitFor(() => statusOf(gpsStateSupersede).preparing);
    sendNotification(
      gpsStateSupersede,
      "navigation.gnss.integrity",
      {
        state: "alarm",
        method: ["sound"],
        message: "GPS position is missing or invalid.",
        data: {
          category: "Navigation",
          alertEvent: { message: "GPS position is missing or invalid." },
        },
      },
      850,
    );
    const gpsStateStatus = await waitFor(
      () => (statusOf(gpsStateSupersede).stats.rendered >= 1 ? statusOf(gpsStateSupersede) : null),
      5000,
    );
    assert.equal(gpsStateStatus.lastAnnouncement.message, "GPS position is missing or invalid.");
    assert.equal(
      gpsStateStatus.recentEvents.some((event) => event.event === "superseded"),
      true,
      "a later GPS lost announcement drops a stale queued or prepared GPS received announcement",
    );
    gpsStateSupersede.plugin.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(gpsStateSupersede.tempDir, { recursive: true, force: true });
  }

  const mutedSkip = createHarness();
  sendEngineAudioPolicy(mutedSkip, { muted: true, sequence: 1 });
  sendNotification(
    mutedSkip,
    "notifications.system.gps-received",
    vesselNotification("gps-received", "GPS received."),
  );
  assert.equal(statusOf(mutedSkip).lastAnnouncement, null);
  const mutedSkipRepeat = await postRepeatLast(mutedSkip);
  assert.equal(mutedSkipRepeat.statusCode, 404);
  mutedSkip.plugin.stop();

  const mutedRepeat = createHarness({ localPlayback: false, liveStream: false });
  sendNotification(
    mutedRepeat,
    "notifications.system.first-repeatable",
    vesselNotification("first-repeatable", "First repeatable announcement."),
  );
  assert.equal(statusOf(mutedRepeat).stats.queued, 1);
  assert.equal(statusOf(mutedRepeat).lastAnnouncement.message, "First repeatable announcement.");
  sendEngineAudioPolicy(mutedRepeat, { muted: true, sequence: 1 });
  const beforeRepeat = statusOf(mutedRepeat).stats.queued;
  const mutedRepeatBody = await postRepeatLast(mutedRepeat);
  assert.equal(mutedRepeatBody.statusCode, 409);
  assert.match(mutedRepeatBody.error, /muted/i);
  assert.equal(statusOf(mutedRepeat).stats.queued, beforeRepeat);
  mutedRepeat.plugin.stop();

  if (RUN_EXTERNAL_AUDIO_PROCESS_TESTS) {
    const muteStopsPlayback = createPipelineHarness();
    sendNotification(
      muteStopsPlayback,
      "notifications.system.long-playback",
      vesselNotification("long-playback", "This playback should stop when muted."),
    );
    await waitFor(() => statusOf(muteStopsPlayback).active);
    sendEngineAudioPolicy(muteStopsPlayback, { muted: true, sequence: 1 });
    await waitFor(() =>
      statusOf(muteStopsPlayback).recentEvents.some(
        (event) => event.event === "speaker-stopped",
      ),
    );
    await waitFor(() => !statusOf(muteStopsPlayback).active);
    assert.equal(statusOf(muteStopsPlayback).stats.failed, 0);
    muteStopsPlayback.plugin.stop();
    fs.rmSync(muteStopsPlayback.tempDir, { recursive: true, force: true });

    const activeForcedSurvivesMute = createPipelineHarness();
    sendNotification(
      activeForcedSurvivesMute,
      "notifications.system.active-bite-summary-forced",
      {
        ...vesselNotification("active-bite-summary-forced", "Marine built in tests complete."),
        data: {
          ...vesselNotification("active-bite-summary-forced", "Marine built in tests complete.").data,
          category: "test",
          force: true,
        },
      },
      950,
      "event",
      [],
      false,
    );
    await waitFor(() => statusOf(activeForcedSurvivesMute).active);
    sendEngineAudioPolicy(activeForcedSurvivesMute, {
      muted: true,
      sequence: 1,
      mode: "traffic",
      sessionId: "traffic-session",
    });
    const activeForcedRendered = await waitFor(
      () => {
        const status = statusOf(activeForcedSurvivesMute);
        return status.stats.rendered >= 1 ? status : null;
      },
      8000,
    );
    assert.equal(activeForcedRendered.stats.failed, 0);
    assert.equal(
      activeForcedRendered.recentEvents.some((event) =>
        event.event === "speaker-stopped" &&
        /Marine built in tests complete/.test(event.message)
      ),
      false,
      "forced BITE summary already playing is not stopped by stationary automute",
    );
    activeForcedSurvivesMute.plugin.stop();
    fs.rmSync(activeForcedSurvivesMute.tempDir, { recursive: true, force: true });

    const forcedSurvivesMute = createPipelineHarness();
    sendNotification(
      forcedSurvivesMute,
      "notifications.system.long-playback-before-bite",
      vesselNotification("long-playback-before-bite", "This playback should stop when muted before BITE summary."),
      100,
    );
    await waitFor(() => statusOf(forcedSurvivesMute).active);
    sendNotification(
      forcedSurvivesMute,
      "notifications.system.bite-summary-forced",
      {
        ...vesselNotification("bite-summary-forced", "Marine built in tests complete."),
        data: {
          ...vesselNotification("bite-summary-forced", "Marine built in tests complete.").data,
          category: "test",
          force: true,
        },
      },
      700,
      "event",
      [],
      false,
    );
    await waitFor(() => statusOf(forcedSurvivesMute).queueLength >= 1);
    sendEngineAudioPolicy(forcedSurvivesMute, {
      muted: true,
      sequence: 1,
      mode: "traffic",
      sessionId: "traffic-session",
    });
    await waitFor(() => statusOf(forcedSurvivesMute).engineMuted === true);
    const forcedRendered = await waitFor(
      () => statusOf(forcedSurvivesMute).recentEvents.some(
        (event) =>
          event.event === "rendered" &&
          /Marine built in tests complete/.test(event.message),
      ),
      8000,
    );
    assert.equal(forcedRendered, true, "forced BITE summary survives stationary automute queue clearing");
    forcedSurvivesMute.plugin.stop();
    fs.rmSync(forcedSurvivesMute.tempDir, { recursive: true, force: true });
  }

  const engineMute = createHarness();
  sendEngineAudioPolicy(engineMute, { muted: true, sequence: 1 });
  assert.equal(statusOf(engineMute).engineMuted, true);
  assert.equal(statusOf(engineMute).muted, true);
  sendNotification(
    engineMute,
    "notifications.collision.engine-muted",
    vesselNotification("engine-muted", "This must remain silent."),
  );
  assert.equal(statusOf(engineMute).queueLength, 0);
  sendEngineAudioPolicy(engineMute, { muted: false, sequence: 2 });
  assert.equal(statusOf(engineMute).engineMuted, false);
  assert.equal(statusOf(engineMute).muted, false);
  sendEngineAudioPolicy(engineMute, { muted: true, sequence: 1 });
  assert.equal(
    statusOf(engineMute).engineMuted,
    false,
    "non-monotonic Engine Audio Policy sequence is ignored",
  );
  engineMute.plugin.stop();

  const trafficMute = createHarness();
  sendEngineAudioPolicy(trafficMute, {
    muted: true,
    sequence: 1,
    mode: "traffic",
    sessionId: "traffic-session",
  });
  assert.equal(statusOf(trafficMute).engineMuted, true);
  assert.equal(statusOf(trafficMute).muted, true);
  sendNotification(
    trafficMute,
    "notifications.navigation.gnss.integrity",
    vesselNotification("traffic-muted", "This GPS alert must remain silent while stationary automute is active."),
  );
  assert.equal(statusOf(trafficMute).queueLength, 0);
  sendNotification(
    trafficMute,
    "notifications.system.bite-summary",
    {
      ...vesselNotification("bite-summary", "Marine built in tests complete."),
      data: {
        ...vesselNotification("bite-summary", "Marine built in tests complete.").data,
        category: "test",
        force: true,
      },
    },
  );
  assert.equal(statusOf(trafficMute).stats.queued, 1);
  assert.equal(statusOf(trafficMute).lastAnnouncement.force, true);
  assert.equal(statusOf(trafficMute).lastAnnouncement.message, "Marine built in tests complete.");
  trafficMute.plugin.stop();

  const emptyProviderMute = createHarness();
  sendNotification(
    emptyProviderMute,
    "notifications.collision.soundState",
    soundStateNotification(true),
  );
  assert.equal(statusOf(emptyProviderMute).muted, false);
  assert.equal(statusOf(emptyProviderMute).aisPlusMuted, false);
  assert.equal(emptyProviderMute.savedOptions.length, 0);
  assert.equal(
    statusOf(emptyProviderMute).recentEvents.some(
      (event) =>
        event.event === "queue-cleared" &&
        event.message.includes("Provider muted audio"),
    ),
    false,
    "provider mute does not log a no-op queue clear when nothing was pending",
  );
  emptyProviderMute.plugin.stop();

  withoutExternalHost(() => withHostname("nemo", () => {
    const streamHost = createHarness({
      publicHttpStream: true,
      publicHttpStreamPort: 3456,
      publicStreamUseHttps: false,
    });
    try {
      assert.equal(statusOf(streamHost).publicStreamUrl, "http://nemo.local:3456/live.mp3");
      assert.equal(statusOf(streamHost).publicStreamHost, "nemo.local");
      assert.doesNotMatch(statusOf(streamHost).publicStreamUrl, /nemo3/);
    } finally {
      streamHost.plugin.stop();
    }
  }));

  const numericStreamHost = createHarness({
    publicHttpStream: true,
    publicHttpStreamPort: 3457,
    publicStreamUseHttps: false,
    publicStreamHost: "192.168.3.50",
  });
  try {
    assert.equal(
      statusOf(numericStreamHost).publicStreamUrl,
      "http://192.168.3.50:3457/live.mp3",
    );
  } finally {
    numericStreamHost.plugin.stop();
  }
})().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
