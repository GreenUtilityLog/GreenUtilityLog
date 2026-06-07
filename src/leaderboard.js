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

// ── Browser-safe ABI decode of the RewardDistributed data area ──────────────
// data layout: [ amount(uint256) , offset(string) , … , len , utf8 bytes … ]
function hexToBytes(h){ h = h.replace(/^0x/, ""); const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }
export function decodeRewardData(data){
  const hex = (data || "").replace(/^0x/, "");
  const word = (i) => hex.slice(i * 64, i * 64 + 64);
  let amount = 0n; try { amount = BigInt("0x" + (word(0) || "0")); } catch {}
  let proof = "";
  try {
    const off = Number(BigInt("0x" + word(1))) / 32; // word index of the length
    const len = Number(BigInt("0x" + word(off)));
    const strHex = hex.slice((off + 1) * 64, (off + 1) * 64 + len * 2);
    proof = new TextDecoder().decode(hexToBytes(strHex));
  } catch {}
  return { amount, proof };
}

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

// Reconstruct one wallet's full submission history straight from chain by
// decoding the proof JSON we wrote into each RewardDistributed event. This lets
// the app restore a user's earnings, history and streak on any device — the
// chain is the source of truth, no local storage or backend needed.
export async function fetchWalletHistory({ node, contract, appId, address, max = 1000, signal } = {}) {
  if (!node || !contract || !address || isUnsetAppId(appId)) return { ok: false, reason: "unavailable", rows: [] };
  const topic2 = "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const pageSize = 256;
  let offset = 0;
  const rows = [];

  for (let fetched = 0; fetched < max; ) {
    const body = {
      options: { offset, limit: pageSize },
      criteriaSet: [{ address: contract, topic0: REWARD_TOPIC, topic1: appId, topic2 }],
      order: "desc",
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
      const { amount, proof } = decodeRewardData(log.data);
      let p = {}; try { p = JSON.parse(proof) || {}; } catch {}
      const ts = (log.meta?.blockTimestamp || 0) * 1000;
      const d = ts ? new Date(ts) : null;
      const dateStr = d
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        : (typeof p.timestamp === "string" ? p.timestamp.slice(0, 10) : "");
      rows.push({
        id:        log.meta?.txID ? `${log.meta.txID}-${log.meta.clauseIndex ?? 0}` : `${log.meta?.blockNumber || 0}-${rows.length}`,
        type:      p.utility || "electric",
        meterNo:   p.meterNo || "",
        cur:       p.reading ?? "",
        prev:      p.prevRead ?? "",
        b3tr:      typeof p.b3tr === "number" ? p.b3tr : Number(amount / 10n ** 14n) / 1e4,
        date:      dateStr,
        status:    "confirmed",
        txHash:    log.meta?.txID || "",
        submittedAt: ts || Date.now(),
      });
    }

    offset  += logs.length;
    fetched += logs.length;
    if (logs.length < pageSize) break;
  }

  rows.sort((a, b) => b.submittedAt - a.submittedAt); // newest first
  return { ok: true, rows };
}
