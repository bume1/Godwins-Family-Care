'use strict';
// Private home care access (owner, 2026-11-03). Managers and care coordinators
// run private home care day to day; the Super Admin keeps the money files,
// approves time and pay changes, and manages staff and clinical accounts.
//
// The scheduling routes and the caregiver routes are mounted and called over
// HTTP. The user routes live in server.js, which cannot be required without
// booting a server, so their ceiling is tested as the pure predicate every
// route calls, plus build guards that every user-writing route calls it.
// scripts/verify_phc_access.js drives the whole thing through the real server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const accountTypes = require('../accountTypes');
const userFinancial = require('../userFinancialFields');
const sched = require('../schedulingRepository');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Stored exactly as accountTypes.fieldsFor stores each type.
const ADMIN = { id: 'adm', email: 'a@g.test', name: 'Bianca Admin', role: 'admin', accountType: 'admin' };
const MANAGER = { id: 'mgr', email: 'm@g.test', name: 'Mary Manager', role: 'user', isManager: true, clinicalRole: 'readOnly', accountType: 'manager' };
const COORD = { id: 'crd', email: 'c@g.test', name: 'Cora Coordinator', role: 'user', isManager: true, clinicalRole: 'coordinator', accountType: 'coordinator' };
const LMSW = { id: 'lms', email: 'l@g.test', name: 'Courtney LMSW', role: 'caseManager', clinicalRole: 'lmsw', accountType: 'lmsw', hasClinicalAccess: true };
const CG = { id: 'cg1', email: 'g@g.test', name: 'Danielle Carter', role: 'vendor', licenseLevel: 'cna', accountType: 'caregiver', payRate: 18 };
const CLIENT = { id: 'cl1', email: 'cl@g.test', name: 'Juanita Guess', role: 'client', accountType: 'client', enrollmentStatus: 'enrolled' };
const PROVIDER = { id: 'fnp', email: 'f@g.test', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', accountType: 'provider', hasClinicalAccess: true };

// ---------------------------------------------------------------------------
// The scheduling router, mounted for real
// ---------------------------------------------------------------------------
function schedHarness(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const db = {
    get: async k => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const users = [ADMIN, MANAGER, COORD, LMSW, CG, CLIENT];
  const activity = [];
  const notices = [];
  const app = express();
  app.use(express.json());
  app.use(require('../routes/scheduling')({
    db, config,
    logActivity: async (...a) => { activity.push(a); },
    queueNotification: async (...a) => { notices.push(a); return { id: 'n' }; },
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    // What the real authenticateToken carries (server.js), accountType included.
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === req.headers['x-as']);
      if (!u) return res.status(401).json({ error: 'no' });
      req.user = { id: u.id, email: u.email, name: u.name, role: u.role, isManager: !!u.isManager,
        accountType: accountTypes.accountTypeOf(u), clinicalRole: u.clinicalRole || null,
        hasClinicalAccess: !!u.hasClinicalAccess, licenseLevel: u.licenseLevel || null,
        assignedClients: [], careTeam: null, familyOfClientId: null };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  }));
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (method, url, body, as) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { 'x-as': as, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, body: json, text };
  };
  return { db, call, activity, notices, close: () => server.close() };
}

// A finished visit on 2026-10-20, 9:00–13:00 Eastern (13:00–17:00Z).
const LOG = {
  id: 'tl1', shift_id: null, client_id: 'cl1', client_name: 'Juanita Guess',
  caregiver_id: 'cg1', caregiver_name: 'Danielle Carter', license_level: 'cna',
  scheduled_start: null, scheduled_end: null,
  clock_in_at: '2026-10-20T13:00:00.000Z', clock_out_at: '2026-10-20T17:00:00.000Z',
  clock_in_geofence: { verdict: 'inside' }, total_minutes: 240, flags: [], edited: false
};
const RANGE = 'from=2026-10-01&to=2026-10-31';

test('A1: a manager and a coordinator record availability for a caregiver; an LMSW no longer does', async () => {
  const h = schedHarness({ caregiver_availability: [] });
  try {
    const d = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
    const body = { caregiverId: 'cg1', effectiveFrom: d, windows: [{ day: 'Mon', start: '09:00', end: '13:00' }] };
    for (const who of ['mgr', 'crd', 'adm']) {
      const r = await h.call('POST', '/api/scheduling/availability', body, who);
      assert.strictEqual(r.status, 200, `${who}: ${r.text}`);
      assert.strictEqual(r.body.availability.caregiverId, 'cg1', 'the row stays the caregiver\'s');
      assert.strictEqual(r.body.availability.enteredOnBehalf, true);
    }
    const lmsw = await h.call('POST', '/api/scheduling/availability', body, 'lms');
    assert.strictEqual(lmsw.status, 403);
    assert.strictEqual(lmsw.body.code, 'AVAILABILITY_RECORDER_ONLY');
  } finally { h.close(); }
});

