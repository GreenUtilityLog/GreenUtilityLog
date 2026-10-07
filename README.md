# 🌱 Green Utility Log

A VeChain **VeBetterDAO** x2earn app that pays **B3TR** for keeping your
electricity use down. Photograph your meter — or let a P1 reader (HomeWizard,
Home Assistant) send the reading by itself — and the server checks it and pays
out on-chain.

**Live app:** https://greenutilitylog.github.io/GreenUtilityLog/
**Setup guide (readers, Home Assistant):** https://greenutilitylog.github.io/GreenUtilityLog/guide.html
**Network:** VeChain testnet — B3TR here are test tokens.

---

## How rewards work

- Only wallets with an **access pass** (from an admin) or a **VeBetterDAO passport**
  that counts them as a person are paid; one meter belongs to one wallet, and
  the same meter photographed for another wallet is refused.
- One reading per meter per ~day (20 h cooldown), **at most 4 B3TR** per reading.
- A reader's reading (P1 / Home Assistant) is paid the moment it arrives — nothing
  to tap in the app.
- You earn for using *less* than a daily benchmark (8 kWh); the base is 0.2 B3TR.
  Almost no usage (under 0.1 kWh a day) pays the base only and is flagged: that is
  a stale or repeated reading, not a saving.
- A meter's **first** reading only sets the starting point (base amount); savings
  are paid from the next one, measured from a number the server recorded.
- The server recomputes every amount. Photos must be real, fresh and unused;
  with an OCR provider configured the typed reading must be on the photo.
- Eco-mode bonus: a photo of an appliance on its eco program, 2 B3TR, up to 4 a week.
- All amounts follow the weekly VeBetterDAO allocation: when more is claimed than
  the week's B3TR covers, every payout is scaled down by the same percentage
  (shown in the app). The server claims each round's allocation by itself.

---

## 🗂️ Project layout

| Path                 | What it is                                                         |
|----------------------|--------------------------------------------------------------------|
| `src/`               | React + Vite frontend (mostly `src/App.jsx`).                      |
| `server/`            | Reward backend: verifies submissions and pays B3TR. Tests in `server/test/`. |
| `bridge/`            | `gul.js`, the one-file helper that sends a HomeWizard P1 reading. Tests in `bridge/test.js`. |
| `custom_components/` | Home Assistant integration (install through HACS).                 |
| `ha-addon/`          | Home Assistant add-on that runs the bridge.                        |
| `docs/`              | The setup guide (`build_guide.py` generates `guide.html` and `gul.js`), deploy and testing notes. |
| `brand/`             | Logos, banners, the VeWorld AppHub entry (`brand/app-hub/`).      |
| `.github/workflows/` | CI (server + bridge tests on every push) and the GitHub Pages deploy. |

---

## 🚀 Run locally

```bash
npm install
npm run dev              # the app
npm run build            # production build into dist/

cd server && npm install && npm test     # backend tests
node --test bridge/test.js               # bridge tests
```

`main` deploys itself: the app to GitHub Pages, the backend to Render.

---

## ⚙️ Configuration

- **App** — the network and backend are build settings (`VITE_NETWORK`,
  `VITE_REWARD_API`), set per build in `.github/workflows/deploy.yml` and read in
  `src/network.js`. Constants at the top of `src/App.jsx`: `VEBETTER_APP_ID`,
  `ADMIN_WALLETS`, `FEEDBACK_EMAIL`, `TURNSTILE_SITE_KEY`. Reward rules (cooldown,
  caps, eco bonus) come from the backend's `/health`, so they are set in one place.
- **Backend** — environment variables, every one listed with its default in
  [`server/env.example`](server/env.example). Details in [`server/README.md`](server/README.md),
  deploying in [`docs/DEPLOY_BACKEND.md`](docs/DEPLOY_BACKEND.md).

---

## 📄 License

See [`LICENSE`](LICENSE).
