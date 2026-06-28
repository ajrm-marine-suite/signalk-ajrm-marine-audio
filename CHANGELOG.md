# Changelog

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
