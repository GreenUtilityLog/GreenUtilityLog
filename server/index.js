// ── Green Utility Log — reward-distributor API ───────────────────────────────
// POST /reward  : verify a submission and issue the B3TR reward on-chain.
// GET  /health  : service + distributor status.

import "dotenv/config";
import { randomBytes } from "node:crypto";
import express from "express";
import cors from "cors";
import { PORT, ALLOWED_ORIGIN, ALLOWED_ORIGINS, NETWORK, NODE_URL, APP_ID, OCR_ENABLED, isBanned, ECO_REWARD, ECO_MAX_PER_WEEK, ECO_COOLDOWN_MS, ECO_APPLIANCES, ecoWeekKey, RATES } from "./config.js";
import { validateSubmission } from "./verify.js";
import { verifyPhoto } from "./media.js";
import { store } from "./store.js";
import { putPhoto, getPhotoDataUrl, deletePhoto, photoStoreEnabled } from "./photostore.js";
import { distributeReward, distributeEcoReward, distributorAddress, chainDiagnostics, moveToRewardsPool } from "./reward.js";
import { ocrImage, ocrEnabled, ocrProviders } from "./ocr.js";
import { verifyWalletCertificate, REQUIRE_CERT } from "./auth.js";
import { checkPhotoAuthenticity, aiPhotoCheckEnabled } from "./authenticity.js";
import { verifyCaptcha, captchaEnabled } from "./captcha.js";
import { enodeEnabled, enodeInfo, createMeterLink, fetchLatestReading } from "./enode.js";

const app = express();
// Trust exactly the platform's proxy hop(s) so req.ip is the REAL client IP and not
// a client-injected X-Forwarded-For (which would let anyone forge the throttle key).
// Render/most PaaS = 1 hop; override with TRUST_PROXY_HOPS if you add a CDN in front.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

// Lock the API to the configured frontend origin(s). "*" stays fully open.
app.use(cors({
  origin: ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS,
}));

// Coarse in-memory IP throttle — runs BEFORE body parsing so an oversized payload
// from a flooding client is rejected before it's buffered. Keyed on the trusted
// req.ip. (Replace with a Redis-backed limiter before horizontal scaling.)
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  req.clientIp = ip;
  const now = Date.now();
  const win = hits.get(ip)?.filter((t) => now - t < 60_000) || [];
  if (win.length >= 30) return res.status(429).json({ error: "too many requests" });
  win.push(now);
  hits.set(ip, win);
  next();
});
// Bound the throttle map so rotating IPs can't grow it without limit (memory DoS):
// every 5 min drop entries with no hits in the last minute.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, win] of hits) { const live = win.filter((t) => t > cutoff); if (live.length) hits.set(ip, live); else hits.delete(ip); }
}, 5 * 60_000).unref?.();

// Body parsing: a small default for every route, with the 20 MB photo allowance
// applied ONLY to the two image-carrying endpoints (and /ocr). This keeps every
// admin/meter/health route from buffering multi-MB bodies.
const photoJson = express.json({ limit: "20mb" });
app.use("/reward", photoJson);
app.use("/eco-action", photoJson);
app.use("/ocr", photoJson);
app.use(express.json({ limit: "64kb" }));

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
    photoArchive: photoStoreEnabled(),
    captcha: captchaEnabled(),
    corsLocked: !ALLOWED_ORIGINS.includes("*"),
    // Which wallets the backend authorises for /admin/* (already public in the client
    // bundle) — surfaced so admin access is easy to verify.
    adminWallets: ADMIN_USER_WALLETS,
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
    // Scheduled hands-off auto-submit (Step 3) — on when AUTO_SUBMIT_MS ≥ 60000.
    autoSubmit: Number(process.env.AUTO_SUBMIT_MS || 0) >= 60000,
  });
});

