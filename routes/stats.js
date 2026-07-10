// ── Statistical tests — pure functions ─────────────────────────────────────
// Quick-look helpers for the researcher dashboard. All inputs are plain
// arrays of numbers (or 2D arrays for chi-square). Every test returns a
// flat result object with the test statistic, df, p-value, effect size,
// and (when applicable) confidence interval — plus an `interpretation`
// string in plain Polish suitable for the UI's results panel.
//
// IMPORTANT: outputs are validated against R/SPSS to within 4 decimal
// places for the test fixtures in __tests__/stats.test.js. Researchers
// should still verify publication-grade results with R/SPSS/JASP — these
// helpers exist to make exploratory analysis fast, not to replace
// dedicated stats software.

const ss = require('simple-statistics');
const jstat = require('jstat');

// ── Helpers ────────────────────────────────────────────────────────────────
function cleanNumeric(arr) {
  return (arr || []).map(v => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }).filter(v => v != null);
}
function fmt(n, digits = 3) {
  if (n == null || !Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}
function pStr(p) {
  if (p == null) return 'n/a';
  if (p < 0.001) return '< .001';
  return 'p = ' + p.toFixed(3).replace(/^0\./, '.');
}
function effectSizeMagnitude(d) {
  const a = Math.abs(d);
  if (a < 0.2) return 'znikomy';
  if (a < 0.5) return 'mały';
  if (a < 0.8) return 'średni';
  return 'duży';
}

// ── Descriptives ──────────────────────────────────────────────────────────
function runDescriptives(values) {
  const x = cleanNumeric(values);
  const n = x.length;
  if (n === 0) return { n: 0, error: 'Brak danych liczbowych' };
  const mean = ss.mean(x);
  const sd = n > 1 ? ss.sampleStandardDeviation(x) : 0;
  return {
    n,
    missing: (values || []).length - n,
    mean: fmt(mean),
    sd: fmt(sd),
    median: fmt(ss.median(x)),
    min: fmt(ss.min(x)),
    max: fmt(ss.max(x)),
    q1: fmt(ss.quantile(x, 0.25)),
    q3: fmt(ss.quantile(x, 0.75)),
    sem: fmt(n > 1 ? sd / Math.sqrt(n) : 0),
  };
}

// ── t-test (Welch by default; pooled when equal variance) ────────────────
function runTTest(group1, group2, options = {}) {
  const x = cleanNumeric(group1);
  const y = cleanNumeric(group2);
  const paired = options.paired === true;

  if (paired) {
    const raw1 = group1 || []; const raw2 = group2 || [];
    if (raw1.length !== raw2.length) {
      return { error: 'Test t dla prób zależnych wymaga par równej długości.' };
    }
    const diffs = [];
    for (let i = 0; i < raw1.length; i++) {
      const a = Number(raw1[i]); const b = Number(raw2[i]);
      if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(a - b);
    }
    if (diffs.length < 2) return { error: 'Za mało kompletnych par (n < 2).' };
    const md = ss.mean(diffs);
    const sdd = ss.sampleStandardDeviation(diffs);
    const n = diffs.length;
    const sed = sdd / Math.sqrt(n);
    const t = md / sed;
    const df = n - 1;
    const p = 2 * (1 - jstat.studentt.cdf(Math.abs(t), df));
    const d = md / sdd; // Cohen's dz for paired
    const tcrit = jstat.studentt.inv(0.975, df);
    return {
      test: 't dla prób zależnych',
      n_pairs: n,
      mean_diff: fmt(md),
      sd_diff: fmt(sdd),
      t: fmt(t),
      df,
      p: fmt(p, 4),
      cohens_d: fmt(d),
      ci95: [fmt(md - tcrit * sed), fmt(md + tcrit * sed)],
      effect_magnitude: effectSizeMagnitude(d),
      interpretation: `Średnia różnica = ${fmt(md)} (SD = ${fmt(sdd)}), t(${df}) = ${fmt(t, 2)}, ${pStr(p)}, d = ${fmt(d, 2)} (${effectSizeMagnitude(d)} efekt).`,
    };
  }

  // Independent samples — Welch's t-test by default (does NOT assume equal variances)
  if (x.length < 2 || y.length < 2) return { error: 'Każda grupa wymaga ≥2 obserwacji.' };
  const m1 = ss.mean(x), m2 = ss.mean(y);
  const v1 = ss.sampleVariance(x), v2 = ss.sampleVariance(y);
  const n1 = x.length, n2 = y.length;
  const se = Math.sqrt(v1 / n1 + v2 / n2);
  const t = (m1 - m2) / se;
  // Welch–Satterthwaite df
  const df = Math.pow(v1 / n1 + v2 / n2, 2) /
             ((v1 * v1) / (n1 * n1 * (n1 - 1)) + (v2 * v2) / (n2 * n2 * (n2 - 1)));
  const p = 2 * (1 - jstat.studentt.cdf(Math.abs(t), df));
  // Cohen's d using pooled SD (Hedges-corrected version omitted for simplicity)
  const sPooled = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const d = (m1 - m2) / sPooled;
  const tcrit = jstat.studentt.inv(0.975, df);
  const diff = m1 - m2;
  // Levene assumption check (equal variances)
  const levene = runLevene([x, y]);
  return {
    test: 't dla prób niezależnych (Welch)',
    group1: { n: n1, mean: fmt(m1), sd: fmt(Math.sqrt(v1)) },
    group2: { n: n2, mean: fmt(m2), sd: fmt(Math.sqrt(v2)) },
    mean_diff: fmt(diff),
    t: fmt(t),
    df: fmt(df, 2),
    p: fmt(p, 4),
    cohens_d: fmt(d),
    ci95: [fmt(diff - tcrit * se), fmt(diff + tcrit * se)],
    effect_magnitude: effectSizeMagnitude(d),
    assumption_equal_variance: levene,
    interpretation: `M1 = ${fmt(m1)} (SD = ${fmt(Math.sqrt(v1))}, n = ${n1}), M2 = ${fmt(m2)} (SD = ${fmt(Math.sqrt(v2))}, n = ${n2}). t(${fmt(df, 2)}) = ${fmt(t, 2)}, ${pStr(p)}, d = ${fmt(d, 2)} (${effectSizeMagnitude(d)} efekt).`,
  };
}

// ── One-way ANOVA + Tukey HSD post-hoc ────────────────────────────────────
function runOneWayAnova(groups, options = {}) {
  // groups: array of arrays of numbers, with group labels in options.labels
  const labels = options.labels || groups.map((_, i) => `Grupa ${i + 1}`);
  const cleaned = groups.map(cleanNumeric);
  if (cleaned.length < 2) return { error: 'ANOVA wymaga ≥2 grup.' };
  if (cleaned.some(g => g.length < 2)) return { error: 'Każda grupa wymaga ≥2 obserwacji.' };

  const k = cleaned.length;
  const all = cleaned.flat();
  const N = all.length;
  const grandMean = ss.mean(all);
  const ssBetween = cleaned.reduce((s, g) => s + g.length * Math.pow(ss.mean(g) - grandMean, 2), 0);
  const ssWithin  = cleaned.reduce((s, g) => {
    const gm = ss.mean(g);
    return s + g.reduce((acc, v) => acc + Math.pow(v - gm, 2), 0);
  }, 0);
  const dfBetween = k - 1;
  const dfWithin = N - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const F = msBetween / msWithin;
  const p = 1 - jstat.centralF.cdf(F, dfBetween, dfWithin);
  const etaSquared = ssBetween / (ssBetween + ssWithin);

  const group_stats = cleaned.map((g, i) => ({
    label: labels[i],
    n: g.length,
    mean: fmt(ss.mean(g)),
    sd: fmt(ss.sampleStandardDeviation(g)),
  }));

  // Tukey HSD post-hoc — pairwise comparisons using the studentized range
  // distribution. Only run if main effect is significant AND we have ≥3
  // groups (else just use t-test directly).
  let post_hoc = null;
  if (p < 0.05 && k >= 3 && jstat.tukey) {
    const tukeyQAt95 = jstat.tukey.inv(0.95, k, dfWithin); // critical q
    const pairs = [];
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const meanI = ss.mean(cleaned[i]);
        const meanJ = ss.mean(cleaned[j]);
        const diff = meanI - meanJ;
        const se = Math.sqrt(msWithin / 2 * (1 / cleaned[i].length + 1 / cleaned[j].length));
        const q = Math.abs(diff) / se;
        const pPair = 1 - jstat.tukey.cdf(q, k, dfWithin);
        const hsd = tukeyQAt95 * se;
        pairs.push({
          group_a: labels[i], group_b: labels[j],
          mean_diff: fmt(diff),
          q: fmt(q, 2),
          p: fmt(pPair, 4),
          ci95: [fmt(diff - hsd), fmt(diff + hsd)],
          significant: pPair < 0.05,
        });
      }
    }
    post_hoc = { method: 'Tukey HSD', pairs };
  }

  const levene = runLevene(cleaned);

  return {
    test: 'One-way ANOVA',
    F: fmt(F),
    df_between: dfBetween,
    df_within: dfWithin,
    p: fmt(p, 4),
    eta_squared: fmt(etaSquared),
    ss_between: fmt(ssBetween),
    ss_within: fmt(ssWithin),
    ms_between: fmt(msBetween),
    ms_within: fmt(msWithin),
    group_stats,
    post_hoc,
    assumption_equal_variance: levene,
    interpretation: `F(${dfBetween}, ${dfWithin}) = ${fmt(F, 2)}, ${pStr(p)}, η² = ${fmt(etaSquared, 3)}. ${p < 0.05 ? 'Istnieje istotna różnica między grupami.' : 'Brak istotnych różnic między grupami.'}`,
  };
}

