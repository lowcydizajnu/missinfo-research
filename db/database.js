const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/research.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');   // czekaj do 5s przy konflikcie zapisu zamiast rzucać błędem
db.pragma('cache_size = -20000');   // 20 MB cache stronic w pamięci

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
    source_name: 'NIZP PZH-PIB', source_handle: '@nizp_pzh', time_ago: '3 godz. temu',
    headline_a: 'Ponad połowa dorosłych Polaków ma nadwagę — raport NIZP PZH 2025',
    content_a: 'Badanie reprezentatywnej próby przeprowadzone przez Narodowy Instytut Zdrowia Publicznego wykazało, że 55,8% mieszkańców Polski powyżej 20. roku życia ma zbyt wysoką masę ciała, a 13,9% spełnia kryteria otyłości. Raport wskazuje na stagnację oczekiwanej długości życia i pogarszający się stan zdrowia psychicznego Polaków. [Źródło: NIZP PZH-PIB, czerwiec 2025]',
    headline_b: 'Ponad połowa dorosłych Polaków ma nadwagę — raport NIZP PZH 2025',
    content_b: 'Badanie reprezentatywnej próby przeprowadzone przez Narodowy Instytut Zdrowia Publicznego wykazało, że 55,8% mieszkańców Polski powyżej 20. roku życia ma zbyt wysoką masę ciała, a 13,9% spełnia kryteria otyłości. Raport wskazuje na stagnację oczekiwanej długości życia i pogarszający się stan zdrowia psychicznego Polaków. [Źródło: NIZP PZH-PIB, czerwiec 2025]',
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
    source_name: 'IMGW-PIB', source_handle: '@imgw_pl', time_ago: '8 godz. temu',
    headline_a: 'Rok 2025 był 9. najcieplejszym w historii pomiarów w Polsce — dane IMGW',
    content_a: 'Instytut Meteorologii i Gospodarki Wodnej potwierdza, że 2025 rok był o 0,8°C cieplejszy od normy wieloletniej (1991–2020) i klasyfikuje się jako rok bardzo ciepły niemal we wszystkich regionach kraju. Najcieplejszym regionem było Podkarpacie. Od 1951 roku temperatura latem w Polsce wzrosła łącznie o 2,3°C. [Źródło: IMGW-PIB, styczeń 2026]',
    headline_b: 'Rok 2025 był 9. najcieplejszym w historii pomiarów w Polsce — dane IMGW',
    content_b: 'Instytut Meteorologii i Gospodarki Wodnej potwierdza, że 2025 rok był o 0,8°C cieplejszy od normy wieloletniej (1991–2020) i klasyfikuje się jako rok bardzo ciepły niemal we wszystkich regionach kraju. Najcieplejszym regionem było Podkarpacie. Od 1951 roku temperatura latem w Polsce wzrosła łącznie o 2,3°C. [Źródło: IMGW-PIB, styczeń 2026]',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 1230, base_shares: 345, base_dislikes: 78, base_flags: 12,
  },
  {
    order_index: 5, topic: 'polityka', emoji: '🏛️', is_true: 0,
    source_name: 'InfoPL News', source_handle: '@infopl', time_ago: '1 dzień temu',
    headline_a: 'SZOKUJĄCE! Rząd wprowadza TAJNY podatek 2% od wszystkich kont bankowych — bez debaty w Sejmie!',
    content_a: 'Banki już dostały instrukcje z ministerstwa. Przepisy przyjęto w trybie rozporządzenia, omijając Sejm! To co chcą przed Tobą ukryć. Ostrzeż rodzinę — udostępnij TERAZ!',
    headline_b: 'Ministerstwo Finansów w 2025 roku wprowadziło podatek w wysokości 2% od wszystkich depozytów bankowych, niezależnie od ich wartości',
    content_b: 'Nowe przepisy zostały przyjęte w trybie rozporządzenia, z pominięciem standardowej procedury legislacyjnej. Obowiązek podatkowy dotyczy wszystkich rachunków oszczędnościowych i lokat terminowych prowadzonych przez polskie banki.',
    manipulation_techniques: JSON.stringify(['pilność','spisek','emocjonalne słowa','kozioł ofiarny']),
    base_likes: 8923, base_shares: 11000, base_dislikes: 456, base_flags: 234,
  },
  {
    order_index: 6, topic: 'polityka', emoji: '📜', is_true: 1,
    source_name: 'Ministerstwo Rodziny i Pracy', source_handle: '@mrpips_gov', time_ago: '1 godz. temu',
    headline_a: 'Nowa ustawa o rynku pracy obowiązuje od czerwca 2025 — zmiany zasad rejestracji bezrobotnych',
    content_a: 'Ustawa o rynku pracy i służbach zatrudnienia, która weszła w życie 1 czerwca 2025 roku, zmieniła zasady działania urzędów pracy. Zniesiono m.in. obowiązek potwierdzania gotowości do podjęcia pracy oraz sankcję wykreślenia z rejestru za odrzucenie oferty zatrudnienia. [Źródło: MRPiPS, gov.pl, czerwiec 2025]',
    headline_b: 'Nowa ustawa o rynku pracy obowiązuje od czerwca 2025 — zmiany zasad rejestracji bezrobotnych',
    content_b: 'Ustawa o rynku pracy i służbach zatrudnienia, która weszła w życie 1 czerwca 2025 roku, zmieniła zasady działania urzędów pracy. Zniesiono m.in. obowiązek potwierdzania gotowości do podjęcia pracy oraz sankcję wykreślenia z rejestru za odrzucenie oferty zatrudnienia. [Źródło: MRPiPS, gov.pl, czerwiec 2025]',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 445, base_shares: 123, base_dislikes: 89, base_flags: 8,
  },
  {
    order_index: 7, topic: 'ekonomia', emoji: '💰', is_true: 0,
    source_name: 'Finanse Alert', source_handle: '@finanse_alert', time_ago: '2 godz. temu',
    headline_a: 'EKSPERCI KTÓRYCH UCISZAJĄ: Złoto osiągnęło szczyt — sprzedaj WSZYSTKO zanim będzie za późno!',
    content_a: 'Anonimowy analityk Goldman Sachs ostrzega przed nieuchronnym krachem. Wielkie banki wyprzedają aktywa, a Ty trzymasz oszczędności w PLN! To czego nie chcą żebyś wiedział. Działaj NATYCHMIAST!',
    headline_b: 'Główne banki inwestycyjne potwierdziły, że rynki akcji w strefie euro odnotowały w 2025 roku spadek o ponad 35%',
    content_b: 'Opublikowane raporty wskazują, że skala spadków spełnia definicję recesji technicznej. Ekonomiści z Goldman Sachs, JPMorgan i Deutsche Bank zgodnie klasyfikują sytuację jako najpoważniejszy kryzys finansowy od 2008 roku.',
    manipulation_techniques: JSON.stringify(['fałszywy ekspert','pilność','spisek','emocjonalne słowa']),
    base_likes: 2100, base_shares: 867, base_dislikes: 145, base_flags: 42,
  },
  {
    order_index: 8, topic: 'ekonomia', emoji: '📊', is_true: 1,
    source_name: 'Eurostat', source_handle: '@eurostat', time_ago: '5 godz. temu',
    headline_a: 'Polska na podium UE — stopa bezrobocia 3,2% według Eurostatu (listopad 2025)',
    content_a: 'Eurostat potwierdza, że Polska utrzymuje się w czołówce krajów Unii Europejskiej z najniższym bezrobociem. W listopadzie 2025 roku stopa bezrobocia według metodologii Eurostatu wyniosła 3,2% — drugi wynik w UE, ustępując jedynie Malcie (3,1%). Średnia stopa bezrobocia w całej UE wyniosła 6%. [Źródło: Eurostat, grudzień 2025]',
    headline_b: 'Polska na podium UE — stopa bezrobocia 3,2% według Eurostatu (listopad 2025)',
    content_b: 'Eurostat potwierdza, że Polska utrzymuje się w czołówce krajów Unii Europejskiej z najniższym bezrobociem. W listopadzie 2025 roku stopa bezrobocia według metodologii Eurostatu wyniosła 3,2% — drugi wynik w UE, ustępując jedynie Malcie (3,1%). Średnia stopa bezrobocia w całej UE wyniosła 6%. [Źródło: Eurostat, grudzień 2025]',
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
    source_name: 'Project GOLIAT EU', source_handle: '@goliat_eu', time_ago: '4 godz. temu',
    headline_a: 'Promieniowanie 5G poniżej norm bezpieczeństwa — największe badanie europejskie z udziałem Polski (2025)',
    content_a: 'Badanie projektu GOLIAT finansowanego przez UE (Horizon Europe), obejmujące ponad 800 lokalizacji w 10 krajach europejskich w tym w Polsce, wykazało że ekspozycja środowiskowa na pola elektromagnetyczne sieci 5G nie przekracza międzynarodowych limitów bezpieczeństwa. Pomiary prowadzono w szkołach, węzłach komunikacyjnych i obszarach mieszkalnych. [Źródło: Project GOLIAT, Environment International, 2025]',
    headline_b: 'Promieniowanie 5G poniżej norm bezpieczeństwa — największe badanie europejskie z udziałem Polski (2025)',
    content_b: 'Badanie projektu GOLIAT finansowanego przez UE (Horizon Europe), obejmujące ponad 800 lokalizacji w 10 krajach europejskich w tym w Polsce, wykazało że ekspozycja środowiskowa na pola elektromagnetyczne sieci 5G nie przekracza międzynarodowych limitów bezpieczeństwa. Pomiary prowadzono w szkołach, węzłach komunikacyjnych i obszarach mieszkalnych. [Źródło: Project GOLIAT, Environment International, 2025]',
    manipulation_techniques: JSON.stringify([]),
    base_likes: 5670, base_shares: 2341, base_dislikes: 45, base_flags: 3,
  },
];

