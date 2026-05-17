import { useState, useRef, useEffect } from "react";

// ─── ANTI-FARMING ENGINE ──────────────────────────────────────────────────────

// Realistic daily usage bounds per utility [min, max]
const USAGE_BOUNDS = {
  electric: [0.5,   60],    // kWh  – very low to heavy household
  gas:      [0.1,   20],    // m³
  water:    [20,  2000],    // L
  solar:    [0.1,   80],    // kWh
};

// Max allowed delta vs personal 7-day average before flagging
const ANOMALY_THRESHOLD = 3.5; // 350% of average = suspicious

// Minimum hours between submissions for the same meter
const COOLDOWN_HOURS = 20;

/** Returns how many ms remain on cooldown for a given utility, or 0 if clear */
function getCooldownMs(subs, utilId) {
  const last = subs.find(s => s.type === utilId);
  if (!last || !last.submittedAt) return 0;
  const elapsed = Date.now() - last.submittedAt;
  const cooldown = COOLDOWN_HOURS * 3600 * 1000;
  return Math.max(0, cooldown - elapsed);
}

/** Full fraud-check. Returns { ok, code, message } */
function fraudCheck(selUtil, reading, prevRead, subs, aiResult) {
  const r = parseFloat(reading), p = parseFloat(prevRead);
  const delta = r - p;
  const [minU, maxU] = USAGE_BOUNDS[selUtil];

  // 1. Reading must increase
  if (r <= p)
    return { ok:false, code:"NEGATIVE", message:"Current reading must be higher than previous." };

  // 2. Delta within physical bounds
  if (delta < minU)
    return { ok:false, code:"TOO_LOW", message:`Usage of ${delta.toFixed(2)} is below the minimum realistic value (${minU}).` };
  if (delta > maxU)
    return { ok:false, code:"TOO_HIGH", message:`Usage of ${delta.toFixed(2)} exceeds the realistic daily maximum (${maxU}). Check your reading.` };

  // 3. Anomaly vs personal average
  const recent = subs.filter(s => s.type === selUtil).slice(0, 7);
  if (recent.length >= 3) {
    const avg = recent.reduce((a,s) => a + (parseFloat(s.cur)-parseFloat(s.prev)), 0) / recent.length;
    if (avg > 0 && delta > avg * ANOMALY_THRESHOLD)
      return { ok:false, code:"ANOMALY", message:`This reading is ${Math.round(delta/avg*100)}% of your average. Unusually high — please double-check.` };
  }

  // 4. AI verification required
  if (!aiResult || !aiResult.verified)
    return { ok:false, code:"NO_AI", message:"Photo must be verified by AI before submitting." };

  // 5. AI confidence floor
  if (aiResult.confidence < 70)
    return { ok:false, code:"LOW_CONF", message:`AI confidence too low (${aiResult.confidence}%). Please retake the photo in better lighting.` };

  // 6. Cooldown
  const cdMs = getCooldownMs(subs, selUtil);
  if (cdMs > 0) {
    const hrs = Math.ceil(cdMs / 3600000);
    return { ok:false, code:"COOLDOWN", message:`You already submitted this meter today. Next allowed in ${hrs}h.` };
  }

  return { ok:true, code:"PASS", message:"All checks passed." };
}

/** Compute a trust score 0-100 for a user based on history */
function trustScore(subs) {
  if (!subs.length) return 50;
  const confirmed = subs.filter(s => s.status === "confirmed").length;
  const ratio = confirmed / subs.length;
  const streak = Math.min(subs.length, 30);
  return Math.round(ratio * 60 + (streak / 30) * 40);
}

// ─── THEME ────────────────────────────────────────────────────────────────────

// ─── OFFLINE STORAGE (IndexedDB) ─────────────────────────────────────────────
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
  { id:"solar",    label:"Solar",    unit:"kWh", rate:0.72, ph:["130.1","142.3"],    hint:"Solar panel output" },
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
  { rank:4,  name:"EcoMeter_42",   addr:"0x3f8a…a9c2", b3tr:68.3,  streak:14, tier:"Moon", isMe:true },
  { rank:5,  name:"WaterWarden",   addr:"0x3m4n…o5p6", b3tr:201.3, streak:15, tier:"Star" },
  { rank:6,  name:"NatureFirst",   addr:"0x7q8r…s9t0", b3tr:188.7, streak:13, tier:"Star" },
  { rank:7,  name:"CleanEnergy99", addr:"0xu1v2…w3x4", b3tr:174.2, streak:11, tier:"Sun" },
  { rank:8,  name:"ZeroCarbon",    addr:"0xy5z6…a7b8", b3tr:162.9, streak:10, tier:"Sun" },
  { rank:9,  name:"GreenGrid_EU",  addr:"0xc9d0…e1f2", b3tr:149.5, streak:9,  tier:"Sun" },
  { rank:10, name:"LeafLogger",    addr:"0xg3h4…i5j6", b3tr:138.1, streak:8,  tier:"Moon" },
];

// chart data per utility - last 7 days usage
const CHART_DATA = {
  electric: [12.8,13.4,11.2,14.1,12.4,13.8,12.5],
  gas:      [1.8, 2.1, 1.6, 2.4, 1.9, 2.2, 1.7],
  water:    [125, 130, 118, 142, 128, 135, 122],
  solar:    [12.2,10.8,13.5,11.4,12.1,9.8, 12.3],
};
const CHART_LABELS = ["Mo","Tu","We","Th","Fr","Sa","Su"];

const ONBOARD_SLIDES = [
  { icon:<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="40" height="40"><path d="M16 4C10 4 5 9 5 15c0 4 2.2 7.5 5.5 9.4V28h11v-3.6C24.8 22.5 27 19 27 15c0-6-5-11-11-11z" fill="currentColor" opacity=".15"/><path d="M16 4C10 4 5 9 5 15c0 4 2.2 7.5 5.5 9.4V28h11v-3.6C24.8 22.5 27 19 27 15c0-6-5-11-11-11z"/><path d="M12 15a4 4 0 018 0" opacity=".5"/></svg>, title:"Welcome to Green Utility Log", sub:"Track your home utilities, reduce your footprint, and earn B3TR rewards on VeChain.", color:"#1a3326" },
  { icon:<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="40" height="40"><rect x="5" y="8" width="22" height="18" rx="2"/><path d="M10 8V6a2 2 0 012-2h8a2 2 0 012 2v2"/><circle cx="16" cy="17" r="3.5"/><circle cx="16" cy="17" r="1"/></svg>, title:"How to Photograph", sub:"Meter must be clear, readable and unobstructed. Take a fresh photo each time.", color:"#10386a" },
  { icon:<svg viewBox="0 0 32 32" fill="currentColor" width="40" height="40"><path d="M17 4L8 18h8l-1 10 9-14h-8l1-10z" opacity=".9"/></svg>, title:"Electric Meter", sub:"LCD display showing kWh. Usually 3000–4000 range. Earn 0.61 B3TR/kWh", color:"#8a4200" },
  { icon:<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="40" height="40"><path d="M16 27c-5 0-9-4-9-9 0-6 4.5-10.5 9-13.5 4.5 3 9 7.5 9 13.5 0 5-4 9-9 9z" fill="currentColor" opacity=".12"/><path d="M16 27c-5 0-9-4-9-9 0-6 4.5-10.5 9-13.5 4.5 3 9 7.5 9 13.5 0 5-4 9-9 9z"/><path d="M16 20a3 3 0 000-6c-1.7 0-3 1.3-3 3" opacity=".5"/></svg>, title:"Gas Meter", sub:"Rotating dials or LCD in m³. Earn 0.84 B3TR/m³", color:"#7a1c1c" },
  { icon:<svg viewBox="0 0 32 32" fill="currentColor" width="40" height="40"><path d="M16 3C11 9 6 14 6 20a10 10 0 0020 0c0-6-5-11-10-17z" opacity=".9"/></svg>, title:"Water Meter", sub:"Shows litres or m³. Often on outside wall. Earn 0.12 B3TR/L", color:"#10386a" },
  { icon:<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="40" height="40"><circle cx="16" cy="16" r="5"/><path d="M16 4v3M16 25v3M4 16h3M25 16h3M7.8 7.8l2.1 2.1M22.1 22.1l2.1 2.1M7.8 24.2l2.1-2.1M22.1 9.9l2.1-2.1"/></svg>, title:"Solar Output", sub:"If you have panels, log your export in kWh. Earn 0.72 B3TR/kWh", color:"#264d3a" },
  { icon:<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="40" height="40"><path d="M16 6l3 7h7l-5.5 4 2 7L16 20l-6.5 4 2-7L6 13h7z" fill="currentColor" opacity=".15"/><path d="M16 6l3 7h7l-5.5 4 2 7L16 20l-6.5 4 2-7L6 13h7z"/></svg>, title:"Earn & Compete", sub:"Daily submissions build your streak. Climb the leaderboard and earn real B3TR.", color:"#3a1a6e" },
];

function getUtil(id){ return UTILS.find(u=>u.id===id)||UTILS[0]; }
function getColor(id,T){ return T[id]||T.electric; }
function getColorBg(id,T){ return T[id+"Bg"]||T.electricBg; }

// ─── SECURITY ENGINE ─────────────────────────────────────────────────────────

// 1. Photo hash — prevent exact duplicate image reuse
async function hashImage(base64) {
  try {
    const bytes = Uint8Array.from(atob(base64.slice(0,2000)), c => c.charCodeAt(0));
    const buf   = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
  } catch { return Math.random().toString(36).slice(2); }
}

