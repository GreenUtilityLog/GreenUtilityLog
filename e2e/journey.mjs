// ── End-to-end: the built app, a real server, a wallet that signs ─────────────
// Unit tests prove the parts. This proves the whole: the production build of the
// app in Chromium (phone-sized), against the real reward server (dry-run payouts,
// certificates required), with a VeWorld stand-in that signs certificates for
// real. It walks what a user does and fails on anything a user would hit: a step
// that doesn't work, a page error, a CSP violation, a console error.
//
// Run it (CI does, .github/workflows/e2e.yml):
//   VITE_REWARD_API=https://e2e-api.test npx vite build --outDir e2e-dist
//   (cd server && npm install --omit=optional)
//   node e2e/journey.mjs
// Needs the `playwright` package and a Chromium for it. PLAYWRIGHT_MODULE can point
// at another copy of playwright's index.mjs; CHROMIUM_PATH at another browser.
// Screenshots of every step land in e2e-out/.
//
// Nothing leaves the machine: the app's API host (https://e2e-api.test) is routed
// to the local server, the VeChain node is answered by a small stand-in, and every
// other outside request is dropped.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Certificate, Secp256k1, Address, ABIFunction } from "@vechain/sdk-core";

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = process.env.E2E_DIST || join(ROOT, "e2e-dist");
const OUT = join(ROOT, "e2e-out");
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const API = "https://e2e-api.test";
const API_PORT = 4390, APP_PORT = 4175;
const STATE = join(mkdtempSync(join(tmpdir(), "gul-e2e-")), "state.json");
const PRIV = await Secp256k1.generatePrivateKey();
const ADDR = Address.ofPrivateKey(PRIV).toString();
const DAY = 86_400_000;

// The wallet already registered meter E1000 a day ago at 1000 kWh, so the first
// photo here covers a day and pays. (A first-ever reading, which pays nothing, is
// covered by the server's own tests.)
const key = "electric:e1000";
writeFileSync(STATE, JSON.stringify({
  meterOwners: { [key]: ADDR.toLowerCase() }, readings: { [key]: 1000 }, readingAts: { [key]: Date.now() - DAY },
  passesInit: 1,
}));

const log = (...a) => console.log("•", ...a);
const problems = [];
const api = []; // every API call the app made, with its answer

// ── processes ────────────────────────────────────────────────────────────────
function proc(cmd, args, env, cwd) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.out = () => out; return p;
}
const server = proc(process.execPath, ["index.js"], {
  PORT: String(API_PORT), STATE_FILE: STATE, REQUIRE_CERT: "true", DISTRIBUTOR_DRY_RUN: "true", REQUIRE_PASS: "false",
  WALLET_CHECK: "off", INGEST_MIN_INTERVAL_MS: "0", COOLDOWN_MS: "0", OCR_ENABLED: "false", AUTO_CLAIM_ON_PUSH: "on",
  UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", NODE_URL: "http://127.0.0.1:9", NETWORK: "testnet",
}, join(ROOT, "server"));
// On 127.0.0.1 explicitly: vite's default "localhost" can resolve to ::1 only (as in
// CI's Playwright container), and everything here talks to 127.0.0.1.
const preview = proc(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "preview", "--outDir", DIST, "--host", "127.0.0.1", "--port", String(APP_PORT), "--strictPort"], {}, ROOT);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 90; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await wait(500); }
  throw new Error(`not up: ${url}\n${server.out().slice(-2000)}\n${preview.out().slice(-2000)}`);
}
let browser;
async function finish(code) {
  try { await browser?.close(); } catch {}
  server.kill("SIGTERM"); preview.kill("SIGTERM");
  process.exit(code);
}
try {
  await up(`http://127.0.0.1:${API_PORT}/health`);
  await up(`http://127.0.0.1:${APP_PORT}/GreenUtilityLog/`);
} catch (e) { console.error(e.message); await finish(1); }
log("server and app are up");

// ── browser ──────────────────────────────────────────────────────────────────
browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ ...devices["iPhone 13"] });