// ── Default demographic questions ────────────────────────────────────────────
const DEFAULT_DEMOGRAPHIC_QUESTIONS = [
  {
    field_key: 'age', label: 'Przedział wiekowy', input_type: 'radio', order_index: 0,
    options: JSON.stringify([
      { value: '18-25', label: '18–25' },
      { value: '26-35', label: '26–35' },
      { value: '36-45', label: '36–45' },
      { value: '46-60', label: '46–60' },
      { value: '60+', label: '60+' },
    ]),
  },
  {
    field_key: 'residence', label: 'Miejsce zamieszkania', input_type: 'radio', order_index: 1,
    options: JSON.stringify([
      { value: 'duże miasto', label: 'Duże miasto (100 tys.+)' },
      { value: 'średnie miasto', label: 'Średnie miasto (10–100 tys.)' },
      { value: 'małe miasto', label: 'Małe miasto (poniżej 10 tys.)' },
      { value: 'wieś', label: 'Wieś' },
    ]),
  },
  {
    field_key: 'education', label: 'Wykształcenie', input_type: 'radio', order_index: 2,
    options: JSON.stringify([
      { value: 'podstawowe', label: 'Podstawowe' },
      { value: 'średnie', label: 'Średnie' },
      { value: 'wyższe licencjat', label: 'Wyższe (licencjat)' },
      { value: 'wyższe magister+', label: 'Wyższe (magister lub wyższe)' },
    ]),
  },
  {
    field_key: 'gender', label: 'Płeć', input_type: 'radio', order_index: 3,
    options: JSON.stringify([
      { value: 'kobieta', label: 'Kobieta' },
      { value: 'mężczyzna', label: 'Mężczyzna' },
      { value: 'inne', label: 'Inne' },
      { value: 'wolę nie podawać', label: 'Wolę nie podawać' },
    ]),
  },
];

