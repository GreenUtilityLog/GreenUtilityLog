// ── Wallet ownership proof (VeChain certificate) ─────────────────────────────
// The /reward body carries a certificate the user signed in their wallet. We
// re-verify the signature here and confirm it was signed by the SAME address the
// payout goes to — so the API can't be tricked into rewarding an address that was
// simply typed into the request. Gasless for the user; the real anti-spoof gate.

import { Certificate } from "@vechain/sdk-core";

// Reject certificates older than this (anti-replay). The wallet's timestamp is in
// seconds on some wallets and ms on others, so we normalise and allow generous skew.
export const CERT_MAX_AGE_MS = Number(process.env.CERT_MAX_AGE_MS || 15 * 60 * 1000);
const MAX_AGE_MS = CERT_MAX_AGE_MS;

// Require a valid certificate by default; set REQUIRE_CERT=false only for local dev.
export const REQUIRE_CERT = String(process.env.REQUIRE_CERT || "true").toLowerCase() !== "false";

// The site a certificate was signed for. The wallet fills this in from the page
// that asked, so a signature someone collected on another site says so here.
// Enforced only when CERT_DOMAINS is set (comma-separated, e.g.
// "greenutilitylog.github.io"): the exact value VeWorld and WalletConnect put here
// has to be seen first, or every real user would be locked out. Until then the
// domains that do arrive are counted and shown on /health, so the list can be
// copied from there.
const CERT_DOMAINS = String(process.env.CERT_DOMAINS || "")
  .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
const seenDomains = new Map();
export function certDomainsSeen() {
  return { enforced: CERT_DOMAINS.length ? CERT_DOMAINS : null, seen: Object.fromEntries(seenDomains) };
}

export function verifyWalletCertificate({ certificate, address }) {
  if (!certificate || typeof certificate !== "object") {
    return { ok: false, error: "wallet signature (certificate) is required" };
  }
  const { purpose, payload, domain, timestamp, signer, signature } = certificate;
  if (!signer || !signature || !payload?.content) {
    return { ok: false, error: "incomplete certificate" };
  }

  // 1) Signature must be cryptographically valid for the certificate contents.
  try {
    Certificate.of({ purpose, payload, domain, timestamp, signer, signature }).verify();
  } catch {
    return { ok: false, error: "certificate signature is invalid" };
  }

  // 1b) Signed for this app (only once CERT_DOMAINS is configured).
  const dom = String(domain || "").trim().toLowerCase();
  if (seenDomains.size < 20 || seenDomains.has(dom)) seenDomains.set(dom, (seenDomains.get(dom) || 0) + 1);
  if (CERT_DOMAINS.length && !CERT_DOMAINS.includes(dom)) {
    return { ok: false, error: "this signature was made for a different site — please sign again in the app" };
  }

  // 2) The signer must be the wallet the reward goes to.
  if (String(signer).toLowerCase() !== String(address).toLowerCase()) {
    return { ok: false, error: "certificate signer does not match the wallet address" };
  }

  // 3) Freshness (lenient: tolerate seconds-vs-ms and clock skew). A missing or
  // non-numeric timestamp must FAIL — otherwise Number(timestamp)=NaN skips the
  // expiry check entirely and a captured certificate replays forever (worst for
  // admin certs). Fail closed instead.
  const tsMs = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isFinite(tsMs)) return { ok: false, error: "certificate timestamp is missing or invalid" };
  if (Math.abs(Date.now() - tsMs) > MAX_AGE_MS) {
    return { ok: false, error: "certificate has expired — please submit again" };
  }

  return { ok: true };
}
