// ── Carry testers over from testnet, once ─────────────────────────────────────
// At go-live this server switches from testnet to mainnet (docs/MAINNET.md). So
// that nobody has to set up again, the first mainnet start reads the testnet
// state and adds what testers had set up: meter numbers and owners, starting
// points and last readings, reader tokens, Powerfox/Tibber/MojElektro links, the
// photo clock, bans, and the hashes of photos that already earned (store.carryOver
// says what, and that mainnet's own entries always win). Payouts, cooldowns,
// history, roles, flags and settings stay behind.
//
// Switched on by CARRY_OVER_KEY (the testnet STATE_KEY, normally
// greenutilitylog:state). CARRY_OVER_URL / CARRY_OVER_TOKEN name the testnet's
// Upstash database; left out, it is this server's own database. Runs once: the
// result is kept in the setting "carriedOver" (also shown in /health). A failed
// read is tried again every minute.

import { store } from "./store.js";

const SRC_KEY = String(process.env.CARRY_OVER_KEY || "").trim();
const SRC_URL = String(process.env.CARRY_OVER_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const SRC_TOK = String(process.env.CARRY_OVER_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const OWN_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const OWN_KEY = process.env.STATE_KEY || "greenutilitylog:state";
// Fields that may live under a key of their own (store.js PART_FIELDS).
const PARTS = ["hashes", "prints"];

export const carryOverWanted = () => !!SRC_KEY;
export const carryOverDone = () => store.getSetting("carriedOver") || null;

// Why it can't run, or null.
export function carryOverProblem() {
  if (!SRC_KEY) return null;
  if (!SRC_URL || !SRC_TOK) return "CARRY_OVER_KEY is set, but there is no Upstash database to read it from (CARRY_OVER_URL / CARRY_OVER_TOKEN)";
  if (SRC_URL === OWN_URL && SRC_KEY === OWN_KEY) return "CARRY_OVER_KEY is this server's own STATE_KEY — it must be the testnet's";
  return null;
}

async function readSource() {
  const keys = [SRC_KEY, ...PARTS.map((f) => `${SRC_KEY}:part:${f}`)];
  const res = await fetch(SRC_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SRC_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(["MGET", ...keys]),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const got = (await res.json())?.result;
  if (!Array.isArray(got)) throw new Error("unexpected answer from Upstash");
  if (!got[0]) throw new Error(`nothing stored under "${SRC_KEY}" — check CARRY_OVER_KEY and the database`);
  const src = JSON.parse(got[0]);
  PARTS.forEach((f, i) => {
    const b = got[i + 1];
    if (!b) return;
    const part = JSON.parse(b)?.[f];
    // An older process may have left entries in the main value too: both count.
    if (Array.isArray(part)) src[f] = [...(Array.isArray(src[f]) ? src[f] : []), ...part];
    else if (part && typeof part === "object") src[f] = { ...(src[f] || {}), ...part };
  });
  return src;
}

let running = null;
// → the result, or null when not wanted / already done / not possible yet.
export function runCarryOver() {
  if (!carryOverWanted() || carryOverDone() || carryOverProblem()) return Promise.resolve(null);
  if (!running) running = (async () => {
    try {
      if (!store.loaded()) throw new Error("this server's own state isn't loaded yet");
      const src = await readSource();
      if (carryOverDone()) return carryOverDone();   // another process finished first
      const counts = store.carryOver(src);
      const done = { at: Date.now(), from: SRC_KEY, ...counts };
      store.setSetting("carriedOver", done);
      await store.flush();
      console.log(`[carry-over] from "${SRC_KEY}": ${counts.meters} meters, ${counts.links} reader links, ${counts.cloud} cloud links, ${counts.bans} bans, ${counts.hashes} photo hashes.`);
      return done;
    } finally { running = null; }
  })();
  return running;
}

// At boot, and every minute until it has run. Only on a server that wants it.
export function startCarryOver() {
  if (!carryOverWanted()) return;
  const problem = carryOverProblem();
  if (problem) { console.error(`[carry-over] not run: ${problem}.`); return; }
  if (carryOverDone()) return;
  const attempt = () => runCarryOver().catch((e) => {
    console.error("[carry-over] failed, trying again in a minute:", e?.message || e);
    setTimeout(attempt, 60000).unref?.();
  });
  attempt();
}
