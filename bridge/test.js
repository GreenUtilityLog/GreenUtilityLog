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
  assert.ok(existsSync(join(dir, ".gul-bridge.log")), "every run is logged next to the script");
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
  const mode = require("node:fs").statSync(join(dir, ".gul-bridge.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dir, ".gul-bridge.json"), "utf8")).token, "t1");
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
  assert.match(tab, /--once '--ip=127\.0\.0\.1:\d+'/, "where to read is carried into the job");

  await run(["--install", ...flags], env);
  tab = readFileSync(cronFile, "utf8");
  assert.equal((tab.match(/# GreenUtilityLog/g) || []).length, 1, "installing again replaces, not duplicates");

  const u = await run(["--uninstall"], env);
  assert.equal(u.code, 0, u.out);
  assert.equal(readFileSync(cronFile, "utf8"), "MAILTO=me\n5 4 * * * /usr/bin/backup\n");
  reader.close(); backend.close();
});
