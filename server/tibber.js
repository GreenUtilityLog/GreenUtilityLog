// ── Tibber (Pulse) — readings straight from the Tibber cloud ──────────────────
// A Tibber Pulse reads the HAN/P1 port of a meter (common in Sweden, Norway,
// Denmark and Finland, and in Germany and the Netherlands) and sends it to
// Tibber. Tibber has a public API that takes a personal access token the user
// makes at developer.tibber.com, so this server can fetch the meter total
// itself — nothing to install, nothing to keep switched on.
//
// The token is stored sealed with the same key as Powerfox logins
// (POWERFOX_SECRET, see powerfox.js), never logged and never sent back.
//
// Two steps, both documented by Tibber:
//   1. POST {api} query viewer { websocketSubscriptionUrl homes { id features {
//      realTimeConsumptionEnabled } } } — which home has a Pulse, and where
//      the live data is served.
//   2. A GraphQL subscription over a websocket (graphql-transport-ws): the first
//      liveMeasurement that carries lastMeterConsumption — the meter's import
//      register in kWh — is the reading; then the socket is closed.
// Tibber asks clients to send a User-Agent naming themselves.

import WebSocket from "ws";

const API = (process.env.TIBBER_API_URL || "https://api.tibber.com/v1-beta/gql").replace(/\/$/, "");
const UA = "GreenUtilityLog/1.0 (+https://github.com/GreenUtilityLog/GreenUtilityLog)";
const LIVE_WAIT_MS = Number(process.env.TIBBER_LIVE_WAIT_MS || 30000);

const fail = (code, error) => ({ ok: false, code, error });

// → { ok:true, reading, at, homeId } or { ok:false, code, error } with an error
// a user can act on. Never includes the token.
export async function fetchTibberReading(token) {
  let res, body;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({ query: "{ viewer { websocketSubscriptionUrl homes { id features { realTimeConsumptionEnabled } } } }" }),
      signal: AbortSignal.timeout(20000),
    });
    body = await res.json().catch(() => null);
  } catch {
    return fail("unreachable", "Tibber can't be reached right now — try again later");
  }
  const authError = res.status === 401 || res.status === 403
    || (body?.errors || []).some((e) => /unauthori[sz]ed|invalid token|token/i.test(String(e?.message || "")) && !body?.data?.viewer);
  if (authError) return fail("auth", "Tibber didn't accept this token — copy it again from developer.tibber.com");
  const viewer = body?.data?.viewer;
  if (!res.ok || !viewer) return fail("bad_answer", "Tibber gave no answer we could use — try again later");
  const home = (viewer.homes || []).find((h) => h?.features?.realTimeConsumptionEnabled);
  if (!home) return fail("no_pulse", "no Tibber Pulse found on this account — the Pulse has to be set up in the Tibber app");
  const url = String(viewer.websocketSubscriptionUrl || "");
  if (!/^wss?:\/\//.test(url)) return fail("bad_answer", "Tibber gave no live-data address — try again later");

  const live = await liveMeterTotal(url, token, home.id);
  return live.ok ? { ...live, homeId: home.id } : live;
}

function liveMeterTotal(url, token, homeId) {
  return new Promise((resolve) => {
    let done = false, sawData = false;
    const ws = new WebSocket(url, "graphql-transport-ws", { headers: { "User-Agent": UA } });
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.send(JSON.stringify({ id: "1", type: "complete" })); } catch {}
      try { ws.close(); } catch {}
      resolve(out);
    };
    const timer = setTimeout(() => finish(sawData
      ? fail("no_total", "your Pulse sends live data but no meter total — not every meter reports it")
      : fail("no_data", "your Pulse sent no live data — check in the Tibber app that it is online")), LIVE_WAIT_MS);
    ws.on("open", () => ws.send(JSON.stringify({ type: "connection_init", payload: { token } })));
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "connection_ack") {
        ws.send(JSON.stringify({
          id: "1", type: "subscribe",
          payload: { query: `subscription { liveMeasurement(homeId: ${JSON.stringify(homeId)}) { timestamp lastMeterConsumption } }` },
        }));
      } else if (m.type === "next") {
        const lm = m.payload?.data?.liveMeasurement;
        if (!lm) return;
        sawData = true;
        const v = Number(lm.lastMeterConsumption);
        if (lm.lastMeterConsumption != null && Number.isFinite(v) && v > 0) {
          const t = Date.parse(lm.timestamp);
          finish({ ok: true, reading: +v.toFixed(3), at: Number.isFinite(t) ? t : Date.now() });
        }
      } else if (m.type === "error" || m.type === "connection_error") {
        finish(fail("bad_answer", "Tibber refused the live data — try again later"));
      }
    });
    ws.on("unexpected-response", (_req, r) => finish(r.statusCode === 401 || r.statusCode === 403
      ? fail("auth", "Tibber didn't accept this token — copy it again from developer.tibber.com")
      : fail("unreachable", "Tibber's live data can't be reached right now — try again later")));
    ws.on("error", () => finish(fail("unreachable", "Tibber's live data can't be reached right now — try again later")));
    ws.on("close", () => finish(fail("no_data", "your Pulse sent no live data — check in the Tibber app that it is online")));
  });
}
