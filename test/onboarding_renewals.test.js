'use strict';

// Renewals, recurring duties and spaced re-checks: the pure rules and the
// routes over HTTP.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const R = require('../onboarding/renewals');
const T = require('../onboarding/track');
const { MODULES } = require('../onboarding/modules');
const VF = require('../onboarding/versionFlags');

const TODAY = new Date('2026-11-08T12:00:00Z');
const NOW = '2026-11-08T12:00:00Z';
const ACT = { id: 'a1', name: 'Office Admin', isOffice: true };

test('an expiring credential warns 60 days out and reads Renewal Due once it passes', () => {
  assert.strictEqual(R.expiryOf('C.4.01', { expiresOn: '2027-03-01' }, TODAY).status, 'OK');
  assert.strictEqual(R.expiryOf('C.4.01', { expiresOn: '2026-12-20' }, TODAY).status, 'SOON');
  assert.strictEqual(R.expiryOf('C.4.01', { expiresOn: '2026-11-07' }, TODAY).status, 'EXPIRED');
  assert.strictEqual(R.expiryOf('C.4.01', {}, TODAY).status, 'NO_DATE');
  assert.strictEqual(R.expiryOf('C.4.03', { expiresOn: '2026-11-07' }, TODAY), null, 'a documentation sample never expires');
  const done = { steps: { 0: { at: NOW }, 1: { at: NOW } }, expiresOn: '2026-11-01' };
  const t = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'] }, record: { items: { 'C.4.01': done } }, today: TODAY });
  assert.strictEqual(t.items.find(i => i.id === 'C.4.01').status, T.STATUS.EXPIRED);
  assert.strictEqual(t.counts.renewalsDue, 1);
});

test('starting a renewal reopens the item and keeps the old record', () => {
  const st = { steps: { 0: { at: NOW }, 1: { at: NOW } }, expiresOn: '2026-11-01' };
  const next = R.startRenewal('C.4.01', st, ACT, NOW);
  assert.deepStrictEqual(next.steps, {});
  assert.strictEqual(next.expiresOn, null);
  assert.strictEqual(next.history.length, 1);
  assert.strictEqual(next.history[0].expiresOn, '2026-11-01');
  const again = R.startRenewal('C.4.01', Object.assign({}, next, { steps: { 0: { at: NOW } }, expiresOn: '2027-11-01' }), ACT, NOW);
  assert.deepStrictEqual(again.history.map(h => h.expiresOn), ['2026-11-01', '2027-11-01'], 'every renewal keeps the records before it');
  assert.throws(() => R.startRenewal('C.4.03', {}, ACT, NOW), /not renewed/);
});

test('a recurring duty is due its interval after it was last done, or after the start date', () => {
  const r30 = [{ id: 'C.9.R1', requirement: 'x', interval: 'Every thirty days', days: 30 }];
  assert.strictEqual(R.recurringFor(r30, {}, '2026-10-20', TODAY)[0].status, 'SOON');
  assert.strictEqual(R.recurringFor(r30, {}, '2026-09-01', TODAY)[0].status, 'OVERDUE');
  const rec = R.recordRecurring('C.9.R1', {}, '2026-11-05', ACT, NOW);
  const row = R.recurringFor(r30, rec, '2026-09-01', TODAY)[0];
  assert.strictEqual(row.nextDue, '2026-12-05');
  assert.strictEqual(row.status, 'OK');
  assert.strictEqual(R.recurringFor(r30, {}, null, TODAY)[0].status, 'NO_START');
  assert.throws(() => R.recordRecurring('C.9.R1', {}, '', ACT, NOW), /date/);
});

test('spaced re-checks open on days 3, 10, 30 and 90, only for knowledge modules, never early or twice', () => {
  const video = MODULES.find(m => /^VIDEO/.test(m.format));
  const live = MODULES.find(m => m.format === 'LIVE');
  const p = { completedAt: '2026-11-01T12:00:00Z', version: video.version };
  const r = R.rechecksFor(video, p, TODAY);
  assert.deepStrictEqual(r.list.map(x => x.day), [3, 10, 30, 90]);
  assert.deepStrictEqual(r.dueNow, [3]);
  assert.strictEqual(R.rechecksFor(live, p, TODAY), null, 'a live review is not re-checked');
  const after = R.recordRecheck(video, p, 3, { name: 'Jordan', isOffice: false }, NOW, TODAY);
  assert.strictEqual(after.rechecks[3].filedBy, 'SELF');
  assert.throws(() => R.recordRecheck(video, after, 3, ACT, NOW, TODAY), /already/);
  assert.throws(() => R.recordRecheck(video, after, 10, ACT, NOW, TODAY), /opens on 2026-11-11/);
});

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const NP = { id: 'n1', name: 'Jordan Ellis', role: 'user', hasClinicalAccess: true };
async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, NP],
    authenticateToken: (req, _r, next) => { req.user = current; next(); },
    drive: {}, detectFileType: () => null, uuidv4: () => Math.random().toString(36).slice(2),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {} }) }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, p, b) => { const res = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: res.status, data: await res.json() }; };
  return { store, call, as: (u) => { current = u; } };
}

test('routes: she records her licence date and starts its renewal; only the office records a recurring duty', async (t) => {
  const h = await mount(t);
  h.as(OFFICE);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'], startDate: '2026-09-01' });
  h.as(NP);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/me/items/C.4.01/expiry', { expiresOn: '2026-12-01' })).status, 200);
  assert.strictEqual(h.store.onboarding_records[0].items['C.4.01'].expiresOn, '2026-12-01');
  assert.strictEqual((await h.call('PUT', '/api/onboarding/me/items/C.4.03/expiry', { expiresOn: '2026-12-01' })).data.code, 'ITEM_DOES_NOT_EXPIRE');
  assert.strictEqual((await h.call('POST', '/api/onboarding/me/items/C.4.01/renew', {})).status, 200);
  assert.strictEqual(h.store.onboarding_records[0].items['C.4.01'].history.length, 1);
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${NP.id}/recurring/C.9.R1`, { doneOn: '2026-11-05' })).status, 403);
  h.as(OFFICE);
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${NP.id}/recurring/C.9.R1`, { doneOn: '2026-11-05' })).status, 200);
  const p = await h.call('GET', `/api/onboarding/admin/people/${NP.id}`);
  assert.strictEqual(p.data.track.renewals.recurring.find(r => r.id === 'C.9.R1').nextDue, '2026-12-05');
});
