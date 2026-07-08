// ── Green Utility Log — reward-distributor API ───────────────────────────────
// POST /reward  : verify a submission and issue the B3TR reward on-chain.
// GET  /health  : service + distributor status.

import "dotenv/config";
import express from "express";
import cors from "cors";
import { PORT, ALLOWED_ORIGIN, ALLOWED_ORIGINS, NETWORK, NODE_URL, APP_ID, OCR_ENABLED, isBanned, ECO_REWARD, ECO_MAX_PER_WEEK, ECO_WINDOW_MS, ECO_APPLIANCES } from "./config.js";
import { validateSubmission } from "./verify.js";
import { verifyPhoto } from "./media.js";
import { store } from "./store.js";
import { distributeReward, distributeEcoReward, distributorAddress, chainDiagnostics } from "./reward.js";
import { ocrImage, ocrEnabled, ocrProviders } from "./ocr.js";
import { verifyWalletCertificate, REQUIRE_CERT } from "./auth.js";
import { checkPhotoAuthenticity, aiPhotoCheckEnabled } from "./authenticity.js";
import { verifyCaptcha, captchaEnabled } from "./captcha.js";

const app = express();
// Limit allows for a meter photo (base64) in the body.
app.use(express.json({ limit: "20mb" }));
// Lock the API to the configured frontend origin(s). "*" stays fully open.
app.use(cors({
  origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
}));

// Very small in-memory IP throttle — a coarse abuse guard on top of the
// per-wallet cooldown. Replace with a real rate limiter (e.g. express-rate-limit
// backed by Redis) in production.
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  req.clientIp = ip;
  const now = Date.now();
  const win = hits.get(ip)?.filter((t) => now - t < 60_000) || [];
  if (win.length >= 30) return res.status(429).json({ error: "too many requests" });
  win.push(now);
  hits.set(ip, win);
  next();
});

app.get("/health", async (req, res) => {
  // On-chain self-diagnosis: poolB3TR is the app's available reward funds;
  // distributorAuthorized says whether our wallet holds the reward-distributor
  // role. false on either one explains a reverting distributeReward instantly.
  const chain = await chainDiagnostics().catch(() => ({ poolB3TR: null, distributorAuthorized: null }));
  res.json({
    ok: true,
    network: NETWORK,
    node: NODE_URL,
    appId: APP_ID,
    ocr: OCR_ENABLED,
    ocrProviders: ocrProviders(),
    requireCert: REQUIRE_CERT,
    aiPhotoCheck: aiPhotoCheckEnabled(),
    captcha: captchaEnabled(),
    corsLocked: !ALLOWED_ORIGINS.includes("*"),
    durableState: store.isDurable(),
    distributor: await distributorAddress().catch(() => null),
    poolB3TR: chain.poolB3TR,
    distributorAuthorized: chain.distributorAuthorized,
  });
});

// Meter-photo OCR. The app POSTs an image (base64) — the cropped reading or the
// full photo — and gets back the detected text + numbers from the first configured
// provider that recognises it (Roboflow → custom → Vision). Keys/URLs stay on the
// server. Returns 503 when no provider is configured, so the app falls back to
// in-browser OCR.
app.post("/ocr", async (req, res) => {
  if (!ocrEnabled()) return res.status(503).json({ ok: false, error: "ocr not configured" });
  const image = req.body?.image;
  if (!image || typeof image !== "string") return res.status(400).json({ ok: false, error: "image is required" });
  const { text, numbers, provider } = await ocrImage(image);
  res.json({ ok: true, text, numbers, provider });
});

// Wallet+utility pairs with a payout in flight — prevents two concurrent
// requests from both passing the cooldown and double-paying.
const inFlight = new Set();

