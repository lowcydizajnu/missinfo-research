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
  headline: '#f59e0b', content: '#10b981', image: '#3b82f6',
  metrics:  '#8b5cf6', actions: '#ec4899', avatar: '#06b6d4', other: '#475569',
};

// ── State ──────────────────────────────────────────────────────────────────
const HV = {
  token:          localStorage.getItem('admin_token'),
  studies:        [],
  studyId:        null,
  allSessions:    [],   // sessions with gaze data for selected study
  currentSession: null, // { session, gaze, posts, feedSnapshot }
  postFilter:     'all',
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
})();

// ── API helpers ────────────────────────────────────────────────────────────
function apiFetch(path) {
  return fetch(path, { headers: { Authorization: `Bearer ${HV.token}` } })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
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
        el.innerHTML = `
          <div class="hv-session-item-id">#${s.id}</div>
          <div class="hv-session-item-cond">${s.full_condition || '—'}</div>
          <div class="hv-session-item-pts">${s.n_gaze_pts} pkt gaze${s.calibration_error != null ? ` · ±${Math.round(s.calibration_error)}px` : ''}</div>`;
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
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = p ? `Post ${p.post_order || '?'}: ${(p.headline || '').slice(0, 40)}` : `Post #${pid}`;
    sel.appendChild(opt);
  });

  HV.postFilter = 'all';
  sel.value = 'all';
  document.getElementById('hv-post-ctrl').hidden = false;
}

function filterGaze(gaze) {
  if (HV.postFilter === 'all') return gaze;
  const pid = parseInt(HV.postFilter);
  return gaze.filter(g => g.post_id === pid);
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
  const normed    = normaliseGaze(filtered);
  switch (HV.activeTab) {
    case 'heatmap':  renderHeatmap(normed);  break;
    case 'scanpath': renderScanpath(normed); break;
    case 'playback': preparePlayback(normed); break;
    case 'aoi':      renderAOI(filtered);    break;
    case 'compare':  /* handled by compare UI */ break;
  }
}

// ── Background schematic ───────────────────────────────────────────────────
function drawBackground(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width  / SCALE;
  const H = canvas.height / SCALE;
  ctx.save();
  ctx.scale(SCALE, SCALE);

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);

  // Post card background
  const pad = 12;
  roundRect(ctx, pad, H * 0.02, W - pad * 2, H * 0.92, 10, '#1a1d2e');

  // Draw each AOI region as a tinted band
  Object.entries(AOI_REGIONS).forEach(([name, { y0, y1 }]) => {
    const color = AOI_COLORS[name] || '#475569';
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = color;
    ctx.fillRect(pad + 2, H * y0, W - pad * 2 - 4, H * (y1 - y0));
    ctx.globalAlpha = 1;
    // Label
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.font = `bold ${Math.max(9, W * 0.023)}px system-ui`;
    ctx.textAlign = 'right';
    ctx.fillText(AOI_LABELS[name] || name, W - pad - 6, H * y0 + (H * (y1 - y0)) / 2 + 4);
    ctx.globalAlpha = 1;
  });

  // Avatar circle
  ctx.fillStyle = '#2d3748';
  ctx.beginPath();
  ctx.arc(pad + 26, H * 0.04 + 22, 18, 0, Math.PI * 2);
  ctx.fill();

  // Author name bars
  ctx.fillStyle = '#2d3748';
  ctx.fillRect(pad + 52, H * 0.04 + 12, W * 0.38, 9);
  ctx.fillRect(pad + 52, H * 0.04 + 26, W * 0.25, 7);

  // Headline lines
  [0, 1, 2].forEach(i => {
    const width = i === 2 ? W * 0.55 : W * 0.82;
    ctx.fillStyle = '#374151';
    ctx.fillRect(pad + 8, H * 0.16 + i * 20, width, 11);
  });

  // Image placeholder
  ctx.fillStyle = '#1e2a3a';
  ctx.fillRect(pad + 2, H * 0.28, W - pad * 2 - 4, H * 0.33);
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#3b82f6';
  ctx.font = `${W * 0.1}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('🖼', W / 2, H * 0.28 + H * 0.33 * 0.6);
  ctx.globalAlpha = 1;

  // Content lines
  ctx.fillStyle = '#2d3748';
  ctx.fillRect(pad + 8, H * 0.63, W * 0.82, 9);
  ctx.fillRect(pad + 8, H * 0.65, W * 0.62, 9);

  // Metric pills
  [0, 1, 2].forEach(i => {
    roundRect(ctx, pad + 8 + i * (W * 0.22 + 4), H * 0.75, W * 0.22, 14, 7, '#1e2235');
  });

  // Action buttons
  [0, 1, 2].forEach(i => {
    roundRect(ctx, pad + 8 + i * (W * 0.26 + 4), H * 0.84, W * 0.26, 20, 6, '#1e2235');
  });

  ctx.restore();
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

// ── Heatmap ────────────────────────────────────────────────────────────────
function renderHeatmap(pts) {
  const bgCanvas = setupCanvas('hm-bg', 'hm-host');
  drawBackground(bgCanvas);

  const heatDiv = document.getElementById('hm-heat');
  heatDiv.style.width  = CANVAS_W + 'px';
  heatDiv.style.height = CANVAS_H + 'px';
  heatDiv.innerHTML = '';  // destroy old heatmap.js instance

  if (!pts.length) {
    document.getElementById('hm-hint').textContent = 'Brak danych gaze dla wybranego filtra.';
    return;
  }

  const hm = h337.create({
    container:  heatDiv,
    radius:     38,
    maxOpacity: 0.78,
    minOpacity: 0.0,
    blur:       0.82,
    gradient: { 0.0: '#000080', 0.2: '#0000ff', 0.45: '#00ffff',
                0.65: '#00ff00', 0.82: '#ffff00', 1.0: '#ff0000' },
  });
  HV.heatmapInst = hm;

  hm.setData({
    max: 8,
    data: pts.map(p => ({ x: p.cx, y: p.cy, value: 1 })),
  });

  const hint = document.getElementById('hm-hint');
  hint.textContent = `${pts.length} próbek gaze`;
  if (HV.postFilter !== 'all') {
    const postLabel = document.getElementById('hv-post-filter').selectedOptions[0]?.text || '';
    hint.textContent += ` · ${postLabel}`;
  }
}

// ── Scanpath ───────────────────────────────────────────────────────────────
function renderScanpath(pts) {
  const canvas = setupCanvas('sp-canvas');
  drawBackground(canvas);
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

function preparePlayback(pts) {
  stopPlayback();
  const canvas = setupCanvas('pb-canvas');
  drawBackground(canvas);
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
  drawBackground(canvas);
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
