// ── Dashboard widget engine — pure functions ──────────────────────────────
// Same data-source abstraction as the export builder + stats engine:
// every widget receives { rows, columns } from getDaneSuroweData(ctx) and
// returns a JSON payload the frontend renders with Chart.js (or as a
// raw table). Five widget types implemented in this iteration:
//
//   kpi          — single big number (count / mean / pct)
//   bar_chart    — aggregated metric per category (+ optional ANOVA/t-test)
//   histogram    — distribution of one numeric variable (+ M, SD overlay)
//   crosstab     — 2D categorical frequencies (+ optional chi²)
//   time_series  — sessions/completions per time bucket
//
// Every renderer is a pure function (config + rows + columns → output).
// No I/O, no DB calls inside renderers — keeps them testable and reusable
// for any future data source (e.g. per-post sheet, eye-tracking, etc.).

const ss = require('simple-statistics');
const stats = require('./stats');

// Helpers ───────────────────────────────────────────────────────────────────
function asNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function numericCol(rows, key) {
  return rows.map(r => asNumber(r[key])).filter(v => v != null);
}
function groupBy(rows, key) {
  const out = {};
  rows.forEach(r => {
    const k = r[key];
    if (k == null || k === '') return;
    (out[k] ||= []).push(r);
  });
  return out;
}

// ── KPI: single big number ─────────────────────────────────────────────────
// config.metric:
//   'count_completed' | 'count_total' | 'count_preview' | 'dropout_pct'  → session-level
//   'count' | 'mean' | 'median' | 'sum' | 'pct_missing'                  → column-level (needs config.column)
//   'pct_value'                                                          → % of rows where config.column == config.value
function renderKpi(config, rows, columns, sessionMeta = {}) {
  const m = config.metric;
  let value = null, subtitle = null, format = config.format || 'integer';

  if (m === 'count_completed') {
    value = sessionMeta.completed_sessions ?? rows.length;
    subtitle = 'ukończonych sesji';
  } else if (m === 'count_total') {
    value = sessionMeta.total_sessions ?? rows.length;
    subtitle = 'wszystkich sesji';
  } else if (m === 'count_preview') {
    value = sessionMeta.preview_count ?? 0;
    subtitle = 'sesji podglądowych';
  } else if (m === 'dropout_pct') {
    value = sessionMeta.dropout_rate ?? 0;
    subtitle = '% niedokończonych';
    format = 'percent';
  } else if (m === 'count') {
    value = rows.length;
    subtitle = `wierszy${config.column ? ` (kol. ${config.column})` : ''}`;
  } else if (m === 'mean' && config.column) {
    const vals = numericCol(rows, config.column);
    value = vals.length ? ss.mean(vals) : null;
    subtitle = `średnia ${config.column} (n = ${vals.length})`;
    format = config.format || 'decimal';
  } else if (m === 'median' && config.column) {
    const vals = numericCol(rows, config.column);
    value = vals.length ? ss.median(vals) : null;
    subtitle = `mediana ${config.column} (n = ${vals.length})`;
    format = config.format || 'decimal';
  } else if (m === 'sum' && config.column) {
    const vals = numericCol(rows, config.column);
    value = vals.length ? ss.sum(vals) : null;
    subtitle = `suma ${config.column}`;
  } else if (m === 'pct_missing' && config.column) {
    const total = rows.length;
    const missing = rows.filter(r => r[config.column] == null || r[config.column] === '').length;
    value = total ? (missing / total) * 100 : 0;
    subtitle = `% brakujących w ${config.column}`;
    format = 'percent';
  } else if (m === 'pct_value' && config.column && config.value != null) {
    const total = rows.length;
    const matching = rows.filter(r => String(r[config.column]) === String(config.value)).length;
    value = total ? (matching / total) * 100 : 0;
    subtitle = `% gdzie ${config.column} = ${config.value}`;
    format = 'percent';
  } else {
    return { error: `Nieznana lub źle skonfigurowana metryka: ${m}` };
  }

  return {
    type: 'kpi',
    value: value != null ? (format === 'decimal' ? Number(value.toFixed(2)) : Math.round(value * 100) / 100) : null,
    format,
    subtitle: config.subtitle ?? subtitle,
  };
}

