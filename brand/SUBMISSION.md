# Green Utility Log — VeBetterDAO inschrijving (creator NFT + X-App)

Alles wat je nodig hebt voor het formulier op
`https://staging.testnet.governance.vebetterdao.org/apps`.
Kopieer-plak de teksten, upload de bijgeleverde afbeeldingen.

---

## ⚠️ Lees dit eerst — testnet vs mainnet
Je registreert op **staging.testnet** (testomgeving). De app in de code wijst
nu naar **mainnet**-contracten en de mainnet-node. Voor een werkende
end-to-end test moet je app naar **testnet** wijzen:
- node → `https://testnet.vechain.org`
- VeBetterDAO testnet-contracten (B3TR, X2EarnRewardsPool, X2EarnApps)
- de **testnet App ID** die je na registratie krijgt

➡️ Zeg het maar, dan zet ik de app in één keer om naar testnet (node +
contracten + App ID) zodat je echt kunt testen, en later weer terug naar
mainnet voor de lancering.

---

## 1. Creator NFT — hoe het werkt
Om een X-App te mogen aanmelden heb je een **Creator NFT** nodig:
1. Verbind op de governance-site de **wallet die je app gaat beheren**
   (dit wordt het *admin*-adres — kies bewust, het bepaalt wie de app beheert).
2. Vraag/claim op testnet de **Creator NFT** (op de staging-omgeving is die
   meestal gratis aan te vragen / te minten).
3. Met de Creator NFT kun je **“Add app / Submit app”** openen en het formulier
   invullen (hieronder).
4. Na inzending krijgt je app een **App ID** (een bytes32-hash). Die zet je in
   de app (zie §6).
5. Om écht stemmen/rewards te ontvangen moet je app daarna **endorsed** worden
   door een node-houder — voor registratie en testen is dat nog niet nodig.

---

## 2. Tekstvelden (kopiëren-plakken)

**App name**
```
Green Utility Log
```

**Tagline / korte slogan**
```
Log your meters, earn B3TR for saving energy.
```

**Short description**
```
Green Utility Log turns everyday energy habits into on-chain rewards. Snap your
electric, gas, water and solar meter readings, verify them, and earn B3TR on
VeChain for tracking — and reducing — your consumption.
```

**Full description**
```
Green Utility Log is a sustainability app that rewards people for monitoring and
lowering their household utility usage. Users photograph their electric, gas,
water and solar meters; each reading is verified and logged on VeChain, building
a transparent history of consumption over time.

Every verified submission earns B3TR through VeBetterDAO's X2Earn program,
turning small, repeatable green actions — checking your meters, spotting waste,
cutting usage — into real rewards. Features include AI-assisted meter
verification, daily streaks, a global leaderboard, charts of your consumption
trends, offline logging with later sync, and an exportable monthly PDF report.

By making utility tracking effortless and rewarding, Green Utility Log nudges
households toward measurable energy and water savings.
```

**Sustainability impact** (vaak gevraagd)
```
Encourages households to reduce electricity, gas and water consumption through
habit tracking, streaks and rewards, and supports solar adoption. Produces
verifiable, time-stamped consumption data on-chain, making personal energy
savings measurable and rewardable.
```

**Categories / tags** (kies wat het formulier aanbiedt)
```
Sustainability · Energy · Lifestyle
```

---

## 3. URL's

**Website (external_url)**
```
https://greenutilitylog.github.io/GreenUtilityLog/
```

**GitHub**
```
https://github.com/GreenUtilityLog/GreenUtilityLog
```

**Socials** — vul je eigen accounts in (laat leeg wat je niet hebt):
```
X / Twitter : https://x.com/<jouw_handle>
Discord     : https://discord.gg/<jouw_invite>
Telegram    : https://t.me/<jouw_kanaal>
```

---

## 4. Wallet-adressen
- **Admin / owner address**: de wallet die je nu verbindt op de governance-site
  (degene met de Creator NFT). Dit adres beheert de app — kies de juiste.
- **Reward distributor address**: het adres dat `distributeReward` mag
  aanroepen om B3TR uit te keren. Voor nu mag dit hetzelfde admin-adres zijn;
  je kunt er later meer toevoegen.

---

## 5. Afbeeldingen (bijgeleverd)
In dezelfde huisstijl als de app (groen gradient + 🌱-sprout + wordmark):

| Bestand | Formaat | Gebruik |
|---|---|---|
| `logo-512.png`  | 512×512 PNG  | App-logo (standaard, vierkant) |
| `logo-1024.png` | 1024×1024 PNG | Hoge-resolutie logo (indien gevraagd) |
| `banner-1500x500.png` | 1500×500 PNG (3:1) | Header / banner |

PNG, vierkant logo en een brede banner zijn de veilige standaard. Vraagt het
formulier een ander formaat (bv. exact 256×256 of 16:9)? Zeg het, dan render ik
het meteen op maat. Screenshots kan ik ook maken als die gevraagd worden.

---

## 6. Na registratie — App ID in de app zetten
Je krijgt een **App ID** (bytes32-hash). Zet die in `src/App.jsx`:
```js
const VEBETTER_APP_ID = "0x....";   // ← jouw App ID hier
```
Stuur 'm me, dan zet ik 'm erin en lever ik het bestand (of vervang zelf die
ene regel). Zonder geldige App ID kan de app geen B3TR uitkeren.

---

## Samengevat — checklist
- [ ] Verbind de **beheer-wallet** op de governance-site
- [ ] Claim de **Creator NFT** (testnet)
- [ ] Vul de tekstvelden uit §2 in
- [ ] Upload `logo-512.png` + `banner-1500x500.png`
- [ ] Vul URL's (§3) en adressen (§4) in
- [ ] Verstuur → noteer je **App ID**
- [ ] Stuur me de App ID (+ of ik de app naar testnet moet omzetten)
