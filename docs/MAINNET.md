# 🚀 Naar mainnet — stap voor stap

Twee versies van dezelfde app:

| | Mainnet (echt) | Testnet (om te testen) |
|---|---|---|
| App | `https://greenutilitylog.github.io/GreenUtilityLog/` | `https://greenutilitylog.github.io/GreenUtilityLog/testnet/` |
| Server | de **huidige** `greenutilitylog-rewards` (wordt bij de livegang mainnet) | een **nieuwe** Render-service |
| Database | **eigen** Upstash-database, `STATE_KEY=greenutilitylog:mainnet` | de huidige (zoals nu) |
| Wallets | zelfde als testnet (zie stap 2) | zoals nu |

Tot de livegang draaien **beide** versies op testnet: er verandert niets voor testers.

**Waarom de huidige server mainnet wordt:** elke geïnstalleerde uitlezer (gul.js, de
Home Assistant-add-on en -integratie, de YAML uit de handleiding) stuurt naar
`greenutilitylog-rewards.onrender.com`. Wordt díe server mainnet, dan blijven al die
uitlezers werken zonder dat iemand iets aanpast. Bij de eerste mainnet-start neemt de
server de testgegevens over (`server/carryover.js`): meternummers, beginstanden en
laatste standen, uitlezer-tokens, Powerfox/Tibber/MojElektro-koppelingen, de fotoklok,
blokkades en de vingerafdrukken van al gebruikte foto's. **Niet** mee: uitbetalingen,
wachttijden, geschiedenis, rollen, meldingen en instellingen. De app op de telefoon neemt
bij de eerste mainnet-start zelf meternummer, beginstand, uitlezer-token, telefoon-ID,
taal en thema over (`src/network.js`). Testers hoeven alleen VeWorld op **Mainnet** te
zetten en aan de toegangsregel te voldoen (GM NFT + Passport, zie stap 5).

---

## Gekozen route (28 november 2026): geen testnet meer
De eigenaar gebruikt testnet niet meer. Daarom **geen nieuwe testnet-service (stap 5a vervalt)**
en **geen testversie** van de app: `/GreenUtilityLog/testnet/` stuurt door naar de app. De huidige
server wordt mainnet; alle uitlezers blijven daarheen sturen. Upstash: **dezelfde database**
(gratis plan = één database), gescheiden door `STATE_KEY`; elke sleutel die de server schrijft
begint daarmee (het foto-archief gebruikt de transactie-ID, per netwerk uniek).

**Volgorde:** (1) Claude zet de livegang-PR klaar en wacht tot CI groen is → (2) de eigenaar doet
5b in Render → (3) Claude merget de PR (de app wordt mainnet) en controleert `/health`.
Tussen (2) en (3) weigert de app standen ("server is mainnet, app is testnet"): een paar minuten.

**5b — Render → `greenutilitylog-rewards`:**
- Settings: **Auto-Deploy: Off** (een wijziging gaat pas live met *Manual Deploy*), **Shutdown Delay 120 s**.
- Environment, toevoegen of wijzigen:

| Sleutel | Waarde |
|---|---|
| `NETWORK` | `mainnet` |
| `STATE_KEY` | `greenutilitylog:mainnet` |
| `CARRY_OVER_KEY` | `greenutilitylog:state` (stond `STATE_KEY` al ingevuld: díe oude waarde) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | **laten staan** (zelfde database); `CARRY_OVER_URL`/`_TOKEN` niet nodig |
| `ANTHROPIC_API_KEY` | de nieuwe sleutel `greenutilitylog-mainnet` |
| `CERT_DOMAINS` | `greenutilitylog.github.io` |
| `ADMIN_WALLETS` | `0x3a007383fce8dcccdb92cf9efe0e609a652a1f29,0xedd7e5e1be4066cdc892a059f586b9d7e8e4b0c7` |
| `ALLOWED_ORIGIN` | `https://greenutilitylog.github.io` |
| `MAX_PAYOUT_PER_SUBMISSION` | `1` (eerste week) |
| `PHOTO_RETENTION_DAYS` | `7` (gedeelde database klein houden) |

