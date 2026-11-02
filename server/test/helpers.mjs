// ── Harness for the HTTP tests ───────────────────────────────────────────────
// Boots the real server as a child process against a throwaway state file, with
// the chain stubbed by DISTRIBUTOR_DRY_RUN so a payout can actually complete.
// Nothing is mocked inside the server itself: these drive it exactly as the app
// does, over HTTP, so a test passing means the deployed thing behaves.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { Certificate, Secp256k1, Address } from "@vechain/sdk-core";
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

// A free port can still be taken between asking and binding: the test files run in
// parallel processes that all ask the OS. The loser dies with EADDRINUSE; it is
// started again on a new port rather than failing a test about something else.
export async function startServer(opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await startServerOnce(opts); }
    catch (e) { if (attempt >= 3 || !/EADDRINUSE/.test(String(e?.message))) throw e; }
  }
}

async function startServerOnce({ state = {}, env = {} } = {}) {
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
      // Off unless a test is about it: otherwise a push is paid before the test's own
      // claim, and every "push, then claim" test would race the server.
      AUTO_CLAIM_ON_PUSH: "off",
      // Passes are on by default in production; the tests that are about them turn
      // them on. Everything else is about other rules.
      REQUIRE_PASS: "false",
      // Same for the device id the app sends with a payout (device.test.js).
      REQUIRE_DEVICE: "false",
      PHOTO_CHECKS_PER_WALLET_DAY: "0",
      // Readers push several readings within seconds in many tests; the per-device
      // limit has its own test (robustness.test.js).
      INGEST_MIN_INTERVAL_MS: "0",
      // The wallet check reads the chain; off unless a test is about it (wallet-check.test.js).
      WALLET_CHECK: "off",
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
    async get(path, headers = {}) {
      const res = await fetch(base + path, { headers });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    async stop({ keepDir = false } = {}) {
      // SIGTERM first: the server flushes debounced state on it, so shutting down
      // this way exercises that path instead of stepping around it.
      child.kill("SIGTERM");
      const exited = new Promise((r) => child.on("exit", r));
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exited;
      clearTimeout(timer);
      if (!keepDir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// A real, decodable JPEG, large enough to clear MIN_BYTES, unique per call so the
// photo dedupe doesn't swallow the second request in a test that needs two. The
// server refuses a photo it cannot decode, so these are real images: a pool of
// random-noise pictures (different enough that the likeness check never takes two
// for the same scene), each given a unique comment segment.
const sharp = (await import("sharp")).default;
const POOL = await Promise.all(Array.from({ length: 48 }, async () => {
  const raw = Buffer.alloc(32 * 32 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  return sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}));
let photoSeq = 0;
export function photo(tag = "") {
  const n = photoSeq++;
  const seed = `${tag}:${n}:${Math.random()}`;
  const pad = Buffer.alloc(9000);
  pad.write(seed.repeat(200).slice(0, 9000));
  const len = pad.length + 2;
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([len >> 8, len & 0xff]), pad]);
  const img = POOL[n % POOL.length];
  return Buffer.concat([img.subarray(0, 2), com, img.subarray(2)]).toString("base64");
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

// A fake VeChain node: enough of Thor's REST API for the distributor to sign, send
// and confirm a transaction. `mode` picks how it misbehaves (see the branches);
// `postDelayMs` holds every transaction POST that long, and `onPost` is called
// when one arrives.
export function fakeNode(mode, { revertSelector = null, postDelayMs = 0, onPost = null } = {}) {
  const seen = new Set();
  const raws = [];
  let posts = 0;
  const best = { id: "0x00000a" + "1".repeat(58), number: 655360, timestamp: Math.floor(Date.now() / 1000), gasLimit: 40000000, baseFeePerGas: "0x9184e72a000", parentID: "0x" + "2".repeat(64) };
  const genesis = { id: "0x00000000" + "27".repeat(28), number: 0, timestamp: 1530014400, gasLimit: 10000000 };
  const srv = createHttpServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => handle());
    function handle() {
      const send = (o, c = 200) => { res.statusCode = c; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      const u = req.url;
      if (u.startsWith("/blocks/0")) return send(genesis);
      if (u.startsWith("/blocks/best")) return send(best);
      if (u.startsWith("/fees/history")) return send({ oldestBlock: best.id, baseFeePerGas: ["0x9184e72a000"], gasUsedRatio: [0.5], reward: [["0x0"]] });
      if (u.startsWith("/fees/priority")) return send({ maxPriorityFeePerGas: "0x0" });
      if (u.startsWith("/accounts/*")) {
        const data = (JSON.parse(b || "{}").clauses || [])[0]?.data || "";
        const reverted = !!revertSelector && data.startsWith(revertSelector);
        return send([{ data: "0x", events: [], transfers: [], gasUsed: 30000, reverted, vmError: reverted ? "execution reverted" : "" }]);
      }
      if (u.startsWith("/accounts/")) return send({ balance: "0x0", energy: "0xffffffffffff", hasCode: false });
      if (req.method === "POST" && u.startsWith("/transactions") && postDelayMs > 0 && !req.delayed) {
        onPost?.();
        req.delayed = true;
        return setTimeout(() => handle(), postDelayMs);
      }
      if (req.method === "POST" && u.startsWith("/transactions")) {
        if (!postDelayMs) onPost?.();
        if (mode === "refused") return send({ error: "rejected" }, 400);
        // Fails the first time without taking it, then takes the same transaction.
        if (mode === "flaky" && posts++ === 0) return send({ error: "busy" }, 503);
        seen.add("tx");
        raws.push(JSON.parse(b).raw);
        if (mode === "lost-reply") { res.socket.destroy(); return; } // took it, reply never came back
        return send({ id: "0x" });
      }
      // A transaction the node has but no block yet holds: no receipt.
      if (mode === "no-receipt" && u.includes("/receipt")) return send(null);
      // Taken, then expired before any block held it: no receipt, unknown to the node.
      if (mode === "expired" && req.method === "GET" && u.startsWith("/transactions/")) return send(null);
      if (req.method === "GET" && u.startsWith("/transactions/")) return send(seen.size ? { id: "0x" } : null);
      send(null);
    }
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, raws, url: `http://127.0.0.1:${srv.address().port}` })));
}

// An admin wallet for the tests: a fresh key, and certificates signed the way the
// app signs an /admin/* call (action and parameters, network, time).
export async function adminSigner() {
  const priv = await Secp256k1.generatePrivateKey();
  const address = Address.ofPrivateKey(priv).toString();
  async function cert(path, body, network = "testnet") {
    const extra = { ...body };
    const content = `Green Utility Log — admin\nAction: ${path}|${JSON.stringify(extra, Object.keys(extra).sort())}\nNetwork: ${network}\nTime: ${new Date().toISOString()}`;
    const base = { purpose: "identification", payload: { type: "text", content }, domain: "test.local", timestamp: Math.floor(Date.now() / 1000), signer: address };
    const c = Certificate.of(base); c.sign(priv);
    const signature = typeof c.signature === "string" ? c.signature : Buffer.from(c.signature).toString("hex");
    return { ...base, signature };
  }
  return { address, cert, call: async (srv, path, body) => srv.post(path, { ...body, address, certificate: await cert(path, body) }) };
}
