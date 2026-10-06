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
//
// Two processes do overlap during every deploy, though, so a Redis write is not
// "replace the blob with my copy" (the older process would put back yesterday's
// baseline for a meter the newer one had just paid). Each process records which
// entries IT changed, and a write reads the stored blob, applies only those, and
// stores the result — atomically, compare-and-set on a version key. It then takes
// over everything else from the stored blob, and a pull every 30 s keeps it current
// between writes. See mergedWrite().

import { readFileSync, writeFileSync, renameSync } from "node:fs";

const FILE  = process.env.STATE_FILE || "./state.json";
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const R_TOK = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_REDIS = !!(R_URL && R_TOK);
const REDIS_KEY = process.env.STATE_KEY || "greenutilitylog:state";

// `passes` is the access-pass registry (address → pass); `passesInit` records that the
// one-time grandfathering has run, so turning REQUIRE_PASS on can't silently cut off
// every existing tester — and can't re-grant a pass an admin has since revoked.
const EMPTY = { cooldowns: {}, hashes: {}, meterOwners: {}, readings: {}, ecoClaims: {}, meterLinks: {}, linkReadings: {}, bans: {}, photos: {}, usedCerts: {}, seen: {}, passes: {}, passesInit: 0, passSeq: 0, flags: {}, readingAts: {}, basisFixed: {}, rebased: {}, autoPaid: {}, payLog: [], prints: [], payDays: {} };
// A fresh copy each time. Spreading EMPTY copies only its top level: every
// "empty" state then shared EMPTY's own maps, so writing to one wrote to all of
// them — and to the next "empty" state read from Redis.
const fresh = (over = {}) => ({ ...JSON.parse(JSON.stringify(EMPTY)), ...over });

// Cap the "seen wallets" roster so an open endpoint can't grow state without bound.
// When exceeded we drop the least-recently-seen entries.
const SEEN_MAX = 2000;

// Same reasoning for the flagged-submission log: one entry per flagged payout,
// forever, would grow state without bound.
const FLAG_MAX = 2000;

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
      if (blob) return fresh(JSON.parse(blob));
      console.log("[store] Redis backend ready (empty — fresh state).");
      return fresh();
    } catch (e) {
      // Fail CLOSED: mark not-ready. Do not disable anti-farming with an empty slate,
      // and do not let a later write clobber the unread key.
      loadError = true;
      console.error("[store] Redis load FAILED — store NOT ready; payouts refused and no writes until it loads:", e?.message || e);
      return fresh();
    }
  }
  try {
    return fresh(JSON.parse(readFileSync(FILE, "utf8")));
  } catch {
    return fresh();
  }
}

// ── Knowing what THIS process changed ────────────────────────────────────────
// Every top-level map is wrapped so that `state.x[k] = v` and `delete state.x[k]`
// note (x, k); assigning a whole field (`state.payLog = …`) notes the field. At
// write time the CURRENT local value of each noted entry is what gets applied, so
// an in-place change after the noted assignment (push onto a list just assigned)
// travels with it.
const dirty = new Map();          // field -> Set of keys, or "*" for the whole field
const PROCESS_ID = Math.random().toString(36).slice(2, 10);
const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);
const note = (field, key) => {
  if (dirty.get(field) === "*") return;
  if (key === "*") { dirty.set(field, "*"); return; }
  if (!dirty.has(field)) dirty.set(field, new Set());
  dirty.get(field).add(key);
};
const rawOf = new WeakMap();      // proxy -> the plain object underneath
function mapProxy(field, obj) {
  const p = new Proxy(obj, {
    set(t, k, v) { t[k] = v; note(field, k); return true; },
    deleteProperty(t, k) { delete t[k]; note(field, k); return true; },
  });
  rawOf.set(p, obj);
  return p;
}
function track(raw) {
  for (const f of Object.keys(raw)) if (isMap(raw[f])) raw[f] = mapProxy(f, raw[f]);
  const p = new Proxy(raw, {
    set(t, f, v) { t[f] = isMap(v) ? mapProxy(f, v) : v; note(f, "*"); return true; },
  });
  rawOf.set(p, raw);
  return p;
}