// ── Bar chart: aggregated metric per category ──────────────────────────────
// config: { value_var?, group_var, aggregator: 'mean'|'median'|'count'|'sum',
//           with_stats?: 'anova'|'t_test' }
function renderBarChart(config, rows, columns) {
  if (!config.group_var) return { error: 'group_var wymagane.' }; // config bug — red
  const groups = groupBy(rows, config.group_var);
  const categories = Object.keys(groups).sort();
  if (!categories.length) return { empty: true, message: 'Brak danych w kolumnie grupującej.' }; // no rows yet — soft state

  const aggregator = config.aggregator || 'count';
  let values = [];
  let se = null;
  let n_per_group = [];

  if (aggregator === 'count') {
    values = categories.map(c => groups[c].length);
    n_per_group = values.slice();
  } else {
    if (!config.value_var) return { error: 'value_var wymagane dla agregacji innej niż count.' };
    se = [];
    categories.forEach(c => {
      const vals = numericCol(groups[c], config.value_var);
      n_per_group.push(vals.length);
      if (!vals.length) { values.push(null); se.push(null); return; }
      if (aggregator === 'mean')   { values.push(ss.mean(vals));   se.push(vals.length > 1 ? ss.sampleStandardDeviation(vals) / Math.sqrt(vals.length) : 0); }
      else if (aggregator === 'median') { values.push(ss.median(vals)); se.push(null); }
      else if (aggregator === 'sum')    { values.push(ss.sum(vals));    se.push(null); }
      else                              { values.push(null);            se.push(null); }
    });
  }

  // Optional inline statistical test (re-uses stats engine)
  let test_result = null;
  if (config.with_stats && aggregator === 'mean' && config.value_var) {
    const arrays = categories.map(c => numericCol(groups[c], config.value_var)).filter(a => a.length >= 2);
    if (arrays.length >= 2) {
      if (config.with_stats === 'anova' && arrays.length >= 2) {
        const r = stats.runOneWayAnova(arrays, { labels: categories });
        if (!r.error) test_result = { test: 'ANOVA', F: r.F, df: `${r.df_between},${r.df_within}`, p: r.p, eta_sq: r.eta_squared };
      } else if (config.with_stats === 't_test' && arrays.length === 2) {
        const r = stats.runTTest(arrays[0], arrays[1]);
        if (!r.error) test_result = { test: 't', t: r.t, df: r.df, p: r.p, cohens_d: r.cohens_d };
      }
    }
  }

  return {
    type: 'bar_chart',
    categories: categories.map(c => String(c)),
    values: values.map(v => v == null ? null : Number(v.toFixed(2))),
    se: se ? se.map(v => v == null ? null : Number(v.toFixed(3))) : null,
    n_per_group,
    aggregator,
    value_var: config.value_var,
    group_var: config.group_var,
    test_result,
  };
}

