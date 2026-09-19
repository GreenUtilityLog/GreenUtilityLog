# 🔌 GreenUtilityLog meter bridge

Auto-submit your electricity meter with **one command** — run it once on any
always-on machine (Raspberry Pi, NAS, old laptop) and it keeps pushing your meter
total to GreenUtilityLog. **No cron, no jq, no scripting.**

Two modes:
- **HomeWizard P1** (default) — it **finds your HomeWizard on the network by itself**
  (mDNS) and reads it. No IP to look up.
- **Any other reader** — point it at any device that returns your kWh total as JSON
  over HTTP (dsmr-reader, Shelly, a custom endpoint…) with `--url=`.

Zero dependencies — just Node ≥ 18 (or Docker).

## Before you start
1. In the HomeWizard Energy app: **Settings → Meters → your P1 → turn on “Local API.”**
2. In the GreenUtilityLog app: **Submit → Electricity → ⚙️ Automatic setup → “Get my device token.”** (Do one photo submission first to set your baseline.)

## Run it — pick one

It's a single file with no dependencies, so there is nothing to clone or install:
download it and run it. It asks for your token the first time and remembers it, so
every run after that is just `node gul.js`.

**Windows (PowerShell):**
```powershell
iwr https://greenutilitylog.github.io/GreenUtilityLog/gul.js -OutFile gul.js; node gul.js
```

**Mac · Linux · Raspberry Pi:**
```bash
curl -fsSL https://greenutilitylog.github.io/GreenUtilityLog/gul.js -o gul.js && node gul.js
```

> Use the line for your own shell. `VAR=value command` and `&&` are bash syntax;
> PowerShell answers *"The term 'GUL_TOKEN=…' is not recognized"* and does nothing.

**Docker:**
```bash
docker build -t gul-bridge ./bridge
docker run -d --name gul-bridge --network host -e GUL_TOKEN=your-device-token gul-bridge
```
> `--network host` lets the container discover your HomeWizard via mDNS.

Leave it running. It pushes your meter total every hour. Your reading shows up in
the app under **“Auto-received”** → tap **Submit — no photo** to claim.

## Options

Every setting can be given as a **flag** (works in any shell) or as an **environment
variable** (handy for Docker and the Home Assistant add-on). Flags win; then env vars;
then the token saved by a previous run.

| Flag | Env var | Default | What it does |
|---|---|---|---|
| `--token=` | `GUL_TOKEN` | asked for, then saved | Your device token from the app |
| `--ip=` | `HW_IP` | auto-discover | Your HomeWizard’s IP, to skip mDNS discovery |
| `--interval=` | `INTERVAL_SEC` | `3600` | Seconds between pushes (min 60) |
| `--ingest=` | `GUL_INGEST_URL` | public backend | Override the ingest endpoint |
| `--url=` | `READ_URL` | — | Generic mode: read your kWh total from this HTTP/JSON endpoint (skips HomeWizard discovery) |
| `--field=` | `READ_FIELD` | auto-detect | Dot-path to the number in that JSON (e.g. `data.total_kwh`) |
| `--once` | `ONCE=1` | — | Push a single reading and exit (for a cron/systemd timer) |

The token is saved to `.gul-bridge.json` next to the script, so it is never needed on
the command line twice. Anyone who can read that file can submit readings as you.

**Generic example** (any reader that serves JSON):
```bash
node gul.js --url=http://192.168.1.60/api/readings --field=electricity.import_kwh
```

## Notes
- **`node` is not recognized?** Node isn't installed, or the window was already open
  when you installed it. On Windows: `winget install OpenJS.NodeJS.LTS`. Anywhere
  else: [nodejs.org](https://nodejs.org). Then open a **new** terminal — the old one
  doesn't pick up the new PATH. Nothing else is needed; git isn't.
- **Discovery not finding it?** Some networks block mDNS (VLANs, guest Wi-Fi). Add
  `--ip=192.168.1.50` (the IP is in the HomeWizard app) and it skips discovery.
- Readings must be < 48h old to pay out; the usual cooldown / plausibility limits
  still apply. Testnet beta — test tokens, no real-world value yet.
- Only your token can submit for your wallet, so keep it private.
