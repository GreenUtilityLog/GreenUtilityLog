// ── Wallet ownership proof (VeChain certificate) ─────────────────────────────
// The /reward body carries a certificate the user signed in their wallet. We
// re-verify the signature here and confirm it was signed by the SAME address the
// payout goes to — so the API can't be tricked into rewarding an address that was
// simply typed into the request. Gasless for the user; the real anti-spoof gate.

import { Certificate } from "@vechain/sdk-core";

// Reject certificates older than this (anti-replay). The wallet's timestamp is in
// seconds on some wallets and ms on others, so we normalise and allow generous skew.
const MAX_AGE_MS = Number(process.env.CERT_MAX_AGE_MS || 15 * 60 * 1000);

// Require a valid certificate by default; set REQUIRE_CERT=false only for local dev.
export const REQUIRE_CERT = String(process.env.REQUIRE_CERT || "true").toLowerCase() !== "false";

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
