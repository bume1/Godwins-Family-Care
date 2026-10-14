// clinicalRoles.js — Session 4.8
//
// Clinical access used to be ONE BOOLEAN. `hasClinicalAccess: true` granted
// read AND write across prescribing, ordering, coding and encounter signing,
// and `licenseLevel` was free text displayed beside a name that gated nothing.
// An RN given clinical access could write a prescription, place a lab order
// independently, and sign-and-close an encounter carrying an E/M code — all
// three outside RN scope, with the app producing the record asserting she did
// them.
//
// This module is the ONE place that answers "may this person do this". The
// clinical vocabulary lives here rather than in config.js for the same reason
// the caregiver vocabulary lives in caregiverRepository.js and the consent
// vocabulary in consentRegistry.js: an enum block that every session edits is
// an enum block that drifts.
//
// THE RULE THIS MODULE ENFORCES was already written in the billing spec
// (docs/GFC_Billing_Segment_App_Integration_Spec.md §4 item 4) and never
// built: *the rendering provider's certification must match the code billed.*

// ---- The roles ----------------------------------------------------------
// `readOnly` is staff WITHOUT a clinical licence who may read a chart — it is
// today's case manager, preserved exactly. It is NOT the same as having no
// clinicalRole at all: a client, a caregiver or an ordinary staff account has
// `null` and reaches no chart.
const CLINICAL_ROLES = Object.freeze({
  PROVIDER: 'provider',   // FNP, MD, PA — full clinical authority
  RN: 'rn',               // RN, including RN case managers
  LCSW: 'lcsw',           // clinical social worker, independently licensed (archetype A9)
  LMSW: 'lmsw',           // master's-level SW under supervision (A10): GFC's case managers and counselors
  READ_ONLY: 'readOnly'   // staff without a clinical licence
});
const ALL_CLINICAL_ROLES = Object.freeze([
  CLINICAL_ROLES.PROVIDER, CLINICAL_ROLES.RN, CLINICAL_ROLES.LCSW,
  CLINICAL_ROLES.LMSW, CLINICAL_ROLES.READ_ONLY
]);
// The licensed roles — the ones `hasClinicalAccess` derives true for.
const LICENSED_CLINICAL_ROLES = Object.freeze([
  CLINICAL_ROLES.PROVIDER, CLINICAL_ROLES.RN, CLINICAL_ROLES.LCSW, CLINICAL_ROLES.LMSW
]);
const CLINICAL_ROLE_LABELS = Object.freeze({
  provider: 'Provider (FNP / MD / PA)',
  rn: 'Registered Nurse',
  lcsw: 'LCSW (clinical social worker)',
  lmsw: 'LMSW (case manager / counselor)',
  readOnly: 'Read-only (unlicensed staff)'
});

// ---- The capability matrix ----------------------------------------------
// Implemented exactly as the Session 4.8 brief's table. Two rows are not a
// plain boolean and are answered by their own functions below:
//   carePlanSign          — branches on the client's SERVICE LINE (§3)
//   signBillableEncounter — branches on what the encounter CARRIES (§3)
// They appear here as the coarse answer (may this role ever sign at all) and
// the functions are the authority.
const CAPABILITIES = Object.freeze({
  CHART_READ: 'chartRead',
  VITALS_WRITE: 'vitalsWrite',
  NURSING_NOTE: 'nursingNote',                 // nursing assessment / visit note
  BEHAVIORAL_NOTE: 'behavioralNote',           // psychosocial assessment / BH note
  SCREENING_INSTRUMENT: 'screeningInstrument', // PHQ-9, GAD-7, SDOH
  CARE_PLAN_AUTHOR: 'carePlanAuthor',
  CARE_PLAN_SIGN: 'carePlanSign',
  MED_REC: 'medRec',                           // medication reconciliation (document)
  PROBLEM_LIST_WRITE: 'problemListWrite',
  DOCUMENT_UPLOAD: 'documentUpload',
  SCHEDULING: 'scheduling',
  ORDER_STATUS_ADVANCE: 'orderStatusAdvance',  // sent / resulted
  PRESCRIBE: 'prescribe',
  ORDER_DIRECT: 'orderDirect',                 // place an order on own authority
  ORDER_STANDING: 'orderStanding',             // place an order under a standing order
  SELECT_SERVICE_CODES: 'selectServiceCodes',  // CPT / E/M selection
  SIGN_BILLABLE_ENCOUNTER: 'signBillableEncounter',
  ACKNOWLEDGE_ABNORMAL_RESULT: 'acknowledgeAbnormalResult',
  AUTHOR_STANDING_ORDER: 'authorStandingOrder', // only a provider signs a protocol (§4 rule 1)
  // Referrals, by scope of practice (owner, 2026-10-12). A referral is not a
  // test: referring a patient to a colleague is coordination every licensed
  // role does, so it is no longer only a provider's.
  REFER_INTERNAL: 'referInternal',             // refer to someone on GFC's own clinical team
  REFER_EXTERNAL: 'referExternal',             // refer out to another practice (provider, LCSW)
  REFERRAL_COORDINATION: 'referralCoordination', // fax, schedule, file the consult note, cancel a referral
  BEHAVIORAL_DIAGNOSIS: 'behavioralDiagnosis'  // add a mental health (ICD-10 F) diagnosis to the problem list
});

