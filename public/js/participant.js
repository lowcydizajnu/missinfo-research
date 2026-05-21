'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  config: null,        // window.STUDY_CONFIG
  session: null,       // {token, style_condition, metric_condition, posts, study}
  posts: [],           // posts for this session
  // Feed mode
  reactions: {},       // {postId: action}
  dwellStart: {},      // {postId: Date.now() when entered viewport}
  dwellAccum: {},      // {postId: accumulated ms}
  ratingIndex: 0,
  ratingValues: {},
  // Paged mode
  pagedIndex: 0,
  pagedRatings: {},    // {postId: 1-7}
  pagedReactions: {},  // {postId: action}
  pagedDwellStart: {}, // {postId: timestamp when shown}
  pagedComments: {},   // {postId: string} — participant comment (custom layout)
};

// ── Helpers ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

function formatNum(n) {
  return Number(n).toLocaleString('pl-PL');
}

function topicClass(topic) {
  const map = { zdrowie: 'topic-zdrowie', klimat: 'topic-klimat', polityka: 'topic-polityka', ekonomia: 'topic-ekonomia', nauka: 'topic-nauka' };
  return map[topic] || 'topic-nauka';
}

function avatarInitials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function avatarHTML(name, url, extraClass = '') {
  if (url) return `<img class="post-avatar post-avatar-img${extraClass ? ' ' + extraClass : ''}" src="${esc(url)}" alt="${esc(name)}">`;
  return `<div class="post-avatar${extraClass ? ' ' + extraClass : ''}">${avatarInitials(name)}</div>`;
}

function showError(msg) {
  $('error-message').textContent = msg;
  showScreen('screen-error');
}

// ── Init ───────────────────────────────────────────────────────────────────
(function init() {
  const cfg = window.STUDY_CONFIG;
  if (!cfg) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;color:#888;background:#f4f6fb"><p>Proszę uzyskać dostęp przez URL badania.</p></div>';
    return;
  }
  S.config = cfg;
  sessionStorage.clear();
  startSession();
})();

// ── Eye-tracking (WebGazer) ────────────────────────────────────────────────
// ISOLATION: all ET code is guarded by ET.enabled — studies with
// eyetracking_enabled=false never load WebGazer, never show calibration screens.
const ET = {
  enabled:         false,  // set from study.eyetracking_enabled in startSession()
  consented:       false,  // participant agreed to camera
  gazeBuffer:      [],     // pending gaze points (flushed in batches)
  flushTimer:      null,
  currentPostId:   null,
  currentPostOrder:null,
  currentScreen:   null,
  paused:          true,   // start paused; resume after calibration
  calibrated:      false,
  lastCalibTime:   0,
  recalibCount:    0,
  postsSinceCalib: 0,
  startTs:         0,      // Date.now() when eye-tracking started
  calIndex:        0,      // current calibration dot index
};

const WEBGAZER_CDN   = 'https://webgazer.cs.brown.edu/webgazer.js';
const GAZE_THROTTLE  = 80;   // ms between stored samples (~12.5 Hz)
const GAZE_BATCH_MAX = 60;   // flush when buffer reaches this size
const GAZE_FLUSH_MS  = 3000; // flush every N ms regardless
const RECALIB_POSTS  = 4;    // recalibrate after N posts in paged mode
const RECALIB_MS     = 5 * 60 * 1000; // …or after 5 minutes

let _lastGazeTs = 0; // timestamp of last stored sample

function loadWebGazer() {
  return new Promise((resolve, reject) => {
    if (window.webgazer) return resolve(window.webgazer);
    const s = document.createElement('script');
    s.src = WEBGAZER_CDN;
    s.async = true;
    s.onload  = () => window.webgazer ? resolve(window.webgazer) : reject(new Error('webgazer not found'));
    s.onerror = () => reject(new Error('WebGazer CDN load failed'));
    document.head.appendChild(s);
  });
}

function detectAOI(x, y) {
  // Returns the named area-of-interest that contains viewport point (x, y).
  //
  // Selector coverage:
  //   feed layout   → .post-* classes (multiple cards in DOM)
  //   paged layout  → #paged-* ids (single post per screen)
  //   rating layout → #rating-* ids + #likert-buttons
  const checks = [
    { name: 'headline', sels: [
        '.post-headline', '#paged-headline', '#rating-headline',
    ]},
    { name: 'content',  sels: [
        '.post-content',  '#paged-content',  '#rating-content',
    ]},
    { name: 'image',    sels: [
        '.post-image', '.post-image img',    // feed (wrapper + img)
        '#paged-image-wrap', '#paged-image', // paged
        // rating screen has no image element
    ]},
    { name: 'metrics',  sels: [
        '.post-metrics', '#paged-metrics',
    ]},
    { name: 'actions',  sels: [
        '.post-actions', '#paged-actions',
        '#paged-likert-buttons',             // paged Likert scale
        '#likert-buttons',                   // rating Likert scale
    ]},
    { name: 'avatar',   sels: [
        '.post-avatar', '.post-avatar-img',  // feed avatars
        '#paged-avatar',                     // paged avatar
        '#rating-source', '#rating-handle',  // rating author line (no avatar img)
        '#rating-topic-pill',                // rating topic badge (part of header)
    ]},
  ];

  const vh = window.innerHeight;

  for (const { name, sels } of checks) {
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        // Skip zero-size elements (display:none, visibility:hidden, collapsed)
        if (r.width === 0 || r.height === 0) continue;
        // Skip elements fully outside viewport (off-screen feed posts)
        if (r.bottom < 0 || r.top > vh) continue;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return name;
      }
    }
  }
  return 'other';
}

