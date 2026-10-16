// ── Device recognition — one phone, many wallets ─────────────────────────────
// A wallet costs nothing to make, and VeWorld switches between wallets in one
// tap. So the cheapest way to farm is one phone with a handful of wallets. The
// app sends two things with each request (see deviceInfo in src/App.jsx):
//
//   id  a random install id the app keeps in its own storage. Every wallet used
//       in that app on that phone sends the same one. Strong signal: refused
//       past DEVICE_MAX_WALLETS.
//   fp  a hash of what the browser reports about the hardware (screen, GPU,
//       canvas, timezone…). Phones of the same model and OS can produce the
//       same value, so it only ever FLAGS, past DEVICE_FP_FLAG wallets.
//
// Only hashes reach the state: the install id is hashed again here, and the
// fingerprint is a hash already. Neither can be turned back into the device.
// Both come from the client and can be forged or left out — this raises the
// cost of farming, it doesn't make it impossible, and a request without them
// is refused (REQUIRE_DEVICE) — automatic readers send none and never pass here.

import { createHash } from "node:crypto";

// One wallet per phone. 0 switches the check off; a higher number leaves room
// for, say, a household that shares one phone.
export const DEVICE_MAX_WALLETS = Number(process.env.DEVICE_MAX_WALLETS || 1);
export const DEVICE_FP_FLAG = Number(process.env.DEVICE_FP_FLAG || 4);
// The app always sends an install id; a payout without one is refused, or leaving
// the field out would be all it took to get past the one-phone rule.
export const REQUIRE_DEVICE = !/^(0|false|off|no)$/i.test(String(process.env.REQUIRE_DEVICE || "true"));

const short = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

// → { install, fp } store keys, each null when absent or malformed.
export function deviceKeys(d) {
  const id = typeof d?.id === "string" && /^[0-9a-f]{32}$/.test(d.id) ? d.id : null;
  const fp = typeof d?.fp === "string" && /^[0-9a-f]{64}$/.test(d.fp) ? d.fp : null;
  return { install: id ? `i:${short(id)}` : null, fp: fp ? `f:${fp.slice(0, 32)}` : null };
}
