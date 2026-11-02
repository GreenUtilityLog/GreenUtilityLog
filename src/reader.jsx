// Setting up an automatic reader: the HomeWizard/Home Assistant/Tasmota steps,
// Tibber and Powerfox. Split out of App.jsx and loaded on demand (React.lazy).
import { useState, useEffect } from "react";
import { useWallet } from "@vechain/dapp-kit-react";
import { t } from "./i18n.js";
import { NETWORK, REWARD_API, INGEST_FLAG } from "./network.js";
import { DARK, GUIDE_URL, BRIDGE_JS_URL, USAGE_RANGES, RULES, MAX_SPAN_DAYS, SERVER_NEXT_AT, fetchT, fmtDay, fmtWhen, validDeviceToken } from "./App.jsx";

// Our Home Assistant integration sends to the bridge's default server unless told
// otherwise. A build with its own backend (INGEST_FLAG set: mainnet, say) has to
// say so, or readings land on the wrong server and are never paid.
function IngestUrlStep({ API }) {
  if (!INGEST_FLAG) return null;
  return (
    <li>In the same setup screen, set <b>Server address</b> to{" "}
      <span style={{ fontFamily: "'SF Mono',Menlo,monospace", wordBreak: "break-all" }}>{`${API}/meter-ingest`}</span>{" "}
      — the integration's default is a different server.</li>
  );
}

