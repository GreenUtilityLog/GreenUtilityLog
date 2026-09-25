// ── Spreading the weekly B3TR over the week ──────────────────────────────────
// Rewards are paid from what VeBetterDAO allocates to the app each round (a week).
// Fixed amounts either run the pot dry mid-week or leave it unspent. So every
// payout is multiplied by a factor, never above 1:
//
//   daily budget = B3TR in the pot ÷ days until the round ends
//   daily demand = what the last 7 days of payouts would have been at full rates
//   factor       = min(1, daily budget ÷ daily demand)
//
// Busy week: everyone gets the same smaller share. Quiet week: full rates. The pot
// refills when the round's allocation is claimed, which the server does itself
// (autoClaimAllocation) as soon as a round has ended.
//
// Unknown pot (chain unreachable) means factor 1: never shrink rewards on a guess.
// The contract still refuses a payout the pot can't cover.

import { Clause, Address, ABIFunction } from "@vechain/sdk-core";
import { CONTRACTS, APP_ID, NODE_URL } from "./config.js";
import { store } from "./store.js";
import { callView, chainDiagnostics, simulateClause, sendClauseTo, distributorAddress, DRY_RUN } from "./reward.js";

const SCALING = String(process.env.REWARD_SCALING || "on").toLowerCase() !== "off";
const BLOCK_SECONDS = 10;
const CACHE_MS = 10 * 60 * 1000;
const DAY = 86400000;

const view = (name, inputs, outputs) => ({ name, type: "function", stateMutability: "view", inputs, outputs });
const U256 = { name: "", type: "uint256" };
const ROUND_ID_ABI = view("currentRoundId", [], [U256]);
const ROUND_DEADLINE_ABI = view("currentRoundDeadline", [], [U256]);
const CLAIMABLE_ABI = view("claimableAmount",
  [{ name: "roundId", type: "uint256" }, { name: "appId", type: "bytes32" }],
  [{ name: "totalAmount", type: "uint256" }, { name: "unallocatedAmount", type: "uint256" }, { name: "teamAllocationAmount", type: "uint256" }, { name: "x2EarnRewardsPoolAmount", type: "uint256" }]);
const CLAIM_ABI = { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [{ name: "roundId", type: "uint256" }, { name: "appId", type: "bytes32" }], outputs: [] };

const first = (v) => (Array.isArray(v) ? v[0] : (v && typeof v === "object" ? Object.values(v)[0] : v));
const num = (v) => { try { return Number(BigInt(v)); } catch { return null; } };
const round2 = (n) => Math.floor(n * 100) / 100;

// Environment overrides: a fixed pot and horizon (tests, or running on a manual
// budget instead of the chain's).
const envNum = (k) => (process.env[k] != null && process.env[k] !== "" && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : null);

async function roundEndsAt() {
  const fixed = envNum("BUDGET_DAYS_LEFT");
  if (fixed != null) return Date.now() + fixed * DAY;
  if (DRY_RUN || !CONTRACTS.XAllocationVoting) return null;
  try {
    const deadline = num(first(await callView(CONTRACTS.XAllocationVoting, ROUND_DEADLINE_ABI, [])));
    const res = await fetch(`${NODE_URL}/blocks/best`);
    const best = res.ok ? await res.json() : null;
    if (deadline == null || !best?.number) return null;
    return best.timestamp * 1000 + (deadline - best.number) * BLOCK_SECONDS * 1000;
  } catch { return null; }
}

async function potB3TR() {
  const fixed = envNum("BUDGET_POOL_B3TR");
  if (fixed != null) return fixed;
  if (DRY_RUN) return null;
  try {
    const d = await chainDiagnostics();
    // With the rewards-pool feature on, payouts come from that bucket only.
    return d.rewardsPoolEnabled === true ? d.rewardsPoolB3TR : d.poolB3TR;
  } catch { return null; }
}

// Full-rate payouts per day over the last 7 days (or since the first one, if the
// app is younger than that — dividing a 2-day history by 7 would understate it).
function dailyDemand(now = Date.now()) {
  const recent = store.payLog().filter((e) => now - e.t < 7 * DAY);
  if (!recent.length) return 0;
  const span = Math.min(7, Math.max(1, (now - Math.min(...recent.map((e) => e.t))) / DAY));
  return recent.reduce((a, e) => a + e.full, 0) / span;
}