// 2. Device fingerprint — stable per browser/device
function getDeviceId() {
  const key = "greenlog_device_id";
  let id = sessionStorage.getItem(key);
  if (!id) { id = crypto.randomUUID?.() || Math.random().toString(36).slice(2); sessionStorage.setItem(key, id); }
  return id;
}

// 3. Cooldown store — one submission per utility per 20h
const COOLDOWN_MS = 20 * 60 * 60 * 1000;
function getCooldowns() {
  try { return JSON.parse(sessionStorage.getItem("greenlog_cooldowns") || "{}"); } catch { return {}; }
}
function setCooldown(utilId) {
  const cd = getCooldowns(); cd[utilId] = Date.now();
  sessionStorage.setItem("greenlog_cooldowns", JSON.stringify(cd));
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

// 4. Used hashes store — prevent reuse across sessions in this run
const usedHashes = new Set();

// 5. Plausibility check — reading must be within normal range
const PLAUSIBLE_RANGES = {
  electric: { min:0.1,  max:80  }, // kWh per day
  gas:      { min:0.01, max:20  }, // m³ per day
  water:    { min:10,   max:1000}, // L per day
  solar:    { min:0.1,  max:60  }, // kWh per day
};
function checkPlausibility(utilId, usageVal) {
  const range = PLAUSIBLE_RANGES[utilId];
  if (!range) return { ok:true };
  if (usageVal < range.min) return { ok:false, reason:`Usage too low (${usageVal} < ${range.min} ${getUtil(utilId).unit})` };
  if (usageVal > range.max) return { ok:false, reason:`Abnormally high usage detected (${usageVal} ${getUtil(utilId).unit}). Flagged for review.` };
  return { ok:true };
}

// 6. Anomaly vs personal history — flag if >3× personal average
function checkAnomaly(utilId, usageVal, subs) {
  const recent = subs.filter(s=>s.type===utilId).slice(0,14);
  if (recent.length < 3) return { ok:true, anomaly:false };
  const avg = recent.reduce((a,s)=>a+(parseFloat(s.cur)-parseFloat(s.prev)),0)/recent.length;
  if (usageVal > avg * 3.5) return { ok:false, anomaly:true, reason:`Usage is ${(usageVal/avg).toFixed(1)}× your personal average. Flagged.` };
  return { ok:true, anomaly:false, avg:parseFloat(avg.toFixed(2)) };
}

// 7. Load Tesseract.js dynamically from CDN (free, no API key needed)
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

// 8. EXIF / file metadata check — detect old saved images & screenshots
function checkFileMeta(file) {
  const flags = [];
  const ageSec = (Date.now() - file.lastModified) / 1000;
  // Photo older than 2 hours is suspicious (saved image, not freshly taken)
  if (ageSec > 7200) flags.push("old_file");
  // PNG on mobile = almost always a screenshot (real camera photos are JPEG/HEIC)
  if (file.type === "image/png" && ageSec < 60) flags.push("likely_screenshot");
  // Tiny file = probably a screenshot or compressed web image, not a real photo
  if (file.size < 80_000) flags.push("file_too_small");
  return { ok: flags.length === 0, flags };
}

// 9. Canvas screenshot detector — checks pixel uniformity & color profile
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

        // Calculate colour variance — real photos have high variance (noise, grain)
        // Screenshots / printed paper tend to have flat uniform regions
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

        // Real camera photos typically have variance > 800
        // Screenshots / solid backgrounds < 400
        const isScreenshot = variance < 400;
        resolve({ isScreenshot, variance: Math.round(variance) });
      } catch { resolve({ isScreenshot: false, variance: 999 }); }
    };
    img.onerror = () => resolve({ isScreenshot: false, variance: 999 });
    img.src = `data:${mime};base64,${base64}`;
  });
}

// 10. Tesseract OCR — read meter digits & compare with entered reading
async function runOCR(file, claimedReading) {
  try {
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: () => {},
    });
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789.",
      tessedit_pageseg_mode: "6",
    });
    const { data: { text, confidence } } = await worker.recognize(file);
    await worker.terminate();

    // Extract all numbers from OCR result
    const nums = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
    if (!nums.length) return { matched: false, ocrNums: [], ocrConfidence: confidence, reason: "No digits detected in photo" };

    // Check if any OCR number matches the claimed reading within 8% tolerance
    const claimed = parseFloat(claimedReading);
    if (!claimed || isNaN(claimed)) return { matched: true, ocrNums: nums, ocrConfidence: confidence };

    const match = nums.find(n => Math.abs(n - claimed) / claimed < 0.08);
    if (!match) {
      // Check partial match — last 4 digits (for long meter readings like 12450)
      const claimedStr = String(Math.round(claimed));
      const partialMatch = nums.find(n => String(Math.round(n)).includes(claimedStr.slice(-4)));
      if (partialMatch) return { matched: true, ocrNums: nums, ocrConfidence: confidence, partialMatch: true };
      return {
        matched: false, ocrNums: nums, ocrConfidence: confidence,
        reason: `OCR reads ${nums.slice(0,3).join(", ")} — entered ${claimed}. Values don't match.`
      };
    }
    return { matched: true, ocrNums: nums, ocrConfidence: confidence };
  } catch (e) {
    // OCR failed — don't block, just warn
    return { matched: true, ocrNums: [], ocrConfidence: 0, ocrFailed: true };
  }
}

