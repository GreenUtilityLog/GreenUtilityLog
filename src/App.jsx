import { useState, useRef, useEffect, Fragment } from "react";
import { useWallet, useWalletModal } from "@vechain/dapp-kit-react";
import { Clause, Address, ABIFunction } from "@vechain/sdk-core";
import { fetchOnChainLeaderboard, fetchWalletHistory, fetchIsAppAdmin, fetchPoolBalance, fetchDiagnostics } from "./leaderboard.js";

// ════════════════════════════════════════════════════════════════════════════
// APP VERSION & VECHAIN KIT
// ════════════════════════════════════════════════════════════════════════════
const APP_VERSION = "1.3.0";
const APP_NAME = "Green Utility Log";

// ── NETWORK SELECTION ──────────────────────────────────────────────────────
// Flip to "mainnet" for the production launch. Everything below (node URL +
// contract addresses) follows this one switch. Addresses are the official
// VeBetterDAO deployments (npm @vechain/vebetterdao-contracts).
const NETWORK = "testnet"; // "testnet" | "mainnet"

const NETWORKS = {
  mainnet: {
    node: "https://mainnet.vechain.org",
    contracts: {
      B3TR:              "0x5ef79995FE8a89e0812330E4378eB2660ceDe699",
      X2EarnRewardsPool: "0x6Bee7DDab6c99d5B2Af0554EaEA484CE18F52631",
      X2EarnApps:        "0x8392B7CCc763dB03b47afcD8E8f5e24F9cf0554D",
    },
  },
  testnet: {
    node: "https://testnet.vechain.org",
    contracts: {
      B3TR:              "0x95761346d18244bb91664181bf91193376197088",
      X2EarnRewardsPool: "0x2d2a2207c68a46fc79325d7718e639d1047b0d8b",
      X2EarnApps:        "0x0b54a094b877a25bdc95b4431eaa1e2206b1ddfe",
    },
  },
};
export const ACTIVE_NODE = NETWORKS[NETWORK].node;
const CONTRACTS = NETWORKS[NETWORK].contracts;
const NETWORK_LABEL = NETWORK === "mainnet" ? "VeChain Mainnet" : "VeChain Testnet";
// Block explorer for the active network — history rows and admin checks link here
// so every payout is verifiable on-chain with one tap.
const EXPLORER = NETWORK === "mainnet" ? "https://explore.vechain.org" : "https://explore-testnet.vechain.org";

// Photos must come from a PHONE CAMERA, not a file picker. The inputs use
// capture="environment" (mobile browsers open the camera directly), desktop is
// blocked entirely, and a freshness gate rejects photos not taken just now —
// gallery picks and downloaded/AI-generated images are minutes-to-years old.
// iPadOS 13+ reports a Macintosh UA — detect it via multi-touch support.
const IS_MOBILE = typeof navigator !== "undefined" && (
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
  ((navigator.maxTouchPoints || 0) > 1 && /Macintosh/i.test(navigator.userAgent || ""))
);

// Parse a "YYYY-MM-DD" day key as LOCAL midnight. `new Date("YYYY-MM-DD")` parses
// as UTC midnight, which shifts the day in western timezones and puts records in
// the wrong week bucket. Used as the fallback when a record has no submittedAt.
function localDayTs(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
}
const MAX_PHOTO_AGE_MS = 15 * 60 * 1000; // camera capture is seconds old; be lenient for slow flows
function photoTooOld(file) {
  // Some webviews report lastModified 0/epoch for camera shots — only reject
  // when we positively know the file is old (a real timestamp well in the past).
  const lm = Number(file?.lastModified) || 0;
  return lm > 24 * 60 * 60 * 1000 && (Date.now() - lm) > MAX_PHOTO_AGE_MS;
}

// ── YOUR APP ID — set this after registering on VeBetterDAO ───────────────
// Get your App ID by registering at the governance site (testnet:
// https://staging.testnet.governance.vebetterdao.org/apps). It is a bytes32
// value and MUST come from the SAME network selected above.
const VEBETTER_APP_ID = "0x489c6c122157f3b1072c2565b0eb6cb734564e84d14c80b1a12e6834a075f71e";

// ── ADMIN WALLETS — read-only monitoring access ──────────────────────────────
// Wallets listed here (lowercase) unlock the in-app Admin panel: a read-only
// view of every on-chain participant, their B3TR and submission counts. This is
// monitoring only — issuing/blocking rewards needs the reward-distributor role
// (a backend), not the frontend. Add your VeBetterDAO app-admin address below.
const ADMIN_WALLETS = [
  "0xedd7e5e1be4066cdc892a059f586b9d7e8e4b0c7",
  "0x3a007383fce8dcccdb92cf9efe0e609a652a1f29",
].map(a => a.toLowerCase());
const isAdminWallet = (w) => !!w && ADMIN_WALLETS.includes(w.toLowerCase());

// ── REWARD BACKEND (optional) ────────────────────────────────────────────────
// When set (e.g. "https://api.greenutilitylog.com"), submissions are sent here
// and a server-side reward-distributor verifies them and issues the B3TR — the
// user signs nothing, and you never have to grant the distributor role to every
// wallet. See the /server folder for the matching service. Leave empty to keep
// the direct on-chain flow (the connected wallet must hold the distributor role).
const REWARD_API = "https://greenutilitylog-rewards.onrender.com";

// ── ANTI-BOT CAPTCHA (optional) ───────────────────────────────────────────────
// Cloudflare Turnstile public site key. Set it to require a captcha on each
// submission (the backend verifies it with TURNSTILE_SECRET). Get both free at
// dash.cloudflare.com → Turnstile. Empty = captcha disabled.
const TURNSTILE_SITE_KEY = "";

// ── OCR BACKEND (optional) ────────────────────────────────────────────────────
// When set, meter photos (the cropped reading + the full photo for the meter
// number) are read by the backend's /ocr endpoint — Google Cloud Vision, far more
// accurate than in-browser OCR. The Vision API key stays server-side. Falls back
// to in-browser OCR when this is empty or the call fails. Defaults to REWARD_API,
// so pointing both at one deployed backend is enough.
const OCR_API = "";

// ── ROBOFLOW (works WITHOUT a backend) ────────────────────────────────────────
// A meter-trained model called straight from the app — the simplest way to get
// reliable recognition without deploying a server. Create a free roboflow.com
// account, open a meter-reading model on Roboflow Universe → "Deploy", and copy
// the model id ("project/version") and your API key here.
// NOTE: the key is visible in the app (fine for a test / free tier). For
// production, move OCR server-side via OCR_API instead.
const ROBOFLOW_MODEL   = "ocr-meter-reading/1";   // project/version (not secret)
// Removed: a hard-coded key ships in the public bundle. Server-side OCR (OCR_API /
// the backend /ocr endpoint) or in-browser Tesseract are used instead. To use
// Roboflow, proxy it through the backend — never put the key in the client.
const ROBOFLOW_API_KEY = "";

// ── FEEDBACK ──────────────────────────────────────────────────────────────────
// Where the in-app "Send Feedback" button delivers testers' messages. It opens
// the tester's own mail app pre-filled (no server needed). Change this to the
// address you want bug reports and testing feedback to land in.
const FEEDBACK_EMAIL = "greenutilitylog@gmail.com";

// Free VeChain testnet faucet — testers need a little VTHO to pay gas. Shown in
// the in-app Help so nobody gets stuck on "insufficient energy".
const TESTNET_FAUCET = "https://faucet.vecha.in";

// Indicative B3TR→USD rate for display only (not a live price feed).
const B3TR_USD = 0.014;

// ── ABI fragments needed ───────────────────────────────────────────────────
const B3TR_ABI = [
  { name:"balanceOf", type:"function", inputs:[{name:"account",type:"address"}], outputs:[{name:"",type:"uint256"}], stateMutability:"view" },
];
const X2EARN_ABI = [
  { name:"distributeReward", type:"function",
    inputs:[
      {name:"appId",    type:"bytes32"},
      {name:"amount",   type:"uint256"},
      {name:"receiver", type:"address"},
      {name:"proof",    type:"string"},
    ],
    outputs:[{name:"",type:"bool"}],
    stateMutability:"nonpayable"
  },
];

// Funding the rewards pool: ERC20 approve on B3TR, then X2EarnRewardsPool.deposit.
const ERC20_APPROVE_ABI = { name:"approve", type:"function", inputs:[{name:"spender",type:"address"},{name:"amount",type:"uint256"}], outputs:[{name:"",type:"bool"}], stateMutability:"nonpayable" };
const DEPOSIT_ABI        = { name:"deposit", type:"function", inputs:[{name:"amount",type:"uint256"},{name:"appId",type:"bytes32"}], outputs:[], stateMutability:"nonpayable" };

// ── Test-B3TR faucet (TESTNET ONLY) ───────────────────────────────────────────
// A self-service faucet that mints a fixed batch of test-B3TR to the caller so an
// admin can fund the rewards pool without already owning B3TR. Only meaningful on
// testnet — there is no real-value faucet on mainnet, so the claim button is
// hidden when NETWORK !== "testnet".
//
// ⚠️ VERIFY BEFORE RELYING ON IT: this address + function signature could not be
// confirmed from inside the build sandbox (no network/docs access). The VeBetterDAO
// testnet faucet contract address and its claim function name/args MUST be checked
// against the official VeBetterDAO testnet docs. If the claim reverts, fix these two
// constants — the rest of the wiring stays the same. (You can still fund the pool
// directly via "Fund rewards pool" if your wallet already holds test-B3TR.)
const B3TR_FAUCET_ADDRESS = "0xfca716f9c93575f428fe49402424454077ccbfee"; // TODO: verify on VeBetterDAO testnet
// Most self-service faucets expose a no-arg claim that mints to msg.sender. If the
// real faucet uses a different name (e.g. "claim") or takes an address arg, change
// this fragment and buildClaimClause() below to match.
const FAUCET_CLAIM_ABI = { name:"claimTokens", type:"function", inputs:[], outputs:[], stateMutability:"nonpayable" };
const FAUCET_ENABLED = NETWORK === "testnet";

// Convert a B3TR amount (number or decimal string) to wei (18 decimals) WITHOUT
// floating-point error — `amount * 1e18` overflows Number's safe integer range and
// corrupts the low digits, so build it from the decimal string instead.
function toWei(amount) {
  const s = String(amount).trim();
  const neg = s.startsWith("-");
  const [intPart = "0", fracRaw = ""] = s.replace("-", "").split(".");
  const frac = (fracRaw + "0".repeat(18)).slice(0, 18);
  const wei = BigInt((intPart || "0") + frac);
  return (neg ? -wei : wei).toString();
}

// ── Build the clauses to fund the app's rewards pool (approve + deposit) ──────
// One multi-clause transaction: approve B3TR for the pool, then deposit it into
// the pool for this app. The connected wallet must hold the B3TR being deposited.
function buildFundClauses(amountB3TR) {
  const amountWei = toWei(amountB3TR);
  const approve = Clause.callFunction(
    Address.of(CONTRACTS.B3TR),
    new ABIFunction(ERC20_APPROVE_ABI),
    [CONTRACTS.X2EarnRewardsPool, amountWei]
  );
  const deposit = Clause.callFunction(
    Address.of(CONTRACTS.X2EarnRewardsPool),
    new ABIFunction(DEPOSIT_ABI),
    [amountWei, VEBETTER_APP_ID]
  );
  return [
    { to: approve.to, value: "0x0", data: approve.data, comment: `Approve ${amountB3TR} B3TR for the rewards pool` },
    { to: deposit.to, value: "0x0", data: deposit.data, comment: `Fund rewards pool with ${amountB3TR} B3TR` },
  ];
}

// ── Build the clause to claim test-B3TR from the testnet faucet ───────────────
// One clause: call the faucet's claim function, which mints a fixed batch of
// test-B3TR to the signer. Used so an admin without B3TR can still fund the pool.
function buildClaimClause() {
  const claim = Clause.callFunction(
    Address.of(B3TR_FAUCET_ADDRESS),
    new ABIFunction(FAUCET_CLAIM_ABI),
    []
  );
  return [{ to: claim.to, value: "0x0", data: claim.data, comment: "Claim test-B3TR from the testnet faucet" }];
}

// ── Build the on-chain clause for a meter submission ──────────────────────
function buildRewardClauses(utilId, reading, prevRead, b3trAmount, userAddress, meterNo) {
  // Build proof JSON — required by VeBetterDAO
  const proof = JSON.stringify({
    appId:     VEBETTER_APP_ID,
    action:    "meter_reading",
    utility:   utilId,
    meterNo:   meterNo || "",
    reading:   reading,
    prevRead:  prevRead,
    b3tr:      b3trAmount,
    timestamp: new Date().toISOString(),
    version:   APP_VERSION,
  });

  // Amount in wei (18 decimals) — string-based, no float rounding error.
  const amountWei = toWei(b3trAmount);

  // distributeReward(appId, amount, receiver, proof) on X2EarnRewardsPool
  const clause = Clause.callFunction(
    Address.of(CONTRACTS.X2EarnRewardsPool),
    new ABIFunction(X2EARN_ABI[0]),
    [VEBETTER_APP_ID, amountWei, userAddress, proof]
  );

  return [{
    to: clause.to,
    value: "0x0", // distributeReward is non-payable; send no VET.
    data: clause.data,
    comment: `Green Utility Log — ${utilId} meter reading — earn ${b3trAmount} B3TR`,
  }];
}

// ────────────────────────────────────────────────────────────────────────────
// PDF EXPORT
// ────────────────────────────────────────────────────────────────────────────
async function generateMonthlyPDF(b3tr, subs) {
  try {
    const { jsPDF } = window.jspdf || await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      script.onload = () => resolve(window);
      script.onerror = reject;
      document.head.appendChild(script);
    });

    const doc = new jsPDF();
    const today = new Date();
    const month = today.toLocaleString('en', { month: 'long', year: 'numeric' });
    
    doc.setFontSize(24);
    doc.text('🌱 Green Utility Log', 20, 20);
    doc.setFontSize(12);
    doc.text(`Monthly Report - ${month}`, 20, 30);
    doc.setFontSize(10);
    doc.text(`Total B3TR Earned: ${b3tr.toFixed(2)} B3TR`, 20, 45);
    doc.text(`Network: ${NETWORK_LABEL} (test tokens, no real-world value)`, 20, 55);
    doc.text(`Submissions: ${subs.length}`, 20, 65);
    doc.setFontSize(14);
    doc.text('Submissions', 20, 85);
    doc.setFontSize(9);
    
    let yPos = 100;
    subs.forEach((s, i) => {
      if (yPos > 270) { doc.addPage(); yPos = 20; }
      const u = getUtil(s.type);
      const delta = (parseFloat(s.cur) - parseFloat(s.prev)).toFixed(2);
      doc.text(`${i+1}. ${u.label} - ${s.date}`, 20, yPos);
      doc.text(`Usage: ${delta} ${u.unit} | +${parseFloat(s.b3tr).toFixed(2)} B3TR`, 20, yPos+5);
      yPos += 12;
    });
    
    doc.setFontSize(8);
    doc.text('Generated by Green Utility Log · Powered by VeChain', 20, doc.internal.pageSize.height - 10);
    doc.save(`GreenUtilityLog_${month.replace(' ', '_')}.pdf`);
    return true;
  } catch (e) {
    console.error('PDF export failed:', e);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// BASELINE STORAGE
// ────────────────────────────────────────────────────────────────────────────
function loadBaselines() {
  try { 
    const stored = localStorage.getItem('greenlog_baselines');
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

function saveBaselines(baselines) {
  localStorage.setItem('greenlog_baselines', JSON.stringify(baselines));
}

// Meter numbers (EAN / serial) are registered once per meter and travel with
// every reading. Tying a submission to a fixed, declared meter makes reward
// farming with random photos far harder.
function loadMeters() {
  try {
    const stored = localStorage.getItem('greenlog_meters');
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

function saveMeters(meters) {
  localStorage.setItem('greenlog_meters', JSON.stringify(meters));
}

// ── Submission history (per wallet) ──────────────────────────────────────────
// The on-chain RewardDistributed events are authoritative, but they only exist for
// PAID submissions. Until the reward backend is live, submissions are recorded but
// not on-chain — so we also keep a per-wallet local copy, otherwise everything
// "resets" on every reload. Keyed by wallet so a different wallet starts clean.
const subsKey = (wallet) => `greenlog_subs_${String(wallet || "").toLowerCase()}`;
function loadSubs(wallet) {
  try { const s = localStorage.getItem(subsKey(wallet)); return s ? JSON.parse(s) : []; } catch { return []; }
}
function saveSubs(wallet, subs) {
  try { localStorage.setItem(subsKey(wallet), JSON.stringify((subs || []).slice(0, 500))); } catch {}
}
// Merge on-chain (authoritative) with local entries that aren't represented there.
function mergeSubs(local, chain) {
  const same = (a, b) =>
    (a.txHash && b.txHash && a.txHash === b.txHash) ||
    (a.type === b.type && String(a.cur) === String(b.cur) && String(a.meterNo) === String(b.meterNo) && a.date === b.date);
  const extras = (local || []).filter(l => !(chain || []).some(c => same(l, c)));
  return [...(chain || []), ...extras].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
}

// ────────────────────────────────────────────────────────────────────────────
// ANTI-FARMING ENGINE
// ────────────────────────────────────────────────────────────────────────────

function checkPlausibility(utilId, usageVal) {
  const RANGES = { electric: { min:0.1, max:80 }, gas: { min:0.01, max:20 }, water: { min:10, max:1000}, solar: { min:0.1, max:60 } };
  const range = RANGES[utilId];
  if (!range) return { ok:true };
  // Zero usage (current == previous) is explicitly valid — the best conservation
  // outcome. Only a tiny-but-nonzero delta may be a typo, and high is abnormal.
  if (usageVal > 0 && usageVal < range.min) return { ok:false, reason:`Usage too low (${usageVal} < ${range.min})` };
  if (usageVal > range.max) return { ok:false, reason:`Abnormally high (${usageVal} > ${range.max})` };
  return { ok:true };
}

function checkAnomaly(utilId, usageVal, subs) {
  const recent = subs.filter(s=>s.type===utilId).slice(0,14);
  // Only rows with a real prev→cur delta count. Photoless/auto-submit rows store an
  // empty prev, so parseFloat("") = NaN; without this filter a single such row makes
  // avg NaN and silently disables the anomaly gate for the whole utility.
  const deltas = recent.map(s=>parseFloat(s.cur)-parseFloat(s.prev)).filter(Number.isFinite);
  if (deltas.length < 3) return { ok:true, anomaly:false };
  const avg = deltas.reduce((a,d)=>a+d,0)/deltas.length;
  if (avg > 0 && usageVal > avg * 3.5) return { ok:false, anomaly:true, reason:`Usage is ${(usageVal/avg).toFixed(1)}x your average`, avg };
  return { ok:true, anomaly:false, avg:parseFloat(avg.toFixed(2)) };
}

// From the numbers OCR found on the photo, choose the most likely CURRENT meter
// reading and reject misreads — barcodes, serial/model numbers, the stray "0" off
// the nameplate. The PREVIOUS reading is the anchor: a real new reading sits just
// above it, and the consumption (reading − prev) must be plausible for the meter.
// Returns null when nothing is convincing, so the field is left empty for manual
// entry instead of pre-filled with a wrong number. Water keeps 2 decimals.
function pickPlausibleReading(nums, { utilId, prevRead, preferred }) {
  const fmt = (v) => (utilId === "water" ? +v.toFixed(2) : v);
  const prev = parseFloat(prevRead);
  const digits = (n) => String(Math.trunc(Math.abs(n))).length;

  // 1) Trust the MOST PROMINENT number read from the boxed region (the tallest /
  //    most-confident digits — that's the meter reading the user pointed at), as
  //    long as it's plausible against the previous reading. This is what makes the
  //    OCR read "the selected part" instead of grabbing some other number.
  if (preferred != null && Number.isFinite(preferred) && preferred > 0 && digits(preferred) <= 8) {
    if (!Number.isFinite(prev) || (preferred > prev && checkPlausibility(utilId, +(preferred - prev).toFixed(2)).ok)) {
      return fmt(preferred);
    }
  }

  const cand = [...new Set((nums || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (!cand.length) return preferred != null && Number.isFinite(preferred) && preferred > 0 ? fmt(preferred) : null;
  // Drop obvious non-readings: barcodes/serials run far longer than a meter dial.
  const sane = cand.filter(n => digits(n) <= 8);
  const pool = sane.length ? sane : cand;

  if (Number.isFinite(prev)) {
    const anchored = pool
      .filter(n => n > prev && checkPlausibility(utilId, +(n - prev).toFixed(2)).ok)
      .sort((a, b) => a - b);              // closest above the previous reading is likeliest
    if (anchored.length) return fmt(anchored[0]);
    // Still no plausible anchor: prefer a candidate with the SAME number of digits
    // as the previous reading (a meter's reading length is stable) over a random
    // larger number like a serial fragment.
    const prevLen = digits(prev);
    const sameLen = pool.filter(n => digits(n) === prevLen).sort((a, b) => b - a);
    if (sameLen.length) return fmt(sameLen[0]);
    // We HAVE a baseline and nothing fits it — every candidate is OCR garbage
    // (mangled label text, serial fragments). Autofilling would put a wrong
    // number in the field, so leave it empty for manual entry instead.
    return null;
  }
  // First reading (no anchor): the reading is normally the figure with the MOST
  // digits on the dial (not merely the largest value). Submit-time photo check
  // still flags it if wrong, so pre-filling here never bypasses verification.
  return fmt(pool.sort((a, b) => digits(b) - digits(a) || b - a)[0]);
}

// Does the final entered reading actually appear on the verified photo? Reuses the
// OCR tolerance — a number within ~8%, or one that shares the reading's last 4
// digits, counts as a match. Checked at SUBMIT time so a reading edited after the
// photo was verified can't silently pass: if the photo can't back it up, the
// submission is flagged for review (it is not auto-blocked — that's the hybrid).
function readingMatchesPhoto(reading, ocrNums) {
  const claimed = parseFloat(reading);
  if (!Number.isFinite(claimed) || claimed <= 0) return false;
  const nums = (ocrNums || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return false;
  if (nums.some(n => Math.abs(n - claimed) / claimed < 0.08)) return true;
  const tail = String(Math.round(claimed)).slice(-4);
  return tail.length >= 3 && nums.some(n => String(Math.round(n)).includes(tail));
}

// ────────────────────────────────────────────────────────────────────────────
// OFFLINE STORAGE (IndexedDB)
// ────────────────────────────────────────────────────────────────────────────

async function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("GreenUtilityLog", 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("submissions")) db.createObjectStore("submissions", { keyPath: "id" });
    };
  });
}

async function saveOfflineSubmission(data) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("submissions", "readwrite");
    const store = tx.objectStore("submissions");
    const req = store.add({ ...data, id: Date.now(), synced: false });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

// Submissions captured while offline, still waiting to be broadcast. Skips any
// that are already broadcasting/synced so a sync interrupted mid-flight can't
// re-broadcast the same reward.
async function getUnsyncedSubmissions() {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("submissions", "readonly").objectStore("submissions").getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result || []).filter(s => !s.synced && !s.broadcasting));
  });
}

// Flag a queued submission as in-flight BEFORE broadcasting so a crash between
// broadcast and confirmation doesn't cause a double payout. Cleared on failure.
async function markBroadcasting(id, flag) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction("submissions", "readwrite").objectStore("submissions");
    const get = store.get(id);
    get.onerror = () => reject(get.error);
    get.onsuccess = () => {
      const v = get.result;
      if (v) { v.broadcasting = !!flag; store.put(v); }
      resolve();
    };
  });
}

// Mark a queued submission as broadcast so it isn't sent twice.
async function markSynced(id, txHash) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction("submissions", "readwrite").objectStore("submissions");
    const get = store.get(id);
    get.onerror = () => reject(get.error);
    get.onsuccess = () => {
      const v = get.result;
      if (v) { v.synced = true; v.broadcasting = false; v.txHash = txHash || v.txHash; store.put(v); }
      resolve();
    };
  });
}

function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const handleOnline  = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online",  handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online",  handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);
  return online;
}

// ────────────────────────────────────────────────────────────────────────────
// THEME
// ────────────────────────────────────────────────────────────────────────────

const LIGHT = {
  bg:"#ede9e2", bgAlt:"#e4e0d8", white:"#f5f2ec",
  green1:"#1a3326", green2:"#264d3a", green3:"#4a7a60", green4:"#90b8a2", green5:"#dce8e1",
  text:"#0d1812", textMid:"#334a3e", textSoft:"#5e756a",
  border:"#cbc6bc", shadow:"rgba(13,24,18,0.05)", shadowMd:"rgba(13,24,18,0.10)",
  electric:"#8a4200", electricBg:"#f0e8de", electricBorder:"#b89070",
  gas:"#7a1c1c",      gasBg:"#ede0e0",    gasBorder:"#b88a8a",
  water:"#10386a",    waterBg:"#dde8f4",  waterBorder:"#80a8cc",
  solar:"#264d3a",    solarBg:"#dce8e1",  solarBorder:"#90b8a2",
  eco:"#264d3a",      ecoBg:"#dce8e1",    ecoBorder:"#90b8a2",
  card:"#f5f2ec", navBg:"rgba(237,233,226,0.97)",
  heroFrom:"#1a3326", heroTo:"#264d3a",
};
const DARK = {
  bg:"#0e1714", bgAlt:"#17241e", white:"#1b2a23",
  green1:"#83cb9f", green2:"#69af86", green3:"#97dcad", green4:"#2c463a", green5:"#16241c",
  text:"#e9e6df", textMid:"#a8c4b4", textSoft:"#7e988a",
  border:"#2a4034", shadow:"rgba(0,0,0,0.38)", shadowMd:"rgba(0,0,0,0.52)",
  electric:"#dc8f50", electricBg:"#201408", electricBorder:"#4a2e0c",
  gas:"#db6060",      gasBg:"#200e0e",    gasBorder:"#4a1818",
  water:"#549bdf",    waterBg:"#0c1622",  waterBorder:"#173a64",
  solar:"#69af86",    solarBg:"#0e1c14",  solarBorder:"#1f3e2d",
  eco:"#69af86",      ecoBg:"#0e1c14",    ecoBorder:"#1f3e2d",
  card:"#17241e", navBg:"rgba(14,23,20,0.97)",
  heroFrom:"#102218", heroTo:"#1f3d2d",
};

const UTIL_ICONS = {
  electric: <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M11 2L4 12h6l-1 6 7-10h-6l1-6z"/></svg>,
  gas:      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="16" height="16"><path d="M10 17c-3.3 0-6-2.7-6-6 0-4 3-7 6-9 3 2 6 5 6 9 0 3.3-2.7 6-6 6z"/><path d="M10 13a2 2 0 000-4c-1.1 0-2 .9-2 2" strokeOpacity=".6"/></svg>,
  water:    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M10 2C7 6 4 9.5 4 13a6 6 0 0012 0c0-3.5-3-7-6-11z" opacity=".9"/></svg>,
  solar:    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="16" height="16"><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M4.6 15.4l1.4-1.4M14 6l1.4-1.4"/></svg>,
  eco:      <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M16 3c-6 0-11 3-11 9 0 1.4.4 2.6 1 3.6C7.6 12 10.5 9.5 14 8c-3 2-5.6 4.6-7 8 .9.6 2 1 3.2 1C15 17 17 11 16 3z"/></svg>,
};

const UTILS = [
  { id:"electric", label:"Electric", unit:"kWh", rate:0.61, ph:["3834.8","3847.2"], hint:"Lights, appliances, boiler" },
  // Hidden for now — testing electricity first. Uncomment a line to bring that meter back.
  // { id:"gas",      label:"Gas",      unit:"m³",  rate:0.84, ph:["521.4","523.1"],   hint:"Heating & cooking" },
  // { id:"water",    label:"Water",    unit:"L",   rate:0.12, ph:["12320","12450"],    hint:"Household water usage" },
  // { id:"solar",    label:"Solar",    unit:"kWh", rate:0.72, ph:["130.1","142.3"],    hint:"Solar panel output", optional:true },
];

// ── Conservation-based reward (MUST match server/config.js) ───────────────────
// We reward USING LESS, not using more:
//   reward = base + max(0, benchmark - usage) * rate     (consumption meters)
//   reward = base + usage * rate                         (solar — produced energy)
// USAGE_BENCHMARK is a fixed "efficient usage" threshold per reading (not an
// average — works from the first submission). Below it you earn the bonus; above
// it you still get the base for logging. Tune to your reading cadence (~1/day).
const REWARD_BASE     = { electric: 0.2, gas: 0.2, water: 0.1, solar: 0.2 };
const USAGE_BENCHMARK = { electric: 8,   gas: 6,   water: 300, solar: 0   };
const SAVING_UTILS    = new Set(["electric", "gas", "water"]); // solar rewards production
function computeReward(utilId, usage) {
  const u = UTILS.find(x => x.id === utilId) || {};
  const base = REWARD_BASE[utilId] ?? 0;
  const rate = u.rate ?? 0;
  if (SAVING_UTILS.has(utilId)) {
    const saved = Math.max(0, (USAGE_BENCHMARK[utilId] ?? 0) - usage);
    return parseFloat((base + saved * rate).toFixed(2));
  }
  return parseFloat((base + Math.max(0, usage) * rate).toFixed(2));
}

const HISTORY_SEED = [
  { id:1,  type:"electric", cur:"3847.2", prev:"3834.8", date:"2026-05-04", b3tr:7.81,  status:"confirmed" },
  { id:2,  type:"water",    cur:"12450",  prev:"12320",  date:"2026-05-03", b3tr:15.60, status:"confirmed" },
  { id:3,  type:"gas",      cur:"523.1",  prev:"521.4",  date:"2026-05-02", b3tr:1.43,  status:"confirmed" },
  { id:4,  type:"electric", cur:"3834.8", prev:"3821.1", date:"2026-05-01", b3tr:8.35,  status:"confirmed" },
  { id:5,  type:"solar",    cur:"142.3",  prev:"130.1",  date:"2026-04-30", b3tr:8.78,  status:"confirmed" },
  { id:6,  type:"water",    cur:"12320",  prev:"12195",  date:"2026-04-29", b3tr:15.00, status:"confirmed" },
  { id:7,  type:"gas",      cur:"521.4",  prev:"518.9",  date:"2026-04-28", b3tr:2.10,  status:"confirmed" },
  { id:8,  type:"electric", cur:"3821.1", prev:"3808.4", date:"2026-04-27", b3tr:7.75,  status:"confirmed" },
  { id:9,  type:"solar",    cur:"130.1",  prev:"119.4",  date:"2026-04-26", b3tr:7.70,  status:"confirmed" },
  { id:10, type:"water",    cur:"12195",  prev:"12060",  date:"2026-04-25", b3tr:16.20, status:"confirmed" },
];

const LEADERBOARD_DATA = [
  { rank:1,  name:"GreenPioneer",  addr:"0x1a2b…c3d4", b3tr:312.4, streak:28, tier:"Platinum" },
  { rank:2,  name:"EcoWarrior_NL", addr:"0x5e6f…g7h8", b3tr:287.1, streak:21, tier:"Gold" },
  { rank:3,  name:"SolarKing",     addr:"0x9i0j…k1l2", b3tr:265.8, streak:19, tier:"Silver" },
  { rank:5,  name:"WaterWarden",   addr:"0x3m4n…o5p6", b3tr:201.3, streak:15, tier:"Star" },
  { rank:6,  name:"NatureFirst",   addr:"0x7q8r…s9t0", b3tr:188.7, streak:13, tier:"Star" },
  { rank:7,  name:"CleanEnergy99", addr:"0xu1v2…w3x4", b3tr:174.2, streak:11, tier:"Sun" },
  { rank:8,  name:"ZeroCarbon",    addr:"0xy5z6…a7b8", b3tr:162.9, streak:10, tier:"Sun" },
  { rank:9,  name:"GreenGrid_EU",  addr:"0xc9d0…e1f2", b3tr:149.5, streak:9,  tier:"Sun" },
  { rank:10, name:"LeafLogger",    addr:"0xg3h4…i5j6", b3tr:138.1, streak:8,  tier:"Moon" },
];

// Shorten a wallet address for display: 0x1234…abcd
function shortAddr(a){ return a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—"; }

// Reward tiers, keyed off lifetime B3TR. Shared by the leaderboard and profile.
const TIERS = [
  { name: "Moon",     min: 0,   max: 99,       multiplier: 1.25, color: "#10386a" },
  { name: "Sun",      min: 100, max: 199,      multiplier: 1.5,  color: "#8a4200" },
  { name: "Star",     min: 200, max: 299,      multiplier: 1.75, color: "#7c3aed" },
  { name: "Gold",     min: 300, max: 499,      multiplier: 2.0,  color: "#f59e0b" },
  { name: "Platinum", min: 500, max: Infinity, multiplier: 2.5,  color: "#c0c0c0" },
];
function getTier(b3tr){ return TIERS.find(t => b3tr >= t.min && b3tr <= t.max) || TIERS[0]; }

// Consecutive-day streak based on submission dates ("YYYY-MM-DD"). The streak
// is allowed to end today OR yesterday, so it isn't reported as broken just
// because today's reading hasn't been logged yet.
function dayKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function computeStreak(subs){
  if (!subs || !subs.length) return 0;
  const days = new Set(subs.map(s => s.date));
  const d = new Date();
  if (!days.has(dayKey(d))) { d.setDate(d.getDate() - 1); if (!days.has(dayKey(d))) return 0; }
  let streak = 0;
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}


const ONBOARD_SLIDES = [
  { icon:"🌍", title:"Welcome to Green Utility Log", sub:"Track your home utilities, reduce your footprint, and earn B3TR rewards on VeChain.", color:"#1a3326" },
  { icon:"📸", title:"How to Photograph", sub:"Meter must be clear, readable and unobstructed. Take a fresh photo each time.", color:"#10386a" },
  { icon:"⚡", title:"Electric Meter", sub:"LCD display showing kWh. Usually 3000–4000 range. Earn 0.61 B3TR/kWh", color:"#8a4200" },
  { icon:"🔥", title:"Gas Meter", sub:"Rotating dials or LCD in m³. Earn 0.84 B3TR/m³", color:"#7a1c1c" },
  { icon:"💧", title:"Water Meter", sub:"Shows litres or m³. Often on outside wall. Earn 0.12 B3TR/L", color:"#10386a" },
  { icon:"☀️", title:"Solar Output", sub:"If you have panels, log your export in kWh. Earn 0.72 B3TR/kWh", color:"#264d3a" },
  { icon:"🏆", title:"Earn & Compete", sub:"Daily submissions build your streak. Climb the leaderboard and earn real B3TR.", color:"#3a1a6e" },
];

// ────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

// Pseudo-utility for the eco-mode bonus: it shows up in history/charts like a
// submission but has no meter reading, unit or rate.
const ECO_UTIL = { id: "eco", label: "Eco Mode", unit: "", rate: 0, ph: ["", ""], hint: "Appliance eco-mode bonus" };
function getUtil(id){ return id === "eco" ? ECO_UTIL : (UTILS.find(u=>u.id===id)||UTILS[0]); }
// Registered up-front (electric/gas/water); optional ones (solar) are added later.
const REQUIRED_UTILS = UTILS.filter(u => !u.optional);
const SOLAR_UTILS    = UTILS.filter(u => u.id === "solar");
function getColorBg(id, T) { return T[id+"Bg"] || T.electricBg; }

// ────────────────────────────────────────────────────────────────────────────
// SECURITY
// ────────────────────────────────────────────────────────────────────────────

// SHA-256 of the FULL image bytes. Returns null on failure so callers fail
// closed (treat as unverifiable) instead of waving the photo through.
async function hashImage(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const buf   = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
  } catch { return null; }
}

// Persisted set of photo hashes already used, so a refresh can't reset the
// duplicate-photo check. Bounded to the most recent entries. (Authoritative
// dedupe still belongs server-side.)
const USED_HASHES_KEY = "greenlog_used_hashes";
function loadUsedHashes() { try { return new Set(JSON.parse(localStorage.getItem(USED_HASHES_KEY) || "[]")); } catch { return new Set(); } }
const usedHashes = loadUsedHashes();
function rememberHash(h) {
  usedHashes.add(h);
  try { localStorage.setItem(USED_HASHES_KEY, JSON.stringify([...usedHashes].slice(-500))); } catch {}
}


