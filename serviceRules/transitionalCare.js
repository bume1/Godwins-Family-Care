'use strict';
// serviceRules/transitionalCare.js — transitional care management (spec 3b.3).
//
// SOURCES (3b.6):
//   Noridian, Transitional Care Management:
//     https://med.noridianmedicare.com/web/jeb/specialties/care-coordination/transitional-care-management-tcm
//   Code validity for 2026: CMS PPRRVU2026 October non-QPP file.
// Both codes need an interactive contact within 2 business days of discharge,
// counting the first business day after discharge as day one. 99495: moderate
// complexity and a face-to-face inside 14 days. 99496: high complexity and a
// face-to-face inside 7 days. Both day counts begin on the discharge date.
// Federal holidays are not modelled; a weekend is.
const { PROVENANCE, chosen, none } = require('./common');

const FAMILY = 'transitional_care';
const verifiedAgainst = Object.freeze([
  'https://med.noridianmedicare.com/web/jeb/specialties/care-coordination/transitional-care-management-tcm',
  'CMS PPRRVU2026 October non-QPP'
]);
const CONTACT_BUSINESS_DAYS = 2;
const MODERATE = Object.freeze({ code: '99495', faceToFaceWithin: 14 });
const HIGH = Object.freeze({ code: '99496', faceToFaceWithin: 7 });
const CODES = Object.freeze([MODERATE.code, HIGH.code]);

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
const at = (d) => new Date(`${d}T12:00:00Z`);
const daysBetween = (a, b) => Math.round((at(b) - at(a)) / 86400000);
// The last date the interactive contact may fall on.
const contactDeadline = (discharge) => {
  const d = at(discharge); let counted = 0;
  while (counted < CONTACT_BUSINESS_DAYS) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) counted++; }
  return d.toISOString().slice(0, 10);
};

const select = (input = {}) => {
  const discharge = ymd(input.dischargeDate); const contact = ymd(input.contactDate); const f2f = ymd(input.faceToFaceDate);
  if (!discharge) return none(FAMILY, 'No discharge date is recorded.');
  if (!contact) return none(FAMILY, 'No interactive contact after discharge is recorded.');
  const deadline = contactDeadline(discharge);
  if (contact <= discharge || contact > deadline) return none(FAMILY, `The interactive contact (${contact}) is not within 2 business days of discharge (${discharge}; the last such day is ${deadline}).`);
  if (!f2f) return none(FAMILY, 'No face-to-face visit is recorded.');
  const days = daysBetween(discharge, f2f);
  if (days < 0) return none(FAMILY, 'The face-to-face visit is recorded before the discharge.');
  if (input.complexity === 'high' && days <= HIGH.faceToFaceWithin) return chosen(FAMILY, [{ code: HIGH.code, units: 1 }], `High complexity, a contact on ${contact}, and a face-to-face ${days} days after discharge.`);
  if (['high', 'moderate'].includes(input.complexity) && days <= MODERATE.faceToFaceWithin) {
    return chosen(FAMILY, [{ code: MODERATE.code, units: 1 }], `${input.complexity === 'high' ? 'High complexity, but the face-to-face was' : 'Moderate complexity, and the face-to-face was'} ${days} days after discharge.`);
  }
  if (!['high', 'moderate'].includes(input.complexity)) return none(FAMILY, 'The medical decision making is not recorded as moderate or high.');
  return none(FAMILY, `The face-to-face visit was ${days} days after discharge, outside both windows.`);
};

const FIELDS = Object.freeze([
  { key: 'dischargeDate', label: 'Discharge date', type: 'date' },
  { key: 'contactDate', label: 'Interactive contact date', type: 'date' },
  { key: 'faceToFaceDate', label: 'Face-to-face visit date', type: 'date' },
  { key: 'complexity', label: 'Medical decision making', type: 'select', options: [['moderate', 'Moderate'], ['high', 'High']] }
]);

module.exports = { FAMILY, FIELDS, label: 'Transitional care management', ...PROVENANCE, verifiedAgainst, catalogActive: true,
  CONTACT_BUSINESS_DAYS, MODERATE, HIGH, CODES, contactDeadline, select };