function startGazeListener() {
  webgazer.setGazeListener((data) => {
    if (!data || ET.paused || !ET.consented) return;
    const now = Date.now();
    if (now - _lastGazeTs < GAZE_THROTTLE) return;
    _lastGazeTs = now;
    ET.gazeBuffer.push({
      post_id:      ET.currentPostId,
      post_order:   ET.currentPostOrder,
      screen_name:  ET.currentScreen,
      t:            now - ET.startTs,
      x:            Math.round(data.x),
      y:            Math.round(data.y),
      vw:           window.innerWidth,
      vh:           window.innerHeight,
      scroll_y:     Math.round(window.scrollY),
      aoi:          detectAOI(data.x, data.y),
    });
    if (ET.gazeBuffer.length >= GAZE_BATCH_MAX) flushGaze();
  });
}

function flushGaze() {
  if (!ET.gazeBuffer.length || !ET.consented || !S.session) return;
  const pts = ET.gazeBuffer.splice(0);
  apiPost('/api/gaze', { session_token: S.session.session_token, points: pts }).catch(() => {});
}

function startGazeFlushTimer() {
  if (ET.flushTimer) clearInterval(ET.flushTimer);
  ET.flushTimer = setInterval(() => { if (ET.gazeBuffer.length) flushGaze(); }, GAZE_FLUSH_MS);
}

function storeEyetrackingConsent(consented, calibrationError) {
  if (!S.session) return;
  apiPost('/api/session/eyetracking-consent', {
    session_token:    S.session.session_token,
    eyetracking_consent: consented,
    calibration_error:   calibrationError ?? null,
    n_recalibrations:    ET.recalibCount,
  }).catch(() => {});
}

function shouldRecalibrate() {
  return ET.postsSinceCalib >= RECALIB_POSTS ||
         (Date.now() - ET.lastCalibTime) >= RECALIB_MS;
}

// ── 9-point calibration ────────────────────────────────────────────────────
const CAL_POSITIONS = [
  [10, 10], [50, 10], [90, 10],
  [10, 50], [50, 50], [90, 50],
  [10, 90], [50, 90], [90, 90],
];

function runCalibration(onComplete) {
  ET.calIndex = 0;
  const wrap = $('cal-dots-wrap');
  const instr = $('cal-instructions');
  wrap.innerHTML = '';

  CAL_POSITIONS.forEach(([xPct, yPct], i) => {
    const dot = document.createElement('div');
    dot.className = 'cal-dot';
    dot.id = 'cal-dot-' + i;
    dot.style.left = xPct + 'vw';
    dot.style.top  = yPct + 'vh';
    dot.style.display = i === 0 ? 'flex' : 'none';
    dot.addEventListener('click', () => {
      if (i !== ET.calIndex) return;
      dot.classList.add('done');
      ET.calIndex++;
      const fill = $('cal-progress-fill');
      if (fill) fill.style.width = `${(ET.calIndex / 9) * 100}%`;
      const next = $('cal-dot-' + ET.calIndex);
      if (next) {
        setTimeout(() => {
          dot.style.display = 'none';
          next.style.display = 'flex';
          const numEl = $('cal-dot-num');
          if (numEl) numEl.textContent = ET.calIndex + 1;
        }, 180);
      } else {
        // All 9 clicked → validate
        setTimeout(() => _runCalibrationValidation(onComplete), 300);
      }
    });
    wrap.appendChild(dot);
  });

  if (instr) instr.innerHTML = 'Spójrz na punkt i kliknij go.<br>Punkt <strong id="cal-dot-num">1</strong> z 9';
  const fill = $('cal-progress-fill');
  if (fill) fill.style.width = '0%';
}

