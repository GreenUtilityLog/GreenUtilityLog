// ── On-chain payout via the reward-distributor wallet ────────────────────────
// Signs and broadcasts X2EarnRewardsPool.distributeReward(...) from the wallet
// that holds the reward-distributor role for this app. This is the ONLY place a
// private key is used; keep it server-side and out of source control.

import {
  ThorClient,
  VeChainProvider,
  VeChainPrivateKeySigner,
} from "@vechain/sdk-network";
import { Clause, Address, ABIFunction } from "@vechain/sdk-core";
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

const PK = (process.env.DISTRIBUTOR_PRIVATE_KEY || "").replace(/^0x/, "");
if (!PK) {
  console.warn("[reward] DISTRIBUTOR_PRIVATE_KEY is not set — /reward will fail until it is.");
}

const thor = ThorClient.at(NODE_URL);
const signer = PK ? new VeChainPrivateKeySigner(Buffer.from(PK, "hex"), new VeChainProvider(thor)) : null;

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

  const amountWei = BigInt(Math.round(amount * 1e18)).toString();
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
