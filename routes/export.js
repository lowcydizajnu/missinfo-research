const ExcelJS = require('exceljs');
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
  { header: 'age_kod', key: 'age_code', width: 10 },
  { header: 'residence', key: 'residence', width: 20 },
  { header: 'residence_kod', key: 'residence_code', width: 15 },
  { header: 'education', key: 'education', width: 22 },
  { header: 'education_kod', key: 'education_code', width: 15 },
  { header: 'gender', key: 'gender', width: 14 },
  { header: 'gender_kod', key: 'gender_code', width: 12 },
];

function addDemoCodes(row) {
  return {
    age_code: code('age', row.age),
    residence_code: code('residence', row.residence),
    education_code: code('education', row.education),
    gender_code: code('gender', row.gender),
  };
}

async function generateExcel(studyId) {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) throw new Error('Study not found');

  // Clarity tags are set with session_token (UUID), not the numeric session_id
  const clarityBase = (study.clarity_enabled && study.clarity_project_id)
    ? `https://clarity.microsoft.com/projects/view/${study.clarity_project_id}/impressions?CustomTag=session_id%3A%3A`
    : null;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MissInfo Research Platform';
  wb.created = new Date();

  // ── Sheet 1: Raw reactions ──────────────────────────────────────────────────
  const s1 = wb.addWorksheet('Dane_surowe');
  s1.columns = [
    { header: 'session_id',    key: 'session_id',    width: 12 },
    { header: 'session_token', key: 'session_token', width: 36 },
    { header: 'full_condition', key: 'full_condition', width: 14 },
    { header: 'style_condition', key: 'style_condition', width: 14 },
    { header: 'metric_condition', key: 'metric_condition', width: 15 },
    ...DEMO_COLS,
    { header: 'post_id', key: 'post_id', width: 10 },
    { header: 'post_order', key: 'post_order', width: 11 },
    { header: 'topic', key: 'topic', width: 12 },
    { header: 'is_true', key: 'is_true', width: 10 },
    { header: 'is_misinfo', key: 'is_misinfo', width: 11 },
    { header: 'headline_shown', key: 'headline_shown', width: 40 },
    { header: 'content_shown', key: 'content_shown', width: 50 },
    { header: 'manipulation_techniques', key: 'manipulation_techniques', width: 30 },
    { header: 'likes_shown', key: 'likes_shown', width: 13 },
    { header: 'shares_shown', key: 'shares_shown', width: 14 },
    { header: 'dislikes_shown', key: 'dislikes_shown', width: 15 },
    { header: 'flags_shown', key: 'flags_shown', width: 13 },
    { header: 'reaction', key: 'reaction', width: 12 },
    { header: 'reaction_timestamp', key: 'reaction_timestamp', width: 20 },
    { header: 'dwell_ms', key: 'dwell_ms', width: 12 },
    { header: 'liked', key: 'liked', width: 8 },
    { header: 'shared', key: 'shared', width: 8 },
    { header: 'disliked', key: 'disliked', width: 10 },
    { header: 'flagged', key: 'flagged', width: 10 },
    { header: 'clarity_link', key: 'clarity_link', width: 20 },
  ];
  styleHeader(s1.getRow(1));

  const rawRows = db.prepare(`
    SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
      s.age, s.residence, s.education, s.gender,
      p.id as post_id, r.post_order, p.topic, p.is_true,
      CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
      CASE WHEN s.style_condition='A' THEN p.content_a ELSE p.content_b END as content_shown,
      p.manipulation_techniques,
      r.likes_shown, r.shares_shown, r.dislikes_shown, r.flags_shown,
      r.action as reaction, r.timestamp as reaction_timestamp, r.dwell_ms
    FROM reactions r
    JOIN sessions s ON r.session_id = s.id
    JOIN posts p ON r.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1
    ORDER BY s.id, r.post_order
  `).all(studyId);

  rawRows.forEach(row => {
    s1.addRow({
      ...row,
      ...addDemoCodes(row),
      is_true: row.is_true ? 1 : 0,
      is_misinfo: row.is_true ? 0 : 1,
      manipulation_techniques: (() => { try { return JSON.parse(row.manipulation_techniques || '[]').join('; '); } catch { return ''; } })(),
      reaction_timestamp: toWarsaw(row.reaction_timestamp),
      liked: row.reaction === 'like' ? 1 : 0,
      shared: row.reaction === 'share' ? 1 : 0,
      disliked: row.reaction === 'dislike' ? 1 : 0,
      flagged: row.reaction === 'flag' ? 1 : 0,
      clarity_link: clarityBase
        ? { text: 'Otwórz nagranie', hyperlink: clarityBase + row.session_token }
        : '',
    });
  });

  // ── Sheet 2: Credibility ratings ────────────────────────────────────────────
  const s2 = wb.addWorksheet('Oceny_wiarygodnosci');
  s2.columns = [
    { header: 'session_id',    key: 'session_id',    width: 12 },
    { header: 'session_token', key: 'session_token', width: 36 },
    { header: 'full_condition', key: 'full_condition', width: 14 },
    { header: 'style_condition', key: 'style_condition', width: 14 },
    { header: 'metric_condition', key: 'metric_condition', width: 15 },
    ...DEMO_COLS,
    { header: 'post_id', key: 'post_id', width: 10 },
    { header: 'post_order', key: 'post_order', width: 11 },
    { header: 'topic', key: 'topic', width: 12 },
    { header: 'is_true', key: 'is_true', width: 10 },
    { header: 'headline_shown', key: 'headline_shown', width: 40 },
    { header: 'belief_1_7', key: 'belief_1_7', width: 12 },
    { header: 'comment', key: 'comment', width: 40 },
    { header: 'rating_timestamp', key: 'rating_timestamp', width: 20 },
  ];
  styleHeader(s2.getRow(1));

  const ratingRows = db.prepare(`
    SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
      s.age, s.residence, s.education, s.gender,
      p.id as post_id, rt.post_order, p.topic, p.is_true,
      CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
      rt.belief_1_7, rt.comment, rt.timestamp as rating_timestamp
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1
    ORDER BY s.id, rt.post_order
  `).all(studyId);

  ratingRows.forEach(row => s2.addRow({
    ...row,
    ...addDemoCodes(row),
    is_true: row.is_true ? 1 : 0,
    rating_timestamp: toWarsaw(row.rating_timestamp),
  }));

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
      r.action as reaction, r.dwell_ms,
      rt.belief_1_7, rt.comment as participant_comment
    FROM reactions r
    JOIN sessions s ON r.session_id = s.id
    JOIN posts    p ON r.post_id    = p.id
    LEFT JOIN ratings rt ON rt.session_id = r.session_id AND rt.post_id = r.post_id
    WHERE s.study_id = ? AND s.completed = 1

    UNION ALL

    -- Ratings that have no matching reaction (optional-reaction layouts)
    SELECT s.id as session_id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
      s.age, s.residence, s.education, s.gender,
      p.id as post_id, rt.post_order, p.topic, p.is_true,
      CASE WHEN s.style_condition='A' THEN p.headline_a ELSE p.headline_b END as headline_shown,
      CASE WHEN s.style_condition='A' THEN p.content_a  ELSE p.content_b  END as content_shown,
      p.manipulation_techniques,
      NULL, NULL, NULL, NULL,
      NULL, NULL,
      rt.belief_1_7, rt.comment as participant_comment
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts    p ON rt.post_id    = p.id
    WHERE s.study_id = ? AND s.completed = 1
      AND NOT EXISTS (
        SELECT 1 FROM reactions r2
        WHERE r2.session_id = rt.session_id AND r2.post_id = rt.post_id
      )

    ORDER BY session_id, post_order
  `).all(studyId, studyId);

  combinedRows.forEach(row => {
    s3.addRow({
      ...row,
      ...addDemoCodes(row),
      is_true:   row.is_true ? 1 : 0,
      is_misinfo: row.is_true ? 0 : 1,
      manipulation_techniques: (() => { try { return JSON.parse(row.manipulation_techniques || '[]').join('; '); } catch { return ''; } })(),
      liked:    row.reaction === 'like'    ? 1 : 0,
      shared:   row.reaction === 'share'   ? 1 : 0,
      disliked: row.reaction === 'dislike' ? 1 : 0,
      flagged:  row.reaction === 'flag'    ? 1 : 0,
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
    WHERE s.study_id = ? AND s.completed = 1
    ORDER BY s.completed_at DESC
  `).all(studyId);

  sessions.forEach(sess => {
    const agg = db.prepare(`
      SELECT
        SUM(CASE WHEN r.action='like' THEN 1 ELSE 0 END) as n_likes,
        SUM(CASE WHEN r.action='share' THEN 1 ELSE 0 END) as n_shares,
        SUM(CASE WHEN r.action='dislike' THEN 1 ELSE 0 END) as n_dislikes,
        SUM(CASE WHEN r.action='flag' THEN 1 ELSE 0 END) as n_flags,
        SUM(CASE WHEN p.is_true=0 AND r.action IN ('like','share') THEN 1 ELSE 0 END) as n_pos_false,
        SUM(CASE WHEN p.is_true=0 AND r.action IN ('dislike','flag') THEN 1 ELSE 0 END) as n_neg_false,
        SUM(CASE WHEN p.is_true=0 THEN 1 ELSE 0 END) as n_false_total
      FROM reactions r JOIN posts p ON r.post_id = p.id
      WHERE r.session_id = ?
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
      metric_condition: sess.metric_condition,
      age: sess.age, ...addDemoCodes(sess),
      residence: sess.residence,
      education: sess.education,
      gender: sess.gender,
      started_at: toWarsaw(sess.started_at),
      completed_at: toWarsaw(sess.completed_at),
      duration_minutes: sess.duration_minutes,
      n_likes: agg.n_likes, n_shares: agg.n_shares,
      n_dislikes: agg.n_dislikes, n_flags: agg.n_flags,
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

  // ── Sheet 5: 2×2 Design pivot ────────────────────────────────────────────────
  const s5 = wb.addWorksheet('Design_2x2');

  const pivotData = db.prepare(`
    SELECT s.full_condition,
      COUNT(DISTINCT s.id) as n_completed,
      AVG(CASE WHEN p.is_true=0 THEN rt.belief_1_7 END) as mean_belief_false,
      AVG(CASE WHEN p.is_true=1 THEN rt.belief_1_7 END) as mean_belief_true
    FROM sessions s
    LEFT JOIN ratings rt ON rt.session_id = s.id
    LEFT JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1
    GROUP BY s.full_condition
  `).all(studyId);

  const condMap = {};
  pivotData.forEach(r => { condMap[r.full_condition] = r; });

  const fmt  = (v) => v != null ? Math.round(v * 100) / 100 : '-';
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
    const vals = db.prepare(`SELECT DISTINCT ${key} FROM sessions WHERE study_id=? AND completed=1 AND ${key} IS NOT NULL`).all(studyId).map(r => r[key]);
    vals.forEach(val => {
      const counts = ['A-HIGH', 'A-LOW', 'B-HIGH', 'B-LOW'].map(cond =>
        db.prepare(`SELECT COUNT(*) as c FROM sessions WHERE study_id=? AND completed=1 AND full_condition=? AND ${key}=?`).get(studyId, cond, val)?.c || 0
      );
      s5.addRow([label, val, ...counts, counts.reduce((a, b) => a + b, 0)]);
    });
  });

  s5.columns = s5.columns.map(c => ({ ...c, width: Math.max(c.width || 12, 14) }));

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
       WHERE s.study_id = ? AND s.eyetracking_consent = 1 AND g.post_id IS NOT NULL
       GROUP BY s.id, g.post_id
       ORDER BY s.id, g.post_order
    `).all(studyId);

    gazeRows.forEach(row => s6et.addRow({
      ...row,
      ...addDemoCodes(row),
      is_true: row.is_true ? 1 : 0,
    }));
  } catch (_) { /* table may not exist on old deployments — sheet stays empty */ }

  // ── Sheet 7: Codebook ─────────────────────────────────────────────────────────
  const s7 = wb.addWorksheet('Klucz_kodowania');
  s7.columns = [
    { header: 'Zmienna', key: 'variable', width: 28 },
    { header: 'Wartość tekstowa', key: 'label', width: 30 },
    { header: 'Kod numeryczny', key: 'code_val', width: 16 },
  ];
  styleCodebookHeader(s7.getRow(1));

  const codebookEntries = [
    { variable: 'PŁEĆ (gender / gender_kod)', label: '', code_val: '' },
    { variable: '', label: 'kobieta', code_val: 1 },
    { variable: '', label: 'mężczyzna', code_val: 2 },
    { variable: '', label: 'inne', code_val: 3 },
    { variable: '', label: 'wolę nie podawać', code_val: 4 },
    { variable: '', label: '', code_val: '' },
    { variable: 'WIEK (age / age_kod)', label: '', code_val: '' },
    { variable: '', label: '18-25', code_val: 1 },
    { variable: '', label: '26-35', code_val: 2 },
    { variable: '', label: '36-45', code_val: 3 },
    { variable: '', label: '46-60', code_val: 4 },
    { variable: '', label: '60+', code_val: 5 },
    { variable: '', label: '', code_val: '' },
    { variable: 'MIEJSCE ZAMIESZKANIA (residence / residence_kod)', label: '', code_val: '' },
    { variable: '', label: 'duże miasto (100 tys.+)', code_val: 1 },
    { variable: '', label: 'średnie miasto (10–100 tys.)', code_val: 2 },
    { variable: '', label: 'małe miasto (poniżej 10 tys.)', code_val: 3 },
    { variable: '', label: 'wieś', code_val: 4 },
    { variable: '', label: '', code_val: '' },
    { variable: 'WYKSZTAŁCENIE (education / education_kod)', label: '', code_val: '' },
    { variable: '', label: 'podstawowe', code_val: 1 },
    { variable: '', label: 'średnie', code_val: 2 },
    { variable: '', label: 'wyższe licencjat', code_val: 3 },
    { variable: '', label: 'wyższe magister+', code_val: 4 },
    { variable: '', label: '', code_val: '' },
    { variable: 'WARUNEK (full_condition)', label: '', code_val: '' },
    { variable: '', label: 'A-HIGH — styl manipulacyjny, metryki wysokie', code_val: '' },
    { variable: '', label: 'A-LOW  — styl manipulacyjny, metryki niskie', code_val: '' },
    { variable: '', label: 'B-HIGH — styl neutralny, metryki wysokie', code_val: '' },
    { variable: '', label: 'B-LOW  — styl neutralny, metryki niskie', code_val: '' },
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

  return wb;
}

module.exports = { generateExcel };
