"use strict";

const assert = require("node:assert/strict");
const { isLocalSignalKHost } = require("../src/local-hosts");
const { isAllowedRedirect, normalizeServerUrl, requestJson, statusErrorMessage, statusUrl } = require("../src/status-client");
const http = require("node:http");

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
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
