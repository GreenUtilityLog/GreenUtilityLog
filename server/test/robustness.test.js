// ── Malformed requests must fail on their own, not take the server down ─────

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

describe("names every JavaScript object inherits", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  for (const utility of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    test(`utility "${utility}" is refused, and the server stays up`, async () => {
      const r = await srv.post("/reward", { utility, meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: photo(utility), photoMime: "image/jpeg" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal((await srv.get("/health")).status, 200);
    });
  }

  test("odd types where a string is expected don't crash it either", async () => {
    for (const body of [
      { utility: ["electric"], meterNo: { a: 1 }, address: WALLET, reading: [1008], photo: 5 },
      { utility: null, meterNo: null, address: null, reading: null },
      { address: WALLET, utility: "electric", meterNo: "E1000", reading: "1008x", prevRead: 1000, photo: photo("x") },
    ]) {
      const r = await srv.post("/reward", body);
      assert.ok(r.status >= 400 && r.status < 500, `${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const path of ["/meter/pair", "/meter-ingest", "/reward-from-meter", "/eco-action", "/meter/rebaseline", "/wallet/seen"]) {
      const r = await srv.post(path, { address: { $ne: 1 }, token: ["x"], reading: { a: 1 }, utility: "constructor", meterNo: [1] });
      assert.ok(r.status < 500 || r.status === 503, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await srv.get("/health")).status, 200);
  });
});

describe("utilities the app doesn't offer", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("are refused — one meter can't be claimed once per utility per day", async () => {
    for (const utility of ["solar", "gas", "water"]) {
      const r = await srv.post("/reward", { utility, meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000, photo: photo(utility), photoMime: "image/jpeg" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /isn't available/);
    }
  });
});

// The rate limit counts per real client. Behind Cloudflare that is CF-Connecting-IP;
// without it every user behind one edge would share one bucket.
test("the rate limit is per client address, from CF-Connecting-IP", async () => {
  const srv = await startServer({});
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await srv.get("/livez", { "CF-Connecting-IP": "203.0.113.7" });
    assert.equal(last.status, 429, "the 31st call from one client in a minute is refused");
    const other = await srv.get("/livez", { "CF-Connecting-IP": "203.0.113.8" });
    assert.equal(other.status, 200, "another client is not affected");
  } finally { await srv.stop(); }
});
