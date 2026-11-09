// ============================================================================
// accountTypes.js — WHAT KIND OF ACCOUNT THIS IS, decided in one place.
//
// OWNER, 2026-10-15: "before we even choose who gets what message, let us get
// our user account types and permission straight."
//
// An account used to be set up with TWO pickers that could disagree: a Role
// dropdown ("Clinical (FNP)", "Case Manager", "Manager" ...) and a separate
// Clinical role dropdown, plus three lab-era checkboxes. Different parts of
// the app read different ones. An LMSW set up as "Clinical (FNP)" messaged
// like a provider; the same LMSW set up as "Case Manager" messaged like a case
// manager. A care coordinator was quietly stored as a case manager.
//
// Now there is ONE choice, the account type, and it sets every stored field
// the rest of the app reads (role, isManager, clinicalRole, hasClinicalAccess).
// Those fields stay, because hundreds of readers depend on them; what changes
// is that nothing sets them independently any more.
//
// The ten types, and what each is (owner, 2026-10-15):
//   admin        Super Admin. Everything.
//   manager      Runs scheduling, billing and patient account management.
//                Clinical workspace: View only by default; an admin can turn
//                it off or grant chart editing on the user form.
//   provider     FNP / MD / PA.
//   rn           Registered nurse.
//   lcsw         Licensed clinical social worker.
//   lmsw         LMSW / Case Manager. Every case manager is an LMSW.
//   coordinator  Care Coordinator: a manager's permissions plus clinical chart
//                writing and editing. Does not sign (no clinical licence).
//   caregiver    Private home care caregiver (plus a licence level).
//   client       The patient.
//   family       Family / authorized contact (plus the POA checkbox).
//
// Pure: no I/O. server.js, the boot migration and the tests all call these.
// ============================================================================

const TYPES = Object.freeze({
  ADMIN: 'admin',
  MANAGER: 'manager',
  PROVIDER: 'provider',
  RN: 'rn',
  LCSW: 'lcsw',
  LMSW: 'lmsw',
  COORDINATOR: 'coordinator',
  CAREGIVER: 'caregiver',
  LIAISON: 'liaison',
  CLIENT: 'client',
  FAMILY: 'family'
});

// The order the user form lists them in.
const ACCOUNT_TYPES = Object.freeze([
  { value: TYPES.ADMIN, label: 'Super Admin', staff: true },
  { value: TYPES.MANAGER, label: 'Manager', staff: true },
  { value: TYPES.PROVIDER, label: 'Provider (FNP / MD / PA)', staff: true },
  { value: TYPES.RN, label: 'RN', staff: true },
  { value: TYPES.LCSW, label: 'LCSW', staff: true },
  { value: TYPES.LMSW, label: 'LMSW / Case Manager', staff: true },
  { value: TYPES.COORDINATOR, label: 'Care Coordinator', staff: true },
  { value: TYPES.CAREGIVER, label: 'Caregiver', staff: true },
  { value: TYPES.LIAISON, label: 'Community Care Liaison', staff: true },
  { value: TYPES.CLIENT, label: 'Client', staff: false },
  { value: TYPES.FAMILY, label: 'Family / Authorized Contact', staff: false }
].map(Object.freeze));
const ALL_TYPES = Object.freeze(ACCOUNT_TYPES.map(t => t.value));
const isValidType = (v) => ALL_TYPES.includes(String(v || ''));

// A manager's clinical workspace access. Stored as the manager's clinicalRole,
// so every existing clinical gate already answers correctly:
//   none → no clinical role (no chart access, no Clinical Workspace tile)
//   view → readOnly (reads charts, writes nothing)        ← the default
//   edit → coordinator (writes and edits notes and charts; never signs)
// "Keep the view only designation just in case" (owner, 2026-10-15) is the
// `view` level here.
const MANAGER_CLINICAL_ACCESS = Object.freeze([
  { value: 'none', label: 'No access', clinicalRole: null },
  { value: 'view', label: 'View only', clinicalRole: 'readOnly' },
  { value: 'edit', label: 'View and edit charts', clinicalRole: 'coordinator' }
].map(Object.freeze));
const DEFAULT_MANAGER_CLINICAL_ACCESS = 'view';
const isValidManagerAccess = (v) => MANAGER_CLINICAL_ACCESS.some(a => a.value === v);

