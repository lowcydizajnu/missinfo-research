'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const CANVAS_W   = 390;   // logical canvas width  (≈ iPhone viewport)
const CANVAS_H   = 720;   // logical canvas height
const SCALE      = window.devicePixelRatio || 1;

const AOI_ORDER  = ['headline','content','image','metrics','actions','avatar','other'];
const AOI_LABELS = { headline:'Nagłówek', content:'Treść', image:'Zdjęcie',
                     metrics:'Metryki', actions:'Akcje', avatar:'Avatar', other:'Inne' };
// Approximate AOI regions as fraction of canvas height (for background schematic)
const AOI_REGIONS = {
  avatar:   { y0: 0.04, y1: 0.14 },
  headline: { y0: 0.15, y1: 0.27 },
  image:    { y0: 0.28, y1: 0.61 },
  content:  { y0: 0.62, y1: 0.73 },
  metrics:  { y0: 0.74, y1: 0.82 },
  actions:  { y0: 0.83, y1: 0.91 },
};
const AOI_COLORS = {
  headline: '#fbbf24', content: '#34d399', image: '#60a5fa',
  metrics:  '#a78bfa', actions: '#f472b6', avatar: '#22d3ee', other: '#94a3b8',
};

// ── State ──────────────────────────────────────────────────────────────────
const HV = {
  token:          localStorage.getItem('admin_token'),
  studies:        [],
  studyId:        null,
  allSessions:    [],   // sessions with gaze data for selected study
  currentSession: null, // { session, gaze, posts, feedSnapshot }
  postFilter:     'all',
  modeFilter:     'all', // 'all' | 'feed' | 'paged'
  activeTab:      'heatmap',
  heatmapInst:    null,
  playback: {
    raf:       null,
    playing:   false,
    speed:     1,
    startReal: 0,
    startGaze: 0,
    points:    [],  // normalised, filtered
  },
  compareSelected: new Set(),
  compareData:     [],
};

// ── Bootstrap ──────────────────────────────────────────────────────────────
(function init() {
  if (!HV.token) { location.href = '/admin'; return; }
  setupTabs();
  setupPlaybackControls();
  setupCompare();
  loadStudies();
  document.getElementById('hv-study').addEventListener('change', e => {
    HV.studyId = e.target.value ? parseInt(e.target.value) : null;
    HV.currentSession = null;
    clearViewer();
    if (HV.studyId) loadSessions(HV.studyId);
  });
  document.getElementById('hv-post-filter').addEventListener('change', e => {
    HV.postFilter = e.target.value;
    if (HV.currentSession) updateVisualization();
  });

  document.getElementById('hv-mode-btns').addEventListener('click', e => {
    const btn = e.target.closest('.hv-mode-btn');
    if (!btn) return;
    document.querySelectorAll('.hv-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    HV.modeFilter = btn.dataset.mode;
    if (HV.currentSession) updateVisualization();
  });
})();

// ── API helpers ────────────────────────────────────────────────────────────
function apiFetch(path) {
  return fetch(path, { headers: { Authorization: `Bearer ${HV.token}` } })
    .then(async r => {
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(`HTTP ${r.status}: ${body.error || '(brak szczegółów)'}`);
      }
      return r.json();
    });
}

// ── Load studies ───────────────────────────────────────────────────────────
async function loadStudies() {
  try {
    HV.studies = await apiFetch('/api/admin/studies');
    const sel = document.getElementById('hv-study');
    HV.studies.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + (s.eyetracking_enabled ? ' 👁' : '');
      sel.appendChild(opt);
    });
    if (HV.studies.length === 0) {
      sel.innerHTML = '<option value="">Brak badań</option>';
    }
  } catch (e) {
    console.error('loadStudies:', e);
    alert('Błąd autoryzacji — zaloguj się ponownie w panelu admina.');
    location.href = '/admin';
  }
}

// ── Load sessions ──────────────────────────────────────────────────────────
async function loadSessions(studyId) {
  try {
    HV.allSessions = await apiFetch(`/api/admin/gaze-sessions/${studyId}`);
    const badge = document.getElementById('hv-session-badge');
    badge.textContent = HV.allSessions.length;

    const list = document.getElementById('hv-session-list');
    list.innerHTML = '';

    if (!HV.allSessions.length) {
      list.innerHTML = '<p style="font-size:.75rem;color:#64748b;margin:0">Brak sesji z danymi eye-tracking.</p>';
    } else {
      HV.allSessions.forEach(s => {
        const el = document.createElement('div');
        el.className = 'hv-session-item';
        el.dataset.id = s.id;
        const dateStr = s.started_at ? new Date(s.started_at).toLocaleString('pl-PL', { dateStyle:'short', timeStyle:'short' }) : '—';
        el.innerHTML = `
          <div class="hv-session-item-id">#${s.id} <span style="font-weight:400;color:#475569">${dateStr}</span></div>
          <div class="hv-session-item-cond">${s.full_condition || '—'}</div>
          <div class="hv-session-item-pts">${s.n_gaze_pts > 0
            ? `${s.n_gaze_pts} pkt gaze${s.calibration_error != null ? ` · ±${Math.round(s.calibration_error)}px` : ''}`
            : '⚠️ Kalibracja nieskuteczna'
          }</div>`;
        el.addEventListener('click', () => selectSession(s.id, el));
        list.appendChild(el);
      });
    }

    document.getElementById('hv-session-ctrl').hidden = false;

    // Populate compare list
    populateCompareList();
  } catch (e) {
    console.error('loadSessions:', e);
  }
}

