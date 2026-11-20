// ── Testers carried over from testnet at go-live ─────────────────────────────
// The first mainnet start reads the testnet state (an Upstash stand-in here) and
// adds what testers had set up, so a reader keeps sending with its old token and
// is paid from the testnet's last reading. Payouts, cooldowns, roles, flags and
// settings stay behind; mainnet's own entries win; it runs once.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, WALLET, OTHER } from "./helpers.mjs";

const H = 3600e3;
const KEY = "greenutilitylog:state";
const TOKEN = "a".repeat(48), TOKEN2 = "b".repeat(48), TOKEN3 = "c".repeat(48);
const THIRD = "0x3333333333333333333333333333333333333333";
const w = (a) => a.toLowerCase();

// The testnet state as a deployment holds it: the main value plus the hashes in a
// key of their own (store.js parts).
function testnetState() {
  const now = Date.now();
  return {
    meterOwners: { "electric:e1000": w(WALLET), "electric:e2000": w(THIRD), "electric:e3000": w(OTHER) },
    readings: { "electric:e1000": 1000, "electric:e2000": 500, "electric:e3000": 700 },
    readingAts: { "electric:e1000": now - 25 * H, "electric:e2000": now - 25 * H, "electric:e3000": now - 25 * H },
    photoAts: { "electric:e1000": now - 10 * 86400000 },
    meterLinks: {
      [TOKEN]: { address: w(WALLET), meterNo: "E1000", utility: "electric", source: "bridge", createdAt: now - 30 * 86400000, autoPaidAt: now - 25 * H, lastPayout: { amount: 2, txid: "0x" + "ab".repeat(32), at: now - 25 * H, reading: 1000 } },
      [TOKEN2]: { address: w(THIRD), meterNo: "E2000", utility: "electric", source: "bridge", createdAt: now },
    },
    linkReadings: { [w(WALLET)]: { reading: 1000, at: now - 25 * H } },
    tibber: { [w(OTHER)]: { sealed: "x", meterNo: "E3000", homeId: "h1" } },
    readDevices: { "i:0123456789abcdef0123456789abcdef": [w(WALLET)] },
    bans: { [w("0x4444444444444444444444444444444444444444")]: now },
    cooldowns: { [`${w(WALLET)}:electric`]: now },
    passes: { [w(WALLET)]: { no: 1, tier: "tester", issuedAt: now } },
    flags: { f1: { address: w(WALLET), reason: "testnet flag" } },
    settings: { access: "everyone" },
    payDays: { "2026-11-19|abc": 12 },
  };
}

function upstash(kv) {
  const asked = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const args = JSON.parse(b || "[]");
      asked.push({ auth: req.headers.authorization, args });
      let result = null;
      if (args[0] === "MGET") result = args.slice(1).map((k) => kv.get(k) ?? null);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, asked, url: `http://127.0.0.1:${srv.address().port}` })));
}
const kvFor = (st, hashes = { h_testnet: Date.now() }) => new Map([[KEY, JSON.stringify(st)], [`${KEY}:part:hashes`, JSON.stringify({ hashes })]]);

// What is already on "mainnet" before the carry-over: OTHER owns E2000 there.
const mainnetBefore = () => ({ meterOwners: { "electric:e2000": w(OTHER) }, readings: { "electric:e2000": 9000 }, readingAts: { "electric:e2000": Date.now() } });

describe("without CARRY_OVER_KEY nothing is carried over (the control)", () => {
  let srv, up;
  before(async () => {
    up = await upstash(kvFor(testnetState()));
    srv = await startServer({ state: {}, env: { CARRY_OVER_URL: up.url, CARRY_OVER_TOKEN: "tok" } });
  });
  after(async () => { await srv.stop(); up.srv.close(); });
  test("the old reader token is unknown and the source isn't read", async () => {
    const r = await srv.post("/meter-ingest", { token: TOKEN, reading: 1004 });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(up.asked.length, 0);
    assert.equal((await srv.get("/health")).body.carryOver, null);
  });
});

