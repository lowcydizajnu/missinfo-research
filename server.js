require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

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

// Serve uploaded images
app.use('/uploads', express.static(uploadsDir));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', require('./routes/participant'));
app.use('/api/admin', require('./routes/admin'));

// WebGazer loads MediaPipe model files relative to the current page URL,
// so /study/:slug → it requests /study/mediapipe/face_mesh/*.
// Redirect those to jsDelivr so no binary assets need to be bundled in the repo.
app.get('/study/mediapipe/face_mesh/:file', (req, res) => {
  res.redirect(302, `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${req.params.file}`);
});

// Study SPA — inject study config into HTML
app.get('/study/:slug', (req, res) => {
  const db = require('./db/database');
  const study = db.prepare('SELECT * FROM studies WHERE slug = ? AND is_active = 1').get(req.params.slug);
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
  });
  html = html.replace('</head>', `<script>window.STUDY_CONFIG = ${config};</script>\n</head>`);
  res.send(html);
});

// Admin panel
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
