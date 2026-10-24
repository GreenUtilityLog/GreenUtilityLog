// ── Is this a real person's wallet? ──────────────────────────────────────────
// Bot farms on x2earn apps share a pattern: wallets made the same day, with no
// history of their own, all topped up from one source wallet, and often already
// signalled to VeBetterDAO by other apps. None of that proves anything about one
// wallet on its own — a newcomer's VeWorld wallet is new and empty too, and an
// exchange funds thousands of honest users — so this RECORDS what it finds for an
// admin to judge, and only in WALLET_CHECK=base mode lets it hold the payout to the
// base amount. Run once per wallet, at its first payout, and remembered for a week.
//
// What is read, all public, no key needed:
//   • the wallet's first VET transfer in and first VTHO transfer in (who funded it,
//     and when it first appeared);
//   • how much it has done: transfers and token events it sent (capped);
//   • VeBetterPassport: person or not, signals by apps, blacklisted.

import { NODE_URL } from "./config.js";
import { passportFor } from "./passport.js";

const VTHO = "0x0000000000000000000000000000456e65726779";
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (addr) => "0x" + "0".repeat(24) + String(addr).toLowerCase().replace(/^0x/, "");
const ACTIVITY_CAP = 50;

async function logs(kind, criteria, { order = "asc", limit = 1 } = {}) {
  const res = await fetch(`${NODE_URL.replace(/\/$/, "")}/logs/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ range: null, options: { offset: 0, limit }, criteriaSet: [criteria], order }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`logs/${kind} ${res.status}`);
  const out = await res.json();
  return Array.isArray(out) ? out : [];
}

// → { at, firstSeen, ageDays, activity, funder, passport, error? }. Never throws:
// a node that can't be read gives what could be read, with `error` set.
export async function inspectWallet(address) {
  const a = String(address || "").toLowerCase();
  const out = { at: Date.now(), firstSeen: null, ageDays: null, activity: null, funder: null, passport: null };
  try {
    const [vetIn, vthoIn, vetOut, tokenOut] = await Promise.all([
      logs("transfer", { recipient: a }),
      logs("event", { address: VTHO, topic0: TRANSFER_TOPIC, topic2: pad(a) }),
      logs("transfer", { sender: a }, { limit: ACTIVITY_CAP }),
      logs("event", { topic0: TRANSFER_TOPIC, topic1: pad(a) }, { limit: ACTIVITY_CAP }),
    ]);
    const firsts = [
      vetIn[0] && { t: vetIn[0].meta?.blockTimestamp, from: vetIn[0].sender },
      vthoIn[0] && { t: vthoIn[0].meta?.blockTimestamp, from: "0x" + String(vthoIn[0].topics?.[1] || "").slice(-40) },
    ].filter((x) => x && Number.isFinite(Number(x.t)));
    firsts.sort((x, y) => x.t - y.t);
    const outT = [vetOut[0]?.meta?.blockTimestamp, tokenOut[0]?.meta?.blockTimestamp].map(Number).filter(Number.isFinite);
    const earliest = Math.min(...[...firsts.map((x) => Number(x.t)), ...outT]);
    if (Number.isFinite(earliest)) {
      out.firstSeen = earliest * 1000;
      out.ageDays = +((Date.now() - out.firstSeen) / 86400000).toFixed(1);
    }
    out.activity = Math.min(ACTIVITY_CAP, vetOut.length + tokenOut.length);
    const f = firsts[0]?.from;
    if (f && /^0x[0-9a-f]{40}$/i.test(f) && !/^0x0{40}$/i.test(f)) out.funder = f.toLowerCase();
  } catch (e) {
    out.error = String(e?.message || e);
  }
  try {
    const p = (await passportFor([a]))[a];
    if (p) out.passport = { isPerson: p.isPerson, reason: p.reason || "", signals: p.signals, blacklisted: p.blacklisted };
  } catch { /* passport unreadable: left null */ }
  return out;
}

// What an admin should see about a check, and whether it is suspicious enough for
// WALLET_CHECK=base. `sameFunder` = other wallets here funded by the same source.
export function judgeWallet(check, sameFunder = 0, funderFlagAt = 3) {
  const reasons = [];
  let suspicious = false;
  const p = check?.passport;
  if (p?.blacklisted) { reasons.push("blacklisted by VeBetterDAO"); suspicious = true; }
  if (Number(p?.signals) > 0) { reasons.push(`signalled ${p.signals}x by VeBetterDAO apps`); suspicious = true; }
  if (check?.funder && sameFunder + 1 >= funderFlagAt) {
    reasons.push(`funded by ${check.funder.slice(0, 6)}…${check.funder.slice(-4)}, like ${sameFunder} other wallet${sameFunder === 1 ? "" : "s"} here`);
    suspicious = true;
  }
  if (check && check.firstSeen == null && check.activity === 0 && !check.error) {
    reasons.push(`new wallet, no history on chain${p && p.isPerson === false ? ", not a person to the VeBetterDAO passport" : ""}`);
  } else if (check?.ageDays != null && check.ageDays < 2) {
    reasons.push(`wallet first seen ${check.ageDays} day(s) ago`);
  }
  return { suspicious, reasons };
}
