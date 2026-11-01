// ── The fields that grow get their own key ───────────────────────────────────
// The state used to be one value, written in full on every save; past the
// storage's per-request limit every save fails and payouts stop. Drives store.js
// directly (in a child process, since it loads at import) against an Upstash
// stand-in, from the shapes a real deployment has: the old single value, a value
// already split, and an older process still writing the old way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const KEY = "t:state";
const part = (f) => `${KEY}:part:${f}`;

function upstash(initial) {
  const kv = new Map(Object.entries(initial));
  const writes = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const args = JSON.parse(b || "[]");
      const [cmd] = args;
      let result = null;
      if (cmd === "GET") result = kv.get(args[1]) ?? null;
      else if (cmd === "MGET") result = args.slice(1).map((k) => kv.get(k) ?? null);
      else if (cmd === "SET") { kv.set(args[1], args[2]); writes.push(args[1]); result = "OK"; }
      else if (cmd === "EVAL") {
        const [, , , key, vkey, expected, blob] = args;
        if ((kv.get(vkey) || "0") === expected) {
          kv.set(key, blob); writes.push(key);
          const v = String(Number(kv.get(vkey) || "0") + 1);
          kv.set(vkey, v); result = Number(v);
        } else result = 0;
      }
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, kv, writes, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function runStore(up, body) {
  const script = `const { store } = await import("./store.js");\n${body}\nconsole.log("DONE");\nprocess.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: SERVER_DIR,
    env: { ...process.env, UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t", STATE_KEY: KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  assert.match(out, /DONE/, out);
  return out;
}
const read = (up, key) => JSON.parse(up.kv.get(key));

test("an existing single value is split at the first save, and nothing is lost", async () => {
  const hashes = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`h${i}`, Date.now()]));
  const up = await upstash({
    [KEY]: JSON.stringify({
      cooldowns: { "old:electric": 5 }, readings: { "electric:e1": 1000 },
      hashes, flags: { tx1: { at: 1, addr: "0x1", reason: "r" } },
      seen: { "0x1": { firstSeen: 1, lastSeen: 2, meters: [] } },
      prints: [{ t: Date.now(), a: "0x1", k: "meter", p: "abcd" }],
    }),
  });
  const out = await runStore(up, `
    store.setCooldown("new:electric", 7);
    await store.flush();
    console.log("BYTES", store.stateBytes(), JSON.stringify(store.stateParts()));
  `);
  up.srv.close();
  const core = read(up, KEY);
  assert.deepEqual(core.cooldowns, { "old:electric": 5, "new:electric": 7 });
  assert.equal(core.readings["electric:e1"], 1000);
  for (const f of ["hashes", "flags", "seen", "prints"]) assert.equal(core[f], undefined, `${f} left the main value`);
  assert.equal(Object.keys(read(up, part("hashes")).hashes).length, 3000);
  assert.equal(read(up, part("flags")).flags.tx1.reason, "r");
  assert.ok(read(up, part("seen")).seen["0x1"]);
  assert.equal(read(up, part("prints")).prints.length, 1);
  // The largest stored value is the hashes part, not everything together.
  const bytes = Number(/BYTES (\d+)/.exec(out)[1]);
  assert.equal(bytes, up.kv.get(part("hashes")).length);
  assert.ok(up.kv.get(KEY).length < 1000, `main value is small now: ${up.kv.get(KEY).length}`);
});

test("what an older process wrote into the main value is taken over, not lost", async () => {
  // Already split — but an older process (a deploy's overlap) still wrote a photo
  // hash and a flag into the main value the old way.
  const up = await upstash({
    [KEY]: JSON.stringify({ cooldowns: {}, hashes: { stray: 9 }, flags: { tx2: { at: 2, addr: "0x2", reason: "late" } } }),
    [`${KEY}:version`]: "4",
    [part("hashes")]: JSON.stringify({ hashes: { kept: 1 } }),
    [`${part("hashes")}:version`]: "2",
    [part("flags")]: JSON.stringify({ flags: {} }),
  });
  await runStore(up, `
    if (!store.hasHash("stray") || !store.hasHash("kept")) throw new Error("both hashes are known at load");
    store.setCooldown("a:electric", 1);
    await store.flush();
  `);
  up.srv.close();
  assert.deepEqual(Object.keys(read(up, part("hashes")).hashes).sort(), ["kept", "stray"]);
  assert.equal(read(up, part("flags")).flags.tx2.reason, "late");
  const core = read(up, KEY);
  assert.equal(core.hashes, undefined);
  assert.equal(core.flags, undefined);
  assert.equal(core.cooldowns["a:electric"], 1);
});

test("a save writes only what changed", async () => {
  const up = await upstash({
    [KEY]: JSON.stringify({ cooldowns: {} }),
    [part("hashes")]: JSON.stringify({ hashes: { h: 1 } }),
    [part("seen")]: JSON.stringify({ seen: {} }),
  });
  await runStore(up, `
    store.setCooldown("a:electric", 1);
    await store.flush();
    store.addHash("h2");
    await store.flush();
  `);
  up.srv.close();
  assert.deepEqual(up.writes, [KEY, part("hashes")], "the main value once, the hashes once, nothing else");
  assert.deepEqual(Object.keys(read(up, part("hashes")).hashes).sort(), ["h", "h2"]);
});
