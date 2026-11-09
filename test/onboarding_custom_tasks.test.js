'use strict';
// Tasks an admin or manager adds to staff onboarding (owner, 2026-11-09): to
// one person, or to everyone onboarding under a chapter, now and later. She
// marks it done; when the office asked to review it, it is complete only once
// the office reviews it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const VF = require('../onboarding/versionFlags');
const T = require('../onboarding/track');

const USERS = {
  admin: { id: 'admin', name: 'Bianca Ume', role: 'admin' },
  mgr: { id: 'mgr', name: 'Morgan Manager', role: 'user', isManager: true, accountType: 'manager' },
  li1: { id: 'li1', name: 'Lee Liaison', role: 'user', accountType: 'liaison' },
  li2: { id: 'li2', name: 'Lou Liaison', role: 'user', accountType: 'liaison' },
  np: { id: 'np', name: 'Nia Provider', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true }
};

async function mount() {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => Object.values(USERS),
    authenticateToken: (req, res, next) => { req.user = USERS[req.headers['x-as']]; if (!req.user) return res.status(401).json({}); next(); },
    drive: {}, detectFileType: () => null, uuidv4: () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {} }) }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (as, m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'x-as': as, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  return { store, call, close: () => server.close() };
}
const customOf = (track) => track.items.filter(i => i.custom);

test('admins and managers add tasks; staff cannot', async () => {
  const h = await mount();
  try {
    await h.call('admin', 'PUT', '/api/onboarding/admin/people/li1/inputs', { chapter: 'G' });
    let r = await h.call('li1', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'x', scope: { userId: 'li1' } });
    assert.strictEqual(r.status, 403);
    r = await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Shadow two visits', scope: { userId: 'li1' } });
    assert.strictEqual(r.status, 200);
    r = await h.call('mgr', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Read the referral guide', scope: { chapter: 'G' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await h.call('li1', 'GET', '/api/onboarding/admin/custom-tasks')).status, 403);
    const list = (await h.call('mgr', 'GET', '/api/onboarding/admin/custom-tasks')).body.tasks;
    assert.deepStrictEqual(list.map(t => t.scopeLabel).sort(), ['Everyone onboarding as Community Care Liaison (remote business development)', 'Only Lee Liaison']);
    // Refused by name.
    assert.strictEqual((await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: '', scope: { chapter: 'G' } })).body.code, 'TASK_TITLE_REQUIRED');
    assert.strictEqual((await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'x', scope: { chapter: 'ZZ' } })).body.code, 'TASK_SCOPE_REQUIRED');
    assert.strictEqual((await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'x', scope: { userId: 'nobody' } })).body.code, 'TASK_PERSON_UNKNOWN');
  } finally { h.close(); }
});

test('a person task reaches only them; a type task reaches everyone of that type, including people set up later', async () => {
  const h = await mount();
  try {
    await h.call('admin', 'PUT', '/api/onboarding/admin/people/li1/inputs', { chapter: 'G' });
    await h.call('admin', 'PUT', '/api/onboarding/admin/people/np/inputs', { chapter: 'C' });
    await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Just Lee', scope: { userId: 'li1' } });
    await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'All liaisons', scope: { chapter: 'G' } });
    await h.call('admin', 'PUT', '/api/onboarding/admin/people/li2/inputs', { chapter: 'G' });
    const t1 = (await h.call('li1', 'GET', '/api/onboarding/me')).body.track;
    const t2 = (await h.call('li2', 'GET', '/api/onboarding/me')).body.track;
    const tn = (await h.call('np', 'GET', '/api/onboarding/me')).body.track;
    assert.deepStrictEqual(customOf(t1).map(i => i.title).sort(), ['All liaisons', 'Just Lee']);
    assert.deepStrictEqual(customOf(t2).map(i => i.title), ['All liaisons']);
    assert.deepStrictEqual(customOf(tn), []);
    assert.ok(t1.phases.some(p => p.id === 'GFC' && p.label === 'Added by GFC'));
    assert.ok(!tn.phases.some(p => p.id === 'GFC'), 'no empty Added by GFC phase');
    // Another person's task is unknown to her doors.
    const lees = customOf(t1).find(i => i.title === 'Just Lee');
    assert.strictEqual((await h.call('li2', 'POST', `/api/onboarding/me/items/${lees.id}/steps/0`, {})).status, 404);
  } finally { h.close(); }
});

