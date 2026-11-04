'use strict';
// emLevels.js — THE E/M level table (AI coding pipeline spec, 2026-11-04, §3.1).
//
// One data file, and nothing else in the codebase holds these numbers. Each
// row is a code, the medical decision making it requires, and the total time
// on the date of the encounter that meets it. Times are THRESHOLDS to meet or
// exceed, not ranges; that has been the form since CPT 2024.
//
// The home-visit new-patient code that sat between 99342 and 99344 was deleted
// in the 2023 E/M revision. It must never appear in this file or anywhere else
// in the codebase, comments included (build-enforced in test/code_catalog.test.js).
//
// Phase 1 reads only `isHighestInFamily` (a scrub warning on a code a human
// chose). Level DERIVATION is Phase 3 and does not ship until the 2026-10-12
// "no code or E/M selection" decision is changed in writing.
//
// Verified 2026-11-04 against the sources in `verifiedAgainst`. CPT 2027 takes
// effect 2027-01-01, so this table has a known expiry: `nextReviewDue`.

const MDM = Object.freeze({
  STRAIGHTFORWARD: 'straightforward',
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high'
});

// Lowest level first within each family.
const FAMILIES = Object.freeze([
  Object.freeze({
    key: 'home_new', label: 'Home or residence, new patient',
    levels: Object.freeze([
      Object.freeze({ code: '99341', mdm: MDM.STRAIGHTFORWARD, minutes: 15 }),
      Object.freeze({ code: '99342', mdm: MDM.LOW, minutes: 30 }),
      Object.freeze({ code: '99344', mdm: MDM.MODERATE, minutes: 60 }),
      Object.freeze({ code: '99345', mdm: MDM.HIGH, minutes: 75 })
    ])
  }),
  Object.freeze({
    key: 'home_established', label: 'Home or residence, established patient',
    levels: Object.freeze([
      Object.freeze({ code: '99347', mdm: MDM.STRAIGHTFORWARD, minutes: 20 }),
      Object.freeze({ code: '99348', mdm: MDM.LOW, minutes: 30 }),
      Object.freeze({ code: '99349', mdm: MDM.MODERATE, minutes: 40 }),
      Object.freeze({ code: '99350', mdm: MDM.HIGH, minutes: 60 })
    ])
  }),
  Object.freeze({
    key: 'office_new', label: 'Office or other outpatient, new patient',
    levels: Object.freeze([
      Object.freeze({ code: '99202', mdm: MDM.STRAIGHTFORWARD, minutes: 15 }),
      Object.freeze({ code: '99203', mdm: MDM.LOW, minutes: 30 }),
      Object.freeze({ code: '99204', mdm: MDM.MODERATE, minutes: 45 }),
      Object.freeze({ code: '99205', mdm: MDM.HIGH, minutes: 60 })
    ])
  }),
  Object.freeze({
    key: 'office_established', label: 'Office or other outpatient, established patient',
    levels: Object.freeze([
      Object.freeze({ code: '99212', mdm: MDM.STRAIGHTFORWARD, minutes: 10 }),
      Object.freeze({ code: '99213', mdm: MDM.LOW, minutes: 20 }),
      Object.freeze({ code: '99214', mdm: MDM.MODERATE, minutes: 30 }),
      Object.freeze({ code: '99215', mdm: MDM.HIGH, minutes: 40 })
    ])
  })
]);

const verified = true;
const verifiedOn = '2026-11-04';
const verifiedAgainst = Object.freeze([
  'https://www.ama-assn.org/system/files/2023-e-m-descriptors-guidelines.pdf',
  'https://www.aafp.org/practice-operations/billing-and-coding/evaluation-management/time-and-medical-decision-making-levels-evaluation-and-management',
  'CMS PPRRVU2026 October non-QPP — all codes status A for 2026, the deleted home-visit new-patient code absent'
]);
const nextReviewDue = '2027-01-01';

const norm = (c) => String(c == null ? '' : c).trim().toUpperCase();

// The family a code belongs to, or null when it is not an E/M code in this table.
const familyOf = (code) => {
  const c = norm(code);
  return FAMILIES.find(f => f.levels.some(l => l.code === c)) || null;
};
const levelOf = (code) => {
  const f = familyOf(code);
  return f ? f.levels.find(l => l.code === norm(code)) : null;
};
const isEmCode = (code) => !!familyOf(code);
const isHighestInFamily = (code) => {
  const f = familyOf(code);
  return !!f && f.levels[f.levels.length - 1].code === norm(code);
};

// ---- Lookups for the level derivation (Phase 3). Nothing outside this file
// names a code or a minute threshold; callers ask by family and MDM level.
const MDM_ORDER = Object.freeze([MDM.STRAIGHTFORWARD, MDM.LOW, MDM.MODERATE, MDM.HIGH]);
const mdmRank = (m) => MDM_ORDER.indexOf(m);
const familyKeyFor = ({ setting, patientStatus }) => {
  const s = setting === 'office' ? 'office' : setting === 'home' ? 'home' : null;
  const p = patientStatus === 'new' ? 'new' : patientStatus === 'established' ? 'established' : null;
  return s && p ? `${s}_${p}` : null;
};
const familyByKey = (key) => FAMILIES.find(f => f.key === key) || null;
// The code a family bills at an MDM level.
const codeForMdm = (familyKey, mdm) => {
  const f = familyByKey(familyKey);
  const l = f && f.levels.find(x => x.mdm === mdm);
  return l ? l.code : null;
};
// The highest level whose time threshold the minutes meet or exceed, or null
// when they meet none. Thresholds, not ranges (CPT 2024 onward).
const levelForMinutes = (familyKey, minutes) => {
  const f = familyByKey(familyKey);
  const m = Number(minutes);
  if (!f || !Number.isFinite(m) || m <= 0) return null;
  const met = f.levels.filter(l => m >= l.minutes);
  return met.length ? met[met.length - 1] : null;
};
// The next level up in the family, for "within five minutes of the next
// threshold" (3b.5) and for stating what a candidate is below.
const nextLevelAbove = (code) => {
  const f = familyOf(code);
  if (!f) return null;
  const i = f.levels.findIndex(l => l.code === norm(code));
  return i >= 0 && i < f.levels.length - 1 ? f.levels[i + 1] : null;
};

// Whether the table is past its review date. Admin-hub and boot-log only:
// no clinician or coder ever sees a verification notice (spec §3.1).
const reviewStatus = (today = new Date().toISOString().slice(0, 10)) => ({
  file: 'emLevels.js', verifiedOn, nextReviewDue,
  overdue: String(today) >= nextReviewDue
});

module.exports = {
  MDM, MDM_ORDER, FAMILIES, verified, verifiedOn, verifiedAgainst, nextReviewDue,
  familyOf, levelOf, isEmCode, isHighestInFamily, reviewStatus,
  mdmRank, familyKeyFor, familyByKey, codeForMdm, levelForMinutes, nextLevelAbove
};
