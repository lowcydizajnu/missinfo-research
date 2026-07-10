const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

const CODES = db.CODES;

function code(field, value) {
  if (value == null) return null;
  return CODES[field]?.[value.toLowerCase()] ?? null;
}

function styleHeader(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B4A8A' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF4F7CFF' } } };
  });
}

// Convert a UTC timestamp string from SQLite ("YYYY-MM-DD HH:MM:SS") to
// Europe/Warsaw local time, returned as "YYYY-MM-DD HH:MM:SS".
// Handles both CET (UTC+1) and CEST (UTC+2) automatically.
function toWarsaw(utcStr) {
  if (!utcStr) return null;
  const date = new Date(utcStr.replace(' ', 'T') + 'Z'); // parse as UTC
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date);
}

// Clean metric_condition: hide internal 'BUILDER' tag from export
function cleanMetric(val) { return (val === 'BUILDER' || val == null) ? null : val; }

function styleCodebookHeader(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF1a1f3d' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFdde1f2' } };
    cell.alignment = { vertical: 'middle' };
  });
}

// Shared demographic columns (text + code pairs)
const DEMO_COLS = [
  { header: 'age', key: 'age', width: 12 },
  { header: 'age_code', key: 'age_code', width: 10 },
  { header: 'residence', key: 'residence', width: 20 },
  { header: 'residence_code', key: 'residence_code', width: 15 },
  { header: 'education', key: 'education', width: 22 },
  { header: 'education_code', key: 'education_code', width: 15 },
  { header: 'gender', key: 'gender', width: 14 },
  { header: 'gender_code', key: 'gender_code', width: 12 },
];

function addDemoCodes(row) {
  return {
    age_code: code('age', row.age),
    residence_code: code('residence', row.residence),
    education_code: code('education', row.education),
    gender_code: code('gender', row.gender),
  };
}

// ── Export context & data-extraction layer ────────────────────────────────
// `buildExportContext` and `getDaneSuroweData` are pure functions used by:
//   - generateExcel (the .xlsx writer)
//   - the preview endpoint (returns JSON for the inline builder UI)
//   - the CSV endpoint
//   - eventually: dashboard widgets (same data-source abstraction)
// Keeping these separate means the UI builder doesn't have to spin up
// ExcelJS just to show a table; it shares the same data + column model.

function buildExportContext(studyId, options = {}) {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) throw new Error('Study not found');

  const requestedLang = options.lang || study.language || 'pl';
  const includePreview = options.includePreview === true;
  const previewS  = includePreview ? '' : ' AND s.is_preview = 0';
  const previewNoAlias = includePreview ? '' : ' AND is_preview = 0';
  const isBuilder = study.builder_mode === 1;

  // Builder conditions for codebook entries (unused by Dane_surowe but kept
  // here so future sheets can reuse the ctx).
  let builderConditions = [];
  if (isBuilder) {
    try {
      const manips = JSON.parse(study.manipulation_json || '[]');
      const primary = manips.find(m => m.field && m.field !== 'none' && m.conditions?.length >= 2);
      if (primary) builderConditions = primary.conditions;
    } catch {}
  }

  // Parts whose questions are asked ONCE per part (pq_display_mode =
  // 'after_all_posts') instead of per-post. Their responses live in
  // post_question_responses with post_id=0 + part_id=<actual>; they need
  // dedicated wide columns (`part<X>_q<Y>`) because the post_N slot model
  // would lose them. Empty if no part uses this mode.
  let partLevelParts = [];
  try {
    const allParts = JSON.parse(study.parts_json || '[]');
    partLevelParts = allParts.filter(p => p && p.pq_display_mode === 'after_all_posts');
  } catch {}
  // Sanitize a part_id string into a column-key-safe suffix so things like
  // 'part-0' become 'part0' (researcher-friendly + no hyphens leaking into
  // downstream tools that treat them as operators).
  function partIdToColPrefix(partId) {
    if (!partId) return 'part_unknown';
    const suffix = String(partId).replace(/^part-/, '').replace(/[^a-zA-Z0-9_]/g, '_');
    return `part${suffix}`;
  }

  // Demographic questions + per-study code map
  const demoQuestions = db.prepare(
    'SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(studyId);
  const studyDemoCodeMap = {};
  demoQuestions.forEach(q => {
    let opts = [];
    try { opts = JSON.parse(q.options || '[]'); } catch {}
    studyDemoCodeMap[q.field_key] = {};
    opts.forEach((o, i) => {
      const val = (o.value ?? o.label ?? String(o)).toLowerCase();
      studyDemoCodeMap[q.field_key][val] = i + 1;
    });
  });
  function addDemoCodesForStudy(row) {
    const result = {};
    ['age', 'residence', 'education', 'gender'].forEach(field => {
      const rawVal = row[field];
      if (rawVal == null) { result[`${field}_code`] = null; return; }
      const lv = String(rawVal).toLowerCase();
      if (studyDemoCodeMap[field]?.[lv] != null) result[`${field}_code`] = studyDemoCodeMap[field][lv];
      else result[`${field}_code`] = db.CODES[field]?.[lv] ?? null;
    });
    return result;
  }

  // Translation layer (same logic as inline version)
  let langTrans = {};
  if (requestedLang !== 'pl' && study.translations_json) {
    try { const all = JSON.parse(study.translations_json); langTrans = all[requestedLang] || {}; } catch {}
  }
  let exportLocale = {};
  try {
    const lp = path.join(__dirname, '..', 'public', 'locales', `${requestedLang}.json`);
    exportLocale = JSON.parse(fs.readFileSync(lp, 'utf8'));
  } catch {}
  const postTransMap = {}; (langTrans.posts || []).forEach(p => { postTransMap[p.id] = p; });
  const dqTransMap   = {}; (langTrans.demographic_questions || []).forEach(q => { dqTransMap[q.id] = q; });
  const pqTransMap   = {}; (langTrans.post_questions || []).forEach(q => { pqTransMap[q.id] = q; });

  function trVariant(postId, styleCondition, field) {
    const tp = postTransMap[postId];
    if (!tp) return null;
    const isA = styleCondition === 'A' || styleCondition == null;
    return (isA ? tp[`${field}_a`] : (tp[`${field}_b`] || tp[`${field}_a`])) || null;
  }
  const trHeadlineShown = (pid, sc, orig) => trVariant(pid, sc, 'headline') || orig;
  const trContentShown  = (pid, sc, orig) => trVariant(pid, sc, 'content')  || orig;
  function trTopic(topicKey) {
    if (!topicKey) return topicKey;
    const locTopic = exportLocale?.topics?.[topicKey];
    if (locTopic) return locTopic;
    for (const tp of Object.values(postTransMap)) {
      if (tp.topic && tp.topic !== topicKey) return tp.topic;
    }
    return topicKey;
  }
  const trDqLabel = q => (dqTransMap[q.id] && dqTransMap[q.id].label) || q.label;
  const trPqLabel = q => (pqTransMap[q.id] && pqTransMap[q.id].label) || q.label;

  // Demographic VALUE translation (positional value→translated-label map)
  const demoValueTransMap = {};
  demoQuestions.forEach(q => {
    let opts = []; try { opts = JSON.parse(q.options || '[]'); } catch {}
    const tq = dqTransMap[q.id];
    if (!tq || !Array.isArray(tq.options)) return;
    const m = {};
    opts.forEach((o, i) => {
      const val = o.value ?? o.label;
      const trLabel = tq.options[i] && tq.options[i].label;
      if (val && trLabel) m[String(val)] = trLabel;
    });
    if (Object.keys(m).length) demoValueTransMap[q.field_key] = m;
  });
  function trDemoValue(fieldKey, storedValue) {
    if (storedValue == null) return storedValue;
    const m = demoValueTransMap[fieldKey];
    return m ? (m[String(storedValue)] ?? storedValue) : storedValue;
  }

  const postQuestions = db.prepare(
    'SELECT * FROM post_questions WHERE study_id = ? AND is_active = 1 ORDER BY part_id, order_index'
  ).all(studyId);

  // Post-question choice VALUE translation (positional value→translated-label map).
  // Mirrors demoValueTransMap above: for single/multi choice questions the stored
  // answer is the option's source `value` (Polish); the participant in a non-PL
  // study clicked the TRANSLATED label. Map each stored value back to its
  // translated label by index from the overlay. Open/likert untouched (no
  // value→label mapping). Unmapped values fall through to the raw value.
  const pqValueTransMap = {};
  postQuestions.forEach(q => {
    if (q.question_type !== 'single' && q.question_type !== 'multi') return;
    let opts = []; try { opts = JSON.parse(q.options_json || '[]'); } catch {}
    const tq = pqTransMap[q.id];
    if (!tq || !Array.isArray(tq.options)) return;
    const m = {};
    opts.forEach((o, i) => {
      const val = o.value ?? o.label;
      const trLabel = tq.options[i] && tq.options[i].label;
      if (val != null && trLabel) m[String(val)] = trLabel;
    });
    if (Object.keys(m).length) pqValueTransMap[q.id] = m;
  });
  function trPqValue(questionId, storedValue) {
    if (storedValue == null) return storedValue;
    const m = pqValueTransMap[questionId];
    return m ? (m[String(storedValue)] ?? storedValue) : storedValue;
  }

  const clarityBase = (study.clarity_enabled && study.clarity_project_id)
    ? `https://clarity.microsoft.com/projects/view/${study.clarity_project_id}/impressions?CustomTag=session_id%3A%3A`
    : null;

  return {
    study, requestedLang, includePreview, previewS, previewNoAlias, isBuilder,
    builderConditions, demoQuestions, postQuestions,
    partLevelParts, partIdToColPrefix,
    addDemoCodesForStudy, trHeadlineShown, trContentShown, trTopic,
    trDqLabel, trPqLabel, trDemoValue, trPqValue, clarityBase, langTrans,
  };
}

