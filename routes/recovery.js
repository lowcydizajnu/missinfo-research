// ── Orphaned-parts recovery ──────────────────────────────────────────────────
// Reverses the historic parts_json='[]' wipe. That bug emptied a study's
// parts_json but left every post and post-question row intact — each still
// carries the part it belonged to (posts.part_ids_json / posts.part_id,
// post_questions.part_id). This endpoint rebuilds parts_json from those
// surviving references, so the study reappears whole. It is STRICTLY additive:
// it only fills in part definitions that are referenced by rows but missing
// from parts_json, and never edits, reorders, or removes a healthy part.
// Reconstructed parts get sensible defaults (label "Część N", the study's
// layout); the researcher can then adjust part-level settings that only ever
// lived in parts_json (custom label, timer, requirements).
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/database');

const router = express.Router();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

function canAccess(study, user) {
  if (user.role === 'admin' || study.owner_id === user.userId) return true;
  return !!db.prepare('SELECT 1 FROM study_collaborators WHERE study_id = ? AND user_id = ?')
    .get(study.id, user.userId);
}

// Rebuild parts_json for one study from surviving row references. Returns a
// report; only writes when there is genuinely orphaned content to re-link.
function recoverStudy(study, { apply }) {
  const posts = db.prepare('SELECT part_id, part_ids_json FROM posts WHERE study_id = ? AND is_active = 1').all(study.id);
  const pqs = db.prepare('SELECT part_id FROM post_questions WHERE study_id = ? AND is_active = 1').all(study.id);

  const refs = new Set();
  const add = (v) => { if (v !== null && v !== undefined && v !== '') refs.add(String(v)); };
  posts.forEach(p => { add(p.part_id); try { (JSON.parse(p.part_ids_json || '[]') || []).forEach(add); } catch {} });
  pqs.forEach(q => add(q.part_id));

  let existing = [];
  try { existing = JSON.parse(study.parts_json || '[]'); } catch {}
  const byId = {};
  existing.forEach(p => { if (p && p.id != null) byId[String(p.id)] = p; });
  const existingIds = new Set(Object.keys(byId));

  // Structural evidence from the surviving translation overlays. The base
  // parts_json holds structural flags (show_transition) that a wipe erased, but
  // the overlays keep the translatable fields. A non-empty overlay
  // transition_text proves that part HAD a between-parts transition screen — so
  // the reconstructed base must set show_transition:true (structural flags are
  // NOT translated, so the overlay text alone would otherwise never render).
  let allTrans = {};
  try { allTrans = JSON.parse(study.translations_json || '{}'); } catch {}
  const partHadTransition = {};
  for (const lang of Object.keys(allTrans)) {
    for (const p of ((allTrans[lang] && allTrans[lang].parts) || [])) {
      if (p && p.id != null && p.transition_text && String(p.transition_text).trim()) partHadTransition[String(p.id)] = true;
    }
  }

  const missing = [...refs].filter(id => !existingIds.has(id));
  // Correct any EXISTING part whose overlay proves a transition but whose base
  // show_transition is off (e.g. a part reconstructed by an earlier, dumber run
  // of this endpoint). Evidence-based and non-destructive: only turns a
  // transition ON when a surviving translation shows it was meant to be on.
  let corrected = 0;
  for (const p of existing) {
    if (partHadTransition[String(p.id)] && !p.show_transition) { p.show_transition = true; corrected++; }
  }

  if (refs.size === 0 || (missing.length === 0 && corrected === 0)) {
    return { slug: study.slug, changed: false, reason: existing.length ? 'ok — nic do odzyskania' : 'brak osieroconej treści' };
  }

  // Union of surviving + reconstructed, ordered by id (part-0 < part-1 < …).
  const allIds = [...new Set([...existingIds, ...refs])].sort();
  const layout = study.layout_type || 'feed';
  const pqMode = study.post_questions_display_mode || 'after_interaction';
  const mkDefault = (id, idx) => ({
    id, label: `Część ${idx + 1}`, layout,
    // Preserve the between-parts transition when a surviving translation proves
    // it existed. The base transition_text stays empty (its source-language
    // wording was lost with the wipe); the overlay supplies it for translated
    // languages, and the source language shows the part label as the title.
    show_transition: !!partHadTransition[id], transition_text: '', pq_display_mode: pqMode,
    pq_title: '', pq_subtitle: '', require_interaction: false,
    allow_back: true, show_reactions: true, max_seconds: 0, requirements: [],
  });
  const rebuilt = allIds.map((id, idx) => byId[id] || mkDefault(id, idx));

  if (apply) db.prepare('UPDATE studies SET parts_json = ? WHERE id = ?').run(JSON.stringify(rebuilt), study.id);
  return {
    slug: study.slug, name: study.name, changed: true,
    before: existing.map(p => p.id), after: rebuilt.map(p => p.id),
    reconstructed_parts: missing, transitions_restored: Object.keys(partHadTransition).length,
    posts: posts.length, questions: pqs.length,
    note: 'Odzyskano treść, grupowanie i ekrany przejścia. Sprawdź ustawienia odtworzonych części (nazwa, timer, wymagania) w Konfiguratorze.',
  };
}

function eligibleStudies(user) {
  const all = db.prepare('SELECT * FROM studies WHERE builder_mode = 1').all();
  return all.filter(s => canAccess(s, user));
}

// Dry run — report what WOULD be recovered. Read-only.
router.get('/scan', auth, (req, res) => {
  const reports = eligibleStudies(req.user).map(s => recoverStudy(s, { apply: false }));
  res.json({ orphaned: reports.filter(r => r.changed), healthy: reports.filter(r => !r.changed).length });
});

// Apply recovery to every accessible orphaned study.
router.post('/parts', auth, (req, res) => {
  const reports = eligibleStudies(req.user).map(s => recoverStudy(s, { apply: true }));
  res.json({ recovered: reports.filter(r => r.changed), skipped: reports.filter(r => !r.changed).length });
});

module.exports = router;
