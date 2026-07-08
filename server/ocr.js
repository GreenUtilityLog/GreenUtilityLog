// ── Meter-photo OCR — pluggable providers ────────────────────────────────────
// One /ocr entry point that tries several recognisers in order and returns the
// first hit: Roboflow (a meter-trained model), a self-hosted custom service
// (e.g. a YOLOv8 + OCR FastAPI pipeline), and Google Vision. All keys/URLs stay
// server-side; the app falls back to in-browser OCR when every provider misses.

import Anthropic from "@anthropic-ai/sdk";
import {
  ROBOFLOW_API_KEY, ROBOFLOW_MODEL, CUSTOM_OCR_URL,
  GOOGLE_VISION_API_KEY, OCR_PROVIDER_ORDER,
} from "./config.js";
import { visionText } from "./vision.js";

// Claude vision as an OCR provider. Reads 7-segment/LCD meter displays far more
// reliably than Tesseract, and needs only ANTHROPIC_API_KEY (the same key that
// powers the photo-authenticity check). Override the model with OCR_CLAUDE_MODEL.
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const OCR_CLAUDE_MODEL = (process.env.OCR_CLAUDE_MODEL || "claude-opus-4-8").trim();
const anthropicClient = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

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
  claude:   () => !!anthropicClient,
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

// Structured output — the model must return exactly this JSON shape.
const CLAUDE_OCR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reading:     { type: "string" },  // the main meter reading, digits as displayed (may include a decimal); "" if none visible
    all_numbers: { type: "array", items: { type: "string" } }, // every other number visible (serials, rates, ...)
    confidence:  { type: "number" },  // 0-1 for the reading
  },
  required: ["reading", "all_numbers", "confidence"],
};

const CLAUDE_OCR_PROMPT = `This photo shows (part of) a utility meter — usually a digital LCD/LED or mechanical counter for electricity, gas or water. Read it carefully.

- "reading" = the METER READING: the main consumption counter, typically the largest/most prominent row of digits (often labelled kWh, m3 or L). Transcribe the digits EXACTLY as displayed, left to right, including leading zeros and the decimal point/comma position if one is marked (use "." as the decimal separator). If the image is too unclear or no reading is visible, use "" and confidence 0.
- "all_numbers" = every other number visible (serial numbers, tariff codes, dates, rates). Do NOT put the reading here.
- Never guess digits you cannot actually see.`;

async function claudeOcr(content) {
  if (!anthropicClient) return null;
  const mediaType = content.startsWith("/9j/") ? "image/jpeg"
    : content.startsWith("iVBOR") ? "image/png"
    : content.startsWith("UklGR") ? "image/webp"
    : content.startsWith("R0lGOD") ? "image/gif"
    : "image/jpeg";
  const resp = await anthropicClient.messages.create({
    model: OCR_CLAUDE_MODEL,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: CLAUDE_OCR_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: content } },
          { type: "text", text: CLAUDE_OCR_PROMPT },
        ],
      },
    ],
  });
  const text = resp.content.find((b) => b.type === "text")?.text || "{}";
  const out = JSON.parse(text);
  const reading = String(out.reading || "").trim();
  if (!reading || Number(out.confidence) <= 0) return null;
  // Reading FIRST so pickMeterReading/autofill prefers it over serials etc.
  const rest = (Array.isArray(out.all_numbers) ? out.all_numbers : []).map(String);
  const all = [reading, ...rest].join(" ");
  return { text: all, numbers: numbersFromText(all) };
}

const RUNNERS = { roboflow: roboflowOcr, custom: customOcr, vision: visionOcr, claude: claudeOcr };

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
