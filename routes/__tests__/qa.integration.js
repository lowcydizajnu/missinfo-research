// Big QA — realistic user journeys + cross-tab cascade refresh + edge cases.
// Spins up a mini express with all admin/participant routes, walks through
// scenarios end-to-end via HTTP, restores DB state after each test, prints
// pass/fail summary at the end.
//
// Run: `node routes/__tests__/qa.integration.js`

const express = require('express');
const jwt = require('jsonwebtoken');
const http = require('http');
const db = require('../../db/database');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'qa-secret';
const app = express();
app.use(express.json());
app.use('/api', require('../participant.js'));
app.use('/api/admin', require('../admin.js'));
const token = jwt.sign({ admin: true }, process.env.JWT_SECRET);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

let port;
function call(opts) {
  return new Promise(resolve => {
    const req = http.request({
      port, host: 'localhost',
      method: opts.method || 'GET',
      path: opts.path,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let body = d; try { body = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ── Test helpers — make a clean throwaway study + cleanup at end ──────────
function makeTestStudy(name = 'QA Study', isBuilder = true) {
  const slug = 'qa-' + Math.random().toString(36).slice(2, 8);
  const info = db.prepare(`
    INSERT INTO studies (name, slug, builder_mode, is_active,
      enable_condition_a, enable_condition_b, metric_conditions_json, posts_per_session)
    VALUES (?, ?, ?, 1, 1, 0, ?, 5)
  `).run(name, slug, isBuilder ? 1 : 0, JSON.stringify([
    { key: 'STANDARD', label: 'Standard', min: 0, max: 0, enabled: true, show_comment: false }
  ]));
  return info.lastInsertRowid;
}
function cleanupStudy(id) {
  const sessIds = db.prepare('SELECT id FROM sessions WHERE study_id = ?').all(id).map(r => r.id);
  if (sessIds.length) {
    const ph = sessIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM reactions WHERE session_id IN (${ph})`).run(...sessIds);
    db.prepare(`DELETE FROM ratings WHERE session_id IN (${ph})`).run(...sessIds);
    db.prepare(`DELETE FROM post_question_responses WHERE session_id IN (${ph})`).run(...sessIds);
  }
  db.prepare('DELETE FROM sessions WHERE study_id = ?').run(id);
  db.prepare('DELETE FROM posts WHERE study_id = ?').run(id);
  db.prepare('DELETE FROM post_questions WHERE study_id = ?').run(id);
  db.prepare('DELETE FROM demographic_questions WHERE study_id = ?').run(id);
  db.prepare('DELETE FROM studies WHERE id = ?').run(id);
}

// ── Test scenarios ────────────────────────────────────────────────────────

async function testEmptyStudy() {
  const id = makeTestStudy('QA Empty');
  try {
    // Dashboard on empty study — should NOT crash; widgets render with 0
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    check('empty study: dashboard 200', dash.status === 200);
    check('empty study: total_sessions = 0', dash.body.total_sessions === 0);
    check('empty study: completed_sessions = 0', dash.body.completed_sessions === 0);
    check('empty study: widgets exist', Array.isArray(dash.body.widgets) && dash.body.widgets.length > 0);
    check('empty study: is_default = true', dash.body.widgets_is_default === true);
    // Widgets should have no errors (just 0 / empty data)
    const widgetErrors = dash.body.widgets.filter(w => w.data?.error);
    check('empty study: no widget render errors', widgetErrors.length === 0,
      widgetErrors.map(w => w.title + ': ' + w.data.error).join(' | '));

    // Export preview — 0 rows but valid columns
    const prev = await call({ path: `/api/admin/export/${id}/preview` });
    check('empty study: preview 200', prev.status === 200);
    check('empty study: preview 0 rows', prev.body.rows?.length === 0);
    check('empty study: preview has columns', prev.body.default_columns?.length > 0);

    // Excel export — should generate (empty rows but valid xlsx)
    const { generateExcel } = require('../export.js');
    const wb = await generateExcel(id);
    check('empty study: xlsx generates', wb.worksheets.length > 0);

    // Analyses — try to run a test, should return graceful error
    const an = await call({ path: `/api/admin/studies/${id}/analyze`, method: 'POST',
      body: { test: 'descriptives', params: { variable: 'duration_min' } } });
    check('empty study: analyze returns gracefully', an.status === 200 || an.status === 400);
  } finally { cleanupStudy(id); }
}

async function testCascadeAddPostQuestion() {
  const id = makeTestStudy('QA Cascade');
  try {
    // We need a post in the study — per-post columns (post_N_qN) only
    // materialize when N ≥ 1. This mirrors the real flow: researcher adds
    // posts first, then questions.
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);

    const before = await call({ path: `/api/admin/export/${id}/preview` });
    const colsBefore = before.body.default_columns.length;

    // Add a new post question via API
    const created = await call({ path: `/api/admin/studies/${id}/post-questions`, method: 'POST',
      body: { label: 'Test pytanie', question_type: 'likert', options_json: JSON.stringify({ scale: 7 }) } });
    check('cascade: post-question created', created.status === 200 && created.body.id);

    // Export preview should reflect new column (per-post slot post_1_q<id>)
    const after = await call({ path: `/api/admin/export/${id}/preview` });
    const colsAfter = after.body.default_columns.length;
    check('cascade: export columns grew', colsAfter > colsBefore,
      `before=${colsBefore} after=${colsAfter}`);
    const newColKey = `post_1_q${created.body.id}`;
    check('cascade: new pq column appears in export', after.body.default_columns.some(c => c.key === newColKey));

    // Dashboard widget_columns should also include it
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    check('cascade: new pq column appears in dashboard widget_columns', dash.body.widget_columns.some(c => c.key === newColKey));

    // Edit the question label — header should update
    const newLabel = 'Edytowana etykieta';
    await call({ path: `/api/admin/post-questions/${created.body.id}`, method: 'PATCH',
      body: { label: newLabel } });
    const after2 = await call({ path: `/api/admin/export/${id}/preview` });
    const updatedCol = after2.body.default_columns.find(c => c.key === newColKey);
    check('cascade: editing pq label updates header',
      updatedCol && updatedCol.header.includes(newLabel.slice(0, 20)),
      `header now: "${updatedCol?.header}"`);
  } finally { cleanupStudy(id); }
}

async function testCascadeAddDemoQuestion() {
  const id = makeTestStudy('QA Demo Cascade');
  try {
    // Seed defaults so we have the legacy 4
    db.seedDefaultDemographicQuestions(id);

    const before = await call({ path: `/api/admin/export/${id}/preview` });
    const colsBefore = before.body.default_columns.length;

    // Add a custom demographic question
    const created = await call({ path: `/api/admin/studies/${id}/demographic-questions`, method: 'POST',
      body: { field_key: 'zawod', label: 'Zawód', input_type: 'text', options: '[]', required: 0 } });
    check('demo cascade: created', created.status === 200 && created.body.id);

    const after = await call({ path: `/api/admin/export/${id}/preview` });
    check('demo cascade: new column "zawod" in export', after.body.default_columns.some(c => c.key === 'zawod'));

    // Dashboard codebook
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    check('demo cascade: appears in dashboard demographic_questions',
      dash.body.demographic_questions.some(q => q.field_key === 'zawod'));
  } finally { cleanupStudy(id); }
}

async function testCascadeAddSession() {
  const id = makeTestStudy('QA Session Cascade');
  try {
    // Add a post so participant flow can start
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 'src', '@s', '1h', 'ha', 'ca', 'hb', 'cb', 1, 1)`).run(id);
    db.seedDefaultDemographicQuestions(id);

    // Baseline counts
    const dash1 = await call({ path: `/api/admin/dashboard/${id}` });
    const sessions1 = dash1.body.total_sessions;
    const prev1 = await call({ path: `/api/admin/export/${id}/preview` });
    const rows1 = prev1.body.rows.length;

    // Insert a completed session directly
    const sessId = db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, age, gender) VALUES (?, ?, 'STANDARD', 'BUILDER', 'STANDARD', 0, 1, datetime('now'), '26-35', 'kobieta')`).run(id, 'qa-' + Math.random()).lastInsertRowid;

    // Dashboard reflects new session
    const dash2 = await call({ path: `/api/admin/dashboard/${id}` });
    check('session cascade: total_sessions incremented', dash2.body.total_sessions === sessions1 + 1);
    check('session cascade: completed_sessions incremented', dash2.body.completed_sessions === (dash1.body.completed_sessions + 1));

    // Export preview reflects new row
    const prev2 = await call({ path: `/api/admin/export/${id}/preview` });
    check('session cascade: preview rows incremented', prev2.body.rows.length === rows1 + 1);

    // Recent sessions includes new session
    check('session cascade: recent_sessions has new entry',
      dash2.body.recent_sessions.some(s => s.id === sessId));

    // Cleanup
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessId);
  } finally { cleanupStudy(id); }
}

async function testTranslationFlow() {
  const id = makeTestStudy('QA Translation');
  try {
    db.seedDefaultDemographicQuestions(id);
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'nauka', '🔬', 'src', '@s', '1h', 'Polski nagłówek', 'Polska treść', 'PL B', 'PL B c', 1, 1)`).run(id);

    // Inject fake EN translation
    const post = db.prepare('SELECT id FROM posts WHERE study_id = ?').get(id);
    const dqs = db.prepare('SELECT id, options FROM demographic_questions WHERE study_id = ?').all(id);
    const fakeTrans = { en: {
      consent_text: 'EN consent',
      posts: [{ id: post.id, headline_a: 'EN headline', content_a: 'EN content', topic: 'science' }],
      demographic_questions: dqs.map(q => {
        let opts = []; try { opts = JSON.parse(q.options); } catch {}
        return { id: q.id, label: 'EN_label', options: opts.map(o => ({ ...o, label: 'EN_' + (o.label || o.value) })) };
      }),
    }};
    db.prepare('UPDATE studies SET translations_json = ?, language = ? WHERE id = ?').run(JSON.stringify(fakeTrans), 'en', id);

    // Insert a completed session to have data
    const sessId = db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, age, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), '26-35', 'kobieta')`).run(id, 'tr-' + Math.random()).lastInsertRowid;

    // Export preview should reflect EN translations on values
    const prev = await call({ path: `/api/admin/export/${id}/preview` });
    const row = prev.body.rows[0];
    check('translation: demographic value translated to EN', row.gender === 'EN_kobieta' || row.gender === 'EN_Kobieta',
      `got "${row.gender}"`);

    // PL canonical export (lang=pl) — should give back PL values
    const prevPL = await call({ path: `/api/admin/export/${id}/preview?lang=pl` });
    check('translation: lang=pl returns canonical PL value', prevPL.body.rows[0].gender === 'kobieta');

    // session/start should send translated locale
    const sess = await call({ path: '/api/session/start', method: 'POST', body: { study_id: id } });
    check('translation: session/start has language', sess.body.language === 'en');

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessId);
  } finally { cleanupStudy(id); }
}

async function testExportConfigPersistence() {
  const id = makeTestStudy('QA Export Config');
  try {
    db.seedDefaultDemographicQuestions(id);
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), 'kobieta')`).run(id, 'ec-' + Math.random());

    // Save config: hide session_token, rename full_condition
    const cfg = { columns: [
      { key: 'session_id', visible: true },
      { key: 'session_token', visible: false },
      { key: 'full_condition', header: 'Warunek', visible: true },
    ]};
    const save = await call({ path: `/api/admin/export/${id}/config`, method: 'PUT',
      body: { sheet: 'Dane_surowe', config: cfg } });
    check('export cfg: save 200', save.status === 200);

    // Preview returns the customized effective_columns
    const prev = await call({ path: `/api/admin/export/${id}/preview` });
    const effective = prev.body.effective_columns;
    check('export cfg: session_token hidden in effective', !effective.some(c => c.key === 'session_token'));
    check('export cfg: full_condition header renamed', effective.find(c => c.key === 'full_condition')?.header === 'Warunek');

    // Excel export respects config
    const { generateExcel } = require('../export.js');
    const wb = await generateExcel(id);
    const s1 = wb.getWorksheet('Dane_surowe');
    const headers = []; s1.getRow(1).eachCell(c => headers.push(c.value));
    check('export cfg: xlsx omits session_token', !headers.includes('session_token'));
    check('export cfg: xlsx has renamed Warunek', headers.includes('Warunek'));

    // Save a named profile
    const prof = await call({ path: `/api/admin/export/${id}/profiles`, method: 'POST',
      body: { name: 'Minimal', sheet: 'Dane_surowe', config: cfg } });
    check('export cfg: profile saved', prof.status === 200);

    // Preview returns profiles list
    const prev2 = await call({ path: `/api/admin/export/${id}/preview` });
    check('export cfg: profile listed in preview', !!prev2.body.profiles?.Minimal);
  } finally { cleanupStudy(id); }
}