- **Laten staan:** `DISTRIBUTOR_PRIVATE_KEY`, `POWERFOX_SECRET`, `KEEP_AWAKE` (mainnet blijft wakker).
- **Weghalen als ze er staan:** `REQUIRE_PASS`, `TESTNET_*`, `PAYOUTS_PAUSED`, en `NODE_URL` /
  `DELEGATION_URL` als ze naar testnet wijzen.

## Stand van zaken (27 november 2026)
- Endorsement gehaald: 110/110, 10 ondersteuners; op VeBetterDAO mainnet "Ondersteund en actief".
- App-naam op mainnet precies `Green Utility Log` → app-ID gelijk aan testnet
  (`0x489c6c122157f3b1072c2565b0eb6cb734564e84d14c80b1a12e6834a075f71e`, de keccak256 van de naam,
  nagerekend). Geen codewijziging nodig.
- `CERT_DOMAINS` = `greenutilitylog.github.io` (gezien op testnet-`/health`, `certDomains.seen`).
- `ADMIN_WALLETS` = `0x3a007383fce8dcccdb92cf9efe0e609a652a1f29,0xedd7e5e1be4066cdc892a059f586b9d7e8e4b0c7`
  (allebei van de eigenaar; `0xedd7…b0c7` is de on-chain app-admin).
- Op mainnet is de **schatkist de admin-wallet** `0xedd7…b0c7` (niet de server-wallet zoals op testnet):
  het teamdeel komt daar binnen, de sleutel staat niet op de server. De server rekent nergens op het
  schatkist-adres. VTHO voor de server-wallet `0x1390…d7c2` stuurt de eigenaar zelf. De distributor
  `0x1390…d7c2` stond al ingesteld.
- De eerste allocatieronde krijgt de app nog niets: de eigenaar stort zelf **2.500 B3TR** in de pot
  (VeBetter mainnet → App-saldo → storten; niet via "Fund rewards pool" in ons adminpaneel zolang de app
  nog testnet is). Eerste week hooguit ±70 B3TR nodig (max 1 per uitbetaling); ongebruikt saldo is weer op
  te nemen naar de team-wallet.
- Nog te doen door de eigenaar: stap 1–3 in VeBetter (distributor, VTHO, pool uit, teamdeel),
  een nieuwe Upstash-database en Anthropic-sleutel, dan stap 5 in Render.
- Klaar voor stap 6: de handleiding zonder "testershandleiding / test-tokens" (20 talen), op de
  werkbranch, gaat mee in de livegang-PR.

## Stap 1 — X2Earn Creator NFT (jij)
Registreren op mainnet kan alleen vanuit een wallet met een **X2Earn Creator NFT**
(het contract weigert anders: `X2EarnUnverifiedCreator`). Aanvragen bij VeBetterDAO.
Check eerst in VeWorld (op **Mainnet**) of de wallet waarmee je registreert hem al heeft.

## Stap 2 — App registreren op VeBetterDAO mainnet (jij)
Dezelfde wallets als op testnet (keuze eigenaar, november 2026):

| Rol | Adres |
|---|---|
| Beheer (admin) | `0xedd7e5e1be4066cdc892a059f586b9d7e8e4b0c7` |
| Schatkist (treasury / team wallet) | `0x1390b2cac3b73419bbac32342e9b9ff22df0d7c2` |
| Reward distributor | `0x1390b2cac3b73419bbac32342e9b9ff22df0d7c2` — de server-wallet; de sleutel staat alleen in Render |

**Teamdeel (team allocation percentage): 10–15%** (keuze eigenaar, 19-11-2026), in te stellen
met de beheerwallet bij de app-instellingen op VeBetterDAO. Standaard staat het op 0%: dan gaat
alles naar de beloningspot. Het teamdeel gaat naar de schatkist en dekt de kosten, vooral de
VTHO (gas) voor elke uitbetaling. Bij het ophalen van een ronde (de server doet dat zelf,
`budget.js`) stuurt het contract het teamdeel rechtstreeks naar de schatkist; de server rekent
alleen met wat in de beloningspot komt.

