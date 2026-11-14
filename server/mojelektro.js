// ── MojElektro (Slovenia) — readings from the grid operators' portal ─────────
// Slovenian smart meters report to the distribution companies, and their joint
// portal mojelektro.si has an API: a customer makes a personal token there
// ("Moj profil" → "Kreiraj žeton") and finds the metering point's id (EIMM) under
// "Merilna mesta". With those two this server can fetch the meter total itself —
// nothing to install.
//
// OFF until a Slovenian tester has tried it: MOJELEKTRO=on switches it on (and,
// like Powerfox and Tibber, it needs POWERFOX_SECRET to seal the token). The
// request below follows the open-source clients that use this API (psvent's
// Moj-Elektro-API-Client, frlequ's Home Assistant integration); the official
// description is at docs.informatika.si/mojelektro/api.
//
// GET {api}/meter-readings?usagePoint=<EIMM>&startTime=YYYY-MM-DD&endTime=YYYY-MM-DD
//     &option=ReadingType=<code>   (repeatable), header X-API-TOKEN
// → { intervalBlocks: [{ readingType, intervalReadings: [{ timestamp, value }] }] }
//
// The reading types asked for are the daily register states ("24 urno stanje") of
// the energy taken from the grid (A+), in kWh: a total that only goes up, like the
// number on the meter. 1.8.0 is the total; meters that only keep the two tariff
// registers (VT/MT) give their sum. The data arrive a day late, so a reading
// carries the meter's own time (`at`), and the payout measures its span to then
// (validateSubmission's readAt).

const API = (process.env.MOJELEKTRO_API_URL || "https://api.informatika.si/mojelektro/v1").replace(/\/$/, "");
const UA = "GreenUtilityLog/1.0 (+https://github.com/GreenUtilityLog/GreenUtilityLog)";

export const READING_TYPES = {
  total: "32.0.4.1.1.2.12.0.0.0.0.0.0.0.0.3.72.0", // A+ total (ET), daily state
  high: "32.0.4.1.1.2.12.0.0.0.0.1.0.0.0.3.72.0",  // A+ high tariff (VT)
  low: "32.0.4.1.1.2.12.0.0.0.0.2.0.0.0.3.72.0",   // A+ low tariff (MT)
};

export const mojElektroSwitchedOn = () => /^(on|1|true|yes)$/i.test(String(process.env.MOJELEKTRO || "").trim());

// A metering point's id: digits, letters and dashes (the EIMM, or the GSRN some
// screens show). Loose on purpose: the portal is the judge, this only keeps junk out.
export const validUsagePoint = (s) => /^[0-9A-Za-z-]{6,40}$/.test(String(s || ""));
export const validToken = (s) => /^[A-Za-z0-9._~+/=-]{16,400}$/.test(String(s || ""));

const fail = (code, error) => ({ ok: false, code, error });
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
// "2026-11-13T00:00:00+0100" (no colon in the offset) is not ISO for Date.parse.
const when = (s) => Date.parse(String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

// The latest { at, value } of one reading type, or null.
function latestOf(blocks, code) {
  let best = null;
  for (const b of blocks) {
    if (String(b?.readingType || "") !== code) continue;
    for (const r of Array.isArray(b.intervalReadings) ? b.intervalReadings : []) {
      const at = when(r?.timestamp), v = Number(r?.value);
      if (!Number.isFinite(at) || !Number.isFinite(v) || v <= 0) continue;
      if (!best || at > best.at) best = { at, value: v };
    }
  }
  return best;
}

// The meter total from one answer: { reading, at } or null.
export function mojElektroTotal(body) {
  const blocks = Array.isArray(body?.intervalBlocks) ? body.intervalBlocks : [];
  const total = latestOf(blocks, READING_TYPES.total);
  if (total) return { reading: +total.value.toFixed(3), at: total.at };
  const hi = latestOf(blocks, READING_TYPES.high), lo = latestOf(blocks, READING_TYPES.low);
  // Both tariffs, for the same moment, or the sum isn't a reading.
  if (hi && lo && hi.at === lo.at) return { reading: +(hi.value + lo.value).toFixed(3), at: hi.at };
  return null;
}

// → { ok:true, reading, at } or { ok:false, code, error } with an error a user can
// act on. Never includes the token.
export async function fetchMojElektroReading(token, usagePoint, now = Date.now()) {
  const qs = new URLSearchParams({ usagePoint, startTime: day(now - 6 * 86400000), endTime: day(now + 86400000) });
  for (const code of Object.values(READING_TYPES)) qs.append("option", `ReadingType=${code}`);
  let res, body;
  try {
    res = await fetch(`${API}/meter-readings?${qs}`, {
      headers: { "X-API-TOKEN": token, Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(20000),
    });
    body = await res.json().catch(() => null);
  } catch {
    return fail("unreachable", "MojElektro can't be reached right now — try again later");
  }
  if (res.status === 401 || res.status === 403) return fail("auth", "MojElektro didn't accept this token — make a new one under Moj profil on mojelektro.si");
  if (res.status === 404 || res.status === 400) return fail("usage_point", "MojElektro doesn't know this metering point — copy the EIMM from Merilna mesta on mojelektro.si");
  if (!res.ok || !body) return fail("bad_answer", "MojElektro gave no answer we could use — try again later");
  const t = mojElektroTotal(body);
  if (!t) return fail("no_data", "MojElektro has no daily meter total for this metering point yet — it shows up a day after the meter sends it");
  return { ok: true, reading: t.reading, at: t.at };
}
