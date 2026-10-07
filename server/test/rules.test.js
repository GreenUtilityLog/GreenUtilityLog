// ── What the app is told before anyone takes a photo ─────────────────────────
// The app used to find out about the cooldown only after the photo, the crop, the
// OCR and the signature, and promised its own built-in 4 B3TR whatever the server
// was set to pay.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

describe("rules and the next allowed submission", () => {
  let srv;
  before(async () => {
    srv = await startServer({ state: stateWithBaseline(), env: { COOLDOWN_MS: "72000000", MAX_PAYOUT_PER_SUBMISSION: "1", ECO_REWARD: "1" } });
  });
  after(async () => { await srv.stop(); });

  test("/health carries this deployment's rules", async () => {
    const h = await srv.get("/health");
    assert.deepEqual(h.body.rules, {
      cooldownMs: 72000000, maxPayout: 1, ecoReward: 1, ecoMaxPerWeek: 4,
      ecoCooldownMs: 86400000, utilities: ["electric"],
    });
  });

  test("a wallet that hasn't been paid may submit now", async () => {
    const r = await srv.post("/wallet/seen", { address: WALLET });
    assert.equal(r.body.nextAt.electric, 0);
  });

  test("after a payout, /wallet/seen says when the next one is allowed", async () => {
    const pay = await srv.post("/reward", {
      utility: "electric", meterNo: "E1000", address: WALLET, reading: 1008, prevRead: 1000,
      photo: photo("rules"), photoMime: "image/jpeg",
    });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    const r = await srv.post("/wallet/seen", { address: WALLET });
    const left = r.body.nextAt.electric - Date.now();
    assert.ok(left > 71000000 && left <= 72000000, `about 20h left, got ${left}`);
  });
});
