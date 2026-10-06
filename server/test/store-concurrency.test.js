// ── Two saves at once must not lose either one's changes ─────────────────────
// Drives store.js directly (in a child process, since it loads at import) against
// a slow Upstash stand-in: one save is still on its way when the next starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function slowUpstash() {
  const kv = new Map();
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
      const args = JSON.parse(b || "[]");
      const [cmd] = args;
      await new Promise((r) => setTimeout(r, 60)); // every round trip takes a while
      let result = null;
      if (cmd === "GET") result = kv.get(args[1]) ?? null;
      else if (cmd === "MGET") result = args.slice(1).map((k) => kv.get(k) ?? null);
      else if (cmd === "SET") { kv.set(args[1], args[2]); result = "OK"; }
      else if (cmd === "EVAL") {
        const [, , , key, vkey, expected, blob] = args;
        if ((kv.get(vkey) || "0") === expected) { kv.set(key, blob); kv.set(vkey, String(Number(kv.get(vkey) || "0") + 1)); result = 1; }
        else result = 0;
      }
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, kv, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("a save started while another is in flight keeps both sets of changes", async () => {
  const up = await slowUpstash();
  // As in production: there is already a stored state.
  up.kv.set("t:state", JSON.stringify({ cooldowns: { old: 0 } }));
  const script = `
    const { store } = await import("./store.js");
    store.setCooldown("a:electric", 1);
    const first = store.flush();                 // in flight…
    await new Promise((r) => setTimeout(r, 20));
    store.setCooldown("b:electric", 2);          // …changed meanwhile…
    const second = store.flush();                // …and saved again before the first lands
    await Promise.all([first, second]);
    console.log("DONE");
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: SERVER_DIR,
    env: { ...process.env, UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t", STATE_KEY: "t:state" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  up.srv.close();
  assert.match(out, /DONE/, out);
  const stored = JSON.parse(up.kv.get("t:state"));
  assert.equal(stored.cooldowns["a:electric"], 1, "the first save's change is there");
  assert.equal(stored.cooldowns["b:electric"], 2, "and the second's");
});
