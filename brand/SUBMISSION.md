# Green Utility Log — VeBetterDAO inschrijving (creator NFT + X-App)

Alles wat je nodig hebt voor het formulier op
`https://staging.testnet.governance.vebetterdao.org/apps`.
Kopieer-plak de teksten, upload de bijgeleverde afbeeldingen.

---

## ⚠️ Lees dit eerst — testnet vs mainnet
Je registreert op **staging.testnet** (testomgeving). De app wijst **al naar
testnet** (`NETWORK = "testnet"` in `src/App.jsx`): testnet-node, VeBetterDAO
testnet-contracten en de testnet App ID. Je kunt dus direct end-to-end testen.

➡️ Voor de lancering zet je de app om naar **mainnet**: `NETWORK = "mainnet"`,
een **mainnet App ID** na mainnet-registratie, en de overige productie-instellingen
uit `STATUS.md` (cooldown, CORS, captcha, enz.).

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
Use less electricity, earn B3TR.
```

**Short description**
```
Green Utility Log rewards households for using less electricity. Snap your meter
or connect a smart reader; every kWh you stay below the daily target of 8 kWh
earns B3TR on VeChain.
```

**Full description**
```
Green Utility Log rewards people for actually saving electricity, not for
logging it. Users photograph their electricity meter, or send the reading
automatically from a P1 reader, Home Assistant, Powerfox or Tibber. The server
checks each reading (photo checks, meter ownership, plausible usage) and pays
B3TR for every kWh used below a target of 8 kWh a day. A reading without savings
is recorded but not rewarded.

Rewards come from the app's weekly VeBetterDAO allocation and are spread over
the week, so the pot never runs dry. On mainnet the app is open to VeBetterDAO
members with a Galaxy Member NFT and a Passport.

Features: automatic meter readers, savings charts and a calendar, levels by days
with a reading, a yearly outlook, a leaderboard, offline logging with later
sync, a PDF report, and the app in 20 languages.
```

**Sustainability impact** (vaak gevraagd)
```
Pays only for measured savings: kWh below a fixed daily target, read from the
household's own electricity meter. Each payout records the reading, the period
and the kWh saved on VeChain, so the saving is verifiable and adds up across
users.
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
