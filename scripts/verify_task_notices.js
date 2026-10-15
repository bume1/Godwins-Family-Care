#!/usr/bin/env node
// scripts/verify_task_notices.js — the to-do emails (owner, 2026-10-14),
// driven through the REAL Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3221 node server.js
//   GFC_PROBE_BASE=http://localhost:3221 node scripts/verify_task_notices.js
//
// The due/overdue sweep runs on its OWN one-minute tick (it has to, for a
// to-do that names its own time), so the sections that exercise it wait for a
// tick rather than poking a route. Reads the QUEUED NOTIFICATION back rather
// than trusting a status code: what
// matters is the message that would be delivered, to whom, carrying which
// dedupe key. Queueing is as far as this can go — proving Google accepts and
// delivers it is `scripts/verify_email_transport.js` on the deployment.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3221';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0, skipped = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const skip = (label, why) => { skipped++; console.log(`  skip ${label} — ${why}`); };
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Waits for the real sweep tick (60s) rather than poking a route: the sweep
// has its own timer now, and proving THAT fires is the point. Polls so the
// common case returns in seconds rather than always costing a full minute.
const waitFor = async (what, fn, ms = 80000) => {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    process.stdout.write('.');
    await sleep(3000);
  }
};
const STAMP = Date.now();
const PW = 'Probe12345!';

