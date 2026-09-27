// ── One person, many wallets ─────────────────────────────────────────────────
// A wallet costs nothing to make, so every per-wallet limit multiplies with the
// number of wallets. These are the gates that don't.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";
import { startServer, photo, stateWithBaseline, WALLET, OTHER } from "./helpers.mjs";

// A real, decodable "meter photo": a noise pattern seeded per scene, so two scenes
// look nothing alike and a retake of one scene (slightly brighter, re-encoded)
// looks almost the same.
async function scene(seed, { brighten = 1 } = {}) {
  const w = 320, h = 240, px = Buffer.alloc(w * h * 3);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < w * h; i++) {
    // Big smooth blocks, like a meter housing and its display: what a difference
    // hash sees. Pure per-pixel noise would all average out to grey.
    const bx = Math.floor((i % w) / 40), by = Math.floor(Math.floor(i / w) / 40);
    x = (x * 1103515245 + 12345 + bx * 7 + by * 13) & 0x7fffffff;
    const v = ((bx * 37 + by * 91 + seed * 53) % 200) + (x % 20);
    px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = Math.min(255, v * brighten);
  }
  const jpg = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: brighten === 1 ? 90 : 75 }).toBuffer();
  return jpg.toString("base64");
}

describe("access passes are on by default", () => {
  let srv;
  before(async () => {
    const state = stateWithBaseline();
    state.passes = { [OTHER.toLowerCase()]: { no: 1, tier: "tester", issuedAt: Date.now() } };
    state.meterOwners["electric:e2000"] = OTHER.toLowerCase();
    state.readings["electric:e2000"] = 1000;
    state.readingAts["electric:e2000"] = Date.now();
    srv = await startServer({ state, env: { REQUIRE_PASS: "" } }); // unset = the production default
  });
  after(async () => { await srv.stop(); });

  test("a wallet without a pass (or a passport) is not paid", async () => {
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: photo("nopass"), photoMime: "image/jpeg" });
    assert.equal(r.status, 403);
    assert.equal(r.body.needsPass, true);
  });

  test("a wallet with a pass is", async () => {
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E2000", address: OTHER, reading: 1008, prevRead: 1000, photo: photo("pass"), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("and the app is told which is which", async () => {
    const r = await srv.post("/wallet/seen", { address: WALLET });
    assert.equal(r.body.requirePass, true);
    assert.equal(r.body.hasPass, false);
  });
});

describe("one meter photographed for two wallets", () => {
  let srv;
  before(async () => {
    const state = stateWithBaseline();
    state.meterOwners["electric:e2000"] = OTHER.toLowerCase();
    state.readings["electric:e2000"] = 1000;
    state.readingAts["electric:e2000"] = Date.now();
    srv = await startServer({ state, env: { COOLDOWN_MS: "0" } });
  });
  after(async () => { await srv.stop(); });

  test("the first wallet is paid", async () => {
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: await scene(1), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("a retake of the same scene for another wallet is refused, and recorded", async () => {
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E2000", address: OTHER, reading: 1008, prevRead: 1000, photo: await scene(1, { brighten: 1.05 }), photoMime: "image/jpeg" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /another wallet/);
    const st = await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => /refused: photo nearly identical/.test(f.reason)));
    assert.ok(st);
  });

  test("a different meter for that wallet is fine", async () => {
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E2000", address: OTHER, reading: 1008, prevRead: 1000, photo: await scene(7), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("and the same wallet photographing its own meter again is never held against it", async () => {
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1016, prevRead: 1008, photo: await scene(1, { brighten: 1.03 }), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("the registered meter number on the photo", () => {
  let srv, ocr, text = "";
  before(async () => {
    ocr = createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ text, numbers: (text.match(/\d+(?:\.\d+)?/g) || []).map(Number) }))); });
    await new Promise((r) => ocr.listen(0, "127.0.0.1", r));
  });
  after(async () => { ocr.close(); });

  test("flag (default): paid, and recorded when the number isn't there", async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { CUSTOM_OCR_URL: `http://127.0.0.1:${ocr.address().port}/`, OCR_PROVIDER_ORDER: "custom" } });
    text = "1008 kWh";
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: photo("mn-flag"), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.flagged, true);
    const st = await srv.waitForState((s) => Object.keys(s.flags || {}).length > 0);
    assert.match(Object.values(st.flags).map((f) => f.reason).join(" "), /meter number E1000 not found on the photo/);
    await srv.stop();
  });

  test("strict: refused without the number, paid with it", async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { CUSTOM_OCR_URL: `http://127.0.0.1:${ocr.address().port}/`, OCR_PROVIDER_ORDER: "custom", METER_NO_CHECK: "strict", COOLDOWN_MS: "0" } });
    text = "1008 kWh";
    let r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: photo("mn-strict"), photoMime: "image/jpeg" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /meter number E1000 is not visible/);
    text = "E1000 1008 kWh";
    r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: photo("mn-ok"), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await srv.stop();
  });
});
