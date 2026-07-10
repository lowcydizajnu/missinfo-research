const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { generateExcel, buildExportContext, getDaneSuroweData, applyExportConfig, applyHeaderOverrides, rowsToCsv } = require('./export');
const stats = require('./stats');
const { renderWidget, generateDefaultDashboard } = require('./widgets');
const Anthropic = require('@anthropic-ai/sdk');

// No hardcoded fallback — a predictable secret means forgeable tokens (total
// auth bypass). Fail fast instead of starting insecure.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start with a forgeable token secret.');
  process.exit(1);
}
const uploadsDir = path.resolve(process.env.UPLOADS_PATH || './uploads');

const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
// A valid bcrypt hash compared against when the username is unknown, so a failed
// login costs the same time whether or not the user exists (no enumeration).
const DUMMY_HASH = bcrypt.hashSync('timing-guard-not-a-real-password', 12);

// ── Auth middleware ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    // Read-only dashboard share tokens ({study_id, scope}) must never reach the
    // admin API — they're only for GET /public/dashboard/:token.
    if (decoded.scope) return res.status(401).json({ error: 'Invalid token' });
    req.user = decoded;    // { userId, role }
    req.admin = decoded;   // backwards-compat alias for any code still reading req.admin
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin-only guard (user management). Use after `auth`.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Wymagane konto administratora.' });
  next();
}

// ── Study ownership guards ─────────────────────────────────────────────────────
// Each returns the study row, or sends a 404 and returns null (so the caller does
// `if (!ownedStudy(...)) return;`). Cross-tenant access returns 404 rather than
// 403 so study/child ids can't be enumerated. Admins see and manage everything;
// researchers are limited to studies whose owner_id matches their user id.
function ownedStudy(req, res, studyId) {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) { res.status(404).json({ error: 'Not found' }); return null; }
  if (req.user.role !== 'admin' && study.owner_id !== req.user.userId) {
    res.status(404).json({ error: 'Not found' }); return null;
  }
  return study;
}
function ownedByChild(req, res, table, childId) {
  const row = db.prepare(`SELECT study_id FROM ${table} WHERE id = ?`).get(childId);
  if (!row) { res.status(404).json({ error: 'Not found' }); return null; }
  return ownedStudy(req, res, row.study_id);
}
function ownedBySession(req, res, sessionId) {
  const row = db.prepare('SELECT study_id FROM sessions WHERE id = ?').get(sessionId);
  if (!row) { res.status(404).json({ error: 'Not found' }); return null; }
  return ownedStudy(req, res, row.study_id);
}

// ── Login (username + password, bcrypt) ─────────────────────────────────────────
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = username ? db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(String(username)) : null;
  const ok = bcrypt.compareSync(String(password || ''), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });
  db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(user.id);
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, role: user.role, username: user.username });
});

// ── User management (admin-only; invite-only — no public self-registration) ─────
router.get('/users', auth, requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.is_active, u.created_at, u.last_login,
           (SELECT COUNT(*) FROM studies s WHERE s.owner_id = u.id) AS study_count
    FROM users u ORDER BY u.id`).all());
});

router.post('/users', auth, requireAdmin, (req, res) => {
  const { username, email, password, role } = req.body || {};
  const uname = String(username || '').trim();
  if (!uname) return res.status(400).json({ error: 'Login jest wymagany.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 8 znaków.' });
  const r = (role === 'admin') ? 'admin' : 'researcher';
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) return res.status(409).json({ error: 'Taki login już istnieje.' });
  const info = db.prepare(
    `INSERT INTO users (username, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)`
  ).run(uname, email ? String(email).trim() : null, bcrypt.hashSync(String(password), 12), r);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/users/:id', auth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  const updates = {};
  if (req.body.email !== undefined) updates.email = req.body.email ? String(req.body.email).trim() : null;
  if (req.body.role !== undefined) updates.role = (req.body.role === 'admin') ? 'admin' : 'researcher';
  if (req.body.is_active !== undefined) updates.is_active = req.body.is_active ? 1 : 0;
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 8 znaków.' });
    updates.password_hash = bcrypt.hashSync(String(req.body.password), 12);
  }
  // Never let the last active admin lose admin or be deactivated (lockout guard).
  const demotes = (updates.role && updates.role !== 'admin') || (updates.is_active === 0);
  if (user.role === 'admin' && demotes) {
    const otherAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1 AND id != ?`).get(user.id).n;
    if (otherAdmins === 0) return res.status(400).json({ error: 'To jedyny aktywny administrator — nie można go zdegradować ani dezaktywować.' });
  }
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const set = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${set} WHERE id = ?`).run(...Object.values(updates), user.id);
  res.json({ ok: true });
});

router.delete('/users/:id', auth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  if (user.id === req.user.userId) return res.status(400).json({ error: 'Nie można usunąć własnego konta.' });
  if (user.role === 'admin') {
    const otherAdmins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND is_active=1 AND id != ?`).get(user.id).n;
    if (otherAdmins === 0) return res.status(400).json({ error: 'To jedyny aktywny administrator — nie można go usunąć.' });
  }
  // Reassign the deleted user's studies to the acting admin so nothing is orphaned.
  const reassigned = db.prepare('UPDATE studies SET owner_id = ? WHERE owner_id = ?').run(req.user.userId, user.id).changes;
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  res.json({ ok: true, reassignedStudies: reassigned });
});

// ── Multer setup (in-memory: files written to SQLite BLOBs, not the filesystem) ─
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Invalid file type'), ok);
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function uniqueSlug(base) {
  let slug = base, i = 2;
  while (db.prepare('SELECT id FROM studies WHERE slug = ?').get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

// ── Studies ───────────────────────────────────────────────────────────────────

// Text fields that are translated per-language (not stored in base columns when lang != pl)
const TRANSLATABLE_STUDY_FIELDS = [
  'participant_title', 'consent_text', 'instruction_text', 'debrief_text',
  'transition_feed_text', 'transition_rating_text',
  'label_likert_question', 'label_likert_min', 'label_likert_max',
  'label_action_like', 'label_action_dislike', 'label_action_share', 'label_action_flag',
  'comment_placeholder',
];

// ── Translation overlay helpers ────────────────────────────────────────────────
// Researcher workflow: duplicate study per language, set study.language to
// target (cs/sk/en), click "Przetłumacz automatycznie" — AI fills translations_json[lang]
// with translated versions of posts/demographic_questions/post_questions/parts.
//
// Pre-existing logic only put STUDY-level fields (consent_text etc.) into the
// overlay on edit. Sub-table edits (PUT /demographic-questions/:id, etc.) wrote
// directly to the DB row — but the runtime overlay in /api/session/start
// SHADOWS the DB row with the translations_json entry for that id. Result:
// researcher's manual correction in a CS/SK clone disappeared into the void.
// Each helper below handles both the read side (admin GET endpoints return
// overlay-applied data so the researcher sees Czech labels in the Czech clone)
// and the write side (PUT/PATCH endpoints save translatable fields to the
// overlay so participants see the corrected text).

// Returns the parsed translations_json overlay for the active language, or null
// when the study is in 'pl' mode (canonical source, no overlay needed). Caller
// can short-circuit on null.
function loadStudyOverlay(study) {
  const lang = study?.language || 'pl';
  if (lang === 'pl' || !study.translations_json) return null;
  try {
    const all = JSON.parse(study.translations_json);
    return all[lang] || null;
  } catch { return null; }
}

// Persists `entryUpdates` into translations_json[lang][tableKey] for the row
// identified by rowId. Creates the language sub-object and the table array
// if absent. Merges into the existing entry when present so partial updates
// don't drop other translated fields. Returns the new translations_json
// string ready to UPDATE into studies. Caller is responsible for the SQL.
function buildOverlayUpdate(study, tableKey, rowId, entryUpdates) {
  const lang = study.language || 'pl';
  if (lang === 'pl') return null;
  let allTrans = {};
  try { allTrans = JSON.parse(study.translations_json || '{}'); } catch {}
  if (!allTrans[lang]) allTrans[lang] = {};
  if (!Array.isArray(allTrans[lang][tableKey])) allTrans[lang][tableKey] = [];
  const arr = allTrans[lang][tableKey];
  // ID match: numeric for table rows (demographic_questions, post_questions,
  // posts), string for parts (e.g. "part-0"). Loose equality + string fallback
  // catches both — and preserves the original type when creating new entries.
  let entry = arr.find(e => String(e.id) === String(rowId));
  if (!entry) {
    entry = { id: typeof rowId === 'number' ? rowId : String(rowId) };
    arr.push(entry);
  }
  Object.assign(entry, entryUpdates);
  return JSON.stringify(allTrans);
}

// Applies the overlay onto a single DB row of `tableKey` so callers (admin
// GET endpoints) return the version the researcher edited / saw last in
// the target language. Mirrors the runtime overlay logic in
// routes/participant.js — identical behaviour so admin view matches what
// participants will see. Pure: returns a new object, doesn't mutate.
function applyOverlayOnRow(study, tableKey, row, opts = {}) {
  const overlay = loadStudyOverlay(study);
  if (!overlay) return row;
  const arr = overlay[tableKey];
  if (!Array.isArray(arr)) return row;
  const trans = arr.find(e => String(e.id) === String(row.id));
  if (!trans) return row;
  const out = { ...row };
  // String-typed translatable fields. Honor the overlay value whenever the
  // overlay DEFINES the field — including an explicit empty string. A
  // researcher who cleared a field in the translated (non-PL) version wants
  // it empty for that language (WYSIWYG); the old truthy check (`if (trans[f])`)
  // treated "" as "no translation" and silently restored the Polish source,
  // so clearing never stuck. We fall back to the source ONLY when the overlay
  // has no entry for the field at all (undefined/null = untranslated). No
  // regression for AI overlays: the translator emits "" only where the source
  // is also "", so honoring it shows the same empty as before.
  (opts.stringFields || []).forEach(f => {
    if (trans[f] != null) out[f] = trans[f];
  });
  // Options translation. CRITICAL distinction:
  //   dbOptionsField — the DB column / request-body field name. Differs
  //     per table: 'options' for demographic_questions, 'options_json'
  //     for post_questions.
  //   overlayKey — the key under which options live inside translations_json.
  //     This is ALWAYS 'options' because the AI-translate prompt + the runtime
  //     overlay in participant.js both use 'options' regardless of table
  //     (see routes/participant.js lines ~252 and ~274/281, and the translate
  //     payload builder which maps options_json → 'options'). Using the DB
  //     column name here was the bug: edits to post_questions options were
  //     written under 'options_json' but the runtime reads 'options' → the
  //     correction was invisible to participants.
  if (opts.dbOptionsField) {
    const overlayKey = 'options';
    const trOpts = trans[overlayKey];
    if (Array.isArray(trOpts)) {
      // Choice question — array of {label} indexed against DB options.
      // Preserves `value` from DB (machine-readable code), swaps `label`.
      let dbOpts = [];
      try { dbOpts = JSON.parse(row[opts.dbOptionsField] || '[]'); } catch {}
      if (Array.isArray(dbOpts)) {
        out[opts.dbOptionsField] = JSON.stringify(dbOpts.map((o, i) => ({
          ...o,
          label: (trOpts[i] && trOpts[i].label) ? trOpts[i].label : o.label,
        })));
      }
    } else if (trOpts && typeof trOpts === 'object') {
      // Likert object — {label_min, label_max, description} translated,
      // {scale, start_at} preserved from DB.
      let dbObj = null;
      try { dbObj = JSON.parse(row[opts.dbOptionsField] || 'null'); } catch {}
      if (dbObj && typeof dbObj === 'object' && !Array.isArray(dbObj)) {
        ['label_min', 'label_max', 'description'].forEach(k => {
          if (trOpts[k]) dbObj[k] = trOpts[k];
        });
        out[opts.dbOptionsField] = JSON.stringify(dbObj);
      }
    }
  }
  return out;
}

// Convenience wrapper: apply overlay to every row in an array, given the same
// tableKey + opts. Returns a new array (rows untouched).
function applyOverlayOnRows(study, tableKey, rows, opts) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const overlay = loadStudyOverlay(study);
  if (!overlay) return rows;
  return rows.map(r => applyOverlayOnRow(study, tableKey, r, opts));
}

// Per-table opts describing which row fields get translated. Keep in sync
// with TRANSLATABLE_STUDY_FIELDS philosophy — only string-typed user-visible
// labels go to the overlay; structural fields (is_active, required, base_likes)
// stay on the DB row.
// dbOptionsField = DB column / request-body field carrying the options blob.
// The overlay key is ALWAYS 'options' (handled inside the helpers) — see the
// long comment in applyOverlayOnRow. demographic_questions stores options in
// the `options` column; post_questions in `options_json`.
const OVERLAY_OPTS_DEMOGRAPHIC = { stringFields: ['label'], dbOptionsField: 'options' };
const OVERLAY_OPTS_POST_QUESTION = { stringFields: ['label'], dbOptionsField: 'options_json' };
const OVERLAY_OPTS_POST = {
  stringFields: [
    'headline_a', 'headline_b', 'content_a', 'content_b',
    'time_ago', 'post_comment', 'post_comment_author',
    // NOTE: `topic` is INTENTIONALLY excluded — it's a key (e.g. "nauka")
    // that the participant client maps through the locale (`topics.<key>`)
    // for the pill label. Overwriting it would break the locale lookup.
    // Same as the runtime overlay in routes/participant.js.
  ],
  // builder_comments_json is per-post array of {author, text, likes?} — handled
  // separately below because it's neither indexed labels nor a flat object.
};

// Splits an incoming updates dict into (DB_updates, overlay_updates) based on
// the field-classification opts. Translatable fields are removed from the DB
// update so the Polish source column is preserved in CS/SK clones — matches
// the existing behaviour of PATCH /studies/:id for study-level fields.
function splitUpdatesByOverlay(updates, opts) {
  const dbUpdates = { ...updates };
  const overlayUpdates = {};
  (opts.stringFields || []).forEach(f => {
    if (dbUpdates[f] !== undefined) {
      overlayUpdates[f] = dbUpdates[f];
      delete dbUpdates[f];
    }
  });
  // Options need careful handling: incoming is the full edited array (or object)
  // under the DB-column field name. We extract just the translatable bits and
  // store them in the overlay under the canonical key 'options' (NOT the DB
  // column name — see applyOverlayOnRow). DB column is left untouched so the
  // Polish source structure (values / scale / start_at) is preserved.
  if (opts.dbOptionsField && dbUpdates[opts.dbOptionsField] !== undefined) {
    let parsed = null;
    try { parsed = typeof dbUpdates[opts.dbOptionsField] === 'string' ? JSON.parse(dbUpdates[opts.dbOptionsField]) : dbUpdates[opts.dbOptionsField]; } catch {}
    if (Array.isArray(parsed)) {
      overlayUpdates.options = parsed.map(o => ({ label: o.label || '' }));
      delete dbUpdates[opts.dbOptionsField];
    } else if (parsed && typeof parsed === 'object') {
      // Likert object — overlay carries label_min/label_max/description only.
      const trObj = {};
      ['label_min', 'label_max', 'description'].forEach(k => {
        if (parsed[k] !== undefined) trObj[k] = parsed[k];
      });
      if (Object.keys(trObj).length) overlayUpdates.options = trObj;
      delete dbUpdates[opts.dbOptionsField];
    }
  }
  return { dbUpdates, overlayUpdates };
}

function resolveStudyDefaults(s) {
  let result = {
    ...s,
    consent_text:           s.consent_text          || db.DEFAULT_CONSENT_TEXT,
    instruction_text:       s.instruction_text      || db.DEFAULT_INSTRUCTION_TEXT,
    debrief_text:           s.debrief_text          || db.DEFAULT_DEBRIEF_TEXT,
    transition_feed_text:   s.transition_feed_text  || db.DEFAULT_TRANSITION_FEED_TEXT,
    transition_rating_text: s.transition_rating_text || db.DEFAULT_TRANSITION_RATING_TEXT,
  };

  // When language != 'pl', overlay translations so admin sees the active language content
  if (s.language && s.language !== 'pl' && s.translations_json) {
    try {
      const allTrans = JSON.parse(s.translations_json);
      const tr = allTrans[s.language] || {};
      TRANSLATABLE_STUDY_FIELDS.forEach(field => {
        if (tr[field]) result[field] = tr[field];
      });
      // Apply parts overlay too — without this, the builder view shows
      // Polish part labels even though the participant sees translated
      // versions from translations_json.parts. Result: researcher edits
      // what looks like Polish, save goes to overlay, participant sees
      // change — but the admin display was confusing before.
      if (Array.isArray(tr.parts) && tr.parts.length && s.parts_json) {
        try {
          const dbParts = JSON.parse(s.parts_json);
          const partsMap = {};
          tr.parts.forEach(p => { partsMap[String(p.id)] = p; });
          if (Array.isArray(dbParts)) {
            const overlaid = dbParts.map(p => {
              const tp = partsMap[String(p.id)];
              if (!tp) return p;
              // != null so a cleared "" in the overlay wins over the source
              // (WYSIWYG) — matches the participant + posts overlay reads.
              const op = (v, fb) => (v != null ? v : fb);
              return {
                ...p,
                label:           op(tp.label,           p.label),
                transition_text: op(tp.transition_text, p.transition_text),
                pq_title:        op(tp.pq_title,        p.pq_title),
                pq_subtitle:     op(tp.pq_subtitle,     p.pq_subtitle),
              };
            });
            result.parts_json = JSON.stringify(overlaid);
          }
        } catch {}
      }
    } catch {}
  }

  return result;
}

router.get('/studies', auth, (req, res) => {
  // Researchers see only their own studies; admins see all.
  const isAdmin = req.user.role === 'admin';
  const studies = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM sessions WHERE study_id=s.id AND completed=1) as completed_count
    FROM studies s ${isAdmin ? '' : 'WHERE s.owner_id = ?'} ORDER BY s.created_at DESC
  `).all(...(isAdmin ? [] : [req.user.userId]));
  // Resolve null text fields to defaults so admin form shows actual content
  const resolved = studies.map(resolveStudyDefaults);
  res.json(resolved);
});

router.post('/studies', auth, (req, res) => {
  const { name, slug: rawSlug, description, institution, contact_email } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const slug = uniqueSlug(rawSlug ? slugify(rawSlug) : slugify(name));

  const info = db.prepare(`
    INSERT INTO studies (name, slug, description, institution, contact_email, owner_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, slug, description || null, institution || null, contact_email || null, req.user.userId);

  // Defensive: DO NOT seed DEFAULT_POSTS here. Legacy behavior auto-seeded
  // 10 prefab posts (NIZP PZH-PIB, IMGW-PIB, Eurostat, etc.) into every new
  // study, which surprised researchers who expected an empty study. The UI
  // no longer uses this endpoint (the "+ Nowe" button hits /studies/builder
  // which creates an empty study), but keeping the seed call here would
  // re-inject defaults if anyone hits this endpoint via API/curl/old code.
  // The seedDefaultPosts function is still exported for tests / explicit
  // demo seeding flows, just not auto-invoked from study creation.
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(info.lastInsertRowid);
  res.json(study);
});

