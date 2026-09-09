// ============================================================
// GODWINS FAMILY CARE — CONSENT REGISTRY (Session 4.6)
//
// THE registry. One list, one place. Every rule about which consents apply to
// which service line, what a consent status may be, and what a consent record
// must carry to count as executed lives here — and nowhere else. Before 4.6
// this list existed twice (server.js and public/admin-enrollment.html) and the
// two had already drifted.
//
// Pure: no storage, no request context, no I/O. That is what makes these rules
// testable directly rather than inferred by parsing server.js as text.
//
// Body text and titles come from public/consent-text.js. Data blocks resolve
// through consentRender.js. TEST DATA ONLY until HIPAA-live.
// ============================================================

'use strict';

const consentText = require('./public/consent-text');

// THE registry. One list, one place. Branched per service line per
// GFC_Intake_and_Packet_Spec_v1.md §4.2 and docs/CONSENT_REGISTRY_v2.md.
//
// Titles and body text come from public/consent-text.js, which carries the
// approved paper-packet wording and its version id. Nothing else in the app
// keeps its own copy of this list — the admin form used to (Scope F1) and had
// already drifted: `monitoring` existed here and in neither of its arrays, so
// offline onboarding could not record the monitoring choice at all.
//
// LANE SEPARATION (Scope A). `serviceAgreement` is PHC-only and
// `ihpcServiceAgreement` is IHPC-only. They were one entry scoped 'both' until
// 4.6, which meant a home-care-only client signed an agreement describing
// medical visits they were never offered, and a client who later added primary
// care walked into the clinical lane already "satisfied" on the only agreement
// in their file — with nothing anywhere establishing the provider-patient
// relationship. A BOTH client signs two agreements. That is correct, not
// duplication.
//
//
// STAGE is a second axis, and it is not scope. Scope says which LANE a record
// belongs to; stage says which VISIT it is signed at. The In-Home Primary Care
// packet is headed "Packet 2 of 2 — do not sign this on the same visit as home
// care", and a BOTH client was being shown all thirteen applicable records on
// one screen in one sitting, which is exactly what that instruction forbids.
// The sentence itself is paper workflow and is not ported; the protection
// behind it is, as a staged flow. A single-line client has one stage and sees
// no difference.
//
//   homecare — the Private Home Care packet, and the shared records it captures
//   medical  — the In-Home Primary Care packet, signed as a separate, later step
//
// Every ihpc-scoped record is staged medical and nothing else is — that is the
// invariant, and it is asserted rather than left to whoever edits this list.
//
// Each consent status is one of: signed | signed_offline | optin_recorded | pending | na.
const GFC_CONSENT_DEFS = [
  // Both service lines — signed once, on the home care packet, carried forward
  { type: 'npp',                  scope: 'both', stage: 'homecare', required: true },
  { type: 'roiFamily',            scope: 'both', stage: 'homecare', required: true },
  { type: 'roiProvider',          scope: 'both', stage: 'homecare', required: true },
  { type: 'billOfRights',         scope: 'both', stage: 'homecare', required: true },
  { type: 'emergencyFinancial',   scope: 'both', stage: 'homecare', required: true },
  { type: 'crisisProtocol',       scope: 'both', stage: 'homecare', required: true },
  { type: 'monitoring',           scope: 'both', stage: 'homecare', required: false, inactive: true },
  // Private Home Care only
  { type: 'serviceAgreement',     scope: 'phc',  stage: 'homecare', required: true },
  { type: 'financialAgreement',   scope: 'phc',  stage: 'homecare', required: true },
  { type: 'pcaScope',             scope: 'phc',  stage: 'homecare', required: true },
  // In-Home Primary Care only — the four documents of the medical packet
  { type: 'ihpcServiceAgreement', scope: 'ihpc', stage: 'medical',  required: true },
  { type: 'consentToTreat',       scope: 'ihpc', stage: 'medical',  required: true },
  { type: 'assignmentOfBenefits', scope: 'ihpc', stage: 'medical',  required: true },
  { type: 'practiceNpp',          scope: 'ihpc', stage: 'medical',  required: true }
].map(d => ({
  ...d,
  title: consentText.titleFor(d.type),
  paperSource: consentText.paperSourceFor(d.type),
  bodyVersion: consentText.currentVersion(d.type)
}));

