# Openstaande punten

De vaste lijst van wat nog moet, uit de audits (code, ontwerp, server) en uit
gesprekken. Bijgewerkt bij elke PR die een punt afrondt: afgevinkt = klaar, met
het PR-nummer erbij. Nieuwe punten komen onderaan hun groep.

Laatst bijgewerkt: 2026-11-28.

## Ronde 1 — vóór mainnet (veiligheid en geld) ✅
- [x] Opslag in delen, zodat één grote waarde niet alle uitbetalingen stillegt; invoer begrensd (#144)
- [x] Decimale komma; dubbeltarief offline en fotocontrole per telwerk (#145)
- [x] Mainnet start niet zonder AI-fotocontrole en `CERT_DOMAINS`; geen uitbetaling vóór bevestigde chain (#146)
- [x] `npm audit fix` server, logregel per uitbetaling, watchdog elk uur, Dockerfile (#147)

## Ronde 2 — eerste indruk ✅
- [x] Deelafbeelding (`docs/og-image.png`): kaart met logo, naam en slogan (#148)
- [x] Connect Wallet-knop: lichte knop op de donkere schermen, ook in de intro (#148)
- [x] Donkere modus: tutorialtitels, tekst op groene vlakken, kalender (`bgAlt`), logotegel (#148)
- [x] Bijsnijdscherm boven de menubalk (portal naar `document.body`, ondoorzichtig) (#148)
- [x] Eerste gebruik: "Log your first reading" op Home; registratietekst kort; "baseline" → startpunt (#148)

## Media voor X ✅
- [x] Acht bewegende banners (MP4 + GIF): meter, kiemplant, week, P1-landen, DACH, Noorden, VS/Canada, zondagsvraag (#149)
- [x] Deellinks met elk een eigen voorbeeldkaart: `…/GreenUtilityLog/share/<naam>.html` (#149)
- [x] Opnieuw maken of een nieuwe zondagsvraag: `node brand/animated/render.cjs sunday --q="…"` (#149)

## Ronde 3 — afwerking ontwerp
- [x] Knoppen minimaal 44 px (wallet-knop, help, dubbeltarief-vinkje, Sluiten, Retake); taalkeuze 36 px (#150)
- [x] Invoervelden 16 px (iPhone zoomt nu in) en zichtbare focusrand (`:focus-visible`) (#148, #150)
- [x] Formuliercontrast: randen, placeholders, foutkleur, "pending"-label (#150)
- [ ] Vaste lettergroottes (12/14/16/20/28/40) en kleuren als tokens — kleinste tekst (9–9,5 px) al naar 10,5 px (#153)
- [x] Datums overal hetzelfde (`Intl.DateTimeFormat`, `fmtDay`) (#150)
- [x] Geschiedenis: beloning als hoofdgetal, verbruik in de titel, meternummer kort (#153)
- [x] Offline-melding als balk met uitleg in plaats van een rood stipje (#150)
- [x] Computer: QR-code naar de app i.p.v. een actieve fotoknop die niets kan (#151)
- [x] Klassement (top 3 + jouw plek) bovenaan Voortgang; vergrendelde badges met slotje (#151)
- [x] Intro: één voortgangsindicator (stippen, nu knoppen); `prefers-reduced-motion` (#150, #151)
- [x] Uitleg welke wallet-optie te kiezen; meldingen onderaan i.p.v. over de kopknoppen (#151)
- [x] `apple-touch-icon` en manifest (#151)
- [x] Handleiding met logo, terugknop en inhoudsopgave (#153)
- [x] Hele app vertalen (NL, DE, FR, ES) — `src/i18n.js` + taalkeuze in Instellingen:
  - [x] Stap 1: intro, tutorial, verbinden, registratie, Home, menu, kopbalk, banners (#154)
  - [x] Stap 2: meterscherm (foto, stand, insturen, meldingen) (#155)
  - [x] Stap 3: Voortgang, Geschiedenis, Profiel, Instellingen, Feedback (#156)
  - [x] Stap 4: automatisch uitlezen; Help-teksten naar de vertaalde knopnamen (#157)
  - [x] Foutmeldingen van de server (#168)
  - Bewust Engels: de Home Assistant-stappen (volgen HA's eigen menu's) en het beheerscherm (alleen eigenaar)
- [x] Toegankelijkheid: dialogen met `role="dialog"`, focus erin, Tab blijft binnen, Escape sluit (#153)
- [ ] Bijsnijden met het toetsenbord (pijltjestoetsen)

## App — code
- [x] Voortgang en PDF tellen mislukte uitbetalingen mee; "bespaard" rekent met één dag i.p.v. de periode (#158)
- [x] Offline foto's: verstuurde, geweigerde en te oude (>14 dagen) worden opgeruimd; één databaseverbinding (#161)
- [x] Content-Security-Policy in `index.html` (alleen eigen scripts, inline-scripts per hash, jsPDF en captcha) (#161)
- [x] Bundel: bibliotheken in een eigen bestand (1,8 MB), app-code 396 KB — na een update alleen dat laatste opnieuw (#161)
- [x] Beheerscherm (`src/admin.jsx`, 50 KB) en koppelschermen (`src/reader.jsx`, 37 KB) laden pas als ze geopend worden; Help is klein (73 regels) en blijft (#164)
- [x] Geschiedenis van de chain samenvoegen met wat nu op het scherm staat (inzending tijdens laden verdwijnt) (#158)
- [x] "Pending" wordt nooit "failed" als de chain niets teruggeeft (#158)
- [x] Afteller van de cooldown loopt niet door (#158)
- [x] Klassement 2 min gedeeld tussen schermen; lezen tot een vast blok, dus geen dubbele telling meer (#161)
- [x] Standen zonder beloning staan alleen op het eigen toestel: laatste stand per meter van de server halen (#158)
- [x] `App.jsx` 7.200 → 5.140 regels: dode code eruit, beheerscherm en koppelschermen in eigen bestanden (#162, #164)
- [ ] Verder opsplitsen: pure logica (beloning, datums, offline-wachtrij) naar `src/lib/`, dan de schermen; de nieuwe bestanden importeren nu nog hulpfuncties uit `App.jsx`
- [x] Dode code opruimen: `sendAndEarn`, `Toggle`, `B3TR_USD`, ongebruikt beheeronderdeel, `!REWARD_API`-takken en het directe on-chain-pad, 4 ongebruikte vertalingen; server: ongebruikte imports en sleutels (#162)
- [x] Privacy: nieuwe vraag "Wat bewaren jullie over mij?" in Help (5 talen): blockchain, server, apparaatkenmerk, logins; Tesseract-taaldata komt van de eigen site, een scan praat met niemand anders (#166)
- [x] Afhankelijkheden app: Vite 8 (bouwen 3 s i.p.v. 20 s), plugin-react 6, React 19; `ws` en `zod` via `overrides` (#163)
- [x] `decode-uri-component` via WalletConnect: WalletConnect 2.23.10 via `overrides` gebruikt `query-string` niet meer; `npm audit` voor de app 8 hoog → 0 (#218, verving #133)
- [ ] WalletConnect-QR na #218 testen: op een computer **Connect → Wallet Connect**, de code scannen met VeWorld, verbinden en één handtekening zetten (vanuit de testomgeving niet bereikbaar). Lukt het niet: #218 terugdraaien
- [ ] De WalletConnect-`overrides` in `package.json` weghalen zodra dapp-kit zelf een nieuwere WalletConnect meebrengt (2.3.3 zit nog op 2.19.2)
- [ ] `elliptic` in de Node-polyfills (6× laag, alleen tijdens het bouwen, niet in de app)

## Server en koppelingen
- [x] Transactie zonder ontvangstbewijs: elke minuut opnieuw gecontroleerd; na 15 min weg → melding voor de beheerder (#159)
- [x] `/health`: chain-gegevens 30 s gedeeld, één ronde aanroepen per keer (#160)
- [x] Tibber koppelen: thuis 2 min gereserveerd in de gedeelde opslag (twee processen tijdens een deploy) (#159)
- [x] `/reward-from-meter` zegt "niets gebruikt" als de boekhouding na een uitbetaling faalt (#159)
- [x] Time-outs op Enode (15 s) en R2 (30 s); Google Vision-sleutel in een header. Roboflow neemt zijn sleutel alleen in de URL: die URL wordt nergens gelogd (#160)
- [x] Snelheidslimiet per IPv6-/64 in plaats van per adres (#160)
- [ ] `index.js` (2.400 regels) opsplitsen in routegroepen (beheer, koppelingen, uitbetaling); eco-resten zijn weg (alleen `/eco-action` → 410). Bewust nog niet gedaan: veel gedeelde toestand, eerst tests voor de admin-routes
- [x] Tests voor: afsluiten met uitbetaling onderweg, `/admin/photo`, `/admin/move-rewards-pool` (#166)
- [x] Servertests hingen in CI na een poortbotsing; nu opnieuw starten en `--test-force-exit` (#159)
- [x] gul.js: versie in de `User-Agent` (server bewaart hem bij de stand), antwoorden max. 1 MB; een nu opgegeven `--ip` wint van een opgeslagen Tasmota/URL; add-on 1.5.3 (#160)
- [x] HA-add-on: instellingen en log in `/data` (`GUL_DATA_DIR`), versie 1.5.2 (#159)
- [x] Afhankelijkheden server: Express 5, @anthropic-ai/sdk 1.3 (API-versie 2026-10-21, sleutel als Bearer), @vechain/sdk 2.1, ws 8.22 (#163)

## Volledige controle (november) — #167
- [x] Server: zelfde meter met andere schrijfwijze betaalde dagen dubbel; >7 dagen tussen standen blokkeerde een meter voor altijd; Tibber/Powerfox ontkoppelen wiste een P1-token; opnieuw koppelen vergat de laatste uitbetaling; koppelen zonder meternummer gaf een fout; `fix-basis` zonder vergrendeling; drie verkeerde foutcodes
- [x] App: voorbeeldbeloning rekende met de verkeerde periode; grafiek vergeleek meerdaagse standen met één dag; restanten van een vorige wallet; toetsenbordval achter de intro; verstuurknop bleef hangen na offline opslaan; OCR bleef uit na één mislukte laadpoging; ~45 Engelse teksten vertaald
- [x] Koppelscherm/beheer: PowerShell-commando op Windows, Home Assistant-YAML in één keer plakbaar, Tibber/Powerfox als automatisch herkend in beheer, hernoemde meter direct zichtbaar
- [x] Bridge 1.5.4 / add-on / HA-integratie: `--install` opnieuw vergat de uitlezer; instellingen via omgevingsvariabelen gingen niet mee naar de planning; `forget_last` in de add-on; 6 uur wachten na een geweigerd token; `http://` in `--ip`; HA: standaardserver niet vastgezet, Wh-sensoren toegestaan, token getrimd
- [x] Norm naar rato: een stand na 20 uur telt als 20/24 dag (6,7 kWh), niet als een hele dag; server en app rekenen hetzelfde (#168)
- [x] Foutmeldingen van de server in 5 talen: de app stuurt `X-GUL-Lang`, de server vertaalt centraal (`server/messages.js`); een test eist een vertaling voor elke nieuwe melding (#168)

## Controle na #167 (november, voor mainnet)
- [x] Server: geen uitbetaling om de GM + Passport-toegang heen (elk pad gecontroleerd); Passport onleesbaar → "probeer opnieuw" i.p.v. "telt je niet"; een stand die niets uitbetaalt meldt 0 kWh bespaard (ook bij de walletcheck); eerste stand zonder `days`; "in 1 uur" i.p.v. "0 dag(en)"; ~25 meldingen vertaald (o.a. foto-daglimiet, telefooncontrole, budget op, Tibber, Powerfox) en de vertaaltest vangt nu ook `publicError`/`fail`
- [x] App: eerste stand niet meer als enorm dagverbruik; mislukte uitbetaling telt niet mee in kWh/CO₂; GM-badge hangt niet meer op een trage afbeelding; toegang wordt eerst gecontroleerd (met de laatste uitkomst onthouden) i.p.v. eerst open; kalender toont een onderweg zijnde uitbetaling als uitbetaald; niveaubalk pas 100% bij het niveau

## Voor mainnet: uitleg
- [x] Fototips stonden achter de menubalk (te weinig ruimte onderaan de pagina) (#186)
- [x] Intro vernieuwd: automatisch uitlezen, rekenvoorbeeld (8 kWh-norm, 6 gebruikt → 2 bespaard), niveaus; mainnet-versie krijgt een 5e dia "Voor leden van VeBetterDAO" (GM NFT + Passport). Tutorial noemt de niveaus. FAQ: drie nieuwe vragen (wie mag de app gebruiken, niveaus, GM-kaart), in 5 talen

## Kwaliteitsbewaking
- [x] Volledige browsertest in CI (`e2e/journey.mjs`, workflow "End-to-end"): echte app-build + echte server + ondertekenende nep-wallet; registreren, uitbetaling, Home/Geschiedenis/Voortgang, uitlezer, offline-wachtrij, Nederlands met servermelding. Faalt bij elke mislukte stap, paginafout of CSP-schending — gecontroleerd door de app en de server opzettelijk te breken (#169)

## Functies
- [x] VeBetterDAO GM NFT op Profiel, als badge onderin de accountkaart (naast de rol): plaatje, niveau (Earth … Galaxy), "niveau n van max" (max uit het contract) en tokennummer, rechtstreeks van de blockchain; zonder NFT een link naar VeBetterDAO, bij een onbereikbare node een melding in plaats van "geen NFT". Leest altijd van mainnet, ook in de testnet-versie, want daar staan de NFT's van gebruikers. Niveaunamen (Aarde … Melkweg) staan in de taal van de app. Op mainnet gecontroleerd door de eigenaar (Mercurius, niveau 3, #827, met plaatje).
- [x] Eigen app-niveaus (Maan, Zon, Ster, Goud, Platina) weggehaald: ze stonden naast de GM-niveaus met deels dezelfde namen. Voortgang toont nu je plek en je totaal Contractadressen en functies gecontroleerd tegen `@vechain/vebetterdao-contracts` 10.0.0 en `@vechain/vechain-kit`; in de browsertest

## Product en organisatie
- [ ] Antwoord aan VeBetterDAO (beoordeling) versturen en opvolgen
- [x] Creator NFT ontvangen; app-aanvraag op mainnet ingediend (17-11-2026)
- [x] Endorsement gehaald: 110/110 punten, 10 ondersteuners; op VeBetterDAO mainnet "Ondersteund en actief", doet mee aan de komende allocatierondes (27-11-2026)
- [x] De server houdt zichzelf wakker: elke 11 min zijn eigen `/cron/tick` (`RENDER_EXTERNAL_URL`), geen aparte dienst (keuze eigenaar). De GitHub-wekker draaide maar ± 3 keer per dag. Bij de livegang `KEEP_AWAKE=off` op testnet (750 gratis uren)
- [x] Elke wekbeurt betaalt ook standen die nog openstaan (een gemiste automatische uitbetaling wachtte tot de volgende push, een halve dag later)
- [x] Livegang mainnet (28-11-2026, #226): server op mainnet (`chainConfirmed`, distributor-rol, pool uit, toegang GM NFT + Passport, `CERT_DOMAINS`, max 1 B3TR, testgegevens overgenomen), app op mainnet, geen testversie meer
- [ ] Maandag 30-11: `PAYOUTS_PAUSED` weghalen in Render (keuze eigenaar: uitbetalen pas vanaf maandag); vóór die tijd de pot vullen (2.500 B3TR), daarna één test-uitbetaling op de eigen wallet
- [ ] Mainnet-stappen uit `docs/MAINNET.md` (serverwissel in Render, sleutels, `CERT_DOMAINS`, eerste week `MAX_PAYOUT_PER_SUBMISSION=1`). Route 28-11 (keuze eigenaar): geen testnet meer, geen testversie, één Upstash-database met eigen `STATE_KEY`
- [x] Testers hoeven bij de livegang niets opnieuw te doen (keuze eigenaar, 20-11-2026): de huidige server wordt mainnet (uitlezers blijven daarheen sturen), testnet krijgt een nieuwe server. De mainnet-server neemt bij de eerste start meters, beginstanden, uitlezer-tokens en cloudkoppelingen over (`CARRY_OVER_KEY`); de mainnet-app neemt op de telefoon meternummer, beginstand, token, telefoon-ID en taal over. Getest op de server (met tegenproef) en in de browser (testnet → zelfde telefoon op mainnet)
- [ ] Grant-aanvraag VeBetter Grants (x2earn-spoor)
- [x] Toegang mainnet volgens de regel van VeBetterDAO (morbidejs, 17-11-2026): hoofdwallet van het Passport (geen gekoppelde), geen signaleringen, gestemd in de vorige ronde met een GM NFT van niveau 2+ die nog in de wallet staat, plus Passport "is persoon". Elke regel apart getest; de app toont per regel wat ontbreekt (20 talen)
- [x] Wallets waarvan de signaleringen na KYC door de Foundation zijn teruggezet (`UserSignalsReset` op VeBetterPassport, verstuurd door `0x12A7…B259`, reden "Resetting signal counter for KYC'ed wallet"): **toegelaten, wel gemarkeerd** (keuze eigenaar, 18-11-2026; morbidejs waarschuwde dat blokkeren bekende mensen uit de community raakt). De admin ziet een markering bij de wallet en een regel in het rollenpaneel, en kan zelf blokkeren
- [ ] Extra beloning voor X-node-houders: later (keuze eigenaar)
- [x] Herhaalfoto (elke 90 dagen, was 30) alleen nog voor uitlezers die zelf standen sturen (P1, Home Assistant, script); Powerfox, Tibber en MojElektro hoeven geen herhaalfoto (keuze eigenaar, 18-11-2026). De eerste foto (startpunt) blijft voor iedereen. Uitlezerkaart: bij een pauze zegt de tijdlijn "eerst een foto" en is er geen claimknop; een stand zonder besparing toont geen "Paid +0.00"; tijden niet meer half afgebroken; resterende Engelse zinnen vertaald (20 talen)
- [x] (eerder) Mainnet alleen voor wallets met een GM NFT (elk niveau) én een VeBetterDAO Passport dat ze als persoon telt; de server controleert het op de blockchain bij openen en bij elke uitbetaling; admins altijd; een rol telt dan niet. Derde stand in het adminpaneel (*GM NFT + Passport*), standaard op mainnet
- [x] Licentie van MIT naar AGPL-3.0-only: openbaar blijven (HACS, add-on, Pages, CI), maar wie de code als dienst draait moet zijn aanpassingen ook openbaar maken. Versies t/m `85d062e` blijven MIT
- [ ] Naam "Green Utility Log" als merk vastleggen (BOIP, Benelux) — overwegen; eventueel met een jurist
- [ ] Normen per land (nu één norm van 8 kWh per dag)
- [ ] Idee (eigenaar, 28-11-2026: voorlopig niet): beloning per dag i.p.v. per periode — (8 − verbruik per dag) × 0,61 × hele dagen (afgerond, min. 1). Dan hangt een uitbetaling niet meer af van hoe lang de periode toevallig was (27 nov ± 28 u: 4,00; 28 nov ± 24 u: 3,34 bij minder verbruik), en een gemiste dag telt nog mee tot het plafond van 4. Op de chain moet `savedKwh` dan meeveranderen
- [x] Eigen app-niveaus terug, op aantal inzendingen (niet op B3TR): Druppel 💧 (0), Vonk ⚡ (50), Vlam 🔥 (200), Zonnestraal ☀️ (500), Groene centrale 🌍 (1000), geteld in dagen met een stand (meer meters gaat niet sneller); één ladder met water, stroom, gas en zon; eerst planten, op verzoek energie en strenger; op Home, Voortgang (met balk naar het volgende niveau) en Profiel
- [x] Voortgang: bespaarde energie per week/maand (met gemiddeld verbruik per dag t.o.v. de norm), inzendkalender van 12 weken, en een vooruitblik per jaar op basis van de laatste 30 dagen (na minstens een week)
- [x] Voortgang rekent met de besparing waarop de server uitbetaalde (ook als de telefoon de vorige stand niet kent) (#175)
- [x] Voortgang: volgend GM-niveau en hoeveel B3TR er nog nodig is (`getB3TRtoUpgrade` uit het GalaxyMember-contract, gecontroleerd tegen de broncode in `@vechain/vebetterdao-contracts`), met een link om op VeBetterDAO te upgraden
- [ ] Roadmap: gas en water, daarna zonnepanelen (staat in de server, uitgeschakeld) — eerst de focus op elektriciteit; bij het toevoegen de niveaus (namen, grenzen, tellen per dag) opnieuw bekijken
- [x] Enode verwijderd: nooit ingeschakeld, betaald, en P1/Home Assistant/Powerfox/Tibber dekken het (#165)

## Later, als de app loopt (ideeën uit HangnDry, november)
- [x] Klassement met "Deze week / Altijd" (standaard deze week, vanaf maandag 00:00) en per wallet de reeks (🔥 dagen op rij met een uitbetaling), uit de chain; in 20 talen
- [ ] Live teller "Net uitbetaald +x B3TR · 1 min geleden" uit de chain
- [ ] Eenmalige B3TR-bonus per niveau (Vonk, Vlam, Zonnestraal, Groene centrale), met plafond, via de bestaande uitbetaling; bedragen nog kiezen
- [ ] Reeksbonus per week (bijv. +5–10%), binnen het weekbudget; anti-farming (één wallet per telefoon, meter, foto) moet overeind blijven
- [ ] Teller "x van y inzendingen deze week" / wachttijd zichtbaar op Home
- [ ] Mijlpaal-NFT's met eigen artwork (eigen contract + gas): pas na de B3TR-bonus
- [ ] Beloningsvermenigvuldiger op basis van VOT3-stemmen: eerst bij VeBetterDAO navragen of dat mag

## Meer landen en meters (uitgezocht in november)
Met een foto kan elk land al meedoen. Voor elk nieuw land geldt eerst: een norm per land (8 kWh per dag past bij NL/BE), de taal, en op mainnet GM NFT + Passport.
- [x] Talen als losse bestanden: een extra taal is één bestand in `src/lang/` (app, Help, FAQ) en één in `server/lang/` (meldingen), alleen geladen als iemand hem kiest; `scripts/check-langs.mjs` (in CI) en de servertest eisen elke tekst, dezelfde {plekken}, links en ⚠️/❌ aan het begin. Help kiest de taal nu met een keuzelijst
- [x] 7 talen erbij: Italiaans, Grieks, Turks, Sloveens, Kroatisch, Roemeens, Bulgaars (app, Help/FAQ, servermeldingen). Machinaal vertaald en automatisch gecontroleerd; nog niet nagelezen door iemand die de taal spreekt
- [ ] Vertalingen laten nalezen door een moedertaalspreker (per taal)
- [x] 8 talen erbij: Zweeds, Deens, Noors, Fins, Hongaars (daar werken meters al), Pools, Portugees, Tsjechisch — 20 talen in totaal; ook nog niet nagelezen
- [x] Handleiding: schermnamen komen uit de app zelf (klopten in het Nederlands, Duits, Frans en Spaans niet: stonden in het Engels); fotoregel bijgewerkt (90 dagen, niet voor Powerfox/Tibber/MojElektro); extra talen als `docs/guide_lang/<code>.json`, door het script gecontroleerd op opbouw, opdrachten, links en HTML; taalkeuze als keuzelijst
- [x] FAQ "Welke meters werken?" en de landentabel in de handleiding: Slovenië (P1, nog niet getest), Griekenland, Kroatië, Turkije, Roemenië, Bulgarije en de rest van de Balkan (voorlopig foto's), in 5 talen
- [ ] Norm per land, vastgesteld door de beheerder of aan de hand van de meter (niet door de gebruiker zelf te kiezen)
- [x] 🇸🇮 MojElektro-koppeling gebouwd, **uitgeschakeld** tot een Sloveense tester hem probeert (aanzetten: `MOJELEKTRO=on` op Render, naast `POWERFOX_SECRET`). Gebruiker vult token (Moj profil → Kreiraj žeton) en meetpunt (EIMM) in; de server haalt elke 6 uur de dagstand A+ (`32.0.4.1.1.2.12.0.0.0.0.0.0.0.0.3.72.0`, anders VT+MT). Omdat de stand een dag later komt, rekent de uitbetaling de periode tot het tijdstip van de meter zelf, en een stand die niet nieuwer is dan de laatste wordt nooit betaald. Getest tegen een nagebootste API (servertests + browserreis), niet tegen de echte
- [ ] MojElektro met een echte Sloveense meter proberen; de officiële Swagger (`docs.informatika.si/mojelektro/api`) nalezen op veldnamen en datumnotatie
- Bronnen: foto, P1-meter en de bestaande koppelingen zijn genoeg — geen nieuwe bronnen of landkoppelingen bouwen (keuze eigenaar, 20-11-2026: eerst niet te moeilijk)
- Niet doen: tussenmeters zoals Shelly EM of stroomtangen (meten niet de officiële meter)

## Volledige controle (19 november) — 4 reviewers, elke bevinding nagelopen
- [x] Geld: MojElektro-standen die meer dan een dag laat binnenkomen werden automatisch overgeslagen (vergeleken met het moment van uitbetalen i.p.v. de metertijd)
- [x] Geld: na een startpunt-herstel of een startpunt van de beheerder is eerst een foto nodig, ook voor Powerfox/Tibber/MojElektro — anders kon een cloud-account van een andere meter worden uitbetaald
- [x] Toegang: één keer de blockchain lezen voor antwoord én reden (een haperende eerste lezing gaf "telt je niet als persoon"); een node-storing bij `ownerOf` is "probeer opnieuw", geen "nee"; het onthouden antwoord geldt alleen voor de ronde waarin het gegeven is; ongeldig adres → 400 i.p.v. "geen toegang"
- [x] KYC-markering alleen bij een wallet die echt wordt toegelaten, en ook bij automatisch uitbetalen (niet alleen bij openen)
- [x] Privacy: `/wallet/seen` geeft de laatste standen alleen nog aan een telefoon waarmee de wallet al eens instuurde
- [x] Koppelingen: Powerfox-reservering 2 minuten vast (als Tibber); Tibber neemt geen huis over dat al aan een andere wallet hangt; koppelpogingen ook per netwerkadres beperkt (20/uur); `/health`-domeinlijst niet meer vol te spammen
- [x] App: toetsenbord/schermlezer bleef vastzitten achter het walletscherm; offline wachtrij verloor een vastgelegde stand bij een verbindingswissel en probeerde "nog niet"-items nooit op tijd opnieuw; door de beheerder toegewezen meternummer verscheen niet in het formulier; taalwissel kon in de verkeerde taal eindigen; testnet-balk volgde de taal niet; weken/dagen rond zomer-/wintertijd; streak, kalender en "100 standen" tellen nu dezelfde standen; "eerste stand"-tekst gebruikt ook de stand van de server
- [x] Uitlezerkaart: "Verbonden" alleen bij een verse stand (met datum); geen valse "startpunt klopt niet"-kaart zonder fotostand; geen claimknop tijdens wachttijd of bij een te oude stand; "laat de computer aan" niet bij Powerfox/Tibber/MojElektro; resterende Engelse zinnen vertaald (20 talen)
- [x] Beheer: leeg veld zette een startpunt op 0; BLOCKED ook bij wallets van de blockchain; waarschuwing als de lijst afgekapt is
- [x] gul.js: één tarief alleen is geen stand meer; Mac weigert installeren vanuit Bureaublad/Documenten/Downloads (cron mag daar niet lezen) met de juiste opdracht; waarschuwing bij nvm/snap-node; Windows `--uninstall` verwijdert alle eigen taken; add-on 1.5.5
- Bewust zo gelaten: het maandrapport (PDF) blijft Engels — het PDF-lettertype heeft geen Griekse/Cyrillische letters. Een wallet-wissel stuurt heel even de oude meterlijst mee; die wordt direct overschreven

## Buitenstaander-audit (22 november) — 4 reviewers, elke bevinding gereproduceerd en nagelopen
- [x] Geld: een automatische stand werd gemeten tot het moment van uitbetalen i.p.v. het moment van meten (0,5 kWh in 1 uur leverde ±3,9 B3TR op); nu tot de tijd van de stand zelf
- [x] Geld: betalingslogboek — een uitbetaling wordt vóór het versturen vastgelegd; stopt de server halverwege, dan wordt hij na de herstart vanuit de chain afgerond (geen dubbele betaling meer; niet aangekomen → meter weer vrij); verloren/teruggedraaide uitbetalingen worden ook na een herstart gemeld
- [x] Geld: het slot "kort geleden al uitbetaald" kon 20 uur blijven staan zonder betaling (verloren antwoord van Upstash, stoppen tijdens het nemen); nu kort slot (15 min) dat pas na de uitbetaling wordt verlengd, en wordt teruggegeven als het antwoord zoekraakt; afsluiten wacht ook daarop
- [x] Overzetten testnet→mainnet: geen oude automatische standen, geen cloud-account dat al aan een andere wallet hangt, geen overlappend meternummer
- [x] Server: 6 trage uploads blokkeerden alle foto-uitbetalingen; open `/wallet/seen` kon de opslag laten groeien; wegwerpwallets lieten gebruikte handtekeningen groeien; handtekening wordt nu eerst gecontroleerd, pas na de toegangscheck verbruikt, met plafond
- [x] App: geen crash meer op oudere iPhones/Android (AbortSignal.timeout) of als een onderdeel niet laadt; crashscherm vertaald met herlaadknop; tijdlijn en Home-tegel van de uitlezer eerlijk; wisselen van wallet bewaart ieders meter; offline-wachtrij vraagt geen handtekeningen meer binnen de wachttijd; PDF via het deelmenu en jsPDF in de app zelf (cdnjs uit het beveiligingsbeleid); "Vergeet deze telefoon" voor iedereen; geen inzoomen op iOS; grotere tikvlakken; privacytekst noemt het walletadres
- [x] Bridge: één foute meting legde de bridge voorgoed stil; logbestand nu privé zonder wachtwoorden; cron op een eigen minuut; waarschuwing bij fnm; `iwr -UseBasicParsing` voor Windows; versie 1.5.6
- [x] CI: de add-on-controle kon nooit falen; nu vóór het buildscript, plus versieophoging verplicht bij een gewijzigde helper, standaardserver overal gelijk, testnet-build en gepubliceerde bestanden al bij de PR; `gul.js` wordt gepubliceerd vanuit een stap zonder npm; bridge-tests ook op Windows en macOS (sinds #215 alleen bij PR's die de bridge raken); sharp vastgepind
- [ ] Bewust niet gedaan / restpunten: `/ocr` zonder handtekening (max 300 per dag, schade beperkt); foto's: meten tot de EXIF-tijd (te omzeilen door EXIF te strippen); negatieve besparing doorrekenen (keuze eigenaar: beloningsregel); overgezette meters een mainnet-foto laten maken (botst met "testers hoeven niets opnieuw"); domeinlijst op testnet-`/health` kan vervuild worden (alleen informatief); HA-YAML in de handleiding met `!secret` (20 talen); `/wallet/seen` wordt bij het laden twee keer aangeroepen; meterLinks-plafond alleen relevant in de stand "iedereen"
- [x] Op een echte telefoon nagelopen door de eigenaar (27 november): maandrapport als pdf delen in VeWorld, en het bevestigingsvenster van "Vergeet deze telefoon" (Annuleren wist niets)
- [x] Windows-installatie van `gul.js` met `iwr -UseBasicParsing` (Windows 10, build 19045): door de eigenaar gedaan op 27 november. Zijn oude taak (van vóór 30 oktober) startte node zonder `conhost --headless` en opende elk uur een venster; opnieuw `--install` gaf de verborgen taak en stuurde meteen een stand
- [x] Verouderde helper: de app zegt het nu zelf, met de regel die hem bijwerkt (alleen die voor het eigen systeem als dat bekend is), bij een `gul.js` ouder dan 1.5.6 of zonder versie (vóór 1.5.3). Wie vóór 16 oktober installeerde had zijn meteradres (`--ip`/`--url`/`--tasmota`) alleen in de geplande taak; `--install` neemt het daar nu uit over (helper 1.5.7, add-on 1.5.7) (#222)

## Uitbetaling over te korte periodes (25 november)
- [x] De wekbeurt betaalde bij het einde van de wachttijd de stand die klaarlag, vaak een paar uur na de vorige opgenomen, terwijl de verse stand minuten later kwam: 0,36 en 0,16 B3TR voor 5 en 1 uur, en daartussen een afgetopte 4,00 over anderhalve dag. Een automatische uitbetaling wacht nu op een stand die minstens de wachttijd (20 uur, keuze eigenaar) na de vorige is opgenomen; de app zegt dan "betaald zodra de volgende stand binnenkomt" en toont geen claimknop (`AUTO_MIN_SPAN_MS`)

## Failmails en werkwijze (25 november)
- [x] Server tests faalde één keer op main: twee testbestanden kregen dezelfde vrije poort en een test sprak de nep-Redis van een ander aan. Ook de server zelf meldde bij een bezette poort "listening" en stopte stil (Express 5); nu stopt hij met een foutcode, en de tests wachten op hun eigen server (#213)
- [x] De branch werd tegelijk met een mislukte merge teruggezet, waardoor GitHub de PR sloot. Nu: `scripts/sync-after-merge.sh` weigert zolang de PR niet gemerged is, een hook blokkeert elke andere force-push, en `CLAUDE.md` legt de volgorde vast (#214)
- [x] Geen macOS-machine vrij bij GitHub: de job werd na 15 minuten afgebroken en Server tests (waar Render op wacht) faalde op een commit zonder bridge-wijziging. De Windows/macOS-tests draaien nu alleen bij PR's die de bridge raken (`bridge-desktop.yml`); Linux test de bridge nog bij elke commit (#215)
- [x] Eindcontrole vóór elk "klaar", ongevraagd: open punten, docs, nieuwe onderdelen echt gedraaid, geen mislukte runs, geen open PR's, alle talen, wat nog bij de eigenaar ligt (`CLAUDE.md`)

## Functies (25 november)
- [x] Badges: van 6 naar 12 (Op gang, Jaarrond, Alleskunner, Klimaatheld, Eerste tientje, Podium erbij); een vergrendelde badge toont hoe ver je bent ("23 / 100"), bovenaan "5 van 12 verdiend"; Klimaatheld gebruikt hetzelfde CO₂-getal als de tegel op Voortgang (#215)

## Bewust zo gelaten
- Tijdverschuiving bij automatische standen: geaccepteerd risico (zie `docs/MAINNET.md`)
- Captcha staat uit
- Twee app-versies delen één domein
- Gekleurde emoji in menu, intro en badges: keuze van de eigenaar (2026-11-01), lijn-iconen voelden te eentonig
