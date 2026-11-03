import { useState, useRef, useEffect, Fragment, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { t, getLang, setLang, LANGS, weekdayInitials } from "./i18n.js";
import { NETWORK, REWARD_API, TESTNET_BANNER, MAIN_APP_URL, ownStorageKeys, IDB_NAME } from "./network.js";
import { useWallet, useWalletModal } from "@vechain/dapp-kit-react";
import { Clause, Address, ABIFunction } from "@vechain/sdk-core";
import { fetchOnChainLeaderboard, fetchWalletHistory, fetchIsAppAdmin, fetchTokenBalance, fetchGalaxyMember } from "./leaderboard.js";
// The admin screen is for the app's owner only, and ~1,000 lines: loaded when it
// is opened rather than for every visitor.
const AdminScreen = lazy(() => import("./admin.jsx"));
// Setting up an automatic reader (P1, Home Assistant, Tibber, Powerfox…) is a
// once-only path for some users: its ~850 lines load when that card is opened.
const SmartMeterCard = lazy(() => import("./reader.jsx"));

// ════════════════════════════════════════════════════════════════════════════
// APP VERSION & VECHAIN KIT
// ════════════════════════════════════════════════════════════════════════════
const APP_VERSION = "1.3.0";
const APP_NAME = "Green Utility Log";

// ── NETWORK SELECTION ──────────────────────────────────────────────────────
// Flip to "mainnet" for the production launch. Everything below (node URL +
// contract addresses) follows this one switch. Addresses are the official
// VeBetterDAO deployments (npm @vechain/vebetterdao-contracts).
// Set per build (src/network.js, .github/workflows/deploy.yml): the main app and
// the /testnet/ copy are the same code with a different NETWORK and REWARD_API.

const NETWORKS = {
  mainnet: {
    node: "https://mainnet.vechain.org",
    contracts: {
      B3TR:              "0x5ef79995FE8a89e0812330E4378eB2660ceDe699",
      X2EarnRewardsPool: "0x6Bee7DDab6c99d5B2Af0554EaEA484CE18F52631",
      X2EarnApps:        "0x8392B7CCc763dB03b47afcD8E8f5e24F9cf0554D",
      // VeBetterDAO's Galaxy Member (GM) NFT. Address as in @vechain/vechain-kit.
      // Read on mainnet in every build: see GalaxyMemberBadge.
      GalaxyMember:      "0x93B8cD34A7Fc4f53271b9011161F7A2B5fEA9D1F",
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
export const CONTRACTS = NETWORKS[NETWORK].contracts;
export const NETWORK_LABEL = NETWORK === "mainnet" ? "VeChain Mainnet" : "VeChain Testnet";
// Block explorer for the active network — history rows and admin checks link here
// so every payout is verifiable on-chain with one tap.
export const EXPLORER = NETWORK === "mainnet" ? "https://explore.vechain.org" : "https://explore-testnet.vechain.org";

// Photos must come from a PHONE CAMERA, not a file picker. The inputs use
// capture="environment" (mobile browsers open the camera directly), desktop is
// blocked entirely, and a freshness gate rejects photos not taken just now —
// gallery picks and downloaded/AI-generated images are minutes-to-years old.
// iPadOS 13+ reports a Macintosh UA — detect it via multi-touch support.
// A file input must stay IN the layout to be reliably activatable. `display:none`
// removes it from the accessibility tree, and several in-app browsers (VeWorld's
// WebView among them) then refuse to open the camera for it — silently, which is
// exactly how "the photo button does nothing" looks from the outside. Hidden this
// way it is still a real, focusable control that a <label> can drive natively.
const HIDDEN_FILE_INPUT = {
  position: "absolute", width: 1, height: 1, opacity: 0, padding: 0, margin: -1,
  border: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap",
};

// The testnet strip (TestnetBanner) is fixed at the top, above everything. The
// sticky header and the full-screen overlays start below it, or the strip hides
// their title bar and Close button. 26 = its 16px line + 2 × 5px padding.
const BANNER_H = TESTNET_BANNER ? 26 : 0;
export const OVERLAY_INSET = BANNER_H ? `${BANNER_H}px 0 0` : 0;

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
export const VEBETTER_APP_ID = "0x489c6c122157f3b1072c2565b0eb6cb734564e84d14c80b1a12e6834a075f71e";

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
// REWARD_API comes from src/network.js (per build).

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


// Long-form setup documentation (P1 readers, Home Assistant, the bridge) lives
// outside the app: those are read on a laptop while wiring up hardware, not on a
// phone mid-submission. The app keeps only help that's useful in the moment and
// links here for the rest. One constant so the destination is easy to move.
export const GUIDE_URL = "https://greenutilitylog.github.io/GreenUtilityLog/guide.html";
// The bridge helper, served as a single file so setup is "download and run" rather
// than "install git, clone a repo, find the right folder". docs/gul.js is generated
// from bridge/index.js by docs/build_guide.py, so the two cannot drift apart.
export const BRIDGE_JS_URL = "https://greenutilitylog.github.io/GreenUtilityLog/gul.js";


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

// ────────────────────────────────────────────────────────────────────────────
// PDF EXPORT
// ────────────────────────────────────────────────────────────────────────────
async function generateMonthlyPDF(b3tr, subs) {
  try {
    const { jsPDF } = window.jspdf || await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      // The file's own fingerprint: a changed or tampered copy is refused, not run.
      script.integrity = 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk';
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(window.jspdf); // the UMD build defines window.jspdf.jsPDF, not window.jsPDF
      script.onerror = reject;
      document.head.appendChild(script);
    });

    const doc = new jsPDF();
    const today = new Date();
    const month = today.toLocaleString('en', { month: 'long', year: 'numeric' });
    
    // This month only (local time), as the title says. jsPDF's built-in font has no
    // emoji, so none are used.
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
    const rows = subs.filter(s => (s.submittedAt || localDayTs(s.date) || 0) >= monthStart);
    const monthB3tr = earnedTotal(rows);

    doc.setFontSize(24);
    doc.text('Green Utility Log', 20, 20);
    doc.setFontSize(12);
    doc.text(`Monthly Report - ${month}`, 20, 30);
    doc.setFontSize(10);
    doc.text(`B3TR earned this month: ${monthB3tr.toFixed(2)} B3TR (all time: ${b3tr.toFixed(2)})`, 20, 45);
    doc.text(`Network: ${NETWORK_LABEL}${NETWORK === "testnet" ? " (test tokens, no real-world value)" : ""}`, 20, 55);
    doc.text(`Submissions this month: ${rows.length}`, 20, 65);
    doc.setFontSize(14);
    doc.text('Submissions', 20, 85);
    doc.setFontSize(9);

    let yPos = 100;
    if (!rows.length) doc.text('No submissions this month yet.', 20, yPos);
    rows.forEach((s, i) => {
      if (yPos > 270) { doc.addPage(); yPos = 20; }
      const paid = s.status === "failed" ? "payout failed" : s.status === "pending" ? `+${(Number(s.b3tr) || 0).toFixed(2)} B3TR (pending)` : s.status === "recorded" ? "recorded, no saving to reward" : `+${(Number(s.b3tr) || 0).toFixed(2)} B3TR`;
      if (s.type === "eco") {
        doc.text(`${i+1}. Eco bonus${s.appliance ? ` (${s.appliance})` : ""} - ${s.date}`, 20, yPos);
        doc.text(paid, 20, yPos+5);
      } else {
        const u = getUtil(s.type);
        const cur = parseFloat(s.cur), prev = parseFloat(s.prev);
        const usage = Number.isFinite(cur) && Number.isFinite(prev) ? `Usage: ${(cur - prev).toFixed(2)} ${u.unit} | ` : (Number.isFinite(cur) ? `Reading: ${cur} ${u.unit} | ` : "");
        doc.text(`${i+1}. ${u.label} - ${s.date}`, 20, yPos);
        doc.text(`${usage}${paid}`, 20, yPos+5);
      }
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
  try { localStorage.setItem('greenlog_baselines', JSON.stringify(baselines)); } catch { /* storage blocked */ }
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
  try { localStorage.setItem('greenlog_meters', JSON.stringify(meters)); } catch { /* storage blocked */ }
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
// A payout the server sent but had not yet seen in a block is "pending" until the
// chain lists it (then the chain's row replaces it). One that still isn't there
// after PENDING_GIVE_UP_MS never made it — a VeChain transaction expires within
// minutes — and is shown as "failed", not as money earned.
const PENDING_GIVE_UP_MS = 30 * 60 * 1000;
function mergeSubs(local, chain) {
  const same = (a, b) =>
    (a.txHash && b.txHash && a.txHash === b.txHash) ||
    (a.type === b.type && String(a.cur) === String(b.cur) && String(a.meterNo) === String(b.meterNo) && a.date === b.date);
  const extras = (local || []).filter(l => !(chain || []).some(c => same(l, c)))
    .map(l => (l.status === "pending" && Date.now() - (l.submittedAt || 0) > PENDING_GIVE_UP_MS ? { ...l, status: "failed" } : l));
  return [...(chain || []), ...extras].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
}
// What counts as earned: only payouts that are in a block. One rule for every
// total — Progress, the week chart, records and the PDF used to add pending and
// failed payouts while "Total earned" next to them didn't.
const countsAsPaid = (s) => !!s && s.status !== "pending" && s.status !== "failed" && s.status !== "recorded";
const paidAmount = (s) => (countsAsPaid(s) ? (parseFloat(s.b3tr) || 0) : 0);
const earnedTotal = (subs) => (subs || []).reduce((a, s) => a + paidAmount(s), 0);

// ────────────────────────────────────────────────────────────────────────────
// ANTI-FARMING ENGINE
// ────────────────────────────────────────────────────────────────────────────

// Lifted out of checkPlausibility so other code can ask the same question without
// restating the numbers — the smart-meter card needs to know when a jump is beyond
// anything any span could ever allow. MUST match USAGE_BOUNDS on the server.
export const USAGE_RANGES = { electric: { min:0.1, max:80 }, gas: { min:0.01, max:20 }, water: { min:10, max:1000}, solar: { min:0.1, max:60 } };

// Less than the per-day floor over the whole span (0.1 kWh a day for electricity):
// not a saving but a stale or repeated reading, so the server records it without a
// reward. MUST match nearZero in server/verify.js.
function nearZeroUsage(utilId, usageVal, days = 1) {
  const range = USAGE_RANGES[utilId];
  if (!range || !SAVING_UTILS.has(utilId)) return false;
  const span = Math.min(Math.max(Number(days) > 0 ? Number(days) : 1, MIN_SPAN_DAYS), MAX_SPAN_DAYS);
  return usageVal < range.min * span;
}

function checkPlausibility(utilId, usageVal, days = 1) {
  const range = USAGE_RANGES[utilId];
  if (!range) return { ok:true };
  // The ceiling stretches with the span, exactly as usageBoundsFor does on the
  // server: eight kWh a day over a week is 56, not 8. Without this the app was the
  // stricter of the two and refused readings the backend would have paid — anyone
  // who doesn't submit daily was blocked by their own client.
  // Not capped at MAX_SPAN_DAYS (that's the savings target): a month between two
  // readings is normal, and capped it was refused for good (server: usageBoundsFor).
  const span = Math.min(Math.max(Number(days) || 1, 1), 400);
  const ceiling = +(range.max * span).toFixed(2);
  // Almost no usage on a saving meter is accepted (the server records it without a
  // reward and flags it — see nearZeroUsage); only for production meters is a tiny-but-
  // nonzero value treated as a typo. High is abnormal either way.
  if (!SAVING_UTILS.has(utilId) && usageVal > 0 && usageVal < range.min) return { ok:false, reason: t("plaus.low", { usage: usageVal, min: range.min }) };
  if (usageVal > ceiling) return { ok:false, reason: t("plaus.high", { usage: usageVal, max: ceiling }), tooHigh:true };
  return { ok:true };
}

// Compares usage PER DAY with the usual per-submission usage (normally a day's).
// Comparing a 5-day total with a 1-day average called every reading after a few days
// away "5x your average" — and each later reading was bigger still. `days` is the
// span this reading covers.
function checkAnomaly(utilId, usageVal, subs, days = 1) {
  const recent = subs.filter(s=>s.type===utilId).slice(0,14);
  // Only rows with a real prev→cur delta count. Photoless/auto-submit rows store an
  // empty prev, so parseFloat("") = NaN; without this filter a single such row makes
  // avg NaN and silently disables the anomaly gate for the whole utility.
  const deltas = recent.map(s=>parseFloat(s.cur)-parseFloat(s.prev)).filter(Number.isFinite);
  if (deltas.length < 3) return { ok:true, anomaly:false };
  const avg = deltas.reduce((a,d)=>a+d,0)/deltas.length;
  const perDay = usageVal / Math.max(1, Number(days) || 1);
  if (avg > 0 && perDay > avg * 3.5) return { ok:false, anomaly:true, reason:`Usage is ${(perDay/avg).toFixed(1)}x your daily average`, avg };
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
// submission is recorded as unconfirmed. It is still PAID — these checks
// false-positive on genuine phone photos, so blocking on them would punish honest
// users. The flag travels to the server, which stores it against the txid for an
// admin to look at afterwards; nothing is held and nobody is waiting on a decision.
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

// One connection for the whole session: every read and write used to open its own
// and never closed it. Dropped when the browser closes it or another tab upgrades
// the database, so the next call opens a fresh one.
let dbPromise = null;
function initDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("submissions")) db.createObjectStore("submissions", { keyPath: "id" });
    };
  });
  return dbPromise;
}

// Queued photos are a few hundred KB each and used to stay on the phone for good:
// sent ones, refused ones and ones too old to be paid. The server takes a photo
// up to 7 days old (PHOTO_MAX_AGE_DAYS), so anything older can never pay. Kept:
// what is still waiting and can still be paid.
const OFFLINE_KEEP_MS = 14 * 86400000;
async function pruneOfflineQueue() {
  const db = await initDB();
  return new Promise((resolve) => {
    const tx = db.transaction("submissions", "readwrite");
    const req = tx.objectStore("submissions").openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const v = c.value || {};
      if (v.synced || v.failed || !v.photo || Date.now() - (Number(v.id) || 0) > OFFLINE_KEEP_MS) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
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

// Submissions captured while offline, still waiting to be broadcast. Skips synced
// ones, ones the server refused for good, and ones in flight. An in-flight flag
// only holds for as long as a payout call can take: a WebView killed mid-request
// never clears it, and without an expiry that item was stuck forever. Retrying an
// expired one is safe — the server's photo-hash dedupe never pays a photo twice.
// (PAYOUT_MS is declared further down, so it's read at call time, not here.)
async function getUnsyncedSubmissions() {
  await pruneOfflineQueue().catch(() => {});
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("submissions", "readonly").objectStore("submissions").getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result || []).filter(s => !s.synced && !s.failed
      && !(s.retryAfter && Date.now() < s.retryAfter)
      && (!s.broadcasting || !s.broadcastAt || Date.now() - s.broadcastAt > PAYOUT_MS + 60000)));
  });
}

// Read-modify-write one queued submission.
async function updateOfflineSubmission(id, patch) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const store = db.transaction("submissions", "readwrite").objectStore("submissions");
    const get = store.get(id);
    get.onerror = () => reject(get.error);
    get.onsuccess = () => {
      const v = get.result;
      if (v) store.put({ ...v, ...patch });
      resolve();
    };
  });
}

// Flag a queued submission as in-flight right before the /reward call, so a sync
// that runs again meanwhile doesn't send it twice. Timestamped: see above.
function markBroadcasting(id, flag) {
  return updateOfflineSubmission(id, { broadcasting: !!flag, broadcastAt: flag ? Date.now() : 0 });
}

// The server refused this item for good (a 4xx: cooldown, duplicate photo, lower
// reading…). Retrying would ask for a signature on every reconnect, forever.
function markFailed(id, reason) {
  return updateOfflineSubmission(id, { failed: true, failReason: String(reason || ""), broadcasting: false, broadcastAt: 0 });
}

// "Not yet" rather than "no": a cooldown that hasn't run out, or a wallet still
// waiting for its access pass. Kept, and left alone until `ms` from now, so it
// doesn't ask for a signature on every reconnect meanwhile.
function markLater(id, ms, reason) {
  return updateOfflineSubmission(id, { retryAfter: Date.now() + ms, failReason: String(reason || ""), broadcasting: false, broadcastAt: 0 });
}

// A queued submission that went through is removed: nothing reads it again, and
// keeping it kept its photo on the phone.
async function markSynced(id) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction("submissions", "readwrite").objectStore("submissions").delete(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
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
  green1:"#1a3326", green2:"#264d3a", green3:"#3f6a52", green4:"#90b8a2", green5:"#dce8e1",
  text:"#0d1812", textMid:"#334a3e", textSoft:"#54685e",
  border:"#cbc6bc", shadow:"rgba(13,24,18,0.05)", shadowMd:"rgba(13,24,18,0.10)",
  electric:"#8a4200", electricBg:"#f0e8de", electricBorder:"#b89070",
  gas:"#7a1c1c",      gasBg:"#ede0e0",    gasBorder:"#b88a8a",
  water:"#10386a",    waterBg:"#dde8f4",  waterBorder:"#80a8cc",
  solar:"#264d3a",    solarBg:"#dce8e1",  solarBorder:"#90b8a2",
  eco:"#264d3a",      ecoBg:"#dce8e1",    ecoBorder:"#90b8a2",
  card:"#f5f2ec", navBg:"rgba(237,233,226,0.97)",
  heroFrom:"#1a3326", heroTo:"#264d3a",
};
export const DARK = {
  // bgAlt is a step lighter than card: empty calendar cells, chips and inputs on
  // a card used to be the card's own colour and disappeared.
  bg:"#0e1714", bgAlt:"#22332b", white:"#1b2a23",
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

// The chrome used platform emoji — a red question mark, a yellow moon, a blue
// person, a multicoloured camera — over a muted sage palette they had nothing to do
// with, rendering differently on every OS. UTIL_ICONS below was already a proper
// inline-SVG set, so these are drawn in the same idiom: 20x20 box, currentColor,
// 1.7 stroke, round caps. They inherit the text colour, so they follow the theme and
// the active/inactive nav state on their own.

export const UTIL_ICONS = {
  electric: <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M11 2L4 12h6l-1 6 7-10h-6l1-6z"/></svg>,
  gas:      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="16" height="16"><path d="M10 17c-3.3 0-6-2.7-6-6 0-4 3-7 6-9 3 2 6 5 6 9 0 3.3-2.7 6-6 6z"/><path d="M10 13a2 2 0 000-4c-1.1 0-2 .9-2 2" strokeOpacity=".6"/></svg>,
  water:    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M10 2C7 6 4 9.5 4 13a6 6 0 0012 0c0-3.5-3-7-6-11z" opacity=".9"/></svg>,
  solar:    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="16" height="16"><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M4.6 15.4l1.4-1.4M14 6l1.4-1.4"/></svg>,
  eco:      <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M16 3c-6 0-11 3-11 9 0 1.4.4 2.6 1 3.6C7.6 12 10.5 9.5 14 8c-3 2-5.6 4.6-7 8 .9.6 2 1 3.2 1C15 17 17 11 16 3z"/></svg>,
};

export const UTILS = [
  { id:"electric", label:"Electric", unit:"kWh", rate:0.61, ph:["3834.8","3847.2"], hint:"Lights, appliances, boiler" },
  // Hidden for now — testing electricity first. Uncomment a line to bring that meter back.
  // Before re-enabling SOLAR: MAX_PAYOUT_PER_SUBMISSION (4 B3TR per submission) applies to
  // production meters too, and solar is rewarded for producing MORE, not less. A good
  // day used to pay around 43; under the cap it pays 6. Decide that deliberately.
  // { id:"gas",      label:"Gas",      unit:"m³",  rate:0.84, ph:["521.4","523.1"],   hint:"Heating & cooking" },
  // { id:"water",    label:"Water",    unit:"L",   rate:0.12, ph:["12320","12450"],    hint:"Household water usage" },
  // { id:"solar",    label:"Solar",    unit:"kWh", rate:0.72, ph:["130.1","142.3"],    hint:"Solar panel output", optional:true },
];



// ── Conservation-based reward (MUST match server/config.js) ───────────────────
// We reward USING LESS, and only that — every B3TR is saved kWh × rate:
//   reward = max(0, benchmark × days - usage) * rate     (consumption meters)
//   reward = usage * rate                                (solar — produced energy)
// USAGE_BENCHMARK is a fixed "efficient usage" threshold per day (not an average
// — works from the first submission). A reading that saves nothing, and a meter's
// first reading (it only sets the starting point), is recorded without a reward.
const REWARD_BASE     = { electric: 0, gas: 0, water: 0, solar: 0 };
const USAGE_BENCHMARK = { electric: 8,   gas: 6,   water: 300, solar: 0   };
const SAVING_UTILS    = new Set(["electric", "gas", "water"]); // solar rewards production
// MUST mirror server/config.js — the preview here and the payout there have to
// agree, or the app promises a number it doesn't deliver.
export const MAX_SPAN_DAYS    = 7;
// Parts of a day count as parts of a day (server: config.js MIN_SPAN_DAYS).
const MIN_SPAN_DAYS = 1 / 24;
// What this deployment's server enforces. /health → rules replaces these defaults
// (the server's own) as soon as it answers, so a cautious start with a lower cap,
// or a longer cooldown, is also what the app previews and counts down.
// maxPayout is flat, NOT multiplied by the span: claiming daily should beat saving
// a week and claiming once.
export const RULES = { cooldownMs: 20 * 60 * 60 * 1000, maxPayout: 4 };
function applyRules(r) {
  let changed = false;
  for (const k of Object.keys(RULES)) {
    const n = Number(r?.[k]);
    if (r?.[k] != null && Number.isFinite(n) && n >= 0 && RULES[k] !== n) { RULES[k] = n; changed = true; }
  }
  return changed;
}
// Down to the cent, with a hair of slack: 0.57 is 0.5699999… in binary and would
// otherwise show as 0.56 (the server rounds the same way).
const floor2 = (n) => Math.floor(n * 100 + 1e-6) / 100;

// Days this reading covers, clamped to [1, MAX_SPAN_DAYS]. The target stretches with
// it, so a reading taken after five days is judged against five days of allowance
// instead of one — which is what made an efficient five-day reading pay the floor.
function spanDays(msSinceLastReading) {
  const d = Number(msSinceLastReading) / 86400000;
  if (!Number.isFinite(d)) return 1;
  return Math.min(Math.max(d, MIN_SPAN_DAYS), MAX_SPAN_DAYS);
}

function computeReward(utilId, usage, days = 1) {
  const u = UTILS.find(x => x.id === utilId) || {};
  const span = Math.min(Math.max(Number(days) > 0 ? Number(days) : 1, MIN_SPAN_DAYS), MAX_SPAN_DAYS);
  const base = REWARD_BASE[utilId] ?? 0;
  const rate = u.rate ?? 0;
  let amount;
  if (SAVING_UTILS.has(utilId)) {
    const saved = Math.max(0, (USAGE_BENCHMARK[utilId] ?? 0) * span - usage);
    amount = base + saved * rate;
  } else {
    amount = base + Math.max(0, usage) * rate;
  }
  return parseFloat(Math.min(amount, RULES.maxPayout).toFixed(2));
}

// A typed number as the app stores it: "3852,4" and "3.852,4" become "3852.4".
// Number fields (type="number") silently dropped a decimal comma on a phone set to
// English — "3852,4" became 38524 — so reading fields are text fields that take
// either separator, and show the number they will actually use.
export function normDecimal(v) {
  let s = String(v ?? "").replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, ".");
  s = s.replace(/[^0-9.]/g, "");
  const i = s.indexOf(".");
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, "");
}

// Shorten a wallet address for display: 0x1234…abcd
export function shortAddr(a){ return a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—"; }

// The app's own tiers (Moon … Platinum) are gone: the level that counts is the
// wallet's VeBetterDAO GM NFT, shown on Profile, and two sets of levels with
// overlapping names confused people.

// Consecutive-day streak based on submission dates ("YYYY-MM-DD"). The streak
// is allowed to end today OR yesterday, so it isn't reported as broken just
// because today's reading hasn't been logged yet.
function dayKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
// A day as people read it, in their own language: "21 Oct" / "Oct 21". The app
// showed "10/19", "21/9" and "2026-10-23" on one screen. Takes a "YYYY-MM-DD" day
// key (read as local midnight) or a timestamp.
const DAY_FMTS = {};
const dayFmt = () => { const l = getLang(); try { return (DAY_FMTS[l] ??= new Intl.DateTimeFormat(l, { day: "numeric", month: "short" })); } catch { return null; } };
export function fmtDay(x) {
  const m = typeof x === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(x) : null;
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(Number(x));
  if (!Number.isFinite(d.getTime())) return String(x ?? "");
  const f = dayFmt();
  return f ? f.format(d) : d.toDateString().slice(4, 10);
}
function computeStreak(subs){
  if (!subs || !subs.length) return 0;
  const days = new Set(subs.map(s => s.date));
  const d = new Date();
  if (!days.has(dayKey(d))) { d.setDate(d.getDate() - 1); if (!days.has(dayKey(d))) return 0; }
  let streak = 0;
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}


// A function, so the texts follow the language picked at the time it is shown.
const ONBOARD_SLIDES = () => [
  { icon:"🌍", title:t("tut.1.t"), sub:t("tut.1.s") },
  { icon:"📸", title:t("tut.2.t"), sub:t("tut.2.s") },
  { icon:"⚡", title:t("tut.3.t"), sub:t("tut.3.s") },
  { icon:"🏆", title:t("tut.4.t"), sub: NETWORK === "mainnet" ? t("tut.4.s.main") : t("tut.4.s.test") },
];

// ────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────

// Pseudo-utility for the eco-mode bonus: it shows up in history/charts like a
// submission but has no meter reading, unit or rate.
const ECO_UTIL = { id: "eco", label: "Eco Mode", unit: "", rate: 0, ph: ["", ""], hint: "Appliance eco-mode bonus" };
// A meter type's name in the current language (UTILS labels are English).
function utilName(id){ return id === "electric" ? t("util.electric") : getUtil(id).label; }
function getUtil(id){ return id === "eco" ? ECO_UTIL : (UTILS.find(u=>u.id===id)||UTILS[0]); }
// Registered up-front (electric/gas/water); optional ones (solar) are added later.
const REQUIRED_UTILS = UTILS.filter(u => !u.optional);
const SOLAR_UTILS    = UTILS.filter(u => u.id === "solar");
export function getColorBg(id, T) { return T[id+"Bg"] || T.electricBg; }

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


// Cooldown between paid submissions per utility — the server's (RULES.cooldownMs).
// The server also says when THIS wallet may submit again (/wallet/seen → nextAt),
// which covers payouts made elsewhere: another device, or a reader paid on arrival.
// Until it has answered, this device's own last payout is the guide.
export const SERVER_NEXT_AT = {};   // utility → epoch ms (0 = now), for the connected wallet
// Which wallet SERVER_NEXT_AT and the local fallback belong to. Set by App while it
// renders (setCooldownWallet), so a switched-to wallet never sees the previous
// one's "next submission in 6h" — not even for the one render before an effect.
let COOLDOWN_WALLET = "";
function setCooldownWallet(wallet) {
  const w = String(wallet || "").toLowerCase();
  if (w === COOLDOWN_WALLET) return;
  COOLDOWN_WALLET = w;
  for (const k of Object.keys(SERVER_NEXT_AT)) delete SERVER_NEXT_AT[k];   // another wallet's
}
// Keyed by wallet: one wallet's payout says nothing about another's cooldown.
const cooldownsKey = () => `greenlog_cooldowns_${COOLDOWN_WALLET}`;
function getCooldowns() {
  try { return JSON.parse(localStorage.getItem(cooldownsKey()) || "{}"); } catch { return {}; }
}
function setCooldown(utilId) {
  SERVER_NEXT_AT[utilId] = Date.now() + RULES.cooldownMs;
  const cd = getCooldowns(); cd[utilId] = Date.now();
  try { localStorage.setItem(cooldownsKey(), JSON.stringify(cd)); } catch {}
}
function getCooldownRemaining(utilId) {
  if (Object.prototype.hasOwnProperty.call(SERVER_NEXT_AT, utilId)) {
    return Math.max(0, (SERVER_NEXT_AT[utilId] || 0) - Date.now());
  }
  const cd = getCooldowns();
  if (!cd[utilId]) return 0;
  const rem = RULES.cooldownMs - (Date.now() - cd[utilId]);
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

const TESSERACT_FILES = new URL(`${import.meta.env.BASE_URL}tesseract/`, window.location.href).href;
// workerBlobURL false: the worker is started from its own file on this site instead
// of a blob made from fetched code.
// The language models are served from this site too (vite.config.js), so a scan
// contacts no one but us.
const TESSERACT_OPTS = { workerPath: TESSERACT_FILES + "worker.min.js", corePath: TESSERACT_FILES, langPath: TESSERACT_FILES + "lang", workerBlobURL: false, logger: () => {} };
let _tesseractReady = null;
async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (_tesseractReady) return _tesseractReady;
  _tesseractReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // Served from this site (vite.config.js copies it from the pinned npm package),
    // together with the worker and the WebAssembly core it loads: from a CDN those
    // two could not be pinned, and they run as this page, next to the wallet session.
    s.src = TESSERACT_FILES + "tesseract.min.js";
    s.onload  = () => resolve(window.Tesseract);
    // Not cached as failed: one load that failed (offline for a moment) used to
    // leave every later scan in the session without OCR.
    s.onerror = (e) => { _tesseractReady = null; s.remove(); reject(e); };
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

async function makeWorker(Tesseract, model) {
  const worker = model === "ssd"
    ? await Tesseract.createWorker("ssd", 1, TESSERACT_OPTS)
    : await Tesseract.createWorker("eng", 1, TESSERACT_OPTS);
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
  const b = (OCR_API || REWARD_API).trim();
  return b ? b.replace(/\/$/, "") : "";
}

// A photo in a format the server's photo check can't read (HEIC from a phone set
// to "high efficiency", say) is refused there. Re-encode it to JPEG here when this
// browser can decode it; JPEG/PNG/WebP/GIF go up untouched, so their EXIF date —
// which the server uses to refuse old photos — survives.
const UPLOADABLE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
async function uploadablePhoto(file) {
  if (!file || UPLOADABLE.has(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
    return blob || file;
  } catch {
    return file; // can't decode it here either — send as is, the server will say so
  }
}

// Every call to our backend or a VeChain node gets a deadline. A Render service
// waking from sleep can take a minute, and without one the app sat on "OCR…" or
// "Submitting…" for good. Payouts get longer: they wait for the chain.
const PAYOUT_MS = 120000;
// ── Device recognition (see server/device.js) ──────────────────────────────────
// One phone with a handful of wallets is the cheapest way to farm, so payouts carry
// two things about the phone: a random install id kept in this app's storage (the
// same for every wallet used here), and a SHA-256 of what the browser reports about
// the hardware. Only these two values leave the phone; neither says who you are.
let devicePromise = null;
const toHex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
function deviceInfo() {
  if (!devicePromise) devicePromise = (async () => {
    let id = "";
    try { id = localStorage.getItem("gul_device_id") || ""; } catch { /* no storage */ }
    if (!/^[0-9a-f]{32}$/.test(id)) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      id = toHex(b);
      try { localStorage.setItem("gul_device_id", id); } catch { /* no storage */ }
    }
    let fp = "";
    try {
      // Sorted: some Android phones swap width and height when turned.
      const parts = [[screen.width, screen.height].sort((a, b) => a - b), screen.colorDepth, window.devicePixelRatio,
        Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.platform,
        navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints];
      try {
        const gl = document.createElement("canvas").getContext("webgl");
        const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) parts.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
      } catch { /* no WebGL */ }
      try {
        const c = document.createElement("canvas");
        c.width = 220; c.height = 30;
        const x = c.getContext("2d");
        x.textBaseline = "top"; x.font = "16px Arial";
        x.fillStyle = "#f60"; x.fillRect(100, 1, 62, 20);
        x.fillStyle = "#069"; x.fillText("GreenUtilityLog 1.8.0 kWh", 2, 2);
        parts.push(c.toDataURL());
      } catch { /* no canvas */ }
      fp = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)))));
    } catch { /* no crypto.subtle: the install id alone */ }
    return fp ? { id, fp } : { id };
  })();
  return devicePromise;
}

