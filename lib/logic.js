// ── Conditional logic core (validation + evaluation) ────────────────────────
// Pure, side-effect-free engine shared by the server (rule validation on save)
// and the participant runtime (rule evaluation during the study). Dual-mode:
// `require('./lib/logic')` on the server, `window.MisinfoLogic` in the browser.
//
// Rule shape (studies.logic_json = { version, rules: [rule] }):
//   rule = {
//     id, label, enabled: bool, priority: number,
//     timing: 'after_demographics' | 'after_part',
//     when:  { source: 'demographic'|'condition'|'post_question',
//              key: <field_key|question_id>, op, value },
//     action:{ type: 'skip_part'|'end_study', target_part_id?, message? },
//   }
// MVP is intentionally small and SAFE: skip_part cannot create loops (forward
// removal only), so the DAG guard is trivial today but the validator is written
// so a future goto_part cannot introduce cycles.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MisinfoLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SOURCES  = ['demographic', 'condition', 'post_question', 'reaction'];
  var OPS      = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'contains', 'empty', 'not_empty'];
  var TIMINGS  = ['after_demographics', 'after_part', 'after_interaction'];
  var ACTIONS  = ['skip_part', 'end_study', 'goto_part', 'hide_question'];

  // ── Condition evaluation ──────────────────────────────────────────────────
  // Compares a resolved participant value against the rule's op/value. Numeric
  // ops coerce both sides to Number; string ops compare case-insensitively.
  function compare(actual, op, expected) {
    if (op === 'empty')     return actual == null || String(actual).trim() === '';
    if (op === 'not_empty') return !(actual == null || String(actual).trim() === '');
    if (actual == null) return false; // any other op on a missing value → false
    if (op === 'contains') {
      if (Array.isArray(actual)) return actual.map(String).some(function (a) { return a.toLowerCase() === String(expected).toLowerCase(); });
      return String(actual).toLowerCase().indexOf(String(expected).toLowerCase()) !== -1;
    }
    if (op === 'eq' || op === 'ne') {
      // Prefer numeric equality when both look numeric, else string (case-insensitive).
      var an = Number(actual), en = Number(expected);
      var eq = (isFinite(an) && isFinite(en) && String(actual).trim() !== '' && String(expected).trim() !== '')
        ? an === en
        : String(actual).toLowerCase() === String(expected).toLowerCase();
      return op === 'eq' ? eq : !eq;
    }
    // Numeric comparisons.
    var a = Number(actual), e = Number(expected);
    if (!isFinite(a) || !isFinite(e)) return false;
    if (op === 'lt') return a < e;
    if (op === 'le') return a <= e;
    if (op === 'gt') return a > e;
    if (op === 'ge') return a >= e;
    return false;
  }

  // Resolve the participant value a rule's `when` refers to, from context.
  //   context = { demographics: {field_key: value}, condition: 'A',
  //               answers: {question_id: value} }
  function resolveActual(when, context) {
    context = context || {};
    switch (when.source) {
      case 'demographic':  return (context.demographics || {})[when.key];
      case 'condition':    return context.condition;
      case 'post_question':return (context.answers || {})[String(when.key)];
      case 'reaction':     return context.reactions; // array of action strings the participant used
      default:             return undefined;
    }
  }

  function ruleMatches(rule, context) {
    if (!rule || !rule.when) return false;
    return compare(resolveActual(rule.when, context), rule.when.op, rule.when.value);
  }

  // ── Evaluation ────────────────────────────────────────────────────────────
  // Evaluate all enabled rules for a given timing against the context.
  // Deterministic: sort by (priority asc, id asc). first-match semantics:
  // end_study and goto_part STOP evaluation (first wins); skip_part accumulate.
  // hide_question is handled separately (see hiddenQuestionIds) since hiding is a
  // render-time state, not a flow event.
  // Returns { end, message, endRuleId, goto, gotoRuleId, skipParts, firedRuleIds }.
  function evaluateRules(rules, context, timing) {
    var out = { end: false, message: null, endRuleId: null, goto: null, gotoRuleId: null, skipParts: [], firedRuleIds: [] };
    if (!Array.isArray(rules)) return out;
    var applicable = rules
      .filter(function (r) { return r && r.enabled !== false && r.timing === timing; })
      .slice()
      .sort(function (a, b) {
        var pa = Number(a.priority) || 0, pb = Number(b.priority) || 0;
        return pa !== pb ? pa - pb : String(a.id).localeCompare(String(b.id));
      });
    for (var i = 0; i < applicable.length; i++) {
      var rule = applicable[i];
      if (!ruleMatches(rule, context)) continue;
      out.firedRuleIds.push(rule.id);
      var act = rule.action || {};
      if (act.type === 'end_study') {
        out.end = true;
        out.message = act.message || null;
        out.endRuleId = rule.id;
        break; // end stops further evaluation
      } else if (act.type === 'goto_part') {
        out.goto = act.target_part_id || null;
        out.gotoRuleId = rule.id;
        break; // an explicit jump stops further evaluation (first wins)
      } else if (act.type === 'skip_part') {
        if (act.target_part_id && out.skipParts.indexOf(act.target_part_id) === -1) {
          out.skipParts.push(act.target_part_id);
        }
      }
      // hide_question is intentionally not applied here — see hiddenQuestionIds.
    }
    return out;
  }

  // Which questions should currently be hidden: every enabled hide_question rule
  // whose condition matches (any timing — hiding is a render-time state). Returns
  // an array of target_question_id strings.
  function hiddenQuestionIds(rules, context) {
    var ids = [];
    if (!Array.isArray(rules)) return ids;
    rules.forEach(function (r) {
      if (!r || r.enabled === false || !r.action || r.action.type !== 'hide_question') return;
      var qid = r.action.target_question_id;
      if (qid == null) return;
      if (ruleMatches(r, context) && ids.indexOf(String(qid)) === -1) ids.push(String(qid));
    });
    return ids;
  }

  // ── Validation (server, on save) ──────────────────────────────────────────
  // refs = { partIds: [], questionIds: [], demoFieldKeys: [] }
  // Returns { valid, errors: [], warnings: [] }. Errors block the save;
  // warnings are surfaced but allowed (e.g. potential confounding).
  function validateLogic(logic, refs) {
    refs = refs || {};
    var partIds  = new Set((refs.partIds || []).map(String));
    var qIds     = new Set((refs.questionIds || []).map(String));
    var demoKeys = new Set((refs.demoFieldKeys || []).map(String));
    var errors = [], warnings = [];

    if (logic == null) return { valid: true, errors: errors, warnings: warnings };
    if (typeof logic !== 'object' || !Array.isArray(logic.rules)) {
      return { valid: false, errors: ['logic_json musi mieć kształt { rules: [...] }'], warnings: warnings };
    }

    var seenIds = new Set();
    logic.rules.forEach(function (r, i) {
      var tag = 'Reguła ' + (i + 1) + (r && r.label ? ' („' + r.label + '")' : '');
      if (!r || typeof r !== 'object') { errors.push(tag + ': nieprawidłowy obiekt reguły'); return; }
      if (!r.id) errors.push(tag + ': brak id');
      else if (seenIds.has(String(r.id))) errors.push(tag + ': zduplikowane id „' + r.id + '"');
      else seenIds.add(String(r.id));
      if (!r.label) warnings.push(tag + ': brak etykiety (label)');
      if (TIMINGS.indexOf(r.timing) === -1) errors.push(tag + ': nieprawidłowy timing „' + r.timing + '"');

      var w = r.when || {};
      if (SOURCES.indexOf(w.source) === -1) errors.push(tag + ': nieprawidłowe źródło warunku „' + w.source + '"');
      if (OPS.indexOf(w.op) === -1) errors.push(tag + ': nieprawidłowy operator „' + w.op + '"');
      if (w.source === 'post_question') {
        if (w.key == null || !qIds.has(String(w.key))) errors.push(tag + ': warunek odwołuje się do nieistniejącego pytania (id ' + w.key + ')');
      } else if (w.source === 'demographic') {
        if (w.key == null || String(w.key).trim() === '') errors.push(tag + ': warunek demograficzny bez pola');
        else if (demoKeys.size && !demoKeys.has(String(w.key))) warnings.push(tag + ': pole demograficzne „' + w.key + '" nie występuje w tym badaniu');
      }
      if (['empty', 'not_empty'].indexOf(w.op) === -1 && (w.value == null || w.value === '')) {
        warnings.push(tag + ': pusta wartość porównania');
      }

      var a = r.action || {};
      if (ACTIONS.indexOf(a.type) === -1) errors.push(tag + ': nieprawidłowa akcja „' + a.type + '"');
      if (a.type === 'skip_part' || a.type === 'goto_part') {
        var actName = a.type === 'skip_part' ? 'pomiń część' : 'przejdź do części';
        if (a.target_part_id == null || !partIds.has(String(a.target_part_id))) {
          errors.push(tag + ': akcja „' + actName + '" wskazuje nieistniejącą część (id ' + a.target_part_id + ')');
        }
      }
      if (a.type === 'hide_question') {
        if (a.target_question_id == null || !qIds.has(String(a.target_question_id))) {
          errors.push(tag + ': akcja „ukryj pytanie" wskazuje nieistniejące pytanie (id ' + a.target_question_id + ')');
        }
      }

      // Methodological guardrail: branching flow on the assigned condition is
      // valid (condition-contingent visibility) but branching on a RESPONSE and
      // an end/skip can confound; warn when a response trigger ends the study.
      if ((w.source === 'post_question' || w.source === 'reaction') && (a.type === 'end_study' || a.type === 'goto_part')) {
        warnings.push(tag + ': zmiana przebiegu badania na podstawie zachowania uczestnika (odpowiedź/reakcja) może wpływać na dobór próby — upewnij się, że to zamierzone (np. test uwagi), a nie filtr zaburzający randomizację.');
      }
    });

    // goto_part can create loops (unlike forward-only skip_part). We can't build
    // a strict part-graph here (goto rules fire at a timing, not from a fixed
    // source part), so cycles are bounded at runtime by a per-session jump cap
    // (see participant.js). Here we only guarantee targets exist (checked above).

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  }

  function emptyLogic() { return { version: 1, rules: [] }; }

  return {
    SOURCES: SOURCES, OPS: OPS, TIMINGS: TIMINGS, ACTIONS: ACTIONS,
    compare: compare, ruleMatches: ruleMatches, evaluateRules: evaluateRules,
    hiddenQuestionIds: hiddenQuestionIds,
    validateLogic: validateLogic, emptyLogic: emptyLogic,
  };
});
