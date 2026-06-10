# Green Utility Log — Reward Distributor

A small backend that issues B3TR rewards for verified meter submissions. It holds
the VeBetterDAO **reward-distributor** role so users never have to (and can't farm
the pool themselves).

```
Frontend submit ──POST /reward──► this service ──verify──► distributeReward() ──► user gets B3TR
                                       │
                                   (distributor wallet signs)
```

## Why this exists

On VeBetterDAO, only an address with the **reward-distributor role** can call
`X2EarnRewardsPool.distributeReward(...)`. If the user's own wallet calls it, the
transaction reverts. So a trusted server — this one — verifies each submission and
issues the payout. It's also your moderation point: you decide what gets paid.

## Setup

```bash
cd server
npm install
cp .env.example .env
# edit .env: set DISTRIBUTOR_PRIVATE_KEY (and NETWORK/APP_ID if different)
npm start            # or: npm run dev
```

Then point the frontend at it — in `src/App.jsx` set:

```js
const REWARD_API = "http://localhost:8787"; // or your deployed URL
```

When `REWARD_API` is set, the app POSTs submissions here and the user signs
nothing. When it's empty, the app falls back to the direct on-chain flow (which
only works if the connected wallet itself holds the distributor role).

## Prerequisites on VeBetterDAO

1. App registered on the **same network** as `NETWORK`.
2. The distributor wallet (`DISTRIBUTOR_PRIVATE_KEY`) is granted the
   **reward-distributor role** for the app (in the governance dashboard).
3. The app's **reward pool is funded** with B3TR.
4. The distributor wallet has a little **VTHO** for gas.

## Endpoints

| Method | Path      | Body                                                                | Returns               |
|--------|-----------|---------------------------------------------------------------------|-----------------------|
| GET    | `/health` | –                                                                   | service + distributor |
| POST   | `/reward` | `{ utility, reading, prevRead, meterNo, address, photo }`           | `{ txid, amount }`    |

`photo` is the meter image as a base64 string (data-URL prefix optional). The
reward **amount is always recomputed server-side** (`usage × rate`); a
client-sent amount is never trusted.

## What it verifies

- Valid wallet address, known utility, meter number present.
- `current > previous`, and usage within plausible bounds (mirrors the app).
- Per wallet+utility cooldown (default 20h), **persisted** (survives restarts).
- **Meter ownership**: a meter number is bound to the first wallet that earns
  with it, so the same physical meter can't be farmed from multiple accounts.
- **Photo is a real image** (magic-byte sniff, size bounds) and **not reused** —
  the SHA-256 of every paid photo is remembered (persisted), so one photo can
  only ever earn once, across submissions and across wallets.
- **Optional OCR** (`OCR_ENABLED=true` + `tesseract.js`): the claimed reading
  must appear in the photo. Lenient — only a confident mismatch rejects.
- **Concurrency lock** per wallet+utility so two simultaneous requests can't both
  pass the cooldown and double-pay.
- Coarse per-IP rate limit.

Durable state (cooldowns, used hashes, meter ownership) is stored in a JSON file
(`STATE_FILE`, default `./state.json`).

## Production hardening (TODO before mainnet)

- **Wallet ownership proof**: the API currently trusts the `address` in the body,
  so it issues to whatever address is sent. Before mainnet, require the client to
  sign a nonce/certificate and verify it recovers `address` here (dapp-kit's
  `requestCertificate` on the client + `Certificate.verify` on the server). This
  stops rewards being issued to arbitrary addresses.
- **Photo verification**: server-side image sanity + SHA-256 dedupe + optional
  OCR run here. Still client-side: screenshot/EXIF detection — port those over too
  for the strongest guarantees.
- **Storage at scale**: the JSON-file store is single-instance. For multiple
  instances / high volume, swap `store.js` for Redis/Postgres (same interface).
- **Key management**: keep `DISTRIBUTOR_PRIVATE_KEY` in a secrets manager / KMS,
  not a plaintext `.env`, in production. Use a dedicated hot wallet.
- **Auth & abuse**: add a real rate limiter, request signing, and monitoring.
- **HTTPS + locked-down CORS** (`ALLOWED_ORIGIN` = your exact frontend origin).