Zoals op testnet: schatkist en distributor zijn één wallet (keuze eigenaar). Daardoor staat
de sleutel van de schatkist op de server; lekt hij, trek dan met de beheerwallet de
distributor-rol in en verander het schatkistadres (zie **Noodstop**).

Naam precies **`Green Utility Log`** → dan is de app-ID gelijk aan testnet
(`0x489c6c12…f71e`) en hoeft er in de code niets te veranderen. Andere naam (of is
deze al bezet)? Geef mij de nieuwe app-ID: dan krijgt de app een eigen ID per
netwerk — dat is een codewijziging, niet alleen een instelling in Render.

## Stap 3 — Distributor-wallet (jij)
- De distributor is de server-wallet `0x1390…d7c2`, dezelfde als op testnet (keuze
  eigenaar). De sleutel staat al in Render bij de huidige service en blijft daar; nooit je
  admin-wallet gebruiken. Wie de sleutel heeft, kan de hele pot uitbetalen. Lekt hij ooit:
  trek met je admin-wallet de distributor-rol in (zie **Noodstop** onderaan).
- Zet wat **VTHO op mainnet** op de distributor-wallet (betaalt het gas van elke uitbetaling).
- Voeg hem in VeBetterDAO mainnet toe als **Reward distributor** van de app.
- Zet in de VeBetterDAO-app-admin de **rewards-pool-functie uit** (met je admin-wallet).
  Waarom: bij elke nieuwe app staat die aan. Uitbetalingen komen dan alleen uit een apart
  potje, terwijl de wekelijkse B3TR ernaast binnenkomt. Dan lijkt de pot leeg en wordt
  niemand betaald. Uitzetten zet alles in één pot; daarna gaat het vanzelf.
  Laat je hem aan, druk dan na elke ronde op **Move to rewards pool**.
  `/health` → `rewardBudget.waitingB3TR` laat zien hoeveel B3TR nog naast het potje wacht.

## Stap 4 — Code voor twee versies (klaar)
Staat al klaar: de app bouwt een mainnet- en een testnetversie, elk met eigen
gegevens in de browser; de testnetversie toont een oranje strook “TESTNET”.

## Stap 5 — De serverwissel in Render (jij, ± 15 minuten)
Doe 5a en 5b vlak na elkaar, en stuur mij dan het adres van de nieuwe testnet-service:
ik zet direct daarna stap 6 live. Tussen 5b en stap 6 zegt de app een paar minuten
"server is mainnet, app is testnet" en weigert hij standen; dat is alles.

### 5a — Een nieuwe service voor testnet
Render → **New → Web Service** → deze repository, naam bijv. `greenutilitylog-testnet`.
**Niet via New → Blueprint** (`server/render.yaml` beschrijft de huidige service).
- **Root Directory:** `server` · **Build:** `npm install` · **Start:** `npm start`
- **Health Check Path:** `/livez` · **Shutdown Delay:** 120 seconden · **Auto-Deploy: On**
- **Environment:** neem de variabelen van de huidige service over (Render →
  `greenutilitylog-rewards` → Environment; overtypen of kopiëren), **zelfde waarden**:
  `NETWORK=testnet`, dezelfde Upstash-URL en -token (de testgegevens blijven dus
  gewoon staan), dezelfde distributor-sleutel, je testnet-Anthropic-sleutel, enzovoort.
  **Twee uitzonderingen:** `KEEP_AWAKE=off` erbij (anders zijn er twee servers altijd
  wakker en is het gratis plan op, zie "De wekker"), en `POWERFOX_SECRET` krijgt een **nieuwe** waarde. Dan haalt testnet
  geen standen meer op bij de Powerfox- en Tibber-accounts die naar mainnet zijn
  overgegaan (anders vragen twee servers hetzelfde account uit).
- Open `<nieuw adres>/health`: `network` = `testnet`, `storeReady` = `true`, en
  `passCount` zoals op de huidige server.

### 5b — De huidige service wordt mainnet
Render → `greenutilitylog-rewards`:
- **Settings → Auto-Deploy: Off.** Elke wijziging in `main` gaat anders meteen naar echt geld.
  Zo gaat een wijziging eerst live op testnet (dat deployt vanzelf); werkt het daar,
  dan klik je bij mainnet op **Manual Deploy → Deploy latest commit**.
