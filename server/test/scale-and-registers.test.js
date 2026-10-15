// ── Two ways a claim could understate the meter (audit, October) ──────────────
// 1. Changing the number of tariff registers reset every register rule, so an
//    invented register never had to be photographed.
// 2. The missing-decimal-point rule let a tenth of the meter pass: a photo read as
//    10012.5 "matched" a claim of 1001.2.
// Both against the real server, with a fake OCR provider and strict checking.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";
import { readingOnPhoto } from "../media.js";

function fakeOcr() {
  const o = { reads: [] };
  o.srv = createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify({ numbers: o.reads, text: o.reads.join(" ") }))); });
  return new Promise((r) => o.srv.listen(0, "127.0.0.1", () => { o.url = `http://127.0.0.1:${o.srv.address().port}/ocr`; r(o); }));
}
const sub = (srv, body, tag) => srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg", ...body });
const env = (ocr) => ({ CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", COOLDOWN_MS: "0", READING_CHECK: "strict" });

describe("the number of tariff registers can't change between payouts", () => {
  let srv, ocr;
  before(async () => { ocr = await fakeOcr(); srv = await startServer({ state: stateWithBaseline({ agoMs: 25 * 3600e3 }), env: env(ocr) }); });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("two registers, then three, is refused", async () => {
    ocr.reads = [612];
    const a = await sub(srv, { registers: [612, 388.8], reading: 1000.8 }, "a");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    ocr.reads = [612.4];
    const c = await sub(srv, { registers: [612.4, 389.0, 0.2], reading: 1001.6 }, "c");
    assert.equal(c.status, 400);
    assert.match(c.body.error, /was paid with 2 tariff registers, not 3/);
  });
});

describe("the missing-decimal-point rule holds the true scale", () => {
  let srv, ocr;
  before(async () => { ocr = await fakeOcr(); srv = await startServer({ state: stateWithBaseline({ reading: 1000, agoMs: 25 * 3600e3 }), env: env(ocr) }); });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("a photo of 10012.5 does not vouch for 1001.2", async () => {
    ocr.reads = [10012.5];
    const r = await sub(srv, { reading: 1001.2 }, "p");
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  test("the rule itself: a lost point still matches on the true scale, never on a tenth", () => {
    assert.equal(readingOnPhoto(12345.6, [123456], 12340), true, "12345.6 read as 123456");
    assert.equal(readingOnPhoto(1234.5, [123456], 12340), false, "a tenth of a meter whose baseline is on the true scale");
    assert.equal(readingOnPhoto(1001.2, [10012.5], 1000), false, "the OCR kept its point");
    assert.equal(readingOnPhoto(12345.6, [123456]), false, "no baseline: a first reading must match exactly");
    assert.equal(readingOnPhoto(12345.6, [12345.4]), true, "within one unit always matches");
  });
});
