const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');

function getSession(token) {
  return db.prepare('SELECT * FROM sessions WHERE session_token = ?').get(token);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calcMetrics(post, condObj) {
  const { min, max } = condObj;
  return {
    likes_shown: randInt(min, max),
    shares_shown: randInt(min, max),
    dislikes_shown: randInt(min, max),
    flags_shown: randInt(min, max),
  };
}

// POST /api/session/start
router.post('/session/start', (req, res) => {
  const { study_id } = req.body;
  const study = db.prepare('SELECT * FROM studies WHERE id = ? AND is_active = 1').get(study_id);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  // Style conditions
  const styleOptions = [];
  if (study.enable_condition_a) styleOptions.push('A');
  if (study.enable_condition_b) styleOptions.push('B');

  // Metric conditions — use JSON if present, else legacy columns
  let metricOptions = [];
  if (study.metric_conditions_json) {
    try {
      const parsed = JSON.parse(study.metric_conditions_json);
      metricOptions = parsed.filter(c => c.enabled);
    } catch {}
  }
  if (!metricOptions.length) {
    if (study.enable_metrics_high) metricOptions.push({ key: 'HIGH', label: 'HIGH', min: study.high_metrics_min, max: study.high_metrics_max, enabled: true });
    if (study.enable_metrics_low)  metricOptions.push({ key: 'LOW',  label: 'LOW',  min: study.low_metrics_min,  max: study.low_metrics_max,  enabled: true });
  }

  if (!styleOptions.length || !metricOptions.length) {
    return res.status(400).json({ error: 'No conditions enabled in study settings' });
  }

  const style_condition = styleOptions[Math.floor(Math.random() * styleOptions.length)];
  const metricCondObj   = metricOptions[Math.floor(Math.random() * metricOptions.length)];
  const metric_condition = metricCondObj.key;
  const full_condition = `${style_condition}-${metric_condition}`;

  const allPosts = db.prepare('SELECT * FROM posts WHERE study_id = ? AND is_active = 1').all(study_id);
  if (!allPosts.length) return res.status(400).json({ error: 'No active posts in study' });

  const n = Math.min(study.posts_per_session, allPosts.length);
  const shuffled = [...allPosts].sort(() => Math.random() - 0.5).slice(0, n);

  const token = uuidv4();
  db.prepare(`
    INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition)
    VALUES (?, ?, ?, ?, ?)
  `).run(study_id, token, style_condition, metric_condition, full_condition);

  const posts = shuffled.map((post, idx) => {
    const metrics = calcMetrics(post, metricCondObj);
    return {
      id: post.id,
      post_order: idx + 1,
      topic: post.topic,
      emoji: post.emoji,
      source_name: post.source_name,
      source_handle: post.source_handle,
      time_ago: post.time_ago,
      headline: style_condition === 'A' ? post.headline_a : post.headline_b,
      content: style_condition === 'A' ? post.content_a : post.content_b,
      is_true: post.is_true ? true : false,
      image_url: post.image_path ? `/uploads/${study_id}/${post.image_path}` : null,
      manipulation_techniques: JSON.parse(post.manipulation_techniques || '[]'),
      ...metrics,
    };
  });

  res.json({
    session_token: token,
    style_condition,
    metric_condition,
    full_condition,
    posts,
    study: {
      id: study.id,
      name: study.name,
      contact_email: study.contact_email || '',
      institution: study.institution || '',
      consent_text: study.consent_text || db.DEFAULT_CONSENT_TEXT,
      instruction_text: study.instruction_text || db.DEFAULT_INSTRUCTION_TEXT,
      debrief_text: study.debrief_text || db.DEFAULT_DEBRIEF_TEXT,
      transition_feed_text: study.transition_feed_text || db.DEFAULT_TRANSITION_FEED_TEXT,
      transition_rating_text: study.transition_rating_text || db.DEFAULT_TRANSITION_RATING_TEXT,
      hide_topic_badges: study.hide_topic_badges ? true : false,
      layout_type: study.layout_type || 'feed',
      show_reactions: study.show_reactions !== 0,
      enable_comments: study.enable_comments ? true : false,
      show_instructions: study.show_instructions !== 0,
      show_transition_feed: study.show_transition_feed !== 0,
      show_transition_rating: study.show_transition_rating !== 0,
      show_debrief: study.show_debrief !== 0,
      show_metrics: study.show_metrics !== 0,
      label_style_a: study.label_style_a || 'Styl A (manipulacyjny)',
      label_style_b: study.label_style_b || 'Styl B (neutralny)',
    },
  });
});

// POST /api/session/consent
router.post('/session/consent', (req, res) => {
  const { session_token, consented } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  db.prepare('UPDATE sessions SET consented = ? WHERE session_token = ?').run(consented ? 1 : 0, session_token);
  res.json({ ok: true });
});

// POST /api/session/demographics
router.post('/session/demographics', (req, res) => {
  const { session_token, age, residence, education, gender } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  db.prepare('UPDATE sessions SET age = ?, residence = ?, education = ?, gender = ? WHERE session_token = ?')
    .run(age, residence, education, gender, session_token);
  res.json({ ok: true });
});

// POST /api/reaction
router.post('/reaction', (req, res) => {
  const { session_token, post_id, post_order, action, dwell_ms,
    likes_shown, shares_shown, dislikes_shown, flags_shown } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  db.prepare('DELETE FROM reactions WHERE session_id = ? AND post_id = ?').run(session.id, post_id);
  db.prepare(`
    INSERT INTO reactions (session_id, post_id, post_order, action, dwell_ms,
      likes_shown, shares_shown, dislikes_shown, flags_shown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, post_id, post_order, action, dwell_ms || 0,
    likes_shown || 0, shares_shown || 0, dislikes_shown || 0, flags_shown || 0);

  res.json({ ok: true });
});

// POST /api/rating
router.post('/rating', (req, res) => {
  const { session_token, post_id, post_order, belief_1_7, comment } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  db.prepare('DELETE FROM ratings WHERE session_id = ? AND post_id = ?').run(session.id, post_id);
  db.prepare('INSERT INTO ratings (session_id, post_id, post_order, belief_1_7, comment) VALUES (?, ?, ?, ?, ?)')
    .run(session.id, post_id, post_order, belief_1_7, comment || null);

  res.json({ ok: true });
});

// POST /api/paged-response  — combined reaction + rating + comment for paged layout
router.post('/paged-response', (req, res) => {
  const { session_token, post_id, post_order, belief_1_7, comment,
    action, dwell_ms, likes_shown, shares_shown, dislikes_shown, flags_shown } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  if (action) {
    db.prepare('DELETE FROM reactions WHERE session_id = ? AND post_id = ?').run(session.id, post_id);
    db.prepare(`INSERT INTO reactions (session_id, post_id, post_order, action, dwell_ms,
        likes_shown, shares_shown, dislikes_shown, flags_shown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, post_id, post_order, action, dwell_ms || 0,
        likes_shown || 0, shares_shown || 0, dislikes_shown || 0, flags_shown || 0);
  }

  db.prepare('DELETE FROM ratings WHERE session_id = ? AND post_id = ?').run(session.id, post_id);
  db.prepare('INSERT INTO ratings (session_id, post_id, post_order, belief_1_7, comment) VALUES (?, ?, ?, ?, ?)')
    .run(session.id, post_id, post_order, belief_1_7, comment || null);

  res.json({ ok: true });
});

// POST /api/session/complete
router.post('/session/complete', (req, res) => {
  const { session_token } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  db.prepare('UPDATE sessions SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE session_token = ?')
    .run(session_token);

  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(session.study_id);
  res.json({
    ok: true,
    debrief_text: study.debrief_text || db.DEFAULT_DEBRIEF_TEXT,
    contact_email: study.contact_email || '',
  });
});

module.exports = router;
