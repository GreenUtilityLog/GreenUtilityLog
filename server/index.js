// ── Green Utility Log — reward-distributor API ───────────────────────────────
// POST /reward  : verify a submission and issue the B3TR reward on-chain.
// GET  /health  : service + distributor status.

import "dotenv/config";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import cors from "cors";
import { PORT, ALLOWED_ORIGIN, ALLOWED_ORIGINS, NETWORK, NODE_URL, APP_ID, OCR_ENABLED, isBanned, REQUIRE_PASS, ECO_REWARD, ECO_MAX_PER_WEEK, ECO_COOLDOWN_MS, ECO_APPLIANCES, ecoWeekKey, RATES, UNITS } from "./config.js";
import { validateSubmission } from "./verify.js";
import { verifyPhoto, checkReadingOnPhoto, readingCheckMode } from "./media.js";
import { store } from "./store.js";
import { putPhoto, getPhotoDataUrl, deletePhoto, photoStoreEnabled } from "./photostore.js";
import { distributeReward, distributeEcoReward, distributorAddress, chainDiagnostics, moveToRewardsPool, DRY_RUN } from "./reward.js";
import { signalStatus, passportFor, signalUser } from "./passport.js";
import { budgetState, scaledAmount, recordPayout, autoClaimAllocation } from "./budget.js";
import { ocrImage, ocrEnabled, ocrProviders } from "./ocr.js";
import { verifyWalletCertificate, REQUIRE_CERT, CERT_MAX_AGE_MS, certDomainsSeen } from "./auth.js";
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
// Also carries a photo: reconciling a meter's tariff registers demands the same
// proof a payout does. Without this it would hit the 64 kB default and every
// submission would fail on body size rather than on anything to do with the meter.
app.use("/meter/fix-basis", photoJson);
app.use(express.json({ limit: "64kb" }));

// Nothing may change state until the durable state has actually been read.
//
// When the load fails the store holds nothing and silently drops every write, so a
// request still "succeeds": /meter/pair hands out a token that is never stored and
// is therefore unknown forever; an admin bans a wallet, sees it work, and the ban
// evaporates on the next restart. Twenty-one endpoints were missing this check, and
// the two that had it had it because someone remembered. A gate per endpoint is a
// gate that gets forgotten, so this one covers every write there is and every write
// there will be.
//
// GETs are left alone: they only read, and /health in particular has to stay
// reachable — storeReady in its response is how anyone finds out this is happening.
app.use((req, res, next) => {
  if (req.method !== "POST" || store.loaded()) return next();
  res.status(503).json({ error: "service is warming up — please try again in a moment" });
});

// When this process came up — with the commit above, that is enough to tell a
// fresh deploy from a free-plan instance that merely woke from sleep.
const STARTED_AT = new Date().toISOString();

