// ============================================================================
// STAFF ANNOUNCEMENTS — who sees an office post, decided in one place
// ============================================================================
// Owner, 2026-11-10: an area every staff member can open for announcements
// and upgrade notes, built on the caregiver Feed rather than beside it. The
// posts stay in `caregiver_broadcasts`, the collection the Feed already reads;
// each row now says who it is for.
//
//   audience: 'all_staff'          every staff account type, caregivers too
//   audience: ['rn', 'manager']    only those account types
//   audience: absent               caregivers only — every post made before
//                                  2026-11-10 was a caregiver Feed post, and
//                                  reading it any wider would show it to
//                                  people it was never written for
//
// The caregiver Feed and My GFC → Announcements both filter through
// `visibleTo`, so the two reads cannot disagree about who sees a post.
//
// "I've reviewed this" is one append-only row per person per post in
// `staff_announcement_reads`. Nothing here is PHI: an announcement is office
// news, and the composer says plainly that it must carry no client names.
//
// Pure: no storage, no request context.
// ============================================================================

'use strict';

const ALL_STAFF = 'all_staff';
const STAFF_TYPES = Object.freeze(['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'liaison']);
const LEGACY_AUDIENCE = Object.freeze(['caregiver']);
const TITLE_MAX = 200;
const BODY_MAX = 4000;

const audienceOf = (row) => {
  if (!row) return [];
  if (row.audience === ALL_STAFF) return ALL_STAFF;
  if (Array.isArray(row.audience) && row.audience.length) return row.audience;
  return LEGACY_AUDIENCE;
};

/** May a staff member of this account type see this post? */
const visibleTo = (row, type) => {
  if (!row || row.active === false || !STAFF_TYPES.includes(type)) return false;
  const a = audienceOf(row);
  return a === ALL_STAFF || a.includes(type);
};

/**
 * Validate what a composer sent. An absent audience keeps the old meaning
 * (caregivers), so a caller that never heard of audiences behaves as before.
 * → { ok, audience } | { ok: false, code, error }
 */
const parseAudience = (input) => {
  if (input === undefined || input === null || input === '') return { ok: true, audience: [...LEGACY_AUDIENCE] };
  if (input === ALL_STAFF) return { ok: true, audience: ALL_STAFF };
  if (!Array.isArray(input) || !input.length) {
    return { ok: false, code: 'AUDIENCE_INVALID', error: 'Choose everyone on the team, or at least one role.' };
  }
  const bad = input.filter(t => !STAFF_TYPES.includes(t));
  if (bad.length) return { ok: false, code: 'AUDIENCE_INVALID', error: `Not a staff role: ${bad.join(', ')}.` };
  return { ok: true, audience: [...new Set(input)] };
};

/** An optional link to a guide or SOP. https only, or nothing. */
const parseLink = (input) => {
  const s = String(input || '').trim();
  if (!s) return { ok: true, link: null };
  let u;
  try { u = new URL(s); } catch (e) { u = null; }
  if (!u || u.protocol !== 'https:') return { ok: false, code: 'LINK_INVALID', error: 'A link must start with https://.' };
  return { ok: true, link: u.toString() };
};

/** The posts one person sees, newest first, with whether they reviewed each. */
const forViewer = (rows, reads, user, type) => {
  const mine = new Map((reads || []).filter(r => r && String(r.user_id) === String(user.id)).map(r => [r.announcement_id, r]));
  return (rows || [])
    .filter(r => visibleTo(r, type))
    .map(r => ({
      id: r.id, title: r.title, body: r.body, link: r.link || null,
      at: r.posted_at, byName: r.posted_by_name,
      reviewedAt: mine.has(r.id) ? mine.get(r.id).reviewed_at : null
    }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
};

/**
 * For the admin team: each post, who it reaches, and who has and has not
 * reviewed it. `people` is [{ id, name, type }] for active staff.
 */
const report = (rows, reads, people) => (rows || [])
  .map(r => {
    const reached = (people || []).filter(p => visibleTo({ ...r, active: true }, p.type));
    const done = new Set((reads || []).filter(x => x && x.announcement_id === r.id).map(x => String(x.user_id)));
    const audience = audienceOf(r);
    return {
      id: r.id, title: r.title, body: r.body, link: r.link || null,
      at: r.posted_at, byName: r.posted_by_name, active: r.active !== false,
      audience,
      reviewed: reached.filter(p => done.has(String(p.id))).map(p => p.name),
      notReviewed: reached.filter(p => !done.has(String(p.id))).map(p => p.name)
    };
  })
  .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

module.exports = {
  ALL_STAFF, STAFF_TYPES, LEGACY_AUDIENCE, TITLE_MAX, BODY_MAX,
  audienceOf, visibleTo, parseAudience, parseLink, forViewer, report
};
