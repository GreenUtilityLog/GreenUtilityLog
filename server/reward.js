// ── On-chain payout via the reward-distributor wallet ────────────────────────
// Signs and broadcasts X2EarnRewardsPool.distributeReward(...) from the wallet
// that holds the reward-distributor role for this app. This is the ONLY place a
// private key is used; keep it server-side and out of source control.

import {
  ThorClient,
  VeChainProvider,
  VeChainPrivateKeySigner,
} from "@vechain/sdk-network";
import { Clause, Address, ABIFunction, Mnemonic } from "@vechain/sdk-core";
import { NODE_URL, CONTRACTS, APP_ID, APP_VERSION } from "./config.js";

const DISTRIBUTE_ABI = {
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
// the key — we derive the standard VeChain account key (m/44'/818'/0'/0/0) from it.
// Either value stays server-side and is never logged.
function loadKeyBytes() {
  const pkHex = (process.env.DISTRIBUTOR_PRIVATE_KEY || "").trim().replace(/^0x/, "");
  if (pkHex) return Buffer.from(pkHex, "hex");

  const phrase = (process.env.DISTRIBUTOR_MNEMONIC || "").trim();
  if (phrase) return Buffer.from(Mnemonic.toPrivateKey(phrase.split(/\s+/)));

  return null;
}

const keyBytes = loadKeyBytes();
if (!keyBytes) {
  console.warn("[reward] No distributor key set — set DISTRIBUTOR_PRIVATE_KEY or DISTRIBUTOR_MNEMONIC; /reward will fail until you do.");
}

const thor = ThorClient.at(NODE_URL);
const signer = keyBytes ? new VeChainPrivateKeySigner(keyBytes, new VeChainProvider(thor)) : null;

export async function distributorAddress() {
  return signer ? signer.getAddress() : null;
}

// Build the VeBetterDAO proof blob — same shape the frontend writes, so the
// on-chain history/indexer decode it identically.
function buildProof({ utility, meterNo, reading, prevRead, amount }) {
  return JSON.stringify({
    appId:     APP_ID,
    action:    "meter_reading",
    utility,
    meterNo:   meterNo || "",
    reading:   String(reading),
    prevRead:  String(prevRead),
    b3tr:      amount,
    timestamp: new Date().toISOString(),
    version:   APP_VERSION,
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
  const txid = await signer.sendTransaction({
    clauses: [{ to: clause.to, value: "0x0", data: clause.data }],
    comment: `Green Utility Log — ${utility} reward (${amount} B3TR)`,
  });

  return txid;
}