// The licensed clinical types — the ones that land straight in /clinical.
const CLINICIAN_TYPES = Object.freeze([TYPES.PROVIDER, TYPES.RN, TYPES.LCSW, TYPES.LMSW]);

// ---- The stored fields each type sets --------------------------------------
// The one mapping. `role` and `isManager` are the legacy account fields,
// `clinicalRole` is clinicalRoles.js's authority, and hasClinicalAccess is
// derived from it (licensed roles only) exactly as clinicalRoles does.
const LICENSED = ['provider', 'rn', 'lcsw', 'lmsw'];
function fieldsFor(type, { managerClinicalAccess } = {}) {
  const t = String(type || '');
  const base = (role, isManager, clinicalRole) => ({
    accountType: t, role, isManager, clinicalRole,
    hasClinicalAccess: LICENSED.includes(clinicalRole)
  });
  switch (t) {
    case TYPES.ADMIN: return base('admin', false, null);
    case TYPES.MANAGER: {
      const level = isValidManagerAccess(managerClinicalAccess) ? managerClinicalAccess : DEFAULT_MANAGER_CLINICAL_ACCESS;
      const access = MANAGER_CLINICAL_ACCESS.find(a => a.value === level);
      return { ...base('user', true, access.clinicalRole), managerClinicalAccess: level };
    }
    case TYPES.PROVIDER: return base('user', false, 'provider');
    case TYPES.RN: return base('user', false, 'rn');
    case TYPES.LCSW: return base('user', false, 'lcsw');
    // Every case manager is an LMSW (owner, 2026-10-15), so this type is the
    // case-manager account: role caseManager, clinical role lmsw.
    case TYPES.LMSW: return base('caseManager', false, 'lmsw');
    // A coordinator is a manager plus chart editing (owner, 2026-10-15). They
    // are stored as a manager so every manager gate (scheduling, billing,
    // caregiver management) admits them with no second rule to keep in step.
    case TYPES.COORDINATOR: return base('user', true, 'coordinator');
    case TYPES.CAREGIVER: return base('vendor', false, null);
    // Community Care Liaison (owner, 2026-11-08): My GFC and the enrollment
    // summary of the clients assigned to them. No clinical role, no hub.
    case TYPES.LIAISON: return base('liaison', false, null);
    case TYPES.CLIENT: return base('client', false, null);
    case TYPES.FAMILY: return base('family', false, null);
    default: return null;
  }
}

// ---- Reading a record back -------------------------------------------------
// The stored `accountType` wins when it agrees with the fields it set. When it
// is absent (a record written before this change) the type is derived from
// the fields, and `null` means the record does not map cleanly onto any type
// and needs an admin to choose one.
function deriveType(u) {
  if (!u) return null;
  const role = u.role;
  const cr = u.clinicalRole || null;
  if (role === 'admin') return TYPES.ADMIN;
  if (role === 'client') return TYPES.CLIENT;
  if (role === 'family') return TYPES.FAMILY;
  if (role === 'vendor') return TYPES.CAREGIVER;
  if (role === 'liaison') return TYPES.LIAISON;
  // A care coordinator used to be stored as a case manager.
  if (cr === 'coordinator') return u.isManager && u.accountType === TYPES.MANAGER ? TYPES.MANAGER : TYPES.COORDINATOR;
  // A case manager is an LMSW. One an admin deliberately set to read-only (or
  // anything else) is NOT widened here: that is flagged for an admin to choose.
  if (role === 'caseManager') return (!cr || cr === 'lmsw') ? TYPES.LMSW : null;
  if (u.isManager) return TYPES.MANAGER;
  if (role === 'user') {
    if (cr === 'provider' || cr === 'rn' || cr === 'lcsw' || cr === 'lmsw') return cr;
    // A clinical account from before Session 4.8 with no stored role reads as
    // a provider everywhere else in the app (clinicalRoles.resolveClinicalRole).
    if (!cr && u.hasClinicalAccess) return TYPES.PROVIDER;
  }
  return null;
}