// role → the capabilities it carries. Anything absent is refused: the matrix
// is an ALLOW-LIST, so a capability added next session is refused for every
// role until someone deliberately grants it.
const ROLE_CAPABILITIES = Object.freeze({
  provider: Object.freeze([
    'chartRead', 'vitalsWrite', 'nursingNote', 'behavioralNote', 'screeningInstrument',
    'carePlanAuthor', 'carePlanSign', 'medRec', 'problemListWrite', 'documentUpload',
    'scheduling', 'orderStatusAdvance', 'prescribe', 'orderDirect', 'orderStanding',
    'selectServiceCodes', 'signBillableEncounter', 'acknowledgeAbnormalResult',
    'authorStandingOrder', 'referInternal', 'referExternal', 'referralCoordination'
  ]),
  rn: Object.freeze([
    'chartRead', 'vitalsWrite', 'nursingNote', 'screeningInstrument',
    'carePlanAuthor', 'carePlanSign', 'medRec', 'problemListWrite', 'documentUpload',
    'scheduling', 'orderStatusAdvance', 'orderStanding', 'referInternal', 'referralCoordination'
  ]),
  // LCSW (owner, 2026-10-12): assesses, diagnoses and treats behavioural and
  // mental health conditions, practises independently, bills in their own
  // name and supervises LMSWs. So: refers in and out, coordinates referrals,
  // and records a MENTAL HEALTH diagnosis on the problem list. Not the rest of
  // the problem list and not allergies: those stay an RN's or a provider's.
  lcsw: Object.freeze([
    'chartRead', 'behavioralNote', 'screeningInstrument',
    'carePlanAuthor', 'carePlanSign', 'documentUpload', 'scheduling',
    'orderStanding', 'selectServiceCodes', 'signBillableEncounter',
    'referInternal', 'referExternal', 'referralCoordination', 'behavioralDiagnosis'
  ]),
  // LMSW (owner, 2026-10-12): case management, intake and service
  // coordination, plus non-clinical or supervised counseling. Cannot
  // diagnose independently or bill without oversight. So: refers within the
  // team and works referrals through (fax, schedule, consult note), but places
  // no referral out on their own, adds no diagnosis, and bills nothing.
  lmsw: Object.freeze([
    'chartRead', 'behavioralNote', 'screeningInstrument',
    'carePlanAuthor', 'documentUpload', 'scheduling', 'orderStanding',
    'referInternal', 'referralCoordination'
  ]),
  readOnly: Object.freeze(['chartRead'])
});

// Why a capability was refused, in words a clinician can act on. A 403 that
// says "forbidden" sends someone to an admin; one that names the credential
// tells them the work needs a different person.
const CAPABILITY_REASONS = Object.freeze({
  prescribe: 'Prescribing is limited to a provider (FNP, MD, PA).',
  orderDirect: 'Placing an order on your own authority is limited to a provider. Execute it under a signed standing order instead.',
  selectServiceCodes: 'Selecting CPT / E/M service codes is limited to a provider (an LCSW may select the behavioural-health set only).',
  signBillableEncounter: 'Signing an encounter that carries a billable service code is limited to a provider.',
  acknowledgeAbnormalResult: 'Clinically acknowledging an abnormal result is limited to a provider.',
  authorStandingOrder: 'Only a provider may author, sign or revise a standing order.',
  nursingNote: 'A nursing assessment or visit note is documented by an RN or a provider.',
  behavioralNote: 'A psychosocial or behavioural-health note is documented by an LCSW, an LMSW or a provider.',
  medRec: 'Medication reconciliation is documented by an RN or a provider.',
  problemListWrite: 'Writing to the problem list is limited to an RN or a provider.',
  vitalsWrite: 'Recording vitals is limited to an RN or a provider.',
  orderStatusAdvance: 'Advancing an order status is limited to an RN or a provider.',
  referInternal: 'Referring a patient to a colleague requires a clinical licence.',
  referExternal: 'Referring a patient to an outside practice is limited to a provider or an LCSW. An LMSW refers within the team.',
  referralCoordination: 'Working a referral through requires a clinical licence.',
  behavioralDiagnosis: 'Adding a diagnosis to the problem list is limited to an RN, a provider, or an LCSW for mental health diagnoses.',
  carePlanSign: 'Signing a care plan requires a clinical licence.',
  carePlanAuthor: 'Authoring a care plan requires a clinical licence.',
  documentUpload: 'Uploading a document requires a clinical licence.',
  scheduling: 'Scheduling requires a clinical licence.',
  screeningInstrument: 'Administering a screening instrument requires a clinical licence.',
  chartRead: 'Reading a chart requires clinical access.'
});