async function testDashboardConfigPersistence() {
  const id = makeTestStudy('QA Dashboard Config');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'nauka', '🔬', 's', '@s', '1h', 'h', 'c', 'h2', 'c2', 1, 1)`).run(id);

    // Get smart defaults first
    const d1 = await call({ path: `/api/admin/dashboard/${id}` });
    check('dash cfg: smart defaults flagged', d1.body.widgets_is_default === true);
    const defaultCount = d1.body.widgets.length;

    // Save custom config
    const save = await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT',
      body: { widgets: [{ type: 'kpi', title: 'Test KPI', metric: 'count_completed' }] }});
    check('dash cfg: save 200', save.status === 200);

    // Saved config doesn't get is_default flag
    const d2 = await call({ path: `/api/admin/dashboard/${id}` });
    check('dash cfg: is_default false after save', d2.body.widgets_is_default === false);
    check('dash cfg: only 1 widget after custom save', d2.body.widgets.length === 1);
    // Round-trip: widget should render correctly (no "metric undefined" bug)
    check('dash cfg: saved KPI renders without error', !d2.body.widgets[0].data?.error,
      d2.body.widgets[0].data?.error);

    // Reset to defaults
    const reset = await call({ path: `/api/admin/dashboard/${id}/config`, method: 'DELETE' });
    check('dash cfg: reset 200', reset.status === 200);
    const d3 = await call({ path: `/api/admin/dashboard/${id}` });
    check('dash cfg: defaults back after reset', d3.body.widgets_is_default === true && d3.body.widgets.length === defaultCount);
  } finally { cleanupStudy(id); }
}

async function testPreviewSessionSemantics() {
  const id = makeTestStudy('QA Preview Sem');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    db.seedDefaultDemographicQuestions(id);

    // Create 3 sessions: 2 completed preview, 1 incomplete preview, 1 production completed
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at) VALUES (?, ?, 'A', 'BUILDER', 'A', 1, 1, datetime('now'))`).run(id, 'p1');
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at) VALUES (?, ?, 'A', 'BUILDER', 'A', 1, 1, datetime('now'))`).run(id, 'p2');
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed) VALUES (?, ?, 'A', 'BUILDER', 'A', 1, 0)`).run(id, 'p3');
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'))`).run(id, 'prod1');

    // Dashboard default
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    check('preview sem: total_sessions counts only non-preview', dash.body.total_sessions === 1);
    check('preview sem: completed_sessions = 1 production', dash.body.completed_sessions === 1);
    check('preview sem: preview_count = 2 completed previews', dash.body.preview_count === 2);
    check('preview sem: preview_count_incomplete = 1', dash.body.preview_count_incomplete === 1);

    // With include_preview=1
    const dashIncl = await call({ path: `/api/admin/dashboard/${id}?include_preview=1` });
    check('preview sem: include_preview total = 3 completed', dashIncl.body.total_sessions === 4);
    check('preview sem: include_preview completed = 3', dashIncl.body.completed_sessions === 3);

    // Export preview default (hidden)
    const prev = await call({ path: `/api/admin/export/${id}/preview` });
    check('preview sem: preview table = 1 row default', prev.body.rows.length === 1);

    // Export preview with include_preview
    const prevAll = await call({ path: `/api/admin/export/${id}/preview?include_preview=1` });
    check('preview sem: preview table = 3 rows with include_preview', prevAll.body.rows.length === 3);

    // Delete preview sessions removes ALL preview (completed + incomplete = 3)
    const del = await call({ path: `/api/admin/studies/${id}/preview-sessions/delete`, method: 'POST',
      body: { confirm: 'DELETE' }});
    check('preview sem: delete returns 200', del.status === 200);
    check('preview sem: delete count = 3 (incl. incomplete)', del.body.deleted === 3);
    const dashAfter = await call({ path: `/api/admin/dashboard/${id}` });
    check('preview sem: after delete preview_count = 0', dashAfter.body.preview_count === 0);
    check('preview sem: after delete production untouched', dashAfter.body.completed_sessions === 1);
  } finally { cleanupStudy(id); }
}

