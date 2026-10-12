#!/usr/bin/env node
/**
 * Google Meet video visits — HTTP round trip (T1, 2026-10-12).
 *
 * Drives the REAL server and the REAL routes: booking a video visit creates a
 * room, a reschedule carries it, a reschedule out of video shuts it, a
 * cancellation shuts it and revokes the one-tap links, the clinician's start
 * stamps the visit, the pre-join checks warn without blocking, the patient's
 * join link is refused outside its window and served inside it, and /v/<token>
 * works once and dies with the visit.
 *
 * Every assertion reads a STORED row or the served body BACK — never a status
 * code alone, which is the trap that cost this repo the soap_note,
 * encounter-PUT, allergy and both Phase 6B defects.
 *
 * Stubbed, because none is reachable from a build sandbox: the KV store, the
 * OpenEMR transport, and GOOGLE MEET. The fake Meet is stateful — spaces are
 * kept, and a restricted one is readable as restricted — so what is asserted
 * is what Google would hold. NOT proven here, stated plainly: that Google
 * accepts the credential and the space configuration. Run the admin
 * "Test video room" button on the deployment to close that half.
 *
 *   node scripts/verify_telehealth_visits.js
 */
process.env.PORT = process.env.PORT || '4617';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'telehealth-verification-secret';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';
process.env.APP_BASE_URL = 'https://app.example.test';
// Enough for `meetStatus()` to read as configured; the transport is replaced
// below, so nothing reaches Google.
process.env.MEET_WORKSPACE_DOMAINS = 'example.test';

const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');