// ---- Resolving a user's role --------------------------------------------
// The stored `clinicalRole` wins. When it is absent the value is DERIVED from
// today's model so a user record written before this session behaves exactly
// as it did — the migration writes the field, this makes the app correct in
// the window before it runs and for any record it could not reach.
//
// An ADMIN always resolves to `provider`. Admin is the Owner/MD super-admin
// role in this app and every route already treats it as full clinical
// authority; narrowing it from this field would be a way to lock the owner out
// of her own chart.
const isValidClinicalRole = (v) => ALL_CLINICAL_ROLES.includes(String(v || ''));
const resolveClinicalRole = (user) => {
  if (!user) return null;
  if (user.role === 'admin') return CLINICAL_ROLES.PROVIDER;
  if (isValidClinicalRole(user.clinicalRole)) return String(user.clinicalRole);
  // Derived fallback — today's model, preserved.
  // GFC's case managers ARE LMSW (owner, 2026-10-12), so a case manager with
  // no stored role resolves to `lmsw`. An admin can still set one to readOnly
  // deliberately, and that stored value wins above.
  if (user.role === 'caseManager') return CLINICAL_ROLES.LMSW;
  if (user.hasClinicalAccess) return CLINICAL_ROLES.PROVIDER;
  return null;
};

// `hasClinicalAccess` stays as a DERIVED READ so nothing downstream breaks —
// login destination, messaging role, MFA, the caregiver and scheduling routes
// all read it. The field is not deleted in this session; it is no longer the
// authority.
const derivedHasClinicalAccess = (user) => {
  const role = resolveClinicalRole(user);
  return !!role && role !== CLINICAL_ROLES.READ_ONLY;
};

const can = (user, capability) => {
  const role = resolveClinicalRole(user);
  if (!role) return false;
  return (ROLE_CAPABILITIES[role] || []).includes(capability);
};
const capabilitiesFor = (user) => {
  const role = resolveClinicalRole(user);
  const list = role ? ROLE_CAPABILITIES[role] || [] : [];
  return Object.fromEntries(Object.values(CAPABILITIES).map(c => [c, list.includes(c)]));
};
const refusalFor = (user, capability) => ({
  error: CAPABILITY_REASONS[capability] || 'Your clinical credential does not permit this action.',
  code: 'CLINICAL_CREDENTIAL',
  capability,
  clinicalRole: resolveClinicalRole(user)
});

// The clinical read/write split (Session 4.3, now expressed through the enum).
// READ  = any assigned clinical role, `readOnly` included.
// WRITE = any LICENSED role. `readOnly` is the case manager's existing
//         read-only access and must not regress.
const canClinicalRead = (u) => !!resolveClinicalRole(u);
const canClinicalWrite = (u) => derivedHasClinicalAccess(u);

// ---- The permitted code set (billing spec §4 item 4) --------------------
// This is a PERMISSION BOUNDARY, not a fee schedule. OpenEMR owns the code
// sets (Clinical Completeness Spec §7) and the app keeps no catalog; what it
// keeps here is which codes a given CREDENTIAL may put its name against.
//
// A9 LCSW bills the behavioural-health set and never E/M. Anything outside the
// list is refused — fail closed, because the failure mode of guessing
// permissively is a claim signed by someone not certified to render it.
const BEHAVIORAL_HEALTH_SERVICE_CODES = Object.freeze([
  '90791', '90792',                               // psychiatric diagnostic evaluation
  '90832', '90834', '90837',                      // psychotherapy, 30 / 45 / 60 min
  '90833', '90836', '90838',                      // psychotherapy add-on
  '90839', '90840',                               // psychotherapy for crisis
  '90846', '90847', '90849', '90853',             // family / group psychotherapy
  '96127',                                        // brief emotional/behavioural assessment
  '96156', '96158', '96159', '96164', '96165', '96167', '96168', // health behaviour assessment/intervention
  'G0177', 'G0409', 'G0410',                      // HCPCS BH services
  'H0031', 'H0032', 'H0034', 'H0038'              // HCPCS behavioural health
]);
// E/M is a range rather than a list; naming it lets the refusal say WHY.
const isEvaluationAndManagementCode = (code) => {
  const s = String(code || '').trim().toUpperCase();
  if (!/^\d{5}$/.test(s)) return false;
  const n = parseInt(s, 10);
  return n >= 99202 && n <= 99499;
};
const isBehavioralHealthCode = (code) =>
  BEHAVIORAL_HEALTH_SERVICE_CODES.includes(String(code || '').trim().toUpperCase());

