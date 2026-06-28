# AJRM Marine Audio

## Version 2 baseline

`v0.5.13` disables radio stream output until the Piper speech render chain is
available and makes Sound check report clearly when no output is selected.
`v0.5.12` uses clearer wording when Piper is missing. `v0.5.11` removes the
non-actionable Renderer information panel from the Audio webapp, renames the
remaining dependency heading to Speech dependencies, and disables Piper browser
playback plus the local speaker level slider until the required server-side
speech/local playback tools are present.
`v0.5.10` defaults server speaker and radio stream output to off for fresh
installs, keeps server speaker unavailable until Piper, a voice model, and a
local audio player are present, and does not silently enable it after Piper
installation. `v0.5.9` renames visible Pi speaker wording to server speaker
output and clarifies that the built-in Piper install action is only for 64-bit
Raspberry Pi OS/Linux aarch64 through AJRM Marine Pi Controller. It is not a
Windows or macOS installer.

`v0.5.3` prefers the broker audio-request message for speech, so written
notifications can keep identifiers such as MMSI without Piper reading them out.

`v0.5.0` treats GPS received/lost announcements as mutually exclusive GPS
state messages, so a later GPS lost event drops any stale queued or prepared
GPS received announcement before it can be spoken.

`v0.5.0` adds runtime dependency checks for Piper, FFmpeg, the configured
voice model, and local audio playback. The webapp shows missing renderer
dependencies and can ask AJRM Marine Pi Controller to install Piper as an explicit user
action; npm/AppStore installation does not run OS-level installers silently.

`v0.5.0` gives AJRM Marine Audio command buttons raised/pressed visual states
and a short command-sent pulse so touchscreen taps are visibly acknowledged.

`v0.5.0` lets AJRM Marine Console host browser announcement playback from its
root window. When Audio is embedded by Console it still shows and saves browser
output settings, but suppresses its own iframe playback to avoid double speech.
Opened directly, AJRM Marine Audio remains fully standalone.

`v0.5.0` makes Audio mute authority explicit: only AJRM Marine Audio's manual
mute and AJRM Marine Traffic Audio Policy can mute playback. Provider
`delivery.muteState` flags are ignored by Audio.

`v0.5.0` removes old AJRM Marine wording from visible Audio status and
configuration labels.

`v0.5.0` replaces the browser playback checkbox with an explicit browser output
mode: Off, browser speech synthesis, or AJRM Marine Piper playback. Server speaker,
radio stream, and mute remain independent switches.

`v0.5.0` keeps AJRM Marine Audio as the browser-audio authority on each device
so the older simple browser speech setting cannot clash with Piper browser
playback.

`v0.5.0` deduplicates repeated Notifications Plus audio requests by request ID
and prevents the webapp from autoplaying an old last announcement when the
AJRM Marine Audio tab is reopened from Console.

`v0.5.0` completes the public webapp naming pass: visible labels now say
AJRM Marine Audio, and the main page no longer presents Piper as the app name.

`v0.5.0` promotes the current Notifications Plus renderer, server speaker pipeline,
and live-stream implementation as the working audio baseline. It does not yet
implement the proposed authoritative synchronized playback contract and does
not intentionally change runtime behavior from `v0.5.0`.

`v0.5.0` carries rendered authenticated/public asset URLs in the authoritative
timeline as soon as MP3 rendering completes. Server speaker playback remains on
the fastest WAV-ready path and is never delayed for Companion.

`v0.5.0` observes the versioned AJRM Marine Traffic Audio Policy projection.
Traffic mute and stationary automute are enforced only when that projection is
explicitly authoritative in Traffic mode. Shadow policy remains observable but
cannot mute Audio. Session changes reset sequence tracking and stale or
non-monotonic policy updates are ignored.

`v0.5.0` suppressed repeated no-op provider-mute queue-clear events; provider
mute flags are ignored entirely by Audio from `v0.5.0`.

`v0.5.0` restores output routing controls in the AJRM Marine Audio webapp. Browser
playback is a local per-device setting, while server speaker output, radio stream
output, and mute-all are saved on the Signal K server as Audio-owned settings.

`v0.5.0` added a session-scoped playback lifecycle timeline for observation and
measurement. Existing server speaker, stream, and browser playback behavior is
unchanged.

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AJRM Marine Audio is the standalone renderer for notification audio-delivery events.

It replaces the older `announce-ais-messages` and standalone Lubuntu speaker paths by rendering each announcement once on the Signal K server:

```text
Standards-compatible Signal K notification
  -> Notifications Plus audio projection
  -> Piper speech
  -> stereo directional ping
  -> stereo browser-friendly audio file
  -> server speaker playback, Companion playback, and/or native radio player stream
```

## Current State

