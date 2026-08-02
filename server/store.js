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

const EMPTY = { cooldowns: {}, hashes: {}, meterOwners: {}, readings: {}, ecoClaims: {}, meterLinks: {}, linkReadings: {}, bans: {}, photos: {} };

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
  // last 14 days on read — enough to evaluate both the current calendar week
  // and the between-claims cooldown.
  ecoClaims: (addr) => {
    const now = Date.now();
    const list = (state.ecoClaims[addr] || []).filter((t) => now - t < 14 * 24 * 60 * 60 * 1000);
    state.ecoClaims[addr] = list;
    return list;
  },
  addEcoClaim: (addr, ts) => {
    (state.ecoClaims[addr] = state.ecoClaims[addr] || []).push(ts);
    persist();
  },

  // ── Smart-meter link (beta) ────────────────────────────────────────────────
  // A device token binds a physical reader to one wallet. A P1/HAN reader (or Home
  // Assistant) POSTs the live meter total to /meter-ingest with this token; nobody
  // without the token can push a reading, so it can't be spoofed for another wallet.
  //   meterLinks:   token   -> { address, meterNo, createdAt }
  //   linkReadings: address -> { reading, meterNo, at, source }
  setMeterLink: (token, obj) => { state.meterLinks[token] = obj; persist(); },
  getMeterLink: (token) => state.meterLinks[token] || null,
  // Reverse lookup so a wallet re-pairing reuses/overwrites its own token rather
  // than accumulating orphans.
  getLinkByAddress: (addr) => {
    const a = String(addr).toLowerCase();
    for (const [token, v] of Object.entries(state.meterLinks)) {
      if (v && String(v.address).toLowerCase() === a) return { token, ...v };
    }
    return null;
  },
  setLinkReading: (addr, obj) => { state.linkReadings[String(addr).toLowerCase()] = obj; persist(); },
  getLinkReading: (addr) => state.linkReadings[String(addr).toLowerCase()] || null,
  // All paired links — used by the scheduled auto-submit (Step 3) to walk every
  // wallet that has a device pushing readings.
  allMeterLinks: () => Object.entries(state.meterLinks).map(([token, v]) => ({ token, ...v })),

  // ── Admin: dynamic ban list ─────────────────────────────────────────────────
  // Wallets an admin has blocked at runtime (durable). Complements the static
  // BANNED_ADDRESSES env list; either one blocks a wallet from claiming.
  isBanned: (addr) => Object.prototype.hasOwnProperty.call(state.bans, String(addr).toLowerCase()),
  setBan: (addr, on) => {
    const a = String(addr).toLowerCase();
    if (on) state.bans[a] = Date.now(); else delete state.bans[a];
    persist();
  },
  listBans: () => Object.keys(state.bans),

  // ── Admin: read/repair a meter's server-side state ──────────────────────────
  // Full snapshot for one meter/wallet so an admin can see what to fix.
  meterState: (meterKey, addr) => ({
    meterNo: meterKey,
    owner: state.meterOwners[meterKey] || null,
    lastReading: Object.prototype.hasOwnProperty.call(state.readings, meterKey) ? state.readings[meterKey] : null,
    cooldownElectric: addr ? (state.cooldowns[`${String(addr).toLowerCase()}:electric`] || 0) : 0,
    linkReading: addr ? (state.linkReadings[String(addr).toLowerCase()] || null) : null,
  }),
  // Clear the cooldown for a wallet+utility so the user can resubmit right away.
  clearCooldown: (addr, utility) => { delete state.cooldowns[`${String(addr).toLowerCase()}:${utility}`]; persist(); },

  // ── Admin: archived-photo index ─────────────────────────────────────────────
  // Maps a payout txID -> { at, addr } for photos kept in the R2 archive. This is
  // only an index for retention/lookup; the image bytes live in R2 (photostore.js),
  // never here. Small (~a few dozen bytes each), safe for the single-blob state.
  addPhoto: (id, addr) => {
    const k = String(id || "").toLowerCase();
    if (!k) return;
    state.photos[k] = { at: Date.now(), addr: String(addr || "").toLowerCase() };
    persist();
  },
  hasPhoto: (id) => Object.prototype.hasOwnProperty.call(state.photos, String(id || "").toLowerCase()),
  delPhoto: (id) => {
    const k = String(id || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(state.photos, k)) { delete state.photos[k]; persist(); return true; }
    return false;
  },
  // Ids older than maxAgeMs — the retention sweep deletes these from R2 then calls
  // delPhoto on each.
  expiredPhotos: (maxAgeMs) => {
    const cutoff = Date.now() - maxAgeMs;
    return Object.entries(state.photos).filter(([, v]) => (v?.at || 0) < cutoff).map(([k]) => k);
  },

  // True when state is backed by a durable store (not the ephemeral file).
  isDurable: () => USE_REDIS,
};