// ── Select session ─────────────────────────────────────────────────────────
async function selectSession(sessionId, itemEl) {
  document.querySelectorAll('.hv-session-item').forEach(el => el.classList.remove('active'));
  if (itemEl) itemEl.classList.add('active');
  stopPlayback();
  try {
    HV.currentSession = await apiFetch(`/api/admin/gaze-data/${sessionId}`);
    buildPostFilter();
    buildModeFilter();
    showSessionMeta();
    document.getElementById('hv-viewer').hidden = false;
    document.getElementById('hv-empty').style.display = 'none';
    updateVisualization();
  } catch (e) {
    console.error('selectSession:', e);
  }
}

// ── Post filter ────────────────────────────────────────────────────────────
function buildPostFilter() {
  const { gaze, posts } = HV.currentSession;
  const sel = document.getElementById('hv-post-filter');
  sel.innerHTML = '<option value="all">Wszystkie posty</option>';

  const postMap = {};
  posts.forEach(p => { postMap[p.id] = p; });
  const postIds = [...new Set(gaze.filter(g => g.post_id != null).map(g => g.post_id))];
  // Sort by post_order if available
  postIds.sort((a, b) => {
    const oa = postMap[a]?.post_order ?? 99;
    const ob = postMap[b]?.post_order ?? 99;
    return oa - ob;
  });
  postIds.forEach(pid => {
    const p = postMap[pid];
    // detect which modes have gaze for this post
    const hasFeed  = gaze.some(g => g.post_id === pid && isFeed(g.screen_name));
    const hasPaged = gaze.some(g => g.post_id === pid && isOcena(g.screen_name));
    const modeTag  = hasFeed && hasPaged ? ' [feed+ocena]' : hasFeed ? ' [feed]' : hasPaged ? ' [ocena]' : '';
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = (p ? `Post ${p.post_order || '?'}: ${(p.headline || '').slice(0, 35)}` : `Post #${pid}`) + modeTag;
    sel.appendChild(opt);
  });

  HV.postFilter = 'all';
  sel.value = 'all';
  document.getElementById('hv-post-ctrl').hidden = false;
}

// screen_name prefixes: feed_post_N (feed), paged_post_N (paged layout), rating_post_N (Likert rating)
function isOcena(screenName) {
  return screenName?.startsWith('paged_') || screenName?.startsWith('rating_');
}
function isFeed(screenName) {
  return screenName?.startsWith('feed_');
}

function buildModeFilter() {
  const { gaze } = HV.currentSession;
  const hasFeed  = gaze.some(g => isFeed(g.screen_name));
  const hasOcena = gaze.some(g => isOcena(g.screen_name));
  const ctrl = document.getElementById('hv-mode-ctrl');
  ctrl.hidden = false;
  document.querySelector('[data-mode="feed"]').style.opacity  = hasFeed  ? '1' : '0.35';
  document.querySelector('[data-mode="paged"]').style.opacity = hasOcena ? '1' : '0.35';
  HV.modeFilter = 'all';
  document.querySelectorAll('.hv-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === 'all'));
}

function filterGaze(gaze) {
  let pts = gaze;
  if (HV.modeFilter === 'feed')  pts = pts.filter(g => isFeed(g.screen_name));
  if (HV.modeFilter === 'paged') pts = pts.filter(g => isOcena(g.screen_name));
  if (HV.postFilter !== 'all') {
    const pid = parseInt(HV.postFilter);
    pts = pts.filter(g => g.post_id === pid);
  }
  return pts;
}

function currentMode(pts) {
  if (HV.modeFilter !== 'all') return HV.modeFilter === 'paged' ? 'paged' : 'feed';
  const feedN  = pts.filter(g => isFeed(g.screen_name)).length;
  const ocenaN = pts.filter(g => isOcena(g.screen_name)).length;
  if (feedN === 0 && ocenaN > 0) return 'paged';
  if (ocenaN === 0 && feedN > 0) return 'feed';
  return 'mixed';
}

// ── Normalise gaze to canvas coords ───────────────────────────────────────
function normaliseGaze(pts) {
  return pts.map(p => ({
    ...p,
    cx: p.vw ? Math.round((p.x / p.vw) * CANVAS_W) : Math.round(p.x),
    cy: p.vh ? Math.round((p.y / p.vh) * CANVAS_H) : Math.round(p.y),
  }));
}

// ── Session meta sidebar ───────────────────────────────────────────────────
function showSessionMeta() {
  const { session } = HV.currentSession;
  const el = document.getElementById('hv-session-meta');
  el.innerHTML = `
    <strong>Sesja #${session.id}</strong><br>
    Warunek: ${session.full_condition || '—'}<br>
    Kalibracja: ${session.calibration_error != null ? `±${Math.round(session.calibration_error)}px` : '—'}<br>
    Rekalibracje: ${session.n_recalibrations ?? 0}<br>
    Rekordy: ${HV.currentSession.gaze.length}`;
  el.hidden = false;
}

// ── Clear viewer ───────────────────────────────────────────────────────────
function clearViewer() {
  document.getElementById('hv-viewer').hidden = true;
  document.getElementById('hv-empty').style.display = '';
  document.getElementById('hv-session-ctrl').hidden = true;
  document.getElementById('hv-mode-ctrl').hidden = true;
  document.getElementById('hv-post-ctrl').hidden = true;
  document.getElementById('hv-session-meta').hidden = true;
  document.querySelectorAll('.hv-session-item').forEach(el => el.classList.remove('active'));
  stopPlayback();
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.hv-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.hv-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.hv-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      HV.activeTab = tab;
      stopPlayback();
      if (HV.currentSession) updateVisualization();
    });
  });
}