async function _runCalibrationValidation(onComplete) {
  const wrap = $('cal-dots-wrap');
  const instr = $('cal-instructions');
  wrap.innerHTML = '';
  if (instr) instr.innerHTML = '<span>Sprawdzam dokładność kalibracji…</span>';
  await new Promise(r => setTimeout(r, 900));

  const valPts = [[25, 25], [75, 50], [50, 75]];
  let totalErr = 0, measured = 0;

  for (const [xPct, yPct] of valPts) {
    wrap.innerHTML = '';
    const dot = document.createElement('div');
    dot.className = 'cal-dot cal-dot-validation';
    dot.style.left = xPct + 'vw';
    dot.style.top  = yPct + 'vh';
    wrap.appendChild(dot);
    if (instr) instr.textContent = 'Spójrz na punkt…';
    await new Promise(r => setTimeout(r, 1800));
    try {
      const pred = await webgazer.getCurrentPrediction();
      if (pred) {
        const tx = (xPct / 100) * window.innerWidth;
        const ty = (yPct / 100) * window.innerHeight;
        totalErr += Math.sqrt((pred.x - tx) ** 2 + (pred.y - ty) ** 2);
        measured++;
      }
    } catch (_) {}
  }

  wrap.innerHTML = '';
  const avgErr = measured > 0 ? Math.round(totalErr / measured) : null;
  const fill = $('cal-progress-fill');
  if (fill) fill.style.width = '100%';

  // Offer retry if error > 180px and recalibrations < 2
  if ((avgErr === null || avgErr > 180) && ET.recalibCount < 2) {
    if (instr) instr.innerHTML = `
      <span>Kalibracja niedokładna${avgErr ? ` (błąd: ${avgErr}px)` : ''}. Spróbuj ponownie lub kontynuuj bez śledzenia wzroku.</span>
      <div style="margin-top:1.25rem;display:flex;gap:1rem;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="cal-retry-btn">Kalibruj ponownie</button>
        <button class="btn btn-ghost" id="cal-skip-btn" style="color:#9aa;border-color:#334">Pomiń śledzenie</button>
      </div>`;
    $('cal-retry-btn').onclick = () => {
      ET.recalibCount++;
      webgazer.clearData();
      runCalibration(onComplete);
    };
    $('cal-skip-btn').onclick = () => onComplete(false, null);
  } else {
    onComplete(avgErr !== null && avgErr <= 180, avgErr);
  }
}

// ── Camera consent + calibration flow ─────────────────────────────────────
function showCameraConsent() {
  showScreen('screen-camera-consent');
  trackScreen('camera-consent');

  $('btn-camera-consent-yes').onclick = async () => {
    const btn    = $('btn-camera-consent-yes');
    const noBtn  = $('btn-camera-consent-no');
    btn.disabled  = true;
    noBtn.disabled = true;
    btn.textContent = '⏳ Ładowanie biblioteki…';
    try {
      const wg = await loadWebGazer();
      btn.textContent = '📷 Zezwól na dostęp do kamery…';
      wg.setRegression('ridge')
        .showVideo(false)
        .showFaceOverlay(false)
        .showFaceFeedbackBox(false)
        .showPredictionPoints(false);
      // NOTE: do NOT await begin() — it never resolves on some WebGazer CDN builds.
      // begin() fires off async init in the background; WebGazer will be ready
      // long before the user finishes clicking all 9 calibration dots.
      wg.begin().catch(e => console.warn('webgazer.begin error (ignored):', e));
      // Give WebGazer ~800ms to start the camera stream before showing calibration
      await new Promise(r => setTimeout(r, 800));
      ET.consented = true;
      ET.startTs   = Date.now();

      showScreen('screen-calibration');
      trackScreen('calibration');
      runCalibration((ok, err) => {
        if (ok) {
          ET.calibrated    = true;
          ET.lastCalibTime = Date.now();
          storeEyetrackingConsent(true, err);
          startGazeListener();
          startGazeFlushTimer();
        } else {
          ET.consented = false;
          storeEyetrackingConsent(false, null);
        }
        goToDemographics();
      });
    } catch (e) {
      console.warn('WebGazer init failed:', e);
      // Re-enable buttons so participant can make a choice
      btn.disabled   = false;
      noBtn.disabled = false;
      if (e && e.name === 'NotAllowedError') {
        btn.textContent = '📷 Wyrażam zgodę na śledzenie wzroku';
        const note = document.querySelector('.camera-consent-note');
        if (note) {
          note.innerHTML = '<p style="color:#e74c3c;font-weight:600">⚠️ Dostęp do kamery został zablokowany przez przeglądarkę. Sprawdź uprawnienia i spróbuj ponownie, lub kontynuuj bez śledzenia wzroku.</p>' + note.innerHTML;
        }
      } else {
        btn.textContent = '📷 Wyrażam zgodę na śledzenie wzroku';
      }
      storeEyetrackingConsent(false, null);
    }
  };

  $('btn-camera-consent-no').onclick = () => {
    storeEyetrackingConsent(false, null);
    goToDemographics();
  };
}

// Go to demographics; pause gaze while personal data is on screen (RODO)
function goToDemographics() {
  ET.paused = true;
  showScreen('screen-demographics');
  trackScreen('demographics');
}

// ── MS Clarity ─────────────────────────────────────────────────────────────
function injectClarity(projectId) {
  if (!projectId) return;
  (function(c,l,a,r,i,t,y){
    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;
    t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
  })(window,document,"clarity","script",projectId);
}

function clarityLink(sessionId, fullCondition, styleCondition, metricCondition) {
  if (typeof clarity === 'undefined') return;
  clarity("identify", sessionId);
  clarity("set", "session_id", String(sessionId));
  clarity("set", "condition", fullCondition || '');
  clarity("set", "style", styleCondition || '');
  clarity("set", "metrics", metricCondition || '');
}

