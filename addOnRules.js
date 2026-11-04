'use strict';
// addOnRules.js — add-on codes and modifiers (AI coding pipeline spec,
// 2026-11-04, Phase 4.2). Deterministic, no model. PURE: the claim scrub calls
// it with what it already holds.
//
// Three kinds of answer:
//   - a BLOCK finding: the claim as coded breaks the rule;
//   - a WARN finding: it releases, and a person should look;
//   - an OFFER: something billing may add. AN OFFER IS NEVER APPLIED. Nothing in
//     this file changes a line; a person adds the code or modifier through the
//     coding screen, or does not.
//
// 59, XE, XS, XP and XU are NEVER offered (spec 4.2), and neither they nor 25
// may sit on a line without the rendering clinician's recorded justification.
//
// SOURCES (spec 4.3). These rules encode payment policy, not published
// numbers, so a coder confirms them at the first audit and the January review
// reconciles them against the CPT book:
//   CMS MLN, Evaluation and Management Services (MLN006764, May 2026):
//     https://www.cms.gov/outreach-and-education/medicare-learning-network-mln/mlnproducts/downloads/eval-mgmt-serv-guide-icn006764.pdf
//   CMS MLN Matters MM13473, the visit complexity add-on G2211:
//     https://www.cms.gov/files/document/mm13473-how-use-office-and-outpatient-evaluation-and-management-visit-complexity-add-code-g2211.pdf
//   CMS MLN, Telehealth Services (modifiers 95 and 93):
//     https://www.cms.gov/files/document/mln901705-telehealth-services.pdf
//   CMS, Medicare NCCI Policy Manual (modifiers 25, 59 and the X modifiers):
//     https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-policy-manual
//   CMS MLN, Medicare Wellness Visits:
//     https://www.cms.gov/outreach-and-education/medicare-learning-network-mln/mlnproducts/preventive-services/medicare-wellness-visits.html
//   Noridian, Transitional Care Management (see serviceRules/transitionalCare.js).

const emLevels = require('./emLevels');
const transitionalCare = require('./serviceRules/transitionalCare');
const annualWellness = require('./serviceRules/annualWellness');
const psychotherapy = require('./serviceRules/psychotherapy');
const healthBehavior = require('./serviceRules/healthBehavior');
const advanceCarePlanning = require('./serviceRules/advanceCarePlanning');
const chronicCare = require('./serviceRules/chronicCare');
const behavioralIntegration = require('./serviceRules/behavioralIntegration');
const remoteMonitoring = require('./serviceRules/remoteMonitoring');

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

// G2211, the visit complexity add-on. MLN006764 "HCPCS Add-On Code G2211":
// reported with the office E/M codes and, from 2026-01-01, the home or
// residence codes; for an ongoing relationship where the practitioner is the
// continuing focal point for all needed services. "HCPCS Code G2211 &
// Modifier 25": not paid when the base E/M carries modifier 25, except on the
// same day as an AWV, a vaccine administration or a Part B preventive service.
const G2211 = 'G2211';
// G0318, prolonged home or residence E/M. MLN006764 Table 4: reported only with
// the highest home level, only when the level was selected using TIME, once
// total time reaches the threshold, and each further 15 minutes. CMS's
// thresholds: 140 minutes for the new-patient top level, 110 for the
// established. (The spec draft said 140 for both; CMS's table is the source.)
// CMS counts time from 3 days before to 7 days after the visit; this app holds
// the date of service only, so it counts less, never more.
const G0318 = Object.freeze({
  code: 'G0318', step: 15,
  thresholdByBase: Object.freeze(Object.fromEntries(emLevels.FAMILIES
    .filter(f => f.key.startsWith('home_'))
    .map(f => [f.levels[f.levels.length - 1].code, f.key === 'home_new' ? 140 : 110])))
});
const MOD = Object.freeze({ M25: '25', M95: '95', M93: '93' });
// Never offered; clinician-entered only, with documentation (spec 4.2).
const DISTINCT_PROCEDURAL = Object.freeze(['59', 'XE', 'XS', 'XP', 'XU']);
const NEEDS_JUSTIFICATION = Object.freeze([MOD.M25, ...DISTINCT_PROCEDURAL]);

