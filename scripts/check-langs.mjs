// ── Checks the app's languages (run in CI, next to the build) ─────────────────
// A text that is missing, lost a {placeholder} or a link, or dropped the ⚠️/❌ at
// its start (the app uses that to keep an error on screen) shows up wrong in the
// app without failing the build. This checks the five built-in languages and every
// extra one in src/lang/, and the Help and FAQ in each.
//   node scripts/check-langs.mjs
import { readdirSync } from "node:fs";
import { TEXTS, CORE_LANGS, EXTRA_LANGS, LANGS, loadLang, langPack } from "../src/i18n.js";
import { HELP_I18N, HELP_MAINNET } from "../src/help.js";

const problems = [];
const bad = (msg) => problems.push(msg);
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const urls = (s) => [...s.matchAll(/https?:\/\/[^\s)"'”]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")).sort();
// The emoji a text starts with, if any.
const lead = (s) => (/^(\p{Extended_Pictographic}️?)/u.exec(s) || [])[1] || "";
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

// One translated text against its English source.
function compare(where, en, tr) {
  if (!nonEmpty(tr)) return bad(`${where}: missing`);
  if (ph(tr) !== ph(en)) bad(`${where}: placeholders {${ph(tr)}} instead of {${ph(en)}}`);
  const ue = urls(en), ut = urls(tr);
  for (const u of ue) if (!ut.includes(u)) bad(`${where}: link ${u} is missing`);
  if (lead(en) !== lead(tr)) bad(`${where}: starts with "${lead(tr)}" instead of "${lead(en)}"`);
}

// Help: the same steps and answers as the English, in the same order.
const HELP_FIELDS = ["subtitle", "quick", "faqLabel", "close", "feedback"];
const MAINNET_FIELDS = ["connect", "earn", "real", "wallet"];
const atTestnet = (list, f) => list.map((x, i) => (/testnet/i.test(x[f]) ? i : -1)).filter((i) => i >= 0).join(",");
function checkHelp(code, L, mainnet) {
  const E = HELP_I18N.en;
  if (!L) return bad(`${code} help: missing`);
  for (const f of HELP_FIELDS) compare(`${code} help.${f}`, E[f], L[f]);
  if (L.steps?.length !== E.steps.length) bad(`${code} help: ${L.steps?.length} steps instead of ${E.steps.length}`);
  if (L.faqs?.length !== E.faqs.length) bad(`${code} help: ${L.faqs?.length} answers instead of ${E.faqs.length}`);
  E.steps.forEach((s, i) => { compare(`${code} help step ${i + 1} title`, s.t, L.steps?.[i]?.t); compare(`${code} help step ${i + 1}`, s.d, L.steps?.[i]?.d); });
  E.faqs.forEach((f, i) => { compare(`${code} help question ${i + 1}`, f.q, L.faqs?.[i]?.q); compare(`${code} help answer ${i + 1} ("${f.q}")`, f.a, L.faqs?.[i]?.a); });
  // The mainnet build swaps the parts that mention testnet, by position (App.jsx).
  if (code !== "en" && L.steps && L.faqs) {
    if (CORE_LANGS[code] && atTestnet(L.steps, "d") !== atTestnet(E.steps, "d")) bad(`${code} help: the testnet steps sit elsewhere than in English`);
    if (CORE_LANGS[code] && atTestnet(L.faqs, "a") !== atTestnet(E.faqs, "a")) bad(`${code} help: the testnet answers sit elsewhere than in English`);
  }
  if (!mainnet) return bad(`${code} helpMainnet: missing`);
  for (const f of MAINNET_FIELDS) compare(`${code} helpMainnet.${f}`, HELP_MAINNET.en[f], mainnet[f]);
}

// The built-in languages.
for (const [key, row] of Object.entries(TEXTS)) {
  if (!nonEmpty(row.en)) bad(`${key}: no English`);
  for (const code of Object.keys(CORE_LANGS)) if (code !== "en") compare(`${code} ${key}`, row.en, row[code]);
}
for (const code of Object.keys(CORE_LANGS)) checkHelp(code, HELP_I18N[code], HELP_MAINNET[code]);

// The extra languages: each file listed in i18n.js, and each listed one a file.
const files = readdirSync(new URL("../src/lang/", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
for (const f of files) if (!EXTRA_LANGS.includes(f) && f !== ".gitkeep") bad(`src/lang/${f}.js is not listed in EXTRA in src/i18n.js`);
// `node scripts/check-langs.mjs it el` checks only those extra languages.
const only = process.argv.slice(2);
for (const code of EXTRA_LANGS) {
  if (only.length && !only.includes(code)) continue;
  if (CORE_LANGS[code]) { bad(`${code} is built in and listed as extra`); continue; }
  try { await loadLang(code); } catch (e) { bad(`${code}: can't load (${e.message})`); continue; }
  const pack = langPack(code);
  if (pack.name !== LANGS[code]) bad(`${code}: name "${pack.name}" differs from "${LANGS[code]}" in i18n.js`);
  const texts = pack.texts || {};
  for (const k of Object.keys(texts)) if (!TEXTS[k]) bad(`${code}: "${k}" is not a key (any more)`);
  for (const [key, row] of Object.entries(TEXTS)) compare(`${code} ${key}`, row.en, texts[key]);
  checkHelp(code, pack.help, pack.helpMainnet);
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in the app's languages:\n  ` + problems.slice(0, 200).join("\n  "));
  process.exit(1);
}
console.log(`languages ok: ${Object.keys(TEXTS).length} texts in ${Object.keys(LANGS).length} languages (${Object.keys(LANGS).join(", ")}), with Help`);
