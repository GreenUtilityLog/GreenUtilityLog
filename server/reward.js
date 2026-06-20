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
import { NODE_URL, CONTRACTS, APP_ID, APP_VERSION } from "./config.js";

const DISTRIBUTE_ABI = {
  name: "distributeRewardDeprecated",
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

// Build the VeBetterDAO proof blob. Top half follows the official VeBetterDAO
// "proof of impact" schema (version/description/proof/impact) so rewards show up
// correctly in the VeBetterDAO ecosystem; the lower half keeps our app-specific
// fields (utility/reading/b3tr/…) that the in-app history + leaderboard decode.
const UTILITY_LABELS = { electric: "Electricity", gas: "Gas", water: "Water", solar: "Solar" };
function buildProof({ utility, meterNo, reading, prevRead, amount }) {
  const label = UTILITY_LABELS[utility] || utility;
  return JSON.stringify({
    // VeBetterDAO standard fields
    version: 2,
    description: `${label} meter reading logged via Green Utility Log`,
    proof: {
      text: `${utility} reading ${reading} (previous ${prevRead})${meterNo ? `, meter ${meterNo}` : ""}`,
    },
    impact: {},
    // App-specific fields (decoded by our own history/leaderboard)
    appId:      APP_ID,
    action:     "meter_reading",
    utility,
    meterNo:    meterNo || "",
    reading:    String(reading),
    prevRead:   String(prevRead),
    b3tr:       amount,
    timestamp:  new Date().toISOString(),
    appVersion: APP_VERSION,
  });
}

// Returns the broadcast transaction id.
export async function distributeReward({ utility, meterNo, reading, prevRead, amount, receiver }) {
  if (!signer) throw new Error("distributor key not configured");

  const amountWei = toWei(amount);
  const proof = buildProof({ utility, meterNo, reading, prevRead, amount });

  const clause = Clause.callFunction(
    Address.of(CONTRACTS.X2EarnRewardsPool),
    new ABIFunction(DISTRIBUTE_ABI),
    [APP_ID, amountWei, receiver, proof]
  );

  // sendTransaction estimates gas, builds, signs and broadcasts; resolves to txid.
  // With DELEGATION_URL set, the gas is paid by the sponsor at that URL (VIP-191).
  const txid = await signer.sendTransaction({
    clauses: [{ to: clause.to, value: "0x0", data: clause.data }],
    comment: `Green Utility Log — ${utility} reward (${amount} B3TR)`,
    ...(DELEGATION_URL ? { delegationUrl: DELEGATION_URL } : {}),
  });

  return txid;
}
