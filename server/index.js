// ── Green Utility Log — reward-distributor API ───────────────────────────────
// POST /reward  : verify a submission and issue the B3TR reward on-chain.
// GET  /health  : service + distributor status.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import express from "express";
import cors from "cors";
import { PORT, ALLOWED_ORIGIN, ALLOWED_ORIGINS, NETWORK, NODE_URL, APP_ID, OCR_ENABLED, isBanned, ECO_REWARD, ECO_MAX_PER_WEEK, ECO_COOLDOWN_MS, ECO_APPLIANCES, ecoWeekKey } from "./config.js";
import { validateSubmission } from "./verify.js";
import { verifyPhoto } from "./media.js";
import { store } from "./store.js";
import { distributeReward, distributeEcoReward, distributorAddress, chainDiagnostics, moveToRewardsPool } from "./reward.js";
import { ocrImage, ocrEnabled, ocrProviders } from "./ocr.js";
import { verifyWalletCertificate, REQUIRE_CERT } from "./auth.js";
import { checkPhotoAuthenticity, aiPhotoCheckEnabled } from "./authenticity.js";
import { verifyCaptcha, captchaEnabled } from "./captcha.js";
import { enodeEnabled, enodeInfo, createMeterLink, fetchLatestReading } from "./enode.js";

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
    rewardsPoolEnabled: chain.rewardsPoolEnabled,
    rewardsPoolB3TR: chain.rewardsPoolB3TR,
    appAdmin: chain.appAdmin,
    // Gas sponsorship (VIP-191): when set, the distributor needs no VTHO of its own.
    delegation: !!(process.env.DELEGATION_URL || "").trim(),
    // Smart-meter sources: the free push path is always on; enode only when configured.
    meterIngest: true,
    enode: enodeInfo(),
  });
});

// ── Admin: move funds into the distributable rewards-pool bucket ─────────────
// The contract only lets the on-chain APP ADMIN call increaseRewardsPoolBalance.
// When the DISTRIBUTOR wallet holds that role, this endpoint performs the move
// server-side for a verified admin user (the app calls it automatically when the
// user's own wallet lacks the role). Guarded by the wallet certificate plus an
// allowlist of admin user wallets (ADMIN_WALLETS env, comma-separated).
const ADMIN_USER_WALLETS = (process.env.ADMIN_WALLETS || "0x3a007383fce8dcccdb92cf9efe0e609a652a1f29")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

app.post("/admin/move-rewards-pool", async (req, res) => {
  const addr = String(req.body.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr) || !ADMIN_USER_WALLETS.includes(addr)) {
    return res.status(403).json({ error: "not an admin wallet" });
  }
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address: req.body.address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }
  const amount = Number(req.body.amount);
  if (!(amount > 0 && amount <= 1_000_000)) return res.status(400).json({ error: "invalid amount" });
  try {
    const txid = await moveToRewardsPool(amount);
    res.json({ txid, amount });
  } catch (e) {
    console.error("[/admin/move-rewards-pool]", e?.message || e);
    res.status(502).json({ error: e?.message || "move failed" });
  }
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
// check, the wallet certificate, a hard cap of ECO_MAX_PER_WEEK claims per
// calendar week (Mon–Sun) and a 24h cooldown between claims.
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

  // Two limits: max ECO_MAX_PER_WEEK per CALENDAR week (Mon–Sun, resets Monday
  // morning) and at least ECO_COOLDOWN_MS (24h) between two claims.
  const claims = store.ecoClaims(addr);
  const thisWeek = claims.filter((t) => ecoWeekKey(t) === ecoWeekKey());
  if (thisWeek.length >= ECO_MAX_PER_WEEK) {
    return res.status(429).json({ error: `eco-bonus limit reached (${ECO_MAX_PER_WEEK} per week) — resets Monday` });
  }
  const last = claims.reduce((a, t) => Math.max(a, t), 0);
  const wait = ECO_COOLDOWN_MS - (Date.now() - last);
  if (last && wait > 0) {
    return res.status(429).json({ error: `eco cooldown active — next claim in ~${Math.ceil(wait / 3600000)}h` });
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
    res.json({ txid, amount: ECO_REWARD, remaining: ECO_MAX_PER_WEEK - thisWeek.length - 1 });
  } catch (e) {
    console.error("[/eco-action]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  } finally {
    inFlight.delete(lockKey);
  }
});