// Which of these service codes, if any, this credential may not put its name
// against. Returns [] when every code is permitted.
// A service line is either { code } or a bare string. Coalescing with `||`
// falls through to the OBJECT when `code` is an empty string, and
// String({}) is "[object Object]" — which would have been reported back to a
// clinician as a disallowed service code by that name.
const codeOf = (c) => String((c && typeof c === 'object') ? (c.code || '') : (c || '')).trim().toUpperCase();
const disallowedServiceCodesFor = (user, serviceCodes) => {
  const role = resolveClinicalRole(user);
  const codes = (Array.isArray(serviceCodes) ? serviceCodes : []).map(codeOf).filter(Boolean);
  if (!codes.length) return [];
  if (role === CLINICAL_ROLES.PROVIDER) return [];
  if (role === CLINICAL_ROLES.LCSW) return codes.filter(c => !isBehavioralHealthCode(c));
  return codes; // rn, lmsw, readOnly and no role select no service codes at all
};
const serviceCodeRefusal = (user, badCodes) => {
  const role = resolveClinicalRole(user);
  const list = (badCodes || []).join(', ');
  if (role === CLINICAL_ROLES.LCSW) {
    const em = (badCodes || []).filter(isEvaluationAndManagementCode);
    return em.length
      ? `${em.join(', ')} is an evaluation and management code. An LCSW bills the behavioural-health set and never E/M.`
      : `${list} is outside the behavioural-health code set an LCSW may bill.`;
  }
  return `Your clinical credential does not permit selecting service code${(badCodes || []).length === 1 ? '' : 's'} ${list}.`;
};

// ---- Signing an encounter (§3) ------------------------------------------
// THE BILLABLE SIGNATURE IS THE LICENSED CLINICIAN WHO SIGNS, within their
// scope (owner, 2026-09-27). Two tiers:
//
//   BILLABLE SIGNERS — provider (NP/MD) signs anything; an LCSW signs the
//   behavioural-health set. Their signature is the claim's rendering signature.
//
//   AUTHOR SIGNERS — an RN or an LMSW signs their own note as its AUTHOR. That
//   locks the narrative and bills NOTHING: the note waits, "awaiting clinician
//   addendum", until a billable signer adds the required addendum, and THAT
//   addendum is the billable signature (owner, 2026-09-27: "licensed clinician
//   must add addendums to notes saved and signed by the non-billable team
//   member"). This holds whether or not the draft carries codes — any codes on
//   it are confirmed by the clinician at the addendum, never billed on the
//   author's signature.
//
// This reverses the 2026-09-24 rule that an LMSW could not sign at all. The
// invariant that rule protected is kept: a non-billable signature never makes
// a note billable.
const SIGN_OUTCOME = Object.freeze({ ALLOWED: 'allowed', PENDING_CO_SIGN: 'pending_co_sign', REFUSED: 'refused' });
const AUTHOR_SIGNER_ROLES = Object.freeze([CLINICAL_ROLES.RN, CLINICAL_ROLES.LMSW]);
const isAuthorSigner = (user) => AUTHOR_SIGNER_ROLES.includes(resolveClinicalRole(user));
const evaluateEncounterSignature = (user, serviceCodes) => {
  const role = resolveClinicalRole(user);
  const codes = (Array.isArray(serviceCodes) ? serviceCodes : []).map(codeOf).filter(Boolean);
  if (!role || role === CLINICAL_ROLES.READ_ONLY) {
    return { outcome: SIGN_OUTCOME.REFUSED, code: 'SIGN_NO_CREDENTIAL', reason: 'Signing an encounter requires a clinical licence.' };
  }
  if (AUTHOR_SIGNER_ROLES.includes(role)) {
    const label = role === CLINICAL_ROLES.RN ? 'An RN' : 'An LMSW';
    return {
      outcome: SIGN_OUTCOME.PENDING_CO_SIGN, billable: false, clinicalRole: role,
      code: 'SIGN_PENDING_CO_SIGN', signatureRole: 'authoring',
      reason: `${label} signs as the note's author, which locks it but bills nothing. It now waits for a clinician addendum from a provider${codes.length && codes.every(isBehavioralHealthCode) ? ' or an LCSW' : ''} — that addendum is the billable signature.`
    };
  }
  if (!codes.length) return { outcome: SIGN_OUTCOME.ALLOWED, billable: false, clinicalRole: role };
  if (role === CLINICAL_ROLES.PROVIDER) return { outcome: SIGN_OUTCOME.ALLOWED, billable: true, clinicalRole: role };
  if (role === CLINICAL_ROLES.LCSW) {
    const bad = codes.filter(c => !isBehavioralHealthCode(c));
    if (bad.length) {
      return { outcome: SIGN_OUTCOME.REFUSED, code: 'SIGN_CREDENTIAL_CODE_SET', clinicalRole: role, reason: serviceCodeRefusal(user, bad) };
    }
    return { outcome: SIGN_OUTCOME.ALLOWED, billable: true, clinicalRole: role };
  }
  return { outcome: SIGN_OUTCOME.REFUSED, code: 'SIGN_NO_CREDENTIAL', reason: 'Signing an encounter requires a clinical licence.' };
};
// Who may add the BILLABLE clinician addendum that clears an author's hold.
// The addendum author's scope is then checked against the codes with
// evaluateEncounterSignature, so an LCSW can only bill the behavioural-health set.
const CO_SIGN_ROLES = Object.freeze([CLINICAL_ROLES.LCSW, CLINICAL_ROLES.PROVIDER]);
const canCoSignEncounter = (user) => CO_SIGN_ROLES.includes(resolveClinicalRole(user));
// A CO-SIGNATURE on a signed note (owner: "all clinicians") attests
// participation and review. It never changes who bills, so it is open to every
// licensed clinical role; unlicensed read-only staff cannot attest a note.
const canCoSignNote = (user) => LICENSED_CLINICAL_ROLES.includes(resolveClinicalRole(user));
// BILLING (owner, 2026-09-29): after a clinician signs, the codes, the modifiers
// and the place of service belong to billing, and billing submits the claim.
// Until a dedicated billing role exists (B-series `hasBillingAccess`), billing
// is an admin or a manager. This is deliberately NOT a clinical role: it is the
// only thing that may see or change a place of service, and a clinician never
// can. One predicate, read by every billing route and served to the page.
const canSubmitBilling = (user) => !!user && user.accountStatus !== 'inactive' &&
  (user.role === 'admin' || user.isManager === true);