// ── Virtual page tracking (Clarity heatmap segmentation) ──────────────────
// Sets a Clarity custom tag AND pushes a hash-based virtual URL so each
// screen / post gets its own heatmap page.  The hash is ONLY for analytics —
// it has no effect on the SPA routing.
let _clarityVirtualNav = false;   // guard: prevents reacting to our own pushState

function clarityPageView(screenName) {
  if (typeof clarity === 'undefined') return;
  clarity('set', 'screen', screenName);
}

function setVirtualUrl(screenName) {
  try {
    _clarityVirtualNav = true;
    history.pushState({ screen: screenName }, '', window.location.pathname + '#' + screenName);
  } catch (e) { /* non-critical */ } finally {
    _clarityVirtualNav = false;
  }
}

function trackScreen(screenName) {
  clarityPageView(screenName);
  setVirtualUrl(screenName);
}

// ── Apply study custom labels to all relevant DOM elements ─────────────────
function applyStudyLabels(study) {
  // Action button labels (paged / custom layout)
  const lblLike    = $('paged-lbl-like');
  const lblDislike = $('paged-lbl-dislike');
  const lblShare   = $('paged-lbl-share');
  const lblFlag    = $('paged-lbl-flag');
  if (lblLike)    lblLike.textContent    = study.label_action_like    || 'Lubię to';
  if (lblDislike) lblDislike.textContent = study.label_action_dislike || 'Nie lubię';
  if (lblShare)   lblShare.textContent   = study.label_action_share   || 'Udostępnij';
  if (lblFlag)    lblFlag.textContent    = study.label_action_flag    || 'Zgłoś';

  // Paged Likert labels
  const pagedQ   = $('paged-likert-question');
  const pagedMin = $('paged-likert-min');
  const pagedMax = $('paged-likert-max');
  if (pagedQ)   pagedQ.textContent   = study.label_likert_question || 'Jak oceniasz wiarygodność tego postu?';
  if (pagedMin) pagedMin.textContent = study.label_likert_min      || 'Zupełnie niewiarygodna';
  if (pagedMax) pagedMax.textContent = study.label_likert_max      || 'W pełni wiarygodna';

  // Rating screen Likert labels
  const ratingQ   = $('rating-likert-question');
  const ratingMin = $('rating-likert-min');
  const ratingMax = $('rating-likert-max');
  if (ratingQ)   ratingQ.textContent   = study.label_likert_question || 'Jak oceniasz wiarygodność tego postu?';
  if (ratingMin) ratingMin.textContent = study.label_likert_min      || 'Zupełnie niewiarygodna';
  if (ratingMax) ratingMax.textContent = study.label_likert_max      || 'W pełni wiarygodna';
}

async function startSession() {
  try {
    const data = await apiPost('/api/session/start', { study_id: S.config.id });
    S.session = data;
    S.posts = data.posts;
    // Enable eye-tracking if study has it configured
    ET.enabled = data.study.eyetracking_enabled === true;
    // Inject Clarity only for this study's project
    if (data.study.clarity_enabled && data.study.clarity_project_id) {
      injectClarity(data.study.clarity_project_id);
      // Give the script a moment to load, then link the session
      setTimeout(() => clarityLink(
        data.session_token,
        data.full_condition,
        data.style_condition,
        data.metric_condition
      ), 2000);
    }
    sessionStorage.setItem('token', data.session_token);
    applyStudyLabels(data.study);
    renderConsentScreen(data.study);
    showScreen('screen-consent');
    trackScreen('consent');
  } catch (e) {
    showError('Nie udało się uruchomić sesji: ' + e.message);
  }
}

// ── Screen 1: Consent ──────────────────────────────────────────────────────
function renderConsentScreen(study) {
  $('consent-institution').textContent = study.institution || 'Badanie naukowe';
  $('consent-study-name').textContent = study.name || 'Badanie dezinformacji';
  $('consent-text').textContent = study.consent_text;

  $('btn-consent-agree').onclick = async () => {
    try {
      await apiPost('/api/session/consent', { session_token: S.session.session_token, consented: true });
      if (study.show_instructions) {
        renderInstructionScreen(study);
        showScreen('screen-instructions');
        trackScreen('instructions');
      } else if (ET.enabled) {
        showCameraConsent();
      } else {
        goToDemographics();
      }
    } catch (e) { showError(e.message); }
  };

  $('btn-consent-decline').onclick = async () => {
    await apiPost('/api/session/consent', { session_token: S.session.session_token, consented: false }).catch(() => {});
    showScreen('screen-no-consent');
  };
}

