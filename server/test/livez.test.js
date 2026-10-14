// Render's health check uses /livez (render.yaml). It has to answer at once,
// without waiting for the chain, or a slow VeChain node fails a healthy deploy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers.mjs";

test("/livez answers at once", async () => {
  const srv = await startServer({});
  try {
    const t = Date.now();
    const r = await srv.get("/livez");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Date.now() - t < 1000);
  } finally { await srv.stop(); }
});
