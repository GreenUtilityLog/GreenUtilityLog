// ── Server-side photo verification ───────────────────────────────────────────
// The client's photo/OCR checks are a UX pre-filter and can be bypassed, so the
// real anti-farming gate lives here: the server sniffs that the upload is a real
// image, then hashes it and rejects any photo it has paid out for before. One
// photo can only ever earn once — across submissions AND across wallets.

import { createHash } from "node:crypto";
import { store } from "./store.js";
import { exifTakenAt } from "./exif.js";

// How old a photo may be, when it tells us. Generous on purpose: the point is to
// refuse stock images and old camera-roll shots, not to police a day's delay.
const PHOTO_MAX_AGE_DAYS = Number(process.env.PHOTO_MAX_AGE_DAYS || 7);
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

// `registers` holds the individual numbers the reading was built from, when there is
// more than one. A double-tariff meter keeps two (1.8.1 low, 1.8.2 normal) and cycles
// its display, so a photo shows ONE of them and their sum — the figure that is
// actually the consumption — appears nowhere on the meter. Matching the photo against
// the sum was therefore unsatisfiable by design; it is matched against the parts too.
export async function verifyPhoto({ imageBase64, reading, registers = [], ocr = false, mime: clientMime = "" } = {}) {
  if (!imageBase64 || typeof imageBase64 !== "string") return { ok: false, error: "photo is required" };

  let buf;
  try { buf = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ""), "base64"); }
  catch { return { ok: false, error: "invalid photo encoding" }; }

  if (buf.length < MIN_BYTES) return { ok: false, error: "photo is too small" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "photo is too large" };

  // Require a genuinely decodable image by its magic bytes. We do NOT trust the
  // client-declared mime as a fallback: when the AI/OCR checks are off, that fallback
  // let 5 KB of random bytes labelled "image/png" pass and (since every random blob
  // hashes uniquely) sail through the dedupe. Magic-byte sniff covers every real
  // phone-photo format (JPEG/PNG/GIF/BMP/TIFF/WebP/HEIC), so a miss means "not a photo".
  const mime = sniffImage(buf);
  if (!mime) return { ok: false, error: "file is not a recognised image — please take a real photo" };

  // When the photo says when it was taken, it has to be recent. This is the cheapest
  // block on the laziest fraud — a meter photo pulled off the internet is either
  // years old or carries no EXIF at all — and it needs no API key, unlike the AI
  // authenticity check. Checked BEFORE the hash is reserved, so a refusal doesn't
  // burn a hash the user might legitimately need.
  //
  // Only a clearly stale date refuses. A MISSING date does not: plenty of honest
  // uploads lose EXIF (share sheets strip it, PNG has no such field), and blocking
  // on absence would punish real users. That case is reported for flagging instead.
  const exif = exifTakenAt(buf);
  if (exif.taken != null) {
    const ageDays = (Date.now() - exif.taken) / 86400000;
    if (ageDays > PHOTO_MAX_AGE_DAYS) {
      return { ok: false, error: `this photo was taken ${Math.round(ageDays)} days ago — please take a fresh one` };
    }
    // A date in the future is a wrong clock or a crafted file; allow a day of slack.
    if (ageDays < -1) {
      return { ok: false, error: "this photo's date is in the future — check your device clock" };
    }
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

  let ocrMatched = null;
  if (ocr) {
    const r = await runOcrCheck(buf, reading, registers).catch(() => ({ ok: true, soft: true }));
    if (!r.ok) { unreserve(); return { ok: false, error: r.error || "the reading was not found in the photo" }; }
    ocrMatched = r.matched ?? null;
  }

  // markUsed is now a no-op (the hash is already reserved) — kept for call-site
  // compatibility. unreserve() releases the reservation on a failed payout.
  return { ok: true, hash, mime, exif, ocrMatched, markUsed: () => {}, unreserve };
}