// Load once at boot (top-level await — importers wait for this to resolve).
let state = track(await loadState());
console.log(`[store] backend: ${USE_REDIS ? "Upstash Redis (durable)" : `file ${FILE} (ephemeral on free hosts)`}`);

// If the durable store couldn't be read at boot, keep retrying so the service
// self-heals when Redis returns — without ever overwriting the unread key meanwhile.
if (USE_REDIS && loadError) {
  const retry = setInterval(async () => {
    const fresh = await loadState();
    if (!loadError) { state = track(fresh); dirty.clear(); clearInterval(retry); console.log("[store] Redis recovered — state loaded, payouts enabled."); }
  }, 10000);
}

// ── Once-only guards shared by every server process ──────────────────────────
// The state is one JSON blob per process, loaded at boot. During a deploy Render
// runs the old and the new process side by side for a while, each with its own
// copy: one pays a reading, the other never hears of it, and pays it again — which
// happened. So the checks that stop a double payout are ALSO taken as atomic keys
// in Redis (SET NX), which both processes see at once. Without Redis there is one
// process, and a Map does the same job.
const localOnce = new Map();
async function takeOnce(key, ttlMs) {
  const ms = Math.max(1000, Math.floor(ttlMs));
  if (USE_REDIS) {
    try { return (await redisCmd(["SET", `${REDIS_KEY}:once:${key}`, String(Date.now()), "NX", "PX", String(ms)])) === "OK"; }
    catch (e) { console.error("[store] once-guard unavailable:", e?.message || e); return null; } // unknown: caller refuses
  }
  const now = Date.now();
  const until = localOnce.get(key);
  if (until && until > now) return false;
  localOnce.set(key, now + ms);
  if (localOnce.size > 20000) for (const [k, t] of localOnce) if (t <= now) localOnce.delete(k);
  return true;
}
async function releaseOnce(key) {
  if (USE_REDIS) { try { await redisCmd(["DEL", `${REDIS_KEY}:once:${key}`]); } catch {} return; }
  localOnce.delete(key);
}

let saveError = false;
let saveRetry = null;

// ── Merging with what another process stored ─────────────────────────────────
const VERSION_KEY = `${REDIS_KEY}:version`;
// Set only if the version is still the one read; bumps it. One round trip, atomic.
const CAS_SCRIPT = "if (redis.call('GET', KEYS[2]) or '0') == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return redis.call('INCR', KEYS[2]) else return 0 end";
let casSupported = true;
const APPEND_LOGS = new Set(["payLog", "prints"]);   // merged as a union, not replaced
const COUNTERS = new Set(["passSeq", "passesInit"]); // merged as the larger

function applyMine(remote, changes) {
  for (const [field, keys] of changes) {
    const mine = state[field];
    if (APPEND_LOGS.has(field)) {
      const seen = new Set(), all = [];
      for (const e of [...(Array.isArray(remote[field]) ? remote[field] : []), ...(Array.isArray(mine) ? mine : [])]) {
        const id = JSON.stringify(e);
        if (!seen.has(id)) { seen.add(id); all.push(e); }
      }
      const maxAge = (field === "payLog" ? 14 : 60) * 86400000, now = Date.now();
      remote[field] = all.filter((e) => now - (e.t || 0) < maxAge).sort((a, b) => (a.t || 0) - (b.t || 0)).slice(field === "payLog" ? -5000 : -8000);
    } else if (COUNTERS.has(field)) {
      remote[field] = Math.max(Number(remote[field]) || 0, Number(mine) || 0);
    } else if (keys === "*" || !isMap(mine)) {
      remote[field] = isMap(mine) ? { ...mine } : mine;
    } else {
      if (!isMap(remote[field])) remote[field] = {};
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(mine, k)) remote[field][k] = mine[k];
        else delete remote[field][k];
      }
    }
  }
}
// Take over what's stored, except entries changed here since (they win at the next
// write). Written to the plain objects underneath, so nothing is noted as changed.
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Changes on their way to Redis right now. They are no longer "dirty", but until
// the write lands they are this process's newest values: adopt() must not undo
// them. (It did: a pull or a second write landing in that window put the stored,
// older value back, and the retry then wrote that.)
let inflight = null; // Map field -> Set | "*"
function protectedKeys(f) {
  const d = dirty.get(f), w = inflight?.get(f);
  if (d === "*" || w === "*") return "*";
  if (!d && !w) return null;
  return new Set([...(d || []), ...(w || [])]);
}
function adopt(remote) {
  const root = rawOf.get(state);
  for (const f of Object.keys(remote)) {
    const d = protectedKeys(f);
    if (d === "*") continue;
    const cur = root[f];
    if (!isMap(remote[f]) || !isMap(cur)) {        // lists, counters, a field new here
      if (!d) root[f] = isMap(remote[f]) ? mapProxy(f, remote[f]) : remote[f];
      continue;
    }
    const raw = rawOf.get(cur) || cur;
    for (const k of Object.keys(remote[f])) if (!d || !d.has(k)) raw[k] = remote[f][k];
    for (const k of Object.keys(raw)) if (!has(remote[f], k) && (!d || !d.has(k))) delete raw[k];
  }
}