// WHERE AN ORDER GOES (owner, 2026-09-29): the receiving agency, practice or
// supplier is usually confirmed AFTER the clinician places the order, by
// whoever is on the phone with the agency. That is the office and social work,
// not only the ordering clinician. This is deliberately NOT a clinical
// capability and NOT the read/write split: a case manager stays read-only
// everywhere else, and this one predicate is the only door that lets them
// touch an order — and only its destination fields (orderRequisitions).
// Admin, a manager, a case manager, or any licensed clinical role.
const canEditOrderDestination = (user) => !!user && user.accountStatus !== 'inactive' &&
  (user.role === 'admin' || user.role === 'caseManager' || user.isManager === true ||
    LICENSED_CLINICAL_ROLES.includes(resolveClinicalRole(user)));

// ---- Patient to-dos (owner, 2026-10-13) ----------------------------------
// Who may write, complete and be assigned a patient to-do: the same people who
// may update an order's destination — admin, a manager, a case manager, or any
// licensed clinician. A case manager stays read-only on the chart; this is the
// one more door they hold. Visibility of each to-do is decided per row in
// clinicalTasks.canSee (assignee and author only), not here.
const canManageTasks = (user) => canEditOrderDestination(user);

// ---- A mental health diagnosis (owner, 2026-10-12) ----------------------
// An LCSW diagnoses behavioural and mental health conditions on their own
// licence; an LMSW does not. ICD-10-CM chapter 5 (F01–F99) is that set. The
// rest of the problem list stays an RN's or a provider's, so an LCSW adding
// "Type 2 diabetes" is refused by name.
const isBehavioralHealthDiagnosis = (code) =>
  /^F\d{2}/.test(String(code || '').trim().toUpperCase().replace(/^ICD10:/, ''));
const canAddProblem = (user, icd10) => {
  if (can(user, CAPABILITIES.PROBLEM_LIST_WRITE)) return true;
  return can(user, CAPABILITIES.BEHAVIORAL_DIAGNOSIS) && isBehavioralHealthDiagnosis(icd10);
};
const problemRefusal = (user, icd10) => ({
  error: can(user, CAPABILITIES.BEHAVIORAL_DIAGNOSIS)
    ? `${String(icd10 || '').trim() ? `${String(icd10).toUpperCase()} is not` : 'A problem with no ICD-10 code is not'} a mental health diagnosis. An LCSW adds F codes (F01–F99); other diagnoses are added by an RN or a provider.`
    : CAPABILITY_REASONS.problemListWrite,
  code: 'CLINICAL_CREDENTIAL',
  capability: CAPABILITIES.PROBLEM_LIST_WRITE,
  clinicalRole: resolveClinicalRole(user)
});

