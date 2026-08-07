#!/usr/bin/env node
// ── GreenUtilityLog bridge for HomeWizard P1 ─────────────────────────────────
// The easiest way to auto-submit a HomeWizard meter: run this once on any always-on
// machine (Raspberry Pi, NAS, desktop). It finds your HomeWizard on the network by
// itself (mDNS), reads the meter total, and pushes it to GreenUtilityLog on an
// interval — no IP to look up, no cron, no jq, no shell scripting.
//
// Zero dependencies (Node ≥18 built-ins only).
//
//   GUL_TOKEN=<your device token>  node index.js
//
// Env:
//   GUL_TOKEN     (required) device token from the app → ⚙️ Automatic setup
//   GUL_INGEST_URL (optional) defaults to the public backend
//   HW_IP         (optional) skip discovery and use this HomeWizard IP directly
//   INTERVAL_SEC  (optional) seconds between pushes (default 3600, min 60)
//   ONCE          (optional) set to "1" to push a single reading and exit

import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";

const TOKEN = (process.env.GUL_TOKEN || "").trim();
const INGEST = (process.env.GUL_INGEST_URL || "https://greenutilitylog-rewards.onrender.com/meter-ingest").trim();
const FIXED_IP = (process.env.HW_IP || "").trim();
const INTERVAL_MS = Math.max(60, Number(process.env.INTERVAL_SEC || 3600)) * 1000;
const ONCE = process.env.ONCE === "1";
// Generic mode: point at ANY reader that returns JSON over HTTP (dsmr-reader,
// Shelly, a custom endpoint…). READ_URL switches off HomeWizard discovery; READ_FIELD
// is an optional dot-path to the cumulative-kWh number (auto-detected if omitted).
const READ_URL = (process.env.READ_URL || "").trim();
const READ_FIELD = (process.env.READ_FIELD || "").trim();

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
function readTotal(data) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const total = n(data.total_power_import_kwh);
  if (total != null) return total;
  const t1 = n(data.total_power_import_t1_kwh) || 0;
  const t2 = n(data.total_power_import_t2_kwh) || 0;
  if (data.total_power_import_t1_kwh != null || data.total_power_import_t2_kwh != null) return +(t1 + t2).toFixed(3);
  return null;
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
    let reading;
    if (READ_URL) {
      // Generic mode — any HTTP/JSON reader.
      const data = await getJson(READ_URL);
      reading = readGeneric(data, READ_FIELD);
      if (reading == null) { log(`couldn't find a kWh number at ${READ_URL}${READ_FIELD ? ` (field "${READ_FIELD}")` : ""} — set READ_FIELD=<dot.path>.`); return; }
    } else {
      // HomeWizard mode — discover on the network, then read the local API.
      if (!lastIp) { lastIp = await discover(); if (lastIp) log(`found HomeWizard at ${lastIp}`); }
      if (!lastIp) { log("no HomeWizard found on the network — set HW_IP=<ip>, or use READ_URL=<url> for another reader."); return; }
      const data = await getJson(`http://${lastIp}/api/v1/data`);
      reading = readTotal(data);
      if (reading == null) { log("couldn't find a total import kWh — is this a HomeWizard P1? (or use READ_URL)"); return; }
    }
    await push(reading);
    log(`pushed ${reading} kWh ✓`);
  } catch (e) {
    log("cycle failed:", e?.message || e);
    if (!READ_URL) lastIp = FIXED_IP || null; // re-discover next time in case the IP changed
  }
}

async function main() {
  if (!TOKEN) {
    console.error('GUL_TOKEN is required. Get it in the app → Submit → Electricity → ⚙️ Automatic setup → "Get my device token".');
    process.exit(1);
  }
  const src = READ_URL ? `reader ${READ_URL}` : (FIXED_IP ? `HomeWizard ${FIXED_IP}` : "HomeWizard (auto-discover)");
  if (!/^https:/i.test(INGEST)) log("WARNING: GUL_INGEST_URL is not https — your token would be sent in cleartext. Use the default https endpoint.");
  log(`GreenUtilityLog bridge starting — ${src}, pushing every ${INTERVAL_MS / 1000}s to ${INGEST}`);
  await cycle();
  if (ONCE) return;
  setInterval(cycle, INTERVAL_MS);
}

// Only run the loop when executed directly (so tests can import the helpers).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) main();

export { buildQuery, parseARecords, skipName, readTotal, readGeneric };
