// ── Server-side submission verification ──────────────────────────────────────
// The frontend's photo/OCR checks are a UX pre-filter and can be bypassed, so
// every payout is re-validated here. The reward AMOUNT is always recomputed on
// the server — a client-sent amount is never trusted.

import { RATES, UNITS, COOLDOWN_MS, computeReward, usageBoundsFor, spanDays, MAX_REWARD } from "./config.js";
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
  const owner = store.meterOwner(utility, meterKey);
  if (owner && owner !== addr) return { ok: false, error: "this meter is registered to another wallet" };

  const r = parseFloat(reading);
  if (!Number.isFinite(r)) return { ok: false, error: "invalid reading" };

  // Compute usage from the LAST reading the server recorded for this meter, not
  // the client-sent prevRead — that way a baseline can't be lowered to inflate
  // the delta. The first ever submission falls back to the supplied baseline.
  const last = store.lastReading(utility, meterKey);
  let prev;
  if (last != null) {
    prev = last;
  } else {
    prev = parseFloat(prevRead);
    if (!Number.isFinite(prev)) return { ok: false, error: "invalid baseline reading" };
  }
  // A meter never runs backwards, so a LOWER reading is rejected. An EQUAL
  // reading (zero consumption) is valid — it's the best conservation outcome and
  // earns the maximum reward.
  if (r < prev) return { ok: false, error: `current reading (${r}) can't be lower than the last recorded reading (${prev})` };

  const usage = +(r - prev).toFixed(2);

  // How many days this reading covers, from the timestamp of the last paid reading
  // for THIS meter (not the wallet cooldown, which would be wrong for a wallet with
  // two meters on the same utility). Unknown — a first submission, or a meter last
  // read before we recorded timestamps — counts as one day, i.e. the old behaviour.
  const lastAt = store.lastReadingAt(utility, meterKey);
  const days = lastAt ? spanDays(Date.now() - lastAt) : 1;

  const [lo, hi] = usageBoundsFor(utility, days);
  // usage 0 (equal readings) is allowed; only a tiny-but-nonzero delta below the
  // plausible floor, or an abnormally high delta, is rejected.
  if ((usage > 0 && usage < lo) || usage > hi) {
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
  const amount = computeReward(utility, usage, days);
  if (amount <= 0) return { ok: false, error: "computed reward is zero" };
  // Hard per-payout ceiling — a stateless sanity bound so a bug or a crafted
  // submission can never sign an absurd amount. Tune MAX_REWARD in config/env.
  if (amount > MAX_REWARD) return { ok: false, error: "computed reward exceeds the per-payout cap" };

  return {
    ok: true,
    usage,
    days,
    prev, // server-authoritative baseline, so the on-chain proof reflects what we validated
    amount,
    // Called only after a successful payout: start the cooldown, bind the meter
    // to this wallet, and record this reading as the new baseline for next time.
    markPaid: () => {
      store.setCooldown(key, Date.now());
      store.bindMeter(utility, meterKey, addr);
      store.setLastReading(utility, meterKey, r);
    },
  };
}
