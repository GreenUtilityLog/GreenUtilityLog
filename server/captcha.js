// ── Cloudflare Turnstile verification (anti-bot) ─────────────────────────────
// When TURNSTILE_SECRET is set, /reward requires a token the frontend obtains
// from the Turnstile widget. We verify it server-side with Cloudflare. The
// secret stays server-side. Disabled (allows through) when no secret is set.

import { TURNSTILE_SECRET } from "./config.js";

export const captchaEnabled = () => !!TURNSTILE_SECRET;

export async function verifyCaptcha(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token || typeof token !== "string") return { ok: false, error: "captcha required" };
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip || "" }),
    });
    const data = await res.json().catch(() => ({}));
    return data.success ? { ok: true } : { ok: false, error: "captcha verification failed" };
  } catch (e) {
    // Fail CLOSED on a verify error. Failing open turned the anti-bot gate off
    // fleet-wide for anyone who could disrupt egress to Cloudflare; for a payout
    // path that's the wrong trade-off. A brief Cloudflare hiccup asks the user to
    // retry rather than silently waving bots through.
    console.warn(`[captcha] verify error, rejecting: ${e?.message || e}`);
    return { ok: false, error: "captcha check unavailable — please try again" };
  }
}
