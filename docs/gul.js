#!/usr/bin/env node
// ── GreenUtilityLog bridge for HomeWizard P1 ─────────────────────────────────
// The easiest way to auto-submit a HomeWizard meter: run this once on any always-on
// machine (Raspberry Pi, NAS, desktop). It finds your HomeWizard on the network by
// itself (mDNS), reads the meter total, and pushes it to GreenUtilityLog on an
// interval — no IP to look up, no cron, no jq, no shell scripting.
//
// Zero dependencies (Node ≥18 built-ins only).
//
//   node gul.js                        (asks for your token, then remembers it)
//   node gul.js --token=<token>        (or pass it straight in)
//
// In the repository this file is bridge/index.js; testers download it from the Pages
// site as gul.js, which is why the messages below use the name it was actually run
// under rather than a hard-coded one.
//
// Settings can come from three places, in this order: a command-line flag, then an
// environment variable, then the token saved by a previous run. Flags exist because
// the env-var form this file used to document — GUL_TOKEN=x node gul.js — is bash
// syntax that simply errors on Windows PowerShell, which is where a lot of
// HomeWizard owners are. Env vars still work, unchanged, for Docker and the Home
// Assistant add-on.
//
//   --token=…     device token from the app → ⚙️ Automatic setup   (GUL_TOKEN)
//   --ip=…        skip discovery, use this HomeWizard IP           (HW_IP)
//   --interval=…  seconds between pushes, default 3600, min 60     (INTERVAL_SEC)
//   --url=…       read ANY reader that serves JSON over HTTP       (READ_URL)
//   --field=…     dot-path to the kWh number in that JSON          (READ_FIELD)
//   --ingest=…    override the backend                            (GUL_INGEST_URL)
//   --once        push one reading and exit                       (ONCE=1)

import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

// --name=value, or a bare --flag. Unknown flags are ignored rather than fatal: a
// stray argument shouldn't stop someone's meter from reporting.
const FLAGS = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(a);
  if (m) FLAGS[m[1].toLowerCase()] = m[2] === undefined ? "1" : m[2];
}

// The token is remembered next to this file, so the second run needs no arguments at
// all. Only the token: everything else is either discovered or has a sensible default.
const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(process.argv[1] || "index.js");
const CONFIG_FILE = join(HERE, ".gul-bridge.json");
function readSaved() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; }
}
function saveToken(token) {
  // 0600: the token is a credential — anyone holding it can submit readings for this
  // wallet. Ignored on Windows, which has no POSIX modes, but free to ask for.
  try { writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 }); return true; }
  catch { return false; }  // read-only dir (Docker) — not worth failing over
}
const SAVED = readSaved();

const pick = (flag, env, fallback = "") =>
  String(FLAGS[flag] ?? process.env[env] ?? fallback).trim();

let TOKEN = pick("token", "GUL_TOKEN", SAVED.token || "");
const INGEST = pick("ingest", "GUL_INGEST_URL", "https://greenutilitylog-rewards.onrender.com/meter-ingest");
const FIXED_IP = pick("ip", "HW_IP");
const INTERVAL_MS = Math.max(60, Number(pick("interval", "INTERVAL_SEC", 3600))) * 1000;
const ONCE = FLAGS.once === "1" || process.env.ONCE === "1";
// Generic mode: point at ANY reader that returns JSON over HTTP (dsmr-reader,
// Shelly, a custom endpoint…). READ_URL switches off HomeWizard discovery; READ_FIELD
// is an optional dot-path to the cumulative-kWh number (auto-detected if omitted).
const READ_URL = pick("url", "READ_URL");
const READ_FIELD = pick("field", "READ_FIELD");

