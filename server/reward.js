// ── On-chain payout via the reward-distributor wallet ────────────────────────
// Signs and broadcasts X2EarnRewardsPool.distributeReward(...) from the wallet
// that holds the reward-distributor role for this app. This is the ONLY place a
// private key is used; keep it server-side and out of source control.

import {
  ThorClient,
  VeChainProvider,
  VeChainPrivateKeySigner,
} from "@vechain/sdk-network";
import { Clause, Address, ABIFunction, HDKey, Transaction, HexUInt } from "@vechain/sdk-core";
import { NODE_URL, CONTRACTS, APP_ID, APP_VERSION, USAGE_BENCHMARK, SAVING_UTILS } from "./config.js";

// The official VeBetterDAO distribution call (X2EarnRewardsPool v10 ABI). The
// CONTRACT builds the standard proof-of-impact JSON on-chain from these typed
// arrays and emits it via RewardDistributed — this standard shape is what
// VeWorld / the VeBetter app recognise and render as a "VeBetter action" on the
// user's wallet activity. Our app-specific fields (utility, reading, …) travel
// in `metadata`, emitted separately via the RewardMetadata event.
const DISTRIBUTE_ABI = {
  name: "distributeRewardWithProofAndMetadata",
  type: "function",
  inputs: [
    { name: "appId",        type: "bytes32"   },
    { name: "amount",       type: "uint256"   },
    { name: "receiver",     type: "address"   },
    { name: "proofTypes",   type: "string[]"  },
    { name: "proofValues",  type: "string[]"  },
    { name: "impactCodes",  type: "string[]"  },
    { name: "impactValues", type: "uint256[]" },
    { name: "description",  type: "string"    },
    { name: "metadata",     type: "string"    },
  ],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
};

// Decimal amount → wei (18 decimals) without floating-point error.
function toWei(amount) {
  const s = String(amount).trim();
  const neg = s.startsWith("-");
  const [intPart = "0", fracRaw = ""] = s.replace("-", "").split(".");
  const frac = (fracRaw + "0".repeat(18)).slice(0, 18);
  const wei = BigInt((intPart || "0") + frac);
  return (neg ? -wei : wei).toString();
}

// Distributor key — supply EITHER a raw private key (DISTRIBUTOR_PRIVATE_KEY, hex)
// OR a recovery phrase (DISTRIBUTOR_MNEMONIC, the 12/24 words). The mnemonic path
// is handy when your wallet app (e.g. VeWorld) only lets you export the phrase, not
// the key. A phrase holds many accounts (m/44'/818'/0'/0/i — VeWorld's account #1,
// #2, …); set DISTRIBUTOR_ADDRESS to the exact wallet you want and we scan the first
// accounts until it matches, so you needn't know the account index. Without it we
// use the first account. Nothing here is ever logged except the matched index.
const ACCOUNT_SCAN = 20;
function loadKeyBytes() {
  const pkHex = (process.env.DISTRIBUTOR_PRIVATE_KEY || "").trim().replace(/^0x/, "");
  if (pkHex) {
    const b = Buffer.from(pkHex, "hex");
    if (b.length === 32) return b;
    console.warn("[reward] DISTRIBUTOR_PRIVATE_KEY is not a valid 32-byte hex key — ignoring it.");
  }

  const phrase = (process.env.DISTRIBUTOR_MNEMONIC || "").trim();
  if (!phrase) return null;
  const words = phrase.split(/\s+/);
  const want = (process.env.DISTRIBUTOR_ADDRESS || "").trim().toLowerCase();

  try {
    const scan = want ? ACCOUNT_SCAN : 1;
    for (let i = 0; i < scan; i++) {
      const pk = HDKey.fromMnemonic(words, HDKey.VET_DERIVATION_PATH).deriveChild(i).privateKey;
      if (!want || Address.ofPrivateKey(pk).toString().toLowerCase() === want) {
        if (want) console.log(`[reward] matched DISTRIBUTOR_ADDRESS at account #${i + 1}`);
        return Buffer.from(pk);
      }
    }
    console.warn(`[reward] DISTRIBUTOR_ADDRESS not found in the first ${ACCOUNT_SCAN} accounts of DISTRIBUTOR_MNEMONIC — wrong recovery phrase?`);
  } catch (e) {
    console.warn(`[reward] could not derive a key from DISTRIBUTOR_MNEMONIC: ${e.message}`);
  }
  return null;
}

