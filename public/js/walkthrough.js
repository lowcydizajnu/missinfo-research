'use strict';

// Study screen walkthrough — renders every screen a participant passes through
// in condition A, on one printable page. Auth: reuses the admin token from
// localStorage (the researcher must be signed into the admin panel first) and
// calls /api/walkthrough/:slug with a Bearer header — no token in the URL.

const WT = {
  slug: decodeURIComponent((location.pathname.match(/\/study\/([^/]+)\/walkthrough/) || [])[1] || ''),
  token: localStorage.getItem('admin_token'),
  data: null,
  n: 0, // screen counter
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Preserve researcher line breaks in body text.
function multiline(s) { return esc(s).replace(/\n/g, '<br>'); }
function num(n) { const v = Number(n) || 0; return v >= 1000 ? (v / 1000).toFixed(v % 1000 >= 100 ? 1 : 0) + ' tys.' : String(v); }

function screen(label, note, innerHTML) {
  WT.n += 1;
  return `<section class="wt-screen">
    <div class="wt-screen-label"><span class="wt-num">${WT.n}</span> ${esc(label)}${note ? ` <span class="wt-screen-note">${esc(note)}</span>` : ''}</div>
    <div class="wt-screen-frame"><div class="screen-inner centered">${innerHTML}</div></div>
  </section>`;
}

// ── Individual screens ───────────────────────────────────────────────────────
function consentScreen(s) {
  const title = s.participant_title || s.name || 'Badanie';
  const body = s.consent_text
    ? multiline(s.consent_text)
    : '<em class="wt-screen-note">Tekst zgody pobierany z domyślnego szablonu — uzupełnij w Ustawieniach, aby pojawił się tutaj.</em>';
  return screen('Zgoda', null, `
    <div class="card consent-card">
      ${s.institution ? `<div class="study-badge">${esc(s.institution)}</div>` : ''}
      <h1>${esc(title)}</h1>
      <div class="consent-body">${body}</div>
      <div class="consent-actions">
        <button class="btn btn-primary" disabled>Wyrażam zgodę i chcę wziąć udział</button>
        <button class="btn btn-ghost" disabled>Nie wyrażam zgody</button>
      </div>
    </div>`);
}

function declineScreen(s) {
  const body = s.no_consent_text
    ? multiline(s.no_consent_text)
    : '<em class="wt-screen-note">Domyślny tekst podziękowania po odmowie.</em>';
  return screen('Odmowa zgody', 'wariant: uczestnik nie wyraził zgody', `
    <div class="card centered-text">
      <div class="big-emoji">🙏</div>
      <div class="transition-body">${body}</div>
    </div>`);
}

function eyetrackingScreen() {
  return screen('Zgoda na użycie kamery (eye-tracking)', 'tylko gdy włączone śledzenie wzroku', `
    <div class="card centered-text">
      <div class="big-emoji">👁</div>
      <h2>Śledzenie wzroku</h2>
      <div class="transition-body">Uczestnik jest proszony o zgodę na użycie kamery do śledzenia wzroku (WebGazer), a następnie przechodzi krótką kalibrację. Nagranie nie opuszcza przeglądarki — zapisywane są wyłącznie współrzędne spojrzenia.</div>
    </div>`);
}

function instructionScreen(s) {
  const body = s.instruction_text
    ? multiline(s.instruction_text)
    : '<em class="wt-screen-note">Tekst instrukcji z domyślnego szablonu.</em>';
  const icons = s.show_instruction_actions === 0 || s.show_instruction_actions === false ? '' : `
    <div class="action-icons-preview">
      <div class="icon-row"><span class="icon-demo like">👍</span><span>${esc(s.label_action_like || 'Lubię to')}</span></div>
      <div class="icon-row"><span class="icon-demo dislike">👎</span><span>${esc(s.label_action_dislike || 'Nie lubię')}</span></div>
      <div class="icon-row"><span class="icon-demo share">🔄</span><span>${esc(s.label_action_share || 'Udostępnij')}</span></div>
      <div class="icon-row"><span class="icon-demo flag">🚩</span><span>${esc(s.label_action_flag || 'Zgłoś')}</span></div>
    </div>`;
  return screen('Instrukcja', null, `
    <div class="card">
      <h2>Instrukcja badania</h2>
      <div class="instruction-body">${body}</div>
      ${icons}
    </div>`);
}

function demographicsScreen(s, questions) {
  const fields = questions.map((q) => {
    let opts = [];
    try { opts = Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]'); } catch { opts = []; }
    const asOpt = (o) => (typeof o === 'string' ? { value: o, label: o } : o);
    const it = (q.input_type || 'radio').toLowerCase();
    let body = '';
    if (it === 'radio' || it === 'select') {
      body = `<div class="wt-dq-opts">${opts.map(asOpt).map((o) =>
        `<div class="wt-opt"><span class="wt-radio"></span>${esc(o.label)}</div>`).join('')}</div>`;
    } else if (it === 'checkbox' || it === 'multi') {
      body = `<div class="wt-dq-opts">${opts.map(asOpt).map((o) =>
        `<div class="wt-opt"><span class="wt-check"></span>${esc(o.label)}</div>`).join('')}</div>`;
    } else if (it === 'number' || it === 'scale' || it === 'range') {
      const rng = (q.min_value != null && q.max_value != null) ? ` (zakres ${q.min_value}–${q.max_value})` : '';
      body = `<div class="wt-dq-input">Odpowiedź liczbowa${rng}</div>`;
    } else {
      body = `<div class="wt-dq-input">Odpowiedź tekstowa</div>`;
    }
    return `<div class="wt-dq">
      <div class="wt-dq-label">${esc(q.label)}${q.required ? ' <span class="wt-dq-req">*</span>' : ''}</div>
      ${body}
    </div>`;
  }).join('');
  return screen('Pytania demograficzne', null, `
    <div class="card">
      <h2>Kilka pytań o Ciebie</h2>
      <p class="muted screen-subtitle">Wszystkie dane są anonimowe.</p>
      ${fields || '<em class="wt-screen-note">Brak aktywnych pytań demograficznych.</em>'}
    </div>`);
}

function transitionScreen(label, emoji, title, text) {
  return screen(label, null, `
    <div class="card centered-text">
      <div class="big-emoji">${emoji}</div>
      <h2>${esc(title)}</h2>
      <div class="transition-body">${text ? multiline(text) : ''}</div>
    </div>`);
}

function postScreen(s, post, i, total) {
  const showAvatar = post.show_avatar !== 0 && post.show_avatar !== false && s.show_avatars !== false;
  const initials = (post.source_name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = showAvatar
    ? (post.avatar_url
      ? `<div class="post-avatar"><img src="${esc(post.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%"></div>`
      : `<div class="post-avatar">${esc(initials)}</div>`)
    : '';
  const meta = [post.source_handle, post.time_ago].filter(Boolean).join(' · ');
  const pill = (s.hide_topic_badges || post.hide_topic) ? '' :
    `<span class="topic-pill">${esc((post.emoji ? post.emoji + ' ' : '') + (post.topic || ''))}</span>`;
  const showMetrics = s.show_metrics !== false && s.show_metrics !== 0;
  const metrics = showMetrics ? `<div class="post-metrics">
    ${post.show_like !== 0 ? `<span class="metric">👍 ${num(post.likes)}</span>` : ''}
    ${post.show_dislike !== 0 ? `<span class="metric">👎 ${num(post.dislikes)}</span>` : ''}
    ${post.show_share !== 0 ? `<span class="metric">🔄 ${num(post.shares)}</span>` : ''}
    ${post.show_flag !== 0 ? `<span class="metric">🚩 ${num(post.flags)}</span>` : ''}
  </div>` : '';
  const actions = s.show_reactions === false || s.show_reactions === 0 ? '' : `<div class="post-actions">
    <button class="action-btn" disabled><span class="action-icon">👍</span><span>${esc(s.label_action_like || 'Lubię to')}</span></button>
    <button class="action-btn" disabled><span class="action-icon">👎</span><span>${esc(s.label_action_dislike || 'Nie lubię')}</span></button>
    <button class="action-btn" disabled><span class="action-icon">🔄</span><span>${esc(s.label_action_share || 'Udostępnij')}</span></button>
    <button class="action-btn" disabled><span class="action-icon">🚩</span><span>${esc(s.label_action_flag || 'Zgłoś')}</span></button>
  </div>`;
  const image = post.image_url ? `<div class="post-image"><img src="${esc(post.image_url)}" alt=""></div>` : '';
  const truth = `<span class="wt-truth ${post.is_true ? 't' : 'f'}">${post.is_true ? 'Prawda' : 'Fałsz'}</span>`;
  const header = (avatar || post.source_name || meta || pill) ? `<div class="post-header">
      ${avatar}
      <div class="post-meta">
        ${post.source_name ? `<div class="post-source">${esc(post.source_name)}</div>` : ''}
        ${meta ? `<div class="post-handle">${esc(meta)}</div>` : ''}
      </div>
      ${pill}
    </div>` : '';
  const likert = `<div class="wt-likert">
      <p class="wt-likert-q">${esc(s.label_likert_question || 'Na ile wiarygodny wydaje Ci się ten post?')}</p>
      <div class="wt-likert-scale">${[1,2,3,4,5,6,7].map((v) => `<span>${v}</span>`).join('')}</div>
      <div class="wt-likert-ends"><span>${esc(s.label_likert_min || 'Zupełnie niewiarygodny')}</span><span>${esc(s.label_likert_max || 'Bardzo wiarygodny')}</span></div>
    </div>`;
  return screen(`Post ${i + 1} z ${total}`, null, `
    <div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem">${truth}</div>
    <div class="card paged-card">
      ${header}
      <div class="post-body">
        ${post.headline ? `<h3 class="post-headline">${esc(post.headline)}</h3>` : ''}
        <p class="post-content">${multiline(post.content)}</p>
      </div>
      ${image}
      ${metrics}
      ${actions}
    </div>
    ${likert}`);
}

function debriefScreen(s, posts) {
  const body = s.debrief_text ? multiline(s.debrief_text)
    : '<em class="wt-screen-note">Tekst debriefingu z domyślnego szablonu.</em>';
  const postsList = (s.show_debrief_posts === 0 || s.show_debrief_posts === false) ? '' : `
    <div class="debrief-section">
      <h3>Posty — prawda i fałsz</h3>
      <p class="muted">Poniżej wszystkie posty widziane podczas badania, z oznaczeniem prawda/fałsz.</p>
      <div>${posts.map((p) => `<div class="wt-debrief-post">
        <span class="wt-truth ${p.is_true ? 't' : 'f'}">${p.is_true ? 'Prawda' : 'Fałsz'}</span>
        <span>${esc(p.headline || (p.content || '').slice(0, 80))}</span>
      </div>`).join('')}</div>
    </div>`;
  const contact = s.contact_email ? `<div class="debrief-contact"><p>W razie pytań: <a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a></p></div>` : '';
  return screen('Debriefing', null, `
    <div class="card debrief-card">
      <div class="debrief-header"><div class="big-emoji">🎓</div><h1>Dziękujemy za udział w badaniu!</h1></div>
      <div class="debrief-section"><h3>Cel badania</h3><div>${body}</div></div>
      ${postsList}
      ${contact}
    </div>`);
}

// ── Assemble ─────────────────────────────────────────────────────────────────
function render(d) {
  const s = d.study;
  const feedMode = (s.layout_type || 'feed') === 'feed';
  WT.n = 0;
  const blocks = [];

  // Cover
  blocks.push(`<div class="wt-cover">
    <h1>${esc(s.participant_title || s.name)}</h1>
    <div class="wt-cover-sub">Załącznik: ekrany badania (warunek A)</div>
    ${s.institution ? `<div class="wt-cover-sub">${esc(s.institution)}</div>` : ''}
    <div class="wt-cover-meta">${d.posts.length} postów · ${d.demographics.length} pytań demograficznych · układ: ${feedMode ? 'feed' : 'strona po stronie'}${s.is_active ? '' : ' · badanie nieaktywne'}</div>
  </div>`);

  blocks.push(consentScreen(s));
  blocks.push(declineScreen(s));
  if (s.eyetracking_enabled) blocks.push(eyetrackingScreen());
  if (s.show_instructions !== 0 && s.show_instructions !== false) blocks.push(instructionScreen(s));
  if (s.show_demographics !== 0 && s.show_demographics !== false) blocks.push(demographicsScreen(s, d.demographics));
  if (s.show_transition_feed !== 0 && s.show_transition_feed !== false)
    blocks.push(transitionScreen('Przejście do feedu', '📱', 'Za chwilę zobaczysz posty', s.transition_feed_text));

  d.posts.forEach((p, i) => blocks.push(postScreen(s, p, i, d.posts.length)));

  if (s.show_debrief !== 0 && s.show_debrief !== false) blocks.push(debriefScreen(s, d.posts));

  document.getElementById('wt-doc').innerHTML = blocks.join('');
  document.getElementById('wt-study-name').textContent = s.participant_title || s.name;
  document.title = `Ekrany — ${s.participant_title || s.name}`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  const doc = document.getElementById('wt-doc');
  if (!WT.token) {
    doc.innerHTML = `<div class="wt-error">Zaloguj się najpierw w <a href="/admin">panelu administratora</a>, a potem otwórz ten link ponownie.</div>`;
    return;
  }
  try {
    const r = await fetch(`/api/walkthrough/${encodeURIComponent(WT.slug)}`, {
      headers: { Authorization: `Bearer ${WT.token}` },
    });
    if (r.status === 401) {
      doc.innerHTML = `<div class="wt-error">Sesja wygasła. Zaloguj się ponownie w <a href="/admin">panelu</a> i otwórz link jeszcze raz.</div>`;
      return;
    }
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      doc.innerHTML = `<div class="wt-error">${esc(e.error || 'Nie udało się wczytać badania.')}</div>`;
      return;
    }
    WT.data = await r.json();
    render(WT.data);
  } catch (e) {
    doc.innerHTML = `<div class="wt-error">Błąd: ${esc(e.message)}</div>`;
  }
}

document.getElementById('wt-style-select').addEventListener('change', (e) => {
  document.body.className = e.target.value === 'report' ? 'wt-style-report' : 'wt-style-replica';
});
document.getElementById('wt-print-btn').addEventListener('click', () => window.print());

boot();
