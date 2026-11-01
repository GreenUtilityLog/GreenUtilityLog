// The bridge names its version in the User-Agent; the server keeps it with the
// reading, so an admin can see which old bridges are still pushing.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

describe("a pushed reading remembers which bridge sent it", () => {
  let srv, token;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline() });
    token = (await srv.post("/meter/pair", { address: WALLET, meterNo: "E1000" })).body.token;
  });
  after(async () => { await srv.stop(); });

  const push = (reading, ua) => fetch(`${srv.base}/meter-ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ua ? { "User-Agent": ua } : {}) },
    body: JSON.stringify({ token, reading }),
  });

  test("the bridge's version is kept", async () => {
    assert.equal((await push(1001, "GreenUtilityLog-bridge/1.5.3 (node 22.1.0; linux)")).status, 200);
    const st = await srv.waitForState((s) => s.linkReadings?.[WALLET.toLowerCase()]?.reading === 1001);
    assert.equal(st.linkReadings[WALLET.toLowerCase()].client, "bridge 1.5.3");
  });

  test("another reader leaves it out, rather than storing whatever it sent", async () => {
    assert.equal((await push(1002, "HomeAssistant/2026.10 aiohttp/3.9 <script>")).status, 200);
    const st = await srv.waitForState((s) => s.linkReadings?.[WALLET.toLowerCase()]?.reading === 1002);
    assert.equal(st.linkReadings[WALLET.toLowerCase()].client, undefined);
  });
});
