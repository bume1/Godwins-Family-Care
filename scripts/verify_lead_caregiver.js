#!/usr/bin/env node
/**
 * A lead caregiver sees what was shared with the patient (owner, 2026-11-11).
 *
 * A GFC caregiver an admin names as "lead" for a client sees, in the caregiver
 * app, the documents shared to the patient's portal, their medicines and
 * allergies, the patient-facing visit summaries and upcoming appointments.
 * Never the clinician's note, results, diagnoses or tests. Other caregivers,
 * and a lead tick on someone not assigned to the client, see nothing.
 *
 * Real server and routes, in-memory store. Assertions read what is served.
 *   node scripts/verify_lead_caregiver.js
 */
process.env.PORT = process.env.PORT || '4651';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lead-caregiver-secret';
process.env.AUTO_CHANGELOG = 'false';
process.env.MFA_ENFORCE = 'false';

const path = require('path');
const Module = require('module');
const STORE = new Map();
class MemDb {
  async get(k) { return STORE.has(k) ? JSON.parse(JSON.stringify(STORE.get(k))) : null; }
  async set(k, v) { STORE.set(k, JSON.parse(JSON.stringify(v))); return true; }
  async delete(k) { STORE.delete(k); return true; }
  async list(prefix) { return [...STORE.keys()].filter(k => !prefix || k.startsWith(prefix)); }
  async empty() { STORE.clear(); return true; }
}
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@replit/database') return '__memdb__';
  return realResolve.call(this, request, ...rest);
};
require.cache['__memdb__'] = { id: '__memdb__', filename: '__memdb__', loaded: true, exports: MemDb };

