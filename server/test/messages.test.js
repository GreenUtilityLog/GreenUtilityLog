// ── The server's messages in the app's languages (messages.js) ────────────────
// Every message a user can be shown must have a row, in all four languages, with
// the same {placeholders}. Written as a check on the source, so a new message
// without a translation fails here rather than reaching users in English.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MESSAGES, translateMessage } from "../messages.js";
import { startServer, stateWithBaseline, WALLET } from "./helpers.mjs";

const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// English on purpose: the admin screen is English, these are internal, or the text
// comes from somewhere else (a provider, the AI check).
const ENGLISH_ONLY = new Set([
  "not an admin wallet", "invalid target wallet", "target wallet is required", "refusing to ban an admin wallet",
  "refusing to signal an admin wallet", "a reason is required", "provide a meter number or a wallet",
  "old and new meter numbers are required", "the new meter number is the same as the old one",
  "the new meter number is registered to another wallet", "this meter has no owner yet — fill in the wallet it belongs to",
  "move failed", "could not read the passport contract", "txid is required", "invalid amount", "mode must be gm, roles or everyone",
  "certificate does not authorise this action", "state not loaded yet", "ocr not configured", "not allowed", "too many requests",
  "request too large", "invalid JSON", "expired", "the photo could not be read",
  // A contract's own revert reason, shown inside "payout would revert: {reason}".
  "execution reverted",
  // The image classifier's own label, logged and flagged, not shown as a refusal.
  'image looks like "7" (confidence 7)',
]);