// ── Smart-meter ingestion (beta) ─────────────────────────────────────────────
// Goal: an automatic, worldwide meter reading so users don't depend on a good
// photo. Two sources, one store (store.linkReadings, keyed by wallet):
//   1) FREE PUSH — a P1/HAN reader or Home Assistant POSTs the live total to
//      /meter-ingest with a device token this wallet paired. No file uploads, no
//      OCR; the reading is machine-read at the meter. Works anywhere such a reader
//      exists (NL/BE P1, Nordics HAN, or any script that can read the meter).
//   2) ENODE (optional) — global aggregator; see enode.js. Env-gated.
// Either way the value is surfaced to the app, which submits it through the SAME
// /reward validation (monotonic vs last reading, bounds, cooldown, reward cap).

const publicBase = (req) =>
  (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "") ||
  `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;

// Pair a device to this wallet. Cert-authed (proves wallet ownership) → returns a
// secret device token + the exact URL a reader should POST readings to. Re-pairing
// the same wallet reuses its token so it can't accumulate orphans.
app.post("/meter/pair", (req, res) => {
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }
  const meterNo = String(req.body.meterNo || "").trim();
  const existing = store.getLinkByAddress(address);
  const token = existing?.token || randomBytes(24).toString("hex");
  store.setMeterLink(token, { address: address.toLowerCase(), meterNo, createdAt: Date.now() });
  res.json({
    token,
    ingestUrl: `${publicBase(req)}/meter-ingest`,
    // A ready-to-paste example a reader / Home Assistant automation can POST.
    example: {
      method: "POST",
      url: `${publicBase(req)}/meter-ingest`,
      headers: { "Content-Type": "application/json" },
      body: { token, reading: 12345.6 },
    },
  });
});

// The endpoint a reader posts to. Token-authed (the token IS the secret binding to
// a wallet) — deliberately no wallet cert, since an unattended device can't sign.
app.post("/meter-ingest", (req, res) => {
  const token = String(req.body.token || "");
  const link = store.getMeterLink(token);
  if (!link) return res.status(401).json({ error: "unknown device token" });
  const reading = Number(req.body.reading);
  if (!Number.isFinite(reading) || reading < 0) return res.status(400).json({ error: "invalid reading" });
  store.setLinkReading(link.address, {
    reading,
    meterNo: String(req.body.meterNo || link.meterNo || "").trim() || null,
    at: Date.now(),
    source: "push",
  });
  res.json({ ok: true });
});

// The app polls this to show / prefill the latest automatically-received reading.
app.get("/meter/latest", (req, res) => {
  const address = String(req.query.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  const r = store.getLinkReading(address);
  const link = store.getLinkByAddress(address);
  res.json({ paired: !!link, reading: r || null });
});

// ── Enode source (optional) ──────────────────────────────────────────────────
// Create a Link session; the app opens the returned linkUrl so the user authorises
// their meter with Enode. Cert-authed so a link is only ever created for the
// wallet that owns it.
app.post("/meter/enode/link", async (req, res) => {
  if (!enodeEnabled()) return res.status(503).json({ error: "enode not configured" });
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }
  try {
    const session = await createMeterLink(address);
    res.json({ linkUrl: session?.linkUrl || session?.url || null, session });
  } catch (e) {
    console.error("[/meter/enode/link]", e?.message || e);
    res.status(502).json({ error: e?.message || "enode link failed" });
  }
});

// Pull the latest reading from Enode into linkReadings. Returns `raw` so the exact
// meter schema can be locked down against a live account (then tighten pickReading).
app.post("/meter/enode/sync", async (req, res) => {
  if (!enodeEnabled()) return res.status(503).json({ error: "enode not configured" });
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }
  try {
    const latest = await fetchLatestReading(address);
    if (!latest) return res.json({ linked: false });
    if (Number.isFinite(latest.reading)) {
      store.setLinkReading(address, {
        reading: latest.reading,
        meterNo: latest.meterId || null,
        at: Date.now(),
        source: "enode",
      });
    }
    res.json({ linked: true, reading: latest.reading, unit: latest.unit, field: latest.field, raw: latest.raw });
  } catch (e) {
    console.error("[/meter/enode/sync]", e?.message || e);
    res.status(502).json({ error: e?.message || "enode sync failed" });
  }
});

// ── Photoless payout from an ingested reading (Step 2, beta) ─────────────────
// Pay out from an automatically-received meter reading — no photo. The trust
// anchor shifts from photo-authenticity to (a) the device-token→wallet binding
// that produced the reading and (b) an already-established meter baseline: the
// meter must first be registered + baselined by a normal photo submission (which
// binds meterNo→wallet and records the last reading). After that, pushes/syncs
// can pay automatically. Reuses validateSubmission, so the same cooldown,
// monotonicity, plausibility bounds and per-payout cap all still apply.
const METER_MAX_AGE_MS = Number(process.env.METER_MAX_AGE_MS || 48 * 60 * 60 * 1000);

app.post("/reward-from-meter", async (req, res) => {
  if (isBanned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  if (captchaEnabled()) {
    const cap = await verifyCaptcha(req.body.captchaToken, req.clientIp);
    if (!cap.ok) return res.status(403).json({ error: cap.error });
  }
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }

  const utility = String(req.body.utility || "electric");
  const meterNo = String(req.body.meterNo || "").trim();
  if (!meterNo) return res.status(400).json({ error: "register your meter number first" });

  // A fresh automatic reading must exist for this wallet.
  const latest = store.getLinkReading(address);
  if (!latest || !Number.isFinite(Number(latest.reading))) {
    return res.status(400).json({ error: "no automatic reading yet — pair a device or connect a source first" });
  }
  if (Date.now() - (latest.at || 0) > METER_MAX_AGE_MS) {
    return res.status(400).json({ error: "the automatic reading is stale — refresh your reader/source, then try again" });
  }

  // Require an established baseline: the auto path never sets the FIRST reading,
  // so a device can't invent a meter or its starting value out of thin air.
  if (store.lastReading(meterNo.trim().toLowerCase()) == null) {
    return res.status(400).json({ error: "submit one photo reading first to set this meter's baseline — then automatic readings pay out" });
  }

  // Server recomputes everything from its own recorded baseline (client prev is
  // ignored inside validateSubmission when a baseline exists).
  const v = validateSubmission({ utility, reading: Number(latest.reading), meterNo, address });
  if (!v.ok) return res.status(400).json({ error: v.error });

  const lockKey = `${address.toLowerCase()}:${utility}`;
  if (inFlight.has(lockKey)) return res.status(429).json({ error: "a submission for this meter is already processing" });
  inFlight.add(lockKey);
  try {
    const txid = await distributeReward({
      utility, meterNo,
      reading:  Number(latest.reading),
      prevRead: v.prev,
      usage:    v.usage,
      amount:   v.amount,
      receiver: address,
    });
    v.markPaid();
    res.json({ txid, amount: v.amount, usage: v.usage, reading: Number(latest.reading), source: latest.source || "meter" });
  } catch (e) {
    console.error("[/reward-from-meter]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  } finally {
    inFlight.delete(lockKey);
  }
});

app.listen(PORT, () => {
  console.log(`Reward distributor listening on :${PORT} (${NETWORK})`);
});
