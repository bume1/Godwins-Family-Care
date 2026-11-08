'use strict';

// One clock (owner, 2026-11-08): W-2 staff without shifts clock in on the same
// clock caregivers use, into the same time logs. Their hours reach payroll and
// never a client invoice.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const USERS = [
  { id: 'admin-1', name: 'Office Admin', role: 'admin' },
  { id: 'np-1', name: 'Bethel Godwins', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true, employmentType: 'W2' },
  { id: 'coord-1', name: 'Coco Ordinator', role: 'user', accountType: 'coordinator', isManager: true, clinicalRole: 'coordinator', employmentType: 'W2' },
  { id: 'ctr-1', name: 'Connie Tractor', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true, employmentType: '1099' },
  { id: 'cg-1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'pca', employmentType: 'W2' }
];

async function mount(t, extra = {}) {
  const store = new Map(Object.entries(Object.assign({ users: USERS }, extra)));
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const router = require('../routes/scheduling')({
    db, config: require('../config'), logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => await db.get('users'), invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { const u = USERS.find(x => x.id === (req.headers['x-as'] || 'admin-1')); req.user = { ...u, isManager: !!u.isManager }; next(); },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, as) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(as ? { 'x-as': as } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* csv */ }
    return { status: res.status, json, text };
  };
  return { store, call };
}

test('a W-2 clinician and a W-2 coordinator clock in and out on the shared clock, into time_logs', async (t) => {
  const h = await mount(t);
  for (const who of ['np-1', 'coord-1']) {
    const i = await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, who);
    assert.strictEqual(i.status, 200, who);
    assert.strictEqual((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, who)).json.code, 'ALREADY_CLOCKED_IN');
    assert.strictEqual((await h.call('POST', '/api/scheduling/staff-clock/clock-out', {}, who)).status, 200);
  }
  const logs = h.store.get('time_logs');
  assert.strictEqual(logs.length, 2);
  assert.ok(logs.every(l => l.kind === 'staff' && l.shift_id === null && l.client_id === null && l.clock_out_at));
  const mine = await h.call('GET', '/api/scheduling/time-logs', undefined, 'np-1');
  assert.strictEqual(mine.json.timeLogs.length, 1, 'she reads only her own');
});

test('1099 staff and caregivers do not use the staff clock', async (t) => {
  const h = await mount(t);
  assert.strictEqual((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'ctr-1')).json.code, 'STAFF_CLOCK_W2_ONLY');
  assert.strictEqual((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'cg-1')).json.code, 'STAFF_CLOCK_W2_ONLY', 'caregivers clock in on their shifts');
  assert.strictEqual(h.store.get('time_logs'), undefined);
});

test('an out-of-state hire cannot record hours until payroll clears the work state (Playbook F.6)', async (t) => {
  const h = await mount(t, { onboarding_records: [{ userId: 'coord-1', inputs: { chapter: 'F', outOfState: true }, items: {} }] });
  assert.strictEqual((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'coord-1')).json.code, 'COMPENSATION_GATE');
  const recs = h.store.get('onboarding_records');
  recs[0].items['F.6.02'] = { steps: { 0: { at: '2026-11-08' } } };
  h.store.set('onboarding_records', recs);
  assert.strictEqual((await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'coord-1')).status, 200);
});

test('staff hours reach payroll as W-2 staff and never a client invoice', async (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const h = await mount(t);
  await h.call('POST', '/api/scheduling/staff-clock/clock-in', {}, 'np-1');
  await h.call('POST', '/api/scheduling/staff-clock/clock-out', {}, 'np-1');
  const from = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const pay = await h.call('GET', `/api/scheduling/payroll.csv?from=${from}&to=${to}`);
  assert.strictEqual(pay.status, 200);
  assert.match(pay.text, /Bethel Godwins/);
  assert.match(pay.text, /W-2 staff/);
  const bill = await h.call('GET', `/api/scheduling/billing.csv?from=${from}&to=${to}`);
  assert.ok(!/Bethel Godwins/.test(bill.text), 'a staff hour is not a client visit');
  void today;
});
