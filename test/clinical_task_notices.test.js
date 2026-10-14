// ============================================================================
// The to-do emails (owner, 2026-10-14)
//
//   "email every time a task is assigned, due, overdue (one email about task
//    a day) and then marked completed."
//
// Before this a to-do was written to the record and nothing was sent: the
// assignee found out by opening the workspace, and the person who wrote it
// had no way to know it had landed.
//
// Two of the four are events, sent at the route. Two are a state, swept once
// a day. What is asserted here is the DELIVERED MESSAGE — the notices are run
// through the real notifier on both transports and the queued row is read
// back — because the only email defect this repo has ever found by reading
// source is none of them.
// ============================================================================

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../clinicalTasks');
const { createNotifier } = require('../notifications');
const appLinks = require('../appLinks');

const root = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The two blocks this file scans, sliced between CODE anchors and asserted
// non-empty at both ends. A slice that silently grabs the wrong text — or the
// whole file — proves nothing about either.
const between = (src, startAnchor, endAnchor, label) => {
  const from = src.indexOf(startAnchor);
  const to = src.indexOf(endAnchor, from + 1);
  assert.ok(from !== -1, `${label}: start anchor "${startAnchor}" is gone`);
  assert.ok(to > from, `${label}: end anchor "${endAnchor}" is gone`);
  return src.slice(from, to);
};
const sliceEvents = (src) => between(src, 'const notifyTaskAssigned =', "app.post('/api/clinical/tasks'", 'event notices');
const sliceSweep = (src) => between(src, 'const sendDueTaskReminders', 'const sendDueVisitReminders', 'reminder sweep');

const FNP = { id: 'u-fnp', name: 'Bethel Godwins', email: 'b@test.local', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true };
const RN = { id: 'u-rn', name: 'Rita Nurse', email: 'rn@test.local', role: 'user', clinicalRole: 'rn', hasClinicalAccess: true };
const CLIENT = { id: 'c-1', name: 'Juanita Guess', role: 'client' };
const USERS = [FNP, RN, CLIENT];
const findUser = (id) => USERS.find(u => u.id === id) || null;
const nameOf = (id) => (findUser(id) || {}).name || null;
const TODAY = '2026-10-14';

const make = (over = {}, actor = FNP) => T.createTask({
  input: { title: 'Call daughter about PT', ...over }, actor, client: CLIENT, findUser,
  now: '2026-10-14T13:00:00Z'
});

// The real notifier, wired exactly as server.js wires it. A harness missing
// what production supplies exercises a different function.
const harness = ({ baaCovered = true } = {}) => {
  const notices = [];
  const notify = createNotifier({
    getUsers: async () => USERS,
    queueNotification: async (type, id, email, name, data, o) => {
      notices.push({ type, email, name, ...data, ...(o || {}) }); return { id: 'q' };
    },
    getAppBaseUrl: async () => 'https://app.test.local',
    emailTransport: { transportStatus: () => ({ baaCovered }) },
    staffRoles: ['admin', 'user', 'caseManager'], clientRole: 'client', familyRole: 'family'
  });
  return { notify, notices };
};

// ---------------------------------------------------------------------------
// The sweep: which to-dos want an email right now
// ---------------------------------------------------------------------------

test('N1 nothing goes out before the send hour, whatever the scan interval', () => {
  const tasks = [make({ dueDate: TODAY }), make({ dueDate: '2026-10-01' })];
  for (const h of [0, 5, 8]) {
    assert.deepStrictEqual(T.remindersDue({ tasks, today: TODAY, hourEt: h }), [],
      `hour ${h}: the scanner runs every few minutes, so without this a to-do is emailed at 00:05`);
  }
  assert.strictEqual(T.remindersDue({ tasks, today: TODAY, hourEt: T.TASK_EMAIL_SEND_HOUR_ET }).length, 2);
  assert.strictEqual(T.remindersDue({ tasks, today: TODAY, hourEt: 23 }).length, 2);
});

