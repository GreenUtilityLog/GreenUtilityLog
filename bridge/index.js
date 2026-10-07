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
//   --install     run twice a day by itself (Windows Task Scheduler, cron elsewhere)
//   --uninstall   remove that schedule again

// CommonJS on purpose. People download this as one loose gul.js with no package.json
// beside it, and Node before 20.19/22.12 treats such a file as CommonJS: `import`
// there is a SyntaxError before a single line runs. Node 18 (Debian/Raspberry Pi OS
// `apt install nodejs`) is exactly that case. require() works on every version.
"use strict";
const http = require("node:http");
const https = require("node:https");
const dgram = require("node:dgram");
const { readFileSync, writeFileSync, appendFileSync, statSync, renameSync, chmodSync, realpathSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { basename, join } = require("node:path");
const { spawnSync } = require("node:child_process");

// --name=value, --name value, or a bare --flag. Unknown flags are ignored rather
// than fatal: a stray argument shouldn't stop someone's meter from reporting. A
// flag that needs a value but got none is an error, though: `--token abc` used to
// save the token "1" over the good one, and every push after that was refused.
const VALUE_FLAGS = new Set(["token", "ip", "interval", "url", "field", "ingest"]);
const FLAGS = {};
const MISSING_VALUE = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(argv[i]);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (m[2] !== undefined) FLAGS[k] = m[2];
    else if (!VALUE_FLAGS.has(k)) FLAGS[k] = "1";
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) FLAGS[k] = argv[++i];
    else MISSING_VALUE.push(k);
  }
}

const pick = (flag, env, fallback = "") =>
  String(FLAGS[flag] ?? process.env[env] ?? fallback).trim();

// MUST match BRIDGE_DEFAULT_API in src/network.js.
const DEFAULT_INGEST = "https://greenutilitylog-rewards.onrender.com/meter-ingest";
const INGEST = pick("ingest", "GUL_INGEST_URL", DEFAULT_INGEST);
// Sending to another server than the default (the test copy of the app, say) gets
// its own saved token, log, scheduled task and cron line. One machine can then
// report to both, instead of the second install silently replacing the first.
const SUFFIX = INGEST === DEFAULT_INGEST ? "" : "-" + (() => {
  try { return new URL(INGEST).hostname.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "other"; }
  catch { return "other"; }
})();

// The token is remembered next to this file, so the second run needs no arguments at
// all. Only the token: everything else is either discovered or has a sensible default.
const HERE = __dirname;
const SELF = basename(process.argv[1] || "index.js");
const CONFIG_FILE = join(HERE, `.gul-bridge${SUFFIX}.json`);
function readSaved() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; }
}
// The saved settings: the token, and when a reading last went through. Written to a
// temporary file and renamed over the old one, so a run that reads it at the same
// moment (a re-install while the hourly job runs) or a crash halfway never sees a
// half-written file — reading one as {} and writing that back is how the token got
// lost. The token this run uses is written every time for the same reason.
function saveConfig(patch) {
  try {
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    const data = { ...readSaved(), ...(TOKEN ? { token: TOKEN } : {}), ...patch };
    // 0600: the token is a credential — anyone holding it can submit readings for
    // this wallet. Ignored on Windows, which has no POSIX modes, but free to ask for.
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, CONFIG_FILE);
    try { chmodSync(CONFIG_FILE, 0o600); } catch {}   // also tightens an older 0644 file
    return true;
  } catch { return false; }  // read-only dir (Docker) — not worth failing over
}
const saveToken = (token) => saveConfig({ token });
const SAVED = readSaved();