app.get("/health", async (req, res) => {
  // On-chain self-diagnosis: poolB3TR is the app's available reward funds;
  // distributorAuthorized says whether our wallet holds the reward-distributor
  // role. false on either one explains a reverting distributeReward instantly.
  const chain = await chainDiagnostics().catch(() => ({ poolB3TR: null, distributorAuthorized: null }));
  res.json({
    ok: true,
    // Which commit is actually running. "Did my backend redeploy?" has come up after
    // every backend change, and until now the only way to answer it was to poke an
    // endpoint and infer the answer from a 404. Render sets RENDER_GIT_COMMIT itself;
    // elsewhere set GIT_COMMIT, and where neither exists this reads "unknown" rather
    // than claiming something it doesn't know.
    commit: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown").slice(0, 7),
    startedAt: STARTED_AT,
    // Loud on purpose: a deployment that thinks it is paying but is not should be
    // obvious from the one endpoint everybody checks.
    dryRun: DRY_RUN,
    network: NETWORK,
    node: NODE_URL,
    appId: APP_ID,
    ocr: OCR_ENABLED,
    ocrProviders: ocrProviders(),
    // How this week's B3TR is being spread: rewards are paid at `factor` × the rates.
    rewardBudget: await budgetState().catch(() => null),
    // Whether the typed reading must be on the photo (off without an OCR provider).
    readingCheck: readingCheckMode(ocrEnabled()),
    // Which site names signatures arrive with, to fill CERT_DOMAINS from.
    certDomains: certDomainsSeen(),
    requireCert: REQUIRE_CERT,
    aiPhotoCheck: aiPhotoCheckEnabled(),
    photoArchive: photoStoreEnabled(),
    captcha: captchaEnabled(),
    corsLocked: !ALLOWED_ORIGINS.includes("*"),
    // Access passes: whether earning is gated, and how many have been issued.
    requirePass: REQUIRE_PASS,
    passCount: store.passCount(),
    // Submissions whose photo the app couldn't auto-confirm. All were paid — this is
    // a counter, not a queue. Also the cheapest way to tell from outside whether a
    // deploy carries the flag-recording change at all.
    flaggedCount: store.listFlags().length,
    // Which wallets the backend authorises for /admin/* (already public in the client
    // bundle) — surfaced so admin access is easy to verify.
    adminWallets: ADMIN_USER_WALLETS,
    durableState: store.isDurable(),
    // isDurable only says Redis is CONFIGURED. This says it was actually read: on a
    // load failure the store holds nothing, refuses payouts and writes nothing, and
    // from the outside that is indistinguishable from a quiet, empty service.
    storeReady: store.ready(),
    // false = the last save to durable storage failed: payouts pause until one lands.
    storeSaving: store.saveOk(),
    distributor: await distributorAddress().catch(() => null),
    poolB3TR: chain.poolB3TR,
    distributorAuthorized: chain.distributorAuthorized,
    rewardsPoolEnabled: chain.rewardsPoolEnabled,
    rewardsPoolB3TR: chain.rewardsPoolB3TR,
    appAdmin: chain.appAdmin,
    distributionPaused: chain.distributionPaused,
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

// Access pass gate. Separate from `banned` on purpose: banned is "you did something
// wrong", no pass is "you're not on the list yet" — different message, different fix.
// Returns null when the wallet may earn, or an error string when it may not.
function passBlock(addr) {
  if (!REQUIRE_PASS) return null;
  if (store.hasPass(addr)) return null;
  return "this wallet has no access pass yet — ask an admin for one";
}

// Why a request that needs the store was turned away. "Warming up" is only true
// for the first case; the second is a storage problem that needs looking at.
function notReadyMessage() {
  if (!store.loaded()) return "service is warming up — please try again in a moment";
  return "payouts are paused while the server can't save its records — nothing was used up, please try again later";
}

// One-time grandfathering, so switching REQUIRE_PASS on never retroactively strands
// testers who were already earning. Runs at boot, exactly once, and only when the
// store is readable — grandfathering off a half-loaded state would issue passes we'd
// then persist over the real data.
function backfillPasses() {
  if (!REQUIRE_PASS || !store.loaded() || store.passesInitialised()) return;
  const known = store.listKnownWallets();
  let granted = 0;
  for (const w of known) {
    if (w.banned) continue;   // a blocked wallet shouldn't be handed a pass on the way in
    // Only wallets that actually did something: own a meter (were paid for one),
    // paired a reader, or claimed an eco bonus. "Seen" alone is an unauthenticated POST anyone can make for
    // any address, so it would hand out passes to made-up wallets.
    if (!w.hasMeter && !w.paired && !w.hasEco) continue;
    store.grantPass(w.address, { tier: "tester", note: "grandfathered when passes were enabled" });
    granted++;
  }
  store.markPassesInitialised();
  // Count what was actually issued, not what was considered — banned wallets are skipped.
  console.log(`[pass] REQUIRE_PASS enabled — issued a pass to ${granted} of ${known.length} known wallet(s). Newcomers now need one from an admin.`);
}

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
// A signature proves WHO is asking. On its own it says nothing about WHAT was
// asked, and it can be presented again. Admin has bound both since it was written —
// the endpoints that actually move B3TR bound neither, so inside the 15-minute
// freshness window a captured certificate could be presented for a different
// submission, or for the same one twice.
//
// `mustContain` are fragments of the text the wallet signed. Each endpoint asserts
// its own purpose line, so a certificate signed for one action cannot be spent on
// another, plus the values that decide the payout.
// What makes a certificate "the same one again". Not its signature text: the same
// signature still verifies in upper case, without 0x, or in its high-S twin, so the
// audit replayed one admin certificate four times by re-spelling it. What was signed
// cannot be re-spelled, so that is the key.
function certKey(cert) {
  const c = cert || {};
  return createHash("sha256").update(JSON.stringify([
    String(c.signer || "").toLowerCase(), String(c.timestamp ?? ""), String(c.purpose || ""),
    String(c.domain || ""), String(c.payload?.type || ""), String(c.payload?.content || ""),
  ])).digest("hex");
}
// A certificate is accepted while its timestamp is within CERT_MAX_AGE_MS of now,
// on either side, so it can be live for twice that. Remember it for longer than that.
const CERT_REPLAY_MS = 2 * CERT_MAX_AGE_MS + 60_000;

function requireBoundCert(req, mustContain = []) {
  if (!REQUIRE_CERT) return { ok: true };
  const cert = req.body.certificate;
  const c = verifyWalletCertificate({ certificate: cert, address: req.body.address });
  if (!c.ok) return { ok: false, code: 401, error: c.error };
  const content = String(cert?.payload?.content || "");
  for (const needle of mustContain) {
    if (needle && !content.includes(needle)) {
      return { ok: false, code: 401, error: "this signature does not authorise this request — please sign again" };
    }
  }
  // Single use, for the certificate's whole lifetime: consumeCert only evicts
  // entries older than the freshness window, so a replay inside it always loses.
  if (!store.consumeCert(certKey(cert), CERT_REPLAY_MS)) {
    return { ok: false, code: 401, error: "signature already used — please sign again" };
  }
  return { ok: true };
}

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
  if (!store.consumeCert(certKey(cert), CERT_REPLAY_MS)) {
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
    // Access pass, so the admin sees in one place why a wallet can or can't earn.
    requirePass: REQUIRE_PASS,
    pass: isAddr(target) ? store.getPass(target) : null,
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

// Submissions the app's own checks couldn't fully confirm. They were paid — these
// checks don't hold a payout — so this is the list a human actually reviews.
app.post("/admin/flags", (req, res) => {
  const a = verifyAdmin(req, "/admin/flags");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const target = String(req.body.targetWallet || "");
  const all = store.listFlags().sort((x, y) => (y.at || 0) - (x.at || 0));
  const flags = isAddr(target) ? all.filter((f) => f.addr === target.toLowerCase()) : all;
  res.json({ ok: true, flags: flags.slice(0, 200), total: all.length });
});

// ── Admin: access passes ─────────────────────────────────────────────────────
// Issue or withdraw a wallet's pass. With REQUIRE_PASS on, holding one is what
// lets a wallet earn — it does not restrict opening the app or submitting, so a
// newcomer can still see what this is before asking for access.
app.post("/admin/pass", (req, res) => {
  const a = verifyAdmin(req, "/admin/pass");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const target = String(req.body.targetWallet || "");
  if (!isAddr(target)) return res.status(400).json({ error: "invalid target wallet" });
  const grant = req.body.grant !== false; // default: issue
  if (grant) {
    const pass = store.grantPass(target, { tier: req.body.tier, note: req.body.note, by: a.addr });
    return res.json({ ok: true, targetWallet: target.toLowerCase(), pass, requirePass: REQUIRE_PASS, passCount: store.passCount() });
  }
  const had = store.revokePass(target);
  res.json({ ok: true, targetWallet: target.toLowerCase(), pass: null, revoked: had, requirePass: REQUIRE_PASS, passCount: store.passCount() });
});

// Every issued pass, for the admin overview.
app.post("/admin/passes", (req, res) => {
  const a = verifyAdmin(req, "/admin/passes");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  res.json({ ok: true, requirePass: REQUIRE_PASS, passes: store.listPasses() });
});

// ── Admin: VeBetterDAO bot signalling ────────────────────────────────────────
// Read-only passport state for a batch of wallets, plus whether we may signal at
// all. Works with no role and no key, which is the point: the admin can see who
// the passport already distrusts long before we can file a signal ourselves.
app.post("/admin/passport", async (req, res) => {
  const a = verifyAdmin(req, "/admin/passport");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const wallets = Array.isArray(req.body.wallets) ? req.body.wallets.slice(0, 25) : [];
  try {
    const [status, passports] = await Promise.all([signalStatus(), passportFor(wallets)]);
    res.json({ ok: true, status, passports });
  } catch (e) {
    console.error("[/admin/passport]", e?.message || e);
    res.status(502).json({ error: "could not read the passport contract" });
  }
});

// File a bot signal against a wallet. This is an ecosystem-wide accusation, not a
// local block — /admin/ban is the local one. Requires SIGNALER_ROLE, which the app
// admin grants from the admin panel (passport.js); without it the simulation fails and we return the
// contract's own reason rather than spending gas.
app.post("/admin/signal", async (req, res) => {
  const a = verifyAdmin(req, "/admin/signal");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const target = String(req.body.targetWallet || "");
  if (!isAddr(target)) return res.status(400).json({ error: "invalid target wallet" });
  if (ADMIN_USER_WALLETS.includes(target.toLowerCase())) {
    return res.status(400).json({ error: "refusing to signal an admin wallet" });
  }
  const reason = String(req.body.reason || "").trim();
  if (reason.length < 3) return res.status(400).json({ error: "a reason is required" });
  try {
    const txid = await signalUser(target, reason);
    console.log(`[admin] signalled ${shortAddr(target)} by ${shortAddr(a.addr)}`);
    res.json({ ok: true, txid, targetWallet: target.toLowerCase() });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("[/admin/signal]", msg);
    // The revert reason is the whole diagnostic here ("not authorised to signal"),
    // so pass it through instead of flattening it to a generic 502.
    res.status(502).json({ error: msg });
  }
});

// Every wallet the backend knows about — app-seen, meter owners, paired devices and
// bans — so the admin list isn't limited to wallets that already earned on-chain.
app.post("/admin/wallets", (req, res) => {
  const a = verifyAdmin(req, "/admin/wallets");
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  res.json({ ok: true, wallets: store.listKnownWallets() });
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
  if (dataUrl) return res.json({ ok: true, enabled: true, found: true, dataUrl });
  // "No photo" has three very different causes and the admin could not tell them
  // apart. The retention index records every submission we DID archive, so a missing
  // blob with an index entry means the retention window passed (or it was deleted),
  // while no index entry at all means the photo was never stored — typically a
  // submission made before the archive was switched on.
  const known = store.hasPhoto(txid);
  res.json({
    ok: true, enabled: true, found: false, dataUrl: null,
    reason: known ? "expired" : "never-archived",
    retentionDays: Number(process.env.PHOTO_RETENTION_DAYS || 30),
  });
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
const OCR_DAILY_MAX = Number(process.env.OCR_DAILY_MAX || 1000);
const OCR_DAILY_PER_IP = Number(process.env.OCR_DAILY_PER_IP || 40);
const ocrQuota = { day: "", total: 0, byIp: new Map() };
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
  // Every call here costs money at a paid provider and needs no signature, so cap
  // the damage a script can do: per IP and in total, per UTC day.
  const day = new Date().toISOString().slice(0, 10);
  if (ocrQuota.day !== day) { ocrQuota.day = day; ocrQuota.total = 0; ocrQuota.byIp.clear(); }
  const ipCount = ocrQuota.byIp.get(req.clientIp) || 0;
  if (ocrQuota.total >= OCR_DAILY_MAX || ipCount >= OCR_DAILY_PER_IP) {
    return res.status(429).json({ ok: false, error: "photo reading limit reached for today — type the reading in yourself" });
  }
  ocrQuota.total++; ocrQuota.byIp.set(req.clientIp, ipCount + 1);
  const { text, numbers, provider } = await ocrImage(image);
  res.json({ ok: true, text, numbers, provider });
});

// Wallet+utility pairs with a payout in flight — prevents two concurrent
// requests from both passing the cooldown and double-paying.
const inFlight = new Set();

app.post("/reward", async (req, res) => {
  // 0) Ban list — blocked wallets can never claim.
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  { const pb = passBlock(req.body.address); if (pb) return res.status(403).json({ error: pb, needsPass: true }); }

  // 0a) Durable store must be loaded — otherwise cooldowns/hashes/baselines are blank
  // and a payout can't be recorded. Refuse rather than farm on an empty slate.
  if (!store.ready()) return res.status(503).json({ error: notReadyMessage() });

  // 0b) Captcha — proves the request came from a real browser, not a bot/script.
  if (captchaEnabled()) {
    const cap = await verifyCaptcha(req.body.captchaToken, req.clientIp);
    if (!cap.ok) return res.status(403).json({ error: cap.error });
  }

  // 0c) Tariff registers, when the meter has more than one.
  // A double-tariff meter keeps 1.8.1 (low) and 1.8.2 (normal) and cycles its
  // display, so no photo can ever show their sum — yet the sum is the consumption,
  // and the figure a P1 reader reports. The app therefore sends the parts and the
  // total it built from them, and the photo is corroborated against the parts.
  //
  // The sum MUST be re-derived here. Trusting the client's total while checking the
  // photo against the parts would be the whole point of the photo check thrown away:
  // send two numbers that are on the meter, plus any total you like, and the reading
  // paid on would be unverified. Cheap to get right, fatal to skip.
  const registers = Array.isArray(req.body.registers)
    ? req.body.registers.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : [];
  if (registers.length) {
    if (registers.length > 4) return res.status(400).json({ error: "too many meter registers" });
    if (registers.length !== req.body.registers.length) {
      return res.status(400).json({ error: "every meter register must be a number of 0 or more" });
    }
    const sum = +registers.reduce((a, b) => a + b, 0).toFixed(3);
    const claimed = Number(req.body.reading);
    // A tolerance of 0.01 absorbs the rounding of a meter that shows three decimals
    // while the field takes two; anything wider would let a register be padded.
    if (!Number.isFinite(claimed) || Math.abs(sum - claimed) > 0.01) {
      return res.status(400).json({ error: `the registers add up to ${sum}, not ${claimed}` });
    }
  }

  // 1) Structural checks + server-recomputed amount.
  const v = validateSubmission(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  // 1b) Wallet ownership proof, bound to THIS submission and spendable once.
  {
    const c = requireBoundCert(req, [
      "confirm submission",
      `Utility: ${req.body.utility}`,
      `Reading: ${req.body.reading}`,
    ]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
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
    photo = await verifyPhoto({ imageBase64: req.body.photo, reading: req.body.reading, registers, ocr: OCR_ENABLED, mime: req.body.photoMime });
    if (!photo.ok) return res.status(400).json({ error: photo.error });

    // 2b) AI authenticity — reject doctored / screenshotted / watermarked / hand-drawn
    // photos before issuing a reward. No-op (allows) when ANTHROPIC_API_KEY is unset.
    if (aiPhotoCheckEnabled()) {
      const auth = await checkPhotoAuthenticity(req.body.photo, photo.mime);
      if (!auth.ok) return res.status(auth.unavailable ? 503 : 400).json({ error: auth.unavailable ? auth.reason : `photo rejected: ${auth.reason}` });
    }

    // 2c) The typed reading has to be the one on the photo (see media.js).
    let readingFlag = "";
    const rcMode = readingCheckMode(ocrEnabled());
    if (rcMode !== "off") {
      const rc = await checkReadingOnPhoto({ imageBase64: req.body.photo, reading: req.body.reading, registers, ocrImage });
      if (!rc.ok && (rcMode === "strict" || rc.unavailable)) {
        return res.status(rc.unavailable ? 503 : 400).json({ error: rc.error });
      }
      if (!rc.ok) readingFlag = `server OCR did not find ${req.body.reading} on the photo (read ${(rc.seen || []).join(", ") || "nothing"})`;
    }

    // 3) Scale to this week's budget (budget.js), pay out, then commit cooldown +
    // baseline (only on success).
    const pay = await scaledAmount(v.amount);
    if (pay.error) return res.status(503).json({ error: pay.error, budget: true });
    const txid = await distributeReward({
      utility:  req.body.utility,
      meterNo:  req.body.meterNo,
      reading:  req.body.reading,
      prevRead: v.prev,    // server baseline, not the client-sent prevRead
      usage:    v.usage,   // server-validated usage
      amount:   pay.amount,
      receiver: req.body.address,
      source:   "photo",
    });
    v.markPaid();
    recordPayout(v.amount);
    committed = true; // payout landed — keep the reserved photo hash + committed cooldown
    // Make the anti-farming state (cooldown, burnt hash, baseline) durable BEFORE
    // responding, so a hard crash in the debounce window can't replay this payout.
    await store.flush();
    // Archive the photo for admin review (opt-in via R2 creds). Fire-and-forget —
    // must never delay or fail the payout. Keyed by txid so it lines up with the
    // on-chain history row shown in admin.
    archivePhoto(txid, req.body.photo, req.body.photoMime, req.body.address);
    // The app's own checks (OCR match, meter number, plausibility) rode along in the
    // request and were being discarded — so the app could tell a user their
    // submission was "flagged for review" while nothing was recorded and no review
    // was possible. These checks intentionally don't hold a payout (they
    // false-positive on genuine phone photos), but they are worth keeping so an
    // admin can look afterwards. Best-effort: never let it affect the response.
    // A photo with no EXIF date at all is worth recording too. It is NOT grounds to
    // refuse — share sheets strip EXIF and PNG has no such field, so honest uploads
    // land here — but a wallet whose photos never carry one is a pattern an admin
    // should be able to see.
    const reasons = [];
    if (readingFlag) reasons.push(readingFlag);
    if (req.body.clientFlagged) reasons.push(req.body.flagReason || "client checks were inconclusive");
    if (photo?.exif && !photo.exif.hasExif) reasons.push("photo carried no EXIF capture date");
    // Worth seeing: the figure paid on was a sum, and the photo could only vouch for
    // one of its parts. Not a refusal — it is the normal shape of a double-tariff
    // meter — but the part that is NOT in the photo rests on the submitter's word.
    if (registers.length > 1) {
      reasons.push(`total of ${registers.length} tariff registers (${registers.join(" + ")})`
        + (photo?.ocrMatched ? `, photo matched ${photo.ocrMatched}` : ""));
    }
    if (reasons.length) {
      try { store.addFlag(txid, req.body.address, reasons.join(" · ")); }
      catch (e) { console.error("[/reward] could not record flag:", e?.message || e); }
    }
    res.json({ txid, amount: pay.amount, fullAmount: v.amount, factor: pay.factor, flagged: reasons.length > 0 });
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
  { const pb = passBlock(req.body.address); if (pb) return res.status(403).json({ error: pb, needsPass: true }); }
  if (!store.ready()) return res.status(503).json({ error: notReadyMessage() });

  if (captchaEnabled()) {
    const cap = await verifyCaptcha(req.body.captchaToken, req.clientIp);
    if (!cap.ok) return res.status(403).json({ error: cap.error });
  }

  const addr = String(req.body.address || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "invalid wallet address" });
  const appliance = String(req.body.appliance || "").toLowerCase();
  if (!ECO_APPLIANCES.has(appliance)) return res.status(400).json({ error: "unknown appliance" });

  {
    const c = requireBoundCert(req, ["confirm eco-mode bonus", `Appliance: ${appliance}`]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
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
      const auth = await checkPhotoAuthenticity(req.body.photo, photo.mime);
      if (!auth.ok) return res.status(auth.unavailable ? 503 : 400).json({ error: auth.unavailable ? auth.reason : `photo rejected: ${auth.reason}` });
    }

    const pay = await scaledAmount(ECO_REWARD);
    if (pay.error) return res.status(503).json({ error: pay.error, budget: true });
    const txid = await distributeEcoReward({ appliance, amount: pay.amount, receiver: req.body.address });
    store.addEcoClaim(addr, Date.now());
    recordPayout(ECO_REWARD);
    committed = true; // payout landed — keep the reserved photo hash + recorded claim
    await store.flush(); // make the claim + burnt hash durable before responding
    archivePhoto(txid, req.body.photo, req.body.photoMime, req.body.address);
    res.json({ txid, amount: pay.amount, fullAmount: ECO_REWARD, factor: pay.factor, remaining: ECO_MAX_PER_WEEK - thisWeek.length - 1 });
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
  {
    // Bound to what the app signs for linking, and single-use. A bare "any valid
    // signature by this wallet" also accepted one made for a different site.
    const c = requireBoundCert(req, ["Green Utility Log — link smart meter"]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
  }
  const meterNo = String(req.body.meterNo || "").trim();
  // Remember which utility this meter is, so the scheduled auto-submit pays it at
  // the right rate/bounds/cooldown instead of always assuming electric.
  const utility = RATES[String(req.body.utility || "").toLowerCase()] ? String(req.body.utility).toLowerCase() : "electric";
  // A reader can only be paired to a meter that is yours, or nobody's yet. Without
  // this, anyone who knew a meter number could pair to it and push numbers against
  // someone else's baseline.
  if (meterNo) {
    const owner = store.meterOwner(utility, meterNo.toLowerCase());
    if (owner && owner !== address.toLowerCase()) {
      return res.status(403).json({ error: "this meter is registered to another wallet" });
    }
  }
  const existing = store.getLinkByAddress(address);
  // Re-pairing reuses the token; `rotate:true` forces a fresh one and invalidates the
  // old (use it if a token may have leaked from a Pi/NAS/shell history).
  if (existing && req.body.rotate === true) store.delMeterLink(existing.token);
  const token = (existing && req.body.rotate !== true) ? existing.token : randomBytes(24).toString("hex");
  // Keep what this wallet's pairing has already been through (autoPaidAt closes
  // /meter/rebaseline) when it is the same meter. Pairing again must not reset it.
  const carried = existing && String(existing.meterNo || "").toLowerCase() === meterNo.toLowerCase() && existing.utility === utility
    ? { autoPaidAt: existing.autoPaidAt, rebasedAt: existing.rebasedAt } : {};
  store.setMeterLink(token, { ...carried, address: address.toLowerCase(), meterNo, utility, createdAt: Date.now() });
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
  {
    // Bound to what the app signs for linking, and single-use. A bare "any valid
    // signature by this wallet" also accepted one made for a different site.
    const c = requireBoundCert(req, ["Green Utility Log — link smart meter"]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
  }
  const existing = store.getLinkByAddress(address);
  if (existing) store.delMeterLink(existing.token);
  store.delLinkReading(address);
  res.json({ ok: true, unpaired: !!existing });
});

// The endpoint a reader posts to. Token-authed (the token IS the secret binding to
// a wallet) — deliberately no wallet cert, since an unattended device can't sign.
app.post("/meter-ingest", (req, res) => {
  // Before anything else. A store that failed to load its durable state looks
  // exactly like a store with no devices in it, so without this check every reader
  // on earth is told "unknown device token" — the one message that sends its owner
  // off to re-pair a device that was never the problem.
  if (!store.loaded()) {
    return res.status(503).json({ error: "service is warming up — please try again in a moment" });
  }
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

// The app reports its connected wallet here so admin can see testers who haven't
// earned on-chain yet. Deliberately unauthenticated — requiring a signature would mean
// a wallet popup on every connect — so it stores only a public address (validated),
// is covered by the IP throttle, and the roster is hard-capped in the store.
app.post("/wallet/seen", (req, res) => {
  const address = String(req.body?.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  store.seenWallet(address, req.body?.meters);
  // The app calls this on connect anyway, so it's the natural place to tell it whether
  // it holds a pass — no extra round-trip, and no separate endpoint that would leak
  // the whole pass list. Only ever reports on the wallet that asked.
  const pass = store.getPass(address);
  res.json({
    ok: true,
    requirePass: REQUIRE_PASS,
    hasPass: !REQUIRE_PASS || Boolean(pass),
    pass: pass ? { no: pass.no, tier: pass.tier, issuedAt: pass.issuedAt } : null,
  });
});

// The app fetches this on connect to PRE-FILL a meter number an admin registered for
// this wallet (via /admin/set-baseline) — so a user who can't find their meter number
// doesn't have to: the admin assigns it and it shows up ready to submit. Returns the
// wallet's registered meters (number + utility + baseline). Low-sensitivity (meter
// numbers), behind the IP throttle; gate with a cert before mainnet if desired.
app.get("/meter/registered", (req, res) => {
  const address = String(req.query.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  res.json({ ok: true, meters: store.metersForWallet(address) });
});

// The app polls this to show / prefill the latest automatically-received reading.
app.get("/meter/latest", (req, res) => {
  const address = String(req.query.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  const r = store.getLinkReading(address);
  const link = store.getLinkByAddress(address);
  // The app needs two more things to offer the "correct my starting point" button
  // honestly: whether it is still allowed, and what the stored starting point is, so
  // it can show the jump rather than ask people to trust a button.
  const utility = link?.utility && RATES[link.utility] ? link.utility : "electric";
  const baseline = link?.meterNo ? store.lastReading(utility, String(link.meterNo).toLowerCase()) : null;
  res.json({
    paired: !!link,
    reading: r || null,
    canRebaseline: !!link && !link.autoPaidAt && !(link.meterNo && (store.rebasedAt(utility, String(link.meterNo).toLowerCase()) || store.autoPaidAt(utility, String(link.meterNo).toLowerCase()))),
    baseline: baseline != null ? baseline : null,
    rebasedAt: link?.rebasedAt || null,
  });
});

// ── Enode source (optional) ──────────────────────────────────────────────────
// Create a Link session; the app opens the returned linkUrl so the user authorises
// their meter with Enode. Cert-authed so a link is only ever created for the
// wallet that owns it.
app.post("/meter/enode/link", async (req, res) => {
  if (!enodeEnabled()) return res.status(503).json({ error: "enode not configured" });
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  {
    // Bound to what the app signs for linking, and single-use. A bare "any valid
    // signature by this wallet" also accepted one made for a different site.
    const c = requireBoundCert(req, ["Green Utility Log — link smart meter"]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
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
  {
    // Bound to what the app signs for linking, and single-use. A bare "any valid
    // signature by this wallet" also accepted one made for a different site.
    const c = requireBoundCert(req, ["Green Utility Log — link smart meter"]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
  }
  try {
    const latest = await fetchLatestReading(address);
    if (!latest) return res.json({ linked: false });
    // Only store a reading whose field was EXPLICITLY configured (ENODE_READING_FIELD).
    // A heuristically-guessed field must never become payable: it feeds
    // /reward-from-meter, so a wrong guess would pay out a wrong amount. The value and
    // the raw object are still returned so an operator can pin the correct field.
    const payable = Number.isFinite(latest.reading) && latest.guessed === false;
    if (payable) {
      store.setLinkReading(address, {
        reading: latest.reading,
        meterNo: latest.meterId || null,
        at: Date.now(),
        source: "enode",
      });
    } else if (latest.guessed) {
      console.warn("[enode] reading field not pinned — set ENODE_READING_FIELD; not storing a guessed value.");
    }
    res.json({
      linked: true, reading: latest.reading, unit: latest.unit, field: latest.field,
      guessed: !!latest.guessed, stored: payable,
      hint: latest.guessed ? "Set ENODE_READING_FIELD to this field's dot-path to make it payable." : undefined,
      raw: latest.raw,
    });
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
    const pay = await scaledAmount(v.amount);
    if (pay.error) return { ok: false, code: 503, error: pay.error };
    const txid = await distributeReward({
      utility, meterNo,
      reading:  Number(latest.reading),
      prevRead: v.prev,
      usage:    v.usage,
      amount:   pay.amount,
      receiver: addr,
      // "push" for a reader, "enode" for the API route; either way no photo exists.
      source:   latest.source || "reader",
    });
    v.markPaid();
    recordPayout(v.amount);
    // This pairing has now produced a real payout, which means its readings and the
    // stored baseline are on the same scale. That closes /meter/rebaseline: the
    // escape hatch exists for a starting point that was never comparable, not for
    // one that has already been used to pay.
    store.markAutoPaid(utility, meterNo.toLowerCase());
    if (link?.token) {
      const { token, ...rest } = link;
      store.setMeterLink(token, { ...rest, autoPaidAt: Date.now() });
    }
    await store.flush(); // durable before returning, so a crash can't replay this reading
    return { ok: true, txid, amount: pay.amount, fullAmount: v.amount, factor: pay.factor, usage: v.usage, reading: Number(latest.reading), source: latest.source || "meter" };
  } finally {
    inFlight.delete(lockKey);
  }
}

app.post("/reward-from-meter", async (req, res) => {
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  { const pb = passBlock(req.body.address); if (pb) return res.status(403).json({ error: pb, needsPass: true }); }
  if (!store.ready()) return res.status(503).json({ error: notReadyMessage() });
  if (captchaEnabled()) {
    const cap = await verifyCaptcha(req.body.captchaToken, req.clientIp);
    if (!cap.ok) return res.status(403).json({ error: cap.error });
  }
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  {
    const c = requireBoundCert(req, ["confirm automatic meter submission"]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
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

// ── Correcting a starting point that was never comparable ────────────────────
// A Dutch double-tariff meter keeps two registers — 1.8.1 (low) and 1.8.2 (normal) —
// and shows them in turn. A photo can only capture one of them; a P1 reader reports
// their sum, which is the physically correct total. So the photo baseline and every
// automatic reading after it are on different scales, the first claim looks like
// thousands of kWh of usage, and it is refused as implausible. Correctly refused, and
// permanently stuck: nothing the owner can do makes the two numbers comparable.
//
// This lets them say once: take what my reader reports now as the starting point.
//
// Deliberately NOT time-limited. The bound that means something is "before this
// pairing has ever been paid", not a clock. A clock locks out exactly the person who
// went away to find out what went wrong, and it buys no safety: the new baseline
// always comes from the device itself, so it can never make a later delta smaller
// than the truth. Anyone who wants smaller deltas has to make the device lie, which
// this endpoint neither enables nor prevents. Pays nothing, and is recorded as a flag
// so it stays reviewable afterwards.
app.post("/meter/rebaseline", async (req, res) => {
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  if (!store.loaded()) return res.status(503).json({ error: notReadyMessage() });
  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  {
    const c = requireBoundCert(req, ["confirm starting point correction"]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
  }

  const link = store.getLinkByAddress(address);
  if (!link) return res.status(400).json({ error: "no reader paired — set up automatic readings first" });
  if (link.autoPaidAt) {
    return res.status(409).json({ error: "this reader has already paid out once, so its starting point is settled" });
  }

  const utility = link.utility && RATES[link.utility] ? link.utility : "electric";
  const meterNo = String(link.meterNo || req.body.meterNo || "").trim();
  if (!meterNo) return res.status(400).json({ error: "register your meter number first" });

  const latest = store.getLinkReading(address);
  const reading = Number(latest?.reading);
  if (!Number.isFinite(reading)) {
    return res.status(400).json({ error: "no automatic reading yet — start your reader first" });
  }
  if (Date.now() - (latest.at || 0) > METER_MAX_AGE_MS) {
    return res.status(400).json({ error: "the automatic reading is stale — refresh your reader, then try again" });
  }

  const key = meterNo.toLowerCase();
  // Only the meter's owner may move its starting point.
  const owner = store.meterOwner(utility, key);
  if (owner && owner !== address.toLowerCase()) {
    return res.status(403).json({ error: "this meter is registered to another wallet" });
  }
  // Once per meter. Each rebaseline wipes the usage since the last payout, so an
  // unlimited one turns every photo after it into a near-zero-usage maximum payout.
  if (store.autoPaidAt(utility, key)) {
    return res.status(409).json({ error: "this reader has already paid out once, so its starting point is settled" });
  }
  if (store.rebasedAt(utility, key)) {
    return res.status(409).json({ error: "this meter's starting point has already been corrected once — ask an admin if it is wrong again" });
  }
  const prev = store.lastReading(utility, key);
  // The photo baseline stays required. The automatic path must never be able to
  // invent a meter or a starting value out of nothing — only to correct the scale of
  // a starting point a photo already established.
  if (prev == null) {
    return res.status(400).json({ error: "submit one photo reading first to set this meter's baseline" });
  }
  if (reading < prev) {
    return res.status(400).json({ error: `your reader reports ${reading}, below the current starting point of ${prev} — a meter total cannot run backwards` });
  }

  // setLastReading also stamps the time, so the next submission's span is measured
  // from now rather than from a photo that may be weeks old.
  store.setLastReading(utility, key, reading);
  store.markRebased(utility, key, { from: prev, to: reading, by: address.toLowerCase() });
  const { token, ...rest } = link;
  store.setMeterLink(token, { ...rest, rebasedAt: Date.now(), rebasedFrom: prev, rebasedTo: reading });
  store.addFlag(
    `rebase-${address.toLowerCase().slice(2, 10)}-${Date.now()}`,
    address,
    `starting point moved ${prev} → ${reading} ${UNITS[utility] || ""} (${utility}, meter ${meterNo}) at the owner's request`,
  );
  await store.flush();
  res.json({ ok: true, from: prev, to: reading, utility, meterNo, unit: UNITS[utility] || "" });
});

// ── Correcting a photo baseline that only ever covered one tariff register ───
// The same mismatch as /meter/rebaseline, reached from the other side. Someone who
// has been photographing 1.8.1 has a baseline that counts one tariff; the moment they
// start entering the total of both — which is their real consumption, and what a
// reader reports — the step is thousands of kWh and every claim is refused.
//
// Kept OUT of /reward deliberately. That endpoint pays, and a non-paying branch
// threaded through it is how a payout path acquires a way to skip validation. This
// one runs the identical photo proof (real image, fresh, not reused, OCR must find a
// register on it) and then only moves the starting point.
//
// Once per meter, ever. It cannot lower a baseline, it pays nothing, and it is
// recorded both as durable state and as a flag.
app.post("/meter/fix-basis", async (req, res) => {
  if (banned(req.body.address)) return res.status(403).json({ error: "this wallet is not allowed to claim" });
  if (!store.loaded()) return res.status(503).json({ error: notReadyMessage() });

  const address = String(req.body.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return res.status(400).json({ error: "invalid wallet address" });
  {
    const c = requireBoundCert(req, ["reconcile tariff registers", `Meter: ${req.body.meterNo}`]);
    if (!c.ok) return res.status(c.code).json({ error: c.error });
  }

  const utility = RATES[String(req.body.utility || "").toLowerCase()] ? String(req.body.utility).toLowerCase() : "electric";
  const meterNo = String(req.body.meterNo || "").trim();
  if (!meterNo) return res.status(400).json({ error: "meter number is required" });
  const meterKey = meterNo.toLowerCase();

  // Same ownership rule as a payout: one physical meter belongs to one wallet.
  const owner = store.meterOwner(utility, meterKey);
  if (owner && owner !== address.toLowerCase()) {
    return res.status(403).json({ error: "this meter is registered to another wallet" });
  }
  if (store.basisFixedAt(utility, meterKey)) {
    return res.status(409).json({ error: "this meter's registers have already been reconciled once" });
  }

  const registers = Array.isArray(req.body.registers)
    ? req.body.registers.map(Number).filter((n) => Number.isFinite(n) && n >= 0)
    : [];
  if (registers.length < 2 || registers.length > 4 || registers.length !== req.body.registers.length) {
    return res.status(400).json({ error: "give the value of each tariff register on your meter" });
  }
  const total = +registers.reduce((a, b) => a + b, 0).toFixed(3);

  const prev = store.lastReading(utility, meterKey);
  if (prev == null) {
    return res.status(400).json({ error: "this meter has no starting point yet — submit a normal photo reading instead" });
  }
  if (total <= prev) {
    return res.status(400).json({ error: `the registers add up to ${total}, which is not above the current starting point of ${prev} — nothing to reconcile` });
  }

  let photo = null;
  try {
    // The photo carries the same weight as it does for a payout: it has to be a real,
    // fresh, unused image, and OCR (when on) has to find one of these registers on it.
    photo = await verifyPhoto({ imageBase64: req.body.photo, reading: total, registers, ocr: OCR_ENABLED, mime: req.body.photoMime });
    if (!photo.ok) return res.status(400).json({ error: photo.error });
    if (aiPhotoCheckEnabled()) {
      const auth = await checkPhotoAuthenticity(req.body.photo, photo.mime);
      if (!auth.ok) { photo.unreserve(); return res.status(auth.unavailable ? 503 : 400).json({ error: auth.unavailable ? auth.reason : `photo rejected: ${auth.reason}` }); }
    }
    // One of the registers has to be on the photo. Flag mode has nothing to flag
    // here — this moves a baseline, it pays nothing — so anything but "off" enforces.
    if (readingCheckMode(ocrEnabled()) !== "off") {
      const rc = await checkReadingOnPhoto({ imageBase64: req.body.photo, reading: total, registers, ocrImage });
      if (!rc.ok) { photo.unreserve(); return res.status(rc.unavailable ? 503 : 400).json({ error: rc.error }); }
    }

    store.setLastReading(utility, meterKey, total);
    store.bindMeter(utility, meterKey, address.toLowerCase());
    store.markBasisFixed(utility, meterKey, { from: prev, to: total, registers, addr: address.toLowerCase() });
    store.addFlag(
      `basis-${address.toLowerCase().slice(2, 10)}-${Date.now()}`,
      address,
      `tariff registers reconciled ${prev} → ${total} ${UNITS[utility] || ""} (${registers.join(" + ")}, ${utility}, meter ${meterNo})`,
    );
    await store.flush();
    res.json({ ok: true, from: prev, to: total, registers, utility, meterNo, unit: UNITS[utility] || "" });
  } catch (e) {
    if (photo?.ok) photo.unreserve();
    console.error("[/meter/fix-basis]", e?.message || e);
    res.status(500).json({ error: e?.message || "could not reconcile this meter" });
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

// Collect each ended round's allocation into the pot (budget.js). Hourly, and once
// shortly after start so a service that slept through the round end catches up.
setTimeout(() => { autoClaimAllocation().catch((e) => console.warn("[budget] auto-claim:", e?.message || e)); }, 30000).unref();
setInterval(() => { autoClaimAllocation().catch((e) => console.warn("[budget] auto-claim:", e?.message || e)); }, 60 * 60 * 1000).unref();

const server = app.listen(PORT, () => {
  console.log(`Reward distributor listening on :${PORT} (${NETWORK})`);
  // After the store has had a chance to load — grandfathering off an unread store
  // would issue passes against empty state and then persist that over the real data.
  setTimeout(backfillPasses, 2000).unref?.();
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
