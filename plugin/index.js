const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const packageInfo = require("../package.json");

const PLUGIN_ID = "signalk-ajrm-marine-audio";
const DEFAULT_AUDIO_DIR = "~/.signalk/ajrm-marine-audio";
const LEGACY_AUDIO_DIR = ["~/.signalk/ais", "-plus-audio"].join("");
const TRAFFIC_AUDIO_POLICY_CONTRACT = "ajrm-marine-traffic-audio-policy";
const STATUS_PATH = "plugins.ajrmMarineAudio";
const MIN_APLAY_VOLUME_LEVEL_PERCENT = 0;
const MAX_APLAY_VOLUME_LEVEL_PERCENT = 100;
const MIN_APLAY_MIXER_VOLUME_PERCENT = 66;
const MAX_APLAY_MIXER_VOLUME_PERCENT = 100;
const DEFAULT_APLAY_MIXER_VOLUME_PERCENT = 75;
const DEFAULT_APLAY_VOLUME_LEVEL_PERCENT = 53;
const APLAY_VOLUME_LOG_BASE = 10;
const DEFAULT_APLAY_VOLUME_CONTROL = "PCM";
const DEFAULT_APLAY_VOLUME_COMMAND = "amixer";
const APLAY_VOLUME_FALLBACK_CONTROLS = ["PCM", "Master", "Headphone", "Speaker"];
const AJRM_MARINE_NOTIFICATIONS_PATH = "plugins.ajrmMarineNotifications";
const AJRM_MARINE_NOTIFICATIONS_AUDIO_PATH = "plugins.ajrmMarineNotifications.audio";
const TRAFFIC_AUDIO_POLICY_PATH = "plugins.ajrmMarineTraffic.audioPolicy";
const PIPER_INSTALL_ENDPOINT = "/plugins/signalk-ajrm-marine-pi-controller/actions/install-piper";
const DEFAULT_PROCESS_TIMEOUT_MS = 60000;

