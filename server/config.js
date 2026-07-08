// ── Reward-distributor service config ────────────────────────────────────────
// Mirrors the frontend's network/contract/rate settings. Override anything via
// environment variables (.env). Defaults target VeChain testnet.

export const NETWORK = process.env.NETWORK || "testnet";

const NODES = {
  mainnet: "https://mainnet.vechain.org",
  testnet: "https://testnet.vechain.org",
};
export const NODE_URL = process.env.NODE_URL || NODES[NETWORK] || NODES.testnet;

const CONTRACTS_BY_NET = {
  mainnet: {
    X2EarnRewardsPool: "0x6Bee7DDab6c99d5B2Af0554EaEA484CE18F52631",
    X2EarnApps:        "0x8392B7CCc763dB03b47afcD8E8f5e24F9cf0554D",
  },
  testnet: {
    X2EarnRewardsPool: "0x2d2a2207c68a46fc79325d7718e639d1047b0d8b",
    X2EarnApps:        "0x0b54a094b877a25bdc95b4431eaa1e2206b1ddfe",
  },
};
export const CONTRACTS = CONTRACTS_BY_NET[NETWORK] || CONTRACTS_BY_NET.testnet;

// VeBetterDAO app id (bytes32). Defaults to the Green Utility Log app.
export const APP_ID =
  process.env.APP_ID ||
  "0x489c6c122157f3b1072c2565b0eb6cb734564e84d14c80b1a12e6834a075f71e";

export const APP_VERSION = "1.3.0";

// Reward rate per unit — MUST match the frontend UTILS rates.
// For consumption meters this is the B3TR earned per unit SAVED below the
// benchmark (see below); for solar it's per unit produced.
export const RATES = { electric: 0.61, gas: 0.84, water: 0.12, solar: 0.72 };
export const UNITS = { electric: "kWh", gas: "m³", water: "L", solar: "kWh" };

// ── Conservation-based reward ────────────────────────────────────────────────
// We reward USING LESS, not using more. The reward is:
//   base + max(0, benchmark - usage) * rate        (consumption meters)
//   base + usage * rate                            (solar — produced energy)
// where `usage` is this reading's consumption (current - previous).
//
// USAGE_BENCHMARK is a fixed "efficient usage" threshold per reading (NOT a
// rolling average — intentionally simple and personal-history-free, so it works
// from the very first submission). Stay below it to earn the bonus; above it you
// still get the base for logging. Tune these to your expected reading cadence —
// they assume roughly one reading per day. MUST match the frontend.
export const REWARD_BASE     = { electric: 0.2, gas: 0.2, water: 0.1, solar: 0.2 };
export const USAGE_BENCHMARK = { electric: 8,   gas: 6,   water: 300, solar: 0   };
// Solar is rewarded for production (more is better); everything else for saving.
export const SAVING_UTILS = new Set(["electric", "gas", "water"]);

// Hard per-payout ceiling (B3TR). A stateless sanity bound enforced in verify.js
// so no single submission can ever sign an absurd amount. Covers the legitimate
// max (solar ≈ 0.2 + 60*0.72 ≈ 43) with headroom. Override via env for mainnet.
export const MAX_REWARD = Number(process.env.MAX_REWARD || 50);

// ── Eco-mode bonus ────────────────────────────────────────────────────────────
// Users photograph an appliance (washer / dryer / dishwasher) running in eco
// mode and earn a small FIXED bonus. Rules: at most ECO_MAX_PER_WEEK claims per
// CALENDAR week (Monday 00:00 – Sunday 23:59 in ECO_TZ) and at least
// ECO_COOLDOWN_MS between claims. An eco photo has no meter reading to anchor
// it, so these caps (plus photo-hash dedupe + the optional AI check) are the guard.
export const ECO_REWARD       = Number(process.env.ECO_REWARD || 8);     // B3TR per approved eco photo
export const ECO_MAX_PER_WEEK = Number(process.env.ECO_MAX_PER_WEEK || 4);
export const ECO_COOLDOWN_MS  = Number(process.env.ECO_COOLDOWN_MS || 24 * 60 * 60 * 1000); // 24h between claims
export const ECO_TZ           = process.env.ECO_TZ || "Europe/Amsterdam";
export const ECO_APPLIANCES   = new Set(["washer", "dryer", "dishwasher"]);

