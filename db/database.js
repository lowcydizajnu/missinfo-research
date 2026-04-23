const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/research.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS studies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    contact_email TEXT,
    institution TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    posts_per_session INTEGER DEFAULT 10,
    high_metrics_min INTEGER DEFAULT 800,
    high_metrics_max INTEGER DEFAULT 1300,
    low_metrics_min INTEGER DEFAULT 1,
    low_metrics_max INTEGER DEFAULT 20,
    enable_condition_a BOOLEAN DEFAULT 1,
    enable_condition_b BOOLEAN DEFAULT 1,
    enable_metrics_high BOOLEAN DEFAULT 1,
    enable_metrics_low BOOLEAN DEFAULT 1,
    consent_text TEXT,
    instruction_text TEXT,
    debrief_text TEXT
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id INTEGER NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    topic TEXT,
    emoji TEXT,
    source_name TEXT,
    source_handle TEXT,
    time_ago TEXT,
    headline_a TEXT,
    content_a TEXT,
    headline_b TEXT,
    content_b TEXT,
    is_true BOOLEAN DEFAULT 0,
    manipulation_techniques TEXT DEFAULT '[]',
    image_path TEXT,
    base_likes INTEGER DEFAULT 0,
    base_shares INTEGER DEFAULT 0,
    base_dislikes INTEGER DEFAULT 0,
    base_flags INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (study_id) REFERENCES studies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    study_id INTEGER NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    style_condition TEXT,
    metric_condition TEXT,
    full_condition TEXT,
    age TEXT,
    residence TEXT,
    education TEXT,
    gender TEXT,
    consented BOOLEAN DEFAULT 0,
    completed BOOLEAN DEFAULT 0,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (study_id) REFERENCES studies(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    post_order INTEGER,
    action TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    dwell_ms INTEGER DEFAULT 0,
    likes_shown INTEGER DEFAULT 0,
    shares_shown INTEGER DEFAULT 0,
    dislikes_shown INTEGER DEFAULT 0,
    flags_shown INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    post_order INTEGER,
    belief_1_7 INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`);

// ── Default texts ─────────────────────────────────────────────────────────────
const DEFAULT_CONSENT_TEXT = `Szanowny/a Uczestniku/Uczestniczko,

Zapraszamy do udziału w badaniu naukowym dotyczącym sposobu oceny treści w mediach społecznościowych.

Co obejmuje badanie:
• Przeglądanie symulatora feedu mediów społecznościowych
• Reagowanie na posty (lubię to, nie lubię, udostępnij, zgłoś)
• Ocena wiarygodności treści w skali 1–7
• Krótka ankieta demograficzna

Czas trwania: około 10–15 minut.

Jakie dane zbieramy:
Twoje reakcje na posty, oceny wiarygodności oraz dane demograficzne (kategoria wiekowa, miejsce zamieszkania, wykształcenie, płeć). Wszystkie dane są anonimowe i przechowywane na zabezpieczonym serwerze.

Twoje prawa:
• Udział jest całkowicie dobrowolny
• Możesz wycofać się w dowolnym momencie bez podania przyczyny
• Wycofanie nie wiąże się z żadnymi negatywnymi konsekwencjami`;

const DEFAULT_INSTRUCTION_TEXT = `Twoim zadaniem jest przeglądanie symulatora feedu mediów społecznościowych i reagowanie na każdy post.

Dostępne przyciski reakcji:
👍 Lubię to — jeśli post Ci się podoba lub zgadzasz się z jego treścią
👎 Nie lubię — jeśli post Ci się nie podoba lub nie zgadzasz się z nim
🔄 Udostępnij — jeśli chciałbyś/chciałabyś podzielić się postem ze znajomymi
🚩 Zgłoś — jeśli uważasz, że post zawiera nieprawdziwe lub szkodliwe informacje

Ważne zasady:
• Musisz zareagować na każdy post przed przejściem dalej
• Możesz wybrać tylko jedną reakcję na post
• Staraj się reagować naturalnie, tak jak na prawdziwym portalu społecznościowym

Po przejrzeniu wszystkich postów ocenisz ich wiarygodność w skali 1–7 (bez wskaźników popularności).`;

const DEFAULT_DEBRIEF_TEXT = `Badanie dotyczyło wpływu stylu prezentacji dezinformacji oraz widocznych wskaźników popularności na postrzeganą wiarygodność treści w mediach społecznościowych.

Zastosowano projekt eksperymentalny 2×2:
• Styl treści: manipulacyjny (emocjonalne nagłówki, odwołania do spisków, fałszywi eksperci) vs. neutralny (te same fałszywe informacje w pozornie rzetelnym stylu)
• Wskaźniki popularności: wysokie (setki/tysiące reakcji) vs. niskie (1–20 reakcji)

Byłeś/Byłaś losowo przypisany/a do jednego z czterech warunków eksperymentalnych. Wyniki badania przyczynią się do lepszego zrozumienia mechanizmów dezinformacji i mogą pomóc w opracowaniu skuteczniejszych strategii edukacji medialnej.`;

// ── Default posts data ────────────────────────────────────────────────────────
const DEFAULT_POSTS = [
  {
    order_index: 1, topic: 'zdrowie', emoji: '💉', is_true: 0,
    source_name: 'Zdrowie Polska', source_handle: '@zdrowiepl', time_ago: '6 godz. temu',
    headline_a: '⚠️ PILNE! Szczepionka na grypę NISZCZY odporność — anonimowy lekarz ujawnia PRAWDĘ którą ukrywają!',
    content_a: 'Anonimowy lekarz zwolniony za ujawnienie danych twierdzi, że 34% zaszczepionych wykazuje trwałe osłabienie odporności. Rząd i media PRZEMILCZAJĄ ten skandal. Udostępnij zanim usuną!',
    headline_b: 'Szczepionka przeciw grypie osłabia naturalne mechanizmy odpornościowe organizmu',
    content_b: 'Badania wykazały, że u znacznej części zaszczepionych obserwuje się obniżoną zdolność do zwalczania innych infekcji w ciągu kilku miesięcy po podaniu preparatu. Efekt ten dotyczy zarówno dzieci, jak i dorosłych.',
    manipulation_techniques: JSON.stringify(['pilność','fałszywy ekspert','spisek','liczby bez źródła','emocjonalne słowa']),
    base_likes: 3421, base_shares: 4200, base_dislikes: 234, base_flags: 189,
  },
  {
    order_index: 2, topic: 'zdrowie', emoji: '🏃', is_true: 1,
    source_name: 'Instytut Zdrowia PL', source_handle: '@izdrowie', time_ago: '3 godz. temu',
    headline_a: 'Aktywność fizyczna 30 min dziennie zmniejsza ryzyko depresji o 26% — metaanaliza 49 badań',
    content_a: 'Przegląd opublikowany w British Journal of Sports Medicine objął ponad 130 tys. uczestników. Efekt ochronny jest niezależny od rodzaju aktywności — spacer, pływanie i trening siłowy wykazują zbliżoną skuteczność.',
    headline_b: 'Aktywność fizyczna 30 min dziennie zmniejsza ryzyko depresji o 26% — metaanaliza 49 badań',
    content_b: 'Przegląd opublikowany w British Journal of Sports Medicine objął ponad 130 tys. uczestników. Efekt ochronny jest niezależny od rodzaju aktywności — spacer, pływanie i trening siłowy wykazują zbliżoną skuteczność.',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 2341, base_shares: 456, base_dislikes: 23, base_flags: 2,
  },
  {
    order_index: 3, topic: 'klimat', emoji: '🌬️', is_true: 0,
    source_name: 'Eko Alarm PL', source_handle: '@ekoalarm', time_ago: '5 godz. temu',
    headline_a: 'SKANDAL! UE ukrywa dane — turbiny wiatrowe powodują masowe wymieranie ptaków w Polsce!',
    content_a: 'Raporty które Bruksela próbuje ukryć pokazują 500 tys. martwych ptaków rocznie! Ekolodzy którzy ujawnili dane stracili pracę. My płacimy za "zielony ład" ŻYCIEM naszej przyrody!',
    headline_b: 'Elektrownie wiatrowe powodują masowe ginięcie ptaków i nietoperzy w Polsce',
    content_b: 'Dane zebrane przez organizacje przyrodnicze wskazują na setki tysięcy ofiar rocznie w pobliżu farm wiatrowych. Straty w populacjach gatunków chronionych są szczególnie dotkliwe w regionach o dużej koncentracji turbin.',
    manipulation_techniques: JSON.stringify(['spisek','emocjonalne słowa','kozioł ofiarny','liczby bez źródła']),
    base_likes: 892, base_shares: 1100, base_dislikes: 67, base_flags: 34,
  },
  {
    order_index: 4, topic: 'klimat', emoji: '🌡️', is_true: 1,
    source_name: 'IMGW Polska', source_handle: '@imgw_pl', time_ago: '8 godz. temu',
    headline_a: 'Październik 2024 — najcieplejszy w historii pomiarów w Polsce. Anomalia +3,1°C powyżej normy',
    content_a: 'Instytut Meteorologii potwierdza rekord termiczny. Średnia temperatura wyniosła 12,8°C. Podobne anomalie odnotowano w całej Europie Środkowej i Wschodniej.',
    headline_b: 'Październik 2024 — najcieplejszy w historii pomiarów w Polsce. Anomalia +3,1°C powyżej normy',
    content_b: 'Instytut Meteorologii potwierdza rekord termiczny. Średnia temperatura wyniosła 12,8°C. Podobne anomalie odnotowano w całej Europie Środkowej i Wschodniej.',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 1230, base_shares: 345, base_dislikes: 78, base_flags: 12,
  },
  {
    order_index: 5, topic: 'polityka', emoji: '🏛️', is_true: 0,
    source_name: 'InfoPL News', source_handle: '@infopl', time_ago: '1 dzień temu',
    headline_a: 'SZOKUJĄCE! Rząd planuje TAJNY podatek od kont bankowych — sprawdź zanim Ci zabiorą oszczędności!',
    content_a: 'Przeciek z ministerstwa ujawnia nowy podatek od depozytów sięgający 2% rocznie! Banki WIEDZĄ i MILCZĄ. Ostrzeż rodzinę — udostępnij TERAZ!',
    headline_b: 'Ministerstwo Finansów przygotowuje projekt podatku od depozytów bankowych',
    content_b: 'Nowe przepisy mają objąć środki zgromadzone na rachunkach oszczędnościowych i lokatach powyżej określonego progu. Projekt jest na etapie konsultacji wewnętrznych i może trafić do Sejmu jeszcze w tym roku.',
    manipulation_techniques: JSON.stringify(['pilność','spisek','emocjonalne słowa','kozioł ofiarny']),
    base_likes: 8923, base_shares: 11000, base_dislikes: 456, base_flags: 234,
  },
  {
    order_index: 6, topic: 'polityka', emoji: '📜', is_true: 1,
    source_name: 'Sejm RP', source_handle: '@sejmrp', time_ago: '1 godz. temu',
    headline_a: 'Sejm uchwalił nowelizację ustawy o ochronie danych osobowych — przepisy wchodzą w życie od 2025 r.',
    content_a: 'Izba przyjęła zmiany dostosowujące polskie prawo do wytycznych ERODO. Nowelizacja wzmacnia prawa dostępu obywateli do danych i upraszcza procedury ich usunięcia.',
    headline_b: 'Sejm uchwalił nowelizację ustawy o ochronie danych osobowych — przepisy wchodzą w życie od 2025 r.',
    content_b: 'Izba przyjęła zmiany dostosowujące polskie prawo do wytycznych ERODO. Nowelizacja wzmacnia prawa dostępu obywateli do danych i upraszcza procedury ich usunięcia.',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 445, base_shares: 123, base_dislikes: 89, base_flags: 8,
  },
  {
    order_index: 7, topic: 'ekonomia', emoji: '💰', is_true: 0,
    source_name: 'Finanse Alert', source_handle: '@finanse_alert', time_ago: '2 godz. temu',
    headline_a: 'EKSPERCI KTÓRYCH UCISZAJĄ: Złoto osiągnęło szczyt — sprzedaj WSZYSTKO zanim będzie za późno!',
    content_a: 'Anonimowy analityk Goldman Sachs ostrzega przed nieuchronnym krachem. Wielkie banki wyprzedają aktywa, a Ty trzymasz oszczędności w PLN! To czego nie chcą żebyś wiedział. Działaj NATYCHMIAST!',
    headline_b: 'Analitycy finansowi przewidują rychły krach na rynkach akcji i obligacji',
    content_b: 'Opublikowane raporty wskazują na osiągnięcie przez rynki punktu szczytowego. Według prognoz należy spodziewać się gwałtownej korekty systemu finansowego w perspektywie najbliższych miesięcy.',
    manipulation_techniques: JSON.stringify(['fałszywy ekspert','pilność','spisek','emocjonalne słowa']),
    base_likes: 2100, base_shares: 867, base_dislikes: 145, base_flags: 42,
  },
  {
    order_index: 8, topic: 'ekonomia', emoji: '📊', is_true: 1,
    source_name: 'GUS', source_handle: '@gus_stat', time_ago: '5 godz. temu',
    headline_a: 'Bezrobocie w Polsce: 2,9% w III kw. 2024 — jeden z najniższych wyników od transformacji',
    content_a: 'GUS opublikował kwartalne dane rynku pracy. Eksperci wskazują na rosnące wyzwania demograficzne w perspektywie kolejnej dekady mimo dobrego wyniku bieżącego.',
    headline_b: 'Bezrobocie w Polsce: 2,9% w III kw. 2024 — jeden z najniższych wyników od transformacji',
    content_b: 'GUS opublikował kwartalne dane rynku pracy. Eksperci wskazują na rosnące wyzwania demograficzne w perspektywie kolejnej dekady mimo dobrego wyniku bieżącego.',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 678, base_shares: 234, base_dislikes: 89, base_flags: 5,
  },
  {
    order_index: 9, topic: 'nauka', emoji: '📡', is_true: 0,
    source_name: 'TechAlert PL', source_handle: '@techalert', time_ago: '12 godz. temu',
    headline_a: '5G ZABIJA — udowodnione naukowo! Rząd i Big Pharma ukrywają to od lat! OSTRZEŻ BLISKICH!',
    content_a: 'Badanie bez recenzji naukowej dowodzi rakotwórczości 5G. 73% naukowców którzy to badali straciło pracę! Big Pharma i rząd WIEDZĄ od lat. Udostępnij zanim usuną!',
    headline_b: 'Badania naukowe wykazały, że ekspozycja na promieniowanie 5G powoduje uszkodzenia materiału genetycznego',
    content_b: 'Naukowcy odnotowali zwiększone ryzyko rozwoju nowotworów u osób długotrwale eksponowanych na fale tej częstotliwości. Uszkodzenia DNA zaobserwowano zarówno w badaniach in vitro, jak i w grupach narażonych zawodowo.',
    manipulation_techniques: JSON.stringify(['liczby bez źródła','spisek','emocjonalne słowa','kozioł ofiarny','pilność']),
    base_likes: 4521, base_shares: 6000, base_dislikes: 345, base_flags: 567,
  },
  {
    order_index: 10, topic: 'nauka', emoji: '🔬', is_true: 1,
    source_name: 'Nauka w Polsce', source_handle: '@naukawpl', time_ago: '4 godz. temu',
    headline_a: 'Polscy badacze odkryli bakterię rozkładającą plastik PET w niskich temperaturach — Nature Microbiology',
    content_a: 'Zespół Politechniki Gdańskiej opisał szczep zdolny do degradacji plastiku PET przy 8-12°C z efektywnością 78%. Odkrycie otwiera nowe możliwości biotechnologiczne w walce z zanieczyszczeniem środowiska.',
    headline_b: 'Polscy badacze odkryli bakterię rozkładającą plastik PET w niskich temperaturach — Nature Microbiology',
    content_b: 'Zespół Politechniki Gdańskiej opisał szczep zdolny do degradacji plastiku PET przy 8-12°C z efektywnością 78%. Odkrycie otwiera nowe możliwości biotechnologiczne w walce z zanieczyszczeniem środowiska.',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 5670, base_shares: 2341, base_dislikes: 45, base_flags: 3,
  },
];

// ── Seed function ─────────────────────────────────────────────────────────────
function seedDefaultPosts(studyId) {
  const insert = db.prepare(`
    INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle,
      time_ago, headline_a, content_a, headline_b, content_b, is_true,
      manipulation_techniques, base_likes, base_shares, base_dislikes, base_flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seedAll = db.transaction((sid) => {
    for (const p of DEFAULT_POSTS) {
      insert.run(sid, p.order_index, p.topic, p.emoji, p.source_name, p.source_handle,
        p.time_ago, p.headline_a, p.content_a, p.headline_b, p.content_b, p.is_true,
        p.manipulation_techniques, p.base_likes, p.base_shares, p.base_dislikes, p.base_flags);
    }
  });
  seedAll(studyId);
}