test('N2 due today is "due"; past its date is "overdue" and says how late', () => {
  const dueToday = make({ dueDate: TODAY });
  const late = make({ dueDate: '2026-10-10' });
  const yesterday = make({ dueDate: '2026-10-13' });
  const out = T.remindersDue({ tasks: [dueToday, late, yesterday], today: TODAY, hourEt: 9 });
  const byId = new Map(out.map(r => [r.task.id, r]));
  assert.strictEqual(byId.get(dueToday.id).kind, 'due');
  assert.strictEqual(byId.get(dueToday.id).daysLate, 0);
  assert.strictEqual(byId.get(late.id).kind, 'overdue');
  assert.strictEqual(byId.get(late.id).daysLate, 4);
  assert.strictEqual(byId.get(yesterday.id).daysLate, 1);
});

test('N3 a to-do is due OR overdue, never both on one day', () => {
  const out = T.remindersDue({ tasks: [make({ dueDate: TODAY })], today: TODAY, hourEt: 9 });
  assert.strictEqual(out.length, 1, 'two emails about one to-do on one day is the thing the owner capped');
});

test('N4 a closed, cancelled, undated or future to-do is never chased', () => {
  const done = T.applyTaskAction({ task: make({ dueDate: '2026-10-01' }), action: 'done', input: {}, actor: FNP }).task;
  const cancelled = T.applyTaskAction({ task: make({ dueDate: '2026-10-01' }), action: 'cancel', input: { reason: 'no longer needed' }, actor: FNP }).task;
  const undated = make({});
  const later = make({ dueDate: '2026-12-01' });
  // Three days out: INSIDE the 7-day `upcoming` window, which is the case a
  // "later" fixture cannot distinguish. A to-do due Friday is not emailed on
  // Wednesday — it is emailed on Friday.
  const soon = make({ dueDate: '2026-10-17' });
  assert.deepStrictEqual(T.remindersDue({ tasks: [done, cancelled, undated, later, soon], today: TODAY, hourEt: 9 }), []);
  assert.strictEqual(T.bucketFor(soon, TODAY), T.BUCKETS.UPCOMING, 'precondition: otherwise this proves nothing');
  assert.strictEqual(T.bucketFor(done, TODAY), T.BUCKETS.CLOSED, 'precondition: a closed to-do must be bucketed closed');
});

test('N5 the date key is what holds it to one email a task a day', () => {
  const t = make({ dueDate: '2026-10-01' });
  assert.strictEqual(T.reminderKey(t, 'overdue', TODAY), `${t.id}:overdue:${TODAY}`);
  // A new day is a new key, so tomorrow sends again rather than deduping.
  assert.notStrictEqual(T.reminderKey(t, 'overdue', TODAY), T.reminderKey(t, 'overdue', '2026-10-15'));
  // Due and overdue are different keys, so one cannot swallow the other.
  assert.notStrictEqual(T.reminderKey(t, 'due', TODAY), T.reminderKey(t, 'overdue', TODAY));
  // Two to-dos for one person on one day are two emails, not one.
  assert.notStrictEqual(T.reminderKey(make({ dueDate: '2026-10-01' }), 'overdue', TODAY), T.reminderKey(t, 'overdue', TODAY));
});

test('N6 the sweep reads nothing from a clock of its own', () => {
  // Pure: hand it a date and an hour. A module that read the system clock
  // would make every test above depend on what time the suite ran, and would
  // judge Georgia's day in the container's zone.
  const src = strip(fs.readFileSync(path.join(root, 'clinicalTasks.js'), 'utf8'));
  const sweep = src.slice(src.indexOf('const remindersDue ='), src.indexOf('module.exports'));
  assert.ok(!/new Date\(\)/.test(sweep), 'remindersDue must not read the system clock');
  assert.deepStrictEqual(T.remindersDue({ tasks: [make({ dueDate: TODAY })], today: 'not-a-date', hourEt: 9 }), []);
});

