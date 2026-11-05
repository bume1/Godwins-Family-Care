// ============================================================================
// googleCalendar.js — mirror clinical visits onto the practice's Google
// Workspace clinical calendar (owner, 2026-10-12).
//
// ONE WAY, AND WRITTEN AT THE MOMENT THE APP CHANGES A VISIT. Since Session 5.2
// a background job cannot read OpenEMR's calendar (each clinician signs in as
// themselves), so the app writes the Google event when it books, moves,
// cancels or marks a no-show, the same moments the visit reminders are written
// (Session 4.11). The consequences are the same too, and the same operating
// rule covers them: a visit created or moved DIRECTLY in OpenEMR does not
// reach Google, and an event added directly in Google does not reach OpenEMR.
// Book clinical visits in the app.
//
// Google Calendar is inside the Workspace BAA, so the event carries what a
// clinician driving to a visit needs: the patient's name and, for a home
// visit, the address. Nothing clinical (no reason for the visit beyond its
// type, no diagnosis, no notes).
//
// BEST-EFFORT. A calendar failure never undoes or blocks a visit that is
// already on the OpenEMR calendar; it is logged and returned as a reason.
//
// Credentials: the same service account as Gmail and Drive, with the
// calendar.events scope added to its domain-wide delegation, impersonating
// GOOGLE_CALENDAR_IMPERSONATE (falls back to GMAIL_SEND_AS), writing to the
// calendar GOOGLE_CLINICAL_CALENDAR_ID names. That user must be able to edit
// that calendar.
//
// ── THE PROVIDER'S INVITE (owner, 2026-11-05) ───────────────────────────────
//
// Clinicians here mostly hold personal Gmail accounts, so a visit booked in
// the app sends them a calendar invite at whatever address is on their user
// record. That invite is a SECOND, DELIBERATELY PHI-FREE EVENT, and the
// separation is the whole point:
//
//   ⚠️ THE WORKSPACE BAA COVERS THE GFC DOMAIN. IT DOES NOT COVER A PERSONAL
//   @gmail.com. The clinical@ event carries the patient's name and, for a
//   home visit, their home address; putting that in front of an attendee at
//   an uncovered mailbox is a disclosure, not a formatting choice. So the
//   invite carries the time, the kind of visit and "open the app" — the same
//   rule the patient message notice already follows — and the identifying
//   half never leaves the covered calendar.
//
// The two events therefore live on DIFFERENT CALENDARS: the full one on
// GOOGLE_CLINICAL_CALENDAR_ID, the invites on GOOGLE_PROVIDER_INVITE_CALENDAR_ID.
// With no invite calendar set, NO INVITES ARE SENT and the boot log says so —
// defaulting them onto the clinical calendar would put two rows on every
// visit for everyone reading it, which is a change nobody asked for.
// ============================================================================

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TIME_ZONE = 'America/New_York';
const COLLECTION = 'google_calendar_events';
// The invites are their own map: one visit has a full event AND an invite
// event, on two calendars, and a single map could only remember one of them.
const INVITE_COLLECTION = 'google_calendar_invites';

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw || !String(raw).trim()) return null;
  try {
    const text = String(raw).trim().startsWith('{') ? String(raw) : Buffer.from(String(raw).trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    if (!parsed.client_email || !parsed.private_key) return null;
    if (parsed.private_key.includes('\\n')) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    return parsed;
  } catch (_) { return null; }
}

