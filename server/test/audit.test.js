// ── Holes found in the security audit ────────────────────────────────────────
// Each case here was a working way to be paid more than the rules allow. They stay
// as tests so a later change cannot quietly reopen one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

describe("a meter's first reading", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("earns the base amount only — its 'previous reading' is the submitter's own word", async () => {
    // prevRead = reading claims zero usage, which used to be the maximum payout on
    // any freshly invented meter number.
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "NEW-1", address: WALLET,
      reading: 5000, prevRead: 5000, photo: photo("first"), photoMime: "image/jpeg",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 0.2);
    assert.equal(srv.readState().readings["electric:new-1"], 5000, "and it sets the baseline");
  });
});

describe("the AI photo check, when it cannot run", () => {
  let srv, api;
  before(async () => {
    // An Anthropic API that always fails — the case that used to wave photos through.
    api = createServer((req, res) => { req.resume(); res.statusCode = 400; res.end('{"type":"error","error":{"type":"invalid_request_error","message":"bad image"}}'); });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    srv = await startServer({
      state: stateWithBaseline(),
      env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}` },
    });
  });
  after(async () => { await srv.stop(); api.close(); });

  test("pays nothing, and says to try again rather than blaming the photo", async () => {
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET,
      reading: 1008, prevRead: 1000, photo: photo("ai"), photoMime: "image/jpeg",
    });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.error, /try again/i);
    assert.equal(r.body.txid, undefined);
    assert.equal(srv.readState().readings["electric:e1000"], 1000, "baseline untouched");
  });

  test("and the photo is not used up by the failed attempt", async () => {
    assert.equal(Object.keys(srv.readState().hashes || {}).length, 0);
  });
});

describe("a durable store that stops accepting writes", () => {
  let srv, redis, failSets = false;
  before(async () => {
    // Upstash stand-in: reads work, and writes fail once we say so.
    const blob = JSON.stringify(stateWithBaseline());
    redis = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const cmd = JSON.parse(b || "[]");
        if (cmd[0] === "SET" && failSets) { res.statusCode = 500; return res.end("{}"); }
        res.end(JSON.stringify({ result: cmd[0] === "GET" ? blob : "OK" }));
      });
    });
    await new Promise((r) => redis.listen(0, "127.0.0.1", r));
    srv = await startServer({
      env: {
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redis.address().port}`,
        UPSTASH_REDIS_REST_TOKEN: "t",
        COOLDOWN_MS: "0",
      },
    });
  });
  after(async () => { await srv.stop(); redis.close(); });

  test("stops paying once a save is lost, instead of carrying on as if saved", async () => {
    failSets = true;
    // This payout goes out, but its cooldown/photo/baseline never reach storage: a
    // restart would forget it was ever paid.
    await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET,
      reading: 1008, prevRead: 1000, photo: photo("lost-write"), photoMime: "image/jpeg",
    });
    const health = await srv.get("/health");
    assert.equal(health.body.storeReady, false);
    const again = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET,
      reading: 1016, prevRead: 1008, photo: photo("lost-write-2"), photoMime: "image/jpeg",
    });
    assert.equal(again.status, 503);
  });

  test("and resumes by itself once saving works again", async () => {
    failSets = false;
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ready = (await srv.get("/health")).body.storeReady === true;
    }
    assert.equal(ready, true);
  });
});
