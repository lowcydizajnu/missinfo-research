'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  token: localStorage.getItem('admin_token'),
  studies: [],
  selectedDashboardStudy: null,
  selectedPostsStudy: null,
  selectedExportStudy: null,
  currentPosts: [],   // cached for preview
  lang: localStorage.getItem('admin_lang') || 'pl',  // panel UI language
  // Delivered SYNCHRONOUSLY by /locales/admin.js, which the HTML loads before
  // this file — so t() already works on this module's first line. Some
  // module-level constants (e.g. AN_TESTS) label themselves with t() at parse
  // time; with an async fetch they would bake in the raw key permanently.
  locales: (window.ADMIN_LOCALES || { pl: {}, en: {} }),
};

// ── i18n ─────────────────────────────────────────────────────────────────────
// Polish is the SOURCE language and the default; English is an overlay for
// self-hosters. Mirrors the participant-side t() (participant.js) — dot-path
// keys + {{var}} interpolation — with one deliberate difference: a missing key
// falls back to the POLISH string, never to the raw key. A partially translated
// panel therefore degrades to Polish rather than showing "header.logout".
const ADMIN_LANGS = { pl: 'Polski', en: 'English' };

function t(keyPath, vars = {}) {
  const pick = (loc) => {
    let v = loc;
    for (const k of keyPath.split('.')) { v = v?.[k]; if (v === undefined) return undefined; }
    return typeof v === 'string' ? v : undefined;
  };
  const val = pick(S.locales[S.lang]) ?? pick(S.locales.pl) ?? keyPath;
  return val.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// Translate the STATIC markup in admin.html. JS-rendered templates call t()
// inline instead; this covers only what ships in the HTML file.
//   data-i18n="key"             → textContent
//   data-i18n-placeholder="key" → placeholder attribute
//   data-i18n-title="key"       → title attribute
function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

// Switching language re-renders everything the simplest bulletproof way: a
// reload. It is a rare action and guarantees no stale strings survive in any
// already-rendered tab.
function setAdminLang(lang) {
  if (!ADMIN_LANGS[lang] || lang === S.lang) return;
  localStorage.setItem('admin_lang', lang);
  location.reload();
}

// ── API ────────────────────────────────────────────────────────────────────
async function api(method, path, data, isForm = false) {
  const opts = { method, headers: { Authorization: `Bearer ${S.token}` } };
  if (data && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  } else if (data && isForm) {
    opts.body = data;
  }
  const r = await fetch(`/api/admin${path}`, opts);
  if (r.status === 401) { doLogout(); return null; }
  const isJson = r.headers.get('content-type')?.includes('json');
  if (!r.ok) {
    const err = isJson ? await r.json() : { error: r.statusText };
    toast(err.error || 'Błąd serwera.', 'error');
    return null;
  }
  if (isJson) return r.json();
  return r;
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ── Modal ──────────────────────────────────────────────────────────────────
function showModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
}
function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    const tab = btn.dataset.tab;
    if (tab === 'users') return renderUsersTab();  // study-independent
    const id = S.activeStudy;
    if (!id) return;
    if (tab === 'dashboard')    loadDashboard(id);
    else if (tab === 'posts')   loadPosts(id);
    else if (tab === 'demographics') loadDemographicQuestions(id);
    else if (tab === 'export')  loadExportView(id);
    else if (tab === 'analyses') loadAnalysesView(id);
    else if (tab === 'settings') renderSettingsTab(id);
    else if (tab === 'konfigurator') renderKonfiguratorTab(id);
  });
});

function switchTab(name) {
  document.querySelector(`.tab-btn[data-tab="${name}"]`)?.click();
}

// ── Inline Settings Tab ────────────────────────────────────────────────────
async function renderSettingsTab(id) {
  const s = S.studies.find(x => String(x.id) === String(id));
  const empty = document.getElementById('settings-empty');
  const wrap  = document.getElementById('settings-form-wrap');
  if (!s) { empty.style.display = ''; wrap.style.display = 'none'; return; }
  empty.style.display = 'none';
  wrap.style.display = '';
  // Builder-mode studies get the new builder view
  if (s.builder_mode === 1) {
    await ensureBuilderRendered(id);
    return;
  }
  // Legacy studies use the existing settings form
  await openStudySettings(id, /* inline= */ true);
}

// ── Platform settings (cog) ───────────────────────────────────────────────
document.getElementById('btn-platform-settings').onclick = () => {
  openPlatformTranslations();
};

// ── Global study picker ────────────────────────────────────────────────────
function setActiveStudy(id) {
  S.activeStudy = id ? String(id) : '';
  S.selectedDashboardStudy = S.activeStudy;
  S.selectedPostsStudy     = S.activeStudy;
  S.selectedExportStudy    = S.activeStudy;
  if (S.activeStudy) localStorage.setItem('lastSelectedStudy', S.activeStudy);

  const study = S.studies.find(s => String(s.id) === S.activeStudy);
  const label = document.getElementById('study-picker-label');
  label.textContent = study ? study.name : t('header.pick_study');
  document.querySelectorAll('#study-picker-list li').forEach(li => {
    li.classList.toggle('selected', li.dataset.id === S.activeStudy);
  });

  // Selecting a study re-enters study-level context → show the tab bar.
  if (study) { const nav = document.querySelector('.tab-nav'); if (nav) nav.style.display = ''; }

  // Load content for currently active tab
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (!S.activeStudy) return;
  if (activeTab === 'dashboard')   loadDashboard(S.activeStudy);
  else if (activeTab === 'posts')  loadPosts(S.activeStudy);
  else if (activeTab === 'demographics') loadDemographicQuestions(S.activeStudy);
  else if (activeTab === 'export') loadExportView(S.activeStudy);
  else if (activeTab === 'analyses') loadAnalysesView(S.activeStudy);
  else if (activeTab === 'settings') renderSettingsTab(S.activeStudy);
  else if (activeTab === 'konfigurator') renderKonfiguratorTab(S.activeStudy);
}

(function initStudyPicker() {
  const btn  = document.getElementById('study-picker-btn');
  const list = document.getElementById('study-picker-list');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = list.classList.toggle('open');
    btn.classList.toggle('open', open);
  });
  document.addEventListener('click', () => {
    list.classList.remove('open');
    btn.classList.remove('open');
  });
  list.addEventListener('click', e => e.stopPropagation());
})();

// ── Aggregate landing dashboard (all studies) ───────────────────────────────
// Post-login landing + clicking the logo. Cross-study summary; picking a study
// (global picker or a row here) drops into that study's own view.
async function renderAggregateDashboard() {
  S.activeStudy = '';
  S.selectedDashboardStudy = '';
  // The tab bar is study-specific — hide it on the aggregate landing.
  const nav = document.querySelector('.tab-nav'); if (nav) nav.style.display = 'none';
  // Stop any per-study auto-refresh timer — otherwise a study's polling reload
  // (setInterval → loadDashboard(DB.studyId)) fires while we're on the aggregate
  // landing and yanks us back into that study's dashboard.
  if (DB.refreshTimer) { clearInterval(DB.refreshTimer); DB.refreshTimer = null; }
  DB.studyId = null;
  const label = document.getElementById('study-picker-label');
  if (label) label.textContent = t('header.pick_study');
  document.querySelectorAll('#study-picker-list li').forEach(li => li.classList.remove('selected'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'dashboard'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-dashboard'));
  const host = document.getElementById('dashboard-content');
  if (!host) return;
  host.innerHTML = '<div class="empty-state">' + t('aggregate.loading') + '</div>';
  const data = await api('GET', '/dashboard/aggregate');
  if (!data) return;
  const card = (val, lbl) => `<div class="stat-card"><div class="stat-value">${val}</div><div class="stat-label">${esc(lbl)}</div></div>`;
  const rows = (data.perStudy || []).map(s => `
    <tr style="cursor:pointer;border-top:1px solid var(--border)" onclick="setActiveStudy(${s.id})" title="${t('aggregate.open_study')}">
      <td style="padding:0.55rem 0.75rem">${esc(s.name)}</td>
      <td style="padding:0.55rem 0.75rem;text-align:right">${s.total}</td>
      <td style="padding:0.55rem 0.75rem;text-align:right">${s.completed}</td>
      <td style="padding:0.55rem 0.75rem;text-align:right">${s.dropout_rate}%</td>
    </tr>`).join('');
  host.innerHTML = `
    <div class="tab-toolbar"><h2>${t('aggregate.all_studies')}</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin-bottom:1.5rem">
      ${card(data.totalStudies, t('aggregate.studies'))}
      ${card(data.completed, t('aggregate.completed_sessions'))}
      ${card(data.total, t('aggregate.all_sessions'))}
      ${card(data.dropout_rate + '%', t('aggregate.dropout'))}
      ${card(data.avg_duration_min != null ? data.avg_duration_min : '—', t('aggregate.avg_duration'))}
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
        <thead><tr style="background:var(--surface2)">
          <th style="text-align:left;padding:0.55rem 0.75rem">${t('aggregate.study')}</th>
          <th style="text-align:right;padding:0.55rem 0.75rem">${t('aggregate.col_all')}</th>
          <th style="text-align:right;padding:0.55rem 0.75rem">${t('aggregate.col_completed')}</th>
          <th style="text-align:right;padding:0.55rem 0.75rem">${t('aggregate.dropout')}</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="empty-state" style="padding:1rem">' + t('aggregate.no_studies') + '</td></tr>'}</tbody>
      </table>
    </div>`;
}
const _brandHome = document.getElementById('brand-home');
if (_brandHome) _brandHome.onclick = renderAggregateDashboard;

// ── Auth ───────────────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const pw = document.getElementById('admin-password').value;
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: pw }),
  });
  const data = await r.json();
  if (r.ok) {
    S.token = data.token;
    localStorage.setItem('admin_token', data.token);
    showAdminPanel();
  } else {
    document.getElementById('login-error').style.display = '';
  }
});

// Role from the JWT payload — for UI gating only; the server enforces access
// independently (requireAdmin), so a tampered client role grants nothing.
function currentRole() {
  try { return JSON.parse(atob(S.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; }
  catch { return null; }
}
function currentUserId() {
  try { return JSON.parse(atob(S.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).userId; }
  catch { return null; }
}

// ── Konta view — admins manage accounts; researchers share their own studies ──
async function renderUsersTab() {
  const isAdmin = currentRole() === 'admin';
  // Toggle the admin-only "+ Nowe konto" action and adapt the heading/intro.
  const addBtn = document.getElementById('btn-add-user');
  if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';
  const title = document.getElementById('users-title');
  const intro = document.getElementById('users-intro');
  if (title) title.textContent = isAdmin ? t('konta.title_accounts') : t('konta.title_sharing');
  if (intro) intro.textContent = isAdmin
    ? t('konta.intro_admin')
    : t('konta.intro_researcher');
  const wrap = document.getElementById('users-list');
  wrap.innerHTML = `<div class="empty-state">${t('konta.loading')}</div>`;
  const users = await api('GET', '/users');
  if (!users) return;
  S.users = users;
  if (!isAdmin) {
    // Researcher view: a login-only roster; the only action is "🔗 Badania",
    // which lists studies THIS researcher owns (openUserStudiesModal filters).
    wrap.innerHTML = users.length ? `
      <table class="data-table" style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:2px solid var(--border)">
          <th style="padding:0.5rem">${t('konta.col_researcher')}</th><th></th>
        </tr></thead>
        <tbody>${users.map(u => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:0.5rem;font-weight:600">${esc(u.username)}</td>
            <td style="text-align:right"><button class="btn btn-ghost btn-sm" title="${t('konta.assign_own_tooltip')}" onclick="openUserStudiesModal(${u.id})">${t('konta.btn_studies')}</button></td>
          </tr>`).join('')}</tbody>
      </table>` : `<div class="empty-state">${t('konta.no_researchers')}</div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="data-table" style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left;border-bottom:2px solid var(--border)">
        <th style="padding:0.5rem">${t('konta.col_login')}</th><th>${t('konta.col_email')}</th><th>${t('konta.role_label')}</th>
        <th title="${t('konta.col_studies_tooltip')}">${t('konta.col_studies')}</th><th>${t('konta.col_status')}</th><th>${t('konta.col_last_login')}</th><th></th>
      </tr></thead>
      <tbody>${users.map(userRowHTML).join('')}</tbody>
    </table>`;
}

function userRowHTML(u) {
  const me = u.id === currentUserId();
  const roleBadge = u.role === 'admin'
    ? `<span class="badge" style="background:#dbeafe;color:#1e40af">${t('konta.role_admin')}</span>`
    : `<span class="badge">${t('konta.role_researcher')}</span>`;
  const statusBadge = u.is_active
    ? `<span class="badge badge-active">${t('konta.status_active')}</span>`
    : `<span class="badge badge-inactive">${t('konta.status_disabled')}</span>`;
  const last = u.last_login ? esc(String(u.last_login).slice(0, 16).replace('T', ' ')) : '—';
  return `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:0.5rem;font-weight:600">${esc(u.username)}${me ? ' <span style="color:var(--muted);font-weight:400">' + t('konta.you') + '</span>' : ''}</td>
      <td style="color:var(--muted)">${esc(u.email || '—')}</td>
      <td>${roleBadge}</td>
      <td style="text-align:center">${u.study_count}</td>
      <td>${statusBadge}</td>
      <td style="color:var(--muted);font-size:0.82rem">${last}</td>
      <td style="text-align:right;white-space:nowrap">
        ${u.role !== 'admin' ? `<button class="btn btn-ghost btn-sm" title="${t('konta.assign_specific_tooltip')}" onclick="openUserStudiesModal(${u.id})">${t('konta.btn_studies')}</button>` : ''}
        <button class="btn btn-ghost btn-sm" title="${t('konta.change_role_tooltip')}" onclick="setUserRole(${u.id}, '${u.role === 'admin' ? 'researcher' : 'admin'}')">${u.role === 'admin' ? t('konta.demote') : t('konta.promote')}</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleUserActive(${u.id}, ${u.is_active ? 0 : 1})">${u.is_active ? t('konta.disable') : t('konta.enable')}</button>
        <button class="btn btn-ghost btn-sm" title="${t('konta.set_password_tooltip')}" onclick="resetUserPassword(${u.id})">${t('konta.btn_password')}</button>
        <button class="btn btn-danger btn-sm" ${me ? 'disabled title="' + t('konta.del_self_disabled') + '"' : ''} onclick="deleteUser(${u.id})">🗑</button>
      </td>
    </tr>`;
}

document.getElementById('btn-add-user')?.addEventListener('click', () => {
  showModal(`
    <div class="modal-section-title">${t('konta.new_account')}</div>
    <div class="form-group"><label>${t('konta.f_login')}</label><input type="text" id="nu-username" placeholder="${t('konta.f_login_ph')}" autocomplete="off"></div>
    <div class="form-group"><label>${t('konta.f_email')}</label><input type="text" id="nu-email" placeholder="researcher@example.org" autocomplete="off"></div>
    <div class="form-group"><label>${t('konta.f_password')} <span style="font-weight:400;color:var(--muted);font-size:0.78rem">${t('konta.f_password_hint')}</span></label><input type="text" id="nu-password" placeholder="${t('konta.f_password_ph')}" autocomplete="off"></div>
    <div class="form-group"><label>${t('konta.role_label')}</label>
      <select id="nu-role"><option value="researcher">${t('konta.opt_researcher')}</option><option value="admin">${t('konta.opt_admin')}</option></select>
    </div>
    <div class="modal-footer" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem">
      <button class="btn btn-ghost" onclick="closeModal()">${t('konta.cancel')}</button>
      <button class="btn btn-primary" onclick="submitNewUser()">${t('konta.create_account')}</button>
    </div>`);
});

async function submitNewUser() {
  const body = {
    username: document.getElementById('nu-username').value.trim(),
    email: document.getElementById('nu-email').value.trim() || null,
    password: document.getElementById('nu-password').value,
    role: document.getElementById('nu-role').value,
  };
  if (!body.username) return toast(t('konta.err_login_required'), 'error');
  if (!body.password || body.password.length < 8) return toast(t('konta.err_password_short'), 'error');
  const res = await api('POST', '/users', body);
  if (!res) return;
  toast(t('konta.account_created'));
  closeModal();
  renderUsersTab();
}

async function setUserRole(id, role) {
  const u = (S.users || []).find(x => x.id === id);
  if (!confirm(t('konta.confirm_role', { name: u ? u.username : id, role: role === 'admin' ? t('konta.role_admin_acc') : t('konta.role_researcher_acc') }))) return;
  const res = await api('PATCH', `/users/${id}`, { role });
  if (!res) return;
  toast(t('konta.role_changed'));
  renderUsersTab();
}

async function toggleUserActive(id, active) {
  const res = await api('PATCH', `/users/${id}`, { is_active: active });
  if (!res) return;
  toast(active ? t('konta.account_enabled') : t('konta.account_disabled'));
  renderUsersTab();
}

async function resetUserPassword(id) {
  const pw = prompt(t('konta.prompt_new_password'));
  if (pw === null) return;
  if (pw.length < 8) return toast(t('konta.err_password_short'), 'error');
  const res = await api('PATCH', `/users/${id}`, { password: pw });
  if (!res) return;
  toast(t('konta.password_changed'));
}

async function deleteUser(id) {
  const u = (S.users || []).find(x => x.id === id);
  const owned = u ? u.study_count : 0;
  const warn = owned > 0
    ? '\n\n' + t('konta.del_warn_owner', { n: owned })
    : '';
  if (!confirm(t('konta.confirm_del', { name: u ? u.username : id }) + warn)) return;
  const res = await api('DELETE', `/users/${id}`);
  if (!res) return;
  toast(res.reassignedStudies ? t('konta.deleted_reassigned', { n: res.reassignedStudies }) : t('konta.deleted'));
  renderUsersTab();
}

// ── Assign a user to studies (Konta → per-user collaboration) ────────────────
async function openUserStudiesModal(userId) {
  const user = (S.users || []).find(u => u.id === userId);
  if (!user) return;
  S.assignUser = user;
  const [studiesRaw, collabs] = await Promise.all([
    api('GET', '/studies'),
    api('GET', `/users/${userId}/collaborations`),
  ]);
  if (!studiesRaw || !collabs) return;
  // Admin may assign any study; a researcher may only grant access to studies
  // they OWN (the server enforces this too — a collaborator can't re-share).
  const myId = currentUserId();
  const studies = currentRole() === 'admin' ? studiesRaw : studiesRaw.filter(s => s.owner_id === myId);
  const collabSet = new Set(collabs.map(String));
  const rows = studies.map(s => {
    const owned = s.owner_id === userId;
    const checked = collabSet.has(String(s.id));
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:0.5rem">${esc(s.name)}</td>
      <td style="text-align:right;white-space:nowrap">${owned
        ? `<span class="badge" style="background:#dbeafe;color:#1e40af">${t('konta.owner')}</span>`
        : `<label style="cursor:pointer;display:inline-flex;align-items:center;gap:0.4rem"><input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleUserStudy(${s.id}, this.checked)"><span style="font-size:0.82rem;color:var(--muted)">${t('konta.access')}</span></label>`}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="2" class="empty-state" style="padding:1rem">${t('konta.no_studies_to_share')}</td></tr>`;
  showModal(`
    <div class="modal-section-title">${t('konta.assign_modal_title')}: ${esc(user.username)}</div>
    <p style="color:var(--muted);font-size:0.85rem;margin:0.25rem 0 1rem">${t('konta.assign_modal_help')}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:1rem">
      <thead><tr style="text-align:left;border-bottom:2px solid var(--border)"><th style="padding:0.5rem">${t('konta.col_study')}</th><th style="text-align:right">${t('konta.col_access')}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="modal-footer" style="display:flex;justify-content:flex-end"><button class="btn btn-ghost" onclick="closeModal()">${t('konta.close')}</button></div>`);
}

async function toggleUserStudy(studyId, checked) {
  const user = S.assignUser;
  if (!user) return;
  const res = checked
    ? await api('POST', `/studies/${studyId}/collaborators`, { username: user.username })
    : await api('DELETE', `/studies/${studyId}/collaborators/${user.id}`);
  if (!res) return openUserStudiesModal(user.id); // request failed → re-sync checkboxes
  toast(checked ? t('konta.assigned') : t('konta.access_revoked'));
}

document.getElementById('logout-btn').onclick = doLogout;
function doLogout() {
  localStorage.removeItem('admin_token');
  S.token = null;
  // Drop the admin-session-mode cookie so the browser stops tagging study
  // sessions as preview after logout
  document.cookie = 'missinfo_admin_mode=; path=/; max-age=0; samesite=lax';
  location.reload();
}

// ── Admin session-mode toggle ──────────────────────────────────────────────
// Cookie controls how /api/session/start treats sessions started from this
// browser tab: 'preview' (default) → is_preview=1 (hidden from dashboard +
// export); 'production' → counts as a real participant. Cookie persists for
// 24h and survives reloads but is cleared on logout.
function getAdminModeCookie() {
  const m = document.cookie.match(/(?:^|;\s*)missinfo_admin_mode=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function setAdminModeCookie(mode) {
  document.cookie = `missinfo_admin_mode=${encodeURIComponent(mode)}; path=/; max-age=${60 * 60 * 24}; samesite=lax`;
}
function initAdminModeToggle() {
  // Default to 'preview' if no cookie yet (i.e. just logged in)
  if (!getAdminModeCookie()) setAdminModeCookie('preview');
  const sel = document.getElementById('admin-mode-select');
  if (!sel) return;
  sel.value = getAdminModeCookie() || 'preview';
  sel.onchange = () => {
    setAdminModeCookie(sel.value);
    const label = sel.value === 'preview'
      ? t('konta.mode_preview_toast')
      : t('konta.mode_production_toast');
    toast(label, sel.value === 'preview' ? 'success' : 'warning');
  };
}

function showAdminPanel() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-panel').style.display = 'block';
  // "Konta" lives in the header (top-level nav). Admins manage accounts here;
  // researchers use it to grant/revoke collaborator access to studies THEY own.
  // Both roles see the button; the server scopes what each may read and change.
  const kontaBtn = document.getElementById('btn-konta');
  if (kontaBtn) {
    kontaBtn.style.display = '';
    kontaBtn.onclick = showKontaView;
  }
  initAdminModeToggle();
  loadAll();
}

// Panel language switcher. Class-based, not id-based, because it appears BOTH
// on the login card and in the header — a self-hoster must be able to switch to
// English before signing in, not only after.
function initLangSwitchers() {
  document.querySelectorAll('.admin-lang-select').forEach(sel => {
    sel.value = S.lang;
    sel.onchange = () => setAdminLang(sel.value);
  });
}

// Accounts view — top-level (not a study tab). Hides the study-specific tab bar.
function showKontaView() {
  S.activeStudy = '';
  const nav = document.querySelector('.tab-nav'); if (nav) nav.style.display = 'none';
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-users'));
  renderUsersTab();
}

// ── Init ───────────────────────────────────────────────────────────────────
async function loadAll() {
  await loadStudies();
  populateStudySelects();
}

// Boot: locales first, so neither the login screen nor the panel can paint a
// stale language. applyStaticI18n() translates admin.html's static markup; the
// JS-rendered views call t() as they render.
// Boot. Locales are already in memory (see S.locales), so nothing to await:
// applyStaticI18n() translates admin.html's static markup, the JS-rendered
// views call t() as they render.
(function boot() {
  applyStaticI18n();
  initLangSwitchers();   // works on the login screen too, not just the header
  if (S.token) showAdminPanel();
})();

// ── Studies ────────────────────────────────────────────────────────────────
async function loadStudies() {
  const data = await api('GET', '/studies');
  if (!data) return;
  S.studies = Array.isArray(data) ? data : [];
  renderStudiesList();
}

function populateStudySelects() {
  // Populate the global picker list
  const list = document.getElementById('study-picker-list');
  list.innerHTML = '';
  S.studies.forEach(s => {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.textContent = `${s.name}${s.is_active ? '' : ` (${t('header.study_inactive')})`}`;
    li.addEventListener('click', () => {
      setActiveStudy(s.id);
      list.classList.remove('open');
      document.getElementById('study-picker-btn').classList.remove('open');
    });
    list.appendChild(li);
  });

  // Also keep hidden legacy selects in sync (some JS paths still use them)
  ['dashboard-study-select', 'posts-study-select', 'export-study-select'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">—</option>';
    S.studies.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  });

  // Landing = cross-study aggregate dashboard (logo click returns here). A study
  // becomes active only when the researcher picks one from the global picker or
  // clicks a row in the aggregate table.
  renderAggregateDashboard();
}

function renderStudiesList() {
  const container = document.getElementById('studies-list');
  if (!container) return; // element removed in current layout
  if (!S.studies.length) {
    container.innerHTML = `<div class="empty-state">${t('studies.empty')}</div>`;
    return;
  }
  container.innerHTML = S.studies.map(s => `
    <div class="study-row" data-study-id="${s.id}">
      <div class="study-row-info">
        <div class="study-name">${esc(s.name)}</div>
        <div class="study-meta">
          <span class="study-slug">/study/${esc(s.slug)}</span>
          · ${t('studies.completed')} <strong>${s.completed_count || 0}</strong>
          · ${s.created_at ? s.created_at.slice(0,10) : ''}
        </div>
      </div>
      <div class="study-actions">
        <span class="badge ${s.is_active ? 'badge-active' : 'badge-inactive'}">${s.is_active ? t('studies.badge_active') : t('studies.badge_inactive')}</span>
        ${s.clarity_enabled && s.clarity_project_id
          ? `<span class="badge badge-active" style="background:#dcfce7;color:#15803d;font-size:0.68rem">Clarity</span>`
          : ''
        }
        ${s.eyetracking_enabled
          ? `<span class="badge badge-active" style="background:#ede9fe;color:#6d28d9;font-size:0.68rem">👁 ET</span>`
          : ''
        }
        ${s.builder_mode === 1 ? '<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:0.68rem">Builder</span>' : ''}
        <button class="btn btn-ghost btn-sm" onclick="toggleStudyActive(${s.id}, ${s.is_active})">${s.is_active ? t('studies.deactivate') : t('studies.activate')}</button>
        <button class="btn btn-ghost btn-sm" onclick="${s.builder_mode === 1 ? `selectStudy(${s.id});switchTab('settings')` : `openStudySettings(${s.id})`}">${t('studies.settings')}</button>
        <button class="btn btn-ghost btn-sm" onclick="goToPostEditor(${s.id})">${t('studies.post_editor')}</button>
        <button class="btn btn-ghost btn-sm" onclick="duplicateStudy(${s.id})">${t('studies.duplicate')}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteStudy(${s.id}, '${esc(s.name)}')">${t('studies.delete')}</button>
      </div>
    </div>
  `).join('');
}

async function toggleStudyActive(id, current) {
  await api('PATCH', `/studies/${id}`, { is_active: current ? 0 : 1 });
  toast(t('studies.status_updated'));
  await loadStudies();
  populateStudySelects();
}

// Create study — opens builder directly
document.getElementById('btn-create-study').onclick = () => createBuilderStudy();

async function createBuilderStudy() {
  const data = await api('POST', '/studies/builder');
  if (!data) return;
  await loadStudies();
  populateStudySelects();
  setActiveStudy(data.id);
  switchTab('settings');
}

async function createStudy() {
  const body = {
    name: document.getElementById('new-name').value.trim(),
    slug: document.getElementById('new-slug').value.trim(),
    description: document.getElementById('new-desc').value.trim(),
    institution: document.getElementById('new-inst').value.trim(),
    contact_email: document.getElementById('new-email').value.trim(),
  };
  if (!body.name) return toast(t('studies.name_required'), 'error');
  const data = await api('POST', '/studies', body);
  if (!data) return;
  closeModal();
  toast(t('studies.created'));
  await loadStudies();
  populateStudySelects();
  openStudySettings(data.id);
}

async function duplicateStudy(id) {
  if (!confirm(t('studies.duplicate_confirm'))) return;
  const data = await api('POST', `/studies/${id}/duplicate`);
  if (!data) return;
  toast(t('studies.duplicated', { name: data.name }));
  await loadStudies();
  populateStudySelects();
}

async function deleteStudy(id, name) {
  if (!confirm(t('studies.delete_confirm', { name }))) return;
  await api('DELETE', `/studies/${id}`, { confirm: 'DELETE' });
  toast(t('studies.deleted'));
  await loadStudies();
  populateStudySelects();
}

// ── Metric condition row helpers ───────────────────────────────────────────
function metricConditionRowHTML(cond) {
  return `
    <div class="metric-condition-row" data-key="${esc(String(cond.key))}">
      <label class="toggle"><input type="checkbox" class="mc-enabled" ${cond.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
      <input type="text" class="mc-label" value="${esc(cond.label)}" placeholder="${t('settings.cond_name_ph')}" style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0">
        <span style="font-size:0.75rem;color:var(--muted)">min</span>
        <input type="number" class="mc-min" value="${cond.min ?? 0}" placeholder="0" style="width:5rem">
        <span style="font-size:0.75rem;color:var(--muted)">max</span>
        <input type="number" class="mc-max" value="${cond.max ?? 0}" placeholder="0" style="width:5rem">
        <span style="font-size:0.72rem;color:var(--muted)">${t('settings.zero_use_base')}</span>
      </div>
      <label style="display:flex;align-items:center;gap:0.3rem;flex-shrink:0;cursor:pointer" title="${t('settings.show_debunk_title')}">
        <input type="checkbox" class="mc-show-comment" ${cond.show_comment ? 'checked' : ''} style="accent-color:var(--accent);width:14px;height:14px">
        <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap">${t('settings.comment_toggle')}</span>
      </label>
      <button type="button" class="btn btn-ghost btn-sm mc-remove" onclick="removeMetricCondition(this)">✕</button>
    </div>`;
}

function addMetricCondition() {
  const container = document.getElementById('es-metric-conditions');
  const key = 'C' + Date.now();
  const div = document.createElement('div');
  div.className = 'metric-condition-row';
  div.dataset.key = key;
  div.innerHTML = `
    <label class="toggle"><input type="checkbox" class="mc-enabled" checked><span class="toggle-slider"></span></label>
    <input type="text" class="mc-label" value="${t('settings.new_condition')}" placeholder="${t('settings.cond_name_ph')}" style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0">
      <span style="font-size:0.75rem;color:var(--muted)">min</span>
      <input type="number" class="mc-min" value="0" placeholder="0" style="width:5rem">
      <span style="font-size:0.75rem;color:var(--muted)">max</span>
      <input type="number" class="mc-max" value="0" placeholder="0" style="width:5rem">
      <span style="font-size:0.72rem;color:var(--muted)">${t('settings.zero_use_base')}</span>
    </div>
    <label style="display:flex;align-items:center;gap:0.3rem;flex-shrink:0;cursor:pointer" title="${t('settings.show_debunk_title')}">
      <input type="checkbox" class="mc-show-comment" style="accent-color:var(--accent);width:14px;height:14px">
      <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap">${t('settings.comment_toggle')}</span>
    </label>
    <button type="button" class="btn btn-ghost btn-sm mc-remove" onclick="removeMetricCondition(this)">✕</button>
  `;
  container.appendChild(div);
  updateMetricRemoveButtons();
}

function removeMetricCondition(btn) {
  btn.closest('.metric-condition-row').remove();
  updateMetricRemoveButtons();
}

function updateMetricRemoveButtons() {
  const rows = document.querySelectorAll('#es-metric-conditions .metric-condition-row');
  rows.forEach(row => {
    row.querySelector('.mc-remove').disabled = rows.length <= 1;
  });
}

// Returns a map of full_condition key → human-readable label for any study object
function buildCondLabelMap(study) {
  const styleConds = [
    { key: 'A', label: study?.label_style_a || t('settings.style_a') },
    { key: 'B', label: study?.label_style_b || t('settings.style_b') },
  ].filter((_, i) => i === 0 ? study?.enable_condition_a : study?.enable_condition_b);

  let metricConds = [];
  try { metricConds = JSON.parse(study?.metric_conditions_json || '[]'); } catch {}
  if (!metricConds.length) {
    if (study?.enable_metrics_high) metricConds.push({ key: 'HIGH', label: 'HIGH', enabled: true });
    if (study?.enable_metrics_low)  metricConds.push({ key: 'LOW',  label: 'LOW',  enabled: true });
  }
  metricConds = metricConds.filter(c => c.enabled);

  const map = {};
  styleConds.forEach(sc => metricConds.forEach(mc => {
    map[`${sc.key}-${mc.key}`] = {
      label: `${sc.label} / ${mc.label}`,
      short: `${sc.key} / ${mc.label}`,
    };
  }));
  return map;
}

// Study settings modal
async function openStudySettings(id, inline = false) {
  const s = S.studies.find(x => x.id == id);
  if (!s) return;

  // Parse metric conditions (fallback to legacy HIGH/LOW columns)
  let mcArr;
  try { mcArr = s.metric_conditions_json ? JSON.parse(s.metric_conditions_json) : null; } catch {}
  if (!mcArr) {
    mcArr = [
      { key: 'HIGH', label: t('settings.with_comment'),    min: s.high_metrics_min || 100, max: s.high_metrics_max || 500, enabled: s.enable_metrics_high ? true : false, show_comment: true },
      { key: 'LOW',  label: t('settings.without_comment'),   min: s.low_metrics_min  || 100, max: s.low_metrics_max  || 500, enabled: s.enable_metrics_low  ? true : false, show_comment: false },
    ];
  }
  const mcHTML = mcArr.map(c => metricConditionRowHTML(c)).join('');

  const studyActionsRow = inline ? `
    <div class="settings-study-actions">
      <span class="settings-study-name">${esc(s.name)}</span>
      <div style="display:flex;gap:0.5rem;margin-left:auto">
        <button class="btn btn-ghost btn-sm" onclick="toggleStudyActive(${s.id}, ${s.is_active})">${s.is_active ? t('settings.deactivate') : t('settings.activate')}</button>
        <button class="btn btn-ghost btn-sm" onclick="duplicateStudy(${s.id})">${t('settings.duplicate')}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteStudy(${s.id}, '${esc(s.name)}')">${t('settings.delete')}</button>
      </div>
    </div>` : '';

  const footer = inline
    ? `<div class="study-action-bar">
         <div class="study-action-bar-inner">
           <button class="btn btn-primary" onclick="saveStudySettings(${id})">${t('settings.save_settings')}</button>
         </div>
       </div>`
    : `<div class="modal-footer">
         <button class="btn btn-primary" onclick="saveStudySettings(${id})">${t('settings.save')}</button>
         <button class="btn btn-ghost" onclick="closeModal()">${t('settings.cancel')}</button>
       </div>`;

  const html = `${studyActionsRow}
    <h2${inline ? ' style="display:none"' : ''}>${t('settings.title')}</h2>
    <div class="modal-section-title">${t('settings.basic_info')}</div>
    <div class="form-group"><label>${t('settings.name_admin')}</label><input type="text" id="es-name" value="${esc(s.name)}"></div>
    <div class="form-group">
      <label>${t('settings.participant_title')}</label>
      <input type="text" id="es-participant-title" value="${esc(s.participant_title || '')}" placeholder="${t('settings.participant_title_ph')}">
      <p class="hint-text">${t('settings.participant_title_hint')}</p>
    </div>
    <div class="form-group"><label>${t('settings.slug')}</label><input type="text" id="es-slug" value="${esc(s.slug)}"></div>
    <div class="form-group"><label>${t('settings.description')}</label><textarea id="es-desc" rows="2">${esc(s.description || '')}</textarea></div>
    <div class="form-group"><label>${t('settings.institution')} <span style="font-weight:400;text-transform:none">${t('settings.institution_hint')}</span></label><input type="text" id="es-inst" value="${esc(s.institution || '')}"></div>
    <div class="form-group"><label>${t('settings.contact_email')}</label><input type="email" id="es-email" value="${esc(s.contact_email || '')}"></div>`;

  if (inline) {
    document.getElementById('settings-form-wrap').innerHTML = html +
      buildStudySettingsBody(s, mcHTML) + footer;
    initStudySettingsListeners(s);
  } else {
    showModal(html + buildStudySettingsBody(s, mcHTML) + footer);
    initStudySettingsListeners(s);
  }
}

function buildStudySettingsBody(s, mcHTML) {
  return `
    <div class="form-group">
      <label>${t('settings.language')}</label>
      <select id="es-language">
        <option value="pl" ${(s.language || 'pl') === 'pl' ? 'selected' : ''}>🇵🇱 Polski</option>
        <option value="en" ${s.language === 'en' ? 'selected' : ''}>🇬🇧 English</option>
        <option value="cs" ${s.language === 'cs' ? 'selected' : ''}>🇨🇿 Čeština</option>
        <option value="sk" ${s.language === 'sk' ? 'selected' : ''}>🇸🇰 Slovenčina</option>
      </select>
    </div>
    <div id="es-translate-section" style="${(s.language || 'pl') !== 'pl' ? '' : 'display:none'}">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;padding:0.75rem;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
        <span style="font-size:0.85rem;color:var(--muted)">${t('settings.translated_q')}</span>
        <span id="es-translate-status" style="font-size:0.8rem"></span>
        <button type="button" class="btn btn-primary btn-sm" style="margin-left:auto" onclick="translateStudyContent(${s.id})">
          ${t('settings.translate_auto')}
        </button>
      </div>
    </div>

    <div class="modal-section-title">${t('settings.layout_type')}</div>
    <div class="form-group">
      <label>${t('settings.layout_label')}</label>
      <select id="es-layout">
        <option value="feed" ${(s.layout_type || 'feed') === 'feed' ? 'selected' : ''}>${t('settings.layout_feed')}</option>
        <option value="custom" ${(s.layout_type === 'custom' || s.layout_type === 'paged') ? 'selected' : ''}>${t('settings.layout_pager')}</option>
      </select>
    </div>

    <!-- Paged-only options -->
    <div id="es-paged-options" style="${s.layout_type === 'paged' ? '' : 'display:none'}">
      <div class="toggle-row" style="margin-bottom:1rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-reactions" ${s.show_reactions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('settings.show_reactions')}</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-comments" ${s.enable_comments ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('settings.enable_comments')}</span>
        </div>
      </div>
    </div>

    <!-- Custom Builder options -->
    <div id="es-custom-options" style="${s.layout_type === 'custom' ? '' : 'display:none'}">
      <div class="toggle-row" style="margin-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-custom-reactions" ${s.show_reactions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('settings.reactions_custom')}</span>
        </div>
      </div>
      <div id="es-custom-reaction-labels" style="margin-bottom:0.75rem;${s.show_reactions !== 0 ? '' : 'display:none'}">
        <div class="form-grid form-grid-4">
          <div class="form-group"><label>${t('settings.lbl_like')}</label><input type="text" id="es-lbl-like" value="${esc(s.label_action_like || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
          <div class="form-group"><label>${t('settings.lbl_dislike')}</label><input type="text" id="es-lbl-dislike" value="${esc(s.label_action_dislike || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
          <div class="form-group"><label>${t('settings.lbl_share')}</label><input type="text" id="es-lbl-share" value="${esc(s.label_action_share || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
          <div class="form-group"><label>${t('settings.lbl_flag')}</label><input type="text" id="es-lbl-flag" value="${esc(s.label_action_flag || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
        </div>
      </div>

      <div class="modal-section-title" style="margin-top:0.25rem;margin-bottom:0.5rem">${t('settings.likert_section')}</div>
      <div class="form-group"><label>${t('settings.likert_question')}</label><input type="text" id="es-lbl-likert-q" value="${esc(s.label_likert_question || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:0.75rem">
        <div class="form-group"><label>${t('settings.likert_min')}</label><input type="text" id="es-lbl-likert-min" value="${esc(s.label_likert_min || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
        <div class="form-group"><label>${t('settings.likert_max')}</label><input type="text" id="es-lbl-likert-max" value="${esc(s.label_likert_max || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
      </div>

      <div class="toggle-row" style="margin-top:0.25rem;margin-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-custom-comments" ${s.enable_comments ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('settings.comment_field')}</span>
        </div>
      </div>
      <div id="es-custom-comment-wrap" style="${s.enable_comments ? '' : 'display:none'}">
        <div class="form-group"><label>${t('settings.comment_ph_label')}</label><input type="text" id="es-lbl-comment-ph" value="${esc(s.comment_placeholder || '')}" placeholder="${t('settings.from_locale_ph')}"></div>
      </div>
    </div>

    <div class="modal-section-title">${t('settings.experimental')}</div>
    <div class="form-group"><label>${t('settings.posts_per_session')}</label><input type="number" id="es-pps" min="1" max="20" value="${s.posts_per_session}"></div>

    <div class="modal-section-title" style="margin-top:1.25rem">${t('settings.style_conditions')}</div>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">${t('settings.style_conditions_hint')}</p>
    <div style="display:flex;flex-direction:column;gap:0.6rem;margin-bottom:1.25rem">
      <div class="condition-row">
        <label class="toggle"><input type="checkbox" id="es-ca" ${s.enable_condition_a ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <input type="text" id="es-label-a" class="condition-label-input" value="${esc(s.label_style_a || t('settings.style_a_default'))}" placeholder="${t('settings.cond_a_name_ph')}">
        <span class="condition-hint">${t('settings.content_a')}</span>
      </div>
      <div class="condition-row">
        <label class="toggle"><input type="checkbox" id="es-cb" ${s.enable_condition_b ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <input type="text" id="es-label-b" class="condition-label-input" value="${esc(s.label_style_b || t('settings.style_b_default'))}" placeholder="${t('settings.cond_b_name_ph')}">
        <span class="condition-hint">${t('settings.content_b')}</span>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">
      <div class="modal-section-title" style="margin:0">${t('settings.exp_conditions')}</div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="addMetricCondition()" style="margin-left:auto">${t('settings.add_condition')}</button>
    </div>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">${t('settings.exp_conditions_hint')}</p>
    <div id="es-metric-conditions" style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:0.75rem">
      ${mcHTML}
    </div>

    <div class="toggle-row" style="margin-bottom:1rem">
      <div class="toggle-wrap" style="flex:1">
        <label class="toggle"><input type="checkbox" id="es-show-metrics" ${s.show_metrics !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('settings.show_metrics')}</span>
      </div>
      <div class="toggle-wrap">
        <label class="toggle"><input type="checkbox" id="es-htb" ${s.hide_topic_badges ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('settings.hide_topic_badges')}</span>
      </div>
    </div>

    <div class="modal-section-title">${t('settings.screen1')}</div>
    <div class="form-group"><label>${t('settings.consent_text')}</label><textarea id="es-consent" rows="5">${esc(s.consent_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>${t('settings.screen2')}</span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-instr" ${s.show_instructions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('settings.show_screen')}</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-instr-wrap"><label>${t('settings.instruction_text')}</label><textarea id="es-instr" rows="5">${esc(s.instruction_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>${t('settings.screen4')}</span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-tf" ${s.show_transition_feed !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('settings.show_screen')}</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-tf-wrap"><label>${t('settings.transition_text')}</label><textarea id="es-tf" rows="4">${esc(s.transition_feed_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>${t('settings.screen6')} <span style="font-size:0.75rem;color:var(--muted)">${t('settings.feed_mode_only')}</span></span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-tr" ${s.show_transition_rating !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('settings.show_screen')}</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-tr-wrap"><label>${t('settings.transition_text')}</label><textarea id="es-tr" rows="4">${esc(s.transition_rating_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>${t('settings.screen8')}</span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-debrief" ${s.show_debrief !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('settings.show_screen')}</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-debrief-wrap"><label>${t('settings.debrief_text')}</label><textarea id="es-debrief" rows="5">${esc(s.debrief_text || '')}</textarea></div>

    <div class="modal-section-title">${t('settings.analytics')}</div>
    <div class="toggle-row" style="margin-bottom:0.75rem">
      <div class="toggle-wrap">
        <label class="toggle">
          <input type="checkbox" id="es-clarity-enabled" ${s.clarity_enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">${t('settings.clarity_enable')}</span>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:0.5rem">
      <label>Clarity Project ID</label>
      <input type="text" id="es-clarity-pid" value="${esc(s.clarity_project_id || '')}"
             placeholder="${t('settings.clarity_pid_ph')}" maxlength="40">
      <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
        ${t('settings.clarity_pid_hint')}
        ${t('settings.clarity_pid_hint2')}
      </div>
    </div>
    <div id="es-clarity-status" style="font-size:0.8rem;margin-bottom:0.5rem"></div>

    <div class="modal-section-title" style="margin-top:1.5rem">${t('settings.eyetracking')}</div>
    <div class="toggle-row" style="margin-bottom:0.75rem">
      <div class="toggle-wrap">
        <label class="toggle">
          <input type="checkbox" id="es-et-enabled" ${s.eyetracking_enabled ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label">${t('settings.eyetracking_enable')}</span>
      </div>
    </div>
    <div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.75rem;line-height:1.5">
      ${t('settings.eyetracking_hint1')}
      ${t('settings.eyetracking_hint2')}
      ${t('settings.eyetracking_hint3')}
    </div>

    <div class="modal-section-title" style="margin-top:1.5rem">${t('settings.panel_integration')}</div>
    <div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.75rem;line-height:1.5">
      ${t('settings.panel_hint1')}
      ${t('settings.panel_hint2')}
    </div>
    <div class="form-group" style="margin-bottom:0.75rem">
      <label>${t('settings.ext_param_label')}</label>
      <input type="text" id="es-ext-param" value="${esc(s.external_id_param_name || 'res_id')}"
             placeholder="res_id" maxlength="64">
      <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
        Agencja dodaje do linka coś w stylu <code>?res_id=ABC123</code>. Wartość zostanie zapisana
        w kolumnie <code>external_id</code> w eksporcie. Domyślnie: <code>res_id</code>.
      </div>
    </div>
    <div class="form-group" style="margin-bottom:0.5rem">
      <label>${t('settings.completion_url_label')}</label>
      <input type="url" id="es-completion-url" value="${esc(s.completion_redirect_url || '')}"
             placeholder="https://panel.example.org/complete?token={ext_id}">
      <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
        Po ukończeniu badania uczestnik zostanie przekierowany pod ten URL (po ~4 s, żeby zdążył
        zobaczyć podziękowanie). Wesprzeć placeholdery: <code>{ext_id}</code> (ID z parametru URL)
        i <code>{session_id}</code> (nasz token sesji). Puste = bez przekierowania.
      </div>
    </div>

  `; // end buildStudySettingsBody
}

function initStudySettingsListeners(s) {
  document.getElementById('es-layout').addEventListener('change', e => {
    document.getElementById('es-paged-options').style.display = e.target.value === 'paged' ? '' : 'none';
    document.getElementById('es-custom-options').style.display = e.target.value === 'custom' ? '' : 'none';
  });

  const langSelect = document.getElementById('es-language');
  const translateSection = document.getElementById('es-translate-section');
  if (langSelect && translateSection) {
    langSelect.addEventListener('change', () => {
      translateSection.style.display = langSelect.value !== 'pl' ? '' : 'none';
      updateTranslateStatus(s);
    });
  }
  updateTranslateStatus(s);

  function updateClarityStatus() {
    const enabled = document.getElementById('es-clarity-enabled').checked;
    const pid = document.getElementById('es-clarity-pid').value.trim();
    const el = document.getElementById('es-clarity-status');
    if (!enabled) {
      el.innerHTML = `<span style="color:var(--muted)">● ${t('settings.clarity_off')}</span>`;
    } else if (pid) {
      el.innerHTML = `<span style="color:var(--success)">● ${t('settings.clarity_on', { pid: esc(pid) })}</span>`;
    } else {
      el.innerHTML = `<span style="color:#ca8a04">● ${t('settings.clarity_no_pid')}</span>`;
    }
  }
  updateClarityStatus();
  document.getElementById('es-clarity-enabled').addEventListener('change', updateClarityStatus);
  document.getElementById('es-clarity-pid').addEventListener('input', updateClarityStatus);

  updateMetricRemoveButtons();

  const customReactCb = document.getElementById('es-custom-reactions');
  const customReactLabels = document.getElementById('es-custom-reaction-labels');
  if (customReactCb && customReactLabels) {
    customReactCb.addEventListener('change', () => {
      customReactLabels.style.display = customReactCb.checked ? '' : 'none';
    });
  }
  const customCommentCb = document.getElementById('es-custom-comments');
  const customCommentWrap = document.getElementById('es-custom-comment-wrap');
  if (customCommentCb && customCommentWrap) {
    customCommentCb.addEventListener('change', () => {
      customCommentWrap.style.display = customCommentCb.checked ? '' : 'none';
    });
  }

  [
    { cb: 'es-show-instr',   wrap: 'es-instr-wrap' },
    { cb: 'es-show-tf',      wrap: 'es-tf-wrap' },
    { cb: 'es-show-tr',      wrap: 'es-tr-wrap' },
    { cb: 'es-show-debrief', wrap: 'es-debrief-wrap' },
  ].forEach(({ cb, wrap }) => {
    const cbEl = document.getElementById(cb);
    const wrapEl = document.getElementById(wrap);
    if (!cbEl || !wrapEl) return;
    wrapEl.style.opacity = cbEl.checked ? '1' : '0.4';
    wrapEl.style.pointerEvents = cbEl.checked ? '' : 'none';
    cbEl.addEventListener('change', () => {
      wrapEl.style.opacity = cbEl.checked ? '1' : '0.4';
      wrapEl.style.pointerEvents = cbEl.checked ? '' : 'none';
    });
  });
}

async function saveStudySettings(id) {
  // Collect metric conditions from DOM
  const metricRows = document.querySelectorAll('#es-metric-conditions .metric-condition-row');
  const metric_conditions_json = JSON.stringify(Array.from(metricRows).map(row => ({
    key: row.dataset.key || ('K' + Date.now()),
    label: row.querySelector('.mc-label').value.trim() || t('settings.condition_fallback'),
    min: Number(row.querySelector('.mc-min').value) || 0,
    max: Number(row.querySelector('.mc-max').value) || 0,
    enabled: row.querySelector('.mc-enabled').checked,
    show_comment: row.querySelector('.mc-show-comment').checked,
  })));

  const layoutVal = document.getElementById('es-layout').value;
  const isPaged  = layoutVal === 'paged';
  const isCustom = layoutVal === 'custom';

  let show_reactions = 1;
  if (isPaged)  show_reactions = document.getElementById('es-reactions').checked ? 1 : 0;
  if (isCustom) show_reactions = document.getElementById('es-custom-reactions').checked ? 1 : 0;

  let enable_comments = 0;
  if (isPaged)  enable_comments = document.getElementById('es-comments').checked ? 1 : 0;
  if (isCustom) enable_comments = document.getElementById('es-custom-comments').checked ? 1 : 0;

  const body = {
    name: document.getElementById('es-name').value.trim(),
    participant_title: document.getElementById('es-participant-title')?.value.trim() || null,
    slug: document.getElementById('es-slug').value.trim(),
    description: document.getElementById('es-desc').value.trim(),
    institution: document.getElementById('es-inst').value.trim(),
    contact_email: document.getElementById('es-email').value.trim(),
    language: document.getElementById('es-language')?.value || 'pl',
    posts_per_session: Number(document.getElementById('es-pps').value),
    enable_condition_a: document.getElementById('es-ca').checked ? 1 : 0,
    enable_condition_b: document.getElementById('es-cb').checked ? 1 : 0,
    label_style_a: document.getElementById('es-label-a').value.trim() || t('settings.style_a'),
    label_style_b: document.getElementById('es-label-b').value.trim() || t('settings.style_b'),
    metric_conditions_json,
    show_metrics: document.getElementById('es-show-metrics').checked ? 1 : 0,
    hide_topic_badges: document.getElementById('es-htb').checked ? 1 : 0,
    layout_type: layoutVal,
    show_reactions,
    enable_comments,
    consent_text: document.getElementById('es-consent').value.trim() || null,
    show_instructions: document.getElementById('es-show-instr').checked ? 1 : 0,
    instruction_text: document.getElementById('es-instr').value.trim() || null,
    show_transition_feed: document.getElementById('es-show-tf').checked ? 1 : 0,
    transition_feed_text: document.getElementById('es-tf').value.trim() || null,
    show_transition_rating: document.getElementById('es-show-tr').checked ? 1 : 0,
    transition_rating_text: document.getElementById('es-tr').value.trim() || null,
    show_debrief: document.getElementById('es-show-debrief').checked ? 1 : 0,
    debrief_text: document.getElementById('es-debrief').value.trim() || null,
    clarity_enabled: document.getElementById('es-clarity-enabled').checked ? 1 : 0,
    clarity_project_id: document.getElementById('es-clarity-pid').value.trim() || null,
    eyetracking_enabled: document.getElementById('es-et-enabled').checked ? 1 : 0,
    // Panel-recruitment fields. Empty inputs → defaults handled server-side
    // (res_id for param name, NULL for endlink = no redirect).
    external_id_param_name: document.getElementById('es-ext-param')?.value.trim() || 'res_id',
    completion_redirect_url: document.getElementById('es-completion-url')?.value.trim() || null,
  };

  // Custom builder — collect editable label fields. Empty input → null so
  // the server stores NULL (which trClean treats as "researcher did not
  // customise" → the participant falls through to the locale value).
  // Zero hardcoded Polish here — locale file is the single source of truth.
  if (isCustom) {
    const trim = (id) => (document.getElementById(id)?.value.trim() || null);
    body.label_action_like     = trim('es-lbl-like');
    body.label_action_dislike  = trim('es-lbl-dislike');
    body.label_action_share    = trim('es-lbl-share');
    body.label_action_flag     = trim('es-lbl-flag');
    body.label_likert_question = trim('es-lbl-likert-q');
    body.label_likert_min      = trim('es-lbl-likert-min');
    body.label_likert_max      = trim('es-lbl-likert-max');
    body.comment_placeholder   = trim('es-lbl-comment-ph');
  }

  await api('PATCH', `/studies/${id}`, body);
  closeModal();
  toast(t('settings.saved'));
  await loadStudies();
  populateStudySelects();
}

// ── Study Builder ──────────────────────────────────────────────────────────────

let _builderSaveTimer = null;

async function renderBuilderView(studyId) {
  const s = S.studies.find(x => x.id == studyId);
  if (!s) return;

  const lang = s.language || 'pl';
  let trans = {};
  try { trans = JSON.parse(s.translations_json || '{}'); } catch {}
  const hasTranslation = lang !== 'pl' && !!trans[lang];
  // Overlay: when language ≠ pl, show translated text for the translatable fields
  // (the base columns stay in PL). Falls back to base value if translation missing.
  const tloc = (hasTranslation ? trans[lang] : {}) || {};
  const v = {
    consent_text:           tloc.consent_text           ?? s.consent_text,
    no_consent_text:        tloc.no_consent_text        ?? s.no_consent_text,
    instruction_text:       tloc.instruction_text       ?? s.instruction_text,
    debrief_text:           tloc.debrief_text           ?? s.debrief_text,
    transition_feed_text:   tloc.transition_feed_text   ?? s.transition_feed_text,
    transition_rating_text: tloc.transition_rating_text ?? s.transition_rating_text,
    participant_title:      tloc.participant_title      ?? s.participant_title,
  };
  let parts = [];
  try { parts = JSON.parse(s.parts_json || '[]'); } catch {}
  if (!parts.length) parts.push({ id: 'part-0', label: t('konfig.part_default_label', { n: 1 }), layout: s.layout_type || 'feed' });
  let manipulations = [];
  try { manipulations = JSON.parse(s.manipulation_json || '[]'); } catch {}
  if (!manipulations.length) manipulations = [];
  let metricConds = [];
  try { metricConds = JSON.parse(s.metric_conditions_json || '[]'); } catch {}
  const allQuestionsForParts = await api('GET', `/studies/${studyId}/post-questions`) || [];
  const questionsByPart = {};
  allQuestionsForParts.forEach(q => {
    const pid = q.part_id || parts[0]?.id || 'part-0';
    if (!questionsByPart[pid]) questionsByPart[pid] = [];
    questionsByPart[pid].push(q);
  });

  // Conditional-logic builder state: rules + the reference lists (parts,
  // questions, demographic fields) the rule editor needs for its dropdowns.
  const demoQsForLogic = await api('GET', `/studies/${studyId}/demographic-questions`) || [];
  let logicRules = [];
  try { const lj = JSON.parse(s.logic_json || 'null'); if (lj && Array.isArray(lj.rules)) logicRules = lj.rules; } catch {}
  S.builderLogic = { studyId, rules: logicRules, parts, questions: allQuestionsForParts, demoQs: demoQsForLogic };

  const html = `<div id="builder-view" data-study-id="${studyId}">

    <div class="builder-header">
      <input id="bld-name" class="builder-name-input" type="text" value="${esc(s.name)}" placeholder="${t('konfig.study_name_ph')}">
      <select id="bld-lang" title="${t('konfig.language')}" onchange="builderUpdateTranslateUI(${studyId})" style="width:auto;flex:0 0 auto;min-width:110px">
        <option value="pl" ${lang==='pl'?'selected':''}>🇵🇱 PL</option>
        <option value="en" ${lang==='en'?'selected':''}>🇬🇧 EN</option>
        <option value="cs" ${lang==='cs'?'selected':''}>🇨🇿 CS</option>
        <option value="sk" ${lang==='sk'?'selected':''}>🇸🇰 SK</option>
      </select>
      <span id="bld-translate-status" style="font-size:0.78rem;color:var(--muted);display:${lang==='pl'?'none':'inline-flex'};align-items:center;white-space:nowrap">
        ${hasTranslation ? '<span style="color:var(--success)">' + t('konfig.translated') + '</span>' : '<span style="color:var(--warning,#c97a00)">' + t('konfig.no_translation') + '</span>'}
      </span>
      <button id="bld-translate-btn" type="button" class="btn btn-primary btn-sm" style="display:${lang==='pl'?'none':'inline-flex'}" onclick="builderTranslate(${studyId})">
        ✨ ${hasTranslation ? t('konfig.translate_again') : t('konfig.translate_auto')}
      </button>
    </div>
    <div class="builder-header-actions">
      <button class="btn btn-ghost btn-sm" onclick="builderPreview(${studyId})">${t('konfig.preview')}</button>
      <button class="btn btn-ghost btn-sm" onclick="toggleStudyActive(${studyId}, ${s.is_active})">${s.is_active ? t('konfig.deactivate') : t('konfig.activate')}</button>
      <button class="btn btn-ghost btn-sm" onclick="duplicateStudy(${studyId})">${t('konfig.duplicate')}</button>
      <button class="btn btn-danger btn-sm" onclick="deleteStudy(${studyId}, '${esc(s.name)}')">${t('konfig.delete')}</button>
    </div>
    <p id="bld-save-status" class="bld-save-status" style="font-size:0.75rem;color:var(--muted);margin:0.25rem 0 1.25rem">${t('konfig.autosave_note')}</p>

    <div class="builder-section">
      <div class="builder-section-title">${t('konfig.basic_info')}</div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label>${t('konfig.slug_label')}</label>
          <input type="text" id="bld-slug" value="${esc(s.slug)}">
        </div>
        <div class="form-group">
          <label>${t('konfig.participant_title_label')}</label>
          <input type="text" id="bld-participant-title" value="${esc(v.participant_title||'')}" placeholder="${t('konfig.participant_title_ph')}">
        </div>
      </div>
      <div class="form-group">
        <label>${t('konfig.desc_label')}</label>
        <textarea id="bld-desc" rows="2">${esc(s.description||'')}</textarea>
      </div>
    </div>

    <div class="builder-section" data-konfig="1">
      <div class="builder-section-title">${t('konfig.screens_title')}</div>
      <p style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem">${t('konfig.screens_help')}</p>

      <div class="screen-card">
        <div class="screen-card-header"><span>${t('konfig.consent_screen')}</span><span class="screen-badge">${t('konfig.always')}</span></div>
        <textarea id="bld-consent" rows="5" placeholder="${t('konfig.consent_ph')}">${esc(v.consent_text||'')}</textarea>
      </div>

      <div class="screen-card">
        <div class="screen-card-header"><span>${t('konfig.no_consent_screen')}</span><span class="screen-badge">${t('konfig.always')}</span></div>
        <textarea id="bld-no-consent" rows="2" placeholder="${t('konfig.no_consent_ph')}">${esc(v.no_consent_text||'')}</textarea>
      </div>

      <div class="screen-card">
        <div class="screen-card-header">
          <span>${t('konfig.instruction_screen')}</span>
          <label class="toggle" style="margin:0"><input type="checkbox" id="bld-show-instruction" ${s.show_instructions!==0?'checked':''}><span class="toggle-slider"></span></label>
        </div>
        <div id="bld-instruction-body" style="${s.show_instructions!==0?'':'display:none'}">
          <textarea id="bld-instruction" rows="4" placeholder="${t('konfig.instruction_ph')}">${esc(v.instruction_text||'')}</textarea>
          <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer;margin-top:0.75rem">
            <label class="toggle" style="margin:0"><input type="checkbox" id="bld-show-instruction-actions" ${s.show_instruction_actions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
            ${t('konfig.instruction_show_icons')}
          </label>
        </div>
      </div>

      <div class="screen-card">
        <div class="screen-card-header"><span>${t('konfig.demographics_screen')}</span></div>
        ${(() => {
          // Resolve current position: explicit field wins; fall back to legacy
          // show_demographics so studies pre-dropdown render the right option.
          const validPositions = ['after_consent', 'before_debrief', 'hidden'];
          const cur = validPositions.includes(s.demographics_position)
            ? s.demographics_position
            : (s.show_demographics === 0 ? 'hidden' : 'after_consent');
          return `
        <div class="form-group">
          <label>${t('konfig.demographics_position_label')}</label>
          <select id="bld-demographics-position">
            <option value="after_consent"  ${cur === 'after_consent'  ? 'selected' : ''}>${t('konfig.demographics_pos_after_consent')}</option>
            <option value="before_debrief" ${cur === 'before_debrief' ? 'selected' : ''}>${t('konfig.demographics_pos_before_debrief')}</option>
            <option value="hidden"         ${cur === 'hidden'         ? 'selected' : ''}>${t('konfig.demographics_pos_hidden')}</option>
          </select>
        </div>`;
        })()}
        <p style="font-size:0.82rem;color:var(--muted);margin:0">${t('konfig.demographics_help')}</p>
      </div>

      <div class="screen-card">
        <div class="screen-card-header">
          <span>${t('konfig.comments_screen')}</span>
          <label class="toggle" style="margin:0"><input type="checkbox" id="bld-enable-comments" ${s.enable_comments ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>
        <p style="font-size:0.82rem;color:var(--muted);margin:0">${t('konfig.comments_help')}</p>
      </div>

      <div class="screen-card">
        <div class="screen-card-header">
          <span>${t('konfig.multi_reactions_screen')}</span>
          <label class="toggle" style="margin:0"><input type="checkbox" id="bld-allow-multi-reactions" ${s.allow_multi_reactions ? 'checked' : ''}><span class="toggle-slider"></span></label>
        </div>
        <p style="font-size:0.82rem;color:var(--muted);margin:0">${t('konfig.multi_reactions_help')}</p>
      </div>

      <div class="screen-card">
        <div class="screen-card-header">
          <span>${t('konfig.debrief_screen')}</span>
          <span style="display:flex;align-items:center;gap:0.5rem">
            <button type="button" class="btn btn-ghost btn-xs" onclick="previewDebrief(${studyId})" title="${t('konfig.debrief_preview_title')}">${t('konfig.preview')}</button>
            <span class="screen-badge">${t('konfig.always')}</span>
          </span>
        </div>
        <textarea id="bld-debrief" rows="4" placeholder="${t('konfig.debrief_ph')}">${esc(v.debrief_text||'')}</textarea>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer;margin-top:0.75rem">
          <label class="toggle" style="margin:0"><input type="checkbox" id="bld-show-debrief-posts" ${s.show_debrief_posts !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
          ${t('konfig.debrief_show_posts')}
        </label>
      </div>
    </div>

    <div class="builder-section">
      <div class="builder-section-title">${t('konfig.analytics_title')}</div>
      <div class="toggle-row" style="margin-bottom:0.75rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="bld-clarity-enabled" ${s.clarity_enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('konfig.clarity_enable')}</span>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.5rem" id="bld-clarity-pid-wrap">
        <label>Clarity Project ID</label>
        <input type="text" id="bld-clarity-pid" value="${esc(s.clarity_project_id || '')}" placeholder="${t('konfig.clarity_pid_ph')}" maxlength="40">
      </div>
      <div class="toggle-row">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="bld-et-enabled" ${s.eyetracking_enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('konfig.eyetracking_enable')}</span>
        </div>
      </div>
    </div>

    <div class="builder-section" data-konfig="1">
      <div class="builder-section-title">${t('konfig.parts_title')}</div>
      <p style="font-size:0.8rem;color:var(--muted);margin-bottom:1rem">${t('konfig.parts_help')}</p>
      <div id="bld-parts-list">
        ${parts.map((part, idx) => builderPartHTML(part, idx, s, questionsByPart[part.id] || [])).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="builderAddPart(${studyId})">${t('konfig.part_add')}</button>
    </div>

    <div class="builder-section" data-konfig="1">
      <div class="builder-section-title">${t('konfig.manip_title')}</div>
      <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">${t('konfig.manip_help')}</p>
      <div id="bld-manip-list">
        ${manipulations.slice(0, 1).map(m => builderManipHTML(m)).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" id="bld-manip-add-btn" style="margin-top:0.5rem;${manipulations.length ? 'display:none' : ''}" onclick="builderAddManip(${studyId})">${t('konfig.manip_add')}</button>
    </div>

    <div class="builder-section" data-konfig="1">
      <div class="builder-section-title">${t('konfig.metrics_title')}</div>
      <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.6rem;cursor:pointer">
        <input type="checkbox" id="bld-show-metrics" ${s.show_metrics !== 0 ? 'checked' : ''}>
        <span style="font-size:0.85rem">${t('konfig.metrics_show')}</span>
      </label>
      <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">${t('konfig.metrics_help')}</p>
      <div id="es-metric-conditions" style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:0.5rem">
        ${metricConds.map(c => metricConditionRowHTML(c)).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="addMetricCondition()">${t('konfig.metrics_add')}</button>
    </div>

    <div class="builder-section">
      <div class="builder-section-title">${t('konfig.panel_title')}</div>
      <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">
        ${t('konfig.panel_help_1')}
        ${t('konfig.panel_help_2')}
      </p>
      <div class="form-group" style="margin-bottom:0.75rem">
        <label>${t('konfig.ext_param_label')}</label>
        <input type="text" id="bld-ext-param" value="${esc(s.external_id_param_name || 'res_id')}"
               placeholder="res_id" maxlength="64">
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.ext_param_help_1')}
          ${t('konfig.ext_param_help_2')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.5rem">
        <label>${t('konfig.completion_url_label')}</label>
        <input type="url" id="bld-completion-url" value="${esc(s.completion_redirect_url || '')}"
               placeholder="https://panel.example.org/complete?token={ext_id}">
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.completion_url_help_1')}
          ${t('konfig.completion_url_help_2')}
          ${t('konfig.completion_url_help_3')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.75rem">
        <label>${t('konfig.completion_delay_label')}</label>
        <input type="number" id="bld-completion-delay" min="0" max="600" step="1"
               value="${Number(s.completion_redirect_delay_seconds ?? 4)}"
               style="width:120px">
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.completion_delay_help_1')}
          ${t('konfig.completion_delay_help_2')}
          ${t('konfig.completion_delay_help_3')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.75rem">
        <label>${t('konfig.completion_notice_label')}</label>
        <textarea id="bld-completion-notice" rows="2"
                  placeholder="${t('konfig.completion_notice_ph')}">${esc(s.completion_redirect_notice || '')}</textarea>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.completion_notice_help_1')}
          ${t('konfig.completion_notice_help_2')}
          ${t('konfig.completion_notice_help_3')}
          ${t('konfig.completion_notice_help_4')}
          ${t('konfig.completion_notice_help_5')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.5rem;padding-top:0.75rem;border-top:1px dashed var(--border,#e5e5ea)">
        <label>${t('konfig.decline_url_label')}</label>
        <input type="url" id="bld-decline-url" value="${esc(s.decline_redirect_url || '')}"
               placeholder="https://panel.example.org/screenout?token={ext_id}">
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.decline_url_help_1')}
          ${t('konfig.decline_url_help_2')}
          ${t('konfig.decline_url_help_3')}
          ${t('konfig.decline_url_help_4')}
          ${t('konfig.decline_url_help_5')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.75rem">
        <label>${t('konfig.decline_delay_label')}</label>
        <input type="number" id="bld-decline-delay" min="0" max="600" step="1"
               value="${Number(s.decline_redirect_delay_seconds ?? 4)}"
               style="width:120px">
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.decline_delay_help_1')}
          ${t('konfig.decline_delay_help_2')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.75rem">
        <label>${t('konfig.decline_notice_label')}</label>
        <textarea id="bld-decline-notice" rows="2"
                  placeholder="${t('konfig.decline_notice_ph')}">${esc(s.decline_redirect_notice || '')}</textarea>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">
          ${t('konfig.decline_notice_help_1')}
          ${t('konfig.decline_notice_help_2')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.75rem">
        <label style="display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer">
          <input type="checkbox" id="bld-decline-immediate"
                 ${s.decline_redirect_immediate ? 'checked' : ''}
                 style="margin-top:0.2rem">
          <span>${t('konfig.decline_immediate_label')}</span>
        </label>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem;line-height:1.5">
          ${t('konfig.decline_immediate_help_1')}
          ${t('konfig.decline_immediate_help_2')}
          ${t('konfig.decline_immediate_help_3')}
          ${t('konfig.decline_immediate_help_4')}
          ${t('konfig.decline_immediate_help_5')}
          ${t('konfig.decline_immediate_help_6')}
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.5rem;padding-top:0.75rem;border-top:1px dashed var(--border,#e5e5ea)">
        <label>${t('konfig.custom_domain_label')}</label>
        <input type="text" id="bld-custom-domain" value="${esc(s.custom_domain || '')}"
               placeholder="study.example.org" maxlength="253"
               style="font-family:var(--font-mono,monospace);font-size:0.9rem">
        <div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem;line-height:1.5">
          ${t('konfig.custom_domain_help_1')}
          ${t('konfig.custom_domain_help_2')}
          ${t('konfig.custom_domain_help_3')}
          ${t('konfig.custom_domain_help_4')}
          ${t('konfig.custom_domain_help_5')}
          ${t('konfig.custom_domain_help_6')} <code>/study/${esc(s.slug || '<slug>')}</code>
          ${t('konfig.custom_domain_help_7')}
        </div>
      </div>
    </div>

    <div class="builder-section" data-konfig="1">
      <div class="builder-section-title">${t('konfig.logic_title')}</div>
      <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">${t('konfig.logic_help')}</p>
      <div id="bld-logic-list"></div>
      <button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onclick="builderAddLogicRule()">${t('konfig.logic_add_rule')}</button>
    </div>

    <div class="study-action-bar">
      <div class="study-action-bar-inner">
        <button class="btn btn-primary" onclick="builderSave(${studyId})">${t('konfig.save')}</button>
        <button class="btn btn-ghost" onclick="builderPreview(${studyId})">${t('konfig.preview_new_tab')}</button>
      </div>
    </div>
  </div>`;

  document.getElementById('settings-form-wrap').innerHTML = html;
  initBuilderListeners(studyId); // attach listeners while all sections are still in #builder-view
  relocateKonfigSections();      // move the 4 config sections into the Konfigurator tab pane
  builderRenderLogicList();      // populate the conditional-logic rule list
}

// Move the four builder-sections tagged data-konfig (Ekrany badania, Części
// eksperymentu, Manipulacja, Logika warunkowa) into the Konfigurator tab pane.
// Runs AFTER initBuilderListeners so per-element listeners (toggles) are already
// attached — those travel with the moved nodes. The #builder-view input/change
// delegation does NOT cover nodes moved outside it, so we wire an equivalent
// delegation on #konfig-form-wrap (once), resolving the current study from
// #builder-view at event time so it survives study switches.
function relocateKonfigSections() {
  const konfigWrap = document.getElementById('konfig-form-wrap');
  if (!konfigWrap) return;
  konfigWrap.innerHTML = '';
  document.querySelectorAll('#settings-form-wrap [data-konfig="1"]').forEach(el => konfigWrap.appendChild(el));
  if (!konfigWrap.dataset.autosaveWired) {
    const trigger = () => { const sid = document.getElementById('builder-view')?.dataset.studyId; if (sid) builderTriggerAutosave(sid); };
    konfigWrap.addEventListener('input', trigger);
    konfigWrap.addEventListener('change', trigger);
    konfigWrap.dataset.autosaveWired = '1';
  }
}

// Ensure the builder view is rendered for a study without re-rendering (and
// clobbering <800ms of not-yet-autosaved input) when merely switching between
// the Ustawienia and Konfigurator tabs of the SAME study.
async function ensureBuilderRendered(id) {
  const existing = document.getElementById('builder-view');
  if (existing && existing.dataset.studyId === String(id)) return;
  await renderBuilderView(id);
}

// Konfigurator tab — same builder data, showing only the relocated config
// sections. Builder-mode only; legacy studies get a note.
async function renderKonfiguratorTab(id) {
  const s = S.studies.find(x => String(x.id) === String(id));
  const empty = document.getElementById('konfig-empty');
  const wrap  = document.getElementById('konfig-form-wrap');
  const footer = document.getElementById('konfig-footer');
  if (!empty || !wrap) return;
  if (!s) {
    empty.textContent = t('konfig.empty_pick_study');
    empty.style.display = ''; wrap.style.display = 'none'; if (footer) footer.style.display = 'none'; return;
  }
  if (s.builder_mode !== 1) {
    empty.textContent = t('konfig.empty_builder_only');
    empty.style.display = ''; wrap.style.display = 'none'; if (footer) footer.style.display = 'none'; return;
  }
  empty.style.display = 'none';
  wrap.style.display = '';
  if (footer) footer.style.display = '';
  await ensureBuilderRendered(id); // populates #settings-form-wrap + relocates sections here
}

function builderPartHTML(part, idx, study, questions) {
  questions = questions || [];
  const layout = part.layout || study.layout_type || 'feed';
  return `<div class="builder-part-card" data-part-idx="${idx}" data-part-id="${esc(part.id || 'part-' + idx)}">
    <div class="builder-part-header">
      <input class="part-label-input" type="text" value="${esc(part.label || t('konfig.part_default_label', { n: idx+1 }))}" placeholder="${t('konfig.part_name_ph')}">
      <span class="cond-badge-slot" data-pid="${esc(part.id || 'part-' + idx)}" style="display:inline-flex;flex-wrap:wrap;gap:0.35rem"></span>
      ${idx > 0 ? `<button class="btn btn-ghost btn-sm" onclick="builderRemovePart(this)" style="margin-left:auto;color:var(--danger)">${t('konfig.part_remove')}</button>` : ''}
    </div>
    <div style="margin:0.75rem 0">
      <label style="font-size:0.8rem;font-weight:600;text-transform:uppercase;color:var(--muted);letter-spacing:.04em">${t('konfig.part_layout_label')}</label>
      <div class="layout-toggle" style="margin-top:0.5rem">
        <button class="layout-btn ${layout==='feed'?'active':''}" data-layout="feed" onclick="builderSetPartLayout(this,'feed')">📜 Feed</button>
        <button class="layout-btn ${layout!=='feed'?'active':''}" data-layout="paged" onclick="builderSetPartLayout(this,'paged')">📄 Pager</button>
      </div>
    </div>
    ${idx > 0 ? `<div style="margin-top:0.5rem">
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" class="part-trans-toggle" ${part.show_transition?'checked':''}><span class="toggle-slider"></span></label>
        ${t('konfig.part_show_transition')}
      </label>
      <div class="part-trans-fields" style="margin-top:0.5rem;display:${part.show_transition?'block':'none'}">
        <textarea class="part-trans-text" rows="2" placeholder="${t('konfig.part_transition_ph')}">${esc(part.transition_text||'')}</textarea>
        <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.4rem;flex-wrap:wrap">
          <label style="font-size:0.8rem;color:var(--muted)">${t('konfig.part_transition_emoji_label')}</label>
          <input type="text" class="part-trans-emoji" value="${esc(part.transition_emoji != null ? part.transition_emoji : '📱')}" maxlength="8" style="width:70px;text-align:center;font-size:1rem" placeholder="📱">
          <span style="font-size:0.78rem;color:var(--muted)">${t('konfig.part_transition_emoji_hint')}</span>
        </div>
      </div>
    </div>` : ''}
    <div style="margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem;display:flex;flex-direction:column;gap:0.5rem">
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" class="part-show-reactions" ${part.show_reactions !== false && part.show_reactions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('konfig.part_show_reactions')} <span style="font-weight:400;color:var(--muted);font-size:0.8rem">${t('konfig.part_show_reactions_hint')}</span>
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" class="part-require-interaction" ${part.require_interaction?'checked':''}><span class="toggle-slider"></span></label>
        ${t('konfig.part_require_interaction')} <span style="font-weight:400;color:var(--muted);font-size:0.78rem">${t('konfig.part_require_interaction_hint')}</span>
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" class="part-allow-back" ${part.allow_back!==false&&part.allow_back!==0?'checked':''}><span class="toggle-slider"></span></label>
        ${t('konfig.part_allow_back')}
      </label>
      <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;flex-wrap:wrap">
        <span>${t('konfig.part_max_time')}</span>
        <input type="number" class="part-max-seconds" min="0" max="3600" step="1" value="${Number(part.max_seconds) || 0}" placeholder="0" style="width:80px;font-size:0.85rem">
        <span style="color:var(--muted);font-size:0.78rem">${t('konfig.part_max_time_hint')}</span>
      </div>
    </div>
    ${(() => {
      // Structured per-part requirements: a list of {action, count} pairs the
      // participant must satisfy before "Dalej" unlocks. Empty (or undefined)
      // → no constraint, button is governed solely by legacy require_interaction.
      // When non-empty, requirements take precedence over require_interaction.
      const reqs = Array.isArray(part.requirements) ? part.requirements : [];
      const actionOpts = [
        ['like',            t('konfig.req_action_like')],
        ['dislike',         t('konfig.req_action_dislike')],
        ['like_or_dislike', t('konfig.req_action_like_or_dislike')],
        ['share',           t('konfig.req_action_share')],
        ['flag',            t('konfig.req_action_flag')],
        ['comment',         t('konfig.req_action_comment')],
        ['any',             t('konfig.req_action_any')],
      ];
      return `
    <div class="part-requirements" data-part-idx="${idx}" style="margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem">
      <div style="font-size:0.8rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:0.5rem">${t('konfig.part_req_title')} <span style="font-weight:400;text-transform:none;letter-spacing:0">${t('konfig.part_req_title_hint')}</span></div>
      <div class="part-req-list" style="display:flex;flex-direction:column;gap:0.4rem">
        ${reqs.map((r, ri) => `
          <div class="part-req-row" style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
            <select class="part-req-action" style="font-size:0.85rem;width:auto">
              ${actionOpts.map(([val, lbl]) => `<option value="${val}" ${r.action === val ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}
            </select>
            <span style="font-size:0.85rem;color:var(--muted)">×</span>
            <input type="number" class="part-req-count" min="0" max="100" value="${Number(r.count) || 0}" style="width:70px;font-size:0.85rem" title="${t('konfig.req_count_title')}" oninput="reqCountChanged(this)">
            <span class="part-req-count-hint" style="font-size:0.78rem;font-weight:${Number(r.count) === 0 ? '600' : '400'};color:${Number(r.count) === 0 ? '#1e40af' : 'var(--muted)'}">${Number(r.count) === 0 ? t('konfig.req_optional_hint') : (Number(r.count) === 1 ? t('konfig.req_post_one') : t('konfig.req_post_many'))}</span>
            <button type="button" class="btn btn-ghost btn-icon" onclick="this.closest('.part-req-row').remove();builderTriggerAutosave(${study.id || 'null'})" title="${t('konfig.req_remove')}" style="margin-left:auto">🗑</button>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-xs" style="margin-top:0.5rem" onclick="builderAddRequirement(this, ${study.id || 'null'})">${t('konfig.req_add')}</button>
      <p style="font-size:0.78rem;color:var(--muted);margin:0.5rem 0 0">${t('konfig.req_help')}</p>
    </div>`;
    })()}
    <div class="builder-part-questions" style="margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;flex-wrap:wrap">
        <span style="font-size:0.8rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${t('konfig.q_placement')}</span>
        <select class="part-pq-display" style="width:auto;font-size:0.8rem">
          <option value="after_interaction" ${(part.pq_display_mode||'after_interaction')==='after_interaction'?'selected':''}>${t('konfig.q_mode_after_interaction')}</option>
          <option value="after_interaction_modal" ${(part.pq_display_mode||'')==='after_interaction_modal'?'selected':''}>${t('konfig.q_mode_after_interaction_modal')}</option>
          <option value="with_post" ${(part.pq_display_mode||'')==='with_post'?'selected':''}>${t('konfig.q_mode_with_post')}</option>
          <option value="after_post" ${(part.pq_display_mode||'')==='after_post'?'selected':''}>${t('konfig.q_mode_after_post')}</option>
          <option value="after_all_posts" ${(part.pq_display_mode||'')==='after_all_posts'?'selected':''}>${t('konfig.q_mode_after_all_posts')}</option>
        </select>
      </div>
      <div class="form-grid form-grid-2" style="margin-bottom:0.6rem">
        <div class="form-group" style="margin-bottom:0">
          <label style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${t('konfig.q_screen_title_label')}</label>
          <input type="text" class="part-pq-title" value="${esc(part.pq_title||'')}" placeholder="${t('konfig.q_screen_title_ph')}">
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">${t('konfig.q_screen_subtitle_label')}</label>
          <input type="text" class="part-pq-subtitle" value="${esc(part.pq_subtitle||'')}" placeholder="${t('konfig.q_screen_subtitle_ph')}">
        </div>
      </div>
      <div class="part-questions-list">
        ${questions.map(q => builderQuestionHTML(q)).join('')}
      </div>
      <button class="btn btn-ghost btn-xs" style="margin-top:0.25rem" onclick="builderAddQuestion(${study.id || 'null'}, '${part.id || 'part-' + idx}')">${t('konfig.q_add')}</button>
    </div>
  </div>`;
}

function builderQuestionHTML(q) {
  const rawOpts = (() => { try { return JSON.parse(q.options_json||'[]'); } catch { return []; } })();
  const isChoice = q.question_type === 'single' || q.question_type === 'multi';
  const isLikert = q.question_type === 'likert';
  // Likert config stored as plain object, choice options stored as array
  const opts = Array.isArray(rawOpts) ? rawOpts : [];
  const likert = (!Array.isArray(rawOpts) && rawOpts) ? rawOpts : {};
  const lScale = likert.scale || 7;
  const lMin   = esc(likert.label_min || '');
  const lMax   = esc(likert.label_max || '');
  const lDesc  = esc(likert.description || '');
  // start_at — which number labels the first button. 1 (default, historical
  // behavior across every study built before this feature) or 0 (new
  // opt-in). Legacy rows lack the key entirely → reads as undefined →
  // collapses to 1 here AND in the participant renderer. Researcher should
  // NEVER flip this on a question that already has responses in flight —
  // the values stored in DB are the actual clicked numbers, so switching
  // from 1 to 0 mid-study would reshuffle the apparent meaning of every
  // existing answer.
  const lStartAt = likert.start_at === 0 ? 0 : 1;

  return `<div class="builder-question-card" data-qid="${q.id}">
    <div style="display:flex;gap:0.75rem;align-items:flex-start">
      <div style="flex:1">
        <div class="cond-badge-slot" data-qid="${q.id}" style="display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.4rem"></div>
        <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap;align-items:center">
          <select class="pq-type" style="width:auto" onchange="builderUpdateQuestionType(this)">
            <option value="open"   ${q.question_type==='open'  ?'selected':''}>${t('konfig.q_type_open')}</option>
            <option value="single" ${q.question_type==='single'?'selected':''}>${t('konfig.q_type_single')}</option>
            <option value="multi"  ${q.question_type==='multi' ?'selected':''}>${t('konfig.q_type_multi')}</option>
            <option value="likert" ${q.question_type==='likert'?'selected':''}>${t('konfig.q_type_likert')}</option>
          </select>
          <label style="display:flex;align-items:center;gap:0.25rem;font-size:0.85rem;cursor:pointer">
            <input type="checkbox" class="pq-required" ${q.required?'checked':''}> ${t('konfig.q_required')}
          </label>
        </div>
        <input type="text" class="pq-label" value="${esc(q.label)}" placeholder="${t('konfig.q_label_ph')}" style="width:100%;margin-bottom:0.5rem">

        <div class="pq-options-wrap" style="${isChoice?'':'display:none'};margin-top:0.25rem">
          <div class="pq-options-list">
            ${opts.map((o,i) => `<div class="pq-opt-row" style="display:flex;gap:0.5rem;margin-bottom:0.25rem">
              <input type="text" class="pq-opt-val" value="${esc(o.label||o.value||o)}" placeholder="${t('konfig.q_option_n', { n: i+1 })}" style="flex:1">
              <button class="btn btn-ghost btn-xs" onclick="this.closest('.pq-opt-row').remove()">✕</button>
            </div>`).join('')}
          </div>
          <button class="btn btn-ghost btn-xs" onclick="builderAddQuestionOption(this)" style="margin-top:0.25rem">${t('konfig.q_add_option')}</button>
        </div>

        <div class="pq-likert-wrap" style="${isLikert?'':'display:none'};margin-top:0.25rem">
          <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-end">
            <div class="form-group" style="margin:0;flex:0 0 auto">
              <label style="font-size:0.8rem;margin-bottom:0.25rem;display:block">${t('konfig.q_likert_scale_points')}</label>
              <select class="pq-likert-scale" style="width:auto">
                ${[5,6,7,8,9,10,11].map(n => `<option value="${n}" ${lScale==n?'selected':''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="margin:0;flex:0 0 auto" title="${t('konfig.q_likert_start_title')}">
              <label style="font-size:0.8rem;margin-bottom:0.25rem;display:block">${t('konfig.q_likert_start_label')}</label>
              <select class="pq-likert-start-at" style="width:auto">
                <option value="1" ${lStartAt===1?'selected':''}>1</option>
                <option value="0" ${lStartAt===0?'selected':''}>0</option>
              </select>
            </div>
            <div class="form-group" style="margin:0;flex:1;min-width:110px">
              <label style="font-size:0.8rem;margin-bottom:0.25rem;display:block">${t('konfig.q_likert_min_label')}</label>
              <input type="text" class="pq-likert-min" value="${lMin}" placeholder="${t('konfig.q_likert_min_ph')}">
            </div>
            <div class="form-group" style="margin:0;flex:1;min-width:110px">
              <label style="font-size:0.8rem;margin-bottom:0.25rem;display:block">${t('konfig.q_likert_max_label')}</label>
              <input type="text" class="pq-likert-max" value="${lMax}" placeholder="${t('konfig.q_likert_max_ph')}">
            </div>
          </div>
          <div class="form-group" style="margin-top:0.5rem;margin-bottom:0">
            <label style="font-size:0.8rem;margin-bottom:0.25rem;display:block">${t('konfig.q_likert_desc_label')}</label>
            <textarea class="pq-likert-desc" rows="2" placeholder="${t('konfig.q_likert_desc_ph')}">${lDesc}</textarea>
          </div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" style="color:var(--danger);flex-shrink:0" onclick="builderDeleteQuestion(${q.id}, this)">✕</button>
    </div>
  </div>`;
}

function initBuilderListeners(studyId) {
  const view = document.getElementById('builder-view');
  if (!view) return;

  view.addEventListener('input', () => builderTriggerAutosave(studyId));
  view.addEventListener('change', () => builderTriggerAutosave(studyId));

  const instrToggle = document.getElementById('bld-show-instruction');
  const instrBody = document.getElementById('bld-instruction-body');
  if (instrToggle && instrBody) {
    instrToggle.addEventListener('change', () => {
      instrBody.style.display = instrToggle.checked ? '' : 'none';
    });
  }

  // Transition fields (text + emoji input) toggle per part — show as a
  // group via .part-trans-fields so the emoji input rides along.
  view.querySelectorAll('.part-trans-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      const fields = toggle.closest('label').closest('div')?.querySelector('.part-trans-fields');
      if (fields) fields.style.display = toggle.checked ? 'block' : 'none';
    });
  });
}

function builderTriggerAutosave(studyId) {
  if (!studyId) return;
  clearTimeout(_builderSaveTimer);
  // 800ms debounce — short enough that researchers don't navigate to the
  // participant preview before their last change has landed; long enough
  // to coalesce rapid typing without flooding the server.
  _builderSaveTimer = setTimeout(() => builderSave(studyId, true), 800);
}

// Live-update the helper text next to the requirement count input. The
// participant sees count=0 as an "∞ opcjonalne" prompt; without this hook
// the researcher couldn't tell whether their just-typed "0" actually
// registered (autosave is silent until ~800ms passes). The visual flip
// to the blue "∞ opcjonalne" hint is immediate confirmation that the
// JS picked up the change. Called via inline oninput on the .part-req-count.
window.reqCountChanged = function (input) {
  const row = input.closest('.part-req-row');
  const hint = row?.querySelector('.part-req-count-hint');
  if (!hint) return;
  const n = Number(input.value);
  if (n === 0) {
    hint.textContent = t('konfig.req_optional_hint');
    hint.style.color = '#1e40af';
    hint.style.fontWeight = '600';
  } else if (n === 1) {
    hint.textContent = t('konfig.req_post_one');
    hint.style.color = 'var(--muted)';
    hint.style.fontWeight = '400';
  } else {
    hint.textContent = t('konfig.req_post_many');
    hint.style.color = 'var(--muted)';
    hint.style.fontWeight = '400';
  }
};

// Append a new {action: 'like', count: 1} requirement row to the part's
// requirements section. Triggers autosave so the new row is persisted
// even if the researcher doesn't touch any other field.
function builderAddRequirement(btn, studyId) {
  const section = btn.closest('.part-requirements');
  const list = section?.querySelector('.part-req-list');
  if (!list) return;
  const actionOpts = [
    ['like',            t('konfig.req_action_like')],
    ['dislike',         t('konfig.req_action_dislike')],
    ['like_or_dislike', t('konfig.req_action_like_or_dislike')],
    ['share',           t('konfig.req_action_share')],
    ['flag',            t('konfig.req_action_flag')],
    ['comment',         t('konfig.req_action_comment')],
    ['any',             t('konfig.req_action_any')],
  ];
  const row = document.createElement('div');
  row.className = 'part-req-row';
  row.style.cssText = 'display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap';
  row.innerHTML = `
    <select class="part-req-action" style="font-size:0.85rem;width:auto">
      ${actionOpts.map(([val, lbl]) => `<option value="${val}">${esc(lbl)}</option>`).join('')}
    </select>
    <span style="font-size:0.85rem;color:var(--muted)">×</span>
    <input type="number" class="part-req-count" min="0" max="100" value="1" style="width:70px;font-size:0.85rem" title="${t('konfig.req_count_title_short')}" oninput="reqCountChanged(this)">
    <span class="part-req-count-hint" style="font-size:0.78rem;color:var(--muted)">${t('konfig.req_post_one')}</span>
    <button type="button" class="btn btn-ghost btn-icon" onclick="this.closest('.part-req-row').remove();builderTriggerAutosave(${studyId || 'null'})" title="${t('konfig.req_remove')}" style="margin-left:auto">🗑</button>
  `;
  list.appendChild(row);
  builderTriggerAutosave(studyId);
}

async function builderSave(studyId, silent = false) {
  const view = document.getElementById('builder-view');
  if (!view) return;
  // Both the Ustawienia top-status and the Konfigurator footer status carry this
  // class; update all so autosave feedback shows on whichever tab is visible.
  const statusEls = document.querySelectorAll('.bld-save-status');

  // Query the DOCUMENT, not #builder-view: the Konfigurator relocates the parts
  // section into #konfig-form-wrap, so a builder-view-scoped query finds ZERO
  // cards and would save parts_json='[]' — wiping every part (timer, requirements
  // and all). Relocation MOVES the cards, so they exist in exactly one place.
  const partCards = document.querySelectorAll('.builder-part-card');
  // Safety net: never persist an empty parts list — if collection somehow finds
  // nothing (e.g. mid-render), skip the parts_json field rather than wipe it.
  if (!partCards.length) { console.warn('builderSave: 0 part cards found — skipping parts_json to avoid a wipe'); }
  const parts = Array.from(partCards).map((card, idx) => ({
    id: card.dataset.partId || `part-${idx}`,
    label: card.querySelector('.part-label-input')?.value || t('konfig.save_part_default', { n: idx+1 }),
    layout: card.querySelector('.layout-btn.active')?.dataset.layout || 'feed',
    show_transition: card.querySelector('.part-trans-toggle')?.checked || false,
    transition_text: card.querySelector('.part-trans-text')?.value || '',
    // Per-part transition emoji. Stored as STRING (including ''):
    //   undefined  → researcher never touched the field (legacy parts)
    //   ''         → researcher explicitly cleared it → hide on the screen
    //   any string → use that emoji
    // The empty-string case is the whole reason this field exists — the
    // HTML hardcoded a '📱' that researchers couldn't remove.
    transition_emoji: card.querySelector('.part-trans-emoji')?.value ?? undefined,
    pq_display_mode: card.querySelector('.part-pq-display')?.value || 'after_interaction',
    pq_title:    card.querySelector('.part-pq-title')?.value    || '',
    pq_subtitle: card.querySelector('.part-pq-subtitle')?.value || '',
    require_interaction: card.querySelector('.part-require-interaction')?.checked || false,
    allow_back: card.querySelector('.part-allow-back')?.checked !== false,
    show_reactions: card.querySelector('.part-show-reactions')?.checked !== false,
    // Max time on this part — 0 (or missing) = no limit. Stored as a
    // non-negative integer; the participant runtime starts a timer on
    // startPart and forces completePart when it expires.
    max_seconds: Math.max(0, Math.min(3600, Number(card.querySelector('.part-max-seconds')?.value) || 0)),
    // Structured requirements — collected from .part-req-row inside the
    // .part-requirements section. count=0 is allowed (opcjonalne / ∞
    // prompt — see participant.js renderPartChecklist), count<0 invalid.
    requirements: Array.from(card.querySelectorAll('.part-req-row')).map(r => ({
      action: r.querySelector('.part-req-action')?.value || 'any',
      count: Math.max(0, Math.min(100, Number(r.querySelector('.part-req-count')?.value) || 0)),
    })).filter(r => r.action),
  }));

  const payload = {
    name:                         document.getElementById('bld-name')?.value || '',
    slug:                         document.getElementById('bld-slug')?.value || '',
    description:                  document.getElementById('bld-desc')?.value || '',
    language:                     document.getElementById('bld-lang')?.value || 'pl',
    participant_title:            document.getElementById('bld-participant-title')?.value || '',
    layout_type:                  parts[0]?.layout || 'feed',
    consent_text:                 document.getElementById('bld-consent')?.value || '',
    no_consent_text:              document.getElementById('bld-no-consent')?.value || '',
    instruction_text:             document.getElementById('bld-instruction')?.value || '',
    debrief_text:                 document.getElementById('bld-debrief')?.value || '',
    show_instructions:            document.getElementById('bld-show-instruction')?.checked ? 1 : 0,
    show_debrief_posts:           document.getElementById('bld-show-debrief-posts')?.checked ? 1 : 0,
    enable_comments:              document.getElementById('bld-enable-comments')?.checked ? 1 : 0,
    allow_multi_reactions:        document.getElementById('bld-allow-multi-reactions')?.checked ? 1 : 0,
    show_instruction_actions:     document.getElementById('bld-show-instruction-actions')?.checked ? 1 : 0,
    // Dropdown is the source of truth from this commit onwards. show_demographics
    // is mirrored from it so legacy code paths reading the boolean still work
    // (hidden → 0, anything else → 1).
    demographics_position:        document.getElementById('bld-demographics-position')?.value || 'after_consent',
    show_demographics:            (document.getElementById('bld-demographics-position')?.value === 'hidden') ? 0 : 1,
    // Never overwrite parts_json with an empty list (would wipe every part).
    ...(partCards.length ? { parts_json: JSON.stringify(parts) } : {}),
    manipulation_json:            JSON.stringify(builderCollectManipulations()),
    logic_json:                   JSON.stringify(builderCollectLogic()),
    // Metric (social-proof) conditions — collected from the builder's section
    // (document-scoped id, so it works after the Konfigurator relocates it).
    metric_conditions_json:       JSON.stringify(Array.from(document.querySelectorAll('#es-metric-conditions .metric-condition-row')).map(row => ({
      key: row.dataset.key || ('K' + Date.now()),
      label: row.querySelector('.mc-label').value.trim() || t('konfig.save_metric_cond_default'),
      min: Number(row.querySelector('.mc-min').value) || 0,
      max: Number(row.querySelector('.mc-max').value) || 0,
      enabled: row.querySelector('.mc-enabled').checked,
      show_comment: row.querySelector('.mc-show-comment').checked,
    }))),
    // Only send show_metrics when the toggle is actually in the DOM, so a render
    // path without it can never silently flip metrics off.
    ...(document.getElementById('bld-show-metrics') ? { show_metrics: document.getElementById('bld-show-metrics').checked ? 1 : 0 } : {}),
    clarity_enabled:              document.getElementById('bld-clarity-enabled')?.checked ? 1 : 0,
    clarity_project_id:           document.getElementById('bld-clarity-pid')?.value.trim() || null,
    eyetracking_enabled:          document.getElementById('bld-et-enabled')?.checked ? 1 : 0,
    // Panel-recruitment fields. Empty inputs → defaults handled server-side
    // (res_id for param name, NULL for endlink = no redirect).
    external_id_param_name:       document.getElementById('bld-ext-param')?.value.trim() || 'res_id',
    completion_redirect_url:      document.getElementById('bld-completion-url')?.value.trim() || null,
    completion_redirect_delay_seconds: (() => {
      const v = Number(document.getElementById('bld-completion-delay')?.value);
      // NaN / negative → null so server applies its 4s default; clamp upper at 600.
      if (!Number.isFinite(v) || v < 0) return null;
      return Math.min(600, Math.floor(v));
    })(),
    completion_redirect_notice:   document.getElementById('bld-completion-notice')?.value.trim() || null,
    decline_redirect_url:         document.getElementById('bld-decline-url')?.value.trim() || null,
    decline_redirect_delay_seconds: (() => {
      const v = Number(document.getElementById('bld-decline-delay')?.value);
      if (!Number.isFinite(v) || v < 0) return null;
      return Math.min(600, Math.floor(v));
    })(),
    decline_redirect_notice:      document.getElementById('bld-decline-notice')?.value.trim() || null,
    decline_redirect_immediate:   document.getElementById('bld-decline-immediate')?.checked ? 1 : 0,
    // Custom domain — normalize to bare hostname: strip protocol, path,
    // lowercase. www. is INTENTIONALLY left untouched (researcher decides
    // if their CNAME is for apex or www form).
    custom_domain: (() => {
      const raw = (document.getElementById('bld-custom-domain')?.value || '').trim();
      if (!raw) return null;
      return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase() || null;
    })(),
  };

  await builderSaveQuestions(studyId);

  const result = await api('PATCH', `/studies/${studyId}/builder`, payload);
  if (result) {
    const idx = S.studies.findIndex(x => x.id == studyId);
    if (idx >= 0) S.studies[idx] = { ...S.studies[idx], ...result };
    statusEls.forEach(el => {
      el.textContent = t('konfig.save_status_saved');
      el.style.color = 'var(--success, #22c55e)';
      setTimeout(() => { el.textContent = t('konfig.save_status_autosave'); el.style.color = 'var(--muted)'; }, 2500);
    });
    if (!silent) toast(t('konfig.save_toast'));
  }
  return result;
}

async function builderSaveQuestions(studyId) {
  const view = document.getElementById('builder-view');
  if (!view) return;
  // Document-scoped: the Konfigurator relocates the parts (with their question
  // cards) into #konfig-form-wrap, so a builder-view query would find none and
  // silently drop question edits made there.
  const cards = document.querySelectorAll('.builder-question-card[data-qid]');
  const promises = [];
  cards.forEach((card, idx) => {
    const qid = card.dataset.qid;
    if (!qid || qid === 'new') return;
    const label         = card.querySelector('.pq-label')?.value || '';
    const question_type = card.querySelector('.pq-type')?.value || 'open';
    const required      = card.querySelector('.pq-required')?.checked ? 1 : 0;
    let options_json;
    if (question_type === 'likert') {
      const scale       = parseInt(card.querySelector('.pq-likert-scale')?.value || '7', 10);
      const label_min   = card.querySelector('.pq-likert-min')?.value || '';
      const label_max   = card.querySelector('.pq-likert-max')?.value || '';
      const description = card.querySelector('.pq-likert-desc')?.value || '';
      // start_at: 1 (legacy default — preserved for every pre-existing
      // question) or 0 (new opt-in). Parsed from the dropdown value so the
      // round-trip through PATCH lands as a real number, not the string
      // "0" / "1" (the participant renderer uses === 0 to detect the new
      // mode).
      const start_at    = parseInt(card.querySelector('.pq-likert-start-at')?.value || '1', 10) === 0 ? 0 : 1;
      options_json = JSON.stringify({ scale, label_min, label_max, description, start_at });
    } else {
      const optEls = card.querySelectorAll('.pq-opt-val');
      options_json = JSON.stringify(Array.from(optEls).map(el => ({ label: el.value, value: el.value })));
    }
    promises.push(api('PATCH', `/post-questions/${qid}`, { label, question_type, required, options_json, order_index: idx }));
  });
  await Promise.all(promises);
}

async function builderAddQuestion(studyId, partId) {
  const data = await api('POST', `/studies/${studyId}/post-questions`, { label: '', question_type: 'open', required: 1, part_id: partId || null });
  if (!data) return;
  // Find the correct part's question list
  const partCard = document.querySelector(`.builder-part-card[data-part-id="${CSS.escape(partId || '')}"]`);
  const list = partCard ? partCard.querySelector('.part-questions-list') : document.getElementById('bld-questions-list');
  if (list) {
    const tmp = document.createElement('div');
    tmp.innerHTML = builderQuestionHTML(data);
    list.appendChild(tmp.firstElementChild);
    list.lastElementChild?.querySelector('.pq-label')?.focus();
  }
}

async function builderDeleteQuestion(qid, btn) {
  await api('DELETE', `/post-questions/${qid}`);
  btn.closest('.builder-question-card')?.remove();
}

function builderUpdateQuestionType(select) {
  const card = select.closest('.builder-question-card');
  const optWrap    = card?.querySelector('.pq-options-wrap');
  const likertWrap = card?.querySelector('.pq-likert-wrap');
  const isChoice = select.value === 'single' || select.value === 'multi';
  const isLikert = select.value === 'likert';
  if (optWrap)    optWrap.style.display    = isChoice ? '' : 'none';
  if (likertWrap) likertWrap.style.display = isLikert ? '' : 'none';
  const studyId = card?.closest('[data-study-id]')?.dataset.studyId;
  if (studyId) builderTriggerAutosave(studyId);
}

function builderAddQuestionOption(btn) {
  const list = btn.previousElementSibling;
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'pq-opt-row';
  row.style.cssText = 'display:flex;gap:0.5rem;margin-bottom:0.25rem';
  row.innerHTML = `<input type="text" class="pq-opt-val" placeholder="${t('konfig.save_option_placeholder')}" style="flex:1"><button class="btn btn-ghost btn-xs" onclick="this.closest('.pq-opt-row').remove()">✕</button>`;
  list.appendChild(row);
  row.querySelector('input')?.focus();
}

function builderAddPart(studyId) {
  const list = document.getElementById('bld-parts-list');
  if (!list) return;
  const idx = list.querySelectorAll('.builder-part-card').length;
  const study = S.studies.find(x => x.id == studyId);
  const newPart = { id: `part-${idx}`, label: t('konfig.save_part_default', { n: idx+1 }), layout: 'feed', show_transition: false, transition_text: '' };
  const tmp = document.createElement('div');
  tmp.innerHTML = builderPartHTML(newPart, idx, study || {});
  const card = tmp.firstElementChild;
  list.appendChild(card);
  // Wire up transition toggle for new part
  const toggle = card.querySelector('.part-trans-toggle');
  if (toggle) {
    toggle.addEventListener('change', () => {
      const textarea = toggle.closest('label')?.closest('div')?.querySelector('.part-trans-text');
      if (textarea) textarea.style.display = toggle.checked ? 'block' : 'none';
    });
  }
  builderTriggerAutosave(studyId);
}

function builderRemovePart(btn) {
  const card = btn.closest('.builder-part-card');
  const studyId = card?.closest('[data-study-id]')?.dataset.studyId;
  card?.remove();
  if (studyId) builderTriggerAutosave(studyId);
}

function builderSetPartLayout(btn, layout) {
  const toggle = btn.closest('.layout-toggle');
  toggle?.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const studyId = btn.closest('[data-study-id]')?.dataset.studyId;
  if (studyId) builderTriggerAutosave(studyId);
}

// A post stores exactly two content variants (_a / _b) for headline, content and
// image — so a between-subjects manipulation is a SINGLE binary split (A vs B).
// The field below is a descriptive label only (the runtime swaps all _a/_b
// content by the assigned arm); it's limited to dimensions that actually have
// per-arm content. 'mixed' = A and B differ in more than one element.
const MANIP_FIELDS = [
  { value: 'headline', label: 'konfig.manip_field_headline' },
  { value: 'content', label: 'konfig.manip_field_content' },
  { value: 'image', label: 'konfig.manip_field_image' },
  { value: 'mixed', label: 'konfig.manip_field_mixed' },
];

// Exactly one manipulation, exactly two arms (A/B). No C/D, no second
// manipulation — those have no post content and would silently collapse to A.
function builderManipHTML(m) {
  const conds = (m.conditions || []).slice(0, 2);
  while (conds.length < 2) conds.push({ key: conds.length === 0 ? 'A' : 'B', label: '' });
  const field = ['headline', 'content', 'image', 'mixed'].includes(m.field) ? m.field : 'headline';
  const fieldOpts = MANIP_FIELDS.map(f => `<option value="${f.value}" ${field===f.value?'selected':''}>${t(f.label)}</option>`).join('');
  return `<div class="builder-manip-card" data-manip-id="${esc(m.id||'m'+Date.now())}">
    <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.6rem">
      <label style="font-size:0.8rem;color:var(--muted);flex-shrink:0">${t('konfig.manip_field_label')}</label>
      <select class="manip-field" style="width:auto;flex:1">${fieldOpts}</select>
      <button class="btn btn-ghost btn-sm" style="color:var(--danger);flex-shrink:0" title="${t('konfig.manip_remove_title')}" onclick="builderRemoveManip(this)">${t('konfig.manip_remove')}</button>
    </div>
    <div class="manip-conditions-list">
      ${conds.map((c, ci) => builderManipCondHTML(c, ci)).join('')}
    </div>
    <div style="font-size:0.76rem;color:var(--muted);margin-top:0.6rem;line-height:1.45;background:var(--bg,#f7f8fa);border-radius:6px;padding:0.55rem 0.7rem">
      ${t('konfig.manip_info_1')}
      ${t('konfig.manip_info_2')}
      ${t('konfig.manip_info_3')}
      ${t('konfig.manip_info_4')}
    </div>
  </div>`;
}

// Fixed A/B rows — key is positional, no add/remove. The "→ wariant A/B" hint
// tells the researcher exactly which post content each arm shows.
function builderManipCondHTML(c, idx) {
  const key = idx === 0 ? 'A' : 'B';
  const variant = idx === 0 ? t('konfig.manip_variant_a') : t('konfig.manip_variant_b');
  const hint = idx === 0 ? t('konfig.manip_hint_a') : t('konfig.manip_hint_b');
  return `<div class="manip-cond-row" data-key="${key}">
    <span class="manip-cond-key">${key}</span>
    <input type="text" class="manip-cond-label" value="${esc(c.label||'')}" placeholder="${t('konfig.manip_cond_placeholder', { key, hint })}">
    <span style="font-size:0.72rem;color:var(--muted);flex-shrink:0;white-space:nowrap">→ ${variant}</span>
  </div>`;
}

function builderAddManip(studyId) {
  const list = document.getElementById('bld-manip-list');
  if (!list) return;
  if (list.querySelector('.builder-manip-card')) return; // at most one manipulation
  const newM = { id: 'm' + Date.now(), field: 'headline', conditions: [{ key: 'A', label: '' }, { key: 'B', label: '' }] };
  const tmp = document.createElement('div');
  tmp.innerHTML = builderManipHTML(newM);
  list.appendChild(tmp.firstElementChild);
  builderUpdateManipAddBtn();
  builderTriggerAutosave(studyId);
}

function builderRemoveManip(btn) {
  const card = btn.closest('.builder-manip-card');
  const studyId = card?.closest('[data-study-id]')?.dataset.studyId;
  card?.remove();
  builderUpdateManipAddBtn();
  if (studyId) builderTriggerAutosave(studyId);
}

// The "+ Dodaj podział A/B" button only makes sense when no manipulation exists.
function builderUpdateManipAddBtn() {
  const btn = document.getElementById('bld-manip-add-btn');
  if (btn) btn.style.display = document.querySelector('#bld-manip-list .builder-manip-card') ? 'none' : '';
}

// ── Conditional-logic rule builder ──────────────────────────────────────────
const LOGIC_OPS = [
  { v: 'eq', l: 'konfig.logic_op_eq' }, { v: 'ne', l: 'konfig.logic_op_ne' },
  { v: 'lt', l: 'konfig.logic_op_lt' }, { v: 'le', l: 'konfig.logic_op_le' },
  { v: 'gt', l: 'konfig.logic_op_gt' }, { v: 'ge', l: 'konfig.logic_op_ge' },
  { v: 'contains', l: 'konfig.logic_op_contains' }, { v: 'empty', l: 'konfig.logic_op_empty' }, { v: 'not_empty', l: 'konfig.logic_op_not_empty' },
];
function builderCollectLogic() {
  const rules = (S.builderLogic && S.builderLogic.rules) || [];
  return { version: 1, rules };
}
function builderLogicRuleSummary(r) {
  const w = r.when || {}, a = r.action || {};
  const srcLabel = w.source === 'demographic' ? t('konfig.logic_src_demographic', { key: w.key || '?' })
    : w.source === 'condition' ? t('konfig.logic_src_condition')
    : w.source === 'post_question' ? t('konfig.logic_src_question', { key: w.key || '?' })
    : w.source === 'reaction' ? t('konfig.logic_src_reaction') : '?';
  const opL = (op => op ? t(op.l) : (w.op || '?'))(LOGIC_OPS.find(o => o.v === w.op));
  const cond = ['empty', 'not_empty'].includes(w.op) ? `${srcLabel} ${opL}` : `${srcLabel} ${opL} „${w.value ?? ''}"`;
  const timing = r.timing === 'after_demographics' ? t('konfig.logic_timing_demographics') : r.timing === 'after_interaction' ? t('konfig.logic_timing_interaction') : t('konfig.logic_timing_part');
  const part = (S.builderLogic?.parts || []).find(p => p.id === a.target_part_id);
  const partName = part ? part.label : a.target_part_id;
  const q = (S.builderLogic?.questions || []).find(x => String(x.id) === String(a.target_question_id));
  const act = a.type === 'skip_part' ? t('konfig.logic_act_skip_part', { part: partName })
    : a.type === 'goto_part' ? t('konfig.logic_act_goto_part', { part: partName })
    : a.type === 'hide_question' ? (t('konfig.logic_act_hide_question', { id: a.target_question_id }) + (q ? (' („' + (q.label || '').slice(0, 25) + '")') : ''))
    : a.type === 'end_study' ? t('konfig.logic_act_end_study') : '?';
  return `[${timing}] ${t('konfig.logic_if')} ${cond} → ${act}`;
}
// Compact description of a rule's TRIGGER (the "gdy …" part), for element badges.
const LOGIC_OP_SYM = { eq: 'konfig.logic_sym_eq', ne: 'konfig.logic_sym_ne', lt: 'konfig.logic_sym_lt', le: 'konfig.logic_sym_le', gt: 'konfig.logic_sym_gt', ge: 'konfig.logic_sym_ge', contains: 'konfig.logic_op_contains', empty: 'konfig.logic_sym_empty', not_empty: 'konfig.logic_sym_not_empty' };
function builderLogicTriggerLabel(r) {
  const w = r.when || {};
  const sym = LOGIC_OP_SYM[w.op] ? t(LOGIC_OP_SYM[w.op]) : (w.op || '');
  const val = ['empty', 'not_empty'].includes(w.op) ? '' : ` „${w.value ?? ''}"`;
  if (w.source === 'condition')     return `${t('konfig.logic_trig_condition')} ${sym}${val}`;
  if (w.source === 'demographic')   return `${w.key || t('konfig.logic_trig_demographic')} ${sym}${val}`;
  if (w.source === 'post_question') return `${t('konfig.logic_trig_answer', { key: w.key || '?' })} ${sym}${val}`;
  if (w.source === 'reaction')      return `${t('konfig.logic_src_reaction')} ${sym}${val}`;
  return t('konfig.logic_trig_condition');
}

// Badge HTML for an element (question/part) targeted by any enabled logic rule.
function builderConditionBadgesFor(targetType, targetId) {
  const rules = (S.builderLogic && S.builderLogic.rules) || [];
  const matched = rules.filter(r => {
    if (r.enabled === false) return false;
    const a = r.action || {};
    if (targetType === 'question') return a.type === 'hide_question' && String(a.target_question_id) === String(targetId);
    if (targetType === 'part') return (a.type === 'skip_part' || a.type === 'goto_part') && String(a.target_part_id) === String(targetId);
    return false;
  });
  return matched.map(r => {
    const a = r.action || {};
    const verb = a.type === 'hide_question' ? t('konfig.logic_badge_hidden') : a.type === 'skip_part' ? t('konfig.logic_badge_skipped') : t('konfig.logic_badge_goto');
    return `<span class="cond-badge" title="${esc(builderLogicRuleSummary(r))}" style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.72rem;background:#ede9fe;color:#6d28d9;border-radius:20px;padding:0.1rem 0.55rem;font-weight:600;white-space:nowrap">🔀 ${verb}, ${t('konfig.logic_badge_when')} ${esc(builderLogicTriggerLabel(r))}</span>`;
  }).join(' ');
}

// Fill every badge slot in the builder from the current rule set. Called on load
// and after any rule change so indicators stay live.
function builderRefreshConditionBadges() {
  document.querySelectorAll('.cond-badge-slot[data-qid]').forEach(s => { s.innerHTML = builderConditionBadgesFor('question', s.dataset.qid); });
  document.querySelectorAll('.cond-badge-slot[data-pid]').forEach(s => { s.innerHTML = builderConditionBadgesFor('part', s.dataset.pid); });
}

function builderRenderLogicList() {
  const host = document.getElementById('bld-logic-list');
  builderRefreshConditionBadges(); // keep element indicators in sync with the rules
  if (!host) return;
  const rules = (S.builderLogic && S.builderLogic.rules) || [];
  if (!rules.length) {
    host.innerHTML = `<div style="font-size:0.85rem;color:var(--muted);padding:0.35rem 0 0.6rem">${t('konfig.logic_empty')}</div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn btn-ghost btn-xs" onclick="builderLogicTemplate('screenout_age')">${t('konfig.logic_tpl_age')}</button>
        <button class="btn btn-ghost btn-xs" onclick="builderLogicTemplate('skip_condition')">${t('konfig.logic_tpl_skip')}</button>
      </div>`;
    return;
  }
  host.innerHTML = rules.map((r, i) => `
    <div class="builder-manip-card" style="display:flex;align-items:flex-start;gap:0.6rem;margin-bottom:0.5rem">
      <label class="toggle" style="margin:0.15rem 0 0" title="${t('konfig.logic_toggle_title')}"><input type="checkbox" ${r.enabled !== false ? 'checked' : ''} onchange="builderToggleLogicRule(${i})"><span class="toggle-slider"></span></label>
      <div style="display:flex;flex-direction:column;gap:0.1rem">
        <button class="btn btn-ghost btn-xs" style="padding:0 0.35rem;line-height:1.2" title="${t('konfig.logic_move_up')}" ${i === 0 ? 'disabled' : ''} onclick="builderMoveLogicRule(${i},-1)">▲</button>
        <button class="btn btn-ghost btn-xs" style="padding:0 0.35rem;line-height:1.2" title="${t('konfig.logic_move_down')}" ${i === rules.length - 1 ? 'disabled' : ''} onclick="builderMoveLogicRule(${i},1)">▼</button>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:0.86rem">${esc(r.label || t('konfig.logic_unnamed'))}</div>
        <div style="font-size:0.79rem;color:var(--muted)">${esc(builderLogicRuleSummary(r))}</div>
      </div>
      <button class="btn btn-ghost btn-xs" onclick="builderEditLogicRule(${i})">${t('konfig.logic_edit')}</button>
      <button class="btn btn-ghost btn-xs" style="color:var(--danger)" onclick="builderDeleteLogicRule(${i})">✕</button>
    </div>`).join('');
}
// Reorder rules (priority = evaluation order; lower index = higher priority).
// Renumber priority to match the new order so it persists in logic_json.
function builderMoveLogicRule(i, dir) {
  const rules = S.builderLogic && S.builderLogic.rules;
  if (!rules) return;
  const j = i + dir;
  if (j < 0 || j >= rules.length) return;
  const tmp = rules[i]; rules[i] = rules[j]; rules[j] = tmp;
  rules.forEach((r, k) => { r.priority = k + 1; });
  builderRenderLogicList();
  builderTriggerAutosave(S.builderLogic.studyId);
}
function builderAddLogicRule() { builderOpenLogicEditor(-1); }
function builderEditLogicRule(i) { builderOpenLogicEditor(i); }

// Re-read the post questions and parts from the live builder DOM so the rule
// editor's dropdowns include items added/renamed since the builder first
// rendered (S.builderLogic was a stale snapshot — a post question added
// afterwards would never appear as a hide/trigger target).
function builderRefreshLogicRefs() {
  if (!S.builderLogic) return;
  const qs = [...document.querySelectorAll('.builder-question-card')]
    .map(c => ({ id: Number(c.dataset.qid), label: (c.querySelector('.pq-label')?.value || '').trim() }))
    .filter(q => q.id);
  S.builderLogic.questions = qs;
  const ps = [...document.querySelectorAll('.builder-part-card')]
    .map(c => ({ id: c.dataset.partId, label: (c.querySelector('.part-label-input')?.value || c.dataset.partId) }))
    .filter(p => p.id);
  if (ps.length) S.builderLogic.parts = ps;
}

function builderOpenLogicEditor(idx) {
  builderRefreshLogicRefs();
  const ctx = S.builderLogic || { rules: [] };
  const r = idx >= 0 ? JSON.parse(JSON.stringify(ctx.rules[idx]))
    : { id: 'rule-' + Date.now(), label: '', enabled: true, priority: (ctx.rules.length || 0) + 1, timing: 'after_demographics', when: { source: 'demographic', key: '', op: 'eq', value: '' }, action: { type: 'end_study', message: '' } };
  showModal(builderLogicEditorHTML(r, idx));
  builderLogicSyncEditor();
}
function builderLogicEditorHTML(r, idx) {
  const ctx = S.builderLogic || {};
  const w = r.when || {}, a = r.action || {};
  const demoOpts = (ctx.demoQs || []).map(q => `<option value="${esc(q.field_key)}" ${w.key === q.field_key ? 'selected' : ''}>${esc(q.field_key)} — ${esc((q.label || '').slice(0, 40))}</option>`).join('');
  const qOpts = (ctx.questions || []).map(q => `<option value="${q.id}" ${String(w.key) === String(q.id) ? 'selected' : ''}>#${q.id} — ${esc((q.label || '').slice(0, 40))}</option>`).join('');
  const partOpts = (ctx.parts || []).map(p => `<option value="${esc(p.id)}" ${a.target_part_id === p.id ? 'selected' : ''}>${esc(p.label || p.id)}</option>`).join('');
  const opOpts = LOGIC_OPS.map(o => `<option value="${o.v}" ${w.op === o.v ? 'selected' : ''}>${t(o.l)}</option>`).join('');
  return `<h3 style="margin-top:0">${idx >= 0 ? t('konfig.logic_edit_title') : t('konfig.logic_new_title')}</h3>
    <div class="form-group"><label>${t('konfig.logic_f_name')}</label><input type="text" id="lg-label" value="${esc(r.label || '')}" placeholder="${t('konfig.logic_f_name_ph')}"></div>
    <div class="form-group"><label>${t('konfig.logic_f_timing')}</label>
      <select id="lg-timing" onchange="builderLogicSyncEditor()"><option value="after_demographics" ${r.timing === 'after_demographics' ? 'selected' : ''}>${t('konfig.logic_timing_opt_demographics')}</option><option value="after_part" ${r.timing === 'after_part' ? 'selected' : ''}>${t('konfig.logic_timing_opt_part')}</option><option value="after_interaction" ${r.timing === 'after_interaction' ? 'selected' : ''}>${t('konfig.logic_timing_opt_interaction')}</option></select></div>
    <div style="border-top:1px solid var(--border);margin:0.75rem 0 0.5rem;padding-top:0.6rem"><strong style="font-size:0.85rem">${t('konfig.logic_if_header')}</strong></div>
    <div class="form-grid form-grid-2">
      <div class="form-group"><label>${t('konfig.logic_f_source')}</label>
        <select id="lg-source" onchange="builderLogicSyncEditor()">
          <option value="demographic" ${w.source === 'demographic' ? 'selected' : ''}>${t('konfig.logic_src_opt_demographic')}</option>
          <option value="condition" ${w.source === 'condition' ? 'selected' : ''}>${t('konfig.logic_src_opt_condition')}</option>
          <option value="post_question" ${w.source === 'post_question' ? 'selected' : ''}>${t('konfig.logic_src_opt_question')}</option>
          <option value="reaction" ${w.source === 'reaction' ? 'selected' : ''}>${t('konfig.logic_src_opt_reaction')}</option>
        </select></div>
      <div class="form-group" id="lg-key-demo-wrap"><label>${t('konfig.logic_f_demo_field')}</label><select id="lg-key-demo">${demoOpts || `<option value="">${t('konfig.logic_no_demo_qs')}</option>`}</select></div>
      <div class="form-group" id="lg-key-q-wrap"><label>${t('konfig.logic_f_post_question')}</label><select id="lg-key-q">${qOpts || `<option value="">${t('konfig.logic_no_questions')}</option>`}</select></div>
      <div class="form-group"><label>${t('konfig.logic_f_operator')}</label><select id="lg-op" onchange="builderLogicSyncEditor()">${opOpts}</select></div>
      <div class="form-group" id="lg-value-wrap"><label>${t('konfig.logic_f_value')}</label><input type="text" id="lg-value" value="${esc(w.value ?? '')}" placeholder="${t('konfig.logic_f_value_ph')}"></div>
    </div>
    <p id="lg-reaction-hint" style="font-size:0.76rem;color:var(--muted);margin:-0.25rem 0 0.5rem;display:none">${t('konfig.logic_reaction_hint')}</p>
    <div style="border-top:1px solid var(--border);margin:0.75rem 0 0.5rem;padding-top:0.6rem"><strong style="font-size:0.85rem">${t('konfig.logic_then_header')}</strong></div>
    <div class="form-grid form-grid-2">
      <div class="form-group"><label>${t('konfig.logic_f_action')}</label>
        <select id="lg-action" onchange="builderLogicSyncEditor()">
          <option value="end_study" ${a.type === 'end_study' ? 'selected' : ''}>${t('konfig.logic_act_opt_end_study')}</option>
          <option value="skip_part" ${a.type === 'skip_part' ? 'selected' : ''}>${t('konfig.logic_act_opt_skip_part')}</option>
          <option value="goto_part" ${a.type === 'goto_part' ? 'selected' : ''}>${t('konfig.logic_act_opt_goto_part')}</option>
          <option value="hide_question" ${a.type === 'hide_question' ? 'selected' : ''}>${t('konfig.logic_act_opt_hide_question')}</option>
        </select></div>
      <div class="form-group" id="lg-target-wrap"><label>${t('konfig.logic_f_which_part')}</label><select id="lg-target">${partOpts || `<option value="">${t('konfig.logic_no_parts')}</option>`}</select></div>
      <div class="form-group" id="lg-target-q-wrap"><label>${t('konfig.logic_f_which_question')}</label><select id="lg-target-q">${(ctx.questions || []).map(q => `<option value="${q.id}" ${String(a.target_question_id) === String(q.id) ? 'selected' : ''}>#${q.id} — ${esc((q.label || '').slice(0, 40))}</option>`).join('') || `<option value="">${t('konfig.logic_no_questions')}</option>`}</select></div>
    </div>
    <div class="form-group" id="lg-message-wrap"><label>${t('konfig.logic_f_message')}</label><textarea id="lg-message" rows="2" placeholder="${t('konfig.logic_f_message_ph')}">${esc(a.message || '')}</textarea></div>
    <div class="modal-footer" style="display:flex;gap:0.5rem;margin-top:1rem">
      <button class="btn btn-primary" onclick="builderCommitLogicRule(${idx})">${t('konfig.logic_save_rule')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">${t('konfig.logic_cancel')}</button>
    </div>`;
}
function builderLogicSyncEditor() {
  const src = document.getElementById('lg-source')?.value;
  const op = document.getElementById('lg-op')?.value;
  const action = document.getElementById('lg-action')?.value;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('lg-key-demo-wrap', src === 'demographic');
  show('lg-key-q-wrap', src === 'post_question');
  show('lg-reaction-hint', src === 'reaction');
  show('lg-value-wrap', !['empty', 'not_empty'].includes(op));
  show('lg-target-wrap', action === 'skip_part' || action === 'goto_part');
  show('lg-target-q-wrap', action === 'hide_question');
  show('lg-message-wrap', action === 'end_study');
}
function builderCommitLogicRule(idx) {
  const src = document.getElementById('lg-source').value;
  const op = document.getElementById('lg-op').value;
  const action = document.getElementById('lg-action').value;
  const key = src === 'demographic' ? document.getElementById('lg-key-demo').value
    : src === 'post_question' ? document.getElementById('lg-key-q').value : null;
  if (src === 'post_question' && !key) { toast(t('konfig.logic_err_pick_question'), 'error'); return; }
  if ((action === 'skip_part' || action === 'goto_part') && !document.getElementById('lg-target').value) { toast(t('konfig.logic_err_pick_part'), 'error'); return; }
  if (action === 'hide_question' && !document.getElementById('lg-target-q').value) { toast(t('konfig.logic_err_pick_hide_question'), 'error'); return; }
  let action_obj;
  if (action === 'skip_part' || action === 'goto_part') action_obj = { type: action, target_part_id: document.getElementById('lg-target').value };
  else if (action === 'hide_question') action_obj = { type: 'hide_question', target_question_id: document.getElementById('lg-target-q').value };
  else action_obj = { type: 'end_study', message: document.getElementById('lg-message').value.trim() || null };
  const existing = idx >= 0 ? S.builderLogic.rules[idx] : null;
  const rule = {
    id: (existing && existing.id) || 'rule-' + Date.now(),
    label: document.getElementById('lg-label').value.trim() || t('konfig.logic_default_name'),
    enabled: existing ? existing.enabled !== false : true,
    priority: (existing && existing.priority) || (S.builderLogic.rules.length + 1),
    timing: document.getElementById('lg-timing').value,
    when: { source: src, key: key, op: op, value: ['empty', 'not_empty'].includes(op) ? null : document.getElementById('lg-value').value },
    action: action_obj,
  };
  if (idx >= 0) S.builderLogic.rules[idx] = rule; else S.builderLogic.rules.push(rule);
  closeModal();
  builderRenderLogicList();
  builderTriggerAutosave(S.builderLogic.studyId);
}
function builderDeleteLogicRule(i) {
  if (!S.builderLogic) return;
  S.builderLogic.rules.splice(i, 1);
  builderRenderLogicList();
  builderTriggerAutosave(S.builderLogic.studyId);
}
function builderToggleLogicRule(i) {
  const r = S.builderLogic.rules[i]; r.enabled = !(r.enabled !== false);
  builderRenderLogicList();
  builderTriggerAutosave(S.builderLogic.studyId);
}
function builderLogicTemplate(kind) {
  const ctx = S.builderLogic;
  if (!ctx) return;
  if (kind === 'screenout_age') {
    const ageQ = (ctx.demoQs || []).find(q => /wiek|age/i.test(q.field_key) || /wiek|age/i.test(q.label || ''));
    ctx.rules.push({ id: 'rule-' + Date.now(), label: t('konfig.logic_tpl_age_label'), enabled: true, priority: ctx.rules.length + 1, timing: 'after_demographics', when: { source: 'demographic', key: ageQ ? ageQ.field_key : 'age', op: 'lt', value: '18' }, action: { type: 'end_study', message: t('konfig.logic_tpl_age_message') } });
  } else if (kind === 'skip_condition') {
    const p2 = (ctx.parts || [])[1];
    ctx.rules.push({ id: 'rule-' + Date.now(), label: t('konfig.logic_tpl_skip_label'), enabled: true, priority: ctx.rules.length + 1, timing: 'after_part', when: { source: 'condition', key: null, op: 'eq', value: 'A' }, action: { type: 'skip_part', target_part_id: p2 ? p2.id : '' } });
  }
  builderRenderLogicList();
  builderTriggerAutosave(S.builderLogic.studyId);
}

function builderCollectManipulations() {
  // Scope to the manip list by id, NOT #builder-view: the Konfigurator tab
  // relocates this section into #konfig-form-wrap, so a builder-view-scoped query
  // would find nothing and silently wipe the manipulation on save.
  const list = document.getElementById('bld-manip-list');
  if (!list) return [];
  // Only ONE manipulation with exactly TWO arms (A/B) is meaningful — posts only
  // store _a/_b content. Cap here so nothing broken can be persisted.
  return Array.from(list.querySelectorAll('.builder-manip-card')).slice(0, 1).map(card => {
    let field = card.querySelector('.manip-field')?.value || 'headline';
    if (!['headline', 'content', 'image', 'mixed'].includes(field)) field = 'headline';
    const conditions = Array.from(card.querySelectorAll('.manip-cond-row')).slice(0, 2).map((row, i) => ({
      key: i === 0 ? 'A' : 'B',
      label: row.querySelector('.manip-cond-label')?.value || '',
    }));
    if (conditions.length < 2) return null; // a half-defined split isn't a manipulation
    return { id: card.dataset.manipId || ('m' + Date.now()), field, conditions };
  }).filter(Boolean);
}

async function builderPreview(studyId) {
  await builderSave(studyId, true);
  const study = S.studies.find(x => x.id == studyId);
  if (!study?.slug) return toast(t('konfig.save_before_preview'), 'error');

  // Auto-create a dummy post if none exist so preview always works
  const posts = await api('GET', `/studies/${studyId}/posts`);
  const activePosts = (posts || []).filter(p => p.is_active);
  if (!activePosts.length) {
    await api('POST', '/posts', {
      study_id: studyId,
      topic: 'demo',
      emoji: '📋',
      source_name: t('konfig.save_demo_source_name'),
      source_handle: t('konfig.save_demo_source_handle'),
      time_ago: t('konfig.save_demo_time_ago'),
      headline_a: t('konfig.save_demo_headline'),
      content_a: t('konfig.save_demo_content'),
      headline_b: t('konfig.save_demo_headline'),
      content_b: t('konfig.save_demo_content'),
      is_true: 1,
    });
    toast(t('konfig.save_demo_added'));
  }
  window.open(`/study/${study.slug}?preview=1`, '_blank');
}

// Direct preview of the debrief screen — saves the builder first (so the
// latest debrief text + show_debrief_posts toggle are reflected), then opens
// the participant page with ?focus=debrief, which jumps straight to the
// debrief screen without walking the whole study. See startSession in
// participant.js. Sessions are is_preview=1 so they don't pollute data.
async function previewDebrief(studyId) {
  await builderSave(studyId, true);
  const study = S.studies.find(x => x.id == studyId);
  if (!study?.slug) return toast(t('konfig.save_before_preview'), 'error');
  window.open(`/study/${study.slug}?preview=1&focus=debrief`, '_blank');
}

// ── i18n: translate study content ─────────────────────────────────────────

function updateTranslateStatus(s) {
  const el = document.getElementById('es-translate-status');
  if (!el) return;
  const lang = document.getElementById('es-language')?.value || s.language;
  let trans = {};
  try { trans = JSON.parse(s.translations_json || '{}'); } catch {}
  if (trans[lang]) {
    el.innerHTML = `<span style="color:var(--success)">${t('konfig.save_translated')}</span>`;
  } else {
    el.innerHTML = `<span style="color:var(--muted)">${t('konfig.save_no_translation')}</span>`;
  }
}

async function translateStudyContent(studyId) {
  const langSelect = document.getElementById('es-language');
  const lang = langSelect?.value;
  if (!lang || lang === 'pl') return toast(t('konfig.save_lang_not_pl'));

  // Auto-save the selected language before translating so users don't need
  // to click "Zapisz" manually first.
  await api('PATCH', '/studies/' + studyId, { language: lang });

  const btn = document.querySelector('[onclick="translateStudyContent(' + studyId + ')"]');
  if (btn) { btn.disabled = true; btn.textContent = t('translate.translating'); }

  const result = await api('POST', `/studies/${studyId}/translate`, { target_language: lang });

  if (btn) { btn.disabled = false; btn.textContent = t('translate.auto_translate'); }

  if (result?.ok) {
    toast(t('translate.saved_editable'));
    // Reload studies so the updated language field is reflected
    const studies = await api('GET', '/studies');
    if (studies) {
      S.studies = studies;
      // Re-render settings tab — openStudySettings is async, await it so the
      // DOM is ready before we try to show the translation preview
      await openStudySettings(studyId, /* inline= */ true);
      showTranslatedPreview(result.translations);
    }
  }
}

// Builder variant: language dropdown changed → cancel pending autosave (it would
// otherwise save the OLD-language field values under the NEW language key,
// corrupting existing translations), then PATCH only the language switch and
// re-render so each language shows its own translated content.
async function builderUpdateTranslateUI(studyId) {
  const langSel = document.getElementById('bld-lang');
  if (!langSel) return;
  const newLang = langSel.value;
  clearTimeout(_builderSaveTimer);
  try {
    const result = await api('PATCH', `/studies/${studyId}/builder`, { language: newLang });
    // Update local cache with the returned study row so re-render sees new language
    const idx = S.studies.findIndex(x => x.id == studyId);
    if (idx >= 0 && result) S.studies[idx] = { ...S.studies[idx], ...result };
  } catch (_) {}
  await renderBuilderView(studyId);
}

async function builderTranslate(studyId) {
  const lang = document.getElementById('bld-lang')?.value;
  if (!lang || lang === 'pl') { toast(t('translate.pick_non_polish')); return; }

  const btn = document.getElementById('bld-translate-btn');
  const orig = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = t('translate.translating'); }

  try {
    const result = await api('POST', `/studies/${studyId}/translate`, { target_language: lang });
    if (result?.ok) {
      // Refresh in-memory study list so subsequent renders see new translations_json
      const studies = await api('GET', '/studies');
      if (studies) S.studies = studies;
      toast(t('translate.saved'));
      // Re-render the builder so all translatable fields show the translated content
      await renderBuilderView(studyId);
    } else if (btn) {
      btn.innerHTML = orig;
      btn.disabled = false;
    }
  } catch (e) {
    toast(t('translate.error', { msg: e?.message || t('translate.unknown_error') }), 'error');
    if (btn) { btn.innerHTML = orig; btn.disabled = false; }
  }
}

function showTranslatedPreview(translations) {
  const section = document.getElementById('es-translate-section');
  if (!section) return;
  // Remove old preview if any
  const old = section.querySelector('.translate-preview');
  if (old) old.remove();
  const preview = document.createElement('div');
  preview.className = 'translate-preview';
  preview.style.cssText = 'margin-top:0.5rem;padding:0.75rem;background:var(--surface2);border-radius:8px;font-size:0.8rem;line-height:1.8';
  const fields = ['consent_text', 'instruction_text', 'debrief_text', 'label_likert_question', 'label_action_like', 'label_action_dislike', 'label_action_share', 'label_action_flag'];
  const labels = { consent_text: t('translate.field_consent'), instruction_text: t('translate.field_instruction'), debrief_text: t('translate.field_debrief'), label_likert_question: t('translate.field_likert'), label_action_like: t('translate.field_like'), label_action_dislike: t('translate.field_dislike'), label_action_share: t('translate.field_share'), label_action_flag: t('translate.field_flag') };
  preview.innerHTML = `<strong>${t('translate.preview_heading')}</strong><br>` +
    fields.filter(f => translations[f]).map(f =>
      `<span style="color:var(--muted)">${labels[f]}:</span> ${esc(String(translations[f]).substring(0, 80))}${translations[f].length > 80 ? '…' : ''}`
    ).join('<br>');
  if (translations.posts && translations.posts.length) {
    preview.innerHTML += `<br><span style="color:var(--muted)">${t('translate.posts_label')}:</span> ${t('translate.posts_count', { n: translations.posts.length })}`;
  }
  section.appendChild(preview);
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function loadDashboard(studyId) {
  document.getElementById('dashboard-content').innerHTML = '<div class="empty-state">Ładowanie...</div>';
  // Build query string from DB filters (date range + cross-filters) so
  // dashboard refreshes respect the current filter selection.
  const params = [];
  if (DB.dateFrom) params.push('date_from=' + encodeURIComponent(DB.dateFrom));
  if (DB.dateTo)   params.push('date_to='   + encodeURIComponent(DB.dateTo));
  Object.entries(DB.crossFilters || {}).forEach(([k, v]) => {
    params.push('filter_' + encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  const url = `/dashboard/${studyId}` + (params.length ? `?${params.join('&')}` : '');
  const data = await api('GET', url);
  if (!data) return;
  renderDashboard(data, studyId);
}

// ── Cross-filter handlers ──────────────────────────────────────────────────
function dashSetCrossFilter(column, value) {
  // Click a category → set filter; click again on same → clear it (toggle UX)
  if (DB.crossFilters[column] === String(value)) {
    delete DB.crossFilters[column];
  } else {
    DB.crossFilters[column] = String(value);
  }
  loadDashboard(DB.studyId);
}
function dashClearAllCrossFilters() {
  DB.crossFilters = {};
  loadDashboard(DB.studyId);
}

// ── Per-dashboard auto-refresh ─────────────────────────────────────────────
// Light-weight polling: every refreshSec seconds re-fetch dashboard. Cheap
// because everything is computed-on-read; no caching. Set to 0 to disable.
function dashSetRefreshInterval(sec) {
  DB.refreshSec = sec;
  if (DB.refreshTimer) { clearInterval(DB.refreshTimer); DB.refreshTimer = null; }
  if (sec > 0 && DB.studyId) {
    DB.refreshTimer = setInterval(() => loadDashboard(DB.studyId), sec * 1000);
  }
  localStorage.setItem('dash_refresh_sec', String(sec));
}

// ── Public read-only share link ────────────────────────────────────────────
// Posts to /share-link → server returns a JWT-signed URL. Researcher gets
// a one-click copy. Token is stateless: regenerating issues a new one, but
// the previous token still validates until its 30-day expiry (no revocation
// for now — accepted tradeoff for stateless tokens).
async function dashGenerateShareLink() {
  const days = prompt(t('dashboard.share_days_prompt'), '30');
  if (days === null) return;
  const d = Math.max(1, Math.min(parseInt(days, 10) || 30, 365));
  const r = await api('POST', `/studies/${DB.studyId}/share-link`, { days: d });
  if (!r?.token) return;
  const fullUrl = window.location.origin + r.url;
  // Show modal-ish prompt so the researcher can copy easily
  const ok = confirm(
    t('dashboard.share_link_intro', { days: r.expires_days }) + '\n\n' +
    fullUrl + '\n\n' +
    t('dashboard.share_copy_hint')
  );
  if (ok) {
    try { await navigator.clipboard.writeText(fullUrl); toast(t('dashboard.copied')); }
    catch { toast(t('dashboard.copy_manually', { url: fullUrl })); }
  }
}

// ── PDF / PNG export of the dashboard ──────────────────────────────────────
async function dashExportImage(format) {
  if (!window.html2canvas) return toast(t('dashboard.html2canvas_missing'), 'error');
  const target = document.getElementById('dashboard-content');
  if (!target) return;
  toast(t('dashboard.generating', { format: format.toUpperCase() }));
  // Hide edit controls + filter bar for the snapshot — researcher wants
  // a clean output, not buttons
  const hideEls = target.querySelectorAll('.dashboard-actions, .widget-edit-controls, .dashboard-filterbar');
  hideEls.forEach(el => el.style.visibility = 'hidden');
  try {
    const canvas = await window.html2canvas(target, { backgroundColor: '#f4f5fb', scale: 2, useCORS: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const studySlug = S.studies.find(s => s.id == DB.studyId)?.slug || 'dashboard';
    const filename = `${studySlug}_dashboard_${dateStr}.${format}`;
    if (format === 'png') {
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a'); a.href = dataUrl; a.download = filename; a.click();
    } else if (format === 'pdf') {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW - 10;
      const imgH = (canvas.height * imgW) / canvas.width;
      const dataUrl = canvas.toDataURL('image/png');
      // If image is taller than one page, split into multiple pages
      if (imgH <= pageH - 10) {
        pdf.addImage(dataUrl, 'PNG', 5, 5, imgW, imgH);
      } else {
        let y = 0;
        while (y < imgH) {
          if (y > 0) pdf.addPage();
          pdf.addImage(dataUrl, 'PNG', 5, 5 - y, imgW, imgH);
          y += pageH - 10;
        }
      }
      pdf.save(filename);
    }
    toast(t('dashboard.downloaded'));
  } catch (e) {
    toast(t('dashboard.export_error', { msg: e.message }), 'error');
  } finally {
    hideEls.forEach(el => el.style.visibility = '');
  }
}

function renderDashboard(d, studyId) {
  const fmt = v => v != null ? Number(v).toFixed(2) : '–';
  const study = S.studies.find(s => s.id == studyId);
  const slug = study?.slug || '';
  const condLabelMap = buildCondLabelMap(study);

  // Save dashboard data on the global so widget renderers + edit handlers
  // can reach it without re-fetching.
  // Reset refresh timer when switching studies; restore preferred interval
  // from localStorage on first dashboard load of the session.
  if (DB.studyId !== studyId && DB.refreshTimer) { clearInterval(DB.refreshTimer); DB.refreshTimer = null; }
  if (DB.studyId !== studyId) {
    const saved = parseInt(localStorage.getItem('dash_refresh_sec') || '0', 10);
    DB.refreshSec = Number.isFinite(saved) ? saved : 0;
  }
  DB.studyId = studyId;
  DB.data = d;
  DB.widgets = (d.widgets || []).slice(); // working copy for edit mode
  // Sync cross-filter state with what server reflected back (handles browser
  // refresh while filters are active)
  if (d.cross_filters) DB.crossFilters = { ...d.cross_filters };
  // (Re-)arm refresh timer if user previously selected an interval
  if (DB.refreshSec > 0 && !DB.refreshTimer) {
    DB.refreshTimer = setInterval(() => loadDashboard(DB.studyId), DB.refreshSec * 1000);
  }

  // Eye-tracking module — generic across all studies, kept above the widget grid
  const etStats = d.eyetracking_stats;
  const etRow = etStats ? `
    <div class="dashboard-et-row">
      <div class="stat-card et"><div class="stat-value">${etStats.consented}</div><div class="stat-label">${t('dashboard.et_consented')}</div></div>
      <div class="stat-card et"><div class="stat-value">${etStats.declined}</div><div class="stat-label">${t('dashboard.et_declined')}</div></div>
      <div class="stat-card et" title="${t('dashboard.et_calib_failed_hint')}"><div class="stat-value">${etStats.calib_failed ?? 0}</div><div class="stat-label">${t('dashboard.et_calib_failed')}</div></div>
      <div class="stat-card et clickable" onclick="window.open('/admin/heatmap','_blank')"><div class="stat-value">👁</div><div class="stat-label">${t('dashboard.et_open_viewer')}</div></div>
    </div>` : '';

  const recentRows = (d.recent_sessions || []).map(s => `
    <tr>
      <td class="mono">${s.id}${s.is_preview ? ` <span title="${t('dashboard.preview_session')}" style="color:var(--warning,#c97a00);font-size:0.7rem">🧪</span>` : ''}</td>
      <td><span class="badge badge-active" title="${esc(condLabelMap[s.full_condition]?.label || s.full_condition || '')}">
        ${esc(condLabelMap[s.full_condition]?.short || s.full_condition || '–')}</span></td>
      <td>${esc(s.age || '–')}</td>
      <td>${esc(s.gender || '–')}</td>
      <td>${fmt(s.avg_belief_false)}</td>
      <td class="text-muted">${s.completed_at ? s.completed_at.slice(0,16).replace('T',' ') : '–'}</td>
    </tr>`).join('');

  // Header: study link + edit mode toggle + reset + filters + profiles
  const isDefault = d.widgets_is_default;
  document.getElementById('dashboard-content').innerHTML = `
    <div class="dashboard-header">
      <div class="dashboard-url">
        <span class="muted-label">URL:</span>
        <a href="/study/${slug}" target="_blank">/study/${slug}</a>
      </div>
      <div class="dashboard-actions">
        ${isDefault ? `<span class="dashboard-default-badge" title="${t('dashboard.default_layout_hint')}">${t('dashboard.default_badge')}</span>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="dashAddWidget()" id="dash-add-btn" style="display:none">${t('dashboard.add_widget_btn')}</button>
        <button class="btn btn-ghost btn-sm" onclick="dashSaveProfilePrompt()" id="dash-save-profile-btn" style="display:none">${t('dashboard.save_profile')}</button>
        <button class="btn btn-ghost btn-sm" onclick="dashResetDefaults()" id="dash-reset-btn" style="display:none" title="${t('dashboard.reset_hint')}">${t('dashboard.reset')}</button>
        <button class="btn btn-primary btn-sm" onclick="dashToggleEdit()" id="dash-edit-btn">${t('dashboard.edit')}</button>
      </div>
    </div>
    <!-- Filter bar: date range + cross-filters + profile + refresh + export -->
    <div class="dashboard-filterbar">
      <div class="dash-filter-group">
        <label>📅</label>
        <input type="date" id="dash-date-from" value="${esc(DB.dateFrom || '')}" onchange="dashUpdateFilters()">
        <span style="color:var(--muted)">–</span>
        <input type="date" id="dash-date-to" value="${esc(DB.dateTo || '')}" onchange="dashUpdateFilters()">
        <button class="btn btn-ghost btn-xs" onclick="dashSetDateRange(7)" title="${t('dashboard.last_7_days')}">7d</button>
        <button class="btn btn-ghost btn-xs" onclick="dashSetDateRange(30)" title="${t('dashboard.last_30_days')}">30d</button>
        <button class="btn btn-ghost btn-xs" onclick="dashSetDateRange(null)" title="${t('dashboard.all_time')}">∞</button>
      </div>
      ${Object.keys(DB.crossFilters || {}).length ? `
        <div class="dash-filter-group dash-cross-filters">
          <span style="color:var(--muted);font-size:0.75rem">${t('dashboard.filter_label')}</span>
          ${Object.entries(DB.crossFilters).map(([k, v]) => `
            <span class="cross-filter-chip" onclick="dashSetCrossFilter('${esc(k)}', '${esc(v)}')" title="${t('dashboard.click_to_remove')}">
              ${esc(k)} = ${esc(v)} <span class="cross-filter-x">✕</span>
            </span>`).join('')}
          <button class="btn btn-ghost btn-xs" onclick="dashClearAllCrossFilters()">${t('dashboard.clear')}</button>
        </div>` : ''}
      <div class="dash-filter-group" style="margin-left:auto">
        <select id="dash-refresh-select" onchange="dashSetRefreshInterval(Number(this.value))" title="${t('dashboard.auto_refresh')}">
          <option value="0"   ${DB.refreshSec===0?'selected':''}>${t('dashboard.refresh_off')}</option>
          <option value="30"  ${DB.refreshSec===30?'selected':''}>🔄 30s</option>
          <option value="60"  ${DB.refreshSec===60?'selected':''}>🔄 1min</option>
          <option value="300" ${DB.refreshSec===300?'selected':''}>🔄 5min</option>
        </select>
        <select id="dash-profile-select" onchange="dashApplyProfile(this.value)">
          <option value="">${t('dashboard.profile_placeholder')}</option>
          ${Object.keys(d.profiles || {}).map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-xs" onclick="dashExportImage('png')" title="${t('dashboard.png_snapshot')}">🖼 PNG</button>
        <button class="btn btn-ghost btn-xs" onclick="dashExportImage('pdf')" title="${t('dashboard.pdf_export')}">📄 PDF</button>
        <button class="btn btn-ghost btn-xs" onclick="dashGenerateShareLink()" title="${t('dashboard.share_hint')}">${t('dashboard.share')}</button>
      </div>
    </div>
    ${etRow}

    <div class="widget-grid" id="widget-grid"></div>

    <div style="margin-top:2rem">
      <div class="section-title">${t('dashboard.recent_sessions_title')}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t('dashboard.col_condition')}</th><th>${t('dashboard.col_age')}</th><th>${t('dashboard.col_gender')}</th><th>${t('dashboard.col_belief_false')}</th><th>${t('dashboard.col_date')}</th></tr></thead>
          <tbody>${recentRows || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">${t('dashboard.no_data')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
  // Render the widget grid after the DOM is in place so canvas elements exist
  setTimeout(renderWidgetGrid, 0);
}

// ── Dashboard widget renderer ──────────────────────────────────────────────
// Module-level state holds the in-memory widgets list + edit mode flag.
// Charts are tracked so we can destroy them before re-rendering (Chart.js
// leaks if you draw into a canvas that already has an instance).
const DB = {
  studyId: null,
  data: null,
  widgets: [],
  editMode: false,
  charts: {}, // widgetId → Chart instance
  sortable: null, // SortableJS instance for the widget grid (edit mode)
  dateFrom: null, // YYYY-MM-DD or null for "all time"
  dateTo: null,
  crossFilters: {}, // { column_key: value } — click a chart slice to filter all OTHER widgets
  refreshTimer: null, // for per-dashboard auto-refresh interval
  refreshSec: 0,      // 0 = off, >0 = auto-refresh every N seconds
};

// ── Dashboard filters ──────────────────────────────────────────────────────
// Global date range applies to widgets + KPIs + recent sessions table.
// Picked from the filter bar inputs; quick-set buttons (7d / 30d / ∞) update
// the inputs + state in one click.
function dashUpdateFilters() {
  const from = document.getElementById('dash-date-from')?.value || null;
  const to   = document.getElementById('dash-date-to')?.value   || null;
  DB.dateFrom = from || null;
  DB.dateTo   = to   || null;
  loadDashboard(DB.studyId);
}
function dashSetDateRange(daysBack) {
  if (daysBack === null) { DB.dateFrom = null; DB.dateTo = null; }
  else {
    const today = new Date();
    const from = new Date(today); from.setDate(today.getDate() - daysBack);
    const iso = d => d.toISOString().slice(0, 10);
    DB.dateFrom = iso(from);
    DB.dateTo   = iso(today);
  }
  loadDashboard(DB.studyId);
}

// ── Dashboard profiles ─────────────────────────────────────────────────────
function dashApplyProfile(name) {
  if (!name) return;
  const profile = DB.data?.profiles?.[name];
  if (!profile?.widgets) return toast(t('dashboard.profile_no_widgets'), 'error');
  DB.widgets = JSON.parse(JSON.stringify(profile.widgets)); // deep copy
  // Push to server so next load shows this profile + refresh dashboard data
  api('PUT', `/dashboard/${DB.studyId}/config`, { widgets: DB.widgets })
    .then(() => { toast(t('dashboard.profile_loaded', { name })); loadDashboard(DB.studyId); });
}

async function dashSaveProfilePrompt() {
  const name = prompt(t('dashboard.profile_name_prompt'));
  if (!name || !name.trim()) return;
  const r = await api('POST', `/dashboard/${DB.studyId}/profiles`, {
    name: name.trim(), widgets: DB.widgets,
  });
  if (r?.ok) { toast(t('dashboard.profile_saved')); loadDashboard(DB.studyId); }
}

async function dashDeleteProfilePrompt() {
  const names = Object.keys(DB.data?.profiles || {});
  if (!names.length) return;
  const name = prompt(t('dashboard.profile_delete_prompt', { names: names.join(', ') }));
  if (!name || !names.includes(name)) return;
  if (!confirm(t('dashboard.profile_delete_confirm', { name }))) return;
  const r = await api('DELETE', `/dashboard/${DB.studyId}/profiles/${encodeURIComponent(name)}`);
  if (r?.ok) { toast(t('dashboard.profile_deleted')); loadDashboard(DB.studyId); }
}

function dashToggleEdit() {
  DB.editMode = !DB.editMode;
  document.getElementById('dash-add-btn').style.display          = DB.editMode ? '' : 'none';
  document.getElementById('dash-save-profile-btn').style.display = DB.editMode ? '' : 'none';
  document.getElementById('dash-reset-btn').style.display        = DB.editMode ? '' : 'none';
  document.getElementById('dash-edit-btn').textContent           = DB.editMode ? t('dashboard.edit_done') : t('dashboard.edit');
  document.getElementById('dash-edit-btn').className             = DB.editMode ? 'btn btn-success btn-sm' : 'btn btn-primary btn-sm';
  renderWidgetGrid();
}

async function dashResetDefaults() {
  if (!confirm(t('dashboard.reset_confirm'))) return;
  await api('DELETE', `/dashboard/${DB.studyId}/config`);
  toast(t('dashboard.reset_done'));
  loadDashboard(DB.studyId);
}

async function dashSaveConfig(silent) {
  const r = await api('PUT', `/dashboard/${DB.studyId}/config`, { widgets: DB.widgets });
  if (r?.ok && !silent) toast(t('dashboard.saved'));
}

function renderWidgetGrid() {
  const grid = document.getElementById('widget-grid');
  if (!grid) return;
  // Destroy existing Chart.js instances before re-rendering canvases
  Object.values(DB.charts).forEach(ch => { try { ch.destroy(); } catch {} });
  DB.charts = {};

  const widgets = DB.data?.widgets || [];
  if (!widgets.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1 / -1">${t('dashboard.no_widgets')}</div>`;
    return;
  }

  grid.innerHTML = widgets.map((w, idx) => renderWidgetShell(w, idx)).join('');
  // After HTML is in DOM, instantiate charts where the renderer needs a canvas
  widgets.forEach(w => renderWidgetBody(w));
  // Wire SortableJS in edit mode so the drag handle reorders widgets. Tear
  // down any previous instance first to avoid double-binding after re-render.
  if (DB.sortable) { try { DB.sortable.destroy(); } catch {} DB.sortable = null; }
  if (DB.editMode && window.Sortable) {
    DB.sortable = window.Sortable.create(grid, {
      handle: '.widget-drag-handle',
      animation: 180,
      ghostClass: 'widget-drag-ghost',
      onEnd: () => {
        // Read the new order from the DOM and reflect it in DB.widgets,
        // then persist + re-render. We don't need to re-fetch since the
        // widget data hasn't changed — just the order.
        const newOrder = Array.from(grid.querySelectorAll('[data-widget-id]')).map(el => el.dataset.widgetId);
        DB.widgets = newOrder.map(id => DB.widgets.find(w => w.id === id)).filter(Boolean);
        DB.data.widgets = DB.widgets;
        dashSaveConfig(true);
      },
    });
  }
}

function renderWidgetShell(w, idx) {
  // In edit mode show drag handle (SortableJS picks this up) + edit/delete buttons.
  // The ← → arrows are replaced by drag in this iteration — much better UX.
  const hasNote = !!w.annotation;
  const editControls = DB.editMode ? `
    <div class="widget-edit-controls">
      <span class="widget-drag-handle" title="${t('dashboard.drag_to_reorder')}">⋮⋮</span>
      <button class="widget-mini-btn ${hasNote ? 'widget-has-note' : ''}" onclick="dashEditAnnotation('${w.id}')" title="${hasNote ? t('dashboard.note_edit') : t('dashboard.note_add')}">💭</button>
      <button class="widget-mini-btn" onclick="dashEditWidget('${w.id}')" title="${t('dashboard.edit_short')}">✏️</button>
      <button class="widget-mini-btn widget-mini-danger" onclick="dashDeleteWidget('${w.id}')" title="${t('dashboard.delete')}">🗑</button>
    </div>` : (hasNote ? `<button class="widget-note-toggle" onclick="dashToggleNote('${w.id}')" title="${t('dashboard.note_toggle')}">💭</button>` : '');
  // Widget grid sizing — each widget type picks the most readable footprint
  const widthClass = (w.type === 'kpi') ? 'widget-w1'
                   : (w.type === 'pie') ? 'widget-w1'                        // donut + legend reads well at small size
                   : (w.type === 'time_series') ? 'widget-w3'                // full width for trends
                   : (w.type === 'correlation_heatmap' && (w.variables?.length || 0) > 4) ? 'widget-w3'  // large matrices need width
                   : (w.type === 'text_responses') ? 'widget-w3'             // long text wraps better wide
                   : 'widget-w2';                                            // default for bar/hist/cross/scatter/box/heatmap
  return `
    <div class="widget ${widthClass} ${DB.editMode ? 'widget-editing' : ''}" data-widget-id="${esc(w.id)}">
      <div class="widget-header">
        <span class="widget-title">${esc(w.title || t('dashboard.untitled'))}</span>
        ${editControls}
      </div>
      <div class="widget-body" id="widget-body-${esc(w.id)}"></div>
      ${w.annotation ? `<div class="widget-annotation" id="widget-note-${esc(w.id)}">${esc(w.annotation).replace(/\n/g, '<br>')}</div>` : ''}
    </div>`;
}

function dashEditAnnotation(id) {
  const w = DB.widgets.find(x => x.id === id);
  if (!w) return;
  const current = w.annotation || '';
  const isExisting = !!current;

  showModal(`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.85rem">
      <h2 style="margin:0;font-size:1.05rem">${t('dashboard.note_modal_title')}</h2>
      <span style="color:var(--muted);font-size:0.78rem">${esc(w.title || '')}</span>
    </div>
    <textarea id="annot-text" rows="5" style="width:100%;font-family:inherit;font-size:0.88rem;padding:0.55rem 0.7rem;border:1px solid var(--border);border-radius:6px;background:var(--surface2);color:var(--text);resize:vertical"
      placeholder="${t('dashboard.note_placeholder')}">${esc(current)}</textarea>
    <div style="font-size:0.72rem;color:var(--muted);margin-top:0.3rem">${t('dashboard.note_visibility_hint')}</div>
    <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem;padding-top:0.85rem;border-top:1px solid var(--border)">
      <button class="btn btn-ghost btn-sm" onclick="closeModal()">${t('dashboard.cancel')}</button>
      ${isExisting ? `<button class="btn btn-danger btn-sm" onclick="dashSaveAnnotation('${esc(id)}', true)">${t('dashboard.note_delete_btn')}</button>` : ''}
      <button class="btn btn-primary btn-sm" onclick="dashSaveAnnotation('${esc(id)}', false)">💾 ${isExisting ? t('dashboard.save') : t('dashboard.add')}</button>
    </div>
  `);
}

function dashSaveAnnotation(id, deleteIt) {
  const w = DB.widgets.find(x => x.id === id);
  if (!w) return;
  if (deleteIt) {
    delete w.annotation;
  } else {
    const text = document.getElementById('annot-text')?.value?.trim();
    if (!text) {
      // Empty save = also delete (same end state)
      delete w.annotation;
    } else {
      w.annotation = text;
    }
  }
  DB.data.widgets = DB.widgets;
  dashSaveConfig(true);
  closeModal();
  renderWidgetGrid();
  toast(deleteIt ? t('dashboard.note_deleted') : t('dashboard.note_saved'));
}

function dashToggleNote(id) {
  // In view mode, click 💭 toggles visibility of the annotation block
  const el = document.getElementById('widget-note-' + id);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

function renderWidgetBody(w) {
  const body = document.getElementById('widget-body-' + w.id);
  if (!body) return;
  const data = w.data || {};
  if (data.error) {
    // Hard error — bad config or runtime exception. Red box.
    body.innerHTML = `<div class="widget-error">⚠ ${esc(data.error)}</div>`;
    return;
  }
  if (data.empty) {
    // Soft empty state — not enough data yet (e.g. study just launched).
    // Subtle muted message, not alarming red.
    body.innerHTML = `<div class="widget-empty">${esc(data.message || t('dashboard.no_data'))}</div>`;
    return;
  }
  switch (w.type) {
    case 'kpi':                 return renderKpiBody(body, w, data);
    case 'bar_chart':           return renderBarChartBody(body, w, data);
    case 'histogram':           return renderHistogramBody(body, w, data);
    case 'crosstab':            return renderCrosstabBody(body, w, data);
    case 'time_series':         return renderTimeSeriesBody(body, w, data);
    case 'scatter':             return renderScatterBody(body, w, data);
    case 'boxplot':             return renderBoxplotBody(body, w, data);
    case 'pie':                 return renderPieBody(body, w, data);
    case 'correlation_heatmap': return renderCorrelationHeatmapBody(body, w, data);
    case 'text_responses':      return renderTextResponsesBody(body, w, data);
    default:                    body.innerHTML = `<div class="widget-error">${t('dashboard.unknown_type', { type: esc(w.type) })}</div>`;
  }
}

function renderKpiBody(body, w, data) {
  if (data.value == null) {
    body.innerHTML = `<div class="kpi-value">—</div><div class="kpi-sub">${t('dashboard.no_data_lower')}</div>`;
    return;
  }
  let display;
  if (data.format === 'percent') display = data.value.toFixed(1) + '%';
  else if (data.format === 'decimal') display = data.value.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  else display = data.value.toLocaleString('pl-PL');
  body.innerHTML = `<div class="kpi-value">${esc(display)}</div><div class="kpi-sub">${esc(data.subtitle || '')}</div>`;
}

function renderBarChartBody(body, w, data) {
  if (!data.categories?.length) { body.innerHTML = `<div class="widget-empty">${t('dashboard.no_data')}</div>`; return; }
  body.innerHTML = `<div class="widget-chart-wrap"><canvas></canvas></div>
    ${data.test_result ? `<div class="widget-stat">${esc(formatStatResult(data.test_result))}</div>` : ''}`;
  const canvas = body.querySelector('canvas');
  if (!window.Chart) { body.innerHTML += `<div class="widget-empty">${t('dashboard.chartjs_missing')}</div>`; return; }
  // When the aggregator is count/sum the Y axis is integer-valued — force
  // integer ticks so we don't render 0.2, 0.4… when all values are 0/low.
  const yIsInt = data.aggregator === 'count' || data.aggregator === 'sum';
  DB.charts[w.id] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.categories,
      datasets: [{
        label: data.aggregator + (data.value_var ? ` (${data.value_var})` : ''),
        data: data.values,
        backgroundColor: data.categories.map(cat =>
          DB.crossFilters[data.group_var] === String(cat) ? 'rgba(34,197,94,0.85)' : 'rgba(79,124,255,0.65)'),
        borderColor: 'rgba(79,124,255,1)',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: yIsInt ? { stepSize: 1, precision: 0 } : {} } },
      // Click on a bar → toggle cross-filter on (group_var = that category).
      // All OTHER widgets re-render filtered to that subset on next loadDashboard.
      onClick: (evt, elements) => {
        if (!elements.length || !data.group_var) return;
        const cat = data.categories[elements[0].index];
        dashSetCrossFilter(data.group_var, cat);
      },
    },
  });
}

function renderHistogramBody(body, w, data) {
  if (!data.counts?.length) { body.innerHTML = `<div class="widget-empty">${t('dashboard.no_data')}</div>`; return; }
  const labels = data.bin_edges.slice(0, -1).map((e, i) => `${e}–${data.bin_edges[i+1]}`);
  body.innerHTML = `<div class="widget-chart-wrap"><canvas></canvas></div>
    <div class="widget-stat">M = ${data.mean}, SD = ${data.sd}, Md = ${data.median}, N = ${data.n}</div>`;
  const canvas = body.querySelector('canvas');
  if (!window.Chart) return;
  DB.charts[w.id] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: data.variable, data: data.counts, backgroundColor: 'rgba(124,58,237,0.6)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } }, // bin counts are integers
    },
  });
}

function renderCrosstabBody(body, w, data) {
  const rows = data.row_categories || [];
  const cols = data.col_categories || [];
  const obs = data.observed || [];
  const pct = data.pct;
  body.innerHTML = `
    <div class="widget-table-wrap">
      <table class="widget-table">
        <thead><tr><th></th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}<th>Σ</th></tr></thead>
        <tbody>
          ${rows.map((rv, i) => `<tr><th>${esc(rv)}</th>${cols.map((_, j) => `
            <td>${obs[i][j]}${pct ? ` <small>(${pct[i][j]}%)</small>` : ''}</td>
          `).join('')}<td>${data.row_totals[i]}</td></tr>`).join('')}
          <tr class="widget-table-total"><th>Σ</th>${cols.map((_, j) => `<td>${data.col_totals[j]}</td>`).join('')}<td>${data.grand_total}</td></tr>
        </tbody>
      </table>
    </div>
    ${data.chi2_result ? `<div class="widget-stat">χ²(${data.chi2_result.df}) = ${data.chi2_result.chi2}, p = ${data.chi2_result.p}, V = ${data.chi2_result.cramers_v}${data.chi2_result.warning ? ' ⚠' : ''}</div>` : ''}`;
}

function renderTimeSeriesBody(body, w, data) {
  body.innerHTML = `<div class="widget-chart-wrap"><canvas></canvas></div>
    <div class="widget-stat">${t('dashboard.ts_summary', { total: data.total, metric: data.metric === 'completed' ? t('dashboard.ts_completed') : t('dashboard.ts_started'), count: data.dates.length, unit: data.granularity === 'day' ? t('dashboard.ts_days') : data.granularity === 'week' ? t('dashboard.ts_weeks') : t('dashboard.ts_months') })}</div>`;
  const canvas = body.querySelector('canvas');
  if (!window.Chart) return;
  DB.charts[w.id] = new Chart(canvas, {
    type: 'line',
    data: { labels: data.dates, datasets: [{ label: data.metric, data: data.counts, fill: true, backgroundColor: 'rgba(34,197,94,0.15)', borderColor: 'rgba(34,197,94,1)', tension: 0.2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      // Session counts are integers — force integer ticks so we never show 0.2, 0.4…
      // when all days are 0 or low. suggestedMax keeps the axis from collapsing to a sliver.
      scales: { y: { beginAtZero: true, suggestedMax: 5, ticks: { stepSize: 1, precision: 0 } } },
    },
  });
}

// ── Scatter plot ───────────────────────────────────────────────────────────
function renderScatterBody(body, w, data) {
  body.innerHTML = `<div class="widget-chart-wrap"><canvas></canvas></div>
    ${data.r != null ? `<div class="widget-stat">r = ${data.r} (n = ${data.n})</div>` : `<div class="widget-stat">n = ${data.n}</div>`}`;
  const canvas = body.querySelector('canvas');
  if (!window.Chart) return;
  // Color-by support: split points into groups, one dataset per category
  let datasets;
  if (data.color_by) {
    const buckets = {};
    data.points.forEach(p => { (buckets[p.group ?? t('dashboard.group_none')] ||= []).push({ x: p.x, y: p.y }); });
    const palette = ['rgba(79,124,255,0.7)','rgba(239,68,68,0.7)','rgba(22,163,74,0.7)','rgba(245,158,11,0.7)','rgba(168,85,247,0.7)'];
    datasets = Object.entries(buckets).map(([label, pts], i) => ({
      label, data: pts, backgroundColor: palette[i % palette.length], pointRadius: 3,
    }));
  } else {
    datasets = [{ label: w.variable_y, data: data.points.map(p => ({ x: p.x, y: p.y })), backgroundColor: 'rgba(79,124,255,0.65)', pointRadius: 3 }];
  }
  DB.charts[w.id] = new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: !!data.color_by } },
      scales: {
        x: { title: { display: true, text: data.variable_x } },
        y: { title: { display: true, text: data.variable_y } },
      },
    },
  });
}

// ── Boxplot — drawn as inline SVG (no chart.js plugin needed) ─────────────
function renderBoxplotBody(body, w, data) {
  const stats = data.stats || [];
  if (!stats.length) { body.innerHTML = `<div class="widget-empty">${t('dashboard.no_data')}</div>`; return; }
  // Find global y range across all groups including outliers
  const allVals = stats.flatMap(s => [s.min, s.max, ...(s.outliers || [])]).filter(v => v != null);
  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const padY = (yMax - yMin) * 0.08 || 1;
  const W = 600, H = 220, padL = 50, padR = 12, padT = 12, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const yScale = v => padT + plotH * (1 - (v - (yMin - padY)) / ((yMax + padY) - (yMin - padY)));
  const groupW = plotW / stats.length;
  const boxW = Math.min(40, groupW * 0.5);

  const boxes = stats.map((s, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const x1 = cx - boxW / 2, x2 = cx + boxW / 2;
    const yMinPx = yScale(s.min ?? s.q1);
    const yMaxPx = yScale(s.max ?? s.q3);
    const yQ1 = yScale(s.q1);
    const yQ3 = yScale(s.q3);
    const yMed = yScale(s.median);
    const outlierCircles = (s.outliers || []).map(v => `<circle cx="${cx}" cy="${yScale(v)}" r="2.5" fill="#ef4444" opacity="0.7"/>`).join('');
    return `
      <line x1="${cx}" x2="${cx}" y1="${yMinPx}" y2="${yQ3}" stroke="#3b4a8a" stroke-width="1"/>
      <line x1="${cx}" x2="${cx}" y1="${yQ1}" y2="${yMaxPx}" stroke="#3b4a8a" stroke-width="1"/>
      <line x1="${x1}" x2="${x2}" y1="${yMinPx}" y2="${yMinPx}" stroke="#3b4a8a" stroke-width="1"/>
      <line x1="${x1}" x2="${x2}" y1="${yMaxPx}" y2="${yMaxPx}" stroke="#3b4a8a" stroke-width="1"/>
      <rect x="${x1}" y="${yQ3}" width="${boxW}" height="${yQ1 - yQ3}" fill="rgba(79,124,255,0.25)" stroke="#3b4a8a" stroke-width="1.5"/>
      <line x1="${x1}" x2="${x2}" y1="${yMed}" y2="${yMed}" stroke="#1a1f3d" stroke-width="2"/>
      ${outlierCircles}
      <text x="${cx}" y="${H - 12}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(s.label)}</text>
      <text x="${cx}" y="${H - 1}" text-anchor="middle" font-size="9" fill="var(--muted)">n=${s.n}</text>
    `;
  }).join('');

  // Y-axis gridlines (4 ticks)
  const ticks = []; for (let i = 0; i <= 4; i++) ticks.push(yMin - padY + (yMax + padY - (yMin - padY)) * i / 4);
  const gridlines = ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${yScale(t)}" y2="${yScale(t)}" stroke="var(--border)" stroke-width="0.5"/>
    <text x="${padL - 6}" y="${yScale(t) + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${Number(t.toFixed(1))}</text>`).join('');

  body.innerHTML = `
    <div class="widget-chart-wrap" style="height:auto">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;max-height:240px">
        ${gridlines}
        ${boxes}
      </svg>
    </div>
    <div class="widget-stat">${data.variable}${data.group_by ? ' ' + t('dashboard.by') + ' ' + data.group_by : ''} — ${stats.length} ${stats.length === 1 ? t('dashboard.group_one') : t('dashboard.group_many')}</div>`;
}

// ── Pie / donut ────────────────────────────────────────────────────────────
function renderPieBody(body, w, data) {
  body.innerHTML = `<div class="widget-chart-wrap"><canvas></canvas></div>
    <div class="widget-stat">${data.variable} — N = ${data.n}, ${data.categories.length} ${data.categories.length === 1 ? t('dashboard.category_one') : t('dashboard.category_many')}</div>`;
  const canvas = body.querySelector('canvas');
  if (!window.Chart) return;
  const palette = ['#4f7cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#6366f1', '#f97316'];
  DB.charts[w.id] = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: data.categories,
      datasets: [{
        data: data.counts,
        backgroundColor: data.categories.map((cat, i) =>
          DB.crossFilters[data.variable] === String(cat) ? '#22c55e' : palette[i % palette.length]),
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} (${data.pct[ctx.dataIndex]}%)` } },
      },
      // Click slice → cross-filter on this variable + slice category
      onClick: (evt, elements) => {
        if (!elements.length || !data.variable) return;
        const cat = data.categories[elements[0].index];
        dashSetCrossFilter(data.variable, cat);
      },
    },
  });
}

// ── Correlation heatmap — colored grid ────────────────────────────────────
function renderCorrelationHeatmapBody(body, w, data) {
  const labels = data.labels || data.variables;
  // Color scale: -1 → red, 0 → white, +1 → blue
  const colorFor = r => {
    if (r == null) return 'transparent';
    const v = Math.max(-1, Math.min(1, r));
    if (v >= 0) {
      const a = v * 0.7; // intensity
      return `rgba(79,124,255,${a})`;
    }
    const a = -v * 0.7;
    return `rgba(239,68,68,${a})`;
  };
  body.innerHTML = `
    <div class="widget-table-wrap">
      <table class="widget-table widget-heatmap">
        <thead><tr><th></th>${labels.map(l => `<th>${esc(l)}</th>`).join('')}</tr></thead>
        <tbody>
          ${labels.map((rv, i) => `<tr><th>${esc(rv)}</th>${labels.map((_, j) => {
            const r = data.r[i][j];
            const p = data.p[i][j];
            const sig = p != null && p < 0.05;
            return `<td style="background:${colorFor(r)};${sig ? 'font-weight:700' : ''}" title="r=${r}, p=${p}">${r != null ? r.toFixed(2) : '—'}</td>`;
          }).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="widget-stat">${data.method === 'spearman' ? 'r_s (Spearman)' : 'r (Pearson)'} · ${t('dashboard.heatmap_sig_note')}</div>`;
}

// ── Text responses — scrollable list ──────────────────────────────────────
function renderTextResponsesBody(body, w, data) {
  const responses = data.responses || [];
  body.innerHTML = `
    <div class="widget-text-list">
      ${responses.map(r => `
        <div class="widget-text-item">
          <span class="widget-text-meta">#${esc(r.session_id || '?')}${r.group ? ` · ${esc(r.group)}` : ''}</span>
          <div class="widget-text-body">${esc(r.text)}</div>
        </div>`).join('')}
    </div>
    <div class="widget-stat">${t('dashboard.responses_count', { n: data.total })} (${data.variable})</div>`;
}

function formatStatResult(r) {
  if (!r) return '';
  if (r.test === 'ANOVA') return `F(${r.df}) = ${r.F}, p = ${r.p}, η² = ${r.eta_sq}`;
  if (r.test === 't')     return `t(${r.df}) = ${r.t}, p = ${r.p}, d = ${r.cohens_d}`;
  return JSON.stringify(r);
}

// ── Dashboard edit-mode actions ────────────────────────────────────────────
// dashMoveWidget kept as a fallback for the keyboard-accessible reorder
// (Tab to widget header, future enhancement) but not used in the UI anymore
// — SortableJS replaces the ← → buttons.
function dashMoveWidget(id, dir) {
  const i = DB.widgets.findIndex(w => w.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= DB.widgets.length) return;
  [DB.widgets[i], DB.widgets[j]] = [DB.widgets[j], DB.widgets[i]];
  DB.data.widgets = DB.widgets;
  dashSaveConfig(true);
  renderWidgetGrid();
}

async function dashDeleteWidget(id) {
  const w = DB.widgets.find(x => x.id === id);
  if (!w) return;
  if (!confirm(t('dashboard.widget_delete_confirm', { title: w.title || w.type }))) return;
  DB.widgets = DB.widgets.filter(x => x.id !== id);
  DB.data.widgets = DB.widgets;
  await dashSaveConfig(true);
  renderWidgetGrid();
}

// Add + Edit widget — open a wizard modal. Both use the same form shape.
function dashAddWidget()  { openWidgetWizard(null); }
function dashEditWidget(id) { openWidgetWizard(id); }


// ── Post Editor ────────────────────────────────────────────────────────────
const TOPICS = ['zdrowie', 'klimat', 'polityka', 'ekonomia', 'nauka'];
const TECHNIQUES = ['pilność', 'fałszywy ekspert', 'spisek', 'liczby bez źródła', 'emocjonalne słowa', 'kozioł ofiarny'];
const TOPIC_CLASS = { zdrowie: 'topic-zdrowie', klimat: 'topic-klimat', polityka: 'topic-polityka', ekonomia: 'topic-ekonomia', nauka: 'topic-nauka' };


document.getElementById('btn-add-post').onclick = async () => {
  const studyId = S.activeStudy || S.selectedPostsStudy;
  if (!studyId) return toast(t('dashboard.select_study'), 'error');
  const data = await api('POST', '/posts', { study_id: Number(studyId) });
  if (!data) return;
  toast(t('dashboard.new_post_added'));
  await loadPosts(studyId);
  // Expand the new post
  setTimeout(() => {
    const row = document.querySelector(`[data-post-id="${data.id}"]`);
    if (row && !row.classList.contains('expanded')) row.querySelector('.post-row-header').click();
    row?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
};

async function loadPosts(studyId) {
  document.getElementById('posts-list').innerHTML = `<div class="empty-state">${t('posts.loading')}</div>`;
  const posts = await api('GET', `/studies/${studyId}/posts`);
  if (!posts) return;
  renderPosts(Array.isArray(posts) ? posts : []);
}

function renderPosts(posts) {
  S.currentPosts = posts;
  const container = document.getElementById('posts-list');
  if (!posts.length) {
    container.innerHTML = `<div class="empty-state">${t('posts.no_posts')}</div>`;
    return;
  }
  container.innerHTML = posts.map(p => postRowHTML(p)).join('');
}

function postRowHTML(p) {
  const techs = (() => { try { return JSON.parse(p.manipulation_techniques || '[]'); } catch { return []; } })();
  const topicCls = TOPIC_CLASS[p.topic] || 'topic-nauka';
  return `
    <div class="post-row" data-post-id="${p.id}" id="post-row-${p.id}">
      <div class="post-row-header" onclick="togglePostRow(${p.id})">
        <span class="post-order">${p.order_index}.</span>
        <div class="post-row-title">
          <span class="post-source-label">${esc(p.source_name || '—')}</span>
          <span style="color:var(--muted);font-size:0.8rem;margin-left:0.5rem">${esc(p.source_handle || '')}</span>
          ${p.updated_at ? `<span class="post-updated-at" title="${t('posts.last_edit')}">✏️ ${p.updated_at.slice(0,16).replace('T',' ')}</span>` : ''}
        </div>
        <span class="post-topic-badge ${topicCls}">${esc(p.emoji || '')} ${esc(p.topic || '')}</span>
        <span class="post-type-badge ${p.is_true ? 'type-true' : 'type-false'}">${p.is_true ? t('posts.true') : t('posts.false')}</span>
        <span class="badge ${p.is_active ? 'badge-active' : 'badge-inactive'}">${p.is_active ? t('posts.active') : t('posts.hidden')}</span>
        <div class="post-row-actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" title="${t('posts.preview_post_title')}" onclick="previewPost(${p.id})" style="font-size:0.78rem;padding:0.3rem 0.6rem">${t('posts.preview_btn')}</button>
          <button class="btn btn-ghost btn-sm" title="${t('posts.to_library_title')}" onclick="promotePostToLibrary(${p.id})" style="font-size:0.78rem;padding:0.3rem 0.6rem">${t('posts.to_library_btn')}</button>
          <button class="btn btn-ghost btn-icon" title="${t('posts.move_up')}" onclick="reorderPost(${p.id},'up')">↑</button>
          <button class="btn btn-ghost btn-icon" title="${t('posts.move_down')}" onclick="reorderPost(${p.id},'down')">↓</button>
          <button class="btn btn-danger btn-icon" title="${t('posts.delete_post_title')}" onclick="deletePost(${p.id})">🗑</button>
        </div>
        <span class="expand-icon">▼</span>
      </div>
      <div class="post-row-body" id="post-body-${p.id}">
        ${postFormHTML(p, techs)}
      </div>
    </div>`;
}

// ── Post library ─────────────────────────────────────────────────────────────
// A study-agnostic catalogue of reusable posts. "🗂 Do biblioteki" promotes a
// study post into the catalogue (copy — the study post stays put); the picker
// ("🗂 Z biblioteki" in the Posty toolbar) copies a catalogue post into the
// current study. Copies are independent — editing one never touches the other.

// Promote a study post → library. No prompts — the researcher recognises posts
// by their source + headline, so we derive a sensible label automatically and
// add the post straight to the catalogue. category is set silently to the post's
// topic so the picker's category filter still works.
async function promotePostToLibrary(postId) {
  const post = (S.currentPosts || []).find(p => p.id === postId);
  const res = await api('POST', `/posts/${postId}/to-library`, {
    name: libraryAutoName(post),
    category: (post && post.topic) ? post.topic : null,
  });
  if (!res) return;
  toast(t('posts.saved_to_library'));
}

// Build a human-readable library label from a post: "źródło · temat", else the
// source, else the topic, else a trimmed headline, else a generic fallback.
function libraryAutoName(post) {
  if (!post) return 'Post';
  const src = (post.source_name || '').trim();
  const topic = (post.topic || '').trim();
  if (src && topic) return `${src} · ${topic}`;
  if (src) return src;
  if (topic) return topic;
  const head = (post.headline_a || '').trim();
  if (head) return head.length > 60 ? head.slice(0, 57) + '…' : head;
  return 'Post';
}

// Open the library picker modal for the currently selected study.
async function openPostLibrary() {
  const studyId = S.activeStudy || S.selectedPostsStudy;
  if (!studyId) return toast(t('posts.pick_study_first'), 'error');
  S.libraryTargetStudy = studyId;
  showModal(`<div class="modal-section-title">${t('posts.lib_title')}</div><div class="empty-state">${t('posts.loading_ellipsis')}</div>`);
  await renderPostLibrary();
}

async function renderPostLibrary(category) {
  const list = await api('GET', `/post-library${category ? `?category=${encodeURIComponent(category)}` : ''}`);
  if (!list) return;
  S.libraryItems = list;
  const cats = [...new Set(list.map(i => i.category).filter(Boolean))].sort();
  const catBar = cats.length ? `
    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin:0.5rem 0 1rem">
      <button class="btn btn-sm ${!category ? 'btn-primary' : 'btn-ghost'}" onclick="renderPostLibrary()">${t('posts.lib_all')}</button>
      ${cats.map(c => `<button class="btn btn-sm ${category === c ? 'btn-primary' : 'btn-ghost'}" onclick="renderPostLibrary('${esc(c).replace(/'/g, "\\'")}')">${esc(c)}</button>`).join('')}
    </div>` : '';

  const cards = list.length ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:0.75rem">
      ${list.map(libCardHTML).join('')}
    </div>` : `<div class="empty-state">${t('posts.lib_empty')}</div>`;

  showModal(`
    <div class="modal-section-title">${t('posts.lib_title')}</div>
    <p style="color:var(--muted);font-size:0.85rem;margin:0.25rem 0 0">${t('posts.lib_hint')}</p>
    ${catBar}
    ${cards}
    <div class="modal-footer" style="display:flex;justify-content:flex-end;margin-top:1rem">
      <button class="btn btn-ghost" onclick="closeModal()">${t('posts.close')}</button>
    </div>`);
}

function libCardHTML(i) {
  // Thumbnail fills a fixed 160px band (object-fit:cover crops to fill, upscaling
  // small source images so they're actually visible). The PRAWDA/FAŁSZ badge is
  // pinned to the top-right corner over the image.
  const thumb = i.has_image
    ? `<img src="/api/admin/post-library/${i.id}/image" alt="" style="display:block;width:100%;height:160px;object-fit:cover">`
    : `<div style="width:100%;height:160px;display:flex;align-items:center;justify-content:center;font-size:2.6rem;background:var(--bg)">📰</div>`;
  const typeBadge = i.is_true
    ? `<span class="post-type-badge type-true" style="position:absolute;top:8px;right:8px;box-shadow:0 1px 3px rgba(0,0,0,.25)">${t('posts.true')}</span>`
    : `<span class="post-type-badge type-false" style="position:absolute;top:8px;right:8px;box-shadow:0 1px 3px rgba(0,0,0,.25)">${t('posts.false')}</span>`;
  return `
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;background:var(--surface)">
      <div style="position:relative">
        ${thumb}
        ${typeBadge}
      </div>
      <div style="padding:0.6rem;display:flex;flex-direction:column;gap:0.3rem;flex:1">
        <div style="font-weight:600;font-size:0.9rem;line-height:1.25">${esc(i.name)}</div>
        ${i.source_name ? `<div style="color:var(--muted);font-size:0.78rem">${esc(i.source_name)}${i.source_handle ? ' · ' + esc(i.source_handle) : ''}</div>` : ''}
        ${i.headline_a ? `<div style="font-size:0.8rem;line-height:1.3;max-height:2.6em;overflow:hidden">${esc(i.headline_a)}</div>` : ''}
        <div style="display:flex;gap:0.35rem;margin-top:auto;padding-top:0.5rem">
          <button class="btn btn-primary btn-sm" style="flex:1;font-size:0.78rem" onclick="libraryAddToStudy(${i.id})">${t('posts.lib_add')}</button>
          <button class="btn btn-danger btn-sm" title="${t('posts.lib_delete_title')}" onclick="libraryDelete(${i.id})">🗑</button>
        </div>
      </div>
    </div>`;
}

async function libraryAddToStudy(libId) {
  const studyId = S.libraryTargetStudy;
  if (!studyId) return toast(t('posts.no_study_selected'), 'error');
  const res = await api('POST', `/studies/${studyId}/posts/from-library`, { library_post_id: libId });
  if (!res) return;
  toast(t('posts.lib_copied'));
  closeModal();
  if (studyId == (S.activeStudy || S.selectedPostsStudy)) await loadPosts(studyId);
}

async function libraryDelete(libId) {
  const item = (S.libraryItems || []).find(i => i.id === libId);
  if (!confirm(t('posts.lib_delete_confirm', { name: item ? item.name : t('posts.lib_this_template') }))) return;
  const res = await api('DELETE', `/post-library/${libId}`);
  if (!res) return;
  toast(t('posts.lib_deleted'));
  await renderPostLibrary();
}

const _btnPostLibrary = document.getElementById('btn-post-library');
if (_btnPostLibrary) _btnPostLibrary.onclick = openPostLibrary;

function builderPostFormHTML(p, study, topicOpts) {
  let manipulations = [];
  try { manipulations = JSON.parse(study.manipulation_json || '[]'); } catch {}

  // A manipulation is "active" only when it has at least 2 named conditions
  const primaryManip = manipulations.find(m => m.field && m.field !== 'none' && m.conditions?.length >= 2);
  const condA = primaryManip?.conditions[0];
  const condB = primaryManip?.conditions[1];

  // Single image upload (no A/B label)
  const imgUpload = (variant, existingPath) => `
    <div class="image-upload-area" onclick="document.getElementById('pf-img-input-${p.id}-${variant}').click()">
      <input type="file" id="pf-img-input-${p.id}-${variant}" accept="image/jpeg,image/png,image/webp"
             onchange="handleImageUpload(${p.id}, '${variant}', this)">
      <img class="image-preview" id="img-preview-${p.id}-${variant}"
           ${existingPath ? `src="/uploads/${p.study_id}/${esc(existingPath)}"` : 'style="display:none"'} alt="">
      <div class="image-upload-label">${t('posts.img_click_choose')}</div>
    </div>
    <button type="button" class="btn btn-danger btn-sm" id="img-del-btn-${p.id}-${variant}"
            style="margin-top:0.3rem;${existingPath ? '' : 'display:none'}"
            onclick="deletePostImage(${p.id},'${variant}')">${t('posts.img_delete')}</button>`;

  let contentHTML;
  if (primaryManip) {
    // Two named variant sections — labelled by condition names
    contentHTML = `
      <div class="form-section-title">${t('posts.condition_heading', { key: esc(condA.key), label: esc(condA.label || condA.key) })}</div>
      <div class="form-group"><label>${t('posts.headline')}</label><textarea id="pf-ha-${p.id}" rows="2">${esc(p.headline_a||'')}</textarea></div>
      <div class="form-group"><label>${t('posts.content')}</label><textarea id="pf-ca-${p.id}" rows="3">${esc(p.content_a||'')}</textarea></div>
      <div class="form-section-title" style="margin-top:0.5rem">${t('posts.image_for', { label: esc(condA.label || condA.key) })}</div>
      ${imgUpload('a', p.image_path_a)}

      <div class="form-section-title" style="margin-top:1rem">${t('posts.condition_heading', { key: esc(condB.key), label: esc(condB.label || condB.key) })}</div>
      <div class="form-group"><label>${t('posts.headline')}</label><textarea id="pf-hb-${p.id}" rows="2">${esc(p.headline_b||'')}</textarea></div>
      <div class="form-group"><label>${t('posts.content')}</label><textarea id="pf-cb-${p.id}" rows="3">${esc(p.content_b||'')}</textarea></div>
      <div class="form-section-title" style="margin-top:0.5rem">${t('posts.image_for', { label: esc(condB.label || condB.key) })}</div>
      ${imgUpload('b', p.image_path_b)}`;
  } else {
    // No manipulation — plain post, no conditions, no A/B anywhere
    contentHTML = `
      <div class="form-group"><label>${t('posts.headline')}</label><textarea id="pf-ha-${p.id}" rows="2">${esc(p.headline_a||'')}</textarea></div>
      <div class="form-group"><label>${t('posts.content')}</label><textarea id="pf-ca-${p.id}" rows="3">${esc(p.content_a||'')}</textarea></div>
      <div class="form-section-title" style="margin-top:0.5rem">${t('posts.image')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.optional_n')}</span></div>
      ${imgUpload('a', p.image_path_a)}
      <input type="hidden" id="pf-hb-${p.id}">
      <input type="hidden" id="pf-cb-${p.id}">`;
  }

  // Parts picker — only shown when the study has 2+ parts. Multi-select so
  // one post can appear in several parts (e.g. part 1 = feed for reactions,
  // part 2 = paged with questions on the same posts). part_ids_json is the
  // canonical storage; part_id stays in sync server-side (= first element)
  // so legacy exports / queries keep working.
  let partsForPicker = [];
  try { partsForPicker = JSON.parse(study?.parts_json || '[]'); } catch {}
  // Resolve current selection: prefer part_ids_json (multi), fall back to
  // single part_id (legacy posts created before this feature existed).
  let currentPartIds = [];
  try {
    const parsed = JSON.parse(p.part_ids_json || '[]');
    if (Array.isArray(parsed)) currentPartIds = parsed.filter(Boolean);
  } catch {}
  if (!currentPartIds.length && p.part_id) currentPartIds = [p.part_id];
  // 1-based prefix on each label exposes the flow position alongside the
  // researcher-chosen label — avoids "I picked Część 2 but the post showed
  // first" confusion when parts are reordered or labeled out-of-order.
  const partsCheckboxes = partsForPicker.length >= 2
    ? partsForPicker.map((part, i) => `
        <label class="parts-multi-checkbox" style="display:inline-flex;align-items:center;gap:0.4rem;padding:0.35rem 0.7rem;background:var(--bg-elevated,#f5f5f5);border:1px solid var(--border,#ddd);border-radius:6px;cursor:pointer;margin:0.15rem 0.3rem 0.15rem 0;font-size:0.875rem">
          <input type="checkbox" class="pf-part-cb-${p.id}" value="${esc(part.id || '')}" ${currentPartIds.includes(part.id) ? 'checked' : ''}>
          <span>${i + 1}. ${esc(part.label || part.id)}</span>
        </label>`).join('')
    : '';

  return `
    <div class="form-section-title">${t('posts.basics')}</div>
    <div class="form-grid">
      <div class="form-group"><label>${t('posts.topic')}</label><select id="pf-topic-${p.id}">${topicOpts}</select></div>
      <div class="form-group"><label>${t('posts.emoji')}</label><input type="text" id="pf-emoji-${p.id}" value="${esc(p.emoji||'')}"></div>
      <div class="form-group"><label>${t('posts.source_name')}</label><input type="text" id="pf-src-${p.id}" value="${esc(p.source_name||'')}"></div>
      <div class="form-group"><label>${t('posts.handle')}</label><input type="text" id="pf-handle-${p.id}" value="${esc(p.source_handle||'')}"></div>
      <div class="form-group"><label>${t('posts.time_ago')}</label><input type="text" id="pf-time-${p.id}" value="${esc(p.time_ago||'')}"></div>
      ${partsCheckboxes ? `<div class="form-group" id="pf-parts-wrap-${p.id}" style="grid-column:1/-1"><label>${t('posts.study_parts')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.parts_hint')}</span></label><div style="display:flex;flex-wrap:wrap;gap:0;margin-top:0.25rem">${partsCheckboxes}</div><div style="font-size:0.75rem;color:var(--muted);margin-top:0.35rem">${t('posts.parts_none_hint')}</div></div>` : ''}
      <div style="display:flex;gap:1.5rem;align-items:flex-end;padding-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-true-${p.id}" ${p.is_true?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('posts.is_true_label')}</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-active-${p.id}" ${p.is_active?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('posts.active')}</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-ht-${p.id}" ${p.hide_topic?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('posts.hide_topic')}</span>
        </div>
      </div>
    </div>

    ${contentHTML}

    <div class="form-section-title" style="margin-top:1rem">${t('posts.social_interactions')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.zero_hides')}</span></div>
    <div class="form-grid form-grid-4">
      <div class="form-group"><label>${t('posts.likes')}</label><input type="number" id="pf-likes-${p.id}" value="${p.base_likes||0}" min="0"></div>
      <div class="form-group"><label>${t('posts.shares')}</label><input type="number" id="pf-shares-${p.id}" value="${p.base_shares||0}" min="0"></div>
      <div class="form-group"><label>${t('posts.dislikes')}</label><input type="number" id="pf-dislikes-${p.id}" value="${p.base_dislikes||0}" min="0"></div>
      <div class="form-group"><label>${t('posts.flags')}</label><input type="number" id="pf-flags-${p.id}" value="${p.base_flags||0}" min="0"></div>
      <div class="form-group"><label>${t('posts.comments_count')}</label><input type="number" id="pf-comments-count-${p.id}" value="${(() => { try { return JSON.parse(p.builder_comments_json||'[]').length; } catch { return 0; } })()}" min="0" readonly style="background:var(--surface2);color:var(--muted)" title="${t('posts.comments_count_title')}"></div>
    </div>

    <div style="display:flex;align-items:center;gap:0.75rem;margin-top:1rem;margin-bottom:0.5rem">
      <span style="font-size:0.8rem;font-weight:600;text-transform:uppercase;color:var(--muted);letter-spacing:.04em">${t('posts.post_comments')}</span>
      <button type="button" class="btn btn-ghost btn-xs" onclick="builderAddPostComment(${p.id})">${t('posts.add_comment')}</button>
    </div>
    <div id="pf-comments-list-${p.id}" style="display:flex;flex-direction:column;gap:0.4rem">
      ${(() => {
        let comments = [];
        try { comments = JSON.parse(p.builder_comments_json || '[]'); } catch {}
        return comments.map((c, i) => `
          <div class="pf-comment-row" style="display:flex;gap:0.5rem;align-items:flex-start;background:var(--surface2);border-radius:8px;padding:0.5rem 0.6rem">
            <div style="flex:0 0 140px"><input type="text" class="pfc-author" placeholder="${t('posts.author_nick')}" value="${esc(c.author||'')}" style="width:100%"></div>
            <div style="flex:1"><input type="text" class="pfc-text" placeholder="${t('posts.comment_text_ph')}" value="${esc(c.text||'')}" style="width:100%"></div>
            <div style="flex:0 0 70px"><input type="number" class="pfc-likes" placeholder="👍" value="${c.likes||0}" min="0" title="${t('posts.comment_likes_title')}" style="width:100%"></div>
            <button type="button" class="btn btn-ghost btn-xs" style="flex-shrink:0;color:var(--danger)" onclick="this.closest('.pf-comment-row').remove();builderUpdateCommentCount(${p.id})">✕</button>
          </div>`).join('');
      })()}
    </div>

    <div class="form-section-title" style="margin-top:1rem">Avatar <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.optional_m')}</span></div>
    <div style="display:flex;align-items:flex-start;gap:1rem">
      <div class="avatar-upload-wrap" onclick="document.getElementById('pf-av-input-${p.id}').click()">
        <input type="file" id="pf-av-input-${p.id}" accept="image/jpeg,image/png,image/webp"
               onchange="handleAvatarUpload(${p.id}, this)">
        ${p.avatar_path
          ? `<img class="avatar-preview" src="/uploads/${p.study_id}/${esc(p.avatar_path)}" id="av-preview-${p.id}" alt="">`
          : `<div class="avatar-preview avatar-preview-placeholder" id="av-preview-${p.id}">${esc((p.source_name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2))}</div>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:0.4rem;padding-top:0.3rem">
        <span style="font-size:0.82rem;color:var(--muted)">jpg/png/webp, max 5 MB</span>
        <button type="button" class="btn btn-danger btn-sm" id="av-del-btn-${p.id}"
                style="${p.avatar_path ? '' : 'display:none'}"
                onclick="deleteAvatar(${p.id})">${t('posts.delete_avatar')}</button>
      </div>
    </div>
    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer;margin-top:0.5rem">
      <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-avatar-${p.id}" ${p.show_avatar !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
      ${t('posts.show_avatar')}
    </label>

    <div class="form-section-title" style="margin-top:1rem">${t('posts.visible_interactions')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.visible_interactions_hint')}</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:0.75rem 1.25rem">
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-like-${p.id}" ${p.show_like !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.like')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-dislike-${p.id}" ${p.show_dislike !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.dislike_btn')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-share-${p.id}" ${p.show_share !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.share')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-flag-${p.id}" ${p.show_flag !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.flag')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-comment-${p.id}" ${p.show_comment !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.comment_field')}
      </label>
    </div>

    <div class="post-save-bar">
      <button class="btn btn-primary" onclick="savePost(${p.id})">${t('posts.save_post')}</button>
      <span class="save-status" id="save-status-${p.id}" style="display:none">${t('posts.saved')}</span>
    </div>`;
}

function postFormHTML(p, techs) {
  const topicOpts = TOPICS.map(t => `<option value="${t}" ${p.topic===t?'selected':''}>${t}</option>`).join('');
  const study = S.studies.find(s => s.id == S.selectedPostsStudy);
  if (study?.builder_mode === 1) return builderPostFormHTML(p, study, topicOpts);

  const techCbs = TECHNIQUES.map(t => `
    <label class="cb-option">
      <input type="checkbox" name="tech" value="${esc(t)}" ${techs.includes(t)?'checked':''}> ${esc(t)}
    </label>`).join('');
  const imgVariant = (variant, existingPath) => `
    <div class="image-upload-area" onclick="document.getElementById('pf-img-input-${p.id}-${variant}').click()">
      <input type="file" id="pf-img-input-${p.id}-${variant}" accept="image/jpeg,image/png,image/webp"
             onchange="handleImageUpload(${p.id}, '${variant}', this)">
      <img class="image-preview" id="img-preview-${p.id}-${variant}"
           ${existingPath ? `src="/uploads/${p.study_id}/${esc(existingPath)}"` : 'style="display:none"'} alt="">
      <div class="image-upload-label">${t('posts.img_click_choose')}</div>
    </div>
    <button type="button" class="btn btn-danger btn-sm" id="img-del-btn-${p.id}-${variant}"
            style="margin-top:0.3rem;${existingPath ? '' : 'display:none'}"
            onclick="deletePostImage(${p.id},'${variant}')">${t('posts.img_delete')}</button>`;

  // Per-condition data (metrics override + per-condition comments)
  let metricConds = [];
  try { metricConds = JSON.parse(study?.metric_conditions_json || '[]'); } catch {}
  const activeConds = metricConds.filter(c => c.enabled);
  let overrides = {};
  try { overrides = JSON.parse(p.metrics_override_json || '{}'); } catch {}
  let postComments = {};
  try { postComments = JSON.parse(p.post_comments_json || '{}'); } catch {}

  const condOverrideHTML = activeConds.length ? `
    <div class="form-section-title">${t('posts.metrics_per_condition')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.metrics_per_condition_hint')}</span></div>
    ${activeConds.map(cond => {
      const ov = overrides[cond.key] || {};
      const rangeHint = cond.max > 0 ? t('posts.range_hint', { min: cond.min, max: cond.max }) : t('posts.no_range_hint');
      return `
        <div style="margin-bottom:0.5rem">
          <div style="font-size:0.8rem;font-weight:600;margin-bottom:0.35rem">${esc(cond.label)}<span style="font-weight:400;color:var(--muted)">${rangeHint}</span></div>
          <div class="form-grid form-grid-4">
            <div class="form-group"><label>${t('posts.likes')}</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="likes" value="${ov.likes ?? ''}" placeholder="${t('posts.random')}" style="max-width:none"></div>
            <div class="form-group"><label>${t('posts.shares')}</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="shares" value="${ov.shares ?? ''}" placeholder="${t('posts.random')}" style="max-width:none"></div>
            <div class="form-group"><label>${t('posts.dislikes')}</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="dislikes" value="${ov.dislikes ?? ''}" placeholder="${t('posts.random')}" style="max-width:none"></div>
            <div class="form-group"><label>${t('posts.flags')}</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="flags" value="${ov.flags ?? ''}" placeholder="${t('posts.random')}" style="max-width:none"></div>
          </div>
        </div>`;
    }).join('')}
  ` : '';

  return `
    <div class="form-section-title">${t('posts.basics')}</div>
    <div class="form-grid">
      <div class="form-group"><label>${t('posts.topic')}</label><select id="pf-topic-${p.id}">${topicOpts}</select></div>
      <div class="form-group"><label>${t('posts.emoji')}</label><input type="text" id="pf-emoji-${p.id}" value="${esc(p.emoji||'')}"></div>
      <div class="form-group"><label>${t('posts.source_name')}</label><input type="text" id="pf-src-${p.id}" value="${esc(p.source_name||'')}"></div>
      <div class="form-group"><label>${t('posts.handle')}</label><input type="text" id="pf-handle-${p.id}" value="${esc(p.source_handle||'')}"></div>
      <div class="form-group"><label>${t('posts.time_ago')}</label><input type="text" id="pf-time-${p.id}" value="${esc(p.time_ago||'')}"></div>
      <div style="display:flex;gap:1.5rem;align-items:flex-end;padding-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-true-${p.id}" ${p.is_true?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('posts.is_true_label')}</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-active-${p.id}" ${p.is_active?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('posts.active')}</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-ht-${p.id}" ${p.hide_topic?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">${t('posts.hide_topic')}</span>
        </div>
      </div>
    </div>

    <div class="form-section-title">${t('posts.version_a_manip')}</div>
    <div class="form-group"><label>${t('posts.headline_a')}</label><textarea id="pf-ha-${p.id}" rows="2">${esc(p.headline_a||'')}</textarea></div>
    <div class="form-group"><label>${t('posts.content_a')}</label><textarea id="pf-ca-${p.id}" rows="3">${esc(p.content_a||'')}</textarea></div>

    <div class="form-section-title">${t('posts.version_b_neutral')}</div>
    <div class="form-group"><label>${t('posts.headline_b')}</label><textarea id="pf-hb-${p.id}" rows="2">${esc(p.headline_b||'')}</textarea></div>
    <div class="form-group"><label>${t('posts.content_b')}</label><textarea id="pf-cb-${p.id}" rows="3">${esc(p.content_b||'')}</textarea></div>

    <div class="form-section-title">${t('posts.experimenter_comment')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.experimenter_comment_hint')}</span></div>
    ${['A','B'].map(v => {
      const pc = postComments[v] || {};
      const label = v === 'A' ? (study?.label_style_a || t('posts.version_a')) : (study?.label_style_b || t('posts.version_b'));
      return `
        <div style="margin-bottom:0.6rem;padding:0.6rem 0.75rem;background:var(--surface2);border-radius:8px">
          <div style="font-size:0.8rem;font-weight:600;margin-bottom:0.4rem">${esc(label)}</div>
          <div class="form-grid" style="grid-template-columns:1fr 2fr;gap:0.5rem">
            <div class="form-group" style="margin:0"><label>${t('posts.author_nick')}</label><input type="text" data-cond-key="${v}" data-comment="author" value="${esc(pc.author||'')}" placeholder="${t('posts.author_ph')}"></div>
            <div class="form-group" style="margin:0"><label>${t('posts.comment_text')}</label><input type="text" data-cond-key="${v}" data-comment="text" value="${esc(pc.text||'')}" placeholder="${t('posts.comment_under_post_ph')}"></div>
          </div>
        </div>`;
    }).join('')}

    <div class="form-section-title">${t('posts.manip_techniques')}</div>
    <div class="checkbox-grid">${techCbs}</div>

    ${condOverrideHTML}

    <div class="form-section-title">${t('posts.avatar_optional_initials')}</div>
    <div style="display:flex;align-items:flex-start;gap:1rem">
      <div class="avatar-upload-wrap" onclick="document.getElementById('pf-av-input-${p.id}').click()">
        <input type="file" id="pf-av-input-${p.id}" accept="image/jpeg,image/png,image/webp"
               onchange="handleAvatarUpload(${p.id}, this)">
        ${p.avatar_path
          ? `<img class="avatar-preview" src="/uploads/${p.study_id}/${esc(p.avatar_path)}" id="av-preview-${p.id}" alt="">`
          : `<div class="avatar-preview avatar-preview-placeholder" id="av-preview-${p.id}">${esc((p.source_name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2))}</div>`}
      </div>
      <div style="display:flex;flex-direction:column;gap:0.4rem;padding-top:0.3rem">
        <span style="font-size:0.82rem;color:var(--muted)">${t('posts.avatar_hint')}</span>
        <button type="button" class="btn btn-danger btn-sm" id="av-del-btn-${p.id}"
                style="${p.avatar_path ? '' : 'display:none'}"
                onclick="deleteAvatar(${p.id})">${t('posts.delete_avatar')}</button>
      </div>
    </div>
    <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer;margin-top:0.5rem">
      <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-avatar-${p.id}" ${p.show_avatar !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
      ${t('posts.show_avatar')}
    </label>

    <div class="form-section-title" style="margin-top:1rem">${t('posts.visible_interactions')} <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">${t('posts.visible_interactions_hint')}</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:0.75rem 1.25rem">
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-like-${p.id}" ${p.show_like !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.like')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-dislike-${p.id}" ${p.show_dislike !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.dislike_btn')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-share-${p.id}" ${p.show_share !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.share')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-flag-${p.id}" ${p.show_flag !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.flag')}
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem;cursor:pointer">
        <label class="toggle" style="margin:0"><input type="checkbox" id="pf-show-comment-${p.id}" ${p.show_comment !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        ${t('posts.comment_field')}
      </label>
    </div>

    <div class="form-section-title">${t('posts.images_section')}</div>
    <div class="grid-2col" style="gap:1rem">
      <div>
        <div class="form-label" style="margin-bottom:0.4rem">${t('posts.version_a')}</div>
        ${imgVariant('a', p.image_path_a)}
      </div>
      <div>
        <div class="form-label" style="margin-bottom:0.4rem">${t('posts.version_b')}</div>
        ${imgVariant('b', p.image_path_b)}
      </div>
    </div>

    <div class="post-save-bar">
      <button class="btn btn-primary" onclick="savePost(${p.id})">${t('posts.save_post')}</button>
      <span class="save-status" id="save-status-${p.id}" style="display:none">${t('posts.saved')}</span>
    </div>`;
}

function builderAddPostComment(postId) {
  const list = document.getElementById(`pf-comments-list-${postId}`);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'pf-comment-row';
  row.style.cssText = 'display:flex;gap:0.5rem;align-items:flex-start;background:var(--surface2);border-radius:8px;padding:0.5rem 0.6rem';
  row.innerHTML = `
    <div style="flex:0 0 140px"><input type="text" class="pfc-author" placeholder="${t('posts.author_nick')}" style="width:100%"></div>
    <div style="flex:1"><input type="text" class="pfc-text" placeholder="${t('posts.comment_text_ph')}" style="width:100%"></div>
    <div style="flex:0 0 70px"><input type="number" class="pfc-likes" placeholder="👍" value="0" min="0" title="${t('posts.comment_likes_title')}" style="width:100%"></div>
    <button type="button" class="btn btn-ghost btn-xs" style="flex-shrink:0;color:var(--danger)" onclick="this.closest('.pf-comment-row').remove();builderUpdateCommentCount(${postId})">✕</button>`;
  list.appendChild(row);
  builderUpdateCommentCount(postId);
  row.querySelector('.pfc-author')?.focus();
}

function builderUpdateCommentCount(postId) {
  const list = document.getElementById(`pf-comments-list-${postId}`);
  const counter = document.getElementById(`pf-comments-count-${postId}`);
  if (list && counter) counter.value = list.querySelectorAll('.pf-comment-row').length;
}

function togglePostRow(id) {
  const row = document.getElementById(`post-row-${id}`);
  row.classList.toggle('expanded');
}

async function savePost(id) {
  const row = document.getElementById(`post-body-${id}`);
  const study = S.studies.find(s => s.id == S.selectedPostsStudy);
  const isBuilder = study?.builder_mode === 1;

  const headline_a = document.getElementById(`pf-ha-${id}`)?.value || '';
  const content_a  = document.getElementById(`pf-ca-${id}`)?.value || '';
  // headline_b / content_b only exist as real textareas when there are 2+ conditions
  const hbEl = document.getElementById(`pf-hb-${id}`);
  const cbEl = document.getElementById(`pf-cb-${id}`);
  const headline_b = (hbEl?.type === 'hidden') ? '' : (hbEl?.value || '');
  const content_b  = (cbEl?.type === 'hidden') ? '' : (cbEl?.value || '');

  const body = {
    topic: document.getElementById(`pf-topic-${id}`).value,
    emoji: document.getElementById(`pf-emoji-${id}`).value,
    source_name: document.getElementById(`pf-src-${id}`).value,
    source_handle: document.getElementById(`pf-handle-${id}`).value,
    time_ago: document.getElementById(`pf-time-${id}`).value,
    is_true: document.getElementById(`pf-true-${id}`).checked ? 1 : 0,
    is_active: document.getElementById(`pf-active-${id}`).checked ? 1 : 0,
    hide_topic: document.getElementById(`pf-ht-${id}`)?.checked ? 1 : 0,
    show_avatar:   document.getElementById(`pf-show-avatar-${id}`)?.checked   ? 1 : 0,
    show_like:     document.getElementById(`pf-show-like-${id}`)?.checked     ? 1 : 0,
    show_dislike:  document.getElementById(`pf-show-dislike-${id}`)?.checked  ? 1 : 0,
    show_share:    document.getElementById(`pf-show-share-${id}`)?.checked    ? 1 : 0,
    show_flag:     document.getElementById(`pf-show-flag-${id}`)?.checked     ? 1 : 0,
    show_comment:  document.getElementById(`pf-show-comment-${id}`)?.checked  ? 1 : 0,
    // Multi-part assignment — checkboxes only render when the study has 2+
    // parts. We collect every checked value and send as part_ids_json; the
    // server derives part_id from the first element so legacy readers keep
    // working. Omit entirely on single-part studies so we never clobber the
    // column on simple studies that don't show the picker.
    ...((() => {
      const wrap = document.getElementById(`pf-parts-wrap-${id}`);
      if (!wrap) return {};
      const checked = Array.from(wrap.querySelectorAll(`input.pf-part-cb-${id}:checked`))
        .map(el => el.value)
        .filter(Boolean);
      return { part_ids_json: JSON.stringify(checked) };
    })()),
    headline_a,
    content_a,
    headline_b,
    content_b,
  };

  if (isBuilder) {
    body.base_likes    = Number(document.getElementById(`pf-likes-${id}`)?.value)    || 0;
    body.base_shares   = Number(document.getElementById(`pf-shares-${id}`)?.value)   || 0;
    body.base_dislikes = Number(document.getElementById(`pf-dislikes-${id}`)?.value) || 0;
    body.base_flags    = Number(document.getElementById(`pf-flags-${id}`)?.value)    || 0;
    const commentRows = row.querySelectorAll('.pf-comment-row');
    body.builder_comments_json = JSON.stringify(Array.from(commentRows).map(r => ({
      author: r.querySelector('.pfc-author')?.value.trim() || '',
      text:   r.querySelector('.pfc-text')?.value.trim()   || '',
      likes:  Number(r.querySelector('.pfc-likes')?.value) || 0,
    })).filter(c => c.text));
  } else {
    // Legacy: collect manipulation techniques, per-condition comments and metric overrides
    body.manipulation_techniques = [...row.querySelectorAll('input[name="tech"]:checked')].map(c => c.value);

    const commentMap = {};
    row.querySelectorAll('input[data-cond-key][data-comment]').forEach(input => {
      const key = input.dataset.condKey;
      const field = input.dataset.comment;
      const val = input.value.trim();
      if (val) {
        if (!commentMap[key]) commentMap[key] = {};
        commentMap[key][field] = val;
      }
    });
    body.post_comments_json = JSON.stringify(commentMap);

    const overrideMap = {};
    row.querySelectorAll('input[data-cond-key][data-metric]').forEach(input => {
      const key = input.dataset.condKey;
      const metric = input.dataset.metric;
      if (input.value.trim() !== '') {
        if (!overrideMap[key]) overrideMap[key] = {};
        overrideMap[key][metric] = Number(input.value);
      }
    });
    body.metrics_override_json = JSON.stringify(overrideMap);
  }

  const data = await api('PATCH', `/posts/${id}`, body);
  if (!data) return;

  // If the researcher just enabled per-post comment on a study where
  // study-level enable_comments is off, the comment field would still be
  // hidden in the participant view because the two-level gate requires
  // both flags. Auto-flip the study-level flag so the per-post toggle
  // "just works" — the researcher's intent is clearly to allow comments
  // on this post. They can still disable comments on other posts via
  // their own per-post toggles.
  if (body.show_comment === 1) {
    const studyForPost = S.studies.find(s => s.id == S.selectedPostsStudy);
    if (studyForPost && !studyForPost.enable_comments) {
      await api('PATCH', `/studies/${studyForPost.id}`, { enable_comments: 1 });
      studyForPost.enable_comments = 1; // keep local cache in sync
      toast(t('posts.comments_auto_enabled'));
    }
  }

  const status = document.getElementById(`save-status-${id}`);
  status.style.display = '';
  setTimeout(() => { status.style.display = 'none'; }, 2500);

  // Update header badges
  const row2 = document.getElementById(`post-row-${id}`);
  row2.querySelector('.post-type-badge').className = `post-type-badge ${data.is_true ? 'type-true' : 'type-false'}`;
  row2.querySelector('.post-type-badge').textContent = data.is_true ? t('posts.true') : t('posts.false');
  row2.querySelector('.badge').className = `badge ${data.is_active ? 'badge-active' : 'badge-inactive'}`;
  row2.querySelector('.badge').textContent = data.is_active ? t('posts.active') : t('posts.hidden');
}

async function reorderPost(id, direction) {
  await api('PATCH', `/posts/${id}/reorder`, { direction });
  await loadPosts(S.selectedPostsStudy);
}

async function handleImageUpload(postId, variant, input) {
  if (!input.files[0]) return;
  const fd = new FormData();
  fd.append('image', input.files[0]);
  const data = await api('POST', `/posts/${postId}/image/${variant}`, fd, true);
  if (!data || data.error) { toast(data?.error || t('posts.upload_error'), 'error'); return; }
  const prev = document.getElementById(`img-preview-${postId}-${variant}`);
  prev.src = data.image_url + '?t=' + Date.now();
  prev.style.display = 'block';
  const delBtn = document.getElementById(`img-del-btn-${postId}-${variant}`);
  if (delBtn) delBtn.style.display = '';
  toast(t('posts.image_saved'));
}

async function deletePost(id) {
  // Look up the title from the rendered row instead of accepting it as an
  // onclick arg — previously the title was injected via JSON.stringify(...)
  // into onclick="deletePost(123, "NIZP PZH-PIB")" which made the inner
  // double quotes terminate the attribute and silently broke the handler.
  const row = document.querySelector(`#post-row-${id}`);
  const title = row?.querySelector('.post-source-label')?.textContent?.trim() || '—';
  if (!confirm(t('posts.delete_confirm', { title }))) return;
  await api('DELETE', `/posts/${id}`);
  toast(t('posts.post_deleted'));
  await loadPosts(S.selectedPostsStudy);
}

async function handleAvatarUpload(postId, input) {
  if (!input.files[0]) return;
  const fd = new FormData();
  fd.append('image', input.files[0]);
  const data = await api('POST', `/posts/${postId}/avatar`, fd, true);
  if (!data || data.error) { toast(data?.error || t('posts.upload_error'), 'error'); return; }
  const prev = document.getElementById(`av-preview-${postId}`);
  // Replace placeholder div with img or update src
  if (prev.tagName === 'IMG') {
    prev.src = data.avatar_url + '?t=' + Date.now();
  } else {
    const img = document.createElement('img');
    img.className = 'avatar-preview';
    img.id = `av-preview-${postId}`;
    img.src = data.avatar_url + '?t=' + Date.now();
    prev.replaceWith(img);
  }
  const delBtn = document.getElementById(`av-del-btn-${postId}`);
  if (delBtn) delBtn.style.display = '';
  toast(t('posts.avatar_saved'));
}

async function deleteAvatar(postId) {
  if (!confirm(t('posts.avatar_delete_confirm'))) return;
  const r = await api('DELETE', `/posts/${postId}/avatar`);
  if (!r) return;
  // Swap img back to initials placeholder
  const prev = document.getElementById(`av-preview-${postId}`);
  if (prev) {
    // Fetch source_name from the visible header to rebuild initials
    const headerLabel = document.querySelector(`#post-row-${postId} .post-source-label`);
    const name = headerLabel ? headerLabel.textContent.trim() : '?';
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
    const placeholder = document.createElement('div');
    placeholder.className = 'avatar-preview avatar-preview-placeholder';
    placeholder.id = `av-preview-${postId}`;
    placeholder.textContent = initials;
    prev.replaceWith(placeholder);
  }
  const delBtn = document.getElementById(`av-del-btn-${postId}`);
  if (delBtn) delBtn.style.display = 'none';
  toast(t('posts.avatar_deleted'));
}

async function deletePostImage(postId, variant) {
  if (!confirm(t('posts.image_delete_confirm'))) return;
  await api('DELETE', `/posts/${postId}/image/${variant}`);
  const prev = document.getElementById(`img-preview-${postId}-${variant}`);
  prev.src = '';
  prev.style.display = 'none';
  const delBtn = document.getElementById(`img-del-btn-${postId}-${variant}`);
  if (delBtn) delBtn.style.display = 'none';
  toast(t('posts.image_deleted'));
}

function goToPostEditor(studyId) {
  setActiveStudy(studyId);
  switchTab('posts');
}

// ── Post preview ───────────────────────────────────────────────────────────
function previewPost(id) {
  const p = S.currentPosts.find(x => x.id === id);
  if (!p) return;

  const study = S.studies.find(s => s.id == S.selectedPostsStudy);

  // Metric conditions
  let metricConds = [];
  try { metricConds = JSON.parse(study?.metric_conditions_json || '[]'); } catch {}
  metricConds = metricConds.filter(c => c.enabled);
  if (!metricConds.length) {
    // Legacy or fallback
    if (study?.enable_metrics_high) metricConds.push({ key: 'HIGH', label: t('posts.high_numbers'), min: study.high_metrics_min || 1000, max: study.high_metrics_max || 5000, show_comment: false });
    if (study?.enable_metrics_low)  metricConds.push({ key: 'LOW',  label: t('posts.low_numbers'),  min: study.low_metrics_min  || 10,   max: study.low_metrics_max  || 100,  show_comment: false });
  }
  if (!metricConds.length) metricConds = [{ key: 'PREVIEW', label: t('posts.preview'), min: 0, max: 0, show_comment: false }];

  let overrides = {};
  try { overrides = JSON.parse(p.metrics_override_json || '{}'); } catch {}
  let postComments = {};
  try { postComments = JSON.parse(p.post_comments_json || '{}'); } catch {}

  const topicMap = { zdrowie:'topic-zdrowie', klimat:'topic-klimat', polityka:'topic-polityka', ekonomia:'topic-ekonomia', nauka:'topic-nauka' };
  const fmt = n => Number(n).toLocaleString('pl-PL');

  function getMetrics(cond) {
    const ov = overrides[cond.key] || {};
    const mid = (f, base) => ov[f] != null ? ov[f] : (cond.max > 0 ? Math.round((cond.min + cond.max) / 2) : (p[base] || 0));
    return {
      likes:    mid('likes',    'base_likes'),
      shares:   mid('shares',   'base_shares'),
      dislikes: mid('dislikes', 'base_dislikes'),
      flags:    mid('flags',    'base_flags'),
    };
  }

  function buildCard(variant, cond) {
    const v = variant.toUpperCase(); // 'A' or 'B'
    const headline = v === 'A' ? (p.headline_a || '') : (p.headline_b || '');
    const content  = v === 'A' ? (p.content_a  || '') : (p.content_b  || '');
    const imgPath  = v === 'A' ? p.image_path_a : p.image_path_b;
    const imageUrl = imgPath ? `/uploads/${p.study_id}/${imgPath}` : (p.image_path ? `/uploads/${p.study_id}/${p.image_path}` : null);
    const avatarUrl = p.avatar_path ? `/uploads/${p.study_id}/${p.avatar_path}` : null;
    const metrics = getMetrics(cond);
    const showMetrics = study?.show_metrics !== 0;
    const topicCls = topicMap[p.topic] || 'topic-nauka';

    const pc = postComments[v] || {};
    const showComment = cond.show_comment && (pc.text || p.post_comment);
    const commentText   = (pc.text   || '').trim() || p.post_comment        || '';
    const commentAuthor = (pc.author || '').trim() || p.post_comment_author || p.source_name || '';

    const avatarEl = avatarUrl
      ? `<img class="pv-avatar pv-avatar-img" src="${esc(avatarUrl)}" alt="${esc(p.source_name)}">`
      : `<div class="pv-avatar">${esc((p.source_name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2))}</div>`;

    const commentAvInit = (commentAuthor || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    return `
      <div class="pv-post">
        <div class="pv-post-header">
          ${avatarEl}
          <div class="pv-post-meta">
            <div class="pv-source">${esc(p.source_name)}</div>
            <div class="pv-handle">${esc(p.source_handle)} · ${esc(p.time_ago)}</div>
          </div>
          <span class="pv-topic-pill ${topicCls}">${esc(p.emoji || '')} ${esc(p.topic || '')}</span>
        </div>
        <div class="pv-post-body">
          <h3 class="pv-headline">${esc(headline || '—')}</h3>
          <p class="pv-content">${esc(content || '—')}</p>
        </div>
        ${imageUrl ? `<div class="pv-image"><img src="${esc(imageUrl)}" alt="" loading="lazy"></div>` : ''}
        ${showMetrics ? `
        <div class="pv-metrics">
          <span class="pv-metric">👍 ${fmt(metrics.likes)}</span>
          <span class="pv-metric">👎 ${fmt(metrics.dislikes)}</span>
          <span class="pv-metric">🔄 ${fmt(metrics.shares)}</span>
          <span class="pv-metric">🚩 ${fmt(metrics.flags)}</span>
        </div>` : ''}
        ${showComment ? `
        <div class="pv-comment-divider"></div>
        <div class="pv-comment-entry">
          <div class="pv-comment-avatar">${esc(commentAvInit)}</div>
          <div class="pv-comment-body">
            <span class="pv-comment-author">${esc(commentAuthor)}</span>
            <p class="pv-comment-text">${esc(commentText)}</p>
          </div>
        </div>` : ''}
        <div class="pv-actions">
          <button class="pv-action-btn"><span class="pv-action-icon">👍</span>${esc(study?.label_action_like    || t('posts.preview_action_like'))}</button>
          <button class="pv-action-btn"><span class="pv-action-icon">👎</span>${esc(study?.label_action_dislike || t('posts.preview_action_dislike'))}</button>
          <button class="pv-action-btn"><span class="pv-action-icon">🔄</span>${esc(study?.label_action_share   || t('posts.preview_action_share'))}</button>
          <button class="pv-action-btn"><span class="pv-action-icon">🚩</span>${esc(study?.label_action_flag    || t('posts.preview_action_flag'))}</button>
        </div>
      </div>`;
  }

  // Lightweight state stored on a global so inline onclick handlers can reach it
  window._pv = { variant: 'a', condIdx: 0 };

  window._pvRender = () => {
    const { variant, condIdx } = window._pv;
    const cond = metricConds[condIdx];

    const variantTabs = [
      { key: 'a', label: study?.label_style_a || t('posts.preview_variant_a') },
      { key: 'b', label: study?.label_style_b || t('posts.preview_variant_b') },
    ].map(t => `
      <button class="btn btn-sm ${variant === t.key ? 'btn-primary' : 'btn-ghost'}"
              onclick="_pv.variant='${t.key}';_pvRender()">${esc(t.label)}</button>`).join('');

    const condTabs = metricConds.length > 1 ? metricConds.map((c, i) => `
      <button class="btn btn-sm ${condIdx === i ? 'btn-primary' : 'btn-ghost'}"
              onclick="_pv.condIdx=${i};_pvRender()">${esc(c.label)}</button>`).join('') : '';

    document.getElementById('modal-body').innerHTML = `
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1.25rem;flex-wrap:wrap">
        <h2 style="margin:0;font-size:1.1rem;flex:1">${t('posts.preview_title')}</h2>
        <span class="badge ${p.is_true ? 'badge-active' : 'badge-inactive'} post-type-badge ${p.is_true ? 'type-true' : 'type-false'}"
              style="font-size:0.7rem">${p.is_true ? t('posts.preview_true') : t('posts.preview_false')}</span>
      </div>

      <div style="display:flex;gap:0.5rem;margin-bottom:${condTabs ? '0.6rem' : '1.25rem'};flex-wrap:wrap">
        ${variantTabs}
      </div>
      ${condTabs ? `<div style="display:flex;gap:0.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${condTabs}</div>` : ''}

      ${buildCard(variant, cond)}
    `;
  };

  showModal('');   // open overlay first (modal-body will be populated below)
  window._pvRender();
}

// ── Export ─────────────────────────────────────────────────────────────────

async function loadExportView(studyId) {
  const dashboard = await api('GET', `/dashboard/${studyId}`);
  if (!dashboard) return;
  const study = S.studies.find(s => s.id == studyId);

  document.getElementById('export-content').innerHTML = `
    <div class="export-box">
      <h3>${esc(study?.name || t('export.study_fallback'))}</h3>
      <div class="export-stats">
        ${t('export.completed_sessions_lbl')} <strong>${dashboard.completed_sessions}</strong>
        &nbsp;·&nbsp; ${t('export.all_sessions_lbl')} <strong>${dashboard.total_sessions}</strong>
        ${(dashboard.preview_count || dashboard.preview_count_incomplete) ? `
          &nbsp;·&nbsp; <span style="color:var(--muted)">${t('export.preview_hidden_lbl')} <strong>${dashboard.preview_count}</strong>${dashboard.preview_count_incomplete ? ` <span title="${t('export.preview_incomplete_title')}" style="font-size:0.78rem">${t('export.preview_incomplete', { n: dashboard.preview_count_incomplete })}</span>` : ''}</span>` : ''}
      </div>
      ${(dashboard.preview_count || dashboard.preview_count_incomplete) ? `
        <div style="display:flex;align-items:center;gap:0.75rem;justify-content:center;margin:0.5rem 0;padding:0.5rem;background:var(--surface2);border-radius:8px;font-size:0.85rem">
          ${dashboard.preview_count ? `<label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;margin:0">
            <input type="checkbox" id="export-include-preview" onchange="updateExportLink(${studyId})">
            Dołącz sesje podglądowe (preview) do eksportu
          </label>` : `<span style="color:var(--muted)">${t('export.no_preview_sessions')}</span>`}
          <button class="btn btn-danger btn-xs" style="margin-left:auto" onclick="deletePreviewSessions(${studyId})" title="${t('export.del_preview_title', { done: dashboard.preview_count, incomplete: dashboard.preview_count_incomplete })}">
            ${t('export.del_preview_btn', { n: (dashboard.preview_count || 0) + (dashboard.preview_count_incomplete || 0) })}
          </button>
        </div>` : ''}
      <div class="export-btn-wrap">
        <div style="display:flex;align-items:center;gap:0.75rem;justify-content:center;flex-wrap:wrap">
          ${(() => {
            // Show a language switch when the study has translations available.
            // Researcher running a CS study can pick PL (canonical) or CS for their
            // export. PL studies without translations get no picker — single button.
            const studyLang = study?.language || 'pl';
            let availableLangs = [];
            try {
              const trans = JSON.parse(study?.translations_json || '{}');
              availableLangs = Object.keys(trans);
            } catch {}
            const langSet = new Set(['pl', studyLang, ...availableLangs]);
            const langs = Array.from(langSet);
            const langLabels = { pl: '🇵🇱 PL', en: '🇬🇧 EN', cs: '🇨🇿 CS', sk: '🇸🇰 SK' };
            if (langs.length <= 1) return '';
            return `
              <select id="export-lang-select" onchange="updateExportLink(${studyId})"
                      title="${t('export.lang_title')}"
                      style="width:auto;padding:0.55rem 2.2rem 0.55rem 0.8rem;font-size:0.85rem;font-weight:600">
                ${langs.map(l => `<option value="${l}" ${l === studyLang ? 'selected' : ''}>${langLabels[l] || l}${l === 'pl' ? ' ' + t('export.canonical') : ''}</option>`).join('')}
              </select>`;
          })()}
          <a class="btn btn-success" href="/api/admin/export/${studyId}"
             id="export-link"
             onclick="handleExportClick(event, ${studyId})">
            ${t('export.download_xlsx')}
          </a>
          <a class="btn btn-ghost" href="/api/admin/export/${studyId}/csv"
             id="export-csv-link"
             onclick="handleCsvExportClick(event, ${studyId})"
             title="${t('export.csv_title')}">
            📄 CSV
          </a>
        </div>
        ${study?.eyetracking_enabled ? `
        <a class="btn btn-ghost btn-sm" href="/api/admin/gaze-csv/${studyId}"
           id="gaze-csv-link" style="margin-top:0.5rem"
           onclick="handleGazeCsvClick(event, ${studyId})">
          ${t('export.download_gaze_csv')}
        </a>` : ''}
      </div>
    </div>

    <!-- Inline export builder — preview + customize Dane_surowe table -->
    <div class="export-builder" id="export-builder-wrap" data-study-id="${studyId}">
      <button type="button" class="export-builder-toggle" onclick="toggleExportBuilder(${studyId})">
        <span class="export-builder-chev">▸</span>
        <span style="font-weight:600">${t('export.builder_toggle')}</span>
        <span style="font-size:0.78rem;color:var(--muted);font-weight:400;margin-left:0.5rem">${t('export.builder_toggle_hint')}</span>
      </button>
      <div class="export-builder-body" id="export-builder-body" style="display:none"></div>
    </div>

    <div class="codebook">
      <div class="section-title">${t('export.codebook_title')}</div>
      <div class="codebook-grid">
        ${(() => {
          const dqs = dashboard.demographic_questions || [];
          const LEGACY = ['age', 'residence', 'education', 'gender'];
          // Order: legacy first (preserving their order), then custom questions
          const ordered = [
            ...LEGACY.map(k => dqs.find(q => q.field_key === k)).filter(Boolean),
            ...dqs.filter(q => !LEGACY.includes(q.field_key)),
          ];
          if (!ordered.length) {
            // Fallback when no demographic_questions configured (e.g. legacy studies)
            return `
              <div class="codebook-group">
                <div class="codebook-group-title">${t('export.codebook_age')}</div>
                <div class="codebook-row"><span class="code-num">1</span><span>18–25</span></div>
                <div class="codebook-row"><span class="code-num">2</span><span>26–35</span></div>
                <div class="codebook-row"><span class="code-num">3</span><span>36–45</span></div>
                <div class="codebook-row"><span class="code-num">4</span><span>46–60</span></div>
                <div class="codebook-row"><span class="code-num">5</span><span>60+</span></div>
              </div>
              <div class="codebook-group">
                <div class="codebook-group-title">${t('export.codebook_residence')}</div>
                <div class="codebook-row"><span class="code-num">1</span><span>${t('export.residence_1')}</span></div>
                <div class="codebook-row"><span class="code-num">2</span><span>${t('export.residence_2')}</span></div>
                <div class="codebook-row"><span class="code-num">3</span><span>${t('export.residence_3')}</span></div>
                <div class="codebook-row"><span class="code-num">4</span><span>${t('export.residence_4')}</span></div>
              </div>
              <div class="codebook-group">
                <div class="codebook-group-title">${t('export.codebook_education')}</div>
                <div class="codebook-row"><span class="code-num">1</span><span>${t('export.education_1')}</span></div>
                <div class="codebook-row"><span class="code-num">2</span><span>${t('export.education_2')}</span></div>
                <div class="codebook-row"><span class="code-num">3</span><span>${t('export.education_3')}</span></div>
                <div class="codebook-row"><span class="code-num">4</span><span>${t('export.education_4')}</span></div>
              </div>
              <div class="codebook-group">
                <div class="codebook-group-title">${t('export.codebook_gender')}</div>
                <div class="codebook-row"><span class="code-num">1</span><span>${t('export.gender_1')}</span></div>
                <div class="codebook-row"><span class="code-num">2</span><span>${t('export.gender_2')}</span></div>
                <div class="codebook-row"><span class="code-num">3</span><span>${t('export.gender_3')}</span></div>
                <div class="codebook-row"><span class="code-num">4</span><span>${t('export.gender_4')}</span></div>
              </div>`;
          }
          return ordered.map(q => {
            const isLegacy = LEGACY.includes(q.field_key);
            const colSuffix = isLegacy ? `${q.field_key}_code` : q.field_key;
            const opts = Array.isArray(q.options) ? q.options : [];
            const rows = opts.length
              ? opts.map((o, i) => `<div class="codebook-row"><span class="code-num">${i + 1}</span><span>${esc(o.label || o.value || String(o))}</span></div>`).join('')
              : `<div class="codebook-row" style="color:var(--muted);font-style:italic"><span></span><span>${t('export.free_text_no_coding')}</span></div>`;
            return `<div class="codebook-group">
              <div class="codebook-group-title">${esc(q.label)} (${esc(colSuffix)})</div>
              ${rows}
            </div>`;
          }).join('');
        })()}
      </div>
    </div>

    <div>
      <div class="section-title">${t('export.recent_sessions_title')}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>${t('export.col_condition')}</th><th>${t('export.col_age')}</th><th>${t('export.col_gender')}</th><th>${t('export.col_avg_belief_false')}</th><th>${t('export.col_date')}</th></tr></thead>
          <tbody>
            ${(() => {
              const lm = buildCondLabelMap(study);
              return (dashboard.recent_sessions || []).slice(0, 10).map(s => `
              <tr>
                <td class="mono">${s.id}</td>
                <td><span class="badge badge-active" title="${esc(lm[s.full_condition]?.label || s.full_condition || '')}">
                  ${esc(lm[s.full_condition]?.short || s.full_condition || '–')}</span></td>
                <td>${esc(s.age||'–')}</td>
                <td>${esc(s.gender||'–')}</td>
                <td>${s.avg_belief_false != null ? Number(s.avg_belief_false).toFixed(2) : '–'}</td>
                <td class="text-muted">${s.completed_at ? s.completed_at.slice(0,16).replace('T',' ') : '–'}</td>
              </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">${t('export.no_data')}</td></tr>`;
            })()}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function handleGazeCsvClick(e, studyId) {
  e.preventDefault();
  const link = document.getElementById('gaze-csv-link');
  if (link) link.textContent = t('export.generating');
  try {
    const r = await fetch(`/api/admin/gaze-csv/${studyId}`, {
      headers: { Authorization: `Bearer ${S.token}` },
    });
    if (!r.ok) { toast(t('export.err_gaze'), 'error'); return; }
    const blob = await r.blob();
    const disp = r.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `gaze_${studyId}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast(t('export.csv_downloaded'));
  } catch {
    toast(t('export.err_export'), 'error');
  } finally {
    if (link) link.textContent = t('export.download_gaze_csv');
  }
}

// Build the export URL respecting both pickers (language + include-preview)
// so the <a href> stays in sync with the UI for right-click "Save link as…".
function buildExportUrl(studyId) {
  const lang = document.getElementById('export-lang-select')?.value;
  const inclPrev = document.getElementById('export-include-preview')?.checked;
  const params = [];
  if (lang) params.push('lang=' + encodeURIComponent(lang));
  if (inclPrev) params.push('include_preview=1');
  return `/api/admin/export/${studyId}` + (params.length ? `?${params.join('&')}` : '');
}

function updateExportLink(studyId) {
  const link = document.getElementById('export-link');
  if (link) link.href = buildExportUrl(studyId);
  // If the builder is open, refresh its preview so language + include-preview
  // toggles propagate to the visible table without manual collapse/expand.
  if (EB.expanded && EB.studyId === studyId) loadExportBuilder(studyId);
}

async function deletePreviewSessions(studyId) {
  if (!confirm(t('export.confirm_del_preview'))) return;
  const r = await api('POST', `/studies/${studyId}/preview-sessions/delete`, { confirm: 'DELETE' });
  if (!r?.ok) return;
  toast(t('export.deleted_preview', { n: r.deleted }));
  // Re-render the export panel so the badge + button disappear
  await loadExportView(studyId);
}

async function handleExportClick(e, studyId) {
  e.preventDefault();
  const link = document.getElementById('export-link');
  link.textContent = t('export.generating_dots');
  const url = buildExportUrl(studyId);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${S.token}` },
    });
    if (!r.ok) { toast(t('export.err_export'), 'error'); return; }
    const blob = await r.blob();
    const disp = r.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `export_${studyId}.xlsx`;
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl; a.download = filename; a.click();
    URL.revokeObjectURL(dlUrl);
    toast(t('export.file_downloaded'));
  } catch {
    toast(t('export.err_export'), 'error');
  } finally {
    link.textContent = t('export.download_xlsx');
  }
}

// CSV download — same lang + include_preview options as xlsx (re-uses
// buildExportUrl's logic but hits the /csv path).
async function handleCsvExportClick(e, studyId) {
  e.preventDefault();
  const link = document.getElementById('export-csv-link');
  const orig = link.textContent;
  link.textContent = '⏳ CSV…';
  const lang = document.getElementById('export-lang-select')?.value;
  const inclPrev = document.getElementById('export-include-preview')?.checked;
  const params = [];
  if (lang) params.push('lang=' + encodeURIComponent(lang));
  if (inclPrev) params.push('include_preview=1');
  const url = `/api/admin/export/${studyId}/csv` + (params.length ? `?${params.join('&')}` : '');
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!r.ok) { toast(t('export.err_csv'), 'error'); return; }
    const blob = await r.blob();
    const disp = r.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `export_${studyId}.csv`;
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl; a.download = filename; a.click();
    URL.revokeObjectURL(dlUrl);
    toast(t('export.csv_downloaded_short'));
  } catch {
    toast(t('export.err_csv'), 'error');
  } finally {
    link.textContent = orig;
  }
}

// ── Export builder UI ──────────────────────────────────────────────────────
// Inline collapsible section under the download buttons. Shows a preview of
// the Dane_surowe table and lets the researcher reorder / hide / rename
// columns. All edits hit the backend (PUT /export/.../config) so the next
// xlsx + CSV download reflects them. Non-destructive: only changes the
// VIEW, never the underlying session data.

// Per-study in-memory state for the builder. Persists across re-renders of
// the export panel within a single admin session.
const EB = {
  studyId: null,
  sheet: 'Dane_surowe',
  data: null,            // last preview response from server
  workingConfig: null,   // {columns: [...]} — what the user is editing
  filter: '',            // text filter applied to preview rows
  expanded: false,       // whether the builder section is open
  showHidden: true,      // when false, hidden columns disappear from the preview entirely
  selectedKeys: new Set(), // checkboxes ticked in header row — drives the bulk action bar
};

function toggleExportBuilder(studyId) {
  const body = document.getElementById('export-builder-body');
  const chev = document.querySelector('#export-builder-wrap .export-builder-chev');
  if (!body) return;
  EB.expanded = body.style.display === 'none';
  body.style.display = EB.expanded ? 'block' : 'none';
  chev.textContent = EB.expanded ? '▾' : '▸';
  localStorage.setItem('export_builder_open', EB.expanded ? '1' : '0');
  if (EB.expanded) loadExportBuilder(studyId);
}

async function loadExportBuilder(studyId) {
  const body = document.getElementById('export-builder-body');
  if (!body) return;
  body.innerHTML = `<div style="padding:1rem;color:var(--muted);font-size:0.85rem">${t('export.loading_preview')}</div>`;
  const lang = document.getElementById('export-lang-select')?.value || '';
  const inclPrev = document.getElementById('export-include-preview')?.checked ? '1' : '';
  const params = ['limit=20'];
  if (lang) params.push('lang=' + encodeURIComponent(lang));
  if (inclPrev) params.push('include_preview=1');
  const data = await api('GET', `/export/${studyId}/preview?${params.join('&')}`);
  if (!data) { body.innerHTML = `<div style="padding:1rem;color:var(--danger)">${t('export.preview_load_failed')}</div>`; return; }
  EB.studyId = studyId;
  EB.sheet = data.sheet;
  EB.data = data;
  // Initialize workingConfig from saved config; if none, derive from defaults
  // (so every column has an explicit entry the UI can manipulate).
  if (data.current_config && Array.isArray(data.current_config.columns)) {
    // Merge: include columns saved in config + append any new default columns
    // not yet in the config (forward-compat).
    const seen = new Set();
    const merged = [];
    data.current_config.columns.forEach(c => {
      if (data.default_columns.some(d => d.key === c.key)) { merged.push(c); seen.add(c.key); }
    });
    data.default_columns.forEach(d => {
      if (!seen.has(d.key)) merged.push({ key: d.key, header: null, visible: true });
    });
    EB.workingConfig = { columns: merged };
  } else {
    EB.workingConfig = { columns: data.default_columns.map(c => ({ key: c.key, header: null, visible: true })) };
  }
  renderExportBuilder();
}

function renderExportBuilder() {
  const body = document.getElementById('export-builder-body');
  if (!body || !EB.data) return;
  // Preserve scroll position across the innerHTML rewrite — without this,
  // any action that re-renders (checkbox tick, drag, bulk-hide, group
  // collapse, profile load) jumps the table back to scrollLeft=0, which
  // is jarring when the researcher was reviewing per-post columns far to
  // the right. requestAnimationFrame restores once the new DOM is laid out.
  const prevScroll = body.querySelector('.eb-table-scroll');
  const savedScrollLeft = prevScroll ? prevScroll.scrollLeft : 0;
  const savedScrollTop  = prevScroll ? prevScroll.scrollTop  : 0;
  const { default_columns, rows, profiles } = EB.data;
  const colByKey = Object.fromEntries(default_columns.map(c => [c.key, c]));
  const cfg = EB.workingConfig.columns;
  const visibleCount = cfg.filter(c => c.visible !== false).length;
  const hiddenCount  = cfg.length - visibleCount;
  const typeBadge = t => ({ number: '🔢', text: '📝', categorical: '🏷', link: '🔗' }[t] || '');
  const profileNames = Object.keys(profiles || {});

  // Group keys + collapsed state (localStorage per-study)
  const groupKey = 'eb_collapsed_' + EB.studyId;
  let collapsedGroups = new Set();
  try { collapsedGroups = new Set(JSON.parse(localStorage.getItem(groupKey) || '[]')); } catch {}

  // Build the "all" column order with type/group from defaults, then decide
  // which to actually render based on EB.showHidden.
  const allCols = cfg.map(c => ({
    ...colByKey[c.key],
    header_override: c.header,
    visible: c.visible !== false,
  })).filter(c => c.key);
  // "Rendered as hidden" combines TWO orthogonal sources: per-column visibility
  // (cfg.visible=false) AND group-collapse (user clicked ▾ on a group bar).
  // The show/hide-hidden toggle controls BOTH so the count and behavior match.
  const isColRenderedHidden = c => !c.visible || collapsedGroups.has(c.group);
  const renderedHiddenCount = allCols.filter(isColRenderedHidden).length;
  const effectiveCols = EB.showHidden ? allCols : allCols.filter(c => !isColRenderedHidden(c));

  body.innerHTML = `
    <div class="eb-toolbar">
      <div class="eb-toolbar-group">
        <select class="eb-profile-select" onchange="ebApplyProfile(this.value)" title="${t('export.eb_load_profile')}">
          <option value="">${t('export.eb_choose_profile')}</option>
          ${profileNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-xs" onclick="ebSaveProfile()" title="${t('export.eb_save_profile_title')}">${t('export.eb_save_profile')}</button>
        ${profileNames.length ? `<button class="btn btn-ghost btn-xs" onclick="ebDeleteProfilePrompt()">${t('export.eb_delete_profile')}</button>` : ''}
      </div>
      <div class="eb-toolbar-group" style="margin-left:auto">
        ${renderedHiddenCount ? `<button class="btn btn-ghost btn-xs" onclick="ebToggleShowHidden()" title="${t('export.eb_show_hidden_title')}">
          ${EB.showHidden ? t('export.eb_hide_hidden', { n: renderedHiddenCount }) : t('export.eb_show_hidden', { n: renderedHiddenCount })}
        </button>` : ''}
        <input type="search" class="eb-filter" placeholder="${t('export.eb_filter_placeholder')}" value="${esc(EB.filter)}" oninput="ebSetFilter(this.value)">
        <button class="btn btn-ghost btn-xs" onclick="ebResetToDefaults()">↺ Reset</button>
        <button class="btn btn-primary btn-xs" onclick="ebSaveConfig()">${t('export.eb_save_layout')}</button>
      </div>
    </div>
    <div class="eb-stats">
      <span><strong>${allCols.length - renderedHiddenCount}</strong>/${cfg.length} ${t('export.eb_visible')}</span>
      ${renderedHiddenCount ? `<span style="color:var(--muted)"> · ${t('export.eb_hidden_count', { n: renderedHiddenCount })}${hiddenCount && hiddenCount < renderedHiddenCount ? t('export.eb_hidden_manual', { n: hiddenCount }) : hiddenCount ? '' : t('export.eb_hidden_groups')}</span>` : ''}
      ${EB.selectedKeys.size ? `
        <span class="eb-bulk-bar">
          <span class="eb-bulk-count">${t('export.eb_selected_count', { n: EB.selectedKeys.size })}</span>
          <button class="btn btn-ghost btn-xs" onclick="ebBulkHide()" title="${t('export.eb_bulk_hide_title')}">${t('export.eb_bulk_hide')}</button>
          <button class="btn btn-ghost btn-xs" onclick="ebBulkShow()" title="${t('export.eb_bulk_show_title')}">${t('export.eb_bulk_show')}</button>
          <button class="btn btn-ghost btn-xs" onclick="ebClearSelection()" title="${t('export.eb_clear_sel_title')}">${t('export.eb_clear_sel')}</button>
        </span>` : ''}
      <span style="color:var(--muted);margin-left:auto">
        ${t('export.eb_preview_rows', { n: rows.length })} ${rows.length === 0 ? t('export.eb_no_rows_hint') : t('export.eb_export_all_hint')}
      </span>
    </div>
    <div class="eb-hint">${t('export.eb_hint')}</div>

    <div class="eb-table-scroll">
      <table class="eb-table">
        <thead>
          <tr>
            ${effectiveCols.map((c, idx) => {
              const isPinned = !!c.pinned;
              const isCollapsedGroup = collapsedGroups.has(c.group);
              const isHidden = !c.visible || isCollapsedGroup;
              const headerText = c.header_override != null && c.header_override !== '' ? c.header_override : c.header;
              return `<th class="eb-th ${isPinned ? 'eb-pin' : ''} ${isHidden ? 'eb-hidden' : ''}"
                          data-key="${esc(c.key)}" data-idx="${idx}" data-group="${esc(c.group || '')}"
                          draggable="${!isPinned}"
                          ondragstart="ebDragStart(event, ${idx})"
                          ondragover="ebDragOver(event)"
                          ondragend="ebDragEnd(event)"
                          ondrop="ebDrop(event, ${idx})">
                <div class="eb-th-inner">
                  <input type="checkbox" class="eb-th-checkbox" ${EB.selectedKeys.has(c.key) ? 'checked' : ''}
                         onclick="ebToggleSelect('${esc(c.key)}', event)"
                         onmousedown="event.stopPropagation()" title="${t('export.eb_select_title')}">
                  <span class="eb-th-type" title="${esc(c.type || '')}">${typeBadge(c.type)}</span>
                  <span class="eb-th-label">${esc(headerText)}</span>
                  <button class="eb-th-menu-btn" onclick="ebOpenColMenu(event, ${idx})" title="${t('export.eb_col_options')}">⋮</button>
                </div>
              </th>`;
            }).join('')}
          </tr>
          <tr class="eb-th-groups">
            ${(() => {
              // Render group bars: for each group with collapsible, show a tiny bar
              // spanning that group's contiguous columns
              const groups = [];
              let current = null;
              effectiveCols.forEach((c, i) => {
                if (!current || current.group !== c.group) {
                  if (current) groups.push(current);
                  current = { group: c.group, start: i, span: 1 };
                } else current.span++;
              });
              if (current) groups.push(current);
              return groups.map(g => {
                const label = g.group === '__meta' ? 'meta' : g.group === '__demo' ? t('export.eb_group_demo') : g.group;
                const isCollapsed = collapsedGroups.has(g.group);
                // All groups are collapsible — including META. Pinned columns
                // inside a collapsed group still hide (consistent with __demo
                // and post groups); researcher can expand back if they need
                // session_id / full_condition visible in the preview.
                return `<th class="eb-group-th ${isCollapsed ? 'eb-group-collapsed' : ''}" colspan="${g.span}"
                    onclick="ebToggleGroup('${esc(g.group)}')" title="${t('export.eb_toggle_group')}">
                  ${isCollapsed ? '▸' : '▾'} ${esc(label)}
                </th>`;
              }).join('');
            })()}
          </tr>
        </thead>
        <tbody>
          ${rows.filter(r => {
            if (!EB.filter) return true;
            const lf = EB.filter.toLowerCase();
            return effectiveCols.some(c => {
              const v = r[c.key];
              return v != null && String(v).toLowerCase().includes(lf);
            });
          }).slice(0, 20).map(r => `
            <tr>
              ${effectiveCols.map(c => {
                const isPinned = !!c.pinned;
                const isCollapsedGroup = collapsedGroups.has(c.group);
                const isHidden = !c.visible || isCollapsedGroup;
                let v = r[c.key];
                if (v && typeof v === 'object' && v.hyperlink) v = v.text || v.hyperlink;
                if (v == null) v = '';
                const display = String(v).length > 60 ? String(v).slice(0, 60) + '…' : String(v);
                return `<td class="${isPinned ? 'eb-pin' : ''} ${isHidden ? 'eb-hidden' : ''}" title="${esc(String(v))}">${esc(display)}</td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  // Restore the scroll position captured before the innerHTML rewrite.
  // requestAnimationFrame guarantees the new .eb-table-scroll has been laid
  // out by the browser; doing this synchronously sets scrollLeft on an
  // element whose scrollWidth hasn't been computed yet → silently ignored.
  if (savedScrollLeft || savedScrollTop) {
    requestAnimationFrame(() => {
      const newScroll = body.querySelector('.eb-table-scroll');
      if (newScroll) {
        newScroll.scrollLeft = savedScrollLeft;
        newScroll.scrollTop  = savedScrollTop;
      }
    });
  }
}

// ── Builder event handlers ────────────────────────────────────────────────

function ebSetFilter(v) {
  EB.filter = v;
  renderExportBuilder();
  // Restore focus on the search input since renderExportBuilder rebuilt the DOM
  requestAnimationFrame(() => {
    const inp = document.querySelector('.eb-filter');
    if (inp) { inp.focus(); inp.setSelectionRange(v.length, v.length); }
  });
}

function ebToggleGroup(group) {
  const key = 'eb_collapsed_' + EB.studyId;
  let s = new Set(); try { s = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch {}
  if (s.has(group)) s.delete(group); else s.add(group);
  localStorage.setItem(key, JSON.stringify([...s]));
  renderExportBuilder();
}

function ebToggleShowHidden() {
  EB.showHidden = !EB.showHidden;
  renderExportBuilder();
}

let _ebDragFrom = null;
function ebDragStart(e, idx) {
  _ebDragFrom = idx;
  e.dataTransfer.effectAllowed = 'move';
  // Mark the dragged TH so CSS can style it. Use setData so Firefox actually
  // initiates the drag.
  try { e.dataTransfer.setData('text/plain', String(idx)); } catch {}
  e.currentTarget.classList.add('eb-dragging');
}
function ebDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // Add a visual drop-target indicator on the column being hovered
  const th = e.currentTarget;
  if (th && !th.classList.contains('eb-drop-target')) {
    document.querySelectorAll('.eb-drop-target').forEach(el => el.classList.remove('eb-drop-target'));
    th.classList.add('eb-drop-target');
  }
}
function ebDragEnd(e) {
  document.querySelectorAll('.eb-dragging, .eb-drop-target').forEach(el => {
    el.classList.remove('eb-dragging'); el.classList.remove('eb-drop-target');
  });
  _ebDragFrom = null;
}
function ebDrop(e, toIdx) {
  e.preventDefault();
  document.querySelectorAll('.eb-dragging, .eb-drop-target').forEach(el => {
    el.classList.remove('eb-dragging'); el.classList.remove('eb-drop-target');
  });
  if (_ebDragFrom == null || _ebDragFrom === toIdx) { _ebDragFrom = null; return; }
  // When showHidden=false the visible-index !== cfg-index, so we look up the
  // real keys via the rendered <th> data-key and find their positions in cfg.
  const allTh = document.querySelectorAll('#export-builder-body .eb-th');
  const fromKey = allTh[_ebDragFrom]?.dataset?.key;
  const toKey   = allTh[toIdx]?.dataset?.key;
  if (!fromKey || !toKey) { _ebDragFrom = null; return; }
  const cols = EB.workingConfig.columns;
  const fromCfgIdx = cols.findIndex(c => c.key === fromKey);
  const toCfgIdx   = cols.findIndex(c => c.key === toKey);
  if (fromCfgIdx < 0 || toCfgIdx < 0) { _ebDragFrom = null; return; }
  const [moved] = cols.splice(fromCfgIdx, 1);
  cols.splice(toCfgIdx, 0, moved);
  _ebDragFrom = null;
  renderExportBuilder();
}

function ebOpenColMenu(e, effIdx) {
  e.stopPropagation();
  // The template passes the index within `effectiveCols` (the filtered render
  // list). When groups are collapsed or showHidden=false, that index does NOT
  // match the absolute position in EB.workingConfig.columns. Mirror the
  // resolution pattern used by ebDrop: read data-key off the rendered <th> and
  // find its real position in cfg. Without this, clicking ⋮ on column X opened
  // the menu for whichever column happened to share absolute index X in cfg
  // (e.g. clicking POST_1_SHARES_SHOWN opened the gender column's editor).
  const allTh = document.querySelectorAll('#export-builder-body .eb-th');
  const key = allTh[effIdx]?.dataset?.key;
  const idx = key ? EB.workingConfig.columns.findIndex(c => c.key === key) : -1;
  if (idx < 0) return;
  const cfg = EB.workingConfig.columns[idx];
  const def = (EB.data.default_columns.find(c => c.key === cfg.key)) || {};
  const headerCurrent = cfg.header != null && cfg.header !== '' ? cfg.header : def.header;
  // Lightweight inline menu — built fresh each open, closed on outside click
  document.querySelectorAll('.eb-col-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'eb-col-menu';
  menu.innerHTML = `
    <div class="eb-col-menu-row">
      <label style="font-size:0.78rem;color:var(--muted);display:block;margin-bottom:0.2rem">${t('export.eb_header_name')}</label>
      <input type="text" class="eb-col-menu-header" value="${esc(headerCurrent || '')}" placeholder="${esc(def.header || '')}">
    </div>
    <div class="eb-col-menu-row">
      <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
        <input type="checkbox" class="eb-col-menu-visible" ${cfg.visible !== false ? 'checked' : ''}>
        ${t('export.eb_visible_col')}
      </label>
    </div>
    <div class="eb-col-menu-row" style="display:flex;gap:0.3rem;justify-content:space-between">
      <button class="btn btn-ghost btn-xs" onclick="ebColMenuMove(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>${t('export.eb_move_left')}</button>
      <button class="btn btn-ghost btn-xs" onclick="ebColMenuMove(${idx}, 1)" ${idx === EB.workingConfig.columns.length - 1 ? 'disabled' : ''}>${t('export.eb_move_right')}</button>
      <button class="btn btn-primary btn-xs" onclick="ebColMenuApply(${idx})">${t('export.eb_apply')}</button>
    </div>
    <div class="eb-col-menu-row" style="font-size:0.72rem;color:var(--muted)">
      ${t('export.eb_key_label')} <code>${esc(cfg.key)}</code> · ${t('export.eb_type_label')} ${esc(def.type || '?')}
    </div>
  `;
  // Position relative to clicked button
  const rect = e.target.getBoundingClientRect();
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${Math.max(8, Math.min(rect.left, window.innerWidth - 270))}px;z-index:9999`;
  document.body.appendChild(menu);
  setTimeout(() => {
    const closer = ev => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closer); }
    };
    document.addEventListener('click', closer);
  }, 0);
}
function ebColMenuApply(idx) {
  const menu = document.querySelector('.eb-col-menu');
  if (!menu) return;
  const headerInput = menu.querySelector('.eb-col-menu-header');
  const visInput    = menu.querySelector('.eb-col-menu-visible');
  const cfg = EB.workingConfig.columns[idx];
  const newHeader = headerInput.value.trim();
  cfg.header  = newHeader === '' ? null : newHeader; // null = use default
  cfg.visible = visInput.checked;
  menu.remove();
  renderExportBuilder();
}
function ebColMenuMove(idx, dir) {
  const cols = EB.workingConfig.columns;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= cols.length) return;
  [cols[idx], cols[newIdx]] = [cols[newIdx], cols[idx]];
  document.querySelector('.eb-col-menu')?.remove();
  renderExportBuilder();
}

// ── Bulk selection / bulk hide ───────────────────────────────────────────────
// Header checkboxes accumulate selected column keys in EB.selectedKeys. The
// bar in .eb-stats appears whenever any key is selected and offers bulk-hide,
// bulk-show, and clear-selection actions. We key on c.key (not effectiveCols
// index) so collapsed-group filtering / showHidden state can't desync the
// selection from the underlying config.
function ebToggleSelect(key, ev) {
  if (ev) ev.stopPropagation();
  if (EB.selectedKeys.has(key)) EB.selectedKeys.delete(key);
  else EB.selectedKeys.add(key);
  renderExportBuilder();
}
function ebBulkHide() {
  if (!EB.selectedKeys.size) return;
  EB.workingConfig.columns.forEach(c => { if (EB.selectedKeys.has(c.key)) c.visible = false; });
  EB.selectedKeys.clear();
  renderExportBuilder();
}
function ebBulkShow() {
  if (!EB.selectedKeys.size) return;
  EB.workingConfig.columns.forEach(c => { if (EB.selectedKeys.has(c.key)) c.visible = true; });
  EB.selectedKeys.clear();
  renderExportBuilder();
}
function ebClearSelection() {
  EB.selectedKeys.clear();
  renderExportBuilder();
}

async function ebSaveConfig() {
  const r = await api('PUT', `/export/${EB.studyId}/config`, { sheet: EB.sheet, config: EB.workingConfig });
  if (r?.ok) toast(t('export.layout_saved'));
}

function ebResetToDefaults() {
  if (!confirm(t('export.reset_confirm'))) return;
  EB.workingConfig = { columns: EB.data.default_columns.map(c => ({ key: c.key, header: null, visible: true })) };
  renderExportBuilder();
  toast(t('export.reset_done'));
}

async function ebSaveProfile() {
  const name = prompt(t('export.profile_name_prompt'));
  if (!name || !name.trim()) return;
  const r = await api('POST', `/export/${EB.studyId}/profiles`, {
    name: name.trim(), sheet: EB.sheet, config: EB.workingConfig,
  });
  if (r?.ok) { toast(t('export.profile_saved')); loadExportBuilder(EB.studyId); }
}

function ebApplyProfile(name) {
  if (!name) return;
  const profile = EB.data.profiles[name]?.[EB.sheet];
  if (!profile) return toast(t('export.profile_no_sheet_config'), 'error');
  // Merge profile cols with defaults (forward-compat)
  const seen = new Set();
  const merged = [];
  profile.columns.forEach(c => {
    if (EB.data.default_columns.some(d => d.key === c.key)) { merged.push(c); seen.add(c.key); }
  });
  EB.data.default_columns.forEach(d => { if (!seen.has(d.key)) merged.push({ key: d.key, header: null, visible: true }); });
  EB.workingConfig = { columns: merged };
  renderExportBuilder();
  toast(t('export.profile_loaded', { name }));
}

async function ebDeleteProfilePrompt() {
  const names = Object.keys(EB.data.profiles || {});
  if (!names.length) return;
  const name = prompt(t('export.delete_profile_prompt', { names: names.join(', ') }));
  if (!name || !names.includes(name)) return;
  if (!confirm(t('export.delete_profile_confirm', { name }))) return;
  const r = await api('DELETE', `/export/${EB.studyId}/profiles/${encodeURIComponent(name)}`);
  if (r?.ok) { toast(t('export.profile_deleted')); loadExportBuilder(EB.studyId); }
}

// ── Demographic Questions ──────────────────────────────────────────────────
async function loadDemographicQuestions(studyId) {
  document.getElementById('dq-list').innerHTML = '<div class="empty-state">Ładowanie...</div>';
  const questions = await api('GET', `/studies/${studyId}/demographic-questions`);
  if (!questions) return;
  renderDemographicQuestions(Array.isArray(questions) ? questions : []);
}

function renderDemographicQuestions(questions) {
  const container = document.getElementById('dq-list');
  if (!questions.length) {
    container.innerHTML = '<div class="empty-state">Brak pytań demograficznych.</div>';
    return;
  }
  container.innerHTML = questions.map(q => {
    let options = [];
    try { options = JSON.parse(q.options || '[]'); } catch {}
    const pillsHTML = options.map(o => `<span class="dq-pill">${esc(o.label || o.value)}</span>`).join('');
    const badgeClass = q.is_active ? 'badge-active' : 'badge-inactive';
    const badgeText = q.is_active ? 'Aktywne' : 'Ukryte';
    return `
      <div class="dq-card">
        <div class="dq-card-order">${q.order_index + 1}.</div>
        <div class="dq-card-body">
          <div class="dq-card-label">${esc(q.label)}</div>
          <div class="dq-card-meta">
            <code style="font-size:0.75rem;background:var(--surface2);padding:0.1rem 0.4rem;border-radius:4px">${esc(q.field_key)}</code>
            &nbsp;·&nbsp; ${esc(q.input_type)}
            &nbsp;·&nbsp; <span class="badge ${badgeClass}" style="font-size:0.68rem">${badgeText}</span>
            ${q.required ? `&nbsp;·&nbsp; <span style="font-size:0.72rem;color:var(--muted)">${t('demog.required_flag')}</span>` : ''}
          </div>
          ${options.length ? `<div class="dq-pills">${pillsHTML}</div>` : ''}
        </div>
        <div class="dq-card-actions">
          <button class="btn btn-ghost btn-sm" onclick="reorderDQ(${q.id},'up')" title="${t('demog.move_up')}">↑</button>
          <button class="btn btn-ghost btn-sm" onclick="reorderDQ(${q.id},'down')" title="${t('demog.move_down')}">↓</button>
          <button class="btn btn-ghost btn-sm" onclick="openDQModal(${q.id})">${t('demog.edit')}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteDQ(${q.id}, '${esc(q.label)}')">${t('demog.delete')}</button>
        </div>
      </div>`;
  }).join('');
}

const DEFAULT_FIELD_KEYS = ['age', 'residence', 'education', 'gender'];

async function openDQModal(id) {
  const studyId = S.activeStudy;
  const questions = await api('GET', `/studies/${studyId}/demographic-questions`);
  if (!questions) return;
  const dq = questions.find(q => q.id === id);
  if (!dq) return;
  let options = [];
  try { options = JSON.parse(dq.options || '[]'); } catch {}
  const isDefault = DEFAULT_FIELD_KEYS.includes(dq.field_key);
  showModal(`
    <h2>${t('demog.edit_title')}</h2>
    <div class="form-group">
      <label>Field key</label>
      <input type="text" id="dq-field-key" value="${esc(dq.field_key)}" ${isDefault ? 'readonly style="opacity:0.5"' : ''}>
    </div>
    <div class="form-group">
      <label>${t('demog.label_question')}</label>
      <input type="text" id="dq-label" value="${esc(dq.label)}">
    </div>
    <div class="form-group">
      <label>${t('demog.field_type')}</label>
      <select id="dq-input-type" onchange="toggleDQOptionsSection()">
        <option value="radio"       ${dq.input_type === 'radio'       ? 'selected' : ''}>${t('demog.type_radio')}</option>
        <option value="multiselect" ${dq.input_type === 'multiselect' ? 'selected' : ''}>${t('demog.type_multiselect')}</option>
        <option value="text"        ${dq.input_type === 'text'        ? 'selected' : ''}>${t('demog.type_text')}</option>
        <option value="number"      ${dq.input_type === 'number'      ? 'selected' : ''}>${t('demog.type_number')}</option>
      </select>
    </div>
    <div id="dq-options-section" style="${(dq.input_type === 'text' || dq.input_type === 'number') ? 'display:none' : ''}">
      <div class="form-group">
        <label>${t('demog.options_label')}</label>
        <div id="dq-options-list">
          ${options.map((o, i) => dqOptionRowHTML(i, o.value, o.label)).join('')}
        </div>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-top:0.4rem" onclick="addDQOption()">${t('demog.add_option')}</button>
        <p style="font-size:0.78rem;color:var(--muted);margin:0.4rem 0 0">
          ${t('demog.multiselect_hint_1')}
          ${t('demog.multiselect_hint_2')}
        </p>
      </div>
    </div>
    <div id="dq-bounds-section" style="${(dq.input_type === 'text' || dq.input_type === 'number') ? '' : 'display:none'}">
      <div class="form-group">
        <label id="dq-bounds-label">${dq.input_type === 'number' ? t('demog.bounds_range') : t('demog.bounds_chars')}</label>
        <div style="display:flex;gap:0.6rem;align-items:center">
          <input type="number" id="dq-min-value" step="any" placeholder="min" value="${dq.min_value != null ? dq.min_value : ''}" style="width:130px">
          <span style="color:var(--muted)">—</span>
          <input type="number" id="dq-max-value" step="any" placeholder="max" value="${dq.max_value != null ? dq.max_value : ''}" style="width:130px">
        </div>
        <p style="font-size:0.78rem;color:var(--muted);margin:0.4rem 0 0">${t('demog.bounds_hint_edit')}</p>
      </div>
    </div>
    <div class="form-group" style="display:flex;gap:1.5rem;align-items:center;margin-top:0.5rem">
      <label class="toggle-wrap">
        <label class="toggle"><input type="checkbox" id="dq-required" ${dq.required ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('demog.required')}</span>
      </label>
      <label class="toggle-wrap">
        <label class="toggle"><input type="checkbox" id="dq-active" ${dq.is_active ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('demog.active')}</span>
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary" onclick="saveDemographicQuestion(${id})">${t('demog.save')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">${t('demog.cancel')}</button>
    </div>
  `);
}

function dqOptionRowHTML(idx, value, label) {
  return `<div class="dq-option-row" data-opt-idx="${idx}">
    <input type="text" placeholder="${t('demog.opt_value_ph')}" value="${esc(value)}" data-opt-field="value" style="max-width:none">
    <input type="text" placeholder="${t('demog.opt_label_ph')}" value="${esc(label)}" data-opt-field="label" style="max-width:none">
    <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.dq-option-row').remove()">✕</button>
  </div>`;
}

function toggleDQOptionsSection() {
  const type = document.getElementById('dq-input-type')?.value;
  const optionsSection = document.getElementById('dq-options-section');
  const boundsSection  = document.getElementById('dq-bounds-section');
  const boundsLabel    = document.getElementById('dq-bounds-label');
  const isFreeform = (type === 'text' || type === 'number');
  if (optionsSection) optionsSection.style.display = isFreeform ? 'none' : '';
  if (boundsSection)  boundsSection.style.display  = isFreeform ? '' : 'none';
  // Flip the bounds label between "Liczba znaków" (text) and "Zakres
  // wartości" (number) so the researcher knows what min/max actually mean.
  if (boundsLabel) boundsLabel.textContent = type === 'number' ? t('demog.bounds_range') : t('demog.bounds_chars');
}

function addDQOption() {
  const list = document.getElementById('dq-options-list');
  if (!list) return;
  const idx = list.children.length;
  const div = document.createElement('div');
  div.innerHTML = dqOptionRowHTML(idx, '', '');
  list.appendChild(div.firstElementChild);
}

async function saveDemographicQuestion(id) {
  const fieldKey = document.getElementById('dq-field-key')?.value.trim();
  const label = document.getElementById('dq-label')?.value.trim();
  const inputType = document.getElementById('dq-input-type')?.value;
  const required = document.getElementById('dq-required')?.checked ? 1 : 0;
  const isActive = document.getElementById('dq-active')?.checked ? 1 : 0;
  if (!fieldKey || !label) return toast(t('demog.err_key_label_required'), 'error');
  const optRows = document.querySelectorAll('#dq-options-list .dq-option-row');
  const options = [];
  optRows.forEach(row => {
    const v = row.querySelector('[data-opt-field="value"]')?.value.trim();
    const l = row.querySelector('[data-opt-field="label"]')?.value.trim();
    if (v) options.push({ value: v, label: l || v });
  });
  // Bounds (only meaningful for text/number). Empty input → null so the
  // server clears any previously-set constraint cleanly. parseFloat
  // tolerates both integer and decimal entries (researcher might want
  // 0–18.5 BMI as a freeform check).
  const parseBound = el => {
    const v = el?.value?.trim();
    if (!v) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const minValue = (inputType === 'text' || inputType === 'number')
    ? parseBound(document.getElementById('dq-min-value')) : null;
  const maxValue = (inputType === 'text' || inputType === 'number')
    ? parseBound(document.getElementById('dq-max-value')) : null;
  const data = await api('PUT', `/demographic-questions/${id}`, {
    field_key: fieldKey, label, input_type: inputType,
    options: JSON.stringify(options), required, is_active: isActive,
    min_value: minValue, max_value: maxValue,
  });
  if (!data) return;
  closeModal();
  toast(t('demog.saved'));
  loadDemographicQuestions(S.activeStudy);
}

function openDQNewModal(studyId) {
  showModal(`
    <h2>${t('demog.new_title')}</h2>
    <div class="form-group">
      <label>${t('demog.field_key_label')}</label>
      <input type="text" id="dq-field-key" placeholder="${t('demog.field_key_ph')}">
    </div>
    <div class="form-group">
      <label>${t('demog.label_question')}</label>
      <input type="text" id="dq-label" placeholder="${t('demog.label_ph')}">
    </div>
    <div class="form-group">
      <label>${t('demog.field_type')}</label>
      <select id="dq-input-type" onchange="toggleDQOptionsSection()">
        <option value="radio">${t('demog.type_radio')}</option>
        <option value="multiselect">${t('demog.type_multiselect')}</option>
        <option value="text">${t('demog.type_text')}</option>
        <option value="number">${t('demog.type_number')}</option>
      </select>
    </div>
    <div id="dq-options-section">
      <div class="form-group">
        <label>${t('demog.options_label')}</label>
        <div id="dq-options-list"></div>
        <button type="button" class="btn btn-ghost btn-sm" style="margin-top:0.4rem" onclick="addDQOption()">${t('demog.add_option')}</button>
      </div>
    </div>
    <div id="dq-bounds-section" style="display:none">
      <div class="form-group">
        <label id="dq-bounds-label">${t('demog.bounds_chars')}</label>
        <div style="display:flex;gap:0.6rem;align-items:center">
          <input type="number" id="dq-min-value" step="any" placeholder="min" style="width:130px">
          <span style="color:var(--muted)">—</span>
          <input type="number" id="dq-max-value" step="any" placeholder="max" style="width:130px">
        </div>
        <p style="font-size:0.78rem;color:var(--muted);margin:0.4rem 0 0">${t('demog.bounds_hint_new')}</p>
      </div>
    </div>
    <div class="form-group" style="display:flex;gap:1.5rem;align-items:center;margin-top:0.5rem">
      <label class="toggle-wrap">
        <label class="toggle"><input type="checkbox" id="dq-required" checked><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('demog.required')}</span>
      </label>
      <label class="toggle-wrap">
        <label class="toggle"><input type="checkbox" id="dq-active" checked><span class="toggle-slider"></span></label>
        <span class="toggle-label">${t('demog.active')}</span>
      </label>
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary" onclick="createDemographicQuestion(${studyId})">${t('demog.create')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">${t('demog.cancel')}</button>
    </div>
  `);
}

async function createDemographicQuestion(studyId) {
  const fieldKey = document.getElementById('dq-field-key')?.value.trim();
  const label = document.getElementById('dq-label')?.value.trim();
  const inputType = document.getElementById('dq-input-type')?.value;
  const required = document.getElementById('dq-required')?.checked ? 1 : 0;
  const isActive = document.getElementById('dq-active')?.checked ? 1 : 0;
  if (!fieldKey || !label) return toast(t('demog.err_key_label_required'), 'error');
  const optRows = document.querySelectorAll('#dq-options-list .dq-option-row');
  const options = [];
  optRows.forEach(row => {
    const v = row.querySelector('[data-opt-field="value"]')?.value.trim();
    const l = row.querySelector('[data-opt-field="label"]')?.value.trim();
    if (v) options.push({ value: v, label: l || v });
  });
  // Bounds (min/max) only apply to freeform types — see saveDemographicQuestion
  // for full semantics. POST endpoint currently ignores bounds at creation;
  // they're sent so the immediate-edit case (create → tweak min/max → save)
  // round-trips cleanly via PUT.
  const parseBound = el => {
    const v = el?.value?.trim();
    if (!v) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const minValue = (inputType === 'text' || inputType === 'number')
    ? parseBound(document.getElementById('dq-min-value')) : null;
  const maxValue = (inputType === 'text' || inputType === 'number')
    ? parseBound(document.getElementById('dq-max-value')) : null;
  const data = await api('POST', `/studies/${studyId}/demographic-questions`, {
    field_key: fieldKey, label, input_type: inputType,
    options: JSON.stringify(options), required, is_active: isActive,
    min_value: minValue, max_value: maxValue,
  });
  if (!data) return;
  // Bounds aren't in the POST allowlist on the server (kept narrow on purpose).
  // If the researcher set them at create-time, immediately PUT to persist them.
  if (data.id && (minValue != null || maxValue != null)) {
    await api('PUT', `/demographic-questions/${data.id}`, { min_value: minValue, max_value: maxValue });
  }
  closeModal();
  toast(t('demog.added'));
  loadDemographicQuestions(studyId);
}

async function reorderDQ(id, direction) {
  await api('POST', `/demographic-questions/${id}/reorder`, { direction });
  loadDemographicQuestions(S.activeStudy);
}

async function deleteDQ(id, label) {
  if (!confirm(t('demog.confirm_delete', { label }))) return;
  await api('DELETE', `/demographic-questions/${id}`);
  toast(t('demog.deleted'));
  loadDemographicQuestions(S.activeStudy);
}

document.getElementById('btn-add-dq').onclick = () => {
  if (!S.activeStudy) return toast(t('demog.select_study'), 'error');
  openDQNewModal(S.activeStudy);
};

// Otwiera ekran pytań demograficznych w nowej karcie z pominięciem zgody
// i instrukcji. Trigger: ?preview=1&focus=demographics w URL. Sesja jest
// tworzona z is_preview=1, więc nie zaśmieca produkcyjnych danych. Submit
// formularza w tym trybie pokazuje "Podgląd zakończony" zamiast iść dalej —
// patrz obsługa S.focusMode w public/js/participant.js.
document.getElementById('btn-preview-dq').onclick = () => {
  if (!S.activeStudy) return toast(t('demog.select_study'), 'error');
  const study = S.studies?.find(x => x.id == S.activeStudy);
  if (!study?.slug) return toast(t('demog.no_slug'), 'error');
  window.open(`/study/${study.slug}?preview=1&focus=demographics`, '_blank');
};

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// \u2500\u2500 Platform Translations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Flatten nested locale object to [{key, value}] preserving insertion order
function flattenLocale(obj, prefix) {
  prefix = prefix || '';
  const rows = [];
  Object.keys(obj).forEach(function(k) {
    const fullKey = prefix ? prefix + '.' + k : k;
    if (obj[k] !== null && typeof obj[k] === 'object') {
      flattenLocale(obj[k], fullKey).forEach(function(r) { rows.push(r); });
    } else {
      rows.push({ key: fullKey, value: String(obj[k]) });
    }
  });
  return rows;
}

// Rebuild nested object from flat {key: value} map
function unflattenLocale(flat) {
  const result = {};
  Object.keys(flat).forEach(function(dotKey) {
    const parts = dotKey.split('.');
    let node = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = flat[dotKey];
  });
  return result;
}

async function openPlatformTranslations() {
  // overrideMaps tracks which keys are CURRENTLY served from the DB
  // (locale_overrides table) vs the file baseline. Server returns this
  // under data.__overrides[lang] = { 'actions.like': {value, updated_at}, \u2026 }.
  // We display a small "\ud83d\udcbe DB" badge next to those keys so the researcher
  // sees AT A GLANCE which edits have persisted across redeploys \u2014 no more
  // "I saved this but did it actually go through?" mystery.
  let data = await api('GET', '/locales');
  if (!data) return;
  let overrideMaps = data.__overrides || {};

  const plRows = flattenLocale(data.pl);

  const langMeta = [
    { code: 'pl', flag: '\ud83c\uddf5\ud83c\uddf1', label: 'Polski' },
    { code: 'en', flag: '\ud83c\uddec\ud83c\udde7', label: 'English' },
    { code: 'cs', flag: '\ud83c\udde8\ud83c\uddff', label: '\u010ce\u0161tina' },
    { code: 'sk', flag: '\ud83c\uddf8\ud83c\uddf0', label: 'Sloven\u010dina' },
  ];

  // Build an editable map for every language (including PL)
  const langMaps = {};
  langMeta.forEach(function(lm) {
    const flat = flattenLocale(data[lm.code] || {});
    const map = {};
    flat.forEach(function(r) { map[r.key] = r.value; });
    langMaps[lm.code] = map;
  });

  let activeLang = 'en';

  function buildRows(lang) {
    const isEditingPl = lang === 'pl';
    const map = langMaps[lang] || {};
    // Pull the PL display value live from langMaps.pl rather than the
    // initial plRows snapshot. Otherwise: researcher edits a PL string
    // \u2192 langMaps.pl[key] updates \u2192 researcher switches to a non-PL tab
    // (which renders PL as a read-only left column) \u2192 plRows.value
    // still holds the value from page-load and shows the STALE text.
    // Same loop also picks up the placeholder for non-PL inputs so the
    // EN/CS/SK input fields show the latest PL as the implicit fallback.
    const plMap = langMaps.pl || {};
    const overrides = overrideMaps[lang] || {};
    return plRows.map(function(r) {
      const plLive = plMap[r.key] !== undefined ? plMap[r.key] : r.value;
      const editVal = map[r.key] !== undefined ? map[r.key] : '';
      // Badge: this key is overridden in DB for the active language \u2014
      // i.e. the researcher's save persisted. Hover shows the timestamp
      // so they can confirm WHEN their edit landed.
      const hasOverride = !!overrides[r.key];
      const badgeTitle = hasOverride
        ? 'Edytowane w bazie ' + (overrides[r.key].updated_at || '') + ' \u2014 prze\u017cywa redeploy'
        : 'Z pliku locale (baseline) \u2014 edycja zapisze si\u0119 do bazy';
      const badge = `<span class="pt-badge ${hasOverride ? 'pt-badge-db' : 'pt-badge-file'}" title="${esc(badgeTitle)}">${hasOverride ? '\ud83d\udcbe DB' : '\ud83d\udcc4 PL.json'}</span>`;
      const rightCell = isEditingPl
        ? '' // no second column when editing PL \u2014 PL IS the editable column
        : `<td class="pt-edit"><input type="text" class="pt-input" data-key="${esc(r.key)}" value="${esc(editVal)}" placeholder="${esc(plLive)}">${badge}</td>`;
      const plCell = isEditingPl
        ? `<td class="pt-edit" colspan="2"><input type="text" class="pt-input" data-key="${esc(r.key)}" value="${esc(editVal)}">${badge}</td>`
        : `<td class="pt-pl">${esc(plLive)}</td>`;
      return `<tr data-key="${esc(r.key)}">
        <td class="pt-key">${esc(r.key)}</td>
        ${plCell}
        ${rightCell}
      </tr>`;
    }).join('');
  }

  function buildTabButtons() {
    return langMeta.map(function(lm) {
      const active = lm.code === activeLang ? ' pt-tab-active' : '';
      return `<button type="button" class="btn btn-ghost btn-sm pt-tab${active}" data-lang="${lm.code}">${lm.flag} ${lm.label}</button>`;
    }).join('');
  }

  function render() {
    const wrap = document.getElementById('pt-wrap');
    if (!wrap) return;
    const isEditingPl = activeLang === 'pl';
    const activeMeta = langMeta.find(function(l) { return l.code === activeLang; });
    const rightHeader = isEditingPl ? '' : `<th style="width:36%">${activeMeta.flag} ${activeMeta.label}</th>`;
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap">
        ${buildTabButtons()}
        <button type="button" class="btn btn-primary btn-sm" style="margin-left:auto" id="pt-save">\ud83d\udcbe Zapisz ${activeMeta.flag}</button>
      </div>
      <div style="overflow-x:auto">
        <table class="pt-table">
          <thead><tr>
            <th style="width:28%">${t('utils.col_key')}</th>
            <th style="${isEditingPl ? 'width:72%' : 'width:36%'}">\ud83c\uddf5\ud83c\uddf1 Polski${isEditingPl ? ' (edytowalny)' : ''}</th>
            ${rightHeader}
          </tr></thead>
          <tbody>${buildRows(activeLang)}</tbody>
        </table>
      </div>`;

    // Tab click
    wrap.querySelectorAll('.pt-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        // Save current inputs to langMaps before switching
        collectCurrentInputs();
        activeLang = btn.dataset.lang;
        render();
      });
    });

    // Save button. After PUT we re-fetch GET /locales and compare each
    // sent key against what the server now serves \u2014 if any mismatch, the
    // save silently failed (transaction abort, DB locked, whatever) and
    // we show an explicit error toast pointing at the failed key instead
    // of letting the researcher discover it later by trial and error.
    document.getElementById('pt-save').addEventListener('click', async function() {
      collectCurrentInputs();
      const flat = langMaps[activeLang];
      const nested = unflattenLocale(flat);
      const sentLang = activeLang;
      const result = await api('PUT', `/locales/${sentLang}`, nested);
      if (!result) return;  // api() already toasted the error
      // Re-fetch so the badges and the PL live column reflect what the
      // server actually accepted. Also catches silent persistence failures.
      const fresh = await api('GET', '/locales');
      if (fresh) {
        data = fresh;
        overrideMaps = fresh.__overrides || {};
        // Refresh local langMaps + plRows from fresh data, then re-render.
        langMeta.forEach(function(lm) {
          const fl = flattenLocale(fresh[lm.code] || {});
          const map = {};
          fl.forEach(function(r) { map[r.key] = r.value; });
          langMaps[lm.code] = map;
        });
        // Verify every non-empty key we sent shows up either as a DB
        // override (preferred) or as a file baseline match (researcher
        // typed the default text back in).
        const mismatched = [];
        Object.keys(flat).forEach(function(k) {
          const sentVal = flat[k];
          if (sentVal == null || sentVal === '') return;
          const liveVal = langMaps[sentLang][k];
          if (liveVal !== sentVal) mismatched.push(k);
        });
        if (mismatched.length) {
          toast(t('utils.save_failed_keys', { n: mismatched.length, keys: mismatched.slice(0, 2).join(', ') }), 'error');
        } else {
          toast('Zapisano t\u0142umaczenia dla ' + sentLang.toUpperCase() + ' (zachowane w bazie)');
        }
        render();
      } else {
        toast('Zapisano, ale nie uda\u0142o si\u0119 od\u015bwie\u017cy\u0107 \u2014 sprawd\u017a r\u0119cznie', 'error');
      }
    });
  }

  function collectCurrentInputs() {
    const wrap = document.getElementById('pt-wrap');
    if (!wrap) return;
    wrap.querySelectorAll('.pt-input').forEach(function(inp) {
      langMaps[activeLang][inp.dataset.key] = inp.value;
    });
  }

  showModal(`
    <h2>T\u0142umaczenia interfejsu</h2>
    <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">Edytuj etykiety interfejsu uczestnika. Tab \ud83c\uddf5\ud83c\uddf1 pozwala edytowa\u0107 polskie zwroty.</p>
    <div id="pt-wrap"></div>
  `);

  // Make the modal wider
  const box = document.getElementById('modal-box');
  if (box) box.style.maxWidth = '860px';

  render();
}

// ── Analyses tab — quick-look statistical tests ─────────────────────────────
// Uses the same data layer as the export builder (getDaneSuroweData on the
// backend). Researcher picks a test + variables → POST /analyze → result
// rendered as APA-style text + table + interpretation. Saved analyses are
// templates (test type + variable picks), re-run against current data on
// every load so they stay live as new sessions roll in.

const AN = {
  studyId: null,
  columns: [],         // column metadata from /export/preview (drives variable pickers)
  saved: [],           // list of saved analyses for this study
  currentTest: 'descriptives',
  currentParams: {},   // working parameters being edited
  currentResult: null, // last computed result
  running: false,
};

// Test catalogue — what each test needs as input + Polish UI labels
const AN_TESTS = {
  descriptives: {
    label: t('analyses.descriptives.label'),
    icon: '📋',
    description: t('analyses.descriptives.desc'),
    fields: [
      { key: 'variable', label: t('analyses.field.variable'), type: 'col', filter: c => c.type === 'number' },
    ],
  },
  t_test: {
    label: t('analyses.t_test.label'),
    icon: '📊',
    description: t('analyses.t_test.desc'),
    fields: [
      { key: 'paired', label: t('analyses.field.paired'), type: 'checkbox' },
      { key: 'variable', label: t('analyses.field.variable_continuous'), type: 'col', filter: c => c.type === 'number' },
      { key: 'group_variable', label: t('analyses.field.group_variable_groups'), type: 'col', filter: c => c.type === 'categorical' || c.type === 'text', when: p => !p.paired },
      { key: 'variable2', label: t('analyses.field.variable2'), type: 'col', filter: c => c.type === 'number', when: p => p.paired },
    ],
  },
  anova: {
    label: t('analyses.anova.label'),
    icon: '📈',
    description: t('analyses.anova.desc'),
    fields: [
      { key: 'variable', label: t('analyses.field.dependent_continuous'), type: 'col', filter: c => c.type === 'number' },
      { key: 'group_variable', label: t('analyses.field.group_variable_cats'), type: 'col', filter: c => c.type === 'categorical' || c.type === 'text' },
    ],
  },
  chi_square: {
    label: t('analyses.chi_square.label'),
    icon: '🔲',
    description: t('analyses.chi_square.desc'),
    fields: [
      { key: 'row_variable', label: t('analyses.field.row_variable'), type: 'col', filter: c => c.type === 'categorical' || c.type === 'text' },
      { key: 'col_variable', label: t('analyses.field.col_variable'), type: 'col', filter: c => c.type === 'categorical' || c.type === 'text' },
    ],
  },
  correlation: {
    label: t('analyses.correlation.label'),
    icon: '∼',
    description: t('analyses.correlation.desc'),
    fields: [
      { key: 'method', label: t('analyses.field.method'), type: 'select', options: [
        { value: 'pearson', label: t('analyses.method.pearson') },
        { value: 'spearman', label: t('analyses.method.spearman') },
      ]},
      { key: 'variable_x', label: t('analyses.field.variable_x'), type: 'col', filter: c => c.type === 'number' },
      { key: 'variable_y', label: t('analyses.field.variable_y'), type: 'col', filter: c => c.type === 'number' },
    ],
  },
  correlation_matrix: {
    label: t('analyses.correlation_matrix.label'),
    icon: '⊞',
    description: t('analyses.correlation_matrix.desc'),
    fields: [
      { key: 'variables', label: t('analyses.field.variables_multi'), type: 'multi-col', filter: c => c.type === 'number' },
    ],
  },
  regression: {
    label: t('analyses.regression.label'),
    icon: '↗',
    description: t('analyses.regression.desc'),
    fields: [
      { key: 'variable_x', label: t('analyses.field.predictor_x'), type: 'col', filter: c => c.type === 'number' },
      { key: 'variable_y', label: t('analyses.field.dependent_y'), type: 'col', filter: c => c.type === 'number' },
    ],
  },
  cronbach_alpha: {
    label: t('analyses.cronbach_alpha.label'),
    icon: 'α',
    description: t('analyses.cronbach_alpha.desc'),
    fields: [
      { key: 'items', label: t('analyses.field.scale_items'), type: 'multi-col', filter: c => c.type === 'number' },
    ],
  },
};

async function loadAnalysesView(studyId) {
  const container = document.getElementById('analyses-content');
  if (!container) return;
  container.innerHTML = `<div class="empty-state">${t('analyses.loading_columns')}</div>`;
  AN.studyId = studyId;
  // Need column metadata to drive variable pickers — fetch from the preview endpoint
  const preview = await api('GET', `/export/${studyId}/preview?limit=1`);
  if (!preview) { container.innerHTML = `<div class="empty-state">${t('analyses.meta_load_error')}</div>`; return; }
  // Use labeled_columns so any header rename in the export builder also
  // shows up in this tab's pickers (single source of truth for column labels).
  AN.columns = preview.labeled_columns || preview.default_columns || [];
  // Saved analyses list
  AN.saved = await api('GET', `/studies/${studyId}/analyses`) || [];
  AN.currentResult = null;
  renderAnalysesView();
}

function renderAnalysesView() {
  const container = document.getElementById('analyses-content');
  if (!container) return;
  container.innerHTML = `
    <div class="an-layout">
      <aside class="an-sidebar">
        <div class="an-sidebar-section">
          <h3>${t('analyses.pick_test')}</h3>
          <div class="an-test-list">
            ${Object.entries(AN_TESTS).map(([k, t]) => `
              <button class="an-test-item ${AN.currentTest === k ? 'an-active' : ''}" onclick="anSelectTest('${k}')">
                <span class="an-test-icon">${t.icon}</span>
                <div class="an-test-meta">
                  <span class="an-test-label">${esc(t.label)}</span>
                  <span class="an-test-desc">${esc(t.description)}</span>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
        ${AN.saved.length ? `
          <div class="an-sidebar-section">
            <h3>${t('analyses.saved_heading')}</h3>
            <div class="an-saved-list">
              ${AN.saved.map(a => `
                <div class="an-saved-item">
                  <button class="an-saved-load" onclick="anLoadSaved('${esc(a.id)}')" title="${t('analyses.load_run')}">
                    <strong>${esc(a.name)}</strong>
                    <span style="color:var(--muted);font-size:0.7rem">${esc(AN_TESTS[a.test]?.label || a.test)}</span>
                  </button>
                  <button class="an-saved-del" onclick="anDeleteSaved('${esc(a.id)}', '${esc(a.name)}')" title="${t('analyses.delete')}">🗑</button>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </aside>
      <main class="an-main">
        <div class="an-editor">
          <div class="an-editor-header">
            <h3>${AN_TESTS[AN.currentTest].icon} ${esc(AN_TESTS[AN.currentTest].label)}</h3>
            <p class="an-editor-desc">${esc(AN_TESTS[AN.currentTest].description)}</p>
          </div>
          <div class="an-fields" id="an-fields"></div>
          <div class="an-actions">
            <button class="btn btn-primary" onclick="anRunAnalysis()" ${AN.running ? 'disabled' : ''}>
              ${AN.running ? t('analyses.computing') : t('analyses.run')}
            </button>
            <button class="btn btn-ghost btn-sm" onclick="anSavePrompt()">${t('analyses.save_as')}</button>
          </div>
        </div>
        <div class="an-results" id="an-results">
          ${AN.currentResult ? renderAnalysisResult(AN.currentResult) : `
            <div class="an-empty">
              <div style="font-size:2.5rem;margin-bottom:0.5rem">📊</div>
              <div>${t('analyses.empty_hint')}</div>
              <div style="font-size:0.78rem;color:var(--muted);margin-top:1.5rem;max-width:480px;line-height:1.5">
                ${t('analyses.export_note_1')}
                ${t('analyses.export_note_2')}
              </div>
            </div>
          `}
        </div>
      </main>
    </div>
  `;
  renderAnalysisFields();
}

function renderAnalysisFields() {
  const wrap = document.getElementById('an-fields');
  if (!wrap) return;
  const def = AN_TESTS[AN.currentTest];
  const visibleFields = def.fields.filter(f => !f.when || f.when(AN.currentParams));
  wrap.innerHTML = visibleFields.map(f => {
    const v = AN.currentParams[f.key];
    if (f.type === 'checkbox') {
      return `<label class="an-field-checkbox">
        <input type="checkbox" ${v ? 'checked' : ''} onchange="anSetParam('${f.key}', this.checked)">
        ${esc(f.label)}
      </label>`;
    }
    if (f.type === 'select') {
      return `<div class="an-field"><label>${esc(f.label)}</label>
        <select onchange="anSetParam('${f.key}', this.value)">
          ${f.options.map(o => `<option value="${esc(o.value)}" ${v === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select></div>`;
    }
    if (f.type === 'col') {
      const candidates = AN.columns.filter(f.filter || (() => true));
      return `<div class="an-field"><label>${esc(f.label)}</label>
        <select onchange="anSetParam('${f.key}', this.value)">
          <option value="">${t('analyses.pick_column')}</option>
          ${candidates.map(c => `<option value="${esc(c.key)}" ${v === c.key ? 'selected' : ''}>${typeBadge(c.type)} ${esc(c.header)}</option>`).join('')}
        </select></div>`;
    }
    if (f.type === 'multi-col') {
      const candidates = AN.columns.filter(f.filter || (() => true));
      const selected = new Set(v || []);
      return `<div class="an-field"><label>${esc(f.label)}</label>
        <select multiple size="8" onchange="anSetParam('${f.key}', Array.from(this.selectedOptions).map(o => o.value))" style="height:auto">
          ${candidates.map(c => `<option value="${esc(c.key)}" ${selected.has(c.key) ? 'selected' : ''}>${typeBadge(c.type)} ${esc(c.header)}</option>`).join('')}
        </select>
        <div style="font-size:0.7rem;color:var(--muted);margin-top:0.2rem">${t('analyses.selected_count', { n: selected.size })}</div></div>`;
    }
    return '';
  }).join('');
}

function typeBadge(type) {
  return ({ number: '🔢', text: '📝', categorical: '🏷', link: '🔗' }[type] || '');
}

function anSelectTest(test) {
  AN.currentTest = test;
  AN.currentParams = {};
  AN.currentResult = null;
  renderAnalysesView();
}

function anSetParam(key, value) {
  AN.currentParams[key] = value;
  // Re-render fields when toggling checkboxes/selects that affect visibility (e.g. paired)
  renderAnalysisFields();
}

async function anRunAnalysis() {
  AN.running = true;
  // Wire current export-panel choices into the analysis so it reflects what
  // the researcher would actually export (translation lang + preview inclusion).
  const lang = document.getElementById('export-lang-select')?.value || null;
  const includePreview = document.getElementById('export-include-preview')?.checked || false;
  renderAnalysesView();
  const r = await api('POST', `/studies/${AN.studyId}/analyze`, {
    test: AN.currentTest,
    params: AN.currentParams,
    options: { lang, includePreview },
  });
  AN.running = false;
  if (!r || r.error) {
    AN.currentResult = { error: r?.error || t('analyses.unknown_error') };
  } else {
    AN.currentResult = r;
  }
  renderAnalysesView();
}

function renderAnalysisResult(payload) {
  if (payload.error) return `<div class="an-result-error">⚠ ${esc(payload.error)}</div>`;
  const { test, result, n_total, columns_used = [] } = payload;
  if (result.error) return `<div class="an-result-error">⚠ ${esc(result.error)}</div>`;
  const usedHtml = columns_used.length ? `<div class="an-used-cols">${t('analyses.used_vars')} ${columns_used.map(c => `<span class="an-used-col">${typeBadge(c.type)} ${esc(c.header)}</span>`).join(' ')}</div>` : '';

  // Test-specific result rendering
  let body = '';
  if (test === 'descriptives') {
    body = `<table class="an-table">
      <tr><th>${t('analyses.n_complete')}</th><td>${result.n}</td><th>${t('analyses.missing')}</th><td>${result.missing}</td></tr>
      <tr><th>${t('analyses.mean')}</th><td>${result.mean}</td><th>${t('analyses.sd_full')}</th><td>${result.sd}</td></tr>
      <tr><th>${t('analyses.median')}</th><td>${result.median}</td><th>IQR</th><td>${result.q1} – ${result.q3}</td></tr>
      <tr><th>Min</th><td>${result.min}</td><th>Max</th><td>${result.max}</td></tr>
      <tr><th>SEM</th><td>${result.sem}</td><th></th><td></td></tr>
    </table>`;
  } else if (test === 't_test') {
    const g1 = result.group1, g2 = result.group2;
    body = `
      ${g1 ? `<table class="an-table">
        <thead><tr><th></th><th>${esc(g1.label || t('analyses.group1'))}</th><th>${esc(g2.label || t('analyses.group2'))}</th></tr></thead>
        <tbody>
          <tr><th>N</th><td>${g1.n}</td><td>${g2.n}</td></tr>
          <tr><th>${t('analyses.mean')}</th><td>${g1.mean}</td><td>${g2.mean}</td></tr>
          <tr><th>SD</th><td>${g1.sd}</td><td>${g2.sd}</td></tr>
        </tbody></table>` : `<table class="an-table">
        <tr><th>${t('analyses.n_pairs')}</th><td>${result.n_pairs}</td></tr>
        <tr><th>${t('analyses.mean_diff')}</th><td>${result.mean_diff}</td></tr>
        <tr><th>${t('analyses.sd_diff')}</th><td>${result.sd_diff}</td></tr>
      </table>`}
      <table class="an-table">
        <tr><th>t</th><td>${result.t}</td><th>df</th><td>${result.df}</td></tr>
        <tr><th>p-value</th><td><strong>${result.p}</strong></td><th>Cohen's d</th><td>${result.cohens_d} <small>(${esc(result.effect_magnitude || '')})</small></td></tr>
        ${result.ci95 ? `<tr><th>${t('analyses.ci95_diff')}</th><td colspan="3">[${result.ci95[0]}, ${result.ci95[1]}]</td></tr>` : ''}
      </table>
      ${result.assumption_equal_variance ? renderAssumption(t('analyses.levene'), result.assumption_equal_variance, x => x.equal_variances ? t('analyses.assumption_met') : t('analyses.levene_violated_ttest')) : ''}
    `;
  } else if (test === 'anova') {
    body = `<table class="an-table">
      <tr><th>F(${result.df_between}, ${result.df_within})</th><td>${result.F}</td><th>p</th><td><strong>${result.p}</strong></td></tr>
      <tr><th>η² (eta²)</th><td>${result.eta_squared}</td><th>SS between / within</th><td>${result.ss_between} / ${result.ss_within}</td></tr>
    </table>
    <h4 style="margin:1rem 0 0.5rem;font-size:0.85rem">${t('analyses.group_stats')}</h4>
    <table class="an-table">
      <thead><tr><th>${t('analyses.group')}</th><th>N</th><th>M</th><th>SD</th></tr></thead>
      <tbody>${result.group_stats.map(g => `<tr><td>${esc(g.label)}</td><td>${g.n}</td><td>${g.mean}</td><td>${g.sd}</td></tr>`).join('')}</tbody>
    </table>
    ${result.post_hoc ? `<h4 style="margin:1rem 0 0.5rem;font-size:0.85rem">Post-hoc (${esc(result.post_hoc.method)})</h4>
      <table class="an-table">
        <thead><tr><th>A vs B</th><th>${t('analyses.difference')}</th><th>q</th><th>p</th><th>95% CI</th><th></th></tr></thead>
        <tbody>${result.post_hoc.pairs.map(p => `<tr ${p.significant ? 'style="font-weight:600"' : ''}><td>${esc(p.group_a)} − ${esc(p.group_b)}</td><td>${p.mean_diff}</td><td>${p.q}</td><td>${p.p}</td><td>[${p.ci95[0]}, ${p.ci95[1]}]</td><td>${p.significant ? '✓' : ''}</td></tr>`).join('')}</tbody>
      </table>` : ''}
    ${result.assumption_equal_variance ? renderAssumption(t('analyses.levene'), result.assumption_equal_variance, x => x.equal_variances ? t('analyses.assumption_met') : t('analyses.levene_violated_anova')) : ''}
    `;
  } else if (test === 'chi_square') {
    body = `<table class="an-table">
      <tr><th>χ²(${result.df}, N=${result.n})</th><td>${result.chi2}</td><th>p</th><td><strong>${result.p}</strong></td></tr>
      <tr><th>${t('analyses.cramers_v')}</th><td>${result.cramers_v}</td><th></th><td></td></tr>
    </table>
    ${result.assumption_warning ? `<div class="an-warning">⚠ ${esc(result.assumption_warning)}</div>` : ''}
    <h4 style="margin:1rem 0 0.5rem;font-size:0.85rem">${t('analyses.observed_counts')}</h4>
    <table class="an-table">
      <thead><tr><th></th>${(result.col_categories || []).map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${(result.row_categories || []).map((rc, i) => `<tr><th>${esc(rc)}</th>${(result.observed || [])[i].map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  } else if (test === 'correlation') {
    body = `<table class="an-table">
      <tr><th>${result.method === 'spearman' ? 'r_s (Spearman)' : 'r (Pearson)'}</th><td>${result.r}</td><th>N</th><td>${result.n}</td></tr>
      <tr><th>df</th><td>${result.df}</td><th>p</th><td><strong>${result.p}</strong></td></tr>
      <tr><th>r²</th><td>${result.r_squared}</td><th>95% CI</th><td>${result.ci95 ? `[${result.ci95[0]}, ${result.ci95[1]}]` : '—'}</td></tr>
    </table>`;
  } else if (test === 'correlation_matrix') {
    const vars = result.variables;
    body = `<div style="overflow:auto"><table class="an-table an-matrix">
      <thead><tr><th></th>${vars.map(v => `<th>${esc(v)}</th>`).join('')}</tr></thead>
      <tbody>${vars.map((v, i) => `<tr><th>${esc(v)}</th>${vars.map((_, j) => {
        const r = result.r[i][j], p = result.p[i][j];
        if (i === j) return '<td class="an-diag">1</td>';
        const sig = p != null && p < 0.05;
        return `<td class="${sig ? 'an-sig' : ''}" title="p = ${p}">${r != null ? r.toFixed(2) : '—'}</td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div style="font-size:0.72rem;color:var(--muted);margin-top:0.4rem">${t('analyses.matrix_note')}</div>`;
  } else if (test === 'regression') {
    body = `<table class="an-table">
      <tr><th>Y = a + b·X</th><td colspan="3">Y = ${result.intercept} + ${result.slope} · X</td></tr>
      <tr><th>R²</th><td>${result.r_squared}</td><th>r</th><td>${result.r}</td></tr>
      <tr><th>${t('analyses.slope')}</th><td>${result.slope}</td><th>SE</th><td>${result.slope_se}</td></tr>
      <tr><th>${t('analyses.t_for_b', { df: result.df })}</th><td>${result.slope_t}</td><th>p</th><td><strong>${result.slope_p}</strong></td></tr>
      <tr><th>${t('analyses.ci95_b')}</th><td colspan="3">[${result.slope_ci95[0]}, ${result.slope_ci95[1]}]</td></tr>
    </table>`;
  } else if (test === 'cronbach_alpha') {
    body = `<table class="an-table">
      <tr><th>α</th><td><strong>${result.alpha}</strong></td><th>${t('analyses.n_items')}</th><td>${result.n_items}</td></tr>
      <tr><th>${t('analyses.n_complete_cases')}</th><td>${result.n_cases}</td><th>${t('analyses.reliability')}</th><td>${esc(result.reliability)}</td></tr>
    </table>
    ${Array.isArray(result.if_item_deleted) ? `<h4 style="margin:1rem 0 0.5rem;font-size:0.85rem">${t('analyses.alpha_if_deleted')}</h4>
      <table class="an-table">
        <thead><tr><th>${t('analyses.item')}</th><th>${t('analyses.alpha_without_item')}</th></tr></thead>
        <tbody>${result.if_item_deleted.map((it, i) => `<tr><td>${esc(result.item_names?.[i] || ('item ' + (i+1)))}</td><td>${it.alpha_if_deleted}</td></tr>`).join('')}</tbody>
      </table>` : ''}`;
  }

  return `
    <div class="an-result-card">
      <div class="an-result-header">
        <h3>${AN_TESTS[test].icon} ${esc(AN_TESTS[test].label)}</h3>
        <div class="an-result-meta">${t('analyses.n_filtered', { n: n_total })}</div>
      </div>
      ${usedHtml}
      ${result.interpretation ? `<div class="an-interpretation">${esc(result.interpretation)}</div>` : ''}
      ${body}
      <div class="an-disclaimer">
        ${t('analyses.disclaimer_short')}
      </div>
    </div>
  `;
}

function renderAssumption(label, data, verdictFn) {
  if (data.error) return '';
  return `<div class="an-assumption">
    <strong>${esc(label)}:</strong>
    F(${data.df1}, ${data.df2}) = ${data.F}, p = ${data.p} → ${verdictFn(data)}
  </div>`;
}

async function anSavePrompt() {
  const name = prompt(t('analyses.save_prompt'));
  if (!name || !name.trim()) return;
  const r = await api('POST', `/studies/${AN.studyId}/analyses`, {
    name: name.trim(), test: AN.currentTest, params: AN.currentParams,
  });
  if (r?.ok) {
    toast(t('analyses.saved_toast'));
    AN.saved = await api('GET', `/studies/${AN.studyId}/analyses`) || [];
    renderAnalysesView();
  }
}

async function anLoadSaved(id) {
  const a = AN.saved.find(x => x.id === id);
  if (!a) return;
  AN.currentTest = a.test;
  AN.currentParams = { ...(a.params || {}) };
  AN.currentResult = null;
  renderAnalysesView();
  // Auto-run on load
  anRunAnalysis();
}

async function anDeleteSaved(id, name) {
  if (!confirm(t('analyses.delete_confirm', { name }))) return;
  const r = await api('DELETE', `/studies/${AN.studyId}/analyses/${encodeURIComponent(id)}`);
  if (r?.ok) {
    toast(t('analyses.deleted_toast'));
    AN.saved = AN.saved.filter(a => a.id !== id);
    renderAnalysesView();
  }
}

// ── Widget wizard modal ────────────────────────────────────────────────────
// One modal for both add and edit. Renders a type picker (when adding), then
// a dynamic config form whose fields depend on the chosen type. Variable
// pickers are populated from dashboard.widget_columns (typed). Saving validates
// minimal required fields then writes the working widget back to DB.widgets
// and persists via the same /config endpoint used by move/delete.

const WIDGET_TYPES = {
  kpi: { label: 'KPI', icon: '🔢', desc: t('analyses.widget_type.kpi.desc') },
  bar_chart: { label: t('analyses.widget_type.bar_chart.label'), icon: '📊', desc: t('analyses.widget_type.bar_chart.desc') },
  histogram: { label: 'Histogram', icon: '📉', desc: t('analyses.widget_type.histogram.desc') },
  crosstab: { label: t('analyses.widget_type.crosstab.label'), icon: '🔲', desc: t('analyses.widget_type.crosstab.desc') },
  time_series: { label: t('analyses.widget_type.time_series.label'), icon: '📈', desc: t('analyses.widget_type.time_series.desc') },
  scatter: { label: 'Scatter plot', icon: '⚬', desc: t('analyses.widget_type.scatter.desc') },
  boxplot: { label: 'Boxplot', icon: '📦', desc: t('analyses.widget_type.boxplot.desc') },
  pie: { label: 'Pie / donut', icon: '🥧', desc: t('analyses.widget_type.pie.desc') },
  correlation_heatmap: { label: t('analyses.widget_type.correlation_heatmap.label'), icon: '🟦', desc: t('analyses.widget_type.correlation_heatmap.desc') },
  text_responses: { label: t('analyses.widget_type.text_responses.label'), icon: '💬', desc: t('analyses.widget_type.text_responses.desc') },
};

function openWidgetWizard(editingId) {
  const existing = editingId ? DB.widgets.find(w => w.id === editingId) : null;
  const working = existing ? JSON.parse(JSON.stringify(existing)) : { id: null, type: 'kpi', title: '' };

  showModal(`
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
      <h2 style="margin:0;font-size:1.1rem">${editingId ? t('dashboard.wiz_edit_title') : t('dashboard.wiz_add_title')}</h2>
    </div>
    <div id="widget-wizard-body"></div>
    <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border)">
      <button class="btn btn-ghost" onclick="closeModal()">${t('dashboard.wiz_cancel')}</button>
      <button class="btn btn-primary" id="widget-wizard-save">${editingId ? t('dashboard.wiz_save_changes') : t('dashboard.wiz_add_title')}</button>
    </div>
  `);
  window._wiz = working;
  renderWidgetWizardBody();
  document.getElementById('widget-wizard-save').onclick = () => saveWidgetWizard(editingId);
}

function renderWidgetWizardBody() {
  const w = window._wiz;
  const cols = DB.data?.widget_columns || [];
  const wrap = document.getElementById('widget-wizard-body');
  if (!wrap) return;

  const typePicker = `
    <div class="form-group">
      <label>${t('dashboard.wiz_type_label')}</label>
      <select id="wiz-type" onchange="wizSetType(this.value)">
        ${Object.entries(WIDGET_TYPES).map(([k, t]) => `<option value="${k}" ${w.type === k ? 'selected' : ''}>${t.icon} ${t.label} — ${t.desc}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>${t('dashboard.wiz_title_label')}</label>
      <input type="text" id="wiz-title" value="${esc(w.title || '')}" placeholder="${t('dashboard.wiz_title_ph')}">
    </div>
  `;

  const numericCols    = cols.filter(c => c.type === 'number');
  const categoricalCols = cols.filter(c => c.type === 'categorical' || c.type === 'text');
  const allCols        = cols;
  const colOpt = (list, key, currentVal) => `
    <select id="wiz-${key}">
      <option value="">${t('dashboard.wiz_choose')}</option>
      ${list.map(c => `<option value="${esc(c.key)}" ${currentVal === c.key ? 'selected' : ''}>${c.type === 'number' ? '🔢' : c.type === 'categorical' ? '🏷' : '📝'} ${esc(c.header)}</option>`).join('')}
    </select>`;

  let typeFields = '';
  if (w.type === 'kpi') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_metric')}</label>
        <select id="wiz-metric">
          <option value="count_completed" ${w.metric==='count_completed'?'selected':''}>${t('dashboard.wiz_metric_count_completed')}</option>
          <option value="count_total"     ${w.metric==='count_total'?'selected':''}>${t('dashboard.wiz_metric_count_total')}</option>
          <option value="count_preview"   ${w.metric==='count_preview'?'selected':''}>${t('dashboard.wiz_metric_count_preview')}</option>
          <option value="dropout_pct"     ${w.metric==='dropout_pct'?'selected':''}>${t('dashboard.wiz_metric_dropout')}</option>
          <option value="mean"            ${w.metric==='mean'?'selected':''}>${t('dashboard.wiz_metric_mean_col')}</option>
          <option value="median"          ${w.metric==='median'?'selected':''}>${t('dashboard.wiz_metric_median_col')}</option>
          <option value="sum"             ${w.metric==='sum'?'selected':''}>${t('dashboard.wiz_metric_sum_col')}</option>
          <option value="pct_missing"     ${w.metric==='pct_missing'?'selected':''}>${t('dashboard.wiz_metric_pct_missing')}</option>
          <option value="pct_value"       ${w.metric==='pct_value'?'selected':''}>${t('dashboard.wiz_metric_pct_value')}</option>
        </select>
      </div>
      <div class="form-group" id="wiz-column-wrap"><label>${t('dashboard.wiz_column_label')}</label>${colOpt(allCols, 'column', w.column)}</div>
      <div class="form-group" id="wiz-value-wrap" style="display:${w.metric === 'pct_value' ? '' : 'none'}"><label>${t('dashboard.wiz_value_label')}</label>
        <input type="text" id="wiz-value" value="${esc(w.value ?? '')}" placeholder="${t('dashboard.wiz_value_ph')}">
      </div>
    `;
  } else if (w.type === 'bar_chart') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_group_var')}</label>${colOpt(categoricalCols, 'group_var', w.group_var)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_aggregator')}</label>
        <select id="wiz-aggregator">
          <option value="count"  ${w.aggregator==='count'?'selected':''}>${t('dashboard.wiz_agg_count')}</option>
          <option value="mean"   ${w.aggregator==='mean'?'selected':''}>${t('dashboard.wiz_agg_mean')}</option>
          <option value="median" ${w.aggregator==='median'?'selected':''}>${t('dashboard.wiz_agg_median')}</option>
          <option value="sum"    ${w.aggregator==='sum'?'selected':''}>${t('dashboard.wiz_agg_sum')}</option>
        </select>
      </div>
      <div class="form-group"><label>${t('dashboard.wiz_value_var')}</label>${colOpt(numericCols, 'value_var', w.value_var)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_with_stats')}</label>
        <select id="wiz-with_stats">
          <option value="" ${!w.with_stats?'selected':''}>${t('dashboard.wiz_none')}</option>
          <option value="anova"  ${w.with_stats==='anova'?'selected':''}>${t('dashboard.wiz_stats_anova')}</option>
          <option value="t_test" ${w.with_stats==='t_test'?'selected':''}>${t('dashboard.wiz_stats_ttest')}</option>
        </select>
      </div>`;
  } else if (w.type === 'histogram') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_continuous_var')}</label>${colOpt(numericCols, 'variable', w.variable)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_bins')}</label>
        <input type="number" id="wiz-bins" value="${esc(w.bins ?? '')}" min="3" max="30" placeholder="auto">
      </div>`;
  } else if (w.type === 'crosstab') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_row_var')}</label>${colOpt(categoricalCols, 'row_var', w.row_var)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_col_var')}</label>${colOpt(categoricalCols, 'col_var', w.col_var)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_show_pct')}</label>
        <select id="wiz-show_pct">
          <option value=""      ${!w.show_pct?'selected':''}>${t('dashboard.wiz_none')}</option>
          <option value="row"   ${w.show_pct==='row'?'selected':''}>${t('dashboard.wiz_pct_row')}</option>
          <option value="col"   ${w.show_pct==='col'?'selected':''}>${t('dashboard.wiz_pct_col')}</option>
          <option value="total" ${w.show_pct==='total'?'selected':''}>${t('dashboard.wiz_pct_total')}</option>
        </select>
      </div>
      <div class="form-group"><label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
        <input type="checkbox" id="wiz-with_chi2" ${w.with_chi2?'checked':''}> ${t('dashboard.wiz_show_chi2')}
      </label></div>`;
  } else if (w.type === 'time_series') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_granularity')}</label>
        <select id="wiz-granularity">
          <option value="day"   ${w.granularity!=='week'&&w.granularity!=='month'?'selected':''}>${t('dashboard.wiz_gran_day')}</option>
          <option value="week"  ${w.granularity==='week'?'selected':''}>${t('dashboard.wiz_gran_week')}</option>
          <option value="month" ${w.granularity==='month'?'selected':''}>${t('dashboard.wiz_gran_month')}</option>
        </select>
      </div>
      <div class="form-group"><label>${t('dashboard.wiz_metric')}</label>
        <select id="wiz-metric_ts">
          <option value="completed" ${w.metric!=='started'?'selected':''}>${t('dashboard.wiz_ts_completed')}</option>
          <option value="started"   ${w.metric==='started'?'selected':''}>${t('dashboard.wiz_ts_started')}</option>
        </select>
      </div>
      <div class="form-group"><label>${t('dashboard.wiz_days_back')}</label>
        <input type="number" id="wiz-days_back" value="${esc(w.days_back ?? 30)}" min="3" max="365">
      </div>`;
  } else if (w.type === 'scatter') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_var_x')}</label>${colOpt(numericCols, 'variable_x', w.variable_x)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_var_y')}</label>${colOpt(numericCols, 'variable_y', w.variable_y)}</div>
      <div class="form-group"><label>Pogrupuj kolorami wg (opcjonalnie)</label>${colOpt(categoricalCols, 'color_by', w.color_by)}</div>`;
  } else if (w.type === 'boxplot') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_continuous_var')}</label>${colOpt(numericCols, 'variable', w.variable)}</div>
      <div class="form-group"><label>Pogrupuj wg (opcjonalnie)</label>${colOpt(categoricalCols, 'group_by', w.group_by)}</div>`;
  } else if (w.type === 'pie') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_categorical_var')}</label>${colOpt(categoricalCols, 'variable', w.variable)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_top_n')}</label>
        <input type="number" id="wiz-top_n" value="${esc(w.top_n ?? '')}" min="2" max="20" placeholder="${t('dashboard.wiz_top_n_ph')}">
      </div>`;
  } else if (w.type === 'correlation_heatmap') {
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_variables')}</label>
        <select multiple size="8" id="wiz-variables" style="height:auto">
          ${numericCols.map(c => `<option value="${esc(c.key)}" ${(w.variables || []).includes(c.key) ? 'selected' : ''}>🔢 ${esc(c.header)}</option>`).join('')}
        </select>
        <div style="font-size:0.7rem;color:var(--muted);margin-top:0.2rem">${t('dashboard.wiz_selected', { n: (w.variables || []).length })}</div>
      </div>
      <div class="form-group"><label>${t('dashboard.wiz_method')}</label>
        <select id="wiz-method">
          <option value="pearson"  ${w.method!=='spearman'?'selected':''}>${t('dashboard.wiz_method_pearson')}</option>
          <option value="spearman" ${w.method==='spearman'?'selected':''}>${t('dashboard.wiz_method_spearman')}</option>
        </select>
      </div>`;
  } else if (w.type === 'text_responses') {
    // For open-text questions: any text/categorical column will do
    const textCols = allCols.filter(c => c.type === 'text' || c.type === 'categorical');
    typeFields = `
      <div class="form-group"><label>${t('dashboard.wiz_text_var')}</label>${colOpt(textCols, 'variable', w.variable)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_group_by')}</label>${colOpt(categoricalCols, 'group_by', w.group_by)}</div>
      <div class="form-group"><label>${t('dashboard.wiz_limit')}</label>
        <input type="number" id="wiz-limit" value="${esc(w.limit ?? 100)}" min="10" max="500">
      </div>`;
  }

  wrap.innerHTML = typePicker + typeFields;
  // Live "value field visible only for pct_value" toggle in KPI
  if (w.type === 'kpi') {
    document.getElementById('wiz-metric')?.addEventListener('change', e => {
      document.getElementById('wiz-value-wrap').style.display = e.target.value === 'pct_value' ? '' : 'none';
    });
  }
}

function wizSetType(type) {
  window._wiz = { id: window._wiz.id, type, title: window._wiz.title };
  renderWidgetWizardBody();
}

async function saveWidgetWizard(editingId) {
  const w = { id: window._wiz.id, type: document.getElementById('wiz-type').value };
  w.title = document.getElementById('wiz-title')?.value?.trim() || WIDGET_TYPES[w.type].label;
  if (w.type === 'kpi') {
    w.metric = document.getElementById('wiz-metric').value;
    const col = document.getElementById('wiz-column')?.value; if (col) w.column = col;
    const val = document.getElementById('wiz-value')?.value; if (val !== '' && val != null) w.value = val;
  } else if (w.type === 'bar_chart') {
    w.group_var = document.getElementById('wiz-group_var').value;
    w.aggregator = document.getElementById('wiz-aggregator').value;
    const v = document.getElementById('wiz-value_var').value; if (v) w.value_var = v;
    const s = document.getElementById('wiz-with_stats').value; if (s) w.with_stats = s;
    if (!w.group_var) return toast(t('dashboard.wiz_err_group_var'), 'error');
  } else if (w.type === 'histogram') {
    w.variable = document.getElementById('wiz-variable').value;
    const b = document.getElementById('wiz-bins').value; if (b) w.bins = parseInt(b, 10);
    if (!w.variable) return toast(t('dashboard.wiz_err_var'), 'error');
  } else if (w.type === 'crosstab') {
    w.row_var = document.getElementById('wiz-row_var').value;
    w.col_var = document.getElementById('wiz-col_var').value;
    const p = document.getElementById('wiz-show_pct').value; if (p) w.show_pct = p;
    w.with_chi2 = document.getElementById('wiz-with_chi2').checked;
    if (!w.row_var || !w.col_var) return toast(t('dashboard.wiz_err_both_vars'), 'error');
  } else if (w.type === 'time_series') {
    w.granularity = document.getElementById('wiz-granularity').value;
    w.metric = document.getElementById('wiz-metric_ts').value;
    w.days_back = parseInt(document.getElementById('wiz-days_back').value, 10) || 30;
  } else if (w.type === 'scatter') {
    w.variable_x = document.getElementById('wiz-variable_x').value;
    w.variable_y = document.getElementById('wiz-variable_y').value;
    const cb = document.getElementById('wiz-color_by').value; if (cb) w.color_by = cb;
    if (!w.variable_x || !w.variable_y) return toast(t('dashboard.wiz_err_both_cont'), 'error');
  } else if (w.type === 'boxplot') {
    w.variable = document.getElementById('wiz-variable').value;
    const gb = document.getElementById('wiz-group_by').value; if (gb) w.group_by = gb;
    if (!w.variable) return toast(t('dashboard.wiz_err_cont_var'), 'error');
  } else if (w.type === 'pie') {
    w.variable = document.getElementById('wiz-variable').value;
    const tn = document.getElementById('wiz-top_n').value; if (tn) w.top_n = parseInt(tn, 10);
    if (!w.variable) return toast(t('dashboard.wiz_err_cat_var'), 'error');
  } else if (w.type === 'correlation_heatmap') {
    w.variables = Array.from(document.getElementById('wiz-variables').selectedOptions).map(o => o.value);
    w.method = document.getElementById('wiz-method').value;
    if (w.variables.length < 2) return toast(t('dashboard.wiz_err_min2'), 'error');
  } else if (w.type === 'text_responses') {
    w.variable = document.getElementById('wiz-variable').value;
    const gb = document.getElementById('wiz-group_by').value; if (gb) w.group_by = gb;
    const lim = document.getElementById('wiz-limit').value; if (lim) w.limit = parseInt(lim, 10);
    if (!w.variable) return toast(t('dashboard.wiz_err_text_var'), 'error');
  }

  if (editingId) {
    const idx = DB.widgets.findIndex(x => x.id === editingId);
    if (idx >= 0) DB.widgets[idx] = { ...DB.widgets[idx], ...w, id: editingId };
  } else {
    w.id = Math.random().toString(36).slice(2, 10);
    DB.widgets.push(w);
  }
  await dashSaveConfig(true);
  closeModal();
  toast(t('dashboard.wiz_saved'));
  // Re-fetch dashboard so widget data is freshly computed for the new config
  loadDashboard(DB.studyId);
}
