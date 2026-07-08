// ── Durable state (cooldowns, used photo hashes, meter ownership, baselines) ──
// Anti-farming state that MUST survive restarts. Pluggable backend:
//   • Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → state is stored in
//     Upstash Redis (free, REST over fetch). Survives every deploy/restart and is
//     the right choice on hosts with ephemeral disk (e.g. Render free plan).
//   • Otherwise → a local JSON file (STATE_FILE, default ./state.json). Fine for
//     local dev, but on an ephemeral-disk host it is wiped on every redeploy.
// The whole state is a single JSON blob (one key) — mirrors the file approach, so
// reads stay synchronous from an in-memory cache and writes are debounced. This is
// a single-instance design; for horizontal scale move to per-key atomic ops.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

const FILE  = process.env.STATE_FILE || "./state.json";
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const R_TOK = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_REDIS = !!(R_URL && R_TOK);
const REDIS_KEY = process.env.STATE_KEY || "greenutilitylog:state";

const EMPTY = { cooldowns: {}, hashes: {}, meterOwners: {}, readings: {}, ecoClaims: {} };

async function redisCmd(cmd) {
  const res = await fetch(R_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const j = await res.json();
  return j.result;
}

async function loadState() {
  if (USE_REDIS) {
    try {
      const blob = await redisCmd(["GET", REDIS_KEY]);
      if (blob) return { ...EMPTY, ...JSON.parse(blob) };
      console.log("[store] Redis backend ready (empty — fresh state).");
      return { ...EMPTY };
    } catch (e) {
      // Fail safe: an unreachable store must NOT silently disable anti-farming with
      // an empty slate, so we surface it loudly and start empty for this boot.
      console.error("[store] Redis load failed — starting empty this boot:", e?.message || e);
      return { ...EMPTY };
    }
  }
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    return { ...EMPTY };
  }
}

// Load once at boot (top-level await — importers wait for this to resolve).
let state = await loadState();
console.log(`[store] backend: ${USE_REDIS ? "Upstash Redis (durable)" : `file ${FILE} (ephemeral on free hosts)`}`);

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const blob = JSON.stringify(state);
    if (USE_REDIS) {
      redisCmd(["SET", REDIS_KEY, blob]).catch((e) => console.error("[store] Redis save failed:", e?.message || e));
      return;
    }
    try {
      // Atomic-ish: write a temp file then rename, so a crash mid-write can't
      // corrupt the live state file (the old boot loader silently started fresh).
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, blob);
      renameSync(tmp, FILE);
    } catch (e) {
      console.error("[store] save failed:", e?.message || e);
    }
  }, 500);
}

export const store = {
  // cooldown per `${address}:${utility}` -> last-paid epoch ms
  getCooldown: (key) => state.cooldowns[key] || 0,
  setCooldown: (key, ts) => { state.cooldowns[key] = ts; persist(); },

  // used photo hashes (one photo can only ever earn once)
  hasHash: (h) => Object.prototype.hasOwnProperty.call(state.hashes, h),
  addHash: (h) => { state.hashes[h] = Date.now(); persist(); },

  // meter number -> the address that first claimed it (anti meter-sharing)
  meterOwner: (meterKey) => state.meterOwners[meterKey] || null,
  bindMeter: (meterKey, addr) => { state.meterOwners[meterKey] = addr; persist(); },

  // last paid reading per meter -> the server computes usage from THIS, not the
  // client-sent prevRead, so a baseline can't be lowered to inflate a delta.
  lastReading: (meterKey) => (Object.prototype.hasOwnProperty.call(state.readings, meterKey) ? state.readings[meterKey] : null),
  setLastReading: (meterKey, val) => { state.readings[meterKey] = val; persist(); },

  // Eco-bonus claims per wallet: timestamps of paid eco photos. Pruned to the
  // given window on read, so the count is always "claims in the rolling window".
  ecoClaims: (addr, windowMs) => {
    const now = Date.now();
    const list = (state.ecoClaims[addr] || []).filter((t) => now - t < windowMs);
    state.ecoClaims[addr] = list;
    return list;
  },
  addEcoClaim: (addr, ts) => {
    (state.ecoClaims[addr] = state.ecoClaims[addr] || []).push(ts);
    persist();
  },

  // True when state is backed by a durable store (not the ephemeral file).
  isDurable: () => USE_REDIS,
};
