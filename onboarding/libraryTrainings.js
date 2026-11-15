// ============================================================================
// THE TRAINING LIBRARY, FOR EVERY TEAM MEMBER (owner, 2026-11-10)
// ============================================================================
// The Training Library was the clinician curriculum (Chapter C). It is now the
// whole team's, scoped to each person:
//
//   - Clinical modules stay with clinicians, exactly as the Playbook places
//     them. Nothing here changes Chapter C, D or E's own curriculum.
//   - SIX GENERAL MODULES apply to every role: the organization, the role
//     card, the GFC app, privacy and security, mandatory reporting, and
//     incidents. A role that does not already carry one gets it in its
//     training phase.
//   - TRAININGS THE OFFICE ADDS are scoped to staff account types (caregiver,
//     RN, LCSW, LMSW, provider, manager, coordinator, liaison, admin). Each
//     is REQUIRED for everyone of those types (owner choice), in their own
//     onboarding, in their chapter's training phase.
//
// One training can reach several roles: the same row, the same material, the
// same completion record per person.
//
// Pure: no storage, no request context.
// ============================================================================

'use strict';

const { findModule, HOSTS, MODULES } = require('./modules');
const { SOURCES } = require('./sources');

const COLLECTION = 'onboarding_library_trainings';

const SHARED_MODULE_IDS = Object.freeze(['TRN-001', 'TRN-002', 'TRN-004', 'TRN-005', 'TRN-216', 'TRN-217']);

// Where training sits on each chapter's checklist. R1 (a supervising
// physician under agreement, not on staff) takes no library training.
const TRAINING_PHASE = Object.freeze({
  A: 'A.7', B: 'B.7', C: 'C.7', D: 'D.6', E: 'C.7', F: 'F.7', G: 'G.2', H: 'H.5'
});

