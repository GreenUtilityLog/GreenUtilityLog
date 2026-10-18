// ── Holes found in the money-path audit (October) ────────────────────────────
// Each case was a working way to be paid more than the rules allow, to be paid
// twice, or to lock an honest user out. They stay as tests so a later change
// cannot quietly reopen one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, photo, stateWithBaseline, WALLET, OTHER } from "./helpers.mjs";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// An OCR service that answers what the test sets: `reading` is what the provider
// says the display shows (as Claude does), `text` everything else on the photo.
async function fakeOcr() {
  const o = { answer: {} };
  o.srv = createServer((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify(o.answer))); });
  await new Promise((r) => o.srv.listen(0, "127.0.0.1", r));
  o.url = `http://127.0.0.1:${o.srv.address().port}/ocr`;
  return o;
}

describe("the reading on the photo is the display's, not any number on it", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({
      state: stateWithBaseline({ reading: 15000 }),
      env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("a register of 1 matching the '1' of '1.8.0' no longer passes", async () => {
    // Display 15010 (honest pay: base only). The claim keeps the baseline almost
    // still and leans on a tiny second "register" that matches the OBIS code.
    ocr.answer = { reading: "15010", text: "15010 kWh 1.8.0 230 V 50 Hz", numbers: [15010, 1.8, 230, 50] };
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET,
      reading: 15000.2, registers: [14999.2, 1], prevRead: 15000, photo: photo("obis"), photoMime: "image/jpeg",
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(srv.readState().readings["electric:e1000"], 15000);
  });

  test("a new meter can't start on the voltage label", async () => {
    ocr.answer = { reading: "15010", text: "15010 kWh 230 V", numbers: [15010, 230] };
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "NEWMETER1", address: OTHER,
      reading: 230, prevRead: 230, photo: photo("volt"), photoMime: "image/jpeg",
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /not what the photo shows/);
  });

  test("the display's own number is paid", async () => {
    ocr.answer = { reading: "15010", text: "15010 kWh 230 V", numbers: [15010, 230] };
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET,
      reading: 15010, prevRead: 15000, photo: photo("display"), photoMime: "image/jpeg",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("a provider that returns all text on the photo", () => {
  let srv, ocr;
  before(async () => {
    ocr = await fakeOcr();
    srv = await startServer({ state: stateWithBaseline({ reading: 15000 }), env: { CUSTOM_OCR_URL: ocr.url, OCR_PROVIDER_ORDER: "custom", COOLDOWN_MS: "0" } });
  });
  after(async () => { await srv.stop(); ocr.srv.close(); });

  test("only numbers of four whole digits or more count", async () => {
    ocr.answer = { text: "230 V 50 Hz 15006", numbers: [230, 50, 15006] };
    const bad = await srv.post("/reward", {
      utility: "electric", meterNo: "SHORTNO1", address: OTHER, reading: 230, prevRead: 230,
      photo: photo("text-230"), photoMime: "image/jpeg",
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    const good = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET, reading: 15006, prevRead: 15000,
      photo: photo("text-15006"), photoMime: "image/jpeg",
    });
    assert.equal(good.status, 200, JSON.stringify(good.body));
  });
});

describe("photos", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("one the server can't decode is refused, not waved past the likeness check", async () => {
    const buf = Buffer.from(photo("cut"), "base64");
    const cut = buf.subarray(0, buf.length - 400).toString("base64");
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET, reading: 1005, prevRead: 1000, photo: cut, photoMime: "image/jpeg",
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /can't be read/);
    assert.equal(srv.readState().readings["electric:e1000"], 1000);
  });
});

describe("a meter number inside another wallet's", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline({ meterNo: "E12345678" }) }); });
  after(async () => { await srv.stop(); });

  test("can't be registered — it would pass the sticker check against their meter", async () => {
    for (const meterNo of ["2345678", "Е12345678"]) {   // a part, and a Cyrillic look-alike "Е"
      const r = await srv.post("/reward", {
        utility: "electric", meterNo, address: OTHER, reading: 500, prevRead: 500, photo: photo(`overlap-${meterNo}`), photoMime: "image/jpeg",
      });
      assert.equal(r.status, 400, `${meterNo}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /overlaps one registered to another wallet/);
    }
  });
});

describe("one phone, one wallet — after a refused attempt", () => {
  let srv;
  const PHONE = { id: "c".repeat(32), fp: "d".repeat(64) };
  before(async () => {
    const s = stateWithBaseline();
    s.meterOwners["electric:e2000"] = OTHER.toLowerCase(); s.readings["electric:e2000"] = 1000; s.readingAts["electric:e2000"] = Date.now();
    srv = await startServer({ state: s, env: { REQUIRE_DEVICE: "true" } });
  });
  after(async () => { await srv.stop(); });

  test("a wrong wallet's failed try doesn't take the phone's only slot", async () => {
    // Fails after the device check: a photo too small to be one.
    const tiny = Buffer.from("not a photo").toString("base64");
    const failed = await srv.post("/reward", {
      utility: "electric", meterNo: "E2000", address: OTHER, reading: 1005, prevRead: 1000, photo: tiny, photoMime: "image/jpeg", device: PHONE,
    });
    assert.equal(failed.status, 400, JSON.stringify(failed.body));
    const right = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET, reading: 1005, prevRead: 1000, photo: photo("rightwallet"), photoMime: "image/jpeg", device: PHONE,
    });
    assert.equal(right.status, 200, JSON.stringify(right.body));
  });

  test("and once a wallet is paid there, the phone is its own", async () => {
    const r = await srv.post("/reward", {
      utility: "electric", meterNo: "E2000", address: OTHER, reading: 1005, prevRead: 1000, photo: photo("second"), photoMime: "image/jpeg", device: PHONE,
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
});

describe("paid photo checks per wallet per day", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { PHOTO_CHECKS_PER_WALLET_DAY: "2" } }); });
  after(async () => { await srv.stop(); });

  test("failed attempts count too — the same photo can't run up the bill all day", async () => {
    const tiny = Buffer.from("not a photo").toString("base64");
    const go = () => srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1005, prevRead: 1000, photo: tiny, photoMime: "image/jpeg" });
    assert.equal((await go()).status, 400);
    assert.equal((await go()).status, 400);
    const third = await go();
    assert.equal(third.status, 429, JSON.stringify(third.body));
    assert.match(third.body.error, /too many photo attempts today/);
  });
});

describe("photo uploads per caller", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("a third upload at once from one caller is turned away, not everyone's", async () => {
    // Two uploads that never finish arriving hold this caller's two places.
    const net = await import("node:net");
    const port = new URL(srv.base).port;
    const hold = () => new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write("POST /reward HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{");
        setTimeout(() => resolve(s), 300);
      });
    });
    const a = await hold(), b = await hold();
    const third = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1005, prevRead: 1000, photo: photo("third"), photoMime: "image/jpeg" });
    assert.equal(third.status, 429, JSON.stringify(third.body));
    a.destroy(); b.destroy();
    await new Promise((r) => setTimeout(r, 300));
    const after = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1005, prevRead: 1000, photo: photo("after"), photoMime: "image/jpeg" });
    assert.equal(after.status, 200, JSON.stringify(after.body));
  });
});

describe("the emergency stop", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline(), env: { PAYOUTS_PAUSED: "true" } }); });
  after(async () => { await srv.stop(); });

  test("PAYOUTS_PAUSED stops a payout before anything is sent, and says so in /health", async () => {
    assert.equal((await srv.get("/health")).body.payoutsPaused, true);
    const r = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1005, prevRead: 1000, photo: photo("paused"), photoMime: "image/jpeg" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.error, /paused/);
    assert.equal(srv.readState().readings["electric:e1000"], 1000, "nothing recorded");
  });
});

// ── Boot: a server that would pay wrongly must not start ─────────────────────
function boot(env) {
  return new Promise(async (resolve) => {
    const redis = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end('{"result":null}'); }); });
    await new Promise((r) => redis.listen(0, "127.0.0.1", r));
    const base = { ...process.env, PORT: "0", DISTRIBUTOR_DRY_RUN: "1", STATE_FILE: join(tmpdir(), `gul-boot-${process.pid}-${Math.random()}.json`) };
    for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "STATE_KEY", "ANTHROPIC_API_KEY", "CUSTOM_OCR_URL", "NETWORK", "READING_CHECK"]) delete base[k];
    const redisEnv = { UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redis.address().port}`, UPSTASH_REDIS_REST_TOKEN: "t" };
    const child = spawn(process.execPath, ["index.js"], {
      cwd: SERVER_DIR,
      env: { ...base, ...(env.redis ? redisEnv : {}), ...env.vars },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on("exit", (code) => { clearTimeout(timer); redis.close(); resolve({ code, out }); });
  });
}
const MAINNET = { NETWORK: "mainnet", REQUIRE_CERT: "true", STATE_KEY: "greenutilitylog:mainnet" };

describe("boot refuses", () => {
  test("mainnet without durable storage", async () => {
    for (const vars of [MAINNET, { ...MAINNET, UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9" }]) {
      const r = await boot({ vars });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /needs durable storage/);
    }
  });

  test("mainnet without the reading on the photo checked", async () => {
    const r = await boot({ redis: true, vars: MAINNET });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs the reading on the photo checked/);
  });

  test("mainnet without its own admin list, or without the distributor key", async () => {
    const ready = { ...MAINNET, CUSTOM_OCR_URL: "http://127.0.0.1:9/ocr", OCR_PROVIDER_ORDER: "custom" };
    let r = await boot({ redis: true, vars: ready });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs ADMIN_WALLETS/);
    r = await boot({ redis: true, vars: { ...ready, ADMIN_WALLETS: "0x1111111111111111111111111111111111111111", DISTRIBUTOR_DRY_RUN: "" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /needs the distributor key/);
  });

  test("a network name that would fall back to testnet and skip every guard", async () => {
    const r = await boot({ vars: { NETWORK: "Mainnet" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /NETWORK must be "mainnet" or "testnet"/);
  });

  test("a limit that isn't a number, instead of silently switching it off", async () => {
    const r = await boot({ vars: { COOLDOWN_MS: "20h" } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /COOLDOWN_MS="20h"/);
  });
});