// ── Histogram: distribution of one numeric variable ────────────────────────
// config: { variable, bins?: number (default Sturges') }
function renderHistogram(config, rows, columns) {
  if (!config.variable) return { error: 'variable wymagana.' };
  const vals = numericCol(rows, config.variable);
  if (vals.length < 2) return { empty: true, message: `Za mało danych liczbowych w "${config.variable}" (n = ${vals.length}).` };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (min === max) return { empty: true, message: 'Wszystkie wartości jednakowe — histogram nic nie pokaże.' };
  // Sturges' rule for default bin count, capped at 30
  const binCount = Math.max(3, Math.min(30, config.bins || Math.ceil(Math.log2(vals.length) + 1)));
  const binWidth = (max - min) / binCount;
  const bin_edges = []; for (let i = 0; i <= binCount; i++) bin_edges.push(min + i * binWidth);
  const counts = new Array(binCount).fill(0);
  vals.forEach(v => {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= binCount) idx = binCount - 1; // upper edge inclusive
    counts[idx]++;
  });
  const mean = ss.mean(vals);
  const sd = vals.length > 1 ? ss.sampleStandardDeviation(vals) : 0;
  return {
    type: 'histogram',
    variable: config.variable,
    n: vals.length,
    bin_edges: bin_edges.map(e => Number(e.toFixed(2))),
    counts,
    mean: Number(mean.toFixed(2)),
    sd: Number(sd.toFixed(2)),
    median: Number(ss.median(vals).toFixed(2)),
  };
}

// ── Crosstab: 2D categorical frequencies (+ optional chi²) ────────────────
// config: { row_var, col_var, show_pct?: 'row'|'col'|'total', with_chi2?: bool }
function renderCrosstab(config, rows, columns) {
  if (!config.row_var || !config.col_var) return { error: 'row_var i col_var wymagane.' };
  const rowVals = [...new Set(rows.map(r => r[config.row_var]).filter(v => v != null && v !== ''))].sort();
  const colVals = [...new Set(rows.map(r => r[config.col_var]).filter(v => v != null && v !== ''))].sort();
  if (rowVals.length < 1 || colVals.length < 1) return { empty: true, message: 'Brak danych w jednej z kolumn.' };

  const observed = rowVals.map(rv => colVals.map(cv =>
    rows.filter(r => r[config.row_var] === rv && r[config.col_var] === cv).length
  ));
  const rowTotals = observed.map(r => r.reduce((a, b) => a + b, 0));
  const colTotals = colVals.map((_, j) => observed.reduce((s, r) => s + r[j], 0));
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

  // Optional percentage matrix
  let pct = null;
  if (config.show_pct) {
    pct = observed.map((r, i) => r.map((v, j) => {
      const denom = config.show_pct === 'row' ? rowTotals[i]
                  : config.show_pct === 'col' ? colTotals[j]
                  : grandTotal;
      return denom ? Number((v / denom * 100).toFixed(1)) : 0;
    }));
  }

  let chi2_result = null;
  if (config.with_chi2 && rowVals.length >= 2 && colVals.length >= 2) {
    const r = stats.runChiSquareIndependence(observed);
    if (!r.error) chi2_result = { chi2: r.chi2, df: r.df, p: r.p, cramers_v: r.cramers_v, warning: r.assumption_warning };
  }

  return {
    type: 'crosstab',
    row_var: config.row_var,
    col_var: config.col_var,
    row_categories: rowVals.map(v => String(v)),
    col_categories: colVals.map(v => String(v)),
    observed,
    pct,
    pct_mode: config.show_pct || null,
    row_totals: rowTotals,
    col_totals: colTotals,
    grand_total: grandTotal,
    chi2_result,
  };
}