// The app's language for the reward server, which then answers its errors in it
// (server/messages.js). Only on requests that already need a CORS preflight (a
// POST, or our own headers), so a plain GET doesn't gain one.
function withLang(url, opts) {
  if (!String(url).startsWith(REWARD_API.replace(/\/$/, ""))) return opts;
  const custom = opts.headers && Object.keys(opts.headers).length;
  if (String(opts.method || "GET").toUpperCase() === "GET" && !custom) return opts;
  return { ...opts, headers: { ...(opts.headers || {}), "X-GUL-Lang": getLang() } };
}
export async function fetchT(url, opts = {}, ms = 30000) {
  opts = withLang(url, opts);
  if (opts.signal || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return fetch(url, opts);
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.name === "TimeoutError") {
      throw new Error(ms >= PAYOUT_MS
        ? t("net.timeoutPay")
        : t("net.timeout"));
    }
    throw e;
  }
}

// An error that remembers the HTTP status it came from. A 4xx is the server's
// final word on that request; anything else — a timeout, a dropped connection, a
// 5xx — leaves open whether a payout went out before it failed.
// `en` is the server's English text when it answered in the app's language: code
// that acts on what a refusal says reads that, not the translation.
function httpError(message, status, en) {
  const e = new Error(message);
  e.status = status;
  e.en = en || message;
  return e;
}
const isRefusal = (e) => e?.status >= 400 && e?.status < 500;

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
    const res = await fetchT(`${base}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    }, 45000);
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
    const res = await fetchT(`https://serverless.roboflow.com/${ROBOFLOW_MODEL}?api_key=${ROBOFLOW_API_KEY}`, {
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
  // Offline the worker and its WebAssembly can't load, and the attempt only ends
  // in an uncaught error from inside the worker. The reading is typed and queued
  // either way; the server checks the photo itself when it is sent.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { matched: true, ocrNums: [], ocrBest: null, ocrConfidence: 0, ocrFailed: true };
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
  if (typeof navigator !== "undefined" && navigator.onLine === false) return ""; // see runOCR
  try {
    const Tesseract = await loadTesseract();
    if (!Tesseract?.createWorker) return "";
    const src = await preprocessForOCR(file, false, false).catch(() => file); // greyscale full image
    const worker = await Tesseract.createWorker("eng", 1, TESSERACT_OPTS);
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
.intro-btn{margin-top:40px;width:100%;max-width:280px;min-height:52px;background:#e6f2ea;border:none;border-radius:8px;padding:15px;color:#14301f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;font-weight:800;cursor:pointer;transition:all .2s;text-transform:none;letter-spacing:0;box-shadow:0 8px 24px rgba(0,0,0,0.25);}
/* The one primary button on the dark green screens (intro, connect): light on
   dark, 12:1. It used to be the background's own green and read as disabled. */
.intro-btn:hover{background:#ffffff;box-shadow:0 12px 32px rgba(0,0,0,0.3);transform:translateY(-2px);}
.intro-btn:focus-visible{outline:3px solid #a8e0bd;outline-offset:3px;}
.intro-skip{margin-top:14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.6);cursor:pointer;background:none;border:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.intro-skip:hover{color:rgba(255,255,255,0.9);}
@keyframes intro-slideup{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes intro-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}

.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:${T.white};border-bottom:1px solid ${T.border};position:sticky;top:${BANNER_H}px;z-index:20;transition:background .25s;gap:16px;}
.logo{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}
.logo-mark{width:30px;height:30px;border-radius:6px;background:linear-gradient(135deg,#142c1e,#214834 55%,#3c6a50);display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 2px 8px ${T.shadow};font-weight:700;font-size:11px;}
.logo-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:800;color:${T.text};letter-spacing:-0.5px;line-height:1;}
.hdr-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.dark-toggle{width:44px;height:44px;border-radius:6px;background:transparent;border:1px solid ${T.border};display:flex;align-items:center;justify-content:center;cursor:pointer;color:${T.textMid};transition:all .15s;flex-shrink:0;font-size:14px;}
.dark-toggle:hover{border-color:${T.green3};color:${T.green3};}
.wallet-pill{display:flex;align-items:center;gap:6px;background:transparent;border:1px solid ${T.border};border-radius:6px;padding:5px 10px;min-height:44px;box-sizing:border-box;cursor:pointer;transition:all .15s;flex-shrink:0;font-size:11px;font-weight:600;}
.wallet-pill:hover,.wallet-pill.connected{border-color:${T.green3};color:${T.green3};}
.wdot{width:5px;height:5px;border-radius:50%;background:${T.green3};animation:wpulse 2.5s infinite;flex-shrink:0;}
.wdot.off{background:${T.textSoft};animation:none;}
@keyframes wpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.25;transform:scale(.65)}}
.waddr{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:10px;color:${T.textMid};letter-spacing:0;}
/* Phones: the name may take two lines rather than be cut to "Green Utility L",
   the buttons shrink a little, and the online dot only shows when OFFLINE.
   AFTER the rules it overrides — placed before them, it lost and did nothing. */
@media (max-width:430px){.hdr{padding:10px 12px;gap:8px;}.logo{gap:8px;}.logo-name{white-space:normal;font-size:14px;letter-spacing:-0.4px;line-height:1.1;}.hdr-actions{gap:6px;}.dark-toggle{width:44px;height:44px;}.hdr-online.is-online{display:none!important;}.wallet-pill{padding:5px 8px;}}

.hero{margin:16px 14px 0;border-radius:10px;border:1px solid ${T.border};background:${T.card};padding:22px;position:relative;overflow:hidden;}
.hero-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};margin-bottom:12px;}
.hero-amount{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:44px;font-weight:800;color:${T.text};line-height:1;letter-spacing:-1px;font-variant-numeric:tabular-nums;}
.hero-amount span{font-size:14px;font-weight:700;color:${T.textSoft};margin-left:8px;letter-spacing:0;}
.hero-usd{font-size:10px;color:${T.textSoft};margin-top:8px;}
.hero-chips{display:flex;gap:0;margin-top:20px;padding-top:18px;border-top:1px solid ${T.border};}
.hchip{flex:1;padding-right:18px;margin-right:18px;border-right:1px solid ${T.border};}
.hchip:last-child{border-right:none;margin-right:0;padding-right:0;}
.hchip-val{font-size:20px;font-weight:800;color:${T.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1;font-variant-numeric:tabular-nums;}
.hchip-key{white-space:nowrap;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};margin-top:5px;}

.sec{display:flex;align-items:center;gap:12px;margin:24px 14px 14px;padding:0;}
.sec-line{flex:1;height:1px;background:${T.border};}
.sec-txt{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};}

.util-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 14px 16px;}
.ucard{background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:14px;transition:all .2s;cursor:pointer;}
.ucard:hover{border-color:${T.green3};}
.ucard-icon{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:${T.green2};font-size:16px;}
.ucard-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.ucard-reads{font-size:10px;color:${T.textSoft};margin-top:4px;font-weight:500;}
.ucard-b3tr{font-size:16px;font-weight:800;margin-top:9px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-variant-numeric:tabular-nums;}

.calendar{margin:0 14px 14px;background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:16px;}
.cal-hdr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:13px;}
.cal-month{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.cal-streak{font-size:11px;font-weight:600;color:${T.green3};display:flex;align-items:center;gap:5px;}
.cal-streak svg{width:15px;height:15px;}
.cal-days-hdr{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:4px;}
.cal-day-name{text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}
.cal-cell{aspect-ratio:1;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:500;color:${T.textSoft};background:${T.bgAlt};}
.cal-cell.has-sub{background:${T.green1};color:${T === DARK ? T.bg : "#fff"};font-weight:600;}
.cal-cell.today{outline:1.5px solid ${T.green3};outline-offset:-1px;}
.cal-cell.empty{opacity:0;}

.hitem{margin:0 14px 6px;background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:13px 14px;display:flex;align-items:center;gap:12px;transition:all .2s;}
.hitem:hover{border-color:${T.green3};}
.hicon{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.hinfo{flex:1;min-width:0;}
.htitle{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.hdate{font-size:11.5px;color:${T.textSoft};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin-top:2px;}
.hright{text-align:right;flex-shrink:0;}
.hb3tr{font-size:16px;font-weight:800;color:${T.green1};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-variant-numeric:tabular-nums;}
.hstatus{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding:1px 5px;border-radius:999px;margin-top:4px;display:inline-block;}
.s-confirmed{background:${T.green5};color:${T.green2};border:1px solid ${T.green4};}
.s-pending{background:rgba(230,160,40,.12);color:${T === DARK ? "#e7b45a" : "#8a5a00"};border:1px solid rgba(230,160,40,.45);}
.s-failed{background:rgba(220,80,60,.10);color:#c0392b;border:1px solid rgba(220,80,60,.45);}
.s-recorded{background:${T.bgAlt};color:${T.textMid};border:1px solid ${T.border};}

.sub-header{padding:20px 18px 10px;}
.sub-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:800;color:${T.text};letter-spacing:-0.4px;}
.sub-sub{font-size:11px;color:${T.textSoft};margin-top:4px;text-transform:uppercase;letter-spacing:.8px;}
.util-selector{display:grid;grid-template-columns:repeat(${UTILS.length},1fr);margin:0 14px 14px;border:1px solid ${T.border};border-radius:6px;overflow:hidden;}
.utab{display:flex;flex-direction:column;align-items:center;gap:3px;background:${T.card};border-right:1px solid ${T.border};padding:10px 4px;cursor:pointer;transition:background .12s,color .12s;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;border-radius:0;}
.utab:last-child{border-right:none;}
.utab:hover,.utab.active{background:var(--ubg);color:var(--uc);}
.utab-icon{font-size:18px;}

.verify-zone{margin:0 14px 12px;border-radius:10px;overflow:hidden;border:1px solid ${T.border};background:${T.card};transition:border-color .15s;cursor:pointer;}
.verify-zone:hover{border-color:${T.green3};}
.verify-zone.verified{background:${T.green5};}
.verify-zone.error{border-color:${T.gas};background:${T.gasBg};}
.vz-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:26px;text-align:center;}
.vz-icon{font-size:26px;margin-bottom:2px;}
.vz-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.vz-sub{font-size:10px;color:${T.textSoft};}
.vz-meter{font-size:10px;font-weight:700;font-family:'SF Mono',Menlo,'Courier New',monospace;color:${T.green1};background:${T.bgAlt};border:1px solid ${T.border};border-radius:6px;padding:2px 8px;letter-spacing:.4px;}
.vz-verifying{display:flex;flex-direction:column;align-items:center;gap:12px;padding:26px;}
.ai-ring{width:36px;height:36px;border-radius:50%;border:2px solid ${T.border};border-top-color:${T.green3};animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.ai-steps{display:flex;flex-direction:column;gap:2px;width:100%;}
.ai-step{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:500;color:${T.textSoft};padding:4px 10px;border-radius:6px;transition:color .2s;}
.ai-step.done{color:${T.green3};}
.ai-step.active{color:${T.text};font-weight:700;}
.ai-step-icon{font-size:10px;width:12px;text-align:center;}
.vz-result{padding:14px 16px;}
.vr-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.vr-badge{display:flex;align-items:center;gap:4px;background:transparent;border:1px solid ${T.green3};border-radius:999px;padding:3px 7px;font-size:10px;font-weight:700;color:${T.green3};text-transform:uppercase;letter-spacing:.6px;}
.vr-confidence{font-size:10px;color:${T.textSoft};margin-left:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.vr-summary{font-size:11px;color:${T.textMid};line-height:1.55;}
.vr-retry{font-size:10px;font-weight:700;color:${T.green3};margin-top:7px;cursor:pointer;text-transform:uppercase;letter-spacing:.8px;}
.vz-photo{width:100%;max-height:160px;object-fit:cover;border-radius:6px;border:1px solid ${T.border};margin-bottom:10px;display:block;}
.vz-photo.sm{max-height:90px;}

.form-card{margin:0 14px 14px;background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:16px;}
.irow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
.igroup{display:flex;flex-direction:column;gap:4px;}
.ilabel{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};display:flex;align-items:center;gap:6px;}
.utag{border-radius:4px;padding:1px 4px;font-size:10.5px;font-weight:700;background:var(--ubg);color:var(--uc);border:1px solid var(--uborder);text-transform:uppercase;letter-spacing:.6px;}
.ifield{width:100%;min-height:44px;box-sizing:border-box;background:${T.bg};border:1px solid ${T === DARK ? T.border : "#8f8a80"};border-radius:6px;padding:10px;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:16px;transition:border-color .15s;}
.ifield:focus{border-color:var(--uc,${T.green3});}
.ifield::placeholder{color:${T.textSoft};opacity:1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;}
.reward-preview{background:${T.bgAlt};border:1px solid ${T.border};border-left:1px solid ${T.border};border-radius:6px;padding:12px 13px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.rp-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};}
.rp-rate{font-size:10px;color:${T.textSoft};margin-top:3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.rp-val{font-size:28px;font-weight:800;color:${T.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:-0.5px;font-variant-numeric:tabular-nums;}
.rp-b3tr{font-size:10px;color:${T.textSoft};text-transform:uppercase;letter-spacing:.8px;}
.sbtn{width:100%;background:${T.green2};border:none;border-radius:6px;padding:14px;color:${T === DARK ? T.bg : "#fff"};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:800;cursor:pointer;transition:all .2s;letter-spacing:0;text-transform:none;display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;}
.sbtn:hover:not(:disabled){box-shadow:none;transform:none;filter:brightness(1.08);}
.sbtn:disabled{opacity:.4;cursor:not-allowed;}

.page-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:800;color:${T.text};padding:20px 18px 4px;letter-spacing:-0.4px;}
.chart-card{margin:0 14px 10px;background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:16px;}
.chart-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;}
.chart-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.chart-bars{display:flex;align-items:flex-end;gap:5px;height:68px;}
.chart-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;}
.chart-bar{width:100%;border-radius:3px 3px 0 0;min-height:3px;transition:all .3s;cursor:pointer;}
.chart-bar:hover{filter:brightness(1.2);}
.chart-val{font-size:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${T.textSoft};text-align:center;}
.chart-lbl{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:${T.textSoft};text-align:center;}

.lb-hero{margin:14px 14px 0;border-radius:10px;border:1px solid ${T.border};border-left:1px solid ${T.border};background:${T.card};padding:20px;}
.lb-hero-rank{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:48px;font-weight:800;color:${T.text};line-height:1;letter-spacing:-2px;font-variant-numeric:tabular-nums;}
.lb-item{margin:0 14px 6px;background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:11px;transition:all .2s;}
.lb-item:hover{border-color:${T.green3};}
.lb-item.me{border-left:1px solid ${T.green3};border-color:${T.green3};}
.lb-rank{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:700;color:${T.textSoft};width:22px;text-align:center;flex-shrink:0;font-variant-numeric:tabular-nums;}
.lb-name{font-size:12.5px;font-weight:700;text-transform:none;letter-spacing:0;color:${T.text};display:flex;align-items:center;gap:6px;}
.lb-b3tr{font-size:13px;font-weight:800;color:${T.green1};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-variant-numeric:tabular-nums;}

.profile-hero{margin:0 14px 14px;border:1px solid ${T.border};border-left:1px solid ${T.border};border-radius:10px;background:${T.card};padding:20px;}
.pname{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:${T.text};letter-spacing:-0.4px;}
.pstat-row{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin:0 14px 14px;}
.pstat{background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:13px;text-align:center;}
.pstat-val{font-size:22px;font-weight:800;color:${T.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:-0.5px;font-variant-numeric:tabular-nums;}
.pstat-key{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};margin-top:3px;}
.toggle{width:34px;height:19px;border-radius:10px;background:${T.border};border:none;cursor:pointer;position:relative;transition:background .18s;flex-shrink:0;}
.toggle.on{background:${T.green3};}
.toggle-dot{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:#fff;transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.2);}
.toggle.on .toggle-dot{transform:translateX(15px);}
.setting-row{margin:0 14px 5px;background:${T.card};border:1px solid ${T.border};border-radius:10px;padding:11px 13px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:border-color .15s;}
.setting-row:hover{border-color:${T.green3};}
.sr-left{display:flex;align-items:center;gap:10px;}
.sr-icon{width:28px;height:28px;border-radius:6px;background:${T.bgAlt};display:flex;align-items:center;justify-content:center;font-size:13px;border:1px solid ${T.border};}
.sr-label{font-size:13px;font-weight:700;color:${T.text};}
.sr-sub{font-size:10px;color:${T.textSoft};margin-top:1px;}
.sr-right{display:flex;align-items:center;gap:6px;}

.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:420px;background:${T.navBg};border-top:1px solid ${T.border};display:grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:10px 0 24px;z-index:20;backdrop-filter:blur(20px);}
.nitem{display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;border:none;background:none;color:${T.textSoft};transition:all .18s;padding:6px 2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;position:relative;}
.nitem.active{color:${T.green2};}
.nitem.active::before{content:'';position:absolute;top:-2px;left:50%;transform:translateX(-50%);width:20px;height:2px;background:${T.green3};border-radius:1px;}
.nicon{font-size:17px;width:30px;height:26px;display:flex;align-items:center;justify-content:center;color:inherit;}
.nlabel{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;}

/* 400, above the admin screen's 320: at 200 every message the admin panel
   produced rendered UNDER it, so signing an action showed nothing at all.
   Any new full-screen overlay must stay below this. */
.toast{position:fixed;bottom:calc(96px + env(safe-area-inset-bottom, 0px));left:50%;transform:translateX(-50%);background:${T.text};border-radius:8px;padding:10px 16px;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-weight:700;letter-spacing:.3px;color:${T.bg};z-index:400;width:max-content;max-width:min(88vw,420px);white-space:normal;overflow-wrap:anywhere;text-align:center;line-height:1.4;animation:toastin .18s ease;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
@keyframes toastin{from{opacity:0;transform:translateX(-50%) translateY(-5px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:100;display:flex;align-items:flex-end;justify-content:center;}
.modal{background:${T.card};border-radius:14px 14px 0 0;padding:24px 18px 36px;width:100%;max-width:420px;border-top:1px solid ${T.border};animation:slideup .22s ease;box-shadow:0 -4px 16px ${T.shadowMd};}
@keyframes slideup{from{transform:translateY(22px);opacity:0}to{transform:translateY(0);opacity:1}}
.modal-handle{width:28px;height:2px;background:${T.border};border-radius:1px;margin:0 auto 20px;}
.modal-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:${T.text};margin-bottom:4px;letter-spacing:-0.3px;}
.modal-opt{display:flex;align-items:center;gap:11px;background:${T.bg};border:1px solid ${T.border};border-radius:10px;padding:12px 13px;cursor:pointer;margin-bottom:7px;transition:border-color .15s;}
.modal-opt:hover{border-color:${T.green3};}
.modal-opt-icon{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:16px;background:${T.bgAlt};border:1px solid ${T.border};}
.modal-opt-name{font-size:13px;font-weight:700;color:${T.text};}

.onboard{position:fixed;inset:${OVERLAY_INSET || 0};background:${T.bg};z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 28px;}
.onboard::before,.onboard::after{content:"";display:block;flex:1 0 32px;}
.ob-icon{font-size:56px;margin-bottom:20px;animation:obpop .3s ease;}
.ob-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:28px;font-weight:800;color:${T.text};text-align:center;line-height:1.2;margin-bottom:12px;letter-spacing:-0.6px;}
.ob-sub{font-size:14px;color:${T.textMid};text-align:center;line-height:1.7;max-width:320px;}
@keyframes obpop{from{transform:scale(.82);opacity:0}to{transform:scale(1);opacity:1}}
.ob-dots{display:flex;gap:5px;margin-top:28px;}
.ob-dot{width:5px;height:5px;border-radius:3px;background:${T.border};transition:all .22s;}
.ob-dot.active{width:18px;background:${T.green1};}
.ob-btn{margin-top:24px;width:100%;max-width:280px;background:${T.green2};border:none;border-radius:6px;padding:15px;color:${T === DARK ? T.bg : "#fff"};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;font-weight:800;cursor:pointer;transition:all .2s;text-transform:none;letter-spacing:0;min-height:48px;}
.ob-btn:hover{box-shadow:0 6px 20px rgba(26,51,38,0.3);transform:translateY(-1px);}
.ob-skip{margin-top:13px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};cursor:pointer;background:none;border:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}

.spin-sm{width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block;}
.filter-row{display:flex;gap:5px;padding:0 14px 13px;overflow-x:auto;}
.fchip{flex-shrink:0;padding:4px 11px;border-radius:2px;font-size:10px;font-weight:700;cursor:pointer;border:1px solid ${T.border};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;transition:all .12s;text-transform:uppercase;letter-spacing:.8px;background:${T.card};color:${T.textSoft};}
.fchip.active{background:${T.green1};color:${T === DARK ? T.bg : "#fff"};border-color:${T.green1};}

/* A visible focus ring for keyboard and switch users. !important because a dozen
   inputs set outline:none inline. Mouse and touch don't trigger :focus-visible. */
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,[role="button"]:focus-visible,[tabindex]:focus-visible{outline:2px solid ${T.green3}!important;outline-offset:2px;}
/* Bouncing logos and pulsing dots loop for ever; people who asked their system for
   less motion get none. */
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important;}}
/* Text links and small controls that were 20-26 px tall: the tap area grows, the
   look doesn't. */
