"use strict";

const assert = require("node:assert/strict");
const {
  detectArchitecture,
  detectPlatform,
  recommendedAsset,
} = require("../public/desktop-player-download");

assert.equal(detectPlatform({ platform: "Win32" }), "windows");
assert.equal(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" }), "macos");
assert.equal(detectPlatform({ platform: "Linux x86_64" }), "linux");
assert.equal(detectArchitecture({ userAgent: "Linux aarch64" }), "arm64");
assert.equal(detectArchitecture({ architecture: "x86_64" }), "x64");

const manifest = {
  assets: [
    { id: "win", platform: "windows", arch: "x64", label: "Windows installer" },
    { id: "mac", platform: "macos", arch: "universal", label: "macOS DMG" },
    { id: "linux-arm", platform: "linux", arch: "arm64", label: "Linux ARM64 AppImage" },
    { id: "linux-x64", platform: "linux", arch: "x64", label: "Linux x64 AppImage" },
  ],
};

assert.equal(recommendedAsset(manifest, { platform: "Win32" }).id, "win");
assert.equal(recommendedAsset(manifest, { platform: "MacIntel" }).id, "mac");
assert.equal(
  recommendedAsset(manifest, { platform: "Linux", architecture: "arm64" }).id,
  "linux-arm",
);
assert.equal(recommendedAsset(manifest, { platform: "iPhone" }), null);
