"use strict";

const http = require("node:http");
const https = require("node:https");
const { isLocalSignalKHost } = require("./local-hosts");

const MAX_REDIRECTS = 5;

function requestJson(url, redirectCount = 0) {
  return requestData(url, { json: true, redirectCount });
}

async function requestAudioDataUrl(url) {
  const result = await requestData(url, { json: false, failureContext: "audio" });
  const contentType = result.contentType || "audio/mpeg";
  return `data:${contentType};base64,${result.buffer.toString("base64")}`;
}

function requestData(url, { json, redirectCount = 0, failureContext = "status" }) {
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
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        if (isRedirect(response.statusCode)) {
          const location = response.headers.location;
          if (!location) {
            reject(new Error(`Audio status redirect ${response.statusCode} did not include a Location header.`));
            return;
          }
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error("Audio status redirect limit exceeded."));
            return;
          }
          let nextUrl;
          try {
            nextUrl = new URL(location, parsed);
          } catch (error) {
            reject(new Error(`Audio status redirect target is invalid: ${error.message}`));
            return;
          }
          if (!isAllowedRedirect(parsed, nextUrl)) {
            reject(new Error(`Audio status redirect to ${nextUrl.origin} was refused.`));
            return;
          }
          requestData(nextUrl.toString(), { json, redirectCount: redirectCount + 1, failureContext }).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(statusErrorMessage(response.statusCode, failureContext)));
          return;
        }
        const buffer = Buffer.concat(chunks);
        if (!json) {
          resolve({
            buffer,
            contentType: String(response.headers["content-type"] || "").split(";")[0],
          });
          return;
        }
        try {
          const body = buffer.toString("utf8");
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

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(Number(statusCode));
}

function isAllowedRedirect(fromUrl, toUrl) {
  if (toUrl.protocol !== "http:" && toUrl.protocol !== "https:") return false;
  if (toUrl.hostname === fromUrl.hostname) return true;
  return isLocalSignalKHost(fromUrl.hostname) && isLocalSignalKHost(toUrl.hostname);
}

function requestErrorMessage(error) {
  if (error?.message) return error.message;
  if (Array.isArray(error?.errors) && error.errors.length) {
    const first = error.errors.find((item) => item?.message) || error.errors[0];
    if (first?.message) return first.message;
  }
  if (error?.code) return error.code;
  return String(error || "Unknown error");
}

function statusErrorMessage(statusCode, context = "status") {
  const noun = context === "audio" ? "audio file" : "status request";
  if (Number(statusCode) === 401) {
    return `Signal K rejected the ${noun} (HTTP 401). Enable Signal K read-only access, or disable security for testing.`;
  }
  if (Number(statusCode) === 403) {
    return `Signal K refused the ${noun} (HTTP 403). The desktop player needs read-only access to AJRM Marine Audio status and generated audio.`;
  }
  return `Audio status failed: HTTP ${statusCode}`;
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
  isAllowedRedirect,
  normalizeServerUrl,
  requestAudioDataUrl,
  requestJson,
  requestErrorMessage,
  statusErrorMessage,
  statusUrl,
};
