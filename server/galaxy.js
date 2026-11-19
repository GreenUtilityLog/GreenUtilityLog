// ── VeBetterDAO Galaxy Member (GM) NFT ────────────────────────────────────────
// Does a wallet hold a GM NFT? Any level counts (level 1, Earth, included). Used for
// the "gm" access mode: on mainnet only GM holders who are also a person in the
// VeBetterDAO Passport may use the app.
//
// The answer is cached: a holder for 10 minutes, a non-holder for 30 seconds (they
// may have just minted one and pressed "Check again"). A read that failed is null and not cached, so a node hiccup
// never locks someone out for long, and never lets anyone in.

import { ABIEvent } from "@vechain/sdk-core";
import { CONTRACTS, NODE_URL } from "./config.js";
import { callView } from "./reward.js";

const BALANCE_OF = {
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }],
};
const HOLDER_TTL = 10 * 60 * 1000;
const NON_HOLDER_TTL = 30 * 1000;
const cache = new Map();

export const galaxyMemberConfigured = () => Boolean(CONTRACTS.GalaxyMember);

// true / false, or null when the chain couldn't be read.
export async function holdsGalaxyMember(address) {
  const a = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a) || !CONTRACTS.GalaxyMember) return false;
  const hit = cache.get(a);
  if (hit && Date.now() - hit.at < (hit.v ? HOLDER_TTL : NON_HOLDER_TTL)) return hit.v;
  let v = null;
  try {
    const out = await callView(CONTRACTS.GalaxyMember, BALANCE_OF, [a]);
    const raw = Array.isArray(out) ? out[0] : (out && typeof out === "object" ? Object.values(out)[0] : out);
    if (raw != null) v = BigInt(raw) > 0n;
  } catch { v = null; }
  if (v == null) return null;
  cache.set(a, { v, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return v;
}

// ── The member check for mainnet (VeBetterDAO's rule, 2026-11-17) ──────────────
// Given by VeBetterDAO (morbidejs) as the safeguard for app rewards, for a wallet W
// in the current round R:
//   1. no signals: VeBetterPassport.signaledCounter(W) == 0;
//   2. voted last round: XAllocationVoting.hasVoted(R − 1, W);
//   3. the GM NFT it voted with: VoterRewards.hasTokenVoted(token, roundStart) —
//      roundStart is roundSnapshot(R − 1), the id VoterRewards files allocation votes
//      under (RoundVotesCountingUtils: registerVote(roundStart, …));
//   4. still W's and at least level 2 (Moon): ownerOf(token) == W, levelOf(token) ≥ 2.
// Plus the owner's rule, one wallet per person: a wallet linked to another
// Passport (an "entity") doesn't earn — the Passport wallet itself does. That also
// covers "a linked account whose main account is signaled".
//
// Which GM NFT: the one selected at the round's start (getSelectedTokenIdAtBlock at
// roundSnapshot), as the rule says — the owner's choice (2026-11-17). Someone who
// switched NFTs during the round and voted with the other one doesn't pass. Its
// level is today's: GalaxyMember keeps no level per block (levelOf only).
//
// Every value is true / false, or null when the chain couldn't be read. The whole
// answer is cached like holdsGalaxyMember's: 10 minutes when it passes, 30 seconds
// when not, never when something couldn't be read.

const v = (name, inputs, outputs) => ({ name, type: "function", stateMutability: "view", inputs, outputs });
const A = (n = "a") => ({ name: n, type: "address" });
const U = (n = "n") => ({ name: n, type: "uint256" });
const B = { name: "", type: "bool" };
export const MEMBER_ABI = {
  isEntity: v("isEntity", [A("user")], [B]),
  signaledCounter: v("signaledCounter", [A("_user")], [U("")]),
  currentRoundId: v("currentRoundId", [], [U("")]),
  roundSnapshot: v("roundSnapshot", [U("roundId")], [U("")]),
  hasVoted: v("hasVoted", [U("roundId"), A("user")], [B]),
  getSelectedTokenId: v("getSelectedTokenId", [A("owner")], [U("")]),
  getSelectedTokenIdAtBlock: v("getSelectedTokenIdAtBlock", [A("owner"), { name: "blockNumber", type: "uint48" }], [U("")]),
  hasTokenVoted: v("hasTokenVoted", [U("tokenId"), U("proposalId")], [B]),
  ownerOf: v("ownerOf", [U("tokenId")], [{ name: "", type: "address" }]),
  levelOf: v("levelOf", [U("tokenId")], [U("")]),
};
export const MIN_GM_LEVEL = 2; // Moon

const one = (out) => (Array.isArray(out) ? out[0] : (out && typeof out === "object" ? Object.values(out)[0] : out));
// A view's single value, or undefined when it couldn't be read (null from callView
// means reverted or empty).
async function read(to, fn, args) {
  try { const out = await callView(to, fn, args); return out == null ? undefined : one(out); } catch { return undefined; }
}
// ownerOf reverts for a burned token: that is "not W's". A node that can't be
// reached is "couldn't read" — told to try again, not refused (and not cached).
const REVERTED = Symbol("reverted");
async function readOwner(to, id) {
  try { const out = await callView(to, MEMBER_ABI.ownerOf, [id]); return out == null ? REVERTED : one(out); } catch { return undefined; }
}

let roundCache = null; // { at, prev, start }
// A minute, so a new round is seen soon after it starts (and the member cache below
// is keyed to the round it was answered for).
async function lastRound() {
  if (roundCache && Date.now() - roundCache.at < 60 * 1000) return roundCache;
  const cur = await read(CONTRACTS.XAllocationVoting, MEMBER_ABI.currentRoundId, []);
  if (cur === undefined) return null;
  const prev = BigInt(cur) - 1n;
  if (prev < 1n) { roundCache = { at: Date.now(), prev: null, start: null }; return roundCache; }
  const start = await read(CONTRACTS.XAllocationVoting, MEMBER_ABI.roundSnapshot, [prev]);
  if (start === undefined) return null;
  roundCache = { at: Date.now(), prev, start: BigInt(start) };
  return roundCache;
}

const memberCache = new Map();
export const memberCheckConfigured = () => Boolean(CONTRACTS.GalaxyMember && CONTRACTS.VoterRewards && CONTRACTS.XAllocationVoting && CONTRACTS.VeBetterPassport);

// → { main, clean, voted, gm } (see above) and `level`: the best level among the
// candidate GM NFTs that voted and are still W's (null when none).
export async function memberCheck(address) {
  const w = String(address || "").toLowerCase();
  const no = { main: false, clean: false, voted: false, gm: false, level: null };
  if (!/^0x[0-9a-f]{40}$/.test(w) || !memberCheckConfigured()) return no;
  const P = CONTRACTS.VeBetterPassport, X = CONTRACTS.XAllocationVoting, G = CONTRACTS.GalaxyMember, R = CONTRACTS.VoterRewards;
  const round = await lastRound();
  // A remembered answer counts only for the round it was given in: at a round
  // change a wallet that voted two rounds ago, not last round, is asked again.
  const hit = memberCache.get(w);
  if (hit && round && hit.round === String(round.prev) && Date.now() - hit.at < (hit.pass ? HOLDER_TTL : NON_HOLDER_TTL)) return hit.v;

  const [entity, signals] = await Promise.all([read(P, MEMBER_ABI.isEntity, [w]), read(P, MEMBER_ABI.signaledCounter, [w])]);
  const main = entity === undefined ? null : entity !== true;
  const clean = signals === undefined ? null : BigInt(signals) === 0n;

  let voted = null, gm = null, level = null;
  if (round && round.prev == null) { voted = false; gm = false; }      // no round before this one
  else if (round) {
    const has = await read(X, MEMBER_ABI.hasVoted, [round.prev, w]);
    voted = has === undefined ? null : has === true;
    if (voted === false) gm = false;
    else if (voted === true) {
      const atStart = await read(G, MEMBER_ABI.getSelectedTokenIdAtBlock, [w, round.start]);
      const ids = atStart !== undefined && BigInt(atStart) > 0n ? [BigInt(atStart)] : [];
      if (!ids.length) gm = atStart === undefined ? null : false;
      else {
        let unread = false;
        gm = false;
        for (const id of ids) {
          const [didVote, owner, lvl] = await Promise.all([
            read(R, MEMBER_ABI.hasTokenVoted, [id, round.start]),
            readOwner(G, id),
            read(G, MEMBER_ABI.levelOf, [id]),
          ]);
          if (didVote === undefined || lvl === undefined || owner === undefined) { unread = true; continue; }
          const mine = owner !== REVERTED && String(owner || "").toLowerCase() === w;
          if (didVote === true && mine) {
            level = Math.max(level ?? 0, Number(lvl));
            if (Number(lvl) >= MIN_GM_LEVEL) gm = true;
          }
        }
        if (!gm && unread) gm = null;
      }
    }
  }
  const out = { main, clean, voted, gm, level };
  const known = [main, clean, voted, gm].every((x) => x !== null);
  if (known) {
    memberCache.set(w, { v: out, at: Date.now(), pass: main && clean && voted && gm, round: round ? String(round.prev) : null });
    if (memberCache.size > 5000) memberCache.delete(memberCache.keys().next().value);
  }
  return out;
}

// ── Signals reset by the VeBetterDAO Foundation after KYC ─────────────────────
// A wallet that was signaled and then proved who it is (KYC) has its signals reset
// by the Foundation: VeBetterPassport.resetUserSignalsWithReason, sent by the
// Foundation wallet with the reason below (as VeBetterDAO's morbidejs described,
// 2026-11-18; example tx 0x671bef27…7abe7). It has 0 signals after that, so it passes
// the member check. The owner's choice: let it earn, but show it to the admin.
//
// The event (UserSignalsReset(address indexed user, string reason)) doesn't name
// who reset; the transaction does (meta.txOrigin in the node's log answer).
// → { reset: true, at, txid } / { reset: false }, or null when the logs couldn't
// be read. A "yes" is kept for a day, a "no" for an hour.


export const KYC_RESETTER = "0x12a7f82621d518aed6bbadc7f9d6d2814934b259";
export const KYC_REASON = "Resetting signal counter for KYC'ed wallet";
const RESET_EVENT = new ABIEvent({
  type: "event", name: "UserSignalsReset", anonymous: false,
  inputs: [{ name: "user", type: "address", indexed: true }, { name: "reason", type: "string", indexed: false }],
});
const kycCache = new Map();

export async function kycSignalReset(address) {
  const w = String(address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w) || !CONTRACTS.VeBetterPassport) return { reset: false };
  const hit = kycCache.get(w);
  if (hit && Date.now() - hit.at < (hit.v.reset ? 86400000 : 3600000)) return hit.v;
  let logs;
  try {
    const res = await fetch(`${NODE_URL}/logs/event`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        criteriaSet: [{ address: CONTRACTS.VeBetterPassport, topic0: RESET_EVENT.signatureHash, topic1: "0x" + w.slice(2).padStart(64, "0") }],
        options: { offset: 0, limit: 100 }, order: "desc",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    logs = await res.json();
    if (!Array.isArray(logs)) return null;
  } catch { return null; }
  let v = { reset: false };
  for (const log of logs) {
    if (String(log?.meta?.txOrigin || "").toLowerCase() !== KYC_RESETTER) continue;
    let reason = "";
    try { reason = String(RESET_EVENT.decodeEventLog({ topics: log.topics, data: log.data }).args?.reason ?? ""); } catch { continue; }
    if (reason !== KYC_REASON) continue;
    v = { reset: true, at: (Number(log.meta.blockTimestamp) || 0) * 1000 || null, txid: log.meta.txID || null };
    break;
  }
  kycCache.set(w, { v, at: Date.now() });
  if (kycCache.size > 5000) kycCache.delete(kycCache.keys().next().value);
  return v;
}
