// ── A double-tariff meter, register by register ──────────────────────────────
// The photo shows one register; the other rested on the submitter's word. The
// trick: type the true register plus an invented one, photograph the true one,
// and every check passed. Now each register only counts up, and the register
// that has been off the photos longest must be on the next one.
//
// Also here: who may see a wallet's readings, and which meter an Enode reading
// (no paired device) can be paid against.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, photo, stateWithBaseline, WALLET, OTHER } from "./helpers.mjs";

function fakeOcr() {
  const o = { reads: [] };
  o.srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ numbers: o.reads, text: o.reads.join(" ") })));
  });
  return new Promise((r) => o.srv.listen(0, "127.0.0.1", () => { o.url = `http://127.0.0.1:${o.srv.address().port}/ocr`; r(o); }));
}
const submit = (srv, registers, tag) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address: WALLET, prevRead: 1000,
  reading: +registers.reduce((a, b) => a + b, 0).toFixed(3), registers,
  photo: photo(tag), photoMime: "image/jpeg",
});

describe("tariff registers, with the photo read (strict)", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({ state: stateWithBaseline(), env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", COOLDOWN_MS: "0" } });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("the first photo may show either register", async () => {
    ocr.reads = [612];
    const r = await submit(srv, [612, 408], "first");
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("the same register twice in a row is refused, and says which one to show", async () => {
    // The trick: register 1 is real and on the photo, register 2 is invented.
    ocr.reads = [614];
    const r = await submit(srv, [614, 430], "trick");
    assert.equal(r.status, 400);
    assert.equal(r.body.photoRegister, 2);
    assert.match(r.body.error, /photograph tariff register 2/);
  });

  test("the app is told which register to photograph next — and no readings", async () => {
    const r = await srv.get(`/meter/registered?address=${WALLET}`);
    assert.equal(r.body.meters[0].photoRegister, 2);
    assert.equal(r.body.meters[0].last, undefined);
  });

  test("showing the other register is paid", async () => {
    ocr.reads = [414];
    const r = await submit(srv, [614, 414], "other");
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("a register that goes down is refused", async () => {
    ocr.reads = [600];
    const r = await submit(srv, [600, 436], "down");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /register 1 went down/);
  });

  test("a photo of the total vouches for both", async () => {
    ocr.reads = [1040];
    const r = await submit(srv, [620, 420], "total");
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("tariff registers, flag mode", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({ state: stateWithBaseline(), env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", COOLDOWN_MS: "0", READING_CHECK: "flag" } });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("the same register twice is paid, but recorded for review", async () => {
    ocr.reads = [612];
    assert.equal((await submit(srv, [612, 408], "a")).status, 200);
    ocr.reads = [614];
    const r = await submit(srv, [614, 410], "b");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => /register 2 was due/.test(JSON.stringify(f))));
    assert.ok(Object.values(st.flags).some((f) => /register 2 was due/.test(JSON.stringify(f))));
  });
});

describe("tariff registers without a photo check", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { COOLDOWN_MS: "0" } }); });
  after(async () => { await srv.stop(); });

  test("still may not run backwards", async () => {
    assert.equal((await submit(srv, [612, 408], "a")).status, 200);
    const r = await submit(srv, [630, 400], "b");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /register 2 went down/);
  });
});

describe("a wallet's live readings", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline() });
    token = (await srv.post("/meter/pair", { address: WALLET, meterNo: "E1000" })).body.token;
    await srv.post("/meter-ingest", { token, reading: 1004 });
  });
  after(async () => { await srv.stop(); });

  test("are not shown to someone who only knows the address", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`);
    assert.equal(r.body.paired, true);
    assert.equal(r.body.needsToken, true);
    assert.equal(r.body.reading, null);
    assert.equal(r.body.baseline, undefined);
  });

  test("nor with a wrong token", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": "0".repeat(token.length) });
    assert.equal(r.body.reading, null);
  });

  test("are shown with the wallet's device token", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": token });
    assert.equal(r.body.reading.reading, 1004);
    assert.equal(r.body.baseline, 1000);
  });
});

describe("an Enode reading without a paired device", () => {
  let srv;
  before(async () => {
    // A meter with a baseline but no recorded owner, and another wallet holding an
    // automatic reading but no device link.
    const state = stateWithBaseline();
    state.readings["electric:e2000"] = 1000;
    state.readingAts["electric:e2000"] = Date.now();
    state.linkReadings = { [OTHER.toLowerCase()]: { reading: 1006, at: Date.now(), source: "enode" } };
    srv = await startServer({ state });
  });
  after(async () => { await srv.stop(); });

  test("can't be paid against a meter the wallet doesn't own", async () => {
    const r = await srv.post("/reward-from-meter", { address: OTHER, meterNo: "E2000" });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /isn't registered to your wallet/);
    assert.equal(srv.readState().readings["electric:e2000"], 1000);
  });
});
