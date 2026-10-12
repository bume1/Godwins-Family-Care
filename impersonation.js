// ============================================================================
// impersonation.js — "View as" for the Super Admin (owner-directed, 2026-10-12)
//
// A Super Admin (role === 'admin') can open the app AS any non-admin account
// to check what that role sees and can do, without keeping a test login for
// every role. It is a SESSION, not a token trick: the session row's userId is
// the person being viewed, and the row also names who really started it
// (impersonatorId / impersonatorSid). The auth middleware rebuilds req.user
// from the viewed person's fresh record exactly as it would for them, so what
// the admin sees is what that person sees.
//
// Full act-as (owner choice), with three things held back, all decided here
// so no route restates the rule:
//   1. NO SIGNATURE IN SOMEONE ELSE'S NAME. Signing a note, a prescription, a
//      care plan, a consent, a packet or an attestation is a legal statement
//      by THAT person. BLOCKED_WHILE_ACTING_AS lists the routes; the auth
//      middleware refuses them with ACTING_AS_BLOCKED.
//   2. NO OPENEMR. OpenEMR tokens are per user, so acting as a clinician
//      would write into the real chart under their name. The token provider
//      refuses (EMR_BLOCKED_WHILE_ACTING_AS) — one place every EMR call
//      passes through, so no route can slip past it.
//   3. NO ACCOUNT CHANGES. Their password, authenticator and OpenEMR
//      connection are theirs alone.
// Emails and notifications still send, and the banner says so.
//
// Never into another admin (owner rule): viewing as an admin would be a way
// to climb into a higher account. Never nested. Hard 60-minute cap.
// ============================================================================
'use strict';

const IMPERSONATION_MINUTES = 60;

// method + path pattern. Paths are matched against req.path (no query).
const BLOCKED_WHILE_ACTING_AS = Object.freeze([
  // Clinical signatures and attestations
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/encounters\/[^/]+\/sign$/, what: 'signing a note' },
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/encounters\/[^/]+\/co-sign$/, what: 'adding a clinician addendum' },
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/encounters\/[^/]+\/co-signatures$/, what: 'co-signing a note' },
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/encounters\/[^/]+\/addenda$/, what: 'adding an addendum' },
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/encounters\/[^/]+\/prescriptions$/, what: 'recording a prescription' },
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/care-plan$/, what: 'signing a care plan' },
  { method: 'POST', pattern: /^\/api\/clinical\/patients\/[^/]+\/care-plan\/provider-cosign$/, what: 'co-signing a care plan' },
  { method: 'POST', pattern: /^\/api\/clinical\/orders\/[^/]+\/co-sign$/, what: 'co-signing an order' },
  { method: 'POST', pattern: /^\/api\/clinical\/standing-orders$/, what: 'signing a standing order' },
  { method: 'POST', pattern: /^\/api\/clinical\/standing-orders\/[^/]+\/revise$/, what: 'signing a standing order' },
  { method: 'POST', pattern: /^\/api\/clinical\/results\/[^/]+\/acknowledge$/, what: 'acknowledging a result' },
  // Client and family signatures
  { method: 'POST', pattern: /^\/api\/gfc\/consents$/, what: 'signing a consent' },
  { method: 'POST', pattern: /^\/api\/gfc\/care-plan\/cosign$/, what: 'co-signing the care plan' },
  { method: 'POST', pattern: /^\/api\/gfc\/transfer-roi\/submit$/, what: 'signing a record release' },
  { method: 'PUT', pattern: /^\/api\/client\/service-reports\/[^/]+\/sign$/, what: 'signing a service report' },
  // Caregiver signatures
  { method: 'POST', pattern: /^\/api\/caregiver\/welcome-packet\/submit$/, what: 'signing the welcome packet' },
  { method: 'POST', pattern: /^\/api\/caregiver\/welcome-packet\/attestations\/[^/]+$/, what: 'signing a caregiver form' },
  // Their account
  { method: 'POST', pattern: /^\/api\/auth\/change-password$/, what: 'changing their password' },
  { method: 'POST', pattern: /^\/api\/auth\/mfa\/recovery-codes\/regenerate$/, what: 'changing their authenticator' },
  { method: '*', pattern: /^\/api\/emr(\/|$)/, what: 'changing their OpenEMR connection' }
]);

const blockedAction = (method, path) => {
  const m = String(method || '').toUpperCase();
  const p = String(path || '');
  return BLOCKED_WHILE_ACTING_AS.find(r => (r.method === '*' || r.method === m) && r.pattern.test(p)) || null;
};

const isActingAs = (session) => !!(session && session.impersonatorId);

// canStart({ admin, adminSession, target, mfaEnforced }) → { ok } | { ok:false, status, code, error }
const canStart = ({ admin, adminSession, target, mfaEnforced }) => {
  const no = (status, code, error) => ({ ok: false, status, code, error });
  if (!admin || admin.role !== 'admin') return no(403, 'ADMIN_ONLY', 'Only a Super Admin can view as another account.');
  if (isActingAs(adminSession)) return no(409, 'ALREADY_ACTING_AS', 'Exit the account you are viewing first.');
  if (mfaEnforced && !(adminSession && adminSession.mfaVerified)) return no(403, 'MFA_REQUIRED', 'Sign in with your authenticator before viewing as another account.');
  if (!target) return no(404, 'USER_NOT_FOUND', 'That account does not exist.');
  if (target.id === admin.id) return no(400, 'ACTING_AS_SELF', 'You are already signed in as yourself.');
  if (target.role === 'admin') return no(403, 'ACTING_AS_ADMIN_REFUSED', 'You cannot view as another admin account.');
  if (target.accountStatus === 'inactive') return no(409, 'ACCOUNT_INACTIVE', 'That account is inactive. Reactivate it first.');
  return { ok: true };
};

const expiresAt = (nowMs = Date.now()) => new Date(nowMs + IMPERSONATION_MINUTES * 60 * 1000).toISOString();

// The role as the banner says it. The stored names are lab-era ('vendor' is
// a caregiver, 'user' a clinician), and the banner is read by a person.
const ROLE_LABELS = Object.freeze({ user: 'clinician', vendor: 'caregiver', caseManager: 'case manager', client: 'client', family: 'family' });
const roleLabel = (role) => ROLE_LABELS[role] || role || null;

// What the browser is told about the current session. Never more than names.
const describe = (session, user) => {
  if (!isActingAs(session)) return null;
  return {
    impersonatorId: session.impersonatorId,
    impersonatorName: session.impersonatorName || null,
    userId: user ? user.id : session.userId,
    userName: user ? (user.name || user.email || null) : null,
    role: user ? user.role : session.role || null,
    roleLabel: roleLabel(user ? user.role : session.role),
    expiresAt: session.absoluteExpiresAt || null
  };
};

module.exports = { IMPERSONATION_MINUTES, roleLabel, BLOCKED_WHILE_ACTING_AS, blockedAction, isActingAs, canStart, expiresAt, describe };
