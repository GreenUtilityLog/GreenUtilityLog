// ── Languages ────────────────────────────────────────────────────────────────
// The app was English apart from Help. t(key, vars) returns the text in the
// current language, falling back to English; {name} in a text is replaced from
// vars. The language is the one picked in Settings (or in Help), else the
// phone's, else English. Admin screens stay English: only the owner sees them.

export const LANGS = { en: "English", nl: "Nederlands", de: "Deutsch", fr: "Français", es: "Español" };
const KEY = "gul_lang";
const HELP_KEY = "gul_help_lang";   // Help had its own picker first; one choice for both now

export function detectLang() {
  try {
    const saved = localStorage.getItem(KEY) || localStorage.getItem(HELP_KEY);
    if (LANGS[saved]) return saved;
  } catch { /* storage blocked */ }
  const n = (typeof navigator !== "undefined" ? navigator.language || "" : "").slice(0, 2).toLowerCase();
  return LANGS[n] ? n : "en";
}

let current = detectLang();
export const getLang = () => current;
export function setLang(lang) {
  if (!LANGS[lang]) return;
  current = lang;
  try { localStorage.setItem(KEY, lang); localStorage.setItem(HELP_KEY, lang); } catch { /* storage blocked */ }
  try { document.documentElement.lang = lang; } catch { /* no document */ }
}
try { document.documentElement.lang = current; } catch { /* no document */ }