function seedDefaultDemographicQuestions(studyId) {
  const existing = db.prepare('SELECT COUNT(*) as n FROM demographic_questions WHERE study_id = ?').get(studyId);
  if (existing && existing.n > 0) return;
  const insert = db.prepare(`
    INSERT INTO demographic_questions (study_id, field_key, label, input_type, options, required, order_index, is_active)
    VALUES (?, ?, ?, ?, ?, 1, ?, 1)
  `);
  const seedAll = db.transaction((sid) => {
    for (const q of DEFAULT_DEMOGRAPHIC_QUESTIONS) {
      insert.run(sid, q.field_key, q.label, q.input_type, q.options, q.order_index);
    }
  });
  seedAll(studyId);
}

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
migrate("ALTER TABLE studies ADD COLUMN layout_type TEXT DEFAULT 'feed'");
migrate('ALTER TABLE studies ADD COLUMN show_reactions BOOLEAN DEFAULT 1');
migrate('ALTER TABLE studies ADD COLUMN enable_comments BOOLEAN DEFAULT 0');
migrate('ALTER TABLE ratings ADD COLUMN comment TEXT');
migrate('ALTER TABLE studies ADD COLUMN show_instructions BOOLEAN DEFAULT 1');
migrate('ALTER TABLE studies ADD COLUMN show_transition_feed BOOLEAN DEFAULT 1');
migrate('ALTER TABLE studies ADD COLUMN show_transition_rating BOOLEAN DEFAULT 1');
migrate('ALTER TABLE studies ADD COLUMN show_debrief BOOLEAN DEFAULT 1');
migrate('ALTER TABLE posts ADD COLUMN post_comment TEXT');
migrate('ALTER TABLE posts ADD COLUMN post_comment_author TEXT');
migrate("ALTER TABLE studies ADD COLUMN label_action_like TEXT DEFAULT 'Lubię to'");
migrate("ALTER TABLE studies ADD COLUMN label_action_dislike TEXT DEFAULT 'Nie lubię'");
migrate("ALTER TABLE studies ADD COLUMN label_action_share TEXT DEFAULT 'Udostępnij'");
migrate("ALTER TABLE studies ADD COLUMN label_action_flag TEXT DEFAULT 'Zgłoś'");
migrate("ALTER TABLE studies ADD COLUMN label_likert_question TEXT DEFAULT 'Jak oceniasz wiarygodność tego postu?'");
migrate("ALTER TABLE studies ADD COLUMN label_likert_min TEXT DEFAULT 'Zupełnie niewiarygodna'");
migrate("ALTER TABLE studies ADD COLUMN label_likert_max TEXT DEFAULT 'W pełni wiarygodna'");
migrate("ALTER TABLE studies ADD COLUMN comment_placeholder TEXT DEFAULT 'Napisz komentarz do tego postu...'");
migrate("ALTER TABLE studies ADD COLUMN label_style_a TEXT DEFAULT 'Styl A (manipulacyjny)'");
migrate("ALTER TABLE studies ADD COLUMN label_style_b TEXT DEFAULT 'Styl B (neutralny)'");
migrate('ALTER TABLE studies ADD COLUMN metric_conditions_json TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN show_metrics INTEGER DEFAULT 1');
migrate('ALTER TABLE posts ADD COLUMN metrics_override_json TEXT DEFAULT NULL');
migrate('ALTER TABLE posts ADD COLUMN post_comments_json TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN condition_queue_json TEXT DEFAULT NULL');
migrate('ALTER TABLE posts ADD COLUMN updated_at DATETIME DEFAULT NULL');
migrate('ALTER TABLE posts ADD COLUMN image_path_a TEXT DEFAULT NULL');
migrate('ALTER TABLE posts ADD COLUMN image_path_b TEXT DEFAULT NULL');
migrate('ALTER TABLE posts ADD COLUMN avatar_path TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN clarity_enabled INTEGER DEFAULT 0');
migrate('ALTER TABLE studies ADD COLUMN clarity_project_id TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN eyetracking_enabled INTEGER DEFAULT 0');
migrate('ALTER TABLE sessions ADD COLUMN eyetracking_consent INTEGER DEFAULT NULL');
migrate('ALTER TABLE sessions ADD COLUMN calibration_error REAL DEFAULT NULL');
migrate('ALTER TABLE sessions ADD COLUMN n_recalibrations INTEGER DEFAULT 0');
migrate('ALTER TABLE sessions ADD COLUMN feed_snapshot TEXT DEFAULT NULL');
migrate(`CREATE TABLE IF NOT EXISTS gaze_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  post_id INTEGER,
  post_order INTEGER,
  screen_name TEXT,
  t INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  vw INTEGER,
  vh INTEGER,
  scroll_y INTEGER,
  aoi TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
)`);
migrate('CREATE INDEX IF NOT EXISTS idx_gaze_session ON gaze_points(session_id)');
migrate('CREATE INDEX IF NOT EXISTS idx_gaze_post ON gaze_points(session_id, post_id)');
migrate(`ALTER TABLE studies ADD COLUMN language TEXT DEFAULT 'pl'`);
migrate(`ALTER TABLE studies ADD COLUMN translations_json TEXT DEFAULT '{}'`);
migrate(`ALTER TABLE studies ADD COLUMN participant_title TEXT DEFAULT NULL`);
// ── Builder feature ───────────────────────────────────────────────────────────
migrate('ALTER TABLE studies ADD COLUMN builder_mode INTEGER DEFAULT 0');
migrate('ALTER TABLE studies ADD COLUMN parts_json TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN logic_json TEXT DEFAULT NULL');
// Conditional logic: records which parts a rule skipped for a session, so the
// export can tell "skipped by rule" apart from "never reached" / "completed".
migrate('ALTER TABLE sessions ADD COLUMN logic_skipped_parts_json TEXT DEFAULT NULL');
migrate('ALTER TABLE sessions ADD COLUMN logic_end_rule_id TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN no_consent_text TEXT DEFAULT NULL');
migrate('ALTER TABLE sessions ADD COLUMN is_preview INTEGER DEFAULT 0');
migrate(`CREATE TABLE IF NOT EXISTS post_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  question_type TEXT NOT NULL DEFAULT 'open',
  options_json TEXT DEFAULT '[]',
  required INTEGER DEFAULT 1,
  order_index INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
)`);
migrate(`CREATE TABLE IF NOT EXISTS post_question_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL,
  post_order INTEGER,
  question_id INTEGER NOT NULL REFERENCES post_questions(id) ON DELETE CASCADE,
  response_text TEXT,
  response_values_json TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
migrate('CREATE INDEX IF NOT EXISTS idx_pqr_session ON post_question_responses(session_id)');
migrate(`ALTER TABLE studies ADD COLUMN post_questions_display_mode TEXT DEFAULT 'after_interaction'`);
migrate(`ALTER TABLE studies ADD COLUMN manipulation_field TEXT DEFAULT 'headline'`);
migrate(`ALTER TABLE studies ADD COLUMN manipulation_variants INTEGER DEFAULT 2`);
migrate(`ALTER TABLE studies ADD COLUMN manipulation_json TEXT DEFAULT '[]'`);
migrate(`ALTER TABLE posts ADD COLUMN part_id TEXT DEFAULT NULL`);
// Multi-part assignment: a single post can appear in multiple parts of the
// study (e.g. part 1 = feed for reactions, part 2 = paged with questions on
// the same posts). part_ids_json holds the canonical list when present; if
// NULL the runtime falls back to [part_id] so every pre-migration post
// continues to behave identically. We also keep part_id in sync with the
// first element of the JSON array — legacy queries / exports that read
// part_id directly keep working without change.
migrate(`ALTER TABLE posts ADD COLUMN part_ids_json TEXT DEFAULT NULL`);
migrate(`ALTER TABLE post_questions ADD COLUMN part_id TEXT DEFAULT NULL`);
// Part-scoped responses (pq_display_mode = 'after_all_posts'): one screen of
// questions appears after the LAST post of a part instead of per-post.
// Schema choice: keep post_id INTEGER NOT NULL (SQLite can't ALTER nullable
// in-place without table recreate) → store sentinel post_id=0 and put the
// real anchor in this nullable `part_id` column. Researchers can detect
// part-scoped rows via `part_id IS NOT NULL` (more reliable than `post_id=0`).
migrate(`ALTER TABLE post_question_responses ADD COLUMN part_id TEXT DEFAULT NULL`);
// Per-study UI visibility toggles. All default to 1 (visible/enabled) so
// existing studies keep their pre-toggle behavior. Set to 0 in the builder
// to hide the corresponding element:
//   show_instruction_actions — the "👍 Lubię to / 👎 Nie lubię / …" preview
//     box rendered above the "Rozumiem, zaczynam" CTA on the instruction
//     screen. Off by default makes sense when the study disables reactions.
//   show_avatars — round avatar pill rendered to the left of each post's
//     source/handle. Off → posts render without the avatar column.
//   show_demographics — the entire demographics screen between consent and
//     the feed. Off → flow jumps straight from consent to the feed/paged
//     view; sessions get NULL demographic fields in the export.
migrate(`ALTER TABLE studies ADD COLUMN show_instruction_actions INTEGER DEFAULT 1`);
migrate(`ALTER TABLE studies ADD COLUMN show_avatars INTEGER DEFAULT 1`);
migrate(`ALTER TABLE studies ADD COLUMN show_demographics INTEGER DEFAULT 1`);
// Where in the participant flow the demographic questions appear. Three values:
//   'after_consent'  — legacy default, demographics screen runs right after
//                       consent (before instructions / feed)
//   'before_debrief' — demographics moved to the very end of the study, just
//                       before the debrief screen. Useful when researchers
//                       worry that demographic priming biases the main task.
//   'hidden'         — skipped entirely (mirrors show_demographics=0).
// Defaults to 'after_consent' so every existing study keeps its current flow.
// Resolution order (backend): study.demographics_position takes precedence;
// fall back to study.show_demographics for studies that haven't been touched
// since the dropdown was added (show_demographics=0 → 'hidden').
migrate(`ALTER TABLE studies ADD COLUMN demographics_position TEXT DEFAULT 'after_consent'`);
// Per-study overrides for the demographics-screen header text. Editing the
// platform-wide locale file works in-container but Railway wipes those
// edits on every redeploy, so any researcher who needs persistent custom
// wording needs a DB-backed override. NULL/empty = use the locale default
// (demographics.title / demographics.subtitle). Frontend prefers the
// study value when set.
migrate(`ALTER TABLE studies ADD COLUMN demographics_title TEXT DEFAULT NULL`);
migrate(`ALTER TABLE studies ADD COLUMN demographics_subtitle TEXT DEFAULT NULL`);
// Per-post avatar visibility — overrides the study-level studies.show_avatars.
// Default 1 so existing posts keep their current behavior; researcher can flip
// individual posts to 0 in the post editor (e.g. anonymous source variants).
migrate(`ALTER TABLE posts ADD COLUMN show_avatar INTEGER DEFAULT 1`);
// Per-post interaction toggles — researcher picks WHICH reaction buttons
// appear under each post. Combined gating: a button shows iff
// (study.show_reactions != 0) AND (part.show_reactions != false)
// AND (post.show_<action> != 0). Defaults preserve legacy behavior: all
// four reactions visible by default, and the comment field follows the
// same per-post toggle so it can be enabled per-post (still gated by
// study.enable_comments at the study level — comment shows iff
// study.enable_comments AND post.show_comment != 0).
migrate(`ALTER TABLE posts ADD COLUMN show_like INTEGER DEFAULT 1`);
migrate(`ALTER TABLE posts ADD COLUMN show_dislike INTEGER DEFAULT 1`);
migrate(`ALTER TABLE posts ADD COLUMN show_share INTEGER DEFAULT 1`);
migrate(`ALTER TABLE posts ADD COLUMN show_flag INTEGER DEFAULT 1`);
migrate(`ALTER TABLE posts ADD COLUMN show_comment INTEGER DEFAULT 1`);
// Feed-mode participant comments. Paged layout has /paged-response which
// persists comments alongside the rating row, but feed mode posts straight
// to /api/reaction and had nowhere to land the comment text. Adding a
// nullable column on reactions lets us carry the comment on the same row
// as its action — one query, no JOIN dance needed in the export.
migrate(`ALTER TABLE reactions ADD COLUMN comment TEXT`);
// Multi-react feature. When studies.allow_multi_reactions=1, a participant
// can stack non-opposing reactions on the same post (like+share+flag) and
// re-click toggles a reaction off. Like/dislike stay mutually exclusive
// regardless. reactions.is_undo records the toggle-off click so the
// append-only reactions log preserves "they un-liked it at time T"
// rather than just dropping the event silently. Default 0 → every
// historical row is treated as a positive reaction.
migrate(`ALTER TABLE studies ADD COLUMN allow_multi_reactions INTEGER DEFAULT 0`);
migrate(`ALTER TABLE reactions ADD COLUMN is_undo INTEGER DEFAULT 0`);
migrate(`ALTER TABLE posts ADD COLUMN builder_comments_json TEXT DEFAULT '[]'`);
migrate(`ALTER TABLE sessions ADD COLUMN demographics_extra_json TEXT DEFAULT '{}'`);
migrate(`ALTER TABLE posts ADD COLUMN hide_topic INTEGER DEFAULT 0`);
// "Posts — true and false" section in the debrief screen, listing each post
// with a TRUE/FALSE badge. Researcher-configurable per study; default ON for
// backward compat with studies created before the toggle existed.
migrate(`ALTER TABLE studies ADD COLUMN show_debrief_posts INTEGER DEFAULT 1`);
// Per-study export builder configuration. Stores researcher's current view
// state (column order, visibility, custom headers) per sheet name. Empty
// object {} means "use defaults for every sheet". This is purely a
// presentation layer — the underlying DB data is never modified by the
// builder. Forward-compatible: keys not in config use defaults.
migrate(`ALTER TABLE studies ADD COLUMN export_config_json TEXT DEFAULT '{}'`);
// Named saved profiles, separate from the working config above. Lets the
// researcher snapshot e.g. "Minimal", "Demographics only", "Full" and
// switch between them. Shape: { "<profile name>": { "<sheet>": {columns:[…]} } }.
migrate(`ALTER TABLE studies ADD COLUMN export_profiles_json TEXT DEFAULT '{}'`);
// Saved statistical analyses per study. Each entry: { id, name, test, params,
// created_at }. params is test-specific (which columns, grouping var, etc.).
// Results are NOT cached — re-computed on every load against current data.
migrate(`ALTER TABLE studies ADD COLUMN analyses_json TEXT DEFAULT '[]'`);
// Dashboard widget configuration per study. Stored shape:
//   { "widgets": [{ id, type, title, ...type-specific, position?:{x,y,w,h} }] }
// Empty {} → smart defaults generated on first load based on study schema
// (manipulation, post questions, demographics). Widget data is recomputed
// on every load against current sessions — no caching, always fresh.
migrate(`ALTER TABLE studies ADD COLUMN dashboard_config_json TEXT DEFAULT '{}'`);
// Named dashboard profiles (snapshot of widget arrangements). Same pattern as
// studies.export_profiles_json. Researcher saves e.g. "Recruitment monitoring"
// vs "Analysis-ready" and switches between them.
migrate(`ALTER TABLE studies ADD COLUMN dashboard_profiles_json TEXT DEFAULT '{}'`);
// ── Images stored as BLOBs in the database (not on filesystem) ───────────────
// Railway's filesystem is ephemeral — even with UPLOADS_PATH pointing at a
// mounted volume, the volume's relationship to the uploads subdirectory is
// fragile. Storing image data alongside the row that owns it means images
// survive every deploy as long as the database does.
migrate(`ALTER TABLE posts ADD COLUMN image_blob_a BLOB`);
migrate(`ALTER TABLE posts ADD COLUMN image_mime_a TEXT`);
migrate(`ALTER TABLE posts ADD COLUMN image_blob_b BLOB`);
migrate(`ALTER TABLE posts ADD COLUMN image_mime_b TEXT`);
migrate(`ALTER TABLE posts ADD COLUMN avatar_blob BLOB`);
migrate(`ALTER TABLE posts ADD COLUMN avatar_mime TEXT`);
migrate(`CREATE TABLE IF NOT EXISTS demographic_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  input_type TEXT DEFAULT 'radio',
  options TEXT DEFAULT '[]',
  required INTEGER DEFAULT 1,
  order_index INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1
)`);
// Platform-wide locale overrides — lives in the DB so admin edits in the
// "Tłumaczenia interfejsu" modal survive every Railway redeploy. JSON
// files in public/locales/*.json provide the baseline (committed to the
// repo); rows here override on a per-key basis. lang+key composite PK
// keeps lookups O(1) and prevents duplicates. NULL value = explicit
// "use the file default" — we delete the row in that case so the
// table only carries actual overrides.
migrate(`CREATE TABLE IF NOT EXISTS locale_overrides (
  lang TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (lang, key)
)`);
// Validation bounds for freeform demographic inputs (input_type='text' or
// 'number'). For text: minimum / maximum character count. For number:
// minimum / maximum numeric value. NULL = no constraint (legacy behaviour
// — every pre-migration row reads as "no min, no max").
migrate(`ALTER TABLE demographic_questions ADD COLUMN min_value REAL DEFAULT NULL`);
migrate(`ALTER TABLE demographic_questions ADD COLUMN max_value REAL DEFAULT NULL`);

// Dwell tracking for posts the participant viewed but did NOT react to.
// Without this, the reactions row is the only place we record viewing time
// per post, so a participant who scrolled past three posts and only liked
// the fourth gives us zero data on the first three. post_views fills that
// gap — one row per (session, post) with cumulative dwell. Export then
// uses reactions.dwell_ms when present, post_views.dwell_ms as fallback.
//
// Composite PK on (session_id, post_id) so the client can upsert the same
// row as the participant returns to a post (allow_back) — we accumulate
// dwell rather than overwriting. first_seen_at/last_seen_at bracket the
// total viewing window for any timeline analyses the researcher does
// later.
migrate(`CREATE TABLE IF NOT EXISTS post_views (
  session_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  post_order INTEGER,
  dwell_ms INTEGER DEFAULT 0,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, post_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
)`);

// Panel-recruitment integration. Research agencies (CINT, panele krajowe,
// własne panele agencji) recruit participants by handing them a study URL
// with the respondent's panel ID glued on as a query parameter, then expect
// the platform to (a) capture that ID with each session so they can map our
// completions back to their participants, and (b) bounce the participant
// back to a "completion URL" after the debrief so the panel can credit
// them points / mark the task done.
//
// Per-study config:
//   external_id_param_name — name of the URL query param to capture (the
//     agency dictates this; CINT uses 'pid', some panels 'res_id',
//     'respondent_id'). Default 'res_id' covers the common case but every
//     study can override.
//   completion_redirect_url — URL the participant is bounced to AFTER the
//     debrief screen. Supports {ext_id} and {session_id} placeholders so
//     the agency can identify which respondent finished. NULL = no
//     redirect, standard end-screen flow (the default for studies that
//     aren't panel-recruited — zero behaviour change).
//
// Per-session capture:
//   sessions.external_id — the captured value at session start, kept on
//     the row forever (independent of any later study config edits).
migrate(`ALTER TABLE studies ADD COLUMN external_id_param_name TEXT DEFAULT 'res_id'`);
migrate(`ALTER TABLE studies ADD COLUMN completion_redirect_url TEXT DEFAULT NULL`);
migrate(`ALTER TABLE sessions ADD COLUMN external_id TEXT DEFAULT NULL`);

// ── Post library ────────────────────────────────────────────────────────────
// A study-agnostic catalogue of reusable posts. A library post can be COPIED
// into any study (POST /studies/:id/posts/from-library); the copy is fully
// independent — later edits to the study post never touch the library source,
// and vice versa. posts.library_post_id is an immutable audit pointer only
// (NO foreign key, so deleting a library post can't cascade-delete study posts).
// POST_LIBRARY_CONTENT_COLS lists the post columns a library entry carries
// (everything content-related; NOT study_id/order_index/part_id) — shared by the
// table definition, the copy-into-study INSERT…SELECT, and the CRUD endpoints.
const POST_LIBRARY_CONTENT_COLS = [
  'topic', 'emoji', 'source_name', 'source_handle', 'time_ago',
  'headline_a', 'content_a', 'headline_b', 'content_b', 'is_true',
  'manipulation_techniques', 'image_path', 'image_path_a', 'image_path_b', 'avatar_path',
  'base_likes', 'base_shares', 'base_dislikes', 'base_flags',
  'post_comment', 'post_comment_author', 'metrics_override_json', 'post_comments_json',
  'builder_comments_json', 'hide_topic',
  'image_blob_a', 'image_mime_a', 'image_blob_b', 'image_mime_b', 'avatar_blob', 'avatar_mime',
  'show_avatar', 'show_like', 'show_dislike', 'show_share', 'show_flag', 'show_comment',
];
db.exec(`
  CREATE TABLE IF NOT EXISTS post_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT,
    translations_json TEXT DEFAULT '{}',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    topic TEXT, emoji TEXT, source_name TEXT, source_handle TEXT, time_ago TEXT,
    headline_a TEXT, content_a TEXT, headline_b TEXT, content_b TEXT, is_true INTEGER DEFAULT 0,
    manipulation_techniques TEXT DEFAULT '[]',
    image_path TEXT, image_path_a TEXT, image_path_b TEXT, avatar_path TEXT,
    base_likes INTEGER DEFAULT 0, base_shares INTEGER DEFAULT 0, base_dislikes INTEGER DEFAULT 0, base_flags INTEGER DEFAULT 0,
    post_comment TEXT, post_comment_author TEXT, metrics_override_json TEXT, post_comments_json TEXT,
    builder_comments_json TEXT, hide_topic INTEGER DEFAULT 0,
    image_blob_a BLOB, image_mime_a TEXT, image_blob_b BLOB, image_mime_b TEXT, avatar_blob BLOB, avatar_mime TEXT,
    show_avatar INTEGER DEFAULT 1, show_like INTEGER DEFAULT 1, show_dislike INTEGER DEFAULT 1,
    show_share INTEGER DEFAULT 1, show_flag INTEGER DEFAULT 1, show_comment INTEGER DEFAULT 1
  );