.tap44{position:relative;}
.tap44::after{content:"";position:absolute;inset:-10px -6px;}
`;
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ════════════════════════════════════════════════════════════════════════════

// Full-screen gate shown after the intro until a wallet is connected, so the
// user signs in BEFORE reaching the dashboard. Once connected, every meter
// submission only needs a single signature (no separate login step).
// A phone browser with no wallet in it — most often the in-app browser of X,
// Telegram or Instagram after tapping a link in a post. dapp-kit's VeWorld button
// then sends the page to veworld.com, meant as a link that opens the VeWorld app;
// inside those in-app browsers it doesn't, and people land on VeWorld's website
// instead of back here. Say so before they tap, in their own language.

function NoWalletHint() {
  const [copied, setCopied] = useState(false);
  if (!IS_MOBILE || typeof window === "undefined" || window.vechain) return null;
  const L = { t: t("nowallet.t"), d: t("nowallet.d"), copy: t("nowallet.copy"), done: t("nowallet.done") };
  const link = window.location.origin + window.location.pathname;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { window.prompt(L.copy, link); }
  };
  return (
    <div style={{ marginTop:18, padding:"12px 14px", borderRadius:8, background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.25)", textAlign:"left" }}>
      <div style={{ fontSize:12.5, fontWeight:700, color:"#fff", marginBottom:4 }}>{L.t}</div>
      <div style={{ fontSize:12, color:"rgba(255,255,255,0.8)", lineHeight:1.5 }}>{L.d}</div>
      <button onClick={copy} style={{ marginTop:10, padding:"6px 12px", borderRadius:6, border:"1px solid rgba(255,255,255,0.5)", background:"transparent", color:"#fff", fontSize:12, fontWeight:700, cursor:"pointer" }}>
        {copied ? L.done : `📋 ${L.copy}`}
      </button>
    </div>
  );
}

function WalletGate({ onConnect, online }) {
  const dlg = useDialog(null, t("gate.title"));
  return (
    /* One centred block — logo, headline, copy and the CTA travel together, so the
       button is never pushed below the fold on a short/mobile viewport. */
    <div {...dlg} className="intro-screen" style={{ zIndex: 410 }}>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", width:"100%", maxWidth:340 }}>
        <div style={{ marginBottom:18, animation:"intro-bounce 1.2s ease-in-out infinite", display:"flex", justifyContent:"center" }}><LogoTile size={84} /></div>
        <h1 style={{ fontSize:27, fontWeight:800, color:"#fff", lineHeight:1.2, letterSpacing:"-0.6px", margin:"0 0 10px" }}>{t("gate.title")}</h1>
        <p style={{ fontSize:13.5, color:"rgba(255,255,255,0.8)", lineHeight:1.55, margin:"0 0 22px" }}>
          {t("gate.sub")}
        </p>
        <button
          className="intro-btn"
          onClick={onConnect}
          disabled={!online}
          style={{ marginTop:0, ...(!online ? { opacity:0.5, cursor:"not-allowed" } : null) }}
        >
          {online ? t("gate.button") : t("gate.offline")}
        </button>
        {/* The wallet dialog lists the options without saying which to pick. */}
        <div style={{ marginTop:14, fontSize:12.5, color:"rgba(255,255,255,0.8)", lineHeight:1.5 }}>
          {IS_MOBILE ? t("gate.pick.mobile") : t("gate.pick.desktop")}
        </div>
        <div style={{ marginTop:8, fontSize:11, color:"rgba(255,255,255,0.6)", lineHeight:1.5 }}>
          {t("gate.keys")}
        </div>
        <NoWalletHint />
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
    { icon: 'logo', title: t("intro.1.t"), sub: t("intro.1.s") },
    { icon: '📸', title: t("intro.2.t"), sub: t("intro.2.s") },
    { icon: '💰', title: t("intro.3.t"), sub: NETWORK === "mainnet" ? t("intro.3.s.main") : t("intro.3.s.test") },
    { icon: '🏆', title: t("intro.4.t"), sub: t("intro.4.s") },
  ];
  
  const [slide, setSlide] = useState(0);
  const s = slides[slide];
  const isLast = slide === slides.length - 1;
  // One progress indicator — the dots. A bar at the top said the same thing again.
  return (
    <div className="intro-screen">

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
          <button
            key={i}
            aria-label={t("intro.slide", { n: i + 1, total: slides.length })}
            aria-current={i === slide ? "step" : undefined}
            style={{
              width: i === slide ? 24 : 8,
              height: 8,
              padding: 0,
              border: "none",
              borderRadius: 6,
              background: i === slide ? "#a8e0bd" : "rgba(255,255,255,0.35)",
              transition: "all 0.3s",
              cursor: "pointer"
            }}
            onClick={() => setSlide(i)}
          />
        ))}
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%",maxWidth:280}}>
        <button
          className="intro-btn"
          onClick={() => isLast ? onStart() : setSlide(s => s + 1)}
          style={{ marginTop: 0, maxWidth: "none" }}
        >
          {isLast ? t("intro.start") : t("intro.next")}
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
              letterSpacing: ".8px",
              padding: 8
            }}
            onMouseEnter={e => e.target.style.color = "rgba(255,255,255,0.9)"}
            onMouseLeave={e => e.target.style.color = "rgba(255,255,255,0.6)"}
          >
            {t("intro.skip")}
          </button>
        )}
      </div>

      <div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginTop:16}}>
        {t("intro.slide", { n: slide + 1, total: slides.length })}
      </div>
    </div>
  );
}

function BaselineOnboarding({ onDone, utils, existingBaselines, existingMeters, editMode, T }) {
  const dlg = useDialog(null, t("reg.title.new"));
  // Which utilities this screen registers. Defaults to the required ones
  // (electric/gas/water); solar is added separately as an optional extra.
  const shown = (utils && utils.length) ? utils : UTILS.filter(u => !u.optional);
  const [baselines, setBaselines] = useState(existingBaselines || { electric:"", gas:"", water:"", solar:"" });
  const [meters, setMeters]       = useState(existingMeters || { electric:"", gas:"", water:"", solar:"" });
  // Which inputs the user has visited and left. Validation styling keys off this:
  // an empty field nobody has touched yet is simply empty, not wrong.
  const [touched, setTouched]     = useState({});
  const markTouched = (k) => setTouched(t => (t[k] ? t : { ...t, [k]: true }));

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

  const title = allLocked ? t("reg.title.locked") : (isSolarOnly ? t("reg.title.solar") : (editMode ? t("reg.title.edit") : t("reg.title.new")));
  const sub = allLocked
    ? t("reg.sub.locked")
    : isSolarOnly
      ? t("reg.sub.solar")
      : t("reg.sub.new");

  return (
    <div {...dlg} className="onboard">
      <div className="ob-icon">{isSolarOnly ? "☀️" : "⚙️"}</div>
      <div className="ob-title" style={{color:T.text}}>{title}</div>
      <div className="ob-sub" style={{color:T.textMid}}>{sub}</div>
      <div style={{width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8,marginTop:20}}>
        {shown.map(u => {
          const needsMeter = required.includes(u);
          const locked = isLocked(u);
          const lockedInput = {width:"100%",boxSizing:"border-box",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6,padding:"7px 10px",fontSize:13,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.textMid,outline:"none",marginBottom:6,cursor:"not-allowed"};
          const editInput = (ok, key) => ({width:"100%",boxSizing:"border-box",background:T.bg,border:`1px solid ${(ok || !touched[key]) ? T.border : "rgba(220,80,60,0.7)"}`,borderRadius:6,padding:"9px 10px",fontSize:16,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.text,marginBottom:6});
          return (
          <div key={u.id} style={{display:"flex",alignItems:"flex-start",gap:12,background:T.card,borderRadius:6,padding:"10px 14px",border:`1px solid ${T.border}`}}>
            <span style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",color:T[u.id]||T.text,flexShrink:0,marginTop:2}}>{UTIL_ICONS[u.id]}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginBottom:4}}>{utilName(u.id)} <span style={{fontWeight:400}}>({u.unit})</span>{locked ? <span style={{fontWeight:400,textTransform:"none",letterSpacing:0,color:T.eco||T.text}}> · {t("reg.locked")}</span> : (!needsMeter && <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}> · {t("reg.optional")}</span>)}</div>
              <input
                type="text"
                readOnly={locked}
                placeholder={needsMeter ? t("reg.meterNo") : t("reg.meterNo.optional")}
                value={meters[u.id]}
                onChange={locked ? undefined : (e => setMeters(m => ({...m,[u.id]:e.target.value})))}
                onBlur={() => markTouched(`m:${u.id}`)}
                style={locked ? lockedInput : editInput((meters[u.id]||"").trim() || !needsMeter, `m:${u.id}`)}
              />
              {locked ? (
                <input type="text" readOnly value={`${baselines[u.id] || ""} ${u.unit}`} style={lockedInput} />
              ) : (
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={t("reg.reading", { example: u.ph[0] })}
                value={baselines[u.id]}
                onChange={e => setBaselines(b => ({...b,[u.id]:normDecimal(e.target.value)}))}
                onBlur={() => markTouched(`b:${u.id}`)}
                style={editInput(hasBaseline(u), `b:${u.id}`)}
              />
              )}
            </div>
          </div>
          );
        })}
      </div>
      {/* Only while solar is offered (it is commented out of UTILS for now). */}
      {SOLAR_UTILS.length > 0 && !isSolarOnly && !allLocked && <div style={{fontSize:11,color:T.textSoft,marginTop:16,textAlign:"center"}}>ℹ️ Got solar panels? Add them later in Settings.</div>}
      {allLocked && <div style={{fontSize:11,color:T.textSoft,marginTop:16,textAlign:"center"}}>{t("reg.allLocked")}</div>}
      {!allMetersFilled && <div style={{fontSize:11,color:Object.keys(touched).length ? (T === DARK ? "#f08c78" : "#b3261e") : T.textSoft,marginTop:6,textAlign:"center"}}>{t("reg.missing")}</div>}
      <button className="ob-btn" onClick={handleDone} disabled={!allMetersFilled} style={!allMetersFilled?{opacity:.5,cursor:"not-allowed"}:undefined}>{allLocked ? t("reg.done.locked") : (isSolarOnly ? t("reg.done.solar") : t("reg.done"))}</button>
    </div>
  );
}

function Onboarding({ onDone }) {
  const dlg = useDialog(onDone, t("dlg.tutorial"));
  const [slide, setSlide] = useState(0);
  const slides = ONBOARD_SLIDES();
  const s = slides[slide];
  const isLast = slide === slides.length - 1;

  return (
    <div {...dlg} className="onboard">
      <div className="ob-icon">{s.icon}</div>
      <h2 className="ob-title">{s.title}</h2>
      <p className="ob-sub">{s.sub}</p>
      <div className="ob-dots">
        {slides.map((_, i) => (
          <div role="button" tabIndex={0} key={i} aria-label={t("intro.slide", { n: i + 1, total: slides.length })} aria-current={i === slide ? "step" : undefined} className={`ob-dot ${i === slide ? 'active' : ''}`} onClick={() => setSlide(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSlide(i); } }} />
        ))}
      </div>
      <button className="ob-btn" onClick={() => isLast ? onDone() : setSlide(slide + 1)}>
        {isLast ? t("tut.done") : t("intro.next")}
      </button>
      {!isLast && <button className="ob-skip" onClick={onDone}>{t("tut.skip")}</button>}
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

// Full-screen overlays behave as dialogs: focus moves in when one opens, Tab stays
// inside it, Escape closes it (when it can be closed) and focus goes back to where
// it was. Keyboard and screen-reader users used to tab out into the screen behind.
export function useDialog(onClose, label) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement;
    // Read the element at each key press: a dialog that swaps its own view (admin's
    // wallet detail) renders a new root element under the same ref.
    const focusables = (el) => [...el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter((n) => !n.disabled && n.getClientRects().length > 0);
    if (ref.current) (focusables(ref.current)[0] || ref.current).focus({ preventScroll: true });
    const onKey = (e) => {
      const el = ref.current;
      if (!el) return;
      // Only for the topmost dialog: one opened on top of this one holds the focus.
      const active = document.activeElement;
      if (!(el.contains(active) || active === document.body || !active)) return;
      if (e.key === "Escape" && closeRef.current) { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = focusables(el);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); try { if (before && document.contains(before)) before.focus({ preventScroll: true }); } catch { /* gone */ } };
  }, []);
  return { ref, role: "dialog", "aria-modal": "true", "aria-label": label, tabIndex: -1 };
}

// A QR code of this page, for moving from a computer to a phone. The encoder is
// only loaded on a computer.
function PhoneQr({ T }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    import("qrcode")
      .then((m) => (m.default || m).toDataURL(window.location.origin + window.location.pathname, { margin: 1, width: 360, color: { dark: "#14301f", light: "#ffffff" } }))
      .then((u) => { if (live) setSrc(u); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return src
    ? <img src={src} alt={t("v.qrAlt")} width={180} height={180} style={{ display: "block", margin: "0 auto 12px", borderRadius: 8, border: `1px solid ${T.border}` }} />
    : <div className="vz-icon">📱</div>;
}

// Full-screen "align the reading" step: the user drags/resizes a box over the
// meter's digits, and only that region is handed to OCR — exactly how purpose-built
// meter apps avoid reading barcodes/serials/nameplate text. Returns a cropped Blob
// (or null = use the whole photo) to the caller.
function MeterCropper({ imgUrl, onCancel, onConfirm }) {
  const dlg = useDialog(onCancel, t("v.align"));
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
  // Rendered on document.body: inside the screen's own stacking context (.z1) the
  // bottom nav was drawn over it, covering "Retake" on short phones. Solid, so the
  // form behind doesn't show through.
  return createPortal(
    <div {...dlg} style={{position:"fixed",inset:OVERLAY_INSET,background:"#0a120e",zIndex:360,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{color:"#fff",fontSize:14,fontWeight:800,marginBottom:4,textAlign:"center"}}>{t("v.align")}</div>
      <div style={{color:"rgba(255,255,255,0.7)",fontSize:11,marginBottom:14,textAlign:"center"}}>{t("v.align.long")}</div>
      <div style={{position:"relative",maxWidth:"100%",maxHeight:"60vh",touchAction:"none"}}>
        <img ref={imgRef} src={imgUrl} onLoad={onImgLoad} alt="" draggable={false}
          style={{display:"block",maxWidth:"100%",maxHeight:"60vh",userSelect:"none",pointerEvents:"none",borderRadius:6}} />
        {box && (
          <div onPointerDown={onDown("move")}
            style={{position:"absolute",left:box.x,top:box.y,width:box.w,height:box.h,border:"2px solid #4CAF50",boxShadow:"0 0 0 9999px rgba(0,0,0,0.5)",borderRadius:6,cursor:"move",touchAction:"none"}}>
            <div onPointerDown={onDown("resize")}
              style={{position:"absolute",right:-13,bottom:-13,width:28,height:28,borderRadius:"50%",background:"#4CAF50",border:"2px solid #fff",cursor:"nwse-resize",touchAction:"none"}} />
          </div>
        )}
      </div>
      <div style={{display:"flex",gap:10,marginTop:20,width:"100%",maxWidth:340}}>
        <button onClick={()=>onConfirm(null)} style={{...btn,border:"1px solid rgba(255,255,255,0.3)",background:"transparent",color:"#fff"}}>{t("v.whole")}</button>
        <button onClick={scan} style={{...btn,flex:2,border:"none",background:"#2E7D32",color:"#fff"}}>{t("v.scan")}</button>
      </div>
      <button onClick={onCancel} style={{marginTop:12,minHeight:44,padding:"0 16px",background:"transparent",border:"none",color:"rgba(255,255,255,0.7)",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",cursor:"pointer"}}>{t("v.retake")}</button>
    </div>,
    document.body,
  );
}

function VerifyZone({ utilId, onVerified, onReset, onOcrReading, reading, prevRead, subs, meterNo, T }) {
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null);
  const [aiStep, setAiStep] = useState(0);
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileInputRef = useRef(null);
  const origFileRef = useRef(null);
  const cooldownMs = getCooldownRemaining(utilId);
  // Re-render while the cooldown runs: the countdown only moved when something else
  // re-rendered, and the photo box could stay locked after the cooldown had ended.
  const [, setCdTick] = useState(0);
  const coolingDown = cooldownMs > 0;
  useEffect(() => {
    if (!coolingDown) return undefined;
    const id = setInterval(() => setCdTick((x) => x + 1), Math.min(30000, Math.max(1000, cooldownMs + 500)));
    return () => clearInterval(id);
  }, [coolingDown, cooldownMs]);

  // Release the preview object URL when it changes or the component unmounts.
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  // Leaving this zone (another tab, the eco card, the reader view) throws its photo
  // away, so the verified state that enables Submit has to go with it — otherwise
  // the zone says "Tap to photograph" while Submit is still enabled.
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  // Verification takes seconds (OCR, the server call). Each run gets a number; a
  // reset or unmount moves it on, so a run that finishes for a zone that is gone
  // (another tab, another meter) or was reset doesn't mark a photo as verified.
  const runIdRef = useRef(0);
  useEffect(() => () => { runIdRef.current++; onResetRef.current?.(); }, []);
  // The parent's latest callbacks, not the ones from when the run started: the
  // OCR autofill has to see what was typed (or switched on) in the meantime.
  const onOcrReadingRef = useRef(onOcrReading);
  onOcrReadingRef.current = onOcrReading;
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const runVerify = async (file, ocrSource) => {
    const runId = ++runIdRef.current;
    const stale = () => runIdRef.current !== runId;
    setPhase("verifying"); setAiStep(0);
    let mime, base64;
    try {
      const upload = await uploadablePhoto(file);
      mime = upload.type;
      // Reject on read errors too — without onerror a failed read leaves the promise
      // unsettled and the UI stuck on "verifying" with no way out but a reload.
      base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(r.error || new Error("could not read the photo"));
        r.readAsDataURL(upload);
      });
    } catch {
      if (stale()) return;
      setResult({ summary: t("v.unreadable") });
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
      fraudReason = t("v.duplicate");
    }

    setAiStep(1);
    const fileMeta = checkFileMeta(file);
    if (!fileMeta.ok) fraudFlags.push(...fileMeta.flags);

    setAiStep(2);
    const ssCheck = await detectScreenshot(base64, mime);
    if (ssCheck.isScreenshot) { fraudFlags.push("screenshot_detected"); fraudReason = fraudReason || t("v.screenshot"); }

    setAiStep(3);
    // OCR runs on the cropped region (if the user boxed the reading) so it ignores
    // barcodes/serials/nameplate text; all fraud checks above use the full photo.
    const ocrResult = await runOCR(ocrSource || file, reading, utilId);
    if (stale()) return;
    // Pre-fill Current from the photo — but only with a number that makes sense
    // against your previous reading (a real new reading sits just above it). This
    // rejects barcodes/serials/"0" the OCR picks off the nameplate; if nothing is
    // convincing the field stays empty rather than filled with a wrong number.
    const guess = pickPlausibleReading(ocrResult.ocrNums || [], { utilId, prevRead, preferred: ocrResult.ocrBest });
    // Only auto-fill when we're reasonably sure: either it lines up with your
    // previous reading (anchored), or the OCR read it with decent confidence.
    // Otherwise leave Current blank — better to type it than to fight a wrong guess.
    const hasAnchor = Number.isFinite(parseFloat(prevRead));
    if (guess != null && (hasAnchor || (ocrResult.ocrConfidence || 0) >= 60)) onOcrReadingRef.current?.(String(guess));
    if (!ocrResult.matched && !ocrResult.ocrFailed) {
      fraudFlags.push("ocr_mismatch");
      fraudReason = fraudReason || ocrResult.reason;
    }

    // Meter-number check (lenient): is the registered meter number visible on the
    // FULL photo? Found = extra confidence; not found = flag for review (never block
    // — serials are small and hard to read). null when there's no number to check.
    let meterNoConfirmed = null;
    if (meterNo) meterNoConfirmed = meterNoMatches(meterNo, await ocrFullText(file));
    if (stale()) return;

    // Plausibility/anomaly run on CONSUMPTION (current − previous), not the
    // absolute meter value, otherwise a normal reading like 3847 always trips.
    const r = parseFloat(reading), p = parseFloat(prevRead);
    const usageVal   = (Number.isFinite(r) && Number.isFinite(p) && r >= p) ? +(r - p).toFixed(2) : null;
    const plausCheck = usageVal != null ? checkPlausibility(utilId, usageVal) : { ok:true };
    const lastOfUtil = subs.filter(s => s.type === utilId && s.submittedAt).reduce((m, s) => Math.max(m, s.submittedAt), 0);
    const anomCheck  = usageVal != null ? checkAnomaly(utilId, usageVal, subs, lastOfUtil ? spanDays(Date.now() - lastOfUtil) : 1) : { ok:true, anomaly:false };
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

    if (hashOk) rememberHash(imgHash);

    // The client check is a UX pre-filter, not the gate — the server re-verifies
    // every photo (real image + authoritative hash dedupe) before paying out. So
    // only a genuine REUSED photo blocks here. Other heuristics (old-file age,
    // screenshot guess, OCR mismatch, anomaly) false-positive on real phone photos,
    // so they no longer stop the submission — they ride along as soft review flags.
    const blocked  = isDuplicate;
    const verified = !blocked;
    const softFlags = fraudFlags.filter(f => f !== "duplicate_photo");
    const meterNote = meterNoConfirmed === true ? t("v.meterOk")
      : meterNoConfirmed === false ? t("v.meterTip")
      : "";
    const summary  = blocked
      ? (fraudReason || t("v.retakeGeneric"))
      : `${t("v.accepted", { n: meterNo ? ` #${meterNo}` : "" })}${softFlags.length ? "" : ` ${ocrResult.ocrNums?.length ? t("v.read", { nums: ocrResult.ocrNums.slice(0,2).join(", ") }) : t("v.readingOk")}`}${meterNote}`;

    const finalResult = { verified, fraudFlags, fraudReason, summary, ocrNums: ocrResult.ocrNums, ocrFailed: !!ocrResult.ocrFailed, meterNoConfirmed, secScore: score, anomCheck, usageVal };
    setResult(finalResult);
    setPhase(verified ? "verified" : "error");
    if (verified) onVerifiedRef.current?.(finalResult, base64, mime);
  };

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    e.target.value = "";
    // Freshness gate: a camera capture is seconds old. A file that is verifiably
    // older was picked from the gallery or downloaded (where AI-generated images
    // come from) — reject it and ask for a live shot.
    if (photoTooOld(file)) {
      setResult({ summary: t("v.old") });
      setPhase("error");
      return;
    }
    origFileRef.current = file;
    setPhotoUrl(URL.createObjectURL(file));   // show a preview of what was captured
    setPhase("crop");                          // let the user box the reading first
  };

  const reset = () => { runIdRef.current++; setPhase("idle"); setResult(null); setPhotoUrl(null); origFileRef.current = null; onReset(); };

  // Desktop has no phone camera — and a file picker invites downloaded or
  // AI-generated images. Block capture entirely outside a mobile browser.
  // It used to stop there: a dead end on a computer, with nothing to take the user
  // to their phone. A QR code of this page does.
  if (phase === "idle" && !IS_MOBILE) return (
    <div className="verify-zone" style={{cursor:"default"}}>
      <div className="vz-idle">
        <PhoneQr T={T} />
        <div className="vz-title">{t("v.phone.t")}</div>
        <div className="vz-sub">{t("v.phone.d")}</div>
      </div>
    </div>
  );

  if (phase === "idle") {
    const body = (
      <div className="vz-idle">
        <div className="vz-icon">{cooldownMs > 0 ? "⏳" : "📸"}</div>
        <div className="vz-title">{t("v.title")}</div>
        {meterNo && <div className="vz-meter">{t("v.meter", { n: meterNo })}</div>}
        <div className="vz-sub">{cooldownMs > 0 ? t("v.next", { time: fmtCooldown(cooldownMs) }) : t("v.tap")}</div>
      </div>
    );
    // During the cooldown there is nothing to open, so this is a plain box that says
    // so — rather than a control that looks tappable and then does nothing at all.
    if (cooldownMs > 0) return <div className="verify-zone" style={{cursor:"default"}}>{body}</div>;
    return (
      <label className="verify-zone" htmlFor="gul-meter-photo" style={{display:"block"}}>
        {body}
        <input id="gul-meter-photo" type="file" ref={fileInputRef} onChange={handleFile}
          accept="image/*" capture="environment" style={HIDDEN_FILE_INPUT} />
      </label>
    );
  }

  if (phase === "crop" && photoUrl) return (
    <>
      <div className="verify-zone">
        <div className="vz-idle">
          <div className="vz-icon">✂️</div>
          <div className="vz-title">{t("v.align")}</div>
          <div className="vz-sub">{t("v.align.short")}</div>
        </div>
      </div>
      <MeterCropper imgUrl={photoUrl} onCancel={reset} onConfirm={(cropBlob) => runVerify(origFileRef.current, cropBlob)} />
    </>
  );

  if (phase === "verifying") return (
    <div className="verify-zone">
      <div className="vz-verifying">
        {photoUrl && <img className="vz-photo sm" src={photoUrl} alt={t("v.captured")} />}
        <div className="ai-ring"/>
        <div className="ai-steps">
          {t("v.steps").split("|").map((s, i) => (
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
        {photoUrl && <img className="vz-photo" src={photoUrl} alt={t("v.captured")} />}
        <div style={{fontSize:12,fontWeight:700,color:T?.gas||"#7a1c1c",marginBottom:8}}>{t("v.failed")}</div>
        <div style={{fontSize:11,color:T?.textMid||"#666",marginBottom:12}}>{result.summary}</div>
        <div role="button" tabIndex={0} className="vr-retry" onClick={reset}>{t("v.tryAgain")}</div>
      </div>
    </div>
  );

  if (phase === "verified" && result) return (
    <div className="verify-zone verified">
      <div className="vz-result">
        {photoUrl && <img className="vz-photo" src={photoUrl} alt={t("v.captured")} />}
        <div className="vr-header">
          <div className="vr-badge">{t("v.ok")}</div>
          <div className="vr-confidence">{t("v.score", { n: result.secScore })}</div>
        </div>
        <div className="vr-summary">{result.summary}</div>
        {result.anomCheck?.anomaly && (
          <div style={{marginTop:12,padding:10,background:T?.electricBg||"#fff3e0",border:`1px solid ${T?.electricBorder||"#FFB74D"}`,borderRadius:6}}>
            <div style={{fontSize:11,fontWeight:700,color:T?.electric||"#E65100"}}>{t("v.high.t")}</div>
            <div style={{fontSize:10,color:T?.textMid||"#666",marginTop:4}}>{result.anomCheck.avg ? t("v.high.pct", { pct: Math.round((result.usageVal/result.anomCheck.avg - 1)*100) }) : t("v.high.any")}</div>
            <div style={{fontSize:10,color:T?.electric||"#E65100",marginTop:4,fontWeight:600}}>{t("v.high.ok")}</div>
          </div>
        )}
        <div role="button" tabIndex={0} className="vr-retry tap44" onClick={reset} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reset(); } }}>{t("v.retakePhoto")}</div>
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
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - ((firstDay.getDay() + 6) % 7)); // weeks start on Monday, like the header

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
        <div className="cal-month">{today.toLocaleString(getLang(), { month: 'long' })} {year}</div>
        <div className="cal-streak">{t("cal.streak", { n: currentStreak })}</div>
      </div>
      <div className="cal-days-hdr">
        {weekdayInitials().map((d, i) => <div key={i} className="cal-day-name">{d}</div>)}
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
  // A row without a previous reading (older automatic claims) has no usage to show:
  // a dash, not "NaN kWh".
  const used = parseFloat(s.cur) - parseFloat(s.prev);
  const delta = isEco
    ? (ECO_APPLIANCE_LABELS[s.appliance] || "Eco run")
    : (Number.isFinite(used) ? used.toFixed(2) : "—");
  // Tapping a paid submission opens the real transaction on the block explorer —
  // one-tap on-chain proof (VeWorld's own Activity tab won't show these, because
  // the user's wallet never signs the payout; the distributor does).
  const txUrl = s.txHash ? `${EXPLORER}/transactions/${s.txHash}` : null;
  return (
    <div role="button" tabIndex={0} className="hitem" onClick={() => { if (txUrl) window.open(txUrl, "_blank", "noopener"); }}
      style={txUrl ? { cursor: "pointer" } : undefined}
      title={txUrl ? t("h.viewTx") : undefined}>
      <div className="hicon" style={{background: getColorBg(s.type, T), color: T[s.type] || T.electric}}>{UTIL_ICONS[s.type]}</div>
      <div className="hinfo">
        {/* What was used, then when — the meter number only as its last digits,
            so rows line up instead of wrapping on a 17-character number. */}
        <div className="htitle">{utilName(s.type)} · <span style={{textTransform:"none",letterSpacing:0,fontWeight:700,color:T.textMid}}>{delta}{util.unit && delta !== "—" ? ` ${util.unit}` : ""}</span></div>
        <div className="hdate">{fmtDay(s.date)}{s.meterNo ? <span title={s.meterNo}> · {t("h.meter", { n: String(s.meterNo).slice(-4) })}</span> : null}{txUrl ? <span> · tx ↗</span> : null}</div>
      </div>
      {/* A reading recorded without a reward (no kWh saved, or a first reading) has
          no amount to show; a failed payout's amount was never received. */}
      <div className="hright" title={s.status === "recorded" ? (s.note || t("h.recordedNote")) : undefined}>
        {s.status === "recorded"
          ? <div className="hb3tr" style={{ color: T.textSoft }}>—</div>
          : <div className="hb3tr" style={s.status === "failed" ? { color: T.textSoft, textDecoration: "line-through" } : undefined}>+{parseFloat(s.b3tr).toFixed(2)} <span style={{ fontSize: 10, fontWeight: 700 }}>B3TR</span></div>}
        <div className={`hstatus s-${s.status}`}>{["confirmed", "pending", "failed", "recorded"].includes(s.status) ? t(`h.st.${s.status}`) : s.status}</div>
      </div>
    </div>
  );
}

// "today 19:13", "yesterday 08:52", "tomorrow 15:20", else "8 Oct 15:20".
export function fmtWhen(ts) {
  const d = new Date(ts), now = new Date();
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const time = d.toLocaleTimeString(getLang(), { hour: "2-digit", minute: "2-digit" });
  if (dayDiff === 0) return t("when.today", { time });
  if (dayDiff === -1) return t("when.yesterday", { time });
  if (dayDiff === 1) return t("when.tomorrow", { time });
  return `${fmtDay(ts)} ${time}`;
}
const subTs = (s) => s.submittedAt || localDayTs(s.date) || 0;

// Today at a glance: what was paid, when the next reward can come, whether the
// reader is alive, and the week — the questions behind "my reading wasn't sent".
function TodayPanel({ subs, wallet, setTab, onOpenReader, T }) {
  const [reader, setReader] = useState(null); // null = not asked; { paired, fresh, at }
  useEffect(() => {
    // Cleared first: a failed lookup for a new wallet left the previous one's reader
    // on screen.
    setReader(null);
    if (!wallet) return;
    let stop = false;
    let token = "";
    try { token = localStorage.getItem(`gul_mtoken_${wallet.toLowerCase()}`) || ""; } catch { /* no storage */ }
    if (!validDeviceToken(token)) token = "";
    fetchT(`${REWARD_API.replace(/\/$/, "")}/meter/latest?address=${wallet}`, token ? { headers: { "x-device-token": token } } : undefined)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (stop || !d) return;
        const at = d.reading?.at || d.lastPayout?.at || 0;
        setReader({ paired: !!d.paired, needsToken: !!d.needsToken, at, fresh: !!at && Date.now() - at < 48 * 3600e3 });
      })
      .catch(() => {});
    return () => { stop = true; };
  }, [wallet]);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - ((now.getDay() + 6) % 7) * 86400000;     // Monday
  const paid = (subs || []).filter(s => s.status === "confirmed" && (Number(s.b3tr) || 0) > 0);
  const today = paid.filter(s => subTs(s) >= todayStart);
  const todayB3tr = today.reduce((a, s) => a + (Number(s.b3tr) || 0), 0);
  const lastToday = today.reduce((m, s) => (subTs(s) > subTs(m || {}) ? s : m), null);
  const initials = weekdayInitials();
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = weekStart + i * 86400000;
    const v = paid.filter(s => s.type !== "eco" && subTs(s) >= start && subTs(s) < start + 86400000).reduce((a, s) => a + (Number(s.b3tr) || 0), 0);
    return { label: initials[i], name: new Date(start).toLocaleDateString(getLang(), { weekday: "long" }), v, past: start < todayStart, isToday: start === todayStart };
  });
  const weekB3tr = paid.filter(s => subTs(s) >= weekStart).reduce((a, s) => a + (Number(s.b3tr) || 0), 0);
  const weekDays = days.filter(d => d.v > 0).length;
  const missed = days.filter(d => d.past && d.v === 0 && paid.some(s => s.type !== "eco" && subTs(s) < weekStart + days.indexOf(d) * 86400000));
  const nextAt = Object.prototype.hasOwnProperty.call(SERVER_NEXT_AT, "electric")
    ? (Number(SERVER_NEXT_AT.electric) || 0)
    : (() => { const last = paid.filter(s => s.type === "electric").reduce((m, s) => Math.max(m, subTs(s)), 0); return last ? last + RULES.cooldownMs : 0; })();
  const max = Math.max(1, ...days.map(d => d.v));
  const card = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px" };
  const label = { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft };

  if (!wallet) return null;
  return (
    <div style={{ margin: "0 14px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ background: T.heroFrom, border: T === DARK ? `1px solid ${T.border}` : "none", borderRadius: 10, padding: "16px", color: "#fff" }}>
        <div style={{ ...label, color: "rgba(255,255,255,.7)" }}>{t("today.title")}</div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginTop: 6 }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-.5px" }}>
            {todayB3tr > 0 ? `+${todayB3tr.toFixed(2)}` : "—"} <span style={{ fontSize: 13, fontWeight: 700 }}>B3TR</span>
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.75)", textAlign: "right", lineHeight: 1.4 }}>
            {lastToday ? <>{t("today.paid", { time: new Date(subTs(lastToday)).toLocaleTimeString(getLang(), { hour: "2-digit", minute: "2-digit" }) })}<br />{lastToday.type === "eco" ? "eco bonus" : t("today.reading")}</> : t("today.nothing")}
          </div>
        </div>
        <div style={{ height: 1, background: "rgba(255,255,255,.18)", margin: "12px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
          <span style={{ color: "rgba(255,255,255,.75)" }}>{t("today.next")}</span>
          <span style={{ fontWeight: 800 }}>{nextAt > Date.now() ? fmtWhen(nextAt) : t("today.now")}</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
        <button type="button" onClick={onOpenReader} style={{ ...card, textAlign: "left", cursor: "pointer", font: "inherit", color: T.text }}>
          <div style={{ ...label, display: "flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: !reader?.paired ? T.border : reader.fresh || reader.needsToken ? T.green3 : T.electric }} />
            {t("today.reader")}
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, marginTop: 6 }}>
            {!reader ? "…" : !reader.paired ? t("today.reader.none") : reader.needsToken ? t("today.reader.ok") : reader.fresh ? t("today.reader.ok") : t("today.reader.stale")}
          </div>
          <div style={{ fontSize: 10.5, color: T.textSoft, marginTop: 2 }}>
            {!reader?.paired ? t("today.reader.setup") : reader.at ? t("today.reader.last", { when: fmtWhen(reader.at) }) : t("today.reader.other")}
          </div>
        </button>
        <div style={card}>
          <div style={label}>{t("today.week")}</div>
          <div style={{ fontSize: 14, fontWeight: 800, marginTop: 6, color: T.text }}>{weekB3tr.toFixed(2)} B3TR</div>
          <div style={{ fontSize: 10.5, color: T.textSoft, marginTop: 2 }}>{t("today.weekDays", { n: weekDays })}</div>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={label}>{t("today.daily")}</span><span style={{ ...label, letterSpacing: ".4px" }}>{initials[0]} – {initials[6]}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 6, alignItems: "end", height: 72, marginTop: 10 }}>
          {days.map((d, i) => (
            <div key={i} title={`${d.name}: ${d.v.toFixed(2)} B3TR`} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 4, height: "100%" }}>
              <div style={{ width: "100%", borderRadius: 6, height: d.v > 0 ? Math.round(10 + (d.v / max) * 42) : 4, background: d.v > 0 ? (T.green3 || T.eco) : T.border, outline: d.isToday ? `2px solid ${T.green4 || T.border}` : "none", outlineOffset: 2 }} />
              <div style={{ fontSize: 10, fontWeight: d.isToday ? 800 : 700, color: d.isToday ? T.text : T.textSoft }}>{d.label}</div>
            </div>
          ))}
        </div>
        {missed.length > 0 && (
          <div style={{ fontSize: 10.5, color: T.textSoft, marginTop: 8, lineHeight: 1.5 }}>
            {t("today.missed", { days: missed.map(d => d.name).join(", ") })}
          </div>
        )}
      </div>

    </div>
  );
}

function HomeScreen({ b3tr, walletB3tr, streak, subs, setTab, wallet, onOpenReader, T }) {
  return (
    <>
      <div className="sub-header">
        <div className="sub-title">{t("home.title")}</div>
        <div className="sub-sub">{t("home.sub")}</div>
      </div>

      {/* A new user landed here after registering to an empty dashboard — "— B3TR",
          an empty chart, a blank calendar — with nothing pointing at the one thing
          to do next. Until the first reading, that is the first thing on Home. */}
      {!(subs || []).some(x => x.type !== "eco") && (
        <div style={{ margin: "0 14px 14px", padding: "18px 16px", borderRadius: 10, background: `linear-gradient(135deg,${T.heroFrom},${T.heroTo})`, color: "#fff" }}>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>{t("home.first.t")}</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "rgba(255,255,255,0.85)", marginBottom: 14 }}>
            {t("home.first.d")}
          </div>
          <button className="intro-btn" style={{ marginTop: 0, maxWidth: "none" }} onClick={() => setTab("submit")}>{t("home.first.cta")}</button>
        </div>
      )}

      <TodayPanel subs={subs} wallet={wallet} setTab={setTab} onOpenReader={onOpenReader} T={T} />
      
      <div className="hero">
        <div className="hero-label">{t("home.total")}</div>
        <div className="hero-amount">{b3tr.toFixed(2)}<span>B3TR</span></div>
        <div className="hero-usd">{walletB3tr != null ? t("home.inWallet", { amount: walletB3tr.toFixed(2) }) : ""}{NETWORK === "mainnet" ? t("home.powered") : t("home.testBeta")}</div>
        <div className="hero-chips">
          <div className="hchip"><div className="hchip-val">{streak}</div><div className="hchip-key">{t("home.streak")}</div></div>
          <div className="hchip"><div className="hchip-val">{subs.length}</div><div className="hchip-key">{t("home.subs")}</div></div>
        </div>
      </div>

      {/* With a single utility this whole block restates the tiles above — one card
          reading "1 readings logged / +0.00 B3TR" next to "Submissions: 1" and
          "Total B3TR: 0.00". A heading over one permanent item isn't navigation.
          It comes back on its own as soon as a second meter is enabled in UTILS. */}
      {UTILS.length > 1 && (<>
      <div className="sec"><div className="sec-line"/><div className="sec-txt">{t("home.utilities")}</div><div className="sec-line"/></div>
      <div className="util-grid">
        {UTILS.map(u => {
          const myS = subs.filter(s => s.type === u.id);
          const tot = myS.reduce((a,s) => a+(parseFloat(s.b3tr)||0), 0);
          return (
            <div role="button" tabIndex={0} key={u.id} className="ucard" onClick={() => setTab("progress")}>
              <div className="ucard-icon" style={{background:getColorBg(u.id, T),border:`1px solid ${T[u.id+"Border"]||T.green4}`,color:T[u.id]||T.green2}}>{UTIL_ICONS[u.id]}</div>
              <div className="ucard-name">{u.label}</div>
              <div className="ucard-reads">{t("home.readingsLogged", { n: myS.length })}</div>
              <div className="ucard-b3tr" style={{color:T[u.id]||T.electric}}>+{tot.toFixed(2)} B3TR</div>
            </div>
          );
        })}
      </div>
      </>)}

      <div className="sec"><div className="sec-line"/><div className="sec-txt">{t("home.activity")}</div><div className="sec-line"/></div>
      <StreakCalendar subs={subs} />

      <div className="sec"><div className="sec-line"/><div className="sec-txt">{t("home.recent")}</div><div className="sec-line"/></div>
      {subs.slice(0,3).map(s => <HistItem key={s.id} s={s} T={T} />)}
      {/* The full history had no way in: no nav item or link opened it. */}
      {subs.length > 3 && (
        <button onClick={() => setTab("history")} style={{display:"block",margin:"4px auto 12px",background:"transparent",border:"none",color:T.green3,fontSize:12,fontWeight:700,cursor:"pointer",padding:"10px 16px"}}>
          {t("home.seeAll", { n: subs.length })}
        </button>
      )}
    </>
  );
}

// A device token is 24 random bytes in hex (server: /meter/pair). The token goes
// into shell commands and YAML the user pastes, so anything else — a tampered
// localStorage entry, an odd server answer — is never rendered or sent.
export const validDeviceToken = (t) => /^[0-9a-f]{48}$/.test(String(t || ""));

function SubmitScreen({ rewardFactor = 1, u, selUtil, setSelUtil, aiOk, setAiOk, setPhoto, reading, setReading, prevRead, setPrevRead,
  dualTariff, setDualTariff, regLow, setRegLow, regNormal, setRegNormal, photoRegister,
  fixBasis, fixBusy, runFixBasis, dismissFixBasis, busy, usage, reward, days, handleSubmit, verifyKey, wallet, setShowWallet, subs, meters, T, setTab, onMeterAutoSubmit, meterAutoBusy, onRegisterMeter, startOnReader = false, onStartedReader }) {
  const meterNo  = (meters?.[selUtil] || "").trim();
  // Submittable when current ≥ previous (equal = zero usage = valid, max reward).
  const _r = parseFloat(reading), _p = parseFloat(prevRead);
  const readingReady = Number.isFinite(_r) && Number.isFinite(_p) && _r >= _p;
  const readingLower = Number.isFinite(_r) && Number.isFinite(_p) && _r < _p;

  // Returning users already have a known previous reading (auto-filled from their
  // last submission). Show it as a compact chip and ask for only the CURRENT value,
  // instead of two number fields — fewer inputs, fewer typos. First-timers (no
  // history for this meter) still get the editable "Previous" field.
  const [editPrev, setEditPrev] = useState(false);
  useEffect(() => { setEditPrev(false); }, [selUtil]); // switching meters resets the chip
  const lastSub = (subs || []).find(s => s.type === selUtil && s.status !== "failed" && Number.isFinite(parseFloat(s.cur)));
  const lastKnown = lastSub ? String(lastSub.cur) : "";
  const knowPrev = !!lastKnown && !editPrev;
  const [tipsOpen, setTipsOpen] = useState(false); // photo tips collapsed by default
  // Two clearly-offered ways to submit a meter reading: a photo, or type it / connect
  // a reader. The type/reader path (auto meter ingestion) is electricity-only, so for
  // other utilities we show only the photo path.
  const autoAvailable = selUtil === "electric";
  const [method, setMethod] = useState(startOnReader && autoAvailable ? "type" : "photo"); // "photo" | "type"
  useEffect(() => { if (!autoAvailable) setMethod("photo"); }, [autoAvailable]);
  useEffect(() => { if (startOnReader) onStartedReader?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Most people never connect a reader, so don't make everyone choose between two
  // methods. The Photo/Auto switch only appears once a reader has actually been
  // paired (its device token is cached); otherwise the default path is just Photo,
  // with a quiet link at the bottom for anyone who wants to set a reader up.
  const hasReader = (() => {
    try { return validDeviceToken(localStorage.getItem(`gul_mtoken_${String(wallet || "").toLowerCase()}`)); } catch { return false; }
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
        <div className="sub-title">{t("m.title")}</div>
        <div className="sub-sub">{t("m.sub")}</div>
      </div>

      {TURNSTILE_SITE_KEY && <div id="cf-turnstile" style={{display:"flex",justifyContent:"center",margin:"0 0 12px"}} />}

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

      <div role="button" tabIndex={0} onClick={() => { if (!meterNo) onRegisterMeter?.([selUtil]); }}
        style={{margin:"0 14px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"9px 12px",background:meterNo?getColorBg(selUtil,T):T.gasBg,border:`1px solid ${meterNo?(T[selUtil+"Border"]||T.electricBorder):T.gasBorder}`,borderRadius:6,cursor:meterNo?"default":"pointer"}}>
        <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft}}>{t("m.registered")}</div>
        <div style={{fontSize:12,fontWeight:700,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:meterNo?(T[selUtil]||T.text):T.gas}}>{meterNo || t("m.tapRegister")}</div>
      </div>

      {/* Method switch only once a reader exists — otherwise there's nothing to choose.
          It also appears while the reader view is open, so there's always a way back. */}
      {(showMethodSwitch || method === "type") && (
        <div style={{display:"flex",gap:8,margin:"0 14px 12px"}}>
          <button onClick={() => setMethod("photo")} style={methodBtn(method === "photo")}>{t("m.method.photo")}</button>
          <button onClick={() => setMethod("type")} style={methodBtn(method === "type")}>{t("m.method.auto")}</button>
        </div>
      )}

      {method === "photo" ? (<>
      {/* Progress strip — at a glance: what's done, what's left, what's next. */}
      {(() => {
        const stepDefs = [
          { n: 1, label: t("m.step.photo"),   done: aiOk },
          { n: 2, label: t("m.step.reading"), done: readingReady },
          { n: 3, label: t("m.step.submit"),  done: false },
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

      {/* Which tariff register this photo has to show — said BEFORE the photo is
          taken, where it can still be acted on (the server refuses the other one). */}
      {photoRegister && (
        <div role="note" style={{display:"flex",gap:10,alignItems:"flex-start",margin:"0 14px 12px",padding:"11px 12px",background:T.electricBg||T.bgAlt,border:`1px solid ${T.electricBorder||T.border}`,borderRadius:10}}>
          <span aria-hidden="true" style={{fontSize:16,lineHeight:"20px"}}>📸</span>
          <div style={{fontSize:12,color:T.text,lineHeight:1.5}}>
            <b>{t("m.register.photo", { reg: photoRegister === 1 ? t("m.register.low") : photoRegister === 2 ? t("m.register.normal") : t("m.register.n", { n: photoRegister }) })}</b>{" "}
            {t("m.register.wait")}
          </div>
        </div>
      )}

      <div id="gul-photo-step">
      <VerifyZone key={verifyKey} utilId={selUtil} reading={reading} prevRead={prevRead} subs={subs} meterNo={meterNo} T={T}
        // Only into an EMPTY field, judged when OCR finishes (functional update), so a
        // number typed during OCR stays. Never with two tariff registers: there
        // `reading` is their sum, and one register off the photo isn't that.
        onOcrReading={(v) => { if (!dualTariff) setReading(prev => (String(prev ?? "").trim() ? prev : String(v))); }}
        onVerified={(res, img, mime) => { setAiOk(true); setPhoto?.(img ? { base64: img, mime, ocrNums: res?.ocrNums || [], ocrFailed: !!res?.ocrFailed, meterNoConfirmed: res?.meterNoConfirmed ?? null } : null); }}
        onReset={() => { setAiOk(false); setPhoto?.(null); }} />
      </div>

      <div className="form-card" style={{"--uc":T[u.id]||T.electric,"--ubg":getColorBg(u.id, T),"--uborder":T[u.id+"Border"]||T.electricBorder,marginTop:14}}>
        {/* A double-tariff meter — the normal case in the Netherlands and Belgium —
            keeps two registers and CYCLES its display, so no photo can ever show
            their sum. Telling people to "enter the total" was therefore asking for a
            number that is nowhere on their meter. They enter each register instead
            and the app adds them up; the photo only has to show one of the two. */}
        {u.id === "electric" && (
          <div style={{ margin: "2px 0 12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, cursor: "pointer", fontSize: 13, fontWeight: 700, color: T.text }}>
              <input type="checkbox" style={{ width: 22, height: 22, flexShrink: 0, accentColor: T.green2 }} checked={!!dualTariff} onChange={e => { setDualTariff(e.target.checked); if (!e.target.checked) { setRegLow(""); setRegNormal(""); setReading(""); } }} />
              {t("m.dual")}
            </label>
            {dualTariff ? (
              <>
                <div className="irow" style={{ marginTop: 8 }}>
                  <div className="igroup">
                    <div className="ilabel">{t("m.dual.reading")} <span className="utag">1.8.1</span></div>
                    <input className="ifield" type="text" inputMode="decimal" autoComplete="off" placeholder="3852.104"
                      value={regLow} onChange={e => setRegLow(normDecimal(e.target.value))} />
                  </div>
                  <div className="igroup">
                    <div className="ilabel">{t("m.dual.reading")} <span className="utag">1.8.2</span></div>
                    <input className="ifield" type="text" inputMode="decimal" autoComplete="off" placeholder="3853.410"
                      value={regNormal} onChange={e => setRegNormal(normDecimal(e.target.value))} />
                  </div>
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: T.textSoft }}>
                  {t("m.dual.total")}{" "}
                  <b style={{ fontFamily: "'SF Mono',Menlo,monospace", color: T.text }}>{reading || "—"}</b> {u.unit}
                  <span style={{ display: "block", marginTop: 3, fontSize: 10.5, lineHeight: 1.5 }}>
                    {t("m.dual.explain")}
                  </span>

                </div>
              </>
            ) : (
              <div style={{ marginTop: 5, fontSize: 10.5, color: T.textSoft, lineHeight: 1.5 }}>
                {t("m.dual.hint")}
              </div>
            )}
          </div>
        )}
        {/* Shown only after a submission was refused specifically because the stored
            starting point covers one tariff register and the reading covers both.
            Not offered speculatively: it moves a baseline, and a baseline moved
            without cause is earnings thrown away. */}
        {fixBasis && (
          <div style={{ marginBottom: 12, padding: "11px 13px", background: T.bgAlt, border: `1px dashed ${T.border}`, borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: T.text, marginBottom: 5 }}>
              {t("m.fix.title")}
            </div>
            <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6 }}>
              {t("m.fix.text", { sum: `${fixBasis.registers.join(" + ")} = ${+(fixBasis.registers[0] + fixBasis.registers[1]).toFixed(3)}`, unit: u.unit })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 9, flexWrap: "wrap" }}>
              <button disabled={fixBusy} onClick={runFixBasis}
                style={{ padding: "9px 12px", fontSize: 12, fontWeight: 700, color: "#fff", background: T[u.id] || T.electric, border: "none", borderRadius: 6, cursor: "pointer", opacity: fixBusy ? .6 : 1 }}>
                {fixBusy ? t("m.fix.busy") : t("m.fix.go")}
              </button>
              <button disabled={fixBusy} onClick={() => dismissFixBasis?.()} style={{ background: "none", border: "none", color: T.textSoft, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                {t("m.fix.later")}
              </button>
            </div>
          </div>
        )}

        {knowPrev ? (
          <>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:12,padding:"8px 12px",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6}}>
              <div style={{fontSize:11,color:T.textSoft}}>{t("m.prev")}&nbsp;
                <span style={{fontFamily:"'SF Mono',Menlo,'Courier New',monospace",fontWeight:700,color:T.text}}>{prevRead || lastKnown} {u.unit}</span>
                <span style={{color:T.textSoft}}>{t("m.prev.from")}</span>
              </div>
              <button onClick={()=>setEditPrev(true)} style={{background:"none",border:"none",color:T.green3||T[u.id]||T.electric,fontSize:11,fontWeight:700,cursor:"pointer",padding:0}}>{t("m.edit")}</button>
            </div>
            <div className="igroup">
              <div className="ilabel">{t("m.current")} <span className="utag">{u.unit}</span></div>
              <input className="ifield" type="text" inputMode="decimal" autoComplete="off" placeholder={Number.isFinite(parseFloat(prevRead)) ? t("m.above", { n: prevRead }) : u.ph[1]} value={reading} onChange={e=>setReading(normDecimal(e.target.value))} disabled={!!dualTariff} style={{width:"100%",boxSizing:"border-box"}}/>
            </div>
          </>
        ) : (
          <div className="irow">
            <div className="igroup">
              <div className="ilabel">{t("m.prev")} <span className="utag">{u.unit}</span></div>
              <input className="ifield" type="text" inputMode="decimal" autoComplete="off" placeholder={u.ph[0]} value={prevRead} onChange={e=>setPrevRead(normDecimal(e.target.value))}/>
            </div>
            <div className="igroup">
              <div className="ilabel">{t("m.current.short")} <span className="utag">{u.unit}</span></div>
              <input className="ifield" type="text" inputMode="decimal" autoComplete="off" placeholder={Number.isFinite(parseFloat(prevRead)) ? t("m.above", { n: prevRead }) : u.ph[1]} value={reading} onChange={e=>setReading(normDecimal(e.target.value))} disabled={!!dualTariff}/>
            </div>
          </div>
        )}


        {readingReady && (() => {
          const span  = Math.min(Math.max(Number(days) > 0 ? Number(days) : 1, MIN_SPAN_DAYS), MAX_SPAN_DAYS);
          const bench = +((USAGE_BENCHMARK[u.id] ?? 0) * span).toFixed(1);
          const saved = Math.max(0, bench - usage());
          const isSaving = SAVING_UTILS.has(u.id);
          // Almost no usage pays nothing (as the server does), so the line must not
          // promise a saving it won't pay.
          const nearZero = isSaving && nearZeroUsage(u.id, usage(), days);
          const rateText = isSaving
            ? (nearZero
                ? t("m.rate.near")
                : saved > 0
                ? t("m.rate.saved", { saved: saved.toFixed(1), unit: u.unit, rate: u.rate, bench })
                : t("m.rate.none", { used: usage(), unit: u.unit, bench }))
            : `${usage()} ${u.unit} produced × ${u.rate} B3TR`;
          // Beyond this the submission cannot be paid under any span, so promising a
          // reward for it is a lie the server will contradict a moment later. The
          // usual cause is a starting point covering one tariff register against a
          // reading covering both — say that here rather than after the photo.
          const ceiling = (USAGE_RANGES[u.id]?.max ?? Infinity) * MAX_SPAN_DAYS;
          const impossible = isSaving && usage() > ceiling;
          return (<>
            {impossible ? (
              <div className="reward-preview" style={{ borderColor: "#e0a800" }}>
                <div>
                  <div className="rp-label">{t("m.impossible.t")}</div>
                  <div className="rp-rate">
                    {t("m.impossible.d", { used: usage(), unit: u.unit, max: ceiling })}
                  </div>
                </div>
              </div>
            ) : (
            <div className="reward-preview">
              <div>
                <div className="rp-label">{t("m.estimate")}</div>
                <div className="rp-rate">{subs.some(x => x.type === selUtil && x.status !== "failed")
                  ? t("m.useLess", { rate: rateText })
                  : t("m.firstSets")}</div>
                {rewardFactor < 1 && (
                  <div className="rp-rate" style={{marginTop:3}}>{t("m.shared", { pct: Math.round(rewardFactor * 100) })}</div>
                )}
                {String(reading).trim() !== "" && String(prevRead).trim() !== "" && nearZeroUsage(selUtil, usage(), days) && (
                  <div className="rp-rate" style={{marginTop:3}}>{t("m.nearZero")}</div>
                )}
              </div>
              <div style={{textAlign:"right"}}>
                <div className="rp-val">+{reward()}</div>
                <div className="rp-b3tr">B3TR</div>
              </div>
            </div>
            )}
            {/* Say the quiet part out loud: the target counts per submission, so a
                reading that covers several days is measured against a one-day
                target. Without this the maths looks broken to anyone who doesn't
                submit daily. */}
            {isSaving && (
              <div style={{fontSize:10,color:T.textSoft,lineHeight:1.5,margin:"-6px 0 12px 2px"}}>
                {span > 1
                  ? t("m.target.span", { bench, unit: u.unit, perDay: USAGE_BENCHMARK[u.id], days: span.toFixed(span % 1 ? 1 : 0) })
                  : t("m.target.day", { bench, unit: u.unit, max: MAX_SPAN_DAYS })}
              </div>
            )}
          </>);
        })()}

        {!wallet
          ? <button className="sbtn" onClick={() => setShowWallet(true)}>{t("m.btn.connect")}</button>
          : !meterNo
            ? <button className="sbtn" onClick={() => onRegisterMeter?.([selUtil])}>{t("m.btn.register")}</button>
            : !aiOk
              ? <button className="sbtn" onClick={() => document.getElementById("gul-photo-step")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  {IS_MOBILE ? t("m.btn.photo") : t("m.btn.qr")}
                </button>
              : readingLower
                ? <button className="sbtn" disabled style={{opacity:.55}}>{t("m.btn.lower")}</button>
                : !readingReady
                ? <button className="sbtn" disabled style={{opacity:.55}}>{t("m.btn.enter")}</button>
                : <button className="sbtn" disabled={busy} onClick={handleSubmit}>
                    {busy ? <><span className="spin-sm"/> {t("m.btn.busy")}</> : t("m.btn.submit")}
                  </button>
        }
      </div>

      {/* Photo tips — collapsed by default so the photo flow stays clean. */}
      <div style={{margin:"14px 14px 0"}}>
        <button onClick={() => setTipsOpen(o => !o)} style={{display:"flex",width:"100%",alignItems:"center",justifyContent:"space-between",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6,padding:"9px 12px",cursor:"pointer",color:T.textMid,fontSize:11,fontWeight:700}}>
          <span>{t("m.tips")}</span><span style={{color:T.textSoft}}>{tipsOpen ? "▲" : "▼"}</span>
        </button>
        {tipsOpen && (
          <ul style={{margin:"8px 2px 0",paddingLeft:20,fontSize:11,color:T.textSoft,lineHeight:1.7}}>
            {["m.tip1", "m.tip2", "m.tip3", "m.tip4", "m.tip5"].map((k) => <li key={k}>{t(k)}</li>)}
          </ul>
        )}
      </div>

      {/* Quiet entry point for the minority who want automatic readings — a link, not
          a competing button, so the photo CTA stays the obvious one. */}
      {autoAvailable && !hasReader && (
        <div style={{margin:"12px 14px 0",textAlign:"center"}}>
          <button onClick={() => setMethod("type")} style={{background:"none",border:"none",padding:"6px",cursor:"pointer",fontSize:11,fontWeight:700,color:T.textSoft,textDecoration:"underline"}}>
            {t("m.readerLink")}
          </button>
        </div>
      )}
      </>) : (
        <Suspense fallback={<div role="status" style={{margin:"14px",padding:"18px",textAlign:"center",fontSize:12,color:T.textSoft}}>…</div>}>
          <SmartMeterCard embedded wallet={wallet} setReading={setReading} T={T} onAutoSubmit={onMeterAutoSubmit} autoBusy={meterAutoBusy} meterNo={meterNo} />
        </Suspense>
      )}
    </>
  );
}

// CO2e grams avoided per unit saved — mirrors the server's on-chain impact model.
const CO2_PER_UNIT_UI = { electric: 400, gas: 1900, water: 0.34, solar: 400 };
const ECO_CO2_PER_CLAIM = 200;   // grams per eco-mode run (≈0.5 kWh saved)
const ECO_KWH_PER_CLAIM = 0.5;

// part: "impact" = only the three impact tiles, "charts" = only the charts below
// them (both used inside Progress); none = the whole screen.
function ChartsScreen({ subs, T, part }) {
  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const usageOf = (s) => { const u = parseFloat(s.cur) - parseFloat(s.prev); return Number.isFinite(u) && u > 0 ? +u.toFixed(2) : 0; };
  const meterSubs = subs.filter(s => s.type !== "eco" && usageOf(s) > 0);
  const ecoSubs   = subs.filter(s => s.type === "eco");

  // ── Headline impact numbers (same model as the on-chain proofs) ────────────
  const totalB3TR = earnedTotal(subs);
  const ecoB3TR   = earnedTotal(ecoSubs);
  // Each reading is judged against the target over the days since that meter's
  // previous reading, exactly like the reward (and the on-chain proof). A meter's
  // first reading is its starting point and saves nothing. It used to be one day's
  // target for every reading, so anyone who didn't log daily saw too little saved.
  const spanOfSub = new Map();
  {
    const lastOf = {};
    const ordered = subs.filter(s => s.type !== "eco" && s.status !== "failed").sort((a, b) => subTs(a) - subTs(b));
    for (const s of ordered) {
      const k = `${s.type}:${String(s.meterNo || "").toLowerCase()}`;
      spanOfSub.set(s, lastOf[k] ? spanDays(subTs(s) - subTs(lastOf[k])) : null);
      lastOf[k] = s;
    }
  }
  let co2g = ecoSubs.length * ECO_CO2_PER_CLAIM, kwhSaved = ecoSubs.length * ECO_KWH_PER_CLAIM;
  for (const s of meterSubs) {
    const bench = USAGE_BENCHMARK[s.type] ?? 0;
    if (SAVING_UTILS.has(s.type)) {
      const span = spanOfSub.get(s);
      if (span == null) continue;
      const saved = Math.max(0, bench * span - usageOf(s));
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
    if (w) { w.b3tr += paidAmount(s); w.n += 1; }
  }
  const weekMax = Math.max(...weeks.map(w => w.b3tr), 0);
  const wkLabel = (t) => fmtDay(t);

  // ── Personal records ────────────────────────────────────────────────────────
  const bestDay = meterSubs.length ? meterSubs.reduce((a, s) => usageOf(s) < usageOf(a) ? s : a) : null;
  const paidSubs = subs.filter(s => paidAmount(s) > 0);
  const bestReward = paidSubs.length ? paidSubs.reduce((a, s) => paidAmount(s) > paidAmount(a) ? s : a) : null;

  const Tile = ({ icon, val, unit, label, sub }) => (
    <div className="pstat">
      <div style={{fontSize:16,marginBottom:2}}>{icon}</div>
      <div className="pstat-val" style={{fontSize:19}}>{val}<span style={{fontSize:11,fontWeight:600,color:T.textSoft}}> {unit}</span></div>
      <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft,marginTop:2}}>{label}</div>
      {sub && <div style={{fontSize:10,color:T.textSoft,marginTop:1}}>{sub}</div>}
    </div>
  );

  if (part === "impact") return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(3, minmax(0, 1fr))",gap:8,margin:"0 14px 12px"}}>
      {[{ icon: "🌍", v: co2Label, k: t("c.co2") }, { icon: "⚡", v: `${kwhSaved.toFixed(kwhSaved >= 100 ? 0 : 1)} kWh`, k: t("c.saved") }, { icon: "🔥", v: t("c.days", { n: streak }), k: t("c.streak") }].map(x => (
        <div key={x.k} className="pstat" style={{padding:"10px 6px"}}>
          <div style={{fontSize:17}}>{x.icon}</div>
          <div className="pstat-val" style={{fontSize:16,marginTop:3}}>{x.v}</div>
          <div className="pstat-key">{x.k}</div>
        </div>
      ))}
    </div>
  );

  if (!subs.length) return (
    <>
      {!part && (
        <div className="sub-header">
          <div className="sub-title">Analytics</div>
          <div className="sub-sub">Your impact and trends</div>
        </div>
      )}
      <div className="chart-card" style={{textAlign:"center",padding:"28px 16px"}}>
        <div style={{fontSize:26,marginBottom:8}}>📊</div>
        <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:4}}>{t("c.noData")}</div>
        <div style={{fontSize:11,color:T.textSoft,lineHeight:1.5}}>{t("c.noData.d")}</div>
      </div>
    </>
  );

  return (
    <>
      {!part && (
        <div className="sub-header">
          <div className="sub-title">Analytics</div>
          <div className="sub-sub">Your impact and trends</div>
        </div>
      )}

      {/* Impact headline — the numbers that tell the sustainability story */}
      {!part && <div className="pstat-row">
        <Tile icon="🌍" val={co2Label.split(" ")[0]} unit={co2Label.split(" ")[1] + " CO₂e"} label={t("c.emissions")} />
        <Tile icon="⚡" val={kwhSaved.toFixed(1)} unit="kWh" label={t("c.energy")} sub={t("c.vsTarget")} />
        <Tile icon="🪙" val={totalB3TR.toFixed(2)} unit="B3TR" label={t("c.totalEarned")} sub={ecoB3TR > 0 ? `${(totalB3TR - ecoB3TR).toFixed(2)} meters · ${ecoB3TR.toFixed(2)} eco` : undefined} />
        <Tile icon="🔥" val={streak} unit="" label={t("c.streak")} sub={t("c.submissions", { n: subs.length })} />
      </div>}

      {/* Usage vs the efficiency target — the core conservation view */}
      {UTILS.map(u => {
        // Production meters (solar) have no "stay under" target — more is better,
        // so they get plain green bars and no target framing.
        const saving = SAVING_UTILS.has(u.id);
        // Usage PER DAY over each reading's span, against the per-day target: a
        // 3-day reading of 18 kWh is 6 a day, under the 8 a day target. Drawn as a
        // total it showed red, "above target", for a reading that paid a saving.
        // Failed rows and a meter's first reading (no span: nothing to compare) are
        // left out.
        const myS = subs.filter(s => s.type === u.id && s.status !== "failed" && (!saving || spanOfSub.get(s))).slice(0, 7).reverse();
        const series = myS.map(s => ({ v: saving ? usageOf(s) / spanOfSub.get(s) : usageOf(s), label: fmtDay(s.date || "") }));
        const bench = saving ? (USAGE_BENCHMARK[u.id] ?? 0) : 0;
        const avg = series.length ? series.reduce((a, d) => a + d.v, 0) / series.length : 0;
        // Scale so the target line is always on-canvas, even when every bar is below it.
        const maxScale = Math.max(...series.map(d => d.v), bench * 1.15, 0.001);
        const underCount = series.filter(d => d.v <= bench).length;
        return (
          <div key={u.id} className="chart-card">
            <div className="chart-hdr">
              <div className="chart-title">{saving ? t("c.usageVsTarget", { label: utilName(u.id) }) : `${utilName(u.id)} — production`}</div>
              <div style={{fontSize:10,color:T.textSoft}}>{series.length ? t("c.avg", { n: avg.toFixed(1), unit: saving ? t("c.perDayUnit", { unit: u.unit }) : u.unit }) : ""}</div>
            </div>
            {series.length ? (
              <>
                <div style={{position:"relative",height:110,display:"flex",alignItems:"flex-end",gap:2,padding:"14px 2px 0"}}>
                  {bench > 0 && (
                    <div style={{position:"absolute",left:0,right:0,bottom:`${(bench / maxScale) * 100}%`,borderTop:`2px dashed ${T.textSoft}`,zIndex:1}}>
                      <span style={{position:"absolute",right:2,top:-14,fontSize:10.5,fontWeight:700,color:T.textSoft,background:T.card,padding:"0 3px"}}>{t("c.target", { n: bench, unit: t("c.perDayUnit", { unit: u.unit }) })}</span>
                    </div>
                  )}
                  {series.map((d, i) => (
                    <div key={i} title={t(!saving ? "c.tipProduced" : d.v <= bench ? "c.tipUnder" : "c.tipAbove", { label: d.label, v: d.v.toFixed(2), unit: saving ? t("c.perDayUnit", { unit: u.unit }) : u.unit })}
                      style={{flex:1,height:`${Math.max(4, (d.v / maxScale) * 100)}%`,background: !saving || d.v <= bench ? T.green3 : T.electric,borderRadius:"4px 4px 0 0"}} />
                  ))}
                </div>
                <div style={{display:"flex",gap:2,padding:"2px 2px 0"}}>
                  {series.map((d, i) => <div key={i} style={{flex:1,textAlign:"center",fontSize:10,color:T.textSoft}}>{d.label}</div>)}
                </div>
                {saving && (
                <div style={{display:"flex",gap:12,marginTop:8,fontSize:10.5,color:T.textMid}}>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:6,background:T.green3,marginRight:4,verticalAlign:"middle"}}/>{t("c.under", { n: underCount })}</span>
                  <span><span style={{display:"inline-block",width:8,height:8,borderRadius:6,background:T.electric,marginRight:4,verticalAlign:"middle"}}/>{t("c.above", { n: series.length - underCount })}</span>
                </div>
                )}
              </>
            ) : (
              <div style={{padding:"18px 4px",fontSize:11,color:T.textSoft,textAlign:"center"}}>{t("c.noReadings")}</div>
            )}
          </div>
        );
      })}

      {/* Earnings per calendar week */}
      <div className="chart-card">
        <div className="chart-hdr">
          <div className="chart-title">{t("c.perWeek")}</div>
          <div style={{fontSize:10,color:T.textSoft}}>{t("c.last6")}</div>
        </div>
        <div style={{position:"relative",height:90,display:"flex",alignItems:"flex-end",gap:4,padding:"12px 2px 0"}}>
          {weeks.map((w, i) => (
            <div key={i} title={`week of ${wkLabel(w.start)}: ${w.b3tr.toFixed(2)} B3TR (${w.n} submission${w.n === 1 ? "" : "s"})`}
              style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end",height:"100%"}}>
              {w.b3tr > 0 && w.b3tr === weekMax && <div style={{fontSize:10.5,fontWeight:700,color:T.textMid,fontFamily:mono,marginBottom:2}}>{w.b3tr.toFixed(1)}</div>}
              <div style={{width:"100%",height: weekMax > 0 ? `${Math.max(4, (w.b3tr / weekMax) * 72)}%` : "4px",background: w.b3tr > 0 ? T.green3 : T.bgAlt,borderRadius:"4px 4px 0 0"}} />
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:4,padding:"2px 2px 0"}}>
          {weeks.map((w, i) => <div key={i} style={{flex:1,textAlign:"center",fontSize:10,color: w.start === thisWeek ? T.green3 : T.textSoft,fontWeight: w.start === thisWeek ? 700 : 400}}>{w.start === thisWeek ? t("c.now") : wkLabel(w.start)}</div>)}
        </div>
      </div>

      {(bestDay || bestReward) && (
        <div className="chart-card">
          <div className="chart-hdr"><div className="chart-title">{t("c.records")}</div></div>
          {bestDay && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${T.border}`,fontSize:11}}>
              <span style={{color:T.textMid}}>{t("c.bestReading")}</span>
              <span style={{fontWeight:700,color:T.green3}}>{usageOf(bestDay).toFixed(2)} {getUtil(bestDay.type).unit} · {fmtDay(bestDay.date)}</span>
            </div>
          )}
          {bestReward && (
            <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",fontSize:11}}>
              <span style={{color:T.textMid}}>{t("c.bestReward")}</span>
              <span style={{fontWeight:700,color:T.green3}}>+{(parseFloat(bestReward.b3tr) || 0).toFixed(2)} B3TR · {fmtDay(bestReward.date)}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// Progress: how you're doing — rank, impact, goals, then usage / leaderboard /
// badges behind one switch. Charts and Rank used to be two tabs that repeated the
// same totals; this is both, once.
function ProgressScreen({ b3tr, streak, subs, wallet, T }) {
  // The "100 B3TR Achievement" goal is a fixed 100.

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
    // No on-chain field (yet, or the node is unreachable): show only you. This used
    // to rank you against made-up players — "#10, 127.60 B3TR to reach #9" — which
    // is a claim about other people that isn't true.
    board = [{ name: "You", addr: shortAddr(wallet), b3tr: +b3tr.toFixed(2), streak, isMe: true, rank: 1 }];
  }

  const myIndex = board.findIndex(d => d.isMe);
  const myRank = myIndex + 1;
  const myBoardB3tr = myIndex >= 0 ? board[myIndex].b3tr : b3tr;
  
  const badges = [
    { id: "early", name: t("b.early"), icon: "🚀", how: t("b.early.how"), unlocked: subs.length > 0 },
    { id: "7day", name: t("b.week"), icon: "🔥", how: t("b.week.how"), unlocked: streak >= 7 },
    { id: "100sub", name: t("b.century"), icon: "💯", how: t("b.century.how"), unlocked: subs.length >= 100 },
    { id: "20day", name: t("b.legend"), icon: "👑", how: t("b.legend.how"), unlocked: streak >= 20 },
    { id: "250b3tr", name: t("b.whale"), icon: "🐋", how: t("b.whale.how"), unlocked: b3tr >= 250 },
    { id: "rank1", name: t("b.champ"), icon: "🏆", how: t("b.champ.how"), unlocked: isLive && board.length > 1 && myRank === 1 && myBoardB3tr > 0 },
  ];
  const [view, setView] = useState("usage");
  const label = { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft };
  const card = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 10 };
  const meterReadings = subs.filter(s => s.type !== "eco").length;
  const goals = [
    streak < 7
      ? { icon: "🔥", label: t("p.goal.7"), left: t("p.daysToGo", { n: 7 - streak }) }
      : { icon: "👑", label: t("p.goal.20"), left: streak >= 20 ? t("p.reached") : t("p.daysToGo", { n: 20 - streak }) },
    { icon: "🏆", label: t("p.goal.top3"), left: !isLive ? "—" : myRank <= 3 ? t("p.inIt") : t("p.placesToGo", { n: myRank - 3 }) },
    { icon: "💯", label: t("p.goal.100"), left: meterReadings >= 100 ? t("p.reached") : t("p.readingsToGo", { n: 100 - meterReadings }) },
  ];

  return (
    <>
      <div className="sub-header">
        <div className="sub-title">{t("p.title")}</div>
        <div className="sub-sub">{t("p.sub")}</div>
      </div>

      <div style={{ ...card, margin: "0 14px 12px", padding: 16, display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden="true" style={{ fontSize: 30, lineHeight: 1 }}>🏆</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>
            {chain.status === "loading" ? t("p.loading") : isLive ? t("p.rank", { rank: myRank, total: board.length }) : t("p.rankLater")}
          </div>
          <div style={{ fontSize: 12, color: T.textSoft, marginTop: 2 }}>{t("p.earnedTotal", { amount: b3tr.toFixed(2) })}</div>
        </div>
      </div>

      {/* The leaderboard sat in the third tab under four stat cards, though the intro
          promises "Climb the Leaderboard". The top three and your own place come
          first now; the full list stays in its tab. */}
      {isLive && board.length > 1 && (
        <div style={{ ...card, margin: "0 14px 12px", padding: 14 }}>
          <div style={{ ...label, marginBottom: 10 }}>{t("p.board")}</div>
          {[...board.slice(0, 3), ...(myRank > 3 ? board.filter((b) => b.isMe) : [])].map((item) => (
            <div key={item.isMe ? "me" : (item.rawAddr || item.name)} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 36, fontSize: 13 }}>
              <span aria-hidden="true" style={{ width: 24, textAlign: "center", fontSize: item.rank <= 3 ? 18 : 13, fontWeight: 800, color: T.textSoft }}>{["🥇", "🥈", "🥉"][item.rank - 1] || item.rank}</span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: item.isMe ? 800 : 600, color: T.text, fontFamily: item.isMe ? undefined : "'SF Mono',Menlo,monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.isMe ? t("p.youRank", { rank: item.rank }) : item.name}</span>
              <span style={{ fontWeight: 800, color: T.text }}>{Number(item.b3tr).toFixed(2)} <span style={{ fontSize: 10, color: T.textSoft }}>B3TR</span></span>
            </div>
          ))}
          <button type="button" onClick={() => setView("board")} style={{ marginTop: 8, minHeight: 40, width: "100%", border: `1px solid ${T.border}`, borderRadius: 6, background: "transparent", color: T.textMid, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>{t("p.fullBoard")}</button>
        </div>
      )}

      <ChartsScreen subs={subs} T={T} part="impact" />

      <div style={{ ...card, margin: "0 14px 12px", padding: 14 }}>
        <div style={{ ...label, marginBottom: 10 }}>{t("p.goals")}</div>
        {goals.map((g, i) => (
          <div key={g.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 13, marginTop: i ? 10 : 0 }}>
            <span style={{ fontWeight: 700, color: T.text }}>{g.icon} {g.label}</span>
            <span style={{ fontWeight: 700, color: T.green3, textAlign: "right" }}>{g.left}</span>
          </div>
        ))}
      </div>

      <div role="tablist" aria-label={t("p.tabs")} style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 3, padding: 3, margin: "0 14px 12px", background: T.bgAlt, borderRadius: 6 }}>
        {[["usage", t("p.tab.usage")], ["board", t("p.tab.board")], ["badges", t("p.tab.badges")]].map(([id, name]) => {
          const on = view === id;
          return (
            <button key={id} type="button" role="tab" aria-selected={on} onClick={() => setView(id)}
              style={{ minHeight: 40, border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: on ? 800 : 700, background: on ? T.card : "transparent", color: on ? T.text : T.textSoft }}>
              {name}
            </button>
          );
        })}
      </div>

      {view === "usage" && <ChartsScreen subs={subs} T={T} part="charts" />}

      {view === "board" && (<>
        <div style={{ margin: "0 14px 8px", fontSize: 11, color: chain.status === "live" ? T.green3 : T.textSoft, fontWeight: 700 }}>
          {chain.status === "loading" ? t("p.loading")
            : chain.status === "live" ? `${t("p.live", { n: board.length })}${chain.truncated ? t("p.more") : ""}`
            : (chain.reason === "unset_appid" ? t("p.noRank") : t("p.onlyYou"))}
        </div>
        <div style={{ ...card, margin: "0 14px 12px", overflow: "hidden" }}>
          {board.slice(0, 25).map((item, i, arr) => (
            <div key={item.isMe ? "me" : (item.rawAddr || item.name)} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", gap: 10, alignItems: "center", minHeight: 52, padding: "0 14px", background: item.isMe ? (T.green5 || T.bgAlt) : "transparent", borderBottom: i < arr.length - 1 ? `1px solid ${T.border}` : "none" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.textSoft }}>{item.rank}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: item.isMe ? 13 : 12, fontWeight: 700, color: T.text, fontFamily: item.isMe ? undefined : "'SF Mono',Menlo,monospace" }}>{item.isMe ? t("p.you") : item.name}</div>
                <div style={{ fontSize: 11, color: T.textSoft }}>
                  {item.count != null ? t("p.rewards", { n: item.count }) : t("p.streakN", { n: streak })}{item.isMe ? ` · ${shortAddr(wallet)}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: T.text }}>{Number(item.b3tr).toFixed(2)}</div>
            </div>
          ))}
        </div>
      </>)}

      {view === "badges" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, margin: "0 14px 12px" }}>
          {badges.map(b => (
            <div key={b.id} style={{ background: T.card, border: b.unlocked ? `2px solid ${T.green3}` : `1px solid ${T.border}`, borderRadius: 10, padding: "12px 6px", textAlign: "center" }}>
              <div aria-hidden="true" style={{ position: "relative", display: "inline-block", fontSize: 26 }}>
                <span style={{ opacity: b.unlocked ? 1 : .35, filter: b.unlocked ? "none" : "grayscale(1)" }}>{b.icon}</span>
                {!b.unlocked && <span style={{ position: "absolute", right: -10, bottom: -4, fontSize: 13 }}>🔒</span>}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: b.unlocked ? T.text : T.textSoft, marginTop: 4 }}>{b.name}</div>
              <div style={{ fontSize: 10, color: T.textSoft, marginTop: 2 }}>{b.unlocked ? t("b.earned") : t("b.locked", { how: b.how })}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function HistoryScreen({ subs, T }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter==="all" ? subs : subs.filter(s=>s.type===filter);
  return (
    <>
      <div style={{padding:"18px 20px 10px",display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
        <div className="page-title" style={{padding:0}}>{t("h.title")}</div>
        <div style={{fontSize:11,color:T.textSoft,fontFamily:"'SF Mono',Menlo,'Courier New',monospace"}}>{t("h.total", { n: subs.length })}</div>
      </div>
      <div className="filter-row">
        {[{id:"all",l:t("h.all")},...UTILS.map(u=>({id:u.id,l:utilName(u.id)}))].map(f=>(
          <button key={f.id} className={`fchip ${filter===f.id?"active":""}`} onClick={()=>setFilter(f.id)}>
            {f.l}
          </button>
        ))}
      </div>
      {filtered.map(s => <HistItem key={s.id} s={s} T={T} />)}
    </>
  );
}

// ── Personal touch: a name and an avatar, on this device only ─────────────────
// Kept per wallet in localStorage and never sent anywhere, so nobody else sees it
// and there is nothing to moderate. A .vet name, when the wallet has one, is shown
// without asking.
const AVATARS = ["🌱", "🌿", "🌳", "🌻", "☀️", "⚡", "💧", "🔥", "🐝", "🦊", "🐢", "🚲"];
const PROFILE_NAME_MAX = 24;
const profileKey = (w) => `greenlog_profile:${String(w || "").toLowerCase()}`;
// An own photo is shrunk to a 160 px square JPEG (~10 KB) before it is kept, so
// it fits comfortably in localStorage. Anything else found there is ignored.
const PHOTO_PREFIX = "data:image/jpeg;base64,";
const PHOTO_MAX_CHARS = 80000;
const EMPTY_PROFILE = { name: "", avatar: "", photo: "" };
function loadProfile(w) {
  if (!w) return EMPTY_PROFILE;
  try {
    const p = JSON.parse(localStorage.getItem(profileKey(w)) || "{}");
    const photo = typeof p.photo === "string" && p.photo.startsWith(PHOTO_PREFIX) && p.photo.length <= PHOTO_MAX_CHARS ? p.photo : "";
    return { name: String(p.name || "").slice(0, PROFILE_NAME_MAX), avatar: AVATARS.includes(p.avatar) ? p.avatar : "", photo };
  } catch { return EMPTY_PROFILE; }
}
// Centre-crop to a square and scale down. Returns a data URL, or null when this
// browser can't decode the file (HEIC on most non-Apple browsers, say).
// Decode a picked photo. createImageBitmap first; when the browser lacks it or
// can't decode the format (older iOS WebViews, an iPhone HEIC photo on some
// phones), an <img> element, which uses the system's own decoder and turns the
// photo upright by its EXIF orientation.
async function decodePhoto(file) {
  try {
    if (typeof createImageBitmap === "function") {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, w: bmp.width, h: bmp.height };
    }
  } catch { /* fall through to <img> */ }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
async function profilePhotoFrom(file) {
  try {
    const { src, w, h } = await decodePhoto(file);
    if (!w || !h) return null;
    const side = Math.min(w, h);
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    c.getContext("2d").drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 160, 160);
    const url = c.toDataURL("image/jpeg", 0.85);
    return url.startsWith(PHOTO_PREFIX) && url.length <= PHOTO_MAX_CHARS ? url : null;
  } catch { return null; }
}
function saveProfile(w, p) {
  try { localStorage.setItem(profileKey(w), JSON.stringify(p)); return true; } catch { return false; }
}

function ProfileHero({ wallet, domain, summary, role, onToast, T }) {
  const [profile, setProfile] = useState(() => loadProfile(wallet));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  // Another wallet connected: show that wallet's own profile, not the last one's.
  useEffect(() => { const p = loadProfile(wallet); setProfile(p); setDraft(p); setEditing(false); }, [wallet]);

  const title = profile.name || domain || t("pr.myAccount");
  const avatar = profile.avatar || "🌱";
  const fileRef = useRef(null);
  const pickPhoto = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again still fires
    if (!f) return;
    const url = await profilePhotoFrom(f);
    if (!url) { onToast?.("⚠️ Couldn't open that photo here — try a JPEG or PNG"); return; }
    setDraft(d => ({ ...d, photo: url }));
  };
  const shown = editing ? draft : profile;
  const save = () => {
    const next = { name: draft.name.trim().slice(0, PROFILE_NAME_MAX), avatar: draft.avatar, photo: draft.photo || "" };
    if (!saveProfile(wallet, next)) onToast?.("⚠️ This browser won't let the app save it — try outside private mode");
    setProfile(next); setEditing(false);
  };
  const mono = "'SF Mono',monospace";

  return (
    <div className="profile-hero">
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <div aria-hidden="true" style={{width:48,height:48,flexShrink:0,borderRadius:"50%",overflow:"hidden",background:T.bgAlt,border:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>
          {shown.photo ? <img src={shown.photo} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} /> : (editing ? (draft.avatar || "🌱") : avatar)}
        </div>
        <div style={{minWidth:0,flex:1}}>
          <div className="pname" style={{overflowWrap:"anywhere",lineHeight:1.15}}>{editing ? (draft.name.trim() || domain || t("pr.myAccount")) : title}</div>
          {summary && !editing && <div style={{fontSize:12,color:T.textMid,marginTop:3}}>{summary}</div>}
          <div style={{fontSize:10,color:T.textSoft,fontFamily:mono,marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {wallet ? (profile.name && domain ? `${domain} · ${shortAddr(wallet)}` : shortAddr(wallet)) : t("pr.notConnected")}
          </div>
        </div>
        {wallet && !editing && (
          // Icon only, so the name gets the room: "MrUnknownV…" was cut off on a phone.
          <button onClick={() => { setDraft(profile); setEditing(true); }} aria-label={t("m.edit")} title={t("m.edit")}
            style={{flexShrink:0,alignSelf:"flex-start",width:44,height:44,background:"transparent",border:`1px solid ${T.border}`,borderRadius:8,fontSize:18,cursor:"pointer"}}>
            ✏️
          </button>
        )}
      </div>

      {editing ? (
        <div style={{marginTop:14}}>
          <label style={{display:"block",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginBottom:6}}>
            {t("prof.name")}
            <input value={draft.name} maxLength={PROFILE_NAME_MAX} placeholder={domain || t("prof.yourName")}
              onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
              style={{display:"block",width:"100%",boxSizing:"border-box",marginTop:6,background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",fontSize:14,color:T.text,outline:"none",textTransform:"none",letterSpacing:0,fontWeight:500}} />
          </label>
          <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"12px 0 6px"}}>{t("prof.photo")}</div>
          {/* Kept in the layout and driven by a <label>, not display:none + .click():
              VeWorld's WebView silently ignores that (see HIDDEN_FILE_INPUT). */}
          <input id="gul-profile-photo" ref={fileRef} type="file" accept="image/*" onChange={pickPhoto} style={HIDDEN_FILE_INPUT} />
          <div style={{display:"flex",gap:8}}>
            <label htmlFor="gul-profile-photo" style={{flex:1,textAlign:"center",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"10px",fontSize:12,fontWeight:700,color:T.text,cursor:"pointer"}}>
              📷 {draft.photo ? t("prof.changePhoto") : t("prof.choosePhoto")}
            </label>
            {draft.photo && (
              <button onClick={() => setDraft(d => ({ ...d, photo: "" }))} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>{t("prof.remove")}</button>
            )}
          </div>
          <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"12px 0 6px"}}>{t("prof.orAvatar")}</div>
          <div role="radiogroup" aria-label="Avatar" style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:6}}>
            {AVATARS.map(a => {
              const on = (draft.avatar || "🌱") === a;
              return (
                <button key={a} role="radio" aria-checked={on} onClick={() => setDraft(d => ({ ...d, avatar: a }))}
                  style={{height:44,fontSize:22,borderRadius:10,cursor:"pointer",background:on ? T.bgAlt : "transparent",border:`${on ? 2 : 1}px solid ${on ? T.green3 : T.border}`}}>
                  {a}
                </button>
              );
            })}
          </div>
          <div style={{fontSize:10,color:T.textSoft,lineHeight:1.5,marginTop:10}}>{t("prof.deviceOnly")}</div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button onClick={() => setEditing(false)} style={{flex:1,background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"11px",fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>{t("prof.cancel")}</button>
            <button onClick={save} style={{flex:2,background:"#2E7D32",border:"none",borderRadius:6,padding:"11px",fontSize:12,fontWeight:800,color:"#fff",cursor:"pointer"}}>{t("prof.save")}</button>
          </div>
        </div>
      ) : (wallet || role) ? (
        <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",marginTop:12}}>
          {wallet && <GalaxyMemberBadge wallet={wallet} T={T} />}
          {role && <span style={{fontSize:10.5,fontWeight:800,background:T.green5||T.bgAlt,color:T.green3,border:`1px solid ${T.green4||T.border}`,borderRadius:999,padding:"4px 10px",textTransform:"uppercase",letterSpacing:".6px"}}>🎟️ {role}</span>}
        </div>
      ) : null}
    </div>
  );
}

// Shown instead of the app to a wallet without a role, while this version is set
// to "Only with a role". The address is what the team needs to give one.
function NoAccessScreen({ wallet, T, onSwitch, onToast }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(wallet); onToast?.(t("noacc.copied")); }
    catch { onToast?.(t("noacc.copyFail")); }
  };
  return (
    <div style={{margin:"24px 16px",padding:"22px 18px",background:T.card,border:`1px solid ${T.border}`,borderRadius:10,textAlign:"center"}}>
      <div style={{fontSize:34,lineHeight:1}} aria-hidden="true">🔒</div>
      <h2 style={{fontSize:17,fontWeight:800,color:T.text,margin:"12px 0 6px"}}>
        {NETWORK === "mainnet" ? t("noacc.titleMain") : t("noacc.titleTest")}
      </h2>
      <p style={{fontSize:12.5,color:T.textMid,lineHeight:1.6,margin:"0 0 14px"}}>
        {NETWORK === "mainnet" ? t("noacc.bodyMain") : t("noacc.bodyTest")}
        {" "}{t("noacc.ask")}
      </p>
      <div style={{fontFamily:"'SF Mono',Menlo,monospace",fontSize:11.5,color:T.text,background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6,padding:"9px 10px",wordBreak:"break-all",userSelect:"all"}}>{wallet}</div>
      <div style={{display:"flex",gap:8,marginTop:12}}>
        <button type="button" onClick={copy} style={{flex:1,padding:"11px",fontSize:12,fontWeight:800,color:T === DARK ? T.bg : "#fff",background:T.green2,border:"none",borderRadius:6,cursor:"pointer"}}>{t("noacc.copy")}</button>
        <button type="button" onClick={onSwitch} style={{flex:1,padding:"11px",fontSize:12,fontWeight:700,color:T.textMid,background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,cursor:"pointer"}}>{t("noacc.switch")}</button>
      </div>
      {MAIN_APP_URL && NETWORK !== "mainnet" && (
        <p style={{fontSize:11,color:T.textSoft,marginTop:14}}>{t("noacc.lookingFor")} <a href={MAIN_APP_URL} style={{color:T.green3,fontWeight:700}}>{t("noacc.open")}</a></p>
      )}
    </div>
  );
}

// A list row that is a real button (keyboard and screen readers reach it).
function RowButton({ icon, label, sub, right, danger, onClick, T, last }) {
  return (
    <button type="button" onClick={onClick}
      style={{display:"flex",alignItems:"center",gap:12,width:"100%",minHeight:56,padding:"0 14px",border:"none",borderBottom:last?"none":`1px solid ${T.border}`,background:"transparent",textAlign:"left",cursor:"pointer",color:T.text,font:"inherit"}}>
      <span aria-hidden="true" style={{width:32,height:32,flexShrink:0,borderRadius:6,background:T.bgAlt,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15}}>{icon}</span>
      <span style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:1}}>
        <span style={{fontSize:13,fontWeight:700,color:danger?T.gas:T.text}}>{label}</span>
        {sub && <span style={{fontSize:11,color:T.textSoft,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sub}</span>}
      </span>
      {right ?? <span aria-hidden="true" style={{color:T.textSoft,fontSize:18}}>›</span>}
    </button>
  );
}
const listCard = (T) => ({ margin: "0 14px 12px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" });

// The wallet's VeBetterDAO Galaxy Member NFT, read from chain, as a badge at the
// bottom of the account card: its picture, level name and level. A wallet without
// one gets a link to get one; a chain that can't be read says so instead of
// claiming there is none.
const GM_PAGE = "https://governance.vebetterdao.org";
// Always mainnet, also in the testnet build: a user's GM NFT lives on mainnet, and
// the badge only reads (nothing is signed or sent).
const GM_NODE = NETWORKS.mainnet.node;
const GM_CONTRACT = NETWORKS.mainnet.contracts.GalaxyMember;
function GalaxyMemberBadge({ wallet, T }) {
  const [gm, setGm] = useState({ status: "loading" });
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => {
    const ctrl = new AbortController();
    setGm({ status: "loading" }); setImgOk(true);
    fetchGalaxyMember({ node: GM_NODE, contract: GM_CONTRACT, address: wallet, signal: ctrl.signal })
      .then((r) => { if (ctrl.signal.aborted) return; setGm(!r ? { status: "none" } : r.error ? { status: "error" } : { status: "ok", ...r }); })
      .catch(() => { if (!ctrl.signal.aborted) setGm({ status: "error" }); });
    return () => ctrl.abort();
  }, [wallet]);
  const pill = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, fontWeight: 800, background: T.bgAlt, color: T.text, border: `1px solid ${T.border}`, borderRadius: 999, padding: "4px 10px", textTransform: "uppercase", letterSpacing: ".6px", textDecoration: "none", maxWidth: "100%" };
  if (gm.status === "loading") return <span style={{ ...pill, color: T.textSoft }} aria-busy="true" title={t("gm.loading")}>🪐 GM NFT…</span>;
  if (gm.status === "error") return <span style={{ ...pill, color: T.textSoft, fontWeight: 700 }} title={t("gm.error")}>🪐 {t("gm.errorShort")}</span>;
  if (gm.status === "none") return <a href={GM_PAGE} target="_blank" rel="noopener noreferrer" style={{ ...pill, color: T.green3 }} title={t("gm.none")}>🪐 {t("gm.getShort")}</a>;
  const name = gm.level >= 1 && gm.level <= 10 ? t(`gm.lv.${gm.level}`) : "";
  const level = gm.maxLevel >= gm.level && gm.level > 0 ? t("gm.levelOf", { n: gm.level, max: gm.maxLevel }) : t("gm.level", { n: gm.level });
  return (
    <span style={{ ...pill, paddingLeft: 3 }} title={`${t("gm.title")} #${gm.tokenId}`}>
      {gm.image && imgOk
        ? <img src={gm.image} alt="" width="22" height="22" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} onError={() => setImgOk(false)} />
        : <span aria-hidden="true" style={{ width: 22, textAlign: "center" }}>🪐</span>}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>GM {name ? `${name} · ` : ""}{level}</span>
    </span>
  );
}

// Profile: you. Settings live one tap away (⚙️), not on this page.
function ProfileScreen({ b3tr, subs, wallet, walletDomain, pass, setTab, onOpenSettings, onOpenHelp, onOpenFeedback, onToast, T }) {
  const readings = subs.filter(s => s.type !== "eco").length;
  const first = subs.reduce((m, s) => { const t = s.submittedAt || localDayTs(s.date) || 0; return t && (!m || t < m) ? t : m; }, 0);
  const summary = `${t("pr.summary", { amount: b3tr.toFixed(2), n: readings })}${first ? t("pr.since", { date: new Date(first).toLocaleDateString(getLang(), { month: "short", year: "numeric" }) }) : ""}`;
  return (
    <>
      <div className="sub-header" style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",gap:10}}>
        <div>
          <div className="sub-title">{t("pr.title")}</div>
          <div className="sub-sub">{t("pr.sub")}</div>
        </div>
        <button type="button" onClick={onOpenSettings} aria-label={t("pr.settings")} className="dark-toggle" style={{width:44,height:44,fontSize:18,background:T.card}}>⚙️</button>
      </div>
      <ProfileHero wallet={wallet} domain={walletDomain} summary={wallet ? summary : ""} role={pass?.tier || ""} onToast={onToast} T={T} />
      <div style={listCard(T)}>
        <RowButton T={T} icon="🧾" label={t("pr.history")} sub={subs.length ? t("pr.history.sub", { n: subs.length }) : t("pr.history.empty")} onClick={() => setTab("history")} />
        <RowButton T={T} icon="❓" label={t("pr.help")} sub={t("pr.help.sub")} onClick={onOpenHelp} />
        <RowButton T={T} icon="✉️" label={t("pr.feedback")} sub={t("pr.feedback.sub")} onClick={onOpenFeedback} last />
      </div>
    </>
  );
}

function SettingsScreen({ lang, onLang, b3tr, subs, wallet, setShowWallet, dark, setDark, setOnboarded, onEditMeters, onEditSolar, meters, isAdmin, onOpenAdmin, onOpenReader, onToast, onReset, onBack, T }) {
  const meterNo = (meters?.electric || "").trim();
  const group = (title) => <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"14px 18px 6px"}}>{title}</div>;
  return (
    <>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 14px 2px"}}>
        <button type="button" onClick={onBack} aria-label={t("set.back")} className="dark-toggle" style={{width:44,height:44,fontSize:18,background:T.card}}>‹</button>
        <div className="sub-title">{t("pr.settings")}</div>
      </div>

      {group(t("set.appearance"))}
      <div style={listCard(T)}>
        <RowButton T={T} icon="🌙" label={t("set.dark")} sub={dark ? t("set.on") : t("set.off")} onClick={() => setDark(d => !d)} last
          right={<span aria-hidden="true" className={`toggle ${dark ? "on" : ""}`} style={{display:"inline-block"}}><span className="toggle-dot"/></span>} />
      </div>

      {group("🌐 " + t("set.language"))}
      <div role="radiogroup" aria-label={t("set.language")} style={{ ...listCard(T), display: "flex", flexWrap: "wrap", gap: 8, padding: 12 }}>
        {Object.entries(LANGS).map(([code, name]) => (
          <button key={code} type="button" role="radio" aria-checked={lang === code} onClick={() => onLang(code)}
            style={{ minHeight: 44, padding: "0 14px", borderRadius: 999, cursor: "pointer", fontSize: 13, fontWeight: 700,
              border: `1px solid ${lang === code ? T.green3 : T.border}`, background: lang === code ? T.green5 : "transparent", color: lang === code ? T.green2 : T.textMid }}>
            {name}
          </button>
        ))}
      </div>

      {group(t("set.meter"))}
      <div style={listCard(T)}>
        <RowButton T={T} icon="🔢" label={t("set.meterStart")} sub={meterNo ? t("set.meterStart.sub", { n: meterNo }) : t("set.register")} onClick={onEditMeters} />
        {SOLAR_UTILS.length > 0 && <RowButton T={T} icon="☀️" label={t("set.solar")} sub={(meters?.solar || "").trim() ? `Meter #${meters.solar}` : t("set.solar.add")} onClick={onEditSolar} />}
        <RowButton T={T} icon="⚡" label={t("set.auto")} sub={t("set.auto.sub")} onClick={onOpenReader} last />
      </div>

      {group(t("set.data"))}
      <div style={listCard(T)}>
        <RowButton T={T} icon="📄" label={t("set.report")} sub={t("set.report.sub")} last
          onClick={async () => { const ok = await generateMonthlyPDF(b3tr, subs); onToast?.(ok ? t("set.reportOk") : t("set.reportFail")); }} />
      </div>

      {group(t("set.account"))}
      <div style={listCard(T)}>
        <RowButton T={T} icon="💼" label={t("set.wallet")} sub={wallet ? t("set.wallet.switch", { addr: shortAddr(wallet) }) : t("set.wallet.connect")} onClick={() => setShowWallet(true)} />
        <RowButton T={T} icon="🎓" label={t("set.tutorial")} sub={t("set.tutorial.sub")} onClick={() => setOnboarded(false)} last={!isAdmin} />
        {isAdmin && <RowButton T={T} icon="🛡️" label="Admin panel" sub="Participants, roles and the pot" onClick={onOpenAdmin} />}
        {isAdmin && <RowButton T={T} icon="🗑️" label="Reset this app" sub="Clears this phone only — rewards stay on chain" danger last
          onClick={() => { if (window.confirm("Reset all app data on this phone and disconnect? Your rewards stay on the blockchain.")) onReset?.(); }} />}
      </div>

      <div style={{fontSize:11,color:T.textSoft,textAlign:"center",margin:"8px 0 18px"}}>Green Utility Log · {NETWORK_LABEL}</div>
    </>
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
      { t:"Register your meters", d:"Enter your electricity meter number and its current reading (the starting point)." },
      { t:"Submit a reading", d:"Go to Meter, photograph the meter (the app reads the number for you), check it, and send." },
      { t:"Earn B3TR", d:"Every kWh you use below the target (8 kWh a day) earns B3TR on testnet. Your first reading sets your starting point; a reading without savings is recorded, not rewarded. Track your total on Home and your position on the Leaderboard." },
    ], faqs:[
      { q:"Where do I find my meter number?", a:"Two spots on the meter:\n1) On the little screen — press the meter's buttons until the number appears.\n2) Under the barcode, on a sticker on the front or side.\nEnter the whole number including the letter — electricity usually starts with E, gas with G. It's also on your energy bill or your supplier's online account." },
      { q:"Automatic reading (P1 reader / HomeWizard / Powerfox / Tibber)", a:"With a P1 reader, Home Assistant, or another reader, your meter can send its own reading — then you never photograph again.\nHave a Powerfox (poweropti) or a Tibber Pulse? Pick it in the setup: we can fetch your reading from their cloud, nothing to install.\nDo one photo submission first (it sets your starting point), then open Meter → the ⚡ link at the bottom → ⚙️ Automatic setup for your token and the ready-made setup.\nFull step-by-step guide for every setup: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Where do I paste the setup code?", a:"In a terminal on the device that stays on — Windows: PowerShell · Mac: Terminal · Pi/NAS: SSH. That device needs Node.js 22+.\nUsing Home Assistant? No terminal at all — install our integration via HACS. (The separate GreenUtilityLog Meter Bridge add-on runs the bridge on Home Assistant OS instead.)\nStep-by-step with screenshots of every route: https://greenutilitylog.github.io/GreenUtilityLog/guide.html\nToo technical? Just take a photo — that works just as well." },
      { q:"Which meters work?", a:"Netherlands, Belgium, Luxembourg: almost any smart meter with a P1 port, with a HomeWizard P1 (Belgium: switch the port on for free in the Fluvius portal · Luxembourg: ask your grid operator for the P1 key).\nDenmark, Sweden, Hungary: a HomeWizard P1 too, once your grid operator switches the port on (Hungary: some meters only). Does it fit your meter? https://helpdesk.homewizard.com/nl/articles/5935311-werkt-de-p1-meter-met-mijn-slimme-meter\nGermany: a Powerfox poweropti, or a Tasmota reading head (Hichi).\nSweden, Norway, Denmark, Finland: a Tibber Pulse.\nFrance, UK, Spain, Italy: no P1 port — for now only through Home Assistant.\nUSA and Canada: no P1 port — photos work if your meter's display shows the kWh total; Home Assistant with a Rainforest EAGLE where your utility allows it.\nEverywhere: if Home Assistant shows your meter's kWh total, it works. And photos always work.\nAll the details per country: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Do I always need a photo?", a:"A photo is required for a hand-entered reading. A connected P1 reader can submit without a photo, because its device token binds the reading to your wallet. One photo every 30 days keeps automatic payouts going; the app tells you a week ahead." },
      { q:"Is this real money?", a:"No. Everything runs on VeChain testnet, so the B3TR you earn are test tokens with no real value — perfect for trying things out safely." },
      { q:"I submitted but got no B3TR — why?", a:"Your first reading only sets your starting point, and a reading where you used the target (8 kWh a day) or more is recorded without a reward — B3TR comes only from kWh saved. Refused altogether? Most common reasons: the new reading isn't higher than your last one, the photo was reused, or a cooldown is active for that utility. Another wallet was already paid on this phone? One person, one wallet: only the first wallet on a phone can earn. Try a fresh photo of an actual meter." },
      { q:"My photo was rejected.", a:"Use a real, clear photo of your own meter — good lighting, numbers in focus, no screenshots or photos of a screen." },
      { q:"I reconnected and lost my meters?", a:"Reconnecting the SAME wallet keeps your meters and baselines. Only connecting a different wallet starts a fresh setup." },
      { q:"My wallet won't connect.", a:"Make sure VeWorld is switched to Testnet. On mobile, use the in-app browser or WalletConnect QR." },
      { q:"What do you store about me?", a:"On the blockchain (public and permanent): your wallet address, your meter number, each reading and what it earned. That is the proof of saving VeBetterDAO asks for.\nOn our server: your meter's readings and waiting time, a fingerprint of each photo (so it can't be reused) and, for review, a small copy of the photo for up to 30 days. Photos can be read and checked by an AI service (Anthropic's Claude) to spot fakes.\nFrom your phone: a random app id and a scrambled code (hash) made from what the browser reports about the device: screen, language, time zone, graphics. Only these two codes leave the phone. They can't be turned back into who you are; they stop one phone from earning with many wallets.\nA Powerfox login or Tibber token is stored encrypted and used only to read your meter; unlinking deletes it. Your name and avatar stay on this phone." },
      { q:"Found a bug or have an idea?", a:"Use Send Feedback below — it pre-fills an email with your message and some helpful diagnostics." },
    ] },
  nl: { name:"Nederlands", subtitle:"Aan de slag", quick:"Snel starten", faqLabel:"Veelgestelde vragen", close:"Sluiten", feedback:"✉️ Feedback sturen",
    steps:[
      { t:"Verbind je wallet", d:"Tik op Connect en open VeWorld (op Testnet) of WalletConnect. Dit is een test-app — er wordt geen echt geld gebruikt." },
      { t:"Registreer je meters", d:"Voer het nummer van je stroommeter en de huidige stand (het startpunt) in." },
      { t:"Doe een inzending", d:"Ga naar Meter, fotografeer je meter (de app leest het nummer), controleer het en verstuur." },
      { t:"Verdien B3TR", d:"Elke kWh die je onder de norm (8 kWh per dag) blijft, levert B3TR op testnet op. Je eerste stand is je beginpunt; een stand zonder besparing wordt vastgelegd, niet beloond. Zie je totaal op Home en je positie in het klassement." },
    ], faqs:[
      { q:"Waar vind ik mijn meternummer?", a:"Twee plekken op de meter:\n1) Op het schermpje — druk op de knopjes tot het nummer verschijnt.\n2) Onder de streepjescode, op een sticker aan de voor- of zijkant.\nNeem het hele nummer over, mét de letter — stroom begint meestal met E, gas met G. Het staat ook op je energierekening of in je online account bij je leverancier." },
      { q:"Automatisch uitlezen (P1-reader / HomeWizard / Powerfox / Tibber)", a:"Met een P1-reader, Home Assistant of een andere reader kan je meter z’n eigen stand doorsturen — dan fotografeer je nooit meer.\nHeb je een Powerfox (poweropti) of een Tibber Pulse? Kies die in de instellingen: wij kunnen je stand uit hun cloud halen, niets te installeren.\nDoe eerst één foto-inzending (dat is je startpunt), ga dan naar Meter → de ⚡-link onderaan → ⚙️ Automatisch instellen voor je token en de kant-en-klare instellingen.\nVolledige stap-voor-stap gids voor elke situatie: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Waar plak ik de setup-code?", a:"In een terminal op het apparaat dat altijd aan staat — Windows: PowerShell · Mac: Terminal · Pi/NAS: SSH. Daar moet Node.js 22+ op staan.\nGebruik je Home Assistant? Dan helemaal geen terminal — installeer onze integratie via HACS. (De aparte add-on GreenUtilityLog Meter Bridge draait in plaats daarvan de bridge op Home Assistant OS.)\nStap voor stap voor elke route: https://greenutilitylog.github.io/GreenUtilityLog/guide.html\nTe technisch? Maak gewoon een foto — dat werkt net zo goed." },
      { q:"Welke meters werken?", a:"Nederland, België, Luxemburg: bijna elke slimme meter met een P1-poort, met een HomeWizard P1 (België: zet de poort gratis aan in het Fluvius-portaal · Luxemburg: vraag de P1-sleutel aan je netbeheerder).\nDenemarken, Zweden, Hongarije: ook een HomeWizard P1, zodra je netbeheerder de poort aanzet (Hongarije: alleen sommige meters). Past hij op jouw meter? https://helpdesk.homewizard.com/nl/articles/5935311-werkt-de-p1-meter-met-mijn-slimme-meter\nDuitsland: een Powerfox poweropti, of een Tasmota-leeskop (Hichi).\nZweden, Noorwegen, Denemarken, Finland: een Tibber Pulse.\nFrankrijk, VK, Spanje, Italië: geen P1-poort — voorlopig alleen via Home Assistant.\nVS en Canada: geen P1-poort — foto’s werken als de display van je meter de kWh-stand toont; Home Assistant met een Rainforest EAGLE waar je netbeheerder dat toestaat.\nOveral: toont Home Assistant de kWh-stand van je meter, dan werkt het. En foto’s werken altijd.\nAlles per land: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Heb ik altijd een foto nodig?", a:"Voor een handmatig ingevoerde stand is een foto verplicht. Een gekoppelde P1-reader mag zonder foto insturen, omdat zijn device-token de stand aan jouw wallet koppelt. Eén foto per 30 dagen houdt de automatische uitbetalingen gaande; de app waarschuwt een week van tevoren." },
      { q:"Is dit echt geld?", a:"Nee. Alles draait op VeChain testnet, dus de B3TR die je verdient zijn test-tokens zonder echte waarde — perfect om veilig te testen." },
      { q:"Ik heb ingezonden maar geen B3TR — waarom?", a:"Je eerste stand legt alleen je beginpunt vast, en een stand waarbij je de norm (8 kWh per dag) of meer verbruikte wordt vastgelegd zonder beloning — B3TR komt alleen uit bespaarde kWh. Helemaal geweigerd? Meest voorkomend: de nieuwe stand is niet hoger dan je vorige, de foto is hergebruikt, of er is een cooldown actief. Is er op deze telefoon al een andere wallet uitbetaald? Eén persoon, één wallet: alleen de eerste wallet op een telefoon kan verdienen. Probeer een verse foto van een echte meter." },
      { q:"Mijn foto werd geweigerd.", a:"Gebruik een echte, scherpe foto van je eigen meter — goed licht, cijfers in beeld, geen screenshots of foto's van een scherm." },
      { q:"Ik verbond opnieuw en mijn meters zijn weg?", a:"Opnieuw verbinden met DEZELFDE wallet behoudt je meters en baselines. Alleen een ándere wallet start opnieuw." },
      { q:"Mijn wallet verbindt niet.", a:"Zorg dat VeWorld op Testnet staat. Op mobiel: gebruik de in-app browser of WalletConnect-QR." },
      { q:"Wat bewaren jullie over mij?", a:"Op de blockchain (openbaar en blijvend): je wallet-adres, je meternummer, elke stand en wat die opleverde. Dat is het bewijs van besparing waar VeBetterDAO om vraagt.\nOp onze server: de standen en wachttijd van je meter, een vingerafdruk van elke foto (zodat die niet opnieuw gebruikt kan worden) en, ter controle, een kleine kopie van de foto, maximaal 30 dagen. Foto's kunnen door een AI-dienst (Claude van Anthropic) gelezen en gecontroleerd worden om nep te herkennen.\nVan je telefoon: een willekeurige app-code en een versleutelde code (hash) van wat de browser over het toestel meldt: scherm, taal, tijdzone, grafische chip. Alleen deze twee codes verlaten de telefoon. Ze zijn niet terug te rekenen naar wie je bent; ze voorkomen dat één telefoon met veel wallets verdient.\nEen Powerfox-login of Tibber-token wordt versleuteld bewaard en alleen gebruikt om je meter uit te lezen; ontkoppelen wist hem. Je naam en avatar blijven op deze telefoon." },
      { q:"Bug gevonden of een idee?", a:"Gebruik Feedback sturen hieronder — het vult een e-mail voor met je bericht en handige diagnostiek." },
    ] },
  de: { name:"Deutsch", subtitle:"Erste Schritte", quick:"Schnellstart", faqLabel:"Häufige Fragen", close:"Schließen", feedback:"✉️ Feedback senden",
    steps:[
      { t:"Wallet verbinden", d:"Tippe auf Connect und öffne VeWorld (auf Testnet) oder WalletConnect. Dies ist eine Test-App — es wird kein echtes Geld verwendet." },
      { t:"Zähler registrieren", d:"Gib die Nummer deines Stromzählers und den aktuellen Stand (den Startwert) ein." },
      { t:"Stand einreichen", d:"Geh zu Zähler, fotografiere deinen Zähler (die App liest die Zahl), prüfe sie und sende." },
      { t:"B3TR verdienen", d:"Jede kWh unter dem Zielwert (8 kWh pro Tag) bringt dir B3TR im Testnet. Dein erster Stand ist dein Startpunkt; ein Stand ohne Einsparung wird erfasst, aber nicht belohnt. Sieh dein Gesamt auf Home und deine Position in der Rangliste." },
    ], faqs:[
      { q:"Wo finde ich meine Zählernummer?", a:"Zwei Stellen am Zähler:\n1) Auf dem kleinen Display — drücke die Tasten, bis die Nummer erscheint.\n2) Unter dem Barcode, auf einem Aufkleber vorne oder seitlich.\nGib die ganze Nummer inklusive Buchstabe ein — Strom beginnt meist mit E, Gas mit G. Sie steht auch auf deiner Energierechnung oder im Online-Konto deines Anbieters." },
      { q:"Automatisches Auslesen (P1-Reader / HomeWizard / Powerfox / Tibber)", a:"Mit einem P1-Reader, Home Assistant oder einem anderen Reader kann dein Zähler seinen Stand selbst senden — dann fotografierst du nie wieder.\nDu hast einen Powerfox (poweropti) oder einen Tibber Pulse? Wähl ihn in der Einrichtung: Wir holen deinen Stand aus deren Cloud, nichts zu installieren.\nMach zuerst eine Foto-Einreichung (das ist dein Startpunkt), dann Zähler → der ⚡-Link unten → ⚙️ Automatische Einrichtung für Token und fertige Einrichtung.\nVollständige Schritt-für-Schritt-Anleitung: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Wo füge ich den Setup-Code ein?", a:"In einem Terminal auf dem Dauergerät — Windows: PowerShell · Mac: Terminal · Pi/NAS: SSH. Dort muss Node.js 22+ installiert sein.\nDu nutzt Home Assistant? Gar kein Terminal — installiere unsere Integration über HACS. (Das separate Add-on GreenUtilityLog Meter Bridge betreibt stattdessen die Bridge auf Home Assistant OS.)\nSchritt für Schritt für jede Route: https://greenutilitylog.github.io/GreenUtilityLog/guide.html\nZu technisch? Mach einfach ein Foto — das funktioniert genauso gut." },
      { q:"Welche Zähler funktionieren?", a:"Niederlande, Belgien, Luxemburg: fast jeder Smart-Zähler mit P1-Anschluss, mit einem HomeWizard P1 (Belgien: den Port kostenlos im Fluvius-Portal einschalten · Luxemburg: den P1-Schlüssel beim Netzbetreiber anfragen).\nDänemark, Schweden, Ungarn: auch ein HomeWizard P1, sobald der Netzbetreiber den Port einschaltet (Ungarn: nur manche Zähler). Passt er zu deinem Zähler? https://helpdesk.homewizard.com/nl/articles/5935311-werkt-de-p1-meter-met-mijn-slimme-meter\nDeutschland: ein Powerfox poweropti oder ein Tasmota-Lesekopf (Hichi).\nSchweden, Norwegen, Dänemark, Finnland: ein Tibber Pulse.\nFrankreich, UK, Spanien, Italien: kein P1-Port — vorerst nur über Home Assistant.\nUSA und Kanada: kein P1-Port — Fotos gehen, wenn das Display deines Zählers den kWh-Stand zeigt; Home Assistant mit einem Rainforest EAGLE, wo dein Versorger das erlaubt.\nÜberall: Zeigt Home Assistant den kWh-Stand deines Zählers, funktioniert es. Und Fotos gehen immer.\nAlles pro Land: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Brauche ich immer ein Foto?", a:"Für einen manuell eingegebenen Stand ist ein Foto nötig. Ein verbundener P1-Reader darf ohne Foto senden, weil sein Geräte-Token den Stand an dein Wallet bindet. Ein Foto alle 30 Tage hält die automatischen Auszahlungen am Laufen; die App erinnert eine Woche vorher." },
      { q:"Ist das echtes Geld?", a:"Nein. Alles läuft im VeChain-Testnet, die B3TR sind Test-Token ohne realen Wert — ideal zum sicheren Ausprobieren." },
      { q:"Ich habe eingereicht, aber kein B3TR — warum?", a:"Dein erster Stand legt nur den Startpunkt fest, und ein Stand, bei dem du den Zielwert (8 kWh pro Tag) oder mehr verbraucht hast, wird ohne Belohnung erfasst — B3TR gibt es nur für eingesparte kWh. Ganz abgelehnt? Häufigste Gründe: der neue Stand ist nicht höher als der letzte, das Foto wurde wiederverwendet, oder eine Sperrzeit ist aktiv. Wurde auf diesem Handy schon eine andere Wallet ausgezahlt? Eine Person, eine Wallet: nur die erste Wallet auf einem Handy kann verdienen. Versuch ein frisches Foto eines echten Zählers." },
      { q:"Mein Foto wurde abgelehnt.", a:"Nutze ein echtes, scharfes Foto deines eigenen Zählers — gutes Licht, Ziffern im Fokus, keine Screenshots oder Bildschirmfotos." },
      { q:"Neu verbunden und meine Zähler sind weg?", a:"Erneutes Verbinden mit DEMSELBEN Wallet behält deine Zähler und Basiswerte. Nur ein anderes Wallet startet neu." },
      { q:"Mein Wallet verbindet nicht.", a:"Stelle sicher, dass VeWorld auf Testnet steht. Mobil: nutze den In-App-Browser oder WalletConnect-QR." },
      { q:"Was speichert ihr über mich?", a:"Auf der Blockchain (öffentlich und dauerhaft): deine Wallet-Adresse, deine Zählernummer, jeder Zählerstand und was er eingebracht hat. Das ist der Nachweis der Einsparung, den VeBetterDAO verlangt.\nAuf unserem Server: die Stände und die Wartezeit deines Zählers, ein Fingerabdruck jedes Fotos (damit es nicht erneut verwendet wird) und zur Kontrolle eine kleine Kopie des Fotos für höchstens 30 Tage. Fotos können von einem KI-Dienst (Claude von Anthropic) gelesen und geprüft werden, um Fälschungen zu erkennen.\nVon deinem Handy: eine zufällige App-Kennung und ein verschlüsselter Code (Hash) aus dem, was der Browser über das Gerät meldet: Bildschirm, Sprache, Zeitzone, Grafikchip. Nur diese zwei Codes verlassen das Handy. Sie lassen sich nicht auf deine Person zurückführen; sie verhindern, dass ein Handy mit vielen Wallets verdient.\nEin Powerfox-Login oder Tibber-Token wird verschlüsselt gespeichert und nur zum Auslesen deines Zählers genutzt; Trennen löscht ihn. Dein Name und Avatar bleiben auf diesem Handy." },
      { q:"Bug gefunden oder eine Idee?", a:"Nutze Feedback senden unten — es füllt eine E-Mail mit deiner Nachricht und hilfreicher Diagnose vor." },
    ] },
  fr: { name:"Français", subtitle:"Démarrer", quick:"Démarrage rapide", faqLabel:"Questions fréquentes", close:"Fermer", feedback:"✉️ Envoyer un retour",
    steps:[
      { t:"Connectez votre wallet", d:"Touchez Connect et ouvrez VeWorld (sur Testnet) ou WalletConnect. C'est une app de test — aucun fonds réel n'est utilisé." },
      { t:"Enregistrez vos compteurs", d:"Saisissez le numéro de votre compteur d'électricité et son relevé actuel (le point de départ)." },
      { t:"Envoyez un relevé", d:"Allez dans Compteur, photographiez votre compteur (l'app lit le relevé), vérifiez-le et envoyez." },
      { t:"Gagnez des B3TR", d:"Chaque kWh sous l'objectif (8 kWh par jour) vous rapporte des B3TR sur testnet. Votre premier relevé est votre point de départ ; un relevé sans économie est enregistré, pas récompensé. Suivez votre total sur Home et votre place au classement." },
    ], faqs:[
      { q:"Où trouver le numéro de mon compteur ?", a:"Deux endroits sur le compteur :\n1) Sur le petit écran — appuyez sur les boutons jusqu'à voir le numéro.\n2) Sous le code-barres, sur une étiquette à l'avant ou sur le côté.\nSaisissez tout le numéro avec la lettre — l'électricité commence souvent par E, le gaz par G. Il figure aussi sur votre facture ou votre compte en ligne fournisseur." },
      { q:"Lecture automatique (lecteur P1 / HomeWizard / Powerfox / Tibber)", a:"Avec un lecteur P1, Home Assistant ou un autre lecteur, votre compteur envoie son relevé lui-même — vous ne photographiez plus.\nVous avez un Powerfox (poweropti) ou un Tibber Pulse ? Choisissez-le dans la configuration : nous récupérons votre relevé dans leur cloud, rien à installer.\nFaites d'abord un envoi photo (c'est votre point de départ), puis Compteur → le lien ⚡ en bas → ⚙️ Configuration automatique pour le jeton et la configuration prête.\nGuide complet pas à pas : https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Où coller le code de configuration ?", a:"Dans un terminal sur l\u2019appareil qui reste allumé — Windows : PowerShell · Mac : Terminal · Pi/NAS : SSH. Il faut Node.js 22+.\nVous utilisez Home Assistant ? Aucun terminal — installez notre intégration via HACS. (L’add-on séparé GreenUtilityLog Meter Bridge fait plutôt tourner le bridge sur Home Assistant OS.)\nPas à pas pour chaque route : https://greenutilitylog.github.io/GreenUtilityLog/guide.html\nTrop technique ? Prenez simplement une photo." },
      { q:"Quels compteurs fonctionnent ?", a:"Pays-Bas, Belgique, Luxembourg : presque tout compteur intelligent avec un port P1, avec un HomeWizard P1 (Belgique : activez le port gratuitement dans le portail Fluvius · Luxembourg : demandez la clé P1 à votre gestionnaire de réseau).\nDanemark, Suède, Hongrie : un HomeWizard P1 aussi, dès que le gestionnaire de réseau active le port (Hongrie : certains compteurs seulement). Compatible avec votre compteur ? https://helpdesk.homewizard.com/nl/articles/5935311-werkt-de-p1-meter-met-mijn-slimme-meter\nAllemagne : un Powerfox poweropti, ou une tête de lecture Tasmota (Hichi).\nSuède, Norvège, Danemark, Finlande : un Tibber Pulse.\nFrance, Royaume-Uni, Espagne, Italie : pas de port P1 — pour l'instant seulement via Home Assistant.\nÉtats-Unis et Canada : pas de port P1 — les photos marchent si l'afficheur de votre compteur montre le total kWh ; Home Assistant avec un Rainforest EAGLE là où votre distributeur l'autorise.\nPartout : si Home Assistant affiche le total kWh de votre compteur, ça marche. Et les photos marchent toujours.\nTout par pays : https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"Faut-il toujours une photo ?", a:"Une photo est requise pour un relevé saisi à la main. Un lecteur P1 connecté peut envoyer sans photo, car son jeton d'appareil lie le relevé à votre wallet. Une photo tous les 30 jours garde les paiements automatiques actifs ; l'app prévient une semaine avant." },
      { q:"Est-ce de l'argent réel ?", a:"Non. Tout tourne sur le testnet VeChain ; les B3TR gagnés sont des jetons de test sans valeur réelle — parfait pour essayer en toute sécurité." },
      { q:"J'ai envoyé mais aucun B3TR — pourquoi ?", a:"Votre premier relevé ne fixe que votre point de départ, et un relevé où vous avez consommé l'objectif (8 kWh par jour) ou plus est enregistré sans récompense — les B3TR viennent uniquement des kWh économisés. Refusé ? Raisons fréquentes : le nouveau relevé n'est pas supérieur au précédent, la photo a été réutilisée, ou un délai est actif. Un autre wallet a déjà été payé sur ce téléphone ? Une personne, un wallet : seul le premier wallet d'un téléphone peut gagner. Essayez une photo fraîche d'un vrai compteur." },
      { q:"Ma photo a été refusée.", a:"Utilisez une vraie photo nette de votre compteur — bon éclairage, chiffres nets, pas de captures ni photos d'écran." },
      { q:"Reconnecté et j'ai perdu mes compteurs ?", a:"Se reconnecter avec le MÊME wallet garde vos compteurs et bases. Seul un autre wallet repart de zéro." },
      { q:"Mon wallet ne se connecte pas.", a:"Assurez-vous que VeWorld est sur Testnet. Sur mobile : navigateur intégré ou QR WalletConnect." },
      { q:"Que conservez-vous à mon sujet ?", a:"Sur la blockchain (public et permanent) : l'adresse de votre wallet, votre numéro de compteur, chaque relevé et ce qu'il a rapporté. C'est la preuve d'économie que demande VeBetterDAO.\nSur notre serveur : les relevés et le délai d'attente de votre compteur, une empreinte de chaque photo (pour qu'elle ne soit pas réutilisée) et, pour vérification, une petite copie de la photo pendant 30 jours au plus. Les photos peuvent être lues et vérifiées par un service d'IA (Claude d'Anthropic) pour repérer les faux.\nDe votre téléphone : un identifiant d'app aléatoire et un code chiffré (hash) de ce que le navigateur indique sur l'appareil : écran, langue, fuseau horaire, puce graphique. Seuls ces deux codes quittent le téléphone. Ils ne permettent pas de savoir qui vous êtes ; ils empêchent un seul téléphone de gagner avec plusieurs wallets.\nUn identifiant Powerfox ou un jeton Tibber est conservé chiffré et sert uniquement à lire votre compteur ; le déconnecter l'efface. Votre nom et votre avatar restent sur ce téléphone." },
      { q:"Un bug ou une idée ?", a:"Utilisez Envoyer un retour ci-dessous — un e-mail est prérempli avec votre message et quelques infos utiles." },
    ] },
  es: { name:"Español", subtitle:"Empezar", quick:"Inicio rápido", faqLabel:"Preguntas frecuentes", close:"Cerrar", feedback:"✉️ Enviar comentarios",
    steps:[
      { t:"Conecta tu wallet", d:"Toca Connect y abre VeWorld (en Testnet) o WalletConnect. Es una app de prueba — no se usa dinero real." },
      { t:"Registra tus contadores", d:"Introduce el número de tu contador de luz y su lectura actual (el punto de partida)." },
      { t:"Envía una lectura", d:"Ve a Contador, fotografía tu contador (la app lee la lectura), revísala y envía." },
      { t:"Gana B3TR", d:"Cada kWh por debajo del objetivo (8 kWh al día) te da B3TR en testnet. Tu primera lectura es tu punto de partida; una lectura sin ahorro se registra, pero no se premia. Mira tu total en Home y tu puesto en la clasificación." },
    ], faqs:[
      { q:"¿Dónde encuentro el número de mi contador?", a:"Dos sitios en el contador:\n1) En la pantallita — pulsa los botones hasta que aparezca el número.\n2) Bajo el código de barras, en una pegatina delante o al lado.\nIntroduce el número completo con la letra — la luz suele empezar por E, el gas por G. También está en tu factura o en la cuenta online de tu comercializadora." },
      { q:"Lectura automática (lector P1 / HomeWizard / Powerfox / Tibber)", a:"Con un lector P1, Home Assistant u otro lector, tu contador envía su lectura solo — ya no fotografías más.\n¿Tienes un Powerfox (poweropti) o un Tibber Pulse? Elígelo en la configuración: recogemos tu lectura de su nube, nada que instalar.\nHaz primero un envío con foto (es tu punto de partida), luego Contador → el enlace ⚡ de abajo → ⚙️ Configuración automática para el token y la configuración lista.\nGuía completa paso a paso: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"¿Dónde pego el código de configuración?", a:"En una terminal en el dispositivo que queda encendido — Windows: PowerShell · Mac: Terminal · Pi/NAS: SSH. Necesita Node.js 22+.\n¿Usas Home Assistant? Ninguna terminal — instala nuestra integración vía HACS. (El add-on aparte GreenUtilityLog Meter Bridge ejecuta en cambio el bridge en Home Assistant OS.)\nPaso a paso para cada ruta: https://greenutilitylog.github.io/GreenUtilityLog/guide.html\n¿Demasiado técnico? Solo haz una foto." },
      { q:"¿Qué contadores funcionan?", a:"Países Bajos, Bélgica, Luxemburgo: casi cualquier contador inteligente con puerto P1, con un HomeWizard P1 (Bélgica: activa el puerto gratis en el portal de Fluvius · Luxemburgo: pide la clave P1 a tu distribuidora).\nDinamarca, Suecia, Hungría: también un HomeWizard P1, cuando la distribuidora active el puerto (Hungría: solo algunos contadores). ¿Sirve para tu contador? https://helpdesk.homewizard.com/nl/articles/5935311-werkt-de-p1-meter-met-mijn-slimme-meter\nAlemania: un Powerfox poweropti, o un cabezal Tasmota (Hichi).\nSuecia, Noruega, Dinamarca, Finlandia: un Tibber Pulse.\nFrancia, Reino Unido, España, Italia: sin puerto P1 — por ahora solo con Home Assistant.\nEE. UU. y Canadá: sin puerto P1 — las fotos funcionan si la pantalla del contador muestra el total de kWh; Home Assistant con un Rainforest EAGLE donde tu compañía lo permita.\nEn todas partes: si Home Assistant muestra el total kWh de tu contador, funciona. Y las fotos siempre funcionan.\nTodo por país: https://greenutilitylog.github.io/GreenUtilityLog/guide.html" },
      { q:"¿Siempre necesito una foto?", a:"Se requiere foto para una lectura escrita a mano. Un lector P1 conectado puede enviar sin foto, porque su token de dispositivo vincula la lectura a tu wallet. Una foto cada 30 días mantiene los pagos automáticos; la app avisa una semana antes." },
      { q:"¿Es dinero real?", a:"No. Todo corre en el testnet de VeChain; los B3TR son tokens de prueba sin valor real — perfecto para probar con seguridad." },
      { q:"Envié pero no recibí B3TR — ¿por qué?", a:"Tu primera lectura solo fija tu punto de partida, y una lectura en la que usaste el objetivo (8 kWh al día) o más se registra sin premio — los B3TR solo vienen de kWh ahorrados. ¿Rechazada? Motivos comunes: la nueva lectura no es mayor que la anterior, la foto se reutilizó, o hay un tiempo de espera activo. ¿Ya cobró otro wallet en este teléfono? Una persona, un wallet: solo el primer wallet de un teléfono puede ganar. Prueba una foto nueva de un contador real." },
      { q:"Rechazaron mi foto.", a:"Usa una foto real y nítida de tu propio contador — buena luz, cifras enfocadas, sin capturas ni fotos de pantalla." },
      { q:"Reconecté y perdí mis contadores.", a:"Reconectar con la MISMA wallet mantiene tus contadores y bases. Solo otra wallet empieza de cero." },
      { q:"Mi wallet no conecta.", a:"Asegúrate de que VeWorld esté en Testnet. En móvil: navegador interno o QR de WalletConnect." },
      { q:"¿Qué guardáis sobre mí?", a:"En la blockchain (pública y permanente): la dirección de tu wallet, tu número de contador, cada lectura y lo que te dio. Es la prueba de ahorro que pide VeBetterDAO.\nEn nuestro servidor: las lecturas y el tiempo de espera de tu contador, una huella de cada foto (para que no se reutilice) y, para revisión, una copia pequeña de la foto durante 30 días como máximo. Las fotos pueden ser leídas y revisadas por un servicio de IA (Claude de Anthropic) para detectar falsificaciones.\nDe tu teléfono: un identificador de app aleatorio y un código cifrado (hash) de lo que el navegador indica del dispositivo: pantalla, idioma, zona horaria, chip gráfico. Solo estos dos códigos salen del teléfono. No permiten saber quién eres; evitan que un solo teléfono gane con muchas wallets.\nUn acceso de Powerfox o un token de Tibber se guarda cifrado y solo se usa para leer tu contador; al desvincularlo se borra. Tu nombre y avatar se quedan en este teléfono." },
      { q:"¿Un fallo o una idea?", a:"Usa Enviar comentarios abajo — rellena un correo con tu mensaje y algunos datos útiles." },
    ] },
};

// The help above is written for testnet ("test tokens, no real money"). On the
// mainnet build those four answers would be untrue, so they are replaced.
const HELP_MAINNET = {
  en: { connect: "Tap Connect and open VeWorld (set to Mainnet) or WalletConnect.", earn: "Every kWh you use below the target (8 kWh a day) earns real B3TR in your own wallet. Your first reading sets your starting point; a reading without savings is recorded, not rewarded. Track your total on Home and your position on the Leaderboard.", real: "Yes. The app runs on VeChain mainnet: the B3TR you earn are real tokens in your own wallet. The amount per kWh saved follows the weekly VeBetterDAO budget.", wallet: "Make sure VeWorld is switched to Mainnet. On mobile, use the in-app browser or WalletConnect QR." },
  nl: { connect: "Tik op Connect en open VeWorld (op Mainnet) of WalletConnect.", earn: "Elke kWh onder de norm (8 kWh per dag) levert echte B3TR op in je eigen wallet. Je eerste stand is je beginpunt; een stand zonder besparing wordt vastgelegd, niet beloond. Zie je totaal op Home en je positie in het klassement.", real: "Ja. De app draait op VeChain mainnet: de B3TR die je verdient zijn echte tokens in je eigen wallet. Het bedrag per bespaarde kWh volgt het wekelijkse budget van VeBetterDAO.", wallet: "Zorg dat VeWorld op Mainnet staat. Op mobiel: gebruik de in-app browser of WalletConnect-QR." },
  de: { connect: "Tippe auf Connect und öffne VeWorld (auf Mainnet) oder WalletConnect.", earn: "Jede kWh unter dem Zielwert (8 kWh pro Tag) bringt dir echte B3TR in deine eigene Wallet. Dein erster Stand ist dein Startpunkt; ein Stand ohne Einsparung wird erfasst, aber nicht belohnt. Sieh dein Gesamt auf Home und deine Position in der Rangliste.", real: "Ja. Die App läuft im VeChain-Mainnet: die B3TR, die du verdienst, sind echte Token in deiner eigenen Wallet. Der Betrag pro eingesparter kWh folgt dem wöchentlichen VeBetterDAO-Budget.", wallet: "Stelle sicher, dass VeWorld auf Mainnet steht. Mobil: nutze den In-App-Browser oder WalletConnect-QR." },
  fr: { connect: "Touchez Connect et ouvrez VeWorld (sur Mainnet) ou WalletConnect.", earn: "Chaque kWh sous l'objectif (8 kWh par jour) vous rapporte de vrais B3TR dans votre propre wallet. Votre premier relevé est votre point de départ ; un relevé sans économie est enregistré, pas récompensé. Suivez votre total sur Home et votre place au classement.", real: "Oui. L’app tourne sur le mainnet VeChain : les B3TR gagnés sont de vrais jetons dans votre propre wallet. Le montant par kWh économisé suit le budget hebdomadaire de VeBetterDAO.", wallet: "Assurez-vous que VeWorld est sur Mainnet. Sur mobile : navigateur intégré ou QR WalletConnect." },
  es: { connect: "Toca Connect y abre VeWorld (en Mainnet) o WalletConnect.", earn: "Cada kWh por debajo del objetivo (8 kWh al día) te da B3TR reales en tu propio wallet. Tu primera lectura es tu punto de partida; una lectura sin ahorro se registra, pero no se premia. Mira tu total en Home y tu puesto en la clasificación.", real: "Sí. La app funciona en la mainnet de VeChain: los B3TR que ganas son tokens reales en tu propio wallet. La cantidad por kWh ahorrado sigue el presupuesto semanal de VeBetterDAO.", wallet: "Asegúrate de que VeWorld esté en Mainnet. En móvil: navegador interno o QR de WalletConnect." },
};
if (NETWORK === "mainnet") {
  for (const [lang, h] of Object.entries(HELP_MAINNET)) {
    const L = HELP_I18N[lang];
    if (!L) continue;
    let step = 0, faq = 0;
    L.steps = L.steps.map((st) => (/testnet/i.test(st.d) ? { ...st, d: step++ === 0 ? h.connect : h.earn } : st));
    L.faqs = L.faqs.map((f) => (/testnet/i.test(f.a) ? { ...f, a: faq++ === 0 ? h.real : h.wallet } : f));
  }
}

function HelpScreen({ onClose, onFeedback, onLang, T }) {
  const dlg = useDialog(onClose, t("hdr.help"));
  const [lang, setHelpLang] = useState(() => (HELP_I18N[getLang()] ? getLang() : "en"));
  // Picking a language here sets it for the whole app (i18n.js).
  const pickLang = (l) => { setHelpLang(l); onLang?.(l); };
  const L = HELP_I18N[lang] || HELP_I18N.en;
  const steps = L.steps.map((s, i) => ({ n: i + 1, t: s.t, d: s.d }));
  const faqs = L.faqs;
  const [openFaq, setOpenFaq] = useState(0); // accordion — first item open by default
  const row = { background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:"12px 14px", marginBottom:8 };
  return (
    <div {...dlg} style={{position:"fixed",inset:OVERLAY_INSET,background:T.bg,zIndex:330,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>{t("help.title")}</div>
          <div style={{fontSize:10.5,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>{L.subtitle} · {NETWORK_LABEL}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 14px",minHeight:44,fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>{L.close}</button>
      </div>

      {/* Language picker */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",padding:"9px 14px",borderBottom:`1px solid ${T.border}`}}>
        <span style={{fontSize:14}}>🌐</span>
        {Object.keys(HELP_I18N).map(code => (
          <button key={code} onClick={() => pickLang(code)} style={{font:"inherit",fontSize:12,fontWeight:700,cursor:"pointer",padding:"4px 12px",minHeight:36,borderRadius:999,border:`1px solid ${lang===code?(T.green3||T.electric):T.border}`,background:lang===code?(T.green3||T.electric):"transparent",color:lang===code?"#fff":T.textMid}}>{HELP_I18N[code].name}</button>
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

        {/* Long-form setup lives outside the app — link, don't inline a manual. */}
        <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer"
          style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginTop:16,
            background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"13px 14px",textDecoration:"none"}}>
          <span>
            <span style={{display:"block",fontSize:12.5,fontWeight:700,color:T.text}}>{t("help.guide")}</span>
            <span style={{display:"block",fontSize:10.5,color:T.textSoft,marginTop:2}}>{t("help.guideSub")}</span>
          </span>
          <span style={{color:T.green3,fontWeight:800}}>↗</span>
        </a>

        <button onClick={onFeedback} style={{width:"100%",marginTop:10,background:T.green3,border:"none",borderRadius:6,padding:"13px",color:T === DARK ? T.bg : "#fff",fontSize:12,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",cursor:"pointer"}}>{L.feedback}</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// FEEDBACK  — composes an email to FEEDBACK_EMAIL with diagnostics (no backend)
// ════════════════════════════════════════════════════════════════════════════
function FeedbackScreen({ onClose, onToast, wallet, tab, T }) {
  const dlg = useDialog(onClose, t("pr.feedback"));
  const [kind, setKind] = useState("bug");
  const [msg, setMsg] = useState("");
  const kinds = [
    { id:"bug",   label:t("f.bug") },
    { id:"idea",  label:t("f.idea") },
    { id:"other", label:t("f.other") },
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
    if (!msg.trim()) { onToast?.(t("f.writeFirst")); return; }
    const subject = `Green Utility Log — ${kind} feedback (v${APP_VERSION})`;
    const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(composeBody())}`;
    try { window.location.href = url; onToast?.(t("f.opening")); }
    catch { onToast?.(t("f.noMail")); }
  };
  const copyAll = async () => {
    const text = `Green Utility Log — ${kind} feedback\n\n${composeBody()}`;
    try { await navigator.clipboard.writeText(text); onToast?.(t("f.copied")); }
    catch { onToast?.(t("f.copyFail")); }
  };
  const inputStyle = { width:"100%", boxSizing:"border-box", background:T.card, border:`1px solid ${T.border}`, borderRadius:10, padding:"12px", fontSize:13, color:T.text, fontFamily:"inherit", lineHeight:1.5, resize:"vertical" };
  return (
    <div {...dlg} style={{position:"fixed",inset:OVERLAY_INSET,background:T.bg,zIndex:335,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>{t("f.title")}</div>
          <div style={{fontSize:10.5,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>{NETWORK === "mainnet" ? t("f.sub.main") : t("f.sub.test")}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 14px",minHeight:44,fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>{t("f.close")}</button>
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
          placeholder={kind==="bug" ? t("f.ph.bug") : kind==="idea" ? t("f.ph.idea") : t("f.ph.other")}
          style={inputStyle}
        />
        <div style={{fontSize:10.5,color:T.textSoft,lineHeight:1.55,margin:"10px 2px 16px"}}>
          {t("f.privacy")}
        </div>
        <button onClick={sendEmail} style={{width:"100%",background:T.green3,border:"none",borderRadius:6,padding:"13px",color:T === DARK ? T.bg : "#fff",fontSize:12,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",cursor:"pointer",marginBottom:8}}>{t("f.email")}</button>
        <button onClick={copyAll} style={{width:"100%",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"12px",color:T.textMid,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",cursor:"pointer"}}>{t("f.copy")}</button>
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

// Tappable rows are divs (for layout), marked role="button" + tabIndex so screen
// readers announce them and Tab reaches them. This makes Enter/Space press them,
// as it would a real button.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if ((e.key === "Enter" || e.key === " ") && el instanceof HTMLElement && el.getAttribute("role") === "button" && el.tagName !== "BUTTON") {
      e.preventDefault();
      el.click();
    }
  });
}

export function TestnetBanner() {
  if (!TESTNET_BANNER) return null;
  return (
    // One line, exactly BANNER_H tall: the header and overlays are offset by that.
    <div style={{position:"fixed",top:0,left:0,right:0,zIndex:2147483000,height:BANNER_H,boxSizing:"border-box",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",background:"#7a4a00",color:"#fff",fontSize:11,fontWeight:700,textAlign:"center",padding:"5px 12px",letterSpacing:".3px",lineHeight:"16px",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"}}>
      {t("testnet.banner")}
      {MAIN_APP_URL && <> · <a href={MAIN_APP_URL} style={{color:"#fff",textDecoration:"underline"}}>{t("testnet.realApp")}</a></>}
    </div>
  );
}

export default function App() {
  // Check if user has seen intro before
  const [showIntro, setShowIntro] = useState(() => {
    // Blocked storage (private mode, some in-app browsers) throws here, and this
    // runs before anything else renders — so it must not throw.
    try { return !localStorage.getItem('greenlog_seen_intro'); } catch { return true; }
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
  // Access pass, reported by the backend on connect. `required:false` is the normal
  // case today — the gate is off unless REQUIRE_PASS is set.
  const [passInfo, setPassInfo]     = useState({ required: false, has: true, pass: null, isAdmin: false });
  const [dark, setDark]             = useState(getInitialDark);
  // The language: setLang() updates what t() returns, this state re-renders the app.
  const [lang, setLangState]        = useState(getLang);
  const changeLang = (l) => { setLang(l); setLangState(l); };
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
  // Home's Reader tile opens the Submit screen on the reader view.
  const [startOnReader, setStartOnReader] = useState(false);
  // Wallet connection is handled by VeChain dapp-kit (VeWorld / WalletConnect
  // mobile). useWallet() exposes the connected address and the
  // requestTransaction() signer; useWalletModal() opens the connect dialog.
  const { account, accountDomain, requestTransaction, requestCertificate, disconnect } = useWallet();
  const wallet = account || null;
  setCooldownWallet(wallet);
  // The wallet connected NOW, for async work started under another one: a payout
  // that returns after a wallet switch must not land in the new wallet's history.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const sameWallet = (w) => String(walletRef.current || "").toLowerCase() === String(w || "").toLowerCase();
  // The server's answer about THIS wallet; reset when another one connects, so a
  // wallet never shows the previous one's access.
  const noAccess = !!wallet && passInfo.required && !passInfo.has;

  // Which tariff register the server wants on the next photo, per utility (it
  // checks that the registers take turns — see /reward), refreshed after a payout.
  const [regHint, setRegHint]       = useState({});
  const [regTick, setRegTick]       = useState(0);
  // The server knows this meter has tariff registers (it says which to photograph
  // next): open the two-register fields instead of making the user find the box.
  useEffect(() => {
    if (regHint.electric) setDualTariffRef.current?.(true);
  }, [regHint]);
  const setDualTariffRef = useRef(null);

  // Pre-fill meter numbers an admin assigned to this wallet on the server, so a user
  // who can't find their meter number doesn't have to enter it. Only fills EMPTY slots
  // — never overwrites a number the user typed themselves.
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchT(`${REWARD_API.replace(/\/$/, "")}/meter/registered?address=${wallet}`);
        if (!r.ok) return;
        const d = await r.json().catch(() => ({}));
        const list = Array.isArray(d.meters) ? d.meters : [];
        if (cancelled) return;
        setRegHint(Object.fromEntries(list.filter(m => m.photoRegister).map(m => [m.utility, m.photoRegister])));
        if (!list.length) return;
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
  }, [wallet, regTick]);

  // Bumped when RULES or SERVER_NEXT_AT (module-level, read by the helpers) change,
  // so everything that shows them renders again.
  const [, setRulesVer] = useState(0);

  // A different wallet starts without the previous one's access pass. Only on a
  // wallet change: editing meters re-sends /wallet/seen below, but must not wipe
  // what the server already said about this same wallet. (SERVER_NEXT_AT is reset
  // by setCooldownWallet during render.)
  useEffect(() => {
    setPassInfo({ required: false, has: true, pass: null, isAdmin: false });
    setRulesVer(v => v + 1);
  }, [wallet]);
  // The last reading the server recorded per meter of this wallet (/wallet/seen).
  const [serverLast, setServerLast] = useState(null);
  // Bumped to ask /wallet/seen again, e.g. after a payout whose outcome is unknown.
  const [seenTick, setSeenTick] = useState(0);

  // Let the backend know this wallet is active, so the admin panel can see testers
  // who have connected (and maybe registered meters locally) but not yet earned
  // on-chain. Fire-and-forget; failure is harmless.
  useEffect(() => {
    if (!wallet) return;
    // An answer for a wallet that is no longer connected (or for an older meter
    // list) must not land: it would show that wallet's pass and cooldowns.
    let cancelled = false;
    const list = Object.entries(meters || {}).filter(([, v]) => String(v || "").trim()).map(([k, v]) => `${k}:${v}`);
    fetchT(`${REWARD_API.replace(/\/$/, "")}/wallet/seen`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet, meters: list }),
    })
      // The same call reports whether this wallet holds an access pass. Knowing it up
      // front means we can say so plainly, instead of letting the user photograph a
      // meter, submit, and only then hit a 403 they can't act on.
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || cancelled) return;
        setPassInfo({ required: !!d.requirePass, has: d.hasPass !== false, pass: d.pass || null, isAdmin: !!d.isAdmin });
        // When this wallet may submit again, from the server — so the photo zone says
        // "next submission in 6h" BEFORE the photo, the crop and the signature.
        if (d.nextAt && typeof d.nextAt === "object") {
          for (const [u, t] of Object.entries(d.nextAt)) SERVER_NEXT_AT[u] = Number(t) || 0;
          setRulesVer(v => v + 1);
        }
        if (Array.isArray(d.lastReadings)) setServerLast(d.lastReadings);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [wallet, meters, seenTick]);
  const { open: openWalletModal } = useWalletModal();
  const openConnectModal = () => openWalletModal();

  // Wipe all local app data and the wallet connection, then reload — a clean
  // slate for testing. (On-chain reward history can't be erased; it re-hydrates
  // from the wallet's events on reconnect.)
  const resetApp = async () => {
    try {
      // This network's own keys only (the other build's stay). Includes the
      // meter-ingest device token(s) — a bearer credential that must not linger on
      // a shared/kiosk browser after disconnect. ownStorageKeys() gives raw names;
      // removeItem adds this build's prefix back itself.
      for (const k of ownStorageKeys()) localStorage.removeItem(k.replace(/^mainnet:/, ""));
    } catch {}
    try { indexedDB.deleteDatabase(IDB_NAME); } catch {}
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
  // What the wallet actually holds (B3TR.balanceOf) — shown beside "earned here",
  // which only counts this app's payouts. null = not read (yet).
  const [walletB3tr, setWalletB3tr] = useState(null);
  // This week's reward scale from the backend (/health → rewardBudget.factor): 1 =
  // full rates; lower when the weekly B3TR has to stretch over more claims.
  const [rewardFactor, setRewardFactor] = useState(1);
  const [serverNetwork, setServerNetwork] = useState(null);
  const networkMismatch = !!serverNetwork && serverNetwork !== NETWORK;
  useEffect(() => {
    let stop = false;
    const read = () => fetch(`${REWARD_API.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(20000) })
      .then(r => (r.ok ? r.json() : null))
      .then(h => {
        if (stop || !h) return;
        const f = Number(h?.rewardBudget?.factor);
        if (Number.isFinite(f) && f >= 0 && f <= 1) setRewardFactor(f);
        if (applyRules(h.rules)) setRulesVer(v => v + 1);
        // A build pointed at the other network's server would pay (or not) on a
        // chain the user isn't looking at. Say so, and refuse to submit.
        setServerNetwork(typeof h.network === "string" ? h.network : null);
      })
      .catch(() => {});
    read();
    const t = setInterval(read, 10 * 60 * 1000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const [subs, setSubs]             = useState([]);    // no demo data — start empty until hydrated
  const streak = computeStreak(subs); // derived from real submission dates
  const [verifyKey, setVerifyKey]   = useState(0);
  const [captchaToken, setCaptchaToken] = useState(""); // Cloudflare Turnstile token (when enabled)
  const turnstileId = useRef(null);
  const [showAdmin, setShowAdmin]   = useState(false);
  const [showHelp, setShowHelp]       = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [onChainAdmin, setOnChainAdmin] = useState(false); // app admin/moderator per the X2EarnApps contract
  const [photo, setPhoto]           = useState(null); // verified meter photo for backend submission
  // A double-tariff meter keeps two registers (1.8.1 low, 1.8.2 normal) and cycles
  // its display. Entering only one reports roughly half your consumption — which the
  // reward formula reads as saving and pays MORE for — and makes the meter
  // irreconcilable with a P1 reader later, since a reader always sends the total.
  // So both are entered, `reading` stays the total everything downstream works on,
  // and the parts ride along to the server, which re-derives the sum itself.
  const [dualTariff, setDualTariff] = useState(false);
  setDualTariffRef.current = setDualTariff;
  // Set when a submission is refused purely because the stored starting point covers
  // one tariff register and the reading covers both. Holds what the one-time
  // reconciliation needs, including the photo, which has to prove the meter again.
  const [fixBasis, setFixBasis] = useState(null);
  const [fixBusy, setFixBusy]   = useState(false);
  const runFixBasis = async () => {
    if (!fixBasis || !wallet) return;
    setFixBusy(true);
    try {
      const content = `Green Utility Log — reconcile tariff registers\nWallet: ${wallet}\nMeter: ${fixBasis.meterNo}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`;
      const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
      const certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      const res = await fetchT(`${REWARD_API.replace(/\/$/, "")}/meter/fix-basis`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: wallet, certificate, utility: fixBasis.utility, meterNo: fixBasis.meterNo,
          registers: fixBasis.registers, photo: fixBasis.photo?.base64 || "", photoMime: fixBasis.photo?.mime || "",
        }),
      }, PAYOUT_MS);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `could not reconcile (${res.status})`);
      setFixBasis(null);
      setPrevRead(String(d.to));
      showToast(t("fix.done", { n: d.to, unit: d.unit || "" }));
    } catch (e) {
      showToast(`❌ ${e?.message || t("fix.fail")}`);
    } finally { setFixBusy(false); }
  };
  const [regLow, setRegLow]         = useState("");
  const [regNormal, setRegNormal]   = useState("");
  const registers = (dualTariff && regLow !== "" && regNormal !== "")
    ? [Number(regLow), Number(regNormal)] : null;
  useEffect(() => {
    if (!dualTariff) return;
    setReading(registers ? String(+(registers[0] + registers[1]).toFixed(3)) : "");
  }, [dualTariff, regLow, regNormal]);

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
    setB3tr(earnedTotal(local));
    setReading(""); setPrevRead(""); prevReadEdited.current = false; setAiOk(false); setPhoto(null);
    // Everything else that belongs to the previous wallet: its tariff registers, its
    // "reconcile" card (which would sign for its meter with this wallet), what the
    // server said about its meters, and its token balance.
    setDualTariff(false); setRegLow(""); setRegNormal(""); setFixBasis(null);
    setServerLast(null); setRegHint({}); setWalletB3tr(null);
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
        // Also with no rows at all: that is what ages a payout stuck on "pending"
        // into "failed". And merged into what is on screen NOW, not the list from
        // when the wallet connected — a reading submitted while the history loaded
        // used to vanish from the screen and from storage.
        if (res.ok) {
          const merged = mergeSubs(subsRef.current, res.rows);
          setSubs(merged);
          setB3tr(earnedTotal(merged));
          saveSubs(addr, merged);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [account]);

  // A payout call that timed out, lost its connection or got a 5xx may still have
  // been paid: the server keeps going after we stop waiting. Ask again — the chain
  // history and /wallet/seen (cooldowns) — so a payout that did go through shows up
  // instead of looking lost and inviting a retry. Once now, and once more after a
  // block or two, because the reward event lands a little after the server answers.
  const subsRef = useRef(subs);
  subsRef.current = subs;
  const recheckPayout = (addr) => {
    const a = String(addr || "").toLowerCase();
    if (!a) return;
    const pull = () => {
      if (!sameWallet(a)) return;
      setSeenTick(t => t + 1);
      fetchWalletHistory({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, address: a })
        .then(res => {
          if (!sameWallet(a) || sessionWalletRef.current !== a || !res.ok) return;
          const merged = mergeSubs(subsRef.current, res.rows);
          setSubs(merged);
          setB3tr(earnedTotal(merged));
          saveSubs(a, merged);
        })
        .catch(() => {});
    };
    pull();
    setTimeout(pull, 30000);
  };

  // Read the wallet's real B3TR balance on connect and whenever a payout lands.
  // The payout is reported as soon as it is sent, before the block includes it,
  // so read once now and once more after a block or two.
  useEffect(() => {
    if (!account) { setWalletB3tr(null); return; }
    const ctrl = new AbortController();
    const read = () => fetchTokenBalance({ node: ACTIVE_NODE, token: CONTRACTS.B3TR, address: account, signal: ctrl.signal })
      .then(v => { if (!ctrl.signal.aborted && v != null) setWalletB3tr(v); });
    read();
    const t = setTimeout(read, 25000);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [account, b3tr]);

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
    if (!online || !wallet) return;
    let cancelled = false;
    (async () => {
      if (syncingRef.current) return;
      // Same rule as a live submission: an app and a server on different networks
      // must not exchange readings — the queue waits until that is fixed.
      if (!serverNetwork || networkMismatch) return;
      syncingRef.current = true;
      try {
        const pending = await getUnsyncedSubmissions();
        let synced = 0, uncertain = false;
        const refused = [];
        for (const item of pending) {
          if (cancelled) break;
          if (!item.photo) continue; // legacy/photoless item — can't be paid (pruned next time)
          // Only the wallet that saved it gets paid for it. Items saved before the
          // wallet was stored (or while none was connected) go to whoever is
          // connected, as they always did.
          if (item.wallet && item.wallet.toLowerCase() !== wallet.toLowerCase()) continue;
          // Sign first: a declined or dropped signature sends nothing, so the item
          // simply stays queued — no flag to get stuck on.
          let certificate;
          try {
            const content = `Green Utility Log — confirm submission\nWallet: ${wallet}\nUtility: ${item.type}\nReading: ${item.cur}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`;
            const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
            certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
          } catch { continue; }
          if (cancelled) break;
          const device = await deviceInfo();
          // In flight only around the call itself (timestamped, so it expires).
          await markBroadcasting(item.id, true);
          let res, data;
          try {
            res = await fetchT(`${REWARD_API.replace(/\/$/, "")}/reward`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ utility: item.type, reading: item.cur, prevRead: item.prev, ...(Array.isArray(item.registers) && item.registers.length ? { registers: item.registers } : {}), meterNo: item.meterNo, address: wallet, photo: item.photo, photoMime: item.photoMime || "", certificate, clientFlagged: !!item.flagged, flagReason: item.flagReason || "", ocrNums: item.ocrNums || [], meterNoConfirmed: item.meterNoConfirmed ?? null, avgUsage: item.avgUsage ?? null, captchaToken: "", device }),
            }, PAYOUT_MS);
            data = await res.json().catch(() => ({}));
          } catch {
            // Timeout or lost connection: it may have been paid. Leave the flag on —
            // it expires after PAYOUT_MS + 60 s, then the item is retried (the
            // server never pays the same photo twice).
            uncertain = true;
            continue;
          }
          if (!res.ok) {
            // 408/429 are "not now", not "no": those retry like a 5xx.
            const notYet = data.needsPass || /cooldown|already processing/i.test(String(data.errorEn || data.error || ""));
            if (notYet) {
              // Kept for later: after the cooldown, or once an admin gives the pass.
              await markLater(item.id, data.needsPass ? 12 * 3600000 : 2 * 3600000, data.error);
              continue;
            }
            // A signature problem (signed by another account in the wallet, expired,
            // already used) says nothing about the reading: it used to remove the
            // reading and its photo from the queue for good. Signed again next time.
            if (res.status === 401) {
              await markLater(item.id, 10 * 60000, data.error);
              continue;
            }
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              // The server's final answer (cooldown, duplicate photo, lower reading…):
              // retrying can't change it, so take it out of the queue.
              const reason = data.error || `refused (${res.status})`;
              await markFailed(item.id, reason);
              refused.push(`${utilName(item.type)} ${item.cur}: ${reason}`);
            } else {
              await markBroadcasting(item.id, false);   // 5xx: try again next time
              uncertain = true;
            }
            continue;
          }
          const paid = (data.amount != null && Number.isFinite(Number(data.amount))) ? Number(data.amount) : item.b3tr;
          await markSynced(item.id);
          if (cancelled) break;
          setSubs(prev => [{
            id: item.id, type: item.type, meterNo: item.meterNo || "",
            cur: item.cur, prev: item.prev, date: dayKey(new Date(item.id)),
            b3tr: data.recorded ? 0 : paid, status: data.recorded ? "recorded" : data.pending ? "pending" : "confirmed", txHash: data.txid || "", submittedAt: item.id,
            ...(data.recorded ? { note: data.reason || "no saving to reward this time" } : {}),
            // Carry the flag through. Without it this row had status "review" but no
            // `flagged`, so the history fell through to rendering the bare word
            // "review" — unstyled, unexplained, on a submission that was paid. The
            // badge only appears when `flagged` is set.
            flagged: !!item.flagged, flagReason: item.flagReason || "",
          }, ...prev]);
          if (data.pending) uncertain = true; else if (!data.recorded) setB3tr(b => b + (parseFloat(paid) || 0));
          synced++;
        }
        if (cancelled) return;
        if (uncertain) recheckPayout(wallet);
        const syncedMsg = synced ? t("s.synced", { n: synced, net: NETWORK_LABEL }) : "";
        // There is no queue screen, so a refused item is said out loud here, with
        // the server's reason, and dropped from the queue.
        if (refused.length) {
          showToast(`${t("s.refused", { n: refused.length })}\n${refused.join("\n")}${syncedMsg ? `\n\n${syncedMsg}` : ""}`);
        } else if (syncedMsg) showToast(syncedMsg);
      } finally {
        syncingRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [online, wallet, serverNetwork]);

  // The best-known "previous reading" for a meter: the most recent submission's
  // reading, falling back to the registered baseline. This is what next time's
  // usage is measured from.
  // The server's own record wins when it has one: it is what the server measures
  // from, and it includes readings recorded on another device or without a reward.
  const lastReadingFor = (id) => {
    const mine = String(meters?.[id] || "").trim().toLowerCase();
    const srv = (serverLast || []).find(r => r.utility === id && String(r.meterNo).toLowerCase() === mine);
    const lastSub = subs.find(s => s.type === id && s.status !== "failed");
    // A reading submitted on this device after the server answered is newer.
    const localNewer = lastSub && (!srv?.at || subTs(lastSub) > Number(srv.at));
    if (srv && Number.isFinite(Number(srv.reading)) && !localNewer) return String(srv.reading);
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
  }, [selUtil, subs, baselines, serverLast]);

  // Cloudflare Turnstile (anti-bot): render the widget on the Meter and Eco tabs when a
  // site key is set; its token rides along with each /reward submission.
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || (tab !== "submit" && tab !== "eco")) return;
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
    const res = await fetchT(`${ACTIVE_NODE}/accounts/*`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clauses: [{ to: clause.to, value: "0x0", data: clause.data }], caller }),
    });
    const [out] = await res.json();
    return { reverted: !!out?.reverted, reason: out?.reverted ? (decodeRevertHex(out.data) || out.vmError || "execution reverted") : "" };
  };

  // Run an admin transaction HONESTLY: simulate first (so a doomed call shows
  // the contract's own revert reason BEFORE signing), then broadcast and wait
  // for the receipt — success is only reported when the tx actually landed.
  const runAdminTx = async ({ fn, args, label, to = CONTRACTS.X2EarnRewardsPool }) => {
    if (!wallet) { openConnectModal(); return; }
    const clause = Clause.callFunction(Address.of(to), new ABIFunction(fn), args);
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
        const r = await fetchT(`${ACTIVE_NODE}/transactions/${txid}/receipt`);
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
      const content = `Green Utility Log — admin action\n${canonical}\nNetwork: ${NETWORK}\nWallet: ${wallet}\nTime: ${new Date().toISOString()}`;
      const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
      const certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      const res = await fetchT(`${REWARD_API.replace(/\/$/, "")}/admin/move-rewards-pool`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, amount: amt, certificate }),
      }, PAYOUT_MS);
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
    const content = `Green Utility Log — admin action\n${canonical}\nNetwork: ${NETWORK}\nWallet: ${wallet}\nTime: ${new Date().toISOString()}`;
    const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
    const certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
    const res = await fetchT(`${REWARD_API.replace(/\/$/, "")}${path}`, {
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

  // Admin emergency stop: while paused, every payout for this app reverts on-chain
  // — photo, reader and eco alike. For a leaked distributor key or a hole in the
  // checks. Only the on-chain app admin can flip it; the simulation says so first.
  const handleSetDistributionPaused = async (pause) => {
    if (pause && !window.confirm("Pause ALL payouts for this app?\n\nEvery claim will fail until you resume. Use this for an emergency, such as a leaked key or abuse.")) return;
    return runAdminTx({
      fn: { name: pause ? "pauseDistribution" : "unpauseDistribution", type: "function", stateMutability: "nonpayable", inputs: [{ name: "appId", type: "bytes32" }], outputs: [] },
      args: [VEBETTER_APP_ID],
      label: pause ? "Pause payouts" : "Resume payouts",
    });
  };

  // Admin: let the distributor wallet file bot signals. The passport lets the
  // app's own admin grant this (assignSignalerToAppByAppAdmin) — no request to
  // VeBetterDAO needed.
  const handleAssignSignaler = async ({ passport, signaler }) => {
    if (!passport || !/^0x[0-9a-fA-F]{40}$/.test(signaler || "")) { showToast("⚠️ Distributor wallet unknown. Is the backend online?"); return; }
    return runAdminTx({
      to: passport,
      fn: { name: "assignSignalerToAppByAppAdmin", type: "function", stateMutability: "nonpayable", inputs: [{ name: "app", type: "bytes32" }, { name: "user", type: "address" }], outputs: [] },
      args: [VEBETTER_APP_ID, signaler],
      label: "Enable bot signalling",
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
  // the previous one. Equal means zero consumption: valid, but (like almost no
  // usage) it is recorded without a reward — a meter that doesn't move is more often
  // a reading that wasn't taken than a household that used nothing. Only a LOWER
  // reading is rejected (a real meter never runs backwards).
  const readingReady = () => { const r=parseFloat(reading),p=parseFloat(prevRead); return Number.isFinite(r)&&Number.isFinite(p)&&r>=p; };
  const usage = () => { const r=parseFloat(reading),p=parseFloat(prevRead); return readingReady()?parseFloat((r-p).toFixed(2)):0; };
  // Conservation reward: you earn for using LESS than the benchmark, not more.
  // The benchmark covers the days since this meter's last reading, so a reading that
  // spans several days is judged against several days of allowance.
  // When this meter was last read: the later of this device's last row and the
  // server's record (a reading made on another phone, or one recorded without a
  // reward, is only in the latter). The preview measured from the device alone and
  // promised a week's allowance for a meter the server had read yesterday.
  const serverLastFor = (id) => {
    const mine = String(meters?.[id] || "").trim().toLowerCase();
    return (serverLast || []).find(r => r.utility === id && String(r.meterNo).toLowerCase() === mine) || null;
  };
  const lastReadAt = () => {
    const local = subs.find(x => x.type === selUtil && x.status !== "failed" && subTs(x));
    const srvAt = Number(serverLastFor(selUtil)?.at) || 0;
    return Math.max(local ? subTs(local) : 0, srvAt) || null;
  };
  const daysSinceLast = () => { const at = lastReadAt(); return at ? spanDays(Date.now() - at) : 1; };
  // The real gap, uncapped: what counts as plausible grows with it (the server does
  // the same, usageBoundsFor), while the savings target stops at a week.
  const gapDays = () => { const at = lastReadAt(); return at ? Math.max(1, (Date.now() - at) / 86400000) : 1; };
  // A meter's first reading earns nothing (the server can't vouch for a starting
  // point it never recorded); the saving is paid from the next one. Paid rows come
  // back from chain on connect, recorded ones are kept on this device, and the
  // server knows about readings made elsewhere.
  const firstForUtil = () => !serverLastFor(selUtil) && !subs.some(x => x.type === selUtil && x.status !== "failed" && x.type !== "eco");
  // The full-rate amount: kWh saved × rate, nothing for a first or near-zero reading.
  const fullReward = () => {
    if (!readingReady()) return 0;
    if (firstForUtil() || nearZeroUsage(selUtil, usage(), daysSinceLast())) return 0;
    return computeReward(selUtil, usage(), daysSinceLast());
  };
  // Scaled to this week's budget exactly as the server does (budget.js): the
  // full-rate amount × rewardFactor, rounded down to the cent.
  const reward = () => floor2(fullReward() * rewardFactor);

  // ── Photoless automatic submission (Step 2) ─────────────────────────────────
  // Submit the latest automatically-received meter reading — no photo. The backend
  // pays out only if the meter already has a baseline (set by a prior photo
  // submission) and the reading is fresh; all the normal reward rules still apply.
  const [meterAutoBusy, setMeterAutoBusy] = useState(false);
  const handleMeterAutoSubmit = async () => {
    if (networkMismatch) { showToast(t("s.mismatch", { app: NETWORK, server: serverNetwork })); return; }
    if (!wallet) { openConnectModal(); return; }
    if (!online) { showToast(t("s.auto.offline")); return; }
    const meterNo = (meters["electric"] || "").trim();
    if (!meterNo) { showToast(t("s.auto.noMeter")); return; }
    if (TURNSTILE_SITE_KEY && !captchaToken) { showToast("🤖 Complete the verification checkbox first"); return; }
    setMeterAutoBusy(true);
    const payWallet = wallet;
    let sent = false;
    try {
      let certificate;
      try {
        const content = `Green Utility Log — confirm automatic meter submission\nWallet: ${wallet}\nMeter: ${meterNo}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`;
        const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
        certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      } catch {
        setMeterAutoBusy(false);
        showToast(t("s.sign"));
        return;
      }
      sent = true;
      const res = await fetchT(`${REWARD_API.replace(/\/$/, "")}/reward-from-meter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, utility: "electric", meterNo, certificate, captchaToken }),
      }, PAYOUT_MS);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(data.error || `service error ${res.status}`, res.status, data.errorEn);
      const paid = Number(data.amount) || 0;
      if (!sameWallet(payWallet)) { showToast(t("auto.otherWallet", { amount: paid, wallet: `${payWallet.slice(0, 6)}…${payWallet.slice(-4)}` })); return; }
      // The server answers with the reading and the usage it paid for, not the
      // previous reading; derive that, so history shows "x kWh" instead of "NaN".
      const curN = Number(data.reading), useN = Number(data.usage);
      const cur = data.reading != null && Number.isFinite(curN) ? String(data.reading) : "";
      const prev = cur && data.usage != null && Number.isFinite(useN) ? String(+(curN - useN).toFixed(3)) : "";
      setSubs(prev0 => [{ id: Date.now(), type: "electric", meterNo, cur, prev, date: dayKey(new Date()), b3tr: data.recorded ? 0 : paid, status: data.recorded ? "recorded" : data.pending ? "pending" : "confirmed", txHash: data.txid || "", submittedAt: Date.now(), ...(data.recorded ? { note: data.reason || "" } : {}) }, ...prev0]);
      setCooldown("electric");
      if (data.recorded) showToast(t("s.auto.recorded", { reason: data.reason || t("s.noSaving") }));
      else if (data.pending) { recheckPayout(payWallet); showToast(t("s.auto.pending", { amount: paid })); }
      else { setB3tr(b => b + paid); showToast(t("s.auto.paid", { amount: paid })); }
    } catch (e) {
      if (sent && !isRefusal(e)) recheckPayout(payWallet);
      showToast(t("s.auto.failed", { reason: e?.message || t("s.tryLater") }));
    } finally {
      setMeterAutoBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (networkMismatch) { showToast(t("s.mismatch", { app: NETWORK, server: serverNetwork })); return; }
    setBusy(true);
    const earned = reward();
    const meterNo = (meters[selUtil] || "").trim();

    // A reading without its registered meter can't be verified — block it.
    if (!meterNo) {
      setBusy(false);
      showToast(t("s.noMeter"));
      return;
    }

    // Block only blank or LOWER readings — equal (zero usage) is valid.
    if (!readingReady()) {
      setBusy(false);
      const p = parseFloat(prevRead), r = parseFloat(reading);
      showToast(Number.isFinite(r) && Number.isFinite(p) && r < p
        ? t("s.lower")
        : t("s.enter"));
      return;
    }
    // A reading that saves something but would pay nothing: this week's B3TR is
    // spread so thin (or gone) that the amount rounds to 0. Say that, not "enter a
    // reading". A reading that saves nothing goes through: it is recorded without a
    // reward, and is the starting point for the next one.
    if (fullReward() > 0 && !(earned > 0)) {
      setBusy(false);
      showToast(t("s.budget"));
      return;
    }

    // Anti-bot captcha must be solved first (only when a site key is configured).
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setBusy(false);
      showToast(t("s.captcha"));
      return;
    }

    // Enforce the per-meter cooldown on the submission itself, not just the
    // camera UI (which is bypassable).
    const cdRem = getCooldownRemaining(selUtil);
    if (cdRem > 0) {
      setBusy(false);
      showToast(t("s.cooldown", { time: fmtCooldown(cdRem) }));
      return;
    }

    // ── Hybrid verification, on the FINAL numbers (not the photo-time ones) ──────
    // Block obvious fraud outright; flag the rest for review. This binds the reward
    // to the verified photo, so a reading edited after the green "verified" badge
    // can no longer pass unchecked.
    const usageVal = usage();
    const plaus = checkPlausibility(selUtil, usageVal, gapDays());
    // One exception: a gap too big for ANY span, with both tariff registers filled
    // in, is the double-tariff mismatch. The app already says so above the button
    // and tells the user to submit anyway — and it has to, because the correction
    // is offered in response to the SERVER's refusal. Blocking here would make the
    // app's own instruction unfollowable.
    const scaleMismatch = !!registers && plaus.tooHigh;
    if (!plaus.ok && !scaleMismatch) {
      setBusy(false);
      showToast(plaus.reason ? `⚠️ ${plaus.reason}` : t("s.implausible"));
      return;
    }
    // High compared with your own history: flagged for review, never blocked. The
    // screen after the photo says "Allow anyway? Tap Submit to continue", and the
    // server enforces the real plausibility bounds anyway.
    const anom = checkAnomaly(selUtil, usageVal, subs, daysSinceLast());
    // Not auto-blocked, but recorded for review when the photo can't back it up:
    // either the reading isn't visible on the photo, or the registered meter number
    // couldn't be confirmed on it (lenient — a miss flags, it never blocks).
    // A double-tariff meter shows one register at a time, never their sum: the
    // photo confirms the reading when one of the registers is on it.
    const readingConfirmed = !photo?.ocrFailed && (registers
      ? registers.some((r) => readingMatchesPhoto(r, photo?.ocrNums))
      : readingMatchesPhoto(reading, photo?.ocrNums));
    const meterUnconfirmed = photo?.meterNoConfirmed === false;
    const photoConfirmed = readingConfirmed && !meterUnconfirmed;
    const flagReason = [
      !readingConfirmed ? (photo?.ocrFailed ? "photo_unreadable" : "reading_not_in_photo") : (meterUnconfirmed ? "meter_not_confirmed" : ""),
      anom.anomaly ? "high_usage" : "",
    ].filter(Boolean).join(",");

    if (!online) {
      // Store the photo + OCR metadata too, so on reconnect we can submit through
      // the reward backend exactly like an online submission (the backend needs the
      // photo and issues the payout). Without this, an offline item could never be
      // paid. captchaToken can't be captured offline — fine while captcha is off.
      // A full or blocked IndexedDB throws here. Uncaught, that left the button on
      // "Submitting…" for good and put up the red startup-error box.
      try {
        await saveOfflineSubmission({
          // Whose reading this is: the sync pays it only to this wallet, not to
          // whichever one happens to be connected when the connection returns.
          wallet: wallet ? wallet.toLowerCase() : "",
          type:selUtil, meterNo, cur:reading, prev:prevRead, b3tr:earned,
          // The server checks a double-tariff meter register by register and
          // refuses the sum on its own: without these the reading was refused
          // and removed from the queue on reconnect.
          ...(registers ? { registers } : {}),
          flagged: !photoConfirmed || anom.anomaly, flagReason,
          photo: photo?.base64 || "", photoMime: photo?.mime || "",
          ocrNums: photo?.ocrNums || [], meterNoConfirmed: photo?.meterNoConfirmed ?? null,
          avgUsage: anom.avg ?? null,
        });
      } catch {
        setBusy(false);
        showToast(t("s.offlineFail"));
        return;
      }
      // The queued reading is the next one's starting point. Cleared instead, the field
      // stayed empty (nothing that refills it changes until the queue syncs) and the
      // Submit button sat on "Enter reading".
      setAiOk(false); setPhoto(null); setReading(""); setPrevRead(String(reading)); prevReadEdited.current = false; setVerifyKey(k=>k+1);
      setBusy(false);
      showToast(t("s.offlineSaved"));
      return;
    }

    if (!wallet) {
      setBusy(false);
      openConnectModal();
      return;
    }

    const payWallet = wallet;
    let sent = false;
    try {
      // The reward server verifies the submission and issues the B3TR; the user
      // signs nothing but a gasless certificate.
      let txid, onChainPending = false;
      // The server recomputes the payout from its own recorded baseline, so the
      // amount actually paid on-chain can differ from the client's `earned`. Show
      // and store the server's number when it returns one; fall back to `earned`.
      let paidAmount = earned, recordedOnly = "";
      // Prove wallet ownership: the user signs a gasless certificate, so the
      // backend can verify the submission really comes from `wallet` and won't
      // issue B3TR to an address someone just typed into the request.
      let certificate;
      try {
        const content = `Green Utility Log — confirm submission\nWallet: ${wallet}\nUtility: ${selUtil}\nReading: ${reading}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`;
        const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
        certificate = { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
      } catch {
        setBusy(false);
        showToast(t("s.sign"));
        return;
      }
      const device = await deviceInfo();
      sent = true;
      const res = await fetchT(`${REWARD_API.replace(/\/$/, "")}/reward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utility: selUtil, reading, prevRead, ...(registers ? { registers } : {}), meterNo, address: wallet, photo: photo?.base64 || "", photoMime: photo?.mime || "", certificate, clientFlagged: !photoConfirmed || anom.anomaly, flagReason, ocrNums: photo?.ocrNums || [], meterNoConfirmed: photo?.meterNoConfirmed ?? null, avgUsage: anom.avg ?? null, captchaToken, device }),
      }, PAYOUT_MS);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw httpError(data.error || `Reward service error ${res.status}`, res.status, data.errorEn);
      txid = data.txid;
      onChainPending = !!data.pending;
      if (data.amount != null && Number.isFinite(Number(data.amount))) paidAmount = Number(data.amount);
      if (data.recorded) { recordedOnly = data.reason || "no saving to reward this time"; paidAmount = 0; }

      // Switched wallets while this was paying: the payout belongs to the wallet it
      // was sent for and shows in its history (from chain) once that one is back.
      // Recording it here would put it in the new wallet's history and totals.
      if (!sameWallet(payWallet)) {
        setBusy(false);
        showToast(t("s.otherWallet", { amount: paidAmount.toFixed(2), wallet: `${payWallet.slice(0, 6)}…${payWallet.slice(-4)}` }));
        return;
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
        status: recordedOnly ? "recorded" : onChainPending ? "pending" : "confirmed",
        ...(recordedOnly ? { note: recordedOnly } : {}),
        flagged: !photoConfirmed,
        flagReason,
        txHash: txid || "",
        submittedAt: Date.now()
      }, ...prev]);

      if (onChainPending) recheckPayout(wallet); else if (!recordedOnly) setB3tr(b => b + paidAmount);
      if (registers) setRegTick(t => t + 1);
      setCooldown(selUtil);
      setAiOk(false);
      setPhoto(null);
      setReading("");
      setPrevRead("");
      prevReadEdited.current = false;
      setVerifyKey(k => k + 1);
      showToast(recordedOnly
        ? t("s.recorded", { reason: recordedOnly })
        : onChainPending
        ? `${t("s.pending", { amount: paidAmount.toFixed(2), net: NETWORK_LABEL })}${txid ? ` • TX: ${txid.slice(0, 10)}...` : ""}`
        : `${t("s.paid", { amount: paidAmount.toFixed(2), net: NETWORK_LABEL })}${txid ? ` • TX: ${txid.slice(0, 10)}...` : ""}`);
      setBusy(false);
    } catch (e) {
      setBusy(false);
      if (sent && !isRefusal(e)) recheckPayout(payWallet);
      // A meter whose starting point was set from a single tariff register can never
      // be reconciled with the total of both — the step is thousands of kWh and this
      // is the refusal it produces, every time, forever. Offer the one-time fix here
      // rather than leaving the user to read a range they cannot influence.
      if (registers && /outside the plausible range/i.test(String(e?.en || e?.message || ""))) {
        setFixBasis({ registers, meterNo, utility: selUtil, photo });
        showToast(t("s.oneTariff"));
        return;
      }
      showToast(t("s.failed", { reason: e?.message || t("s.cancelled") }));
    }
  };

  return (
    <>
      <style>{CSS}</style>
      {showIntro && <IntroScreen onStart={() => { setShowIntro(false); try { localStorage.setItem('greenlog_seen_intro', 'true'); } catch { /* storage blocked */ } }} />}
      {!showIntro && !wallet && <WalletGate onConnect={openConnectModal} online={online} />}
      {/* Not under the intro: its dialog took the keyboard focus and trapped Tab in
          fields nobody could see, so Next and Skip on the intro were unreachable. */}
      {needsBaselines && !showIntro && <BaselineOnboarding onDone={(bl, mtrs) => { setBaselines(bl); setMeters(mtrs); closeRegistration(); }} utils={regUtils} editMode={regEdit} existingBaselines={baselines} existingMeters={meters} T={T} />}
      {!onboarded && <Onboarding onDone={() => setOnboarded(true)} />}
      {showAdmin && isAdmin && <Suspense fallback={<div role="status" style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,.4)",color:"#fff",zIndex:400}}>Loading…</div>}><AdminScreen onClose={() => setShowAdmin(false)} T={T} wallet={wallet} onFundPool={handleFundPool} onMoveToRewardsPool={handleMoveToRewardsPool} onDisableRewardsPool={handleDisableRewardsPool} onSetDistributionPaused={handleSetDistributionPaused} onAssignSignaler={handleAssignSignaler} onClaimB3TR={FAUCET_ENABLED ? handleClaimB3TR : null} onAdminApi={adminApi} onToast={showToast} /></Suspense>}
      {showHelp && <HelpScreen onLang={changeLang} onClose={() => setShowHelp(false)} onFeedback={() => { setShowHelp(false); setShowFeedback(true); }} T={T} />}
      {showFeedback && <FeedbackScreen onClose={() => setShowFeedback(false)} onToast={showToast} wallet={wallet} tab={tab} T={T} />}
      {toast && (toast.sticky ? (
        <div className="toast" role="status" aria-live="polite" style={{whiteSpace:"pre-wrap",maxWidth:"88vw",textAlign:"left",lineHeight:1.5,background:T.gasBg,color:T.gas,border:`1px solid ${T.gasBorder}`,padding:"12px 14px"}}>
          <div style={{wordBreak:"break-word"}}>{toast.msg}</div>
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button onClick={() => { navigator.clipboard?.writeText(toast.msg).catch(() => {}); }}
              style={{flex:1,background:T.gas,color:T.bg,border:0,borderRadius:6,padding:"8px 10px",fontSize:11,fontWeight:800,cursor:"pointer"}}>{t("toast.copyError")}</button>
            <button onClick={() => setToast(null)}
              style={{background:"transparent",color:T.gas,border:`1px solid ${T.gasBorder}`,borderRadius:6,padding:"8px 12px",fontSize:11,fontWeight:800,cursor:"pointer"}}>{t("toast.close")}</button>
          </div>
        </div>
      ) : (
        <div className="toast" role="status" aria-live="polite">{toast.msg}</div>
      ))}

      <div className="app">
        <div className="z1 scr">
          {/* The /testnet/ copy says what it is, so nobody mistakes test tokens for
              real ones — and, once the real app is on mainnet, where that is. */}
          {/* The testnet strip itself is rendered next to the app in main.jsx, so it
              also shows over the connect screen and the intro; this keeps it from
              covering the header. */}
          {TESTNET_BANNER && <div aria-hidden="true" style={{height:BANNER_H}} />}
          <div className="hdr">
            <div className="logo">
              <div className="logo-mark"><SproutIcon size={18} /></div>
              <div>
                <div className="logo-name">Green Utility Log</div>
              </div>
            </div>
            <div className="hdr-actions">
              <div className={`hdr-online ${online ? "is-online" : ""}`} title={online ? t("hdr.online") : t("hdr.offline")} aria-label={online ? t("hdr.online") : t("hdr.offline")} style={{display:"flex",alignItems:"center",justifyContent:"center",width:30,height:30,borderRadius:6,border:`1px solid ${online?T.green4:T.gasBorder}`,background:online?T.green5:T.gasBg,flexShrink:0}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:online?T.green3:T.gas,animation:online?"pulse 2.5s infinite":"none"}}/>
              </div>
              {/* Light/dark, one tap from every screen again — it had moved into
                  Profile → Settings, where people stopped finding it. Still there too. */}
              <button className="dark-toggle" onClick={toggleDark} aria-label={dark ? t("hdr.toLight") : t("hdr.toDark")} title={dark ? t("hdr.toLight") : t("hdr.toDark")}>
                {dark ? "☀️" : "🌙"}
              </button>
              <button className="dark-toggle" onClick={() => setShowHelp(true)} aria-label={t("hdr.help")} title={t("hdr.help")}>
                ❓
              </button>
              {/* Connect button — opens dapp-kit's wallet modal
                  (VeWorld, WalletConnect/mobile QR) via useWalletModal. */}
              <button
                className={`wallet-pill ${wallet ? "connected" : ""}`}
                onClick={openConnectModal}
                title={wallet || t("hdr.connectWallet")}
              >
                <span className={`wdot ${wallet ? "" : "off"}`} />
                <span className="waddr">
                  {wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : t("hdr.connect")}
                </span>
              </button>
            </div>
          </div>

          {/* Offline was only a red dot in the header: nothing said that a reading
              taken now isn't lost. */}
          {!online && (
            <div role="status" style={{margin:"10px 14px 0",padding:"10px 12px",fontSize:12.5,lineHeight:1.5,fontWeight:600,color:T.text,background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6}}>
              {t("offline.bar")}
            </div>
          )}

          {networkMismatch && (
            <div role="alert" style={{margin:"10px 14px 0",padding:"10px 12px",fontSize:11.5,lineHeight:1.5,fontWeight:600,color:"#7a1c1c",background:"#fdecec",border:"1px solid #e3a3a3",borderRadius:6}}>
              {t("net.mismatch", { app: NETWORK, server: serverNetwork })}
            </div>
          )}

          {/* "Only with a role": a wallet without one gets this instead of the app.
              The server decides (admins always pass), and refuses payouts as well, so
              this is the honest front of a rule that holds either way. */}
          {noAccess && <NoAccessScreen wallet={wallet} T={T} onSwitch={openConnectModal} onToast={showToast} />}

          {!noAccess && <>
          {tab==="home"      && <HomeScreen b3tr={b3tr} walletB3tr={walletB3tr} streak={streak} subs={subs} setTab={setTab} wallet={wallet} onOpenReader={() => { setStartOnReader(true); setTab("submit"); }} T={T}/>}
          {tab==="submit"    && <SubmitScreen startOnReader={startOnReader} onStartedReader={() => setStartOnReader(false)} rewardFactor={rewardFactor} u={u} selUtil={selUtil} setSelUtil={handleSelUtil} aiOk={aiOk} setAiOk={setAiOk} setPhoto={setPhoto} reading={reading} setReading={setReading} prevRead={prevRead} setPrevRead={setPrevReadByUser} dualTariff={dualTariff} fixBasis={fixBasis} fixBusy={fixBusy} runFixBasis={runFixBasis} dismissFixBasis={() => setFixBasis(null)} setDualTariff={setDualTariff} regLow={regLow} setRegLow={setRegLow} regNormal={regNormal} setRegNormal={setRegNormal} photoRegister={regHint[selUtil] || null} busy={busy} usage={usage} reward={reward} days={daysSinceLast()} handleSubmit={handleSubmit} verifyKey={verifyKey} wallet={wallet} setShowWallet={openConnectModal} subs={subs} meters={meters} T={T} setTab={setTab} onMeterAutoSubmit={handleMeterAutoSubmit} meterAutoBusy={meterAutoBusy} onRegisterMeter={(utils) => openRegistration(utils, true)}/>}
          {tab==="progress"  && <ProgressScreen b3tr={b3tr} streak={streak} subs={subs} wallet={wallet} T={T}/>}
          {tab==="history"   && <HistoryScreen subs={subs} T={T}/>}
          {tab==="profile"   && <ProfileScreen b3tr={b3tr} subs={subs} wallet={wallet} walletDomain={accountDomain || null} pass={passInfo.pass} setTab={setTab} onOpenSettings={()=>setTab("settings")} onOpenHelp={()=>setShowHelp(true)} onOpenFeedback={()=>setShowFeedback(true)} onToast={showToast} T={T}/>}
          {tab==="settings"  && <SettingsScreen lang={lang} onLang={changeLang} b3tr={b3tr} subs={subs} wallet={wallet} setShowWallet={openConnectModal} dark={dark} setDark={toggleDark} setOnboarded={setOnboarded} onEditMeters={()=>openRegistration(REQUIRED_UTILS, true)} onEditSolar={()=>openRegistration(SOLAR_UTILS, true)} meters={meters} isAdmin={isAdmin} onOpenAdmin={()=>setShowAdmin(true)} onOpenReader={() => { setStartOnReader(true); setTab("submit"); }} onToast={showToast} onReset={resetApp} onBack={()=>setTab("profile")} T={T}/>}
          </>}
        </div>

        <div className="bnav">
          {/* Charts is hidden until there are two readings to draw a line between —
              a new tester's first impression was otherwise a tab holding an empty
              graph. It reappears the moment there's something to plot, and stays
              visible while you're standing on it so the nav never loses its place. */}
          {[{id:"home",icon:"🏠",label:t("nav.home")},{id:"submit",icon:"📸",label:t("nav.meter")},{id:"progress",icon:"📈",label:t("nav.progress")},{id:"profile",icon:"👤",label:t("nav.profile")}].filter(n=>n.show!==false).map(n=>{
            const active = tab===n.id || (n.id==="profile" && (tab==="settings" || tab==="history"));
            return (
            <button key={n.id} className={`nitem ${active ?"active":""}`} aria-current={active ? "page" : undefined} onClick={()=>setTab(n.id)}>
              <div className="nicon">{n.icon}</div>
              <div className="nlabel">{n.label}</div>
            </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
