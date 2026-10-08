// The bridge against a fake HomeWizard and a fake backend, as the file people
// actually download: one loose .js with no package.json beside it. CI runs this on
// every Node version the guide promises, because "works on my Node" is how the
// bridge once failed to even start on Node 18.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdtempSync, copyFileSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Copied into a bare temp folder, so no package.json can decide the module type.
const dir = mkdtempSync(join(tmpdir(), "gul bridge "));   // a space on purpose
const GUL = join(dir, "gul.js");
copyFileSync(join(__dirname, "index.js"), GUL);

function fake(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const hw = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ total_power_import_t1_kwh: 100.5, total_power_import_t2_kwh: 200.25 }));
};
function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GUL, ...args], { env: { ...process.env, GUL_RETRY_WAIT_MS: "50", ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => resolve({ code, out }));
  });
}

test("pushes the tariff sum and exits 0", async () => {
  const reader = await fake(hw);
  let got = null;
  const backend = await fake((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got = JSON.parse(b); res.end("{}"); }); });
  const r = await run(["--token=t1", "--once", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`]);
  reader.close(); backend.close();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(got, { token: "t1", reading: 300.75 });
  assert.match(r.out, /pushed 300\.75 kWh ✓ \(low 100\.5 \+ normal 200\.25\)/);
  assert.ok(existsSync(join(dir, ".gul-bridge-127.log")), "every run is logged next to the script");
});

test("waits out a backend that is still waking up", async () => {
  const reader = await fake(hw);
  let n = 0;
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => { n++; if (n < 3) { res.statusCode = 503; res.end('{"error":"warming up"}'); } else res.end("{}"); }); });
  const r = await run(["--once", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`]);
  reader.close(); backend.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(n, 3);
});

test("a refused token fails at once, with exit 1, without retrying", async () => {
  const reader = await fake(hw);
  let n = 0;
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => { n++; res.statusCode = 401; res.end('{"error":"unknown device token"}'); }); });
  const r = await run(["--once", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`]);
  reader.close(); backend.close();
  assert.equal(r.code, 1, r.out);
  assert.equal(n, 1);
  assert.match(r.out, /401: \{"error":"unknown device token"\}/);
});

test("a HomeWizard with Local API off is named as such", async () => {
  const reader = await fake((req, res) => { res.statusCode = 403; res.end("forbidden"); });
  const r = await run(["--once", `--ip=127.0.0.1:${reader.address().port}`, "--ingest=http://127.0.0.1:9/x"]);
  reader.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Local API/);
});

test("a nonsense --interval falls back to twice a day", async () => {
  const reader = await fake(hw);
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
  const p = spawn(process.execPath, [GUL, "--interval=12h", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`]);
  let out = ""; p.stdout.on("data", (c) => (out += c));
  await new Promise((r) => setTimeout(r, 1500));
  p.kill(); reader.close(); backend.close();
  assert.match(out, /pushing every 43200s/);
  assert.equal((out.match(/pushed /g) || []).length, 1, out);
});

