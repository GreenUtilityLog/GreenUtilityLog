// ────────────────────────────────────────────────────────────────────────────
// ON-CHAIN LEADERBOARD INDEXER
// ────────────────────────────────────────────────────────────────────────────
// Reads the real participant field straight from VeChain. Every reward this app
// hands out is a `distributeReward(appId, amount, receiver, proof)` call on the
// VeBetterDAO X2EarnRewardsPool, which emits a `RewardDistributed` event. We
// query those logs (filtered to our appId), aggregate B3TR per receiver and
// return a ranked board — no backend required, the chain IS the database.
import { ABIEvent, ABIFunction } from "@vechain/sdk-core";

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

// event RewardMetadata(uint256 amount, bytes32 indexed appId,
//                      address indexed receiver, string metadata,
//                      address indexed distributor)
// Emitted alongside RewardDistributed when the backend pays via
// distributeRewardWithProofAndMetadata: the proof (built on-chain in the
// standard VeBetter shape wallets recognise) no longer carries our app fields —
// those travel here. Same data layout as RewardDistributed, so decodeRewardData
// works for both.
const METADATA_EVENT = new ABIEvent({
  name: "RewardMetadata",
  type: "event",
  inputs: [
    { name: "amount",      type: "uint256", indexed: false },
    { name: "appId",       type: "bytes32", indexed: true  },
    { name: "receiver",    type: "address", indexed: true  },
    { name: "metadata",    type: "string",  indexed: false },
    { name: "distributor", type: "address", indexed: true  },
  ],
});
export const METADATA_TOPIC = METADATA_EVENT.signatureHash;

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
  let truncated = false;

  for (let fetched = 0; ; ) {
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
    if (logs.length < pageSize) break;              // last page
    if (fetched >= max) { truncated = true; break; } // hit the cap — more may exist
  }

  const rows = [...totals.entries()]
    .map(([addr, v]) => ({
      addr,
      b3tr:  Number(v.wei / 10n ** 14n) / 1e4, // wei -> B3TR, 4-decimal safe
      count: v.count,
      last:  v.last,
    }))
    .sort((a, b) => b.b3tr - a.b3tr);

  return { ok: true, rows, truncated };
}

