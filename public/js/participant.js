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
  // Post questions (builder mode)
  postQuestions: [],   // [{id, label, question_type, options_json, required}]
  pagedQSubmitted: {}, // {postId: true} — tracks which posts already had questions submitted
  showingQuestions: false, // true while paged question screen is active
  _pqCallback: null,   // called after questions are submitted
};

// ── i18n ──────────────────────────────────────────────────────────────────
function t(keyPath, vars = {}) {
  const locale = S.session?.locale || {};
  const keys = keyPath.split('.');
  let val = locale;
  for (const k of keys) { val = val?.[k]; if (val === undefined) break; }
  if (typeof val !== 'string') val = keyPath; // fallback to key
  // Variable substitution: {{varName}}
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// Get translated study field (falls back to Polish/default value)
function ts(field) {
  const tr = S.session?.study_translations || {};
  return tr[field] || S.session?.study?.[field] || '';
}

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

// Inject a small fixed banner so the admin always knows when their current
// session is being tagged as preview (and therefore won't count toward the
// study's production data).
function showPreviewBanner() {
  if (document.getElementById('preview-session-banner')) return;
  const div = document.createElement('div');
  div.id = 'preview-session-banner';
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#fef3c7;color:#92400e;font-size:0.78rem;text-align:center;padding:0.3rem 0.6rem;border-bottom:1px solid #fbbf24;font-family:system-ui,sans-serif';
  div.textContent = '🧪 Sesja oznaczona jako podglądowa — odpowiedzi nie wejdą do danych produkcyjnych. (Aby zrobić prawdziwy test produkcyjny: wyloguj się z admina lub przełącz tryb w panelu.)';
  document.body.prepend(div);
  // Push the rest of the page down so the banner doesn't overlap the consent
  // screen header — measured at runtime so it adapts if styling changes.
  const h = div.offsetHeight;
  document.body.style.paddingTop = h + 'px';
}

function formatNum(n) {
  const lang = S.session?.language || 'pl';
  const localeCode = lang === 'pl' ? 'pl-PL' : lang === 'cs' ? 'cs-CZ' : lang === 'sk' ? 'sk-SK' : 'en-US';
  return Number(n).toLocaleString(localeCode);
}

// UI-only reaction counter update — when the participant clicks like/dislike/
// share/flag, the count next to the icon increments (or decrements on undo).
// EVERYTHING server-side stays exactly as before: likes_shown is still the
// base value persisted on the reactions row and exported to Excel; the
// participant's own +1 is purely a visual social-feedback cue, never sent
// anywhere. Without this the post numbers feel "dead" — researcher asked
// for "click adds visible reaction" to match real platforms.
const _METRIC_BASE_FIELD = { like: 'likes_shown', dislike: 'dislikes_shown', share: 'shares_shown', flag: 'flags_shown' };
const _METRIC_EMOJI      = { like: '👍', dislike: '👎', share: '🔄', flag: '🚩' };
function refreshShownMetrics(cardEl, post, activeArr) {
  if (!cardEl || !post) return;
  // activeArr: array of currently-active reaction keys for this post (the
  // post-click state). Empty array = nothing selected → all deltas zero.
  const active = new Set(Array.isArray(activeArr) ? activeArr : []);
  for (const action of Object.keys(_METRIC_BASE_FIELD)) {
    const span = cardEl.querySelector(`[data-metric="${action}"]`);
    if (!span) continue;
    const base = Number(post[_METRIC_BASE_FIELD[action]] || 0);
    const delta = active.has(action) ? 1 : 0;
    span.textContent = `${_METRIC_EMOJI[action]} ${formatNum(base + delta)}`;
  }
}

function topicClass(topic) {
  // Map known Polish slugs for backward compatibility; for any other topic use slug directly
  const known = { zdrowie: 'topic-zdrowie', klimat: 'topic-klimat', polityka: 'topic-polityka', ekonomia: 'topic-ekonomia', nauka: 'topic-nauka',
    health: 'topic-health', climate: 'topic-climate', politics: 'topic-politics', economy: 'topic-economy', science: 'topic-science' };
  if (known[topic]) return known[topic];
  // Generic: sanitize topic string to a valid CSS class slug
  return 'topic-' + (topic || 'other').toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function topicLabel(topic) {
  // Try locale translation first (covers Polish slugs in non-Polish studies)
  const translated = t('topics.' + topic);
  if (translated) return translated;
  // Fall back to raw value (custom topics entered directly in study language)
  return topic || '';
}

function getPartConfig(post) {
  const parts = S.session?.parts || [];
  if (!parts.length) return {};
  // Multi-part flow: the same post can surface in several parts, each with
  // its own reactions/comments/questions config. Prefer the part the
  // participant is CURRENTLY in over post.part_id (the primary, fixed at
  // creation). Without this, a post in [Part 1, Part 2] keeps Part 1's
  // settings while displayed in Part 2 — wrong reaction buttons, wrong
  // comment gate, wrong questions. Falls back to the primary-id lookup
  // for contexts where currentPartIdx isn't set yet (early init).
  if (S.currentPartIdx != null && parts[S.currentPartIdx]) {
    return parts[S.currentPartIdx];
  }
  // Try exact ID match first; fall back to first part (handles string/numeric ID mismatch)
  return parts.find(p => String(p.id) === String(post.part_id)) || parts[0];
}
function getPartDisplayMode(post) {
  return getPartConfig(post).pq_display_mode || 'after_interaction';
}

// Return the subset of S.postQuestions that should appear under this specific
// post. Questions are bound to a part via post_questions.part_id. Without
// this filter, every post in the study would trigger every question — a
// part-2 question would pop up after reacting to a part-1 post.
//
// Resolution:
//   1. Exact part match (q.part_id === post.part_id) takes precedence.
//   2. If the post's part has no questions of its own, fall back to global
//      questions (q.part_id null/undefined) — legacy studies that defined
//      questions before parts existed kept them with part_id=null and we
//      don't want them silently disappearing.
function getPostQuestionsForPost(post) {
  if (!Array.isArray(S.postQuestions)) return [];
  // Multi-part flow: filter by the CURRENT part's id, not post.part_id.
  // A post in [Part 1, Part 2] should expose Part 2's questions when
  // displayed in Part 2 context — keying off post.part_id (the primary,
  // fixed at creation) would always pull Part 1's questions.
  const parts = S.session?.parts || [];
  const currentPart = (S.currentPartIdx != null) ? parts[S.currentPartIdx] : null;
  const targetPartId = currentPart ? (currentPart.id || null) : (post?.part_id || null);
  const partMatches = S.postQuestions.filter(q => (q.part_id || null) === targetPartId);
  if (partMatches.length) return partMatches;
  return S.postQuestions.filter(q => !q.part_id);
}

// ── Per-part interaction requirements (Phase 3) ─────────────────────────────
// Each part can carry a `requirements: [{action, count}, ...]` array in
// parts_json. The participant must hit each row's count before "Dalej" unlocks.
// `action: 'any'` accepts any reaction OR comment. Empty/missing array =
// no constraint (legacy require_interaction still applies if set).

function getPartIdOfPost(postId) {
  const p = (S.posts || []).find(x => x.id == postId);
  return p ? (p.part_id || null) : null;
}

// Multi-part aware version: returns the full set of parts a post belongs
// to. Used by countActionInPart so a reaction on a post that appears in
// part A and part B counts toward EITHER part's requirements. Without
// this, a multi-part post's reaction would only credit its primary part.
function getPartIdsOfPost(postId) {
  const p = (S.posts || []).find(x => x.id == postId)
         || (S.allPosts || []).find(x => x.id == postId);
  if (!p) return [];
  if (Array.isArray(p.part_ids) && p.part_ids.length) return p.part_ids;
  return p.part_id ? [p.part_id] : [];
}

// Multi-react state accessors. The legacy single-react mode keeps each
// reaction map (S.reactions, S.pagedReactions) keyed by post.id with the
// VALUE being the single reaction string. Multi-react mode promotes the
// value to an array of strings so a post can carry like+share+flag at
// once. These helpers normalise to array shape so the rest of the code
// can treat both modes uniformly.
function reactionsOfFeed(postId) {
  const v = S.reactions?.[postId];
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string' && v) return [v];
  return [];
}
function reactionsOfPaged(postId) {
  const v = S.pagedReactions?.[postId];
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string' && v) return [v];
  return [];
}
// Centralised "is multi-react enabled?" check — driven by the study-level
// allow_multi_reactions flag returned by session/start.
function isMultiReactMode() {
  return !!S.session?.study?.allow_multi_reactions;
}
// Apply the multi-react click rules to a current reaction array and a
// click action. Returns { next, added, removed } describing the new
// array and the diff so callers can fire the right server event.
//   - like/dislike are mutually exclusive (clicking like clears dislike)
//   - clicking a reaction that's already present toggles it OFF
//   - everything else stacks
function applyMultiReactClick(currentArr, action) {
  let next = currentArr.slice();
  const wasActive = next.includes(action);
  // Mutex pair: like ↔ dislike. The OPPOSITE always gets removed before we
  // toggle the clicked action — never both at once.
  if (action === 'like'    && next.includes('dislike')) next = next.filter(a => a !== 'dislike');
  if (action === 'dislike' && next.includes('like'))    next = next.filter(a => a !== 'like');
  if (wasActive) {
    next = next.filter(a => a !== action);
    return { next, added: null, removed: action };
  }
  next.push(action);
  return { next, added: action, removed: null };
}

// Count distinct POSTS in this part that received the given action. We key
// on distinct post.id so re-reacting to the same post via allow_back doesn't
// double-count. `action === 'any'` counts a post if it has EITHER a reaction
// of any kind OR a non-empty comment.
function countActionInPart(partId, action) {
  // Multi-part: a post in [partA, partB] credits BOTH parts' requirements.
  // A single reaction satisfies all assignments — matches the demo flow
  // where part 1 (feed) reactions also count toward part 2's recap view.
  const inPart = id => getPartIdsOfPost(id).includes(partId);
  // Combined valence requirement — "Polub LUB Nie lubię". Counts distinct
  // posts that received either reaction. Because the like ↔ dislike mutex
  // guarantees a post can't carry both at once, a simple sum is exact
  // (no double-count risk).
  if (action === 'like_or_dislike') {
    return countActionInPart(partId, 'like') + countActionInPart(partId, 'dislike');
  }
  if (action === 'comment') {
    // Feed mode persists comments in S.feedComments, paged in S.pagedComments —
    // we count a post once if either store has a non-empty entry. Without
    // the feedComments side, a feed part with a "Skomentuj" requirement
    // would never tick its counter.
    const ids = new Set();
    Object.entries(S.pagedComments || {}).forEach(([id, text]) => {
      if (text && String(text).trim() && inPart(Number(id))) ids.add(Number(id));
    });
    Object.entries(S.feedComments  || {}).forEach(([id, text]) => {
      if (text && String(text).trim() && inPart(Number(id))) ids.add(Number(id));
    });
    return ids.size;
  }
  if (action === 'any') {
    const ids = new Set();
    // A post counts if it has ANY recorded reaction (array non-empty in
    // multi-react mode, string set in single-react mode).
    Object.keys(S.pagedReactions || {}).forEach(id => {
      if (inPart(Number(id)) && reactionsOfPaged(id).length) ids.add(Number(id));
    });
    Object.entries(S.pagedComments  || {}).forEach(([id, text]) => {
      if (text && String(text).trim() && inPart(Number(id))) ids.add(Number(id));
    });
    Object.entries(S.feedComments   || {}).forEach(([id, text]) => {
      if (text && String(text).trim() && inPart(Number(id))) ids.add(Number(id));
    });
    Object.keys(S.reactions      || {}).forEach(id => {
      if (inPart(Number(id)) && reactionsOfFeed(id).length) ids.add(Number(id));
    });
    return ids.size;
  }
  // Specific reaction type — multi-react stores arrays so we check
  // membership rather than ===. reactionsOfFeed / reactionsOfPaged
  // normalise both legacy (string) and multi (array) shapes.
  const fromPaged = Object.keys(S.pagedReactions || {})
    .filter(id => reactionsOfPaged(id).includes(action) && inPart(Number(id))).length;
  const fromFeed  = Object.keys(S.reactions || {})
    .filter(id => reactionsOfFeed(id).includes(action) && inPart(Number(id))).length;
  return fromPaged + fromFeed;
}

// Returns { reqs: [{action, count, got, met}], allMet: bool }. `reqs` is
// empty when the part has no structured requirements; callers should fall
// back to legacy require_interaction in that case.
function evalPartRequirements(part) {
  const reqs = Array.isArray(part?.requirements) ? part.requirements : [];
  if (!reqs.length || !part) return { reqs: [], allMet: true };
  const partId = part.id;
  const evaluated = reqs.map(r => {
    const got = countActionInPart(partId, r.action);
    const count = Number(r.count) || 0;
    // count=0 = "opcjonalne / ∞" — the participant sees the row as a prompt
    // ("we're tracking this; you can do 0 or any number") but it never
    // blocks Dalej. met=true regardless of got so allMet stays clean.
    const met = count === 0 ? true : got >= count;
    return { action: r.action, count, got, met };
  });
  return { reqs: evaluated, allMet: evaluated.every(r => r.met) };
}

// Label + emoji for a Phase 3 requirement row. Reads from the locale via
// requirement.<action> keys so every string is editable in the platform
// translations modal — no hardcoded Polish in render code. Falls back to
// the raw action key only when the locale lookup misses (defensive — e.g.
// a brand-new action type added before locale files were updated).
function requirementLabel(action) {
  const lookup = t('requirement.' + action);
  return (lookup && lookup !== 'requirement.' + action) ? lookup : action;
}

// Render the per-part checklist into a sticky container under the progress
// bar. Called from renderPagedPost on every navigation and from reaction /
// comment handlers to refresh counts live. No-op if the part defines no
// structured requirements — keeps legacy parts visually unchanged.
// Render the checklist into whichever screen is currently active. The
// checklist host #part-checklist is a single element that gets re-parented
// when the active layout flips between feed and paged across parts — this
// way reaction counts and the "📋 Aby przejść dalej" UI stay visible in
// both feed (where the user is doing the reacting) and paged (where the
// progress is the answers + reactions to each card).
// Vertical-space-saving compact status bar. When EITHER the per-part timer
// is running OR the part declares Phase 3 requirements, we hide the native
// "Post N / Total" progress label + track and replace them with a single
// horizontal row inside the same sticky container:
//   [⏱ 7:43]   👍 Polub 1/1 ✓   🔄 Udostępnij 0/1 ○   💬 Skomentuj 1/1 ✓
// Falls back to the native progress bar when both slots are empty so legacy
// studies with neither timer nor structured requirements look unchanged.

function getActiveProgressBarId() {
  const layout = S.session?.study?.layout_type || 'feed';
  return (layout === 'paged' || layout === 'custom') ? 'paged-progress-bar' : 'feed-progress-bar';
}

function ensureCompactStatusBar(progressBarId) {
  const sticky = document.getElementById(progressBarId);
  if (!sticky) return null;
  let bar = sticky.querySelector(':scope > .part-status-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'part-status-bar';
    bar.style.cssText = 'display:none;align-items:center;justify-content:center;gap:0.85rem;flex-wrap:wrap;padding:0.45rem 0.6rem';
    // Two slots — timer (left) + checklist items (right). Empty slots stay
    // display:none so they don't introduce phantom gaps.
    bar.innerHTML =
      '<div class="part-status-timer-slot" style="display:none"></div>' +
      '<div class="part-status-checklist-slot" style="display:none;align-items:center;gap:0.55rem;flex-wrap:wrap;font-size:0.85rem"></div>';
    sticky.appendChild(bar);
  }
  return bar;
}

// Decide which container to show: native progress UI or the compact bar.
// Driven entirely by what's in the compact bar's slots — call this after
// every mutation of either slot.
function syncCompactStatusVisibility(progressBarId) {
  const sticky = document.getElementById(progressBarId);
  if (!sticky) return;
  const bar = sticky.querySelector(':scope > .part-status-bar');
  const timerSlot = bar?.querySelector('.part-status-timer-slot');
  const listSlot  = bar?.querySelector('.part-status-checklist-slot');
  const hasTimer  = !!(timerSlot && timerSlot.innerHTML.trim() && timerSlot.style.display !== 'none');
  const hasList   = !!(listSlot  && listSlot.innerHTML.trim()  && listSlot.style.display  !== 'none');
  const compact = hasTimer || hasList;
  const lbl = sticky.querySelector(':scope > .progress-label');
  const trk = sticky.querySelector(':scope > .progress-track');
  if (compact) {
    if (lbl) lbl.style.display = 'none';
    if (trk) trk.style.display = 'none';
    if (bar) bar.style.display = 'flex';
  } else {
    if (lbl) lbl.style.display = '';
    if (trk) trk.style.display = '';
    if (bar) bar.style.display = 'none';
  }
}

function renderPartChecklist(part) {
  const status = evalPartRequirements(part);
  const progressBarId = getActiveProgressBarId();
  // Belt + braces: an older build of this code created a sibling
  // #part-checklist DIV outside the progress bar. Mid-session reloads after
  // a deploy can leave that stale node attached. Strip it on every call so
  // we never paint twice.
  const stale = document.getElementById('part-checklist');
  if (stale) stale.remove();

  const bar = ensureCompactStatusBar(progressBarId);
  if (!bar) return;
  const slot = bar.querySelector('.part-status-checklist-slot');
  if (!slot) return;

  if (!status.reqs.length) {
    slot.innerHTML = '';
    slot.style.display = 'none';
    syncCompactStatusVisibility(progressBarId);
    return;
  }
  slot.style.display = 'flex';
  slot.innerHTML = status.reqs.map(r => {
    // count=0 = "opcjonalne / ∞" prompt — researcher is tracking the action
    // but hasn't set a minimum. Show a neutral palette (slate-ish) rather
    // than green ✓ — the row is informational, not a "completed" goal —
    // and render "${got} / ∞" so the participant sees their running count.
    const isOpen = r.count === 0;
    const bg = isOpen ? '#eff6ff' : (r.met ? '#dcfce7' : '#f1f5f9');
    const bd = isOpen ? '#bfdbfe' : (r.met ? '#86efac' : '#cbd5e1');
    const fg = isOpen ? '#1e40af' : (r.met ? '#166534' : '#475569');
    // Icon: ∞ for open prompts, ✓ for met requirements, ○ for unmet.
    const icon = isOpen ? '∞' : (r.met ? '✓' : '○');
    const tally = isOpen ? `${r.got} / ∞` : `${r.got}/${r.count}`;
    return `<span class="part-status-req ${r.met ? 'met' : ''} ${isOpen ? 'open' : ''}" style="display:inline-flex;align-items:center;gap:0.35rem;padding:0.22rem 0.6rem;border-radius:999px;background:${bg};border:1px solid ${bd};color:${fg};font-weight:500;line-height:1.1">
      <span aria-hidden="true">${icon}</span>
      <span>${esc(requirementLabel(r.action))}</span>
      <span style="font-variant-numeric:tabular-nums;opacity:0.85">${tally}</span>
    </span>`;
  }).join('');
  syncCompactStatusVisibility(progressBarId);
}

// Re-evaluate the checklist for the part the current paged post belongs to.
// Cheap to call from every reaction click / comment input — only touches the
// already-rendered #part-checklist DOM and recomputes counts client-side.
function refreshPartChecklistForCurrent() {
  const post = S.posts && S.posts[S.pagedIndex];
  if (!post) return;
  const partCfg = getPartConfig(post);
  if (!partCfg) return;
  renderPartChecklist(partCfg);
  const nextBtn = document.getElementById('btn-paged-next');
  if (!nextBtn) return;
  const status = evalPartRequirements(partCfg);
  if (status.reqs.length) nextBtn.disabled = !status.allMet;
}

// Feed-mode analog. Feed has no "Dalej" button — auto-advance to the next
// part is gated on requirements (see handleReaction). We still need to
// refresh the checklist's visible counts on every reaction / comment edit.
function refreshPartChecklistForFeed() {
  if (!S.session?.parts?.length) return;
  const part = S.session.parts[S.currentPartIdx ?? 0];
  if (!part) return;
  renderPartChecklist(part);
}

function avatarInitials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
// Build the "handle · time" line, joining with " · " only between non-empty
// parts. Returns '' when both are empty so the caller can drop the line —
// and, when source name + avatar are also empty, the whole post header —
// instead of rendering a lone separator dot. Researcher leaves these fields
// blank for posts where the image itself is the full stimulus (a screenshot
// that already carries its own author/handle/time).
function metaLine(handle, timeAgo) {
  return [handle, timeAgo]
    .map(s => (s == null ? '' : String(s).trim()))
    .filter(Boolean)
    .join(' · ');
}

// Topic pill is globally disabled in code. The per-post hide_topic toggle in
// the admin editor was unreliable; the researcher asked to simply never show
// topic pills on posts. Flip to false to restore the pill (then the per-post /
// study-level hide_topic flags take over again). Applies to feed, paged,
// rating and debrief renders.
const TOPIC_PILL_DISABLED = true;

// Normalize post-body whitespace for display. Researcher-pasted and especially
// AI-translated content frequently arrives HARD-WRAPPED — a newline inserted
// roughly every ~85 chars MID-SENTENCE by the source or the translation step.
// Rendered in the narrower post card with white-space:pre-line, each wrapped
// line overflows by a word and leaves ragged single-word orphans ("Polsku",
// "vývoje", "do"). We rejoin only the wrap artifacts and keep meaningful breaks.
//
// A newline is KEPT (real break) when ANY of:
//   • the text before it ends a sentence — . ! ? : … or a closing quote/paren
//   • the line is blank, or the next line is blank (paragraph spacing)
//   • the line it terminates starts with a list/section marker (emoji, •, –, ◆)
//   • the next line starts with such a marker
// Otherwise the newline was a mid-sentence wrap → collapses to a single space.
//
// Intentionally punctuation-driven so behaviour is PREDICTABLE: "breaks survive
// after sentence-ending punctuation and around bullet/section markers; a break
// in the middle of a sentence is treated as a wrap and becomes a space." No
// language-specific capital-letter guessing (Slavic proper nouns mid-sentence —
// Polsku, Varšavě — would defeat that anyway).
const _PT_MARKER_START = /^\s*(?:[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}]|[•◆▪‣·–—→*])/u;
const _PT_SENTENCE_END = /[.!?:…"»”’\)\]]\s*$/;
function formatPostText(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    out += lines[i];
    if (i === lines.length - 1) break;
    const cur = lines[i], next = lines[i + 1];
    const keep =
      cur.trim() === '' || next.trim() === '' ||
      _PT_SENTENCE_END.test(cur) ||
      _PT_MARKER_START.test(cur) ||
      _PT_MARKER_START.test(next);
    out += keep ? '\n' : ' ';
  }
  // At most one blank line between paragraphs.
  return out.replace(/\n{3,}/g, '\n\n');
}
function avatarHTML(name, url, extraClass = '', perPostShow = true) {
  // Two-level avatar visibility:
  //   1. Per-post (post.show_avatar=0 → false here) — wins, hides this post only
  //   2. Study-level (study.show_avatars=false) — hides every post's avatar
  // Returning an empty string lets the post-header flex layout collapse the
  // avatar column on its own — no separate CSS hook needed.
  if (perPostShow === false) return '';
  if (S.session?.study?.show_avatars === false) return '';
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
    // No locale available yet, use static Polish fallback
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

  if (instr) instr.innerHTML = t('calibration.instruction', { n: 1, total: 9 }).replace('{{n}}', `<strong id="cal-dot-num">1</strong>`);
  const fill = $('cal-progress-fill');
  if (fill) fill.style.width = '0%';
}

async function _runCalibrationValidation(onComplete) {
  const wrap = $('cal-dots-wrap');
  const instr = $('cal-instructions');
  wrap.innerHTML = '';
  if (instr) instr.innerHTML = `<span>${t('calibration.checking')}</span>`;
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
    if (instr) instr.textContent = t('calibration.look_at_dot');
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
      <span>${t('calibration.inaccurate', { error: avgErr ? ` (błąd: ${avgErr}px)` : '' })}</span>
      <div style="margin-top:1.25rem;display:flex;gap:1rem;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="cal-retry-btn">${t('calibration.btn_retry')}</button>
        <button class="btn btn-ghost" id="cal-skip-btn" style="color:#9aa;border-color:#334">${t('calibration.btn_skip_tracking')}</button>
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
    btn.textContent = t('camera_consent.loading');
    try {
      const wg = await loadWebGazer();
      btn.textContent = t('camera_consent.allow_camera');
      wg.setRegression('ridge')
        .showVideo(false)
        .showFaceOverlay(false)
        .showFaceFeedbackBox(false)
        .showPredictionPoints(false);
      // NOTE: do NOT await begin() — it never resolves on some WebGazer CDN builds.
      // begin() fires off async init in the background; WebGazer will be ready
      // long before the user finishes clicking all 9 calibration dots.
      wg.begin().catch(e => console.warn('webgazer.begin error (ignored):', e));
      // Give WebGazer ~2000ms to start the camera stream and load the face model
      // before showing calibration. 800ms was too short → face model not ready →
      // all calibration predictions returned null → avgErr=null → calibration "failed".
      await new Promise(r => setTimeout(r, 2000));
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
          // Calibration failed technically (face model not ready / poor accuracy),
          // but the user DID consent — record consent=true so it's not counted as
          // "odmowa". Just don't start gaze recording since calibration was bad.
          ET.consented = false;
          storeEyetrackingConsent(true, null);
        }
        goToDemographics();
      });
    } catch (e) {
      console.warn('WebGazer init failed:', e);
      // Re-enable buttons so participant can make a choice
      btn.disabled   = false;
      noBtn.disabled = false;
      if (e && e.name === 'NotAllowedError') {
        btn.textContent = t('camera_consent.btn_agree');
        const note = document.querySelector('.camera-consent-note');
        if (note && !note.querySelector('.et-cam-err')) {
          const p = document.createElement('p');
          p.className = 'et-cam-err';
          p.style.cssText = 'color:#e74c3c;font-weight:600;margin-bottom:.5rem';
          p.textContent = t('camera_consent.error_blocked');
          note.prepend(p);
        }
      } else {
        btn.textContent = t('camera_consent.btn_agree');
      }
      // Do NOT record consent here — user hasn't made a final choice yet.
      // They can retry. Consent is only stored after calibration (success/fail)
      // or when they explicitly click "nie wyrażam zgody".
    }
  };

  $('btn-camera-consent-no').onclick = () => {
    storeEyetrackingConsent(false, null);
    goToDemographics();
  };
}

