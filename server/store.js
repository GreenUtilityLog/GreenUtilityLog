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

// `passes` is the access-pass registry (address → pass); `passesInit` records that the
// one-time grandfathering has run, so turning REQUIRE_PASS on can't silently cut off
// every existing tester — and can't re-grant a pass an admin has since revoked.
const EMPTY = { cooldowns: {}, hashes: {}, meterOwners: {}, readings: {}, ecoClaims: {}, meterLinks: {}, linkReadings: {}, bans: {}, photos: {}, usedCerts: {}, seen: {}, passes: {}, passesInit: 0 };

// Cap the "seen wallets" roster so an open endpoint can't grow state without bound.
// When exceeded we drop the least-recently-seen entries.
const SEEN_MAX = 2000;

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

// True when the durable (Redis) state could not be read at boot. While set, the
// store is NOT ready: payouts must be refused and we must NEVER write, or the first
// SET would overwrite the real (unread) key and wipe all cooldowns/hashes/baselines.
let loadError = false;

async function loadState() {
  if (USE_REDIS) {
    try {
      const blob = await redisCmd(["GET", REDIS_KEY]);
      loadError = false;
      if (blob) return { ...EMPTY, ...JSON.parse(blob) };
      console.log("[store] Redis backend ready (empty — fresh state).");
      return { ...EMPTY };
    } catch (e) {
      // Fail CLOSED: mark not-ready. Do not disable anti-farming with an empty slate,
      // and do not let a later write clobber the unread key.
      loadError = true;
      console.error("[store] Redis load FAILED — store NOT ready; payouts refused and no writes until it loads:", e?.message || e);
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

// If the durable store couldn't be read at boot, keep retrying so the service
// self-heals when Redis returns — without ever overwriting the unread key meanwhile.
if (USE_REDIS && loadError) {
  const retry = setInterval(async () => {
    const fresh = await loadState();
    if (!loadError) { state = fresh; clearInterval(retry); console.log("[store] Redis recovered — state loaded, payouts enabled."); }
  }, 10000);
}

// Write the current state out now. Async so a graceful shutdown can await it.
async function writeNow() {
  // Never overwrite a key we couldn't read at boot — that would wipe it durably.
  if (USE_REDIS && loadError) {
    console.warn("[store] skip save — store not ready (won't overwrite unread key).");
    return;
  }
  const blob = JSON.stringify(state);
  if (USE_REDIS) {
    try { await redisCmd(["SET", REDIS_KEY, blob]); }
    catch (e) { console.error("[store] Redis save failed:", e?.message || e); }
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
}

// Debounced persist WITH a hard max-wait, so anti-farming writes (cooldowns, burnt
// photo hashes, baselines) can't be starved indefinitely by a steady write stream —
// a pure trailing debounce never flushes under sustained load. First pending write
// starts the clock; we flush at the latest MAX_WAIT_MS after it.
let timer = null;
let firstPendingAt = 0;
const MAX_WAIT_MS = 2000;
function persist() {
  if (!firstPendingAt) firstPendingAt = Date.now();
  clearTimeout(timer);
  const waited = Date.now() - firstPendingAt;
  const delay = waited >= MAX_WAIT_MS ? 0 : Math.min(500, MAX_WAIT_MS - waited);
  timer = setTimeout(() => { timer = null; firstPendingAt = 0; writeNow(); }, delay);
}
// Flush any pending write immediately and await it. Called on graceful shutdown
// (SIGTERM/SIGINT) so a redeploy can't drop a just-committed payout's state.
async function flush() {
  clearTimeout(timer); timer = null; firstPendingAt = 0;
  await writeNow();
}

// Meter owner/baseline key, namespaced by utility. Legacy keys were the bare meter
// number (electric-only in practice), so only electric reads fall back to them.
const mKey = (utility, meterNo) => `${utility}:${meterNo}`;
const mFallback = (utility) => utility === "electric";

export const store = {
  // cooldown per `${address}:${utility}` -> last-paid epoch ms
  getCooldown: (key) => state.cooldowns[key] || 0,
  setCooldown: (key, ts) => { state.cooldowns[key] = ts; persist(); },

  // used photo hashes (one photo can only ever earn once). addHash reserves a hash
  // synchronously at verify time; delHash rolls that reservation back if the payout
  // it was reserved for never completes.
  hasHash: (h) => Object.prototype.hasOwnProperty.call(state.hashes, h),
  addHash: (h) => { state.hashes[h] = Date.now(); persist(); },
  delHash: (h) => { if (Object.prototype.hasOwnProperty.call(state.hashes, h)) { delete state.hashes[h]; persist(); } },

  // Meter owner + baseline are keyed by `${utility}:${meterNo}` so the SAME meter
  // number used for two utilities (e.g. electric "5" and water "5") keeps separate
  // ownership/baselines instead of one clobbering the other. Legacy rows were keyed
  // by the bare meter number and were always electric in practice, so they're read
  // back only for electric (mFallback) and migrated to the namespaced key on the
  // next electric write — existing baselines are never lost.
  meterOwner: (utility, meterNo) => {
    const k = mKey(utility, meterNo);
    if (Object.prototype.hasOwnProperty.call(state.meterOwners, k)) return state.meterOwners[k];
    if (mFallback(utility) && Object.prototype.hasOwnProperty.call(state.meterOwners, meterNo)) return state.meterOwners[meterNo];
    return null;
  },
  bindMeter: (utility, meterNo, addr) => {
    state.meterOwners[mKey(utility, meterNo)] = addr;
    if (mFallback(utility)) delete state.meterOwners[meterNo]; // migrate legacy electric
    persist();
  },

  // last paid reading per meter -> the server computes usage from THIS, not the
  // client-sent prevRead, so a baseline can't be lowered to inflate a delta.
  lastReading: (utility, meterNo) => {
    const k = mKey(utility, meterNo);
    if (Object.prototype.hasOwnProperty.call(state.readings, k)) return state.readings[k];
    if (mFallback(utility) && Object.prototype.hasOwnProperty.call(state.readings, meterNo)) return state.readings[meterNo];
    return null;
  },
  setLastReading: (utility, meterNo, val) => {
    state.readings[mKey(utility, meterNo)] = val;
    if (mFallback(utility)) delete state.readings[meterNo]; // migrate legacy electric
    persist();
  },
  // ── Seen wallets ────────────────────────────────────────────────────────────
  // The admin participant list is built from on-chain rewards, so a tester who has
  // connected (and maybe registered a meter locally) but not yet earned is invisible.
  // The app reports its wallet here on connect so admin can see them without anyone
  // adding them by hand. Minimal data: address + first/last seen + the meter numbers
  // the app has registered locally.
  seenWallet: (addr, meters) => {
    const a = String(addr).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return;
    const now = Date.now();
    const prev = state.seen[a];
    state.seen[a] = {
      firstSeen: prev?.firstSeen || now,
      lastSeen: now,
      meters: Array.isArray(meters) ? meters.slice(0, 8).map((m) => String(m).slice(0, 64)) : (prev?.meters || []),
    };
    // Bound the roster: drop the least-recently-seen beyond SEEN_MAX.
    const keys = Object.keys(state.seen);
    if (keys.length > SEEN_MAX) {
      keys.sort((x, y) => (state.seen[x]?.lastSeen || 0) - (state.seen[y]?.lastSeen || 0));
      for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete state.seen[k];
    }
    persist();
  },
  // Everything the backend knows about, for the admin list: wallets seen by the app
  // plus any that own a meter, hold a device link, or are banned.
  listKnownWallets: () => {
    const out = new Map();
    const add = (addr, patch) => {
      const a = String(addr || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) return;
      out.set(a, { address: a, ...(out.get(a) || {}), ...patch });
    };
    for (const [a, v] of Object.entries(state.seen)) add(a, { firstSeen: v?.firstSeen, lastSeen: v?.lastSeen, meters: v?.meters || [] });
    for (const owner of Object.values(state.meterOwners)) add(owner, { hasMeter: true });
    for (const l of Object.values(state.meterLinks)) add(l?.address, { paired: true });
    for (const a of Object.keys(state.bans)) add(a, { banned: true });
    return [...out.values()];
  },

  // Admin: every meter registered to a wallet on the backend (owner == addr), with its
  // baseline — including meters added via /admin/set-baseline that haven't submitted
  // on-chain yet, so the admin panel can show them.
  metersForWallet: (addr) => {
    const a = String(addr).toLowerCase();
    const out = [];
    for (const [k, owner] of Object.entries(state.meterOwners)) {
      if (String(owner).toLowerCase() !== a) continue;
      const i = k.indexOf(":");
      const utility = i > 0 ? k.slice(0, i) : "electric";   // legacy bare keys were electric
      const meterNo = i > 0 ? k.slice(i + 1) : k;
      out.push({ utility, meterNo, last: Object.prototype.hasOwnProperty.call(state.readings, k) ? state.readings[k] : null });
    }
    return out;
  },
  // Admin: change a meter's NUMBER — carry its owner + baseline from the old number
  // to the new one (same utility), then remove the old keys. Fixes a mis-entered
  // meter number so the user's future submissions match a valid baseline.
  renameMeter: (utility, oldMeterNo, newMeterNo, addr) => {
    const oldK = mKey(utility, oldMeterNo), newK = mKey(utility, newMeterNo);
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const owner = (has(state.meterOwners, oldK) ? state.meterOwners[oldK]
      : (mFallback(utility) && has(state.meterOwners, oldMeterNo) ? state.meterOwners[oldMeterNo] : null));
    const last = (has(state.readings, oldK) ? state.readings[oldK]
      : (mFallback(utility) && has(state.readings, oldMeterNo) ? state.readings[oldMeterNo] : null));
    state.meterOwners[newK] = String(addr || owner || "").toLowerCase();
    if (last != null) state.readings[newK] = last;
    delete state.meterOwners[oldK]; delete state.readings[oldK];
    if (mFallback(utility)) { delete state.meterOwners[oldMeterNo]; delete state.readings[oldMeterNo]; }
    persist();
    return { meterNo: newMeterNo, owner: state.meterOwners[newK] || null, lastReading: (last != null ? last : null) };
  },

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
  // Revoke a device token / erase a wallet's ingested reading (token rotation + the
  // GDPR "unpair and forget my reader" flow).
  delMeterLink: (token) => { if (token && Object.prototype.hasOwnProperty.call(state.meterLinks, token)) { delete state.meterLinks[token]; persist(); return true; } return false; },
  delLinkReading: (addr) => { const a = String(addr).toLowerCase(); if (Object.prototype.hasOwnProperty.call(state.linkReadings, a)) { delete state.linkReadings[a]; persist(); } },
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

  // ── Access passes ───────────────────────────────────────────────────────────
  // A pass is what lets a wallet actually earn, once REQUIRE_PASS is on. Issued by
  // an admin, revocable, and durable. Deliberately not an on-chain NFT: it has to be
  // reversible, and it costs nothing to issue.
  //
  // Revoking DELETES the record rather than flagging it, so a wallet is either
  // holding a pass or it isn't — no third state to get wrong on the earning path.
  getPass: (addr) => state.passes[String(addr || "").toLowerCase()] || null,
  hasPass: (addr) => Boolean(state.passes[String(addr || "").toLowerCase()]),
  grantPass: (addr, { tier, note, by } = {}) => {
    const a = String(addr || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
    const prev = state.passes[a];
    const pass = {
      // Stable per wallet: re-granting after a revoke keeps the original number, so
      // "pass #7" means one tester forever rather than drifting between people.
      no: prev?.no || (Object.keys(state.passes).length + 1),
      issuedAt: prev?.issuedAt || Date.now(),
      issuedBy: by ? String(by).toLowerCase() : (prev?.issuedBy || null),
      tier: String(tier || prev?.tier || "tester").slice(0, 24),
      note: String(note ?? prev?.note ?? "").slice(0, 140),
    };
    state.passes[a] = pass;
    persist();
    return pass;
  },
  revokePass: (addr) => {
    const a = String(addr || "").toLowerCase();
    const had = Object.prototype.hasOwnProperty.call(state.passes, a);
    delete state.passes[a];
    if (had) persist();
    return had;
  },
  listPasses: () => Object.entries(state.passes).map(([address, p]) => ({ address, ...p })),
  passCount: () => Object.keys(state.passes).length,

  // One-time grandfathering. Turning REQUIRE_PASS on must not retroactively lock out
  // people who were already earning, so on first enable every wallet the backend
  // already knows gets a pass. Guarded by passesInit so it runs exactly once — after
  // that, revoking a pass sticks.
  passesInitialised: () => Boolean(state.passesInit),
  markPassesInitialised: () => { state.passesInit = Date.now(); persist(); },

  // ── Admin: read/repair a meter's server-side state ──────────────────────────
  // Full snapshot for one meter/wallet so an admin can see what to fix. Utility-aware
  // (defaults electric), with the same legacy fallback as the read methods above.
  meterState: (utility, meterNo, addr) => {
    const u = utility || "electric";
    const k = mKey(u, meterNo);
    const owner = Object.prototype.hasOwnProperty.call(state.meterOwners, k) ? state.meterOwners[k]
      : (mFallback(u) ? (state.meterOwners[meterNo] || null) : null);
    const last = Object.prototype.hasOwnProperty.call(state.readings, k) ? state.readings[k]
      : (mFallback(u) && Object.prototype.hasOwnProperty.call(state.readings, meterNo) ? state.readings[meterNo] : null);
    return {
      meterNo,
      utility: u,
      owner: owner || null,
      lastReading: last,
      cooldownElectric: addr ? (state.cooldowns[`${String(addr).toLowerCase()}:${u}`] || 0) : 0,
      linkReading: addr ? (state.linkReadings[String(addr).toLowerCase()] || null) : null,
    };
  },
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

  // False while a durable store failed to load at boot — callers must refuse payouts
  // until it recovers, so anti-farming state is never bypassed or overwritten.
  ready: () => !loadError,

  // Single-use admin certificates: returns true the FIRST time a signature is seen,
  // false on any replay within the TTL. Prunes expired entries on each call so it
  // can't grow unbounded. Makes a captured admin cert non-replayable.
  consumeCert: (sig, ttlMs = 15 * 60 * 1000) => {
    if (!sig) return false;
    const now = Date.now();
    for (const [k, t] of Object.entries(state.usedCerts)) if (now - t > ttlMs) delete state.usedCerts[k];
    if (Object.prototype.hasOwnProperty.call(state.usedCerts, sig)) return false;
    state.usedCerts[sig] = now; persist(); return true;
  },

  // Flush any debounced write immediately (awaitable) — for graceful shutdown.
  flush,
};