let TOKEN = pick("token", "GUL_TOKEN", SAVED.token || "");
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
// --due: push only if the last reading that went through is older than this. The
// cron job runs every hour with it, so a laptop that is on at SOME point of the day
// still reports daily — at 00:00 and 12:00 exactly it may well be asleep — and a
// push that failed (server asleep, Wi-Fi down) is simply tried again next hour.
const DUE = FLAGS.due === "1";
const DUE_AFTER_MS = 11 * 60 * 60 * 1000;
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
    if (TOKEN !== SAVED.token && saveToken(TOKEN)) log(FLAGS.install === "1" ? "token saved" : `token saved — next time just run: node ${SELF}`);
    return true;
  }
  if (!process.stdin.isTTY) {
    // Also into the log: a scheduled run has no window, and cron throws stderr away.
    const msg = "No device token. Pass --token=YOUR_TOKEN, or set GUL_TOKEN.";
    console.error(msg);
    toFile(`${new Date().toISOString()} ${msg}`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question("\nPaste your device token (app → Meter → Automatic setup): ", res));
  rl.close();
  TOKEN = String(answer || "").trim();
  if (!TOKEN) { console.error("No token given — nothing to do."); return false; }
  if (saveToken(TOKEN)) console.log(FLAGS.install === "1" ? "Saved.\n" : `Saved. Next time just run: node ${SELF}\n`);
  return true;
}

// Everything is also appended to .gul-bridge.log next to this file. A scheduled task
// runs with no window, so without a log there is nothing to look at when a reading
// doesn't arrive. Kept small: rotated to .old at 256 KB. A read-only folder
// (Docker) just means no log file, never a failure.
const LOG_FILE = join(HERE, `.gul-bridge${SUFFIX}.log`);
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
    const body = await push(reading);
    // The server says when a reading can next be paid (its cooldown). --due then
    // pushes at that hour instead of up to 11 hours later.
    let nextAt = null;
    try { const n = Number(JSON.parse(body || "{}").nextAt); if (Number.isFinite(n) && n > 0) nextAt = n; } catch {}
    saveConfig({ lastPushAt: Date.now(), nextAt });
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
  const name = TASK_NAME;
  if (action === "uninstall") return ["schtasks", ["/Delete", "/TN", name, "/F"]];
  // Carry over whatever this run was told about WHERE to read and send. Only the
  // token is saved to disk; --ip, --url, --field and --ingest are not, so a task
  // without them would fall back to auto-discovery — which is exactly what fails
  // for the people who needed --ip in the first place, and it would fail silently,
  // twice a day, with nobody watching.
  const keep = keptFlags();
  // schtasks wants the whole command as ONE argument.
  // Every hour with --due, like cron: it only pushes once the last reading is 11 h
  // old, so twice a day in practice — but a run that failed (the PC just woke and
  // Wi-Fi wasn't back yet) is tried again the next hour instead of 12 hours later.
  const run = `"${node}" "${script}" --once --due${keep ? " " + keep : ""}`;
  return ["schtasks", ["/Create", "/TN", name, "/TR", run, "/SC", "HOURLY", "/MO", "1", "/F"]];
}

