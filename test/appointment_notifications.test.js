// Booking, moving or cancelling a clinical visit used to tell the patient
// nothing at all, and the portal's "Upcoming visits" card read a collection
// that only receives rows AFTER a visit — so a client with three confirmed
// shifts this week saw an empty card and no email. Both fixed here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createNotifier } = require('../notifications');

const CLIENT = { id: 'c1', role: 'client', name: 'Ada Bell', email: 'ada@example.com', slug: 'ada' };
const POA = { id: 'f1', role: 'family', name: 'Joe Bell', email: 'joe@example.com', familyOfClientId: 'c1', familyIsPoa: true };
const PLAIN_FAMILY = { id: 'f2', role: 'family', name: 'Kim Bell', email: 'kim@example.com', familyOfClientId: 'c1' };

function harness({ baaCovered = true, transportThrows = false } = {}) {
  const queued = [];
  const notifier = createNotifier({
    getUsers: async () => [CLIENT, POA, PLAIN_FAMILY],
    queueNotification: async (type, userId, email, name, content, opts) => {
      queued.push({ type, userId, email, ...content, ...opts });
      return { id: `n${queued.length}` };
    },
    getAppBaseUrl: async () => 'https://app.godwinsfamilycarellc.com',
    emailTransport: {
      transportStatus: () => {
        if (transportThrows) throw new Error('transport unreadable');
        return { baaCovered };
      }
    },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  return { notifier, queued };
}

const BOOKING = { client: CLIENT, eid: '55', when: 'Tuesday, September 16 at 2:00 PM', clinician: 'Bethel Godwins, FNP', place: 'Your home', actorId: 'u9' };

test('a booking reaches the client and a designated POA, and nobody else', async () => {
  const { notifier, queued } = harness();
  const r = await notifier.appointmentBooked(BOOKING);
  assert.strictEqual(r.notified, 2);
  const to = queued.map(q => q.email).sort();
  assert.deepStrictEqual(to, ['ada@example.com', 'joe@example.com']);
  // Non-POA family are ROI- and sharing-gated at READ time. Email is a push
  // channel where neither gate can be re-checked once the message is out.
  assert.ok(!to.includes('kim@example.com'), 'non-POA family must not be emailed');
});

test('on a covered transport the visit details are IN the email', async () => {
  const { notifier, queued } = harness({ baaCovered: true });
  await notifier.appointmentBooked(BOOKING);
  const m = queued[0];
  assert.match(m.subject, /Tuesday, September 16 at 2:00 PM/);
  assert.match(m.htmlBody, /Tuesday, September 16 at 2:00 PM/);
  assert.match(m.htmlBody, /Bethel Godwins, FNP/);
  assert.match(m.htmlBody, /Your home/);
  assert.strictEqual(m.phi, true, 'a visit date and clinician is PHI and must be marked');
});

test('on an uncovered transport the email says a visit exists and nothing else', async () => {
  const { notifier, queued } = harness({ baaCovered: false });
  await notifier.appointmentBooked(BOOKING);
  const m = queued[0];
  assert.ok(!m.subject.includes('September 16'), 'the date must not reach the subject line');
  assert.ok(!m.htmlBody.includes('September 16'), 'the date must not reach the body');
  assert.ok(!m.htmlBody.includes('Bethel'), 'the clinician must not be named');
  assert.match(m.htmlBody, /secure portal/, 'it must still say where to look');
});

test('an unreadable transport is treated as NOT covered', async () => {
  // Guessing the permissive way here puts PHI in an inbox on the strength of
  // a failed lookup.
  const { notifier, queued } = harness({ transportThrows: true });
  await notifier.appointmentBooked(BOOKING);
  assert.ok(!queued[0].htmlBody.includes('September 16'), 'a failed transport read must not unlock detail');
});

test('a reschedule names both the old time and the new one', async () => {
  const { notifier, queued } = harness();
  await notifier.appointmentRescheduled({
    client: CLIENT, eid: '56',
    from: 'Tuesday, September 16 at 2:00 PM', to: 'Thursday, September 18 at 10:00 AM',
    clinician: 'Bethel Godwins, FNP', place: 'Your home', actorId: 'u9'
  });
  const m = queued[0];
  assert.match(m.htmlBody, /September 16 at 2:00 PM/, 'the old time tells them what moved');
  assert.match(m.htmlBody, /September 18 at 10:00 AM/, 'the new time is the point of the email');
});

test('a cancellation carries its reason only where the transport can hold it', async () => {
  const covered = harness({ baaCovered: true });
  await covered.notifier.appointmentCancelled({
    client: CLIENT, eid: '57', when: 'Tuesday, September 16 at 2:00 PM',
    reason: 'Clinician called to an urgent visit', clinician: 'Bethel Godwins, FNP', actorId: 'u9'
  });
  assert.match(covered.queued[0].htmlBody, /Clinician called to an urgent visit/);

  const bare = harness({ baaCovered: false });
  await bare.notifier.appointmentCancelled({
    client: CLIENT, eid: '57', when: 'Tuesday, September 16 at 2:00 PM',
    reason: 'Clinician called to an urgent visit', clinician: 'Bethel Godwins, FNP', actorId: 'u9'
  });
  assert.ok(!bare.queued[0].htmlBody.includes('urgent visit'), 'staff free text must not ride an uncovered transport');
});

test("the POA's copy says whose visit it is; the client's does not", async () => {
  const { notifier, queued } = harness();
  await notifier.appointmentBooked(BOOKING);
  const toClient = queued.find(q => q.email === 'ada@example.com');
  const toPoa = queued.find(q => q.email === 'joe@example.com');
  assert.match(toClient.htmlBody, /Your visit is booked/, 'the client is not told their own name');
  assert.match(toPoa.htmlBody, /Ada Bell&#39;s visit is booked|Ada Bell's visit is booked/,
    'a POA acts for someone and must be told for whom');
});

test('a client with no email on file is a reported skip, not a crash', async () => {
  const notifier = createNotifier({
    getUsers: async () => [{ id: 'c1', role: 'client', name: 'Ada Bell' }],
    queueNotification: async () => ({ id: 'n1' }),
    getAppBaseUrl: async () => 'https://app.godwinsfamilycarellc.com',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  const r = await notifier.appointmentBooked(BOOKING);
  assert.strictEqual(r.notified, 0);
  assert.match(r.reason, /no email address/);
});

// ---- the portal's Upcoming visits card ------------------------------------

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// getClientVisits is not exported (requiring server.js boots a server), so it
// is lifted out and run against fakes — the same technique the welcome-email
// and announcement-migration guards use.
function loadGetClientVisits({ visitLogs = [], shifts = [], users = [] }) {
  const from = SERVER_SRC.indexOf('const DAY_NAMES =');
  const to = SERVER_SRC.indexOf('// The interim message shaper lived here');
  assert.ok(from !== -1 && to > from, 'could not lift getClientVisits out of server.js');
  const db = { get: async (k) => (k === 'visit_logs' ? visitLogs : k === 'shifts' ? shifts : null) };
  return new Function('db', 'getUsers', `${SERVER_SRC.slice(from, to)}\nreturn getClientVisits;`)(
    db, async () => users
  );
}

const future = new Date(Date.now() + 3 * 86400000).toISOString();
const past = new Date(Date.now() - 3 * 86400000).toISOString();

test('a confirmed shift shows up as an upcoming visit', async () => {
  const get = loadGetClientVisits({
    shifts: [{ id: 's1', clientId: 'c1', status: 'confirmed', start: future, caregiverId: 'cg1' }],
    users: [{ id: 'cg1', name: 'Rosa Diaz' }]
  });
  const { upcoming } = await get({ id: 'c1' });
  assert.strictEqual(upcoming.length, 1, 'the whole point: a confirmed shift must appear');
  assert.strictEqual(upcoming[0].with, 'Rosa Diaz');
  assert.strictEqual(upcoming[0].type, 'Home care visit');
});

test('a shift nobody has agreed to yet is NOT shown', async () => {
  // open/claimed/assigned can still be declined. Showing one promises a visit
  // that may never happen.
  for (const status of ['open', 'claimed', 'assigned']) {
    const get = loadGetClientVisits({
      shifts: [{ id: 's1', clientId: 'c1', status, start: future, caregiverId: 'cg1' }],
      users: [{ id: 'cg1', name: 'Rosa Diaz' }]
    });
    const { upcoming } = await get({ id: 'c1' });
    assert.strictEqual(upcoming.length, 0, `a ${status} shift must not be shown to the client`);
  }
});

test('another client\'s shift never appears', async () => {
  const get = loadGetClientVisits({
    shifts: [{ id: 's1', clientId: 'c2', status: 'confirmed', start: future, caregiverId: 'cg1' }],
    users: [{ id: 'cg1', name: 'Rosa Diaz' }]
  });
  const { upcoming } = await get({ id: 'c1' });
  assert.strictEqual(upcoming.length, 0);
});

test('an unnamed caregiver reads as the care team, not as blank', async () => {
  const get = loadGetClientVisits({
    shifts: [{ id: 's1', clientId: 'c1', status: 'confirmed', start: future, caregiverId: 'ghost' }],
    users: []
  });
  const { upcoming } = await get({ id: 'c1' });
  assert.strictEqual(upcoming[0].with, 'Your care team');
});

test('recent visits still come from the documented log, not the shift board', async () => {
  // A completed shift carries no id linking it to its visit log, so counting
  // both would show every past visit twice.
  const get = loadGetClientVisits({
    visitLogs: [{ id: 'v1', client_id: 'c1', status: 'completed', scheduledAt: past, caregiverName: 'Rosa Diaz' }],
    shifts: [{ id: 's1', clientId: 'c1', status: 'completed', start: past, caregiverId: 'cg1' }],
    users: [{ id: 'cg1', name: 'Rosa Diaz' }]
  });
  const { recent } = await get({ id: 'c1' });
  assert.strictEqual(recent.length, 1, 'the visit must be listed once, from the log');
  assert.strictEqual(recent[0].id, 'v1');
});

test('shifts and visit logs share one ordered list', async () => {
  const soon = new Date(Date.now() + 86400000).toISOString();
  const later = new Date(Date.now() + 5 * 86400000).toISOString();
  const get = loadGetClientVisits({
    visitLogs: [{ id: 'v1', client_id: 'c1', status: 'scheduled', scheduledAt: later }],
    shifts: [{ id: 's1', clientId: 'c1', status: 'confirmed', start: soon, caregiverId: 'cg1' }],
    users: [{ id: 'cg1', name: 'Rosa Diaz' }]
  });
  const { upcoming } = await get({ id: 'c1' });
  assert.deepStrictEqual(upcoming.map(u => u.id), ['shift:s1', 'v1'], 'soonest first, whichever source it came from');
});
