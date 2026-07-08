# AJRM Marine Audio Player

Standalone desktop player for AJRM Marine Audio announcements on Lubuntu,
macOS, and Windows.

This app is deliberately a player, not an alert engine. AJRM Marine Audio on
the Signal K server renders and prioritises announcements. The desktop player
connects to that server, watches for newly rendered announcements, and plays
them locally in FIFO order.

The player shows a short diagnostics panel and writes the same events to a
local log file. The log records connection attempts, status failures, queued
announcements, MP3 download, playback start/end/error, retries, and window
focus/visibility changes. Use it to distinguish a server-side audio problem
from a desktop-player output or background/focus problem.

If the player sees a new announcement before AJRM Marine Audio has published
the generated MP3 URL, it waits briefly for a later status poll before skipping
that announcement. This avoids false "no audio URL" skips during busy tests or
slow rendering.

## Lubuntu Install

Install Node.js 20 or later, then clone the Audio repository and run the player
from the `desktop-player` directory:

```sh
sudo apt update
sudo apt install -y git curl ca-certificates

cd ~
git clone https://github.com/ajrm-marine-suite/signalk-ajrm-marine-audio.git
cd signalk-ajrm-marine-audio/desktop-player
./scripts/install-lubuntu.sh
npm start
```

The install script also creates an **AJRM Marine Audio Player** launcher in the
desktop/app menu and, where the desktop folder exists, on the desktop itself.

If `node --version` reports a version older than `20`, install a current Node.js
release first. One common route on Ubuntu/Lubuntu is:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

If the repository is already cloned:

```sh
cd ~/signalk-ajrm-marine-audio
git pull --ff-only
cd desktop-player
./scripts/install-lubuntu.sh
npm start
```

If Electron reports missing desktop libraries on a minimal Lubuntu install,
install the common runtime packages:

```sh
sudo apt install -y libgtk-3-0 libnss3 libxss1 libatk-bridge2.0-0 libasound2t64
```

On older Ubuntu releases the audio package may be named `libasound2` instead of
`libasound2t64`.

Electron on Linux also needs its `chrome-sandbox` helper to be owned by root
with mode `4755`. The install script configures this automatically. To repair an
existing install manually:

```sh
cd ~/signalk-ajrm-marine-audio/desktop-player
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
npm start
```

As a last-resort diagnostic only, the player can be started without the Electron
sandbox:

```sh
npm run start:no-sandbox
```

To recreate the desktop launcher after moving or updating the repository, rerun:

```sh
./scripts/install-lubuntu.sh
```

## Windows Test Install

The Windows desktop player is not yet packaged as an installer. For early
testing, install:

- [Git for Windows](https://git-scm.com/download/win)
- [Node.js](https://nodejs.org/) 20 or later; Node.js 22 LTS is recommended

Open PowerShell, then run:

```powershell
cd $HOME
git clone https://github.com/ajrm-marine-suite/signalk-ajrm-marine-audio.git
cd signalk-ajrm-marine-audio\desktop-player
npm install
npm run start:windows
```

If the repository is already cloned:

```powershell
cd $HOME\signalk-ajrm-marine-audio
git pull --ff-only
cd desktop-player
npm install
npm run start:windows
```

Windows may ask whether to allow network access. The player needs to reach the
Signal K server on the local/private network. If `.local` name resolution is not
working, use the Signal K server's IP address instead, for example:

```text
http://192.168.1.42:3000
https://192.168.1.42:3443
```

Windows audio playback still needs real-machine testing. Use **Sound Check** to
confirm announcement playback, then enable **Audible test** under **Setup** to
confirm the Bluetooth keep-alive tone repeats at the configured interval.

## First Run

```sh
npm install
npm start
```

Enter the Signal K server URL, for example:

```text
http://localhost:3000
http://nemo.local:3000
https://nemo.local:3443
```

Enable **Auto-connect** if the player should connect automatically when it
starts. If the Signal K server is not available yet, the player retries once a
minute until it connects.

If Signal K security is enabled, enable Signal K read-only access. The desktop
player deliberately does not store Signal K usernames, passwords, or device
tokens; it only reads AJRM Marine Audio status and generated announcement URLs.
The player fetches both status and MP3 announcement files through Electron's
main process so local self-signed Signal K HTTPS certificates do not prevent
playback.

The **Sound Check** button replays the most recent Sound Check announcement
that this player has received. It is cached locally as rendered MP3 audio, so it
uses the selected server voice but does not require Piper on the desktop
machine. The button becomes available after one Sound Check has been received
from AJRM Marine Audio.

The **Bluetooth keep-alive** option plays a very short silent audio pulse at the
configured interval, defaulting to 60 seconds. This is intended for Bluetooth
speakers or adapters that sleep between announcements. The player skips the
keep-alive pulse while a real announcement is already playing. Enable
**Audible test** temporarily to make the keep-alive pulse a short quiet beep
while checking the speaker path.

The player accepts self-signed HTTPS certificates only for local/private Signal
K hosts: `localhost`, `.local`, `192.168.x.x`, `10.x.x.x`, and
`172.16.x.x` through `172.31.x.x`. Public internet hosts still use normal
certificate validation.

The first version uses the existing AJRM Marine Audio status endpoint:

```text
/signalk/v1/api/ajrmMarineAudio/status
```

It plays only announcements seen while the player is running. It does not
backfill old browser/audio history when the app starts.

## Scope

- Cross-platform Electron app.
- Local mute and volume.
- Configurable Bluetooth keep-alive silent pulse.
- FIFO playback of server-rendered MP3 announcements.
- Local Sound Check replay using the latest rendered Sound Check announcement
  when available.
- No AIS, GPS, traffic, instrument, or profile logic.

## Next Steps

- Add Signal K authentication/device-token flow.
- Add packaging for Linux `.deb`, macOS `.dmg`, and Windows installer.
- Add tray/menu-bar mode and start-at-login.
- Add a dedicated Audio plugin endpoint for player clients if polling status
  proves too coarse.

## Windows Tester Checklist

1. Confirm Node.js and npm:
   ```powershell
   node --version
   npm --version
   ```
2. Start the player with `npm run start:windows`.
3. In **Setup**, enter the Signal K server URL and connect.
4. In **Player**, run **Sound Check** from AJRM Marine Audio and confirm it is
   heard through the Windows default audio output.
5. In **Setup**, enable **Bluetooth keep-alive**, set **Every** to `10`, enable
   **Audible test**, and confirm the test tone repeats every 10 seconds.
6. Switch Windows to the intended Bluetooth speaker and repeat Sound Check plus
   audible keep-alive testing.
7. Check **Status > Diagnostics** for `keep-alive-armed`, `keep-alive`, status
   failures, or playback errors.