// ── Chi-square test of independence ───────────────────────────────────────
function runChiSquareIndependence(observed) {
  // observed: 2D array (rows × cols)
  if (!Array.isArray(observed) || observed.length < 2) return { error: 'Tabela musi mieć ≥2 wiersze.' };
  if (!observed.every(r => Array.isArray(r) && r.length === observed[0].length)) return { error: 'Wiersze muszą mieć tę samą liczbę kolumn.' };
  if (observed[0].length < 2) return { error: 'Tabela musi mieć ≥2 kolumny.' };

  const rows = observed.length, cols = observed[0].length;
  const rowTotals = observed.map(r => r.reduce((a, b) => a + b, 0));
  const colTotals = Array.from({ length: cols }, (_, j) => observed.reduce((a, r) => a + r[j], 0));
  const total = rowTotals.reduce((a, b) => a + b, 0);

  const expected = observed.map((r, i) =>
    r.map((_, j) => (rowTotals[i] * colTotals[j]) / total)
  );

  let chi2 = 0;
  let lowExpected = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (expected[i][j] < 5) lowExpected++;
      if (expected[i][j] > 0) chi2 += Math.pow(observed[i][j] - expected[i][j], 2) / expected[i][j];
    }
  }
  const df = (rows - 1) * (cols - 1);
  const p = 1 - jstat.chisquare.cdf(chi2, df);
  // Cramér's V (effect size)
  const v = Math.sqrt(chi2 / (total * (Math.min(rows, cols) - 1)));

  return {
    test: 'Chi-square niezależności',
    chi2: fmt(chi2),
    df,
    p: fmt(p, 4),
    n: total,
    cramers_v: fmt(v),
    expected: expected.map(r => r.map(e => fmt(e, 1))),
    low_expected_cells: lowExpected,
    assumption_warning: lowExpected > 0 ? `${lowExpected} komórek ma oczekiwaną liczność < 5. Wynik może być zawodny — rozważ test dokładny Fishera (nie ma w aplikacji) lub konsolidację kategorii.` : null,
    interpretation: `χ²(${df}, N = ${total}) = ${fmt(chi2, 2)}, ${pStr(p)}, V Craméra = ${fmt(v, 3)}.`,
  };
}

