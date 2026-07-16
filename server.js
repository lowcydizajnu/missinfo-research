require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

// Behind a hosting proxy (Railway, Render, most PaaS) the real client IP arrives
// in the X-Forwarded-For header. Trust exactly ONE proxy hop so req.ip is the
// real client (not the proxy) — required for express-rate-limit to identify
// callers, and it otherwise throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Trusting
// a single hop (not `true`) keeps clients from spoofing X-Forwarded-For.
app.set('trust proxy', 1);

// Ensure required directories exist
const dbPath = process.env.DATABASE_PATH || './data/research.db';
const dataDir = path.dirname(path.resolve(dbPath));
const uploadsDir = path.resolve(process.env.UPLOADS_PATH || './uploads');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Init DB (runs schema + seeds)
require('./db/database');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Serve uploaded images from SQLite BLOBs ───────────────────────────────────
// URL pattern: /uploads/<studyId>/<filename>. We look up the post in the same
// study whose image_path_* / avatar_path / image_path matches the filename,
// then stream its BLOB. Falls back to disk (uploadsDir) when no BLOB exists
// (covers any file that hasn't yet been migrated by the startup pass).
const dbForUploads = require('./db/database');
const findImageStmt = dbForUploads.prepare(`
  SELECT id, image_path, image_path_a, image_path_b, avatar_path,
         image_blob_a, image_mime_a, image_blob_b, image_mime_b,
         avatar_blob, avatar_mime
  FROM posts
  WHERE study_id = ? AND (
    image_path = ? OR image_path_a = ? OR image_path_b = ? OR avatar_path = ?
  )
  LIMIT 1
`);
app.get('/uploads/:studyId/:filename', (req, res) => {
  const { studyId, filename } = req.params;
  // basic safety: filenames are never expected to contain slashes
  if (filename.includes('/') || filename.includes('..')) return res.status(400).end();

  const row = findImageStmt.get(studyId, filename, filename, filename, filename);
  if (row) {
    let blob = null, mime = null;
    if (row.image_path_a === filename) { blob = row.image_blob_a; mime = row.image_mime_a; }
    else if (row.image_path_b === filename) { blob = row.image_blob_b; mime = row.image_mime_b; }
    else if (row.avatar_path === filename)  { blob = row.avatar_blob;  mime = row.avatar_mime;  }
    else if (row.image_path === filename)   { blob = row.image_blob_a; mime = row.image_mime_a; }
    if (blob) {
      res.set('Content-Type', mime || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(blob);
    }
  }
  // Fallback to disk (legacy / not-yet-migrated)
  const fp = path.join(uploadsDir, studyId, filename);
  if (fs.existsSync(fp)) return res.sendFile(fp);
  return res.status(404).end();
});

// ── Per-study custom-domain routing ───────────────────────────────────────────
// When a researcher binds a study to a specific hostname (studies.custom_domain),
// requests landing on that host should ONLY serve that one study — never the
// admin panel, never other studies, never the dashboard. The participant
// recruitment link `https://study.example.org/?res_id=ABC123` lands on
// the bound study directly, with the URL query (res_id etc.) preserved so
// the panel-recruitment ID-capture flow continues to work end-to-end.
//
// Lookup is a single indexed SQLite read per request — sub-millisecond on a
// local volume. No cache needed at this scale. If the host doesn't match any
// custom_domain (the common case: original Railway URL, localhost dev, future
// agency domain), the middleware no-ops and the request falls through to the
// normal routing below. Studies without a custom_domain configured remain
// reachable only via /study/<slug> on the default host — zero behaviour
// change for the existing setup.
const dbForRouting = require('./db/database');
const findStudyByHostStmt = dbForRouting.prepare(
  'SELECT id, slug FROM studies WHERE custom_domain = ? AND is_active = 1'
);
app.use((req, res, next) => {
  const host = req.hostname; // express normalises to lowercase, strips port
  if (!host) return next();
  const bound = findStudyByHostStmt.get(host);
  if (!bound) return next();   // not a custom-domain request

  const p = req.path;

  // 1. Root → serve the bound study. We rewrite the URL so the existing
  //    GET /study/:slug handler (further down) does the actual SPA serve,
  //    keeping a single source of truth for the study HTML injection logic.
  //    The query string is preserved verbatim so ?res_id=… continues to
  //    flow into participant.js → /api/session/start → external_id capture.
  if (p === '/' || p === '') {
    const qs = req.url.length > p.length ? req.url.slice(p.length) : '';
    req.url = '/study/' + bound.slug + qs;
    return next();
  }

  // 2. Allow-list of paths that must remain reachable on the custom domain:
  //    - /api/*       — participant API (session/start, reaction, etc.)
  //    - /uploads/*   — post images / avatars served from BLOBs
  //    - /study/mediapipe/* — WebGazer model assets (redirected to jsDelivr)
  //    - /study/<bound.slug> — the bound study's own canonical URL
  //    - Static assets the participant SPA needs (css/js/locales/favicon)
  if (p.startsWith('/api/')) return next();
  if (p.startsWith('/uploads/')) return next();
  if (p.startsWith('/study/mediapipe/')) return next();
  if (p === '/study/' + bound.slug) return next();
  if (p.startsWith('/css/') || p.startsWith('/js/') ||
      p.startsWith('/locales/') || p.startsWith('/favicon')) return next();

  // 3. Everything else (admin, other studies, dashboard share, raw .html
  //    files served by express.static) → 404. Researcher-facing surfaces
  //    remain accessible on the default Railway/localhost host.
  return res.status(404).send('<h2>Strona nie została znaleziona.</h2>');
});

// Serve static frontend
// `maxAge: 0` + `etag: true` (default) forces the browser to revalidate every
// request via If-None-Match — server still returns 304 when nothing changed,
// but any code/CSS update is picked up instantly without a hard refresh.
// HTML in particular has been getting served from disk cache on iterative dev
// loops, which made just-edited admin UI invisible until Cmd+Shift+R.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Cache-bust JS/CSS/HTML aggressively; keep image/font caching on (defaults).
    if (/\.(html|js|css|json)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));