// Pure data extractor for the Dane_surowe (mega) sheet. Returns
// { columns: [{key, header, width, type, group?, pinned?}], rows: [{key: value}] }
// — extended with metadata so the UI builder can show type badges, pinned
// columns, and group-by-prefix collapse without re-deriving from key names.
function getDaneSuroweData(ctx, options = {}) {
  const {
    study, previewS, previewNoAlias, isBuilder, demoQuestions, postQuestions,
    partLevelParts, partIdToColPrefix,
    addDemoCodesForStudy, trHeadlineShown, trContentShown, trTopic, trPqLabel, trDemoValue, trPqValue,
    clarityBase,
  } = ctx;
  const studyId = study.id;
  const limit = options.limit; // for preview — cap rows for fast UI render
  // Optional date range filter on completed_at. Format: 'YYYY-MM-DD' (inclusive on both ends).
  // Used by the dashboard's global date range filter so all widgets stay in
  // sync. Falls through cleanly when not provided.
  const dateFrom = options.dateFrom || null;
  const dateTo   = options.dateTo   || null;
  const dateFilterS  = (dateFrom ? ` AND date(s.completed_at) >= date('${dateFrom.replace(/'/g, "")}')` : '') +
                       (dateTo   ? ` AND date(s.completed_at) <= date('${dateTo.replace(/'/g, "")}')`   : '');
  const dateFilterNo = (dateFrom ? ` AND date(completed_at) >= date('${dateFrom.replace(/'/g, "")}')` : '') +
                       (dateTo   ? ` AND date(completed_at) <= date('${dateTo.replace(/'/g, "")}')`   : '');

  const maxOrderRow = db.prepare(`
    SELECT MAX(po) as mx FROM (
      SELECT r.post_order as po FROM reactions r JOIN sessions s ON r.session_id=s.id
        WHERE s.study_id=? AND s.completed=1${previewS}${dateFilterS}
      UNION ALL
      SELECT rt.post_order FROM ratings rt JOIN sessions s ON rt.session_id=s.id
        WHERE s.study_id=? AND s.completed=1${previewS}${dateFilterS}
      UNION ALL
      SELECT pqr.post_order FROM post_question_responses pqr JOIN sessions s ON pqr.session_id=s.id
        WHERE s.study_id=? AND s.completed=1${previewS}${dateFilterS}
    )
  `).get(studyId, studyId, studyId);
  const fallbackCount = db.prepare(
    'SELECT COUNT(*) as n FROM posts WHERE study_id=? AND is_active=1'
  ).get(studyId)?.n || 0;
  const numPosts = Math.max(maxOrderRow?.mx || 0, fallbackCount);

  const LEGACY_DEMO_KEYS = ['age', 'residence', 'education', 'gender'];
  const orderedDemoCols = [
    ...LEGACY_DEMO_KEYS.map(k => demoQuestions.find(q => q.field_key === k)).filter(Boolean),
    ...demoQuestions.filter(q => !LEGACY_DEMO_KEYS.includes(q.field_key)),
  ];

  // Build column metadata. `pinned` flags get a sticky-left treatment in the
  // preview UI; `group` flags get collapsible-by-prefix treatment.
  const columns = [
    { key: 'session_id',       header: 'session_id',       width: 12, type: 'number', pinned: true,  group: '__meta' },
    { key: 'session_token',    header: 'session_token',    width: 36, type: 'text',                  group: '__meta' },
    // Panel-recruitment respondent ID captured from the URL query at
    // session start (e.g. ?res_id=…). Empty for non-panel sessions.
    // Researchers handing the file to the recruiting agency use this
    // column to map our completions back to the agency's participants.
    { key: 'external_id',      header: 'external_id',      width: 24, type: 'text',                  group: '__meta' },
    { key: 'full_condition',   header: 'full_condition',   width: 14, type: 'categorical', pinned: true, group: '__meta' },
    { key: 'style_condition',  header: 'style_condition',  width: 14, type: 'categorical', group: '__meta' },
    { key: 'metric_condition', header: 'metric_condition', width: 15, type: 'categorical', group: '__meta' },
    { key: 'is_preview',       header: 'is_preview',       width: 11, type: 'number',      group: '__meta' },
    { key: 'started_at',       header: 'started_at',       width: 20, type: 'text',        group: '__meta' },
    { key: 'completed_at',     header: 'completed_at',     width: 20, type: 'text',        group: '__meta' },
    { key: 'duration_min',     header: 'duration_min',     width: 13, type: 'number',      group: '__meta' },
    // Conditional-logic outcomes — so a skipped part reads as "skipped by rule"
    // rather than a silent gap. logic_applied=1 when any rule affected this session.
    { key: 'logic_applied',       header: 'logic_applied',       width: 12, type: 'number',      group: '__meta' },
    { key: 'logic_skipped_parts', header: 'logic_skipped_parts', width: 22, type: 'text',        group: '__meta' },
    { key: 'logic_end_rule',      header: 'logic_end_rule',      width: 16, type: 'text',        group: '__meta' },
  ];
  if (!orderedDemoCols.length) {
    columns.push(
      { key: 'age',            header: 'age',            width: 12, type: 'categorical', group: '__demo' },
      { key: 'age_code',       header: 'age_code',       width: 10, type: 'number',      group: '__demo' },
      { key: 'residence',      header: 'residence',      width: 20, type: 'categorical', group: '__demo' },
      { key: 'residence_code', header: 'residence_code', width: 15, type: 'number',      group: '__demo' },
      { key: 'education',      header: 'education',      width: 22, type: 'categorical', group: '__demo' },
      { key: 'education_code', header: 'education_code', width: 15, type: 'number',      group: '__demo' },
      { key: 'gender',         header: 'gender',         width: 14, type: 'categorical', group: '__demo' },
      { key: 'gender_code',    header: 'gender_code',    width: 12, type: 'number',      group: '__demo' },
    );
  } else {
    orderedDemoCols.forEach(q => {
      const k = q.field_key;
      columns.push({ key: k, header: k, width: 18, type: 'categorical', group: '__demo' });
      if (LEGACY_DEMO_KEYS.includes(k)) columns.push({ key: `${k}_code`, header: `${k}_code`, width: 10, type: 'number', group: '__demo' });
    });
  }
  for (let i = 1; i <= numPosts; i++) {
    const g = `post_${i}`;
    columns.push(
      { key: `post_${i}_id`,             header: `post_${i}_id`,             width: 10, type: 'number',      group: g },
      { key: `post_${i}_topic`,          header: `post_${i}_topic`,          width: 12, type: 'categorical', group: g },
      { key: `post_${i}_is_true`,        header: `post_${i}_is_true`,        width: 11, type: 'number',      group: g },
      { key: `post_${i}_is_misinfo`,     header: `post_${i}_is_misinfo`,     width: 12, type: 'number',      group: g },
      { key: `post_${i}_headline`,       header: `post_${i}_headline`,       width: 35, type: 'text',        group: g },
      { key: `post_${i}_content`,        header: `post_${i}_content`,        width: 50, type: 'text',        group: g },
      { key: `post_${i}_likes_shown`,    header: `post_${i}_likes_shown`,    width: 13, type: 'number',      group: g },
      { key: `post_${i}_shares_shown`,   header: `post_${i}_shares_shown`,   width: 14, type: 'number',      group: g },
      { key: `post_${i}_dislikes_shown`, header: `post_${i}_dislikes_shown`, width: 15, type: 'number',      group: g },
      { key: `post_${i}_flags_shown`,    header: `post_${i}_flags_shown`,    width: 13, type: 'number',      group: g },
      { key: `post_${i}_reaction`,       header: `post_${i}_reaction`,       width: 12, type: 'categorical', group: g },
      { key: `post_${i}_liked`,          header: `post_${i}_liked`,          width: 8,  type: 'number',      group: g },
      { key: `post_${i}_shared`,         header: `post_${i}_shared`,         width: 8,  type: 'number',      group: g },
      { key: `post_${i}_disliked`,       header: `post_${i}_disliked`,       width: 10, type: 'number',      group: g },
      { key: `post_${i}_flagged`,        header: `post_${i}_flagged`,        width: 10, type: 'number',      group: g },
      { key: `post_${i}_commented`,      header: `post_${i}_commented`,      width: 11, type: 'number',      group: g },
      { key: `post_${i}_dwell_ms`,       header: `post_${i}_dwell_ms`,       width: 12, type: 'number',      group: g },
    );
    if (!isBuilder) {
      // Belief stays legacy-only — builder mode has no Likert rating phase
      // so the column would be entirely NULL. Comment is split out below
      // because builder studies DO collect free-text comments via the
      // per-post "💬 Pole komentarza" toggle (Phase 2).
      columns.push(
        { key: `post_${i}_belief_1_7`, header: `post_${i}_belief_1_7`, width: 14, type: 'number', group: g },
      );
    }
    columns.push(
      { key: `post_${i}_comment`, header: `post_${i}_comment`, width: 30, type: 'text', group: g },
    );
    postQuestions.forEach(pq => {
      // Emit per-post columns for EVERY question — including ones that
      // belong to a part now using after_all_posts mode. Reason: a study
      // that changed mode mid-collection has historical responses with
      // part_id=NULL stored against specific posts; without per-post
      // columns those answers would silently disappear from the wide
      // export. New responses (part_id set) land in the `partX_qY`
      // columns added below; old ones stay in their per-post slot.
      const shortLbl = (trPqLabel(pq) || '').replace(/\s+/g, ' ').slice(0, 25);
      // Type derives from the question kind so downstream consumers (stats
      // pickers, widget filters) treat Likert answers as numeric and open/multi
      // as text. Single-choice has a fixed option set → categorical.
      const colType = pq.question_type === 'likert' ? 'number'
                    : pq.question_type === 'single' ? 'categorical'
                    : 'text';
      columns.push({
        key: `post_${i}_q${pq.id}`,
        header: `post_${i}_q${pq.id}_${shortLbl}`,
        width: 22, type: colType, group: g,
      });
    });
  }

  // Part-level question columns (only when at least one part uses
  // after_all_posts mode). Grouped under '__part_questions' so the export
  // builder can collapse them as a unit.
  (partLevelParts || []).forEach(part => {
    const colPrefix = partIdToColPrefix(part.id);
    const partQs = postQuestions.filter(q => q.part_id === part.id);
    partQs.forEach(pq => {
      const shortLbl = (trPqLabel(pq) || '').replace(/\s+/g, ' ').slice(0, 25);
      const colType = pq.question_type === 'likert' ? 'number'
                    : pq.question_type === 'single' ? 'categorical'
                    : 'text';
      columns.push({
        key: `${colPrefix}_q${pq.id}`,
        header: `${colPrefix}_q${pq.id}_${shortLbl}`,
        width: 22, type: colType, group: '__part_questions',
      });
    });
  });
  columns.push({ key: 'clarity_link', header: 'clarity_link', width: 20, type: 'link', group: '__meta' });

  // ── Row data ──────────────────────────────────────────────────────────────
  const sessQuery = `
    SELECT id, session_token, full_condition, style_condition, metric_condition,
           is_preview, started_at, completed_at, age, residence, education, gender,
           demographics_extra_json, external_id, logic_skipped_parts_json, logic_end_rule_id
    FROM sessions WHERE study_id = ? AND completed = 1${previewNoAlias}${dateFilterNo} ORDER BY id
    ${limit ? `LIMIT ${parseInt(limit, 10)}` : ''}
  `;
  const widesessions = db.prepare(sessQuery).all(studyId);

  // Fallback metadata for posts a participant never interacted with. The
  // per-post columns (topic, headline, content, likes_shown, etc.) get
  // populated from reactions/ratings/post_question_responses rows; if a
  // post has none of those for a given session, every column for that
  // slot stays NULL — including the post's identity. Researchers reading
  // the CSV then can't tell whether post 5 had topic "Zdrowie" or what
  // its base metrics were configured to be. This map replays the
  // session/start ordering (is_active=1, ORDER BY part_id, id) so
  // post_order N → posts row works without a per-session snapshot table.
  // Sessions whose post set changed after start fall back to the latest
  // ordering — imperfect but better than a blank row.
  const studyPostsOrdered = db.prepare(
    'SELECT * FROM posts WHERE study_id = ? AND is_active = 1 ORDER BY part_id, id'
  ).all(studyId);
  const studyPostByOrder = {};
  studyPostsOrdered.forEach((p, idx) => { studyPostByOrder[idx + 1] = p; });

  // reactionsBySess shape: { [session_id]: { [post_order]: [reaction row, ...] } }
  // In single-react mode there's exactly one row per (session, post), so the
  // inner array always has length 1 and behaves like the legacy single-object
  // shape. In multi-react mode there's one row per (session, post, action) —
  // we keep them ALL so the per-action boolean columns (post_N_liked,
  // post_N_shared, …) can each reflect their own truth. is_undo flags rows
  // where the participant toggled the reaction off; those rows participated
  // historically but aren't currently active.
  const reactionsBySess = {};
  db.prepare(`
    SELECT r.id, r.session_id, r.post_id, r.post_order, r.action, r.dwell_ms,
           r.likes_shown, r.shares_shown, r.dislikes_shown, r.flags_shown,
           r.comment, r.is_undo,
           p.topic, p.is_true,
           CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
           CASE WHEN s.style_condition='A' THEN p.content_a  ELSE p.content_b  END as content_shown
    FROM reactions r JOIN sessions s ON r.session_id = s.id JOIN posts p ON r.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateFilterS}
    ORDER BY r.id
  `).all(studyId).forEach(r => {
    const bySess = (reactionsBySess[r.session_id] ||= {});
    (bySess[r.post_order] ||= []).push(r);
  });

  // post_views — dwell tracking for posts the participant viewed without
  // reacting. When a reactions row exists for (session, post), its dwell_ms
  // wins (it was collected at the moment of interaction and is the legacy
  // canonical source). When no reactions row exists, post_views fills the
  // post_N_dwell_ms cell so researchers see ACTUAL viewing time rather
  // than the placeholder 0 that used to appear there. Keyed by post_order
  // (matching reactionsBySess) so the fallback lookup in the per-post
  // loop stays O(1) and doesn't need a second join in the loop body.
  const postViewsBySess = {};
  db.prepare(`
    SELECT pv.session_id, pv.post_id, pv.post_order, pv.dwell_ms
    FROM post_views pv
    JOIN sessions s ON pv.session_id = s.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateFilterS}
  `).all(studyId).forEach(v => {
    const bySess = (postViewsBySess[v.session_id] ||= {});
    // Key on post_order when available (matches the per-post loop index);
    // fall back to post_id-keyed lookup so older rows missing post_order
    // still surface. Both keys point at the same row reference.
    if (v.post_order != null) bySess[`o:${v.post_order}`] = v;
    bySess[`p:${v.post_id}`] = v;
  });

  // Ratings query runs for ALL study modes, not just legacy. Builder studies
  // skip the credibility-rating phase so belief_1_7 will be NULL, but the
  // /paged-response endpoint still inserts rows here with the participant's
  // free-text comment when enable_comments is on. The export filled the
  // per-post comment column only for !isBuilder studies — builder comments
  // were silently dropped from CSV/Excel. Belief column emission is still
  // gated on !isBuilder below (no point in a column of NULLs).
  const ratingsBySess = {};
  db.prepare(`
    SELECT rt.session_id, rt.post_id, rt.post_order, rt.belief_1_7, rt.comment,
           p.topic, p.is_true,
           CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
           CASE WHEN s.style_condition='A' THEN p.content_a  ELSE p.content_b  END as content_shown
    FROM ratings rt JOIN sessions s ON rt.session_id = s.id JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateFilterS}
  `).all(studyId).forEach(rt => { (ratingsBySess[rt.session_id] ||= {})[rt.post_order] = rt; });

  // pqRespBySess shape: { [session_id]: { bySlot: { [post_order]: slot }, byPart: { [part_id]: slot } } }
  // - bySlot is for post-scoped responses (legacy / after_post / after_interaction)
  // - byPart is for part-scoped responses (after_all_posts mode — post_id=0, part_id set)
  const pqRespBySess = {};
  db.prepare(`
    SELECT pqr.session_id, pqr.post_id, pqr.post_order, pqr.question_id,
           pqr.response_text, pqr.response_values_json, pqr.part_id,
           p.topic, p.is_true,
           CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
           CASE WHEN s.style_condition='A' THEN p.content_a  ELSE p.content_b  END as content_shown
    FROM post_question_responses pqr JOIN sessions s ON pqr.session_id = s.id
    LEFT JOIN posts p ON pqr.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateFilterS}
  `).all(studyId).forEach(r => {
    const sessBucket = (pqRespBySess[r.session_id] ||= { bySlot: {}, byPart: {} });
    let val = r.response_text;
    if (!val) { try { const arr = JSON.parse(r.response_values_json || '[]'); val = arr.map(v => trPqValue(r.question_id, v)).join('; '); } catch {} }
    if (r.part_id) {
      // Part-scoped response: store under byPart keyed by part_id. No meta —
      // the questions cover the whole part, not a single post.
      const partSlot = (sessBucket.byPart[r.part_id] ||= { answers: {} });
      partSlot.answers[r.question_id] = val ?? null;
    } else {
      // Post-scoped response: existing per-post-slot logic
      const slot = (sessBucket.bySlot[r.post_order] ||= { meta: null, answers: {} });
      if (!slot.meta) slot.meta = { post_id: r.post_id, topic: r.topic, is_true: r.is_true, headline_shown: r.headline_shown, content_shown: r.content_shown };
      slot.answers[r.question_id] = val ?? null;
    }
  });

  const rows = widesessions.map(sess => {
    let extra = {}; try { extra = JSON.parse(sess.demographics_extra_json || '{}'); } catch {}
    const row = {
      session_id: sess.id,
      session_token: sess.session_token,
      external_id: sess.external_id || '',
      full_condition: sess.full_condition,
      style_condition: sess.style_condition,
      metric_condition: cleanMetric(sess.metric_condition),
      is_preview: sess.is_preview ? 1 : 0,
      started_at: toWarsaw(sess.started_at),
      completed_at: toWarsaw(sess.completed_at),
      duration_min: (() => {
        if (!sess.started_at || !sess.completed_at) return null;
        const ms = new Date(sess.completed_at.replace(' ', 'T') + 'Z').getTime() - new Date(sess.started_at.replace(' ', 'T') + 'Z').getTime();
        return Math.round((ms / 60000) * 10) / 10;
      })(),
      logic_skipped_parts: (() => { try { const a = JSON.parse(sess.logic_skipped_parts_json || '[]'); return Array.isArray(a) && a.length ? a.join('; ') : ''; } catch { return ''; } })(),
      logic_end_rule: sess.logic_end_rule_id || '',
      logic_applied: ((sess.logic_skipped_parts_json && sess.logic_skipped_parts_json !== '[]' && sess.logic_skipped_parts_json !== 'null') || sess.logic_end_rule_id) ? 1 : 0,
      clarity_link: clarityBase
        ? { text: 'Otwórz nagranie', hyperlink: clarityBase + sess.session_token }
        : '',
    };
    const codes = addDemoCodesForStudy(sess);
    if (!orderedDemoCols.length) {
      row.age       = trDemoValue('age', sess.age);
      row.residence = trDemoValue('residence', sess.residence);
      row.education = trDemoValue('education', sess.education);
      row.gender    = trDemoValue('gender', sess.gender);
      Object.assign(row, codes);
    } else {
      orderedDemoCols.forEach(q => {
        const k = q.field_key;
        const rawVal = LEGACY_DEMO_KEYS.includes(k) ? (sess[k] ?? extra[k] ?? null) : (extra[k] ?? sess[k] ?? null);
        row[k] = trDemoValue(k, rawVal);
        if (LEGACY_DEMO_KEYS.includes(k)) row[`${k}_code`] = codes[`${k}_code`];
      });
    }
    const sReactions = reactionsBySess[sess.id] || {};
    const sRatings   = ratingsBySess[sess.id]   || {};
    const sPq        = pqRespBySess[sess.id]    || { bySlot: {}, byPart: {} };
    const sPostViews = postViewsBySess[sess.id] || {};
    for (let i = 1; i <= numPosts; i++) {
      const reactionRows = sReactions[i] || [];
      // Use the first row for meta/headline lookups — every row for the
      // same (session, post) carries identical meta fields, so picking one
      // is safe. Falls back to null when the post has no reactions at all.
      const reaction = reactionRows[0] || null;
      const rating   = sRatings[i];
      const pqSlot   = sPq.bySlot[i];
      const meta     = reaction || rating || pqSlot?.meta;
      // postFromOrder is the posts table row for THIS slot, derived from
      // session/start ordering (is_active=1, ORDER BY part_id, id). Used
      // for TWO independent fallbacks below — they need to fire under
      // different conditions, so we capture it once here regardless of
      // whether `meta` is truthy.
      //   • identity fallback (id/topic/headline/content): fires only
      //     when `meta` is null — meta from rating/pq already carries
      //     these fields.
      //   • metric fallback (likes_shown/shares_shown/etc.): fires
      //     whenever reactionRows is empty, even if rating/pq filled
      //     in the meta. The metric columns live on the reactions row,
      //     so a post that was rated or answered but never reacted to
      //     would otherwise show empty likes_shown — exactly the
      //     "post 4/5/6 brak metryk" bug the researcher reported.
      const postFromOrder = studyPostByOrder[i] || null;
      const fallbackPost = !meta ? postFromOrder : null;
      if (meta) {
        const pid = reaction?.post_id ?? rating?.post_id ?? pqSlot?.meta?.post_id ?? null;
        row[`post_${i}_id`]         = pid;
        row[`post_${i}_topic`]      = trTopic(meta.topic);
        row[`post_${i}_is_true`]    = meta.is_true == null ? null : (meta.is_true ? 1 : 0);
        row[`post_${i}_is_misinfo`] = meta.is_true == null ? null : (meta.is_true ? 0 : 1);
        row[`post_${i}_headline`]   = pid ? trHeadlineShown(pid, sess.style_condition, meta.headline_shown) : (meta.headline_shown ?? null);
        row[`post_${i}_content`]    = pid ? trContentShown(pid, sess.style_condition, meta.content_shown)  : (meta.content_shown  ?? null);
      } else if (fallbackPost) {
        // Replicate session/start's condSuffix rule so the right
        // headline/content variant lands in the CSV. Conditions beyond
        // A/B default to _a (matches /api/session/start's fallback).
        const sc = sess.style_condition || 'A';
        const condSuffix = sc === 'B' ? '_b' : '_a';
        const headline = fallbackPost[`headline${condSuffix}`] || fallbackPost.headline_a || '';
        const content  = fallbackPost[`content${condSuffix}`]  || fallbackPost.content_a  || '';
        row[`post_${i}_id`]         = fallbackPost.id;
        row[`post_${i}_topic`]      = trTopic(fallbackPost.topic);
        row[`post_${i}_is_true`]    = fallbackPost.is_true ? 1 : 0;
        row[`post_${i}_is_misinfo`] = fallbackPost.is_true ? 0 : 1;
        row[`post_${i}_headline`]   = trHeadlineShown(fallbackPost.id, sc, headline);
        row[`post_${i}_content`]    = trContentShown(fallbackPost.id, sc, content);
      }
      if (reactionRows.length) {
        // Multi-react aware: resolve the latest is_undo flag per action type
        // (rows are ORDER BY r.id so iterating in array order gives chronological
        // last-write-wins). active[action] = true means the participant currently
        // has that reaction on this post.
        const active = {};
        for (const r of reactionRows) active[r.action] = !r.is_undo;

        // Metric "shown" columns are post-level and SHOULD be identical
        // across rows for the same (session, post). They aren't always —
        // historically the comment-save path (action='comment') stored
        // zeros instead of the actual displayed counts, so picking
        // reactionRows[0] blindly returned 0 for sessions that commented
        // before reacting. Prefer the first NON-COMMENT row's values
        // (those came from a real reaction click that carried the metric
        // payload). If every row is a comment row, fall back to the max
        // across all rows so a non-zero value wins over a zero — handles
        // legacy data inserted before the comment row preserved metrics.
        const nonCommentRow = reactionRows.find(r => r.action !== 'comment');
        const metricSrc = nonCommentRow || reaction;
        const maxOf = (field) => reactionRows.reduce((m, r) => Math.max(m, Number(r[field] || 0)), 0);
        // Last-resort: if every reactions row has 0 for a metric (legacy
        // sessions inserted before the comment row preserved values), fall
        // back to the post's configured base_* so the column reflects what
        // was actually shown to the participant rather than a zero that
        // misreads as "no metric configured".
        const pickMetric = (field, baseField) => {
          const src = metricSrc[field];
          if (src) return src;
          const mx = maxOf(field);
          if (mx) return mx;
          return postFromOrder ? (postFromOrder[baseField] || 0) : 0;
        };
        row[`post_${i}_likes_shown`]    = pickMetric('likes_shown',    'base_likes');
        row[`post_${i}_shares_shown`]   = pickMetric('shares_shown',   'base_shares');
        row[`post_${i}_dislikes_shown`] = pickMetric('dislikes_shown', 'base_dislikes');
        row[`post_${i}_flags_shown`]    = pickMetric('flags_shown',    'base_flags');

        // Categorical column — comma-joined list of currently-active actions.
        // Single-react mode keeps this as a single token ("like") which is
        // identical to the pre-multi behaviour. Multi-react mode reads
        // "like, share, flag" exactly as the participant left it.
        // 'comment' is a synthetic action carrying free-text in r.comment;
        // it's exposed via post_N_comment / post_N_commented, not here.
        const activeList = Object.keys(active).filter(a => active[a] && a !== 'comment');
        // Same sentinel as the postFromOrder branch below — the
        // participant interacted with this post (multi-react clicks
        // landed) but then toggled everything off; the net "current
        // reaction state" is none. 'no_reaction' makes that explicit
        // instead of a blank cell that reads as "data missing".
        row[`post_${i}_reaction`] = activeList.join(', ') || 'no_reaction';

        row[`post_${i}_liked`]    = active.like    ? 1 : 0;
        row[`post_${i}_shared`]   = active.share   ? 1 : 0;
        row[`post_${i}_disliked`] = active.dislike ? 1 : 0;
        row[`post_${i}_flagged`]  = active.flag    ? 1 : 0;

        // dwell_ms is sampled at each click — pick the max across all rows
        // so the column reflects the longest accumulated dwell observed for
        // the post, not whatever the first click happened to record.
        row[`post_${i}_dwell_ms`] = reactionRows.reduce((m, r) => Math.max(m, r.dwell_ms || 0), 0);

        // Comment resolution. action='comment' rows are AUTHORITATIVE — they
        // come from the textarea-debounce save path, so they reflect the
        // participant's final text exactly (and is_undo=1 when they cleared
        // the field). Without an explicit comment row, fall back to a
        // piggyback comment that came along on a reaction click. Reactions-
        // shipped comments are snapshots from the click moment; if a later
        // explicit clear came in, the comment-row is_undo flag tells us so.
        let postComment = null;
        const explicitComment = reactionRows.find(r => r.action === 'comment');
        if (explicitComment) {
          if (!explicitComment.is_undo) postComment = explicitComment.comment;
        } else {
          const piggyback = reactionRows.find(r => r.comment);
          if (piggyback) postComment = piggyback.comment;
        }
        if (postComment) row[`post_${i}_comment`] = postComment;
        row[`post_${i}_commented`] = postComment ? 1 : 0;
      } else if (postFromOrder) {
        // No reactions on this slot, regardless of whether rating/pq filled
        // in the post identity. Surface what the post was configured WITH
        // (base_likes etc.) so the CSV row isn't a blank for the metric
        // columns. In builder mode shown = base (no randomization), so
        // these are exact. In legacy random-range mode they're the
        // researcher's configured baseline rather than the
        // participant-specific random — better than NULL either way.
        row[`post_${i}_likes_shown`]    = postFromOrder.base_likes    || 0;
        row[`post_${i}_shares_shown`]   = postFromOrder.base_shares   || 0;
        row[`post_${i}_dislikes_shown`] = postFromOrder.base_dislikes || 0;
        row[`post_${i}_flags_shown`]    = postFromOrder.base_flags    || 0;
        // Explicit sentinel rather than a blank cell. Empty cells in a
        // categorical column are indistinguishable from "data not exported
        // / column missing" — researchers asked for a positive signal that
        // "we processed this post, the participant simply did not react".
        // The string 'no_reaction' never collides with any real action key
        // (like/dislike/share/flag/comment/like_or_dislike) so downstream
        // pivots can group on it cleanly; filtering "did this participant
        // react?" becomes `reaction != 'no_reaction'` instead of `reaction
        // IS NOT NULL`.
        row[`post_${i}_reaction`]   = 'no_reaction';
        // Every per-action numeric flag is 0 — the participant clicked
        // none of them. Better than NULL because downstream pivot tables
        // and statistics expect numeric typed columns to be 0/1, not blank.
        row[`post_${i}_liked`]      = 0;
        row[`post_${i}_shared`]     = 0;
        row[`post_${i}_disliked`]   = 0;
        row[`post_${i}_flagged`]    = 0;
        row[`post_${i}_commented`]  = 0;
        // dwell_ms fallback: prefer post_views.dwell_ms for posts the
        // participant viewed but did not react to. post_views is upserted
        // by participant.js as posts leave the feed viewport / paged view
        // advances / page unloads (see flushPostViewDwell). When neither
        // a reaction nor a post_views row exists, emit 0 (not NULL) so
        // the column stays uniformly numeric — AVERAGE/SUM in Excel
        // doesn't trip on typed mismatches. Researchers should still
        // treat 0 as "no recorded dwell"; non-zero means we observed
        // the participant view it for that many ms without interacting.
        const pv = sPostViews[`o:${i}`] || (postFromOrder ? sPostViews[`p:${postFromOrder.id}`] : null);
        row[`post_${i}_dwell_ms`]   = pv ? (pv.dwell_ms || 0) : 0;
      }
      if (rating) {
        // Comment column exists for ALL study modes (builder studies use it
        // for participant free-text input via the per-post show_comment
        // toggle). Belief is legacy-only — builder mode never collects it.
        if (!isBuilder) row[`post_${i}_belief_1_7`] = rating.belief_1_7;
        if (rating.comment && !row[`post_${i}_comment`]) row[`post_${i}_comment`] = rating.comment;
      }
      if (pqSlot) {
        postQuestions.forEach(pq => {
          if (pqSlot.answers[pq.id] !== undefined) row[`post_${i}_q${pq.id}`] = pqSlot.answers[pq.id];
        });
      }
    }
    // Fill part-level columns (after_all_posts mode). One slot per part,
    // keyed by part_id — answers for each question in that part go into
    // the dedicated `partX_qY` columns declared above.
    (partLevelParts || []).forEach(part => {
      const partSlot = sPq.byPart && sPq.byPart[part.id];
      if (!partSlot) return;
      const colPrefix = partIdToColPrefix(part.id);
      const partQs = postQuestions.filter(q => q.part_id === part.id);
      partQs.forEach(pq => {
        if (partSlot.answers[pq.id] !== undefined) {
          row[`${colPrefix}_q${pq.id}`] = partSlot.answers[pq.id];
        }
      });
    });
    return row;
  });

  return { columns, rows };
}

