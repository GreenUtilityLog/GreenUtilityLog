# 🔌 GreenUtilityLog meter bridge

Auto-submit your electricity meter with **one command** — run it once on any
always-on machine (Raspberry Pi, NAS, old laptop) and it keeps pushing your meter
total to GreenUtilityLog. **No cron, no jq, no scripting.**

Two modes:
- **HomeWizard P1** (default) — it **finds your HomeWizard on the network by itself**
  (mDNS) and reads it. No IP to look up.
- **Any other reader** — point it at any device that returns your kWh total as JSON
  over HTTP (dsmr-reader, Shelly, a custom endpoint…) with `READ_URL`.

Zero dependencies — just Node ≥ 18 (or Docker).

## Before you start
1. In the HomeWizard Energy app: **Settings → Meters → your P1 → turn on “Local API.”**
2. In the GreenUtilityLog app: **Submit → Electricity → ⚙️ Automatic setup → “Get my device token.”** (Do one photo submission first to set your baseline.)

## Run it — pick one

**Node (no Docker):**
```bash
git clone https://github.com/GreenUtilityLog/GreenUtilityLog
cd GreenUtilityLog/bridge
GUL_TOKEN=your-device-token node index.js
```

**Docker:**
```bash
docker build -t gul-bridge ./bridge
docker run -d --name gul-bridge --network host -e GUL_TOKEN=your-device-token gul-bridge
```
> `--network host` lets the container discover your HomeWizard via mDNS.

Leave it running. It pushes your meter total every hour. Your reading shows up in
the app under **“Auto-received”** → tap **Submit — no photo** to claim.

## Options (environment variables)
| Var | Default | What it does |
|---|---|---|
| `GUL_TOKEN` | — (required) | Your device token from the app |
| `HW_IP` | auto-discover | Set your HomeWizard’s IP to skip mDNS discovery |
| `INTERVAL_SEC` | `3600` | Seconds between pushes (min 60) |
| `GUL_INGEST_URL` | public backend | Override the ingest endpoint |
| `READ_URL` | — | Generic mode: read your kWh total from this HTTP/JSON endpoint (skips HomeWizard discovery) |
| `READ_FIELD` | auto-detect | Dot-path to the number in that JSON (e.g. `data.total_kwh`) |
| `ONCE` | — | Set `ONCE=1` to push a single reading and exit (for a cron/systemd timer) |

**Generic example** (any reader that serves JSON):
```bash
GUL_TOKEN=your-token \
READ_URL=http://192.168.1.60/api/readings \
READ_FIELD=electricity.import_kwh \
node index.js
```

## Notes
- **Discovery not finding it?** Some networks block mDNS (VLANs, guest Wi-Fi). Just
  set `HW_IP=192.168.1.50` (see the IP in the HomeWizard app) and it skips discovery.
- Readings must be < 48h old to pay out; the usual cooldown / plausibility limits
  still apply. Testnet beta — test tokens, no real-world value yet.
- Only your token can submit for your wallet, so keep it private.
