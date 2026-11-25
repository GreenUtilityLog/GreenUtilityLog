// ── An automatic payout waits for a reading that covers most of a day ────────
// Paid the moment the cooldown ended, the automatic payout (every wake-up, since
// /cron/tick settles unpaid readings) took the reading lying in wait: one a reader
// sent a few hours after the last reading. Testnet, 23–25 November: 0.36 B3TR for
// about five hours, 4.00 (capped) for a day and a half, 0.16 for one hour. A
// reading too soon after the last one now waits for a newer one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, WALLET } from "./helpers.mjs";

const H = 3600e3;
const TOKEN = "e".repeat(48);
const K = "electric:e1000";
// Last paid reading 25 h ago (1000 kWh), paid 21 h ago; the reader's reading now
// waiting was taken 20 h ago, five hours after the last one.
function state() {
  const now = Date.now();
  return {
    meterOwners: { [K]: WALLET.toLowerCase() },
    readings: { [K]: 1000 },
    readingAts: { [K]: now - 25 * H },
    photoAts: { [K]: now - 10 * 86400000 },
    cooldowns: { [`${WALLET.toLowerCase()}:electric`]: now - 21 * H },
    meterLinks: { [TOKEN]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", source: "bridge", createdAt: now - 30 * 86400000 } },
    linkReadings: { [WALLET.toLowerCase()]: { reading: 1001.2, meterNo: "E1000", at: now - 20 * H, source: "push" } },
  };
}

test("a reading five hours after the last: not paid by the wake-up; the app is told it waits", async () => {
  const srv = await startServer({ state: state(), env: { AUTO_CLAIM_ON_PUSH: "on" } });
  try {
    const t = await srv.get("/cron/tick");
    assert.equal(t.body.settled, 0, JSON.stringify(t.body));
    assert.equal(srv.readState().readings[K], 1000, "still the last paid reading");
    const latest = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": TOKEN });
    assert.equal(latest.body.waitsForNewer, true);
    // The reader's next reading, a full day after the last: paid on arrival, over that day.
    assert.equal((await srv.post("/meter-ingest", { token: TOKEN, reading: 1003 })).status, 200);
    const st = await srv.waitForState((s) => s.readings[K] === 1003);
    assert.equal(st.readings[K], 1003);
    const after = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": TOKEN });
    assert.ok(after.body.lastPayout.amount > 3, `a day's saving: ${JSON.stringify(after.body.lastPayout)}`);
    assert.equal(after.body.waitsForNewer, false);
  } finally { await srv.stop(); }
});

test("the line is the cooldown itself: a reading 19 hours after the last still waits", async () => {
  const st = state();
  // Taken 19 h after the last recorded reading (which was 25 h ago).
  st.linkReadings[WALLET.toLowerCase()].at = Date.now() - 6 * H;
  const srv = await startServer({ state: st, env: { AUTO_CLAIM_ON_PUSH: "on" } });
  try {
    const t = await srv.get("/cron/tick");
    assert.equal(t.body.settled, 0, JSON.stringify(t.body));
    assert.equal(srv.readState().readings[K], 1000);
  } finally { await srv.stop(); }
});