// Resolve where the demographic questions screen should appear in the flow.
// Returns 'after_consent' (legacy default), 'before_debrief', or 'hidden'.
// Falls back to the legacy boolean show_demographics for studies edited
// before the dropdown landed: false → 'hidden', true/undefined → 'after_consent'.
function getDemographicsPosition() {
  const study = S.session?.study || {};
  const explicit = study.demographics_position;
  if (explicit === 'after_consent' || explicit === 'before_debrief' || explicit === 'hidden') {
    return explicit;
  }
  return study.show_demographics === false ? 'hidden' : 'after_consent';
}

// Show demographics screen. The caller decides WHEN to call this (between
// consent and main phase, or after main phase right before debrief).
function showDemographicsScreen() {
  ET.paused = true;
  renderDemographicsScreen();
  showScreen('screen-demographics');
  trackScreen('demographics');
}

// Entry point used right after consent. Honors demographics_position to
// decide whether to show the screen here, defer to the end, or skip entirely.
function goToDemographics() {
  const pos = getDemographicsPosition();
  if (pos === 'after_consent') {
    showDemographicsScreen();
    return;
  }
  // Deferred to before_debrief OR hidden — either way, skip this step and
  // continue with the rest of the post-consent flow. The end-of-study handler
  // (see completeSession callsites in pagedAdvance + feed submit) intercepts
  // 'before_debrief' there.
  const study = S.session.study;
  if (study.show_transition_feed) {
    showScreen('screen-transition-feed');
  } else {
    startMainPhase();
  }
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDemographicsScreen() {
  const questions = S.session && S.session.demographic_questions
    ? S.session.demographic_questions
    : [];
  const container = $('demographics-fields');
  if (!container) return;
  if (!questions.length) return; // fallback: keep static HTML as-is

  container.innerHTML = questions.map(q => {
    let options = [];
    try { options = JSON.parse(q.options || '[]'); } catch {}

    if (q.input_type === 'text' || q.input_type === 'number') {
      // Freeform input. For 'number' the browser enforces digit-only entry
      // + the min/max attributes (numeric range). For 'text' we map
      // researcher-set min/max onto minlength/maxlength (character count),
      // so the same admin UI semantics drive both. NULL min/max = no
      // bound; the attr is omitted entirely so participants don't see a
      // stray "0" minimum.
      const isNumber = q.input_type === 'number';
      const minAttr = q.min_value != null
        ? (isNumber ? ` min="${escHtml(String(q.min_value))}"` : ` minlength="${escHtml(String(Math.floor(q.min_value)))}"`)
        : '';
      const maxAttr = q.max_value != null
        ? (isNumber ? ` max="${escHtml(String(q.max_value))}"` : ` maxlength="${escHtml(String(Math.floor(q.max_value)))}"`)
        : '';
      // Inline hint so participants know up front what's allowed instead
      // of discovering it from a validation error after submit.
      let hint = '';
      if (q.min_value != null && q.max_value != null) {
        hint = isNumber
          ? `Dopuszczalny zakres: ${q.min_value}–${q.max_value}`
          : `Długość: ${Math.floor(q.min_value)}–${Math.floor(q.max_value)} znaków`;
      } else if (q.min_value != null) {
        hint = isNumber ? `Minimum: ${q.min_value}` : `Minimum ${Math.floor(q.min_value)} znaków`;
      } else if (q.max_value != null) {
        hint = isNumber ? `Maksimum: ${q.max_value}` : `Maksimum ${Math.floor(q.max_value)} znaków`;
      }
      // step="1" + inputmode="numeric" on number — most demographics are
      // integers (age, kids, years of education); also surfaces the
      // numeric keypad on mobile.
      const stepAttr = isNumber ? ' step="1" inputmode="numeric"' : '';
      return `<div class="form-group">
        <label>${escHtml(q.label)}</label>
        <input type="${isNumber ? 'number' : 'text'}" name="${escHtml(q.field_key)}" class="demo-input"${stepAttr}${minAttr}${maxAttr}
               placeholder="${t('demographics.text_placeholder')}" ${q.required ? 'required' : ''}>
        ${hint ? `<div class="demo-input-hint">${escHtml(hint)}</div>` : ''}
      </div>`;
    }

    // Multiselect — checkboxy, uczestnik może zaznaczyć wiele opcji.
    // Wartości zbierane przez fd.getAll() i łączone przecinkami przy
    // submicie (patrz handler submit poniżej). Wymóg "required" oznacza
    // "min. jedna zaznaczona" — walidacja w validateDemographics.
    if (q.input_type === 'multiselect') {
      const checks = options.map(o =>
        `<label class="radio-option">
           <input type="checkbox" name="${escHtml(q.field_key)}" value="${escHtml(o.value)}"> ${escHtml(o.label)}
         </label>`
      ).join('');
      return `<div class="form-group">
        <label>${escHtml(q.label)}</label>
        <div class="radio-group" id="${escHtml(q.field_key)}-group">${checks}</div>
      </div>`;
    }

    // radio (default)
    const radios = options.map(o =>
      `<label class="radio-option">
         <input type="radio" name="${escHtml(q.field_key)}" value="${escHtml(o.value)}"> ${escHtml(o.label)}
       </label>`
    ).join('');

    return `<div class="form-group">
      <label>${escHtml(q.label)}</label>
      <div class="radio-group" id="${escHtml(q.field_key)}-group">${radios}</div>
    </div>`;
  }).join('');
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
  if (lblLike)    lblLike.textContent    = study.label_action_like    || t('actions.like');
  if (lblDislike) lblDislike.textContent = study.label_action_dislike || t('actions.dislike');
  if (lblShare)   lblShare.textContent   = study.label_action_share   || t('actions.share');
  if (lblFlag)    lblFlag.textContent    = study.label_action_flag    || t('actions.flag');

  // Paged Likert labels
  const pagedQ   = $('paged-likert-question');
  const pagedMin = $('paged-likert-min');
  const pagedMax = $('paged-likert-max');
  if (pagedQ)   pagedQ.textContent   = study.label_likert_question || t('actions.likert_question');
  if (pagedMin) pagedMin.textContent = study.label_likert_min      || t('actions.likert_min');
  if (pagedMax) pagedMax.textContent = study.label_likert_max      || t('actions.likert_max');

  // Rating screen Likert labels
  const ratingQ   = $('rating-likert-question');
  const ratingMin = $('rating-likert-min');
  const ratingMax = $('rating-likert-max');
  if (ratingQ)   ratingQ.textContent   = study.label_likert_question || t('actions.likert_question');
  if (ratingMin) ratingMin.textContent = study.label_likert_min      || t('actions.likert_min');
  if (ratingMax) ratingMax.textContent = study.label_likert_max      || t('actions.likert_max');

  // ── Locale-driven static UI labels ────────────────────────────────────────
  // Consent buttons
  const btnConsentAgree = $('btn-consent-agree');
  if (btnConsentAgree) btnConsentAgree.textContent = t('consent.btn_agree');
  const btnConsentDecline = $('btn-consent-decline');
  if (btnConsentDecline) btnConsentDecline.textContent = t('consent.btn_decline');

  // Instructions button
  const btnInstrNext = $('btn-instructions-next');
  if (btnInstrNext) btnInstrNext.textContent = t('instruction.btn_start');

  // Demographics — title + subtitle come straight from the locale. The
  // locale is file-baseline + DB-overrides merged server-side, so platform
  // translation edits persist across redeploys (see db.loadLocaleWithOverrides
  // + locale_overrides table). No per-study override fields needed.
  const demoTitle = document.querySelector('#screen-demographics h2');
  if (demoTitle) demoTitle.textContent = t('demographics.title');
  const demoSubtitle = document.querySelector('#screen-demographics .screen-subtitle');
  if (demoSubtitle) demoSubtitle.textContent = t('demographics.subtitle');
  const btnDemoNext = $('btn-demographics-next');
  if (btnDemoNext) btnDemoNext.textContent = t('demographics.btn_next');
  const demoHint = $('demographics-hint');
  if (demoHint) demoHint.textContent = t('demographics.hint_fill_all');

  // Transition feed button
  const btnStartFeed = $('btn-start-feed');
  if (btnStartFeed) btnStartFeed.textContent = t('transition_feed.btn_start');

  // Transition rating button
  const btnStartRating = $('btn-start-rating');
  if (btnStartRating) btnStartRating.textContent = t('transition_rating.btn_start');

  // Camera consent buttons
  const btnCamYes = $('btn-camera-consent-yes');
  if (btnCamYes) btnCamYes.textContent = t('camera_consent.btn_agree');
  const btnCamNo = $('btn-camera-consent-no');
  if (btnCamNo) btnCamNo.textContent = t('camera_consent.btn_decline');

  // Calibration skip
  const btnCalSkip = $('cal-skip-btn');
  if (btnCalSkip) btnCalSkip.textContent = t('calibration.btn_skip');

  // Rating hint and next/finish buttons — updated dynamically per post
  const ratingHint = $('rating-hint');
  if (ratingHint) ratingHint.textContent = t('rating.hint_select');

  // ── Instruction screen ────────────────────────────────────────────────────
  const instrTitle = $('instruction-title');
  if (instrTitle) instrTitle.textContent = t('instruction.title');
  const iconLike    = $('icon-label-like');
  const iconDislike = $('icon-label-dislike');
  const iconShare   = $('icon-label-share');
  const iconFlag    = $('icon-label-flag');
  if (iconLike)    iconLike.textContent    = study.label_action_like    || t('instruction.icon_like');
  if (iconDislike) iconDislike.textContent = study.label_action_dislike || t('instruction.icon_dislike');
  if (iconShare)   iconShare.textContent   = study.label_action_share   || t('instruction.icon_share');
  if (iconFlag)    iconFlag.textContent    = study.label_action_flag    || t('instruction.icon_flag');
  // Builder studies can hide the reactions preview block entirely
  // (study.show_instruction_actions=false). Useful when the study disables
  // reactions altogether — showing icons that the participant won't see
  // later is confusing.
  const iconsPreview = $('instruction-icons-preview');
  if (iconsPreview) iconsPreview.style.display = study.show_instruction_actions === false ? 'none' : '';

  // ── Transition feed screen (feed layout) ─────────────────────────────────
  // Initial paint uses the feed locale. completePart() flips to the paged
  // variant (or a per-part override) when applicable. Both emoji and title
  // are locale-driven now — the previous HTML had the emoji hardcoded as
  // '📱' which couldn't be removed; the participant render path is now the
  // single source of truth.
  const transFeedEmoji = $('transition-feed-emoji');
  if (transFeedEmoji) transFeedEmoji.textContent = t('transition_feed.emoji');
  const transFeedTitle = $('transition-feed-title');
  if (transFeedTitle) transFeedTitle.textContent = t('transition_feed.title');

  // ── Transition rating heading ─────────────────────────────────────────────
  const transRatingTitle = $('transition-rating-title');
  if (transRatingTitle) transRatingTitle.textContent = t('transition_rating.h2_after_feed');

  // ── Feed footer button ────────────────────────────────────────────────────
  const btnProceedFeed = $('btn-proceed-feed');
  if (btnProceedFeed) btnProceedFeed.textContent = t('feed.btn_proceed_rating');

  // ── Rating next button default text ──────────────────────────────────────
  const btnRatingNext = $('btn-rating-next');
  if (btnRatingNext) btnRatingNext.textContent = t('rating.btn_next');

  // ── Paged back/next buttons ───────────────────────────────────────────────
  const btnPagedBack = $('btn-paged-back');
  const btnPagedNext = $('btn-paged-next');
  if (btnPagedBack) btnPagedBack.textContent = t('paged.btn_back');
  if (btnPagedNext) btnPagedNext.textContent = t('paged.btn_next');

  // ── Progress labels (Post X z Y / Ocena X z Y / Reagowałeś na X z Y postów) ──
  // Each label has a data-template attribute pointing to its locale key. The
  // template uses {{currentSpan}} / {{totalSpan}} so we re-insert the live
  // counter spans into the localized string instead of replacing them.
  function fillProgressTemplate(elId, currentSpanId, totalSpanId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const tplKey = el.dataset.template;
    if (!tplKey) return;
    // Save the existing span elements so we can put them back after re-rendering text
    const curSpan = document.getElementById(currentSpanId);
    const totSpan = document.getElementById(totalSpanId);
    const curVal = curSpan ? curSpan.textContent : '0';
    const totVal = totSpan ? totSpan.textContent : '0';
    const raw = t(tplKey, { current: '__CUR__', total: '__TOT__', reacted: '__CUR__' });
    // Rebuild: replace markers with <span id=...>value</span>
    el.innerHTML = raw
      .replace('__CUR__', `<span id="${currentSpanId}">${curVal}</span>`)
      .replace('__TOT__', `<span id="${totalSpanId}">${totVal}</span>`);
  }
  fillProgressTemplate('feed-progress-label',   'reacted-count', 'total-count');
  fillProgressTemplate('rating-progress-label', 'rating-current', 'rating-total');
  fillProgressTemplate('paged-progress-label',  'paged-current',  'paged-total');

  // ── Back-warning modal (browser back button) ─────────────────────────────
  const bwTitle = $('back-warning-title');
  if (bwTitle) bwTitle.textContent = t('back_warning.title');
  const bwBody = $('back-warning-body');
  if (bwBody) bwBody.textContent = t('back_warning.body');
  const bwStay = $('back-warning-stay');
  if (bwStay) bwStay.textContent = t('back_warning.stay');
  const bwLeave = $('back-warning-leave');
  if (bwLeave) bwLeave.textContent = t('back_warning.leave');

  // ── Debrief screen headings ───────────────────────────────────────────────
  const debriefTitle = $('debrief-title');
  if (debriefTitle) debriefTitle.textContent = t('debrief.title');
  const debriefSectionGoal = $('debrief-section-goal');
  if (debriefSectionGoal) debriefSectionGoal.textContent = t('debrief.section_goal');
  const debriefSectionPosts = $('debrief-section-posts');
  if (debriefSectionPosts) debriefSectionPosts.textContent = t('debrief.section_posts');
  const debriefPostsDesc = $('debrief-posts-description');
  if (debriefPostsDesc) debriefPostsDesc.textContent = t('debrief.posts_description');

  // ── Camera consent screen ─────────────────────────────────────────────────
  const camTitle = $('camera-consent-title');
  if (camTitle) camTitle.textContent = t('camera_consent.title');
  const camDesc = $('camera-consent-description');
  if (camDesc) camDesc.textContent = t('camera_consent.description');
  const camImportantTitle = $('camera-consent-important-title');
  if (camImportantTitle) camImportantTitle.textContent = t('camera_consent.important_title');
  const camBullets = [
    ['camera-consent-bullet-1', 'camera_consent.bullet_camera_only'],
    ['camera-consent-bullet-2', 'camera_consent.bullet_no_save'],
    ['camera-consent-bullet-3', 'camera_consent.bullet_coords_only'],
    ['camera-consent-bullet-4', 'camera_consent.bullet_optional'],
  ];
  camBullets.forEach(([id, key]) => {
    const el = $(id);
    if (el) el.textContent = t(key);
  });

  // ── Complete / no-consent / error screens ─────────────────────────────────
  const completeTitle = $('complete-title');
  if (completeTitle) completeTitle.textContent = t('screen.complete_title');
  const completeBody = $('complete-body');
  if (completeBody) completeBody.textContent = t('screen.complete_body');
  const noConsentTitle = $('no-consent-title');
  if (noConsentTitle) noConsentTitle.textContent = t('screen.no_consent_title');
  const noConsentBody = $('no-consent-body');
  if (noConsentBody) noConsentBody.textContent = t('screen.no_consent_body');
  const errorTitle = $('error-title');
  if (errorTitle) errorTitle.textContent = t('screen.error_title');
  // Note: error-message body is set per-error via showError(), not statically

  // ── Feed progress label ───────────────────────────────────────────────────
  // Progress label template is updated dynamically in updateFeedProgress()
  // Store the template in a data attribute for runtime use
  const feedProgressLabel = $('feed-progress-label');
  // Keep the {{reacted}} / {{total}} placeholders intact in the stored
  // template so updateFeedProgress can substitute live counts later. Calling
  // t() without these self-referential vars would consume the placeholders
  // (t() replaces every {{var}} with vars[var] ?? '' — missing vars → empty
  // string), leaving "Zareagowałeś/aś na  z  postów" forever — exactly the
  // "na z postów" we just saw in the screenshot.
  if (feedProgressLabel) {
    feedProgressLabel.dataset.template = t('feed.progress_label', {
      reacted: '{{reacted}}',
      total: '{{total}}',
    });
  }
}

async function startSession() {
  try {
    const isPreview = new URLSearchParams(window.location.search).get('preview') === '1';
    // Forward EVERY URL query param to the server so it can pick the
    // configured key for panel-recruitment ID capture. Different agencies
    // use different param names (res_id, pid, respondent_id, RID, …) so
    // we don't try to guess client-side — let the per-study config on the
    // server decide which key is the external ID for this study.
    const _qsParams = {};
    new URLSearchParams(window.location.search).forEach((v, k) => {
      // Skip ours-only keys that could collide / clutter (preview is the
      // app's own opt-in flag, never the panel param). Everything else
      // gets forwarded — server treats unknown keys as noise.
      if (k === 'preview') return;
      _qsParams[k] = v;
    });
    const data = await apiPost('/api/session/start', { study_id: S.config.id, preview: isPreview, url_params: _qsParams });
    S.session = data;
    S.posts = data.posts;
    // Show a small banner when this session is server-tagged as preview (because
    // either ?preview=1 was in the URL OR the admin-mode cookie said 'preview').
    // Real participants without the cookie never see this.
    if (data.is_preview === 1) showPreviewBanner();
    // Store post questions (builder mode)
    if (data.post_questions && data.post_questions.length) {
      S.postQuestions = data.post_questions;
    }
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

    // QA preview-focus mode — badacz uruchomił z panelu admin przycisk
    // "👁 Podgląd ekranu" przy pytaniach demograficznych. URL zawiera
    // ?focus=demographics. Pomijamy ekran zgody i instrukcji, renderujemy
    // demographics natychmiast. Sesja w DB jest is_preview=1 (cookie
    // admina + ?preview=1 razem), więc nie zaśmieca produkcyjnych danych.
    // Submit demographics w tym trybie pokazuje "Podgląd zakończony"
    // zamiast lecieć dalej w flow — patrz S.focusMode w obsłudze form.
    const _focus = new URLSearchParams(window.location.search).get('focus');
    if (_focus === 'demographics') {
      S.focusMode = 'demographics';
      // showDemographicsScreen pauzuje eye-tracking (ET.paused = true)
      // co dla podglądu nie ma znaczenia, ale jest spójne z prawdziwym
      // flow — gdyby kiedyś trzeba było rozszerzyć podgląd o eye-tracking.
      showDemographicsScreen();
      return;
    }
    if (_focus === 'debrief') {
      // QA preview — skok prosto na ekran debriefingu (przycisk "👁 Podgląd"
      // przy debriefingu w builderze). renderDebrief czyta S.posts (lista
      // prawda/fałsz) i teksty ze study; nie wywołuje /api/session/complete
      // ani przekierowania endlink, więc to czysty podgląd. Sesja is_preview=1.
      S.focusMode = 'debrief';
      renderDebrief({ debrief_text: data.study.debrief_text, contact_email: data.study.contact_email });
      showScreen('screen-debrief');
      // Render the endlink sticky header (agency-redirect notice) so the
      // preview matches the real completion screen. noAutoRedirect keeps the
      // researcher on the page — see runEndlinkRedirect. No-ops cleanly when
      // the study has no completion_redirect_url/notice configured.
      runEndlinkRedirect('completion', { noAutoRedirect: true });
      trackScreen('debrief-preview');
      return;
    }

    renderConsentScreen(data.study);
    showScreen('screen-consent');
    trackScreen('consent');
  } catch (e) {
    const errMsg = S.session?.locale ? t('errors.session_failed') : 'Failed to start session';
    showError(errMsg + ': ' + e.message);
  }
}

// ── Screen 1: Consent ──────────────────────────────────────────────────────
function renderConsentScreen(study) {
  // Institution badge — only show if explicitly set
  const instEl = $('consent-institution');
  if (instEl) {
    if (study.institution) {
      instEl.textContent = study.institution;
      instEl.style.display = '';
    } else {
      instEl.style.display = 'none';
    }
  }
  $('consent-study-name').textContent = study.participant_title || study.name || t('misc.study_default_name');
  $('consent-text').textContent = ts('consent_text') || study.consent_text;

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
    // Immediate-redirect short-circuit. When the researcher ticked
    // "Pomiń ekran odmowy" AND a decline URL is configured, navigate
    // straight to the agency without flashing the local "Rozumiemy"
    // screen. The panel owns the post-decline UX entirely. We still
    // sanitize the URL through the same http(s)-only check that
    // runEndlinkRedirect uses — guarding against a misconfigured
    // javascript:/data: value sneaking through the immediate path.
    const study = S.session && S.session.study;
    const immediate = study && study.decline_redirect_immediate;
    const rawUrl   = study && study.decline_redirect_url;
    if (immediate && rawUrl && typeof rawUrl === 'string') {
      const url = rawUrl
        .replace(/\{ext_id\}/g,     encodeURIComponent(S.session.external_id || ''))
        .replace(/\{session_id\}/g, encodeURIComponent(S.session.session_token || ''));
      if (/^https?:\/\//i.test(url)) {
        window.location.href = url;
        return;
      }
    }
    // Default flow: show the local thank-you screen, optionally fire
    // the timer-driven endlink redirect from there.
    showScreen('screen-no-consent');
    // Panel-recruitment: if the study has a decline endlink configured,
    // bounce the participant back to the agency's screen-out endpoint
    // (no points awarded but the agency closes the loop). No-op when
    // no decline URL is set — the local "Rozumiemy" screen stays.
    runEndlinkRedirect('decline');
  };
}