module.exports = function ajrmMarineAudio(app) {
  const plugin = {};
  let options = {};
  let storedPluginOptions = {};
  let unsubscribes = [];
  let queue = [];
  let active = null;
  let preparing = null;
  let prepared = null;
  let currentLocalPlaybackChild = null;
  let currentLocalPlaybackEntry = null;
  let lastAnnouncement = null;
  let recentAnnouncements = [];
  let trafficMuted = false;
  let trafficAudioPolicy = null;
  let trafficSessionId = "";
  let lastTrafficAudioPolicySequence = 0;
  let ajrmMarineNotificationsSessionId = "";
  let lastNotificationsPlusAudioSequence = 0;
  let processedNotificationsPlusAudioRequests = new Set();
  let audioSessionId = randomUUID();
  let audioTimelineSequence = 0;
  let audioPlaybackSequence = 0;
  let timeline = null;
  let activeNotificationSubjects = new Set();
  let lastAplayVolumeSetAt = null;
  let lastAplayVolumeError = "";
  let lastAplayVolumeControl = "";
  let recentEvents = [];
  let liveSilenceTimer = null;
  let liveSilenceFile = null;
  let liveStreamPauseUntil = 0;
  let publicStreamServer = null;
  let publicStreamIsHttps = false;
  let streamHealthTimer = null;
  let statusPublishTimer = null;
  let lastRealAnnouncementAt = 0;
  let lastStreamHealthAt = 0;
  const liveStreamClients = new Set();
  let nextLiveStreamClientId = 1;
  let droppedLaggingClients = 0;
  const streamStats = {
    connectedTotal: 0,
    disconnectedTotal: 0,
    lastConnectedAt: null,
    lastConnectedRemote: "",
    lastDisconnectedAt: null,
    lastDisconnectedRemote: "",
    lastDisconnectReason: "",
    lastClientUptimeSeconds: 0,
  };
  let stats = {
    received: 0,
    queued: 0,
    filtered: 0,
    rendered: 0,
    failed: 0,
  };

  plugin.id = PLUGIN_ID;
  plugin.name = "AJRM Marine Audio";
  plugin.description =
    "Renders AJRM Marine announcement events into Piper audio for local speaker and browser clients.";

  plugin.start = (initialPluginOptions = {}) => {
    audioSessionId = randomUUID();
    audioTimelineSequence = 0;
    audioPlaybackSequence = 0;
    timeline = null;
    recentAnnouncements = [];
    ajrmMarineNotificationsSessionId = "";
    lastNotificationsPlusAudioSequence = 0;
    processedNotificationsPlusAudioRequests = new Set();
    trafficMuted = false;
    trafficAudioPolicy = null;
    trafficSessionId = "";
    lastTrafficAudioPolicySequence = 0;
    options = normalizeOptions(initialPluginOptions);
    storedPluginOptions = {
      ...initialPluginOptions,
      aplayVolumeLevelPercent: options.aplayVolumeLevelPercent,
      aplayVolumePercent: options.aplayVolumePercent,
    };
    ensureAudioDirectory();
    const dependencyStatus = checkDependencies();
    if (dependencyStatus.piper.status !== "ok" || dependencyStatus.voice.status !== "ok") {
      addRecent(
        "warning",
        `Piper setup incomplete: ${dependencyStatus.summary}`,
      );
    }
    applyAplayVolume("startup").catch((error) => {
      addRecent("warning", `Local speaker volume not applied on startup: ${error.message}`);
    });
    startPublicStreamServer();
    startStreamHealthTimer();
    startStatusPublisher();
    subscribeToAisPlusAnnouncements();
    publishStatus();
    app.setPluginStatus(`Started v${packageInfo.version}`);
  };

  plugin.stop = () => {
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch (error) {
        app.debug(`[${PLUGIN_ID}] unsubscribe failed: ${error.message}`);
      }
    }
    unsubscribes = [];
    queue = [];
    active = null;
    preparing = null;
    prepared = null;
    currentLocalPlaybackChild?.kill("SIGTERM");
    currentLocalPlaybackChild = null;
    currentLocalPlaybackEntry = null;
    activeNotificationSubjects = new Set();
    trafficMuted = false;
    trafficAudioPolicy = null;
    stopLiveStreamSilence();
    for (const client of Array.from(liveStreamClients)) {
      closeLiveStreamClient(client, "plugin stop");
    }
    stopPublicStreamServer();
    stopStreamHealthTimer();
    stopStatusPublisher();
    publishStatus();
  };

  plugin.schema = {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        title: "Enable AJRM Marine Audio rendering",
        default: true,
      },
      localPlayback: {
        type: "boolean",
        title: "Play rendered audio on this Signal K server",
        description:
          "When enabled, this Signal K server will play the same rendered announcement audio that browser clients can fetch. Requires Piper, a voice model, and a local audio player.",
        default: false,
      },
      desktopPlayerOutput: {
        type: "boolean",
        title: "Enable Electron/Desktop Player output",
        description:
          "Allows AJRM Marine Audio Player desktop apps on macOS, Windows, or Linux to play server-rendered announcement MP3 files from the Audio status feed.",
        default: true,
      },
      liveStream: {
        type: "boolean",
        title: "Enable radio-style MP3 stream",
        description:
          "Serves a continuous stream for radio player apps that can keep playing while a phone is locked.",
        default: false,
      },
      publicHttpStream: {
        type: "boolean",
        title: "Enable local stream port",
        description:
          "Serves only the live audio stream on a separate local port, so native radio apps do not need a Signal K login.",
        default: false,
      },
      publicHttpStreamPort: {
        type: "integer",
        title: "Local stream port",
        default: 3445,
        minimum: 1024,
        maximum: 65535,
      },
      publicStreamHost: {
        type: "string",
        title: "Public stream host",
        description:
          "Optional hostname or IP address used when showing radio stream URLs. Leave blank to use EXTERNALHOST or this server's hostname.",
        default: "",
      },
      publicStreamUseHttps: {
        type: "boolean",
        title: "Use HTTPS for local stream port",
        description:
          "Uses Signal K ssl-cert.pem and ssl-key.pem from the server config directory. Recommended for iPhone/iPad.",
        default: true,
      },
      piperBinary: {
        type: "string",
        title: "Piper executable",
        default: "piper",
      },
      ffmpegBinary: {
        type: "string",
        title: "FFmpeg executable",
        description: "Used to combine the stereo ping and Piper speech into browser-friendly MP3.",
        default: "ffmpeg",
      },
      audioPlayer: {
        type: "string",
        title: "Local audio player",
        description: "Usually aplay on Raspberry Pi OS.",
        default: "aplay",
      },
      speakerReleaseGapMs: {
        type: "integer",
        title: "Speaker release gap (milliseconds)",
        description:
          "Keeps the speaker reserved briefly after aplay exits so the final buffered words finish before another announcement starts.",
        default: 500,
        minimum: 0,
        maximum: 3000,
      },
      aplayVolumeLevelPercent: {
        type: "number",
        title: "Local speaker level (%)",
        description:
          "Logarithmic default speaker level to apply at AJRM Marine Audio startup and before local aplay playback. Level 0 applies 66% to the ALSA mixer, so the local speaker should remain audible.",
        default: DEFAULT_APLAY_VOLUME_LEVEL_PERCENT,
        minimum: MIN_APLAY_VOLUME_LEVEL_PERCENT,
        maximum: MAX_APLAY_VOLUME_LEVEL_PERCENT,
      },
      aplayVolumeCommand: {
        type: "string",
        title: "Local speaker mixer command",
        description:
          "Usually amixer on Raspberry Pi OS. Leave blank to disable hardware mixer volume control. macOS disables this automatically.",
        default: defaultAplayVolumeCommand(),
      },
      aplayVolumeControl: {
        type: "string",
        title: "Local speaker mixer control",
        description:
          "Usually PCM on Raspberry Pi OS. AJRM Marine Audio will also try Master, Headphone, and Speaker if the configured control is not present.",
        default: DEFAULT_APLAY_VOLUME_CONTROL,
      },
      voicesDir: {
        type: "string",
        title: "Piper voices directory",
        default: "~/piper-voices",
      },
      voice: {
        type: "string",
        title: "Piper voice model",
        description: "The .onnx filename or voice id to use.",
        default: "en_GB-alba-medium",
      },
      audioDirectory: {
        type: "string",
        title: "Generated audio directory",
        default: DEFAULT_AUDIO_DIR,
      },
      maxAudioFiles: {
        type: "integer",
        title: "Maximum generated audio files to keep",
        default: 30,
        minimum: 1,
        maximum: 200,
      },
      maxQueueLength: {
        type: "integer",
        title: "Maximum announcement queue length",
        default: 10,
        minimum: 1,
        maximum: 100,
      },
      mp3BitrateKbps: {
        type: "integer",
        title: "MP3 stream bitrate (kbit/s)",
        description:
          "Lower values reduce Wi-Fi traffic. 64 kbit/s is usually enough for spoken alerts and the directional ping.",
        default: 64,
        minimum: 32,
        maximum: 192,
      },
      maxStreamLagSeconds: {
        type: "integer",
        title: "Maximum stream lag before reconnect (seconds)",
        description:
          "If a radio player falls this far behind, AJRM Marine Audio closes that stream instead of queuing stale announcements behind old silence.",
        default: 30,
        minimum: 5,
        maximum: 300,
      },
      streamHealthTimeCheck: {
        type: "boolean",
        title: "Announce time on live stream",
        description:
          "Periodically speaks the server time to the live stream so you can detect player buffering drift.",
        default: false,
      },
      streamHealthIntervalMinutes: {
        type: "integer",
        title: "Live stream time-check interval (minutes)",
        default: 15,
        minimum: 1,
        maximum: 120,
      },
      masterVolumePercent: {
        type: "number",
        title: "Master volume (%)",
        default: 100,
        minimum: 0,
        maximum: 200,
      },
      speechVolumePercent: {
        type: "number",
        title: "Speech volume (%)",
        default: 65,
        minimum: 0,
        maximum: 200,
      },
      pingEnabled: {
        type: "boolean",
        title: "Enable directional ping",
        default: false,
      },
      pingVolumePercent: {
        type: "number",
        title: "Directional ping volume (%)",
        default: 100,
        minimum: 0,
        maximum: 400,
      },
      pingSmallFrequencyHz: {
        type: "integer",
        title: "Small vessel ping frequency",
        default: 1100,
        minimum: 200,
        maximum: 2400,
      },
      pingMediumFrequencyHz: {
        type: "integer",
        title: "Medium vessel ping frequency",
        default: 760,
        minimum: 200,
        maximum: 2400,
      },
      pingLargeFrequencyHz: {
        type: "integer",
        title: "Large vessel ping frequency",
        default: 440,
        minimum: 200,
        maximum: 2400,
      },
      generatedAudioExpiresSeconds: {
        type: "integer",
        title: "Announcement freshness window",
        description:
          "Drop queued or prepared announcements older than this unless the provider supplies its own expiry.",
        default: 90,
        minimum: 10,
        maximum: 600,
      },
      debugLogging: {
        type: "boolean",
        title: "Enable debug log",
        default: false,
      },
    },
  };

  plugin.registerWithRouter = (router) => {
    registerRoutes(router);
  };

  plugin.signalKApiRoutes = (router) => {
    registerRoutes(router, {
      prefix: "/ajrmMarineAudio",
      requireWriteAccess: true,
    });
    return router;
  };

  return plugin;

  function registerRoutes(router, routeOptions = {}) {
    const prefix = routeOptions.prefix || "";
    const write = routeOptions.requireWriteAccess ? requireWriteAccess : (handler) => handler;

    router.get(`${prefix}/status`, (_req, res) => {
      res.json(buildStatus());
    });

    router.get(`${prefix}/live.mp3`, async (_req, res) => {
      if (!options.liveStream) {
        res.status(404).json({ error: "Live stream is disabled." });
        return;
      }
      try {
        await addLiveStreamClient(res);
      } catch (error) {
        addRecent("error", `Live stream failed: ${error.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        } else {
          res.end();
        }
      }
    });

    router.get(`${prefix}/live.m3u`, (req, res) => {
      const streamUrl = absolutePluginUrl(req, "/live.mp3");
      res.setHeader("Content-Type", "audio/x-mpegurl; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(`#EXTM3U\n#EXTINF:-1,AJRM Marine Audio\n${streamUrl}\n`);
    });

    router.get(`${prefix}/audio/:file`, (req, res) => {
      const file = path.basename(req.params.file || "");
      if (!file.endsWith(".mp3")) {
        res.status(404).json({ error: "Audio file not found." });
        return;
      }
      const filePath = path.join(expandHome(options.audioDirectory), file);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: "Audio file not found." });
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(filePath).pipe(res);
    });

    router.post(`${prefix}/sound-check`, write((_req, res) => {
      const entry = normalizeAnnouncement({
        id: `sound-check-${Date.now()}`,
        ts: new Date().toISOString(),
        severity: "alert",
        category: "test",
        vesselName: "AJRM Marine Audio",
        clock: 12,
        sizeCategory: "medium",
        message: "Sound Check. Testing 1, 2, 3.",
        force: true,
      });
      enqueue(entry);
      res.json({ ok: true, announcement: entry });
    }));

    router.post(`${prefix}/ping-enabled`, write((req, res) => {
      const enabled = String(req.query.enabled || "").toLowerCase() === "true";
      options.pingEnabled = enabled;
      addRecent(
        "settings",
        `Directional ping ${enabled ? "enabled" : "disabled"} from Audio webapp`,
      );
      publishStatus();
      res.json({ ok: true, pingEnabled: options.pingEnabled, status: buildStatus() });
    }));

    router.post(`${prefix}/aplay-volume`, write(async (req, res) => {
      const requested =
        req.body?.volumeLevelPercent ??
        req.body?.volumePercent ??
        req.query.level ??
        req.query.volume ??
        req.query.percent;
      const volumeLevelPercent = normalizeAplayVolumeLevelPercent(requested);
      options.aplayVolumeLevelPercent = volumeLevelPercent;
      options.aplayVolumePercent = aplayVolumeLevelToMixerPercent(volumeLevelPercent);
      try {
        await savePluginOptions({
          ...storedPluginOptions,
          aplayVolumeLevelPercent: options.aplayVolumeLevelPercent,
          aplayVolumePercent: options.aplayVolumePercent,
        });
      } catch (error) {
        res.status(500).json({ error: `Volume save failed: ${error.message}` });
        return;
      }
      let applied = false;
      let errorMessage = "";
      try {
        applied = await applyAplayVolume("webapp");
      } catch (error) {
        applied = false;
        errorMessage = error.message;
        addRecent("warning", `Local speaker volume saved but not applied: ${error.message}`);
      }
      publishStatus();
      res.json({
        ok: true,
        applied,
        error: errorMessage,
        aplayVolumeLevelPercent: options.aplayVolumeLevelPercent,
        aplayVolumePercent: options.aplayVolumePercent,
        status: buildStatus(),
      });
    }));

    router.post(`${prefix}/outputs`, write(async (req, res) => {
      const next = {
        localPlayback:
          req.body?.localPlayback !== undefined
            ? booleanFrom(req.body.localPlayback)
            : options.localPlayback,
        liveStream:
          req.body?.liveStream !== undefined
            ? booleanFrom(req.body.liveStream)
            : options.liveStream,
        desktopPlayerOutput:
          req.body?.desktopPlayerOutput !== undefined
            ? booleanFrom(req.body.desktopPlayerOutput)
            : options.desktopPlayerOutput,
      };
      const previous = outputSettings();
      if (next.localPlayback && !localPlaybackAvailability().available) {
        const reason = localPlaybackAvailability().reason;
        res.status(409).json({
          ok: false,
          error: reason
            ? `Server speaker output is not available: ${reason}`
            : "Server speaker output is not available.",
          outputs: previous,
          status: buildStatus(),
        });
        return;
      }
      if (next.liveStream && !piperPlaybackAvailability().available) {
        const reason = piperPlaybackAvailability().reason;
        res.status(409).json({
          ok: false,
          error: reason
            ? `Radio stream output is not available: ${reason}`
            : "Radio stream output is not available.",
          outputs: previous,
          status: buildStatus(),
        });
        return;
      }
      options.localPlayback = next.localPlayback;
      options.liveStream = next.liveStream;
      options.desktopPlayerOutput = next.desktopPlayerOutput;
      try {
        await savePluginOptions({
          ...storedPluginOptions,
          localPlayback: options.localPlayback,
          liveStream: options.liveStream,
          desktopPlayerOutput: options.desktopPlayerOutput,
        });
      } catch (error) {
        options.localPlayback = previous.localPlayback;
        options.liveStream = previous.liveStream;
        options.desktopPlayerOutput = previous.desktopPlayerOutput;
        res.status(500).json({ error: `Output settings save failed: ${error.message}` });
        return;
      }
      if (!options.liveStream) {
        restartLiveStreamClients("radio stream disabled");
      }
      addRecent(
        "settings",
        [
          `Audio outputs updated from webapp:`,
          `desktop player ${options.desktopPlayerOutput ? "on" : "off"},`,
          `server speaker ${options.localPlayback ? "on" : "off"},`,
          `radio stream ${options.liveStream ? "on" : "off"}`,
        ].join(" "),
      );
      publishStatus();
      res.json({ ok: true, outputs: outputSettings(), status: buildStatus() });
    }));

    router.post(`${prefix}/voice`, write(async (req, res) => {
      const requested = String(req.body?.voice || req.query.voice || "").trim();
      const voices = listVoices();
      const selected = voices.find(
        (voice) => voice.id === requested || `${voice.id}.onnx` === requested,
      );
      if (!selected) {
        res.status(400).json({
          ok: false,
          error: requested
            ? `Piper voice ${requested} is not installed.`
            : "Select an installed Piper voice.",
          voices,
          status: buildStatus(),
        });
        return;
      }
      const previous = options.voice;
      options.voice = selected.id;
      try {
        await savePluginOptions({
          ...storedPluginOptions,
          voice: options.voice,
        });
      } catch (error) {
        options.voice = previous;
        res.status(500).json({ ok: false, error: `Voice save failed: ${error.message}` });
        return;
      }
      addRecent("settings", `Piper voice changed to ${selected.id} from Audio webapp`);
      publishStatus();
      res.json({ ok: true, voice: selected.id, status: buildStatus() });
    }));

    router.post(`${prefix}/clear-queue`, write((_req, res) => {
      queue = [];
      addRecent("queue-cleared", "Announcement queue cleared");
      res.json({ ok: true });
    }));

    router.post(`${prefix}/restart-streams`, write((_req, res) => {
      if (!isRadioStreamAvailable()) {
        res.status(409).json({
          ok: false,
          error: "Radio stream is off or unavailable.",
          status: buildStatus(),
        });
        return;
      }
      const count = restartLiveStreamClients("manual stream restart");
      res.json({ ok: true, restarted: count });
    }));

    router.post(`${prefix}/stream-time-check`, write((_req, res) => {
      if (!isRadioStreamAvailable()) {
        res.status(409).json({
          ok: false,
          error: "Radio stream is off or unavailable.",
          status: buildStatus(),
        });
        return;
      }
      const entry = createStreamTimeCheckAnnouncement(true);
      enqueue(entry);
      res.json({ ok: true, announcement: entry });
    }));

    router.post(`${prefix}/repeat-last`, write((_req, res) => {
      if (!lastAnnouncement) {
        res.status(404).json({ error: "No announcement has been received yet." });
        return;
      }
      if (!options.enabled) {
        res.status(409).json({ ok: false, error: "Audio is disabled." });
        return;
      }
      if (isAudioMuted()) {
        res.status(409).json({ ok: false, error: "Audio is muted." });
        return;
      }
      enqueue({
        ...lastAnnouncement,
        id: `repeat-${Date.now()}`,
        force: false,
      });
      res.json({ ok: true });
    }));
  }

  function requireWriteAccess(handler) {
    return function writeAccessHandler(req, res) {
      const permission = req.skPrincipal?.permissions;
      if (
        permission === "admin" ||
        permission === "readwrite" ||
        (permission === undefined && req.skIsAuthenticated !== false)
      ) {
        return handler(req, res);
      }
      res.status(403).json({
        ok: false,
        error:
          "AJRM Marine Audio controls require Signal K read/write or admin access.",
      });
      return undefined;
    };
  }

  function normalizeOptions(value) {
    return {
      enabled: value.enabled !== false,
      muted: false,
      localPlayback: value.localPlayback === true,
      desktopPlayerOutput: value.desktopPlayerOutput !== false,
      liveStream: value.liveStream === true,
      publicHttpStream: value.publicHttpStream === true,
      publicHttpStreamPort: clampInteger(value.publicHttpStreamPort, 1024, 65535, 3445),
      publicStreamHost: String(value.publicStreamHost || "").trim(),
      publicStreamUseHttps: value.publicStreamUseHttps !== false,
      piperBinary: expandHome(String(value.piperBinary || "piper")),
      ffmpegBinary: expandHome(String(value.ffmpegBinary || "ffmpeg")),
      audioPlayer: expandHome(String(value.audioPlayer || "aplay")),
      speakerReleaseGapMs: clampInteger(value.speakerReleaseGapMs, 0, 3000, 500),
      aplayVolumeLevelPercent: normalizeAplayVolumeLevelPercent(
        value.aplayVolumeLevelPercent,
        value.aplayVolumePercent,
      ),
      aplayVolumePercent: aplayVolumeLevelToMixerPercent(
        normalizeAplayVolumeLevelPercent(value.aplayVolumeLevelPercent, value.aplayVolumePercent),
      ),
      aplayVolumeCommand: expandHome(
        normalizeAplayVolumeCommand(value.aplayVolumeCommand),
      ),
      aplayVolumeControl:
        String(
          value.aplayVolumeControl == null
            ? DEFAULT_APLAY_VOLUME_CONTROL
            : value.aplayVolumeControl,
        ).trim() || DEFAULT_APLAY_VOLUME_CONTROL,
      voicesDir: String(value.voicesDir || "~/piper-voices"),
      voice: String(value.voice || "en_GB-alba-medium"),
      audioDirectory: String(value.audioDirectory || defaultAudioDirectory()),
      maxAudioFiles: clampInteger(value.maxAudioFiles, 1, 200, 30),
      maxQueueLength: clampInteger(value.maxQueueLength, 1, 100, 10),
      mp3BitrateKbps: clampInteger(value.mp3BitrateKbps, 32, 192, 64),
      maxStreamLagSeconds: clampInteger(value.maxStreamLagSeconds, 5, 300, 30),
      streamHealthTimeCheck: value.streamHealthTimeCheck === true,
      streamHealthIntervalMinutes: clampInteger(value.streamHealthIntervalMinutes, 1, 120, 15),
      masterVolumePercent: normalizePercentValue(value.masterVolumePercent, value.masterVolume, 100, 200),
      speechVolumePercent: normalizePercentValue(value.speechVolumePercent, value.speechVolume, 65, 200),
      pingEnabled: value.pingEnabled === true,
      pingVolumePercent: normalizePercentValue(value.pingVolumePercent, value.pingVolume, 100, 400),
      pingSmallFrequencyHz: clampInteger(value.pingSmallFrequencyHz, 200, 2400, 1100),
      pingMediumFrequencyHz: clampInteger(value.pingMediumFrequencyHz, 200, 2400, 760),
      pingLargeFrequencyHz: clampInteger(value.pingLargeFrequencyHz, 200, 2400, 440),
      generatedAudioExpiresSeconds: clampInteger(
        value.generatedAudioExpiresSeconds,
        10,
        600,
        90,
      ),
      debugLogging: value.debugLogging === true,
    };
  }

  function defaultAudioDirectory() {
    const preferred = expandHome(DEFAULT_AUDIO_DIR);
    const legacy = expandHome(LEGACY_AUDIO_DIR);
    return !fs.existsSync(preferred) && fs.existsSync(legacy) ? LEGACY_AUDIO_DIR : DEFAULT_AUDIO_DIR;
  }

  function outputSettings() {
    return {
      localPlayback: options.localPlayback,
      desktopPlayerOutput: options.desktopPlayerOutput,
      liveStream: options.liveStream,
    };
  }

  function booleanFrom(value) {
    if (typeof value === "boolean") return value;
    const text = String(value || "").trim().toLowerCase();
    return text === "true" || text === "1" || text === "yes" || text === "on";
  }

  function subscribeToAisPlusAnnouncements() {
    if (!app.subscriptionmanager?.subscribe) {
      addRecent("warning", "Signal K subscription manager is not available");
      return;
    }

    const subscription = {
      context: "vessels.self",
      subscribe: [
        { path: AJRM_MARINE_NOTIFICATIONS_PATH, policy: "instant", format: "delta" },
        { path: AJRM_MARINE_NOTIFICATIONS_AUDIO_PATH, policy: "instant", format: "delta" },
        { path: TRAFFIC_AUDIO_POLICY_PATH, policy: "instant", format: "delta" },
      ],
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (error) => {
        addRecent("error", `Subscription error: ${error}`);
        app.error(`[${PLUGIN_ID}] subscription error: ${error}`);
      },
      (delta) => handleDelta(delta),
    );
  }

  function handleDelta(delta) {
    for (const update of delta.updates || []) {
      for (const value of update.values || []) {
        if (value?.path === TRAFFIC_AUDIO_POLICY_PATH) {
          handleTrafficAudioPolicy(value.value);
        } else if (value?.path === AJRM_MARINE_NOTIFICATIONS_AUDIO_PATH) {
          handleNotificationsPlusAudioDelivery(value.value);
        } else {
          handleNotificationValue(value);
        }
      }
    }
  }

  function handleTrafficAudioPolicy(projection) {
    if (projection?.contract !== TRAFFIC_AUDIO_POLICY_CONTRACT) return;
    const sessionId = String(projection.sessionId || "");
    if (sessionId && sessionId !== trafficSessionId) {
      trafficSessionId = sessionId;
      lastTrafficAudioPolicySequence = 0;
    }
    const sequence = Number(projection.sequence) || 0;
    if (sequence <= lastTrafficAudioPolicySequence) return;
    lastTrafficAudioPolicySequence = sequence;
    trafficAudioPolicy = projection;
    const wasMuted = trafficMuted;
    trafficMuted =
      projection.authoritative === true &&
      projection.mode === "traffic" &&
      projection.muted === true;
    if (!wasMuted && trafficMuted) {
      clearAudibleWork("Traffic audio policy muted audio");
    }
    publishStatus();
  }

  function handleNotificationValue(value) {
    if (value?.path !== AJRM_MARINE_NOTIFICATIONS_PATH) return;
    const projection = value.value;
    updateNotificationsPlusSession(projection);
    activeNotificationSubjects = new Set(
      Array.isArray(projection?.active)
        ? projection.active
            .map((notification) => String(notification?.subjectKey || "").trim())
            .filter(Boolean)
        : [],
    );
  }

  function handleNotificationsPlusAudioDelivery(projection) {
    if (projection?.contract !== "notifications-plus-audio-delivery") return;
    updateNotificationsPlusSession(projection);
    const sequence = Number(projection?.audioSequence || projection?.sequence) || 0;
    const envelope = projection?.event || projection?.lastAudioEvent;
    if (!envelope || sequence <= lastNotificationsPlusAudioSequence) return;
    lastNotificationsPlusAudioSequence = sequence;
    stats.received += 1;
    handleNotificationsPlusAudio(envelope, projection?.audioRequest);
  }

  function updateNotificationsPlusSession(projection) {
    const brokerSessionId = String(projection?.sessionId || "");
    if (brokerSessionId && brokerSessionId !== ajrmMarineNotificationsSessionId) {
      ajrmMarineNotificationsSessionId = brokerSessionId;
      lastNotificationsPlusAudioSequence = 0;
    }
  }

  function handleNotificationsPlusAudio(envelope, request = null) {
    const receivedAt = new Date().toISOString();
    const requestKeys = ajrmMarineNotificationsAudioRequestKeys(envelope, request);
    if (
      requestKeys.some((requestKey) =>
        processedNotificationsPlusAudioRequests.has(requestKey),
      )
    ) {
      stats.filtered += 1;
      addRecent(
        "duplicate",
        `Ignored duplicate audio request: ${envelope?.presentation?.message || requestKeys[0]}`,
      );
      return;
    }
    rememberNotificationsPlusAudioRequests(requestKeys);
    const message = String(
      request?.message ||
      envelope?.presentation?.audioMessage ||
      envelope?.presentation?.message ||
      "",
    ).trim();
    if (!message || envelope?.delivery?.audio !== true) {
      stats.filtered += 1;
      return;
    }
    const entry = normalizeAnnouncement({
      id: envelope.eventId,
      requestId: request?.requestId,
      correlationId: request?.correlationId || envelope.correlationId,
      subjectKey: request?.subjectKey || envelope.subjectKey,
      ts: envelope.timestamp,
      receivedAt,
      lifecycle: envelope.lifecycle,
      expiresAt: envelope.audioExpiresAt || envelope.expiresAt || null,
      vesselId: envelope.subjectKey || "",
      mmsi: envelope.context?.mmsi || "",
      vesselName: envelope.presentation?.title || "",
      severity: envelope.priority?.level || "information",
      priorityScore: Number(envelope.priority?.score) || 0,
      preempt: envelope.delivery?.preempt !== false,
      category: envelope.presentation?.category || "notification",
      context: envelope.context || {},
      message,
      sourcePath: AJRM_MARINE_NOTIFICATIONS_PATH,
      force: request?.force === true || envelope.delivery?.force === true,
      localPlayback: envelope.delivery?.localPlayback !== false,
      streamOutput: envelope.delivery?.streamOutput !== false,
    });
    publishTimeline("accepted", entry);
    enqueue(entry);
  }

  function ajrmMarineNotificationsAudioRequestKeys(envelope, request) {
    return [
      envelope?.eventId,
      request?.eventId,
      request?.requestId,
      envelope?.audioSequence,
    ]
      .map((key) => String(key || "").trim())
      .filter(Boolean);
  }

  function rememberNotificationsPlusAudioRequests(requestKeys) {
    for (const requestKey of requestKeys) {
      processedNotificationsPlusAudioRequests.add(requestKey);
    }
    if (processedNotificationsPlusAudioRequests.size <= 200) return;
    processedNotificationsPlusAudioRequests = new Set(
      [...processedNotificationsPlusAudioRequests].slice(-160),
    );
  }

  function enqueue(entry) {
    if (!entry?.message) return;

    if (!options.enabled && !canBypassMute(entry)) {
      addRecent("skipped", `Audio disabled: ${entry.message}`);
      return;
    }
    if (isAudioMutedForEntry(entry)) {
      addRecent("skipped", `Muted: ${entry.message}`);
      return;
    }

    lastAnnouncement = entry;

    const supersedeKey = announcementSupersedeKey(entry);
    if (supersedeKey) {
      const removed = supersedeAnnouncementsWithKey(supersedeKey);
      if (removed > 0) {
        addRecent(
          "superseded",
          `Dropped ${removed} stale queued announcement${removed === 1 ? "" : "s"} for ${announcementDisplayName(entry)}`,
        );
      }
    }

    entry.queuedAt = entry.queuedAt || new Date().toISOString();
    entry.queueDepthAtEnqueue = queue.length;
    queue.push(entry);
    sortAnnouncementQueue();
    if (queue.length > options.maxQueueLength) {
      queue = queue.slice(0, options.maxQueueLength);
      addRecent("warning", "Dropped stale queued announcements");
    }
    stats.queued += 1;
    publishTimeline("queued", entry);
    addRecent(
      "queued",
      `[priority ${entry.priorityScore}] ${entry.message} (${timingAgeText(entry.timestamp, entry.queuedAt)} from provider)`,
    );
    processQueue();
  }

  async function processQueue() {
    if (active || preparing) return;

    if (prepared) {
      const next = prepared;
      prepared = null;
      if (next.entry.superseded || announcementExpired(next.entry)) {
        if (!next.entry.superseded) {
          stats.filtered += 1;
          addRecent(
            "expired",
            `Dropped expired prepared announcement: ${next.entry.message}`,
          );
        }
        cleanupPreparedAnnouncement(next);
        processQueue();
      } else if (shouldPreparedAnnouncementYield(next.entry)) {
        requeuePreparedAnnouncement(next);
        processQueue();
      } else {
        deliverPreparedAnnouncement(next);
      }
      return;
    }
    if (queue.length === 0) return;

    const entry = queue.shift();
    entry.processingStartedAt = new Date().toISOString();
    entry.queueWaitMs = elapsedMs(entry.queuedAt, entry.processingStartedAt);
    entry.generatedToProcessingMs = elapsedMs(entry.timestamp, entry.processingStartedAt);
    if (announcementExpired(entry)) {
      stats.filtered += 1;
      publishTimeline("expired", entry);
      addRecent(
        "expired",
        `Dropped expired announcement after ${formatDurationMs(entry.generatedToProcessingMs)}: ${entry.message}`,
      );
      processQueue();
      return;
    }
    addRecent(
      "processing",
      `[priority ${entry.priorityScore}] ${entry.message} (queue ${formatDurationMs(entry.queueWaitMs)}, total ${formatDurationMs(entry.generatedToProcessingMs)})`,
    );
    preparing = { entry };
    try {
      const next = await prepareAnnouncement(entry);
      preparing = null;
      if (entry.superseded) {
        cleanupPreparedAnnouncement(next);
      } else {
        prepared = next;
      }
    } catch (error) {
      preparing = null;
      stats.failed += 1;
      addRecent("error", `Render failed: ${error.message}`);
      app.error(`[${PLUGIN_ID}] render failed: ${error.stack || error.message}`);
    }
    processQueue();
  }

  async function prepareAnnouncement(entry) {
    const audioDir = expandHome(options.audioDirectory);
    await fs.promises.mkdir(audioDir, { recursive: true });

    const baseName = safeFileSegment(entry.id || `announcement-${Date.now()}`);
    const tempBase = path.join(os.tmpdir(), `${PLUGIN_ID}-${baseName}-${Date.now()}`);
    const speechWav = `${tempBase}-speech.wav`;
    const pingWav = `${tempBase}-ping.wav`;
    const combinedWav = `${tempBase}-combined.wav`;
    const mp3FileName = `${baseName}.mp3`;
    const mp3File = path.join(audioDir, mp3FileName);
    const metadataFile = path.join(audioDir, `${baseName}.json`);

    if (!piperPlaybackAvailability().available) {
      debug(`Skipping Piper render for "${entry.message}" because the speech render chain is unavailable`);
      entry.preparedAt = new Date().toISOString();
      return {
        entry,
        combinedWav: null,
        mp3File: null,
        mp3FileName: "",
        metadataFile,
        mp3Promise: Promise.resolve(null),
        textOnly: true,
      };
    }

    entry.synthesisStartedAt = new Date().toISOString();
    publishTimeline("synthesis-started", entry);
    await synthesizePiperWav(formatMessageForSpeech(entry.message), speechWav);
    entry.synthesisCompletedAt = new Date().toISOString();
    entry.synthesisMs = elapsedMs(entry.synthesisStartedAt, entry.synthesisCompletedAt);
    const clock = extractClockPosition(entry);
    const shouldPing = options.pingEnabled && clock != null;
    if (shouldPing) {
      await fs.promises.writeFile(
        pingWav,
        createPingWav(clock, extractVesselSize(entry), pingCountForClock(clock)),
      );
    }

    await createCombinedWav({
      speechWav,
      pingWav: shouldPing ? pingWav : null,
      combinedWav,
    });
    entry.wavReadyAt = new Date().toISOString();
    entry.preparedAt = entry.wavReadyAt;
    entry.generatedToWavReadyMs = elapsedMs(entry.timestamp, entry.wavReadyAt);
    fs.rm(speechWav, { force: true }, () => {});
    fs.rm(pingWav, { force: true }, () => {});

    const mp3Promise = (async () => {
      entry.mp3StartedAt = new Date().toISOString();
      await createMp3(combinedWav, mp3File);
      entry.mp3CompletedAt = new Date().toISOString();
      entry.mp3Ms = elapsedMs(entry.mp3StartedAt, entry.mp3CompletedAt);
    })().then(
      () => null,
      (error) => error,
    );

    return {
      entry,
      combinedWav,
      mp3File,
      mp3FileName,
      metadataFile,
      mp3Promise,
    };
  }

  async function deliverPreparedAnnouncement(preparation) {
    const { entry, combinedWav, mp3File, mp3FileName, metadataFile, mp3Promise } =
      preparation;
    active = entry;
    try {
      const shouldPlayLocally =
        combinedWav &&
        !entry.streamOnly &&
        entry.localPlayback !== false &&
        options.localPlayback &&
        !isAudioMutedForEntry(entry);
      const localPlaybackPromise = shouldPlayLocally
        ? playLocalWav(combinedWav, entry).then(
            () => null,
            (error) => error,
          )
        : Promise.resolve(null);

      const mp3Error = await mp3Promise;
      if (mp3Error) throw mp3Error;

      const rendered = {
        ...entry,
        audioUrl: mp3FileName ? `/signalk/v1/api/ajrmMarineAudio/audio/${mp3FileName}` : "",
        publicAudioUrl: mp3FileName ? publicAudioFileUrl(mp3FileName) : "",
        streamUrl: `/plugins/${PLUGIN_ID}/live.mp3`,
        playlistUrl: `/plugins/${PLUGIN_ID}/live.m3u`,
        audioFile: mp3FileName || "",
        renderMode: preparation.textOnly ? "text-only" : "piper",
        renderedAt: new Date().toISOString(),
      };
      Object.assign(entry, rendered);
      publishTimeline("audio-ready", rendered, {
        assetUrl: rendered.audioUrl,
        publicAssetUrl: rendered.publicAudioUrl,
      });
      await fs.promises.writeFile(metadataFile, `${JSON.stringify(rendered, null, 2)}\n`);
      await cleanupGeneratedAudio();
      if (mp3File && entry.streamOutput !== false && !isAudioMutedForEntry(entry)) {
        await broadcastMp3ToLiveStream(mp3File);
      }

      const localPlaybackError = await localPlaybackPromise;
      if (localPlaybackError) throw localPlaybackError;
      rendered.localPlaybackStartedAt = entry.localPlaybackStartedAt || null;
      rendered.localPlaybackCompletedAt = entry.localPlaybackCompletedAt || null;
      rendered.generatedToSpeakerMs = elapsedMs(entry.timestamp, entry.localPlaybackStartedAt);
      rendered.queueToSpeakerMs = elapsedMs(entry.queuedAt, entry.localPlaybackStartedAt);
      rendered.processingToSpeakerMs = elapsedMs(
        entry.processingStartedAt,
        entry.localPlaybackStartedAt,
      );

      lastAnnouncement = rendered;
      addRecentAnnouncement(rendered);
      if (rendered.category !== "stream-health") {
        lastRealAnnouncementAt = Date.now();
      }
      stats.rendered += 1;
      addRecent("rendered", rendered.message);
      return rendered;
    } catch (error) {
      if (entry.cancelledByMute) {
        publishTimeline("muted", entry);
        addRecent("muted", `${entry.message} stopped because audio was muted`);
      } else {
        stats.failed += 1;
        publishTimeline("failed", entry, { error: error.message });
        addRecent("error", `Render failed: ${error.message}`);
        app.error(`[${PLUGIN_ID}] render failed: ${error.stack || error.message}`);
      }
    } finally {
      cleanupPreparedAnnouncement(preparation);
      active = null;
      processQueue();
    }
  }

  function cleanupPreparedAnnouncement(preparation) {
    if (!preparation) return;
    if (preparation.combinedWav) fs.rm(preparation.combinedWav, { force: true }, () => {});
  }

  function shouldPreparedAnnouncementYield(entry) {
    const preparedPriority = Number(entry?.priorityScore || 0);
    return queue.some((queuedEntry) => Number(queuedEntry?.priorityScore || 0) > preparedPriority);
  }

  function requeuePreparedAnnouncement(preparation) {
    const entry = preparation.entry;
    entry.reprioritizedAt = new Date().toISOString();
    queue.push(entry);
    sortAnnouncementQueue();
    cleanupPreparedAnnouncement(preparation);
    publishTimeline("reprioritized", entry);
    addRecent(
      "reprioritized",
      `[priority ${entry.priorityScore}] ${entry.message} yielded to a higher-priority queued announcement`,
    );
  }

  function sortAnnouncementQueue() {
    queue.sort(
      (left, right) =>
        Number(right.priorityScore || 0) - Number(left.priorityScore || 0) ||
        Date.parse(left.timestamp || 0) - Date.parse(right.timestamp || 0),
    );
  }

  function normalizeAnnouncement(value) {
    const ts = String(value.ts || new Date().toISOString());
    const expiresAt =
      value.expiresAt ||
      new Date(Date.parse(ts) + options.generatedAudioExpiresSeconds * 1000).toISOString();
    return {
      id: String(value.id || `announcement-${Date.now()}`),
      requestId: String(value.requestId || value.id || `request-${Date.now()}`),
      playbackId: String(value.playbackId || nextPlaybackId()),
      correlationId: String(value.correlationId || ""),
      subjectKey: String(value.subjectKey || value.vesselId || ""),
      timestamp: ts,
      expiresAt,
      lifecycle: String(value.lifecycle || "event"),
      vesselId: String(value.vesselId || ""),
      mmsi: String(value.mmsi || ""),
      vesselName: String(value.vesselName || ""),
      severity: String(value.severity || "alert"),
      priorityScore: Number(value.priorityScore) || 0,
      preempt: value.preempt !== false,
      category: String(value.category || "cpa"),
      clock: normalizeClock(value.clock),
      sizeCategory: normalizeSizeCategory(value.sizeCategory),
      context: normalizeAnnouncementContext(value.context),
      message: String(value.message || "").trim(),
      sourcePath: String(value.sourcePath || ""),
      receivedAt: String(value.receivedAt || new Date().toISOString()),
      queuedAt: value.queuedAt ? String(value.queuedAt) : null,
      force: value.force === true,
      streamOnly: value.streamOnly === true,
      localPlayback: value.localPlayback !== false,
      streamOutput: value.streamOutput !== false,
    };
  }

  function announcementSupersedeKey(entry) {
    if (!entry || entry.force || entry.category === "stream-health") return "";
    const gpsKey = gpsAnnouncementSupersedeKey(entry);
    if (gpsKey) return gpsKey;
    const subjectKey = String(entry.subjectKey || "").trim();
    if (subjectKey && entry.lifecycle === "active") return `subject:${subjectKey}`;
    const vesselId = String(entry.vesselId || entry.mmsi || "").trim();
    if (vesselId) return `vessel:${vesselId}`;
    const sourcePath = String(entry.sourcePath || "").trim();
    const collisionMatch = sourcePath.match(/^notifications\.collision\.([^.\s]+)$/);
    if (collisionMatch?.[1]) return `collision:${collisionMatch[1]}`;
    return "";
  }

  function supersedeAnnouncementsWithKey(supersedeKey) {
    const key = String(supersedeKey || "");
    if (!key) return 0;
    const previousLength = queue.length;
    queue = queue.filter(
      (queuedEntry) => announcementSupersedeKey(queuedEntry) !== key,
    );
    let removed = previousLength - queue.length;
    const preparingEntry = preparing?.entry || null;
    if (
      preparingEntry &&
      preparingEntry.superseded !== true &&
      announcementSupersedeKey(preparingEntry) === key
    ) {
      preparingEntry.superseded = true;
      removed += 1;
    }
    const preparedEntry = prepared?.entry || null;
    if (
      preparedEntry &&
      preparedEntry.superseded !== true &&
      announcementSupersedeKey(preparedEntry) === key
    ) {
      preparedEntry.superseded = true;
      cleanupPreparedAnnouncement(prepared);
      prepared = null;
      removed += 1;
    }
    return removed;
  }

  function gpsAnnouncementSupersedeKey(entry) {
    const subjectKey = String(entry?.subjectKey || entry?.vesselId || "").trim();
    const category = String(entry?.category || "").trim().toLowerCase();
    const message = String(entry?.message || "");
    if (
      subjectKey === "navigation.gnss.integrity" ||
      subjectKey === "ajrm-marine:traffic:system:gps-received" ||
      subjectKey === ["ais", "plus:system:gps-received"].join("-") ||
      category === "gps" ||
      /\bGPS (received|lost|position is missing|position is invalid)\b/i.test(message)
    ) {
      return "system:gps-state";
    }
    return "";
  }

  function announcementDisplayName(entry) {
    return (
      String(entry?.vesselName || "").trim() ||
      String(entry?.vesselId || entry?.mmsi || "").trim() ||
      "target"
    );
  }

  function clearAudibleWork(reason) {
    const cleared = clearQueuedAnnouncements(reason);
    const stopped = stopActiveLocalPlayback(reason);
    return cleared || stopped;
  }

  function clearQueuedAnnouncements(reason) {
    const originalQueueLength = queue.length;
    const retainedQueue = queue.filter((entry) => canBypassMute(entry));
    const removed = originalQueueLength - retainedQueue.length;
    const preparingEntry = preparing?.entry || null;
    const preparedEntry = prepared?.entry || null;
    const cancelledPreparing =
      preparingEntry &&
      !canBypassMute(preparingEntry) &&
      preparingEntry.superseded !== true;
    const cancelledPrepared =
      preparedEntry &&
      !canBypassMute(preparedEntry) &&
      preparedEntry.superseded !== true;
    queue = retainedQueue;
    if (cancelledPreparing) preparingEntry.superseded = true;
    if (cancelledPrepared) {
      preparedEntry.superseded = true;
      cleanupPreparedAnnouncement(prepared);
      prepared = null;
    }
    if (removed === 0 && !cancelledPreparing && !cancelledPrepared) return false;
    const details = [];
    if (removed > 0) {
      details.push(`dropped ${removed} queued announcement${removed === 1 ? "" : "s"}`);
    }
    if (retainedQueue.length > 0) {
      details.push(`kept ${retainedQueue.length} sound check announcement${retainedQueue.length === 1 ? "" : "s"}`);
    }
    if (cancelledPreparing) details.push("cancelled in-flight preparation");
    if (cancelledPrepared) details.push("discarded prepared announcement");
    addRecent(
      "queue-cleared",
      `${reason}: ${details.join(", ")}`,
    );
    return true;
  }

  function stopActiveLocalPlayback(reason) {
    if (!currentLocalPlaybackChild || !currentLocalPlaybackEntry) return false;
    if (canBypassMute(currentLocalPlaybackEntry)) return false;
    currentLocalPlaybackEntry.cancelledByMute = true;
    currentLocalPlaybackEntry.superseded = true;
    currentLocalPlaybackChild.kill("SIGTERM");
    addRecent("speaker-stopped", `${reason}: stopped current speaker playback`);
    return true;
  }

  function isAudioMuted() {
    return trafficMuted === true;
  }

  function isAudioMutedForEntry(entry) {
    return !canBypassMute(entry) && isAudioMuted();
  }

  function canBypassMute(entry) {
    return entry?.force === true && isSoundCheckEntry(entry);
  }

  function isSoundCheckEntry(entry) {
    return (
      String(entry?.id || "").startsWith("sound-check-") ||
      String(entry?.category || "") === "sound-check" ||
      /^Sound Check\b/i.test(String(entry?.message || ""))
    );
  }

  function buildStatus() {
    const publicStreamBase = publicStreamBaseUrl();
    const localPlaybackState = localPlaybackAvailability();
    const piperPlaybackState = piperPlaybackAvailability();
    const publishedLastAnnouncement = lastAnnouncement
      ? {
          ...lastAnnouncement,
          publicAudioUrl:
            lastAnnouncement.publicAudioUrl ||
            publicAudioFileUrl(lastAnnouncement.audioFile),
        }
      : null;
    return {
      plugin: PLUGIN_ID,
      version: packageInfo.version,
      contract: "ajrm-marine-audio-status",
      contractVersion: 1,
      sessionId: audioSessionId,
      timeline,
      serverTime: new Date().toISOString(),
      enabled: options.enabled,
      muted: isAudioMuted(),
      pluginMuted: false,
      trafficMuted,
      trafficAudioPolicy,
      trafficSessionId,
      trafficAudioPolicySequence: lastTrafficAudioPolicySequence,
      aisPlusMuted: false,
      localPlayback: options.localPlayback,
      localPlaybackAvailable: localPlaybackState.available,
      localPlaybackUnavailableReason: localPlaybackState.reason,
      desktopPlayerOutput: options.desktopPlayerOutput,
      desktopPlayerOutputAvailable: piperPlaybackState.available,
      desktopPlayerOutputUnavailableReason: piperPlaybackState.reason,
      liveStream: options.liveStream,
      liveStreamClients: liveStreamClients.size,
      liveStreamConnections: Array.from(liveStreamClients).map((client) => ({
        id: client.id,
        connectedAt: new Date(client.connectedAt).toISOString(),
        remote: client.remote,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - client.connectedAt) / 1000)),
        writableLength: client.res?.writableLength || 0,
      })),
      streamUrl: `/plugins/${PLUGIN_ID}/live.mp3`,
      playlistUrl: `/plugins/${PLUGIN_ID}/live.m3u`,
      publicHttpStream: options.publicHttpStream,
      publicHttpStreamPort: options.publicHttpStreamPort,
      publicStreamHost: publicStreamHost(),
      publicStreamUseHttps: options.publicStreamUseHttps,
      publicStreamProtocol: publicStreamProtocol(),
      publicStreamUrl: publicStreamBase ? `${publicStreamBase}/live.mp3` : "",
      publicPlaylistUrl: publicStreamBase ? `${publicStreamBase}/live.m3u` : "",
      mp3BitrateKbps: options.mp3BitrateKbps,
      maxStreamLagSeconds: options.maxStreamLagSeconds,
      maxStreamBufferBytes: maxStreamBufferBytes(),
      streamHealthTimeCheck: options.streamHealthTimeCheck,
      streamHealthIntervalMinutes: options.streamHealthIntervalMinutes,
      masterVolumePercent: options.masterVolumePercent,
      speechVolumePercent: options.speechVolumePercent,
      aplayVolumeLevelPercent: options.aplayVolumeLevelPercent,
      aplayVolumeMinimumPercent: MIN_APLAY_VOLUME_LEVEL_PERCENT,
      aplayVolumeMaximumPercent: MAX_APLAY_VOLUME_LEVEL_PERCENT,
      aplayVolumePercent: options.aplayVolumePercent,
      aplayMixerVolumePercent: options.aplayVolumePercent,
      aplayMixerMinimumPercent: MIN_APLAY_MIXER_VOLUME_PERCENT,
      aplayMixerMaximumPercent: MAX_APLAY_MIXER_VOLUME_PERCENT,
      aplayVolumeCommand: options.aplayVolumeCommand,
      aplayVolumeEnabled: Boolean(options.localPlayback && options.aplayVolumeCommand),
      aplayVolumeControl: options.aplayVolumeControl,
      speakerReleaseGapMs: options.speakerReleaseGapMs,
      lastAplayVolumeSetAt,
      lastAplayVolumeError,
      lastAplayVolumeControl,
      pingEnabled: options.pingEnabled,
      pingVolumePercent: options.pingVolumePercent,
      queueLength: queue.length,
      active,
      preparing: preparing?.entry || null,
      prepared: prepared?.entry || null,
      lastAnnouncement: publishedLastAnnouncement,
      recentAnnouncements: recentAnnouncements.map((entry) => ({
        ...entry,
        publicAudioUrl: entry.publicAudioUrl || publicAudioFileUrl(entry.audioFile),
      })),
      recentEvents: recentEvents.slice().reverse(),
      stats,
      droppedLaggingClients,
      streamStats,
      audioDirectory: expandHome(options.audioDirectory),
      voices: listVoices(),
      dependencies: checkDependencies(),
    };
  }

  function checkDependencies() {
    const piper = checkExecutable(options.piperBinary);
    const ffmpeg = checkExecutable(options.ffmpegBinary);
    const audioPlayer = checkExecutable(options.audioPlayer);
    const voices = listVoices();
    const voice = selectedVoiceFromList(voices);
    const voiceDir = expandHome(options.voicesDir);
    const piControllerRunning = Boolean(
      app.getSelfPath?.("plugins.ajrmMarinePiController.version"),
    );
    const missing = [];
    if (piper.status !== "ok") missing.push("Speech engine Piper is not installed yet");
    if (!voice) missing.push("Piper voice model is not installed yet");
    if (ffmpeg.status !== "ok") missing.push("Audio converter FFmpeg is not installed yet");
    if (options.localPlayback && audioPlayer.status !== "ok") {
      missing.push("Server audio player is not installed yet");
    }
    const piperPlaybackAvailable = piperPlaybackAvailability().available;
    const piperInstallAvailable = piper.status !== "ok" || !voice;
    return {
      ok: missing.length === 0,
      summary: missing.length ? missing.join(", ") : "Piper speech engine ready",
      piperPlaybackAvailable,
      piper,
      ffmpeg,
      audioPlayer,
      voice: voice
        ? { status: "ok", id: voice.id, file: voice.file }
        : {
            status: "missing",
            id: options.voice,
            directory: voiceDir,
            message: `No .onnx voice model found in ${voiceDir}`,
          },
      voicesDirectory: voiceDir,
      install: {
        supportedByPiController: true,
        piControllerRunning,
        available: piperInstallAvailable && piControllerRunning,
        endpoint: PIPER_INSTALL_ENDPOINT,
        platform: "raspberry-pi-os-64-bit",
        message:
          piControllerRunning
            ? "The built-in Piper installer is for 64-bit Raspberry Pi OS/Linux aarch64 through AJRM Marine Pi Controller. It is not a Windows or macOS installer."
            : "Install the AJRM Marine Pi Controller Signal K app on a 64-bit Raspberry Pi OS server to use the built-in Piper installer. On Windows, macOS, or other Linux servers, install Piper and FFmpeg manually, then set the Piper executable, FFmpeg executable, Piper voices directory, and voice model in the AJRM Marine Audio plugin configuration.",
      },
    };
  }

  function localPlaybackAvailability() {
    const piper = checkExecutable(options.piperBinary);
    if (piper.status !== "ok") {
      return { available: false, reason: "Speech engine Piper is not installed yet" };
    }
    const voice = selectedVoiceFromList(listVoices());
    if (!voice) {
      return { available: false, reason: "Piper voice model is not installed yet" };
    }
    const audioPlayer = checkExecutable(options.audioPlayer);
    if (audioPlayer.status !== "ok") {
      return { available: false, reason: "Server audio player is not installed yet" };
    }
    return { available: true, reason: "" };
  }

  function piperPlaybackAvailability() {
    const piper = checkExecutable(options.piperBinary);
    if (piper.status !== "ok") {
      return { available: false, reason: "Speech engine Piper is not installed yet" };
    }
    const voice = selectedVoiceFromList(listVoices());
    if (!voice) {
      return { available: false, reason: "Piper voice model is not installed yet" };
    }
    const ffmpeg = checkExecutable(options.ffmpegBinary);
    if (ffmpeg.status !== "ok") {
      return { available: false, reason: "Audio converter FFmpeg is not installed yet" };
    }
    return { available: true, reason: "" };
  }

  function isRadioStreamAvailable() {
    return options.liveStream === true && piperPlaybackAvailability().available === true;
  }

  function checkExecutable(command) {
    const value = String(command || "").trim();
    if (!value) {
      return { status: "missing", command: value, message: "Command is blank" };
    }
    const candidates = value.includes(path.sep)
      ? [value]
      : String(process.env.PATH || "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, value));
    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { status: "ok", command: value, path: candidate };
      } catch {
        // Try the next PATH entry.
      }
    }
    return {
      status: "missing",
      command: value,
      message: value.includes(path.sep)
        ? `${value} is not executable`
        : `${value} was not found on PATH`,
    };
  }

  function listVoices() {
    const dir = expandHome(options.voicesDir);
    try {
      const voices = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".onnx")) {
          voices.push(voiceFromFile(dir, entry.name));
          continue;
        }
        if (!entry.isDirectory()) continue;
        const nestedVoice = path.join(dir, entry.name, `${entry.name}.onnx`);
        if (fs.existsSync(nestedVoice)) voices.push(voiceFromFile(path.join(dir, entry.name), `${entry.name}.onnx`));
      }
      return voices.sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      return [];
    }
  }

  function voiceFromFile(dir, name) {
    const id = name.replace(/\.onnx$/, "");
    return {
      id,
      file: path.join(dir, name),
      selected: options.voice === name || options.voice === id,
    };
  }

  function selectedVoice() {
    return selectedVoiceFromList(listVoices());
  }

  function selectedVoiceFromList(voices) {
    if (!voices.length) return null;
    return (
      voices.find((voice) => voice.selected) ||
      voices.find((voice) => `${voice.id}.onnx` === options.voice) ||
      voices[0]
    );
  }

  function synthesizePiperWav(message, outputFile) {
    const voice = selectedVoice();
    if (!voice) {
      throw new Error(`No Piper voices found in ${expandHome(options.voicesDir)}`);
    }
    return runProcess(
      options.piperBinary,
      ["--model", voice.file, "--output_file", outputFile],
      `${message}\n`,
    );
  }

  function createCombinedWav({ speechWav, pingWav, combinedWav }) {
    const masterVolume = percentToGain(options.masterVolumePercent);
    const speechVolume = percentToGain(options.speechVolumePercent);
    const filter = pingWav
      ? `[0:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[p];[1:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,volume=${speechVolume}[s];[p][s]concat=n=2:v=0:a=1,volume=${masterVolume}[out]`
      : `[0:a]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,volume=${speechVolume * masterVolume}[out]`;
    const inputs = pingWav ? ["-i", pingWav, "-i", speechWav] : ["-i", speechWav];
    return runProcess(options.ffmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      combinedWav,
    ]);
  }

  function createMp3(inputWav, outputMp3) {
    return runProcess(options.ffmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputWav,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      `${options.mp3BitrateKbps}k`,
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
      outputMp3,
    ]);
  }

  async function addLiveStreamClient(res) {
    await ensureLiveSilenceFile();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("icy-name", "AJRM Marine Audio");
    res.setHeader("icy-genre", "Marine Safety");
    res.setHeader("icy-br", String(options.mp3BitrateKbps));
    res.setHeader("icy-pub", "0");
    res.setHeader("icy-metaint", "0");
    res.setHeader("Accept-Ranges", "none");
    res.flushHeaders?.();

    const client = {
      id: nextLiveStreamClientId,
      res,
      connectedAt: Date.now(),
      remote: streamRemoteAddress(res.req),
      disconnecting: false,
    };
    nextLiveStreamClientId += 1;
    liveStreamClients.add(client);
    streamStats.connectedTotal += 1;
    streamStats.lastConnectedAt = new Date(client.connectedAt).toISOString();
    streamStats.lastConnectedRemote = client.remote;
    addRecent(
      "stream-connected",
      `Client ${client.id} connected from ${client.remote}; ${liveStreamClients.size} live stream client(s)`,
    );
    res.on("close", () => closeLiveStreamClient(client, client.disconnectReason || "client closed connection"));

    await writeFileToLiveClient(client, liveSilenceFile);
    startLiveStreamSilence();
  }

  function startPublicStreamServer() {
    if (!options.publicHttpStream || publicStreamServer) return;
    const tlsOptions = publicStreamTlsOptions();
    publicStreamIsHttps = Boolean(tlsOptions);
    const requestHandler = (req, res) => {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (req.method !== "GET") {
        sendPlainResponse(res, 405, "Method not allowed\n", "text/plain; charset=utf-8");
        return;
      }
      if (requestUrl.pathname === "/live.mp3") {
        if (!options.liveStream) {
          sendJsonResponse(res, 404, { error: "Live stream is disabled." });
          return;
        }
        addLiveStreamClient(res).catch((error) => {
          addRecent("error", `Public live stream failed: ${error.message}`);
          if (!res.headersSent) {
            sendJsonResponse(res, 500, { error: error.message });
          } else {
            res.end();
          }
        });
        return;
      }
      if (requestUrl.pathname === "/live.m3u") {
        const host = req.headers.host || `localhost:${options.publicHttpStreamPort}`;
        sendPlainResponse(
          res,
          200,
          `#EXTM3U\n#EXTINF:-1,AJRM Marine Audio\n${publicStreamProtocol()}://${host}/live.mp3\n`,
          "audio/x-mpegurl; charset=utf-8",
        );
        return;
      }
      if (requestUrl.pathname.startsWith("/audio/")) {
        const file = path.basename(decodeURIComponent(requestUrl.pathname.slice("/audio/".length)));
        if (!file.endsWith(".mp3")) {
          sendJsonResponse(res, 404, { error: "Audio file not found." });
          return;
        }
        const filePath = path.join(expandHome(options.audioDirectory), file);
        if (!fs.existsSync(filePath)) {
          sendJsonResponse(res, 404, { error: "Audio file not found." });
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      if (requestUrl.pathname === "/status") {
        sendJsonResponse(res, 200, {
          ok: true,
          plugin: PLUGIN_ID,
          version: packageInfo.version,
          clients: liveStreamClients.size,
          streamStats,
        });
        return;
      }
      sendPlainResponse(res, 404, "Not found\n", "text/plain; charset=utf-8");
    };
    publicStreamServer = tlsOptions
      ? https.createServer(tlsOptions, requestHandler)
      : http.createServer(requestHandler);
    publicStreamServer.on("error", (error) => {
      addRecent("error", `Public stream server failed: ${error.message}`);
      app.error(`[${PLUGIN_ID}] public stream server failed: ${error.stack || error.message}`);
    });
    publicStreamServer.listen(options.publicHttpStreamPort, "0.0.0.0", () => {
      addRecent(
        "stream-server",
        `Listening on ${publicStreamProtocol()}://0.0.0.0:${options.publicHttpStreamPort}`,
      );
    });
  }

  function stopPublicStreamServer() {
    if (!publicStreamServer) return;
    publicStreamServer.close();
    publicStreamServer = null;
    publicStreamIsHttps = false;
  }

  function sendJsonResponse(res, statusCode, body) {
    sendPlainResponse(res, statusCode, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
  }

  function sendPlainResponse(res, statusCode, body, contentType) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  }

  function publicStreamTlsOptions() {
    if (!options.publicStreamUseHttps) return null;
    const configPath = app.config?.configPath || path.join(os.homedir(), ".signalk");
    const keyPath = path.join(configPath, "ssl-key.pem");
    const certPath = path.join(configPath, "ssl-cert.pem");
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      addRecent("warning", `HTTPS stream disabled: ${keyPath} or ${certPath} not found`);
      return null;
    }
    try {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    } catch (error) {
      addRecent("warning", `HTTPS stream disabled: ${error.message}`);
      return null;
    }
  }

  function publicStreamProtocol() {
    return publicStreamIsHttps ? "https" : "http";
  }

  function closeLiveStreamClient(client, reason = "closed") {
    if (!liveStreamClients.has(client)) return;
    client.disconnectReason = reason;
    liveStreamClients.delete(client);
    const disconnectedAt = Date.now();
    streamStats.disconnectedTotal += 1;
    streamStats.lastDisconnectedAt = new Date(disconnectedAt).toISOString();
    streamStats.lastDisconnectedRemote = client.remote || "";
    streamStats.lastDisconnectReason = reason;
    streamStats.lastClientUptimeSeconds = Math.max(
      0,
      Math.round((disconnectedAt - (client.connectedAt || disconnectedAt)) / 1000),
    );
    try {
      if (!client.res.destroyed && !client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // Client has already gone away.
    }
    addRecent(
      "stream-disconnected",
      `Client ${client.id} disconnected: ${reason}; ${liveStreamClients.size} live stream client(s)`,
    );
    if (liveStreamClients.size === 0) {
      stopLiveStreamSilence();
    }
  }

  function startLiveStreamSilence() {
    if (liveSilenceTimer) return;
    liveSilenceTimer = setInterval(() => {
      if (!liveStreamClients.size || Date.now() < liveStreamPauseUntil || !liveSilenceFile) return;
      for (const client of Array.from(liveStreamClients)) {
        if (isStreamClientLagging(client)) {
          closeLaggingLiveStreamClient(client, "silence");
          continue;
        }
        writeFileToLiveClient(client, liveSilenceFile).catch(() =>
          closeLiveStreamClient(client, "write failed during silence"),
        );
      }
    }, 1000);
  }

  function stopLiveStreamSilence() {
    if (liveSilenceTimer) {
      clearInterval(liveSilenceTimer);
      liveSilenceTimer = null;
    }
  }

  async function ensureLiveSilenceFile() {
    const audioDir = expandHome(options.audioDirectory);
    await fs.promises.mkdir(audioDir, { recursive: true });
    const silenceFile = path.join(audioDir, `live-silence-1s-${options.mp3BitrateKbps}k.mp3`);
    if (fs.existsSync(silenceFile)) {
      liveSilenceFile = silenceFile;
      return silenceFile;
    }
    await runProcess(options.ffmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "1",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      `${options.mp3BitrateKbps}k`,
      "-write_id3v1",
      "0",
      "-id3v2_version",
      "0",
      silenceFile,
    ]);
    liveSilenceFile = silenceFile;
    return silenceFile;
  }

  async function broadcastMp3ToLiveStream(mp3File) {
    if (!options.liveStream || liveStreamClients.size === 0 || !fs.existsSync(mp3File)) return;
    const stat = await fs.promises.stat(mp3File);
    liveStreamPauseUntil = Date.now() + estimateMp3DurationMs(stat.size) + 600;
    for (const client of Array.from(liveStreamClients)) {
      if (isStreamClientLagging(client)) {
        closeLaggingLiveStreamClient(client, "announcement");
        continue;
      }
      writeFileToLiveClient(client, mp3File).catch(() =>
        closeLiveStreamClient(client, "write failed during announcement"),
      );
    }
    addRecent("streamed", `Streamed announcement to ${liveStreamClients.size} client(s)`);
  }

  async function writeFileToLiveClient(client, file) {
    if (!client?.res || client.res.destroyed || client.res.writableEnded) {
      closeLiveStreamClient(client, "stream no longer writable");
      return;
    }
    const buffer = await fs.promises.readFile(file);
    await new Promise((resolve, reject) => {
      client.res.write(buffer, (error) => (error ? reject(error) : resolve()));
    });
  }

  function estimateMp3DurationMs(bytes) {
    const bytesPerSecond = Math.max(1, (options.mp3BitrateKbps * 1000) / 8);
    return Math.max(1200, Math.min(30000, Math.round((bytes / bytesPerSecond) * 1000)));
  }

  function maxStreamBufferBytes() {
    return Math.round(((options.mp3BitrateKbps * 1000) / 8) * options.maxStreamLagSeconds);
  }

  function isStreamClientLagging(client) {
    return Number(client?.res?.writableLength || 0) > maxStreamBufferBytes();
  }

  function closeLaggingLiveStreamClient(client, phase) {
    droppedLaggingClients += 1;
    addRecent(
      "stream-lag-reset",
      `Restarted lagging stream during ${phase}; buffered ${client?.res?.writableLength || 0} bytes`,
    );
    closeLiveStreamClient(client, `lag guard during ${phase}`);
  }

  function restartLiveStreamClients(reason) {
    const clients = Array.from(liveStreamClients);
    for (const client of clients) {
      closeLiveStreamClient(client, reason);
    }
    addRecent("stream-restart", `${clients.length} live stream client(s) restarted: ${reason}`);
    return clients.length;
  }

  function startStreamHealthTimer() {
    stopStreamHealthTimer();
    streamHealthTimer = setInterval(() => {
      if (!options.streamHealthTimeCheck || !liveStreamClients.size) return;
      const intervalMs = options.streamHealthIntervalMinutes * 60 * 1000;
      const lastAudioAt = Math.max(lastRealAnnouncementAt, lastStreamHealthAt);
      if (lastAudioAt && Date.now() - lastAudioAt < intervalMs) return;
      enqueue(createStreamTimeCheckAnnouncement(false));
    }, 30 * 1000);
  }

  function stopStreamHealthTimer() {
    if (streamHealthTimer) {
      clearInterval(streamHealthTimer);
      streamHealthTimer = null;
    }
  }

  function startStatusPublisher() {
    stopStatusPublisher();
    statusPublishTimer = setInterval(publishStatus, 2000);
    statusPublishTimer.unref?.();
  }

  function stopStatusPublisher() {
    if (!statusPublishTimer) return;
    clearInterval(statusPublishTimer);
    statusPublishTimer = null;
  }

  function createStreamTimeCheckAnnouncement(force) {
    const now = new Date();
    lastStreamHealthAt = now.getTime();
    const time = now.toLocaleTimeString("en-GB", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return normalizeAnnouncement({
      id: `stream-time-check-${Date.now()}`,
      ts: now.toISOString(),
      severity: "alert",
      category: "stream-health",
      vesselName: "AJRM Marine Audio",
      message: `AJRM Marine Audio time check. Server time is ${time}.`,
      force,
      streamOnly: true,
    });
  }

  function streamRemoteAddress(req) {
    const forwarded = req?.headers?.["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
    return req?.socket?.remoteAddress || req?.connection?.remoteAddress || "unknown";
  }

  function absolutePluginUrl(req, pluginPath) {
    const host = req.get?.("host") || "localhost";
    const forwardedProto = req.get?.("x-forwarded-proto");
    const protocol = forwardedProto || req.protocol || "https";
    return `${protocol}://${host}/plugins/${PLUGIN_ID}${pluginPath}`;
  }

  function publicAudioFileUrl(fileName) {
    if (!options.publicHttpStream || !fileName) return "";
    const publicStreamBase = publicStreamBaseUrl();
    if (!publicStreamBase) return "";
    return `${publicStreamBase}/audio/${encodeURIComponent(fileName)}`;
  }

  function publicStreamBaseUrl() {
    if (!options.publicHttpStream) return "";
    const port = Number(options.publicHttpStreamPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "";
    return `${publicStreamProtocol()}://${publicStreamHost()}:${port}`;
  }

  function publicStreamHost() {
    if (options.publicStreamHost) return options.publicStreamHost;
    if (process.env.EXTERNALHOST) return process.env.EXTERNALHOST;
    const hostname = String(os.hostname?.() || "localhost").trim();
    if (!hostname || hostname === "localhost") return "localhost";
    return hostname.includes(".") ? hostname : `${hostname}.local`;
  }

  async function playLocalWav(file, entry = null) {
    try {
      await applyAplayVolume("playback");
    } catch (error) {
      addRecent("warning", `Local speaker volume not applied before playback: ${error.message}`);
    }
    const startedAt = new Date().toISOString();
    if (entry) {
      entry.localPlaybackStartedAt = startedAt;
      entry.generatedToSpeakerMs = elapsedMs(entry.timestamp, startedAt);
      entry.queueToSpeakerMs = elapsedMs(entry.queuedAt, startedAt);
      entry.processingToSpeakerMs = elapsedMs(entry.processingStartedAt, startedAt);
      entry.preparedToSpeakerMs = elapsedMs(entry.preparedAt, startedAt);
      addRecent(
        "speaker-started",
        `[priority ${entry.priorityScore}] ${entry.message} (provider-to-speaker ${formatDurationMs(entry.generatedToSpeakerMs)}, queued-to-speaker ${formatDurationMs(entry.queueToSpeakerMs)}, synthesis ${formatDurationMs(entry.synthesisMs)}, ready wait ${formatDurationMs(entry.preparedToSpeakerMs)})`,
      );
      publishTimeline("speaker-started", entry, {
        speakerStartedAt: startedAt,
      });
    }
    currentLocalPlaybackEntry = entry;
    try {
    await runProcess(options.audioPlayer, [file], null, (child) => {
        currentLocalPlaybackChild = child;
      });
    } finally {
      currentLocalPlaybackChild = null;
      currentLocalPlaybackEntry = null;
    }
    if (entry) {
      entry.localPlaybackCompletedAt = new Date().toISOString();
      entry.localPlaybackMs = elapsedMs(
        entry.localPlaybackStartedAt,
        entry.localPlaybackCompletedAt,
      );
      publishTimeline("speaker-finished", entry, {
        speakerStartedAt: entry.localPlaybackStartedAt,
        speakerFinishedAt: entry.localPlaybackCompletedAt,
        durationMs: entry.localPlaybackMs,
      });
    }
    if (options.speakerReleaseGapMs > 0) {
      await delay(options.speakerReleaseGapMs);
    }
    if (entry) {
      entry.speakerReleasedAt = new Date().toISOString();
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function announcementExpired(entry, now = Date.now()) {
    if (entry?.force === true || !entry?.expiresAt) return false;
    const expiresAt = Date.parse(entry.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= now;
  }

  function elapsedMs(from, to) {
    const start = Date.parse(from || "");
    const end = Date.parse(to || "");
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, end - start);
  }

  function formatDurationMs(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds)) return "unknown";
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1)} s`;
  }

  function timingAgeText(from, to) {
    return formatDurationMs(elapsedMs(from, to));
  }

  async function applyAplayVolume(reason) {
    if (!options.localPlayback || !options.aplayVolumeCommand) {
      lastAplayVolumeError = "";
      lastAplayVolumeControl = "";
      return false;
    }
    options.aplayVolumeLevelPercent = normalizeAplayVolumeLevelPercent(
      options.aplayVolumeLevelPercent,
      options.aplayVolumePercent,
    );
    const volumePercent = aplayVolumeLevelToMixerPercent(options.aplayVolumeLevelPercent);
    options.aplayVolumePercent = volumePercent;
    let lastError = null;
    for (const control of aplayVolumeControlCandidates(options.aplayVolumeControl)) {
      try {
        await runProcess(options.aplayVolumeCommand, ["sset", control, `${volumePercent}%`]);
        options.aplayVolumePercent = volumePercent;
        lastAplayVolumeSetAt = new Date().toISOString();
        lastAplayVolumeError = "";
        lastAplayVolumeControl = control;
        if (reason !== "playback") {
          addRecent(
            "volume",
            `Local speaker level ${Math.round(options.aplayVolumeLevelPercent)}% set ${control} to ${volumePercent}% (${reason})`,
          );
        } else {
          debug(
            `Local speaker level ${Math.round(options.aplayVolumeLevelPercent)}% set ${control} to ${volumePercent}% before playback`,
          );
        }
        return true;
      } catch (error) {
        lastError = error;
        debug(`Local speaker volume control ${control} failed: ${error.message}`);
      }
    }
    lastAplayVolumeError = lastError?.message || "No ALSA mixer volume control succeeded";
    lastAplayVolumeControl = "";
    throw new Error(lastAplayVolumeError);
  }

  function savePluginOptions(nextOptions) {
    return new Promise((resolve, reject) => {
      if (typeof app.savePluginOptions !== "function") {
        reject(new Error("Signal K savePluginOptions is not available"));
        return;
      }
      app.savePluginOptions(nextOptions, (error) => {
        if (error) {
          reject(error);
          return;
        }
        storedPluginOptions = nextOptions;
        resolve();
      });
    });
  }

  function runProcess(command, args, stdin = null, onSpawn = null) {
    return new Promise((resolve, reject) => {
      const tempBase = path.join(
        os.tmpdir(),
        `${PLUGIN_ID}-process-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const stdinFile = `${tempBase}.stdin`;
      const stderrFile = `${tempBase}.stderr`;
      let stdinFd = null;
      let stderrFd = null;
      let finished = false;
      let child = null;
      let timeoutTimer = null;

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        for (const fd of [stdinFd, stderrFd]) {
          if (fd == null) continue;
          try {
            fs.closeSync(fd);
          } catch {
            // Best-effort cleanup after child process completion.
          }
        }
        stdinFd = null;
        stderrFd = null;
        fs.rm(stdinFile, { force: true }, () => {});
        fs.rm(stderrFile, { force: true }, () => {});
      };
      const readStderr = () => {
        try {
          return fs.readFileSync(stderrFile, "utf8").trim();
        } catch {
          return "";
        }
      };
      const rejectOnce = (error) => {
        if (finished) return;
        finished = true;
        if (child && !child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 1000).unref?.();
        }
        const stderr = readStderr();
        cleanup();
        reject(
          new Error(
            stderr
              ? `${command} failed: ${error.message}: ${stderr}`
              : `${command} failed: ${error.message}`,
          ),
        );
      };

      try {
        if (stdin != null) {
          fs.writeFileSync(stdinFile, stdin);
          stdinFd = fs.openSync(stdinFile, "r");
        }
        stderrFd = fs.openSync(stderrFile, "w");
      } catch (error) {
        cleanup();
        reject(new Error(`${command} failed preparing process IO: ${error.message}`));
        return;
      }

      try {
        child = spawn(command, args, { stdio: [stdinFd ?? "ignore", "ignore", stderrFd] });
        onSpawn?.(child);
      } catch (error) {
        rejectOnce(error);
        return;
      }
      timeoutTimer = setTimeout(() => {
        rejectOnce(new Error(`timed out after ${formatDurationMs(processTimeoutMs())}`));
      }, processTimeoutMs());
      timeoutTimer.unref?.();
      child.on("error", rejectOnce);
      child.on("close", (code) => {
        if (finished) return;
        finished = true;
        const stderr = readStderr();
        cleanup();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        }
      });
    });
  }

  function processTimeoutMs() {
    const envValue = Number(process.env.AJRM_MARINE_AUDIO_PROCESS_TIMEOUT_MS);
    if (Number.isFinite(envValue) && envValue > 0) {
      return Math.max(100, envValue);
    }
    return DEFAULT_PROCESS_TIMEOUT_MS;
  }

  function createPingWav(clock, size = "", pingCount = 1) {
    const sampleRate = 44100;
    const channels = 2;
    const bytesPerSample = 2;
    const toneSamples = Math.max(1, Math.round((sampleRate * 180) / 1000));
    const gapSamples = pingCount > 1 ? Math.max(0, Math.round((sampleRate * 90) / 1000)) : 0;
    const durationSamples = toneSamples * pingCount + gapSamples * (pingCount - 1);
    const dataSize = durationSamples * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);
    const pan = clockToPan(clock);
    const leftGain = Math.cos(((pan + 1) * Math.PI) / 4);
    const rightGain = Math.sin(((pan + 1) * Math.PI) / 4);
    const amplitude = Math.round(32767 * percentToGain(options.pingVolumePercent));
    const frequency = pingFrequencyForSize(size);

    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(bytesPerSample * 8, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < durationSamples; i += 1) {
      const cycleSamples = toneSamples + gapSamples;
      const cycleOffset = cycleSamples > 0 ? i % cycleSamples : i;
      const inTone = cycleOffset < toneSamples;
      const progress = inTone ? cycleOffset / toneSamples : 0;
      const t = cycleOffset / sampleRate;
      const attack = inTone ? Math.min(1, cycleOffset / (sampleRate * 0.012)) : 0;
      const decay = inTone ? Math.exp(-5.2 * progress) : 0;
      const fadeOut = inTone ? Math.min(1, (toneSamples - cycleOffset) / (sampleRate * 0.025)) : 0;
      const envelope = attack * decay * fadeOut;
      const sweptFrequency = frequency * (1 - (1 - 0.72) * progress);
      const phase = 2 * Math.PI * sweptFrequency * t;
      const tone = inTone ? Math.sin(phase) + 0.18 * Math.sin(phase * 2.01) : 0;
      const sample = amplitude * tone * Math.max(0, envelope);
      const offset = 44 + i * channels * bytesPerSample;
      buffer.writeInt16LE(clampPcm16(sample * leftGain), offset);
      buffer.writeInt16LE(clampPcm16(sample * rightGain), offset + 2);
    }

    return buffer;
  }

  function pingFrequencyForSize(size) {
    if (size === "large") return options.pingLargeFrequencyHz;
    if (size === "medium") return options.pingMediumFrequencyHz;
    return options.pingSmallFrequencyHz;
  }

  function pingCountForClock(clock) {
    return clock >= 10 || clock <= 2 ? 1 : 2;
  }

  function clockToPan(clock) {
    const angle = ((clock % 12) / 12) * Math.PI * 2;
    return Math.max(-1, Math.min(1, Math.sin(angle)));
  }

  function extractClockPosition(entry) {
    return normalizeClock(
      entry?.clock ??
      entry?.context?.relativeClockHour ??
      entry?.context?.clockHour,
    );
  }

  function extractVesselSize(entry) {
    return normalizeSizeCategory(entry?.sizeCategory || entry?.context?.vesselSize) || "small";
  }

  function normalizeClock(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 12) return null;
    return Math.round(number);
  }

  function normalizeSizeCategory(value) {
    const clean = String(value || "").toLowerCase();
    return ["small", "medium", "large"].includes(clean) ? clean : "";
  }

  function normalizeAnnouncementContext(context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) return {};
    return {
      ...context,
      relativeClockHour: normalizeClock(context.relativeClockHour),
      clockHour: normalizeClock(context.clockHour),
      vesselSize: normalizeSizeCategory(context.vesselSize),
    };
  }

  function formatMessageForSpeech(message) {
    const vesselFriendly = String(message || "").replace(
      /\b((?:fast\s+)?(?:large vessel|medium vessel|small craft|small vessel|vessel)\s+)(.+?)(\s+at\s+(?:[1-9]|1[0-2])\s+o'?clock\b)/gi,
      (_match, prefix, vesselName, suffix) =>
        `${prefix}${formatVesselNameForSpeech(vesselName)}${suffix}`,
    );
    return expandUnitAbbreviationsForSpeech(vesselFriendly);
  }

  function expandUnitAbbreviationsForSpeech(message) {
    return String(message || "")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*kn\b/gi, "$1 knots")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*kts\b/gi, "$1 knots")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*kt\b/gi, "$1 knots")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*nm\b/gi, "$1 miles")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*nmi\b/gi, "$1 miles")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*m\/s\b/gi, "$1 meters per second")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*m\b/gi, "$1 meters")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*km\b/gi, "$1 kilometers")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*ft\b/gi, "$1 feet")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*deg\b/gi, "$1 degrees")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*min\b/gi, "$1 minutes")
      .replace(/\b(-?\d+(?:\.\d+)?)\s*sec\b/gi, "$1 seconds");
  }

  function formatVesselNameForSpeech(name) {
    const clean = String(name || "").trim();
    const letters = clean.match(/[A-Za-z]/g) || [];
    const uppercaseLetters = clean.match(/[A-Z]/g) || [];
    if (letters.length < 2 || uppercaseLetters.length / letters.length < 0.8) {
      return clean;
    }
    return clean.toLowerCase().replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }

  function cleanupGeneratedAudio() {
    const audioDir = expandHome(options.audioDirectory);
    return fs.promises
      .readdir(audioDir)
      .then((files) =>
        Promise.all(
          files
            .filter((file) => file.endsWith(".mp3") && !file.startsWith("live-silence-1s-"))
            .map(async (file) => {
              const fullPath = path.join(audioDir, file);
              const stat = await fs.promises.stat(fullPath);
              return { fullPath, mtimeMs: stat.mtimeMs };
            }),
        ),
      )
      .then((files) =>
        Promise.all(
          files
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(options.maxAudioFiles)
            .flatMap((item) => [
              fs.promises.rm(item.fullPath, { force: true }),
              fs.promises.rm(item.fullPath.replace(/\.mp3$/, ".json"), { force: true }),
            ]),
        ),
      );
  }

  function ensureAudioDirectory() {
    fs.mkdirSync(expandHome(options.audioDirectory), { recursive: true });
  }

  function nextPlaybackId() {
    audioPlaybackSequence += 1;
    return `${audioSessionId}:${audioPlaybackSequence}`;
  }

  function publishTimeline(state, entry = {}, extra = {}) {
    audioTimelineSequence += 1;
    timeline = {
      contract: "ajrm-marine-audio-timeline",
      contractVersion: 1,
      sessionId: audioSessionId,
      sequence: audioTimelineSequence,
      event: {
        state,
        playbackId: String(entry.playbackId || ""),
        requestId: String(entry.requestId || ""),
        correlationId: String(entry.correlationId || ""),
        subjectKey: String(entry.subjectKey || entry.vesselId || ""),
        priorityScore: Number(entry.priorityScore) || 0,
        message: String(entry.message || ""),
        assetUrl: String(extra.assetUrl || entry.audioUrl || ""),
        publicAssetUrl: String(
          extra.publicAssetUrl || entry.publicAudioUrl || "",
        ),
        occurredAt: new Date().toISOString(),
        ...extra,
      },
    };
    publishStatus();
  }

  function addRecent(event, message) {
    recentEvents.push({
      ts: new Date().toISOString(),
      event,
      message,
    });
    if (recentEvents.length > 80) {
      recentEvents = recentEvents.slice(recentEvents.length - 80);
    }
    publishStatus();
  }

  function addRecentAnnouncement(entry) {
    recentAnnouncements.push({
      ...entry,
      publicAudioUrl: entry.publicAudioUrl || publicAudioFileUrl(entry.audioFile),
    });
    if (recentAnnouncements.length > 20) {
      recentAnnouncements = recentAnnouncements.slice(-20);
    }
  }

  function publishStatus() {
    if (!options || !Object.keys(options).length) return;
    app.handleMessage(PLUGIN_ID, {
      context: "vessels.self",
      updates: [
        {
          values: [
            {
              path: STATUS_PATH,
              value: buildStatus(),
            },
          ],
        },
      ],
    });
  }

  function debug(message) {
    if (options.debugLogging) {
      app.debug(`[${PLUGIN_ID}] ${message}`);
    }
  }

  function expandHome(filePath) {
    const clean = String(filePath || "").trim();
    if (clean === "~") return os.homedir();
    if (clean.startsWith("~/")) return path.join(os.homedir(), clean.slice(2));
    return clean;
  }

  function safeFileSegment(value) {
    return String(value || "announcement")
      .replace(/[^a-z0-9_.-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  function safeFfmpegNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 1;
  }

  function percentToGain(value) {
    return safeFfmpegNumber(value) / 100;
  }

  function normalizePercentValue(percentValue, legacyGainValue, fallbackPercent, maxPercent) {
    const explicitPercent = Number(percentValue);
    if (Number.isFinite(explicitPercent)) {
      return Math.min(maxPercent, Math.max(0, explicitPercent));
    }
    const legacyGain = Number(legacyGainValue);
    if (Number.isFinite(legacyGain)) {
      return Math.min(maxPercent, Math.max(0, legacyGain * 100));
    }
    return fallbackPercent;
  }

  function normalizeAplayVolumeLevelPercent(value, legacyMixerPercent) {
    const level = Number(value);
    if (Number.isFinite(level)) {
      return clampNumber(
        level,
        MIN_APLAY_VOLUME_LEVEL_PERCENT,
        MAX_APLAY_VOLUME_LEVEL_PERCENT,
        DEFAULT_APLAY_VOLUME_LEVEL_PERCENT,
      );
    }
    if (legacyMixerPercent == null || legacyMixerPercent === "") {
      return DEFAULT_APLAY_VOLUME_LEVEL_PERCENT;
    }
    const mixerPercent = Number(legacyMixerPercent);
    if (Number.isFinite(mixerPercent)) {
      return aplayMixerPercentToVolumeLevel(mixerPercent);
    }
    return DEFAULT_APLAY_VOLUME_LEVEL_PERCENT;
  }

  function aplayVolumeLevelToMixerPercent(value) {
    const level =
      clampNumber(
        value,
        MIN_APLAY_VOLUME_LEVEL_PERCENT,
        MAX_APLAY_VOLUME_LEVEL_PERCENT,
        DEFAULT_APLAY_VOLUME_LEVEL_PERCENT,
      ) / MAX_APLAY_VOLUME_LEVEL_PERCENT;
    const curved = (Math.pow(APLAY_VOLUME_LOG_BASE, level) - 1) / (APLAY_VOLUME_LOG_BASE - 1);
    return Math.round(
      MIN_APLAY_MIXER_VOLUME_PERCENT +
        (MAX_APLAY_MIXER_VOLUME_PERCENT - MIN_APLAY_MIXER_VOLUME_PERCENT) * curved,
    );
  }

  function aplayMixerPercentToVolumeLevel(value) {
    const mixerPercent = clampNumber(
      value,
      MIN_APLAY_MIXER_VOLUME_PERCENT,
      MAX_APLAY_MIXER_VOLUME_PERCENT,
      DEFAULT_APLAY_MIXER_VOLUME_PERCENT,
    );
    const normalized =
      (mixerPercent - MIN_APLAY_MIXER_VOLUME_PERCENT) /
      (MAX_APLAY_MIXER_VOLUME_PERCENT - MIN_APLAY_MIXER_VOLUME_PERCENT);
    return Math.round(
      (Math.log10(1 + normalized * (APLAY_VOLUME_LOG_BASE - 1)) /
        Math.log10(APLAY_VOLUME_LOG_BASE)) *
        MAX_APLAY_VOLUME_LEVEL_PERCENT,
    );
  }

  function aplayVolumeControlCandidates(value) {
    const preferred = String(value || DEFAULT_APLAY_VOLUME_CONTROL).trim();
    const candidates = [preferred, ...APLAY_VOLUME_FALLBACK_CONTROLS];
    return candidates.filter((control, index) => control && candidates.indexOf(control) === index);
  }

  function normalizeAplayVolumeCommand(value) {
    const command = String(value == null ? defaultAplayVolumeCommand() : value).trim();
    if (os.platform() === "darwin" && command === DEFAULT_APLAY_VOLUME_COMMAND) {
      return "";
    }
    return command;
  }

  function defaultAplayVolumeCommand() {
    return os.platform() === "darwin" ? "" : DEFAULT_APLAY_VOLUME_COMMAND;
  }

  function clampPcm16(value) {
    return Math.max(-32768, Math.min(32767, Math.round(value)));
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }
};
