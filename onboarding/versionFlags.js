// ============================================================================
// VERSION FLAGS — a reissued manual reopens the modules written against it
// ============================================================================
// Training Library §2.2: every module records the manual version it was
// written against. When the manual is reissued, every module whose manual
// references fall in a changed section is flagged and reviewed before the
// next learner begins. A module's own version bump (its procedure changed)
// re-checks anyone who already completed it; that is a separate mechanism.
//
// WHERE THE CHANGED SECTIONS COME FROM. The manual carries no change log, and
// the Drive copies have no earlier revision to compare against. So:
//   1. Going forward, each time the app reads a manual version it stores a
//      fingerprint of every numbered section. A reissue is compared section by
//      section, and the change list is computed, not typed.
//   2. For the move from v2.1 to v2.2, no v2.1 copy exists to fingerprint. The
//      only statement of what changed is Training Library v1.2 §2.2 (11.4,
//      12.3, 12.4). That entry is seeded here and CITES §2.2 as its source, so
//      the record says where the list came from.
//
// A module with no manual references cannot be judged. It is reported as
// CANNOT_ASSESS, never cleared: silence would read as "nothing changed".
// ============================================================================

'use strict';

const crypto = require('crypto');
const { ref } = require('./sources');

const STATUS = Object.freeze({
  CURRENT: 'CURRENT',                 // reviewed against the current version
  FLAGGED: 'FLAGGED',                 // a referenced section changed; review before the next learner
  CLEARED_NO_OVERLAP: 'CLEARED_NO_OVERLAP', // version moved, none of its sections changed
  CANNOT_ASSESS: 'CANNOT_ASSESS',     // no manual references to judge against
  CHANGES_UNKNOWN: 'CHANGES_UNKNOWN'  // no record of what changed between its version and now
});

// What the module review baseline is: Training Library v1.2's change table
// says the manual reference moved from v2.1 to v2.2, so every module was last
// reviewed against v2.1 until somebody records a review against v2.2.
const REVIEW_BASELINE = '2.1';

const SEEDED_CHANGES = Object.freeze([
  Object.freeze({
    document: 'CLINICAL_MANUAL',
    from: '2.1',
    to: '2.2',
    changedSections: Object.freeze(['11.4', '12.3', '12.4']),
    basis: 'STATED_IN_SOURCE',
    source: ref('TRAINING_LIBRARY', '2.2')
  })
]);