// ── Screen 2: Instructions ─────────────────────────────────────────────────
function renderInstructionScreen(study) {
  $('instruction-text').textContent = ts('instruction_text') || study.instruction_text;

  // Transition screens
  const feedBody = $('transition-feed-body');
  if (feedBody) feedBody.textContent = ts('transition_feed_text') || study.transition_feed_text;
  const ratingBody = $('transition-rating-body');
  if (ratingBody) ratingBody.textContent = ts('transition_rating_text') || study.transition_rating_text;

  // Paged / custom mode: swap to the paged transition variant. Both
  // strings are locale keys (transition_feed.emoji_paged /
  // .title_paged) so platform-translation edits propagate without
  // hardcoded fallbacks.
  if (study.layout_type === 'paged' || study.layout_type === 'custom') {
    const emoji = $('transition-feed-emoji');
    const title = $('transition-feed-title');
    if (emoji) emoji.textContent = t('transition_feed.emoji_paged');
    if (title) title.textContent = t('transition_feed.title_paged');

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

  function validateDemographics() {
    const questions = S.session && S.session.demographic_questions
      ? S.session.demographic_questions.filter(q => q.is_active && q.required)
      : [];
    if (!questions.length) {
      // fallback: check hardcoded fields
      const groups = ['age', 'residence', 'education', 'gender'];
      return groups.every(g => form.querySelector(`input[name="${g}"]:checked`));
    }
    return questions.every(q => {
      if (q.input_type === 'text' || q.input_type === 'number') {
        const el = form.querySelector(`input[name="${q.field_key}"]`);
        if (!el) return false;
        const val = el.value.trim();
        if (!val) return false;
        // HTML5 min/max/minlength/maxlength validation. checkValidity()
        // returns false when the value violates any attribute on the
        // element — covers number range, char-length, type='number' format.
        if (typeof el.checkValidity === 'function' && !el.checkValidity()) return false;
        return true;
      }
      // Multiselect wymaga przynajmniej jednej zaznaczonej opcji (validate
      // jest wywoływany tylko gdy q.required). Radio działa identycznie:
      // pierwszy :checked dowodzi że uczestnik dokonał wyboru.
      return !!form.querySelector(`input[name="${q.field_key}"]:checked`);
    });
  }

  function checkComplete() {
    const allFilled = validateDemographics();
    btn.disabled = !allFilled;
    $('demographics-hint').style.display = allFilled ? 'none' : '';
  }

  form.addEventListener('change', checkComplete);
  form.addEventListener('input', checkComplete);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // QA preview-focus mode — researcher otworzył ekran demograficznych
    // jako podgląd z panelu admin (przycisk "👁 Podgląd ekranu"). Submit
    // NIE leci do API ani do dalszego flow — pokazujemy panel "Podgląd
    // zakończony" w miejscu karty formularza. Brak walidacji bo to nie
    // jest realna odpowiedź, tylko researcher chce zobaczyć że ekran
    // się rendreuje.
    if (S.focusMode === 'demographics') {
      const card = document.querySelector('#screen-demographics .card');
      if (card) {
        card.innerHTML = `
          <div style="text-align:center;padding:2rem">
            <div style="font-size:3rem;margin-bottom:1rem">✅</div>
            <h2 style="margin-bottom:0.5rem">Podgląd zakończony</h2>
            <p style="color:var(--muted);max-width:24rem;margin:0.5rem auto">
              Ekran pytań demograficznych wyrenderował się poprawnie.
              Możesz zamknąć tę kartę.
            </p>
          </div>
        `;
      }
      return;
    }
    const fd = new FormData(form);
    const questions = S.session && S.session.demographic_questions
      ? S.session.demographic_questions
      : [];

    // Collect ALL fields from the form (both legacy and custom).
    // Multiselect = wiele checkboxów z tym samym name → fd.getAll() zwraca
    // tablicę wartości; łączymy przecinkami jako jedna komórka w eksporcie
    // (researcher może łatwo splitować w Excelu). Inne typy biorą tylko
    // pierwszą (i jedyną) wartość przez fd.get().
    let payload = { session_token: S.session.session_token };
    if (questions.length) {
      questions.forEach(q => {
        if (q.input_type === 'multiselect') {
          const values = fd.getAll(q.field_key);
          payload[q.field_key] = values.length ? values.join(', ') : null;
        } else {
          payload[q.field_key] = fd.get(q.field_key) || null;
        }
      });
    } else {
      ['age', 'residence', 'education', 'gender'].forEach(k => { payload[k] = fd.get(k) || null; });
    }

    try {
      await apiPost('/api/session/demographics', payload);
      S.demographicsSubmitted = true;
      // Conditional logic: demographic screen-out / branching. If a rule ends
      // the study, stop here (don't proceed into the transition/main phase).
      captureDemographics(payload);
      if (applyLogic('after_demographics')) return;
      ET.paused = false; // resume gaze tracking — personal data screen is done (RODO)
      const study = S.session.study;
      // Two completion paths:
      //   - position='before_debrief': demographics ran at the END, so the
      //     next step is finalizing the session (completeSession handles the
      //     transition into the debrief screen).
      //   - position='after_consent': legacy flow — proceed to transition or
      //     directly to the main phase.
      if (getDemographicsPosition() === 'before_debrief') {
        await completeSession();
      } else if (study.show_transition_feed) {
        showScreen('screen-transition-feed');
      } else {
        startMainPhase();
      }
    } catch (err) { showError(err.message); }
  });
})();

