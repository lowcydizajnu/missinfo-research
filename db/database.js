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
migrate("ALTER TABLE studies ADD COLUMN label_style_a TEXT DEFAULT 'Styl A (manipulacyjny)'");
migrate("ALTER TABLE studies ADD COLUMN label_style_b TEXT DEFAULT 'Styl B (neutralny)'");
migrate('ALTER TABLE studies ADD COLUMN metric_conditions_json TEXT DEFAULT NULL');
migrate('ALTER TABLE studies ADD COLUMN show_metrics INTEGER DEFAULT 1');

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

// ── Post content migrations (idempotent UPDATE — safe to run on every boot) ───
const migratePost = db.prepare(
  `UPDATE posts SET source_name=?, source_handle=?, headline_a=?, content_a=?, headline_b=?, content_b=?
   WHERE topic=? AND order_index=?`
);
const migratePostB = db.prepare(
  `UPDATE posts SET headline_b=?, content_b=? WHERE topic=? AND order_index=?`
);

db.transaction(() => {
  // TRUE posts — source + both headline/content
  migratePost.run(
    'NIZP PZH-PIB', '@nizp_pzh',
    'Ponad połowa dorosłych Polaków ma nadwagę — raport NIZP PZH 2025',
    'Badanie reprezentatywnej próby przeprowadzone przez Narodowy Instytut Zdrowia Publicznego wykazało, że 55,8% mieszkańców Polski powyżej 20. roku życia ma zbyt wysoką masę ciała, a 13,9% spełnia kryteria otyłości. Raport wskazuje na stagnację oczekiwanej długości życia i pogarszający się stan zdrowia psychicznego Polaków. [Źródło: NIZP PZH-PIB, czerwiec 2025]',
    'Ponad połowa dorosłych Polaków ma nadwagę — raport NIZP PZH 2025',
    'Badanie reprezentatywnej próby przeprowadzone przez Narodowy Instytut Zdrowia Publicznego wykazało, że 55,8% mieszkańców Polski powyżej 20. roku życia ma zbyt wysoką masę ciała, a 13,9% spełnia kryteria otyłości. Raport wskazuje na stagnację oczekiwanej długości życia i pogarszający się stan zdrowia psychicznego Polaków. [Źródło: NIZP PZH-PIB, czerwiec 2025]',
    'zdrowie', 2
  );
  migratePost.run(
    'IMGW-PIB', '@imgw_pl',
    'Rok 2025 był 9. najcieplejszym w historii pomiarów w Polsce — dane IMGW',
    'Instytut Meteorologii i Gospodarki Wodnej potwierdza, że 2025 rok był o 0,8°C cieplejszy od normy wieloletniej (1991–2020) i klasyfikuje się jako rok bardzo ciepły niemal we wszystkich regionach kraju. Najcieplejszym regionem było Podkarpacie. Od 1951 roku temperatura latem w Polsce wzrosła łącznie o 2,3°C. [Źródło: IMGW-PIB, styczeń 2026]',
    'Rok 2025 był 9. najcieplejszym w historii pomiarów w Polsce — dane IMGW',
    'Instytut Meteorologii i Gospodarki Wodnej potwierdza, że 2025 rok był o 0,8°C cieplejszy od normy wieloletniej (1991–2020) i klasyfikuje się jako rok bardzo ciepły niemal we wszystkich regionach kraju. Najcieplejszym regionem było Podkarpacie. Od 1951 roku temperatura latem w Polsce wzrosła łącznie o 2,3°C. [Źródło: IMGW-PIB, styczeń 2026]',
    'klimat', 4
  );
  migratePost.run(
    'Ministerstwo Rodziny i Pracy', '@mrpips_gov',
    'Nowa ustawa o rynku pracy obowiązuje od czerwca 2025 — zmiany zasad rejestracji bezrobotnych',
    'Ustawa o rynku pracy i służbach zatrudnienia, która weszła w życie 1 czerwca 2025 roku, zmieniła zasady działania urzędów pracy. Zniesiono m.in. obowiązek potwierdzania gotowości do podjęcia pracy oraz sankcję wykreślenia z rejestru za odrzucenie oferty zatrudnienia. [Źródło: MRPiPS, gov.pl, czerwiec 2025]',
    'Nowa ustawa o rynku pracy obowiązuje od czerwca 2025 — zmiany zasad rejestracji bezrobotnych',
    'Ustawa o rynku pracy i służbach zatrudnienia, która weszła w życie 1 czerwca 2025 roku, zmieniła zasady działania urzędów pracy. Zniesiono m.in. obowiązek potwierdzania gotowości do podjęcia pracy oraz sankcję wykreślenia z rejestru za odrzucenie oferty zatrudnienia. [Źródło: MRPiPS, gov.pl, czerwiec 2025]',
    'polityka', 6
  );
  migratePost.run(
    'Eurostat', '@eurostat',
    'Polska na podium UE — stopa bezrobocia 3,2% według Eurostatu (listopad 2025)',
    'Eurostat potwierdza, że Polska utrzymuje się w czołówce krajów Unii Europejskiej z najniższym bezrobociem. W listopadzie 2025 roku stopa bezrobocia według metodologii Eurostatu wyniosła 3,2% — drugi wynik w UE, ustępując jedynie Malcie (3,1%). Średnia stopa bezrobocia w całej UE wyniosła 6%. [Źródło: Eurostat, grudzień 2025]',
    'Polska na podium UE — stopa bezrobocia 3,2% według Eurostatu (listopad 2025)',
    'Eurostat potwierdza, że Polska utrzymuje się w czołówce krajów Unii Europejskiej z najniższym bezrobociem. W listopadzie 2025 roku stopa bezrobocia według metodologii Eurostatu wyniosła 3,2% — drugi wynik w UE, ustępując jedynie Malcie (3,1%). Średnia stopa bezrobocia w całej UE wyniosła 6%. [Źródło: Eurostat, grudzień 2025]',
    'ekonomia', 8
  );
  migratePost.run(
    'Project GOLIAT EU', '@goliat_eu',
    'Promieniowanie 5G poniżej norm bezpieczeństwa — największe badanie europejskie z udziałem Polski (2025)',
    'Badanie projektu GOLIAT finansowanego przez UE (Horizon Europe), obejmujące ponad 800 lokalizacji w 10 krajach europejskich w tym w Polsce, wykazało że ekspozycja środowiskowa na pola elektromagnetyczne sieci 5G nie przekracza międzynarodowych limitów bezpieczeństwa. Pomiary prowadzono w szkołach, węzłach komunikacyjnych i obszarach mieszkalnych. [Źródło: Project GOLIAT, Environment International, 2025]',
    'Promieniowanie 5G poniżej norm bezpieczeństwa — największe badanie europejskie z udziałem Polski (2025)',
    'Badanie projektu GOLIAT finansowanego przez UE (Horizon Europe), obejmujące ponad 800 lokalizacji w 10 krajach europejskich w tym w Polsce, wykazało że ekspozycja środowiskowa na pola elektromagnetyczne sieci 5G nie przekracza międzynarodowych limitów bezpieczeństwa. Pomiary prowadzono w szkołach, węzłach komunikacyjnych i obszarach mieszkalnych. [Źródło: Project GOLIAT, Environment International, 2025]',
    'nauka', 10
  );
  // FALSE posts — headline_b + content_b only
  db.prepare(`UPDATE posts SET headline_a=?, content_a=?, headline_b=?, content_b=? WHERE topic=? AND order_index=?`).run(
    'SZOKUJĄCE! Rząd wprowadza TAJNY podatek 2% od wszystkich kont bankowych — bez debaty w Sejmie!',
    'Banki już dostały instrukcje z ministerstwa. Przepisy przyjęto w trybie rozporządzenia, omijając Sejm! To co chcą przed Tobą ukryć. Ostrzeż rodzinę — udostępnij TERAZ!',
    'Ministerstwo Finansów w 2025 roku wprowadziło podatek w wysokości 2% od wszystkich depozytów bankowych, niezależnie od ich wartości',
    'Nowe przepisy zostały przyjęte w trybie rozporządzenia, z pominięciem standardowej procedury legislacyjnej. Obowiązek podatkowy dotyczy wszystkich rachunków oszczędnościowych i lokat terminowych prowadzonych przez polskie banki.',
    'polityka', 5
  );
  migratePostB.run(
    'Główne banki inwestycyjne potwierdziły, że rynki akcji w strefie euro odnotowały w 2025 roku spadek o ponad 35%',
    'Opublikowane raporty wskazują, że skala spadków spełnia definicję recesji technicznej. Ekonomiści z Goldman Sachs, JPMorgan i Deutsche Bank zgodnie klasyfikują sytuację jako najpoważniejszy kryzys finansowy od 2008 roku.',
    'ekonomia', 7
  );
})();

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