router.patch('/studies/:id', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const { id } = req.params;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!study) return res.status(404).json({ error: 'Not found' });

  const fields = [
    'name', 'slug', 'description', 'institution', 'contact_email', 'is_active',
    'posts_per_session', 'high_metrics_min', 'high_metrics_max',
    'low_metrics_min', 'low_metrics_max',
    'enable_condition_a', 'enable_condition_b',
    'enable_metrics_high', 'enable_metrics_low',
    'hide_topic_badges',
    'layout_type', 'show_reactions', 'enable_comments', 'allow_multi_reactions',
    'show_instructions', 'show_transition_feed', 'show_transition_rating', 'show_debrief', 'show_debrief_posts',
    'show_instruction_actions', 'show_avatars', 'show_demographics', 'demographics_position',
    'label_style_a', 'label_style_b', 'metric_conditions_json', 'show_metrics',
    'label_action_like', 'label_action_dislike', 'label_action_share', 'label_action_flag',
    'label_likert_question', 'label_likert_min', 'label_likert_max', 'comment_placeholder',
    'consent_text', 'instruction_text', 'transition_feed_text', 'transition_rating_text', 'debrief_text',
    'clarity_enabled', 'clarity_project_id',
    'eyetracking_enabled',
    'language',
    'participant_title',
    // Panel-recruitment integration — capture respondent ID from URL query
    // and bounce the participant back to the agency's completion endpoint
    // after debrief. Both NULL/empty by default → no behaviour change for
    // studies that aren't panel-recruited.
    'external_id_param_name', 'completion_redirect_url',
    'completion_redirect_delay_seconds', 'completion_redirect_notice',
    'decline_redirect_url',
    'decline_redirect_delay_seconds', 'decline_redirect_notice',
    'decline_redirect_immediate',
    // Per-study custom hostname binding. When set, the bound subdomain
    // serves ONLY this study (no admin, no other studies). See server.js
    // middleware. NULL = no binding.
    'custom_domain',
  ];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  // Validate clarity_project_id
  if (updates.clarity_project_id != null) {
    const trimmed = String(updates.clarity_project_id).trim();
    if (trimmed !== '' && !/^[a-zA-Z0-9]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'clarity_project_id must contain only alphanumeric characters' });
    }
    updates.clarity_project_id = trimmed || null;
  }

  if (Object.keys(updates).length === 0) return res.json(study);

  // When language is non-Polish, translatable text fields go into translations_json
  // instead of the base columns — this protects the Polish source from being overwritten.
  const lang = updates.language || study.language || 'pl';
  if (lang !== 'pl') {
    const transUpdates = {};
    TRANSLATABLE_STUDY_FIELDS.forEach(f => {
      if (updates[f] !== undefined) {
        transUpdates[f] = updates[f];
        delete updates[f]; // don't touch base column
      }
    });
    if (Object.keys(transUpdates).length) {
      let allTrans = {};
      try { allTrans = JSON.parse(study.translations_json || '{}'); } catch {}
      allTrans[lang] = { ...(allTrans[lang] || {}), ...transUpdates };
      updates.translations_json = JSON.stringify(allTrans);
    }
  }

  if (Object.keys(updates).length === 0) return res.json(resolveStudyDefaults(study));

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE studies SET ${setClauses} WHERE id = ?`)
    .run(...Object.values(updates), id);

  res.json(resolveStudyDefaults(db.prepare('SELECT * FROM studies WHERE id = ?').get(id)));
});

router.delete('/studies/:id', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const { id } = req.params;
  if (req.body.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required: send {confirm: "DELETE"}' });
  }
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!study) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM studies WHERE id = ?').run(id);

  // Remove upload directory
  const dir = path.join(uploadsDir, String(id));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

  res.json({ ok: true });
});

router.post('/studies/:id/duplicate', auth, (req, res) => {
  const { id } = req.params;
  const study = ownedStudy(req, res, id);
  if (!study) return;

  // Dynamic column copy — picks up every studies column including builder_mode,
  // parts_json, manipulation_json, language, translations_json, all show_* flags,
  // clarity/eyetracking, participant_title, etc. without a hardcoded list.
  const studiesCols = db.prepare(`PRAGMA table_info(studies)`).all()
    .map(c => c.name)
    .filter(n => n !== 'id' && n !== 'created_at');

  // Compute next "(kopia N)" name. Examples: "Foo" → "Foo (kopia)"; "Foo (kopia)"
  // → "Foo (kopia 2)"; "Foo (kopia 7)" → "Foo (kopia 8)" (skipping any taken numbers).
  const copyMatch = study.name.match(/^(.+?)\s*\(kopia(?:\s+(\d+))?\)$/);
  const baseName = copyMatch ? copyMatch[1] : study.name;
  const takenNames = new Set(
    db.prepare(`SELECT name FROM studies WHERE name = ? OR name LIKE ?`)
      .all(baseName + ' (kopia)', baseName + ' (kopia %)')
      .map(r => r.name)
  );
  let n = 1;
  const buildName = () => n === 1 ? `${baseName} (kopia)` : `${baseName} (kopia ${n})`;
  while (takenNames.has(buildName())) n++;
  const newName = buildName();
  const newSlug = uniqueSlug(slugify(newName));
  const overrides = {
    name: newName,
    slug: newSlug,
    is_active: 0, // duplicates start inactive so they can't be activated by accident
    owner_id: req.user.userId, // the copy belongs to whoever duplicated it, not the source owner
  };

  const insertCols = studiesCols;
  const insertVals = insertCols.map(c => (c in overrides ? overrides[c] : study[c]));
  const placeholders = insertCols.map(() => '?').join(', ');
  const info = db.prepare(
    `INSERT INTO studies (${insertCols.join(', ')}) VALUES (${placeholders})`
  ).run(...insertVals);
  const newStudyId = info.lastInsertRowid;

  // ── Posts: copy every column except id/study_id ──────────────────────────────
  // BLOBs (image_blob_a/b, avatar_blob) are duplicated automatically by the INSERT
  // since they're regular columns picked up by PRAGMA. The /uploads/:studyId/:filename
  // route resolves by (study_id, filename), so identical image_path_* values on the
  // new row resolve to its own (newly-inserted) BLOB. No file copy needed.
  // Track old-id → new-id mappings for posts / post_questions / demographic_questions
  // so we can rewrite translations_json afterwards (translations are keyed by row id;
  // without a remap, the duplicate's overlay lookups would all miss and fall back
  // to PL — exactly the bug the user hit).
  const postIdMap = {};
  const pqIdMap   = {};
  const dqIdMap   = {};

  const postsCols = db.prepare(`PRAGMA table_info(posts)`).all()
    .map(c => c.name)
    .filter(n => n !== 'id' && n !== 'study_id');
  const posts = db.prepare('SELECT * FROM posts WHERE study_id = ?').all(id);
  const insertPostStmt = db.prepare(
    `INSERT INTO posts (study_id, ${postsCols.join(', ')}) VALUES (?, ${postsCols.map(() => '?').join(', ')})`
  );
  posts.forEach(p => {
    const info = insertPostStmt.run(newStudyId, ...postsCols.map(c => p[c]));
    postIdMap[p.id] = info.lastInsertRowid;
  });

  // ── Post questions (builder) ─────────────────────────────────────────────────
  const pqCols = db.prepare(`PRAGMA table_info(post_questions)`).all()
    .map(c => c.name)
    .filter(n => n !== 'id' && n !== 'study_id');
  const pqs = db.prepare('SELECT * FROM post_questions WHERE study_id = ?').all(id);
  if (pqs.length) {
    const insertPq = db.prepare(
      `INSERT INTO post_questions (study_id, ${pqCols.join(', ')}) VALUES (?, ${pqCols.map(() => '?').join(', ')})`
    );
    pqs.forEach(q => {
      const info = insertPq.run(newStudyId, ...pqCols.map(c => q[c]));
      pqIdMap[q.id] = info.lastInsertRowid;
    });
  }

  // ── Demographic questions ────────────────────────────────────────────────────
  const dqCols = db.prepare(`PRAGMA table_info(demographic_questions)`).all()
    .map(c => c.name)
    .filter(n => n !== 'id' && n !== 'study_id');
  const dqs = db.prepare('SELECT * FROM demographic_questions WHERE study_id = ?').all(id);
  if (dqs.length) {
    const insertDq = db.prepare(
      `INSERT INTO demographic_questions (study_id, ${dqCols.join(', ')}) VALUES (?, ${dqCols.map(() => '?').join(', ')})`
    );
    dqs.forEach(q => {
      const info = insertDq.run(newStudyId, ...dqCols.map(c => q[c]));
      dqIdMap[q.id] = info.lastInsertRowid;
    });
  }

  // ── Remap translations_json ids ──────────────────────────────────────────────
  // translations_json was copied verbatim from the source study. Its posts[],
  // demographic_questions[] and post_questions[] arrays reference the SOURCE
  // study's row ids — the duplicate has different (newly-assigned) ids so the
  // overlay would never match. Walk each language and remap every id.
  if (study.translations_json) {
    let allTrans = {};
    try { allTrans = JSON.parse(study.translations_json); } catch {}
    let touched = false;
    Object.keys(allTrans).forEach(lang => {
      const t = allTrans[lang];
      if (!t || typeof t !== 'object') return;
      if (Array.isArray(t.posts)) {
        t.posts = t.posts
          .map(p => postIdMap[p.id] ? { ...p, id: postIdMap[p.id] } : null)
          .filter(Boolean);
        touched = true;
      }
      if (Array.isArray(t.demographic_questions)) {
        t.demographic_questions = t.demographic_questions
          .map(q => dqIdMap[q.id] ? { ...q, id: dqIdMap[q.id] } : null)
          .filter(Boolean);
        touched = true;
      }
      if (Array.isArray(t.post_questions)) {
        t.post_questions = t.post_questions
          .map(q => pqIdMap[q.id] ? { ...q, id: pqIdMap[q.id] } : null)
          .filter(Boolean);
        touched = true;
      }
      // parts[] keys are strings ("part-0") preserved verbatim in parts_json,
      // so no remap needed — the translations match by string id.
    });
    if (touched) {
      db.prepare('UPDATE studies SET translations_json = ? WHERE id = ?')
        .run(JSON.stringify(allTrans), newStudyId);
    }
  }

  res.json(db.prepare('SELECT * FROM studies WHERE id = ?').get(newStudyId));
});

// ── Posts ─────────────────────────────────────────────────────────────────────
router.get('/studies/:id/posts', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const posts = db.prepare('SELECT * FROM posts WHERE study_id = ? ORDER BY order_index').all(req.params.id);

  // Overlay translated post content when study language != 'pl'
  const study = db.prepare('SELECT language, translations_json FROM studies WHERE id = ?').get(req.params.id);
  if (study && study.language && study.language !== 'pl' && study.translations_json) {
    try {
      const allTrans = JSON.parse(study.translations_json);
      const transPosts = (allTrans[study.language] || {}).posts || [];
      if (transPosts.length) {
        const tpMap = {};
        transPosts.forEach(tp => { tpMap[tp.id] = tp; });
        const overlaid = posts.map(p => {
          const tp = tpMap[p.id];
          if (!tp) return p;
          // builder_comments_json overlay: per-comment {author, text}
          // merged into the DB-side structure (which also has likes counts
          // and ordering). Preserves DB ordering / likes, translates the
          // visible strings.
          let mergedComments = p.builder_comments_json;
          if (Array.isArray(tp.builder_comments_json) && p.builder_comments_json) {
            try {
              const dbComments = JSON.parse(p.builder_comments_json || '[]');
              const trComments = tp.builder_comments_json;
              if (Array.isArray(dbComments)) {
                mergedComments = JSON.stringify(dbComments.map((c, i) => ({
                  ...c,
                  author: (trComments[i] && trComments[i].author) || c.author,
                  text:   (trComments[i] && trComments[i].text)   || c.text,
                })));
              }
            } catch {}
          }
          // != null (not truthy ||) so an explicitly-cleared "" in the
          // overlay wins over the DB source — keeps the builder editor in
          // sync with what the participant sees (WYSIWYG). topic stays || :
          // it's a locale key, never intentionally blanked.
          const op = (v, fb) => (v != null ? v : fb);
          return {
            ...p,
            headline_a: op(tp.headline_a, p.headline_a),
            content_a:  op(tp.content_a,  p.content_a),
            headline_b: op(tp.headline_b, p.headline_b),
            content_b:  op(tp.content_b,  p.content_b),
            time_ago:   op(tp.time_ago,   p.time_ago),
            topic:      tp.topic      || p.topic,
            post_comment:        op(tp.post_comment,        p.post_comment),
            post_comment_author: op(tp.post_comment_author, p.post_comment_author),
            builder_comments_json: mergedComments,
          };
        });
        return res.json(overlaid);
      }
    } catch {}
  }

  res.json(posts);
});

router.post('/posts', auth, (req, res) => {
  if (!ownedStudy(req, res, req.body.study_id)) return;
  const { study_id, topic, emoji, source_name, source_handle, time_ago,
    headline_a, content_a, headline_b, content_b, is_true, manipulation_techniques,
    base_likes, base_shares, base_dislikes, base_flags } = req.body;

  if (!study_id) return res.status(400).json({ error: 'study_id required' });

  const maxOrder = db.prepare('SELECT MAX(order_index) as m FROM posts WHERE study_id = ?').get(study_id)?.m || 0;
  const info = db.prepare(`
    INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle,
      time_ago, headline_a, content_a, headline_b, content_b, is_true,
      manipulation_techniques, base_likes, base_shares, base_dislikes, base_flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(study_id, maxOrder + 1, topic || 'nauka', emoji || '📝',
    source_name || '', source_handle || '', time_ago || 'teraz',
    headline_a || '', content_a || '', headline_b || '', content_b || '',
    is_true ? 1 : 0, JSON.stringify(manipulation_techniques || []),
    base_likes || 0, base_shares || 0, base_dislikes || 0, base_flags || 0);

  res.json(db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/posts/:id', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });

  const fields = ['topic', 'hide_topic', 'emoji', 'source_name', 'source_handle', 'time_ago',
    'headline_a', 'content_a', 'headline_b', 'content_b', 'is_true',
    'manipulation_techniques', 'base_likes', 'base_shares', 'base_dislikes', 'base_flags', 'is_active',
    'post_comment', 'post_comment_author', 'metrics_override_json', 'post_comments_json',
    'builder_comments_json', 'show_avatar',
    'show_like', 'show_dislike', 'show_share', 'show_flag', 'show_comment',
    'part_id', 'part_ids_json'];

  const updates = {};
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      updates[f] = f === 'manipulation_techniques' && Array.isArray(req.body[f])
        ? JSON.stringify(req.body[f])
        : req.body[f];
    }
  });

  // Keep part_id in sync with part_ids_json so legacy readers (exports,
  // pre-multi-part code paths) still return a sensible primary part. When
  // the client sends part_ids_json, derive part_id from its first element;
  // empty array → both become NULL (orphan → first part at runtime).
  if (Object.prototype.hasOwnProperty.call(updates, 'part_ids_json')) {
    let arr = [];
    try { arr = JSON.parse(updates.part_ids_json || '[]'); } catch {}
    if (!Array.isArray(arr)) arr = [];
    updates.part_id = arr[0] || null;
    if (!arr.length) updates.part_ids_json = null;
  }

  if (!Object.keys(updates).length) return res.json(post);

  // Translation overlay routing for posts (see /demographic-questions/:id
  // for the full rationale). headline_a/b, content_a/b, time_ago,
  // post_comment, post_comment_author go to translations_json[lang].posts
  // when the study is non-PL. Structural fields (is_active, base_likes,
  // image_path, part_id, manipulation_techniques, show_* toggles) stay
  // on the DB row. `topic` is NOT translatable — it's a locale key.
  // `builder_comments_json` is handled separately: extract its translatable
  // parts (author + text per comment) into overlay while leaving the DB
  // structure (likes counts, comment ordering) intact in the Polish source.
  const study = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(post.study_id);
  let dbUpdates = updates;
  let overlayUpdates = {};
  if (study?.language && study.language !== 'pl') {
    const split = splitUpdatesByOverlay(updates, OVERLAY_OPTS_POST);
    dbUpdates = split.dbUpdates;
    overlayUpdates = split.overlayUpdates;
    // builder_comments_json — special-case nested overlay (per comment:
    // {author, text} translated, structure + likes count stay in DB).
    if (dbUpdates.builder_comments_json !== undefined) {
      let parsed = null;
      try { parsed = typeof dbUpdates.builder_comments_json === 'string' ? JSON.parse(dbUpdates.builder_comments_json) : dbUpdates.builder_comments_json; } catch {}
      if (Array.isArray(parsed)) {
        overlayUpdates.builder_comments_json = parsed.map(c => ({
          author: c.author || '',
          text:   c.text   || '',
        }));
        delete dbUpdates.builder_comments_json;
      }
    }
  }

  if (Object.keys(dbUpdates).length) {
    const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE posts SET ${setClauses}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(dbUpdates), req.params.id);
  }
  if (Object.keys(overlayUpdates).length) {
    const newTransJson = buildOverlayUpdate(study, 'posts', post.id, overlayUpdates);
    if (newTransJson) {
      db.prepare('UPDATE studies SET translations_json = ? WHERE id = ?').run(newTransJson, study.id);
    }
  }
  res.json(db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id));
});