const STAFF_TYPES = Object.freeze(['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'liaison']);
const TYPE_LABELS = Object.freeze({
  admin: 'Administrator', manager: 'Manager', coordinator: 'Care Coordinator', provider: 'Provider (NP, MD, PA)',
  rn: 'Registered Nurse', lcsw: 'LCSW', lmsw: 'LMSW / Case Manager', caregiver: 'Caregiver', liaison: 'Community Care Liaison'
});
// Who completes it: the person themselves, or the office signing it off.
const SIGNOFFS = Object.freeze(['ATTEST', 'OBSERVED']);

/** A training the office added, shaped like a library module. */
function toModule(row) {
  return Object.freeze({
    id: String(row.id),
    title: String(row.title),
    description: row.description || null,
    chapter: 'LIBRARY',
    phase: null,
    stage: 'LIBRARY',
    roles: Object.freeze((row.types || []).slice()),
    types: Object.freeze((row.types || []).slice()),
    lanes: Object.freeze([]),
    credentials: Object.freeze([]),
    format: 'LIBRARY',
    minutes: row.minutes == null ? null : row.minutes,
    host: row.signoff === 'OBSERVED' ? HOSTS.EXECUTIVE_DIRECTOR : HOSTS.SELF_PACED,
    coHost: null,
    sopRefs: Object.freeze([]),
    manualRefs: Object.freeze([]),
    manualRefsBasis: null,
    flagsOnAnyManualChange: false,
    proposedManualRefs: null,
    proposedBasis: null,
    plannedSop: null,
    sourceClass: null,
    checksFrom: null,
    spacedRecheck: Object.freeze([]),
    signoff: row.signoff === 'OBSERVED' ? 'OBSERVED' : 'ATTEST',
    unlocksAfter: Object.freeze([]),
    requiredFor: Object.freeze([]),
    requiredForUnparsed: null,
    dueDay: null, everyDays: null, untilDay: null,
    version: String(row.version || '1'),
    libraryRef: null,
    policy: row.policyText ? Object.freeze({ document: row.policyText, sections: '', url: row.policyUrl || null }) : null,
    addedByOffice: true
  });
}

const live = (rows) => (rows || []).filter(r => r && !r.removedAt && r.title);

/** Any module by id: the clinical catalog first, then the office's. */
function findAny(id, rows) {
  const m = findModule(id);
  if (m) return m;
  const row = live(rows).find(r => String(r.id) === String(id));
  return row ? toModule(row) : null;
}

// Non-clinical chapters (2026-11-10): mandatory reporting and incidents are
// the Executive Director's, under the role's own manual, never the Clinical
// Manual. Caregivers and RNs work under the PHC manual; the office, liaisons
// and students have no manual section to cite yet.
const NON_CLINICAL = Object.freeze(['A', 'B', 'F', 'G', 'H']);
const PHC_CHAPTERS = Object.freeze(['A', 'B']);
const OFFICE_ONLY = Object.freeze(['F', 'G', 'H']);
function phcPolicy() {
  const src = SOURCES.PHC_MANUAL;
  return src ? Object.freeze({ document: `${src.title}${src.transcribedFromVersion ? ` v${src.transcribedFromVersion}` : ''}`, sections: '',
    url: `https://drive.google.com/file/d/${src.driveFileId}/view` }) : null;
}
/** How a shared module reads for this chapter: host, policy and title. */
function sharedFor(id, chapterId) {
  const out = {};
  if (NON_CLINICAL.includes(chapterId) && (id === 'TRN-216' || id === 'TRN-217')) {
    out.host = HOSTS.EXECUTIVE_DIRECTOR;
    out.policy = PHC_CHAPTERS.includes(chapterId) ? phcPolicy() : null;
  }
  // The office, liaisons and students don't work in clients' homes.
  if (id === 'TRN-005' && OFFICE_ONLY.includes(chapterId)) out.title = 'Privacy and security in GFC systems';
  return out;
}

/**
 * The trainings this person gets on top of their chapter's own curriculum,
 * each with the phase it sits in. `alreadyIds` are the modules the chapter
 * already gives them, so nothing appears twice.
 */
function extrasFor({ chapterId, accountType, rows, alreadyIds }) {
  const phase = TRAINING_PHASE[chapterId];
  if (!phase) return [];
  const have = new Set(alreadyIds || []);
  const out = [];
  for (const id of SHARED_MODULE_IDS) {
    if (!have.has(id)) { out.push(Object.assign({ module: findModule(id), phase, shared: true }, sharedFor(id, chapterId))); have.add(id); }
  }
  // Catalog modules scoped to account types (TRN-009, TRN-501–503).
  for (const m of MODULES) {
    if (!m.audience || !accountType || !m.audience.includes(accountType) || have.has(m.id)) continue;
    out.push({ module: m, phase, shared: false });
    have.add(m.id);
  }
  for (const row of live(rows)) {
    if (!accountType || !(row.types || []).includes(accountType) || have.has(String(row.id))) continue;
    // A contracted clinician takes no training the office signs off (D.1-D.2).
    if (chapterId === 'D' && row.signoff === 'OBSERVED') continue;
    out.push({ module: toModule(row), phase, shared: false });
    have.add(String(row.id));
  }
  return out;
}

/**
 * Validate the office's new training. → { ok, row } | { ok: false, code, error }
 */
function validate(body) {
  const b = body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, code: 'TRAINING_TITLE_REQUIRED', error: 'Give the training a name.' };
  const types = Array.isArray(b.types) ? [...new Set(b.types.map(String))] : [];
  if (!types.length) return { ok: false, code: 'TRAINING_ROLES_REQUIRED', error: 'Choose at least one role it is for.' };
  const bad = types.filter(t => !STAFF_TYPES.includes(t));
  if (bad.length) return { ok: false, code: 'TRAINING_ROLE_UNKNOWN', error: `Not a staff role: ${bad.join(', ')}.` };
  const signoff = SIGNOFFS.includes(b.signoff) ? b.signoff : 'ATTEST';
  const minutes = b.minutes === '' || b.minutes == null ? null : Number(b.minutes);
  if (minutes != null && (!Number.isFinite(minutes) || minutes < 0 || minutes > 2400)) {
    return { ok: false, code: 'TRAINING_MINUTES_INVALID', error: 'Minutes must be a number from 0 to 2400.' };
  }
  // What it ties to (2026-11-10): a line of words and an optional https link.
  const policyText = String(b.policyText || '').trim().slice(0, 200) || null;
  let policyUrl = String(b.policyUrl || '').trim() || null;
  if (policyUrl) {
    let u = null; try { u = new URL(policyUrl); } catch (e) { u = null; }
    if (!u || u.protocol !== 'https:') return { ok: false, code: 'TRAINING_POLICY_URL_INVALID', error: 'The policy link must start with https://.' };
    policyUrl = u.toString();
  }
  return { ok: true, row: {
    title, types, signoff, minutes, policyText, policyUrl,
    description: String(b.description || '').trim().slice(0, 2000) || null
  } };
}

// Each staff type's usual chapter, for the Library's "Show what <role> gets".
const DEFAULT_CHAPTER = Object.freeze({ caregiver: 'A', rn: 'B', provider: 'C', lcsw: 'C', lmsw: 'C',
  admin: 'F', manager: 'F', coordinator: 'F', liaison: 'G' });
/**
 * The account types that get each module, from the same rule the checklist
 * uses. `baseFor(chapterId)` returns the ids that chapter's own curriculum
 * carries. → { [moduleId]: [type…] }
 */
function whoGets(rows, baseFor) {
  const out = {};
  for (const t of STAFF_TYPES) {
    const base = baseFor(DEFAULT_CHAPTER[t]) || [];
    const ids = base.concat(extrasFor({ chapterId: DEFAULT_CHAPTER[t], accountType: t, rows, alreadyIds: base }).map(x => x.module.id));
    for (const id of ids) (out[id] = out[id] || []).push(t);
  }
  return out;
}

/** Who a library module is for, in words, for the office's library list. */
function audienceLabel(m) {
  if (m.addedByOffice) return m.types.map(t => TYPE_LABELS[t] || t).join(', ');
  if (m.audience) return m.audience.map(t => TYPE_LABELS[t] || t).join(', ');
  if (SHARED_MODULE_IDS.includes(m.id)) return 'Everyone';
  return 'Clinicians';
}

module.exports = {
  COLLECTION, SHARED_MODULE_IDS, TRAINING_PHASE, STAFF_TYPES, TYPE_LABELS, SIGNOFFS,
  toModule, findAny, extrasFor, validate, audienceLabel, live, whoGets
};
