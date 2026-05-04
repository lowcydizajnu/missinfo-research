'use strict';

/**
 * One-time migration: update existing seeded posts to match the revised
 * DEFAULT_POSTS content. Matches by (topic, order_index) within each study.
 *
 * Run with:  node update_seed_posts.js
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/research.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Patch definitions ─────────────────────────────────────────────────────────
// Each entry identifies the post by (topic, order_index) and specifies only
// the fields that changed.

const PATCHES = [
  // ── TRUE posts: source + both headline/content versions ──────────────────

  {
    _key: { topic: 'zdrowie', order_index: 2 },
    source_name: 'NIZP PZH-PIB',
    source_handle: '@nizp_pzh',
    headline_a: 'Ponad połowa dorosłych Polaków ma nadwagę — raport NIZP PZH 2025',
    content_a: 'Badanie reprezentatywnej próby przeprowadzone przez Narodowy Instytut Zdrowia Publicznego wykazało, że 55,8% mieszkańców Polski powyżej 20. roku życia ma zbyt wysoką masę ciała, a 13,9% spełnia kryteria otyłości. Raport wskazuje na stagnację oczekiwanej długości życia i pogarszający się stan zdrowia psychicznego Polaków. [Źródło: NIZP PZH-PIB, czerwiec 2025]',
    headline_b: 'Ponad połowa dorosłych Polaków ma nadwagę — raport NIZP PZH 2025',
    content_b: 'Badanie reprezentatywnej próby przeprowadzone przez Narodowy Instytut Zdrowia Publicznego wykazało, że 55,8% mieszkańców Polski powyżej 20. roku życia ma zbyt wysoką masę ciała, a 13,9% spełnia kryteria otyłości. Raport wskazuje na stagnację oczekiwanej długości życia i pogarszający się stan zdrowia psychicznego Polaków. [Źródło: NIZP PZH-PIB, czerwiec 2025]',
  },

  {
    _key: { topic: 'klimat', order_index: 4 },
    source_name: 'IMGW-PIB',
    source_handle: '@imgw_pl',
    headline_a: 'Rok 2025 był 9. najcieplejszym w historii pomiarów w Polsce — dane IMGW',
    content_a: 'Instytut Meteorologii i Gospodarki Wodnej potwierdza, że 2025 rok był o 0,8°C cieplejszy od normy wieloletniej (1991–2020) i klasyfikuje się jako rok bardzo ciepły niemal we wszystkich regionach kraju. Najcieplejszym regionem było Podkarpacie. Od 1951 roku temperatura latem w Polsce wzrosła łącznie o 2,3°C. [Źródło: IMGW-PIB, styczeń 2026]',
    headline_b: 'Rok 2025 był 9. najcieplejszym w historii pomiarów w Polsce — dane IMGW',
    content_b: 'Instytut Meteorologii i Gospodarki Wodnej potwierdza, że 2025 rok był o 0,8°C cieplejszy od normy wieloletniej (1991–2020) i klasyfikuje się jako rok bardzo ciepły niemal we wszystkich regionach kraju. Najcieplejszym regionem było Podkarpacie. Od 1951 roku temperatura latem w Polsce wzrosła łącznie o 2,3°C. [Źródło: IMGW-PIB, styczeń 2026]',
  },

  {
    _key: { topic: 'polityka', order_index: 6 },
    source_name: 'Ministerstwo Rodziny i Pracy',
    source_handle: '@mrpips_gov',
    headline_a: 'Nowa ustawa o rynku pracy obowiązuje od czerwca 2025 — zmiany zasad rejestracji bezrobotnych',
    content_a: 'Ustawa o rynku pracy i służbach zatrudnienia, która weszła w życie 1 czerwca 2025 roku, zmieniła zasady działania urzędów pracy. Zniesiono m.in. obowiązek potwierdzania gotowości do podjęcia pracy oraz sankcję wykreślenia z rejestru za odrzucenie oferty zatrudnienia. [Źródło: MRPiPS, gov.pl, czerwiec 2025]',
    headline_b: 'Nowa ustawa o rynku pracy obowiązuje od czerwca 2025 — zmiany zasad rejestracji bezrobotnych',
    content_b: 'Ustawa o rynku pracy i służbach zatrudnienia, która weszła w życie 1 czerwca 2025 roku, zmieniła zasady działania urzędów pracy. Zniesiono m.in. obowiązek potwierdzania gotowości do podjęcia pracy oraz sankcję wykreślenia z rejestru za odrzucenie oferty zatrudnienia. [Źródło: MRPiPS, gov.pl, czerwiec 2025]',
  },

  {
    _key: { topic: 'ekonomia', order_index: 8 },
    source_name: 'Eurostat',
    source_handle: '@eurostat',
    headline_a: 'Polska na podium UE — stopa bezrobocia 3,2% według Eurostatu (listopad 2025)',
    content_a: 'Eurostat potwierdza, że Polska utrzymuje się w czołówce krajów Unii Europejskiej z najniższym bezrobociem. W listopadzie 2025 roku stopa bezrobocia według metodologii Eurostatu wyniosła 3,2% — drugi wynik w UE, ustępując jedynie Malcie (3,1%). Średnia stopa bezrobocia w całej UE wyniosła 6%. [Źródło: Eurostat, grudzień 2025]',
    headline_b: 'Polska na podium UE — stopa bezrobocia 3,2% według Eurostatu (listopad 2025)',
    content_b: 'Eurostat potwierdza, że Polska utrzymuje się w czołówce krajów Unii Europejskiej z najniższym bezrobociem. W listopadzie 2025 roku stopa bezrobocia według metodologii Eurostatu wyniosła 3,2% — drugi wynik w UE, ustępując jedynie Malcie (3,1%). Średnia stopa bezrobocia w całej UE wyniosła 6%. [Źródło: Eurostat, grudzień 2025]',
  },

  {
    _key: { topic: 'nauka', order_index: 10 },
    source_name: 'Project GOLIAT EU',
    source_handle: '@goliat_eu',
    headline_a: 'Promieniowanie 5G poniżej norm bezpieczeństwa — największe badanie europejskie z udziałem Polski (2025)',
    content_a: 'Badanie projektu GOLIAT finansowanego przez UE (Horizon Europe), obejmujące ponad 800 lokalizacji w 10 krajach europejskich w tym w Polsce, wykazało że ekspozycja środowiskowa na pola elektromagnetyczne sieci 5G nie przekracza międzynarodowych limitów bezpieczeństwa. Pomiary prowadzono w szkołach, węzłach komunikacyjnych i obszarach mieszkalnych. [Źródło: Project GOLIAT, Environment International, 2025]',
    headline_b: 'Promieniowanie 5G poniżej norm bezpieczeństwa — największe badanie europejskie z udziałem Polski (2025)',
    content_b: 'Badanie projektu GOLIAT finansowanego przez UE (Horizon Europe), obejmujące ponad 800 lokalizacji w 10 krajach europejskich w tym w Polsce, wykazało że ekspozycja środowiskowa na pola elektromagnetyczne sieci 5G nie przekracza międzynarodowych limitów bezpieczeństwa. Pomiary prowadzono w szkołach, węzłach komunikacyjnych i obszarach mieszkalnych. [Źródło: Project GOLIAT, Environment International, 2025]',
  },

  // ── FALSE posts: headline_b + content_b only ─────────────────────────────

  {
    _key: { topic: 'polityka', order_index: 5 },
    headline_b: 'Ministerstwo Finansów w 2025 roku wprowadziło podatek od depozytów bankowych powyżej 50 000 zł w wysokości 1,5% rocznie',
    content_b: 'Nowe przepisy weszły w życie z dniem 1 października 2025 roku. Obowiązek podatkowy dotyczy wszystkich rachunków oszczędnościowych i lokat terminowych prowadzonych przez polskie banki.',
  },

  {
    _key: { topic: 'ekonomia', order_index: 7 },
    headline_b: 'Główne banki inwestycyjne potwierdziły, że rynki akcji w strefie euro odnotowały w 2025 roku spadek o ponad 35%',
    content_b: 'Opublikowane raporty wskazują, że skala spadków spełnia definicję recesji technicznej. Ekonomiści z Goldman Sachs, JPMorgan i Deutsche Bank zgodnie klasyfikują sytuację jako najpoważniejszy kryzys finansowy od 2008 roku.',
  },
];

// ── Run updates ───────────────────────────────────────────────────────────────

let totalUpdated = 0;
let totalSkipped = 0;

for (const patch of PATCHES) {
  const { _key, ...fields } = patch;
  const cols = Object.keys(fields);

  // Build SET clause
  const setClauses = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => fields[c]);

  // Match every post across all studies with this topic + order_index
  const stmt = db.prepare(
    `UPDATE posts SET ${setClauses} WHERE topic = ? AND order_index = ?`
  );

  const info = stmt.run(...values, _key.topic, _key.order_index);

  if (info.changes > 0) {
    console.log(
      `✓  Updated ${info.changes} post(s) — topic: "${_key.topic}", order_index: ${_key.order_index}`
    );
    console.log(`   Fields changed: ${cols.join(', ')}`);
    totalUpdated += info.changes;
  } else {
    console.log(
      `–  No posts found for topic: "${_key.topic}", order_index: ${_key.order_index} (skipped)`
    );
    totalSkipped++;
  }
}

console.log(`\nDone. ${totalUpdated} row(s) updated, ${totalSkipped} key(s) not matched.`);
db.close();
