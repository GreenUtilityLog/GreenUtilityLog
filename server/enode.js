// ── Enode adapter (optional, global smart-meter source) ──────────────────────
// Enode (https://enode.com) is a B2B aggregator: one API in front of 1000+ energy
// brands across Europe/US/world. We use it as ONE source of a meter reading — the
// value still flows through the same /reward validation as a photographed reading.
//
// Enabled only when ENODE_CLIENT_ID + ENODE_CLIENT_SECRET are set (like the OCR
// key gates OCR). Absent → the app just shows the free push-ingestion path instead.
//
// IMPORTANT / honest notes:
//   • The SANDBOX (default) returns SIMULATED devices — good for wiring the flow,
//     but you cannot link a real meter there. Real meters need PRODUCTION creds
//     (a paid Enode contract) and Enode's meter product is still BETA + region-
//     dependent, so coverage for a given DSO/brand is not guaranteed.
//   • Enode's meter response schema is not fully pinned here; /meter/enode/sync
//     returns the raw object so the exact reading field can be locked down against
//     a live account, then `pickReading()` tightened. Until then it probes the
//     most likely fields and falls back to returning raw for inspection.

const ENV      = (process.env.ENODE_ENV || "sandbox").toLowerCase() === "production" ? "production" : "sandbox";
const CLIENT   = (process.env.ENODE_CLIENT_ID || "").trim();
const SECRET   = (process.env.ENODE_CLIENT_SECRET || "").trim();
const OAUTH_URL = (process.env.ENODE_OAUTH_URL || `https://oauth.${ENV}.enode.io/oauth2/token`).trim();
const API_BASE  = (process.env.ENODE_API_URL  || `https://enode-api.${ENV}.enode.io`).trim().replace(/\/$/, "");
// Where Enode returns the user after they finish linking in the vendor UI.
const REDIRECT  = (process.env.ENODE_REDIRECT_URI || "https://greenutilitylog.github.io/GreenUtilityLog/").trim();

export function enodeEnabled() {
  return !!(CLIENT && SECRET);
}

export function enodeInfo() {
  return { enabled: enodeEnabled(), env: ENV };
}

// Cache the client-credentials access token until shortly before it expires.
let _tok = null; // { access_token, exp }
async function accessToken() {
  const now = Date.now();
  if (_tok && _tok.exp - 30_000 > now) return _tok.access_token;
  const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString("base64");
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`enode auth ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  _tok = { access_token: j.access_token, exp: now + (Number(j.expires_in || 3600) * 1000) };
  return _tok.access_token;
}

async function api(path, opts = {}) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`enode ${opts.method || "GET"} ${path} ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

// We key Enode users by the wallet address, so a wallet always maps to the same
// linked meter(s). Enode userIds are arbitrary strings the integrator chooses.
const userId = (addr) => `wallet-${String(addr).toLowerCase()}`;

// Create a Link session so the user authorises their utility/meter to Enode.
// Returns { linkUrl, ... } — the app opens linkUrl; Enode sends them back to REDIRECT.
export async function createMeterLink(address) {
  const body = {
    vendorType: "meter",
    scopes: ["meter:read:data", "meter:read:location"],
    language: "en",
    redirectUri: REDIRECT,
  };
  return api(`/users/${encodeURIComponent(userId(address))}/link`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// List the meters currently linked for this wallet's Enode user.
export async function listMeters(address) {
  const j = await api(`/users/${encodeURIComponent(userId(address))}/meters`);
  // Enode list endpoints return { data: [...] } or a bare array depending on route.
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.data)) return j.data;
  return [];
}

// Best-effort extraction of a cumulative meter reading (kWh) from a meter object.
// Enode's beta meter schema isn't pinned here, so we deep-scan for the most
// plausible cumulative-energy field and its unit/timestamp. sync() also returns
// the raw object so this can be tightened against a live response.
export function pickReading(meter) {
  if (!meter || typeof meter !== "object") return null;
  let best = null;
  const readingKey = /(reading|register|cumulativ|total.*(energy|consum)|energy.*total|meterValue)/i;
  const unitKey = /unit/i;
  const tsKey = /(timestamp|lastUpdated|lastSeen|readAt|measuredAt|time)/i;

  const walk = (node, unitHint, tsHint) => {
    if (!node || typeof node !== "object") return;
    // carry down a nearby unit / timestamp as context
    let unit = unitHint, ts = tsHint;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && unitKey.test(k)) unit = v;
      if ((typeof v === "string" || typeof v === "number") && tsKey.test(k)) ts = v;
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "number" && Number.isFinite(v) && readingKey.test(k)) {
        // Prefer a plausible cumulative reading (meters read large & monotonic).
        if (!best || v > best.reading) best = { reading: v, unit: unit || null, at: ts || null, field: k };
      } else if (v && typeof v === "object") {
        walk(v, unit, ts);
      }
    }
  };
  walk(meter, null, null);
  return best;
}

// Pull the latest reading for a wallet. Returns { reading, unit, at, meterId, raw }
// or null when no meter is linked. `raw` is the full meter object for schema work.
export async function fetchLatestReading(address) {
  const meters = await listMeters(address);
  if (!meters.length) return null;
  // Take the first meter (single-home assumption for the beta).
  const first = meters[0];
  const meterId = typeof first === "string" ? first : first.id;
  const meter = typeof first === "object" && first.energyState ? first : await api(`/meters/${encodeURIComponent(meterId)}`);
  const picked = pickReading(meter);
  return {
    meterId,
    reading: picked?.reading ?? null,
    unit: picked?.unit ?? null,
    at: picked?.at ?? null,
    field: picked?.field ?? null,
    raw: meter,
  };
}
