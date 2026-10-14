// ── One phone, many wallets ──────────────────────────────────────────────────
// The app sends a random install id (the same for every wallet used in it) and a
// hardware fingerprint. Past DEVICE_MAX_WALLETS wallets on one install id the
// payout is refused; a fingerprint shared by many wallets, or no device id at all,
// is only flagged. See server/device.js.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline } from "./helpers.mjs";

const W = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];
const PHONE = { id: "a".repeat(32), fp: "b".repeat(64) };

// Every wallet owns its own baselined meter, E1..E4.
function state() {
  const s = stateWithBaseline({ wallet: W[0], meterNo: "E1" });
  W.forEach((w, i) => {
    const k = `electric:e${i + 1}`;
    s.meterOwners[k] = w.toLowerCase();
    s.readings[k] = 1000;
    s.readingAts[k] = Date.now();
  });
  return s;
}
const submit = (srv, i, device) => srv.post("/reward", {
  utility: "electric", meterNo: `E${i + 1}`, address: W[i], reading: 1005, prevRead: 1000,
  photo: photo(`dev${i}`), photoMime: "image/jpeg", ...(device === undefined ? {} : { device }),
});
const flagsFor = (srv, addr) => Object.values(srv.readState().flags || {}).filter((f) => f.addr === addr.toLowerCase()).map((f) => f.reason || "").join(" | ");

describe("device recognition", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state() }); });
  after(async () => { await srv.stop(); });

  test("is announced in /health: one wallet per phone", async () => {
    const h = await srv.get("/health");
    assert.equal(h.body.device.maxWallets, 1);
  });

  test("the first wallet on a phone is paid", async () => {
    const r = await submit(srv, 0, PHONE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("a second wallet on the same phone is refused", async () => {
    const r = await submit(srv, 1, PHONE);
    assert.equal(r.status, 403);
    assert.equal(r.body.device, true);
    assert.match(r.body.error, /already used by 1 other wallet —/);
    await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => f.addr === W[1].toLowerCase()));
    assert.match(flagsFor(srv, W[1]), /refused: this phone was already used by 0x1111/);
  });

  test("and keeps being refused — the first wallet keeps its place", async () => {
    assert.equal((await submit(srv, 1, PHONE)).status, 403);
    assert.equal((await submit(srv, 0, { ...PHONE })).status === 403, false);
  });

  test("no device id is paid, but flagged", async () => {
    const r = await submit(srv, 3);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => f.addr === W[3].toLowerCase()));
    assert.match(flagsFor(srv, W[3]), /no device id/);
  });

  test("the state holds hashes only, never the install id itself", async () => {
    await srv.waitForState((s) => s.devices && Object.keys(s.devices).length >= 2);
    const raw = JSON.stringify(srv.readState().devices);
    assert.ok(!raw.includes(PHONE.id));
    assert.ok(Object.keys(srv.readState().devices).every((k) => /^[if]:[0-9a-f]{32}$/.test(k)));
  });
});

describe("two wallets per phone allowed", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state(), env: { DEVICE_MAX_WALLETS: "2" } }); });
  after(async () => { await srv.stop(); });

  test("the second wallet is paid and flagged, the third refused", async () => {
    assert.equal((await submit(srv, 0, PHONE)).status, 200);
    assert.equal((await submit(srv, 1, PHONE)).status, 200);
    await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => f.addr === W[1].toLowerCase()));
    assert.match(flagsFor(srv, W[1]), /phone shared with 0x1111/);
    const r = await submit(srv, 2, PHONE);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /already used by 2 other wallets/);
  });
});

describe("device recognition switched off", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state(), env: { DEVICE_MAX_WALLETS: "0" } }); });
  after(async () => { await srv.stop(); });

  test("three wallets on one phone are all paid", async () => {
    for (const i of [0, 1, 2]) {
      const r = await submit(srv, i, PHONE);
      assert.equal(r.status, 200, `wallet ${i}: ${JSON.stringify(r.body)}`);
    }
  });
});