let cache = null;
export function invalidateBudget() { cache = null; }

export async function budgetState() {
  if (cache && Date.now() - cache.at < CACHE_MS) return { ...cache.state, dailyDemand: +dailyDemand().toFixed(2), factor: factorFor(cache.state) };
  const [pot, endsAt] = await Promise.all([potB3TR(), roundEndsAt()]);
  // Half a day of slack past the deadline: the new allocation arrives only after
  // the round has ended AND been claimed.
  const daysLeft = endsAt != null ? Math.max(0.5, (endsAt - Date.now()) / DAY + 0.5) : 7;
  const state = {
    scaling: SCALING,
    poolB3TR: pot,
    roundEndsAt: endsAt,
    daysLeft: +daysLeft.toFixed(2),
    dailyBudget: pot != null ? +(pot / daysLeft).toFixed(2) : null,
  };
  cache = { at: Date.now(), state };
  return { ...state, dailyDemand: +dailyDemand().toFixed(2), factor: factorFor(state) };
}

function factorFor(state) {
  if (!SCALING || state.dailyBudget == null) return 1;
  const demand = dailyDemand();
  if (demand <= 0) return 1;
  return Math.max(0, Math.min(1, state.dailyBudget / demand));
}

// The amount to actually pay for a full-rate `full`. { amount } or { error }.
export async function scaledAmount(full) {
  const b = await budgetState();
  const amount = round2(full * b.factor);
  if (b.poolB3TR != null && b.poolB3TR < Math.max(amount, 0.01)) {
    return { error: `this week's reward budget is used up — rewards resume after the next VeBetterDAO round (in about ${Math.ceil(b.daysLeft)} day${Math.ceil(b.daysLeft) === 1 ? "" : "s"})` };
  }
  if (amount < 0.01) return { error: "this week's reward budget is spread too thin for another payout — try again tomorrow" };
  return { amount, factor: b.factor };
}

export function recordPayout(full) {
  store.addPayLog(full);
}

// ── Collecting the weekly allocation ─────────────────────────────────────────
// XAllocationPool.claim(roundId, appId) moves an ended round's allocation into the
// rewards pool (minus the team share). Anyone may call it, nobody has to: so the
// server does, once a round has ended, instead of the pot waiting for a person.
export async function autoClaimAllocation() {
  if (DRY_RUN || !CONTRACTS.XAllocationPool || !CONTRACTS.XAllocationVoting) return null;
  if (String(process.env.AUTO_CLAIM_ALLOCATION || "on").toLowerCase() === "off") return null;
  const caller = await distributorAddress().catch(() => null);
  if (!caller) return null;
  const current = num(first(await callView(CONTRACTS.XAllocationVoting, ROUND_ID_ABI, []).catch(() => null)));
  if (!current || current < 2) return null;
  // The last two ended rounds, in case one was missed while the service slept.
  for (const roundId of [current - 1, current - 2]) {
    if (roundId < 1) continue;
    const c = await callView(CONTRACTS.XAllocationPool, CLAIMABLE_ABI, [roundId, APP_ID]).catch(() => null);
    const total = c ? num(Array.isArray(c) ? c[0] : Object.values(c)[0]) : null;
    if (!total) continue;
    const clause = Clause.callFunction(Address.of(CONTRACTS.XAllocationPool), new ABIFunction(CLAIM_ABI), [roundId, APP_ID]);
    const sim = await simulateClause(clause, caller).catch(() => null);
    if (sim?.reverted) { console.warn(`[budget] claim of round ${roundId} would revert: ${sim.reason}`); continue; }
    try {
      const r = await sendClauseTo(CONTRACTS.XAllocationPool, CLAIM_ABI, [roundId, APP_ID], `Claim round ${roundId} allocation`);
      console.log(`[budget] claimed round ${roundId} allocation (${(total / 1e18).toFixed(2)} B3TR incl. team share) — tx ${r.txid}${r.reverted ? " REVERTED" : ""}`);
      invalidateBudget();
      return r.txid;
    } catch (e) { console.warn(`[budget] claim of round ${roundId} failed: ${e?.message || e}`); }
  }
  return null;
}
