// ── Optional photo archive (Cloudflare R2 or Upstash Redis) ──────────────────
// The reward flow only ever needs a photo's *hash* (anti-reuse). This module is a
// separate, OPT-IN archive so an admin can later eyeball the actual photo behind a
// payout to spot farmers. It is deliberately decoupled:
//   • Disabled unless a backend is configured → the service runs exactly as before.
//   • Storing/reading/deleting never blocks or breaks a payout (callers fire-and-
//     forget the save and swallow errors).
//   • Photos are downscaled to a thumbnail before upload (≈80 KB vs multi-MB).
//
// Two backends, picked automatically (R2 wins when both are set):
//   1) CLOUDFLARE R2 (big, needs a card to activate — free ≤10 GB):
//        R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//      Retention is enforced by the store.js index + the sweep in index.js.
//   2) UPSTASH REDIS (no card; smaller — free ≤256 MB, ~a few thousand thumbs):
//        UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (same vars store.js uses,
//        so if durable state already runs on Upstash, photos work with ZERO new
//        config). Retention is a native Redis TTL — each thumbnail self-expires.
//
// `sharp` (thumbnailing) and `aws4fetch` (R2 signing) are optionalDependencies — if
// missing the archive degrades gracefully (stores originals / disables R2), never a
// crash. sharp matters most for the Upstash backend, whose per-request size is tight.

const R2_ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || "").trim();
const R2_ACCESS_KEY = (process.env.R2_ACCESS_KEY_ID || "").trim();
const R2_SECRET_KEY = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
const R2_BUCKET     = (process.env.R2_BUCKET || "").trim();
const PREFIX        = (process.env.R2_PREFIX || "photos").trim().replace(/^\/+|\/+$/g, "");
const R2_ON = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET);

const U_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const U_TOK = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const U_ON  = !!(U_URL && U_TOK);

// R2 wins when both are configured (larger, purpose-built for blobs).
const BACKEND = R2_ON ? "r2" : (U_ON ? "upstash" : null);

const RETENTION_DAYS = Number(process.env.PHOTO_RETENTION_DAYS || 30);
const RETENTION_SEC = Math.max(0, RETENTION_DAYS) * 24 * 60 * 60;
// Upstash free tier caps a single request; keep a thumbnail comfortably under 1 MB.
const UPSTASH_MAX_BYTES = 900 * 1024;

// True when a backend is configured (and, for R2, its signer can load).
export function photoStoreEnabled() {
  if (BACKEND === "upstash") return true;
  if (BACKEND === "r2") return _r2client !== false;
  return false;
}

// Sanitise the payout txID into a safe object key / redis key fragment.
function safeId(id) {
  // Lowercased: the retention index in store.js keys on a lowercased txid, and a
  // txid that arrives capitalised from one path and lowercase from another would
  // otherwise store and look up under two different keys.
  return String(id || "").replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "").toLowerCase().slice(0, 96);
}

// Downscale to a JPEG thumbnail. Uses sharp when available; if not, returns the
// original bytes so R2 still works (Upstash may reject an oversized original).
// `rotate()` honours EXIF orientation so portrait phone shots aren't stored sideways.
async function thumbnail(buf, mime) {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf).rotate()
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { buf: out, mime: "image/jpeg" };
  } catch {
    return { buf, mime: mime || "image/jpeg" };
  }
}

// ── Cloudflare R2 backend (S3 API via aws4fetch) ─────────────────────────────
let _r2client = null; // AwsClient, or false once we know aws4fetch is unavailable
async function r2client() {
  if (_r2client !== null) return _r2client || null;
  try {
    const { AwsClient } = await import("aws4fetch");
    _r2client = new AwsClient({ accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY, region: "auto", service: "s3" });
    return _r2client;
  } catch (e) {
    console.error("[photostore] aws4fetch missing — R2 disabled:", e?.message || e);
    _r2client = false;
    return null;
  }
}
const r2url = (id) => `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${PREFIX}/${safeId(id)}.jpg`;

async function r2Put(id, buf, mime) {
  const c = await r2client();
  if (!c) return false;
  const res = await c.fetch(r2url(id), { method: "PUT", body: buf, headers: { "Content-Type": mime || "image/jpeg" } });
  if (!res.ok) { console.error("[photostore] R2 put failed", res.status); return false; }
  return true;
}
async function r2Get(id) {
  const c = await r2client();
  if (!c) return null;
  const res = await c.fetch(r2url(id), { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) { console.error("[photostore] R2 get failed", res.status); return null; }
  const mime = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString("base64")}`;
}
async function r2Del(id) {
  const c = await r2client();
  if (!c) return false;
  const res = await c.fetch(r2url(id), { method: "DELETE" });
  return res.ok || res.status === 404;
}

// ── Upstash Redis backend (REST) ─────────────────────────────────────────────
async function upstashCmd(cmd) {
  const res = await fetch(U_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${U_TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return (await res.json()).result;
}
const ukey = (id) => `photo:${safeId(id)}`;

async function uPut(id, buf, mime) {
  const dataUrl = `data:${mime || "image/jpeg"};base64,${buf.toString("base64")}`;
  if (dataUrl.length > UPSTASH_MAX_BYTES) {
    console.error("[photostore] thumbnail too large for Upstash (install sharp / lower quality)");
    return false;
  }
  const cmd = RETENTION_SEC > 0 ? ["SET", ukey(id), dataUrl, "EX", String(RETENTION_SEC)] : ["SET", ukey(id), dataUrl];
  const r = await upstashCmd(cmd);
  return r === "OK" || r === true;
}
async function uGet(id) {
  const r = await upstashCmd(["GET", ukey(id)]);
  return r || null;
}
async function uDel(id) {
  await upstashCmd(["DEL", ukey(id)]);
  return true;
}

// ── Public API (dispatches to the active backend) ────────────────────────────
// Store a photo under the payout id. Best-effort: returns true/false, never throws.
export async function putPhoto(id, imageBase64, mime) {
  if (!BACKEND || !id || !imageBase64) return false;
  try {
    const raw = Buffer.from(String(imageBase64).replace(/^data:[^,]+,/, ""), "base64");
    const thumb = await thumbnail(raw, mime);
    if (BACKEND === "r2") return await r2Put(id, thumb.buf, thumb.mime);
    if (BACKEND === "upstash") return await uPut(id, thumb.buf, thumb.mime);
    return false;
  } catch (e) {
    console.error("[photostore] put error:", e?.message || e);
    return false;
  }
}

// Fetch a photo as a data URL (for inline display in admin). null when absent.
export async function getPhotoDataUrl(id) {
  if (!BACKEND || !id) return null;
  try {
    if (BACKEND === "r2") return await r2Get(id);
    if (BACKEND === "upstash") return await uGet(id);
    return null;
  } catch (e) {
    console.error("[photostore] get error:", e?.message || e);
    return null;
  }
}

// Delete one photo. Returns true when the backend accepted it (or it was absent).
export async function deletePhoto(id) {
  if (!BACKEND || !id) return false;
  try {
    if (BACKEND === "r2") return await r2Del(id);
    if (BACKEND === "upstash") return await uDel(id);
    return false;
  } catch (e) {
    console.error("[photostore] delete error:", e?.message || e);
    return false;
  }
}
