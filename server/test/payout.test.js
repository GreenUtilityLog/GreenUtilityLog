// ── The rules that decide whether a wallet gets paid ─────────────────────────
// Driven over HTTP against the real server, with the chain stubbed at its single
// chokepoint. Every case here is one a tester has hit, or one that would cost
// money if it silently stopped working.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET, OTHER } from "./helpers.mjs";

const DAY = 86_400_000;
const METER = "E1000";

const submit = (srv, over = {}) => srv.post("/reward", {
  utility: "electric", meterNo: METER, address: WALLET,
  reading: 1008, prevRead: 1000, photo: photo("submit"), photoMime: "image/jpeg",
  ...over,
});

describe("a normal photo submission", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("is paid, and the amount comes from the server", async () => {
    const r = await submit(srv, { reading: 1004 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.txid, /^0x/);
    // 4 kWh in a day against the 8 kWh benchmark: 4 kWh saved × 0.61 — and only
    // that, there is no fixed amount for submitting.
    assert.equal(r.body.amount, 2.44);
  });

  test("advances the stored baseline to the reading just paid", async () => {
    assert.equal(srv.readState().readings["electric:e1000"], 1004);
  });

  test("starts the cooldown, so an immediate second attempt is refused", async () => {
    const r = await submit(srv, { reading: 1012 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cooldown/i);
  });
});

describe("what the server refuses", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("a reading below the stored baseline — meters do not run backwards", async () => {
    const r = await submit(srv, { reading: 900 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /lower than the last recorded reading/i);
  });

  test("a jump no span could ever cover", async () => {
    const r = await submit(srv, { reading: 1000 + 3853.41 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /outside the plausible range/i);
  });

  test("a meter already registered to someone else", async () => {
    const r = await submit(srv, { address: OTHER, reading: 1016 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /registered to another wallet/i);
  });

  test("a submission with no photo at all", async () => {
    const r = await submit(srv, { photo: "", reading: 1020 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /photo is required/i);
  });

  test("a photo that is not an image", async () => {
    const r = await submit(srv, { photo: Buffer.alloc(9000, 7).toString("base64"), reading: 1020 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not a recognised image/i);
  });
});

describe("the stored baseline wins over anything the client sends", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("a low prevRead cannot widen the delta", async () => {
    // The server measures from its own baseline of 1000, so this is 4 kWh of
    // usage and 4 kWh saved — not 1004 kWh of usage.
    const r = await submit(srv, { reading: 1004, prevRead: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 2.44);
  });
});

describe("the same photo cannot be paid twice", () => {
  let srv;
  // Cooldown off on purpose: with it on, a second attempt trips that first and the
  // dedupe is never reached, so the test would pass without proving anything.
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { COOLDOWN_MS: "0" } }); });
  after(async () => { await srv.stop(); });

  test("a reused photo is refused on its own merits", async () => {
    const shot = photo("reuse");
    const first = await submit(srv, { photo: shot });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(Object.keys(srv.readState().hashes).length >= 1, "the hash should be recorded");

    const again = await submit(srv, { photo: shot, reading: 1016 });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /duplicate photo/i);
  });

  test("a fresh photo goes through, so it really was the photo that was refused", async () => {
    const r = await submit(srv, { photo: photo("fresh"), reading: 1016 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("tariff registers", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline({ reading: 500 }) }); });
  after(async () => { await srv.stop(); });

  test("registers that do not add up to the reading are refused", async () => {
    const r = await submit(srv, { reading: 5000, registers: [400, 108] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /add up to 508, not 5000/);
  });

  test("a register that is not a number is refused rather than dropped", async () => {
    const r = await submit(srv, { reading: 508, registers: [400, "oops"] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /must be a number/i);
  });

  test("registers that do add up are accepted and recorded as a flag", async () => {
    const r = await submit(srv, { reading: 508, registers: [400, 108] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.flagged, true, "a multi-register payout should be reviewable");
    const st = await srv.waitForState((s) => Object.keys(s.flags || {}).length > 0);
    const reasons = Object.values(st.flags).map((f) => f.reason).join(" ");
    assert.match(reasons, /tariff registers \(400 \+ 108\)/);
  });
});

describe("a backend that could not read its own state", () => {
  let srv;
  before(async () => {
    // Redis configured but unreachable: loadState fails closed, so the store holds
    // nothing. Every device token is then unknown through no fault of the device.
    srv = await startServer({
      state: stateWithBaseline(),
      env: {
        UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1",
        UPSTASH_REDIS_REST_TOKEN: "nonsense",
      },
    });
  });
  after(async () => { await srv.stop(); });

  test("says so on /health instead of looking merely empty", async () => {
    const r = await srv.get("/health");
    assert.equal(r.body.durableState, true, "Redis IS configured");
    assert.equal(r.body.storeReady, false, "…but it was never read");
  });

  test("tells a reader to come back, rather than blaming its token", async () => {
    const r = await srv.post("/meter-ingest", { token: "whatever", reading: 1234 });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /warming up/i);
    assert.doesNotMatch(r.body.error, /unknown device token/i);
  });

  test("and refuses to pay from an empty slate", async () => {
    const r = await submit(srv);
    assert.equal(r.status, 503);
  });

  test("never hands out a device token it cannot store", async () => {
    // The quiet one. Pairing wrote through a persist() that silently skips while the
    // store is unread, so the user walked away with a token that was never saved and
    // would be "unknown" forever — looking, from the outside, like their mistake.
    const r = await srv.post("/meter/pair", { address: WALLET, meterNo: METER });
    assert.equal(r.status, 503);
    assert.equal(r.body.token, undefined, "a token handed out here can never be honoured");
  });

  test("refuses admin writes too, rather than losing them", async () => {
    // An admin sees "banned", the ban is dropped, and the wallet claims again.
    const r = await srv.post("/admin/ban", { address: WALLET, target: OTHER, ban: true });
    assert.equal(r.status, 503);
  });
});

describe("a payout records where its reading came from", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { COOLDOWN_MS: "0" } });
    const pair = await srv.post("/meter/pair", { address: WALLET, meterNo: METER });
    token = pair.body.token;
  });
  after(async () => { await srv.stop(); });

  test("a photographed reading is marked as one", async () => {
    const r = await submit(srv, { reading: 1004 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(srv.logs(), /"source":"photo"/);
  });

  test("a reader's reading is marked as automatic, so an admin can tell", async () => {
    // Nobody ever looked at this one, and there is no photo to look at — which is
    // exactly why the row has to say so.
    await srv.post("/meter-ingest", { token, reading: 1010 });
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: METER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(srv.logs(), /"source":"push"/);
    assert.doesNotMatch(srv.logs().split("source").pop(), /photo/);
  });
});

