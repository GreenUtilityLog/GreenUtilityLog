// ── The saving a reading was paid on goes back to the app ────────────────────
// Progress showed 0 kWh saved for a paid reading whenever the app didn't know the
// previous reading (a new phone, a starting reading only the server holds). The
// server now answers with the span and the saving it paid on — the same figures
// it writes on chain — so the app can show them.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

const TARGET = 8; // kWh a day (config.js USAGE_BENCHMARK.electric)
const submit = (srv, tag, reading) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address: WALLET, reading, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg",
});
// savedKwh is worked out on the exact span and `days` is rounded to 2 decimals,
// so the two agree to within 8 × 0.005 kWh.
const near = (a, b) => Math.abs(a - b) < 0.05;

describe("a photo reading: the answer carries its span and saving", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline({ agoMs: 30 * 3600e3 }), env: { COOLDOWN_MS: "0" } }); });
  after(async () => { await srv.stop(); });

  test("paid: 3 kWh over 30 hours saved 8 × 1.25 − 3", async () => {
    const r = await submit(srv, "save-paid", 1003);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.amount > 0, "paid");
    assert.ok(near(r.body.days, 1.25), `days ${r.body.days}`);
    assert.ok(near(r.body.savedKwh, TARGET * r.body.days - 3), `savedKwh ${r.body.savedKwh}`);
  });
});

describe("a reading at or over the target: recorded, saved 0, span still given", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { COOLDOWN_MS: "0" } }); });
  after(async () => { await srv.stop(); });

  test("recorded with savedKwh 0", async () => {
    const r = await submit(srv, "save-over", 1012);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.recorded, true);
    assert.equal(r.body.savedKwh, 0);
    assert.ok(near(r.body.days, 1), `days ${r.body.days}`);
  });
});

describe("an automatic reading: the same two figures", () => {
  let srv;
  before(async () => {
    const s = stateWithBaseline({ agoMs: 25 * 3600e3 });
    s.meterLinks = { ["a".repeat(48)]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", createdAt: Date.now() } };
    s.linkReadings = { [WALLET.toLowerCase()]: { reading: 1005, meterNo: "E1000", at: Date.now(), source: "reader" } };
    s.photoAts = { "electric:e1000": Date.now() - 86400000 };
    srv = await startServer({ state: s, env: { COOLDOWN_MS: "0", AUTO_CLAIM_ON_PUSH: "off" } });
  });
  after(async () => { await srv.stop(); });

  test("paid: 5 kWh over 25 hours", async () => {
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(near(r.body.days, 25 / 24), `days ${r.body.days}`);
    assert.ok(near(r.body.savedKwh, TARGET * r.body.days - 5), `savedKwh ${r.body.savedKwh}`);
  });
});
