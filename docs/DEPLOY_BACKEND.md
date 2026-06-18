# 🛠️ Backend uitrollen — zodat testers écht testnet-B3TR krijgen

Je testers hebben zelf **niet** de VeBetterDAO `reward-distributor`-rol. Daarom
kan hun eigen wallet geen B3TR uitkeren — dat moet een **vertrouwde server** doen
met een hot-wallet die die rol wél heeft. Deze gids zet die server live.

> Korte versie: rol de `server/` uit op een host (bv. Render), zet in de app
> `REWARD_API` op de URL van die server, en testers krijgen automatisch B3TR
> zonder zelf iets te ondertekenen.

---

## 1. Vereisten op VeBetterDAO (eenmalig)

In het VeBetterDAO governance-dashboard (testnet:
https://dashboard.testnet.governance.vebetterdao.org/) :

1. Je app is geregistreerd op **testnet** (App ID staat al in de code).
2. Maak/kies een **hot-wallet** (een aparte wallet, géén persoonlijke) en geef die
   de **reward-distributor-rol** voor je app.
3. **Vul de reward-pool** van je app met (testnet-)B3TR.
4. Geef de hot-wallet een beetje **VTHO** voor gas (faucet: https://faucet.vecha.in).

> ⚠️ De **private key** van die hot-wallet komt op de server. Gebruik een
> wegwerp-/hot-wallet met alleen testnet-tegoed — nooit je persoonlijke wallet.

---

## 2. De server uitrollen (Render, gratis)

De makkelijkste route — er staat al een blueprint klaar (`server/render.yaml`):

1. Maak een account op https://render.com en koppel je GitHub.
2. **New → Blueprint**, kies deze repo. Render leest `server/render.yaml`.
3. Render vraagt om de secret **`DISTRIBUTOR_PRIVATE_KEY`** → plak de private key
   van je hot-wallet (stap 1.2).
4. Klik **Apply**. Na de build krijg je een URL zoals
   `https://greenutilitylog-rewards.onrender.com`.
5. Test 'm: open `<die-url>/health` in je browser. Je ziet de netwerk- en
   distributor-info → de server draait. ✅

> 💤 De gratis Render-instantie valt in slaap bij inactiviteit; het eerste
> verzoek daarna duurt ~30s. Voor een testronde prima. De staat (cooldowns,
> foto-hashes, meter-eigenaarschap) staat in `./state.json` en kan resetten bij
> een redeploy/slaap — voeg een Render **Persistent Disk** toe als je dat over
> langere tijd wilt bewaren.

**Andere hosts:** er is ook een `server/Dockerfile` (werkt op Railway, Fly.io,
Koyeb, een VPS, enz.). Zet dezelfde env-vars als in `render.yaml`.

---

## 2b. (Aanrader) Betrouwbare meterstand-herkenning via Google Vision

De in-browser OCR is wisselvallig op echte meters. Met **Google Cloud Vision**
wordt de herkenning veel beter — en de eerste **1000 foto's per maand zijn gratis**.

1. Ga naar https://console.cloud.google.com/ → maak een project (of kies er een).
2. Schakel de **Cloud Vision API** in (zoek op "Vision API" → Enable).
3. **APIs & Services → Credentials → Create credentials → API key**. Kopieer de key.
   (Tip: beperk de key tot de Vision API onder "Restrict key".)
4. Zet in Render (of je host) de env-var **`GOOGLE_VISION_API_KEY`** = die key.
5. Controleer op `<server-url>/health` dat `"vision": true` staat.

In de app zet je dan `OCR_API` (zie stap 3) op dezelfde server-URL. De app stuurt
de **bijgesneden cijfers** én de **volledige foto** (voor het meternummer) naar
`/ocr`; mislukt dat, dan valt hij automatisch terug op de browser-OCR.

> 💶 Kosten: gratis tot 1000 foto's/maand, daarna ±€1,30 per 1000. De app doet ~2
> Vision-aanroepen per inzending (stand + meternummer), dus ~500 gratis
> inzendingen per maand.

## 3. De app naar de server laten wijzen

In `src/App.jsx` staat bovenin:

```js
const REWARD_API = "";
```

Zet daar je server-URL neer (zónder slash op het eind):

```js
const REWARD_API = "https://greenutilitylog-rewards.onrender.com";
```

Gebruik je Google Vision (stap 2b)? Zet dan óók `OCR_API` op diezelfde URL:

```js
const OCR_API = "https://greenutilitylog-rewards.onrender.com";
```

Upload de gewijzigde `src/App.jsx` naar `main` (zoals altijd). GitHub Pages
herbouwt automatisch. Vanaf nu sturen inzendingen naar je server, en keert de
server de B3TR uit — testers ondertekenen niets. De meterstand-herkenning loopt
dan via Google Vision.

> Zolang `REWARD_API` leeg is, gebruikt de app de directe on-chain-modus en moet
> de wallet zélf de distributor-rol hebben (alleen praktisch voor jou als admin).

---

## 4. Snel controleren dat het werkt

1. `<server-url>/health` → toont `distributor`-adres en netwerk.
2. Stuur in de app een meterstand in met een testwallet.
3. Je ziet een toast met `+X B3TR` en een TX-hash; controleer 'm op
   https://explore-testnet.vechain.org/.

---

## 5. Goed om te weten (beveiliging)

De server doet al stevige anti-fraude (cooldown, foto-hash dedupe,
meter-eigenaarschap, plausibiliteitsgrenzen). Vóór een **mainnet**-lancering staan
de extra hardening-stappen (o.a. wallet-eigendomsbewijs via certificaat, secrets
manager, strakke CORS) in [`server/README.md`](../server/README.md#production-hardening-todo-before-mainnet).
Voor een **testnet**-testronde is de huidige opzet voldoende.

---

Vragen of vastgelopen? Noteer waar je strandt (welke stap, welke foutmelding) —
dan helpen we verder.