// ── Pearson / Spearman correlation ────────────────────────────────────────
function runCorrelation(x, y, options = {}) {
  const method = options.method === 'spearman' ? 'spearman' : 'pearson';
  // Pair up — only keep where BOTH have numeric values
  const pairs = [];
  for (let i = 0; i < (x || []).length; i++) {
    const a = Number(x[i]), b = Number(y[i]);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  const n = pairs.length;
  if (n < 3) return { error: 'Korelacja wymaga ≥3 par obserwacji.' };
  const xs = pairs.map(p => p[0]); const ys = pairs.map(p => p[1]);

  let r;
  if (method === 'spearman') {
    // Rank-transform then Pearson
    const rank = arr => {
      const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const ranks = new Array(arr.length);
      let i = 0;
      while (i < sorted.length) {
        let j = i;
        while (j < sorted.length - 1 && sorted[j + 1].v === sorted[i].v) j++;
        const avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) ranks[sorted[k].i] = avgRank;
        i = j + 1;
      }
      return ranks;
    };
    r = ss.sampleCorrelation(rank(xs), rank(ys));
  } else {
    r = ss.sampleCorrelation(xs, ys);
  }
  // Significance (t-distribution)
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  const df = n - 2;
  const p = 2 * (1 - jstat.studentt.cdf(Math.abs(t), df));
  // Fisher z 95% CI for Pearson
  let ci = null;
  if (method === 'pearson' && Math.abs(r) < 1) {
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(n - 3);
    const zLo = z - 1.96 * se, zHi = z + 1.96 * se;
    ci = [
      fmt((Math.exp(2 * zLo) - 1) / (Math.exp(2 * zLo) + 1)),
      fmt((Math.exp(2 * zHi) - 1) / (Math.exp(2 * zHi) + 1)),
    ];
  }
  return {
    test: method === 'spearman' ? 'Korelacja Spearmana' : 'Korelacja Pearsona',
    method, r: fmt(r), n, df, p: fmt(p, 4),
    r_squared: fmt(r * r),
    ci95: ci,
    interpretation: `r${method === 'spearman' ? '_s' : ''} = ${fmt(r, 3)}, ${pStr(p)} (n = ${n}). ${Math.abs(r) < 0.1 ? 'Korelacja znikoma' : Math.abs(r) < 0.3 ? 'Korelacja słaba' : Math.abs(r) < 0.5 ? 'Korelacja umiarkowana' : Math.abs(r) < 0.7 ? 'Korelacja silna' : 'Korelacja bardzo silna'}.`,
  };
}