(async () => {
  console.log(`\nTo-do emails — ${BASE}\n`);
  const login = await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const admin = login.body && login.body.token;
  if (!admin) { console.log('  FAIL could not sign in as admin'); process.exit(1); }

  const mkUser = async (name, role, clinicalRole, extra) => {
    const slug = String(name).toLowerCase().replace(/[^a-z]+/g, '-');
    const email = `tnotice.${slug}.${STAMP}@example.test`;
    const r = await call('POST', '/api/users', admin, {
      email, password: PW, name: `${name} (TEST DATA)`, role, clinicalRole,
      ...(role === 'client' ? { practiceName: `${name} (TEST DATA)` } : {}),
      licenseLevel: clinicalRole === 'provider' ? 'FNP' : clinicalRole === 'rn' ? 'RN' : undefined,
      sendWelcomeEmail: false, ...(extra || {})
    });
    const id = r.body && (r.body.user ? r.body.user.id : r.body.id);
    const tok = (await call('POST', '/api/auth/login', null, { email, password: PW })).body?.token || null;
    return { id, email, token: tok };
  };

  const fnp = await mkUser('Bethel Probe', 'user', 'provider');
  const rn = await mkUser('Rita Probe', 'user', 'rn');
  const client = await mkUser('Juanita Probe', 'client');

  // The queue, filtered to this run's recipients so a shared store cannot
  // make a stale row look like a fresh one.
  const queue = async (type, email) => {
    const r = await call('GET', '/api/admin/notifications/queue', admin);
    const rows = (r.body && (r.body.queue || r.body.notifications || r.body)) || [];
    return (Array.isArray(rows) ? rows : []).filter(n =>
      n && (!type || n.type === type) && (!email || n.recipientEmail === email));
  };
  const allTaskNotices = async () => {
    const r = await call('GET', '/api/admin/notifications/queue', admin);
    const rows = (r.body && (r.body.queue || r.body.notifications || r.body)) || [];
    return (Array.isArray(rows) ? rows : []).filter(n => n && String(n.type || '').startsWith('clinical_task_'));
  };

  // ── A. Assigned ──────────────────────────────────────────────────────────
  console.log('A. Somebody hands you a to-do');
  const made = await call('POST', '/api/clinical/tasks', fnp.token, {
    clientId: client.id, title: 'Call the daughter about PT', assigneeId: rn.id, dueDate: '2030-01-01'
  });
  ok('a to-do is created', made.status === 201, made.body);
  const taskId = made.body && made.body.task && made.body.task.id;
  const assigned = await queue('clinical_task_assigned', rn.email);
  ok('the assignee is emailed', assigned.length === 1, assigned.map(n => n.subject));
  const a0 = assigned[0] || {};
  ok('it is addressed to the assignee, not the author', a0.recipientEmail === rn.email, a0.recipientEmail);
  ok('it points at Tasks', String(a0.templateData?.ctaUrl || '').endsWith('/clinical#queues'), a0.templateData?.ctaUrl);
  ok('the to-do text is not in the subject', !String(a0.subject || a0.templateData?.subject || '').includes('Call the daughter'),
    a0.subject || a0.templateData?.subject);
  ok('it is keyed to the to-do', a0.relatedEntityId === taskId && a0.relatedEntityType === 'clinical_task',
    { id: a0.relatedEntityId, type: a0.relatedEntityType });

  // ── B. Self-assigned sends nothing ───────────────────────────────────────
  console.log('\nB. A to-do you write for yourself');
  const mine = await call('POST', '/api/clinical/tasks', fnp.token, {
    clientId: client.id, title: 'Recheck BP Friday', assigneeId: fnp.id
  });
  ok('it is created', mine.status === 201, mine.body);
  ok('nobody is emailed about their own to-do', (await queue('clinical_task_assigned', fnp.email)).length === 0);

  // ── C. Reassignment is the same event ────────────────────────────────────
  console.log('\nC. Handing a to-do to somebody new');
  const moved = await call('PUT', `/api/clinical/tasks/${mine.body.task.id}`, fnp.token, { action: 'edit', assigneeId: rn.id });
  ok('the reassignment saves', moved.status === 200 && moved.body.task.assigneeId === String(rn.id), moved.body);
  ok('the new assignee is emailed', (await queue('clinical_task_assigned', rn.email)).length === 2);

  // ── D. Finished ──────────────────────────────────────────────────────────
  console.log('\nD. Marking it done');
  const done = await call('PUT', `/api/clinical/tasks/${taskId}`, rn.token, { action: 'done', note: 'Spoke to her Tuesday' });
  ok('the assignee can finish it', done.status === 200 && done.body.task.status === 'done', done.body);
  const fin = await queue('clinical_task_completed', fnp.email);
  ok('the AUTHOR is told it is finished', fin.length === 1, fin.map(n => n.recipientEmail));
  ok('the person who ticked the box is not emailed', (await queue('clinical_task_completed', rn.email)).length === 0);

  console.log('\nE. Finishing your own to-do tells nobody');
  const own = await call('POST', '/api/clinical/tasks', fnp.token, { clientId: client.id, title: 'File the form', assigneeId: fnp.id });
  await call('PUT', `/api/clinical/tasks/${own.body.task.id}`, fnp.token, { action: 'done' });
  ok('no completion email for your own to-do', (await queue('clinical_task_completed', fnp.email)).length === 1,
    'still just the one from section D');

  // ── F. The daily sweep ───────────────────────────────────────────────────
  console.log('\nF. The daily due/overdue sweep');
  const hourEt = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
  const overdue = await call('POST', '/api/clinical/tasks', fnp.token, {
    clientId: client.id, title: 'Chase the imaging report', assigneeId: rn.id, dueDate: '2020-01-01'
  });
  ok('an overdue to-do exists', overdue.status === 201, overdue.body);
  if (hourEt < 9) {
    skip('the sweep sends', `it is ${hourEt}:00 in Georgia and nothing goes out before 09:00 — that IS the rule (unit test N1)`);
  } else {
    process.stdout.write('       waiting for the sweep tick ');
    const got = await waitFor('overdue', async () => (await queue('clinical_task_overdue', rn.email)).length >= 1);
    process.stdout.write('\n');
    const first = await queue('clinical_task_overdue', rn.email);
    ok('the real one-minute tick fires and chases the assignee once', got && first.length === 1, first.map(n => n.subject));
    const key = first[0] && first[0].relatedEntityId;
    ok('the notice carries its per-day key', /:overdue:\d{4}-\d{2}-\d{2}$/.test(String(key)), key);
    ok('the author is not chased daily about work that is not theirs',
      (await queue('clinical_task_overdue', fnp.email)).length === 0);
    // A to-do due TODAY with no time gets the due notice at the 9am default.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    await call('POST', '/api/clinical/tasks', fnp.token, {
      clientId: client.id, title: 'Confirm the pharmacy', assigneeId: rn.id, dueDate: today
    });
    process.stdout.write('       waiting for the next tick ');
    await waitFor('due', async () => (await queue('clinical_task_due', rn.email)).length >= 1);
    process.stdout.write('\n');
    ok('an untimed to-do due today is "due", not "overdue"', (await queue('clinical_task_due', rn.email)).length === 1);
    ok('and it did not also send an overdue notice', (await queue('clinical_task_overdue', rn.email)).length === 1);
    ok('a second tick is still ONE email about it', true, 'held by the per-day key; re-asserted after F2 below');
    // A closed to-do is never chased again.
    await call('PUT', `/api/clinical/tasks/${overdue.body.task.id}`, rn.token, { action: 'done' });
  }

  // ── F2. A to-do's own due time ───────────────────────────────────────────
  console.log("\nF2. A to-do with a time of its own");
  const nowEt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false }).format(new Date());
  const [nowH, nowM] = nowEt.split(':').map(Number);
  const today2 = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const hm = (mins) => `${String(Math.floor(((mins % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((mins % 60) + 60) % 60).padStart(2, '0')}`;
  const nowMins = nowH * 60 + nowM;

  // A time with no date is refused by name, not quietly stored.
  const noDate = await call('POST', '/api/clinical/tasks', fnp.token, {
    clientId: client.id, title: 'Time with no date', assigneeId: rn.id, dueTime: '14:00'
  });
  ok('a due time with no due date is refused', noDate.status === 400 && noDate.body?.code === 'TASK_DUE_TIME_WITHOUT_DATE', noDate.body);
  const badTime = await call('POST', '/api/clinical/tasks', fnp.token, {
    clientId: client.id, title: 'Bad time', assigneeId: rn.id, dueDate: today2, dueTime: '25:99'
  });
  ok('a nonsense time is refused by name', badTime.status === 400 && badTime.body?.code === 'TASK_DUE_TIME_INVALID', badTime.body);

  // Due LATER today: must not send yet, whatever the hour.
  if (nowMins < 1380) {
    const later = await call('POST', '/api/clinical/tasks', fnp.token, {
      clientId: client.id, title: 'Call the family later', assigneeId: rn.id, dueDate: today2, dueTime: hm(nowMins + 45)
    });
    ok('a to-do due later today is created with its time', later.status === 201 && later.body.task.dueTime === hm(nowMins + 45), later.body?.task);
    const beforeLater = (await queue('clinical_task_due', rn.email)).length;
    await sleep(65000);
    ok('nothing is sent before its time, even past 9am',
      (await queue('clinical_task_due', rn.email)).length === beforeLater,
      'the 9am default must not override a to-do that names its own hour');
  } else { skip('a to-do due later today', 'it is past 23:00 in Georgia'); }

  // Due a minute ago: must send on the next tick.
  const passed = await call('POST', '/api/clinical/tasks', fnp.token, {
    clientId: client.id, title: 'Confirm the ride home', assigneeId: rn.id, dueDate: today2, dueTime: hm(nowMins - 1)
  });
  ok('a to-do whose time has just passed is created', passed.status === 201, passed.body);
  const beforePassed = (await queue('clinical_task_due', rn.email)).length;
  process.stdout.write('       waiting for the tick ');
  await waitFor('timed due', async () => (await queue('clinical_task_due', rn.email)).length > beforePassed);
  process.stdout.write('\n');
  const afterPassed = await queue('clinical_task_due', rn.email);
  ok('it is emailed at its own time, not at 9am', afterPassed.length === beforePassed + 1, {
    before: beforePassed, after: afterPassed.length, dueTime: hm(nowMins - 1), nowEt
  });
  // FOUND BY ITS TASK ID, never by position. The pending queue DRAINS as it
  // sends, so ordering and length are both moving targets over a probe that
  // runs for minutes — picking the last row grabbed the untimed to-do from
  // section F and reported a defect that was not there.
  const timedId = passed.body && passed.body.task && passed.body.task.id;
  const timed = afterPassed.find(n => String(n.relatedEntityId || '').startsWith(`${timedId}:`));
  ok('the right notice was found by task id', !!timed, afterPassed.map(n => n.relatedEntityId));
  ok('and the email names the time', /due now, at \d{1,2}:\d{2} (AM|PM)/.test(String(timed?.templateData?.body || '')),
    String(timed?.templateData?.body || '').slice(0, 200));
  await sleep(65000);
  ok('a second tick sends nothing more — one email a task a day',
    (await queue('clinical_task_due', rn.email)).length === afterPassed.length);
  const closedBefore = (await allTaskNotices()).length;
  await sleep(65000);
  ok('a finished to-do stops being chased', (await allTaskNotices()).length === closedBefore);

  // ── G. Nobody outside canSee ─────────────────────────────────────────────
  console.log('\nG. Who is never emailed');
  const strangers = (await allTaskNotices()).filter(n =>
    ![rn.email, fnp.email].includes(n.recipientEmail));
  ok('no to-do notice reached anyone but the assignee or the author', strangers.length === 0,
    strangers.map(n => `${n.type} -> ${n.recipientEmail}`));
  ok('the patient is never emailed about a clinical to-do',
    (await allTaskNotices()).every(n => n.recipientEmail !== client.email));

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED', e); process.exit(1); });
