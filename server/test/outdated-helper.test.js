// ── The app is told when the owner's helper (gul.js) is out of date ──────────
// A helper installed before 30 October made a Windows task that opened a window
// every hour; its owner found out on 27 November, by asking. Running the install
// line again fixes that (and more), so the app now says so — from what the
// helper sends: "GreenUtilityLog-bridge/x.y.z (node vN; platform)" from 1.5.3 on,
// no User-Agent at all before.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { startServer, WALLET } from "./helpers.mjs";

const TOKEN = "f".repeat(48);
function state() {
  const now = Date.now();
  return {
    meterOwners: { "electric:e1000": WALLET.toLowerCase() },
    readings: { "electric:e1000": 1000 },
    readingAts: { "electric:e1000": now - 25 * 3600e3 },
    photoAts: { "electric:e1000": now - 86400000 },
    meterLinks: { [TOKEN]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", source: "bridge", createdAt: now - 30 * 86400000 } },
  };
}

// A push the way a given client sends it. `ua: null` sends no User-Agent at all,
// as gul.js did before 1.5.3 (http.request adds none).
function push(srv, reading, ua) {
  const body = JSON.stringify({ token: TOKEN, reading });
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...(ua ? { "User-Agent": ua } : {}) };
  return new Promise((resolve, reject) => {
    const req = request(srv.base + "/meter-ingest", { method: "POST", headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject); req.end(body);
  });
}
const latest = async (srv) => (await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": TOKEN })).body;

describe("which helper sent the reading", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state() }); });
  after(async () => { await srv.stop(); });

  test("no User-Agent at all: a gul.js from before 1.5.3, out of date", async () => {
    assert.equal((await push(srv, 1001, null)).status, 200);
    const l = await latest(srv);
    assert.deepEqual(l.outdatedHelper, { version: null, os: null });
    assert.equal(l.reading.client, "bridge <1.5.3", "recorded for the admin too");
  });

  test("1.5.4 on Windows: out of date, and the app knows it is Windows", async () => {
    assert.equal((await push(srv, 1002, "GreenUtilityLog-bridge/1.5.4 (node 22.11.0; win32)")).status, 200);
    assert.deepEqual((await latest(srv)).outdatedHelper, { version: "1.5.4", os: "win32" });
  });

  test("the current one: nothing to say", async () => {
    assert.equal((await push(srv, 1003, "GreenUtilityLog-bridge/1.5.6 (node 24.1.0; linux)")).status, 200);
    const l = await latest(srv);
    assert.equal(l.outdatedHelper, null);
    assert.equal(l.reading.client, "bridge 1.5.6");
    assert.equal(l.reading.os, "linux");
  });

  test("the helper this repository publishes is never called out of date", async () => {
    const v = /const BRIDGE_VERSION = "(\d+\.\d+\.\d+)";/.exec(readFileSync(new URL("../../bridge/index.js", import.meta.url), "utf8"))[1];
    assert.equal((await push(srv, 1003.5, `GreenUtilityLog-bridge/${v} (node 24.1.0; win32)`)).status, 200);
    assert.equal((await latest(srv)).outdatedHelper, null, `gul.js ${v} is the current one`);
  });

  test("a newer one (1.10.0 sorts after 1.5.6 as a number, not as text): nothing to say", async () => {
    assert.equal((await push(srv, 1004, "GreenUtilityLog-bridge/1.10.0 (node 24.1.0; darwin)")).status, 200);
    assert.equal((await latest(srv)).outdatedHelper, null);
  });

  test("another reader (Home Assistant): not gul.js, nothing to say", async () => {
    assert.equal((await push(srv, 1005, "HomeAssistant/2026.11 aiohttp/3.11 Python/3.13")).status, 200);
    const l = await latest(srv);
    assert.equal(l.outdatedHelper, null);
    assert.equal(l.reading.client, undefined);
  });

  test("a made-up platform is not stored", async () => {
    assert.equal((await push(srv, 1006, "GreenUtilityLog-bridge/1.5.4 (node 22; <script>)")).status, 200);
    const l = await latest(srv);
    assert.deepEqual(l.outdatedHelper, { version: "1.5.4", os: null });
    assert.equal(l.reading.os, undefined);
  });
});
