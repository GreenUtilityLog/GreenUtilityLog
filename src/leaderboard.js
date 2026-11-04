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
// The newest block when a read starts. Pages are fetched newest-first by offset, so
// a payout landing between two pages shifted every later offset by one and the same
// event came back on the next page: counted twice. Reading up to a fixed block
// keeps the offsets still while paging.
async function bestBlockNumber(node, signal) {
  const res = await fetch(`${node}/blocks/best`, { signal });
  if (!res.ok) throw new Error(`blocks/best responded ${res.status}`);
  const b = await res.json();
  const n = Number(b?.number);
  if (!Number.isFinite(n)) throw new Error("blocks/best gave no block number");
  return n;
}

// The leaderboard is read on Home, on Progress and in admin, and each read is up to
// 40 requests to the node. One read serves them all for LEADERBOARD_TTL_MS.
const LEADERBOARD_TTL_MS = 2 * 60 * 1000;
const leaderboardCache = new Map(); // key -> { at, promise }

export function fetchOnChainLeaderboard({ node, contract, appId, max = 10000, signal } = {}) {
  const key = `${node}|${contract}|${appId}|${max}`;
  const hit = leaderboardCache.get(key);
  if (!hit || Date.now() - hit.at > LEADERBOARD_TTL_MS) {
    const promise = readLeaderboard({ node, contract, appId, max });
    leaderboardCache.set(key, { at: Date.now(), promise });
    // A failed read isn't kept: the next screen asks again.
    promise.then((r) => { if (!r.ok) leaderboardCache.delete(key); }, () => leaderboardCache.delete(key));
  }
  const shared = leaderboardCache.get(key).promise;
  // The read is shared, so a caller that goes away (signal) stops waiting for it
  // rather than cancelling it for the others.
  if (!signal) return shared;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    shared.then(resolve, reject);
  });
}