// Cooldown between paid submissions per utility.
// ⚠️ TESTING: set to 0 so you can submit repeatedly. Restore to
// 20 * 60 * 60 * 1000 (20h) before going live. (Also set COOLDOWN_MS=0 in Render
// to disable the matching server-side cooldown while testing.)
const COOLDOWN_MS = 0; // 20 * 60 * 60 * 1000;
function getCooldowns() {
  try { return JSON.parse(localStorage.getItem("greenlog_cooldowns") || "{}"); } catch { return {}; }
}
function setCooldown(utilId) {
  const cd = getCooldowns(); cd[utilId] = Date.now();
  try { localStorage.setItem("greenlog_cooldowns", JSON.stringify(cd)); } catch {}
}
function getCooldownRemaining(utilId) {
  const cd = getCooldowns();
  if (!cd[utilId]) return 0;
  const rem = COOLDOWN_MS - (Date.now() - cd[utilId]);
  return rem > 0 ? rem : 0;
}
function fmtCooldown(ms) {
  const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000);
  return `${h}h ${m}m`;
}

function checkFileMeta(file) {
  const flags = [];
  const ageSec = (Date.now() - file.lastModified) / 1000;
  if (ageSec > 7200) flags.push("old_file");
  if (file.type === "image/png" && ageSec < 60) flags.push("likely_screenshot");
  if (file.size < 80_000) flags.push("file_too_small");
  return { ok: flags.length === 0, flags };
}

async function detectScreenshot(base64, mime) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale  = 200 / Math.max(img.width, img.height);
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        let rSum = 0, gSum = 0, bSum = 0, n = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          rSum += data[i]; gSum += data[i+1]; bSum += data[i+2];
        }
        const rMean = rSum/n, gMean = gSum/n, bMean = bSum/n;
        let variance = 0;
        for (let i = 0; i < data.length; i += 4) {
          variance += (data[i]-rMean)**2 + (data[i+1]-gMean)**2 + (data[i+2]-bMean)**2;
        }
        variance /= (n * 3);

        const isScreenshot = variance < 400;
        resolve({ isScreenshot, variance: Math.round(variance) });
      } catch { resolve({ isScreenshot: false, variance: 999 }); }
    };
    img.onerror = () => resolve({ isScreenshot: false, variance: 999 });
    img.src = `data:${mime};base64,${base64}`;
  });
}

let _tesseractReady = null;
async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (_tesseractReady) return _tesseractReady;
  _tesseractReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload  = () => resolve(window.Tesseract);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _tesseractReady;
}

// Otsu's method: pick the grey level that best separates dark/light pixels.
function otsuThreshold(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = t; }
  }
  return thr;
}

// Pre-process a meter photo for OCR: scale up, greyscale, then (optionally)
// binarise with Otsu so the digits become clean black-on-white. `invert` flips it
// (for light-on-dark LED/LCD displays). With `binarize=false` it returns an
// upscaled greyscale image — for sharp photos that often reads better than a hard
// black/white threshold (glare/colour can wreck binarisation). Returns a canvas.
async function preprocessForOCR(file, invert = false, binarize = true) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });
  const targetW = 1280;
  const scale = Math.min(4, targetW / (img.width || targetW)) || 1; // upscale small crops harder — helps 7-segment digits
  const w = Math.max(1, Math.round((img.width || targetW) * scale));
  const h = Math.max(1, Math.round((img.height || targetW) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const n = w * h;
    const gray = new Uint8Array(n);
    const hist = new Array(256).fill(0);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      gray[p] = g; hist[g]++;
    }
    const t = otsuThreshold(hist, n);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v;
      if (binarize) { v = gray[p] > t ? 255 : 0; if (invert) v = 255 - v; }
      else { v = gray[p]; }
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
  } catch {}
  try { URL.revokeObjectURL(img.src); } catch {}
  return canvas;
}

// Which OCR model fits each meter. Electric/gas/solar are digital 7-segment
// LCD/LED displays → the "ssd" model (trained on seven-segment digits) reads
// them far better than generic "eng". Water is a mechanical rolling counter →
// plain "eng" handles those printed digits.
const OCR_MODEL = { electric: "ssd", gas: "ssd", solar: "ssd", water: "eng" };
const SSD_LANG_PATH = "https://cdn.jsdelivr.net/gh/Shreeshrii/tessdata_ssd@master";

async function makeWorker(Tesseract, model) {
  const worker = model === "ssd"
    ? await Tesseract.createWorker("ssd", 1, { langPath: SSD_LANG_PATH, gzip: false, logger: () => {} })
    : await Tesseract.createWorker("eng", 1, { logger: () => {} });
  // PSM 7 = treat the image as a SINGLE TEXT LINE. A cropped meter reading is one
  // line of digits, so this reads it as one number instead of fragmenting it into
  // several (which is what made the picker grab a wrong/"random" figure).
  await worker.setParameters({ tessedit_char_whitelist: "0123456789.", tessedit_pageseg_mode: "7" });
  return worker;
}

function extractCandidates(data) {
  const cands = [];
  for (const wd of (data?.words || [])) {
    const m = (wd.text || "").match(/\d+(?:\.\d+)?/);
    if (!m) continue;
    const val = parseFloat(m[0]);
    if (!Number.isFinite(val)) continue;
    const bbox = wd.bbox || {};
    cands.push({ val, height: (bbox.y1 - bbox.y0) || 0, conf: wd.confidence || 0, digits: String(Math.trunc(val)).length });
  }
  return cands;
}

// Recognise `sources` (one or more pre-processed canvases) with a single worker
// of the given model. Runs TWO segmentation passes per source — single-line
// (PSM 7, ideal when the user boxed just the digits) and block (PSM 6, rescues
// crops that also caught a label line like "Geleverd laag:") — and merges the
// candidates; the plausibility picker downstream chooses the sane one.
async function recognizeAll(Tesseract, model, sources) {
  const worker = await makeWorker(Tesseract, model);
  let cands = [], text = "", confidence = 0;
  try {
    for (const psm of ["7", "6"]) {
      await worker.setParameters({ tessedit_pageseg_mode: psm }).catch(() => {});
      for (const src of sources) {
        if (!src) continue;
        const data = await worker.recognize(src).then(r => r.data).catch(() => null);
        if (!data) continue;
        cands = cands.concat(extractCandidates(data));
        if (data.text && data.text.trim().length > text.trim().length) text = data.text;
        confidence = Math.max(confidence, data.confidence || 0);
      }
    }
  } finally {
    try { await worker.terminate(); } catch {}
  }
  return { cands, text, confidence };
}

function ocrBackendBase() {
  const b = (OCR_API || REWARD_API || "").trim();
  return b ? b.replace(/\/$/, "") : "";
}

function blobToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Read an image via the backend's Google Vision OCR. Returns the detected text, or
// null when no backend is configured or the call fails (caller falls back to the
// in-browser OCR). Used for both the cropped reading and the full-photo serial.
// Ask the backend's OCR (Roboflow / custom model / Google Vision) to read an image.
// Returns { text, numbers } or null when no backend is set or every provider misses.
async function remoteOcr(file) {
  const base = ocrBackendBase();
  if (!base) return null;
  try {
    const image = await blobToBase64(file);
    if (!image) return null;
    const res = await fetch(`${base}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) return null;
    const text = typeof data.text === "string" ? data.text : "";
    const numbers = Array.isArray(data.numbers) ? data.numbers.map(Number).filter(Number.isFinite) : [];
    if (!text && !numbers.length) return null;
    return { text, numbers };
  } catch {
    return null;
  }
}

// Call Roboflow's hosted meter model directly from the app (no backend). Assembles
// the reading by sorting the detected digits left-to-right. Returns { text, numbers }
// or null when not configured / nothing detected.
async function roboflowDirect(file) {
  if (!ROBOFLOW_MODEL || !ROBOFLOW_API_KEY) return null;
  try {
    const image = await blobToBase64(file);
    if (!image) return null;
    const res = await fetch(`https://serverless.roboflow.com/${ROBOFLOW_MODEL}?api_key=${ROBOFLOW_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: image,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const preds = data?.predictions;
    if (!Array.isArray(preds) || !preds.length) return null;
    const text = preds
      .filter(p => (p.confidence ?? 1) >= 0.3)
      .sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
      .map(p => String(p.class ?? "").replace(/[^0-9.]/g, ""))
      .join("");
    if (!text) return null;
    const numbers = (text.match(/\d+(?:[.,]\d+)?/g) || []).map(s => parseFloat(s.replace(",", "."))).filter(Number.isFinite);
    return { text, numbers };
  } catch {
    return null;
  }
}

async function runOCR(file, claimedReading, utilId) {
  // Prefer a trained-model OCR when available — much more reliable than Tesseract.
  // First the backend's /ocr (key hidden), then Roboflow called straight from the
  // app (no backend needed). Fall back to in-browser OCR if both miss.
  const remote = await remoteOcr(file) || await roboflowDirect(file);
  if (remote) {
    const nums = remote.numbers.length
      ? remote.numbers
      : (remote.text.match(/\d+(?:[.,]\d+)?/g) || []).map(s => parseFloat(s.replace(",", "."))).filter(Number.isFinite);
    return { matched: true, ocrNums: nums, ocrBest: pickMeterReading(nums), ocrConfidence: 90, remote: true };
  }
  try {
    const Tesseract = await loadTesseract();
    const model = OCR_MODEL[utilId] || "eng";
    const digital = OCR_MODEL[utilId] === "ssd";

    // Binarised normal pass; for digital displays also a binarised INVERTED pass
    // (LED/LCD digits are often light-on-dark) — merge both for robustness.
    const normal = await preprocessForOCR(file, false).catch(() => file);
    const grey   = await preprocessForOCR(file, false, false).catch(() => null); // sharp photos read better un-binarised
    const sources = [normal];
    if (grey) sources.push(grey);
    if (digital) { const inv = await preprocessForOCR(file, true).catch(() => null); if (inv) sources.push(inv); }

    let { cands, text, confidence } = await recognizeAll(Tesseract, model, sources).catch(() => ({ cands: [], text: "", confidence: 0 }));
    // Fall back to eng if the 7-segment model couldn't load / found nothing.
    if (!cands.length && model !== "eng") {
      const r = await recognizeAll(Tesseract, "eng", [normal]).catch(() => ({ cands: [], text: "", confidence: 0 }));
      cands = r.cands; text = r.text || text; confidence = Math.max(confidence, r.confidence);
    }

    const nums = cands.length ? cands.map(c => c.val) : (text.match(/\d+(\.\d+)?/g) || []).map(Number);
    const best = pickBestReading(cands);
    if (!nums.length) return { matched: false, ocrNums: [], ocrBest: null, ocrConfidence: confidence, reason: "No digits detected" };

    const claimed = parseFloat(claimedReading);
    if (!claimed || isNaN(claimed)) return { matched: true, ocrNums: nums, ocrBest: best, ocrConfidence: confidence };

    const match = nums.find(n => Math.abs(n - claimed) / claimed < 0.08);
    if (!match) {
      const claimedStr = String(Math.round(claimed));
      const partialMatch = nums.find(n => String(Math.round(n)).includes(claimedStr.slice(-4)));
      if (partialMatch) return { matched: true, ocrNums: nums, ocrBest: best, ocrConfidence: confidence, partialMatch: true };
      return { matched: false, ocrNums: nums, ocrBest: best, ocrConfidence: confidence, reason: `OCR reads ${nums[0]} — entered ${claimed}` };
    }
    return { matched: true, ocrNums: nums, ocrBest: best, ocrConfidence: confidence };
  } catch (e) {
    return { matched: true, ocrNums: [], ocrBest: null, ocrConfidence: 0, ocrFailed: true };
  }
}

// Read all alphanumeric text from the FULL photo (serials are letters+digits, so
// the digit-only reading OCR can't see them). Used to confirm the registered meter
// number is actually visible on the photographed meter.
async function ocrFullText(file) {
  // Backend OCR first — a trained model / Vision reads serials far better.
  const remote = await remoteOcr(file);
  if (remote) return (remote.text || remote.numbers.join(" ")).toUpperCase();
  try {
    const Tesseract = await loadTesseract();
    if (!Tesseract?.createWorker) return "";
    const src = await preprocessForOCR(file, false, false).catch(() => file); // greyscale full image
    const worker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
    try {
      await worker.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", tessedit_pageseg_mode: "6" });
      const data = await worker.recognize(src).then(r => r.data).catch(() => null);
      return (data?.text || "").toUpperCase();
    } finally { try { await worker.terminate(); } catch {} }
  } catch { return ""; }
}

// Lenient check: does the registered meter number appear in the photo's text? Tries
// the whole number, then a strong contiguous segment (OCR often drops a character
// on a small serial label). Returns true only on a confident hit — a miss is left
// to the caller to FLAG (never block), since serials are small/hard to read.
function meterNoMatches(meterNo, text) {
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = norm(meterNo), t = norm(text);
  if (!m || m.length < 4 || !t) return false;
  if (t.includes(m)) return true;
  const segLen = Math.min(m.length, Math.max(6, Math.ceil(m.length * 0.6)));
  for (let i = 0; i + segLen <= m.length; i++) {
    if (t.includes(m.slice(i, i + segLen))) return true;
  }
  return false;
}

// From word-level OCR candidates, pick the largest digits (the display reading),
// tie-broken by confidence then digit count.
function pickBestReading(cands) {
  if (!cands || !cands.length) return null;
  const top = [...cands].sort((a, b) => (b.height - a.height) || (b.conf - a.conf) || (b.digits - a.digits))[0];
  return top ? top.val : null;
}

// Fallback when only a plain number list is available: most digits, then largest.
function pickMeterReading(nums) {
  if (!nums || !nums.length) return null;
  return [...nums].sort((a, b) => {
    const da = String(Math.trunc(a)).length, db = String(Math.trunc(b)).length;
    return db - da || b - a;
  })[0];
}

function computeSecurityScore({ ocrMatched, ocrFailed, ocrConfidence, plausible, anomaly, hashOk, fileOk, screenshotOk }) {
  let score = 100;
  if (!hashOk)       score -= 50;
  if (!fileOk)       score -= 20;
  if (!screenshotOk) score -= 25;
  if (ocrFailed)     score -= 15;            // couldn't read — soft penalty, not a free pass
  else if (!ocrMatched) score -= 30;
  if (!plausible)    score -= 40;
  if (anomaly)       score -= 30;
  if (ocrConfidence > 0 && ocrConfidence < 50) score -= 10;
  return Math.max(0, Math.round(score));
}

// ────────────────────────────────────────────────────────────────────────────
// CSS GENERATOR
// ────────────────────────────────────────────────────────────────────────────

function makeCSS(T) {
  return `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
html,body{background:${T.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${T.text};min-height:100vh;}
.app{max-width:420px;margin:0 auto;min-height:100vh;background:${T.bg};position:relative;transition:background .25s;}
/* dapp-kit's wallet modal defaults to z-index 100, which is BELOW our connect
   gate (410) — so on tap it would open hidden behind the gate. Force it on top. */
vdk-modal{--vdk-modal-z-index:99999 !important;}
.z1{position:relative;z-index:1;}
.scr{padding-bottom:85px;}

/* 100dvh (not 100vh) so mobile browser chrome can't push the CTA below the fold;
   overflow-y:auto keeps it usable on very short screens. */
.intro-screen{position:fixed;inset:0;background:linear-gradient(135deg,#1a3326 0%,#264d3a 100%);z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 28px 32px;height:100vh;height:100dvh;overflow-y:auto;}
.intro-hero{display:flex;flex-direction:column;align-items:center;gap:0;animation:intro-slideup .6s ease;}
.intro-icon{font-size:88px;margin-bottom:24px;animation:intro-bounce 1.2s ease-in-out infinite;display:block;}
.intro-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:32px;font-weight:800;color:#fff;text-align:center;line-height:1.2;letter-spacing:-0.6px;max-width:320px;margin-bottom:12px;}
.intro-sub{font-size:15px;color:rgba(255,255,255,0.75);text-align:center;line-height:1.6;max-width:320px;margin-bottom:24px;}
.intro-dots{display:flex;gap:6px;margin-top:32px;}
.intro-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.3);transition:all .3s;cursor:pointer;}
.intro-dot.active{width:24px;background:#4CAF50;border-radius:3px;}
.intro-btn{margin-top:40px;width:100%;max-width:280px;background:#4CAF50;border:none;border-radius:6px;padding:16px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:800;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:1.2px;box-shadow:0 8px 24px rgba(76,175,80,0.3);}
.intro-btn:hover{background:#45a049;box-shadow:0 12px 32px rgba(76,175,80,0.4);transform:translateY(-2px);}
.intro-skip{margin-top:14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.6);cursor:pointer;background:none;border:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.intro-skip:hover{color:rgba(255,255,255,0.9);}
@keyframes intro-slideup{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes intro-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}

.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:${T.white};border-bottom:1px solid ${T.border};position:sticky;top:0;z-index:20;transition:background .25s;gap:16px;}
.logo{display:flex;align-items:center;gap:10px;flex:1;}
.logo-mark{width:30px;height:30px;border-radius:4px;background:linear-gradient(135deg,${T.green1},${T.green2});display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 2px 8px ${T.shadow};font-weight:700;font-size:11px;}
.logo-name{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:800;color:${T.text};letter-spacing:-0.5px;line-height:1;}
.hdr-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.dark-toggle{width:30px;height:30px;border-radius:3px;background:transparent;border:1px solid ${T.border};display:flex;align-items:center;justify-content:center;cursor:pointer;color:${T.textMid};transition:all .15s;flex-shrink:0;font-size:14px;}
.dark-toggle:hover{border-color:${T.green3};color:${T.green3};}
.wallet-pill{display:flex;align-items:center;gap:6px;background:transparent;border:1px solid ${T.border};border-radius:3px;padding:5px 9px;cursor:pointer;transition:all .15s;flex-shrink:0;font-size:9px;font-weight:600;}
.wallet-pill:hover,.wallet-pill.connected{border-color:${T.green3};color:${T.green3};}
.wdot{width:5px;height:5px;border-radius:50%;background:${T.green3};animation:wpulse 2.5s infinite;flex-shrink:0;}
.wdot.off{background:${T.textSoft};animation:none;}
@keyframes wpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.25;transform:scale(.65)}}
.waddr{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:9px;color:${T.textMid};letter-spacing:0;}

.hero{margin:16px 14px 0;border-radius:5px;border:1px solid ${T.border};background:${T.card};padding:22px;position:relative;overflow:hidden;box-shadow:0 2px 6px ${T.shadow};}
.hero-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2.4px;color:${T.textSoft};margin-bottom:12px;}
.hero-amount{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:48px;font-weight:500;color:${T.text};line-height:1;letter-spacing:-1.5px;}
.hero-amount span{font-size:14px;font-weight:400;color:${T.textSoft};margin-left:8px;letter-spacing:0;}
.hero-usd{font-size:10px;color:${T.textSoft};margin-top:8px;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.hero-chips{display:flex;gap:0;margin-top:20px;padding-top:18px;border-top:1px solid ${T.border};}
.hchip{flex:1;padding-right:18px;margin-right:18px;border-right:1px solid ${T.border};}
.hchip:last-child{border-right:none;margin-right:0;padding-right:0;}
.hchip-val{font-size:20px;font-weight:600;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;line-height:1;}
.hchip-key{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};margin-top:5px;}

.sec{display:flex;align-items:center;gap:12px;margin:24px 14px 14px;padding:0;}
.sec-line{flex:1;height:1px;background:${T.border};}
.sec-txt{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:2.8px;color:${T.textSoft};}

.util-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 14px 16px;}
.ucard{background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:14px;transition:all .2s;cursor:pointer;box-shadow:0 1px 3px ${T.shadow};}
.ucard:hover{border-color:${T.green3};box-shadow:0 4px 12px ${T.shadowMd};}
.ucard-icon{width:32px;height:32px;border-radius:4px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:${T.green2};font-size:16px;}
.ucard-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.text};}
.ucard-reads{font-size:9px;color:${T.textSoft};margin-top:4px;font-weight:500;}
.ucard-b3tr{font-size:16px;font-weight:600;margin-top:9px;font-family:'SF Mono',Menlo,'Courier New',monospace;}

.calendar{margin:0 14px 14px;background:${T.card};border:1px solid ${T.border};border-radius:4px;padding:16px;}
.cal-hdr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:13px;}
.cal-month{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.cal-streak{font-size:11px;font-weight:500;color:${T.green3};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.cal-days-hdr{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:4px;}
.cal-day-name{text-align:center;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
.cal-cell{aspect-ratio:1;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:500;color:${T.textSoft};background:${T.bgAlt};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.cal-cell.has-sub{background:${T.green1};color:#fff;font-weight:600;}
.cal-cell.today{outline:1.5px solid ${T.green3};outline-offset:-1px;}
.cal-cell.empty{opacity:0;}

.hitem{margin:0 14px 6px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:13px 14px;display:flex;align-items:center;gap:12px;transition:all .2s;box-shadow:0 1px 3px ${T.shadow};}
.hitem:hover{border-color:${T.green3};box-shadow:0 4px 12px ${T.shadowMd};}
.hicon{width:32px;height:32px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.hinfo{flex:1;min-width:0;}
.htitle{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${T.text};}
.hdate{font-size:10px;color:${T.textSoft};font-family:'SF Mono',Menlo,'Courier New',monospace;margin-top:2px;}
.hright{text-align:right;flex-shrink:0;}
.hb3tr{font-size:14px;font-weight:500;color:${T.green1};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.hstatus{font-size:8px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:1px 5px;border-radius:1px;margin-top:4px;display:inline-block;}
.s-confirmed{background:${T.green5};color:${T.green2};border:1px solid ${T.green4};}

.sub-header{padding:20px 18px 10px;}
.sub-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:800;color:${T.text};letter-spacing:-0.4px;}
.sub-sub{font-size:11px;color:${T.textSoft};margin-top:4px;text-transform:uppercase;letter-spacing:.8px;}
.util-selector{display:grid;grid-template-columns:repeat(${UTILS.length},1fr);margin:0 14px 14px;border:1px solid ${T.border};border-radius:4px;overflow:hidden;}
.utab{display:flex;flex-direction:column;align-items:center;gap:3px;background:${T.card};border-right:1px solid ${T.border};padding:10px 4px;cursor:pointer;transition:background .12s,color .12s;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;border-radius:0;}
.utab:last-child{border-right:none;}
.utab:hover,.utab.active{background:var(--ubg);color:var(--uc);}
.utab-icon{font-size:18px;}

.verify-zone{margin:0 14px 12px;border-radius:4px;overflow:hidden;border:1px solid ${T.border};background:${T.card};transition:border-color .15s;cursor:pointer;}
.verify-zone:hover{border-color:${T.green3};}
.verify-zone.verified{background:${T.green5};}
.verify-zone.error{border-color:${T.gas};background:${T.gasBg};}
.vz-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:26px;text-align:center;}
.vz-icon{font-size:26px;margin-bottom:2px;}
.vz-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.vz-sub{font-size:10px;color:${T.textSoft};}
.vz-meter{font-size:10px;font-weight:700;font-family:'SF Mono',Menlo,'Courier New',monospace;color:${T.green1};background:${T.bgAlt};border:1px solid ${T.border};border-radius:3px;padding:2px 8px;letter-spacing:.4px;}
.vz-verifying{display:flex;flex-direction:column;align-items:center;gap:12px;padding:26px;}
.ai-ring{width:36px;height:36px;border-radius:50%;border:2px solid ${T.border};border-top-color:${T.green3};animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.ai-steps{display:flex;flex-direction:column;gap:2px;width:100%;}
.ai-step{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:500;color:${T.textSoft};padding:4px 10px;border-radius:2px;transition:color .2s;}
.ai-step.done{color:${T.green3};}
.ai-step.active{color:${T.text};font-weight:700;}
.ai-step-icon{font-size:10px;width:12px;text-align:center;}
.vz-result{padding:14px 16px;}
.vr-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.vr-badge{display:flex;align-items:center;gap:4px;background:transparent;border:1px solid ${T.green3};border-radius:2px;padding:3px 7px;font-size:9px;font-weight:700;color:${T.green3};text-transform:uppercase;letter-spacing:1px;}
.vr-confidence{font-size:10px;color:${T.textSoft};margin-left:auto;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.vr-summary{font-size:11px;color:${T.textMid};line-height:1.55;}
.vr-retry{font-size:9px;font-weight:700;color:${T.green3};margin-top:7px;cursor:pointer;text-transform:uppercase;letter-spacing:.8px;}
.vz-photo{width:100%;max-height:160px;object-fit:cover;border-radius:3px;border:1px solid ${T.border};margin-bottom:10px;display:block;}
.vz-photo.sm{max-height:90px;}

.form-card{margin:0 14px 14px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:16px;box-shadow:0 2px 6px ${T.shadow};}
.irow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
.igroup{display:flex;flex-direction:column;gap:4px;}
.ilabel{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};display:flex;align-items:center;gap:6px;}
.utag{border-radius:1px;padding:1px 4px;font-size:7px;font-weight:700;background:var(--ubg);color:var(--uc);border:1px solid var(--uborder);text-transform:uppercase;letter-spacing:.6px;}
.ifield{width:100%;background:${T.bg};border:1px solid ${T.border};border-radius:3px;padding:9px 10px;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:15px;outline:none;transition:border-color .15s;}
.ifield:focus{border-color:var(--uc,${T.green3});}
.ifield::placeholder{color:${T.textSoft};opacity:.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;}
.reward-preview{background:${T.bgAlt};border:1px solid ${T.border};border-left:3px solid ${T.green3};border-radius:3px;padding:12px 13px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.rp-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};}
.rp-rate{font-size:10px;color:${T.textSoft};margin-top:3px;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.rp-val{font-size:28px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;letter-spacing:-0.5px;}
.rp-b3tr{font-size:9px;color:${T.textSoft};text-transform:uppercase;letter-spacing:1.4px;}
.sbtn{width:100%;background:linear-gradient(135deg,${T.green1},${T.green2});border:none;border-radius:4px;padding:14px;color:${T.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 12px rgba(26,51,38,0.2);}
.sbtn:hover:not(:disabled){box-shadow:0 6px 20px rgba(26,51,38,0.3);transform:translateY(-1px);}
.sbtn:disabled{opacity:.4;cursor:not-allowed;}

.page-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:800;color:${T.text};padding:20px 18px 4px;letter-spacing:-0.4px;}
.chart-card{margin:0 14px 10px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:16px;box-shadow:0 2px 6px ${T.shadow};}
.chart-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;}
.chart-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.9px;color:${T.text};}
.chart-bars{display:flex;align-items:flex-end;gap:5px;height:68px;}
.chart-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;}
.chart-bar{width:100%;border-radius:1px 1px 0 0;min-height:3px;transition:all .3s;cursor:pointer;}
.chart-bar:hover{filter:brightness(1.2);}
.chart-val{font-size:8px;font-family:'SF Mono',Menlo,'Courier New',monospace;color:${T.textSoft};text-align:center;}
.chart-lbl{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:${T.textSoft};text-align:center;}

.lb-hero{margin:14px 14px 0;border-radius:4px;border:1px solid ${T.border};border-left:3px solid #7c3aed;background:${T.card};padding:20px;}
.lb-hero-rank{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:52px;font-weight:500;color:${T.text};line-height:1;letter-spacing:-2px;}
.lb-item{margin:0 14px 6px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:12px 14px;display:flex;align-items:center;gap:11px;transition:all .2s;box-shadow:0 1px 3px ${T.shadow};}
.lb-item:hover{border-color:${T.green3};box-shadow:0 4px 12px ${T.shadowMd};}
.lb-item.me{border-left:3px solid ${T.green3};}
.lb-rank{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:15px;font-weight:500;color:${T.textSoft};width:22px;text-align:center;flex-shrink:0;}
.lb-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${T.text};display:flex;align-items:center;gap:6px;}
.lb-b3tr{font-size:13px;font-weight:500;color:${T.green1};font-family:'SF Mono',Menlo,'Courier New',monospace;}

.profile-hero{margin:14px;border:1px solid ${T.border};border-left:3px solid ${T.green3};border-radius:4px;background:${T.card};padding:20px;}
.pname{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:${T.text};letter-spacing:-0.4px;}
.pstat-row{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin:0 14px 14px;}
.pstat{background:${T.card};border:1px solid ${T.border};border-radius:4px;padding:13px;text-align:center;}
.pstat-val{font-size:22px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;letter-spacing:-0.5px;}
.pstat-key{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};margin-top:3px;}
.notif-card{margin:0 14px 9px;background:${T.card};border:1px solid ${T.border};border-radius:4px;padding:15px;}
.notif-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:${T.text};margin-bottom:12px;}
.notif-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid ${T.border};}
.notif-row:last-child{border-bottom:none;padding-bottom:0;}
.notif-label{font-size:12px;font-weight:600;color:${T.text};}
.notif-sub{font-size:10px;color:${T.textSoft};margin-top:1px;}
.toggle{width:34px;height:19px;border-radius:10px;background:${T.border};border:none;cursor:pointer;position:relative;transition:background .18s;flex-shrink:0;}
.toggle.on{background:${T.green3};}
.toggle-dot{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.2);}
.toggle.on .toggle-dot{transform:translateX(15px);}
.setting-row{margin:0 14px 5px;background:${T.card};border:1px solid ${T.border};border-radius:4px;padding:11px 13px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:border-color .15s;}
.setting-row:hover{border-color:${T.green3};}
.sr-left{display:flex;align-items:center;gap:10px;}
.sr-icon{width:28px;height:28px;border-radius:3px;background:${T.bgAlt};display:flex;align-items:center;justify-content:center;font-size:13px;border:1px solid ${T.border};}
.sr-label{font-size:12px;font-weight:600;color:${T.text};}
.sr-sub{font-size:10px;color:${T.textSoft};margin-top:1px;}
.sr-right{display:flex;align-items:center;gap:6px;}

.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:420px;background:${T.navBg};border-top:1px solid ${T.border};display:grid;grid-template-columns:repeat(5,1fr);padding:10px 0 24px;z-index:20;backdrop-filter:blur(20px);}
.nitem{display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;border:none;background:none;color:${T.textSoft};transition:all .18s;padding:6px 2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;position:relative;}
.nitem.active{color:${T.green2};}
.nitem.active::before{content:'';position:absolute;top:-2px;left:50%;transform:translateX(-50%);width:20px;height:2px;background:${T.green3};border-radius:1px;}
.nicon{font-size:17px;width:30px;height:26px;display:flex;align-items:center;justify-content:center;color:inherit;}
.nlabel{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;}

.toast{position:fixed;top:72px;left:50%;transform:translateX(-50%);background:${T.text};border-radius:3px;padding:8px 14px;font-size:11px;font-weight:700;letter-spacing:.3px;color:${T.bg};z-index:200;white-space:nowrap;animation:toastin .18s ease;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
@keyframes toastin{from{opacity:0;transform:translateX(-50%) translateY(-5px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:100;display:flex;align-items:flex-end;justify-content:center;}
.modal{background:${T.card};border-radius:8px 8px 0 0;padding:24px 18px 36px;width:100%;max-width:420px;border-top:1px solid ${T.border};animation:slideup .22s ease;box-shadow:0 -4px 16px ${T.shadowMd};}
@keyframes slideup{from{transform:translateY(22px);opacity:0}to{transform:translateY(0);opacity:1}}
.modal-handle{width:28px;height:2px;background:${T.border};border-radius:1px;margin:0 auto 20px;}
.modal-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:${T.text};margin-bottom:4px;letter-spacing:-0.3px;}
.modal-opt{display:flex;align-items:center;gap:11px;background:${T.bg};border:1px solid ${T.border};border-radius:4px;padding:12px 13px;cursor:pointer;margin-bottom:7px;transition:border-color .15s;}
.modal-opt:hover{border-color:${T.green3};}
.modal-opt-icon{width:32px;height:32px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:16px;background:${T.bgAlt};border:1px solid ${T.border};}
.modal-opt-name{font-size:13px;font-weight:700;color:${T.text};}

.onboard{position:fixed;inset:0;background:${T.bg};z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 28px;}
.onboard::before,.onboard::after{content:"";display:block;flex:1 0 32px;}
.ob-icon{font-size:56px;margin-bottom:20px;animation:obpop .3s ease;}
.ob-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:28px;font-weight:800;text-align:center;line-height:1.2;margin-bottom:12px;letter-spacing:-0.6px;}
.ob-sub{font-size:14px;color:${T.textMid};text-align:center;line-height:1.7;max-width:320px;}
@keyframes obpop{from{transform:scale(.82);opacity:0}to{transform:scale(1);opacity:1}}
.ob-dots{display:flex;gap:5px;margin-top:28px;}
.ob-dot{width:5px;height:5px;border-radius:3px;background:${T.border};transition:all .22s;}
.ob-dot.active{width:18px;background:${T.green1};}
.ob-btn{margin-top:24px;width:100%;max-width:280px;background:linear-gradient(135deg,${T.green1},${T.green2});border:none;border-radius:4px;padding:15px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:1.2px;box-shadow:0 4px 12px rgba(26,51,38,0.2);}
.ob-btn:hover{box-shadow:0 6px 20px rgba(26,51,38,0.3);transform:translateY(-1px);}
.ob-skip{margin-top:13px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};cursor:pointer;background:none;border:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}

.spin-sm{width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block;}
.filter-row{display:flex;gap:5px;padding:0 14px 13px;overflow-x:auto;}
.fchip{flex-shrink:0;padding:4px 11px;border-radius:2px;font-size:9px;font-weight:700;cursor:pointer;border:1px solid ${T.border};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;transition:all .12s;text-transform:uppercase;letter-spacing:.8px;background:${T.card};color:${T.textSoft};}
.fchip.active{background:${T.green1};color:#fff;border-color:${T.green1};}
`;
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ════════════════════════════════════════════════════════════════════════════

// Full-screen gate shown after the intro until a wallet is connected, so the
// user signs in BEFORE reaching the dashboard. Once connected, every meter
// submission only needs a single signature (no separate login step).
function WalletGate({ onConnect, online }) {
  return (
    /* One centred block — logo, headline, copy and the CTA travel together, so the
       button is never pushed below the fold on a short/mobile viewport. */
    <div className="intro-screen" style={{ zIndex: 410 }}>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", width:"100%", maxWidth:340 }}>
        <div style={{ marginBottom:18, animation:"intro-bounce 1.2s ease-in-out infinite", display:"flex", justifyContent:"center" }}><LogoTile size={84} /></div>
        <h1 style={{ fontSize:27, fontWeight:800, color:"#fff", lineHeight:1.2, letterSpacing:"-0.6px", margin:"0 0 10px" }}>Connect your wallet</h1>
        <p style={{ fontSize:13.5, color:"rgba(255,255,255,0.8)", lineHeight:1.55, margin:"0 0 22px" }}>
          Sign in with VeWorld or WalletConnect to start logging meters and earning B3TR.
        </p>
        <button
          className="intro-btn"
          onClick={onConnect}
          disabled={!online}
          style={{ marginTop:0, ...(!online ? { opacity:0.5, cursor:"not-allowed" } : null) }}
        >
          {online ? "Connect Wallet" : "You're offline"}
        </button>
        <div style={{ marginTop:14, fontSize:11, color:"rgba(255,255,255,0.55)", lineHeight:1.5 }}>
          Your wallet stays in your control — we never see your keys.
        </div>
      </div>
    </div>
  );
}

// ── Brand sprout mark (matches the app logo + VeBetterDAO listing assets) ──
function SproutIcon({ size = 20, color = "#fff" }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden="true" style={{ display:"block" }}>
      <path d="M256 380 C 247 330 250 300 256 256" fill="none" stroke={color} strokeWidth="20" strokeLinecap="round"/>
      <path d="M256 268 C 238 244 238 212 256 184 C 274 212 274 244 256 268 Z" fill={color}/>
      <path d="M254 300 C 300 314 358 288 382 232 C 322 218 268 250 254 300 Z" fill={color}/>
      <path d="M258 300 C 212 314 154 288 130 232 C 190 218 244 250 258 300 Z" fill={color}/>
    </svg>
  );
}

// Rounded green-gradient tile containing the sprout — the app's logo lockup.
function LogoTile({ size = 30, shadow = true }) {
  return (
    <div style={{
      width:size, height:size, borderRadius:Math.round(size*0.23),
      background:"linear-gradient(135deg,#142c1e,#214834 55%,#3c6a50)",
      display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
      boxShadow: shadow ? "0 6px 18px rgba(0,0,0,0.28)" : "none",
    }}>
      <SproutIcon size={Math.round(size*0.62)} />
    </div>
  );
}

function IntroScreen({ onStart }) {
  const slides = [
    { icon: 'logo', title: 'Welcome to Green Utility Log', sub: 'Track your electric, gas, water & solar meters. Earn real B3TR rewards on VeChain.' },
    { icon: '📸', title: 'Verify Your Meters', sub: 'Take a photo of your meter. AI-powered OCR verifies readings instantly.' },
    { icon: '💰', title: 'Earn B3TR Rewards', sub: 'Earn B3TR for logging your meter and saving energy. Testnet beta — test tokens, no real-world value yet.' },
    { icon: '🏆', title: 'Climb the Leaderboard', sub: 'Compete globally. Unlock achievement badges. Build your sustainability streak.' },
  ];
  
  const [slide, setSlide] = useState(0);
  const s = slides[slide];
  const isLast = slide === slides.length - 1;
  const progress = ((slide + 1) / slides.length) * 100;

  return (
    <div className="intro-screen">
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"rgba(255,255,255,0.1)"}}>
        <div style={{height:"100%",background:"#4CAF50",width:`${progress}%`,transition:"width 0.3s ease"}}/>
      </div>

      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",width:"100%"}}>
        <div style={{textAlign:"center"}}>
          {s.icon === 'logo'
            ? <div style={{marginBottom:20,animation:"intro-bounce 1.2s ease-in-out infinite",display:"flex",justifyContent:"center"}}><LogoTile size={112} /></div>
            : <div style={{fontSize:72,marginBottom:20,animation:"intro-bounce 1.2s ease-in-out infinite"}}>{s.icon}</div>}
          <h1 style={{fontSize:32,fontWeight:800,color:"#fff",lineHeight:1.2,letterSpacing:"-0.6px",marginBottom:12,maxWidth:300}}>{s.title}</h1>
          <p style={{fontSize:14,color:"rgba(255,255,255,0.8)",lineHeight:1.6,maxWidth:320,marginBottom:24}}>{s.sub}</p>
        </div>
      </div>

      <div style={{display:"flex",gap:6,justifyContent:"center",marginBottom:32}}>
        {slides.map((_, i) => (
          <div 
            key={i} 
            style={{
              width: i === slide ? 24 : 6,
              height: 6,
              borderRadius: 3,
              background: i === slide ? "#4CAF50" : "rgba(255,255,255,0.3)",
              transition: "all 0.3s",
              cursor: "pointer"
            }}
            onClick={() => setSlide(i)}
          />
        ))}
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%",maxWidth:280}}>
        <button 
          onClick={() => isLast ? onStart() : setSlide(s => s + 1)}
          style={{
            width: "100%",
            background: "#4CAF50",
            border: "none",
            borderRadius: 6,
            padding: 14,
            color: "#fff",
            fontSize: 13,
            fontWeight: 800,
            cursor: "pointer",
            transition: "all 0.2s",
            textTransform: "uppercase",
            letterSpacing: "1.2px",
            boxShadow: "0 8px 24px rgba(76,175,80,0.3)"
          }}
          onMouseEnter={e => {
            e.target.style.background = "#45a049";
            e.target.style.boxShadow = "0 12px 32px rgba(76,175,80,0.4)";
            e.target.style.transform = "translateY(-2px)";
          }}
          onMouseLeave={e => {
            e.target.style.background = "#4CAF50";
            e.target.style.boxShadow = "0 8px 24px rgba(76,175,80,0.3)";
            e.target.style.transform = "translateY(0)";
          }}
        >
          {isLast ? '🚀 Get Started' : 'Continue →'}
        </button>
        
        {!isLast && (
          <button 
            onClick={onStart}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.6)",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: "1px",
              padding: 8
            }}
            onMouseEnter={e => e.target.style.color = "rgba(255,255,255,0.9)"}
            onMouseLeave={e => e.target.style.color = "rgba(255,255,255,0.6)"}
          >
            Skip →
          </button>
        )}
      </div>

      <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:16}}>
        Slide {slide + 1} of {slides.length}
      </div>
    </div>
  );
}

