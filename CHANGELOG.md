# Changelog

## 0.5.64

- Render saved output-routing status immediately so the Audio webapp shows
  **Desktop Player off** as soon as the Electron/Desktop Player output switch
  is disabled.
- Treat enabled Desktop Player output as a valid server-rendered Sound Check
  route when browser, server speaker, and radio stream outputs are off.

## 0.5.63

- Add an explicit **Electron/Desktop Player output** switch to Audio output
  routing, defaulting on for existing behaviour.
- Report Desktop Player output availability and status in the Audio status
  contract.
- Make the bundled desktop player stop queuing server announcements when Audio
  disables Desktop Player output.
- Bump the bundled desktop player to `0.1.15`.

## 0.5.62

- Expand common marine unit abbreviations before sending text to Piper, so
  `kn`, `m/s`, `m`, `NM`, `ft`, `deg`, `min`, and `sec` are spoken as words
  while preserving the original written announcement text.

## 0.5.61

- Make the desktop player wait briefly for a newly observed announcement's
  generated MP3 URL before skipping it. This avoids noisy "no audio URL"
  diagnostics when the status feed sees an announcement just before rendering
  has finished.
- Bump the bundled desktop player to `0.1.13`.

## 0.5.60

- Add desktop-player diagnostics for connection attempts, status failures,
  newly queued announcements, MP3 download, playback start/end/error, retries,
  and window focus/visibility changes.
- Show the desktop-player diagnostic log path in the app and persist the log to
  Electron's user-data directory so missed-audio faults can be reviewed after a
  soak run.

## 0.5.59

- Continue processing the announcement queue after dropping an expired prepared
  announcement, so later forced or valid announcements cannot be stranded behind
  stale rendered audio.

## 0.5.58

- Add a watchdog around external audio renderer/player processes so a hung
  Piper, ffmpeg, or local player command cannot block the announcement queue
  indefinitely.
- Add a regression test that deliberately hangs Piper and verifies Audio times
  out the renderer, records a failure, and continues draining the queue.

## 0.5.49

- Keep forced test announcements, including BITE audible summaries, in the
  queue when Traffic stationary automute activates and clears ordinary queued
  audio.
- Add a regression test for a forced BITE summary queued behind active playback
  when automute switches on.

## 0.5.48

- Honour forced Notifications audio requests so explicit test announcements,
  such as BITE audible summaries, can bypass Traffic stationary automute in the
  same way as Sound Check.

## 0.5.47

- Keep desktop-player status and audio fetch failures inside the app UI instead
  of letting expected network timeouts or socket resets log noisy Electron IPC
  handler exceptions to the terminal.

## 0.5.46

- Add a desktop-player **Sound Check** button that replays the latest cached
  server-rendered Sound Check MP3 for local volume setting.
- Cache the received Sound Check MP3 locally so the selected server voice is
  reused without requiring Piper on the desktop machine.

## 0.5.45

- Make the desktop player prefer `publicAudioUrl` over the authenticated
  `audioUrl`, so generated announcements play when Signal K security is enabled
  with read-only access.
- Make audio-download 401/403 messages refer to the audio file, not the status
  request.

## 0.5.44

- Fetch desktop-player announcement MP3 files through Electron's main process
  and play them from local data URLs, so local self-signed Signal K HTTPS
  certificates do not stop playback.

## 0.5.43

- Keep desktop-player connection simple: no stored Signal K credentials.
- Show a clear read-only-access message when Signal K security returns HTTP
  401/403 for the Audio status endpoint.

## 0.5.42

- Let the desktop player follow Signal K's HTTP-to-HTTPS redirect instead of
  reporting HTTP 302 as a connection failure.
- Show clearer connection-refused messages when the Signal K server is down.
- Quit the desktop player when its window is closed, including on macOS.

## 0.5.41

- Add a desktop-player **Auto-connect** option. When enabled, the player
  connects automatically on startup and retries once a minute if the Signal K
  server is not yet available.

## 0.5.40

- Move desktop-player status polling through Electron's main process so local
  self-signed Signal K HTTPS certificates do not produce repeated Chromium
  `net_error -202` terminal noise while idle.

## 0.5.39

- Let the desktop player return to the disconnected state after a failed first
  connection attempt, so the server URL can be corrected and Connect pressed
  again without using Disconnect first.

## 0.5.38

- Configure Electron's Linux `chrome-sandbox` helper in the Lubuntu player
  installer and document the manual repair command.
- Create an **AJRM Marine Audio Player** desktop/app-menu launcher during the
  Lubuntu player install.
- Add a `start:no-sandbox` diagnostic fallback for the desktop player.

## 0.5.37

- Add the standalone AJRM Marine Audio Player under `desktop-player/`, with
  Lubuntu install instructions and a small install helper.

## 0.5.36

- Clarify the `Announcement freshness window` configuration description: it
  drops stale queued or prepared announcements unless the provider supplies its
  own expiry.

## 0.5.35

- Revert browser announcement queueing from `0.5.34`. Browser playback is now
  deliberately simple convenience output again; reliable FIFO playback belongs
  in the standalone AJRM Marine Audio Player.
- Keep rendered announcement history in Audio status for external clients, but
  do not use it to backfill browser audio when a tab regains attention.

## 0.5.34

- Queue browser Piper playback and browser speech locally so a new announcement
  waits for the current browser announcement to finish instead of interrupting
  it.
- Use recent rendered announcements as browser delivery input so rapid alert
  bursts are played in order when the page is open.
  Superseded by `0.5.35`.

## 0.5.33

- Remove Audio's server-wide manual mute control from output routing. Shared
  muting now follows AJRM Marine Traffic Audio Policy only.
