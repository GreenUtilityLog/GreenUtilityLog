// Mainnet must not start on the testnet state. The default STATE_KEY is testnet's,
// so without its own key mainnet would read and write it: testers' passes would
// earn real B3TR. Refused at boot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function boot(env) {
  return new Promise(async (resolve) => {
    const redis = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end('{"result":null}'); }); });
    await new Promise((r) => redis.listen(0, "127.0.0.1", r));
    const child = spawn(process.execPath, ["index.js"], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: "0", NETWORK: "mainnet", REQUIRE_CERT: "true", DISTRIBUTOR_DRY_RUN: "1",
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redis.address().port}`, UPSTASH_REDIS_REST_TOKEN: "t", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on("exit", (code) => { clearTimeout(timer); redis.close(); resolve({ code, out }); });
  });
}

test("mainnet without a mainnet STATE_KEY refuses to start", async () => {
  const r = await boot({ STATE_KEY: "" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /needs STATE_KEY set to a mainnet key/);
});
