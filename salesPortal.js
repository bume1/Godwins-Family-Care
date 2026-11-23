// ============================================================================
// salesPortal.js — THE SALES PORTAL'S CONTENT (owner, 2026-11-23)
// ============================================================================
// The Sales Portal used to live on the public website, which was down for
// most of November 2026. Growth work moved into the app so it no longer
// depends on the site. Owner: "get the original onto the app first", so the
// sections below are the website's portal as it stood (August 2026 copy),
// ported as-is. Refinements and the related scripts come after.
//
// Every link here points INSIDE the app or at an outside site we do not run.
// None may point at the old website (godwinsfamilycarellc.com without the
// app. prefix); test/sales_portal.test.js fails the build if one does.
//
// Not PHI: this is marketing and outreach material, no client records.
// ============================================================================

const SOURCE = Object.freeze({
  from: 'Public website Sales Portal, August 2026 copy',
  portedAt: null
});

// Each section: { id, title, intro, items: [{ kind, title, body?, href? }] }
// kind: 'script' (text to read or send), 'link', 'document', 'note'.
// `stale` on an item flags something that looked out of date in the copy.
const SECTIONS = Object.freeze([]);

const OLD_SITE = /^https?:\/\/(www\.)?godwinsfamilycarellc\.com(\/|$)/i;

function portal() {
  return { source: SOURCE, sections: SECTIONS };
}

module.exports = { portal, SECTIONS, SOURCE, OLD_SITE };
