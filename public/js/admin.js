'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  token: localStorage.getItem('admin_token'),
  studies: [],
  selectedDashboardStudy: null,
  selectedPostsStudy: null,
  selectedExportStudy: null,
};

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
  if (r.headers.get('content-type')?.includes('json')) return r.json();
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
    // Auto-load tab content when switching if a study is already selected
    const id = S.activeStudy;
    if (!id) return;
    const tab = btn.dataset.tab;
    if (tab === 'dashboard') loadDashboard(id);
    else if (tab === 'posts') { document.getElementById('posts-toolbar').style.display = ''; loadPosts(id); }
    else if (tab === 'export') loadExportView(id);
  });
});

function switchTab(name) {
  document.querySelector(`.tab-btn[data-tab="${name}"]`)?.click();
}

// ── Global study picker ────────────────────────────────────────────────────
function setActiveStudy(id) {
  S.activeStudy = id ? String(id) : '';
  S.selectedDashboardStudy = S.activeStudy;
  S.selectedPostsStudy     = S.activeStudy;
  S.selectedExportStudy    = S.activeStudy;
  if (S.activeStudy) localStorage.setItem('lastSelectedStudy', S.activeStudy);

  const study = S.studies.find(s => String(s.id) === S.activeStudy);
  const label = document.getElementById('study-picker-label');
  label.textContent = study ? study.name : '— wybierz badanie —';
  document.querySelectorAll('#study-picker-list li').forEach(li => {
    li.classList.toggle('selected', li.dataset.id === S.activeStudy);
  });

  // Load content for currently active tab
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (!S.activeStudy) return;
  if (activeTab === 'dashboard') loadDashboard(S.activeStudy);
  else if (activeTab === 'posts') { document.getElementById('posts-toolbar').style.display = ''; loadPosts(S.activeStudy); }
  else if (activeTab === 'export') loadExportView(S.activeStudy);
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

// ── Auth ───────────────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = document.getElementById('admin-password').value;
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
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

document.getElementById('logout-btn').onclick = doLogout;
function doLogout() {
  localStorage.removeItem('admin_token');
  S.token = null;
  location.reload();
}

function showAdminPanel() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-panel').style.display = 'block';
  loadAll();
}

// ── Init ───────────────────────────────────────────────────────────────────
async function loadAll() {
  await loadStudies();
  populateStudySelects();
}

if (S.token) showAdminPanel();

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
    li.textContent = `${s.name}${s.is_active ? '' : ' (nieaktywne)'}`;
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

  // Restore last selected study, or fall back to first in list
  const saved = S.activeStudy || localStorage.getItem('lastSelectedStudy') || '';
  const validSaved = saved && S.studies.some(s => String(s.id) === saved);
  const toSelect = validSaved ? saved : (S.studies[0]?.id ?? '');
  if (toSelect) setActiveStudy(toSelect);
}

function renderStudiesList() {
  const container = document.getElementById('studies-list');
  if (!S.studies.length) {
    container.innerHTML = '<div class="empty-state">Brak badań. Utwórz pierwsze badanie.</div>';
    return;
  }
  container.innerHTML = S.studies.map(s => `
    <div class="study-row" data-study-id="${s.id}">
      <div class="study-row-info">
        <div class="study-name">${esc(s.name)}</div>
        <div class="study-meta">
          <span class="study-slug">/study/${esc(s.slug)}</span>
          · Ukończono: <strong>${s.completed_count || 0}</strong>
          · ${s.created_at ? s.created_at.slice(0,10) : ''}
        </div>
      </div>
      <div class="study-actions">
        <span class="badge ${s.is_active ? 'badge-active' : 'badge-inactive'}">${s.is_active ? 'Aktywne' : 'Nieaktywne'}</span>
        <button class="btn btn-ghost btn-sm" onclick="toggleStudyActive(${s.id}, ${s.is_active})">${s.is_active ? 'Dezaktywuj' : 'Aktywuj'}</button>
        <button class="btn btn-ghost btn-sm" onclick="openStudySettings(${s.id})">Ustawienia</button>
        <button class="btn btn-ghost btn-sm" onclick="goToPostEditor(${s.id})">Edytor postów</button>
        <button class="btn btn-ghost btn-sm" onclick="duplicateStudy(${s.id})">Duplikuj</button>
        <button class="btn btn-danger btn-sm" onclick="deleteStudy(${s.id}, '${esc(s.name)}')">Usuń</button>
      </div>
    </div>
  `).join('');
}

async function toggleStudyActive(id, current) {
  await api('PATCH', `/studies/${id}`, { is_active: current ? 0 : 1 });
  toast('Zaktualizowano status badania.');
  await loadStudies();
  populateStudySelects();
}

// Create study
document.getElementById('btn-create-study').onclick = () => {
  showModal(`
    <h2>Nowe badanie</h2>
    <div class="form-group"><label>Nazwa badania</label><input type="text" id="new-name" placeholder="np. Badanie dezinformacji 2025"></div>
    <div class="form-group"><label>Slug (URL)</label><input type="text" id="new-slug" placeholder="auto-generowany"></div>
    <div class="form-group"><label>Opis</label><textarea id="new-desc" rows="2"></textarea></div>
    <div class="form-group"><label>Instytucja</label><input type="text" id="new-inst"></div>
    <div class="form-group"><label>E-mail kontaktowy</label><input type="email" id="new-email"></div>
    <div class="modal-footer">
      <button class="btn btn-primary" onclick="createStudy()">Utwórz badanie</button>
      <button class="btn btn-ghost" onclick="closeModal()">Anuluj</button>
    </div>
  `);
  document.getElementById('new-name').addEventListener('input', e => {
    const slug = document.getElementById('new-slug');
    if (!slug._touched) slug.value = slugify(e.target.value);
  });
  document.getElementById('new-slug').addEventListener('input', e => { e.target._touched = true; });
};