// ── Admin: move funds into the distributable rewards-pool bucket ─────────────
// The contract only lets the on-chain APP ADMIN call increaseRewardsPoolBalance.
// When the DISTRIBUTOR wallet holds that role, this endpoint performs the move
// server-side for a verified admin user (the app calls it automatically when the
// user's own wallet lacks the role). Guarded by the wallet certificate plus an
// allowlist of admin user wallets (ADMIN_WALLETS env, comma-separated).
// Admin wallets authorised for /admin/* actions. Kept in sync with the frontend's
// ADMIN_WALLETS list so every wallet that SEES the admin panel can also perform its
// actions. Override with the ADMIN_WALLETS env (comma-separated) in production.
const ADMIN_USER_WALLETS = (process.env.ADMIN_WALLETS || "0x3a007383fce8dcccdb92cf9efe0e609a652a1f29,0xedd7e5e1be4066cdc892a059f586b9d7e8e4b0c7")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

// A wallet is blocked if it's on the static env list OR the admin's dynamic list.
const banned = (addr) => isBanned(addr) || store.isBanned(addr);

// Canonical string an admin certificate must sign, binding it to the EXACT action
// and its parameters. Both the frontend and this server compute it identically from
// (path, body-minus-auth-fields), so a captured cert can't be replayed against a
// different endpoint or with swapped parameters.
function canonicalAdminAction(path, body) {
  const extra = { ...body };
  delete extra.address; delete extra.certificate;
  return `${path}|${JSON.stringify(extra, Object.keys(extra).sort())}`;
}

// Shared gate for every /admin/* action. Unlike /reward, admin ALWAYS requires a
// valid, fresh, action-bound, single-use certificate — never gated by REQUIRE_CERT
// (that dev flag must not be able to disable privileged auth).
function verifyAdmin(req, path) {
  const addr = String(req.body.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr) || !ADMIN_USER_WALLETS.includes(addr)) {
    return { ok: false, code: 403, error: "not an admin wallet" };
  }
  const cert = req.body.certificate;
  const c = verifyWalletCertificate({ certificate: cert, address: req.body.address });
  if (!c.ok) return { ok: false, code: 401, error: c.error };
  // The signed content must authorise THIS action+params...
  if (path && !String(cert?.payload?.content || "").includes(canonicalAdminAction(path, req.body))) {
    return { ok: false, code: 401, error: "certificate does not authorise this action" };
  }
  // ...and be single-use (defence against replay within the freshness window).
  if (!store.consumeCert(cert?.signature)) {
    return { ok: false, code: 401, error: "certificate already used — please sign again" };
  }
  return { ok: true, addr };
}
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
// Truncate a wallet address for logs — pseudonymous PII shouldn't sit in plaintext logs.
const shortAddr = (a) => { const s = String(a || ""); return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };

// Archive a submission photo for later admin review. Best-effort and non-blocking:
// uploads a downscaled thumbnail to R2 and records it in the retention index. Any
// failure is swallowed so it can never affect the payout. No-op unless R2 is set up.
function archivePhoto(txid, photoBase64, mime, addr) {
  if (!txid || !photoBase64 || !photoStoreEnabled()) return;
  Promise.resolve()
    .then(() => putPhoto(txid, photoBase64, mime))
    .then((ok) => { if (ok) store.addPhoto(txid, addr); })
    .catch((e) => console.error("[archivePhoto]", e?.message || e));
}

app.post("/admin/move-rewards-pool", async (req, res) => {
  const a = verifyAdmin(req, "/admin/move-rewards-pool");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const amount = Number(req.body.amount);
  if (!(amount > 0 && amount <= 1_000_000)) return res.status(400).json({ error: "invalid amount" });
  try {
    const txid = await moveToRewardsPool(amount);
    res.json({ txid, amount });
  } catch (e) {
    console.error("[/admin/move-rewards-pool]", e?.message || e);
    res.status(502).json({ error: "move failed" });
  }
});

// ── Admin: account management ────────────────────────────────────────────────
// Block/unblock a farming wallet. A blocked wallet can never claim (checked on
// every reward path). Durable across restarts.
app.post("/admin/ban", (req, res) => {
  const a = verifyAdmin(req, "/admin/ban");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const target = String(req.body.targetWallet || "");
  if (!isAddr(target)) return res.status(400).json({ error: "invalid target wallet" });
  const ban = req.body.ban !== false; // default true
  if (ADMIN_USER_WALLETS.includes(target.toLowerCase()) && ban) {
    return res.status(400).json({ error: "refusing to ban an admin wallet" });
  }
  store.setBan(target, ban);
  res.json({ ok: true, targetWallet: target.toLowerCase(), banned: ban, bans: store.listBans() });
});