// ---------------------------------------------------------------------------
// What the four emails actually say
// ---------------------------------------------------------------------------

const bodyOf = (n) => `${n.subject}\n${n.body}`;

test('N7 on a covered transport each notice names the patient and the to-do, and is marked PHI', async () => {
  const { notify, notices } = harness({ baaCovered: true });
  const t = make({ dueDate: TODAY, assigneeId: RN.id });
  const common = { user: RN, task: t, patientName: 'Juanita Guess', ctaUrl: 'https://app.test.local/clinical#queues' };
  await notify.taskAssigned({ ...common, assignedByName: 'Bethel Godwins' });
  await notify.taskDueToday({ ...common, dedupeId: 'k1' });
  await notify.taskOverdue({ ...common, daysLate: 3, dedupeId: 'k2' });
  await notify.taskCompleted({ user: FNP, task: { ...t, completionNote: 'Spoke to her Tuesday' }, patientName: 'Juanita Guess', completedByName: 'Rita Nurse', ctaUrl: common.ctaUrl });

  assert.strictEqual(notices.length, 4);
  for (const n of notices) {
    assert.ok(n.subject.includes('Juanita Guess'), `${n.type}: a staff notice must be actionable — ${n.subject}`);
    assert.ok(n.body.includes('Juanita Guess'), `${n.type} body names the patient`);
    assert.ok(n.body.includes('Call daughter about PT'), `${n.type} body carries the to-do`);
    assert.strictEqual(n.phi, true, `${n.type} must be marked PHI or it skips the refuse-on-uncovered-transport check`);
    assert.strictEqual(n.relatedEntityType, 'clinical_task');
  }
  // THE TITLE STAYS OUT OF THE SUBJECT: a subject shows on a lock screen.
  for (const n of notices) {
    assert.ok(!n.subject.includes('Call daughter about PT'), `${n.type} subject must not carry the to-do text`);
  }
  const [assigned, due, overdue, completed] = notices;
  assert.match(assigned.body, /Bethel Godwins assigned you a to-do/);
  assert.match(assigned.body, /due Wednesday, October 14/, 'a bare date read as UTC midnight renders a day early in Georgia');
  // `dueLine` reads at midday UTC AND formats in UTC. Either alone is enough,
  // so neither fails on its own — what must hold is that at least one survives.
  const notifSrc = strip(fs.readFileSync(path.join(root, 'notifications.js'), 'utf8'));
  const dl = between(notifSrc, 'const dueLine =', 'async function taskAssigned', 'dueLine');
  assert.ok(/T12:00:00Z/.test(dl) || /timeZone: 'UTC'/.test(dl),
    'drop both and a to-do due today reads as yesterday for every evening in Georgia');
  assert.match(due.body, /due today/i);
  assert.match(overdue.body, /3 days ago/);
  assert.match(completed.body, /Rita Nurse marked your to-do/);
  assert.match(completed.body, /Spoke to her Tuesday/, 'the completion note is why the author wanted telling');
});

test('N8 on an uncovered transport nothing names a patient or a to-do, and nothing is marked PHI', async () => {
  const { notify, notices } = harness({ baaCovered: false });
  const t = make({ dueDate: TODAY, assigneeId: RN.id });
  const common = { user: RN, task: t, patientName: 'Juanita Guess', ctaUrl: 'https://app.test.local/clinical#queues' };
  await notify.taskAssigned({ ...common, assignedByName: 'Bethel Godwins' });
  await notify.taskDueToday({ ...common, dedupeId: 'k1' });
  await notify.taskOverdue({ ...common, daysLate: 3, dedupeId: 'k2' });
  await notify.taskCompleted({ user: FNP, task: { ...t, completionNote: 'Spoke to her Tuesday' }, patientName: 'Juanita Guess', completedByName: 'Rita Nurse', ctaUrl: common.ctaUrl });

  assert.strictEqual(notices.length, 4);
  for (const n of notices) {
    const all = bodyOf(n);
    assert.ok(!all.includes('Juanita Guess'), `${n.type} leaked the patient on an uncovered transport`);
    assert.ok(!all.includes('Call daughter about PT'), `${n.type} leaked the to-do on an uncovered transport`);
    assert.ok(!all.includes('Spoke to her Tuesday'), `${n.type} leaked the completion note`);
    assert.strictEqual(n.phi, false, `${n.type}: the vague wording carries no PHI, so marking it PHI would refuse a safe email`);
    assert.ok(/open the (workspace|app)/i.test(n.body), `${n.type} must still say where to go`);
  }
});