`);
migrate('ALTER TABLE posts ADD COLUMN library_post_id INTEGER DEFAULT NULL');
db.POST_LIBRARY_CONTENT_COLS = POST_LIBRARY_CONTENT_COLS;

// Custom hostname binding — when a study is hosted under a dedicated
// subdomain (e.g. badanie-misinfo.swps.pl), the server routes requests to
// that hostname directly to this study and blocks everything else on the
// same host (no admin, no other studies, no dashboard). Researchers
// pointing the URL on social media / panel recruitment ads to the bare
// host see just their study — never the admin login.
//
// The bound hostname must be exact (no wildcards, www-prefix normalization
// is the operator's job in DNS). NULL = no binding, study reachable only
// via /study/<slug> on whatever host runs the app. UNIQUE-enforced at the
// query level (host→study lookup returns one row), not at the schema
// level — SQLite ALTER TABLE can't add UNIQUE constraints retroactively.
migrate(`ALTER TABLE studies ADD COLUMN custom_domain TEXT DEFAULT NULL`);

// Panel-recruitment endlink UX — fine-tuning controls per study.
//   completion_redirect_delay_seconds: how long the participant sees the
//     debrief before auto-navigation fires. Default 4s — researcher-friendly
//     across most panels. Can be raised when the debrief contains material
//     the participant should actually read; lowered to 0 when the agency
//     wants the redirect immediately. Hard-capped at 600 (10 min) in
//     server payload so a typo can't trap the participant.
//   completion_redirect_notice: custom text rendered inside a sticky
//     box at the top of the debrief, ABOVE the debrief content. Lets
//     researchers tell the participant exactly what's about to happen
//     ("po zakończeniu wrócisz na panel X i naliczy się punkt") instead
//     of the generic "you'll be redirected" line. The same box hosts a
//     "Wróć do panelu" button — clicking fires the redirect immediately
//     regardless of the timer. NULL = no sticky box, only the timer
//     fires the redirect, and only the small inline notice from the
//     previous implementation is shown.
migrate(`ALTER TABLE studies ADD COLUMN completion_redirect_delay_seconds INTEGER DEFAULT 4`);
migrate(`ALTER TABLE studies ADD COLUMN completion_redirect_notice TEXT DEFAULT NULL`);

// Decline endlink — separate URL the participant is bounced to when they
// REFUSE consent on the first screen. Panels treat "screen-out" differently
// from "complete" (no points awarded, just close the loop), and the URL
// often differs from the completion endpoint. Mirrors the three completion
// fields exactly so the admin UX is symmetric: URL + delay + optional
// sticky notice on the no-consent thank-you screen. NULL URL = participant
// stays on the local "Rozumiemy Twoją decyzję" screen and closes the tab
// (the default — non-panel studies don't need a screen-out endpoint).
migrate(`ALTER TABLE studies ADD COLUMN decline_redirect_url TEXT DEFAULT NULL`);
migrate(`ALTER TABLE studies ADD COLUMN decline_redirect_delay_seconds INTEGER DEFAULT 4`);
migrate(`ALTER TABLE studies ADD COLUMN decline_redirect_notice TEXT DEFAULT NULL`);

// Decline endlink — bypass the local "Rozumiemy Twoją decyzję" screen
// entirely and navigate to the agency URL the moment the participant
// clicks "Nie wyrażam zgody". For panels that want full control of the
// post-decline UX (their own thank-you screen, immediate close, etc.)
// the intermediate local screen + 4s timer + sticky banner are noise.
// Only honored when decline_redirect_url is set; ignored otherwise.
// Default 0 = previous behaviour (show local screen, then timer-driven
// redirect if URL configured).
migrate(`ALTER TABLE studies ADD COLUMN decline_redirect_immediate INTEGER DEFAULT 0`);

// ── Multi-user accounts ──────────────────────────────────────────────────────
// Invite-only accounts (an admin creates users); every study is PRIVATE to its
// owner. Participants stay fully unauthenticated — only the admin panel is
// user-scoped. studies.owner_id is nullable so the ALTER can't fail on the
// existing table; the seed below backfills it. Child tables (posts, sessions,
// demographic_questions, post_questions) resolve ownership by joining up to
// studies.owner_id, so they need no new column. post_library + locales stay
// global (shared catalogue / config).
migrate(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'researcher',   -- 'admin' | 'researcher'
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT DEFAULT NULL
  )
`);
migrate(`ALTER TABLE studies ADD COLUMN owner_id INTEGER DEFAULT NULL REFERENCES users(id)`);
migrate(`CREATE INDEX IF NOT EXISTS idx_studies_owner ON studies(owner_id)`);