// What is missing, all of it, so setup takes one restart not three. Being
// configured is not proof Google accepts it; only a real write is.
function calendarStatus() {
  const sa = loadServiceAccount();
  const impersonate = String(process.env.GOOGLE_CALENDAR_IMPERSONATE || process.env.GMAIL_SEND_AS || '').trim();
  const calendarId = String(process.env.GOOGLE_CLINICAL_CALENDAR_ID || '').trim();
  const inviteCalendarId = String(process.env.GOOGLE_PROVIDER_INVITE_CALENDAR_ID || '').trim();
  const blockers = [];
  if (!sa) blockers.push('GOOGLE_SERVICE_ACCOUNT_KEY is not set (or is not valid JSON)');
  if (!impersonate) blockers.push('GOOGLE_CALENDAR_IMPERSONATE is not set (and GMAIL_SEND_AS is not set to fall back on)');
  if (!calendarId) blockers.push('GOOGLE_CLINICAL_CALENDAR_ID is not set');
  return {
    configured: !blockers.length, calendarId: calendarId || null,
    impersonating: impersonate || null, blockers,
    // Invites are their own switch. Deliberately NOT defaulted to the clinical
    // calendar: that would put a second row on every visit for every reader.
    inviteCalendarId: inviteCalendarId || null,
    invitesConfigured: !blockers.length && !!inviteCalendarId
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
// "09:00" + 45 minutes -> "09:45". A visit that would run past midnight is
// clipped to 23:59 rather than written as an event on the wrong day.
function addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (isNaN(h)) return null;
  const total = Math.min(h * 60 + (m || 0) + (Number(minutes) || 30), 23 * 60 + 59);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
const hhmm = (t) => { const [h, m] = String(t || '').split(':'); return h ? `${pad2(Number(h))}:${pad2(Number(m || 0))}` : null; };

const LOCATION_LABEL = { home: 'Home visit', telehealth: 'Video / phone visit', office: 'Office visit' };

// The event, pure. Times are wall-clock in Georgia with the zone named, so a
// calendar viewed from anywhere shows the right hour on both sides of DST.
function buildEvent({ eid, title, patientName, date, startTime, durationMinutes, location, address, clinicianName, status }) {
  const start = hhmm(startTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !start) return null;
  const end = addMinutes(start, durationMinutes);
  const where = LOCATION_LABEL[location] || 'Visit';
  const prefix = status === 'no_show' ? 'No-show: ' : '';
  const summary = `${prefix}${title || where}${patientName ? ` · ${patientName}` : ''}`;
  const lines = [where, clinicianName ? `With ${clinicianName}` : null, 'Booked in the Godwins Family Care app. Change it there, not here.'].filter(Boolean);
  return {
    summary,
    description: lines.join('\n'),
    location: location === 'home' && address ? address : undefined,
    start: { dateTime: `${date}T${start}:00`, timeZone: TIME_ZONE },
    end: { dateTime: `${date}T${end}:00`, timeZone: TIME_ZONE },
    extendedProperties: { private: { gfcAppointmentEid: String(eid) } }
  };
}

// ⚠️ THE PROVIDER'S INVITE, AND IT CARRIES NO PATIENT.
//
// Built from a DIFFERENT, NARROWER INPUT than buildEvent on purpose: it is
// handed only the facts it may show, so there is no patient name or address
// in scope to leak by a later edit. Passing the whole visit and trusting
// whoever edits it next to leave two fields out is how a disclosure happens
// quietly — the same reasoning behind the critical-result notice builder,
// which takes no arguments at all.
//
// Build-enforced in test/google_calendar.test.js: this function may not read
// patientName or address, and its output may not contain either.
function buildInvite({ eid, title, date, startTime, durationMinutes, location, providerEmail }) {
  const start = hhmm(startTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !start) return null;
  if (!isEmail(providerEmail)) return null;
  const end = addMinutes(start, durationMinutes);
  const where = LOCATION_LABEL[location] || 'Visit';
  return {
    // No patient, so the summary says what KIND of visit it is and nothing
    // about whose. A bare "Visit" on somebody's calendar is useless.
    summary: `GFC ${title || where}`,
    description: [
      where,
      'Open the Godwins Family Care app for the patient, the address and the chart.',
      'This invite deliberately carries no patient details.',
      'Booked in the app. Change it there, not here.'
    ].join('\n'),
    start: { dateTime: `${date}T${start}:00`, timeZone: TIME_ZONE },
    end: { dateTime: `${date}T${end}:00`, timeZone: TIME_ZONE },
    attendees: [{ email: String(providerEmail).trim() }],
    // The clinician cannot change the visit from their own calendar — it is
    // booked in the app, and a guest edit here would never reach OpenEMR.
    guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false,
    extendedProperties: { private: { gfcAppointmentEid: String(eid), gfcInvite: '1' } }
  };
}

// Deliberately strict rather than clever: an address Google refuses fails the
// whole insert, and a silent non-invite is worse than not offering one.
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v == null ? '' : v).trim());

// The Google client, built once per call. Injected in tests.
let _clientOverride = null;
function setClientForTests(c) { _clientOverride = c; }
function getClient() {
  if (_clientOverride) return _clientOverride;
  const { google } = require('googleapis');
  const sa = loadServiceAccount();
  const status = calendarStatus();
  const auth = new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes: [CALENDAR_SCOPE], subject: status.impersonating });
  return google.calendar({ version: 'v3', auth });
}

// db: the app store. One row per OpenEMR appointment eid that has an event.
async function readMap(db) { return (await db.get(COLLECTION)) || []; }

/**
 * Put one visit on (or update it on) the Google calendar.
 * `previousEid` moves an existing event when a reschedule or a no-show swap
 * gave the visit a new eid; without it a new event is made.
 * Never throws: returns { synced, eventId?, reason? }.
 */