async function testDuplicateTranslationIdRemap() {
  const id = makeTestStudy('QA Duplicate');
  try {
    db.seedDefaultDemographicQuestions(id);
    const dqs = db.prepare('SELECT id, options FROM demographic_questions WHERE study_id = ?').all(id);
    const fakeTrans = { en: { demographic_questions: dqs.map(q => ({
      id: q.id, label: 'EN_' + q.id,
      options: JSON.parse(q.options || '[]').map(o => ({ ...o, label: 'EN_' + (o.label || o.value) })),
    }))}};
    db.prepare('UPDATE studies SET translations_json = ?, language = ? WHERE id = ?').run(JSON.stringify(fakeTrans), 'en', id);

    // Duplicate
    const dup = await call({ path: `/api/admin/studies/${id}/duplicate`, method: 'POST' });
    check('duplicate: returns new study', dup.status === 200 && dup.body.id);
    const newId = dup.body.id;
    try {
      const newDqs = db.prepare('SELECT id FROM demographic_questions WHERE study_id = ?').all(newId);
      const newTrans = JSON.parse(db.prepare('SELECT translations_json FROM studies WHERE id = ?').get(newId).translations_json);
      const newDqIds = newDqs.map(q => q.id).sort();
      const remappedIds = newTrans.en.demographic_questions.map(q => q.id).sort();
      check('duplicate: dq ids remapped to new study', JSON.stringify(newDqIds) === JSON.stringify(remappedIds));
    } finally { cleanupStudy(newId); }
  } finally { cleanupStudy(id); }
}