function managerAccessOf(u) {
  if (!u) return null;
  if (isValidManagerAccess(u.managerClinicalAccess)) return u.managerClinicalAccess;
  const cr = u.clinicalRole || null;
  const hit = MANAGER_CLINICAL_ACCESS.find(a => a.clinicalRole === cr);
  return hit ? hit.value : null;
}

function accountTypeOf(u) {
  if (!u) return null;
  if (isValidType(u.accountType)) return u.accountType;
  return deriveType(u);
}

// Does a stored record already carry exactly what its type sets?
function isConsistent(u) {
  const type = accountTypeOf(u);
  if (!type) return false;
  const want = fieldsFor(type, { managerClinicalAccess: managerAccessOf(u) });
  return u.role === want.role && !!u.isManager === want.isManager &&
    (u.clinicalRole || null) === want.clinicalRole;
}

// ---- Where each type lands on sign-in --------------------------------------
// `null` means the Portal Hub: the Super Admin's launcher, and the manager's
// and coordinator's (Clinical Workspace + Private Home Care).
function landingFor(u) {
  const type = accountTypeOf(u);
  // A record waiting on an admin to choose its type keeps the clinical
  // landing it had, rather than losing its way in on sign-in.
  if (!type) return (u && (u.clinicalRole || u.role === 'caseManager')) ? '/clinical' : null;
  if (type === TYPES.CLIENT) return u.slug ? `/portal/${u.slug}` : '/portal';
  if (type === TYPES.FAMILY) return '/portal';
  if (CLINICIAN_TYPES.includes(type)) return '/clinical';
  if (type === TYPES.CAREGIVER) return u.licenseLevel ? '/caregiver' : null;
  // A liaison lands straight in My GFC (owner, 2026-11-08).
  if (type === TYPES.LIAISON) return '/my';
  return null;   // admin, manager, coordinator → the hub
}

// ---- The hub tiles each type sees ------------------------------------------
// Only a Super Admin sees the Admin Hub, the Client Portal Admin and the
// Service Portal (owner, 2026-10-15: "until we revise these areas").
// Private Home Care opens to Caregiver Management and Caregiver Scheduling.
const PRIVATE_HOME_CARE = Object.freeze([
  Object.freeze({ id: 'caregiverManagement', name: 'Caregiver Management', path: '/caregivers',
    description: 'Escalations, visit log review, incidents, documents and the caregiver feed' }),
  Object.freeze({ id: 'caregiverScheduling', name: 'Caregiver Scheduling', path: '/scheduling',
    description: 'Shifts, availability, time tracking, payroll and client locations' })
]);
// ---- People (owner, 2026-11-08; Enrollment moved in, owner, 2026-11-09) ----
// User Management moved out of the Admin Hub into its own block, beside staff
// onboarding: the same shape as Private Home Care. User Management still runs
// on the Admin Hub page, opened straight to that view. Staff Onboarding's
// office side is admin-or-manager (routes/onboarding.js), so the tile appears
// for exactly those accounts.
//
// Enrollment used to sit beside People as its own top-level tile (owner,
// 2026-10-15, "Enrollment and Billing are modules of their own"). The owner
// reversed that on 2026-11-09: enrollment is how a CLIENT becomes a person in
// this system, the same job User Management and Staff Onboarding do for
// everyone else, so it belongs where those live. Billing is untouched — it is
// a money module, not a people one, and stays its own top-level tile.
const PEOPLE_USERS = Object.freeze({ id: 'users', name: 'User Management', path: '/admin?view=users',
  description: 'Add and edit staff, caregivers, clients and family contacts' });
const PEOPLE_ENROLLMENT = Object.freeze({ id: 'enrollment', name: 'Enrollment', path: '/admin/enrollment',
  description: 'Client enrollment, consents and documents' });
