# 🌱 Green Utility Log

A VeChain **VeBetterDAO** dApp that rewards people with **B3TR** for logging their
utility meter readings. Snap a photo of your electricity, gas, water or solar
meter, the app reads the number, verifies it, and pays out B3TR on-chain.

**Live app:** https://greenutilitylog.github.io/GreenUtilityLog/
**Network:** VeChain Testnet (switch in `src/App.jsx`)

---

## ✨ Features

- 📸 **Photo-verified submissions** — on-device OCR reads the meter, plus
  screenshot/reuse/anomaly checks against farming.
- 🪙 **On-chain B3TR rewards** via the VeBetterDAO `X2EarnRewardsPool`.
- 🏆 **Live leaderboard** read straight from chain.
- 📊 Usage charts, streaks, monthly PDF export.
- 🌙 Light/dark theme, offline support with sync on reconnect.
- ❓ In-app **Help & FAQ** and a **Send Feedback** button for testers.

---

## 🗂️ Project layout

| Path          | What it is                                                            |
|---------------|----------------------------------------------------------------------|
| `src/`        | React + Vite frontend (the whole app lives in `src/App.jsx`).        |
| `server/`     | Optional reward-distributor backend (issues B3TR for testers).       |
| `docs/`       | Testing guide & backend deploy guide.                                |
| `.github/`    | GitHub Actions — auto-deploys `main` to GitHub Pages.                |

---

## 🚀 Run locally

```bash
npm install
npm run dev      # Vite dev server
npm run build    # production build into dist/
```

Deploys automatically to GitHub Pages on every push to `main`.

---

## ⚙️ Configuration (top of `src/App.jsx`)

| Constant            | Purpose                                                          |
|---------------------|------------------------------------------------------------------|
| `NETWORK`           | `"testnet"` or `"mainnet"` — flips node + contracts.            |
| `VEBETTER_APP_ID`   | Your VeBetterDAO app id (bytes32).                              |
| `ADMIN_WALLETS`     | Wallets that unlock the read-only admin monitor.               |
| `REWARD_API`        | Backend URL for real payouts (empty = direct on-chain).        |
| `FEEDBACK_EMAIL`    | Where the in-app feedback button sends messages.               |

---

## 🧪 Inviting testers

1. **Share the testing guide:** [`docs/TESTING.md`](docs/TESTING.md) — how testers
   connect a wallet, get free testnet VTHO, register meters and earn B3TR.
2. **Give testers real B3TR:** testers don't hold the distributor role, so deploy
   the backend and set `REWARD_API`. Full walkthrough:
   [`docs/DEPLOY_BACKEND.md`](docs/DEPLOY_BACKEND.md).

---

## 🔌 Backend (reward distributor)

Only an address with the VeBetterDAO **reward-distributor role** can pay out, so a
trusted server verifies each submission and issues the B3TR. See
[`server/README.md`](server/README.md) for details and
[`docs/DEPLOY_BACKEND.md`](docs/DEPLOY_BACKEND.md) for a one-click Render deploy.

---

## 📄 License

See [`LICENSE`](LICENSE).