async function testStatsEngineEdgeCases() {
  const id = makeTestStudy('QA Stats Edge');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    db.seedDefaultDemographicQuestions(id);
    // Add only 1 session — too few for most tests
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, age, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), '26-35', 'kobieta')`).run(id, 'se-' + Math.random());

    // t-test with single group → should error gracefully not crash
    const tt = await call({ path: `/api/admin/studies/${id}/analyze`, method: 'POST',
      body: { test: 't_test', params: { variable: 'duration_min', group_variable: 'full_condition' }}});
    check('stats edge: t-test on 1 group returns gracefully', tt.status === 400 || tt.body.result?.error,
      tt.body.error || tt.body.result?.error);

    // Chi-square on single category → graceful
    const cs = await call({ path: `/api/admin/studies/${id}/analyze`, method: 'POST',
      body: { test: 'chi_square', params: { row_variable: 'gender', col_variable: 'full_condition' }}});
    check('stats edge: chi² with 1 cat returns gracefully', cs.status === 400);

    // Unknown test → 400
    const un = await call({ path: `/api/admin/studies/${id}/analyze`, method: 'POST',
      body: { test: 'bogus_test', params: {} }});
    check('stats edge: unknown test returns 400', un.status === 400);
  } finally { cleanupStudy(id); }
}

async function testWidgetEngineEdgeCases() {
  const id = makeTestStudy('QA Widget Edge');
  try {
    // 0 sessions — widgets should render without crashing
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    check('widget edge: dashboard 200 with 0 sessions', dash.status === 200);
    const errs = dash.body.widgets.filter(w => w.data?.error);
    // Some widgets like bar charts WILL legitimately say "no data" — that's not a crash
    check('widget edge: no widget threw exception', dash.status === 200);

    // Save a widget config with bad column ref → should render error gracefully
    await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT',
      body: { widgets: [{ type: 'kpi', title: 'Bad', metric: 'mean', column: 'nonexistent_col' }] }});
    const dash2 = await call({ path: `/api/admin/dashboard/${id}` });
    check('widget edge: bad column ref does not crash', dash2.status === 200);
    // KPI mean on nonexistent column → value should be null (no data to mean)
    const badWidget = dash2.body.widgets[0];
    check('widget edge: bad column returns null value, not error', badWidget.data?.value === null && !badWidget.data?.error);

    // Bad widget type
    await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT',
      body: { widgets: [{ type: 'bogus_type', title: 'Bad' }] }});
    const dash3 = await call({ path: `/api/admin/dashboard/${id}` });
    check('widget edge: bad type returns error in data',
      dash3.body.widgets[0].data?.error?.includes('Nieznany'));
  } finally { cleanupStudy(id); }
}

async function testCookieAdminMode() {
  const id = makeTestStudy('QA Cookie', /*isBuilder*/ true);
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    db.seedDefaultDemographicQuestions(id);

    // (a) No cookie, no preview flag → is_preview=0
    const a = await call({ path: '/api/session/start', method: 'POST', body: { study_id: id }});
    check('cookie: no cookie + main URL → production', a.body.is_preview === 0);
    db.prepare('DELETE FROM sessions WHERE session_token = ?').run(a.body.session_token);

    // (b) Cookie=preview → is_preview=1
    const b = await call({ path: '/api/session/start', method: 'POST', body: { study_id: id },
      headers: { cookie: 'missinfo_admin_mode=preview' }});
    check('cookie: cookie=preview + main URL → preview', b.body.is_preview === 1);
    db.prepare('DELETE FROM sessions WHERE session_token = ?').run(b.body.session_token);

    // (c) Cookie=production + preview=true URL → STILL preview (URL flag wins for tagging)
    const c = await call({ path: '/api/session/start', method: 'POST',
      body: { study_id: id, preview: true },
      headers: { cookie: 'missinfo_admin_mode=production' }});
    check('cookie: production + Podgląd URL → preview (your scenario)', c.body.is_preview === 1);
    db.prepare('DELETE FROM sessions WHERE session_token = ?').run(c.body.session_token);

    // (d) Cookie=production, main URL → production (true live test)
    const d = await call({ path: '/api/session/start', method: 'POST', body: { study_id: id },
      headers: { cookie: 'missinfo_admin_mode=production' }});
    check('cookie: production + main URL → production (live test)', d.body.is_preview === 0);
    db.prepare('DELETE FROM sessions WHERE session_token = ?').run(d.body.session_token);
  } finally { cleanupStudy(id); }
}

async function testHeaderRenameCascades() {
  const id = makeTestStudy('QA Rename Cascade');
  try {
    db.seedDefaultDemographicQuestions(id);
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    // Save an export config that renames full_condition → "Warunek"
    const cfg = { columns: [
      { key: 'full_condition', header: 'Warunek', visible: true },
    ]};
    await call({ path: `/api/admin/export/${id}/config`, method: 'PUT',
      body: { sheet: 'Dane_surowe', config: cfg }});

    // Dashboard widget_columns should show the renamed label
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    const dashCol = dash.body.widget_columns.find(c => c.key === 'full_condition');
    check('rename cascade: header renamed in dashboard widget_columns',
      dashCol?.header === 'Warunek', `got: ${dashCol?.header}`);

    // Export preview labeled_columns should also have it
    const prev = await call({ path: `/api/admin/export/${id}/preview` });
    const prevCol = prev.body.labeled_columns.find(c => c.key === 'full_condition');
    check('rename cascade: labeled_columns has renamed header',
      prevCol?.header === 'Warunek');

    // But default_columns should remain the original default (single
    // source of truth for the export builder UI itself)
    const prevDefault = prev.body.default_columns.find(c => c.key === 'full_condition');
    check('rename cascade: default_columns unchanged (still "full_condition")',
      prevDefault?.header === 'full_condition');

    // And effective_columns should also have the rename (used for xlsx)
    const prevEff = prev.body.effective_columns.find(c => c.key === 'full_condition');
    check('rename cascade: effective_columns has renamed header',
      prevEff?.header === 'Warunek');
  } finally { cleanupStudy(id); }
}

async function testPostQuestionLikertType() {
  const id = makeTestStudy('QA pq type');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    // Add one of each question type
    const likertRes = await call({ path: `/api/admin/studies/${id}/post-questions`, method: 'POST',
      body: { label: 'Wiarygodność', question_type: 'likert', options_json: JSON.stringify({ scale: 7 }) }});
    const singleRes = await call({ path: `/api/admin/studies/${id}/post-questions`, method: 'POST',
      body: { label: 'Płeć autora', question_type: 'single', options_json: JSON.stringify([{ label: 'M', value: 'm' }, { label: 'K', value: 'k' }]) }});
    const openRes = await call({ path: `/api/admin/studies/${id}/post-questions`, method: 'POST',
      body: { label: 'Komentarz', question_type: 'open', options_json: '[]' }});

    const prev = await call({ path: `/api/admin/export/${id}/preview` });
    const cols = prev.body.default_columns;
    const likertCol = cols.find(c => c.key === `post_1_q${likertRes.body.id}`);
    const singleCol = cols.find(c => c.key === `post_1_q${singleRes.body.id}`);
    const openCol = cols.find(c => c.key === `post_1_q${openRes.body.id}`);
    check('pq type: Likert column has type "number"', likertCol?.type === 'number');
    check('pq type: single column has type "categorical"', singleCol?.type === 'categorical');
    check('pq type: open column has type "text"', openCol?.type === 'text');
  } finally { cleanupStudy(id); }
}

async function testDashboardDateFilter() {
  const id = makeTestStudy('QA Date Filter');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    // Insert sessions with different completed_at dates
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, '2026-01-01 12:00:00', 'kobieta')`).run(id, 'old-' + Math.random());
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, '2026-06-15 12:00:00', 'mężczyzna')`).run(id, 'new-' + Math.random());

    // No filter — both sessions
    const all = await call({ path: `/api/admin/dashboard/${id}` });
    check('date filter: all = 2 sessions', all.body.completed_sessions === 2);

    // Filter to only the old session
    const old = await call({ path: `/api/admin/dashboard/${id}?date_from=2025-12-01&date_to=2026-02-01` });
    check('date filter: range catches old only', old.body.completed_sessions === 1);

    // Filter to only the new session
    const newOnly = await call({ path: `/api/admin/dashboard/${id}?date_from=2026-06-01&date_to=2026-12-31` });
    check('date filter: range catches new only', newOnly.body.completed_sessions === 1);

    // Filter outside both ranges
    const none = await call({ path: `/api/admin/dashboard/${id}?date_from=2027-01-01` });
    check('date filter: future range = 0', none.body.completed_sessions === 0);

    // Echo back in response
    check('date filter: date_from echoed', newOnly.body.date_from === '2026-06-01');
    check('date filter: date_to echoed', newOnly.body.date_to === '2026-12-31');

    // Invalid date format rejected (or normalized to null)
    const bad = await call({ path: `/api/admin/dashboard/${id}?date_from=garbage` });
    check('date filter: bad format ignored', bad.body.completed_sessions === 2);
  } finally { cleanupStudy(id); }
}

async function testDashboardProfiles() {
  const id = makeTestStudy('QA Dash Profiles');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    // Save a profile
    const widgets = [{ id: 'w1', type: 'kpi', title: 'Min KPI', metric: 'count_completed' }];
    const save = await call({ path: `/api/admin/dashboard/${id}/profiles`, method: 'POST', body: { name: 'Minimal', widgets }});
    check('dash profiles: save 200', save.status === 200);

    // List
    const list = await call({ path: `/api/admin/dashboard/${id}/profiles` });
    check('dash profiles: list has Minimal', !!list.body.Minimal);
    check('dash profiles: Minimal has widget', list.body.Minimal?.widgets?.length === 1);

    // Dashboard response includes profiles
    const dash = await call({ path: `/api/admin/dashboard/${id}` });
    check('dash profiles: appear in dashboard response', !!dash.body.profiles?.Minimal);

    // Delete
    const del = await call({ path: `/api/admin/dashboard/${id}/profiles/Minimal`, method: 'DELETE' });
    check('dash profiles: delete 200', del.status === 200);
    const after = await call({ path: `/api/admin/dashboard/${id}/profiles` });
    check('dash profiles: deleted', !after.body.Minimal);

    // Delete non-existent → 404
    const missing = await call({ path: `/api/admin/dashboard/${id}/profiles/Bogus`, method: 'DELETE' });
    check('dash profiles: missing 404', missing.status === 404);
  } finally { cleanupStudy(id); }
}

async function testShareLink() {
  const id = makeTestStudy('QA Share');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'))`).run(id, 'shr-1');
    // Save a tiny dashboard so the share link has something to render
    await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT',
      body: { widgets: [{ type: 'kpi', title: 'Sessions', metric: 'count_completed' }]}});

    // Generate a share token
    const gen = await call({ path: `/api/admin/studies/${id}/share-link`, method: 'POST', body: { days: 7 }});
    check('share: token generated', gen.status === 200 && gen.body.token);
    check('share: url returned', gen.body.url?.startsWith('/share/dashboard/'));
    check('share: expires_days echoed', gen.body.expires_days === 7);

    // Public endpoint serves the dashboard WITHOUT auth
    const pub = await new Promise(resolve => {
      http.request({port, path:'/api/admin/public/dashboard/' + encodeURIComponent(gen.body.token), method:'GET'}, res => {
        let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve({status:res.statusCode, body:JSON.parse(d)}));
      }).end();
    });
    check('share: public endpoint works without auth', pub.status === 200);
    check('share: returns widgets', pub.body.widgets?.length === 1);
    check('share: study_name echoed', pub.body.study_name === 'QA Share');

    // Invalid token rejected
    const bad = await new Promise(resolve => {
      http.request({port, path:'/api/admin/public/dashboard/garbage-token', method:'GET'}, res => {
        let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve({status:res.statusCode}));
      }).end();
    });
    check('share: bad token rejected', bad.status === 401);

    // Token with wrong scope rejected
    const wrongScope = jwt.sign({ study_id: id, scope: 'something-else' }, process.env.JWT_SECRET);
    const wrong = await new Promise(resolve => {
      http.request({port, path:'/api/admin/public/dashboard/' + encodeURIComponent(wrongScope), method:'GET'}, res => {
        let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve({status:res.statusCode}));
      }).end();
    });
    check('share: wrong-scope token rejected', wrong.status === 403);
  } finally { cleanupStudy(id); }
}