const PEOPLE_ONBOARDING = Object.freeze({ id: 'onboarding', name: 'Staff Onboarding', path: '/onboarding',
  description: 'Who is onboarding, whose turn it is, credentialing and readiness' });
const MY_GFC = Object.freeze({ id: 'myGfc', name: 'My GFC', path: '/my',
  description: 'Your onboarding, documents, policies and shared folders' });
function peopleTile(u) {
  // Enrollment keeps the same visibility it had as a standalone tile: every
  // account type that reaches this function (admin, manager, coordinator).
  const children = [PEOPLE_USERS, PEOPLE_ENROLLMENT];
  if (u && (u.role === 'admin' || u.isManager === true)) children.push(PEOPLE_ONBOARDING);
  return { id: 'people', name: 'People', children };
}

function hubTilesFor(u) {
  const type = accountTypeOf(u);
  const tiles = [];
  const clinical = { id: 'clinical', name: 'Clinical Workspace', path: '/clinical' };
  const phc = { id: 'privateHomeCare', name: 'Private Home Care', children: PRIVATE_HOME_CARE };
  // Billing stays its own module (owner, 2026-10-15); Enrollment moved into
  // People (owner, 2026-11-09) — see the People section above.
  const billingTile = { id: 'billing', name: 'Billing', path: '/billing' };
  // Managers and coordinators read Support and Admin Broadcasts here; the
  // Super Admin's inbox is in the Admin Hub.
  const messages = { id: 'messages', name: 'Messages', path: '/messages' };
  // User Management and Enrollment now sit inside People (owner, 2026-11-08
  // and 2026-11-09). A manager or care coordinator still reaches only User
  // Management in the Admin Hub.
  const people = peopleTile(u);
  // My GFC, the staff portal (owner, 2026-11-08): everyone's own onboarding,
  // documents, policies and shared Drive folders. First, because it is theirs.
  if ([TYPES.ADMIN, TYPES.MANAGER, TYPES.COORDINATOR].includes(type)) tiles.push(MY_GFC);
  if (type === TYPES.ADMIN) {
    tiles.push({ id: 'admin', name: 'Admin Hub', path: '/admin' }, people, clinical, phc, billingTile,
      { id: 'service', name: 'Service Portal', path: '/service-portal' },
      { id: 'clientPortalAdmin', name: 'Client Portal Admin', path: '/portal' });
  } else if (type === TYPES.COORDINATOR) {
    tiles.push(clinical, phc, billingTile, messages, people);
  } else if (type === TYPES.MANAGER) {
    if (managerAccessOf(u) !== 'none' && u.clinicalRole) tiles.push(clinical);
    tiles.push(phc, billingTile, messages, people);
  }
  return tiles;
}

// ---- Who runs private home care day to day -------------------------------
// Owner decision, 2026-11-03: managers and care coordinators run private home
// care, alongside the Super Admin. One predicate, read by account type, so a
// route never has to guess from `role` and `isManager`. An LMSW is NOT in it:
// case management is clinical work, not the scheduling and caregiver office.
const HOME_CARE_OFFICE_TYPES = Object.freeze([TYPES.ADMIN, TYPES.MANAGER, TYPES.COORDINATOR]);
const isHomeCareOffice = (u) => HOME_CARE_OFFICE_TYPES.includes(accountTypeOf(u));

// ---- Who may create and edit which accounts ------------------------------
// Owner decision, 2026-11-03: managers and care coordinators take over
// onboarding, so they create and edit the people they manage. That must never
// become a way to raise anyone's access, their own included.
//
// E1: a manager or coordinator manages CAREGIVER, CLIENT and FAMILY accounts
//     and nothing else. Clinician accounts stay with the Super Admin: they
//     carry NPI, DEA and credentialing that feed billing.
// E2: they never create or edit a staff account, never change an account to
//     a staff type, never change their own account, and never set the access
//     fields (role, isManager, clinicalRole, hasClinicalAccess, accountType)
//     to anything outside E1.
//
// This is the ONE predicate every route that writes a user calls. Anybody it
// does not recognise is refused, so a route added later fails closed.
const OFFICE_MANAGEABLE_TYPES = Object.freeze([TYPES.CAREGIVER, TYPES.CLIENT, TYPES.FAMILY]);
const OFFICE_MANAGEABLE_ROLES = Object.freeze(['vendor', 'client', 'family']);