// ── Main update ────────────────────────────────────────────────────────────
function updateVisualization() {
  const filtered  = filterGaze(HV.currentSession.gaze);
  const mode      = currentMode(filtered);
  const normed    = normaliseGaze(filtered);
  switch (HV.activeTab) {
    case 'heatmap':  renderHeatmap(normed, mode);  break;
    case 'scanpath': renderScanpath(normed, mode); break;
    case 'playback': preparePlayback(normed, mode); break;
    case 'aoi':      renderAOI(filtered);          break;
    case 'compare':  /* handled by compare UI */   break;
  }
}

// ── Background schematic ───────────────────────────────────────────────────
function drawBackground(canvas, mode) {
  if (mode === 'paged') { drawBackgroundPaged(canvas); return; }
  drawBackgroundFeed(canvas);
}

// ── Shared AOI-band drawing helper ────────────────────────────────────────────
// Draws coloured region tint + left pill label for one AOI band.
function drawAOIBand(ctx, name, x, y, w, h) {
  const color = AOI_COLORS[name] || '#94a3b8';
  const label = AOI_LABELS[name] || name;

  // Subtle fill tint
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);

  // Crisp top border line
  ctx.globalAlpha = 0.40;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();

  // Left pill tag
  const tagW = ctx.measureText(label).width + 10;
  const tagH = 14;
  const tagX = x + 4;
  const tagY = y + (h - tagH) / 2;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = color;
  roundRect(ctx, tagX, tagY, tagW, tagH, 4, color);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0f1117';
  ctx.font = `600 9px/1 'Inter', system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, tagX + 5, tagY + tagH / 2);
  ctx.textBaseline = 'alphabetic';
}

// Paged / rating layout: large image top, headline, content, Likert scale
function drawBackgroundPaged(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width  / SCALE;
  const H = canvas.height / SCALE;
  ctx.save();
  ctx.scale(SCALE, SCALE);

  // ── Base
  ctx.fillStyle = '#0b0e18';
  ctx.fillRect(0, 0, W, H);

  const pad = 14;
  const cW  = W - pad * 2;

  // Card
  roundRect(ctx, pad, H * 0.01, cW, H * 0.97, 10, '#141720');

  // Separator lines between sections
  const sepColor = 'rgba(255,255,255,0.04)';

  // ── AOI bands (paged/rating layout)
  const pagedRegions = [
    { name: 'avatar',   y0: 0.02, y1: 0.11 },
    { name: 'headline', y0: 0.11, y1: 0.30 },
    { name: 'image',    y0: 0.30, y1: 0.53 },
    { name: 'content',  y0: 0.53, y1: 0.65 },
    { name: 'metrics',  y0: 0.65, y1: 0.73 },
    { name: 'actions',  y0: 0.73, y1: 0.97 },
  ];
  ctx.save();
  ctx.font = `600 9px 'Inter', system-ui, sans-serif`;
  pagedRegions.forEach(({ name, y0, y1 }) => {
    drawAOIBand(ctx, name, pad + 2, H * y0, cW - 4, H * (y1 - y0));
  });
  ctx.restore();

  // ── Skeleton elements

  // Author / avatar row
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(pad + 18, H * 0.065, 13, 0, Math.PI * 2);
  ctx.fill();
  skeletonBar(ctx, pad + 38, H * 0.055, cW * 0.38, 8, 'rgba(255,255,255,0.12)');
  skeletonBar(ctx, pad + 38, H * 0.055 + 12, cW * 0.22, 6, 'rgba(255,255,255,0.07)');

  // Image block — gradient shimmer
  const imgGrad = ctx.createLinearGradient(pad, H * 0.30, pad + cW, H * 0.30);
  imgGrad.addColorStop(0,   'rgba(30,50,80,0.9)');
  imgGrad.addColorStop(0.5, 'rgba(25,40,70,0.9)');
  imgGrad.addColorStop(1,   'rgba(30,50,80,0.9)');
  ctx.fillStyle = imgGrad;
  ctx.fillRect(pad + 2, H * 0.30, cW - 4, H * 0.23);
  // tiny mountain icon
  ctx.globalAlpha = 0.18;
  ctx.font = `${W * 0.09}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('🏔', W / 2, H * 0.30 + H * 0.23 * 0.62);
  ctx.globalAlpha = 1;

  // Headline bars
  skeletonBar(ctx, pad + 8, H * 0.125, cW * 0.93, 12, 'rgba(255,255,255,0.18)');
  skeletonBar(ctx, pad + 8, H * 0.125 + 17, cW * 0.78, 12, 'rgba(255,255,255,0.14)');
  skeletonBar(ctx, pad + 8, H * 0.125 + 34, cW * 0.55, 12, 'rgba(255,255,255,0.09)');

  // Content bars
  skeletonBar(ctx, pad + 8, H * 0.54,      cW * 0.90, 8, 'rgba(255,255,255,0.10)');
  skeletonBar(ctx, pad + 8, H * 0.54 + 13, cW * 0.70, 8, 'rgba(255,255,255,0.07)');

  // Metrics pills
  [0, 1, 2].forEach(i => {
    roundRect(ctx, pad + 8 + i * (cW * 0.22 + 6), H * 0.675, cW * 0.22, 13, 6, 'rgba(255,255,255,0.06)');
  });

  // Likert circles (7)
  const lkY  = H * 0.855;
  const lkStep = cW / 8;
  for (let i = 0; i < 7; i++) {
    const cx = pad + lkStep * (i + 0.5);
    ctx.beginPath();
    ctx.arc(cx, lkY, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `bold 9px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, cx, lkY);
    ctx.textBaseline = 'alphabetic';
  }
  // Likert anchor labels
  ctx.font = `8px system-ui`;
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.textAlign = 'left';  ctx.fillText('Zdecydowanie\nniewiarygodny', pad + 6, lkY + 22);
  ctx.textAlign = 'right'; ctx.fillText('Zdecydowanie\nwiarygodny',   W - pad - 6, lkY + 22);
  ctx.textAlign = 'left';

  // Mode badge
  modeBadge(ctx, pad + 4, H * 0.978, '📋 Tryb oceny (paged)');

  ctx.restore();
}

function drawBackgroundFeed(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width  / SCALE;
  const H = canvas.height / SCALE;
  ctx.save();
  ctx.scale(SCALE, SCALE);

  // ── Base
  ctx.fillStyle = '#0b0e18';
  ctx.fillRect(0, 0, W, H);

  const pad = 12;
  const cW  = W - pad * 2;

  // Card
  roundRect(ctx, pad, H * 0.01, cW, H * 0.96, 10, '#141720');

  // ── AOI bands
  ctx.save();
  ctx.font = `600 9px 'Inter', system-ui, sans-serif`;
  Object.entries(AOI_REGIONS).forEach(([name, { y0, y1 }]) => {
    drawAOIBand(ctx, name, pad + 2, H * y0, cW - 4, H * (y1 - y0));
  });
  ctx.restore();

  // ── Skeleton elements

  // Avatar circle
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(pad + 22, H * 0.04 + 22, 16, 0, Math.PI * 2);
  ctx.fill();
  // Dot badge on avatar
  ctx.fillStyle = '#22d3ee';
  ctx.beginPath();
  ctx.arc(pad + 33, H * 0.04 + 36, 4, 0, Math.PI * 2);
  ctx.fill();

  // Author name bars
  skeletonBar(ctx, pad + 46, H * 0.04 + 14, cW * 0.40, 8, 'rgba(255,255,255,0.18)');
  skeletonBar(ctx, pad + 46, H * 0.04 + 27, cW * 0.26, 6, 'rgba(255,255,255,0.09)');

  // Headline bars (3 lines, prominent)
  skeletonBar(ctx, pad + 8, H * 0.165, cW * 0.88, 11, 'rgba(255,255,255,0.20)');
  skeletonBar(ctx, pad + 8, H * 0.165 + 16, cW * 0.82, 11, 'rgba(255,255,255,0.16)');
  skeletonBar(ctx, pad + 8, H * 0.165 + 32, cW * 0.52, 11, 'rgba(255,255,255,0.10)');

  // Image block — gradient shimmer
  const imgGrad = ctx.createLinearGradient(pad, H * 0.28, pad + cW, H * 0.28);
  imgGrad.addColorStop(0,   'rgba(22,42,72,0.95)');
  imgGrad.addColorStop(0.5, 'rgba(18,34,60,0.95)');
  imgGrad.addColorStop(1,   'rgba(22,42,72,0.95)');
  ctx.fillStyle = imgGrad;
  ctx.fillRect(pad + 2, H * 0.28, cW - 4, H * 0.33);
  ctx.globalAlpha = 0.20;
  ctx.font = `${W * 0.09}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('🏔', W / 2, H * 0.28 + H * 0.33 * 0.60);
  ctx.globalAlpha = 1;

  // Content lines
  skeletonBar(ctx, pad + 8, H * 0.632,      cW * 0.85, 8, 'rgba(255,255,255,0.11)');
  skeletonBar(ctx, pad + 8, H * 0.632 + 13, cW * 0.62, 8, 'rgba(255,255,255,0.07)');

  // Metric pills (3)
  [0, 1, 2].forEach(i => {
    roundRect(ctx, pad + 8 + i * (cW * 0.22 + 5), H * 0.752, cW * 0.22, 14, 7, 'rgba(255,255,255,0.06)');
    skeletonBar(ctx, pad + 8 + i * (cW * 0.22 + 5) + 5, H * 0.752 + 4, cW * 0.10, 6, 'rgba(255,255,255,0.10)');
  });

  // Action buttons (3)
  [0, 1, 2].forEach(i => {
    roundRect(ctx, pad + 8 + i * (cW * 0.27 + 4), H * 0.843, cW * 0.27, 22, 6, 'rgba(255,255,255,0.06)');
  });

  // Mode badge
  modeBadge(ctx, pad + 4, H * 0.978, '📜 Tryb feed');

  ctx.restore();
}

// ── tiny skeleton bar helper
function skeletonBar(ctx, x, y, w, h, fill) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = fill;
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// ── mode badge in footer
function modeBadge(ctx, x, y, text) {
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#818cf8';
  ctx.font = `500 9px 'Inter', system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// ── Canvas creation helper ─────────────────────────────────────────────────
function setupCanvas(canvasId, hostId) {
  const canvas = document.getElementById(canvasId);
  canvas.width  = CANVAS_W * SCALE;
  canvas.height = CANVAS_H * SCALE;
  canvas.style.width  = CANVAS_W + 'px';
  canvas.style.height = CANVAS_H + 'px';
  if (hostId) {
    const host = document.getElementById(hostId);
    host.style.width  = CANVAS_W + 'px';
    host.style.height = CANVAS_H + 'px';
  }
  return canvas;
}

// ── Heatmap legend / methodology hint ─────────────────────────────────────
function buildHintHTML(nPts, hasData) {
  const filterLabel = HV.postFilter !== 'all'
    ? document.getElementById('hv-post-filter').selectedOptions[0]?.text || ''
    : 'wszystkie posty';
  const modeLabel = { all: 'feed + ocena', feed: 'feed', paged: 'ocena' }[HV.modeFilter] || HV.modeFilter;

  // AOI color dots row
  const aoiDots = AOI_ORDER.filter(k => k !== 'other').map(k =>
    `<span style="display:inline-flex;align-items:center;gap:3px;white-space:nowrap">
       <span style="width:8px;height:8px;border-radius:50%;background:${AOI_COLORS[k]};flex-shrink:0;display:inline-block"></span>
       <span style="color:#94a3b8">${AOI_LABELS[k]}</span>
     </span>`
  ).join('');

  const noDataMsg = `<span style="color:#ef4444">Brak danych gaze dla wybranego filtra.</span>`;

  return `
<div style="display:flex;flex-direction:column;gap:0.55rem;padding:0.6rem 0.75rem;background:#13161f;border-radius:8px;border:1px solid #1e2235;font-size:0.76rem;line-height:1.5">

  <!-- Row 1: stats -->
  <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
    ${hasData
      ? `<span style="color:#e2e8f0;font-weight:600">${nPts} próbek gaze</span>
         <span style="color:#64748b">·</span>
         <span style="color:#94a3b8">${filterLabel}</span>
         <span style="color:#64748b">·</span>
         <span style="color:#94a3b8">tryb: ${modeLabel}</span>`
      : noDataMsg
    }
  </div>

  <!-- Row 2: colour scale -->
  <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">
    <span style="color:#64748b;white-space:nowrap">Intensywność fiksacji:</span>
    <span style="color:#60a5fa;white-space:nowrap;font-weight:500">niska</span>
    <span style="background:linear-gradient(to right,#1e40ff,#06b6d4,#22c55e,#facc15,#ef4444);
                 width:100px;height:8px;border-radius:4px;display:inline-block;flex-shrink:0"></span>
    <span style="color:#ef4444;white-space:nowrap;font-weight:500">wysoka</span>
  </div>

  <!-- Row 3: methodology one-liner -->
  <details style="color:#64748b;cursor:pointer">
    <summary style="list-style:none;display:flex;align-items:center;gap:0.3rem;cursor:pointer;color:#64748b;font-size:0.72rem">
      <span style="color:#818cf8">ℹ</span> Jak to działa? <span style="font-size:0.65rem;opacity:.7">(rozwiń)</span>
    </summary>
    <div style="margin-top:0.4rem;color:#94a3b8;font-size:0.72rem;line-height:1.65;padding-left:0.5rem;border-left:2px solid #2d3148">
      Każdy zarejestrowany punkt wzroku (<em>gaze sample</em>) generuje gaussowski „pagórek"
      o promieniu σ&nbsp;≈&nbsp;14&nbsp;px. Wszystkie pagórki są sumowane w buforze Float32,
      a następnie normalizowane względem maksymalnej wartości. Znormalizowana wartość
      0→1 jest mapowana na gradient temperatury: niebieski (0) → cyjan → zielony → żółty → czerwony (1).
      Przezroczystość piksela rośnie proporcjonalnie, więc obszary z jedną fiksacją są
      półprzezroczyste, a miejsca wielokrotnie oglądane świecą intensywnie.
      Próbkowanie: ~12 Hz (co 80 ms). Koordynaty są znormalizowane do rozdzielczości
      okna przeglądarki uczestnika, a następnie przeskalowane do siatki ${CANVAS_W}×${CANVAS_H} px.
    </div>
  </details>

  <!-- Row 4: AOI colour key -->
  <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
    <span style="color:#64748b;white-space:nowrap;font-size:0.72rem">Obszary (AOI):</span>
    <div style="display:flex;gap:0.55rem;flex-wrap:wrap;font-size:0.72rem">${aoiDots}</div>
  </div>

</div>`;
}

// ── Heatmap (canvas-based Gaussian KDE — no external library) ──────────────
function renderHeatmap(pts, mode = 'feed') {
  const canvas = setupCanvas('hm-canvas');
  drawBackground(canvas, mode);

  const hint = document.getElementById('hm-hint');
  if (!pts.length) {
    hint.innerHTML = buildHintHTML(0, false);
    return;
  }

  drawGaussianHeatmap(canvas, pts);
  hint.innerHTML = buildHintHTML(pts.length, true);
}

function drawGaussianHeatmap(canvas, pts) {
  const W   = CANVAS_W * SCALE;
  const H   = CANVAS_H * SCALE;
  const R   = 36 * SCALE;  // gaussian radius in physical pixels

  // Accumulation buffer
  const buf = new Float32Array(W * H);
  let maxVal = 0;

  pts.forEach(p => {
    const cx = Math.round(p.cx * SCALE);
    const cy = Math.round(p.cy * SCALE);
    const x0 = Math.max(0, cx - R), x1 = Math.min(W - 1, cx + R);
    const y0 = Math.max(0, cy - R), y1 = Math.min(H - 1, cy + R);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 > R * R) continue;
        const v = Math.exp(-d2 / (2 * (R / 2.5) ** 2));
        const idx = y * W + x;
        buf[idx] += v;
        if (buf[idx] > maxVal) maxVal = buf[idx];
      }
    }
  });

  if (maxVal === 0) return;

  // Colorise
  const ctx    = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, W, H);
  const pix    = imgData.data;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] < 0.001) continue;
    const t   = Math.min(1, buf[i] / maxVal);
    const [r, g, b] = heatRGB(t);
    const alpha = Math.round(Math.min(230, t * 255 * 1.4 + 30));
    const px  = i * 4;
    // Blend over existing background pixel
    const a   = alpha / 255;
    pix[px]     = Math.round(pix[px]     * (1 - a) + r * a);
    pix[px + 1] = Math.round(pix[px + 1] * (1 - a) + g * a);
    pix[px + 2] = Math.round(pix[px + 2] * (1 - a) + b * a);
    // alpha stays 255 (background is opaque)
  }

  ctx.putImageData(imgData, 0, 0);
}

// Blue→Cyan→Green→Yellow→Red gradient
function heatRGB(t) {
  const stops = [
    [0,    [  0,   0, 255]],
    [0.25, [  0, 200, 255]],
    [0.50, [  0, 255, 100]],
    [0.75, [255, 230,   0]],
    [1.0,  [255,  30,   0]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const lo = stops[i - 1], hi = stops[i];
      const f  = (t - lo[0]) / (hi[0] - lo[0]);
      return lo[1].map((v, j) => Math.round(v + (hi[1][j] - v) * f));
    }
  }
  return stops[stops.length - 1][1];
}

// ── Scanpath ───────────────────────────────────────────────────────────────
function renderScanpath(pts, mode = 'feed') {
  const canvas = setupCanvas('sp-canvas');
  drawBackground(canvas, mode);
  if (!pts.length) return;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(SCALE, SCALE);

  const fixations = computeFixations(pts);
  const n = fixations.length;
  if (!n) { ctx.restore(); return; }

  // Draw saccade lines
  ctx.lineWidth = 1.2;
  ctx.globalAlpha = 0.45;
  for (let i = 1; i < n; i++) {
    const a = fixCenter(fixations[i - 1]);
    const b = fixCenter(fixations[i]);
    const t = i / n;
    ctx.strokeStyle = lerpColor('#4fc3f7', '#ef5350', t);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Draw fixation circles
  fixations.forEach((fix, i) => {
    const { x, y } = fixCenter(fix);
    const dur = (fix[fix.length - 1].t - fix[0].t) || 80;
    const r   = Math.min(24, Math.max(6, dur / 40));
    const t   = i / Math.max(n - 1, 1);
    const col = lerpColor('#4fc3f7', '#ef5350', t);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = col + '55';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fixation number
    if (r > 9) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.min(10, r * 0.85)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i + 1, x, y);
    }
  });

  ctx.restore();
}

function computeFixations(pts, spatThreshold = 48) {
  if (!pts.length) return [];
  const fixations = [];
  let group = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = group[group.length - 1];
    const d = Math.hypot(pts[i].cx - prev.cx, pts[i].cy - prev.cy);
    if (d < spatThreshold) {
      group.push(pts[i]);
    } else {
      if (group.length >= 2) fixations.push(group);
      group = [pts[i]];
    }
  }
  if (group.length >= 2) fixations.push(group);
  return fixations;
}

function fixCenter(fix) {
  const x = fix.reduce((s, p) => s + p.cx, 0) / fix.length;
  const y = fix.reduce((s, p) => s + p.cy, 0) / fix.length;
  return { x, y };
}

function lerpColor(hex1, hex2, t) {
  const a = hexToRgb(hex1), b = hexToRgb(hex2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ── Playback ───────────────────────────────────────────────────────────────
function setupPlaybackControls() {
  const playBtn  = document.getElementById('pb-play');
  const timeline = document.getElementById('pb-timeline');
  const speedSel = document.getElementById('pb-speed');

  playBtn.addEventListener('click', () => {
    if (HV.playback.playing) stopPlayback();
    else startPlayback();
  });

  timeline.addEventListener('input', () => {
    const { points } = HV.playback;
    if (!points.length) return;
    const total = points[points.length - 1].t - points[0].t;
    const seekT = points[0].t + (timeline.value / 1000) * total;
    HV.playback.startGaze = seekT;
    HV.playback.startReal = performance.now();
    if (!HV.playback.playing) drawPlaybackFrame(seekT, points);
  });

  speedSel.addEventListener('change', () => {
    HV.playback.speed = parseFloat(speedSel.value);
    if (HV.playback.playing) {
      // Reset start reference so speed change is seamless
      const now = performance.now();
      HV.playback.startReal = now;
    }
  });
}

function preparePlayback(pts, mode = 'feed') {
  stopPlayback();
  const canvas = setupCanvas('pb-canvas');
  drawBackground(canvas, mode);
  HV.playback.mode   = mode;
  HV.playback.points = pts;
  HV.playback.speed  = parseFloat(document.getElementById('pb-speed').value);
  if (!pts.length) return;
  updateTimeLabel(pts[0].t, pts);
  document.getElementById('pb-timeline').value = 0;
}

function startPlayback() {
  const { points } = HV.playback;
  if (!points.length) return;
  HV.playback.playing   = true;
  HV.playback.startReal = performance.now();
  HV.playback.startGaze = points[0].t;
  document.getElementById('pb-play').textContent = '⏸';
  tickPlayback();
}

function stopPlayback() {
  HV.playback.playing = false;
  if (HV.playback.raf) { cancelAnimationFrame(HV.playback.raf); HV.playback.raf = null; }
  document.getElementById('pb-play').textContent = '▶';
}

function tickPlayback() {
  if (!HV.playback.playing) return;
  const { points, startReal, startGaze, speed } = HV.playback;
  const elapsed = (performance.now() - startReal) * speed;
  const currentT = startGaze + elapsed;
  drawPlaybackFrame(currentT, points);

  const total = points[points.length - 1].t - points[0].t;
  const progress = Math.min(1, (currentT - points[0].t) / total);
  document.getElementById('pb-timeline').value = Math.round(progress * 1000);
  updateTimeLabel(currentT, points);

  if (currentT >= points[points.length - 1].t) {
    stopPlayback();
    return;
  }
  HV.playback.raf = requestAnimationFrame(tickPlayback);
}

function drawPlaybackFrame(currentT, points) {
  const canvas = document.getElementById('pb-canvas');
  drawBackground(canvas, HV.playback.mode || 'feed');
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(SCALE, SCALE);

  // Trail: last 20 points before currentT
  const past = points.filter(p => p.t <= currentT).slice(-25);

  if (past.length > 1) {
    for (let i = 1; i < past.length; i++) {
      const a = past[i - 1], b = past[i];
      const alpha = 0.08 + 0.35 * (i / past.length);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#818cf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.cx, a.cy);
      ctx.lineTo(b.cx, b.cy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Cursor dot
  const nearest = findNearest(points, currentT);
  if (nearest) {
    // Outer glow
    ctx.beginPath();
    ctx.arc(nearest.cx, nearest.cy, 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(129,140,248,0.18)';
    ctx.fill();
    // Inner dot
    ctx.beginPath();
    ctx.arc(nearest.cx, nearest.cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#818cf8';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // AOI label
    if (nearest.aoi && nearest.aoi !== 'other') {
      ctx.fillStyle = AOI_COLORS[nearest.aoi] || '#64748b';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(AOI_LABELS[nearest.aoi] || nearest.aoi, nearest.cx, nearest.cy - 10);
    }
  }

  ctx.restore();
}

function findNearest(points, t) {
  if (!points.length) return null;
  let best = points[0], bestD = Math.abs(points[0].t - t);
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestD) { bestD = d; best = p; }
    if (p.t > t + 500) break;
  }
  return best;
}

function updateTimeLabel(currentT, points) {
  const elapsed = Math.max(0, (currentT - points[0].t) / 1000);
  const total   = (points[points.length - 1].t - points[0].t) / 1000;
  document.getElementById('pb-time').textContent =
    `${elapsed.toFixed(1)}s / ${total.toFixed(1)}s`;
}

// ── Compare ────────────────────────────────────────────────────────────────
function setupCompare() {
  document.getElementById('cmp-go').addEventListener('click', runCompare);
  document.getElementById('cmp-back').addEventListener('click', () => {
    document.getElementById('cmp-result').hidden   = true;
    document.getElementById('cmp-selector').hidden = false;
  });
}

function populateCompareList() {
  HV.compareSelected.clear();
  const list = document.getElementById('cmp-list');
  list.innerHTML = '';
  HV.allSessions.forEach(s => {
    const item = document.createElement('label');
    item.className = 'cmp-item';
    item.innerHTML = `
      <input type="checkbox" value="${s.id}">
      <span class="cmp-item-label">#${s.id} · ${s.full_condition || '—'}</span>
      <span class="cmp-item-pts">${s.n_gaze_pts} pkt</span>`;
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (HV.compareSelected.size >= 4) { cb.checked = false; return; }
        HV.compareSelected.add(s.id);
        item.classList.add('selected');
      } else {
        HV.compareSelected.delete(s.id);
        item.classList.remove('selected');
      }
      document.getElementById('cmp-go').disabled = HV.compareSelected.size < 2;
    });
    list.appendChild(item);
  });
}

async function runCompare() {
  const ids = [...HV.compareSelected];
  const btn = document.getElementById('cmp-go');
  btn.disabled = true;
  btn.textContent = 'Ładowanie…';
  try {
    HV.compareData = await Promise.all(ids.map(id => apiFetch(`/api/admin/gaze-data/${id}`)));
    renderCompare();
    document.getElementById('cmp-selector').hidden = true;
    document.getElementById('cmp-result').hidden   = false;
  } catch (e) {
    console.error('runCompare:', e);
  }
  btn.disabled = false;
  btn.textContent = 'Pokaż porównanie →';
}

function renderCompare() {
  const wrap = document.getElementById('cmp-heatmaps');
  wrap.innerHTML = '';
  const sz = Math.max(200, Math.floor((window.innerWidth - 360) / HV.compareData.length) - 20);
  const cW  = sz;
  const cH  = Math.round(sz * (CANVAS_H / CANVAS_W));

  HV.compareData.forEach(({ session, gaze }) => {
    const filtered = HV.postFilter !== 'all' ? gaze.filter(g => g.post_id === parseInt(HV.postFilter)) : gaze;
    const normed   = normaliseGaze(filtered);

    const col = document.createElement('div');
    col.className = 'cmp-col';

    const label = document.createElement('div');
    label.className = 'cmp-col-label';
    label.textContent = `#${session.id} · ${session.full_condition || '—'} · ${filtered.length} pkt`;
    col.appendChild(label);

    const host = document.createElement('div');
    host.className = 'hv-canvas-host';
    host.style.width  = cW + 'px';
    host.style.height = cH + 'px';

    const bgCanvas = document.createElement('canvas');
    bgCanvas.width  = cW * SCALE;
    bgCanvas.height = cH * SCALE;
    bgCanvas.style.width  = cW + 'px';
    bgCanvas.style.height = cH + 'px';

    // Scale background drawing to compare canvas size
    drawBackgroundScaled(bgCanvas, cW, cH);
    host.appendChild(bgCanvas);

    if (normed.length) {
      const heatDiv = document.createElement('div');
      heatDiv.style.cssText = `position:absolute;top:0;left:0;width:${cW}px;height:${cH}px;pointer-events:none`;
      host.appendChild(heatDiv);

      // Scale gaze coords to compare canvas size
      const scaledPts = normed.map(p => ({
        x: Math.round(p.cx * (cW / CANVAS_W)),
        y: Math.round(p.cy * (cH / CANVAS_H)),
        value: 1,
      }));
      const hm = h337.create({
        container:  heatDiv,
        radius:     Math.round(38 * cW / CANVAS_W),
        maxOpacity: 0.78, minOpacity: 0.0, blur: 0.82,
        gradient: { 0.0: '#000080', 0.2: '#0000ff', 0.45: '#00ffff',
                    0.65: '#00ff00', 0.82: '#ffff00', 1.0: '#ff0000' },
      });
      hm.setData({ max: 8, data: scaledPts });
    }

    col.appendChild(host);
    wrap.appendChild(col);
  });
}