// ---- the store --------------------------------------------------------------
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(p) { return [...STORE.keys()].filter(k => !p || k.startsWith(p)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r === '@replit/database') return '__memdb__';
  return realResolve.call(this, r, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };
const rows = (k) => STORE.get(k) || [];

// ---- a stateful fake Google Meet -------------------------------------------
const MEET = { seq: 0, spaces: new Map(), ended: [], calls: [], failNext: false };
const meetRooms = require(path.join(__dirname, '..', 'meetRooms.js'));
const REAL_CONFIG = meetRooms.SPACE_CONFIG;
meetRooms.meetStatus = () => ({ configured: true, blockers: [] });
meetRooms.createSpace = async (clinicianEmail) => {
  MEET.calls.push({ op: 'create', as: clinicianEmail });
  if (MEET.failNext) { MEET.failNext = false; const e = new Error('Meet refused the room'); e.code = 'MEET_CALL_FAILED'; throw e; }
  const n = ++MEET.seq;
  const space = {
    spaceName: `spaces/probe-${n}`,
    meetingUri: `https://meet.example.test/room-${n}`,
    meetingCode: `abc-def-${n}`,
    hostedBy: clinicianEmail,
    accessType: REAL_CONFIG.accessType,
    config: REAL_CONFIG
  };
  MEET.spaces.set(space.spaceName, space);
  return space;
};
meetRooms.closeSpace = async (clinicianEmail, spaceName) => {
  MEET.calls.push({ op: 'close', as: clinicianEmail, spaceName });
  const s = MEET.spaces.get(spaceName);
  if (s) { s.accessType = 'RESTRICTED'; MEET.ended.push(spaceName); }
  return { ok: !!s, failures: s ? [] : ['no such space'] };
};

// ---- a stateful fake OpenEMR ------------------------------------------------
const EMR = { seq: 500, appts: new Map(), encounters: new Map(), soap: new Map(), deleted: [] };
const FACILITIES = [
  { id: '3', name: 'Vinings office', pos_code: '11', service_location: '1', billing_location: '1', primary_business_entity: '1' },
  { id: '5', name: 'Private Residence', pos_code: '12', service_location: '1', billing_location: '0', primary_business_entity: '0' }
];
const PUUID = 'uuid-video-patient';
const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
const apptList = (puuid) => [...EMR.appts.values()].filter(a => a.puuid === (puuid || PUUID));
openemr.forActor = () => new Proxy({}, {
  get(_t, prop) {
    switch (prop) {
      case 'getFacilities': return async () => FACILITIES;
      case 'listAppointmentRows': return async () => [...EMR.appts.values()];
      case 'getPatientAppointmentRows': return async (puuid) => apptList(puuid);
      case 'getAppointmentRow': return async (puuid, eid) => EMR.appts.get(String(eid)) || null;
      case 'createAppointmentRow': return async (puuid, fields) => {
        const eid = String(++EMR.seq);
        EMR.appts.set(eid, { pc_eid: eid, puuid, ...fields, pc_endTime: fields.pc_endTime || '15:00:00' });
        return eid;
      };
      // The tombstone swap: new rows first, the superseded row removed last.
      case 'swapAppointment': return async (puuid, oldEid, newRows) => {
        const newEids = newRows.map(f => {
          const eid = String(++EMR.seq);
          EMR.appts.set(eid, { pc_eid: eid, puuid, ...f, pc_endTime: f.pc_endTime || '15:00:00' });
          return eid;
        });
        EMR.appts.delete(String(oldEid));
        EMR.deleted.push(String(oldEid));
        return { newEids, deleted: true, deleteError: null };
      };
      case 'createEncounter': return async (puuid, fields) => {
        const eid = String(++EMR.seq); const euuid = `enc-${eid}`;
        EMR.encounters.set(euuid, { puuid, eid, ...fields });
        return { euuid, eid };
      };
      case 'getEncounterRow': return async (puuid, euuid) => {
        const e = EMR.encounters.get(euuid); if (!e) return null;
        const f = FACILITIES.find(x => x.id === String(e.facility_id));
        return { eid: e.eid, date: e.date, reason: e.reason, pos_code: e.pos_code || null, facility_id: e.facility_id || null, facility_name: f ? f.name : null };
      };
      case 'updateEncounter': return async (puuid, euuid, fields) => { Object.assign(EMR.encounters.get(euuid) || {}, fields); return {}; };
      case 'addSoapNote': return async (puuid, euuid, note) => { const sid = String(++EMR.seq); EMR.soap.set(sid, { id: sid, euuid, ...note }); return { sid }; };
      case 'updateSoapNote': return async (puuid, euuid, sid, note) => { EMR.soap.set(String(sid), { id: String(sid), euuid, ...note }); return {}; };
      case 'getSoapNote': return async (puuid, euuid, sid) => EMR.soap.get(String(sid)) || null;
      case 'getSoapNotes': return async (puuid, euuid) => [...EMR.soap.values()].filter(n => n.euuid === euuid);
      case 'addVitals': return async () => ({});
      case 'uploadPatientDocument': return async () => true;
      default:
        if (/^get|^list/.test(String(prop))) return async () => [];
        return async () => { throw new Error(`openemr.${String(prop)} not stubbed`); };
    }
  }
});

// ---- the world --------------------------------------------------------------
const config = require(path.join(__dirname, '..', 'config.js'));
const practiceTime = require(path.join(__dirname, '..', 'public', 'gfc-time.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const PW = 'Probe12345!';
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 400)}` : ''}`); } };
const call = async (m, u, t, b) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; const text = await r.text();
  try { j = JSON.parse(text); } catch (_) { j = { html: text }; }
  return { status: r.status, body: j };
};
const login = async (email) => { const r = await call('POST', '/api/auth/login', null, { email, password: PW }); return r.body && r.body.token; };
const videoLink = (eid) => rows('appointment_video_links').find(r => String(r.eid) === String(eid)) || null;
const joinTokens = () => rows('appointment_join_tokens');
const timing = (eid) => rows('visit_timings').find(r => String(r.eid) === String(eid)) || null;
const reminders = (eid, kind) => rows('visit_reminders').filter(r => String(r.eid) === String(eid) && (!kind || (r.kind || 'day_before') === kind));