function canManageAccountType(actor, targetType) {
  const a = accountTypeOf(actor);
  if (a === TYPES.ADMIN) return true;
  if (a === TYPES.MANAGER || a === TYPES.COORDINATOR) return OFFICE_MANAGEABLE_TYPES.includes(String(targetType || ''));
  return false;
}

// The access fields a body may carry, and the staff-only credential fields
// that mean nothing on a caregiver, client or family record.
const ACCESS_FIELDS = Object.freeze(['role', 'isManager', 'clinicalRole', 'hasClinicalAccess', 'accountType', 'managerClinicalAccess']);
const CREDENTIAL_FIELDS = Object.freeze(['npi', 'prescriberCredential', 'deaNumber', 'deaSchedules', 'deaExpiresAt',
  'medicareEnrollment', 'openEmrProviderId', 'hasImplementationsAccess']);
const blank = (v) => v === undefined || v === null || v === '' || v === false ||
  (Array.isArray(v) && v.length === 0) ||
  (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(blank));

const SUPER_ADMIN_MANAGES = 'A Super Admin manages staff and clinical accounts. A manager or care coordinator can add and edit caregivers, clients and family contacts.';

// Decide one user write. `existing` is the stored record (null on create).
// Returns { ok: true, body } with the body cleaned of empty staff-only keys,
// or { ok: false, status, code, error } naming the reason.
function checkUserWrite(actor, { existing, body }) {
  const b = { ...(body || {}) };
  const a = accountTypeOf(actor);
  if (a === TYPES.ADMIN) return { ok: true, body: b };
  if (a !== TYPES.MANAGER && a !== TYPES.COORDINATOR) {
    return { ok: false, status: 403, code: 'USER_ADMIN_FORBIDDEN', error: 'Only a Super Admin, a manager or a care coordinator manages accounts.' };
  }
  if (existing && actor && String(existing.id) === String(actor.id)) {
    return { ok: false, status: 403, code: 'USER_SELF_EDIT_FORBIDDEN',
      error: 'You cannot change your own account type, status or permissions. Ask a Super Admin.' };
  }
  if (existing && !canManageAccountType(actor, accountTypeOf(existing))) {
    return { ok: false, status: 403, code: 'USER_TYPE_NOT_MANAGEABLE', error: SUPER_ADMIN_MANAGES };
  }
  // What the body asks the account to BE.
  if (!blank(b.accountType) && !canManageAccountType(actor, b.accountType)) {
    return { ok: false, status: 403, code: 'USER_TYPE_NOT_MANAGEABLE', error: SUPER_ADMIN_MANAGES };
  }
  if (!blank(b.role) && !OFFICE_MANAGEABLE_ROLES.includes(String(b.role))) {
    return { ok: false, status: 403, code: 'USER_TYPE_NOT_MANAGEABLE', error: SUPER_ADMIN_MANAGES };
  }
  for (const f of ['isManager', 'clinicalRole', 'hasClinicalAccess', 'managerClinicalAccess']) {
    if (!blank(b[f])) {
      return { ok: false, status: 403, code: 'USER_ACCESS_FIELD_FORBIDDEN',
        error: `${SUPER_ADMIN_MANAGES} (${f} cannot be set here.)` };
    }
  }
  for (const f of CREDENTIAL_FIELDS) {
    if (!blank(b[f])) {
      return { ok: false, status: 403, code: 'USER_CREDENTIAL_FIELD_FORBIDDEN',
        error: `${SUPER_ADMIN_MANAGES} (${f} is a clinical credential.)` };
    }
  }
  // On create, an account with no type of its own is refused rather than left
  // to default to a staff role.
  if (!existing && blank(b.accountType) && blank(b.role)) {
    return { ok: false, status: 400, code: 'ACCOUNT_TYPE_REQUIRED', error: 'Choose Caregiver, Client or Family / Authorized Contact.' };
  }
  // Empty staff-only keys are dropped, so a form that always sends them cannot
  // clear anything on the record by sending a blank.
  for (const f of [...ACCESS_FIELDS, ...CREDENTIAL_FIELDS]) {
    if (f === 'accountType' || f === 'role') { if (blank(b[f])) delete b[f]; continue; }
    delete b[f];
  }
  return { ok: true, body: b };
}

