const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

function getSession(token) {
  return db.prepare('SELECT * FROM sessions WHERE session_token = ?').get(token);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Detect a logged-in admin via the `missinfo_admin_mode` cookie. The admin
// panel sets this cookie after login (default value 'preview'); the value
// can be toggled to 'production' from a UI control when the researcher
// wants to do a true production test on the live link. Sessions started
// while the cookie is 'preview' are silently flagged is_preview=1 even on
// the main study URL, so admin's own check sessions don't pollute the
// production dataset. Real participants (no cookie) get the normal flow.
function getAdminSessionMode(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)missinfo_admin_mode=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Builds a permuted block of exactly `blockSize` slots drawn from `conditions`.
// Each condition appears as equally often as possible (±1 slot).
function generateBlock(conditions, blockSize) {
  const k = conditions.length;
  const base = Math.floor(blockSize / k);
  const extra = blockSize % k;
  const pool = [];
  conditions.forEach((c, i) => {
    const reps = base + (i < extra ? 1 : 0);
    for (let r = 0; r < reps; r++) pool.push(c);
  });
  return shuffle(pool);
}

function calcMetrics(post, condObj) {
  // Priority: per-post override → condition range → post base values
  let overrides = {};
  try { overrides = JSON.parse(post.metrics_override_json || '{}'); } catch {}
  const ov = overrides[condObj.key] || {};
  const useRange = condObj.max > 0;

  const val = (field, baseField) => {
    if (ov[field] != null) return ov[field];           // explicit override
    if (useRange) return randInt(condObj.min, condObj.max); // range
    return post[baseField] || 0;                         // base value fallback
  };

  return {
    likes_shown:    val('likes',    'base_likes'),
    shares_shown:   val('shares',   'base_shares'),
    dislikes_shown: val('dislikes', 'base_dislikes'),
    flags_shown:    val('flags',    'base_flags'),
  };
}

// POST /api/session/start
router.post('/session/start', (req, res) => {
  const { study_id } = req.body;
  // Two related-but-distinct concepts:
  //  - urlPreviewFlag: did the caller hit ?preview=1 on the URL? This unlocks
  //    access to INACTIVE builder studies (the Podgląd flow before activation).
  //  - isPreview: should the resulting session row be tagged is_preview=1?
  //    True when EITHER the URL flag is set OR the logged-in admin's
  //    session-mode cookie is 'preview'. Tagging is independent of access:
  //    an admin in preview cookie mode opening the live (active) URL still
  //    needs the is_active=1 path to find the study.
  const adminMode = getAdminSessionMode(req);
  const urlPreviewFlag = req.body.preview === true;
  const isPreview = urlPreviewFlag || adminMode === 'preview';
  const study = urlPreviewFlag
    ? db.prepare('SELECT * FROM studies WHERE id = ? AND builder_mode = 1').get(study_id)
    : db.prepare('SELECT * FROM studies WHERE id = ? AND is_active = 1').get(study_id);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  // Panel-recruitment: pull the configured query-param value from
  // req.body.url_params (the client forwards every URL query param verbatim
  // so the server can pick whichever key this study is configured for).
  // Sanity-cap at 256 chars — agency IDs are typically UUID-shaped (~36
  // chars), so anything longer is almost certainly junk/abuse and trimming
  // protects the column.
  const externalIdParamName = (study.external_id_param_name || 'res_id').trim() || 'res_id';
  const urlParams = (req.body && typeof req.body.url_params === 'object') ? req.body.url_params : {};
  let externalId = urlParams[externalIdParamName];
  if (typeof externalId !== 'string') externalId = externalId == null ? null : String(externalId);
  if (externalId) {
    externalId = externalId.trim().slice(0, 256);
    if (!externalId) externalId = null;
  }

  // ── Builder study path ────────────────────────────────────────────────────
  if (study.builder_mode) {
    let manipulations = [];
    try { manipulations = JSON.parse(study.manipulation_json || '[]'); } catch {}

    const primaryManip = manipulations.find(m => m.conditions?.length > 0);
    const conditionOptions = primaryManip?.conditions?.map(c => c.key) || ['A'];
    const conditionKey = isPreview
      ? conditionOptions[0]
      : conditionOptions[Math.floor(Math.random() * conditionOptions.length)];
    const condIdx = conditionOptions.indexOf(conditionKey);
    const condSuffix = ['_a', '_b', '_c', '_d'][condIdx] || '_a';

    // ORDER BY order_index so the researcher's reorder (admin ↑↓ arrows,
    // which swap order_index) is reflected in the participant feed. id is the
    // tie-breaker for posts that were never reordered (same/0 order_index),
    // preserving creation order among them. part_id first keeps multi-part
    // grouping. Previously sorted by (part_id, id) only — order_index was
    // ignored, so admin reorder had no effect on what participants saw.
    const allPosts = db.prepare('SELECT * FROM posts WHERE study_id = ? AND is_active = 1 ORDER BY part_id, order_index, id').all(study_id);

    const token = uuidv4();
    db.prepare(`INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(study_id, token, conditionKey, 'BUILDER', conditionKey, isPreview ? 1 : 0, externalId);

    // Resolve multi-part assignment. part_ids_json is the canonical list when
    // present; otherwise fall back to [part_id] so every pre-migration post
    // continues to surface exactly where it used to. Returning an array on the
    // wire lets the client treat single- and multi-part assignment uniformly.
    const resolvePartIds = (post) => {
      try {
        const parsed = JSON.parse(post.part_ids_json || '[]');
        if (Array.isArray(parsed) && parsed.length) return parsed.filter(Boolean);
      } catch {}
      return post.part_id ? [post.part_id] : [];
    };

    let posts = allPosts.map((post, idx) => ({
      id: post.id,
      post_order: idx + 1,
      part_id: post.part_id || null,
      part_ids: resolvePartIds(post),
      topic: post.topic,
      hide_topic: post.hide_topic ? true : false,
      emoji: post.emoji,
      source_name: post.source_name,
      source_handle: post.source_handle,
      time_ago: post.time_ago,
      headline: post[`headline${condSuffix}`] || post.headline_a || '',
      content:  post[`content${condSuffix}`]  || post.content_a  || '',
      is_true: post.is_true ? true : false,
      image_url: (() => {
        const img = post[`image_path${condSuffix}`] || post.image_path;
        return img ? `/uploads/${study_id}/${img}` : null;
      })(),
      avatar_url: post.avatar_path ? `/uploads/${study_id}/${post.avatar_path}` : null,
      show_avatar: post.show_avatar !== 0,   // per-post override; default true
      // Per-post interaction toggles. All default true → existing posts behave
      // identically to pre-migration. Frontend combines these with study + part
      // level reaction/comment gates when deciding which buttons to render.
      show_like:    post.show_like    !== 0,
      show_dislike: post.show_dislike !== 0,
      show_share:   post.show_share   !== 0,
      show_flag:    post.show_flag    !== 0,
      show_comment: post.show_comment !== 0,
      manipulation_techniques: JSON.parse(post.manipulation_techniques || '[]'),
      post_comment: null,
      post_comment_author: null,
      base_likes: post.base_likes || 0,
      base_dislikes: post.base_dislikes || 0,
      base_shares: post.base_shares || 0,
      base_flags: post.base_flags || 0,
      likes_shown: post.base_likes || 0,
      dislikes_shown: post.base_dislikes || 0,
      shares_shown: post.base_shares || 0,
      flags_shown: post.base_flags || 0,
      metric_min: 0,
      metric_max: 0,
      builder_comments: (() => { try { return JSON.parse(post.builder_comments_json || '[]'); } catch { return []; } })(),
    }));

    const studyLang = study.language || 'pl';
    // File baseline + DB overrides merged. Locale edits made in the
    // platform translations modal persist in the locale_overrides table
    // and apply here on every session/start.
    const locale = db.loadLocaleWithOverrides(studyLang);
    let studyTranslations = {};
    if (studyLang !== 'pl' && study.translations_json) {
      try { const t = JSON.parse(study.translations_json); studyTranslations = t[studyLang] || {}; } catch {}
    }
    const tr = (field, fallback = '') => studyTranslations[field] || study[field] || fallback;
    // Every legacy per-study label column was created with a HARDCODED
    // Polish default in its migration (e.g. label_action_like DEFAULT
    // 'Lubię to'). Every study is born with those defaults populated, so
    // study.label_action_like is ALWAYS truthy. The participant frontend
    // does `study.x || t('actions.x')` everywhere — which means the DB
    // default always masks the locale and edits via "Tłumaczenia
    // interfejsu" do nothing for these fields. trClean() returns '' when
    // the value is exactly the migration default (researcher never
    // customised) so the frontend falls through to the locale. Non-PL
    // per-study translations still work via studyTranslations[field].
    // db.STUDY_LABEL_DEFAULTS is derived at server boot from pl.json so the
    // strings live ONLY in the locale file (the canonical translation
    // source). Zero hardcoded Polish in this render path.
    const trClean = (field, fallback = '') => {
      if (studyTranslations[field]) return studyTranslations[field];
      const v = study[field];
      if (v != null && v !== db.STUDY_LABEL_DEFAULTS[field]) return v;
      return fallback;
    };

    // ── Translation overlay for posts (headlines, content, topic, comments, time_ago)
    if (studyTranslations.posts && studyTranslations.posts.length) {
      const postTransMap = {};
      studyTranslations.posts.forEach(p => { postTransMap[p.id] = p; });
      // Honor the overlay value when DEFINED (incl. explicit empty string —
      // a cleared field in the translated version is intentional, WYSIWYG).
      // `!= null` distinguishes "" (present, use it) from undefined/null
      // (untranslated → fall back to Polish source). The B→A fallback within
      // the translation stays `!= null` too, so an absent B uses translated A.
      const trPick = (v, fallback) => (v != null ? v : fallback);
      posts = posts.map(p => {
        const tp = postTransMap[p.id];
        if (!tp) return p;
        // Pick translated headline/content matching the condition (a/b)
        const trHeadline = condSuffix === '_b' ? trPick(tp.headline_b, tp.headline_a) : tp.headline_a;
        const trContent  = condSuffix === '_b' ? trPick(tp.content_b,  tp.content_a)  : tp.content_a;
        return {
          ...p,
          headline: trPick(trHeadline, p.headline),
          content:  trPick(trContent,  p.content),
          // NOTE: `topic` stays as the original key (e.g. "nauka"); the participant
          // client maps it through the locale (`topics.<key>`) so the topic pill
          // displays correctly translated. Overwriting it with the translated value
          // would break the locale lookup.
          time_ago:            trPick(tp.time_ago,            p.time_ago),
          post_comment:        trPick(tp.post_comment,        p.post_comment),
          post_comment_author: trPick(tp.post_comment_author, p.post_comment_author),
        };
      });
    }

    let demoQuestions = db.prepare('SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index').all(study_id);
    if (!demoQuestions.length) {
      db.seedDefaultDemographicQuestions(study_id);
      demoQuestions = db.prepare('SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index').all(study_id);
    }

    // ── Translation overlay for demographic_questions (label + option labels)
    if (studyTranslations.demographic_questions && studyTranslations.demographic_questions.length) {
      const dqMap = {};
      studyTranslations.demographic_questions.forEach(q => { dqMap[q.id] = q; });
      demoQuestions = demoQuestions.map(q => {
        const tq = dqMap[q.id];
        if (!tq) return q;
        let options = [];
        try { options = JSON.parse(q.options || '[]'); } catch {}
        if (tq.options && Array.isArray(tq.options) && tq.options.length) {
          options = options.map((o, i) => ({
            ...o,
            label: (tq.options[i] && tq.options[i].label) ? tq.options[i].label : o.label,
          }));
        }
        return { ...q, label: tq.label != null ? tq.label : q.label, options: JSON.stringify(options) };
      });
    }

    let postQuestions = db.prepare('SELECT * FROM post_questions WHERE study_id = ? AND is_active = 1 ORDER BY part_id, order_index').all(study_id);

    // ── Translation overlay for post_questions (label + options)
    if (studyTranslations.post_questions && studyTranslations.post_questions.length) {
      const pqMap = {};
      studyTranslations.post_questions.forEach(q => { pqMap[q.id] = q; });
      postQuestions = postQuestions.map(q => {
        const tq = pqMap[q.id];
        if (!tq) return q;
        // options_json shape depends on question_type — array for choice, object for likert
        let opts = null;
        try { opts = JSON.parse(q.options_json || '[]'); } catch {}
        if (q.question_type === 'likert' && opts && tq.options && !Array.isArray(tq.options)) {
          opts = {
            ...opts,
            label_min: tq.options.label_min ?? opts.label_min,
            label_max: tq.options.label_max ?? opts.label_max,
            description: tq.options.description ?? opts.description,
          };
        } else if (Array.isArray(opts) && Array.isArray(tq.options)) {
          opts = opts.map((o, i) => ({
            ...o,
            label: (tq.options[i] && tq.options[i].label) ? tq.options[i].label : o.label,
          }));
        }
        return { ...q, label: tq.label != null ? tq.label : q.label, options_json: JSON.stringify(opts ?? []) };
      });
    }

    let studyParts = [];
    try { studyParts = JSON.parse(study.parts_json || '[]'); } catch {}

    // ── Translation overlay for parts (label + transition_text + pq screen copy)
    if (studyTranslations.parts && studyTranslations.parts.length) {
      const partMap = {};
      studyTranslations.parts.forEach(p => { partMap[p.id] = p; });
      studyParts = studyParts.map(p => {
        const tp = partMap[p.id];
        if (!tp) return p;
        return {
          ...p,
          label:           tp.label           != null ? tp.label           : p.label,
          transition_text: tp.transition_text != null ? tp.transition_text : p.transition_text,
          pq_title:        tp.pq_title        != null ? tp.pq_title        : p.pq_title,
          pq_subtitle:     tp.pq_subtitle     != null ? tp.pq_subtitle     : p.pq_subtitle,
        };
      });
    }

    return res.json({
      session_token: token,
      // Panel-recruitment: surface the captured respondent ID on the
      // session payload so the client can substitute {ext_id} into
      // completion_redirect_url before navigation.
      external_id: externalId,
      is_preview: isPreview ? 1 : 0,
      style_condition: conditionKey,
      metric_condition: 'BUILDER',
      full_condition: conditionKey,
      parts: studyParts,
      // Conditional-logic rules for the client-side engine (lib/logic.js). The
      // participant runtime guards on is_preview so rules never fire in preview.
      logic: (() => { try { return JSON.parse(study.logic_json || 'null'); } catch { return null; } })(),
      posts,
      demographic_questions: demoQuestions,
      post_questions: postQuestions,
      language: studyLang,
      locale,
      study_translations: studyTranslations,
      study: {
        id: study.id,
        name: study.name,
        participant_title: tr('participant_title', study.participant_title || study.name),
        contact_email: study.contact_email || '',
        institution: study.institution || '',
        consent_text: tr('consent_text', db.DEFAULT_CONSENT_TEXT),
        instruction_text: tr('instruction_text', db.DEFAULT_INSTRUCTION_TEXT),
        debrief_text: tr('debrief_text', db.DEFAULT_DEBRIEF_TEXT),
        transition_feed_text: tr('transition_feed_text', db.DEFAULT_TRANSITION_FEED_TEXT),
        transition_rating_text: tr('transition_rating_text', db.DEFAULT_TRANSITION_RATING_TEXT),
        label_action_like:    trClean('label_action_like',    ''),
        label_action_dislike: trClean('label_action_dislike', ''),
        label_action_share:   trClean('label_action_share',   ''),
        label_action_flag:    trClean('label_action_flag',    ''),
        label_likert_question: trClean('label_likert_question', ''),
        label_likert_min:      trClean('label_likert_min',      ''),
        label_likert_max:      trClean('label_likert_max',      ''),
        comment_placeholder:   trClean('comment_placeholder',   ''),
        hide_topic_badges: study.hide_topic_badges ? true : false,
        layout_type: study.layout_type || 'feed',
        show_reactions: study.show_reactions !== 0,
        enable_comments: study.enable_comments ? true : false,
        allow_multi_reactions: study.allow_multi_reactions ? true : false,
        // Panel-recruitment endlink. NULL/empty = no redirect, standard
        // end-screen flow (default for non-panel studies — zero behaviour
        // change). Client substitutes {ext_id} / {session_id} placeholders
        // before navigating, so the agency can identify which respondent
        // finished even when the URL doesn't carry our token.
        completion_redirect_url: study.completion_redirect_url || null,
        // How long to show the debrief before auto-redirect fires. Hard-cap
        // at 600s so a typo in the admin can't trap the participant on
        // the end screen indefinitely. Floor at 0 = immediate navigation.
        completion_redirect_delay_seconds: Math.max(0, Math.min(600,
          Number(study.completion_redirect_delay_seconds ?? 4))),
        // Optional custom text rendered inside a sticky box at the top of
        // the debrief. NULL = no sticky box, only the previous inline
        // "you'll be redirected" notice fires.
        completion_redirect_notice: study.completion_redirect_notice || null,
        // Decline endlink — fired when the participant clicks "Nie wyrażam
        // zgody" on the consent screen. Mirrors the three completion
        // fields. NULL URL = stay on the local thank-you screen.
        decline_redirect_url: study.decline_redirect_url || null,
        decline_redirect_delay_seconds: Math.max(0, Math.min(600,
          Number(study.decline_redirect_delay_seconds ?? 4))),
        decline_redirect_notice: study.decline_redirect_notice || null,
        // Bypass the local "Rozumiemy" screen entirely — navigate to the
        // agency URL immediately on click. Honored only when the URL is
        // also set. Truthy → immediate navigation; falsy → previous
        // behaviour (show local screen, then timer-driven redirect).
        decline_redirect_immediate: study.decline_redirect_immediate ? 1 : 0,
        show_instructions: study.show_instructions === 1,   // only if explicitly enabled
        show_transition_feed: false,                        // builder uses part-level transitions
        show_transition_rating: false,                      // no rating phase in builder
        show_debrief: study.show_debrief !== 0,
        show_debrief_posts: study.show_debrief_posts !== 0,
        show_instruction_actions: study.show_instruction_actions !== 0,
        show_avatars: study.show_avatars !== 0,
        show_demographics: study.show_demographics !== 0,
        // Resolved demographics position. Falls back to show_demographics for
        // studies last edited before the dropdown landed (show=0 → 'hidden').
        demographics_position: (study.demographics_position && ['after_consent', 'before_debrief', 'hidden'].includes(study.demographics_position))
          ? study.demographics_position
          : (study.show_demographics === 0 ? 'hidden' : 'after_consent'),
        show_metrics: study.show_metrics !== 0,
        clarity_enabled: study.clarity_enabled ? true : false,
        clarity_project_id: study.clarity_project_id || null,
        eyetracking_enabled: study.eyetracking_enabled ? true : false,
        show_comment_in_condition: false,
        label_style_a: (primaryManip?.conditions?.[0]?.label) || conditionOptions[0] || 'A',
        label_style_b: (primaryManip?.conditions?.[1]?.label) || conditionOptions[1] || 'B',
        no_consent_text: study.no_consent_text || null,
      },
    });
  }
  // ── End builder path ──────────────────────────────────────────────────────

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

  // Build the full condition list (all style × metric combinations)
  const fullConditions = [];
  for (const s of styleOptions) {
    for (const m of metricOptions) {
      fullConditions.push({ style: s, metricKey: m.key });
    }
  }

  // Permuted block randomization (block size 4).
  // Queue is stored per-study in condition_queue_json and refilled when empty.
  // Items in the queue are validated against current enabled conditions so that
  // changing study settings doesn't leave stale entries in the queue.
  const validKeys = new Set(fullConditions.map(c => `${c.style}-${c.metricKey}`));
  let queue = [];
  try { queue = JSON.parse(study.condition_queue_json || '[]'); } catch {}
  queue = queue.filter(c => validKeys.has(`${c.style}-${c.metricKey}`));
  // Block size: at least as large as number of conditions (so each appears ≥1 per block)
  const blockSize = Math.max(4, fullConditions.length);
  if (!queue.length) queue = generateBlock(fullConditions, blockSize);
  const chosen = queue.shift();
  db.prepare('UPDATE studies SET condition_queue_json = ? WHERE id = ?')
    .run(JSON.stringify(queue), study_id);

  const style_condition  = chosen.style;
  const metricCondObj    = metricOptions.find(m => m.key === chosen.metricKey) || metricOptions[0];
  const metric_condition = metricCondObj.key;
  const full_condition   = `${style_condition}-${metric_condition}`;

  const allPosts = db.prepare('SELECT * FROM posts WHERE study_id = ? AND is_active = 1').all(study_id);
  if (!allPosts.length) return res.status(400).json({ error: 'No active posts in study' });

  const n = Math.min(study.posts_per_session, allPosts.length);
  const shuffled = [...allPosts].sort(() => Math.random() - 0.5).slice(0, n);

  const token = uuidv4();
  db.prepare(`
    INSERT INTO sessions (study_id, session_token, style_condition, metric_condition, full_condition, is_preview, external_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(study_id, token, style_condition, metric_condition, full_condition, isPreview ? 1 : 0, externalId);

  let posts = shuffled.map((post, idx) => {
    const metrics = calcMetrics(post, metricCondObj);

    // Resolve comment: keyed by style condition (A/B); only shown when metric condition has show_comment=true
    let postComments = {};
    try { postComments = JSON.parse(post.post_comments_json || '{}'); } catch {}
    const styleComment = postComments[style_condition] || {};
    const post_comment        = metricCondObj.show_comment ? ((styleComment.text   || '').trim() || post.post_comment        || null) : null;
    const post_comment_author = metricCondObj.show_comment ? ((styleComment.author || '').trim() || post.post_comment_author || null) : null;

    return {
      id: post.id,
      post_order: idx + 1,
      topic: post.topic,
      hide_topic: post.hide_topic ? true : false,
      emoji: post.emoji,
      source_name: post.source_name,
      source_handle: post.source_handle,
      time_ago: post.time_ago,
      headline: style_condition === 'A' ? post.headline_a : post.headline_b,
      content: style_condition === 'A' ? post.content_a : post.content_b,
      is_true: post.is_true ? true : false,
      image_url: (() => {
        // Per-variant image takes priority; fall back to legacy image_path
        const variantPath = style_condition === 'A' ? post.image_path_a : post.image_path_b;
        const img = variantPath || post.image_path;
        return img ? `/uploads/${study_id}/${img}` : null;
      })(),
      avatar_url: post.avatar_path ? `/uploads/${study_id}/${post.avatar_path}` : null,
      show_avatar: post.show_avatar !== 0,   // per-post override; default true
      // Per-post interaction toggles. All default true → existing posts behave
      // identically to pre-migration. Frontend combines these with study + part
      // level reaction/comment gates when deciding which buttons to render.
      show_like:    post.show_like    !== 0,
      show_dislike: post.show_dislike !== 0,
      show_share:   post.show_share   !== 0,
      show_flag:    post.show_flag    !== 0,
      show_comment: post.show_comment !== 0,
      manipulation_techniques: JSON.parse(post.manipulation_techniques || '[]'),
      post_comment,
      post_comment_author,
      ...metrics,
    };
  });

  // Demographic questions — seed defaults if none exist yet
  let demoQuestions = db.prepare(
    'SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(study_id);
  if (!demoQuestions.length) {
    db.seedDefaultDemographicQuestions(study_id);
    demoQuestions = db.prepare(
      'SELECT * FROM demographic_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
    ).all(study_id);
  }

  // Load locale for the study's language
  const studyLang = study.language || 'pl';
  // File baseline + DB locale_overrides merged. Falls back to PL when the
  // requested lang has no file at all (legacy: missing translation set).
  let locale = db.loadLocaleWithOverrides(studyLang);
  if (!Object.keys(locale).length) locale = db.loadLocaleWithOverrides('pl');

  // Load study translations for non-PL languages
  let studyTranslations = {};
  if (studyLang !== 'pl' && study.translations_json) {
    try {
      const allTrans = JSON.parse(study.translations_json);
      studyTranslations = allTrans[studyLang] || {};
    } catch {}
  }

  // Helper: pick translated value first, fall back to DB value, then hardcoded default
  const tr = (field, fallback = '') => studyTranslations[field] || study[field] || fallback;
  // Strip migration-default values for the label_* columns. The defaults
  // map is derived at server boot from pl.json (see db.STUDY_LABEL_DEFAULTS)
  // so zero Polish text is hardcoded here.
  const trClean = (field, fallback = '') => {
    if (studyTranslations[field]) return studyTranslations[field];
    const v = study[field];
    if (v != null && v !== db.STUDY_LABEL_DEFAULTS[field]) return v;
    return fallback;
  };

  // Overlay translated post content
  if (studyTranslations.posts && studyTranslations.posts.length) {
    const postTransMap = {};
    studyTranslations.posts.forEach(p => { postTransMap[p.id] = p; });
    posts = posts.map(p => {
      const tp = postTransMap[p.id];
      if (!tp) return p;
      const trPick = (v, fb) => (v != null ? v : fb);
      return {
        ...p,
        headline: style_condition === 'A' ? trPick(tp.headline_a, p.headline) : trPick(tp.headline_b, p.headline),
        content:  style_condition === 'A' ? trPick(tp.content_a,  p.content)  : trPick(tp.content_b,  p.content),
        // Keep original topic key — client maps it via `topics.<key>` locale entries.
        post_comment:        trPick(tp.post_comment,        p.post_comment),
        post_comment_author: trPick(tp.post_comment_author, p.post_comment_author),
      };
    });
  }

  // Overlay translated demographic question labels + option labels
  const dqTrans = studyTranslations.demographic_questions;
  if (dqTrans && dqTrans.length) {
    const dqMap = {};
    dqTrans.forEach(q => { dqMap[q.id] = q; });
    demoQuestions = demoQuestions.map(q => {
      const tq = dqMap[q.id];
      if (!tq) return q;
      // Merge translated option labels onto original options (keep value unchanged)
      let options = [];
      try { options = JSON.parse(q.options || '[]'); } catch {}
      if (tq.options && tq.options.length) {
        options = options.map((o, i) => ({
          ...o,
          label: (tq.options[i] && tq.options[i].label) ? tq.options[i].label : o.label,
        }));
      }
      return { ...q, label: tq.label != null ? tq.label : q.label, options: JSON.stringify(options) };
    });
  }

  let postQuestions = db.prepare(
    'SELECT * FROM post_questions WHERE study_id = ? AND is_active = 1 ORDER BY order_index'
  ).all(study_id);

  // Overlay post_questions translations (mirrors the builder path)
  if (studyTranslations.post_questions && studyTranslations.post_questions.length) {
    const pqMap = {};
    studyTranslations.post_questions.forEach(q => { pqMap[q.id] = q; });
    postQuestions = postQuestions.map(q => {
      const tq = pqMap[q.id];
      if (!tq) return q;
      let opts = null;
      try { opts = JSON.parse(q.options_json || '[]'); } catch {}
      if (q.question_type === 'likert' && opts && tq.options && !Array.isArray(tq.options)) {
        opts = {
          ...opts,
          label_min:   tq.options.label_min   ?? opts.label_min,
          label_max:   tq.options.label_max   ?? opts.label_max,
          description: tq.options.description ?? opts.description,
        };
      } else if (Array.isArray(opts) && Array.isArray(tq.options)) {
        opts = opts.map((o, i) => ({
          ...o,
          label: (tq.options[i] && tq.options[i].label) ? tq.options[i].label : o.label,
        }));
      }
      return { ...q, label: tq.label != null ? tq.label : q.label, options_json: JSON.stringify(opts ?? []) };
    });
  }

  res.json({
    session_token: token,
    // Panel-recruitment: see builder branch for rationale.
    external_id: externalId,
    is_preview: isPreview ? 1 : 0,
    style_condition,
    metric_condition,
    full_condition,
    posts,
    demographic_questions: demoQuestions,
    post_questions: postQuestions,
    language: studyLang,
    locale: locale,
    study_translations: studyTranslations, // kept for ts() fallback on client
    study: {
      id: study.id,
      name: study.name,
      participant_title: tr('participant_title', study.participant_title || study.name),
      contact_email: study.contact_email || '',
      institution:   study.institution   || '',
      // All translatable text fields — translated value wins, then DB, then default
      consent_text:           tr('consent_text',           db.DEFAULT_CONSENT_TEXT),
      instruction_text:       tr('instruction_text',       db.DEFAULT_INSTRUCTION_TEXT),
      debrief_text:           tr('debrief_text',           db.DEFAULT_DEBRIEF_TEXT),
      transition_feed_text:   tr('transition_feed_text',   db.DEFAULT_TRANSITION_FEED_TEXT),
      transition_rating_text: tr('transition_rating_text', db.DEFAULT_TRANSITION_RATING_TEXT),
      label_action_like:    trClean('label_action_like',    ''),
      label_action_dislike: trClean('label_action_dislike', ''),
      label_action_share:   trClean('label_action_share',   ''),
      label_action_flag:    trClean('label_action_flag',    ''),
      label_likert_question: trClean('label_likert_question', ''),
      label_likert_min:      trClean('label_likert_min',      ''),
      label_likert_max:      trClean('label_likert_max',      ''),
      comment_placeholder:   trClean('comment_placeholder',   ''),
      // Non-translated fields
      hide_topic_badges: study.hide_topic_badges ? true : false,
      layout_type:   study.layout_type || 'feed',
      show_reactions:         study.show_reactions !== 0,
      enable_comments:        study.enable_comments ? true : false,
      // Multi-react mode — when true, the participant can stack non-opposing
      // reactions on the same post (like+share+flag); like/dislike remain
      // mutually exclusive; re-clicking a reaction toggles it off.
      allow_multi_reactions:  study.allow_multi_reactions ? true : false,
      // Panel-recruitment endlink (see builder branch above for rationale).
      completion_redirect_url: study.completion_redirect_url || null,
      completion_redirect_delay_seconds: Math.max(0, Math.min(600,
        Number(study.completion_redirect_delay_seconds ?? 4))),
      completion_redirect_notice: study.completion_redirect_notice || null,
      // Decline endlink — see builder branch above for rationale.
      decline_redirect_url: study.decline_redirect_url || null,
      decline_redirect_delay_seconds: Math.max(0, Math.min(600,
        Number(study.decline_redirect_delay_seconds ?? 4))),
      decline_redirect_notice: study.decline_redirect_notice || null,
      decline_redirect_immediate: study.decline_redirect_immediate ? 1 : 0,
      show_instructions:      study.show_instructions !== 0,
      show_transition_feed:   study.show_transition_feed !== 0,
      show_transition_rating: study.show_transition_rating !== 0,
      show_debrief:    study.show_debrief !== 0,
      show_debrief_posts: study.show_debrief_posts !== 0,
      show_instruction_actions: study.show_instruction_actions !== 0,
      show_avatars:    study.show_avatars !== 0,
      show_demographics: study.show_demographics !== 0,
      show_metrics:    study.show_metrics !== 0,
      clarity_enabled:     study.clarity_enabled ? true : false,
      clarity_project_id:  study.clarity_project_id || null,
      eyetracking_enabled: study.eyetracking_enabled ? true : false,
      show_comment_in_condition: metricCondObj.show_comment ? true : false,
      label_style_a: study.label_style_a || styleOptions[0] || 'A',
      label_style_b: study.label_style_b || styleOptions[1] || 'B',
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
  const { session_token, age, residence, education, gender, ...rest } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // Diagnostic: log the exact payload landing here. The researcher reported
  // entering age=98 on a session whose export later showed age=52, with no
  // transformation visible anywhere in the pipeline (client form collects
  // fd.get('age') verbatim; server UPDATEs sessions.age directly with no
  // cap; export's trDemoValue is identity for text/number fields). Logging
  // the raw body lets us pinpoint whether the bad value originates on the
  // client (browser autocomplete substitution, race condition, hidden
  // field collision) or on the server. Remove or downgrade to debug-only
  // once the case is closed.
  try {
    console.log('[demographics POST]', {
      session_id: session.id,
      session_token: session_token ? session_token.slice(0, 8) + '…' : null,
      raw_age: age,
      raw_age_type: typeof age,
      raw_residence: residence,
      raw_education: education,
      raw_gender: gender,
      extra_keys: Object.keys(req.body).filter(k => !['session_token','age','residence','education','gender'].includes(k)),
    });
  } catch (_) { /* logging must never break the submit path */ }

  // Save legacy fixed fields
  db.prepare('UPDATE sessions SET age = ?, residence = ?, education = ?, gender = ? WHERE session_token = ?')
    .run(age || null, residence || null, education || null, gender || null, session_token);

  // Save all custom (non-legacy) demographic answers as JSON
  const LEGACY = new Set(['session_token', 'age', 'residence', 'education', 'gender']);
  const extra = {};
  Object.entries(req.body).forEach(([k, v]) => { if (!LEGACY.has(k) && v != null) extra[k] = v; });
  if (Object.keys(extra).length) {
    db.prepare('UPDATE sessions SET demographics_extra_json = ? WHERE session_token = ?')
      .run(JSON.stringify(extra), session_token);
  }

  res.json({ ok: true });
});

// POST /api/reaction
router.post('/reaction', (req, res) => {
  const { session_token, post_id, post_order, action, dwell_ms,
    likes_shown, shares_shown, dislikes_shown, flags_shown, comment, is_undo } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  // Single- vs multi-react mode determines the dedup key. In single-react
  // mode (legacy), each post carries at most one reaction — we wipe all
  // prior rows for the post before writing the new one. In multi-react
  // mode each post can carry several reactions stacked together
  // (like+share+flag), so we only dedup against the same action type;
  // a new "share" mustn't clobber an existing "like" on the same post.
  const study = db.prepare('SELECT allow_multi_reactions FROM studies WHERE id = ?').get(session.study_id);
  const multi = !!(study && study.allow_multi_reactions);
  // 'comment' is a special pseudo-action — emitted by the comment textarea
  // listener so a participant who types but never clicks a reaction still
  // has their comment persisted. It dedupes against its own action key
  // only (never wipes a real reaction row), skips the like/dislike mutex,
  // and behaves identically in single- and multi-react studies so we don't
  // need a parallel codepath downstream.
  if (action === 'comment') {
    db.prepare('DELETE FROM reactions WHERE session_id = ? AND post_id = ? AND action = ?')
      .run(session.id, post_id, 'comment');
  } else if (multi) {
    db.prepare('DELETE FROM reactions WHERE session_id = ? AND post_id = ? AND action = ?')
      .run(session.id, post_id, action);
    // Like ↔ dislike are mutually exclusive even in multi-react mode. The
    // frontend (applyMultiReactClick) drops the opposite from local state
    // when one of the pair is clicked, but it only POSTs the NEW click.
    // Without the server mirroring that rule, the previous opposite's row
    // stays in the table and the export reads both as active at once
    // (the "post_1_liked=1 AND post_1_disliked=1" leak the researcher hit).
    // On a positive (is_undo=0) like/dislike click we record an is_undo=1
    // row for the opposite so the audit trail keeps the transition AND
    // the export's active-state resolver correctly reads only the newly
    // selected one as on.
    if (!is_undo && (action === 'like' || action === 'dislike')) {
      const opposite = action === 'like' ? 'dislike' : 'like';
      const existing = db.prepare(
        'SELECT 1 FROM reactions WHERE session_id = ? AND post_id = ? AND action = ? AND COALESCE(is_undo, 0) = 0'
      ).get(session.id, post_id, opposite);
      if (existing) {
        db.prepare('DELETE FROM reactions WHERE session_id = ? AND post_id = ? AND action = ?')
          .run(session.id, post_id, opposite);
        db.prepare(`
          INSERT INTO reactions (session_id, post_id, post_order, action,
            likes_shown, shares_shown, dislikes_shown, flags_shown, is_undo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(session.id, post_id, post_order || 0, opposite,
          likes_shown || 0, shares_shown || 0, dislikes_shown || 0, flags_shown || 0);
      }
    }
  } else {
    db.prepare('DELETE FROM reactions WHERE session_id = ? AND post_id = ?')
      .run(session.id, post_id);
  }
  // Preserve metric "shown" values across action types. The comment-save path
  // (scheduleCommentSave) historically POSTed action='comment' WITHOUT
  // likes_shown/shares_shown/dislikes_shown/flags_shown, which made the
  // server store zeros on the comment row. Because the export then picked
  // reactionRows[0].likes_shown (and the comment row was chronologically
  // first for sessions that commented before reacting), every metric column
  // for that post on that session read 0 — the "post_4_likes_shown=0 even
  // though the post was configured with base_likes=10" bug. We now look up
  // the most recent prior reactions row for the same (session, post) and
  // carry its metric values forward when the incoming request didn't supply
  // them. This keeps every row for the same (session, post) consistent
  // regardless of which client path inserted it.
  const inLikes    = likes_shown    != null ? Number(likes_shown    || 0) : null;
  const inShares   = shares_shown   != null ? Number(shares_shown   || 0) : null;
  const inDislikes = dislikes_shown != null ? Number(dislikes_shown || 0) : null;
  const inFlags    = flags_shown    != null ? Number(flags_shown    || 0) : null;
  const needFallback = inLikes == null || inShares == null || inDislikes == null || inFlags == null;
  let prior = null;
  if (needFallback) {
    prior = db.prepare(
      `SELECT likes_shown, shares_shown, dislikes_shown, flags_shown
       FROM reactions WHERE session_id = ? AND post_id = ?
       ORDER BY id DESC LIMIT 1`
    ).get(session.id, post_id);
  }
  const finalLikes    = inLikes    != null ? inLikes    : (prior ? prior.likes_shown    : 0);
  const finalShares   = inShares   != null ? inShares   : (prior ? prior.shares_shown   : 0);
  const finalDislikes = inDislikes != null ? inDislikes : (prior ? prior.dislikes_shown : 0);
  const finalFlags    = inFlags    != null ? inFlags    : (prior ? prior.flags_shown    : 0);

  db.prepare(`
    INSERT INTO reactions (session_id, post_id, post_order, action, dwell_ms,
      likes_shown, shares_shown, dislikes_shown, flags_shown, comment, is_undo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(session.id, post_id, post_order, action, dwell_ms || 0,
    finalLikes, finalShares, finalDislikes, finalFlags,
    comment && String(comment).trim() ? String(comment).trim() : null,
    is_undo ? 1 : 0);

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

// POST /api/post-view — record cumulative dwell time for a post the
// participant viewed but did not react to. The reactions row already
// carries dwell_ms for posts that were liked/disliked/shared/flagged,
// so the export merge prefers reactions.dwell_ms and falls back to
// post_views.dwell_ms only when no reaction exists. UPSERT pattern:
// first call inserts with first_seen_at = now; subsequent calls add
// to dwell_ms and bump last_seen_at. This lets us call the endpoint
// every time the post leaves the viewport (feed) or the participant
// advances past it (paged) without double-counting on re-entry.
router.post('/post-view', (req, res) => {
  const { session_token, post_id, post_order, dwell_ms } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  const dwell = Math.max(0, Number(dwell_ms) || 0);
  if (!post_id || dwell <= 0) return res.json({ ok: true, skipped: true });
  // SQLite UPSERT — ON CONFLICT on the composite PK accumulates dwell
  // and bumps last_seen_at. first_seen_at is only set on the initial
  // insert, preserving the first-view timestamp across re-visits.
  db.prepare(`
    INSERT INTO post_views (session_id, post_id, post_order, dwell_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, post_id) DO UPDATE SET
      dwell_ms = dwell_ms + excluded.dwell_ms,
      last_seen_at = CURRENT_TIMESTAMP,
      post_order = COALESCE(post_views.post_order, excluded.post_order)
  `).run(session.id, post_id, post_order || null, dwell);
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

// POST /api/post-question-response
// Accepts both post-scoped (post_id set, part_id null) and part-scoped responses
// (post_id=0 sentinel, part_id set) — the latter come from the after_all_posts
// display mode where one questions screen covers a whole part instead of being
// asked per-post. Schema keeps post_id NOT NULL for backwards compat; the
// nullable part_id column is the canonical marker that researchers should
// query on (`WHERE part_id IS NOT NULL` → part-scoped).
router.post('/post-question-response', (req, res) => {
  const { session_token, post_id, post_order, question_id, response_text, response_values, part_id } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  db.prepare(`
    INSERT INTO post_question_responses (session_id, post_id, post_order, question_id, response_text, response_values_json, part_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    part_id ? 0 : (post_id || 0),
    part_id ? null : (post_order || 0),
    question_id,
    response_text || null,
    JSON.stringify(response_values || []),
    part_id || null
  );
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

// POST /api/session/logic-event — record conditional-logic outcomes for a
// session: which part(s) a rule skipped, and whether a rule ended the study
// early. Lets the export distinguish "skipped by rule" from "never reached".
router.post('/session/logic-event', (req, res) => {
  const { session_token, skipped_part_id, end_rule_id } = req.body || {};
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  if (skipped_part_id != null && skipped_part_id !== '') {
    const row = db.prepare('SELECT logic_skipped_parts_json FROM sessions WHERE session_token = ?').get(session_token);
    let arr = []; try { arr = JSON.parse(row.logic_skipped_parts_json || '[]'); } catch {}
    if (!arr.includes(skipped_part_id)) {
      arr.push(skipped_part_id);
      db.prepare('UPDATE sessions SET logic_skipped_parts_json = ? WHERE session_token = ?').run(JSON.stringify(arr), session_token);
    }
  }
  if (end_rule_id != null && end_rule_id !== '') {
    db.prepare('UPDATE sessions SET logic_end_rule_id = ? WHERE session_token = ?').run(String(end_rule_id), session_token);
  }
  res.json({ ok: true });
});

// POST /api/session/eyetracking-consent — record camera consent + calibration quality
router.post('/session/eyetracking-consent', (req, res) => {
  const { session_token, eyetracking_consent, calibration_error, n_recalibrations } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  db.prepare(`UPDATE sessions SET eyetracking_consent = ?, calibration_error = ?, n_recalibrations = ?
    WHERE session_token = ?`)
    .run(eyetracking_consent ? 1 : 0, calibration_error ?? null, n_recalibrations ?? 0, session_token);
  res.json({ ok: true });
});

// POST /api/gaze — batch insert gaze points (fire-and-forget from client)
router.post('/gaze', (req, res) => {
  const { session_token, points } = req.body;
  if (!session_token || !Array.isArray(points) || !points.length) return res.json({ ok: true });
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });

  const insert = db.prepare(`
    INSERT INTO gaze_points
      (session_id, post_id, post_order, screen_name, t, x, y, vw, vh, scroll_y, aoi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((pts) => {
    for (const p of pts) {
      insert.run(
        session.id,
        p.post_id   ?? null, p.post_order  ?? null,
        p.screen_name ?? null,
        p.t, p.x, p.y,
        p.vw ?? null, p.vh ?? null, p.scroll_y ?? null,
        p.aoi ?? null
      );
    }
  });
  try { insertAll(points); } catch (_) { /* non-critical */ }
  res.json({ ok: true });
});

// POST /api/session/feed-snapshot — store post layout snapshot for heatmap viewer
router.post('/session/feed-snapshot', (req, res) => {
  const { session_token, snapshot } = req.body;
  const session = getSession(session_token);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  db.prepare('UPDATE sessions SET feed_snapshot = ? WHERE session_token = ?')
    .run(JSON.stringify(snapshot || []), session_token);
  res.json({ ok: true });
});

module.exports = router;