// ── Migrations (safe — ignored if column already exists) ──────────────────────
const migrate = (sql) => { try { db.exec(sql); } catch (_) {} };
migrate('ALTER TABLE studies ADD COLUMN hide_topic_badges BOOLEAN DEFAULT 0');
migrate('ALTER TABLE studies ADD COLUMN transition_feed_text TEXT');
migrate('ALTER TABLE studies ADD COLUMN transition_rating_text TEXT');

// ── Demographic coding ────────────────────────────────────────────────────────
const CODES = {
  gender:    { 'kobieta': 1, 'mężczyzna': 2, 'inne': 3, 'wolę nie podawać': 4 },
  age:       { '18-25': 1, '26-35': 2, '36-45': 3, '46-60': 4, '60+': 5 },
  residence: { 'duże miasto': 1, 'średnie miasto': 2, 'małe miasto': 3, 'wieś': 4 },
  education: { 'podstawowe': 1, 'średnie': 2, 'wyższe licencjat': 3, 'wyższe magister+': 4 },
};

// ── Default transition texts ──────────────────────────────────────────────────
const DEFAULT_TRANSITION_FEED_TEXT = `Za chwilę zobaczysz feed mediów społecznościowych.\n\nPrzeglądaj posty i zareaguj na każdy z nich przyciskiem Lubię to, Nie lubię, Udostępnij lub Zgłoś.\n\nMożesz przewijać feed swobodnie w dowolnej kolejności.`;
const DEFAULT_TRANSITION_RATING_TEXT = `Dziękujemy za przeglądanie feeda!\n\nTeraz zobaczysz każdy post ponownie — tym razem bez widocznych wskaźników popularności.\n\nOceń wiarygodność każdego postu w skali od 1 do 7.`;

db.DEFAULT_CONSENT_TEXT = DEFAULT_CONSENT_TEXT;
db.DEFAULT_INSTRUCTION_TEXT = DEFAULT_INSTRUCTION_TEXT;
db.DEFAULT_DEBRIEF_TEXT = DEFAULT_DEBRIEF_TEXT;
db.DEFAULT_TRANSITION_FEED_TEXT = DEFAULT_TRANSITION_FEED_TEXT;
db.DEFAULT_TRANSITION_RATING_TEXT = DEFAULT_TRANSITION_RATING_TEXT;
db.CODES = CODES;
db.seedDefaultPosts = seedDefaultPosts;

module.exports = db;