router.patch('/posts/:id/reorder', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  const { direction } = req.body;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });

  const sibling = direction === 'up'
    ? db.prepare('SELECT * FROM posts WHERE study_id = ? AND order_index < ? ORDER BY order_index DESC LIMIT 1').get(post.study_id, post.order_index)
    : db.prepare('SELECT * FROM posts WHERE study_id = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1').get(post.study_id, post.order_index);

  if (!sibling) return res.json({ ok: true });

  db.prepare('UPDATE posts SET order_index = ? WHERE id = ?').run(sibling.order_index, post.id);
  db.prepare('UPDATE posts SET order_index = ? WHERE id = ?').run(post.order_index, sibling.id);
  res.json({ ok: true });
});

// Helper: map variant to the right columns
function imageColsFor(variant) {
  if (variant === 'a') return { pathCol: 'image_path_a', blobCol: 'image_blob_a', mimeCol: 'image_mime_a' };
  if (variant === 'b') return { pathCol: 'image_path_b', blobCol: 'image_blob_b', mimeCol: 'image_mime_b' };
  // Legacy single-image endpoint — write to image_path (no blob column for it; treat as variant 'a' for blob storage)
  return { pathCol: 'image_path', blobCol: 'image_blob_a', mimeCol: 'image_mime_a' };
}

function extFromMime(mime) {
  if (mime === 'image/png')  return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif')  return '.gif';
  return '.jpg';
}

function handleImageUpload(req, res) {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const post = db.prepare('SELECT study_id FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!ownedStudy(req, res, post.study_id)) return;

    const variant = req.params.variant;
    const { pathCol, blobCol, mimeCol } = imageColsFor(variant);
    const ext = extFromMime(req.file.mimetype);
    // Unique filename per upload (timestamp token). Previously the name was
    // deterministic (`<id>_<variant>.<ext>`) so re-uploading an image kept the
    // SAME URL — the browser and the Cloudflare CDN in front of Railway then
    // served the cached OLD image for up to an hour, even though the DB blob
    // had been replaced. A fresh filename means a never-before-seen URL on
    // every upload, so caches always fetch the new bytes from origin. The
    // blob column is still reused (overwritten), so no orphan blobs pile up;
    // only the stored image_path string changes.
    const stamp = Date.now().toString(36);
    const filename = variant ? `${req.params.id}_${variant}_${stamp}${ext}` : `${req.params.id}_${stamp}${ext}`;

    db.prepare(`UPDATE posts SET ${blobCol} = ?, ${mimeCol} = ?, ${pathCol} = ? WHERE id = ?`)
      .run(req.file.buffer, req.file.mimetype, filename, req.params.id);

    res.json({
      col: pathCol,
      filename,
      image_url: `/uploads/${post.study_id}/${filename}?t=${Date.now()}`,
    });
  });
}

router.post('/posts/:id/image/:variant', auth, handleImageUpload);
router.post('/posts/:id/image',          auth, handleImageUpload); // legacy (no variant)

router.delete('/posts/:id', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  // Cascade-delete reactions and ratings
  const sessions = db.prepare('SELECT id FROM sessions WHERE study_id = ?').all(post.study_id).map(s => s.id);
  if (sessions.length) {
    const placeholders = sessions.map(() => '?').join(',');
    db.prepare(`DELETE FROM reactions WHERE post_id = ? AND session_id IN (${placeholders})`).run(post.id, ...sessions);
    db.prepare(`DELETE FROM ratings  WHERE post_id = ? AND session_id IN (${placeholders})`).run(post.id, ...sessions);
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id); // BLOBs go with the row
  // Best-effort cleanup of any legacy disk files still present
  for (const col of ['image_path', 'image_path_a', 'image_path_b', 'avatar_path']) {
    if (post[col]) {
      const fp = path.join(uploadsDir, String(post.study_id), post[col]);
      if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch {}
    }
  }
  res.json({ ok: true });
});

// ── Post library ──────────────────────────────────────────────────────────────
// A study-agnostic catalogue of reusable posts. Copying into a study is a true
// copy (BLOBs included) via INSERT…SELECT over the shared content-column list;
// the study post and the library source are fully independent afterwards.
const LIB_COLS = db.POST_LIBRARY_CONTENT_COLS;
const LIB_NON_BLOB = LIB_COLS.filter(c => !c.includes('blob')); // safe to echo in JSON
const LIB_EDITABLE = LIB_NON_BLOB.filter(c => !c.endsWith('_mime')); // client-settable fields

// GET /post-library — catalogue (metadata + light preview fields, no BLOBs). Optional ?category=.
router.get('/post-library', auth, (req, res) => {
  const cat = (req.query.category || '').trim();
  const where = cat ? ' WHERE category = ?' : '';
  const rows = db.prepare(
    `SELECT id, name, category, description, is_active, created_at, updated_at,
            topic, source_name, source_handle, headline_a, is_true,
            (image_blob_a IS NOT NULL OR image_path_a IS NOT NULL OR image_path IS NOT NULL) AS has_image
       FROM post_library${where} ORDER BY id DESC`
  ).all(...(cat ? [cat] : []));
  res.json(rows);
});