test('A2: a manager and a coordinator set a client location', async () => {
  const h = schedHarness();
  try {
    for (const who of ['mgr', 'crd']) {
      const r = await h.call('PUT', '/api/scheduling/clients/cl1/location', { lat: 33.75, lng: -84.39 }, who);
      assert.strictEqual(r.status, 200, `${who}: ${r.text}`);
    }
    const cg = await h.call('PUT', '/api/scheduling/clients/cl1/location', { lat: 33.75, lng: -84.39 }, 'cg1');
    assert.strictEqual(cg.status, 403);
  } finally { h.close(); }
});

test('A3: a manager and a coordinator read payroll and billing; both are refused the CSV files', async () => {
  const h = schedHarness({ time_logs: [LOG] });
  try {
    for (const who of ['mgr', 'crd']) {
      const p = await h.call('GET', `/api/scheduling/payroll?${RANGE}`, null, who);
      assert.strictEqual(p.status, 200, p.text);
      assert.strictEqual(p.body.rows.length, 1);
      assert.strictEqual(p.body.rows[0].caregiverName, 'Danielle Carter');
      assert.strictEqual(p.body.rows[0].payRate, '18.00', 'pay rates are shown (assumed decision 5)');
      assert.strictEqual(p.body.canExport, false);
      const b = await h.call('GET', `/api/scheduling/billing?${RANGE}`, null, who);
      assert.strictEqual(b.status, 200);
      assert.strictEqual(b.body.rows.length, 1);
      for (const csv of ['payroll.csv', 'billing.csv']) {
        const r = await h.call('GET', `/api/scheduling/${csv}?${RANGE}`, null, who);
        assert.strictEqual(r.status, 403, `${who} must not download ${csv}`);
      }
    }
    const admin = await h.call('GET', `/api/scheduling/payroll?${RANGE}`, null, 'adm');
    assert.strictEqual(admin.body.canExport, true);
    // Every view is audited.
    assert.ok(h.activity.some(a => a[2] === 'payroll_viewed'));
    assert.ok(h.activity.some(a => a[2] === 'billing_viewed'));
    // A caregiver and an LMSW see neither.
    for (const who of ['cg1', 'lms']) {
      assert.strictEqual((await h.call('GET', `/api/scheduling/payroll?${RANGE}`, null, who)).status, 403);
    }
  } finally { h.close(); }
});

test('A4: manual hours and direct time edits stay with the Super Admin', async () => {
  const h = schedHarness({ time_logs: [LOG] });
  try {
    for (const who of ['mgr', 'crd']) {
      const put = await h.call('PUT', '/api/scheduling/time-logs/tl1', { clockOutAt: '2026-10-20T18:00:00Z', reason: 'x' }, who);
      assert.strictEqual(put.status, 403);
      const post = await h.call('POST', '/api/scheduling/time-logs', { caregiverId: 'cg1', clientId: 'cl1', clockInAt: LOG.clock_in_at, reason: 'x' }, who);
      assert.strictEqual(post.status, 403);
    }
  } finally { h.close(); }
});