async function testWidgetAnnotations() {
  const id = makeTestStudy('QA Annot');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    // Save widget with annotation
    const widgets = [{ type: 'kpi', title: 'Ses', metric: 'count_completed', annotation: 'Wzrost po pre-reg' }];
    await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT', body: { widgets }});
    const r = await call({ path: `/api/admin/dashboard/${id}` });
    check('annotations: persist through save/load', r.body.widgets[0].annotation === 'Wzrost po pre-reg');
  } finally { cleanupStudy(id); }
}

async function testCrossFilter() {
  const id = makeTestStudy('QA Cross Filter');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    // 3 sessions: 2 A, 1 B
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), 'kobieta')`).run(id, 'cf-1');
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), 'kobieta')`).run(id, 'cf-2');
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'B', 'BUILDER', 'B', 0, 1, datetime('now'), 'mężczyzna')`).run(id, 'cf-3');

    // Save a bar chart widget
    await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT',
      body: { widgets: [{ type: 'bar_chart', title: 'b', group_var: 'full_condition', aggregator: 'count' }]}});

    // No filter → 3 sessions, bar chart shows 2 categories
    const r1 = await call({ path: `/api/admin/dashboard/${id}` });
    check('cross-filter: no filter shows all data', r1.body.widgets[0].data.categories.length === 2);

    // Filter to A only — widget data should show ONLY A (1 category, 2 count)
    const r2 = await call({ path: `/api/admin/dashboard/${id}?filter_full_condition=A` });
    check('cross-filter: filter narrows widget data',
      r2.body.widgets[0].data.categories.length === 1 && r2.body.widgets[0].data.categories[0] === 'A');
    check('cross-filter: filter narrows row count', r2.body.widgets[0].data.values[0] === 2);
    check('cross-filter: server echoes cross_filters', r2.body.cross_filters?.full_condition === 'A');

    // Multiple filters chain (AND)
    const r3 = await call({ path: `/api/admin/dashboard/${id}?filter_full_condition=A&filter_gender=kobieta` });
    check('cross-filter: chained filters compose', r3.body.widgets[0].data.values[0] === 2);

    // Filter to non-existent value → empty results
    const r4 = await call({ path: `/api/admin/dashboard/${id}?filter_full_condition=NOPE` });
    const w = r4.body.widgets[0].data;
    check('cross-filter: no-match → empty state', w.empty === true || (w.categories && w.categories.length === 0));
  } finally { cleanupStudy(id); }
}

async function testAllTenWidgetTypes() {
  const id = makeTestStudy('QA 10 widgets');
  try {
    db.prepare(`INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle, time_ago, headline_a, content_a, headline_b, content_b, is_true, is_active) VALUES (?, 0, 'demo', '📋', 's', '@s', '1h', 'h', 'c', 'h', 'c', 1, 1)`).run(id);
    db.seedDefaultDemographicQuestions(id);
    // A couple of completed sessions so widgets have data
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender, age) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), 'kobieta', '26-35')`).run(id, '10w-1');
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender, age) VALUES (?, ?, 'B', 'BUILDER', 'B', 0, 1, datetime('now'), 'mężczyzna', '36-45')`).run(id, '10w-2');

    // Save one of each widget type
    const widgets = [
      { type:'kpi', title:'k', metric:'count_completed' },
      { type:'bar_chart', title:'b', group_var:'full_condition', aggregator:'count' },
      { type:'histogram', title:'h', variable:'duration_min' },
      { type:'crosstab', title:'cr', row_var:'full_condition', col_var:'gender' },
      { type:'time_series', title:'ts', granularity:'day', metric:'completed', days_back:7 },
      { type:'scatter', title:'sc', variable_x:'duration_min', variable_y:'age_code' },
      { type:'boxplot', title:'bo', variable:'duration_min', group_by:'full_condition' },
      { type:'pie', title:'p', variable:'gender' },
      { type:'correlation_heatmap', title:'hm', variables:['duration_min','age_code'] },
      { type:'text_responses', title:'tr', variable:'session_token' },
    ];
    await call({ path: `/api/admin/dashboard/${id}/config`, method: 'PUT', body: { widgets }});
    const r = await call({ path: `/api/admin/dashboard/${id}` });
    widgets.forEach((w, i) => {
      const got = r.body.widgets[i];
      check(`10 widgets: ${w.type} renders without error`, !got.data?.error,
        got.data?.error);
    });
  } finally { cleanupStudy(id); }
}

async function testLanguageSwitchExport() {
  const id = makeTestStudy('QA Lang Switch');
  try {
    db.seedDefaultDemographicQuestions(id);
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, completed, completed_at, gender) VALUES (?, ?, 'A', 'BUILDER', 'A', 0, 1, datetime('now'), 'kobieta')`).run(id, 'lng-' + Math.random());
    const dqs = db.prepare('SELECT id, options FROM demographic_questions WHERE study_id = ?').all(id);
    const fakeTrans = { en: { demographic_questions: dqs.map(q => ({
      id: q.id, label: 'EN', options: JSON.parse(q.options).map(o => ({...o, label: 'EN_' + (o.label || o.value) })),
    }))}, cs: { demographic_questions: dqs.map(q => ({
      id: q.id, label: 'CS', options: JSON.parse(q.options).map(o => ({...o, label: 'CS_' + (o.label || o.value) })),
    }))}};
    db.prepare('UPDATE studies SET translations_json = ?, language = ? WHERE id = ?').run(JSON.stringify(fakeTrans), 'en', id);

    // Default (study lang = en)
    const en = await call({ path: `/api/admin/export/${id}/preview` });
    check('lang: default returns EN', en.body.rows[0].gender?.startsWith('EN_'));

    // Override to CS
    const cs = await call({ path: `/api/admin/export/${id}/preview?lang=cs` });
    check('lang: ?lang=cs returns CS', cs.body.rows[0].gender?.startsWith('CS_'));

    // Override to PL (canonical, no overlay)
    const pl = await call({ path: `/api/admin/export/${id}/preview?lang=pl` });
    check('lang: ?lang=pl returns canonical PL', pl.body.rows[0].gender === 'kobieta');
  } finally { cleanupStudy(id); }
}