// VeWorld stand-in: dapp-kit's "veworld" source asks window.vechain for a signer;
// this one signs certificates with the test wallet's key, in Node.
await ctx.exposeBinding("__gulSign", async (_src, msgJson) => {
  const msg = JSON.parse(msgJson);
  const annex = { domain: `localhost:${APP_PORT}`, timestamp: Math.floor(Date.now() / 1000), signer: ADDR.toLowerCase() };
  const c = Certificate.of({ purpose: msg.purpose, payload: msg.payload, ...annex });
  c.sign(PRIV);
  const signature = typeof c.signature === "string" ? c.signature : "0x" + Buffer.from(c.signature).toString("hex").replace(/^0x/, "");
  return { annex, signature };
});
await ctx.addInitScript(([addr]) => {
  window.vechain = {
    newConnexSigner: () => ({
      signCert: async (msg) => window.__gulSign(JSON.stringify(msg)),
      signTx: async () => { throw new Error("no transactions in this test"); },
    }),
  };
  try {
    if (!localStorage.getItem("e2e-init")) {
      localStorage.setItem("e2e-init", "1");
      localStorage.setItem("dappkit@vechain/v2/source", "veworld");
      localStorage.setItem("dappkit@vechain/v2/account", addr);
    }
  } catch {}
  document.addEventListener("securitypolicyviolation", (e) => console.error("CSP-VIOLATION", e.violatedDirective, e.blockedURI));
}, [ADDR]);

// The test wallet holds a Galaxy Member NFT: token 7, level 2 (Moon). The stand-in
// node answers the GalaxyMember contract's calls, and the IPFS gateway answers its
// metadata and picture. Only on the mainnet node: the app reads the GM NFT there
// even in this testnet build, since that's where users' NFTs are.
const GM_CONTRACT = "0x93b8cd34a7fc4f53271b9011161f7a2b5fea9d1f";
const selector = (name, types) => new ABIFunction({ name, type: "function", stateMutability: "view", inputs: types.map((type, i) => ({ name: `a${i}`, type })), outputs: [] }).signatureHash.slice(0, 10);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const abiString = (str) => { const b = Buffer.from(str, "utf8"); return word(32) + word(b.length) + b.toString("hex").padEnd(Math.max(64, Math.ceil(b.length / 32) * 64), "0"); };
const GM_ANSWERS = {
  [selector("getSelectedTokenId", ["address"])]: "0x" + word(7),
  [selector("balanceOf", ["address"])]: "0x" + word(1),
  [selector("levelOf", ["uint256"])]: "0x" + word(2),
  [selector("tokenURI", ["uint256"])]: "0x" + abiString("ipfs://bafye2egmmeta/metadata/2.json"),
  [selector("MAX_LEVEL", [])]: "0x" + word(10),
};
// A 1×1 PNG, for the NFT's picture.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Outside requests: the API goes to the local server, the VeChain node to the
// stand-in, the rest is dropped (fonts, WalletConnect, …) so the run needs no network.
const GENESIS = { id: "0x000000000b2bce3c70bc649a02749e8687721b09ed2e15997f466536b20bb127", number: 0, timestamp: 1530014400, gasLimit: 10000000, parentID: "0xffffffff00000000000000000000000000000000000000000000000000000000", size: 170, beneficiary: "0x0000000000000000000000000000000000000000", gasUsed: 0, totalScore: 0, txsRoot: "0x" + "0".repeat(64), txsFeatures: 0, stateRoot: "0x" + "0".repeat(64), receiptsRoot: "0x" + "0".repeat(64), signer: "0x0000000000000000000000000000000000000000", isTrunk: true, transactions: [] };
await ctx.route((url) => !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url.href), async (route) => {
  const u = new URL(route.request().url());
  if (u.origin === API) {
    const local = route.request().url().replace(API, `http://127.0.0.1:${API_PORT}`);
    try {
      const res = await route.fetch({ url: local });
      if (!/^\/(health|wallet\/seen|meter\/latest|meter\/registered)/.test(u.pathname)) {
        let body = ""; try { body = await res.text(); } catch {}
        api.push({ method: route.request().method(), path: u.pathname, status: res.status(), body });
      }
      return route.fulfill({ response: res });
    } catch { return route.abort(); }
  }
  if (/^(testnet|mainnet)\.vechain\.org$/.test(u.hostname)) {
    const json = (o) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname.startsWith("/blocks/0") || u.pathname.startsWith("/blocks/0x000000000b2b")) return json(GENESIS);
    if (u.pathname.startsWith("/blocks/best")) return json({ ...GENESIS, id: "0x0100000a" + "1".repeat(56), number: 16777226, timestamp: Math.floor(Date.now() / 1000) });
    if (u.pathname.startsWith("/logs/event")) return json([]);
    if (u.pathname.startsWith("/accounts/*")) return json([{ data: "0x" + "0".repeat(64), events: [], transfers: [], gasUsed: 0, reverted: false, vmError: "" }]);
    if (u.hostname === "mainnet.vechain.org" && u.pathname.toLowerCase() === `/accounts/${GM_CONTRACT}` && route.request().method() === "POST") {
      const data = String(JSON.parse(route.request().postData() || "{}").data || "");
      const out = GM_ANSWERS[data.slice(0, 10)];
      return json({ data: out || "0x", events: [], transfers: [], gasUsed: 0, reverted: !out, vmError: out ? "" : "execution reverted" });
    }
    if (u.pathname.startsWith("/accounts/")) return json({ balance: "0x0", energy: "0x0", hasCode: false });
    return json(null);
  }
  if (u.hostname === "api.gateway-proxy.vechain.org") {
    if (u.pathname === "/ipfs/bafye2egmmeta/metadata/2.json") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ name: "Moon", image: "ipfs://bafye2egmimg/2.png" }) });
    if (u.pathname === "/ipfs/bafye2egmimg/2.png") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  }
  return route.abort();
});