// GET /post-library/:id — full editable row (BLOBs excluded; use /post-library/:id/image for preview).
router.get('/post-library/:id', auth, (req, res) => {
  const row = db.prepare(
    `SELECT id, name, category, description, translations_json, is_active, created_at, updated_at,
            ${LIB_NON_BLOB.join(', ')}
       FROM post_library WHERE id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// POST /post-library — create a new library post (metadata + any content fields sent).
router.post('/post-library', auth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim() || 'Nowy post w bibliotece';
  const fields = ['name', 'category', 'description', 'translations_json'];
  const values = [name, b.category ?? null, b.description ?? null, b.translations_json ?? '{}'];
  LIB_EDITABLE.forEach(c => { if (b[c] !== undefined) { fields.push(c); values.push(b[c]); } });
  const info = db.prepare(
    `INSERT INTO post_library (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`
  ).run(...values);
  res.json({ id: info.lastInsertRowid });
});

// PATCH /post-library/:id — edit metadata + content fields (BLOBs handled by a separate image route).
router.patch('/post-library/:id', auth, (req, res) => {
  const exists = db.prepare('SELECT id FROM post_library WHERE id = ?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const allowed = ['name', 'category', 'description', 'translations_json', 'is_active', ...LIB_EDITABLE];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const set = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE post_library SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(...Object.values(updates), req.params.id);
  res.json({ ok: true });
});

// DELETE /post-library/:id — remove the catalogue entry (study posts copied from it are untouched;
// their library_post_id becomes a dangling audit pointer, which is intentional — no FK cascade).
router.delete('/post-library/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM post_library WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// GET /post-library/:id/image[?variant=a|b|avatar] — preview a library BLOB. Deliberately UNauthenticated
// (like the public /uploads route) so it works in an <img src> — the JWT is a Bearer header, not a cookie.
// These are the same study stimuli already served publicly via /uploads, so this exposes nothing new.
router.get('/post-library/:id/image', (req, res) => {
  const variant = req.query.variant === 'b' ? 'b' : req.query.variant === 'avatar' ? 'avatar' : 'a';
  const blobCol = variant === 'avatar' ? 'avatar_blob' : `image_blob_${variant}`;
  const mimeCol = variant === 'avatar' ? 'avatar_mime' : `image_mime_${variant}`;
  const row = db.prepare(`SELECT ${blobCol} AS blob, ${mimeCol} AS mime FROM post_library WHERE id = ?`).get(req.params.id);
  if (!row || !row.blob) return res.status(404).end();
  res.set('Content-Type', row.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(row.blob);
});

// POST /studies/:studyId/posts/from-library { library_post_id } — copy a library post into the study.
router.post('/studies/:studyId/posts/from-library', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const { studyId } = req.params;
  const libId = req.body.library_post_id;
  if (!db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId)) return res.status(404).json({ error: 'Study not found' });
  if (!db.prepare('SELECT id FROM post_library WHERE id = ?').get(libId)) return res.status(404).json({ error: 'Library post not found' });
  const nextOrder = db.prepare('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM posts WHERE study_id = ?').get(studyId).n;
  const cols = LIB_COLS.join(', ');
  const info = db.prepare(
    `INSERT INTO posts (study_id, order_index, library_post_id, ${cols})
     SELECT ?, ?, ?, ${cols} FROM post_library WHERE id = ?`
  ).run(studyId, nextOrder, libId, libId);
  res.json({ id: info.lastInsertRowid });
});

// POST /posts/:id/to-library { name, category, description } — promote a study post into the library
// (copies content + BLOBs). The study post is left in place; this just seeds a reusable catalogue entry.
router.post('/posts/:id/to-library', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  if (!db.prepare('SELECT id FROM posts WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Post not found' });
  const name = String(req.body.name || '').trim() || 'Post z badania';
  const cols = LIB_COLS.join(', ');
  const info = db.prepare(
    `INSERT INTO post_library (name, category, description, ${cols})
     SELECT ?, ?, ?, ${cols} FROM posts WHERE id = ?`
  ).run(name, req.body.category ?? null, req.body.description ?? null, req.params.id);
  res.json({ id: info.lastInsertRowid });
});

router.post('/posts/:id/avatar', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const post = db.prepare('SELECT study_id FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const ext = extFromMime(req.file.mimetype);
    // Unique per upload — same cache-busting rationale as post images above.
    const filename = `av_${req.params.id}_${Date.now().toString(36)}${ext}`;

    db.prepare('UPDATE posts SET avatar_blob = ?, avatar_mime = ?, avatar_path = ? WHERE id = ?')
      .run(req.file.buffer, req.file.mimetype, filename, req.params.id);

    res.json({ avatar_url: `/uploads/${post.study_id}/${filename}?t=${Date.now()}` });
  });
});

router.delete('/posts/:id/avatar', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  const post = db.prepare('SELECT study_id, avatar_path FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE posts SET avatar_blob = NULL, avatar_mime = NULL, avatar_path = NULL WHERE id = ?').run(req.params.id);
  // Best-effort: also remove any leftover disk file
  if (post.avatar_path) {
    const fp = path.join(uploadsDir, String(post.study_id), post.avatar_path);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch {}
  }
  res.json({ ok: true });
});

router.delete('/posts/:id/image/:variant', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  const { pathCol, blobCol, mimeCol } = imageColsFor(req.params.variant);
  db.prepare(`UPDATE posts SET ${blobCol} = NULL, ${mimeCol} = NULL, ${pathCol} = NULL WHERE id = ?`).run(req.params.id);
  if (post[pathCol]) {
    const fp = path.join(uploadsDir, String(post.study_id), post[pathCol]);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch {}
  }
  res.json({ ok: true });
});

router.delete('/posts/:id/image', auth, (req, res) => {
  if (!ownedByChild(req, res, 'posts', req.params.id)) return;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE posts SET image_blob_a = NULL, image_mime_a = NULL, image_path = NULL WHERE id = ?').run(req.params.id);
  if (post.image_path) {
    const fp = path.join(uploadsDir, String(post.study_id), post.image_path);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch {}
  }
  res.json({ ok: true });
});

// ── Demographic Questions ─────────────────────────────────────────────────────
router.get('/studies/:studyId/demographic-questions', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const { studyId } = req.params;
  const existing = db.prepare('SELECT COUNT(*) as n FROM demographic_questions WHERE study_id = ?').get(studyId);
  if (!existing || existing.n === 0) {
    db.seedDefaultDemographicQuestions(Number(studyId));
  }
  const questions = db.prepare(
    'SELECT * FROM demographic_questions WHERE study_id = ? ORDER BY order_index'
  ).all(studyId);
  // Apply translation overlay so admin in a CS/SK clone sees the translated
  // labels they (or AI) saved last — not the Polish source rows. Without
  // this the researcher would edit Polish thinking it was Czech, and the
  // resulting save (now overlay-aware) would corrupt the overlay.
  const study = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(studyId);
  res.json(applyOverlayOnRows(study, 'demographic_questions', questions, OVERLAY_OPTS_DEMOGRAPHIC));
});

router.post('/studies/:studyId/demographic-questions', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const { studyId } = req.params;
  const { field_key, label, input_type, options, required, order_index, is_active } = req.body;
  if (!field_key || !label) return res.status(400).json({ error: 'field_key and label required' });
  const maxOrder = db.prepare('SELECT MAX(order_index) as m FROM demographic_questions WHERE study_id = ?').get(studyId)?.m ?? -1;
  const info = db.prepare(`
    INSERT INTO demographic_questions (study_id, field_key, label, input_type, options, required, order_index, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    studyId, field_key, label,
    input_type || 'radio',
    options || '[]',
    required != null ? (required ? 1 : 0) : 1,
    order_index != null ? order_index : maxOrder + 1,
    is_active != null ? (is_active ? 1 : 0) : 1
  );
  res.json(db.prepare('SELECT * FROM demographic_questions WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/demographic-questions/:id', auth, (req, res) => {
  if (!ownedByChild(req, res, 'demographic_questions', req.params.id)) return;
  const dq = db.prepare('SELECT * FROM demographic_questions WHERE id = ?').get(req.params.id);
  if (!dq) return res.status(404).json({ error: 'Not found' });
  // min_value / max_value are bounds for freeform inputs — character count
  // for input_type='text', numeric range for input_type='number'. The
  // client sends `null` to clear an existing bound; we let those through
  // so a researcher can drop a constraint without re-creating the question.
  const fields = ['field_key', 'label', 'input_type', 'options', 'required', 'order_index', 'is_active', 'min_value', 'max_value'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) return res.json(dq);

  // Translation overlay routing — in CS/SK clones, translatable fields
  // (`label`, `options` labels) go to studies.translations_json instead
  // of the DB row so the runtime overlay in /api/session/start picks them
  // up. Structural fields (is_active, required, min_value, max_value,
  // order_index, input_type, field_key) stay on the DB row regardless of
  // language because they aren't user-facing text. See helpers at top.
  const study = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(dq.study_id);
  const { dbUpdates, overlayUpdates } = (study?.language && study.language !== 'pl')
    ? splitUpdatesByOverlay(updates, OVERLAY_OPTS_DEMOGRAPHIC)
    : { dbUpdates: updates, overlayUpdates: {} };

  if (Object.keys(dbUpdates).length) {
    const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE demographic_questions SET ${setClauses} WHERE id = ?`).run(...Object.values(dbUpdates), req.params.id);
  }
  if (Object.keys(overlayUpdates).length) {
    const newTransJson = buildOverlayUpdate(study, 'demographic_questions', dq.id, overlayUpdates);
    if (newTransJson) {
      db.prepare('UPDATE studies SET translations_json = ? WHERE id = ?').run(newTransJson, study.id);
    }
  }
  // Return the row WITH overlay applied so the admin UI immediately reflects
  // the saved CS/SK version (not the Polish DB source).
  const refreshedRow = db.prepare('SELECT * FROM demographic_questions WHERE id = ?').get(req.params.id);
  const refreshedStudy = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(dq.study_id);
  res.json(applyOverlayOnRow(refreshedStudy, 'demographic_questions', refreshedRow, OVERLAY_OPTS_DEMOGRAPHIC));
});

router.delete('/demographic-questions/:id', auth, (req, res) => {
  if (!ownedByChild(req, res, 'demographic_questions', req.params.id)) return;
  const dq = db.prepare('SELECT * FROM demographic_questions WHERE id = ?').get(req.params.id);
  if (!dq) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM demographic_questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/demographic-questions/:id/reorder', auth, (req, res) => {
  if (!ownedByChild(req, res, 'demographic_questions', req.params.id)) return;
  const { direction } = req.body;
  const dq = db.prepare('SELECT * FROM demographic_questions WHERE id = ?').get(req.params.id);
  if (!dq) return res.status(404).json({ error: 'Not found' });
  const sibling = direction === 'up'
    ? db.prepare('SELECT * FROM demographic_questions WHERE study_id = ? AND order_index < ? ORDER BY order_index DESC LIMIT 1').get(dq.study_id, dq.order_index)
    : db.prepare('SELECT * FROM demographic_questions WHERE study_id = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1').get(dq.study_id, dq.order_index);
  if (!sibling) return res.json({ ok: true });
  db.prepare('UPDATE demographic_questions SET order_index = ? WHERE id = ?').run(sibling.order_index, dq.id);
  db.prepare('UPDATE demographic_questions SET order_index = ? WHERE id = ?').run(dq.order_index, sibling.id);
  res.json({ ok: true });
});

// ── Aggregate dashboard (cross-study landing) ───────────────────────────────
// Registered BEFORE '/dashboard/:studyId' so the literal 'aggregate' segment
// is matched here, not captured as a study id. Production sessions only
// (is_preview=0). Counts total by started_at so unfinished sessions (NULL
// completed_at) are not dropped and the drop-out rate is real.
router.get('/dashboard/aggregate', auth, (req, res) => {
  const dateFromRaw = req.query.date_from || null;
  const dateToRaw   = req.query.date_to   || null;
  const dateFrom = dateFromRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateFromRaw) ? dateFromRaw : null;
  const dateTo   = dateToRaw   && /^\d{4}-\d{2}-\d{2}$/.test(dateToRaw)   ? dateToRaw   : null;
  const dRangeStart = (dateFrom ? ` AND date(started_at) >= date('${dateFrom}')` : '') + (dateTo ? ` AND date(started_at) <= date('${dateTo}')` : '');
  const dRangeCompl = (dateFrom ? ` AND date(completed_at) >= date('${dateFrom}')` : '') + (dateTo ? ` AND date(completed_at) <= date('${dateTo}')` : '');

  // Owner scoping: a researcher's aggregate must count ONLY their own studies +
  // those studies' sessions; an admin sees everything. userId is an integer from
  // a verified JWT, so inlining it is injection-safe (same pattern as the dates).
  const isAdmin = req.user.role === 'admin';
  const uid = Number(req.user.userId) || 0;
  const sessOwn    = isAdmin ? '' : ` AND study_id IN (SELECT id FROM studies WHERE owner_id = ${uid})`;
  const studyOwn   = isAdmin ? '' : ` WHERE owner_id = ${uid}`;
  const studySOwn  = isAdmin ? '' : ` WHERE s.owner_id = ${uid}`;

  const totalStudies = db.prepare(`SELECT COUNT(*) as n FROM studies${studyOwn}`).get()?.n || 0;
  const total     = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE is_preview = 0${dRangeStart}${sessOwn}`).get()?.n || 0;
  const completed = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE completed = 1 AND is_preview = 0${dRangeCompl}${sessOwn}`).get()?.n || 0;
  const dropout_rate = total > 0 ? Math.round(((total - completed) / total) * 10000) / 100 : 0;

  const avgRow = db.prepare(`
    SELECT AVG((julianday(completed_at) - julianday(started_at)) * 24 * 60) as mins
    FROM sessions WHERE completed = 1 AND is_preview = 0 AND started_at IS NOT NULL AND completed_at IS NOT NULL${dRangeCompl}${sessOwn}
  `).get();
  const avg_duration_min = avgRow?.mins != null ? Math.round(avgRow.mins * 10) / 10 : null;

  // Completed sessions per day, last 30 days, across the caller's studies.
  const timeseries = db.prepare(`
    SELECT date(completed_at) as d, COUNT(*) as n
    FROM sessions WHERE completed = 1 AND is_preview = 0 AND completed_at >= date('now', '-30 days')${sessOwn}
    GROUP BY date(completed_at) ORDER BY d
  `).all();

  // Per-study mini summary (production only), newest first.
  const perStudy = db.prepare(`
    SELECT s.id, s.name, s.slug,
      (SELECT COUNT(*) FROM sessions WHERE study_id = s.id AND is_preview = 0) as total,
      (SELECT COUNT(*) FROM sessions WHERE study_id = s.id AND completed = 1 AND is_preview = 0) as completed
    FROM studies s${studySOwn} ORDER BY s.id DESC
  `).all().map(r => ({
    ...r,
    dropout_rate: r.total > 0 ? Math.round(((r.total - r.completed) / r.total) * 10000) / 100 : 0,
  }));

  res.json({ totalStudies, total, completed, dropout_rate, avg_duration_min, timeseries, perStudy });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard/:studyId', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const { studyId } = req.params;

  // Preview-session filtering — same pattern as the export. Researcher can pass
  // ?include_preview=1 from the UI toggle to surface the sessions they
  // generated via "Podgląd" during builder development.
  const includePreview = req.query.include_preview === '1' || req.query.include_preview === 'true';
  const previewS  = includePreview ? '' : ' AND s.is_preview = 0';
  const previewNo = includePreview ? '' : ' AND is_preview = 0';

  // Optional global date range filter on completed_at. UI sends ISO dates; we
  // pass them through to getDaneSuroweData below AND apply to the dashboard's
  // own session counts so KPI / time-series widgets stay in sync with the
  // recent-sessions table the legacy code path produces.
  const dateFromRaw = req.query.date_from || null;
  const dateToRaw   = req.query.date_to   || null;
  const dateFrom = dateFromRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateFromRaw) ? dateFromRaw : null;
  const dateTo   = dateToRaw   && /^\d{4}-\d{2}-\d{2}$/.test(dateToRaw)   ? dateToRaw   : null;
  const dateS  = (dateFrom ? ` AND date(s.completed_at) >= date('${dateFrom}')` : '') + (dateTo ? ` AND date(s.completed_at) <= date('${dateTo}')` : '');
  const dateNo = (dateFrom ? ` AND date(completed_at) >= date('${dateFrom}')`   : '') + (dateTo ? ` AND date(completed_at) <= date('${dateTo}')`   : '');
  // Same range but on started_at — for counting ALL sessions (incl. unfinished,
  // whose completed_at is NULL and would otherwise be dropped by a date filter,
  // making the drop-out rate collapse to 0%).
  const dateNoStart = (dateFrom ? ` AND date(started_at) >= date('${dateFrom}')` : '') + (dateTo ? ` AND date(started_at) <= date('${dateTo}')` : '');

  // Two counts to match the UI mental model:
  //  - preview_count           = completed preview sessions; THIS is what would
  //                              show up in the export if include_preview=true,
  //                              and matches the preview table row count
  //  - preview_count_incomplete = in-progress preview rows that never finished
  //                              (admin started a test but didn't go through).
  //                              Doesn't appear in export OR preview table.
  // Delete button cleans both up (just garbage).
  const previewCount = db.prepare(
    'SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND is_preview = 1 AND completed = 1'
  ).get(studyId)?.n || 0;
  const previewCountIncomplete = db.prepare(
    'SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND is_preview = 1 AND (completed = 0 OR completed IS NULL)'
  ).get(studyId)?.n || 0;

  // All session-counting queries respect the global date range when set,
  // so KPIs / recent sessions / condition pivots stay in sync with widgets.
  // (Excludes eye-tracking stats — those are orthogonal to time and the
  // researcher typically wants to see ALL ET data regardless of date range.)
  const total = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE study_id = ?${previewNo}${dateNoStart}`).get(studyId)?.n || 0;
  const completed = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND completed = 1${previewNo}${dateNo}`).get(studyId)?.n || 0;
  const dropout_rate = total > 0 ? Math.round(((total - completed) / total) * 10000) / 100 : 0;

  const condCompletion = db.prepare(`
    SELECT full_condition, COUNT(*) as count
    FROM sessions WHERE study_id = ? AND completed = 1${previewNo}${dateNo}
    GROUP BY full_condition
  `).all(studyId);

  const beliefByCondFalse = db.prepare(`
    SELECT s.full_condition, ROUND(AVG(rt.belief_1_7), 2) as mean_belief
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateS} AND p.is_true = 0
    GROUP BY s.full_condition
  `).all(studyId);

  const beliefByCondTrue = db.prepare(`
    SELECT s.full_condition, ROUND(AVG(rt.belief_1_7), 2) as mean_belief
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateS} AND p.is_true = 1
    GROUP BY s.full_condition
  `).all(studyId);

  const recentSessions = db.prepare(`
    SELECT s.id, s.full_condition, s.age, s.residence, s.education, s.gender, s.completed_at, s.is_preview,
      ROUND(AVG(CASE WHEN p.is_true=0 THEN rt.belief_1_7 END), 2) as avg_belief_false
    FROM sessions s
    LEFT JOIN ratings rt ON rt.session_id = s.id
    LEFT JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1${previewS}${dateS}
    GROUP BY s.id
    ORDER BY s.completed_at DESC LIMIT 20
  `).all(studyId);

  // Eye-tracking stats (only if the study has it enabled)
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  let eyetracking_stats = null;
  if (study && study.eyetracking_enabled) {
    // consent=1: participant agreed (regardless of calibration quality)
    const etConsented = db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND eyetracking_consent = 1${previewNo}`
    ).get(studyId)?.n || 0;
    // consent=0: explicit refusal (participant clicked "nie wyrażam zgody")
    const etDeclined = db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND eyetracking_consent = 0${previewNo}`
    ).get(studyId)?.n || 0;
    // consent=1 but zero gaze points: agreed but calibration failed / no data recorded
    const tableExists2 = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='gaze_points'`
    ).get();
    const etCalibFailed = tableExists2 ? db.prepare(
      `SELECT COUNT(*) as n FROM sessions s
       WHERE s.study_id = ? AND s.eyetracking_consent = 1${previewS}
         AND NOT EXISTS (SELECT 1 FROM gaze_points g WHERE g.session_id = s.id)`
    ).get(studyId)?.n || 0 : 0;
    const etGazePts = tableExists2 ? db.prepare(
      `SELECT COUNT(*) as n FROM gaze_points g
       JOIN sessions s ON g.session_id = s.id WHERE s.study_id = ?${previewS}`
    ).get(studyId)?.n || 0 : 0;
    eyetracking_stats = { consented: etConsented, declined: etDeclined, calib_failed: etCalibFailed, gaze_points: etGazePts };
  }

  // Demographic questions configured for this study (used to render dynamic codebook UI)
  const dashboardDemoQs = db.prepare(
    'SELECT id, field_key, label, input_type, options, required, order_index FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(studyId).map(q => {
    let opts = [];
    try { opts = JSON.parse(q.options || '[]'); } catch {}
    return { ...q, options: opts };
  });

  // ── Widget engine: render configured widgets against current data ─────────
  // Load saved dashboard config (or generate smart defaults if none).
  const studyRow = db.prepare('SELECT dashboard_config_json FROM studies WHERE id = ?').get(studyId);
  let dashboardConfig = {};
  try { dashboardConfig = JSON.parse(studyRow?.dashboard_config_json || '{}'); } catch {}
  let widgetsConfig = Array.isArray(dashboardConfig.widgets) ? dashboardConfig.widgets : null;
  let isDefault = false;

  // Cross-filter: when researcher clicks a category in one widget, all OTHER
  // widgets re-render filtered to that subset. URL params look like
  // ?filter_full_condition=A-LOW&filter_gender=kobieta. We capture every
  // filter_* param into an object and apply it on the row set in JS (cheaper
  // than re-running SQL queries — same rows, smaller working set).
  const crossFilters = {};
  Object.entries(req.query || {}).forEach(([k, v]) => {
    if (k.startsWith('filter_') && v) crossFilters[k.slice(7)] = v;
  });

  let widgetCtx = null, widgetRows = [], widgetColumns = [];
  try {
    widgetCtx = buildExportContext(studyId, { includePreview });
    const ds = getDaneSuroweData(widgetCtx, { dateFrom, dateTo });
    widgetRows = ds.rows;
    widgetColumns = ds.columns;
    // Apply cross-filters in-memory if any are set
    if (Object.keys(crossFilters).length) {
      widgetRows = widgetRows.filter(r => Object.entries(crossFilters).every(([k, v]) => String(r[k]) === String(v)));
    }
  } catch (err) {
    // Study has no completed sessions yet, or other extraction error — widgets
    // will render with empty data; KPIs that read sessionMeta still work.
    widgetRows = []; widgetColumns = [];
  }

  // Load saved dashboard profiles too (mirror export profiles structure)
  let dashboardProfiles = {};
  try { dashboardProfiles = JSON.parse(db.prepare('SELECT dashboard_profiles_json FROM studies WHERE id = ?').get(studyId)?.dashboard_profiles_json || '{}'); } catch {}

  if (!widgetsConfig) {
    // No saved config → generate defaults from study schema. We pass
    // demoQuestions / postQuestions from ctx (already loaded by
    // buildExportContext) so defaults reflect the actual study.
    if (widgetCtx) {
      const defaults = generateDefaultDashboard(widgetCtx);
      widgetsConfig = defaults.widgets;
      isDefault = true;
    } else {
      widgetsConfig = [];
    }
  } else {
    // Self-heal widgets saved with the old wrapped format ({id, type, title,
    // config: {...}, data: {...}}). Unwrap the inner config so renderers
    // see the metric/columns at the top level where they expect them.
    widgetsConfig = widgetsConfig.map(w => {
      if (w && w.config && typeof w.config === 'object' && !w.metric && !w.group_var && !w.variable && !w.row_var) {
        return { ...w.config, id: w.id || w.config.id, title: w.title || w.config.title };
      }
      return w;
    });
  }

  const sessionMeta = {
    total_sessions: total,
    completed_sessions: completed,
    preview_count: previewCount,
    dropout_rate,
  };
  const renderedWidgets = widgetsConfig.map(w => renderWidget(w, widgetRows, widgetColumns, sessionMeta));

  // Column metadata (typed) — used by the dashboard edit-mode wizard to
  // populate variable pickers, same as the analyses tab. Header renames
  // from the export builder cascade here so the column the researcher
  // renamed in /export shows the same label in widget pickers and Analizy
  // (single source of truth for column labels across the app).
  let exportCfgForLabels = {};
  try { exportCfgForLabels = JSON.parse(db.prepare('SELECT export_config_json FROM studies WHERE id = ?').get(studyId)?.export_config_json || '{}'); } catch {}
  const withOverrides = applyHeaderOverrides(widgetColumns, exportCfgForLabels['Dane_surowe']);
  const columnsMeta = withOverrides.map(c => ({ key: c.key, header: c.header, type: c.type, group: c.group }));

  res.json({
    total_sessions: total,
    completed_sessions: completed,
    dropout_rate,
    conditions_completion: Object.fromEntries(condCompletion.map(r => [r.full_condition, r.count])),
    conditions_mean_belief_false: Object.fromEntries(beliefByCondFalse.map(r => [r.full_condition, r.mean_belief])),
    conditions_mean_belief_true: Object.fromEntries(beliefByCondTrue.map(r => [r.full_condition, r.mean_belief])),
    recent_sessions: recentSessions,
    eyetracking_stats,
    demographic_questions: dashboardDemoQs,
    preview_count: previewCount,                       // completed previews (in export + preview table)
    preview_count_incomplete: previewCountIncomplete,  // in-progress preview rows (junk)
    include_preview: includePreview,
    date_from: dateFrom,
    date_to: dateTo,
    cross_filters: crossFilters, // echo so UI can show active filter chips
    // New: widget engine output
    widgets: renderedWidgets,
    widgets_is_default: isDefault, // UI shows a "Customize" hint when true
    widget_columns: columnsMeta,    // for the edit-mode variable pickers
    profiles: dashboardProfiles,    // named saved arrangements (UI populates picker)
  });
});

