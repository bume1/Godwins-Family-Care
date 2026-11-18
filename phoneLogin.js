// ============================================================================
// phoneLogin.js — sign in with a phone number, hear from us by text
// (owner, 2026-11-18).
//
// THE ASK. "For clients like Ms. Dorothy that don't use email, but have a
// phone number, can we make it where a phone number OR email is needed? And
// that those who don't have emails get notifications of updates via text
// message instead? Down to the reset links?"
//
// HOW IT FITS WHAT IS ALREADY HERE. A patient with no email already gets a
// placeholder login (familyLinks.placeholderEmailFor) that nobody can use.
// This adds one field, `loginPhone` (+1XXXXXXXXXX), that makes such an account
// one a real person CAN sign in to: the sign-in box takes an email or a phone
// number, and anything the app would have emailed them goes by text through
// Quo (BAA signed, already wired for Care Team texts in quoSms.js).
//
// Pure rules only; the routes live in server.js and routes/messaging.js.
//
// THE RULES, each one load-bearing:
//   - Only a client or family account may sign in by phone. Staff keep email,
//     because MFA and every staff notice assume an inbox.
//   - One phone number, one login. Two accounts on one sign-in number would
//     make the number ambiguous at the sign-in box, so the second is refused.
//   - Texts about updates are PHI-FREE: "you have a new update, sign in to
//     see it". The same rule the patient emails follow. A text sits on a lock
//     screen anyone can read.
//   - A reset link is texted only to the number on the account, never to a
//     number someone types. The token rules are passwordSetLinks.js's,
//     unchanged: 1 hour, one use, 3 per hour, only its hash stored. The link
//     itself is never written to the database, so it never goes through the
//     stored text outbox.
//   - STOP is honoured. Someone who texted STOP, or switched texts off in the
//     portal, gets no update texts. A reset link they asked for still goes,
//     because they asked for it on the screen just now.
// ============================================================================
'use strict';

const quoSms = require('./quoSms');