- **Shutdown Delay** (onder Settings): **120 seconden**. De server maakt een
  uitbetaling die al verstuurd is eerst af en legt hem vast (tot 100 s). Met Render's
  standaard van 30 s wordt hij bij elke deploy afgekapt: de B3TR is weg, het record niet.
- **Plan:** met echt geld raad ik een betaald plan aan (slaapt niet); gratis kan ook.
  **Let op bij gratis:** Render geeft **750 instance-uren per maand per workspace**, voor
  alle gratis services samen. Twee gratis services die allebei de hele dag wakker zijn
  (de wekker in `wake.yml` houdt ze wakker) zitten daar ruim boven, en dan zet Render
  **alle** gratis services in die workspace stil tot de nieuwe maand — testnet én
  mainnet. Mainnet op gratis? Zet testnet dan in een **andere workspace**, of zet
  mainnet op **Starter** zodra het gebruik groeit.
- **Staat er bij de service "Blueprint"** (aangemaakt via New → Blueprint)? Zeg het mij:
  dan zet ik in stap 6 ook `server/render.yaml` op mainnet, anders zet een
  blueprint-synchronisatie `NETWORK` terug op testnet.
- **Environment** (wijzigen, toevoegen of weghalen, dan **Save**; de server start opnieuw):

| Sleutel | Waarde |
|---|---|
| `CARRY_OVER_KEY` | `greenutilitylog:state` — de `STATE_KEY` van testnet (stond `STATE_KEY` al ingevuld, neem dan die waarde). Zet het overnemen van de testgegevens aan; het gebeurt één keer |
| `CARRY_OVER_URL` / `CARRY_OVER_TOKEN` | de **huidige** (testnet) `UPSTASH_REDIS_REST_URL` en `UPSTASH_REDIS_REST_TOKEN`: kopieer ze hierheen vóór je die twee hieronder vervangt |
- **Environment:**

