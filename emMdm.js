'use strict';
// emMdm.js — E/M level derivation from CONFIRMED facts (AI coding pipeline
// spec, 2026-11-04, Phase 3). Rules, no model.
//
// The model (Phase 2) extracted facts; the clinician confirmed them; this file
// decides. It never names a code or a minute threshold itself: those live in
// emLevels.js and nowhere else. It works in MDM levels and asks emLevels which
// code a family bills at that level.
//
// THE FRAMEWORK. Implemented from AMA, "CPT Evaluation and Management (E/M)
// Code and Guideline Changes", Table 1: Levels of Medical Decision Making,
//   https://www.ama-assn.org/system/files/2023-e-m-descriptors-guidelines.pdf
// The level of MDM is the highest level met or exceeded by at least 2 of the 3
// elements: problems addressed, data reviewed and analyzed, and risk.
//
// CONSERVATIVE ON THE WIRE, VISIBLE IN THE QUEUE. Where the confirmed facts do
// not say enough to score an element higher, it is scored lower and the
// missing evidence is recorded AS AN ABSENCE ("the note does not state…"),
// never as advice about what to document. A LEVEL_AMBIGUOUS flag is raised
// only when that missing evidence could change the final level, or when the
// MDM and time candidates disagree. The flag is the coder's, never the
// clinician's.

const emLevels = require('./emLevels');

const { MDM } = emLevels;
const LEVEL_LABEL = Object.freeze({
  [MDM.STRAIGHTFORWARD]: 'straightforward', [MDM.LOW]: 'low', [MDM.MODERATE]: 'moderate', [MDM.HIGH]: 'high'
});
// AMA's own names for each element's levels.
const DATA_LABEL = Object.freeze({
  [MDM.STRAIGHTFORWARD]: 'minimal or none', [MDM.LOW]: 'limited', [MDM.MODERATE]: 'moderate', [MDM.HIGH]: 'extensive'
});
const RISK_LABEL = Object.freeze({
  [MDM.STRAIGHTFORWARD]: 'minimal', [MDM.LOW]: 'low', [MDM.MODERATE]: 'moderate', [MDM.HIGH]: 'high'
});
const PROBLEM_LABEL = Object.freeze({
  [MDM.STRAIGHTFORWARD]: 'minimal', [MDM.LOW]: 'low', [MDM.MODERATE]: 'moderate', [MDM.HIGH]: 'high'
});

const rank = emLevels.mdmRank;
const maxLevel = (...ls) => ls.reduce((a, b) => (rank(b) > rank(a) ? b : a), MDM.STRAIGHTFORWARD);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const str = (v) => (v == null ? '' : String(v).trim());

// ---- Element 1: number and complexity of problems addressed ----------------
// AMA Table 1, column "Number and Complexity of Problems Addressed at the
// Encounter", https://www.ama-assn.org/system/files/2023-e-m-descriptors-guidelines.pdf
//   Minimal:  1 self-limited or minor problem
//   Low:      2+ self-limited or minor; or 1 stable chronic illness; or 1 acute
//             uncomplicated illness or injury
//   Moderate: 1+ chronic illness with exacerbation, progression or side
//             effects of treatment; or 2+ stable chronic illnesses; or 1
//             undiagnosed new problem with uncertain prognosis; or …
//   High:     1+ chronic illness with SEVERE exacerbation…; or 1 acute or
//             chronic illness that poses a threat to life or bodily function
// Mapping from the confirmed status (the confirmation screen labels each in
// these terms, so the clinician confirms the AMA meaning, not a guess at it):
//   stable    → a stable chronic illness
//   worsening → a chronic illness with exacerbation, progression or side
//               effects. NOT "severe": the facts cannot say severe, so High is
//               never reached from problems, and the absence is recorded.
//   new       → an acute uncomplicated problem (Low). Whether the prognosis is
//               uncertain is not stated, so Moderate is not credited.
//   resolved  → a self-limited or minor problem
//   unclear   → not counted
const scoreProblems = (problems) => {
  const list = Array.isArray(problems) ? problems.filter(Boolean) : [];
  const by = (s) => list.filter(p => p.status === s);
  const W = by('worsening'); const S = by('stable'); const N = by('new'); const R = by('resolved'); const U = by('unclear');
  let level = MDM.STRAIGHTFORWARD; let because = list.length ? 'self-limited or minor problems only' : 'no problem addressed is recorded';
  if (S.length === 1 || N.length >= 1 || R.length >= 2) {
    level = MDM.LOW;
    because = S.length === 1 ? 'one stable chronic illness' : N.length ? plural(N.length, 'new problem', 'new problems') : 'two or more self-limited or minor problems';
  }
  if (W.length >= 1 || S.length >= 2) {
    level = MDM.MODERATE;
    because = W.length ? plural(W.length, 'chronic illness that is worsening', 'chronic illnesses that are worsening') : `${S.length} stable chronic illnesses`;
  }
  // What the facts could support if what is missing were present.
  let possible = level; const absent = [];
  for (const p of N) { possible = maxLevel(possible, MDM.MODERATE); absent.push(`The note does not state whether the new problem "${str(p.description)}" has an uncertain prognosis.`); }
  for (const p of W) { possible = maxLevel(possible, MDM.HIGH); absent.push(`The note does not state whether the worsening of "${str(p.description)}" is a severe exacerbation or a threat to life or bodily function.`); }
  for (const p of U) { possible = maxLevel(possible, MDM.MODERATE); absent.push(`The note does not make clear whether "${str(p.description)}" was stable, worsening, new or resolved.`); }
  return { element: 'problems', level, label: PROBLEM_LABEL[level], because, possible, absent, facts: list };
};