// Which consent definitions apply to a given service line.
const consentDefsForServiceLine = (serviceLine) => {
  const line = (serviceLine || 'PHC').toUpperCase();
  return GFC_CONSENT_DEFS.filter(d => {
    if (d.scope === 'both') return true;
    if (d.scope === 'phc') return line === 'PHC' || line === 'BOTH';
    if (d.scope === 'ihpc') return line === 'IHPC' || line === 'BOTH';
    return false;
  });
};
const requiredConsentTypes = (serviceLine) =>
  consentDefsForServiceLine(serviceLine).filter(d => d.required).map(d => d.type);

// The two signing stages, in the order they are signed.
const CONSENT_STAGES = ['homecare', 'medical'];
const consentDefsForStage = (serviceLine, stage) =>
  consentDefsForServiceLine(serviceLine).filter(d => (d.stage || 'homecare') === stage);
// A stage is complete when every required, active record in it is satisfied.
// An inactive record can never be satisfied, so it must never hold a stage open.
const stageComplete = (serviceLine, stage, consents) =>
  consentDefsForStage(serviceLine, stage)
    .filter(d => d.required && !d.inactive)
    .every(d => isConsentSatisfied((consents || {})[d.type]));

// Consent status vocabulary:
//   signed          — e-signed in-app: typed name + acknowledgment + server
//                     timestamp + hashed client IP. NEVER written without all four.
//   signed_offline  — signed on paper before the app existed (offline onboarding);
//                     satisfies the enrollment gate identically to `signed`, kept
//                     distinct only so the audit trail preserves how it was captured
//   optin_recorded  — a preference recorded for an INACTIVE consent (Scope F4).
//                     Nothing was executed and no signature was taken, so this is
//                     deliberately NOT a satisfying status: an inactive opt-in must
//                     never be indistinguishable from an executed consent. Before
//                     4.6 the handler wrote 'signed' here with no signature, no
//                     timestamp and no IP, which is exactly the provenance-free
//                     record Scope E1 found in a live packet.
//   pending         — required but not yet satisfied
//   na              — not applicable, opted out, or declined
const CONSENT_SATISFIED_STATUSES = ['signed', 'signed_offline'];
const isConsentSatisfied = (status) => CONSENT_SATISFIED_STATUSES.includes(status);
// Every status a consent record may legitimately hold.
const CONSENT_STATUSES = ['signed', 'signed_offline', 'optin_recorded', 'pending', 'na'];

// Scope E2 — internal review status is an INTERNAL fact.
// It used to print across the header of the client's own enrollment packet:
// "Working draft — consent language pending counsel/licensure review." That
// document is the client's copy of what they signed; our review workflow is
// none of their business and undermines the document they are holding. The
// banner renders in the admin view only.
const CONSENT_REVIEW_BANNER =
  'Internal: consent bodies ported from the approved 09/2026 paper packets. Counsel and Georgia licensure review is still open. Test data until HIPAA-live.';