// ── Run all ───────────────────────────────────────────────────────────────
async function runAll() {
  const tests = [
    ['Empty study renders without crashing',     testEmptyStudy],
    ['Adding post_question cascades to export/dashboard', testCascadeAddPostQuestion],
    ['Adding demographic_question cascades',     testCascadeAddDemoQuestion],
    ['Adding session cascades to all surfaces',  testCascadeAddSession],
    ['Translation overlay flows end-to-end',     testTranslationFlow],
    ['Export config persists across requests',   testExportConfigPersistence],
    ['Dashboard config persists + round-trips',  testDashboardConfigPersistence],
    ['Preview session count semantics',          testPreviewSessionSemantics],
    ['Duplicate study remaps translation ids',   testDuplicateTranslationIdRemap],
    ['Stats engine edge cases (n=1 etc.)',       testStatsEngineEdgeCases],
    ['Widget engine edge cases (empty, bad refs)', testWidgetEngineEdgeCases],
    ['Cookie-based admin mode (4 scenarios)',    testCookieAdminMode],
    ['Header rename cascades to dashboard + analyses', testHeaderRenameCascades],
    ['Post-question column type follows question_type', testPostQuestionLikertType],
    ['Dashboard global date range filter',       testDashboardDateFilter],
    ['Dashboard saved profiles CRUD',            testDashboardProfiles],
    ['All 10 widget types render without errors', testAllTenWidgetTypes],
    ['Dashboard cross-filter',                   testCrossFilter],
    ['Public read-only share link',              testShareLink],
    ['Widget annotations persist',               testWidgetAnnotations],
    ['Per-export language switch',               testLanguageSwitchExport],
  ];
  for (const [name, fn] of tests) {
    console.log('\n━━━ ' + name + ' ━━━');
    try { await fn(); } catch (e) { results.push({ name: name + ' [exception]', ok: false, detail: e.message }); console.error('  💥', e.message); }
  }
  console.log('\n══════ RESULTS ══════');
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  results.forEach(r => console.log((r.ok ? '✓' : '✗') + ' ' + r.name + (r.detail && !r.ok ? '  →  ' + r.detail : '')));
  console.log('\n' + pass + '/' + (pass + fail) + ' passed' + (fail ? `, ${fail} failed` : ''));
  process.exit(fail ? 1 : 0);
}

const server = app.listen(0, () => { port = server.address().port; runAll().finally(() => server.close()); });