// Nobody should have to read documentation to find out they forgot the token. When
// there's a terminal to ask in, ask; when there isn't (Docker, a service), fail with
// a message that names the flag AND the env var.
async function ensureToken() {
  if (TOKEN) {
    // Given once on the command line, remembered from then on. Saving fails silently
    // on a read-only dir (Docker), which is fine — there the env var supplies it
    // every time anyway.
    if (TOKEN !== SAVED.token && saveToken(TOKEN)) log(`token saved — next time just run: node ${SELF}`);
    return true;
  }
  if (!process.stdin.isTTY) {
    console.error("No device token. Pass --token=YOUR_TOKEN, or set GUL_TOKEN.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question("\nPaste your device token (app → Submit → Automatic setup): ", res));
  rl.close();
  TOKEN = String(answer || "").trim();
  if (!TOKEN) { console.error("No token given — nothing to do."); return false; }
  if (saveToken(TOKEN)) console.log(`Saved. Next time just run: node ${SELF}\n`);
  return true;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── mDNS discovery ───────────────────────────────────────────────────────────
// HomeWizard Energy devices advertise the `_hwenergy._tcp.local` service. We send
// one PTR query to the multicast group and take the first IPv4 (A record) that
// comes back. Best-effort: if nothing answers, the caller falls back to HW_IP.
function encodeName(name) {
  const parts = name.split(".").filter(Boolean);
  const bufs = parts.map((p) => { const b = Buffer.from(p, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}
function buildQuery(service) {
  const header = Buffer.from([0,0, 0,0, 0,1, 0,0, 0,0, 0,0]); // id0, flags0, qd1
  const q = Buffer.concat([encodeName(service), Buffer.from([0,12, 0,1])]); // QTYPE=PTR(12), QCLASS=IN(1)
  return Buffer.concat([header, q]);
}
// Read a (possibly compressed) DNS name; returns the offset AFTER the name.
function skipName(buf, off) {
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2; // compression pointer ends the name
    off += 1 + len;
  }
  return off;
}
// Pull every IPv4 A record out of a DNS response message.
function parseARecords(buf) {
  const ips = [];
  try {
    const qd = buf.readUInt16BE(4);
    const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i++) { off = skipName(buf, off); off += 4; } // name + qtype + qclass
    for (let i = 0; i < total && off + 10 <= buf.length; i++) {
      off = skipName(buf, off);
      const type = buf.readUInt16BE(off);
      const rdlen = buf.readUInt16BE(off + 8);
      const rdoff = off + 10;
      if (type === 1 && rdlen === 4 && rdoff + 4 <= buf.length) {
        ips.push(`${buf[rdoff]}.${buf[rdoff + 1]}.${buf[rdoff + 2]}.${buf[rdoff + 3]}`);
      }
      off = rdoff + rdlen;
    }
  } catch { /* malformed packet — ignore */ }
  return ips;
}
function discover(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let done = false;
    const finish = (ip) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(ip); };
    sock.on("message", (msg) => { const ips = parseARecords(msg); if (ips.length) finish(ips[0]); });
    sock.on("error", () => finish(null));
    sock.bind(() => {
      try { sock.setMulticastTTL(255); sock.addMembership("224.0.0.251"); } catch {}
      const q = buildQuery("_hwenergy._tcp.local");
      sock.send(q, 0, q.length, 5353, "224.0.0.251");
    });
    setTimeout(() => finish(null), timeoutMs);
  });
}

// ── HomeWizard read + push ───────────────────────────────────────────────────
function getJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = String(url).toLowerCase().startsWith("https:") ? https : http; // honour https READ_URLs
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
// HomeWizard ships TWO naming conventions for the same numbers depending on
// firmware/model: the older `total_power_import_*` and the newer `energy_import_*`.
// Handle both, single-total first, then tariff 1 + tariff 2.
function readTotal(data) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const d = data || {};
  for (const key of ["total_power_import_kwh", "energy_import_kwh"]) {
    const v = n(d[key]);
    if (v != null) return v;
  }
  for (const [k1, k2] of [["total_power_import_t1_kwh", "total_power_import_t2_kwh"], ["energy_import_t1_kwh", "energy_import_t2_kwh"]]) {
    if (d[k1] != null || d[k2] != null) return +((n(d[k1]) || 0) + (n(d[k2]) || 0)).toFixed(3);
  }
  return null;
}
// The number above is the total across BOTH tariff registers, which is what a meter
// actually consumed. A double-tariff meter (the normal case in NL) shows them apart
// as 1.8.1 and 1.8.2 and alternates between them, so the display never matches this
// total and it looks like the reader is wrong. Print the split when the device offers
// it, so the difference explains itself instead of becoming a support question.
function tariffSplit(data) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const d = data || {};
  for (const [k1, k2] of [["total_power_import_t1_kwh", "total_power_import_t2_kwh"], ["energy_import_t1_kwh", "energy_import_t2_kwh"]]) {
    const a = n(d[k1]), b = n(d[k2]);
    if (a != null && b != null) return ` (low ${a} + normal ${b})`;
  }
  return "";
}
// Generic reader: read a dot-path field, or auto-detect a common cumulative-kWh key.
function readGeneric(data, field) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null));
  if (field) {
    let v = data;
    for (const k of field.split(".")) { if (v == null) break; v = v[k]; }
    return num(v);
  }
  const CANDIDATES = ["total_power_import_kwh", "total_energy_import_kwh", "energy_import_kwh", "import_kwh", "total_kwh", "reading", "value"];
  for (const k of CANDIDATES) { const v = num(data?.[k]); if (v != null) return v; }
  return readTotal(data || {}); // fall back to HomeWizard-style t1+t2
}
function push(reading) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ token: TOKEN, reading });
    const u = new URL(INGEST);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 10000 }, (res) => {
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(body) : reject(new Error(`ingest ${res.statusCode}: ${body}`))));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