// Identifier of the Monday-to-Sunday calendar week a timestamp falls in, in the
// configured timezone (returns that week's Monday as "YYYY-MM-DD"). Two claims
// share a weekly budget iff their keys match; the budget resets Monday morning.
export function ecoWeekKey(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ECO_TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const daysSinceMonday = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[get("weekday")] ?? 0;
  const monday = new Date(Date.UTC(+get("year"), +get("month") - 1, +get("day")));
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  return monday.toISOString().slice(0, 10);
}

// Reward amount for a single reading, given the utility and its usage.
export function computeReward(utility, usage) {
  const base = REWARD_BASE[utility] ?? 0;
  const rate = RATES[utility] ?? 0;
  if (SAVING_UTILS.has(utility)) {
    const saved = Math.max(0, (USAGE_BENCHMARK[utility] ?? 0) - usage);
    return +(base + saved * rate).toFixed(2);
  }
  // solar / production meters: reward the clean energy produced
  return +(base + Math.max(0, usage) * rate).toFixed(2);
}

// Plausible usage bounds per utility — MUST match the frontend checkPlausibility
// RANGES, otherwise a reading can pass on the client and then be rejected here.
export const USAGE_BOUNDS = {
  electric: [0.1, 80],
  gas:      [0.01, 20],
  water:    [10, 1000],
  solar:    [0.1, 60],
};

// Minimum gap between paid submissions for the same wallet+utility (default 20h,
// matching the in-app "fresh photo every 20 hours" rule).
export const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 20 * 60 * 60 * 1000);

export const PORT = Number(process.env.PORT || 8787);

// CORS — lock the API to your frontend origin(s). Comma-separate to allow more
// than one (e.g. your github.io page + a custom domain). Defaults to "*" (open)
// for first-run convenience; set ALLOWED_ORIGIN in production.
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
export const ALLOWED_ORIGINS = ALLOWED_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

// Ban list — wallet addresses that may never claim. Comma-separated, case-
// insensitive. Leave empty to ban no one.
export const BANNED_ADDRESSES = new Set(
  (process.env.BANNED_ADDRESSES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
export const isBanned = (addr) => BANNED_ADDRESSES.has(String(addr || "").toLowerCase());

// Cloudflare Turnstile (anti-bot captcha). Set TURNSTILE_SECRET to require a
// valid captcha token on /reward; leave empty to disable the check.
export const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";

// Opt-in server-side OCR (tesseract.js). Off by default — the photo hash dedupe
// and image sanity checks run regardless; OCR additionally checks the reading
// is visible in the photo. Enable with OCR_ENABLED=true (needs the optional
// tesseract.js dependency installed).
export const OCR_ENABLED = String(process.env.OCR_ENABLED || "").toLowerCase() === "true";

// Google Cloud Vision API key — when set, the /ocr endpoint reads meter photos via
// Vision (far more accurate than in-browser OCR). Get one in Google Cloud →
// "Credentials" → API key, with the Cloud Vision API enabled. First 1000 images a
// month are free. Leave empty to disable the endpoint (the app falls back to
// in-browser OCR).
export const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || "";

// ── Roboflow (meter-trained model) ───────────────────────────────────────────
// A model trained specifically on meter displays — usually reads them better than
// generic OCR. Create a free account, find the model on Roboflow Universe, and set
// ROBOFLOW_MODEL to "project/version" (e.g. "ocr-meter-reading/3") + your API key.
export const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY || "";
export const ROBOFLOW_MODEL   = process.env.ROBOFLOW_MODEL || "ocr-meter-reading/1"; // "project/version"

// ── Custom OCR service (self-hosted) ─────────────────────────────────────────
// URL of your own OCR HTTP service (e.g. the YOLOv8 + OCR FastAPI pipeline). It is
// POSTed { image } (base64) and should return { text } and/or { numbers: [...] }.
// Host the model yourself; this just forwards to it.
export const CUSTOM_OCR_URL = process.env.CUSTOM_OCR_URL || "";

// Order to try the OCR providers in; the first that returns a result wins. Any not
// configured are skipped, and the app falls back to in-browser OCR if all miss.
export const OCR_PROVIDER_ORDER = (process.env.OCR_PROVIDER_ORDER || "roboflow,custom,vision")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
