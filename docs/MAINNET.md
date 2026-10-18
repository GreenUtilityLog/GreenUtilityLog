# 🚀 Naar mainnet — stap voor stap

Twee versies van dezelfde app:

| | Mainnet (echt) | Testnet (om te testen) |
|---|---|---|
| App | `https://greenutilitylog.github.io/GreenUtilityLog/` | `https://greenutilitylog.github.io/GreenUtilityLog/testnet/` |
| Server | **nieuwe** Render-service | de huidige `greenutilitylog-rewards` |
| Database | **eigen** Upstash-database, `STATE_KEY=greenutilitylog:mainnet` | zoals nu |
| Wallets | admin: je bestaande admin-wallet · distributor: een **nieuwe** wallet, alleen voor mainnet | zoals nu |

Tot de laatste stap draaien **beide** versies op testnet: er verandert niets voor testers.

---

## Stap 1 — X2Earn Creator NFT (jij)
Registreren op mainnet kan alleen vanuit een wallet met een **X2Earn Creator NFT**
(het contract weigert anders: `X2EarnUnverifiedCreator`). Aanvragen bij VeBetterDAO.
Check eerst in VeWorld (op **Mainnet**) of de wallet waarmee je registreert hem al heeft.

## Stap 2 — App registreren op VeBetterDAO mainnet (jij)
Naam precies **`Green Utility Log`** → dan is de app-ID gelijk aan testnet
(`0x489c6c12…f71e`) en hoeft er in de code niets te veranderen. Andere naam (of is
deze al bezet)? Geef mij de nieuwe app-ID: dan krijgt de app een eigen ID per
netwerk — dat is een codewijziging, niet alleen een instelling in Render.

## Stap 3 — Distributor-wallet (jij)
- Maak een **nieuwe** wallet aan, alleen voor de mainnet-server. Nooit de testnet-sleutel
  hergebruiken en nooit je admin-wallet: de sleutel staat op een server, en wie hem
  heeft kan de hele pot uitbetalen. Lekt hij ooit: trek met je admin-wallet de
  distributor-rol in (zie **Noodstop** onderaan).
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

## Stap 5 — Tweede Render-service (jij, ± 5 minuten)
Render → **New → Web Service** → deze repository. **Niet via New → Blueprint**: de
blueprint (`server/render.yaml`) beschrijft de testnet-service en zou die naam en
`NETWORK=testnet` opleggen.
- **Root Directory:** `server` · **Build:** `npm install` · **Start:** `npm start`
- **Health Check Path** (onder Advanced): `/livez` — `/health` wacht op de chain en kan te traag zijn voor Render
- **Shutdown Delay** (onder Advanced / Settings): **120 seconden**. De server maakt een
  uitbetaling die al verstuurd is eerst af en legt hem vast (tot 100 s). Met Render's
  standaard van 30 s wordt hij bij elke deploy afgekapt: de B3TR is weg, het record niet.
- **Auto-Deploy: Off.** Elke wijziging in `main` gaat anders meteen naar echt geld.
  Zo gaat een wijziging eerst live op testnet (dat deployt wel vanzelf); werkt het daar,
  dan klik je bij mainnet op **Manual Deploy → Deploy latest commit**.
- **Plan:** met echt geld raad ik een betaald plan aan (slaapt niet); gratis kan ook.
  **Let op bij gratis:** Render geeft **750 instance-uren per maand per workspace**, voor
  alle gratis services samen. Twee gratis services die allebei de hele dag wakker zijn
  (de wekker in `wake.yml` houdt ze wakker) zitten daar ruim boven, en dan zet Render
  **alle** gratis services in die workspace stil tot de nieuwe maand — testnet én
  mainnet. Mainnet op gratis? Zet testnet dan in een **andere workspace**, of zet
  mainnet op **Starter** zodra het gebruik groeit.
- **Environment:**

