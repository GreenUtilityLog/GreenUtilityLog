# Green Utility Log — Overzicht

Eén GitHub-repo bevat **alles**: de app (`src/`) én de reward-server (`server/`).
Beide deployen automatisch vanaf branch **`main`**.

## 🌐 Frontend (de app)
- **Live:** https://greenutilitylog.github.io/GreenUtilityLog/
- **Host:** GitHub Pages — auto-deploy via `.github/workflows/deploy.yml` bij elke commit op `main`
- **Belangrijkste code:**
  - `src/App.jsx` — de hele app (UI, reward-flow, thema's, `REWARD_API`)
  - `src/main.jsx` — wallet-verbinding (VeChain dapp-kit, netwerk)

## ⚙️ Backend (reward-server)
- **Live:** https://greenutilitylog-rewards.onrender.com
- **Health-check:** https://greenutilitylog-rewards.onrender.com/health
- **Host:** Render — service `greenutilitylog-rewards`
- **Belangrijkste code (map `server/`):**
  - `reward.js` — tekent de B3TR-uitbetaling (mnemonic → distributor `0x1390`, + optionele fee delegation)
  - `index.js` — de API: `/reward`, `/health`, `/ocr`
  - `render.yaml` — de Render Blueprint (welke env-vars)

## 🔐 Geheimen & instellingen (Render → Environment)
| Variabele | Waarde |
|-----------|--------|
| `DISTRIBUTOR_MNEMONIC` | 12 woorden van wallet 3 |
| `DISTRIBUTOR_ADDRESS` | `0x1390b2cac3b73419bbac32342e9b9ff22df0d7c2` |
| `NETWORK` | `testnet` |
| `ALLOWED_ORIGIN` | CORS-origin van de app |
| `DELEGATION_URL` | *(optioneel)* fee-delegation sponsor-URL |

## 🦊 Wallet & rol
- **VeWorld** → wallet 3 → account `0x1390…d7c2` = de **distributor**
- **VeBetterDAO-beheer:** https://staging.testnet.governance.vebetterdao.org
  - Daar staat `0x1390` als **Beloningsverdeler** + de beloningspot (B3TR)

## 🔁 Hoe een beloning loopt
1. Gebruiker stuurt meterstand + foto in de app
2. App → `POST /reward` naar de backend (met een gratis ondertekend certificaat)
3. Backend controleert (cooldown, foto-hash, eigenaarschap) en tekent `distributeReward` met `0x1390`
4. B3TR komt op de blockchain bij de gebruiker

## ✅ Snelle checks
- Backend leeft + juiste distributor? → open de health-check, kijk naar `distributor` (= `0x1390…`)
- App werkt? → open de live-app, verbind VeWorld (op **Testnet**)