// ---- The boot migration ----------------------------------------------------
// Once per record, and idempotent: a record already consistent is left alone.
//   1. The three lab-era access checkboxes are cleared on everyone. They no
//      longer open anything, and a stale `true` would read as access.
//   2. A care coordinator stored as a case manager moves to the coordinator
//      type (role user + manager flag), so manager gates admit them.
//   3. An LMSW set up as a clinical account moves to the LMSW / Case Manager
//      type, so the same job always gets the same account.
//   4. `accountType` is written where it can be derived. Where it cannot, the
//      record is flagged for an admin to choose, never guessed.
const LEGACY_FLAGS = Object.freeze(['hasAdminHubAccess', 'hasClientPortalAdminAccess', 'hasServicePortalAccess']);
function applyAccountTypeMigration(users) {
  const changed = [];
  const needsReview = [];
  const next = (Array.isArray(users) ? users : []).map(u => {
    if (!u) return u;
    const out = { ...u };
    const notes = [];
    for (const f of LEGACY_FLAGS) {
      if (out[f]) { out[f] = false; notes.push(`cleared ${f}`); }
    }
    const type = isValidType(out.accountType) ? out.accountType : deriveType(out);
    if (!type) {
      if (!out.accountTypeNeedsReview) {
        out.accountTypeNeedsReview = true;
        notes.push('account type needs an admin to choose it');
      }
      needsReview.push({ id: out.id, name: out.name || out.email || out.id });
    } else {
      const want = fieldsFor(type, { managerClinicalAccess: managerAccessOf(out) });
      if (out.role !== want.role) { notes.push(`role ${out.role} → ${want.role}`); out.role = want.role; }
      if (!!out.isManager !== want.isManager) { notes.push(`manager flag → ${want.isManager}`); out.isManager = want.isManager; }
      if ((out.clinicalRole || null) !== want.clinicalRole) {
        notes.push(`clinical role ${out.clinicalRole || 'none'} → ${want.clinicalRole || 'none'}`);
        out.clinicalRole = want.clinicalRole;
      }
      if (!!out.hasClinicalAccess !== want.hasClinicalAccess) out.hasClinicalAccess = want.hasClinicalAccess;
      if (want.managerClinicalAccess && out.managerClinicalAccess !== want.managerClinicalAccess) {
        out.managerClinicalAccess = want.managerClinicalAccess;
      }
      if (out.accountType !== type) { out.accountType = type; notes.push(`account type ${type}`); }
      if (out.accountTypeNeedsReview) { out.accountTypeNeedsReview = false; }
    }
    if (notes.length) changed.push({ id: out.id, name: out.name || out.email || out.id, notes });
    return out;
  });
  return { users: next, changed, needsReview };
}

module.exports = {
  TYPES, ACCOUNT_TYPES, ALL_TYPES, isValidType,
  MANAGER_CLINICAL_ACCESS, DEFAULT_MANAGER_CLINICAL_ACCESS, isValidManagerAccess,
  CLINICIAN_TYPES, PRIVATE_HOME_CARE, LEGACY_FLAGS,
  fieldsFor, deriveType, accountTypeOf, managerAccessOf, isConsistent,
  landingFor, hubTilesFor, applyAccountTypeMigration,
  HOME_CARE_OFFICE_TYPES, isHomeCareOffice,
  OFFICE_MANAGEABLE_TYPES, canManageAccountType, checkUserWrite
};
