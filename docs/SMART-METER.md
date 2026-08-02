# 🔗 Smart-meter ingestion (beta)

Goal: an **automatic** electricity reading so a good photo isn't the only way to
submit — reliable enough to attract users beyond NL, across Europe and worldwide.

We build it **step by step**. This is **Step 1: the pipe** — get a live reading
from a real source into the backend and show it in the app. Photoless auto-payout
is Step 2.

---

## The design (one store, two sources)

Every source writes the same thing — a wallet's latest cumulative kWh total — into
one backend store (`linkReadings`, keyed by wallet). The app reads it from one
place (`GET /meter/latest`). Adding a source later never changes the app.

```
 P1 / HAN reader  ─┐
 Home Assistant   ─┼──POST /meter-ingest──►  linkReadings[wallet]  ──►  app shows it
 Enode (global)   ─┘        (or Enode sync)                              "Use this reading"
```

### Source 1 — Push (free, works today, worldwide)
A device that can read the meter (a P1/HAN dongle, or a Home Assistant automation)
POSTs the live total to the backend. Your Landis+Gyr has a **P1 port**, so this is
testable now.

Flow:
1. App → `POST /meter/pair` (wallet-signed) → returns a **device token** + the
   **ingest URL**.
2. The reader POSTs `{ "token": "...", "reading": 12345.6 }` to `/meter-ingest`
   whenever it has a fresh total. The token is the secret that binds the reading to
   the wallet — no token, no write, so nobody can push a fake reading for someone else.
3. App polls `GET /meter/latest?address=…` and shows it.

No env vars needed — this path is always on.

### Source 2 — Enode (optional, global aggregator)
[Enode](https://enode.com) is one API in front of 1000+ energy brands. Shown in the
app only when configured. **Honest constraints:**
- **Paid** for production (real meters). The **sandbox** is free but only returns
  **simulated** devices — good for wiring, you can't link your real meter there.
- Meter support is **beta** and region/DSO-dependent — coverage isn't guaranteed.

Enable it on the backend (**Render → Environment**):

| Env | Value |
|---|---|
| `ENODE_CLIENT_ID` | from your Enode dashboard |
| `ENODE_CLIENT_SECRET` | from your Enode dashboard |
| `ENODE_ENV` | `sandbox` (default) or `production` |
| `ENODE_REDIRECT_URI` | (optional) where Enode returns the user; defaults to the app URL |

Flow: `POST /meter/enode/link` (wallet-signed) → app opens Enode's link UI → user
authorises their meter → `POST /meter/enode/sync` pulls the latest reading into the
same store.

> ⚠️ **Schema still to pin down.** Enode's beta *meter* response fields aren't fixed
> in code yet. `/meter/enode/sync` returns the **raw** meter object so we can read
> the exact reading field off a live account, then tighten `pickReading()` in
> `server/enode.js`. Until then it probes the most likely cumulative-kWh field.

---

## Endpoints (all in `server/index.js`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/meter/pair` | wallet cert | issue a device token + ingest URL |
| POST | `/meter-ingest` | device token | a reader pushes a reading |
| GET | `/meter/latest?address=` | — | latest reading for the app |
| POST | `/meter/enode/link` | wallet cert | start an Enode link session |
| POST | `/meter/enode/sync` | wallet cert | pull latest Enode reading (+ raw) |
| POST | `/reward-from-meter` | wallet cert | **photoless payout** from the latest ingested reading |

`METER_MAX_AGE_MS` (default 48h) bounds how old an ingested reading may be and
still pay out. `AUTO_SUBMIT_MS` (≥ 60000, unset = off) enables the hands-off
scheduler that submits paired meters automatically.

`GET /health` reports `meterIngest: true` and `enode: { enabled, env }`.

---

## Roadmap
- **Step 1 (done):** pairing + ingestion + Enode adapter + app card showing the live
  reading, "Use in form" prefills the Current field.
- **Step 2 (done):** photoless payout — `POST /reward-from-meter` (cert-authed) pays
  from a fresh ingested reading instead of a photo. Trust anchors: the device
  token→wallet binding **and** an existing meter baseline (the meter must be
  registered + baselined by one normal photo submission first, so a device can't
  invent a meter or its starting value). All the usual rules still apply
  (cooldown, monotonic reading, plausibility bounds, per-payout cap). In the app:
  the **Submit — no photo** button on the smart-meter card.
- **Step 3 (done):** hands-off scheduled auto-submit. Set `AUTO_SUBMIT_MS` on the
  backend (ms between sweeps, ≥ 60000) and it walks every paired meter and submits
  its latest pushed reading automatically — no app, no per-submit signature (the
  device token, bound to the wallet at pairing, is the authorisation). Each ingested
  reading pays at most once (a reading is only submitted if it arrived after the
  wallet's last payout), and every other rule (baseline, freshness, cooldown,
  bounds, cap) is enforced exactly like the manual path. The pairing call now stores
  the registered meter number so the scheduler knows which baseline to measure from.
  `GET /health` reports `autoSubmit`.
- **Step 4 (later):** more first-class sources (HomeWizard local/cloud, Tibber).

### Trust model (Step 2)
A photo proved "a real meter showing this number." Without it, two things replace
that proof:
1. **Device-token binding** — only a reader holding the wallet's secret token can
   push a reading, so a value can't be forged for someone else's wallet.
2. **Established baseline** — the auto path never sets the *first* reading; usage is
   always a delta from a server-recorded baseline that a photo submission created.
   Combined with the per-meter→wallet binding and the cooldown, a device can't farm
   more than the genuine conservation reward for the energy actually (not) used.
