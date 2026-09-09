#!/usr/bin/env node
// ============================================================================
// Session 6 acceptance — live HTTP through the REAL caregiver router
//
// Run:  node scripts/verify_caregiver_app.js
//
// This drives routes/caregiver.js over real HTTP, through real Express, with
// real JWTs — the same style as scripts/verify_6b_charges.js and the other
// 4.x probes. It asserts STORED VALUES read back out of the store, never
// status codes alone: three of this repo's worst defects (soap_note, the
// encounter PUT, the allergy write) all returned a cheerful 200 and wrote
// nothing, and both Phase 6B failures passed a status-code assertion.
//
// The Replit KV store is not reachable from the build sandbox (same constraint
// Session 4.5 recorded), so the store here is an in-memory stand-in with the
// same get/set contract. Everything above it — the router, the guards, the
// tier gate, the sanitizer, the routing — is the shipped code.
//
// `authenticateToken` lives inside server.js and is not exported, so the
// harness below reproduces its contract exactly: verify the JWT, load the
// FRESH user record, and hand the router the same req.user shape.
// ============================================================================

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const config = require('../config');
const caregiverRoutes = require('../routes/caregiver');
const cg = require('../caregiverRepository');

const JWT_SECRET = config.JWT_SECRET;

// ---- In-memory store with the @replit/database get/set contract ------------
const store = new Map();
const db = {
  get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
  set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
};

// ---- Seed data — TEST DATA ONLY --------------------------------------------
const USERS = [
  { id: 'admin-1', name: 'GFC Admin (TEST DATA)', email: 'admin@test.local', role: 'admin' },
  { id: 'fnp-1', name: 'Bethel Godwins (TEST DATA)', email: 'fnp@test.local', role: 'user', hasClinicalAccess: true },
  { id: 'cm-1', name: 'Courtney Hale (TEST DATA)', email: 'cm@test.local', role: 'caseManager' },
  { id: 'sitter-1', name: 'Sam Sitter (TEST DATA)', email: 'sitter@test.local', role: 'vendor', licenseLevel: 'sitter', assignedClients: ['client-1'] },
  { id: 'pca-1', name: 'Pat PCA (TEST DATA)', email: 'pca@test.local', role: 'vendor', licenseLevel: 'pca', assignedClients: ['client-1'] },
  { id: 'cna-bare', name: 'Chris CNA (TEST DATA)', email: 'cna1@test.local', role: 'vendor', licenseLevel: 'cna', assignedClients: ['client-1'], skilledCompetencies: [] },
  { id: 'cna-vitals', name: 'Cam CNA (TEST DATA)', email: 'cna2@test.local', role: 'vendor', licenseLevel: 'cna', assignedClients: ['client-1'], skilledCompetencies: [{ task: 'vital_signs', verified: true }] },
  { id: 'lpn-1', name: 'Joelle LPN (TEST DATA)', email: 'lpn@test.local', role: 'vendor', licenseLevel: 'lpn', assignedClients: ['client-1'], skilledCompetencies: [{ task: 'wound_care', verified: true }] },
  { id: 'cg-other', name: 'Other Caregiver (TEST DATA)', email: 'other@test.local', role: 'vendor', licenseLevel: 'pca', assignedClients: ['client-2'] },
  { id: 'client-1', name: 'Margaret Whitfield (TEST DATA)', email: 'c1@test.local', role: 'client', careTier: 'A2',
    careTeam: { assignedFNPs: ['fnp-1'], assignedCaseManager: 'cm-1', primaryCaregiver: 'pca-1', backupCaregiver: null },
    carePlan: { version: 1, frequency: '3x/week', goals: ['Remain safe at home'], tasks: [], chargeNote: '$38/hr' },
    rateAgreement: { hourly: 38 } },
  { id: 'client-2', name: 'Harold Vance (TEST DATA)', email: 'c2@test.local', role: 'client', careTier: 'A1', careTeam: {} },
  { id: 'client-orphan', name: 'Nora Orphan (TEST DATA)', email: 'c3@test.local', role: 'client', careTier: 'B',
    careTeam: { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: 'pca-1' } }
];
store.set('users', USERS);