// Reconstruct one wallet's full submission history straight from chain by
// decoding the proof JSON we wrote into each RewardDistributed event. This lets
// the app restore a user's earnings, history and streak on any device — the
// chain is the source of truth, no local storage or backend needed.
async function fetchLogsPaged({ node, contract, topic0, appId, topic2, max, signal, onLog }) {
  const pageSize = 256;
  let offset = 0;
  for (let fetched = 0; fetched < max; ) {
    const body = {
      options: { offset, limit: pageSize },
      criteriaSet: [{ address: contract, topic0, topic1: appId, topic2 }],
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
    for (const log of logs) onLog(log);
    offset  += logs.length;
    fetched += logs.length;
    if (logs.length < pageSize) break;
  }
}

export async function fetchWalletHistory({ node, contract, appId, address, max = 1000, signal } = {}) {
  if (!node || !contract || !address || isUnsetAppId(appId)) return { ok: false, reason: "unavailable", rows: [] };
  const topic2 = "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const rows = [];

  // App-specific fields per payout (RewardMetadata), keyed by tx+clause so they
  // can be merged into the matching RewardDistributed row. Best-effort: rewards
  // paid via the old proof-only path simply have no metadata entry.
  const metaByKey = new Map();
  await fetchLogsPaged({
    node, contract, topic0: METADATA_TOPIC, appId, topic2, max, signal,
    onLog: (log) => {
      const { proof } = decodeRewardData(log.data); // same layout: string field
      try {
        const m = JSON.parse(proof);
        if (m && typeof m === "object") metaByKey.set(`${log.meta?.txID}-${log.meta?.clauseIndex ?? 0}`, m);
      } catch {}
    },
  }).catch(() => {});

  await fetchLogsPaged({
    node, contract, topic0: REWARD_TOPIC, appId, topic2, max, signal,
    onLog: (log) => {
      const { amount, proof } = decodeRewardData(log.data);
      let p = {}; try { p = JSON.parse(proof) || {}; } catch {}
      // New-style payouts: standard on-chain proof + our fields in metadata.
      const meta = metaByKey.get(`${log.meta?.txID}-${log.meta?.clauseIndex ?? 0}`);
      if (meta) p = { ...p, ...meta };
      const ts = (log.meta?.blockTimestamp || 0) * 1000;
      const d = ts ? new Date(ts) : null;
      const dateStr = d
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        : (typeof p.timestamp === "string" ? p.timestamp.slice(0, 10) : "");
      rows.push({
        id:        log.meta?.txID ? `${log.meta.txID}-${log.meta.clauseIndex ?? 0}` : `${log.meta?.blockNumber || 0}-${rows.length}`,
        type:      p.utility || "electric",
        appliance: p.appliance || "",
        meterNo:   p.meterNo || "",
        cur:       p.reading ?? "",
        prev:      p.prevRead ?? "",
        b3tr:      typeof p.b3tr === "number" ? p.b3tr : Number(amount / 10n ** 14n) / 1e4,
        date:      dateStr,
        status:    "confirmed",
        txHash:    log.meta?.txID || "",
        submittedAt: ts || Date.now(),
      });
    },
  });

  rows.sort((a, b) => b.submittedAt - a.submittedAt); // newest first
  return { ok: true, rows };
}

// ── On-chain admin check (VeBetterDAO X2EarnApps) ────────────────────────────
// Auto-detects whether a wallet is the app's admin or a moderator, so admin
// access doesn't depend on a hardcoded list. Read-only call to the X2EarnApps
// contract; returns false on any error so it degrades gracefully.
const X2EARN_APPS_FN = {
  appAdmin:       { name: "appAdmin", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  isAppModerator: { name: "isAppModerator", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }, { name: "moderator", type: "address" }], outputs: [{ name: "", type: "bool" }] },
};

