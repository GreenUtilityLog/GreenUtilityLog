// ── Green Utility Log — reward-distributor API ───────────────────────────────
// POST /reward  : verify a submission and issue the B3TR reward on-chain.
// GET  /health  : service + distributor status.

import "dotenv/config";
import express from "express";
import cors from "cors";
import { PORT, ALLOWED_ORIGIN, NETWORK, NODE_URL, APP_ID, OCR_ENABLED } from "./config.js";
import { validateSubmission } from "./verify.js";
import { verifyPhoto } from "./media.js";
import { distributeReward, distributorAddress } from "./reward.js";

const app = express();
// Limit allows for a meter photo (base64) in the body.
app.use(express.json({ limit: "14mb" }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Very small in-memory IP throttle — a coarse abuse guard on top of the
// per-wallet cooldown. Replace with a real rate limiter (e.g. express-rate-limit
// backed by Redis) in production.
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const win = hits.get(ip)?.filter((t) => now - t < 60_000) || [];
  if (win.length >= 30) return res.status(429).json({ error: "too many requests" });
  win.push(now);
  hits.set(ip, win);
  next();
});

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    network: NETWORK,
    node: NODE_URL,
    appId: APP_ID,
    ocr: OCR_ENABLED,
    distributor: await distributorAddress().catch(() => null),
  });
});

app.post("/reward", async (req, res) => {
  // 1) Structural checks + server-recomputed amount.
  const v = validateSubmission(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });

  // 2) Photo check — real image, not a reused one (and optional OCR match).
  const photo = await verifyPhoto({ imageBase64: req.body.photo, reading: req.body.reading, ocr: OCR_ENABLED });
  if (!photo.ok) return res.status(400).json({ error: photo.error });

  // 3) Pay out, then commit cooldown + burn the photo hash (only on success).
  try {
    const txid = await distributeReward({
      utility:  req.body.utility,
      meterNo:  req.body.meterNo,
      reading:  req.body.reading,
      prevRead: req.body.prevRead,
      amount:   v.amount,
      receiver: req.body.address,
    });
    v.markPaid();
    photo.markUsed();
    res.json({ txid, amount: v.amount });
  } catch (e) {
    console.error("[/reward]", e?.message || e);
    res.status(502).json({ error: e?.message || "distribution failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Reward distributor listening on :${PORT} (${NETWORK})`);
});
