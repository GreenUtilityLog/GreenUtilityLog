// ── EXIF date extraction (no dependencies) ───────────────────────────────────
// The point is narrow: a photo grabbed off the internet, or an old one from the
// camera roll, is not today's meter reading. A phone photo carries the moment it
// was taken in EXIF; a downloaded or re-saved image usually carries nothing, and a
// screenshot is normally a PNG with no EXIF at all.
//
// Deliberately NOT a "no EXIF means fraud" test. Plenty of honest uploads lose EXIF
// — some share sheets and browsers strip it, PNG has no EXIF field at all — and
// blocking on its absence would punish real users, the same mistake as blocking on
// an unreadable meter serial. Absence is reported so it can be flagged; only a date
// that is clearly stale is grounds to refuse.
//
// Parses just enough of the JPEG/TIFF structure to find one tag. EXIF lives in the
// APP1 segment; DateTimeOriginal (0x9003) sits in the Exif sub-IFD (0x8769), with
// DateTime (0x0132) in IFD0 as a fallback.

const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME          = 0x0132;
const TAG_EXIF_IFD_POINTER  = 0x8769;

// "YYYY:MM:DD HH:MM:SS" — EXIF's own format. Read as local time, which is what the
// camera recorded; we only ever compare it as an age, so a few hours of timezone
// slack is irrelevant next to the thresholds this feeds.
function parseExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  // EXIF writes 0000:00:00 when the camera had no clock set.
  if (!y || !mo || !d) return null;
  const t = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isFinite(t) ? t : null;
}

function readIfd(buf, tiffStart, ifdOffset, little, want, depth = 0) {
  // A malformed or hostile file must not send us looping through pointers.
  if (depth > 2) return null;
  const at = tiffStart + ifdOffset;
  if (at < 0 || at + 2 > buf.length) return null;

  const count = little ? buf.readUInt16LE(at) : buf.readUInt16BE(at);
  // 12 bytes per entry; a count that doesn't fit the file is a broken header.
  if (count > 512 || at + 2 + count * 12 > buf.length) return null;

  let subIfd = null;
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    const tag = little ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
    const type = little ? buf.readUInt16LE(e + 2) : buf.readUInt16BE(e + 2);
    const num = little ? buf.readUInt32LE(e + 4) : buf.readUInt32BE(e + 4);
    const valOff = little ? buf.readUInt32LE(e + 8) : buf.readUInt32BE(e + 8);

    if (tag === TAG_EXIF_IFD_POINTER && type === 4) subIfd = valOff;

    if (tag === want && type === 2 && num >= 19) {
      // ASCII longer than 4 bytes is stored out of line, at valOff from the TIFF header.
      const s = tiffStart + valOff;
      if (s < 0 || s + 19 > buf.length) return null;
      return buf.toString("ascii", s, s + 19);
    }
  }
  // Not in this IFD — follow the Exif sub-IFD, which is where DateTimeOriginal lives.
  if (subIfd != null) return readIfd(buf, tiffStart, subIfd, little, want, depth + 1);
  return null;
}

// Returns { taken: epochMs|null, hasExif: boolean }. Never throws: a photo we cannot
// parse is reported as "no EXIF", which is a flag, not a rejection.
export function exifTakenAt(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return { taken: null, hasExif: false };
    // JPEG only. PNG/WebP screenshots carry no EXIF date worth trusting.
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return { taken: null, hasExif: false };

    let p = 2;
    while (p + 4 <= buf.length) {
      if (buf[p] !== 0xff) break;
      const marker = buf[p + 1];
      if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
      const len = buf.readUInt16BE(p + 2);
      if (len < 2 || p + 2 + len > buf.length) break;

      if (marker === 0xe1 && buf.toString("ascii", p + 4, p + 10) === "Exif\0\0") {
        const tiff = p + 10;
        if (tiff + 8 > buf.length) return { taken: null, hasExif: false };
        const bom = buf.toString("ascii", tiff, tiff + 2);
        if (bom !== "II" && bom !== "MM") return { taken: null, hasExif: false };
        const little = bom === "II";
        const ifd0 = little ? buf.readUInt32LE(tiff + 4) : buf.readUInt32BE(tiff + 4);
        const s = readIfd(buf, tiff, ifd0, little, TAG_DATETIME_ORIGINAL)
               || readIfd(buf, tiff, ifd0, little, TAG_DATETIME);
        return { taken: parseExifDate(s), hasExif: true };
      }
      p += 2 + len;
    }
    return { taken: null, hasExif: false };
  } catch {
    return { taken: null, hasExif: false };
  }
}
