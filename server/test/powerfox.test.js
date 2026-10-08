// ── Powerfox: the server fetches readings from the Powerfox cloud ─────────────
// A fake Powerfox API answers like the real one (basic auth, /my/main/current,
// A_Plus or the two tariff registers, Outdated, and 412 when data sharing is
// off). What matters: wrong logins and refusals are said plainly and nothing is
// stored; a good login is stored SEALED (the password never appears in the
// state); readings arrive and are paid by the normal rules; unlink forgets it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

const EMAIL = "me@example.de", PASSWORD = "Sehr-Geheim-123";

function fakePowerfox() {
  const f = { answer: { Outdated: false, Watt: 300, Timestamp: Math.floor(Date.now() / 1000), A_Plus: 1004.5, A_Minus: 0 }, calls: 0 };
  f.srv = createServer((req, res) => {
    f.calls++;
    const auth = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    res.setHeader("content-type", "application/json");
    if (auth !== `${EMAIL}:${PASSWORD}`) { res.statusCode = 401; return res.end("{}"); }
    if (!req.url.startsWith("/api/2.0/my/main/current?unit=kwh")) { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify(typeof f.answer === "function" ? f.answer() : f.answer));
  });
  return new Promise((r) => f.srv.listen(0, "127.0.0.1", () => { f.url = `http://127.0.0.1:${f.srv.address().port}/api/2.0`; r(f); }));
}

describe("Powerfox, fetched by the server", () => {
  let srv, pf;
  before(async () => {
    pf = await fakePowerfox();
    srv = await startServer({
      state: stateWithBaseline(),
      env: { POWERFOX_API_URL: pf.url, POWERFOX_SECRET: "a-test-secret-of-some-length", AUTO_CLAIM_ON_PUSH: "on", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); pf.srv.close(); });

  const link = (over = {}) => srv.post("/meter/powerfox/link", { address: WALLET, meterNo: "E1000", email: EMAIL, password: PASSWORD, ...over });

  test("is announced in /health", async () => {
    const h = await srv.get("/health");
    assert.equal(h.body.powerfox.enabled, true);
  });

  test("a wrong password is refused, and nothing is stored", async () => {
    const r = await link({ password: "wrong" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /didn't accept this e-mail and password/);
    assert.equal(Object.keys(srv.readState().powerfox || {}).length, 0);
  });

  test("data sharing switched off in the Powerfox app is named as such", async () => {
    pf.answer = { StatusCode: 412, ReasonPhrase: "Precondition Failed" };
    const r = await link();
    assert.equal(r.status, 400);
    assert.match(r.body.error, /switch on data transfer/);
  });

  test("a good login links, stores the password sealed, and pays the reading", async () => {
    pf.answer = { Outdated: false, Watt: 300, Timestamp: Math.floor(Date.now() / 1000), A_Plus: 1004.5, A_Minus: 0 };
    const r = await link();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reading, 1004.5);
    assert.ok(r.body.token);
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1004.5, 6000);
    assert.equal(st.readings["electric:e1000"], 1004.5, "paid, so the baseline moved");
    const raw = JSON.stringify(st);
    assert.ok(!raw.includes(PASSWORD), "the password is not in the state");
    assert.ok(!raw.includes(EMAIL), "the e-mail is not in the state either");
    assert.match(st.powerfox[WALLET.toLowerCase()].cred, /^v1:/);
    const latest = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": r.body.token });
    assert.equal(latest.body.reading.source, "powerfox");
    assert.equal(latest.body.powerfox.linked, true);
  });

  test("a meter with only tariff registers is read as their sum", async () => {
    pf.answer = { Outdated: false, Watt: 0, Timestamp: Math.floor(Date.now() / 1000), A_Plus: 0, A_Plus_HT: 600.25, A_Plus_NT: 410.5 };
    const r = await link();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reading, 1010.75);
  });

  test("an outdated reading is not used", async () => {
    pf.answer = { Outdated: true, Watt: 0, Timestamp: Math.floor(Date.now() / 1000) - 86400, A_Plus: 1500 };
    const r = await link();
    assert.equal(r.status, 200);
    assert.equal(r.body.outdated, true);
    await new Promise((x) => setTimeout(x, 600));
    assert.notEqual(srv.readState().readings["electric:e1000"], 1500);
  });

  test("the wake-up call runs at most once every ten minutes", async () => {
    const a = await srv.get("/cron/tick");
    assert.equal(a.status, 200);
    const b = await srv.get("/cron/tick");
    assert.equal(b.body.skipped, "ran recently");
  });

  test("unlinking forgets the account at once", async () => {
    const r = await srv.post("/meter/powerfox/unlink", { address: WALLET });
    assert.equal(r.body.unlinked, true);
    const st = await srv.waitForState((s) => !(s.powerfox || {})[WALLET.toLowerCase()]);
    assert.equal((st.powerfox || {})[WALLET.toLowerCase()], undefined);
  });
});

describe("Powerfox without a server key", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("is off, and says so", async () => {
    const r = await srv.post("/meter/powerfox/link", { address: WALLET, meterNo: "E1000", email: EMAIL, password: PASSWORD });
    assert.equal(r.status, 503);
    assert.equal((await srv.get("/health")).body.powerfox.enabled, false);
  });
});
