# GreenUtilityLog — Home Assistant integration

Sends your meter reading to GreenUtilityLog automatically, so you never photograph the
meter again. Home Assistant already reads your meter — whatever your country uses
(DSMR/P1, HAN, Tibber, an optical head) — and this forwards that number on a timer.

## Install via HACS

1. HACS → ⋮ → **Custom repositories** → add
   `https://github.com/GreenUtilityLog/GreenUtilityLog` as an **Integration**.
2. Install **GreenUtilityLog**, then restart Home Assistant.
3. **Settings → Devices & services → Add integration → GreenUtilityLog**.

## Set it up

1. In the app, do **one photo submission** first — that sets your meter's starting
   point. Automatic readings can't pay out without it.
2. In the app: **Submit → ⚡ Have a P1 reader? → ⚙️ Automatic setup → “Get my device
   token”**. Copy it.
3. In the integration dialog: paste the token, pick the sensor holding your
   **cumulative kWh** (the value that keeps counting up — not current power), and
   choose how often to send.

That's it. Your reading then appears in the app under **“Auto-received”**, where you
tap **Submit — no photo**.

## What you get

- A diagnostic sensor **Last sent reading** — the last value successfully sent, with
  the timestamp and any error as attributes. If something breaks, it shows here.
- A service **`greenutilitylog.push_now`** to send immediately instead of waiting for
  the next interval. Useful right after setup.

## Options

Change the meter entity, interval, token or server address any time via
**Configure** on the integration — no reinstall.

## Troubleshooting

| Attribute `last_error` says | What to do |
|---|---|
| `entity … not found` | The sensor was renamed or removed — pick it again under Configure. |
| `… is unavailable` | Normal during a restart; it recovers on the next interval. |
| `server said 401` | Wrong or revoked token — get a fresh one in the app. |
| `submit one photo reading first` | You skipped the baseline. Do one photo submission in the app. |

Full guide: <https://greenutilitylog.github.io/GreenUtilityLog/guide.html>
