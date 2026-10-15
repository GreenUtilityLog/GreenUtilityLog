// ── Tibber: the server fetches readings from the Tibber cloud ─────────────────
// A fake Tibber answers like the real one: a GraphQL viewer query (bearer token)
// that names the websocket address and which home has a Pulse, then a
// graphql-transport-ws subscription that streams liveMeasurement. What matters:
// a bad token or a missing Pulse is said plainly and nothing is stored; a good
// token is stored SEALED and the meter total is paid by the normal rules.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

const TOKEN = "tibber-personal-access-token-0123456789";

function fakeTibber() {
  const f = { pulse: true, live: [{ lastMeterConsumption: null }, { lastMeterConsumption: 1004.5 }], sawUA: "" };
  f.srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end(JSON.stringify({ errors: [{ message: "unauthorized" }] })); }
    f.sawUA = String(req.headers["user-agent"] || "");
    res.end(JSON.stringify({ data: { viewer: {
      websocketSubscriptionUrl: `ws://127.0.0.1:${f.srv.address().port}/sub`,
      homes: [{ id: "home-1", features: { realTimeConsumptionEnabled: f.pulse } }],
    } } }));
  });
  const wss = new WebSocketServer({ server: f.srv, path: "/sub" });
  wss.on("connection", (ws, req) => {
    assert.equal(req.headers["sec-websocket-protocol"], "graphql-transport-ws");
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "connection_init") {
        if (m.payload?.token !== TOKEN) return ws.close(4403, "Forbidden");
        ws.send(JSON.stringify({ type: "connection_ack" }));
      } else if (m.type === "subscribe") {
        assert.match(m.payload.query, /liveMeasurement\(homeId: "home-1"\)/);
        f.live.forEach((lm, i) => setTimeout(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ id: m.id, type: "next", payload: { data: { liveMeasurement: { timestamp: new Date().toISOString(), ...lm } } } }));
        }, 20 * (i + 1)));
      }
    });
  });
  return new Promise((r) => f.srv.listen(0, "127.0.0.1", () => { f.url = `http://127.0.0.1:${f.srv.address().port}/gql`; r(f); }));
}

describe("Tibber, fetched by the server", () => {
  let srv, tb;
  before(async () => {
    tb = await fakeTibber();
    srv = await startServer({
      state: stateWithBaseline(),
      env: { TIBBER_API_URL: tb.url, TIBBER_LIVE_WAIT_MS: "1500", POWERFOX_SECRET: "a-test-secret-of-some-length", AUTO_CLAIM_ON_PUSH: "on", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); tb.srv.close(); });

  const link = (over = {}) => srv.post("/meter/tibber/link", { address: WALLET, meterNo: "E1000", tibberToken: TOKEN, ...over });

  test("is announced in /health", async () => {
    assert.equal((await srv.get("/health")).body.tibber.enabled, true);
  });

  test("a wrong token is refused, and nothing is stored", async () => {
    const r = await link({ tibberToken: "not-the-right-token-but-long-enough" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /didn't accept this token/);
    assert.equal(Object.keys(srv.readState().tibber || {}).length, 0);
  });

  test("an account without a Pulse is named as such", async () => {
    tb.pulse = false;
    const r = await link();
    tb.pulse = true;
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "no_pulse");
  });

  test("a good token links, is stored sealed, and the meter total is paid", async () => {
    const r = await link();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reading, 1004.5, "the first message without a total is skipped");
    assert.match(tb.sawUA, /GreenUtilityLog/);
    const st = await srv.waitForState((s) => s.readings["electric:e1000"] === 1004.5, 6000);
    assert.equal(st.readings["electric:e1000"], 1004.5);
    assert.ok(!JSON.stringify(st).includes(TOKEN), "the token is not in the state");
    assert.match(st.tibber[WALLET.toLowerCase()].cred, /^v1:/);
    const latest = await srv.get(`/meter/latest?address=${WALLET}`, { "x-device-token": r.body.token });
    assert.equal(latest.body.reading.source, "tibber");
    assert.equal(latest.body.tibber.linked, true);
  });

  test("a Pulse that never sends a meter total is named as such", async () => {
    tb.live = [{ lastMeterConsumption: null }];
    const r = await link();
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "no_total");
  });

  test("unlinking forgets the token at once", async () => {
    const r = await srv.post("/meter/tibber/unlink", { address: WALLET });
    assert.equal(r.body.unlinked, true);
    const st = await srv.waitForState((s) => !(s.tibber || {})[WALLET.toLowerCase()]);
    assert.equal((st.tibber || {})[WALLET.toLowerCase()], undefined);
  });
});

describe("Tibber without a server key", () => {
  let srv;
  before(async () => { srv = await startServer({ state: stateWithBaseline() }); });
  after(async () => { await srv.stop(); });

  test("is off, and says so", async () => {
    const r = await srv.post("/meter/tibber/link", { address: WALLET, meterNo: "E1000", tibberToken: TOKEN });
    assert.equal(r.status, 503);
    assert.equal((await srv.get("/health")).body.tibber.enabled, false);
  });
});