test('N9 a to-do with no patient name on file still sends, vaguely, rather than naming "null"', async () => {
  const { notify, notices } = harness({ baaCovered: true });
  await notify.taskDueToday({ user: RN, task: make({ dueDate: TODAY }), patientName: null, ctaUrl: 'x', dedupeId: 'k' });
  assert.ok(!/null|undefined/.test(bodyOf(notices[0])), notices[0].subject);
  assert.strictEqual(notices[0].phi, false);
});

test('N10 the reminder carries its date key, so the queue holds it to one a day', async () => {
  const { notify, notices } = harness({ baaCovered: true });
  const t = make({ dueDate: '2026-10-01' });
  await notify.taskOverdue({ user: RN, task: t, patientName: 'Juanita Guess', daysLate: 2, ctaUrl: 'x', dedupeId: T.reminderKey(t, 'overdue', TODAY) });
  assert.strictEqual(notices[0].relatedEntityId, `${t.id}:overdue:${TODAY}`,
    'keyed on the task alone, the queue cooldown would be the only thing between a to-do and a send-storm');
});

test('N11 a notice failure is swallowed, never thrown at the route', async () => {
  const notify = createNotifier({
    getUsers: async () => USERS,
    queueNotification: async () => { throw new Error('queue down'); },
    getAppBaseUrl: async () => 'https://app.test.local',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: [], clientRole: 'client', familyRole: 'family'
  });
  const t = make({ dueDate: TODAY });
  for (const fn of ['taskAssigned', 'taskDueToday', 'taskOverdue', 'taskCompleted']) {
    const out = await notify[fn]({ user: RN, task: t, patientName: 'Juanita Guess', ctaUrl: 'x' });
    assert.strictEqual(out.notified, 0, `${fn} must not throw: a written to-do is never undone by a failed email`);
  }
});

// ---------------------------------------------------------------------------
// Who gets told — the `canSee` rule, not a wider one
// ---------------------------------------------------------------------------

// The two event helpers are not exported (requiring server.js boots a
// server), so they are lifted out and RUN against fakes.
const loadEventNotifiers = (calls) => {
  const from = SERVER_SRC.indexOf('const notifyTaskAssigned =');
  const to = SERVER_SRC.indexOf("app.post('/api/clinical/tasks'");
  assert.ok(from !== -1 && to > from, 'could not lift the to-do notifiers out of server.js');
  return new Function('notify', 'getAppBaseUrl', 'appLinks',
    `${SERVER_SRC.slice(from, to)}\nreturn { notifyTaskAssigned, notifyTaskCompleted };`)(
    {
      taskAssigned: async (a) => { calls.push({ fn: 'assigned', to: a.user.id, cta: a.ctaUrl, by: a.assignedByName }); return { notified: 1 }; },
      taskCompleted: async (a) => { calls.push({ fn: 'completed', to: a.user.id, cta: a.ctaUrl, by: a.completedByName }); return { notified: 1 }; }
    },
    async () => 'https://app.test.local', appLinks
  );
};

