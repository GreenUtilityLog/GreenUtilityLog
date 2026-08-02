// ── Optional photo archive (Cloudflare R2) ───────────────────────────────────
// The reward flow only ever needs a photo's *hash* (anti-reuse). This module is a
// separate, OPT-IN archive so an admin can later eyeball the actual photo behind a
// payout to spot farmers. It is deliberately decoupled:
//   • Disabled unless R2 credentials are set → the service runs exactly as before.
//   • Storing/reading/deleting never blocks or breaks a payout (callers fire-and-
//     forget the save and swallow errors).
//   • Photos are downscaled to a thumbnail before upload (≈80 KB vs multi-MB), so
//     the free R2 tier (10 GB) holds ~100k+ of them.
//   • Retention is enforced by store.js pruning + a sweep in index.js; nothing here
//     keeps a photo alive.
//
// Set in the host env to enable:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Both `sharp` (thumbnailing) and `aws4fetch` (S3 signing) are optionalDependencies
// — if either is missing the archive just no-ops (or stores the original bytes),
// never a crash.

const ACCOUNT_ID = (process.env.R2_ACCOUNT_ID || "").trim();
const ACCESS_KEY = (process.env.R2_ACCESS_KEY_ID || "").trim();
const SECRET_KEY = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
const BUCKET     = (process.env.R2_BUCKET || "").trim();
const PREFIX     = (process.env.R2_PREFIX || "photos").trim().replace(/^\/+|\/+$/g, "");

const CONFIGURED = !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && BUCKET);

let _client = null;      // cached AwsClient (or false once we know it's unavailable)
async function client() {
  if (_client !== null) return _client || null;
  if (!CONFIGURED) { _client = false; return null; }
  try {
    const { AwsClient } = await import("aws4fetch");
    _client = new AwsClient({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: "auto", service: "s3" });
    return _client;
  } catch (e) {
    console.error("[photostore] aws4fetch missing — archive disabled:", e?.message || e);
    _client = false;
    return null;
  }
}

// True only when creds are set AND the S3 client can load. Cheap check for callers
// that just want the flag (falls back to "configured" before the client is warmed).
export function photoStoreEnabled() {
  return CONFIGURED && _client !== false;
}

function keyFor(id) {
  // id is the payout txID (matches the on-chain history row's txHash). Strip 0x and
  // anything non-hex so it can never escape the prefix.
  const safe = String(id || "").replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "").slice(0, 96);
  return `${PREFIX}/${safe}.jpg`;
}
function urlFor(id) {
  return `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${keyFor(id)}`;
}

// Downscale to a JPEG thumbnail. Uses sharp when available; if not, returns the
// original bytes so the archive still works (just larger). `rotate()` honours EXIF
// orientation so portrait phone shots aren't stored sideways.
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

// Store a photo under the payout id. Best-effort: returns true/false, never throws.
export async function putPhoto(id, imageBase64, mime) {
  const c = await client();
  if (!c || !id || !imageBase64) return false;
  try {
    const raw = Buffer.from(String(imageBase64).replace(/^data:[^,]+,/, ""), "base64");
    const thumb = await thumbnail(raw, mime);
    const res = await c.fetch(urlFor(id), {
      method: "PUT",
      body: thumb.buf,
      headers: { "Content-Type": thumb.mime || "image/jpeg" },
    });
    if (!res.ok) { console.error("[photostore] put failed", res.status); return false; }
    return true;
  } catch (e) {
    console.error("[photostore] put error:", e?.message || e);
    return false;
  }
}

// Fetch a photo as a data URL (for inline display in admin). null when absent.
export async function getPhotoDataUrl(id) {
  const c = await client();
  if (!c || !id) return null;
  try {
    const res = await c.fetch(urlFor(id), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) { console.error("[photostore] get failed", res.status); return null; }
    const mime = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (e) {
    console.error("[photostore] get error:", e?.message || e);
    return null;
  }
}

// Delete one photo. Returns true when R2 accepted the delete (or it was absent).
export async function deletePhoto(id) {
  const c = await client();
  if (!c || !id) return false;
  try {
    const res = await c.fetch(urlFor(id), { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch (e) {
    console.error("[photostore] delete error:", e?.message || e);
    return false;
  }
}
