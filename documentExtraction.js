// documentExtraction.js — turning a scanned document into PROPOSALS (2026-09-22).
//
// The owner's ask, 2026-09-22: "as documents are scanned our system is able to
// pull the necessary details from that document and automatically input it into
// the respective area of the patient's portal, enrollment, scheduling etc."
//
// THE WORD THIS MODULE REFUSES IS "AUTOMATICALLY". Nothing here writes to a
// record. Every read becomes a PROPOSAL on the enrollment ledger, outstanding
// until a person looks at it — the "unverified until touched" rule §10.3 makes
// normative, and the reason is not procedural caution. A misread member ID
// looks exactly as plausible as a right one, and the place it surfaces is a
// denied claim months later. A blank field gets asked about; a wrong one gets
// billed.
//
// WHAT IT DOES NOT RESTATE, AND THAT IS MOST OF ITS DESIGN:
//   • WHERE a value may land — `public/intake-fields.js` is the allow-list the
//     staff editor already uses, and a target here must name a path IT
//     declares. So extraction can never write somewhere a person could not,
//     and a closed select's catalog holds a model to exactly the options it
//     holds a staff member to.
//   • WHAT a document kind is — `GFC_EXPECTED_DOCUMENTS` owns that, and kinds
//     are passed in, never listed here.
//   • WHAT a consent is — the registry owns it, and is passed in.
//   • HOW a model is called — `modelEngine.js` is the one call site.
//
// A fourth copy of any of those is how this module starts proposing into a
// field the editor retired. The competency catalog, the document kinds and the
// intake fields each bought that lesson already.
'use strict';

const intakeFields = require('./public/intake-fields');
const ledger = require('./enrollmentLedger');

// ---- What may be read out of which document ------------------------------
//
// A target names an intake PATH and nothing else. Its label, its type and its
// permitted options all come from the field declaration, so a select narrowed
// there narrows what a model may return on the next request.
//
// `verify` fields are the sharp ones. A face sheet or a referral arrives from
// somebody else's system and may simply be about a DIFFERENT PATIENT. Those
// fields are extracted to be COMPARED against what we hold and shown to the
// reviewer side by side — they are never writable, at any confidence, by
// anyone. Silently correcting a date of birth from a document that turns out
// to be the wrong patient's is the worst thing this feature could do.
const TARGETS = Object.freeze({
  insuranceCard: {
    fill: [
      'payerType',
      'commercial.carrier', 'commercial.planName', 'commercial.memberId',
      'commercial.groupNum', 'commercial.insPhone',
      'commercial.policyHolder', 'commercial.policyHolderRel',
      'medicare.id', 'medicare.type', 'medicare.advantagePlan',
      'medicare.advMemberId', 'medicare.advGroupNum',
      'medicaid.memberId', 'medicaid.plan'
    ],
    verify: ['dob']
  },
  referral: {
    fill: [
      'medicalTeam.pcpName', 'medicalTeam.pcpPractice', 'medicalTeam.pcpPhone',
      'medicalTeam.specialist1Name', 'medicalTeam.specialist1Phone',
      'medicalTeam.preferredHospital', 'medicalTeam.preferredPharmacy',
      'medicalTeam.pharmacyPhone'
    ],
    verify: ['dob', 'phone']
  },
  physicianOrder: {
    // An order's CONTENT — the services, the frequency, the duration — has no
    // intake path, and inventing one here would be a second home for data the
    // orders workflow owns. What this reads is who wrote it, so the medical
    // team on the face sheet is right; the order itself goes to the clinician.
    fill: ['medicalTeam.pcpName', 'medicalTeam.pcpPractice', 'medicalTeam.pcpPhone'],
    verify: ['dob']
  },
  priorRecords: {
    fill: [
      'medicalTeam.pcpName', 'medicalTeam.pcpPractice', 'medicalTeam.pcpPhone',
      'medicalTeam.preferredHospital', 'medicalTeam.preferredPharmacy'
    ],
    verify: ['dob']
  },
  advanceDirective: {
    fill: ['advanceDirective.status'],
    verify: ['dob']
  },
  dnrPolst: {
    fill: ['advanceDirective.status'],
    verify: ['dob']
  },
  // VERIFY-ONLY KINDS (owner, 2026-09-23: "it needs to be able to read any
  // document uploaded"). Every one of these arrives from somewhere else —
  // a wallet, a hospital, a contracting entity — and none of them has a
  // FILL target: a photo ID and a medication list carry no field this app
  // does not already hold, and `medications` is a LIST, which is refused as
  // a fill target by `validateTargets` for the reason recorded there — a
  // half-read medication list is worse than none. What every one of them
  // DOES carry, reliably, is the patient's own date of birth, so `verify`
  // is what they get: the one thing worth checking is whether this document
  // is about the right person at all.
  photoId: { verify: ['dob'] },
  poaGuardianship: { verify: ['dob'] },
  medicationList: { verify: ['dob'] },
  // Per-visit documents (Session 4.12's VISIT-scoped kinds) get the same
  // treatment — a discharge summary or an IME file is about a specific
  // patient and identity-checking it is exactly as valuable as it is for a
  // referral, even though nothing on it is a fill target.
  dischargeSummary: { verify: ['dob'] },
  dischargeMedList: { verify: ['dob'] },
  imeRecords: { verify: ['dob'] },
  imeExamRequest: { verify: ['dob'] }
});