// Serve the shared conditional-logic engine (also require()d server-side) to the
// participant browser as /lib/logic.js.
app.use('/lib', express.static(path.join(__dirname, 'lib'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
}));

// API routes
app.use('/api', require('./routes/participant'));
app.use('/api/admin', require('./routes/admin'));

// Public read-only dashboard share page. Token is the path param;
// validates server-side via the /api/admin/public/dashboard/:token endpoint.
app.get('/share/dashboard/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share-dashboard.html'));
});

// WebGazer loads MediaPipe model files relative to the current page URL,
// so /study/:slug → it requests /study/mediapipe/face_mesh/*.
// Redirect those to jsDelivr so no binary assets need to be bundled in the repo.
app.get('/study/mediapipe/face_mesh/:file', (req, res) => {
  res.redirect(302, `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${req.params.file}`);
});

// Study SPA — inject study config into HTML
app.get('/study/:slug', (req, res) => {
  const db = require('./db/database');
  const previewMode = req.query.preview === '1';
  const study = previewMode
    ? db.prepare('SELECT * FROM studies WHERE slug = ? AND builder_mode = 1').get(req.params.slug)
    : db.prepare('SELECT * FROM studies WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!study) return res.status(404).send('<h2>Badanie nie zostało znalezione lub jest nieaktywne.</h2>');

  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
  const config = JSON.stringify({
    id: study.id,
    name: study.name,
    slug: study.slug,
    institution: study.institution || '',
    contact_email: study.contact_email || '',
    consent_text: study.consent_text || null,
    instruction_text: study.instruction_text || null,
    debrief_text: study.debrief_text || null,
    builder_mode: study.builder_mode || 0,
    is_preview: previewMode ? 1 : 0,
  });
  html = html.replace('</head>', `<script>window.STUDY_CONFIG = ${config};</script>\n</head>`);
  res.send(html);
});

// Admin panel
// Admin UI locales as a BLOCKING script, loaded before /js/admin.js.
// Why a script and not a fetch: admin.js builds some module-level constants
// (e.g. AN_TESTS) whose labels call t() at parse time. An async fetch resolves
// after that, so those constants would bake in the raw key forever. Delivering
// the dictionaries synchronously makes t() valid from the first line of the
// module and removes that entire class of bug. Both languages ship together —
// the chosen language lives in localStorage, which the server cannot see.
app.get('/locales/admin.js', (req, res) => {
  const load = (lang) => {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(__dirname, 'public', 'locales', 'admin', `${lang}.json`), 'utf-8'));
    } catch { return {}; }
  };
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.send(`window.ADMIN_LOCALES = ${JSON.stringify({ pl: load('pl'), en: load('en') })};`);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Eye-tracking heatmap viewer
app.get('/admin/heatmap', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-heatmap.html'));
});

// Root → admin
app.get('/', (req, res) => res.redirect('/admin'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