Version `1.4.7` consumes the Notifications Plus audio projection. This gives all providers common priority ordering, subject supersession, freshness, and output instructions without Audio interpreting message content. It creates Piper WAV speech, can prepend the stereo directional ping, creates a browser-friendly MP3, serves generated files from the plugin router, publishes read-only status at `vessels.self.plugins.ajrmMarineAudio`, can play the combined WAV locally on the Signal K server, and exposes generated files plus a continuous radio-style MP3 stream on the public stream port for read-only clients.

The status projection also carries an additive
`plugins.ajrmMarineAudio.timeline` contract with an Audio `sessionId`, monotonic
`sequence`, broker `requestId`, provider `correlationId`, playback identity, and
accepted/queued/synthesis/audio-ready/speaker lifecycle events. Existing
playback behavior is unchanged; Companion should observe and measure this
timeline before using it as its playback authority.

Local speaker playback starts as soon as Piper speech and the combined WAV are ready. MP3 encoding and live-stream publication proceed alongside speaker playback instead of delaying it. Recent events and the published status include provider, receipt, queue, processing, synthesis, WAV-ready, speaker-start, speaker-finish, and MP3 timestamps so a slow provider, queue backlog, Piper, ALSA, or stream stage can be identified directly.

Version `1.4.2` also pre-renders one queued announcement while the current announcement is playing. The prepared WAV starts as soon as the speaker becomes free, while superseded, muted, or expired prepared announcements are still discarded before playback.

Version `1.4.3` adds local-speaker priority pre-emption. Once a higher-priority prepared notification is ready, it interrupts a lower-priority announcement currently playing and takes the speaker. Equal-priority announcements remain sequential. The event log records both the interrupted and interrupting messages.

Version `1.4.4` restarts an interrupted lower-priority announcement from the beginning after the urgent announcement, but only when its stable broker subject remains active and it is still fresh, audible, and unsuperseded.

Version `1.4.5` follows the provider's explicit `delivery.preempt` instruction. Routine informational announcements may be queued and pre-rendered but cannot interrupt any message already using the speaker.

Version `1.4.6` closes a preparation race: when a higher-priority event arrives while Piper is synthesizing a lower-priority event, the completed lower-priority WAV must rejoin the queue instead of claiming the speaker ahead of the newer urgent event.

Version `1.4.7` keeps the local speaker reserved for 500 ms after `aplay` exits. This protects the final buffered words before the next queued announcement starts. The gap is configurable in the plugin settings.

Volume settings are shown as percentages in the Signal K configuration page. Existing pre-`0.2.2` gain settings are migrated automatically, so an old value of `1` becomes `100%`. The local speaker level setting uses a logarithmic curve and applies the matching ALSA mixer volume at AJRM Marine Audio startup and before local `aplay` playback. Level `0%` maps to `66%` on the mixer, level `100%` maps to `100%`, and old linear mixer-volume settings are migrated onto the new curve. It tries the configured mixer control first, then common Pi/ALSA controls such as `PCM`, `Master`, `Headphone`, and `Speaker`. Paths beginning with `~` are expanded for Piper, FFmpeg, audio player, voice, and generated-audio paths.

The radio stream is intended for iPhone/iPad/Android apps that can keep a stream alive while the device is locked.

## Install

```sh
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-audio.git#v0.5.13 --omit=dev --no-package-lock
sudo systemctl restart signalk
```

Open **AJRM Marine Audio** from the Signal K webapps page.

Piper is optional at install time. Browser speech synthesis can be used without
Piper, but server speaker playback, Piper browser playback, and the radio stream
need Piper, a Piper voice model, and FFmpeg on the Signal K server. AJRM Marine
Audio reports missing renderer dependencies on its page and in
`vessels.self.plugins.ajrmMarineAudio.dependencies`.

Server speaker output and radio stream output default to off. The webapp only
allows server speaker output to be enabled when Piper, the selected voice model,
and the configured local audio player are available. Installing Piper through Pi
Controller makes the output available but does not turn the speaker on
automatically.

If AJRM Marine Pi Controller is installed and support actions are enabled, AJRM Marine Audio
can request a Piper install from its dependency panel. That action is deliberately
manual and confirmed; it is not run by npm or by Signal K AppStore installation.
The bundled installer is for 64-bit Raspberry Pi OS/Linux aarch64. On Windows,
macOS, or other Linux servers, install Piper, FFmpeg, and the selected voice
model yourself and point Audio at those paths in the plugin settings. If
Pi Controller is not installed and running, Audio hides the install button and
shows manual-install guidance instead.

The **Enable directional ping** checkbox in the AJRM Marine Audio webapp can switch the ping on or off immediately while Signal K is running. The **Local speaker level** slider sets and saves the logarithmic default level for local `aplay` output, with its minimum mapped to `66%` mixer volume. The Signal K plugin configuration still provides the startup defaults and ping volume/frequency settings.

