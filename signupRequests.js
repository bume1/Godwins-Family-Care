// ============================================================================
// signupRequests.js — self sign-up (owner, 2026-10-12): "self sign up should
// collect key info to create a new user, then staff verifies and approves or
// links account". Pure rules only; the routes live in server.js.
//
// A SIGN-UP IS A REQUEST, NOT AN ACCOUNT. Anyone on the internet can fill the
// form in, so nothing they submit can sign in or see anything until a staff
// member decides. The person confirms their email first (so a request cannot
// be made in somebody else's name without their inbox), then staff:
//   - approve it as a NEW CLIENT (for a loved one: a client record with no
//     login of its own, plus a family account for the person who signed up),
//   - LINK it as family of a client already on file, or
//   - DECLINE it with a reason the person is shown.
// An approved account starts at intake_pending, so the enrollment gate, the
// consents and the intake all still run. Nothing here grants POA.
//
// The password is hashed on arrival and the hash moves to the account on
// approval; the plain password is never stored. The verify token is stored
// HASHED, so a read of the collection cannot confirm anybody's email.
// ============================================================================
const crypto = require('crypto');

const WHO = Object.freeze(['self', 'loved_one']);
const RELATIONSHIPS = Object.freeze(['Spouse or partner', 'Child', 'Parent', 'Sibling', 'Grandchild', 'Other relative', 'Friend', 'Other']);
// What they are interested in; maps to the service line the intake starts on.
const INTERESTS = Object.freeze({ home_care: 'Home care (help at home)', primary_care: 'Medical visits at home', not_sure: 'Not sure yet' });
const COVERAGE = Object.freeze(['Medicare', 'Medicare Advantage', 'Medicaid', 'Private insurance', 'Long-term care insurance', 'Paying privately', 'Not sure']);
const VERIFY_HOURS = 48;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function validDob(s, today) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d)) return false;
  const now = today ? new Date(`${today}T12:00:00Z`) : new Date();
  const years = (now - d) / (365.25 * 86400000);
  return years >= 0 && years <= 120;
}

// One person's name split for the intake. "Mary Ann Smith" -> Mary Ann / Smith.
const splitName = (full) => {
  const parts = clean(full, 120).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
};

