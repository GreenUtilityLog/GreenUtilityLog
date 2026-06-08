// ── Server-side submission verification ──────────────────────────────────────
// The frontend's photo/OCR checks are a UX pre-filter and can be bypassed, so
// every payout is re-validated here. The reward AMOUNT is always recomputed on
// the server — a client-sent amount is never trusted.

import { RATES, UNITS, USAGE_BOUNDS, COOLDOWN_MS } from "./config.js";

// In-memory cooldown ledger. NOTE: this resets on restart and is not shared
// across instances — back it with Redis/Postgres before running more than one
// process or expecting durability.
const lastPaid = new Map(); // `${address}:${utility}` -> epoch ms

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export function validateSubmission(body) {
  const { utility, reading, prevRead, meterNo, address } = body || {};

  if (!isAddress(address)) return { ok: false, error: "invalid wallet address" };
  if (!RATES[utility]) return { ok: false, error: "unknown utility" };
  if (!meterNo || !String(meterNo).trim()) return { ok: false, error: "meter number is required" };

  const r = parseFloat(reading);
  const p = parseFloat(prevRead);
  if (!Number.isFinite(r) || !Number.isFinite(p)) return { ok: false, error: "invalid readings" };
  if (r <= p) return { ok: false, error: "current reading must exceed previous" };

  const usage = +(r - p).toFixed(2);
  const [lo, hi] = USAGE_BOUNDS[utility] || [0, Infinity];
  if (usage < lo || usage > hi) {
    return { ok: false, error: `usage ${usage} ${UNITS[utility]} is outside the plausible range` };
  }

  // Per wallet+utility cooldown.
  const key = `${address.toLowerCase()}:${utility}`;
  const now = Date.now();
  const elapsed = now - (lastPaid.get(key) || 0);
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
    markPaid: () => lastPaid.set(key, Date.now()),
  };
}