| Sleutel | Waarde |
|---|---|
| `NETWORK` | `mainnet` |
| `DISTRIBUTOR_PRIVATE_KEY` | laten staan (dezelfde distributor-wallet als testnet) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **vervangen** door die van een **nieuwe, eigen** Upstash-database voor mainnet (zie hieronder). **Verplicht, allebei:** zonder start mainnet niet |
| `STATE_KEY` | `greenutilitylog:mainnet` — **verplicht**: houdt test- en echte gegevens gescheiden; zonder "mainnet" in de sleutel weigert de mainnet-server te starten |
| `ALLOWED_ORIGIN` | `https://greenutilitylog.github.io` |
| `ANTHROPIC_API_KEY` | **verplicht**: controleert of de foto echt is en of stand + meternummer erop staan — zonder start mainnet niet (anders is de stand gewoon wat iemand intypt). Een **nieuwe** sleutel `greenutilitylog-mainnet` op platform.claude.com. Standaard met het goedkope model `claude-haiku-5-5`: per foto ± 3 aanroepen (vooraf invullen + echtheid + stand), samen een fractie van een cent; hooguit 5 pogingen per wallet per dag en 300 keer vooraf invullen per dag (`OCR_DAILY_MAX`, 15 per IP). Zet bij **Limits** een maandlimiet en een **e-mailwaarschuwing** bij bijna op: is het tegoed op, dan weigert de server elke foto-uitbetaling tot je bijkoopt |
| `MAX_PAYOUT_PER_SUBMISSION` | `1` voor de eerste week (veilige start), daarna weghalen (= 4) |
| `REQUIRE_PASS` | niet invullen. Op mainnet bepaalt de toegangsstand wie erin mag (standaard **GM NFT + Passport**, zie hieronder) |
| `PASSPORT_GRANTS_ACCESS` | niet invullen: staat op mainnet standaard uit (een passport kan van wallet naar wallet worden doorgegeven) |
| `ADMIN_WALLETS` | alleen **jouw** wallet-adres (meerdere: met komma's) |
| `DISTRIBUTOR_ADDRESS` | alleen bij `DISTRIBUTOR_MNEMONIC`: welk adres uit die woorden de distributor is |
| `CERT_DOMAINS` | **verplicht** (zonder start mainnet niet): de site-naam waarmee handtekeningen binnenkomen — waarschijnlijk `greenutilitylog.github.io`. **Controleer hem vooraf op testnet**: open `https://greenutilitylog-rewards.onrender.com/health` en kijk onder `certDomains.seen` (beide app-versies staan op dezelfde site, dus het is dezelfde naam). Een verkeerde waarde sluit iedereen buiten, jou als admin ook |
| `PAYOUTS_PAUSED` | **niet** invullen. Dit is de noodstop (zie onderaan): `true` stopt alle uitbetalingen |
| `WALLET_CHECK` | niet invullen (= `base`): wallets die uit dezelfde bron gevuld zijn of door VeBetterDAO gesignaleerd, krijgen alleen het basisbedrag en komen bij de meldingen. `flag` = alleen melden |
| `POWERFOX_SECRET` | **laten staan, niet veranderen**: de overgenomen Powerfox-, Tibber- en MojElektro-koppelingen zijn ermee versleuteld. Een andere waarde = die koppelingen werken niet meer |
| `REQUIRE_PASS`, `TESTNET_*` en andere testinstellingen | weghalen als ze er staan |
| `NODE_URL`, `DELEGATION_URL` | weghalen als ze naar een **testnet**-node of -sponsor wijzen (anders standaard mainnet). Een testnet-`NODE_URL` laat de mainnet-server weigeren te starten (verkeerde chain) |

**Bewust geaccepteerd risico — automatische standen:** een automatische meter (gul.js,
Home Assistant, Powerfox, Tibber) kan een tijd te weinig verbruik doorgeven en dat later in
een paar grote stappen inhalen. Dan krijgt hij in die tijd de hoogste bespaarbonus. De
30-dagenfoto vangt dat niet, want een foto mag hoger zijn dan wat is uitbetaald. Gekozen is
dit zo te laten: alleen wallets met een GM NFT én een Passport dat ze als persoon telt kunnen
meedoen. Let in het admin-paneel op meters met dagen op het maximum gevolgd door grote
sprongen; dan de wallet blokkeren.

**Een eigen Upstash-database voor mainnet:** maak in Upstash een **nieuwe** Redis-database
aan (gratis plan kan) en gebruik die URL en token alleen hier. Let op twee grenzen van
het gratis plan: **256 MB opslag** en **± 1 MB per opslagactie**.
- Het foto-archief (een verkleinde foto per uitbetaling, ± 80 KB, 30 dagen bewaard) staat
  vanzelf aan en vult die 256 MB bij ± 80 uitbetaalde foto's per dag. Zet bij de start
  `PHOTO_RETENTION_DAYS=7`, en verhoog het (of neem een betaald plan) als het druk wordt.
- De bewaking waarschuwt als de opgeslagen gegevens richting 1 MB groeien (`stateKB`). Deel je er één met
testnet, dan delen beide versies ook de grenzen van het gratis plan: één budget aan
commando's en één opslag (het foto-archief groeit mee). Raakt testnet (veel testers, veel foto's) zo'n grens, dan kan de server niet
meer opslaan en **stoppen de uitbetalingen op allebei**. Zet **eviction nooit aan** op
deze database: dan gooit Upstash bij een volle database zelf sleutels weg, en daarmee
ook wie al betaald is en welke readings al geclaimd zijn.

**Mainnet alleen voor VeBetterDAO-leden (GM NFT + Passport):** zo start mainnet. Een wallet
komt erin als alles klopt (de regel van VeBetterDAO voor app-beloningen, via morbidejs,
17-11-2026, plus het Passport):
1. een **GM NFT**;
2. de **hoofdwallet** van zijn Passport, geen gekoppelde wallet (één wallet per persoon);
3. **geen signaleringen** in het Passport (`signaledCounter` = 0);
4. **gestemd in de vorige ronde** (`XAllocationVoting.hasVoted`);
5. de GM NFT die **aan het begin van die ronde geselecteerd** was (`getSelectedTokenIdAtBlock`)
   heeft gestemd (`VoterRewards.hasTokenVoted`, met het startblok van die ronde), is nog van
   hem en is minimaal **niveau 2 (Moon)**. Het niveau is dat van nu: het contract bewaart geen
   niveau per moment. Wie tijdens de ronde van GM NFT wisselt en met de andere stemt, telt niet;
