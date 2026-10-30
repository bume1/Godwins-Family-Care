#!/usr/bin/env node
/**
 * Calls and messages into the patient chart (owner, 2026-10-19) — HTTP round
 * trip through the REAL server and routes.
 *
 *   - A signed Quo call webhook from the POA's phone becomes a call waiting to
 *     be documented; the AI summary that arrives FIRST is kept and merged.
 *   - Missed calls, unknown numbers, other lines and repeats go no further.
 *   - The inbox lists it for a clinician who writes Phone Call notes, not for
 *     an LMSW; Document Call opens a filled-in Phone Call note as the
 *     clinician's own draft; a second clinician cannot take it; discarding the
 *     draft puts it back; saving the note marks it documented.
 *   - A call can be dismissed only with a reason.
 *   - The note is dated the day of the CALL (the encounter date fills itself in).
 *   - Every answered call is also a call note: summary and transcript, on the
 *     timeline, filed to OpenEMR on chart open.
 *   - Message notes: only patient-facing conversations, ONE per conversation;
 *     the timeline lists them without their words; the words open on
 *     request; a conversation with no message today files to OpenEMR on chart
 *     open with the clinician's sign-in, once; one that grew files again as
 *     an updated copy.
 *   - A text from the patient shows in the patient's own portal thread.
 *
 * Stubbed: the KV store, OpenEMR (stateful, documents kept), the OpenEMR
 * sign-in check, and Quo. Assertions read stored rows back.
 *
 *   node scripts/verify_chart_communications.js
 */
process.env.PORT = process.env.PORT || '4627';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'chart-comms-verification-secret';
process.env.MFA_ENFORCE = 'false';
process.env.DATA_STORE = 'kv';
process.env.AUTO_CHANGELOG = 'false';
process.env.QUO_API_KEY = 'probe-key';
process.env.QUO_WEBHOOK_SECRET = Buffer.from('probe-secret').toString('base64');

const path = require('path');
const crypto = require('crypto');
const Module = require('module');
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

// ---- a stateful fake OpenEMR --------------------------------------------------
const EMR = { seq: 100, encounters: new Map(), soap: new Map(), documents: [] };
const FACILITIES = [{ id: '5', name: 'Private Residence', pos_code: '12', service_location: '1', billing_location: '1', primary_business_entity: '1' }];
const openemr = require(path.join(__dirname, '..', 'openemr.js'));
openemr.isConfigured = () => true;
openemr.forActor = (actor) => new Proxy({}, {
  get(_t, prop) {
    switch (prop) {
      case 'createEncounter': return async (puuid, fields) => { const eid = String(++EMR.seq); const euuid = `enc-${eid}`; EMR.encounters.set(euuid, { puuid, eid, ...fields }); return { euuid, eid }; };
      case 'getEncounterRow': return async (puuid, euuid) => { const e = EMR.encounters.get(euuid); return e ? { eid: e.eid, date: e.date, reason: e.reason, pos_code: e.pos_code || null, facility_id: e.facility_id || null } : null; };
      case 'updateEncounter': return async (puuid, euuid, f) => { Object.assign(EMR.encounters.get(euuid) || {}, f); return {}; };
      case 'addSoapNote': return async (puuid, euuid, note) => { const sid = String(++EMR.seq); EMR.soap.set(sid, { id: sid, euuid, ...note }); return { sid }; };
      case 'updateSoapNote': return async (puuid, euuid, sid, note) => { EMR.soap.set(String(sid), { id: String(sid), euuid, ...note }); return {}; };
      case 'getSoapNote': return async (puuid, euuid, sid) => EMR.soap.get(String(sid)) || null;
      case 'getSoapNotes': return async (puuid, euuid) => [...EMR.soap.values()].filter(n => n.euuid === euuid);
      case 'uploadPatientDocument': return async (puuid, fileName, buffer, mime, category) => { EMR.documents.push({ puuid, fileName, category, head: Buffer.from(buffer).slice(0, 5).toString(), byId: actor && actor.id }); return true; };
      case 'getFacilities': return async () => FACILITIES;
      case 'getEncounters': return async () => { throw new Error('not stubbed'); };
      case 'getAllEncounters': return async () => { throw new Error('not stubbed'); };
      default:
        if (/^get/.test(String(prop))) return async () => [];
        return async () => { throw new Error(`openemr.${String(prop)} not stubbed`); };
    }
  }
});
// Who has a live OpenEMR sign-in.
const EMR_CONNECTED = new Set(['fnp_1', 'fnp_2']);
const emrAuthMod = require(path.join(__dirname, '..', 'emrAuth.js'));
const realCreate = emrAuthMod.createEmrAuth;
emrAuthMod.createEmrAuth = (o) => { const a = realCreate(o); return { ...a, statusFor: async (id) => ({ ...(await a.statusFor(id)), connected: EMR_CONNECTED.has(id) }) }; };
// Quo is never called from a probe.
global.fetch = ((real) => async (url, opts) => String(url).includes('api.openphone.com') ? { ok: true, status: 202, json: async () => ({ data: { id: 'QM-probe' } }) } : real(url, opts))(global.fetch);

