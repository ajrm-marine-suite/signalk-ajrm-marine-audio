# AJRM Marine Audio Player

Standalone desktop player for AJRM Marine Audio announcements on Lubuntu,
macOS, and Windows.

This app is deliberately a player, not an alert engine. AJRM Marine Audio on
the Signal K server renders and prioritises announcements. The desktop player
connects to that server, watches for newly rendered announcements, and plays
them locally in FIFO order.

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
- FIFO playback of server-rendered MP3 announcements.
- Sound Check using the latest rendered announcement when available.
- No AIS, GPS, traffic, instrument, or profile logic.

## Next Steps

- Add Signal K authentication/device-token flow.
- Add packaging for Linux `.deb`, macOS `.dmg`, and Windows installer.
- Add tray/menu-bar mode and start-at-login.
- Add a dedicated Audio plugin endpoint for player clients if polling status
  proves too coarse.