// Seed the first admin from ADMIN_PASSWORD and hand every pre-existing (unowned)
// study to it — so nothing breaks on the first deploy of the multi-user build.
// ADMIN_PASSWORD is used ONLY to seed this one row; after that, login checks the
// bcrypt hash in the users table (changing the env var later has no effect).
// Safe + idempotent: only runs when there are no users yet, and skips silently
// (no process exit) when ADMIN_PASSWORD isn't present, so CLI scripts that
// require this module without a loaded .env don't crash.
{
  const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!anyUser) {
    const pw = process.env.ADMIN_PASSWORD;
    if (pw) {
      const bcrypt = require('bcryptjs');
      const info = db.prepare(
        `INSERT INTO users (username, email, password_hash, role, is_active)
         VALUES ('admin', NULL, ?, 'admin', 1)`
      ).run(bcrypt.hashSync(pw, 12));
      const back = db.prepare('UPDATE studies SET owner_id = ? WHERE owner_id IS NULL').run(info.lastInsertRowid);
      console.log(`[accounts] Seeded admin user "admin"; assigned ${back.changes} existing studies to it.`);
    } else {
      console.warn('[accounts] No users yet and ADMIN_PASSWORD not set — admin seed skipped. Set ADMIN_PASSWORD and restart to create the first admin.');
    }
  }
}

