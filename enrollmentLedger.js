// enrollmentLedger.js — one row per thing enrollment requires (2026-09-22).
//
// Per `docs/GFC_Offline_Intake_Reconciliation_Spec_v1.md` §1, rescued onto main
// the same day. Its thesis, and the reason this module exists:
//
//   "Stop modeling this as consent statuses. Every item enrollment requires is
//    one row in a single per-patient ledger — data field, document, or consent
//    — and each row carries the same shape."
//
// WHY THAT MATTERS MORE NOW THAN WHEN IT WAS WRITTEN. The owner asked for
// scanned documents to populate the record automatically. The moment anything
// AUTOMATED proposes a value, "where did this come from, and who checked it"
// stops being a nice-to-have and becomes the only thing standing between a
// misread insurance number and a claim. Every row carries `source`, `evidence`,
// `confidence` and `verifiedBy` for exactly that reason — so the answer is a
// property of the record rather than something reconstructed later.
//
// THIS MODULE RESTATES NO VOCABULARY. The consent set, the document catalog and
// the required-field list all already exist and each has one owner; they are
// passed IN. A fourth copy of "what enrollment requires" is how the ledger
// starts chasing a consent the registry retired — the drift this repo has paid
// for with the competency catalog, the document kinds and the intake fields.
'use strict';

const KIND = Object.freeze({ DATA: 'data', DOCUMENT: 'document', CONSENT: 'consent' });

// One status vocabulary across all three kinds (spec §1.2). A single enum is
// what lets the gate, the outstanding list and the chase email read one thing.
const STATUS = Object.freeze({
  CAPTURED: 'captured',                 // data: present and verified
  ON_FILE_OFFLINE: 'on_file_offline',   // satisfied by an uploaded document, with evidence
  IN_APP: 'in_app',                     // completed or signed inside the app
  REQUESTED: 'requested',               // asked for, awaiting them
  MISSING: 'missing',                   // required, not yet satisfied
  NA: 'na'                              // not applicable to this client or line
});

// Provenance precedence (spec §4.4). Staff verification always wins, and an
// unverified extraction NEVER silently overwrites a value a person entered or
// checked. This ordering is the whole safety property of letting a model
// propose anything at all.
const SOURCE_RANK = Object.freeze({
  staff_verified: 3,
  patient_portal: 2,
  extracted_draft: 1
});
const rankOf = (source) => {
  const s = String(source || '');
  if (s.startsWith('uploaded_doc:')) return SOURCE_RANK.extracted_draft;
  return SOURCE_RANK[s] || 0;
};

// "Satisfied" reduces to ONE boolean (spec §1.3), and everything downstream
// reads it: the enrollment gate, the client's action list, the chase email.
const isSatisfied = (row) => {
  if (!row) return false;
  if (row.status === STATUS.NA) return true;
  if (row.kind === KIND.DATA) return row.status === STATUS.CAPTURED;
  // A consent or a document is satisfied whether it was signed in the app or
  // filed from paper — the whole point of reconciliation is not making someone
  // redo work they already did.
  return row.status === STATUS.IN_APP || row.status === STATUS.ON_FILE_OFFLINE;
};

// A row is OUTSTANDING when it is required and not satisfied. `requested` is
// outstanding too: asking is not receiving.
const isOutstanding = (row) => !!row && !!row.required && !isSatisfied(row);

// Version / refresh override (spec §4.2). One mechanism serves a consent whose
// wording was rewritten and a data field whose required shape changed: if what
// is on file predates what is now required, the row goes back to outstanding.
// Without this, a client stays "complete" against a document that no longer
// says what we need it to say.
const applyVersionOverride = (row) => {
  if (!row || !row.requiredVersion) return row;
  if (!isSatisfied(row)) return row;
  const onFile = row.version == null ? null : String(row.version);
  if (onFile !== null && onFile === String(row.requiredVersion)) return row;
  return {
    ...row,
    status: STATUS.MISSING,
    supersededVersion: onFile,
    // Named, because "you never signed this" and "you signed an older version
    // of this" are different sentences to read, and only one of them is true.
    reason: onFile === null
      ? 'What is on file does not record which version was signed, so it cannot be matched to the current one.'
      : `Signed against version ${onFile}; version ${row.requiredVersion} is now required.`
  };
};

const baseRow = ({ key, kind, label, required, status, source, evidence, value, signedAt, version, requiredVersion, verifiedBy, verifiedAt, confidence, reason }) => ({
  key: String(key),
  kind,
  label: label || String(key),
  required: !!required,
  status: status || STATUS.MISSING,
  source: source || null,
  // The uploaded document (and page, where the extractor knows it) that backs
  // an offline value. A row claiming `on_file_offline` with no evidence is a
  // claim nobody can check.
  evidence: evidence || null,
  value: value === undefined ? null : value,
  signedAt: signedAt || null,
  version: version == null ? null : String(version),
  requiredVersion: requiredVersion == null ? null : String(requiredVersion),
  verifiedBy: verifiedBy || null,
  verifiedAt: verifiedAt || null,
  // Extraction confidence. Null means nobody guessed — a human put it there.
  confidence: typeof confidence === 'number' ? confidence : null,
  reason: reason || null
});