// ── Time series: sessions per time bucket ──────────────────────────────────
// Uses started_at + completed_at directly from the row data (already in
// Warsaw-local format from buildExportContext).
// config: { granularity: 'day'|'week'|'month' (default day),
//           metric?: 'started'|'completed' (default completed),
//           days_back?: number (default 30) }
function renderTimeSeries(config, rows, columns) {
  const gran = config.granularity || 'day';
  const metric = config.metric || 'completed';
  const daysBack = config.days_back || 30;

  const dateField = metric === 'started' ? 'started_at' : 'completed_at';
  const buckets = {};
  rows.forEach(r => {
    const ts = r[dateField];
    if (!ts) return;
    // ts is "YYYY-MM-DD HH:MM:SS" (Warsaw local). Bucket by date portion.
    const datePart = ts.slice(0, 10);
    const d = new Date(datePart);
    if (isNaN(d)) return;
    let bucket;
    if (gran === 'month') bucket = datePart.slice(0, 7); // YYYY-MM
    else if (gran === 'week') {
      // ISO-ish week — Monday start
      const day = d.getUTCDay() || 7; // Sun → 7
      const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - day + 1);
      bucket = monday.toISOString().slice(0, 10);
    } else bucket = datePart;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });

  // Fill empty buckets back to days_back so the chart isn't gappy
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const dates = []; const counts = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    let bucket;
    if (gran === 'month') bucket = d.toISOString().slice(0, 7);
    else if (gran === 'week') {
      const day = d.getUTCDay() || 7;
      const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - day + 1);
      bucket = monday.toISOString().slice(0, 10);
    } else bucket = d.toISOString().slice(0, 10);
    if (!dates.length || dates[dates.length - 1] !== bucket) {
      dates.push(bucket);
      counts.push(buckets[bucket] || 0);
    }
  }

  return {
    type: 'time_series',
    granularity: gran,
    metric,
    dates,
    counts,
    total: counts.reduce((a, b) => a + b, 0),
  };
}

// ── Scatter plot — two numeric variables ──────────────────────────────────
// config: { variable_x, variable_y, color_by? (categorical) }
// Returns x[], y[], optional color_by_values[] + n + Pearson r (when no color split).
function renderScatter(config, rows, columns) {
  if (!config.variable_x || !config.variable_y) return { error: 'variable_x i variable_y wymagane.' };
  // Build paired data — keep only rows where BOTH x and y are numeric
  const points = [];
  rows.forEach(r => {
    const x = asNumber(r[config.variable_x]);
    const y = asNumber(r[config.variable_y]);
    if (x == null || y == null) return;
    const point = { x, y };
    if (config.color_by) point.group = r[config.color_by] ?? null;
    points.push(point);
  });
  if (points.length < 2) return { empty: true, message: 'Za mało par danych (n < 2).' };

  // When no color_by, compute Pearson r for the inline stat strip
  let r = null;
  if (!config.color_by) {
    try { r = ss.sampleCorrelation(points.map(p => p.x), points.map(p => p.y)); } catch {}
  }

  return {
    type: 'scatter',
    variable_x: config.variable_x,
    variable_y: config.variable_y,
    color_by: config.color_by || null,
    points,
    n: points.length,
    r: r != null ? Number(r.toFixed(3)) : null,
  };
}

// ── Boxplot — distribution per group via quartiles ────────────────────────
// config: { variable (numeric), group_by (categorical, optional) }
// Returns per-group { n, min, q1, median, q3, max, outliers, mean }.
function renderBoxplot(config, rows, columns) {
  if (!config.variable) return { error: 'variable wymagana.' };
  // Group → array of numeric values
  let groups;
  if (config.group_by) {
    const buckets = groupBy(rows, config.group_by);
    groups = Object.entries(buckets)
      .map(([label, rs]) => ({ label: String(label), values: numericCol(rs, config.variable) }))
      .filter(g => g.values.length >= 1)
      .sort((a, b) => a.label.localeCompare(b.label));
  } else {
    groups = [{ label: '(wszystkie)', values: numericCol(rows, config.variable) }];
  }
  if (!groups.length || groups.every(g => g.values.length < 2)) {
    return { empty: true, message: 'Za mało danych dla boxplotu.' };
  }
  const stats = groups.map(g => {
    const vals = g.values;
    if (vals.length < 1) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const q1 = ss.quantile(sorted, 0.25);
    const q3 = ss.quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    const outliers = sorted.filter(v => v < lowerFence || v > upperFence);
    const innerVals = sorted.filter(v => v >= lowerFence && v <= upperFence);
    return {
      label: g.label, n: vals.length,
      min: innerVals.length ? Number(Math.min(...innerVals).toFixed(2)) : null,
      q1: Number(q1.toFixed(2)),
      median: Number(ss.median(vals).toFixed(2)),
      q3: Number(q3.toFixed(2)),
      max: innerVals.length ? Number(Math.max(...innerVals).toFixed(2)) : null,
      mean: Number(ss.mean(vals).toFixed(2)),
      outliers: outliers.map(v => Number(v.toFixed(2))),
    };
  }).filter(Boolean);
  return { type: 'boxplot', variable: config.variable, group_by: config.group_by || null, stats };
}