// ── Screen 2: Instructions ─────────────────────────────────────────────────
function renderInstructionScreen(study) {
  $('instruction-text').textContent = study.instruction_text;

  // Transition screens
  const feedBody = $('transition-feed-body');
  if (feedBody) feedBody.textContent = study.transition_feed_text;
  const ratingBody = $('transition-rating-body');
  if (ratingBody) ratingBody.textContent = study.transition_rating_text;

  // Paged / custom mode: adapt transition screen wording and hide reaction icons if not used
  if (study.layout_type === 'paged' || study.layout_type === 'custom') {
    const emoji = $('transition-feed-emoji');
    const title = $('transition-feed-title');
    if (emoji) emoji.textContent = '📋';
    if (title) title.textContent = 'Za chwilę zobaczysz posty do oceny';

    // Hide reaction icons preview if reactions are off
    if (!study.show_reactions) {
      const preview = $('instruction-icons-preview');
      if (preview) preview.style.display = 'none';
    }
  }

  $('btn-instructions-next').onclick = () => {
    if (ET.enabled) {
      showCameraConsent();
    } else {
      goToDemographics();
    }
  };
}

// ── Screen 3: Demographics ─────────────────────────────────────────────────
(function setupDemographics() {
  const form = $('demographics-form');
  const btn = $('btn-demographics-next');
  const groups = ['age', 'residence', 'education', 'gender'];

  function checkComplete() {
    const allFilled = groups.every(g => form.querySelector(`input[name="${g}"]:checked`));
    btn.disabled = !allFilled;
    $('demographics-hint').style.display = allFilled ? 'none' : '';
  }

  form.addEventListener('change', checkComplete);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await apiPost('/api/session/demographics', {
        session_token: S.session.session_token,
        age: fd.get('age'),
        residence: fd.get('residence'),
        education: fd.get('education'),
        gender: fd.get('gender'),
      });
      ET.paused = false; // resume gaze tracking — personal data screen is done (RODO)
      const study = S.session.study;
      if (study.show_transition_feed) {
        showScreen('screen-transition-feed');
      } else {
        startMainPhase();
      }
    } catch (err) { showError(err.message); }
  });
})();

// ── Screen 4: Transition ───────────────────────────────────────────────────
function startMainPhase() {
  const layoutType = S.session.study.layout_type;
  if (layoutType === 'paged' || layoutType === 'custom') {
    S.pagedIndex = 0;
    renderPagedPost();
    showScreen('screen-paged');
  } else {
    renderFeed();
    showScreen('screen-feed');
  }
}

$('btn-start-feed').onclick = () => startMainPhase();

// ── Screen 5: Feed ────────────────────────────────────────────────────────
function renderFeed() {
  const container = $('feed-container');
  container.innerHTML = '';
  $('total-count').textContent = S.posts.length;
  $('reacted-count').textContent = '0';
  updateFeedProgress();

  S.posts.forEach(post => {
    const el = createPostCard(post);
    container.appendChild(el);
  });

  setupDwellObserver();

  // Capture feed layout snapshot for eye-tracking heatmap (Part 2)
  if (ET.enabled && ET.consented) {
    setTimeout(() => {
      const snapshot = S.posts.map(post => {
        const el = document.querySelector(`[data-post-id="${post.id}"]`);
        if (!el) return null;
        return { post_id: post.id, post_order: post.post_order, height: Math.round(el.getBoundingClientRect().height) };
      }).filter(Boolean);
      apiPost('/api/session/feed-snapshot', { session_token: S.session.session_token, snapshot }).catch(() => {});
    }, 600);
  }
}

function createPostCard(post) {
  const isHighMetric = S.session.metric_condition === 'HIGH';
  const hideTopics = S.session.study.hide_topic_badges;

  const div = document.createElement('div');
  div.className = 'feed-post';
  div.dataset.postId = post.id;
  div.dataset.postOrder = post.post_order;

  const metricClass = isHighMetric ? 'high' : 'low';
  const topicPill = hideTopics ? '' :
    `<span class="topic-pill ${topicClass(post.topic)}">${esc(post.emoji)} ${esc(post.topic)}</span>`;

  const showMetrics = S.session.study.show_metrics !== false && S.session.study.show_metrics !== 0;

  div.innerHTML = `
    <div class="post-header" data-clarity-unmask="true">
      ${avatarHTML(post.source_name, post.avatar_url)}
      <div class="post-meta">
        <div class="post-source" data-clarity-unmask="true">${esc(post.source_name)}</div>
        <div class="post-handle" data-clarity-unmask="true">${esc(post.source_handle)} · ${esc(post.time_ago)}</div>
      </div>
      ${topicPill}
    </div>
    <div class="post-body" data-clarity-unmask="true">
      <h3 class="post-headline" data-clarity-unmask="true">${esc(post.headline)}</h3>
      <p class="post-content" data-clarity-unmask="true">${esc(post.content)}</p>
    </div>
    ${post.image_url ? `<div class="post-image"><img src="${post.image_url}" alt="" loading="lazy"></div>` : ''}
    ${showMetrics ? `
    <div class="post-metrics">
      <span class="metric ${metricClass}">👍 ${formatNum(post.likes_shown)}</span>
      <span class="metric ${metricClass}">👎 ${formatNum(post.dislikes_shown)}</span>
      <span class="metric ${metricClass}">🔄 ${formatNum(post.shares_shown)}</span>
      <span class="metric ${metricClass}">🚩 ${formatNum(post.flags_shown)}</span>
    </div>` : ''}
    <div class="post-actions">
      <button class="action-btn" data-action="like"><span class="action-icon">👍</span>Lubię to</button>
      <button class="action-btn" data-action="dislike"><span class="action-icon">👎</span>Nie lubię</button>
      <button class="action-btn" data-action="share"><span class="action-icon">🔄</span>Udostępnij</button>
      <button class="action-btn" data-action="flag"><span class="action-icon">🚩</span>Zgłoś</button>
    </div>
  `;

  div.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => handleReaction(post, btn.dataset.action, div));
  });

  return div;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleReaction(post, action, cardEl) {
  cardEl.querySelectorAll('.action-btn').forEach(b => {
    b.className = 'action-btn';
    if (b.dataset.action === action) b.classList.add(`active-${action}`);
  });
  S.reactions[post.id] = action;
  cardEl.classList.add('reacted');
  updateFeedProgress();

  const dwell = getDwell(post.id);
  const payload = {
    session_token: S.session.session_token,
    post_id: post.id,
    post_order: post.post_order,
    action,
    dwell_ms: dwell,
    likes_shown: post.likes_shown,
    shares_shown: post.shares_shown,
    dislikes_shown: post.dislikes_shown,
    flags_shown: post.flags_shown,
  };
  apiPost('/api/reaction', payload).catch(() => apiPost('/api/reaction', payload).catch(() => {}));
}

