#!/usr/bin/env node
// ============================================================================
// Session 7 acceptance — live HTTP through the REAL scheduling router
//
// Run:  node scripts/verify_scheduling.js
//
// Drives routes/scheduling.js over real HTTP, through real Express, with real
// JWTs — the same style as scripts/verify_caregiver_app.js and the 4.x probes.
// It asserts STORED VALUES read back out of the store, never status codes
// alone: this repo has been bitten four times by a write that answered 200 and
// stored nothing (soap_note, the encounter PUT, documents, allergies).
//
// The Replit KV store is unreachable from the build sandbox, so the store here
// is an in-memory stand-in with the same get/set contract. Everything above it
// — the router, the guards, the state machine, the geofence — is shipped code.
// `authenticateToken` is not exported from server.js, so the harness below
// reproduces its contract exactly.
// ============================================================================

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const config = require('../config');
const schedulingRoutes = require('../routes/scheduling');
const sched = require('../schedulingRepository');

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
  { id: 'cm-1', name: 'Courtney Hale (TEST DATA)', email: 'cm@test.local', role: 'caseManager' },
  { id: 'sitter-1', name: 'Sam Sitter (TEST DATA)', email: 'sitter@test.local', role: 'vendor', licenseLevel: 'sitter' },
  { id: 'pca-1', name: 'Pat PCA (TEST DATA)', email: 'pca@test.local', role: 'vendor', licenseLevel: 'pca' },
  { id: 'pca-2', name: 'Robin PCA (TEST DATA)', email: 'pca2@test.local', role: 'vendor', licenseLevel: 'pca' },
  { id: 'cna-1', name: 'Cam CNA (TEST DATA)', email: 'cna@test.local', role: 'vendor', licenseLevel: 'cna' },
  { id: 'vendor-legacy', name: 'Lab Vendor (TEST DATA)', email: 'lab@test.local', role: 'vendor' },
  { id: 'client-1', name: 'Margaret Whitfield (TEST DATA)', email: 'c1@test.local', role: 'client',
    careTier: 'A2',
    address: { line1: '12 Oak St', city: 'Marietta', state: 'GA', zip: '30060', lat: 33.9526, lng: -84.5499 },
    careTeam: { assignedFNPs: ['fnp-1'], assignedCaseManager: 'cm-1', primaryCaregiver: 'pca-1', backupCaregiver: null } },
  { id: 'client-2', name: 'Harold Vance (TEST DATA)', email: 'c2@test.local', role: 'client',
    careTier: 'A1', address: { line1: '9 Pine Rd', city: 'Marietta', state: 'GA' }, careTeam: {} }
];
store.set('users', USERS);

const getUsers = async () => await db.get('users');
const invalidateUsersCache = () => {};
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
    familyOfClientId: u.familyOfClientId || null
  };
  next();
};

const app = express();
app.use(bodyParser.json({ limit: '5mb' }));
app.use(schedulingRoutes({ db, config, logActivity, queueNotification, getUsers, invalidateUsersCache, authenticateToken, uuidv4 }));

// ---- Harness ---------------------------------------------------------------
let PORT = 0;
const tokenFor = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });

const call = (method, path, { as, body, raw } = {}) => new Promise((resolve, reject) => {
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
      if (raw) return resolve({ status: res.statusCode, text, headers: res.headers });
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
const check = (label, condition, detail) => {
  if (condition) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);
const stored = async (collection, predicate) =>
  ((await db.get(collection)) || []).find(predicate) || null;

const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const at = (dayOffset, hhmm) => new Date(`${plusDays(dayOffset)}T${hhmm}:00.000Z`).toISOString();

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  PORT = server.address().port;
  console.log(`\nSession 7 acceptance — PHCP scheduling (TEST DATA ONLY)\nlistening on :${PORT}`);

  // ==========================================================================
  section('A. Availability — the 30-day rule, enforced at the API');
  // ==========================================================================
  const tooSoon = await call('POST', '/api/scheduling/availability', {
    as: 'pca-1',
    body: { effectiveFrom: plusDays(10), windows: [{ day: 'Mon', start: '09:00', end: '17:00' }] }
  });
  check('availability 10 days out is REFUSED by the API, not just the form',
    tooSoon.status === 400 && tooSoon.data.code === 'AVAILABILITY_LEAD_TIME',
    JSON.stringify(tooSoon.data).slice(0, 200));
  check('the refusal says how far out it actually was',
    /10 days out/.test(tooSoon.data.error), tooSoon.data.error);
  check('STORED: nothing was written for the refused submission',
    ((await db.get('caregiver_availability')) || []).length === 0);

  const ok40 = await call('POST', '/api/scheduling/availability', {
    as: 'pca-1',
    body: {
      effectiveFrom: plusDays(40),
      windows: [{ day: 'Mon', start: '09:00', end: '17:00' }, { day: 'Wed', start: '09:00', end: '17:00' }],
      blackoutDates: [plusDays(45)]
    }
  });
  check('availability 40 days out is accepted', ok40.status === 200);
  const availRow = await stored('caregiver_availability', r => r.caregiver_id === 'pca-1');
  check('STORED: the row carries the windows and the blackout date',
    !!availRow && availRow.windows.length === 2 && availRow.blackout_dates.length === 1);
  check('STORED: it is submitted, not silently reviewed', availRow.status === 'submitted');

  const clinicianAvail = await call('POST', '/api/scheduling/availability', {
    as: 'fnp-1', body: { effectiveFrom: plusDays(40), windows: [{ day: 'Fri', start: '08:00', end: '12:00' }] }
  });
  check('a clinician may submit availability too', clinicianAvail.status === 200);

  const legacyVendor = await call('POST', '/api/scheduling/availability', {
    as: 'vendor-legacy', body: { effectiveFrom: plusDays(40), windows: [{ day: 'Mon', start: '09:00', end: '17:00' }] }
  });
  check('a vendor with no license level is refused with a specific code',
    legacyVendor.status === 403 && legacyVendor.data.code === 'CAREGIVER_NO_LICENSE_LEVEL');

  const ownAvail = await call('GET', '/api/scheduling/availability', { as: 'pca-2' });
  check('a caregiver sees only their OWN availability',
    ownAvail.status === 200 && ownAvail.data.availability.length === 0);
  const adminAvail = await call('GET', '/api/scheduling/availability', { as: 'admin-1' });
  check('admin sees everyone\'s', adminAvail.data.availability.length === 2);

  // ==========================================================================
  section('B. Posting shifts + open-pool eligibility');
  // ==========================================================================
  const skilled = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1',
    body: { clientId: 'client-1', start: at(40, '14:00'), end: at(40, '18:00'), requiredLicenseLevel: 'cna', notes: 'TEST DATA' }
  });
  check('admin posts a CNA shift', skilled.status === 200 && skilled.data.shift.status === 'open');
  const skilledId = skilled.data.shift.id;

  const general = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1', body: { clientId: 'client-1', start: at(41, '09:00'), end: at(41, '13:00') }
  });
  const generalId = general.data.shift.id;
  check('and a shift with no level requirement', general.status === 200);

  const notAdmin = await call('POST', '/api/scheduling/shifts', {
    as: 'pca-1', body: { clientId: 'client-1', start: at(42, '09:00'), end: at(42, '13:00') }
  });
  check('a caregiver cannot post a shift (403)', notAdmin.status === 403);

  const inverted = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1', body: { clientId: 'client-1', start: at(42, '18:00'), end: at(42, '09:00') }
  });
  check('an inverted shift is refused with a field error',
    inverted.status === 400 && inverted.data.errors.some(e => e.code === 'END_BEFORE_START'));

  const anyLevel = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1',
    body: { clientId: 'client-1', start: at(43, '10:00'), end: at(43, '14:00'), requiredLicenseLevel: 'any', notes: 'TEST DATA' }
  });
  const anyLevelId = anyLevel.data.shift.id;
  check('admin posts a shift open to ANY license level', anyLevel.status === 200);
  check('STORED: "any" is stored as null, not as a second spelling of no requirement',
    (await stored('shifts', r => r.id === anyLevelId)).required_license_level === null);
  check('and the shift SAYS it is open to everyone rather than staying silent',
    anyLevel.data.shift.openToAllLevels === true &&
    anyLevel.data.shift.levelRequirementLabel === 'Open to all license levels',
    anyLevel.data.shift.levelRequirementLabel);

  const misspelled = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1', body: { clientId: 'client-1', start: at(43, '15:00'), end: at(43, '18:00'), requiredLicenseLevel: 'anyone' }
  });
  check('an unrecognized requirement is refused, and the error names the token that works',
    misspelled.status === 400 &&
    misspelled.data.errors.some(e => e.code === 'LICENSE_LEVEL_INVALID' && /"any"/.test(e.message)),
    JSON.stringify(misspelled.data.errors));

  const pcaPool = await call('GET', '/api/scheduling/shifts/open', { as: 'pca-1' });
  const pcaIds = pcaPool.data.shifts.map(s => s.id);
  check('a PCA does NOT see the CNA shift in the open pool',
    !pcaIds.includes(skilledId), JSON.stringify(pcaIds));
  check('but does see the unrestricted one', pcaIds.includes(generalId));
  check('and the any-level one', pcaIds.includes(anyLevelId));

  const cnaPool = await call('GET', '/api/scheduling/shifts/open', { as: 'cna-1' });
  check('a CNA sees all three', cnaPool.data.shifts.length === 3);

  const sitterPool = await call('GET', '/api/scheduling/shifts/open', { as: 'sitter-1' });
  const sitterIds = sitterPool.data.shifts.map(s => s.id);
  check('a sitter sees the unrestricted and any-level shifts, and not the CNA one',
    sitterIds.length === 2 && sitterIds.includes(generalId) && sitterIds.includes(anyLevelId),
    JSON.stringify(sitterIds));
  check('a PCA and a CNA can BOTH take the any-level shift — the point of the option',
    pcaIds.includes(anyLevelId) && cnaPool.data.shifts.map(s => s.id).includes(anyLevelId));

  // --- Admin posts straight to one caregiver (Pathway B in one step) --------
  const beforeDirect = (await db.get('shifts')).length;
  const wrongLevel = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1',
    body: {
      clientId: 'client-1', start: at(44, '09:00'), end: at(44, '13:00'),
      requiredLicenseLevel: 'cna', assignToCaregiverId: 'pca-1', notes: 'TEST DATA'
    }
  });
  check('posting a CNA shift straight to a PCA is REFUSED',
    wrongLevel.status === 409 && wrongLevel.data.code === 'SHIFT_NOT_ELIGIBLE');
  check('STORED: the refused direct post left NO orphan open shift behind',
    (await db.get('shifts')).length === beforeDirect, `${(await db.get('shifts')).length} vs ${beforeDirect}`);

  const direct = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1',
    body: {
      clientId: 'client-1', start: at(44, '09:00'), end: at(44, '13:00'),
      requiredLicenseLevel: 'cna', assignToCaregiverId: 'cna-1', notes: 'TEST DATA'
    }
  });
  const directId = direct.data.shift.id;
  check('admin posts a shift straight to a named caregiver', direct.status === 200);
  const directRow = await stored('shifts', r => r.id === directId);
  check('STORED: it lands at ASSIGNED, not confirmed — the caregiver still agrees',
    directRow.status === 'assigned' && directRow.caregiver_id === 'cna-1' && !!directRow.assigned_at,
    directRow.status);
  check('and the response says so plainly',
    /accept/i.test(direct.data.message || '') && /open pool/i.test(direct.data.message || ''),
    direct.data.message);
  check('the caregiver is notified of the offer',
    ((await db.get('pending_notifications')) || []).some(n => n.type === 'shift_assigned' && n.relatedEntityId === directId));
  check('a directly posted shift never reaches the open pool',
    !(await call('GET', '/api/scheduling/shifts/open', { as: 'cna-1' })).data.shifts.map(s => s.id).includes(directId));

  const directAccept = await call('POST', `/api/scheduling/shifts/${directId}/accept`, { as: 'cna-1' });
  check('the caregiver accepts it', directAccept.status === 200);
  check('STORED: only now is it confirmed',
    (await stored('shifts', r => r.id === directId)).status === 'confirmed');

  const directToNobody = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1',
    body: { clientId: 'client-1', start: at(45, '09:00'), end: at(45, '13:00'), requiredLicenseLevel: 'any', assignToCaregiverId: 'vendor-legacy' }
  });
  check('posting to a vendor with no license level is refused',
    directToNobody.status === 400 && directToNobody.data.code === 'CAREGIVER_INVALID');

  const claimAbove = await call('POST', `/api/scheduling/shifts/${skilledId}/claim`, { as: 'pca-1' });
  check('a PCA claiming the CNA shift is REFUSED at the API, not just hidden',
    claimAbove.status === 403 && claimAbove.data.code === 'SHIFT_NOT_ELIGIBLE');
  check('and is told why', /below the required/.test(claimAbove.data.reason || ''), claimAbove.data.reason);
  check('STORED: the shift is untouched by the refused claim',
    (await stored('shifts', r => r.id === skilledId)).status === 'open');

  // ==========================================================================
  section('C. Pathway A — a claim does NOT confirm the shift');
  // ==========================================================================
  const claim = await call('POST', `/api/scheduling/shifts/${generalId}/claim`, { as: 'pca-1' });
  check('the caregiver claims it', claim.status === 200);
  const claimed = await stored('shifts', r => r.id === generalId);
  check('STORED: the shift is CLAIMED, not confirmed',
    claimed.status === 'claimed' && !claimed.confirmed_at, `status=${claimed.status}`);
  check('STORED: the claimant and the claim time are recorded',
    claimed.caregiver_id === 'pca-1' && !!claimed.claimed_at);
  check('the caregiver is told it is not yet theirs',
    /administrator approves/i.test(claim.data.message || ''), claim.data.message);
  check('QUEUED: admin was asked to decide',
    ((await db.get('pending_notifications')) || []).some(n => n.type === 'shift_claimed'));

  const clockTooSoon = await call('POST', `/api/scheduling/shifts/${generalId}/clock-in`, { as: 'pca-1', body: {} });
  check('clock-in on a CLAIMED (unconfirmed) shift is refused',
    clockTooSoon.status === 409 && clockTooSoon.data.code === 'SHIFT_NOT_CONFIRMED');

  const approve = await call('POST', `/api/scheduling/shifts/${generalId}/approve`, { as: 'admin-1' });
  check('admin approves it', approve.status === 200);
  const confirmed = await stored('shifts', r => r.id === generalId);
  check('STORED: now confirmed, with a timestamp',
    confirmed.status === 'confirmed' && !!confirmed.confirmed_at);
  const notifs = (await db.get('pending_notifications')) || [];
  check('QUEUED: BOTH parties notified on confirmation',
    notifs.some(n => n.recipientUserId === 'pca-1' && n.type === 'shift_confirmed') &&
    notifs.some(n => n.recipientUserId === 'client-1' && n.type === 'shift_confirmed_client'));

  // Admin declining a claim returns the shift to the pool.
  const claim2 = await call('POST', `/api/scheduling/shifts/${skilledId}/claim`, { as: 'cna-1' });
  check('a CNA claims the skilled shift', claim2.status === 200);
  const declineClaim = await call('POST', `/api/scheduling/shifts/${skilledId}/decline-claim`, {
    as: 'admin-1', body: { reason: 'Covered by the primary caregiver. (TEST DATA)' }
  });
  check('admin declines the claim', declineClaim.status === 200);
  const reopened = await stored('shifts', r => r.id === skilledId);
  check('STORED: the shift is OPEN again and the caregiver is cleared',
    reopened.status === 'open' && reopened.caregiver_id === null);
  check('STORED: but who let it go is kept',
    reopened.released_from_name === 'Cam CNA (TEST DATA)' && /Covered by/.test(reopened.released_reason));

  // ==========================================================================
  section('D. Pathway B — assign, and a decline returns it to the pool');
  // ==========================================================================
  const assignWrongLevel = await call('POST', `/api/scheduling/shifts/${skilledId}/assign`, {
    as: 'admin-1', body: { caregiverId: 'pca-1' }
  });
  check('admin cannot assign a PCA to a CNA shift',
    assignWrongLevel.status === 409 && assignWrongLevel.data.code === 'SHIFT_NOT_ELIGIBLE');

  const assign = await call('POST', `/api/scheduling/shifts/${skilledId}/assign`, {
    as: 'admin-1', body: { caregiverId: 'cna-1' }
  });
  check('admin assigns the CNA directly', assign.status === 200);
  const assigned = await stored('shifts', r => r.id === skilledId);
  check('STORED: assigned, not confirmed — the caregiver still has to answer',
    assigned.status === 'assigned' && !assigned.confirmed_at);

  const notMine = await call('POST', `/api/scheduling/shifts/${skilledId}/accept`, { as: 'pca-1' });
  check('another caregiver cannot accept it (403)',
    notMine.status === 403 && notMine.data.code === 'SHIFT_NOT_YOURS');

  const decline = await call('POST', `/api/scheduling/shifts/${skilledId}/decline`, {
    as: 'cna-1', body: { reason: 'Already booked. (TEST DATA)' }
  });
  check('the caregiver declines', decline.status === 200);
  const backOpen = await stored('shifts', r => r.id === skilledId);
  check('STORED: the shift RETURNED TO THE OPEN POOL',
    backOpen.status === 'open' && backOpen.caregiver_id === null, `status=${backOpen.status}`);
  check('and it is visible in the pool again',
    (await call('GET', '/api/scheduling/shifts/open', { as: 'cna-1' })).data.shifts.some(s => s.id === skilledId));

  const reassign = await call('POST', `/api/scheduling/shifts/${skilledId}/assign`, {
    as: 'admin-1', body: { caregiverId: 'cna-1' }
  });
  const accept = await call('POST', `/api/scheduling/shifts/${skilledId}/accept`, { as: 'cna-1' });
  check('reassigned and accepted → confirmed',
    reassign.status === 200 && accept.status === 200 && accept.data.shift.status === 'confirmed');

  // ==========================================================================
  section('E. Illegal transitions are refused with a specific error');
  // ==========================================================================
  const approveConfirmed = await call('POST', `/api/scheduling/shifts/${generalId}/approve`, { as: 'admin-1' });
  check('approving an already-confirmed shift is refused (409)',
    approveConfirmed.status === 409 && approveConfirmed.data.code === 'SHIFT_NOT_CLAIMED',
    JSON.stringify(approveConfirmed.data));

  const acceptConfirmed = await call('POST', `/api/scheduling/shifts/${generalId}/accept`, { as: 'pca-1' });
  check('accepting a confirmed shift is refused (409)',
    acceptConfirmed.status === 409 && acceptConfirmed.data.code === 'SHIFT_NOT_ASSIGNED');

  const claimConfirmed = await call('POST', `/api/scheduling/shifts/${generalId}/claim`, { as: 'pca-2' });
  check('claiming a confirmed shift is refused, not silently reassigned',
    claimConfirmed.status === 409 && claimConfirmed.data.code === 'INVALID_SHIFT_TRANSITION',
    JSON.stringify(claimConfirmed.data));
  check('STORED: the confirmed shift still belongs to the original caregiver',
    (await stored('shifts', r => r.id === generalId)).caregiver_id === 'pca-1');

  const noReason = await call('POST', `/api/scheduling/shifts/${generalId}/cancel`, { as: 'admin-1', body: {} });
  check('cancelling without a reason is refused',
    noReason.status === 400 && noReason.data.code === 'CANCEL_REASON_REQUIRED');

  // ==========================================================================
  section('F. Time tracking — geofence FLAGS, never blocks');
  // ==========================================================================
  const clockIn = await call('POST', `/api/scheduling/shifts/${generalId}/clock-in`, {
    as: 'pca-1', body: { gps: { lat: 33.9527, lng: -84.5500, accuracy: 12 } }
  });
  check('clock-in on a confirmed shift succeeds', clockIn.status === 200);
  const log = await stored('time_logs', l => l.shift_id === generalId);
  check('STORED: a time log exists with the GPS and the geofence verdict',
    !!log && log.clock_in_geofence.verdict === 'inside' && log.clock_in_gps.lat === 33.9527);
  check('STORED: no flags for an on-site clock-in', log.flags.length === 0, JSON.stringify(log.flags));
  check('STORED: the shift moved to in_progress',
    (await stored('shifts', r => r.id === generalId)).status === 'in_progress');

  const doubleClock = await call('POST', `/api/scheduling/shifts/${generalId}/clock-in`, { as: 'pca-1', body: {} });
  check('a second clock-in is refused', doubleClock.status === 409 && doubleClock.data.code === 'ALREADY_CLOCKED_IN');

  const clockOut = await call('POST', `/api/scheduling/shifts/${generalId}/clock-out`, {
    as: 'pca-1', body: { gps: { lat: 33.9527, lng: -84.5500 } }
  });
  check('clock-out succeeds', clockOut.status === 200);
  const closed = await stored('time_logs', l => l.id === log.id);
  check('STORED: the log is closed and the total is computed',
    !!closed.clock_out_at && typeof closed.total_minutes === 'number' && closed.total_minutes >= 0);
  check('STORED: the shift is completed',
    (await stored('shifts', r => r.id === generalId)).status === 'completed');

  // The one that matters: outside the radius SUCCEEDS and is flagged.
  const farShift = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1', body: { clientId: 'client-1', start: at(0, '09:00'), end: at(0, '13:00') }
  });
  const farId = farShift.data.shift.id;
  await call('POST', `/api/scheduling/shifts/${farId}/assign`, { as: 'admin-1', body: { caregiverId: 'pca-2' } });
  await call('POST', `/api/scheduling/shifts/${farId}/accept`, { as: 'pca-2' });

  const farClock = await call('POST', `/api/scheduling/shifts/${farId}/clock-in`, {
    as: 'pca-2', body: { gps: { lat: 33.9800, lng: -84.5499 } }     // ~3km north
  });
  check('a clock-in 3km away SUCCEEDS — it is never blocked', farClock.status === 200);
  const farLog = await stored('time_logs', l => l.shift_id === farId);
  check('STORED: and it is FLAGGED outside_geofence',
    farLog.flags.includes('outside_geofence'), JSON.stringify(farLog.flags));
  check('STORED: with the measured distance, so admin can judge it',
    farLog.clock_in_geofence.distance > 150 && farLog.clock_in_geofence.radius === 150);
  check('the caregiver is TOLD it was flagged, not left to find out later',
    /flagged for the office/i.test(farClock.data.message || ''), farClock.data.message);

  // A client with no coordinates: unverifiable, never reported as inside.
  const noCoordShift = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1', body: { clientId: 'client-2', start: at(0, '14:00'), end: at(0, '16:00') }
  });
  const ncId = noCoordShift.data.shift.id;
  await call('POST', `/api/scheduling/shifts/${ncId}/assign`, { as: 'admin-1', body: { caregiverId: 'sitter-1' } });
  await call('POST', `/api/scheduling/shifts/${ncId}/accept`, { as: 'sitter-1' });
  await call('POST', `/api/scheduling/shifts/${ncId}/clock-in`, { as: 'sitter-1', body: { gps: { lat: 33.95, lng: -84.55 } } });
  const ncLog = await stored('time_logs', l => l.shift_id === ncId);
  check('STORED: a client with no coordinates reads UNVERIFIABLE, never "inside"',
    ncLog.clock_in_geofence.verdict === 'unverifiable' &&
    ncLog.clock_in_geofence.reason === 'NO_CLIENT_COORDINATES' &&
    ncLog.flags.includes('geofence_unverifiable'), JSON.stringify(ncLog.clock_in_geofence));

  // ==========================================================================
  section('G. Time-log edits — a reason is mandatory, before/after is logged');
  // ==========================================================================
  const noReasonEdit = await call('PUT', `/api/scheduling/time-logs/${log.id}`, {
    as: 'admin-1', body: { clockOutAt: at(41, '13:00') }
  });
  check('an edit with no reason is REFUSED',
    noReasonEdit.status === 400 && noReasonEdit.data.code === 'EDIT_REASON_REQUIRED');
  const untouched = await stored('time_logs', l => l.id === log.id);
  check('STORED: nothing changed on the refused edit',
    untouched.clock_out_at === closed.clock_out_at && untouched.edited === false);

  const beforeOut = closed.clock_out_at;
  const edit = await call('PUT', `/api/scheduling/time-logs/${log.id}`, {
    as: 'admin-1',
    body: { clockOutAt: at(41, '13:00'), reason: 'Caregiver forgot to clock out. (TEST DATA)' }
  });
  check('an edit WITH a reason succeeds', edit.status === 200);
  const edited = await stored('time_logs', l => l.id === log.id);
  check('STORED: the times changed and the row is marked edited',
    edited.clock_out_at !== beforeOut && edited.edited === true && /forgot to clock out/.test(edited.edit_reason));
  check('STORED: the flag records that a human changed it', edited.flags.includes('admin_edited'));

  const activity = (await db.get('activity_log')) || [];
  const editEntry = activity.find(a => a.action === 'time_log_edited');
  check('AUDIT: before AND after are in the activity log',
    !!editEntry && editEntry.details.before.clockOutAt === beforeOut &&
    editEntry.details.after.clockOutAt === edited.clock_out_at,
    JSON.stringify(editEntry && editEntry.details));
  check('AUDIT: with the reason and who made it',
    editEntry.details.reason.includes('forgot') && editEntry.userName.includes('Admin'));
  const editTrail = await stored('time_log_edits', e => e.time_log_id === log.id);
  check('STORED: an append-only edit trail row exists too', !!editTrail && !!editTrail.at);

  const cgEdit = await call('PUT', `/api/scheduling/time-logs/${log.id}`, {
    as: 'pca-1', body: { reason: 'nice try' }
  });
  check('a caregiver cannot edit a time log (403)', cgEdit.status === 403);

  const backwards = await call('PUT', `/api/scheduling/time-logs/${log.id}`, {
    as: 'admin-1', body: { clockInAt: at(41, '14:00'), clockOutAt: at(41, '09:00'), reason: 'x' }
  });
  check('a clock-out before the clock-in is refused',
    backwards.status === 400 && backwards.data.code === 'CLOCK_OUT_BEFORE_IN');

  // ==========================================================================
  section('H. RBAC — a caregiver sees only their own shifts and hours');
  // ==========================================================================
  const pcaShifts = await call('GET', '/api/scheduling/shifts', { as: 'pca-1' });
  check('a caregiver reads ONLY their own shifts',
    pcaShifts.data.shifts.every(s => s.caregiverId === 'pca-1'),
    JSON.stringify(pcaShifts.data.shifts.map(s => s.caregiverId)));
  check('and not the open pool rows belonging to nobody',
    !pcaShifts.data.shifts.some(s => s.caregiverId === null));

  const pcaLogs = await call('GET', '/api/scheduling/time-logs', { as: 'pca-1' });
  check('a caregiver reads ONLY their own time history',
    pcaLogs.data.timeLogs.every(l => l.caregiverId === 'pca-1'));
  check('and cannot widen it with a query parameter',
    (await call('GET', '/api/scheduling/time-logs?caregiverId=pca-2', { as: 'pca-1' }))
      .data.timeLogs.every(l => l.caregiverId === 'pca-1'),
    'the caregiverId filter must be admin-only');

  const adminLogs = await call('GET', '/api/scheduling/time-logs', { as: 'admin-1' });
  check('admin sees every log and a total', adminLogs.data.timeLogs.length >= 3 && adminLogs.data.totalHours !== undefined);

  for (const [role, id] of [['client', 'client-1'], ['case manager', 'cm-1']]) {
    const r = await call('GET', '/api/scheduling/shifts', { as: id });
    check(`/api/scheduling/shifts is 403 for ${role}`, r.status === 403, `got ${r.status}`);
  }
  check('unauthenticated is 401', (await call('GET', '/api/scheduling/shifts')).status === 401);

  // ==========================================================================
  section('I. Client shift requests (Pathway A entry point)');
  // ==========================================================================
  const request = await call('POST', '/api/scheduling/shift-requests', {
    as: 'client-1', body: { date: plusDays(45), start: '09:00', end: '13:00', careNeeds: 'TEST DATA' }
  });
  check('a client requests a shift', request.status === 200);
  const reqRow = await stored('shift_requests', r => r.client_id === 'client-1');
  check('STORED: the request records who asked and for whom',
    !!reqRow && reqRow.requested_by === 'client-1' && reqRow.status === 'requested');

  const strangerRequest = await call('POST', '/api/scheduling/shift-requests', {
    as: 'pca-1', body: { date: plusDays(45), start: '09:00', end: '13:00' }
  });
  check('a caregiver cannot request a shift for a client (403)', strangerRequest.status === 403);

  const posted = await call('POST', '/api/scheduling/shifts', {
    as: 'admin-1',
    body: { clientId: 'client-1', start: at(45, '09:00'), end: at(45, '13:00'), shiftRequestId: reqRow.id }
  });
  check('admin posts a shift answering the request', posted.status === 200);
  const resolved = await stored('shift_requests', r => r.id === reqRow.id);
  check('STORED: the request is marked posted and points at the shift',
    resolved.status === 'posted' && resolved.shift_id === posted.data.shift.id);

  // ==========================================================================
  section('J. Payroll CSV — admin only, real range');
  // ==========================================================================
  const csvDenied = await call('GET', `/api/scheduling/payroll.csv?from=${plusDays(-30)}&to=${plusDays(1)}`, { as: 'pca-1' });
  check('a caregiver cannot export payroll (403)', csvDenied.status === 403);

  const badRange = await call('GET', '/api/scheduling/payroll.csv?from=nope&to=nope', { as: 'admin-1' });
  check('a bad date range is refused', badRange.status === 400 && badRange.data.code === 'DATE_RANGE_REQUIRED');

  const csv = await call('GET', `/api/scheduling/payroll.csv?from=${plusDays(-30)}&to=${plusDays(1)}`, { as: 'admin-1', raw: true });
  check('admin exports the CSV', csv.status === 200);
  check('it is served as a CSV attachment',
    /text\/csv/.test(csv.headers['content-type']) && /attachment/.test(csv.headers['content-disposition'] || ''));
  const lines = csv.text.trim().split('\r\n');
  check('the header is the documented column set', lines[0].startsWith('Caregiver,License Level,Client,Shift Date'), lines[0]);
  check('and it carries the logged rows', lines.length >= 3, `${lines.length} lines`);
  check('the CSV carries no clinical content',
    !/diagnos|care plan|medication/i.test(csv.text));
  check('AUDIT: the export is logged',
    ((await db.get('activity_log')) || []).some(a => a.action === 'payroll_csv_exported'));

  // ==========================================================================
  // ==========================================================================
  section('L. Client locations — the missing half of the geofence');
  // ==========================================================================
  const noCoords = await stored('users', u => u.id === 'client-2');
  check('client-2 starts with no coordinates', !sched.clientCoords(noCoords));

  const rosterBefore = await call('GET', '/api/scheduling/caregivers', { as: 'admin-1' });
  const c2Before = rosterBefore.data.clients.find(c => c.id === 'client-2');
  check('the roster names it as uncheckable, and shows the address so you know which house',
    c2Before.hasCoordinates === false && /Pine Rd/.test(c2Before.addressLine || ''), c2Before.addressLine);

  const nullIsland = await call('PUT', '/api/scheduling/clients/client-2/location', {
    as: 'admin-1', body: { lat: 0, lng: 0 }
  });
  check('0,0 is REFUSED rather than stored as a location',
    nullIsland.status === 400 && nullIsland.data.code === 'COORDINATES_NULL_ISLAND');
  check('STORED: nothing was written by the refusal',
    !sched.clientCoords(await stored('users', u => u.id === 'client-2')));

  const setLoc = await call('PUT', '/api/scheduling/clients/client-2/location', {
    as: 'admin-1', body: { lat: 33.9601, lng: -84.5285, geofenceRadiusMeters: 200 }
  });
  check('admin sets the coordinates', setLoc.status === 200);
  const c2Row = await stored('users', u => u.id === 'client-2');
  check('STORED: on the client record, radius included',
    c2Row.address.lat === 33.9601 && c2Row.address.lng === -84.5285 && c2Row.geofenceRadiusMeters === 200,
    JSON.stringify({ a: c2Row.address, r: c2Row.geofenceRadiusMeters }));
  check('STORED: the rest of the address is untouched',
    c2Row.address.line1 === '9 Pine Rd' && c2Row.address.city === 'Marietta');
  check('and the response says what changes for a clock-in', /200m/.test(setLoc.data.message || ''), setLoc.data.message);

  check('a clock-in there is now CHECKED rather than unverifiable',
    sched.evaluateGeofence(c2Row, { lat: 33.9602, lng: -84.5286 }).verdict === 'inside');
  check('and a clock-in across town is flagged, with the distance measured',
    sched.evaluateGeofence(c2Row, { lat: 33.7490, lng: -84.3880 }).verdict === 'outside');

  const auditRows = (await db.get('activity_log')) || [];
  const locAudit = auditRows.find(r => r.action === 'client_location_set');
  check('AUDIT: the change is logged', !!locAudit);
  check('AUDIT: and the log does NOT carry the coordinates — it is not a second copy of where someone lives',
    !JSON.stringify(locAudit.details).includes('33.9601'), JSON.stringify(locAudit.details));

  const notAdminLoc = await call('PUT', '/api/scheduling/clients/client-2/location', {
    as: 'cna-1', body: { lat: 33.9, lng: -84.5 }
  });
  check('a caregiver cannot move a client (403)', notAdminLoc.status === 403);

  const notAClient = await call('PUT', '/api/scheduling/clients/cna-1/location', {
    as: 'admin-1', body: { lat: 33.9, lng: -84.5 }
  });
  check('and a caregiver id is not a client (404)',
    notAClient.status === 404 && notAClient.data.code === 'CLIENT_NOT_FOUND');

  const keepRadius = await call('PUT', '/api/scheduling/clients/client-2/location', {
    as: 'admin-1', body: { lat: 33.9605, lng: -84.5280 }
  });
  check('omitting the radius KEEPS the one already stored',
    keepRadius.status === 200 && (await stored('users', u => u.id === 'client-2')).geofenceRadiusMeters === 200);

  const cleared = await call('PUT', '/api/scheduling/clients/client-2/location', {
    as: 'admin-1', body: { lat: '', lng: '' }
  });
  check('clearing both boxes removes the coordinates', cleared.status === 200);
  const clearedRow = await stored('users', u => u.id === 'client-2');
  check('STORED: they are gone, and the street address survives',
    !sched.clientCoords(clearedRow) && clearedRow.address.line1 === '9 Pine Rd');
  check('and the caregiver is told what that means',
    /unverifiable/i.test(cleared.data.message || ''), cleared.data.message);

  section('K. Audit trail');
  // ==========================================================================
  const acts = (await db.get('activity_log')) || [];
  for (const action of ['availability_submitted', 'shift_posted', 'shift_claimed', 'shift_confirmed',
    'shift_assigned', 'clock_in', 'clock_out', 'time_log_edited']) {
    check(`activity_log carries "${action}"`, acts.some(a => a.action === action));
  }

  // ==========================================================================
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  ${pass} passed · ${fail} failed  (${pass + fail} assertions)`);
  console.log(`${'═'.repeat(66)}\n`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('\nPROBE CRASHED:', err); process.exit(1); });