- Keep browser muting local to each browser/device so one display cannot mute
  the server speaker, radio stream, or another browser.

## 0.5.32

- Gate the external fake Piper/FFmpeg/aplay pipeline regression tests to
  platforms where those fake process controls are reliable; Windows and 32-bit
  ARM still run the static, configuration, status, queue, mute, and packaging
  checks.

## 0.5.31

- Make the standalone Audio regression test exit explicitly on success or
  failure so lingering platform-specific handles cannot leave Windows CI jobs
  running until cancellation.

## 0.5.30

- Replace shell-script fake audio commands in the test harness with
  cross-platform Node-backed commands so Windows CI can exercise the audio
  pipeline tests.

## 0.5.29

- Make the nested Piper voice regression test accept Windows path separators
  so the Signal K plugin CI matrix completes cleanly on Windows.

## 0.5.28

- Add Signal K AppStore relationship metadata recommending AJRM Marine Pi
  Controller for users who want the assisted Piper installer.
- Add the reusable Signal K plugin CI workflow.

## 0.5.24

- Treat active Notifications Plus subjects as supersedable audio work, so
  repeated updates for one instrument or traffic target drop stale queued and
  prepared announcements before adding the newest one.
- Add regression coverage for falling-depth instrument updates and traffic
  advisory-to-collision escalation while the speaker is already busy.

## 0.5.23

- Include a bounded `recentAnnouncements` list in Audio status so browser
  clients do not miss rapid collision/advisory bursts when a later lower
  priority announcement becomes `lastAnnouncement`.

## 0.5.22

- Reduce Audio page status polling noise: 5 seconds when opened directly and
  10 seconds when embedded in Console.
- Update Audio static asset cache-busting to match the release version.

## 0.5.21

- Treat announcements as text-only when the Piper render chain is unavailable,
  so browser-speech-only setups do not fail with `spawn piper ENOENT`.

## 0.5.20

- Keep passive Audio status polling away from the Signal K login-status route
  after authentication failures, and retry unauthenticated status checks at a
  slower interval.

## 0.5.19

- Throttle Audio webapp status polling after Signal K authentication failures
  so an unauthenticated browser tab does not flood the Signal K log.

## 0.5.18

- Clarify that the mute-all switch does not suppress Sound Check.

## 0.5.17

- Clarify that AJRM Marine Pi Controller is a Signal K app when explaining the
  optional built-in Piper installer.

## 0.5.16

- Grey disabled buttons and remove their pressed/3D interaction state.

## 0.5.15

- Default directional ping to off for fresh installs.
- Move the directional ping control beside AJRM Marine Piper playback and keep
  it disabled until Piper playback is selected and available.
- Grey disabled toggle labels as well as the controls.
- Clarify that manual Piper/FFmpeg paths are configured in the AJRM Marine
  Audio plugin configuration.

## 0.5.14

- Let Sound check and Repeat last use browser speech locally when that is the
  only selected output.
- Disable Restart streams and Stream time check unless the radio stream is on
  and the Piper speech render chain is available.
- Make the radio stream panel show off/unavailable status instead of a naked
  URL when the stream cannot work.
- Use friendlier missing dependency wording for the Piper voice model, FFmpeg,
  and the server audio player.
- Disable the directional ping checkbox until Piper-rendered audio is available.

## 0.5.13

- Disable radio stream output until Piper, a voice model, and FFmpeg are
  available.
- Reject direct attempts to enable radio stream output when the speech render
  chain cannot work.
- Make Sound check report when no browser, server speaker, or radio stream
  output is selected.

## 0.5.12

- Use clearer wording when Piper is missing: "Speech engine Piper is not
  installed yet."

## 0.5.11

- Remove the non-actionable Renderer information panel from the Audio webapp
  and rename the remaining dependency heading to Speech dependencies.
- Disable browser Piper playback until Piper, a voice model, and FFmpeg are
  available.
- Disable the local speaker level slider until server speaker output can work.

## 0.5.10

- Default server speaker output to off for fresh installs.
- Default radio stream output and its local stream port to off for fresh
  installs.
- Keep the server speaker checkbox unavailable until Piper, a voice model, and
  a local audio player are present.
- Reject attempts to enable server speaker output when the local playback chain
  cannot work; installing Piper does not silently enable speaker output.
- Add punctuation between dependency status and install guidance in the webapp.

## 0.5.9

- Rename visible Pi speaker wording to server speaker output.
- Clarify that the built-in Piper install action is for 64-bit Raspberry Pi
  OS/Linux aarch64 via AJRM Marine Pi Controller, not Windows or macOS.

## 0.5.8

- Align web asset cache keys and install documentation with the package version.

## 0.5.7

- Include the MIT license file in the published package.

## 0.5.6

- Update public install command to the current release tag.

## 0.5.5

- Update Audio documentation to use AJRM Marine Traffic audio-policy terminology.

## 0.5.4

- Prefer AJRM Marine audio contracts, generated-audio defaults, and browser device IDs while accepting legacy Traffic audio-policy contracts during upgrades.

## 0.5.3

- Prefer the broker audio-request message for speech, allowing providers to keep written notifications detailed while sending shorter spoken text.

## 0.5.2

- Prefer the authenticated Signal K audio route for browser playback inside the Audio webapp.
- Derive public stream URLs from an optional configured host, `EXTERNALHOST`, or the Pi hostname instead of falling back to the previous test hostname.

## 0.5.1

- Enable AJRM Marine Audio by default for fresh Signal K installs.
- Show a clearer offline diagnostic when the Audio plugin route is not active.
- Refresh web asset cache keys for the public beta package version.

## 0.5.0

- Initial public beta release as AJRM Marine Audio.
