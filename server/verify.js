// ── Server-side submission verification ──────────────────────────────────────
// The frontend's photo/OCR checks are a UX pre-filter and can be bypassed, so
// every payout is re-validated here. The reward AMOUNT is always recomputed on
// the server — a client-sent amount is never trusted.

import { RATES, UNITS, USAGE_BOUNDS, COOLDOWN_MS, computeReward, MAX_REWARD } from "./config.js";
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
  if (!Number.isFinite(r)) return { ok: false, error: "invalid reading" };

  // Compute usage from the LAST reading the server recorded for this meter, not
  // the client-sent prevRead — that way a baseline can't be lowered to inflate
  // the delta. The first ever submission falls back to the supplied baseline.
  const last = store.lastReading(meterKey);
  let prev;
  if (last != null) {
    prev = last;
  } else {
    prev = parseFloat(prevRead);
    if (!Number.isFinite(prev)) return { ok: false, error: "invalid baseline reading" };
  }
  if (r <= prev) return { ok: false, error: `current reading (${r}) must exceed the last recorded reading (${prev})` };

  const usage = +(r - prev).toFixed(2);
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

  // Server is the source of truth for the reward amount. Conservation-based:
  // you earn for using LESS than the benchmark, not for using more.
  const amount = computeReward(utility, usage);
  if (amount <= 0) return { ok: false, error: "computed reward is zero" };
  // Hard per-payout ceiling — a stateless sanity bound so a bug or a crafted
  // submission can never sign an absurd amount. Tune MAX_REWARD in config/env.
  if (amount > MAX_REWARD) return { ok: false, error: "computed reward exceeds the per-payout cap" };

  return {
    ok: true,
    usage,
    prev, // server-authoritative baseline, so the on-chain proof reflects what we validated
    amount,
    // Called only after a successful payout: start the cooldown, bind the meter
    // to this wallet, and record this reading as the new baseline for next time.
    markPaid: () => {
      store.setCooldown(key, Date.now());
      store.bindMeter(meterKey, addr);
      store.setLastReading(meterKey, r);
    },
  };
}