// ---- Element 2: amount and/or complexity of data reviewed and analyzed ----
// AMA Table 1, column "Amount and/or Complexity of Data to be Reviewed and
// Analyzed", https://www.ama-assn.org/system/files/2023-e-m-descriptors-guidelines.pdf
//   Limited (Low): at least 1 of 2 categories —
//     Cat 1: any combination of 2 from: review of prior external note(s) from
//            each unique source; review of the result(s) of each unique test;
//            ordering of each unique test
//     Cat 2: assessment requiring an independent historian
//   Moderate: at least 1 of 3 categories —
//     Cat 1: any combination of 3 from the Cat 1 list above PLUS assessment
//            requiring an independent historian
//     Cat 2: independent interpretation of a test performed by another
//            physician/QHP (not separately reported)
//     Cat 3: discussion of management or test interpretation with an external
//            physician/QHP/appropriate source (not separately reported)
//   Extensive (High): at least 2 of the 3 Moderate categories.
// Mapping: lab and imaging (results reviewed or tests ordered) and
// outside_record count as Cat 1 items, each unique one once. A prior_note is a
// GFC note, not an EXTERNAL one, so it does not count; the absence is recorded.
const dataKey = (d) => `${d.kind}|${str(d.detail).toLowerCase().replace(/\s+/g, ' ')}`;
const scoreData = (data) => {
  const list = Array.isArray(data) ? data.filter(Boolean) : [];
  const uniq = (kinds) => new Set(list.filter(d => kinds.includes(d.kind)).map(dataKey)).size;
  const cat1Items = uniq(['lab', 'imaging', 'outside_record']);
  const historian = uniq(['independent_historian']);
  const interp = uniq(['test_interpretation']);
  const discussion = uniq(['discussion_with_clinician']);
  const priorNotes = list.filter(d => d.kind === 'prior_note');
  const levelFor = (c1) => {
    const modCats = [(c1 + historian) >= 3, interp >= 1, discussion >= 1].filter(Boolean).length;
    if (modCats >= 2) return MDM.HIGH;
    if (modCats >= 1) return MDM.MODERATE;
    if (c1 >= 2 || historian >= 1) return MDM.LOW;
    return MDM.STRAIGHTFORWARD;
  };
  const level = levelFor(cat1Items);
  const parts = [];
  if (cat1Items) parts.push(plural(cat1Items, 'unique note, result or test', 'unique notes, results or tests'));
  if (historian) parts.push('an independent historian');
  if (interp) parts.push('an independent interpretation of a test');
  if (discussion) parts.push('a discussion with another clinician');
  const absent = [];
  let possible = level;
  if (priorNotes.length) {
    possible = maxLevel(possible, levelFor(cat1Items + new Set(priorNotes.map(dataKey)).size));
    absent.push(`The note records review of ${plural(priorNotes.length, 'prior note', 'prior notes')} without stating it came from an outside source, so it is not counted as an external note.`);
  }
  return { element: 'data', level, label: DATA_LABEL[level], because: parts.length ? parts.join(', ') : 'no data reviewed is recorded', possible, absent, facts: list };
};