async function createStudy() {
  const body = {
    name: document.getElementById('new-name').value.trim(),
    slug: document.getElementById('new-slug').value.trim(),
    description: document.getElementById('new-desc').value.trim(),
    institution: document.getElementById('new-inst').value.trim(),
    contact_email: document.getElementById('new-email').value.trim(),
  };
  if (!body.name) return toast('Nazwa jest wymagana.', 'error');
  const data = await api('POST', '/studies', body);
  if (!data) return;
  closeModal();
  toast('Badanie utworzone!');
  await loadStudies();
  populateStudySelects();
  openStudySettings(data.id);
}

async function duplicateStudy(id) {
  if (!confirm('Zduplikować badanie? Zostaną skopiowane ustawienia i posty (bez danych sesji).')) return;
  const data = await api('POST', `/studies/${id}/duplicate`);
  if (!data) return;
  toast(`Badanie zduplikowane: "${data.name}"`);
  await loadStudies();
  populateStudySelects();
}

async function deleteStudy(id, name) {
  const confirmed = confirm(`UWAGA: Usunięcie badania "${name}" spowoduje trwałe usunięcie WSZYSTKICH danych (sesje, reakcje, oceny). Wpisz "USUŃ" aby potwierdzić.`);
  if (!confirmed) return;
  const input = prompt('Wpisz DELETE (wielkimi literami) aby potwierdzić usunięcie:');
  if (input !== 'DELETE') return toast('Anulowano usunięcie.', 'error');
  await api('DELETE', `/studies/${id}`, { confirm: 'DELETE' });
  toast('Badanie usunięte.');
  await loadStudies();
  populateStudySelects();
}

