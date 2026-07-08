// ── On-chain payout via the reward-distributor wallet ────────────────────────
// Signs and broadcasts X2EarnRewardsPool.distributeReward(...) from the wallet
// that holds the reward-distributor role for this app. This is the ONLY place a
// private key is used; keep it server-side and out of source control.

import {
  ThorClient,
  VeChainProvider,
  VeChainPrivateKeySigner,
} from "@vechain/sdk-network";
import { Clause, Address, ABIFunction, HDKey } from "@vechain/sdk-core";
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
const signer = keyBytes ? new VeChainPrivateKeySigner(keyBytes, new VeChainProvider(thor)) : null;

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
async function callView(to, fragment, args) {
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

const first = (v) => (Array.isArray(v) ? v[0] : (v && typeof v === "object" ? Object.values(v)[0] : v));

export async function chainDiagnostics() {
  const out = { poolB3TR: null, distributorAuthorized: null };
  try {
    const funds = first(await callView(CONTRACTS.X2EarnRewardsPool, AVAILABLE_FUNDS_ABI, [APP_ID]));
    if (funds != null) out.poolB3TR = Number(BigInt(funds) / 10n ** 14n) / 1e4;
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

// Sign + broadcast one distributeRewardWithProofAndMetadata call. The contract
// assembles the standard VeBetter proof JSON from proofText/impacts/description
// and emits it (RewardDistributed); `metadata` is our app-specific JSON, emitted
// via the RewardMetadata event and merged back in by the app's history decoder.
async function sendProofReward({ amount, receiver, proofText, impacts, description, metadata, comment }) {
  if (!signer) throw new Error("distributor key not configured");
  const impactCodes = [], impactValues = [];
  for (const [code, val] of Object.entries(impacts || {})) {
    const v = Math.round(Number(val) || 0);
    if (v > 0) { impactCodes.push(code); impactValues.push(String(v)); }
  }
  const clause = Clause.callFunction(
    Address.of(CONTRACTS.X2EarnRewardsPool),
    new ABIFunction(DISTRIBUTE_ABI),
    [APP_ID, toWei(amount), receiver, ["text"], [proofText], impactCodes, impactValues, description, metadata]
  );
  // sendTransaction estimates gas, builds, signs and broadcasts; resolves to txid.
  // With DELEGATION_URL set, the gas is paid by the sponsor at that URL (VIP-191).
  return signer.sendTransaction({
    clauses: [{ to: clause.to, value: "0x0", data: clause.data }],
    comment,
    ...(DELEGATION_URL ? { delegationUrl: DELEGATION_URL } : {}),
  });
}

// Returns the broadcast transaction id. `usage` and `prevRead` are the
// server-validated values from validateSubmission, not the raw client body.
export async function distributeReward({ utility, meterNo, reading, prevRead, usage, amount, receiver }) {
  const label = UTILITY_LABELS[utility] || utility;
  const u = Math.max(0, Number(usage) || 0);
  const impact = computeImpact({ utility, usage: u }); // { carbon: grams } or {}
  // Extra standard impact codes VeBetter understands: energy saved/produced (Wh)
  // for electric & solar, litres for water. Same server-validated basis as carbon.
  const impacts = { ...impact };
  if (utility === "electric") {
    const savedKwh = Math.max(0, (USAGE_BENCHMARK.electric ?? 0) - u);
    if (savedKwh > 0) impacts.energy = savedKwh * 1000; // Wh
  } else if (utility === "solar") {
    impacts.energy = u * 1000; // Wh produced
  } else if (utility === "water") {
    const savedL = Math.max(0, (USAGE_BENCHMARK.water ?? 0) - u);
    if (savedL > 0) impacts.water = savedL; // litres
  }
  const metadata = JSON.stringify({
    action: "meter_reading", utility,
    meterNo: meterNo || "", reading: String(reading), prevRead: String(prevRead),
    usage: u, b3tr: amount, timestamp: new Date().toISOString(), appVersion: APP_VERSION,
  });
  return sendProofReward({
    amount, receiver,
    proofText:   `${utility} reading ${reading} (previous ${prevRead})${meterNo ? `, meter ${meterNo}` : ""}`,
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