function getDwell(postId) {
  let total = S.dwellAccum[postId] || 0;
  if (S.dwellStart[postId]) total += Date.now() - S.dwellStart[postId];
  return total;
}

function updateFeedProgress() {
  const reacted = Object.keys(S.reactions).length;
  const total = S.posts.length;
  $('reacted-count').textContent = reacted;
  $('feed-fill').style.width = total > 0 ? `${(reacted / total) * 100}%` : '0%';
  if (reacted >= total) $('feed-footer').classList.add('visible');
}

function setupDwellObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const postId    = Number(entry.target.dataset.postId);
      const postOrder = Number(entry.target.dataset.postOrder);
      if (entry.isIntersecting) {
        S.dwellStart[postId] = Date.now();
        ET.currentPostId    = postId;
        ET.currentPostOrder = postOrder;
        ET.currentScreen    = 'feed_post_' + postOrder;
        // Virtual page for Clarity heatmap segmentation
        trackScreen('post_' + postOrder + '_id' + postId);
      } else {
        if (S.dwellStart[postId]) {
          S.dwellAccum[postId] = (S.dwellAccum[postId] || 0) + (Date.now() - S.dwellStart[postId]);
          delete S.dwellStart[postId];
        }
      }
    });
  }, { threshold: 0.4 });
  document.querySelectorAll('.feed-post').forEach(el => observer.observe(el));
}

$('btn-proceed-feed').onclick = () => {
  if (S.session.study.show_transition_rating) {
    showScreen('screen-transition-rating');
  } else {
    S.ratingIndex = 0;
    renderRatingPost();
    showScreen('screen-rating');
  }
};

// ── Screen 6: Transition to rating ────────────────────────────────────────
$('btn-start-rating').onclick = () => {
  S.ratingIndex = 0;
  renderRatingPost();
  showScreen('screen-rating');
};

// ── Screen 7: Rating ──────────────────────────────────────────────────────
function renderRatingPost() {
  const post = S.posts[S.ratingIndex];
  const total = S.posts.length;

  $('rating-current').textContent = S.ratingIndex + 1;
  $('rating-total').textContent = total;
  $('rating-fill').style.width = `${((S.ratingIndex) / total) * 100}%`;

  $('rating-source').textContent = post.source_name;
  $('rating-handle').textContent = post.source_handle;

  const pill = $('rating-topic-pill');
  pill.textContent = `${post.emoji} ${post.topic}`;
  pill.className = `topic-pill ${topicClass(post.topic)}`;

  $('rating-headline').textContent = post.headline;
  $('rating-content').textContent = post.content;

  // Virtual page for Clarity heatmap segmentation
  trackScreen('post_' + post.post_order + '_id' + post.id);

  // ET context: rating screen is a separate viewing mode from feed
  if (ET.enabled && ET.consented) {
    ET.currentPostId    = post.id;
    ET.currentPostOrder = post.post_order;
    ET.currentScreen    = 'rating_post_' + post.post_order;
    ET.paused = false;
  }

  const nextBtn = $('btn-rating-next');
  nextBtn.disabled = true;
  document.querySelectorAll('#likert-buttons .likert-btn').forEach(b => b.classList.remove('selected'));

  const prev = S.ratingValues[post.id];
  if (prev) {
    document.querySelector(`#likert-buttons .likert-btn[data-value="${prev}"]`)?.classList.add('selected');
    nextBtn.disabled = false;
  }
}

document.querySelectorAll('#likert-buttons .likert-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#likert-buttons .likert-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const post = S.posts[S.ratingIndex];
    S.ratingValues[post.id] = Number(btn.dataset.value);
    $('btn-rating-next').disabled = false;
  });
});