app.post("/reward", async (req, res) => {
  // 0) Ban list — blocked wallets can never claim.
  if (isBanned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });

  // 0b) Captcha — proves the request came from a real browser, not a bot/script.
  if (captchaEnabled()) {
    const cap = await verifyCaptcha(req.body.captchaToken, req.clientIp);
    if (!cap.ok) return res.status(403).json({ error: cap.error });
  }

  // 1) Structural checks + server-recomputed amount.
  const v = validateSubmission(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  // 1b) Wallet ownership proof — the signer of the certificate must be the address
  // we're about to reward. Stops rewards being issued to an arbitrary address.
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address: req.body.address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }

  const lockKey = `${String(req.body.address).toLowerCase()}:${req.body.utility}`;
  if (inFlight.has(lockKey)) return res.status(429).json({ error: "a submission for this meter is already processing" });

  // 2) Photo check — real image, not a reused one (and optional OCR match).
  const photo = await verifyPhoto({ imageBase64: req.body.photo, reading: req.body.reading, ocr: OCR_ENABLED, mime: req.body.photoMime });
  if (!photo.ok) return res.status(400).json({ error: photo.error });

  // 2b) AI authenticity — reject doctored / screenshotted / watermarked / hand-drawn
  // photos before issuing a reward. No-op (allows) when ANTHROPIC_API_KEY is unset.
  if (aiPhotoCheckEnabled()) {
    const auth = await checkPhotoAuthenticity(req.body.photo);
    if (!auth.ok) return res.status(400).json({ error: `photo rejected: ${auth.reason}` });
  }

  // 3) Pay out, then commit cooldown + burn the photo hash (only on success).
  inFlight.add(lockKey);
  try {
    const txid = await distributeReward({
      utility:  req.body.utility,
      meterNo:  req.body.meterNo,
      reading:  req.body.reading,
      prevRead: v.prev,    // server baseline, not the client-sent prevRead
      usage:    v.usage,   // server-validated usage
      amount:   v.amount,
      receiver: req.body.address,
    });
    v.markPaid();
    photo.markUsed();
    res.json({ txid, amount: v.amount });
  } catch (e) {
    console.error("[/reward]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  } finally {
    inFlight.delete(lockKey);
  }
});

// ── Eco-mode bonus ────────────────────────────────────────────────────────────
// POST /eco-action: photograph an appliance (washer/dryer/dishwasher) running in
// eco mode → fixed ECO_REWARD. No meter reading to anchor, so the guards are:
// photo-hash dedupe (one photo ever earns once), the optional AI authenticity
// check, the wallet certificate, and a hard cap of ECO_MAX_PER_WEEK claims per
// rolling 7 days per wallet.
app.post("/eco-action", async (req, res) => {
  if (isBanned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });

  if (captchaEnabled()) {
    const cap = await verifyCaptcha(req.body.captchaToken, req.clientIp);
    if (!cap.ok) return res.status(403).json({ error: cap.error });
  }

  const addr = String(req.body.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "invalid wallet address" });
  const appliance = String(req.body.appliance || "").toLowerCase();
  if (!ECO_APPLIANCES.has(appliance)) return res.status(400).json({ error: "unknown appliance" });

  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address: req.body.address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }

  // Weekly cap: at most ECO_MAX_PER_WEEK paid eco photos per rolling 7 days.
  const claims = store.ecoClaims(addr, ECO_WINDOW_MS);
  if (claims.length >= ECO_MAX_PER_WEEK) {
    return res.status(429).json({ error: `eco-bonus limit reached (${ECO_MAX_PER_WEEK} per week) — try again later` });
  }

  const lockKey = `${addr}:eco`;
  if (inFlight.has(lockKey)) return res.status(429).json({ error: "an eco submission is already processing" });

  // Real image + never paid for before. No OCR — there's no reading to match.
  const photo = await verifyPhoto({ imageBase64: req.body.photo, ocr: false, mime: req.body.photoMime });
  if (!photo.ok) return res.status(400).json({ error: photo.error });

  if (aiPhotoCheckEnabled()) {
    const auth = await checkPhotoAuthenticity(req.body.photo);
    if (!auth.ok) return res.status(400).json({ error: `photo rejected: ${auth.reason}` });
  }

  inFlight.add(lockKey);
  try {
    const txid = await distributeEcoReward({ appliance, amount: ECO_REWARD, receiver: req.body.address });
    store.addEcoClaim(addr, Date.now());
    photo.markUsed();
    res.json({ txid, amount: ECO_REWARD, remaining: ECO_MAX_PER_WEEK - claims.length - 1 });
  } catch (e) {
    console.error("[/eco-action]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  } finally {
    inFlight.delete(lockKey);
  }
});

app.listen(PORT, () => {
  console.log(`Reward distributor listening on :${PORT} (${NETWORK})`);
});