function BaselineOnboarding({ onDone, utils, existingBaselines, existingMeters, editMode, T }) {
  // Which utilities this screen registers. Defaults to the required ones
  // (electric/gas/water); solar is added separately as an optional extra.
  const shown = (utils && utils.length) ? utils : UTILS.filter(u => !u.optional);
  const [baselines, setBaselines] = useState(existingBaselines || { electric:"", gas:"", water:"", solar:"" });
  const [meters, setMeters]       = useState(existingMeters || { electric:"", gas:"", water:"", solar:"" });

  // Baseline readings are typed in by hand — registration earns no B3TR, so it
  // needs no photo/OCR step. Photo verification only guards the reward-earning
  // submissions on the Submit screen.

  const isSolarOnly = shown.length === 1 && shown[0].id === "solar";
  // Anti-fraud: a meter that's already registered is LOCKED — you can view it but
  // not change the number or baseline (which would let you reset cooldowns or
  // inflate the next usage delta). Only not-yet-registered meters are editable.
  const isLocked = (u) => editMode && (existingMeters?.[u.id] || "").trim().length > 0;
  const allLocked = shown.length > 0 && shown.every(isLocked);
  // In edit mode every shown meter is expected; on first setup only the
  // non-optional ones are required to continue.
  const required = editMode ? shown : shown.filter(u => !u.optional);
  const hasNo = (u) => (meters[u.id] || "").trim().length > 0;
  // The baseline is the user's REAL current reading — the starting point every
  // future usage is measured from. It's required (no invented default), otherwise
  // the first submission would compute a nonsense delta.
  const hasBaseline = (u) => { const v = parseFloat(baselines[u.id]); return Number.isFinite(v) && v >= 0; };
  // A meter is complete only with BOTH its number and a starting reading. Optional
  // meters need a baseline only once their number is filled in.
  const allMetersFilled = required.every(hasNo) && shown.filter(u => required.includes(u) || hasNo(u)).every(hasBaseline);

  const handleDone = () => {
    if (!allMetersFilled) return;
    // Merge into the existing data so editing one meter never wipes the others.
    const nextBaselines = { ...(existingBaselines || {}) };
    const nextMeters    = { ...(existingMeters || {}) };
    for (const u of shown) {
      // Use the reading the user actually entered; fall back only to an existing
      // (already-registered) baseline, never to an invented default.
      nextBaselines[u.id] = (baselines[u.id] || "").trim() || (existingBaselines?.[u.id] || "");
      nextMeters[u.id]    = (meters[u.id] || "").trim();
    }
    saveBaselines(nextBaselines);
    saveMeters(nextMeters);
    onDone(nextBaselines, nextMeters);
  };

  const title = allLocked ? "Your Meters" : (isSolarOnly ? "Add Solar Panels" : (editMode ? "Edit Your Meters" : "Register Your Meters"));
  const sub = allLocked
    ? "Your registered meters are locked to keep your readings tamper-proof. A meter number and baseline can't be changed once set."
    : isSolarOnly
      ? "Generating your own power? Add your solar meter number and its current export reading."
      : "Enter each meter number and its current reading. That first reading becomes your baseline (starting point) — future submissions measure usage from it, so enter the real number on your meter now.";

  return (
    <div className="onboard">
      <div className="ob-icon">{isSolarOnly ? "☀️" : "⚙️"}</div>
      <div className="ob-title" style={{color:T.text}}>{title}</div>
      <div className="ob-sub" style={{color:T.textMid}}>{sub}</div>
      <div style={{width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8,marginTop:20}}>
        {shown.map(u => {
          const needsMeter = required.includes(u);
          const locked = isLocked(u);
          const lockedInput = {width:"100%",boxSizing:"border-box",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:3,padding:"7px 10px",fontSize:13,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.textMid,outline:"none",marginBottom:6,cursor:"not-allowed"};
          const editInput = (ok) => ({width:"100%",boxSizing:"border-box",background:T.bg,border:`1px solid ${ok ? T.border : "rgba(220,80,60,0.7)"}`,borderRadius:3,padding:"7px 10px",fontSize:14,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.text,outline:"none",marginBottom:6});
          return (
          <div key={u.id} style={{display:"flex",alignItems:"flex-start",gap:12,background:T.card,borderRadius:4,padding:"10px 14px",border:`1px solid ${T.border}`}}>
            <span style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",color:T[u.id]||T.text,flexShrink:0,marginTop:2}}>{UTIL_ICONS[u.id]}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginBottom:4}}>{u.label} <span style={{fontWeight:400}}>({u.unit})</span>{locked ? <span style={{fontWeight:400,textTransform:"none",letterSpacing:0,color:T.eco||T.text}}> · 🔒 locked</span> : (!needsMeter && <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}> · optional</span>)}</div>
              <input
                type="text"
                readOnly={locked}
                placeholder={needsMeter ? "Meter / EAN number" : "Meter / EAN number (optional)"}
                value={meters[u.id]}
                onChange={locked ? undefined : (e => setMeters(m => ({...m,[u.id]:e.target.value})))}
                style={locked ? lockedInput : editInput((meters[u.id]||"").trim() || !needsMeter)}
              />
              {locked ? (
                <input type="text" readOnly value={`${baselines[u.id] || ""} ${u.unit}`} style={lockedInput} />
              ) : (
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                placeholder={`Current reading on the meter · e.g. ${u.ph[0]}`}
                value={baselines[u.id]}
                onChange={e => setBaselines(b => ({...b,[u.id]:e.target.value}))}
                style={editInput(hasBaseline(u))}
              />
              )}
            </div>
          </div>
          );
        })}
      </div>
      {!isSolarOnly && !allLocked && <div style={{fontSize:11,color:T.textSoft,marginTop:16,textAlign:"center"}}>ℹ️ Got solar panels? Add them later in Settings.</div>}
      {allLocked && <div style={{fontSize:11,color:T.textSoft,marginTop:16,textAlign:"center"}}>🔒 Locked to prevent fraud. To replace a meter, contact support.</div>}
      {!allMetersFilled && <div style={{fontSize:11,color:"#e0553d",marginTop:6,textAlign:"center"}}>Enter a meter number <b>and</b> its current reading for every meter to continue.</div>}
      <button className="ob-btn" onClick={handleDone} disabled={!allMetersFilled} style={!allMetersFilled?{opacity:.5,cursor:"not-allowed"}:undefined}>{allLocked ? "Done" : (isSolarOnly ? "Save Solar Meter" : "Complete Setup")}</button>
    </div>
  );
}

function Onboarding({ onDone }) {
  const [slide, setSlide] = useState(0);
  const s = ONBOARD_SLIDES[slide];
  const isLast = slide === ONBOARD_SLIDES.length - 1;

  return (
    <div className="onboard">
      <div className="ob-icon">{s.icon}</div>
      <h2 className="ob-title" style={{color:s.color}}>{s.title}</h2>
      <p className="ob-sub">{s.sub}</p>
      <div className="ob-dots">
        {ONBOARD_SLIDES.map((_, i) => (
          <div key={i} className={`ob-dot ${i === slide ? 'active' : ''}`} onClick={() => setSlide(i)} />
        ))}
      </div>
      <button className="ob-btn" onClick={() => isLast ? onDone() : setSlide(slide + 1)}>
        {isLast ? 'Start Tracking' : 'Continue →'}
      </button>
      {!isLast && <button className="ob-skip" onClick={onDone}>Skip</button>}
    </div>
  );
}

// Keep a crop box inside the displayed image bounds.
function clampBox(b, dd) {
  if (!dd) return b;
  const nb = { ...b };
  nb.w = Math.max(48, Math.min(nb.w, dd.w));
  nb.h = Math.max(28, Math.min(nb.h, dd.h));
  nb.x = Math.max(0, Math.min(nb.x, dd.w - nb.w));
  nb.y = Math.max(0, Math.min(nb.y, dd.h - nb.h));
  return nb;
}

