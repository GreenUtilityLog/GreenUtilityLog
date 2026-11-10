// The owner's admin screen, split out of App.jsx and loaded on demand (React.lazy).
// English only: it is for the app's owner, not for users.
import { useState, useEffect } from "react";
import { REWARD_API, NETWORK } from "./network.js";
import { fetchOnChainLeaderboard, fetchWalletHistory, fetchPoolBalance, fetchDiagnostics } from "./leaderboard.js";
import { ACTIVE_NODE, CONTRACTS, VEBETTER_APP_ID, NETWORK_LABEL, EXPLORER, OVERLAY_INSET, UTILS, UTIL_ICONS, shortAddr, normDecimal, getColorBg, fmtDay, fetchT, useDialog } from "./App.jsx";

// Read-only admin overlay: every on-chain participant for this app, aggregated
// from RewardDistributed events. Monitoring only — payouts/blocking require the
// reward-distributor role (a backend), never the frontend.

// Admin actions on the wallet you've drilled into — block/unblock, reset its
// cooldown, and correct a meter's baseline right where you see the problem.
// Submissions the app's own photo checks couldn't confirm. They were all PAID —
// those checks false-positive on real phone photos, so they never hold a reward.
// This is the list that makes the word "noted" mean something: without it the app
// was telling users their submission was flagged while nothing was recorded.
function FlaggedPanel({ T, address, onAdminApi }) {
  const [state, setState] = useState({ status: "idle" });

  const load = async () => {
    setState({ status: "loading" });
    try {
      const d = await onAdminApi("/admin/flags", { targetWallet: address });
      setState({ status: "live", flags: d.flags || [] });
    } catch (e) {
      setState({ status: "error", error: e?.message || "request failed" });
    }
  };

  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const box = { marginTop: 16, padding: 12, background: T.bgAlt, border: `1px solid ${T.border}`, borderRadius: 10 };
  const head = { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, marginBottom: 10 };
  const btn = { background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6, padding: "9px 12px", fontWeight: 700, fontSize: 11, color: T.textMid, cursor: "pointer" };

  if (state.status === "idle") {
    return (
      <div style={box}>
        <div style={head}>⚠️ Unconfirmed photos</div>
        <div style={{ fontSize:10.5, color: T.textSoft, lineHeight: 1.6, marginBottom: 10 }}>
          Submissions whose photo the app couldn't auto-check. All were paid — this is for spotting a pattern, not a queue.
        </div>
        <button onClick={load} style={btn}>⚠️ Show for this wallet</button>
      </div>
    );
  }
  if (state.status === "loading") return <div style={box}><div style={head}>⚠️ Unconfirmed photos</div><div style={{ fontSize: 11, color: T.textSoft }}>Loading…</div></div>;
  if (state.status === "error") {
    return (
      <div style={box}>
        <div style={head}>⚠️ Unconfirmed photos</div>
        <div style={{ fontSize: 11, color: T.text, marginBottom: 10 }}>⚠️ {state.error}</div>
        <button onClick={load} style={btn}>Retry</button>
      </div>
    );
  }

  const flags = state.flags || [];
  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={head}>⚠️ Unconfirmed photos ({flags.length})</div>
        <button onClick={load} style={{ background: "transparent", border: "none", fontSize: 11, color: T.textSoft, cursor: "pointer" }}>↻</button>
      </div>
      {flags.length === 0 ? (
        <div style={{ fontSize: 11, color: T.textSoft, lineHeight: 1.6 }}>None — every submission from this wallet passed the app's photo checks.</div>
      ) : flags.map((f) => (
        <div key={f.txid} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "9px 11px", marginBottom: 6 }}>
          <div style={{ fontSize:10.5, color: T.text, lineHeight: 1.5 }}>{f.reason}</div>
          <div style={{ fontSize:10.5, color: T.textSoft, marginTop: 3, fontFamily: mono, wordBreak: "break-all" }}>
            {f.at ? new Date(f.at).toISOString().slice(0, 16).replace("T", " ") : "—"} · {String(f.txid).slice(0, 14)}…
          </div>
        </div>
      ))}
      <div style={{ fontSize:10.5, color: T.textSoft, marginTop: 8, lineHeight: 1.6 }}>
        These were paid. A single one usually means a blurry photo; many from one wallet is worth a look.
      </div>
    </div>
  );
}

// The access pass: what actually lets a wallet earn once passes are switched on.
// Not an NFT and deliberately so — it has to be revocable and cost nothing to issue,
// and an admin hands them out one wallet at a time.
//
// Note this is a different thing from the VeBetterDAO passport below: that one is
// VeBetterDAO's bot check on the whole ecosystem, this one is our own guest list.
// Who may use THIS version (this server; mainnet and the test copy each have their
// own): wallets with a GM NFT + Passport, only wallets with a role, or everyone.
// Admins always get in. Reading the
// current setting needs no signature (/health); changing it does.
function AccessModePanel({ T, onAdminApi, onToast }) {
  const [mode, setMode] = useState(null);   // "gm" | "roles" | "everyone" | null (unknown)
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let stop = false;
    fetchT(`${REWARD_API.replace(/\/$/, "")}/health`).then(r => (r.ok ? r.json() : null))
      .then(h => { if (!stop && ["gm", "roles", "everyone"].includes(h?.access)) setMode(h.access); })
      .catch(() => {});
    return () => { stop = true; };
  }, []);
  const set = async (m) => {
    if (m === mode) return;
    setBusy(m);
    try {
      const d = await onAdminApi("/admin/access", { mode: m });
      setMode(d.access);
      onToast?.(d.access === "gm" ? "🪐 Only wallets with a GM NFT and a Passport can use this version now"
        : d.access === "roles" ? "🔒 Only wallets with a role can use this version now" : "🔓 Everyone can use this version now");
    } catch (e) {
      onToast?.(`❌ ${e?.message || "could not change access"}`);
    } finally { setBusy(""); }
  };
  const opt = (m, label, sub) => {
    const on = mode === m;
    return (
      <button type="button" onClick={() => set(m)} disabled={!!busy} aria-pressed={on}
        style={{flex:1,minWidth:0,textAlign:"left",background:on ? (T.green5 || T.bgAlt) : T.card,border:`1px solid ${on ? (T.green3 || T.border) : T.border}`,borderRadius:6,padding:"9px 10px",cursor:busy ? "default" : "pointer",opacity:busy && busy !== m ? .6 : 1}}>
        <div style={{fontSize:12,fontWeight:800,color:T.text}}>{busy === m ? "…" : (on ? "● " : "○ ")}{label}</div>
        <div style={{fontSize:10,color:T.textSoft,marginTop:2,lineHeight:1.4}}>{sub}</div>
      </button>
    );
  };
  return (
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 12px",marginBottom:12}}>
      <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft,marginBottom:8}}>
        🔐 Who can use this version · {NETWORK_LABEL}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {opt("gm", "GM NFT + Passport", "VeBetterDAO members: a Galaxy Member NFT and a Passport that counts them as a person. Roles don't count.")}
        {opt("roles", "Only with a role", "Testers and users you added. Everyone else sees a 'no access' screen.")}
        {opt("everyone", "Everyone", "Any wallet can use the app and earn.")}
      </div>
      <div style={{fontSize:10,color:T.textSoft,marginTop:8,lineHeight:1.5}}>
        {mode ? "Admins always get in. Give someone a role: search their wallet below → Role." : "Couldn't read the current setting — choosing one still works."}
      </div>
    </div>
  );
}

const ROLE_OPTIONS = [
  { id: "tester", label: "Tester" },
  { id: "user",   label: "User" },
];