## Radio Stream

The radio stream is the best iPhone/iPad option when the screen may be locked. Browser and PWA audio normally stops when iOS suspends the page, but a native radio player can keep an already-open stream alive in the background.

Use this local stream URL in a radio player app:

```text
https://<your-server-hostname>.local:3445/live.mp3
```

Station name:

```text
AJRM Marine Audio
```

Some apps prefer an M3U playlist:

```text
https://<your-server-hostname>.local:3445/live.m3u
```

The local stream port serves only the generated audio stream, so native radio player apps do not need a Signal K login cookie. It uses the same `ssl-cert.pem` and `ssl-key.pem` as Signal K when they are available. The stream sends silence between announcements and writes each rendered AJRM Marine announcement into the stream as it is produced.

If `.local` hostnames are not suitable, set **Public stream host** in the plugin configuration to a numeric address or VPN hostname, for example `192.168.3.50`.

### iPhone/iPad Setup

1. Install a radio stream player app.
2. Add a custom station using `https://<your-server-hostname>.local:3445/live.mp3`.
3. Name it `AJRM Marine Audio`.
4. Start the station while connected to the boat Wi-Fi.
5. Trigger **Sound check** in the AJRM Marine Audio webapp.
6. Lock the phone and trigger another **Sound check** to confirm background playback.

If the app asks for a playlist rather than a direct stream, use `https://<your-server-hostname>.local:3445/live.m3u`.

### Network Use

The stream is unicast, not broadcast. Each connected radio app opens one direct TCP/TLS connection to the Pi. It is therefore limited to the network path between that device and the Pi when the device is connected to the boat Wi-Fi.

At the default 64 kbit/s MP3 stream rate, allow roughly:

```text
8 KB/s per connected player
29 MB/hour per connected player
700 MB/day per connected player if left running continuously
```

The bitrate is configurable in the Signal K plugin settings as **MP3 stream bitrate (kbit/s)**.

### Stream Lag Guard

AJRM Marine Audio treats the radio stream as live audio, not as a podcast queue. If a player falls too far behind, the server closes that stream instead of writing a fresh announcement behind old buffered silence. The player should then reconnect and resume from the current live stream.

The lag limit is configurable as **Maximum stream lag before reconnect (seconds)** and defaults to 30 seconds.

Use **Restart streams** in the AJRM Marine Audio webapp to test whether a radio app reconnects automatically after the stream is deliberately closed. If it does not reconnect, start the station manually again in the radio app.

### Stream Time Check

Enable **Announce time on live stream** to periodically speak the Signal K server time into the radio stream. This is a practical drift test: if the announcement says a time that is several minutes behind the actual time, the player has built up too much buffer delay.

The interval is configurable as **Live stream time-check interval (minutes)**. The manual **Stream time check** button sends one time announcement immediately. Time checks are stream-only and are not played on the server speaker. The webapp displays the current server time so the spoken time can be compared with the server clock.

### Stream Diagnostics

The AJRM Marine Audio webapp shows current stream clients, total connects/disconnects, client uptime, server-side write buffer size, and the last disconnect reason. The stream also sends basic ICY radio headers (`icy-name`, `icy-genre`, `icy-br`) so native radio players can recognise it as a radio-style stream.

This traffic should stay on the local boat LAN when the stream URL uses the local Pi hostname, for example `nemo.local`. It should not use the boat router's cellular data unless the phone is no longer on the boat Wi-Fi, the hostname is being resolved through a remote/VPN route, or the router is configured to hairpin local traffic through an internet service.

For normal use, keep the phone on the boat Wi-Fi and use the local `.local` address. Do not publish or port-forward the stream port to the internet.

## Responsibilities

- Providers decide notification meaning and publish standard Signal K notifications.
- Notifications Plus applies priority, lifecycle, supersession, history, and delivery mechanics.
- AJRM Marine Audio renders the broker's audio projection without classifying content.
- AJRM Marine Companion can play the rendered audio while open.
- A native radio player can play the live stream while the phone or tablet is locked.

## Queue Behaviour

AJRM Marine Audio keeps the current speaker announcement uninterrupted. When a new vessel announcement is queued, any older queued announcements for the same vessel are dropped before the new one is added. This keeps busy-area speech focused on the latest known state, including de-escalations from collision alarm back to advisory.

When AJRM Marine Audio is manually muted or AJRM Marine Traffic Audio Policy is muted,
AJRM Marine Audio suppresses further non-forced announcements until sounds are
enabled again. It does not interrupt an announcement already playing on the local
speaker.

## Notes

- Requires Piper and FFmpeg on the Signal K server.
- Generated audio must be treated as time-limited; stale collision warnings should not auto-play.
- The Signal K server remains the only place that needs Piper installed.


## Public Beta

Speech and audio delivery for AJRM Marine Suite notifications.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
