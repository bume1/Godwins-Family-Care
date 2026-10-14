// Patient to-dos and the daily digest (owner, 2026-10-13).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../clinicalTasks');
const clinicalRoles = require('../clinicalRoles');

const FNP = { id: 'u-fnp', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true };
const RN = { id: 'u-rn', name: 'Rita Nurse', role: 'user', clinicalRole: 'rn', hasClinicalAccess: true };
const OTHER = { id: 'u-other', name: 'Other Provider', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true };
const ADMIN = { id: 'u-admin', name: 'GFC Admin', role: 'admin' };
const CM = { id: 'u-cm', name: 'Courtney Hale', role: 'caseManager' };
const CAREGIVER = { id: 'u-cg', name: 'Cara Giver', role: 'vendor', licenseLevel: 'PCA' };
const CLIENT = { id: 'c-1', name: 'Juanita Guess', role: 'client' };
const users = [FNP, RN, OTHER, ADMIN, CM, CAREGIVER, CLIENT];
const findUser = (id) => users.find(u => u.id === id) || null;
const TODAY = '2026-10-14';

const make = (over = {}, actor = FNP) => T.createTask({
  input: { title: 'Call daughter about PT', ...over }, actor, client: CLIENT, findUser, now: '2026-10-14T13:00:00Z'
});

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('who may hold a to-do: the clinical team incl. case managers, never a caregiver or a client', () => {
  for (const u of [FNP, RN, ADMIN, CM]) assert.strictEqual(T.canManageTasks(u), true, u.name);
  for (const u of [CAREGIVER, CLIENT, null]) assert.strictEqual(T.canManageTasks(u), false);
  assert.strictEqual(clinicalRoles.canManageTasks({ ...FNP, accountStatus: 'inactive' }), false);
});

test('a to-do is seen only by its assignee and its author — not admin, not the rest of the team', () => {
  const t = make({ assigneeId: RN.id });
  assert.strictEqual(T.canSee(t, FNP), true);
  assert.strictEqual(T.canSee(t, RN), true);
  for (const u of [OTHER, ADMIN, CM]) assert.strictEqual(T.canSee(t, u), false, u.name);
  const list = T.listForViewer({ tasks: [t], viewer: ADMIN, scope: 'all' });
  assert.deepStrictEqual(list, []);
});

test('assigned to me vs I assigned', () => {
  const mine = make({}, FNP);
  const handed = make({ assigneeId: RN.id }, FNP);
  const fromRn = make({ assigneeId: FNP.id }, RN);
  const ids = (scope) => T.listForViewer({ tasks: [mine, handed, fromRn], viewer: FNP, scope }).map(t => t.id).sort();
  assert.deepStrictEqual(ids('mine'), [mine.id, fromRn.id].sort());
  assert.deepStrictEqual(ids('assigned_by_me'), [handed.id]);
  assert.strictEqual(ids('all').length, 3);
});

test('defaults to the author, and refuses an assignee who is not on the clinical team', () => {
  assert.strictEqual(make().assigneeId, FNP.id);
  assert.throws(() => make({ assigneeId: CAREGIVER.id }), e => e.code === 'TASK_ASSIGNEE_NOT_ELIGIBLE');
  assert.throws(() => make({ assigneeId: 'ghost' }), e => e.code === 'TASK_ASSIGNEE_NOT_FOUND');
  assert.strictEqual(make({ assigneeId: CM.id }).assigneeId, CM.id);
});

test('a case manager can write, complete and reopen a to-do', () => {
  const t = make({}, CM);
  const done = T.applyTaskAction({ task: t, action: 'done', input: { note: 'Spoke to daughter' }, actor: CM, findUser });
  assert.strictEqual(done.task.status, 'done');
  assert.strictEqual(done.task.completedById, CM.id);
  const back = T.applyTaskAction({ task: done.task, action: 'reopen', actor: CM, findUser });
  assert.strictEqual(back.task.status, 'open');
  assert.strictEqual(back.task.completedAt, null);
});

test('every to-do names a patient', () => {
  assert.throws(() => T.createTask({ input: { title: 'x' }, actor: FNP, client: null, findUser }),
    e => e.code === 'TASK_CLIENT_REQUIRED');
});