test('B+C: a manager asks, the admin approves, the log keeps both times and both exports say adjusted', async () => {
  const h = schedHarness({ time_logs: [LOG] });
  try {
    // A reason is required.
    let r = await h.call('POST', '/api/scheduling/time-logs/tl1/adjustment-requests', { clockOutAt: '2026-10-20T18:00:00Z' }, 'mgr');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'ADJUSTMENT_REASON_REQUIRED');

    r = await h.call('POST', '/api/scheduling/time-logs/tl1/adjustment-requests',
      { clockOutAt: '2026-10-20T18:00:00Z', reason: 'Phone died; stayed until 2pm per the client' }, 'mgr');
    assert.strictEqual(r.status, 200, r.text);
    const reqId = r.body.request.id;
    assert.strictEqual(r.body.request.requestedByRole, 'manager');
    // Nothing changed yet.
    assert.strictEqual((await h.db.get('time_logs'))[0].clock_out_at, LOG.clock_out_at);
    // The Super Admin was told.
    assert.ok(h.notices.some(n => n[0] === 'time_adjustment_requested' && n[1] === 'adm'));

    // One pending request per log, naming the open one.
    const dup = await h.call('POST', '/api/scheduling/time-logs/tl1/adjustment-requests',
      { clockOutAt: '2026-10-20T19:00:00Z', reason: 'again' }, 'crd');
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.body.code, 'ADJUSTMENT_ALREADY_PENDING');
    assert.strictEqual(dup.body.request.id, reqId);

    // Managers see the queue but cannot decide.
    const q = await h.call('GET', '/api/scheduling/adjustment-requests', null, 'crd');
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.body.pendingCount, 1);
    assert.strictEqual(q.body.canDecide, false);
    const self = await h.call('POST', `/api/scheduling/adjustment-requests/${reqId}/decide`, { decision: 'approved' }, 'mgr');
    assert.strictEqual(self.status, 403);

    const ok = await h.call('POST', `/api/scheduling/adjustment-requests/${reqId}/decide`, { decision: 'approved', note: 'ok' }, 'adm');
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.request.status, 'approved');

    // B3: the stored log has the new time AND the original.
    const log = (await h.db.get('time_logs'))[0];
    assert.strictEqual(log.clock_out_at, '2026-10-20T18:00:00.000Z');
    assert.strictEqual(log.total_minutes, 300);
    assert.strictEqual(log.adjusted, true);
    assert.strictEqual(log.original_clock_in, LOG.clock_in_at);
    assert.strictEqual(log.original_clock_out, LOG.clock_out_at);
    assert.strictEqual(log.original_total_minutes, 240);
    assert.strictEqual(log.adjustment_request_id, reqId);
    assert.strictEqual(log.adjusted_by_id, 'mgr', 'the requester');
    assert.strictEqual(log.approved_by_id, 'adm', 'the admin');
    assert.ok(log.adjusted_at);
    assert.match(log.adjustment_reason, /Phone died/);
    assert.strictEqual(log.caregiver_id, 'cg1', 'the caregiver is still the subject');
    // The edit trail records it as an adjustment, through the one writer.
    const edits = await h.db.get('time_log_edits');
    assert.strictEqual(edits.length, 1);
    assert.strictEqual(edits[0].kind, 'adjustment_request');
    // The requester was told.
    assert.ok(h.notices.some(n => n[0] === 'time_adjustment_decided' && n[1] === 'mgr'));

    // C: both exports carry it, with the caregiver unchanged and adjusted early.
    for (const [file, cols] of [['payroll.csv', sched.PAYROLL_CSV_COLUMNS], ['billing.csv', sched.BILLING_CSV_COLUMNS]]) {
      const csv = await h.call('GET', `/api/scheduling/${file}?${RANGE}`, null, 'adm');
      assert.strictEqual(csv.status, 200);
      const [header, row] = csv.text.trim().split(/\r?\n/);
      const heads = header.split(',');
      const cells = row.split(',');
      const at = (name) => cells[heads.indexOf(name)];
      assert.strictEqual(at('Adjusted'), 'yes', file);
      assert.strictEqual(at('Original Hours'), String(sched.minutesToHours(240)), file);
      assert.strictEqual(at(file === 'payroll.csv' ? 'Hours' : 'Billable Hours'), String(sched.minutesToHours(300)), file);
      assert.strictEqual(at('Caregiver'), 'Danielle Carter', `${file}: never re-attributed to the manager or admin`);
      assert.strictEqual(at('Adjusted By'), 'Mary Manager');
      assert.strictEqual(at('Approved By'), 'Bianca Admin');
      const firstTime = heads.findIndex(x => x === 'Clock In' || x === 'Actual In');
      assert.ok(heads.indexOf('Adjusted') < firstTime, `${file}: Adjusted comes before the times`);
      assert.ok(heads.indexOf('Adjusted') <= 4, `${file}: Adjusted sits in the first five columns`);
      assert.strictEqual(cols.find(c => c.key === 'adjusted').header, 'Adjusted');
    }
    // And the on-screen view.
    const view = await h.call('GET', `/api/scheduling/payroll?${RANGE}`, null, 'crd');
    assert.strictEqual(view.body.rows[0].adjusted, 'yes');
    assert.strictEqual(view.body.rows[0].caregiverName, 'Danielle Carter');

    // Already decided.
    const again = await h.call('POST', `/api/scheduling/adjustment-requests/${reqId}/decide`, { decision: 'declined' }, 'adm');
    assert.strictEqual(again.status, 409);
  } finally { h.close(); }
});