async function readLeaderboard({ node, contract, appId, max }) {
  if (!node || !contract) return { ok: false, reason: "misconfigured", rows: [] };
  // An all-zero appId means the app isn't registered on VeBetterDAO yet, so
  // there is no real field to read — let the caller fall back to sample data.
  if (isUnsetAppId(appId)) return { ok: false, reason: "unset_appid", rows: [] };

  const totals = new Map(); // receiver -> { wei: BigInt, count, last }
  const pageSize = 256;
  let offset = 0;
  let truncated = false;
  const to = await bestBlockNumber(node);

  for (let fetched = 0; ; ) {
    const body = {
      range: { unit: "block", from: 0, to },
      options: { offset, limit: pageSize },
      criteriaSet: [{ address: contract, topic0: REWARD_TOPIC, topic1: appId }],
      // Newest first: if the event count ever exceeds `max`, the cap must drop the
      // OLDEST events, not the newest — with "asc" a recent participant would simply
      // never appear in the list once the app passes the cap.
      order: "desc",
    };
    const res = await fetch(`${node}/logs/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  const to = await bestBlockNumber(node, signal);
  for (let fetched = 0; fetched < max; ) {
    const body = {
      range: { unit: "block", from: 0, to },
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
        // "photo" | "push" | "reader" | "powerfox" | "tibber" (older payouts: "enode"). Absent on payouts made before this
        // was recorded, which is why the UI treats "" as unknown rather than photo.
        source:    typeof p.source === "string" ? p.source : "",
        cur:       p.reading ?? "",
        prev:      p.prevRead ?? "",
        b3tr:      typeof p.b3tr === "number" ? p.b3tr : Number(amount / 10n ** 14n) / 1e4,
        date:      dateStr,
        status:    "confirmed",
        txHash:    log.meta?.txID || "",
        submittedAt: ts || Date.now(),
        // The saving the payout was made on, and its span, as written on chain
        // (payouts from before these were recorded have neither).
        ...(typeof p.savedKwh === "number" && Number.isFinite(p.savedKwh) ? { savedKwh: p.savedKwh } : {}),
        ...(typeof p.days === "number" && p.days > 0 ? { days: p.days } : {}),
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

// ── A wallet's actual B3TR balance ───────────────────────────────────────────
// What the wallet holds right now (all apps, minus anything spent) — distinct from
// "earned here", which is summed from this app's payout history.
const BALANCE_OF_FN = { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] };

export async function fetchTokenBalance({ node, token, address, signal } = {}) {
  if (!node || !token || !/^0x[0-9a-fA-F]{40}$/.test(address || "")) return null;
  try {
    const out = await callView(node, token, BALANCE_OF_FN, [address], signal);
    if (out == null) return null;
    const v = Array.isArray(out) ? out[0] : (typeof out === "object" ? Object.values(out)[0] : out);
    return Number(BigInt(v) / 10n ** 14n) / 1e4;
  } catch {
    return null;
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
// Emergency stop (X2EarnRewardsPool v7+): while paused every payout reverts.
// Older pools lack the function; the call then reverts and reads as null ("unknown").
const IS_DISTRIBUTION_PAUSED_FN = { name: "isDistributionPaused", type: "function", stateMutability: "view", inputs: [{ name: "appId", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] };
const firstVal = (v) => (Array.isArray(v) ? v[0] : (v && typeof v === "object" ? Object.values(v)[0] : v));

export async function fetchDiagnostics({ node, poolContract, appsContract, appId, distributor, signal } = {}) {
  const out = { poolB3TR: null, distributorAuthorized: null, distributorVTHO: null, payoutCount: null, lastPayoutAt: null, rewardsPoolEnabled: null, rewardsPoolB3TR: null, appAdmin: null, distributionPaused: null };
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
  try {
    const p = firstVal(await callView(node, poolContract, IS_DISTRIBUTION_PAUSED_FN, [appId], signal));
    if (p != null) out.distributionPaused = p === true;
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

// ── VeBetterDAO Galaxy Member (GM) NFT ────────────────────────────────────────
// The NFT a wallet holds in VeBetterDAO's GalaxyMember contract. A wallet chooses
// one of its GM NFTs as its "selected" one (getSelectedTokenId), and that one's
// level counts in VeBetterDAO; a wallet with one but none selected shows its first.
// The picture comes from the token's metadata on IPFS, through VeChain's gateway.
// Function names and the contract layout as in @vechain/vebetterdao-contracts.
const GM_FN = {
  getSelectedTokenId: { name: "getSelectedTokenId", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  balanceOf: { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  tokenOfOwnerByIndex: { name: "tokenOfOwnerByIndex", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  levelOf: { name: "levelOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  tokenURI: { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  MAX_LEVEL: { name: "MAX_LEVEL", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  // What is still needed for the next level: the contract takes off what was donated
  // already and what an attached node gives for free, and answers 0 at the top level.
  getB3TRtoUpgrade: { name: "getB3TRtoUpgrade", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
};
// Level 1 is Earth; 2 to 10 as in VeBetterDAO's own configuration.
export const GM_LEVEL_NAMES = ["", "Earth", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Galaxy"];
export const IPFS_GATEWAY = "https://api.gateway-proxy.vechain.org/ipfs/";
export const ipfsToHttp = (u) => {
  const s = String(u || "").trim();
  if (s.startsWith("ipfs://")) return IPFS_GATEWAY + s.slice(7).replace(/^ipfs\//, "");
  return /^https:\/\//.test(s) ? s : "";
};
const bigOrNull = (v) => { try { return v == null ? null : BigInt(firstVal(v)); } catch { return null; } };

// { tokenId, level, maxLevel, name, image, b3trToUpgrade } for the wallet's GM NFT,
// null when it has none (maxLevel is 0 when it couldn't be read: governance raises it
// over time; b3trToUpgrade, in B3TR, is null when it couldn't be read),
// and { error } when the chain couldn't be read (so the app can tell "none" apart
// from "couldn't check").
export async function fetchGalaxyMember({ node, contract, address, signal } = {}) {
  if (!node || !contract || !/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) return null;
  try {
    let tokenId = bigOrNull(await callView(node, contract, GM_FN.getSelectedTokenId, [address], signal));
    if (!tokenId) {
      const n = bigOrNull(await callView(node, contract, GM_FN.balanceOf, [address], signal));
      if (!n) return null;
      // Here a 0 is a real token id: only "no answer" means none.
      tokenId = bigOrNull(await callView(node, contract, GM_FN.tokenOfOwnerByIndex, [address, 0], signal));
      if (tokenId == null) return null;
    }
    const level = Number(bigOrNull(await callView(node, contract, GM_FN.levelOf, [tokenId], signal)) || 0n);
    const maxLevel = Number(bigOrNull(await callView(node, contract, GM_FN.MAX_LEVEL, [], signal).catch(() => null)) || 0n);
    const upWei = bigOrNull(await callView(node, contract, GM_FN.getB3TRtoUpgrade, [tokenId], signal).catch(() => null));
    const b3trToUpgrade = upWei == null ? null : Number(upWei / 10n ** 14n) / 1e4;
    let image = "";
    try {
      const uri = firstVal(await callView(node, contract, GM_FN.tokenURI, [tokenId], signal));
      const metaUrl = ipfsToHttp(uri);
      if (metaUrl) {
        const r = await fetch(metaUrl, { signal });
        if (r.ok) image = ipfsToHttp((await r.json().catch(() => ({})))?.image);
      }
    } catch { /* no picture: the level still shows */ }
    return { tokenId: tokenId.toString(), level, maxLevel, name: GM_LEVEL_NAMES[level] || "", image, b3trToUpgrade };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    return { error: String(e?.message || e) };
  }
}