// ── Pie / donut — composition of a categorical variable ───────────────────
// config: { variable (categorical), top_n? (limit to top N, others bucketed as "inne") }
function renderPie(config, rows, columns) {
  if (!config.variable) return { error: 'variable wymagana.' };
  const counts = {};
  rows.forEach(r => {
    const v = r[config.variable];
    if (v == null || v === '') return;
    counts[v] = (counts[v] || 0) + 1;
  });
  let entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { empty: true, message: 'Brak danych w kolumnie.' };
  const total = entries.reduce((s, e) => s + e[1], 0);

  // Optional top-N grouping — keep the largest N, bucket the rest as "inne"
  if (config.top_n && entries.length > config.top_n) {
    const top = entries.slice(0, config.top_n);
    const other = entries.slice(config.top_n).reduce((s, e) => s + e[1], 0);
    entries = [...top, ['inne', other]];
  }

  return {
    type: 'pie',
    variable: config.variable,
    n: total,
    categories: entries.map(e => String(e[0])),
    counts: entries.map(e => e[1]),
    pct: entries.map(e => Number((e[1] / total * 100).toFixed(1))),
  };
}

// ── Correlation heatmap — N×N r matrix ────────────────────────────────────
// config: { variables (≥2 numeric column keys), method? 'pearson'|'spearman' }
function renderCorrelationHeatmap(config, rows, columns) {
  if (!Array.isArray(config.variables) || config.variables.length < 2) {
    return { error: 'Wymagane ≥2 zmienne ciągłe.' };
  }
  const method = config.method === 'spearman' ? 'spearman' : 'pearson';
  // Build matrix using stats engine to keep behavior consistent with Analizy tab
  const vars = config.variables.map(k => ({ name: k, values: rows.map(r => r[k]) }));
  const result = stats.runCorrelationMatrix(vars);
  return {
    type: 'correlation_heatmap',
    method,
    variables: result.variables,
    // Headers — apply translation-friendly labels if columns metadata has them
    labels: result.variables.map(v => columns.find(c => c.key === v)?.header || v),
    r: result.r,
    p: result.p,
  };
}

// ── Text responses — open-ended answers as scrollable list ────────────────
// config: { variable (text column), group_by? (categorical, optional) }
// Returns up to `limit` non-empty responses with their group label (if any).
function renderTextResponses(config, rows, columns) {
  if (!config.variable) return { error: 'variable wymagana.' };
  const limit = Math.min(config.limit || 100, 500);
  const out = [];
  for (const r of rows) {
    const text = r[config.variable];
    if (text == null || text === '' || typeof text === 'object') continue;
    const entry = {
      text: String(text),
      session_id: r.session_id ?? null,
    };
    if (config.group_by) entry.group = r[config.group_by] ?? null;
    out.push(entry);
    if (out.length >= limit) break;
  }
  if (!out.length) return { empty: true, message: 'Brak niepustych odpowiedzi w tej kolumnie.' };
  return {
    type: 'text_responses',
    variable: config.variable,
    group_by: config.group_by || null,
    responses: out,
    total: out.length,
  };
}

// ── Dispatcher ─────────────────────────────────────────────────────────────
const RENDERERS = {
  kpi: renderKpi,
  bar_chart: renderBarChart,
  histogram: renderHistogram,
  crosstab: renderCrosstab,
  time_series: renderTimeSeries,
  scatter: renderScatter,
  boxplot: renderBoxplot,
  pie: renderPie,
  correlation_heatmap: renderCorrelationHeatmap,
  text_responses: renderTextResponses,
};

