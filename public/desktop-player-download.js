/**
 * Implements the desktop player download responsibilities of the AJRM Marine Audio browser application.
 */

(function desktopPlayerDownloadModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AjrmMarineDesktopPlayerDownload = api;
})(typeof window !== "undefined" ? window : null, function createDesktopPlayerDownloadApi() {
  "use strict";

  function detectPlatform({ platform = "", userAgent = "" } = {}) {
    const value = `${platform} ${userAgent}`.toLowerCase();
    if (/windows|win32|win64/.test(value)) return "windows";
    if (/macintosh|mac os|macintel/.test(value)) return "macos";
    if (/linux|x11/.test(value)) return "linux";
    return "unknown";
  }

  function detectArchitecture({ architecture = "", userAgent = "" } = {}) {
    const value = `${architecture} ${userAgent}`.toLowerCase();
    if (/arm64|aarch64/.test(value)) return "arm64";
    if (/x86_64|x64|win64|amd64/.test(value)) return "x64";
    return "unknown";
  }

  function recommendedAsset(manifest, environment = {}) {
    const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
    const platform = detectPlatform(environment);
    const architecture = detectArchitecture(environment);
    const matches = assets.filter((asset) => asset?.platform === platform);
    if (!matches.length) return null;
    if (platform === "macos") {
      return matches.find((asset) => asset.arch === "universal") || matches[0];
    }
    return matches.find((asset) => asset.arch === architecture && /appimage|installer/i.test(asset.label)) ||
      matches.find((asset) => asset.arch === architecture) ||
      matches[0];
  }

  return { detectPlatform, detectArchitecture, recommendedAsset };
});
