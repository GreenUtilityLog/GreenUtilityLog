import { useState, useRef, useEffect } from "react";
import { useWallet, useWalletModal } from "@vechain/dapp-kit-react";
import { Clause, Address, ABIFunction } from "@vechain/sdk-core";
import { fetchOnChainLeaderboard, fetchWalletHistory, fetchIsAppAdmin } from "./leaderboard.js";

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
const REWARD_API = "";

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

// ── Build the on-chain clause for a meter submission ──────────────────────
// Wallet connection + signing are handled by VeChain Kit (VeWorld /
// WalletConnect / Sync2) via dapp-kit's useWallet().requestTransaction.
// This helper only builds the transaction clause that the Kit signs & sends,
// so it works identically on desktop and mobile.
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

  // Amount in wei (18 decimals)
  const amountWei = BigInt(Math.round(b3trAmount * 1e18)).toString();

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
    doc.text(`USD Value: $${(b3tr * B3TR_USD).toFixed(2)}`, 20, 55);
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

// ────────────────────────────────────────────────────────────────────────────
// ANTI-FARMING ENGINE
// ────────────────────────────────────────────────────────────────────────────

function checkPlausibility(utilId, usageVal) {
  const RANGES = { electric: { min:0.1, max:80 }, gas: { min:0.01, max:20 }, water: { min:10, max:1000}, solar: { min:0.1, max:60 } };
  const range = RANGES[utilId];
  if (!range) return { ok:true };
  if (usageVal < range.min) return { ok:false, reason:`Usage too low (${usageVal} < ${range.min})` };
  if (usageVal > range.max) return { ok:false, reason:`Abnormally high (${usageVal} > ${range.max})` };
  return { ok:true };
}

function checkAnomaly(utilId, usageVal, subs) {
  const recent = subs.filter(s=>s.type===utilId).slice(0,14);
  if (recent.length < 3) return { ok:true, anomaly:false };
  const avg = recent.reduce((a,s)=>a+(parseFloat(s.cur)-parseFloat(s.prev)),0)/recent.length;
  if (avg > 0 && usageVal > avg * 3.5) return { ok:false, anomaly:true, reason:`Usage is ${(usageVal/avg).toFixed(1)}x your average`, avg };
  return { ok:true, anomaly:false, avg:parseFloat(avg.toFixed(2)) };
}

