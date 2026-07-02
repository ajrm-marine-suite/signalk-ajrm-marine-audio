"use strict";

const http = require("node:http");
const https = require("node:https");
const { isLocalSignalKHost } = require("./local-hosts");

function requestJson(url) {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  const options = {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-store",
    },
    timeout: 10000,
  };
  if (parsed.protocol === "https:" && isLocalSignalKHost(parsed.hostname)) {
    options.rejectUnauthorized = false;
  }
  return new Promise((resolve, reject) => {
    const request = client.request(parsed, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Audio status failed: HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || "{}"));
        } catch (error) {
          reject(new Error(`Audio status returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("Audio status request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

function normalizeServerUrl(value) {
  const url = new URL(String(value || "").trim().replace(/\/+$/, "") || "http://localhost:3000");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Signal K server URL must start with http:// or https://");
  }
  return url.toString().replace(/\/+$/, "");
}

function statusUrl(serverUrl) {
  return `${normalizeServerUrl(serverUrl)}/signalk/v1/api/ajrmMarineAudio/status`;
}

module.exports = {
  normalizeServerUrl,
  requestJson,
  statusUrl,
};
