// ============================================================================
// familyInvites.js — a patient (or their POA) invites a family member; staff
// confirm (owner, 2026-10-12). Pure rules only; the routes live in server.js.
//
// WHY AN INVITE AND NOT AN ACCOUNT. Family access to a patient's portal has
// three gates that an invite must not skip: an admin creates the account, the
// patient's family Release of Information must be signed, and a Power of
// Attorney is only ever granted after staff verify the POA document. So the
// patient's ask creates nothing but a request. Approving it creates a plain
// family account (never a POA, whatever the ask said), and the ROI gate still
// decides what that account can open.
//
// The request records whether the patient SAYS this person is their POA, so
// staff know to ask for the document. It never sets familyIsPoa.
// ============================================================================

const familyLinks = require('./familyLinks');

const RELATIONSHIPS = Object.freeze(['Spouse or partner', 'Child', 'Parent', 'Sibling', 'Grandchild', 'Other relative', 'Friend', 'Other']);
const STATUSES = Object.freeze(['pending', 'approved', 'declined', 'cancelled']);
const NAME_MAX = 120;
const DECLINE_REASON_MAX = 500;
// A plain sanity check, not validation of deliverability: one @, a dot after it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// What the patient typed, checked. Returns { value } or { error, code }.
function normalizeInvite(body) {
  const b = body || {};
  const name = clean(b.name, NAME_MAX);
  const email = clean(b.email, 254).toLowerCase();
  const relationship = clean(b.relationship, 40);
  if (!name) return { error: 'Enter their name.', code: 'INVITE_NAME_REQUIRED' };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address. That is where their sign-in details will go.', code: 'INVITE_EMAIL_INVALID' };
  if (!RELATIONSHIPS.includes(relationship)) return { error: `Choose how they are related to you: ${RELATIONSHIPS.join(', ')}.`, code: 'INVITE_RELATIONSHIP_INVALID' };
  return { value: { name, email, relationship, saysPoa: b.saysPoa === true } };
}

// Refuse an invite that would collide with an account or another open ask.
// Someone who already has a FAMILY account (for another patient) can be
// invited: approving links this patient to their existing login rather than
// making a second account on the same email (familyLinks.js).
function checkInvite(value, { users, invites, clientId }) {
  const email = value.email;
  const existing = (users || []).find(u => u && String(u.email || '').toLowerCase() === email);
  if (existing && existing.role === 'family' && familyLinks.isFamilyOf(existing, clientId)) {
    return { error: 'That person already has access to your portal.', code: 'INVITE_ALREADY_LINKED' };
  }
  if (existing && existing.role !== 'family') {
    return { error: 'Someone already has an account with that email. Call the office and we will link it for you.', code: 'INVITE_EMAIL_IN_USE' };
  }
  if ((invites || []).some(i => i && i.clientId === clientId && i.status === 'pending' && i.email === email)) {
    return { error: 'You have already invited that email. The office will confirm it soon.', code: 'INVITE_DUPLICATE' };
  }
  return null;
}

function buildInviteRow({ id, clientId, value, by, at }) {
  return {
    id, clientId,
    name: value.name, email: value.email, relationship: value.relationship,
    saysPoa: !!value.saysPoa,
    status: 'pending',
    requestedAt: at,
    requestedBy: { id: by.id, name: by.name || null, role: by.role }
  };
}

// The one place a decision is applied, so approve and decline cannot drift.
function decide(row, { decision, by, at, reason }) {
  if (!row || row.status !== 'pending') return { error: 'That invite has already been answered.', code: 'INVITE_NOT_PENDING' };
  if (decision === 'declined') {
    const r = clean(reason, DECLINE_REASON_MAX);
    if (!r) return { error: 'Give a reason. The patient is shown it.', code: 'INVITE_DECLINE_REASON_REQUIRED' };
    return { row: { ...row, status: 'declined', decidedAt: at, decidedBy: { id: by.id, name: by.name || null }, declineReason: r } };
  }
  if (decision === 'approved') return { row: { ...row, status: 'approved', decidedAt: at, decidedBy: { id: by.id, name: by.name || null } } };
  if (decision === 'cancelled') return { row: { ...row, status: 'cancelled', decidedAt: at, decidedBy: { id: by.id, name: by.name || null } } };
  return { error: 'Unknown decision.', code: 'INVITE_BAD_DECISION' };
}

// What a family member can see, in words, from the client's sharing settings.
// A POA sees what the patient sees. Labels match the Sharing card.
const SHARE_LABELS = [['carePlan', 'care plan'], ['appointments', 'appointments'], ['medications', 'medicines'], ['allergies', 'allergies'], ['problems', 'conditions'], ['vitals', 'vitals'], ['results', 'test results']];
function accessSummary(familyUser, sharing) {
  if (familyUser && familyUser.familyIsPoa) return 'Full access (Power of Attorney)';
  const s = sharing || {};
  const parts = SHARE_LABELS.filter(([k]) => s[k]).map(([, l]) => l);
  if (s.visitSummaries === 'full') parts.push('visit summaries and notes');
  else if (s.visitSummaries === 'summary') parts.push('visit dates');
  return parts.length ? `Can see ${parts.join(', ')} · messages` : 'Messages only';
}

// What the patient's screen is given about one invite: never who on staff
// decided it, only that it was decided and, for a decline, why.
function publicInvite(row) {
  return {
    id: row.id, name: row.name, email: row.email, relationship: row.relationship,
    saysPoa: !!row.saysPoa, status: row.status, requestedAt: row.requestedAt,
    decidedAt: row.decidedAt || null, declineReason: row.status === 'declined' ? (row.declineReason || null) : null
  };
}

module.exports = { RELATIONSHIPS, STATUSES, normalizeInvite, checkInvite, buildInviteRow, decide, accessSummary, publicInvite, SHARE_LABELS };
