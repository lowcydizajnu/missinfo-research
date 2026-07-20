// ── Study screen walkthrough (report appendix) ───────────────────────────────
// Returns everything needed to render, on ONE page, every screen a participant
// passes through in condition A — consent → instruction → demographics → each
// post → debrief. Consumed by /public/js/walkthrough.js, which the researcher
// prints to PDF. Read-only; authenticated exactly like the admin API (Bearer
// JWT), and scoped to studies the caller may see (admin, owner, or collaborator)
// so it never widens access to a study.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/database');

const router = express.Router();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { userId, role }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Study fields the walkthrough needs (deliberately explicit — no blobs, no
// internal columns). Condition A post content is mapped from the *_a variants.
const STUDY_FIELDS = [
  'id', 'name', 'slug', 'participant_title', 'institution', 'contact_email', 'language',
  'is_active', 'builder_mode', 'layout_type',
  'consent_text', 'no_consent_text', 'instruction_text', 'debrief_text',
  'transition_feed_text', 'transition_rating_text',
  'show_instructions', 'show_transition_feed', 'show_transition_rating',
  'show_demographics', 'show_debrief', 'show_debrief_posts', 'show_instruction_actions',
  'show_reactions', 'show_metrics', 'show_avatars', 'eyetracking_enabled',
  'label_action_like', 'label_action_dislike', 'label_action_share', 'label_action_flag',
  'label_likert_question', 'label_likert_min', 'label_likert_max',
];

router.get('/:slug', auth, (req, res) => {
  const study = db.prepare('SELECT * FROM studies WHERE slug = ?').get(req.params.slug);
  // 404 (not 403) on cross-tenant / missing — same non-enumerable behaviour as
  // the rest of the admin API.
  if (!study) return res.status(404).json({ error: 'Nie znaleziono badania.' });
  const uid = req.user.userId;
  const isAdmin = req.user.role === 'admin';
  const isCollaborator = !!db.prepare(
    'SELECT 1 FROM study_collaborators WHERE study_id = ? AND user_id = ?'
  ).get(study.id, uid);
  if (!(isAdmin || study.owner_id === uid || isCollaborator)) {
    return res.status(404).json({ error: 'Nie znaleziono badania.' });
  }

  const out = { study: {} };
  for (const f of STUDY_FIELDS) out.study[f] = study[f];

  // Posts in condition A. Images/avatars are served from the existing
  // /uploads/<studyId>/<filename> endpoint (SQLite BLOB or disk), so we only
  // pass the filename-derived URL, never the blob.
  const uploadUrl = (name) => (name ? `/uploads/${study.id}/${name}` : null);
  const rows = db.prepare(
    'SELECT * FROM posts WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(study.id);
  out.posts = rows.map((p) => ({
    order_index: p.order_index,
    source_name: p.source_name,
    source_handle: p.source_handle,
    time_ago: p.time_ago,
    topic: p.topic,
    emoji: p.emoji,
    hide_topic: p.hide_topic,
    headline: p.headline_a,
    content: p.content_a,
    is_true: p.is_true,
    image_url: uploadUrl(p.image_path_a || p.image_path),
    avatar_url: uploadUrl(p.avatar_path),
    show_avatar: p.show_avatar,
    likes: p.base_likes, shares: p.base_shares, dislikes: p.base_dislikes, flags: p.base_flags,
    show_like: p.show_like, show_dislike: p.show_dislike, show_share: p.show_share, show_flag: p.show_flag,
  }));

  out.demographics = db.prepare(
    'SELECT field_key, label, input_type, options, required, min_value, max_value ' +
    'FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(study.id);

  try { out.parts = JSON.parse(study.parts_json || '[]'); } catch { out.parts = []; }

  res.json(out);
});

module.exports = router;
