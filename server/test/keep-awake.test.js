// ── The server keeps itself awake ─────────────────────────────────────────────
// On Render (RENDER_EXTERNAL_URL set) the server calls its own /cron/tick on a
// timer, so the free plan doesn't put it to sleep; KEEP_AWAKE=off stops that.
// A stand-in plays the public address here and counts the calls.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer } from "./helpers.mjs";

function publicAddress() {
  const hits = [];
  const srv = createServer((req, res) => { hits.push(req.url); res.setHeader("content-type", "application/json"); res.end("{}"); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, hits, url: `http://127.0.0.1:${srv.address().port}` })));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("on Render: calls its own /cron/tick on a timer", () => {
  let srv, pub;
  before(async () => { pub = await publicAddress(); srv = await startServer({ env: { RENDER_EXTERNAL_URL: pub.url + "/", KEEP_AWAKE_MS: "1000" } }); });
  after(async () => { await srv.stop(); pub.srv.close(); });
  test("several calls within a few seconds, all to /cron/tick", async () => {
    await wait(3500);
    assert.ok(pub.hits.length >= 2, `calls: ${pub.hits.length}`);
    assert.ok(pub.hits.every((u) => u === "/cron/tick"), pub.hits.join(","));
    assert.equal((await srv.get("/health")).body.keepAwake, true);
  });
});

describe("KEEP_AWAKE=off: no calls", () => {
  let srv, pub;
  before(async () => { pub = await publicAddress(); srv = await startServer({ env: { RENDER_EXTERNAL_URL: pub.url, KEEP_AWAKE_MS: "1000", KEEP_AWAKE: "off" } }); });
  after(async () => { await srv.stop(); pub.srv.close(); });
  test("nothing in a few seconds", async () => {
    await wait(2500);
    assert.equal(pub.hits.length, 0);
    assert.equal((await srv.get("/health")).body.keepAwake, false);
  });
});

describe("not on Render (no RENDER_EXTERNAL_URL): no calls", () => {
  let srv;
  before(async () => { srv = await startServer({ env: { RENDER_EXTERNAL_URL: "", KEEP_AWAKE_MS: "300" } }); });
  after(async () => { await srv.stop(); });
  test("keepAwake is false", async () => {
    assert.equal((await srv.get("/health")).body.keepAwake, false);
  });
});