// Initialise metric_conditions_json from legacy columns for any study that doesn't have it yet
{
  const studies = db.prepare('SELECT * FROM studies WHERE metric_conditions_json IS NULL').all();
  const upd = db.prepare('UPDATE studies SET metric_conditions_json = ? WHERE id = ?');
  for (const s of studies) {
    upd.run(JSON.stringify([
      { key: 'HIGH', label: 'Metryki HIGH', min: s.high_metrics_min || 800, max: s.high_metrics_max || 1300, enabled: s.enable_metrics_high ? true : false },
      { key: 'LOW',  label: 'Metryki LOW',  min: s.low_metrics_min  || 1,   max: s.low_metrics_max  || 20,   enabled: s.enable_metrics_low  ? true : false },
    ]), s.id);
  }
}

// ── REMOVED: Auto-overwrite seed migration block ──────────────────────────────
// Earlier versions had an "idempotent" UPDATE here that ran on every app
// boot, rewriting source_name / source_handle / headline_a/b / content_a/b
// on posts matching (topic, order_index). The "idempotent" framing was
// wrong: it was idempotent for fresh-seeded studies but DESTRUCTIVE for any
// study where the researcher had edited those fields — every Railway restart
// silently overwrote those edits with the prefab NIZP PZH-PIB / IMGW-PIB /
// Eurostat content. A user reported their cleared source_names reappearing
// across deploys. If specific seed revisions are needed in the future, run
// `node update_seed_posts.js` manually against the target environment.

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
db.seedDefaultDemographicQuestions = seedDefaultDemographicQuestions;