// ---- Working an order through (owner, 2026-10-12) -----------------------
// Faxing, recording the appointment, filing the result and cancelling are
// operational steps. An RN or a provider does them on any order. Everyone who
// coordinates referrals (LCSW, LMSW) does them on a REFERRAL, which is what
// case management is; a lab, imaging, procedure or DME order stays with the
// RN and the provider.
const isReferral = (order) => !!order && order.orderType === 'referral';
const canCoordinateOrder = (user, order) => {
  if (!order) return false;
  if (can(user, CAPABILITIES.ORDER_STATUS_ADVANCE)) return true;
  return isReferral(order) && can(user, CAPABILITIES.REFERRAL_COORDINATION);
};
const coordinationRefusal = (user, order) => ({
  error: isReferral(order)
    ? CAPABILITY_REASONS.referralCoordination
    : 'Working a lab, imaging, procedure or equipment order through is limited to an RN or a provider. Social work coordinates referrals.',
  code: 'CLINICAL_CREDENTIAL',
  capability: isReferral(order) ? CAPABILITIES.REFERRAL_COORDINATION : CAPABILITIES.ORDER_STATUS_ADVANCE,
  clinicalRole: resolveClinicalRole(user)
});

// ---- Referring a patient (owner, 2026-10-12) ----------------------------
// WHERE a referral goes decides who may place it. Inside the team: any
// licensed role. Out to another practice: a provider (who may order anything)
// or an LCSW (an independent practitioner). Never under a standing order: a
// referral is not a protocol test, and STANDING_ORDER_TYPES still excludes it.
const REFERRAL_DESTINATIONS = Object.freeze(['internal', 'external']);
const canRefer = (user, destination) => {
  if (destination === 'internal') return can(user, CAPABILITIES.REFER_INTERNAL);
  if (destination === 'external') {
    return can(user, CAPABILITIES.ORDER_DIRECT) || can(user, CAPABILITIES.REFER_EXTERNAL);
  }
  return false;
};
const referralRefusal = (user, destination) => refusalFor(user,
  destination === 'internal' ? CAPABILITIES.REFER_INTERNAL : CAPABILITIES.REFER_EXTERNAL);
// Who a patient may be referred TO inside GFC: an active account carrying a
// licensed clinical role. An office admin account is skipped unless it has an
// NPI on file, because admin resolves to `provider` for the owner's sake and
// the office login is not a clinician anyone should be referred to.
const isReferralTarget = (user) => {
  if (!user || user.accountStatus === 'inactive') return false;
  if (!LICENSED_CLINICAL_ROLES.includes(resolveClinicalRole(user))) return false;
  if (user.role === 'admin') return /^\d{10}$/.test(String(user.npi || '').replace(/\D/g, ''));
  return true;
};

// ---- Care-plan signature branches on the SERVICE LINE (§3) --------------
//   Track A / PHC  → an RN signature satisfies the care plan
//   IHPC / clinical → a provider signature is required; an RN signature is
//                     recorded as the AUTHORING signature and the plan stays
//                     pending provider co-signature
const CARE_PLAN_OUTCOME = Object.freeze({ COMPLETE: 'complete', PENDING_PROVIDER: 'pending_provider_cosign', REFUSED: 'refused' });
const isClinicalLine = (serviceLine) => ['IHPC', 'BOTH'].includes(String(serviceLine || 'PHC').toUpperCase());
const evaluateCarePlanSignature = (user, serviceLine) => {
  const role = resolveClinicalRole(user);
  if (!role || role === CLINICAL_ROLES.READ_ONLY) {
    return { outcome: CARE_PLAN_OUTCOME.REFUSED, code: 'CARE_PLAN_NO_CREDENTIAL', reason: 'Authoring a care plan requires a clinical licence.' };
  }
  if (role === CLINICAL_ROLES.LMSW) {
    // A10 authors and never completes a signature alone.
    return {
      outcome: CARE_PLAN_OUTCOME.PENDING_PROVIDER, clinicalRole: role, signatureRole: 'authoring',
      reason: 'An LMSW authors a care plan; it is held for co-signature by an LCSW or a provider.'
    };
  }
  if (role === CLINICAL_ROLES.PROVIDER) return { outcome: CARE_PLAN_OUTCOME.COMPLETE, clinicalRole: role, signatureRole: 'signing' };
  if (role === CLINICAL_ROLES.RN) {
    return isClinicalLine(serviceLine)
      ? {
          outcome: CARE_PLAN_OUTCOME.PENDING_PROVIDER, clinicalRole: role, signatureRole: 'authoring',
          reason: 'This client is on the clinical service line, so the care plan needs a provider co-signature. The RN signature is recorded as the authoring signature.'
        }
      : { outcome: CARE_PLAN_OUTCOME.COMPLETE, clinicalRole: role, signatureRole: 'signing' };
  }
  // LCSW — independently licensed, signs their own plan on either line.
  return { outcome: CARE_PLAN_OUTCOME.COMPLETE, clinicalRole: role, signatureRole: 'signing' };
};
const canCoSignCarePlan = (user) => CO_SIGN_ROLES.includes(resolveClinicalRole(user));

