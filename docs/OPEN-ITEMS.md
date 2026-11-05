# Openstaande punten

De vaste lijst van wat nog moet, uit de audits (code, ontwerp, server) en uit
gesprekken. Bijgewerkt bij elke PR die een punt afrondt: afgevinkt = klaar, met
het PR-nummer erbij. Nieuwe punten komen onderaan hun groep.

Laatst bijgewerkt: 2026-11-01.

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
- [ ] Nog open in `npm audit`: `decode-uri-component` via WalletConnect (`query-string` 7; de veilige versie is alleen ESM en breekt het) en `elliptic` in de Node-polyfills (laag) — wachten op een dapp-kit-update

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

## Kwaliteitsbewaking
- [x] Volledige browsertest in CI (`e2e/journey.mjs`, workflow "End-to-end"): echte app-build + echte server + ondertekenende nep-wallet; registreren, uitbetaling, Home/Geschiedenis/Voortgang, uitlezer, offline-wachtrij, Nederlands met servermelding. Faalt bij elke mislukte stap, paginafout of CSP-schending — gecontroleerd door de app en de server opzettelijk te breken (#169)

## Functies
- [x] VeBetterDAO GM NFT op Profiel, als badge onderin de accountkaart (naast de rol): plaatje, niveau (Earth … Galaxy), "niveau n van max" (max uit het contract) en tokennummer, rechtstreeks van de blockchain; zonder NFT een link naar VeBetterDAO, bij een onbereikbare node een melding in plaats van "geen NFT". Leest altijd van mainnet, ook in de testnet-versie, want daar staan de NFT's van gebruikers. Niveaunamen (Aarde … Melkweg) staan in de taal van de app. Op mainnet gecontroleerd door de eigenaar (Mercurius, niveau 3, #827, met plaatje).
- [x] Eigen app-niveaus (Maan, Zon, Ster, Goud, Platina) weggehaald: ze stonden naast de GM-niveaus met deels dezelfde namen. Voortgang toont nu je plek en je totaal Contractadressen en functies gecontroleerd tegen `@vechain/vebetterdao-contracts` 10.0.0 en `@vechain/vechain-kit`; in de browsertest

## Product en organisatie
- [ ] Antwoord aan VeBetterDAO (beoordeling) versturen en opvolgen
- [ ] Creator NFT / endorsement afwachten
- [ ] Mainnet-stappen uit `docs/MAINNET.md` (Render-dienst, sleutels, `CERT_DOMAINS`, eerste week `MAX_PAYOUT_PER_SUBMISSION=1`)
- [ ] Grant-aanvraag VeBetter Grants (x2earn-spoor)
- [ ] Normen per land (nu één norm van 8 kWh per dag)
- [x] Eigen app-niveaus terug, op aantal inzendingen (niet op B3TR): Druppel 💧 (0), Vonk ⚡ (50), Vlam 🔥 (200), Zonnestraal ☀️ (500), Groene centrale 🌍 (1000), geteld in dagen met een stand (meer meters gaat niet sneller); één ladder met water, stroom, gas en zon; eerst planten, op verzoek energie en strenger; op Home, Voortgang (met balk naar het volgende niveau) en Profiel
- [x] Voortgang: bespaarde energie per week/maand (met gemiddeld verbruik per dag t.o.v. de norm), inzendkalender van 12 weken, en een vooruitblik per jaar op basis van de laatste 30 dagen (na minstens een week)
- [x] Voortgang rekent met de besparing waarop de server uitbetaalde (ook als de telefoon de vorige stand niet kent) (#175)
- [x] Voortgang: volgend GM-niveau en hoeveel B3TR er nog nodig is (`getB3TRtoUpgrade` uit het GalaxyMember-contract, gecontroleerd tegen de broncode in `@vechain/vebetterdao-contracts`), met een link om op VeBetterDAO te upgraden
- [ ] Roadmap: gas en water, daarna zonnepanelen (staat in de server, uitgeschakeld)
- [x] Enode verwijderd: nooit ingeschakeld, betaald, en P1/Home Assistant/Powerfox/Tibber dekken het (#165)

## Later, als de app loopt (ideeën uit HangnDry, november)
- [ ] Klassement met "Deze week / Altijd" en een reeks-kolom (een nieuweling kan dan elke week meedoen)
- [ ] Live teller "Net uitbetaald +x B3TR · 1 min geleden" uit de chain
- [ ] Eenmalige B3TR-bonus per niveau (Vonk, Vlam, Zonnestraal, Groene centrale), met plafond, via de bestaande uitbetaling; bedragen nog kiezen
- [ ] Reeksbonus per week (bijv. +5–10%), binnen het weekbudget; anti-farming (één wallet per telefoon, meter, foto) moet overeind blijven
- [ ] Teller "x van y inzendingen deze week" / wachttijd zichtbaar op Home
- [ ] Mijlpaal-NFT's met eigen artwork (eigen contract + gas): pas na de B3TR-bonus
- [ ] Beloningsvermenigvuldiger op basis van VOT3-stemmen: eerst bij VeBetterDAO navragen of dat mag

## Bewust zo gelaten
- Tijdverschuiving bij automatische standen: geaccepteerd risico (zie `docs/MAINNET.md`)
- Captcha staat uit
- Twee app-versies delen één domein
- Gekleurde emoji in menu, intro en badges: keuze van de eigenaar (2026-11-01), lijn-iconen voelden te eentonig
