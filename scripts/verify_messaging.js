#!/usr/bin/env node
// ============================================================================
// Session 9 acceptance — live HTTP through the REAL messaging router
//
// Run:  node scripts/verify_messaging.js
//
// Same style as verify_caregiver_app.js and verify_scheduling.js: real Express,
// real JWTs, the shipped router. It asserts STORED VALUES read back out of the
// store, never status codes alone — the trap that cost this repo the soap_note
// write, the encounter PUT, documents, allergies and both Phase 6B defects.
//
// The Replit KV store is unreachable from the build sandbox, so the store here
// is an in-memory stand-in with the same get/set contract. Everything above it
// is shipped code. `authenticateToken` is not exported from server.js, so the
// harness reproduces its contract exactly.
// ============================================================================

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const config = require('../config');
const messagingRoutes = require('../routes/messaging');
const msg = require('../messagingRepository');

const JWT_SECRET = config.JWT_SECRET;

const store = new Map();
const db = {
  get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
  set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
};

// ---- Seed — TEST DATA ONLY -------------------------------------------------
const USERS = [
  { id: 'admin-1', name: 'GFC Admin (TEST DATA)', email: 'admin@test.local', role: 'admin' },
  { id: 'fnp-1', name: 'Bethel Godwins (TEST DATA)', email: 'fnp@test.local', role: 'user', hasClinicalAccess: true },
  { id: 'fnp-2', name: 'Other FNP (TEST DATA)', email: 'fnp2@test.local', role: 'user', hasClinicalAccess: true },
  { id: 'cm-1', name: 'Courtney Hale (TEST DATA)', email: 'cm@test.local', role: 'caseManager' },
  { id: 'cg-1', name: 'Cam CNA (TEST DATA)', email: 'cna@test.local', role: 'vendor', licenseLevel: 'cna' },
  { id: 'cg-2', name: 'Pat PCA (TEST DATA)', email: 'pca@test.local', role: 'vendor', licenseLevel: 'pca' },
  { id: 'fam-1', name: 'Ada Vance (TEST DATA)', email: 'fam@test.local', role: 'family', familyOfClientId: 'client-1' },
  { id: 'poa-1', name: 'Ruth Whitfield (TEST DATA)', email: 'poa@test.local', role: 'family', familyOfClientId: 'client-1', familyIsPoa: true },
  { id: 'client-1', name: 'Margaret Whitfield (TEST DATA)', email: 'c1@test.local', role: 'client',
    careTeam: { assignedFNPs: ['fnp-1'], assignedCaseManager: 'cm-1', primaryCaregiver: 'cg-1', backupCaregiver: null } },
  { id: 'client-2', name: 'Harold Vance (TEST DATA)', email: 'c2@test.local', role: 'client', careTeam: {} }
];
store.set('users', USERS);

// Two Session 3.5 rows, so the migration has something real to carry.
store.set('gfc_messages', [
  { id: 'legacy-1', client_id: 'client-1', channel: 'admin', direction: 'out',
    fromName: 'Margaret Whitfield (TEST DATA)', fromRole: 'Client', fromUserId: 'client-1',
    body: 'Can we move Thursday to the afternoon? (TEST DATA)', sentAt: '2026-09-01T14:00:00.000Z', readAt: null },
  { id: 'legacy-2', client_id: 'client-1', channel: 'admin', direction: 'in',
    fromName: 'GFC Admin (TEST DATA)', fromRole: 'Admin', fromUserId: 'admin-1',
    body: 'Yes, 2pm works. (TEST DATA)', sentAt: '2026-09-01T15:30:00.000Z', readAt: '2026-09-01T16:00:00.000Z' }
]);