// ---- section references ----------------------------------------------------
// A reference is a section ("12.3"), a whole chapter ("12" covers every
// 12.x), or a range within one chapter ("11.1-11.7").
function parseSection(s) {
  const parts = String(s).trim().split('.').map(n => Number(n));
  if (!parts.length || parts.some(n => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Not a manual section: "${s}"`);
  }
  return parts;
}

function refCovers(refStr, section) {
  const sec = parseSection(section);
  const r = String(refStr).trim();
  if (r.includes('-')) {
    const [lo, hi] = r.split('-').map(parseSection);
    if (lo.length !== 2 || hi.length !== 2 || lo[0] !== hi[0]) {
      throw new Error(`Range "${r}" must stay within one chapter, like 11.1-11.7`);
    }
    if (sec[0] !== lo[0]) return false;
    if (sec.length === 1) return false;          // a range never covers the bare chapter
    return sec[1] >= lo[1] && sec[1] <= hi[1];
  }
  const rp = parseSection(r);
  if (rp.length > sec.length) return false;
  return rp.every((n, i) => n === sec[i]);
}

// ---- the change chain -------------------------------------------------------
// Walks from the version a module was reviewed against to the current one,
// collecting changed sections. A missing link returns null: we cannot say
// what changed, and the caller must not treat that as "nothing".
function changedSectionsBetween(fromVersion, toVersion, changeLog) {
  if (String(fromVersion) === String(toVersion)) return [];
  const log = changeLog || [];
  const out = new Set();
  let at = String(fromVersion);
  for (let guard = 0; guard < 100 && at !== String(toVersion); guard++) {
    const hop = log.find(c => c.document === 'CLINICAL_MANUAL' && String(c.from) === at);
    if (!hop) return null;
    hop.changedSections.forEach(s => out.add(String(s)));
    at = String(hop.to);
  }
  return at === String(toVersion) ? Array.from(out) : null;
}

// ---- one module -------------------------------------------------------------
// `reviewedAgainst` is the manual version somebody last recorded a review of
// this module against (from the app's review records), or the baseline.
function evaluateModule(module, { currentVersion, reviewedAgainst, changeLog } = {}) {
  const against = String(reviewedAgainst || REVIEW_BASELINE);
  const current = String(currentVersion);
  if (against === current) {
    return { moduleId: module.id, status: STATUS.CURRENT, reviewedAgainst: against, currentVersion: current, hits: [] };
  }
  const changed = changedSectionsBetween(against, current, changeLog || SEEDED_CHANGES);
  const base = { moduleId: module.id, reviewedAgainst: against, currentVersion: current };
  if (changed === null) return Object.assign(base, { status: STATUS.CHANGES_UNKNOWN, hits: [] });
  // A module that teaches the whole manual (TRN-006) lists no sections in the
  // Library, and the Library's own §2.2 outcome does not flag it. Reading
  // "the whole manual" as "every section" would be our inference, so it is
  // reported as CANNOT_ASSESS like any other module without references.
  if (!module.manualRefs || !module.manualRefs.length) {
    return Object.assign(base, { status: STATUS.CANNOT_ASSESS, hits: [] });
  }
  const hits = changed.filter(sec => module.manualRefs.some(r => refCovers(r, sec)));
  return Object.assign(base, { status: hits.length ? STATUS.FLAGGED : STATUS.CLEARED_NO_OVERLAP, hits });
}

function evaluateAll(modules, { currentVersion, reviews, changeLog } = {}) {
  const r = reviews || {};
  return modules.map(m => evaluateModule(m, {
    currentVersion, changeLog,
    reviewedAgainst: r[m.id] && r[m.id].reviewedAgainst
  }));
}

// ---- fingerprints (the forward path) ---------------------------------------
// Splits a manual's text on its numbered headings and hashes each section's
// body. Whitespace is normalised so a reflow is not a change; wording is.
// Headings are lines like "12.3 Controlled Substances" or "12 MEDICATION ...".
const HEADING = /^(\d{1,2}(?:\.\d{1,2})?) +([A-Z][^\n]{0,120})$/;

function fingerprintSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = {};
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) {
      const body = buf.join(' ').replace(/\s+/g, ' ').trim();
      sections[current] = crypto.createHash('sha256').update(body).digest('hex');
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    const m = HEADING.exec(line);
    if (m) { flush(); current = m[1]; buf = [line]; } else if (current) { buf.push(line); }
  }
  flush();
  return sections;
}

// A chapter heading's own body is only its title, so a change inside 12.3
// reports 12.3, not 12. Sections that appear or disappear are changes too.
function diffFingerprints(prev, next) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  return Array.from(keys).filter(k => (prev || {})[k] !== (next || {})[k]).sort((a, b) => {
    const pa = parseSection(a); const pb = parseSection(b);
    return pa[0] - pb[0] || (pa[1] || 0) - (pb[1] || 0);
  });
}

// Reads the version out of a document's control table ("| Version | 2.2 |"),
// never the filename.
function readControlVersion(text) {
  const m = /\|\s*Version\s*\|\s*([0-9]+(?:\.[0-9]+)*)\s*\|/.exec(String(text || ''));
  return m ? m[1] : null;
}

module.exports = {
  STATUS, REVIEW_BASELINE, SEEDED_CHANGES,
  refCovers, changedSectionsBetween, evaluateModule, evaluateAll,
  fingerprintSections, diffFingerprints, readControlVersion
};
