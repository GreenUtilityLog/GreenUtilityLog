// ── Google Cloud Vision OCR ──────────────────────────────────────────────────
// Reads meter photos far more reliably than in-browser Tesseract. Called by the
// /ocr endpoint; the API key stays server-side. Uses the REST API (no SDK needed)
// so it runs on any Node 18+ host with global fetch.

import { GOOGLE_VISION_API_KEY } from "./config.js";

export function visionEnabled() {
  return !!GOOGLE_VISION_API_KEY;
}

// OCR an image (base64, with or without a data: prefix). Returns the full detected
// text, or "" on any failure so the caller can fall back to in-browser OCR.
export async function visionText(imageBase64) {
  if (!GOOGLE_VISION_API_KEY) return "";
  const content = String(imageBase64 || "").replace(/^data:[^,]+,/, "");
  if (!content) return "";
  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ image: { content }, features: [{ type: "TEXT_DETECTION" }] }],
        }),
      }
    );
    if (!res.ok) return "";
    const data = await res.json().catch(() => null);
    const r = data?.responses?.[0];
    return r?.fullTextAnnotation?.text || r?.textAnnotations?.[0]?.description || "";
  } catch {
    return "";
  }
}

// Pull plausible numeric readings out of OCR text (handles , or . decimals).
export function numbersFromText(text) {
  return (String(text || "").match(/\d+(?:[.,]\d+)?/g) || [])
    .map((s) => parseFloat(s.replace(",", ".")))
    .filter((n) => Number.isFinite(n));
}