describe("carried over: a tester's reader keeps working on mainnet", () => {
  let srv, up;
  before(async () => {
    up = await upstash(kvFor(testnetState()));
    srv = await startServer({ state: mainnetBefore(), env: { CARRY_OVER_KEY: KEY, CARRY_OVER_URL: up.url, CARRY_OVER_TOKEN: "tok", COOLDOWN_MS: "0" } });
    await srv.waitForState((s) => s.settings?.carriedOver, 6000);
  });
  after(async () => { await srv.stop(); up.srv.close(); });

  test("read from the testnet database, with its token, main value and hashes part", () => {
    const mget = up.asked.find((a) => a.args[0] === "MGET");
    assert.equal(mget.auth, "Bearer tok");
    assert.deepEqual(mget.args.slice(1, 3), [KEY, `${KEY}:part:hashes`]);
  });

  test("meters, starting points, photo clock, reader link, cloud link, devices, bans, hashes: carried", () => {
    const s = srv.readState();
    assert.equal(s.meterOwners["electric:e1000"], w(WALLET));
    assert.equal(s.readings["electric:e1000"], 1000);
    assert.ok(s.readingAts["electric:e1000"] < Date.now() - 24 * H);
    assert.ok(s.photoAts["electric:e1000"]);
    assert.equal(s.meterLinks[TOKEN].address, w(WALLET));
    assert.equal(s.meterLinks[TOKEN].autoPaidAt > 0, true, "keeps what the pairing went through");
    assert.equal(s.meterLinks[TOKEN].lastPayout, undefined, "a testnet payout isn't shown as a mainnet one");
    assert.equal(s.linkReadings[w(WALLET)].reading, 1000);
    assert.equal(s.tibber[w(OTHER)].homeId, "h1");
    assert.deepEqual(s.readDevices["i:0123456789abcdef0123456789abcdef"], [w(WALLET)]);
    assert.ok(s.bans[w("0x4444444444444444444444444444444444444444")]);
    assert.ok(s.hashes.h_testnet, "a photo that earned on testnet can't earn again");
  });

  test("payouts, cooldowns, roles, flags and settings stay behind", () => {
    const s = srv.readState();
    assert.equal(s.cooldowns?.[`${w(WALLET)}:electric`], undefined);
    assert.equal(s.passes?.[w(WALLET)], undefined);
    assert.equal(s.flags?.f1, undefined);
    assert.equal(s.settings?.access, undefined);
    assert.equal(Object.keys(s.payDays || {}).length, 0);
  });

  test("a meter already owned on mainnet keeps its mainnet owner, reading and no testnet link", () => {
    const s = srv.readState();
    assert.equal(s.meterOwners["electric:e2000"], w(OTHER));
    assert.equal(s.readings["electric:e2000"], 9000);
    assert.equal(s.meterLinks[TOKEN2], undefined);
  });

  test("the old token sends, and the reading is paid from the testnet's last one", async () => {
    const r = await srv.post("/meter-ingest", { token: TOKEN, reading: 1004 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await srv.post("/reward-from-meter", { address: WALLET, utility: "electric", meterNo: "E1000" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.ok(p.body.amount > 0, JSON.stringify(p.body));
    assert.equal(srv.readState().readings["electric:e1000"], 1004);
  });

  test("/health says it ran, and what came over", async () => {
    const c = (await srv.get("/health")).body.carryOver;
    assert.equal(c.problem, null);
    assert.equal(c.done.from, KEY);
    assert.equal(c.done.meters, 2);
    assert.equal(c.done.links, 1);
    assert.equal(c.done.cloud, 1);
  });
});

describe("it runs once: a later start doesn't bring back what was removed", () => {
  let srv, up;
  before(async () => {
    up = await upstash(kvFor(testnetState()));
    srv = await startServer({ state: { settings: { carriedOver: { at: Date.now() - H, from: KEY, meters: 2 } } }, env: { CARRY_OVER_KEY: KEY, CARRY_OVER_URL: up.url, CARRY_OVER_TOKEN: "tok" } });
  });
  after(async () => { await srv.stop(); up.srv.close(); });
  test("the source isn't read again, the old token stays unknown", async () => {
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(up.asked.length, 0);
    assert.equal((await srv.post("/meter-ingest", { token: TOKEN, reading: 1004 })).status, 401);
  });
});

test("pointing it at this server's own state is refused", async () => {
  const { spawn } = await import("node:child_process");
  const script = `const c = await import("./carryover.js"); console.log("PROBLEM:" + c.carryOverProblem()); process.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9", UPSTASH_REDIS_REST_TOKEN: "t", STATE_KEY: KEY, CARRY_OVER_KEY: KEY, REDIS_TIMEOUT_MS: "500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  assert.match(out, /PROBLEM:CARRY_OVER_KEY is this server's own STATE_KEY/, out);
});