// PUT save the dashboard's widget config. Body: { widgets: [...] }.
// Non-destructive — only writes studies.dashboard_config_json.
router.put('/dashboard/:studyId/config', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT id FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const { widgets } = req.body || {};
  if (!Array.isArray(widgets)) return res.status(400).json({ error: 'widgets array required' });
  // Ensure every widget has an id; assign one if missing
  const sanitized = widgets.map(w => ({
    ...w,
    id: w.id || Math.random().toString(36).slice(2, 10),
  }));
  db.prepare('UPDATE studies SET dashboard_config_json = ? WHERE id = ?')
    .run(JSON.stringify({ widgets: sanitized }), req.params.studyId);
  res.json({ ok: true, widgets: sanitized });
});

// DELETE reset dashboard to smart defaults (clears dashboard_config_json).
router.delete('/dashboard/:studyId/config', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  db.prepare('UPDATE studies SET dashboard_config_json = ? WHERE id = ?').run('{}', req.params.studyId);
  res.json({ ok: true });
});

// ── Dashboard saved profiles (named widget arrangements) ──────────────────
// Mirrors the export profiles pattern: snapshot current widgets as a named
// profile, switch between them without losing customization.

// GET list saved dashboard profiles
router.get('/dashboard/:studyId/profiles', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT dashboard_profiles_json FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  let profiles = {}; try { profiles = JSON.parse(study.dashboard_profiles_json || '{}'); } catch {}
  res.json(profiles);
});

// POST save current widgets as a named profile
router.post('/dashboard/:studyId/profiles', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT dashboard_profiles_json FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const { name, widgets } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(widgets)) return res.status(400).json({ error: 'widgets array required' });
  let profiles = {}; try { profiles = JSON.parse(study.dashboard_profiles_json || '{}'); } catch {}
  profiles[name.trim()] = { widgets };
  db.prepare('UPDATE studies SET dashboard_profiles_json = ? WHERE id = ?').run(JSON.stringify(profiles), req.params.studyId);
  res.json({ ok: true, name: name.trim() });
});

// DELETE remove a named profile
router.delete('/dashboard/:studyId/profiles/:name', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT dashboard_profiles_json FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  let profiles = {}; try { profiles = JSON.parse(study.dashboard_profiles_json || '{}'); } catch {}
  if (!profiles[req.params.name]) return res.status(404).json({ error: 'Profile not found' });
  delete profiles[req.params.name];
  db.prepare('UPDATE studies SET dashboard_profiles_json = ? WHERE id = ?').run(JSON.stringify(profiles), req.params.studyId);
  res.json({ ok: true });
});

// ── Public read-only share link ────────────────────────────────────────────
// Admin generates a JWT-signed token that grants READ-ONLY access to a
// study's dashboard. The token embeds study_id + a "scope:dashboard-readonly"
// claim so the public endpoint can validate and refuse anything else.
// Defaults to 30 days; admin can revoke by regenerating (old token still
// validates until expiry — that's a tradeoff for stateless tokens).
router.post('/studies/:studyId/share-link', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT id, slug FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const days = Math.max(1, Math.min(parseInt(req.body?.days, 10) || 30, 365));
  const shareToken = jwt.sign(
    { study_id: study.id, scope: 'dashboard-readonly' },
    JWT_SECRET,
    { expiresIn: `${days}d` },
  );
  res.json({ token: shareToken, expires_days: days, url: `/share/dashboard/${shareToken}` });
});