const jwt = require('jsonwebtoken');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tok = (u) => {
  const sid = `sess_${u.id}`;
  const at = new Date().toISOString();
  STORE.set(`auth_session:${sid}`, { id: sid, userId: u.id, role: u.role, createdAt: at, lastSeenAt: at, absoluteExpiresAt: null, revokedAt: null, mfaVerified: true });
  return jwt.sign({ id: u.id, email: u.email, name: u.name, role: u.role, sid }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const call = async (method, url, token, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const LEAD = { id: 'cg_lead', role: 'vendor', licenseLevel: 'cna', email: 'lead@x.test', name: 'Lena Lead' };
const BACKUP = { id: 'cg_backup', role: 'vendor', licenseLevel: 'pca', email: 'backup@x.test', name: 'Bo Backup' };
const STRANGER = { id: 'cg_other', role: 'vendor', licenseLevel: 'cna', email: 'other@x.test', name: 'Oz Other' };
const ADMIN = { id: 'adm', role: 'admin', email: 'adm@x.test', name: 'Ad Min' };
const PAT = { id: 'pat', role: 'client', email: 'pat@x.test', name: 'Patrick Bell', slug: 'pat', enrollmentStatus: 'enrolled', openEmrPatientId: 'puuid-1',
  // The stranger's id is on the lead list but they are not assigned: the tick alone grants nothing.
  careTeam: { primaryCaregiver: LEAD.id, backupCaregiver: BACKUP.id, leadCaregivers: [LEAD.id, STRANGER.id] } };

const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

(async () => {
  STORE.set('users', [LEAD, BACKUP, STRANGER, ADMIN, PAT]);
  // Every caregiver has finished their welcome packet, so the app is open to them.
  STORE.set('welcome_packets', [LEAD, BACKUP, STRANGER].map(u => ({ caregiver_id: u.id, status: 'submitted' })));
  STORE.set('patient_published_chart', [{ clientId: PAT.id, publishedAt: '2026-11-01T15:00:00Z',
    medications: [{ id: 'm1', name: 'Lisinopril 10 mg', instructions: 'Once daily', status: 'active' }],
    allergies: [{ id: 'a1', name: 'Penicillin', severity: 'severe' }],
    problems: [{ id: 'p1', name: 'Hypertension' }] }]);
  STORE.set('patient_published_visits', [{ clientId: PAT.id, encounterUuid: 'e1',
    visit: { id: 'e1', date: past, provider: 'Bethel Godwins', reason: 'Follow-up', overview: 'Blood pressure is better.', summary: 'Blood pressure is better.\n\nLab work (CBC) — ordered.',
      followUp: 'Check BP daily.', status: 'complete', newPrescriptions: [{ name: 'Lisinopril' }], testsOrdered: [{ type: 'Lab work', tests: ['CBC'] }], diagnosesAddressed: ['Essential hypertension'] },
    note: { subjective: 'SECRET CLINICAL NOTE' } }]);
  STORE.set('patient_published_appointments', [{ clientId: PAT.id, sourcePuuid: 'puuid-1', publishedAt: '2026-11-01T15:00:00Z',
    appointments: [{ id: 'ap-past', date: past, startTime: '10:00', title: 'Old visit' }, { id: 'ap-next', date: future, startTime: '14:00', title: 'Home visit', provider: 'Bethel Godwins' }] }]);
  STORE.set('client_document_uploads', [
    { id: 'd-shared', clientId: PAT.id, kind: 'other', fileName: 'Discharge instructions.pdf', source: 'staff', sharedWithPatient: true, uploadedAt: '2026-11-02T10:00:00Z', driveFileId: 'f1', mimeType: 'application/pdf' },
    { id: 'd-patient', clientId: PAT.id, kind: 'insuranceCard', fileName: 'card.jpg', source: 'client', uploadedAt: '2026-11-03T10:00:00Z', driveFileId: 'f2', mimeType: 'image/jpeg' },
    { id: 'd-private', clientId: PAT.id, kind: 'other', fileName: 'Office only.pdf', source: 'staff', uploadedAt: '2026-11-04T10:00:00Z', driveFileId: 'f3', mimeType: 'application/pdf' }
  ]);
  require(path.join(__dirname, '..', 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const lt = tok(LEAD), bt = tok(BACKUP), st = tok(STRANGER);

  console.log('\n── Who gets the wider view ──');
  let r = await call('GET', `/api/caregiver/clients/${PAT.id}`, lt);
  check('the lead caregiver is told they have it', r.status === 200 && r.body.leadAccess === true, JSON.stringify(r.body).slice(0, 160));
  r = await call('GET', `/api/caregiver/clients/${PAT.id}`, bt);
  check('the backup caregiver is not', r.status === 200 && r.body.leadAccess === false);
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared`, bt);
  check('and is refused the shared record', r.status === 403 && r.body.code === 'NOT_LEAD_CAREGIVER');
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared`, st);
  check('a lead tick on someone not assigned grants nothing', r.status === 403 && r.body.code === 'CLIENT_NOT_ASSIGNED');

  console.log('\n── What the lead caregiver sees ──');
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared`, lt);
  const b = r.body;
  check('the shared record loads', r.status === 200, JSON.stringify(b).slice(0, 200));
  check('medicines', (b.medications && b.medications.rows || []).some(m => m.name === 'Lisinopril 10 mg' && m.instructions === 'Once daily'));
  check('allergies', (b.allergies && b.allergies.rows || []).some(a => a.name === 'Penicillin'));
  check('the visit summary and follow-up', (b.visits || []).some(v => v.overview === 'Blood pressure is better.' && v.followUp === 'Check BP daily.'));
  const text = JSON.stringify(b);
  check('never the clinician’s note', !/SECRET CLINICAL NOTE/.test(text) && !(b.visits || []).some(v => 'note' in v));
  check('never diagnoses or tests ordered', !/Essential hypertension/.test(text) && !/CBC/.test(text));
  check('never the problem list', !/Hypertension"/.test(text) && !('problems' in b));
  check('upcoming appointments only', (b.appointments || []).length === 1 && b.appointments[0].id === 'ap-next');
  const docIds = (b.documents || []).map(d => d.id).sort();
  check('the documents the patient can see, and not the office’s unshared one', JSON.stringify(docIds) === JSON.stringify(['d-patient', 'd-shared']), JSON.stringify(docIds));
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared/documents/d-private/file`, lt);
  check('the unshared document cannot be opened either', r.status === 404);
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared/documents/d-shared/file`, bt);
  check('the backup caregiver cannot open a shared document', r.status === 403);
  const log = JSON.stringify(STORE.get('activity_log') || []);
  check('every read is logged', log.includes('caregiver_shared_record_read'));

  console.log('\n── The office sets it ──');
  const at = tok(ADMIN);
  r = await call('PUT', `/api/users/${PAT.id}`, at, { careTeam: { primaryCaregiver: LEAD.id, backupCaregiver: BACKUP.id, leadCaregivers: [BACKUP.id] } });
  check('an admin moves the lead tick to the backup', r.status === 200);
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared`, bt);
  check('the backup now sees it', r.status === 200);
  r = await call('GET', `/api/caregiver/clients/${PAT.id}/shared`, lt);
  check('the former lead does not', r.status === 403 && r.body.code === 'NOT_LEAD_CAREGIVER');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