// ── Locale loading with DB overlay ───────────────────────────────────────────
// Reads the baseline locale file from public/locales/<lang>.json (committed
// to the repo), then overlays any rows from locale_overrides for that lang
// so admin edits in the platform translations modal take effect AND survive
// redeploys. flat/unflat helpers convert between dot-path keys (how the
// override table stores them) and the nested objects the frontend t() helper
// expects. Keep both forms cached lightly — caller hits the DB on every
// session/start which is fine for our volume.
function flattenLocaleObj(obj, prefix) {
  const out = {};
  const pre = prefix ? prefix + '.' : '';
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenLocaleObj(v, pre + k));
    } else {
      out[pre + k] = v;
    }
  }
  return out;
}
function unflattenLocale(flat) {
  const out = {};
  for (const k of Object.keys(flat)) {
    const parts = k.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = flat[k];
  }
  return out;
}
function loadLocaleWithOverrides(lang) {
  const fileFlat = {};
  try {
    const localePath = path.join(__dirname, '..', 'public', 'locales', `${lang}.json`);
    const raw = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    Object.assign(fileFlat, flattenLocaleObj(raw));
  } catch {}
  try {
    const rows = db.prepare('SELECT key, value FROM locale_overrides WHERE lang = ?').all(lang);
    for (const r of rows) {
      if (r.value != null) fileFlat[r.key] = r.value;
    }
  } catch {}
  return unflattenLocale(fileFlat);
}
db.loadLocaleWithOverrides = loadLocaleWithOverrides;
db.flattenLocaleObj = flattenLocaleObj;
db.unflattenLocale = unflattenLocale;

