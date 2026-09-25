// ── Spreading the weekly allocation ──────────────────────────────────────────
// Every payout is scaled by min(1, daily budget / daily demand), where the daily
// budget is the pot divided over the days left in the round. The chain is stubbed,
// so the pot and the days left are fixed through BUDGET_POOL_B3TR/BUDGET_DAYS_LEFT.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

const DAY = 86400000;
const submit = (srv, tag, reading = 1008) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address: WALLET,
  reading, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg",
});
// A week of history: 7 days × 10 B3TR a day at full rates.
const busyWeek = () => Array.from({ length: 70 }, (_, i) => ({ t: Date.now() - 6.9 * DAY + i * (6.8 * DAY / 70), full: 1 }));

describe("a quiet week: the pot covers full rates", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { BUDGET_POOL_B3TR: "1000", BUDGET_DAYS_LEFT: "7" } }); });
  after(async () => { await srv.stop(); });

  test("pays the full amount", async () => {
    const r = await submit(srv, "quiet");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 0.2);
    assert.equal(r.body.factor, 1);
  });
});

describe("a busy week: everyone gets the same smaller share", () => {
  let srv;
  before(async () => {
    const state = { ...stateWithBaseline(), payLog: busyWeek() };
    // Pot 35 over 7 days = 5 a day, demand ≈ 10 a day → factor ≈ 0.5.
    srv = await startServer({ state, env: { BUDGET_POOL_B3TR: "35", BUDGET_DAYS_LEFT: "6.5" } });
  });
  after(async () => { await srv.stop(); });

  test("scales the payout, and says by how much", async () => {
    const h = await srv.get("/health");
    const f = h.body.rewardBudget.factor;
    assert.ok(f > 0.45 && f < 0.55, `factor ${f}`);
    const r = await submit(srv, "busy");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fullAmount, 0.2);
    assert.equal(r.body.amount, Math.floor(0.2 * r.body.factor * 100) / 100);
  });

  test("and records the full-rate amount as demand, not the scaled one", async () => {
    const st = await srv.waitForState((s) => (s.payLog || []).length === 71);
    assert.equal(st.payLog.at(-1).full, 0.2);
  });
});

describe("an empty pot", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { BUDGET_POOL_B3TR: "0", BUDGET_DAYS_LEFT: "3" } }); });
  after(async () => { await srv.stop(); });

  test("pays nothing, uses nothing up, and says when it comes back", async () => {
    const r = await submit(srv, "empty");
    assert.equal(r.status, 503);
    assert.match(r.body.error, /budget is used up.*next VeBetterDAO round/);
    const st = srv.readState();
    assert.equal(st.readings["electric:e1000"], 1000, "baseline untouched");
    assert.equal(Object.keys(st.cooldowns || {}).length, 0, "no cooldown started");
  });
});

describe("the eco bonus follows the same budget", () => {
  let srv;
  before(async () => {
    const state = { ...stateWithBaseline(), payLog: busyWeek() };
    srv = await startServer({ state, env: { BUDGET_POOL_B3TR: "35", BUDGET_DAYS_LEFT: "6.5" } });
  });
  after(async () => { await srv.stop(); });

  test("scaled like everything else", async () => {
    const r = await srv.post("/eco-action", { address: WALLET, appliance: "washer", photo: photo("eco-busy"), photoMime: "image/jpeg" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fullAmount, 2);
    assert.ok(r.body.amount < 2 && r.body.amount > 0.8, `amount ${r.body.amount}`);
  });
});