test('she marks it done; with review on, it waits for the office, and only the office can review', async () => {
  const h = await mount();
  try {
    await h.call('admin', 'PUT', '/api/onboarding/admin/people/li1/inputs', { chapter: 'G' });
    const a = (await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Plain', scope: { userId: 'li1' } })).body.task;
    const b = (await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Reviewed', details: 'Bring the binder', review: true, askForFile: true, scope: { userId: 'li1' } })).body.task;
    assert.strictEqual((await h.call('li1', 'POST', `/api/onboarding/me/items/${a.id}/steps/0`, {})).status, 200);
    assert.strictEqual((await h.call('li1', 'POST', `/api/onboarding/me/items/${b.id}/steps/0`, {})).status, 200);
    let t = (await h.call('li1', 'GET', '/api/onboarding/me')).body.track;
    const st = (id) => t.items.find(i => i.id === id);
    assert.strictEqual(st(a.id).status, T.STATUS.COMPLETE);
    assert.strictEqual(st(b.id).status, T.STATUS.SUBMITTED);
    assert.deepStrictEqual(st(b.id).steps.map(s => [s.actorLabel, s.action]), [['New hire', 'COMPLETE'], ['GFC office', 'REVIEW']]);
    assert.deepStrictEqual(st(b.id).elements, [{ row: 'Bring the binder' }]);
    assert.strictEqual(st(b.id).askForFile, true);
    assert.strictEqual((await h.call('li1', 'POST', `/api/onboarding/me/items/${b.id}/steps/1`, {})).body.code, 'STEP_NOT_YOURS');
    assert.strictEqual((await h.call('mgr', 'POST', `/api/onboarding/admin/people/li1/items/${b.id}/steps/1`, {})).status, 200);
    t = (await h.call('li1', 'GET', '/api/onboarding/me')).body.track;
    assert.strictEqual(st(b.id).status, T.STATUS.COMPLETE);
    // Notes and not-applicable work on it like any item.
    assert.strictEqual((await h.call('li1', 'POST', `/api/onboarding/me/items/${a.id}/notes`, { text: 'Done Tuesday' })).status, 200);
    const c = (await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Skip me', scope: { userId: 'li1' } })).body.task;
    assert.strictEqual((await h.call('admin', 'POST', `/api/onboarding/admin/people/li1/items/${c.id}/not-applicable`, { reason: 'Already did it' })).status, 200);
    t = (await h.call('li1', 'GET', '/api/onboarding/me')).body.track;
    assert.strictEqual(st(c.id).status, T.STATUS.NOT_APPLICABLE);
  } finally { h.close(); }
});

test('removing a task takes it off every checklist and keeps the row', async () => {
  const h = await mount();
  try {
    await h.call('admin', 'PUT', '/api/onboarding/admin/people/li1/inputs', { chapter: 'G' });
    const a = (await h.call('admin', 'POST', '/api/onboarding/admin/custom-tasks', { title: 'Gone soon', scope: { chapter: 'G' } })).body.task;
    assert.strictEqual((await h.call('li1', 'DELETE', `/api/onboarding/admin/custom-tasks/${a.id}`)).status, 403);
    assert.strictEqual((await h.call('mgr', 'DELETE', `/api/onboarding/admin/custom-tasks/${a.id}`)).status, 200);
    assert.deepStrictEqual(customOf((await h.call('li1', 'GET', '/api/onboarding/me')).body.track), []);
    assert.deepStrictEqual((await h.call('admin', 'GET', '/api/onboarding/admin/custom-tasks')).body.tasks, []);
    const row = h.store.onboarding_custom_tasks.find(t => t.id === a.id);
    assert.ok(row.removedAt && row.removedByName === 'Morgan Manager');
  } finally { h.close(); }
});

test('the page offers it to the office: Add a Task on a person and on the overview, Remove on the item', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /^const AddTaskForm = \(\{ person, chapters, onAdded, onCancel \}\) => \{/m, 'module scope, so typing keeps focus');
  assert.match(page, /<AddTaskForm person=\{\{ userId, name: t\.person\.name, chapter: t\.chapter\.id \}\}/);
  assert.match(page, /<CustomTaskList \/>/);
  assert.match(page, /\{office && item\.custom && \(/);
  assert.match(page, /Office reviews it after it is marked done/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'dataMigration.js'), 'utf8'), /key: 'onboarding_custom_tasks', phi: false/);
});