// ── Migration-default strings for legacy per-study label columns ──────────────
// Each migrated label_* / comment_placeholder column has a hardcoded Polish
// default string baked into ALTER TABLE … DEFAULT '…' (see migrations above).
// Every study is born with those values, so the participant frontend's
// `study.x || t('actions.x')` chain always picks the column over the locale,
// silently swallowing platform translation edits.
//
// Goal: zero hardcoded Polish text inside RENDER code. The migration defaults
// are derived ONCE at boot from public/locales/pl.json (the canonical PL
// baseline that the migration strings were copied from in the first place).
// FIELD_TO_LOCALE_KEY is the ONLY hardcoded thing — and it's metadata
// (DB column ↔ locale key), not user-visible text.
const FIELD_TO_LOCALE_KEY = {
  label_action_like:      'actions.like',
  label_action_dislike:   'actions.dislike',
  label_action_share:     'actions.share',
  label_action_flag:      'actions.flag',
  label_likert_question:  'actions.likert_question',
  label_likert_min:       'actions.likert_min',
  label_likert_max:       'actions.likert_max',
  comment_placeholder:    'actions.comment_placeholder',
};
function buildStudyLabelDefaults() {
  // Read pl.json directly (no DB overlay). DB overrides apply to RUNTIME
  // resolution; the defaults map needs the FILE baseline so we can detect
  // "researcher never customised" against the migration-time default value.
  let baseline = {};
  try {
    const p = path.join(__dirname, '..', 'public', 'locales', 'pl.json');
    baseline = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  const out = {};
  for (const [col, key] of Object.entries(FIELD_TO_LOCALE_KEY)) {
    let v = baseline;
    for (const part of key.split('.')) v = v?.[part];
    if (typeof v === 'string') out[col] = v;
  }
  return out;
}
db.FIELD_TO_LOCALE_KEY = FIELD_TO_LOCALE_KEY;
db.STUDY_LABEL_DEFAULTS = buildStudyLabelDefaults();

// ── One-time migration: read any disk-resident image files into BLOB columns ──
// Idempotent (skips posts that already have BLOBs). Safe to run on every boot.
(function migrateExistingImagesToBlobs() {
  const uploadsDir = path.resolve(process.env.UPLOADS_PATH || './uploads');
  if (!fs.existsSync(uploadsDir)) return;
  const rows = db.prepare(`
    SELECT id, study_id,
           image_path, image_path_a, image_path_b, avatar_path,
           image_blob_a, image_blob_b, avatar_blob
    FROM posts
  `).all();
  const mimeFor = ext => {
    const e = (ext || '').toLowerCase().replace(/^\./, '');
    if (e === 'png') return 'image/png';
    if (e === 'webp') return 'image/webp';
    if (e === 'gif') return 'image/gif';
    return 'image/jpeg';
  };
  let migrated = 0;
  const upd = {
    image_a: db.prepare('UPDATE posts SET image_blob_a = ?, image_mime_a = ? WHERE id = ?'),
    image_b: db.prepare('UPDATE posts SET image_blob_b = ?, image_mime_b = ? WHERE id = ?'),
    avatar:  db.prepare('UPDATE posts SET avatar_blob = ?, avatar_mime = ? WHERE id = ?'),
  };
  for (const p of rows) {
    const tasks = [];
    // image_path_a OR legacy image_path (only when image_path_a is null)
    const aPath = p.image_path_a || (p.image_path && !p.image_path_a ? p.image_path : null);
    if (aPath && !p.image_blob_a) tasks.push({ key: 'image_a', filename: aPath });
    if (p.image_path_b && !p.image_blob_b) tasks.push({ key: 'image_b', filename: p.image_path_b });
    if (p.avatar_path && !p.avatar_blob)   tasks.push({ key: 'avatar', filename: p.avatar_path });
    for (const t of tasks) {
      const fp = path.join(uploadsDir, String(p.study_id), t.filename);
      if (!fs.existsSync(fp)) continue;
      try {
        const buf = fs.readFileSync(fp);
        const ext = path.extname(t.filename);
        upd[t.key].run(buf, mimeFor(ext), p.id);
        migrated++;
      } catch (e) { /* skip unreadable files */ }
    }
  }
  if (migrated) console.log(`[image-migration] Loaded ${migrated} image(s) from disk into DB BLOBs`);
})();

module.exports = db;