6. een **VeBetterDAO Passport** dat hem als persoon telt.
Wie elke ronde stemt, blijft verdienen; wie een ronde overslaat, doet de week erna niet mee.
Een wallet waarvan de Foundation de signaleringen na KYC heeft teruggezet, komt erin maar wordt
gemarkeerd voor de admin (rollenpaneel en markeringen); blokkeren kan met de hand.
De server controleert dat
zelf op de blockchain, bij het openen van de app én bij elke uitbetaling. Wie het niet heeft,
ziet een scherm met wat er ontbreekt, een link naar VeBetterDAO en "Opnieuw controleren".
Een rol telt in deze stand **niet**. Jij komt er als admin altijd in.

**De schakelaar (per versie):** in het adminpaneel staat bovenaan **"Who can use this
version"**: *GM NFT + Passport*, *Only with a role* of *Everyone*. Elke versie (mainnet en
`/testnet/`) heeft zijn eigen schakelaar. Mainnet staat standaard op *GM NFT + Passport*,
testnet op *Only with a role*. Iemand een rol geven (telt alleen bij *Only with a role*):
zoek zijn wallet in het adminpaneel → **Role** → *Tester* of *User* → geven.

Stuur mij daarna het **adres** van de nieuwe testnet-service (5a).
Test mainnet: open `https://greenutilitylog-rewards.onrender.com/health` en controleer:

| Veld | Moet zijn |
|---|---|
| `network` | `mainnet` |
| `appId` | `0x489c6c12…f71e` (of de nieuwe ID uit stap 2) |
| `dryRun` · `payoutsPaused` | `false` · `false` |
| `chainConfirmed` | `true` (de server heeft gezien dat zijn node op mainnet zit; tot dan gaat er niets uit) |
| `storeReady` · `storeSaving` | `true` · `true` |
| `readingCheck` · `aiPhotoCheck` | `strict` · `true` |
| `distributorAuthorized` · `distributionPaused` | `true` · `false` |
| `rewardsPoolEnabled` | `false` (als je die in stap 3 uitzette) |
| `access` | `gm` |
| `adminWallets` | alleen jouw adres |
| `certDomains.enforced` | jouw `CERT_DOMAINS` |
| `rules.maxPayout` | `1` (de veilige eerste week) |
| `carryOver.done` | ingevuld, met o.a. `meters` en `links` (hoeveel er is overgenomen); `carryOver.problem` = `null`. Leeg? Kijk in de Render-log naar `[carry-over]`: hij probeert het elke minuut opnieuw |

## Stap 6 — Live zetten (ik)
In één pull request, zodra ik het adres uit 5a heb:
- `.github/workflows/deploy.yml`: `MAIN_NETWORK: mainnet`, `MAINNET_API` = de huidige
  server, `TESTNET_API` = de nieuwe testnet-server. De mainnet-app neemt bij de eerste
  start de gegevens van de testnet-app op de telefoon over; de testnet-app zet voortaan
  zelf `--ingest=<testnet>` in zijn installatieregel.
- `.github/workflows/wake.yml`: `TESTNET_SERVER` = de nieuwe testnet-server (elk uur wekken).
  Let op: GitHub zet geplande workflows in een publieke repository **uit na 60 dagen
  zonder commits**. Wordt de server ineens niet meer gewekt, kijk dan in het tabblad
  **Actions** bij *Wake the reward server*: daar staat de knop om hem weer aan te zetten.
- `.github/workflows/watchdog.yml`: de testnet-server erbij in `server:`. De huidige staat er
  al in en wordt vanzelf op mainnet bewaakt (lege pot, weinig VTHO, rol kwijt, opslag, en
  of het overnemen gelukt is).
- `server/render.yaml`: alleen als de huidige service een Blueprint is (zie 5b).
- Handleiding: "testnet / testtokens" eruit (ook de voettekst, in alle talen), link naar de
  testversie erin.