// 11. Compute security score (no AI needed)
function computeSecurityScore({ ocrMatched, ocrConfidence, plausible, anomaly, hashOk, fileOk, screenshotOk }) {
  let score = 100;
  if (!hashOk)       score -= 50;
  if (!fileOk)       score -= 20;
  if (!screenshotOk) score -= 25;
  if (!ocrMatched)   score -= 30;
  if (!plausible)    score -= 40;
  if (anomaly)       score -= 30;
  if (ocrConfidence > 0 && ocrConfidence < 50) score -= 10;
  return Math.max(0, Math.round(score));
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
function makeCSS(T){
return `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
html,body{background:${T.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${T.text};min-height:100vh;}
.app{max-width:420px;margin:0 auto;min-height:100vh;background:${T.bg};position:relative;transition:background .25s;}
.z1{position:relative;z-index:1;}
.scr{padding-bottom:85px;}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:${T.white};border-bottom:1px solid ${T.border};position:sticky;top:0;z-index:20;transition:background .25s,border-color .25s;gap:16px;}
.logo{display:flex;align-items:center;gap:10px;flex:1;}
.logo-mark{width:30px;height:30px;border-radius:4px;background:linear-gradient(135deg,${T.green1},${T.green2});display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 2px 8px ${T.shadow};}
.logo-name{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;font-weight:800;color:${T.text};letter-spacing:-0.5px;line-height:1;}
.logo-tag{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:${T.textSoft};margin-top:1px;}
.hdr-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.dark-toggle{width:30px;height:30px;border-radius:3px;background:transparent;border:1px solid ${T.border};display:flex;align-items:center;justify-content:center;cursor:pointer;color:${T.textMid};transition:all .15s;flex-shrink:0;}
.dark-toggle:hover{border-color:${T.green3};color:${T.green3};background:${T.bgAlt};}
.wallet-pill{display:flex;align-items:center;gap:6px;background:transparent;border:1px solid ${T.border};border-radius:3px;padding:6px 10px;cursor:pointer;transition:all .15s;flex-shrink:0;font-size:10px;font-weight:600;}
.wallet-pill:hover,.wallet-pill.connected{border-color:${T.green3};color:${T.green3};}
.wdot{width:5px;height:5px;border-radius:50%;background:${T.green3};animation:wpulse 2.5s infinite;flex-shrink:0;}
.wdot.off{background:${T.textSoft};animation:none;}
@keyframes wpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.25;transform:scale(.65)}}
.waddr{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:9px;color:${T.textMid};letter-spacing:0;}
.wconnect{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.green2};}

/* HERO */
.hero{margin:16px 14px 0;border-radius:5px;border:1px solid ${T.border};background:${T.card};padding:22px;position:relative;overflow:hidden;box-shadow:0 2px 6px ${T.shadow};}
.hero::after{display:none;}
.hero-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2.4px;color:${T.textSoft};margin-bottom:12px;}
.hero-amount{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:48px;font-weight:500;color:${T.text};line-height:1;letter-spacing:-1.5px;}
.hero-amount span{font-size:14px;font-weight:400;color:${T.textSoft};margin-left:8px;letter-spacing:0;}
.hero-usd{font-size:10px;color:${T.textSoft};margin-top:8px;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.hero-chips{display:flex;gap:0;margin-top:20px;padding-top:18px;border-top:1px solid ${T.border};}
.hchip{flex:1;padding-right:18px;margin-right:18px;border-right:1px solid ${T.border};}
.hchip:last-child{border-right:none;margin-right:0;padding-right:0;}
.hchip-val{font-size:20px;font-weight:600;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;line-height:1;}
.hchip-key{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};margin-top:5px;}

/* SEC */
.sec{display:flex;align-items:center;gap:12px;margin:24px 14px 14px;padding:0;}
.sec-line{flex:1;height:1px;background:${T.border};}
.sec-txt{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:2.8px;color:${T.textSoft};}

/* UTIL CARDS */
.util-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 14px 16px;}
.ucard{background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:14px;transition:all .2s;cursor:pointer;box-shadow:0 1px 3px ${T.shadow};}
.ucard:hover{border-color:${T.green3};box-shadow:0 4px 12px ${T.shadowMd};}
.ucard-icon{width:32px;height:32px;border-radius:4px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;color:${T.green2};font-size:16px;}
.ucard-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.text};}
.ucard-reads{font-size:9px;color:${T.textSoft};margin-top:4px;font-weight:500;}
.ucard-b3tr{font-size:16px;font-weight:600;margin-top:9px;font-family:'SF Mono',Menlo,'Courier New',monospace;}

/* CALENDAR */
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
.cal-legend{display:flex;align-items:center;gap:14px;margin-top:11px;padding-top:11px;border-top:1px solid ${T.border};}
.cal-leg-item{display:flex;align-items:center;gap:5px;font-size:8px;font-weight:600;color:${T.textSoft};text-transform:uppercase;letter-spacing:.8px;}
.cal-leg-dot{width:8px;height:8px;border-radius:1px;}

/* HISTORY */
.hitem{margin:0 14px 6px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:13px 14px;display:flex;align-items:center;gap:12px;transition:all .2s;box-shadow:0 1px 3px ${T.shadow};}
.hitem:hover{border-color:${T.green3};box-shadow:0 4px 12px ${T.shadowMd};}
.hicon{width:32px;height:32px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.hinfo{flex:1;min-width:0;}
.htitle{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${T.text};}
.hdate{font-size:10px;color:${T.textSoft};font-family:'SF Mono',Menlo,'Courier New',monospace;margin-top:2px;}
.hdelta{font-size:10px;color:${T.textMid};margin-top:2px;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.hright{text-align:right;flex-shrink:0;}
.hb3tr{font-size:14px;font-weight:500;color:${T.green1};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.hstatus{font-size:8px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;padding:1px 5px;border-radius:1px;margin-top:4px;display:inline-block;}
.s-confirmed{background:${T.green5};color:${T.green2};border:1px solid ${T.green4};}
.s-processing{background:${T.waterBg};color:${T.water};border:1px solid ${T.waterBorder};}
.s-pending{background:${T.electricBg};color:${T.electric};border:1px solid ${T.electricBorder};}

/* SUBMIT */
.sub-header{padding:20px 18px 10px;}
.sub-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:800;color:${T.text};letter-spacing:-0.4px;}
.sub-sub{font-size:11px;color:${T.textSoft};margin-top:4px;text-transform:uppercase;letter-spacing:.8px;}
.util-selector{display:grid;grid-template-columns:repeat(4,1fr);margin:0 14px 14px;border:1px solid ${T.border};border-radius:4px;overflow:hidden;}
.utab{display:flex;flex-direction:column;align-items:center;gap:3px;background:${T.card};border-right:1px solid ${T.border};padding:10px 4px;cursor:pointer;transition:background .12s,color .12s;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;border-radius:0;}
.utab:last-child{border-right:none;}
.utab:hover,.utab.active{background:var(--ubg);color:var(--uc);}
.utab-icon{font-size:18px;}

/* VERIFY */
.verify-zone{margin:0 14px 12px;border-radius:4px;overflow:hidden;border:1px solid ${T.border};background:${T.card};transition:border-color .15s;cursor:pointer;}
.verify-zone:hover{border-color:${T.green3};}
.verify-zone.captured,.verify-zone.verifying,.verify-zone.verified{border-color:${T.green3};}
.verify-zone.verified{background:${T.green5};}
.verify-zone.error{border-color:${T.gas};background:${T.gasBg};}
.vz-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:26px;text-align:center;}
.vz-icon{font-size:26px;margin-bottom:2px;}
.vz-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.text};}
.vz-sub{font-size:10px;color:${T.textSoft};}
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
.vz-error{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 16px;text-align:center;}

/* FORM */
.form-card{margin:0 14px 14px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:16px;box-shadow:0 2px 6px ${T.shadow};}
.irow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
.igroup{display:flex;flex-direction:column;gap:4px;}
.ilabel{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};display:flex;align-items:center;gap:6px;}
.utag{border-radius:1px;padding:1px 4px;font-size:7px;font-weight:700;background:var(--ubg);color:var(--uc);border:1px solid var(--uborder);text-transform:uppercase;letter-spacing:.6px;}
.ifield{width:100%;background:${T.bg};border:1px solid ${T.border};border-radius:3px;padding:9px 10px;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:15px;outline:none;transition:border-color .15s;}
.ifield:focus{border-color:var(--uc,${T.green3});}
.ifield::placeholder{color:${T.textSoft};opacity:.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;}
.ifield-full{width:100%;margin-bottom:10px;}
.usage-pill{display:flex;align-items:center;justify-content:space-between;background:${T.bgAlt};border:1px solid ${T.border};border-radius:3px;padding:8px 11px;margin-bottom:9px;}
.up-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};}
.up-val{font-size:15px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.reward-preview{background:${T.bgAlt};border:1px solid ${T.border};border-left:3px solid ${T.green3};border-radius:3px;padding:12px 13px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.rp-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};}
.rp-rate{font-size:10px;color:${T.textSoft};margin-top:3px;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.rp-val{font-size:28px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;letter-spacing:-0.5px;}
.rp-b3tr{font-size:9px;color:${T.textSoft};text-transform:uppercase;letter-spacing:1.4px;}
.sbtn{width:100%;background:linear-gradient(135deg,${T.green1},${T.green2});border:none;border-radius:4px;padding:14px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 12px rgba(26,51,38,0.2);}
.sbtn:hover:not(:disabled){box-shadow:0 6px 20px rgba(26,51,38,0.3);transform:translateY(-1px);}
.sbtn:disabled{opacity:.4;cursor:not-allowed;}

/* CHARTS */
.chart-screen{padding:0 0 8px;}
.chart-page-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:22px;font-weight:800;color:${T.text};padding:20px 18px 4px;letter-spacing:-0.4px;}
.chart-page-sub{font-size:11px;color:${T.textSoft};padding:0 18px 14px;text-transform:uppercase;letter-spacing:.8px;}
.chart-card{margin:0 14px 10px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:16px;box-shadow:0 2px 6px ${T.shadow};}
.chart-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;}
.chart-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.9px;color:${T.text};}
.chart-avg{font-size:10px;color:${T.textSoft};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.chart-bars{display:flex;align-items:flex-end;gap:5px;height:68px;}
.chart-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;}
.chart-bar{width:100%;border-radius:1px 1px 0 0;min-height:3px;transition:all .3s;cursor:pointer;}
.chart-bar:hover{filter:brightness(1.2);}
.chart-val{font-size:8px;font-family:'SF Mono',Menlo,'Courier New',monospace;color:${T.textSoft};text-align:center;}
.chart-lbl{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:${T.textSoft};text-align:center;}
.chart-stat-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;margin-top:13px;padding-top:11px;border-top:1px solid ${T.border};}
.cstat{text-align:center;padding:0 6px;border-right:1px solid ${T.border};}
.cstat:last-child{border-right:none;}
.cstat-val{font-size:15px;font-weight:500;font-family:'SF Mono',Menlo,'Courier New',monospace;color:${T.text};}
.cstat-key{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};margin-top:2px;}

/* LEADERBOARD */
.lb-hero{margin:14px 14px 0;border-radius:4px;border:1px solid ${T.border};border-left:3px solid #7c3aed;background:${T.card};padding:20px;}
.lb-hero::after{display:none;}
.lb-hero-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:2.2px;color:${T.textSoft};margin-bottom:10px;}
.lb-hero-rank{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:52px;font-weight:500;color:${T.text};line-height:1;letter-spacing:-2px;}
.lb-hero-sub{font-size:11px;color:${T.textSoft};margin-top:5px;}
.lb-hero-chips{display:flex;gap:0;margin-top:16px;padding-top:14px;border-top:1px solid ${T.border};}
.lb-chip{flex:1;padding-right:14px;margin-right:14px;border-right:1px solid ${T.border};}
.lb-chip:last-child{border-right:none;margin-right:0;padding-right:0;}
.lb-chip-v{font-size:16px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.lb-chip-k{font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};margin-top:3px;}
.lb-item{margin:0 14px 6px;background:${T.card};border:1px solid ${T.border};border-radius:5px;padding:12px 14px;display:flex;align-items:center;gap:11px;transition:all .2s;box-shadow:0 1px 3px ${T.shadow};}
.lb-item:hover{border-color:${T.green3};box-shadow:0 4px 12px ${T.shadowMd};}
.lb-item.me{border-left:3px solid ${T.green3};}
.lb-rank{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:15px;font-weight:500;color:${T.textSoft};width:22px;text-align:center;flex-shrink:0;}
.lb-rank.top{color:${T.text};font-weight:700;}
.lb-av{width:30px;height:30px;border-radius:3px;background:${T.bgAlt};display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;font-family:'SF Mono',Menlo,'Courier New',monospace;font-weight:600;color:${T.textMid};border:1px solid ${T.border};}
.lb-av.me{background:${T.green1};color:#fff;border-color:${T.green1};}
.lb-info{flex:1;min-width:0;}
.lb-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${T.text};display:flex;align-items:center;gap:6px;}
.lb-me-tag{font-size:7px;font-weight:700;background:${T.green1};color:#fff;border-radius:1px;padding:1px 4px;letter-spacing:.8px;}
.lb-addr{font-size:9px;color:${T.textSoft};font-family:'SF Mono',Menlo,'Courier New',monospace;margin-top:2px;}
.lb-right{text-align:right;}
.lb-b3tr{font-size:13px;font-weight:500;color:${T.green1};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.lb-streak{font-size:9px;color:${T.textSoft};margin-top:2px;font-family:'SF Mono',Menlo,'Courier New',monospace;}
.lb-filter{display:flex;gap:0;padding:12px 14px;border-bottom:1px solid ${T.border};margin-bottom:5px;}
.lb-ftab{flex-shrink:0;padding:5px 12px 5px 0;margin-right:14px;border-radius:0;font-size:9px;font-weight:700;cursor:pointer;border:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;transition:color .15s;text-transform:uppercase;letter-spacing:1px;background:none;border-bottom:2px solid transparent;color:${T.textSoft};}
.lb-ftab.active{color:${T.green1};border-bottom-color:${T.green3};}

/* PROFILE */
.profile-hero{margin:14px;border:1px solid ${T.border};border-left:3px solid ${T.green3};border-radius:4px;background:${T.card};padding:20px;}
.pav{width:46px;height:46px;border-radius:4px;margin-bottom:10px;background:${T.bgAlt};display:flex;align-items:center;justify-content:center;font-size:22px;border:1px solid ${T.border};}
.pname{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:${T.text};letter-spacing:-0.4px;}
.paddr{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:10px;color:${T.textSoft};margin-top:3px;}
.pbadge{display:inline-flex;align-items:center;gap:5px;background:${T.bgAlt};border:1px solid ${T.border};border-radius:2px;padding:3px 7px;font-size:8px;font-weight:700;color:${T.textMid};margin-top:10px;text-transform:uppercase;letter-spacing:.8px;}
.pstat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:0 14px 14px;}
.pstat{background:${T.card};border:1px solid ${T.border};border-radius:4px;padding:13px;text-align:center;}
.pstat-val{font-size:22px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;letter-spacing:-0.5px;}
.pstat-key{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};margin-top:3px;}
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
.sr-val{font-size:10px;color:${T.textSoft};font-family:'SF Mono',Menlo,'Courier New',monospace;}
.sr-arrow{color:${T.textSoft};font-size:11px;}

.online-pill{display:flex;align-items:center;gap:5px;padding:4px 8px;border-radius:3px;border:1px solid ${T.border};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:${T.textSoft};}
.online-pill.on{color:${T.green3};border-color:${T.green4};}
.online-pill.off{color:${T.textSoft};}
.online-dot{width:5px;height:5px;border-radius:50%;background:${T.green3};flex-shrink:0;}
.online-pill.off .online-dot{background:${T.textSoft};}
/* NAV */
.bnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:420px;background:${T.navBg};border-top:1px solid ${T.border};display:grid;grid-template-columns:repeat(5,1fr);padding:10px 0 24px;z-index:20;backdrop-filter:blur(20px);}
.nitem{display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;border:none;background:none;color:${T.textSoft};transition:all .18s;padding:6px 2px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;position:relative;}
.nitem.active{color:${T.green2};}
.nitem.active::before{content:'';position:absolute;top:-2px;left:50%;transform:translateX(-50%);width:20px;height:2px;background:${T.green3};border-radius:1px;}
.nicon{font-size:17px;width:30px;height:26px;display:flex;align-items:center;justify-content:center;color:inherit;}
.nlabel{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;}

/* TOAST */
.toast{position:fixed;top:72px;left:50%;transform:translateX(-50%);background:${T.text};border-radius:3px;padding:8px 14px;font-size:11px;font-weight:700;letter-spacing:.3px;color:${T.bg};z-index:200;white-space:nowrap;animation:toastin .18s ease;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
@keyframes toastin{from{opacity:0;transform:translateX(-50%) translateY(-5px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* MODAL */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:100;display:flex;align-items:flex-end;justify-content:center;}
.modal{background:${T.card};border-radius:8px 8px 0 0;padding:24px 18px 36px;width:100%;max-width:420px;border-top:1px solid ${T.border};animation:slideup .22s ease;box-shadow:0 -4px 16px ${T.shadowMd};}
@keyframes slideup{from{transform:translateY(22px);opacity:0}to{transform:translateY(0);opacity:1}}
.modal-handle{width:28px;height:2px;background:${T.border};border-radius:1px;margin:0 auto 20px;}
.modal-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:800;color:${T.text};margin-bottom:4px;letter-spacing:-0.3px;}
.modal-sub{font-size:11px;color:${T.textSoft};margin-bottom:18px;}
.modal-opt{display:flex;align-items:center;gap:11px;background:${T.bg};border:1px solid ${T.border};border-radius:4px;padding:12px 13px;cursor:pointer;margin-bottom:7px;transition:border-color .15s;}
.modal-opt:hover{border-color:${T.green3};}
.modal-opt-icon{width:32px;height:32px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:16px;background:${T.bgAlt};border:1px solid ${T.border};}
.modal-opt-name{font-size:13px;font-weight:700;color:${T.text};}
.modal-opt-sub{font-size:10px;color:${T.textSoft};margin-top:1px;}
.modal-cancel{width:100%;border:none;background:none;padding:12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}

/* ONBOARDING */
.onboard{position:fixed;inset:0;background:${T.bg};z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 28px 44px;}
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

/* MISC */
.spin-sm{width:13px;height:13px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:inline-block;}
.page-title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:24px;font-weight:800;color:${T.text};padding:22px 18px 6px;letter-spacing:-0.6px;}
.page-sub{font-size:11px;color:${T.textSoft};padding:0 18px 16px;text-transform:uppercase;letter-spacing:1px;}
.filter-row{display:flex;gap:5px;padding:0 14px 13px;overflow-x:auto;}
.fchip{flex-shrink:0;padding:4px 11px;border-radius:2px;font-size:9px;font-weight:700;cursor:pointer;border:1px solid ${T.border};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;transition:all .12s;text-transform:uppercase;letter-spacing:.8px;background:${T.card};color:${T.textSoft};}
.fchip.active{background:${T.green1};color:#fff;border-color:${T.green1};}
/* DIFF PANEL */
.diff-panel{display:flex;align-items:center;justify-content:space-between;background:${T.bgAlt};border-radius:3px;padding:10px 12px;margin-bottom:8px;border:1px solid ${T.border};}
.diff-left{}
.diff-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:${T.textSoft};}
.diff-val{font-size:22px;font-weight:500;color:${T.text};font-family:'SF Mono',Menlo,'Courier New',monospace;margin-top:2px;letter-spacing:-0.5px;}
.diff-val span{font-size:11px;font-weight:400;color:${T.textSoft};margin-left:3px;letter-spacing:0;}
.diff-badge{font-size:10px;font-weight:700;border-radius:2px;padding:4px 7px;display:flex;flex-direction:column;align-items:flex-end;gap:1px;}
.diff-badge.better{background:${T.green5};color:${T.green2};border:1px solid ${T.green4};}
.diff-badge.worse{background:${T.gasBg};color:${T.gas};border:1px solid ${T.gasBorder};}
.diff-badge.neutral{background:${T.bgAlt};color:${T.textMid};border:1px solid ${T.border};}
.diff-pct{font-size:8px;font-weight:600;opacity:.75;}
/* CO2 ROW */
.co2-row{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:500;color:${T.textSoft};background:${T.bgAlt};border-radius:3px;padding:7px 11px;margin-bottom:9px;border:1px solid ${T.border};}
.co2-avg{font-family:'SF Mono',Menlo,'Courier New',monospace;font-size:10px;}
/* SECURITY */
.sec-badges{display:flex;gap:4px;margin-top:10px;flex-wrap:wrap;justify-content:center;}
.sec-badge{font-size:8px;font-weight:700;background:transparent;color:${T.green3};border:1px solid ${T.green3};border-radius:1px;padding:2px 6px;letter-spacing:1px;text-transform:uppercase;}
.sec-score-bar{display:flex;align-items:center;gap:8px;margin-top:8px;padding:7px 10px;background:${T.bgAlt};border-radius:3px;border:1px solid ${T.border};}
.ssb-label{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${T.textSoft};white-space:nowrap;}
.ssb-track{flex:1;height:3px;background:${T.border};border-radius:2px;overflow:hidden;}
.ssb-fill{height:100%;border-radius:2px;transition:width .5s ease;}
.ssb-val{font-size:10px;font-weight:700;font-family:'SF Mono',Menlo,'Courier New',monospace;white-space:nowrap;}
.vz-error{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 16px;text-align:center;}
`;
}

// ─── AI STEPS ────────────────────────────────────────────────────────────────
const AI_STEPS = [
  "Checking duplicate photo hash…",
  "Analyzing file metadata & age…",
  "Detecting screenshots & edits…",
  "Reading meter digits (OCR)…",
  "Checking plausibility & anomalies…",
];

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

const TOTAL_SLIDES = ONBOARD_SLIDES.length + 1; // +1 for meter registration

function Onboarding({ onDone }) {
  const [slide, setSlide] = useState(0);
  const [baselines, setBaselines] = useState({ electric:"", gas:"", water:"", solar:"" });
  const isSetup = slide === ONBOARD_SLIDES.length; // last slide = meter setup
  const isInfoSlide = slide < ONBOARD_SLIDES.length;
  const s = isInfoSlide ? ONBOARD_SLIDES[slide] : null;

  const handleDone = () => {
    // Fill blanks with defaults so app works immediately
    const filled = {
      electric: baselines.electric || "3834.8",
      gas:      baselines.gas      || "521.4",
      water:    baselines.water    || "12320",
      solar:    baselines.solar    || "130.1",
    };
    onDone(filled);
  };

  const allSlides = TOTAL_SLIDES;

  return (
    <div className="onboard">
      {isInfoSlide ? (
        <>
          <div className="ob-icon" key={slide}>{s.icon}</div>
          <div className="ob-title" style={{ color: s.color }}>{s.title}</div>
          <div className="ob-sub">{s.sub}</div>
        </>
      ) : (
        <>
          <div className="ob-icon" key="setup">
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="40" height="40"><rect x="5" y="4" width="22" height="24" rx="2"/><path d="M10 10h12M10 14h12M10 18h8"/></svg>
          </div>
          <div className="ob-title" style={{ color:"#1a3326" }}>Register Your Meters</div>
          <div className="ob-sub" style={{marginBottom:20}}>Enter your current meter readings so we can calculate your daily usage from day one.</div>
          <div style={{width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:8}}>
            {UTILS.map(u => (
              <div key={u.id} style={{display:"flex",alignItems:"center",gap:12,background:"rgba(26,51,38,0.06)",borderRadius:4,padding:"10px 14px",border:"1px solid rgba(26,51,38,0.12)"}}>
                <span style={{width:22,height:22,display:"flex",alignItems:"center",justifyContent:"center",color:"#264d3a",flexShrink:0}}>{UTIL_ICONS[u.id]}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:"#7a9188",marginBottom:4}}>{u.label} <span style={{fontWeight:400}}>({u.unit})</span></div>
                  <input
                    type="number"
                    placeholder={`e.g. ${u.ph[0]}`}
                    value={baselines[u.id]}
                    onChange={e => setBaselines(b => ({...b,[u.id]:e.target.value}))}
                    style={{width:"100%",background:"rgba(26,51,38,0.04)",border:"1px solid rgba(26,51,38,0.15)",borderRadius:3,padding:"7px 10px",fontSize:14,fontFamily:"'DM Mono',monospace",color:"#0d1812",outline:"none"}}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:"#7a9188",marginTop:10,textAlign:"center"}}>You can skip and update these later in Settings.</div>
        </>
      )}
      <div className="ob-dots" style={{marginTop:isSetup?16:40}}>
        {Array.from({length:allSlides}).map((_,i) => <div key={i} className={`ob-dot ${i===slide?"active":""}`} />)}
      </div>
      <button className="ob-btn" onClick={() => isSetup ? handleDone() : setSlide(s => s+1)}>
        {isSetup ? "Start Tracking" : "Continue →"}
      </button>
      {!isSetup && <button className="ob-skip" onClick={handleDone}>Skip setup</button>}
    </div>
  );
}