// A task made by schtasks /Create keeps Windows' defaults: it only starts on mains
// power and a run missed while the PC slept is skipped. On a laptop that can mean
// no reading for days. The ScheduledTasks PowerShell module (Windows 8+) can change
// both. Best effort: the task already exists and works on mains power either way.
function relaxPowerSettings() {
  const ps = `Set-ScheduledTask -TaskName ${TASK_NAME} -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status === 0) log("also set to run on battery, and to catch up a run missed while the PC was asleep.");
  else log("note: could not allow the task on battery power — it runs when the PC is plugged in.");
}

// Mac, Linux, Raspberry Pi: the same idea with cron — one line in the user's own
// crontab, marked so it can be found again, replaced on a re-install and removed
// by --uninstall. Everything else in that crontab is kept exactly as it was.
const TASK_NAME = `GreenUtilityLog${SUFFIX}`;
const CRON_MARK = `# GreenUtilityLog${SUFFIX}`;
// The node to put in the cron line. process.execPath is the RESOLVED path, which
// for Homebrew is a versioned Cellar folder that `brew upgrade` deletes — cron then
// fails every hour, silently. The path the shell finds (/opt/homebrew/bin/node, a
// symlink that follows upgrades) is used instead when it is the same program.
function stableNodePath() {
  try {
    const r = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" });
    const p = (r.stdout || "").trim();
    if (p && realpathSync(p) === realpathSync(process.execPath)) return p;
  } catch {}
  return process.execPath;
}
function manageCron(action) {
  // Single-quoted for sh: a space in a path or an & in --url would otherwise split
  // or background the command. ' itself becomes '\''.
  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const keep = ["ip", "url", "field", "ingest", "interval"].filter((k) => FLAGS[k] && FLAGS[k] !== "1").map((k) => q(`--${k}=${FLAGS[k]}`)).join(" ");
  const cmd = `${q(stableNodePath())} ${q(process.argv[1])} --once --due${keep ? " " + keep : ""}`;
  // Every hour, but --due makes it push only when the last reading is 11 h old:
  // twice a day in practice, and caught up within the hour when the machine wakes.
  // Output goes to .gul-bridge.log already; without the redirect cron mails it.
  const line = `0 * * * * ${cmd} >/dev/null 2>&1 ${CRON_MARK}`;
  const manual = () => {
    log(`Add it yourself: run  crontab -e  and paste this line:\n  ${line}`);
    return 1;
  };

  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (cur.error) { log("cron is not available on this machine."); return manual(); }
  // An empty crontab is an error on most systems ("no crontab for you"). Any OTHER
  // failure means we could not read it — and writing then would wipe it.
  let existing = "";
  if (cur.status === 0) existing = cur.stdout || "";
  else if (!/no crontab/i.test(cur.stderr || "")) {
    log(`could not read your crontab: ${(cur.stderr || "").trim()}`);
    return manual();
  }
  // Exactly this marker at the end of the line: the default one is a prefix of a
  // per-server one, and installing one must leave the other alone. --uninstall
  // without --ingest removes every one of ours: "stop all of it" is what it means.
  const everything = action === "uninstall" && !FLAGS.ingest && !process.env.GUL_INGEST_URL;
  const ours = (l) => (everything ? /# GreenUtilityLog(-[a-z0-9-]+)?$/.test(l.trimEnd()) : l.trimEnd().endsWith(CRON_MARK));
  const lines = existing.split("\n").filter((l) => l.trim() && !ours(l));
  if (action === "install") lines.push(line);
  const w = spawnSync("crontab", ["-"], { input: lines.join("\n") + "\n", encoding: "utf8" });
  if (w.status !== 0) {
    log(`could not ${action} the cron job: ${`${w.stdout || ""}${w.stderr || ""}`.trim()}`);
    return action === "install" ? manual() : 1;
  }
  log(action === "install"
    ? "Scheduled with cron. Your meter now reports twice a day on its own, and catches up within the hour after the computer was off — you can close this terminal."
    : "Removed. Nothing is scheduled any more.");
  return 0;
}

function manageTask(action) {
  if (process.platform !== "win32") return manageCron(action);
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
  if (MISSING_VALUE.length) {
    const msg = `--${MISSING_VALUE[0]} needs a value, like --${MISSING_VALUE[0]}=… — nothing was changed.`;
    console.error(msg); toFile(`${new Date().toISOString()} ${msg}`);
    process.exit(1);
  }
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
      log("sending one reading now, so you can see it arrive… (the server may need up to a minute to wake up)");
      if (!(await cycle())) log(`the schedule is set, but this first reading failed (see above). Details of every run: ${LOG_FILE}`);
    }
    process.exit(code);
  }
  if (!(await ensureToken())) process.exit(1);
  // Not due yet: stay silent, or the log gets a line every hour for nothing.
  // A last push "in the future" (the clock was set back) counts as due, or this
  // would stay silent until the clock caught up — days, possibly.
  {
    const saved = readSaved();
    const last = Number(saved.lastPushAt) || 0;
    const next = Number(saved.nextAt) || 0;
    // Due 11 hours after the last push — or earlier, when the server said a reading
    // can be paid sooner than that.
    const dueAt = Math.min(last + DUE_AFTER_MS, next > last ? next : Infinity);
    if (DUE && ONCE && last <= Date.now() && Date.now() < dueAt) process.exit(0);
  }
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