// ---- The credential ceiling (§4) ---------------------------------------
// A standing order GRANTS authority; it cannot CREATE authority a licence does
// not carry. This is checked SEPARATELY from the protocol's own
// permittedExecutorRoles, so a mis-authored protocol that names an LMSW and
// permits a CBC is refused at execution. A provider's signature on a document
// is not a licence extension.
//
// `screening` covers instrument administration — PHQ-9, GAD-7, SDOH,
// fall-risk, cognitive screens. It is the order type GFC's LMSW case managers
// actually work under.
const STANDING_ORDER_TYPES = Object.freeze(['lab', 'imaging', 'procedure', 'screening']);
const CREDENTIAL_CEILING = Object.freeze({
  provider: Object.freeze(['lab', 'imaging', 'procedure', 'screening']),
  rn: Object.freeze(['lab', 'imaging', 'procedure', 'screening']),
  lcsw: Object.freeze(['screening']),
  lmsw: Object.freeze(['screening']),
  readOnly: Object.freeze([])
});
const ceilingFor = (roleOrUser) => {
  const role = typeof roleOrUser === 'string' ? roleOrUser : resolveClinicalRole(roleOrUser);
  return CREDENTIAL_CEILING[role] || [];
};
const withinCredentialCeiling = (roleOrUser, orderTypes) => {
  const allowed = ceilingFor(roleOrUser);
  const types = (Array.isArray(orderTypes) ? orderTypes : [orderTypes]).map(t => String(t || '').trim()).filter(Boolean);
  const outside = types.filter(t => !allowed.includes(t));
  return { ok: outside.length === 0, outside, allowed };
};

// ---- Migration (§2) -----------------------------------------------------
// Map every existing hasClinicalAccess:true user to `provider`, preserving
// today's behaviour EXACTLY. Nobody is silently downgraded; the boot warning
// names every auto-mapped user so an admin reassigns the RNs deliberately.
//
// A CASE MANAGER maps to `lmsw`. 4.8 held them at `readOnly` and named them
// for a decision because lmsw widens what they may do; the owner made that
// decision on 2026-10-12 (case managers and counselors are LMSW).
const migrationRoleFor = (user) => {
  if (!user) return null;
  if (isValidClinicalRole(user.clinicalRole)) return String(user.clinicalRole);
  if (user.role === 'admin') return CLINICAL_ROLES.PROVIDER;
  if (user.role === 'caseManager') return CLINICAL_ROLES.LMSW;
  if (user.hasClinicalAccess) return CLINICAL_ROLES.PROVIDER;
  return null;
};

// ---- Case managers become LMSW (owner, 2026-10-12) ----------------------
// The 4.8 migration left every case manager at `readOnly` on purpose and named
// them for a decision. The owner made it: case managers and counselors are
// LMSW. This moves each case manager still stored as `readOnly` to `lmsw`,
// ONCE. The marker is what keeps it once: an admin who later sets somebody
// back to readOnly deliberately is not overridden on the next boot.
const CASE_MANAGER_LMSW_MARKER = '2026-10-12';
const applyCaseManagerLmswMigration = (users, at) => {
  const out = [];
  const changed = [];
  const now = at || new Date().toISOString();
  for (const u of Array.isArray(users) ? users : []) {
    if (!u || typeof u !== 'object' || u.role !== 'caseManager' ||
        u.caseManagerLmswMigration || String(u.clinicalRole || '') !== CLINICAL_ROLES.READ_ONLY) {
      out.push(u);
      continue;
    }
    out.push({
      ...u, clinicalRole: CLINICAL_ROLES.LMSW, hasClinicalAccess: true,
      clinicalRoleAutoAssigned: false,
      caseManagerLmswMigration: { version: CASE_MANAGER_LMSW_MARKER, at: now, from: CLINICAL_ROLES.READ_ONLY }
    });
    changed.push({ id: u.id, name: u.name || '(no name)', clinicalRole: CLINICAL_ROLES.LMSW });
  }
  return { users: out, changed };
};
// Returns { users, changed, warnings } — pure, so the boot path and the tests
// exercise the same function.
const applyClinicalRoleMigration = (users) => {
  const out = [];
  const changed = [];
  for (const u of Array.isArray(users) ? users : []) {
    if (!u || typeof u !== 'object') { out.push(u); continue; }
    if (isValidClinicalRole(u.clinicalRole)) { out.push(u); continue; }
    const role = migrationRoleFor(u);
    if (!role) { out.push(u); continue; }
    // The auto-assigned marker is what makes the warning STAND. Cleared the
    // moment an admin sets the role deliberately (the user PUT clears it), so
    // the reminder stops when the review actually happens rather than when the
    // migration happens to finish.
    out.push({
      ...u, clinicalRole: role, clinicalRoleAutoAssigned: true,
      hasClinicalAccess: role !== CLINICAL_ROLES.READ_ONLY ? true : !!u.hasClinicalAccess
    });
    changed.push({ id: u.id, name: u.name || '(no name)', email: u.email || '(no email)', role: u.role, clinicalRole: role });
  }
  return { users: out, changed };
};
// The boot warning. It lists each user BY NAME AND EMAIL — a reassignment
// nobody can find is a reassignment that never happens.
// Who is still sitting on a role nobody reviewed. A one-off print at migration
// time is a warning that scrolls past; this one prints at every boot until an
// admin has actually been through them.
const usersPendingRoleReview = (users) => (Array.isArray(users) ? users : [])
  .filter(u => u && u.clinicalRoleAutoAssigned && isValidClinicalRole(u.clinicalRole))
  .map(u => ({ id: u.id, name: u.name || '(no name)', email: u.email || '(no email)', role: u.role, clinicalRole: u.clinicalRole }));
