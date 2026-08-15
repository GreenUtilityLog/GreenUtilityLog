#!/usr/bin/env python3
# Generate the multilingual tester guide from one content source, so all five
# languages keep identical structure and only the prose differs.
import io, html

REPO = "https://github.com/GreenUtilityLog/GreenUtilityLog"
CLONE = "git clone https://github.com/GreenUtilityLog/GreenUtilityLog\ncd GreenUtilityLog/bridge"

L = {}

# ────────────────────────────────── ENGLISH ──────────────────────────────────
L["en"] = dict(
  name="English", kicker="Tester guide",
  h1="Earn without photographing your meter",
  lede="Normally you photograph your meter to earn B3TR. If something in your home can already read the meter, it can send the reading for you — and you never photograph again. Start by finding your setup below.",
  s_routes="Which setup do you have?",
  s_token="All automatic routes: get your token",
  s_a="Route A — Home Assistant (any meter)",
  s_b="Route B — HomeWizard P1, without Home Assistant",
  s_c="Route C — Another P1 reader",
  s_claim="Finally: claim it in the app",
  s_trouble="If something doesn't work",
  routes=[
    ("I use Home Assistant", "Works with almost any meter HA already reads. Install our add-on, or paste a few lines of YAML.", 1, "Easiest"),
    ("I have a HomeWizard P1", "No Home Assistant needed. A small helper finds your meter on the network by itself.", 2, "Some tech"),
    ("I have another P1 reader", "dsmr-reader, P1 Monitor, Shelly and friends — anything that serves its data as JSON.", 3, "Technical"),
    ("None of these", "Then keep photographing your meter. It works just as well and earns exactly the same. Nothing to set up.", 0, "No setup"),
  ],
  baseline_t="First, once: set your starting point",
  baseline_b="Whichever route you pick, do <strong>one normal photo submission</strong> in the app first. That tells the app where your meter started — without it, automatic readings can't be paid out.",
  token=[
    ("Copy your device token", 'In the app: <span class="k">Submit → ⚡ Have a P1 reader? → ⚙️ Automatic setup → “Get my device token”</span>. Copy it.',
     "What it is", 'A long code that says “these readings belong to my wallet”. Keep it private — anyone holding it can send readings in your name.'),
  ],
  a_intro="Two ways. Our integration is the easiest and works with <em>any</em> meter Home Assistant already shows you; the YAML does the same by hand if you'd rather not install anything.",
  a1_t='With our integration (recommended)',
  a1=[
    ('Add us to HACS', 'In Home Assistant: <span class="k">HACS → ⋮ (top right) → Custom repositories</span>. Paste the address below, choose type <strong>Integration</strong>, press Add.', 'code', 'https://github.com/GreenUtilityLog/GreenUtilityLog', 'Repository address'),
    ('Install and restart', 'Open <strong>GreenUtilityLog</strong> in the HACS list, press <strong>Download</strong>, then restart Home Assistant.', None, None, None),
    ('Add the integration', 'Go to <span class="k">Settings → Devices &amp; services → Add integration</span> and search for <strong>GreenUtilityLog</strong>. Paste your token, pick the sensor holding your <strong>cumulative kWh</strong>, and choose how often to send.', 'see', 'Check it worked', 'A sensor <span class="k">Last sent reading</span> appears with your meter total. Its attributes show the time it was sent and any error.'),
  ],
  a2_t="With your own sensor (any meter)",
  a2=[
    ("Find your meter sensor", 'In Home Assistant: <span class="k">Developer tools → States</span>. Filter on <em>import</em> and pick the one in kWh whose value keeps counting up — that is your total. Entity ids differ per install, so use yours.', None, None, None),
    ("Add these lines", 'Put this in <span class="k">configuration.yaml</span>, replacing the entity and your token, then restart Home Assistant.', "code",
     'rest_command:\n  gul_push:\n    url: "https://greenutilitylog-rewards.onrender.com/meter-ingest"\n    method: POST\n    content_type: "application/json"\n    payload: \'{"token":"YOUR_TOKEN","reading":{{ states("sensor.YOUR_ENTITY") | float }}}\'\n\n# automations.yaml — send once an hour\n- alias: Push meter to GreenUtilityLog\n  trigger: { platform: time_pattern, hours: "/1" }\n  action: { service: rest_command.gul_push }', "configuration.yaml + automations.yaml"),
  ],
  b=[
    ("Turn on the Local API", 'In the <strong>HomeWizard Energy</strong> app: <span class="k">Settings → Meters → your P1 → Local API → ON</span>. This lets your own network read the meter.', None, None, None),
    ("Open a terminal on a device that stays on", '<strong>Windows:</strong> press Start, type <em>PowerShell</em>. <strong>Mac:</strong> open <em>Terminal</em>. <strong>Pi / NAS:</strong> its terminal, or over SSH.', "see", "You need Node.js 18+", 'Not installed? Get it from nodejs.org first, or the command below won\'t run.'),
    ("Paste this, with your own token", 'Replace <span class="k">YOUR_TOKEN</span>, press Enter, and leave the window open.', "code", CLONE + "\nGUL_TOKEN=YOUR_TOKEN node index.js", "One-off setup"),
    ("Check it found the meter", 'You should see the meter being discovered and then pushed.', "see", "Expected output", '<span class="k">found HomeWizard at 192.168.…</span> then <span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  c_intro="The same helper reads any device that serves its data as JSON over HTTP — you just tell it where.",
  c=[
    ("Find your reader's data URL", 'Open your reader\'s web page and look for the address that returns raw JSON (often something like <span class="k">/api/v1/data</span> or <span class="k">/api/v2/sm/actual</span>). Exact paths differ per brand — check your reader\'s own documentation.', None, None, None),
    ("Start the helper with that URL", 'Replace the URL and your token. If the reading isn\'t found automatically, add <span class="k">READ_FIELD=</span> with the dot-path to the kWh value in that JSON.', "code",
     CLONE + "\nGUL_TOKEN=YOUR_TOKEN READ_URL=http://192.168.1.60/api/v1/data node index.js", "Any HTTP/JSON reader"),
    ("Check it worked", 'The helper prints what it pushed.', "see", "Expected output", '<span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  claim=[
    ("Your reading appears by itself", 'In the app open <strong>Submit</strong>. Under <strong>“Auto-received”</strong> you\'ll see your meter total and when it arrived.', None, None, None),
    ("Tap “Submit — no photo”", 'That\'s it. From now on your meter sends its reading every hour and you only claim it.', None, None, None),
  ],
  s_country='Does this work where you live?',
  country_intro="The socket on your meter differs per country, so not every reader works everywhere. What always works: <strong>if Home Assistant already shows your meter's total, Route A works</strong> — whatever country you're in.",
  country_th=('Country', 'Your meter has', 'What to use'),
  country_rows=[('🇳🇱 Netherlands', 'P1 port (RJ12)', 'Any route. HomeWizard works out of the box.'), ('🇧🇪 Belgium', 'P1 port (RJ12)', 'Same — plus the free Fluvius decryption key, once.'), ('🇱🇺 Luxembourg', 'P1 port (Dutch DSMR)', 'Same as the Netherlands.'), ('🇸🇪 Sweden · 🇫🇮 Finland', 'HAN port (RJ12)', 'A P1/HAN reader, or Home Assistant.'), ('🇩🇰 Denmark', 'HAN (pin header, encrypted)', 'A reader with the right connector, or Home Assistant.'), ('🇳🇴 Norway', 'HAN (RJ45, M-BUS)', 'A Norwegian HAN reader + Home Assistant.'), ('🇩🇪 Germany', 'Smart-Meter-Gateway / optical head', 'Home Assistant.'), ('Anywhere else', 'Varies', 'If Home Assistant reads your meter, Route A works.')],
  country_close="Not sure? Open Home Assistant and look for your meter under Developer tools → States. If a kWh value is there and counting up, you're set.",
  be_t="🇧🇪 Belgium (Fluvius meters)",
  be_b="Digital Fluvius meters send encrypted data. Ask Fluvius for your free decryption key and enter it once in your reader's app — after that everything works the same.",
  th=("You see", "What to do"),
  trouble=[
    ("No HomeWizard found", 'Your network blocks auto-discovery. Find your P1\'s IP in the HomeWizard app and set <span class="k">hw_ip</span> (add-on) or add <span class="k">HW_IP=192.168.1.50</span> before the command.'),
    ("couldn't find a total import kWh", 'The reader returned JSON the helper didn\'t recognise. Set <span class="k">READ_FIELD</span> to the dot-path of the cumulative kWh value.'),
    ("Nothing under “Auto-received”", 'Check the token is pasted correctly and the helper is still running on the same network as the meter.'),
    ("the automatic reading is stale", 'A reading must be under 48 hours old to pay out — make sure the add-on or terminal is still running.'),
    ("submit one photo reading first", 'You skipped the starting point. Do one normal photo submission, then try again.'),
  ],
  close="Still stuck? Send a message with what the Log tab (or terminal) shows — it usually says exactly what's missing.",
  foot="GreenUtilityLog · Tester guide · Testnet beta — test tokens, no real-world value yet.",
)

# ──────────────────────────────── NEDERLANDS ─────────────────────────────────
L["nl"] = dict(
  name="Nederlands", kicker="Testershandleiding",
  h1="Verdien zonder je meter te fotograferen",
  lede="Normaal fotografeer je je meter om B3TR te verdienen. Kan er thuis al iets je meter uitlezen, dan stuurt dát de stand door — en hoef jij nooit meer te fotograferen. Zoek hieronder je situatie op.",
  s_routes="Welke situatie heb jij?",
  s_token="Alle automatische routes: haal je token op",
  s_a="Route A — Home Assistant (elke meter)",
  s_b="Route B — HomeWizard P1, zonder Home Assistant",
  s_c="Route C — Een andere P1-reader",
  s_claim="Tot slot: claimen in de app",
  s_trouble="Als er iets niet werkt",
  routes=[
    ("Ik gebruik Home Assistant", "Werkt met vrijwel elke meter die HA al uitleest. Installeer onze add-on, of plak een paar regels YAML.", 1, "Makkelijkst"),
    ("Ik heb een HomeWizard P1", "Geen Home Assistant nodig. Een klein hulpprogramma vindt je meter zelf op het netwerk.", 2, "Beetje techniek"),
    ("Ik heb een andere P1-reader", "dsmr-reader, P1 Monitor, Shelly en dergelijke — alles wat z’n data als JSON aanbiedt.", 3, "Technisch"),
    ("Geen van deze", "Blijf dan je meter fotograferen. Dat werkt net zo goed en levert precies hetzelfde op. Niets in te stellen.", 0, "Niets instellen"),
  ],
  baseline_t="Eerst, eenmalig: zet je startpunt",
  baseline_b="Welke route je ook kiest, doe eerst <strong>één gewone foto-inzending</strong> in de app. Daarmee weet de app waar je meter begon — zonder dat kunnen automatische standen niet uitbetalen.",
  token=[
    ("Kopieer je device-token", 'In de app: <span class="k">Submit → ⚡ Have a P1 reader? → ⚙️ Automatic setup → “Get my device token”</span>. Kopieer ’m.',
     "Wat het is", 'Een lange code die zegt: “deze standen horen bij mijn wallet”. Houd ’m privé — wie ’m heeft kan standen op jouw naam insturen.'),
  ],
  a_intro='Twee manieren. Onze integratie is de makkelijkste en werkt met <em>elke</em> meter die Home Assistant al toont; de YAML doet hetzelfde handmatig als je liever niets installeert.',
  a1_t='Met onze integratie (aanbevolen)',
  a1=[
    ('Voeg ons toe aan HACS', 'In Home Assistant: <span class="k">HACS → ⋮ (rechtsboven) → Custom repositories</span>. Plak het adres hieronder, kies type <strong>Integration</strong>, klik Add.', 'code', 'https://github.com/GreenUtilityLog/GreenUtilityLog', 'Adres van de bron'),
    ('Installeren en herstarten', 'Open <strong>GreenUtilityLog</strong> in de HACS-lijst, klik <strong>Download</strong> en herstart Home Assistant.', None, None, None),
    ('Integratie toevoegen', 'Ga naar <span class="k">Instellingen → Apparaten &amp; diensten → Integratie toevoegen</span> en zoek <strong>GreenUtilityLog</strong>. Plak je token, kies de sensor met je <strong>cumulatieve kWh</strong>, en stel in hoe vaak er verstuurd wordt.', 'see', 'Controleren of het werkt', 'Er verschijnt een sensor <span class="k">Last sent reading</span> met je meterstand. In de attributen zie je het tijdstip en een eventuele fout.'),
  ],
  a2_t="Met je eigen sensor (elke meter)",
  a2=[
    ("Zoek je meter-sensor op", 'In Home Assistant: <span class="k">Ontwikkelhulpmiddelen → Statussen</span>. Filter op <em>import</em> en pak degene in kWh waarvan de waarde blijft oplopen — dat is je totaalstand. Entity-ID’s verschillen per installatie, dus gebruik die van jou.', None, None, None),
    ("Voeg deze regels toe", 'Zet dit in <span class="k">configuration.yaml</span>, vervang de entity en je token, en herstart Home Assistant.', "code",
     'rest_command:\n  gul_push:\n    url: "https://greenutilitylog-rewards.onrender.com/meter-ingest"\n    method: POST\n    content_type: "application/json"\n    payload: \'{"token":"JOUW_TOKEN","reading":{{ states("sensor.JOUW_ENTITY") | float }}}\'\n\n# automations.yaml — stuur elk uur\n- alias: Push meter to GreenUtilityLog\n  trigger: { platform: time_pattern, hours: "/1" }\n  action: { service: rest_command.gul_push }', "configuration.yaml + automations.yaml"),
  ],
  b=[
    ("Zet de Local API aan", 'In de <strong>HomeWizard Energy</strong>-app: <span class="k">Instellingen → Meters → je P1 → Local API → AAN</span>. Hiermee mag je eigen netwerk de meter uitlezen.', None, None, None),
    ("Open een terminal op een apparaat dat aan blijft", '<strong>Windows:</strong> druk op Start, typ <em>PowerShell</em>. <strong>Mac:</strong> open <em>Terminal</em>. <strong>Pi / NAS:</strong> de terminal daar, of via SSH.', "see", "Je hebt Node.js 18+ nodig", 'Niet geïnstalleerd? Haal het eerst van nodejs.org, anders werkt het commando niet.'),
    ("Plak dit, met je eigen token", 'Vervang <span class="k">JOUW_TOKEN</span>, druk op Enter en laat het venster openstaan.', "code", CLONE + "\nGUL_TOKEN=JOUW_TOKEN node index.js", "Eenmalig instellen"),
    ("Controleer of hij de meter vond", 'Je hoort te zien dat de meter gevonden en verstuurd wordt.', "see", "Dit hoor je te zien", '<span class="k">found HomeWizard at 192.168.…</span> en daarna <span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  c_intro="Hetzelfde hulpprogramma leest elk apparaat dat z’n data als JSON via HTTP aanbiedt — je zegt alleen waar.",
  c=[
    ("Zoek de data-URL van je reader", 'Open de webpagina van je reader en zoek het adres dat ruwe JSON teruggeeft (vaak zoiets als <span class="k">/api/v1/data</span> of <span class="k">/api/v2/sm/actual</span>). Exacte paden verschillen per merk — kijk in de documentatie van je reader.', None, None, None),
    ("Start het hulpprogramma met die URL", 'Vervang de URL en je token. Wordt de stand niet automatisch gevonden, zet er dan <span class="k">READ_FIELD=</span> bij met het pad naar de kWh-waarde in die JSON.', "code",
     CLONE + "\nGUL_TOKEN=JOUW_TOKEN READ_URL=http://192.168.1.60/api/v1/data node index.js", "Elke HTTP/JSON-reader"),
    ("Controleer of het werkte", 'Het hulpprogramma laat zien wat het verstuurd heeft.', "see", "Dit hoor je te zien", '<span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  claim=[
    ("Je stand verschijnt vanzelf", 'Ga in de app naar <strong>Submit</strong>. Onder <strong>“Auto-received”</strong> zie je je meterstand en hoe laat die binnenkwam.', None, None, None),
    ("Tik op “Submit — no photo”", 'Klaar. Vanaf nu stuurt je meter elk uur z\'n stand en hoef jij alleen te claimen.', None, None, None),
  ],
  s_country='Werkt dit ook in jouw land?',
  country_intro='De aansluiting op je meter verschilt per land, dus niet elke reader werkt overal. Wat altijd werkt: <strong>toont Home Assistant je meterstand al, dan werkt Route A</strong> — in welk land je ook zit.',
  country_th=('Land', 'Jouw meter heeft', 'Wat je gebruikt'),
  country_rows=[('🇳🇱 Nederland', 'P1-poort (RJ12)', 'Elke route. HomeWizard werkt direct.'), ('🇧🇪 België', 'P1-poort (RJ12)', 'Hetzelfde — plus eenmalig de gratis Fluvius-sleutel.'), ('🇱🇺 Luxemburg', 'P1-poort (Nederlandse DSMR)', 'Hetzelfde als Nederland.'), ('🇸🇪 Zweden · 🇫🇮 Finland', 'HAN-poort (RJ12)', 'Een P1/HAN-reader, of Home Assistant.'), ('🇩🇰 Denemarken', 'HAN (pin-header, versleuteld)', 'Een reader met de juiste connector, of Home Assistant.'), ('🇳🇴 Noorwegen', 'HAN (RJ45, M-BUS)', 'Een Noorse HAN-reader + Home Assistant.'), ('🇩🇪 Duitsland', 'Smart-Meter-Gateway / optische kop', 'Home Assistant.'), ('Elders', 'Verschilt', 'Leest Home Assistant je meter, dan werkt Route A.')],
  country_close='Niet zeker? Open Home Assistant en zoek je meter onder Ontwikkelhulpmiddelen → Statussen. Staat er een kWh-waarde die oploopt, dan zit je goed.',
  be_t="🇧🇪 België (Fluvius-meters)",
  be_b="Digitale Fluvius-meters sturen versleutelde data. Vraag bij Fluvius je gratis decryptiesleutel op en voer die één keer in de app van je reader in — daarna werkt alles hetzelfde.",
  th=("Je ziet", "Wat te doen"),
  trouble=[
    ("No HomeWizard found", 'Je netwerk blokkeert auto-detectie. Zoek het IP van je P1 in de HomeWizard-app en vul <span class="k">hw_ip</span> in (add-on) of zet <span class="k">HW_IP=192.168.1.50</span> vóór het commando.'),
    ("couldn't find a total import kWh", 'De reader gaf JSON terug die het hulpprogramma niet herkende. Zet <span class="k">READ_FIELD</span> op het pad naar de cumulatieve kWh-waarde.'),
    ("Niets onder “Auto-received”", 'Controleer of de token goed geplakt is en of het hulpprogramma nog draait op hetzelfde netwerk als de meter.'),
    ("the automatic reading is stale", 'Een stand moet jonger dan 48 uur zijn om uit te betalen — zorg dat de add-on of terminal nog draait.'),
    ("submit one photo reading first", 'Je hebt het startpunt overgeslagen. Doe één gewone foto-inzending en probeer opnieuw.'),
  ],
  close="Kom je er niet uit? Stuur een berichtje met wat er in het Log-tabblad (of de terminal) staat — daar staat meestal precies wat er mist.",
  foot="GreenUtilityLog · Testershandleiding · Testnet-beta — test-tokens, nog geen echte waarde.",
)

# ────────────────────────────────── DEUTSCH ──────────────────────────────────
L["de"] = dict(
  name="Deutsch", kicker="Tester-Anleitung",
  h1="Verdienen, ohne den Zähler zu fotografieren",
  lede="Normalerweise fotografierst du deinen Zähler, um B3TR zu verdienen. Kann bei dir zu Hause schon etwas den Zähler auslesen, sendet das den Stand für dich — und du fotografierst nie wieder. Such unten deine Situation.",
  s_routes="Welche Situation hast du?",
  s_token="Alle automatischen Routen: Token holen",
  s_a="Route A — Home Assistant (jeder Zähler)",
  s_b="Route B — HomeWizard P1, ohne Home Assistant",
  s_c="Route C — Ein anderer P1-Reader",
  s_claim="Zum Schluss: in der App einlösen",
  s_trouble="Wenn etwas nicht klappt",
  routes=[
    ("Ich nutze Home Assistant", "Funktioniert mit fast jedem Zähler, den HA schon ausliest. Installiere unser Add-on oder füge ein paar Zeilen YAML ein.", 1, "Am einfachsten"),
    ("Ich habe einen HomeWizard P1", "Kein Home Assistant nötig. Ein kleines Hilfsprogramm findet deinen Zähler selbst im Netzwerk.", 2, "Etwas Technik"),
    ("Ich habe einen anderen P1-Reader", "dsmr-reader, P1 Monitor, Shelly und Co. — alles, was seine Daten als JSON anbietet.", 3, "Technisch"),
    ("Nichts davon", "Dann fotografiere deinen Zähler weiter. Das funktioniert genauso gut und bringt exakt dasselbe. Nichts einzurichten.", 0, "Nichts einrichten"),
  ],
  baseline_t="Zuerst, einmalig: Startpunkt setzen",
  baseline_b="Egal welche Route: mach zuerst <strong>eine normale Foto-Einreichung</strong> in der App. Damit weiß die App, wo dein Zähler startete — sonst können automatische Stände nicht ausgezahlt werden.",
  token=[
    ("Geräte-Token kopieren", 'In der App: <span class="k">Submit → ⚡ Have a P1 reader? → ⚙️ Automatic setup → „Get my device token“</span>. Kopieren.',
     "Was das ist", 'Ein langer Code, der sagt: „diese Stände gehören zu meinem Wallet“. Halte ihn privat — wer ihn hat, kann Stände in deinem Namen senden.'),
  ],
  a_intro='Zwei Wege. Unsere Integration ist am einfachsten und funktioniert mit <em>jedem</em> Zähler, den Home Assistant schon anzeigt; das YAML macht dasselbe von Hand, falls du nichts installieren willst.',
  a1_t='Mit unserer Integration (empfohlen)',
  a1=[
    ('Uns zu HACS hinzufügen', 'In Home Assistant: <span class="k">HACS → ⋮ (oben rechts) → Custom repositories</span>. Adresse unten einfügen, Typ <strong>Integration</strong> wählen, Add drücken.', 'code', 'https://github.com/GreenUtilityLog/GreenUtilityLog', 'Repository-Adresse'),
    ('Installieren und neu starten', 'Öffne <strong>GreenUtilityLog</strong> in der HACS-Liste, drücke <strong>Download</strong> und starte Home Assistant neu.', None, None, None),
    ('Integration hinzufügen', 'Geh zu <span class="k">Einstellungen → Geräte &amp; Dienste → Integration hinzufügen</span> und such <strong>GreenUtilityLog</strong>. Token einfügen, den Sensor mit deinem <strong>kumulativen kWh</strong>-Wert wählen und das Intervall einstellen.', 'see', 'Prüfen, ob es klappt', 'Ein Sensor <span class="k">Last sent reading</span> erscheint mit deinem Zählerstand. Die Attribute zeigen Zeitpunkt und etwaige Fehler.'),
  ],
  a2_t="Mit deinem eigenen Sensor (jeder Zähler)",
  a2=[
    ("Deinen Zähler-Sensor finden", 'In Home Assistant: <span class="k">Entwicklerwerkzeuge → Zustände</span>. Nach <em>import</em> filtern und den in kWh nehmen, dessen Wert weiter hochzählt — das ist dein Gesamtstand. Entity-IDs unterscheiden sich pro Installation, nimm also deine.', None, None, None),
    ("Diese Zeilen hinzufügen", 'Trag das in <span class="k">configuration.yaml</span> ein, ersetze Entity und Token, und starte Home Assistant neu.', "code",
     'rest_command:\n  gul_push:\n    url: "https://greenutilitylog-rewards.onrender.com/meter-ingest"\n    method: POST\n    content_type: "application/json"\n    payload: \'{"token":"DEIN_TOKEN","reading":{{ states("sensor.DEINE_ENTITY") | float }}}\'\n\n# automations.yaml — stündlich senden\n- alias: Push meter to GreenUtilityLog\n  trigger: { platform: time_pattern, hours: "/1" }\n  action: { service: rest_command.gul_push }', "configuration.yaml + automations.yaml"),
  ],
  b=[
    ("Local API aktivieren", 'In der <strong>HomeWizard Energy</strong>-App: <span class="k">Einstellungen → Zähler → dein P1 → Local API → EIN</span>. Damit darf dein Netzwerk den Zähler auslesen.', None, None, None),
    ("Terminal auf einem Dauergerät öffnen", '<strong>Windows:</strong> Start drücken, <em>PowerShell</em> tippen. <strong>Mac:</strong> <em>Terminal</em> öffnen. <strong>Pi / NAS:</strong> dessen Terminal oder per SSH.', "see", "Du brauchst Node.js 18+", 'Nicht installiert? Erst von nodejs.org holen, sonst läuft der Befehl nicht.'),
    ("Das hier einfügen, mit deinem Token", 'Ersetze <span class="k">DEIN_TOKEN</span>, drücke Enter und lass das Fenster offen.', "code", CLONE + "\nGUL_TOKEN=DEIN_TOKEN node index.js", "Einmalige Einrichtung"),
    ("Prüfen, ob er den Zähler fand", 'Du solltest sehen, wie der Zähler gefunden und gesendet wird.', "see", "Erwartete Ausgabe", '<span class="k">found HomeWizard at 192.168.…</span> und danach <span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  c_intro="Dasselbe Hilfsprogramm liest jedes Gerät, das seine Daten als JSON über HTTP anbietet — du sagst ihm nur wo.",
  c=[
    ("Die Daten-URL deines Readers finden", 'Öffne die Weboberfläche deines Readers und such die Adresse, die rohes JSON zurückgibt (oft etwas wie <span class="k">/api/v1/data</span> oder <span class="k">/api/v2/sm/actual</span>). Die genauen Pfade unterscheiden sich je Marke — schau in die Doku deines Readers.', None, None, None),
    ("Hilfsprogramm mit dieser URL starten", 'Ersetze URL und Token. Wird der Stand nicht automatisch gefunden, ergänze <span class="k">READ_FIELD=</span> mit dem Pfad zum kWh-Wert in diesem JSON.', "code",
     CLONE + "\nGUL_TOKEN=DEIN_TOKEN READ_URL=http://192.168.1.60/api/v1/data node index.js", "Jeder HTTP/JSON-Reader"),
    ("Prüfen, ob es klappte", 'Das Hilfsprogramm zeigt, was es gesendet hat.', "see", "Erwartete Ausgabe", '<span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  claim=[
    ("Dein Stand erscheint von selbst", 'Geh in der App auf <strong>Submit</strong>. Unter <strong>„Auto-received“</strong> siehst du deinen Zählerstand und wann er ankam.', None, None, None),
    ("Auf „Submit — no photo“ tippen", 'Fertig. Ab jetzt sendet dein Zähler stündlich seinen Stand und du löst nur noch ein.', None, None, None),
  ],
  s_country='Funktioniert das in deinem Land?',
  country_intro='Der Anschluss am Zähler unterscheidet sich je Land, nicht jeder Reader passt überall. Was immer geht: <strong>zeigt Home Assistant deinen Zählerstand bereits, funktioniert Route A</strong> — egal in welchem Land.',
  country_th=('Land', 'Dein Zähler hat', 'Was du nutzt'),
  country_rows=[('🇳🇱 Niederlande', 'P1-Port (RJ12)', 'Jede Route. HomeWizard läuft direkt.'), ('🇧🇪 Belgien', 'P1-Port (RJ12)', 'Genauso — plus einmalig den kostenlosen Fluvius-Schlüssel.'), ('🇱🇺 Luxemburg', 'P1-Port (niederländischer DSMR)', 'Wie in den Niederlanden.'), ('🇸🇪 Schweden · 🇫🇮 Finnland', 'HAN-Port (RJ12)', 'Ein P1/HAN-Reader, oder Home Assistant.'), ('🇩🇰 Dänemark', 'HAN (Pin-Header, verschlüsselt)', 'Ein Reader mit passendem Stecker, oder Home Assistant.'), ('🇳🇴 Norwegen', 'HAN (RJ45, M-BUS)', 'Ein norwegischer HAN-Reader + Home Assistant.'), ('🇩🇪 Deutschland', 'Smart-Meter-Gateway / Lesekopf', 'Home Assistant.'), ('Anderswo', 'Unterschiedlich', 'Liest Home Assistant deinen Zähler, funktioniert Route A.')],
  country_close='Unsicher? Öffne Home Assistant und such deinen Zähler unter Entwicklerwerkzeuge → Zustände. Steht dort ein kWh-Wert, der hochzählt, passt es.',
  be_t="🇧🇪 Belgien (Fluvius-Zähler)",
  be_b="Digitale Fluvius-Zähler senden verschlüsselt. Frag bei Fluvius deinen kostenlosen Entschlüsselungscode an und gib ihn einmal in der App deines Readers ein — danach läuft alles gleich.",
  th=("Du siehst", "Was tun"),
  trouble=[
    ("No HomeWizard found", 'Dein Netzwerk blockiert die Erkennung. IP deines P1 in der HomeWizard-App suchen und <span class="k">hw_ip</span> setzen (Add-on) oder <span class="k">HW_IP=192.168.1.50</span> vor den Befehl.'),
    ("couldn't find a total import kWh", 'Der Reader lieferte JSON, das nicht erkannt wurde. Setz <span class="k">READ_FIELD</span> auf den Pfad zum kumulativen kWh-Wert.'),
    ("Nichts unter „Auto-received“", 'Prüfe, ob der Token korrekt eingefügt ist und das Hilfsprogramm noch im selben Netzwerk wie der Zähler läuft.'),
    ("the automatic reading is stale", 'Ein Stand muss jünger als 48 Stunden sein — Add-on bzw. Terminal muss laufen.'),
    ("submit one photo reading first", 'Der Startpunkt fehlt. Mach eine normale Foto-Einreichung und versuch es erneut.'),
  ],
  close="Kommst du nicht weiter? Schick eine Nachricht mit dem Inhalt des Protokoll-Tabs (oder Terminals) — dort steht meist genau, was fehlt.",
  foot="GreenUtilityLog · Tester-Anleitung · Testnet-Beta — Test-Token, noch kein realer Wert.",
)

# ────────────────────────────────── FRANÇAIS ─────────────────────────────────
L["fr"] = dict(
  name="Français", kicker="Guide testeur",
  h1="Gagnez sans photographier votre compteur",
  lede="Normalement vous photographiez votre compteur pour gagner des B3TR. Si quelque chose chez vous sait déjà lire le compteur, il peut envoyer le relevé à votre place — et vous ne photographiez plus jamais. Trouvez votre cas ci-dessous.",
  s_routes="Quelle est votre situation ?",
  s_token="Toutes les routes automatiques : récupérez votre jeton",
  s_a="Route A — Home Assistant (tout compteur)",
  s_b="Route B — HomeWizard P1, sans Home Assistant",
  s_c="Route C — Un autre lecteur P1",
  s_claim="Enfin : réclamez dans l'app",
  s_trouble="Si ça ne marche pas",
  routes=[
    ("J'utilise Home Assistant", "Fonctionne avec presque tout compteur que HA lit déjà. Installez notre add-on, ou collez quelques lignes de YAML.", 1, "Le plus simple"),
    ("J'ai un HomeWizard P1", "Pas besoin de Home Assistant. Un petit utilitaire trouve votre compteur tout seul sur le réseau.", 2, "Un peu technique"),
    ("J'ai un autre lecteur P1", "dsmr-reader, P1 Monitor, Shelly et compagnie — tout ce qui expose ses données en JSON.", 3, "Technique"),
    ("Aucun des deux", "Continuez à photographier votre compteur. Ça marche aussi bien et rapporte exactement pareil. Rien à configurer.", 0, "Rien à faire"),
  ],
  baseline_t="D'abord, une fois : fixez votre point de départ",
  baseline_b="Quelle que soit la route, faites d'abord <strong>une soumission photo normale</strong> dans l'app. L'app sait ainsi où votre compteur a démarré — sinon les relevés automatiques ne peuvent pas être payés.",
  token=[
    ("Copiez votre jeton", 'Dans l\'app : <span class="k">Submit → ⚡ Have a P1 reader? → ⚙️ Automatic setup → « Get my device token »</span>. Copiez-le.',
     "Ce que c'est", 'Un long code qui dit « ces relevés appartiennent à mon wallet ». Gardez-le privé — celui qui l\'a peut envoyer des relevés en votre nom.'),
  ],
  a_intro="Deux façons. Notre intégration est la plus simple et fonctionne avec <em>n'importe quel</em> compteur que Home Assistant affiche déjà ; le YAML fait la même chose à la main si vous préférez ne rien installer.",
  a1_t='Avec notre intégration (recommandé)',
  a1=[
    ('Ajoutez-nous à HACS', 'Dans Home Assistant : <span class="k">HACS → ⋮ (en haut à droite) → Custom repositories</span>. Collez l\'adresse ci-dessous, choisissez le type <strong>Integration</strong>, appuyez sur Add.', 'code', 'https://github.com/GreenUtilityLog/GreenUtilityLog', 'Adresse du dépôt'),
    ('Installez et redémarrez', 'Ouvrez <strong>GreenUtilityLog</strong> dans la liste HACS, appuyez sur <strong>Download</strong>, puis redémarrez Home Assistant.', None, None, None),
    ("Ajoutez l'intégration", 'Allez dans <span class="k">Paramètres → Appareils et services → Ajouter une intégration</span> et cherchez <strong>GreenUtilityLog</strong>. Collez votre jeton, choisissez le capteur contenant vos <strong>kWh cumulés</strong>, et réglez la fréquence.', 'see', 'Vérifiez', 'Un capteur <span class="k">Last sent reading</span> apparaît avec votre relevé. Ses attributs indiquent l\'heure d\'envoi et toute erreur.'),
  ],
  a2_t="Avec votre propre capteur (tout compteur)",
  a2=[
    ("Trouvez le capteur de votre compteur", 'Dans Home Assistant : <span class="k">Outils de développement → États</span>. Filtrez sur <em>import</em> et prenez celui en kWh dont la valeur continue de monter — c\'est votre total. Les identifiants diffèrent par installation, utilisez le vôtre.', None, None, None),
    ("Ajoutez ces lignes", 'Mettez ceci dans <span class="k">configuration.yaml</span>, remplacez l\'entité et votre jeton, puis redémarrez Home Assistant.', "code",
     'rest_command:\n  gul_push:\n    url: "https://greenutilitylog-rewards.onrender.com/meter-ingest"\n    method: POST\n    content_type: "application/json"\n    payload: \'{"token":"VOTRE_JETON","reading":{{ states("sensor.VOTRE_ENTITE") | float }}}\'\n\n# automations.yaml — envoyer chaque heure\n- alias: Push meter to GreenUtilityLog\n  trigger: { platform: time_pattern, hours: "/1" }\n  action: { service: rest_command.gul_push }', "configuration.yaml + automations.yaml"),
  ],
  b=[
    ("Activez l'API locale", 'Dans l\'app <strong>HomeWizard Energy</strong> : <span class="k">Réglages → Compteurs → votre P1 → Local API → ON</span>. Votre réseau peut alors lire le compteur.', None, None, None),
    ("Ouvrez un terminal sur un appareil qui reste allumé", '<strong>Windows :</strong> Démarrer, tapez <em>PowerShell</em>. <strong>Mac :</strong> ouvrez <em>Terminal</em>. <strong>Pi / NAS :</strong> son terminal, ou en SSH.', "see", "Il vous faut Node.js 18+", 'Pas installé ? Prenez-le sur nodejs.org, sinon la commande ne marchera pas.'),
    ("Collez ceci, avec votre jeton", 'Remplacez <span class="k">VOTRE_JETON</span>, appuyez sur Entrée et laissez la fenêtre ouverte.', "code", CLONE + "\nGUL_TOKEN=VOTRE_JETON node index.js", "Configuration unique"),
    ("Vérifiez qu'il a trouvé le compteur", 'Vous devriez voir le compteur détecté puis envoyé.', "see", "Sortie attendue", '<span class="k">found HomeWizard at 192.168.…</span> puis <span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  c_intro="Le même utilitaire lit tout appareil qui expose ses données en JSON via HTTP — vous lui dites simplement où.",
  c=[
    ("Trouvez l'URL de données de votre lecteur", 'Ouvrez la page web de votre lecteur et cherchez l\'adresse qui renvoie du JSON brut (souvent <span class="k">/api/v1/data</span> ou <span class="k">/api/v2/sm/actual</span>). Les chemins exacts diffèrent selon la marque — consultez la doc de votre lecteur.', None, None, None),
    ("Lancez l'utilitaire avec cette URL", 'Remplacez l\'URL et votre jeton. Si le relevé n\'est pas trouvé automatiquement, ajoutez <span class="k">READ_FIELD=</span> avec le chemin vers la valeur kWh dans ce JSON.', "code",
     CLONE + "\nGUL_TOKEN=VOTRE_JETON READ_URL=http://192.168.1.60/api/v1/data node index.js", "Tout lecteur HTTP/JSON"),
    ("Vérifiez que ça a marché", 'L\'utilitaire affiche ce qu\'il a envoyé.', "see", "Sortie attendue", '<span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  claim=[
    ("Votre relevé apparaît tout seul", 'Dans l\'app, allez sur <strong>Submit</strong>. Sous <strong>« Auto-received »</strong> vous voyez votre relevé et l\'heure d\'arrivée.', None, None, None),
    ("Touchez « Submit — no photo »", 'C\'est tout. Votre compteur envoie son relevé chaque heure et vous n\'avez plus qu\'à réclamer.', None, None, None),
  ],
  s_country='Est-ce que ça marche chez vous ?',
  country_intro='La prise de votre compteur diffère selon le pays, donc tous les lecteurs ne fonctionnent pas partout. Ce qui marche toujours : <strong>si Home Assistant affiche déjà votre relevé, la Route A fonctionne</strong> — quel que soit le pays.',
  country_th=('Pays', 'Votre compteur a', 'Quoi utiliser'),
  country_rows=[('🇳🇱 Pays-Bas', 'Port P1 (RJ12)', 'Toutes les routes. HomeWizard marche directement.'), ('🇧🇪 Belgique', 'Port P1 (RJ12)', 'Pareil — plus la clé Fluvius gratuite, une fois.'), ('🇱🇺 Luxembourg', 'Port P1 (DSMR néerlandais)', 'Comme aux Pays-Bas.'), ('🇸🇪 Suède · 🇫🇮 Finlande', 'Port HAN (RJ12)', 'Un lecteur P1/HAN, ou Home Assistant.'), ('🇩🇰 Danemark', 'HAN (connecteur à broches, chiffré)', 'Un lecteur au bon connecteur, ou Home Assistant.'), ('🇳🇴 Norvège', 'HAN (RJ45, M-BUS)', 'Un lecteur HAN norvégien + Home Assistant.'), ('🇩🇪 Allemagne', 'Smart-Meter-Gateway / tête optique', 'Home Assistant.'), ('Ailleurs', 'Variable', 'Si Home Assistant lit votre compteur, la Route A marche.')],
  country_close="Pas sûr ? Ouvrez Home Assistant et cherchez votre compteur dans Outils de développement → États. Si une valeur en kWh monte, c'est bon.",
  be_t="🇧🇪 Belgique (compteurs Fluvius)",
  be_b="Les compteurs Fluvius numériques envoient des données chiffrées. Demandez votre clé gratuite à Fluvius et saisissez-la une fois dans l'app de votre lecteur — ensuite tout fonctionne pareil.",
  th=("Vous voyez", "Que faire"),
  trouble=[
    ("No HomeWizard found", 'Votre réseau bloque la détection. Trouvez l\'IP de votre P1 dans l\'app HomeWizard et renseignez <span class="k">hw_ip</span> (add-on) ou <span class="k">HW_IP=192.168.1.50</span> avant la commande.'),
    ("couldn't find a total import kWh", 'Le lecteur a renvoyé du JSON non reconnu. Réglez <span class="k">READ_FIELD</span> sur le chemin de la valeur kWh cumulée.'),
    ("Rien sous « Auto-received »", 'Vérifiez que le jeton est bien collé et que l\'utilitaire tourne toujours sur le même réseau que le compteur.'),
    ("the automatic reading is stale", 'Un relevé doit avoir moins de 48 h — l\'add-on ou le terminal doit tourner.'),
    ("submit one photo reading first", 'Le point de départ manque. Faites une soumission photo normale, puis réessayez.'),
  ],
  close="Toujours bloqué ? Envoyez un message avec le contenu de l'onglet Journal (ou du terminal) — il dit généralement exactement ce qui manque.",
  foot="GreenUtilityLog · Guide testeur · Bêta testnet — jetons de test, sans valeur réelle.",
)

# ─────────────────────────────────── ESPAÑOL ─────────────────────────────────
L["es"] = dict(
  name="Español", kicker="Guía para testers",
  h1="Gana sin fotografiar tu contador",
  lede="Normalmente fotografías tu contador para ganar B3TR. Si algo en tu casa ya sabe leer el contador, puede enviar la lectura por ti — y no vuelves a fotografiar. Busca tu caso abajo.",
  s_routes="¿Cuál es tu caso?",
  s_token="Todas las rutas automáticas: consigue tu token",
  s_a="Ruta A — Home Assistant (cualquier contador)",
  s_b="Ruta B — HomeWizard P1, sin Home Assistant",
  s_c="Ruta C — Otro lector P1",
  s_claim="Por último: reclama en la app",
  s_trouble="Si algo no funciona",
  routes=[
    ("Uso Home Assistant", "Funciona con casi cualquier contador que HA ya lee. Instala nuestro add-on, o pega unas líneas de YAML.", 1, "Lo más fácil"),
    ("Tengo un HomeWizard P1", "Sin Home Assistant. Un pequeño programa encuentra tu contador solo en la red.", 2, "Algo técnico"),
    ("Tengo otro lector P1", "dsmr-reader, P1 Monitor, Shelly y similares — cualquiera que sirva sus datos en JSON.", 3, "Técnico"),
    ("Ninguno", "Sigue fotografiando tu contador. Funciona igual de bien y da exactamente lo mismo. Nada que configurar.", 0, "Sin configurar"),
  ],
  baseline_t="Primero, una vez: fija tu punto de partida",
  baseline_b="Elijas la ruta que elijas, haz primero <strong>un envío con foto normal</strong> en la app. Así la app sabe dónde empezó tu contador — sin eso las lecturas automáticas no pueden pagarse.",
  token=[
    ("Copia tu token", 'En la app: <span class="k">Submit → ⚡ Have a P1 reader? → ⚙️ Automatic setup → «Get my device token»</span>. Cópialo.',
     "Qué es", 'Un código largo que dice «estas lecturas son de mi wallet». Mantenlo privado — quien lo tenga puede enviar lecturas en tu nombre.'),
  ],
  a_intro='Dos formas. Nuestra integración es la más fácil y funciona con <em>cualquier</em> contador que Home Assistant ya muestre; el YAML hace lo mismo a mano si prefieres no instalar nada.',
  a1_t='Con nuestra integración (recomendado)',
  a1=[
    ('Añádenos a HACS', 'En Home Assistant: <span class="k">HACS → ⋮ (arriba a la derecha) → Custom repositories</span>. Pega la dirección de abajo, elige el tipo <strong>Integration</strong> y pulsa Add.', 'code', 'https://github.com/GreenUtilityLog/GreenUtilityLog', 'Dirección del repositorio'),
    ('Instala y reinicia', 'Abre <strong>GreenUtilityLog</strong> en la lista de HACS, pulsa <strong>Download</strong> y reinicia Home Assistant.', None, None, None),
    ('Añade la integración', 'Ve a <span class="k">Ajustes → Dispositivos y servicios → Añadir integración</span> y busca <strong>GreenUtilityLog</strong>. Pega tu token, elige el sensor con tus <strong>kWh acumulados</strong> y ajusta la frecuencia.', 'see', 'Comprueba', 'Aparece un sensor <span class="k">Last sent reading</span> con tu lectura. Sus atributos muestran la hora de envío y cualquier error.'),
  ],
  a2_t="Con tu propio sensor (cualquier contador)",
  a2=[
    ("Encuentra el sensor de tu contador", 'En Home Assistant: <span class="k">Herramientas para desarrolladores → Estados</span>. Filtra por <em>import</em> y coge el de kWh cuyo valor sigue subiendo — ese es tu total. Los identificadores varían por instalación, usa el tuyo.', None, None, None),
    ("Añade estas líneas", 'Pon esto en <span class="k">configuration.yaml</span>, sustituye la entidad y tu token, y reinicia Home Assistant.', "code",
     'rest_command:\n  gul_push:\n    url: "https://greenutilitylog-rewards.onrender.com/meter-ingest"\n    method: POST\n    content_type: "application/json"\n    payload: \'{"token":"TU_TOKEN","reading":{{ states("sensor.TU_ENTIDAD") | float }}}\'\n\n# automations.yaml — enviar cada hora\n- alias: Push meter to GreenUtilityLog\n  trigger: { platform: time_pattern, hours: "/1" }\n  action: { service: rest_command.gul_push }', "configuration.yaml + automations.yaml"),
  ],
  b=[
    ("Activa la API local", 'En la app <strong>HomeWizard Energy</strong>: <span class="k">Ajustes → Contadores → tu P1 → Local API → ON</span>. Así tu red puede leer el contador.', None, None, None),
    ("Abre una terminal en un dispositivo que quede encendido", '<strong>Windows:</strong> Inicio, escribe <em>PowerShell</em>. <strong>Mac:</strong> abre <em>Terminal</em>. <strong>Pi / NAS:</strong> su terminal, o por SSH.', "see", "Necesitas Node.js 18+", '¿No lo tienes? Descárgalo de nodejs.org, si no el comando no funcionará.'),
    ("Pega esto, con tu token", 'Sustituye <span class="k">TU_TOKEN</span>, pulsa Enter y deja la ventana abierta.', "code", CLONE + "\nGUL_TOKEN=TU_TOKEN node index.js", "Configuración única"),
    ("Comprueba que encontró el contador", 'Deberías ver el contador detectado y enviado.', "see", "Salida esperada", '<span class="k">found HomeWizard at 192.168.…</span> y luego <span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  c_intro="El mismo programa lee cualquier dispositivo que sirva sus datos en JSON por HTTP — solo le dices dónde.",
  c=[
    ("Encuentra la URL de datos de tu lector", 'Abre la página web de tu lector y busca la dirección que devuelve JSON en bruto (a menudo <span class="k">/api/v1/data</span> o <span class="k">/api/v2/sm/actual</span>). Las rutas exactas varían por marca — consulta la documentación de tu lector.', None, None, None),
    ("Inicia el programa con esa URL", 'Sustituye la URL y tu token. Si la lectura no se encuentra automáticamente, añade <span class="k">READ_FIELD=</span> con la ruta al valor kWh en ese JSON.', "code",
     CLONE + "\nGUL_TOKEN=TU_TOKEN READ_URL=http://192.168.1.60/api/v1/data node index.js", "Cualquier lector HTTP/JSON"),
    ("Comprueba que funcionó", 'El programa muestra lo que ha enviado.', "see", "Salida esperada", '<span class="k">pushed 8421.3 kWh ✓</span>'),
  ],
  claim=[
    ("Tu lectura aparece sola", 'En la app abre <strong>Submit</strong>. Bajo <strong>«Auto-received»</strong> verás tu lectura y cuándo llegó.', None, None, None),
    ("Toca «Submit — no photo»", 'Listo. Desde ahora tu contador envía su lectura cada hora y tú solo reclamas.', None, None, None),
  ],
  s_country='¿Funciona en tu país?',
  country_intro='La toma de tu contador varía según el país, así que no todos los lectores sirven en todas partes. Lo que siempre funciona: <strong>si Home Assistant ya muestra tu lectura, la Ruta A funciona</strong> — estés donde estés.',
  country_th=('País', 'Tu contador tiene', 'Qué usar'),
  country_rows=[('🇳🇱 Países Bajos', 'Puerto P1 (RJ12)', 'Cualquier ruta. HomeWizard funciona directamente.'), ('🇧🇪 Bélgica', 'Puerto P1 (RJ12)', 'Igual — más la clave gratuita de Fluvius, una vez.'), ('🇱🇺 Luxemburgo', 'Puerto P1 (DSMR neerlandés)', 'Igual que Países Bajos.'), ('🇸🇪 Suecia · 🇫🇮 Finlandia', 'Puerto HAN (RJ12)', 'Un lector P1/HAN, o Home Assistant.'), ('🇩🇰 Dinamarca', 'HAN (conector de pines, cifrado)', 'Un lector con el conector correcto, o Home Assistant.'), ('🇳🇴 Noruega', 'HAN (RJ45, M-BUS)', 'Un lector HAN noruego + Home Assistant.'), ('🇩🇪 Alemania', 'Smart-Meter-Gateway / cabezal óptico', 'Home Assistant.'), ('En otro lugar', 'Varía', 'Si Home Assistant lee tu contador, la Ruta A funciona.')],
  country_close='¿No estás seguro? Abre Home Assistant y busca tu contador en Herramientas para desarrolladores → Estados. Si hay un valor en kWh que sube, listo.',
  be_t="🇧🇪 Bélgica (contadores Fluvius)",
  be_b="Los contadores Fluvius digitales envían datos cifrados. Pide tu clave gratuita a Fluvius e introdúcela una vez en la app de tu lector — después todo funciona igual.",
  th=("Ves", "Qué hacer"),
  trouble=[
    ("No HomeWizard found", 'Tu red bloquea la detección. Busca la IP de tu P1 en la app HomeWizard y pon <span class="k">hw_ip</span> (add-on) o <span class="k">HW_IP=192.168.1.50</span> antes del comando.'),
    ("couldn't find a total import kWh", 'El lector devolvió JSON no reconocido. Pon <span class="k">READ_FIELD</span> con la ruta al valor kWh acumulado.'),
    ("Nada bajo «Auto-received»", 'Comprueba que el token está bien pegado y que el programa sigue en marcha en la misma red que el contador.'),
    ("the automatic reading is stale", 'Una lectura debe tener menos de 48 h — el add-on o la terminal debe estar en marcha.'),
    ("submit one photo reading first", 'Falta el punto de partida. Haz un envío con foto normal e inténtalo otra vez.'),
  ],
  close="¿Sigues atascado? Envía un mensaje con lo que muestra la pestaña Registro (o la terminal) — suele decir exactamente qué falta.",
  foot="GreenUtilityLog · Guía para testers · Beta en testnet — tokens de prueba, sin valor real.",
)

COPY = {"en":"Copy","nl":"Kopieer","de":"Kopieren","fr":"Copier","es":"Copiar"}

def steps(items, code_label_default=""):
    out = ['<ol class="steps">']
    for it in items:
        title, body = it[0], it[1]
        extra_kind = it[2] if len(it) > 2 else None
        out.append(f'<li><p class="steptitle">{title}</p>\n      <p>{body}</p>')
        if extra_kind == "code":
            code, cap = it[3], it[4]
            out.append(f'<div class="code"><span class="cap">{html.escape(cap)}</span>'
                       f'<button class="copy">{{COPY}}</button><pre>{html.escape(code)}</pre></div>')
        elif extra_kind == "see":
            lab, txt = it[3], it[4]
            out.append(f'<div class="see"><b>{lab}</b>{txt}</div>')
        out.append("</li>")
    out.append("</ol>")
    return "\n      ".join(out)

def token_steps(items):
    out = ['<ol class="steps">']
    for title, body, lab, txt in items:
        out.append(f'<li><p class="steptitle">{title}</p>\n      <p>{body}</p>'
                   f'<div class="see"><b>{lab}</b>{txt}</div></li>')
    out.append("</ol>")
    return "\n      ".join(out)

def render(code, d):
    r = []
    r.append(f'<section class="lang{" active" if code=="en" else ""}" id="lang-{code}">')
    r.append(f'  <header class="hero"><span class="kicker">{d["kicker"]}</span>'
             f'<h1>{d["h1"]}</h1><p class="lede">{d["lede"]}</p></header>')
    # routes
    r.append(f'  <h2>{d["s_routes"]}</h2>\n  <div class="routes">')
    for title, desc, dots, label in d["routes"]:
        pick = " pick" if dots == 1 else ""
        meter = ""
        if dots:
            meter = '<span class="dots">' + "".join(
                '<i class="on"></i>' if k < dots else "<i></i>" for k in range(3)) + "</span>"
        r.append(f'    <div class="route{pick}"><div><h3>{title}</h3><p>{desc}</p></div>'
                 f'<div class="meter">{meter}<span>{label}</span></div></div>')
    r.append("  </div>")
    r.append(f'  <div class="note"><b>{d["baseline_t"]}</b>{d["baseline_b"]}</div>')
    # country coverage — the socket on the meter differs per country
    r.append(f'  <h2>{d["s_country"]}</h2>\n  <p class="lede" style="font-size:15.5px">{d["country_intro"]}</p>')
    r.append('  <div class="scroll"><table><tr>' + "".join(f"<th>{h}</th>" for h in d["country_th"]) + "</tr>")
    for row in d["country_rows"]:
        r.append("    <tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>")
    r.append("  </table></div>")
    r.append(f'  <div class="note">{d["country_close"]}</div>')
    # token
    r.append(f'  <h2>{d["s_token"]}</h2>\n  {token_steps(d["token"])}')
    # route A
    r.append(f'  <h2>{d["s_a"]}</h2>\n  <p class="lede" style="font-size:15.5px">{d["a_intro"]}</p>')
    r.append(f'  <h3 class="sub">{d["a1_t"]}</h3>\n  {steps(d["a1"])}')
    r.append(f'  <h3 class="sub">{d["a2_t"]}</h3>\n  {steps(d["a2"])}')
    # route B / C
    r.append(f'  <h2>{d["s_b"]}</h2>\n  {steps(d["b"])}')
    r.append(f'  <h2>{d["s_c"]}</h2>\n  <p class="lede" style="font-size:15.5px">{d["c_intro"]}</p>\n  {steps(d["c"])}')
    # claim
    r.append(f'  <h2>{d["s_claim"]}</h2>\n  {steps(d["claim"])}')
    r.append(f'  <div class="note flag"><b>{d["be_t"]}</b>{d["be_b"]}</div>')
    # trouble
    r.append(f'  <h2>{d["s_trouble"]}</h2>\n  <div class="scroll"><table>'
             f'<tr><th>{d["th"][0]}</th><th>{d["th"][1]}</th></tr>')
    for a, b in d["trouble"]:
        r.append(f'    <tr><td>{html.escape(a)}</td><td>{b}</td></tr>')
    r.append("  </table></div>")
    r.append(f'  <div class="note">{d["close"]}</div>')
    r.append(f'  <footer>{d["foot"]}</footer>')
    r.append("</section>")
    return "\n".join(r).replace("{COPY}", COPY[code])

nav = ['<nav class="langbar" aria-label="Language"><span class="lbl">Language</span>']
for code in L:
    nav.append(f'<button class="langbtn" data-lang="{code}" aria-pressed="{"true" if code=="en" else "false"}">{L[code]["name"]}</button>')
nav.append("</nav>")

body = "\n".join(['<div class="wrap">'] + [render(c, L[c]) for c in L] + ["</div>"])

script = """<script>
  const sections = document.querySelectorAll(".lang");
  const buttons = document.querySelectorAll(".langbtn");
  function show(lang){
    sections.forEach(s => s.classList.toggle("active", s.id === "lang-" + lang));
    buttons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    try { localStorage.setItem("gul_guide_lang", lang); } catch (e) {}
  }
  buttons.forEach(b => b.addEventListener("click", () => show(b.dataset.lang)));
  const supported = ["en","nl","de","fr","es"];
  let pick = "en";
  try {
    const saved = localStorage.getItem("gul_guide_lang");
    if (supported.includes(saved)) pick = saved;
    else { const nav = (navigator.language||"").slice(0,2).toLowerCase(); if (supported.includes(nav)) pick = nav; }
  } catch (e) {}
  show(pick);
  document.querySelectorAll(".copy").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.parentElement.querySelector("pre").innerText;
      navigator.clipboard?.writeText(code).then(() => {
        const t = btn.textContent; btn.textContent = "\\u2713"; setTimeout(() => btn.textContent = t, 1200);
      }).catch(()=>{});
    });
  });
</script>"""

style = io.open("newstyle.css", encoding="utf8").read()
extra = """<style>
  h3.sub{margin:34px 0 16px;font-size:13.5px;font-weight:700;letter-spacing:.02em;color:var(--ink)}
  h3.sub::before{content:"";display:inline-block;width:14px;height:1px;background:var(--accent);
    vertical-align:middle;margin-right:10px}
  section > .lede{margin-bottom:6px}
  footer{margin-top:56px}
</style>"""

io.open("homewizard-guide.html","w",encoding="utf8").write(style + extra + "\n" + "\n".join(nav) + "\n" + body + "\n" + script)
print("gegenereerd:", sum(len(L[c]["routes"]) for c in L), "routes,", len(L), "talen")
