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
//   --interval=…  seconds between pushes, default 43200, min 60    (INTERVAL_SEC)
//   --url=…       read ANY reader that serves JSON over HTTP       (READ_URL)
//   --field=…     dot-path to the kWh number in that JSON          (READ_FIELD)
//   --ingest=…    override the backend                            (GUL_INGEST_URL)
//   --once        push one reading and exit                       (ONCE=1)
//   --install     Windows: run twice a day by itself, no window open
//   --uninstall   remove that scheduled task again

// CommonJS on purpose. People download this as one loose gul.js with no package.json
// beside it, and Node before 20.19/22.12 treats such a file as CommonJS: `import`
// there is a SyntaxError before a single line runs. Node 18 (Debian/Raspberry Pi OS
// `apt install nodejs`) is exactly that case. require() works on every version.
"use strict";
const http = require("node:http");
const https = require("node:https");
const dgram = require("node:dgram");
const { readFileSync, writeFileSync, appendFileSync, statSync, renameSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { basename, join } = require("node:path");
const { spawnSync } = require("node:child_process");

// --name=value, or a bare --flag. Unknown flags are ignored rather than fatal: a
// stray argument shouldn't stop someone's meter from reporting.
const FLAGS = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(a);
  if (m) FLAGS[m[1].toLowerCase()] = m[2] === undefined ? "1" : m[2];
}

// The token is remembered next to this file, so the second run needs no arguments at
// all. Only the token: everything else is either discovered or has a sensible default.
const HERE = __dirname;
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
// Twelve hours, not one. A reading can only be claimed once per COOLDOWN_MS (20h)
// and /meter-ingest keeps only the newest value, so 23 of 24 hourly pushes are
// discarded. Two a day still leaves a wide margin against the 48h staleness rule,
// and it lets a free-tier backend sleep instead of being woken every hour.
// Seconds, as a plain number. Anything else ("12h", "") used to become NaN, and
// setInterval(fn, NaN) fires as fast as it can — thousands of pushes a second.
const INTERVAL_SEC = Number(pick("interval", "INTERVAL_SEC", 43200));
const INTERVAL_MS = (Number.isFinite(INTERVAL_SEC) && INTERVAL_SEC > 0 ? Math.max(60, INTERVAL_SEC) : 43200) * 1000;
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