// ---- Element 3: risk of complications and/or morbidity or mortality --------
// AMA Table 1, column "Risk of Complications and/or Morbidity or Mortality of
// Patient Management", https://www.ama-assn.org/system/files/2023-e-m-descriptors-guidelines.pdf
//   Moderate, examples: prescription drug management; decision regarding minor
//     surgery with identified patient or procedure risk factors; decision
//     regarding elective major surgery without identified risk factors;
//     diagnosis or treatment significantly limited by social determinants
//   High, examples: drug therapy requiring intensive monitoring for toxicity;
//     decision regarding elective major surgery with identified risk factors;
//     decision regarding emergency major surgery; decision regarding
//     hospitalization or escalation of hospital-level care; decision not to
//     resuscitate or to de-escalate care because of poor prognosis;
//     parenteral controlled substances
// Mapping: prescription_management and social_determinants → moderate;
// drug_therapy_monitoring and decision_re_hospitalization → high;
// decision_re_surgery → moderate (minor or major, and risk factors, are not
// stated); otc_management → low; other → minimal, recorded as unclassified.
const RISK_LEVEL = Object.freeze({
  prescription_management: MDM.MODERATE, social_determinants: MDM.MODERATE,
  drug_therapy_monitoring: MDM.HIGH, decision_re_hospitalization: MDM.HIGH,
  decision_re_surgery: MDM.MODERATE, otc_management: MDM.LOW, other: MDM.STRAIGHTFORWARD
});
const RISK_WORDS = Object.freeze({
  prescription_management: 'prescription drug management', social_determinants: 'care limited by social determinants of health',
  drug_therapy_monitoring: 'drug therapy requiring intensive monitoring for toxicity', decision_re_hospitalization: 'a decision about hospitalization',
  decision_re_surgery: 'a decision about surgery', otc_management: 'over-the-counter drug management', other: 'another risk factor'
});
const scoreRisk = (risk) => {
  const list = Array.isArray(risk) ? risk.filter(Boolean) : [];
  let level = MDM.STRAIGHTFORWARD; let top = null;
  for (const r of list) {
    const l = RISK_LEVEL[r.factor] || MDM.STRAIGHTFORWARD;
    if (rank(l) > rank(level)) { level = l; top = r; }
  }
  let possible = level; const absent = [];
  for (const r of list.filter(x => x.factor === 'decision_re_surgery')) {
    possible = maxLevel(possible, MDM.HIGH);
    absent.push(`The note does not state whether the surgery decision ("${str(r.detail)}") concerned minor or major surgery, or whether patient or procedure risk factors were identified.`);
  }
  for (const r of list.filter(x => x.factor === 'other')) {
    possible = maxLevel(possible, MDM.MODERATE);
    absent.push(`The risk factor "${str(r.detail)}" is not one of the named categories, so it is not scored.`);
  }
  return { element: 'risk', level, label: RISK_LABEL[level], because: top ? RISK_WORDS[top.factor] : 'no risk factor is recorded', possible, absent, facts: list };
};

// The highest level met or exceeded by at least 2 of the 3 elements.
const mdmFromElements = (levels) => {
  const sorted = levels.slice().sort((a, b) => rank(b) - rank(a));
  return sorted[1];
};

