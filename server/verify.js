// ── Server-side submission verification ──────────────────────────────────────
// The frontend's photo/OCR checks are a UX pre-filter and can be bypassed, so
// every payout is re-validated here. The reward AMOUNT is always recomputed on
// the server — a client-sent amount is never trusted.

import { RATES, UNITS, USAGE_BOUNDS, COOLDOWN_MS } from "./config.js";
import { store } from "./store.js";

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export function validateSubmission(body) {
  const { utility, reading, prevRead, meterNo, address } = body || {};

  if (!isAddress(address)) return { ok: false, error: "invalid wallet address" };
  if (!RATES[utility]) return { ok: false, error: "unknown utility" };
  if (!meterNo || !String(meterNo).trim()) return { ok: false, error: "meter number is required" };

  const addr = address.toLowerCase();
  const meterKey = String(meterNo).trim().toLowerCase();

  // A meter number belongs to one wallet (first to use it). This stops the same
  // physical meter being farmed from several accounts.
  const owner = store.meterOwner(meterKey);
  if (owner && owner !== addr) return { ok: false, error: "this meter is registered to another wallet" };

  const r = parseFloat(reading);
  const p = parseFloat(prevRead);
  if (!Number.isFinite(r) || !Number.isFinite(p)) return { ok: false, error: "invalid readings" };
  if (r <= p) return { ok: false, error: "current reading must exceed previous" };

  const usage = +(r - p).toFixed(2);
  const [lo, hi] = USAGE_BOUNDS[utility] || [0, Infinity];
  if (usage < lo || usage > hi) {
    return { ok: false, error: `usage ${usage} ${UNITS[utility]} is outside the plausible range` };
  }

  // Per wallet+utility cooldown (durable, survives restarts).
  const key = `${addr}:${utility}`;
  const elapsed = Date.now() - store.getCooldown(key);
  if (elapsed < COOLDOWN_MS) {
    const mins = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
    return { ok: false, error: `cooldown active — try again in ~${mins} min` };
  }

  // Server is the source of truth for the reward amount.
  const amount = +(usage * RATES[utility]).toFixed(2);
  if (amount <= 0) return { ok: false, error: "computed reward is zero" };

  return {
    ok: true,
    usage,
    amount,
    // Called only after a successful payout: start the cooldown and bind the
    // meter number to this wallet.
    markPaid: () => { store.setCooldown(key, Date.now()); store.bindMeter(meterKey, addr); },
  };
}
