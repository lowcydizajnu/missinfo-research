'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  config: null,        // window.STUDY_CONFIG
  session: null,       // {token, style_condition, metric_condition, posts, study}
  posts: [],           // posts for this session
  reactions: {},       // {postId: action}
  dwellStart: {},      // {postId: Date.now() when entered viewport}
  dwellAccum: {},      // {postId: accumulated ms}
  ratingIndex: 0,      // current post index in rating phase
  ratingValues: {},    // {postId: 1-7}
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
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
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
  // Clear session on every load (fresh start)
  sessionStorage.clear();
  startSession();
})();

async function startSession() {
  try {
    const data = await apiPost('/api/session/start', { study_id: S.config.id });
    S.session = data;
    S.posts = data.posts;
    sessionStorage.setItem('token', data.session_token);
    renderConsentScreen(data.study);
    showScreen('screen-consent');
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
      renderInstructionScreen(study);
      showScreen('screen-instructions');
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

  // Pre-populate transition screens
  const feedBody = $('transition-feed-body');
  if (feedBody) feedBody.textContent = study.transition_feed_text;
  const ratingBody = $('transition-rating-body');
  if (ratingBody) ratingBody.textContent = study.transition_rating_text;

  $('btn-instructions-next').onclick = () => showScreen('screen-demographics');
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
      showScreen('screen-transition-feed');
    } catch (err) { showError(err.message); }
  });
})();

// ── Screen 4: Transition to feed ──────────────────────────────────────────
$('btn-start-feed').onclick = () => {
  renderFeed();
  showScreen('screen-feed');
};

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

  div.innerHTML = `
    <div class="post-header">
      <div class="post-avatar">${avatarInitials(post.source_name)}</div>
      <div class="post-meta">
        <div class="post-source">${esc(post.source_name)}</div>
        <div class="post-handle">${esc(post.source_handle)} · ${esc(post.time_ago)}</div>
      </div>
      ${topicPill}
    </div>
    <div class="post-body">
      <h3 class="post-headline">${esc(post.headline)}</h3>
      <p class="post-content">${esc(post.content)}</p>
    </div>
    ${post.image_url ? `<div class="post-image"><img src="${post.image_url}" alt="" loading="lazy"></div>` : ''}
    <div class="post-metrics">
      <span class="metric ${metricClass}">👍 ${formatNum(post.likes_shown)}</span>
      <span class="metric ${metricClass}">🔄 ${formatNum(post.shares_shown)}</span>
      <span class="metric ${metricClass}">👎 ${formatNum(post.dislikes_shown)}</span>
      <span class="metric ${metricClass}">🚩 ${formatNum(post.flags_shown)}</span>
    </div>
    <div class="post-actions">
      <button class="action-btn" data-action="like"><span class="action-icon">👍</span>Lubię to</button>
      <button class="action-btn" data-action="dislike"><span class="action-icon">👎</span>Nie lubię</button>
      <button class="action-btn" data-action="share"><span class="action-icon">🔄</span>Udostępnij</button>
      <button class="action-btn" data-action="flag"><span class="action-icon">🚩</span>Zgłoś</button>
    </div>
  `;

  // Action buttons
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
  // Update UI
  cardEl.querySelectorAll('.action-btn').forEach(b => {
    b.className = 'action-btn';
    if (b.dataset.action === action) b.classList.add(`active-${action}`);
  });

  S.reactions[post.id] = action;
  cardEl.classList.add('reacted');

  updateFeedProgress();

  // Compute dwell
  const dwell = getDwell(post.id);

  // Send to server (fire-and-forget, retry once)
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
  if (S.dwellStart[postId]) {
    total += Date.now() - S.dwellStart[postId];
  }
  return total;
}

function updateFeedProgress() {
  const reacted = Object.keys(S.reactions).length;
  const total = S.posts.length;
  $('reacted-count').textContent = reacted;
  $('feed-fill').style.width = total > 0 ? `${(reacted / total) * 100}%` : '0%';

  if (reacted >= total) {
    $('feed-footer').classList.add('visible');
  }
}

function setupDwellObserver() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const postId = Number(entry.target.dataset.postId);
      if (entry.isIntersecting) {
        S.dwellStart[postId] = Date.now();
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

$('btn-proceed-feed').onclick = () => showScreen('screen-transition-rating');

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

  // Reset Likert
  const nextBtn = $('btn-rating-next');
  nextBtn.disabled = true;
  document.querySelectorAll('.likert-btn').forEach(b => b.classList.remove('selected'));

  // Restore previous rating if navigating back (not supported, but safe)
  const prev = S.ratingValues[post.id];
  if (prev) {
    document.querySelector(`.likert-btn[data-value="${prev}"]`)?.classList.add('selected');
    nextBtn.disabled = false;
  }
}

document.querySelectorAll('.likert-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.likert-btn').forEach(b => b.classList.remove('selected'));
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

  // Send rating
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

// ── Screen 8: Debrief ─────────────────────────────────────────────────────
async function completeSession() {
  try {
    const data = await apiPost('/api/session/complete', { session_token: S.session.session_token });
    renderDebrief(data);
    showScreen('screen-debrief');
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