// ── Screen 4: Transition ───────────────────────────────────────────────────
// ── Per-part runtime layout switching ──────────────────────────────────────
// Each part in study.parts_json carries its own `layout` ('feed' | 'paged' |
// 'custom'). The flow runs parts in order: render current part using its
// layout, wait for completion (all reactions in feed mode / pagedIndex >=
// post count in paged mode), then transition to the next part (with its own
// transition screen if configured) which may have a different layout.
//
// S.allPosts holds the full post list from the server. S.posts is reassigned
// per-part to that part's slice; renderFeed / renderPagedPost iterate
// S.posts so swapping in place is sufficient. All reaction/comment maps stay
// keyed by post.id so they survive part transitions.

function getOrderedParts() {
  const parts = (S.session?.parts || []);
  if (parts.length) return parts;
  // No parts in payload — synthesize a single part using study-level layout
  // so the rest of the per-part flow has something to iterate without
  // special-casing legacy studies.
  return [{ id: null, label: 'Część 1', layout: S.session?.study?.layout_type || 'feed' }];
}

function getPostsForPart(part, partIdx) {
  if (!S.allPosts) return [];
  if (!part.id) return S.allPosts.slice();
  // A post belongs to this part if its part_ids array contains part.id
  // (multi-part assignment) OR — legacy fallback — its primary part_id
  // matches. The same post may legitimately appear in multiple parts (e.g.
  // part 1 = feed for reactions, part 2 = paged with questions); we don't
  // dedupe across parts because the researcher explicitly assigned it twice.
  const idsOf = p => (Array.isArray(p.part_ids) && p.part_ids.length)
    ? p.part_ids
    : (p.part_id ? [p.part_id] : []);
  const matching = S.allPosts.filter(p => idsOf(p).includes(part.id));
  if (partIdx === 0) {
    // First part also catches orphans (posts created without any part assignment)
    const orphans = S.allPosts.filter(p => !idsOf(p).length);
    return [...matching, ...orphans];
  }
  return matching;
}

// ── Per-part countdown timer ────────────────────────────────────────────────
// When a part declares max_seconds > 0, the participant has that long to
// finish the part. On expiry we force completePart regardless of whether
// requirements were met — researchers use this for time-pressure manipulations
// and to cap dwell on each section. A small "⏱ M:SS" badge appears next to
// the progress bar of whichever layout the part uses.
//
// State lives on S.partTimer; clearPartTimer is idempotent and safe to call
// from any cleanup path (completePart, startPart re-entry, etc).
// Wipe the timer slot from BOTH possible progress bars — we may have
// mounted it under feed-progress-bar last part and the user is now on a
// paged part (or vice versa). Then re-sync compact visibility for both
// so the native progress label is restored where appropriate.
function clearPartTimerSlots() {
  // Strip the legacy floating badge from earlier builds (mid-deploy reloads
  // could leave it parented to the sticky div, outside the new slot model).
  const oldBadge = document.getElementById('part-timer-badge');
  if (oldBadge) oldBadge.remove();
  ['feed-progress-bar', 'paged-progress-bar'].forEach(pbId => {
    const sticky = document.getElementById(pbId);
    const slot = sticky?.querySelector(':scope > .part-status-bar > .part-status-timer-slot');
    if (slot) { slot.textContent = ''; slot.style.display = 'none'; slot.style.cssText = 'display:none'; }
    syncCompactStatusVisibility(pbId);
  });
}

function clearPartTimer() {
  if (S.partTimer) {
    if (S.partTimer.timeoutId)  clearTimeout(S.partTimer.timeoutId);
    if (S.partTimer.intervalId) clearInterval(S.partTimer.intervalId);
    S.partTimer = null;
  }
  clearPartTimerSlots();
}

function startPartTimer(maxSeconds, screenId) {
  clearPartTimer();
  if (!(maxSeconds > 0)) return;
  const expiresAt = Date.now() + maxSeconds * 1000;
  // Mount the timer pill inside the compact status bar's timer slot. The
  // slot sits alongside the checklist slot so both share one horizontal
  // row, replacing the native "Post N / Total" progress UI to save the
  // vertical space the user complained about.
  const progressBarId = (screenId === 'screen-paged') ? 'paged-progress-bar' : 'feed-progress-bar';
  const bar = ensureCompactStatusBar(progressBarId);
  const slot = bar?.querySelector('.part-status-timer-slot');
  if (!slot) return;
  // Reset to base palette every arm — the previous part might have left
  // it in the red-urgent state.
  slot.style.cssText = 'display:inline-flex;align-items:center;padding:0.22rem 0.7rem;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:999px;font-size:0.85rem;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1';

  const fmt = ms => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `⏱ ${m}:${s.toString().padStart(2, '0')}`;
  };
  slot.textContent = fmt(maxSeconds * 1000);
  syncCompactStatusVisibility(progressBarId);

  const intervalId = setInterval(() => {
    const remaining = expiresAt - Date.now();
    slot.textContent = fmt(remaining);
    // Visual urgency under 30s — switch to red so the participant has
    // a chance to wrap up before auto-advance.
    if (remaining <= 30000) {
      slot.style.background = '#fee2e2';
      slot.style.borderColor = '#fca5a5';
      slot.style.color = '#991b1b';
    }
  }, 500);
  const timeoutId = setTimeout(() => {
    clearPartTimer();
    // completePart handles "next part or completeSession". Wrapping in a
    // try/catch protects the timer fire from unmounting weirdness mid-
    // navigation (e.g. participant already clicked Dalej manually).
    try { completePart(); } catch {}
  }, Math.max(0, expiresAt - Date.now()));
  S.partTimer = { expiresAt, intervalId, timeoutId };
}

function startPart(idx) {
  // Any previous part's timer must be cleared before we wire up the new
  // one — otherwise a fast clicker on the manual Dalej button could leave
  // a stale timer that fires during part 2 and force-advances it.
  clearPartTimer();
  // Also wipe the checklist slots on BOTH progress bars. We may be moving
  // from feed→paged (or back) and the previous part's compact bar would
  // otherwise linger in the inactive screen — visible the moment the
  // participant ever returns to that layout in a later part.
  ['feed-progress-bar', 'paged-progress-bar'].forEach(pbId => {
    const slot = document.getElementById(pbId)?.querySelector(':scope > .part-status-bar > .part-status-checklist-slot');
    if (slot) { slot.innerHTML = ''; slot.style.display = 'none'; }
    syncCompactStatusVisibility(pbId);
  });
  const parts = getOrderedParts();
  if (idx < 0 || idx >= parts.length) {
    completeSession();
    return;
  }
  S.currentPartIdx = idx;
  const part = parts[idx];
  S.posts = getPostsForPart(part, idx);
  S.pagedIndex = 0;
  // Skip empty parts (no posts) — go straight to the next one
  if (!S.posts.length) {
    completePart();
    return;
  }
  const layout = part.layout || S.session?.study?.layout_type || 'feed';
  // Sync study.layout_type to the active part so downstream code that still
  // reads it (e.g. some legacy callsites) sees the right value mid-flight.
  if (S.session?.study) S.session.study.layout_type = layout;
  const screenId = (layout === 'paged' || layout === 'custom') ? 'screen-paged' : 'screen-feed';
  if (screenId === 'screen-paged') {
    renderPagedPost();
    showScreen(screenId);
    trackScreen('part_' + idx + '_paged');
  } else {
    renderFeed();
    showScreen(screenId);
    trackScreen('part_' + idx + '_feed');
  }
  // Start the countdown AFTER the screen is mounted so the badge has a
  // visible anchor to attach to.
  startPartTimer(Number(part.max_seconds) || 0, screenId);
}

