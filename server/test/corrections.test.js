// ── The two ways a starting point can be corrected ───────────────────────────
// Both exist because a photo captures ONE tariff register while a reader reports
// the sum of both, so the stored baseline and everything after it can be on
// different scales — permanently unclaimable until something reconciles them.
//
// Both move a baseline, which is the one number that decides what every future
// submission earns. The gates around them are the whole point, so they are what
// is tested: once only, never downward, never without proof, and closed for good
// once the pairing has been paid.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET, OTHER } from "./helpers.mjs";

const METER = "E1000";
const KEY = "electric:e1000";
// One register photographed, the reader reporting both.
const REG = [3852.104, 3853.41];
const TOTAL = 7705.514;

// ── Reader route: /meter/rebaseline ──────────────────────────────────────────
describe("correcting a paired reader's starting point", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline({ reading: REG[0] }) });
    const pair = await srv.post("/meter/pair", { address: WALLET, meterNo: METER });
    token = pair.body.token;
    await srv.post("/meter-ingest", { token, reading: TOTAL });
  });
  after(async () => { await srv.stop(); });

  test("the claim is refused first, which is what makes the correction necessary", async () => {
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: METER });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /outside the plausible range/i);
  });

  test("the app is told the correction is available, and what the gap is", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`);
    assert.equal(r.body.canRebaseline, true);
    assert.equal(r.body.baseline, REG[0]);
    assert.equal(r.body.reading.reading, TOTAL);
  });

  test("it moves the starting point to what the reader reports", async () => {
    const r = await srv.post("/meter/rebaseline", { address: WALLET });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.from, REG[0]);
    assert.equal(r.body.to, TOTAL);
    assert.equal(srv.readState().readings[KEY], TOTAL);
  });

  test("it is recorded, so an admin can see a baseline was moved", async () => {
    const st = await srv.waitForState((s) => Object.keys(s.flags || {}).length > 0);
    const reasons = Object.values(st.flags).map((f) => f.reason).join(" ");
    assert.match(reasons, /starting point moved 3852\.104 → 7705\.514/);
  });

  test("it cannot pull a baseline downward", async () => {
    await srv.post("/meter-ingest", { token, reading: 7000 });
    const r = await srv.post("/meter/rebaseline", { address: WALLET });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cannot run backwards/i);
  });

  test("and the claim works afterwards", async () => {
    await srv.post("/meter-ingest", { token, reading: TOTAL + 8 });
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: METER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usage, 8);
  });
});

describe("once a reader has been paid, its starting point is settled", () => {
  let srv;
  before(async () => {
    // A pairing that has already produced a payout, with a mismatched baseline.
    const state = stateWithBaseline({ reading: REG[0] });
    state.meterLinks = {
      abc: { address: WALLET.toLowerCase(), meterNo: METER, utility: "electric",
             createdAt: Date.now(), autoPaidAt: Date.now() },
    };
    state.linkReadings = { [WALLET.toLowerCase()]: { reading: TOTAL, meterNo: METER, at: Date.now(), source: "push" } };
    srv = await startServer({ state });
  });
  after(async () => { await srv.stop(); });

  test("the endpoint refuses", async () => {
    const r = await srv.post("/meter/rebaseline", { address: WALLET });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already paid out once/i);
  });

  test("and the app is told not to offer it", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`);
    assert.equal(r.body.canRebaseline, false);
  });
});

// ── Photo route: /meter/fix-basis ────────────────────────────────────────────
describe("reconciling a photo baseline's tariff registers", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline({ reading: REG[0] }) }); });
  after(async () => { await srv.stop(); });

  test("it needs a real photo, exactly as a payout does", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: WALLET, meterNo: METER, registers: REG, photo: "",
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /photo is required/i);
  });

  test("it needs more than one register — there is nothing else to reconcile", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: WALLET, meterNo: METER, registers: [TOTAL], photo: photo("one"),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /each tariff register/i);
  });

  test("it refuses a total that is not above the current starting point", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: WALLET, meterNo: METER, registers: [100, 200], photo: photo("low"),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not above the current starting point/i);
  });

  test("it refuses a meter belonging to another wallet", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: OTHER, meterNo: METER, registers: REG, photo: photo("other"),
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /registered to another wallet/i);
  });

  test("it moves the starting point to the sum of the registers", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: WALLET, meterNo: METER, registers: REG, photo: photo("ok"),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.from, REG[0]);
    assert.equal(r.body.to, TOTAL);
    assert.equal(srv.readState().readings[KEY], TOTAL);
  });

  test("it pays nothing — it only moves where counting starts", async () => {
    const st = srv.readState();
    assert.equal(st.cooldowns[`${WALLET.toLowerCase()}:electric`], undefined,
      "a correction must not start the payout cooldown");
  });

  test("it can only be done once per meter, ever", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: WALLET, meterNo: METER, registers: [4000, 4000], photo: photo("twice"),
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already been reconciled once/i);
  });

  test("and that refusal survives a restart, because it is durable state", async () => {
    const st = srv.readState();
    assert.ok(st.basisFixed[KEY], "the reconciliation must be recorded outside the flag list");
    assert.equal(st.basisFixed[KEY].to, TOTAL);
  });
});

describe("a meter with no starting point at all", () => {
  let srv;
  before(async () => {
    const state = stateWithBaseline();
    delete state.readings[KEY];        // never photographed
    delete state.readingAts[KEY];
    srv = await startServer({ state });
  });
  after(async () => { await srv.stop(); });

  test("cannot be reconciled — the first value must still come from a photo", async () => {
    const r = await srv.post("/meter/fix-basis", {
      address: WALLET, meterNo: METER, registers: REG, photo: photo("nobase"),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no starting point yet/i);
  });
});
