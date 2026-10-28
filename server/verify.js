// ── Server-side submission verification ──────────────────────────────────────
// The frontend's photo/OCR checks are a UX pre-filter and can be bypassed, so
// every payout is re-validated here. The reward AMOUNT is always recomputed on
// the server — a client-sent amount is never trusted.

import { RATES, UNITS, isEnabledUtility, COOLDOWN_MS, computeReward, usageBoundsFor, spanDays, MAX_REWARD, USAGE_BENCHMARK, SAVING_UTILS, MAX_SPAN_DAYS } from "./config.js";
import { store } from "./store.js";

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

export function validateSubmission(body) {
  const { utility, reading, prevRead, meterNo, address } = body || {};

  if (!isAddress(address)) return { ok: false, error: "invalid wallet address" };
  if (!isEnabledUtility(utility)) return { ok: false, error: "this utility isn't available" };
  if (!meterNo || !String(meterNo).trim()) return { ok: false, error: "meter number is required" };

  const addr = address.toLowerCase();
  const meterKey = String(meterNo).trim().toLowerCase();

  // A meter number belongs to one wallet (first to use it). This stops the same
  // physical meter being farmed from several accounts.
  const owner = store.meterOwner(utility, meterKey);
  if (owner && owner !== addr) return { ok: false, error: "this meter is registered to another wallet" };
  if (!owner && store.meterOverlapOwner(utility, meterKey, addr)) {
    return { ok: false, error: "this meter number overlaps one registered to another wallet — check the full number on your meter" };
  }

  // Number(), not parseFloat(): "1000x" is not a reading.
  const r = typeof reading === "number" || typeof reading === "string" ? Number(reading) : NaN;
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
  // Almost no usage over the whole span — less than the floor per day (0.1 kWh a day
  // for electricity; a fridge alone uses about 1). A home that is lived in doesn't
  // do that, so it is a reader sending an old value, the same number typed again,
  // or an empty house. It used to count as the best saving there is and pay the
  // maximum; now it is recorded without a reward and flagged for review.
  const span = Math.min(Math.max(Number(days) || 1, 1), MAX_SPAN_DAYS);
  const nearZero = SAVING_UTILS.has(utility) && usage < lo * span;
  if ((!SAVING_UTILS.has(utility) && usage > 0 && usage < lo) || usage > hi) {
    return { ok: false, error: `usage ${usage} ${UNITS[utility]} is outside the plausible range` };
  }

  // Per wallet+utility cooldown (durable, survives restarts).
  const key = `${addr}:${utility}`;
  const elapsed = Date.now() - store.getCooldown(key);
  if (elapsed < COOLDOWN_MS) {
    const mins = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
    return { ok: false, error: `cooldown active — try again in ~${mins} min` };
  }

  // Server is the source of truth for the reward amount, and it is saved kWh × rate
  // and nothing else: you earn for using LESS than the benchmark, not for logging.
  //
  // Nothing on a meter's FIRST submission. Its "previous reading" is whatever the
  // client typed — nothing on the server can vouch for it — so the usage, and with
  // it the saving, is the submitter's own choice: prevRead = reading means "zero
  // usage", the maximum. The first reading only sets the starting point; savings
  // are paid from the second reading on, measured from a number the server
  // recorded itself.
  //
  // A reading that saves nothing is still a valid reading: it is recorded (it is
  // the starting point for the next one) with amount 0, and the caller records it
  // without a payout.
  const firstReading = last == null;
  const amount = firstReading || nearZero ? 0 : computeReward(utility, usage, days);
  // Hard per-payout ceiling — a stateless sanity bound so a bug or a crafted
  // submission can never sign an absurd amount. Tune MAX_REWARD in config/env.
  if (amount > MAX_REWARD) return { ok: false, error: "computed reward exceeds the per-payout cap" };
  const target = +((USAGE_BENCHMARK[utility] ?? 0) * span).toFixed(2);

  return {
    ok: true,
    usage,
    days,
    prev, // server-authoritative baseline, so the on-chain proof reflects what we validated
    amount,
    firstReading,
    // Why a valid reading pays nothing, for the person who sent it.
    noReward: amount > 0 ? null
      : firstReading ? "your first reading sets your starting point — rewards start from your next reading"
      : nearZero ? "almost no usage since your last reading — recorded and held for review, no reward"
      : `you used ${usage} ${UNITS[utility]} in ${+span.toFixed(1)} day(s), against a target of ${target} ${UNITS[utility]} — recorded, no saving to reward this time`,
    // For the flag: why this reading was recorded without a reward.
    nearZero: nearZero
      ? `almost no usage: ${usage} ${UNITS[utility]} over ${+span.toFixed(1)} day(s) — recorded without a reward`
      : null,
    // Called only after a successful payout, or once a reading without a reward is
    // recorded: start the cooldown, bind the meter to this wallet, and record this
    // reading as the new baseline for next time.
    markPaid: () => {
      store.setCooldown(key, Date.now());
      store.bindMeter(utility, meterKey, addr);
      store.setLastReading(utility, meterKey, r);
    },
  };
}
