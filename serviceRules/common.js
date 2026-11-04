'use strict';
// serviceRules/common.js — shared by every Phase 3b family file (AI coding
// pipeline spec, 2026-11-04). No thresholds live here: each family file holds
// its own numbers, its sources and its review date.

const PROVENANCE = Object.freeze({ verified: true, verifiedOn: '2026-11-04', nextReviewDue: '2027-01-01' });

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// A selected code, or none with the reason stated.
const chosen = (family, codes, explanation, extra = {}) => ({ family, codes, explanation, reviewFlag: null, notes: [], ...extra });
const none = (family, reason, extra = {}) => ({ family, codes: [], explanation: reason, reviewFlag: null, notes: [], ...extra });

// Spec 3b.5: when the documented time sits within five minutes of the next
// threshold up, the same review flag as 3.3, naming the code chosen, the next
// code, and the absent evidence stated as an absence. Never advice.
const NEAR_MINUTES = 5;
const nearNext = ({ minutes, chosenCode, nextCode, nextAt, what = 'time' }) => {
  if (minutes == null || nextAt == null || !nextCode) return null;
  const gap = nextAt - minutes;
  if (gap <= 0 || gap > NEAR_MINUTES) return null;
  return {
    code: 'LEVEL_AMBIGUOUS', reasons: ['near_threshold'],
    chosen: chosenCode || null, next: nextCode, nextAt,
    absent: [`The documented ${what} is ${minutes} minutes. ${nextCode} begins at ${nextAt} minutes, and the record does not show more than ${minutes}.`]
  };
};

// Units of a "each additional N minutes" add-on, given where its first unit
// begins. Zero below the start.
const addOnUnits = (minutes, firstAt, step) => (minutes == null || minutes < firstAt ? 0 : 1 + Math.floor((minutes - firstAt) / step));

module.exports = { PROVENANCE, num, chosen, none, NEAR_MINUTES, nearNext, addOnUnits };