const page = await ctx.newPage();
// A failed request is expected (outside hosts are dropped, the app goes offline on
// purpose); anything else in the console as an error is a problem.
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_|ERR_INTERNET_DISCONNECTED|Error getting account domain/.test(m.text())) problems.push("console: " + m.text().slice(0, 300)); });
page.on("pageerror", (e) => problems.push("page error: " + e.message.slice(0, 300)));
const shot = (n) => page.screenshot({ path: join(OUT, n + ".png") }).catch(() => {});
const text = async () => (await page.locator("#root").innerText()).replace(/\n+/g, " | ");
const lastCall = (path) => api.filter((c) => c.path === path).pop();
async function meterPhoto(shown) {
  const p = await browser.newPage({ viewport: { width: 800, height: 400 } });
  await p.setContent(`<body style="margin:0;background:#8a9;display:flex;align-items:center;justify-content:center;height:400px"><div style="background:#cfd8c0;font:bold 120px monospace;padding:20px 40px">${shown}</div></body>`);
  const buf = await p.screenshot({ type: "jpeg" }); await p.close(); return buf;
}
const idbCount = () => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("GreenUtilityLog", 1);
  r.onsuccess = () => { try { const q = r.result.transaction("submissions").objectStore("submissions").getAll(); q.onsuccess = () => res(q.result.length); } catch { res(0); } };
  r.onerror = () => res(-1);
}));

let failed = 0;
async function step(name, fn) {
  try { await fn(); log("ok  ", name); }
  catch (e) { failed++; log("FAIL", name, "—", e.message.split("\n").slice(0, 6).join(" / ")); await shot("FAIL-" + name.replace(/\W+/g, "_")); }
}

// Photograph the meter, enter the reading, submit. `shown` is what the photo shows.
async function submitPhoto(reading, label, shown = reading) {
  await page.locator(".bnav button").nth(1).click(); await wait(800);
  await page.locator("#gul-meter-photo").setInputFiles({ name: "meter.jpg", mimeType: "image/jpeg", buffer: await meterPhoto(shown) });
  await wait(1200);
  const scan = page.getByRole("button", { name: /Scan this area|Scan dit deel/i }).first();
  if (await scan.count()) await scan.click();
  await page.getByText(/✓ Verified|Verification failed|✓ Gecontroleerd|Controle mislukt/i).first().waitFor({ timeout: 90000 });
  await page.locator("input[inputmode=decimal]:visible").last().fill(String(reading));
  await wait(300);
  await shot(`${label}-filled`);
  const before = api.filter((c) => c.path === "/reward").length;
  await page.getByRole("button", { name: /submit|insturen/i }).last().click();
  for (let i = 0; i < 60 && api.filter((c) => c.path === "/reward").length === before; i++) await wait(250);
  await wait(1500);
  await shot(`${label}-after`);
  return lastCall("/reward");
}

// ── the journey ──────────────────────────────────────────────────────────────
await page.goto(`http://127.0.0.1:${APP_PORT}/GreenUtilityLog/`, { waitUntil: "networkidle" });
await wait(1500);