// ── Conditional logic runtime ───────────────────────────────────────────────
// Evaluates the study's logic_json rules (via the shared lib/logic.js engine
// exposed as window.MisinfoLogic) at flow checkpoints and applies skip_part /
// end_study. No-op in preview so an admin testing a rule-heavy study isn't
// trapped. Context is accumulated as the participant progresses.
function captureDemographics(payload) {
  S.logicCtx = S.logicCtx || { demographics: {}, answers: {} };
  Object.keys(payload || {}).forEach(k => { if (k !== 'session_token') S.logicCtx.demographics[k] = payload[k]; });
}
function captureLogicAnswer(qid, value) {
  S.logicCtx = S.logicCtx || { demographics: {}, answers: {} };
  S.logicCtx.answers[String(qid)] = value;
}
function logicPartSkipped(part) {
  return !!(part && S.logicSkipped && S.logicSkipped.has(part.id));
}
// Returns true if a rule ENDED the study (so the caller stops its own flow).
function applyLogic(timing) {
  try {
    if (!S.session || S.session.is_preview) return false; // preview: rules never fire
    const logic = S.session.logic;
    if (!logic || !Array.isArray(logic.rules) || !window.MisinfoLogic) return false;
    const out = window.MisinfoLogic.evaluateRules(logic.rules, buildLogicContext(), timing);
    S.logicSkipped = S.logicSkipped || new Set();
    out.skipParts.forEach(pid => {
      if (!S.logicSkipped.has(pid)) {
        S.logicSkipped.add(pid);
        apiPost('/api/session/logic-event', { session_token: S.session.session_token, skipped_part_id: pid }).catch(() => {});
      }
    });
    // goto_part (after_part only): jump to a specific part; completePart consumes it.
    if (out.goto) S.pendingGoto = out.goto;
    if (out.end) {
      apiPost('/api/session/logic-event', { session_token: S.session.session_token, end_rule_id: out.endRuleId }).catch(() => {});
      endStudyByLogic(out.message);
      return true;
    }
    return false;
  } catch (_) { return false; }
}
// Full evaluation context: demographics + assigned condition + answers + the
// list of reaction actions the participant has used so far.
function buildLogicContext() {
  const reactions = [];
  // Feed mode uses S.reactions; paged mode uses S.pagedReactions — include both.
  [S.reactions, S.pagedReactions].forEach(map => {
    Object.values(map || {}).forEach(v => { (Array.isArray(v) ? v : [v]).forEach(a => { if (a) reactions.push(a); }); });
  });
  return {
    demographics: (S.logicCtx && S.logicCtx.demographics) || {},
    answers: (S.logicCtx && S.logicCtx.answers) || {},
    condition: S.session.style_condition || S.session.full_condition || null,
    reactions,
  };
}
// Question ids currently hidden by a hide_question rule (render-time state).
function logicHiddenQuestionSet() {
  try {
    if (!S.session || S.session.is_preview) return null;
    const logic = S.session.logic;
    if (!logic || !Array.isArray(logic.rules) || !window.MisinfoLogic || !window.MisinfoLogic.hiddenQuestionIds) return null;
    const ids = window.MisinfoLogic.hiddenQuestionIds(logic.rules, buildLogicContext());
    return ids.length ? new Set(ids) : null;
  } catch (_) { return null; }
}
function endStudyByLogic(message) {
  if (message) showBlockingNotice(message, () => completeSession());
  else completeSession();
}
function showBlockingNotice(message, onNext) {
  let ov = document.getElementById('logic-end-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'logic-end-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:30000;display:flex;align-items:center;justify-content:center;background:var(--bg,#f5f5f7);padding:24px';
    ov.innerHTML = '<div style="background:var(--surface,#fff);max-width:460px;padding:28px 30px;border-radius:14px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.12)">'
      + '<div id="logic-end-text" style="font-size:1rem;line-height:1.6;color:var(--text,#222);margin-bottom:18px;white-space:pre-wrap"></div>'
      + '<button type="button" id="logic-end-btn" class="btn btn-primary">Dalej →</button></div>';
    document.body.appendChild(ov);
  }
  ov.querySelector('#logic-end-text').textContent = message;
  ov.style.display = 'flex';
  ov.querySelector('#logic-end-btn').onclick = () => { ov.style.display = 'none'; onNext && onNext(); };
}

function completePart() {
  // Defensive: clear any active timer before transitioning, even on manual
  // completePart calls (Dalej click, auto-advance from handleReaction).
  clearPartTimer();
  // Conditional logic: evaluate now that this part is done. May end the study
  // early (→ we bail), jump to a specific part (goto), or skip later parts.
  if (applyLogic('after_part')) return;
  const parts = getOrderedParts();
  let nextIdx;
  if (S.pendingGoto) {
    // goto_part: jump to the target part. Bounded by a per-session jump cap so a
    // pair of mutually-jumping rules can't trap the participant in a loop.
    const gi = parts.findIndex(p => p.id === S.pendingGoto);
    S.pendingGoto = null;
    S.logicGotoCount = (S.logicGotoCount || 0) + 1;
    nextIdx = (gi >= 0 && S.logicGotoCount <= 20) ? gi : (S.currentPartIdx ?? 0) + 1;
  } else {
    nextIdx = (S.currentPartIdx ?? 0) + 1;
    // Jump over any parts a rule marked for skipping.
    while (nextIdx < parts.length && logicPartSkipped(parts[nextIdx])) nextIdx++;
  }
  if (nextIdx >= parts.length) {
    completeSession();
    return;
  }
  const nextPart = parts[nextIdx];
  // If the next part wants an explicit transition screen, show it and wire
  // the existing "Rozpocznij" button to advance into that part. Otherwise
  // jump straight in.
  if (nextPart.show_transition) {
    const titleEl = document.getElementById('transition-feed-title');
    const bodyEl  = document.getElementById('transition-feed-body');
    const emojiEl = document.getElementById('transition-feed-emoji');
    const btnEl   = document.getElementById('btn-start-feed');
    if (titleEl) titleEl.textContent = nextPart.label || 'Następna część';
    if (bodyEl)  bodyEl.textContent  = nextPart.transition_text || '';
    // Per-part emoji. Convention:
    //   undefined  → use the LOCALE default (so changing transition_feed.emoji
    //                in the platform translations modal propagates here too).
    //   ''         → hide the emoji entirely (researcher explicitly cleared
    //                this part's emoji).
    //   any string → render that exact string.
    // Always reset display:'' first because a previous part in this session
    // might have hidden the emoji — without that reset, an unset part-2
    // would inherit part-1's hidden state.
    if (emojiEl) {
      const pe = nextPart.transition_emoji;
      emojiEl.style.display = '';
      if (typeof pe === 'string') {
        if (pe === '') {
          emojiEl.style.display = 'none';
        } else {
          emojiEl.textContent = pe;
        }
      } else {
        emojiEl.textContent = t('transition_feed.emoji');
      }
    }
    if (btnEl) btnEl.onclick = () => startPart(nextIdx);
    showScreen('screen-transition-feed');
    return;
  }
  startPart(nextIdx);
}

function startMainPhase() {
  // Stash the full post list once — startPart will swap S.posts to a
  // per-part slice and we need the original to resolve subsequent parts.
  if (!S.allPosts) S.allPosts = S.posts || [];
  startPart(0);
}

$('btn-start-feed').onclick = () => startMainPhase();

// ── Screen 5: Feed ────────────────────────────────────────────────────────
function renderFeed() {
  const container = $('feed-container');
  container.innerHTML = '';
  updateFeedProgress();
  // Phase 3 — render the per-part checklist under the feed progress bar
  // for parts that declared structured requirements. No-op for legacy
  // parts (evalPartRequirements returns reqs=[] → checklist hidden).
  refreshPartChecklistForFeed();

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
  const isHighMetric = (() => {
    const mc = S.session.metric_condition;
    if (!mc || mc === 'BUILDER') return false;
    // Legacy: 'HIGH' = high metrics; builder: check against study's high threshold
    if (mc === 'HIGH') return true;
    if (mc === 'LOW') return false;
    // For custom condition names, treat as high if min > 100 (arbitrary threshold)
    const cond = S.session.posts?.[0]?.metric_min != null
      ? { min: S.session.posts[0].metric_min }
      : null;
    return cond ? cond.min > 100 : false;
  })();
  const hideTopics = S.session.study.hide_topic_badges;

  const div = document.createElement('div');
  div.className = 'feed-post';
  div.dataset.postId = post.id;
  div.dataset.postOrder = post.post_order;

  const metricClass = isHighMetric ? 'high' : 'low';
  const topicPill = (TOPIC_PILL_DISABLED || hideTopics || post.hide_topic) ? '' :
    `<span class="topic-pill ${topicClass(post.topic)}">${esc(post.emoji)} ${esc(topicLabel(post.topic))}</span>`;

  const showMetrics = S.session.study.show_metrics !== false && S.session.study.show_metrics !== 0;
  // Per-part show_reactions wins over study-level study.show_reactions.
  // Default true at both levels. Used to omit the <div class="post-actions">
  // entirely from the card when reactions are hidden.
  const partCfgForReactions = getPartConfig(post);
  const partShowReactions = partCfgForReactions?.show_reactions !== false && partCfgForReactions?.show_reactions !== 0;
  const showReactions = partShowReactions && (S.session.study.show_reactions !== false);
  // Per-post interaction toggles. Each defaults to true so legacy posts
  // (and any session payload that doesn't include the field) show the
  // button. False = explicit per-post hide. Comment is gated on top by
  // study.enable_comments at the study level.
  const showLike    = post.show_like    !== false;
  const showDislike = post.show_dislike !== false;
  const showShare   = post.show_share   !== false;
  const showFlag    = post.show_flag    !== false;
  const showComment = post.show_comment !== false;

  // Build header pieces conditionally. When the researcher left source name,
  // handle, time AND avatar blank (image-only post), render NO header at all
  // — previously a lone " · " separator showed above the content.
  const _avatar = avatarHTML(post.source_name, post.avatar_url, '', post.show_avatar !== false);
  const _source = (post.source_name || '').trim();
  const _meta   = metaLine(post.source_handle, post.time_ago);
  const _headerHTML = (_avatar || _source || _meta || topicPill) ? `
    <div class="post-header" data-clarity-unmask="true">
      ${_avatar}
      ${(_source || _meta) ? `<div class="post-meta">
        ${_source ? `<div class="post-source" data-clarity-unmask="true">${esc(_source)}</div>` : ''}
        ${_meta ? `<div class="post-handle" data-clarity-unmask="true">${esc(_meta)}</div>` : ''}
      </div>` : ''}
      ${topicPill}
    </div>` : '';

  div.innerHTML = `
    ${_headerHTML}
    <div class="post-body" data-clarity-unmask="true">
      <h3 class="post-headline" data-clarity-unmask="true">${esc(post.headline)}</h3>
      <p class="post-content" data-clarity-unmask="true">${esc(formatPostText(post.content))}</p>
    </div>
    ${post.image_url ? `<div class="post-image"><img src="${post.image_url}" alt="" loading="lazy"></div>` : ''}
    ${showMetrics ? `
    <div class="post-metrics">
      <span class="metric ${metricClass}" data-metric="like">👍 ${formatNum(post.likes_shown)}</span>
      <span class="metric ${metricClass}" data-metric="dislike">👎 ${formatNum(post.dislikes_shown)}</span>
      <span class="metric ${metricClass}" data-metric="share">🔄 ${formatNum(post.shares_shown)}</span>
      <span class="metric ${metricClass}" data-metric="flag">🚩 ${formatNum(post.flags_shown)}</span>
      ${(post.builder_comments||[]).length ? `<span class="metric ${metricClass}">💬 ${formatNum((post.builder_comments||[]).length)}</span>` : ''}
    </div>` : ''}
    ${(post.builder_comments||[]).length ? `
    <div class="post-comments-list">
      ${(post.builder_comments||[]).map(c => `
        <div class="post-comment-item">
          <div class="post-comment-avatar">${esc((c.author||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2))}</div>
          <div class="post-comment-body">
            <span class="post-comment-author">${esc(c.author||'')}</span>
            <span class="post-comment-text">${esc(c.text||'')}</span>
            ${c.likes ? `<span class="post-comment-likes">👍 ${formatNum(c.likes)}</span>` : ''}
          </div>
        </div>`).join('')}
    </div>` : ''}
    ${showReactions && (showLike || showDislike || showShare || showFlag) ? `
    <div class="post-actions">
      ${showLike    ? `<button class="action-btn" data-action="like"><span class="action-icon">👍</span>${esc(S.session.study.label_action_like || t('actions.like'))}</button>` : ''}
      ${showDislike ? `<button class="action-btn" data-action="dislike"><span class="action-icon">👎</span>${esc(S.session.study.label_action_dislike || t('actions.dislike'))}</button>` : ''}
      ${showShare   ? `<button class="action-btn" data-action="share"><span class="action-icon">🔄</span>${esc(S.session.study.label_action_share || t('actions.share'))}</button>` : ''}
      ${showFlag    ? `<button class="action-btn" data-action="flag"><span class="action-icon">🚩</span>${esc(S.session.study.label_action_flag || t('actions.flag'))}</button>` : ''}
    </div>` : ''}
    ${(showReactions && S.session.study.enable_comments && showComment) ? `
    <div class="feed-participant-comment-wrap" data-post-id="${post.id}">
      <textarea class="paged-comment-area feed-comment-input" rows="2"
        placeholder="${esc(S.session.study.comment_placeholder || t('actions.comment_placeholder'))}"
        data-post-id="${post.id}">${esc((S.feedComments && S.feedComments[post.id]) || '')}</textarea>
    </div>` : ''}
  `;

  div.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => handleReaction(post, btn.dataset.action, div));
  });
  // Wire comment textarea — keystrokes stored in S.feedComments[post.id],
  // flushed to the server alongside the next reaction (handleReaction payload).
  // Without S.feedComments, feed-mode comment input would be a write-only widget.
  const commentEl = div.querySelector('.feed-comment-input');
  if (commentEl) {
    S.feedComments = S.feedComments || {};
    commentEl.addEventListener('input', () => {
      S.feedComments[post.id] = commentEl.value || '';
      // Refresh the visual checklist counts AND the Dalej-button gate.
      // Both read the same evalPartRequirements result, but only one is
      // wired to comment-typing: refreshPartChecklistForFeed redraws the
      // checklist, updateFeedProgress re-evaluates partBtn.disabled.
      // Without the second call the user sees a green checklist while
      // Dalej stays disabled — and only un-stucks itself on the next
      // reaction click (which fires updateFeedProgress via handleReaction).
      refreshPartChecklistForFeed();
      updateFeedProgress();
      // Persist to server (debounced) so the comment lands in Excel even
      // when the participant types but never clicks a reaction afterwards.
      scheduleCommentSave(post, commentEl.value || '');
    });
  }

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
  // Branch on multi-react mode. Single (legacy): clicking any action
  // becomes THE reaction, replacing whatever was there. Multi: stack
  // non-opposing reactions; like/dislike are mutex; re-click toggles off.
  let isUndo = false;
  if (isMultiReactMode()) {
    const before = reactionsOfFeed(post.id);
    const { next, removed } = applyMultiReactClick(before, action);
    S.reactions[post.id] = next;
    isUndo = !!removed;  // tells server this click was a toggle-off
    // Reset all buttons, then highlight every action currently active.
    cardEl.querySelectorAll('.action-btn').forEach(b => { b.className = 'action-btn'; });
    next.forEach(act => {
      const btn = cardEl.querySelector(`.action-btn[data-action="${act}"]`);
      if (btn) btn.classList.add(`active-${act}`);
    });
    // "Reacted" visual flag should stay as long as at least one reaction
    // remains on the card. Strip it when the user undoes their last one.
    cardEl.classList.toggle('reacted', next.length > 0);
  } else {
    // Single-react legacy path: replace the value, highlight one button.
    cardEl.querySelectorAll('.action-btn').forEach(b => {
      b.className = 'action-btn';
      if (b.dataset.action === action) b.classList.add(`active-${action}`);
    });
    S.reactions[post.id] = action;
    cardEl.classList.add('reacted');
  }
  // UI-only: bump/decrement the visible counter next to the icon so the
  // participant sees their own +1 land. Server-sent base values stay
  // untouched — refreshShownMetrics re-derives display = base + (active?1:0).
  refreshShownMetrics(cardEl, post, reactionsOfFeed(post.id));
  updateFeedProgress();
  // Refresh the Phase 3 part-checklist live so the counter ticks as the
  // participant reacts. No-op when the current part has no structured
  // requirements declared.
  refreshPartChecklistForFeed();

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
    // Carry whatever the participant has typed into the feed-mode comment box
    // for this post. Backend accepts comment as optional and persists it on
    // the reactions row; keeps the wire shape flat so we don't need a separate
    // /api/feed-comment round trip.
    comment: (S.feedComments && S.feedComments[post.id]) || null,
    // Multi-react: distinguish "I clicked share to add it" from "I clicked
    // share to remove a previous share". Backend uses this to keep the
    // append log honest while letting the latest-row-per-action lookup
    // resolve to "not currently reacted".
    is_undo: isUndo ? 1 : 0,
  };
  apiPost('/api/reaction', payload).catch(() => apiPost('/api/reaction', payload).catch(() => {}));

  // Conditional logic: evaluate on this reaction (after_interaction timing).
  // May end the study early — bail before showing follow-up questions.
  if (applyLogic('after_interaction')) return;

  // Show post questions inline below the card (builder mode). Filter by
  // the post's part — a part-2 question should not pop after a part-1
  // reaction.
  if (getPostQuestionsForPost(post).length > 0) {
    showPostQuestionsInline(post, cardEl);
    return;
  }
  // No auto-advance from here. Reaction clicks update S.reactions, the
  // checklist counts, and the Dalej-button gate (via updateFeedProgress)
  // — but the actual part transition is participant-driven now: they
  // click the always-visible "Dalej →" button or the part's max_seconds
  // timer expires. Auto-advance was firing on EVERY reaction that
  // happened to satisfy the gate, including reactions that just toggled
  // an existing one off and then back — yanking the user mid-interaction
  // into the next part. The Dalej button is enough.
}

// Debounced persist of the participant's comment text to the server. The
// reaction-row INSERT path normally carries the comment along for the ride,
// but only when the participant clicks a reaction afterwards. A participant
// who types a comment and never clicks anything (or types after their last
// reaction click) would otherwise lose the comment — no /api/reaction fires
// and Excel shows an empty post_N_comment cell. We post with the synthetic
// action='comment' (server special-cases it: dedupes by action='comment'
// only, never wipes real reaction rows, skips the like/dislike mutex). Per-
// post timers so concurrent edits on different feed cards don't cancel one
// another's pending save.
function scheduleCommentSave(post, text) {
  if (!post || post.id == null) return;
  S._commentTimers = S._commentTimers || {};
  const t = S._commentTimers;
  if (t[post.id]) clearTimeout(t[post.id]);
  t[post.id] = setTimeout(() => {
    delete t[post.id];
    const trimmed = (text || '').trim();
    apiPost('/api/reaction', {
      session_token: S.session.session_token,
      post_id: post.id,
      post_order: post.post_order,
      action: 'comment',
      comment: trimmed || null,
      // Carry the displayed metric values on the comment row too. Without
      // these, the server stored zeros on the comment row, and the export
      // (which picks reactionRows[0] for metric "shown" columns) read 0
      // for every session whose participant commented before reacting —
      // the "post_4_likes_shown=0 even though base_likes=10" bug.
      likes_shown:    post.likes_shown,
      shares_shown:   post.shares_shown,
      dislikes_shown: post.dislikes_shown,
      flags_shown:    post.flags_shown,
      // Empty text = participant cleared the textarea; record an is_undo=1
      // row so the export's active-state resolver reads "no comment" rather
      // than the stale previous value.
      is_undo: trimmed ? 0 : 1,
    }).catch(() => {});
  }, 1200);
}

function getDwell(postId) {
  let total = S.dwellAccum[postId] || 0;
  if (S.dwellStart[postId]) total += Date.now() - S.dwellStart[postId];
  return total;
}

// Post-view dwell flush — fires /api/post-view with a delta segment so the
// server can record viewing time for posts the participant scrolled past
// WITHOUT reacting. The reactions row already carries dwell_ms for posts
// that got a like/dislike/share/flag (export prefers that), so this fills
// the gap for the "scrolled past, did nothing" case. Sent on:
//   • feed: every time a post leaves the viewport (IntersectionObserver)
//   • paged: every time the participant advances past a post
//   • page unload: any post still in-flight at exit
// Using sendBeacon for the unload case so the request survives navigation.
// Server upserts into post_views with `dwell_ms = dwell_ms + delta`, so
// multiple flushes for the same post accumulate correctly (allow_back
// re-visits, IntersectionObserver re-entry, etc).
function flushPostViewDwell(postId, postOrder, deltaMs) {
  if (!postId || !deltaMs || deltaMs <= 0) return;
  if (!S.session || !S.session.session_token) return;
  const payload = {
    session_token: S.session.session_token,
    post_id: postId,
    post_order: postOrder || null,
    dwell_ms: Math.round(deltaMs),
  };
  // Best-effort fire-and-forget; failure is non-fatal — reactions row
  // remains the canonical source of dwell when one exists.
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/api/post-view', blob);
    } else {
      apiPost('/api/post-view', payload).catch(() => {});
    }
  } catch (_) {
    apiPost('/api/post-view', payload).catch(() => {});
  }
}

// Flush any in-flight dwell segments when the page is closing or hidden —
// otherwise the active feed post (still in viewport) and the active paged
// post (still rendered) would lose their final segment. Idempotent: clears
// the started-at marker after flushing so a subsequent fire is a no-op.
function flushAllInFlightDwell() {
  // Feed mode: any post currently in viewport has S.dwellStart[id].
  for (const idStr of Object.keys(S.dwellStart || {})) {
    const startedAt = S.dwellStart[idStr];
    if (!startedAt) continue;
    const id = Number(idStr);
    const delta = Date.now() - startedAt;
    // Find post_order from S.posts if available.
    const p = (S.posts || []).find(pp => pp.id === id);
    flushPostViewDwell(id, p ? p.post_order : null, delta);
    delete S.dwellStart[idStr];
  }
  // Paged mode: the current paged post has a pagedDwellStart entry.
  const cur = S.posts && S.posts[S.pagedIndex];
  if (cur && S.pagedDwellStart && S.pagedDwellStart[cur.id]) {
    const delta = Date.now() - S.pagedDwellStart[cur.id];
    flushPostViewDwell(cur.id, cur.post_order, delta);
    delete S.pagedDwellStart[cur.id];
  }
}
window.addEventListener('pagehide', flushAllInFlightDwell);
window.addEventListener('beforeunload', flushAllInFlightDwell);

function updateFeedProgress() {
  // Per-part flow: reactions tracker accumulates across parts (keyed by
  // post.id) but the visible progress bar should reflect ONLY the current
  // part's posts. Otherwise a 2-part feed study with 5+5 posts would jump
  // straight to 100% as soon as the participant enters part 2.
  const currentIds = new Set((S.posts || []).map(p => p.id));
  // Multi-react safe: S.reactions[id] = [] is still an own key, so
  // `Object.keys` would overcount posts whose reactions got toggled off.
  // reactionsOfFeed returns the normalised array — non-empty means the
  // post still has at least one active reaction.
  const reacted = Object.keys(S.reactions || {})
    .filter(id => currentIds.has(Number(id)) && reactionsOfFeed(id).length > 0).length;
  const total = S.posts.length;
  $('feed-fill').style.width = total > 0 ? `${(reacted / total) * 100}%` : '0%';
  const isBuilderStudy = S.config?.builder_mode === 1;
  // Legacy (non-builder) studies: footer shows the rating-phase CTA only
  // when everything's reacted to.
  if (!isBuilderStudy && reacted >= total) $('feed-footer').classList.add('visible');
  // Builder studies: keep an ALWAYS-visible "Dalej →" button so the
  // participant never gets stuck if the auto-advance heuristic doesn't
  // fire (e.g. post-questions not all submitted, structured-requirements
  // not all met, missed-reaction). The button is disabled until the gate
  // condition is met; clicking it manually calls completePart. Without
  // this safety net a feed part has NO visible affordance to advance,
  // which is exactly the "no button, not even disabled" report.
  if (isBuilderStudy) {
    const footer = $('feed-footer');
    const ratingBtn = $('btn-proceed-feed');
    const partBtn = $('btn-feed-next-part');
    if (footer) footer.classList.add('visible');
    if (ratingBtn) ratingBtn.style.display = 'none';
    if (partBtn) {
      partBtn.style.display = '';
      // Gate: if the part declared Phase 3 structured requirements, mirror
      // that gate; otherwise fall back to "every post reacted". Either way
      // the button is the source of truth — auto-advance still fires too,
      // but if it doesn't, the user has a manual escape hatch.
      const parts = S.session?.parts || [];
      const partCfg = parts[S.currentPartIdx ?? 0];
      const reqStatus = partCfg ? evalPartRequirements(partCfg) : { reqs: [], allMet: true };
      const canAdvance = reqStatus.reqs.length
        ? reqStatus.allMet
        : (reacted >= total && total > 0);
      partBtn.disabled = !canAdvance;
      // Final-part label tweak — clearer signal when "Dalej" actually
      // means "Zakończ badanie".
      const parts2 = getOrderedParts();
      const isLastPart = (S.currentPartIdx ?? 0) >= parts2.length - 1;
      // t() returns the key path on miss, which is TRUTHY, so the legacy
      // `t(key) || fallback` pattern doesn't actually fall back — we'd
      // render the literal "actions.next" string. Use only keys that
      // exist in every locale file: misc.next + feed.btn_end_feed.
      partBtn.textContent = isLastPart ? t('feed.btn_end_feed') : t('misc.next');
    }
  }
  // Update progress label using locale template if available
  const progLabel = $('feed-progress-label');
  if (progLabel?.dataset.template) {
    progLabel.innerHTML = progLabel.dataset.template
      .replace('{{reacted}}', `<span id="reacted-count">${reacted}</span>`)
      .replace('{{total}}', `<span id="total-count">${total}</span>`);
  } else {
    const rc = $('reacted-count');
    if (rc) rc.textContent = reacted;
  }
}