// A consent packet is not a field read. It answers "which of these documents
// is signed in here, and on what date" — which proposes ledger CONSENT rows,
// not data rows. The consent vocabulary is passed in for the same reason the
// ledger takes it in: one owner, never a copy.
const CONSENT_PACKET_KIND = 'consentPacket';

// ---- Guard rails, enforced at load, not at review time -------------------
//
// A target naming a path the editor does not declare would propose into a
// field no person can correct afterwards. Better to refuse to start.
const validateTargets = (targets) => {
  const bad = [];
  for (const [kind, t] of Object.entries(targets || {})) {
    for (const path of [...(t.fill || []), ...(t.verify || [])]) {
      const field = intakeFields.fieldAt(path);
      if (!field) { bad.push(`${kind} → ${path} is not a declared intake field`); continue; }
      // A checkbox group or a repeating block needs a row-shaped proposal and a
      // row-shaped review, and a HALF-read medication list is worse than none —
      // a dropped medication reads as a medication the patient is not taking.
      // Refused by name rather than silently flattened; the next increment is
      // where they land, deliberately.
      if (field.type === 'multi' || field.type === 'list') {
        bad.push(`${kind} → ${path} is a ${field.type}; repeating and multi-select answers are not extractable yet`);
      }
    }
  }
  return bad;
};
// Called at LOAD, not at review time. A target naming a path the editor does
// not declare would propose into a field no person can correct afterwards, so
// refusing to start is better than finding out at a kitchen table.
{
  const bad = validateTargets(TARGETS);
  if (bad.length) throw new Error(`documentExtraction targets are invalid:\n  ${bad.join('\n  ')}`);
}

const extractableKinds = () => Object.keys(TARGETS).concat(CONSENT_PACKET_KIND);
const isExtractable = (kind) => extractableKinds().includes(String(kind || ''));

// ---- The schema handed to the model --------------------------------------
//
// DERIVED from the field declarations, so a closed select holds the model to
// exactly the catalog it holds a staff member to, and the engine refuses an
// invented option before it ever reaches a reviewer.
// One field's slot in the schema. Its own function so the open/closed rule can
// be exercised against a field that IS open — none of today's targets is one,
// and a loop that iterates nothing proves nothing about the rule it loops over.
const schemaFieldFor = (path) => {
  const field = intakeFields.fieldAt(path) || {};
  const def = { type: 'string' };
  // An `open` select is a suggestion list, not a vocabulary — the same four
  // fields the staff editor deliberately left open stay open here. A refactor
  // that centralises a rule must not quietly tighten it.
  if (field.type === 'select' && !field.open) {
    const options = intakeFields.optionsFor(field);
    if (options.length) def.enum = options;
  }
  return def;
};

const schemaFor = (kind) => {
  const k = String(kind || '');
  if (k === CONSENT_PACKET_KIND) return null; // classification, not field extraction
  const t = TARGETS[k];
  if (!t) return null; // a kind with no declared targets cannot be extracted at all
  const fields = {};
  for (const path of [...(t.fill || []), ...(t.verify || [])]) fields[path] = schemaFieldFor(path);
  return { fields };
};

const labelFor = (path) => {
  const f = intakeFields.fieldAt(path);
  return (f && f.label) || path;
};

const clamp01 = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);

