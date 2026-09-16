// ============================================================================
// GFC APP LINKS — the one place that answers "where does this person go?"
//
// Every link in every email is built from here. Before this module the answer
// was given in five places and three of them were wrong (owner report,
// 2026-09-16):
//
//   1. THE HOST WAS THE MARKETING SITE. `getAppBaseUrl()` fell back to
//      `https://godwinsfamilycarellc.com` — a lab-era default — so unless the
//      stored portal domain happened to be set, every CTA in every notice sent
//      the reader to the public website, which has no portal on it.
//   2. A SHIFT EMAIL DROPPED THE CAREGIVER ON THE HOME TAB. "Open the caregiver
//      app" is true and useless: the caregiver is being told about a SHIFT and
//      then has to go find it. It deep-links to the schedule now.
//   3. THE MESSAGE NOTICE SENT EVERYONE TO `/portal`. Messaging mounts on four
//      surfaces — portal, caregiver app, clinician workspace, admin hub — and
//      the notice goes to whoever is on the thread. A caregiver, a clinician
//      and an admin were all being sent to the CLIENT's portal.
//
// THE RULE: a path here must be one the server actually serves. That is not a
// convention, it is a test — `test/app_links.test.js` boots the app and
// requests every one of them. `/admin-hub` was a dead link in a live notice
// and nothing caught it, because "it looks like a path" is not evidence a
// route exists.
// ============================================================================

'use strict';

// Every destination an email may point at. Names, not literals, at the call
// sites: a path that moves gets corrected once, here.
const PATHS = Object.freeze({
  PORTAL: '/portal',                        // client + family
  CAREGIVER_APP: '/caregiver',              // caregiver home
  CAREGIVER_SCHEDULE: '/caregiver#schedule',// their shifts — where a shift notice belongs
  CAREGIVER_MORE: '/caregiver#more',        // messages + documents live here
  CLINICAL: '/clinical',                    // clinician workspace + case-manager read
  SCHEDULING: '/scheduling',                // ADMIN shift board, not the caregiver's
  CAREGIVER_ADMIN: '/caregivers',           // admin supervision: escalations, reviews
  ADMIN: '/admin',                          // the admin hub. NOT `/admin-hub`, which 404s.
  ENROLLMENT: '/admin/enrollment',
  LOGIN: '/login'
});

const ROLES = { ADMIN: 'admin', CLIENT: 'client', FAMILY: 'family', VENDOR: 'vendor', CLINICAL: 'user', CASE_MANAGER: 'caseManager' };

// Is this person a caregiver? A `vendor` without a licence level is the
// lab-era vendor surface, not the caregiver app — Session 6's rule, reused
// rather than restated, so a link cannot disagree with the login destination.
const isCaregiver = (u) => !!(u && u.role === ROLES.VENDOR && u.licenseLevel);
const isClinical = (u) => !!(u && (u.role === ROLES.CLINICAL || u.hasClinicalAccess || u.clinicalRole === 'provider' ||
  u.clinicalRole === 'rn' || u.clinicalRole === 'lcsw' || u.clinicalRole === 'lmsw'));

// Where this person lands when they sign in. Mirrors `directDestination()` in
// public/login.html: an email that sends somebody somewhere their login would
// not is an email that sends them to a screen they cannot use.
function homeFor(user) {
  if (!user) return PATHS.LOGIN;
  if (user.role === ROLES.CLIENT || user.role === ROLES.FAMILY) return PATHS.PORTAL;
  if (isCaregiver(user)) return PATHS.CAREGIVER_APP;
  if (isClinical(user) || user.role === ROLES.CASE_MANAGER) return PATHS.CLINICAL;
  if (user.role === ROLES.ADMIN) return PATHS.ADMIN;
  return PATHS.LOGIN;
}

// The surface THIS person reads messages on. Messaging is one component
// mounted on four pages, so the notice has to resolve per recipient — the
// single `/portal` it used to send was right for two roles out of five.
function messagesFor(user) {
  if (!user) return PATHS.LOGIN;
  if (user.role === ROLES.CLIENT || user.role === ROLES.FAMILY) return PATHS.PORTAL;
  if (isCaregiver(user)) return PATHS.CAREGIVER_MORE;   // the More tab carries it
  if (isClinical(user) || user.role === ROLES.CASE_MANAGER) return PATHS.CLINICAL;
  if (user.role === ROLES.ADMIN) return PATHS.ADMIN;
  return PATHS.LOGIN;
}

// A shift concerns a caregiver, so it points at their schedule — never the
// admin board at `/scheduling`, which they cannot open.
const shiftFor = () => PATHS.CAREGIVER_SCHEDULE;

// The path without its #fragment, which is what a server route matches.
const routeOf = (p) => String(p || '').split('#')[0].split('?')[0];

const ALL_PATHS = Object.freeze(Object.values(PATHS));

module.exports = { PATHS, ALL_PATHS, homeFor, messagesFor, shiftFor, routeOf, isCaregiver, isClinical };