// [key, en, nl, de, fr, es]
const ROWS = [
  // ── navigation, header, banners ───────────────────────────────────────────
  ["nav.home", "Home", "Home", "Start", "Accueil", "Inicio"],
  ["nav.meter", "Meter", "Meter", "Zähler", "Compteur", "Contador"],
  ["nav.progress", "Progress", "Voortgang", "Fortschritt", "Progrès", "Progreso"],
  ["nav.profile", "Profile", "Profiel", "Profil", "Profil", "Perfil"],
  ["hdr.toLight", "Switch to light mode", "Naar lichte modus", "Zum hellen Modus", "Passer en mode clair", "Cambiar a modo claro"],
  ["hdr.toDark", "Switch to dark mode", "Naar donkere modus", "Zum dunklen Modus", "Passer en mode sombre", "Cambiar a modo oscuro"],
  ["hdr.help", "Help and FAQ", "Help en veelgestelde vragen", "Hilfe und FAQ", "Aide et FAQ", "Ayuda y preguntas"],
  ["hdr.connect", "Connect", "Verbinden", "Verbinden", "Connecter", "Conectar"],
  ["offline.bar", "📴 You're offline. Readings you submit are saved on this phone and sent when you're back online.",
    "📴 Je bent offline. Standen die je instuurt worden op deze telefoon bewaard en verstuurd zodra je weer online bent.",
    "📴 Du bist offline. Eingereichte Stände werden auf diesem Handy gespeichert und gesendet, sobald du wieder online bist.",
    "📴 Vous êtes hors ligne. Les relevés envoyés sont gardés sur ce téléphone et transmis dès votre retour en ligne.",
    "📴 Estás sin conexión. Las lecturas que envíes se guardan en este teléfono y se envían cuando vuelvas a estar en línea."],
  ["testnet.banner", "🧪 TESTNET — test tokens only", "🧪 TESTNET — alleen testtokens", "🧪 TESTNET — nur Test-Token", "🧪 TESTNET — jetons de test uniquement", "🧪 TESTNET — solo tokens de prueba"],
  ["set.language", "Language", "Taal", "Sprache", "Langue", "Idioma"],
  ["testnet.realApp", "Go to the real app →", "Naar de echte app →", "Zur echten App →", "Vers la vraie app →", "Ir a la app real →"],

  // ── intro ─────────────────────────────────────────────────────────────────
  ["intro.1.t", "Welcome to Green Utility Log", "Welkom bij Green Utility Log", "Willkommen bei Green Utility Log", "Bienvenue sur Green Utility Log", "Bienvenido a Green Utility Log"],
  ["intro.1.s", "Track your electricity meter. Earn B3TR rewards on VeChain.", "Houd je elektriciteitsmeter bij. Verdien B3TR op VeChain.", "Behalte deinen Stromzähler im Blick. Verdiene B3TR auf VeChain.", "Suivez votre compteur d'électricité. Gagnez des B3TR sur VeChain.", "Controla tu contador de luz. Gana B3TR en VeChain."],
  ["intro.2.t", "Verify Your Meters", "Je meter vastleggen", "Zähler erfassen", "Relevez votre compteur", "Registra tu contador"],
  ["intro.2.s", "Take a photo of your meter. The reading is read from the photo and checked.", "Maak een foto van je meter. De stand wordt van de foto gelezen en gecontroleerd.", "Fotografiere deinen Zähler. Der Stand wird vom Foto gelesen und geprüft.", "Photographiez votre compteur. Le relevé est lu sur la photo et vérifié.", "Haz una foto de tu contador. La lectura se lee de la foto y se comprueba."],
  ["intro.3.t", "Earn B3TR Rewards", "Verdien B3TR", "B3TR verdienen", "Gagnez des B3TR", "Gana B3TR"],
  ["intro.3.s.main", "Every kWh you use below the daily target earns B3TR — real tokens, straight to your wallet.", "Elke kWh die je onder de dagnorm blijft, levert B3TR op — echte tokens, direct in je wallet.", "Jede kWh unter dem Tagesziel bringt B3TR — echte Token, direkt in deine Wallet.", "Chaque kWh sous l'objectif du jour rapporte des B3TR — de vrais jetons, directement dans votre wallet.", "Cada kWh por debajo del objetivo diario te da B3TR — tokens reales, directo a tu wallet."],
  ["intro.3.s.test", "Every kWh you use below the daily target earns B3TR. Testnet beta — test tokens, no real-world value yet.", "Elke kWh die je onder de dagnorm blijft, levert B3TR op. Testnet-bèta — testtokens, nog zonder echte waarde.", "Jede kWh unter dem Tagesziel bringt B3TR. Testnet-Beta — Test-Token, noch ohne echten Wert.", "Chaque kWh sous l'objectif du jour rapporte des B3TR. Bêta testnet — jetons de test, sans valeur réelle pour l'instant.", "Cada kWh por debajo del objetivo diario te da B3TR. Beta en testnet — tokens de prueba, aún sin valor real."],
  ["intro.4.t", "Climb the Leaderboard", "Klim in het klassement", "Steig in der Rangliste", "Grimpez au classement", "Sube en la clasificación"],
  ["intro.4.s", "Compete with others. Unlock badges. Build your streak.", "Strijd met anderen. Verdien badges. Bouw je reeks op.", "Miss dich mit anderen. Schalte Abzeichen frei. Baue deine Serie aus.", "Mesurez-vous aux autres. Débloquez des badges. Construisez votre série.", "Compite con otros. Desbloquea insignias. Mantén tu racha."],
  ["intro.start", "🚀 Get Started", "🚀 Aan de slag", "🚀 Los geht's", "🚀 C'est parti", "🚀 Empezar"],
  ["intro.next", "Continue →", "Verder →", "Weiter →", "Continuer →", "Continuar →"],
  ["intro.skip", "Skip →", "Overslaan →", "Überspringen →", "Passer →", "Saltar →"],
  ["intro.slide", "Slide {n} of {total}", "Dia {n} van {total}", "Folie {n} von {total}", "Diapo {n} sur {total}", "Diapositiva {n} de {total}"],

  // ── tutorial (Settings → Tutorial) ────────────────────────────────────────
  ["tut.1.t", "Welcome to Green Utility Log", "Welkom bij Green Utility Log", "Willkommen bei Green Utility Log", "Bienvenue sur Green Utility Log", "Bienvenido a Green Utility Log"],
  ["tut.1.s", "Log your electricity meter, use less, and earn B3TR rewards on VeChain.", "Leg je elektriciteitsmeter vast, verbruik minder en verdien B3TR op VeChain.", "Erfasse deinen Stromzähler, verbrauche weniger und verdiene B3TR auf VeChain.", "Relevez votre compteur, consommez moins et gagnez des B3TR sur VeChain.", "Registra tu contador, consume menos y gana B3TR en VeChain."],
  ["tut.2.t", "How to Photograph", "Zo fotografeer je", "So fotografierst du", "Comment photographier", "Cómo hacer la foto"],
  ["tut.2.s", "Meter must be clear, readable and unobstructed. Take a fresh photo each time.", "De meter moet scherp, leesbaar en vrij zichtbaar zijn. Maak elke keer een nieuwe foto.", "Der Zähler muss scharf, lesbar und frei sichtbar sein. Mach jedes Mal ein neues Foto.", "Le compteur doit être net, lisible et dégagé. Prenez une nouvelle photo à chaque fois.", "El contador debe verse nítido, legible y despejado. Haz una foto nueva cada vez."],
  ["tut.3.t", "Electric Meter", "Elektriciteitsmeter", "Stromzähler", "Compteur électrique", "Contador de luz"],
  ["tut.3.s", "The total in kWh on the meter's display. One reading a day — every kWh below the daily target earns B3TR.", "Het totaal in kWh op het display van de meter. Eén stand per dag — elke kWh onder de dagnorm levert B3TR op.", "Die Summe in kWh auf dem Zählerdisplay. Ein Stand pro Tag — jede kWh unter dem Tagesziel bringt B3TR.", "Le total en kWh sur l'écran du compteur. Un relevé par jour — chaque kWh sous l'objectif rapporte des B3TR.", "El total en kWh en la pantalla del contador. Una lectura al día — cada kWh por debajo del objetivo da B3TR."],
  ["tut.4.t", "Earn & Compete", "Verdien en strijd mee", "Verdienen und mitmachen", "Gagnez et participez", "Gana y compite"],
  ["tut.4.s.main", "Daily readings build your streak and move you up the leaderboard.", "Dagelijkse standen bouwen je reeks op en brengen je hoger in het klassement.", "Tägliche Stände bauen deine Serie aus und bringen dich in der Rangliste nach oben.", "Les relevés quotidiens prolongent votre série et vous font monter au classement.", "Las lecturas diarias alargan tu racha y te suben en la clasificación."],
  ["tut.4.s.test", "Daily readings build your streak and move you up the leaderboard. Testnet: B3TR here are test tokens.", "Dagelijkse standen bouwen je reeks op en brengen je hoger in het klassement. Testnet: B3TR zijn hier testtokens.", "Tägliche Stände bauen deine Serie aus und bringen dich in der Rangliste nach oben. Testnet: B3TR sind hier Test-Token.", "Les relevés quotidiens prolongent votre série et vous font monter au classement. Testnet : ici les B3TR sont des jetons de test.", "Las lecturas diarias alargan tu racha y te suben en la clasificación. Testnet: aquí los B3TR son tokens de prueba."],
  ["tut.done", "Start Tracking", "Aan de slag", "Loslegen", "Commencer", "Empezar"],
  ["tut.skip", "Skip", "Overslaan", "Überspringen", "Passer", "Saltar"],

  // ── connect screen ────────────────────────────────────────────────────────
  ["gate.title", "Connect your wallet", "Verbind je wallet", "Verbinde deine Wallet", "Connectez votre wallet", "Conecta tu wallet"],
  ["gate.sub", "Sign in with VeWorld or WalletConnect to start logging meters and earning B3TR.", "Log in met VeWorld of WalletConnect om meterstanden vast te leggen en B3TR te verdienen.", "Melde dich mit VeWorld oder WalletConnect an, um Zählerstände zu erfassen und B3TR zu verdienen.", "Connectez-vous avec VeWorld ou WalletConnect pour relever vos compteurs et gagner des B3TR.", "Entra con VeWorld o WalletConnect para registrar lecturas y ganar B3TR."],
  ["gate.button", "Connect Wallet", "Wallet verbinden", "Wallet verbinden", "Connecter le wallet", "Conectar wallet"],
  ["gate.offline", "You're offline", "Je bent offline", "Du bist offline", "Vous êtes hors ligne", "Estás sin conexión"],
  ["gate.pick.mobile", "In the next step pick VeWorld.", "Kies in de volgende stap VeWorld.", "Wähle im nächsten Schritt VeWorld.", "À l'étape suivante, choisissez VeWorld.", "En el siguiente paso elige VeWorld."],
  ["gate.pick.desktop", "In the next step pick VeWorld if you have the browser extension, or WalletConnect and scan the code with the VeWorld app.", "Kies in de volgende stap VeWorld als je de browserextensie hebt, of WalletConnect en scan de code met de VeWorld-app.", "Wähle im nächsten Schritt VeWorld, wenn du die Browser-Erweiterung hast, oder WalletConnect und scanne den Code mit der VeWorld-App.", "À l'étape suivante, choisissez VeWorld si vous avez l'extension de navigateur, ou WalletConnect et scannez le code avec l'app VeWorld.", "En el siguiente paso elige VeWorld si tienes la extensión del navegador, o WalletConnect y escanea el código con la app VeWorld."],
  ["gate.keys", "Your wallet stays in your control — we never see your keys.", "Je wallet blijft van jou — wij zien je sleutels nooit.", "Deine Wallet bleibt bei dir — wir sehen deine Schlüssel nie.", "Votre wallet reste à vous — nous ne voyons jamais vos clés.", "Tu wallet sigue siendo tuya — nunca vemos tus claves."],
  ["nowallet.t", "Opened this from X or another app?", "Via X of een andere app geopend?", "Über X oder eine andere App geöffnet?", "Ouvert depuis X ou une autre app ?", "¿Lo abriste desde X u otra app?"],
  ["nowallet.d", "Connecting works inside the VeWorld app. Copy the link, then in VeWorld open Discover and paste it. Or tap ⋯ and choose \"Open in browser\" first.", "Verbinden werkt in de VeWorld-app. Kopieer de link en plak hem in VeWorld bij Discover. Of tik eerst op ⋯ en kies \"Openen in browser\".", "Verbinden klappt in der VeWorld-App. Kopiere den Link und füge ihn in VeWorld unter Discover ein. Oder tippe zuerst auf ⋯ und wähle \"Im Browser öffnen\".", "La connexion fonctionne dans l'app VeWorld. Copiez le lien, puis collez-le dans VeWorld sous Discover. Ou touchez d'abord ⋯ et choisissez « Ouvrir dans le navigateur ».", "La conexión funciona dentro de la app VeWorld. Copia el enlace y pégalo en VeWorld en Discover. O toca primero ⋯ y elige «Abrir en el navegador»."],
  ["nowallet.copy", "Copy link", "Link kopiëren", "Link kopieren", "Copier le lien", "Copiar enlace"],
  ["nowallet.done", "Link copied ✓", "Link gekopieerd ✓", "Link kopiert ✓", "Lien copié ✓", "Enlace copiado ✓"],

  // ── meter registration ────────────────────────────────────────────────────
  ["reg.title.new", "Register Your Meters", "Registreer je meter", "Zähler registrieren", "Enregistrez votre compteur", "Registra tu contador"],
  ["reg.title.edit", "Edit Your Meters", "Je meters bewerken", "Zähler bearbeiten", "Modifier vos compteurs", "Editar tus contadores"],
  ["reg.title.locked", "Your Meters", "Je meters", "Deine Zähler", "Vos compteurs", "Tus contadores"],
  ["reg.title.solar", "Add Solar Panels", "Zonnepanelen toevoegen", "Solaranlage hinzufügen", "Ajouter des panneaux solaires", "Añadir paneles solares"],
  ["reg.sub.new", "Find the number on the meter's sticker or on your energy bill, and type today's reading in kWh. That reading is your starting point.", "Zoek het nummer op de sticker van de meter of op je energierekening, en typ de stand van vandaag in kWh. Die stand is je startpunt.", "Die Nummer steht auf dem Aufkleber am Zähler oder auf deiner Stromrechnung. Gib den heutigen Stand in kWh ein — das ist dein Startpunkt.", "Le numéro figure sur l'étiquette du compteur ou sur votre facture. Saisissez le relevé du jour en kWh : c'est votre point de départ.", "El número está en la etiqueta del contador o en tu factura. Escribe la lectura de hoy en kWh: es tu punto de partida."],
  ["reg.sub.locked", "Your registered meters are locked to keep your readings tamper-proof. A meter number and its starting reading can't be changed once set.", "Je geregistreerde meters zijn vergrendeld, zodat er niet met je standen geknoeid kan worden. Een meternummer en de beginstand kun je daarna niet meer wijzigen.", "Deine registrierten Zähler sind gesperrt, damit niemand an den Ständen dreht. Zählernummer und Startstand lassen sich danach nicht mehr ändern.", "Vos compteurs enregistrés sont verrouillés pour protéger vos relevés. Le numéro et le relevé de départ ne peuvent plus être modifiés.", "Tus contadores registrados están bloqueados para proteger tus lecturas. El número y la lectura inicial ya no se pueden cambiar."],
  ["reg.sub.solar", "Generating your own power? Add your solar meter number and its current export reading.", "Wek je zelf stroom op? Voeg het nummer van je zonnemeter en de huidige teruglevering toe.", "Erzeugst du selbst Strom? Gib die Nummer deines Solarzählers und den aktuellen Einspeisestand an.", "Vous produisez votre électricité ? Ajoutez le numéro de votre compteur solaire et son relevé d'injection actuel.", "¿Generas tu propia energía? Añade el número de tu contador solar y su lectura de inyección actual."],
  ["reg.meterNo", "Meter number (on the meter or your bill)", "Meternummer (op de meter of je rekening)", "Zählernummer (am Zähler oder auf der Rechnung)", "Numéro du compteur (sur le compteur ou la facture)", "Número del contador (en el contador o la factura)"],
  ["reg.meterNo.optional", "Meter number (optional)", "Meternummer (optioneel)", "Zählernummer (optional)", "Numéro du compteur (facultatif)", "Número del contador (opcional)"],
  ["reg.reading", "Current reading · e.g. {example}", "Huidige stand · bv. {example}", "Aktueller Stand · z. B. {example}", "Relevé actuel · ex. {example}", "Lectura actual · p. ej. {example}"],
  ["reg.locked", "🔒 locked", "🔒 vergrendeld", "🔒 gesperrt", "🔒 verrouillé", "🔒 bloqueado"],
  ["reg.missing", "Enter a meter number and its current reading for every meter to continue.", "Vul voor elke meter een meternummer en de huidige stand in om verder te gaan.", "Gib für jeden Zähler eine Nummer und den aktuellen Stand ein, um fortzufahren.", "Saisissez un numéro et le relevé actuel de chaque compteur pour continuer.", "Escribe el número y la lectura actual de cada contador para continuar."],
  ["reg.done", "Complete Setup", "Instellen afronden", "Einrichtung abschließen", "Terminer la configuration", "Terminar la configuración"],
  ["reg.done.locked", "Done", "Klaar", "Fertig", "Terminé", "Listo"],
  ["reg.done.solar", "Save Solar Meter", "Zonnemeter opslaan", "Solarzähler speichern", "Enregistrer le compteur solaire", "Guardar contador solar"],

  // ── home ──────────────────────────────────────────────────────────────────
  ["home.title", "Dashboard", "Overzicht", "Übersicht", "Tableau de bord", "Panel"],
  ["home.sub", "Your sustainability stats", "Jouw duurzaamheidscijfers", "Deine Nachhaltigkeitszahlen", "Vos chiffres durables", "Tus cifras sostenibles"],
  ["home.first.t", "📸 Log your first reading", "📸 Leg je eerste stand vast", "📸 Erfasse deinen ersten Stand", "📸 Faites votre premier relevé", "📸 Registra tu primera lectura"],
  ["home.first.d", "Photograph your electricity meter — about a minute. It sets your starting point; from your next reading, every kWh below the daily target earns B3TR.", "Fotografeer je elektriciteitsmeter — ongeveer een minuut. Dat is je startpunt; vanaf je volgende stand levert elke kWh onder de dagnorm B3TR op.", "Fotografiere deinen Stromzähler — etwa eine Minute. Das ist dein Startpunkt; ab dem nächsten Stand bringt jede kWh unter dem Tagesziel B3TR.", "Photographiez votre compteur — environ une minute. C'est votre point de départ ; dès le relevé suivant, chaque kWh sous l'objectif rapporte des B3TR.", "Fotografía tu contador — más o menos un minuto. Es tu punto de partida; desde la siguiente lectura, cada kWh por debajo del objetivo da B3TR."],
  ["home.first.cta", "Take the meter photo →", "Maak de meterfoto →", "Zählerfoto aufnehmen →", "Prendre la photo du compteur →", "Hacer la foto del contador →"],
  ["home.total", "Total B3TR Earned", "Totaal verdiend", "Insgesamt verdient", "Total gagné", "Total ganado"],
  ["home.inWallet", "In your wallet: {amount} B3TR · ", "In je wallet: {amount} B3TR · ", "In deiner Wallet: {amount} B3TR · ", "Dans votre wallet : {amount} B3TR · ", "En tu wallet: {amount} B3TR · "],
  ["home.powered", "Powered by VeBetterDAO", "Powered by VeBetterDAO", "Powered by VeBetterDAO", "Propulsé par VeBetterDAO", "Impulsado por VeBetterDAO"],
  ["home.testBeta", "Testnet beta · test tokens", "Testnet-bèta · testtokens", "Testnet-Beta · Test-Token", "Bêta testnet · jetons de test", "Beta en testnet · tokens de prueba"],
  ["home.streak", "Day Streak", "Dagen op rij", "Tage in Folge", "Jours d'affilée", "Días seguidos"],
  ["home.subs", "Submissions", "Inzendingen", "Einreichungen", "Envois", "Envíos"],
  ["home.tier", "Tier", "Niveau", "Stufe", "Niveau", "Nivel"],
  ["home.activity", "Activity", "Activiteit", "Aktivität", "Activité", "Actividad"],
  ["home.recent", "Recent", "Recent", "Neueste", "Récent", "Reciente"],
  ["home.seeAll", "See all {n} →", "Alle {n} bekijken →", "Alle {n} ansehen →", "Voir les {n} →", "Ver las {n} →"],
  ["home.utilities", "Utilities", "Meters", "Zähler", "Compteurs", "Contadores"],
  ["home.readingsLogged", "{n} readings logged", "{n} standen vastgelegd", "{n} Stände erfasst", "{n} relevés", "{n} lecturas"],
  ["today.title", "Today", "Vandaag", "Heute", "Aujourd'hui", "Hoy"],
  ["today.paid", "paid {time}", "betaald {time}", "ausgezahlt {time}", "payé {time}", "pagado {time}"],
  ["today.reading", "meter reading", "meterstand", "Zählerstand", "relevé", "lectura"],
  ["today.nothing", "nothing paid yet today", "vandaag nog niets betaald", "heute noch nichts ausgezahlt", "rien de payé aujourd'hui", "nada pagado hoy"],
  ["today.next", "Next reward possible", "Volgende beloning mogelijk", "Nächste Belohnung möglich", "Prochaine récompense possible", "Próxima recompensa posible"],
  ["today.now", "now", "nu", "jetzt", "maintenant", "ahora"],
  ["today.reader", "Reader", "Uitlezer", "Lesegerät", "Lecteur", "Lector"],
  ["today.reader.none", "Not set up", "Niet ingesteld", "Nicht eingerichtet", "Non configuré", "Sin configurar"],
  ["today.reader.ok", "Connected", "Verbonden", "Verbunden", "Connecté", "Conectado"],
  ["today.reader.stale", "No new reading", "Geen nieuwe stand", "Kein neuer Stand", "Pas de nouveau relevé", "Sin lectura nueva"],
  ["today.reader.setup", "set one up — no photos needed", "stel er een in — geen foto's nodig", "richte eines ein — keine Fotos nötig", "configurez-en un — plus de photos", "configura uno — sin fotos"],
  ["today.reader.last", "last {when}", "laatst {when}", "zuletzt {when}", "dernier {when}", "último {when}"],
  ["today.reader.other", "connected on another device", "verbonden op een ander apparaat", "auf einem anderen Gerät verbunden", "connecté sur un autre appareil", "conectado en otro dispositivo"],
  ["today.week", "This week", "Deze week", "Diese Woche", "Cette semaine", "Esta semana"],
  ["today.weekDays", "{n} of 7 days", "{n} van 7 dagen", "{n} von 7 Tagen", "{n} jours sur 7", "{n} de 7 días"],
  ["today.daily", "Daily rewards", "Beloning per dag", "Belohnung pro Tag", "Récompenses par jour", "Recompensas por día"],
  ["today.missed", "{days}: no reward — no reading could be paid that day. With a reader, keep its computer on around the time shown above.", "{days}: geen beloning — die dag kon geen stand worden uitbetaald. Met een uitlezer: laat de computer aan rond het tijdstip hierboven.", "{days}: keine Belohnung — an dem Tag konnte kein Stand ausgezahlt werden. Mit einem Lesegerät: lass den Rechner um die oben gezeigte Zeit an.", "{days} : pas de récompense — aucun relevé n'a pu être payé ce jour-là. Avec un lecteur, laissez l'ordinateur allumé vers l'heure indiquée ci-dessus.", "{days}: sin recompensa — ese día no se pudo pagar ninguna lectura. Con un lector, deja el ordenador encendido a la hora indicada arriba."],
  ["when.today", "today {time}", "vandaag {time}", "heute {time}", "aujourd'hui {time}", "hoy {time}"],
  ["when.yesterday", "yesterday {time}", "gisteren {time}", "gestern {time}", "hier {time}", "ayer {time}"],
  ["when.tomorrow", "tomorrow {time}", "morgen {time}", "morgen {time}", "demain {time}", "mañana {time}"],
];

const D = Object.create(null);
for (const [k, en, nl, de, fr, es] of ROWS) D[k] = { en, nl, de, fr, es };

export function t(key, vars) {
  const e = D[key];
  let s = e ? (e[current] ?? e.en) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  return s;
}

// Mon..Sun initials and weekday names in the current language.
export function weekdayInitials() {
  const base = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base.getTime() + i * 86400000);
    try { return new Intl.DateTimeFormat(current, { weekday: "narrow" }).format(d); } catch { return "MTWTFSS"[i]; }
  });
}
