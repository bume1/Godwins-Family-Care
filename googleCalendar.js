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
// ============================================================================

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TIME_ZONE = 'America/New_York';
const COLLECTION = 'google_calendar_events';

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
  const blockers = [];
  if (!sa) blockers.push('GOOGLE_SERVICE_ACCOUNT_KEY is not set (or is not valid JSON)');
  if (!impersonate) blockers.push('GOOGLE_CALENDAR_IMPERSONATE is not set (and GMAIL_SEND_AS is not set to fall back on)');
  if (!calendarId) blockers.push('GOOGLE_CLINICAL_CALENDAR_ID is not set');
  return { configured: !blockers.length, calendarId: calendarId || null, impersonating: impersonate || null, blockers };
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

module.exports = { calendarStatus, buildEvent, addMinutes, upsertVisit, removeVisit, setClientForTests, COLLECTION, CALENDAR_SCOPE };