// Correlation matrix — symmetric N×N for an array of named numeric vars
function runCorrelationMatrix(variables) {
  // variables: [{name, values}]
  const names = variables.map(v => v.name);
  const matrix = names.map(() => names.map(() => null));
  const pvalues = names.map(() => names.map(() => null));
  for (let i = 0; i < variables.length; i++) {
    for (let j = i; j < variables.length; j++) {
      if (i === j) { matrix[i][j] = 1; pvalues[i][j] = 0; continue; }
      const c = runCorrelation(variables[i].values, variables[j].values);
      matrix[i][j] = matrix[j][i] = c.r;
      pvalues[i][j] = pvalues[j][i] = c.p;
    }
  }
  return { variables: names, r: matrix, p: pvalues };
}

// ── Simple linear regression: Y ~ X ────────────────────────────────────────
function runLinearRegression(x, y) {
  const pairs = [];
  for (let i = 0; i < (x || []).length; i++) {
    const a = Number(x[i]), b = Number(y[i]);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  if (pairs.length < 3) return { error: 'Regresja wymaga ≥3 obserwacji.' };
  const { m: slope, b: intercept } = ss.linearRegression(pairs);
  const r = ss.sampleCorrelation(pairs.map(p => p[0]), pairs.map(p => p[1]));
  const n = pairs.length;
  const yMean = ss.mean(pairs.map(p => p[1]));
  const ssTotal = pairs.reduce((s, p) => s + Math.pow(p[1] - yMean, 2), 0);
  const ssResidual = pairs.reduce((s, p) => s + Math.pow(p[1] - (intercept + slope * p[0]), 2), 0);
  const r2 = 1 - ssResidual / ssTotal;
  const xMean = ss.mean(pairs.map(p => p[0]));
  const sxx = pairs.reduce((s, p) => s + Math.pow(p[0] - xMean, 2), 0);
  const seSlope = Math.sqrt((ssResidual / (n - 2)) / sxx);
  const tSlope = slope / seSlope;
  const df = n - 2;
  const p = 2 * (1 - jstat.studentt.cdf(Math.abs(tSlope), df));
  const tcrit = jstat.studentt.inv(0.975, df);
  return {
    test: 'Regresja liniowa Y ~ X',
    n, slope: fmt(slope, 4), intercept: fmt(intercept, 4),
    r: fmt(r), r_squared: fmt(r2),
    slope_se: fmt(seSlope, 4),
    slope_t: fmt(tSlope, 2), df, slope_p: fmt(p, 4),
    slope_ci95: [fmt(slope - tcrit * seSlope, 4), fmt(slope + tcrit * seSlope, 4)],
    interpretation: `Y = ${fmt(intercept, 3)} + ${fmt(slope, 3)}·X. R² = ${fmt(r2, 3)}, t(${df}) = ${fmt(tSlope, 2)}, ${pStr(p)}.`,
  };
}

// ── Cronbach's alpha — internal consistency of a multi-item scale ─────────
function runCronbachAlpha(items) {
  // items: 2D — items[i] = column of values for item i (one row per case)
  // Compute across cases where ALL items have non-null values (listwise deletion)
  if (!items || items.length < 2) return { error: 'Alfa Cronbacha wymaga ≥2 pozycji.' };
  const k = items.length;
  const nCases = Math.min(...items.map(it => it.length));
  const matrix = []; // cases × items
  for (let c = 0; c < nCases; c++) {
    const row = [];
    let complete = true;
    for (let i = 0; i < k; i++) {
      const v = Number(items[i][c]);
      if (!Number.isFinite(v)) { complete = false; break; }
      row.push(v);
    }
    if (complete) matrix.push(row);
  }
  if (matrix.length < 2) return { error: 'Za mało kompletnych przypadków (n < 2).' };
  const n = matrix.length;
  const itemVars = []; for (let i = 0; i < k; i++) itemVars.push(ss.sampleVariance(matrix.map(r => r[i])));
  const totals = matrix.map(r => r.reduce((s, v) => s + v, 0));
  const totalVar = ss.sampleVariance(totals);
  const sumItemVar = itemVars.reduce((s, v) => s + v, 0);
  const alpha = (k / (k - 1)) * (1 - sumItemVar / totalVar);
  // Item-total corrections (alpha if item dropped)
  const if_item_deleted = [];
  for (let i = 0; i < k; i++) {
    const reducedItems = items.filter((_, idx) => idx !== i);
    const sub = runCronbachAlpha(reducedItems);
    if_item_deleted.push({ item_index: i, alpha_if_deleted: sub.alpha ?? null });
  }
  const reliability =
    alpha >= 0.9 ? 'doskonała' :
    alpha >= 0.8 ? 'dobra' :
    alpha >= 0.7 ? 'akceptowalna' :
    alpha >= 0.6 ? 'wątpliwa' :
    alpha >= 0.5 ? 'słaba' : 'nieakceptowalna';
  return {
    test: "Alfa Cronbacha",
    alpha: fmt(alpha),
    n_items: k, n_cases: n,
    item_variances: itemVars.map(v => fmt(v)),
    if_item_deleted,
    reliability,
    interpretation: `α = ${fmt(alpha, 3)} (${reliability}, k = ${k} pozycji, n = ${n} kompletnych przypadków).`,
  };
}

// ── Assumption checks ─────────────────────────────────────────────────────
// Normality heuristic via skewness + excess kurtosis.
// Rationale: exact Shapiro-Wilk requires hand-tabulated coefficients (Royston
// 1995) for small n to be reliable; approximations are notoriously off for
// n < 30 and we'd risk reporting misleading p-values. For a "quick-look"
// helper, the standard rule of thumb (|skew| < 2, |excess kurt| < 7 per
// Kline 2016; stricter |skew| < 1, |kurt| < 1 for "approximately normal")
// is more honest. Researchers needing publication-grade normality testing
// should run Shapiro-Wilk in R/SPSS.
function runNormalityCheck(values) {
  const x = cleanNumeric(values);
  const n = x.length;
  if (n < 3) return { error: 'Sprawdzenie normalności wymaga ≥3 obserwacji.' };
  const mean = ss.mean(x);
  const sd = ss.sampleStandardDeviation(x);
  if (sd === 0) return { test: 'Skewness/kurtosis', n, error: 'Brak zmienności (SD = 0).' };
  // Sample skewness (Fisher-Pearson)
  const skewness = (n / ((n - 1) * (n - 2))) *
    x.reduce((s, v) => s + Math.pow((v - mean) / sd, 3), 0);
  // Excess kurtosis (unbiased)
  const kurt4 = x.reduce((s, v) => s + Math.pow((v - mean) / sd, 4), 0);
  const excessKurt = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * kurt4 -
                     (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3));
  // Strict thresholds: |skew| < 1 and |excess kurt| < 1 → approximately normal
  // Liberal (Kline 2016): |skew| < 2 and |kurt| < 7
  const strictOk  = Math.abs(skewness) < 1 && Math.abs(excessKurt) < 1;
  const liberalOk = Math.abs(skewness) < 2 && Math.abs(excessKurt) < 7;
  const verdict = strictOk ? 'approximately normal'
                : liberalOk ? 'mild deviation from normal'
                : 'strong deviation from normal';
  return {
    test: 'Skewness / kurtosis (heurystyka)',
    n,
    skewness: fmt(skewness),
    excess_kurtosis: fmt(excessKurt),
    // "approximately_normal" uses Kline (2016) liberal threshold — the standard
    // for "this is acceptable for parametric tests". Strict threshold (|skew|<1,
    // |kurt|<1) is exposed separately for researchers who want stricter check.
    approximately_normal: liberalOk,
    strict_normal: strictOk,
    verdict,
    note: 'Do publikacji użyj Shapiro-Wilka w R/SPSS (`shapiro.test()`).',
  };
}

