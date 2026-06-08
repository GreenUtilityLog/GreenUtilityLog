// ── Server-side photo verification ───────────────────────────────────────────
// The client's photo/OCR checks are a UX pre-filter and can be bypassed, so the
// real anti-farming gate lives here: the server sniffs that the upload is a real
// image, then hashes it and rejects any photo it has paid out for before. One
// photo can only ever earn once — across submissions AND across wallets.

import { createHash } from "node:crypto";

const MIN_BYTES = 5 * 1024;          // reject blank/placeholder images
const MAX_BYTES = 12 * 1024 * 1024;  // 12 MB cap

// Magic-byte sniff — don't trust the client-declared mime type.
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // HEIC/HEIF: bytes 4..7 spell "ftyp"
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "image/heic";
  return null;
}

// Hashes of photos already paid out. NOTE: in-memory — back with Redis/DB in
// production so it survives restarts and is shared across instances.
const usedHashes = new Set();

export async function verifyPhoto({ imageBase64, reading, ocr = false } = {}) {
  if (!imageBase64 || typeof imageBase64 !== "string") return { ok: false, error: "photo is required" };

  let buf;
  try { buf = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ""), "base64"); }
  catch { return { ok: false, error: "invalid photo encoding" }; }

  if (buf.length < MIN_BYTES) return { ok: false, error: "photo is too small" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "photo is too large" };

  const mime = sniffImage(buf);
  if (!mime) return { ok: false, error: "file is not a supported image" };

  const hash = createHash("sha256").update(buf).digest("hex");
  if (usedHashes.has(hash)) return { ok: false, error: "duplicate photo — each submission needs a fresh photo" };

  if (ocr) {
    const r = await runOcrCheck(buf, reading).catch(() => ({ ok: true, soft: true }));
    if (!r.ok) return { ok: false, error: r.error || "the reading was not found in the photo" };
  }

  return { ok: true, hash, mime, markUsed: () => usedHashes.add(hash) };
}

// Best-effort OCR via tesseract.js (lazy-loaded so the service runs without it).
// Lenient by design: only a confident mismatch rejects; OCR failures pass.
async function runOcrCheck(buf, reading) {
  let createWorker;
  try { ({ createWorker } = await import("tesseract.js")); }
  catch { return { ok: true, soft: true }; } // dependency not installed -> skip

  const worker = await createWorker("eng");
  try {
    await worker.setParameters({ tessedit_char_whitelist: "0123456789." });
    const { data } = await worker.recognize(buf);
    const seen = (data.text || "").replace(/[^0-9]/g, "");
    const target = String(reading ?? "").replace(/[^0-9]/g, "");
    if (target.length < 3) return { ok: true }; // too short to match reliably
    const needle = target.slice(0, Math.min(target.length, 6));
    return seen.includes(needle) ? { ok: true } : { ok: false, error: "meter reading not found in photo" };
  } finally {
    await worker.terminate();
  }
}