// Full-screen "align the reading" step: the user drags/resizes a box over the
// meter's digits, and only that region is handed to OCR — exactly how purpose-built
// meter apps avoid reading barcodes/serials/nameplate text. Returns a cropped Blob
// (or null = use the whole photo) to the caller.
function MeterCropper({ imgUrl, onCancel, onConfirm }) {
  const imgRef = useRef(null);
  const dRef = useRef(null);            // displayed + natural dimensions
  const drag = useRef(null);
  const [d, setD] = useState(null);
  const [box, setBox] = useState(null); // {x,y,w,h} in displayed pixels

  useEffect(() => {
    const move = (e) => {
      const dr = drag.current; if (!dr) return;
      const dx = e.clientX - dr.sx, dy = e.clientY - dr.sy;
      const next = dr.mode === "move"
        ? { ...dr.box, x: dr.box.x + dx, y: dr.box.y + dy }
        : { ...dr.box, w: dr.box.w + dx, h: dr.box.h + dy };
      setBox(clampBox(next, dRef.current));
    };
    const up = () => { drag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const onImgLoad = () => {
    const im = imgRef.current; if (!im) return;
    const w = im.clientWidth, h = im.clientHeight;
    const dd = { w, h, natW: im.naturalWidth || w, natH: im.naturalHeight || h };
    dRef.current = dd; setD(dd);
    const bw = w * 0.8, bh = Math.min(h * 0.3, h);   // readings are wide & short
    setBox({ x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh });
  };

  const onDown = (mode) => (e) => {
    e.preventDefault(); e.stopPropagation();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, box };
  };

  const scan = () => {
    if (!box || !d) { onConfirm(null); return; }
    try {
      const sx = d.natW / d.w, sy = d.natH / d.h;
      const cw = Math.max(1, Math.round(box.w * sx)), ch = Math.max(1, Math.round(box.h * sy));
      const canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      canvas.getContext("2d").drawImage(imgRef.current, box.x * sx, box.y * sy, cw, ch, 0, 0, cw, ch);
      canvas.toBlob((blob) => onConfirm(blob || null), "image/jpeg", 0.95);
    } catch { onConfirm(null); }
  };

  const btn = { flex: 1, padding: "13px", borderRadius: 6, fontSize: 12, fontWeight: 800, cursor: "pointer" };
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(10,18,14,0.96)",zIndex:360,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{color:"#fff",fontSize:14,fontWeight:800,marginBottom:4,textAlign:"center"}}>Align the reading</div>
      <div style={{color:"rgba(255,255,255,0.7)",fontSize:11,marginBottom:14,textAlign:"center"}}>Box ONLY the digits row (e.g. 003755) — leave out any text above or below it</div>
      <div style={{position:"relative",maxWidth:"100%",maxHeight:"60vh",touchAction:"none"}}>
        <img ref={imgRef} src={imgUrl} onLoad={onImgLoad} alt="" draggable={false}
          style={{display:"block",maxWidth:"100%",maxHeight:"60vh",userSelect:"none",pointerEvents:"none",borderRadius:6}} />
        {box && (
          <div onPointerDown={onDown("move")}
            style={{position:"absolute",left:box.x,top:box.y,width:box.w,height:box.h,border:"2px solid #4CAF50",boxShadow:"0 0 0 9999px rgba(0,0,0,0.5)",borderRadius:4,cursor:"move",touchAction:"none"}}>
            <div onPointerDown={onDown("resize")}
              style={{position:"absolute",right:-13,bottom:-13,width:28,height:28,borderRadius:"50%",background:"#4CAF50",border:"2px solid #fff",cursor:"nwse-resize",touchAction:"none"}} />
          </div>
        )}
      </div>
      <div style={{display:"flex",gap:10,marginTop:20,width:"100%",maxWidth:340}}>
        <button onClick={()=>onConfirm(null)} style={{...btn,border:"1px solid rgba(255,255,255,0.3)",background:"transparent",color:"#fff"}}>Whole photo</button>
        <button onClick={scan} style={{...btn,flex:2,border:"none",background:"#4CAF50",color:"#fff"}}>Scan this area</button>
      </div>
      <button onClick={onCancel} style={{marginTop:12,background:"transparent",border:"none",color:"rgba(255,255,255,0.7)",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",cursor:"pointer"}}>Retake</button>
    </div>
  );
}

function VerifyZone({ utilId, onVerified, onReset, onOcrReading, reading, prevRead, subs, meterNo, T }) {
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null);
  const [secScore, setSecScore] = useState(null);
  const [aiStep, setAiStep] = useState(0);
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileInputRef = useRef(null);
  const origFileRef = useRef(null);
  const cooldownMs = getCooldownRemaining(utilId);

  // Release the preview object URL when it changes or the component unmounts.
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const runVerify = async (file, ocrSource) => {
    setPhase("verifying"); setAiStep(0);
    const mime   = file.type;
    let base64;
    try {
      // Reject on read errors too — without onerror a failed read leaves the promise
      // unsettled and the UI stuck on "verifying" with no way out but a reload.
      base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(r.error || new Error("could not read the photo"));
        r.readAsDataURL(file);
      });
    } catch {
      setResult({ summary: "Couldn't read that photo — please tap the camera and take it again." });
      setPhase("error");
      return;
    }
    const fraudFlags = [];
    let   fraudReason = null;

    setAiStep(0);
    const imgHash = await hashImage(base64);
    // Only a genuine REUSED photo hard-blocks. A null hash (crypto.subtle missing
    // on some Android webviews) no longer fails closed — the server hashes every
    // upload and is the authoritative dedupe, so we don't block a real photo just
    // because the browser couldn't compute its hash.
    const isDuplicate = !!imgHash && usedHashes.has(imgHash);
    const hashOk = !isDuplicate;
    if (isDuplicate) {
      fraudFlags.push("duplicate_photo");
      fraudReason = "Duplicate photo detected. Each submission needs a fresh photo.";
    }

    setAiStep(1);
    const fileMeta = checkFileMeta(file);
    if (!fileMeta.ok) fraudFlags.push(...fileMeta.flags);

    setAiStep(2);
    const ssCheck = await detectScreenshot(base64, mime);
    if (ssCheck.isScreenshot) { fraudFlags.push("screenshot_detected"); fraudReason = fraudReason || "Screenshot detected. Please take a real photo of your physical meter."; }

    setAiStep(3);
    // OCR runs on the cropped region (if the user boxed the reading) so it ignores
    // barcodes/serials/nameplate text; all fraud checks above use the full photo.
    const ocrResult = await runOCR(ocrSource || file, reading, utilId);
    // Pre-fill Current from the photo — but only with a number that makes sense
    // against your previous reading (a real new reading sits just above it). This
    // rejects barcodes/serials/"0" the OCR picks off the nameplate; if nothing is
    // convincing the field stays empty rather than filled with a wrong number.
    const guess = pickPlausibleReading(ocrResult.ocrNums || [], { utilId, prevRead, preferred: ocrResult.ocrBest });
    // Only auto-fill when we're reasonably sure: either it lines up with your
    // previous reading (anchored), or the OCR read it with decent confidence.
    // Otherwise leave Current blank — better to type it than to fight a wrong guess.
    const hasAnchor = Number.isFinite(parseFloat(prevRead));
    if (guess != null && (hasAnchor || (ocrResult.ocrConfidence || 0) >= 60)) onOcrReading?.(String(guess));
    if (!ocrResult.matched && !ocrResult.ocrFailed) {
      fraudFlags.push("ocr_mismatch");
      fraudReason = fraudReason || ocrResult.reason;
    }

    // Meter-number check (lenient): is the registered meter number visible on the
    // FULL photo? Found = extra confidence; not found = flag for review (never block
    // — serials are small and hard to read). null when there's no number to check.
    let meterNoConfirmed = null;
    if (meterNo) meterNoConfirmed = meterNoMatches(meterNo, await ocrFullText(file));

    // Plausibility/anomaly run on CONSUMPTION (current − previous), not the
    // absolute meter value, otherwise a normal reading like 3847 always trips.
    const r = parseFloat(reading), p = parseFloat(prevRead);
    const usageVal   = (Number.isFinite(r) && Number.isFinite(p) && r >= p) ? +(r - p).toFixed(2) : null;
    const plausCheck = usageVal != null ? checkPlausibility(utilId, usageVal) : { ok:true };
    const anomCheck  = usageVal != null ? checkAnomaly(utilId, usageVal, subs) : { ok:true, anomaly:false };
    if (!plausCheck.ok) { fraudFlags.push("implausible_reading"); fraudReason = fraudReason || plausCheck.reason; }
    if (anomCheck.anomaly) { fraudFlags.push("anomaly"); fraudReason = fraudReason || anomCheck.reason; }

    setAiStep(4);

    const score = computeSecurityScore({
      ocrMatched:    ocrResult.matched,
      ocrFailed:     ocrResult.ocrFailed,
      ocrConfidence: ocrResult.ocrConfidence || 0,
      plausible:     plausCheck.ok,
      anomaly:       anomCheck.anomaly,
      hashOk,
      fileOk:        fileMeta.ok,
      screenshotOk:  !ssCheck.isScreenshot,
    });
    setSecScore(score);

    if (hashOk) rememberHash(imgHash);

    // The client check is a UX pre-filter, not the gate — the server re-verifies
    // every photo (real image + authoritative hash dedupe) before paying out. So
    // only a genuine REUSED photo blocks here. Other heuristics (old-file age,
    // screenshot guess, OCR mismatch, anomaly) false-positive on real phone photos,
    // so they no longer stop the submission — they ride along as soft review flags.
    const blocked  = isDuplicate;
    const verified = !blocked;
    const softFlags = fraudFlags.filter(f => f !== "duplicate_photo");
    const meterNote = meterNoConfirmed === true ? " ✓ Meter # confirmed on photo."
      : meterNoConfirmed === false ? " ⚠ Meter # not detected — flagged for review."
      : "";
    const summary  = blocked
      ? (fraudReason || "Verification failed. Please retake the photo.")
      : `${getUtil(utilId).label} meter${meterNo ? ` #${meterNo}` : ""} accepted.${softFlags.length ? " ⚠ Some checks were soft — flagged for review." : ` ${ocrResult.ocrNums?.length ? "OCR read: " + ocrResult.ocrNums.slice(0,2).join(", ") + "." : "Reading accepted."}`}${meterNote}`;

    const finalResult = { verified, fraudFlags, fraudReason, summary, ocrNums: ocrResult.ocrNums, ocrFailed: !!ocrResult.ocrFailed, meterNoConfirmed, secScore: score, anomCheck, usageVal };
    setResult(finalResult);
    setPhase(verified ? "verified" : "error");
    if (verified) onVerified(finalResult, base64, mime);
  };

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = "";
    // Freshness gate: a camera capture is seconds old. A file that is verifiably
    // older was picked from the gallery or downloaded (where AI-generated images
    // come from) — reject it and ask for a live shot.
    if (photoTooOld(file)) {
      setResult({ summary: "This photo wasn't taken just now. Tap the camera and photograph your meter live — gallery uploads and saved images aren't accepted." });
      setPhase("error");
      return;
    }
    origFileRef.current = file;
    setPhotoUrl(URL.createObjectURL(file));   // show a preview of what was captured
    setPhase("crop");                          // let the user box the reading first
  };

  const reset = () => { setPhase("idle"); setResult(null); setSecScore(null); setPhotoUrl(null); origFileRef.current = null; onReset(); };

  // Desktop has no phone camera — and a file picker invites downloaded or
  // AI-generated images. Block capture entirely outside a mobile browser.
  if (phase === "idle" && !IS_MOBILE) return (
    <div className="verify-zone">
      <div className="vz-idle">
        <div className="vz-icon">📵</div>
        <div className="vz-title">Phone camera required</div>
        <div className="vz-sub">Open this app on your phone (VeWorld's in-app browser) and photograph the meter live — file uploads aren't accepted.</div>
      </div>
    </div>
  );

  if (phase === "idle") return (
    <div className="verify-zone" onClick={() => cooldownMs === 0 && fileInputRef.current?.click()}>
      <div className="vz-idle">
        <div className="vz-icon">📸</div>
        <div className="vz-title">Verify Meter</div>
        {meterNo && <div className="vz-meter">Meter #{meterNo}</div>}
        <div className="vz-sub">{cooldownMs > 0 ? `Next submission in ${fmtCooldown(cooldownMs)}` : "Tap to photograph with your camera"}</div>
      </div>
      <input type="file" ref={fileInputRef} onChange={handleFile} accept="image/*" style={{display:"none"}} capture="environment" />
    </div>
  );

  if (phase === "crop" && photoUrl) return (
    <>
      <div className="verify-zone">
        <div className="vz-idle">
          <div className="vz-icon">✂️</div>
          <div className="vz-title">Align the reading</div>
          <div className="vz-sub">Box only the digits row, then scan</div>
        </div>
      </div>
      <MeterCropper imgUrl={photoUrl} onCancel={reset} onConfirm={(cropBlob) => runVerify(origFileRef.current, cropBlob)} />
    </>
  );

  if (phase === "verifying") return (
    <div className="verify-zone">
      <div className="vz-verifying">
        {photoUrl && <img className="vz-photo sm" src={photoUrl} alt="Captured meter" />}
        <div className="ai-ring"/>
        <div className="ai-steps">
          {["Hash check", "File meta", "Screenshot detect", "OCR", "Security score"].map((s, i) => (
            <div key={i} className={`ai-step ${i < aiStep ? 'done' : i === aiStep ? 'active' : ''}`}>
              <span className="ai-step-icon">{i < aiStep ? '✓' : i === aiStep ? '●' : '○'}</span>
              {s}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (phase === "error" && result) return (
    <div className="verify-zone error">
      <div className="vz-result">
        {photoUrl && <img className="vz-photo" src={photoUrl} alt="Captured meter" />}
        <div style={{fontSize:12,fontWeight:700,color:T?.gas||"#7a1c1c",marginBottom:8}}>⚠️ Verification failed</div>
        <div style={{fontSize:11,color:T?.textMid||"#666",marginBottom:12}}>{result.summary}</div>
        <div className="vr-retry" onClick={reset}>Try again</div>
      </div>
    </div>
  );

  if (phase === "verified" && result) return (
    <div className="verify-zone verified">
      <div className="vz-result">
        {photoUrl && <img className="vz-photo" src={photoUrl} alt="Captured meter" />}
        <div className="vr-header">
          <div className="vr-badge">✓ Verified</div>
          <div className="vr-confidence">Score: {result.secScore}</div>
        </div>
        <div className="vr-summary">{result.summary}</div>
        {result.anomCheck?.anomaly && (
          <div style={{marginTop:12,padding:10,background:T?.electricBg||"#fff3e0",border:`1px solid ${T?.electricBorder||"#FFB74D"}`,borderRadius:4}}>
            <div style={{fontSize:11,fontWeight:700,color:T?.electric||"#E65100"}}>⚠️ High Usage Detected</div>
            <div style={{fontSize:10,color:T?.textMid||"#666",marginTop:4}}>This reading is {result.anomCheck.avg ? `${Math.round((result.usageVal/result.anomCheck.avg - 1)*100)}%` : "significantly"} higher than your average.</div>
            <div style={{fontSize:10,color:T?.electric||"#E65100",marginTop:4,fontWeight:600}}>Allow anyway? Tap Submit to continue.</div>
          </div>
        )}
        <div className="vr-retry" onClick={reset}>Retake photo</div>
      </div>
    </div>
  );

  return null;
}

function StreakCalendar({ subs }) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - firstDay.getDay());

  const dates = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }

  const dateStrs = new Set(subs.map(s => s.date));
  const todayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const currentStreak = computeStreak(subs);

  return (
    <div className="calendar">
      <div className="cal-hdr">
        <div className="cal-month">{today.toLocaleString('en', { month: 'long' })} {year}</div>
        <div className="cal-streak">🔥 {currentStreak} day{currentStreak !== 1 ? 's' : ''}</div>
      </div>
      <div className="cal-days-hdr">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => <div key={d} className="cal-day-name">{d}</div>)}
      </div>
      <div className="cal-grid">
        {dates.map((d, i) => {
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const hasSub = dateStrs.has(dateStr);
          const isToday = dateStr === todayStr;
          const inMonth = d.getMonth() === month;
          return (
            <div key={i} className={`cal-cell ${!inMonth ? 'empty' : hasSub ? 'has-sub' : ''} ${isToday ? 'today' : ''}`}>
              {inMonth ? d.getDate() : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ECO_APPLIANCE_LABELS = { washer: "Washing machine", dryer: "Dryer", dishwasher: "Dishwasher" };

function HistItem({ s, T }) {
  const util = getUtil(s.type);
  const isEco = s.type === "eco";
  const delta = isEco
    ? (ECO_APPLIANCE_LABELS[s.appliance] || "Eco run")
    : (parseFloat(s.cur) - parseFloat(s.prev)).toFixed(2);
  // Tapping a paid submission opens the real transaction on the block explorer —
  // one-tap on-chain proof (VeWorld's own Activity tab won't show these, because
  // the user's wallet never signs the payout; the distributor does).
  const txUrl = s.txHash ? `${EXPLORER}/transactions/${s.txHash}` : null;
  return (
    <div className="hitem" onClick={() => { if (txUrl) window.open(txUrl, "_blank", "noopener"); }}
      style={txUrl ? { cursor: "pointer" } : undefined}
      title={txUrl ? "View this transaction on the VeChain explorer" : undefined}>
      <div className="hicon" style={{background: getColorBg(s.type, T), color: T[s.type] || T.electric}}>{UTIL_ICONS[s.type]}</div>
      <div className="hinfo">
        <div className="htitle">{util.label}{s.meterNo ? <span style={{fontWeight:400,color:T.textSoft,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",fontSize:9}}> · #{s.meterNo}</span> : null}</div>
        <div className="hdate">{s.date}{txUrl ? <span style={{color:T.textSoft}}> · tx ↗</span> : null}</div>
        <div style={{color: T[s.type] || T.electric, fontSize: isEco ? 12 : undefined}}>{delta}{util.unit ? ` ${util.unit}` : ""}</div>
      </div>
      <div className="hright">
        <div className="hb3tr">+{parseFloat(s.b3tr).toFixed(2)}</div>
        {s.flagged
          ? <div className="hstatus" style={{color:T.gas,background:T.gasBg,border:`1px solid ${T.gasBorder}`}} title="Reading couldn't be confirmed from the photo — needs review">⚠ review</div>
          : <div className={`hstatus s-${s.status}`}>{s.status}</div>}
      </div>
    </div>
  );
}

function HomeScreen({ b3tr, streak, subs, setTab, T }) {
  return (
    <>
      <div className="sub-header">
        <div className="sub-title">Dashboard</div>
        <div className="sub-sub">Your sustainability stats</div>
      </div>
      
      <div className="hero">
        <div className="hero-label">Total B3TR Earned</div>
        <div className="hero-amount">{b3tr.toFixed(2)}<span>B3TR</span></div>
        <div className="hero-usd">Testnet beta · test tokens · Powered by VeChain</div>
        <div className="hero-chips">
          <div className="hchip"><div className="hchip-val">{streak}</div><div className="hchip-key">Day Streak</div></div>
          <div className="hchip"><div className="hchip-val">{subs.length}</div><div className="hchip-key">Submissions</div></div>
          <div className="hchip"><div className="hchip-val">{getTier(b3tr).name}</div><div className="hchip-key">Tier</div></div>
        </div>
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Utilities</div><div className="sec-line"/></div>
      <div className="util-grid">
        {UTILS.map(u => {
          const myS = subs.filter(s => s.type === u.id);
          const tot = myS.reduce((a,s) => a+(parseFloat(s.b3tr)||0), 0);
          return (
            <div key={u.id} className="ucard" onClick={() => setTab("charts")}>
              <div className="ucard-icon" style={{background:getColorBg(u.id, T),border:`1px solid ${T[u.id+"Border"]||T.green4}`,color:T[u.id]||T.green2}}>{UTIL_ICONS[u.id]}</div>
              <div className="ucard-name">{u.label}</div>
              <div className="ucard-reads">{myS.length} readings logged</div>
              <div className="ucard-b3tr" style={{color:T[u.id]||T.electric}}>+{tot.toFixed(2)} B3TR</div>
            </div>
          );
        })}
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Activity</div><div className="sec-line"/></div>
      <StreakCalendar subs={subs} />

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Recent</div><div className="sec-line"/></div>
      {subs.slice(0,3).map(s => <HistItem key={s.id} s={s} T={T} />)}
    </>
  );
}

// ── Smart-meter card (beta) ──────────────────────────────────────────────────
// The friendly, photoless path. Everyday users just type their current reading and
// tap one button — no camera, no OCR. Under the hood the value goes to the same
// backend store a real reader would push to (device token, cached after a one-time
// pairing), then the photoless payout endpoint issues B3TR. All the technical bits
// (device token, ingest URL, P1/Home-Assistant setup, Enode) live in a collapsed
// "Automatic setup" section so they never clutter the simple flow.
function SmartMeterCard({ wallet, setReading, T, onAutoSubmit, autoBusy, meterNo, embedded = false }) {
  const { requestCertificate } = useWallet();
  const API = (REWARD_API || "").replace(/\/$/, "");
  const ingestUrl = `${API}/meter-ingest`;
  const tkKey = wallet ? `gul_mtoken_${wallet.toLowerCase()}` : "";

  const [health, setHealth]   = useState(null);
  const [latest, setLatest]   = useState(null);   // { paired, reading }
  const [token, setToken]     = useState("");     // paired device token (cached)
  const [manual, setManual]   = useState("");     // the reading the user typed
  const [sending, setSending] = useState(false);  // manual send+submit in flight
  const [busy, setBusy]       = useState("");     // "enode" | "sync"
  const [err, setErr]         = useState("");
  const [copied, setCopied]   = useState("");
  const [open, setOpen]       = useState(!!embedded); // embedded → always expanded (no toggle)
  const [advOpen, setAdvOpen] = useState(false);
  const [device, setDevice]   = useState("homewizard"); // which setup snippet to show

  const signCert = async () => {
    const content = `Green Utility Log — link smart meter\nWallet: ${wallet}\nTime: ${new Date().toISOString()}`;
    const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
    return { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
  };

  const refreshLatest = async () => {
    if (!API || !wallet) return;
    try {
      const r = await fetch(`${API}/meter/latest?address=${wallet}`);
      if (r.ok) setLatest(await r.json());
    } catch { /* offline — leave as-is */ }
  };

  // Load backend capabilities once; load any cached device token for this wallet.
  useEffect(() => {
    if (!API) return;
    fetch(`${API}/health`).then(r => r.ok ? r.json() : null).then(h => h && setHealth(h)).catch(() => {});
  }, [API]);
  useEffect(() => {
    if (!tkKey) { setToken(""); return; }
    try { setToken(localStorage.getItem(tkKey) || ""); } catch { /* no storage */ }
  }, [tkKey]);
  useEffect(() => {
    if (!open || !wallet) return;
    refreshLatest();
    const id = setInterval(refreshLatest, 15000);
    return () => clearInterval(id);
  }, [open, wallet, API]);

  // Pair once (one wallet signature ever) and remember the token so future sends
  // need no popup. Returns the token to use for /meter-ingest.
  const ensureToken = async () => {
    if (token) return token;
    const certificate = await signCert();
    // Send the registered meter number so the backend scheduler (auto-submit) knows
    // which meter's baseline to measure this wallet's readings against.
    const r = await fetch(`${API}/meter/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, meterNo: meterNo || "", certificate }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `pairing failed (${r.status})`);
    setToken(d.token);
    try { localStorage.setItem(tkKey, d.token); } catch { /* no storage */ }
    return d.token;
  };

  // The one-tap path: send the typed reading to the backend, then pay it out.
  const sendAndEarn = async () => {
    const rv = parseFloat(manual);
    if (!Number.isFinite(rv) || rv < 0) { setErr("Enter a valid meter reading (kWh)."); return; }
    setErr(""); setSending(true);
    try {
      const tk = await ensureToken();
      const r = await fetch(ingestUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tk, reading: rv }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `couldn't send the reading (${r.status})`);
      await refreshLatest();
      setManual("");
      if (onAutoSubmit) await onAutoSubmit();   // pays out + shows its own toast/history
    } catch (e) {
      setErr(e?.message || "sending failed");
    } finally {
      setSending(false);
    }
  };

  const doEnodeLink = async () => {
    setErr(""); setBusy("enode");
    try {
      const certificate = await signCert();
      const r = await fetch(`${API}/meter/enode/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, certificate }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `link failed (${r.status})`);
      // Only open an https URL — never navigate to an arbitrary backend-supplied scheme.
      if (d.linkUrl && /^https:\/\//i.test(String(d.linkUrl))) window.open(d.linkUrl, "_blank", "noopener");
      else setErr("Enode returned no valid link URL");
    } catch (e) { setErr(e?.message || "Enode link failed"); }
    finally { setBusy(""); }
  };

  const doEnodeSync = async () => {
    setErr(""); setBusy("sync");
    try {
      const certificate = await signCert();
      const r = await fetch(`${API}/meter/enode/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, certificate }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `sync failed (${r.status})`);
      if (!d.linked) setErr("No meter linked yet — connect one via Enode first.");
      await refreshLatest();
    } catch (e) { setErr(e?.message || "Enode sync failed"); }
    finally { setBusy(""); }
  };

  const showToken = async () => {   // Advanced: reveal/create the device token for a reader
    setErr("");
    try { await ensureToken(); } catch (e) { setErr(e?.message || "pairing failed"); }
  };

  const copy = (text, tag) => {
    try { navigator.clipboard?.writeText(text); setCopied(tag); setTimeout(() => setCopied(""), 1500); } catch { /* no clipboard */ }
  };

  const enodeOn = !!health?.enode?.enabled;
  const rd = latest?.reading;
  const busyAny = sending || !!autoBusy;
  const box = { margin: "0 14px 12px", padding: 12, background: T.ecoBg || T.waterBg, border: `1px solid ${T.ecoBorder || T.waterBorder}`, borderRadius: 8 };
  const btn = (bg) => ({ padding: "9px 12px", fontSize: 12, fontWeight: 700, color: "#fff", background: bg, border: "none", borderRadius: 6, cursor: "pointer" });
  const mono = { fontFamily: "'SF Mono',Menlo,'Courier New',monospace" };
  const inputStyle = { flex: 1, minWidth: 0, padding: "10px 12px", fontSize: 15, fontWeight: 700, ...mono, color: T.text, background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 6, outline: "none" };

  if (!API) return null;

  return (
    <div style={box}>
      <button onClick={embedded ? undefined : () => setOpen(o => !o)} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 10, background: "none", border: "none", cursor: embedded ? "default" : "pointer", padding: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: T.eco || T.water }}>⚡ Automatic reading <span style={{ fontWeight: 600, color: T.textSoft }}>· connect a P1 reader (beta)</span></span>
        {!embedded && <span style={{ color: T.textSoft, fontSize: 13 }}>{open ? "▲" : "▼"}</span>}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6, marginBottom: 10 }}>
            Connect a P1 reader (e.g. HomeWizard) and your meter total is sent in automatically — no photos, no typing. Once it arrives it shows above, ready to submit with one tap.
          </div>

          {!wallet ? (
            <div style={{ fontSize: 11, color: T.textSoft }}>Connect your wallet to submit a reading.</div>
          ) : rd != null ? (
            /* A real reader (P1 / Enode) pushed a reading — claim it with one tap, no
               photo needed (the device token binds it to your wallet). */
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 8 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".6px", color: T.textSoft }}>Auto-received</div>
                <div style={{ ...mono, fontSize: 15, fontWeight: 800, color: T.eco || T.text }}>{rd.reading} kWh</div>
                {rd.source && <div style={{ fontSize: 10, color: T.textSoft }}>via {rd.source}{rd.at ? ` · ${new Date(rd.at).toLocaleString()}` : ""}</div>}
              </div>
              <button disabled={busyAny} onClick={() => onAutoSubmit?.()} style={{ ...btn(T.eco || T.electric), whiteSpace: "nowrap", opacity: busyAny ? .6 : 1 }}>
                {busyAny ? "Submitting…" : "Submit — no photo"}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6 }}>
              No automatic reading yet. Set up your <b>P1 reader</b> below — your meter total then shows up here to submit with one tap. To submit <b>by hand, use the 📸 Photo tab</b> (a photo is required for manual submissions).
            </div>
          )}

          {err && <div style={{ marginTop: 10, fontSize: 11, color: "#e74c3c", background: "rgba(231,76,60,.08)", border: "1px solid rgba(231,76,60,.3)", borderRadius: 6, padding: "8px 10px", wordBreak: "break-word" }}>{err}</div>}

          {/* ── Advanced: automatic setup (collapsed) ─────────────────────────── */}
          {wallet && (
            <div style={{ marginTop: 12, borderTop: `1px solid ${T.ecoBorder || T.waterBorder}`, paddingTop: 10 }}>
              <button onClick={() => setAdvOpen(o => !o)} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", padding: 0, color: T.textSoft, fontSize: 11, fontWeight: 700 }}>
                <span>⚙️ Automatic setup (P1 reader / Home Assistant{enodeOn ? " / Enode" : ""})</span>
                <span>{advOpen ? "▲" : "▼"}</span>
              </button>

              {advOpen && (
                <div style={{ marginTop: 10 }}>
                  {/* Plain-language step-by-step so a first-timer knows the whole flow. */}
                  <div style={{ background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: T.text, marginBottom: 6 }}>📖 How it works — 5 steps</div>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, lineHeight: 1.7, color: T.textMid }}>
                      <li>In the <b>HomeWizard app</b>, turn on <b>Local API</b> (Settings → Meters → your P1).</li>
                      <li>Do <b>one photo submission</b> first (📸 Photo tab) — it sets your baseline.</li>
                      <li>Tap <b>“Get my device token”</b> below and copy it.</li>
                      <li>On a device that stays on (Raspberry Pi / NAS / PC), run the <b>copied setup</b> once — it finds your meter and sends the reading every hour.</li>
                      <li>Your reading shows as <b>“Auto-received”</b> → tap <b>Submit — no photo</b>. Done!</li>
                    </ol>
                    <div style={{ fontSize: 10, color: T.textSoft, marginTop: 7, lineHeight: 1.5 }}>No device that stays on? Just type your reading or take a photo — that works too, and is easiest for most people.</div>
                  </div>

                  <div style={{ fontSize: 10, color: T.textSoft, lineHeight: 1.6, marginBottom: 8 }}>
                    Pick your device and copy the ready-made setup — your token is already filled in. Point your reader at it once and it keeps sending your meter total automatically.
                  </div>

                  {!token ? (
                    <button onClick={showToken} style={btn(T.electric)}>Get my device token</button>
                  ) : (() => {
                    // Live connection status — the card already polls /meter/latest.
                    const connected = rd != null;
                    const statusBg = connected ? (T.ecoBg || T.waterBg) : T.bg;
                    const statusColor = connected ? (T.eco || T.green3 || T.text) : T.textSoft;
                    const DEVS = [
                      { id: "homewizard", label: "HomeWizard P1" },
                      { id: "ha",         label: "Home Assistant" },
                      { id: "curl",       label: "Any other reader" },
                    ];
                    const bridgeCmd = `# Easiest: the bridge finds your HomeWizard on the network and pushes
# automatically. Run it once on an always-on machine (Pi / NAS / PC), Node 18+:

git clone https://github.com/GreenUtilityLog/GreenUtilityLog
cd GreenUtilityLog/bridge
GUL_TOKEN=${token} node index.js

# Prefer Docker?
# docker build -t gul-bridge ./bridge
# docker run -d --network host -e GUL_TOKEN=${token} gul-bridge`;
                    const haYaml = `# configuration.yaml — works with (almost) any meter Home Assistant supports
#
# FIRST: find YOUR entity — entity IDs differ per install (they include your device
# name). Developer tools → States → filter on "import" and pick the cumulative
# kWh one (its value keeps counting up, e.g. 8421.3). Paste that id below.
rest_command:
  gul_push:
    url: "${ingestUrl}"
    method: POST
    content_type: "application/json"
    payload: '{"token":"${token}","reading":{{ states("sensor.YOUR_IMPORT_KWH_ENTITY") | float }}}'

# automations.yaml — send hourly
- alias: Push meter to GreenUtilityLog
  trigger: { platform: time_pattern, hours: "/1" }
  action: { service: rest_command.gul_push }`;
                    const curlSnippet = `# Any reader/script that can POST JSON works — send your cumulative kWh total:
curl -X POST ${ingestUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"token":"${token}","reading":12345.6}'

# Or let the bridge read any HTTP/JSON reader for you:
# READ_URL=http://<reader-ip>/... GUL_TOKEN=${token} node GreenUtilityLog/bridge/index.js`;
                    const snip = device === "ha" ? haYaml : device === "curl" ? curlSnippet : bridgeCmd;
                    const hint = device === "homewizard"
                      ? 'Turn on "Local API" in the HomeWizard app first. The bridge auto-discovers your P1 — if your network blocks mDNS, add HW_IP=<your P1 IP>. Needs Node 18+ or Docker.'
                      : device === "ha"
                      ? "The universal route — Home Assistant supports almost every meter/reader. Entity IDs differ per install, so find yours under Developer tools → States (filter “import”, pick the kWh one that counts up) and paste it into the snippet."
                      : "For any other setup. POST your cumulative kWh total from any device, or use the bridge’s generic mode (READ_URL) to read any HTTP/JSON reader.";
                    return (
                      <div>
                        {/* Live connection status */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", background: statusBg, border: `1px solid ${connected ? (T.ecoBorder || T.waterBorder) : (T.border || T.waterBorder)}`, borderRadius: 6, marginBottom: 10, fontSize: 11, fontWeight: 700, color: statusColor }}>
                          {connected
                            ? `✅ Connected — ${rd.reading} kWh received${rd.at ? ` at ${new Date(rd.at).toLocaleTimeString()}` : ""}`
                            : "⏳ Waiting for your first reading… (leave this open after you set it up)"}
                        </div>

                        {/* Device picker */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                          {DEVS.map((d) => (
                            <button key={d.id} onClick={() => setDevice(d.id)}
                              style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: `1px solid ${device === d.id ? (T.eco || T.electric) : (T.border || T.waterBorder)}`, background: device === d.id ? (T.eco || T.electric) : "transparent", color: device === d.id ? "#fff" : T.textMid }}>
                              {d.label}
                            </button>
                          ))}
                        </div>

                        {/* Pre-filled, one-tap-copy setup */}
                        <div style={{ position: "relative" }}>
                          <button onClick={() => copy(snip, "snip")} style={{ position: "absolute", top: 6, right: 6, padding: "4px 8px", fontSize: 10, fontWeight: 700, border: "none", borderRadius: 5, cursor: "pointer", background: copied === "snip" ? (T.eco || T.green3 || T.electric) : T.textSoft, color: "#fff" }}>
                            {copied === "snip" ? "✓ Copied" : "Copy setup"}
                          </button>
                          <pre style={{ ...mono, fontSize: 10, lineHeight: 1.5, color: T.text, background: T.bg, border: `1px dashed ${T.border || T.waterBorder}`, padding: "10px 10px 10px", borderRadius: 6, overflowX: "auto", margin: 0, whiteSpace: "pre" }}>{snip}</pre>
                        </div>
                        <div style={{ fontSize: 10, color: T.textSoft, lineHeight: 1.5, margin: "6px 2px 0" }}>{hint}</div>

                        {/* Where does this text actually go? The most-asked question. */}
                        {device !== "ha" && (
                          <div style={{ marginTop: 8, padding: "9px 11px", background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 6 }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: T.text, marginBottom: 4 }}>📍 Where do I paste this?</div>
                            <div style={{ fontSize: 10, color: T.textSoft, lineHeight: 1.7 }}>
                              In a <b>terminal</b> on the device that stays on:<br />
                              • <b>Windows</b> — press Start, type <b>PowerShell</b>, open it<br />
                              • <b>Mac</b> — open <b>Terminal</b> (Applications → Utilities)<br />
                              • <b>Raspberry Pi / NAS</b> — its Terminal, or connect over <b>SSH</b><br />
                              Paste, press Enter, and leave it running. Requires <b>Node.js 18+</b> installed on that device.
                            </div>
                          </div>
                        )}

                        {/* Raw token / URL for reference */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                          <button onClick={() => copy(token, "tok")} style={{ ...btn(T.textSoft), padding: "5px 9px", fontSize: 10 }}>{copied === "tok" ? "✓ Token copied" : "Copy token only"}</button>
                          <button onClick={() => copy(ingestUrl, "url")} style={{ ...btn(T.textSoft), padding: "5px 9px", fontSize: 10 }}>{copied === "url" ? "✓ URL copied" : "Copy URL only"}</button>
                        </div>
                      </div>
                    );
                  })()}

                  {enodeOn && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                      <button disabled={!!busy} onClick={doEnodeLink} style={{ ...btn("#6c5ce7"), opacity: busy ? .6 : 1 }}>{busy === "enode" ? "Opening…" : "Connect via Enode (global)"}</button>
                      <button disabled={!!busy} onClick={doEnodeSync} style={{ ...btn(T.textSoft), opacity: busy ? .6 : 1 }}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubmitScreen({ u, selUtil, setSelUtil, aiOk, setAiOk, setPhoto, reading, setReading, prevRead, setPrevRead, busy, usage, reward, handleSubmit, verifyKey, wallet, setShowWallet, subs, meters, T, setTab, onEcoSubmit, ecoBusy, ecoUsedThisWeek, ecoCooldownMs, onMeterAutoSubmit, meterAutoBusy, onRegisterMeter }) {
  const meterNo  = (meters?.[selUtil] || "").trim();
  // Submittable when current ≥ previous (equal = zero usage = valid, max reward).
  const _r = parseFloat(reading), _p = parseFloat(prevRead);
  const readingReady = Number.isFinite(_r) && Number.isFinite(_p) && _r >= _p;
  const readingLower = Number.isFinite(_r) && Number.isFinite(_p) && _r < _p;
  // Two sub-tabs: the meter-reading flow and the eco-mode bonus each get their
  // own screen instead of being stacked below each other.
  const [subTab, setSubTab] = useState("meter");

  // Returning users already have a known previous reading (auto-filled from their
  // last submission). Show it as a compact chip and ask for only the CURRENT value,
  // instead of two number fields — fewer inputs, fewer typos. First-timers (no
  // history for this meter) still get the editable "Previous" field.
  const [editPrev, setEditPrev] = useState(false);
  useEffect(() => { setEditPrev(false); }, [selUtil]); // switching meters resets the chip
  const lastSub = (subs || []).find(s => s.type === selUtil && s.status !== "pending" && Number.isFinite(parseFloat(s.cur)));
  const lastKnown = lastSub ? String(lastSub.cur) : "";
  const knowPrev = !!lastKnown && !editPrev;
  const [tipsOpen, setTipsOpen] = useState(false); // photo tips collapsed by default
  // Two clearly-offered ways to submit a meter reading: a photo, or type it / connect
  // a reader. The type/reader path (auto meter ingestion) is electricity-only, so for
  // other utilities we show only the photo path.
  const autoAvailable = selUtil === "electric";
  const [method, setMethod] = useState("photo"); // "photo" | "type"
  useEffect(() => { if (!autoAvailable) setMethod("photo"); }, [autoAvailable]);
  // Most people never connect a reader, so don't make everyone choose between two
  // methods. The Photo/Auto switch only appears once a reader has actually been
  // paired (its device token is cached); otherwise the default path is just Photo,
  // with a quiet link at the bottom for anyone who wants to set a reader up.
  const hasReader = (() => {
    try { return !!localStorage.getItem(`gul_mtoken_${String(wallet || "").toLowerCase()}`); } catch { return false; }
  })();
  const showMethodSwitch = autoAvailable && hasReader;
  const methodBtn = (active) => ({
    flex: 1, padding: "10px 8px", minHeight: 44, borderRadius: 6, fontSize: 12.5, fontWeight: 800, cursor: "pointer",
    border: `1px solid ${active ? (T[selUtil] || T.electric) : T.border}`,
    background: active ? getColorBg(selUtil, T) : T.bgAlt,
    color: active ? (T[selUtil] || T.text) : T.textMid,
  });

  return (
    <>
      <div className="sub-header">
        <div className="sub-title">{subTab === "eco" ? "Eco Bonus" : "Meter Reading"}</div>
        <div className="sub-sub">{subTab === "eco" ? "Appliance on eco mode · Earn B3TR" : "Photograph your meter · Earn B3TR"}</div>
      </div>

      {/* Captcha lives OUTSIDE the sub-view conditionals: both the meter submission
          and the eco claim ride the same token, and the widget must stay mounted
          when the user switches views. */}
      {TURNSTILE_SITE_KEY && <div id="cf-turnstile" style={{display:"flex",justifyContent:"center",margin:"0 0 12px"}} />}

      {subTab === "meter" && (<>
      {/* Utility picker only when there's an actual choice — with a single active
          utility a full-width "tab" reads as a button that does nothing. */}
      {UTILS.length > 1 && (
        <div className="util-selector">
          {UTILS.map(ut => (
            <button key={ut.id} className={`utab ${selUtil===ut.id?"active":""}`}
              style={{"--uc":T[ut.id]||T.electric,"--ubg":getColorBg(ut.id, T),"--uborder":T[ut.id+"Border"]||T.electricBorder}}
              onClick={() => setSelUtil(ut.id)}>
              <span className="utab-icon">{UTIL_ICONS[ut.id]}</span>{ut.label}
            </button>
          ))}
        </div>
      )}

      <div onClick={() => { if (!meterNo) onRegisterMeter?.([selUtil]); }}
        style={{margin:"0 14px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"9px 12px",background:meterNo?getColorBg(selUtil,T):T.gasBg,border:`1px solid ${meterNo?(T[selUtil+"Border"]||T.electricBorder):T.gasBorder}`,borderRadius:6,cursor:meterNo?"default":"pointer"}}>
        <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft}}>Registered meter</div>
        <div style={{fontSize:12,fontWeight:700,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:meterNo?(T[selUtil]||T.text):T.gas}}>{meterNo || "Tap to register →"}</div>
      </div>

      {/* Method switch only once a reader exists — otherwise there's nothing to choose.
          It also appears while the reader view is open, so there's always a way back. */}
      {(showMethodSwitch || method === "type") && (
        <div style={{display:"flex",gap:8,margin:"0 14px 12px"}}>
          <button onClick={() => setMethod("photo")} style={methodBtn(method === "photo")}>📸 Photo</button>
          <button onClick={() => setMethod("type")} style={methodBtn(method === "type")}>⚡ Auto (reader)</button>
        </div>
      )}

      {method === "photo" ? (<>
      {/* Progress strip — at a glance: what's done, what's left, what's next. */}
      {(() => {
        const stepDefs = [
          { n: 1, label: "Photo",   done: aiOk },
          { n: 2, label: "Reading", done: readingReady },
          { n: 3, label: "Submit",  done: false },
        ];
        const activeIdx = !aiOk ? 0 : !readingReady ? 1 : 2;
        return (
          <div style={{display:"flex",alignItems:"center",gap:4,margin:"0 14px 12px"}}>
            {stepDefs.map((s, i) => {
              const active = i === activeIdx;
              const fg = s.done ? (T.green3 || T.electric) : active ? (T[selUtil] || T.electric) : T.textSoft;
              return (
                <Fragment key={s.n}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flex:"0 0 auto"}}>
                    <div style={{width:22,height:22,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,
                      background: s.done ? (T.green3 || T.electric) : active ? getColorBg(selUtil, T) : "transparent",
                      color: s.done ? "#fff" : fg,
                      border: `1px solid ${s.done ? (T.green3 || T.electric) : active ? (T[selUtil] || T.electric) : T.border}`}}>
                      {s.done ? "✓" : s.n}
                    </div>
                    <span style={{fontSize:11,fontWeight:active||s.done?700:600,color:fg,whiteSpace:"nowrap"}}>{s.label}</span>
                  </div>
                  {i < stepDefs.length - 1 && <div style={{flex:1,height:1,background:T.border,minWidth:8}} />}
                </Fragment>
              );
            })}
          </div>
        );
      })()}

      <VerifyZone key={verifyKey} utilId={selUtil} reading={reading} prevRead={prevRead} subs={subs} meterNo={meterNo} T={T}
        onOcrReading={(v) => { if (!String(reading).trim()) setReading(String(v)); }}
        onVerified={(res, img, mime) => { setAiOk(true); setPhoto?.(img ? { base64: img, mime, ocrNums: res?.ocrNums || [], ocrFailed: !!res?.ocrFailed, meterNoConfirmed: res?.meterNoConfirmed ?? null } : null); }}
        onReset={() => { setAiOk(false); setPhoto?.(null); }} />

      <div className="form-card" style={{"--uc":T[u.id]||T.electric,"--ubg":getColorBg(u.id, T),"--uborder":T[u.id+"Border"]||T.electricBorder,marginTop:14}}>
        {knowPrev ? (
          <>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:12,padding:"8px 12px",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6}}>
              <div style={{fontSize:11,color:T.textSoft}}>Previous&nbsp;
                <span style={{fontFamily:"'SF Mono',Menlo,'Courier New',monospace",fontWeight:700,color:T.text}}>{prevRead || lastKnown} {u.unit}</span>
                <span style={{color:T.textSoft}}> · from your last reading</span>
              </div>
              <button onClick={()=>setEditPrev(true)} style={{background:"none",border:"none",color:T.green3||T[u.id]||T.electric,fontSize:11,fontWeight:700,cursor:"pointer",padding:0}}>Edit</button>
            </div>
            <div className="igroup">
              <div className="ilabel">Current reading <span className="utag">{u.unit}</span></div>
              <input className="ifield" type="number" step="0.01" inputMode="decimal" placeholder={u.ph[1]} value={reading} onChange={e=>setReading(e.target.value)} style={{width:"100%",boxSizing:"border-box"}}/>
            </div>
          </>
        ) : (
          <div className="irow">
            <div className="igroup">
              <div className="ilabel">Previous <span className="utag">{u.unit}</span></div>
              <input className="ifield" type="number" step="0.01" inputMode="decimal" placeholder={u.ph[0]} value={prevRead} onChange={e=>setPrevRead(e.target.value)}/>
            </div>
            <div className="igroup">
              <div className="ilabel">Current <span className="utag">{u.unit}</span></div>
              <input className="ifield" type="number" step="0.01" inputMode="decimal" placeholder={u.ph[1]} value={reading} onChange={e=>setReading(e.target.value)}/>
            </div>
          </div>
        )}

        {readingReady && (() => {
          const bench = USAGE_BENCHMARK[u.id] ?? 0;
          const saved = Math.max(0, bench - usage());
          const base  = REWARD_BASE[u.id] ?? 0;
          const isSaving = SAVING_UTILS.has(u.id);
          const rateText = isSaving
            ? (usage() === 0
                ? `${base} base + no consumption — maximum saving! (${bench} ${u.unit} under target × ${u.rate} B3TR)`
                : saved > 0
                ? `${base} base + ${saved.toFixed(1)} ${u.unit} saved × ${u.rate} B3TR (target ≤ ${bench} ${u.unit})`
                : `Base only — used ${usage()} ${u.unit}, target is ≤ ${bench} ${u.unit}`)
            : `${base} base + ${usage()} ${u.unit} produced × ${u.rate} B3TR`;
          return (
            <div className="reward-preview">
              <div>
                <div className="rp-label">Estimated Reward</div>
                <div className="rp-rate">Use less, earn more · {rateText}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div className="rp-val">+{reward()}</div>
                <div className="rp-b3tr">B3TR</div>
              </div>
            </div>
          );
        })()}

        {!wallet
          ? <button className="sbtn" onClick={() => setShowWallet(true)}>Connect Wallet to Submit</button>
          : !meterNo
            ? <button className="sbtn" onClick={() => onRegisterMeter?.([selUtil])}>Register this meter →</button>
            : !aiOk
              ? <button className="sbtn" disabled style={{opacity:.55}}>📸 Verify a meter photo to submit</button>
              : readingLower
                ? <button className="sbtn" disabled style={{opacity:.55}}>Current can't be lower than previous</button>
                : !readingReady
                ? <button className="sbtn" disabled style={{opacity:.55}}>Enter the current reading above</button>
                : <button className="sbtn" disabled={busy} onClick={handleSubmit}>
                    {busy ? <><span className="spin-sm"/> Submitting on VeChain…</> : <>Submit & Earn B3TR</>}
                  </button>
        }
      </div>

      {/* Photo tips — collapsed by default so the photo flow stays clean. */}
      <div style={{margin:"14px 14px 0"}}>
        <button onClick={() => setTipsOpen(o => !o)} style={{display:"flex",width:"100%",alignItems:"center",justifyContent:"space-between",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6,padding:"9px 12px",cursor:"pointer",color:T.textMid,fontSize:11,fontWeight:700}}>
          <span>💡 Photo tips</span><span style={{color:T.textSoft}}>{tipsOpen ? "▲" : "▼"}</span>
        </button>
        {tipsOpen && (
          <ul style={{margin:"8px 2px 0",paddingLeft:20,fontSize:11,color:T.textSoft,lineHeight:1.7}}>
            <li>Clear, well-lit photo of the meter face</li>
            <li>All the numbers visible and readable</li>
            <li>Avoid shadows or glare on the display</li>
            <li>Hold steady for a sharp image</li>
            <li>Fresh photo each time — a photo can only ever earn once</li>
          </ul>
        )}
      </div>

      {/* Eco bonus lives here as its own card rather than a sub-tab competing with the
          meter flow: a separate earning action, clearly labelled, one tap away. */}
      {onEcoSubmit && (
        <div onClick={() => setSubTab("eco")} style={{margin:"14px 14px 0",display:"flex",alignItems:"center",gap:12,padding:"14px 15px",background:T.ecoBg||T.bgAlt,border:`1px solid ${T.ecoBorder||T.border}`,borderRadius:10,cursor:"pointer"}}>
          <span style={{fontSize:26,lineHeight:1}}>🌿</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13.5,fontWeight:800,color:T.text}}>Eco Bonus</div>
            <div style={{fontSize:11,color:T.textSoft,lineHeight:1.45,marginTop:2}}>
              Washer, dryer or dishwasher on eco mode — extra B3TR
              {Number.isFinite(ecoUsedThisWeek) ? ` · ${Math.max(0, ECO_MAX_PER_WEEK_UI - ecoUsedThisWeek)} left this week` : ""}
            </div>
          </div>
          <span style={{fontSize:16,color:T.eco||T.green3,fontWeight:800}}>→</span>
        </div>
      )}

      {/* Quiet entry point for the minority who want automatic readings — a link, not
          a competing button, so the photo CTA stays the obvious one. */}
      {autoAvailable && !hasReader && (
        <div style={{margin:"12px 14px 0",textAlign:"center"}}>
          <button onClick={() => setMethod("type")} style={{background:"none",border:"none",padding:"6px",cursor:"pointer",fontSize:11,fontWeight:700,color:T.textSoft,textDecoration:"underline"}}>
            ⚡ Have a P1 reader? Set up automatic readings
          </button>
        </div>
      )}
      </>) : (
        <SmartMeterCard embedded wallet={wallet} setReading={setReading} T={T} onAutoSubmit={onMeterAutoSubmit} autoBusy={meterAutoBusy} meterNo={meterNo} />
      )}
      </>)}

      {subTab === "eco" && onEcoSubmit && (<>
        <div style={{margin:"0 14px 12px"}}>
          <button onClick={() => setSubTab("meter")} style={{background:"none",border:"none",padding:"6px 0",cursor:"pointer",fontSize:12,fontWeight:700,color:T.textMid}}>← Back to meter reading</button>
        </div>
        <EcoBonusCard T={T} wallet={wallet} setShowWallet={setShowWallet} onSubmit={onEcoSubmit} busy={ecoBusy} usedThisWeek={ecoUsedThisWeek} cooldownMs={ecoCooldownMs} />
      </>)}
    </>
  );
}

// ── Eco-mode bonus card ───────────────────────────────────────────────────────
// Photograph an appliance (washer / dryer / dishwasher) running in eco mode →
// a small fixed B3TR bonus, max 4× per rolling week (enforced server-side; the
// counter shown here is the local view of it).
const ECO_APPLIANCE_OPTIONS = [
  { id: "washer",     label: "Washer",     icon: "🧺" },
  { id: "dryer",      label: "Dryer",      icon: "🌀" },
  { id: "dishwasher", label: "Dishwasher", icon: "🍽️" },
];
const ECO_MAX_PER_WEEK_UI = 4;

function EcoBonusCard({ T, wallet, setShowWallet, onSubmit, busy, usedThisWeek, cooldownMs }) {
  const [appliance, setAppliance] = useState("washer");
  const [preview, setPreview] = useState(null); // { file, url } — shown before submitting
  const fileRef = useRef(null);
  const left = Math.max(0, ECO_MAX_PER_WEEK_UI - (usedThisWeek || 0));
  const coolingDown = (cooldownMs || 0) > 0;
  const canClaim = left > 0 && !coolingDown;
  const hours = Math.ceil((cooldownMs || 0) / 3600000);
  const clearPreview = () => setPreview(p => { if (p?.url) { try { URL.revokeObjectURL(p.url); } catch {} } return null; });
  useEffect(() => () => { if (preview?.url) { try { URL.revokeObjectURL(preview.url); } catch {} } }, [preview]);
  return (
    <div style={{background:T.card,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"14px",margin:"0 14px 14px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
        <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px",color:T.green3}}>🌿 Eco Mode Bonus</div>
        <div style={{fontSize:10,fontWeight:700,color:left ? T.green3 : T.textSoft}}>{left}/{ECO_MAX_PER_WEEK_UI} left this week</div>
      </div>
      <div style={{fontSize:10.5,color:T.textMid,lineHeight:1.5,marginBottom:10}}>
        Running your washer, dryer or dishwasher on the <b>eco setting</b>? Photograph the appliance with the eco mode visible and earn a bonus. Fresh photo every time — max 4 per week (Mon–Sun), one per 24h.
      </div>

      {/* Example of a valid photo, shown BEFORE the user shoots/uploads one: the
          appliance's panel with the ECO setting clearly selected and readable. */}
      <div style={{display:"flex",gap:10,alignItems:"center",background:T.bgAlt,border:`1px dashed ${T.border}`,borderRadius:6,padding:"8px 10px",marginBottom:10}}>
        <svg width="92" height="60" viewBox="0 0 92 60" aria-label="Example: appliance panel with ECO selected" style={{flexShrink:0}}>
          <rect x="1" y="1" width="90" height="58" rx="6" fill={T.card} stroke={T.border}/>
          <rect x="8" y="8" width="40" height="20" rx="3" fill={T.green5} stroke={T.green4||T.border}/>
          <text x="28" y="22" textAnchor="middle" fontSize="11" fontWeight="800" fill={T.green3} fontFamily="-apple-system,sans-serif">ECO</text>
          <circle cx="68" cy="30" r="14" fill={T.bgAlt} stroke={T.border}/>
          <line x1="68" y1="30" x2="58" y2="22" stroke={T.green3} strokeWidth="2.5" strokeLinecap="round"/>
          <circle cx="54" cy="18" r="2.5" fill={T.green3}/>
          <rect x="8" y="34" width="12" height="12" rx="2" fill={T.bgAlt} stroke={T.border}/>
          <rect x="24" y="34" width="12" height="12" rx="2" fill={T.bgAlt} stroke={T.border}/>
          <text x="14" y="55" fontSize="6.5" fill={T.textSoft} fontFamily="-apple-system,sans-serif">40°</text>
          <text x="30" y="55" fontSize="6.5" fill={T.textSoft} fontFamily="-apple-system,sans-serif">60°</text>
        </svg>
        <div style={{fontSize:10,color:T.textMid,lineHeight:1.5}}>
          <b style={{color:T.green3}}>Example photo:</b> the appliance's panel or dial with <b>ECO</b> selected and clearly readable. Include the whole panel, not just the light.
        </div>
      </div>

      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {ECO_APPLIANCE_OPTIONS.map(a => (
          <button key={a.id} onClick={() => setAppliance(a.id)}
            style={{flex:1,padding:"8px 4px",minHeight:44,borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer",
              border:`1px solid ${appliance===a.id ? T.green2 : T.border}`,
              background: appliance===a.id ? T.green5 : T.bgAlt,
              color: appliance===a.id ? T.green3 : T.textMid}}>
            {a.icon} {a.label}
          </button>
        ))}
      </div>
      {/* After shooting, PREVIEW the photo and let the user confirm or retake
          before it's submitted — no accidental sends. */}
      {preview ? (
        <div>
          <img src={preview.url} alt="Eco mode photo" style={{width:"100%",maxHeight:220,objectFit:"cover",borderRadius:6,border:`1px solid ${T.border}`,display:"block"}} />
          <div style={{fontSize:10.5,color:T.textMid,margin:"8px 0 10px"}}>Is the <b>ECO</b> setting clearly visible? Submit for your {ECO_APPLIANCE_OPTIONS.find(a=>a.id===appliance)?.label} bonus, or retake.</div>
          <div style={{display:"flex",gap:8}}>
            <button className="sbtn" style={{flex:1}} disabled={busy}
              onClick={() => { const f = preview.file; clearPreview(); onSubmit(f, appliance); }}>
              {busy ? <><span className="spin-sm"/> Submitting…</> : "✅ Submit for bonus"}
            </button>
            <button disabled={busy} onClick={() => { clearPreview(); fileRef.current?.click(); }}
              style={{background:"transparent",color:T.textMid,border:`1px solid ${T.border}`,borderRadius:4,padding:"0 16px",fontWeight:700,fontSize:12,cursor:"pointer"}}>↻ Retake</button>
          </div>
        </div>
      ) : !IS_MOBILE
        ? <button className="sbtn" disabled style={{opacity:.55}}>📵 Phone camera required — open on your phone</button>
        : !wallet
        ? <button className="sbtn" onClick={() => setShowWallet(true)}>Connect Wallet</button>
        : <button className="sbtn" disabled={busy || !canClaim} style={!canClaim ? {opacity:.55} : undefined}
            onClick={() => canClaim && fileRef.current?.click()}>
            {busy ? <><span className="spin-sm"/> Submitting…</>
              : !left ? "Weekly limit reached — resets Monday"
              : coolingDown ? `Next eco bonus in ~${hours}h`
              : "📸 Photograph eco mode"}
          </button>
      }
      <input type="file" ref={fileRef} accept="image/*" capture="environment" style={{display:"none"}}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPreview({ file: f, url: URL.createObjectURL(f) }); }} />
    </div>
  );
}

// CO2e grams avoided per unit saved — mirrors the server's on-chain impact model.
const CO2_PER_UNIT_UI = { electric: 400, gas: 1900, water: 0.34, solar: 400 };
const ECO_CO2_PER_CLAIM = 200;   // grams per eco-mode run (≈0.5 kWh saved)
const ECO_KWH_PER_CLAIM = 0.5;

function ChartsScreen({ subs, T }) {
  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const usageOf = (s) => { const u = parseFloat(s.cur) - parseFloat(s.prev); return Number.isFinite(u) && u > 0 ? +u.toFixed(2) : 0; };
  const meterSubs = subs.filter(s => s.type !== "eco" && usageOf(s) > 0);
  const ecoSubs   = subs.filter(s => s.type === "eco");

  // ── Headline impact numbers (same model as the on-chain proofs) ────────────
  const totalB3TR = subs.reduce((a, s) => a + (parseFloat(s.b3tr) || 0), 0);
  const ecoB3TR   = ecoSubs.reduce((a, s) => a + (parseFloat(s.b3tr) || 0), 0);
  let savedUnits = 0, co2g = ecoSubs.length * ECO_CO2_PER_CLAIM, kwhSaved = ecoSubs.length * ECO_KWH_PER_CLAIM;
  for (const s of meterSubs) {
    const bench = USAGE_BENCHMARK[s.type] ?? 0;
    if (SAVING_UTILS.has(s.type)) {
      const saved = Math.max(0, bench - usageOf(s));
      savedUnits += saved;
      co2g += saved * (CO2_PER_UNIT_UI[s.type] || 0);
      if (s.type === "electric") kwhSaved += saved;
    } else if (s.type === "solar") {
      co2g += usageOf(s) * CO2_PER_UNIT_UI.solar;
      kwhSaved += usageOf(s);
    }
  }
  const streak = computeStreak(subs);
  const co2Label = co2g >= 1000 ? `${(co2g / 1000).toFixed(1)} kg` : `${Math.round(co2g)} g`;

  // ── Weekly B3TR earnings, last 6 calendar weeks (Mon–Sun, local) ───────────
  const weekStartOf = (ts) => { const d = new Date(ts); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const thisWeek = weekStartOf(Date.now());
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const weeks = Array.from({ length: 6 }, (_, i) => ({ start: thisWeek - (5 - i) * WEEK, b3tr: 0, n: 0 }));
  for (const s of subs) {
    const ts = s.submittedAt || localDayTs(s.date);
    if (!Number.isFinite(ts)) continue;
    const w = weeks.find(w => ts >= w.start && ts < w.start + WEEK);
    if (w) { w.b3tr += parseFloat(s.b3tr) || 0; w.n += 1; }
  }
  const weekMax = Math.max(...weeks.map(w => w.b3tr), 0);
  const wkLabel = (t) => { const d = new Date(t); return `${d.getDate()}/${d.getMonth() + 1}`; };
  const ecoThisWeek = ecoSubs.filter(s => (s.submittedAt || localDayTs(s.date) || 0) >= thisWeek).length;

  // ── Personal records ────────────────────────────────────────────────────────
  const bestDay = meterSubs.length ? meterSubs.reduce((a, s) => usageOf(s) < usageOf(a) ? s : a) : null;
  const bestReward = subs.length ? subs.reduce((a, s) => (parseFloat(s.b3tr) || 0) > (parseFloat(a.b3tr) || 0) ? s : a) : null;

  const Tile = ({ icon, val, unit, label, sub }) => (
    <div className="pstat">
      <div style={{fontSize:16,marginBottom:2}}>{icon}</div>
      <div className="pstat-val" style={{fontSize:19}}>{val}<span style={{fontSize:11,fontWeight:600,color:T.textSoft}}> {unit}</span></div>
      <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft,marginTop:2}}>{label}</div>
      {sub && <div style={{fontSize:9,color:T.textSoft,marginTop:1}}>{sub}</div>}
    </div>
  );

  if (!subs.length) return (
    <>
      <div className="page-title">Analytics</div>
      <div className="chart-card" style={{textAlign:"center",padding:"28px 16px"}}>
        <div style={{fontSize:26,marginBottom:8}}>📊</div>
        <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:4}}>No data yet</div>
        <div style={{fontSize:11,color:T.textSoft,lineHeight:1.5}}>Submit your first meter reading and your impact statistics will appear here.</div>
      </div>
    </>
  );

  return (
    <>
      <div className="page-title">Analytics</div>

      {/* Impact headline — the numbers that tell the sustainability story */}
      <div className="pstat-row">
        <Tile icon="🌍" val={co2Label.split(" ")[0]} unit={co2Label.split(" ")[1] + " CO₂e"} label="Emissions avoided" />
        <Tile icon="⚡" val={kwhSaved.toFixed(1)} unit="kWh" label="Energy saved" sub="vs efficiency target" />
        <Tile icon="🪙" val={totalB3TR.toFixed(2)} unit="B3TR" label="Total earned" sub={ecoB3TR > 0 ? `${(totalB3TR - ecoB3TR).toFixed(2)} meters · ${ecoB3TR.toFixed(2)} eco` : undefined} />
        <Tile icon="🔥" val={streak} unit={streak === 1 ? "day" : "days"} label="Streak" sub={`${subs.length} submission${subs.length === 1 ? "" : "s"}`} />
      </div>

      {/* Usage vs the efficiency target — the core conservation view */}
      {UTILS.map(u => {
        const myS = subs.filter(s => s.type === u.id).slice(0, 7).reverse();
        const series = myS.map(s => ({ v: usageOf(s), label: (s.date || "").slice(5).replace("-", "/") }));
        // Production meters (solar) have no "stay under" target — more is better,
        // so they get plain green bars and no target framing.
        const saving = SAVING_UTILS.has(u.id);
        const bench = saving ? (USAGE_BENCHMARK[u.id] ?? 0) : 0;
        const avg = series.length ? series.reduce((a, d) => a + d.v, 0) / series.length : 0;
        // Scale so the target line is always on-canvas, even when every bar is below it.
        const maxScale = Math.max(...series.map(d => d.v), bench * 1.15, 0.001);
        const underCount = series.filter(d => d.v <= bench).length;
        return (
          <div key={u.id} className="chart-card">
            <div className="chart-hdr">
              <div className="chart-title">{u.label} — {saving ? "usage vs target" : "production"}</div>
              <div style={{fontSize:10,color:T.textSoft}}>{series.length ? `avg ${avg.toFixed(1)} ${u.unit}` : ""}</div>
            </div>
            {series.length ? (
              <>
                <div style={{position:"relative",height:110,display:"flex",alignItems:"flex-end",gap:2,padding:"14px 2px 0"}}>
                  {bench > 0 && (
                    <div style={{position:"absolute",left:0,right:0,bottom:`${(bench / maxScale) * 100}%`,borderTop:`2px dashed ${T.textSoft}`,zIndex:1}}>
                      <span style={{position:"absolute",right:2,top:-14,fontSize:9,fontWeight:700,color:T.textSoft,background:T.card,padding:"0 3px"}}>target {bench} {u.unit}</span>
                    </div>
                  )}
                  {series.map((d, i) => (
                    <div key={i} title={`${d.label}: ${d.v.toFixed(2)} ${u.unit}${saving ? ` — ${d.v <= bench ? "under" : "above"} target` : " produced"}`}
                      style={{flex:1,height:`${Math.max(4, (d.v / maxScale) * 100)}%`,background: !saving || d.v <= bench ? T.green3 : T.electric,borderRadius:"4px 4px 0 0"}} />
                  ))}
                </div>
                <div style={{display:"flex",gap:2,padding:"2px 2px 0"}}>
                  {series.map((d, i) => <div key={i} style={{flex:1,textAlign:"center",fontSize:8.5,color:T.textSoft}}>{d.label}</div>)}
                </div>
                {saving && (
                <div style={{display:"flex",gap:12,marginTop:8,fontSize:9.5,color:T.textMid}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:T.green3,marginRight:4,verticalAlign:"middle"}}/>under target ({underCount})</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:T.electric,marginRight:4,verticalAlign:"middle"}}/>above target ({series.length - underCount})</span>
                </div>
                )}
              </>
            ) : (
              <div style={{padding:"18px 4px",fontSize:11,color:T.textSoft,textAlign:"center"}}>No readings yet — log this meter to see your usage.</div>
            )}
          </div>
        );
      })}

      {/* Earnings per calendar week */}
      <div className="chart-card">
        <div className="chart-hdr">
          <div className="chart-title">B3TR earned per week</div>
          <div style={{fontSize:10,color:T.textSoft}}>last 6 weeks</div>
        </div>
        <div style={{position:"relative",height:90,display:"flex",alignItems:"flex-end",gap:4,padding:"12px 2px 0"}}>
          {weeks.map((w, i) => (
            <div key={i} title={`week of ${wkLabel(w.start)}: ${w.b3tr.toFixed(2)} B3TR (${w.n} submission${w.n === 1 ? "" : "s"})`}
              style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",height:"100%"}}>
              {w.b3tr > 0 && w.b3tr === weekMax && <div style={{fontSize:9,fontWeight:700,color:T.textMid,fontFamily:mono,marginBottom:2}}>{w.b3tr.toFixed(1)}</div>}
              <div style={{width:"100%",height: weekMax > 0 ? `${Math.max(4, (w.b3tr / weekMax) * 72)}%` : "4px",background: w.b3tr > 0 ? T.green3 : T.bgAlt,borderRadius:"4px 4px 0 0"}} />
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:4,padding:"2px 2px 0"}}>
          {weeks.map((w, i) => <div key={i} style={{flex:1,textAlign:"center",fontSize:8.5,color: w.start === thisWeek ? T.green3 : T.textSoft,fontWeight: w.start === thisWeek ? 700 : 400}}>{w.start === thisWeek ? "now" : wkLabel(w.start)}</div>)}
        </div>
      </div>

      {/* Eco bonus + personal records */}
      <div className="chart-card">
        <div className="chart-hdr"><div className="chart-title">🌿 Eco bonus this week</div><div style={{fontSize:10,color:T.textSoft}}>resets Monday</div></div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginTop:4}}>
          <div style={{display:"flex",gap:5}}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} style={{width:26,height:26,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,
                background: i < ecoThisWeek ? T.green5 : T.bgAlt,border:`1px solid ${i < ecoThisWeek ? T.green3 : T.border}`}}>{i < ecoThisWeek ? "🌿" : ""}</div>
            ))}
          </div>
          <div style={{fontSize:11,color:T.textMid,lineHeight:1.45}}>{ecoThisWeek}/4 claims used · {ecoSubs.length} total ({ecoB3TR.toFixed(2)} B3TR)</div>
        </div>
      </div>

      {(bestDay || bestReward) && (
        <div className="chart-card">
          <div className="chart-hdr"><div className="chart-title">🏅 Personal records</div></div>
          {bestDay && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${T.border}`,fontSize:11}}>
              <span style={{color:T.textMid}}>Most efficient reading</span>
              <span style={{fontWeight:700,color:T.green3,fontFamily:mono}}>{usageOf(bestDay).toFixed(2)} {getUtil(bestDay.type).unit} · {bestDay.date}</span>
            </div>
          )}
          {bestReward && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",fontSize:11}}>
              <span style={{color:T.textMid}}>Biggest single reward</span>
              <span style={{fontWeight:700,color:T.green3,fontFamily:mono}}>+{(parseFloat(bestReward.b3tr) || 0).toFixed(2)} B3TR · {bestReward.date}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function LeaderboardScreen({ b3tr, streak, subs, wallet, T }) {
  const currentTier = getTier(b3tr);
  const nextTier = TIERS[TIERS.indexOf(currentTier) + 1];
  const progressPercent = nextTier ? Math.min(100, Math.round((b3tr - currentTier.min) / (nextTier.min - currentTier.min) * 100)) : 100;
  const b3trNeeded = nextTier ? Math.max(0, nextTier.min - b3tr) : 0;
  // The "100 B3TR Achievement" goal is a fixed 100, NOT the gap to the next tier —
  // reusing b3trNeeded showed a wrong number for anyone already past 100.
  const to100 = Math.max(0, 100 - b3tr);
  const dailyAvg = subs.length > 0 ? (b3tr / subs.length).toFixed(2) : "0.00";
  const withBonus = (parseFloat(dailyAvg) * currentTier.multiplier).toFixed(2);
  const bonusExtra = (withBonus - dailyAvg).toFixed(2);

  // ── Real participant field ────────────────────────────────────────────────
  // Pull the ranked field straight from chain (aggregated RewardDistributed
  // events for our appId). Falls back to the sample field when the app isn't
  // registered yet or the node is unreachable, so the screen never breaks.
  const [chain, setChain] = useState({ status: "loading", rows: [], reason: null });
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetchOnChainLeaderboard({
      node: ACTIVE_NODE,
      contract: CONTRACTS.X2EarnRewardsPool,
      appId: VEBETTER_APP_ID,
      signal: ctrl.signal,
    })
      .then(res => { if (!cancelled) setChain(res.ok ? { status: "live", rows: res.rows, truncated: res.truncated } : { status: "demo", rows: [], reason: res.reason }); })
      .catch(() => { if (!cancelled) setChain({ status: "demo", rows: [], reason: "error" }); });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  const meAddr = wallet ? wallet.toLowerCase() : null;
  const isLive = chain.status === "live" && chain.rows.length > 0;

  let board;
  if (isLive) {
    // Rank the on-chain field; make sure the connected wallet always appears,
    // even with no rewards yet, so the user can see where they stand.
    const rows = chain.rows.map(r => ({
      name: shortAddr(r.addr), addr: shortAddr(r.addr), rawAddr: r.addr,
      b3tr: r.b3tr, count: r.count, isMe: meAddr && r.addr === meAddr,
    }));
    if (meAddr && !rows.some(r => r.isMe)) {
      rows.push({ name: "You", addr: shortAddr(wallet), rawAddr: meAddr, b3tr: 0, count: 0, isMe: true });
    }
    board = rows.sort((a, b) => b.b3tr - a.b3tr).map((d, i) => ({ ...d, rank: i + 1 }));
  } else {
    // Sample field — splice the connected wallet in and rank by B3TR.
    const competitors = LEADERBOARD_DATA.filter(d => !d.isMe);
    const me = { name: "You", addr: shortAddr(wallet), b3tr: +b3tr.toFixed(2), streak, tier: currentTier.name, isMe: true };
    board = [...competitors, me].sort((a, b) => b.b3tr - a.b3tr).map((d, i) => ({ ...d, rank: i + 1 }));
  }

  const myIndex = board.findIndex(d => d.isMe);
  const myRank = myIndex + 1;
  const myBoardB3tr = myIndex >= 0 ? board[myIndex].b3tr : b3tr;
  const aheadOfMe = board[myIndex - 1];
  const gapToNext = aheadOfMe ? Math.max(0, aheadOfMe.b3tr - myBoardB3tr) : 0;
  
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekSubs = subs.filter(s => new Date(s.date) >= weekAgo);
  const weekB3tr = weekSubs.reduce((a, s) => a + parseFloat(s.b3tr), 0).toFixed(2);
  
  const badges = [
    { id: "early", name: "Early Adopter", icon: "🚀", unlocked: subs.length > 0 },
    { id: "100sub", name: "Century Club", icon: "💯", unlocked: subs.length >= 100 },
    { id: "7day", name: "Week Warrior", icon: "🔥", unlocked: streak >= 7 },
    { id: "20day", name: "Legend", icon: "👑", unlocked: streak >= 20 },
    { id: "250b3tr", name: "B3TR Whale", icon: "🐋", unlocked: b3tr >= 250 },
    { id: "rank1", name: "Champion", icon: "🏆", unlocked: false },
  ];

  return (
    <>
      <div className="lb-hero" style={{borderLeftColor:currentTier.color}}>
        <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"2.2px",color:T.textSoft,marginBottom:10}}>Your Rank & Tier</div>
        <div className="lb-hero-rank">#{myRank}</div>
        <div style={{fontSize:12,fontWeight:700,color:currentTier.color,marginTop:8}}>{currentTier.name} Tier ({currentTier.multiplier}x bonus)</div>
        <div style={{fontSize:11,color:T.textSoft,marginTop:5}}>{(isLive ? myBoardB3tr : b3tr).toFixed(2)} B3TR · {streak} day streak</div>

        <div style={{fontSize:10,fontWeight:700,color:T.green3,marginTop:10,display:"flex",alignItems:"center",gap:6}}>
          {myRank === 1 ? "🏆 Top of the leaderboard" : `↑ ${gapToNext.toFixed(2)} B3TR to reach #${myRank - 1}`}
        </div>

        {nextTier && (
          <div style={{marginTop:14,width:"100%"}}>
            <div style={{fontSize:9,fontWeight:700,color:T.textMid,marginBottom:6}}>Progress to {nextTier.name} Tier</div>
            <div style={{width:"100%",height:6,background:T.border,borderRadius:3,overflow:"hidden"}}>
              <div style={{width:`${progressPercent}%`,height:"100%",background:T.green3,transition:"width 0.3s"}}/>
            </div>
            <div style={{fontSize:8,color:T.textSoft,marginTop:4,textAlign:"center"}}>{progressPercent}% • Need {b3trNeeded.toFixed(2)} more B3TR</div>
          </div>
        )}
      </div>

      <div className="sec" style={{marginTop:20}}><div className="sec-line"/><div className="sec-txt">🎯 Next Goals</div><div className="sec-line"/></div>
      <div style={{margin:"0 14px 14px",padding:14,background:T.card,border:`1px solid ${T.border}`,borderRadius:5}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:T.text}}>100 B3TR Achievement</div>
          <div style={{fontSize:10,fontWeight:700,color:T.green3,fontFamily:"'SF Mono',monospace"}}>{to100 > 0 ? `${to100.toFixed(2)} away` : "Achieved ✓"}</div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:T.text}}>#1 Global Rank</div>
          <div style={{fontSize:10,fontWeight:700,color:T.green3,fontFamily:"'SF Mono',monospace"}}>{myRank === 1 ? "You're #1!" : `${myRank - 1} spots away`}</div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{fontSize:11,fontWeight:700,color:T.text}}>30-Day Streak</div>
          <div style={{fontSize:10,fontWeight:700,color:T.green3,fontFamily:"'SF Mono',monospace"}}>{Math.max(0, 30-streak)} days away</div>
        </div>
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">📊 This Week</div><div className="sec-line"/></div>
      <div style={{margin:"0 14px 14px",padding:14,background:T.card,border:`1px solid ${T.border}`,borderRadius:5}}>
        <div style={{fontSize:10,fontWeight:700,color:T.green3,marginBottom:8}}>✓ +{weekB3tr} B3TR</div>
        <div style={{fontSize:10,fontWeight:700,color:T.green3,marginBottom:8}}>✓ +{weekSubs.length} submissions</div>
        <div style={{fontSize:10,fontWeight:700,color:T.green3}}>✓ Avg: {(weekB3tr/7).toFixed(2)} B3TR/day</div>
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">💰 Earning Power</div><div className="sec-line"/></div>
      <div style={{margin:"0 14px 14px",padding:14,background:T.card,border:`1px solid ${T.border}`,borderRadius:5}}>
        <div style={{fontSize:9,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:8}}>Base Rate</div>
        <div style={{fontSize:11,fontWeight:700,color:T.text,marginBottom:12,fontFamily:"'SF Mono',monospace"}}>Ø {dailyAvg} B3TR/day</div>
        <div style={{fontSize:9,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:8}}>With {currentTier.name} Tier ({currentTier.multiplier}x)</div>
        <div style={{fontSize:11,fontWeight:700,color:currentTier.color,marginBottom:12,fontFamily:"'SF Mono',monospace"}}>{withBonus} B3TR/day <span style={{color:T.green3}}>+{bonusExtra} bonus!</span></div>
        <div style={{fontSize:9,color:T.textSoft,lineHeight:1.6}}>
          📅 Monthly: {(dailyAvg * 30).toFixed(2)} B3TR<br/>
          📅 Yearly: {(dailyAvg * 365).toFixed(2)} B3TR
        </div>
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">🏅 Achievements</div><div className="sec-line"/></div>
      <div style={{margin:"0 14px 14px",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
        {badges.map(b => (
          <div key={b.id} style={{padding:12,background:b.unlocked?T.card:T.bgAlt,border:`1px solid ${b.unlocked?T.border:T.textSoft}`,borderRadius:4,textAlign:"center",opacity:b.unlocked?1:0.5}}>
            <div style={{fontSize:24,marginBottom:4}}>{b.icon}</div>
            <div style={{fontSize:8,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.8px",color:T.textSoft}}>{b.name}</div>
          </div>
        ))}
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Global Leaderboard</div><div className="sec-line"/></div>
      <div style={{margin:"0 14px 10px",display:"flex",alignItems:"center",justifyContent:"center",gap:7,fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:chain.status==="live"?T.green3:T.textSoft}}>
        {chain.status==="loading"
          ? <><span className="spin-sm" style={{width:9,height:9,borderColor:`${T.border}`,borderTopColor:T.green3}}/> Loading on-chain rankings…</>
          : chain.status==="live"
            ? <><span style={{width:6,height:6,borderRadius:"50%",background:T.green3,animation:"pulse 2.5s infinite"}}/> Live · {board.length} on-chain participants{chain.truncated ? " (top, more exist)" : ""}</>
            : <>● Sample field — {chain.reason==="unset_appid" ? "set your VeBetterDAO App ID for live data" : "live rankings load once submissions are on-chain"}</>
        }
      </div>
      {board.slice(0, 25).map(item => (
        <div key={item.isMe ? "me" : (item.rawAddr || item.name)} className={`lb-item ${item.isMe ? 'me' : ''}`}>
          <div className="lb-rank">{item.rank}</div>
          <div style={{flex:1}}>
            <div className="lb-name">{item.name} {item.isMe && <span style={{fontSize:7,fontWeight:700,background:T.green1,color:"#fff",borderRadius:1,padding:"1px 4px",letterSpacing:".8px"}}>YOU</span>}</div>
            <div style={{fontSize:9,color:T.textSoft,fontFamily:"'SF Mono',monospace"}}>{item.addr}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div className="lb-b3tr">+{Number(item.b3tr).toFixed(item.count!=null ? 2 : (item.isMe ? 2 : 1))}</div>
            <div style={{fontSize:9,color:T.textSoft}}>{item.count!=null ? `📸 ${item.count}` : `🔥 ${item.streak}d`}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function HistoryScreen({ subs, T }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter==="all" ? subs : subs.filter(s=>s.type===filter);
  return (
    <>
      <div style={{padding:"18px 20px 10px",display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
        <div className="page-title" style={{padding:0}}>History</div>
        <div style={{fontSize:11,color:T.textSoft,fontFamily:"'SF Mono',Menlo,'Courier New',monospace"}}>{subs.length} total</div>
      </div>
      <div className="filter-row">
        {[{id:"all",l:"All"},...UTILS.map(u=>({id:u.id,l:u.label}))].map(f=>(
          <button key={f.id} className={`fchip ${filter===f.id?"active":""}`} onClick={()=>setFilter(f.id)}>
            {f.l}
          </button>
        ))}
      </div>
      {filtered.map(s => <HistItem key={s.id} s={s} T={T} />)}
    </>
  );
}

// Read-only admin overlay: every on-chain participant for this app, aggregated
// from RewardDistributed events. Monitoring only — payouts/blocking require the
// reward-distributor role (a backend), never the frontend.
// ── Admin: account tools (block farmers · fix a wrong reading) ────────────────
// Each action is a signed call to an /admin/* endpoint (onAdminApi handles the
// certificate). All are guarded server-side by the admin allowlist too.
function AdminAccountTools({ T, onAdminApi, onToast }) {
  const [banW, setBanW]   = useState("");
  const [meterNo, setMeterNo] = useState("");
  const [reading, setReading] = useState("");
  const [owner, setOwner] = useState("");
  const [cdW, setCdW]     = useState("");
  const [lookW, setLookW] = useState("");
  const [busy, setBusy]   = useState("");
  const [result, setResult] = useState(null);

  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || "").trim());
  const run = async (key, fn, okMsg) => {
    setBusy(key); setResult(null);
    try { const d = await fn(); if (d) setResult(d); onToast?.(okMsg(d)); }
    catch (e) { onToast?.(`❌ ${e?.message || "action failed"}`); }
    finally { setBusy(""); }
  };

  const inp = { width: "100%", boxSizing: "border-box", background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "9px 11px", fontSize: 12, color: T.text, fontFamily: "'SF Mono',Menlo,'Courier New',monospace", outline: "none" };
  const btn = (bg, fg, disabled) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${T.border}` : "none", borderRadius: 6, padding: "9px 12px", fontWeight: 700, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", opacity: disabled ? 0.6 : 1 });
  const lbl = { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".6px", color: T.textSoft, margin: "0 0 5px" };
  const card = { background: T.bgAlt, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, marginBottom: 10 };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: T.text, marginBottom: 8 }}>🛠️ Account tools</div>

      {/* Block / unblock a farming wallet */}
      <div style={card}>
        <div style={lbl}>Block a wallet (farmer)</div>
        <input value={banW} onChange={e => setBanW(e.target.value)} placeholder="0x… wallet to block" spellCheck={false} style={inp} />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button disabled={busy === "ban" || !isAddr(banW)} onClick={() => run("ban", () => onAdminApi("/admin/ban", { targetWallet: banW.trim(), ban: true }), () => `🚫 Blocked ${banW.trim().slice(0, 8)}…`)} style={btn("#c0392b", "#fff", busy === "ban" || !isAddr(banW))}>{busy === "ban" ? "…" : "Block"}</button>
          <button disabled={busy === "unban" || !isAddr(banW)} onClick={() => run("unban", () => onAdminApi("/admin/ban", { targetWallet: banW.trim(), ban: false }), () => `✅ Unblocked ${banW.trim().slice(0, 8)}…`)} style={btn("transparent", T.textMid, busy === "unban" || !isAddr(banW))}>{busy === "unban" ? "…" : "Unblock"}</button>
        </div>
      </div>

      {/* Correct a wrong meter reading (baseline) */}
      <div style={card}>
        <div style={lbl}>Fix a meter's baseline (wrong reading)</div>
        <input value={meterNo} onChange={e => setMeterNo(e.target.value)} placeholder="Meter / EAN number" spellCheck={false} style={{ ...inp, marginBottom: 8 }} />
        <input value={reading} onChange={e => setReading(e.target.value)} type="number" step="0.01" inputMode="decimal" placeholder="Correct current reading" style={{ ...inp, marginBottom: 8 }} />
        <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="Bind to wallet (optional 0x…)" spellCheck={false} style={inp} />
        <button disabled={busy === "base" || !meterNo.trim() || !(Number(reading) >= 0)} onClick={() => run("base", () => onAdminApi("/admin/set-baseline", { meterNo: meterNo.trim(), reading: Number(reading), ...(isAddr(owner) ? { targetWallet: owner.trim() } : {}) }), (d) => `✅ Baseline set: ${d.meterNo} → ${d.baseline}`)} style={{ ...btn(T.green3 || "#2e7d5b", "#fff", busy === "base" || !meterNo.trim() || !(Number(reading) >= 0)), marginTop: 8 }}>{busy === "base" ? "Saving…" : "Set baseline"}</button>
        <div style={{ fontSize: 10, color: T.textSoft, marginTop: 6, lineHeight: 1.5 }}>Sets the value future usage is measured from. Use it to correct a mis-entered reading. To let the user resubmit now, also reset their cooldown below.</div>
      </div>

      {/* Reset a wallet's cooldown */}
      <div style={card}>
        <div style={lbl}>Reset cooldown (electric)</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={cdW} onChange={e => setCdW(e.target.value)} placeholder="0x… wallet" spellCheck={false} style={inp} />
          <button disabled={busy === "cd" || !isAddr(cdW)} onClick={() => run("cd", () => onAdminApi("/admin/reset-cooldown", { targetWallet: cdW.trim(), utility: "electric" }), () => `✅ Cooldown reset`)} style={btn(T.green3 || "#2e7d5b", "#fff", busy === "cd" || !isAddr(cdW))}>{busy === "cd" ? "…" : "Reset"}</button>
        </div>
      </div>

      {/* Look up a meter or wallet */}
      <div style={card}>
        <div style={lbl}>Look up (meter number or wallet)</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={lookW} onChange={e => setLookW(e.target.value)} placeholder="Meter number or 0x…" spellCheck={false} style={inp} />
          <button disabled={busy === "look" || !lookW.trim()} onClick={() => run("look", () => onAdminApi("/admin/lookup", isAddr(lookW) ? { targetWallet: lookW.trim() } : { meterNo: lookW.trim() }), () => `🔎 Loaded`)} style={btn("transparent", T.textMid, busy === "look" || !lookW.trim())}>{busy === "look" ? "…" : "Look up"}</button>
        </div>
        {result && (
          <pre style={{ margin: "8px 0 0", padding: 10, background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, fontSize: 11, color: T.text, fontFamily: "'SF Mono',Menlo,'Courier New',monospace", overflowX: "auto", lineHeight: 1.5 }}>{JSON.stringify(result, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

// Admin actions on the wallet you've drilled into — block/unblock, reset its
// cooldown, and correct a meter's baseline right where you see the problem.
function WalletAdminActions({ T, address, meters, onAdminApi, onToast }) {
  const [busy, setBusy] = useState("");
  const [vals, setVals] = useState({});         // baseline inputs per meter
  const [renameVals, setRenameVals] = useState({}); // new-number inputs per meter
  const [add, setAdd] = useState({ meterNo: "", utility: "electric", reading: "" }); // register-a-meter form
  const [backendMeters, setBackendMeters] = useState(null); // meters registered on the backend (incl. just-added)
  // Show the on-chain-derived meters PLUS any backend-registered ones, deduped — so a
  // meter added via admin (no submission yet) is visible here too.
  const norm = (m) => `${m.utility}:${String(m.meterNo).toLowerCase()}`;
  const shown = (() => {
    const map = new Map();
    for (const m of (meters || [])) map.set(norm(m), m);
    for (const m of (backendMeters || [])) if (!map.has(norm(m))) map.set(norm(m), m);
    return [...map.values()];
  })();
  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try { const d = await fn(); onToast?.(okMsg(d)); }
    catch (e) { onToast?.(`❌ ${e?.message || "action failed"}`); }
    finally { setBusy(""); }
  };
  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const btn = (bg, fg, dis) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${T.border}` : "none", borderRadius: 6, padding: "9px 12px", fontWeight: 700, fontSize: 11, cursor: "pointer", opacity: dis ? 0.6 : 1, whiteSpace: "nowrap" });
  const inp = { flex: 1, minWidth: 0, boxSizing: "border-box", background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", fontSize: 12, color: T.text, fontFamily: mono, outline: "none" };

  return (
    <div style={{ marginTop: 16, padding: 12, background: T.bgAlt, border: `1px solid ${T.border}`, borderRadius: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, marginBottom: 10 }}>🛠️ Admin actions</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button disabled={busy === "ban"} onClick={() => run("ban", () => onAdminApi("/admin/ban", { targetWallet: address, ban: true }), () => "🚫 Wallet blocked — it can no longer claim")} style={btn("#c0392b", "#fff", busy === "ban")}>{busy === "ban" ? "…" : "🚫 Block wallet"}</button>
        <button disabled={busy === "unban"} onClick={() => run("unban", () => onAdminApi("/admin/ban", { targetWallet: address, ban: false }), () => "✅ Wallet unblocked")} style={btn("transparent", T.textMid, busy === "unban")}>{busy === "unban" ? "…" : "Unblock"}</button>
        <button disabled={busy === "cd"} onClick={() => run("cd", () => onAdminApi("/admin/reset-cooldown", { targetWallet: address, utility: "electric" }), () => "✅ Cooldown reset")} style={btn("transparent", T.textMid, busy === "cd")}>{busy === "cd" ? "…" : "⏱️ Reset cooldown"}</button>
        <button disabled={busy === "load"} onClick={() => run("load", () => onAdminApi("/admin/lookup", { targetWallet: address }), (d) => { setBackendMeters(d.meters || []); return `✅ ${(d.meters || []).length} meter(s) registered on backend`; })} style={btn("transparent", T.textMid, busy === "load")}>{busy === "load" ? "…" : "🔍 Load meters"}</button>
      </div>

      {shown.length === 0 && (
        <div style={{ fontSize: 10.5, color: T.textSoft, marginTop: 10, lineHeight: 1.5 }}>No meters yet from on-chain submissions. Tap <b>🔍 Load meters</b> to show ones registered on the backend, or add one below.</div>
      )}

      {shown.map((m, i) => (
        <div key={i} style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 10, color: T.textSoft, marginBottom: 5 }}><span style={{ fontFamily: mono, color: T.text }}>{m.meterNo}</span> · {m.utility}{m.last != null ? ` · last ${m.last}` : ""}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={vals[m.meterNo] ?? ""} onChange={e => setVals(v => ({ ...v, [m.meterNo]: e.target.value }))} type="number" step="0.01" inputMode="decimal" placeholder={`Fix reading${m.last != null ? ` (e.g. ${m.last})` : ""}`} style={inp} />
            <button disabled={busy === "base" + i || !(Number(vals[m.meterNo]) >= 0)} onClick={() => run("base" + i, () => onAdminApi("/admin/set-baseline", { meterNo: m.meterNo, utility: m.utility, reading: Number(vals[m.meterNo]), targetWallet: address }), (d) => `✅ Baseline set: ${d.meterNo} → ${d.baseline}`)} style={btn(T.green3 || "#2e7d5b", "#fff", busy === "base" + i || !(Number(vals[m.meterNo]) >= 0))}>{busy === "base" + i ? "…" : "Set"}</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input value={renameVals[m.meterNo] ?? ""} onChange={e => setRenameVals(v => ({ ...v, [m.meterNo]: e.target.value }))} placeholder="Change meter number →" spellCheck={false} style={inp} />
            <button disabled={busy === "ren" + i || !(renameVals[m.meterNo] || "").trim()} onClick={() => run("ren" + i, () => onAdminApi("/admin/rename-meter", { oldMeterNo: m.meterNo, newMeterNo: (renameVals[m.meterNo] || "").trim(), utility: m.utility, targetWallet: address }), (d) => `✅ Meter renamed → ${d.meterNo}`)} style={btn("transparent", T.textMid, busy === "ren" + i || !(renameVals[m.meterNo] || "").trim())}>{busy === "ren" + i ? "…" : "Rename"}</button>
          </div>
        </div>
      ))}

      {/* Register / add a meter to this wallet (e.g. before their first submission,
          or to add a second utility). Sets its server-side baseline + ownership. */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.textSoft, marginBottom: 5 }}>➕ Add a meter to this wallet</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={add.meterNo} onChange={e => setAdd(a => ({ ...a, meterNo: e.target.value }))} placeholder="Meter number" spellCheck={false} style={{ ...inp, flex: "2 1 120px" }} />
          <select value={add.utility} onChange={e => setAdd(a => ({ ...a, utility: e.target.value }))} style={{ ...inp, flex: "1 1 90px", fontFamily: "inherit", cursor: "pointer" }}>
            {UTILS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
          <input value={add.reading} onChange={e => setAdd(a => ({ ...a, reading: e.target.value }))} type="number" step="0.01" inputMode="decimal" placeholder="Current reading" style={{ ...inp, flex: "1 1 100px" }} />
          <button disabled={busy === "add" || !add.meterNo.trim() || !(Number(add.reading) >= 0)} onClick={() => run("add", () => onAdminApi("/admin/set-baseline", { meterNo: add.meterNo.trim(), utility: add.utility, reading: Number(add.reading), targetWallet: address }), (d) => { const nm = { utility: add.utility, meterNo: add.meterNo.trim().toLowerCase(), last: Number(add.reading) }; setBackendMeters(prev => { const cur = prev || []; return cur.some(x => norm(x) === norm(nm)) ? cur : [...cur, nm]; }); setAdd({ meterNo: "", utility: "electric", reading: "" }); return `✅ Meter added: ${d.meterNo} (${d.utility})`; })} style={btn(T.green3 || "#2e7d5b", "#fff", busy === "add" || !add.meterNo.trim() || !(Number(add.reading) >= 0))}>{busy === "add" ? "…" : "Add"}</button>
        </div>
      </div>

      <div style={{ fontSize: 10, color: T.textSoft, marginTop: 10, lineHeight: 1.5 }}>Each action asks for one wallet signature (admin proof). Fix baseline corrects a mis-entered reading; Rename changes a wrong meter number (moves its baseline); Add registers a meter + baseline for this wallet. Meters/baselines live on the backend, not the chain.</div>
    </div>
  );
}

// One row in a wallet's "Recent submissions" list. Renders the submission clearly
// per type (meter reading vs eco bonus) and — when the server's photo archive is on
// — lets an admin pull up the actual photo behind the payout (📷) or erase it (🗑️).
function SubmissionRow({ r, T, onAdminApi, onToast, archiveOn }) {
  const MONO = "'SF Mono',Menlo,'Courier New',monospace";
  const isEco = !!r.appliance || r.type === "eco";
  const p = parseFloat(r.prev), c = parseFloat(r.cur);
  const usage = (Number.isFinite(p) && Number.isFinite(c)) ? +(c - p).toFixed(2) : null;
  const unit = (UTILS.find((x) => x.id === r.type)?.unit) || "kWh";
  const txUrl = r.txHash ? `${EXPLORER}/transactions/${r.txHash}` : null;
  const canPhoto = archiveOn && !!r.txHash;
  const [photo, setPhoto] = useState({ status: "idle", dataUrl: null }); // idle|loading|shown|none|deleted|busy

  const loadPhoto = async (e) => {
    e.stopPropagation();
    if (photo.status === "shown") { setPhoto({ status: "idle", dataUrl: null }); return; } // toggle closed
    setPhoto({ status: "loading", dataUrl: null });
    try {
      const d = await onAdminApi("/admin/photo", { txid: r.txHash });
      if (d.found && d.dataUrl) setPhoto({ status: "shown", dataUrl: d.dataUrl });
      else { setPhoto({ status: "none", dataUrl: null }); onToast?.("📭 No photo stored for this submission"); }
    } catch (err) { setPhoto({ status: "idle", dataUrl: null }); onToast?.(`⚠️ ${err.message}`); }
  };
  const deletePhoto = async (e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this photo from storage? This cannot be undone.")) return;
    setPhoto({ status: "busy", dataUrl: photo.dataUrl });
    try {
      await onAdminApi("/admin/photo-delete", { txid: r.txHash });
      setPhoto({ status: "deleted", dataUrl: null });
      onToast?.("🗑️ Photo deleted");
    } catch (err) { setPhoto({ status: "shown", dataUrl: photo.dataUrl }); onToast?.(`⚠️ ${err.message}`); }
  };

  const iconBtn = (label, onClick, disabled) => (
    <button onClick={onClick} disabled={disabled}
      style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"3px 7px",fontSize:12,cursor:disabled?"default":"pointer",color:T.textMid,lineHeight:1}}>{label}</button>
  );

  return (
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,marginBottom:6,overflow:"hidden"}}>
      <div onClick={() => txUrl && window.open(txUrl, "_blank", "noopener")}
        title={txUrl ? "View this transaction on the VeChain explorer" : undefined}
        style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",cursor:txUrl?"pointer":"default"}}>
        <span style={{fontSize:16}}>{isEco ? "🌿" : (UTIL_ICONS[r.type] || "⚡")}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:700,color:T.text}}>
            {isEco ? "Eco bonus" : "Meter reading"}
            {!isEco && r.meterNo ? <span style={{fontWeight:400,color:T.textSoft,fontFamily:MONO,fontSize:10}}> · #{r.meterNo}</span> : null}
          </div>
          <div style={{fontSize:10,color:T.textSoft,fontFamily:MONO}}>
            {isEco
              ? (r.appliance ? `${r.appliance} on eco mode` : "appliance on eco mode")
              : (usage != null ? `${r.prev} → ${r.cur} · ${usage} ${unit} used` : (r.cur !== "" ? `reading ${r.cur}` : "reading"))}
          </div>
          <div style={{fontSize:9,color:T.textSoft,marginTop:2}}>{r.date}{txUrl ? " · tx ↗" : ""}</div>
        </div>
        {canPhoto && photo.status !== "deleted" && (
          <span onClick={(e) => e.stopPropagation()} style={{display:"flex",gap:4}}>
            {iconBtn(photo.status === "loading" ? "…" : photo.status === "shown" ? "📷 ▲" : "📷", loadPhoto, photo.status === "loading" || photo.status === "busy")}
            {photo.status === "shown" && iconBtn("🗑️", deletePhoto, false)}
          </span>
        )}
        <div style={{fontSize:13,fontWeight:800,color:T.green3,fontFamily:MONO,whiteSpace:"nowrap"}}>+{parseFloat(r.b3tr).toFixed(2)}</div>
      </div>
      {photo.status === "shown" && photo.dataUrl && (
        <div style={{padding:"0 12px 12px"}}>
          <img src={photo.dataUrl} alt="submission" style={{maxWidth:"100%",borderRadius:6,border:`1px solid ${T.border}`,display:"block"}} />
        </div>
      )}
      {photo.status === "deleted" && (
        <div style={{padding:"0 12px 10px",fontSize:10,color:T.textSoft}}>🗑️ Photo deleted.</div>
      )}
    </div>
  );
}