$('btn-rating-next').onclick = async () => {
  const post = S.posts[S.ratingIndex];
  const rating = S.ratingValues[post.id];
  if (!rating) return;

  apiPost('/api/rating', {
    session_token: S.session.session_token,
    post_id: post.id,
    post_order: post.post_order,
    belief_1_7: rating,
  }).catch(() => {});

  S.ratingIndex++;
  $('rating-fill').style.width = `${(S.ratingIndex / S.posts.length) * 100}%`;

  if (S.ratingIndex >= S.posts.length) {
    await completeSession();
  } else {
    renderRatingPost();
    window.scrollTo(0, 0);
  }
};

// ── Paged screen ───────────────────────────────────────────────────────────
function renderPagedPost() {
  const post = S.posts[S.pagedIndex];
  const study = S.session.study;
  const total = S.posts.length;
  const isHighMetric = S.session.metric_condition === 'HIGH';
  const metricClass = isHighMetric ? 'high' : 'low';

  // Progress
  $('paged-current').textContent = S.pagedIndex + 1;
  $('paged-total').textContent = total;
  $('paged-fill').style.width = `${(S.pagedIndex / total) * 100}%`;

  // Header
  const pagedAv = $('paged-avatar');
  if (post.avatar_url) {
    pagedAv.innerHTML = `<img src="${esc(post.avatar_url)}" alt="${esc(post.source_name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    pagedAv.innerHTML = avatarInitials(post.source_name);
  }
  $('paged-source').textContent = post.source_name;
  $('paged-handle').textContent = `${post.source_handle} · ${post.time_ago}`;

  // Topic pill
  const pill = $('paged-topic-pill');
  if (study.hide_topic_badges) {
    pill.style.display = 'none';
  } else {
    pill.style.display = '';
    pill.textContent = `${post.emoji} ${post.topic}`;
    pill.className = `topic-pill ${topicClass(post.topic)}`;
  }

  // Content
  $('paged-headline').textContent = post.headline;
  $('paged-content').textContent = post.content;

  // Image
  const imgWrap = $('paged-image-wrap');
  if (post.image_url) {
    $('paged-image').src = post.image_url;
    imgWrap.style.display = '';
  } else {
    imgWrap.style.display = 'none';
  }

  // Metrics
  const metricsEl = $('paged-metrics');
  const showMetricsPaged = study.show_metrics !== false && study.show_metrics !== 0;
  if (showMetricsPaged) {
    metricsEl.style.display = '';
    metricsEl.innerHTML = `
      <span class="metric ${metricClass}">👍 ${formatNum(post.likes_shown)}</span>
      <span class="metric ${metricClass}">👎 ${formatNum(post.dislikes_shown)}</span>
      <span class="metric ${metricClass}">🔄 ${formatNum(post.shares_shown)}</span>
      <span class="metric ${metricClass}">🚩 ${formatNum(post.flags_shown)}</span>
    `;
  } else {
    metricsEl.style.display = 'none';
    metricsEl.innerHTML = '';
  }

  // Reactions row
  const actionsEl = $('paged-actions');
  actionsEl.style.display = study.show_reactions ? '' : 'none';
  actionsEl.querySelectorAll('.action-btn').forEach(b => b.className = 'action-btn');
  const prevReaction = S.pagedReactions[post.id];
  if (prevReaction) {
    actionsEl.querySelector(`[data-action="${prevReaction}"]`)?.classList.add(`active-${prevReaction}`);
  }

  // Likert
  const nextBtn = $('btn-paged-next');
  nextBtn.disabled = true;
  document.querySelectorAll('#paged-likert-buttons .likert-btn').forEach(b => b.classList.remove('selected'));
  const prevRating = S.pagedRatings[post.id];
  if (prevRating) {
    document.querySelector(`#paged-likert-buttons .likert-btn[data-value="${prevRating}"]`)?.classList.add('selected');
    nextBtn.disabled = false;
  }

  // Researcher comment — shown only when the assigned condition has show_comment: true
  const postCommentEl = $('paged-post-comment');
  if (post.post_comment && study.show_comment_in_condition) {
    postCommentEl.style.display = '';
    const author = post.post_comment_author || post.source_name;
    $('paged-comment-avatar').textContent = avatarInitials(author);
    $('paged-comment-author').textContent = author;
    $('paged-comment-text').textContent = post.post_comment;
  } else {
    postCommentEl.style.display = 'none';
  }

  // Participant comment textarea (custom layout)
  const commentWrap  = $('paged-participant-comment-wrap');
  const commentInput = $('paged-participant-comment');
  if (commentWrap) {
    if (study.enable_comments) {
      commentWrap.style.display = '';
      if (commentInput) {
        commentInput.placeholder = study.comment_placeholder || 'Napisz komentarz do tego postu...';
        commentInput.value = S.pagedComments[post.id] || '';
      }
    } else {
      commentWrap.style.display = 'none';
    }
  }

  // Navigation
  $('btn-paged-back').disabled = S.pagedIndex === 0;

  // Track dwell
  S.pagedDwellStart[post.id] = Date.now();

  // Eye-tracking: update current post context
  ET.currentPostId    = post.id;
  ET.currentPostOrder = post.post_order;
  ET.currentScreen    = 'paged_post_' + post.post_order;

  // Virtual page for Clarity heatmap segmentation
  trackScreen('post_' + post.post_order + '_id' + post.id);

  window.scrollTo(0, 0);
}

