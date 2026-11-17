// ── VeBetterDAO Galaxy Member (GM) NFT ────────────────────────────────────────
// Does a wallet hold a GM NFT? Any level counts (level 1, Earth, included). Used for
// the "gm" access mode: on mainnet only GM holders who are also a person in the
// VeBetterDAO Passport may use the app.
//
// The answer is cached: a holder for 10 minutes, a non-holder for 30 seconds (they
// may have just minted one and pressed "Check again"). A read that failed is null and not cached, so a node hiccup
// never locks someone out for long, and never lets anyone in.

import { CONTRACTS } from "./config.js";
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
// Which GM NFT: VoterRewards takes the one selected when the vote is cast
// (getSelectedTokenId at that moment); the rule above names the one selected at
// the round's start (getSelectedTokenIdAtBlock). Both are tried, so switching NFTs
// mid-round neither shuts someone out nor lets an unvoted NFT through.
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

let roundCache = null; // { at, prev, start }
async function lastRound() {
  if (roundCache && Date.now() - roundCache.at < 10 * 60 * 1000) return roundCache;
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
  const hit = memberCache.get(w);
  if (hit && Date.now() - hit.at < (hit.pass ? HOLDER_TTL : NON_HOLDER_TTL)) return hit.v;
  const P = CONTRACTS.VeBetterPassport, X = CONTRACTS.XAllocationVoting, G = CONTRACTS.GalaxyMember, R = CONTRACTS.VoterRewards;

  const [entity, signals, round] = await Promise.all([read(P, MEMBER_ABI.isEntity, [w]), read(P, MEMBER_ABI.signaledCounter, [w]), lastRound()]);
  const main = entity === undefined ? null : entity !== true;
  const clean = signals === undefined ? null : BigInt(signals) === 0n;

  let voted = null, gm = null, level = null;
  if (round && round.prev == null) { voted = false; gm = false; }      // no round before this one
  else if (round) {
    const has = await read(X, MEMBER_ABI.hasVoted, [round.prev, w]);
    voted = has === undefined ? null : has === true;
    if (voted === false) gm = false;
    else if (voted === true) {
      const [atStart, now] = await Promise.all([
        read(G, MEMBER_ABI.getSelectedTokenIdAtBlock, [w, round.start]),
        read(G, MEMBER_ABI.getSelectedTokenId, [w]),
      ]);
      const ids = [...new Set([atStart, now].filter((x) => x !== undefined && BigInt(x) > 0n).map((x) => BigInt(x)))];
      if (!ids.length) gm = atStart === undefined || now === undefined ? null : false;
      else {
        let unread = false;
        gm = false;
        for (const id of ids) {
          const [didVote, owner, lvl] = await Promise.all([
            read(R, MEMBER_ABI.hasTokenVoted, [id, round.start]),
            read(G, MEMBER_ABI.ownerOf, [id]),
            read(G, MEMBER_ABI.levelOf, [id]),
          ]);
          if (didVote === undefined || lvl === undefined) { unread = true; continue; }
          // ownerOf reverts for a burned token: undefined is then "not W's".
          const mine = String(owner || "").toLowerCase() === w;
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
    memberCache.set(w, { v: out, at: Date.now(), pass: main && clean && voted && gm });
    if (memberCache.size > 5000) memberCache.delete(memberCache.keys().next().value);
  }
  return out;
}