test('bad input is refused by name, never dropped', () => {
  assert.throws(() => make({ title: '   ' }), e => e.code === 'TASK_TITLE_REQUIRED');
  assert.throws(() => make({ title: 'x'.repeat(201) }), e => e.code === 'TASK_TITLE_TOO_LONG');
  assert.throws(() => make({ dueDate: '2026-02-30' }), e => e.code === 'TASK_DUE_INVALID');
  assert.throws(() => make({ priority: 'asap' }), e => e.code === 'TASK_PRIORITY_INVALID');
  assert.throws(() => make({ category: 'billing' }), e => e.code === 'TASK_CATEGORY_INVALID');
});

test('cancelling needs a reason; a closed to-do cannot be edited or closed again', () => {
  const t = make();
  assert.throws(() => T.applyTaskAction({ task: t, action: 'cancel', input: {}, actor: FNP, findUser }),
    e => e.code === 'TASK_CANCEL_REASON_REQUIRED');
  const c = T.applyTaskAction({ task: t, action: 'cancel', input: { reason: 'Daughter called us' }, actor: FNP, findUser }).task;
  assert.strictEqual(c.status, 'cancelled');
  assert.throws(() => T.applyTaskAction({ task: c, action: 'edit', input: { title: 'y' }, actor: FNP, findUser }), e => e.code === 'TASK_NOT_OPEN');
  assert.throws(() => T.applyTaskAction({ task: c, action: 'done', actor: FNP, findUser }), e => e.code === 'TASK_NOT_OPEN');
});

test('history records who and which fields changed, never the words', () => {
  const t = make({ detail: 'Potassium 5.9' });
  const { task, changed } = T.applyTaskAction({ task: t, action: 'edit', input: { title: 'Recheck potassium', dueDate: TODAY }, actor: FNP, findUser });
  assert.deepStrictEqual(changed.sort(), ['dueDate', 'title']);
  const json = JSON.stringify(task.history);
  assert.ok(!json.includes('potassium') && !json.includes('Potassium'), json);
  assert.deepStrictEqual(task.history.at(-1).fields.sort(), ['dueDate', 'title']);
});

test('an edit with nothing changed writes nothing', () => {
  const t = make({ dueDate: TODAY });
  const r = T.applyTaskAction({ task: t, action: 'edit', input: { dueDate: TODAY }, actor: FNP, findUser });
  assert.strictEqual(r.task, t);
  assert.deepStrictEqual(r.changed, []);
});

test('buckets are judged against the date passed in (Georgia), with a 7-day upcoming window', () => {
  const at = (dueDate, status = 'open') => T.bucketFor({ status, dueDate }, TODAY);
  assert.strictEqual(at('2026-10-13'), 'overdue');
  assert.strictEqual(at('2026-10-14'), 'today');
  assert.strictEqual(at('2026-10-21'), 'upcoming');
  assert.strictEqual(at('2026-10-22'), 'later');
  assert.strictEqual(at(null), 'no_date');
  assert.strictEqual(at('2026-10-01', 'done'), 'closed');
  // The bucket never reads the system clock: the same task, judged on a
  // different practice day, moves.
  assert.strictEqual(T.bucketFor({ status: 'open', dueDate: '2026-10-14' }, '2026-10-15'), 'overdue');
  assert.ok(!/new Date\(\)/.test(strip(T.bucketFor.toString())));
});