await step("intro, and registering the meter", async () => {
  for (let i = 0; i < 8; i++) {
    const b = page.getByRole("button", { name: /next|get started|start|let's go|skip/i }).first();
    if (!(await b.count())) break;
    await b.click(); await wait(400);
  }
  assert.match(await text(), /Register Your Meters/i, "the registration screen follows the intro");
  const inputs = page.locator("input:visible");
  await inputs.nth(0).fill("E1000");
  await inputs.nth(1).fill("1000");
  await page.getByRole("button", { name: /complete setup/i }).click(); await wait(1200);
  await shot("01-home");
  assert.doesNotMatch(await text(), /Register Your Meters/i, "registration closes");
});

await step("a photo reading a day after the last one pays", async () => {
  const r = await submitPhoto("1003.5", "02-paid");
  assert.ok(r, "the app sent the reading");
  assert.equal(r.status, 200, r.body);
  const b = JSON.parse(r.body);
  assert.ok(b.amount > 0 && b.txid, `paid: ${r.body}`);
});

await step("Home, History and Progress show it", async () => {
  await page.locator(".bnav button").nth(0).click(); await wait(1200); await shot("03-home");
  assert.match(await text(), /\+\d+\.\d\d B3TR/, "today's reward on Home");
  // The app's own tiers are gone: the level that counts is the GM NFT (Profile).
  assert.doesNotMatch(await text(), /\btier\b/i, "no app tier on Home");
  // The app's level, by readings sent in: one reading so far is the first level.
  assert.match(await text(), /🌱 Seedling \| level/i, "the level on Home");
  await page.locator(".bnav button").nth(3).click(); await wait(600);
  await page.getByRole("button", { name: /history/i }).first().click(); await wait(1200); await shot("04-history");
  assert.match(await text(), /1 total/, "one row in History");
  await page.locator(".bnav button").nth(2).click(); await wait(1200); await shot("05-progress");
  assert.match(await text(), /kWh/, "Progress renders");
  assert.match(await text(), /\d+\.\d\d B3TR earned in total/, "the total on Progress");
  // The paid reading saved energy; the app doesn't know its previous reading (only
  // the server does), so this is the saving the server paid on.
  const saved = Number((/([\d.]+) kWh \| saved/i.exec(await text()) || [])[1]);
  assert.ok(saved > 0, `kWh saved on Progress is ${saved}, not more than 0`);
  assert.doesNotMatch(await text(), /\btier\b/i, "no app tier on Progress");
  assert.match(await text(), /Level Seedling/, "the level on Progress");
  const toGo = /(\d+) more readings to Sprout · (\d+)%/.exec(await text());
  assert.ok(toGo && Number(toGo[1]) >= 1 && Number(toGo[1]) <= 9, `readings to the next level: ${toGo?.[0]}`);
  assert.equal(await page.getByRole("progressbar", { name: "Progress to Sprout" }).getAttribute("aria-valuenow"), toGo[2], "the bar matches");
});

await step("Profile shows the wallet's GM NFT", async () => {
  await page.locator(".bnav button").nth(3).click(); await wait(2500);
  await shot("05b-profile-gm");
  // A badge at the bottom of the account card, upper-cased in CSS (innerText
  // returns it as shown): level name and level, with the token in its title.
  const hero = page.locator(".profile-hero");
  assert.match(await hero.innerText(), /GM Moon · Level 2 of 10/i, "the GM badge is in the account card");
  assert.equal(await hero.locator('[title="VeBetterDAO GM NFT #7"]').count(), 1, "its token number");
  const img = hero.locator('img[src="https://api.gateway-proxy.vechain.org/ipfs/bafye2egmimg/2.png"]');
  assert.equal(await img.count(), 1, "its picture, from VeChain's IPFS gateway");
  assert.ok(await img.evaluate((el) => el.complete && el.naturalWidth > 0), "the picture loaded (CSP allows it)");
  // A name of the full 24 characters shows whole, not cut off with "…".
  const NAME = "MrUnknownVeChainSaver123";
  await hero.getByRole("button", { name: "Edit" }).click(); await wait(400);
  await hero.getByPlaceholder("Your name").fill(NAME);
  await hero.getByRole("button", { name: "Save" }).click(); await wait(400);
  await shot("05c-profile-name");
  const pname = hero.locator(".pname");
  assert.equal(await pname.innerText(), NAME, "the name as typed");
  assert.ok(await pname.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== "ellipsis"), "the whole name is visible");
});

await step("a reader: pair, push, and its reading appears", async () => {
  await page.locator(".bnav button").nth(1).click(); await wait(800);
  await page.getByText(/Have a meter reader/i).first().click(); await wait(1500);
  await page.getByText(/Automatic setup/).first().click(); await wait(800);
  await page.getByRole("button", { name: /Get my device token/i }).click(); await wait(3000);
  await shot("06-token");
  const pair = lastCall("/meter/pair");
  assert.equal(pair?.status, 200, pair?.body);
  const { token } = JSON.parse(pair.body);
  const r = await fetch(`http://127.0.0.1:${API_PORT}/meter-ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, reading: 1005.5 }) });
  assert.equal(r.status, 200, await r.text());
  await wait(17000); // the card polls every 15 s
  await shot("07-reader");
  assert.match(await text(), /1005\.5/, "the pushed reading shows in the app");
});

await step("offline: a reading is queued, and sent when back online", async () => {
  await page.locator(".bnav button").nth(1).click(); await wait(800);
  const photoTab = page.getByRole("button", { name: /📸 Photo/ }).first();
  if (await photoTab.count()) { await photoTab.click(); await wait(500); }
  await ctx.setOffline(true); await wait(500);
  await submitPhoto("1007.0", "08-offline");
  assert.equal(await idbCount(), 1, "one reading queued on the phone");
  await ctx.setOffline(false);
  for (let i = 0; i < 40 && (await idbCount()) > 0; i++) await wait(500);
  await shot("09-online-again");
  assert.equal(await idbCount(), 0, "the queue was sent and emptied");
  assert.equal(lastCall("/reward")?.status, 200, lastCall("/reward")?.body);
});

await step("Dutch: the app, and the server's messages", async () => {
  await page.locator(".bnav button").nth(3).click(); await wait(600);
  await page.getByRole("button", { name: /settings/i }).first().click(); await wait(800);
  await page.getByText("Nederlands", { exact: true }).first().click(); await wait(1000);
  await page.locator(".bnav button").nth(0).click(); await wait(800);
  assert.match(await text(), /VOORTGANG|Voortgang/, "the menu is Dutch");
  // The GM badge on Profile, in Dutch too: the level's name and the level line.
  await page.locator(".bnav button").nth(3).click(); await wait(1500);
  await shot("10-nl-profile");
  const prof = await text();
  assert.match(prof, /GM Maan · Niveau 2 van 10/i, "the GM badge is Dutch");
  assert.match(prof, /niveau (kiemplant|spruit)/i, "the app's level badge, in Dutch");
  // No app tier badge ("Niveau Maan") next to the GM level, and no English left over.
  assert.doesNotMatch(prof, /niveau maan/i, "no app tier badge on Profile");
  assert.doesNotMatch(prof, /\bmoon\b/i, "no English level name on Profile");
  await page.locator(".bnav button").nth(0).click(); await wait(500);
  // The same reading again, on a new photo: the server refuses it, in Dutch.
  const photoTab = page.getByRole("button", { name: /📸 Foto/ }).first();
  await page.locator(".bnav button").nth(1).click(); await wait(800);
  if (await photoTab.count()) { await photoTab.click(); await wait(500); }
  const r = await submitPhoto("1007.0", "10-nl", "01007.0");
  assert.equal(r?.status, 400, r?.body);
  const b = JSON.parse(r.body);
  assert.ok(b.errorEn, "the English text travels along");
  assert.match(b.error, /stand is al ingestuurd/, "the server answered in Dutch");
  assert.match(await text(), /stand is al ingestuurd/, "and the app shows it");
});

// ── result ───────────────────────────────────────────────────────────────────
writeFileSync(join(OUT, "api.json"), JSON.stringify(api, null, 1));
writeFileSync(join(OUT, "server.log"), server.out());
for (const p of problems) log("PROBLEM", p);
const ok = failed === 0 && problems.length === 0;
console.log(ok ? "\nAll steps passed, no page errors, no CSP violations." : `\n${failed} step(s) failed, ${problems.length} problem(s). Screenshots and logs: e2e-out/`);
await finish(ok ? 0 : 1);