test('N12 the assignee is told, and never about a to-do they wrote for themselves', async () => {
  const calls = [];
  const { notifyTaskAssigned } = loadEventNotifiers(calls);
  const mine = make({ assigneeId: FNP.id }, FNP);
  assert.strictEqual((await notifyTaskAssigned({ task: mine, actor: FNP, findUser, nameOf })).notified, 0);
  assert.deepStrictEqual(calls, [], 'an email about the to-do you just wrote yourself is noise');

  const theirs = make({ assigneeId: RN.id }, FNP);
  await notifyTaskAssigned({ task: theirs, actor: FNP, findUser, nameOf });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].to, RN.id, 'the assignee, not the author');
  assert.strictEqual(calls[0].by, 'Bethel Godwins');
  assert.strictEqual(calls[0].cta, 'https://app.test.local/clinical#queues');
});

test('N13 the author is told it is finished — not the person who ticked the box', async () => {
  const calls = [];
  const { notifyTaskCompleted } = loadEventNotifiers(calls);
  const t = make({ assigneeId: RN.id }, FNP);
  const done = T.applyTaskAction({ task: t, action: 'done', input: {}, actor: RN }).task;
  await notifyTaskCompleted({ task: done, actor: RN, findUser, nameOf });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].to, FNP.id, 'the author is the person waiting on it');
  assert.strictEqual(calls[0].by, 'Rita Nurse');

  // Finished by its own author: nobody needs telling what they just did.
  calls.length = 0;
  const own = T.applyTaskAction({ task: make({ assigneeId: FNP.id }, FNP), action: 'done', input: {}, actor: FNP }).task;
  assert.strictEqual((await notifyTaskCompleted({ task: own, actor: FNP, findUser, nameOf })).notified, 0);
  assert.deepStrictEqual(calls, []);
});

test('N14 a recipient with no address is skipped, not crashed on', async () => {
  const calls = [];
  const { notifyTaskAssigned } = loadEventNotifiers(calls);
  const noEmail = { id: 'u-x', name: 'No Address', role: 'user', clinicalRole: 'rn' };
  const find = (id) => (id === 'u-x' ? noEmail : findUser(id));
  const t = { ...make({ assigneeId: RN.id }, FNP), assigneeId: 'u-x' };
  assert.strictEqual((await notifyTaskAssigned({ task: t, actor: FNP, findUser: find, nameOf })).notified, 0);
  assert.deepStrictEqual(calls, []);
  // And an assignee who is no longer on the roster at all.
  const gone = { ...t, assigneeId: 'u-deleted' };
  assert.strictEqual((await notifyTaskAssigned({ task: gone, actor: FNP, findUser, nameOf })).notified, 0);
});

test('N15 nobody outside canSee is ever emailed about a to-do', () => {
  const src = strip(SERVER_SRC);
  // Anchored on CODE at both ends: `strip` removes the `//` headings, so a
  // comment anchor would not be there and the slice would run to EOF — which
  // is how a bounded scan quietly stops testing what it names.
  const block = sliceEvents(src) + sliceSweep(src);
  assert.ok(block.length > 400 && block.length < 6000, `slice is ${block.length} chars — an anchor moved`);
  // The only two recipients a to-do notice may resolve are its assignee and
  // its author — the two `canSee` allows. A staff broadcast here would hand
  // out by push exactly what the read gate refuses.
  assert.ok(!/staffRecipients|ENROLLMENT_STAFF_ROLES|ROLES\.ADMIN/.test(block), 'a to-do notice must never fan out to staff');
  const lookups = block.match(/findUser\((task\.assigneeId|task\.createdById)\)/g) || [];
  assert.strictEqual(lookups.length, 3, `only assignee/author lookups, got ${JSON.stringify(lookups)}`);
});

// ---------------------------------------------------------------------------
// The wiring — a notice nobody calls is a notice nobody gets
// ---------------------------------------------------------------------------