// ── Smart-meter card (beta) ──────────────────────────────────────────────────
// The friendly, photoless path. Everyday users just type their current reading and
// tap one button — no camera, no OCR. Under the hood the value goes to the same
// backend store a real reader would push to (device token, cached after a one-time
// pairing), then the photoless payout endpoint issues B3TR. All the technical bits
// (device token, ingest URL, P1/Home-Assistant setup) live in a collapsed
// "Automatic setup" section so they never clutter the simple flow.
// Tibber Pulse (Sweden, Norway, Denmark, Finland, and more): the server fetches
// the meter total from the Tibber cloud with the user's personal access token;
// or Home Assistant's own Tibber integration feeds ours.
function TibberSetup({ T, API, wallet, meterNo, token, latest, health, onLinked, requestCertificate, copy, copied }) {
  const serverOn = !!health?.tibber?.enabled;
  const [route, setRoute] = useState(serverOn ? "server" : "ha");
  const [tibberToken, setTibberToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);   // { ok, text }
  const tb = latest?.tibber || null;
  const card = { padding: 12, background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 10 };
  const input = { width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 14, color: T.text, background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, outline: "none", fontFamily: "'SF Mono',Menlo,monospace" };
  const label = { display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, margin: "10px 0 5px" };
  const primary = { width: "100%", minHeight: 44, marginTop: 10, border: "none", borderRadius: 6, background: T.green2, color: T === DARK ? T.bg : "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer" };
  const sign = async (content) => {
    const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
    return { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
  };
  const connect = async () => {
    setMsg(null);
    if (!meterNo) { setMsg({ ok: false, text: t("r.registerFirst") }); return; }
    if (tibberToken.trim().length < 20) { setMsg({ ok: false, text: t("tb.needToken") }); return; }
    if (!consent) { setMsg({ ok: false, text: t("tb.needConsent") }); return; }
    setBusy(true);
    try {
      const certificate = await sign(`Green Utility Log — link Tibber\nWallet: ${wallet}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`);
      const r = await fetchT(`${API}/meter/tibber/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, meterNo, tibberToken: tibberToken.trim(), certificate }) }, 60000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `connecting failed (${r.status})`);
      setTibberToken("");
      setMsg({ ok: true, text: t("r.checkTotal", { who: "Tibber", n: d.reading }) });
      onLinked?.(d.token);
    } catch (e) {
      setMsg({ ok: false, text: e?.message || t("r.connectFailed") });
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!window.confirm(t("tb.confirmOff"))) return;
    setBusy(true);
    try {
      const certificate = await sign(`Green Utility Log — unlink Tibber\nWallet: ${wallet}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`);
      const r = await fetchT(`${API}/meter/tibber/unlink`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, certificate }) });
      if (!r.ok) throw new Error("couldn't disconnect — try again");
      setMsg({ ok: true, text: t("tb.off") });
      onLinked?.();
    } catch (e) { setMsg({ ok: false, text: e?.message || t("r.disconnectFailed") }); }
    finally { setBusy(false); }
  };
  const routes = [
    ...(serverOn ? [{ id: "server", title: t("r.route.server"), sub: t("r.route.server.sub") }] : []),
    { id: "ha", title: t("r.route.ha"), sub: t("r.route.ha.sub") },
  ];
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: T.textMid, lineHeight: 1.6, marginBottom: 8 }}>
        {t("tb.need")}
      </div>
      <div role="radiogroup" aria-label={t("tb.how")} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {routes.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={route === r.id} onClick={() => setRoute(r.id)}
            style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, cursor: "pointer", background: route === r.id ? (T.green5 || T.bgAlt) : T.card, border: `${route === r.id ? 2 : 1}px solid ${route === r.id ? T.green3 : T.border}` }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: T.text }}>{route === r.id ? "● " : "○ "}{r.title}</div>
            <div style={{ fontSize: 11, color: T.textSoft, marginTop: 2 }}>{r.sub}</div>
          </button>
        ))}
      </div>

      {route === "server" && (
        <div style={card}>
          {tb?.linked ? (<>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: T.text }}>{t("tb.connected")}</div>
            <div style={{ fontSize: 11, color: T.textSoft, marginTop: 4, lineHeight: 1.5 }}>
              {t("r.everyHour", { last: tb.lastPullAt ? t("r.lastTime", { when: fmtWhen(tb.lastPullAt) }) : "" })}
            </div>
            {tb.lastError && <div style={{ fontSize: 11, color: T.gas, marginTop: 6, lineHeight: 1.5 }}>⚠️ {tb.lastError}</div>}
            <button type="button" disabled={busy} onClick={disconnect} style={{ marginTop: 10, minHeight: 40, padding: "0 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textMid, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              {busy ? "…" : t("tb.disconnect")}
            </button>
          </>) : (<>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: T.textMid, lineHeight: 1.7 }}>
              <li>{t("tb.s1")}</li>
              <li>{t("tb.s2")}</li>
              <li>{t("tb.s3")}</li>
            </ol>
            <label style={label} htmlFor="tb-token">{t("tb.label")}</label>
            <input id="tb-token" type="password" autoComplete="off" spellCheck={false} value={tibberToken} onChange={(e) => setTibberToken(e.target.value)} style={input} />
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: 11, color: T.textMid, lineHeight: 1.5, cursor: "pointer" }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
              <span>{t("tb.consent")}</span>
            </label>
            <button type="button" disabled={busy} onClick={connect} style={{ ...primary, opacity: busy ? .6 : 1 }}>{busy ? t("r.connecting30") : t("tb.connect")}</button>
          </>)}
          {msg && <div role="status" style={{ marginTop: 8, fontSize: 11, fontWeight: 700, lineHeight: 1.5, color: msg.ok ? T.green3 : T.gas }}>{msg.text}</div>}
        </div>
      )}

      {route === "ha" && (
        <div style={card}>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: T.textMid, lineHeight: 1.7 }}>
            <li>In Home Assistant: <b>Settings → Devices &amp; services → Add integration → Tibber</b>. Paste your Tibber token.</li>
            <li>Add <b>our</b> integration (HACS → custom repository <span style={{ fontFamily: "'SF Mono',Menlo,monospace" }}>GreenUtilityLog/GreenUtilityLog</span> → GreenUtilityLog).</li>
            <li>Paste your device token: <span style={{ fontFamily: "'SF Mono',Menlo,monospace", wordBreak: "break-all" }}>{token}</span></li>
            <IngestUrlStep API={API} />
            <li>Pick the Tibber sensor <b>Last meter consumption</b> (kWh) — the meter's own total.</li>
          </ol>
          <button type="button" onClick={() => copy(token, "tbtok")} style={{ marginTop: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none", background: copied === "tbtok" ? T.green3 : T.textSoft, color: "#fff", cursor: "pointer" }}>
            {copied === "tbtok" ? t("r.tokenCopied") : t("r.copyTokenShort")}
          </button>
          {INGEST_FLAG && (
            <button type="button" onClick={() => copy(`${API}/meter-ingest`, "tburl")} style={{ marginTop: 8, marginLeft: 6, padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none", background: copied === "tburl" ? T.green3 : T.textSoft, color: "#fff", cursor: "pointer" }}>
              {copied === "tburl" ? t("r.addrCopied") : t("r.copyAddr")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Powerfox (poweropti, Germany): three ways in, easiest first. The server can
// fetch the reading from the Powerfox cloud itself (nothing to keep running at
// home); or the bridge on your own computer does it; or Home Assistant's own
// Powerfox integration feeds ours.
function PowerfoxSetup({ T, API, wallet, meterNo, token, latest, health, onLinked, requestCertificate, copy, copied, os, setOs, fetchCmd, needNode }) {
  const [route, setRoute] = useState(health?.powerfox?.enabled ? "server" : "computer");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);   // { ok, text }
  const pf = latest?.powerfox || null;
  const serverOn = !!health?.powerfox?.enabled;
  const card = { padding: 12, background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 10 };
  const input = { width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 14, color: T.text, background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, outline: "none" };
  const label = { display: "block", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, margin: "10px 0 5px" };
  const primary = { width: "100%", minHeight: 44, marginTop: 10, border: "none", borderRadius: 6, background: T.green2, color: T === DARK ? T.bg : "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer" };
  const sign = async (content) => {
    const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
    return { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
  };
  const connect = async () => {
    setMsg(null);
    if (!meterNo) { setMsg({ ok: false, text: t("r.registerFirst") }); return; }
    if (!email.trim() || !password) { setMsg({ ok: false, text: t("pf.needLogin") }); return; }
    if (!consent) { setMsg({ ok: false, text: t("pf.needConsent") }); return; }
    setBusy(true);
    try {
      const certificate = await sign(`Green Utility Log — link Powerfox\nWallet: ${wallet}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`);
      const r = await fetchT(`${API}/meter/powerfox/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, meterNo, email: email.trim(), password, certificate }) }, 60000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `connecting failed (${r.status})`);
      setPassword("");
      setMsg({ ok: true, text: d.outdated
        ? t("pf.old")
        : t("r.checkTotal", { who: "Powerfox", n: d.reading }) });
      onLinked?.(d.token);
    } catch (e) {
      setMsg({ ok: false, text: e?.message || t("r.connectFailed") });
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!window.confirm(t("pf.confirmOff"))) return;
    setBusy(true);
    try {
      const certificate = await sign(`Green Utility Log — unlink Powerfox\nWallet: ${wallet}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`);
      const r = await fetchT(`${API}/meter/powerfox/unlink`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, certificate }) });
      if (!r.ok) throw new Error("couldn't disconnect — try again");
      setMsg({ ok: true, text: t("pf.off") });
      onLinked?.();
    } catch (e) { setMsg({ ok: false, text: e?.message || t("r.disconnectFailed") }); }
    finally { setBusy(false); }
  };
  const routes = [
    ...(serverOn ? [{ id: "server", title: t("r.route.server"), sub: t("r.route.server.sub") }] : []),
    { id: "computer", title: t("r.route.pc"), sub: t("r.route.pc.sub") },
    { id: "ha", title: t("r.route.ha"), sub: t("r.route.ha.sub") },
  ];
  const cmd = `${needNode}

${fetchCmd(`--ask-token --powerfox=YOUR_POWERFOX_EMAIL --install${INGEST_FLAG}`)}

# It asks for your device token (tap “Copy token”) and your Powerfox password
# (not shown as you type), once, and keeps them in a private file next to
# gul.js. Then it sends your reading by itself, every day.`;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: T.textMid, lineHeight: 1.6, marginBottom: 8 }}>
        {t("pf.first")}
      </div>
      <div role="radiogroup" aria-label={t("pf.how")} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {routes.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={route === r.id} onClick={() => setRoute(r.id)}
            style={{ textAlign: "left", padding: "10px 12px", borderRadius: 10, cursor: "pointer", background: route === r.id ? (T.green5 || T.bgAlt) : T.card, border: `${route === r.id ? 2 : 1}px solid ${route === r.id ? T.green3 : T.border}` }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: T.text }}>{route === r.id ? "● " : "○ "}{r.title}</div>
            <div style={{ fontSize: 11, color: T.textSoft, marginTop: 2 }}>{r.sub}</div>
          </button>
        ))}
      </div>

      {route === "server" && (
        <div style={card}>
          {pf?.linked ? (<>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: T.text }}>{t("pf.connected")}</div>
            <div style={{ fontSize: 11, color: T.textSoft, marginTop: 4, lineHeight: 1.5 }}>
              We fetch your reading every hour{pf.lastPullAt ? ` — last time ${fmtWhen(pf.lastPullAt)}` : ""}. Payouts follow automatically — after your first photo submission, which sets the starting point (until then, automatic readings are not paid).
            </div>
            {pf.lastError && <div style={{ fontSize: 11, color: T.gas, marginTop: 6, lineHeight: 1.5 }}>⚠️ {pf.lastError}</div>}
            <button type="button" disabled={busy} onClick={disconnect} style={{ marginTop: 10, minHeight: 40, padding: "0 12px", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.textMid, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              {busy ? "…" : t("pf.disconnect")}
            </button>
          </>) : (<>
            <div style={{ fontSize: 11, color: T.textMid, lineHeight: 1.6 }}>
              {t("pf.login")}
            </div>
            <label style={label} htmlFor="pf-email">{t("pf.email")}</label>
            <input id="pf-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={input} />
            <label style={label} htmlFor="pf-pass">{t("pf.pass")}</label>
            <input id="pf-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: 11, color: T.textMid, lineHeight: 1.5, cursor: "pointer" }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
              <span>{t("pf.consent")}</span>
            </label>
            <button type="button" disabled={busy} onClick={connect} style={{ ...primary, opacity: busy ? .6 : 1 }}>{busy ? t("r.connecting") : t("pf.connect")}</button>
          </>)}
          {msg && <div role="status" style={{ marginTop: 8, fontSize: 11, fontWeight: 700, lineHeight: 1.5, color: msg.ok ? T.green3 : T.gas }}>{msg.text}</div>}
        </div>
      )}

      {route === "computer" && (
        <div style={card}>
          <div style={{ fontSize: 11, color: T.textMid, lineHeight: 1.6, marginBottom: 8 }}>
            {t("pf.pc")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: T.textSoft, fontWeight: 700 }}>{t("r.runningOn")}</span>
            {[{ id: "win", label: "Windows" }, { id: "unix", label: "Mac · Linux · Pi" }].map((o) => (
              <button key={o.id} type="button" onClick={() => setOs(o.id)}
                style={{ padding: "5px 9px", fontSize: 10, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: `1px solid ${os === o.id ? T.green3 : T.border}`, background: os === o.id ? T.green3 : "transparent", color: os === o.id ? "#fff" : T.textMid }}>
                {o.label}
              </button>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <button type="button" onClick={() => copy(cmd, "pfcmd")} style={{ position: "absolute", top: 6, right: 6, padding: "4px 8px", fontSize: 10, fontWeight: 700, border: "none", borderRadius: 6, cursor: "pointer", background: copied === "pfcmd" ? T.green3 : T.textSoft, color: "#fff" }}>
              {copied === "pfcmd" ? "✓ Copied" : "Copy"}
            </button>
            <pre style={{ fontFamily: "'SF Mono',Menlo,monospace", fontSize: 10, lineHeight: 1.5, color: T.text, background: T.card, border: `1px dashed ${T.border}`, padding: 10, borderRadius: 6, overflowX: "auto", margin: 0, whiteSpace: "pre" }}>{cmd}</pre>
          </div>
          <button type="button" onClick={() => copy(token, "pfcomptok")} style={{ marginTop: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none", background: copied === "pfcomptok" ? T.green3 : T.textSoft, color: "#fff", cursor: "pointer" }}>
            {copied === "pfcomptok" ? t("r.tokenCopied") : t("r.copyTokenShort")}
          </button>
        </div>
      )}

      {route === "ha" && (
        <div style={card}>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: T.textMid, lineHeight: 1.7 }}>
            <li>In Home Assistant: <b>Settings → Devices &amp; services → Add integration → Powerfox</b>. Log in with your Powerfox account.</li>
            <li>Add <b>our</b> integration (HACS → custom repository <span style={{ fontFamily: "'SF Mono',Menlo,monospace" }}>GreenUtilityLog/GreenUtilityLog</span> → GreenUtilityLog).</li>
            <li>Paste your device token: <span style={{ fontFamily: "'SF Mono',Menlo,monospace", wordBreak: "break-all" }}>{token}</span></li>
            <IngestUrlStep API={API} />
            {/* Not "Combine the state of several sensors": that helper's state_class
                is measurement, and our integration refuses a sensor that can reset.
                A sensor group of the two total_increasing registers stays one. */}
            <li>Pick the Powerfox sensor <b>Energy usage</b> (kWh). Meter with two tariffs and that one stays empty? Add the high- and low-tariff sensors together with <b>Settings → Devices &amp; services → Helpers → Create helper → Group → Sensor group</b>, type <b>Sum</b>, and pick that group.</li>
          </ol>
          <button type="button" onClick={() => copy(token, "pftok")} style={{ marginTop: 8, padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none", background: copied === "pftok" ? T.green3 : T.textSoft, color: "#fff", cursor: "pointer" }}>
            {copied === "pftok" ? t("r.tokenCopied") : t("r.copyTokenShort")}
          </button>
          {INGEST_FLAG && (
            <button type="button" onClick={() => copy(`${API}/meter-ingest`, "pfurl")} style={{ marginTop: 8, marginLeft: 6, padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none", background: copied === "pfurl" ? T.green3 : T.textSoft, color: "#fff", cursor: "pointer" }}>
              {copied === "pfurl" ? t("r.addrCopied") : t("r.copyAddr")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SmartMeterCard({ wallet, setReading, T, onAutoSubmit, autoBusy, meterNo, embedded = false }) {
  const { requestCertificate } = useWallet();
  const API = REWARD_API.replace(/\/$/, "");
  const ingestUrl = `${API}/meter-ingest`;
  const tkKey = wallet ? `gul_mtoken_${wallet.toLowerCase()}` : "";

  const [health, setHealth]   = useState(null);
  const [latest, setLatest]   = useState(null);   // { paired, reading }
  const [token, setToken]     = useState("");     // paired device token (cached)
  const [busy, setBusy]       = useState("");     // which action is running
  const [err, setErr]         = useState("");
  const [copied, setCopied]   = useState("");
  const [open, setOpen]       = useState(!!embedded); // embedded → always expanded (no toggle)
  const [advOpen, setAdvOpen] = useState(false);
  const [device, setDevice]   = useState("homewizard"); // which setup snippet to show
  const [relinked, setRelinked] = useState(""); // "" | "same" | "new" after a re-link
  // Which shell the command is written for. Guessed from the browser, but only as a
  // starting point: most people open this app on a phone and set the bridge up on a
  // different machine, so the guess is worthless without a way to change it. It
  // matters because the two commands are not interchangeable — a bash line pasted
  // into PowerShell fails to parse, which is exactly how testers got stuck.
  const [os, setOs] = useState(() => {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    return /Mac|iPhone|iPad|Linux|Android/i.test(ua) && !/Windows/i.test(ua) ? "unix" : "win";
  });

  const signCert = async () => {
    const content = `Green Utility Log — link smart meter\nWallet: ${wallet}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`;
    const cert = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
    return { purpose: "identification", payload: { type: "text", content }, domain: cert.annex.domain, timestamp: cert.annex.timestamp, signer: cert.annex.signer, signature: cert.signature };
  };

  const refreshLatest = async () => {
    if (!API || !wallet) return;
    try {
      // Readings are only returned with this wallet's device token: the address
      // alone is public, and live readings show when someone is home.
      const r = await fetchT(`${API}/meter/latest?address=${wallet}`, token ? { headers: { "x-device-token": token } } : undefined);
      if (r.ok) setLatest(await r.json());
    } catch { /* offline — leave as-is */ }
  };

  // Load backend capabilities once; load any cached device token for this wallet.
  useEffect(() => {
    if (!API) return;
    fetchT(`${API}/health`).then(r => r.ok ? r.json() : null).then(h => h && setHealth(h)).catch(() => {});
  }, [API]);
  useEffect(() => {
    if (!tkKey) { setToken(""); return; }
    // An invalid stored token counts as none: pairing again replaces it.
    try { const t = localStorage.getItem(tkKey) || ""; setToken(validDeviceToken(t) ? t : ""); } catch { /* no storage */ }
  }, [tkKey]);
  useEffect(() => {
    if (!open || !wallet) return;
    refreshLatest();
    const id = setInterval(refreshLatest, 15000);
    return () => clearInterval(id);
  }, [open, wallet, API, token]);

  // Pair once (one wallet signature ever) and remember the token so future sends
  // need no popup. Returns the token to use for /meter-ingest.
  const ensureToken = async () => {
    if (token) return token;
    const certificate = await signCert();
    // Send the registered meter number so the backend scheduler (auto-submit) knows
    // which meter's baseline to measure this wallet's readings against.
    const r = await fetchT(`${API}/meter/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: wallet, meterNo: meterNo || "", certificate }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `pairing failed (${r.status})`);
    if (!validDeviceToken(d.token)) throw new Error("pairing failed (the server sent an unexpected device token)");
    setToken(d.token);
    try { localStorage.setItem(tkKey, d.token); } catch { /* no storage */ }
    return d.token;
  };

  // The token on screen comes out of localStorage and was never checked against the
  // server, so a browser holding a token the backend has forgotten shows it forever
  // — and every reader using it is told "unknown device token", which reads like the
  // device's fault. The backend forgets one whenever its state starts fresh: a new
  // durable store, a pairing whose write was lost, a different backend.
  //
  // Pairing again is the repair. It returns the SAME token when the server still
  // knows this wallet, so pressing this when nothing is wrong changes nothing.
  const relinkDevice = async () => {
    setErr(""); setBusy("relink");
    try {
      const certificate = await signCert();
      const r = await fetchT(`${API}/meter/pair`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, meterNo: meterNo || "", certificate }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `pairing failed (${r.status})`);
      if (!validDeviceToken(d.token)) throw new Error("re-linking failed (the server sent an unexpected device token)");
      const changed = d.token !== token;
      setToken(d.token);
      try { localStorage.setItem(tkKey, d.token); } catch { /* no storage */ }
      setRelinked(changed ? "new" : "same");
    } catch (e) { setErr(e?.message || "could not re-link this device"); }
    finally { setBusy(""); }
  };


  // A photo can only capture one of a double-tariff meter's two registers, while the
  // reader reports their sum, so the stored starting point and everything the reader
  // sends afterwards are on different scales and no claim can ever succeed. This asks
  // the backend to take the reader's current value as the starting point instead.
  // Allowed only until this pairing has been paid once; the backend enforces that.
  const doRebaseline = async () => {
    setErr(""); setBusy("rebase");
    try {
      // Its own purpose line, not the pairing one it used to borrow: the server
      // binds each signature to the action it was signed for, so a signature made
      // to pair a reader cannot be spent on moving a baseline.
      const content = `Green Utility Log — confirm starting point correction\nWallet: ${wallet}\nMeter: ${meterNo || ""}\nNetwork: ${NETWORK}\nTime: ${new Date().toISOString()}`;
      const c = await requestCertificate({ purpose: "identification", payload: { type: "text", content } }, { signer: wallet });
      const certificate = { purpose: "identification", payload: { type: "text", content }, domain: c.annex.domain, timestamp: c.annex.timestamp, signer: c.annex.signer, signature: c.signature };
      const r = await fetchT(`${API}/meter/rebaseline`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet, certificate, meterNo }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `couldn't update the starting point (${r.status})`);
      await refreshLatest();
    } catch (e) { setErr(e?.message || "updating the starting point failed"); }
    finally { setBusy(""); }
  };

  const showToken = async () => {   // Advanced: reveal/create the device token for a reader
    setErr("");
    try { await ensureToken(); } catch (e) { setErr(e?.message || "pairing failed"); }
  };

  // writeText returns a promise; unawaited, a refusal (in-app browsers often have
  // no clipboard permission) surfaced as an uncaught error while the button said
  // "Copied". Only say so when it actually was.
  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag); setTimeout(() => setCopied(""), 1500);
    } catch {
      setErr(t("r.copyByHand"));
    }
  };

  const rd = latest?.reading;
  // A gap bigger than the maximum plausible usage over the longest span the backend
  // will ever count isn't usage at all — it means the stored starting point and the
  // reader are measuring different things. Derived from the same numbers the
  // plausibility check uses, so it cannot drift away from what the server enforces.
  const gapKwh = (rd && Number.isFinite(Number(latest?.baseline)))
    ? +(Number(rd.reading) - Number(latest.baseline)).toFixed(3) : null;
  const scaleMismatch = !!latest?.canRebaseline && gapKwh != null
    && gapKwh > USAGE_RANGES.electric.max * MAX_SPAN_DAYS;
  const busyAny = !!autoBusy;
  // Split for the timeline: the day on one line, the time under it.
  const dayTime = (ts) => {
    const w = fmtWhen(ts), t = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return { day: w.slice(0, w.length - t.length).trim(), time: t };
  };
  const lastPayout = latest?.lastPayout || null;
  const paidThis = !!(lastPayout && rd && Number(lastPayout.reading) === Number(rd.reading));
  // A reading must be under 48 h old to be paid; older means the reader stopped.
  const readerFresh = !!(rd?.at && Date.now() - rd.at < 48 * 3600e3);
  // When the next reward can come: the server's own answer when we have it,
  // else the last payout plus the cooldown.
  const nextAt = Object.prototype.hasOwnProperty.call(SERVER_NEXT_AT, "electric")
    ? (Number(SERVER_NEXT_AT.electric) || 0)
    : (lastPayout?.at ? lastPayout.at + RULES.cooldownMs : 0);
  const timeline = (() => {
    const steps = [];
    if (rd?.at) steps.push({ at: rd.at, ...dayTime(rd.at), title: t("r.received"), sub: t("r.received.sub", { n: rd.reading }), done: true });
    if (lastPayout?.at) steps.push({ at: lastPayout.at, ...dayTime(lastPayout.at), title: `Paid +${Number(lastPayout.amount).toFixed(2)} B3TR`, sub: "automatically, on VeChain", done: true });
    steps.sort((a, b) => a.at - b.at);
    steps.push(nextAt > Date.now()
      ? { ...dayTime(nextAt), title: t("r.nextReward"), sub: t("r.sendsAfter"), done: false }
      : { day: "", time: t("today.now"), title: t("r.nextReward"), sub: paidThis || !rd ? t("r.paidNext") : t("r.canPay"), done: false });
    return steps;
  })();
  const box = { margin: "0 14px 12px", padding: 12, background: T.ecoBg || T.waterBg, border: `1px solid ${T.ecoBorder || T.waterBorder}`, borderRadius: 10 };
  const btn = (bg) => ({ padding: "9px 12px", fontSize: 12, fontWeight: 700, color: "#fff", background: bg, border: "none", borderRadius: 6, cursor: "pointer" });
  const mono = { fontFamily: "'SF Mono',Menlo,'Courier New',monospace" };

  if (!API) return null;

  return (
    <div style={box}>
      <button onClick={embedded ? undefined : () => setOpen(o => !o)} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 10, background: "none", border: "none", cursor: embedded ? "default" : "pointer", padding: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: T.eco || T.water }}>{t("r.title")} <span style={{ fontWeight: 600, color: T.textSoft }}>{t("r.title.sub")}</span></span>
        {!embedded && <span style={{ color: T.textSoft, fontSize: 13 }}>{open ? "▲" : "▼"}</span>}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          {rd == null && (
            <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6, marginBottom: 10 }}>
              {t("r.intro")}
            </div>
          )}

          {!wallet ? (
            <div style={{ fontSize: 11, color: T.textSoft }}>{t("r.connectWallet")}</div>
          ) : rd != null ? (
            /* A real reader (P1, Powerfox, Tibber) pushed a reading — claim it with one tap, no
               photo needed (the device token binds it to your wallet). */
            <>
            {/* Status at a glance: is the reader alive, what arrived, what was paid,
                and when the next reward can come — the questions people actually
                asked when a day went missing. */}
            <div style={{ padding: "12px", background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 800, color: T.text }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: readerFresh ? T.green3 : T.electric, flexShrink: 0 }} />
                  {rd.source === "powerfox" ? "Powerfox" : rd.source === "tibber" ? "Tibber" : t("r.p1")}
                </div>
                <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".6px", padding: "3px 8px", borderRadius: 999, color: readerFresh ? T.green3 : T.electric, background: readerFresh ? (T.green5 || T.bgAlt) : (T.electricBg || T.bgAlt) }}>
                  {readerFresh ? t("today.reader.ok") : t("today.reader.stale")}
                </span>
              </div>
              {/* Automatic payouts need a photo now and then (the server pauses them
                  otherwise). Said here, before it happens: a week ahead, and plainly
                  once it has. */}
              {Number(latest?.photoDueAt) > 0 && Date.now() > Number(latest.photoDueAt) - 7 * 86400000 && (
                <div role="status" style={{ marginTop: 8, fontSize: 11, fontWeight: 700, lineHeight: 1.5, color: Date.now() > Number(latest.photoDueAt) ? T.gas : T.textMid }}>
                  {Date.now() > Number(latest.photoDueAt)
                    ? t("r.paused")
                    : t("r.photoDue", { date: fmtDay(Number(latest.photoDueAt)) })}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 8 }}>
                <span style={{ ...mono, fontSize: 22, fontWeight: 800, color: T.text }}>{rd.reading}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: T.textSoft }}>kWh</span>
              </div>
              <div style={{ fontSize: 10.5, color: T.textSoft, marginTop: 2 }}>
                received {rd.at ? fmtWhen(rd.at) : "—"}{readerFresh ? "" : " — check that the computer with the script (or Home Assistant) is on"}
              </div>
            </div>

            <div style={{ marginTop: 8, padding: "12px", background: T.bg, border: `1px solid ${T.border || T.waterBorder}`, borderRadius: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".6px", color: T.textSoft, marginBottom: 8 }}>{t("r.timeline")}</div>
              {timeline.map((s, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 14px 1fr", gap: 8, alignItems: "stretch", minHeight: i === timeline.length - 1 ? 0 : 40 }}>
                  <div style={{ paddingTop: 1 }}>
                    {s.day && <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: T.textSoft }}>{s.day}</div>}
                    <div style={{ ...mono, fontSize: 12, fontWeight: 700, color: T.textMid, whiteSpace: "nowrap" }}>{s.time}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", boxSizing: "border-box", marginTop: 3, flexShrink: 0, background: s.done ? (T.green3 || T.eco) : T.bg, border: `2px solid ${T.green3 || T.eco}` }} />
                    {i < timeline.length - 1 && <span aria-hidden="true" style={{ flex: 1, width: 2, background: T.border || T.waterBorder, marginTop: 2 }} />}
                  </div>
                  <div style={{ paddingBottom: i < timeline.length - 1 ? 10 : 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: s.done ? T.text : T.textMid }}>{s.title}</div>
                    <div style={{ fontSize: 10.5, color: T.textSoft, marginTop: 1 }}>{s.sub}</div>
                  </div>
                </div>
              ))}
              {!paidThis && (
                <button disabled={busyAny} onClick={() => onAutoSubmit?.()} style={{ ...btn(T.eco || T.electric), width: "100%", marginTop: 10, opacity: busyAny ? .6 : 1 }}>
                  {busyAny ? t("r.submitting") : latest?.autoClaimOnPush ? t("r.claim") : t("r.submitNoPhoto")}
                </button>
              )}
            </div>

            {nextAt > Date.now() && (
              <div style={{ marginTop: 8, padding: "10px 12px", fontSize: 11, color: T.text, lineHeight: 1.55, background: T.green5 || T.bgAlt, border: `1px solid ${T.green4 || T.border}`, borderRadius: 10 }}>
                🖥️ Keep the computer with the script (or Home Assistant) on around <b>{fmtWhen(nextAt)}</b>. If it's off then, the reading goes out within the hour after you switch it on.
              </div>
            )}
            {/* Shown only when the gap is larger than ANY span could ever pay, which
                is the signature of a starting point that isn't on the same scale as
                the reader — almost always a double-tariff meter photographed on one
                register. Below that threshold this is just normal usage and the
                button would be an invitation to throw away earnings. */}
            {scaleMismatch && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: T.bg, border: `1px dashed ${T.border || T.waterBorder}`, borderRadius: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.text, marginBottom: 4 }}>
                  {t("r.mismatch.t")}
                </div>
                <div style={{ fontSize: 10.5, color: T.textSoft, lineHeight: 1.6 }}>
                  {t("r.mismatch.d", { start: latest.baseline, reading: rd.reading, gap: gapKwh })}
                </div>
                <button disabled={!!busy} onClick={doRebaseline}
                  style={{ ...btn(T.electric), marginTop: 9, opacity: busy ? .6 : 1 }}>
                  {busy === "rebase" ? t("r.updating") : t("r.useAsStart")}
                </button>
                <div style={{ fontSize: 10, color: T.textSoft, marginTop: 6, lineHeight: 1.5 }}>
                  Pays nothing — it only sets where counting begins. You can do this until your first automatic payout.
                </div>
              </div>
            )}
            </>
          ) : latest?.needsToken && !token ? (
            /* Paired, but from another browser or device: this one has no token yet,
               and readings are only shown to whoever holds it. */
            <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6 }}>
              {t("r.connectedOther", { paid: latest?.lastPayout ? t("r.lastPaid", { amount: Number(latest.lastPayout.amount).toFixed(2) }) : "" })}
              <div style={{ marginTop: 8 }}>
                <button onClick={showToken} style={btn(T.eco || T.electric)}>{t("r.showHere")}</button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6 }}>
              {t("r.none")}
            </div>
          )}

          {err && <div style={{ marginTop: 10, fontSize: 11, color: "#e74c3c", background: "rgba(231,76,60,.08)", border: "1px solid rgba(231,76,60,.3)", borderRadius: 6, padding: "8px 10px", wordBreak: "break-word" }}>{err}</div>}

          {/* ── Advanced: automatic setup (collapsed) ─────────────────────────── */}
          {wallet && (
            <div style={{ marginTop: 12, borderTop: `1px solid ${T.ecoBorder || T.waterBorder}`, paddingTop: 10 }}>
              <button onClick={() => setAdvOpen(o => !o)} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", cursor: "pointer", padding: 0, color: T.textSoft, fontSize: 11, fontWeight: 700 }}>
                <span>{t("r.setup")}</span>
                <span>{advOpen ? "▲" : "▼"}</span>
              </button>

              {advOpen && (
                <div style={{ marginTop: 10 }}>
                  {/* Setup is long-form and read on a laptop, so it lives in the guide.
                      Here: just what you need to act — the snippet and where it goes. */}
                  <div style={{ fontSize:10.5, color: T.textSoft, lineHeight: 1.6, marginBottom: 8 }}>
                    {t("r.pick")}{" "}
                    <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer" style={{ color: T.eco || T.electric, fontWeight: 700 }}>
                      {t("r.guide")}
                    </a>
                  </div>

                  {!token ? (
                    <button onClick={showToken} style={btn(T.electric)}>{t("r.getToken")}</button>
                  ) : (() => {
                    // Live connection status — the card already polls /meter/latest.
                    const connected = rd != null;
                    const statusBg = connected ? (T.ecoBg || T.waterBg) : T.bg;
                    const statusColor = connected ? (T.eco || T.green3 || T.text) : T.textSoft;
                    const DEVS = [
                      { id: "homewizard", label: "HomeWizard P1" },
                      { id: "powerfox",   label: "Powerfox" },
                      { id: "tibber",     label: "Tibber" },
                      { id: "tasmota",    label: "Tasmota / Hichi" },
                      { id: "ha",         label: "Home Assistant" },
                      { id: "curl",       label: t("r.other") },
                    ];
                    // One file, no git, no cd, no install: the helper has no dependencies, so
                    // downloading and running it IS the setup. Written for one shell at a
                    // time — `VAR=x cmd` and `&&` are bash, and PowerShell answers "The term
                    // 'GUL_TOKEN=…' is not recognized" rather than doing anything useful.
                    const fetchCmd = (args) => os === "win"
                      ? `iwr ${BRIDGE_JS_URL} -OutFile gul.js; node gul.js ${args}`
                      : `curl -fsSL ${BRIDGE_JS_URL} -o gul.js && node gul.js ${args}`;
                    // The one thing still needed beforehand is Node. Named right here,
                    // as a # comment (a comment in both shells, so pasting the whole
                    // block is safe), because "install Node first" buried in a hint is
                    // how you get `node : The term 'node' is not recognized`.
                    const needNode = os === "win"
                      ? "# No Node yet? winget install OpenJS.NodeJS.LTS — then open a NEW window."
                      : "# No Node yet? Get it from nodejs.org (Pi/Debian: sudo apt install nodejs).";
                    const bridgeCmd = `# The bridge finds your HomeWizard on the network by itself and sends
# your meter reading. Run it on a PC / Pi / NAS on the same network.
${needNode}

${fetchCmd(`--ask-token --install${INGEST_FLAG}`)}
# It first asks for your device token: tap “Copy token only” and paste it.

# That sends your first reading AND schedules it twice a day (Windows: Task
# Scheduler, Mac/Linux/Pi: cron), so you can close this window — it keeps
# working, even after a restart. You only ever run this once.
# Network blocks auto-discovery? Add --ip=<your P1 IP>`;
                    const tasmotaCmd = `# A Tasmota IR reading head (Hichi and friends) on your meter's optical
# port. The bridge reads its total (Total_in) over your home network.
# Run it on a PC / Pi / NAS on the same network. Replace TASMOTA_IP first.
${needNode}

${fetchCmd(`--ask-token --tasmota=TASMOTA_IP --install${INGEST_FLAG}`)}
# It first asks for your device token: tap “Copy token only” and paste it.

# That sends your first reading AND schedules it twice a day, so you can
# close this window. Total not found? Add --field=StatusSNS.<group>.<name>
# with the names from your meter script (Tasmota: Consoles → Console → status 10).`;
                    const haYaml = `# EASIEST: install our integration instead — no YAML at all.
#   HACS → ⋮ → Custom repositories → add (type: Integration):
#   https://github.com/GreenUtilityLog/GreenUtilityLog
#   Then: Settings → Devices & services → Add integration → GreenUtilityLog.
#   Paste your token, pick your meter sensor from the list.${INGEST_FLAG ? `
#   Set "Server address" to ${ingestUrl}
#   (the integration's default is a different server).` : ""} Done.
#
# Prefer to wire it yourself instead? Use the YAML below.
# configuration.yaml — works with (almost) any meter Home Assistant supports
#
# FIRST: find YOUR entity — entity IDs differ per install (they include your device
# name). Developer tools → States → filter on "import" and pick the cumulative
# kWh one (its value keeps counting up, e.g. 8421.3). Paste that id below.
rest_command:
  gul_push:
    url: "${ingestUrl}"
    method: POST
    content_type: "application/json"
    payload: '{"token":"${token}","reading":{{ states("sensor.YOUR_IMPORT_KWH_ENTITY") | float }}}'

# automations.yaml — twice a day; you can only claim once per 20h anyway
- alias: Push meter to GreenUtilityLog
  trigger: { platform: time_pattern, hours: "/12" }
  action: { service: rest_command.gul_push }`;
                    const curlSnippet = `# Any reader/script that can POST JSON works — send your cumulative kWh total:
curl -X POST ${ingestUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"token":"${token}","reading":12345.6}'

# Or let the bridge read any HTTP/JSON reader for you — one file, no install:
${fetchCmd(`--ask-token --install --url=http://<reader-ip>/api/v1/data${INGEST_FLAG}`)}
# It first asks for your device token: tap “Copy token only” and paste it.`;
                    const snip = device === "ha" ? haYaml : device === "curl" ? curlSnippet : device === "tasmota" ? tasmotaCmd : bridgeCmd;
                    const hint = device === "homewizard"
                      ? t("r.hint.hw")
                      : device === "tasmota"
                      ? t("r.hint.tasmota")
                      : device === "ha"
                      ? t("r.hint.ha")
                      : t("r.hint.curl");
                    return (
                      <div>
                        {/* Live connection status */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", background: statusBg, border: `1px solid ${connected ? (T.ecoBorder || T.waterBorder) : (T.border || T.waterBorder)}`, borderRadius: 6, marginBottom: 10, fontSize: 11, fontWeight: 700, color: statusColor }}>
                          {connected
                            ? `✅ Connected — ${rd.reading} kWh received${rd.at ? ` at ${new Date(rd.at).toLocaleTimeString()}` : ""}`
                            : "⏳ Waiting for your first reading… (leave this open after you set it up)"}
                        </div>

                        {/* Device picker */}
                        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                          {DEVS.map((d) => (
                            <button key={d.id} onClick={() => setDevice(d.id)}
                              style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: `1px solid ${device === d.id ? (T.eco || T.electric) : (T.border || T.waterBorder)}`, background: device === d.id ? (T.eco || T.electric) : "transparent", color: device === d.id ? "#fff" : T.textMid }}>
                              {d.label}
                            </button>
                          ))}
                        </div>

                        {/* Which shell the command is for. Only shown where there IS a
                            command — the Home Assistant route is YAML, same everywhere. */}
                        {device === "powerfox" && (
                          <PowerfoxSetup T={T} API={API} wallet={wallet} meterNo={meterNo} token={token} latest={latest} health={health}
                            onLinked={(tk) => { if (validDeviceToken(tk) && tk !== token) { setToken(tk); try { localStorage.setItem(tkKey, tk); } catch { /* no storage */ } } refreshLatest(); }}
                            requestCertificate={requestCertificate} copy={copy} copied={copied} os={os} setOs={setOs} fetchCmd={fetchCmd} needNode={needNode} />
                        )}
                        {device === "tibber" && (
                          <TibberSetup T={T} API={API} wallet={wallet} meterNo={meterNo} token={token} latest={latest} health={health}
                            onLinked={(tk) => { if (validDeviceToken(tk) && tk !== token) { setToken(tk); try { localStorage.setItem(tkKey, tk); } catch { /* no storage */ } } refreshLatest(); }}
                            requestCertificate={requestCertificate} copy={copy} copied={copied} />
                        )}

                        {device !== "ha" && device !== "powerfox" && device !== "tibber" && (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize:10, color: T.textSoft, fontWeight: 700 }}>{t("r.runningOn")}</span>
                            {[{ id: "win", label: "Windows" }, { id: "unix", label: "Mac · Linux · Pi" }].map((o) => (
                              <button key={o.id} onClick={() => setOs(o.id)}
                                style={{ padding: "5px 9px", fontSize:10, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: `1px solid ${os === o.id ? (T.eco || T.electric) : (T.border || T.waterBorder)}`, background: os === o.id ? (T.eco || T.electric) : "transparent", color: os === o.id ? "#fff" : T.textMid }}>
                                {o.label}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Pre-filled, one-tap-copy setup */}
                        {device !== "powerfox" && device !== "tibber" && <>
                        <div style={{ position: "relative" }}>
                          <button onClick={() => copy(snip, "snip")} style={{ position: "absolute", top: 6, right: 6, padding: "4px 8px", fontSize:10, fontWeight: 700, border: "none", borderRadius: 6, cursor: "pointer", background: copied === "snip" ? (T.eco || T.green3 || T.electric) : T.textSoft, color: "#fff" }}>
                            {copied === "snip" ? t("r.copied") : t("r.copySetup")}
                          </button>
                          <pre style={{ ...mono, fontSize:10, lineHeight: 1.5, color: T.text, background: T.bg, border: `1px dashed ${T.border || T.waterBorder}`, padding: "10px 10px 10px", borderRadius: 6, overflowX: "auto", margin: 0, whiteSpace: "pre" }}>{snip}</pre>
                        </div>
                        <div style={{ fontSize:10, color: T.textSoft, lineHeight: 1.5, margin: "6px 2px 0" }}>{hint}</div>
                        </>}

                        {/* The one thing a user cannot otherwise do: find out that the
                            token on their screen is one the backend has forgotten. The
                            reader just keeps saying "unknown device token". */}
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border || T.waterBorder}` }}>
                          <div style={{ fontSize: 10.5, color: T.textSoft, lineHeight: 1.6, marginBottom: 7 }}>
                            {t("r.unknownToken")}
                          </div>
                          <button disabled={!!busy} onClick={relinkDevice}
                            style={{ padding: "8px 11px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: "pointer", border: `1px solid ${T.border || T.waterBorder}`, background: "transparent", color: T.textMid, opacity: busy ? .6 : 1 }}>
                            {busy === "relink" ? t("r.relinking") : t("r.relink")}
                          </button>
                          {relinked && (
                            <div style={{ marginTop: 7, fontSize: 10.5, fontWeight: 700, color: relinked === "new" ? (T.eco || T.electric) : T.textSoft }}>
                              {relinked === "new"
                                ? "✅ Your saved token was out of date. Copy the setup above again — the old one will never work."
                                : "✓ Already linked — the server has this exact token, so the problem is elsewhere."}
                            </div>
                          )}
                        </div>

                        {/* One line, not a manual: the detail lives in the guide. */}
                        {device !== "ha" && device !== "powerfox" && device !== "tibber" && (
                          <div style={{ fontSize:10, color: T.textSoft, lineHeight: 1.6, marginTop: 8 }}>
                            {t("r.terminal")}{" "}
                            <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer" style={{ color: T.eco || T.electric, fontWeight: 700 }}>{t("r.showMe")}</a>
                          </div>
                        )}

                        {/* Raw token / URL for reference */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                          <button onClick={() => copy(token, "tok")} style={{ ...btn(T.textSoft), padding: "5px 9px", fontSize:10 }}>{copied === "tok" ? t("r.tokenCopied") : t("r.copyToken")}</button>
                          <button onClick={() => copy(ingestUrl, "url")} style={{ ...btn(T.textSoft), padding: "5px 9px", fontSize:10 }}>{copied === "url" ? t("r.urlCopied") : t("r.copyUrl")}</button>
                        </div>
                      </div>
                    );
                  })()}

                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
