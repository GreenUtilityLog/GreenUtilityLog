// Automatic readings need a photo now and then. After one photo a script could
// otherwise push "baseline + a little" every day and be paid for ever; a photo
// can't be lower than what was paid, so numbers that ran ahead are caught.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

function state({ photoDaysAgo }) {
  const s = stateWithBaseline({ agoMs: 25 * 3600e3 });
  s.meterLinks = { ["a".repeat(48)]: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", createdAt: Date.now() } };
  s.linkReadings = { [WALLET.toLowerCase()]: { reading: 1005, meterNo: "E1000", at: Date.now(), source: "reader" } };
  if (photoDaysAgo != null) s.photoAts = { "electric:e1000": Date.now() - photoDaysAgo * 86400000 };
  return s;
}
const claim = (srv) => srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });

describe("a photo in the last 30 days: automatic payouts go on", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state({ photoDaysAgo: 10 }), env: { COOLDOWN_MS: "0", AUTO_CLAIM_ON_PUSH: "off" } }); });
  after(async () => { await srv.stop(); });
  test("paid", async () => {
    const r = await claim(srv);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("the last photo is older than 30 days: paused until a photo", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state({ photoDaysAgo: 31 }), env: { COOLDOWN_MS: "0", AUTO_CLAIM_ON_PUSH: "off" } }); });
  after(async () => { await srv.stop(); });
  test("refused, and says why", async () => {
    const r = await claim(srv);
    assert.equal(r.status, 400);
    assert.equal(r.body.needsPhoto, true);
    assert.match(r.body.error, /take one photo of your meter/);
  });
  test("the app is told when the photo was due", async () => {
    const r = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": "a".repeat(48) });
    assert.ok(r.body.photoDueAt && r.body.photoDueAt < Date.now());
  });
});

describe("a meter from before this rule: its clock starts now", () => {
  let srv;
  before(async () => { srv = await startServer({ state: state({}), env: { COOLDOWN_MS: "0", AUTO_CLAIM_ON_PUSH: "off" } }); });
  after(async () => { await srv.stop(); });
  test("paid, and the photo clock is set", async () => {
    const r = await claim(srv);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await srv.waitForState((s) => s.photoAts && s.photoAts["electric:e1000"]);
    assert.ok(Date.now() - st.photoAts["electric:e1000"] < 60000);
  });
});
