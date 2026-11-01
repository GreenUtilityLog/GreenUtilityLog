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

## Ronde 3 — afwerking ontwerp
- [ ] Emoji in menu, kop en badges vervangen door de bestaande `UI_ICONS` (SVG)
- [ ] Knoppen minimaal 44 px (wallet-knop, help, dubbeltarief-vinkje, taalkeuze, Sluiten, Retake)
- [ ] Invoervelden 16 px (iPhone zoomt nu in) en zichtbare focusrand (`:focus-visible`) — registratievelden al gedaan (#148)
- [ ] Formuliercontrast: randen, placeholders, foutkleur, "pending"-label
- [ ] Vaste lettergroottes (12/14/16/20/28/40) en kleuren als tokens
- [ ] Datums overal hetzelfde (`Intl.DateTimeFormat`)
- [ ] Geschiedenis: beloning als hoofdgetal, meternummer uit de rij
- [ ] Offline-melding als balk met uitleg in plaats van een rood stipje
- [ ] Computer: QR-code naar de app i.p.v. een actieve fotoknop die niets kan
- [ ] Klassement hoger in Voortgang; vergrendelde badges met slotje
- [ ] Intro: één voortgangsindicator, lijn-iconen, geen eindeloze animatie (`prefers-reduced-motion`)
- [ ] Wallet-keuzevenster: uitleg per optie; meldingen onderaan i.p.v. over knoppen
- [ ] `apple-touch-icon` en manifest; handleiding met logo, terugknop en inhoudsopgave
- [ ] Hele app vertalen (NL, DE, FR, ES), niet alleen Help; Help verwijst nu naar Engelse knopnamen
- [ ] Toegankelijkheid: dialogen met `role="dialog"`, focus erin, sluiten met Escape; bijsnijden met toetsenbord

## App — code
- [ ] Voortgang en PDF tellen mislukte uitbetalingen mee; "bespaard" rekent met één dag i.p.v. de periode
- [ ] Offline foto's blijven voor altijd in IndexedDB; één databaseverbinding
- [ ] Content-Security-Policy in `index.html`
- [ ] Bundel 2 MB: beheerscherm, Help en koppelschermen later laden
- [ ] Geschiedenis van de chain samenvoegen met een functionele update (inzending tijdens laden verdwijnt)
- [ ] "Pending" wordt nooit "failed" als de chain niets teruggeeft
- [ ] Afteller van de cooldown loopt niet door
- [ ] Klassement elke keer opnieuw geladen (tot 40 verzoeken); kan een uitbetaling dubbel tellen
- [ ] Standen zonder beloning staan alleen op het eigen toestel: laatste stand per meter van de server halen
- [ ] `App.jsx` (7.200 regels) opsplitsen: eerst pure logica, dan i18n, dan schermen
- [ ] Dode code opruimen (`sendAndEarn`, `Toggle`, `B3TR_USD`, `!REWARD_API`-takken, …)
- [ ] Privacy: apparaatkenmerk vermelden; Tesseract-taaldata zelf hosten
- [ ] Afhankelijkheden: vite 8, plugin-react 6, React 19; WalletConnect-meldingen via `overrides`

## Server en koppelingen
- [ ] Transactie zonder ontvangstbewijs wordt nooit opnieuw gecontroleerd
- [ ] `/health` doet 6 chain-aanroepen per keer zonder cache
- [ ] Tibber koppelen mist de reservering die Powerfox heeft (twee wallets tegelijk)
- [ ] `/reward-from-meter` zegt "niets gebruikt" als de boekhouding na een uitbetaling faalt
- [ ] Time-outs op Enode- en R2-aanroepen; Roboflow-sleutel niet in de URL
- [ ] Snelheidslimiet per IPv6-/64 in plaats van per adres
- [ ] `index.js` (2.400 regels) opsplitsen; `/reward` en eco-resten delen één helper
- [ ] Tests voor: afsluiten met uitbetaling onderweg, `/admin/photo`, `/admin/move-rewards-pool`
- [ ] gul.js: versie meesturen (`User-Agent`); antwoordgrootte begrenzen
- [ ] HA-add-on: instellingen in `/data` i.p.v. `/opt/bridge` (geheugen van laatste stand gaat nu verloren)
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