async function callView(node, to, fragment, args, signal) {
  const abi = new ABIFunction(fragment);
  const data = abi.encodeData(args).toString();
  const res = await fetch(`${node}/accounts/${to}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data, value: "0x0" }),
    signal,
  });
  if (!res.ok) throw new Error(`accounts call ${res.status}`);
  const out = await res.json();
  if (!out || out.reverted || !out.data || out.data === "0x") return null;
  return abi.decodeResult(out.data);
}

// ── Rewards-pool balance (VeBetterDAO X2EarnRewardsPool) ─────────────────────
// How much B3TR this app currently has available to pay out. This is the pot the
// distributor draws from — when it's empty, distributeReward reverts. Read-only.
const POOL_FN = {
  availableFunds: { name: "availableFunds", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] },
};

export async function fetchPoolBalance({ node, contract, appId, signal } = {}) {
  if (!node || !contract || isUnsetAppId(appId)) return { ok: false, b3tr: 0 };
  try {
    const out = await callView(node, contract, POOL_FN.availableFunds, [appId], signal);
    if (out == null) return { ok: false, b3tr: 0 };
    const v = Array.isArray(out) ? out[0] : (typeof out === "object" ? Object.values(out)[0] : out);
    let wei = 0n; try { wei = BigInt(v); } catch { wei = 0n; }
    return { ok: true, b3tr: Number(wei / 10n ** 14n) / 1e4 }; // wei -> B3TR, 4-decimal safe
  } catch {
    return { ok: false, b3tr: 0 };
  }
}

// ── Full payout self-diagnosis (runs in the ADMIN's browser) ─────────────────
// Checks every classic reason a payout fails, straight from the chain:
//   1. pool funds for this appId          → distributeReward reverts when 0
//   2. distributor has the reward role    → reverts when false
//   3. distributor wallet has VTHO (gas)  → tx can never be sent when 0
//   4. how many payouts ever landed       → ground truth for "nothing shows up"
const IS_DISTRIBUTOR_FN = { name: "isRewardDistributor", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }, { name: "distributor", type: "address" }], outputs: [{ name: "", type: "bool" }] };
// v10 two-bucket model: when the rewards-pool feature is enabled for an app,
// distributeReward pays from rewardsPoolBalance, NOT from availableFunds —
// deposits land in availableFunds and must be moved over by the app admin.
const REWARDS_POOL_ENABLED_FN = { name: "isRewardsPoolEnabled", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] };
const REWARDS_POOL_BALANCE_FN = { name: "rewardsPoolBalance", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] };
const firstVal = (v) => (Array.isArray(v) ? v[0] : (v && typeof v === "object" ? Object.values(v)[0] : v));

export async function fetchDiagnostics({ node, poolContract, appsContract, appId, distributor, signal } = {}) {
  const out = { poolB3TR: null, distributorAuthorized: null, distributorVTHO: null, payoutCount: null, lastPayoutAt: null, rewardsPoolEnabled: null, rewardsPoolB3TR: null, appAdmin: null };
  if (!node || isUnsetAppId(appId)) return out;
  // 0. who is the on-chain APP ADMIN (the only wallet the contract lets manage
  //    the rewards-pool buckets)
  try {
    if (appsContract) {
      const a = firstVal(await callView(node, appsContract, X2EARN_APPS_FN.appAdmin, [appId], signal));
      if (a) out.appAdmin = String(a);
    }
  } catch {}
  // 1. pool funds
  try { const r = await fetchPoolBalance({ node, contract: poolContract, appId, signal }); if (r.ok) out.poolB3TR = r.b3tr; } catch {}
  // 1b. distributable rewards-pool bucket (independent reads — one failing
  // shouldn't blank the other in the System Check)
  try {
    const en = firstVal(await callView(node, poolContract, REWARDS_POOL_ENABLED_FN, [appId], signal));
    if (en != null) out.rewardsPoolEnabled = en === true;
  } catch {}
  try {
    const bal = firstVal(await callView(node, poolContract, REWARDS_POOL_BALANCE_FN, [appId], signal));
    if (bal != null) { let wei = 0n; try { wei = BigInt(bal); } catch {} out.rewardsPoolB3TR = Number(wei / 10n ** 14n) / 1e4; }
  } catch {}
  // 2. distributor role
  try {
    if (distributor && appsContract) {
      const ok = firstVal(await callView(node, appsContract, IS_DISTRIBUTOR_FN, [appId, distributor], signal));
      if (ok != null) out.distributorAuthorized = ok === true;
    }
  } catch {}
  // 3. distributor gas (VTHO = the account's `energy`)
  try {
    if (distributor) {
      const res = await fetch(`${node}/accounts/${distributor}`, { signal });
      if (res.ok) {
        const acc = await res.json();
        let wei = 0n; try { wei = BigInt(acc.energy || "0x0"); } catch {}
        out.distributorVTHO = Number(wei / 10n ** 14n) / 1e4;
      }
    }
  } catch {}
  // 4. payouts ever recorded for this app
  try {
    const res = await fetch(`${node}/logs/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options: { offset: 0, limit: 20 }, criteriaSet: [{ address: poolContract, topic0: REWARD_TOPIC, topic1: appId }], order: "desc" }),
      signal,
    });
    if (res.ok) {
      const logs = await res.json();
      if (Array.isArray(logs)) {
        out.payoutCount = logs.length;
        out.lastPayoutAt = logs[0]?.meta?.blockTimestamp ? logs[0].meta.blockTimestamp * 1000 : null;
      }
    }
  } catch {}
  return out;
}

export async function fetchIsAppAdmin({ node, appsContract, appId, address, signal } = {}) {
  if (!node || !appsContract || !address || isUnsetAppId(appId)) return false;
  const addr = address.toLowerCase();
  try {
    const admin = await callView(node, appsContract, X2EARN_APPS_FN.appAdmin, [appId], signal);
    if (admin && String(admin).toLowerCase() === addr) return true;
  } catch {}
  try {
    const isMod = await callView(node, appsContract, X2EARN_APPS_FN.isAppModerator, [appId, address], signal);
    if (isMod === true || (Array.isArray(isMod) && isMod[0] === true)) return true;
  } catch {}
  return false;
}