// Apply a user-saved export config (rename/reorder/hide) to a default
// column array. Forward-compatible: columns NOT mentioned in config get
// appended at the end with their defaults — so adding a new column to the
// underlying schema doesn't silently disappear from existing studies'
// configs. Never mutates the input.
function applyExportConfig(defaultColumns, config) {
  if (!config || !Array.isArray(config.columns) || !config.columns.length) {
    return defaultColumns.slice(); // no config → return defaults unchanged
  }
  const byKey = Object.fromEntries(defaultColumns.map(c => [c.key, c]));
  const seen = new Set();
  const out = [];
  // First: columns ordered/customized by the config
  config.columns.forEach(cfg => {
    const base = byKey[cfg.key];
    if (!base) return; // skip stale keys (column may have been removed)
    if (cfg.visible === false) { seen.add(cfg.key); return; }
    seen.add(cfg.key);
    out.push({
      ...base,
      header: cfg.header != null && cfg.header !== '' ? cfg.header : base.header,
    });
  });
  // Then: any default columns not mentioned in config — appended verbatim
  defaultColumns.forEach(c => { if (!seen.has(c.key)) out.push(c); });
  return out;
}

// Apply ONLY header renames from the user's export config — leave the column
// order and visibility intact. Used by the dashboard widget pickers and the
// stats Analizy tab so a column renamed in the export builder is also
// renamed in those pickers (without their lists getting reordered or items
// disappearing — those are export-only concerns).
function applyHeaderOverrides(defaultColumns, config) {
  if (!config || !Array.isArray(config.columns)) return defaultColumns;
  const overrides = {};
  config.columns.forEach(c => {
    if (c && c.key && c.header != null && c.header !== '') overrides[c.key] = c.header;
  });
  if (!Object.keys(overrides).length) return defaultColumns;
  return defaultColumns.map(c => overrides[c.key] ? { ...c, header: overrides[c.key] } : c);
}

