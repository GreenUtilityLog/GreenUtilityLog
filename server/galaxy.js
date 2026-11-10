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