function renderWidget(widget, rows, columns, sessionMeta) {
  const renderer = RENDERERS[widget.type];
  if (!renderer) return { ...widget, data: { error: `Nieznany typ widgetu: ${widget.type}` } };
  try {
    const output = renderer(widget, rows, columns, sessionMeta);
    // Spread the full widget config alongside the rendered data so the frontend
    // round-trip (load → render → edit → save) doesn't need to unwrap. Saving
    // DB.widgets verbatim now sends valid configs back to the server.
    return { ...widget, data: output };
  } catch (err) {
    return { ...widget, data: { error: err.message } };
  }
}

// ── Smart defaults ─────────────────────────────────────────────────────────
// When a study has no dashboard_config_json saved yet, generate a sensible
// default based on its schema (manipulation conditions, post questions,
// demographic questions, eye-tracking). Returns a config the frontend can
// save back as the initial state OR display ephemerally.
function generateDefaultDashboard(ctx) {
  const { study, postQuestions, demoQuestions } = ctx;
  const widgets = [];
  let id = 0; const nextId = () => `w${++id}`;

  // KPIs always make sense
  widgets.push({ id: nextId(), type: 'kpi', title: 'Ukończone sesje',     metric: 'count_completed' });
  widgets.push({ id: nextId(), type: 'kpi', title: 'Wszystkie sesje',     metric: 'count_total' });
  widgets.push({ id: nextId(), type: 'kpi', title: 'Drop-out',            metric: 'dropout_pct', format: 'percent' });
  widgets.push({ id: nextId(), type: 'kpi', title: 'Średni czas (min)',  metric: 'mean', column: 'duration_min', format: 'decimal' });

  // Recruitment trend
  widgets.push({ id: nextId(), type: 'time_series', title: 'Sesje w czasie (30 dni)', granularity: 'day', metric: 'completed', days_back: 30 });

  // If study has manipulation conditions → bar chart per condition for the
  // first numeric "outcome" we can find. For builder studies that's typically
  // a Likert post-question response.
  const hasMultiConditions = (() => {
    try { const m = JSON.parse(study.manipulation_json || '[]'); return m.some(x => (x.conditions || []).length >= 2); } catch { return false; }
  })();

  if (hasMultiConditions) {
    // Find a likely outcome column: first builder Likert post-question, else duration_min
    const likertPq = postQuestions.find(q => q.question_type === 'likert');
    if (likertPq) {
      widgets.push({
        id: nextId(), type: 'bar_chart',
        title: `Średnia odpowiedź "${likertPq.label}" wg warunku`,
        value_var: `post_1_q${likertPq.id}`,
        group_var: 'full_condition',
        aggregator: 'mean',
        with_stats: 'anova',
      });
    } else {
      widgets.push({
        id: nextId(), type: 'bar_chart',
        title: 'Średni czas sesji wg warunku',
        value_var: 'duration_min',
        group_var: 'full_condition',
        aggregator: 'mean',
        with_stats: 'anova',
      });
    }
  }

  // Demographic composition pie/bar — first legacy demo (gender) as bar
  if (demoQuestions.length || true) {
    widgets.push({
      id: nextId(), type: 'bar_chart',
      title: 'Skład próby — płeć',
      group_var: 'gender',
      aggregator: 'count',
    });
  }

  // Crosstab: full_condition × gender if multi-condition
  if (hasMultiConditions) {
    widgets.push({
      id: nextId(), type: 'crosstab',
      title: 'Warunek × płeć',
      row_var: 'full_condition',
      col_var: 'gender',
      show_pct: 'row',
      with_chi2: true,
    });
  }

  return { widgets };
}

module.exports = {
  renderWidget,
  generateDefaultDashboard,
  RENDERERS,
};