// Inspect a meter/wallet's server-side state so the admin knows what to correct.
app.post("/admin/lookup", (req, res) => {
  const a = verifyAdmin(req, "/admin/lookup");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const meterNo = String(req.body.meterNo || "").trim();
  const target = String(req.body.targetWallet || "");
  if (!meterNo && !isAddr(target)) return res.status(400).json({ error: "provide a meter number or a wallet" });
  const utility = RATES[String(req.body.utility || "").toLowerCase()] ? String(req.body.utility).toLowerCase() : "electric";
  const meterKey = meterNo.toLowerCase();
  const snap = store.meterState(utility, meterKey, isAddr(target) ? target : null);
  res.json({
    ok: true,
    ...snap,
    banned: isAddr(target) ? banned(target) : null,
    // Every meter registered to this wallet (incl. ones added but not yet submitted).
    meters: isAddr(target) ? store.metersForWallet(target) : [],
  });
});

// Correct a wrong baseline: overwrite the server-recorded last reading for a
// meter (the value every future usage delta is measured from). Optionally also
// (re)bind the meter to a wallet. This is the fix for a mis-entered reading.
app.post("/admin/set-baseline", (req, res) => {
  const a = verifyAdmin(req, "/admin/set-baseline");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const meterNo = String(req.body.meterNo || "").trim();
  if (!meterNo) return res.status(400).json({ error: "meter number is required" });
  const reading = Number(req.body.reading);
  if (!Number.isFinite(reading) || reading < 0) return res.status(400).json({ error: "invalid reading" });
  const utility = RATES[String(req.body.utility || "").toLowerCase()] ? String(req.body.utility).toLowerCase() : "electric";
  const meterKey = meterNo.toLowerCase();
  store.setLastReading(utility, meterKey, reading);
  // Optional: rebind this meter to a given wallet (e.g. fix a wrong owner).
  const target = String(req.body.targetWallet || "");
  if (isAddr(target)) store.bindMeter(utility, meterKey, target.toLowerCase());
  res.json({ ok: true, meterNo: meterKey, utility, baseline: reading, owner: store.meterOwner(utility, meterKey) });
});

// Change a meter's NUMBER for a wallet (fix a typo / re-register under the correct
// number). Moves the server-side owner + baseline from the old number to the new one
// for the given utility. (Registering a brand-new meter is done via /admin/set-baseline.)
app.post("/admin/rename-meter", (req, res) => {
  const a = verifyAdmin(req, "/admin/rename-meter");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const oldMeterNo = String(req.body.oldMeterNo || "").trim().toLowerCase();
  const newMeterNo = String(req.body.newMeterNo || "").trim().toLowerCase();
  if (!oldMeterNo || !newMeterNo) return res.status(400).json({ error: "old and new meter numbers are required" });
  if (oldMeterNo === newMeterNo) return res.status(400).json({ error: "the new meter number is the same as the old one" });
  const target = String(req.body.targetWallet || "");
  if (!isAddr(target)) return res.status(400).json({ error: "target wallet is required" });
  const utility = RATES[String(req.body.utility || "").toLowerCase()] ? String(req.body.utility).toLowerCase() : "electric";
  // Don't clobber a meter number already owned by a DIFFERENT wallet.
  const newOwner = store.meterOwner(utility, newMeterNo);
  if (newOwner && newOwner !== target.toLowerCase()) return res.status(409).json({ error: "the new meter number is registered to another wallet" });
  const r = store.renameMeter(utility, oldMeterNo, newMeterNo, target.toLowerCase());
  res.json({ ok: true, utility, ...r });
});

// Clear a wallet+utility cooldown so a user who was wrongly blocked (or whose
// submission we just corrected) can submit again immediately.
app.post("/admin/reset-cooldown", (req, res) => {
  const a = verifyAdmin(req, "/admin/reset-cooldown");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const target = String(req.body.targetWallet || "");
  if (!isAddr(target)) return res.status(400).json({ error: "invalid target wallet" });
  const utility = String(req.body.utility || "electric");
  store.clearCooldown(target, utility);
  res.json({ ok: true, targetWallet: target.toLowerCase(), utility });
});

