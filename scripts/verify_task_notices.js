#!/usr/bin/env node
// scripts/verify_task_notices.js — the to-do emails (owner, 2026-10-14),
// driven through the REAL Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3221 node server.js
//   GFC_PROBE_BASE=http://localhost:3221 node scripts/verify_task_notices.js
//
// Reads the QUEUED NOTIFICATION back rather than trusting a status code: what
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
    await call('POST', '/api/admin/reminders/trigger', admin);
    const first = await queue('clinical_task_overdue', rn.email);
    ok('the assignee is chased once', first.length === 1, first.map(n => n.subject));
    const key = first[0] && first[0].relatedEntityId;
    ok('the notice carries its per-day key', /:overdue:\d{4}-\d{2}-\d{2}$/.test(String(key)), key);
    await call('POST', '/api/admin/reminders/trigger', admin);
    await call('POST', '/api/admin/reminders/trigger', admin);
    ok('three scans in one day is still ONE email', (await queue('clinical_task_overdue', rn.email)).length === 1,
      'the owner asked for one email about a task a day');
    ok('the author is not chased daily about work that is not theirs',
      (await queue('clinical_task_overdue', fnp.email)).length === 0);
    // A to-do due TODAY gets the due notice, not the overdue one.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    await call('POST', '/api/clinical/tasks', fnp.token, {
      clientId: client.id, title: 'Confirm the pharmacy', assigneeId: rn.id, dueDate: today
    });
    await call('POST', '/api/admin/reminders/trigger', admin);
    ok('a to-do due today is "due", not "overdue"', (await queue('clinical_task_due', rn.email)).length === 1);
    ok('and it did not also send an overdue notice', (await queue('clinical_task_overdue', rn.email)).length === 1);
    // A closed to-do is never chased again.
    await call('PUT', `/api/clinical/tasks/${overdue.body.task.id}`, rn.token, { action: 'done' });
    const before = (await allTaskNotices()).length;
    await call('POST', '/api/admin/reminders/trigger', admin);
    ok('a finished to-do stops being chased', (await allTaskNotices()).length === before + 0,
      'no new reminder after it was closed');
  }

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
