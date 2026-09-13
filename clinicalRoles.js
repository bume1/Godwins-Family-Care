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
  LCSW: 'lcsw',           // independently licensed clinical social worker (archetype A9)
  LMSW: 'lmsw',           // master's-level SW requiring supervision (A10) — GFC's case managers
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
  lcsw: 'LCSW (independently licensed)',
  lmsw: 'LMSW (supervised — case manager)',
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
  AUTHOR_STANDING_ORDER: 'authorStandingOrder' // only a provider signs a protocol (§4 rule 1)
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
    'authorStandingOrder'
  ]),
  rn: Object.freeze([
    'chartRead', 'vitalsWrite', 'nursingNote', 'screeningInstrument',
    'carePlanAuthor', 'carePlanSign', 'medRec', 'problemListWrite', 'documentUpload',
    'scheduling', 'orderStatusAdvance', 'orderStanding'
  ]),
  lcsw: Object.freeze([
    'chartRead', 'behavioralNote', 'screeningInstrument',
    'carePlanAuthor', 'carePlanSign', 'documentUpload', 'scheduling',
    'orderStanding', 'selectServiceCodes', 'signBillableEncounter'
  ]),
  lmsw: Object.freeze([
    'chartRead', 'behavioralNote', 'screeningInstrument',
    'carePlanAuthor', 'documentUpload', 'scheduling', 'orderStanding'
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
  // A case manager reads and never writes, flag or no flag (the 4.3 rule).
  if (user.role === 'caseManager') return CLINICAL_ROLES.READ_ONLY;
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

// ---- Signing a billable encounter (§3) ----------------------------------
// GATE ON WHAT IS BEING ATTESTED, not only on who is asking.
//   • carries any CPT/service code → provider (LCSW for the BH set only)
//   • no service codes (nursing documentation) → rn or provider may sign
//   • LMSW carrying a service code → signs, but the encounter is pendingCoSign
//     and is not billable until an LCSW or provider co-signs (A10 bills
//     nothing independently)
const SIGN_OUTCOME = Object.freeze({ ALLOWED: 'allowed', PENDING_CO_SIGN: 'pending_co_sign', REFUSED: 'refused' });
const evaluateEncounterSignature = (user, serviceCodes) => {
  const role = resolveClinicalRole(user);
  const codes = (Array.isArray(serviceCodes) ? serviceCodes : []).map(codeOf).filter(Boolean);
  if (!role || role === CLINICAL_ROLES.READ_ONLY) {
    return { outcome: SIGN_OUTCOME.REFUSED, code: 'SIGN_NO_CREDENTIAL', reason: 'Signing an encounter requires a clinical licence.' };
  }
  if (!codes.length) {
    // Nursing documentation. Everyone licensed may attest their own note.
    return { outcome: SIGN_OUTCOME.ALLOWED, billable: false, clinicalRole: role };
  }
  if (role === CLINICAL_ROLES.PROVIDER) return { outcome: SIGN_OUTCOME.ALLOWED, billable: true, clinicalRole: role };
  if (role === CLINICAL_ROLES.RN) {
    return {
      outcome: SIGN_OUTCOME.REFUSED, code: 'SIGN_CREDENTIAL_BILLABLE', clinicalRole: role,
      reason: `This encounter carries a billable service code (${codes.join(', ')}), so it must be signed by a provider. An RN may sign a nursing note that carries no service code.`
    };
  }
  if (role === CLINICAL_ROLES.LCSW) {
    const bad = codes.filter(c => !isBehavioralHealthCode(c));
    if (bad.length) {
      return { outcome: SIGN_OUTCOME.REFUSED, code: 'SIGN_CREDENTIAL_CODE_SET', clinicalRole: role, reason: serviceCodeRefusal(user, bad) };
    }
    return { outcome: SIGN_OUTCOME.ALLOWED, billable: true, clinicalRole: role };
  }
  // LMSW — signs, but nothing bills until a supervising credential co-signs.
  return {
    outcome: SIGN_OUTCOME.PENDING_CO_SIGN, billable: false, clinicalRole: role,
    code: 'SIGN_PENDING_CO_SIGN',
    reason: 'An LMSW bills nothing independently. The encounter is signed and held for co-signature by an LCSW or a provider before any charge posts.'
  };
};
// Who may clear a pendingCoSign encounter.
const CO_SIGN_ROLES = Object.freeze([CLINICAL_ROLES.LCSW, CLINICAL_ROLES.PROVIDER]);
const canCoSignEncounter = (user) => CO_SIGN_ROLES.includes(resolveClinicalRole(user));

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
// A CASE MANAGER maps to `readOnly`, not to `lmsw`, even though GFC's case
// managers ARE LMSW (owner, 2026-09-13). Auto-assigning lmsw would WIDEN them
// — care-plan authoring, document upload, screening execution — and a
// migration must not hand anyone a write they did not have this morning. They
// are named in the warning for deliberate reassignment.
const migrationRoleFor = (user) => {
  if (!user) return null;
  if (isValidClinicalRole(user.clinicalRole)) return String(user.clinicalRole);
  if (user.role === 'admin') return CLINICAL_ROLES.PROVIDER;
  if (user.role === 'caseManager') return CLINICAL_ROLES.READ_ONLY;
  if (user.hasClinicalAccess) return CLINICAL_ROLES.PROVIDER;
  return null;
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
  if (readOnly.length) {
    lines.push(`   Mapped to READ-ONLY — unchanged from today (${readOnly.length}):`);
    for (const r of readOnly) lines.push(`     • ${r.name} <${r.email}>`);
    lines.push("   GFC's case managers are LMSW (owner, 2026-09-13). Assigning them");
    lines.push('   `lmsw` widens what they may do, so it is a deliberate admin action,');
    lines.push('   not something this migration does on their behalf.');
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
  evaluateEncounterSignature,
  CO_SIGN_ROLES,
  canCoSignEncounter,
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
