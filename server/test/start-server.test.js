// ── A test drives its own server, never a stranger on the same port ──────────
// Server tests, main, 25 November: between freePort() and the child's bind,
// double-pay.test.js's fake Redis (which answers any path with 200) took the port.
// The startup wait saw /health answer, attached to it, and the next POST crashed
// that fake: "other side closed" in corrections.test.js, and double-pay failed too.
// The wait now needs the child's own "listening on :port" line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer } from "./helpers.mjs";

test("a port another process holds is not mistaken for our server", async () => {
  // A stranger that answers everything, as the fake Redis and fake nodes do.
  const stranger = createServer((req, res) => res.end("{}"));
  await new Promise((r) => stranger.listen(0, "127.0.0.1", r));
  const { port } = stranger.address();
  try {
    let srv = null, err = null;
    try { srv = await startServer({ port }); } catch (e) { err = e; }
    if (srv) await srv.stop();
    assert.equal(srv, null, "attached to the stranger on the port");
    assert.match(String(err?.message), /EADDRINUSE/);
  } finally { stranger.close(); }
});