function AdminScreen({ onClose, T, wallet, onFundPool, onMoveToRewardsPool, onDisableRewardsPool, onClaimB3TR, onAdminApi, onToast }) {
  const [chain, setChain] = useState({ status: "loading", rows: [], reason: null });
  const [knownWallets, setKnownWallets] = useState(null); // backend-known wallets (not yet on-chain)
  const [loadingWallets, setLoadingWallets] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState({ status: "idle", rows: [] });
  const [detailReload, setDetailReload] = useState(0); // bump to retry the history fetch
  const [fundAmt, setFundAmt] = useState("100");
  const [funding, setFunding] = useState(false);
  const [claiming, setClaiming] = useState(false);
  // How much B3TR the app's reward pool currently has to pay out.
  const [pool, setPool] = useState({ status: "loading", b3tr: 0 });
  // Full payout self-diagnosis: backend health + on-chain checks, run from THIS
  // browser so it works even when the server can't see the chain. Pinpoints the
  // exact reason payouts fail instead of leaving the admin guessing.
  const [diag, setDiag] = useState({ status: "loading" });
  // Setup/diagnostics (System check + Fund pool) are collapsed by default so the
  // day-to-day view (participants + search) stays uncluttered.
  const [opsOpen, setOpsOpen] = useState(false);

  async function runDiagnostics(signal) {
    const d = { status: "done", backend: null, health: null, chain: null };
    try {
      const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/health`, { signal });
      d.backend = res.ok;
      if (res.ok) d.health = await res.json();
    } catch { d.backend = false; }
    const distributor = d.health?.distributor || null;
    try {
      d.chain = await fetchDiagnostics({
        node: ACTIVE_NODE,
        poolContract: CONTRACTS.X2EarnRewardsPool,
        appsContract: CONTRACTS.X2EarnApps,
        appId: VEBETTER_APP_ID,
        distributor,
        signal,
      });
    } catch { d.chain = null; }
    setDiag(d);
  }

  function refreshPool(signal) {
    return fetchPoolBalance({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, signal })
      .then(res => setPool(res.ok ? { status: "live", b3tr: res.b3tr } : { status: "error", b3tr: 0 }))
      .catch(() => setPool({ status: "error", b3tr: 0 }));
  }

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetchOnChainLeaderboard({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, signal: ctrl.signal })
      .then(res => { if (!cancelled) setChain(res.ok ? { status: "live", rows: res.rows } : { status: "empty", rows: [], reason: res.reason }); })
      .catch(() => { if (!cancelled) setChain({ status: "error", rows: [] }); });
    refreshPool(ctrl.signal);
    runDiagnostics(ctrl.signal).catch(() => {});
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  // Load one wallet's full on-chain history (incl. the meter numbers it used).
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const ctrl = new AbortController();
    setDetail({ status: "loading", rows: [] });
    fetchWalletHistory({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, address: selected, signal: ctrl.signal })
      .then(res => { if (!cancelled) setDetail(res.ok ? { status: "live", rows: res.rows } : { status: "empty", rows: [], reason: res.reason }); })
      .catch(e => { if (!cancelled) setDetail({ status: "error", rows: [], error: e?.message || "request failed" }); });
    return () => { cancelled = true; ctrl.abort(); };
  }, [selected, detailReload]);

  const totalB3tr = chain.rows.reduce((a, r) => a + (r.b3tr || 0), 0);
  const totalSubs = chain.rows.reduce((a, r) => a + (r.count || 0), 0);

  // The on-chain list only contains wallets that already earned. Merge in everything
  // the backend knows (app-seen testers, meter owners, paired devices, bans) so new
  // wallets show up on their own — no manual adding.
  const allRows = (() => {
    const seenAddrs = new Set(chain.rows.map(r => String(r.addr).toLowerCase()));
    const extra = (knownWallets || [])
      .filter(w => !seenAddrs.has(String(w.address).toLowerCase()))
      .map(w => ({ addr: w.address, b3tr: 0, count: 0, isNew: true, meters: w.meters || [], banned: !!w.banned }))
      .sort((a, b) => a.addr.localeCompare(b.addr));
    return [...chain.rows, ...extra];
  })();

  const q = query.trim().toLowerCase();
  const isFullAddr = /^0x[0-9a-f]{40}$/.test(q);
  const filtered = q ? allRows.filter(r => r.addr.toLowerCase().includes(q)) : allRows;

  const headerBar = (title, sub, onBack) => (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        {onBack && <button onClick={onBack} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"6px 10px",fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>←</button>}
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>{title}</div>
          <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>{sub}</div>
        </div>
      </div>
      <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"6px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Close</button>
    </div>
  );

  // ── Per-wallet detail ──────────────────────────────────────────────────────
  if (selected) {
    const row = chain.rows.find(r => r.addr.toLowerCase() === selected.toLowerCase());
    const meters = (() => {
      const m = new Map();
      for (const r of detail.rows) {
        if (!r.meterNo) continue;
        const key = `${r.type}:${r.meterNo}`;
        if (!m.has(key)) m.set(key, { utility: r.type, meterNo: r.meterNo, count: 0, last: r.cur });
        m.get(key).count++;
      }
      return [...m.values()];
    })();
    return (
      <div style={{position:"fixed",inset:0,background:T.bg,zIndex:320,display:"flex",flexDirection:"column"}}>
        {headerBar("🛡️ Wallet detail", `On-chain · ${NETWORK_LABEL}`, () => setSelected(null))}
        <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px"}}>
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:"12px 14px",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
              <div style={{fontSize:13,fontWeight:700,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.text}}>{shortAddr(selected)}</div>
              <button onClick={() => { try { navigator.clipboard.writeText(selected); } catch {} }} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"4px 8px",fontSize:10,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Copy</button>
            </div>
            <div style={{fontSize:9,color:T.textSoft,wordBreak:"break-all",marginTop:4,fontFamily:"'SF Mono',Menlo,'Courier New',monospace"}}>{selected}</div>
            <div style={{display:"flex",gap:16,marginTop:10}}>
              <div><span style={{fontSize:15,fontWeight:600,color:T.green3}}>{row ? row.b3tr.toFixed(2) : (detail.rows.reduce((a,r)=>a+(parseFloat(r.b3tr)||0),0)).toFixed(2)}</span> <span style={{fontSize:9,color:T.textSoft}}>B3TR</span></div>
              <div><span style={{fontSize:15,fontWeight:600,color:T.text}}>{detail.rows.length}</span> <span style={{fontSize:9,color:T.textSoft}}>submissions</span></div>
              <div><span style={{fontSize:15,fontWeight:600,color:T.text}}>{meters.length}</span> <span style={{fontSize:9,color:T.textSoft}}>meters</span></div>
            </div>
          </div>

          {/* A failed fetch used to look exactly like "this wallet has nothing" —
              zeros everywhere — which is misleading when a wallet DOES have history.
              Surface the failure and offer a retry instead. */}
          {detail.status === "error" && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,padding:"11px 12px",marginBottom:12}}>
              <div style={{fontSize:11,color:T.text,lineHeight:1.5}}>
                ⚠️ <b>Couldn't load this wallet's on-chain history.</b> The counts below are not reliable — the node didn't respond{detail.error ? ` (${detail.error})` : ""}.
              </div>
              <button onClick={() => setDetailReload(n => n + 1)} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"7px 11px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer",whiteSpace:"nowrap"}}>Retry</button>
            </div>
          )}
          {detail.status === "empty" && detail.reason && (
            <div style={{background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,padding:"11px 12px",marginBottom:12,fontSize:11,color:T.text,lineHeight:1.5}}>
              ⚠️ History unavailable ({detail.reason}) — check the VeBetterDAO App ID and network.
            </div>
          )}

          <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"4px 2px 8px"}}>Meters used</div>
          {detail.status === "loading" && <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:18}}>Loading…</div>}
          {detail.status === "live" && meters.length === 0 && <div style={{color:T.textSoft,fontSize:11,padding:"6px 2px"}}>No meters found on-chain for this wallet.</div>}
          {meters.map((m, i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,background:getColorBg(m.utility,T),border:`1px solid ${T[m.utility+"Border"]||T.border}`,borderRadius:6,padding:"9px 12px",marginBottom:6}}>
              <span style={{fontSize:15}}>{UTIL_ICONS[m.utility]}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:700,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.text}}>{m.meterNo}</div>
                <div style={{fontSize:9,color:T.textSoft,textTransform:"capitalize"}}>{m.utility} · {m.count} reading{m.count!==1?"s":""} · last {m.last}</div>
              </div>
            </div>
          ))}

          <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"16px 2px 8px"}}>Recent submissions</div>
          {detail.status === "loading" && <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:14}}>Loading…</div>}

          {/* Example rows when the wallet has no submissions yet — so you can see
              exactly how a real one will look. */}
          {detail.status === "live" && detail.rows.length === 0 && (() => {
            const MONO = "'SF Mono',Menlo,'Courier New',monospace";
            const ghost = (icon, title, sub, amt) => (
              <div style={{display:"flex",alignItems:"center",gap:10,background:T.bgAlt,border:`1px dashed ${T.border}`,borderRadius:8,padding:"10px 12px",marginBottom:6,opacity:.7}}>
                <span style={{fontSize:16}}>{icon}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.textMid}}>{title}</div>
                  <div style={{fontSize:10,color:T.textSoft,fontFamily:MONO}}>{sub}</div>
                  <div style={{fontSize:9,color:T.textSoft,marginTop:2}}>2026-08-02 · tx ↗</div>
                </div>
                <div style={{fontSize:13,fontWeight:800,color:T.green3,fontFamily:MONO,whiteSpace:"nowrap"}}>{amt}</div>
              </div>
            );
            return (
              <div>
                <div style={{fontSize:10,color:T.textSoft,marginBottom:8}}>No submissions yet — here's what they'll look like (example):</div>
                {ghost("⚡", "Meter reading", "3775 → 3776 · 1.0 kWh used", "+4.47")}
                {ghost("🌿", "Eco bonus", "washer on eco mode", "+8.00")}
              </div>
            );
          })()}

          {detail.rows.slice(0, 30).map((r) => (
            <SubmissionRow key={r.id} r={r} T={T} onAdminApi={onAdminApi} onToast={onToast} archiveOn={!!(onAdminApi && diag.health?.photoArchive)} />
          ))}
          {onAdminApi && diag.health && !diag.health.photoArchive && detail.rows.length > 0 && (
            <div style={{marginTop:2,fontSize:9.5,color:T.textSoft,padding:"0 2px"}}>
              📷 Photo review is off. Set the R2 keys in the backend to keep a thumbnail of each submission here.
            </div>
          )}

          {onAdminApi
            ? <WalletAdminActions T={T} address={selected} meters={meters} onAdminApi={onAdminApi} onToast={onToast} />
            : (
              <div style={{marginTop:16,padding:"10px 12px",background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,fontSize:10.5,color:T.textMid,lineHeight:1.6}}>
                ℹ️ This view is read-only (the blockchain is the source of truth). <strong>Editing</strong> a wallet's meters requires the reward backend (meters are otherwise stored on each user's own device).
              </div>
            )}
        </div>
      </div>
    );
  }

  // ── Participant list + search ──────────────────────────────────────────────
  return (
    <div style={{position:"fixed",inset:0,background:T.bg,zIndex:320,display:"flex",flexDirection:"column"}}>
      {headerBar("🛡️ Admin · Participants", `Read-only on-chain monitor · ${NETWORK_LABEL}`, null)}
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
          {[
            { k:"Participants",     v: chain.rows.length },
            { k:"B3TR Distributed", v: totalB3tr.toFixed(2) },
            { k:"Submissions",      v: totalSubs },
          ].map(s => (
            <div key={s.k} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:5,padding:"12px 8px",textAlign:"center"}}>
              <div style={{fontSize:17,fontWeight:600,color:T.text,fontFamily:"'SF Mono',monospace"}}>{s.v}</div>
              <div style={{fontSize:7.5,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft,marginTop:3}}>{s.k}</div>
            </div>
          ))}
        </div>

        <button onClick={() => setOpsOpen(o => !o)} style={{display:"flex",width:"100%",alignItems:"center",justifyContent:"space-between",background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:"11px 14px",marginBottom:12,cursor:"pointer",color:T.text}}>
          <span style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px"}}>⚙️ Setup &amp; diagnostics</span>
          <span style={{color:T.textSoft,fontSize:13}}>{opsOpen ? "▲ hide" : "▼ show"}</span>
        </button>
        {opsOpen && (<>
        {(() => {
          const h = diag.health, c = diag.chain;
          const authorized = c?.distributorAuthorized ?? h?.distributorAuthorized ?? null;
          const poolOk = (c?.poolB3TR ?? h?.poolB3TR ?? null);
          const vtho = c?.distributorVTHO ?? null;
          const payouts = c?.payoutCount ?? null;
          const Row = ({ ok, label, fix }) => (
            <div style={{display:"flex",gap:8,alignItems:"flex-start",padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <span style={{fontSize:13,lineHeight:"16px"}}>{ok === null ? "◌" : ok ? "✅" : "❌"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:11.5,fontWeight:700,color:ok === false ? T.gas : T.text}}>{label}</div>
                {ok === false && fix && <div style={{fontSize:10.5,color:T.textMid,lineHeight:1.45,marginTop:2}}>{fix}</div>}
              </div>
            </div>
          );
          return (
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:"12px 14px",marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px",color:T.green3}}>🩺 System check</div>
                <button onClick={() => { setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); }}
                  style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 10px",fontSize:10,fontWeight:700,color:T.textMid,cursor:"pointer"}}>
                  {diag.status === "loading" ? "…" : "↻ Re-run"}
                </button>
              </div>
              {diag.status === "loading" ? (
                <div style={{fontSize:11,color:T.textSoft,padding:"8px 0"}}>Running checks…</div>
              ) : (
                <>
                  <Row ok={diag.backend} label={`Reward backend online${h?.network ? ` (${h.network})` : ""}`}
                    fix="The Render service is unreachable or asleep — open the /health URL once to wake it, and check the Render dashboard." />
                  <Row ok={authorized} label="Distributor wallet has the reward-distributor role"
                    fix={`THIS IS THE USUAL CAUSE OF REVERTED PAYOUTS. In the VeBetterDAO testnet dashboard, open your app → settings → Reward distributors, and add ${h?.distributor || "the distributor wallet"} — then sign and retry.`} />
                  {(() => {
                    const adminAddr = c?.appAdmin ?? h?.appAdmin ?? null;
                    const a = adminAddr ? String(adminAddr).toLowerCase() : null;
                    const isMe = !!(a && wallet && a === String(wallet).toLowerCase());
                    const isDistributor = !!(a && h?.distributor && a === String(h.distributor).toLowerCase());
                    return <Row ok={a === null ? null : (isMe || isDistributor)}
                      label={`On-chain app admin: ${adminAddr ? shortAddr(adminAddr) : "unknown"}${isMe ? " — your connected wallet ✓" : isDistributor ? " — the server's distributor (bucket moves run server-side) ✓" : ""}`}
                      fix={`Only the app-admin wallet may move funds between buckets or toggle the rewards-pool feature. Admin is ${adminAddr || "unknown"} — connect VeWorld with THAT wallet and retry, or change the app admin in the VeBetterDAO dashboard.`} />;
                  })()}
                  {(() => {
                    const rpEnabled = c?.rewardsPoolEnabled ?? h?.rewardsPoolEnabled ?? null;
                    const rpBal = c?.rewardsPoolB3TR ?? h?.rewardsPoolB3TR ?? null;
                    // With the rewards-pool feature ON, moving the whole deposit into
                    // the distributable bucket legitimately empties availableFunds —
                    // total funding is what matters, so count BOTH buckets here.
                    const totalFunded = (poolOk ?? 0) + (rpEnabled === true ? (rpBal ?? 0) : 0);
                    const fundedOk = poolOk === null && rpBal === null ? null : totalFunded > 0;
                    // Feature off → payouts draw straight from available funds (fine).
                    // Feature ON → the distributable bucket itself must hold B3TR.
                    const distOk = rpEnabled === null ? null : (rpEnabled === false ? true : (rpBal === null ? null : rpBal > 0));
                    return (<>
                      <Row ok={fundedOk} label={`Reward pool funded${poolOk != null ? ` (${poolOk.toFixed(2)} available${rpEnabled === true && rpBal != null ? ` + ${rpBal.toFixed(2)} distributable` : ""})` : ""}`}
                        fix="No B3TR in either bucket for this app id — use the Fund rewards pool card below." />
                      <Row ok={distOk}
                        label={rpEnabled === false
                          ? "Distributable balance (rewards-pool feature off — pays from available funds)"
                          : `Distributable rewards-pool balance${rpBal != null ? ` (${rpBal.toFixed(2)} B3TR)` : ""}`}
                        fix="FOUND IT — the rewards-pool feature is ON for this app, so payouts draw from THIS bucket, not from 'available funds'. Your deposit is sitting in the wrong bucket. Use the 'Move to rewards pool' button below (you sign as app admin), then re-run this check." />
                    </>);
                  })()}
                  <Row ok={h?.delegation ? true : (vtho === null ? null : vtho >= 1)}
                    label={h?.delegation ? "Gas sponsored via fee delegation" : `Distributor has gas${vtho != null ? ` (${vtho.toFixed(1)} VTHO)` : ""}`}
                    fix={`Send free testnet VTHO to ${h?.distributor || "the distributor wallet"} via faucet.vecha.in.`} />
                  <Row ok={payouts === null ? null : payouts > 0} label={payouts != null ? `${payouts >= 20 ? "20+" : payouts} payout${payouts === 1 ? "" : "s"} recorded on-chain${c?.lastPayoutAt ? ` — last ${new Date(c.lastPayoutAt).toLocaleString()}` : ""}` : "Payouts recorded on-chain"}
                    fix="No payout has EVER landed on-chain for this app id. Fix the failing checks above, submit a reading, then re-run this check." />
                </>
              )}
            </div>
          );
        })()}

        {onFundPool && (
          <div style={{background:T.card,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"12px 14px",marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px",color:T.green3,marginBottom:6}}>🎁 Fund rewards pool</div>
            {(() => {
              const empty = pool.status === "live" && pool.b3tr <= 0;
              const c = pool.status === "live" ? (empty ? T.gas : T.green3) : T.textSoft;
              return (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,background:T.bgAlt,border:`1px solid ${empty ? T.gasBorder : T.border}`,borderRadius:6,padding:"9px 12px",marginBottom:10}}>
                  <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft}}>Pool balance</span>
                  <span style={{display:"inline-flex",alignItems:"center",fontSize:14,fontWeight:700,color:c,fontFamily:"'SF Mono',Menlo,'Courier New',monospace"}}>
                    {pool.status === "loading" ? "…" : pool.status === "error" ? "—" : `${pool.b3tr.toFixed(2)} B3TR`}
                    {empty && <span style={{fontSize:9,fontWeight:700,marginLeft:6,color:T.gas,background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:2,padding:"1px 5px"}}>EMPTY</span>}
                  </span>
                </div>
              );
            })()}
            <div style={{fontSize:10.5,color:T.textMid,lineHeight:1.5,marginBottom:10}}>Deposit B3TR from your connected wallet into this app's reward pool. You sign one transaction (approve + deposit) in your wallet.</div>
            <div style={{display:"flex",gap:8}}>
              <input value={fundAmt} onChange={e=>setFundAmt(e.target.value)} type="number" min="0" step="1" placeholder="B3TR amount"
                style={{flex:1,boxSizing:"border-box",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",fontSize:13,color:T.text,outline:"none"}} />
              <button disabled={funding} onClick={async()=>{ setFunding(true); try { await onFundPool(fundAmt); setPool(p=>({...p,status:"loading"})); setTimeout(()=>refreshPool(), 8000); } finally { setFunding(false); } }}
                style={{background:T.green2,color:T.bg,border:0,borderRadius:6,padding:"10px 16px",fontWeight:700,fontSize:13,cursor:"pointer",opacity:funding?0.6:1,whiteSpace:"nowrap"}}>
                {funding ? "Signing…" : "Fund pool"}
              </button>
            </div>
            {onMoveToRewardsPool && (
              <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:10,color:T.textSoft,lineHeight:1.45,flex:1}}>Payouts reverting while funded? Move the deposit into the app's distributable rewards-pool bucket (same amount field above).</div>
                <button disabled={funding} onClick={async()=>{ setFunding(true); try { await onMoveToRewardsPool(fundAmt); setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); } finally { setFunding(false); } }}
                  style={{background:"transparent",color:T.green3,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"8px 12px",fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap",opacity:funding?0.6:1}}>
                  ⇄ Move to rewards pool
                </button>
              </div>
            )}
            {onDisableRewardsPool && (
              <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:10,color:T.textSoft,lineHeight:1.45,flex:1}}>Or turn the rewards-pool feature OFF so payouts draw straight from available funds (no bucket-moving needed).</div>
                <button disabled={funding} onClick={async()=>{ setFunding(true); try { await onDisableRewardsPool(); setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); } finally { setFunding(false); } }}
                  style={{background:"transparent",color:T.textMid,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 12px",fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap",opacity:funding?0.6:1}}>
                  🔧 Disable feature
                </button>
              </div>
            )}
            {onClaimB3TR && (
              <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                <div style={{fontSize:10,color:T.textSoft,lineHeight:1.45,flex:1}}>No test-B3TR yet? Claim a free batch from the testnet faucet first, then fund the pool.</div>
                <button disabled={claiming} onClick={async()=>{ setClaiming(true); try { await onClaimB3TR(); } finally { setClaiming(false); } }}
                  style={{background:"transparent",color:T.green3,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"8px 12px",fontWeight:700,fontSize:11,cursor:"pointer",opacity:claiming?0.6:1,whiteSpace:"nowrap"}}>
                  {claiming ? "Claiming…" : "💧 Claim test-B3TR"}
                </button>
              </div>
            )}
          </div>
        )}
        </>)}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔎 Search wallet address (0x…)"
          spellCheck={false}
          style={{width:"100%",boxSizing:"border-box",background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:"11px 12px",fontSize:12,color:T.text,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",outline:"none",marginBottom:10}}
        />

        {/* The on-chain list only has wallets that already earned. One tap pulls in
            everyone the backend knows — testers who connected or registered a meter
            but haven't submitted yet — so nothing has to be added by hand. */}
        {onAdminApi && (
          <div style={{marginBottom:12}}>
            <button
              disabled={loadingWallets}
              onClick={async () => {
                setLoadingWallets(true);
                try {
                  const d = await onAdminApi("/admin/wallets", {});
                  setKnownWallets(d.wallets || []);
                  const extra = (d.wallets || []).filter(w => !chain.rows.some(r => r.addr.toLowerCase() === String(w.address).toLowerCase())).length;
                  onToast?.(extra ? `✅ ${extra} wallet(s) without rewards added to the list` : "✅ No extra wallets — everyone already shows");
                } catch (e) { onToast?.(`❌ ${e?.message || "could not load wallets"}`); }
                finally { setLoadingWallets(false); }
              }}
              style={{width:"100%",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:loadingWallets?"default":"pointer",opacity:loadingWallets?0.6:1}}>
              {loadingWallets ? "Loading…" : knownWallets ? "🔄 Refresh all wallets" : "👥 Show all wallets (incl. no rewards yet)"}
            </button>
          </div>
        )}

        {isFullAddr && !filtered.some(r => r.addr.toLowerCase() === q) && (
          <div onClick={() => setSelected(q)} style={{cursor:"pointer",background:T.green5||T.bgAlt,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"11px 12px",marginBottom:10,fontSize:11,fontWeight:700,color:T.green3}}>
            Look up this wallet → {shortAddr(q)} (no rewards yet, view its meters/history)
          </div>
        )}

        {chain.status === "loading" && (
          <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:24}}>Loading on-chain participants…</div>
        )}
        {chain.status !== "loading" && chain.rows.length === 0 && (
          <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:24,lineHeight:1.6}}>
            {chain.reason === "unset_appid"
              ? "Set your VeBetterDAO App ID to load participants."
              : chain.status === "error" ? "Could not reach the node — try again later." : "No on-chain submissions yet."}
          </div>
        )}
        {chain.rows.length > 0 && filtered.length === 0 && !isFullAddr && (
          <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:18}}>No participant matches “{query}”.</div>
        )}
        {filtered.map((r, i) => (
          <div key={r.addr} className="lb-item" style={{cursor:"pointer"}} onClick={() => setSelected(r.addr)}>
            <div className="lb-rank">{q || r.isNew ? "•" : i + 1}</div>
            <div style={{flex:1}}>
              <div className="lb-name" style={{fontFamily:"'SF Mono',monospace",fontSize:11}}>
                {shortAddr(r.addr)}
                {r.banned && <span style={{marginLeft:6,fontSize:8,fontWeight:800,color:"#c0392b"}}>BLOCKED</span>}
              </div>
              <div style={{fontSize:9,color:T.textSoft}}>
                {r.isNew
                  ? `🆕 No rewards yet${r.meters?.length ? ` · ${r.meters.length} meter${r.meters.length !== 1 ? "s" : ""} registered` : ""} · tap to view`
                  : `📸 ${r.count} submission${r.count !== 1 ? "s" : ""} · tap to view`}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div className="lb-b3tr" style={r.isNew ? {color:T.textSoft} : undefined}>+{r.b3tr.toFixed(2)}</div>
              <div style={{fontSize:9,color:T.textSoft}}>B3TR</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileScreen({ b3tr, subs, wallet, setShowWallet, dark, setDark, notifs, setNotifs, setOnboarded, onEditMeters, onEditSolar, meters, isAdmin, onOpenAdmin, onOpenHelp, onOpenFeedback, onToast, onReset, T }) {
  const tier = getTier(b3tr);
  return (
    <>
      <div className="profile-hero">
        <div style={{fontSize:18}}>🌱</div>
        <div className="pname">My Account</div>
        <div style={{fontSize:10,color:T.textSoft,fontFamily:"'SF Mono',monospace",marginTop:3}}>{wallet ? shortAddr(wallet) : "Not connected"}</div>
        <div style={{fontSize:8,fontWeight:700,background:T.bgAlt,color:tier.color,border:`1px solid ${T.border}`,borderRadius:2,padding:"3px 7px",marginTop:10,textTransform:"uppercase",letterSpacing:".8px"}}>{tier.name} Tier</div>
      </div>
      
      <div className="pstat-row">
        {[{v:b3tr.toFixed(2),k:"B3TR Earned"},{v:subs.length,k:"Submissions"}].map(x=>(
          <div key={x.k} className="pstat"><div className="pstat-val">{x.v}</div><div className="pstat-key">{x.k}</div></div>
        ))}
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Settings</div><div className="sec-line"/></div>
      <div className="setting-row" onClick={()=>setDark(d=>!d)}>
        <div className="sr-left">
          <div className="sr-icon">🌙</div>
          <div><div className="sr-label">Dark Mode</div><div className="sr-sub">{dark ? "On" : "Off"}</div></div>
        </div>
        <div className="sr-right"><Toggle on={dark} onToggle={(e)=>{ e?.stopPropagation?.(); setDark(d=>!d); }}/></div>
      </div>
      <div className="setting-row" onClick={onEditMeters}>
        <div className="sr-left">
          <div className="sr-icon">🔢</div>
          <div><div className="sr-label">Meters & Baselines</div><div className="sr-sub">{UTILS.map(u => u.label).join(", ")}</div></div>
        </div>
        <div className="sr-right" style={{fontSize:11,color:T.textSoft}}>→</div>
      </div>
      {SOLAR_UTILS.length > 0 && (() => {
        const solarNo = (meters?.solar || "").trim();
        return (
          <div className="setting-row" onClick={onEditSolar}>
            <div className="sr-left">
              <div className="sr-icon">☀️</div>
              <div><div className="sr-label">Solar Panels</div><div className="sr-sub">{solarNo ? `Meter #${solarNo}` : "Add solar panels (optional)"}</div></div>
            </div>
            <div className="sr-right" style={{fontSize:11,fontWeight:solarNo?400:700,color:solarNo?T.textSoft:T.green3}}>{solarNo ? "→" : "Add"}</div>
          </div>
        );
      })()}

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Export</div><div className="sec-line"/></div>
      <div className="setting-row" onClick={async () => { const ok = await generateMonthlyPDF(b3tr, subs); onToast?.(ok ? "📄 Report downloaded" : "❌ Couldn't generate the report"); }}>
        <div className="sr-left">
          <div className="sr-icon">📄</div>
          <div><div className="sr-label">Download Monthly Report</div><div className="sr-sub">PDF with stats, trends, and proof</div></div>
        </div>
        <div className="sr-right"><span style={{fontSize:11,fontWeight:700,color:T.green3}}>Export</span></div>
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Notifications</div><div className="sec-line"/></div>
      <div className="notif-card">
        <div className="notif-hdr">Daily Reminders</div>
        {[
          {id:"daily",   label:"Daily submission",  sub:"08:00 AM reminder to log your meters"},
          {id:"streak",  label:"Streak alert",      sub:"Get warned before losing your streak"},
          {id:"rewards", label:"Reward updates",    sub:"B3TR payouts and VeChain confirmations"},
          {id:"lb",      label:"Leaderboard",       sub:"Get notified when you climb the ranks"},
        ].map(n => (
          <div key={n.id} className="notif-row">
            <div>
              <div className="notif-label">{n.label}</div>
              <div className="notif-sub">{n.sub}</div>
            </div>
            <div className="sr-right"><Toggle on={notifs[n.id]} onToggle={()=>setNotifs(x=>({...x,[n.id]:!x[n.id]}))} /></div>
          </div>
        ))}
      </div>

      <div className="sec" style={{marginTop:20}}><div className="sec-line"/><div className="sec-txt">Support</div><div className="sec-line"/></div>
      <div className="setting-row" onClick={onOpenHelp}>
        <div className="sr-left">
          <div className="sr-icon">❓</div>
          <div><div className="sr-label">Help &amp; FAQ</div><div className="sr-sub">How to test, earn B3TR &amp; troubleshoot</div></div>
        </div>
        <div className="sr-right" style={{fontSize:11,color:T.textSoft}}>→</div>
      </div>
      <div className="setting-row" onClick={onOpenFeedback}>
        <div className="sr-left">
          <div className="sr-icon">✉️</div>
          <div><div className="sr-label">Send Feedback</div><div className="sr-sub">Report a bug or share an idea</div></div>
        </div>
        <div className="sr-right" style={{fontSize:11,fontWeight:700,color:T.green3}}>Send</div>
      </div>

      <div className="sec" style={{marginTop:20}}><div className="sec-line"/><div className="sec-txt">Account</div><div className="sec-line"/></div>
      <div className="setting-row" onClick={() => setShowWallet(true)}>
        <div className="sr-left">
          <div className="sr-icon">💼</div>
          <div><div className="sr-label">Wallet</div><div className="sr-sub">{wallet || "Not connected"}</div></div>
        </div>
        <div className="sr-right" style={{fontSize:10,color:T.green3}}>Connect</div>
      </div>
      <div className="setting-row" style={{marginBottom:isAdmin?5:14}} onClick={() => setOnboarded(false)}>
        <div className="sr-left">
          <div className="sr-icon">🎓</div>
          <div><div className="sr-label">View Tutorial</div><div className="sr-sub">Re-watch the onboarding guide</div></div>
        </div>
        <div className="sr-right" style={{fontSize:11,color:T.textSoft}}>→</div>
      </div>
      {isAdmin && (
        <div className="setting-row" style={{marginBottom:5,borderColor:T.green4}} onClick={onOpenAdmin}>
          <div className="sr-left">
            <div className="sr-icon">🛡️</div>
            <div><div className="sr-label">Admin · Participants</div><div className="sr-sub">Read-only on-chain monitor</div></div>
          </div>
          <div className="sr-right" style={{fontSize:11,color:T.green3}}>Open</div>
        </div>
      )}
      {isAdmin && (
        <div className="setting-row" style={{marginBottom:14,borderColor:T.gasBorder}} onClick={() => { if (window.confirm("Reset all app data and disconnect? This clears local meters, baselines and history for a fresh test. (On-chain rewards stay on the blockchain.)")) onReset?.(); }}>
          <div className="sr-left">
            <div className="sr-icon">🔄</div>
            <div><div className="sr-label">Reset app data</div><div className="sr-sub">Admin/testing — clears local data &amp; disconnects</div></div>
          </div>
          <div className="sr-right" style={{fontSize:11,fontWeight:700,color:T.gas}}>Reset</div>
        </div>
      )}
    </>
  );
}

