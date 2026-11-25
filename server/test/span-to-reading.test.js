// ── An automatic reading is measured to when it was taken, not when it is settled ──
// A reading kept through the cooldown and settled later (a tick, a tap, the next
// push) was measured to "now": one hour of usage against twenty hours of target,
// paid as a saving that never happened. A reader owner could push once right after
// each payout and stay silent, and be paid about 4 B3TR every other cycle whatever
// was used. Now the span ends at the reading's own time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, WALLET } from "./helpers.mjs";

const H = 3600e3;
const TOKEN = "d".repeat(48);
function state({ readingAgoH, takenAgoH, reading }) {
  const now = Date.now();
  return {
    meterOwners: { "electric:e1000": WALLET.toLowerCase() },
    readings: { "electric:e1000": 1000 },
    readingAts: { "electric:e1000": now - readingAgoH * H },
    photoAts: { "electric:e1000": now - 10 * 86400000 },
    cooldowns: { [`${WALLET.toLowerCase()}:electric`]: now - readingAgoH * H },
    meterLinks: { [TOKEN]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", source: "bridge", createdAt: now - 30 * 86400000 } },
    linkReadings: { [WALLET.toLowerCase()]: { reading, meterNo: "E1000", at: now - takenAgoH * H, source: "push" } },
  };
}
const paid = async (srv) => (await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": TOKEN })).body.lastPayout;

test("0.5 kWh read one hour after the last reading, settled 19.5 h later: no saving, nothing paid", async () => {
  // 0.5 kWh in one hour is a 12 kWh/day pace: above the 8 kWh target.
  // The wait for a reading that covers most of a day (auto-span.test.js) is off
  // here: this test is about where the span ends.
  const srv = await startServer({ state: state({ readingAgoH: 20.5, takenAgoH: 19.5, reading: 1000.5 }), env: { AUTO_MIN_SPAN_MS: "0" } });
  try {
    const t = await srv.get("/cron/tick");
    assert.equal(t.status, 200, JSON.stringify(t.body));
    const p = await paid(srv);
    assert.equal(p?.amount, 0, `paid ${JSON.stringify(p)}`);
    // The next span starts at the reading's own time, not at the settle.
    const at = srv.readState().readingAts["electric:e1000"];
    assert.ok(Math.abs(at - (Date.now() - 19.5 * H)) < 60_000, `readingAt ${new Date(at).toISOString()}`);
  } finally { await srv.stop(); }
});

test("the control: a real saving over the whole span is still paid", async () => {
  // 3 kWh over 20.5 h is about 3.5 kWh/day: a saving of about 4 kWh.
  const srv = await startServer({ state: state({ readingAgoH: 20.5, takenAgoH: 0.1, reading: 1003 }) });
  try {
    await srv.get("/cron/tick");
    const p = await paid(srv);
    assert.ok(p?.amount > 1, `paid ${JSON.stringify(p)}`);
  } finally { await srv.stop(); }
});