test("the token file stays private", () => {
  if (process.platform === "win32") return;
  const mode = require("node:fs").statSync(join(dir, ".gul-bridge-127.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dir, ".gul-bridge-127.json"), "utf8")).token, "t1");
});

test("--install on Mac/Linux adds one cron line, keeps the rest, and --uninstall removes it", async () => {
  if (process.platform === "win32") return;
  const { writeFileSync, chmodSync, mkdirSync } = require("node:fs");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const cronFile = join(dir, "crontab.txt");
  // A stand-in for crontab(1): -l prints the file (or "no crontab"), - replaces it.
  writeFileSync(join(bin, "crontab"), '#!/bin/sh\nif [ "$1" = "-l" ]; then if [ -f "$CRONFILE" ]; then cat "$CRONFILE"; else echo "no crontab for you" >&2; exit 1; fi; elif [ "$1" = "-" ]; then cat > "$CRONFILE"; fi\n');
  chmodSync(join(bin, "crontab"), 0o755);
  writeFileSync(cronFile, "MAILTO=me\n5 4 * * * /usr/bin/backup\n");
  const env = { PATH: `${bin}:${process.env.PATH}`, CRONFILE: cronFile };
  const reader = await fake(hw);
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
  const flags = [`--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`];

  const r = await run(["--install", ...flags], env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Scheduled with cron/);
  assert.match(r.out, /pushed 300\.75 kWh/, "and sends the first reading straight away");
  let tab = readFileSync(cronFile, "utf8");
  assert.match(tab, /MAILTO=me\n5 4 \* \* \* \/usr\/bin\/backup\n/, "the user's own lines stay");
  assert.equal((tab.match(/# GreenUtilityLog/g) || []).length, 1);
  assert.match(tab, /^0 \* \* \* \* .* --once --due '--ip=127\.0\.0\.1:\d+'/m, "hourly, pushing only when due, where to read carried into the job");

  await run(["--install", ...flags], env);
  tab = readFileSync(cronFile, "utf8");
  assert.equal((tab.match(/# GreenUtilityLog/g) || []).length, 1, "installing again replaces, not duplicates");

  const u = await run(["--uninstall"], env);
  assert.equal(u.code, 0, u.out);
  assert.equal(readFileSync(cronFile, "utf8"), "MAILTO=me\n5 4 * * * /usr/bin/backup\n");
  reader.close(); backend.close();
});

test("--due pushes only when the last reading is 11 hours old, and retries a failure next time", async () => {
  const reader = await fake(hw);
  let n = 0, fail = true;
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => { n++; if (fail) { res.statusCode = 401; res.end("{}"); } else res.end("{}"); }); });
  const flags = ["--once", "--due", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`];
  const cfg = join(dir, ".gul-bridge-127.json");
  const set = (lastPushAt) => { const c = JSON.parse(readFileSync(cfg, "utf8")); c.lastPushAt = lastPushAt; require("node:fs").writeFileSync(cfg, JSON.stringify(c)); };

  set(Date.now() - 12 * 3600e3);
  let r = await run(flags);                       // due, but the server refuses
  assert.equal(r.code, 1, r.out);
  assert.equal(n, 1);
  r = await run(flags);                           // a failure isn't a push: still due
  assert.equal(n, 2);

  fail = false;
  r = await run(flags);                           // goes through now
  assert.equal(r.code, 0, r.out);
  assert.equal(n, 3);
  r = await run(flags);                           // just pushed: not due, silent
  assert.equal(r.code, 0);
  assert.equal(n, 3);
  assert.equal(r.out, "");
  assert.ok(JSON.parse(readFileSync(cfg, "utf8")).token, "the token survives the timestamp being saved");
  reader.close(); backend.close();
});

test("a clock set back doesn't silence --due until it catches up", async () => {
  const reader = await fake(hw);
  let n = 0;
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => { n++; res.end("{}"); }); });
  const flags = ["--once", "--due", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`];
  const cfg = join(dir, ".gul-bridge-127.json");
  const c = JSON.parse(readFileSync(cfg, "utf8")); c.lastPushAt = Date.now() + 30 * 86400e3;
  require("node:fs").writeFileSync(cfg, JSON.stringify(c));
  const r = await run(flags);
  assert.equal(r.code, 0, r.out);
  assert.equal(n, 1, "a last push 'in the future' counts as due");
  reader.close(); backend.close();
});

test("--token with a space instead of = still works, and a bare --token is refused", async () => {
  const reader = await fake(hw);
  const seen = [];
  const backend = await fake((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { seen.push(JSON.parse(b).token); res.end("{}"); }); });
  const flags = ["--once", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`];
  let r = await run(["--token", "spaced", ...flags]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(seen, ["spaced"]);
  r = await run([...flags, "--token"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--token needs a value/);
  assert.equal(seen.length, 1, "nothing was sent");
  assert.equal(JSON.parse(readFileSync(join(dir, ".gul-bridge-127.json"), "utf8")).token, "spaced", "the saved token is untouched");
  reader.close(); backend.close();
});

test("runs at the same moment never lose the saved token", async () => {
  const reader = await fake(hw);
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
  const flags = ["--once", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`];
  const cfg = join(dir, ".gul-bridge-127.json");
  for (let round = 0; round < 8; round++) {
    await Promise.all(Array.from({ length: 6 }, () => run(flags)));
    assert.equal(JSON.parse(readFileSync(cfg, "utf8")).token, "spaced", `round ${round}`);
  }
  reader.close(); backend.close();
});

test("--due pushes as soon as the server said a reading can be paid, even within 11 hours", async () => {
  const reader = await fake(hw);
  let n = 0, nextAt = 0;
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => { n++; res.end(JSON.stringify({ ok: true, nextAt })); }); });
  const flags = ["--once", "--due", `--ip=127.0.0.1:${reader.address().port}`, `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`];
  const cfg = join(dir, ".gul-bridge-127.json");
  const c = JSON.parse(readFileSync(cfg, "utf8")); c.lastPushAt = Date.now() - 12 * 3600e3; require("node:fs").writeFileSync(cfg, JSON.stringify(c));
  nextAt = Date.now() + 2000;                     // the server: payable again in 2 s
  assert.equal((await run(flags)).code, 0);
  assert.equal(n, 1);
  assert.equal((await run(flags)).code, 0);       // not yet
  assert.equal(n, 1);
  await new Promise((r) => setTimeout(r, 2200));
  nextAt = Date.now() + 20 * 3600e3;
  assert.equal((await run(flags)).code, 0);       // now it may: sent, 2 s after the last push
  assert.equal(n, 2);
  assert.equal((await run(flags)).code, 0);       // and then 11 h again
  assert.equal(n, 2);
  reader.close(); backend.close();
});

// ── Powerfox (poweropti) via the Powerfox cloud ─────────────────────────────
function fakePowerfox() {
  const f = { answer: { Outdated: false, Watt: 200, Timestamp: Math.floor(Date.now() / 1000), A_Plus: 1004.5 } };
  f.srv = http.createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    res.setHeader("content-type", "application/json");
    if (auth !== "me@example.de:pw-123") { res.statusCode = 401; return res.end("{}"); }
    res.end(JSON.stringify(f.answer));
  }).listen(0, "127.0.0.1");
  return new Promise((r) => f.srv.on("listening", () => { f.url = `http://127.0.0.1:${f.srv.address().port}/api/2.0`; r(f); }));
}