// Fetch the archived photo behind a payout (keyed by its txID) so an admin can eyeball
// it for fraud. Returns { found, dataUrl } — dataUrl is a downscaled thumbnail.
app.post("/admin/photo", async (req, res) => {
  const a = verifyAdmin(req, "/admin/photo");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  if (!photoStoreEnabled()) return res.json({ ok: true, enabled: false, found: false });
  const txid = String(req.body.txid || "").trim();
  if (!txid) return res.status(400).json({ error: "txid is required" });
  const dataUrl = await getPhotoDataUrl(txid);
  res.json({ ok: true, enabled: true, found: !!dataUrl, dataUrl: dataUrl || null });
});

// Delete one archived photo (per-submission 🗑️ in admin, or a GDPR erase request).
app.post("/admin/photo-delete", async (req, res) => {
  const a = verifyAdmin(req, "/admin/photo-delete");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const txid = String(req.body.txid || "").trim();
  if (!txid) return res.status(400).json({ error: "txid is required" });
  const ok = await deletePhoto(txid);
  store.delPhoto(txid);
  res.json({ ok: true, deleted: ok, txid });
});

// Meter-photo OCR. The app POSTs an image (base64) — the cropped reading or the
// full photo — and gets back the detected text + numbers from the first configured
// provider that recognises it (Roboflow → custom → Vision). Keys/URLs stay on the
// server. Returns 503 when no provider is configured, so the app falls back to
// in-browser OCR.
app.post("/ocr", async (req, res) => {
  if (!ocrEnabled()) return res.status(503).json({ ok: false, error: "ocr not configured" });
  // This forwards to PAID providers (Vision/Roboflow/Claude), so guard the cost:
  // ban list, a hard image-size cap, and an optional wallet-cert requirement
  // (OCR_REQUIRE_CERT=true) for when the app is wired to send one.
  if (banned(req.body?.address)) return res.status(403).json({ ok: false, error: "not allowed" });
  const image = req.body?.image;
  if (!image || typeof image !== "string") return res.status(400).json({ ok: false, error: "image is required" });
  if (image.length > 6_000_000) return res.status(413).json({ ok: false, error: "image too large" }); // ~4.4 MB decoded
  if (String(process.env.OCR_REQUIRE_CERT || "").toLowerCase() === "true") {
    const c = verifyWalletCertificate({ certificate: req.body?.certificate, address: req.body?.address });
    if (!c.ok) return res.status(401).json({ ok: false, error: c.error });
  }
  const { text, numbers, provider } = await ocrImage(image);
  res.json({ ok: true, text, numbers, provider });
});

// Wallet+utility pairs with a payout in flight — prevents two concurrent
// requests from both passing the cooldown and double-paying.
const inFlight = new Set();

