const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');
const { generateExcel } = require('./export');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret';
const uploadsDir = path.resolve(process.env.UPLOADS_PATH || './uploads');

// ── Auth middleware ────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Login ──────────────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  if (req.body.password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// ── Multer setup ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const post = db.prepare('SELECT study_id FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return cb(new Error('Post not found'));
    const dir = path.join(uploadsDir, String(post.study_id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${req.params.id}${ext}`);
  },
});
const upload = multer({
  storage,
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
router.get('/studies', auth, (req, res) => {
  const studies = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM sessions WHERE study_id=s.id AND completed=1) as completed_count
    FROM studies s ORDER BY s.created_at DESC
  `).all();
  res.json(studies);
});

router.post('/studies', auth, (req, res) => {
  const { name, slug: rawSlug, description, institution, contact_email } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const slug = uniqueSlug(rawSlug ? slugify(rawSlug) : slugify(name));

  const info = db.prepare(`
    INSERT INTO studies (name, slug, description, institution, contact_email)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, slug, description || null, institution || null, contact_email || null);

  db.seedDefaultPosts(info.lastInsertRowid);
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(info.lastInsertRowid);
  res.json(study);
});

router.patch('/studies/:id', auth, (req, res) => {
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
    'layout_type', 'show_reactions', 'enable_comments',
    'show_instructions', 'show_transition_feed', 'show_transition_rating', 'show_debrief',
    'label_style_a', 'label_style_b', 'metric_conditions_json', 'show_metrics',
    'consent_text', 'instruction_text', 'transition_feed_text', 'transition_rating_text', 'debrief_text',
  ];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  if (Object.keys(updates).length === 0) return res.json(study);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE studies SET ${setClauses} WHERE id = ?`)
    .run(...Object.values(updates), id);

  res.json(db.prepare('SELECT * FROM studies WHERE id = ?').get(id));
});

router.delete('/studies/:id', auth, (req, res) => {
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
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(id);
  if (!study) return res.status(404).json({ error: 'Not found' });

  const newSlug = uniqueSlug(slugify(study.name + '-kopia'));
  const info = db.prepare(`
    INSERT INTO studies (name, slug, description, institution, contact_email,
      posts_per_session, high_metrics_min, high_metrics_max, low_metrics_min, low_metrics_max,
      enable_condition_a, enable_condition_b, enable_metrics_high, enable_metrics_low,
      consent_text, instruction_text, debrief_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    study.name + ' (kopia)', newSlug, study.description, study.institution, study.contact_email,
    study.posts_per_session, study.high_metrics_min, study.high_metrics_max,
    study.low_metrics_min, study.low_metrics_max,
    study.enable_condition_a, study.enable_condition_b,
    study.enable_metrics_high, study.enable_metrics_low,
    study.consent_text, study.instruction_text, study.debrief_text
  );
  const newStudyId = info.lastInsertRowid;

  const posts = db.prepare('SELECT * FROM posts WHERE study_id = ?').all(id);
  const insertPost = db.prepare(`
    INSERT INTO posts (study_id, order_index, topic, emoji, source_name, source_handle,
      time_ago, headline_a, content_a, headline_b, content_b, is_true,
      manipulation_techniques, base_likes, base_shares, base_dislikes, base_flags, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const oldDir = path.join(uploadsDir, String(id));
  const newDir = path.join(uploadsDir, String(newStudyId));

  posts.forEach(p => {
    const pInfo = insertPost.run(
      newStudyId, p.order_index, p.topic, p.emoji, p.source_name, p.source_handle,
      p.time_ago, p.headline_a, p.content_a, p.headline_b, p.content_b, p.is_true,
      p.manipulation_techniques, p.base_likes, p.base_shares, p.base_dislikes, p.base_flags, p.is_active
    );
    // Copy image if exists
    if (p.image_path) {
      const src = path.join(oldDir, p.image_path);
      if (fs.existsSync(src)) {
        fs.mkdirSync(newDir, { recursive: true });
        const ext = path.extname(p.image_path);
        const newFilename = `${pInfo.lastInsertRowid}${ext}`;
        fs.copyFileSync(src, path.join(newDir, newFilename));
        db.prepare('UPDATE posts SET image_path = ? WHERE id = ?').run(newFilename, pInfo.lastInsertRowid);
      }
    }
  });

  res.json(db.prepare('SELECT * FROM studies WHERE id = ?').get(newStudyId));
});

// ── Posts ─────────────────────────────────────────────────────────────────────
router.get('/studies/:id/posts', auth, (req, res) => {
  const posts = db.prepare('SELECT * FROM posts WHERE study_id = ? ORDER BY order_index').all(req.params.id);
  res.json(posts);
});

router.post('/posts', auth, (req, res) => {
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
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });

  const fields = ['topic', 'emoji', 'source_name', 'source_handle', 'time_ago',
    'headline_a', 'content_a', 'headline_b', 'content_b', 'is_true',
    'manipulation_techniques', 'base_likes', 'base_shares', 'base_dislikes', 'base_flags', 'is_active',
    'post_comment', 'post_comment_author'];

  const updates = {};
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      updates[f] = f === 'manipulation_techniques' && Array.isArray(req.body[f])
        ? JSON.stringify(req.body[f])
        : req.body[f];
    }
  });

  if (!Object.keys(updates).length) return res.json(post);
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE posts SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json(db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id));
});