// ---- Composing the ledger ------------------------------------------------
//
// The three requirement sets are passed in, each already filtered to this
// client's service line by whoever owns that vocabulary.
//
//   consents  — [{ type, title, required }]      ← consentRegistry
//   dataFields— [{ key, label, present(...) }]   ← ENROLLMENT_REQUIRED_FIELDS
//   documents — [{ kind, label, required }]      ← GFC_EXPECTED_DOCUMENTS
//
const buildLedger = ({
  consents, dataFields, documents,
  client, uploads, requests,
  consentSatisfied, fieldPresent,
  now
} = {}) => {
  const at = now || new Date().toISOString();
  const c = client || {};
  const stored = c.consents || {};
  const mine = (uploads || []).filter(u => u && u.clientId === c.id);
  const asks = (requests || []).filter(r => r && r.clientId === c.id && r.status === 'open');
  const rows = [];

  // --- consents -----------------------------------------------------------
  for (const def of (consents || [])) {
    const rec = stored[def.type] || null;
    const satisfiedInApp = typeof consentSatisfied === 'function'
      ? !!consentSatisfied(rec) : !!(rec && (rec.status === 'signed' || rec.status === 'signed_offline'));
    // `signed_offline` IS the offline path — a paper signature staff recorded.
    const offline = !!(rec && rec.status === 'signed_offline');
    rows.push(applyVersionOverride(baseRow({
      key: def.type, kind: KIND.CONSENT, label: def.title || def.type,
      required: def.required !== false,
      status: satisfiedInApp ? (offline ? STATUS.ON_FILE_OFFLINE : STATUS.IN_APP) : STATUS.MISSING,
      source: rec ? (offline ? 'staff_verified' : 'patient_portal') : null,
      evidence: (rec && (rec.scanUploadId || rec.evidence)) || null,
      signedAt: (rec && (rec.signedAt || rec.at)) || null,
      version: rec ? rec.bodyVersion : null,
      requiredVersion: def.bodyVersion || null,
      verifiedBy: (rec && rec.recordedByName) || null
    })));
  }

  // --- documents ----------------------------------------------------------
  for (const def of (documents || [])) {
    const files = mine.filter(u => u.kind === def.kind && u.status !== 'rejected');
    const accepted = files.find(u => u.status === 'accepted') || null;
    const ask = asks.find(a => a.kind === def.kind) || null;
    const have = accepted || files[0] || null;
    rows.push(baseRow({
      key: def.kind, kind: KIND.DOCUMENT, label: def.label || def.kind,
      required: !!def.required,
      status: have
        // A document IS its own evidence, so an accepted one is on file.
        ? (accepted ? STATUS.ON_FILE_OFFLINE : STATUS.IN_APP)
        : (ask ? STATUS.REQUESTED : STATUS.MISSING),
      source: have ? (have.source === 'staff' ? 'staff_verified' : 'patient_portal') : null,
      evidence: have ? `uploaded_doc:${have.id}` : null,
      verifiedBy: (accepted && (accepted.reviewedByName || accepted.uploadedByName)) || null,
      verifiedAt: (accepted && (accepted.reviewedAt || accepted.uploadedAt)) || null
    }));
  }

  // --- data fields --------------------------------------------------------
  for (const def of (dataFields || [])) {
    let present = false;
    try {
      present = typeof fieldPresent === 'function'
        ? !!fieldPresent(def, c)
        : (typeof def.present === 'function' ? !!def.present(c, c.intake || {}) : false);
    } catch (e) { present = false; }
    const proposed = (c.ledgerProposals || {})[def.key] || null;
    rows.push(baseRow({
      key: def.key, kind: KIND.DATA, label: def.label || def.key,
      required: true,
      // A PROPOSED value is never `captured`. It is an extraction waiting for a
      // person, and the row stays outstanding until one looks at it — the
      // "unverified until touched" rule §10.3 makes normative.
      status: present ? STATUS.CAPTURED : STATUS.MISSING,
      source: present ? 'staff_verified' : (proposed ? `uploaded_doc:${proposed.docId}` : null),
      evidence: proposed ? `uploaded_doc:${proposed.docId}` : null,
      value: present ? undefined : (proposed ? proposed.value : null),
      confidence: proposed ? proposed.confidence : null,
      reason: (!present && proposed) ? 'Read from an uploaded document — needs checking before it counts.' : null
    }));
  }

  const outstanding = rows.filter(isOutstanding);
  const requiredRows = rows.filter(r => r.required);
  return {
    at,
    rows,
    byKey: rows.reduce((m, r) => { m[r.key] = r; return m; }, {}),
    outstanding,
    // The gate generalises from "roiFamily is signed" to "every required row is
    // satisfied, by ANY provenance" (spec §3.1). ROI-family stops being special
    // cased; it is one row among many.
    satisfied: outstanding.length === 0,
    counts: {
      total: requiredRows.length,
      satisfied: requiredRows.length - outstanding.length,
      outstanding: outstanding.length,
      // How many outstanding rows have something proposed waiting on a human.
      awaitingReview: outstanding.filter(r => r.confidence !== null).length
    }
  };
};

// Merging an extracted proposal into what is already known (spec §4.4).
// Returns the value that WINS, and says why — an extraction that loses must
// lose visibly, or the next person cannot tell it was ever offered.
const reconcileValue = ({ existing, incoming }) => {
  const e = existing || null;
  const i = incoming || null;
  if (!i) return { winner: e, changed: false, reason: 'nothing proposed' };
  if (!e) return { winner: i, changed: true, reason: 'no existing value' };
  const er = rankOf(e.source);
  const ir = rankOf(i.source);
  if (ir > er) return { winner: i, changed: true, reason: `${i.source} outranks ${e.source}` };
  // An extraction never overwrites a verified or patient-entered value, and
  // never overwrites a peer either — a tie goes to what is already on file.
  return { winner: e, changed: false, reason: `${e.source} is not outranked by ${i.source}` };
};

module.exports = {
  KIND, STATUS, SOURCE_RANK,
  isSatisfied, isOutstanding, applyVersionOverride,
  buildLedger, reconcileValue, rankOf
};