// ---- Turning a model proposal into ledger-shaped rows ---------------------
//
// `snapshot` is what the record held AT THE MOMENT OF EXTRACTION. It is kept
// on every row so a reviewer who accepts three days later cannot apply their
// reasoning about one value to a different one — the stale-ask rule the shift
// change request settled, in a place where the cost of getting it wrong is a
// claim rather than a rota.
const buildProposals = ({ kind, docId, extracted, snapshotAt, readValue, confidence, at }) => {
  const k = String(kind || '');
  const t = TARGETS[k];
  if (!t) return { error: `"${k}" has no declared extraction targets`, code: 'EXTRACTION_KIND_UNSUPPORTED' };
  if (!docId) return { error: 'A proposal must name the document it came from', code: 'EXTRACTION_NO_DOCUMENT' };
  const src = extracted || {};
  const when = at || new Date().toISOString();
  const rows = [];
  const declared = new Set([...(t.fill || []), ...(t.verify || [])]);

  for (const path of declared) {
    const raw = src[path];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const value = String(raw).trim();
    const snapshot = typeof readValue === 'function' ? readValue(path) : undefined;
    const current = snapshot === undefined || snapshot === null ? '' : String(snapshot);
    const isVerify = (t.verify || []).includes(path);
    rows.push({
      path,
      label: labelFor(path),
      value,
      // A proposal that already matches what is on file is not a correction and
      // is not worth a reviewer's attention — but it IS worth saying it agreed,
      // because a document that agrees with the record is evidence the document
      // is about the right person.
      agrees: current !== '' && current === value,
      snapshot: current,
      // Read to be COMPARED, never written. No confidence and no decision
      // changes that.
      verifyOnly: isVerify,
      confidence: clamp01(typeof src.__confidence === 'object' ? src.__confidence[path] : confidence),
      docId: String(docId),
      decision: null
    });
  }

  return {
    kind: k,
    docId: String(docId),
    at: when,
    snapshotAt: snapshotAt || when,
    rows,
    // What the ledger reads. VERIFY rows are deliberately absent: they are not
    // candidates for a field, so they must not make a field look answered.
    ledgerProposals: rows
      .filter(r => !r.verifyOnly)
      .reduce((m, r) => { m[r.path] = { docId: r.docId, value: r.value, confidence: r.confidence }; return m; }, {}),
    // What a reviewer must look at before any of it counts.
    reviewCount: rows.filter(r => !r.verifyOnly && !r.agrees).length,
    // Named separately, because "this document disagrees with the record about
    // the date of birth" is a question about WHOSE DOCUMENT THIS IS, and it is
    // asked before anything else on the screen.
    identityConflicts: rows.filter(r => r.verifyOnly && r.snapshot !== '' && r.snapshot !== r.value)
      .map(r => ({ path: r.path, label: r.label, onFile: r.snapshot, onDocument: r.value }))
  };
};

const DECISIONS = Object.freeze({ ACCEPT: 'accept', EDIT: 'edit', DISCARD: 'discard' });

