// ── Durable state (cooldowns, used photo hashes, meter ownership) ────────────
// A tiny JSON-file-backed store so these survive a restart. This is the
// pragmatic single-instance solution; for multiple instances / high volume,
// back this with Redis or Postgres instead (same interface).

import { readFileSync, writeFileSync } from "node:fs";

const FILE = process.env.STATE_FILE || "./state.json";

let state = { cooldowns: {}, hashes: {}, meterOwners: {} };
try {
  const loaded = JSON.parse(readFileSync(FILE, "utf8"));
  state = { cooldowns: {}, hashes: {}, meterOwners: {}, ...loaded };
} catch { /* no file yet — start fresh */ }

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { writeFileSync(FILE, JSON.stringify(state)); }
    catch (e) { console.error("[store] save failed:", e?.message || e); }
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
};