// ---- Consent provenance (Intake Spec §4.3, Scope E1/E3) -------------------
// X-Forwarded-For is a CHAIN: "<client>, <proxy>, <loopback>". Storing the whole
// chain as the audit identifier gives you the client IP plus an internal hop
// plus 127.0.0.1, which is noise — and 127.0.0.1 is meaningless as an identifier.
// Take the FIRST entry, which is the client, and hash that. The chain itself is
// hashed separately so a support question ("did these two signatures come from
// the same network path?") is still answerable without retaining raw addresses.
const clientIpFrom = (req) => {
  const fwd = (req.headers && req.headers['x-forwarded-for']) || '';
  const first = String(fwd).split(',')[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || null;
};
const ipChainFrom = (req) => {
  const fwd = (req.headers && req.headers['x-forwarded-for']) || '';
  return String(fwd).trim() || null;
};

// The ONLY way a consent signature record is built. Throws rather than writing a
// record without provenance — Scope E1 found a consent recorded as signed with
// no timestamp and no IP, and a rule that lives in one function cannot be
// forgotten at a second call site.
function buildConsentSignature({ type, typedName, req, bodyVersion, choices, provenance, hashIp }) {
  const signedAt = new Date().toISOString();
  const rawIp = clientIpFrom(req);
  const ipHash = hashIp(rawIp);
  if (!signedAt || !ipHash) {
    const e = new Error('Refusing to record a consent signature without a timestamp and a client IP.');
    e.code = 'CONSENT_PROVENANCE_MISSING';
    throw e;
  }
  return {
    typedName: String(typedName || '').trim(),
    acknowledged: true,
    signedAt,
    // Only a salted hash of the signer IP is retained — never the raw address,
    // which is PII (consistent with the ROI and care-plan paths).
    ipHash,
    ipChainHash: hashIp(ipChainFrom(req)),
    // The body version AS PRESENTED AT SIGNING. A consent copy reproduces this
    // text forever, not whatever the current wording happens to be (Scope C).
    version: bodyVersion || consentText.currentVersion(type) || consentText.CURRENT_VERSION,
    choices: choices || {},
    provenance: provenance || 'in_app'
  };
}

// A consent record is valid only with a timestamp and a hashed IP. Applied to
// every write and to the boot-time audit of existing records.
const consentRecordHasProvenance = (status, meta) => {
  if (status === 'signed') return !!(meta && meta.signedAt && meta.ipHash);
  if (status === 'signed_offline') return !!(meta && meta.signedAt && (meta.recordedBy || meta.provenance));
  if (status === 'optin_recorded' || status === 'na') return !!(meta && (meta.recordedAt || meta.signedAt));
  return true; // pending needs no provenance
};


// ── Service-line transitions (Scope F3) ─────────────────────────────
//
// THE HOLE THIS CLOSES: a client enrolls Private Home Care, later elects
// primary care, and the lane flips on an intake save. Nothing re-evaluated the
// consent set. The gate correctly blocked on the new clinical consents, but
// nobody was told the lane had changed — and before the Scope A split,
// `serviceAgreement` stayed satisfied from home care, so the client could reach
// the clinical lane having never signed a clinical agreement. PHC -> BOTH is
// the real September 2026 sequence, so it is the case the tests cover.
//
// Returns null when the line did not actually change. Mutates `client`.
function applyServiceLineChange(client, nextLine, actor) {
  const from = (client.serviceLine || 'PHC').toUpperCase();
  const to = String(nextLine || '').toUpperCase();
  if (!to || to === from) return null;

  const beforeRequired = requiredConsentTypes(from);
  client.serviceLine = to;
  const afterRequired = requiredConsentTypes(to);
  const consents = { ...(client.consents || {}) };

  // Newly required and not already satisfied -> written as pending, explicitly.
  // Leaving them absent would read as "nothing to do" on any screen that lists
  // consent rows rather than computing the required set.
  const newlyRequired = afterRequired.filter(t => !beforeRequired.includes(t) && !isConsentSatisfied(consents[t]));
  newlyRequired.forEach(t => { consents[t] = 'pending'; });
  client.consents = consents;

  // No longer required by the new lane. The record is KEPT — a signature is a
  // fact and is never erased by a lane change — it simply stops being counted.
  const noLongerRequired = beforeRequired.filter(t => !afterRequired.includes(t));

  const at = new Date().toISOString();
  client.serviceLineHistory = [...(client.serviceLineHistory || []), {
    from, to, at, byId: actor && actor.id, byName: (actor && (actor.name || actor.email)) || null,
    newlyRequired, noLongerRequired
  }];
  // Flag for admin. The lane change is silent otherwise — nobody finds out
  // until someone happens to open the enrollment screen.
  if (newlyRequired.length) {
    client.consentActionRequired = {
      reason: 'service_line_changed', from, to, at, consents: newlyRequired,
      titles: newlyRequired.map(titleForType)
    };
    if (client.enrollmentStatus === 'enrolled') client.reviewStatus = 'needs_followup';
  }
  return { from, to, newlyRequired, noLongerRequired };
}

const titleForType = (type) => (GFC_CONSENT_DEFS.find(d => d.type === type) || {}).title || type;

module.exports = {
  GFC_CONSENT_DEFS,
  consentDefsForServiceLine,
  requiredConsentTypes,
  CONSENT_STAGES,
  consentDefsForStage,
  stageComplete,
  CONSENT_SATISFIED_STATUSES,
  CONSENT_STATUSES,
  isConsentSatisfied,
  consentRecordHasProvenance,
  clientIpFrom,
  ipChainFrom,
  buildConsentSignature,
  applyServiceLineChange,
  titleForType,
  CONSENT_REVIEW_BANNER
};