test('B: a declined request changes nothing; a stale one is refused', async () => {
  const h = schedHarness({ time_logs: [LOG] });
  try {
    let r = await h.call('POST', '/api/scheduling/time-logs/tl1/adjustment-requests',
      { clockInAt: '2026-10-20T12:30:00Z', reason: 'arrived early' }, 'crd');
    const id = r.body.request.id;
    r = await h.call('POST', `/api/scheduling/adjustment-requests/${id}/decide`, { decision: 'declined', note: 'GPS says 9:00' }, 'adm');
    assert.strictEqual(r.status, 200);
    const log = (await h.db.get('time_logs'))[0];
    assert.strictEqual(log.clock_in_at, LOG.clock_in_at);
    assert.ok(!log.adjusted);
    assert.strictEqual((await h.db.get('time_log_edits')) || null, null, 'nothing written to the edit trail');

    // Stale: the admin corrects it directly, then a request raised before that is approved.
    r = await h.call('POST', '/api/scheduling/time-logs/tl1/adjustment-requests',
      { clockOutAt: '2026-10-20T18:00:00Z', reason: 'stayed late' }, 'mgr');
    const id2 = r.body.request.id;
    await h.call('PUT', '/api/scheduling/time-logs/tl1', { clockOutAt: '2026-10-20T17:30:00Z', reason: 'fix' }, 'adm');
    r = await h.call('POST', `/api/scheduling/adjustment-requests/${id2}/decide`, { decision: 'approved' }, 'adm');
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'ADJUSTMENT_STALE');
  } finally { h.close(); }
});

