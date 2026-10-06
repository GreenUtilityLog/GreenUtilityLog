# 🚀 Naar mainnet — stap voor stap

Twee versies van dezelfde app:

| | Mainnet (echt) | Testnet (om te testen) |
|---|---|---|
| App | `https://greenutilitylog.github.io/GreenUtilityLog/` | `https://greenutilitylog.github.io/GreenUtilityLog/testnet/` |
| Server | **nieuwe** Render-service | de huidige `greenutilitylog-rewards` |
| Database | zelfde Upstash, `STATE_KEY=greenutilitylog:mainnet` | zoals nu |
| Wallets | de bestaande app-wallets | zoals nu |

Tot de laatste stap draaien **beide** versies op testnet: er verandert niets voor testers.

---

## Stap 1 — X2Earn Creator NFT (jij)
Registreren op mainnet kan alleen vanuit een wallet met een **X2Earn Creator NFT**
(het contract weigert anders: `X2EarnUnverifiedCreator`). Aanvragen bij VeBetterDAO.
Check eerst in VeWorld (op **Mainnet**) of de wallet waarmee je registreert hem al heeft.

## Stap 2 — App registreren op VeBetterDAO mainnet (jij)
Naam precies **`Green Utility Log`** → dan is de app-ID gelijk aan testnet
(`0x489c6c12…f71e`) en hoeft er in de code niets te veranderen. Andere naam? Geef mij
de nieuwe app-ID.

## Stap 3 — Distributor-wallet (jij)
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
Render → **New → Web Service** → deze repository.
- **Root Directory:** `server` · **Build:** `npm install` · **Start:** `npm start`
- **Plan:** met echt geld raad ik een betaald plan aan (slaapt niet); gratis kan ook.
- **Environment:**

| Sleutel | Waarde |
|---|---|
| `NETWORK` | `mainnet` |
| `DISTRIBUTOR_PRIVATE_KEY` | sleutel van de distributor-wallet (of `DISTRIBUTOR_MNEMONIC`) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | dezelfde als bij testnet |
| `STATE_KEY` | `greenutilitylog:mainnet` — **belangrijk**, anders lopen test- en echte gegevens door elkaar |
| `ALLOWED_ORIGIN` | `https://greenutilitylog.github.io` |
| `ANTHROPIC_API_KEY` | sterk aangeraden: controle stand + meternummer op de foto |
| `MAX_PAYOUT_PER_SUBMISSION` | `1` voor de eerste week (veilige start), daarna weghalen (= 4) |
| `ECO_REWARD` | `1` voor de eerste week, daarna weghalen (= 2) |
| `REQUIRE_PASS` | niet invullen (staat standaard aan): alleen wallets met een pas worden uitbetaald |
| `PASSPORT_GRANTS_ACCESS` | `false` — anders komt elke VeBetterDAO-gebruiker met een passport er zonder pas in |
| `ADMIN_WALLETS` | alleen **jouw** wallet-adres (meerdere: met komma's) |

**Alleen jij op mainnet (besloten start):** met de drie regels hierboven wordt op mainnet
alleen uitbetaald aan wallets met een pas, en alleen jij kunt passen uitdelen. De database
voor mainnet begint leeg, dus niemand krijgt automatisch een pas. Geef jezelf een pas in het
adminpaneel (Pass → je eigen adres). Anderen kunnen de app openen maar krijgen niets, tot
jij ze een pas geeft. Testers blijven op `/testnet/`.

Stuur mij daarna het **adres** van de nieuwe service (bijv. `https://….onrender.com`).
Test: open `<adres>/health` → `network` moet `mainnet` zijn.

## Stap 6 — De pot (jij)
Vul de pot met echte B3TR (adminpaneel → Fund rewards pool), of wacht op de wekelijkse
allocatie — die komt pas als de app genoeg **endorsement** heeft.

## Stap 7 — Live zetten (ik)
In één pull request:
- `.github/workflows/deploy.yml`: `MAIN_NETWORK: mainnet` en `MAINNET_API: <adres>`.
- `bridge/index.js` + `src/network.js` (`BRIDGE_DEFAULT_API`): standaardserver → mainnet;
  de testnetapp zet dan zelf `--ingest=<testnet>` in zijn installatieregel.
- Home Assistant-integratie en add-on: standaardserver → mainnet.
- Handleiding: “testnet / testtokens” eruit, link naar de testversie erin.

## Stap 8 — VeWorld app-hub (ik, jij klikt één keer)
De aanmelding staat klaar in `brand/app-hub/`. Fork van `vechain/app-hub`, dan dien ik hem in.

---

**Na livegang:** testers blijven op `/testnet/`. Nieuwe dingen eerst daar, dan pas naar mainnet.