function drawBackgroundScaled(canvas, W, H) {
  // Save real CANVAS_W/H and temporarily draw at target size
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(SCALE * W / CANVAS_W, SCALE * H / CANVAS_H);
  // Temporarily override canvas.width/height for drawBackground
  const origW = canvas.width, origH = canvas.height;
  canvas.width  = CANVAS_W * SCALE;
  canvas.height = CANVAS_H * SCALE;
  drawBackground(canvas);
  canvas.width  = origW;
  canvas.height = origH;
  ctx.restore();

  // Re-draw at native size
  const tmp = document.createElement('canvas');
  tmp.width  = CANVAS_W * SCALE;
  tmp.height = CANVAS_H * SCALE;
  drawBackground(tmp);
  ctx.drawImage(tmp, 0, 0, W * SCALE, H * SCALE);
}

// ── AOI Table ──────────────────────────────────────────────────────────────
function renderAOI(rawPts) {
  const { posts } = HV.currentSession;
  const postMap = {};
  posts.forEach(p => { postMap[p.id] = p; });

  const wrap = document.getElementById('aoi-content');
  wrap.innerHTML = '';

  // Group by post
  const byPost = {};
  rawPts.forEach(p => {
    const key = p.post_id != null ? p.post_id : '__other__';
    if (!byPost[key]) byPost[key] = [];
    byPost[key].push(p);
  });

  // Sort keys: post ids by order, then __other__
  const sortedKeys = Object.keys(byPost).sort((a, b) => {
    if (a === '__other__') return 1;
    if (b === '__other__') return -1;
    const oa = postMap[a]?.post_order ?? 99;
    const ob = postMap[b]?.post_order ?? 99;
    return oa - ob;
  });

  if (!sortedKeys.length) {
    wrap.innerHTML = '<p style="color:#64748b;font-size:.82rem">Brak danych.</p>';
    return;
  }

  sortedKeys.forEach(key => {
    const pts = byPost[key];
    const post = key !== '__other__' ? postMap[key] : null;
    const block = document.createElement('div');
    block.className = 'aoi-post-block';

    const title = document.createElement('div');
    title.className = 'aoi-post-title';
    if (post) {
      title.textContent = `Post ${post.post_order || '?'}: ${(post.headline || '—').slice(0, 60)}`;
    } else {
      title.textContent = 'Inne ekrany';
    }
    block.appendChild(title);

    // Count per AOI
    const counts = {};
    AOI_ORDER.forEach(a => { counts[a] = 0; });
    pts.forEach(p => { counts[p.aoi || 'other'] = (counts[p.aoi || 'other'] || 0) + 1; });
    const total = pts.length || 1;
    const maxCount = Math.max(...Object.values(counts));

    const table = document.createElement('table');
    table.className = 'aoi-table';
    table.innerHTML = `<thead><tr>
      <th>AOI</th>
      <th>Próbki</th>
      <th>%</th>
      <th style="width:130px">Udział</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');

    AOI_ORDER.forEach(aoi => {
      if (!counts[aoi]) return;
      const pct = (counts[aoi] / total * 100).toFixed(1);
      const barW = maxCount > 0 ? Math.round((counts[aoi] / maxCount) * 100) : 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="aoi-name"><span class="aoi-dot aoi-dot-${aoi}"></span>${AOI_LABELS[aoi] || aoi}</td>
        <td>${counts[aoi]}</td>
        <td class="aoi-pct">${pct}%</td>
        <td><div class="aoi-bar-wrap"><div class="aoi-bar-fill" style="width:${barW}%;background:${AOI_COLORS[aoi]}"></div></div></td>`;
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    block.appendChild(table);
    wrap.appendChild(block);
  });
}
