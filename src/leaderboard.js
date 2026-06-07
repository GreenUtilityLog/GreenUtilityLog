// ────────────────────────────────────────────────────────────────────────────
// ON-CHAIN LEADERBOARD INDEXER
// ────────────────────────────────────────────────────────────────────────────
// Reads the real participant field straight from VeChain. Every reward this app
// hands out is a `distributeReward(appId, amount, receiver, proof)` call on the
// VeBetterDAO X2EarnRewardsPool, which emits a `RewardDistributed` event. We
// query those logs (filtered to our appId), aggregate B3TR per receiver and
// return a ranked board — no backend required, the chain IS the database.
import { ABIEvent } from "@vechain/sdk-core";

// event RewardDistributed(uint256 amount, bytes32 indexed appId,
//                         address indexed receiver, string proof,
//                         address indexed distributor)
const REWARD_EVENT = new ABIEvent({
  name: "RewardDistributed",
  type: "event",
  inputs: [
    { name: "amount",      type: "uint256", indexed: false },
    { name: "appId",       type: "bytes32", indexed: true  },
    { name: "receiver",    type: "address", indexed: true  },
    { name: "proof",       type: "string",  indexed: false },
    { name: "distributor", type: "address", indexed: true  },
  ],
});

// topic0 — the event signature hash used to filter logs.
export const REWARD_TOPIC = REWARD_EVENT.signatureHash;

const isUnsetAppId = (appId) => !appId || /^0x0+$/i.test(appId);

// Fetch and aggregate the on-chain reward field for one app.
// Returns { ok, reason?, rows:[{ addr, b3tr, count, last }] } sorted desc by B3TR.
export async function fetchOnChainLeaderboard({ node, contract, appId, max = 2000, signal } = {}) {
  if (!node || !contract) return { ok: false, reason: "misconfigured", rows: [] };
  // An all-zero appId means the app isn't registered on VeBetterDAO yet, so
  // there is no real field to read — let the caller fall back to sample data.
  if (isUnsetAppId(appId)) return { ok: false, reason: "unset_appid", rows: [] };

  const totals = new Map(); // receiver -> { wei: BigInt, count, last }
  const pageSize = 256;
  let offset = 0;

  for (let fetched = 0; fetched < max; ) {
    const body = {
      options: { offset, limit: pageSize },
      criteriaSet: [{ address: contract, topic0: REWARD_TOPIC, topic1: appId }],
      order: "asc",
    };
    const res = await fetch(`${node}/logs/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`logs/event responded ${res.status}`);
    const logs = await res.json();
    if (!Array.isArray(logs) || logs.length === 0) break;

    for (const log of logs) {
      // receiver is the 3rd topic (indexed); amount is the first 32-byte word of
      // data (proof, being dynamic, follows as an offset).
      const receiver = ("0x" + log.topics[2].slice(-40)).toLowerCase();
      let wei = 0n;
      try { wei = BigInt(log.data.slice(0, 66)); } catch { wei = 0n; }
      const cur = totals.get(receiver) || { wei: 0n, count: 0, last: 0 };
      cur.wei  += wei;
      cur.count += 1;
      cur.last  = Math.max(cur.last, log.meta?.blockTimestamp || 0);
      totals.set(receiver, cur);
    }

    offset   += logs.length;
    fetched  += logs.length;
    if (logs.length < pageSize) break; // last page
  }

  const rows = [...totals.entries()]
    .map(([addr, v]) => ({
      addr,
      b3tr:  Number(v.wei / 10n ** 14n) / 1e4, // wei -> B3TR, 4-decimal safe
      count: v.count,
      last:  v.last,
    }))
    .sort((a, b) => b.b3tr - a.b3tr);

  return { ok: true, rows };
}