function AccessPassPanel({ T, address, onAdminApi, onToast }) {
  const [state, setState] = useState({ status: "idle" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [role, setRole] = useState("tester");

  const load = async () => {
    setState({ status: "loading" });
    try {
      const d = await onAdminApi("/admin/lookup", { targetWallet: address });
      setState({ status: "live", pass: d.pass || null, requirePass: !!d.requirePass, access: d.access || "" });
      if (ROLE_OPTIONS.some(r => r.id === d.pass?.tier)) setRole(d.pass.tier);
    } catch (e) {
      setState({ status: "error", error: e?.message || "request failed" });
    }
  };

  const act = async (grant, tier = role) => {
    setBusy(grant ? "grant" : "revoke");
    try {
      const d = await onAdminApi("/admin/pass", { targetWallet: address, grant, ...(grant ? { tier } : {}), ...(grant && note.trim() ? { note: note.trim() } : {}) });
      setState((s) => ({ ...s, status: "live", pass: d.pass || null, requirePass: !!d.requirePass, access: d.access || s.access || "" }));
      onToast?.(grant ? `🎟️ ${d.pass?.tier === "user" ? "User" : "Tester"} role given (pass #${d.pass?.no})` : "🎟️ Role withdrawn");
      setNote("");
    } catch (e) {
      onToast?.(`❌ ${e?.message || "action failed"}`);
    } finally { setBusy(""); }
  };

  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const box = { marginTop: 16, padding: 12, background: T.bgAlt, border: `1px solid ${T.border}`, borderRadius: 10 };
  const head = { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, marginBottom: 10 };
  const btn = (bg, fg, dis) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${T.border}` : "none", borderRadius: 6, padding: "9px 12px", fontWeight: 700, fontSize: 11, cursor: dis ? "default" : "pointer", opacity: dis ? 0.6 : 1, whiteSpace: "nowrap" });

  if (state.status === "idle") {
    return (
      <div style={box}>
        <div style={head}>🎟️ Role</div>
        <div style={{ fontSize:10.5, color: T.textSoft, lineHeight: 1.6, marginBottom: 10 }}>Tester or user. With "Only with a role" on, only wallets with a role can use this version and earn.</div>
        <button onClick={load} style={btn("transparent", T.textMid, false)}>🎟️ Check role</button>
      </div>
    );
  }
  if (state.status === "loading") return <div style={box}><div style={head}>🎟️ Role</div><div style={{ fontSize: 11, color: T.textSoft }}>Loading…</div></div>;
  if (state.status === "error") {
    return (
      <div style={box}>
        <div style={head}>🎟️ Role</div>
        <div style={{ fontSize: 11, color: T.text, marginBottom: 10 }}>⚠️ {state.error}</div>
        <button onClick={load} style={btn("transparent", T.textMid, false)}>Retry</button>
      </div>
    );
  }

  const p = state.pass;
  return (
    <div style={box}>
      <div style={head}>🎟️ Role</div>
      {p ? (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: T.green3, fontFamily: mono }}>Pass #{p.no}</div>
            <span style={{ background: T.gasBg, color: T.textMid, borderRadius: 6, padding: "3px 7px", fontSize:10, fontWeight: 800, textTransform: "uppercase" }}>{p.tier}</span>
          </div>
          <div style={{ fontSize:10, color: T.textSoft, marginTop: 4 }}>
            Issued {p.issuedAt ? new Date(p.issuedAt).toISOString().slice(0, 10) : "—"}{p.issuedBy ? ` by ${shortAddr(p.issuedBy)}` : ""}
          </div>
          {p.note ? <div style={{ fontSize:10.5, color: T.textMid, marginTop: 4 }}>{p.note}</div> : null}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: T.textMid, marginBottom: 10, lineHeight: 1.6 }}>
          No role. {state.requirePass ? <b>This wallet can't use this version.</b>
            : state.access === "gm" ? "This version is on \"GM NFT + Passport\": a role doesn't decide who gets in here."
            : "This version is open to everyone, so this wallet can still use it."}
        </div>
      )}

      <div role="radiogroup" aria-label="Role" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {ROLE_OPTIONS.map(r => {
          const on = role === r.id;
          return (
            <button key={r.id} type="button" role="radio" aria-checked={on}
              onClick={() => { setRole(r.id); if (p && p.tier !== r.id) act(true, r.id); }}
              disabled={!!busy}
              style={{ ...btn(on ? (T.green3 || "#2e7d5b") : "transparent", on ? "#fff" : T.textMid, !!busy), flex: 1 }}>
              {r.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!p && (
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" maxLength={140}
            style={{ flex: 1, minWidth: 140, boxSizing: "border-box", background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 10px", fontSize: 12, color: T.text, outline: "none" }} />
        )}
        {p
          ? <button disabled={busy === "revoke"} onClick={() => act(false)} style={btn("transparent", T.textMid, busy === "revoke")}>{busy === "revoke" ? "…" : "Withdraw role"}</button>
          : <button disabled={busy === "grant"} onClick={() => act(true)} style={btn(T.green3 || "#2e7d5b", "#fff", busy === "grant")}>{busy === "grant" ? "…" : `🎟️ Give ${role === "user" ? "user" : "tester"} role`}</button>}
      </div>

      {!state.requirePass && (
        <div style={{ fontSize:10.5, color: T.textSoft, marginTop: 8, lineHeight: 1.6 }}>
          {state.access === "gm"
            ? "This version is on \"GM NFT + Passport\": only wallets with a GM NFT and a Passport that counts them get in, roles or not. Switch to \"Only with a role\" at the top of the admin screen to make roles count."
            : "This version is open to everyone right now. Switch to \"Only with a role\" at the top of the admin screen to make roles count."}
        </div>
      )}
    </div>
  );
}

// VeBetterDAO's own sybil defence, for one wallet. Reading it needs no permission
// and is the useful half: the passport's verdict on a wallet is ecosystem-wide, so
// a tester who isn't counted as a person here isn't counted anywhere.
//
// Signalling is the other half and is a genuine accusation — it costs the wallet
// standing across every VeBetter app, not just this one. Blocking someone locally
// is /admin/ban; this is not that, and the UI says so.
function PassportPanel({ T, address, onAdminApi, onAssignSignaler, onToast }) {
  const [state, setState] = useState({ status: "idle" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setState({ status: "loading" });
    try {
      const d = await onAdminApi("/admin/passport", { wallets: [address] });
      setState({ status: "live", status_: d.status, p: (d.passports || {})[address.toLowerCase()] || null });
    } catch (e) {
      setState({ status: "error", error: e?.message || "request failed" });
    }
  };

  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const box = { marginTop: 16, padding: 12, background: T.bgAlt, border: `1px solid ${T.border}`, borderRadius: 10 };
  const head = { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, marginBottom: 10 };
  const btn = (bg, fg, dis) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${T.border}` : "none", borderRadius: 6, padding: "9px 12px", fontWeight: 700, fontSize: 11, cursor: dis ? "default" : "pointer", opacity: dis ? 0.6 : 1, whiteSpace: "nowrap" });

  if (state.status === "idle") {
    return (
      <div style={box}>
        <div style={head}>🪪 VeBetterDAO passport</div>
        <div style={{ fontSize:10.5, color: T.textSoft, lineHeight: 1.6, marginBottom: 10 }}>
          Whether VeBetterDAO still counts this wallet as a person, and how often it has been signalled as a bot.
        </div>
        <button onClick={load} style={btn("transparent", T.textMid, false)}>🪪 Check passport</button>
      </div>
    );
  }
  if (state.status === "loading") return <div style={box}><div style={head}>🪪 VeBetterDAO passport</div><div style={{ fontSize: 11, color: T.textSoft }}>Loading…</div></div>;
  if (state.status === "error") {
    return (
      <div style={box}>
        <div style={head}>🪪 VeBetterDAO passport</div>
        <div style={{ fontSize: 11, color: T.text, lineHeight: 1.5, marginBottom: 10 }}>⚠️ Couldn't read the passport contract ({state.error}).</div>
        <button onClick={load} style={btn("transparent", T.textMid, false)}>Retry</button>
      </div>
    );
  }

  const { p } = state;
  const st = state.status_ || {};
  const authorized = st.authorized === true;
  // null means the node didn't answer — say "unknown" rather than implying a verdict.
  const person = p?.isPerson;
  const pill = (bg, fg, text) => <span style={{ background: bg, color: fg, borderRadius: 6, padding: "3px 7px", fontSize:10, fontWeight: 800 }}>{text}</span>;

  const doSignal = async () => {
    if (reason.trim().length < 3) { onToast?.("❌ Give a reason first"); return; }
    if (!window.confirm(`Signal ${address} as a bot?\n\nThis is an ecosystem-wide accusation recorded on-chain — it affects this wallet across every VeBetter app, not just here. To only stop them claiming in this app, use "Block wallet" instead.`)) return;
    setBusy(true);
    try {
      const d = await onAdminApi("/admin/signal", { targetWallet: address, reason: reason.trim() });
      onToast?.(`🚩 Signalled — tx ${String(d.txid || "").slice(0, 10)}…`);
      setReason("");
      await load();
    } catch (e) {
      onToast?.(`❌ ${e?.message || "signal failed"}`);
    } finally { setBusy(false); }
  };

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={head}>🪪 VeBetterDAO passport</div>
        <button onClick={load} style={{ background: "transparent", border: "none", fontSize: 11, color: T.textSoft, cursor: "pointer" }}>↻</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        {person === true && pill(T.green1 || "#dce8e1", T.green3 || "#2e7d5b", "✓ Counts as a person")}
        {person === false && pill("#7a1c1c", "#fff", "✕ Not counted as a person")}
        {person == null && pill(T.gasBg, T.textMid, "? Unknown — node didn't answer")}
        {p?.blacklisted === true && pill("#7a1c1c", "#fff", "Blacklisted")}
      </div>

      {p?.reason ? (
        <div style={{ fontSize:10.5, color: T.textMid, lineHeight: 1.6, marginBottom: 8 }}>
          Contract's reason: <span style={{ fontFamily: mono }}>{p.reason}</span>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
        <div><span style={{ fontSize: 15, fontWeight: 600, color: T.text, fontFamily: mono }}>{p?.signals ?? "–"}</span> <span style={{ fontSize:10.5, color: T.textSoft }}>signals total</span></div>
        <div><span style={{ fontSize: 15, fontWeight: 600, color: T.text, fontFamily: mono }}>{p?.appSignals ?? "–"}</span> <span style={{ fontSize:10.5, color: T.textSoft }}>from this app</span></div>
        {st.threshold != null && <div><span style={{ fontSize: 15, fontWeight: 600, color: T.textSoft, fontFamily: mono }}>{st.threshold}</span> <span style={{ fontSize:10.5, color: T.textSoft }}>threshold</span></div>}
      </div>

      {authorized ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (recorded on-chain)"
              maxLength={256}
              style={{ flex: 1, minWidth: 160, boxSizing: "border-box", background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 10px", fontSize: 12, color: T.text, outline: "none" }}
            />
            <button disabled={busy} onClick={doSignal} style={btn("#c0392b", "#fff", busy)}>{busy ? "…" : "🚩 Signal as bot"}</button>
          </div>
          <div style={{ fontSize:10.5, color: T.textSoft, marginTop: 8, lineHeight: 1.6 }}>
            Ecosystem-wide and permanent from our side — only VeBetterDAO can reset a wallet's signals. To just stop someone claiming here, use <b>Block wallet</b> above.
          </div>
        </>
      ) : (
        <div style={{ background: T.gasBg, border: `1px solid ${T.gasBorder}`, borderRadius: 6, padding: "10px 12px", fontSize:10.5, color: T.textMid, lineHeight: 1.6 }}>
          ℹ️ <b>Signalling is not enabled yet.</b> The app admin can enable it: this lets the server's distributor wallet{" "}
          <span style={{ fontFamily: mono, wordBreak: "break-all" }}>{st.signaler || "(unknown)"}</span> file signals. You sign one transaction with the app-admin wallet.
          {onAssignSignaler && st.contract && st.signaler && (
            <div style={{ marginTop: 8 }}>
              <button disabled={busy} style={btn(T.green3 || "#2e7d5b", "#fff", busy)}
                onClick={async () => { setBusy(true); try { const tx = await onAssignSignaler({ passport: st.contract, signaler: st.signaler }); if (tx) await load(); } finally { setBusy(false); } }}>
                {busy ? "…" : "Enable signalling"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WalletAdminActions({ T, address, meters, onAdminApi, onToast }) {
  const [busy, setBusy] = useState("");
  const [vals, setVals] = useState({});         // baseline inputs per meter
  const [renameVals, setRenameVals] = useState({}); // new-number inputs per meter
  const [add, setAdd] = useState({ meterNo: "", utility: "electric", reading: "" }); // register-a-meter form
  const [backendMeters, setBackendMeters] = useState(null); // meters registered on the backend (incl. just-added)
  // Show the on-chain-derived meters PLUS any backend-registered ones, deduped — so a
  // meter added via admin (no submission yet) is visible here too.
  const norm = (m) => `${m.utility}:${String(m.meterNo).toLowerCase()}`;
  const shown = (() => {
    const map = new Map();
    for (const m of (meters || [])) map.set(norm(m), m);
    for (const m of (backendMeters || [])) if (!map.has(norm(m))) map.set(norm(m), m);
    return [...map.values()];
  })();
  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try { const d = await fn(); onToast?.(okMsg(d)); }
    catch (e) { onToast?.(`❌ ${e?.message || "action failed"}`); }
    finally { setBusy(""); }
  };
  const mono = "'SF Mono',Menlo,'Courier New',monospace";
  const btn = (bg, fg, dis) => ({ background: bg, color: fg, border: bg === "transparent" ? `1px solid ${T.border}` : "none", borderRadius: 6, padding: "9px 12px", fontWeight: 700, fontSize: 11, cursor: "pointer", opacity: dis ? 0.6 : 1, whiteSpace: "nowrap" });
  const inp = { flex: 1, minWidth: 0, boxSizing: "border-box", background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "8px 10px", fontSize: 12, color: T.text, fontFamily: mono, outline: "none" };

  return (
    <div style={{ marginTop: 16, padding: 12, background: T.bgAlt, border: `1px solid ${T.border}`, borderRadius: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".8px", color: T.textSoft, marginBottom: 10 }}>🛠️ Admin actions</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button disabled={busy === "ban"} onClick={() => run("ban", () => onAdminApi("/admin/ban", { targetWallet: address, ban: true }), () => "🚫 Wallet blocked — it can no longer claim")} style={btn("#c0392b", "#fff", busy === "ban")}>{busy === "ban" ? "…" : "🚫 Block wallet"}</button>
        <button disabled={busy === "unban"} onClick={() => run("unban", () => onAdminApi("/admin/ban", { targetWallet: address, ban: false }), () => "✅ Wallet unblocked")} style={btn("transparent", T.textMid, busy === "unban")}>{busy === "unban" ? "…" : "Unblock"}</button>
        <button disabled={busy === "cd"} onClick={() => run("cd", () => onAdminApi("/admin/reset-cooldown", { targetWallet: address, utility: "electric" }), () => "✅ Cooldown reset")} style={btn("transparent", T.textMid, busy === "cd")}>{busy === "cd" ? "…" : "⏱️ Reset cooldown"}</button>
        <button disabled={busy === "load"} onClick={() => run("load", () => onAdminApi("/admin/lookup", { targetWallet: address }), (d) => { setBackendMeters(d.meters || []); return `✅ ${(d.meters || []).length} meter(s) registered on backend`; })} style={btn("transparent", T.textMid, busy === "load")}>{busy === "load" ? "…" : "🔍 Load meters"}</button>
      </div>

      {shown.length === 0 && (
        <div style={{ fontSize:10.5, color: T.textSoft, marginTop: 10, lineHeight: 1.5 }}>No meters yet from on-chain submissions. Tap <b>🔍 Load meters</b> to show ones registered on the backend, or add one below.</div>
      )}

      {shown.map((m, i) => (
        <div key={i} style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize:10, color: T.textSoft, marginBottom: 5 }}><span style={{ fontFamily: mono, color: T.text }}>{m.meterNo}</span> · {m.utility}{m.last != null ? ` · last ${m.last}` : ""}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={vals[m.meterNo] ?? ""} onChange={e => setVals(v => ({ ...v, [m.meterNo]: normDecimal(e.target.value) }))} type="text" inputMode="decimal" autoComplete="off" placeholder={`Fix reading${m.last != null ? ` (e.g. ${m.last})` : ""}`} style={inp} />
            <button disabled={busy === "base" + i || !(Number(vals[m.meterNo]) >= 0)} onClick={() => run("base" + i, () => onAdminApi("/admin/set-baseline", { meterNo: m.meterNo, utility: m.utility, reading: Number(vals[m.meterNo]), targetWallet: address }), (d) => `✅ Baseline set: ${d.meterNo} → ${d.baseline}`)} style={btn(T.green3 || "#2e7d5b", "#fff", busy === "base" + i || !(Number(vals[m.meterNo]) >= 0))}>{busy === "base" + i ? "…" : "Set"}</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input value={renameVals[m.meterNo] ?? ""} onChange={e => setRenameVals(v => ({ ...v, [m.meterNo]: e.target.value }))} placeholder="Change meter number →" spellCheck={false} style={inp} />
            <button disabled={busy === "ren" + i || !(renameVals[m.meterNo] || "").trim()} onClick={() => run("ren" + i, () => onAdminApi("/admin/rename-meter", { oldMeterNo: m.meterNo, newMeterNo: (renameVals[m.meterNo] || "").trim(), utility: m.utility, targetWallet: address }), (d) => { setBackendMeters(prev => (prev || []).map(x => x.meterNo === m.meterNo && x.utility === m.utility ? { ...x, meterNo: d.meterNo } : x)); setRenameVals(v => ({ ...v, [m.meterNo]: "" })); return `✅ Meter renamed → ${d.meterNo}`; })} style={btn("transparent", T.textMid, busy === "ren" + i || !(renameVals[m.meterNo] || "").trim())}>{busy === "ren" + i ? "…" : "Rename"}</button>
          </div>
        </div>
      ))}

      {/* Register / add a meter to this wallet (e.g. before their first submission,
          or to add a second utility). Sets its server-side baseline + ownership. */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
        <div style={{ fontSize:10, fontWeight: 700, color: T.textSoft, marginBottom: 5 }}>➕ Add a meter to this wallet</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={add.meterNo} onChange={e => setAdd(a => ({ ...a, meterNo: e.target.value }))} placeholder="Meter number" spellCheck={false} style={{ ...inp, flex: "2 1 120px" }} />
          <select value={add.utility} onChange={e => setAdd(a => ({ ...a, utility: e.target.value }))} style={{ ...inp, flex: "1 1 90px", fontFamily: "inherit", cursor: "pointer" }}>
            {UTILS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
          <input value={add.reading} onChange={e => setAdd(a => ({ ...a, reading: normDecimal(e.target.value) }))} type="text" inputMode="decimal" autoComplete="off" placeholder="Current reading" style={{ ...inp, flex: "1 1 100px" }} />
          <button disabled={busy === "add" || !add.meterNo.trim() || !(Number(add.reading) >= 0)} onClick={() => run("add", () => onAdminApi("/admin/set-baseline", { meterNo: add.meterNo.trim(), utility: add.utility, reading: Number(add.reading), targetWallet: address }), (d) => { const nm = { utility: add.utility, meterNo: add.meterNo.trim().toLowerCase(), last: Number(add.reading) }; setBackendMeters(prev => { const cur = prev || []; return cur.some(x => norm(x) === norm(nm)) ? cur : [...cur, nm]; }); setAdd({ meterNo: "", utility: "electric", reading: "" }); return `✅ Meter added: ${d.meterNo} (${d.utility})`; })} style={btn(T.green3 || "#2e7d5b", "#fff", busy === "add" || !add.meterNo.trim() || !(Number(add.reading) >= 0))}>{busy === "add" ? "…" : "Add"}</button>
        </div>
      </div>

      <div style={{ fontSize:10, color: T.textSoft, marginTop: 10, lineHeight: 1.5 }}>Each action asks for one wallet signature (admin proof). Fix baseline corrects a mis-entered reading; Rename changes a wrong meter number (moves its baseline); Add registers a meter + baseline for this wallet. Meters/baselines live on the backend, not the chain.</div>
    </div>
  );
}

// One row in a wallet's "Recent submissions" list. Renders the submission clearly
// per type (meter reading vs eco bonus) and — when the server's photo archive is on
// — lets an admin pull up the actual photo behind the payout (📷) or erase it (🗑️).
function SubmissionRow({ r, T, onAdminApi, onToast, archiveOn }) {
  const MONO = "'SF Mono',Menlo,'Courier New',monospace";
  const isEco = !!r.appliance || r.type === "eco";
  const p = parseFloat(r.prev), c = parseFloat(r.cur);
  const usage = (Number.isFinite(p) && Number.isFinite(c)) ? +(c - p).toFixed(2) : null;
  const unit = (UTILS.find((x) => x.id === r.type)?.unit) || "kWh";
  const txUrl = r.txHash ? `${EXPLORER}/transactions/${r.txHash}` : null;
  // A reader-sourced payout has no photo by design, so the camera would only ever
  // report its absence. Empty source means a payout from before this was recorded:
  // unknown, so the button stays and the message keeps naming both possibilities.
  // Every source without a photo: a pushed reading, and the Powerfox and Tibber
  // clouds the server reads itself ("enode" is in older payouts on chain).
  const fromReader = ["push", "reader", "powerfox", "tibber", "enode"].includes(r.source);
  const canPhoto = archiveOn && !!r.txHash && !fromReader;
  const [photo, setPhoto] = useState({ status: "idle", dataUrl: null }); // idle|loading|shown|none|deleted|busy

  const loadPhoto = async (e) => {
    e.stopPropagation();
    if (photo.status === "shown") { setPhoto({ status: "idle", dataUrl: null }); return; } // toggle closed
    setPhoto({ status: "loading", dataUrl: null });
    try {
      const d = await onAdminApi("/admin/photo", { txid: r.txHash });
      if (d.found && d.dataUrl) setPhoto({ status: "shown", dataUrl: d.dataUrl });
      else {
        setPhoto({ status: "none", dataUrl: null });
        onToast?.(d.reason === "expired"
          ? `📭 This photo was archived but is past the ${d.retentionDays}-day retention window, so storage has dropped it`
          : d.enabled === false
            ? "📭 Photo archiving is switched off in the backend"
            // Two causes, and the backend cannot tell them apart: both paths write the
            // same on-chain metadata. Naming only one of them told an admin something
            // false — usually about an automatic submission, which never has a photo
            // because no camera was ever involved.
            : "📭 No photo found. This payout predates the archive being switched on, or came from a reader — payouts made since carry their source, so newer rows say which.");
      }
    } catch (err) { setPhoto({ status: "idle", dataUrl: null }); onToast?.(`⚠️ ${err.message}`); }
  };
  const deletePhoto = async (e) => {
    e.stopPropagation();
    if (!window.confirm("Delete this photo from storage? This cannot be undone.")) return;
    setPhoto({ status: "busy", dataUrl: photo.dataUrl });
    try {
      await onAdminApi("/admin/photo-delete", { txid: r.txHash });
      setPhoto({ status: "deleted", dataUrl: null });
      onToast?.("🗑️ Photo deleted");
    } catch (err) { setPhoto({ status: "shown", dataUrl: photo.dataUrl }); onToast?.(`⚠️ ${err.message}`); }
  };

  const iconBtn = (label, onClick, disabled) => (
    <button onClick={onClick} disabled={disabled}
      style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"3px 7px",fontSize:12,cursor:disabled?"default":"pointer",color:T.textMid,lineHeight:1}}>{label}</button>
  );

  return (
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,marginBottom:6,overflow:"hidden"}}>
      <div role="button" tabIndex={0} onClick={() => txUrl && window.open(txUrl, "_blank", "noopener")}
        title={txUrl ? "View this transaction on the VeChain explorer" : undefined}
        style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",cursor:txUrl?"pointer":"default"}}>
        <span style={{fontSize:16}}>{isEco ? "🌿" : (UTIL_ICONS[r.type] || "⚡")}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:700,color:T.text}}>
            {isEco ? "Eco bonus" : "Meter reading"}
            {/* Say which payouts nobody looked at. A reader-sourced reading was never
                seen by a human and has no photo to check, so it is the row an admin
                most needs to recognise at a glance. */}
            {fromReader && (
              <span style={{marginLeft:6,fontSize:10.5,fontWeight:800,letterSpacing:".6px",textTransform:"uppercase",color:T.eco||T.electric,border:`1px solid ${T.ecoBorder||T.border}`,background:T.ecoBg||T.bgAlt,borderRadius:6,padding:"1px 5px"}}>
                ⚡ Automatic · no photo
              </span>
            )}
            {!isEco && r.meterNo ? <span style={{fontWeight:400,color:T.textSoft,fontFamily:MONO,fontSize:10}}> · #{r.meterNo}</span> : null}
          </div>
          <div style={{fontSize:10,color:T.textSoft,fontFamily:MONO}}>
            {isEco
              ? (r.appliance ? `${r.appliance} on eco mode` : "appliance on eco mode")
              : (usage != null ? `${r.prev} → ${r.cur} · ${usage} ${unit} used` : (r.cur !== "" ? `reading ${r.cur}` : "reading"))}
          </div>
          <div style={{fontSize:10.5,color:T.textSoft,marginTop:2}}>{fmtDay(r.date)}{txUrl ? " · tx ↗" : ""}</div>
        </div>
        {canPhoto && photo.status !== "deleted" && (
          <span onClick={(e) => e.stopPropagation()} style={{display:"flex",gap:4}}>
            {iconBtn(photo.status === "loading" ? "…" : photo.status === "shown" ? "📷 ▲" : "📷", loadPhoto, photo.status === "loading" || photo.status === "busy")}
            {photo.status === "shown" && iconBtn("🗑️", deletePhoto, false)}
          </span>
        )}
        <div style={{fontSize:13,fontWeight:800,color:T.green3,fontFamily:MONO,whiteSpace:"nowrap"}}>+{parseFloat(r.b3tr).toFixed(2)}</div>
      </div>
      {photo.status === "shown" && photo.dataUrl && (
        <div style={{padding:"0 12px 12px"}}>
          <img src={photo.dataUrl} alt="submission" style={{maxWidth:"100%",borderRadius:6,border:`1px solid ${T.border}`,display:"block"}} />
        </div>
      )}
      {photo.status === "deleted" && (
        <div style={{padding:"0 12px 10px",fontSize:10,color:T.textSoft}}>🗑️ Photo deleted.</div>
      )}
    </div>
  );
}

export default function AdminScreen({ onClose, T, wallet, onFundPool, onMoveToRewardsPool, onDisableRewardsPool, onSetDistributionPaused, onAssignSignaler, onClaimB3TR, onAdminApi, onToast }) {
  const dlg = useDialog(onClose, "Admin");
  const [chain, setChain] = useState({ status: "loading", rows: [], reason: null });
  const [knownWallets, setKnownWallets] = useState(null); // backend-known wallets (not yet on-chain)
  const [loadingWallets, setLoadingWallets] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState({ status: "idle", rows: [] });
  const [detailReload, setDetailReload] = useState(0); // bump to retry the history fetch
  const [fundAmt, setFundAmt] = useState("100");
  const [funding, setFunding] = useState(false);
  const [claiming, setClaiming] = useState(false);
  // How much B3TR the app's reward pool currently has to pay out.
  const [pool, setPool] = useState({ status: "loading", b3tr: 0 });
  // Full payout self-diagnosis: backend health + on-chain checks, run from THIS
  // browser so it works even when the server can't see the chain. Pinpoints the
  // exact reason payouts fail instead of leaving the admin guessing.
  const [diag, setDiag] = useState({ status: "loading" });
  // Setup/diagnostics (System check + Fund pool) are collapsed by default so the
  // day-to-day view (participants + search) stays uncluttered.
  const [opsOpen, setOpsOpen] = useState(false);
  const [pausing, setPausing] = useState(false);

  async function runDiagnostics(signal) {
    const d = { status: "done", backend: null, health: null, chain: null };
    try {
      const res = await fetch(`${REWARD_API.replace(/\/$/, "")}/health`, { signal });
      d.backend = res.ok;
      if (res.ok) d.health = await res.json();
    } catch { d.backend = false; }
    const distributor = d.health?.distributor || null;
    try {
      d.chain = await fetchDiagnostics({
        node: ACTIVE_NODE,
        poolContract: CONTRACTS.X2EarnRewardsPool,
        appsContract: CONTRACTS.X2EarnApps,
        appId: VEBETTER_APP_ID,
        distributor,
        signal,
      });
    } catch { d.chain = null; }
    setDiag(d);
  }

  function refreshPool(signal) {
    return fetchPoolBalance({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, signal })
      .then(res => setPool(res.ok ? { status: "live", b3tr: res.b3tr } : { status: "error", b3tr: 0 }))
      .catch(() => setPool({ status: "error", b3tr: 0 }));
  }

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    fetchOnChainLeaderboard({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, signal: ctrl.signal })
      .then(res => { if (!cancelled) setChain(res.ok ? { status: "live", rows: res.rows } : { status: "empty", rows: [], reason: res.reason }); })
      .catch(() => { if (!cancelled) setChain({ status: "error", rows: [] }); });
    refreshPool(ctrl.signal);
    runDiagnostics(ctrl.signal).catch(() => {});
    return () => { cancelled = true; ctrl.abort(); };
  }, []);

  // Load one wallet's full on-chain history (incl. the meter numbers it used).
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const ctrl = new AbortController();
    setDetail({ status: "loading", rows: [] });
    fetchWalletHistory({ node: ACTIVE_NODE, contract: CONTRACTS.X2EarnRewardsPool, appId: VEBETTER_APP_ID, address: selected, signal: ctrl.signal })
      .then(res => { if (!cancelled) setDetail(res.ok ? { status: "live", rows: res.rows } : { status: "empty", rows: [], reason: res.reason }); })
      .catch(e => { if (!cancelled) setDetail({ status: "error", rows: [], error: e?.message || "request failed" }); });
    return () => { cancelled = true; ctrl.abort(); };
  }, [selected, detailReload]);

  const totalB3tr = chain.rows.reduce((a, r) => a + (r.b3tr || 0), 0);
  const totalSubs = chain.rows.reduce((a, r) => a + (r.count || 0), 0);

  // The on-chain list only contains wallets that already earned. Merge in everything
  // the backend knows (app-seen testers, meter owners, paired devices, bans) so new
  // wallets show up on their own — no manual adding.
  const allRows = (() => {
    const seenAddrs = new Set(chain.rows.map(r => String(r.addr).toLowerCase()));
    const extra = (knownWallets || [])
      .filter(w => !seenAddrs.has(String(w.address).toLowerCase()))
      .map(w => ({ addr: w.address, b3tr: 0, count: 0, isNew: true, meters: w.meters || [], banned: !!w.banned }))
      .sort((a, b) => a.addr.localeCompare(b.addr));
    return [...chain.rows, ...extra];
  })();

  const q = query.trim().toLowerCase();
  const isFullAddr = /^0x[0-9a-f]{40}$/.test(q);
  const filtered = q ? allRows.filter(r => r.addr.toLowerCase().includes(q)) : allRows;

  const headerBar = (title, sub, onBack) => (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px",borderBottom:`1px solid ${T.border}`}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        {onBack && <button onClick={onBack} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 10px",fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>←</button>}
        <div>
          <div style={{fontSize:14,fontWeight:800,color:T.text}}>{title}</div>
          <div style={{fontSize:10.5,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,marginTop:2}}>{sub}</div>
        </div>
      </div>
      <button onClick={onClose} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 14px",minHeight:44,fontSize:12,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Close</button>
    </div>
  );

  // ── Per-wallet detail ──────────────────────────────────────────────────────
  if (selected) {
    const row = chain.rows.find(r => r.addr.toLowerCase() === selected.toLowerCase());
    const meters = (() => {
      const m = new Map();
      for (const r of detail.rows) {
        if (!r.meterNo) continue;
        const key = `${r.type}:${r.meterNo}`;
        if (!m.has(key)) m.set(key, { utility: r.type, meterNo: r.meterNo, count: 0, last: r.cur });
        m.get(key).count++;
      }
      return [...m.values()];
    })();
    return (
      <div {...dlg} style={{position:"fixed",inset:OVERLAY_INSET,background:T.bg,zIndex:320,display:"flex",flexDirection:"column"}}>
        {headerBar("🛡️ Wallet detail", `On-chain · ${NETWORK_LABEL}`, () => setSelected(null))}
        <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px"}}>
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
              <div style={{fontSize:13,fontWeight:700,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.text}}>{shortAddr(selected)}</div>
              <button onClick={() => { navigator.clipboard?.writeText(selected).catch(() => {}); }} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"4px 8px",fontSize:10,fontWeight:700,color:T.textMid,cursor:"pointer"}}>Copy</button>
            </div>
            <div style={{fontSize:10.5,color:T.textSoft,wordBreak:"break-all",marginTop:4,fontFamily:"'SF Mono',Menlo,'Courier New',monospace"}}>{selected}</div>
            <div style={{display:"flex",gap:16,marginTop:10}}>
              <div><span style={{fontSize:15,fontWeight:600,color:T.green3}}>{row ? row.b3tr.toFixed(2) : (detail.rows.reduce((a,r)=>a+(parseFloat(r.b3tr)||0),0)).toFixed(2)}</span> <span style={{fontSize:10.5,color:T.textSoft}}>B3TR</span></div>
              <div><span style={{fontSize:15,fontWeight:600,color:T.text}}>{detail.rows.length}</span> <span style={{fontSize:10.5,color:T.textSoft}}>submissions</span></div>
              <div><span style={{fontSize:15,fontWeight:600,color:T.text}}>{meters.length}</span> <span style={{fontSize:10.5,color:T.textSoft}}>meters</span></div>
            </div>
          </div>

          {/* A failed fetch used to look exactly like "this wallet has nothing" —
              zeros everywhere — which is misleading when a wallet DOES have history.
              Surface the failure and offer a retry instead. */}
          {detail.status === "error" && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,padding:"11px 12px",marginBottom:12}}>
              <div style={{fontSize:11,color:T.text,lineHeight:1.5}}>
                ⚠️ <b>Couldn't load this wallet's on-chain history.</b> The counts below are not reliable — the node didn't respond{detail.error ? ` (${detail.error})` : ""}.
              </div>
              <button onClick={() => setDetailReload(n => n + 1)} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"7px 11px",fontSize:11,fontWeight:700,color:T.textMid,cursor:"pointer",whiteSpace:"nowrap"}}>Retry</button>
            </div>
          )}
          {detail.status === "empty" && detail.reason && (
            <div style={{background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,padding:"11px 12px",marginBottom:12,fontSize:11,color:T.text,lineHeight:1.5}}>
              ⚠️ History unavailable ({detail.reason}) — check the VeBetterDAO App ID and network.
            </div>
          )}

          <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"4px 2px 8px"}}>Meters used</div>
          {detail.status === "loading" && <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:18}}>Loading…</div>}
          {detail.status === "live" && meters.length === 0 && <div style={{color:T.textSoft,fontSize:11,padding:"6px 2px"}}>No meters found on-chain for this wallet.</div>}
          {meters.map((m, i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,background:getColorBg(m.utility,T),border:`1px solid ${T[m.utility+"Border"]||T.border}`,borderRadius:6,padding:"9px 12px",marginBottom:6}}>
              <span style={{fontSize:15}}>{UTIL_ICONS[m.utility]}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:700,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",color:T.text}}>{m.meterNo}</div>
                <div style={{fontSize:10.5,color:T.textSoft,textTransform:"capitalize"}}>{m.utility} · {m.count} reading{m.count!==1?"s":""} · last {m.last}</div>
              </div>
            </div>
          ))}

          <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".8px",color:T.textSoft,margin:"16px 2px 8px"}}>Recent submissions</div>
          {detail.status === "loading" && <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:14}}>Loading…</div>}

          {/* Example rows when the wallet has no submissions yet — so you can see
              exactly how a real one will look. */}
          {detail.status === "live" && detail.rows.length === 0 && (() => {
            const MONO = "'SF Mono',Menlo,'Courier New',monospace";
            const ghost = (icon, title, sub, amt) => (
              <div style={{display:"flex",alignItems:"center",gap:10,background:T.bgAlt,border:`1px dashed ${T.border}`,borderRadius:10,padding:"10px 12px",marginBottom:6,opacity:.7}}>
                <span style={{fontSize:16}}>{icon}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.textMid}}>{title}</div>
                  <div style={{fontSize:10,color:T.textSoft,fontFamily:MONO}}>{sub}</div>
                  <div style={{fontSize:10.5,color:T.textSoft,marginTop:2}}>2026-08-02 · tx ↗</div>
                </div>
                <div style={{fontSize:13,fontWeight:800,color:T.green3,fontFamily:MONO,whiteSpace:"nowrap"}}>{amt}</div>
              </div>
            );
            return (
              <div>
                <div style={{fontSize:10,color:T.textSoft,marginBottom:8}}>No submissions yet — here's what they'll look like (example):</div>
                {ghost("⚡", "Meter reading", "3775 → 3781 · 6.0 kWh used", "+1.22")}
              </div>
            );
          })()}

          {detail.rows.slice(0, 30).map((r) => (
            <SubmissionRow key={r.id} r={r} T={T} onAdminApi={onAdminApi} onToast={onToast} archiveOn={!!(onAdminApi && diag.health?.photoArchive)} />
          ))}
          {onAdminApi && diag.health && !diag.health.photoArchive && detail.rows.length > 0 && (
            <div style={{marginTop:2,fontSize:10.5,color:T.textSoft,padding:"0 2px"}}>
              📷 Photo review is off. Set the R2 keys in the backend to keep a thumbnail of each submission here.
            </div>
          )}

          {onAdminApi
            ? <>
                <WalletAdminActions T={T} address={selected} meters={meters} onAdminApi={onAdminApi} onToast={onToast} />
                <FlaggedPanel T={T} address={selected} onAdminApi={onAdminApi} />
                <AccessPassPanel T={T} address={selected} onAdminApi={onAdminApi} onToast={onToast} />
                <PassportPanel T={T} address={selected} onAdminApi={onAdminApi} onAssignSignaler={onAssignSignaler} onToast={onToast} />
              </>
            : (
              <div style={{marginTop:16,padding:"10px 12px",background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,fontSize:10.5,color:T.textMid,lineHeight:1.6}}>
                ℹ️ This view is read-only (the blockchain is the source of truth). <strong>Editing</strong> a wallet's meters requires the reward backend (meters are otherwise stored on each user's own device).
              </div>
            )}
        </div>
      </div>
    );
  }

  // ── Participant list + search ──────────────────────────────────────────────
  return (
    <div {...dlg} style={{position:"fixed",inset:OVERLAY_INSET,background:T.bg,zIndex:320,display:"flex",flexDirection:"column"}}>
      {headerBar("🛡️ Admin · Participants", `Read-only on-chain monitor · ${NETWORK_LABEL}`, null)}
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
          {[
            { k:"Participants",     v: chain.rows.length },
            { k:"B3TR Distributed", v: totalB3tr.toFixed(2) },
            { k:"Submissions",      v: totalSubs },
          ].map(s => (
            <div key={s.k} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 8px",textAlign:"center"}}>
              <div style={{fontSize:17,fontWeight:600,color:T.text,fontFamily:"'SF Mono',monospace"}}>{s.v}</div>
              <div style={{fontSize:7.5,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft,marginTop:3}}>{s.k}</div>
            </div>
          ))}
        </div>

        <AccessModePanel T={T} onAdminApi={onAdminApi} onToast={onToast} />

        <button onClick={() => setOpsOpen(o => !o)} style={{display:"flex",width:"100%",alignItems:"center",justifyContent:"space-between",background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 14px",marginBottom:12,cursor:"pointer",color:T.text}}>
          <span style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px"}}>⚙️ Setup &amp; diagnostics</span>
          <span style={{color:T.textSoft,fontSize:13}}>{opsOpen ? "▲ hide" : "▼ show"}</span>
        </button>
        {opsOpen && (<>
        {(() => {
          const h = diag.health, c = diag.chain;
          const authorized = c?.distributorAuthorized ?? h?.distributorAuthorized ?? null;
          const poolOk = (c?.poolB3TR ?? h?.poolB3TR ?? null);
          const vtho = c?.distributorVTHO ?? null;
          const payouts = c?.payoutCount ?? null;
          const Row = ({ ok, label, fix }) => (
            <div style={{display:"flex",gap:8,alignItems:"flex-start",padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <span style={{fontSize:13,lineHeight:"16px"}}>{ok === null ? "◌" : ok ? "✅" : "❌"}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:11.5,fontWeight:700,color:ok === false ? T.gas : T.text}}>{label}</div>
                {ok === false && fix && <div style={{fontSize:10.5,color:T.textMid,lineHeight:1.45,marginTop:2}}>{fix}</div>}
              </div>
            </div>
          );
          return (
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"12px 14px",marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px",color:T.green3}}>🩺 System check</div>
                <button onClick={() => { setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); }}
                  style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 10px",fontSize:10,fontWeight:700,color:T.textMid,cursor:"pointer"}}>
                  {diag.status === "loading" ? "…" : "↻ Re-run"}
                </button>
              </div>
              {diag.status === "loading" ? (
                <div style={{fontSize:11,color:T.textSoft,padding:"8px 0"}}>Running checks…</div>
              ) : (
                <>
                  <Row ok={diag.backend} label={`Reward backend online${h?.network ? ` (${h.network})` : ""}`}
                    fix="The Render service is unreachable or asleep — open the /health URL once to wake it, and check the Render dashboard." />
                  <Row ok={authorized} label="Distributor wallet has the reward-distributor role"
                    fix={`THIS IS THE USUAL CAUSE OF REVERTED PAYOUTS. In the VeBetterDAO ${NETWORK} dashboard, open your app → settings → Reward distributors, and add ${h?.distributor || "the distributor wallet"} — then sign and retry.`} />
                  {(() => {
                    const adminAddr = c?.appAdmin ?? h?.appAdmin ?? null;
                    const a = adminAddr ? String(adminAddr).toLowerCase() : null;
                    const isMe = !!(a && wallet && a === String(wallet).toLowerCase());
                    const isDistributor = !!(a && h?.distributor && a === String(h.distributor).toLowerCase());
                    return <Row ok={a === null ? null : (isMe || isDistributor)}
                      label={`On-chain app admin: ${adminAddr ? shortAddr(adminAddr) : "unknown"}${isMe ? " — your connected wallet ✓" : isDistributor ? " — the server's distributor (bucket moves run server-side) ✓" : ""}`}
                      fix={`Only the app-admin wallet may move funds between buckets or toggle the rewards-pool feature. Admin is ${adminAddr || "unknown"} — connect VeWorld with THAT wallet and retry, or change the app admin in the VeBetterDAO dashboard.`} />;
                  })()}
                  {(() => {
                    const rpEnabled = c?.rewardsPoolEnabled ?? h?.rewardsPoolEnabled ?? null;
                    const rpBal = c?.rewardsPoolB3TR ?? h?.rewardsPoolB3TR ?? null;
                    // With the rewards-pool feature ON, moving the whole deposit into
                    // the distributable bucket legitimately empties availableFunds —
                    // total funding is what matters, so count BOTH buckets here.
                    const totalFunded = (poolOk ?? 0) + (rpEnabled === true ? (rpBal ?? 0) : 0);
                    const fundedOk = poolOk === null && rpBal === null ? null : totalFunded > 0;
                    // Feature off → payouts draw straight from available funds (fine).
                    // Feature ON → the distributable bucket itself must hold B3TR.
                    const distOk = rpEnabled === null ? null : (rpEnabled === false ? true : (rpBal === null ? null : rpBal > 0));
                    return (<>
                      <Row ok={fundedOk} label={`Reward pool funded${poolOk != null ? ` (${poolOk.toFixed(2)} available${rpEnabled === true && rpBal != null ? ` + ${rpBal.toFixed(2)} distributable` : ""})` : ""}`}
                        fix="No B3TR in either bucket for this app id — use the Fund rewards pool card below." />
                      <Row ok={distOk}
                        label={rpEnabled === false
                          ? "Distributable balance (rewards-pool feature off — pays from available funds)"
                          : `Distributable rewards-pool balance${rpBal != null ? ` (${rpBal.toFixed(2)} B3TR)` : ""}`}
                        fix="FOUND IT — the rewards-pool feature is ON for this app, so payouts draw from THIS bucket, not from 'available funds'. Your deposit is sitting in the wrong bucket. Use the 'Move to rewards pool' button below (you sign as app admin), then re-run this check." />
                    </>);
                  })()}
                  <Row ok={h?.delegation ? true : (vtho === null ? null : vtho >= 1)}
                    label={h?.delegation ? "Gas sponsored via fee delegation" : `Distributor has gas${vtho != null ? ` (${vtho.toFixed(1)} VTHO)` : ""}`}
                    fix={NETWORK === "mainnet" ? `Send some VTHO to ${h?.distributor || "the distributor wallet"} — it pays the gas for every payout.` : `Send free testnet VTHO to ${h?.distributor || "the distributor wallet"} via faucet.vecha.in.`} />
                  <Row ok={payouts === null ? null : payouts > 0} label={payouts != null ? `${payouts >= 20 ? "20+" : payouts} payout${payouts === 1 ? "" : "s"} recorded on-chain${c?.lastPayoutAt ? ` — last ${new Date(c.lastPayoutAt).toLocaleString()}` : ""}` : "Payouts recorded on-chain"}
                    fix="No payout has EVER landed on-chain for this app id. Fix the failing checks above, submit a reading, then re-run this check." />
                  <Row ok={c?.distributionPaused == null ? null : !c.distributionPaused}
                    label={c?.distributionPaused === true ? "Payouts are PAUSED (emergency stop)" : c?.distributionPaused === false ? "Payouts are running (not paused)" : "Emergency stop: status unknown"}
                    fix="Every claim fails while payouts are paused. Press Resume payouts below once the problem is fixed." />
                  {(() => {
                    const b = h?.rewardBudget;
                    if (!b) return null;
                    const pct = Math.round((b.factor ?? 1) * 100);
                    const ends = b.roundEndsAt ? new Date(b.roundEndsAt).toLocaleString() : null;
                    return <Row ok={b.poolB3TR == null ? null : b.poolB3TR > 0}
                      label={`Weekly budget: rewards at ${pct}%${b.poolB3TR != null ? ` · ${b.poolB3TR.toFixed(2)} B3TR in the pot` : ""} · ${b.dailyBudget != null ? `${b.dailyBudget} a day` : "?"} vs ${b.dailyDemand} claimed a day${ends ? ` · round ends ${ends}` : ""}`}
                      fix="The pot is empty: payouts are refused until the round ends and its allocation is claimed (the server does that by itself within the hour), or fund the pool below." />;
                  })()}
                  {onSetDistributionPaused && c?.distributionPaused != null && (
                    <div style={{paddingTop:10}}>
                      <button disabled={pausing}
                        onClick={async () => { setPausing(true); try { const tx = await onSetDistributionPaused(!c.distributionPaused); if (tx) { setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); } } finally { setPausing(false); } }}
                        style={{background: c.distributionPaused ? T.green3 : "transparent", color: c.distributionPaused ? "#fff" : T.gas, border: c.distributionPaused ? "none" : `1px solid ${T.gasBorder}`, borderRadius:6, padding:"8px 12px", fontSize:11, fontWeight:700, cursor: pausing ? "default" : "pointer", opacity: pausing ? 0.6 : 1}}>
                        {pausing ? "…" : c.distributionPaused ? "▶ Resume payouts" : "⏸ Pause all payouts"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {onFundPool && (
          <div style={{background:T.card,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"12px 14px",marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:800,textTransform:"uppercase",letterSpacing:".6px",color:T.green3,marginBottom:6}}>🎁 Fund rewards pool</div>
            {(() => {
              const empty = pool.status === "live" && pool.b3tr <= 0;
              const c = pool.status === "live" ? (empty ? T.gas : T.green3) : T.textSoft;
              return (
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,background:T.bgAlt,border:`1px solid ${empty ? T.gasBorder : T.border}`,borderRadius:6,padding:"9px 12px",marginBottom:10}}>
                  <span style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",color:T.textSoft}}>Pool balance</span>
                  <span style={{display:"inline-flex",alignItems:"center",fontSize:14,fontWeight:700,color:c,fontFamily:"'SF Mono',Menlo,'Courier New',monospace"}}>
                    {pool.status === "loading" ? "…" : pool.status === "error" ? "—" : `${pool.b3tr.toFixed(2)} B3TR`}
                    {empty && <span style={{fontSize:10.5,fontWeight:700,marginLeft:6,color:T.gas,background:T.gasBg,border:`1px solid ${T.gasBorder}`,borderRadius:6,padding:"1px 5px"}}>EMPTY</span>}
                  </span>
                </div>
              );
            })()}
            <div style={{fontSize:10.5,color:T.textMid,lineHeight:1.5,marginBottom:10}}>Deposit B3TR from your connected wallet into this app's reward pool. You sign one transaction (approve + deposit) in your wallet.</div>
            <div style={{display:"flex",gap:8}}>
              <input value={fundAmt} onChange={e=>setFundAmt(e.target.value)} type="number" min="0" step="1" placeholder="B3TR amount"
                style={{flex:1,boxSizing:"border-box",background:T.bgAlt,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",fontSize:13,color:T.text,outline:"none"}} />
              <button disabled={funding} onClick={async()=>{ setFunding(true); try { await onFundPool(fundAmt); setPool(p=>({...p,status:"loading"})); setTimeout(()=>refreshPool(), 8000); } finally { setFunding(false); } }}
                style={{background:T.green2,color:T.bg,border:0,borderRadius:6,padding:"10px 16px",fontWeight:700,fontSize:13,cursor:"pointer",opacity:funding?0.6:1,whiteSpace:"nowrap"}}>
                {funding ? "Signing…" : "Fund pool"}
              </button>
            </div>
            {onMoveToRewardsPool && (
              <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:10,color:T.textSoft,lineHeight:1.45,flex:1}}>Payouts reverting while funded? Move the deposit into the app's distributable rewards-pool bucket (same amount field above).</div>
                <button disabled={funding} onClick={async()=>{ setFunding(true); try { await onMoveToRewardsPool(fundAmt); setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); } finally { setFunding(false); } }}
                  style={{background:"transparent",color:T.green3,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"8px 12px",fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap",opacity:funding?0.6:1}}>
                  ⇄ Move to rewards pool
                </button>
              </div>
            )}
            {onDisableRewardsPool && (
              <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:10,color:T.textSoft,lineHeight:1.45,flex:1}}>Or turn the rewards-pool feature OFF so payouts draw straight from available funds (no bucket-moving needed).</div>
                <button disabled={funding} onClick={async()=>{ setFunding(true); try { await onDisableRewardsPool(); setDiag({ status: "loading" }); runDiagnostics().catch(() => {}); } finally { setFunding(false); } }}
                  style={{background:"transparent",color:T.textMid,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 12px",fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap",opacity:funding?0.6:1}}>
                  🔧 Disable feature
                </button>
              </div>
            )}
            {onClaimB3TR && (
              <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                <div style={{fontSize:10,color:T.textSoft,lineHeight:1.45,flex:1}}>No test-B3TR yet? Claim a free batch from the testnet faucet first, then fund the pool.</div>
                <button disabled={claiming} onClick={async()=>{ setClaiming(true); try { await onClaimB3TR(); } finally { setClaiming(false); } }}
                  style={{background:"transparent",color:T.green3,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"8px 12px",fontWeight:700,fontSize:11,cursor:"pointer",opacity:claiming?0.6:1,whiteSpace:"nowrap"}}>
                  {claiming ? "Claiming…" : "💧 Claim test-B3TR"}
                </button>
              </div>
            )}
          </div>
        )}
        </>)}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔎 Search wallet address (0x…)"
          spellCheck={false}
          style={{width:"100%",boxSizing:"border-box",background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 12px",fontSize:12,color:T.text,fontFamily:"'SF Mono',Menlo,'Courier New',monospace",outline:"none",marginBottom:10}}
        />

        {/* The on-chain list only has wallets that already earned. One tap pulls in
            everyone the backend knows — testers who connected or registered a meter
            but haven't submitted yet — so nothing has to be added by hand. */}
        {onAdminApi && (
          <div style={{marginBottom:12}}>
            <button
              disabled={loadingWallets}
              onClick={async () => {
                setLoadingWallets(true);
                try {
                  const d = await onAdminApi("/admin/wallets", {});
                  setKnownWallets(d.wallets || []);
                  const extra = (d.wallets || []).filter(w => !chain.rows.some(r => r.addr.toLowerCase() === String(w.address).toLowerCase())).length;
                  onToast?.(extra ? `✅ ${extra} wallet(s) without rewards added to the list` : "✅ No extra wallets — everyone already shows");
                } catch (e) { onToast?.(`❌ ${e?.message || "could not load wallets"}`); }
                finally { setLoadingWallets(false); }
              }}
              style={{width:"100%",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",fontSize:11,fontWeight:700,color:T.textMid,cursor:loadingWallets?"default":"pointer",opacity:loadingWallets?0.6:1}}>
              {loadingWallets ? "Loading…" : knownWallets ? "🔄 Refresh all wallets" : "👥 Show all wallets (incl. no rewards yet)"}
            </button>
          </div>
        )}

        {isFullAddr && !filtered.some(r => r.addr.toLowerCase() === q) && (
          <div role="button" tabIndex={0} onClick={() => setSelected(q)} style={{cursor:"pointer",background:T.green5||T.bgAlt,border:`1px solid ${T.green4||T.border}`,borderRadius:6,padding:"11px 12px",marginBottom:10,fontSize:11,fontWeight:700,color:T.green3}}>
            Look up this wallet → {shortAddr(q)} (no rewards yet, view its meters/history)
          </div>
        )}

        {chain.status === "loading" && (
          <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:24}}>Loading on-chain participants…</div>
        )}
        {chain.status !== "loading" && chain.rows.length === 0 && (
          <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:24,lineHeight:1.6}}>
            {chain.reason === "unset_appid"
              ? "Set your VeBetterDAO App ID to load participants."
              : chain.status === "error" ? "Could not reach the node — try again later." : "No on-chain submissions yet."}
          </div>
        )}
        {chain.rows.length > 0 && filtered.length === 0 && !isFullAddr && (
          <div style={{textAlign:"center",color:T.textSoft,fontSize:11,padding:18}}>No participant matches “{query}”.</div>
        )}
        {filtered.map((r, i) => (
          <div role="button" tabIndex={0} key={r.addr} className="lb-item" style={{cursor:"pointer"}} onClick={() => setSelected(r.addr)}>
            <div className="lb-rank">{q || r.isNew ? "•" : i + 1}</div>
            <div style={{flex:1}}>
              <div className="lb-name" style={{fontFamily:"'SF Mono',monospace",fontSize:11}}>
                {shortAddr(r.addr)}
                {r.banned && <span style={{marginLeft:6,fontSize:8,fontWeight:800,color:"#c0392b"}}>BLOCKED</span>}
              </div>
              <div style={{fontSize:10.5,color:T.textSoft}}>
                {r.isNew
                  ? `🆕 No rewards yet${r.meters?.length ? ` · ${r.meters.length} meter${r.meters.length !== 1 ? "s" : ""} registered` : ""} · tap to view`
                  : `📸 ${r.count} submission${r.count !== 1 ? "s" : ""} · tap to view`}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div className="lb-b3tr" style={r.isNew ? {color:T.textSoft} : undefined}>+{r.b3tr.toFixed(2)}</div>
              <div style={{fontSize:10.5,color:T.textSoft}}>B3TR</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
