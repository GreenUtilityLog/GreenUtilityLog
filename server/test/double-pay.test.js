// ── Two server processes, one reading ────────────────────────────────────────
// What happened on 2026-09-27: during a deploy Render ran the old and the new
// process side by side. Each loaded the state once and kept its own copy, so one
// paid a reader's reading automatically and the other, not knowing, let the owner
// claim the same reading again. Paid twice. The guard that stops it lives in the
// storage both share (Redis SET NX), which this test stands in for.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

// A tiny Upstash REST stand-in: GET, SET (with NX and PX) and DEL, shared by both.
function fakeUpstash(initial) {
  const kv = new Map([["greenutilitylog:state", JSON.stringify(initial)]]);
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const [cmd, key, val, ...opts] = JSON.parse(b || "[]");
      let result = null;
      if (cmd === "GET") result = kv.has(key) ? kv.get(key) : null;
      else if (cmd === "SET") {
        if (opts.includes("NX") && kv.has(key)) result = null;
        else { kv.set(key, val); result = "OK"; }
      } else if (cmd === "DEL") result = kv.delete(key) ? 1 : 0;
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

describe("the old and the new process during a deploy", () => {
  let redis, a, b, token;
  before(async () => {
    const state = stateWithBaseline({ reading: 7717.912 });
    state.meterLinks = { tok: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", createdAt: Date.now() } };
    token = "tok";
    redis = await fakeUpstash(state);
    const env = { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: "t", AUTO_CLAIM_ON_PUSH: "on" };
    // Both boot from the same stored state, as the old and the new process do.
    [a, b] = await Promise.all([startServer({ env }), startServer({ env })]);
  });
  after(async () => { await a.stop(); await b.stop(); redis.srv.close(); });

  test("the reader's reading is paid once, by the process it reached", async () => {
    const r = await a.post("/meter-ingest", { token, reading: 7721.72 });
    assert.equal(r.status, 200);
    let paid = null;
    for (let i = 0; i < 20 && !paid; i++) {
      await new Promise((res) => setTimeout(res, 200));
      paid = (await a.get(`/meter/latest?address=${WALLET}`)).body.lastPayout;
    }
    assert.ok(paid, "process A paid it");
  });

  test("the other process, which never heard of it, refuses to pay it again", async () => {
    // B's own copy still has the old baseline and no cooldown, and it has the
    // reading too once the reader's push reaches it.
    await b.post("/meter-ingest", { token, reading: 7721.72 });
    // That push makes B try to pay it by itself first; let that attempt finish.
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal((await b.get(`/meter/latest?address=${WALLET}`)).body.lastPayout, null, "B's own automatic attempt was refused");
    const r = await b.post("/reward-from-meter", { address: WALLET, meterNo: "E1000" });
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.error, /already paid|cooldown/);
  });
});
