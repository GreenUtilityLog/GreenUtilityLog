// ── AI photo-authenticity check (Claude vision) ──────────────────────────────
// Optional fraud layer: before paying out, ask a Claude vision model whether the
// meter photo looks doctored, re-photographed off a screen, watermarked, or has
// hand-drawn/painted-on numbers. Enabled only when ANTHROPIC_API_KEY is set; the
// key stays server-side and is never sent to the browser. Fails OPEN — if the
// check errors or isn't configured, a submission is allowed through (we never
// block a genuine user because of an infrastructure hiccup).

import Anthropic from "@anthropic-ai/sdk";

const API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
// Default to the most capable model. Set AI_PHOTO_MODEL=claude-haiku-4-5 to trade
// some accuracy for much lower cost per check.
const MODEL = (process.env.AI_PHOTO_MODEL || "claude-opus-4-8").trim();
// Reject a payout only when a "bad" verdict carries at least this confidence.
const MIN_CONFIDENCE = Number(process.env.AI_PHOTO_MIN_CONFIDENCE || "0.6");

const client = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;
export const aiPhotoCheckEnabled = () => !!client;

// Labels that should block a reward when confident enough.
const BAD_LABELS = new Set([
  "doctored_unrealistic",
  "screen_capture",
  "watermarked",
  "handdrawn",
  "multiple_flags",
]);

// Structured-output schema — guarantees the model returns parseable JSON in this
// exact shape (no stray prose), regardless of how it reasons internally.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    evaluation_feasible:         { type: "boolean" },
    doctored_unrealistic_score:  { type: "number" },
    doctored_unrealistic_reasons:{ type: "array", items: { type: "string" } },
    screen_capture_score:        { type: "number" },
    screen_capture_reasons:      { type: "array", items: { type: "string" } },
    watermark_score:             { type: "number" },
    watermark_reasons:           { type: "array", items: { type: "string" } },
    watermark_text:              { type: "string" },
    painted_text_score:          { type: "number" },
    painted_text_reasons:        { type: "array", items: { type: "string" } },
    final_label: {
      type: "string",
      enum: ["clean", "doctored_unrealistic", "screen_capture", "watermarked", "handdrawn", "multiple_flags", "inconclusive"],
    },
    final_confidence:            { type: "number" },
  },
  required: [
    "evaluation_feasible",
    "doctored_unrealistic_score", "doctored_unrealistic_reasons",
    "screen_capture_score", "screen_capture_reasons",
    "watermark_score", "watermark_reasons", "watermark_text",
    "painted_text_score", "painted_text_reasons",
    "final_label", "final_confidence",
  ],
};

const PROMPT = `You are checking a photo a user submitted as proof of a utility-meter reading, to detect reward fraud. Evaluate it through multiple analytical stages.

Objective — determine:
1. If the photo has been doctored or altered in an unrealistic way.
2. If the photo was taken from a computer/phone screen rather than a real-world capture of an actual meter.
3. If the photo contains visible or partially obscured watermarks (stock imagery / ownership overlays).
4. If numbers/text were hand-drawn or painted onto the image.

Progress through the stages in sequence and reason about each before deciding.

STAGE 1 — Quick Triage (visibility & quality): Is the content visible and in focus enough to evaluate? Heavy obstructions, extreme blur, tiny resolution? If evaluation is not feasible, set evaluation_feasible=false.

STAGE 2 — Doctored / Unrealistic screening: inconsistent shadows/reflections, mismatched perspective, warped lines near edits, plastic/smeared textures, halos or cut-out borders, localized compression shifts suggesting pasted regions, lighting/color-temperature mismatches, deformed text/logos, impossible scale combinations.

STAGE 3 — Photo-of-a-Screen screening: visible pixel grid/subpixels, scanlines, refresh/PWM banding, moiré; device bezels/notch/status bar/cursor/taskbar/scrollbars; rectangular glare, Newton rings, rainbowing on glass; focus on a flat screen surface; keystone perspective of a monitor; uniform backlight glow or overly blue/green whites.

STAGE 4 — Watermark / overlay detection: semi-transparent stock text/logos ("Getty Images", "Shutterstock", "Adobe Stock", creator handles), diagonal repeating patterns, corner logos, composited date/time stamps. Distinguish legitimate camera-UI overlays (e.g. a timestamp) from stock watermarks. If a watermark is present, note its content in watermark_text if legible (do NOT identify a person).

STAGE 5 — Hand-drawn / painted-on text: uneven non-font handwriting, brush strokes/smudging/pen artifacts in the digits, text blending poorly with the background or overlapping objects unnaturally, resolution mismatch between the text and the rest of the image.

STAGE 6 — Final decision: set final_label to one of "clean", "doctored_unrealistic", "screen_capture", "watermarked", "handdrawn", "multiple_flags", or "inconclusive", and final_confidence (0-1). Each score is 0-1 (higher = more suspicious). Cite only visible cues in the reasons arrays; keep them short. A normal, genuine photo of a physical meter should be "clean".`;

// Detect media type + strip a data: URL wrapper, returning clean base64.
function splitImage(b64) {
  if (!b64 || typeof b64 !== "string") return null;
  const m = /^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/s.exec(b64.trim());
  let mediaType, data;
  if (m) { mediaType = m[1]; data = m[2]; }
  else { data = b64; mediaType = sniff(b64); }
  data = data.replace(/\s+/g, ""); // base64 must contain no whitespace/newlines
  if (!data) return null;
  return { mediaType, data };
}
function sniff(b64) {
  if (b64.startsWith("/9j/"))   return "image/jpeg";
  if (b64.startsWith("iVBOR"))  return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR"))  return "image/webp";
  return "image/jpeg";
}

// Returns { ok, verdict?, reason?, skipped?, error? }. ok=false means reject the payout.
export async function checkPhotoAuthenticity(imageBase64) {
  if (!client) return { ok: true, skipped: true };
  const img = splitImage(imageBase64);
  if (!img) return { ok: true, skipped: true };

  let verdict;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // Let the model reason through the stages internally, then emit only JSON.
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    const text = resp.content.find((b) => b.type === "text")?.text || "{}";
    verdict = JSON.parse(text);
  } catch (e) {
    // Fail open — never block a legitimate user because the AI call failed.
    console.warn(`[authenticity] check failed, allowing submission: ${e?.message || e}`);
    return { ok: true, error: String(e?.message || e) };
  }

  const label = verdict?.final_label;
  const conf = Number(verdict?.final_confidence || 0);
  const flagged = BAD_LABELS.has(label) && conf >= MIN_CONFIDENCE;
  return {
    ok: !flagged,
    verdict,
    reason: flagged ? `image looks like "${label}" (confidence ${conf.toFixed(2)})` : undefined,
  };
}