const PHONE_LOGIN_ROLES = Object.freeze(['client', 'family']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const toE164 = (raw) => quoSms.toE164(raw);
const looksLikeEmail = (s) => /@/.test(String(s || ''));

const isPlaceholder = (email) => /@placeholder\.local$/i.test(String(email || '').trim());
// An address someone actually reads.
const hasRealEmail = (user) => !!(user && user.email && EMAIL_RE.test(String(user.email)) && !isPlaceholder(user.email));

const canUsePhoneLogin = (role) => PHONE_LOGIN_ROLES.includes(String(role || ''));

// What was typed in the sign-in box. An @ means email; otherwise it must read
// as a US phone number, or it is nothing we can look up.
function parseIdentifier(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { kind: null };
  if (looksLikeEmail(s)) return { kind: 'email', value: s.toLowerCase() };
  const p = toE164(s);
  return p ? { kind: 'phone', value: p } : { kind: null };
}

// The one account a typed email or phone number names, or null. An email is
// matched case-blind, as sign-in always has been. A phone number is matched
// only against `loginPhone`, never against a contact phone on someone's
// record, so a number on a profile is never quietly a way in.
function findByIdentifier(users, raw, { roles = null } = {}) {
  const id = parseIdentifier(raw);
  if (!id.kind) return null;
  const list = (Array.isArray(users) ? users : []).filter(u => u && (!roles || roles.includes(u.role)));
  if (id.kind === 'email') return list.find(u => u.email && String(u.email).toLowerCase() === id.value) || null;
  return list.find(u => u.loginPhone && u.loginPhone === id.value && canUsePhoneLogin(u.role)) || null;
}

// Another account already signs in with this number?
function loginPhoneHolder(users, e164, exceptUserId = null) {
  if (!e164) return null;
  return (users || []).find(u => u && u.loginPhone === e164 && u.id !== exceptUserId) || null;
}

// Check a sign-in phone number for an account. Returns { value } (E.164, or
// null to clear it) or { error, code, status }.
function checkLoginPhone({ users, raw, role, userId = null }) {
  if (raw === null || raw === '' || raw === false) return { value: null };
  if (!canUsePhoneLogin(role)) {
    return { error: 'Only a client or family account can sign in with a phone number. Staff sign in with email.', code: 'PHONE_LOGIN_ROLE', status: 400 };
  }
  const p = toE164(raw);
  if (!p) return { error: 'Enter a 10-digit US mobile number for them to sign in with.', code: 'PHONE_LOGIN_INVALID', status: 400 };
  const holder = loginPhoneHolder(users, p, userId);
  if (holder) {
    return { error: `${holder.name || 'Another account'} already signs in with that phone number. Each sign-in number can belong to one account.`, code: 'PHONE_LOGIN_IN_USE', status: 400 };
  }
  return { value: p };
}

const textsStopped = (user) => !!(user && user.smsOptIn && user.smsOptIn.enabled === false);
const isActive = (user) => !!user && (user.accountStatus || 'active') !== 'inactive';

// May this person get "you have an update" texts in place of email? Only a
// phone sign-in with no inbox, still active, who has not said STOP.
function mayTextNotices(user) {
  return !!(user && user.loginPhone && canUsePhoneLogin(user.role) && isActive(user) && !hasRealEmail(user) && !textsStopped(user));
}

// Where a password link for this account goes: 'email', 'sms', or null.
// `typed` is what the person typed on the Forgot Password screen (or
// undefined for an office-sent link): a phone number typed means a text, an
// email typed means an email, and the office sends to whichever the account
// has, email first.
function resetChannel(user, typed) {
  if (!user || !isActive(user)) return null;
  const t = typed ? parseIdentifier(typed) : { kind: null };
  const phoneOk = !!(user.loginPhone && canUsePhoneLogin(user.role));
  if (t.kind === 'phone') return phoneOk && user.loginPhone === t.value ? 'sms' : null;
  if (t.kind === 'email') return hasRealEmail(user) ? 'email' : null;
  if (hasRealEmail(user)) return 'email';
  return phoneOk ? 'sms' : null;
}

// ---- The wording -------------------------------------------------------------
// Short, plain, and nothing about anyone's health. Carriers want the business
// named in the first words and STOP offered on the first text.
const BRAND = 'Godwins Family Care';

function noticeText({ portalUrl, first = false }) {
  const lines = [`${BRAND}: You have a new update in your portal. Sign in to see it: ${portalUrl}`];
  if (first) lines.push('Reply STOP to stop texts.');
  return lines.join('\n');
}

function resetText({ url, purpose }) {
  const lasts = purpose === 'admin' ? '24 hours' : '1 hour';
  return purpose === 'admin'
    ? `${BRAND}: Our office set up a new password for you. Choose it here (works once, expires in ${lasts}): ${url}`
    : `${BRAND}: Here is your link to choose a new password. It works once and expires in ${lasts}: ${url}\nDidn't ask? Ignore this text.`;
}

function welcomeText({ firstName, url }) {
  return `${BRAND}: Hi ${firstName || 'there'}, your portal account is ready. You sign in with this phone number. Choose your password here (works once, expires in 24 hours): ${url}\nReply STOP to stop texts.`;
}

function passwordChangedText({ officePhone }) {
  return `${BRAND}: Your portal password was just changed. If this wasn't you, call us right away at ${officePhone}.`;
}

// A link the notice can carry: an absolute app URL, or the portal.
function portalLinkFor(ctaUrl, base) {
  const b = String(base || '').replace(/\/+$/, '');
  const c = String(ctaUrl || '');
  if (/^https?:\/\//i.test(c)) return c;
  if (c.startsWith('/')) return b + c;
  return `${b}/portal`;
}

// Shown in a reply to staff ("Texted (404) 555-0100 a link…").
const describeChannel = (user, channel) => channel === 'sms'
  ? `Texted ${quoSms.prettyPhone(user.loginPhone)}`
  : `Emailed ${user.email}`;

module.exports = {
  PHONE_LOGIN_ROLES,
  toE164, looksLikeEmail, hasRealEmail, canUsePhoneLogin, parseIdentifier, findByIdentifier,
  loginPhoneHolder, checkLoginPhone, textsStopped, mayTextNotices, resetChannel,
  noticeText, resetText, welcomeText, passwordChangedText, portalLinkFor, describeChannel
};