function WalletModal({ onConnect, onClose }) {
  const [connecting, setConnecting] = useState(null);
  const connect = async (name) => {
    setConnecting(name);
    await new Promise(r => setTimeout(r, 1800));
    onConnect("0x3f8a…a9c2");
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-handle"/>
        <div className="modal-title">Connect Wallet</div>
        <div className="modal-sub">Link your VeChain wallet to earn B3TR for every utility reading</div>
        {[
          {id:"veworld", name:"VeWorld",       sub:"Official VeChain super app",  svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="18" height="18"><circle cx="12" cy="12" r="9"/><path d="M12 3a13 13 0 010 18M12 3a13 13 0 000 18M3 12h18"/></svg>},
          {id:"sync2",   name:"Sync2",         sub:"VeChain desktop & mobile",    svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="18" height="18"><path d="M20 11A8 8 0 104 13"/><path d="M20 4v7h-7"/></svg>},
          {id:"wc",      name:"WalletConnect", sub:"Connect via QR code",         svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="18" height="18"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>},
        ].map(w => (
          <div key={w.id} className="modal-opt" onClick={() => connect(w.name)}>
            <div className="modal-opt-icon">{connecting===w.name ? <div className="ai-ring" style={{width:28,height:28,borderWidth:2}}/> : w.svg}</div>
            <div>
              <div className="modal-opt-name">{w.name}</div>
              <div className="modal-opt-sub">{connecting===w.name ? "Connecting…" : w.sub}</div>
            </div>
          </div>
        ))}
        <button className="modal-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function VerifyZone({ utilId, onVerified, onReset, reading, subs }) {
  const [phase, setPhase]   = useState("idle");
  const [aiStep, setAiStep] = useState(0);
  const [result, setResult] = useState(null);
  const [secScore, setSecScore] = useState(null);
  const fileRef = useRef();

  // Check cooldown on mount / utilId change
  const cooldownMs = getCooldownRemaining(utilId);

  const runVerify = async (file) => {
    setPhase("verifying"); setAiStep(0);
    const mime   = file.type;
    const base64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(file); });
    const fraudFlags = [];
    let   fraudReason = null;

    // Step 1 — Duplicate hash check
    setAiStep(0);
    const imgHash = await hashImage(base64);
    const hashOk  = !usedHashes.has(imgHash);
    if (!hashOk) { fraudFlags.push("duplicate_photo"); fraudReason = "Duplicate photo detected. Each submission needs a fresh photo."; }

    // Step 2 — File metadata check (age, type, size)
    setAiStep(1);
    const fileMeta = checkFileMeta(file);
    if (!fileMeta.ok) fraudFlags.push(...fileMeta.flags);

    // Step 3 — Canvas screenshot detection
    setAiStep(2);
    const ssCheck = await detectScreenshot(base64, mime);
    if (ssCheck.isScreenshot) { fraudFlags.push("screenshot_detected"); fraudReason = fraudReason || "Screenshot detected. Please take a real photo of your physical meter."; }

    // Step 4 — Tesseract OCR: read digits & compare with entered reading
    setAiStep(3);
    const ocrResult = await runOCR(file, reading);
    if (!ocrResult.matched && !ocrResult.ocrFailed) {
      fraudFlags.push("ocr_mismatch");
      fraudReason = fraudReason || ocrResult.reason;
    }

    // Step 5 — Plausibility & anomaly
    const usageVal   = reading && parseFloat(reading) > 0 ? parseFloat(reading) : null;
    const plausCheck = usageVal ? checkPlausibility(utilId, usageVal) : { ok:true };
    const anomCheck  = usageVal ? checkAnomaly(utilId, usageVal, subs) : { ok:true, anomaly:false };
    if (!plausCheck.ok) { fraudFlags.push("implausible_reading"); fraudReason = fraudReason || plausCheck.reason; }
    if (anomCheck.anomaly) { fraudFlags.push("anomaly"); fraudReason = fraudReason || anomCheck.reason; }

    setAiStep(4);

    // Security score
    const score = computeSecurityScore({
      ocrMatched:    ocrResult.matched,
      ocrConfidence: ocrResult.ocrConfidence || 0,
      plausible:     plausCheck.ok,
      anomaly:       anomCheck.anomaly,
      hashOk,
      fileOk:        fileMeta.ok,
      screenshotOk:  !ssCheck.isScreenshot,
    });
    setSecScore(score);

    // Register hash
    if (hashOk) usedHashes.add(imgHash);

    const verified = fraudFlags.length === 0 && score >= 40;
    const summary  = verified
      ? `${getUtil(utilId).label} meter verified. ${ocrResult.ocrNums?.length ? "OCR read: " + ocrResult.ocrNums.slice(0,2).join(", ") + "." : "Reading accepted."}`
      : (fraudReason || "Verification failed. Please retake the photo.");

    const finalResult = { verified, fraudFlags, fraudReason, summary, ocrNums: ocrResult.ocrNums, secScore: score };
    setResult(finalResult);
    setPhase(verified ? "verified" : "error");
    if (verified) onVerified(finalResult);
  };

  const handleFile = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    await runVerify(file);
  };

  const reset = () => { setPhase("idle"); setResult(null); setSecScore(null); onReset(); };

  // Cooldown block
  if (cooldownMs > 0) return (
    <div className="verify-zone" style={{cursor:"default"}}>
      <div className="vz-idle">
        <div className="vz-icon">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="28" height="28"><circle cx="16" cy="16" r="12"/><path d="M16 10v6l4 2"/></svg>
        </div>
        <div className="vz-title">Cooldown active</div>
        <div className="vz-sub">Next {getUtil(utilId).label} submission in <strong>{fmtCooldown(cooldownMs)}</strong></div>
        <div style={{marginTop:10,fontSize:10,color:"#85a882",textAlign:"center",maxWidth:240}}>One submission per meter per 20 hours prevents farming.</div>
      </div>
    </div>
  );

  if (phase === "idle") return (
    <div className="verify-zone" onClick={() => fileRef.current?.click()}>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handleFile} />
      <div className="vz-idle">
        <div className="vz-icon">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="28" height="28"><rect x="3" y="8" width="26" height="19" rx="2"/><path d="M10 8V6a2 2 0 012-2h8a2 2 0 012 2v2"/><circle cx="16" cy="17.5" r="4.5"/><circle cx="16" cy="17.5" r="1.5"/></svg>
        </div>
        <div className="vz-title">Photograph your {getUtil(utilId).label.toLowerCase()} meter</div>
        <div className="vz-sub">AI fraud detection · duplicate check · anomaly analysis</div>
        <div className="sec-badges">
          <span className="sec-badge">Anti-farm</span>
          <span className="sec-badge">AI verify</span>
          <span className="sec-badge">On-chain</span>
        </div>
      </div>
    </div>
  );

  if (phase === "verifying") return (
    <div className="verify-zone verifying">
      <div className="vz-verifying">
        <div className="ai-ring"/>
        <div style={{fontSize:13,fontWeight:700}}>Security Verification…</div>
        <div className="ai-steps">
          {AI_STEPS.map((s,i) => (
            <div key={i} className={`ai-step ${i<aiStep?"done":i===aiStep?"active":""}`}>
              <span className="ai-step-icon">{i<aiStep?"✓":i===aiStep?"·":"○"}</span>{s}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (phase === "verified" && result) return (
    <div className="verify-zone verified">
      <div className="vz-result">
        <div className="vr-header">
          <div className="vr-badge"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="10" height="10"><path d="M2 7l3 3 7-6"/></svg> Verified</div>
          <div className="vr-confidence">{result.secScore ?? 0}/100</div>
        </div>
        <div className="vr-summary">{result.summary}</div>
        {secScore !== null && (
          <div className="sec-score-bar">
            <div className="ssb-label">Security score</div>
            <div className="ssb-track"><div className="ssb-fill" style={{width:`${secScore}%`,background:secScore>79?"#2e7d52":secScore>49?"#e67e00":"#c0392b"}}/></div>
            <div className="ssb-val" style={{color:secScore>79?"#2e7d52":secScore>49?"#e67e00":"#c0392b"}}>{secScore}/100</div>
          </div>
        )}
        <div className="vr-retry" onClick={reset}>Retake photo</div>
      </div>
    </div>
  );

  return (
    <div className="verify-zone error" onClick={reset}>
      <div className="vz-error">
        <div style={{fontSize:28}}>🚫</div>
        <div style={{fontSize:13,fontWeight:700,color:"#c0392b"}}>Submission blocked</div>
        <div style={{fontSize:12,color:"#666",marginTop:4,textAlign:"center",padding:"0 16px"}}>{result?.fraudReason || "Verification failed. Please try again with a real photo."}</div>
        {result?.fraudFlags?.length > 0 && (
          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:8,justifyContent:"center"}}>
            {result.fraudFlags.map(f => <span key={f} style={{fontSize:9,fontWeight:700,background:"#fee2e2",color:"#c0392b",borderRadius:20,padding:"2px 8px"}}>{f.replace(/_/g," ")}</span>)}
          </div>
        )}
        <div style={{fontSize:10,color:"#999",marginTop:8}}>Tap to try again with a valid photo</div>
      </div>
    </div>
  );
}

function StreakCalendar({ subs }) {
  const subDays = new Set(subs.map(s => parseInt(s.date?.split("-")[2] || "0")));
  const today = 5;
  const offset = 4; // May 1 2026 = Friday
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push({ empty: true });
  for (let d = 1; d <= 31; d++) cells.push({ day: d, has: subDays.has(d), today: d === today });
  return (
    <div className="calendar">
      <div className="cal-hdr">
        <div className="cal-month">May 2026</div>
        <div className="cal-streak">{subs.length}-day streak</div>
      </div>
      <div className="cal-days-hdr">
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d=><div key={d} className="cal-day-name">{d}</div>)}
      </div>
      <div className="cal-grid">
        {cells.map((c,i) => c.empty
          ? <div key={i} className="cal-cell empty"/>
          : <div key={i} className={`cal-cell${c.has?" has-sub":""}${c.today?" today":""}`}>{c.day}</div>
        )}
      </div>
      <div className="cal-legend">
        <div className="cal-leg-item"><div className="cal-leg-dot" style={{background:"#1b5e38"}}/> Submitted</div>
        <div className="cal-leg-item"><div className="cal-leg-dot" style={{background:"transparent",border:"2px solid #4caf76",borderRadius:3}}/> Today</div>
        <div className="cal-leg-item"><div className="cal-leg-dot" style={{background:"#d4e8da"}}/> No data</div>
      </div>
    </div>
  );
}