test('B: one writer for a time log\'s times', () => {
  const src = read('routes/scheduling.js');
  const put = src.slice(src.indexOf("router.put('/api/scheduling/time-logs/:id'"), src.indexOf('// ---- TIME ADJUSTMENT REQUESTS'));
  assert.match(put, /applyTimeLogEdit\(/, 'the admin edit goes through the writer');
  assert.ok(!/db\.set\('time_logs'/.test(put), 'and does not write time itself');
  const decide = src.slice(src.indexOf("router.post('/api/scheduling/adjustment-requests/:id/decide'"));
  const block = decide.slice(0, decide.indexOf('\n  });\n'));
  assert.match(block, /applyTimeLogEdit\(/, 'approval goes through the same writer');
  assert.ok(!/db\.set\('time_logs'/.test(block), 'and does not write time itself');
});

// ---------------------------------------------------------------------------
// D: caregiver management, the caregiver router mounted for real
// ---------------------------------------------------------------------------
async function cgHarness(t, as) {
  const store = {
    caregiver_documents: [{ id: 'd1', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter', kind: 'timesheet',
      file_name: 'wk.pdf', drive_file_id: 'drv', mime_type: 'application/pdf', status: 'received', uploaded_at: '2026-10-01T00:00:00Z' }]
  };
  const db = { get: async k => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const activity = [];
  const users = [ADMIN, MANAGER, COORD, LMSW, CG, PROVIDER];
  const router = require('../routes/caregiver')({
    db, config,
    logActivity: async (...a) => { activity.push(a); },
    queueNotification: async () => {},
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => {
      const u = users.find(x => x.id === as);
      req.user = { ...u, accountType: accountTypes.accountTypeOf(u) };
      next();
    },
    uuidv4: () => 'x',
    drive: { downloadFileBuffer: async () => Buffer.from('%PDF-1.4'), deleteFile: async () => {} },
    detectFileType: () => 'application/pdf'
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
    });
    let j = null; const txt = await r.text(); try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, body: j };
  };
  return { store, activity, call };
}

for (const who of ['mgr', 'crd']) {
  test(`D: a ${who === 'mgr' ? 'manager' : 'coordinator'} reads and approves a caregiver document; deletion is refused`, async (t) => {
    const h = await cgHarness(t, who);
    const kinds = await h.call('GET', '/api/caregiver/documents/kinds');
    assert.strictEqual(kinds.status, 200);
    const list = await h.call('GET', '/api/caregiver/documents');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.documents.length, 1, 'reads every caregiver\'s documents');
    assert.ok(h.activity.some(a => a[2] === 'caregiver_document_read' && a[5].route === 'GET /api/caregiver/documents'),
      'listing is audited too');
    const file = await h.call('GET', '/api/caregiver/documents/d1/file');
    assert.strictEqual(file.status, 200);
    const read = h.activity.find(a => a[2] === 'caregiver_document_read' && a[4] === 'd1');
    assert.ok(read, 'the read is audited');
    assert.strictEqual(read[5].owner, 'cg1');
    assert.strictEqual(read[5].role, who === 'mgr' ? 'manager' : 'coordinator');
    assert.match(read[5].route, /documents\/:id\/file/);
    const rev = await h.call('POST', '/api/caregiver/documents/d1/review', { decision: 'accepted' });
    assert.strictEqual(rev.status, 200);
    assert.strictEqual(h.store.caregiver_documents[0].status, 'accepted');
    const del = await h.call('DELETE', '/api/caregiver/documents/d1');
    assert.strictEqual(del.status, 403, 'deletion stays with the Super Admin');
    assert.strictEqual(h.store.caregiver_documents.length, 1);
    assert.strictEqual((await h.call('GET', '/api/caregiver/admin/competencies')).status, 200);
    const comp = await h.call('PUT', '/api/caregiver/admin/caregivers/cg1/competencies', { skilledCompetencies: [] });
    assert.strictEqual(comp.status, 200);
    const onProvider = await h.call('PUT', '/api/caregiver/admin/caregivers/fnp/competencies', { skilledCompetencies: [] });
    assert.strictEqual(onProvider.status, 403, 'competencies only on caregiver accounts');
    const post = await h.call('POST', '/api/caregiver/broadcasts', { title: 'Holiday schedule' });
    assert.strictEqual(post.status, 200);
  });
}

test('D: a caregiver still reads only their own documents; an LMSW is not the caregiver office', async (t) => {
  const cg = await cgHarness(t, 'cg1');
  assert.strictEqual((await cg.call('POST', '/api/caregiver/documents/d1/review', { decision: 'accepted' })).status, 403);
  const lmsw = await cgHarness(t, 'lms');
  assert.strictEqual((await lmsw.call('GET', '/api/caregiver/documents')).status, 403);
  assert.strictEqual((await lmsw.call('POST', '/api/caregiver/broadcasts', { title: 'x' })).status, 403);
});

test('D: the Super Admin keeps document deletion', async (t) => {
  const h = await cgHarness(t, 'adm');
  assert.strictEqual((await h.call('DELETE', '/api/caregiver/documents/d1')).status, 200);
});

// ---------------------------------------------------------------------------
// E: who may create and edit which accounts
// ---------------------------------------------------------------------------
const W = (actor, existing, body) => accountTypes.checkUserWrite(actor, { existing, body });

test('E1: a manager and a coordinator may create a caregiver, client or family account', () => {
  for (const actor of [MANAGER, COORD]) {
    for (const t of ['caregiver', 'client', 'family']) {
      assert.strictEqual(W(actor, null, { accountType: t, name: 'X' }).ok, true, `${actor.accountType} → ${t}`);
    }
    assert.strictEqual(W(actor, null, { role: 'vendor', name: 'X' }).ok, true, 'by legacy role too');
  }
});

test('E2: a manager is refused an admin, manager, coordinator or clinician, with a 403 that names the reason', () => {
  for (const t of ['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw']) {
    const v = W(MANAGER, null, { accountType: t, name: 'X' });
    assert.strictEqual(v.ok, false, t);
    assert.strictEqual(v.status, 403);
    assert.match(v.error, /Super Admin manages staff and clinical accounts/, 'the reason, not a bare forbidden');
  }
  for (const role of ['admin', 'user', 'caseManager']) {
    assert.strictEqual(W(COORD, null, { role, name: 'X' }).ok, false, `role ${role}`);
  }
});

test('E2: no access field slips in beside an allowed type', () => {
  for (const [f, v] of [['isManager', true], ['clinicalRole', 'provider'], ['hasClinicalAccess', true], ['managerClinicalAccess', 'edit'],
    ['npi', '1234567890'], ['deaNumber', 'AB1234563'], ['prescriberCredential', 'NP']]) {
    const r = W(MANAGER, null, { accountType: 'caregiver', name: 'X', [f]: v });
    assert.strictEqual(r.ok, false, f);
    assert.strictEqual(r.status, 403);
  }
  // A form that always sends these blank is fine, and the blanks are dropped
  // so they cannot clear anything.
  const r = W(MANAGER, CG, { name: 'Danielle C', isManager: false, clinicalRole: '', npi: '', hasClinicalAccess: false });
  assert.strictEqual(r.ok, true);
  for (const f of ['isManager', 'clinicalRole', 'npi', 'hasClinicalAccess']) assert.ok(!(f in r.body), `${f} dropped`);
  assert.strictEqual(r.body.name, 'Danielle C');
});

test('E2: editing an existing clinician, manager or admin is refused; changing a caregiver into one is refused', () => {
  for (const target of [PROVIDER, LMSW, ADMIN, COORD]) {
    const r = W(MANAGER, target, { name: 'New name' });
    assert.strictEqual(r.ok, false, target.accountType);
    assert.strictEqual(r.code, 'USER_TYPE_NOT_MANAGEABLE');
  }
  assert.strictEqual(W(MANAGER, CG, { accountType: 'rn' }).ok, false);
  assert.strictEqual(W(MANAGER, CG, { accountType: 'client' }).ok, true, 'within E1 is fine');
});

test('E2: a manager attempting to change their own account type is refused', () => {
  const r = W(MANAGER, MANAGER, { accountType: 'admin' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.code, 'USER_SELF_EDIT_FORBIDDEN');
  assert.strictEqual(W(COORD, COORD, { accountStatus: 'active' }).code, 'USER_SELF_EDIT_FORBIDDEN');
});

test('E: fails closed for anybody else, and a create with no type is refused', () => {
  for (const actor of [LMSW, PROVIDER, CG, CLIENT, {}, null]) {
    assert.strictEqual(W(actor, null, { accountType: 'caregiver' }).ok, false);
  }
  assert.strictEqual(W(MANAGER, null, { name: 'X' }).code, 'ACCOUNT_TYPE_REQUIRED');
  assert.strictEqual(W(ADMIN, null, { accountType: 'admin' }).ok, true, 'the Super Admin does everything');
});

test('E: every route that writes a user runs the guard or requireAdmin', () => {
  const src = read('server.js');
  const routes = [...src.matchAll(/app\.(post|put|patch|delete)\('(\/api\/users[^']*)',([^\n]*)/g)];
  assert.ok(routes.length >= 8, 'the routes were found');
  // Self-service preferences have their own self-or-admin check.
  const SELF_SERVICE = ['/api/users/:userId/notification-preferences'];
  for (const [, method, route, rest] of routes) {
    if (SELF_SERVICE.includes(route)) continue;
    assert.ok(/guardUserWrite|requireAdmin|requireFinancialRequester/.test(rest), `${method.toUpperCase()} ${route} carries no user-write guard`);
  }
  // E3: the create and edit routes use the guard; MFA, sessions, EMR stay admin.
  assert.match(src, /app\.post\('\/api\/users', authenticateToken, guardUserWrite,/);
  assert.match(src, /app\.put\('\/api\/users\/:userId', authenticateToken, guardUserWrite,/);
  for (const r of ['/api/users/:userId/mfa/reset', '/api/users/:userId/sessions/revoke', '/api/users/:userId/emr/disconnect', '/api/users/financial-change-requests/:id/decide']) {
    assert.ok(new RegExp(`app\\.post\\('${r.replace(/[/:]/g, m => '\\' + m)}', authenticateToken, requireAdmin`).test(src), `${r} stays Super Admin only`);
  }
  assert.match(src, /app\.delete\('\/api\/users\/:userId', authenticateToken, requireAdmin/);
  // The guard calls the one predicate and holds the money fields.
  const g = src.slice(src.indexOf('const guardUserWrite'), src.indexOf('function normalizeFinancialValue'));
  assert.match(g, /accountTypes\.checkUserWrite\(/);
  assert.match(g, /userFinancial\.splitFinancial\(/);
  assert.match(g, /req\.body = rest/);
});

// ---------------------------------------------------------------------------
// F: money is held and raised as a request
// ---------------------------------------------------------------------------
test('F1: the financial fields are listed once, from what the code writes', () => {
  assert.deepStrictEqual([...userFinancial.FINANCIAL_FIELDS].sort(), ['billingSettings', 'clientPayRates', 'payRate', 'rateAgreement']);
  assert.ok(userFinancial.isFinancialField('payRate'));
  assert.ok(!userFinancial.isFinancialField('name'));
  const header = read('userFinancialFields.js');
  assert.match(header, /NO overtime, mileage, reimbursement, bonus or stipend field/);
});

test('F2: a name and a pay rate in one body: the name goes through, the rate is held', () => {
  const v = W(MANAGER, CG, { name: 'Danielle Carter-Smith', payRate: 22 });
  assert.strictEqual(v.ok, true);
  const { held, rest } = userFinancial.splitFinancial(v.body);
  assert.strictEqual(rest.name, 'Danielle Carter-Smith');
  assert.ok(!('payRate' in rest), 'the rate does not reach the handler');
  assert.deepStrictEqual(held, { payRate: 22 });
});

test('F2/F4: the server raises a request for a held field and says which were held', () => {
  const src = read('server.js');
  for (const route of ["app.post('/api/users', authenticateToken, guardUserWrite", "app.put('/api/users/:userId', authenticateToken, guardUserWrite"]) {
    const i = src.indexOf(route);
    const body = src.slice(i, src.indexOf('\n});', i));
    const save = body.indexOf("await db.set('users', users)");
    const raise = body.indexOf('raiseFinancialRequests(req,');
    assert.ok(save > 0 && raise > save, `${route}: requests are raised after the rest saves`);
    assert.match(body, /financialHeld: financial\.held/, 'the response names what was held');
  }
  const decide = src.slice(src.indexOf("app.post('/api/users/financial-change-requests/:id/decide'"));
  const block = decide.slice(0, decide.indexOf('\n});'));
  assert.match(block, /commitRate\(/, 'a client rate is applied through the same commit the admin uses');
  assert.match(block, /FINANCIAL_REQUEST_STALE/);
  assert.match(src, /app\.get\('\/api\/users\/financial-change-requests', authenticateToken, requireFinancialRequester/);
  assert.match(src, /app\.post\('\/api\/users\/:userId\/financial-change-requests', authenticateToken, requireFinancialRequester/);
});

test('both new collections are registered for migration', () => {
  const reg = require('../dataMigration').COLLECTION_REGISTRY || require('../dataMigration').REGISTRY;
  const keys = (Array.isArray(reg) ? reg : Object.values(reg || {})).map(r => r.key);
  for (const k of ['time_log_adjustment_requests', 'user_financial_change_requests']) assert.ok(keys.includes(k), k);
});

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------
test('screens: the pay views carry no download, and the time boxes read Eastern', () => {
  const page = read('public/scheduling.html');
  const pv = page.slice(page.indexOf('const PayView'), page.indexOf('// ====', page.indexOf('const PayView')));
  assert.ok(pv.length > 200, 'the read-only view exists');
  assert.ok(!/\.csv|download|clipboard|window\.print/i.test(pv), 'no download, copy or print control in the view');
  assert.match(page, /access\.managePay && <button className="btn gold" onClick=\{exportCsv\}>/, 'the export stays the Super Admin\'s');
  assert.match(page, /onRequest=\{!access\.managePay && access\.manageSchedule \? requestAdjustment : null\}/);
  // The correction box used to hold the raw UTC instant, so saving it moved a visit four hours.
  const row = page.slice(page.indexOf('const TimeLogRow'), page.indexOf('const AdjustmentQueue'));
  assert.ok(!/clockInAt\.slice\(0, 16\)/.test(row), 'no raw UTC slice in the time box');
  assert.match(row, /toEasternInput\(l\.clockInAt\)/);
  assert.match(row, /fromEasternInput\(clockInAt\)/);
});

test('screens: caregiver management reviews documents and offers no delete', () => {
  const page = read('public/caregivers.html');
  const docs = page.slice(page.indexOf('const Documents'), page.indexOf('// Broadcast'));
  assert.match(docs, /\/review`/);
  assert.ok(!/method: 'DELETE'/.test(docs), 'removing a document stays with the Super Admin');
});

test('screens: the user form is served only the types the viewer may pick, and shows held pay changes', () => {
  const src = read('server.js');
  const i = src.indexOf("app.get('/api/admin/clinical-roles'");
  assert.match(src.slice(i, i + 900), /canManageAccountType\(req\.user, t\.value\)/);
  const hub = read('public/admin-hub.html');
  assert.match(hub, /<FinancialChangeQueue token=\{token\} requests=\{financialPending\} canDecide=\{isSuperAdmin\}/);
  assert.match(hub, /result\.message \|\|/, 'the form says which fields were held');
});

// ---------------------------------------------------------------------------
// The Admin Hub opens to managers and coordinators for User Management only
// (owner, 2026-11-04).
// ---------------------------------------------------------------------------
test('hub: managers and coordinators sign in to User Management and nothing else', () => {
  const hub = read('public/admin-hub.html');
  assert.match(hub, /const HUB_OFFICE_TYPES = \['manager', 'coordinator'\];/);
  assert.match(hub, /result\.user\.role !== 'admin' && !isHubOffice\(result\.user\)/, 'the sign-in lets them in');
  assert.match(hub, /user\.role !== 'admin' && !isHubOffice\(user\)\) window\.location\.replace/, 'and the page does not bounce them');
  // isSuperAdmin={false} is the rule; the prop list grows, so do not pin the
  // whole tag.
  assert.match(hub, /if \(officeOnly\) return <UsersPage token=\{token\}[^>]*isSuperAdmin=\{false\}[^>]*\/>;/, 'they get the user page whatever was asked');
  assert.match(hub, /const sections = officeOnly\s*\? \[\{ id: 'users', label: 'User Management', icon: 'ti-users' \}\]/, 'the menu shows User Management only');
  // The list shows only the accounts they manage, and the staff-only parts stay hidden.
  assert.match(hub, /isSuperAdmin \|\| OFFICE_MANAGED_TYPES\.includes\(user\.accountType\)\)\.filter\(user =>/);
  assert.match(hub, /\{isSuperAdmin && <button onClick=\{\(\) => handleDelete/);
  assert.match(hub, /\{editingUser && isSuperAdmin && \(/, 'account recovery stays with the Super Admin');
  for (const b of ['pendingTypeReview', 'pendingRoleReview', 'missingPatientFacingCredential']) {
    assert.match(hub, new RegExp(`\\{isSuperAdmin && ${b}\\.length > 0 &&`), b);
  }
  // The list of types they manage matches the server's.
  const m = /const OFFICE_MANAGED_TYPES = (\[[^\]]+\])/.exec(hub);
  assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')).sort(), [...accountTypes.OFFICE_MANAGEABLE_TYPES].sort());
});

test('hub: the rest of the Admin Hub API stays Super Admin only', () => {
  const src = read('server.js');
  const gate = src.slice(src.indexOf('const requireAdminHubAccess'), src.indexOf('const requireAdminHubAccess') + 200);
  assert.match(gate, /req\.user\.role === config\.ROLES\.ADMIN/);
  assert.ok(!/isManager|isHomeCareOffice/.test(gate));
});

test('hub: managers and coordinators reach User Management through People; nobody else new does', () => {
  // User Management moved into the People block (owner, 2026-11-08), opened
  // on the staff side of the People / Clients split (owner, 2026-11-09).
  const usersTile = (t) => ((accountTypes.hubAreasFor(accountTypes.fieldsFor(t)).find(x => x.id === 'people') || {}).links || []).find(x => x.id === 'users');
  for (const t of ['manager', 'coordinator']) {
    const tile = usersTile(t);
    assert.ok(tile && tile.path === '/admin?view=users&group=staff', t);
  }
  for (const t of ['provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'client', 'family']) {
    assert.ok(!usersTile(t), t);
  }
});

test('hub: the user page declares the pay-change state it reads (it crashed User Management for everyone)', () => {
  // PR #225 put this state in the Inbox page by mistake, so User Management
  // threw "financialPending is not defined" for the Super Admin too. Found by
  // rendering the page, not by reading it.
  const hub = read('public/admin-hub.html');
  // Anchored on the DECLARATION, not its full parameter list, and checked:
  // when the signature gained a prop this indexOf returned -1 and the slice
  // below was garbage. A guard that silently grabs the wrong slice proves
  // nothing — it only failed loudly here by luck.
  const start = hub.indexOf('const UsersPage = ({ token, isSuperAdmin');
  assert.ok(start > 0, 'the UsersPage declaration moved; re-anchor this guard');
  const end = hub.indexOf('\n    const ', start + 10);
  assert.ok(end > start, 'the end anchor moved');
  const page = hub.slice(start, end);
  assert.ok(page.length > 1000, `the UsersPage slice looks wrong (${page.length} chars)`);
  assert.match(page, /const \[financialPending, setFinancialPending\] = useState\(\[\]\);/);
  assert.match(page, /loadFinancial\(\);/);
  assert.strictEqual((hub.match(/const \[financialPending, setFinancialPending\]/g) || []).length, 1, 'declared once');
  assert.match(page, /\{isSuperAdmin && \(\s*<button onClick=\{\(\) => \{ setShowBulkReset\(true\)/, 'bulk password reset stays the Super Admin\'s');
  assert.match(page, /\{isSuperAdmin && <button onClick=\{\(\) => setActiveTab\('resets'\)\}/);
});