const getUsers = async () => await db.get('users');
const logActivity = async (userId, userName, action, entityType, entityId, details) => {
  const rows = (await db.get('activity_log')) || [];
  rows.unshift({ id: uuidv4(), userId, userName, action, entityType, entityId, details, timestamp: new Date().toISOString() });
  await db.set('activity_log', rows);
};
const queueNotification = async (type, recipientUserId, recipientEmail, recipientName, templateData, options = {}) => {
  const q = (await db.get('pending_notifications')) || [];
  const row = { id: uuidv4(), type, recipientUserId, recipientEmail, recipientName, templateData, ...options, status: 'pending' };
  q.push(row);
  await db.set('pending_notifications', q);
  return row;
};

// Mirrors server.js authenticateToken (not exported from there).
const authenticateToken = async (req, res, next) => {
  const token = (req.headers['authorization'] || '').split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access denied', code: 'AUTH_MISSING' });
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(403).json({ error: 'Invalid token', code: 'AUTH_INVALID' }); }
  const users = await getUsers();
  const u = users.find(x => x.id === decoded.id);
  if (!u) return res.status(403).json({ error: 'User not found', code: 'AUTH_INVALID' });
  req.user = {
    id: u.id, email: u.email, name: u.name, role: u.role,
    hasClinicalAccess: u.hasClinicalAccess || false,
    licenseLevel: u.licenseLevel || null,
    assignedClients: u.assignedClients || [],
    careTeam: u.careTeam || null,
    isManager: u.isManager || false
  };
  next();
};

// ---- App -------------------------------------------------------------------
const app = express();
app.use(bodyParser.json({ limit: '5mb' }));
app.use(caregiverRoutes({ db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4 }));

// ---- Harness ---------------------------------------------------------------
let PORT = 0;
const tokenFor = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });

