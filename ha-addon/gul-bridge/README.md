# GreenUtilityLog Meter Bridge (Home Assistant add-on)

Sends your smart-meter reading to GreenUtilityLog automatically — **no terminal, no
scripts, no YAML**. Install it, paste your token, press Start.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Add `https://github.com/GreenUtilityLog/GreenUtilityLog`.
3. Install **GreenUtilityLog Meter Bridge** from the list.

## Set it up

1. In the app, do **one photo submission** first — that sets your meter's baseline
   (needed once).
2. In the app: **Submit → Electricity → ⚙️ Automatic setup → "Get my device token"**.
   Copy it.
3. In the add-on's **Configuration** tab, paste it into **token**. Press **Save**,
   then **Start**.
4. Open the **Log** tab — you should see `pushed 8421.3 kWh ✓`.

Your reading then appears in the app under **"Auto-received"** → tap
**"Submit — no photo"**.

## Options

| Option | Default | What it does |
|---|---|---|
| `token` | — (required) | Your device token from the app |
| `interval_sec` | `3600` | Seconds between pushes (min 60) |
| `hw_ip` | auto-discover | Your HomeWizard's IP — only needed if discovery fails |
| `read_url` | — | Read from **any** HTTP/JSON reader instead of a HomeWizard |
| `read_field` | auto-detect | Dot-path to the kWh value in that JSON |
| `ingest_url` | public backend | Leave as-is unless you run your own backend |

## Not a HomeWizard?

Any reader that serves its data as JSON over HTTP works — set **read_url** to it (and
**read_field** if the value isn't found automatically). Prefer to use Home Assistant's
own sensor instead? Then you don't need this add-on: use the `rest_command` snippet
shown in the app's Automatic setup.

## Troubleshooting

- **"No HomeWizard found"** — turn on **Local API** in the HomeWizard Energy app
  (Settings → Meters → your P1), or set **hw_ip** manually.
- **"couldn't find a total import kWh"** — the reader returned JSON the bridge didn't
  recognise; set **read_field** to the dot-path of the cumulative kWh value.
- **Nothing in the app** — check the token, and that you did one photo submission
  first to set the baseline.
