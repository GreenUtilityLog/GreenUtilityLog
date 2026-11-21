// ── The wake-up call also pays readings that are still unpaid ────────────────
// A reader's reading is paid on arrival. When that try misses (here: switched off,
// as a stand-in for a busy server or a restart), the reading used to wait for the
// reader's NEXT push, half a day later, while the app said "this happens by
// itself". /cron/tick (woken every few minutes) now settles it, with every usual
// check: never before the cooldown, never the same reading twice.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

const H = 3600e3;
const TOKEN = "c".repeat(48);
const withReader = (over = {}) => {
  const st = stateWithBaseline({ agoMs: 25 * H });
  st.meterLinks = { [TOKEN]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", source: "bridge", createdAt: Date.now() - 30 * 86400000 } };
  st.photoAts = { "electric:e1000": Date.now() - 10 * 86400000 };
  return { ...st, ...over };
};

describe("a reading not paid on arrival is paid at the next wake-up", () => {
  let srv;
  before(async () => { srv = await startServer({ state: withReader(), env: { AUTO_CLAIM_ON_PUSH: "off" } }); });
  after(async () => { await srv.stop(); });
  test("pushed, not paid; the tick pays it", async () => {
    assert.equal((await srv.post("/meter-ingest", { token: TOKEN, reading: 1004 })).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(srv.readState().readings["electric:e1000"], 1000, "not paid on arrival");
    const tick = await srv.get("/cron/tick");
    assert.equal(tick.status, 200, JSON.stringify(tick.body));
    assert.equal(tick.body.settled, 1, JSON.stringify(tick.body));
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1004);
    assert.equal(st.readings["electric:e1000"], 1004, "paid by the tick");
    assert.ok(st.cooldowns[`${WALLET.toLowerCase()}:electric`] > Date.now() - 60000, "its cooldown started");
  });
});

describe("the tick never pays before the cooldown, nor the same reading twice", () => {
  let srv;
  before(async () => {
    // Paid an hour ago: the 20-hour cooldown is still running.
    const st = withReader();
    st.cooldowns = { [`${WALLET.toLowerCase()}:electric`]: Date.now() - H };
    srv = await startServer({ state: st, env: { AUTO_CLAIM_ON_PUSH: "off" } });
  });
  after(async () => { await srv.stop(); });
  test("in the cooldown: not paid", async () => {
    assert.equal((await srv.post("/meter-ingest", { token: TOKEN, reading: 1004 })).status, 200);
    const tick = await srv.get("/cron/tick");
    assert.equal(tick.body.settled, 0, JSON.stringify(tick.body));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(srv.readState().readings["electric:e1000"], 1000);
  });
});
