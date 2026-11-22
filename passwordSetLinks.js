// ============================================================================
// passwordSetLinks.js — "choose a new password" links (owner, 2026-11-17).
//
// THE GAP THIS CLOSES. "Forgot password" filed a request in the admin Inbox,
// and the Inbox's "Reset Password" button only marked the request handled. It
// never changed the password and never emailed the person, so a request
// produced nothing at all unless an admin went to the user form separately.
// Owner: "turn this into an automated password reset function that I don't
// have to go in and do the reset myself."
//
// HOW IT WORKS NOW. The person asks, the app emails them a one-time link, and
// they choose their own password on that page. Nobody else ever sees it, and
// no temporary password is generated, stored or emailed.
//
// THE RULES, each one load-bearing:
//   - The token is 32 random bytes and only its SHA-256 is stored. A copy of
//     the database does not hold a working link.
//   - One use. A used, expired or superseded link is refused by name.
//   - A new link supersedes the person's earlier unused ones.
//   - A self-service link lasts 1 hour; an admin-sent one 24 hours; an offer
//     letter's 7 days.
//   - At most 3 self-service links per person per hour, so the form cannot be
//     used to flood someone's inbox. Over the limit, the reply is the same
//     generic sentence and nothing is sent.
//   - Asking for a link changes nothing about the account. Only using it does,
//     so a stranger typing someone's email cannot lock them out.
//   - Setting the password signs the person out everywhere. MFA is untouched:
//     they still need their authenticator code to sign in.
// ============================================================================
const crypto = require('crypto');

const SELF_SERVICE_TTL_MS = 60 * 60 * 1000;
const ADMIN_TTL_MS = 24 * 60 * 60 * 1000;
// An offer letter's link (owner, 2026-11-19): a new hire may not open the
// email the same day, so it lasts a week. Using it sets their password AND
// signs them in, straight onto the offer.
const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SELF_SERVICE_PER_HOUR = 3;
const PURPOSES = Object.freeze(['self_service', 'admin', 'offer']);
const TTL_BY_PURPOSE = Object.freeze({ self_service: SELF_SERVICE_TTL_MS, admin: ADMIN_TTL_MS, offer: OFFER_TTL_MS });

const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

// A new link for one person. Returns the plain token (for the email only) and
// the record to store, which never holds the token itself.
function buildLink({ userId, purpose, now = new Date(), randomBytes = crypto.randomBytes }) {
  if (!userId) throw new Error('userId is required');
  const p = PURPOSES.includes(purpose) ? purpose : 'self_service';
  const token = randomBytes(32).toString('hex');
  const at = new Date(now);
  const ttl = TTL_BY_PURPOSE[p];
  return {
    token,
    record: {
      id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      userId: String(userId),
      purpose: p,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + ttl).toISOString(),
      usedAt: null,
      supersededAt: null
    }
  };
}

// Store a new link: earlier unused links for the same person are superseded,
// and anything finished more than a day ago is dropped so the list stays small.
function addLink(records, record, now = new Date()) {
  const t = new Date(now).getTime();
  const dayAgo = t - 24 * 60 * 60 * 1000;
  const kept = (records || []).filter(r => r && new Date(r.expiresAt).getTime() > dayAgo);
  const out = kept.map(r => (r.userId === record.userId && !r.usedAt && !r.supersededAt)
    ? { ...r, supersededAt: new Date(now).toISOString() } : r);
  out.push(record);
  return out;
}

// Self-service links issued to this person in the last hour.
function recentSelfServiceCount(records, userId, now = new Date()) {
  const hourAgo = new Date(now).getTime() - 60 * 60 * 1000;
  return (records || []).filter(r => r && r.userId === String(userId) && r.purpose === 'self_service' &&
    new Date(r.createdAt).getTime() > hourAgo).length;
}
const overSelfServiceLimit = (records, userId, now) => recentSelfServiceCount(records, userId, now) >= MAX_SELF_SERVICE_PER_HOUR;

// Look a token up. Each refusal says which it is, so the page can tell the
// person what to do next (ask for a new link, or that it was already used).
function findLink(records, token, now = new Date()) {
  if (!token || !/^[0-9a-f]{64}$/.test(String(token))) return { error: 'invalid' };
  const h = hashToken(token);
  const rec = (records || []).find(r => r && r.tokenHash === h);
  if (!rec) return { error: 'invalid' };
  if (rec.usedAt) return { error: 'used', record: rec };
  if (rec.supersededAt) return { error: 'superseded', record: rec };
  if (new Date(rec.expiresAt).getTime() <= new Date(now).getTime()) return { error: 'expired', record: rec };
  return { record: rec };
}

const markUsed = (records, id, now = new Date()) =>
  (records || []).map(r => (r && r.id === id ? { ...r, usedAt: new Date(now).toISOString() } : r));

// The password rules every other password route already applies (config.js).
function passwordProblem(password, { minLength, regex }) {
  const p = typeof password === 'string' ? password : '';
  if (p.length < minLength) return `Your password must be at least ${minLength} characters.`;
  if (regex && !regex.test(p)) return 'Your password needs at least one uppercase letter, one lowercase letter and one number.';
  return null;
}

module.exports = {
  SELF_SERVICE_TTL_MS, ADMIN_TTL_MS, OFFER_TTL_MS, MAX_SELF_SERVICE_PER_HOUR, PURPOSES,
  hashToken, buildLink, addLink, recentSelfServiceCount, overSelfServiceLimit,
  findLink, markUsed, passwordProblem
};