// ── Metric condition row helpers ───────────────────────────────────────────
function metricConditionRowHTML(cond) {
  return `
    <div class="metric-condition-row" data-key="${esc(String(cond.key))}">
      <label class="toggle"><input type="checkbox" class="mc-enabled" ${cond.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
      <input type="text" class="mc-label" value="${esc(cond.label)}" placeholder="Nazwa warunku" style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0">
        <span style="font-size:0.75rem;color:var(--muted)">min</span>
        <input type="number" class="mc-min" value="${cond.min ?? 0}" placeholder="0" style="width:5rem">
        <span style="font-size:0.75rem;color:var(--muted)">max</span>
        <input type="number" class="mc-max" value="${cond.max ?? 0}" placeholder="0" style="width:5rem">
        <span style="font-size:0.72rem;color:var(--muted)">(0 = użyj bazy)</span>
      </div>
      <label style="display:flex;align-items:center;gap:0.3rem;flex-shrink:0;cursor:pointer" title="Pokaż komentarz debunkujący uczestnikom w tym warunku">
        <input type="checkbox" class="mc-show-comment" ${cond.show_comment ? 'checked' : ''} style="accent-color:var(--accent);width:14px;height:14px">
        <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap">💬 komentarz</span>
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
    <input type="text" class="mc-label" value="Nowy warunek" placeholder="Nazwa warunku" style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;gap:0.4rem;flex-shrink:0">
      <span style="font-size:0.75rem;color:var(--muted)">min</span>
      <input type="number" class="mc-min" value="0" placeholder="0" style="width:5rem">
      <span style="font-size:0.75rem;color:var(--muted)">max</span>
      <input type="number" class="mc-max" value="0" placeholder="0" style="width:5rem">
      <span style="font-size:0.72rem;color:var(--muted)">(0 = użyj bazy)</span>
    </div>
    <label style="display:flex;align-items:center;gap:0.3rem;flex-shrink:0;cursor:pointer" title="Pokaż komentarz debunkujący uczestnikom w tym warunku">
      <input type="checkbox" class="mc-show-comment" style="accent-color:var(--accent);width:14px;height:14px">
      <span style="font-size:0.8rem;color:var(--muted);white-space:nowrap">💬 komentarz</span>
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
    { key: 'A', label: study?.label_style_a || 'Styl A' },
    { key: 'B', label: study?.label_style_b || 'Styl B' },
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
async function openStudySettings(id) {
  const s = S.studies.find(x => x.id == id);
  if (!s) return;

  // Parse metric conditions (fallback to legacy HIGH/LOW columns)
  let mcArr;
  try { mcArr = s.metric_conditions_json ? JSON.parse(s.metric_conditions_json) : null; } catch {}
  if (!mcArr) {
    mcArr = [
      { key: 'HIGH', label: 'Z komentarzem',    min: s.high_metrics_min || 100, max: s.high_metrics_max || 500, enabled: s.enable_metrics_high ? true : false, show_comment: true },
      { key: 'LOW',  label: 'Bez komentarza',   min: s.low_metrics_min  || 100, max: s.low_metrics_max  || 500, enabled: s.enable_metrics_low  ? true : false, show_comment: false },
    ];
  }
  const mcHTML = mcArr.map(c => metricConditionRowHTML(c)).join('');

  showModal(`
    <h2>Ustawienia badania</h2>
    <div class="modal-section-title">Informacje podstawowe</div>
    <div class="form-group"><label>Nazwa</label><input type="text" id="es-name" value="${esc(s.name)}"></div>
    <div class="form-group"><label>Slug</label><input type="text" id="es-slug" value="${esc(s.slug)}"></div>
    <div class="form-group"><label>Opis</label><textarea id="es-desc" rows="2">${esc(s.description || '')}</textarea></div>
    <div class="form-group"><label>Instytucja</label><input type="text" id="es-inst" value="${esc(s.institution || '')}"></div>
    <div class="form-group"><label>E-mail kontaktowy</label><input type="email" id="es-email" value="${esc(s.contact_email || '')}"></div>

    <div class="modal-section-title">Typ układu</div>
    <div class="form-group">
      <label>Układ ekranu uczestnika</label>
      <select id="es-layout">
        <option value="feed" ${(s.layout_type || 'feed') === 'feed' ? 'selected' : ''}>Feed — przewijany (klasyczny)</option>
        <option value="custom" ${(s.layout_type === 'custom' || s.layout_type === 'paged') ? 'selected' : ''}>Pager — post per strona</option>
      </select>
    </div>

    <!-- Paged-only options -->
    <div id="es-paged-options" style="${s.layout_type === 'paged' ? '' : 'display:none'}">
      <div class="toggle-row" style="margin-bottom:1rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-reactions" ${s.show_reactions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">Pokaż przyciski reakcji (like / dislike / share / flag)</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-comments" ${s.enable_comments ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">Włącz pole komentarza pod postem</span>
        </div>
      </div>
    </div>

    <!-- Custom Builder options -->
    <div id="es-custom-options" style="${s.layout_type === 'custom' ? '' : 'display:none'}">
      <div class="toggle-row" style="margin-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-custom-reactions" ${s.show_reactions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">👇 Przyciski reakcji (like / dislike / share / flag)</span>
        </div>
      </div>
      <div id="es-custom-reaction-labels" style="margin-bottom:0.75rem;${s.show_reactions !== 0 ? '' : 'display:none'}">
        <div class="form-grid form-grid-4">
          <div class="form-group"><label>Lubię to</label><input type="text" id="es-lbl-like" value="${esc(s.label_action_like || 'Lubię to')}"></div>
          <div class="form-group"><label>Nie lubię</label><input type="text" id="es-lbl-dislike" value="${esc(s.label_action_dislike || 'Nie lubię')}"></div>
          <div class="form-group"><label>Udostępnij</label><input type="text" id="es-lbl-share" value="${esc(s.label_action_share || 'Udostępnij')}"></div>
          <div class="form-group"><label>Zgłoś</label><input type="text" id="es-lbl-flag" value="${esc(s.label_action_flag || 'Zgłoś')}"></div>
        </div>
      </div>

      <div class="modal-section-title" style="margin-top:0.25rem;margin-bottom:0.5rem">⭐ Skala wiarygodności</div>
      <div class="form-group"><label>Treść pytania</label><input type="text" id="es-lbl-likert-q" value="${esc(s.label_likert_question || 'Jak oceniasz wiarygodność tego postu?')}"></div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:0.75rem">
        <div class="form-group"><label>Etykieta lewa (min)</label><input type="text" id="es-lbl-likert-min" value="${esc(s.label_likert_min || 'Zupełnie niewiarygodna')}"></div>
        <div class="form-group"><label>Etykieta prawa (max)</label><input type="text" id="es-lbl-likert-max" value="${esc(s.label_likert_max || 'W pełni wiarygodna')}"></div>
      </div>

      <div class="toggle-row" style="margin-top:0.25rem;margin-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="es-custom-comments" ${s.enable_comments ? 'checked' : ''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">💬 Pole komentarza uczestnika</span>
        </div>
      </div>
      <div id="es-custom-comment-wrap" style="${s.enable_comments ? '' : 'display:none'}">
        <div class="form-group"><label>Placeholder pola komentarza</label><input type="text" id="es-lbl-comment-ph" value="${esc(s.comment_placeholder || 'Napisz komentarz do tego postu...')}"></div>
      </div>
    </div>

    <div class="modal-section-title">Ustawienia eksperymentalne</div>
    <div class="form-group"><label>Liczba postów na sesję (1–20)</label><input type="number" id="es-pps" min="1" max="20" value="${s.posts_per_session}"></div>

    <div class="modal-section-title" style="margin-top:1.25rem">Warunki stylu</div>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">Każdy uczestnik losowo trafia do jednego z aktywnych warunków — odpowiada treściom A lub B w postach.</p>
    <div style="display:flex;flex-direction:column;gap:0.6rem;margin-bottom:1.25rem">
      <div class="condition-row">
        <label class="toggle"><input type="checkbox" id="es-ca" ${s.enable_condition_a ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <input type="text" id="es-label-a" class="condition-label-input" value="${esc(s.label_style_a || 'Styl A (manipulacyjny)')}" placeholder="Nazwa warunku A">
        <span class="condition-hint">treść A</span>
      </div>
      <div class="condition-row">
        <label class="toggle"><input type="checkbox" id="es-cb" ${s.enable_condition_b ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <input type="text" id="es-label-b" class="condition-label-input" value="${esc(s.label_style_b || 'Styl B (neutralny)')}" placeholder="Nazwa warunku B">
        <span class="condition-hint">treść B</span>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">
      <div class="modal-section-title" style="margin:0">Warunki eksperymentalne</div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="addMetricCondition()" style="margin-left:auto">+ Dodaj warunek</button>
    </div>
    <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.75rem">Każdy uczestnik losowo trafia do jednego z aktywnych warunków. Użyj przełącznika 💬, aby pokazać komentarz debunkujący tylko w wybranych warunkach.</p>
    <div id="es-metric-conditions" style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:0.75rem">
      ${mcHTML}
    </div>

    <div class="toggle-row" style="margin-bottom:1rem">
      <div class="toggle-wrap" style="flex:1">
        <label class="toggle"><input type="checkbox" id="es-show-metrics" ${s.show_metrics !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">Pokaż interakcje społecznościowe (liczba polubień, udostępnień itp.)</span>
      </div>
      <div class="toggle-wrap">
        <label class="toggle"><input type="checkbox" id="es-htb" ${s.hide_topic_badges ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">Ukryj kategorie (topic badges)</span>
      </div>
    </div>

    <div class="modal-section-title">Ekran 1 — Zgoda uczestnika</div>
    <div class="form-group"><label>Treść zgody (puste = domyślna)</label><textarea id="es-consent" rows="5">${esc(s.consent_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>Ekran 2 — Instrukcja</span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-instr" ${s.show_instructions !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">Pokaż ekran</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-instr-wrap"><label>Treść instrukcji (puste = domyślna)</label><textarea id="es-instr" rows="5">${esc(s.instruction_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>Ekran 4 — Przejście do feeda / oceny</span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-tf" ${s.show_transition_feed !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">Pokaż ekran</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-tf-wrap"><label>Tekst przejścia (puste = domyślny)</label><textarea id="es-tf" rows="4">${esc(s.transition_feed_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>Ekran 6 — Przejście do oceny <span style="font-size:0.75rem;color:var(--muted)">(tylko tryb Feed)</span></span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-tr" ${s.show_transition_rating !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">Pokaż ekran</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-tr-wrap"><label>Tekst przejścia (puste = domyślny)</label><textarea id="es-tr" rows="4">${esc(s.transition_rating_text || '')}</textarea></div>

    <div class="modal-section-title screen-toggle-title">
      <span>Ekran 8 — Debriefing</span>
      <label class="toggle-wrap" style="margin-left:auto;gap:0.5rem">
        <label class="toggle"><input type="checkbox" id="es-show-debrief" ${s.show_debrief !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <span class="toggle-label">Pokaż ekran</span>
      </label>
    </div>
    <div class="form-group screen-section" id="es-debrief-wrap"><label>Tekst debriefingu (puste = domyślny)</label><textarea id="es-debrief" rows="5">${esc(s.debrief_text || '')}</textarea></div>

    <div class="modal-footer">
      <button class="btn btn-primary" onclick="saveStudySettings(${id})">Zapisz</button>
      <button class="btn btn-ghost" onclick="closeModal()">Anuluj</button>
    </div>
  `);
  document.getElementById('es-layout').addEventListener('change', e => {
    document.getElementById('es-paged-options').style.display = e.target.value === 'paged' ? '' : 'none';
    document.getElementById('es-custom-options').style.display = e.target.value === 'custom' ? '' : 'none';
  });

  updateMetricRemoveButtons();

  // Custom builder sub-toggles
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

  // Screen toggle visibility
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
    label: row.querySelector('.mc-label').value.trim() || 'Warunek',
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
    slug: document.getElementById('es-slug').value.trim(),
    description: document.getElementById('es-desc').value.trim(),
    institution: document.getElementById('es-inst').value.trim(),
    contact_email: document.getElementById('es-email').value.trim(),
    posts_per_session: Number(document.getElementById('es-pps').value),
    enable_condition_a: document.getElementById('es-ca').checked ? 1 : 0,
    enable_condition_b: document.getElementById('es-cb').checked ? 1 : 0,
    label_style_a: document.getElementById('es-label-a').value.trim() || 'Styl A',
    label_style_b: document.getElementById('es-label-b').value.trim() || 'Styl B',
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
  };

  // Custom builder — collect editable label fields
  if (isCustom) {
    body.label_action_like      = document.getElementById('es-lbl-like').value.trim()       || 'Lubię to';
    body.label_action_dislike   = document.getElementById('es-lbl-dislike').value.trim()    || 'Nie lubię';
    body.label_action_share     = document.getElementById('es-lbl-share').value.trim()      || 'Udostępnij';
    body.label_action_flag      = document.getElementById('es-lbl-flag').value.trim()       || 'Zgłoś';
    body.label_likert_question  = document.getElementById('es-lbl-likert-q').value.trim()   || 'Jak oceniasz wiarygodność tego postu?';
    body.label_likert_min       = document.getElementById('es-lbl-likert-min').value.trim() || 'Zupełnie niewiarygodna';
    body.label_likert_max       = document.getElementById('es-lbl-likert-max').value.trim() || 'W pełni wiarygodna';
    body.comment_placeholder    = document.getElementById('es-lbl-comment-ph')?.value.trim() || 'Napisz komentarz do tego postu...';
  }

  await api('PATCH', `/studies/${id}`, body);
  closeModal();
  toast('Ustawienia zapisane.');
  await loadStudies();
  populateStudySelects();
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function loadDashboard(studyId) {
  document.getElementById('dashboard-content').innerHTML = '<div class="empty-state">Ładowanie...</div>';
  const data = await api('GET', `/dashboard/${studyId}`);
  if (!data) return;
  renderDashboard(data, studyId);
}

function renderDashboard(d, studyId) {
  const comp = d.conditions_completion || {};
  const bf = d.conditions_mean_belief_false || {};
  const bt = d.conditions_mean_belief_true || {};

  const fmt = v => v != null ? Number(v).toFixed(2) : '–';

  const study = S.studies.find(s => s.id == studyId);
  const slug = study?.slug || '';

  // ── Resolve actual condition names from study settings ──────────────────
  const styleConds = [
    { key: 'A', label: study?.label_style_a || 'Styl A', enabled: study?.enable_condition_a },
    { key: 'B', label: study?.label_style_b || 'Styl B', enabled: study?.enable_condition_b },
  ].filter(c => c.enabled);

  let metricConds = [];
  try { metricConds = JSON.parse(study?.metric_conditions_json || '[]'); } catch {}
  if (!metricConds.length) {
    if (study?.enable_metrics_high) metricConds.push({ key: 'HIGH', label: 'HIGH', enabled: true });
    if (study?.enable_metrics_low)  metricConds.push({ key: 'LOW',  label: 'LOW',  enabled: true });
  }
  metricConds = metricConds.filter(c => c.enabled);

  // Fallback: derive from keys actually present in the data
  if (!metricConds.length || !styleConds.length) {
    const allKeys = Object.keys({ ...comp, ...bf, ...bt });
    const styleKeys  = [...new Set(allKeys.map(k => k.split('-')[0]))].filter(Boolean);
    const metricKeys = [...new Set(allKeys.map(k => k.split('-').slice(1).join('-')))].filter(Boolean);
    if (!styleConds.length)  styleKeys.forEach(k  => styleConds.push({ key: k, label: k }));
    if (!metricConds.length) metricKeys.forEach(k => metricConds.push({ key: k, label: k }));
  }

  // All full condition combos in order
  const allCondKeys   = styleConds.flatMap(sc => metricConds.map(mc => `${sc.key}-${mc.key}`));
  const allCondLabels = styleConds.flatMap(sc => metricConds.map(mc => `${sc.label} / ${mc.label}`));

  // Map raw full_condition key → human-readable label for badges
  const condLabelMap = buildCondLabelMap(study);

  const pivot2x2 = (label, obj) => `
    <div style="margin-bottom:1.5rem">
      <div class="section-title">${label}</div>
      <div class="table-wrap">
        <table class="pivot-table">
          <thead><tr><th>Styl</th>${metricConds.map(mc=>`<th>${esc(mc.label)}</th>`).join('')}<th>Łącznie</th></tr></thead>
          <tbody>
            ${styleConds.map(sc => {
              const vals = metricConds.map(mc => obj[`${sc.key}-${mc.key}`] ?? null);
              const nums = vals.filter(v => v != null);
              const avg  = nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;
              return `<tr><td>${esc(sc.label)}</td>${vals.map(v=>`<td>${fmt(v)}</td>`).join('')}<td>${fmt(avg)}</td></tr>`;
            }).join('')}
            <tr class="total-row"><td>Łącznie</td>
              ${metricConds.map(mc => {
                const vals = styleConds.map(sc => obj[`${sc.key}-${mc.key}`]).filter(v => v != null);
                return `<td>${vals.length ? fmt(vals.reduce((a,b)=>a+b,0)/vals.length) : '–'}</td>`;
              }).join('')}
              <td>${(() => { const all = Object.values(obj).filter(v=>v!=null); return fmt(all.length ? all.reduce((a,b)=>a+b,0)/all.length : null); })()}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const recentRows = (d.recent_sessions || []).map(s => `
    <tr>
      <td class="mono">${s.id}</td>
      <td><span class="badge badge-active" title="${esc(condLabelMap[s.full_condition]?.label || s.full_condition || '')}">
        ${esc(condLabelMap[s.full_condition]?.short || s.full_condition || '–')}</span></td>
      <td>${esc(s.age || '–')}</td>
      <td>${esc(s.residence || '–')}</td>
      <td>${esc(s.education || '–')}</td>
      <td>${esc(s.gender || '–')}</td>
      <td>${fmt(s.avg_belief_false)}</td>
      <td class="text-muted">${s.completed_at ? s.completed_at.slice(0,16).replace('T',' ') : '–'}</td>
    </tr>`).join('');

  document.getElementById('dashboard-content').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${d.total_sessions}</div><div class="stat-label">Wszystkie sesje</div></div>
      <div class="stat-card"><div class="stat-value">${d.completed_sessions}</div><div class="stat-label">Ukończone</div></div>
      <div class="stat-card"><div class="stat-value">${d.dropout_rate?.toFixed(1)}%</div><div class="stat-label">Dropout rate</div></div>
      <div class="stat-card" style="background:var(--surface2)">
        <div class="stat-value" style="font-size:1rem;word-break:break-all">
          <a href="/study/${slug}" target="_blank" style="color:var(--accent)">/study/${slug}</a>
        </div>
        <div class="stat-label">URL badania</div>
      </div>
    </div>

    <div class="grid-2col">
      <div>${pivot2x2('Ukończone sesje (N)', comp)}</div>
      <div>${pivot2x2('Śr. ocena wiarygodności — fałszywe posty', bf)}</div>
    </div>

    <div style="margin-bottom:1.5rem">
      <div class="section-title">Śr. ocena wiarygodności — porównanie warunków</div>
      <div class="table-wrap">
        <table class="pivot-table">
          <thead><tr><th>Typ posta</th>${allCondKeys.map((_,i)=>`<th style="font-size:0.7rem">${esc(allCondLabels[i])}</th>`).join('')}</tr></thead>
          <tbody>
            <tr><td>Fałszywe posty</td>${allCondKeys.map(k=>`<td>${fmt(bf[k])}</td>`).join('')}</tr>
            <tr><td>Prawdziwe posty</td>${allCondKeys.map(k=>`<td>${fmt(bt[k])}</td>`).join('')}</tr>
            <tr class="total-row"><td>Różnica</td>${allCondKeys.map(k=>`<td>${bf[k]!=null&&bt[k]!=null ? fmt(bt[k]-bf[k]) : '–'}</td>`).join('')}</tr>
          </tbody>
        </table>
      </div>
    </div>

    <div>
      <div class="section-title">Ostatnie 20 ukończonych sesji</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Warunek</th><th>Wiek</th><th>Miejsce</th><th>Wykształcenie</th><th>Płeć</th><th>Śr. wiara (fałsz.)</th><th>Data</th></tr></thead>
          <tbody>${recentRows || '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Brak danych</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ── Post Editor ────────────────────────────────────────────────────────────
const TOPICS = ['zdrowie', 'klimat', 'polityka', 'ekonomia', 'nauka'];
const TECHNIQUES = ['pilność', 'fałszywy ekspert', 'spisek', 'liczby bez źródła', 'emocjonalne słowa', 'kozioł ofiarny'];
const TOPIC_CLASS = { zdrowie: 'topic-zdrowie', klimat: 'topic-klimat', polityka: 'topic-polityka', ekonomia: 'topic-ekonomia', nauka: 'topic-nauka' };


document.getElementById('btn-add-post').onclick = async () => {
  if (!S.selectedPostsStudy) return;
  const data = await api('POST', '/posts', { study_id: Number(S.selectedPostsStudy) });
  if (!data) return;
  toast('Nowy post dodany.');
  await loadPosts(S.selectedPostsStudy);
  // Expand the new post
  setTimeout(() => {
    const row = document.querySelector(`[data-post-id="${data.id}"]`);
    if (row && !row.classList.contains('expanded')) row.querySelector('.post-row-header').click();
    row?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
};

async function loadPosts(studyId) {
  document.getElementById('posts-list').innerHTML = '<div class="empty-state">Ładowanie...</div>';
  const posts = await api('GET', `/studies/${studyId}/posts`);
  if (!posts) return;
  renderPosts(Array.isArray(posts) ? posts : []);
}

function renderPosts(posts) {
  const container = document.getElementById('posts-list');
  if (!posts.length) {
    container.innerHTML = '<div class="empty-state">Brak postów. Kliknij "+ Dodaj post" aby dodać pierwszy.</div>';
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
        </div>
        <span class="post-topic-badge ${topicCls}">${esc(p.emoji || '')} ${esc(p.topic || '')}</span>
        <span class="post-type-badge ${p.is_true ? 'type-true' : 'type-false'}">${p.is_true ? 'PRAWDA' : 'FAŁSZ'}</span>
        <span class="badge ${p.is_active ? 'badge-active' : 'badge-inactive'}">${p.is_active ? 'Aktywny' : 'Ukryty'}</span>
        ${p.updated_at ? `<span class="post-updated-at" title="Ostatnia edycja">✏️ ${p.updated_at.slice(0,16).replace('T',' ')}</span>` : ''}
        <div class="post-row-actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-icon" title="Przesuń w górę" onclick="reorderPost(${p.id},'up')">↑</button>
          <button class="btn btn-ghost btn-icon" title="Przesuń w dół" onclick="reorderPost(${p.id},'down')">↓</button>
          <button class="btn btn-danger btn-icon" title="Usuń post" onclick="deletePost(${p.id}, ${JSON.stringify(p.source_name || '—')})">🗑</button>
        </div>
        <span class="expand-icon">▼</span>
      </div>
      <div class="post-row-body" id="post-body-${p.id}">
        ${postFormHTML(p, techs)}
      </div>
    </div>`;
}

function postFormHTML(p, techs) {
  const topicOpts = TOPICS.map(t => `<option value="${t}" ${p.topic===t?'selected':''}>${t}</option>`).join('');
  const techCbs = TECHNIQUES.map(t => `
    <label class="cb-option">
      <input type="checkbox" name="tech" value="${esc(t)}" ${techs.includes(t)?'checked':''}> ${esc(t)}
    </label>`).join('');
  const imgSection = p.image_path
    ? `<img class="image-preview" src="/uploads/${p.study_id}/${esc(p.image_path)}" alt="Post image" id="img-preview-${p.id}">
       <button type="button" class="btn btn-danger btn-sm" onclick="deletePostImage(${p.id})" style="margin-bottom:0.5rem">Usuń zdjęcie</button><br>`
    : `<img class="image-preview" id="img-preview-${p.id}" style="display:none" alt="">`;

  // Per-condition data (metrics override + per-condition comments)
  const study = S.studies.find(s => s.id == S.selectedPostsStudy);
  let metricConds = [];
  try { metricConds = JSON.parse(study?.metric_conditions_json || '[]'); } catch {}
  const activeConds = metricConds.filter(c => c.enabled);
  let overrides = {};
  try { overrides = JSON.parse(p.metrics_override_json || '{}'); } catch {}
  let postComments = {};
  try { postComments = JSON.parse(p.post_comments_json || '{}'); } catch {}

  const condOverrideHTML = activeConds.length ? `
    <div class="form-section-title">Metryki per warunek <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">(puste = losowe z zakresu warunku)</span></div>
    ${activeConds.map(cond => {
      const ov = overrides[cond.key] || {};
      const rangeHint = cond.max > 0 ? ` zakres ${cond.min}–${cond.max}` : ' (brak zakresu → wartość bazowa)';
      return `
        <div style="margin-bottom:0.5rem">
          <div style="font-size:0.8rem;font-weight:600;margin-bottom:0.35rem">${esc(cond.label)}<span style="font-weight:400;color:var(--muted)">${rangeHint}</span></div>
          <div class="form-grid form-grid-4">
            <div class="form-group"><label>👍 Polubienia</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="likes" value="${ov.likes ?? ''}" placeholder="losowe" style="max-width:none"></div>
            <div class="form-group"><label>🔄 Udostępnienia</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="shares" value="${ov.shares ?? ''}" placeholder="losowe" style="max-width:none"></div>
            <div class="form-group"><label>👎 Nie lubię</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="dislikes" value="${ov.dislikes ?? ''}" placeholder="losowe" style="max-width:none"></div>
            <div class="form-group"><label>🚩 Zgłoszenia</label><input type="number" data-cond-key="${esc(cond.key)}" data-metric="flags" value="${ov.flags ?? ''}" placeholder="losowe" style="max-width:none"></div>
          </div>
        </div>`;
    }).join('')}
  ` : '';

  return `
    <div class="form-section-title">Podstawowe</div>
    <div class="form-grid">
      <div class="form-group"><label>Temat</label><select id="pf-topic-${p.id}">${topicOpts}</select></div>
      <div class="form-group"><label>Emoji</label><input type="text" id="pf-emoji-${p.id}" value="${esc(p.emoji||'')}"></div>
      <div class="form-group"><label>Źródło (nazwa)</label><input type="text" id="pf-src-${p.id}" value="${esc(p.source_name||'')}"></div>
      <div class="form-group"><label>Handle</label><input type="text" id="pf-handle-${p.id}" value="${esc(p.source_handle||'')}"></div>
      <div class="form-group"><label>Czas temu</label><input type="text" id="pf-time-${p.id}" value="${esc(p.time_ago||'')}"></div>
      <div style="display:flex;gap:1.5rem;align-items:flex-end;padding-bottom:0.5rem">
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-true-${p.id}" ${p.is_true?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">Post prawdziwy</span>
        </div>
        <div class="toggle-wrap">
          <label class="toggle"><input type="checkbox" id="pf-active-${p.id}" ${p.is_active?'checked':''}><span class="toggle-slider"></span></label>
          <span class="toggle-label">Aktywny</span>
        </div>
      </div>
    </div>

    <div class="form-section-title">Wersja A — manipulacyjna</div>
    <div class="form-group"><label>Nagłówek A</label><textarea id="pf-ha-${p.id}" rows="2">${esc(p.headline_a||'')}</textarea></div>
    <div class="form-group"><label>Treść A</label><textarea id="pf-ca-${p.id}" rows="3">${esc(p.content_a||'')}</textarea></div>

    <div class="form-section-title">Wersja B — neutralna</div>
    <div class="form-group"><label>Nagłówek B</label><textarea id="pf-hb-${p.id}" rows="2">${esc(p.headline_b||'')}</textarea></div>
    <div class="form-group"><label>Treść B</label><textarea id="pf-cb-${p.id}" rows="3">${esc(p.content_b||'')}</textarea></div>

    <div class="form-section-title">Komentarz eksperymentatora <span style="font-weight:400;font-size:0.75rem;color:var(--muted)">(wyświetlany tylko w warunkach z włączonym 💬)</span></div>
    ${['A','B'].map(v => {
      const pc = postComments[v] || {};
      const label = v === 'A' ? (study?.label_style_a || 'Wersja A') : (study?.label_style_b || 'Wersja B');
      return `
        <div style="margin-bottom:0.6rem;padding:0.6rem 0.75rem;background:var(--surface2);border-radius:8px">
          <div style="font-size:0.8rem;font-weight:600;margin-bottom:0.4rem">${esc(label)}</div>
          <div class="form-grid" style="grid-template-columns:1fr 2fr;gap:0.5rem">
            <div class="form-group" style="margin:0"><label>Autor (nick)</label><input type="text" data-cond-key="${v}" data-comment="author" value="${esc(pc.author||'')}" placeholder="np. Zdrowie Polska"></div>
            <div class="form-group" style="margin:0"><label>Treść komentarza</label><input type="text" data-cond-key="${v}" data-comment="text" value="${esc(pc.text||'')}" placeholder="Komentarz pod postem..."></div>
          </div>
        </div>`;
    }).join('')}

    <div class="form-section-title">Techniki manipulacji</div>
    <div class="checkbox-grid">${techCbs}</div>

    ${condOverrideHTML}

    <div class="form-section-title">Zdjęcie (opcjonalne, max 5 MB — jpg/png/webp)</div>
    <div class="image-upload-area" onclick="document.getElementById('pf-img-input-${p.id}').click()">
      <input type="file" id="pf-img-input-${p.id}" accept="image/jpeg,image/png,image/webp" onchange="handleImageUpload(${p.id}, this)">
      ${imgSection}
      <div class="image-upload-label">Kliknij aby wybrać zdjęcie</div>
    </div>

    <div class="post-save-bar">
      <button class="btn btn-primary" onclick="savePost(${p.id})">Zapisz post</button>
      <span class="save-status" id="save-status-${p.id}" style="display:none">✓ Zapisano</span>
    </div>`;
}

function togglePostRow(id) {
  const row = document.getElementById(`post-row-${id}`);
  row.classList.toggle('expanded');
}

async function savePost(id) {
  const row = document.getElementById(`post-body-${id}`);
  const techs = [...row.querySelectorAll('input[name="tech"]:checked')].map(c => c.value);
  const body = {
    topic: document.getElementById(`pf-topic-${id}`).value,
    emoji: document.getElementById(`pf-emoji-${id}`).value,
    source_name: document.getElementById(`pf-src-${id}`).value,
    source_handle: document.getElementById(`pf-handle-${id}`).value,
    time_ago: document.getElementById(`pf-time-${id}`).value,
    is_true: document.getElementById(`pf-true-${id}`).checked ? 1 : 0,
    is_active: document.getElementById(`pf-active-${id}`).checked ? 1 : 0,
    headline_a: document.getElementById(`pf-ha-${id}`).value,
    content_a: document.getElementById(`pf-ca-${id}`).value,
    headline_b: document.getElementById(`pf-hb-${id}`).value,
    content_b: document.getElementById(`pf-cb-${id}`).value,
    manipulation_techniques: techs,
  };

  // Collect per-condition comments
  const commentMap = {};
  row.querySelectorAll('input[data-cond-key][data-comment]').forEach(input => {
    const key = input.dataset.condKey;
    const field = input.dataset.comment; // 'author' or 'text'
    const val = input.value.trim();
    if (val) {
      if (!commentMap[key]) commentMap[key] = {};
      commentMap[key][field] = val;
    }
  });
  body.post_comments_json = JSON.stringify(commentMap);

  // Collect per-condition metric overrides
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

  const data = await api('PATCH', `/posts/${id}`, body);
  if (!data) return;

  const status = document.getElementById(`save-status-${id}`);
  status.style.display = '';
  setTimeout(() => { status.style.display = 'none'; }, 2500);

  // Update header badges
  const row2 = document.getElementById(`post-row-${id}`);
  row2.querySelector('.post-type-badge').className = `post-type-badge ${data.is_true ? 'type-true' : 'type-false'}`;
  row2.querySelector('.post-type-badge').textContent = data.is_true ? 'PRAWDA' : 'FAŁSZ';
  row2.querySelector('.badge').className = `badge ${data.is_active ? 'badge-active' : 'badge-inactive'}`;
  row2.querySelector('.badge').textContent = data.is_active ? 'Aktywny' : 'Ukryty';
}

async function reorderPost(id, direction) {
  await api('PATCH', `/posts/${id}/reorder`, { direction });
  await loadPosts(S.selectedPostsStudy);
}

async function handleImageUpload(postId, input) {
  if (!input.files[0]) return;
  const fd = new FormData();
  fd.append('image', input.files[0]);
  const data = await api('POST', `/posts/${postId}/image`, fd, true);
  if (!data || data.error) { toast(data?.error || 'Błąd uploadu', 'error'); return; }
  // Show preview
  const prev = document.getElementById(`img-preview-${postId}`);
  prev.src = data.image_url + '?t=' + Date.now();
  prev.style.display = 'block';
  toast('Zdjęcie zapisane.');
}

async function deletePost(id, title) {
  if (!confirm(`Usunąć post "${title}"?\nTa operacja usunie też powiązane reakcje i oceny. Nie można jej cofnąć.`)) return;
  await api('DELETE', `/posts/${id}`);
  toast('Post usunięty.');
  await loadPosts(S.selectedPostsStudy);
}

async function deletePostImage(postId) {
  if (!confirm('Usunąć zdjęcie?')) return;
  await api('DELETE', `/posts/${postId}/image`);
  const prev = document.getElementById(`img-preview-${postId}`);
  prev.src = '';
  prev.style.display = 'none';
  toast('Zdjęcie usunięte.');
}

function goToPostEditor(studyId) {
  setActiveStudy(studyId);
  switchTab('posts');
}

// ── Export ─────────────────────────────────────────────────────────────────

async function loadExportView(studyId) {
  const dashboard = await api('GET', `/dashboard/${studyId}`);
  if (!dashboard) return;
  const study = S.studies.find(s => s.id == studyId);

  document.getElementById('export-content').innerHTML = `
    <div class="export-box">
      <h3>${esc(study?.name || 'Badanie')}</h3>
      <div class="export-stats">
        Ukończone sesje: <strong>${dashboard.completed_sessions}</strong>
        &nbsp;·&nbsp; Wszystkie sesje: <strong>${dashboard.total_sessions}</strong>
      </div>
      <div class="export-btn-wrap">
        <a class="btn btn-success" href="/api/admin/export/${studyId}"
           id="export-link"
           onclick="handleExportClick(event, ${studyId})">
          📥 Pobierz Excel (.xlsx)
        </a>
      </div>
      <p style="color:var(--muted);font-size:0.8rem;margin-top:1rem">
        Plik zawiera 5 arkuszy: Dane_surowe, Oceny_wiarygodnosci, Podsumowanie_sesji, Design_2x2, Klucz_kodowania
      </p>
    </div>

    <div class="codebook">
      <div class="section-title">Klucz kodowania zmiennych demograficznych</div>
      <div class="codebook-grid">
        <div class="codebook-group">
          <div class="codebook-group-title">Wiek (age_kod)</div>
          <div class="codebook-row"><span class="code-num">1</span><span>18–25</span></div>
          <div class="codebook-row"><span class="code-num">2</span><span>26–35</span></div>
          <div class="codebook-row"><span class="code-num">3</span><span>36–45</span></div>
          <div class="codebook-row"><span class="code-num">4</span><span>46–60</span></div>
          <div class="codebook-row"><span class="code-num">5</span><span>60+</span></div>
        </div>
        <div class="codebook-group">
          <div class="codebook-group-title">Miejsce zamieszkania (residence_kod)</div>
          <div class="codebook-row"><span class="code-num">1</span><span>Duże miasto (100 tys.+)</span></div>
          <div class="codebook-row"><span class="code-num">2</span><span>Średnie miasto (10–100 tys.)</span></div>
          <div class="codebook-row"><span class="code-num">3</span><span>Małe miasto (poniżej 10 tys.)</span></div>
          <div class="codebook-row"><span class="code-num">4</span><span>Wieś</span></div>
        </div>
        <div class="codebook-group">
          <div class="codebook-group-title">Wykształcenie (education_kod)</div>
          <div class="codebook-row"><span class="code-num">1</span><span>Podstawowe</span></div>
          <div class="codebook-row"><span class="code-num">2</span><span>Średnie</span></div>
          <div class="codebook-row"><span class="code-num">3</span><span>Wyższe (licencjat)</span></div>
          <div class="codebook-row"><span class="code-num">4</span><span>Wyższe (magister lub wyższe)</span></div>
        </div>
        <div class="codebook-group">
          <div class="codebook-group-title">Płeć (gender_kod)</div>
          <div class="codebook-row"><span class="code-num">1</span><span>Kobieta</span></div>
          <div class="codebook-row"><span class="code-num">2</span><span>Mężczyzna</span></div>
          <div class="codebook-row"><span class="code-num">3</span><span>Inne</span></div>
          <div class="codebook-row"><span class="code-num">4</span><span>Wolę nie podawać</span></div>
        </div>
      </div>
    </div>

    <div>
      <div class="section-title">Ostatnie 10 sesji (podgląd)</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Warunek</th><th>Wiek</th><th>Płeć</th><th>Śr. wiara (fałsz.)</th><th>Data</th></tr></thead>
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
              </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Brak danych</td></tr>';
            })()}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function handleExportClick(e, studyId) {
  e.preventDefault();
  const link = document.getElementById('export-link');
  link.textContent = '⏳ Generowanie...';
  try {
    const r = await fetch(`/api/admin/export/${studyId}`, {
      headers: { Authorization: `Bearer ${S.token}` },
    });
    if (!r.ok) { toast('Błąd eksportu.', 'error'); return; }
    const blob = await r.blob();
    const disp = r.headers.get('content-disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `export_${studyId}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast('Plik pobrany!');
  } catch {
    toast('Błąd eksportu.', 'error');
  } finally {
    link.textContent = '📥 Pobierz Excel (.xlsx)';
  }
}

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