// Paged reaction buttons
$('paged-actions').querySelectorAll('.action-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const post = S.posts[S.pagedIndex];
    $('paged-actions').querySelectorAll('.action-btn').forEach(b => b.className = 'action-btn');
    btn.classList.add(`active-${btn.dataset.action}`);
    S.pagedReactions[post.id] = btn.dataset.action;
  });
});

// Paged likert buttons
document.querySelectorAll('#paged-likert-buttons .likert-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#paged-likert-buttons .likert-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const post = S.posts[S.pagedIndex];
    S.pagedRatings[post.id] = Number(btn.dataset.value);
    $('btn-paged-next').disabled = false;
  });
});

// Back
$('btn-paged-back').onclick = () => {
  if (S.pagedIndex === 0) return;
  S.pagedIndex--;
  renderPagedPost();
};

// Next
$('btn-paged-next').onclick = async () => {
  const post = S.posts[S.pagedIndex];
  const rating = S.pagedRatings[post.id];
  if (!rating) return;

  const dwellMs = S.pagedDwellStart[post.id] ? Date.now() - S.pagedDwellStart[post.id] : 0;
  const study = S.session.study;

  const payload = {
    session_token: S.session.session_token,
    post_id: post.id,
    post_order: post.post_order,
    belief_1_7: rating,
  };

  if (study.show_reactions && S.pagedReactions[post.id]) {
    payload.action = S.pagedReactions[post.id];
    payload.dwell_ms = dwellMs;
    payload.likes_shown = post.likes_shown;
    payload.shares_shown = post.shares_shown;
    payload.dislikes_shown = post.dislikes_shown;
    payload.flags_shown = post.flags_shown;
  }

  if (study.enable_comments && $('paged-participant-comment')) {
    const commentVal = ($('paged-participant-comment').value || '').trim();
    S.pagedComments[post.id] = commentVal;
    payload.comment = commentVal || null;
  }

  apiPost('/api/paged-response', payload).catch(() =>
    apiPost('/api/paged-response', payload).catch(() => {})
  );

  S.pagedIndex++;
  $('paged-fill').style.width = `${(S.pagedIndex / S.posts.length) * 100}%`;

  if (S.pagedIndex >= S.posts.length) {
    await completeSession();
    return;
  }

  // Check if eye-tracking recalibration is needed between posts
  ET.postsSinceCalib++;
  if (ET.enabled && ET.consented && ET.calibrated && shouldRecalibrate()) {
    ET.paused = true;
    flushGaze();
    ET.recalibCount++;
    webgazer.clearData();
    showScreen('screen-calibration');
    trackScreen('recalibration');
    runCalibration((ok, err) => {
      if (ok) {
        ET.lastCalibTime    = Date.now();
        ET.postsSinceCalib  = 0;
        storeEyetrackingConsent(true, err);
      }
      ET.paused = false;
      renderPagedPost();
      showScreen('screen-paged');
    });
  } else {
    renderPagedPost();
  }
};

// ── Screen 8: Debrief ─────────────────────────────────────────────────────
async function completeSession() {
  // Flush any remaining gaze points before marking session complete
  if (ET.enabled && ET.consented) {
    ET.paused = true;
    flushGaze();
    if (ET.flushTimer) { clearInterval(ET.flushTimer); ET.flushTimer = null; }
    try { webgazer.pause(); } catch (_) {}
  }
  try {
    const data = await apiPost('/api/session/complete', { session_token: S.session.session_token });
    if (S.session.study.show_debrief) {
      renderDebrief(data);
      showScreen('screen-debrief');
      trackScreen('debrief');
    } else {
      showScreen('screen-complete');
      trackScreen('complete');
    }
  } catch (e) {
    showError('Błąd podczas kończenia sesji: ' + e.message);
  }
}

function renderDebrief(data) {
  $('debrief-text-content').textContent = data.debrief_text;

  const list = $('debrief-posts-list');
  list.innerHTML = '';
  S.posts.forEach(post => {
    const div = document.createElement('div');
    div.className = 'debrief-post-item';
    div.innerHTML = `
      <span class="debrief-truth-badge ${post.is_true ? 'badge-true' : 'badge-false'}">
        ${post.is_true ? 'PRAWDA' : 'FAŁSZ'}
      </span>
      <div>
        <span class="topic-pill ${topicClass(post.topic)}" style="margin-bottom:0.4rem;display:inline-flex">${esc(post.emoji)} ${esc(post.topic)}</span>
        <div class="debrief-post-headline">${esc(post.headline)}</div>
      </div>
    `;
    list.appendChild(div);
  });

  if (data.contact_email) {
    const contactEl = $('debrief-contact');
    const emailEl = $('debrief-email');
    emailEl.textContent = data.contact_email;
    emailEl.href = `mailto:${data.contact_email}`;
    contactEl.style.display = '';
  }
}
