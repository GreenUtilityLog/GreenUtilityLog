// ── Server-side photo verification ───────────────────────────────────────────
// The client's photo/OCR checks are a UX pre-filter and can be bypassed, so the
// real anti-farming gate lives here: the server sniffs that the upload is a real
// image, then hashes it and rejects any photo it has paid out for before. One
// photo can only ever earn once — across submissions AND across wallets.

import { createHash } from "node:crypto";
import { store } from "./store.js";

const MIN_BYTES = 5 * 1024;          // reject blank/placeholder images
const MAX_BYTES = 15 * 1024 * 1024;  // 15 MB cap (modern phone photos are big)

// Magic-byte sniff — don't trust the client-declared mime type.
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";  // "GIF"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";                     // "BM"
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return "image/tiff";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // ISO-BMFF (HEIC / HEIF / AVIF): bytes 4..7 spell "ftyp". Only treat it as an
  // image when the major brand (bytes 8..11) is a known image brand — a bare "ftyp"
  // match also accepts MP4/MOV video. Unknown brands fall through to the lenient
  // client-mime path below, so real photos are never rejected by tightening this.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]).toLowerCase();
    const IMAGE_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1", "avif", "avis"]);
    if (IMAGE_BRANDS.has(brand)) return "image/heic";
    return null;
  }
  return null;
}

export async function verifyPhoto({ imageBase64, reading, ocr = false, mime: clientMime = "" } = {}) {
  if (!imageBase64 || typeof imageBase64 !== "string") return { ok: false, error: "photo is required" };

  let buf;
  try { buf = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ""), "base64"); }
  catch { return { ok: false, error: "invalid photo encoding" }; }

  if (buf.length < MIN_BYTES) return { ok: false, error: "photo is too small" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "photo is too large" };

  let mime = sniffImage(buf);
  if (!mime) {
    // Magic-byte sniff missed it. Accept when the client says it's an image and
    // the size is sane — the hash dedupe (and optional AI check) are the real
    // anti-farm guards. Only reject when it's clearly not an image at all.
    if (typeof clientMime === "string" && clientMime.startsWith("image/")) mime = clientMime;
    else return { ok: false, error: "file is not a supported image" };
  }

  const hash = createHash("sha256").update(buf).digest("hex");
  if (store.hasHash(hash)) return { ok: false, error: "duplicate photo — each submission needs a fresh photo" };

  // Reserve the hash NOW, synchronously (no await between hasHash and addHash), so
  // concurrent requests carrying the same photo — even from different wallets or
  // utilities, which the per-`address:utility` in-flight lock doesn't cover — can't
  // all pass the dedupe and pay out. The caller rolls this back via unreserve() if
  // the payout it was reserved for never completes.
  store.addHash(hash);
  const unreserve = () => store.delHash(hash);

  if (ocr) {
    const r = await runOcrCheck(buf, reading).catch(() => ({ ok: true, soft: true }));
    if (!r.ok) { unreserve(); return { ok: false, error: r.error || "the reading was not found in the photo" }; }
  }

  // markUsed is now a no-op (the hash is already reserved) — kept for call-site
  // compatibility. unreserve() releases the reservation on a failed payout.
  return { ok: true, hash, mime, markUsed: () => {}, unreserve };
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