test("--powerfox reads the meter total from the Powerfox cloud and keeps the login for later runs", async () => {
  const pf = await fakePowerfox();
  const seen = [];
  const backend = await fake((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { seen.push(JSON.parse(b).reading); res.end("{}"); }); });
  const ingest = `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`;
  const env = { GUL_POWERFOX_URL: pf.url };
  let r = await run(["--once", "--powerfox=me@example.de", "--powerfox-pass=pw-123", ingest], env);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(seen, [1004.5]);
  const cfg = JSON.parse(readFileSync(join(dir, ".gul-bridge-127.json"), "utf8"));
  assert.equal(cfg.powerfoxUser, "me@example.de");

  pf.answer = { Outdated: false, Timestamp: Math.floor(Date.now() / 1000), A_Plus: 0, A_Plus_HT: 600.25, A_Plus_NT: 410.5 };
  r = await run(["--once", "--powerfox", ingest], env);               // bare: the saved login
  assert.equal(r.code, 0, r.out);
  assert.equal(seen[1], 1010.75, "only tariff registers: their sum");

  pf.answer = { StatusCode: 412 };
  r = await run(["--once", "--powerfox", ingest], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /switch on data transfer/);

  pf.answer = { Outdated: true, A_Plus: 2000 };
  r = await run(["--once", "--powerfox", ingest], env);
  assert.equal(r.code, 1);
  assert.match(r.out, /old reading/);
  assert.equal(seen.length, 2, "nothing sent for a refused or outdated reading");
  pf.srv.close(); backend.close();
});

test("a wrong Powerfox password is said plainly and not saved", async () => {
  const pf = await fakePowerfox();
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
  const fresh = mkdtempSync(join(tmpdir(), "gul pf "));
  copyFileSync(join(__dirname, "index.js"), join(fresh, "gul.js"));
  const p = spawn(process.execPath, [join(fresh, "gul.js"), "--once", "--token=t1", "--powerfox=me@example.de", "--powerfox-pass=wrong", `--ingest=http://127.0.0.1:${backend.address().port}/x`], { env: { ...process.env, GUL_POWERFOX_URL: pf.url, GUL_RETRY_WAIT_MS: "50" } });
  let out = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c));
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 1);
  assert.match(out, /didn't accept the e-mail and password/);
  const cfg = JSON.parse(readFileSync(join(fresh, ".gul-bridge-127.json"), "utf8"));
  assert.equal(cfg.powerfoxPass, undefined);
  pf.srv.close(); backend.close();
});

test("the scheduled job says --powerfox but never carries the password", async () => {
  const pf = await fakePowerfox();
  const backend = await fake((req, res) => { req.resume(); req.on("end", () => res.end("{}")); });
  const tabFile = join(dir, "crontab-pf.txt");
  require("node:fs").writeFileSync(tabFile, "");
  const binDir = mkdtempSync(join(tmpdir(), "fakecron"));
  require("node:fs").writeFileSync(join(binDir, "crontab"), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${tabFile}"; else cat > "${tabFile}"; fi\n`, { mode: 0o755 });
  const r = await run(["--install", "--powerfox=me@example.de", "--powerfox-pass=pw-123", `--ingest=http://127.0.0.1:${backend.address().port}/meter-ingest`], { GUL_POWERFOX_URL: pf.url, PATH: `${binDir}:${process.env.PATH}` });
  assert.equal(r.code, 0, r.out);
  const tab = readFileSync(tabFile, "utf8");
  assert.match(tab, / --powerfox /);
  assert.doesNotMatch(tab, /pw-123/);
  assert.doesNotMatch(tab, /me@example\.de/);
  pf.srv.close(); backend.close();
});
