# AJRM Marine Audio

## Current release

Version `0.7.2` is the current public release. It renders the provider-neutral
AJRM Marine Notifications audio projection and supports browser speech,
server-rendered Piper audio, an optional server speaker, the radio stream, and
the standalone desktop player. Output routes remain independently selectable;
shared mute policy comes from AJRM Marine Traffic.

Providers may protect safety-critical queued audio with
`delivery.retainUntilDelivered: true`. Audio then keeps that item while it is
queued, rendering, or ready, until delivery or the provider-defined expiry,
even if a newer state for the same subject arrives.

> **Alpha Release disclaimer:** This software is Alpha Release and has not been tested in live environments and must not be relied upon for navigation or safety. The Authors do not accept any responsibility for loss or damage as a result of using this software.

AJRM Marine Audio is the standalone renderer for notification audio-delivery events.

It replaces the older `announce-ais-messages` and standalone Lubuntu speaker paths by rendering each announcement once on the Signal K server:

```text
Standards-compatible Signal K notification
  -> AJRM Marine Notifications audio projection
  -> Piper speech
  -> stereo directional ping
  -> stereo browser-friendly audio file
  -> server speaker, browser/desktop-player playback, and/or radio stream
```

## Architecture

The current implementation consumes the AJRM Marine Notifications audio projection. This gives all providers common priority ordering, subject supersession, freshness, and output instructions without Audio interpreting message content. It creates Piper WAV speech, can prepend the stereo directional ping, creates a browser-friendly MP3, serves generated files from the plugin router, publishes read-only status at `vessels.self.plugins.ajrmMarineAudio`, can play the combined WAV locally on the Signal K server, and exposes generated files plus a continuous radio-style MP3 stream on the public stream port for read-only clients.

The status projection also carries an additive
`plugins.ajrmMarineAudio.timeline` contract with an Audio `sessionId`, monotonic
`sequence`, broker `requestId`, provider `correlationId`, playback identity, and
accepted/queued/synthesis/audio-ready/speaker lifecycle events. Existing
playback behavior is unchanged; diagnostic clients can observe this timeline
without becoming playback authorities.

Local speaker playback starts as soon as Piper speech and the combined WAV are ready. MP3 encoding and live-stream publication proceed alongside speaker playback instead of delaying it. Recent events and the published status include provider, receipt, queue, processing, synthesis, WAV-ready, speaker-start, speaker-finish, and MP3 timestamps so a slow provider, queue backlog, Piper, ALSA, or stream stage can be identified directly.

Audio can pre-render one queued announcement while the current announcement is playing. The prepared WAV starts as soon as the speaker becomes free, while superseded, muted, or expired prepared announcements are still discarded before playback.

Local-speaker priority pre-emption lets a higher-priority prepared notification interrupt a lower-priority announcement. Equal-priority announcements remain sequential, and the event log records both messages.

An interrupted lower-priority announcement restarts after the urgent announcement only while its stable broker subject remains active, fresh, audible, and unsuperseded.

Audio follows the provider's explicit `delivery.preempt` instruction. Routine informational announcements may be queued and pre-rendered but cannot interrupt a message already using the speaker.

When a higher-priority event arrives while Piper is synthesizing a lower-priority event, the completed lower-priority WAV rejoins the queue instead of claiming the speaker ahead of the urgent event.

The local speaker remains reserved for 500 ms after `aplay` exits by default. This protects the final buffered words before the next queued announcement starts; the gap is configurable.

Volume settings are shown as percentages in the Signal K configuration page. Existing pre-`0.2.2` gain settings are migrated automatically, so an old value of `1` becomes `100%`. The local speaker level setting uses a logarithmic curve and applies the matching ALSA mixer volume at AJRM Marine Audio startup and before local `aplay` playback. Level `0%` maps to `66%` on the mixer, level `100%` maps to `100%`, and old linear mixer-volume settings are migrated onto the new curve. It tries the configured mixer control first, then common Pi/ALSA controls such as `PCM`, `Master`, `Headphone`, and `Speaker`. Paths beginning with `~` are expanded for Piper, FFmpeg, audio player, voice, and generated-audio paths.

The radio stream is intended for iPhone/iPad/Android apps that can keep a stream alive while the device is locked.

## Install