// Wire the manual "Dalej →" feed button once at load — clicking calls
// completePart, which either moves to the next part or finishes the
// session. Idempotent (.disabled gate handles bouncing).
(function wireBtnFeedNextPart() {
  const btn = document.getElementById('btn-feed-next-part');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;  // debounce — completePart may navigate
    completePart();
  });
})();

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
          const delta = Date.now() - S.dwellStart[postId];
          S.dwellAccum[postId] = (S.dwellAccum[postId] || 0) + delta;
          delete S.dwellStart[postId];
          // Stream the segment to post_views so we record viewing time
          // even if the participant never reacts. Server accumulates per
          // (session, post). The reactions row (if any) remains canonical
          // for posts that ARE reacted to — export merge handles fallback.
          flushPostViewDwell(postId, postOrder, delta);
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
  if (TOPIC_PILL_DISABLED) {
    pill.style.display = 'none';
  } else {
    pill.style.display = '';
    pill.textContent = `${post.emoji} ${topicLabel(post.topic)}`;
    pill.className = `topic-pill ${topicClass(post.topic)}`;
  }

  $('rating-headline').textContent = post.headline;
  $('rating-content').textContent = formatPostText(post.content);

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
  // Update button label: last post → "finish", otherwise → "next"
  const isLastRating = (S.ratingIndex + 1) >= S.posts.length;
  nextBtn.textContent = isLastRating ? t('rating.btn_finish') : t('rating.btn_next');
  document.querySelectorAll('#likert-buttons .likert-btn').forEach(b => b.classList.remove('selected'));

  // Update rating hint
  const ratingHintEl = $('rating-hint');
  if (ratingHintEl) ratingHintEl.textContent = t('rating.hint_select');

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
  // Always reset question-screen state when (re-)rendering a post
  S.showingQuestions = false;
  const nextBtnEl = $('btn-paged-next');
  if (nextBtnEl && nextBtnEl.textContent.trim() === '✓') {
    // Restore "Dalej →" after the temporary ✓ check-mark used during
    // post-question submission. The previous t('actions.next') key didn't
    // exist in any locale and resolved to the literal "actions.next" string
    // (t() returns the key path on miss → truthy → `|| 'Dalej →'` never
    // fired). Use the canonical misc.next key instead.
    nextBtnEl.textContent = t('misc.next');
  }
  const post = S.posts[S.pagedIndex];
  const study = S.session.study;
  const total = S.posts.length;
  const isHighMetric = (() => {
    const mc = S.session.metric_condition;
    if (!mc || mc === 'BUILDER') return false;
    // Legacy: 'HIGH' = high metrics; builder: check against study's high threshold
    if (mc === 'HIGH') return true;
    if (mc === 'LOW') return false;
    // For custom condition names, treat as high if min > 100 (arbitrary threshold)
    const cond = S.session.posts?.[0]?.metric_min != null
      ? { min: S.session.posts[0].metric_min }
      : null;
    return cond ? cond.min > 100 : false;
  })();
  const metricClass = isHighMetric ? 'high' : 'low';

  // Progress
  $('paged-current').textContent = S.pagedIndex + 1;
  $('paged-total').textContent = total;
  $('paged-fill').style.width = `${(S.pagedIndex / total) * 100}%`;

  // Header
  const pagedAv = $('paged-avatar');
  // Two-level avatar visibility: per-post (post.show_avatar=false) wins over
  // study-level (study.show_avatars=false). Both default to true. Hiding the
  // element via display:none keeps the layout's gap/spacing consistent —
  // emptying innerHTML alone would leave an empty circle taking up space.
  const hideAvatar = post.show_avatar === false || S.session?.study?.show_avatars === false;
  if (hideAvatar) {
    pagedAv.style.display = 'none';
  } else {
    pagedAv.style.display = '';
    if (post.avatar_url) {
      pagedAv.innerHTML = `<img src="${esc(post.avatar_url)}" alt="${esc(post.source_name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      pagedAv.innerHTML = avatarInitials(post.source_name);
    }
  }
  // Source + handle/time line — hide each element when empty, and the whole
  // meta block when both are blank, so an image-only post doesn't show a
  // lone " · " separator. Matches the feed-card logic (see metaLine).
  const _pagedSource = (post.source_name || '').trim();
  const _pagedMeta   = metaLine(post.source_handle, post.time_ago);
  const srcEl = $('paged-source');
  srcEl.textContent = _pagedSource;
  srcEl.style.display = _pagedSource ? '' : 'none';
  const handleEl = $('paged-handle');
  handleEl.textContent = _pagedMeta;
  handleEl.style.display = _pagedMeta ? '' : 'none';
  const metaEl = $('paged-meta');
  if (metaEl) metaEl.style.display = (_pagedSource || _pagedMeta) ? '' : 'none';

  // Topic pill
  const pill = $('paged-topic-pill');
  const pillHidden = TOPIC_PILL_DISABLED || study.hide_topic_badges || post.hide_topic;
  if (pillHidden) {
    pill.style.display = 'none';
  } else {
    pill.style.display = '';
    pill.textContent = `${post.emoji} ${topicLabel(post.topic)}`;
    pill.className = `topic-pill ${topicClass(post.topic)}`;
  }

  // Collapse the entire header row when nothing remains (no avatar, no source,
  // no handle/time, no topic pill) — start the card straight from the content.
  const headerEl = $('paged-header');
  if (headerEl) {
    const anyHeader = !hideAvatar || _pagedSource || _pagedMeta || !pillHidden;
    headerEl.style.display = anyHeader ? '' : 'none';
  }

  // Content
  $('paged-headline').textContent = post.headline;
  $('paged-content').textContent = formatPostText(post.content);

  // Image
  const imgWrap = $('paged-image-wrap');
  if (post.image_url) {
    $('paged-image').src = post.image_url;
    $('paged-image').onerror = () => { imgWrap.style.display = 'none'; };
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
      <span class="metric ${metricClass}" data-metric="like">👍 ${formatNum(post.likes_shown)}</span>
      <span class="metric ${metricClass}" data-metric="dislike">👎 ${formatNum(post.dislikes_shown)}</span>
      <span class="metric ${metricClass}" data-metric="share">🔄 ${formatNum(post.shares_shown)}</span>
      <span class="metric ${metricClass}" data-metric="flag">🚩 ${formatNum(post.flags_shown)}</span>
      ${(post.builder_comments||[]).length ? `<span class="metric ${metricClass}">💬 ${formatNum((post.builder_comments||[]).length)}</span>` : ''}
    `;
  } else {
    metricsEl.style.display = 'none';
    metricsEl.innerHTML = '';
  }

  // Builder comments
  let pagedCommentsEl = $('paged-post-comments');
  if (!pagedCommentsEl) {
    pagedCommentsEl = document.createElement('div');
    pagedCommentsEl.id = 'paged-post-comments';
    pagedCommentsEl.className = 'post-comments-list';
    metricsEl.insertAdjacentElement('afterend', pagedCommentsEl);
  }
  const builderComments = post.builder_comments || [];
  if (builderComments.length) {
    pagedCommentsEl.style.display = '';
    pagedCommentsEl.innerHTML = builderComments.map(c => `
      <div class="post-comment-item">
        <div class="post-comment-avatar">${esc((c.author||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2))}</div>
        <div class="post-comment-body">
          <span class="post-comment-author">${esc(c.author||'')}</span>
          <span class="post-comment-text">${esc(c.text||'')}</span>
          ${c.likes ? `<span class="post-comment-likes">👍 ${formatNum(c.likes)}</span>` : ''}
        </div>
      </div>`).join('');
  } else {
    pagedCommentsEl.style.display = 'none';
    pagedCommentsEl.innerHTML = '';
  }

  // Reactions row — per-part show_reactions wins over study-level
  const actionsEl = $('paged-actions');
  const partCfgReactions = getPartConfig(post);
  const partShowReactionsPaged = partCfgReactions?.show_reactions !== false && partCfgReactions?.show_reactions !== 0;
  actionsEl.style.display = (study.show_reactions && partShowReactionsPaged) ? '' : 'none';
  // Per-post button visibility — hide individual action buttons that the
  // researcher disabled for this specific post. Combined with the row-level
  // hide above: row hidden → all buttons hidden; row visible → each button
  // visible iff post.show_<action> !== false.
  actionsEl.querySelectorAll('.action-btn').forEach(btn => {
    const action = btn.dataset.action;
    const perPostShow = post[`show_${action}`];
    btn.style.display = (perPostShow === false) ? 'none' : '';
  });
  actionsEl.querySelectorAll('.action-btn').forEach(b => b.className = 'action-btn');
  // Re-paint every currently-active reaction. In legacy single mode this is
  // 0–1 entries; in multi mode it can be several (like+share+flag).
  reactionsOfPaged(post.id).forEach(act => {
    actionsEl.querySelector(`[data-action="${act}"]`)?.classList.add(`active-${act}`);
  });
  // UI-only: if the participant already reacted to this post (e.g. they used
  // the back button to return), reflect their +1 in the visible count too —
  // otherwise the number would snap back to the base and look like the click
  // was lost.
  refreshShownMetrics($('paged-metrics'), post, reactionsOfPaged(post.id));

  // Likert credibility scale — legacy only; hidden for builder studies
  const isBuilder = S.config?.builder_mode === 1;
  const ratingSection = document.querySelector('.paged-rating-section');
  if (ratingSection) ratingSection.style.display = isBuilder ? 'none' : '';

  const nextBtn = $('btn-paged-next');
  const backBtn = $('btn-paged-back');
  if (isBuilder) {
    const partCfg = getPartConfig(post);
    const pqMode = partCfg.pq_display_mode || 'after_interaction';
    const requireInteraction = partCfg.require_interaction === true || partCfg.require_interaction === 1;
    const allowBack = partCfg.allow_back !== false && partCfg.allow_back !== 0; // default true
    const hasPostQ = getPostQuestionsForPost(post).length > 0;
    const alreadySubmitted = S.pagedQSubmitted?.[post.id];
    // Multi-react safe: empty array is still truthy in JS, so we must check
    // length rather than relying on `!!`. Single-mode (string) length 1+
    // also returns truthy via this path.
    const alreadyReacted = reactionsOfPaged(post.id).length > 0;

    // Restore paged-card visibility (may have been hidden in after_post mode)
    const pagedCard = document.querySelector('.paged-card');
    if (pagedCard) pagedCard.style.display = '';

    // Back button visibility
    backBtn.style.display = allowBack ? '' : 'none';
    if (allowBack) backBtn.disabled = S.pagedIndex === 0;

    // Clear question container
    const pqContainer = $('paged-post-questions');

    if (pqMode === 'with_post' && hasPostQ && !alreadySubmitted) {
      showPostQuestionsPaged(post); // shown immediately → sets nextBtn.disabled = true
    } else {
      if (pqContainer) { pqContainer.innerHTML = ''; pqContainer.style.display = 'none'; }
      // Next button: structured requirements (Phase 3) take precedence over
      // legacy require_interaction. If part has requirements → button enabled
      // only when allMet. If no requirements → fall back to require_interaction.
      const reqStatus = evalPartRequirements(partCfg);
      if (reqStatus.reqs.length) {
        nextBtn.disabled = !reqStatus.allMet;
      } else {
        nextBtn.disabled = requireInteraction && !alreadyReacted && !alreadySubmitted;
      }
    }
    // Re-render the part checklist (Phase 3) on every renderPagedPost call so
    // counts stay fresh when researcher navigates back/forward. No-op if part
    // has no structured requirements.
    renderPartChecklist(partCfg);
  } else {
    // Legacy: next requires Likert selection
    nextBtn.disabled = true;
    document.querySelectorAll('#paged-likert-buttons .likert-btn').forEach(b => b.classList.remove('selected'));
    const prevRating = S.pagedRatings[post.id];
    if (prevRating) {
      document.querySelector(`#paged-likert-buttons .likert-btn[data-value="${prevRating}"]`)?.classList.add('selected');
      nextBtn.disabled = false;
    }
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

  // Participant comment textarea (custom layout). Combined gate:
  // study.enable_comments must be on AND the per-post toggle must allow it.
  // post.show_comment defaults to true on the wire — researcher has to
  // explicitly uncheck it in the post editor to suppress comment on a single
  // post even when study-level comments are enabled.
  const commentWrap  = $('paged-participant-comment-wrap');
  const commentInput = $('paged-participant-comment');
  const postAllowsComment = post.show_comment !== false;
  // Part-level interactions gate: if the part has show_reactions=false the
  // whole post is read-only (no reactions, no comment). Without this gate
  // a part marked "no interaction" would still render the comment textarea.
  const partCfgComment = getPartConfig(post);
  const partAllowsInteractions = partCfgComment.show_reactions !== false;
  if (commentWrap) {
    if (partAllowsInteractions && study.enable_comments && postAllowsComment) {
      commentWrap.style.display = '';
      if (commentInput) {
        commentInput.placeholder = study.comment_placeholder || t('actions.comment_placeholder');
        commentInput.value = S.pagedComments[post.id] || '';
        // Live-track comment text so the Phase 3 checklist updates as the
        // participant types. Dedupe listener attachment via a flag so
        // multiple renderPagedPost calls don't stack handlers.
        if (!commentInput._pq3Wired) {
          commentInput._pq3Wired = true;
          commentInput.addEventListener('input', () => {
            const currentPost = S.posts[S.pagedIndex];
            const id = currentPost?.id;
            if (id != null) S.pagedComments[id] = commentInput.value || '';
            refreshPartChecklistForCurrent();
            // Persist via /api/reaction (action='comment') so the comment
            // shows in Excel even when the paged-response (Dalej) path
            // never sends one. Paged-response would normally batch it,
            // but multi-react mode disables that branch, and either way
            // a participant who navigates back/forward might not trigger
            // Dalej for THIS post before session-end.
            if (currentPost) scheduleCommentSave(currentPost, commentInput.value || '');
          });
        }
      }
    } else {
      commentWrap.style.display = 'none';
    }
  }

  // Navigation — back button handled per-mode above (builder) or below (legacy)
  if (!isBuilder) $('btn-paged-back').disabled = S.pagedIndex === 0;

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
    const action = btn.dataset.action;
    if (isMultiReactMode()) {
      // Multi mode — stack non-opposing reactions; like/dislike mutex;
      // re-click toggles off.
      const before = reactionsOfPaged(post.id);
      const { next, removed } = applyMultiReactClick(before, action);
      S.pagedReactions[post.id] = next;
      // Re-paint highlights from the new state.
      $('paged-actions').querySelectorAll('.action-btn').forEach(b => { b.className = 'action-btn'; });
      next.forEach(act => {
        const b2 = $('paged-actions').querySelector(`.action-btn[data-action="${act}"]`);
        if (b2) b2.classList.add(`active-${act}`);
      });
      // Multi-react paged: send each click immediately (the legacy
      // batched-on-Dalej flow only captures the LAST action, which loses
      // the toggle history in multi mode). Single mode keeps the batched
      // path so we don't double-write for existing studies.
      apiPost('/api/reaction', {
        session_token: S.session.session_token,
        post_id: post.id,
        post_order: post.post_order,
        action,
        likes_shown: post.likes_shown,
        shares_shown: post.shares_shown,
        dislikes_shown: post.dislikes_shown,
        flags_shown: post.flags_shown,
        is_undo: removed ? 1 : 0,
      }).catch(() => {});
    } else {
      // Single (legacy) mode — replace.
      $('paged-actions').querySelectorAll('.action-btn').forEach(b => b.className = 'action-btn');
      btn.classList.add(`active-${action}`);
      S.pagedReactions[post.id] = action;
    }
    // UI-only: bump/decrement the visible counter (see refreshShownMetrics).
    // Scoped to the paged metrics container — the data-metric spans live
    // inside #paged-metrics, not on $('paged-actions').
    refreshShownMetrics($('paged-metrics'), post, reactionsOfPaged(post.id));
    // Refresh structured-requirements checklist + Dalej gate live (Phase 3).
    refreshPartChecklistForCurrent();
    // Conditional logic on this reaction (after_interaction). May end the study.
    if (applyLogic('after_interaction')) return;
    const partCfg = getPartConfig(post);
    const pqMode = partCfg.pq_display_mode || 'after_interaction';
    const requireInteraction = partCfg.require_interaction === true || partCfg.require_interaction === 1;
    // Interaction recorded — if require_interaction, now enable next btn (for after_post) or show questions
    if (pqMode === 'after_interaction') {
      if (getPostQuestionsForPost(post).length > 0) {
        showPostQuestionsPaged(post); // inline — disables Dalej until answered
      } else if (requireInteraction) {
        $('btn-paged-next').disabled = false;
      }
    } else if (pqMode === 'after_interaction_modal') {
      if (getPostQuestionsForPost(post).length > 0) {
        showPostQuestionsModal(post); // popup over the post card
        // Dalej stays disabled until the modal's own submit button fires;
        // submitPostQuestionsInline detects the modal context and enables it.
        $('btn-paged-next').disabled = true;
      } else if (requireInteraction) {
        $('btn-paged-next').disabled = false;
      }
    } else if (requireInteraction) {
      // after_post / with_post / after_all_posts: reaction satisfies requirement → enable nextBtn
      $('btn-paged-next').disabled = false;
    }
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
  if (S.showingQuestions) {
    // Restore the post view without changing the index
    S.showingQuestions = false;
    const pagedCard = document.querySelector('.paged-card');
    if (pagedCard) pagedCard.style.display = '';
    const container = $('paged-post-questions');
    if (container) { container.innerHTML = ''; container.style.display = 'none'; }
    renderPagedPost();
    return;
  }
  if (S.pagedIndex === 0) return;
  S.pagedIndex--;
  renderPagedPost();
};

// ── Reliable answer saving (no silent data loss) ────────────────────────────
// Post-question answers used to be fired as fire-and-forget with .catch(()=>{})
// and the flow advanced regardless — a network blip silently dropped a REQUIRED
// answer while the participant saw a checkmark and moved on. These helpers retry
// with backoff and BLOCK advancing until every answer is confirmed saved.
async function postWithRetry(path, body, attempts = 3, baseDelay = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await apiPost(path, body); }
    catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i))); }
  }
  throw lastErr;
}