describe("a reading that saves nothing", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("is recorded without a payout: no transaction, nothing paid", async () => {
    // 8 kWh in a day is exactly the benchmark: no kWh saved, so no B3TR.
    const r = await submit(srv, { reading: 1008 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.txid, null);
    assert.equal(r.body.amount, 0);
    assert.equal(r.body.recorded, true);
    assert.match(r.body.reason, /no saving to reward/);
    assert.doesNotMatch(srv.logs(), /"amount"/, "nothing went to the chain");
  });

  test("but it is the starting point for the next one, and the cooldown runs", async () => {
    assert.equal(srv.readState().readings["electric:e1000"], 1008);
    const r = await submit(srv, { reading: 1010, photo: photo("next") });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cooldown/i);
  });
});

describe("a reading that covers several days", () => {
  let srv;
  before(async () => {
    const st = stateWithBaseline();
    st.readingAts["electric:e1000"] = Date.now() - 3 * DAY;   // last reading three days ago
    srv = await startServer({ state: st });
  });
  after(async () => { await srv.stop(); });

  test("is judged against three days of target, and the chain records that saving", async () => {
    // 15 kWh over three days against 3 × 8 = 24: 9 kWh saved — more than one day's
    // target, which is what the on-chain record used to compare against.
    const r = await submit(srv, { reading: 1015 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 4, "9 kWh × 0.61, capped at 4");
    assert.match(srv.logs(), /"savedKwh":9\b/);
    assert.match(srv.logs(), /"days":3\b/);
  });
});

describe("the eco-mode bonus has ended", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("a claim from an old app is told so, and nothing is paid", async () => {
    const r = await srv.post("/eco-action", { address: WALLET, appliance: "washer", photo: photo("eco"), photoMime: "image/jpeg" });
    assert.equal(r.status, 410);
    assert.match(r.body.error, /eco bonus has ended/);
  });
});

