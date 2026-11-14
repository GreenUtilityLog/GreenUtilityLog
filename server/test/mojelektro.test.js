// ── MojElektro (Slovenia): the server fetches the daily meter total ─────────
// A fake MojElektro API answers like the one the open-source clients use
// (X-API-TOKEN, /meter-readings with usagePoint, startTime, endTime and repeated
// option=ReadingType=…; intervalBlocks with readingType and intervalReadings).
// What matters:
//   - it is OFF unless MOJELEKTRO=on, even with the sealing key set;
//   - a wrong token or metering point is said plainly and nothing is stored;
//   - a good token is stored sealed;
//   - the data come a day late, so a payout measures its span to the meter's own
//     time, and a total no newer than the last recorded reading is never paid;
//   - one metering point feeds one wallet, and unlinking forgets it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, stateWithBaseline, WALLET, OTHER } from "./helpers.mjs";
import { mojElektroTotal, READING_TYPES } from "../mojelektro.js";

const TOKEN = "moj-token-abcdefghijklmnop-1234567890";
const POINT = "3-1234567";
const H = 3600e3;
const SECRET = "a-test-secret-of-some-length";
// "2026-11-13T00:00:00+0100": the format the API uses (an offset without a colon).
const stamp = (ms) => {
  const d = new Date(ms + 3600e3);
  return d.toISOString().slice(0, 19) + "+0100";
};
const block = (code, at, value) => ({ readingType: code, intervalReadings: [{ timestamp: stamp(at - 86400e3), value: String(value - 10) }, { timestamp: stamp(at), value: String(value) }] });

function fakeMojElektro() {
  const f = { blocks: [], calls: [] };
  f.srv = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    f.calls.push({ path: u.pathname, token: req.headers["x-api-token"], point: u.searchParams.get("usagePoint"), options: u.searchParams.getAll("option"), start: u.searchParams.get("startTime"), end: u.searchParams.get("endTime") });
    res.setHeader("content-type", "application/json");
    if (req.headers["x-api-token"] !== TOKEN) { res.statusCode = 401; return res.end("{}"); }
    if (u.pathname !== "/mojelektro/v1/meter-readings") { res.statusCode = 404; return res.end("{}"); }
    if (u.searchParams.get("usagePoint") !== POINT) { res.statusCode = 404; return res.end(JSON.stringify({ message: "not found" })); }
    res.end(JSON.stringify({ usagePoint: POINT, intervalBlocks: f.blocks }));
  });
  return new Promise((r) => f.srv.listen(0, "127.0.0.1", () => { f.url = `http://127.0.0.1:${f.srv.address().port}/mojelektro/v1`; r(f); }));
}

test("the total: the 1.8.0 daily state, else both tariffs at the same moment", () => {
  const at = Date.parse("2026-11-13T00:00:00+01:00");
  assert.deepEqual(mojElektroTotal({ intervalBlocks: [block(READING_TYPES.total, at, 1234.5)] }), { reading: 1234.5, at });
  assert.deepEqual(mojElektroTotal({ intervalBlocks: [block(READING_TYPES.high, at, 700), block(READING_TYPES.low, at, 534.5)] }), { reading: 1234.5, at });
  assert.equal(mojElektroTotal({ intervalBlocks: [block(READING_TYPES.high, at, 700), block(READING_TYPES.low, at - 86400e3, 534.5)] }), null, "two tariffs from different days are no reading");
  assert.equal(mojElektroTotal({ intervalBlocks: [] }), null);
  assert.equal(mojElektroTotal(null), null);
});

describe("MojElektro is off unless switched on", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { POWERFOX_SECRET: SECRET } }); });
  after(async () => { await srv.stop(); });
  test("off with only the sealing key, and says so", async () => {
    assert.equal((await srv.get("/health")).body.mojelektro.enabled, false);
    const r = await srv.post("/meter/mojelektro/link", { address: WALLET, meterNo: "E1000", mojToken: TOKEN, usagePoint: POINT });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /isn't switched on/);
  });
});