async function upsertVisit(db, visit, { previousEid } = {}) {
  const status = calendarStatus();
  if (!status.configured && !_clientOverride) return { synced: false, reason: 'not_configured' };
  try {
    const body = buildEvent(visit);
    if (!body) return { synced: false, reason: 'bad_visit' };
    const cal = getClient();
    const rows = await readMap(db);
    const prior = rows.find(r => r.eid === String(previousEid || visit.eid));
    let eventId;
    if (prior) {
      const r = await cal.events.patch({ calendarId: status.calendarId, eventId: prior.eventId, requestBody: body });
      eventId = (r && r.data && r.data.id) || prior.eventId;
    } else {
      const r = await cal.events.insert({ calendarId: status.calendarId, requestBody: body });
      eventId = r && r.data && r.data.id;
    }
    if (!eventId) return { synced: false, reason: 'no_event_id' };
    const next = rows.filter(r => r.eid !== String(visit.eid) && r.eid !== String(previousEid || ''));
    next.push({ eid: String(visit.eid), eventId, clientId: visit.clientId || null, at: new Date().toISOString() });
    await db.set(COLLECTION, next);
    return { synced: true, eventId };
  } catch (e) {
    console.error('[CALENDAR] sync failed (non-fatal):', e.message);
    return { synced: false, reason: e.message };
  }
}

/**
 * Invite the provider, on their own email, to a PHI-free copy of the visit.
 * `sendUpdates: 'all'` is what actually puts the invitation in their inbox —
 * without it Google creates the event and tells nobody.
 * Never throws: returns { invited, eventId?, reason? }.
 */
async function upsertInvite(db, invite, { previousEid } = {}) {
  const status = calendarStatus();
  if (!status.invitesConfigured && !_clientOverride) {
    return { invited: false, reason: status.configured ? 'no_invite_calendar' : 'not_configured' };
  }
  if (!isEmail(invite && invite.providerEmail)) return { invited: false, reason: 'no_provider_email' };
  try {
    const body = buildInvite(invite);
    if (!body) return { invited: false, reason: 'bad_visit' };
    const cal = getClient();
    const rows = (await db.get(INVITE_COLLECTION)) || [];
    const prior = rows.find(r => r.eid === String(previousEid || invite.eid));
    const calendarId = status.inviteCalendarId;
    let eventId;
    if (prior) {
      const r = await cal.events.patch({ calendarId, eventId: prior.eventId, requestBody: body, sendUpdates: 'all' });
      eventId = (r && r.data && r.data.id) || prior.eventId;
    } else {
      const r = await cal.events.insert({ calendarId, requestBody: body, sendUpdates: 'all' });
      eventId = r && r.data && r.data.id;
    }
    if (!eventId) return { invited: false, reason: 'no_event_id' };
    const next = rows.filter(r => r.eid !== String(invite.eid) && r.eid !== String(previousEid || ''));
    next.push({ eid: String(invite.eid), eventId, providerEmail: String(invite.providerEmail).trim(), at: new Date().toISOString() });
    await db.set(INVITE_COLLECTION, next);
    return { invited: true, eventId };
  } catch (e) {
    console.error('[CALENDAR] invite failed (non-fatal):', e.message);
    return { invited: false, reason: e.message };
  }
}

// A cancelled visit takes the invitation back, and `sendUpdates: 'all'` is
// what tells the provider it is off. Deleting quietly would leave them
// driving to a visit nobody cancelled as far as their phone is concerned.
async function removeInvite(db, eid) {
  const status = calendarStatus();
  if (!status.invitesConfigured && !_clientOverride) return { invited: false, reason: 'not_configured' };
  try {
    const rows = (await db.get(INVITE_COLLECTION)) || [];
    const prior = rows.find(r => r.eid === String(eid));
    if (!prior) return { invited: false, reason: 'no_event' };
    await getClient().events.delete({ calendarId: status.inviteCalendarId, eventId: prior.eventId, sendUpdates: 'all' });
    await db.set(INVITE_COLLECTION, rows.filter(r => r.eid !== String(eid)));
    return { invited: true };
  } catch (e) {
    console.error('[CALENDAR] invite removal failed (non-fatal):', e.message);
    return { invited: false, reason: e.message };
  }
}

// A cancelled visit leaves the clinicians' calendar. (OpenEMR keeps its
// cancelled tombstone with the reason; that is the record, not this.)
async function removeVisit(db, eid) {
  const status = calendarStatus();
  if (!status.configured && !_clientOverride) return { synced: false, reason: 'not_configured' };
  try {
    const rows = await readMap(db);
    const prior = rows.find(r => r.eid === String(eid));
    if (!prior) return { synced: false, reason: 'no_event' };
    await getClient().events.delete({ calendarId: status.calendarId, eventId: prior.eventId });
    await db.set(COLLECTION, rows.filter(r => r.eid !== String(eid)));
    return { synced: true };
  } catch (e) {
    console.error('[CALENDAR] remove failed (non-fatal):', e.message);
    return { synced: false, reason: e.message };
  }
}

module.exports = {
  calendarStatus, buildEvent, buildInvite, addMinutes, isEmail,
  upsertVisit, removeVisit, upsertInvite, removeInvite,
  setClientForTests, COLLECTION, INVITE_COLLECTION, CALENDAR_SCOPE
};