// Everything the form sends, checked. Returns { value } or { error, code, field }.
function normalizeSignup(body, { minPasswordLength = 8, today } = {}) {
  const b = body || {};
  const fail = (field, code, error) => ({ field, code, error });
  const name = clean(b.name, 120);
  if (!splitName(name)) return fail('name', 'SIGNUP_NAME', 'Enter your first and last name.');
  const dob = clean(b.dob, 10);
  if (!validDob(dob, today)) return fail('dob', 'SIGNUP_DOB', 'Enter your date of birth.');
  const email = clean(b.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail('email', 'SIGNUP_EMAIL', 'Enter a valid email address.');
  const phone = digits(b.phone);
  if (phone.length !== 10 && !(phone.length === 11 && phone[0] === '1')) return fail('phone', 'SIGNUP_PHONE', 'Enter a 10-digit phone number.');
  const password = String(b.password || '');
  if (password.length < minPasswordLength) return fail('password', 'SIGNUP_PASSWORD', `Choose a password of at least ${minPasswordLength} characters.`);
  if (password.length > 200) return fail('password', 'SIGNUP_PASSWORD', 'That password is too long.');

  const who = WHO.includes(b.who) ? b.who : null;
  if (!who) return fail('who', 'SIGNUP_WHO', 'Tell us who the care is for.');
  let patient = null;
  if (who === 'loved_one') {
    const pName = clean(b.patientName, 120);
    if (!splitName(pName)) return fail('patientName', 'SIGNUP_PATIENT_NAME', 'Enter your loved one\'s first and last name.');
    const pDob = clean(b.patientDob, 10);
    if (!validDob(pDob, today)) return fail('patientDob', 'SIGNUP_PATIENT_DOB', 'Enter your loved one\'s date of birth.');
    const relationship = clean(b.relationship, 40);
    if (!RELATIONSHIPS.includes(relationship)) return fail('relationship', 'SIGNUP_RELATIONSHIP', `Choose how you are related: ${RELATIONSHIPS.join(', ')}.`);
    patient = { name: pName, dob: pDob, relationship };
  }
  const a = b.address || {};
  const address = { line1: clean(a.line1, 120), city: clean(a.city, 60), state: clean(a.state, 2).toUpperCase() || 'GA', zip: digits(a.zip).slice(0, 5) };
  if (!address.line1 || !address.city || address.zip.length !== 5) return fail('address', 'SIGNUP_ADDRESS', 'Enter the street address, city and ZIP where care would happen.');
  const interests = (Array.isArray(b.interests) ? b.interests : []).filter(k => Object.prototype.hasOwnProperty.call(INTERESTS, k));
  if (!interests.length) return fail('interests', 'SIGNUP_INTERESTS', 'Choose at least one kind of care, or "Not sure yet".');

  const coverage = COVERAGE.includes(b.coverage) ? b.coverage : 'Not sure';
  const insurance = { coverage, carrier: clean(b.carrier, 80) || null, memberId: clean(b.memberId, 40) || null };

  if (b.agreeTerms !== true) return fail('agreeTerms', 'SIGNUP_TERMS', 'Please agree to the terms and privacy notice to continue.');
  return {
    value: {
      name, dob, email, phone: phone.slice(-10), password,
      who, patient, address, interests: [...new Set(interests)], insurance,
      contactOk: b.contactOk === true
    }
  };
}

// The stored row. The plain password and the plain token are NOT in it.
function buildSignupRow({ id, value, passwordHash, token, at, ipHash }) {
  const { password, ...rest } = value; // eslint-disable-line no-unused-vars
  return {
    id, ...rest,
    passwordHash,
    verifyTokenHash: hashToken(token),
    verifyExpiresAt: new Date(Date.parse(at) + VERIFY_HOURS * 3600 * 1000).toISOString(),
    status: 'unverified',
    createdAt: at,
    ipHash: ipHash || null
  };
}

// Find a request by the token in the link. Returns { row, idx } or { error, code }.
function findByToken(rows, token, now) {
  const h = hashToken(token);
  const idx = (rows || []).findIndex(r => r && r.verifyTokenHash === h);
  if (idx === -1) return { error: 'That link is not valid. Try signing up again.', code: 'SIGNUP_LINK_INVALID' };
  const row = rows[idx];
  if (row.status !== 'unverified') return { row, idx, already: true };
  if (Date.parse(row.verifyExpiresAt) < Date.parse(now)) return { error: 'That link has expired. Sign up again and we will send a new one.', code: 'SIGNUP_LINK_EXPIRED' };
  return { row, idx };
}

// The service line an approved client's intake starts on.
function serviceLineFor(interests) {
  const h = interests.includes('home_care');
  const m = interests.includes('primary_care');
  return h && m ? 'BOTH' : m ? 'IHPC' : h ? 'PHC' : null;
}

// What the sign-up says about coverage, put where the intake keeps it, so the
// staff editor and the intake wizard show it in the right fields.
function intakeInsurance(ins) {
  const i = ins || {};
  const out = {};
  if (i.coverage === 'Medicare') out.medicare = { id: i.memberId || '' };
  else if (i.coverage === 'Medicare Advantage') out.medicare = { advantagePlan: i.carrier || '', advMemberId: i.memberId || '' };
  else if (i.coverage === 'Medicaid') out.medicaid = { memberId: i.memberId || '', plan: i.carrier || '' };
  else if (i.coverage === 'Private insurance') out.commercial = { carrier: i.carrier || '', memberId: i.memberId || '' };
  else if (i.coverage === 'Long-term care insurance') out.ltc = { carrier: 'Other', carrierOther: i.carrier || '', policyNum: i.memberId || '' };
  else if (i.coverage === 'Paying privately') out.payerType = 'Private pay';
  out.signupCoverage = i.coverage || 'Not sure';
  return out;
}

// The intake a new client record starts from: the person the care is for.
function intakeFor(row) {
  const forSelf = row.who === 'self';
  const nm = splitName(forSelf ? row.name : row.patient.name);
  return {
    firstName: nm.firstName, lastName: nm.lastName,
    dob: forSelf ? row.dob : row.patient.dob,
    phone: forSelf ? row.phone : '',
    address: row.address,
    ...intakeInsurance(row.insurance),
    ...(forSelf ? {} : { primaryContact: { name: row.name, relationship: row.patient.relationship, phone: row.phone, email: row.email } }),
    source: 'self_signup',
    signupRequestId: row.id
  };
}

// The one place a decision is checked, so the three actions cannot drift.
function checkDecision(row, { action, clientId, reason }) {
  if (!row) return { error: 'Sign-up not found.', code: 'SIGNUP_NOT_FOUND' };
  if (row.status === 'unverified') return { error: 'This person has not confirmed their email yet.', code: 'SIGNUP_NOT_VERIFIED' };
  if (row.status !== 'verified') return { error: 'This sign-up has already been answered.', code: 'SIGNUP_ANSWERED' };
  if (action === 'approve_client') return null;
  if (action === 'link_family') return clientId ? null : { error: 'Choose the client to link them to.', code: 'SIGNUP_LINK_CLIENT_REQUIRED' };
  if (action === 'decline') return clean(reason, 500) ? null : { error: 'Give a reason. The person is shown it.', code: 'SIGNUP_DECLINE_REASON_REQUIRED' };
  return { error: 'Unknown action.', code: 'SIGNUP_BAD_ACTION' };
}

// What staff see. Never the password hash or the token hash.
function staffRow(row) {
  const { passwordHash, verifyTokenHash, ipHash, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}

// What sign-in says to a person whose sign-up is not an account yet.
function loginMessageFor(row) {
  if (!row) return null;
  if (row.status === 'unverified') return { code: 'SIGNUP_UNVERIFIED', error: 'Please confirm your email first. We sent you a link when you signed up.' };
  if (row.status === 'verified') return { code: 'SIGNUP_PENDING', error: 'Thanks for signing up. Our office is reviewing your account and will email you once it is ready.' };
  if (row.status === 'declined') return { code: 'SIGNUP_DECLINED', error: `We couldn't set up this account: ${row.declineReason || 'please call the office.'}` };
  return null;
}

// A tiny fixed-window limiter by hashed address: a form anyone can post to
// must not be a way to flood the office's queue or someone's inbox.
function makeLimiter({ max = 5, windowMs = 3600 * 1000 } = {}) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now); hits.set(key, arr); return false;
  };
}

module.exports = {
  WHO, RELATIONSHIPS, INTERESTS, COVERAGE, VERIFY_HOURS,
  normalizeSignup, buildSignupRow, findByToken, hashToken, serviceLineFor, intakeFor, intakeInsurance,
  splitName, checkDecision, staffRow, loginMessageFor, makeLimiter
};
