// ── VeBetterPassport: bot signalling ─────────────────────────────────────────
// VeBetterDAO's sybil defence. Apps flag ("signal") wallets they believe are bots;
// once a wallet passes the network-wide signalling threshold the passport stops
// counting it as a person, which costs it allocation weight across the whole
// ecosystem — not just here. So a signal is a real accusation, not a local mute.
//
// Two halves, with very different requirements:
//
//   READING works for anyone, no role and no key. That is the useful half today:
//   who is already signalled, and whom does the passport not consider a person.
//
//   SIGNALLING needs SIGNALER_ROLE on the passport contract. It is granted by
//   `assignSignalerToApp(app, wallet)`, which is `onlyRoleOrAdmin(ROLE_GRANTER)` —
//   VeBetterDAO, not the app admin. We cannot grant it to ourselves; it has to be
//   requested. Until then signalStatus() reports authorized:false and the endpoint
//   refuses rather than burning gas on a call that would revert.
//
// Resetting a wallet's signals is deliberately NOT implemented: it sits behind
// RESET_SIGNALER_ROLE, which is VeBetterDAO's own moderation path. A wallet
// flagged by mistake is appealed to them, not undone from here.
//
// Addresses live in config.js. Signatures verified against the contract source at
// vechain/vebetterdao-contracts → packages/contracts/contracts/ve-better-passport.

import { Clause, Address, ABIFunction } from "@vechain/sdk-core";
import { CONTRACTS, APP_ID } from "./config.js";
import { callView, simulateClause, sendClauseTo, distributorAddress } from "./reward.js";

const PASSPORT = CONTRACTS.VeBetterPassport;

// keccak256("SIGNALER_ROLE"). Taken from the contract and cross-checked against
// vechain-energy's signal-admin, which uses the same constant.
const SIGNALER_ROLE = "0xa4ce4aad7fca001529f4aae69bf669c4020e0aaa65ff85dc9f7b13c20e01624a";

const view = (name, inputs, outputs) => ({ name, type: "function", stateMutability: "view", inputs, outputs });
const ADDR = (n) => ({ name: n, type: "address" });
const U256 = (n = "") => ({ name: n, type: "uint256" });

const IS_PERSON_ABI          = view("isPerson", [ADDR("user")], [{ name: "person", type: "bool" }, { name: "reason", type: "string" }]);
const SIGNALED_COUNTER_ABI   = view("signaledCounter", [ADDR("_user")], [U256()]);
const APP_SIGNALS_ABI        = view("appSignalsCounter", [{ name: "_app", type: "bytes32" }, ADDR("_user")], [U256()]);
const APP_TOTAL_SIGNALS_ABI  = view("appTotalSignalsCounter", [{ name: "_app", type: "bytes32" }], [U256()]);
const SIGNALING_THRESHOLD_ABI= view("signalingThreshold", [], [U256()]);
const IS_BLACKLISTED_ABI     = view("isBlacklisted", [ADDR("_user")], [{ name: "", type: "bool" }]);
const HAS_ROLE_ABI           = view("hasRole", [{ name: "role", type: "bytes32" }, ADDR("account")], [{ name: "", type: "bool" }]);

const SIGNAL_ABI = {
  name: "signalUserWithReason",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [ADDR("_user"), { name: "reason", type: "string" }],
  outputs: [],
};

export const passportConfigured = () => Boolean(PASSPORT);

// decodeResult hands back an array, a named object, or a bare value depending on
// the shape — normalise to a positional array so callers can just index.
function tuple(decoded) {
  if (decoded == null) return [];
  if (Array.isArray(decoded)) return decoded;
  if (typeof decoded === "object") return Object.values(decoded);
  return [decoded];
}
const one = (decoded) => tuple(decoded)[0];
const num = (v) => (v == null ? null : Number(BigInt(v)));

async function read(abi, args) {
  if (!PASSPORT) return null;
  return callView(PASSPORT, abi, args).catch(() => null);
}

// Is the distributor wallet allowed to signal, and how many signals has this app
// filed in total? Everything here is best-effort: a passport that can't be reached
// must never break the admin panel, so failures surface as nulls.
export async function signalStatus() {
  const out = {
    contract: PASSPORT || null,
    appId: APP_ID,
    signaler: null,
    authorized: null,
    threshold: null,
    appTotalSignals: null,
  };
  if (!PASSPORT) return out;

  out.signaler = await distributorAddress().catch(() => null);
  if (out.signaler) {
    const ok = one(await read(HAS_ROLE_ABI, [SIGNALER_ROLE, out.signaler]));
    if (ok != null) out.authorized = ok === true;
  }
  out.threshold = num(one(await read(SIGNALING_THRESHOLD_ABI, [])));
  out.appTotalSignals = num(one(await read(APP_TOTAL_SIGNALS_ABI, [APP_ID])));
  return out;
}

// Passport state for a batch of wallets — what the admin list shows per row.
// `person:false` is the signal that matters: that wallet currently earns the app
// no allocation weight, whatever the reason.
export async function passportFor(addresses) {
  const wallets = [...new Set((addresses || []).map((a) => String(a || "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
  if (!PASSPORT || !wallets.length) return {};

  const entries = await Promise.all(wallets.map(async (addr) => {
    const [person, signals, appSignals, blacklisted] = await Promise.all([
      read(IS_PERSON_ABI, [addr]),
      read(SIGNALED_COUNTER_ABI, [addr]),
      read(APP_SIGNALS_ABI, [APP_ID, addr]),
      read(IS_BLACKLISTED_ABI, [addr]),
    ]);
    const p = tuple(person);
    return [addr, {
      isPerson: p.length ? p[0] === true : null,
      // The contract's own explanation ("User has been signaled too many times",
      // "User's participation score is too low", …) — far more useful than a bool.
      reason: p.length > 1 ? String(p[1] ?? "") : "",
      signals: num(one(signals)),
      appSignals: num(one(appSignals)),
      blacklisted: one(blacklisted) === true ? true : (one(blacklisted) === false ? false : null),
    }];
  }));
  return Object.fromEntries(entries);
}

// File a signal against a wallet, signed by the distributor. Simulated first so an
// unauthorised or otherwise doomed call fails with the contract's own reason
// instead of a burnt transaction.
export async function signalUser(address, reason) {
  if (!PASSPORT) throw new Error("no VeBetterPassport address for this network");
  const target = String(address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error("invalid wallet address");

  const text = String(reason || "").trim().slice(0, 256);
  if (!text) throw new Error("a reason is required");

  const caller = await distributorAddress();
  if (!caller) throw new Error("distributor key not configured");

  const clause = Clause.callFunction(Address.of(PASSPORT), new ABIFunction(SIGNAL_ABI), [target, text]);
  const sim = await simulateClause(clause, caller).catch(() => null);
  if (sim && sim.reverted) {
    throw new Error(`signal would revert: ${sim.reason || "not authorised to signal"}`);
  }

  const attempt = await sendClauseTo(PASSPORT, SIGNAL_ABI, [target, text], `Signal ${target} — ${text}`);
  if (attempt.reverted) throw new Error("signal reverted on-chain");
  return attempt.txid;
}
