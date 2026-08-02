# 🚀 Launch checklist — Green Utility Log

Two stages. You're in **Stage 0 (testing)** now. Do **Stage 1** right before you share
the public tester link. **Stage 2** is later, only when you go to mainnet.

Exact file locations are given so nothing gets missed. Anything under **Render** is an
environment variable you set in the Render dashboard (Service → Environment) — no code
edit, the backend redeploys itself.

---

## ✅ Already done (verified working)
Payouts land on-chain · conservation reward is correct · admin System Check · camera-only
photos · honest testnet copy · analytics dashboard · error toasts you can read/copy.

---

## 🟡 Stage 1 — before sharing the PUBLIC tester link

### Anti-farming (the important part)
| What | Where | Set to |
|---|---|---|
| Cooldown — server (enforcing) | **Render** env `COOLDOWN_MS` | `72000000`  (20h) |
| Cooldown — app (the UI timer) | `src/App.jsx` line 695 `const COOLDOWN_MS` | `20 * 60 * 60 * 1000` |
| Durable anti-farm state | **Render** env `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | free Upstash Redis (else every redeploy wipes cooldowns/used-photo hashes) |

> ⚠️ Cooldown must be set in **both** places. Server-only = testers see a raw error
> instead of a timer. App-only = the limit is bypassable. For a small closed group you
> may leave it at 0; for a public link, turn it on.

### Optional but recommended
| What | Where | Note |
|---|---|---|
| Captcha (anti-bot) | Cloudflare Turnstile → `src/App.jsx` line 97 `TURNSTILE_SITE_KEY` = site key · **Render** `TURNSTILE_SECRET` = secret | free; both halves needed |
| Better meter OCR | **Render** `ANTHROPIC_API_KEY` (+ optional `OCR_CLAUDE_MODEL=claude-haiku-4-5`) | reads meters far better than in-browser OCR; also enables the AI photo-authenticity check. Costs ~½¢/photo on haiku |
| Lock CORS | **Render** `ALLOWED_ORIGIN` = `https://greenutilitylog.github.io` | replaces the open `*` |
| Smart-meter push (beta) | nothing — always on | pair a P1/HAN reader or Home Assistant to auto-send readings. See `docs/SMART-METER.md` |
| Smart-meter via Enode (beta) | **Render** `ENODE_CLIENT_ID` + `ENODE_CLIENT_SECRET` (+ `ENODE_ENV`) | optional global aggregator; sandbox is free/simulated, real meters need a paid Enode plan |

### Sanity check before you post the link
1. Open `<render-url>/health` → `ok:true`, distributor correct.
2. Admin → System Check → all green (incl. distributable rewards-pool balance).
3. One real submission end-to-end → `+B3TR` toast with tx → shows in admin + explorer.
4. Reward pool has enough B3TR for the tester round (admin → Pool balance).

---

## 🔵 Stage 2 — mainnet (much later, only when leaving testnet)
| What | Where | Set to |
|---|---|---|
| Network | `src/App.jsx` line 16 `const NETWORK` | `"mainnet"` |
| App id | `src/App.jsx` `VEBETTER_APP_ID` | your **mainnet** app id after mainnet registration |
| Render | env `NETWORK=mainnet`, `APP_ID=<mainnet id>` | |
| Distributor | a **mainnet** wallet with the role + VTHO; fund the mainnet pool with real B3TR | |
| Treasury safety | add a per-day distribution cap before loading a mainnet key | not built yet — ask me |

Faucet auto-hides on mainnet; the exposed test-only faucet address is testnet-only.

---

## The one-line summary
**To open the public tester beta:** set `COOLDOWN_MS` in Render + `src/App.jsx`, add the
two Upstash env vars, run the 4 sanity checks, then share the link. Everything else is
optional polish or mainnet-only.