async function readStored() {
  const [blob, ver] = await redisCmd(["MGET", REDIS_KEY, VERSION_KEY]);
  return { remote: blob ? fresh(JSON.parse(blob)) : fresh(), ver: ver == null ? "0" : String(ver) };
}

async function mergedWrite() {
  // What changed here up to now; anything changed during the round trips stays
  // noted for the next write.
  const changes = [...dirty.entries()].map(([f, k]) => [f, k === "*" ? "*" : new Set(k)]);
  dirty.clear();
  inflight = new Map(changes);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { remote, ver } = await readStored();
      applyMine(remote, changes);
      const blob = JSON.stringify(remote);
      if (casSupported) {
        let r;
        try { r = await redisCmd(["EVAL", CAS_SCRIPT, "2", REDIS_KEY, VERSION_KEY, ver, blob]); }
        catch (e) {
          if (!/upstash 4\d\d/.test(String(e?.message))) throw e;
          casSupported = false; // no scripting on this Redis: a plain merged SET still
          console.warn("[store] EVAL not available — merged writes without compare-and-set");
        }
        if (casSupported && !r) continue;       // someone wrote in between: read again
        if (casSupported) { adopt(remote); return; }
      }
      await redisCmd(["SET", REDIS_KEY, blob]);
      adopt(remote);
      return;
    }
    throw new Error("state kept changing under us — will retry");
  } catch (e) {
    // Not written: note the changes again so the retry carries them.
    for (const [f, k] of changes) { if (k === "*") note(f, "*"); else for (const x of k) note(f, x); }
    throw e;
  } finally {
    inflight = null;
  }
}

// Pick up other processes' writes between our own (a deploy's overlap, mostly).
if (USE_REDIS) {
  const pull = setInterval(async () => {
    if (loadError || writing) return; // a write is about to adopt the newest anyway
    try {
      const { remote } = await readStored();
      if (!writing) adopt(remote);
    } catch { /* next time */ }
  }, 30000);
  pull.unref?.();
}

// Writes run one at a time: two overlapping merged writes (a payout's flush and
// the debounce timer, say) each read, merged and stored, and the second could
// take the first's in-flight changes for "someone else's" values.
let writing = false;
let writeQueue = Promise.resolve();
function writeNow() {
  const run = writeQueue.then(() => { writing = true; return writeOnce(); }).finally(() => { writing = false; });
  writeQueue = run.catch(() => {});
  return run;
}