router.patch('/posts/:id/reorder', auth, (req, res) => {
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

router.post('/posts/:id/image', auth, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Remove old image if different extension
    if (post.image_path && post.image_path !== req.file.filename) {
      const oldPath = path.join(uploadsDir, String(post.study_id), post.image_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    db.prepare('UPDATE posts SET image_path = ? WHERE id = ?').run(req.file.filename, req.params.id);
    res.json({ image_path: req.file.filename, image_url: `/uploads/${post.study_id}/${req.file.filename}` });
  });
});

router.delete('/posts/:id/image', auth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (post.image_path) {
    const filePath = path.join(uploadsDir, String(post.study_id), post.image_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('UPDATE posts SET image_path = NULL WHERE id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard/:studyId', auth, (req, res) => {
  const { studyId } = req.params;

  const total = db.prepare('SELECT COUNT(*) as n FROM sessions WHERE study_id = ?').get(studyId)?.n || 0;
  const completed = db.prepare('SELECT COUNT(*) as n FROM sessions WHERE study_id = ? AND completed = 1').get(studyId)?.n || 0;
  const dropout_rate = total > 0 ? Math.round(((total - completed) / total) * 10000) / 100 : 0;

  const condCompletion = db.prepare(`
    SELECT full_condition, COUNT(*) as count
    FROM sessions WHERE study_id = ? AND completed = 1
    GROUP BY full_condition
  `).all(studyId);

  const beliefByCondFalse = db.prepare(`
    SELECT s.full_condition, ROUND(AVG(rt.belief_1_7), 2) as mean_belief
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1 AND p.is_true = 0
    GROUP BY s.full_condition
  `).all(studyId);

  const beliefByCondTrue = db.prepare(`
    SELECT s.full_condition, ROUND(AVG(rt.belief_1_7), 2) as mean_belief
    FROM ratings rt
    JOIN sessions s ON rt.session_id = s.id
    JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1 AND p.is_true = 1
    GROUP BY s.full_condition
  `).all(studyId);

  const recentSessions = db.prepare(`
    SELECT s.id, s.full_condition, s.age, s.residence, s.education, s.gender, s.completed_at,
      ROUND(AVG(CASE WHEN p.is_true=0 THEN rt.belief_1_7 END), 2) as avg_belief_false
    FROM sessions s
    LEFT JOIN ratings rt ON rt.session_id = s.id
    LEFT JOIN posts p ON rt.post_id = p.id
    WHERE s.study_id = ? AND s.completed = 1
    GROUP BY s.id
    ORDER BY s.completed_at DESC LIMIT 20
  `).all(studyId);

  res.json({
    total_sessions: total,
    completed_sessions: completed,
    dropout_rate,
    conditions_completion: Object.fromEntries(condCompletion.map(r => [r.full_condition, r.count])),
    conditions_mean_belief_false: Object.fromEntries(beliefByCondFalse.map(r => [r.full_condition, r.mean_belief])),
    conditions_mean_belief_true: Object.fromEntries(beliefByCondTrue.map(r => [r.full_condition, r.mean_belief])),
    recent_sessions: recentSessions,
  });
});

// ── Export ────────────────────────────────────────────────────────────────────
router.get('/export/:studyId', auth, async (req, res) => {
  try {
    const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(req.params.studyId);
    if (!study) return res.status(404).json({ error: 'Study not found' });

    const wb = await generateExcel(req.params.studyId);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${study.slug}_${date}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