app.post("/reward", async (req, res) => {
  // 0) Ban list — blocked wallets can never claim.
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });

  // 0a) Durable store must be loaded — otherwise cooldowns/hashes/baselines are blank
  // and a payout can't be recorded. Refuse rather than farm on an empty slate.
  if (!store.ready()) return res.status(503).json({ error: "service is warming up — please try again in a moment" });

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

  // Claim the in-flight lock SYNCHRONOUSLY, before any await, or two concurrent
  // requests both pass the has() check and double-pay (TOCTOU). Everything after
  // runs in the try so every early return still releases the lock in finally.
  const lockKey = `${String(req.body.address).toLowerCase()}:${req.body.utility}`;
  if (inFlight.has(lockKey)) return res.status(429).json({ error: "a submission for this meter is already processing" });
  inFlight.add(lockKey);
  let photo = null, committed = false;
  try {
    // 2) Photo check — real image, not a reused one (and optional OCR match). This
    // reserves the photo hash immediately; the finally rolls it back unless we pay.
    photo = await verifyPhoto({ imageBase64: req.body.photo, reading: req.body.reading, ocr: OCR_ENABLED, mime: req.body.photoMime });
    if (!photo.ok) return res.status(400).json({ error: photo.error });

    // 2b) AI authenticity — reject doctored / screenshotted / watermarked / hand-drawn
    // photos before issuing a reward. No-op (allows) when ANTHROPIC_API_KEY is unset.
    if (aiPhotoCheckEnabled()) {
      const auth = await checkPhotoAuthenticity(req.body.photo);
      if (!auth.ok) return res.status(400).json({ error: `photo rejected: ${auth.reason}` });
    }

    // 3) Pay out, then commit cooldown + baseline (only on success).
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
    committed = true; // payout landed — keep the reserved photo hash + committed cooldown
    // Make the anti-farming state (cooldown, burnt hash, baseline) durable BEFORE
    // responding, so a hard crash in the debounce window can't replay this payout.
    await store.flush();
    // Archive the photo for admin review (opt-in via R2 creds). Fire-and-forget —
    // must never delay or fail the payout. Keyed by txid so it lines up with the
    // on-chain history row shown in admin.
    archivePhoto(txid, req.body.photo, req.body.photoMime, req.body.address);
    res.json({ txid, amount: v.amount });
  } catch (e) {
    console.error("[/reward]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  } finally {
    // Release the photo reservation if we didn't actually pay, so a failed payout
    // doesn't permanently burn the user's photo.
    if (!committed && photo?.ok) photo.unreserve();
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
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  if (!store.ready()) return res.status(503).json({ error: "service is warming up — please try again in a moment" });

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

  // Claim the lock synchronously before any await (same TOCTOU fix as /reward).
  const lockKey = `${addr}:eco`;
  if (inFlight.has(lockKey)) return res.status(429).json({ error: "an eco submission is already processing" });
  inFlight.add(lockKey);
  let photo = null, committed = false;
  try {
    // Real image + never paid for before (reserved here). No OCR — no reading to match.
    photo = await verifyPhoto({ imageBase64: req.body.photo, ocr: false, mime: req.body.photoMime });
    if (!photo.ok) return res.status(400).json({ error: photo.error });

    if (aiPhotoCheckEnabled()) {
      const auth = await checkPhotoAuthenticity(req.body.photo);
      if (!auth.ok) return res.status(400).json({ error: `photo rejected: ${auth.reason}` });
    }

    const txid = await distributeEcoReward({ appliance, amount: ECO_REWARD, receiver: req.body.address });
    store.addEcoClaim(addr, Date.now());
    committed = true; // payout landed — keep the reserved photo hash + recorded claim
    await store.flush(); // make the claim + burnt hash durable before responding
    archivePhoto(txid, req.body.photo, req.body.photoMime, req.body.address);
    res.json({ txid, amount: ECO_REWARD, remaining: ECO_MAX_PER_WEEK - thisWeek.length - 1 });
  } catch (e) {
    console.error("[/eco-action]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  } finally {
    if (!committed && photo?.ok) photo.unreserve();
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
  // Remember which utility this meter is, so the scheduled auto-submit pays it at
  // the right rate/bounds/cooldown instead of always assuming electric.
  const utility = RATES[String(req.body.utility || "").toLowerCase()] ? String(req.body.utility).toLowerCase() : "electric";
  const existing = store.getLinkByAddress(address);
  // Re-pairing reuses the token; `rotate:true` forces a fresh one and invalidates the
  // old (use it if a token may have leaked from a Pi/NAS/shell history).
  if (existing && req.body.rotate === true) store.delMeterLink(existing.token);
  const token = (existing && req.body.rotate !== true) ? existing.token : randomBytes(24).toString("hex");
  store.setMeterLink(token, { address: address.toLowerCase(), meterNo, utility, createdAt: Date.now() });
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

// Unpair: revoke this wallet's device token and erase its ingested reading. Cert-authed
// (proves ownership) — the "revoke my reader / delete my meter data" control.
app.post("/meter/unpair", (req, res) => {
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  if (REQUIRE_CERT) {
    const c = verifyWalletCertificate({ certificate: req.body.certificate, address });
    if (!c.ok) return res.status(401).json({ error: c.error });
  }
  const existing = store.getLinkByAddress(address);
  if (existing) store.delMeterLink(existing.token);
  store.delLinkReading(address);
  res.json({ ok: true, unpaired: !!existing });
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

// Core settle logic shared by the manual endpoint (Step 2) and the scheduled
// auto-submit (Step 3). Returns { ok, ... } or { ok:false, code, error }; it does
// NOT do ban/captcha/cert — the caller owns request-level auth. All the reward
// rules still come from validateSubmission (cooldown, monotonicity, bounds, cap).
async function settleMeterReading({ address, utility = "electric", meterNo }) {
  const addr = String(address);
  // Bind to the PAIRED device: the reading came from this device, so it must settle
  // against the meter/utility the device was paired for — not arbitrary body values.
  // Otherwise one pushed number could be settled against several utilities/meters.
  const link = store.getLinkByAddress(addr);
  if (link?.meterNo) meterNo = link.meterNo;
  if (link?.utility && RATES[link.utility]) utility = link.utility;
  meterNo = String(meterNo || "").trim();
  if (!meterNo) return { ok: false, code: 400, error: "register your meter number first" };

  const latest = store.getLinkReading(addr);
  if (!latest || !Number.isFinite(Number(latest.reading))) {
    return { ok: false, code: 400, error: "no automatic reading yet — pair a device or connect a source first" };
  }
  if (Date.now() - (latest.at || 0) > METER_MAX_AGE_MS) {
    return { ok: false, code: 400, error: "the automatic reading is stale — refresh your reader/source, then try again" };
  }
  // The auto path never sets the FIRST reading, so a device can't invent a meter
  // or its starting value — a photo submission must have set the baseline first.
  if (store.lastReading(utility, meterNo.toLowerCase()) == null) {
    return { ok: false, code: 400, error: "submit one photo reading first to set this meter's baseline — then automatic readings pay out" };
  }

  const v = validateSubmission({ utility, reading: Number(latest.reading), meterNo, address: addr });
  if (!v.ok) return { ok: false, code: 400, error: v.error };

  const lockKey = `${addr.toLowerCase()}:${utility}`;
  if (inFlight.has(lockKey)) return { ok: false, code: 429, error: "a submission for this meter is already processing" };
  inFlight.add(lockKey);
  try {
    const txid = await distributeReward({
      utility, meterNo,
      reading:  Number(latest.reading),
      prevRead: v.prev,
      usage:    v.usage,
      amount:   v.amount,
      receiver: addr,
    });
    v.markPaid();
    await store.flush(); // durable before returning, so a crash can't replay this reading
    return { ok: true, txid, amount: v.amount, usage: v.usage, reading: Number(latest.reading), source: latest.source || "meter" };
  } finally {
    inFlight.delete(lockKey);
  }
}

app.post("/reward-from-meter", async (req, res) => {
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  if (!store.ready()) return res.status(503).json({ error: "service is warming up — please try again in a moment" });
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
  try {
    const r = await settleMeterReading({ address, utility: String(req.body.utility || "electric"), meterNo: req.body.meterNo });
    if (!r.ok) return res.status(r.code || 400).json({ error: r.error });
    res.json({ txid: r.txid, amount: r.amount, usage: r.usage, reading: r.reading, source: r.source });
  } catch (e) {
    console.error("[/reward-from-meter]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  }
});

// ── Scheduled auto-submit (Step 3, opt-in) ───────────────────────────────────
// Fully hands-off: on a timer, walk every paired meter and submit its latest
// pushed reading automatically — no app, no per-submit signature (the device
// token, bound to the wallet at pairing time, is the authorisation). Opt-in via
// AUTO_SUBMIT_MS (ms between sweeps; min 60000). Off when unset.
//   • Only pays a reading that arrived AFTER the wallet's last payout, so the same
//     reading is never paid twice even if COOLDOWN_MS is 0 during testing.
//   • Everything else (baseline required, freshness, cooldown, bounds, cap) is
//     enforced by settleMeterReading, exactly like the manual path.
const AUTO_SUBMIT_MS = Number(process.env.AUTO_SUBMIT_MS || 0);
let autoTickBusy = false;
async function autoSubmitTick() {
  if (!store.ready()) return; // don't pay from a blank/half-loaded state
  for (const link of store.allMeterLinks()) {
    const meterNo = String(link.meterNo || "").trim();
    if (!meterNo || banned(link.address)) continue;
    const utility = RATES[link.utility] ? link.utility : "electric";
    const latest = store.getLinkReading(link.address);
    if (!latest) continue;
    // Skip unless this reading is newer than the last payout for this wallet+utility.
    const lastPaid = store.getCooldown(`${String(link.address).toLowerCase()}:${utility}`);
    if ((latest.at || 0) <= lastPaid) continue;
    try {
      const r = await settleMeterReading({ address: link.address, utility, meterNo });
      if (r.ok) console.log(`[auto-submit] ${shortAddr(link.address)} +${r.amount} B3TR (${r.txid})`);
      // Non-ok results (stale / cooldown / no baseline) are normal skips, not errors.
    } catch (e) {
      console.error("[auto-submit]", shortAddr(link.address), e?.message || e);
    }
  }
}
if (AUTO_SUBMIT_MS >= 60000) {
  setInterval(() => {
    if (autoTickBusy) return;
    autoTickBusy = true;
    autoSubmitTick().catch(() => {}).finally(() => { autoTickBusy = false; });
  }, AUTO_SUBMIT_MS);
  console.log(`[auto-submit] enabled — sweeping every ${Math.round(AUTO_SUBMIT_MS / 1000)}s`);
}

// ── Photo-archive retention sweep ────────────────────────────────────────────
// Auto-delete archived photos older than PHOTO_RETENTION_DAYS (default 30) so we
// never hoard users' personal photos. Runs hourly; no-op when the archive is off.
const PHOTO_RETENTION_DAYS = Number(process.env.PHOTO_RETENTION_DAYS || 30);
const PHOTO_RETENTION_MS = Math.max(0, PHOTO_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
let sweepBusy = false;
async function photoRetentionSweep() {
  if (!photoStoreEnabled() || PHOTO_RETENTION_MS <= 0) return;
  const expired = store.expiredPhotos(PHOTO_RETENTION_MS);
  if (!expired.length) return;
  let gone = 0;
  for (const id of expired) {
    try { await deletePhoto(id); store.delPhoto(id); gone++; }
    catch (e) { console.error("[photo-retention]", id, e?.message || e); }
  }
  if (gone) console.log(`[photo-retention] deleted ${gone} photo(s) older than ${PHOTO_RETENTION_DAYS}d`);
}
if (PHOTO_RETENTION_MS > 0) {
  setInterval(() => {
    if (sweepBusy) return;
    sweepBusy = true;
    photoRetentionSweep().catch(() => {}).finally(() => { sweepBusy = false; });
  }, 60 * 60 * 1000);
}

// Mainnet safety guards — fail closed on the config foot-guns the audit flagged.
if (NETWORK === "mainnet") {
  if (!REQUIRE_CERT) {
    console.error("[boot] FATAL: NETWORK=mainnet requires REQUIRE_CERT=true (wallet-ownership proof). Refusing to start.");
    process.exit(1);
  }
  if (!aiPhotoCheckEnabled() && !ocrEnabled()) {
    console.warn("[boot] WARNING: mainnet with neither AI photo-authenticity nor OCR enabled — the photo layer adds little anti-fraud. Set ANTHROPIC_API_KEY or an OCR provider before real value flows.");
  }
  if (ALLOWED_ORIGINS.includes("*")) {
    console.warn("[boot] WARNING: mainnet with ALLOWED_ORIGIN='*' — lock it to your exact frontend origin.");
  }
}

const server = app.listen(PORT, () => {
  console.log(`Reward distributor listening on :${PORT} (${NETWORK})`);
});

// Graceful shutdown: a redeploy/scale-down sends SIGTERM. Flush any debounced
// anti-farming state (cooldowns, burnt photo hashes, baselines) before exiting so a
// just-committed payout can't be replayed after the restart. Guarded against double
// invocation and a hard 5s cap so we never hang the platform's shutdown.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${sig} — flushing state…`);
  const cap = setTimeout(() => process.exit(0), 5000);
  try { await store.flush(); } catch (e) { console.error("[shutdown] flush failed:", e?.message || e); }
  clearTimeout(cap);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