function HistItem({ s, T }) {
  const u = getUtil(s.type);
  const delta = (parseFloat(s.cur) - parseFloat(s.prev)).toFixed(2);
  return (
    <div className="hitem">
      <div className="hicon" style={{background:T[u.id+"Bg"]||T.green5,border:`1px solid ${T[u.id+"Border"]||T.green4}`,color:T[u.id]||T.green2}}>{UTIL_ICONS[u.id]}</div>
      <div className="hinfo">
        <div className="htitle">{u.label} Meter</div>
        <div className="hdate">{s.date}</div>
        <div className="hdelta">Usage: {delta} {u.unit}</div>
      </div>
      <div className="hright">
        <div className="hb3tr">+{parseFloat(s.b3tr).toFixed(2)} B3TR</div>
        <span className={`hstatus s-${s.status}`}>{s.status}</span>
      </div>
    </div>
  );
}

function UsageChart({ utilId, T }) {
  const u = getUtil(utilId);
  const data = CHART_DATA[utilId];
  const max = Math.max(...data);
  const avg = (data.reduce((a,v)=>a+v,0)/data.length).toFixed(1);
  const total = data.reduce((a,v)=>a+v,0).toFixed(1);
  const color = T[utilId] || T.electric;
  const colorBg = T[utilId+"Bg"] || T.electricBg;
  return (
    <div className="chart-card">
      <div className="chart-hdr">
        <div className="chart-title" style={{display:"flex",alignItems:"center",gap:7,color}}><span style={{opacity:.8}}>{UTIL_ICONS[utilId]}</span>{u.label}</div>
        <div className="chart-avg">avg {avg} {u.unit}/day</div>
      </div>
      <div className="chart-bars">
        {data.map((v, i) => (
          <div key={i} className="chart-bar-wrap">
            <div className="chart-val" style={{color}}>{v}</div>
            <div className="chart-bar" style={{height:`${(v/max)*68}px`,background:`linear-gradient(to top,${color},${color}88)`}} />
            <div className="chart-lbl">{CHART_LABELS[i]}</div>
          </div>
        ))}
      </div>
      <div className="chart-stat-row">
        <div className="cstat"><div className="cstat-val" style={{color}}>{total}</div><div className="cstat-key">Total {u.unit}</div></div>
        <div className="cstat"><div className="cstat-val" style={{color}}>{avg}</div><div className="cstat-key">Daily avg</div></div>
        <div className="cstat"><div className="cstat-val" style={{color}}>+{(parseFloat(total)*u.rate).toFixed(1)}</div><div className="cstat-key">B3TR earned</div></div>
      </div>
    </div>
  );
}