// From the numbers OCR found on the photo, choose the most likely CURRENT meter
// reading and reject misreads — barcodes, serial/model numbers, the stray "0" off
// the nameplate. The PREVIOUS reading is the anchor: a real new reading sits just
// above it, and the consumption (reading − prev) must be plausible for the meter.
// Returns null when nothing is convincing, so the field is left empty for manual
// entry instead of pre-filled with a wrong number. Water keeps 2 decimals.
function pickPlausibleReading(nums, { utilId, prevRead }) {
  const cand = [...new Set((nums || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (!cand.length) return null;
  const prev = parseFloat(prevRead);
  if (!Number.isFinite(prev)) return null; // no anchor yet (first reading) → don't guess
  const ok = cand
    .filter(n => n > prev && checkPlausibility(utilId, +(n - prev).toFixed(2)).ok)
    .sort((a, b) => a - b);                // closest above the previous reading is likeliest
  if (!ok.length) return null;
  return utilId === "water" ? +ok[0].toFixed(2) : ok[0];
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
  text:"#0d1812", textMid:"#334a3e", textSoft:"#7a9188",
  border:"#cbc6bc", shadow:"rgba(13,24,18,0.05)", shadowMd:"rgba(13,24,18,0.10)",
  electric:"#8a4200", electricBg:"#f0e8de", electricBorder:"#b89070",
  gas:"#7a1c1c",      gasBg:"#ede0e0",    gasBorder:"#b88a8a",
  water:"#10386a",    waterBg:"#dde8f4",  waterBorder:"#80a8cc",
  solar:"#264d3a",    solarBg:"#dce8e1",  solarBorder:"#90b8a2",
  card:"#f5f2ec", navBg:"rgba(237,233,226,0.97)",
  heroFrom:"#1a3326", heroTo:"#264d3a",
};
const DARK = {
  bg:"#0a1210", bgAlt:"#0f1a15", white:"#131d18",
  green1:"#72b890", green2:"#5a9e78", green3:"#88cc9e", green4:"#243c30", green5:"#101c16",
  text:"#ccc8c0", textMid:"#84a494", textSoft:"#486055",
  border:"#1a2c22", shadow:"rgba(0,0,0,0.30)", shadowMd:"rgba(0,0,0,0.42)",
  electric:"#c07030", electricBg:"#1a1208", electricBorder:"#3c2408",
  gas:"#c04040",      gasBg:"#1a0c0c",    gasBorder:"#3c1212",
  water:"#3070bc",    waterBg:"#081018",  waterBorder:"#102a50",
  solar:"#5a9e78",    solarBg:"#0a1810",  solarBorder:"#183224",
  card:"#131d18", navBg:"rgba(10,18,16,0.97)",
  heroFrom:"#0c1c14", heroTo:"#1a3326",
};

const UTIL_ICONS = {
  electric: <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M11 2L4 12h6l-1 6 7-10h-6l1-6z"/></svg>,
  gas:      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="16" height="16"><path d="M10 17c-3.3 0-6-2.7-6-6 0-4 3-7 6-9 3 2 6 5 6 9 0 3.3-2.7 6-6 6z"/><path d="M10 13a2 2 0 000-4c-1.1 0-2 .9-2 2" strokeOpacity=".6"/></svg>,
  water:    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M10 2C7 6 4 9.5 4 13a6 6 0 0012 0c0-3.5-3-7-6-11z" opacity=".9"/></svg>,
  solar:    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width="16" height="16"><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M4.6 15.4l1.4-1.4M14 6l1.4-1.4"/></svg>,
};

const UTILS = [
  { id:"electric", label:"Electric", unit:"kWh", rate:0.61, ph:["3834.8","3847.2"], hint:"Lights, appliances, boiler" },
  { id:"gas",      label:"Gas",      unit:"m³",  rate:0.84, ph:["521.4","523.1"],   hint:"Heating & cooking" },
  { id:"water",    label:"Water",    unit:"L",   rate:0.12, ph:["12320","12450"],    hint:"Household water usage" },
  { id:"solar",    label:"Solar",    unit:"kWh", rate:0.72, ph:["130.1","142.3"],    hint:"Solar panel output", optional:true },
];

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

function getUtil(id){ return UTILS.find(u=>u.id===id)||UTILS[0]; }
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


const COOLDOWN_MS = 20 * 60 * 60 * 1000;
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

// Pre-process a meter photo for OCR: scale up, greyscale, then binarise with
// Otsu so the digits become clean black-on-white — what Tesseract reads best.
// `invert` flips it (for light-on-dark LED/LCD displays). Returns a canvas.
async function preprocessForOCR(file, invert = false) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });
  const targetW = 1280;
  const scale = Math.min(2.5, targetW / (img.width || targetW)) || 1;
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
      let bw = gray[p] > t ? 255 : 0;
      if (invert) bw = 255 - bw;
      d[i] = d[i + 1] = d[i + 2] = bw;
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
  await worker.setParameters({ tessedit_char_whitelist: "0123456789.", tessedit_pageseg_mode: "6" });
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
// of the given model. Returns merged candidates + text + best confidence.
async function recognizeAll(Tesseract, model, sources) {
  const worker = await makeWorker(Tesseract, model);
  let cands = [], text = "", confidence = 0;
  try {
    for (const src of sources) {
      if (!src) continue;
      const data = await worker.recognize(src).then(r => r.data).catch(() => null);
      if (!data) continue;
      cands = cands.concat(extractCandidates(data));
      if (data.text) text = data.text;
      confidence = Math.max(confidence, data.confidence || 0);
    }
  } finally {
    try { await worker.terminate(); } catch {}
  }
  return { cands, text, confidence };
}

async function runOCR(file, claimedReading, utilId) {
  try {
    const Tesseract = await loadTesseract();
    const model = OCR_MODEL[utilId] || "eng";
    const digital = OCR_MODEL[utilId] === "ssd";

    // Binarised normal pass; for digital displays also a binarised INVERTED pass
    // (LED/LCD digits are often light-on-dark) — merge both for robustness.
    const normal = await preprocessForOCR(file, false).catch(() => file);
    const sources = [normal];
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

.intro-screen{position:fixed;inset:0;background:linear-gradient(135deg,#1a3326 0%,#264d3a 100%);z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 28px 44px;min-height:100vh;}
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
.util-selector{display:grid;grid-template-columns:repeat(4,1fr);margin:0 14px 14px;border:1px solid ${T.border};border-radius:4px;overflow:hidden;}
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
.vz-meter{font-size:10px;font-weight:700;font-family:'DM Mono',monospace;color:${T.green1};background:${T.bgAlt};border:1px solid ${T.border};border-radius:3px;padding:2px 8px;letter-spacing:.4px;}
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
.sbtn{width:100%;background:linear-gradient(135deg,${T.green1},${T.green2});border:none;border-radius:4px;padding:14px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 12px rgba(26,51,38,0.2);}
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
    <div className="intro-screen" style={{ zIndex: 410 }}>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", width:"100%" }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ marginBottom:24, animation:"intro-bounce 1.2s ease-in-out infinite", display:"flex", justifyContent:"center" }}><LogoTile size={104} /></div>
          <h1 style={{ fontSize:30, fontWeight:800, color:"#fff", lineHeight:1.2, letterSpacing:"-0.6px", marginBottom:12, maxWidth:300 }}>Connect your wallet</h1>
          <p style={{ fontSize:14, color:"rgba(255,255,255,0.8)", lineHeight:1.6, maxWidth:320, marginBottom:24 }}>
            Sign in with VeWorld, WalletConnect or Sync2 to start logging meters and earning B3TR. After this, each submission just needs a single signature.
          </p>
        </div>
      </div>
      <button
        className="intro-btn"
        onClick={onConnect}
        disabled={!online}
        style={!online ? { opacity:0.5, cursor:"not-allowed" } : undefined}
      >
        {online ? "Connect Wallet" : "You're offline"}
      </button>
      <div style={{ marginTop:14, fontSize:11, color:"rgba(255,255,255,0.55)", textAlign:"center", maxWidth:300, lineHeight:1.5 }}>
        Your wallet stays in your control — we never see your keys.
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
    { icon: '💰', title: 'Earn B3TR Rewards', sub: 'Get paid in real cryptocurrency for every meter you log. Weekly payouts guaranteed.' },
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

// Default baselines used when a meter is registered without a starting reading.
const BASELINE_DEFAULTS = { electric:"3834.8", gas:"521.4", water:"12320", solar:"130.1" };

function BaselineOnboarding({ onDone, utils, existingBaselines, existingMeters, editMode }) {
  // Which utilities this screen registers. Defaults to the required ones
  // (electric/gas/water); solar is added separately as an optional extra.
  const shown = (utils && utils.length) ? utils : UTILS.filter(u => !u.optional);
  const [baselines, setBaselines] = useState(existingBaselines || { electric:"", gas:"", water:"", solar:"" });
  const [meters, setMeters]       = useState(existingMeters || { electric:"", gas:"", water:"", solar:"" });

  // Photo-assisted reading: snap the meter, OCR the digits and pre-fill the
  // baseline (the user can still correct it). The meter number stays typed.
  const fileRef = useRef(null);
  const scanUtilRef = useRef(null);
  const [scanning, setScanning] = useState(null);
  const [scanMsg, setScanMsg]   = useState(null);
  const onScanClick = (id) => { scanUtilRef.current = id; setScanMsg(null); fileRef.current?.click(); };
  const onScanFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const id = scanUtilRef.current;
    if (!file || !id) return;
    setScanning(id); setScanMsg(null);
    try {
      const res = await runOCR(file, "", id);
      const reading = (res.ocrBest != null ? res.ocrBest : pickMeterReading(res.ocrNums));
      if (reading != null) { setBaselines(b => ({ ...b, [id]: String(reading) })); setScanMsg({ id, ok:true }); }
      else setScanMsg({ id, ok:false });
    } catch { setScanMsg({ id, ok:false }); }
    setScanning(null);
  };

  const isSolarOnly = shown.length === 1 && shown[0].id === "solar";
  // Anti-fraud: a meter that's already registered is LOCKED — you can view it but
  // not change the number or baseline (which would let you reset cooldowns or
  // inflate the next usage delta). Only not-yet-registered meters are editable.
  const isLocked = (u) => editMode && (existingMeters?.[u.id] || "").trim().length > 0;
  const allLocked = shown.length > 0 && shown.every(isLocked);
  // In edit mode every shown meter is expected; on first setup only the
  // non-optional ones are required to continue.
  const required = editMode ? shown : shown.filter(u => !u.optional);
  const allMetersFilled = required.every(u => (meters[u.id] || "").trim().length > 0);

  const handleDone = () => {
    if (!allMetersFilled) return;
    // Merge into the existing data so editing one meter never wipes the others.
    const nextBaselines = { ...(existingBaselines || {}) };
    const nextMeters    = { ...(existingMeters || {}) };
    for (const u of shown) {
      nextBaselines[u.id] = (baselines[u.id] || "").trim() || BASELINE_DEFAULTS[u.id];
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
      ? "Generating your own power? Add your solar meter number and current export reading — tap 📷 to scan the reading from a photo."
      : "Enter each meter number, then the current reading — or tap 📷 to scan it from a photo. The meter number is logged with every submission to keep your readings verifiable.";

  return (
    <div className="onboard">
      <div className="ob-icon">{isSolarOnly ? "☀️" : "⚙️"}</div>
      <div className="ob-title" style={{color:"#1a3326"}}>{title}</div>
      <div className="ob-sub">{sub}</div>
      <div style={{width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8,marginTop:20}}>
        {shown.map(u => {
          const needsMeter = required.includes(u);
          const locked = isLocked(u);
          const lockedInput = {width:"100%",background:"rgba(26,51,38,0.05)",border:"1px solid rgba(26,51,38,0.12)",borderRadius:3,padding:"7px 10px",fontSize:13,fontFamily:"'DM Mono',monospace",color:"#5a6f64",outline:"none",marginBottom:6,cursor:"not-allowed"};
          return (
          <div key={u.id} style={{display:"flex",alignItems:"flex-start",gap:12,background:"rgba(26,51,38,0.06)",borderRadius:4,padding:"10px 14px",border:"1px solid rgba(26,51,38,0.12)"}}>
            <span style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",color:"#264d3a",flexShrink:0,marginTop:2}}>{UTIL_ICONS[u.id]}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:"#7a9188",marginBottom:4}}>{u.label} <span style={{fontWeight:400}}>({u.unit})</span>{locked ? <span style={{fontWeight:400,textTransform:"none",letterSpacing:0,color:"#264d3a"}}> · 🔒 locked</span> : (!needsMeter && <span style={{fontWeight:400,textTransform:"none",letterSpacing:0}}> · optional</span>)}</div>
              <input
                type="text"
                readOnly={locked}
                placeholder={needsMeter ? "Meter / EAN number" : "Meter / EAN number (optional)"}
                value={meters[u.id]}
                onChange={locked ? undefined : (e => setMeters(m => ({...m,[u.id]:e.target.value})))}
                style={locked ? lockedInput : {width:"100%",background:"rgba(26,51,38,0.04)",border:`1px solid ${((meters[u.id]||"").trim() || !needsMeter) ? "rgba(26,51,38,0.15)" : "rgba(180,60,40,0.45)"}`,borderRadius:3,padding:"7px 10px",fontSize:13,fontFamily:"'DM Mono',monospace",color:"#0d1812",outline:"none",marginBottom:6}}
              />
              {locked ? (
                <input type="text" readOnly value={`${baselines[u.id] || ""} ${u.unit}`} style={lockedInput} />
              ) : (
              <div style={{display:"flex",gap:6,alignItems:"stretch"}}>
                <input
                  type="number"
                  placeholder={`Current reading · e.g. ${u.ph[0]}`}
                  value={baselines[u.id]}
                  onChange={e => setBaselines(b => ({...b,[u.id]:e.target.value}))}
                  style={{flex:1,minWidth:0,background:"rgba(26,51,38,0.04)",border:"1px solid rgba(26,51,38,0.15)",borderRadius:3,padding:"7px 10px",fontSize:14,fontFamily:"'DM Mono',monospace",color:"#0d1812",outline:"none"}}
                />
                <button type="button" onClick={()=>onScanClick(u.id)} disabled={scanning===u.id}
                  title="Scan the reading from a photo" aria-label={`Scan ${u.label} reading from a photo`}
                  style={{flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",minWidth:42,background:"rgba(26,51,38,0.07)",border:"1px solid rgba(26,51,38,0.18)",borderRadius:3,fontSize:14,color:"#264d3a",cursor:scanning===u.id?"wait":"pointer"}}>
                  {scanning===u.id ? "…" : "📷"}
                </button>
              </div>
              )}
              {!locked && scanning===u.id && <div style={{fontSize:10,color:"#7a9188",marginTop:4}}>Reading the meter…</div>}
              {!locked && scanMsg && scanMsg.id===u.id && scanning!==u.id && (
                scanMsg.ok
                  ? <div style={{fontSize:10,color:"#2e7d52",marginTop:4}}>✓ Filled from photo — check it's right.</div>
                  : <div style={{fontSize:10,color:"#b43c28",marginTop:4}}>Couldn't read it — type the reading in.</div>
              )}
            </div>
          </div>
          );
        })}
      </div>
      <input type="file" ref={fileRef} onChange={onScanFile} accept="image/*" capture="environment" style={{display:"none"}} />
      {!isSolarOnly && !allLocked && <div style={{fontSize:11,color:"#7a9188",marginTop:16,textAlign:"center"}}>ℹ️ Got solar panels? Add them later in Settings.</div>}
      {allLocked && <div style={{fontSize:11,color:"#7a9188",marginTop:16,textAlign:"center"}}>🔒 Locked to prevent fraud. To replace a meter, contact support.</div>}
      {!allMetersFilled && <div style={{fontSize:11,color:"#b43c28",marginTop:6,textAlign:"center"}}>Enter a meter number for every meter to continue.</div>}
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

function VerifyZone({ utilId, onVerified, onReset, onOcrReading, reading, prevRead, subs, meterNo }) {
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null);
  const [secScore, setSecScore] = useState(null);
  const [aiStep, setAiStep] = useState(0);
  const [photoUrl, setPhotoUrl] = useState(null);
  const fileInputRef = useRef(null);
  const cooldownMs = getCooldownRemaining(utilId);

  // Release the preview object URL when it changes or the component unmounts.
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const runVerify = async (file) => {
    setPhase("verifying"); setAiStep(0);
    const mime   = file.type;
    const base64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(file); });
    const fraudFlags = [];
    let   fraudReason = null;

    setAiStep(0);
    const imgHash = await hashImage(base64);
    const hashOk  = !!imgHash && !usedHashes.has(imgHash); // null hash = unverifiable = fail closed
    if (!hashOk) {
      fraudFlags.push("duplicate_photo");
      fraudReason = imgHash ? "Duplicate photo detected. Each submission needs a fresh photo." : "Couldn't verify the photo — please retake it.";
    }

    setAiStep(1);
    const fileMeta = checkFileMeta(file);
    if (!fileMeta.ok) fraudFlags.push(...fileMeta.flags);

    setAiStep(2);
    const ssCheck = await detectScreenshot(base64, mime);
    if (ssCheck.isScreenshot) { fraudFlags.push("screenshot_detected"); fraudReason = fraudReason || "Screenshot detected. Please take a real photo of your physical meter."; }

    setAiStep(3);
    const ocrResult = await runOCR(file, reading, utilId);
    // Pre-fill Current from the photo — but only with a number that makes sense
    // against your previous reading (a real new reading sits just above it). This
    // rejects barcodes/serials/"0" the OCR picks off the nameplate; if nothing is
    // convincing the field stays empty rather than filled with a wrong number.
    const guess = pickPlausibleReading([...(ocrResult.ocrNums || []), ocrResult.ocrBest], { utilId, prevRead });
    if (guess != null) onOcrReading?.(String(guess));
    if (!ocrResult.matched && !ocrResult.ocrFailed) {
      fraudFlags.push("ocr_mismatch");
      fraudReason = fraudReason || ocrResult.reason;
    }

    // Plausibility/anomaly run on CONSUMPTION (current − previous), not the
    // absolute meter value, otherwise a normal reading like 3847 always trips.
    const r = parseFloat(reading), p = parseFloat(prevRead);
    const usageVal   = (Number.isFinite(r) && Number.isFinite(p) && r > p) ? +(r - p).toFixed(2) : null;
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

    const verified = fraudFlags.length === 0 && score >= 40;
    const summary  = verified
      ? `${getUtil(utilId).label} meter${meterNo ? ` #${meterNo}` : ""} verified. ${ocrResult.ocrNums?.length ? "OCR read: " + ocrResult.ocrNums.slice(0,2).join(", ") + "." : "Reading accepted."}`
      : (fraudReason || "Verification failed. Please retake the photo.");

    const finalResult = { verified, fraudFlags, fraudReason, summary, ocrNums: ocrResult.ocrNums, ocrFailed: !!ocrResult.ocrFailed, secScore: score, anomCheck, usageVal };
    setResult(finalResult);
    setPhase(verified ? "verified" : "error");
    if (verified) onVerified(finalResult, base64, mime);
  };

  const handleFile = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setPhotoUrl(URL.createObjectURL(file));   // show a preview of what was captured
    await runVerify(file);
  };

  const reset = () => { setPhase("idle"); setResult(null); setSecScore(null); setPhotoUrl(null); onReset(); };

  if (phase === "idle") return (
    <div className="verify-zone" onClick={() => cooldownMs === 0 && fileInputRef.current?.click()}>
      <div className="vz-idle">
        <div className="vz-icon">📸</div>
        <div className="vz-title">Verify Meter</div>
        {meterNo && <div className="vz-meter">Meter #{meterNo}</div>}
        <div className="vz-sub">{cooldownMs > 0 ? `Next submission in ${fmtCooldown(cooldownMs)}` : "Tap to photograph"}</div>
      </div>
      <input type="file" ref={fileInputRef} onChange={handleFile} accept="image/*" style={{display:"none"}} capture="environment" />
    </div>
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
        <div style={{fontSize:12,fontWeight:700,color:"#7a1c1c",marginBottom:8}}>⚠️ Verification failed</div>
        <div style={{fontSize:11,color:"#666",marginBottom:12}}>{result.summary}</div>
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
          <div style={{marginTop:12,padding:10,background:"#fff3e0",border:"1px solid #FFB74D",borderRadius:4}}>
            <div style={{fontSize:11,fontWeight:700,color:"#E65100"}}>⚠️ High Usage Detected</div>
            <div style={{fontSize:10,color:"#666",marginTop:4}}>This reading is {result.anomCheck.avg ? Math.round(result.usageVal/result.anomCheck.avg*100) : "significantly"} higher than your average.</div>
            <div style={{fontSize:10,color:"#E65100",marginTop:4,fontWeight:600}}>Allow anyway? Tap Submit to continue.</div>
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

function HistItem({ s, T }) {
  const util = getUtil(s.type);
  const delta = (parseFloat(s.cur) - parseFloat(s.prev)).toFixed(2);
  return (
    <div className="hitem">
      <div className="hicon" style={{background: getColorBg(s.type, T), color: T[s.type] || T.electric}}>{UTIL_ICONS[s.type]}</div>
      <div className="hinfo">
        <div className="htitle">{util.label}{s.meterNo ? <span style={{fontWeight:400,color:T.textSoft,fontFamily:"'DM Mono',monospace",fontSize:9}}> · #{s.meterNo}</span> : null}</div>
        <div className="hdate">{s.date}</div>
        <div style={{color: T[s.type] || T.electric}}>{delta} {util.unit}</div>
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
        <div className="hero-usd">≈ ${(b3tr * B3TR_USD).toFixed(2)} USD · Powered by VeChain</div>
        <div className="hero-chips">
          <div className="hchip"><div className="hchip-val">{streak}</div><div className="hchip-key">Day Streak</div></div>
          <div className="hchip"><div className="hchip-val">{subs.length}</div><div className="hchip-key">Submissions</div></div>
          <div className="hchip"><div className="hchip-val">Top 6%</div><div className="hchip-key">Ranking</div></div>
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

function SubmitScreen({ u, selUtil, setSelUtil, aiOk, setAiOk, setPhoto, reading, setReading, prevRead, setPrevRead, busy, usage, reward, handleSubmit, verifyKey, wallet, setShowWallet, subs, meters, T, setTab }) {
  const meterNo  = (meters?.[selUtil] || "").trim();

  return (
    <>
      <div className="sub-header">
        <div className="sub-title">Daily Submission</div>
        <div className="sub-sub">Log your meter reading · Earn B3TR on VeChain</div>
      </div>
      <div className="util-selector">
        {UTILS.map(ut => (
          <button key={ut.id} className={`utab ${selUtil===ut.id?"active":""}`}
            style={{"--uc":T[ut.id]||T.electric,"--ubg":getColorBg(ut.id, T),"--uborder":T[ut.id+"Border"]||T.electricBorder}}
            onClick={() => setSelUtil(ut.id)}>
            <span className="utab-icon">{UTIL_ICONS[ut.id]}</span>{ut.label}
          </button>
        ))}
      </div>

      <div style={{margin:"0 14px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,padding:"9px 12px",background:meterNo?getColorBg(selUtil,T):T.gasBg,border:`1px solid ${meterNo?(T[selUtil+"Border"]||T.electricBorder):T.gasBorder}`,borderRadius:6}}>
        <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft}}>Registered meter</div>
        <div style={{fontSize:12,fontWeight:700,fontFamily:"'DM Mono',monospace",color:meterNo?(T[selUtil]||T.text):T.gas}}>{meterNo || "Not registered"}</div>
      </div>

      <VerifyZone key={verifyKey} utilId={selUtil} reading={reading} prevRead={prevRead} subs={subs} meterNo={meterNo}
        onOcrReading={(v) => { if (!String(reading).trim()) setReading(String(v)); }}
        onVerified={(res, img, mime) => { setAiOk(true); setPhoto?.(img ? { base64: img, mime, ocrNums: res?.ocrNums || [], ocrFailed: !!res?.ocrFailed } : null); }}
        onReset={() => { setAiOk(false); setPhoto?.(null); }} />

      <div style={{margin:"14px 14px 0",padding:12,background:T.waterBg,border:`1px solid ${T.waterBorder}`,borderRadius:6}}>
        <div style={{fontSize:12,fontWeight:700,color:T.water,marginBottom:8}}>💡 Tips for Successful Verification</div>
        <ul style={{margin:0,paddingLeft:18,fontSize:11,color:T.textSoft,lineHeight:1.6}}>
          <li>📸 Take a clear, well-lit photo of the meter face</li>
          <li>🔢 Ensure all numbers are visible and readable</li>
          <li>⚡ Avoid shadows or glare on the display</li>
          <li>📱 Hold your phone steady for sharp image</li>
          <li>🔄 Fresh photo needed - each meter per 20 hours</li>
          <li>✓ AI must verify before submitting to blockchain</li>
        </ul>
      </div>

      <div className="form-card" style={{"--uc":T[u.id]||T.electric,"--ubg":getColorBg(u.id, T),"--uborder":T[u.id+"Border"]||T.electricBorder,marginTop:14}}>
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

        {usage() > 0 && (
          <div className="reward-preview">
            <div>
              <div className="rp-label">Estimated Reward</div>
              <div className="rp-rate">{usage()} {u.unit} × {u.rate} B3TR/{u.unit}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div className="rp-val">+{reward()}</div>
              <div className="rp-b3tr">B3TR</div>
            </div>
          </div>
        )}

        {!wallet
          ? <button className="sbtn" onClick={() => setShowWallet(true)}>Connect Wallet to Submit</button>
          : !meterNo
            ? <button className="sbtn" disabled style={{opacity:.55}}>Register this meter first</button>
            : !aiOk
              ? <button className="sbtn" disabled style={{opacity:.55}}>📸 Verify a meter photo to submit</button>
              : usage() <= 0
                ? <button className="sbtn" disabled style={{opacity:.55}}>Enter a current reading above</button>
                : <button className="sbtn" disabled={busy} onClick={handleSubmit}>
                    {busy ? <><span className="spin-sm"/> Submitting on VeChain…</> : <>Submit & Earn B3TR</>}
                  </button>
        }
      </div>
    </>
  );
}

function ChartsScreen({ subs, T }) {
  return (
    <>
      <div className="page-title">Analytics</div>
      {UTILS.map(u => {
        // Real per-submission consumption (current − previous), last 7, oldest→newest.
        const myS = subs.filter(s => s.type === u.id).slice(0, 7).reverse();
        const series = myS.map(s => ({
          v: Math.max(0, (parseFloat(s.cur) - parseFloat(s.prev)) || 0),
          label: (s.date || "").slice(5).replace("-", "/"),
        }));
        const avg = series.length ? series.reduce((a, d) => a + d.v, 0) / series.length : 0;
        const max = Math.max(...series.map(d => d.v), 0);
        return (
          <div key={u.id} className="chart-card">
            <div className="chart-hdr">
              <div className="chart-title">{u.label}</div>
              <div style={{fontSize:10,color:T.textSoft}}>{series.length} reading{series.length!==1?"s":""}{series.length ? ` · avg ${avg.toFixed(2)} ${u.unit}` : ""}</div>
            </div>
            {series.length ? (
              <div className="chart-bars">
                {series.map((d, i) => (
                  <div key={i} className="chart-bar-wrap">
                    <div className="chart-bar" style={{background: T[u.id]||T.electric, height: max > 0 ? `${Math.max(8, (d.v/max)*100)}%` : "8px"}} title={`${d.v.toFixed(2)} ${u.unit}`}/>
                    <div className="chart-lbl">{d.label}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{padding:"18px 4px",fontSize:11,color:T.textSoft,textAlign:"center"}}>No readings yet — log this meter to see your usage.</div>
            )}
          </div>
        );
      })}
    </>
  );
}

function LeaderboardScreen({ b3tr, streak, subs, wallet, T }) {
  const currentTier = getTier(b3tr);
  const nextTier = TIERS[TIERS.indexOf(currentTier) + 1];
  const progressPercent = nextTier ? Math.min(100, Math.round((b3tr - currentTier.min) / (nextTier.min - currentTier.min) * 100)) : 100;
  const b3trNeeded = nextTier ? Math.max(0, nextTier.min - b3tr) : 0;
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
          <div style={{fontSize:10,fontWeight:700,color:T.green3,fontFamily:"'SF Mono',monospace"}}>{b3trNeeded.toFixed(2)} away</div>
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
        <div style={{fontSize:11,color:T.textSoft,fontFamily:"'DM Mono',monospace"}}>{subs.length} total</div>
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
function AdminScreen({ onClose, T }) {
  const [chain, setChain] = useState({ status: "loading", rows: [], reason: null });
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetchOnChainLeaderboard({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, signal: ctrl.signal })
      .then(res => { if (!cancelled) setChain(res.ok ? { status: "live", rows: res.rows } : { status: "empty", rows: [], reason: res.reason }); })
      .catch(() => { if (!cancelled) setChain({ status: "error", rows: [] }); });
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  const totalB3tr = chain.rows.reduce((a, r) => a + (r.b3tr || 0), 0);
  const totalSubs = chain.rows.reduce((a, r) => a + (r.count || 0), 0);

  return (
    <div style={{position:"fixed",inset:0,background:T.bg,zIndex:320,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>🛡️ Admin · Participants</div>
          <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>Read-only on-chain monitor · {NETWORK_LABEL}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"6px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Close</button>
      </div>

      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:14}}>
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
        {chain.rows.map((r, i) => (
          <div key={r.addr} className="lb-item">
            <div className="lb-rank">{i + 1}</div>
            <div style={{flex:1}}>
              <div className="lb-name" style={{fontFamily:"'SF Mono',monospace",fontSize:11}}>{shortAddr(r.addr)}</div>
              <div style={{fontSize:9,color:T.textSoft}}>📸 {r.count} submission{r.count !== 1 ? "s" : ""}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div className="lb-b3tr">+{r.b3tr.toFixed(2)}</div>
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
          <div><div className="sr-label">Meters & Baselines</div><div className="sr-sub">Electric, gas &amp; water</div></div>
        </div>
        <div className="sr-right" style={{fontSize:11,color:T.textSoft}}>→</div>
      </div>
      {(() => {
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
function HelpScreen({ onClose, onFeedback, T }) {
  const steps = [
    { n: 1, t: "Connect your wallet", d: "Tap Connect and open VeWorld (set to Testnet) or WalletConnect. This is a test app — no real funds are used." },
    { n: 2, t: "Get free test gas (VTHO)", d: `Transactions cost a tiny bit of VTHO. Grab some free testnet VTHO from the faucet, then come back.` },
    { n: 3, t: "Register your meters", d: "Enter the meter number and the current reading (baseline) for electricity, gas and water. Solar is optional." },
    { n: 4, t: "Submit a reading", d: "Go to Submit, pick a utility, photograph the meter (the app reads the number for you), check it, and send." },
    { n: 5, t: "Earn B3TR", d: "A valid reading rewards you with B3TR on testnet. Track your total on Home and your position on the Leaderboard." },
  ];
  const faqs = [
    { q: "Is this real money?", a: "No. Everything runs on VeChain testnet, so the B3TR you earn are test tokens with no real value — perfect for trying things out safely." },
    { q: "I submitted but got no B3TR — why?", a: "Most common reasons: the new reading isn't higher than your last one, you're still within the ~20h cooldown for that utility, or the photo was reused/looked like a screenshot. Try a fresh photo of an actual meter." },
    { q: "What's the cooldown?", a: "You can earn once per utility roughly every 20 hours. This keeps things fair while testing." },
    { q: "My photo was rejected.", a: "Use a real, clear photo of your own meter — good lighting, numbers in focus, no screenshots or photos of a screen." },
    { q: "I cleared my browser / reconnected and lost my meters?", a: "Reconnecting the SAME wallet keeps your meters and baselines. Only connecting a different wallet starts a fresh setup." },
    { q: "My wallet won't connect.", a: "Make sure VeWorld is switched to Testnet. On mobile, use the in-app browser or WalletConnect QR." },
    { q: "Found a bug or have an idea?", a: "Use Send Feedback below — it pre-fills an email with your message and some helpful diagnostics." },
  ];
  const row = { background:T.card, border:`1px solid ${T.border}`, borderRadius:6, padding:"12px 14px", marginBottom:8 };
  return (
    <div style={{position:"fixed",inset:0,background:T.bg,zIndex:330,display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>❓ Help &amp; FAQ</div>
          <div style={{fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>Getting started · {NETWORK_LABEL}</div>
        </div>
        <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:4,padding:"6px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Close</button>
      </div>

      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"16px 14px 28px"}}>
        <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"4px 2px 10px"}}>Quick start</div>
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

        <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"18px 2px 10px"}}>Frequently asked</div>
        {faqs.map((f, i) => (
          <div key={i} style={row}>
            <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>{f.q}</div>
            <div style={{fontSize:12,color:T.textMid,lineHeight:1.55}}>{f.a}</div>
          </div>
        ))}

        <button onClick={onFeedback} style={{width:"100%",marginTop:14,background:T.green3,border:"none",borderRadius:6,padding:"13px",color:"#fff",fontSize:12,fontWeight:800,textTransform:"uppercase",letterSpacing:"1px",cursor:"pointer"}}>✉️ Send Feedback</button>
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
  // mobile / Sync2). useWallet() exposes the connected address and the
  // requestTransaction() signer; useWalletModal() opens the connect dialog.
  const { account, requestTransaction, disconnect } = useWallet();
  const wallet = account || null;
  const { open: openWalletModal } = useWalletModal();
  const openConnectModal = () => openWalletModal();

  // Wipe all local app data and the wallet connection, then reload — a clean
  // slate for testing. (On-chain reward history can't be erased; it re-hydrates
  // from the wallet's events on reconnect.)
  const resetApp = async () => {
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("greenlog_")) localStorage.removeItem(k);
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
  const [busy, setBusy]             = useState(false);
  const [toast, setToast]           = useState(null);
  const [b3tr, setB3tr]             = useState(68.34);
  const [subs, setSubs]             = useState(HISTORY_SEED);
  const streak = computeStreak(subs); // derived from real submission dates
  const [verifyKey, setVerifyKey]   = useState(0);
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
  useEffect(() => {
    if (!account) return;
    const addr = account.toLowerCase();
    if (sessionWalletRef.current === addr) return;
    sessionWalletRef.current = addr;

    let storedWallet = null;
    try { storedWallet = localStorage.getItem(WALLET_KEY); } catch {}

    setSubs([]);
    setB3tr(0);
    setReading(""); setPrevRead(""); setAiOk(false); setPhoto(null);
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
          setSubs(res.rows);
          setB3tr(res.rows.reduce((a, s) => a + (parseFloat(s.b3tr) || 0), 0));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [account]);

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

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  // When connectivity returns (and a wallet is connected), broadcast any
  // submissions that were queued while offline, then fold them into the
  // dashboard. Each one prompts the wallet to sign its reward transaction.
  const syncingRef = useRef(false);
  useEffect(() => {
    if (!online || !wallet) return;
    let cancelled = false;
    (async () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      try {
        const pending = await getUnsyncedSubmissions();
        let synced = 0;
        for (const item of pending) {
          if (cancelled) break;
          // Claim the item before broadcasting; if we crash mid-flight it stays
          // flagged and won't be re-sent (no double payout).
          await markBroadcasting(item.id, true);
          try {
            const clauses = buildRewardClauses(item.type, item.cur, item.prev, item.b3tr, wallet, item.meterNo);
            const { txid } = await requestTransaction(clauses);
            await markSynced(item.id, txid);
            if (cancelled) break;
            setSubs(prev => [{
              id: item.id, type: item.type, meterNo: item.meterNo || "",
              cur: item.cur, prev: item.prev, date: dayKey(new Date(item.id)),
              b3tr: item.b3tr, status: "confirmed", txHash: txid || "", submittedAt: item.id,
            }, ...prev]);
            setB3tr(b => b + (parseFloat(item.b3tr) || 0));
            synced++;
          } catch {
            // Broadcast failed (e.g. user rejected) — release it for a retry.
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

  const handleSelUtil = (id) => {
    if (id === selUtil) return; // re-tapping the active meter shouldn't clear input
    setSelUtil(id);
    setAiOk(false);
    setPhoto(null);
    setReading("");
    const lastSub = subs.find(s => s.type === id);
    setPrevRead(lastSub ? lastSub.cur : (baselines[id] || ""));
    setVerifyKey(k => k+1);
  };

  const usage = () => { const r=parseFloat(reading),p=parseFloat(prevRead); return(!r||!p||r<=p)?0:parseFloat((r-p).toFixed(2)); };
  const reward = () => parseFloat((usage()*u.rate).toFixed(2));

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

    // Don't broadcast a zero/NaN reward (blank or non-increasing readings).
    if (!(earned > 0)) {
      setBusy(false);
      showToast("⚠️ Enter a current reading higher than the previous one");
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
    // Not auto-blocked, but recorded for review when the photo can't back it up.
    const photoConfirmed = !photo?.ocrFailed && readingMatchesPhoto(reading, photo?.ocrNums);
    const flagReason = photo?.ocrFailed
      ? "photo_unreadable"
      : (photoConfirmed ? "" : "reading_not_in_photo");

    if (!online) {
      await saveOfflineSubmission({ type:selUtil, meterNo, cur:reading, prev:prevRead, b3tr:earned, flagged: !photoConfirmed, flagReason });
      setAiOk(false); setPhoto(null); setReading(""); setPrevRead(""); setVerifyKey(k=>k+1);
      setBusy(false);
      showToast("💾 Saved offline — syncing when online");
      return;
    }

    if (!wallet) {
      setBusy(false);
      openConnectModal();
      return;
    }

    try {
      // Two payout paths:
      //  • REWARD_API set → a server-side reward-distributor verifies and issues
      //    the B3TR (the production model; the user signs nothing).
      //  • otherwise → the connected wallet signs distributeReward directly
      //    (only works if that wallet holds the distributor role — fine for tests).
      let txid;
      if (REWARD_API) {
        const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/reward`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ utility: selUtil, reading, prevRead, meterNo, address: wallet, photo: photo?.base64 || "", clientFlagged: !photoConfirmed, flagReason, ocrNums: photo?.ocrNums || [] }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Reward service error ${res.status}`);
        txid = data.txid;
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
        b3tr: earned,
        status: photoConfirmed ? "confirmed" : "review",
        flagged: !photoConfirmed,
        flagReason,
        txHash: txid || "",
        submittedAt: Date.now()
      }, ...prev]);

      setB3tr(b => b + earned);
      setCooldown(selUtil);
      setAiOk(false);
      setPhoto(null);
      setReading("");
      setPrevRead("");
      setVerifyKey(k => k + 1);
      showToast(photoConfirmed
        ? `✅ +${earned.toFixed(2)} B3TR on ${NETWORK_LABEL}${txid ? ` • TX: ${txid.slice(0, 10)}...` : ""}`
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
      {needsBaselines && <BaselineOnboarding onDone={(bl, mtrs) => { setBaselines(bl); setMeters(mtrs); closeRegistration(); }} utils={regUtils} editMode={regEdit} existingBaselines={baselines} existingMeters={meters} />}
      {!onboarded && <Onboarding onDone={() => setOnboarded(true)} />}
      {showAdmin && isAdmin && <AdminScreen onClose={() => setShowAdmin(false)} T={T} />}
      {showHelp && <HelpScreen onClose={() => setShowHelp(false)} onFeedback={() => { setShowHelp(false); setShowFeedback(true); }} T={T} />}
      {showFeedback && <FeedbackScreen onClose={() => setShowFeedback(false)} onToast={showToast} wallet={wallet} tab={tab} T={T} />}
      {toast && <div className="toast">{toast}</div>}

      <div className="app">
        <div className="z1 scr">
          <div className="hdr">
            <div className="logo">
              <div className="logo-mark"><SproutIcon size={18} /></div>
              <div>
                <div className="logo-name">Green Utility Log</div>
                <div style={{fontSize:7,fontWeight:700,color:T.textSoft,textTransform:"uppercase",letterSpacing:"0.8px",marginTop:2}}>VeBetterDAO Vechain • v{APP_VERSION}</div>
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
                  (VeWorld, WalletConnect/mobile QR, Sync2) via useWalletModal. */}
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
          {tab==="submit"    && <SubmitScreen u={u} selUtil={selUtil} setSelUtil={handleSelUtil} aiOk={aiOk} setAiOk={setAiOk} setPhoto={setPhoto} reading={reading} setReading={setReading} prevRead={prevRead} setPrevRead={setPrevRead} busy={busy} usage={usage} reward={reward} handleSubmit={handleSubmit} verifyKey={verifyKey} wallet={wallet} setShowWallet={openConnectModal} subs={subs} meters={meters} T={T} setTab={setTab}/>}
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
