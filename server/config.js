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

// Plausible daily-usage bounds per utility — mirrors the frontend anti-farming
// engine, so the server rejects the same implausible readings.
export const USAGE_BOUNDS = {
  electric: [0.5, 60],
  gas:      [0.1, 20],
  water:    [20, 2000],
  solar:    [0.1, 80],
};

// Minimum gap between paid submissions for the same wallet+utility (default 20h,
// matching the in-app "fresh photo every 20 hours" rule).
export const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 20 * 60 * 60 * 1000);

export const PORT = Number(process.env.PORT || 8787);
export const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

// Opt-in server-side OCR (tesseract.js). Off by default — the photo hash dedupe
// and image sanity checks run regardless; OCR additionally checks the reading
// is visible in the photo. Enable with OCR_ENABLED=true (needs the optional
// tesseract.js dependency installed).
export const OCR_ENABLED = String(process.env.OCR_ENABLED || "").toLowerCase() === "true";