// Everything is also appended to .gul-bridge.log next to this file. A scheduled task
// runs with no window, so without a log there is nothing to look at when a reading
// doesn't arrive. Kept small: rotated to .old at 256 KB. A read-only folder
// (Docker) just means no log file, never a failure.
const LOG_FILE = join(HERE, ".gul-bridge.log");
function toFile(line) {
  try {
    try { if (statSync(LOG_FILE).size > 256 * 1024) renameSync(LOG_FILE, LOG_FILE + ".old"); } catch {}
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}
const log = (...a) => {
  const line = [new Date().toISOString(), ...a].join(" ");
  console.log(line);
  toFile(line);
};

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
      res.on("end", () => {
        // A HomeWizard with its Local API switched off answers 403. Say that, rather
        // than trying to parse the refusal and blaming the JSON field.
        if (res.statusCode === 403) return reject(new Error(`${url} said 403 — switch on "Local API" for this meter in the HomeWizard Energy app`));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${url} said ${res.statusCode}: ${short(body)}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`${url} did not return JSON: ${short(body)}`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
// An error page can be a whole HTML document; one line of it is enough to recognise.
const short = (body) => String(body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

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
function pushOnce(reading) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ token: TOKEN, reading });
    const u = new URL(INGEST);
    const mod = u.protocol === "https:" ? https : http;
    // 90 s: a free-tier backend asleep since the last push takes ~30-60 s to wake,
    // and with two pushes a day nearly every push is the one that wakes it.
    const req = mod.request(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: PUSH_TIMEOUT_MS }, (res) => {
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        const err = new Error(`server said ${res.statusCode}: ${short(body)}`);
        err.retry = res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504 || res.statusCode === 429;
        reject(err);
      });
    });
    req.on("timeout", () => { const e = new Error("no answer from the server (timeout)"); e.retry = true; req.destroy(e); });
    req.on("error", (e) => { if (e.retry === undefined) e.retry = true; reject(e); }); // network errors: worth another try
    req.end(payload);
  });
}
const PUSH_TIMEOUT_MS = Number(process.env.GUL_PUSH_TIMEOUT_MS) || 90000;
const RETRY_WAIT_MS = Number(process.env.GUL_RETRY_WAIT_MS) || 20000;
// Three tries, 20 s apart, for the failures that pass on their own: a backend still
// waking ("warming up" 503), a proxy 502, a dropped connection. A 401 (bad token)
// or 400 (bad reading) will not improve by asking again, so those fail at once.
async function push(reading) {
  for (let attempt = 1; ; attempt++) {
    try { return await pushOnce(reading); }
    catch (e) {
      if (!e.retry || attempt >= 3) throw e;
      log(`${e.message} — trying again in ${RETRY_WAIT_MS / 1000}s (${attempt}/3)`);
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
}

let lastIp = FIXED_IP || null;
async function cycle() {
  try {
    let reading, split = "";
    if (READ_URL) {
      // Generic mode — any HTTP/JSON reader.
      const data = await getJson(READ_URL);
      reading = readGeneric(data, READ_FIELD);
      if (reading == null) { log(`couldn't find a kWh number at ${READ_URL}${READ_FIELD ? ` (field "${READ_FIELD}")` : ""} — add --field=<dot.path>.`); return false; }
      // Also here: the guide's own "any reader" example points --url at a HomeWizard's
      // /api/v1/data, so this path sees tariff registers just as often as the other.
      if (!READ_FIELD) split = tariffSplit(data);
    } else {
      // HomeWizard mode — discover on the network, then read the local API.
      if (!lastIp) { lastIp = await discover(); if (lastIp) log(`found HomeWizard at ${lastIp}`); }
      if (!lastIp) { log("no HomeWizard found on the network — add --ip=<ip>, or --url=<url> for another reader."); return false; }
      const data = await getJson(`http://${lastIp}/api/v1/data`);
      reading = readTotal(data);
      if (reading == null) { log("couldn't find a total import kWh — is this a HomeWizard P1? (or use --url=)"); return false; }
      split = tariffSplit(data);
    }
    await push(reading);
    log(`pushed ${reading} kWh ✓${split}`);
    return true;
  } catch (e) {
    log("cycle failed:", e?.message || e);
    if (!READ_URL) lastIp = FIXED_IP || null; // re-discover next time in case the IP changed
    return false;
  }
}

// ── Running without a window open ────────────────────────────────────────────
// Until now the only way to keep pushing was to leave a PowerShell window open on a
// machine that never sleeps. That is a poor thing to ask of someone, and it is the
// most common way this quietly stops working: the window gets closed, no reading
// arrives, and nothing anywhere says so.
//
// Windows has Task Scheduler for exactly this. One task running `--once` twice a day
// needs no window, survives a reboot, and needs no admin rights. The schedule matches
// the push interval for the same reason it was chosen: a reading only has to be under
// 48 hours old, so twice a day leaves room for two missed runs.
// The flags that say where to read and where to send. Only the token is saved to
// disk, so anything scheduled has to be given these again or it quietly falls back
// to auto-discovery — which is what fails for the people who needed --ip.
function keptFlags() {
  return ["ip", "url", "field", "ingest", "interval"]
    .filter((k) => FLAGS[k] && FLAGS[k] !== "1")
    .map((k) => `--${k}=${FLAGS[k]}`)
    .join(" ");
}

function taskCommand(action) {
  const node = process.execPath;                 // the node that is running us
  const script = process.argv[1];                // this file, wherever it was saved
  const name = "GreenUtilityLog";
  if (action === "uninstall") return ["schtasks", ["/Delete", "/TN", name, "/F"]];
  // Carry over whatever this run was told about WHERE to read and send. Only the
  // token is saved to disk; --ip, --url, --field and --ingest are not, so a task
  // without them would fall back to auto-discovery — which is exactly what fails
  // for the people who needed --ip in the first place, and it would fail silently,
  // twice a day, with nobody watching.
  const keep = keptFlags();
  // schtasks wants the whole command as ONE argument.
  const run = `"${node}" "${script}" --once${keep ? " " + keep : ""}`;
  return ["schtasks", ["/Create", "/TN", name, "/TR", run, "/SC", "HOURLY", "/MO", "12", "/F"]];
}

// A task made by schtasks /Create keeps Windows' defaults: it only starts on mains
// power and a run missed while the PC slept is skipped. On a laptop that can mean
// no reading for days. The ScheduledTasks PowerShell module (Windows 8+) can change
// both. Best effort: the task already exists and works on mains power either way.
function relaxPowerSettings() {
  const ps = "Set-ScheduledTask -TaskName GreenUtilityLog -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status === 0) log("also set to run on battery, and to catch up a run missed while the PC was asleep.");
  else log("note: could not allow the task on battery power — it runs when the PC is plugged in.");
}

function manageTask(action) {
  if (process.platform !== "win32") {
    log(`--${action} is a Windows feature (Task Scheduler).`);
    // Single-quoted for sh: a space in a path or an & in --url would otherwise split
    // or background the command. ' itself becomes '\''.
    const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
    const keep = ["ip", "url", "field", "ingest", "interval"].filter((k) => FLAGS[k] && FLAGS[k] !== "1").map((k) => q(`--${k}=${FLAGS[k]}`)).join(" ");
    const cmd = `${q(process.execPath)} ${q(process.argv[1])} --once${keep ? " " + keep : ""}`;
    log(`On Linux/macOS use cron or a systemd timer, running:  ${cmd}`);
    log(`e.g. crontab -e, then:  0 */12 * * * ${cmd}`);
    return 1;
  }
  const [cmd, args] = taskCommand(action);
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  if (r.status === 0) {
    if (action === "install") relaxPowerSettings();
    log(action === "install"
      ? "Scheduled. Your meter now reports twice a day on its own — you can close this window."
      : "Removed. Nothing is scheduled any more.");
    return 0;
  }
  // Never leave someone stuck: show what failed AND what to run by hand.
  log(`could not ${action} the scheduled task${out ? `: ${out}` : ""}`);
  // cmd.exe syntax, not PowerShell: Windows PowerShell 5.1 mangles the " inside
  // /TR when it passes them on, and cmd passes them through untouched.
  log(`Run this yourself in a Command Prompt (cmd):\n  ${cmd} ${args.map((a) => (/[ "]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`);
  return 1;
}

async function main() {
  if (FLAGS.uninstall === "1") process.exit(manageTask("uninstall"));
  if (FLAGS.install === "1") {
    // A task is useless without a token: it runs unattended and cannot ask.
    if (!(await ensureToken())) process.exit(1);
    const code = manageTask("install");
    // And push once, right now. Scheduling alone sends nothing: the task first runs
    // at its next slot, which can be hours away, so someone who has just done
    // everything asked of them still sees no reading arrive and no way to tell
    // whether any of it worked. One cycle here makes the setup verifiable the
    // moment it finishes.
    if (code === 0) {
      log("sending one reading now, so you can see it arrive…");
      if (!(await cycle())) log(`the schedule is set, but this first reading failed (see above). Details of every run: ${LOG_FILE}`);
    }
    process.exit(code);
  }
  if (!(await ensureToken())) process.exit(1);
  const src = READ_URL ? `reader ${READ_URL}` : (FIXED_IP ? `HomeWizard ${FIXED_IP}` : "HomeWizard (auto-discover)");
  if (!/^https:/i.test(INGEST)) log("WARNING: GUL_INGEST_URL is not https — your token would be sent in cleartext. Use the default https endpoint.");
  log(`GreenUtilityLog bridge starting — ${src}, pushing every ${INTERVAL_MS / 1000}s to ${INGEST}`);
  const ok = await cycle();
  // Exit 1 on failure, so Task Scheduler / cron / Docker see a failed run instead of
  // "completed successfully" while nothing arrived.
  if (ONCE) process.exit(ok ? 0 : 1);
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

module.exports = { buildQuery, parseARecords, skipName, readTotal, readGeneric };