function Toggle({ on, onToggle }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={onToggle}>
      <div className="toggle-dot"/>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// HELP & FAQ  — full-screen guide for new testers (no backend needed)
// ════════════════════════════════════════════════════════════════════════════
// Help content in several languages. The P1/meter answers keep \n line breaks
// (rendered with white-space: pre-line). Add a language by adding a key here.
const HELP_I18N = {
  en: { name:"English", subtitle:"Getting started", quick:"Quick start", faqLabel:"Frequently asked", close:"Close", feedback:"✉️ Send Feedback",
    steps:[
      { t:"Connect your wallet", d:"Tap Connect and open VeWorld (set to Testnet) or WalletConnect. This is a test app — no real funds are used." },
      { t:"Get free test gas (VTHO)", d:"Transactions cost a tiny bit of VTHO. Grab some free testnet VTHO from the faucet, then come back." },
      { t:"Register your meters", d:"Enter the meter number and the current reading (baseline) for electricity, gas and water. Solar is optional." },
      { t:"Submit a reading", d:"Go to Submit, pick a utility, photograph the meter (the app reads the number for you), check it, and send." },
      { t:"Earn B3TR", d:"A valid reading rewards you with B3TR on testnet. Track your total on Home and your position on the Leaderboard." },
    ], faqs:[
      { q:"Where do I find my meter number?", a:"Two spots on the meter:\n1) On the little screen — press the meter's buttons until the number appears.\n2) Under the barcode, on a sticker on the front or side.\nEnter the whole number including the letter — electricity usually starts with E, gas with G. It's also on your energy bill or your supplier's online account." },
      { q:"Automatic reading (P1 reader / HomeWizard)", a:"With a P1 reader like a HomeWizard, your meter is read for you and sent in on its own.\n1. In the HomeWizard app, turn on \"Local API\".\n2. Do one photo submission first (it sets your baseline).\n3. In Submit → Electricity → \"Auto (reader)\" → \"Automatic setup\", tap \"Get my device token\" and copy it.\n4. On a device that stays on (Raspberry Pi / NAS / PC), run the copied setup once — it finds your meter and sends the reading every hour.\n5. Your reading shows as \"Auto-received\" → tap \"Submit — no photo\".\nNo always-on device? Just take a photo — that's easiest for most people." },
      { q:"Where do I paste the setup code?", a:"In a terminal on the device that stays on:\n• Windows — press Start, type PowerShell, open it\n• Mac — open Terminal (Applications → Utilities)\n• Raspberry Pi / NAS — its Terminal, or connect over SSH\nPaste, press Enter, and leave it running. That device needs Node.js 18+ installed.\nUsing Home Assistant? No terminal needed — you paste the YAML into configuration.yaml instead.\nToo technical? Just take a photo — that works just as well." },
      { q:"Which meters work?", a:"Almost any Dutch or Belgian smart meter with a P1 port. Dutch meters send plain data and work out of the box. Belgian (Fluvius) meters are encrypted — enter the free Fluvius key in the HomeWizard app once, then it works the same." },
      { q:"Do I always need a photo?", a:"A photo is required for a hand-entered reading. A connected P1 reader can submit without a photo, because its device token binds the reading to your wallet." },
      { q:"Is this real money?", a:"No. Everything runs on VeChain testnet, so the B3TR you earn are test tokens with no real value — perfect for trying things out safely." },
      { q:"I submitted but got no B3TR — why?", a:"Most common reasons: the new reading isn't higher than your last one, the photo was reused, or a cooldown is active for that utility. Try a fresh photo of an actual meter." },
      { q:"My photo was rejected.", a:"Use a real, clear photo of your own meter — good lighting, numbers in focus, no screenshots or photos of a screen." },
      { q:"I reconnected and lost my meters?", a:"Reconnecting the SAME wallet keeps your meters and baselines. Only connecting a different wallet starts a fresh setup." },
      { q:"My wallet won't connect.", a:"Make sure VeWorld is switched to Testnet. On mobile, use the in-app browser or WalletConnect QR." },
      { q:"Found a bug or have an idea?", a:"Use Send Feedback below — it pre-fills an email with your message and some helpful diagnostics." },
    ] },
  nl: { name:"Nederlands", subtitle:"Aan de slag", quick:"Snel starten", faqLabel:"Veelgestelde vragen", close:"Sluiten", feedback:"✉️ Feedback sturen",
    steps:[
      { t:"Verbind je wallet", d:"Tik op Connect en open VeWorld (op Testnet) of WalletConnect. Dit is een test-app — er wordt geen echt geld gebruikt." },
      { t:"Haal gratis test-gas (VTHO)", d:"Transacties kosten een beetje VTHO. Haal gratis testnet-VTHO bij de faucet en kom terug." },
      { t:"Registreer je meters", d:"Voer het meternummer en de huidige stand (baseline) in voor stroom, gas en water. Zon is optioneel." },
      { t:"Doe een inzending", d:"Ga naar Submit, kies een meter, fotografeer 'm (de app leest het nummer), controleer en verstuur." },
      { t:"Verdien B3TR", d:"Een geldige stand levert B3TR op testnet op. Zie je totaal op Home en je positie in het klassement." },
    ], faqs:[
      { q:"Waar vind ik mijn meternummer?", a:"Twee plekken op de meter:\n1) Op het schermpje — druk op de knopjes tot het nummer verschijnt.\n2) Onder de streepjescode, op een sticker aan de voor- of zijkant.\nNeem het hele nummer over, mét de letter — stroom begint meestal met E, gas met G. Het staat ook op je energierekening of in je online account bij je leverancier." },
      { q:"Automatisch uitlezen (P1-reader / HomeWizard)", a:"Met een P1-reader zoals een HomeWizard wordt je meter voor je uitgelezen en vanzelf ingestuurd.\n1. Zet in de HomeWizard-app \"Local API\" aan.\n2. Doe eerst één foto-inzending (dat zet je baseline).\n3. In Submit → Electricity → \"Auto (reader)\" → \"Automatic setup\": tik \"Get my device token\" en kopieer 'm.\n4. Draai op een altijd-aan-apparaat (Raspberry Pi / NAS / pc) de gekopieerde setup één keer — het vindt je meter en stuurt elk uur je stand.\n5. Je stand verschijnt als \"Auto-received\" → tik \"Submit — no photo\".\nGeen altijd-aan-apparaat? Maak gewoon een foto — voor de meeste mensen het makkelijkst." },
      { q:"Waar plak ik de setup-code?", a:"In een terminal op het apparaat dat altijd aan staat:\n• Windows — druk op Start, typ PowerShell, open 'm\n• Mac — open Terminal (Programma's → Hulpprogramma's)\n• Raspberry Pi / NAS — de Terminal daar, of verbind via SSH\nPlakken, Enter drukken, en laten draaien. Op dat apparaat moet Node.js 18+ staan.\nGebruik je Home Assistant? Dan heb je geen terminal nodig — daar plak je de YAML in configuration.yaml.\nTe technisch? Maak gewoon een foto — dat werkt net zo goed." },
      { q:"Welke meters werken?", a:"Bijna elke Nederlandse of Belgische slimme meter met een P1-poort. Nederlandse meters sturen open data en werken direct. Belgische (Fluvius) meters zijn versleuteld — voer de gratis Fluvius-sleutel één keer in de HomeWizard-app in, daarna werkt alles hetzelfde." },
      { q:"Heb ik altijd een foto nodig?", a:"Voor een handmatig ingevoerde stand is een foto verplicht. Een gekoppelde P1-reader mag zonder foto insturen, omdat zijn device-token de stand aan jouw wallet koppelt." },
      { q:"Is dit echt geld?", a:"Nee. Alles draait op VeChain testnet, dus de B3TR die je verdient zijn test-tokens zonder echte waarde — perfect om veilig te testen." },
      { q:"Ik heb ingezonden maar geen B3TR — waarom?", a:"Meest voorkomend: de nieuwe stand is niet hoger dan je vorige, de foto is hergebruikt, of er is een cooldown actief. Probeer een verse foto van een echte meter." },
      { q:"Mijn foto werd geweigerd.", a:"Gebruik een echte, scherpe foto van je eigen meter — goed licht, cijfers in beeld, geen screenshots of foto's van een scherm." },
      { q:"Ik verbond opnieuw en mijn meters zijn weg?", a:"Opnieuw verbinden met DEZELFDE wallet behoudt je meters en baselines. Alleen een ándere wallet start opnieuw." },
      { q:"Mijn wallet verbindt niet.", a:"Zorg dat VeWorld op Testnet staat. Op mobiel: gebruik de in-app browser of WalletConnect-QR." },
      { q:"Bug gevonden of een idee?", a:"Gebruik Feedback sturen hieronder — het vult een e-mail voor met je bericht en handige diagnostiek." },
    ] },
  de: { name:"Deutsch", subtitle:"Erste Schritte", quick:"Schnellstart", faqLabel:"Häufige Fragen", close:"Schließen", feedback:"✉️ Feedback senden",
    steps:[
      { t:"Wallet verbinden", d:"Tippe auf Connect und öffne VeWorld (auf Testnet) oder WalletConnect. Dies ist eine Test-App — es wird kein echtes Geld verwendet." },
      { t:"Kostenloses Test-Gas (VTHO)", d:"Transaktionen kosten etwas VTHO. Hol dir kostenloses Testnet-VTHO vom Faucet und komm zurück." },
      { t:"Zähler registrieren", d:"Gib die Zählernummer und den aktuellen Stand (Basiswert) für Strom, Gas und Wasser ein. Solar ist optional." },
      { t:"Stand einreichen", d:"Geh zu Submit, wähle einen Zähler, fotografiere ihn (die App liest die Nummer), prüfe und sende." },
      { t:"B3TR verdienen", d:"Ein gültiger Stand belohnt dich mit B3TR im Testnet. Sieh dein Gesamt auf Home und deine Position in der Rangliste." },
    ], faqs:[
      { q:"Wo finde ich meine Zählernummer?", a:"Zwei Stellen am Zähler:\n1) Auf dem kleinen Display — drücke die Tasten, bis die Nummer erscheint.\n2) Unter dem Barcode, auf einem Aufkleber vorne oder seitlich.\nGib die ganze Nummer inklusive Buchstabe ein — Strom beginnt meist mit E, Gas mit G. Sie steht auch auf deiner Energierechnung oder im Online-Konto deines Anbieters." },
      { q:"Automatisches Auslesen (P1-Reader / HomeWizard)", a:"Mit einem P1-Reader wie einem HomeWizard wird dein Zähler für dich ausgelesen und von selbst gesendet.\n1. Aktiviere in der HomeWizard-App die \"Local API\".\n2. Mach zuerst eine Foto-Einreichung (setzt deinen Basiswert).\n3. In Submit → Electricity → \"Auto (reader)\" → \"Automatic setup\": tippe \"Get my device token\" und kopiere ihn.\n4. Führe auf einem Dauergerät (Raspberry Pi / NAS / PC) das kopierte Setup einmal aus — es findet deinen Zähler und sendet stündlich den Stand.\n5. Dein Stand erscheint als \"Auto-received\" → tippe \"Submit — no photo\".\nKein Dauergerät? Mach einfach ein Foto — für die meisten am einfachsten." },
      { q:"Wo füge ich den Setup-Code ein?", a:"In einem Terminal auf dem Dauergerät:\n• Windows — Start drücken, PowerShell tippen, öffnen\n• Mac — Terminal öffnen (Programme → Dienstprogramme)\n• Raspberry Pi / NAS — dessen Terminal, oder per SSH verbinden\nEinfügen, Enter drücken und laufen lassen. Auf dem Gerät muss Node.js 18+ installiert sein.\nDu nutzt Home Assistant? Dann kein Terminal nötig — dort fügst du das YAML in die configuration.yaml ein.\nZu technisch? Mach einfach ein Foto — das funktioniert genauso gut." },
      { q:"Welche Zähler funktionieren?", a:"Fast jeder niederländische oder belgische Smart-Zähler mit P1-Anschluss. Niederländische Zähler senden offene Daten und laufen sofort. Belgische (Fluvius) Zähler sind verschlüsselt — gib den kostenlosen Fluvius-Schlüssel einmal in der HomeWizard-App ein, danach läuft alles gleich." },
      { q:"Brauche ich immer ein Foto?", a:"Für einen manuell eingegebenen Stand ist ein Foto nötig. Ein verbundener P1-Reader darf ohne Foto senden, weil sein Geräte-Token den Stand an dein Wallet bindet." },
      { q:"Ist das echtes Geld?", a:"Nein. Alles läuft im VeChain-Testnet, die B3TR sind Test-Token ohne realen Wert — ideal zum sicheren Ausprobieren." },
      { q:"Ich habe eingereicht, aber kein B3TR — warum?", a:"Häufigste Gründe: der neue Stand ist nicht höher als der letzte, das Foto wurde wiederverwendet, oder eine Sperrzeit ist aktiv. Versuch ein frisches Foto eines echten Zählers." },
      { q:"Mein Foto wurde abgelehnt.", a:"Nutze ein echtes, scharfes Foto deines eigenen Zählers — gutes Licht, Ziffern im Fokus, keine Screenshots oder Bildschirmfotos." },
      { q:"Neu verbunden und meine Zähler sind weg?", a:"Erneutes Verbinden mit DEMSELBEN Wallet behält deine Zähler und Basiswerte. Nur ein anderes Wallet startet neu." },
      { q:"Mein Wallet verbindet nicht.", a:"Stelle sicher, dass VeWorld auf Testnet steht. Mobil: nutze den In-App-Browser oder WalletConnect-QR." },
      { q:"Bug gefunden oder eine Idee?", a:"Nutze Feedback senden unten — es füllt eine E-Mail mit deiner Nachricht und hilfreicher Diagnose vor." },
    ] },
  fr: { name:"Français", subtitle:"Démarrer", quick:"Démarrage rapide", faqLabel:"Questions fréquentes", close:"Fermer", feedback:"✉️ Envoyer un retour",
    steps:[
      { t:"Connectez votre wallet", d:"Touchez Connect et ouvrez VeWorld (sur Testnet) ou WalletConnect. C'est une app de test — aucun fonds réel n'est utilisé." },
      { t:"Obtenez du gaz de test (VTHO)", d:"Les transactions coûtent un peu de VTHO. Récupérez du VTHO testnet gratuit au faucet, puis revenez." },
      { t:"Enregistrez vos compteurs", d:"Saisissez le numéro et le relevé actuel (base) pour l'électricité, le gaz et l'eau. Le solaire est optionnel." },
      { t:"Envoyez un relevé", d:"Allez dans Submit, choisissez un compteur, photographiez-le (l'app lit le numéro), vérifiez et envoyez." },
      { t:"Gagnez des B3TR", d:"Un relevé valide vous récompense en B3TR sur testnet. Suivez votre total sur Home et votre place au classement." },
    ], faqs:[
      { q:"Où trouver le numéro de mon compteur ?", a:"Deux endroits sur le compteur :\n1) Sur le petit écran — appuyez sur les boutons jusqu'à voir le numéro.\n2) Sous le code-barres, sur une étiquette à l'avant ou sur le côté.\nSaisissez tout le numéro avec la lettre — l'électricité commence souvent par E, le gaz par G. Il figure aussi sur votre facture ou votre compte en ligne fournisseur." },
      { q:"Lecture automatique (lecteur P1 / HomeWizard)", a:"Avec un lecteur P1 comme un HomeWizard, votre compteur est lu pour vous et envoyé tout seul.\n1. Dans l'app HomeWizard, activez « Local API ».\n2. Faites d'abord une soumission photo (fixe votre base).\n3. Dans Submit → Electricity → « Auto (reader) » → « Automatic setup » : touchez « Get my device token » et copiez-le.\n4. Sur un appareil toujours allumé (Raspberry Pi / NAS / PC), lancez la config copiée une fois — il trouve votre compteur et envoie le relevé chaque heure.\n5. Votre relevé apparaît en « Auto-received » → touchez « Submit — no photo ».\nPas d'appareil allumé en permanence ? Prenez simplement une photo — le plus simple pour la plupart." },
      { q:"Où coller le code de configuration ?", a:"Dans un terminal, sur l'appareil qui reste allumé :\n• Windows — appuyez sur Démarrer, tapez PowerShell, ouvrez-le\n• Mac — ouvrez Terminal (Applications → Utilitaires)\n• Raspberry Pi / NAS — son Terminal, ou connectez-vous en SSH\nCollez, appuyez sur Entrée, et laissez tourner. Cet appareil doit avoir Node.js 18+.\nVous utilisez Home Assistant ? Pas de terminal — vous collez le YAML dans configuration.yaml.\nTrop technique ? Prenez simplement une photo — ça marche aussi bien." },
      { q:"Quels compteurs fonctionnent ?", a:"Presque tout compteur intelligent néerlandais ou belge avec un port P1. Les compteurs néerlandais envoient des données ouvertes et marchent directement. Les compteurs belges (Fluvius) sont chiffrés — saisissez une fois la clé Fluvius gratuite dans l'app HomeWizard, puis tout fonctionne pareil." },
      { q:"Faut-il toujours une photo ?", a:"Une photo est requise pour un relevé saisi à la main. Un lecteur P1 connecté peut envoyer sans photo, car son jeton d'appareil lie le relevé à votre wallet." },
      { q:"Est-ce de l'argent réel ?", a:"Non. Tout tourne sur le testnet VeChain ; les B3TR gagnés sont des jetons de test sans valeur réelle — parfait pour essayer en toute sécurité." },
      { q:"J'ai envoyé mais aucun B3TR — pourquoi ?", a:"Raisons fréquentes : le nouveau relevé n'est pas supérieur au précédent, la photo a été réutilisée, ou un délai est actif. Essayez une photo fraîche d'un vrai compteur." },
      { q:"Ma photo a été refusée.", a:"Utilisez une vraie photo nette de votre compteur — bon éclairage, chiffres nets, pas de captures ni photos d'écran." },
      { q:"Reconnecté et j'ai perdu mes compteurs ?", a:"Se reconnecter avec le MÊME wallet garde vos compteurs et bases. Seul un autre wallet repart de zéro." },
      { q:"Mon wallet ne se connecte pas.", a:"Assurez-vous que VeWorld est sur Testnet. Sur mobile : navigateur intégré ou QR WalletConnect." },
      { q:"Un bug ou une idée ?", a:"Utilisez Envoyer un retour ci-dessous — un e-mail est prérempli avec votre message et quelques infos utiles." },
    ] },
  es: { name:"Español", subtitle:"Empezar", quick:"Inicio rápido", faqLabel:"Preguntas frecuentes", close:"Cerrar", feedback:"✉️ Enviar comentarios",
    steps:[
      { t:"Conecta tu wallet", d:"Toca Connect y abre VeWorld (en Testnet) o WalletConnect. Es una app de prueba — no se usa dinero real." },
      { t:"Consigue gas de prueba (VTHO)", d:"Las transacciones cuestan algo de VTHO. Consigue VTHO de testnet gratis en el faucet y vuelve." },
      { t:"Registra tus contadores", d:"Introduce el número y la lectura actual (base) de luz, gas y agua. La solar es opcional." },
      { t:"Envía una lectura", d:"Ve a Submit, elige un contador, fotografíalo (la app lee el número), revísalo y envía." },
      { t:"Gana B3TR", d:"Una lectura válida te premia con B3TR en testnet. Mira tu total en Home y tu puesto en la clasificación." },
    ], faqs:[
      { q:"¿Dónde encuentro el número de mi contador?", a:"Dos sitios en el contador:\n1) En la pantallita — pulsa los botones hasta que aparezca el número.\n2) Bajo el código de barras, en una pegatina delante o al lado.\nIntroduce el número completo con la letra — la luz suele empezar por E, el gas por G. También está en tu factura o en la cuenta online de tu comercializadora." },
      { q:"Lectura automática (lector P1 / HomeWizard)", a:"Con un lector P1 como un HomeWizard, tu contador se lee solo y se envía por su cuenta.\n1. En la app HomeWizard, activa «Local API».\n2. Haz primero un envío con foto (fija tu base).\n3. En Submit → Electricity → «Auto (reader)» → «Automatic setup»: toca «Get my device token» y cópialo.\n4. En un dispositivo siempre encendido (Raspberry Pi / NAS / PC), ejecuta la configuración copiada una vez — encuentra tu contador y envía la lectura cada hora.\n5. Tu lectura aparece como «Auto-received» → toca «Submit — no photo».\n¿Sin dispositivo siempre encendido? Solo haz una foto — lo más fácil para la mayoría." },
      { q:"¿Dónde pego el código de configuración?", a:"En una terminal, en el dispositivo que queda encendido:\n• Windows — pulsa Inicio, escribe PowerShell, ábrelo\n• Mac — abre Terminal (Aplicaciones → Utilidades)\n• Raspberry Pi / NAS — su Terminal, o conéctate por SSH\nPega, pulsa Enter y déjalo funcionando. Ese dispositivo necesita Node.js 18+.\n¿Usas Home Assistant? No hace falta terminal — pegas el YAML en configuration.yaml.\n¿Demasiado técnico? Solo haz una foto — funciona igual de bien." },
      { q:"¿Qué contadores funcionan?", a:"Casi cualquier contador inteligente neerlandés o belga con puerto P1. Los neerlandeses envían datos abiertos y funcionan directamente. Los belgas (Fluvius) van cifrados — introduce una vez la clave gratuita de Fluvius en la app HomeWizard y luego funciona igual." },
      { q:"¿Siempre necesito una foto?", a:"Se requiere foto para una lectura escrita a mano. Un lector P1 conectado puede enviar sin foto, porque su token de dispositivo vincula la lectura a tu wallet." },
      { q:"¿Es dinero real?", a:"No. Todo corre en el testnet de VeChain; los B3TR son tokens de prueba sin valor real — perfecto para probar con seguridad." },
      { q:"Envié pero no recibí B3TR — ¿por qué?", a:"Motivos comunes: la nueva lectura no es mayor que la anterior, la foto se reutilizó, o hay un tiempo de espera activo. Prueba una foto nueva de un contador real." },
      { q:"Rechazaron mi foto.", a:"Usa una foto real y nítida de tu propio contador — buena luz, cifras enfocadas, sin capturas ni fotos de pantalla." },
      { q:"Reconecté y perdí mis contadores.", a:"Reconectar con la MISMA wallet mantiene tus contadores y bases. Solo otra wallet empieza de cero." },
      { q:"Mi wallet no conecta.", a:"Asegúrate de que VeWorld esté en Testnet. En móvil: navegador interno o QR de WalletConnect." },
      { q:"¿Un fallo o una idea?", a:"Usa Enviar comentarios abajo — rellena un correo con tu mensaje y algunos datos útiles." },
    ] },
};

function HelpScreen({ onClose, onFeedback, T }) {
  const [lang, setLang] = useState(() => {
    try { const s = localStorage.getItem("gul_help_lang"); if (HELP_I18N[s]) return s; const n = (navigator.language || "").slice(0,2).toLowerCase(); if (HELP_I18N[n]) return n; } catch {}
    return "en";
  });
  const pickLang = (l) => { setLang(l); try { localStorage.setItem("gul_help_lang", l); } catch {} };
  const L = HELP_I18N[lang] || HELP_I18N.en;
  const steps = L.steps.map((s, i) => ({ n: i + 1, t: s.t, d: s.d }));
  const faqs = L.faqs;
  const [openFaq, setOpenFaq] = useState(0); // accordion — first item open by default
  const row = { background:T.card, border:`1px solid ${T.border}`, borderRadius:6, padding:"12px 14px", marginBottom:8 };
  return (
    <div style={{position:"fixed",inset:0,background:T.bg,zIndex:330,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>❓ Help &amp; FAQ</div>
          <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>{L.subtitle} · {NETWORK_LABEL}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"6px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer"}}>{L.close}</button>
      </div>

      {/* Language picker */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",padding:"9px 14px",borderBottom:`1px solid ${T.border}`}}>
        <span style={{fontSize:14}}>🌐</span>
        {Object.keys(HELP_I18N).map(code => (
          <button key={code} onClick={() => pickLang(code)} style={{font:"inherit",fontSize:11.5,fontWeight:700,cursor:"pointer",padding:"4px 10px",borderRadius:999,border:`1px solid ${lang===code?(T.green3||T.electric):T.border}`,background:lang===code?(T.green3||T.electric):"transparent",color:lang===code?"#fff":T.textMid}}>{HELP_I18N[code].name}</button>
        ))}
      </div>

      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"16px 14px 28px"}}>
        <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"4px 2px 10px"}}>{L.quick}</div>
        {steps.map(s => (
          <div key={s.n} style={{...row, display:"flex", gap:12, alignItems:"flex-start"}}>
            <div style={{flexShrink:0,width:24,height:24,borderRadius:"50%",background:T.green5||T.bgAlt,color:T.green3,border:`1px solid ${T.green4||T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:800}}>{s.n}</div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:3}}>{s.t}</div>
              <div style={{fontSize:12,color:T.textMid,lineHeight:1.55}}>{s.d}</div>
              {s.n === 2 && (
                <a href={TESTNET_FAUCET} target="_blank" rel="noopener noreferrer" style={{display:"inline-block",marginTop:8,fontSize:11,fontWeight:800,color:T.green3,textDecoration:"none",border:`1px solid ${T.green4||T.border}`,borderRadius:4,padding:"6px 10px"}}>💧 Open testnet faucet →</a>
              )}
            </div>
          </div>
        ))}

        <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"18px 2px 10px"}}>{L.faqLabel}</div>
        {faqs.map((f, i) => (
          <div key={i} style={{...row, padding:0, overflow:"hidden"}}>
            <button onClick={() => setOpenFaq(openFaq === i ? -1 : i)} style={{display:"flex",width:"100%",alignItems:"center",justifyContent:"space-between",gap:10,background:"transparent",border:"none",cursor:"pointer",padding:"12px 14px",textAlign:"left"}}>
              <span style={{fontSize:13,fontWeight:700,color:T.text}}>{f.q}</span>
              <span style={{color:T.textSoft,fontSize:11,flexShrink:0}}>{openFaq === i ? "▲" : "▼"}</span>
            </button>
            {openFaq === i && (
              <div style={{fontSize:12,color:T.textMid,lineHeight:1.6,padding:"0 14px 13px",whiteSpace:"pre-line"}}>{f.a}</div>
            )}
          </div>
        ))}

        <button onClick={onFeedback} style={{width:"100%",marginTop:14,background:T.green3,border:"none",borderRadius:6,padding:"13px",color:"#fff",fontSize:12,fontWeight:800,textTransform:"uppercase",letterSpacing:"1px",cursor:"pointer"}}>{L.feedback}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FEEDBACK  — composes an email to FEEDBACK_EMAIL with diagnostics (no backend)
// ════════════════════════════════════════════════════════════════════════════
function FeedbackScreen({ onClose, onToast, wallet, tab, T }) {
  const [kind, setKind] = useState("bug");
  const [msg, setMsg] = useState("");
  const kinds = [
    { id:"bug",   label:"🐞 Bug" },
    { id:"idea",  label:"💡 Idea" },
    { id:"other", label:"💬 Other" },
  ];
  const diagnostics = () => {
    const scr = (typeof window !== "undefined") ? `${window.innerWidth}×${window.innerHeight}` : "?";
    const ua = (typeof navigator !== "undefined") ? navigator.userAgent : "?";
    return [
      `App: ${APP_NAME} v${APP_VERSION}`,
      `Network: ${NETWORK_LABEL}`,
      `Wallet: ${wallet || "not connected"}`,
      `Screen: ${tab || "?"}`,
      `Viewport: ${scr}`,
      `Device: ${ua}`,
    ].join("\n");
  };
  const composeBody = () => `${msg.trim() || "(describe what happened or what you'd like)"}\n\n— — —\nDiagnostics (helps us reproduce):\n${diagnostics()}`;
  const sendEmail = () => {
    if (!msg.trim()) { onToast?.("✍️ Write a short message first"); return; }
    const subject = `Green Utility Log — ${kind} feedback (v${APP_VERSION})`;
    const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(composeBody())}`;
    try { window.location.href = url; onToast?.("✉️ Opening your mail app…"); }
    catch { onToast?.("❌ Couldn't open mail — use Copy instead"); }
  };
  const copyAll = async () => {
    const text = `Green Utility Log — ${kind} feedback\n\n${composeBody()}`;
    try { await navigator.clipboard.writeText(text); onToast?.("📋 Copied — paste it anywhere"); }
    catch { onToast?.("❌ Copy failed on this device"); }
  };
  const inputStyle = { width:"100%", boxSizing:"border-box", background:T.card, border:`1px solid ${T.border}`, borderRadius:6, padding:"12px", fontSize:13, color:T.text, fontFamily:"inherit", lineHeight:1.5, resize:"vertical" };
  return (
    <div style={{position:"fixed",inset:0,background:T.bg,zIndex:335,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>✉️ Send Feedback</div>
          <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>Help us improve the test</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"6px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Close</button>
      </div>

      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"16px 14px 28px"}}>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {kinds.map(k => (
            <button key={k.id} onClick={()=>setKind(k.id)} style={{flex:1,padding:"10px 6px",borderRadius:6,fontSize:12,fontWeight:700,cursor:"pointer",border:`1px solid ${kind===k.id?(T.green4||T.green3):T.border}`,background:kind===k.id?(T.green5||T.bgAlt):T.card,color:kind===k.id?T.green3:T.textMid}}>{k.label}</button>
          ))}
        </div>
        <textarea
          value={msg}
          onChange={(e)=>setMsg(e.target.value)}
          rows={6}
          placeholder={kind==="bug" ? "What went wrong? What did you expect to happen?" : kind==="idea" ? "What would make this better?" : "Tell us anything…"}
          style={inputStyle}
        />
        <div style={{fontSize:10.5,color:T.textSoft,lineHeight:1.55,margin:"10px 2px 16px"}}>
          We attach a little diagnostic info (app version, network, screen, device) so we can reproduce issues. No reading photos or private keys are ever included.
        </div>
        <button onClick={sendEmail} style={{width:"100%",background:T.green3,border:"none",borderRadius:6,padding:"13px",color:"#fff",fontSize:12,fontWeight:800,textTransform:"uppercase",letterSpacing:"1px",cursor:"pointer",marginBottom:8}}>✉️ Send via email</button>
        <button onClick={copyAll} style={{width:"100%",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"12px",color:T.textMid,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",cursor:"pointer"}}>📋 Copy instead</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════════════════

// Theme follows the device by default; an explicit toggle is remembered and
// from then on overrides the system preference.
const THEME_KEY = "greenlog_theme";
// Remembers which wallet the on-screen data belongs to, so a different wallet
// starts from a clean slate.
const WALLET_KEY = "greenlog_wallet";
function systemPrefersDark() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
  catch { return false; }
}
function getInitialDark() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark") return true;
    if (saved === "light") return false;
  } catch {}
  return systemPrefersDark();
}

export default function App() {
  // Check if user has seen intro before
  const [showIntro, setShowIntro] = useState(() => {
    const seen = localStorage.getItem('greenlog_seen_intro');
    return !seen; // Show intro if NOT seen before
  });
  const [onboarded, setOnboarded]   = useState(true);
  const [needsBaselines, setNeedsBaselines] = useState(false);
  const [regUtils, setRegUtils]     = useState(null);   // which meters the registration screen shows
  const [regEdit, setRegEdit]       = useState(false);  // edit mode (from Settings) vs first setup
  const [baselines, setBaselines]   = useState({ electric:"", gas:"", water:"", solar:"" });

  // Open the meter registration overlay for a given set of utilities.
  const openRegistration = (utils = null, edit = false) => { setRegUtils(utils); setRegEdit(edit); setNeedsBaselines(true); };
  const closeRegistration = () => { setNeedsBaselines(false); setRegUtils(null); setRegEdit(false); };
  const [meters, setMeters]         = useState({ electric:"", gas:"", water:"", solar:"" });
  const [dark, setDark]             = useState(getInitialDark);
  const T = dark ? DARK : LIGHT;
  const CSS = makeCSS(T);

  // Flip the theme and remember the choice (overrides the system preference).
  const toggleDark = () => setDark(prev => {
    const next = !prev;
    try { localStorage.setItem(THEME_KEY, next ? "dark" : "light"); } catch {}
    return next;
  });

  // Keep following the device theme until the user has made an explicit choice.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => {
      try { if (localStorage.getItem(THEME_KEY)) return; } catch {}
      setDark(e.matches);
    };
    mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener(onChange);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", onChange) : mq.removeListener(onChange); };
  }, []);

  useEffect(() => {
    const stored = loadBaselines();
    const storedMeters = loadMeters();
    // Registration is only complete once both the baselines and a meter number
    // for every utility exist; otherwise re-prompt the meter registration.
    const metersComplete = storedMeters && UTILS.filter(u => !u.optional).every(u => (storedMeters[u.id] || "").trim());
    if (!stored || !metersComplete) {
      setNeedsBaselines(true);
    }
    if (stored) setBaselines(stored);
    if (storedMeters) setMeters(storedMeters);
  }, []);

  const [tab, setTab]               = useState("home");
  // Wallet connection is handled by VeChain dapp-kit (VeWorld / WalletConnect
  // mobile). useWallet() exposes the connected address and the
  // requestTransaction() signer; useWalletModal() opens the connect dialog.
  const { account, requestTransaction, requestCertificate, disconnect } = useWallet();
  const wallet = account || null;

  // Pre-fill meter numbers an admin assigned to this wallet on the server, so a user
  // who can't find their meter number doesn't have to enter it. Only fills EMPTY slots
  // — never overwrites a number the user typed themselves.
  useEffect(() => {
    if (!wallet || !REWARD_API) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${REWARD_API.replace(/\/$/, "")}/meter/registered?address=${wallet}`);
        if (!r.ok) return;
        const d = await r.json().catch(() => ({}));
        const list = Array.isArray(d.meters) ? d.meters : [];
        if (cancelled || !list.length) return;
        setMeters(prev => {
          const next = { ...prev };
          let changed = false;
          for (const m of list) {
            const u = m.utility, no = String(m.meterNo || "").trim();
            if (u && no && !(next[u] || "").trim()) { next[u] = no; changed = true; }
          }
          if (changed) { try { saveMeters(next); } catch { /* no storage */ } }
          return changed ? next : prev;
        });
      } catch { /* offline — ignore */ }
    })();
    return () => { cancelled = true; };
  }, [wallet]);

  // Let the backend know this wallet is active, so the admin panel can see testers
  // who have connected (and maybe registered meters locally) but not yet earned
  // on-chain. Fire-and-forget; failure is harmless.
  useEffect(() => {
    if (!wallet || !REWARD_API) return;
    const list = Object.entries(meters || {}).filter(([, v]) => String(v || "").trim()).map(([k, v]) => `${k}:${v}`);
    fetch(`${REWARD_API.replace(/\/$/, "")}/wallet/seen`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet, meters: list }),
    }).catch(() => {});
  }, [wallet, meters]);
  const { open: openWalletModal } = useWalletModal();
  const openConnectModal = () => openWalletModal();

  // Wipe all local app data and the wallet connection, then reload — a clean
  // slate for testing. (On-chain reward history can't be erased; it re-hydrates
  // from the wallet's events on reconnect.)
  const resetApp = async () => {
    try {
      for (const k of Object.keys(localStorage)) {
        // Also drop the meter-ingest device token(s) — a bearer credential that must
        // not linger on a shared/kiosk browser after disconnect.
        if (k.startsWith("greenlog_") || k.startsWith("gul_mtoken_")) localStorage.removeItem(k);
      }
    } catch {}
    try { indexedDB.deleteDatabase("GreenUtilityLog"); } catch {}
    try { await disconnect?.(); } catch {}
    setTimeout(() => { try { location.reload(); } catch {} }, 150);
  };
  const [selUtil, setSelUtil]       = useState("electric");
  const [aiOk, setAiOk]            = useState(false);
  const [reading, setReading]       = useState("");
  const [prevRead, setPrevRead]     = useState("");
  // True once the user types in the "previous reading" field themselves — the
  // autofill below must never clobber a value the user entered by hand.
  const prevReadEdited = useRef(false);
  const setPrevReadByUser = (v) => { prevReadEdited.current = true; setPrevRead(v); };
  const [busy, setBusy]             = useState(false);
  const [toast, setToast]           = useState(null);
  const [b3tr, setB3tr]             = useState(0);     // real balance loads from chain/local on connect
  const [subs, setSubs]             = useState([]);    // no demo data — start empty until hydrated
  const streak = computeStreak(subs); // derived from real submission dates
  const [verifyKey, setVerifyKey]   = useState(0);
  const [captchaToken, setCaptchaToken] = useState(""); // Cloudflare Turnstile token (when enabled)
  const turnstileId = useRef(null);
  const [notifs, setNotifs]         = useState({ daily:true, streak:true, rewards:false, lb:false });
  const [showAdmin, setShowAdmin]   = useState(false);
  const [showHelp, setShowHelp]       = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [onChainAdmin, setOnChainAdmin] = useState(false); // app admin/moderator per the X2EarnApps contract
  const [photo, setPhoto]           = useState(null); // verified meter photo for backend submission

  // The seed history/rewards are only a preview for the disconnected gate — they
  // never belong to a real account. Whenever a wallet connects, start it at zero;
  // a wallet we haven't seen on this browser also gets its baselines re-prompted.
  const sessionWalletRef = useRef(undefined);
  const subsHydratedRef = useRef(undefined);
  useEffect(() => {
    if (!account) return;
    const addr = account.toLowerCase();
    if (sessionWalletRef.current === addr) return;
    sessionWalletRef.current = addr;

    let storedWallet = null;
    try { storedWallet = localStorage.getItem(WALLET_KEY); } catch {}

    // Show this wallet's locally-saved submissions immediately so nothing "resets"
    // on reload; the on-chain history is merged in below when it arrives.
    const local = loadSubs(addr);
    subsHydratedRef.current = addr;
    setSubs(local);
    setB3tr(local.reduce((a, s) => a + (parseFloat(s.b3tr) || 0), 0));
    setReading(""); setPrevRead(""); prevReadEdited.current = false; setAiOk(false); setPhoto(null);
    setVerifyKey(k => k + 1);
    setTab("home");

    if (storedWallet && storedWallet !== addr) {
      // Genuinely switching to a DIFFERENT wallet on this browser: reset the
      // account setup — a new wallet must not inherit the previous one's meters
      // or baselines (the latter being the real anti-fraud guard).
      setBaselines({ electric:"", gas:"", water:"", solar:"" });
      setMeters({ electric:"", gas:"", water:"", solar:"" });
      setRegUtils(null); setRegEdit(false);   // first-setup mode: required meters only
      setNeedsBaselines(true);
      try {
        localStorage.removeItem('greenlog_baselines');
        localStorage.removeItem('greenlog_meters');
      } catch {}
    }
    // Record the wallet for this browser. Reconnecting the SAME wallet — or a
    // fresh / cache-cleared browser — keeps whatever meters & baselines are
    // stored, so nothing gets wiped "every time"; only a real switch resets.
    try { localStorage.setItem(WALLET_KEY, addr); } catch {}

    // Restore this wallet's earnings and history straight from chain so the
    // dashboard reflects real on-chain data across devices and reloads. Falls
    // back silently to an empty slate when the app isn't registered yet or the
    // node is unreachable.
    let cancelled = false;
    fetchWalletHistory({
      node: ACTIVE_NODE,
      contract: CONTRACTS.X2EarnRewardsPool,
      appId: VEBETTER_APP_ID,
      address: addr,
    })
      .then(res => {
        if (cancelled || sessionWalletRef.current !== addr) return;
        if (res.ok && res.rows.length) {
          const merged = mergeSubs(local, res.rows);
          setSubs(merged);
          setB3tr(merged.reduce((a, s) => a + (parseFloat(s.b3tr) || 0), 0));
          saveSubs(addr, merged);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [account]);

  // Persist this wallet's submissions on every change, so recorded (not-yet-paid)
  // submissions survive a reload instead of resetting to an empty/seed state.
  useEffect(() => {
    const addr = account?.toLowerCase();
    if (addr && subsHydratedRef.current === addr) saveSubs(addr, subs);
  }, [subs, account]);

  // Auto-detect admin access from the VeBetterDAO X2EarnApps contract (the app
  // admin / moderators), on top of the hardcoded ADMIN_WALLETS allowlist.
  useEffect(() => {
    if (!account) { setOnChainAdmin(false); return; }
    let cancelled = false;
    const ctrl = new AbortController();
    fetchIsAppAdmin({ node: ACTIVE_NODE, appsContract: CONTRACTS.X2EarnApps, appId: VEBETTER_APP_ID, address: account, signal: ctrl.signal })
      .then(ok => { if (!cancelled) setOnChainAdmin(!!ok); })
      .catch(() => {});
    return () => { cancelled = true; ctrl.abort(); };
  }, [account]);

  const isAdmin = isAdminWallet(wallet) || onChainAdmin;
  const u = getUtil(selUtil);
  const online = useOnlineStatus();

  // Success/info toasts auto-hide; ERROR toasts stick until dismissed and can be
  // copied — a revert reason you can't read or screenshot is useless.
  const toastTimer = useRef(null);
  const showToast = (msg) => {
    const text = String(msg ?? "");
    const isError = /^[❌⚠️✋🤖📸]|revert|failed|error/iu.test(text);
    clearTimeout(toastTimer.current);
    setToast({ msg: text, sticky: isError });
    if (!isError) toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  // When connectivity returns (and a wallet is connected), submit any readings that
  // were queued while offline THROUGH THE REWARD BACKEND — the same path as an online
  // submission (the server verifies the stored photo and issues the payout). We sign a
  // fresh gasless certificate per item; we never self-sign distributeReward (that
  // reverts for a normal wallet). Items stored before this change (no photo) are
  // skipped — they can't be verified server-side.
  const syncingRef = useRef(false);
  useEffect(() => {
    if (!online || !wallet || !REWARD_API) return;
    let cancelled = false;
    (async () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        const pending = await getUnsyncedSubmissions();
        let synced = 0;
        for (const item of pending) {
          if (cancelled) break;
          if (!item.photo) continue; // legacy/photoless item — can't be paid, leave queued
          // Claim the item first; if we crash mid-flight it stays flagged and won't be
          // re-sent (no double payout).
          await markBroadcasting(item.id, true);
          try {
            const content = `Green Utility Log — confirm submission\nWallet: ${wallet}\nUtility: ${item.type}\nReading: ${item.cur}\nTime: ${new Date().toISOString()}`;
            const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
            const certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
            const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/reward`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ utility: item.type, reading: item.cur, prevRead: item.prev, meterNo: item.meterNo, address: wallet, photo: item.photo, photoMime: item.photoMime || "", certificate, clientFlagged: !!item.flagged, flagReason: item.flagReason || "", ocrNums: item.ocrNums || [], meterNoConfirmed: item.meterNoConfirmed ?? null, avgUsage: item.avgUsage ?? null, captchaToken: "" }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `reward ${res.status}`);
            const paid = (data.amount != null && Number.isFinite(Number(data.amount))) ? Number(data.amount) : item.b3tr;
            await markSynced(item.id, data.txid);
            if (cancelled) break;
            setSubs(prev => [{
              id: item.id, type: item.type, meterNo: item.meterNo || "",
              cur: item.cur, prev: item.prev, date: dayKey(new Date(item.id)),
              b3tr: paid, status: item.flagged ? "review" : "confirmed", txHash: data.txid || "", submittedAt: item.id,
            }, ...prev]);
            setB3tr(b => b + (parseFloat(paid) || 0));
            synced++;
          } catch {
            // Failed (rejected cert / server error) — release it for a later retry.
            await markBroadcasting(item.id, false);
          }
        }
        if (synced && !cancelled) showToast(`🔄 Synced ${synced} offline submission${synced > 1 ? "s" : ""} to ${NETWORK_LABEL}`);
      } finally {
        syncingRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [online, wallet]);

  // The best-known "previous reading" for a meter: the most recent submission's
  // reading, falling back to the registered baseline. This is what next time's
  // usage is measured from.
  const lastReadingFor = (id) => {
    const lastSub = subs.find(s => s.type === id);
    return lastSub ? String(lastSub.cur) : (baselines[id] ? String(baselines[id]) : "");
  };

  const handleSelUtil = (id) => {
    if (id === selUtil) return; // re-tapping the active meter shouldn't clear input
    setSelUtil(id);
    setAiOk(false);
    setPhoto(null);
    setReading("");
    prevReadEdited.current = false;       // switching meters → autofill may take over again
    setPrevRead(lastReadingFor(id));
    setVerifyKey(k => k+1);
  };

  // Auto-fill the "previous reading" from your last submission (or the registered
  // baseline) so you never have to type it. Unlike before, this UPGRADES a stale
  // value (e.g. the old baseline) to your latest reading once history loads — but
  // it never overwrites a value you typed yourself (prevReadEdited guards that).
  useEffect(() => {
    if (prevReadEdited.current) return;          // user is in control of this field
    const v = lastReadingFor(selUtil);
    if (v && v !== prevRead) setPrevRead(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selUtil, subs, baselines]);

  // Cloudflare Turnstile (anti-bot): render the widget on the Submit tab when a
  // site key is set; its token rides along with each /reward submission.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || tab !== "submit") return;
    let stop = false;
    const render = () => {
      if (stop || !window.turnstile) return;
      const el = document.getElementById("cf-turnstile");
      if (!el || el.dataset.rendered) return;
      el.dataset.rendered = "1";
      turnstileId.current = window.turnstile.render("#cf-turnstile", {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (t) => setCaptchaToken(t),
        "expired-callback": () => setCaptchaToken(""),
        "error-callback": () => setCaptchaToken(""),
      });
    };
    if (window.turnstile) { render(); return () => { stop = true; }; }
    if (!document.getElementById("cf-turnstile-script")) {
      const s = document.createElement("script");
      s.id = "cf-turnstile-script";
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      s.async = true; s.defer = true; s.onload = render;
      document.head.appendChild(s);
    }
    const iv = setInterval(() => { if (window.turnstile) { clearInterval(iv); render(); } }, 200);
    return () => { stop = true; clearInterval(iv); };
  }, [tab]);

  // Admin: deposit B3TR from the connected wallet into the app's rewards pool.
  const handleFundPool = async (amount) => {
    const amt = parseFloat(amount);
    if (!(amt > 0)) { showToast("⚠️ Enter a B3TR amount"); return; }
    if (!wallet) { openConnectModal(); return; }
    try {
      const { txid } = await requestTransaction(buildFundClauses(amt));
      showToast(`✅ Funding ${amt} B3TR — confirm in wallet (tx ${String(txid).slice(0, 8)}…)`);
      return txid;
    } catch (e) {
      showToast(`⚠️ ${e?.message || "Funding failed"}`);
    }
  };

  // Decode a solidity Error(string) revert payload.
  const decodeRevertHex = (data) => {
    const hex = String(data || "").replace(/^0x/, "");
    if (!hex.startsWith("08c379a0")) return "";
    try {
      const len = parseInt(hex.slice(8 + 64, 8 + 128), 16);
      const b = new Uint8Array(len); const s = hex.slice(8 + 128, 8 + 128 + len * 2);
      for (let i = 0; i < len; i++) b[i] = parseInt(s.substr(i * 2, 2), 16);
      return new TextDecoder().decode(b);
    } catch { return ""; }
  };

  // Dry-run a clause as `caller` — free, instant, names the blocker.
  const simulateAsCaller = async (clause, caller) => {
    const res = await fetch(`${ACTIVE_NODE}/accounts/*`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clauses: [{ to: clause.to, value: "0x0", data: clause.data }], caller }),
    });
    const [out] = await res.json();
    return { reverted: !!out?.reverted, reason: out?.reverted ? (decodeRevertHex(out.data) || out.vmError || "execution reverted") : "" };
  };

  // Run an admin transaction HONESTLY: simulate first (so a doomed call shows
  // the contract's own revert reason BEFORE signing), then broadcast and wait
  // for the receipt — success is only reported when the tx actually landed.
  const runAdminTx = async ({ fn, args, label }) => {
    if (!wallet) { openConnectModal(); return; }
    const clause = Clause.callFunction(Address.of(CONTRACTS.X2EarnRewardsPool), new ABIFunction(fn), args);
    try {
      const sim = await simulateAsCaller(clause, wallet);
      if (sim.reverted) { showToast(`❌ ${label} would revert: ${sim.reason}`); return; }
    } catch { /* simulation unavailable — proceed and rely on the receipt */ }
    // 2. Sign + broadcast, then wait for the on-chain receipt.
    let txid;
    try {
      ({ txid } = await requestTransaction([{ to: clause.to, value: "0x0", data: clause.data, comment: label }]));
    } catch (e) { showToast(`⚠️ ${e?.message || `${label} was not signed`}`); return; }
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const r = await fetch(`${ACTIVE_NODE}/transactions/${txid}/receipt`);
        if (r.ok) {
          const receipt = await r.json();
          if (receipt) {
            if (receipt.reverted) showToast(`❌ ${label} REVERTED on-chain (tx ${String(txid).slice(0, 10)}…) — see ${EXPLORER}/transactions/${txid}`);
            else showToast(`✅ ${label} confirmed on-chain!`);
            return txid;
          }
        }
      } catch {}
    }
    showToast(`⚠️ ${label}: still pending — check ${EXPLORER}/transactions/${txid}`);
    return txid;
  };

  // Ask the BACKEND to do the move with the distributor key — used when the
  // user's wallet lacks the on-chain app-admin role but the distributor has it.
  const serverMoveRewardsPool = async (amt) => {
    try {
      // Bind the signature to this exact action+params (server re-derives + checks).
      const canonical = `/admin/move-rewards-pool|${JSON.stringify({ amount: amt }, ["amount"])}`;
      const content = `Green Utility Log — admin action\n${canonical}\nWallet: ${wallet}\nTime: ${new Date().toISOString()}`;
      const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
      const certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/admin/move-rewards-pool`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, amount: amt, certificate }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `server ${res.status}`);
      showToast(`✅ Moved ${amt} B3TR to the rewards pool via the server — confirmed on-chain! Re-run the System Check.`);
      return data.txid;
    } catch (e) {
      showToast(`❌ Server-side move failed: ${e?.message || "unknown"}. The on-chain app admin (see System Check) must do this — connect with that wallet, or use the VeBetterDAO dashboard.`);
    }
  };

  // Generic signed admin call — cert-proves the admin wallet, then POSTs to an
  // /admin/* endpoint. Used by the account tools (ban, fix baseline, lookup…).
  const adminApi = async (path, body) => {
    if (!wallet) { openConnectModal(); throw new Error("connect your wallet"); }
    const b = body || {};
    // Bind the signature to THIS action + its exact parameters (server re-derives the
    // same string and rejects a cert that doesn't authorise it, or that's re-used).
    const canonical = `${path}|${JSON.stringify(b, Object.keys(b).sort())}`;
    const content = `Green Utility Log — admin action\n${canonical}\nWallet: ${wallet}\nTime: ${new Date().toISOString()}`;
    const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
    const certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
    const res = await fetch(`${REWARD_API.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet, certificate, ...b }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `server ${res.status}`);
    return data;
  };

  // Admin: move deposited B3TR from `availableFunds` into `rewardsPoolBalance` —
  // on v10 pools with the rewards-pool feature ON, distributeReward pays ONLY
  // from that second bucket ("not enough funds in the rewards pool" otherwise).
  // Tries the connected wallet first; if the contract says it isn't the app
  // admin, automatically falls back to the server (distributor) route.
  const handleMoveToRewardsPool = async (amount) => {
    const amt = parseFloat(amount);
    if (!(amt > 0)) { showToast("⚠️ Enter a B3TR amount"); return; }
    if (!wallet) { openConnectModal(); return; }
    const wei = BigInt(Math.round(amt * 1e6)) * 10n ** 12n; // 6-decimal-safe -> wei
    const fn = { name: "increaseRewardsPoolBalance", type: "function", stateMutability: "nonpayable", inputs: [{ name: "appId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] };
    const args = [VEBETTER_APP_ID, wei.toString()];
    try {
      const clause = Clause.callFunction(Address.of(CONTRACTS.X2EarnRewardsPool), new ABIFunction(fn), args);
      const sim = await simulateAsCaller(clause, wallet);
      if (sim.reverted && /app admin/i.test(sim.reason)) {
        showToast("↪️ Your wallet isn't the on-chain app admin — trying via the server instead…");
        return serverMoveRewardsPool(amt);
      }
      if (sim.reverted) { showToast(`❌ Move would revert: ${sim.reason}`); return; }
    } catch { /* simulation unavailable — fall through to the honest signed path */ }
    return runAdminTx({ fn, args, label: `Move ${amt} B3TR to rewards pool` });
  };

  // Admin fallback: turn the rewards-pool feature OFF for this app, so payouts
  // draw straight from availableFunds (where the deposit already sits) and the
  // bucket-moving dance disappears entirely.
  const handleDisableRewardsPool = async () => {
    return runAdminTx({
      fn: { name: "toggleRewardsPoolBalance", type: "function", stateMutability: "nonpayable", inputs: [{ name: "appId", type: "bytes32" }, { name: "enable", type: "bool" }], outputs: [] },
      args: [VEBETTER_APP_ID, false],
      label: "Disable rewards-pool feature",
    });
  };

  // Admin: claim test-B3TR from the testnet faucet to the connected wallet, so the
  // pool can be funded even when the wallet starts with no B3TR. Testnet only.
  const handleClaimB3TR = async () => {
    if (!wallet) { openConnectModal(); return; }
    try {
      const { txid } = await requestTransaction(buildClaimClause());
      showToast(`✅ Claiming test-B3TR — confirm in wallet (tx ${String(txid).slice(0, 8)}…)`);
      return txid;
    } catch (e) {
      showToast(`⚠️ ${e?.message || "Claim failed — check the faucet address"}`);
    }
  };

  // A reading is submittable when it's a number that's EQUAL TO or higher than
  // the previous one. Equal means zero consumption — the ultimate conservation —
  // so it's valid and earns the maximum reward. Only a LOWER reading is rejected
  // (a real meter never runs backwards).
  const readingReady = () => { const r=parseFloat(reading),p=parseFloat(prevRead); return Number.isFinite(r)&&Number.isFinite(p)&&r>=p; };
  const usage = () => { const r=parseFloat(reading),p=parseFloat(prevRead); return readingReady()?parseFloat((r-p).toFixed(2)):0; };
  // Conservation reward: you earn for using LESS than the benchmark, not more.
  const reward = () => (readingReady() ? computeReward(selUtil, usage()) : 0);

  // ── Eco-mode bonus ──────────────────────────────────────────────────────────
  // Photo of an appliance running in eco mode → fixed bonus via the backend.
  // Rules (server-enforced; these local values only drive the UI): max 4 per
  // CALENDAR week (Monday–Sunday, resets Monday morning) + 24h between claims.
  const [ecoBusy, setEcoBusy] = useState(false);
  const ecoWeekStart = (() => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
  const ecoSubTs = (s) => s.submittedAt || localDayTs(s.date) || 0;
  const ecoSubs = subs.filter(s => s.type === "eco");
  const ecoUsedThisWeek = ecoSubs.filter(s => ecoSubTs(s) >= ecoWeekStart).length;
  const ecoLastTs = ecoSubs.reduce((a, s) => Math.max(a, ecoSubTs(s)), 0);
  const ecoCooldownMs = Math.max(0, 24*60*60*1000 - (Date.now() - ecoLastTs));
  const handleEcoSubmit = async (file, appliance) => {
    if (!wallet) { openConnectModal(); return; }
    if (!online) { showToast("🌿 Eco bonus needs a connection — try again when online"); return; }
    if (!REWARD_API) { showToast("Eco bonus isn't available yet"); return; }
    if (TURNSTILE_SITE_KEY && !captchaToken) { showToast("🤖 Complete the verification checkbox first"); return; }
    if (photoTooOld(file)) { showToast("📸 Take the photo live with your camera — saved images aren't accepted"); return; }
    setEcoBusy(true);
    try {
      const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(file); });
      let certificate = null;
      try {
        const content = `Green Utility Log — confirm eco-mode bonus\nWallet: ${wallet}\nAppliance: ${appliance}\nTime: ${new Date().toISOString()}`;
        const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
        certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      } catch {
        showToast("✋ Sign the confirmation in your wallet to claim the eco bonus");
        return;
      }
      const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/eco-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, appliance, photo: base64, photoMime: file.type || "", certificate, captchaToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `eco service error ${res.status}`);
      const paid = Number(data.amount) || 0;
      setSubs(prev => [{ id: Date.now(), type: "eco", appliance, cur: "", prev: "", meterNo: "", date: dayKey(new Date()), b3tr: paid, status: "confirmed", txHash: data.txid || "", submittedAt: Date.now() }, ...prev]);
      setB3tr(b => b + paid);
      showToast(`🌿 Eco bonus: +${paid} B3TR!`);
    } catch (e) {
      showToast(`❌ Eco bonus failed: ${e?.message || "try again later"}`);
    } finally {
      setEcoBusy(false);
    }
  };

  // ── Photoless automatic submission (Step 2) ─────────────────────────────────
  // Submit the latest automatically-received meter reading — no photo. The backend
  // pays out only if the meter already has a baseline (set by a prior photo
  // submission) and the reading is fresh; all the normal reward rules still apply.
  const [meterAutoBusy, setMeterAutoBusy] = useState(false);
  const handleMeterAutoSubmit = async () => {
    if (!wallet) { openConnectModal(); return; }
    if (!online) { showToast("⚡ Automatic submit needs a connection — try again when online"); return; }
    if (!REWARD_API) { showToast("Automatic submit isn't available yet"); return; }
    const meterNo = (meters["electric"] || "").trim();
    if (!meterNo) { showToast("⚠️ Register your electricity meter number first"); return; }
    if (TURNSTILE_SITE_KEY && !captchaToken) { showToast("🤖 Complete the verification checkbox first"); return; }
    setMeterAutoBusy(true);
    try {
      let certificate;
      try {
        const content = `Green Utility Log — confirm automatic meter submission\nWallet: ${wallet}\nMeter: ${meterNo}\nTime: ${new Date().toISOString()}`;
        const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
        certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      } catch {
        setMeterAutoBusy(false);
        showToast("✋ Sign the confirmation in your wallet to submit");
        return;
      }
      const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/reward-from-meter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, utility: "electric", meterNo, certificate, captchaToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `service error ${res.status}`);
      const paid = Number(data.amount) || 0;
      setSubs(prev => [{ id: Date.now(), type: "electric", meterNo, cur: data.reading != null ? String(data.reading) : "", prev: "", date: dayKey(new Date()), b3tr: paid, status: "confirmed", txHash: data.txid || "", submittedAt: Date.now() }, ...prev]);
      setB3tr(b => b + paid);
      showToast(`⚡ Automatic reading: +${paid} B3TR!`);
    } catch (e) {
      showToast(`❌ Automatic submit failed: ${e?.message || "try again later"}`);
    } finally {
      setMeterAutoBusy(false);
    }
  };

  const handleSubmit = async () => {
    setBusy(true);
    const earned = reward();
    const meterNo = (meters[selUtil] || "").trim();

    // A reading without its registered meter can't be verified — block it.
    if (!meterNo) {
      setBusy(false);
      showToast("⚠️ Register this meter's number before submitting");
      return;
    }

    // Block only blank or LOWER readings — equal (zero usage) is valid and earns
    // the max reward, so reward() returns > 0 for it.
    if (!(earned > 0)) {
      setBusy(false);
      const p = parseFloat(prevRead), r = parseFloat(reading);
      showToast(Number.isFinite(r) && Number.isFinite(p) && r < p
        ? "⚠️ The current reading can't be lower than the previous one"
        : "⚠️ Enter the current meter reading");
      return;
    }

    // Anti-bot captcha must be solved first (only when a site key is configured).
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setBusy(false);
      showToast("🤖 Complete the captcha to submit");
      return;
    }

    // Enforce the per-meter cooldown on the submission itself, not just the
    // camera UI (which is bypassable).
    const cdRem = getCooldownRemaining(selUtil);
    if (cdRem > 0) {
      setBusy(false);
      showToast(`⏳ ${getUtil(selUtil).label} on cooldown — ${fmtCooldown(cdRem)} left`);
      return;
    }

    // ── Hybrid verification, on the FINAL numbers (not the photo-time ones) ──────
    // Block obvious fraud outright; flag the rest for review. This binds the reward
    // to the verified photo, so a reading edited after the green "verified" badge
    // can no longer pass unchecked.
    const usageVal = usage();
    const plaus = checkPlausibility(selUtil, usageVal);
    if (!plaus.ok) {
      setBusy(false);
      showToast(`⚠️ ${plaus.reason || "That reading looks implausible"}`);
      return;
    }
    const anom = checkAnomaly(selUtil, usageVal, subs);
    if (anom.anomaly) {
      setBusy(false);
      showToast(`⚠️ ${anom.reason || "Usage far above your average"} — retake or correct`);
      return;
    }
    // Not auto-blocked, but recorded for review when the photo can't back it up:
    // either the reading isn't visible on the photo, or the registered meter number
    // couldn't be confirmed on it (lenient — a miss flags, it never blocks).
    const readingConfirmed = !photo?.ocrFailed && readingMatchesPhoto(reading, photo?.ocrNums);
    const meterUnconfirmed = photo?.meterNoConfirmed === false;
    const photoConfirmed = readingConfirmed && !meterUnconfirmed;
    const flagReason = !readingConfirmed
      ? (photo?.ocrFailed ? "photo_unreadable" : "reading_not_in_photo")
      : (meterUnconfirmed ? "meter_not_confirmed" : "");

    if (!online) {
      // Store the photo + OCR metadata too, so on reconnect we can submit through
      // the reward backend exactly like an online submission (the backend needs the
      // photo and issues the payout). Without this, an offline item could never be
      // paid. captchaToken can't be captured offline — fine while captcha is off.
      await saveOfflineSubmission({
        type:selUtil, meterNo, cur:reading, prev:prevRead, b3tr:earned,
        flagged: !photoConfirmed, flagReason,
        photo: photo?.base64 || "", photoMime: photo?.mime || "",
        ocrNums: photo?.ocrNums || [], meterNoConfirmed: photo?.meterNoConfirmed ?? null,
        avgUsage: anom.avg ?? null,
      });
      setAiOk(false); setPhoto(null); setReading(""); setPrevRead(""); prevReadEdited.current = false; setVerifyKey(k=>k+1);
      setBusy(false);
      showToast("💾 Saved offline — will submit when you're back online");
      return;
    }

    if (!wallet) {
      setBusy(false);
      openConnectModal();
      return;
    }

    // No payout path for a normal tester: without a reward backend the only option
    // is the wallet signing distributeReward itself, which reverts unless it holds
    // the distributor role. Rather than broadcast a doomed transaction, record the
    // verified submission locally (no B3TR) so the flow still completes cleanly.
    if (!REWARD_API && !isAdmin) {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      setSubs(prev => [{
        id: Date.now(), type: selUtil, meterNo, cur: reading, prev: prevRead, date: dateStr,
        b3tr: 0, status: "recorded", flagged: !photoConfirmed, flagReason, txHash: "", submittedAt: Date.now(),
      }, ...prev]);
      setCooldown(selUtil);
      setAiOk(false); setPhoto(null); setReading(""); setPrevRead(""); prevReadEdited.current = false; setVerifyKey(k => k + 1);
      if (window.turnstile && turnstileId.current) { try { window.turnstile.reset(turnstileId.current); } catch {} }
      setCaptchaToken("");
      setBusy(false);
      showToast("ℹ️ Submission recorded — rewards aren't live yet (reward backend not connected).");
      return;
    }

    try {
      // Two payout paths:
      //  • REWARD_API set → a server-side reward-distributor verifies and issues
      //    the B3TR (the production model; the user signs nothing).
      //  • otherwise (admin only) → the connected wallet signs distributeReward
      //    directly; only works if that wallet holds the distributor role.
      let txid;
      // The server recomputes the payout from its own recorded baseline, so the
      // amount actually paid on-chain can differ from the client's `earned`. Show
      // and store the server's number when it returns one; fall back to `earned`.
      let paidAmount = earned;
      if (REWARD_API) {
        // Prove wallet ownership: the user signs a gasless certificate, so the
        // backend can verify the submission really comes from `wallet` and won't
        // issue B3TR to an address someone just typed into the request.
        let certificate;
        try {
          const content = `Green Utility Log — confirm submission\nWallet: ${wallet}\nUtility: ${selUtil}\nReading: ${reading}\nTime: ${new Date().toISOString()}`;
          const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } });
          certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
        } catch {
          setBusy(false);
          showToast("✋ Sign the confirmation in your wallet to submit");
          return;
        }
        const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/reward`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ utility: selUtil, reading, prevRead, meterNo, address: wallet, photo: photo?.base64 || "", photoMime: photo?.mime || "", certificate, clientFlagged: !photoConfirmed, flagReason, ocrNums: photo?.ocrNums || [], meterNoConfirmed: photo?.meterNoConfirmed ?? null, avgUsage: anom.avg ?? null, captchaToken }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Reward service error ${res.status}`);
        txid = data.txid;
        if (data.amount != null && Number.isFinite(Number(data.amount))) paidAmount = Number(data.amount);
      } else {
        const clauses = buildRewardClauses(selUtil, reading, prevRead, earned, wallet, meterNo);
        ({ txid } = await requestTransaction(clauses));
      }

      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      setSubs(prev => [{
        id: Date.now(),
        type: selUtil,
        meterNo,
        cur: reading,
        prev: prevRead,
        date: dateStr,
        b3tr: paidAmount,
        status: photoConfirmed ? "confirmed" : "review",
        flagged: !photoConfirmed,
        flagReason,
        txHash: txid || "",
        submittedAt: Date.now()
      }, ...prev]);

      setB3tr(b => b + paidAmount);
      setCooldown(selUtil);
      setAiOk(false);
      setPhoto(null);
      setReading("");
      setPrevRead("");
      prevReadEdited.current = false;
      setVerifyKey(k => k + 1);
      showToast(photoConfirmed
        ? `✅ +${paidAmount.toFixed(2)} B3TR on ${NETWORK_LABEL}${txid ? ` • TX: ${txid.slice(0, 10)}...` : ""}`
        : `⚠️ Submitted — couldn't confirm the reading from the photo, flagged for review`);
      setBusy(false);
    } catch (e) {
      setBusy(false);
      showToast(`❌ Submission failed: ${e?.message || "Transaction cancelled"}`);
    }
  };

  return (
    <>
      <style>{CSS}</style>
      {showIntro && <IntroScreen onStart={() => { setShowIntro(false); localStorage.setItem('greenlog_seen_intro', 'true'); }} />}
      {!showIntro && !wallet && <WalletGate onConnect={openConnectModal} online={online} />}
      {needsBaselines && <BaselineOnboarding onDone={(bl, mtrs) => { setBaselines(bl); setMeters(mtrs); closeRegistration(); }} utils={regUtils} editMode={regEdit} existingBaselines={baselines} existingMeters={meters} T={T} />}
      {!onboarded && <Onboarding onDone={() => setOnboarded(true)} />}
      {showAdmin && isAdmin && <AdminScreen onClose={() => setShowAdmin(false)} T={T} wallet={wallet} onFundPool={handleFundPool} onMoveToRewardsPool={handleMoveToRewardsPool} onDisableRewardsPool={handleDisableRewardsPool} onClaimB3TR={FAUCET_ENABLED ? handleClaimB3TR : null} onAdminApi={adminApi} onToast={showToast} />}
      {showHelp && <HelpScreen onClose={() => setShowHelp(false)} onFeedback={() => { setShowHelp(false); setShowFeedback(true); }} T={T} />}
      {showFeedback && <FeedbackScreen onClose={() => setShowFeedback(false)} onToast={showToast} wallet={wallet} tab={tab} T={T} />}
      {toast && (toast.sticky ? (
        <div className="toast" style={{whiteSpace:"pre-wrap",maxWidth:"88vw",textAlign:"left",lineHeight:1.5,background:T.gasBg,color:T.gas,border:`1px solid ${T.gasBorder}`,padding:"12px 14px"}}>
          <div style={{wordBreak:"break-word"}}>{toast.msg}</div>
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button onClick={() => { try { navigator.clipboard?.writeText(toast.msg); } catch {} }}
              style={{flex:1,background:T.gas,color:T.bg,border:0,borderRadius:5,padding:"8px 10px",fontSize:11,fontWeight:800,cursor:"pointer"}}>📋 Copy error</button>
            <button onClick={() => setToast(null)}
              style={{background:"transparent",color:T.gas,border:`1px solid ${T.gasBorder}`,borderRadius:5,padding:"8px 12px",fontSize:11,fontWeight:800,cursor:"pointer"}}>✕ Close</button>
          </div>
        </div>
      ) : (
        <div className="toast">{toast.msg}</div>
      ))}

      <div className="app">
        <div className="z1 scr">
          <div className="hdr">
            <div className="logo">
              <div className="logo-mark"><SproutIcon size={18} /></div>
              <div>
                <div className="logo-name">Green Utility Log</div>
              </div>
            </div>
            <div className="hdr-actions">
              <div title={online ? "Online" : "Offline"} aria-label={online ? "Online" : "Offline"} style={{display:"flex",alignItems:"center",justifyContent:"center",width:30,height:30,borderRadius:3,border:`1px solid ${online?T.green4:T.gasBorder}`,background:online?T.green5:T.gasBg,flexShrink:0}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:online?T.green3:T.gas,animation:online?"pulse 2.5s infinite":"none"}}/>
              </div>
              <button className="dark-toggle" onClick={() => setShowHelp(true)} aria-label="Help and FAQ" title="Help & FAQ">
                ❓
              </button>
              <button className="dark-toggle" onClick={toggleDark} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
                {dark ? '☀️' : '🌙'}
              </button>
              {/* Connect button — opens dapp-kit's wallet modal
                  (VeWorld, WalletConnect/mobile QR) via useWalletModal. */}
              <button
                className={`wallet-pill ${wallet ? "connected" : ""}`}
                onClick={openConnectModal}
                title={wallet || "Connect wallet"}
              >
                <span className={`wdot ${wallet ? "" : "off"}`} />
                <span className="waddr">
                  {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect"}
                </span>
              </button>
            </div>
          </div>

          {tab==="home"      && <HomeScreen b3tr={b3tr} streak={streak} subs={subs} setTab={setTab} T={T}/>}
          {tab==="submit"    && <SubmitScreen u={u} selUtil={selUtil} setSelUtil={handleSelUtil} aiOk={aiOk} setAiOk={setAiOk} setPhoto={setPhoto} reading={reading} setReading={setReading} prevRead={prevRead} setPrevRead={setPrevReadByUser} busy={busy} usage={usage} reward={reward} handleSubmit={handleSubmit} verifyKey={verifyKey} wallet={wallet} setShowWallet={openConnectModal} subs={subs} meters={meters} T={T} setTab={setTab} onEcoSubmit={handleEcoSubmit} ecoBusy={ecoBusy} ecoUsedThisWeek={ecoUsedThisWeek} ecoCooldownMs={ecoCooldownMs} onMeterAutoSubmit={handleMeterAutoSubmit} meterAutoBusy={meterAutoBusy} onRegisterMeter={(utils) => openRegistration(utils, true)}/>}
          {tab==="charts"    && <ChartsScreen subs={subs} T={T}/>}
          {tab==="leaderboard" && <LeaderboardScreen b3tr={b3tr} streak={streak} subs={subs} wallet={wallet} T={T}/>}
          {tab==="history"   && <HistoryScreen subs={subs} T={T}/>}
          {tab==="profile"   && <ProfileScreen b3tr={b3tr} subs={subs} wallet={wallet} setShowWallet={openConnectModal} dark={dark} setDark={toggleDark} notifs={notifs} setNotifs={setNotifs} setOnboarded={setOnboarded} onEditMeters={()=>openRegistration(REQUIRED_UTILS, true)} onEditSolar={()=>openRegistration(SOLAR_UTILS, true)} meters={meters} isAdmin={isAdmin} onOpenAdmin={()=>setShowAdmin(true)} onOpenHelp={()=>setShowHelp(true)} onOpenFeedback={()=>setShowFeedback(true)} onToast={showToast} onReset={resetApp} T={T}/>}
        </div>

        <div className="bnav">
          {[{id:"home",icon:"🏠",label:"Home"},{id:"submit",icon:"📸",label:"Submit"},{id:"charts",icon:"📊",label:"Charts"},{id:"leaderboard",icon:"🏆",label:"Rank"},{id:"profile",icon:"👤",label:"Profile"}].map(n=>(
            <button key={n.id} className={`nitem ${tab===n.id?"active":""}`} onClick={()=>setTab(n.id)}>
              <div className="nicon">{n.icon}</div>
              <div className="nlabel">{n.label}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
