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
function hubTilesFor(u) {
  const type = accountTypeOf(u);
  const tiles = [];
  const clinical = { id: 'clinical', name: 'Clinical Workspace', path: '/clinical' };
  const phc = { id: 'privateHomeCare', name: 'Private Home Care', children: PRIVATE_HOME_CARE };
  if (type === TYPES.ADMIN) {
    tiles.push({ id: 'admin', name: 'Admin Hub', path: '/admin' }, clinical, phc,
      { id: 'service', name: 'Service Portal', path: '/service-portal' },
      { id: 'clientPortalAdmin', name: 'Client Portal Admin', path: '/portal' });
  } else if (type === TYPES.COORDINATOR) {
    tiles.push(clinical, phc);
  } else if (type === TYPES.MANAGER) {
    if (managerAccessOf(u) !== 'none' && u.clinicalRole) tiles.push(clinical);
    tiles.push(phc);
  }
  return tiles;
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
  landingFor, hubTilesFor, applyAccountTypeMigration
};