function Toggle({ on, onToggle }) {
  return (
    <button className={`toggle ${on?"on":""}`} onClick={onToggle}>
      <div className="toggle-dot"/>
    </button>
  );
}

// ─── SCREENS ─────────────────────────────────────────────────────────────────

function HomeScreen({ b3tr, streak, subs, setTab, testnet, T }) {
  return (
    <>
      {testnet && <div style={{background:T.gasBg,border:`1px solid ${T.gasBorder}`,color:T.gas,padding:"8px 14px",borderRadius:3,fontSize:10,fontWeight:700,textAlign:"center",margin:"0 14px 10px",fontFamily:"'DM Mono',monospace",letterSpacing:".4px",textTransform:"uppercase"}}>Testnet — Test B3TR only. Switch to MainNet in Settings.</div>}
      <div className="hero">
        <div className="hero-label">Total B3TR Earned</div>
        <div className="hero-amount">{b3tr.toFixed(2)}<span>B3TR</span></div>
        <div className="hero-usd">≈ ${(b3tr * 0.014).toFixed(2)} USD · Powered by VeChain {testnet?"(TestNet)":"(MainNet)"}</div>
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
              <div className="ucard-icon" style={{background:T[u.id+"Bg"]||T.green5,border:`1px solid ${T[u.id+"Border"]||T.green4}`,color:T[u.id]||T.green2}}>{UTIL_ICONS[u.id]}</div>
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

function SubmitScreen({ u, selUtil, setSelUtil, aiOk, setAiOk, reading, setReading, prevRead, setPrevRead, busy, usage, reward, handleSubmit, verifyKey, wallet, setShowWallet, subs, T }) {
  const canSubmit = aiOk && reading && prevRead && usage() > 0 && !busy;

  // Compute 7-day average for this utility type
  const avgUsage = (() => {
    const recent = subs.filter(s => s.type === selUtil).slice(0, 7);
    if (!recent.length) return null;
    const avg = recent.reduce((a, s) => a + (parseFloat(s.cur) - parseFloat(s.prev)), 0) / recent.length;
    return parseFloat(avg.toFixed(2));
  })();

  const todayUsage = usage();
  const diffVsAvg = avgUsage && todayUsage > 0 ? parseFloat((todayUsage - avgUsage).toFixed(2)) : null;
  const diffPct = avgUsage && diffVsAvg !== null ? Math.round((diffVsAvg / avgUsage) * 100) : null;
  const isBetter = diffVsAvg !== null && diffVsAvg < 0;

  // CO₂ conversion factors kg per unit
  const co2 = { electric:0.233, gas:2.04, water:0.001, solar:-0.233 };
  const co2Saved = todayUsage > 0 ? parseFloat((todayUsage * (co2[selUtil] || 0)).toFixed(3)) : 0;

  return (
    <>
      <div className="sub-header">
        <div className="sub-title">Daily Submission</div>
        <div className="sub-sub">Log your meter reading · Earn B3TR on VeChain</div>
      </div>
      <div className="util-selector">
        {UTILS.map(ut => (
          <button key={ut.id} className={`utab ${selUtil===ut.id?"active":""}`}
            style={{"--uc":T[ut.id]||T.electric,"--ubg":T[ut.id+"Bg"]||T.electricBg,"--uborder":T[ut.id+"Border"]||T.electricBorder}}
            onClick={() => setSelUtil(ut.id)}>
            <span className="utab-icon">{UTIL_ICONS[ut.id]}</span>{ut.label}
          </button>
        ))}
      </div>
      <VerifyZone key={verifyKey} utilId={selUtil} reading={reading} subs={subs} onVerified={() => setAiOk(true)} onReset={() => setAiOk(false)} />
      <div className="form-card" style={{"--uc":T[u.id]||T.electric,"--ubg":T[u.id+"Bg"]||T.electricBg,"--uborder":T[u.id+"Border"]||T.electricBorder}}>
        <div className="irow">
          <div className="igroup">
            <div className="ilabel">Previous <span className="utag">{u.unit}</span></div>
            <input className="ifield" type="number" placeholder={u.ph[0]} value={prevRead} onChange={e=>setPrevRead(e.target.value)}/>
          </div>
          <div className="igroup">
            <div className="ilabel">Current <span className="utag">{u.unit}</span></div>
            <input className="ifield" type="number" placeholder={u.ph[1]} value={reading} onChange={e=>setReading(e.target.value)}/>
          </div>
        </div>

        {todayUsage > 0 && (
          <>
            {/* Usage + diff vs average */}
            <div className="diff-panel">
              <div className="diff-left">
                <div className="diff-label">Today's usage</div>
                <div className="diff-val">{todayUsage} <span>{u.unit}</span></div>
              </div>
              {diffVsAvg !== null ? (
                <div className={`diff-badge ${isBetter?"better":"worse"}`}>
                  {isBetter ? "▼" : "▲"} {Math.abs(diffVsAvg)} {u.unit} vs avg
                  <span className="diff-pct">({isBetter?"-":"+"}{ Math.abs(diffPct)}%)</span>
                </div>
              ) : (
                <div className="diff-badge neutral">First reading</div>
              )}
            </div>

            {/* CO₂ insight */}
            <div className="co2-row">
              <span>🌍</span>
              <span>{selUtil === "solar"
                ? `Generates ${co2Saved} kg CO₂ offset today`
                : `${co2Saved} kg CO₂ emitted today`}
              </span>
              {avgUsage && <span className="co2-avg"> · 7-day avg: {avgUsage} {u.unit}</span>}
            </div>
          </>
        )}

        {todayUsage > 0 && (
          <div className="reward-preview">
            <div>
              <div className="rp-label">Estimated Reward</div>
              <div className="rp-rate">{todayUsage} {u.unit} × {u.rate} B3TR/{u.unit}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div className="rp-val">+{reward()}</div>
              <div className="rp-b3tr">B3TR</div>
            </div>
          </div>
        )}
        {!wallet
          ? <button className="sbtn" onClick={() => setShowWallet(true)}>Connect Wallet to Submit</button>
          : <button className="sbtn" disabled={!canSubmit} onClick={handleSubmit}>
              {busy ? <><span className="spin-sm"/> Submitting on VeChain…</> : <>Submit & Earn B3TR</>}
            </button>
        }
      </div>
    </>
  );
}

function ChartsScreen({ T }) {
  const [active, setActive] = useState("electric");
  return (
    <div className="chart-screen">
      <div className="page-title">Usage Charts</div>
      <div className="page-sub">Your last 7 days of consumption per utility</div>
      <div className="filter-row">
        {UTILS.map(u => (
          <button key={u.id} className={`fchip ${active===u.id?"active":""}`} onClick={() => setActive(u.id)}
            style={active===u.id ? {"--fc":T[u.id]||T.electric} : {}}>
            {u.label}
          </button>
        ))}
      </div>
      <UsageChart utilId={active} T={T} />
      {/* All 4 mini cards below */}
      <div className="sec"><div className="sec-line"/><div className="sec-txt">All Meters</div><div className="sec-line"/></div>
      {UTILS.filter(u=>u.id!==active).map(u => <UsageChart key={u.id} utilId={u.id} T={T} />)}
    </div>
  );
}

function LeaderboardScreen({ b3tr, streak, T }) {
  const [filter, setFilter] = useState("b3tr");
  const sorted = [...LEADERBOARD_DATA].sort((a,b) => filter==="b3tr" ? b.b3tr-a.b3tr : b.streak-a.streak);
  const me = sorted.find(x=>x.isMe);
  return (
    <>
      <div className="lb-hero">
        <div className="lb-hero-label">Your Ranking</div>
        <div className="lb-hero-rank">#{me?.rank || 4}</div>
        <div className="lb-hero-sub">Top 6% globally · {sorted.length} active members</div>
        <div className="lb-hero-chips">
          <div className="lb-chip"><div className="lb-chip-v">{b3tr.toFixed(1)}</div><div className="lb-chip-k">B3TR Earned</div></div>
          <div className="lb-chip"><div className="lb-chip-v">{streak}</div><div className="lb-chip-k">Day Streak</div></div>
          <div className="lb-chip"><div className="lb-chip-v">Moon</div><div className="lb-chip-k">Tier</div></div>
        </div>
      </div>
      <div className="lb-filter">
        {[{id:"b3tr",l:"B3TR Earned"},{id:"streak",l:"Streak"}].map(f => (
          <button key={f.id} className={`lb-ftab ${filter===f.id?"active":""}`} onClick={()=>setFilter(f.id)}>{f.l}</button>
        ))}
      </div>
      {sorted.map((item, i) => (
        <div key={item.addr} className={`lb-item ${item.isMe?"me":""}`}>
          <div className={`lb-rank ${i<3?"top":""}`}>{item.badge || item.rank}</div>
          <div className={`lb-av ${item.isMe?"me":""}`}>{item.isMe ? "Me" : item.name.slice(0,2)}</div>
          <div className="lb-info">
            <div className="lb-name">
              {item.name}
              {item.isMe && <span className="lb-me-tag">You</span>}
            </div>
            <div className="lb-addr">{item.addr}</div>
          </div>
          <div className="lb-right">
            <div className="lb-b3tr">{item.b3tr.toFixed(1)}</div>
            <div className="lb-streak">{item.streak}d streak</div>
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

function ProfileScreen({ b3tr, streak, subs, wallet, setShowWallet, dark, setDark, notifs, setNotifs, setOnboarded, testnet, setTestnet, T }) {
  return (
    <>
      <div className="profile-hero">
        <div className="pav">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="22" height="22"><circle cx="16" cy="12" r="5"/><path d="M6 28c0-5.5 4.5-10 10-10s10 4.5 10 10"/></svg>
        </div>
        <div className="pname">EcoMeter_42</div>
        <div className="paddr">{wallet || "No wallet connected"}</div>
        <div className="pbadge">Galaxy Member · Moon Tier · +5% B3TR</div>
      </div>
      <div className="pstat-row">
        {[{v:b3tr.toFixed(2),k:"B3TR Earned"},{v:streak,k:"Day Streak"},{v:subs.length,k:"Submissions"}].map(x=>(
          <div key={x.k} className="pstat"><div className="pstat-val">{x.v}</div><div className="pstat-key">{x.k}</div></div>
        ))}
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Streak</div><div className="sec-line"/></div>
      <StreakCalendar subs={subs} />

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Notifications</div><div className="sec-line"/></div>
      <div className="notif-card">
        <div className="notif-hdr">Daily Reminders</div>
        {[
          {id:"daily",   label:"Daily submission",  sub:"08:00 AM reminder to log your meters"},
          {id:"streak",  label:"Streak alert",      sub:"Get warned before losing your streak"},
          {id:"rewards", label:"Reward updates",    sub:"B3TR payouts and VeChain confirmations"},
          {id:"lb",      label:"Leaderboard moves", sub:"When someone passes or you climb ranks"},
        ].map(n => (
          <div key={n.id} className="notif-row">
            <div><div className="notif-label">{n.label}</div><div className="notif-sub">{n.sub}</div></div>
            <Toggle on={notifs[n.id]} onToggle={()=>{setNotifs(prev=>({...prev,[n.id]:!prev[n.id]}));if(!notifs[n.id]&&n.id==="daily"){requestNotificationPermission();scheduleDailyReminder(8,0);}}}/>
          </div>
        ))}
      </div>

      <div className="sec"><div className="sec-line"/><div className="sec-txt">Settings</div><div className="sec-line"/></div>
      <div className="setting-row" onClick={()=>setDark(d=>!d)}>
        <div className="sr-left">
          <div className="sr-icon">
            {dark
              ? <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="13" height="13"><path d="M17 11.5A7 7 0 119.5 3a5 5 0 007.5 8.5z"/></svg>
              : <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="13" height="13"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>
            }
          </div>
          <div><div className="sr-label">Dark Mode</div><div className="sr-sub">{dark?"On — dark sustainable theme":"Off — bright clean theme"}</div></div>
        </div>
        <div className="sr-right"><Toggle on={dark} onToggle={()=>setDark(d=>!d)}/></div>
      </div>
      <div className="setting-row" onClick={()=>setTestnet(t=>!t)}>
        <div className="sr-left">
          <div className="sr-icon">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="13" height="13"><path d="M6 3h8M7 3v4l-3 5v2h12v-2l-3-5V3"/><path d="M8 14v3h4v-3"/></svg>
          </div>
          <div><div className="sr-label">VeChain Network</div><div className="sr-sub">{testnet?"TestNet — Safe testing":"MainNet — Real rewards"}</div></div>
        </div>
        <div className="sr-right"><Toggle on={testnet} onToggle={()=>setTestnet(t=>!t)}/></div>
      </div>
      {[
        {icon:<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="13" height="13"><circle cx="10" cy="10" r="7"/><path d="M6 10h8M10 6l4 4-4 4"/></svg>, label:"Wallet", sub:wallet||"Not connected", action:!wallet?"Connect":""},
        {icon:UTIL_ICONS.electric, label:"Electric meter", sub:"Reward rate: 0.61 B3TR/kWh"},
        {icon:UTIL_ICONS.gas,      label:"Gas meter",      sub:"Reward rate: 0.84 B3TR/m³"},
        {icon:UTIL_ICONS.water,    label:"Water meter",    sub:"Reward rate: 0.12 B3TR/L"},
        {icon:UTIL_ICONS.solar,    label:"Solar meter",    sub:"Reward rate: 0.72 B3TR/kWh"},
        {icon:<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="13" height="13"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 3"/></svg>, label:"View Onboarding", sub:"Replay the intro & meter setup", action:"onboard"},
        {icon:<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" width="13" height="13"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 7v.5"/></svg>, label:"App version", sub:"Green Utility Log v4.0 · VeBetterDAO"},
      ].map((s,i) => (
        <div key={i} className="setting-row" onClick={s.label==="Wallet"&&!wallet?()=>setShowWallet(true):s.action==="onboard"?()=>setOnboarded(false):undefined}>
          <div className="sr-left">
            <div className="sr-icon">{s.icon}</div>
            <div><div className="sr-label">{s.label}</div><div className="sr-sub">{s.sub}</div></div>
          </div>
          <div className="sr-right">
            {s.action && s.action !== "onboard" && <span style={{fontSize:11,fontWeight:700,color:T.green2}}>{s.action}</span>}
            <span className="sr-arrow">›</span>
          </div>
        </div>
      ))}
    </>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────

// ─── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────
async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "denied") {
    const perm = await Notification.requestPermission();
    return perm === "granted";
  }
  return false;
}

async function scheduleDailyReminder(hour = 8, minute = 0) {
  const hasPermission = await requestNotificationPermission();
  if (!hasPermission || !("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const now = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      await reg.showNotification("Don't forget to log your meter!", {
        body: "Open Green Utility Log to submit today's readings and earn B3TR",
        icon: "/icons/icon-192.png",
        tag: "greenlog-reminder",
        actions: [{ action: "submit", title: "Log Now" }],
      });
      scheduleDailyReminder(hour, minute);
    } catch (e) { console.log("Notification failed:", e); }
  }, delay);
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      console.log("✅ Service Worker registered");
      return reg;
    } catch (e) { console.warn("SW registration failed:", e); }
  }
}

export default function App() {
  const [onboarded, setOnboarded]   = useState(true);
  const [testnet, setTestnet]       = useState(true); // set to false for new users
  const [baselines, setBaselines]   = useState({ electric:"3834.8", gas:"521.4", water:"12320", solar:"130.1" });
  const [dark, setDark]             = useState(false);
  const T = dark ? DARK : LIGHT;

  const [tab, setTab]               = useState("home");
  const [wallet, setWallet]         = useState(null);
  const [showWallet, setShowWallet] = useState(false);
  const [selUtil, setSelUtil]       = useState("electric");
  const [aiOk, setAiOk]            = useState(false);
  const [reading, setReading]       = useState("");
  const [prevRead, setPrevRead]     = useState("");
  const [busy, setBusy]             = useState(false);
  const [toast, setToast]           = useState(null);
  const [b3tr, setB3tr]             = useState(68.34);
  const [streak, setStreak]         = useState(14);
  const [subs, setSubs]             = useState(HISTORY_SEED);
  const [verifyKey, setVerifyKey]   = useState(0);
  const [notifs, setNotifs]         = useState({ daily:true, streak:true, rewards:false, lb:false });

  const online = useOnlineStatus();
  useEffect(() => { registerServiceWorker().then(() => { if (notifs.daily) scheduleDailyReminder(8, 0); }); }, []);
  const u = getUtil(selUtil);
  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(null), 3000); };

  // Auto-fill prevRead from baselines when switching utility
  const handleSelUtil = (id) => {
    setSelUtil(id);
    setAiOk(false);
    setReading("");
    // Pre-fill previous reading from last submission or baseline
    const lastSub = subs.find(s => s.type === id);
    setPrevRead(lastSub ? lastSub.cur : (baselines[id] || ""));
    setVerifyKey(k => k+1);
  };

  const usage = () => { const r=parseFloat(reading),p=parseFloat(prevRead); return(!r||!p||r<=p)?0:parseFloat((r-p).toFixed(2)); };
  const reward = () => parseFloat((usage()*u.rate).toFixed(2));

  const handleSubmit = async () => {
    if (!aiOk||!reading||!prevRead||usage()<=0) return;
    const plaus = checkPlausibility(selUtil, usage());
    if (!plaus.ok) { showToast(plaus.reason); return; }
    const anom  = checkAnomaly(selUtil, usage(), subs);
    if (!anom.ok) { showToast(anom.reason); return; }
    if (getCooldownRemaining(selUtil) > 0) { showToast("Cooldown active — come back later."); return; }
    setBusy(true);
    const earned = reward();
    
    if (!online) {
      await saveOfflineSubmission({ type:selUtil, cur:reading, prev:prevRead, b3tr:earned, testnet });
      setAiOk(false); setReading(""); setPrevRead(""); setVerifyKey(k=>k+1);
      setBusy(false);
      showToast("Saved offline — will sync when online.");
      return;
    }
    await new Promise(r=>setTimeout(r,2000));
    setSubs(p=>[{id:Date.now(),type:selUtil,cur:reading,prev:prevRead,date:"2026-05-05",b3tr:earned,status:"processing"},...p]);
    setB3tr(p=>parseFloat((p+earned).toFixed(2)));
    setStreak(p=>p+1);
    setBaselines(b => ({...b,[selUtil]:reading}));
    setCooldown(selUtil);
    setAiOk(false); setReading(""); setPrevRead(""); setVerifyKey(k=>k+1);
    setBusy(false);
    showToast(`+${earned.toFixed(2)} B3TR earned`);
    setTab("history");
  };

  const CSS = makeCSS(T);

  return (
    <>
      <style>{CSS}</style>
      {!onboarded && <Onboarding onDone={(bl) => { setBaselines(bl); setOnboarded(true); setPrevRead(bl.electric||""); }} />}
      {toast && <div className="toast">{toast}</div>}
      {showWallet && <WalletModal onConnect={addr=>{setWallet(addr);setShowWallet(false);showToast("VeWorld connected");}} onClose={()=>setShowWallet(false)}/>}

      <div className="app">
        <div className="z1 scr">
          <div className="hdr">
            <div className="logo">
              <div className="logo-mark">
                <svg viewBox="0 0 28 28" fill="none" width="14" height="14"><path d="M14 4C9 4 5 8 5 13c0 3.6 2 6.7 5 8.3V24h8v-2.7c3-1.6 5-4.7 5-8.3 0-5-4-9-9-9z" fill="currentColor" opacity=".9"/><path d="M11 13c0-1.7 1.3-3 3-3s3 1.3 3 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" opacity=".7"/></svg>
              </div>
              <div>
                <div className="logo-name">Green Utility Log</div>
                <div className="logo-tag">VeBetterDAO · VeChain</div>
              </div>
            </div>
            <div className="hdr-actions">
              <div className="dark-toggle" onClick={()=>setDark(d=>!d)}>
                {dark
                  ? <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="14" height="14"><circle cx="10" cy="10" r="4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"/></svg>
                  : <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" width="14" height="14"><path d="M17 11.5A7 7 0 119.5 3a5 5 0 007.5 8.5z" fill="currentColor" opacity=".15"/><path d="M17 11.5A7 7 0 119.5 3a5 5 0 007.5 8.5z"/></svg>
                }
              </div>
              <div className={`online-pill ${online?"on":"off"}`}>
                <span className="online-dot"/>
                {online ? "Online" : "Offline"}
              </div>
              <div className={`wallet-pill ${wallet?"connected":""}`} onClick={()=>!wallet&&setShowWallet(true)}>
                <span className={`wdot ${wallet?"":"off"}`}/>
                {wallet ? <span className="waddr">{wallet}</span> : <span className="wconnect">Connect</span>}
              </div>
            </div>
          </div>

          {tab==="home"      && <HomeScreen b3tr={b3tr} streak={streak} subs={subs} setTab={setTab} testnet={testnet} T={T}/>}
          {tab==="submit"    && <SubmitScreen u={u} selUtil={selUtil} setSelUtil={handleSelUtil} aiOk={aiOk} setAiOk={setAiOk} reading={reading} setReading={setReading} prevRead={prevRead} setPrevRead={setPrevRead} busy={busy} usage={usage} reward={reward} handleSubmit={handleSubmit} verifyKey={verifyKey} wallet={wallet} setShowWallet={setShowWallet} subs={subs} T={T}/>}
          {tab==="charts"    && <ChartsScreen T={T}/>}
          {tab==="leaderboard" && <LeaderboardScreen b3tr={b3tr} streak={streak} T={T}/>}
          {tab==="history"   && <HistoryScreen subs={subs} T={T}/>}
          {tab==="profile"   && <ProfileScreen b3tr={b3tr} streak={streak} subs={subs} wallet={wallet} setShowWallet={setShowWallet} dark={dark} setDark={setDark} notifs={notifs} setNotifs={setNotifs} setOnboarded={setOnboarded} testnet={testnet} setTestnet={setTestnet} T={T}/>}
        </div>

        <nav className="bnav">
          {[
            {id:"home", l:"Home", svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>},
            {id:"submit", l:"Submit", svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M7 6V4a1 1 0 011-1h8a1 1 0 011 1v2"/><circle cx="12" cy="13" r="3"/></svg>},
            {id:"charts", l:"Charts", svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M3 20h18"/><rect x="5" y="12" width="3" height="8" rx="1"/><rect x="10.5" y="7" width="3" height="13" rx="1"/><rect x="16" y="3" width="3" height="17" rx="1"/></svg>},
            {id:"leaderboard", l:"Ranks", svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><path d="M8 21H4a1 1 0 01-1-1v-4a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1z"/><path d="M14 21h-4V11a1 1 0 011-1h2a1 1 0 011 1v10z"/><path d="M20 21h-4V7a1 1 0 011-1h2a1 1 0 011 1v14z"/></svg>},
            {id:"profile", l:"Profile", svg:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="20" height="20"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>},
          ].map(n => (
            <button key={n.id} className={`nitem ${tab===n.id?"active":""}`} onClick={()=>setTab(n.id)}>
              <div className="nicon">{n.svg}</div>
              <span className="nlabel">{n.l}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}
