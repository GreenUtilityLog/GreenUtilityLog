// ── Which network this build is for ──────────────────────────────────────────
// One codebase, two builds: the main app at /GreenUtilityLog/ and a test copy at
// /GreenUtilityLog/testnet/ (see .github/workflows/deploy.yml). The build sets
// VITE_NETWORK and VITE_REWARD_API; a local `npm run dev` gets testnet.
export const NETWORK = import.meta.env.VITE_NETWORK === "mainnet" ? "mainnet" : "testnet";
// The testnet backend. A testnet build (and `npm run dev`) falls back to it.
const TESTNET_API = "https://greenutilitylog-rewards.onrender.com";
const API_FROM_BUILD = String(import.meta.env.VITE_REWARD_API || "").trim().replace(/\/$/, "");
// A mainnet build must never quietly talk to the testnet backend: payouts would go
// out on the wrong chain (or not at all) while the app says "mainnet". deploy.yml
// falls back to TESTNET_API when MAINNET_API is empty, so the testnet URL counts as
// missing too. Refuse to start, visibly — main.jsx's error page isn't installed yet
// when this module runs, so write the message into #root ourselves.
if (NETWORK === "mainnet" && (!API_FROM_BUILD || API_FROM_BUILD === TESTNET_API)) {
  const msg = "Build misconfigured: this is a MAINNET build but VITE_REWARD_API is "
    + (API_FROM_BUILD ? "the testnet backend" : "not set")
    + ". Set it to the mainnet reward backend (see docs/MAINNET.md) and rebuild.";
  try {
    const root = typeof document !== "undefined" && document.getElementById("root");
    if (root) root.innerHTML = '<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:24px auto;padding:20px;border:2px solid #b00020;border-radius:10px;background:#fff5f5;color:#1a1a1a"><h2 style="margin:0 0 8px;color:#b00020">The app could not start</h2><p style="margin:0"></p></div>';
    const p = root && root.querySelector("p");
    if (p) p.textContent = msg;
  } catch { /* no DOM — the throw below still stops it */ }
  throw new Error(msg);
}
export const REWARD_API = API_FROM_BUILD || TESTNET_API;
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
