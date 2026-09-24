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
    // The release is written with the usual short debounce, so wait for it.
    const st = await srv.waitForState((x) => Object.keys(x.hashes || {}).length === 0);
    assert.equal(Object.keys(st.hashes || {}).length, 0);
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

  test("but does not shut out everything else — an admin still has to be able to act", async () => {
    const r = await srv.post("/meter/pair", { address: WALLET, meterNo: "E1000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pay = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET,
      reading: 1016, prevRead: 1008, photo: photo("lost-write-3"), photoMime: "image/jpeg",
    });
    assert.match(pay.body.error, /can't save/);
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

// ── The typed reading has to be on the photo ─────────────────────────────────
// A fake OCR service stands in for Claude/Vision: it "reads" whatever number the
// test sets, which is all the server sees of any provider.
function fakeOcr() {
  const o = { reads: [1008], status: 200 };
  o.srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = o.status;
      res.end(JSON.stringify({ numbers: o.reads, text: o.reads.join(" ") }));
    });
  });
  return new Promise((r) => o.srv.listen(0, "127.0.0.1", () => { o.url = `http://127.0.0.1:${o.srv.address().port}/ocr`; r(o); }));
}
const submitAt = (srv, reading, tag, over = {}) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address: WALLET,
  reading, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg", ...over,
});

describe("reading check, strict (the default once a provider is configured)", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({ state: stateWithBaseline(), env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", COOLDOWN_MS: "0" } });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("yesterday's number again — 'zero usage', the maximum — is refused when the photo says otherwise", async () => {
    ocr.reads = [1008];
    const r = await submitAt(srv, 1000, "same-again");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not what the photo shows/);
    assert.equal(srv.readState().readings["electric:e1000"], 1000);
  });

  test("the photo's own number is paid", async () => {
    ocr.reads = [1008.4, 12345678];
    const r = await submitAt(srv, 1008, "honest");
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("a photo with no readable number is refused, and says what to do", async () => {
    ocr.reads = [];
    const r = await submitAt(srv, 1016, "blurry");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /sharper photo/);
  });

  test("an OCR outage is 'try again', not a verdict on the photo — and pays nothing", async () => {
    ocr.status = 500;
    const r = await submitAt(srv, 1016, "outage");
    assert.equal(r.status, 503);
    assert.match(r.body.error, /try again/);
    ocr.status = 200;
  });

  test("a double-tariff total passes when one register is on the photo", async () => {
    ocr.reads = [612];
    const r = await submitAt(srv, 1020, "tariff", { registers: [612, 408] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("reading check, flag mode", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({ state: stateWithBaseline(), env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", READING_CHECK: "flag" } });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("pays, and records the mismatch for an admin", async () => {
    ocr.reads = [1050];
    const r = await submitAt(srv, 1008, "flagged");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.flagged, true);
    const st = await srv.waitForState((s) => Object.keys(s.flags || {}).length > 0);
    assert.match(Object.values(st.flags).map((f) => f.reason).join(" "), /server OCR did not find 1008/);
  });
});

describe("no OCR provider configured", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("behaves as before: nothing to read the photo with, so nothing is refused for it", async () => {
    const r = await submitAt(srv, 1008, "no-provider");
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("the unsigned /ocr endpoint", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({ env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", OCR_DAILY_PER_IP: "2" } });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("stops forwarding to the paid provider after the daily limit", async () => {
    const img = photo("ocr");
    assert.equal((await srv.post("/ocr", { image: img })).status, 200);
    assert.equal((await srv.post("/ocr", { image: img })).status, 200);
    assert.equal((await srv.post("/ocr", { image: img })).status, 429);
  });
});