const buildPendingReviewWarning = (pending) => {
  const rows = Array.isArray(pending) ? pending : [];
  if (!rows.length) return null;
  const lines = [
    `⚠️  SESSION 4.8 — ${rows.length} clinical role${rows.length === 1 ? ' is' : 's are'} still the value the migration guessed.`,
    '   Everyone who had clinical access was mapped to PROVIDER, which carries',
    '   prescribing, direct ordering and signing billable encounters. Confirm or',
    '   change each one at Admin hub → Users → Clinical role; this notice stops',
    '   when they have been reviewed.'
  ];
  for (const r of rows) lines.push(`     • ${r.name} <${r.email}> → ${r.clinicalRole}`);
  return lines.join('\n');
};
const buildMigrationWarning = (changed) => {
  const rows = Array.isArray(changed) ? changed : [];
  if (!rows.length) return null;
  const providers = rows.filter(r => r.clinicalRole === CLINICAL_ROLES.PROVIDER);
  const lmsw = rows.filter(r => r.clinicalRole === CLINICAL_ROLES.LMSW);
  const readOnly = rows.filter(r => r.clinicalRole === CLINICAL_ROLES.READ_ONLY);
  const lines = [
    '⚠️  SESSION 4.8 — clinical roles were assigned automatically. REVIEW THEM.',
    '   Clinical access used to be one boolean, so the migration cannot tell an',
    '   RN from an FNP. Everyone who had clinical access is now a PROVIDER,',
    '   which preserves what they could do this morning — including prescribing,',
    '   placing orders and signing billable encounters. Reassign the RNs before',
    '   they next work: Admin hub → Users → Clinical role.'
  ];
  if (providers.length) {
    lines.push(`   Mapped to PROVIDER (${providers.length}):`);
    for (const r of providers) lines.push(`     • ${r.name} <${r.email}>`);
  }
  if (lmsw.length) {
    lines.push(`   Case managers mapped to LMSW (${lmsw.length}) — owner rule, 2026-10-12:`);
    for (const r of lmsw) lines.push(`     • ${r.name} <${r.email}>`);
  }
  if (readOnly.length) {
    lines.push(`   Mapped to READ-ONLY (${readOnly.length}):`);
    for (const r of readOnly) lines.push(`     • ${r.name} <${r.email}>`);
  }
  return lines.join('\n');
};

module.exports = {
  CLINICAL_ROLES,
  ALL_CLINICAL_ROLES,
  LICENSED_CLINICAL_ROLES,
  CLINICAL_ROLE_LABELS,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  CAPABILITY_REASONS,
  isValidClinicalRole,
  resolveClinicalRole,
  derivedHasClinicalAccess,
  can,
  capabilitiesFor,
  refusalFor,
  canClinicalRead,
  canClinicalWrite,
  BEHAVIORAL_HEALTH_SERVICE_CODES,
  isEvaluationAndManagementCode,
  isBehavioralHealthCode,
  disallowedServiceCodesFor,
  serviceCodeRefusal,
  SIGN_OUTCOME,
  AUTHOR_SIGNER_ROLES,
  isAuthorSigner,
  evaluateEncounterSignature,
  CO_SIGN_ROLES,
  canCoSignEncounter,
  canCoSignNote,
  canSubmitBilling,
  canEditOrderDestination,
  canManageTasks,
  isBehavioralHealthDiagnosis,
  canAddProblem,
  problemRefusal,
  canCoordinateOrder,
  coordinationRefusal,
  REFERRAL_DESTINATIONS,
  canRefer,
  referralRefusal,
  isReferralTarget,
  CASE_MANAGER_LMSW_MARKER,
  applyCaseManagerLmswMigration,
  CARE_PLAN_OUTCOME,
  evaluateCarePlanSignature,
  canCoSignCarePlan,
  isClinicalLine,
  STANDING_ORDER_TYPES,
  CREDENTIAL_CEILING,
  ceilingFor,
  withinCredentialCeiling,
  migrationRoleFor,
  applyClinicalRoleMigration,
  buildMigrationWarning,
  usersPendingRoleReview,
  buildPendingReviewWarning
};