// Read-only dashboard endpoint hit by the public share page. Validates the
// token's scope before doing anything. Returns the SAME widget JSON shape as
// the auth'd dashboard endpoint so the same renderer can be reused.
router.get('/public/dashboard/:token', (req, res) => {
  let payload;
  try { payload = jwt.verify(req.params.token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired share link' }); }
  if (payload.scope !== 'dashboard-readonly' || !payload.study_id) {
    return res.status(403).json({ error: 'Token scope does not allow this' });
  }

  // Reuse the dashboard endpoint's render logic. Build a minimal req that
  // matches the shape the handler expects, then delegate. Simpler: inline
  // the widget bits from getDaneSuroweData + render here.
  const studyId = payload.study_id;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  const includePreview = false; // read-only never shows preview sessions
  const dateFromRaw = req.query.date_from || null;
  const dateToRaw   = req.query.date_to   || null;
  const dateFrom = dateFromRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateFromRaw) ? dateFromRaw : null;
  const dateTo   = dateToRaw   && /^\d{4}-\d{2}-\d{2}$/.test(dateToRaw)   ? dateToRaw   : null;

  let widgetRows = [], widgetColumns = [];
  try {
    const ctx = buildExportContext(studyId, { includePreview });
    const ds = getDaneSuroweData(ctx, { dateFrom, dateTo });
    widgetRows = ds.rows; widgetColumns = ds.columns;
  } catch {}

  let cfg = {}; try { cfg = JSON.parse(study.dashboard_config_json || '{}'); } catch {}
  const widgets = Array.isArray(cfg.widgets) ? cfg.widgets : [];
  // Session-meta KPIs need their own counts even in read-only mode
  const sessionMeta = {
    total_sessions:     db.prepare('SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND is_preview = 0').get(studyId)?.n || 0,
    completed_sessions: db.prepare('SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND is_preview = 0 AND completed = 1').get(studyId)?.n || 0,
    preview_count: 0,
    dropout_rate: 0,
  };
  sessionMeta.dropout_rate = sessionMeta.total_sessions > 0
    ? Math.round(((sessionMeta.total_sessions - sessionMeta.completed_sessions) / sessionMeta.total_sessions) * 10000) / 100 : 0;

  const renderedWidgets = widgets.map(w => renderWidget(w, widgetRows, widgetColumns, sessionMeta));
  res.json({
    study_name: study.name,
    study_slug: study.slug,
    completed_sessions: sessionMeta.completed_sessions,
    total_sessions: sessionMeta.total_sessions,
    dropout_rate: sessionMeta.dropout_rate,
    widgets: renderedWidgets,
    date_from: dateFrom, date_to: dateTo,
    expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
  });
});

// Delete every preview session for a study (and its cascaded reactions /
// ratings / post_question_responses / gaze_points). Production sessions
// stay untouched. Requires explicit confirmation in the body.
router.post('/studies/:id/preview-sessions/delete', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required: send {confirm: "DELETE"}' });
  }
  const { id } = req.params;
  const sessionIds = db.prepare('SELECT id FROM sessions WHERE study_id = ? AND is_preview = 1').all(id).map(r => r.id);
  if (!sessionIds.length) return res.json({ ok: true, deleted: 0 });
  // Delete child rows explicitly so we don't rely on PRAGMA foreign_keys being on
  const ph = sessionIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM reactions WHERE session_id IN (${ph})`).run(...sessionIds);
  db.prepare(`DELETE FROM ratings WHERE session_id IN (${ph})`).run(...sessionIds);
  db.prepare(`DELETE FROM post_question_responses WHERE session_id IN (${ph})`).run(...sessionIds);
  // gaze_points may not exist on old deployments — guard with table check
  const gazeTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='gaze_points'`).get();
  if (gazeTable) db.prepare(`DELETE FROM gaze_points WHERE session_id IN (${ph})`).run(...sessionIds);
  const info = db.prepare(`DELETE FROM sessions WHERE id IN (${ph})`).run(...sessionIds);
  res.json({ ok: true, deleted: info.changes });
});