let lastIp = FIXED_IP || null;
async function cycle() {
  try {
    let reading, split = "";
    if (READ_URL) {
      // Generic mode — any HTTP/JSON reader.
      const data = await getJson(READ_URL);
      reading = readGeneric(data, READ_FIELD);
      if (reading == null) { log(`couldn't find a kWh number at ${READ_URL}${READ_FIELD ? ` (field "${READ_FIELD}")` : ""} — add --field=<dot.path>.`); return; }
      // Also here: the guide's own "any reader" example points --url at a HomeWizard's
      // /api/v1/data, so this path sees tariff registers just as often as the other.
      if (!READ_FIELD) split = tariffSplit(data);
    } else {
      // HomeWizard mode — discover on the network, then read the local API.
      if (!lastIp) { lastIp = await discover(); if (lastIp) log(`found HomeWizard at ${lastIp}`); }
      if (!lastIp) { log("no HomeWizard found on the network — add --ip=<ip>, or --url=<url> for another reader."); return; }
      const data = await getJson(`http://${lastIp}/api/v1/data`);
      reading = readTotal(data);
      if (reading == null) { log("couldn't find a total import kWh — is this a HomeWizard P1? (or use --url=)"); return; }
      split = tariffSplit(data);
    }
    await push(reading);
    log(`pushed ${reading} kWh ✓${split}`);
  } catch (e) {
    log("cycle failed:", e?.message || e);
    if (!READ_URL) lastIp = FIXED_IP || null; // re-discover next time in case the IP changed
  }
}

async function main() {
  if (!(await ensureToken())) process.exit(1);
  const src = READ_URL ? `reader ${READ_URL}` : (FIXED_IP ? `HomeWizard ${FIXED_IP}` : "HomeWizard (auto-discover)");
  if (!/^https:/i.test(INGEST)) log("WARNING: GUL_INGEST_URL is not https — your token would be sent in cleartext. Use the default https endpoint.");
  log(`GreenUtilityLog bridge starting — ${src}, pushing every ${INTERVAL_MS / 1000}s to ${INGEST}`);
  await cycle();
  if (ONCE) return;
  setInterval(cycle, INTERVAL_MS);
}

// Run it. There used to be an "only when invoked directly" guard here that compared
// import.meta.url against `file://${process.argv[1]}` — string concatenation that
// cannot produce a valid file URL. On Windows argv[1] is "C:\Users\you\gul.js", so the
// comparison was `file://C:\Users\you\gul.js` vs `file:///C:/Users/you/gul.js`: never
// equal, for any path. main() was skipped and the script exited printing NOTHING, on
// every Windows machine. The same bug shows up anywhere the path needs escaping — a
// single space is enough, since the real URL has %20 and the concatenation doesn't.
//
// Nothing in this repository imports this file; the exports below exist for ad-hoc
// checks. So run unconditionally and give importers an explicit opt-out, rather than
// inferring "was I run directly?" from a comparison that has to be exactly right on
// three platforms to avoid failing silently.
if (!process.env.GUL_NO_MAIN) main();

export { buildQuery, parseARecords, skipName, readTotal, readGeneric };
