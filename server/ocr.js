// ── Meter-photo OCR — pluggable providers ────────────────────────────────────
// One /ocr entry point that tries several recognisers in order and returns the
// first hit: Roboflow (a meter-trained model), a self-hosted custom service
// (e.g. a YOLOv8 + OCR FastAPI pipeline), and Google Vision. All keys/URLs stay
// server-side; the app falls back to in-browser OCR when every provider misses.

import {
  ROBOFLOW_API_KEY, ROBOFLOW_MODEL, CUSTOM_OCR_URL,
  GOOGLE_VISION_API_KEY, OCR_PROVIDER_ORDER,
} from "./config.js";
import { visionText } from "./vision.js";

// Pull plausible numeric readings out of OCR text (handles , or . decimals).
export function numbersFromText(text) {
  return (String(text || "").match(/\d+(?:[.,]\d+)?/g) || [])
    .map((s) => parseFloat(s.replace(",", ".")))
    .filter((n) => Number.isFinite(n));
}

const available = {
  roboflow: () => !!(ROBOFLOW_API_KEY && ROBOFLOW_MODEL),
  custom:   () => !!CUSTOM_OCR_URL,
  vision:   () => !!GOOGLE_VISION_API_KEY,
};

export function ocrProviders() {
  return OCR_PROVIDER_ORDER.filter((p) => available[p] && available[p]());
}
export function ocrEnabled() {
  return ocrProviders().length > 0;
}

// Roboflow hosted inference: object-detection of digits. Assemble the reading by
// sorting the detected digits left-to-right and concatenating their class labels.
async function roboflowOcr(content) {
  try {
    const res = await fetch(`https://serverless.roboflow.com/${ROBOFLOW_MODEL}?api_key=${ROBOFLOW_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: content,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const preds = data?.predictions;
    if (!Array.isArray(preds) || !preds.length) return null;
    const text = preds
      .filter((p) => (p.confidence ?? 1) >= 0.3)
      .sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
      .map((p) => String(p.class ?? "").replace(/[^0-9.]/g, ""))
      .join("");
    if (!text) return null;
    return { text, numbers: numbersFromText(text) };
  } catch { return null; }
}

// Self-hosted OCR service: POST { image } → { text } and/or { numbers }.
async function customOcr(content) {
  try {
    const res = await fetch(CUSTOM_OCR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: content }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const numbers = Array.isArray(data.numbers) ? data.numbers.map(Number).filter(Number.isFinite) : null;
    const text = data.text || data.reading || (numbers ? numbers.join(" ") : "");
    if (!text && !(numbers && numbers.length)) return null;
    return { text: String(text), numbers: numbers || numbersFromText(text) };
  } catch { return null; }
}

async function visionOcr(content) {
  const text = await visionText(content);
  return text ? { text, numbers: numbersFromText(text) } : null;
}

const RUNNERS = { roboflow: roboflowOcr, custom: customOcr, vision: visionOcr };

// Run the configured providers in order; return the first non-empty result.
export async function ocrImage(imageBase64) {
  const content = String(imageBase64 || "").replace(/^data:[^,]+,/, "");
  if (!content) return { text: "", numbers: [], provider: null };
  for (const p of ocrProviders()) {
    const r = await RUNNERS[p](content).catch(() => null);
    if (r && (r.text || (r.numbers && r.numbers.length))) return { ...r, provider: p };
  }
  return { text: "", numbers: [], provider: null };
}
