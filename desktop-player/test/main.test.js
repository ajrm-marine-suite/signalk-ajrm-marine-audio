"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isLocalSignalKHost } = require("../src/local-hosts");
const { isAllowedRedirect, normalizeServerUrl, requestAudioDataUrl, requestJson, statusErrorMessage, statusUrl } = require("../src/status-client");
const http = require("node:http");

const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "app.js"), "utf8");

assert.equal(isLocalSignalKHost("localhost"), true);
assert.equal(isLocalSignalKHost("nemo.local"), true);
assert.equal(isLocalSignalKHost("192.168.1.42"), true);
assert.equal(isLocalSignalKHost("192.168.3.42"), true);
assert.equal(isLocalSignalKHost("10.0.0.9"), true);
assert.equal(isLocalSignalKHost("172.16.0.9"), true);
assert.equal(isLocalSignalKHost("172.31.0.9"), true);

assert.equal(isLocalSignalKHost("172.32.0.9"), false);
assert.equal(isLocalSignalKHost("example.com"), false);
assert.equal(isLocalSignalKHost("github.com"), false);

assert.equal(normalizeServerUrl("https://nemo.local:3443/"), "https://nemo.local:3443");
assert.equal(statusUrl("https://192.168.3.10:3443/"), "https://192.168.3.10:3443/signalk/v1/api/ajrmMarineAudio/status");
assert.throws(() => normalizeServerUrl("file:///tmp/test"), /http/);

assert.equal(isAllowedRedirect(new URL("http://nemo.local:3000"), new URL("https://nemo.local:3443")), true);
assert.equal(isAllowedRedirect(new URL("http://192.168.1.20:3000"), new URL("https://192.168.1.20:3443")), true);
assert.equal(isAllowedRedirect(new URL("http://nemo.local:3000"), new URL("https://github.com")), false);
assert.match(statusErrorMessage(401), /read-only access/);
assert.match(statusErrorMessage(403), /read-only access/);
assert.match(statusErrorMessage(401, "audio"), /audio file/);
assert.match(rendererSource, /const AUDIO_URL_WAIT_MS = 15000/);
assert.match(rendererSource, /let waitingForAudioUrl = new Map\(\)/);
assert.match(rendererSource, /waitForAnnouncementAudioUrl\(announcement\)/);
assert.match(rendererSource, /announcement-waiting-audio-url/);
assert.match(rendererSource, /announcement-audio-url-ready/);
assert.match(rendererSource, /Announcement still has no audio URL after wait window/);
assert.doesNotMatch(rendererSource, /Announcement has no audio URL/);
assert.match(rendererSource, /const DEFAULT_KEEP_ALIVE_SECONDS = 60/);
assert.match(rendererSource, /const MIN_KEEP_ALIVE_SECONDS = 10/);
assert.match(rendererSource, /function playKeepAlivePulse\(\{ force = false \} = \{\}\)/);
assert.match(rendererSource, /Sent Bluetooth keep-alive pulse/);
assert.match(rendererSource, /AUDIBLE_KEEP_ALIVE_DATA_URL/);
assert.match(rendererSource, /Bluetooth keep-alive audible test enabled/);
assert.match(rendererSource, /Sent audible Bluetooth keep-alive test pulse/);
assert.match(rendererSource, /playKeepAlivePulse\(\{ force: true \}\)/);
assert.match(rendererSource, /els\.keepAliveAudio\.src = settings\.keepAliveAudible/);
assert.match(rendererSource, /if \(\(!force && !settings\.keepAliveEnabled\) \|\| playing\) return/);

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  await withServer((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { Location: "/final" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    assert.deepEqual(await requestJson(`${baseUrl}/start`), { ok: true });
  });

  await withServer((_request, response) => {
    response.writeHead(401, { "Content-Type": "text/plain" });
    response.end("Unauthorized");
  }, async (baseUrl) => {
    await assert.rejects(
      () => requestJson(`${baseUrl}/status`),
      /read-only access/,
    );
  });

  await withServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "audio/mpeg" });
    response.end(Buffer.from([1, 2, 3, 4]));
  }, async (baseUrl) => {
    assert.equal(await requestAudioDataUrl(`${baseUrl}/audio.mp3`), "data:audio/mpeg;base64,AQIDBA==");
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