const getUsers = async () => await db.get('users');
const logActivity = async (userId, userName, action, entityType, entityId, details) => {
  const rows = (await db.get('activity_log')) || [];
  rows.unshift({ id: uuidv4(), userId, userName, action, entityType, entityId, details, timestamp: new Date().toISOString() });
  await db.set('activity_log', rows);
};
const queueNotification = async (type, recipientUserId, recipientEmail, recipientName, templateData, options = {}) => {
  const q = (await db.get('pending_notifications')) || [];
  q.push({ id: uuidv4(), type, recipientUserId, recipientEmail, recipientName, templateData, ...options, status: 'pending' });
  await db.set('pending_notifications', q);
};

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
    familyOfClientId: u.familyOfClientId || null,
    familyIsPoa: u.familyIsPoa || false,
    careTeam: u.careTeam || null
  };
  next();
};

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
const router = messagingRoutes({ db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4 });
app.use(router);

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
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => {
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = text; }
      resolve({ status: res.statusCode, data });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? `  → ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);
const stored = async (key, pred) => ((await db.get(key)) || []).find(pred);
const storedAll = async (key, pred) => ((await db.get(key)) || []).filter(pred || (() => true));

const server = app.listen(0, '127.0.0.1', async () => {
  PORT = server.address().port;
  console.log(`\n${'═'.repeat(66)}\n  Session 9 acceptance — messaging (TEST DATA ONLY)\n${'═'.repeat(66)}`);

  // ==========================================================================
  section('A. The channel matrix, per role');
  // ==========================================================================
  const clientCh = await call('GET', '/api/messaging/channels', { as: 'client-1' });
  check('a client reads their channels', clientCh.status === 200);
  const clientIds = clientCh.data.channels.map(c => c.id).sort();
  check('and they are exactly Direct, Support and Clinical Escalation',
    JSON.stringify(clientIds) === JSON.stringify(['clinical_escalation', 'direct_care', 'support']),
    JSON.stringify(clientIds));

  const cmCh = await call('GET', '/api/messaging/channels', { as: 'cm-1' });
  check('a case manager opens none — behavioral escalations come TO them',
    cmCh.status === 200 && cmCh.data.channels.length === 0);

  const unauth = await call('GET', '/api/messaging/channels');
  check('unauthenticated is 401', unauth.status === 401);

  // ==========================================================================
  section('B. Every channel in the matrix sends and lands');
  // ==========================================================================
  const sends = [
    ['client-1', 'support', null, 'Client → Admin (Support)'],
    ['client-1', 'direct_care', null, 'Client → Caregiver (Direct)'],
    ['client-1', 'clinical_escalation', null, 'Client → Clinical (Clinical Escalation)'],
    ['cg-1', 'operations', 'client-1', 'Caregiver → Admin (Operations)'],
    ['cg-1', 'behavioral_escalation', 'client-1', 'Caregiver → Case Manager (Behavioral Escalation)'],
    ['fnp-1', 'clinical_oversight', 'client-1', 'Clinical → Caregiver (Clinical Oversight)'],
    ['fnp-1', 'care_update', 'client-1', 'Clinical → Family (Care Update)'],
    ['admin-1', 'admin_direct', 'client-1', 'Admin → Anyone (Admin Broadcast or Direct)'],
    ['fam-1', 'family_portal', null, 'Family → Caregiver (Family Portal)'],
    ['fam-1', 'support', null, 'Family → Admin (Support)']
  ];
  const made = {};
  for (const [as, channel, clientId, label] of sends) {
    const r = await call('POST', '/api/messaging/threads', {
      as, body: { channel, clientId: clientId || undefined, body: `${label} (TEST DATA)` }
    });
    check(`${label} sends`, r.status === 200, JSON.stringify(r.data).slice(0, 140));
    if (r.status === 200) made[channel] = made[channel] || r.data.thread.id;
  }
  check('STORED: every channel produced a thread row',
    (await storedAll('message_threads')).length === 10, String((await storedAll('message_threads')).length));
  check('STORED: and the first message of each is on it',
    (await storedAll('messages')).length === 10);

  const supportThread = await stored('message_threads', t => t.channel === 'support' && t.started_by === 'client-1');
  check('STORED: a thread is scoped to ONE client and names its channel',
    supportThread.client_id === 'client-1' && supportThread.channel === 'support');

  // ==========================================================================
  section('C. Both parties see the thread');
  // ==========================================================================
  const clientThreads = await call('GET', '/api/messaging/threads', { as: 'client-1' });
  const adminThreads = await call('GET', '/api/messaging/threads', { as: 'admin-1' });
  check('the client sees the Support thread they started',
    clientThreads.data.threads.some(t => t.id === made.support));
  check('and the admin sees the same thread', adminThreads.data.threads.some(t => t.id === made.support));
  check('admin sees every thread — full visibility is the matrix\'s answer for admin',
    adminThreads.data.threads.length === 10, String(adminThreads.data.threads.length));

  const cgThreads = await call('GET', '/api/messaging/threads', { as: 'cg-1' });
  const cgIds = cgThreads.data.threads.map(t => t.channel).sort();
  check('a caregiver sees only their own four',
    JSON.stringify(cgIds) === JSON.stringify(['admin_direct', 'behavioral_escalation', 'clinical_oversight', 'direct_care', 'family_portal', 'operations'].filter(c => cgIds.includes(c))),
    JSON.stringify(cgIds));
  check('and NOT the clinical escalation between client and clinician',
    !cgThreads.data.threads.some(t => t.id === made.clinical_escalation));

  // ==========================================================================
  section('D. Asking for a thread you are not party to — 403, not an empty list');
  // ==========================================================================
  const denied = await call('GET', `/api/messaging/threads/${made.care_update}`, { as: 'cg-1' });
  check('a caregiver requesting the clinician-to-family thread BY ID is refused',
    denied.status === 403, `${denied.status} ${JSON.stringify(denied.data).slice(0, 120)}`);
  check('and it is a refusal, not "there is nothing here"',
    denied.data.code === 'THREAD_NOT_YOURS' && !('messages' in denied.data));

  const cmClinical = await call('GET', `/api/messaging/threads/${made.clinical_oversight}`, { as: 'cm-1' });
  check('a case manager is refused a clinical thread',
    cmClinical.status === 403 && cmClinical.data.code === 'CASE_MANAGER_SCOPE');
  const cmBehavioral = await call('GET', `/api/messaging/threads/${made.behavioral_escalation}`, { as: 'cm-1' });
  check('and reads the behavioral one they were never named on', cmBehavioral.status === 200);

  const famClinical = await call('GET', `/api/messaging/threads/${made.clinical_escalation}`, { as: 'fam-1' });
  check('non-POA family are refused a clinical thread',
    famClinical.status === 403 && famClinical.data.code === 'FAMILY_SCOPE');
  const famUpdate = await call('GET', `/api/messaging/threads/${made.care_update}`, { as: 'fam-1' });
  check('but read the Care Update a clinician pushed to them', famUpdate.status === 200);

  const otherFnp = await call('GET', `/api/messaging/threads/${made.clinical_oversight}`, { as: 'fnp-2' });
  check('a clinician off the care team is refused',
    otherFnp.status === 403 && otherFnp.data.code === 'CLINICAL_NOT_ASSIGNED');

  const ghost = await call('GET', '/api/messaging/threads/does-not-exist', { as: 'admin-1' });
  check('a thread that does not exist is 404 — a different fact from "not yours"',
    ghost.status === 404 && ghost.data.code === 'THREAD_NOT_FOUND');

  // ==========================================================================
  section('E. A Care Update is an update, not a conversation');
  // ==========================================================================
  const famReply = await call('POST', `/api/messaging/threads/${made.care_update}/messages`, {
    as: 'fam-1', body: { body: 'Thank you (TEST DATA)' }
  });
  check('family cannot reply into a Care Update',
    famReply.status === 403 && famReply.data.code === 'CHANNEL_READ_ONLY');
  check('and are told where to reply instead', /Support/i.test(famReply.data.error || ''), famReply.data.error);
  check('STORED: nothing was written by the refusal',
    (await storedAll('messages', m => m.thread_id === made.care_update)).length === 1);

  // ==========================================================================
  section('F. Client ↔ caregiver turns on and off with the assignment');
  // ==========================================================================
  const c2 = await call('GET', '/api/messaging/channels?clientId=client-2', { as: 'admin-1' });
  check('admin reads channels for a client with no caregiver', c2.status === 200);

  const unassigned = await call('POST', '/api/messaging/threads', {
    as: 'client-2', body: { channel: 'direct_care', body: 'Hello (TEST DATA)' }
  });
  check('a client with no caregiver assigned is REFUSED with the reason named',
    unassigned.status === 403 && unassigned.data.code === 'NO_CAREGIVER_ASSIGNED',
    JSON.stringify(unassigned.data).slice(0, 140));
  check('and the refusal says what happens next',
    /assigns one/i.test(unassigned.data.error || ''), unassigned.data.error);

  // Assign one, and it opens on its own.
  const users2 = await db.get('users');
  users2.find(u => u.id === 'client-2').careTeam = { primaryCaregiver: 'cg-2' };
  await db.set('users', users2);
  const nowOpen = await call('POST', '/api/messaging/threads', {
    as: 'client-2', body: { channel: 'direct_care', body: 'Hello again (TEST DATA)' }
  });
  check('assigning a caregiver enables the channel with no other change', nowOpen.status === 200);
  check('STORED: the caregiver is a participant on the new thread',
    (await stored('message_threads', t => t.id === nowOpen.data.thread.id)).participant_ids.includes('cg-2'));

  // ==========================================================================
  section('G. POA — "as POA for", to every recipient');
  // ==========================================================================
  const poaSend = await call('POST', '/api/messaging/threads', {
    as: 'poa-1', body: { channel: 'support', body: 'Calling on her behalf (TEST DATA)' }
  });
  check('a POA sends on the client\'s behalf', poaSend.status === 200);
  const poaRow = await stored('messages', m => m.thread_id === poaSend.data.thread.id);
  check('STORED: displayed as "<POA> as POA for <client>"',
    poaRow.display_name === 'Ruth Whitfield (TEST DATA) as POA for Margaret Whitfield (TEST DATA)',
    poaRow.display_name);
  check('STORED: the client is never presented as the author',
    poaRow.from_role === 'POA' && poaRow.from_user_id === 'poa-1' && poaRow.acting_for === 'client-1');

  const adminSees = await call('GET', `/api/messaging/threads/${poaSend.data.thread.id}`, { as: 'admin-1' });
  check('and the recipient sees that attribution, not the client\'s name',
    adminSees.data.messages[0].from === poaRow.display_name && adminSees.data.messages[0].isPoa === true);

  const poaClinical = await call('GET', `/api/messaging/threads/${made.clinical_escalation}`, { as: 'poa-1' });
  check('a POA reads what the client reads (the clinical thread)', poaClinical.status === 200);

  // ==========================================================================
  section('H. Escalations');
  // ==========================================================================
  const escRow = await stored('escalation_events', e => e.source === 'message');
  check('a Behavioral Escalation message created an escalation event', !!escRow);
  check('STORED: in SESSION 6\'s store and Session 6\'s shape',
    escRow && escRow.concern_type === 'behavioral' && escRow.status === 'received' &&
    Array.isArray(escRow.notified) && !!escRow.raised_at && !!escRow.received_at);
  check('STORED: it names the case manager it reached',
    escRow.notified.some(n => n.id === 'cm-1' && n.role === 'caseManager'),
    JSON.stringify(escRow.notified));
  check('STORED: and points back at the thread it came from',
    escRow.message_thread_id === made.behavioral_escalation);
  const trail = await storedAll('escalation_status_events', e => e.escalation_id === escRow.id);
  check('STORED: the append-only trail has both raised and received',
    trail.length === 2 && trail.map(t => t.status).join(',') === 'raised,received');

  const clinThread = await call('GET', `/api/messaging/threads/${made.clinical_escalation}`, { as: 'client-1' });
  check('a Clinical Escalation carries a response status from the moment it exists',
    clinThread.data.thread.responseStatus === 'awaiting_response');

  const clientMove = await call('POST', `/api/messaging/threads/${made.clinical_escalation}/response-status`, {
    as: 'client-1', body: { status: 'responded' }
  });
  check('the SENDER cannot mark their own concern responded',
    clientMove.status === 403 && clientMove.data.code === 'RESPONSE_STATUS_DENIED');

  const ack = await call('POST', `/api/messaging/threads/${made.clinical_escalation}/response-status`, {
    as: 'fnp-1', body: { status: 'acknowledged' }
  });
  check('the clinician acknowledges it', ack.status === 200);
  check('STORED: the status moved and was stamped',
    (await stored('message_threads', t => t.id === made.clinical_escalation)).response_status === 'acknowledged');

  const backwards = await call('POST', `/api/messaging/threads/${made.clinical_escalation}/response-status`, {
    as: 'fnp-1', body: { status: 'awaiting_response' }
  });
  check('it never walks backwards', backwards.status === 409 && backwards.data.code === 'INVALID_RESPONSE_TRANSITION');

  const clinReply = await call('POST', `/api/messaging/threads/${made.clinical_escalation}/messages`, {
    as: 'fnp-1', body: { body: 'Increase fluids and call if it persists. (TEST DATA)' }
  });
  check('the clinician replies', clinReply.status === 200);
  check('STORED: replying IS the response — nobody has to remember a second button',
    (await stored('message_threads', t => t.id === made.clinical_escalation)).response_status === 'responded');

  const notEsc = await call('POST', `/api/messaging/threads/${made.support}/response-status`, {
    as: 'admin-1', body: { status: 'acknowledged' }
  });
  check('a plain Support thread is not a tracked escalation',
    notEsc.status === 409 && notEsc.data.code === 'NOT_AN_ESCALATION');

  // ==========================================================================
  section('I. Replies, unread and notifications');
  // ==========================================================================
  const reply = await call('POST', `/api/messaging/threads/${made.support}/messages`, {
    as: 'admin-1', body: { body: 'We have you down for 2pm. (TEST DATA)' }
  });
  check('admin replies into the client\'s Support thread', reply.status === 200);
  check('STORED: the reply is on the thread',
    (await storedAll('messages', m => m.thread_id === made.support)).length === 2);

  const clientList = await call('GET', '/api/messaging/threads', { as: 'client-1' });
  const sup = clientList.data.threads.find(t => t.id === made.support);
  check('the client sees it as unread', sup.unread === 1, String(sup.unread));
  await call('GET', `/api/messaging/threads/${made.support}`, { as: 'client-1' });
  const after = await call('GET', '/api/messaging/threads', { as: 'client-1' });
  check('and reading the thread clears it',
    after.data.threads.find(t => t.id === made.support).unread === 0);

  const notes = await storedAll('pending_notifications', n => n.type === 'message_received');
  check('messages ride the EXISTING notification queue', notes.length > 0);
  check('SAFETY: and the notification carries no message body out of the app',
    !notes.some(n => /2pm|fluids|Thursday/i.test(JSON.stringify(n.templateData))),
    JSON.stringify(notes[0] && notes[0].templateData).slice(0, 160));

  const empty = await call('POST', `/api/messaging/threads/${made.support}/messages`, { as: 'client-1', body: { body: '  ' } });
  check('an empty message is refused', empty.status === 400 && empty.data.code === 'BODY_REQUIRED');

  const bogus = await call('POST', '/api/messaging/threads', { as: 'client-1', body: { channel: 'gossip', body: 'hi' } });
  check('a channel outside the matrix does not exist',
    bogus.status === 400 && bogus.data.code === 'UNKNOWN_CHANNEL');

  // ==========================================================================
  section('J. Migrating Session 3.5');
  // ==========================================================================
  const migrated = await router.migrateInterimMessages();
  check('the interim rows migrate', migrated.migrated === 2, JSON.stringify(migrated));
  const carried = await storedAll('messages', m => m.migrated_from);
  check('STORED: both survive, with their original text',
    carried.length === 2 && carried.some(m => /Thursday/.test(m.body)) && carried.some(m => /2pm works/.test(m.body)));
  check('STORED: into a Support thread for that client',
    (await stored('message_threads', t => t.migrated_from_interim)).client_id === 'client-1');
  check('STORED: the staff reply is attributed to admin, not to the client',
    carried.find(m => /2pm works/.test(m.body)).from_role === 'admin');

  const again = await router.migrateInterimMessages();
  check('running it twice migrates nothing more — it cannot double-file',
    again.migrated === 0 && (await storedAll('messages', m => m.migrated_from)).length === 2);

  const migratedVisible = await call('GET', '/api/messaging/threads', { as: 'client-1' });
  check('and the migrated thread renders in the new UI for the client',
    migratedVisible.data.threads.some(t => t.lastMessagePreview.includes('2pm works')));

  const notAdmin = await call('POST', '/api/messaging/admin/migrate-interim', { as: 'client-1' });
  check('only an admin may run the migration route', notAdmin.status === 403);

  // ==========================================================================
  section('K. Audit trail');
  // ==========================================================================
  for (const action of ['message_thread_started', 'message_sent', 'message_thread_read', 'escalation_raised', 'escalation_response_status']) {
    check(`activity_log carries "${action}"`, !!(await stored('activity_log', r => r.action === action)));
  }
  const poaAudit = await stored('activity_log', r => r.action === 'message_thread_started' && r.details && r.details.actingFor);
  check('AUDIT: a POA action records who it was taken for', poaAudit && poaAudit.details.actingFor === 'client-1');

  // ==========================================================================
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${pass} passed · ${fail} failed  (${pass + fail} assertions)`);
  console.log(`${'═'.repeat(66)}\n`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
});