// String literals given as an error or reason, outside the /admin/* routes, with
// each ${…} turned into a sample value so templates are checked too.
function userMessages() {
  const out = new Set();
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".js"))) {
    let src = readFileSync(join(DIR, f), "utf8");
    if (f === "index.js") {
      // Drop the admin route handlers: from each app.<verb>("/admin/… to the next route.
      src = src.split(/(?=\napp\.(?:get|post)\(")/).filter((part) => !/^\napp\.(?:get|post)\("\/admin\//.test(part)).join("");
    }
    // `error: "…"`, `error: cond ? "…"` and `error: x || "…"`.
    for (const m of src.matchAll(/(?:error|reason|noReward)\s*[:=]\s*(?:[^"`\n;]*?(?:\?|\|\|)\s*)?"((?:[^"\\\n]|\\.){8,})"/g)) out.add(JSON.parse(`"${m[1]}"`));
    // Texts handed to users through helpers: publicError("…") and fail("code", "…").
    for (const m of src.matchAll(/(?:publicError\(|fail\(\s*"\w+"\s*,)\s*"((?:[^"\\\n]|\\.){8,})"/g)) out.add(JSON.parse(`"${m[1]}"`));
    for (const m of src.matchAll(/(?:publicError\(|fail\(\s*"\w+"\s*,)\s*`([^`\n]{8,})`/g)) {
      if (/\$\{[^}]*[?`]/.test(m[1])) continue;
      out.add(m[1].replace(/\$\{[^}]*\}/g, "7"));
    }
    // Template literals without nested ones: each ${…} becomes a sample value.
    for (const m of src.matchAll(/(?:error|reason|noReward)\s*[:=]\s*(?:[^"`\n;]*?\?\s*)?`([^`\n]{8,})`/g)) {
      // A part that is itself a choice (a plural, an optional clause) can't be
      // sampled this way; those messages have their own rows and checks below.
      if (/\$\{[^}]*[?`]/.test(m[1])) continue;
      out.add(m[1].replace(/\$\{[^}]*\}/g, "7"));
    }
  }
  return [...out].filter((m) => /[a-z]{3}/.test(m) && !/^[\w.]+$/.test(m));
}

test("every message a user can get has a translation", () => {
  const missing = userMessages().filter((m) => !ENGLISH_ONLY.has(m) && translateMessage(m, "nl") === m);
  assert.deepEqual(missing, [], "add these to server/messages.js (or to ENGLISH_ONLY if they really stay English)");
});

// Returned by helper functions (not as `error:` literals), so the scan above can't see
// them: the photo-check limits, the one-phone-one-wallet check and the access gate.
test("refusals returned by helpers have a translation too", () => {
  for (const m of [
    "too many photo attempts today — try again tomorrow",
    "the photo check has reached today's limit — please try again tomorrow",
    "the app didn't say which phone this is — reload the app and try again",
    "this phone is already used by 1 other wallet — one person, one wallet",
    "this phone is already used by 2 other wallets — one person, one wallet",
    "couldn't check this wallet's VeBetterDAO GM NFT right now — please try again in a minute",
    "this version is for VeBetterDAO members: the wallet needs a Galaxy Member (GM) NFT and a VeBetterDAO Passport that counts it as a person",
    "this wallet has a GM NFT, but its VeBetterDAO Passport doesn't count it as a person yet",
    "couldn't check this wallet's VeBetterDAO Passport right now — please try again in a minute",
    "you used 2 kWh in 3 hour(s), against a target of 1 kWh — recorded, no saving to reward this time",
  ]) assert.notEqual(translateMessage(m, "nl"), m, m);
});

test("every row is complete and keeps its placeholders in all languages", () => {
  const seen = new Set();
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const row of MESSAGES) {
    assert.equal(row.length, 5, row[0]);
    assert.ok(!seen.has(row[0]), `duplicate row: ${row[0]}`);
    seen.add(row[0]);
    for (let i = 1; i < 5; i++) {
      assert.ok(row[i] && row[i] !== row[0] || /^[^a-z]*$/i.test(row[0]), `row ${row[0]} language ${i} is empty or English`);
      assert.equal(ph(row[i]), ph(row[0]), `placeholders differ in ${row[0]} (language ${i})`);
    }
  }
});

test("templates fill in their parts", () => {
  assert.equal(translateMessage("current reading (995) can't be lower than the last recorded reading (1000)", "nl"),
    "de huidige stand (995) kan niet lager zijn dan de laatst vastgelegde stand (1000)");
  assert.equal(translateMessage("cooldown active — try again in ~42 min", "de"), "Wartezeit läuft noch — versuch es in ~42 Min. erneut");
  assert.equal(translateMessage("something not in the table", "fr"), "something not in the table");
  // The messages with a choice in them, in each form.
  assert.match(translateMessage("this week's reward budget is used up — rewards resume after the next VeBetterDAO round (in about 1 day)", "nl"), /over ongeveer 1 dag\)$/);
  assert.match(translateMessage("this week's reward budget is used up — rewards resume after the next VeBetterDAO round (in about 4 days)", "nl"), /over ongeveer 4 dagen\)$/);
  assert.match(translateMessage("the reading you entered (1010) is not what the photo shows (it reads 1001, 22) — check the number and try again", "de"), /dort steht 1001, 22/);
  assert.match(translateMessage("the reading you entered (1010) is not what the photo shows — check the number and try again", "es"), /no es la que muestra la foto/);
  assert.equal(translateMessage("invalid wallet address", "en"), "invalid wallet address");
});

test("the server answers in the app's language, with the English alongside", async () => {
  const srv = await startServer({ state: stateWithBaseline() });
  try {
    const nl = await fetch(srv.base + "/meter/pair", { method: "POST", headers: { "Content-Type": "application/json", "X-GUL-Lang": "nl" }, body: JSON.stringify({ address: "nope" }) });
    const body = await nl.json();
    assert.equal(nl.status, 400);
    assert.equal(body.error, "ongeldig wallet-adres");
    assert.equal(body.errorEn, "invalid wallet address");
    // No header (a reader, an old app): English, as before.
    const en = await srv.post("/meter/pair", { address: "nope" });
    assert.equal(en.body.error, "invalid wallet address");
    assert.equal(en.body.errorEn, undefined);
    // A recorded reading's reason, in Spanish.
    const es = await fetch(srv.base + "/reward", { method: "POST", headers: { "Content-Type": "application/json", "X-GUL-Lang": "es" },
      body: JSON.stringify({ utility: "electric", meterNo: "E1000", address: WALLET, reading: 990, prevRead: 1000, photo: "x" }) });
    assert.match((await es.json()).error, /no puede ser menor|foto/);
  } finally { await srv.stop(); }
});
