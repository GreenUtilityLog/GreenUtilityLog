// ── Harness for the HTTP tests ───────────────────────────────────────────────
// Boots the real server as a child process against a throwaway state file, with
// the chain stubbed by DISTRIBUTOR_DRY_RUN so a payout can actually complete.
// Nothing is mocked inside the server itself: these drive it exactly as the app
// does, over HTTP, so a test passing means the deployed thing behaves.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Ask the OS for a free port instead of guessing one. Guessing was the bug: each
// test FILE is its own process, so each picked its own random base and two of them
// could land on the same port. The loser failed to bind and died — and the startup
// wait only checked that /health answered, which the WINNER happily did. The test
// then drove a stranger's server, with a different state file, and only noticed
// when a result depended on state. Intermittently, which is the worst kind.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer({ state = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gul-test-"));
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const port = await freePort();

  const child = spawn(process.execPath, ["index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      STATE_FILE: stateFile,
      REQUIRE_CERT: "false",
      OCR_ENABLED: "false",
      DISTRIBUTOR_DRY_RUN: "true",
      // Keep the real file backend: tests assert on what was persisted.
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  // If OUR child dies, stop. A healthy /health on this port then means somebody
  // else's server is answering, and attaching to it is how a passing test ends up
  // proving nothing about the code under test.
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) {
      throw new Error(`server process exited during startup (code ${exited.code}, signal ${exited.signal}) on port ${port}\n${logs.join("")}`);
    }
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not start on ${port}\n${logs.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    base,
    logs: () => logs.join(""),
    readState: () => JSON.parse(readFileSync(stateFile, "utf8")),
    // Writes to the state file are debounced, and some are made after the endpoint
    // has already flushed and replied (flags, for one). Poll rather than assume the
    // file is current the instant a response lands.
    async waitForState(pred, ms = 4000) {
      const until = Date.now() + ms;
      let last;
      for (;;) {
        last = JSON.parse(readFileSync(stateFile, "utf8"));
        if (pred(last)) return last;
        if (Date.now() > until) return last;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async post(path, body) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async get(path) {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async stop() {
      // SIGTERM first: the server flushes debounced state on it, so shutting down
      // this way exercises that path instead of stepping around it.
      child.kill("SIGTERM");
      const exited = new Promise((r) => child.on("exit", r));
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// A real JPEG, large enough to clear MIN_BYTES, unique per call so the photo
// dedupe doesn't swallow the second request in a test that needs two.
let photoSeq = 0;
export function photo(tag = "") {
  const seed = `${tag}:${photoSeq++}:${Math.random()}`;
  const pad = Buffer.alloc(9000);
  pad.write(seed.repeat(200).slice(0, 9000));
  const len = pad.length + 2;
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([len >> 8, len & 0xff]), pad]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), com, Buffer.from([0xff, 0xd9])]).toString("base64");
}

export const WALLET = "0x1111111111111111111111111111111111111111";
export const OTHER  = "0x2222222222222222222222222222222222222222";

// A state file with one electric meter already owned and baselined, as it would be
// after a first photo submission.
export function stateWithBaseline({ wallet = WALLET, meterNo = "E1000", reading = 1000, agoMs = 0 } = {}) {
  const key = `electric:${meterNo.toLowerCase()}`;
  return {
    cooldowns: {}, hashes: {}, ecoClaims: {}, meterLinks: {}, linkReadings: {},
    bans: {}, photos: {}, usedCerts: {}, seen: {}, passes: {}, passesInit: 1,
    passSeq: 0, flags: {}, basisFixed: {},
    meterOwners: { [key]: wallet.toLowerCase() },
    readings: { [key]: reading },
    readingAts: { [key]: Date.now() - agoMs },
  };
}