- **Niet nodig:** gul.js, de Home Assistant-add-on en -integratie en de YAML in de
  handleiding sturen al naar `greenutilitylog-rewards.onrender.com`, en dat blijft zo.

**Wat testers merken:** niets aan hun uitlezer. Ze zetten VeWorld op **Mainnet**, openen
de app (die opent gewoon op Home, met hun meter en uitlezer) en moeten aan de
toegangsregel voldoen. De eerste mainnet-uitbetaling rekent vanaf hun laatste testnet-stand,
hooguit 7 dagen (`MAX_SPAN_DAYS`) en hooguit `MAX_PAYOUT_PER_SUBMISSION`.

**Wie op testnet blijft testen:** de testnet-app geeft een installatieregel mét
`--ingest=<testnet>`; Home Assistant: bij **ingest_url** (add-on) of onder **Configure**
(integratie) `<testnet-adres>/meter-ingest` invullen. Zonder dat stuurt een uitlezer naar
mainnet. Powerfox/Tibber op testnet opnieuw koppelen (andere `POWERFOX_SECRET`).

## De wekker (klaar, niets te doen)
Op het gratis plan valt een server na 15 minuten zonder verkeer in slaap; dan haalt hij
geen Powerfox/Tibber-standen op en betaalt hij een openstaande stand niet uit. De server
houdt zichzelf daarom wakker: elke 11 minuten roept hij zijn eigen `/cron/tick` aan (via
het adres dat Render zelf meegeeft, `RENDER_EXTERNAL_URL`). Elke wekbeurt haalt de
cloud-standen op en betaalt standen die nog openstaan, na de wachttijd en met alle gewone
controles. `/health` → `keepAwake: true` laat zien dat het aan staat. De GitHub-wekker
(`wake.yml`) blijft als reserve.

**Let op de 750 gratis uren per maand** (per workspace): één server die altijd wakker is
past erin, twee niet. Na de livegang zet je bij de **testnet**-service `KEEP_AWAKE=off`
(stap 5a); die slaapt dan weer als niemand hem gebruikt. Mainnet blijft wakker.

## Stap 7 — De pot (jij)
Pas **na** stap 6: daarvóór is ook de hoofd-app nog testnet, en dan zou "Fund rewards
pool" test-B3TR storten. Vul de pot met echte B3TR (mainnet-app → adminpaneel → Fund
rewards pool), of wacht op de wekelijkse allocatie — die komt pas als de app genoeg
**endorsement** heeft. Doe daarna één test-uitbetaling op je eigen wallet.

## Stap 8 — VeWorld app-hub (ik, jij klikt één keer)
De aanmelding staat klaar in `brand/app-hub/`. Fork van `vechain/app-hub`, dan dien ik hem in.

---

## 🛑 Noodstop — als er op mainnet iets misgaat
Van snel naar grondig:
1. **`PAYOUTS_PAUSED=true`** in Render (mainnet-service → Environment → Save). Na de
   herstart (± 1 minuut) gaat er **geen enkele** uitbetaling meer uit — foto en
   automatisch — en meldt `/health` `payoutsPaused: true`. Weghalen = weer aan.
2. **Pause payouts** in het adminpaneel van de mainnet-app: zet de uitbetalingen op
   VeBetterDAO zelf stil (on-chain; je admin-wallet heeft wat VTHO nodig).
3. **Distributor-rol intrekken** op VeBetterDAO (met je admin-wallet) — als de
   distributor-sleutel gelekt kan zijn. Daarna een nieuwe distributor-wallet (stap 3).
4. **Render → Suspend** van de mainnet-service: niets draait meer.

**Geen** noodstop: `DISTRIBUTOR_DRY_RUN` (de server doet dan alsof hij betaalt en zet
standen en wachttijden als betaald), en de toegang op *Only with a role* zetten (wie al
een rol heeft, wordt gewoon betaald).

---

**Na livegang:** testers blijven op `/testnet/`. Nieuwe dingen eerst daar: testnet deployt
vanzelf, mainnet pas als jij op **Manual Deploy** klikt (stap 5). De hoofd-app op GitHub
Pages gaat wel meteen mee met `main` — grote app-wijzigingen eerst op `/testnet/` proberen.