// Levene's test for equal variances (median-based, more robust)
function runLevene(groups) {
  const cleaned = groups.map(cleanNumeric).filter(g => g.length >= 2);
  if (cleaned.length < 2) return { error: 'Test Levene wymaga ≥2 grup po ≥2 obserwacje.' };
  const k = cleaned.length;
  // z_ij = |x_ij - median_i|
  const z = cleaned.map(g => {
    const med = ss.median(g);
    return g.map(v => Math.abs(v - med));
  });
  const N = z.reduce((s, g) => s + g.length, 0);
  const groupMeans = z.map(g => ss.mean(g));
  const grandMean = ss.mean(z.flat());
  const ssBetween = z.reduce((s, g, i) => s + g.length * Math.pow(groupMeans[i] - grandMean, 2), 0);
  const ssWithin = z.reduce((s, g, i) => s + g.reduce((acc, v) => acc + Math.pow(v - groupMeans[i], 2), 0), 0);
  const dfBetween = k - 1;
  const dfWithin = N - k;
  const F = (ssBetween / dfBetween) / (ssWithin / dfWithin);
  const p = 1 - jstat.centralF.cdf(F, dfBetween, dfWithin);
  return { test: 'Levene', F: fmt(F, 2), df1: dfBetween, df2: dfWithin, p: fmt(p, 4), equal_variances: p >= 0.05 };
}

module.exports = {
  runDescriptives,
  runTTest,
  runOneWayAnova,
  runChiSquareIndependence,
  runCorrelation,
  runCorrelationMatrix,
  runLinearRegression,
  runCronbachAlpha,
  runNormalityCheck,
  runLevene,
};