describe("MojElektro, switched on", () => {
  let srv, me;
  before(async () => {
    me = await fakeMojElektro();
    srv = await startServer({
      // The last reading was taken 30 hours ago.
      state: stateWithBaseline({ agoMs: 30 * H }),
      env: { MOJELEKTRO: "on", MOJELEKTRO_API_URL: me.url, POWERFOX_SECRET: SECRET, AUTO_CLAIM_ON_PUSH: "off", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); me.srv.close(); });
  const link = (over = {}) => srv.post("/meter/mojelektro/link", { address: WALLET, meterNo: "E1000", mojToken: TOKEN, usagePoint: POINT, ...over });

  test("is announced in /health", async () => {
    assert.equal((await srv.get("/health")).body.mojelektro.enabled, true);
  });

  test("a wrong token is refused, and nothing is stored", async () => {
    const r = await link({ mojToken: "wrong-token-0000000000000000" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /didn't accept this token/);
    assert.equal(Object.keys(srv.readState().mojelektro || {}).length, 0);
  });

  test("an unknown metering point is named as such", async () => {
    const r = await link({ usagePoint: "3-7654321" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /doesn't know this metering point/);
  });

  test("no daily total yet: said plainly", async () => {
    me.blocks = [];
    const r = await link();
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no daily meter total/);
  });

  test("the request: the token in X-API-TOKEN, the metering point, the daily A+ states", async () => {
    const c = me.calls.at(-1);
    assert.equal(c.token, TOKEN);
    assert.equal(c.point, POINT);
    assert.deepEqual(c.options, Object.values(READING_TYPES).map((x) => `ReadingType=${x}`));
    assert.match(c.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(c.end, /^\d{4}-\d{2}-\d{2}$/);
  });

  // The meter showed 1003 six hours ago (published late): 3 kWh over the 24 hours
  // since the last reading — not over the 30 hours until now.
  const meterAt = Math.floor((Date.now() - 6 * H) / 1000) * 1000;
  test("a good token links, and is stored sealed", async () => {
    me.blocks = [block(READING_TYPES.total, meterAt, 1003)];
    const r = await link();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reading, 1003);
    assert.equal(r.body.at, meterAt);
    const st = srv.readState();
    assert.ok(!JSON.stringify(st).includes(TOKEN), "the token is not in the state");
    assert.match(st.mojelektro[WALLET.toLowerCase()].cred, /^v1:/);
    assert.equal(st.mojelektro[WALLET.toLowerCase()].usagePoint, POINT);
    const latest = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": r.body.token });
    assert.equal(latest.body.reading.source, "mojelektro");
    assert.equal(latest.body.mojelektro.linked, true);
  });

  test("the payout measures its span to the meter's own time", async () => {
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Math.abs(r.body.days - 1) < 0.01, `days ${r.body.days} (30 h until now would be 1.25)`);
    assert.ok(Math.abs(r.body.savedKwh - 5) < 0.05, `savedKwh ${r.body.savedKwh}`);
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1003);
    assert.equal(st.readingAts["electric:e1000"], meterAt, "the reading is recorded at the meter's time");
  });

  test("the same total again is never paid twice", async () => {
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /isn't newer than the meter's last recorded reading/);
  });

  test("the same metering point can't feed a second wallet", async () => {
    const r = await srv.post("/meter/mojelektro/link", { address: OTHER, meterNo: "E2000", mojToken: TOKEN, usagePoint: POINT });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /already connected to another wallet/);
  });

  test("unlinking forgets the token at once", async () => {
    const r = await srv.post("/meter/mojelektro/unlink", { address: WALLET });
    assert.equal(r.body.unlinked, true);
    const st = await srv.waitForState((s) => !(s.mojelektro || {})[WALLET.toLowerCase()]);
    assert.equal((st.mojelektro || {})[WALLET.toLowerCase()], undefined);
    assert.equal(st.linkReadings[WALLET.toLowerCase()], undefined, "its reading is gone too");
  });
});

describe("MojElektro: a total from before the last recorded reading waits for a newer one", () => {
  let srv, me;
  before(async () => {
    me = await fakeMojElektro();
    // A photo an hour ago set the last reading; MojElektro has the state from six
    // hours ago, higher than the old baseline but older than the photo.
    srv = await startServer({
      state: stateWithBaseline({ agoMs: H }),
      env: { MOJELEKTRO: "on", MOJELEKTRO_API_URL: me.url, POWERFOX_SECRET: SECRET, AUTO_CLAIM_ON_PUSH: "off", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); me.srv.close(); });
  test("not paid, and the baseline stays", async () => {
    me.blocks = [block(READING_TYPES.total, Date.now() - 6 * H, 1004)];
    assert.equal((await srv.post("/meter/mojelektro/link", { address: WALLET, meterNo: "E1000", mojToken: TOKEN, usagePoint: POINT })).status, 200);
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /isn't newer than the meter's last recorded reading/);
    assert.equal(srv.readState().readings["electric:e1000"], 1000);
  });
});

describe("MojElektro: a total two or three days old still counts, five days doesn't", () => {
  let srv, me;
  before(async () => {
    me = await fakeMojElektro();
    srv = await startServer({
      state: stateWithBaseline({ agoMs: 6 * 86400e3 }),
      env: { MOJELEKTRO: "on", MOJELEKTRO_API_URL: me.url, POWERFOX_SECRET: SECRET, AUTO_CLAIM_ON_PUSH: "off", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); me.srv.close(); });

  test("five days old: stale", async () => {
    me.blocks = [block(READING_TYPES.total, Date.now() - 5 * 86400e3, 1004)];
    assert.equal((await srv.post("/meter/mojelektro/link", { address: WALLET, meterNo: "E1000", mojToken: TOKEN, usagePoint: POINT })).status, 200);
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /stale/);
  });

  test("three days old: paid, over the five days up to it", async () => {
    me.blocks = [block(READING_TYPES.total, Date.now() - 3 * 86400e3, 1010)];
    assert.equal((await srv.post("/meter/mojelektro/link", { address: WALLET, meterNo: "E1000", mojToken: TOKEN, usagePoint: POINT })).status, 200);
    const r = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Math.abs(r.body.days - 3) < 0.05, `days ${r.body.days}`);
  });
});