// ── Export ────────────────────────────────────────────────────────────────────
router.get('/export/:studyId', auth, async (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  try {
    const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
    if (!study) return res.status(404).json({ error: 'Study not found' });

    // Optional ?lang=pl|en|cs|sk — pick which language the export should be in.
    // Defaults to the study's own language. Only languages that actually have a
    // translation (or the canonical PL) are accepted; everything else falls back.
    const validLangs = new Set(['pl', 'en', 'cs', 'sk']);
    const requestedLang = req.query.lang && validLangs.has(req.query.lang) ? req.query.lang : null;
    const includePreview = req.query.include_preview === '1' || req.query.include_preview === 'true';
    const wb = await generateExcel(req.params.studyId, { lang: requestedLang, includePreview });
    const date = new Date().toISOString().slice(0, 10);
    // Include language + "preview" markers in filename when explicitly chosen so
    // the researcher can keep PL, CS, and preview-inclusive exports side by side
    // without overwriting each other.
    const langSuffix = requestedLang && requestedLang !== (study.language || 'pl')
      ? `_${requestedLang}`
      : '';
    const previewSuffix = includePreview ? '_with-preview' : '';
    const filename = `${study.slug}${langSuffix}${previewSuffix}_${date}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Export builder: preview / config / profiles / CSV ──────────────────────
// All endpoints here are non-destructive — they only read sessions and write
// to the studies.export_config_json / studies.export_profiles_json columns.

// GET preview JSON of a sheet, with default + current column model + a
// row sample (default limit 20). The UI uses this to render the inline
// builder table without forcing an xlsx round-trip.
router.get('/export/:studyId/preview', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  try {
    const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
    if (!study) return res.status(404).json({ error: 'Study not found' });
    const sheet = req.query.sheet || 'Dane_surowe';
    const validLangs = new Set(['pl', 'en', 'cs', 'sk']);
    const lang = req.query.lang && validLangs.has(req.query.lang) ? req.query.lang : null;
    const includePreview = req.query.include_preview === '1' || req.query.include_preview === 'true';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 200));

    // Only Dane_surowe is wired through the new data layer in this iteration
    if (sheet !== 'Dane_surowe') return res.status(400).json({ error: `Sheet "${sheet}" not yet builder-enabled` });

    const ctx = buildExportContext(req.params.studyId, { lang, includePreview });
    const { columns: defaultColumns, rows } = getDaneSuroweData(ctx, { limit });

    let exportConfig = {}; try { exportConfig = JSON.parse(study.export_config_json || '{}'); } catch {}
    let profiles    = {}; try { profiles    = JSON.parse(study.export_profiles_json || '{}'); } catch {}

    res.json({
      sheet,
      // Three flavors of column metadata, each for a different consumer:
      //  - default_columns: untouched defaults (export builder UI shows
      //    these + lets the researcher diff against their config).
      //  - labeled_columns: same shape + order as defaults, but with header
      //    renames from export_config_json applied. Consumed by the Analizy
      //    tab + dashboard widget pickers so a renamed column shows the
      //    friendly label everywhere — single source of truth for labels.
      //  - effective_columns: full export-config apply (rename + reorder +
      //    hide). What the actual xlsx/CSV download uses.
      default_columns: defaultColumns,
      labeled_columns: applyHeaderOverrides(defaultColumns, exportConfig[sheet]),
      current_config: exportConfig[sheet] || null,
      effective_columns: applyExportConfig(defaultColumns, exportConfig[sheet]),
      rows,
      total_rows_estimate: null, // could be wired up with a COUNT if needed
      profiles,
      lang: ctx.requestedLang,
      include_preview: includePreview,
    });
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT save current working config for a sheet (the "live" arrangement, not
// a named profile). Body: { sheet: 'Dane_surowe', config: { columns: [...] } }
router.put('/export/:studyId/config', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const { sheet, config } = req.body || {};
  if (!sheet) return res.status(400).json({ error: 'sheet required' });
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });

  let all = {}; try { all = JSON.parse(study.export_config_json || '{}'); } catch {}
  all[sheet] = config;
  db.prepare('UPDATE studies SET export_config_json = ? WHERE id = ?')
    .run(JSON.stringify(all), req.params.studyId);
  res.json({ ok: true, sheet, config });
});

// POST save the current working config as a NAMED profile that can be
// reapplied later. Body: { name, sheet, config }
router.post('/export/:studyId/profiles', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const { name, sheet, config } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!sheet) return res.status(400).json({ error: 'sheet required' });
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });

  let profiles = {}; try { profiles = JSON.parse(study.export_profiles_json || '{}'); } catch {}
  profiles[name] = profiles[name] || {};
  profiles[name][sheet] = config;
  db.prepare('UPDATE studies SET export_profiles_json = ? WHERE id = ?')
    .run(JSON.stringify(profiles), req.params.studyId);
  res.json({ ok: true, name, sheet });
});

// DELETE a named profile (does not touch the live working config).
router.delete('/export/:studyId/profiles/:name', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  let profiles = {}; try { profiles = JSON.parse(study.export_profiles_json || '{}'); } catch {}
  if (!profiles[req.params.name]) return res.status(404).json({ error: 'Profile not found' });
  delete profiles[req.params.name];
  db.prepare('UPDATE studies SET export_profiles_json = ? WHERE id = ?')
    .run(JSON.stringify(profiles), req.params.studyId);
  res.json({ ok: true, deleted: req.params.name });
});

// CSV alternative to the xlsx export — same column model, so any builder
// customization (rename / reorder / hide) carries over.
router.get('/export/:studyId/csv', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  try {
    const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
    if (!study) return res.status(404).json({ error: 'Study not found' });
    const validLangs = new Set(['pl', 'en', 'cs', 'sk']);
    const lang = req.query.lang && validLangs.has(req.query.lang) ? req.query.lang : null;
    const includePreview = req.query.include_preview === '1' || req.query.include_preview === 'true';
    const sheet = req.query.sheet || 'Dane_surowe';
    if (sheet !== 'Dane_surowe') return res.status(400).json({ error: `Sheet "${sheet}" not yet builder-enabled for CSV` });

    const ctx = buildExportContext(req.params.studyId, { lang, includePreview });
    const { columns: defaultCols, rows } = getDaneSuroweData(ctx);
    let exportConfig = {}; try { exportConfig = JSON.parse(study.export_config_json || '{}'); } catch {}
    const finalCols = applyExportConfig(defaultCols, exportConfig[sheet]);

    const date = new Date().toISOString().slice(0, 10);
    const langSuffix = lang && lang !== (study.language || 'pl') ? `_${lang}` : '';
    const previewSuffix = includePreview ? '_with-preview' : '';
    const filename = `${study.slug}${langSuffix}${previewSuffix}_${date}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM so Excel opens UTF-8 correctly without prompting
    res.write('﻿');
    res.end(rowsToCsv(finalCols, rows));
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Statistical analyses ───────────────────────────────────────────────────
// "Quick-look helper" stats engine — runs descriptives + the common
// inferential tests against current session data. Each request is recomputed
// from scratch (no caching) so results always reflect the latest sessions.
// Saved analyses are templates (test type + variable picks), not result
// snapshots, so they re-run automatically as new sessions come in.

// Helper: extract a column of values for a stats test from the Dane_surowe
// data layer. `groupKey` (optional) splits rows by that column's value.
function extractColumn(rows, columnKey) {
  return rows.map(r => r[columnKey]).filter(v => v != null && v !== '');
}
function splitByGroup(rows, valueKey, groupKey) {
  const buckets = {};
  rows.forEach(r => {
    const g = r[groupKey];
    if (g == null || g === '') return;
    const v = r[valueKey];
    if (v == null || v === '') return;
    (buckets[g] ||= []).push(v);
  });
  return buckets;
}

// POST run an analysis right now and return the result. Body shape:
// { test: 't_test'|'anova'|'chi_square'|'correlation'|'correlation_matrix'|
//         'regression'|'cronbach_alpha'|'descriptives',
//   params: { ... test-specific ... },
//   options: { lang, include_preview }  // same opts as preview/export
// }
router.post('/studies/:studyId/analyze', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  try {
    const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
    if (!study) return res.status(404).json({ error: 'Study not found' });
    const { test, params = {}, options = {} } = req.body || {};
    if (!test) return res.status(400).json({ error: 'test required' });

    // Pull current Dane_surowe data so the test sees what the export sees
    const ctx = buildExportContext(req.params.studyId, {
      lang: options.lang || null,
      includePreview: options.includePreview === true,
    });
    const { rows, columns } = getDaneSuroweData(ctx);

    let result;
    switch (test) {
      case 'descriptives': {
        if (!params.variable) return res.status(400).json({ error: 'params.variable required' });
        result = stats.runDescriptives(extractColumn(rows, params.variable));
        break;
      }
      case 't_test': {
        if (!params.variable) return res.status(400).json({ error: 'params.variable required' });
        if (params.paired) {
          // Paired: variable + variable2 (same number of rows, value pairs)
          if (!params.variable2) return res.status(400).json({ error: 'params.variable2 required for paired t-test' });
          const a = rows.map(r => r[params.variable]);
          const b = rows.map(r => r[params.variable2]);
          result = stats.runTTest(a, b, { paired: true });
        } else {
          // Independent: variable + group_variable (binary grouping; pick first 2 groups)
          if (!params.group_variable) return res.status(400).json({ error: 'params.group_variable required for independent t-test' });
          const buckets = splitByGroup(rows, params.variable, params.group_variable);
          const keys = Object.keys(buckets);
          if (keys.length < 2) return res.status(400).json({ error: 'Need at least 2 groups in data' });
          if (keys.length > 2) {
            return res.status(400).json({
              error: `Zmienna grupująca "${params.group_variable}" ma ${keys.length} grup. Test t porównuje 2 grupy — użyj ANOVA dla 3+. Możesz też podać params.group_a i params.group_b żeby wybrać dwie konkretne grupy.`,
            });
          }
          const ga = params.group_a || keys[0];
          const gb = params.group_b || keys[1];
          result = stats.runTTest(buckets[ga], buckets[gb], { paired: false });
          if (result.group1 && result.group2) {
            result.group1.label = String(ga);
            result.group2.label = String(gb);
          }
        }
        break;
      }
      case 'anova': {
        if (!params.variable || !params.group_variable) return res.status(400).json({ error: 'params.variable + params.group_variable required' });
        const buckets = splitByGroup(rows, params.variable, params.group_variable);
        const labels = Object.keys(buckets).sort();
        if (labels.length < 2) return res.status(400).json({ error: 'Need at least 2 groups in data' });
        result = stats.runOneWayAnova(labels.map(l => buckets[l]), { labels });
        break;
      }
      case 'chi_square': {
        if (!params.row_variable || !params.col_variable) return res.status(400).json({ error: 'params.row_variable + params.col_variable required' });
        // Build contingency table from two categorical columns
        const rowVals = [...new Set(rows.map(r => r[params.row_variable]).filter(v => v != null && v !== ''))].sort();
        const colVals = [...new Set(rows.map(r => r[params.col_variable]).filter(v => v != null && v !== ''))].sort();
        if (rowVals.length < 2 || colVals.length < 2) return res.status(400).json({ error: 'Każda zmienna musi mieć ≥2 kategorie.' });
        const observed = rowVals.map(rv => colVals.map(cv =>
          rows.filter(r => r[params.row_variable] === rv && r[params.col_variable] === cv).length
        ));
        result = stats.runChiSquareIndependence(observed);
        result.row_categories = rowVals;
        result.col_categories = colVals;
        result.observed = observed;
        break;
      }
      case 'correlation': {
        if (!params.variable_x || !params.variable_y) return res.status(400).json({ error: 'params.variable_x + params.variable_y required' });
        const x = rows.map(r => r[params.variable_x]);
        const y = rows.map(r => r[params.variable_y]);
        result = stats.runCorrelation(x, y, { method: params.method === 'spearman' ? 'spearman' : 'pearson' });
        break;
      }
      case 'correlation_matrix': {
        if (!Array.isArray(params.variables) || params.variables.length < 2) return res.status(400).json({ error: 'params.variables (array of column keys, ≥2) required' });
        const vars = params.variables.map(k => ({ name: k, values: rows.map(r => r[k]) }));
        result = stats.runCorrelationMatrix(vars);
        break;
      }
      case 'regression': {
        if (!params.variable_x || !params.variable_y) return res.status(400).json({ error: 'params.variable_x + params.variable_y required' });
        result = stats.runLinearRegression(
          rows.map(r => r[params.variable_x]),
          rows.map(r => r[params.variable_y]),
        );
        break;
      }
      case 'cronbach_alpha': {
        if (!Array.isArray(params.items) || params.items.length < 2) return res.status(400).json({ error: 'params.items (array of column keys, ≥2) required' });
        const items = params.items.map(k => rows.map(r => r[k]));
        result = stats.runCronbachAlpha(items);
        result.item_names = params.items;
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown test: ${test}. Supported: descriptives, t_test, anova, chi_square, correlation, correlation_matrix, regression, cronbach_alpha.` });
    }

    // Surface metadata so the UI can show context next to the result
    res.json({
      test, params, options,
      n_total: rows.length,
      result,
      // Echo back the column metadata so UI can show type badges / labels
      columns_used: (() => {
        const used = new Set();
        ['variable', 'variable2', 'group_variable', 'row_variable', 'col_variable', 'variable_x', 'variable_y'].forEach(k => {
          if (params[k]) used.add(params[k]);
        });
        (params.variables || []).forEach(k => used.add(k));
        (params.items || []).forEach(k => used.add(k));
        return [...used].map(k => columns.find(c => c.key === k)).filter(Boolean);
      })(),
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET list saved analyses for a study
router.get('/studies/:studyId/analyses', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT analyses_json FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  let analyses = [];
  try { analyses = JSON.parse(study.analyses_json || '[]'); } catch {}
  res.json(analyses);
});

// POST save an analysis as a named template (test + params only — re-runs against current data on load)
router.post('/studies/:studyId/analyses', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT analyses_json FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  const { name, test, params = {} } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!test) return res.status(400).json({ error: 'test required' });
  let analyses = []; try { analyses = JSON.parse(study.analyses_json || '[]'); } catch {}
  const id = Math.random().toString(36).slice(2, 10);
  analyses.push({ id, name: name.trim(), test, params, created_at: new Date().toISOString() });
  db.prepare('UPDATE studies SET analyses_json = ? WHERE id = ?').run(JSON.stringify(analyses), req.params.studyId);
  res.json({ ok: true, id });
});

// DELETE a saved analysis
router.delete('/studies/:studyId/analyses/:id', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT analyses_json FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });
  let analyses = []; try { analyses = JSON.parse(study.analyses_json || '[]'); } catch {}
  const before = analyses.length;
  analyses = analyses.filter(a => a.id !== req.params.id);
  if (analyses.length === before) return res.status(404).json({ error: 'Analysis not found' });
  db.prepare('UPDATE studies SET analyses_json = ? WHERE id = ?').run(JSON.stringify(analyses), req.params.studyId);
  res.json({ ok: true });
});

// ── Gaze CSV ──────────────────────────────────────────────────────────────────
router.get('/gaze-csv/:studyId', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  const rows = db.prepare(`
    SELECT g.session_id, s.session_token, s.full_condition,
           g.post_id, g.post_order, g.screen_name, g.t,
           g.x, g.y, g.vw, g.vh, g.scroll_y, g.aoi
    FROM gaze_points g
    JOIN sessions s ON g.session_id = s.id
    WHERE s.study_id = ?
    ORDER BY g.session_id, g.t
  `).all(req.params.studyId);

  const header = 'session_id,session_token,full_condition,post_id,post_order,screen_name,t,x,y,vw,vh,scroll_y,aoi';
  const csv = [
    header,
    ...rows.map(r => [
      r.session_id, r.session_token, r.full_condition ?? '',
      r.post_id ?? '', r.post_order ?? '', r.screen_name ?? '',
      r.t, r.x, r.y, r.vw ?? '', r.vh ?? '', r.scroll_y ?? '', r.aoi ?? '',
    ].join(',')),
  ].join('\n');

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${study.slug}_gaze_${date}.csv"`);
  res.send(csv);
});

// ── Eye-tracking viewer API ────────────────────────────────────────────────

// Sessions with gaze data for a study
router.get('/gaze-sessions/:studyId', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.studyId)) return;
  const studyId = parseInt(req.params.studyId);
  try {
    // Check if gaze_points table exists first
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='gaze_points'`
    ).get();
    if (!tableExists) return res.json([]);

    const sessions = db.prepare(`
      SELECT s.id, s.session_token, s.full_condition, s.style_condition, s.metric_condition,
             s.eyetracking_consent, s.calibration_error, s.n_recalibrations,
             s.started_at, s.completed_at,
             COUNT(g.id) as n_gaze_pts
      FROM sessions s
      LEFT JOIN gaze_points g ON g.session_id = s.id
      WHERE s.study_id = ? AND s.eyetracking_consent = 1
      GROUP BY s.id
      ORDER BY s.started_at DESC
    `).all(studyId);
    res.json(sessions);
  } catch (err) {
    console.error('gaze-sessions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full gaze data for one session
// Debug: dump RAW sessions row for a given id so the researcher can
// cross-check what the DB actually stores against what the export emits.
// Researcher hit a "admin shows age=98 but export shows age=52" mismatch;
// without DB shell access this endpoint is the diagnostic surface. Returns
// every column on the sessions row + parsed demographics_extra_json. The
// :auth middleware is the only gate — same protection as the rest of the
// admin panel. Safe to leave in (read-only, single row, requires login).
router.get('/session-debug/:sessionId', auth, (req, res) => {
  if (!ownedBySession(req, res, req.params.sessionId)) return;
  const id = parseInt(req.params.sessionId, 10);
  if (!id) return res.status(400).json({ error: 'Bad session id' });
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  let extra = null;
  try { extra = row.demographics_extra_json ? JSON.parse(row.demographics_extra_json) : null; } catch (e) { extra = { _parse_error: String(e) }; }
  res.json({
    session: row,
    demographics_extra_parsed: extra,
    legacy_demographics: {
      age: row.age,
      residence: row.residence,
      education: row.education,
      gender: row.gender,
    },
    types: {
      age: typeof row.age,
      residence: typeof row.residence,
      education: typeof row.education,
      gender: typeof row.gender,
    },
  });
});

// Full gaze data for one session
router.get('/gaze-data/:sessionId', auth, (req, res) => {
  if (!ownedBySession(req, res, req.params.sessionId)) return;
  const sessionId = parseInt(req.params.sessionId);
  try {
  const session = db.prepare(`
    SELECT s.*, st.name as study_name, st.slug as study_slug
    FROM sessions s
    JOIN studies st ON s.study_id = st.id
    WHERE s.id = ?
  `).get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='gaze_points'`
  ).get();
  const gaze = tableExists ? db.prepare(`
    SELECT post_id, post_order, screen_name, t, x, y, vw, vh, scroll_y, aoi
    FROM gaze_points WHERE session_id = ? ORDER BY t
  `).all(sessionId) : [];

  const postIds = [...new Set(gaze.filter(g => g.post_id != null).map(g => g.post_id))];
  let posts = [];
  if (postIds.length) {
    const ph = postIds.map(() => '?').join(',');
    posts = db.prepare(
      `SELECT id, order_index as post_order, topic, is_true,
              COALESCE(headline_a, headline_b, source_name, '') as headline,
              source_name as author_name
       FROM posts WHERE id IN (${ph})`
    ).all(...postIds);
  }

  let feedSnapshot = null;
  try { if (session.feed_snapshot) feedSnapshot = JSON.parse(session.feed_snapshot); } catch (_) {}

  res.json({ session, gaze, posts, feedSnapshot });
  } catch (err) {
    console.error('gaze-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /studies/:id/translate ───────────────────────────────────────────────
router.post('/studies/:id/translate', auth, async (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const { target_language } = req.body;
  const SUPPORTED_LANGUAGES = ['en', 'cs', 'sk'];
  if (!SUPPORTED_LANGUAGES.includes(target_language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }

  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.id);
  if (!study) return res.status(404).json({ error: 'Not found' });

  // Get demographic questions for this study
  const demoQuestions = db.prepare(
    'SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(req.params.id);

  // Get active posts for this study
  const posts = db.prepare(
    'SELECT * FROM posts WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(req.params.id);

  // Post questions (builder studies)
  const postQuestionsRaw = db.prepare(
    'SELECT * FROM post_questions WHERE study_id = ? AND is_active = 1 ORDER BY part_id, order_index'
  ).all(req.params.id);

  // Parts (label + transition_text)
  let studyParts = [];
  try { studyParts = JSON.parse(study.parts_json || '[]'); } catch {}

  // Fields to translate — split into two payloads to stay within max_tokens
  const studyFieldsToTranslate = {
    participant_title: study.participant_title || study.name || '',
    consent_text: study.consent_text || db.DEFAULT_CONSENT_TEXT,
    no_consent_text: study.no_consent_text || '',
    instruction_text: study.instruction_text || db.DEFAULT_INSTRUCTION_TEXT,
    transition_feed_text: study.transition_feed_text || db.DEFAULT_TRANSITION_FEED_TEXT,
    transition_rating_text: study.transition_rating_text || db.DEFAULT_TRANSITION_RATING_TEXT,
    debrief_text: study.debrief_text || db.DEFAULT_DEBRIEF_TEXT,
    // Fallbacks read from pl.json baseline at boot (db.STUDY_LABEL_DEFAULTS).
    // Used as source text for the AI translation pipeline when the study
    // hasn't been customised. Zero hardcoded Polish here — locale file is
    // the single source of truth.
    label_likert_question: study.label_likert_question || db.STUDY_LABEL_DEFAULTS.label_likert_question,
    label_likert_min:      study.label_likert_min      || db.STUDY_LABEL_DEFAULTS.label_likert_min,
    label_likert_max:      study.label_likert_max      || db.STUDY_LABEL_DEFAULTS.label_likert_max,
    label_action_like:     study.label_action_like     || db.STUDY_LABEL_DEFAULTS.label_action_like,
    label_action_dislike:  study.label_action_dislike  || db.STUDY_LABEL_DEFAULTS.label_action_dislike,
    label_action_share:    study.label_action_share    || db.STUDY_LABEL_DEFAULTS.label_action_share,
    label_action_flag:     study.label_action_flag     || db.STUDY_LABEL_DEFAULTS.label_action_flag,
    comment_placeholder:   study.comment_placeholder   || db.STUDY_LABEL_DEFAULTS.comment_placeholder,
    demographic_questions: demoQuestions.map(q => ({
      id: q.id,
      label: q.label,
      options: (() => { try { return JSON.parse(q.options); } catch { return []; } })()
    })),
    post_questions: postQuestionsRaw.map(q => {
      // Parse options_json. For choice questions it's an array; for Likert it's an object.
      let opts = null;
      try { opts = JSON.parse(q.options_json || '[]'); } catch {}
      return {
        id: q.id,
        label: q.label,
        question_type: q.question_type,
        // For choice questions: array of {label, value}; for Likert: {label_min, label_max, description}
        options: opts,
      };
    }),
    parts: studyParts.map((p, idx) => ({
      id: p.id || `part-${idx}`,
      label: p.label || '',
      transition_text: p.transition_text || '',
      pq_title:    p.pq_title    || '',
      pq_subtitle: p.pq_subtitle || '',
    })),
  };

  const postsToTranslate = posts.map(p => ({
    id: p.id,
    headline_a: p.headline_a || '',
    content_a: p.content_a || '',
    headline_b: p.headline_b || '',
    content_b: p.content_b || '',
    topic: p.topic || '',
    time_ago: p.time_ago || '',
    post_comment: p.post_comment || '',
    post_comment_author: p.post_comment_author || '',
  }));

  const langNames = { en: 'English', cs: 'Czech', sk: 'Slovak', pl: 'Polish' };

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── Call 1: study-level content ──────────────────────────────────────────
    const response1 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `You are translating a research study interface from Polish to ${langNames[target_language]}.

Translate ALL text values in this JSON. Keep keys exactly the same.
For demographic_questions: translate "label" and each option's "label" field, keep "value" and "id" fields unchanged.
For post_questions: translate "label". For choice questions ("single"/"multi"), translate each option's "label" field, keep "value" unchanged. For "likert" type the options object has "label_min", "label_max", "description" — translate those text values, keep "scale" (number) unchanged. Keep "id" and "question_type" unchanged.
For parts: translate "label", "transition_text", "pq_title", and "pq_subtitle". Keep "id" unchanged.
For empty strings (""), keep them empty.
Return ONLY valid JSON.

${JSON.stringify(studyFieldsToTranslate, null, 2)}`
      }]
    });

    let rawText1 = response1.content[0].text.trim();
    const fence1 = rawText1.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence1) rawText1 = fence1[1];
    const studyFieldTranslations = JSON.parse(rawText1);

    // ── Call 2: posts only ───────────────────────────────────────────────────
    let postsTranslationArray = postsToTranslate; // fallback: keep originals
    try {
      const response2 = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: `You are translating research study posts from Polish to ${langNames[target_language]}.

For each post object: translate headline_a, content_a, headline_b, content_b, topic, time_ago (e.g. "5h"→"5h", "teraz"→"now", "2 dni temu"→"2 days ago"), post_comment, post_comment_author. Keep "id" exactly as-is (number). Keep empty strings ("") empty.
Return ONLY valid JSON array (same structure, just translated values).

${JSON.stringify(postsToTranslate, null, 2)}`
        }]
      });

      let rawPostsText = response2.content[0].text.trim();
      const fence2 = rawPostsText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (fence2) rawPostsText = fence2[1];
      postsTranslationArray = JSON.parse(rawPostsText);
    } catch (postsErr) {
      console.error('Posts translation error (non-fatal):', postsErr);
    }

    // Merge results
    const translated = { ...studyFieldTranslations, posts: postsTranslationArray };

    // Save translations to study's translations_json
    let existing = {};
    try { existing = JSON.parse(study.translations_json || '{}'); } catch {}
    existing[target_language] = translated;

    db.prepare('UPDATE studies SET translations_json = ?, language = ? WHERE id = ?')
      .run(JSON.stringify(existing), target_language, req.params.id);

    res.json({ ok: true, language: target_language, translations: translated });
  } catch (err) {
    console.error('Translation error:', err);
    const msg = err.message?.includes('authentication') || err.message?.includes('API key') || err.message?.includes('apiKey')
      ? 'Brak klucza API Anthropic. Dodaj zmienną środowiskową ANTHROPIC_API_KEY w ustawieniach serwera (Railway → Variables).'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

// ── Builder study creation ────────────────────────────────────────────────────
router.post('/studies/builder', auth, (req, res) => {
  const slug = uniqueSlug('nowe-badanie');
  const info = db.prepare(`
    INSERT INTO studies (name, slug, builder_mode, is_active,
      enable_condition_a, enable_condition_b, metric_conditions_json, posts_per_session, owner_id)
    VALUES (?, ?, 1, 0, 1, 0, ?, 5, ?)
  `).run('Nowe badanie', slug, JSON.stringify([
    { key: 'STANDARD', label: 'Standard', min: 0, max: 0, enabled: true, show_comment: false }
  ]), req.user.userId);
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(info.lastInsertRowid);
  res.json(study);
});

// ── Builder state save ────────────────────────────────────────────────────────
router.patch('/studies/:id/builder', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const { id } = req.params;
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!study) return res.status(404).json({ error: 'Not found' });

  const allowed = ['name', 'slug', 'description', 'language', 'layout_type',
    'parts_json', 'logic_json', 'no_consent_text',
    'consent_text', 'instruction_text', 'debrief_text',
    'transition_feed_text', 'transition_rating_text',
    'show_instructions', 'show_transition_feed', 'show_transition_rating', 'show_debrief', 'show_debrief_posts',
    'show_instruction_actions', 'show_avatars', 'show_demographics', 'demographics_position',
    'enable_comments', 'allow_multi_reactions',
    'clarity_enabled', 'clarity_project_id',
    'eyetracking_enabled',
    // Panel-recruitment integration — see allowlist in PATCH /studies/:id.
    'external_id_param_name', 'completion_redirect_url',
    'completion_redirect_delay_seconds', 'completion_redirect_notice',
    'decline_redirect_url',
    'decline_redirect_delay_seconds', 'decline_redirect_notice',
    'decline_redirect_immediate',
    // Per-study custom hostname binding — see PATCH /studies/:id.
    'custom_domain',
    'is_active', 'participant_title',
    'enable_condition_a', 'enable_condition_b',
    'metric_conditions_json', 'posts_per_session',
    'post_questions_display_mode', 'manipulation_field', 'manipulation_variants', 'manipulation_json'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  // Validate conditional-logic rules before persisting — block dangling part/
  // question references, duplicate ids and malformed rules (shared pure engine
  // in lib/logic.js). Rejected saves return 400 with human-readable errors.
  if (updates.logic_json !== undefined) {
    const logicLib = require('../lib/logic');
    let logic = updates.logic_json;
    if (typeof logic === 'string') {
      try { logic = JSON.parse(logic || 'null'); }
      catch { return res.status(400).json({ error: 'logic_json: nieprawidłowy JSON' }); }
    }
    let partsForRefs = [];
    try {
      const rawParts = updates.parts_json !== undefined
        ? (typeof updates.parts_json === 'string' ? updates.parts_json : JSON.stringify(updates.parts_json))
        : study.parts_json;
      partsForRefs = JSON.parse(rawParts || '[]');
    } catch {}
    const refs = {
      partIds: (Array.isArray(partsForRefs) ? partsForRefs : []).map(p => p && p.id).filter(Boolean),
      questionIds: db.prepare('SELECT id FROM post_questions WHERE study_id = ?').all(id).map(r => r.id),
      demoFieldKeys: db.prepare('SELECT field_key FROM demographic_questions WHERE study_id = ?').all(id).map(r => r.field_key),
    };
    const vr = logicLib.validateLogic(logic, refs);
    if (!vr.valid) {
      return res.status(400).json({ error: 'Nieprawidłowe reguły logiki warunkowej:\n• ' + vr.errors.join('\n• '), logic_errors: vr.errors, logic_warnings: vr.warnings });
    }
    updates.logic_json = (logic == null) ? null : JSON.stringify(logic);
  }

  if (Object.keys(updates).length) {
    const lang = updates.language || study.language || 'pl';
    if (lang !== 'pl') {
      const transFields = ['consent_text', 'instruction_text', 'debrief_text',
        'transition_feed_text', 'transition_rating_text', 'participant_title', 'no_consent_text'];
      const transUpdates = {};
      transFields.forEach(f => {
        if (updates[f] !== undefined) { transUpdates[f] = updates[f]; delete updates[f]; }
      });
      // parts_json — nested overlay per part. Same problem as posts /
      // demographic_questions but the structure lives inside studies.parts_json
      // as an array of part objects with their own `id`. Translatable fields
      // per part: label, transition_text, pq_title, pq_subtitle (matches the
      // runtime overlay in routes/participant.js). Structural part fields
      // (id, layout, max_seconds, require_interaction, show_reactions,
      // requirements, transition_emoji) stay in the DB parts_json column —
      // they aren't user-visible strings or they're identifiers/numbers.
      let partsOverlayUpdates = null;
      if (updates.parts_json !== undefined) {
        let incomingParts = [];
        try { incomingParts = typeof updates.parts_json === 'string' ? JSON.parse(updates.parts_json) : updates.parts_json; } catch {}
        if (Array.isArray(incomingParts)) {
          // Strip translatable fields from each part for the DB write —
          // load the existing parts_json structure so we can preserve the
          // Polish source labels there. If this is the first time saving
          // a CS/SK clone, the DB parts_json IS the Polish source.
          let dbParts = [];
          try { dbParts = JSON.parse(study.parts_json || '[]'); } catch {}
          const dbPartMap = {};
          dbParts.forEach(p => { dbPartMap[String(p.id)] = p; });
          // Fix A: load the CURRENT overlay parts so a save can never
          // overwrite a good CS/SK translation with the Polish source.
          let curOverlayParts = [];
          try { curOverlayParts = (JSON.parse(study.translations_json || '{}')[lang] || {}).parts || []; } catch {}
          const curOverlayMap = {};
          if (Array.isArray(curOverlayParts)) curOverlayParts.forEach(p => { curOverlayMap[String(p.id)] = p; });
          const partsTranslated = [];
          const cleanedParts = incomingParts.map(part => {
            const dbPart = dbPartMap[String(part.id)] || {};
            const curOv  = curOverlayMap[String(part.id)] || {};
            // Extract translatable fields for the overlay — with the Fix A
            // guard. The builder sends the WHOLE parts array every save, so
            // an incoming value can be either a genuine edit OR just the
            // source text the editor happened to display (e.g. an untranslated
            // field, or a transient where the overlay wasn't applied). Baking
            // that source into the overlay corrupts the translation (the
            // SK→Polish reversion). Rule:
            //   • incoming differs from the Polish source → genuine value
            //     (incl. an intentional "" clear) → write it to the overlay.
            //   • incoming EQUALS the source → editor was showing source →
            //     DO NOT overwrite; preserve the existing overlay translation
            //     if one exists, else leave the field unregistered.
            const trEntry = { id: part.id };
            ['label', 'transition_text', 'pq_title', 'pq_subtitle'].forEach(f => {
              if (part[f] === undefined) return;
              const incoming = part[f];
              const source   = dbPart[f];
              if (incoming !== source) {
                trEntry[f] = incoming;                 // real translation / edit
              } else if (curOv[f] != null) {
                trEntry[f] = curOv[f];                 // keep existing translation
              }
              // else: incoming == source, no existing overlay → don't register
              // the Polish source as a "translation".
            });
            if (Object.keys(trEntry).length > 1) partsTranslated.push(trEntry);
            // Reconstruct the part for the DB: keep DB's Polish strings,
            // accept the incoming structural fields. First save in a CS/SK
            // clone (when dbPart is empty/PL): take incoming as Polish too,
            // so the canonical source row gets initialised. That edge case
            // is harmless because the overlay will shadow it for participants.
            return {
              ...part,
              label:           dbPart.label           || part.label,
              transition_text: dbPart.transition_text || part.transition_text,
              pq_title:        dbPart.pq_title        || part.pq_title,
              pq_subtitle:     dbPart.pq_subtitle     || part.pq_subtitle,
            };
          });
          updates.parts_json = JSON.stringify(cleanedParts);
          if (partsTranslated.length) partsOverlayUpdates = partsTranslated;
        }
      }

      if (Object.keys(transUpdates).length || partsOverlayUpdates) {
        let allTrans = {};
        try { allTrans = JSON.parse(study.translations_json || '{}'); } catch {}
        allTrans[lang] = { ...(allTrans[lang] || {}), ...transUpdates };
        // Merge parts overlay — preserve existing parts entries by id so
        // researcher can edit one part without losing translations of others.
        if (partsOverlayUpdates) {
          const existing = Array.isArray(allTrans[lang].parts) ? allTrans[lang].parts : [];
          const merged = [...existing];
          partsOverlayUpdates.forEach(np => {
            const idx = merged.findIndex(e => String(e.id) === String(np.id));
            if (idx >= 0) merged[idx] = { ...merged[idx], ...np };
            else merged.push(np);
          });
          allTrans[lang].parts = merged;
        }
        updates.translations_json = JSON.stringify(allTrans);
      }
    }
    if (Object.keys(updates).length) {
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE studies SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), id);
    }
  }
  res.json(db.prepare('SELECT * FROM studies WHERE id = ?').get(id));
});