describe("a reader's reading is paid the moment it arrives", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { AUTO_CLAIM_ON_PUSH: "on" } });
    token = (await srv.post("/meter/pair", { address: WALLET, meterNo: METER })).body.token;
  });
  after(async () => { await srv.stop(); });

  test("no tap in the app needed", async () => {
    const r = await srv.post("/meter-ingest", { token, reading: 1004 });
    assert.equal(r.status, 200);
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1004);
    assert.equal(st.readings["electric:e1000"], 1004, "paid, so the baseline moved");
    const latest = await srv.get(`/meter/latest?address=${WALLET}`);
    assert.equal(latest.body.lastPayout.reading, 1004);
    assert.ok(latest.body.lastPayout.amount > 0);
  });

  test("and the next push inside the cooldown is kept, not paid", async () => {
    await srv.post("/meter-ingest", { token, reading: 1012 });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(srv.readState().readings["electric:e1000"], 1004);
    const latest = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": token });
    assert.equal(latest.body.reading.reading, 1012, "the newest reading is still there to be paid later");
  });
});

describe("almost no usage", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { COOLDOWN_MS: "0" } });
    token = (await srv.post("/meter/pair", { address: WALLET, meterNo: METER })).body.token;
  });
  after(async () => { await srv.stop(); });

  test("the same reading again is no longer the maximum: recorded, not paid, flagged", async () => {
    // 0 kWh in a day used to count as the best saving there is — 4 B3TR — which
    // made "type yesterday's number again" the best-paying thing to do.
    const r = await submit(srv, { reading: 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 0);
    assert.equal(r.body.recorded, true);
    assert.equal(r.body.flagged, true);
    const st = await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => /almost no usage/.test(f.reason)));
    assert.ok(st);
  });

  test("a tiny amount is not refused, just recorded without a reward", async () => {
    const r = await submit(srv, { reading: 1000.05, photo: photo("tiny") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 0);
    assert.equal(r.body.recorded, true);
  });

  test("a reader sending the same value: recorded, not paid, flagged too", async () => {
    await srv.post("/meter-ingest", { token, reading: 1000.08 });
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: METER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 0);
    assert.equal(r.body.recorded, true);
    assert.equal(r.body.txid, null);
  });

  test("real, low usage still earns the saving", async () => {
    const r = await submit(srv, { reading: 1002, photo: photo("low") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.amount > 3, `amount ${r.body.amount}`);
  });
});

describe("a reader is told when its next reading can be paid", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { AUTO_CLAIM_ON_PUSH: "off", COOLDOWN_MS: "72000000" } });
    token = (await srv.post("/meter/pair", { address: WALLET, meterNo: METER })).body.token;
  });
  after(async () => { await srv.stop(); });

  test("payable now: the next one is a cooldown from now", async () => {
    const r = await srv.post("/meter-ingest", { token, reading: 1008 });
    assert.equal(r.status, 200);
    const left = r.body.nextAt - Date.now();
    assert.ok(left > 71000000 && left <= 72000000, String(left));
  });
});
