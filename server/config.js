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
  mainnet: { X2EarnRewardsPool: "0x6Bee7DDab6c99d5B2Af0554EaEA484CE18F52631" },
  testnet: { X2EarnRewardsPool: "0x2d2a2207c68a46fc79325d7718e639d1047b0d8b" },
};
export const CONTRACTS = CONTRACTS_BY_NET[NETWORK] || CONTRACTS_BY_NET.testnet;

// VeBetterDAO app id (bytes32). Defaults to the Green Utility Log app.
export const APP_ID =
  process.env.APP_ID ||
  "0x489c6c122157f3b1072c2565b0eb6cb734564e84d14c80b1a12e6834a075f71e";

export const APP_VERSION = "1.3.0";

// Reward rate per unit — MUST match the frontend UTILS rates.
export const RATES = { electric: 0.61, gas: 0.84, water: 0.12, solar: 0.72 };
export const UNITS = { electric: "kWh", gas: "m³", water: "L", solar: "kWh" };

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