// ── Post questions CRUD ───────────────────────────────────────────────────────
router.get('/studies/:id/post-questions', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const rows = db.prepare('SELECT * FROM post_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index').all(req.params.id);
  // Same overlay treatment as /demographic-questions — admin in a CS/SK
  // clone sees the translated label + options so edits don't accidentally
  // overwrite the translation with the Polish source.
  const study = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(req.params.id);
  res.json(applyOverlayOnRows(study, 'post_questions', rows, OVERLAY_OPTS_POST_QUESTION));
});

router.post('/studies/:id/post-questions', auth, (req, res) => {
  if (!ownedStudy(req, res, req.params.id)) return;
  const { label, question_type, options_json, required, order_index } = req.body;
  const part_id = req.body.part_id || null;
  const maxOrder = db.prepare('SELECT MAX(order_index) as m FROM post_questions WHERE study_id = ?').get(req.params.id)?.m ?? -1;
  const info = db.prepare(`
    INSERT INTO post_questions (study_id, label, question_type, options_json, required, order_index, part_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, label || '', question_type || 'open', options_json || '[]',
    required != null ? (required ? 1 : 0) : 1,
    order_index != null ? order_index : maxOrder + 1,
    part_id);
  res.json(db.prepare('SELECT * FROM post_questions WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/post-questions/:id', auth, (req, res) => {
  if (!ownedByChild(req, res, 'post_questions', req.params.id)) return;
  const q = db.prepare('SELECT * FROM post_questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const fields = ['label', 'question_type', 'options_json', 'required', 'order_index', 'is_active'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) return res.json(q);

  // Translation overlay routing (see /demographic-questions/:id for the full
  // rationale). `label` and `options_json` (whichever shape — choice array
  // or likert object) flow into the overlay when the study is non-PL.
  // Structural fields (question_type, required, order_index, is_active)
  // stay on the DB row.
  const study = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(q.study_id);
  const { dbUpdates, overlayUpdates } = (study?.language && study.language !== 'pl')
    ? splitUpdatesByOverlay(updates, OVERLAY_OPTS_POST_QUESTION)
    : { dbUpdates: updates, overlayUpdates: {} };

  if (Object.keys(dbUpdates).length) {
    const setClauses = Object.keys(dbUpdates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE post_questions SET ${setClauses} WHERE id = ?`).run(...Object.values(dbUpdates), req.params.id);
  }
  if (Object.keys(overlayUpdates).length) {
    const newTransJson = buildOverlayUpdate(study, 'post_questions', q.id, overlayUpdates);
    if (newTransJson) {
      db.prepare('UPDATE studies SET translations_json = ? WHERE id = ?').run(newTransJson, study.id);
    }
  }
  const refreshedRow = db.prepare('SELECT * FROM post_questions WHERE id = ?').get(req.params.id);
  const refreshedStudy = db.prepare('SELECT id, language, translations_json FROM studies WHERE id = ?').get(q.study_id);
  res.json(applyOverlayOnRow(refreshedStudy, 'post_questions', refreshedRow, OVERLAY_OPTS_POST_QUESTION));
});

router.delete('/post-questions/:id', auth, (req, res) => {
  if (!ownedByChild(req, res, 'post_questions', req.params.id)) return;
  db.prepare('DELETE FROM post_questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /locales — return all 4 locales (file baseline + DB overlay merged)
// PLUS a separate `__overrides` map per-lang listing which keys are currently
// served from the DB rather than the file. The modal uses that to badge
// edited rows so the researcher has at-a-glance confirmation that their
// save landed in the database and will survive a Railway redeploy.
router.get('/locales', auth, (req, res) => {
  const langs = ['pl', 'en', 'cs', 'sk'];
  const result = {};
  const overrides = {};
  langs.forEach(lang => {
    result[lang] = db.loadLocaleWithOverrides(lang);
    const rows = db.prepare('SELECT key, value, updated_at FROM locale_overrides WHERE lang = ?').all(lang);
    const flat = {};
    rows.forEach(r => { flat[r.key] = { value: r.value, updated_at: r.updated_at }; });
    overrides[lang] = flat;
  });
  // Sentinel key so callers that iterate result[lang] don't accidentally
  // pick this up as if it were a 5th language.
  result.__overrides = overrides;
  res.json(result);
});

// PUT /locales/:lang — persist locale edits to the database.
// Previously this wrote the JSON file on disk; that worked in-container but
// Railway wipes the filesystem on every redeploy, so the researcher's edits
// silently reverted. Now we diff the incoming object against the file
// baseline: any key whose value differs from the file is UPSERTed into
// locale_overrides; any key whose value matches the file (or is empty) gets
// DELETEd so the table only ever carries actual overrides. The committed
// JSON file stays unchanged — it's the read-only baseline the DB layers
// over.
// Locale overrides are GLOBAL app-wide strings (no owner), so the write path is
// admin-only — otherwise any researcher could pollute text seen by every study,
// researcher and participant. Read (GET /locales) stays open for rendering.
router.put('/locales/:lang', auth, requireAdmin, (req, res) => {
  const { lang } = req.params;
  if (!['pl', 'en', 'cs', 'sk'].includes(lang)) {
    return res.status(400).json({ error: 'Invalid language code' });
  }
  // Load the file baseline (no DB overlay) so we can detect "back to default".
  let fileFlat = {};
  try {
    const p = path.join(__dirname, '..', 'public', 'locales', `${lang}.json`);
    fileFlat = db.flattenLocaleObj(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {}
  const incomingFlat = db.flattenLocaleObj(req.body || {});
  const upsert = db.prepare('INSERT INTO locale_overrides (lang, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(lang, key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP');
  const del    = db.prepare('DELETE FROM locale_overrides WHERE lang = ? AND key = ?');
  // Wrap in a transaction so a partial failure doesn't leave half-applied
  // overrides — researchers expect "Save" to be atomic.
  const tx = db.transaction(() => {
    for (const k of Object.keys(incomingFlat)) {
      const v = incomingFlat[k];
      const baseline = fileFlat[k];
      // Treat undefined/null/'' as "remove the override" so the file
      // baseline shines through after the researcher clears a field.
      if (v == null || v === '' || v === baseline) {
        del.run(lang, k);
      } else {
        upsert.run(lang, k, String(v));
      }
    }
  });
  try {
    tx();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