```sh
cd ~/.signalk
npm install git+https://github.com/ajrm-marine-suite/signalk-ajrm-marine-audio.git#v0.7.2 --omit=dev --no-package-lock
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

New installations default to the `en_GB-alba-medium` Piper voice when it is
available. Existing installations keep the voice already saved in the Signal K
plugin configuration until changed from the Audio webapp or plugin config.

If the AJRM Marine Pi Controller Signal K app is installed and support actions
are enabled, AJRM Marine Audio can request a Piper install from its dependency
panel. That action is deliberately manual and confirmed; it is not run by npm or
by Signal K AppStore installation. The bundled installer is for 64-bit
Raspberry Pi OS/Linux aarch64. On Windows, macOS, or other Linux servers,
install Piper, FFmpeg, and the selected voice model manually, then set the Piper
executable, FFmpeg executable, Piper voices directory, and voice model in the
AJRM Marine Audio plugin configuration. If Pi Controller is not installed and
running, Audio hides the install button and shows manual-install guidance
instead.

The **Enable directional ping** checkbox sits beside **AJRM Marine Piper playback**.
It defaults off and remains disabled until Piper playback is selected and the
Piper speech render chain is available. The **Local speaker level** slider sets
and saves the logarithmic default level for local `aplay` output, with its
minimum mapped to `66%` mixer volume. The Signal K plugin configuration still
provides the startup defaults and ping volume/frequency settings.

## Standalone Desktop Player

The repository includes the canonical Electron desktop player in
`desktop-player/`. It is intended for Linux, macOS, and Windows machines that
should play AJRM Marine Audio announcements locally without depending on a
browser tab staying awake.

Open AJRM Marine Audio on the computer that should play announcements. Its
**Desktop Audio Player** panel recommends the appropriate installer for that
browser device and also lists every available platform package. Downloading an
installer does not alter the Signal K Raspberry Pi. Operating systems require
the user to open and approve native installers; a web page cannot silently
install software.

The first packaged builds are unsigned previews. Windows and macOS may show a
security warning until project code-signing and Apple notarisation credentials
are configured. Verify that the URL is an official
`ajrm-marine-suite/signalk-ajrm-marine-audio` GitHub Release before opening an
unsigned package.

On Lubuntu:

```sh
sudo apt update
sudo apt install -y git curl ca-certificates

cd ~
git clone https://github.com/ajrm-marine-suite/signalk-ajrm-marine-audio.git
cd signalk-ajrm-marine-audio/desktop-player
./scripts/install-lubuntu.sh
npm start
```

Enter the Signal K server URL when the player opens, for example
`https://boat-pi.local:3443`, `http://boat-pi.local:3000`, or a numeric address such
as `https://192.168.1.50:3443`.

The desktop player is not part of the Signal K plugin package installed by npm;
it is downloaded from this GitHub repository and run on the client machine.
On Lubuntu, `./scripts/install-lubuntu.sh` also configures Electron's
`chrome-sandbox` helper with the required root ownership and `4755` permissions,
then creates an **AJRM Marine Audio Player** launcher in the app menu and on the
desktop where supported.

The source-based Windows procedure remains available for development:

```powershell
cd $HOME
git clone https://github.com/ajrm-marine-suite/signalk-ajrm-marine-audio.git
cd signalk-ajrm-marine-audio\desktop-player
npm install
npm run start:windows
```

Windows, macOS, AppImage, and Debian/Ubuntu packages are built by the
`audio-player-v*` release workflow. Windows and macOS still need real-machine
audio and installer testing. Full player instructions and the tester checklist
are in `desktop-player/README.md`.

When Signal K security is enabled, the desktop player expects Signal K read-only
access to be enabled. It does not store Signal K login credentials.

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

This traffic should stay on the local boat LAN when the stream URL uses the local Pi hostname, for example `boat-pi.local`. It should not use the boat router's cellular data unless the phone is no longer on the boat Wi-Fi, the hostname is being resolved through a remote/VPN route, or the router is configured to hairpin local traffic through an internet service.

For normal use, keep the phone on the boat Wi-Fi and use the local `.local` address. Do not publish or port-forward the stream port to the internet.

## Responsibilities

- Providers decide notification meaning and publish standard Signal K notifications.
- AJRM Marine Notifications applies priority, lifecycle, supersession, history, and delivery mechanics.
- AJRM Marine Audio renders the broker's audio projection without classifying content.
- Browsers and the standalone desktop player can play rendered audio.
- A native radio player can play the live stream while the phone or tablet is locked.

## Queue Behaviour

AJRM Marine Audio keeps the current speaker announcement uninterrupted. When a new vessel announcement is queued, any older queued announcements for the same vessel are dropped before the new one is added. This keeps busy-area speech focused on the latest known state, including de-escalations from collision alarm back to advisory.

When AJRM Marine Traffic Audio Policy is muted, AJRM Marine Audio suppresses
further announcements except Sound Check and stops active playback so stale
speech cannot continue after muting.

## Notes

- Requires Piper and FFmpeg on the Signal K server.
- Generated audio must be treated as time-limited; stale collision warnings should not auto-play.
- The Signal K server remains the only place that needs Piper installed.


## Public Beta

Speech and audio delivery for AJRM Marine Suite notifications.

Development assistance: OpenAI Codex helped with code generation, refactoring, and automated testing during the beta development cycle.
## License and commercial use

This software is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You may use, study, share, and modify it under that licence. If you modify it and make it available to users over a network, the corresponding source code must also be made available under the AGPL.

Commercial licensing is available by arrangement for organisations that want different terms.
