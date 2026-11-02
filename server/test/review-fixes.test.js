// ── Found in the full review (November) ───────────────────────────────────────
// Each case paid more than the rules allow, locked an honest user out, or broke a
// reader's setup. They stay as tests so a later change can't bring one back.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

const DAY = 86400000;
const submit = (srv, meterNo, reading, tag) => srv.post("/reward", {
  utility: "electric", meterNo, address: WALLET, reading, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg",
});

describe("the same meter number spelled differently", () => {
  let srv;
  // E1000 was last read two days ago at 1000.
  before(async () => { srv = await startServer({ state: stateWithBaseline({ agoMs: 2 * DAY }), env: { COOLDOWN_MS: "0" } }); });
  after(async () => { await srv.stop(); });

  test("is one meter: one baseline, one date, so the same days can't be paid twice", async () => {
    const a = await submit(srv, "E-1000", 1010, "dash");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(!a.body.recorded, "measured from E1000's reading, not a fresh first reading: " + JSON.stringify(a.body));
    let st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1010);
    assert.equal(st.readings["electric:e1000"], 1010);
    assert.equal(st.readings["electric:e-1000"], undefined, "no second baseline under the other spelling");
    // Another spelling right after: measured from 1010 just now, not from 1000 two days ago.
    const b = await submit(srv, "e 1000", 1012, "space");
    assert.equal(b.status, 200, JSON.stringify(b.body));
    st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1012);
    assert.equal(st.readings["electric:e1000"], 1012);
    assert.equal(b.body.usage, 2);
  });
});

describe("a month between two readings", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline({ agoMs: 30 * DAY }) }); });
  after(async () => { await srv.stop(); });

  test("is accepted (recorded, nothing to pay), not refused as implausible for good", async () => {
    // 19 kWh a day for 30 days. The target stops at a week, so this pays nothing,
    // but it has to be accepted: every later reading would be higher still.
    const r = await submit(srv, "E1000", 1570, "gap");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.recorded, true);
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1570);
    assert.equal(st.readings["electric:e1000"], 1570, "the new starting point");
  });
});

describe("automatic readers", () => {
  let srv;
  const TOKEN = "a".repeat(48);
  const linked = () => {
    const state = stateWithBaseline();
    state.meterLinks = {
      [TOKEN]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", createdAt: 1, source: "tibber", keepsReader: true,
        autoPaidAt: 5, lastPayout: { amount: 1.2, txid: "0x" + "1".repeat(64), at: 5, reading: 1000 } },
    };
    state.tibber = { [WALLET.toLowerCase()]: { cred: "x", token: TOKEN, homeId: "h1", linkedAt: 1, lastPullAt: 1 } };
    return state;
  };
  before(async () => { srv = await startServer({ state: linked(), env: { POWERFOX_SECRET: "a-test-secret-of-some-length" } }); });
  after(async () => { await srv.stop(); });

  test("pairing again keeps the last payout and the source", async () => {
    const own = await startServer({ state: linked(), env: { POWERFOX_SECRET: "a-test-secret-of-some-length" } });
    try {
      const r = await own.post("/meter/pair", { address: WALLET, meterNo: "E1000" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.token, TOKEN);
      // Wait for the write itself: pairing stamps a new createdAt.
      const link = (await own.waitForState((s) => s.meterLinks[TOKEN]?.createdAt > 1)).meterLinks[TOKEN];
      assert.ok(link.createdAt > 1, "the pairing was saved");
      assert.equal(link.lastPayout?.amount, 1.2, "the app still shows what was paid, and offers no second claim");
      assert.equal(link.source, "tibber");
    } finally { await own.stop(); }
  });

  test("a token header with non-ASCII bytes is a wrong token, not a server error", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": "é".repeat(48) });
    assert.equal(r.status, 200);
  });

  test("unlinking Tibber gives a P1 reader its token back instead of deleting it", async () => {
    const r = await srv.post("/meter/tibber/unlink", { address: WALLET });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await srv.waitForState((s) => !(s.tibber || {})[WALLET.toLowerCase()]);
    const link = st.meterLinks[TOKEN];
    assert.ok(link, "the reader's token still works");
    assert.equal(link.source, undefined);
    assert.equal(link.keepsReader, undefined);
    const push = await srv.post("/meter-ingest", { token: TOKEN, reading: 1003 });
    assert.equal(push.status, 200, JSON.stringify(push.body));
  });

  test("pairing without a meter number yet is allowed", async () => {
    const r = await srv.post("/meter/pair", { address: "0x" + "3".repeat(40), meterNo: "" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

});

describe("a request body the server can't read", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("gets the client error body-parser meant, not a 500", async () => {
    const res = await fetch(srv.base + "/meter/pair", { method: "POST", headers: { "Content-Type": "application/json; charset=latin1" }, body: "{}" });
    assert.equal(res.status, 415);
  });
});
