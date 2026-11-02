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
  - [ ] Nog Engels: foutmeldingen van de server, de Home Assistant-stappen bij Tibber/Powerfox (volgen HA's eigen menu's), het beheerscherm (alleen eigenaar)
- [x] Toegankelijkheid: dialogen met `role="dialog"`, focus erin, Tab blijft binnen, Escape sluit (#153)
- [ ] Bijsnijden met het toetsenbord (pijltjestoetsen)

## App — code
- [x] Voortgang en PDF tellen mislukte uitbetalingen mee; "bespaard" rekent met één dag i.p.v. de periode (#158)
- [x] Offline foto's: verstuurde, geweigerde en te oude (>14 dagen) worden opgeruimd; één databaseverbinding (#161)
- [x] Content-Security-Policy in `index.html` (alleen eigen scripts, inline-scripts per hash, jsPDF en captcha) (#161)
- [x] Bundel: bibliotheken in een eigen bestand (1,8 MB), app-code 396 KB — na een update alleen dat laatste opnieuw (#161)
- [ ] Beheerscherm, Help en koppelschermen pas laden als ze geopend worden (komt met het opsplitsen van `App.jsx`)
- [x] Geschiedenis van de chain samenvoegen met wat nu op het scherm staat (inzending tijdens laden verdwijnt) (#158)
- [x] "Pending" wordt nooit "failed" als de chain niets teruggeeft (#158)
- [x] Afteller van de cooldown loopt niet door (#158)
- [x] Klassement 2 min gedeeld tussen schermen; lezen tot een vast blok, dus geen dubbele telling meer (#161)
- [x] Standen zonder beloning staan alleen op het eigen toestel: laatste stand per meter van de server halen (#158)
- [ ] `App.jsx` (7.200 regels) opsplitsen: eerst pure logica, dan i18n, dan schermen
- [ ] Dode code opruimen (`sendAndEarn`, `Toggle`, `B3TR_USD`, `!REWARD_API`-takken, …)
- [ ] Privacy: apparaatkenmerk vermelden; Tesseract-taaldata zelf hosten
- [ ] Afhankelijkheden: vite 8, plugin-react 6, React 19; WalletConnect-meldingen via `overrides`

## Server en koppelingen
- [x] Transactie zonder ontvangstbewijs: elke minuut opnieuw gecontroleerd; na 15 min weg → melding voor de beheerder (#159)
- [x] `/health`: chain-gegevens 30 s gedeeld, één ronde aanroepen per keer (#160)
- [x] Tibber koppelen: thuis 2 min gereserveerd in de gedeelde opslag (twee processen tijdens een deploy) (#159)
- [x] `/reward-from-meter` zegt "niets gebruikt" als de boekhouding na een uitbetaling faalt (#159)
- [x] Time-outs op Enode (15 s) en R2 (30 s); Google Vision-sleutel in een header. Roboflow neemt zijn sleutel alleen in de URL: die URL wordt nergens gelogd (#160)
- [x] Snelheidslimiet per IPv6-/64 in plaats van per adres (#160)
- [ ] `index.js` (2.400 regels) opsplitsen; `/reward` en eco-resten delen één helper
- [ ] Tests voor: afsluiten met uitbetaling onderweg, `/admin/photo`, `/admin/move-rewards-pool`
- [x] Servertests hingen in CI na een poortbotsing; nu opnieuw starten en `--test-force-exit` (#159)
- [x] gul.js: versie in de `User-Agent` (server bewaart hem bij de stand), antwoorden max. 1 MB; een nu opgegeven `--ip` wint van een opgeslagen Tasmota/URL; add-on 1.5.3 (#160)
- [x] HA-add-on: instellingen en log in `/data` (`GUL_DATA_DIR`), versie 1.5.2 (#159)
- [ ] Afhankelijkheden server: express 5, @anthropic-ai/sdk, @vechain/sdk 2.1

## Product en organisatie
- [ ] Antwoord aan VeBetterDAO (beoordeling) versturen en opvolgen
- [ ] Creator NFT / endorsement afwachten
- [ ] Mainnet-stappen uit `docs/MAINNET.md` (Render-dienst, sleutels, `CERT_DOMAINS`, eerste week `MAX_PAYOUT_PER_SUBMISSION=1`)
- [ ] Grant-aanvraag VeBetter Grants (x2earn-spoor)
- [ ] Normen per land (nu één norm van 8 kWh per dag)
- [ ] Roadmap: gas en water, daarna zonnepanelen (staat in de server, uitgeschakeld)

## Bewust zo gelaten
- Tijdverschuiving bij automatische standen: geaccepteerd risico (zie `docs/MAINNET.md`)
- Captcha staat uit
- Twee app-versies delen één domein
- Gekleurde emoji in menu, intro en badges: keuze van de eigenaar (2026-11-01), lijn-iconen voelden te eentonig