const keyBytes = loadKeyBytes();
if (!keyBytes) {
  console.warn("[reward] No distributor key set — set DISTRIBUTOR_PRIVATE_KEY or DISTRIBUTOR_MNEMONIC; /reward will fail until you do.");
}

const thor = ThorClient.at(NODE_URL);
// The third argument switches fee delegation on in the transactions the provider
// builds. Without it a DELEGATION_URL transaction came out not marked as delegated
// and still carried the sponsor's signature — one the node rejects.
const signer = keyBytes ? new VeChainPrivateKeySigner(keyBytes, new VeChainProvider(thor, undefined, !!(process.env.DELEGATION_URL || "").trim())) : null;

// Optional fee delegation (VIP-191). When DELEGATION_URL is set (e.g. a
// vechain.energy sponsorship), the distributor still signs each reward but a
// sponsor pays the VTHO gas — so the distributor wallet needs no VTHO of its
// own. Leave empty to have the distributor pay its own gas.
const DELEGATION_URL = (process.env.DELEGATION_URL || "").trim();

export async function distributorAddress() {
  return signer ? signer.getAddress() : null;
}

// ── On-chain self-diagnosis ───────────────────────────────────────────────────
// Read-only checks against the VeBetterDAO contracts so /health can say exactly
// why payouts would fail: pool empty, or the distributor lacking the
// reward-distributor role for this app (the two classic revert causes).
export async function callView(to, fragment, args) {
  const abi = new ABIFunction(fragment);
  const data = abi.encodeData(args).toString();
  const res = await fetch(`${NODE_URL}/accounts/${to}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, value: "0x0" }),
  });
  if (!res.ok) throw new Error(`accounts call ${res.status}`);
  const out = await res.json();
  if (!out || out.reverted || !out.data || out.data === "0x") return null;
  return abi.decodeResult(out.data);
}

const AVAILABLE_FUNDS_ABI = { name: "availableFunds", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] };
const IS_DISTRIBUTOR_ABI  = { name: "isRewardDistributor", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }, { name: "distributor", type: "address" }], outputs: [{ name: "", type: "bool" }] };
// v10 two-bucket model: when the rewards-pool feature is ENABLED for an app,
// distributeReward draws from rewardsPoolBalance — NOT from availableFunds.
// Deposits land in availableFunds; the admin must move them over. This is the
// classic "pool looks funded but every payout reverts" trap.
const REWARDS_POOL_ENABLED_ABI = { name: "isRewardsPoolEnabled", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] };
const REWARDS_POOL_BALANCE_ABI = { name: "rewardsPoolBalance", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] };

const APP_ADMIN_ABI = { name: "appAdmin", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "address" }] };

// Emergency stop (pool v7+). While true every distributeReward reverts. Older pools
// lack the function, the call reverts, and this reads as null ("unknown").
const IS_DISTRIBUTION_PAUSED_ABI = { name: "isDistributionPaused", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] };

const first = (v) => (Array.isArray(v) ? v[0] : (v && typeof v === "object" ? Object.values(v)[0] : v));

export async function chainDiagnostics() {
  const out = { poolB3TR: null, distributorAuthorized: null, rewardsPoolEnabled: null, rewardsPoolB3TR: null, appAdmin: null, distributionPaused: null };
  try {
    if (CONTRACTS.X2EarnApps) {
      const a = first(await callView(CONTRACTS.X2EarnApps, APP_ADMIN_ABI, [APP_ID]));
      if (a) out.appAdmin = String(a);
    }
  } catch {}
  try {
    const funds = first(await callView(CONTRACTS.X2EarnRewardsPool, AVAILABLE_FUNDS_ABI, [APP_ID]));
    if (funds != null) out.poolB3TR = Number(BigInt(funds) / 10n ** 14n) / 1e4;
  } catch {}
  try {
    const en = first(await callView(CONTRACTS.X2EarnRewardsPool, REWARDS_POOL_ENABLED_ABI, [APP_ID]));
    if (en != null) out.rewardsPoolEnabled = en === true;
  } catch {}
  try {
    const bal = first(await callView(CONTRACTS.X2EarnRewardsPool, REWARDS_POOL_BALANCE_ABI, [APP_ID]));
    if (bal != null) out.rewardsPoolB3TR = Number(BigInt(bal) / 10n ** 14n) / 1e4;
  } catch {}
  try {
    const p = first(await callView(CONTRACTS.X2EarnRewardsPool, IS_DISTRIBUTION_PAUSED_ABI, [APP_ID]));
    if (p != null) out.distributionPaused = p === true;
  } catch {}
  try {
    const addr = signer ? await signer.getAddress() : null;
    if (addr && CONTRACTS.X2EarnApps) {
      const ok = first(await callView(CONTRACTS.X2EarnApps, IS_DISTRIBUTOR_ABI, [APP_ID, addr]));
      if (ok != null) out.distributorAuthorized = ok === true;
    }
  } catch {}
  return out;
}

// Build the VeBetterDAO proof blob. Top half follows the official VeBetterDAO
// "proof of impact" schema (version/description/proof/impact) so rewards show up
// correctly in the VeBetterDAO ecosystem; the lower half keeps our app-specific
// fields (utility/reading/b3tr/…) that the in-app history + leaderboard decode.
const UTILITY_LABELS = { electric: "Electricity", gas: "Gas", water: "Water", solar: "Solar" };

// Rough CO2 factors in grams CO2e per meter unit — editable estimates, not gospel.
// electric & solar: per kWh · gas: per m³ · water: per litre.
const CO2_PER_UNIT = { electric: 400, gas: 1900, water: 0.34, solar: 400 };

// Honest sustainability impact: grams of CO2 avoided. For consumption meters
// (electric/gas/water) that's the saving below the efficient-usage benchmark; for
// solar it's the clean energy you produced (which offsets grid power). Uses the
// same server-known benchmark the reward is based on — no client-supplied average,
// so the on-chain impact can't be fabricated. Returns {} when there's nothing
// positive to claim. `usage` is the server-validated usage in the meter's unit.
function computeImpact({ utility, usage }) {
  const factor = CO2_PER_UNIT[utility];
  if (!factor || !(usage >= 0)) return {};
  let avoidedUnits;
  if (!SAVING_UTILS.has(utility)) avoidedUnits = usage;                          // solar: clean energy produced
  else avoidedUnits = Math.max(0, (USAGE_BENCHMARK[utility] ?? 0) - usage);      // saved below the benchmark
  const grams = Math.round(avoidedUnits * factor);
  return grams > 0 ? { carbon: grams } : {};
}

// Move deposited B3TR from the app's availableFunds bucket into its
// distributable rewardsPoolBalance bucket, SIGNED BY THE DISTRIBUTOR wallet.
// Only works when the distributor happens to be the on-chain app admin (the
// contract requires isAppAdmin) — the /admin/move-rewards-pool endpoint uses
// this as the fallback when the user's own wallet lacks the admin role.
const INCREASE_RP_ABI = { name: "increaseRewardsPoolBalance", type: "function", stateMutability: "nonpayable", inputs: [{ name: "appId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] };

export async function moveToRewardsPool(amount) {
  if (!signer) throw new Error("distributor key not configured");
  const caller = await signer.getAddress();
  const clause = Clause.callFunction(Address.of(CONTRACTS.X2EarnRewardsPool), new ABIFunction(INCREASE_RP_ABI), [APP_ID, toWei(amount)]);
  const sim = await simulateClause(clause, caller).catch(() => null);
  if (sim && sim.reverted) throw new Error(`move would revert: ${sim.reason}`);
  const attempt = await sendClause(INCREASE_RP_ABI, [APP_ID, toWei(amount)], `Move ${amount} B3TR to rewards pool`);
  if (attempt.reverted) throw new Error("move reverted on-chain");
  return attempt.txid;
}

// Legacy single-proof-string variant — kept as an automatic fallback in case the
// deployed pool proxy predates distributeRewardWithProofAndMetadata.
// distributeRewardWithProof(appId, amount, receiver, proofTypes, proofValues,
// impactCodes, impactValues, description) — X2EarnRewardsPool.sol.
const DISTRIBUTE_WITH_PROOF_ABI = {
  name: "distributeRewardWithProof",
  type: "function",
  inputs: [
    { name: "appId",        type: "bytes32"   },
    { name: "amount",       type: "uint256"   },
    { name: "receiver",     type: "address"   },
    { name: "proofTypes",   type: "string[]"  },
    { name: "proofValues",  type: "string[]"  },
    { name: "impactCodes",  type: "string[]"  },
    { name: "impactValues", type: "uint256[]" },
    { name: "description",  type: "string"    },
  ],
  outputs: [],
  stateMutability: "nonpayable",
};

const LEGACY_DISTRIBUTE_ABI = {
  name: "distributeReward",
  type: "function",
  inputs: [
    { name: "appId",    type: "bytes32" },
    { name: "amount",   type: "uint256" },
    { name: "receiver", type: "address" },
    { name: "proof",    type: "string"  },
  ],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
};

// Decode a solidity Error(string) revert payload into its message.
function decodeRevertReason(data) {
  try {
    const hex = String(data || "").replace(/^0x/, "");
    if (!hex.startsWith("08c379a0")) return "";
    const body = hex.slice(8);
    const len = Number(BigInt("0x" + body.slice(64, 128)));
    return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch { return ""; }
}

// Dry-run a clause via the node (free, instant). Returns { reverted, reason } —
// the contract's OWN error message, so failures stop being a guessing game.
export async function simulateClause(clause, caller) {
  const res = await fetch(`${NODE_URL}/accounts/*`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clauses: [{ to: clause.to, value: "0x0", data: clause.data }], caller }),
  });
  if (!res.ok) throw new Error(`simulation call ${res.status}`);
  const [out] = await res.json();
  if (!out) throw new Error("empty simulation result");
  return { reverted: !!out.reverted, reason: out.reverted ? (decodeRevertReason(out.data) || out.vmError || "execution reverted") : "" };
}

// Broadcast one clause and wait for its receipt. Broadcast ≠ paid: a broadcast
// tx can still REVERT on-chain — and the app/admin read the CHAIN, so reporting
// success on broadcast produced green toasts for payouts that never landed.
// Generalised over the target contract so other modules (passport.js) can reuse the
// distributor signer, gas estimation and receipt handling. sendClause below keeps the
// original rewards-pool-only signature for every existing caller.
export async function sendClauseTo(to, abi, args, comment) {
  if (!signer) throw new Error("distributor key not configured");
  const clause = Clause.callFunction(Address.of(to), new ABIFunction(abi), args);
  // Sign first, broadcast second. With one call doing both, a broadcast whose
  // reply got lost (timeout, 5xx after the node took it) looked like "not sent":
  // the caller released the cooldown and the user's retry paid again. Signed
  // first, the id is known before anything leaves, so a failed broadcast can be
  // checked: the node has it → it went out; the node doesn't → safe to retry.
  // With DELEGATION_URL set, the gas is paid by the sponsor at that URL (VIP-191).
  const raw = await signer.signTransaction({
    clauses: [{ to: clause.to, value: "0x0", data: clause.data }],
    comment,
    ...(DELEGATION_URL ? { delegationUrl: DELEGATION_URL } : {}),
  });
  const txid = Transaction.decode(HexUInt.of(String(raw).replace(/^0x/, "")).bytes, true).id.toString();
  try {
    await thor.transactions.sendRawTransaction(raw);
  } catch (e) {
    const known = await nodeHasTransaction(txid);
    if (known === false) throw e; // never arrived: nothing was sent, a retry is safe
    // It arrived (or we can't tell): treat it as sent. Wrongly "sent" costs the
    // user one day's claim; wrongly "not sent" could pay twice.
    console.warn(`[reward] broadcast of ${txid} reported "${e?.message || e}" but the transaction ${known ? "is on the node" : "may have gone out"} — treating it as sent`);
  }
  let receipt = null;
  try {
    receipt = await thor.transactions.waitForTransaction(txid, { timeoutMs: 30000, intervalMs: 2000 });
  } catch (e) {
    console.warn(`[reward] receipt check inconclusive for ${txid}: ${e?.message || e}`);
  }
  // On a rare receipt timeout treat as pending (not reverted).
  return { txid, reverted: !!(receipt && receipt.reverted) };
}

// Is this transaction known to the node (pending or included)? true / false, or
// null when the node can't be asked.
async function nodeHasTransaction(txid) {
  try {
    const res = await fetch(`${NODE_URL}/transactions/${txid}?pending=true`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body != null;
  } catch { return null; }
}

const sendClause = (abi, args, comment) =>
  sendClauseTo(CONTRACTS.X2EarnRewardsPool, abi, args, comment);

// Sign + broadcast the payout. Preferred path: distributeRewardWithProofAndMetadata
// (the contract builds the standard VeBetter proof that wallets recognise, and our
// app fields ride in `metadata`). If that call REVERTS — e.g. the deployed testnet
// proxy predates it — we automatically retry once via the legacy distributeReward
// with a self-built proof JSON, so a payout succeeds on whichever path the
// deployed contract supports. Only a mined, non-reverted tx counts as success.
// Every reward — meter and eco alike — reaches the chain through this one function,
// so this is the only place a test harness needs to stop. Without it the payout path
// could never be exercised end to end: validation could be tested, the effects of a
// successful payout (cooldown started, baseline advanced, pairing marked as paid)
// could not, and those are exactly the rules that decide what a wallet earns next.
//
// Must be set to an explicit true, is shouted about at startup, and is reported by
// /health, so it cannot sit unnoticed in a deployment that is handing out real B3TR.
// An error whose message is written for the user and safe to show them. Anything
// else (node URLs, provider internals, stack-ish text) stays in the server log.
export function publicError(message) {
  const e = new Error(message);
  e.public = true;
  return e;
}

export const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DISTRIBUTOR_DRY_RUN || "");
if (DRY_RUN) {
  console.warn("[reward] DISTRIBUTOR_DRY_RUN is on — rewards are NOT sent on-chain.");
}

async function sendProofReward({ amount, receiver, proofText, impacts, description, metadata, comment }) {
  if (DRY_RUN) {
    // Shaped like a real txid so callers, logs and stored history need no special case.
    const fake = "0xdry" + Buffer.from(`${receiver}:${amount}:${Date.now()}`).toString("hex").slice(0, 61);
    // The metadata too: it is what an admin later reads off the chain, and the only
    // way a test can check what would have been written without a chain to write to.
    console.warn(`[reward] DRY RUN — would send ${amount} B3TR to ${receiver} (${fake}) metadata=${metadata || ""}`);
    return fake;
  }
  if (!signer) throw new Error("distributor key not configured");
  const caller = await signer.getAddress();
  const impactCodes = [], impactValues = [], impactObj = {};
  for (const [code, val] of Object.entries(impacts || {})) {
    const v = Math.round(Number(val) || 0);
    if (v > 0) { impactCodes.push(code); impactValues.push(String(v)); impactObj[code] = v; }
  }

  let meta = {}; try { meta = JSON.parse(metadata) || {}; } catch {}
  const legacyProof = JSON.stringify({
    version: 2, description, proof: { text: proofText }, impact: impactObj, appId: APP_ID, ...meta,
  });
  // Tried in this order; the first the deployed contract accepts is sent. The
  // middle one keeps proof and impact (only our metadata is dropped): the plain
  // distributeReward of current pools ignores its proof argument and records an
  // empty one, so it is only the last resort for a very old pool.
  const variants = [
    { name: "with proof and metadata", abi: DISTRIBUTE_ABI, args: [APP_ID, toWei(amount), receiver, ["text"], [proofText], impactCodes, impactValues, description, metadata] },
    { name: "with proof", abi: DISTRIBUTE_WITH_PROOF_ABI, args: [APP_ID, toWei(amount), receiver, ["text"], [proofText], impactCodes, impactValues, description] },
    { name: "legacy", abi: LEGACY_DISTRIBUTE_ABI, args: [APP_ID, toWei(amount), receiver, legacyProof] },
  ];

  // SIMULATE first (free): pick the variant the deployed contract accepts, and
  // when all would revert, surface the contract's own reason instead of burning
  // gas on a doomed tx and guessing afterwards. A simulation that can't run at
  // all (node hiccup) doesn't rule a variant out.
  let chosen = null;
  const reasons = [];
  for (const v of variants) {
    const clause = Clause.callFunction(Address.of(CONTRACTS.X2EarnRewardsPool), new ABIFunction(v.abi), v.args);
    try {
      const sim = await simulateClause(clause, caller);
      if (!sim.reverted) { chosen = v; break; }
      reasons.push(sim.reason || "reverted");
    } catch (e) {
      console.warn(`[reward] simulation of "${v.name}" inconclusive: ${e?.message || e}`);
      chosen = v; break;
    }
  }
  if (!chosen) {
    const all = reasons.join(" · ");
    console.error(`[reward] payout would revert — ${variants.map((v, i) => `${v.name}: "${reasons[i] || ""}"`).join(" · ")}`);
    // The admin's emergency stop. Say so in words a user can act on ("try later"),
    // not as a contract error that reads like something they did wrong.
    if (/distribution is paused/i.test(all)) {
      throw publicError("payouts are paused by the app admin — nothing was used up, try again later");
    }
    if (/insufficient (available )?funds|not enough funds/i.test(all)) {
      throw publicError("this week's reward budget is used up — rewards resume after the next VeBetterDAO round, nothing was used up");
    }
    throw publicError(`payout would revert: ${reasons[0] || "unknown reason"}`);
  }
  if (chosen !== variants[0]) console.warn(`[reward] "${variants[0].name}" reverts ("${reasons[0]}") — sending "${chosen.name}"`);

  const attempt = await sendClause(chosen.abi, chosen.args, chosen === variants[0] ? comment : `${comment} (${chosen.name})`);
  if (attempt.reverted) {
    console.error(`[reward] tx ${attempt.txid} reverted on-chain despite clean simulation`);
    throw publicError("payout reverted on-chain — re-run the admin System Check and try again");
  }
  return attempt.txid;
}

// Returns the broadcast transaction id. `usage` and `prevRead` are the
// server-validated values from validateSubmission, not the raw client body.
// For text that the contract pastes into its proof JSON without escaping: a quote
// in a meter "number" could otherwise break that JSON or smuggle in a field.
const proofSafe = (v) => String(v ?? "").replace(/[^A-Za-z0-9.\-_]/g, "").slice(0, 40);
const proofNum = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : "?");

// `noImpact`: a payout held to the base amount (a meter's first reading, almost no
// usage) claims no saving — its "usage" is the submitter's word or a stale value,
// and the chain record shouldn't present it as kilograms of CO2 avoided.
export async function distributeReward({ utility, meterNo, reading, prevRead, usage, amount, receiver, source, noImpact = false }) {
  const label = UTILITY_LABELS[utility] || utility;
  const u = Math.max(0, Number(usage) || 0);
  // Units as VeBetterDAO defines them (vechain-ai-skills, sustainability-proofs):
  // carbon g CO2e, energy Wh saved, water ml, clean_energy_production_wh Wh made.
  const impacts = {};
  if (!noImpact) {
    Object.assign(impacts, computeImpact({ utility, usage: u })); // { carbon: grams } or {}
    if (utility === "electric") {
      const savedKwh = Math.max(0, (USAGE_BENCHMARK.electric ?? 0) - u);
      if (savedKwh > 0) impacts.energy = savedKwh * 1000; // Wh
    } else if (utility === "solar") {
      impacts.clean_energy_production_wh = u * 1000; // Wh produced
    } else if (utility === "water") {
      const savedL = Math.max(0, (USAGE_BENCHMARK.water ?? 0) - u);
      if (savedL > 0) impacts.water = savedL * 1000; // ml
    }
  }
  const metadata = JSON.stringify({
    action: "meter_reading", utility,
    meterNo: meterNo || "", reading: String(reading), prevRead: String(prevRead),
    usage: u, b3tr: amount, timestamp: new Date().toISOString(), appVersion: APP_VERSION,
    // Where the number came from. An admin reviewing a payout could not tell a
    // photographed reading from one a reader pushed, which matters: only the first
    // has a photo to check, and only the second was never seen by a human. Written
    // into the on-chain metadata rather than kept server-side, so the record travels
    // with the payout and cannot drift from it.
    source: source || "photo",
  });
  return sendProofReward({
    amount, receiver,
    proofText:   `${utility} reading ${proofNum(reading)} (previous ${proofNum(prevRead)})${proofSafe(meterNo) ? `, meter ${proofSafe(meterNo)}` : ""}`,
    impacts,
    description: `${label} meter reading logged via Green Utility Log`,
    metadata,
    comment:     `Green Utility Log — ${utility} reward (${amount} B3TR)`,
  });
}

// Eco-mode bonus: a fixed reward for photographing an appliance running in eco
// mode. The impact is a conservative fixed estimate (an eco cycle saves roughly
// 0.5 kWh vs a normal cycle ≈ 200 g CO2e) — deliberately small and honest.
const ECO_APPLIANCE_LABELS = { washer: "Washing machine", dryer: "Dryer", dishwasher: "Dishwasher" };

export async function distributeEcoReward({ appliance, amount, receiver }) {
  const label = ECO_APPLIANCE_LABELS[appliance] || "Appliance";
  const metadata = JSON.stringify({
    action: "eco_mode", utility: "eco", appliance,
    b3tr: amount, timestamp: new Date().toISOString(), appVersion: APP_VERSION,
  });
  return sendProofReward({
    amount, receiver,
    proofText:   `${label} photographed running in eco mode`,
    impacts:     { carbon: 200, energy: 500 }, // ≈0.5 kWh saved per eco cycle
    description: `${label} run in eco mode, logged via Green Utility Log`,
    metadata,
    comment:     `Green Utility Log — eco-mode bonus (${amount} B3TR)`,
  });
}
