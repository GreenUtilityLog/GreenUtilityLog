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
    // Fail open on a network hiccup so a Cloudflare outage can't block real users.
    console.warn(`[captcha] verify error, allowing: ${e?.message || e}`);
    return { ok: true, error: String(e?.message || e) };
  }
}
