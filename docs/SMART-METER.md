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

`GET /health` reports `meterIngest: true` and `enode: { enabled, env }`.

---

## Roadmap
- **Step 1 (done):** pairing + ingestion + Enode adapter + app card showing the live
  reading, "Use this reading" prefills the Current field.
- **Step 2 (next):** photoless payout — a `/reward-from-meter` endpoint that trusts a
  fresh ingested reading (cert-authed) instead of a photo, so the whole submission is
  automatic.
- **Step 3 (later):** more first-class sources (HomeWizard local/cloud, Tibber) and
  a background auto-submit on a schedule.