// CSV serializer — RFC 4180-ish: quote when value contains comma / quote /
// newline; double-quote inner quotes. Hyperlink cells (objects from
// generateExcel's clarity_link path) serialize to their URL.
function rowsToCsv(columns, rows) {
  const esc = v => {
    if (v == null) return '';
    if (typeof v === 'object' && v.hyperlink) v = v.hyperlink;
    const s = String(v);
    return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map(c => esc(c.header)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
  return header + '\n' + body;
}

async function generateExcel(studyId, options = {}) {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) throw new Error('Study not found');

  // Caller can request a specific export language; defaults to the study's own
  // language. Passing 'pl' (the canonical/source language) returns the export
  // with no translation overlay — useful when a researcher running a CS study
  // wants to read the Polish master copy of their content in the export.
  const requestedLang = options.lang || study.language || 'pl';

  // Preview sessions (is_preview=1, created by the researcher's own "Podgląd"
  // clicks) are hidden by default so they don't pollute production analyses.
  // Pass { includePreview: true } to surface them.
  const includePreview = options.includePreview === true;
  // Built once and concatenated into every session-touching SQL query. Two
  // variants: SQL with the conventional `s.` sessions alias vs. unaliased
  // (used by the bare `FROM sessions ...` counts at the top of the dashboard).
  const previewS  = includePreview ? '' : ' AND s.is_preview = 0';
  const previewNoAlias = includePreview ? '' : ' AND is_preview = 0';

  const isBuilder = study.builder_mode === 1;

  // Builder: parse conditions from manipulation_json
  let builderConditions = []; // [{key:'A', label:'Manipulacyjna'}, ...]
  if (isBuilder) {
    try {
      const manips = JSON.parse(study.manipulation_json || '[]');
      const primary = manips.find(m => m.field && m.field !== 'none' && m.conditions?.length >= 2);
      if (primary) builderConditions = primary.conditions;
    } catch {}
    if (!builderConditions.length) {
      // Fallback: derive from actual session data
      const keys = db.prepare(`SELECT DISTINCT full_condition FROM sessions WHERE study_id=? AND completed=1${previewNoAlias}`).all(studyId).map(r => r.full_condition);
      builderConditions = keys.map(k => ({ key: k, label: k }));
    }
  }

  // ── Demographic questions (loaded early — used for dynamic code map in ALL sheets) ──
  const demoQuestions = db.prepare(
    'SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(studyId);

  // Build a per-study code map from option POSITION (1-indexed), language-agnostic.
  // For each demographic question, option at position 0 → code 1, position 1 → code 2, etc.
  // Falls back to the legacy CODES dict for values not found in demoQuestions
  // (covers studies that never had demographic_questions seeded).
  const studyDemoCodeMap = {}; // { fieldKey: { lowerCaseValue: codeNum } }
  demoQuestions.forEach(q => {
    let opts = [];
    try { opts = JSON.parse(q.options || '[]'); } catch {}
    studyDemoCodeMap[q.field_key] = {};
    opts.forEach((o, i) => {
      const val = (o.value ?? o.label ?? String(o)).toLowerCase();
      studyDemoCodeMap[q.field_key][val] = i + 1;
    });
  });

  function addDemoCodesForStudy(row) {
    const result = {};
    // Always emit _code for the 4 legacy fields (DEMO_COLS expects them)
    ['age', 'residence', 'education', 'gender'].forEach(field => {
      const rawVal = row[field];
      if (rawVal == null) { result[`${field}_code`] = null; return; }
      const lv = String(rawVal).toLowerCase();
      // 1. Dynamic map from this study's demographic questions
      if (studyDemoCodeMap[field]?.[lv] != null) {
        result[`${field}_code`] = studyDemoCodeMap[field][lv];
      // 2. Legacy Polish fallback (backward compat for studies pre-demoQuestions)
      } else {
        result[`${field}_code`] = db.CODES[field]?.[lv] ?? null;
      }
    });
    return result;
  }

  // For SQL: headline/content selection based on style_condition
  // Builder uses style_condition = conditionKey ('A','B'...), legacy uses 'A'/'B'
  // Both resolve correctly with CASE WHEN style_condition='A'

  // Clarity tags are set with session_token (UUID), not the numeric session_id
  const clarityBase = (study.clarity_enabled && study.clarity_project_id)
    ? `https://clarity.microsoft.com/projects/view/${study.clarity_project_id}/impressions?CustomTag=session_id%3A%3A`
    : null;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Misinfo Research Platform';
  wb.created = new Date();

  // ── Translation layer ───────────────────────────────────────────────────────
  // When study.language !== 'pl', presentation fields (post headlines/content/topic,
  // demographic question labels + options, post question labels + options) should be
  // rendered in the target language. Source-of-truth columns remain Polish; we apply
  // a JS-side overlay using translations_json[language] (saved by the translate
  // endpoint). The codebook and all sheets that surface human-readable text go
  // through these helpers so the export is consistent with what the participant saw.
  const studyLang = requestedLang;
  let langTrans = {};
  if (studyLang !== 'pl' && study.translations_json) {
    try { const all = JSON.parse(study.translations_json); langTrans = all[studyLang] || {}; } catch {}
  }
  // Locale file gives us topic names for the 8 default topic keys (used as a fallback)
  let exportLocale = {};
  try {
    const lp = path.join(__dirname, '..', 'public', 'locales', `${studyLang}.json`);
    exportLocale = JSON.parse(fs.readFileSync(lp, 'utf8'));
  } catch {}

  const postTransMap = {}; (langTrans.posts || []).forEach(p => { postTransMap[p.id] = p; });
  const dqTransMap   = {}; (langTrans.demographic_questions || []).forEach(q => { dqTransMap[q.id] = q; });
  const pqTransMap   = {}; (langTrans.post_questions || []).forEach(q => { pqTransMap[q.id] = q; });

  // Translate a post field that depends on style_condition (headline / content).
  // SQL queries fetch headline_shown via CASE WHEN style_condition='A'; we mirror
  // that variant pick here for the translated value, then fall back to original.
  function trVariant(postId, styleCondition, field) {
    const tp = postTransMap[postId];
    if (!tp) return null;
    const isA = styleCondition === 'A' || styleCondition == null;
    const pick = isA ? tp[`${field}_a`] : (tp[`${field}_b`] || tp[`${field}_a`]);
    return pick || null;
  }
  function trHeadlineShown(postId, styleCondition, original) {
    return trVariant(postId, styleCondition, 'headline') || original;
  }
  function trContentShown(postId, styleCondition, original) {
    return trVariant(postId, styleCondition, 'content') || original;
  }
  // Topic: prefer per-study translation → locale → raw key
  function trTopic(topicKey) {
    if (!topicKey) return topicKey;
    // The translate endpoint stored translated topic per-post but topic is shared
    // across posts with the same key, so any post in postTransMap with this topic
    // gives us the translation. Cheaper: just check locale; fall back to raw.
    const locTopic = exportLocale?.topics?.[topicKey];
    if (locTopic) return locTopic;
    // Look in any translated post for the same topic key
    for (const tp of Object.values(postTransMap)) {
      if (tp.topic && tp.topic !== topicKey) return tp.topic; // any non-identity translation wins
    }
    return topicKey;
  }
  function trDqLabel(q) {
    return (dqTransMap[q.id] && dqTransMap[q.id].label) || q.label;
  }
  function trDqOptions(q) {
    let opts = [];
    try { opts = JSON.parse(q.options || '[]'); } catch {}
    const tq = dqTransMap[q.id];
    if (!tq || !Array.isArray(tq.options)) return opts;
    return opts.map((o, i) => ({ ...o, label: (tq.options[i] && tq.options[i].label) ? tq.options[i].label : o.label }));
  }
  function trPqLabel(q) {
    return (pqTransMap[q.id] && pqTransMap[q.id].label) || q.label;
  }

  // Value-→-translated-label map per demographic field. The DB stores the
  // original (Polish) option VALUE, but the participant in a non-PL study
  // clicked the TRANSLATED label. To make the export consistent with what
  // they saw, we map each stored value back to its translated label.
  // Numeric codes (age_code, etc.) and the value→code mapping are unchanged.
  const demoValueTransMap = {};
  demoQuestions.forEach(q => {
    let opts = [];
    try { opts = JSON.parse(q.options || '[]'); } catch {}
    const tq = dqTransMap[q.id];
    if (!tq || !Array.isArray(tq.options)) return;
    const m = {};
    opts.forEach((o, i) => {
      const val = o.value ?? o.label;
      const trLabel = tq.options[i] && tq.options[i].label;
      if (val && trLabel) m[String(val)] = trLabel;
    });
    if (Object.keys(m).length) demoValueTransMap[q.field_key] = m;
  });
  function trDemoValue(fieldKey, storedValue) {
    if (storedValue == null) return storedValue;
    const m = demoValueTransMap[fieldKey];
    return m ? (m[String(storedValue)] ?? storedValue) : storedValue;
  }
  // Convenience: produce a translated text-fields object to spread into
  // every .addRow that uses DEMO_COLS (age / residence / education / gender).
  function trDemoText(row) {
    return {
      age:       trDemoValue('age',       row.age),
      residence: trDemoValue('residence', row.residence),
      education: trDemoValue('education', row.education),
      gender:    trDemoValue('gender',    row.gender),
    };
  }

  // ── Post questions (loaded early — needed for Dane_surowe wide format) ──────
  const postQuestions = db.prepare(
    'SELECT * FROM post_questions WHERE study_id = ? AND is_active = 1 ORDER BY part_id, order_index'
  ).all(studyId);

  // Post-question choice VALUE translation — see buildExportContext for rationale.
  // Maps a stored option `value` (Polish) back to the translated `label` by index
  // for single/multi questions. Open/likert untouched; unmapped values fall through.
  const pqValueTransMap = {};
  postQuestions.forEach(q => {
    if (q.question_type !== 'single' && q.question_type !== 'multi') return;
    let opts = []; try { opts = JSON.parse(q.options_json || '[]'); } catch {}
    const tq = pqTransMap[q.id];
    if (!tq || !Array.isArray(tq.options)) return;
    const m = {};
    opts.forEach((o, i) => {
      const val = o.value ?? o.label;
      const trLabel = tq.options[i] && tq.options[i].label;
      if (val != null && trLabel) m[String(val)] = trLabel;
    });
    if (Object.keys(m).length) pqValueTransMap[q.id] = m;
  });
  function trPqValue(questionId, storedValue) {
    if (storedValue == null) return storedValue;
    const m = pqValueTransMap[questionId];
    return m ? (m[String(storedValue)] ?? storedValue) : storedValue;
  }

  // ── Sheet 1: Dane_surowe — mega tabela, jeden wiersz per sesja ─────────────
  // Delegates to the pure data extractor + config layer so the xlsx export
  // and the inline builder preview always show the same column model + rows.
  const s1 = wb.addWorksheet('Dane_surowe');
  const ds_ctx = buildExportContext(studyId, { lang: requestedLang, includePreview });
  const { columns: ds_defaultCols, rows: ds_rows } = getDaneSuroweData(ds_ctx);
  let ds_exportConfig = {};
  try { ds_exportConfig = JSON.parse(study.export_config_json || '{}'); } catch {}
  const ds_finalCols = applyExportConfig(ds_defaultCols, ds_exportConfig['Dane_surowe']);

  // ── Full-export augmentation of Dane_surowe (Excel only) ────────────────────
  // Dane_surowe is the single "everything" sheet, so append, from the question
  // option DEFINITIONS (complete coverage incl. never-chosen options):
  //  • one-hot (0/1) columns for every multi-select answer —
  //      - demographic input_type='multiselect' (session level, e.g. knowledge-sources)
  //      - post question_type='multi' per post slot (e.g. q30)
  //  • per-post answered_at timestamps (folded in from the long sheets we drop).
  // Appended AFTER applyExportConfig so they always appear regardless of a saved
  // column selection. Augments ONLY this xlsx sheet — the admin dashboard calls
  // getDaneSuroweData directly and is untouched.
  {
    let numPosts = 0;
    ds_defaultCols.forEach(c => { const m = /^post_(\d+)_id$/.exec(c.key); if (m) numPosts = Math.max(numPosts, +m[1]); });

    const dqOptLabelTr = (q, idx, src) => {
      const tq = dqTransMap[q.id];
      return (tq && Array.isArray(tq.options) && tq.options[idx] && tq.options[idx].label) || src;
    };
    const pqOptLabelTr = (q, idx, src) => {
      const tq = pqTransMap[q.id];
      return (tq && Array.isArray(tq.options) && tq.options[idx] && tq.options[idx].label) || src;
    };
    // Demographic multi-select is stored as a single ", "-joined string; some
    // option VALUES contain a comma (e.g. "gazety, czasopisma"), so this greedy
    // longest-first tokenizer consumes whole option values at delimiter
    // boundaries. residue=true ⇒ a stored token matched no known option.
    const greedyParse = (str, sortedVals) => {
      const set = new Set(); const s = String(str); const n = s.length; let pos = 0, residue = false;
      while (pos < n) {
        const ch = s[pos];
        if (ch === ',' || ch === ' ') { pos++; continue; }
        let matched = null;
        for (const sv of sortedVals) {
          if (!sv.v) continue;
          if (s.substr(pos, sv.v.length).toLowerCase() === sv.v.toLowerCase()) {
            const nxt = s[pos + sv.v.length];
            if (nxt === undefined || nxt === ',') { matched = sv; break; }
          }
        }
        if (!matched) { residue = true; break; }
        set.add(matched.i); pos += matched.v.length;
      }
      return { set, residue };
    };
    const LEGACY = ['age', 'residence', 'education', 'gender'];

    const multiDemo = demoQuestions
      .filter(q => (q.input_type || '') === 'multiselect')
      .map(q => {
        let opts = []; try { opts = JSON.parse(q.options || '[]'); } catch {}
        const values = opts.map(o => String(o.value ?? o.label ?? ''));
        const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => b.v.length - a.v.length);
        return { q, opts, values, sorted };
      })
      .filter(m => m.opts.length);

    const multiPost = postQuestions
      .filter(q => q.question_type === 'multi')
      .map(q => {
        let opts = []; try { opts = JSON.parse(q.options_json || '[]'); } catch {}
        return { q, opts, values: opts.map(o => String(o.value ?? o.label ?? '')) };
      })
      .filter(m => m.opts.length);

    // Single-choice one-hot too: the user wants every categorical answer as its
    // own 0/1 column (blank = truly unanswered). Single-select stores ONE value
    // (exact match, no comma-parsing) — for radio demographics and 'single' post
    // questions. Existing raw text + _code columns stay untouched.
    const singleDemo = demoQuestions
      .filter(q => (q.input_type || 'radio') !== 'multiselect')
      .map(q => {
        let opts = []; try { opts = JSON.parse(q.options || '[]'); } catch {}
        return { q, opts, values: opts.map(o => String(o.value ?? o.label ?? '')) };
      })
      .filter(m => m.opts.length); // only questions that actually have options (excludes free age/text)

    const singlePost = postQuestions
      .filter(q => q.question_type === 'single')
      .map(q => {
        let opts = []; try { opts = JSON.parse(q.options_json || '[]'); } catch {}
        return { q, opts, values: opts.map(o => String(o.value ?? o.label ?? '')) };
      })
      .filter(m => m.opts.length);

    // Raw source demographic strings per session (NOT the translated row value —
    // a single-selection multi value would otherwise be mapped to its label).
    const demoRawBySess = {};
    if (multiDemo.length || singleDemo.length) {
      db.prepare(`SELECT id, age, residence, education, gender, demographics_extra_json
                  FROM sessions WHERE study_id = ? AND completed = 1${previewNoAlias}`).all(studyId).forEach(s => {
        let extra = {}; try { extra = JSON.parse(s.demographics_extra_json || '{}'); } catch {}
        demoRawBySess[s.id] = { extra, s };
      });
    }

    const q30BySess = {};
    const multiIds = multiPost.map(m => m.q.id);
    if (multiIds.length) {
      const ph = multiIds.map(() => '?').join(',');
      db.prepare(`SELECT pqr.session_id, pqr.post_order, pqr.question_id, pqr.response_values_json
                  FROM post_question_responses pqr JOIN sessions s ON pqr.session_id = s.id
                  WHERE s.study_id = ? AND s.completed = 1${previewS} AND pqr.question_id IN (${ph})`)
        .all(studyId, ...multiIds).forEach(r => {
          let vals = []; try { vals = JSON.parse(r.response_values_json || '[]'); } catch {}
          ((q30BySess[r.session_id] ||= {})[r.post_order] ||= {})[r.question_id] = new Set(vals.map(String));
        });
    }

    // Single-choice post answers per session×post×question (value from
    // response_text; fall back to first response_values entry).
    const singlePostBySess = {};
    const singleIds = singlePost.map(m => m.q.id);
    if (singleIds.length) {
      const ph = singleIds.map(() => '?').join(',');
      db.prepare(`SELECT pqr.session_id, pqr.post_order, pqr.question_id, pqr.response_text, pqr.response_values_json
                  FROM post_question_responses pqr JOIN sessions s ON pqr.session_id = s.id
                  WHERE s.study_id = ? AND s.completed = 1${previewS} AND pqr.question_id IN (${ph})`)
        .all(studyId, ...singleIds).forEach(r => {
          let val = r.response_text;
          if (val == null || val === '') { try { const a = JSON.parse(r.response_values_json || '[]'); val = a.length ? a[0] : null; } catch {} }
          ((singlePostBySess[r.session_id] ||= {})[r.post_order] ||= {})[r.question_id] = (val == null ? null : String(val));
        });
    }

    const answeredAtBySess = {};
    db.prepare(`SELECT pqr.session_id, pqr.post_order, MAX(pqr.created_at) as answered_at
                FROM post_question_responses pqr JOIN sessions s ON pqr.session_id = s.id
                WHERE s.study_id = ? AND s.completed = 1${previewS} AND pqr.post_order > 0
                GROUP BY pqr.session_id, pqr.post_order`)
      .all(studyId).forEach(r => { (answeredAtBySess[r.session_id] ||= {})[r.post_order] = r.answered_at; });

    const augCols = [];
    multiDemo.forEach(m => m.opts.forEach((o, i) => {
      augCols.push({ header: `${m.q.field_key}::${dqOptLabelTr(m.q, i, String(o.label ?? o.value ?? ''))}`, key: `d_${m.q.id}_${i}`, width: 10 });
    }));
    singleDemo.forEach(m => m.opts.forEach((o, i) => {
      augCols.push({ header: `${m.q.field_key}::${dqOptLabelTr(m.q, i, String(o.label ?? o.value ?? ''))}`, key: `sd_${m.q.id}_${i}`, width: 10 });
    }));
    for (let i = 1; i <= numPosts; i++) {
      multiPost.forEach(m => m.opts.forEach((oi, oidx) => {
        augCols.push({ header: `post_${i}_q${m.q.id}::${pqOptLabelTr(m.q, oidx, String(oi.label ?? oi.value ?? ''))}`, key: `post_${i}_q${m.q.id}_oh${oidx}`, width: 10 });
      }));
      singlePost.forEach(m => m.opts.forEach((oi, oidx) => {
        augCols.push({ header: `post_${i}_q${m.q.id}::${pqOptLabelTr(m.q, oidx, String(oi.label ?? oi.value ?? ''))}`, key: `post_${i}_q${m.q.id}_soh${oidx}`, width: 10 });
      }));
      augCols.push({ header: `post_${i}_answered_at`, key: `post_${i}_answered_at`, width: 20 });
    }

    let unparsed = 0;
    ds_rows.forEach(row => {
      const sid = row.session_id;
      multiDemo.forEach(m => {
        const rec = demoRawBySess[sid];
        const k = m.q.field_key;
        let raw = '';
        if (rec) raw = LEGACY.includes(k) ? (rec.s[k] ?? rec.extra[k]) : (rec.extra[k] ?? rec.s[k]);
        const rawStr = (raw == null) ? '' : String(raw);
        if (rawStr === '') { m.opts.forEach((o, i) => { row[`d_${m.q.id}_${i}`] = null; }); }
        else {
          const { set, residue } = greedyParse(rawStr, m.sorted);
          if (residue) unparsed++;
          m.opts.forEach((o, i) => { row[`d_${m.q.id}_${i}`] = set.has(i) ? 1 : 0; });
        }
      });
      singleDemo.forEach(m => {
        const rec = demoRawBySess[sid];
        const k = m.q.field_key;
        let raw = '';
        if (rec) raw = LEGACY.includes(k) ? (rec.s[k] ?? rec.extra[k]) : (rec.extra[k] ?? rec.s[k]);
        const rawStr = (raw == null) ? '' : String(raw);
        if (rawStr === '') { m.opts.forEach((o, i) => { row[`sd_${m.q.id}_${i}`] = null; }); }
        else { m.opts.forEach((o, i) => { row[`sd_${m.q.id}_${i}`] = (m.values[i] === rawStr) ? 1 : 0; }); }
      });
      for (let i = 1; i <= numPosts; i++) {
        const perQ = q30BySess[sid] && q30BySess[sid][i];
        multiPost.forEach(m => {
          const set = perQ && perQ[m.q.id];
          m.opts.forEach((oi, oidx) => {
            row[`post_${i}_q${m.q.id}_oh${oidx}`] = set ? (set.has(m.values[oidx]) ? 1 : 0) : null;
          });
        });
        const perQs = singlePostBySess[sid] && singlePostBySess[sid][i];
        singlePost.forEach(m => {
          const chosen = perQs ? perQs[m.q.id] : undefined;
          m.opts.forEach((oi, oidx) => {
            row[`post_${i}_q${m.q.id}_soh${oidx}`] = (chosen == null) ? null : (m.values[oidx] === chosen ? 1 : 0);
          });
        });
        const at = answeredAtBySess[sid] && answeredAtBySess[sid][i];
        row[`post_${i}_answered_at`] = at ? toWarsaw(at) : null;
      }
    });
    if (unparsed) console.warn(`[export one-hot] Dane_surowe: ${unparsed} demographic value(s) had an unrecognized token`);

    augCols.forEach(c => ds_finalCols.push(c));
  }

  // ExcelJS expects {header, key, width} — strip our extra metadata (type/group/pinned).
  s1.columns = ds_finalCols.map(c => ({ header: c.header, key: c.key, width: c.width || 15 }));
  styleHeader(s1.getRow(1));
  ds_rows.forEach(r => s1.addRow(r));
  // LEGACY_DEMO_KEYS is referenced by the codebook section much further down
  // (used to order legacy demographic questions ahead of custom ones). Keep
  // a single canonical declaration here so the codebook can read it.
  const LEGACY_DEMO_KEYS = ['age', 'residence', 'education', 'gender'];


  // ── Sheet 2: Credibility ratings ────────────────────────────────────────────
  // Legacy: from `ratings` table. Builder: from `post_question_responses` (Likert questions).
  const s2 = wb.addWorksheet('Oceny_wiarygodnosci');
  s2.columns = [
    { header: 'session_id',       key: 'session_id',       width: 12 },
    { header: 'session_token',    key: 'session_token',     width: 36 },
    { header: 'full_condition',   key: 'full_condition',    width: 14 },
    { header: 'style_condition',  key: 'style_condition',   width: 14 },
    { header: 'metric_condition', key: 'metric_condition',  width: 15 },
    ...DEMO_COLS,
    { header: 'post_id',          key: 'post_id',           width: 10 },
    { header: 'post_order',       key: 'post_order',        width: 11 },
    { header: 'topic',            key: 'topic',             width: 12 },
    { header: 'is_true',          key: 'is_true',           width: 10 },
    { header: 'headline_shown',   key: 'headline_shown',    width: 40 },
    // question_label only populated for builder (multiple Likert questions possible)
    { header: 'question_label',   key: 'question_label',    width: 35 },
    { header: 'belief_1_7',       key: 'belief_1_7',        width: 12 },
    { header: 'comment',          key: 'comment',           width: 40 },
    { header: 'rating_timestamp', key: 'rating_timestamp',  width: 20 },
  ];
  styleHeader(s2.getRow(1));

  if (isBuilder) {
    // Builder: pull all Likert post-question responses as "ratings"
    const builderRatingRows = db.prepare(`
      SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
        s.age, s.residence, s.education, s.gender,
        pqr.post_id, pqr.post_order, p.topic, p.is_true,
        CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
        pq.id as question_id, pq.label as question_label,
        pqr.response_values_json,
        pqr.response_text as comment,
        pqr.created_at as rating_timestamp
      FROM post_question_responses pqr
      JOIN sessions s ON pqr.session_id = s.id
      JOIN post_questions pq ON pqr.question_id = pq.id
      LEFT JOIN posts p ON pqr.post_id = p.id
      WHERE s.study_id = ? AND s.completed = 1${previewS} AND pq.question_type = 'likert'
        AND (pqr.part_id IS NULL OR pqr.part_id = '')
      ORDER BY s.id, pqr.post_order, pq.order_index
    `).all(studyId);

    builderRatingRows.forEach(row => {
      let belief = null;
      try { const arr = JSON.parse(row.response_values_json || '[]'); belief = arr.length ? Number(arr[0]) : null; } catch {}
      s2.addRow({
        ...row,
        ...trDemoText(row),
        metric_condition: cleanMetric(row.metric_condition),
        ...addDemoCodesForStudy(row),
        is_true: row.is_true ? 1 : 0,
        topic:          trTopic(row.topic),
        headline_shown: trHeadlineShown(row.post_id, row.style_condition, row.headline_shown),
        question_label: pqTransMap[row.question_id]?.label || row.question_label,
        belief_1_7: belief,
        rating_timestamp: toWarsaw(row.rating_timestamp),
      });
    });
  } else {
    const ratingRows = db.prepare(`
      SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
        s.age, s.residence, s.education, s.gender,
        p.id as post_id, rt.post_order, p.topic, p.is_true,
        CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
        rt.belief_1_7, rt.comment, rt.timestamp as rating_timestamp
      FROM ratings rt
      JOIN sessions s ON rt.session_id = s.id
      JOIN posts p ON rt.post_id = p.id
      WHERE s.study_id = ? AND s.completed = 1${previewS}
      ORDER BY s.id, rt.post_order
    `).all(studyId);

    ratingRows.forEach(row => s2.addRow({
      ...row,
      ...trDemoText(row),
      metric_condition: cleanMetric(row.metric_condition),
      ...addDemoCodesForStudy(row),
      is_true: row.is_true ? 1 : 0,
      topic:          trTopic(row.topic),
      headline_shown: trHeadlineShown(row.post_id, row.style_condition, row.headline_shown),
      question_label: null,
      rating_timestamp: toWarsaw(row.rating_timestamp),
    }));
  }

  // ── Sheet 3: Combined (reactions + ratings joined per session×post) ──────────
  const s3 = wb.addWorksheet('Dane_polaczone');
  s3.columns = [
    { header: 'session_id',              key: 'session_id',              width: 12 },
    { header: 'session_token',           key: 'session_token',           width: 36 },
    { header: 'full_condition',          key: 'full_condition',          width: 14 },
    { header: 'style_condition',         key: 'style_condition',         width: 14 },
    { header: 'metric_condition',        key: 'metric_condition',        width: 15 },
    ...DEMO_COLS,
    { header: 'post_id',                 key: 'post_id',                 width: 10 },
    { header: 'post_order',              key: 'post_order',              width: 11 },
    { header: 'topic',                   key: 'topic',                   width: 12 },
    { header: 'is_true',                 key: 'is_true',                 width: 10 },
    { header: 'is_misinfo',              key: 'is_misinfo',              width: 11 },
    { header: 'headline_shown',          key: 'headline_shown',          width: 40 },
    { header: 'content_shown',           key: 'content_shown',           width: 50 },
    { header: 'manipulation_techniques', key: 'manipulation_techniques', width: 30 },
    { header: 'likes_shown',             key: 'likes_shown',             width: 13 },
    { header: 'shares_shown',            key: 'shares_shown',            width: 14 },
    { header: 'dislikes_shown',          key: 'dislikes_shown',          width: 15 },
    { header: 'flags_shown',             key: 'flags_shown',             width: 13 },
    { header: 'reaction',                key: 'reaction',                width: 12 },
    { header: 'is_undo',                 key: 'is_undo',                 width: 9  },
    { header: 'dwell_ms',                key: 'dwell_ms',                width: 12 },
    { header: 'liked',                   key: 'liked',                   width: 8  },
    { header: 'shared',                  key: 'shared',                  width: 8  },
    { header: 'disliked',                key: 'disliked',                width: 10 },
    { header: 'flagged',                 key: 'flagged',                 width: 10 },
    { header: 'belief_1_7',              key: 'belief_1_7',              width: 12 },
    { header: 'participant_comment',     key: 'participant_comment',     width: 40 },
  ];
  styleHeader(s3.getRow(1));

  // Base: all reactions; LEFT JOIN ratings so rows without a rating are kept
  // (edge-case: paged layout without mandatory reaction gets a UNION row below)
  const combinedRows = db.prepare(`
    SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
      s.age, s.residence, s.education, s.gender,
      p.id as post_id, r.post_order, p.topic, p.is_true,
      CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
      CASE WHEN s.style_condition='A' THEN p.content_a  ELSE p.content_b  END as content_shown,
      p.manipulation_techniques,
      r.likes_shown, r.shares_shown, r.dislikes_shown, r.flags_shown,
      r.action as reaction, COALESCE(r.is_undo, 0) as is_undo, r.dwell_ms,
      rt.belief_1_7, rt.comment as participant_comment
    FROM reactions r
    JOIN sessions s ON r.session_id = s.id
    JOIN posts    p ON r.post_id    = p.id
    LEFT JOIN ratings rt ON rt.session_id = r.session_id AND rt.post_id = r.post_id
    WHERE s.study_id = ? AND s.completed = 1${previewS}

    UNION ALL

    -- Ratings that have no matching reaction (optional-reaction layouts)
    SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
      s.age, s.residence, s.education, s.gender,
      p.id as post_id, rt.post_order, p.topic, p.is_true,
      CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
      CASE WHEN s.style_condition='A' THEN p.content_a  ELSE p.content_b  END as content_shown,
      p.manipulation_techniques,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL,
      rt.belief_1_7, rt.comment as participant_comment
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts    p ON rt.post_id    = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}
      AND NOT EXISTS (
        SELECT 1 FROM reactions r2
        WHERE r2.session_id = rt.session_id AND r2.post_id = rt.post_id
      )

    ORDER BY session_id, post_order
  `).all(studyId, studyId);

  combinedRows.forEach(row => {
    s3.addRow({
      ...row,
      ...trDemoText(row),
      metric_condition: cleanMetric(row.metric_condition),
      ...addDemoCodesForStudy(row),
      is_true:   row.is_true ? 1 : 0,
      is_misinfo: row.is_true ? 0 : 1,
      manipulation_techniques: (() => { try { return JSON.parse(row.manipulation_techniques || '[]').join('; '); } catch { return ''; } })(),
      topic:          trTopic(row.topic),
      headline_shown: trHeadlineShown(row.post_id, row.style_condition, row.headline_shown),
      content_shown:  trContentShown(row.post_id, row.style_condition, row.content_shown),
      // Boolean flags respect is_undo: a toggled-off click leaves the row
      // in the table (so the audit trail is complete) but liked/shared/…
      // should read 0 for that row.
      liked:    (row.reaction === 'like'    && !row.is_undo) ? 1 : 0,
      shared:   (row.reaction === 'share'   && !row.is_undo) ? 1 : 0,
      disliked: (row.reaction === 'dislike' && !row.is_undo) ? 1 : 0,
      flagged:  (row.reaction === 'flag'    && !row.is_undo) ? 1 : 0,
    });
  });

  // ── Sheet 4: Session summary ─────────────────────────────────────────────────
  const s4 = wb.addWorksheet('Podsumowanie_sesji');
  s4.columns = [
    { header: 'session_id',    key: 'session_id',    width: 12 },
    { header: 'session_token', key: 'session_token', width: 36 },
    { header: 'layout_type', key: 'layout_type', width: 12 },
    { header: 'full_condition', key: 'full_condition', width: 14 },
    { header: 'style_condition', key: 'style_condition', width: 14 },
    { header: 'metric_condition', key: 'metric_condition', width: 15 },
    ...DEMO_COLS,
    { header: 'started_at', key: 'started_at', width: 20 },
    { header: 'completed_at', key: 'completed_at', width: 20 },
    { header: 'duration_minutes', key: 'duration_minutes', width: 17 },
    { header: 'n_likes', key: 'n_likes', width: 10 },
    { header: 'n_shares', key: 'n_shares', width: 11 },
    { header: 'n_dislikes', key: 'n_dislikes', width: 12 },
    { header: 'n_flags', key: 'n_flags', width: 10 },
    { header: 'n_comments', key: 'n_comments', width: 12 },
    { header: 'avg_belief_true_posts', key: 'avg_belief_true_posts', width: 22 },
    { header: 'avg_belief_false_posts', key: 'avg_belief_false_posts', width: 23 },
    { header: 'belief_difference', key: 'belief_difference', width: 18 },
    { header: 'n_positive_on_false', key: 'n_positive_on_false', width: 20 },
    { header: 'n_negative_on_false', key: 'n_negative_on_false', width: 20 },
    { header: 'misinfo_susceptibility_pct', key: 'misinfo_susceptibility_pct', width: 26 },
    { header: 'clarity_link', key: 'clarity_link', width: 20 },
  ];
  styleHeader(s4.getRow(1));

  const sessions = db.prepare(`
    SELECT s.id, s.session_token, st.layout_type, s.full_condition, s.style_condition, s.metric_condition,
      s.age, s.residence, s.education, s.gender, s.started_at, s.completed_at,
      ROUND(CAST((strftime('%s', s.completed_at) - strftime('%s', s.started_at)) AS REAL) / 60.0, 2) as duration_minutes
    FROM sessions s JOIN studies st ON s.study_id = st.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}
    ORDER BY s.completed_at DESC
  `).all(studyId);

  sessions.forEach(sess => {
    // Multi-react: a toggled-off reaction (is_undo=1) still has a row in
    // the table, but it shouldn't count toward the participant's totals.
    // Excluding is_undo=1 rows keeps the session summary honest in both
    // single- and multi-react modes (single mode never sets is_undo=1).
    const agg = db.prepare(`
      SELECT
        SUM(CASE WHEN r.action='like' THEN 1 ELSE 0 END) as n_likes,
        SUM(CASE WHEN r.action='share' THEN 1 ELSE 0 END) as n_shares,
        SUM(CASE WHEN r.action='dislike' THEN 1 ELSE 0 END) as n_dislikes,
        SUM(CASE WHEN r.action='flag' THEN 1 ELSE 0 END) as n_flags,
        SUM(CASE WHEN r.action='comment' THEN 1 ELSE 0 END) as n_comments,
        SUM(CASE WHEN p.is_true=0 AND r.action IN ('like','share') THEN 1 ELSE 0 END) as n_pos_false,
        SUM(CASE WHEN p.is_true=0 AND r.action IN ('dislike','flag') THEN 1 ELSE 0 END) as n_neg_false,
        SUM(CASE WHEN p.is_true=0 THEN 1 ELSE 0 END) as n_false_total
      FROM reactions r JOIN posts p ON r.post_id = p.id
      WHERE r.session_id = ? AND COALESCE(r.is_undo, 0) = 0
    `).get(sess.id);

    const beliefs = db.prepare(`
      SELECT
        AVG(CASE WHEN p.is_true=1 THEN rt.belief_1_7 END) as avg_true,
        AVG(CASE WHEN p.is_true=0 THEN rt.belief_1_7 END) as avg_false
      FROM ratings rt JOIN posts p ON rt.post_id = p.id
      WHERE rt.session_id = ?
    `).get(sess.id);

    const avgTrue  = beliefs.avg_true  ? Math.round(beliefs.avg_true  * 100) / 100 : null;
    const avgFalse = beliefs.avg_false ? Math.round(beliefs.avg_false * 100) / 100 : null;
    const diff = (avgTrue !== null && avgFalse !== null) ? Math.round((avgTrue - avgFalse) * 100) / 100 : null;
    const susceptPct = agg.n_false_total > 0
      ? Math.round((agg.n_pos_false / agg.n_false_total) * 10000) / 100
      : null;

    s4.addRow({
      session_id:    sess.id,
      session_token: sess.session_token,
      layout_type:   sess.layout_type || 'feed',
      full_condition: sess.full_condition,
      style_condition: sess.style_condition,
      metric_condition: cleanMetric(sess.metric_condition),
      ...addDemoCodesForStudy(sess),
      ...trDemoText(sess),
      started_at: toWarsaw(sess.started_at),
      completed_at: toWarsaw(sess.completed_at),
      duration_minutes: sess.duration_minutes,
      n_likes: agg.n_likes, n_shares: agg.n_shares,
      n_dislikes: agg.n_dislikes, n_flags: agg.n_flags,
      n_comments: agg.n_comments,
      avg_belief_true_posts: avgTrue,
      avg_belief_false_posts: avgFalse,
      belief_difference: diff,
      n_positive_on_false: agg.n_pos_false,
      n_negative_on_false: agg.n_neg_false,
      misinfo_susceptibility_pct: susceptPct,
      clarity_link: clarityBase
        ? { text: 'Otwórz nagranie', hyperlink: clarityBase + sess.session_token }
        : '',
    });
  });

  // ── Sheet 5: Design pivot (legacy 2×2 or builder per-condition) ─────────────
  const s5 = wb.addWorksheet('Design_warunki');

  const fmt = (v) => v != null ? Math.round(v * 100) / 100 : '-';

  if (isBuilder) {
    // ── Builder pivot: per condition, N + mean per Likert post-question ────────
    const condKeys  = builderConditions.map(c => c.key);
    const condLabels = builderConditions.map(c => c.label || c.key);

    // Session counts per condition
    const sessionCounts = db.prepare(`
      SELECT full_condition, COUNT(*) as n FROM sessions
      WHERE study_id=? AND completed=1${previewNoAlias} GROUP BY full_condition
    `).all(studyId);
    const scMap = {};
    sessionCounts.forEach(r => { scMap[r.full_condition] = r.n; });

    // Header
    const hdrRow = s5.addRow(['Warunek', ...condLabels, 'Łącznie']);
    styleHeader(hdrRow);
    s5.addRow(['N ukończonych', ...condKeys.map(k => scMap[k] || 0),
      sessionCounts.reduce((s, r) => s + r.n, 0)]);

    // Likert question averages per condition
    const pqs = db.prepare(
      `SELECT * FROM post_questions WHERE study_id=? AND question_type='likert' AND is_active=1 ORDER BY part_id, order_index`
    ).all(studyId);

    if (pqs.length) {
      s5.addRow([]);
      const qHdr = s5.addRow(['Pytanie (Likert)', ...condLabels, 'Łącznie', 'N odpowiedzi']);
      styleHeader(qHdr);

      pqs.forEach(pq => {
        const allVals = [];
        const condMeans = condKeys.map(ck => {
          const rows = db.prepare(`
            SELECT pqr.response_values_json
            FROM post_question_responses pqr
            JOIN sessions s ON pqr.session_id = s.id
            WHERE s.study_id=? AND s.completed=1${previewS} AND pqr.question_id=? AND s.full_condition=?
          `).all(studyId, pq.id, ck);
          const nums = rows.map(r => {
            try { const v = JSON.parse(r.response_values_json || '[]'); return v.length ? Number(v[0]) : null; } catch { return null; }
          }).filter(v => v != null && !isNaN(v));
          nums.forEach(n => allVals.push(n));
          return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100 : '-';
        });
        const totalMean = allVals.length ? Math.round(allVals.reduce((a, b) => a + b, 0) / allVals.length * 100) / 100 : '-';
        s5.addRow([trPqLabel(pq), ...condMeans, totalMean, allVals.length]);
      });
    }

    // Open question response counts per condition
    const oqs = db.prepare(
      `SELECT * FROM post_questions WHERE study_id=? AND question_type IN ('open','single','multi') AND is_active=1 ORDER BY order_index`
    ).all(studyId);
    if (oqs.length) {
      s5.addRow([]);
      const oqHdr = s5.addRow(['Pytanie (inne)', ...condLabels, 'Łącznie']);
      styleHeader(oqHdr);
      oqs.forEach(pq => {
        const condCounts = condKeys.map(ck =>
          db.prepare(`SELECT COUNT(*) as n FROM post_question_responses pqr JOIN sessions s ON pqr.session_id=s.id WHERE s.study_id=? AND s.completed=1${previewS} AND pqr.question_id=? AND s.full_condition=?`).get(studyId, pq.id, ck)?.n || 0
        );
        s5.addRow([trPqLabel(pq), ...condCounts, condCounts.reduce((a, b) => a + b, 0)]);
      });
    }

    // Demographic distribution
    s5.addRow([]);
    const dh = s5.addRow(['Rozkład demograficzny']);
    dh.getCell(1).font = { bold: true };
    const dHdr = s5.addRow(['Cecha', 'Wartość', ...condLabels, 'Łącznie']);
    styleHeader(dHdr);
    [{ key: 'age', label: 'Wiek' }, { key: 'residence', label: 'Miejsce' },
     { key: 'education', label: 'Wykształcenie' }, { key: 'gender', label: 'Płeć' }].forEach(({ key, label }) => {
      const vals = db.prepare(`SELECT DISTINCT ${key} FROM sessions WHERE study_id=? AND completed=1${previewNoAlias} AND ${key} IS NOT NULL`).all(studyId).map(r => r[key]);
      vals.forEach(val => {
        const counts = condKeys.map(ck =>
          db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE study_id=? AND completed=1${previewNoAlias} AND full_condition=? AND ${key}=?`).get(studyId, ck, val)?.c || 0
        );
        s5.addRow([label, val, ...counts, counts.reduce((a, b) => a + b, 0)]);
      });
    });

  } else {
    // ── Legacy 2×2 pivot ───────────────────────────────────────────────────────
    const pivotData = db.prepare(`
      SELECT s.full_condition,
        COUNT(DISTINCT s.id) as n_completed,
        AVG(CASE WHEN p.is_true=0 THEN rt.belief_1_7 END) as mean_belief_false,
        AVG(CASE WHEN p.is_true=1 THEN rt.belief_1_7 END) as mean_belief_true
      FROM sessions s
      LEFT JOIN ratings rt ON rt.session_id = s.id
      LEFT JOIN posts p ON rt.post_id = p.id
      WHERE s.study_id = ? AND s.completed = 1${previewS}
      GROUP BY s.full_condition
    `).all(studyId);

    const condMap = {};
    pivotData.forEach(r => { condMap[r.full_condition] = r; });
    const getN   = (cond) => condMap[cond]?.n_completed || 0;
    const getMBF = (cond) => condMap[cond]?.mean_belief_false ?? null;
    const getMBT = (cond) => condMap[cond]?.mean_belief_true ?? null;
    const totalN  = (conds) => conds.reduce((s, c) => s + getN(c), 0);
    const avgMean = (conds, fn) => {
      const vals = conds.map(fn).filter(v => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    s5.addRow(['', 'Metrics HIGH', '', '', '', 'Metrics LOW', '', '', '', 'Total', '', '', '']);
    s5.addRow(['Styl', 'N ukończono', 'Śr. wiara (fałsz.)', 'Śr. wiara (prawdz.)', 'Różnica',
      'N ukończono', 'Śr. wiara (fałsz.)', 'Śr. wiara (prawdz.)', 'Różnica',
      'N ukończono', 'Śr. wiara (fałsz.)', 'Śr. wiara (prawdz.)', 'Różnica']);
    styleHeader(s5.getRow(1));
    styleHeader(s5.getRow(2));

    const addPivotRow = (label, highCond, lowCond, totalConds) => {
      const hN = getN(highCond), hF = getMBF(highCond), hT = getMBT(highCond);
      const lN = getN(lowCond),  lF = getMBF(lowCond),  lT = getMBT(lowCond);
      const tN = totalN(totalConds);
      const tF = avgMean(totalConds, getMBF);
      const tT = avgMean(totalConds, getMBT);
      s5.addRow([
        label,
        hN, fmt(hF), fmt(hT), fmt(hT !== null && hF !== null ? hT - hF : null),
        lN, fmt(lF), fmt(lT), fmt(lT !== null && lF !== null ? lT - lF : null),
        tN, fmt(tF), fmt(tT), fmt(tF !== null && tT !== null ? tT - tF : null),
      ]);
    };

    addPivotRow('Styl A', 'A-HIGH', 'A-LOW', ['A-HIGH', 'A-LOW']);
    addPivotRow('Styl B', 'B-HIGH', 'B-LOW', ['B-HIGH', 'B-LOW']);
    addPivotRow('Łącznie', 'A-HIGH', 'A-LOW', ['A-HIGH', 'A-LOW', 'B-HIGH', 'B-LOW']);

    s5.addRow([]);
    const demoHdr = s5.addRow(['Rozkład demograficzny ukończonych sesji']);
    demoHdr.getCell(1).font = { bold: true };
    s5.addRow(['Cecha', 'Wartość', 'A-HIGH', 'A-LOW', 'B-HIGH', 'B-LOW', 'Łącznie']);
    styleHeader(s5.lastRow);

    [{ key: 'age', label: 'Wiek' }, { key: 'residence', label: 'Miejsce zamieszkania' },
     { key: 'education', label: 'Wykształcenie' }, { key: 'gender', label: 'Płeć' }].forEach(({ key, label }) => {
      const vals = db.prepare(`SELECT DISTINCT ${key} FROM sessions WHERE study_id=? AND completed=1${previewNoAlias} AND ${key} IS NOT NULL`).all(studyId).map(r => r[key]);
      vals.forEach(val => {
        const counts = ['A-HIGH', 'A-LOW', 'B-HIGH', 'B-LOW'].map(cond =>
          db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE study_id=? AND completed=1${previewNoAlias} AND full_condition=? AND ${key}=?`).get(studyId, cond, val)?.c || 0
        );
        s5.addRow([label, val, ...counts, counts.reduce((a, b) => a + b, 0)]);
      });
    });
  }

  s5.columns = s5.columns.map(c => ({ ...c, width: Math.max(c.width || 12, 18) }));

  // ── Sheet 6: Eye-tracking aggregated per session × post ─────────────────────
  const s6et = wb.addWorksheet('Eye_tracking');
  s6et.columns = [
    { header: 'session_id',          key: 'session_id',          width: 12 },
    { header: 'session_token',       key: 'session_token',       width: 36 },
    { header: 'full_condition',      key: 'full_condition',      width: 14 },
    { header: 'style_condition',     key: 'style_condition',     width: 14 },
    { header: 'metric_condition',    key: 'metric_condition',    width: 15 },
    ...DEMO_COLS,
    { header: 'eyetracking_consent', key: 'eyetracking_consent', width: 20 },
    { header: 'calibration_error_px',key: 'calibration_error',  width: 22 },
    { header: 'n_recalibrations',    key: 'n_recalibrations',   width: 18 },
    { header: 'post_id',             key: 'post_id',             width: 10 },
    { header: 'post_order',          key: 'post_order',          width: 11 },
    { header: 'topic',               key: 'topic',               width: 12 },
    { header: 'is_true',             key: 'is_true',             width: 10 },
    { header: 'n_gaze_pts',          key: 'n_gaze_pts',          width: 12 },
    { header: 'pct_headline',        key: 'pct_headline',        width: 15 },
    { header: 'pct_content',         key: 'pct_content',         width: 14 },
    { header: 'pct_image',           key: 'pct_image',           width: 13 },
    { header: 'pct_metrics',         key: 'pct_metrics',         width: 14 },
    { header: 'pct_actions',         key: 'pct_actions',         width: 14 },
    { header: 'pct_avatar',          key: 'pct_avatar',          width: 13 },
    { header: 'pct_other',           key: 'pct_other',           width: 12 },
  ];
  styleHeader(s6et.getRow(1));

  try {
    const gazeRows = db.prepare(`
      SELECT s.id as session_id, s.session_token, s.full_condition,
             s.style_condition, s.metric_condition,
             s.age, s.residence, s.education, s.gender,
             s.eyetracking_consent, s.calibration_error, s.n_recalibrations,
             g.post_id, g.post_order, p.topic, p.is_true,
             COUNT(*) as n_gaze_pts,
             ROUND(100.0 * SUM(CASE WHEN g.aoi='headline' THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_headline,
             ROUND(100.0 * SUM(CASE WHEN g.aoi='content'  THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_content,
             ROUND(100.0 * SUM(CASE WHEN g.aoi='image'    THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_image,
             ROUND(100.0 * SUM(CASE WHEN g.aoi='metrics'  THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_metrics,
             ROUND(100.0 * SUM(CASE WHEN g.aoi='actions'  THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_actions,
             ROUND(100.0 * SUM(CASE WHEN g.aoi='avatar'   THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_avatar,
             ROUND(100.0 * SUM(CASE WHEN g.aoi NOT IN ('headline','content','image','metrics','actions','avatar') OR g.aoi IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_other
        FROM gaze_points g
        JOIN sessions s ON g.session_id = s.id
        JOIN posts    p ON g.post_id    = p.id
       WHERE s.study_id = ? AND s.eyetracking_consent = 1${previewS} AND g.post_id IS NOT NULL
       GROUP BY s.id, g.post_id
       ORDER BY s.id, g.post_order
    `).all(studyId);

    gazeRows.forEach(row => s6et.addRow({
      ...row,
      ...trDemoText(row),
      ...addDemoCodesForStudy(row),
      is_true: row.is_true ? 1 : 0,
    }));
  } catch (_) { /* table may not exist on old deployments — sheet stays empty */ }

  // ── Sheet 7: Custom demographic question responses ───────────────────────────
  // demoQuestions already loaded at top of generateExcel (used for dynamic code map)
  const s7demo = wb.addWorksheet('Pytania_demograficzne');
  const demoCols = [
    { header: 'session_id',    key: 'session_id',    width: 12 },
    { header: 'session_token', key: 'session_token', width: 36 },
    { header: 'full_condition', key: 'full_condition', width: 14 },
    ...DEMO_COLS,
  ];
  // Add one column per custom question
  demoQuestions.forEach(q => {
    demoCols.push({ header: q.field_key, key: `dq_${q.id}`, width: 24 });
  });
  s7demo.columns = demoCols;
  styleHeader(s7demo.getRow(1));

  const demoSessions = db.prepare(`
    SELECT s.id as session_id, s.session_token, s.full_condition,
           s.age, s.residence, s.education, s.gender,
           s.demographics_extra_json
    FROM sessions s
    WHERE s.study_id = ? AND s.completed = 1${previewS}
    ORDER BY s.id
  `).all(studyId);

  demoSessions.forEach(sess => {
    let extra = {};
    try { extra = JSON.parse(sess.demographics_extra_json || '{}'); } catch {}
    const row = {
      session_id:    sess.session_id,
      session_token: sess.session_token,
      full_condition: sess.full_condition,
      ...trDemoText(sess),
      ...addDemoCodesForStudy(sess),
    };
    demoQuestions.forEach(q => {
      // Custom questions saved in extra; legacy 4 already in top-level fields.
      // For consistency, translate the value-as-stored back to its localized label.
      const rawVal = extra[q.field_key] ?? sess[q.field_key] ?? null;
      row[`dq_${q.id}`] = trDemoValue(q.field_key, rawVal);
    });
    s7demo.addRow(row);
  });

  // ── Sheet 8: Post question responses ─────────────────────────────────────────
  // (postQuestions was already loaded near the top of generateExcel)
  const s8pq = wb.addWorksheet('Pytania_do_postow');
  s8pq.columns = [
    { header: 'session_id',     key: 'session_id',     width: 12 },
    { header: 'session_token',  key: 'session_token',  width: 36 },
    { header: 'full_condition', key: 'full_condition',  width: 14 },
    ...DEMO_COLS,
    { header: 'post_id',        key: 'post_id',        width: 10 },
    { header: 'post_order',     key: 'post_order',     width: 11 },
    { header: 'post_source',    key: 'post_source',    width: 22 },
    { header: 'post_headline',  key: 'post_headline',  width: 45 },
    { header: 'part_id',        key: 'part_id',        width: 14 },
    { header: 'question_id',    key: 'question_id',    width: 12 },
    { header: 'question_label', key: 'question_label', width: 40 },
    { header: 'question_type',  key: 'question_type',  width: 14 },
    { header: 'response_text',  key: 'response_text',  width: 40 },
    { header: 'response_values',key: 'response_values',width: 30 },
    { header: 'answered_at',    key: 'answered_at',    width: 20 },
  ];
  styleHeader(s8pq.getRow(1));

  const pqRows = db.prepare(`
    SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition,
           s.age, s.residence, s.education, s.gender,
           pqr.post_id, pqr.post_order,
           p.source_name as post_source,
           CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as post_headline,
           pq.id as question_id, pq.label as question_label,
           pq.question_type, pq.part_id,
           pqr.response_text, pqr.response_values_json,
           pqr.created_at as answered_at
    FROM post_question_responses pqr
    JOIN sessions s ON pqr.session_id = s.id
    JOIN post_questions pq ON pqr.question_id = pq.id
    LEFT JOIN posts p ON pqr.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}
    ORDER BY s.id, pqr.post_order, pq.order_index
  `).all(studyId);

  pqRows.forEach(row => {
    let vals = [];
    try { vals = JSON.parse(row.response_values_json || '[]'); } catch {}
    s8pq.addRow({
      ...row,
      ...trDemoText(row),
      ...addDemoCodesForStudy(row),
      post_headline:  trHeadlineShown(row.post_id, row.style_condition, row.post_headline),
      question_label: pqTransMap[row.question_id]?.label || row.question_label,
      response_values: vals.map(v => trPqValue(row.question_id, v)).join('; '),
      answered_at: toWarsaw(row.answered_at),
    });
  });

  // ── Sheet 9: Complete flat table (one row per session × post, all data merged) ─
  const s9 = wb.addWorksheet('Dane_kompletne');

  const s9cols = [
    { header: 'session_id',       key: 'session_id',       width: 12 },
    { header: 'session_token',    key: 'session_token',     width: 36 },
    { header: 'full_condition',   key: 'full_condition',    width: 14 },
    { header: 'style_condition',  key: 'style_condition',   width: 14 },
    { header: 'metric_condition', key: 'metric_condition',  width: 15 },
    ...DEMO_COLS,
  ];
  // One column per custom demographic question
  demoQuestions.forEach(q => {
    s9cols.push({ header: q.field_key, key: `dq_${q.id}`, width: 22 });
  });
  s9cols.push(
    { header: 'post_id',        key: 'post_id',        width: 10 },
    { header: 'post_order',     key: 'post_order',      width: 11 },
    { header: 'post_source',    key: 'post_source',     width: 22 },
    { header: 'post_headline',  key: 'post_headline',   width: 45 },
    { header: 'topic',          key: 'topic',           width: 12 },
    { header: 'is_true',        key: 'is_true',         width: 10 },
    { header: 'is_misinfo',     key: 'is_misinfo',      width: 11 },
    { header: 'likes_shown',    key: 'likes_shown',     width: 13 },
    { header: 'shares_shown',   key: 'shares_shown',    width: 14 },
    { header: 'dislikes_shown', key: 'dislikes_shown',  width: 15 },
    { header: 'flags_shown',    key: 'flags_shown',     width: 13 },
    { header: 'reaction',       key: 'reaction',        width: 12 },
    { header: 'is_undo',        key: 'is_undo',         width: 9  },
    { header: 'dwell_ms',       key: 'dwell_ms',        width: 12 },
    { header: 'liked',          key: 'liked',           width: 8  },
    { header: 'shared',         key: 'shared',          width: 8  },
    { header: 'disliked',       key: 'disliked',        width: 10 },
    { header: 'flagged',        key: 'flagged',         width: 10 },
  );
  if (!isBuilder) {
    // Legacy only: credibility rating and open comment from ratings table
    s9cols.push({ header: 'belief_1_7',         key: 'belief_1_7',         width: 12 });
    s9cols.push({ header: 'participant_comment', key: 'participant_comment', width: 40 });
  }
  // One column per post question (pivoted wide). Header uses translated label;
  // the column key stays stable (`pq_<id>`) so JS pivot logic still works.
  postQuestions.forEach(pq => {
    s9cols.push({ header: (trPqLabel(pq) || '').substring(0, 35), key: `pq_${pq.id}`, width: 28 });
  });
  s9.columns = s9cols;
  styleHeader(s9.getRow(1));

  // Pre-load post question responses: Map[`${session_id}_${post_id}`] → {pq_ID: value}
  const pqRespMap = {};
  if (postQuestions.length) {
    db.prepare(`
      SELECT pqr.session_id, pqr.post_id, pqr.question_id,
             pqr.response_text, pqr.response_values_json
      FROM post_question_responses pqr
      JOIN sessions s ON pqr.session_id = s.id
      WHERE s.study_id = ? AND s.completed = 1${previewS}
    `).all(studyId).forEach(r => {
      const k = `${r.session_id}_${r.post_id}`;
      if (!pqRespMap[k]) pqRespMap[k] = {};
      let val = r.response_text;
      if (!val) {
        try { const arr = JSON.parse(r.response_values_json || '[]'); val = arr.map(v => trPqValue(r.question_id, v)).join('; '); } catch {}
      }
      pqRespMap[k][`pq_${r.question_id}`] = val ?? null;
    });
  }

  // Pre-load demographics_extra_json per session (reuse demoSessions already queried)
  const demoExtraMap = {};
  demoSessions.forEach(sess => {
    let extra = {};
    try { extra = JSON.parse(sess.demographics_extra_json || '{}'); } catch {}
    demoExtraMap[sess.session_id] = extra;
  });

  // Base rows: reactions + posts that were only rated/answered (no reaction recorded)
  const s9baseRows = isBuilder
    ? db.prepare(`
        SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
          s.age, s.residence, s.education, s.gender,
          p.id as post_id, r.post_order, p.topic, p.is_true,
          p.source_name as post_source,
          CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as post_headline,
          r.likes_shown, r.shares_shown, r.dislikes_shown, r.flags_shown,
          r.action as reaction, COALESCE(r.is_undo, 0) as is_undo, r.dwell_ms
        FROM reactions r
        JOIN sessions s ON r.session_id = s.id
        JOIN posts p ON r.post_id = p.id
        WHERE s.study_id = ? AND s.completed = 1${previewS}

        UNION ALL

        SELECT s.id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
          s.age, s.residence, s.education, s.gender,
          p.id, MIN(pqr2.post_order), p.topic, p.is_true,
          p.source_name,
          CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM post_question_responses pqr2
        JOIN sessions s ON pqr2.session_id = s.id
        JOIN posts p ON pqr2.post_id = p.id
        WHERE s.study_id = ? AND s.completed = 1${previewS}
          AND NOT EXISTS (SELECT 1 FROM reactions rx WHERE rx.session_id=pqr2.session_id AND rx.post_id=pqr2.post_id)
        GROUP BY s.id, p.id

        ORDER BY session_id, post_order
      `).all(studyId, studyId)
    : db.prepare(`
        SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
          s.age, s.residence, s.education, s.gender,
          p.id as post_id, r.post_order, p.topic, p.is_true,
          p.source_name as post_source,
          CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as post_headline,
          r.likes_shown, r.shares_shown, r.dislikes_shown, r.flags_shown,
          r.action as reaction, COALESCE(r.is_undo, 0) as is_undo, r.dwell_ms,
          rt.belief_1_7, rt.comment as participant_comment
        FROM reactions r
        JOIN sessions s ON r.session_id = s.id
        JOIN posts p ON r.post_id = p.id
        LEFT JOIN ratings rt ON rt.session_id = r.session_id AND rt.post_id = r.post_id
        WHERE s.study_id = ? AND s.completed = 1${previewS}

        UNION ALL

        SELECT s.id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
          s.age, s.residence, s.education, s.gender,
          p.id, rt2.post_order, p.topic, p.is_true,
          p.source_name,
          CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          rt2.belief_1_7, rt2.comment
        FROM ratings rt2
        JOIN sessions s ON rt2.session_id = s.id
        JOIN posts p ON rt2.post_id = p.id
        WHERE s.study_id = ? AND s.completed = 1${previewS}
          AND NOT EXISTS (SELECT 1 FROM reactions rx WHERE rx.session_id=rt2.session_id AND rx.post_id=rt2.post_id)

        ORDER BY session_id, post_order
      `).all(studyId, studyId);

  s9baseRows.forEach(row => {
    const k = `${row.session_id}_${row.post_id}`;
    const pqVals = pqRespMap[k] || {};
    const extra  = demoExtraMap[row.session_id] || {};
    const rowData = {
      ...row,
      ...trDemoText(row),
      metric_condition: cleanMetric(row.metric_condition),
      ...addDemoCodesForStudy(row),
      is_true:   row.is_true ? 1 : 0,
      is_misinfo: row.is_true ? 0 : 1,
      topic:         trTopic(row.topic),
      post_headline: trHeadlineShown(row.post_id, row.style_condition, row.post_headline),
      // Multi-react: is_undo=1 rows still appear in the audit trail but
      // their per-action flags read 0.
      liked:    (row.reaction === 'like'    && !row.is_undo) ? 1 : 0,
      shared:   (row.reaction === 'share'   && !row.is_undo) ? 1 : 0,
      disliked: (row.reaction === 'dislike' && !row.is_undo) ? 1 : 0,
      flagged:  (row.reaction === 'flag'    && !row.is_undo) ? 1 : 0,
    };
    // Custom demographic answers — translate the stored value to its localized label
    demoQuestions.forEach(q => {
      const rawVal = extra[q.field_key] ?? row[q.field_key] ?? null;
      rowData[`dq_${q.id}`] = trDemoValue(q.field_key, rawVal);
    });
    // Post question answers (pivoted wide)
    postQuestions.forEach(pq => {
      rowData[`pq_${pq.id}`] = pqVals[`pq_${pq.id}`] ?? null;
    });
    s9.addRow(rowData);
  });


  // ── Sheet 10: Codebook ─────────────────────────────────────────────────────────
  const s7 = wb.addWorksheet('Klucz_kodowania');

  s7.columns = [
    { header: 'Zmienna', key: 'variable', width: 28 },
    { header: 'Wartość tekstowa', key: 'label', width: 30 },
    { header: 'Kod numeryczny', key: 'code_val', width: 16 },
  ];
  styleCodebookHeader(s7.getRow(1));

  // Build condition entries dynamically (builder vs legacy)
  const conditionCodebookEntries = [];
  conditionCodebookEntries.push({ variable: 'WARUNEK (full_condition)', label: '', code_val: '' });
  if (isBuilder) {
    if (builderConditions.length) {
      builderConditions.forEach((c, i) => {
        conditionCodebookEntries.push({ variable: '', label: `${c.key} — ${c.label || c.key}`, code_val: i + 1 });
      });
    } else {
      // No manipulation defined — single group
      const actualConds = db.prepare(
        `SELECT DISTINCT full_condition FROM sessions WHERE study_id=? AND completed=1${previewNoAlias}`
      ).all(studyId).map(r => r.full_condition);
      actualConds.forEach((c, i) => {
        conditionCodebookEntries.push({ variable: '', label: c, code_val: i + 1 });
      });
    }
  } else {
    conditionCodebookEntries.push({ variable: '', label: 'A-HIGH — styl manipulacyjny, metryki wysokie', code_val: '' });
    conditionCodebookEntries.push({ variable: '', label: 'A-LOW  — styl manipulacyjny, metryki niskie', code_val: '' });
    conditionCodebookEntries.push({ variable: '', label: 'B-HIGH — styl neutralny, metryki wysokie', code_val: '' });
    conditionCodebookEntries.push({ variable: '', label: 'B-LOW  — styl neutralny, metryki niskie', code_val: '' });
  }

  // Post questions legend (if any defined for this study)
  const pqLegendEntries = [];
  if (postQuestions.length) {
    pqLegendEntries.push({ variable: '', label: '', code_val: '' });
    pqLegendEntries.push({ variable: 'PYTANIA DO POSTÓW (Pytania_do_postow)', label: '', code_val: '' });
    postQuestions.forEach(pq => {
      pqLegendEntries.push({ variable: '', label: `[${pq.question_type}] ${trPqLabel(pq)}`, code_val: pq.id });
    });
  }

  // Custom demographic questions legend
  const demoQLegendEntries = [];
  if (demoQuestions.length) {
    demoQLegendEntries.push({ variable: '', label: '', code_val: '' });
    demoQLegendEntries.push({ variable: 'PYTANIA DEMOGRAFICZNE (Pytania_demograficzne)', label: '', code_val: '' });
    demoQuestions.forEach(dq => {
      demoQLegendEntries.push({ variable: dq.field_key, label: trDqLabel(dq), code_val: '' });
    });
  }

  // Build demo codebook entries dynamically from this study's demographic_questions
  // Code = 1-indexed position of option in the question's options list (language-agnostic)
  const demoCbEntries = [];
  // (LEGACY_DEMO_KEYS already declared at top of generateExcel for the wide Dane_surowe)
  // Show the 4 legacy fields first (they map to DEMO_COLS in all sheets)
  const orderedDemoQs = [
    ...LEGACY_DEMO_KEYS.map(k => demoQuestions.find(q => q.field_key === k)).filter(Boolean),
    ...demoQuestions.filter(q => !LEGACY_DEMO_KEYS.includes(q.field_key)),
  ];
  orderedDemoQs.forEach(q => {
    // Use translated label + translated option labels for the codebook
    const trLabel = trDqLabel(q);
    const opts = trDqOptions(q);
    const colKey = LEGACY_DEMO_KEYS.includes(q.field_key)
      ? `${q.field_key} / ${q.field_key}_code`
      : q.field_key;
    demoCbEntries.push({ variable: `${(trLabel || '').toUpperCase()} (${colKey})`, label: '', code_val: '' });
    opts.forEach((o, i) => {
      demoCbEntries.push({ variable: '', label: o.label || o.value || String(o), code_val: i + 1 });
    });
    demoCbEntries.push({ variable: '', label: '', code_val: '' });
  });
  // Fallback: if no demoQuestions seeded, show hardcoded Polish legend
  if (!orderedDemoQs.length) {
    demoCbEntries.push(
      { variable: 'PŁEĆ (gender / gender_code)', label: '', code_val: '' },
      { variable: '', label: 'kobieta', code_val: 1 }, { variable: '', label: 'mężczyzna', code_val: 2 },
      { variable: '', label: 'inne', code_val: 3 }, { variable: '', label: 'wolę nie podawać', code_val: 4 },
      { variable: '', label: '', code_val: '' },
      { variable: 'WIEK (age / age_code)', label: '', code_val: '' },
      { variable: '', label: '18-25', code_val: 1 }, { variable: '', label: '26-35', code_val: 2 },
      { variable: '', label: '36-45', code_val: 3 }, { variable: '', label: '46-60', code_val: 4 },
      { variable: '', label: '60+', code_val: 5 }, { variable: '', label: '', code_val: '' },
      { variable: 'MIEJSCE ZAMIESZKANIA (residence / residence_code)', label: '', code_val: '' },
      { variable: '', label: 'duże miasto', code_val: 1 }, { variable: '', label: 'średnie miasto', code_val: 2 },
      { variable: '', label: 'małe miasto', code_val: 3 }, { variable: '', label: 'wieś', code_val: 4 },
      { variable: '', label: '', code_val: '' },
      { variable: 'WYKSZTAŁCENIE (education / education_code)', label: '', code_val: '' },
      { variable: '', label: 'podstawowe', code_val: 1 }, { variable: '', label: 'średnie', code_val: 2 },
      { variable: '', label: 'wyższe licencjat', code_val: 3 }, { variable: '', label: 'wyższe magister+', code_val: 4 },
      { variable: '', label: '', code_val: '' },
    );
  }

  const codebookEntries = [
    ...demoCbEntries,
    ...conditionCodebookEntries,
    ...pqLegendEntries,
    ...demoQLegendEntries,
  ];

  codebookEntries.forEach((entry, i) => {
    const row = s7.addRow(entry);
    if (entry.variable && entry.label === '') {
      row.getCell(1).font = { bold: true, color: { argb: 'FF3B4A8A' } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf0f2fa' } };
    }
    if (entry.code_val !== '') {
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(3).font = { bold: true };
    }
  });

  // ── Slim the workbook down to the two sheets researchers actually use ────────
  // Dane_surowe is now the single "everything" sheet (wide, incl. one-hot dummies
  // + per-post answered_at), and Klucz_kodowania is the codebook. The remaining
  // sheets are either long-format reshapes of data already in Dane_surowe, pure
  // aggregates/summaries, or empty — and the two big long sheets dominated file
  // size (~95%). Built above (so shared variables stay intact) then dropped here.
  ['Oceny_wiarygodnosci', 'Dane_polaczone', 'Podsumowanie_sesji', 'Design_warunki',
   'Eye_tracking', 'Pytania_demograficzne', 'Pytania_do_postow', 'Dane_kompletne']
    .forEach(name => { const ws = wb.getWorksheet(name); if (ws) wb.removeWorksheet(ws.id); });

  return wb;
}

module.exports = { generateExcel, buildExportContext, getDaneSuroweData, applyExportConfig, applyHeaderOverrides, rowsToCsv };