function ensureSavingOverlay() {
  let ov = document.getElementById('pq-saving-overlay');
  if (!ov) {
    if (!document.getElementById('pq-spin-kf')) {
      const st = document.createElement('style'); st.id = 'pq-spin-kf';
      st.textContent = '@keyframes pqspin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    ov = document.createElement('div');
    ov.id = 'pq-saving-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:30000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.4)';
    ov.innerHTML = '<div style="background:var(--surface,#fff);color:var(--text,#222);padding:22px 26px;border-radius:12px;max-width:340px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,0.25)">'
      + '<div id="pq-saving-spin" style="width:22px;height:22px;margin:0 auto 12px;border:2px solid var(--border,#ccc);border-top-color:var(--accent,#4f46e5);border-radius:50%;animation:pqspin 0.8s linear infinite"></div>'
      + '<div id="pq-saving-text" style="font-size:0.95rem;line-height:1.5"></div>'
      + '<button type="button" id="pq-saving-retry" class="btn btn-primary" style="display:none;margin-top:14px">Spróbuj ponownie</button>'
      + '</div>';
    document.body.appendChild(ov);
  }
  return ov;
}
function showSavingSpinner(text) {
  const ov = ensureSavingOverlay();
  ov.querySelector('#pq-saving-text').textContent = text;
  ov.querySelector('#pq-saving-spin').style.display = 'block';
  ov.querySelector('#pq-saving-retry').style.display = 'none';
  ov.style.display = 'flex';
}
function hideSavingOverlay() { const ov = document.getElementById('pq-saving-overlay'); if (ov) ov.style.display = 'none'; }
// Blocking error state with a manual retry — the participant CANNOT proceed
// until answers are saved (better a stuck retry than lost required data).
function showSaveError(text, retryLabel) {
  return new Promise(resolve => {
    const ov = ensureSavingOverlay();
    ov.querySelector('#pq-saving-text').textContent = text;
    ov.querySelector('#pq-saving-spin').style.display = 'none';
    const btn = ov.querySelector('#pq-saving-retry');
    btn.textContent = retryLabel;
    btn.style.display = 'inline-block';
    ov.style.display = 'flex';
    btn.onclick = () => { btn.onclick = null; resolve(); };
  });
}
// Persist a list of {path, body} specs, retrying until all succeed. Blocks with
// an overlay; only returns (resolves) once every answer is confirmed saved.
async function persistAnswers(specs) {
  if (!specs.length) return;
  const savingText = t('errors.saving');
  const failText   = t('errors.post_question_save');
  const retryText  = t('errors.retry');
  // Fallbacks if a locale is missing the keys (t returns the key path).
  const s = savingText === 'errors.saving' ? 'Zapisywanie odpowiedzi…' : savingText;
  const f = failText === 'errors.post_question_save' ? 'Nie udało się zapisać odpowiedzi. Sprawdź połączenie z internetem i spróbuj ponownie.' : failText;
  const r = retryText === 'errors.retry' ? 'Spróbuj ponownie' : retryText;
  while (true) {
    showSavingSpinner(s);
    const results = await Promise.allSettled(specs.map(x => postWithRetry(x.path, x.body)));
    if (!results.some(res => res.status === 'rejected')) { hideSavingOverlay(); return; }
    await showSaveError(f, r); // resolves when participant clicks retry → loop
  }
}

// Submit paged post questions without needing a button reference (used by pagedAdvance)
async function submitPagedQuestions(postId, postOrder) {
  const container = $('paged-post-questions');
  const block = container?.querySelector('.post-questions-block');
  if (!block) { S.showingQuestions = false; pagedAdvance(); return; }

  // Detect part-scoped submission (after_all_posts mode). The questions
  // screen appeared once at the end of the part rather than per-post — we
  // shouldn't link responses to that specific last post because semantically
  // the answers cover the whole part. Send `part_id` so the row in
  // post_question_responses gets the part anchor + post_id=0 sentinel.
  //
  // Fallback to the resolved part config's id when the post itself doesn't
  // carry part_id — posts created before part_id was added (or never
  // explicitly assigned) end up resolved to parts[0] by getPartConfig, and
  // we want the response anchored to that same logical part. Without this
  // fallback, after_all_posts responses on legacy posts get stored with
  // part_id=null and silently fall back into per-post slots in the export.
  const currentPost = S.posts[S.pagedIndex];
  const isPartLevel = currentPost && getPartDisplayMode(currentPost) === 'after_all_posts';
  const resolvedPartCfg = currentPost && getPartConfig(currentPost);
  const partIdForResponse = isPartLevel
    ? (currentPost.part_id || resolvedPartCfg?.id || null)
    : null;

  const qEls = block.querySelectorAll('.pq-q');
  let allValid = true;
  const saves = [];

  qEls.forEach(qEl => {
    qEl.style.outline = '';
    const qid = Number(qEl.dataset.qid);
    const type = qEl.dataset.type;
    const q = S.postQuestions.find(x => x.id == qid);
    let responseText = null, responseValues = [];
    if (type === 'open') {
      responseText = qEl.querySelector('.pq-response')?.value?.trim() || '';
      if (q?.required && !responseText) allValid = false;
    } else if (type === 'likert') {
      responseText = qEl.querySelector('.likert-btn.selected')?.dataset.value || '';
      if (q?.required && !responseText) allValid = false;
    } else if (type === 'single') {
      responseText = qEl.querySelector('input:checked')?.value || '';
      if (q?.required && !responseText) allValid = false;
    } else {
      responseValues = Array.from(qEl.querySelectorAll('input:checked')).map(c => c.value);
      if (q?.required && !responseValues.length) allValid = false;
    }
    if (responseText || responseValues.length) {
      captureLogicAnswer(qid, responseText || responseValues); // feed the logic context
      saves.push({ path: '/api/post-question-response', body: {
        session_token: S.session.session_token,
        // For part-scoped responses we explicitly pass part_id; the server
        // overrides post_id to 0 and stores the part anchor.
        post_id: isPartLevel ? 0 : postId,
        post_order: isPartLevel ? null : postOrder,
        part_id: partIdForResponse,
        question_id: qid,
        response_text: responseText || null,
        response_values: responseValues,
      } });
    }
  });

  if (!allValid) {
    qEls.forEach(qEl => {
      const q = S.postQuestions.find(x => x.id == qEl.dataset.qid);
      if (!q?.required) return;
      const type = qEl.dataset.type;
      const answered = type === 'open'
        ? !!qEl.querySelector('.pq-response')?.value?.trim()
        : type === 'likert'
          ? !!qEl.querySelector('.likert-btn.selected')
          : !!qEl.querySelector('input:checked');
      if (!answered) {
        qEl.style.outline = '2px solid var(--danger, #ef4444)';
        qEl.style.borderRadius = '6px';
        qEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    return;
  }

  $('btn-paged-next').disabled = true;
  await persistAnswers(saves); // blocks (with retry) until every answer is saved
  S.pagedQSubmitted[postId] = true;
  S.showingQuestions = false;
  setTimeout(() => pagedAdvance(), 300);
}

// Shared advance logic — called by btn-paged-next and by post-question submit in paged builder
async function pagedAdvance() {
  // If we're on the questions screen, submit questions instead of advancing
  if (S.showingQuestions) {
    const post = S.posts[S.pagedIndex];
    await submitPagedQuestions(post.id, post.post_order);
    return;
  }

  const post = S.posts[S.pagedIndex];

  // after_post mode: intercept Dalej → show questions before advancing
  const pqAdvMode = getPartDisplayMode(post);
  const hasAdvPostQ = getPostQuestionsForPost(post).length > 0;
  const advAlreadySubmitted = S.pagedQSubmitted?.[post.id];
  if (pqAdvMode === 'after_post' && hasAdvPostQ && !advAlreadySubmitted) {
    showPostQuestionsAfterPost(post);
    return;
  }
  // after_all_posts mode: questions appear ONCE at the end of the part, not
  // per-post. We detect "last post of this part" by peeking at the next post
  // in S.posts — if it's missing (end of sequence) or belongs to a different
  // part, the current post is the part's terminal one and we trigger the
  // questions screen here. Responses get stored with part_id (not post_id)
  // so the export never falsely attributes part-level answers to one post.
  if (pqAdvMode === 'after_all_posts' && hasAdvPostQ && !advAlreadySubmitted) {
    // S.posts is already sliced to the CURRENT part's posts by startPart →
    // getPostsForPart, so "next index out of range" alone signals end-of-part.
    // The old `nextPost.part_id !== post.part_id` check was a leftover from
    // pre-per-part slicing AND broke multi-part posts (their part_id refers
    // to the primary part, not the current one — see getPartConfig).
    const isLastInPart = (S.pagedIndex + 1) >= S.posts.length;
    if (isLastInPart) {
      showPostQuestionsAfterPost(post);
      return;
    }
  }

  const rating = S.pagedRatings[post.id];
  const isBuilder = S.config?.builder_mode === 1;
  if (!isBuilder && !rating) return;  // legacy requires rating; builder doesn't

  const dwellMs = S.pagedDwellStart[post.id] ? Date.now() - S.pagedDwellStart[post.id] : 0;
  const study = S.session.study;

  const payload = {
    session_token: S.session.session_token,
    post_id: post.id,
    post_order: post.post_order,
    belief_1_7: rating,
  };

  // Single-react mode batches the reaction into the paged-response payload
  // (one row per post on Dalej). Multi-react mode already streamed every
  // click via /api/reaction in the button handler, so we deliberately omit
  // payload.action here — sending an array would mismatch the server's
  // single-action schema, and re-sending the LAST clicked action would
  // overwrite the carefully-tracked multi-state.
  const pagedReacted = reactionsOfPaged(post.id);
  if (study.show_reactions && pagedReacted.length && !isMultiReactMode()) {
    payload.action = pagedReacted[0];
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

  // Record post-view dwell regardless of whether the participant reacted.
  // The reactions row is the canonical source when present (and carries
  // its own dwell_ms via paged-response above), but post_views still gets
  // the segment so a researcher querying "viewing time per post" gets a
  // complete picture even on participants who never reacted. Export
  // merge prefers reactions.dwell_ms and falls back to post_views.
  if (dwellMs > 0) {
    flushPostViewDwell(post.id, post.post_order, dwellMs);
    delete S.pagedDwellStart[post.id];  // mark this segment as flushed
  }

  S.pagedIndex++;
  $('paged-fill').style.width = `${(S.pagedIndex / S.posts.length) * 100}%`;

  if (S.pagedIndex >= S.posts.length) {
    // Per-part flow: hand off to completePart so a multi-part paged study
    // moves to the next part (with its own layout) instead of jumping
    // straight to the debrief. completePart calls completeSession itself
    // when this was the last part.
    await completePart();
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
}

$('btn-paged-next').onclick = () => pagedAdvance();

// ── Screen 8: Debrief ─────────────────────────────────────────────────────
async function completeSession() {
  // Clear any active per-part timer — the session is ending, no more
  // auto-advance should fire. Safe to call even when no timer is running.
  clearPartTimer();
  // If demographics is deferred to the end of the study and the participant
  // hasn't filled it out yet, intercept here and show the screen. The
  // demographics submit handler will call back into completeSession() once
  // the responses are saved (S.demographicsSubmitted=true makes us skip
  // this branch on the second pass so we don't loop).
  if (!S.demographicsSubmitted && getDemographicsPosition() === 'before_debrief') {
    showDemographicsScreen();
    return;
  }
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
    // Panel-recruitment endlink — bounce the participant back to the
    // agency's completion URL so the panel can credit them. Placeholders:
    //   {ext_id}      — the URL query value captured at session start
    //   {session_id}  — our internal session_token (for cross-reference)
    // No endlink configured → nothing changes; participant sees the
    // standard end screen and closes the tab themselves.
    maybeRedirectToEndlink();
  } catch (e) {
    showError(t('errors.session_complete_failed') + ': ' + e.message);
  }
}

// Resolves the per-study endlink (if set), substitutes placeholders,
// renders a "you'll be redirected" notice on the visible end screen, and
// navigates after a short delay so the participant has a moment to see
// the confirmation. Failure modes (no endlink, missing placeholders,
// malformed URL) all degrade to "no redirect" without throwing — the
// participant just stays on the debrief/complete screen as if no
// endlink were configured.
// Shared endlink runner — used for both completion (debrief screen) and
// decline (no-consent screen). Reads the configured URL/delay/notice
// (different field names per flow), substitutes placeholders, optionally
// renders a sticky notice + manual button, and fires the redirect after
// the configured delay. Pure no-op when no URL is configured for the
// given flow, so studies without panel-recruitment are unchanged.
//
// `flow` is one of:
//   'completion' — fires after /api/session/complete, hosts on debrief / complete screens
//   'decline'    — fires after consent decline, hosts on no-consent screen
function runEndlinkRedirect(flow, opts = {}) {
  try {
    const study = S.session && S.session.study;
    if (!study) return;
    const prefix = flow === 'decline' ? 'decline_' : 'completion_';
    const raw    = study[prefix + 'redirect_url'];
    if (!raw || typeof raw !== 'string') return;
    const url = raw
      .replace(/\{ext_id\}/g,     encodeURIComponent(S.session.external_id || ''))
      .replace(/\{session_id\}/g, encodeURIComponent(S.session.session_token || ''));
    // Defensive: only allow http(s) URLs so a misconfigured value can't
    // pivot the participant into a javascript:/data: navigation.
    if (!/^https?:\/\//i.test(url)) return;

    // Delay is per-study configurable. Server clamps to [0, 600]; we
    // re-clamp here as a defensive belt-and-suspenders. 0 = navigate
    // immediately (panel wants full control of post-flow UX).
    const delayMs = Math.max(0, Math.min(600, Number(study[prefix + 'redirect_delay_seconds'] ?? 4))) * 1000;
    const noticeText = study[prefix + 'redirect_notice'];

    // Host selector differs per flow. Completion uses debrief / complete
    // screens; decline uses the no-consent screen. Both have a `.card`
    // ancestor that anchors the sticky box.
    const hostSelector = flow === 'decline'
      ? '#screen-no-consent.active .card'
      : '#screen-debrief.active .debrief-card, #screen-complete.active .card';
    const cardHost = document.querySelector(hostSelector);
    // Unique IDs per flow so completion and decline don't ever collide
    // (they shouldn't render simultaneously but the guard is cheap).
    const stickyId = 'endlink-sticky-' + flow;
    const noticeId = 'endlink-notice-' + flow;

    if (cardHost && noticeText) {
      // Sticky banner at the top of the host card — hosts custom notice
      // + manual "Wróć do panelu" button that bypasses the timer.
      let sticky = document.getElementById(stickyId);
      if (!sticky) {
        sticky = document.createElement('div');
        sticky.id = stickyId;
        sticky.style.cssText = [
          'position:sticky', 'top:0', 'z-index:20',
          'margin:-1rem -1rem 1rem -1rem',
          'padding:14px 18px',
          'background:var(--surface,#fff)',
          'border-bottom:1px solid var(--border,#e5e5ea)',
          'box-shadow:0 2px 8px rgba(0,0,0,0.04)',
          'display:flex', 'flex-direction:column', 'gap:10px',
          'align-items:stretch',
        ].join(';');
        cardHost.insertBefore(sticky, cardHost.firstChild);
      }
      sticky.innerHTML = '';
      const txt = document.createElement('div');
      txt.style.cssText = 'font-size:0.92rem;line-height:1.5;color:var(--text,#222)';
      txt.textContent = noticeText;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary';
      btn.style.cssText = 'align-self:flex-start;padding:8px 16px;font-size:0.9rem';
      // Locale-driven so SK/CZ clones show the translated label (editable in
      // the admin "Tłumaczenia platformy" modal). Falls back to PL via the
      // locale file when no override exists.
      btn.textContent = t('debrief.btn_back_to_panel');
      btn.addEventListener('click', () => { window.location.href = url; }, { once: true });
      sticky.appendChild(txt);
      sticky.appendChild(btn);
    } else if (cardHost) {
      // Default fallback notice — small inline confirmation at the bottom
      // of the host card. Matches the previous behaviour exactly so
      // existing studies without a custom notice are unaffected.
      let notice = document.getElementById(noticeId);
      if (!notice) {
        notice = document.createElement('div');
        notice.id = noticeId;
        notice.style.cssText = 'margin-top:16px;padding:12px;background:var(--surface-alt,#f5f5f7);border-radius:8px;font-size:0.95rem;color:var(--muted,#555);text-align:center';
        cardHost.appendChild(notice);
      }
      notice.textContent = delayMs > 0
        ? 'Za chwilę zostaniesz przekierowany z powrotem do panelu badawczego…'
        : 'Przekierowuję z powrotem do panelu badawczego…';
    }

    // QA preview (?focus=debrief): render the sticky box so the researcher can
    // see exactly what the participant gets, but DON'T fire the auto-redirect —
    // otherwise the preview would yank them off to the agency after the delay.
    // The manual "Wróć do panelu →" button still works for testing the URL.
    if (opts.noAutoRedirect) return;

    setTimeout(() => { window.location.href = url; }, delayMs);
  } catch (_) { /* never break the end screen on a misconfigured endlink */ }
}

// Backwards-compatible wrapper for the completion flow (kept so other
// call sites continue to work without churn). The decline flow has its
// own direct caller from the consent-decline handler.
function maybeRedirectToEndlink() { runEndlinkRedirect('completion'); }

function renderDebrief(data) {
  $('debrief-text-content').textContent = ts('debrief_text') || data.debrief_text;

  // "Posts — true and false" section can be hidden per-study via the
  // admin's `show_debrief_posts` toggle. We hide the WHOLE section
  // (header + description + list) so the debrief doesn't leave an
  // orphaned heading. Find the closest .debrief-section ancestor of
  // the list so we toggle the right wrapper.
  const list = $('debrief-posts-list');
  const showPosts = S.session?.study?.show_debrief_posts !== false;
  const sectionEl = list?.closest('.debrief-section');
  if (sectionEl) sectionEl.style.display = showPosts ? '' : 'none';
  list.innerHTML = '';
  if (showPosts) {
    S.posts.forEach(post => {
      const div = document.createElement('div');
      div.className = 'debrief-post-item';
      // Headline may be empty for image-only posts (the screenshot IS the
      // stimulus). Render the headline only when present, and always show
      // the post image thumbnail when the post has one — otherwise an
      // image-only post would appear blank in the debrief list.
      const headlineHTML = post.headline
        ? `<div class="debrief-post-headline">${esc(formatPostText(post.headline))}</div>`
        : '';
      const imageHTML = post.image_url
        ? `<img class="debrief-post-image" src="${esc(post.image_url)}" alt="" loading="lazy">`
        : '';
      const hideTopic = TOPIC_PILL_DISABLED || S.session?.study?.hide_topic_badges || post.hide_topic;
      const topicHTML = hideTopic
        ? ''
        : `<span class="topic-pill ${topicClass(post.topic)}" style="margin-bottom:0.4rem;display:inline-flex">${esc(post.emoji)} ${esc(topicLabel(post.topic))}</span>`;
      div.innerHTML = `
        <span class="debrief-truth-badge ${post.is_true ? 'badge-true' : 'badge-false'}">
          ${post.is_true ? t('debrief.badge_true') : t('debrief.badge_false')}
        </span>
        <div>
          ${topicHTML}
          ${headlineHTML}
          ${imageHTML}
        </div>
      `;
      list.appendChild(div);
    });
  }

  if (data.contact_email) {
    const contactEl = $('debrief-contact');
    const emailEl = $('debrief-email');
    emailEl.textContent = data.contact_email;
    emailEl.href = `mailto:${data.contact_email}`;
    contactEl.style.display = '';
  }
}

// ── Post questions — inline (builder mode) ────────────────────────────────

function buildPostQuestionsHTML(post) {
  // Restrict to questions actually bound to this post's part — otherwise a
  // part-2 question would render under a part-1 post.
  let questionsForPost = getPostQuestionsForPost(post);
  // Conditional logic: drop questions a hide_question rule currently hides.
  const hidden = logicHiddenQuestionSet();
  if (hidden) questionsForPost = questionsForPost.filter(q => !hidden.has(String(q.id)));
  const hasRequired = questionsForPost.some(q => q.required);
  // Title + subtitle come from the current part's config (admin-configurable in builder)
  const partCfg = getPartConfig(post) || {};
  const title    = partCfg.pq_title    || '';
  const subtitle = partCfg.pq_subtitle || '';
  return `<div class="post-questions-block" data-post-id="${post.id}" data-post-order="${post.post_order}">
    <div class="post-questions-inner">
      ${title    ? `<h2 class="pq-screen-title">${esc(title)}</h2>` : ''}
      ${subtitle ? `<p class="pq-screen-subtitle">${esc(subtitle)}</p>` : ''}
      ${questionsForPost.map(q => renderPostQuestion(q, post.id)).join('')}
      <button class="pq-submit-btn btn btn-primary" onclick="submitPostQuestionsInline(this, ${post.id}, ${post.post_order})"
        ${hasRequired ? 'disabled' : ''}>${t('builder.pq_next')}</button>
    </div>
  </div>`;
}

// Check if all required questions in a block are answered; enable/disable the submit button
function pqCheckSubmitReady(block) {
  // In paged mode the submit action is the bottom "Dalej →"; in feed mode it's the inline button
  const btn = S.showingQuestions ? $('btn-paged-next') : block?.querySelector('.pq-submit-btn');
  if (!btn) return;
  const qEls = block.querySelectorAll('.pq-q');
  let allDone = true;
  qEls.forEach(qEl => {
    const qid = qEl.dataset.qid;
    const q = S.postQuestions.find(x => x.id == qid);
    if (!q?.required) return;
    const type = qEl.dataset.type;
    const answered = type === 'open'
      ? !!qEl.querySelector('.pq-response')?.value?.trim()
      : type === 'likert'
        ? !!qEl.querySelector('.likert-btn.selected')
        : !!qEl.querySelector('input:checked');
    if (!answered) allDone = false;
  });
  btn.disabled = !allDone;
}

// Feed layout: inject questions as a block directly below the post card
function showPostQuestionsInline(post, cardEl) {
  // Remove any existing question block for this post first (re-reaction)
  cardEl.parentElement?.querySelectorAll(`.post-questions-block[data-post-id="${post.id}"]`).forEach(el => el.remove());

  const tmp = document.createElement('div');
  tmp.innerHTML = buildPostQuestionsHTML(post);
  const block = tmp.firstElementChild;
  // Wire up live readiness checks
  block.addEventListener('input',  () => pqCheckSubmitReady(block));
  block.addEventListener('change', () => pqCheckSubmitReady(block));
  // Insert after the card element
  cardEl.insertAdjacentElement('afterend', block);
  block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Paged layout: populate the #paged-post-questions container
function showPostQuestionsPaged(post) {
  const container = $('paged-post-questions');
  if (!container) return;
  container.innerHTML = buildPostQuestionsHTML(post);
  container.style.display = '';
  S.showingQuestions = true;
  // Hide the inline submit button — bottom "Dalej →" handles submission
  const inlineBtn = container.querySelector('.pq-submit-btn');
  if (inlineBtn) inlineBtn.style.display = 'none';
  // Enable/disable bottom Dalej based on whether required questions exist
  // (scoped to THIS post's part — see getPostQuestionsForPost).
  const hasRequired = getPostQuestionsForPost(post).some(q => q.required);
  $('btn-paged-next').disabled = hasRequired;
  // Wire up readiness checks for the block inside the container
  const block = container.querySelector('.post-questions-block');
  if (block) {
    block.addEventListener('input',  () => pqCheckSubmitReady(block));
    block.addEventListener('change', () => pqCheckSubmitReady(block));
  }
}

// Paged + modal mode: pop the questions over the post card in a centered
// dialog. The post stays visible underneath (dimmed) so the participant can
// re-read it while answering. Submission uses the modal's own pq-submit-btn
// (NOT the bottom Dalej) — submitPostQuestionsInline detects the .pq-modal
// ancestor and closes the modal + enables Dalej once saves complete.
function showPostQuestionsModal(post) {
  // Build the backdrop once and reuse — keeps DOM lean across N posts.
  let backdrop = document.getElementById('pq-modal-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'pq-modal-backdrop';
    backdrop.className = 'pq-modal-backdrop';
    backdrop.innerHTML = '<div class="pq-modal-card" role="dialog" aria-modal="true"><div class="pq-modal-body" id="pq-modal-body"></div></div>';
    document.body.appendChild(backdrop);
  }
  const body = backdrop.querySelector('#pq-modal-body');
  body.innerHTML = buildPostQuestionsHTML(post);
  // The inline submit button is the canonical way to dismiss the modal.
  // Keep it visible (unlike showPostQuestionsPaged which hides it in favor
  // of the bottom Dalej).
  const block = body.querySelector('.post-questions-block');
  if (block) {
    block.addEventListener('input',  () => pqCheckSubmitReady(block));
    block.addEventListener('change', () => pqCheckSubmitReady(block));
  }
  // Show with a frame delay so the CSS transition runs.
  requestAnimationFrame(() => backdrop.classList.add('open'));
  // Lock body scroll while the modal is open.
  document.body.style.overflow = 'hidden';
}

function showPostQuestionsAfterPost(post) {
  // Hide the post card, show questions full-screen within the paged layout
  const pagedCard = document.querySelector('.paged-card');
  if (pagedCard) pagedCard.style.display = 'none';
  const container = $('paged-post-questions');
  if (!container) return;
  container.innerHTML = buildPostQuestionsHTML(post);
  container.style.display = '';
  container.style.margin = '0';  // full width
  S.showingQuestions = true;
  // Hide the inline submit button — bottom "Dalej →" handles submission
  const inlineBtn = container.querySelector('.pq-submit-btn');
  if (inlineBtn) inlineBtn.style.display = 'none';
  // Enable/disable bottom Dalej based on required questions (this post's part only)
  const hasRequired = getPostQuestionsForPost(post).some(q => q.required);
  $('btn-paged-next').disabled = hasRequired;
  // Back button: allow it so user can return to the post view
  const partCfg = getPartConfig(post);
  const allowBack = partCfg.allow_back !== false && partCfg.allow_back !== 0;
  const backBtn = $('btn-paged-back');
  if (allowBack) { backBtn.style.display = ''; backBtn.disabled = false; }
  const block = container.querySelector('.post-questions-block');
  if (block) {
    block.style.margin = '0';
    block.addEventListener('input',  () => pqCheckSubmitReady(block));
    block.addEventListener('change', () => pqCheckSubmitReady(block));
  }
  window.scrollTo(0, 0);
}

function renderPostQuestion(q, postId) {
  const rawOpts = (() => { try { return JSON.parse(q.options_json || '[]'); } catch { return []; } })();
  const reqMark = q.required ? '<span class="pq-req">*</span>' : '';
  const uid = `pq_${postId}_${q.id}`;

  if (q.question_type === 'likert') {
    const cfg = (rawOpts && !Array.isArray(rawOpts)) ? rawOpts : {};
    const scale = cfg.scale || 7;
    // start_at: opt-in 0-indexed scale. Legacy questions (every row built
    // before this feature) lack the key in options_json → reads as
    // undefined → defaults to 1. The strict `=== 0` check (not falsy) is
    // intentional so a coerced `'0'` string from the JSON round-trip is
    // ignored — only the explicit number 0 the admin save handler emits
    // flips the scale. NEVER toggle this on a question mid-study: stored
    // response values are the literal clicked digits, so 1..N answers
    // and 0..(N-1) answers can't be compared back-to-back.
    const startAt = cfg.start_at === 0 ? 0 : 1;
    const btns = Array.from({ length: scale }, (_, i) => i + startAt)
      .map(n => `<button type="button" class="likert-btn" data-value="${n}" onclick="pqLikertSelect(this)">${n}</button>`)
      .join('');
    // Inline grid override so 10-point scales render in a single row. The
    // base .likert-buttons rule uses `repeat(7, 1fr)` which wraps anything
    // larger; the inline style here wins on specificity and adapts to the
    // configured scale (3-10). `minmax(0, 1fr)` (not bare `1fr`) is the
    // critical bit on small viewports — `1fr` resolves to
    // `minmax(auto, 1fr)`, and `auto` defers to the button's min-content
    // width. With a 10-button scale on a 400px phone that overflows the
    // container horizontally (researcher report: "10 ucięte na prawej
    // krawędzi"). `minmax(0, 1fr)` lets the grid track shrink below
    // intrinsic button width so all N buttons always fit the row.
    return `<div class="pq-q" data-qid="${q.id}" data-type="likert">
      <div class="form-group">
        <label>${esc(q.label)} ${reqMark}</label>
        <div class="likert-labels" style="margin-bottom:0.5rem">
          <span>${esc(cfg.label_min || '')}</span>
          <span>${esc(cfg.label_max || '')}</span>
        </div>
        <div class="likert-buttons" style="grid-template-columns: repeat(${scale}, minmax(0, 1fr))">${btns}</div>
        ${cfg.description ? `<p class="pq-likert-description">${esc(cfg.description)}</p>` : ''}
      </div>
    </div>`;
  }

  if (q.question_type === 'open') {
    return `<div class="pq-q" data-qid="${q.id}" data-type="open">
      <div class="form-group">
        <label>${esc(q.label)} ${reqMark}</label>
        <textarea class="pq-response" rows="2" placeholder="${t('pq.answer_placeholder')}"></textarea>
      </div>
    </div>`;
  }

  const opts = Array.isArray(rawOpts) ? rawOpts : [];
  const inputType = q.question_type === 'multi' ? 'checkbox' : 'radio';
  return `<div class="pq-q" data-qid="${q.id}" data-type="${q.question_type}">
    <div class="form-group">
      <label>${esc(q.label)} ${reqMark}</label>
      <div class="radio-group">
        ${opts.map(o => {
          const val = esc(o.value || o.label || String(o));
          const lbl = esc(o.label || String(o));
          return `<label class="radio-option"><input type="${inputType}" name="${uid}" value="${val}"> ${lbl}</label>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function pqLikertSelect(btn) {
  btn.closest('.likert-buttons')?.querySelectorAll('.likert-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  // Trigger readiness check after selection
  const block = btn.closest('.post-questions-block');
  if (block) pqCheckSubmitReady(block);
}

async function submitPostQuestionsInline(btn, postId, postOrder) {
  const block = btn.closest('.post-questions-block');
  if (!block) return;
  S.pagedQSubmitted = S.pagedQSubmitted || {};
  const qEls = block.querySelectorAll('.pq-q');

  let allValid = true;
  const saves = [];

  qEls.forEach(qEl => {
    qEl.style.outline = '';
    const qid = Number(qEl.dataset.qid);
    const type = qEl.dataset.type;
    const q = S.postQuestions.find(x => x.id == qid);
    let responseText = null, responseValues = [];

    if (type === 'open') {
      responseText = qEl.querySelector('.pq-response')?.value?.trim() || '';
      if (q?.required && !responseText) allValid = false;
    } else if (type === 'likert') {
      responseText = qEl.querySelector('.likert-btn.selected')?.dataset.value || '';
      if (q?.required && !responseText) allValid = false;
    } else if (type === 'single') {
      responseText = qEl.querySelector('input:checked')?.value || '';
      if (q?.required && !responseText) allValid = false;
    } else {
      responseValues = Array.from(qEl.querySelectorAll('input:checked')).map(c => c.value);
      if (q?.required && !responseValues.length) allValid = false;
    }

    if (responseText || responseValues.length) {
      captureLogicAnswer(qid, responseText || responseValues); // feed the logic context
      saves.push({ path: '/api/post-question-response', body: {
        session_token: S.session.session_token,
        post_id: postId,
        post_order: postOrder,
        question_id: qid,
        response_text: responseText || null,
        response_values: responseValues,
      } });
    }
  });

  if (!allValid) {
    // This path is a safety net — normally the button is disabled until all required fields are filled
    qEls.forEach(qEl => {
      const q = S.postQuestions.find(x => x.id == qEl.dataset.qid);
      if (!q?.required) return;
      const type = qEl.dataset.type;
      const answered = type === 'open'
        ? !!qEl.querySelector('.pq-response')?.value?.trim()
        : type === 'likert'
          ? !!qEl.querySelector('.likert-btn.selected')
          : !!qEl.querySelector('input:checked');
      if (!answered) {
        qEl.style.outline = '2px solid var(--danger, #ef4444)';
        qEl.style.borderRadius = '6px';
        qEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    return;
  }

  btn.disabled = true;
  await persistAnswers(saves); // blocks (with retry) until every answer is saved
  btn.textContent = '✓';

  // If this block lives inside the modal (after_interaction_modal mode),
  // close the modal now that all responses are saved. The bottom Dalej is
  // then enabled and the next click on Dalej calls pagedAdvance() in the
  // normal way — no auto-advance from here so the participant gets a
  // moment between answering and moving on.
  const modal = btn.closest('.pq-modal-backdrop');
  if (modal) {
    modal.classList.remove('open');
    document.body.style.overflow = '';
    S.pagedQSubmitted[postId] = true;
    $('btn-paged-next').disabled = false;
    setTimeout(() => { const b = modal.querySelector('#pq-modal-body'); if (b) b.innerHTML = ''; }, 250);
    return;
  }

  // For builder studies in PAGED mode we still auto-advance to the next
  // post on submit (one-post-per-screen makes manual Dalej redundant when
  // the questions just got answered). Feed mode no longer auto-advances
  // the WHOLE PART — the participant clicks the always-visible "Dalej →"
  // (or the part's max_seconds timer expires). The previous feed
  // auto-advance was yanking users mid-interaction into the next part
  // every time a reaction click happened to satisfy the gate.
  const isBuilderStudy = S.config?.builder_mode === 1;
  if (isBuilderStudy) {
    const layout = S.session?.study?.layout_type || 'feed';
    if (layout === 'paged' || layout === 'custom') {
      // Paged: mark as submitted, then advance to next post (or complete session)
      S.pagedQSubmitted[postId] = true;
      setTimeout(() => pagedAdvance(), 400);
    }
    // Feed: no-op. updateFeedProgress / refreshPartChecklistForFeed have
    // already kept the Dalej-button gate and checklist counts in sync.
  }
}

// ── Browser back-button interception ─────────────────────────────────────────
(function setupBackWarning() {
  const overlay = document.getElementById('back-warning-overlay');
  if (!overlay) return;

  // Push a sentinel state so the first popstate fires instead of leaving the page
  history.replaceState({ studyPage: true }, '');
  history.pushState({ studyPage: true }, '');

  let _leaving = false;

  window.addEventListener('popstate', () => {
    if (!S.session) return;   // not in an active study session — allow normal navigation
    if (_leaving) return;     // user confirmed leave — let it proceed
    // Push state back so URL doesn't change
    history.pushState({ studyPage: true }, '');
    // Show modal
    overlay.style.display = 'flex';
  });

  document.getElementById('back-warning-stay')?.addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  document.getElementById('back-warning-leave')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    _leaving = true;
    history.go(-2); // go back past the two pushStates we added
  });
})();