// ---- Applying a review ---------------------------------------------------
//
// Returns the writes to make and, just as importantly, everything that did NOT
// get written and why. An extraction that loses must lose VISIBLY, or the next
// person cannot tell it was ever offered.
const applyReview = ({ proposal, decisions, readValue, actor, at }) => {
  if (!proposal || !Array.isArray(proposal.rows)) {
    return { error: 'No proposal to review', code: 'EXTRACTION_NO_PROPOSAL' };
  }
  const when = at || new Date().toISOString();
  const byPath = decisions || {};
  const writes = [];
  const refused = [];
  const undecided = [];
  let accepted = 0, edited = 0, discarded = 0;

  for (const row of proposal.rows) {
    const d = byPath[row.path];
    const choice = d && String(d.decision || '');

    if (row.verifyOnly) {
      // No decision vocabulary applies. It was never writable.
      if (choice && choice !== DECISIONS.DISCARD) {
        refused.push({ path: row.path, label: row.label, reason: 'This field is read from the document to be checked against the record, never written from it.' });
      }
      continue;
    }

    if (!choice) { undecided.push({ path: row.path, label: row.label }); continue; }

    if (choice === DECISIONS.DISCARD) { discarded++; continue; }
    if (choice !== DECISIONS.ACCEPT && choice !== DECISIONS.EDIT) {
      refused.push({ path: row.path, label: row.label, reason: `"${choice}" is not a decision.` });
      continue;
    }

    // Held to the same catalog the staff editor is held to. A reviewer typing a
    // correction is a staff edit and gets the staff editor's rules; anything
    // else would make this a quieter second door onto the same record.
    const field = intakeFields.fieldAt(row.path) || {};
    const proposedValue = choice === DECISIONS.EDIT ? String(d.value === undefined || d.value === null ? '' : d.value).trim() : row.value;
    if (field.type === 'select' && proposedValue !== '' && !field.open) {
      const options = intakeFields.optionsFor(field);
      if (options.length && !options.includes(proposedValue)) {
        refused.push({ path: row.path, label: row.label, value: proposedValue, options, reason: 'That is not one of the permitted answers for this field.' });
        continue;
      }
    }

    // THE STALE CHECK. If the record moved between the scan and this review,
    // the reviewer is reasoning about a value that is no longer there. Refused
    // with both values named, and the row stays for them to decide again.
    const nowOnFile = typeof readValue === 'function' ? readValue(row.path) : undefined;
    const currently = nowOnFile === undefined || nowOnFile === null ? '' : String(nowOnFile);
    if (currently !== row.snapshot) {
      refused.push({
        path: row.path, label: row.label, value: proposedValue,
        onFile: currently, wasOnFile: row.snapshot,
        code: 'EXTRACTION_SUPERSEDED',
        reason: 'This field changed after the document was read, so the proposal was not applied.'
      });
      continue;
    }

    // A person looked at it, so what lands is STAFF-VERIFIED — not an
    // extraction. That is the whole point of the review existing: the
    // provenance of an accepted value is the human who accepted it.
    const merged = ledger.reconcileValue({
      existing: currently === '' ? null : { source: 'staff_verified', value: currently },
      incoming: { source: 'staff_verified', value: proposedValue }
    });
    // A tie goes to what is on file, which here means an unchanged value is not
    // a write. Re-saving the same string is not a correction.
    if (currently === proposedValue) { if (choice === DECISIONS.EDIT) edited++; else accepted++; continue; }

    writes.push({
      path: row.path, label: row.label, value: proposedValue,
      previous: currently,
      source: 'staff_verified',
      verifiedBy: (actor && (actor.name || actor.email)) || null,
      verifiedAt: when,
      // Where it came from originally, kept so the trail back to the scan
      // survives the acceptance.
      evidence: `uploaded_doc:${row.docId}`,
      fromDecision: choice,
      reconciled: merged.reason
    });
    if (choice === DECISIONS.EDIT) edited++; else accepted++;
  }

  // The OUTCOME reported back to the engine (§10.3). One per review, and it is
  // the honest measure of whether the feature helps: a run where every field
  // was retyped is a run that cost the reviewer time rather than saving it.
  const outcome = edited > 0 ? 'edited' : (accepted > 0 ? 'accepted' : 'discarded');

  return {
    writes, refused, undecided,
    counts: { accepted, edited, discarded, refused: refused.length, undecided: undecided.length },
    outcome,
    // A review with anything left undecided has not finished. The ledger rows
    // stay outstanding, so an enrollment cannot complete on a half-read scan.
    complete: undecided.length === 0
  };
};

// ---- Consent packet classification ---------------------------------------
//
// Proposes "this packet appears to contain a signed X, dated Y". It proposes a
// CONSENT row and stops there: recording a signature is `signed_offline`, which
// is a staff act with its own route, its own required scan and its own audit.
// A classifier does not get to assert that somebody signed something.
const buildConsentProposals = ({ docId, found, consentDefs, at }) => {
  if (!docId) return { error: 'A proposal must name the document it came from', code: 'EXTRACTION_NO_DOCUMENT' };
  const known = new Map((consentDefs || []).map(d => [d.type, d]));
  const when = at || new Date().toISOString();
  const rows = [];
  const unrecognised = [];
  for (const hit of (found || [])) {
    const type = hit && String(hit.type || '');
    const def = known.get(type);
    // A consent the registry does not carry — retired, renamed, or invented by
    // the classifier — is reported, never proposed. The registry is the owner
    // of that vocabulary and this is not a second one.
    if (!def) { if (type) unrecognised.push(type); continue; }
    rows.push({
      consentType: type,
      label: def.title || type,
      signedAt: hit.signedAt || null,
      // Which wording it appears to be. A packet signed against superseded
      // wording does not satisfy the requirement, and the ledger's version
      // override is what says so — this only carries what was read.
      bodyVersion: hit.bodyVersion || null,
      requiredVersion: def.bodyVersion || null,
      confidence: clamp01(hit.confidence),
      docId: String(docId),
      decision: null
    });
  }
  return {
    kind: CONSENT_PACKET_KIND, docId: String(docId), at: when,
    rows, unrecognised,
    // Said in the payload rather than only in a comment, because the screen
    // renders it and a reviewer needs to know what accepting does NOT do.
    note: 'A packet is classified, never recorded. Filing a paper signature is its own step, with the scan attached.'
  };
};

module.exports = {
  TARGETS, CONSENT_PACKET_KIND, DECISIONS,
  extractableKinds, isExtractable, schemaFor, schemaFieldFor, validateTargets, labelFor,
  buildProposals, applyReview, buildConsentProposals
};