| Sleutel | Waarde |
|---|---|
| `NETWORK` | `mainnet` |
| `DISTRIBUTOR_PRIVATE_KEY` | sleutel van de distributor-wallet (of `DISTRIBUTOR_MNEMONIC`) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | van een **nieuwe, eigen** Upstash-database voor mainnet — niet die van testnet (zie hieronder). **Verplicht, allebei:** zonder start mainnet niet |
| `STATE_KEY` | `greenutilitylog:mainnet` — **verplicht**: houdt test- en echte gegevens gescheiden; zonder "mainnet" in de sleutel weigert de mainnet-server te starten |
| `ALLOWED_ORIGIN` | `https://greenutilitylog.github.io` |
| `ANTHROPIC_API_KEY` | **verplicht**: controleert of de foto echt is en of stand + meternummer erop staan — zonder start mainnet niet (anders is de stand gewoon wat iemand intypt). Een **nieuwe** sleutel `greenutilitylog-mainnet` op platform.claude.com. Standaard met het goedkope model `claude-haiku-5-5`: per foto ± 3 aanroepen (vooraf invullen + echtheid + stand), samen een fractie van een cent; hooguit 5 pogingen per wallet per dag en 300 keer vooraf invullen per dag (`OCR_DAILY_MAX`, 15 per IP). Zet bij **Limits** een maandlimiet en een **e-mailwaarschuwing** bij bijna op: is het tegoed op, dan weigert de server elke foto-uitbetaling tot je bijkoopt |
| `MAX_PAYOUT_PER_SUBMISSION` | `1` voor de eerste week (veilige start), daarna weghalen (= 4) |
| `ECO_REWARD` | `1` voor de eerste week, daarna weghalen (= 2) |
| `REQUIRE_PASS` | niet invullen (staat standaard aan): alleen wallets met een pas worden uitbetaald |
| `PASSPORT_GRANTS_ACCESS` | niet invullen: staat op mainnet standaard uit (een passport kan van wallet naar wallet worden doorgegeven) |
| `ADMIN_WALLETS` | alleen **jouw** wallet-adres (meerdere: met komma's) |
| `DISTRIBUTOR_ADDRESS` | alleen bij `DISTRIBUTOR_MNEMONIC`: welk adres uit die woorden de distributor is |
| `CERT_DOMAINS` | de site-naam waarmee handtekeningen binnenkomen — waarschijnlijk `greenutilitylog.github.io`. **Controleer hem vooraf op testnet**: open `https://greenutilitylog-rewards.onrender.com/health` en kijk onder `certDomains.seen` (beide app-versies staan op dezelfde site, dus het is dezelfde naam). Een verkeerde waarde sluit iedereen buiten, jou als admin ook |
| `PAYOUTS_PAUSED` | **niet** invullen. Dit is de noodstop (zie onderaan): `true` stopt alle uitbetalingen |
| `POWERFOX_SECRET` | een lange willekeurige sleutel (anders dan op testnet) — zet de Powerfox- én Tibber-koppeling aan |

**Bewust geaccepteerd risico — automatische standen:** een automatische meter (gul.js,
Home Assistant, Powerfox, Tibber) kan een tijd te weinig verbruik doorgeven en dat later in
een paar grote stappen inhalen. Dan krijgt hij in die tijd de hoogste bespaarbonus. De
30-dagenfoto vangt dat niet, want een foto mag hoger zijn dan wat is uitbetaald. Gekozen is
dit zo te laten: alleen wallets met een pas van jou kunnen meedoen. Let in het admin-paneel op
meters met dagen op het maximum gevolgd door grote sprongen; dan de pas intrekken.

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

**Alleen jij op mainnet (besloten start):** zo staat mainnet op "Alleen met rol". Wallets
zonder rol zien een slotscherm en worden niet uitbetaald. Jij komt er als admin altijd in.
De database voor mainnet begint leeg, dus niemand anders heeft al een rol.

**Rollen en de schakelaar (per versie):** in het adminpaneel staat bovenaan
**"Who can use this version"**: *Only with a role* of *Everyone*. Elke versie (mainnet en
`/testnet/`) heeft zijn eigen schakelaar en zijn eigen lijst. Iemand een rol geven: zoek
zijn wallet in het adminpaneel → **Role** → *Tester* of *User* → geven. Testers geef je
een rol op de testversie; zo komen zij alleen daar binnen.

Stuur mij daarna het **adres** van de nieuwe service (bijv. `https://….onrender.com`).
Test: open `<adres>/health` en controleer:

| Veld | Moet zijn |
|---|---|
| `network` | `mainnet` |
| `appId` | `0x489c6c12…f71e` (of de nieuwe ID uit stap 2) |
| `dryRun` · `payoutsPaused` | `false` · `false` |
| `storeReady` · `storeSaving` | `true` · `true` |
| `readingCheck` · `aiPhotoCheck` | `strict` · `true` |
| `distributorAuthorized` · `distributionPaused` | `true` · `false` |
| `rewardsPoolEnabled` | `false` (als je die in stap 3 uitzette) |
| `access` | `roles` |
| `adminWallets` | alleen jouw adres |
| `certDomains.enforced` | jouw `CERT_DOMAINS` |
| `rules.maxPayout` | `1` (de veilige eerste week) |

## Stap 6 — Live zetten (ik)
In één pull request:
- `.github/workflows/deploy.yml`: `MAIN_NETWORK: mainnet` en `MAINNET_API: <adres>`.
- `bridge/index.js` + `src/network.js` (`BRIDGE_DEFAULT_API`): standaardserver → mainnet;
  de testnetapp zet dan zelf `--ingest=<testnet>` in zijn installatieregel.
- `.github/workflows/watchdog.yml`: het mainnet-adres in de lijst `server:` — dan krijg
  je elke ochtend ook voor mainnet een melding (lege pot, weinig VTHO, rol kwijt, opslag).
- `.github/workflows/wake.yml`: een tweede regel die ook de mainnet-server elk uur wekt
  (nodig voor Powerfox zolang de server op het gratis plan staat). Let op: GitHub zet
  geplande workflows in een publieke repository **uit na 60 dagen zonder commits**.
  Wordt de server ineens niet meer gewekt, kijk dan in het tabblad **Actions** bij
  *Wake the reward server*: daar staat de melding en de knop om hem weer aan te zetten.
- Ook naar mainnet: `DEFAULT_INGEST_URL` in `custom_components/greenutilitylog/const.py`
  en de YAML in `docs/build_guide.py` (alle 5 talen).
- **Add-on:** die heeft een eigen kopie van gul.js (`ha-addon/gul-bridge/gul.js`,
  bijgewerkt door `docs/build_guide.py`), en Home Assistant bouwt een add-on alleen opnieuw
  als zijn **versie** verandert. Verhoog daarom `version` in `ha-addon/gul-bridge/config.yaml`
  in dezelfde pull request; anders blijft iedereen met de add-on naar de oude server sturen. Add-on-testers die op testnet
  willen blijven, vullen bij **ingest_url** het adres van de testnet-server in:
  `https://greenutilitylog-rewards.onrender.com/meter-ingest`.
- **Testers met een P1-reader:** hun geïnstalleerde `gul.js` verandert niet vanzelf (de
  geplande taak draait het bestand op hun eigen computer), dus die blijft gewoon naar
  testnet sturen — niets te doen. Maar: wie daarna een installatieregel uit de
  **handleiding** plakt, downloadt de nieuwe `gul.js` over de oude heen, en die stuurt naar
  **mainnet** (de regels in de handleiding hebben geen `--ingest`). Testers op testnet
  gebruiken dus altijd de regel uit de **testnet-app**, die `--ingest=<testnet>` meegeeft.
  Wie naar mainnet wil, plakt de regel uit de mainnet-app (met zijn mainnet-token).
- **Testers met de Home Assistant-integratie** die op testnet blijven: onder
  **Configure** het serveradres op de testnet-server zetten (zelfde adres als hierboven).
- Home Assistant-integratie en add-on: standaardserver → mainnet.
- Handleiding: “testnet / testtokens” eruit (ook de voettekst, in alle 5 talen), link naar
  de testversie erin.

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
   herstart (± 1 minuut) gaat er **geen enkele** uitbetaling meer uit — foto, eco en
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