// ---- The derivation ---------------------------------------------------------
// facts: the CONFIRMED facts, shaped like the Phase 2 output.
// setting: 'home' | 'office' (appointmentTypes.resolveCodeFamily decides it).
// patientStatus: 'new' | 'established'.
// chooseTime / affirmTime: the clinician asked for the time-based level and
//   affirmed the time explicitly (spec §3.3).
// context: { enteredMinutes, statusConflict } facts the server knows about
//   the encounter, stated in the flag when they disagree with the note.
const deriveLevel = ({ facts, setting, patientStatus, chooseTime = false, affirmTime = false, context = {} }) => {
  const familyKey = emLevels.familyKeyFor({ setting, patientStatus });
  const family = familyKey ? emLevels.familyByKey(familyKey) : null;
  if (!family) return { error: 'This visit is not a home or office E/M visit, so there is no E/M level to derive.', code: 'EM_NO_FAMILY' };
  const f = facts || {};
  const elements = [scoreProblems(f.problemsAddressed), scoreData(f.dataReviewed), scoreRisk(f.risk)];
  const mdm = mdmFromElements(elements.map(e => e.level));
  const mdmCode = emLevels.codeForMdm(familyKey, mdm);

  const t = f.time || {};
  const minutes = t.statementPresent && Number.isFinite(Number(t.totalMinutes)) && Number(t.totalMinutes) > 0 ? Math.round(Number(t.totalMinutes)) : null;
  const timeLevel = minutes != null ? emLevels.levelForMinutes(familyKey, minutes) : null;
  const timeCode = timeLevel ? timeLevel.code : null;

  const indexOf = (code) => family.levels.findIndex(l => l.code === code);
  const candidates = [{ basis: 'mdm', code: mdmCode, mdm }];
  if (timeCode) candidates.push({ basis: 'time', code: timeCode, minutes });
  // The lower by default.
  const def = timeCode && indexOf(timeCode) < indexOf(mdmCode) ? candidates[1] : candidates[0];
  const timeIsHigher = !!timeCode && indexOf(timeCode) > indexOf(mdmCode);

  let final = def;
  if (chooseTime) {
    if (!timeIsHigher) return { error: 'The time-based level is not higher than the one medical decision making supports, so there is nothing to choose.', code: 'EM_TIME_NOT_HIGHER' };
    if (!affirmTime) return { error: 'Choosing the level by time needs you to affirm the total time explicitly.', code: 'EM_TIME_NOT_AFFIRMED' };
    final = candidates[1];
  }

  // ---- the review flag ----
  const absent = [];
  const reasons = [];
  if (timeCode && timeCode !== mdmCode) reasons.push('candidates_disagree');
  const possibleMdm = mdmFromElements(elements.map(e => e.possible));
  if (rank(possibleMdm) > rank(mdm)) {
    reasons.push('thin_evidence');
    for (const e of elements) if (rank(e.possible) > rank(e.level)) absent.push(...e.absent);
  }
  if (minutes == null) absent.push('No total time is stated in the note.');
  if (context.enteredMinutes && minutes != null && Number(context.enteredMinutes) !== minutes) {
    reasons.push('time_disagrees');
    absent.push(`The total time entered at signing (${Number(context.enteredMinutes)} minutes) is not the time stated in the note (${minutes} minutes).`);
  }
  if (context.statusConflict) { reasons.push('patient_status'); absent.push(context.statusConflict); }
  const flag = reasons.length ? {
    code: 'LEVEL_AMBIGUOUS', reasons,
    candidates: candidates.map(c => ({ ...c })),
    elements: elements.map(e => ({ element: e.element, level: e.level, because: e.because, facts: e.facts.map(x => ({ ...x })) })),
    absent: [...new Set(absent)]
  } : null;

  return {
    familyKey, familyLabel: family.label,
    elements: elements.map(e => ({ element: e.element, level: e.level, label: e.label, because: e.because })),
    mdm: { level: mdm, code: mdmCode },
    time: { minutes, statementPresent: !!t.statementPresent, code: timeCode },
    candidates, defaultCode: def.code, defaultBasis: def.basis,
    finalCode: final.code, finalBasis: final.basis, override: final !== def,
    explanation: explain({ final, elements, mdm, family }),
    flag
  };
};

// The plain-language sentence the clinician reads after confirming. It says
// how the code was reached. It never mentions a dollar amount, and it never
// says what would have reached a different code.
const explain = ({ final, elements, mdm, family }) => {
  if (final.basis === 'time') {
    return `${final.code} was reached from total time: ${final.minutes} minutes on the date of service, as stated in the note (${family.label}).`;
  }
  const [p, d, r] = elements;
  const met = elements.filter(e => rank(e.level) >= rank(mdm)).map(e => e.element);
  return `${final.code} was reached from medical decision making, which was ${LEVEL_LABEL[mdm]} (${family.label}). ` +
    `Problems addressed: ${p.label} (${p.because}). Data reviewed: ${d.label} (${d.because}). Risk: ${r.label} (${r.because}). ` +
    `The level is the highest that two of the three meet; here ${met.join(' and ')} ${met.length === 1 ? 'meets' : 'meet'} it.`;
};

module.exports = {
  LEVEL_LABEL, RISK_LEVEL,
  scoreProblems, scoreData, scoreRisk, mdmFromElements, deriveLevel, explain
};
