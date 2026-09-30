// ── Which network this build is for ──────────────────────────────────────────
// One codebase, two builds: the main app at /GreenUtilityLog/ and a test copy at
// /GreenUtilityLog/testnet/ (see .github/workflows/deploy.yml). The build sets
// VITE_NETWORK and VITE_REWARD_API; a local `npm run dev` gets testnet.
export const NETWORK = import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const REWARD_API = (import.meta.env.VITE_REWARD_API || "https://greenutilitylog-rewards.onrender.com").replace(/\/$/, "");
// Shown on the test copy: a strip saying so, and (once the real app is on mainnet)
// a link to it.
export const TESTNET_BANNER = import.meta.env.VITE_TESTNET_BANNER === "1";
export const MAIN_APP_URL = import.meta.env.VITE_MAIN_APP_URL || "";

// Both builds live on the same origin (greenutilitylog.github.io), so they share
// localStorage: testnet meters, baselines and history would show up in the real
// app and the other way round. The mainnet build keeps its own copies by
// prefixing the app's keys. The testnet build keeps the plain keys, so nobody who
// is already testing loses what's stored. Installed before the app module runs
// (main.jsx imports this first), so no read ever sees the shared keys.
const OURS = /^(greenlog_|gul_)/;
export const STORAGE_PREFIX = NETWORK === "mainnet" ? "mainnet:" : "";
if (STORAGE_PREFIX && typeof Storage !== "undefined") {
  const p = Storage.prototype;
  const wrap = (fn) => function (key, ...rest) {
    return fn.call(this, OURS.test(String(key)) ? STORAGE_PREFIX + key : key, ...rest);
  };
  p.getItem = wrap(p.getItem);
  p.setItem = wrap(p.setItem);
  p.removeItem = wrap(p.removeItem);
}
// This build's own keys, for "reset all app data" (Object.keys sees raw names).
export function ownStorageKeys() {
  try {
    return Object.keys(localStorage).filter((k) =>
      STORAGE_PREFIX ? k.startsWith(STORAGE_PREFIX) && OURS.test(k.slice(STORAGE_PREFIX.length)) : OURS.test(k));
  } catch { return []; }
}
// Offline submissions (IndexedDB) likewise per network.
export const IDB_NAME = NETWORK === "mainnet" ? "GreenUtilityLog-mainnet" : "GreenUtilityLog";

// The server gul.js sends to when given no --ingest. MUST match INGEST's default in
// bridge/index.js; a build whose REWARD_API differs puts --ingest in its commands.
export const BRIDGE_DEFAULT_API = "https://greenutilitylog-rewards.onrender.com";
export const INGEST_FLAG = REWARD_API === BRIDGE_DEFAULT_API ? "" : ` --ingest=${REWARD_API}/meter-ingest`;
