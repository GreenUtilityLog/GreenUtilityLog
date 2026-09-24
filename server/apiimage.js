// ── Getting a photo into a shape a vision API accepts ────────────────────────
// Claude takes JPEG, PNG, GIF or WebP up to 5 MB. A phone photo is often larger,
// or HEIC. Both the authenticity check and the OCR provider send photos there, and
// a photo the API refuses is not a photo that passed — so it is re-encoded first.

const API_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const API_MAX_BYTES = 5 * 1024 * 1024;

function sniff(b64) {
  if (b64.startsWith("/9j/"))   return "image/jpeg";
  if (b64.startsWith("iVBOR"))  return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR"))  return "image/webp";
  return "";
}

// Returns { mediaType, data } (base64) or null when it cannot be made acceptable.
// 1568 px on the long side is what the API scales images to anyway.
export async function toApiImage(imageBase64, detectedMime = "") {
  const data = String(imageBase64 || "").replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  if (!data) return null;
  const buf = Buffer.from(data, "base64");
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf).rotate()
      .resize(1568, 1568, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { mediaType: "image/jpeg", data: out.toString("base64") };
  } catch { /* sharp missing, or a format it cannot decode */ }
  const mediaType = detectedMime || sniff(data);
  if (API_TYPES.has(mediaType) && buf.length <= API_MAX_BYTES) return { mediaType, data };
  return null;
}
