// ── Powerfox (poweropti) — readings straight from the Powerfox cloud ──────────
// A poweropti clips onto the optical port of a German smart meter ("moderne
// Messeinrichtung") and sends the meter total to the Powerfox cloud. Unlike a
// HomeWizard, that cloud has an API, so this server can fetch the reading itself
// and nobody has to keep a computer on.
//
// The API has no OAuth: it takes the Powerfox account's e-mail and password as
// HTTP basic auth (the official python-powerfox library, which Home Assistant
// uses, does the same). So the credentials are stored, encrypted with a key that
// exists only in this server's environment (POWERFOX_SECRET), never logged and
// never sent back. Without that key the feature is off.
//
// GET {api}/my/main/current?unit=kwh →
//   { Outdated, Timestamp (unix s), Watt, A_Plus (kWh), A_Minus, A_Plus_HT, A_Plus_NT }
// A_Plus is the meter total. Some meters only report the two tariff registers;
// then A_Plus is 0 and the total is HT + NT. A refused data transfer (switched
// off in the Powerfox app) comes back as HTTP 200 with {"StatusCode": 412}.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const API = (process.env.POWERFOX_API_URL || "https://backend.powerfox.energy/api/2.0").replace(/\/$/, "");
const SECRET = String(process.env.POWERFOX_SECRET || "");

export const powerfoxEnabled = () => SECRET.length >= 16;

const key = () => createHash("sha256").update(SECRET).digest();

// "v1:<iv>:<tag>:<ciphertext>", base64 parts.
export function sealCredentials(user, pass) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ u: String(user), p: String(pass) }), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
export function openCredentials(sealed) {
  const [v, iv, tag, ct] = String(sealed || "").split(":");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    const o = JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
    return o && o.u && o.p ? { user: o.u, pass: o.p } : null;
  } catch { return null; }   // wrong key (POWERFOX_SECRET changed) or tampered
}

// Total kWh from one "current" answer, or null.
export function powerfoxTotal(d) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const plus = n(d?.A_Plus);
  if (plus != null && plus > 0) return plus;
  const ht = n(d?.A_Plus_HT), nt = n(d?.A_Plus_NT);
  if (ht != null || nt != null) {
    const sum = +((ht || 0) + (nt || 0)).toFixed(3);
    return sum > 0 ? sum : null;
  }
  return null;
}

// → { ok:true, reading, at, outdated } or { ok:false, code, error } with an error
// a user can act on. Never includes the credentials.
export async function fetchPowerfoxReading(user, pass) {
  const auth = "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  let res, text;
  try {
    res = await fetch(`${API}/my/main/current?unit=kwh`, {
      headers: { Authorization: auth, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    text = await res.text();
  } catch {
    return { ok: false, code: "unreachable", error: "Powerfox can't be reached right now — try again later" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "auth", error: "Powerfox didn't accept this e-mail and password" };
  }
  let d;
  try { d = JSON.parse(text); } catch { d = null; }
  if (d && typeof d.StatusCode === "number" && d.StatusCode === 412) {
    return { ok: false, code: "privacy", error: "Powerfox refused to share the data — switch on data transfer (Datenfreigabe) in the Powerfox app" };
  }
  if (!res.ok || !d || typeof d !== "object") {
    return { ok: false, code: "bad_answer", error: "Powerfox gave no meter reading — check that your poweropti is set up in the Powerfox app" };
  }
  const reading = powerfoxTotal(d);
  if (reading == null) {
    return { ok: false, code: "no_total", error: "Powerfox sent no meter total for this device — is the main device an electricity meter?" };
  }
  const ts = Number(d.Timestamp);
  return { ok: true, reading, at: Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now(), outdated: d.Outdated === true };
}