// Tomorrow and the day after, in Georgia, so the booking is always in the
// future however long the probe takes to reach a section.
const ga = practiceTime.zonedParts(new Date()).isoDate;
const plus = (n) => new Date(Date.parse(`${ga}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const DAY1 = plus(3), DAY2 = plus(4);

const staff = (id, name, clinicalRole, licenseLevel, extra = {}) => ({
  id, name: `${name} (TEST DATA)`, email: `${id}@example.test`, role: 'user', clinicalRole, licenseLevel,
  hasClinicalAccess: clinicalRole !== 'readOnly', npi: clinicalRole === 'provider' ? '1234567893' : null,
  openEmrProviderId: clinicalRole === 'provider' ? '7' : null, accountStatus: 'active', ...extra
});
const FNP = staff('fnp_v', 'Bethel Godwins', 'provider', 'FNP');
// A clinician with NO Workspace mailbox — the one blocker nobody finds out
// about from a setting. Their visits book and then have no room.
const NOMAIL = staff('fnp_x', 'Nadia Ross', 'provider', 'FNP', { email: 'nadia@gmail.com', openEmrProviderId: '9' });
const ADMIN = { id: 'adm_v', name: 'Admin (TEST DATA)', email: 'adm_v@example.test', role: config.ROLES.ADMIN, accountStatus: 'active' };
const PATIENT = {
  id: 'c_video', role: config.ROLES.CLIENT, email: 'c_video@example.test', name: 'Video Probe Patient (TEST DATA)',
  slug: 'video-probe', serviceLine: 'IHPC', enrollmentStatus: 'enrolled', openEmrPatientId: PUUID,
  openEmrFacilityId: '5', usualLocation: 'home', intake: { dob: '1948-03-11' },
  consents: { consentToTreat: 'signed', assignmentOfBenefits: 'signed', practiceNpp: 'signed', roiFamily: 'signed' },
  consentMeta: { consentToTreat: { choices: { telehealth: 'consent' } } },
  sharing: { appointments: true, visitSummaries: 'full' }
};
const POA = {
  id: 'f_poa', role: config.ROLES.FAMILY, email: 'f_poa@example.test', name: 'Pat Olsen (TEST DATA)',
  familyOfClientId: 'c_video', familyIsPoa: true, accountStatus: 'active'
};
const COUSIN = {
  id: 'f_cousin', role: config.ROLES.FAMILY, email: 'f_cousin@example.test', name: 'Cass Unger (TEST DATA)',
  familyOfClientId: 'c_video', accountStatus: 'active'
};

(async () => {
  const hash = await bcrypt.hash(PW, 4);
  STORE.set('users', [PATIENT, POA, COUSIN, FNP, NOMAIL, ADMIN].map(u => ({ ...u, password: hash })));
  STORE.set('gfc_payer_credentialing', { billing_npi_used: '1234567893', billing_provider_name: 'GFC' });
  const fresh = new Date().toISOString();
  STORE.set('gfc_ncci_source_version', { ptp: { quarter: '2026Q4', loadedAt: fresh }, mue: { quarter: '2026Q4', loadedAt: fresh } });

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3000));
  const tok = {};
  for (const [k, u] of Object.entries({ fnp: FNP, nomail: NOMAIL, adm: ADMIN, pt: PATIENT, poa: POA, cousin: COUSIN })) tok[k] = await login(u.email);
  if (!tok.fnp || !tok.pt || !tok.adm) { console.log('LOGIN FAILED', tok); process.exit(1); }
  const P = `/api/clinical/patients/${PATIENT.id}`;

  console.log('\n── A. Booking a video visit creates a room ──');
  let r = await call('POST', `${P}/appointments`, tok.fnp, {
    date: DAY1, startTime: '14:00', durationMinutes: 30, providerId: '7', location: 'telehealth', title: 'Video follow-up'
  });
  check('the booking is accepted', r.status === 200, r.body);
  const eid1 = r.body && r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
  check('OpenEMR holds the appointment', !!eid1 && EMR.appts.has(String(eid1)));
  check('a room was created and the response carries it', !!(r.body.video && r.body.video.meetingUri), r.body.video);
  const link1 = videoLink(eid1);
  check('the pointer is stored against the appointment', !!link1 && link1.clientId === PATIENT.id, link1);
  check('the pointer carries NO date, time or status — the calendar is the one record',
    !!link1 && !('date' in link1) && !('startTime' in link1) && !('status' in link1), link1 && Object.keys(link1));
  check('the room was created as the APPOINTMENT\'s clinician, not the caller',
    MEET.calls.some(c => c.op === 'create' && c.as === FNP.email));
  check('the activity log names the visit and the space, never the join link', (() => {
    const row = rows('activity_log').find(a => a.action === 'video_room_created');
    return row && row.details && row.details.spaceName && !JSON.stringify(row).includes('meet.example.test');
  })(), rows('activity_log').filter(a => a.action === 'video_room_created'));
  check('a day-of nudge was scheduled 30 minutes before the start',
    reminders(eid1, 'video_join').length === 1 &&
    reminders(eid1, 'video_join')[0].sendAt === new Date(Date.parse(practiceTime.instantFromZoned(DAY1, '14:00')) - 30 * 60000).toISOString(),
    reminders(eid1, 'video_join'));
  check('the day-before reminder is still there too', reminders(eid1, 'day_before').length === 1);

  console.log('\n── A2. A home visit gets no room, and neither does a phone call ──');
  for (const loc of ['home', 'phone']) {
    r = await call('POST', `${P}/appointments`, tok.fnp, { date: DAY1, startTime: loc === 'home' ? '09:00' : '10:00', durationMinutes: 30, providerId: '7', location: loc });
    const eid = r.body && r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
    check(`a ${loc} visit creates no room`, r.status === 200 && !videoLink(eid) && !r.body.video, r.body);
    check(`and no day-of nudge`, reminders(eid, 'video_join').length === 0);
  }

  console.log('\n── A3. A clinician with no Workspace mailbox: the booking stands, the room does not ──');
  r = await call('POST', `${P}/appointments`, tok.adm, {
    date: DAY1, startTime: '16:00', durationMinutes: 30, providerId: '9', location: 'telehealth'
  });
  const eidNoHost = r.body && r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
  check('the visit is on the calendar anyway — a Meet failure never blocks a booking', r.status === 200 && EMR.appts.has(String(eidNoHost)), r.body);
  check('and the caller is told why there is no room', (r.body.warnings || []).some(w => /no GFC Google account|Video room not created/i.test(w)), r.body.warnings);
  check('no pointer was written', !videoLink(eidNoHost));

  console.log('\n── A4. Meet itself refusing: still just a warning ──');
  MEET.failNext = true;
  r = await call('POST', `${P}/appointments`, tok.fnp, { date: DAY1, startTime: '17:00', durationMinutes: 30, providerId: '7', location: 'telehealth' });
  const eidFail = r.body && r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
  check('the booking still succeeded', r.status === 200 && EMR.appts.has(String(eidFail)));
  check('the refusal is reported as a warning', (r.body.warnings || []).some(w => /Meet refused the room/.test(w)), r.body.warnings);

  console.log('\n── B. The clinician starts the visit, and that stamps it ──');
  r = await call('GET', `/api/clinical/visits/${eid1}/video`, tok.fnp);
  check('the room reads back for the clinician', r.status === 200 && r.body.video && r.body.video.meetingUri === link1.meetingUri, r.body);
  r = await call('POST', `/api/clinical/visits/${eid1}/video/start`, tok.fnp);
  check('starting it returns the join link', r.status === 200 && r.body.video.meetingUri === link1.meetingUri, r.body);
  check('and STAMPS the visit as started', !!(timing(eid1) && timing(eid1).startedAt), timing(eid1));
  const firstStart = timing(eid1).startedAt;
  r = await call('POST', `/api/clinical/visits/${eid1}/video/start`, tok.fnp);
  check('rejoining still opens the room', r.status === 200 && !!r.body.video.meetingUri);
  check('and does NOT move the recorded start', timing(eid1).startedAt === firstStart, { firstStart, now: timing(eid1).startedAt });
  check('the clinician is told it was already running', /already started/i.test(r.body.timingNote || ''), r.body.timingNote);
  r = await call('POST', `/api/clinical/visits/${eidNoHost}/video/start`, tok.fnp);
  check('a visit with no room is refused by name', r.status === 409 && r.body.code === 'MEET_NO_ROOM', r.body);
  check('nothing was stamped on it', !timing(eidNoHost));
  r = await call('POST', `/api/clinical/visits/${eid1}/video/start`, tok.pt);
  check('a patient cannot use the clinician\'s door', r.status === 403, r.body);

  console.log('\n── C. The pre-join checks, on the encounter ──');
  r = await call('POST', `${P}/notes`, tok.fnp, {
    note: { kind: 'followup', visit: { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'telehealth' },
      // Every section the Follow-up template requires, so the signature below
      // is refused ONLY by what this probe is actually testing.
      // The template's required sections, by their own keys: a fixed field
      // where one answers the section (chiefConcern, subjective, assessment,
      // plan) and a `sections` entry where it does not.
      chiefConcern: 'Video follow-up', subjective: 'No new symptoms since the last visit',
      assessment: 'Hypertension, stable', plan: 'Continue current medicines',
      sections: {
        medReconciliation: 'Reviewed with the patient; no changes',
        followUp: 'Four weeks',
        mdmOrTime: 'Low complexity. 18 minutes spent on this visit.'
      } },
    appointmentEid: String(eid1)
  });
  check('the note saves', r.status === 200, r.body);
  const euuid = r.body && r.body.encounterUuid;
  r = await call('GET', `${P}/encounters/${euuid}`, tok.fnp);
  check('the encounter says it is a video visit', r.status === 200 && r.body.isVideoVisit === true, { isVideoVisit: r.body.isVideoVisit });
  check('and serves the checklist with the consent PREFILLED from the signed consent to treat',
    !!r.body.telehealthChecklist && r.body.telehealthChecklist.election === 'consent' &&
    /Consented to telehealth/.test((r.body.telehealthChecklist.items.find(i => i.key === 'consent') || {}).prefill || ''),
    r.body.telehealthChecklist);
  check('nothing is ticked yet', r.body.telehealthChecklist.complete === false && r.body.telehealthChecklist.outstanding.length === 3);
  r = await call('POST', `${P}/encounters/${euuid}/telehealth-checks`, tok.fnp, { key: 'identity', confirmed: true });
  check('a check is recorded with who and when', r.status === 200 &&
    (r.body.telehealthChecklist.items.find(i => i.key === 'identity') || {}).confirmed === true &&
    !!(r.body.telehealthChecklist.items.find(i => i.key === 'identity') || {}).by, r.body.telehealthChecklist);
  check('and stored on the encounter record',
    !!((rows('encounter_billing').find(x => x.encounterUuid === euuid) || {}).telehealthChecks || {}).identity);
  r = await call('POST', `${P}/encounters/${euuid}/telehealth-checks`, tok.fnp, { key: 'invented', confirmed: true });
  check('an unknown check is refused by name', r.status === 400 && r.body.code === 'BAD_TELEHEALTH_CHECK', r.body);
  check('the audit row carries the check, never the note', (() => {
    const a = rows('activity_log').find(x => x.action === 'telehealth_check_recorded');
    return a && a.details && a.details.check === 'identity' && !('note' in a.details);
  })());

  console.log('\n── C2. Signing WARNS about the checks and never blocks ──');
  r = await call('PUT', `${P}/encounters/${euuid}/coding`, tok.fnp, { diagnoses: [{ code: 'I10', description: 'Essential hypertension' }], services: [] });
  check('coding saves', r.status === 200, r.body);
  r = await call('POST', `${P}/encounters/${euuid}/sign`, tok.fnp, { attest: true });
  check('the note SIGNS with two checks outstanding', r.status === 200, r.body);
  check('and the signature carries a warning naming them',
    (r.body.warnings || []).some(w => /pre-join checks not recorded/i.test(w)), r.body.warnings);

  console.log('\n── D. The patient asks for the link ──');
  // Outside the window: the visit is days away.
  r = await call('GET', `/api/gfc/clinical/appointments/${eid1}/join`, tok.pt);
  check('too early is refused, and says when it opens', r.status === 409 && r.body.code === 'JOIN_TOO_EARLY' && !!r.body.opensAt, r.body);
  check('and hands out no link', !JSON.stringify(r.body).includes('meet.example.test'));
  // Inside the window: book one for right now.
  const now = practiceTime.zonedParts(new Date());
  r = await call('POST', `${P}/appointments`, tok.fnp, {
    date: now.isoDate, startTime: `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
    durationMinutes: 30, providerId: '7', location: 'telehealth', title: 'Video visit now'
  });
  const eidNow = r.body && r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
  check('a visit starting now is booked with a room', r.status === 200 && !!videoLink(eidNow), r.body);
  r = await call('GET', `/api/gfc/clinical/appointments/${eidNow}/join`, tok.pt);
  check('the patient gets the link inside the window', r.status === 200 && r.body.join.url === videoLink(eidNow).meetingUri, r.body);
  check('the hand-out is audited', rows('activity_log').some(a => a.action === 'patient_clinical_read' && a.details && a.details.resource === 'video_join_link'));
  r = await call('GET', `/api/gfc/clinical/appointments/${eidNow}/join`, tok.poa);
  check('the POA gets it too — they act for the patient everywhere else', r.status === 200 && !!r.body.join.url, r.body);
  r = await call('GET', `/api/gfc/clinical/appointments/${eidNow}/join`, tok.cousin);
  check('other family are refused, and told the patient can invite them',
    r.status === 403 && r.body.code === 'JOIN_NOT_PERMITTED' && /invite you/i.test(r.body.error), r.body);
  r = await call('GET', `/api/gfc/clinical/appointments/999999/join`, tok.pt);
  check('an appointment that is not theirs is simply not found', r.status === 404 && r.body.code === 'APPOINTMENT_NOT_FOUND', r.body);
  r = await call('GET', `/api/gfc/clinical/summary`, tok.pt);
  const published = ((r.body.appointments || []).find(a => String(a.id) === String(eidNow)) || {});
  check('the published copy carries hasVideo', published.hasVideo === true, published);
  check('and the location reads "Video visit"', published.location === 'Video visit', published);
  check('and NO join link is anywhere in the patient\'s payload', !JSON.stringify(r.body).includes('meet.example.test'));

  console.log('\n── E. The one-tap link ──');
  // Mint one the way the reminder drain does, through the real token module.
  const tokens = require(path.join(__dirname, '..', 'videoJoinTokens.js'));
  const minted = tokens.buildToken({ eid: String(eidNow), clientId: PATIENT.id, recipientUserId: PATIENT.id, recipientRole: 'patient', salt: process.env.JWT_SECRET });
  STORE.set('appointment_join_tokens', [...joinTokens(), minted.row]);
  check('the stored row holds a hash, never the token', !JSON.stringify(minted.row).includes(minted.token) && minted.row.tokenHash.length === 64);
  r = await call('GET', `/v/${minted.token}`, null);
  check('the link serves a page with no login at all', r.status === 200 && /Join the video visit/.test(r.body.html || ''), (r.body.html || '').slice(0, 200));
  check('and the page carries the room, not a redirect', /meet\.example\.test/.test(r.body.html || ''));
  check('the tap is audited', rows('activity_log').some(a => a.action === 'video_join_link_used'));
  check('and the audit row carries no link', (() => {
    const a = rows('activity_log').find(x => x.action === 'video_join_link_used');
    return a && !JSON.stringify(a).includes('meet.example.test');
  })());
  r = await call('GET', '/v/not-a-real-token', null);
  check('a token that never existed answers 404', r.status === 404 && /not valid/i.test(r.body.html || ''));

  console.log('\n── F. A reschedule carries the room; moving out of video shuts it ──');
  const before = videoLink(eid1).spaceName;
  r = await call('POST', `/api/clinical/appointments/${eid1}/reschedule`, tok.fnp, { date: DAY2, startTime: '14:00', durationMinutes: 30 });
  check('the reschedule is accepted', r.status === 200, r.body);
  const eid1b = r.body && r.body.appointmentEid;
  check('the swap gave it a NEW eid', !!eid1b && String(eid1b) !== String(eid1));
  check('and the room followed it — same space, new eid', !!videoLink(eid1b) && videoLink(eid1b).spaceName === before && !videoLink(eid1), { moved: videoLink(eid1b), old: videoLink(eid1) });
  check('the day-of nudge was re-scheduled on the new eid', reminders(eid1b, 'video_join').length === 1 && reminders(eid1, 'video_join').every(x => x.status === 'void'), { fresh: reminders(eid1b, 'video_join').length, old: reminders(eid1, 'video_join').map(x => x.status) });
  // Out of video.
  r = await call('POST', `/api/clinical/appointments/${eid1b}/reschedule`, tok.fnp, { date: DAY2, startTime: '15:00', durationMinutes: 30, location: 'home' });
  const eid1c = r.body && r.body.appointmentEid;
  check('moving it to a home visit is accepted', r.status === 200, r.body);
  check('the room pointer is GONE', !videoLink(eid1c) && !videoLink(eid1b));
  check('Google was told to restrict the space', MEET.spaces.get(before).accessType === 'RESTRICTED');
  check('and no day-of nudge was created for a home visit', reminders(eid1c, 'video_join').length === 0);
  check('the day-before reminder survived the move', reminders(eid1c, 'day_before').length === 1, reminders(eid1c));

  console.log('\n── F2. The reschedule never guesses the place ──');
  // A row whose location marker cannot be hydrated — the 7.0.4 list quirk that
  // used to turn a video visit into a house call.
  r = await call('POST', `${P}/appointments`, tok.fnp, { date: DAY2, startTime: '11:00', durationMinutes: 30, providerId: '7', location: 'telehealth' });
  const eidBlind = r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
  EMR.appts.get(String(eidBlind)).pc_hometext = '';   // the marker is unreadable
  r = await call('POST', `/api/clinical/appointments/${eidBlind}/reschedule`, tok.fnp, { date: DAY2, startTime: '12:00', durationMinutes: 30 });
  check('it is REFUSED rather than quietly becoming a home visit', r.status === 409 && r.body.code === 'APPT_LOCATION_UNKNOWN', r.body);
  check('and the appointment is untouched', EMR.appts.has(String(eidBlind)) && EMR.appts.get(String(eidBlind)).pc_eventDate === DAY2 && EMR.appts.get(String(eidBlind)).pc_startTime === '11:00');
  r = await call('POST', `/api/clinical/appointments/${eidBlind}/reschedule`, tok.fnp, { date: DAY2, startTime: '12:00', durationMinutes: 30, location: 'telehealth' });
  check('naming the place lets it through', r.status === 200, r.body);
  const eidBlindB = r.body.appointmentEid;

  console.log('\n── G. Cancelling shuts the room and kills the links ──');
  const cancelSpace = videoLink(eidBlindB).spaceName;
  STORE.set('appointment_join_tokens', [...joinTokens(),
    tokens.buildToken({ eid: String(eidBlindB), clientId: PATIENT.id, recipientUserId: PATIENT.id, recipientRole: 'patient', salt: process.env.JWT_SECRET }).row]);
  const cancelToken = joinTokens().find(t => String(t.eid) === String(eidBlindB));
  r = await call('POST', `/api/clinical/appointments/${eidBlindB}/cancel`, tok.fnp, { reason: 'Patient in hospital' });
  check('the cancellation is accepted', r.status === 200, r.body);
  check('the room pointer is gone', !videoLink(eidBlindB));
  check('Google was told to restrict the space', MEET.spaces.get(cancelSpace).accessType === 'RESTRICTED');
  check('and the one-tap link is REVOKED, not deleted — a shut link can still say it was shut',
    (() => { const t = joinTokens().find(x => x.id === cancelToken.id); return !!t && !!t.revokedAt; })(), joinTokens().map(t => ({ id: t.id, revokedAt: t.revokedAt })));
  check('every reminder for it is void', reminders(eidBlindB).every(x => x.status === 'void'), reminders(eidBlindB).map(x => x.status));

  console.log('\n── G2. A no-show shuts the room too, and still notifies nobody ──');
  r = await call('POST', `${P}/appointments`, tok.fnp, { date: DAY2, startTime: '08:00', durationMinutes: 30, providerId: '7', location: 'telehealth' });
  const eidNs = r.body.appointment && (r.body.appointment.eid || r.body.appointment.id);
  const nsSpace = videoLink(eidNs).spaceName;
  const noticesBefore = rows('notification_queue').length;
  r = await call('POST', `/api/clinical/appointments/${eidNs}/no-show`, tok.fnp, {});
  check('the no-show is accepted', r.status === 200, r.body);
  check('the room is shut', MEET.spaces.get(nsSpace).accessType === 'RESTRICTED' && !videoLink(eidNs));
  check('its reminders are void', reminders(eidNs).every(x => x.status === 'void'));
  check('and the patient is still told NOTHING about a no-show', rows('notification_queue').length === noticesBefore,
    rows('notification_queue').slice(noticesBefore));

  console.log('\n── H. The admin can prove Meet works, and is told who cannot host ──');
  r = await call('GET', '/api/admin/meet/status', tok.adm);
  check('the status reads back', r.status === 200 && r.body.meet.configured === true, r.body);
  check('and names the clinician with no Workspace mailbox',
    (r.body.hosts.withoutWorkspaceAccount || []).some(u => u.id === NOMAIL.id), r.body.hosts);
  r = await call('GET', '/api/admin/meet/status', tok.fnp);
  check('a clinician cannot read it', r.status === 403, r.body);
  const createsBefore = MEET.calls.filter(c => c.op === 'create').length;
  r = await call('POST', '/api/admin/meet/test', tok.adm, {});
  check('the test creates a real room', r.status === 200 && r.body.roomCreated === true, r.body);
  check('and shuts it again, leaving nothing joinable',
    MEET.calls.filter(c => c.op === 'create').length === createsBefore + 1 &&
    [...MEET.spaces.values()].slice(-1)[0].accessType === 'RESTRICTED');
  check('no pointer was stored for the test room', rows('appointment_video_links').every(x => x.spaceName !== [...MEET.spaces.values()].slice(-1)[0].spaceName));
  r = await call('POST', '/api/admin/meet/test', tok.adm, { userId: NOMAIL.id });
  check('testing as a clinician with no mailbox is refused by name', r.status === 409 && r.body.code === 'MEET_NO_HOST_ACCOUNT', r.body);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED:', e); process.exit(1); });