// Codes that ride on another service rather than standing as one: they never
// make a same-date service "separately identifiable" for modifier 25.
const ADD_ON_CODES = new Set([G2211, G0318.code, ...psychotherapy.ADD_ONS, psychotherapy.INTERACTIVE_COMPLEXITY, psychotherapy.CRISIS.addOn,
  ...Object.values(healthBehavior.INTERVENTIONS).map(x => x.addOn), advanceCarePlanning.ADD_ON.code,
  chronicCare.STAFF.addOn, chronicCare.STAFF_COMPLEX.addOn, chronicCare.PRACTITIONER.addOn, ...chronicCare.APCM_ADD_ONS,
  behavioralIntegration.COCM.addOn, remoteMonitoring.RPM.management.addOn, remoteMonitoring.RTM.management.addOn]);
const isHomeOrOfficeEm = (c) => !!emLevels.familyOf(c);
const isOfficeEm = (c) => { const f = emLevels.familyOf(c); return !!f && f.key.startsWith('office_'); };

// input: { lines, visit, emDerivation, totalMinutes, continuingCare, justifications,
//          tcm, priorAwvDates, dos, sameDayOtherCodes }
const evaluate = (input = {}) => {
  const findings = []; const offers = [];
  const add = (severity, code, field, fieldLabel, message) => findings.push({ severity, code, field, fieldLabel, message });
  const offer = (code, kind, target, message, extra) => offers.push({ code, kind, target, message, ...(extra || {}) });
  const lines = (Array.isArray(input.lines) ? input.lines : []).filter(Boolean);
  const codes = lines.map(l => upper(l.code));
  const modsOf = (l) => (Array.isArray(l.modifiers) ? l.modifiers : []).map(upper);
  const emIdx = lines.findIndex(l => isHomeOrOfficeEm(l.code));
  const em = emIdx >= 0 ? lines[emIdx] : null;
  const label = (i) => `Line ${i + 1} (${upper(lines[i].code)})`;
  const visit = input.visit || {};
  const sameDay = (Array.isArray(input.sameDayOtherCodes) ? input.sameDayOtherCodes : []).map(upper);
  const awvHere = codes.some(c => annualWellness.CODES.includes(c)) || sameDay.some(c => annualWellness.CODES.includes(c));
  const separateService = [...codes, ...sameDay].some(c => c && !isHomeOrOfficeEm(c) && !ADD_ON_CODES.has(c));

  // ---- G2211 ----
  const g2211At = codes.indexOf(G2211);
  if (g2211At >= 0) {
    if (!em) add('block', 'G2211_WITHOUT_BASE', `lines[${g2211At}].code`, `${label(g2211At)}`, 'G2211 is billed without a home or office E/M visit to add it to.');
    else if (modsOf(em).includes(MOD.M25) && !(awvHere && isOfficeEm(em.code))) {
      add('block', 'G2211_WITH_MODIFIER_25', `lines[${g2211At}].code`, `${label(g2211At)}`,
        `G2211 is billed with ${upper(em.code)}-25. Medicare does not pay G2211 when its base visit carries modifier 25, except beside an AWV, a vaccine or a Part B preventive service on an office visit.`);
    }
  } else if (em && input.continuingCare && !(modsOf(em).includes(MOD.M25) && !(awvHere && isOfficeEm(em.code)))) {
    offer(G2211, 'add_on', upper(em.code), `G2211 may apply: GFC is this patient's continuing source of care. Add it only if the note supports the ongoing relationship.`);
  }

  // ---- G0318 ----
  const g0318At = codes.indexOf(G0318.code);
  const base = em ? upper(em.code) : null;
  const threshold = base ? G0318.thresholdByBase[base] : undefined;
  const der = input.emDerivation;
  const byTime = !!(der && der.finalBasis === 'time' && der.finalCode && upper(der.finalCode) === base);
  const total = Number(input.totalMinutes);
  const allowed = threshold && byTime && Number.isFinite(total) && total >= threshold ? 1 + Math.floor((total - threshold) / G0318.step) : 0;
  if (g0318At >= 0) {
    const units = Number(lines[g0318At].units) > 0 ? Number(lines[g0318At].units) : 1;
    if (!threshold) add('block', 'G0318_WRONG_BASE', `lines[${g0318At}].code`, label(g0318At), 'G0318 is billed without the highest home or residence E/M level to add it to.');
    else if (!byTime) add('block', 'G0318_NOT_BY_TIME', `lines[${g0318At}].code`, label(g0318At), `G0318 is billed, and ${base} was not selected by time.`);
    else if (!allowed) add('block', 'G0318_UNDER_THRESHOLD', `lines[${g0318At}].units`, label(g0318At), `G0318 is billed, and the total time documented (${Number.isFinite(total) ? total : 'none'} minutes) does not reach ${threshold}.`);
    else if (units > allowed) add('block', 'G0318_TOO_MANY_UNITS', `lines[${g0318At}].units`, label(g0318At), `G0318 is billed at ${units} units; ${total} minutes supports ${allowed}.`);
  } else if (allowed) {
    offer(G0318.code, 'add_on', base, `G0318 × ${allowed} may apply: ${base} was selected by time and ${total} minutes are documented.`, { units: allowed });
  }

  // ---- modifier 25: offered, never applied; justification recorded ----
  if (em && !modsOf(em).includes(MOD.M25) && (awvHere || separateService)) {
    offer(MOD.M25, 'modifier', upper(em.code), `Modifier 25 may apply to ${upper(em.code)}: ${awvHere ? 'an AWV' : 'another service'} shares the date. Add it only if the E/M was significant and separately identifiable, and the clinician records why.`);
  }
  const just = input.justifications || {};
  lines.forEach((l, i) => {
    for (const m of modsOf(l).filter(x => NEEDS_JUSTIFICATION.includes(x))) {
      const key = `${upper(l.code)}-${m}`;
      if (!just[key] || !String(just[key].text || '').trim()) {
        add('block', 'MODIFIER_NOT_JUSTIFIED', `lines[${i}].modifiers`, `${label(i)}: modifier ${m}`,
          `Modifier ${m} is on ${upper(l.code)}, and the rendering clinician has not recorded why.`);
      }
    }
  });

  // ---- modifier 95 is applied automatically for audio-video telehealth, as
  // before (clinicalRepository.modifiersForCharge). Modifier 93 is offered for
  // audio-only, never applied.
  if (visit.modality === 'phone') {
    lines.forEach((l) => {
      if (!modsOf(l).includes(MOD.M93) && !ADD_ON_CODES.has(upper(l.code))) {
        offer(MOD.M93, 'modifier', upper(l.code), `Modifier 93 may apply to ${upper(l.code)}: this visit was audio-only.`);
      }
    });
  }

  // ---- TCM: the dates in the chart must support the code billed ----
  lines.forEach((l, i) => {
    const c = upper(l.code);
    if (!transitionalCare.CODES.includes(c)) return;
    const t = input.tcm || {};
    const r = transitionalCare.select({
      dischargeDate: t.dischargeDate, contactDate: t.contactDate,
      faceToFaceDate: t.faceToFaceDate || input.dos,
      complexity: t.complexity || (der && der.mdm && der.mdm.level) || null
    });
    const supported = r.codes.length ? r.codes[0].code : null;
    if (supported !== c) {
      add('block', 'TCM_DATES_DO_NOT_SUPPORT', `lines[${i}].code`, label(i),
        `${c} is billed. ${supported ? `The dates and complexity on record support ${supported}.` : r.explanation}`);
    }
  });

  // ---- AWV: once per lifetime, then once per 12 months; another practice's
  // claim is not in GFC's records ----
  lines.forEach((l, i) => {
    const c = upper(l.code);
    if (!annualWellness.CODES.includes(c)) return;
    const r = annualWellness.select({ dos: input.dos, priorAwvDates: input.priorAwvDates });
    const supported = r.codes.length ? r.codes[0].code : null;
    if (supported !== c) {
      add('warn', 'AWV_HISTORY', `lines[${i}].code`, label(i),
        `${c} is billed. ${supported ? `GFC's records support ${supported}.` : r.explanation} ${annualWellness.OTHER_PRACTICE}`);
    }
  });

  return { findings, offers };
};

module.exports = { G2211, G0318, MOD, DISTINCT_PROCEDURAL, NEEDS_JUSTIFICATION, ADD_ON_CODES, evaluate };
