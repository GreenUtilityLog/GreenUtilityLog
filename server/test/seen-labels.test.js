// ── The open /wallet/seen roster stores meter numbers only ───────────────────
// Anyone can call it. Each call kept up to 4 labels of 40 characters of anything
// that isn't a control character — "€" is 3 bytes, so 600 bytes a wallet, and 2000
// wallets grew the stored roster past 1 MB. Now only meter-number characters stay,
// and stored sizes are measured in bytes, not characters.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.mjs";

test("non-meter characters are dropped from the labels", async () => {
  const srv = await startServer({ state: {} });
  try {
    const address = "0x" + "a".repeat(40);
    const r = await fetch(srv.base + "/wallet/seen", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, meters: ["€".repeat(40), "E-1000 / 2", "<b>x</b>", "ok_1.2"] }) });
    assert.equal(r.status, 200);
    const st = await srv.waitForState((s) => s.seen?.[address]);
    assert.deepEqual(st.seen[address].meters, ["E-1000 / 2", "bx/b", "ok_1.2"]);
    assert.ok(Buffer.byteLength(JSON.stringify(st.seen[address])) < 200);
  } finally { await srv.stop(); }
});
