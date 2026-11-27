// Setting a shift's status by hand (owner, 2026-11-27): "need to add an option
// to manually change these shift options (as an admin or manager)".
// Driven through the REAL scheduling router over HTTP, stored rows read back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bodyParser = require('body-parser');

function harness(seed) {
  const store = new Map(Object.entries(seed || {}));
  const db = {
    get: async k => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const users = [
    { id: 'adm', email: 'a@g.test', name: 'GFC Admin', role: 'admin' },
    { id: 'mgr', email: 'm@g.test', name: 'Manager', role: 'user', isManager: true, clinicalRole: 'readOnly', accountType: 'manager' },
    { id: 'cg1', email: 'g@g.test', name: 'Danielle Carter', role: 'vendor', licenseLevel: 'cna' },
    { id: 'client-1', email: 'cl@g.test', name: 'Margaret Whitfield', role: 'client', enrollmentStatus: 'enrolled' }
  ];
  const activity = [];
  const app = express();
  app.use(bodyParser.json());
  app.use(require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async (...a) => { activity.push(a); }, queueNotification: async () => ({ id: 'n' }),
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === req.headers['x-as']);
      if (!u) return res.status(401).json({ error: 'no' });
      req.user = { id: u.id, email: u.email, name: u.name, role: u.role, isManager: u.isManager || false,
        accountType: u.accountType || null, clinicalRole: u.clinicalRole || null, hasClinicalAccess: false,
        licenseLevel: u.licenseLevel || null, assignedClients: [], careTeam: null, familyOfClientId: null };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  }));
  return { app, store, activity };
}

const call = (app, method, url, body, as) => new Promise((resolve, reject) => {
  const srv = http.createServer(app).listen(0, () => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port: srv.address().port, path: url, method,
      headers: Object.assign({ 'x-as': as }, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { srv.close(); let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', e => { srv.close(); reject(e); });
    if (data) req.write(data); req.end();
  });
});

const row = (extra) => Object.assign({
  id: 's1', client_id: 'client-1', client_name: 'Margaret Whitfield', status: 'confirmed',
  start: '2026-11-20T14:00:00.000Z', end: '2026-11-20T18:00:00.000Z',
  required_license_level: null, pool_visibility: 'all_eligible', caregiver_id: 'cg1', caregiver_name: 'Danielle Carter'
}, extra || {});
const set = (h, as, body) => call(h.app, 'POST', '/api/scheduling/shifts/s1/status', body, as);
const stored = (h) => h.store.get('shifts').find(r => r.id === 's1');

test('an admin can un-cancel a shift, and the reason is kept on it', async () => {
  const h = harness({ shifts: [row({ status: 'cancelled', cancel_reason: 'mistake' })] });
  const r = await set(h, 'adm', { status: 'confirmed', reason: 'Cancelled by mistake' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const s = stored(h);
  assert.strictEqual(s.status, 'confirmed');
  assert.strictEqual(s.cancel_reason, null);
  assert.strictEqual(s.status_overrides.length, 1);
  assert.deepStrictEqual([s.status_overrides[0].from, s.status_overrides[0].to, s.status_overrides[0].by_name],
    ['cancelled', 'confirmed', 'GFC Admin']);
  assert.ok(h.activity.some(a => a[2] === 'shift_status_override'), 'the activity log records it');
});

test('a manager can mark a shift completed by hand, and no hours are invented', async () => {
  const h = harness({ shifts: [row()], time_logs: [] });
  const r = await set(h, 'mgr', { status: 'completed', reason: 'Visit happened, app was down' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(stored(h).status, 'completed');
  assert.ok(stored(h).completed_at);
  assert.deepStrictEqual(h.store.get('time_logs'), [], 'no time log is created');
  assert.match(r.body.message, /No hours were recorded/);
});

test('a caregiver cannot set a status', async () => {
  const h = harness({ shifts: [row()] });
  const r = await set(h, 'cg1', { status: 'completed', reason: 'x' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(stored(h).status, 'confirmed');
});

test('a reason is required, and an unknown or unchanged status is refused', async () => {
  const h = harness({ shifts: [row()] });
  assert.strictEqual((await set(h, 'adm', { status: 'completed', reason: ' ' })).body.code, 'STATUS_REASON_REQUIRED');
  assert.strictEqual((await set(h, 'adm', { status: 'done', reason: 'x' })).body.code, 'UNKNOWN_STATUS');
  assert.strictEqual((await set(h, 'adm', { status: 'confirmed', reason: 'x' })).body.code, 'STATUS_UNCHANGED');
  assert.strictEqual(stored(h).status, 'confirmed');
});

test('a status that needs a holder is refused on a shift nobody holds', async () => {
  const h = harness({ shifts: [row({ status: 'open', caregiver_id: null, caregiver_name: null })] });
  const r = await set(h, 'adm', { status: 'confirmed', reason: 'x' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'SHIFT_NEEDS_HOLDER');
  assert.strictEqual(stored(h).status, 'open');
});

test('setting a held shift back to open releases the holder', async () => {
  const h = harness({ shifts: [row()] });
  const r = await set(h, 'adm', { status: 'open', reason: 'She can no longer make it' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(stored(h).status, 'open');
  assert.strictEqual(stored(h).caregiver_id, null);
  assert.strictEqual(stored(h).released_from_id, 'cg1');
});

test('leaving in progress closes the open clock-in', async () => {
  const h = harness({
    shifts: [row({ status: 'in_progress' })],
    time_logs: [{ id: 'l1', shift_id: 's1', caregiver_id: 'cg1', client_id: 'client-1', clock_in_at: new Date(Date.now() - 3600000).toISOString(), clock_out_at: null }]
  });
  const r = await set(h, 'adm', { status: 'completed', reason: 'Forgot to clock out' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(h.store.get('time_logs')[0].clock_out_at, 'the running clock is stopped');
  assert.strictEqual(stored(h).status, 'completed');
});

test('the board shows the override to the office, never to the caregiver', async () => {
  const h = harness({ shifts: [row({ status_overrides: [{ from: 'cancelled', to: 'confirmed', reason: 'office note', at: 'x', by_name: 'GFC Admin' }] })] });
  const office = await call(h.app, 'GET', '/api/scheduling/shifts', null, 'adm');
  assert.strictEqual(office.body.shifts[0].statusOverrides.length, 1);
  const mine = await call(h.app, 'GET', '/api/scheduling/shifts', null, 'cg1');
  assert.strictEqual(mine.body.shifts[0].statusOverrides, undefined);
});

test('the board offers Change Status and posts to the override route', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'scheduling.html'), 'utf8');
  assert.match(page, /Change Status<\/button>/);
  assert.match(page, /\/api\/scheduling\/shifts\/\$\{s\.id\}\/status`/);
});
