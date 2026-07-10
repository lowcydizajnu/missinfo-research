// Validation suite for routes/stats.js. Expected values verified against
// Python scipy.stats (no Yates correction for 2x2 chi²) and R's t.test
// (Welch by default). Run: `node routes/__tests__/stats.test.js`.
const stats = require('../stats.js');
const tol = 0.01;
const close = (a, b, t = tol) => Math.abs(a - b) < t;

const tests = [];
function check(label, ok) { tests.push([label, ok]); }

// Descriptives
{
  const r = stats.runDescriptives([1, 2, 3, 4, 5]);
  check('descriptives n=5', r.n === 5);
  check('descriptives mean=3', r.mean === 3);
  check('descriptives sd≈1.58', close(r.sd, 1.581));
}

// Welch t-test (independent samples)
// R: t.test(c(1,2,3,4,5), c(3,4,5,6,7)) → t=-2, df=8, p=0.08054
{
  const r = stats.runTTest([1,2,3,4,5], [3,4,5,6,7]);
  check('t indep stat=-2', close(r.t, -2));
  check('t indep df=8',    close(r.df, 8));
  check('t indep p≈0.081', close(r.p, 0.0805, 0.005));
  check("t indep cohen's d≈-1.265", close(r.cohens_d, -1.265, 0.01));
}

// Paired t-test
// R: t.test(c(2,4,3,5,7), c(1,2,3,4,5), paired=TRUE) → t=3.207, df=4, p=0.0327
{
  const r = stats.runTTest([2,4,3,5,7], [1,2,3,4,5], { paired: true });
  check('t paired stat≈3.207', close(r.t, 3.207));
  check('t paired df=4',       r.df === 4);
  check('t paired p≈0.033',    close(r.p, 0.0327, 0.005));
}

// One-way ANOVA
// R: summary(aov(c(1,2,3,3,4,5,5,6,7) ~ factor(rep(1:3, each=3))))
// → F=12, df1=2, df2=6, p=0.00802, η²=0.8
{
  const r = stats.runOneWayAnova([[1,2,3], [3,4,5], [5,6,7]]);
  check('ANOVA F=12',          r.F === 12);
  check('ANOVA df_between=2',  r.df_between === 2);
  check('ANOVA df_within=6',   r.df_within === 6);
  check('ANOVA p≈0.008',       close(r.p, 0.008, 0.001));
  check('ANOVA eta²=0.8',      r.eta_squared === 0.8);
  check('ANOVA Tukey 3 pairs', Array.isArray(r.post_hoc?.pairs) && r.post_hoc.pairs.length === 3);
}

// Chi-square (no Yates) — scipy.stats.chi2_contingency
{
  const r = stats.runChiSquareIndependence([[50, 30], [20, 40]]);
  check('χ²≈11.667',  close(r.chi2, 11.667));
  check('χ² df=1',    r.df === 1);
  check('χ² p≈0.0006', close(r.p, 0.0006, 0.0001));
  check('Cramér V≈0.289', close(r.cramers_v, 0.289, 0.01));
}

// Pearson correlation
// R: cor(c(1,2,3,4,5), c(2,4,5,4,5)) → r=0.7746
{
  const r = stats.runCorrelation([1,2,3,4,5], [2,4,5,4,5]);
  check('Pearson r≈0.7746', close(r.r, 0.7746));
}

// Spearman
{
  const r = stats.runCorrelation([1,2,3,4,5], [2,4,5,4,5], { method: 'spearman' });
  check('Spearman returns r', typeof r.r === 'number');
}

// Linear regression
// R: lm(c(2,4,5,4,5) ~ c(1,2,3,4,5)) → slope=0.6, intercept=2.2, R²=0.6
{
  const r = stats.runLinearRegression([1,2,3,4,5], [2,4,5,4,5]);
  check('lm slope=0.6',     close(r.slope, 0.6));
  check('lm intercept=2.2', close(r.intercept, 2.2));
  check('lm R²=0.6',        close(r.r_squared, 0.6));
}

// Cronbach's alpha
{
  const r = stats.runCronbachAlpha([
    [3,4,5,2,4,5,3,4],
    [3,4,5,2,4,5,3,4],
    [3,5,5,2,4,4,3,4],
  ]);
  check('Cronbach α > 0.9 (highly correlated items)', r.alpha > 0.9);
  check('Cronbach n_items=3', r.n_items === 3);
}

// Levene
{
  const r = stats.runLevene([[1,2,3,4,5], [10,20,30,40,50]]);
  check('Levene rejects equal var', r.p < 0.05);
  check('Levene equal_variances=false', r.equal_variances === false);
}

// Normality heuristic (skewness + excess kurtosis with rule-of-thumb thresholds)
{
  // Approximately normal — should pass strict threshold (|skew|<1, |kurt|<1)
  const r1 = stats.runNormalityCheck([1.2, 2.1, 3.0, 4.0, 4.9, 6.0, 6.9, 8.1, 9.0]);
  check('normality returns skewness',           typeof r1.skewness === 'number');
  check('normality flags normal data normal',   r1.approximately_normal === true);
  // Strongly skewed — should fail
  const r2 = stats.runNormalityCheck([1, 1, 1, 1, 1, 1, 1, 50, 100, 200]);
  check('normality flags skewed as not normal', r2.approximately_normal === false);
  check('normality verdict says strong dev',    r2.verdict.includes('strong'));
}

let pass = 0, fail = 0;
tests.forEach(([l, ok]) => { (ok ? pass++ : fail++); console.log((ok ? '✓' : '✗') + ' ' + l); });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
