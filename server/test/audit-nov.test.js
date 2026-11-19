// ── Audit, November: what the review found, each held to its fix ──────────────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, stateWithBaseline, adminSigner, WALLET, OTHER } from "./helpers.mjs";
import { READING_TYPES } from "../mojelektro.js";

const H = 3600e3;
const SECRET = "a-test-secret-of-some-length";
const listen = (handler) => new Promise((r) => { const srv = createServer(handler).listen(0, "127.0.0.1", () => r(srv)); });

// MojElektro reports a day late. The automatic payout compared the meter's time
// with when the last payout was MADE, so a total arriving more than a day late was
// skipped every time (paid only by tapping "claim").
describe("MojElektro: a total more than a day late is still paid automatically", () => {
  let srv, me;
  const blocks = { v: [] };
  before(async () => {
    me = await listen((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ intervalBlocks: blocks.v })); });
    // Last reading 1000 at meter time 60 h ago, paid 24 h ago.
    const st = stateWithBaseline({ agoMs: 60 * H });
    st.cooldowns[`${WALLET.toLowerCase()}:electric`] = Date.now() - 24 * H;
    srv = await startServer({ state: st, env: { MOJELEKTRO: "on", MOJELEKTRO_API_URL: `http://127.0.0.1:${me.address().port}/mojelektro/v1`, POWERFOX_SECRET: SECRET, AUTO_CLAIM_ON_PUSH: "on", COOLDOWN_MS: "0" } });
  });
  after(async () => { await srv.stop(); me.close(); });
  test("the next daily total (36 h old) is paid on arrival", async () => {
    const stamp = (ms) => new Date(ms + 3600e3).toISOString().slice(0, 19) + "+0100";
    blocks.v = [{ readingType: READING_TYPES.total, intervalReadings: [{ timestamp: stamp(Date.now() - 36 * H), value: "1004" }] }];
    const r = await srv.post("/meter/mojelektro/link", { address: WALLET, meterNo: "E1000", mojToken: "moj-token-abcdefghijklmnop-1234567890", usagePoint: "3-1234567" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1004, 6000);
    assert.equal(st.readings["electric:e1000"], 1004);
  });
});

// A starting point set without a photo (an admin's set-baseline here) owes a photo
// before an automatic payout — also for Powerfox/Tibber/MojElektro, which need no
// repeat photo. Without it, a cloud account for another meter could be paid on.
describe("a starting point set by hand: a cloud source waits for a photo too", () => {
  let srv, admin;
  before(async () => {
    admin = await adminSigner();
    const st = stateWithBaseline({ agoMs: 25 * H });
    st.meterLinks = { ["a".repeat(48)]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", source: "powerfox", createdAt: Date.now() } };
    st.photoAts = { "electric:e1000": Date.now() - 86400000 };
    srv = await startServer({ state: st, env: { ADMIN_WALLETS: admin.address, COOLDOWN_MS: "0", AUTO_CLAIM_ON_PUSH: "off" } });
  });
  after(async () => { await srv.stop(); });
  test("before: no photo is owed", async () => {
    assert.equal(srv.readState().photoOwed?.["electric:e1000"], undefined);
  });
  test("after the admin sets the starting point: refused until a photo", async () => {
    const set = await admin.call(srv, "/admin/set-baseline", { meterNo: "E1000", utility: "electric", reading: 54321, targetWallet: WALLET });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    // A reading from the cloud account, as the Powerfox tick would store it.
    const ingest = await srv.post("/meter-ingest", { token: "a".repeat(48), reading: 54330 });
    assert.equal(ingest.status, 200, JSON.stringify(ingest.body));
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.needsPhoto, true);
  });
});

describe("a payout request with a malformed address is told so, not 'no access'", () => {
  let srv;
  before(async () => { srv = await startServer({ state: { settings: { access: "roles" } } }); });
  after(async () => { await srv.stop(); });
  for (const path of ["/reward", "/reward-from-meter"]) {
    test(path, async () => {
      const r = await srv.post(path, { address: "0xabc", utility: "electric", meterNo: "E1" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /invalid wallet address/);
    });
  }
});

// The shared reservation on a Powerfox account is kept for two minutes after a link
// (as for a Tibber home): another process sees a new link only on its 30 s pull.
describe("Powerfox: an account just linked can't be linked to a second wallet at once", () => {
  let srv, pf;
  before(async () => {
    pf = await listen((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ Outdated: false, Watt: 1, Timestamp: Math.floor(Date.now() / 1000), A_Plus: 1004.5 })); });
    srv = await startServer({ state: stateWithBaseline(), env: { POWERFOX_API_URL: `http://127.0.0.1:${pf.address().port}/api/2.0`, POWERFOX_SECRET: SECRET, AUTO_CLAIM_ON_PUSH: "off" } });
  });
  after(async () => { await srv.stop(); pf.close(); });
  test("link A, unlink A, link B straight away: refused", async () => {
    const login = { email: "me@example.de", password: "Sehr-Geheim-123" };
    assert.equal((await srv.post("/meter/powerfox/link", { address: WALLET, meterNo: "E1000", ...login })).status, 200);
    assert.equal((await srv.post("/meter/powerfox/unlink", { address: WALLET })).status, 200);
    const b = await srv.post("/meter/powerfox/link", { address: OTHER, meterNo: "E2000", ...login });
    assert.equal(b.status, 409, JSON.stringify(b.body));
  });
  test("the same wallet linking again is let through", async () => {
    const r = await srv.post("/meter/powerfox/link", { address: WALLET, meterNo: "E1000", email: "me@example.de", password: "Sehr-Geheim-123" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

// Login attempts on the cloud links are limited per network address too: wallets
// cost nothing to make.
describe("cloud link attempts: at most 20 an hour from one address, whatever the wallet", () => {
  let srv;
  before(async () => { srv = await startServer({ state: {}, env: { POWERFOX_SECRET: SECRET } }); });
  after(async () => { await srv.stop(); });
  test("the 21st attempt from one address is refused", async () => {
    let last;
    for (let i = 0; i < 21; i++) {
      const address = "0x" + (i + 1).toString(16).padStart(40, "0");
      last = await fetch(srv.base + "/meter/tibber/link", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.7.7.7" }, body: JSON.stringify({ address, meterNo: "E1", tibberToken: "x" }) });
      if (i < 20) assert.notEqual(last.status, 429, `attempt ${i + 1}`);
    }
    assert.equal(last.status, 429);
  });
});