const jwt = require('jsonwebtoken');
const config = require(path.join(__dirname, '..', 'config.js'));
const gfcTime = require(path.join(__dirname, '..', 'public', 'gfc-time.js'));
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 500)}` : ''}`); } };
const tok = (u) => {
  const sid = `sess_${u.id}`; const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, revokedReason: null, ipHash: null, userAgent: null, mfaVerified: true, surface: null });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (m, u, t, b) => {
  const r = await fetch(`${BASE}${u}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const sign = (raw) => { const ts = Date.now(); return `hmac;1;${ts};` + crypto.createHmac('sha256', Buffer.from(process.env.QUO_WEBHOOK_SECRET, 'base64')).update(ts + '.' + raw).digest('base64'); };
const hook = async (evt) => { const raw = JSON.stringify(evt); const r = await fetch(`${BASE}/api/webhooks/quo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'openphone-signature': sign(raw) }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const OFFICE = '+14049136705';
const callDone = (id, from, { to = OFFICE, answered = true, mins = 12, direction = 'incoming', endAt = Date.now() - 60 * 1000 } = {}) => {
  const end = endAt;
  const start = end - mins * 60 * 1000;
  return { type: 'call.completed', createdAt: new Date(end).toISOString(), data: { object: {
    id, direction, from: direction === 'incoming' ? from : to, to: direction === 'incoming' ? to : from,
    status: answered ? 'completed' : 'no-answer', createdAt: new Date(start - 5000).toISOString(),
    answeredAt: answered ? new Date(start).toISOString() : null, completedAt: new Date(end).toISOString(), userId: 'US-office' } } };
};
const transcript = (callId) => ({ type: 'call.transcript.completed', data: { object: { callId, dialogue: [
  { identifier: OFFICE, userId: 'US-office', start: 0, content: 'Godwins Family Care, this is Bethel.' },
  { identifier: '+14045550200', start: 5, content: 'Hi, I am calling about my mother\'s blood pressure.' }
] } } });
const summary = (callId) => ({ type: 'call.summary.completed', data: { object: { callId, summary: ['Asked about the new blood pressure medicine', 'Morning readings around *150*'], nextSteps: ['Recheck BP Friday'] } } });

const staff = (id, name, clinicalRole, extra = {}) => ({ id, name, email: `${id}@example.test`, role: 'user', clinicalRole, clinicalRoleConfirmed: true,
  hasClinicalAccess: clinicalRole !== 'readOnly', npi: clinicalRole === 'provider' ? '1234567893' : null, openEmrProviderId: clinicalRole === 'provider' ? '7' : null, accountStatus: 'active', ...extra });
const PATIENT = { id: 'c_cc', role: config.ROLES.CLIENT, email: 'c_cc@example.test', name: 'Juanita Guess', slug: 'cc-probe', serviceLine: 'IHPC',
  enrollmentStatus: 'enrolled', openEmrPatientId: 'uuid-cc', openEmrFacilityId: '5', intake: { phone: '404-555-0100', dob: '1948-03-11' },
  careTeam: { assignedFNPs: ['fnp_1'], assignedCaseManager: 'lmsw_1' } };
const POA = { id: 'poa_cc', role: config.ROLES.FAMILY, email: 'poa_cc@example.test', name: 'Luka Agent', familyOfClientId: PATIENT.id, familyIsPoa: true, phone: '(404) 555-0200' };
const FNP = staff('fnp_1', 'Bethel Godwins', 'provider');
const FNP2 = staff('fnp_2', 'Other Provider', 'provider');
const LMSW = staff('lmsw_1', 'Mara Shaw', 'lmsw', { role: 'caseManager' });

(async () => {
  STORE.set('users', [PATIENT, POA, FNP, FNP2, LMSW]);
  STORE.set('gfc_payer_credentialing', { billing_npi_used: '1234567893', billing_provider_name: 'GFC' });
  // Two conversations about the patient: a Care Update she is on, and a team
  // note she was left off. Yesterday and today, in Georgia.
  const today = gfcTime.zonedParts(new Date()).isoDate;
  const yIso = new Date(Date.parse(`${today}T16:00:00Z`) - 24 * 3600 * 1000).toISOString();
  const tIso = new Date().toISOString();
  STORE.set('message_threads', [
    { id: 't_cu', channel: 'care_update', client_id: PATIENT.id, participant_ids: ['fnp_1', PATIENT.id, POA.id], patient_facing: true, created_at: yIso, last_message_at: tIso, subject: 'BP update' },
    { id: 't_cu2', channel: 'care_update', client_id: PATIENT.id, participant_ids: ['fnp_1', PATIENT.id], patient_facing: true, created_at: tIso, last_message_at: tIso, subject: 'Today' },
    { id: 't_team', channel: 'care_team', client_id: PATIENT.id, participant_ids: ['fnp_1', 'lmsw_1'], audience_chosen: true, patient_facing: false, created_at: yIso, last_message_at: yIso }
  ]);
  STORE.set('messages', [
    { id: 'm1', thread_id: 't_cu', client_id: PATIENT.id, channel: 'care_update', from_user_id: 'fnp_1', from_role: 'clinical', from_role_label: 'Provider', from_name: 'Bethel Godwins', display_name: 'Bethel Godwins', body: 'Your **labs** look good.', body_format: 'markup', attachments: [], sent_at: yIso },
    { id: 'm2', thread_id: 't_cu', client_id: PATIENT.id, channel: 'care_update', from_user_id: POA.id, from_role: 'POA', from_name: 'Luka Agent', display_name: 'Luka Agent as POA for Juanita Guess', body: 'Thank you', body_format: 'plain', attachments: [], sent_at: new Date(Date.parse(yIso) + 600000).toISOString(), via: 'sms' },
    { id: 'm3', thread_id: 't_cu2', client_id: PATIENT.id, channel: 'care_update', from_user_id: 'fnp_1', from_role: 'clinical', from_name: 'Bethel Godwins', display_name: 'Bethel Godwins', body: 'Today too', body_format: 'plain', attachments: [], sent_at: tIso },
    { id: 'm4', thread_id: 't_team', client_id: PATIENT.id, channel: 'care_team', from_user_id: 'fnp_1', from_role: 'clinical', from_name: 'Bethel Godwins', display_name: 'Bethel Godwins', body: 'INTERNAL: check insurance', body_format: 'plain', attachments: [], sent_at: yIso }
  ]);

  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 3000));
  const T = { fnp: tok(FNP), fnp2: tok(FNP2), lmsw: tok(LMSW) };
  const P = `/api/clinical/patients/${PATIENT.id}`;
  const callRow = (quoId) => rows('phone_calls').find(c => c.quo_call_id === quoId);

  console.log('\n── 1. Calls on the office line ──');
  let r = await hook(summary('AC-1'));
  check('a summary that arrives first is kept', r.body.outcome === 'summary_waiting', r.body);
  r = await hook(callDone('AC-1', '+14045550200', { endAt: Date.parse(yIso) }));
  check('an answered call from the POA\'s phone is waiting to be documented', r.body.outcome === 'call_waiting', r.body);
  r = await hook(transcript('AC-1'));
  check('its transcript is added', r.body.outcome === 'transcript_added' && callRow('AC-1').transcript.length === 2, r.body);
  const c1 = callRow('AC-1');
  check('it is the patient\'s, with the POA, 12 minutes, summary merged',
    c1 && c1.client_id === PATIENT.id && c1.with_poa === true && c1.duration_sec === 720 && c1.summary.length === 2 && !c1.pending_summary, c1);
  r = await hook(callDone('AC-1', '+14045550200'));
  check('the same webhook twice is handled once', r.body.outcome === 'duplicate' && rows('phone_calls').filter(c => c.quo_call_id === 'AC-1').length === 1, r.body);
  r = await hook(callDone('AC-2', '+14045550100', { answered: false }));
  check('a missed call makes nothing', r.body.outcome === 'not_answered' && !callRow('AC-2'), r.body);
  r = await hook(callDone('AC-3', '+14045559999'));
  check('a number nobody has is never guessed', r.body.outcome === 'unknown_number' && !callRow('AC-3'), r.body);
  r = await hook(callDone('AC-4', '+14045550100', { to: '+14045551111' }));
  check('a call on another line is ignored', r.body.outcome === 'other_line' && !callRow('AC-4'), r.body);
  r = await hook(callDone('AC-5', '+14045550100', { direction: 'outgoing', mins: 3 }));
  check('an outgoing call to the patient\'s phone waits too', r.body.outcome === 'call_waiting' && callRow('AC-5').direction === 'outgoing' && callRow('AC-5').with_poa === false, r.body);
  r = await hook(transcript('AC-7'));
  check('a transcript that arrives before its call is kept', r.body.outcome === 'transcript_waiting', r.body);
  r = await hook(callDone('AC-7', '+14045550200', { mins: 2 }));
  check('and joins the call when it arrives', r.body.outcome === 'call_waiting' && callRow('AC-7').transcript.length === 2 && !callRow('AC-7').pending_summary, callRow('AC-7'));
  { const all = rows('phone_calls'); STORE.set('phone_calls', all.filter(c => c.quo_call_id !== 'AC-7')); }
  const bad = await fetch(`${BASE}/api/webhooks/quo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'openphone-signature': 'hmac;1;1;x' }, body: JSON.stringify(callDone('AC-6', '+14045550100')) });
  check('an unsigned call webhook is refused', bad.status === 401 && !callRow('AC-6'));

  console.log('\n── 2. The inbox ──');
  r = await call('GET', '/api/clinical/inbox', T.fnp);
  const item = (body, id) => ((body && body.items) || []).find(i => i.kind === 'phone_call' && i.id === id);
  const i1 = item(r.body, c1.id);
  check('the provider sees it as waiting on them', i1 && i1.actionable === true && i1.waitingOn === 'you' && i1.patientName === 'Juanita Guess', i1);
  check('the row says who and how long, not what was said', i1 && /Luka Agent \(POA for Juanita Guess\), 12 min/.test(i1.detail) && !/150/.test(JSON.stringify(i1)), i1);
  r = await call('GET', '/api/clinical/inbox', T.lmsw);
  const iL = item(r.body, c1.id);
  check('an LMSW sees it, waiting on the patient\'s clinician by name', iL && iL.actionable === false && iL.waitingOn === 'Bethel Godwins', iL);

  console.log('\n── 3. Document Call ──');
  r = await call('POST', `/api/clinical/calls/${c1.id}/document`, T.lmsw);
  check('an LMSW cannot open a Phone Call note', r.status === 403, r.body);
  r = await call('POST', `/api/clinical/calls/${c1.id}/document`, T.fnp);
  check('the provider opens it', r.status === 200 && r.body.clientId === PATIENT.id && r.body.tab === 'visit', r.body);
  r = await call('GET', `${P}/visit/draft`, T.fnp);
  const draftNote = r.body && r.body.draft && r.body.draft.note;
  check('their own draft is a Phone Call note', draftNote && draftNote.visit.appointmentType === 'pc_phone_ccm' && draftNote.visit.modality === 'phone' && draftNote.kind === 'followup', draftNote);
  const cn = (draftNote && draftNote.sections && draftNote.sections.callNote) || '';
  check('filled in with who, when, minutes and the labelled summary', /Luka Agent \(POA for Juanita Guess\)/.test(cn) && /12 minutes/.test(cn) && /Summary from the phone system/.test(cn) && /Recheck BP Friday/.test(cn), cn);
  check('Quo\'s text goes in as text, never a format', /\\\*150\\\*/.test(cn), cn);
  const callDay = gfcTime.zonedParts(new Date(Date.parse(yIso))).isoDate;
  check('the encounter date fills in as the day of the call, not today', draftNote && draftNote.visitDate === callDay && callDay !== today, { visitDate: draftNote && draftNote.visitDate, callDay, today });
  r = await call('POST', `/api/clinical/calls/${c1.id}/document`, T.fnp2);
  check('a second clinician cannot take a call already opened', r.status === 409 && r.body.code === 'CALL_STARTED_BY_OTHER' && /Bethel Godwins/.test(r.body.error), r.body);
  r = await call('POST', `/api/clinical/calls/${callRow('AC-5').id}/document`, T.fnp);
  check('the provider cannot open a second call over their unsaved note', r.status === 409 && r.body.code === 'NOTE_DRAFT_EXISTS', r.body);
  r = await call('DELETE', `${P}/visit/draft`, T.fnp);
  check('discarding the draft puts the call back in the queue', r.status === 200 && callRow('AC-1').status === 'waiting' && !callRow('AC-1').started_by_id, callRow('AC-1'));
  r = await call('POST', `/api/clinical/calls/${c1.id}/document`, T.fnp);
  r = await call('GET', `${P}/visit/draft`, T.fnp);
  const note = r.body.draft.note;
  note.sections.callNote += '\nPlan: continue amlodipine.';
  r = await call('POST', `${P}/notes`, T.fnp, { note });
  check('saving the note creates the encounter', r.status === 200 && !!r.body.encounterUuid, r.body);
  const enc = r.body && r.body.encounterUuid;
  check('the call is documented and names the encounter', callRow('AC-1').status === 'documented' && callRow('AC-1').encounter_uuid === enc, callRow('AC-1'));
  const recd = rows('encounter_billing').find(x => x.encounterUuid === enc);
  check('the saved encounter is dated the day of the call', recd && recd.date === callDay && EMR.encounters.get(enc).date === callDay, { record: recd && recd.date, emr: EMR.encounters.get(enc) && EMR.encounters.get(enc).date, callDay });
  r = await call('GET', '/api/clinical/inbox', T.fnp);
  check('it has left the inbox', !item(r.body, c1.id));
  r = await call('POST', `/api/clinical/calls/${c1.id}/document`, T.fnp);
  check('a documented call cannot be opened again', r.status === 409 && r.body.code === 'CALL_ALREADY_HANDLED', r.body);

  console.log('\n── 4. Dismiss ──');
  const c5 = callRow('AC-5');
  r = await call('POST', `/api/clinical/calls/${c5.id}/dismiss`, T.fnp, { reason: '' });
  check('a dismissal needs a reason', r.status === 400 && r.body.code === 'CALL_DISMISS_REASON_REQUIRED' && callRow('AC-5').status === 'waiting', r.body);
  r = await call('POST', `/api/clinical/calls/${c5.id}/dismiss`, T.lmsw, { reason: 'Scheduling' });
  check('an LMSW cannot dismiss one', r.status === 403 && callRow('AC-5').status === 'waiting', r.body);
  r = await call('POST', `/api/clinical/calls/${c5.id}/dismiss`, T.fnp, { reason: 'Scheduling call only' });
  check('the provider dismisses it with a reason', r.status === 200 && callRow('AC-5').status === 'dismissed' && callRow('AC-5').dismissed_reason === 'Scheduling call only');
  check('the audit row names the call, never the reason', !JSON.stringify(rows('activity_log')).includes('Scheduling call only'));

  console.log('\n── 5. Message notes and call notes on the timeline ──');
  r = await call('GET', `${P}/timeline`, T.fnp);
  const mn = ((r.body && r.body.rows) || []).filter(x => x.kind === 'message_note');
  check('one message note per patient-facing conversation', mn.length === 2 && mn.every(x => /^Care Update message note$/.test(x.title)) && mn.some(x => x.id === 'msg:t_cu') && mn.some(x => x.id === 'msg:t_cu2'), mn);
  check('the team note the patient was left off is not a message note', !mn.some(x => /t_team/.test(x.id)));
  check('the timeline carries no message words', !/labs|INTERNAL|Thank you|blood pressure/i.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 300));
  const cRows = ((r.body && r.body.rows) || []).filter(x => x.kind === 'call');
  check('calls show as call notes with their state', cRows.length === 2 && cRows.every(x => /^Call note/.test(x.title)) && cRows.some(x => /Documented/.test(x.detail)) && cRows.some(x => /Dismissed/.test(x.detail)), cRows);
  check('yesterday\'s conversation waits to be filed; today\'s is still open', /Files to OpenEMR/.test((mn.find(x => x.id === 'msg:t_cu') || {}).detail) && /Still open/.test((mn.find(x => x.id === 'msg:t_cu2') || {}).detail), mn);
  r = await call('GET', `${P}/message-notes/${encodeURIComponent('msg:t_cu')}`, T.fnp);
  check('the note\'s words open on request, plain text, with who and how', r.status === 200 && /Your labs look good\./.test(r.body.text) && /Luka Agent as POA for Juanita Guess · by text/.test(r.body.text) && !/\*\*/.test(r.body.text), r.body);
  r = await call('GET', `${P}/message-notes/${encodeURIComponent('msg:t_team')}`, T.fnp);
  check('the team note cannot be opened as a message note', r.status === 404);
  r = await call('GET', `${P}/calls/${c1.id}/note`, T.fnp);
  check('the call note holds the summary and the transcript, with speakers', r.status === 200 && /Asked about the new blood pressure medicine/.test(r.body.text) && /GFC staff: Godwins Family Care, this is Bethel\./.test(r.body.text) && /Luka Agent \(POA for Juanita Guess\): Hi, I am calling/.test(r.body.text), r.body);

  console.log('\n── 6. Filing to OpenEMR on chart open ──');
  await call('GET', `${P}/chart`, T.fnp);
  await new Promise(res => setTimeout(res, 900));
  const msgDocs = () => EMR.documents.filter(d => /^Message_note_/.test(d.fileName));
  const callDocs = () => EMR.documents.filter(d => /^Call_note_/.test(d.fileName));
  check('the closed conversation filed as one PDF, with the clinician\'s sign-in', msgDocs().length === 1 && msgDocs()[0].head === '%PDF-' && msgDocs()[0].byId === 'fnp_1' && msgDocs()[0].puuid === 'uuid-cc' && /through_/.test(msgDocs()[0].fileName), EMR.documents);
  check('the call with a transcript filed as a call note; the one still waiting for a transcript did not', callDocs().length === 1 && new RegExp(callRow('AC-1').id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)).test(callDocs()[0].fileName), EMR.documents);
  check('the filings are recorded with a hash, no words', rows('message_note_filings').length === 2 && rows('message_note_filings').some(f => f.key === 'msg:t_cu') && !/labs|blood pressure/.test(JSON.stringify(rows('message_note_filings'))));
  await call('GET', `${P}/chart`, T.fnp);
  await new Promise(res => setTimeout(res, 900));
  check('opening the chart again files nothing twice', msgDocs().length === 1 && callDocs().length === 1);
  r = await call('GET', `${P}/timeline`, T.fnp);
  check('the timeline now says both are filed', ((r.body && r.body.rows) || []).some(x => x.id === 'msg:t_cu' && /Filed to OpenEMR/.test(x.detail)) && ((r.body && r.body.rows) || []).some(x => x.id === c1.id && /Filed to OpenEMR/.test(x.detail)));
  const msgs = rows('messages');
  msgs.push({ id: 'm5', thread_id: 't_cu', client_id: PATIENT.id, channel: 'care_update', from_user_id: 'fnp_1', from_role: 'clinical', from_name: 'Bethel Godwins', display_name: 'Bethel Godwins', body: 'One more thing', body_format: 'plain', attachments: [], sent_at: new Date(Date.parse(yIso) + 1200000).toISOString() });
  STORE.set('messages', msgs);
  await call('GET', `${P}/chart`, T.fnp);
  await new Promise(res => setTimeout(res, 900));
  check('a conversation that grew files again as an updated copy with every message', msgDocs().length === 2 && /_updated\.pdf$/.test(msgDocs()[1].fileName) && rows('message_note_filings').some(f => f.key === 'msg:t_cu' && f.updated === true && f.count === 3), msgDocs());
  EMR_CONNECTED.delete('fnp_2');
  const before = EMR.documents.length;
  const msgs2 = rows('messages'); msgs2.find(m => m.id === 'm1').body = 'changed again'; STORE.set('messages', msgs2);
  await call('GET', `${P}/chart`, T.fnp2);
  await new Promise(res => setTimeout(res, 900));
  check('a clinician with no OpenEMR sign-in files nothing', EMR.documents.length === before);

  console.log('\n── 7. Texts in the patient\'s portal ──');
  r = await hook({ type: 'message.received', data: { object: { id: 'SM-1', from: '+14045550100', to: ['+13462455658'], direction: 'incoming', body: 'Can someone call me back?', createdAt: new Date().toISOString() } } });
  check('a text from the patient is recorded', r.body.outcome === 'recorded', r.body);
  const pt = tok(PATIENT);
  r = await call('GET', '/api/messaging/threads', pt);
  const ctThread = ((r.body && r.body.threads) || []).find(t => t.channel === 'care_team');
  check('the patient sees the Care Team conversation in their portal', r.status === 200 && !!ctThread, r.body);
  r = ctThread ? await call('GET', `/api/messaging/threads/${ctThread.id}`, pt) : { body: {} };
  const sms = ((r.body && r.body.messages) || []).find(m => m.body === 'Can someone call me back?');
  check('their own text is there, marked as sent by text', !!sms && sms.via === 'sms' && sms.mine === true, r.body);
  r = await call('GET', `${P}/timeline`, T.fnp);
  check('and it becomes part of that conversation\'s message note', ((r.body && r.body.rows) || []).some(x => x.kind === 'message_note' && /^Care Team message note$/.test(x.title)), (r.body && r.body.rows || []).filter(x => x.kind === 'message_note'));

  console.log(`\n${pass}/${pass + fail} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
