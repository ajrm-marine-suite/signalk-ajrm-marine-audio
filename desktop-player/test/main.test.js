"use strict";

const assert = require("node:assert/strict");
const { isLocalSignalKHost } = require("../src/local-hosts");

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