const call = (method, path, { as, body } = {}) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request({
    host: '127.0.0.1', port: PORT, path, method,
    headers: {
      'Content-Type': 'application/json',
      ...(as ? { Authorization: `Bearer ${tokenFor(as)}` } : {}),
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
    }
  }, (res) => {
    let raw = '';
    res.on('data', c => { raw += c; });
    res.on('end', () => {
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { data = raw; }
      resolve({ status: res.statusCode, data });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

let pass = 0, fail = 0;
const check = (label, condition, detail) => {
  if (condition) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);

// Read a row back OUT OF THE STORE. Every assertion about a write goes
// through this, never through the response body alone.
const stored = async (collection, predicate) =>
  ((await db.get(collection)) || []).find(predicate) || null;

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;
  console.log(`\nSession 6 acceptance — caregiver app (TEST DATA ONLY)\nlistening on :${PORT}`);

  // ==========================================================================
  section('A. Tier branching — the correct variant per license level');
  // ==========================================================================
  const levels = {};
  for (const [id, level] of [['sitter-1', 'sitter'], ['pca-1', 'pca'], ['cna-vitals', 'cna'], ['lpn-1', 'lpn']]) {
    const r = await call('GET', '/api/caregiver/me', { as: id });
    levels[level] = r.data && r.data.schema;
    check(`${level}: GET /me returns the ${level} schema`,
      r.status === 200 && r.data.licenseLevel === level, JSON.stringify(r.data).slice(0, 200));
  }
  const idsOf = (s) => (s.taskGroups || []).reduce((a, g) => a.concat(g.items.map(i => i.id)), []);

  check('sitter: presence + companionship, no ADLs',
    idsOf(levels.sitter).includes('presence_confirmed') && !idsOf(levels.sitter).includes('bath'));
  check('pca: full ADL set, medication REMINDER only',
    idsOf(levels.pca).includes('bath') && idsOf(levels.pca).includes('med_remind') && !idsOf(levels.pca).includes('med_administer'));
  check('cna (vital_signs verified): vitals offered',
    idsOf(levels.cna).includes('vitals') && levels.cna.measurements.some(m => m.id === 'bloodPressure'));
  check('lpn: skilled block + Pending Review status',
    idsOf(levels.lpn).includes('wound') && levels.lpn.submitStatus === 'pending_review');

  const cnaBare = (await call('GET', '/api/caregiver/me', { as: 'cna-bare' })).data.schema;
  check('cna WITHOUT the competency does not receive the field',
    !idsOf(cnaBare).includes('vitals') && cnaBare.measurements.length === 0);

  // ==========================================================================
  section('B. Sanitization — skilled fields are ABSENT from a PCA payload');
  // ==========================================================================
  const attack = await call('POST', '/api/caregiver/visit-logs', {
    as: 'pca-1',
    body: {
      idempotencyKey: 'probe-pca-1', clientId: 'client-1', visitType: 'Personal care',
      tasks: { bath: { done: true }, wound: { done: true }, med_administer: { done: true }, vitals: { done: true } },
      measurements: { bloodPressure: '120/80' },
      narratives: { additionalNotes: 'TEST DATA', clinicalObservations: 'should never land' }
    }
  });
  check('PCA submit returns 200', attack.status === 200, JSON.stringify(attack.data).slice(0, 200));

  const pcaRow = await stored('caregiver_visit_logs', r => r.idempotency_key === 'pca-1:probe-pca-1');
  check('STORED: the row exists in caregiver_visit_logs', !!pcaRow);
  check('STORED: the in-scope task landed', !!(pcaRow && pcaRow.tasks.bath));
  check('STORED: "wound" is ABSENT, not false',
    !!pcaRow && !Object.prototype.hasOwnProperty.call(pcaRow.tasks, 'wound'),
    pcaRow && JSON.stringify(pcaRow.tasks));
  check('STORED: "med_administer" is ABSENT',
    !!pcaRow && !Object.prototype.hasOwnProperty.call(pcaRow.tasks, 'med_administer'));
  check('STORED: measurements are empty for a PCA',
    !!pcaRow && Object.keys(pcaRow.measurements).length === 0, pcaRow && JSON.stringify(pcaRow.measurements));
  check('STORED: the LPN clinical narrative is ABSENT',
    !!pcaRow && !Object.prototype.hasOwnProperty.call(pcaRow.narratives, 'clinicalObservations'));
  check('STORED: the in-scope narrative survived',
    !!pcaRow && pcaRow.narratives.additionalNotes === 'TEST DATA');
  check('STORED: status is submitted (not pending review) for a PCA',
    !!pcaRow && pcaRow.status === 'submitted');

  // ==========================================================================
  section('C. Idempotency — a retry does not file the visit twice');
  // ==========================================================================
  const replay = await call('POST', '/api/caregiver/visit-logs', {
    as: 'pca-1',
    body: { idempotencyKey: 'probe-pca-1', clientId: 'client-1', visitType: 'Personal care', tasks: { bath: { done: true } } }
  });
  check('replay returns 200 with duplicate:true', replay.status === 200 && replay.data.duplicate === true);
  check('replay returns the ORIGINAL row id', replay.data.visitLog && replay.data.visitLog.id === pcaRow.id);
  const afterReplay = ((await db.get('caregiver_visit_logs')) || []).filter(r => r.idempotency_key === 'pca-1:probe-pca-1');
  check('STORED: still exactly ONE row after the retry', afterReplay.length === 1, `found ${afterReplay.length}`);

  const noKey = await call('POST', '/api/caregiver/visit-logs', { as: 'pca-1', body: { clientId: 'client-1' } });
  check('a submission with no key is refused 400 IDEMPOTENCY_KEY_REQUIRED',
    noKey.status === 400 && noKey.data.code === 'IDEMPOTENCY_KEY_REQUIRED');

  // Two caregivers using the same client-generated key must not collide.
  await call('POST', '/api/caregiver/visit-logs', {
    as: 'cna-vitals', body: { idempotencyKey: 'probe-pca-1', clientId: 'client-1', tasks: { bath: { done: true } } }
  });
  const collide = ((await db.get('caregiver_visit_logs')) || []).filter(r => String(r.idempotency_key).endsWith(':probe-pca-1'));
  check('STORED: the same key from another caregiver files its own row', collide.length === 2, `found ${collide.length}`);

  // ==========================================================================
  section('D. Immutability + the clinician review note appends');
  // ==========================================================================
  const putAttempt = await call('PUT', `/api/caregiver/visit-logs/${pcaRow.id}`, { as: 'pca-1', body: { visitType: 'edited' } });
  check('there is no update route for a submitted log (404)', putAttempt.status === 404);

  const review = await call('POST', `/api/caregiver/visit-logs/${pcaRow.id}/review-note`, {
    as: 'fnp-1', body: { note: 'Reviewed — no concerns. (TEST DATA)' }
  });
  check('clinician appends a review note', review.status === 200 && !!review.data.review);
  const reviewRow = await stored('caregiver_visit_log_reviews', r => r.visit_log_id === pcaRow.id);
  check('STORED: the review note is its own row with its own author + timestamp',
    !!reviewRow && reviewRow.by_name.includes('Bethel') && !!reviewRow.at);
  const afterReview = await stored('caregiver_visit_logs', r => r.id === pcaRow.id);
  check('STORED: the documented content is untouched by the review',
    JSON.stringify(afterReview.tasks) === JSON.stringify(pcaRow.tasks) &&
    JSON.stringify(afterReview.narratives) === JSON.stringify(pcaRow.narratives));

  const cgReview = await call('POST', `/api/caregiver/visit-logs/${pcaRow.id}/review-note`, { as: 'pca-1', body: { note: 'x' } });
  check('a caregiver cannot write a review note (403)', cgReview.status === 403);

  // ==========================================================================
  section('E. LPN skilled note routes to the review inbox');
  // ==========================================================================
  const lpn = await call('POST', '/api/caregiver/visit-logs', {
    as: 'lpn-1',
    body: {
      idempotencyKey: 'probe-lpn-1', clientId: 'client-1', visitType: 'Skilled visit',
      tasks: { wound: { done: true, note: 'Clean, dry, redressed. (TEST DATA)' } },
      narratives: { clinicalObservations: 'Wound bed pink. (TEST DATA)', responseToTreatment: 'Tolerated well.' }
    }
  });
  const lpnRow = await stored('caregiver_visit_logs', r => r.idempotency_key === 'lpn-1:probe-lpn-1');
  check('LPN submit succeeds', lpn.status === 200);
  check('STORED: status is pending_review', !!lpnRow && lpnRow.status === 'pending_review');
  check('STORED: the skilled task landed with its detail note',
    !!lpnRow && lpnRow.tasks.wound && lpnRow.tasks.wound.note.includes('redressed'));
  check('STORED: the clinical narrative landed', !!lpnRow && !!lpnRow.narratives.clinicalObservations);

  const inbox = await call('GET', '/api/caregiver/visit-logs?status=pending_review', { as: 'fnp-1' });
  check('the clinician inbox lists it',
    inbox.status === 200 && inbox.data.visitLogs.some(v => v.id === lpnRow.id));

  await call('POST', `/api/caregiver/visit-logs/${lpnRow.id}/review-note`, { as: 'fnp-1', body: { note: 'Agree. (TEST DATA)' } });
  const lpnAfter = await stored('caregiver_visit_logs', r => r.id === lpnRow.id);
  check('STORED: reviewing moves the STATE only, pending_review → reviewed',
    lpnAfter.status === 'reviewed' && JSON.stringify(lpnAfter.tasks) === JSON.stringify(lpnRow.tasks));

  // A caregiver never sees another caregiver's notes.
  const otherView = await call('GET', '/api/caregiver/visit-logs', { as: 'pca-1' });
  check('a caregiver reads only their OWN logs',
    otherView.data.visitLogs.every(v => v.caregiverId === 'pca-1'));

  // ==========================================================================
  section('F. Escalation — routing, refusal, confirmation');
  // ==========================================================================
  const clinical = await call('POST', '/api/caregiver/escalations', {
    as: 'pca-1', body: { clientId: 'client-1', concernType: 'clinical', description: 'TEST DATA' }
  });
  check('clinical concern accepted', clinical.status === 200);
  const clinRow = await stored('escalation_events', r => r.id === clinical.data.escalation.id);
  check('STORED: clinical notified the assigned FNP and NOBODY else',
    !!clinRow && clinRow.notified.length === 1 && clinRow.notified[0].id === 'fnp-1',
    clinRow && JSON.stringify(clinRow.notified));
  check('STORED: admin has visibility but was not paged',
    clinRow.visibility.includes('admin-1') && !clinRow.notified.some(n => n.id === 'admin-1'));
  check('the confirmation NAMES the human', /Sent to Bethel Godwins/.test(clinical.data.confirmation),
    clinical.data.confirmation);
  const clinNotifs = ((await db.get('pending_notifications')) || []).filter(n => n.relatedEntityId === clinRow.id);
  check('QUEUED: one notification on the existing queue, to the FNP',
    clinNotifs.length === 1 && clinNotifs[0].recipientUserId === 'fnp-1');

  const behavioral = await call('POST', '/api/caregiver/escalations', {
    as: 'pca-1', body: { clientId: 'client-1', concernType: 'behavioral' }
  });
  const behRow = await stored('escalation_events', r => r.id === behavioral.data.escalation.id);
  check('STORED: behavioral notified the case manager only',
    behRow.notified.length === 1 && behRow.notified[0].id === 'cm-1');

  const noDesc = await call('POST', '/api/caregiver/escalations', {
    as: 'pca-1', body: { clientId: 'client-1', concernType: 'safety_urgent' }
  });
  check('safety-urgent is REFUSED without a description (400)',
    noDesc.status === 400 && noDesc.data.code === 'DESCRIPTION_REQUIRED');
  check('STORED: nothing was written for the refused urgent concern',
    ((await db.get('escalation_events')) || []).every(r => r.concern_type !== 'safety_urgent'));

  const urgent = await call('POST', '/api/caregiver/escalations', {
    as: 'pca-1', body: { clientId: 'client-1', concernType: 'safety_urgent', description: 'Client on the floor. (TEST DATA)' }
  });
  const urgRow = await stored('escalation_events', r => r.id === urgent.data.escalation.id);
  check('STORED: safety-urgent notified FNP + case manager + admin',
    urgRow.notified.map(n => n.id).sort().join(',') === 'admin-1,cm-1,fnp-1',
    JSON.stringify(urgRow.notified.map(n => n.id)));
  check('STORED: severity urgent and SMS added', urgRow.severity === 'urgent' && urgRow.channels.includes('sms'));
  check('the confirmation names all three',
    /Bethel/.test(urgent.data.confirmation) && /Courtney/.test(urgent.data.confirmation) && /Admin/.test(urgent.data.confirmation),
    urgent.data.confirmation);

  const orphan = await call('POST', '/api/caregiver/escalations', {
    as: 'pca-1', body: { clientId: 'client-orphan', concernType: 'clinical', description: 'TEST DATA' }
  });
  check('an unroutable concern falls back to admin AND says so',
    orphan.status === 200 && /No clinician is assigned/.test(orphan.data.confirmation), orphan.data.confirmation);

  // ==========================================================================
  section('G. Escalation lifecycle — four states, timestamped, forward only');
  // ==========================================================================
  const eid = clinical.data.escalation.id;
  check('raised → received happens automatically', clinRow.status === 'received' && !!clinRow.received_at);

  const skip = await call('POST', `/api/caregiver/escalations/${eid}/status`, { as: 'fnp-1', body: { status: 'resolved', note: 'x' } });
  check('received → resolved is refused (409): acknowledge first',
    skip.status === 409 && skip.data.code === 'INVALID_STATUS_TRANSITION');

  const ack = await call('POST', `/api/caregiver/escalations/${eid}/status`, { as: 'fnp-1', body: { status: 'acknowledged' } });
  check('recipient acknowledges', ack.status === 200 && ack.data.escalation.status === 'acknowledged');

  const noNote = await call('POST', `/api/caregiver/escalations/${eid}/status`, { as: 'fnp-1', body: { status: 'action_taken' } });
  check('action_taken is refused without a note (400)', noNote.status === 400 && noNote.data.code === 'STATUS_NOTE_REQUIRED');

  await call('POST', `/api/caregiver/escalations/${eid}/status`, { as: 'fnp-1', body: { status: 'action_taken', note: 'Visited. (TEST DATA)' } });
  await call('POST', `/api/caregiver/escalations/${eid}/status`, { as: 'fnp-1', body: { status: 'resolved', note: 'Stable. (TEST DATA)' } });

  const finalRow = await stored('escalation_events', r => r.id === eid);
  check('STORED: all four timestamps are set and distinct fields',
    !!finalRow.raised_at && !!finalRow.received_at && !!finalRow.acknowledged_at && !!finalRow.action_taken_at && !!finalRow.resolved_at);

  const trail = ((await db.get('escalation_status_events')) || []).filter(t => t.escalation_id === eid);
  check('STORED: the trail is append-only — one row per transition, five in all',
    trail.length === 5, `found ${trail.length}: ${trail.map(t => t.status).join(' → ')}`);
  check('STORED: every trail row carries who and when',
    trail.every(t => !!t.at && !!t.by_name));

  const backwards = await call('POST', `/api/caregiver/escalations/${eid}/status`, { as: 'fnp-1', body: { status: 'acknowledged' } });
  check('a resolved concern cannot be walked backwards (409)', backwards.status === 409);

  const stranger = await call('POST', `/api/caregiver/escalations/${behRow.id}/status`, { as: 'cg-other', body: { status: 'acknowledged' } });
  check('a caregiver cannot advance an escalation status (403)', stranger.status === 403);

  const caregiverSees = await call('GET', '/api/caregiver/escalations', { as: 'pca-1' });
  const seen = caregiverSees.data.escalations.find(e => e.id === eid);
  check('the caregiver WATCHES the status move', !!seen && seen.status === 'resolved');
  check('and sees the whole trail', !!seen && seen.trail.length === 5);

  // ==========================================================================
  section('H. Incidents — a separate record, not a checkbox');
  // ==========================================================================
  const withFall = await call('POST', '/api/caregiver/visit-logs', {
    as: 'pca-1',
    body: {
      idempotencyKey: 'probe-fall', clientId: 'client-1', visitType: 'Personal care',
      safetyConcerns: ['falls', 'weight_loss'],
      narratives: { safetyConcernDetails: 'Slipped in the bathroom. (TEST DATA)' },
      flagConcernType: 'safety_urgent', flagDescription: 'Fall with no injury. (TEST DATA)'
    }
  });
  check('a flagged visit log submits', withFall.status === 200);
  const fallLog = await stored('caregiver_visit_logs', r => r.idempotency_key === 'pca-1:probe-fall');
  const incident = await stored('incident_reports', r => r.visit_log_id === fallLog.id && r.kind === 'falls');
  check('STORED: an incident report exists as its OWN row', !!incident && incident.status === 'open');
  check('STORED: the incident carries the detail', !!incident && incident.detail.includes('bathroom'));
  const weightIncident = await stored('incident_reports', r => r.visit_log_id === fallLog.id && r.kind === 'weight_loss');
  check('STORED: a non-incident concern does NOT spawn a report', !weightIncident);
  check('STORED: the safety concern is still on the log too', fallLog.safety_concerns.includes('falls'));

  const flagged = await stored('escalation_events', r => r.visit_log_id === fallLog.id);
  check('STORED: the in-log flag raised the same kind of escalation',
    !!flagged && flagged.concern_type === 'safety_urgent' && flagged.notified.length === 3);
  check('the response names who was notified for the in-log flag',
    !!withFall.data.escalation && /Bethel/.test(withFall.data.escalation.confirmation));

  const incidentList = await call('GET', '/api/caregiver/incidents', { as: 'pca-1' });
  check('a caregiver cannot read the incident queue (403)', incidentList.status === 403);
  check('staff can', (await call('GET', '/api/caregiver/incidents', { as: 'admin-1' })).status === 200);

  // ==========================================================================
  section('I. RBAC — assignment, role, and what a caregiver may see');
  // ==========================================================================
  const crossRead = await call('GET', '/api/caregiver/clients/client-2', { as: 'pca-1' });
  check('a caregiver cannot read a client they are not assigned to (403)',
    crossRead.status === 403 && crossRead.data.code === 'CLIENT_NOT_ASSIGNED');

  const crossWrite = await call('POST', '/api/caregiver/visit-logs', {
    as: 'pca-1', body: { idempotencyKey: 'probe-cross', clientId: 'client-2', tasks: { bath: { done: true } } }
  });
  check('a caregiver cannot FILE against an unassigned client (403)', crossWrite.status === 403);
  check('STORED: nothing was written for the refused cross-client submit',
    !(await stored('caregiver_visit_logs', r => r.client_id === 'client-2')));

  const ownRead = await call('GET', '/api/caregiver/clients/client-1', { as: 'pca-1' });
  check('a caregiver reads their assigned client', ownRead.status === 200);
  const flat = JSON.stringify(ownRead.data.client);
  check('the client view carries NO rate or charge value', !/38/.test(flat) && !/chargeNote/.test(flat), flat.slice(0, 240));
  check('the client view carries the care plan the caregiver needs',
    ownRead.data.client.carePlan && ownRead.data.client.carePlan.frequency === '3x/week');

  for (const [role, id] of [['client', 'client-1'], ['clinical', 'fnp-1'], ['case manager', 'cm-1'], ['admin', 'admin-1']]) {
    const r = await call('GET', '/api/caregiver/me', { as: id });
    check(`/api/caregiver/me is 403 for ${role}`, r.status === 403, `got ${r.status}`);
  }
  const anon = await call('GET', '/api/caregiver/me');
  check('/api/caregiver/me is 401 unauthenticated', anon.status === 401);

  const broadcast = await call('POST', '/api/caregiver/broadcasts', { as: 'pca-1', body: { title: 'x' } });
  check('a caregiver cannot post a broadcast (403)', broadcast.status === 403);

  // ==========================================================================
  section('J. Submission loop — the family feed row is written');
  // ==========================================================================
  const displayRow = ((await db.get('visit_logs')) || []).find(v => v.id === fallLog.id);
  check('STORED: a display row landed in visit_logs for the client/family feed',
    !!displayRow && displayRow.client_id === 'client-1' && displayRow.status === 'completed');
  check('STORED: the display row names the caregiver, not the log body',
    !!displayRow && displayRow.caregiverName.includes('Pat PCA') && !('tasks' in displayRow));

  // ==========================================================================
  section('K. Audit trail — every action is logged');
  // ==========================================================================
  const activity = (await db.get('activity_log')) || [];
  for (const action of ['caregiver_visit_log_submitted', 'caregiver_visit_log_reviewed',
    'escalation_raised', 'escalation_status_changed', 'caregiver_client_read']) {
    check(`activity_log carries "${action}"`, activity.some(a => a.action === action));
  }

  // ==========================================================================
  section('L. Admin records competencies, and the form changes');
  // ==========================================================================
  const before = (await call('GET', '/api/caregiver/me', { as: 'cna-bare' })).data.schema;
  check('before: no measurement fields', before.measurements.length === 0);
  const set = await call('PUT', '/api/caregiver/admin/caregivers/cna-bare/competencies', {
    as: 'admin-1', body: { skilledCompetencies: [{ task: 'vital_signs', verified: true }] }
  });
  check('admin sets a verified competency', set.status === 200);
  const after = (await call('GET', '/api/caregiver/me', { as: 'cna-bare' })).data.schema;
  check('after: the vitals fields appear', after.measurements.some(m => m.id === 'bloodPressure'));

  const unverified = await call('PUT', '/api/caregiver/admin/caregivers/cna-bare/competencies', {
    as: 'admin-1', body: { skilledCompetencies: [{ task: 'vital_signs', verified: false }] }
  });
  const afterUnverified = (await call('GET', '/api/caregiver/me', { as: 'cna-bare' })).data.schema;
  check('an UNVERIFIED competency takes the field away again — fails safe',
    unverified.status === 200 && afterUnverified.measurements.length === 0);

  const bogus = await call('PUT', '/api/caregiver/admin/caregivers/cna-bare/competencies', {
    as: 'admin-1', body: { skilledCompetencies: [{ task: 'telekinesis', verified: true }] }
  });
  check('an unknown competency is refused (400)', bogus.status === 400 && bogus.data.code === 'UNKNOWN_COMPETENCY');

  const notAdmin = await call('PUT', '/api/caregiver/admin/caregivers/cna-bare/competencies', {
    as: 'fnp-1', body: { skilledCompetencies: [] }
  });
  check('only an admin may set competencies (403)', notAdmin.status === 403);

  // ==========================================================================
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${pass} passed · ${fail} failed  (${pass + fail} assertions)`);
  console.log(`${'═'.repeat(66)}\n`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('\nPROBE CRASHED:', err); process.exit(1); });