// Write the current state out now. Async so a graceful shutdown can await it.
async function writeOnce() {
  // Never overwrite a key we couldn't read at boot — that would wipe it durably.
  if (USE_REDIS && loadError) {
    console.warn("[store] skip save — store not ready (won't overwrite unread key).");
    return;
  }
  if (USE_REDIS) {
    try {
      await mergedWrite();
      if (saveError) console.log("[store] Redis save recovered — payouts enabled again.");
      saveError = false;
    } catch (e) {
      // A lost write is a payout that can be claimed again after the next restart
      // (the cooldown, the burnt photo and the new baseline all lived in it). So a
      // failing save makes the store NOT ready — no new payouts — and keeps trying
      // until one lands. It used to log and carry on as if saved.
      saveError = true;
      console.error("[store] Redis save FAILED — payouts paused until a save succeeds:", e?.message || e);
      if (!saveRetry) {
        saveRetry = setTimeout(() => { saveRetry = null; writeNow(); }, 5000);
        saveRetry.unref?.();
      }
    }
    return;
  }
  const blob = JSON.stringify(state);
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
    const k = mKey(utility, meterNo);
    state.readings[k] = val;
    // When this reading was taken, so the next submission knows how many days it
    // covers. Kept in its own map rather than nested in `readings`, so existing
    // stored baselines keep their shape and nothing needs migrating.
    state.readingAts[k] = Date.now();
    if (mFallback(utility)) { delete state.readings[meterNo]; delete state.readingAts[meterNo]; }
    persist();
  },
  // Timestamp of the last paid reading for this meter, or null when we've never
  // recorded one — which is also the case for meters that last submitted before
  // this map existed. Callers treat null as "assume a single day".
  lastReadingAt: (utility, meterNo) => {
    const k = mKey(utility, meterNo);
    if (Object.prototype.hasOwnProperty.call(state.readingAts, k)) return state.readingAts[k];
    if (mFallback(utility) && Object.prototype.hasOwnProperty.call(state.readingAts, meterNo)) return state.readingAts[meterNo];
    return null;
  },
  // A meter whose baseline was set from ONE tariff register cannot be reconciled with
  // a total that covers both: the step between them is thousands of kWh and every
  // claim is refused as implausible. Correcting it is allowed once per meter, and
  // that is recorded here — a bounded map keyed by meter, not a flag, because flags
  // are evicted when they get old and a gate that forgets is not a gate.
  // Same idea for /meter/rebaseline: once per meter, remembered by the meter and not
  // by the pairing, so unpairing and pairing again does not reopen it.
  rebasedAt: (utility, meterNo) => state.rebased[mKey(utility, meterNo)] || null,
  // A reader's reading has been paid on this meter, so its baseline and the
  // reader's numbers are on one scale: /meter/rebaseline is closed for good. Kept
  // per meter — on the pairing it was lost by unpairing and pairing again.
  autoPaidAt: (utility, meterNo) => state.autoPaid[mKey(utility, meterNo)] || null,
  markAutoPaid: (utility, meterNo) => { state.autoPaid[mKey(utility, meterNo)] = Date.now(); persist(); },
  markRebased: (utility, meterNo, info) => {
    state.rebased[mKey(utility, meterNo)] = { at: Date.now(), ...info };
    persist();
  },
  basisFixedAt: (utility, meterNo) => state.basisFixed[mKey(utility, meterNo)] || null,
  markBasisFixed: (utility, meterNo, info) => {
    state.basisFixed[mKey(utility, meterNo)] = { at: Date.now(), ...info };
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
    for (const [a, list] of Object.entries(state.ecoClaims)) if (Array.isArray(list) && list.length) add(a, { hasEco: true });
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
  // Own keys only: a token of "__proto__" would otherwise find Object.prototype.
  getMeterLink: (token) => (Object.prototype.hasOwnProperty.call(state.meterLinks, token) ? state.meterLinks[token] : null),
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
    // A monotonic counter, not a count of live passes: counting would re-issue a
    // number after any revoke (grant 1,2,3 → revoke 2 → the next grant is also 3),
    // and two wallets holding "Pass #3" makes the number worse than useless. Seeded
    // from the highest number in use so state written before passSeq existed is safe.
    const nextNo = () => {
      const highest = Math.max(0, state.passSeq || 0, ...Object.values(state.passes).map((p) => Number(p?.no) || 0));
      state.passSeq = highest + 1;
      return state.passSeq;
    };
    const pass = {
      // Re-issuing to a wallet that still holds one (to edit its tier or note) keeps
      // its number. A WITHDRAWN pass is gone — revoke deletes the record — so issuing
      // again afterwards is a new pass with a new number. That's the honest reading:
      // the number identifies a grant, not a person.
      no: prev?.no || nextNo(),
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
  // ── Flagged submissions ─────────────────────────────────────────────────────
  // The app runs client-side checks (OCR match, meter number, plausibility) and
  // sends the result along. Those checks false-positive on genuine phone photos, so
  // they deliberately do NOT hold a payout — but they were also being thrown away,
  // which left the app telling users a submission was "flagged for review" when
  // nothing was recorded and nobody could review anything. Keeping them makes the
  // word true: paid, and visible to an admin afterwards.
  addFlag: (txid, addr, reason) => {
    const k = String(txid || "").toLowerCase();
    if (!k) return;
    state.flags[k] = {
      at: Date.now(),
      addr: String(addr || "").toLowerCase(),
      reason: String(reason || "").slice(0, 200),
    };
    // Bound it like the seen-roster: this grows once per flagged payout forever.
    const keys = Object.keys(state.flags);
    if (keys.length > FLAG_MAX) {
      keys.sort((x, y) => (state.flags[x]?.at || 0) - (state.flags[y]?.at || 0));
      for (const k2 of keys.slice(0, keys.length - FLAG_MAX)) delete state.flags[k2];
    }
    persist();
  },
  listFlags: () => Object.entries(state.flags).map(([txid, v]) => ({ txid, ...v })),

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

  // What each payout WOULD have been at full rates — the demand the weekly budget
  // is spread over (budget.js). One running total per UTC day AND per process:
  // two processes adding to one shared key during a deploy would overwrite each
  // other's sums in a merged write, while a key per process merges cleanly.
  // 14 days kept. The old per-payout list (payLog) is only read until it ages out.
  addPayLog: (full) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (!isMap(state.payDays)) state.payDays = {};
    for (const k of Object.keys(state.payDays)) if (now - Date.parse(k.slice(0, 10)) > 14 * 86400000) delete state.payDays[k];
    if (Array.isArray(state.payLog) && state.payLog.length && now - state.payLog[0].t > 14 * 86400000) {
      state.payLog = state.payLog.filter((e) => now - e.t < 14 * 86400000);
    }
    const key = `${day}|${PROCESS_ID}`;
    state.payDays[key] = +((Number(state.payDays[key]) || 0) + (Number(full) || 0)).toFixed(4);
    persist();
  },
  payDays: () => Object.entries(isMap(state.payDays) ? state.payDays : {}).map(([k, sum]) => ({ dayStart: Date.parse(k.slice(0, 10)), sum: Number(sum) || 0 })),
  payLog: () => (Array.isArray(state.payLog) ? state.payLog : []),
  // Photo prints of paid submissions (media.js photoPrint), to spot one meter being
  // photographed for several wallets. 60 days, capped.
  addPrint: (addr, kind, print) => {
    if (!print) return;
    const now = Date.now();
    const list = (Array.isArray(state.prints) ? state.prints : []).filter((e) => now - e.t < 60 * 86400000);
    list.push({ a: String(addr).toLowerCase(), k: kind, p: print, t: now });
    state.prints = list.slice(-8000);
    persist();
  },
  prints: () => (Array.isArray(state.prints) ? state.prints : []),
  takeOnce,
  releaseOnce,
  // False while a durable store failed to load at boot — callers must refuse payouts
  // until it recovers, so anti-farming state is never bypassed or overwritten.
  // loaded: the durable state was read, so writing is safe. ready: also the last
  // save landed — required to PAY, since a payout whose save is lost can be
  // claimed again after a restart. Other writes (admin actions, pairing, ingest)
  // only need loaded: they are lost at worst, and an admin must be able to act
  // while saving is failing.
  loaded: () => !loadError,
  saveOk: () => !saveError,
  ready: () => !loadError && !saveError,

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