// Best-effort OCR via tesseract.js (lazy-loaded so the service runs without it).
// Lenient by design: only a confident mismatch rejects; OCR failures pass.
async function runOcrCheck(buf, reading, registers = []) {
  let createWorker;
  try { ({ createWorker } = await import("tesseract.js")); }
  catch { return { ok: true, soft: true }; } // dependency not installed -> skip

  // The photo has to corroborate ONE of these. The total is checked first because on
  // a single-register meter it is the only candidate and it is what the display
  // shows; on a double-tariff meter the display never shows it, and one of the parts
  // will match instead. Which one matched is reported so the caller can record that a
  // submission was corroborated by a part rather than by the figure being paid on.
  const candidates = [reading, ...(Array.isArray(registers) ? registers : [])]
    .map((v) => String(v ?? "").replace(/[^0-9]/g, ""))
    .filter((d) => d.length >= 3);
  // Nothing long enough to look for. This used to PASS — which made "type a reading
  // of 2 digits" a way round the check. When OCR is on, a reading it cannot check is
  // refused instead; real meter totals have more digits than this.
  if (!candidates.length) return { ok: false, error: "that reading is too short to check against the photo — enter the full meter total" };

  // errorHandler: without one, tesseract re-throws a failed job (e.g. language data
  // that cannot be downloaded) as an uncaught error and takes the whole server down.
  const worker = await createWorker("eng", 1, { errorHandler: (e) => console.error("[ocr] tesseract:", e?.message || e) });
  try {
    await worker.setParameters({ tessedit_char_whitelist: "0123456789." });
    const { data } = await worker.recognize(buf);
    const seen = (data.text || "").replace(/[^0-9]/g, "");
    for (let i = 0; i < candidates.length; i++) {
      const needle = candidates[i].slice(0, Math.min(candidates[i].length, 6));
      if (seen.includes(needle)) return { ok: true, matched: i === 0 ? "total" : `register ${i}` };
    }
    return { ok: false, error: "meter reading not found in photo" };
  } finally {
    await worker.terminate();
  }
}

// ── Is the reading that was typed actually on the photo? ──────────────────────
// Without this the reading is whatever the submitter types, and the photo only
// proves that SOME meter was photographed: type yesterday's number again and it is
// "zero usage", the maximum payout, every day. With an OCR provider configured
// (ANTHROPIC_API_KEY, Google Vision, Roboflow or a custom service) the server reads
// the photo itself and the reading has to be there.
//
// READING_CHECK=strict (default when a provider is configured) refuses a mismatch;
// =flag pays and records it for review; =off skips it.
export function readingCheckMode(providersConfigured) {
  const m = String(process.env.READING_CHECK || "").trim().toLowerCase();
  if (m === "off" || m === "flag" || m === "strict") return providersConfigured ? m : "off";
  return providersConfigured ? "strict" : "off";
}

// Does `claimed` appear among the numbers read off the photo? Tolerance is ONE
// unit, not a percentage: a percentage of a meter total is hundreds of kWh, which
// is exactly the room a lower-than-true reading needs. The second rule covers a
// display whose decimal point the OCR did not see (12345.6 read as 123456): the
// same leading digits with at most three more. That cannot be used to understate,
// because the reading still has to be above the stored baseline.
export function readingOnPhoto(claimed, numbers) {
  const c = Number(claimed);
  if (!Number.isFinite(c) || c < 0) return false;
  const nums = (numbers || []).map(Number).filter(Number.isFinite);
  if (nums.some((n) => Math.abs(n - c) <= 1)) return true;
  const head = String(Math.floor(c));
  if (head.length < 3) return false;
  return nums.some((n) => {
    const d = String(Math.floor(n));
    return d.startsWith(head) && d.length > head.length && d.length - head.length <= 3;
  });
}

// { ok, matched?, seen?, unavailable?, error? }. `registers` are the tariff parts of
// a summed reading; the display shows one at a time, so any one of them counts.
export async function checkReadingOnPhoto({ imageBase64, reading, registers = [], ocrImage }) {
  const unavailable = { ok: false, unavailable: true, error: "the meter reading could not be checked right now — nothing was used up, please try again in a few minutes" };
  let r;
  try { r = await ocrImage(imageBase64); }
  catch { return unavailable; }
  if (r?.errored) return unavailable;
  const numbers = r?.numbers || [];
  if (!numbers.length) {
    return { ok: false, error: "the meter's numbers could not be read on this photo — take a sharper photo, straight on, with the display filling most of the picture" };
  }
  const candidates = [reading, ...(Array.isArray(registers) ? registers : [])];
  const hit = candidates.findIndex((v) => readingOnPhoto(v, numbers));
  if (hit >= 0) return { ok: true, matched: hit === 0 ? "total" : `register ${hit}`, seen: numbers.slice(0, 6) };
  return {
    ok: false,
    seen: numbers.slice(0, 6),
    error: `the reading you entered (${reading}) is not what the photo shows${numbers.length ? ` (it reads ${numbers.slice(0, 3).join(", ")})` : ""} — check the number and try again`,
  };
}