test('N16 the routes call the notifiers, unconditionally', () => {
  const src = strip(SERVER_SRC);
  // Anchored on a newline + await so a call wrapped in `if (false)` cannot
  // pass. A source scan cannot prove a line is REACHED; this is the shape
  // that at least distinguishes a statement from a guarded call.
  // BOTH routes carry the identical call, so matching once proves nothing
  // about either: count them, and pin the create route's own by slicing it.
  const assignedCalls = src.match(/await notifyTaskAssigned\(\{ task, actor, findUser, nameOf \}\);/g) || [];
  assert.strictEqual(assignedCalls.length, 2, 'one call in the create route, one in the reassign branch');
  const createRoute = between(src, "app.post('/api/clinical/tasks'", "app.put('/api/clinical/tasks/:taskId'", 'create route');
  assert.ok(/\n\s*await notifyTaskAssigned\(\{ task, actor, findUser, nameOf \}\);/.test(createRoute),
    'the create route must tell the assignee');
  assert.ok(/action === 'edit' && changed\.includes\('assigneeId'\)[\s\S]{0,200}await notifyTaskAssigned/.test(src),
    'handing a to-do to somebody new is the same event as handing them one');
  assert.ok(/action === 'done'\) await notifyTaskCompleted/.test(src),
    'the author must hear when it is finished');
  assert.ok(/\n\s*await sendDueTaskReminders\(\);/.test(src),
    'the sweep must ride the scanner that already runs');
});

test('N17 the update route compares against a snapshot, not the live row', () => {
  const src = strip(SERVER_SRC);
  const i = src.indexOf("app.put('/api/clinical/tasks/:taskId'");
  const block = src.slice(i, i + 2200);
  assert.ok(/const before = rows\[idx\];/.test(block) && /applyTaskAction\(\{ task: before,/.test(block),
    'aliasing the live row is how the shift editor printed the NEW time as the old one');
});

test('N18 the sweep judges the day and the hour in Georgia, never the container', () => {
  const src = strip(SERVER_SRC);
  const block = sliceSweep(src);
  assert.ok(/practiceTime\.zonedParts\(new Date\(\)\)/.test(block),
    'UTC is already tomorrow for four hours of every evening');
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(block), 'that is the UTC day, not Georgia\'s');
  assert.ok(/reminderKey\(task, kind, today\)/.test(block), 'the daily cap rides the date key');
  assert.ok(/findUser\(task\.assigneeId\)/.test(block) && !/task\.createdById/.test(block),
    'the sweep chases the assignee only; the author hears at completion');
});

test('N19 the email points at Tasks, and the page honours that fragment', () => {
  assert.strictEqual(appLinks.tasksFor(), '/clinical#queues');
  assert.strictEqual(appLinks.routeOf(appLinks.tasksFor()), '/clinical', 'the sweep requests this path and expects a 200');
  assert.ok(appLinks.ALL_PATHS.includes('/clinical#queues'), 'a destination outside ALL_PATHS is never swept');
  // `queues` is the Tasks view's own key, and the page must resolve it.
  assert.match(PAGE, /\{ key: 'queues', tab: 'Tasks'/);
  assert.match(PAGE, /NAV_VIEWS\.some\(v => v\.key === h\) \? h : 'myday'/,
    'only #inbox used to work, so #queues would have landed on My Day');
  // An unknown fragment still falls back rather than rendering a dead tab.
  const pick = (h) => (['myday', 'charts', 'inbox', 'queues'].includes(h) ? h : 'myday');
  assert.strictEqual(pick('queues'), 'queues');
  assert.strictEqual(pick('nonsense'), 'myday');
});

test('N20 no to-do notice is hand-rolled outside notifications.js', () => {
  const src = strip(SERVER_SRC);
  const block = sliceEvents(src) + sliceSweep(src);
  assert.ok(!/queueNotification\(/.test(block) && !/sendEmail\(/.test(block),
    'branding, the unsubscribe honour and the transport rule all live in the notifier');
});