test('the digest splits pending now from coming up, and only ever shows the viewer\'s own work', () => {
  const tasks = [
    make({ title: 'overdue', dueDate: '2026-10-10' }),
    make({ title: 'today', dueDate: TODAY }),
    make({ title: 'next week', dueDate: '2026-10-18' }),
    make({ title: 'later', dueDate: '2026-11-30' }),
    make({ title: 'not mine', dueDate: TODAY }, OTHER),
    make({ title: 'handed to rn', dueDate: TODAY, assigneeId: RN.id })
  ];
  const d = T.buildDigest({
    viewer: FNP, today: TODAY, tasks,
    inboxItems: [
      { kind: 'encounter_unsigned', id: 'e1', clientId: 'c-1', label: 'Encounter documented but not signed', actionable: true },
      { kind: 'encounter_co_sign', id: 'e2', clientId: 'c-1', label: 'x', actionable: false }
    ],
    results: [
      { id: 'r1', clientId: 'c-1', interpretation: 'abnormal', routeTo: { userId: FNP.id } },
      { id: 'r2', clientId: 'c-1', routeTo: { userId: OTHER.id } },
      { id: 'r3', clientId: 'c-1', acknowledgedAt: 'x', routeTo: { userId: FNP.id } }
    ],
    overdueOrders: [
      { id: 'o1', clientId: 'c-1', orderType: 'lab', ageDays: 9, orderingClinician: { id: FNP.id } },
      { id: 'o2', clientId: 'c-1', orderType: 'lab', ageDays: 9, orderingClinician: { id: OTHER.id } }
    ],
    orders: [
      { id: 'f1', clientId: 'c-1', orderType: 'referral', status: 'sent', referral: { specialty: 'Cardiology' }, orderingClinician: { id: FNP.id } },
      { id: 'f2', clientId: 'c-1', orderType: 'referral', status: 'completed', orderingClinician: { id: FNP.id } }
    ],
    appointments: [
      { eid: '1', clientId: 'c-1', date: '2026-10-15', startTime: '09:00', title: 'Follow-up' },
      { eid: '2', clientId: 'c-1', date: '2026-10-16', status: 'x', state: 'cancelled' },
      { eid: '3', clientId: 'c-1', date: '2026-10-30' },
      { eid: '4', clientId: 'c-1', date: '2026-10-13' }
    ],
    nameOf: () => 'Juanita Guess'
  });
  const titles = (l) => l.map(x => x.title || x.id);
  assert.deepStrictEqual(d.pending.filter(p => p.kind === 'todo').map(p => p.title), ['overdue', 'today']);
  assert.deepStrictEqual(d.upcoming.filter(p => p.kind === 'todo').map(p => p.title), ['next week']);
  assert.ok(!titles(d.pending).includes('not mine') && !titles(d.pending).includes('handed to rn'));
  assert.deepStrictEqual(d.pending.filter(p => p.kind === 'inbox').map(p => p.id), ['inbox:encounter_unsigned:e1']);
  assert.deepStrictEqual(d.pending.filter(p => p.kind === 'result').map(p => p.id), ['result:r1']);
  assert.deepStrictEqual(d.pending.filter(p => p.kind === 'order').map(p => p.id), ['order:o1']);
  assert.deepStrictEqual(d.upcoming.filter(p => p.kind === 'visit').map(p => p.id), ['visit:1']);
  assert.deepStrictEqual(d.upcoming.filter(p => p.kind === 'referral').map(p => p.id), ['referral:f1']);
  assert.strictEqual(d.counts.pending, d.pending.length);
  assert.strictEqual(d.counts.upcoming, d.upcoming.length);
  assert.strictEqual(d.pending[0].overdue, true, 'overdue sorts first');
});

test('the routes: one gate, a hidden to-do answers 404, the audit carries ids not words', () => {
  const routes = ['/api/clinical/tasks', '/api/clinical/tasks/:taskId', '/api/clinical/digest'];
  for (const r of routes) assert.match(server, new RegExp(`app\\.(get|post|put)\\('${r.replace(/[/:]/g, m => `\\${m}`)}', authenticateToken, requireTaskManager,`));
  const i = server.indexOf("app.put('/api/clinical/tasks/:taskId'");
  const body = server.slice(i, server.indexOf('\n});', i));
  assert.match(body, /!clinicalTasks\.canSee\(rows\[idx\], actor\)\)\s*\{\s*return res\.status\(404\)/);
  const audits = server.slice(server.indexOf('// ── Patient to-dos and the daily digest'), server.indexOf('// GET /api/clinical/digest'));
  for (const m of audits.matchAll(/logActivity\(([\s\S]*?)\);/g)) {
    assert.ok(!/title|detail/.test(m[1]), `an audit row must not carry the words: ${m[1]}`);
  }
  const d = server.slice(server.indexOf("app.get('/api/clinical/digest'"), server.indexOf('// GET /api/clinical/analytics'));
  assert.ok(!/sendEmail|queueNotification/.test(d), 'the digest is on screen only (owner)');
});

test('the page draws the to-do UI from the server answer and keeps the work queues', () => {
  assert.match(page, /canManageTasks: !!\(emrStatus && emrStatus\.access && emrStatus\.access\.canManageTasks\)/);
  assert.match(page, /<TasksShell onOpenChart=/);
  assert.match(page, /\{date === today && access\.canManageTasks && onGo && <DigestCard/);
  assert.match(page, /if \(!useContext\(AccessContext\)\.canManageTasks\) return null;/);
  assert.match(server, /canManageTasks: clinicalRoles\.canManageTasks\(req\.user\)/);
});
