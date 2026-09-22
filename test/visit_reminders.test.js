// ============================================================================
// Session 4.11 — the day-before visit reminder, and a "Who" line a patient
// understands
//
// TWO GAPS. A patient got one email when a visit was booked and nothing after —
// and for a home-visit practice a forgotten visit is a wasted drive and a lost
// slot. And the "Who" line rendered `name, licenseLevel`, which assumed the
// patient knew what "FNP" meant and said nothing at all when the field was blank.
//
// ⚠️ THE CONSTRAINT THAT DECIDES THE DESIGN, pinned here so a later session does
// not "fix" it: per-clinician OpenEMR auth means A BACKGROUND JOB CANNOT READ THE
// CALENDAR. The reminder is captured at WRITE time and renders from snapshot
// strings. Adding a service identity to get around that reverses a HIPAA-gate
// decision.
//
// What this file pins:
//   1. sendAt is 9:00 AM EASTERN on the calendar day before — across the DST
//      boundary, which an offset would get wrong.
//   2. A send time already past creates NO reminder.
//   3. Reschedule voids the OLD eid and creates on the NEW one. Cancel voids.
//   4. A due reminder sends once; a second scan is a no-op; more than 12 hours
//      past is VOIDED, not sent late.
//   5. BOTH copy variants begin with "Your visit" — that is the mechanism
//      sendToClientSide uses to say "{Name}'s visit" to a POA.
//   6. The vague version carries no date, name or place anywhere.
//   7. visitClinicianLabel across the credentials, and an unrecognised one gets
//      the name alone. NEVER GUESS A ROLE.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// DELIBERATELY UTC. The whole point of the Eastern rules below is that they hold
// whatever the server's clock says, so running these under Eastern would prove
// nothing about them (brief §8).
process.env.TZ = 'UTC';

const reminders = require('../visitReminders');
const { createNotifier } = require('../notifications');
const consentText = require('../public/consent-text');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CODE = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SERVER_CODE = CODE(read('server.js'));

// ══════════════════════════════════════════════════════════════════════════
// A1 / A2 — when it sends
// ══════════════════════════════════════════════════════════════════════════

test('A2: sendAt is 9:00 AM EASTERN on the calendar day before, with the process in UTC', () => {
  assert.equal(process.env.TZ, 'UTC', 'this test is only meaningful with the server clock NOT in Eastern');
  assert.equal(reminders.REMINDER_SEND_HOUR_ET, 9);
  // September: Eastern is UTC-4, so 9 AM ET is 13:00Z.
  assert.equal(reminders.reminderSendAt('2026-09-25'), '2026-09-24T13:00:00.000Z');
  // A Monday visit is reminded Sunday. 2026-09-28 is a Monday.
  const sunday = reminders.reminderSendAt('2026-09-28');
  assert.equal(sunday, '2026-09-27T13:00:00.000Z');
  assert.equal(new Date(sunday).getUTCDay(), 0, 'Sunday');
});

test('A2: it holds ACROSS THE DST BOUNDARY, which a fixed offset would get wrong', () => {
  // US Eastern leaves daylight time on 2026-11-01. A visit on 2026-11-02 is
  // reminded on the 1st at 9 AM EST = 14:00Z; a visit on 2026-10-30 is reminded
  // on the 29th at 9 AM EDT = 13:00Z. SUBTRACTING 24 HOURS FROM THE VISIT, or
  // hardcoding -04:00, gives the wrong instant for one of these — which is the
  // bug the shift-offer email shipped with in September.
  assert.equal(reminders.reminderSendAt('2026-10-30'), '2026-10-29T13:00:00.000Z');
  assert.equal(reminders.reminderSendAt('2026-11-02'), '2026-11-01T14:00:00.000Z');
  // And across a month boundary, and a year boundary.
  assert.equal(reminders.reminderSendAt('2026-11-01'), '2026-10-31T13:00:00.000Z');
  assert.equal(reminders.reminderSendAt('2027-01-01'), '2026-12-31T14:00:00.000Z');
});

test('A2: an unusable visit date yields no reminder rather than a wrong one', () => {
  for (const bad of ['', null, 'tomorrow', '2026-9-5', '2026-13-40']) {
    const out = reminders.buildVisitReminder({ id: 'r', clientId: 'c', eid: '1', visitDate: bad });
    assert.ok(out.skipped, `refused: ${JSON.stringify(bad)}`);
  }
  // `new Date(null)` is the EPOCH, not an invalid date — the trap that once
  // printed "12/31/1969, 7:00 PM" to a caregiver. Empties are rejected before any
  // Date is constructed.
  assert.equal(reminders.reminderSendAt(null), null);
  assert.equal(reminders.reminderSendAt(undefined), null);
});

test('A1: the row snapshots the display strings, so nothing has to read OpenEMR to send it', () => {
  const { reminder } = reminders.buildVisitReminder({
    id: 'r1', clientId: 'c1', eid: '77', visitDate: '2026-09-25', startTime: '09:00',
    when: 'Friday, September 25 at 9:00 AM', clinician: 'Bethel Godwins, FNP — your nurse practitioner',
    place: 'Your home', now: '2026-09-20T12:00:00.000Z'
  });
  assert.equal(reminder.eid, '77');
  assert.equal(reminder.status, 'scheduled');
  assert.equal(reminder.sendAt, '2026-09-24T13:00:00.000Z');
  assert.equal(reminder.when, 'Friday, September 25 at 9:00 AM');
  assert.equal(reminder.clinician, 'Bethel Godwins, FNP — your nurse practitioner');
  assert.equal(reminder.place, 'Your home');
  assert.equal(reminder.sentAt, null);
  assert.equal(reminder.voidReason, null);
  // THE SNAPSHOT IS THE POINT: a reminder that had to re-read the calendar is a
  // reminder no background job can send under per-clinician auth.
  assert.ok(!('providerId' in reminder), 'nothing that would require a calendar read');
});

test('A2: a send time already past creates NO reminder — the booking email just went out', () => {
  // Booked at 7 PM today for tomorrow at 8 AM. The 9 AM reminder slot was this
  // morning, so a "reminder" now would arrive minutes after the booking notice.
  const lateBooking = reminders.buildVisitReminder({
    id: 'r', clientId: 'c', eid: '1', visitDate: '2026-09-23',
    now: '2026-09-22T23:00:00.000Z'   // 7 PM ET on the 22nd
  });
  assert.ok(lateBooking.skipped);
  assert.match(lateBooking.reason, /already past/);
  // Booked the SAME day: also nothing.
  assert.ok(reminders.buildVisitReminder({ id: 'r', clientId: 'c', eid: '1', visitDate: '2026-09-22', now: '2026-09-22T12:00:00.000Z' }).skipped);
  // But three days out creates exactly one.
  const ok = reminders.buildVisitReminder({ id: 'r', clientId: 'c', eid: '1', visitDate: '2026-09-25', now: '2026-09-22T12:00:00.000Z' });
  assert.ok(ok.reminder, 'three days out creates a reminder');
  // The boundary: one minute BEFORE the send instant still creates one.
  assert.ok(reminders.buildVisitReminder({ id: 'r', clientId: 'c', eid: '1', visitDate: '2026-09-25', now: '2026-09-24T12:59:00.000Z' }).reminder);
  assert.ok(reminders.buildVisitReminder({ id: 'r', clientId: 'c', eid: '1', visitDate: '2026-09-25', now: '2026-09-24T13:00:00.000Z' }).skipped);
});

test('A1: a missing client or eid is a skip, not a half-written row', () => {
  assert.ok(reminders.buildVisitReminder({ id: 'r', eid: '1', visitDate: '2026-09-25' }).skipped);
  assert.ok(reminders.buildVisitReminder({ id: 'r', clientId: 'c', visitDate: '2026-09-25' }).skipped);
});

// ══════════════════════════════════════════════════════════════════════════
// A3 — the three writes
// ══════════════════════════════════════════════════════════════════════════

const mkRow = (over = {}) => ({
  id: 'r1', clientId: 'c1', eid: '100', visitDate: '2026-09-25',
  when: 'Friday, September 25 at 9:00 AM', clinician: 'Bethel Godwins, FNP — your nurse practitioner',
  place: 'Your home', sendAt: '2026-09-24T13:00:00.000Z', status: 'scheduled',
  voidReason: null, createdAt: '2026-09-20T00:00:00.000Z', sentAt: null, ...over
});

test('A3: voiding is keyed on the eid, and only touches SCHEDULED rows', () => {
  const rows = [
    mkRow({ id: 'a', eid: '100' }),
    mkRow({ id: 'b', eid: '200' }),
    mkRow({ id: 'c', eid: '100', status: 'sent', sentAt: '2026-09-24T13:00:01.000Z' })
  ];
  const out = reminders.voidRemindersForEid(rows, '100', 'rescheduled', '2026-09-22T00:00:00.000Z');
  assert.equal(out.voided, 1);
  assert.equal(out.rows[0].status, 'void');
  assert.equal(out.rows[0].voidReason, 'rescheduled');
  assert.equal(out.rows[1].status, 'scheduled', 'another appointment is untouched');
  assert.equal(out.rows[2].status, 'sent', 'an already-sent reminder is not retro-voided');
  // A numeric eid and a string eid are the same appointment.
  assert.equal(reminders.voidRemindersForEid([mkRow({ eid: 100 })], '100', 'cancelled').voided, 1);
  // An unrecognised reason falls back rather than storing a value nothing reads.
  assert.equal(reminders.voidRemindersForEid(rows, '100', 'because').rows[0].voidReason, 'cancelled');
});

test('A3: RESCHEDULE VOIDS THE OLD EID AND CREATES ON THE NEW ONE', () => {
  // THE TOMBSTONE SWAP CHANGES THE EID. Keying the void on the NEW eid would
  // leave the old reminder live and send a patient to a time nobody is coming at
  // — which is the single worst outcome this whole feature could produce.
  const src = SERVER_CODE.slice(SERVER_CODE.indexOf('notify.appointmentRescheduled'));
  const slice = src.slice(0, src.indexOf('res.json('));
  assert.match(slice, /voidVisitReminders\(\{ eid: String\(row\.pc_eid\), reason: 'rescheduled'/,
    'the void keys on the OLD eid (row.pc_eid), not the new one');
  assert.match(slice, /scheduleVisitReminder\(\{[\s\S]{0,200}eid: String\(newEid\)/,
    'and the create keys on the NEW eid');
  assert.ok(awaitsUnconditionally(slice, 'scheduleVisitReminder'),
    'and it actually runs — not a call left behind a condition');
  assert.ok(awaitsUnconditionally(slice, 'voidVisitReminders'));
  // Both, in that order: creating first and then voiding by the old eid would be
  // correct too, but voiding by the NEW eid at any point would kill the reminder
  // that was just written.
  assert.ok(slice.indexOf('voidVisitReminders') < slice.indexOf('scheduleVisitReminder'));
});

// A SOURCE SCAN CANNOT PROVE A CALL IS REACHED — but it can prove the call is an
// UNCONDITIONAL STATEMENT. Anchoring on a newline plus `await` is what
// distinguishes `await f()` from `if (false) await f()`, and two of my own
// mutations survived because the first version of these assertions only checked
// that the text was present. The mutation harness is the only reason I know.
const awaitsUnconditionally = (src, call) =>
  new RegExp(`\\n\\s*await ${call}\\(`).test(src);

test('A3: booking creates one, cancel voids, and a no-show still sends nothing', () => {
  assert.match(SERVER_CODE, /notify\.appointmentBooked\([\s\S]{0,400}scheduleVisitReminder\(/,
    'the booking route schedules the reminder after the booking notice');
  assert.ok(awaitsUnconditionally(SERVER_CODE, 'scheduleVisitReminder'),
    'and it is an unconditional await, not a call behind a condition');
  assert.ok(awaitsUnconditionally(SERVER_CODE, 'voidVisitReminders'),
    'as is the void');
  // Both of them, at every site: three notify calls, three reminder actions.
  assert.equal((SERVER_CODE.match(/\n\s*await scheduleVisitReminder\(/g) || []).length, 2,
    'scheduled unconditionally at booking AND at reschedule');
  assert.equal((SERVER_CODE.match(/\n\s*await voidVisitReminders\(/g) || []).length, 2,
    'voided unconditionally at reschedule AND at cancel');
  const cancel = SERVER_CODE.slice(SERVER_CODE.indexOf('notify.appointmentCancelled'));
  assert.match(cancel.slice(0, 900), /voidVisitReminders\(\{ eid: String\(row\.pc_eid\), reason: 'cancelled'/);
  // A NO-SHOW SENDS NOTHING, before or after. "You missed your appointment" is a
  // conversation, not an automated email, and the patient may have been in
  // hospital. The existing rule, and a reminder must not reintroduce it.
  const noShow = SERVER_CODE.slice(SERVER_CODE.indexOf("appointments/:eid/no-show"));
  const noShowBody = noShow.slice(0, noShow.indexOf('app.get(') > 0 ? noShow.indexOf('app.get(') : 3000);
  assert.ok(!/notify\.|scheduleVisitReminder/.test(noShowBody), 'a no-show notifies nobody and schedules nothing');
});

test('A3: scheduling a reminder is BEST-EFFORT — it can never undo an appointment', () => {
  // Exactly like the booking notice. An appointment is already on the calendar
  // by this point; losing it over a reminder would be absurd.
  const fn = SERVER_CODE.slice(SERVER_CODE.indexOf('const scheduleVisitReminder'));
  const body = fn.slice(0, fn.indexOf('const voidVisitReminders'));
  assert.match(body, /try \{/);
  assert.match(body, /catch \(e\) \{[\s\S]{0,200}non-fatal/);
  assert.match(body, /return \{ scheduled: false/);
  // And a SKIP is logged as a skip, not as an error — the commonest skip is a
  // visit booked too close to the day, which is normal.
  assert.match(body, /if \(built\.skipped\) \{[\s\S]{0,200}console\.log/);
  assert.ok(!/built\.skipped[\s\S]{0,120}console\.error/.test(body));
});

// ══════════════════════════════════════════════════════════════════════════
// A4 — the send
// ══════════════════════════════════════════════════════════════════════════

test('A4: a due reminder is picked up; one not yet due is not', () => {
  const rows = [mkRow({ id: 'due' }), mkRow({ id: 'later', sendAt: '2026-10-01T13:00:00.000Z' })];
  const { due, missed } = reminders.dueReminders(rows, '2026-09-24T13:00:00.000Z');
  assert.deepEqual(due.map(r => r.id), ['due']);
  assert.deepEqual(missed, []);
  // One second early is not due.
  assert.deepEqual(reminders.dueReminders(rows, '2026-09-24T12:59:59.000Z').due, []);
});

test('A4: a sent or voided reminder is never picked up again — a second scan is a no-op', () => {
  const rows = [
    mkRow({ id: 'sent', status: 'sent', sentAt: '2026-09-24T13:00:01.000Z' }),
    mkRow({ id: 'void', status: 'void', voidReason: 'cancelled' })
  ];
  const { due, missed } = reminders.dueReminders(rows, '2026-09-24T14:00:00.000Z');
  assert.deepEqual(due, []);
  assert.deepEqual(missed, []);
});

test('A4: MORE THAN 12 HOURS PAST IS VOIDED, NOT SENT LATE', () => {
  // The server was down over the send window. A reminder that arrives after the
  // visit tells somebody to expect a clinician who has already been and gone,
  // which is worse than no reminder at all.
  assert.equal(reminders.MISSED_WINDOW_HOURS, 12);
  const rows = [mkRow({ id: 'stale' })];
  const justInside = reminders.dueReminders(rows, '2026-09-25T00:59:00.000Z');  // 11h59
  assert.deepEqual(justInside.due.map(r => r.id), ['stale']);
  assert.deepEqual(justInside.missed, []);
  const outside = reminders.dueReminders(rows, '2026-09-25T01:01:00.000Z');     // 12h01
  assert.deepEqual(outside.due, []);
  assert.deepEqual(outside.missed.map(r => r.id), ['stale']);
  // And the scanner VOIDS the missed ones rather than sending them.
  const sweep = SERVER_CODE.slice(SERVER_CODE.indexOf('const sendDueVisitReminders'));
  assert.match(sweep, /for \(const r of missed\)[\s\S]{0,300}voidReason: 'missed_window'/);
  const missedBlock = sweep.slice(sweep.indexOf('for (const r of missed)'), sweep.indexOf('for (const r of due)'));
  assert.ok(!/notify\.visitReminder/.test(missedBlock), 'a missed reminder is never sent');
});

test('A4: a backlog drains oldest first', () => {
  // BOTH INSIDE THE MISSED-WINDOW CUTOFF, or the older one is voided rather than
  // queued and this would be asserting the wrong thing. My first fixture put the
  // older row 25 hours back, so it landed in `missed` and the assertion read as a
  // sort bug when the sort was fine.
  const rows = [
    mkRow({ id: 'newer', sendAt: '2026-09-24T13:00:00.000Z' }),
    mkRow({ id: 'older', sendAt: '2026-09-24T09:00:00.000Z' })
  ];
  const out = reminders.dueReminders(rows, '2026-09-24T14:00:00.000Z');
  assert.deepEqual(out.missed, [], 'both are inside the window');
  assert.deepEqual(out.due.map(r => r.id), ['older', 'newer']);
});

test('A4: the reminder rides the EXISTING scanner, and the row is marked only after the queue accepts it', () => {
  // A new timer is a second thing to keep alive, and this one already runs on a
  // schedule the owner controls.
  assert.match(SERVER_CODE, /await sendDueVisitReminders\(\);\s*\n\s*console\.log\('\[SCANNER\] Notification trigger scan completed'\)/);
  assert.equal((SERVER_CODE.match(/setInterval\(sendDueVisitReminders/g) || []).length, 0, 'no second timer');
  const sweep = SERVER_CODE.slice(SERVER_CODE.indexOf('const sendDueVisitReminders'));
  const dueBlock = sweep.slice(sweep.indexOf('for (const r of due)'));
  // THE SEND HAPPENS, THEN THE ROW IS MARKED. Asserted as the await coming before
  // the assignment that marks it — my first version compared the positions of two
  // loosely related strings, and a mutation that reordered the lines around them
  // sailed through because neither string moved relative to the other.
  const awaitAt = dueBlock.indexOf('await notify.visitReminder(');
  const markAt = dueBlock.indexOf('rows[i] = {');
  assert.ok(awaitAt > -1 && markAt > -1);
  assert.ok(awaitAt < markAt, 'the row is marked only after the queue has accepted it');
  // And the whole sweep is wrapped, so a reminder problem never takes the scan down.
  assert.match(sweep, /catch \(err\) \{[\s\S]{0,200}non-fatal/);
});

test('A4: the dedupe key is `${eid}:reminder`, so it cannot collide with the booking notice', () => {
  // Sharing the eid would make the reminder look like a duplicate of the booking
  // email and silently drop it — the trap the document-request reminder already
  // paid for, which is why THAT one carries a distinct relatedEntityId too.
  const src = CODE(read('notifications.js'));
  assert.match(src, /entityId: `\$\{reminder\.eid\}:reminder`/);
  // And it makes a second scan a no-op even if marking the row 'sent' failed, so
  // a crash between the queue and the write cannot double-send.
  assert.match(read('notifications.js'), /no-op even if marking the row 'sent'/);
});

// ══════════════════════════════════════════════════════════════════════════
// A5 — the copy, and the POA rewrite it depends on
// ══════════════════════════════════════════════════════════════════════════

test('A5: BOTH variants\' first paragraph begins with "Your visit" — that is the mechanism', () => {
  // sendToClientSide rewrites /^Your visit/ to "{Name}'s visit" for a POA. A
  // paragraph that starts any other way tells a POA "your visit" about somebody
  // else's appointment.
  for (const detail of [true, false]) {
    const copy = reminders.reminderCopy({ detail, when: 'Friday at 9:00 AM', orgPhone: consentText.ORG.phone });
    assert.ok(copy.paragraphs[0].startsWith('Your visit'),
      `the ${detail ? 'detailed' : 'vague'} first paragraph must start with "Your visit"`);
  }
});

test('A5: a POA is told WHOSE visit it is; the client is not told their own name', async () => {
  const CLIENT = { id: 'c1', name: 'Juanita Guess', role: 'client', email: 'client@test.local' };
  const POA = { id: 'f1', name: 'Marcus Guess', role: 'family', email: 'poa@test.local', familyIsPoa: true, familyOfClientId: 'c1' };
  const NON_POA = { id: 'f2', name: 'Nosy Cousin', role: 'family', email: 'cousin@test.local', familyIsPoa: false, familyOfClientId: 'c1' };
  const queued = [];
  const notify = createNotifier({
    db: { get: async () => null, set: async () => {} },
    getUsers: async () => [CLIENT, POA, NON_POA],
    queueNotification: async (type, uid, email, name, tpl) => { queued.push({ type, email, ...tpl }); return { id: 'q' }; },
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    // createNotifier takes the ROLE NAMES, not a config object — they are passed
    // in rather than restated so this fixture cannot drift from server.js.
    clientRole: 'client', familyRole: 'family', staffRoles: ['admin', 'user', 'caseManager'],
    getAppBaseUrl: async () => 'https://app.test.local'
  });

  await notify.visitReminder({ reminder: mkRow(), orgPhone: consentText.ORG.phone });
  assert.equal(queued.length, 2, 'the client and the POA — and NOT the non-POA family member');
  const toClient = queued.find(q => q.email === 'client@test.local');
  const toPoa = queued.find(q => q.email === 'poa@test.local');
  assert.ok(!queued.some(q => q.email === 'cousin@test.local'),
    'non-POA family are excluded: their access is ROI- and sharing-gated at READ time and email is a push channel');
  assert.match(toClient.body, /Your visit is tomorrow/);
  assert.ok(!/Juanita Guess's visit/.test(toClient.body), 'the client is not told their own name');
  assert.match(toPoa.body, /Juanita Guess's visit is tomorrow/);
  assert.ok(!/^Your visit/m.test(toPoa.body.split('\n').find(l => /visit is tomorrow/.test(l)) || ''),
    'the POA is never told "your visit" about somebody else\'s appointment');
});

test('A5: the detailed version carries When / Who / Where and the office phone from ORG', () => {
  const copy = reminders.reminderCopy({ detail: true, when: 'Friday, September 25 at 9:00 AM', orgPhone: consentText.ORG.phone });
  assert.match(copy.subject, /^Reminder: your visit tomorrow at Friday, September 25 at 9:00 AM$/);
  assert.equal(copy.headline, 'See you tomorrow');
  assert.ok(copy.paragraphs[1].includes(consentText.ORG.phone), 'the office number comes from ORG, never a literal');
  // NEVER A LITERAL. The number changes in one place.
  const src = CODE(read('visitReminders.js'));
  assert.ok(!/404-913-6705|4049136705/.test(src), 'the office phone must not be a literal here');
  assert.match(SERVER_CODE, /orgPhone: consentText\.ORG\.phone/);
});

test('A6: the vague version carries NO date, name or place anywhere', async () => {
  const CLIENT = { id: 'c1', name: 'Juanita Guess', role: 'client', email: 'client@test.local' };
  const queued = [];
  const notify = createNotifier({
    db: { get: async () => null, set: async () => {} },
    getUsers: async () => [CLIENT],
    queueNotification: async (type, uid, email, name, tpl) => { queued.push({ ...tpl }); return { id: 'q' }; },
    // The transport is NOT BAA-covered, so PHI may not be put in an email.
    emailTransport: { transportStatus: () => ({ baaCovered: false }) },
    clientRole: 'client', familyRole: 'family', staffRoles: ['admin', 'user', 'caseManager'],
    getAppBaseUrl: async () => 'https://app.test.local'
  });
  await notify.visitReminder({ reminder: mkRow(), orgPhone: consentText.ORG.phone });
  assert.equal(queued.length, 1);
  const all = `${queued[0].subject} ${queued[0].body} ${queued[0].htmlBody}`;
  assert.equal(queued[0].subject, 'You have a visit coming up');
  for (const leak of ['September 25', 'Friday', '9:00 AM', 'Bethel Godwins', 'nurse practitioner', 'Your home']) {
    assert.ok(!all.includes(leak), `the vague version must not carry "${leak}"`);
  }
  assert.match(queued[0].body, /details are in your secure portal/);
  // The vague version still begins with "Your visit", or the POA rewrite breaks.
  assert.match(queued[0].body, /Your visit is coming up tomorrow/);
});

// ══════════════════════════════════════════════════════════════════════════
// SCOPE B — the "Who" line
// ══════════════════════════════════════════════════════════════════════════

test('B1: the plain-English role, per credential', () => {
  const label = (c) => reminders.visitClinicianLabel({ name: 'Bethel Godwins', licenseLevel: c });
  assert.equal(label('FNP'), 'Bethel Godwins, FNP — your nurse practitioner');
  assert.equal(label('PMHNP-BC'), 'Bethel Godwins, PMHNP-BC — your nurse practitioner');
  assert.equal(label('MD'), 'Bethel Godwins, MD — your physician');
  assert.equal(label('DO'), 'Bethel Godwins, DO — your physician');
  assert.equal(label('PA-C'), 'Bethel Godwins, PA-C — your physician assistant');
  assert.equal(label('LCSW'), 'Bethel Godwins, LCSW — your social worker');
  assert.equal(label('LMSW'), 'Bethel Godwins, LMSW — your social worker');
  assert.equal(label('RN'), 'Bethel Godwins, RN — your nurse');
  // The NP family in the shapes a licence actually carries, case-insensitively.
  for (const c of ['np', 'NP', 'APRN', 'AGNP', 'ANP', 'FNP-BC', 'fnp-c', 'PMHNP']) {
    assert.match(label(c), /your nurse practitioner$/, c);
  }
});

test('B1: a BLANK credential gives the name alone, and an UNRECOGNISED one gives name plus credential', () => {
  // NEVER GUESS A ROLE. Inventing "your physician" for a credential this file
  // does not know would tell a patient something untrue about who is treating
  // them, which is worse than telling them only a name.
  assert.equal(reminders.visitClinicianLabel({ name: 'Bethel Godwins' }), 'Bethel Godwins');
  assert.equal(reminders.visitClinicianLabel({ name: 'Bethel Godwins', licenseLevel: '' }), 'Bethel Godwins');
  assert.equal(reminders.visitClinicianLabel({ name: 'Bethel Godwins', licenseLevel: '   ' }), 'Bethel Godwins');
  assert.equal(reminders.visitClinicianLabel({ name: 'Bethel Godwins', licenseLevel: 'Doula' }), 'Bethel Godwins, Doula');
  assert.equal(reminders.visitClinicianLabel({ name: 'Bethel Godwins', licenseLevel: 'CNA' }), 'Bethel Godwins, CNA');
  assert.equal(reminders.rolePhraseFor('Doula'), null);
  // No user, or no name, is null rather than a label about nobody.
  assert.equal(reminders.visitClinicianLabel(null), null);
  assert.equal(reminders.visitClinicianLabel({ licenseLevel: 'MD' }), null);
});

test('B1: the STRUCTURED prescriberCredential (4.10) wins over free-text licenseLevel', () => {
  // Free text is what made the old line unreliable, so the structured field is
  // preferred where it exists.
  assert.equal(
    reminders.visitClinicianLabel({ name: 'Dana Prewitt', prescriberCredential: 'MD', licenseLevel: 'FNP-BC' }),
    'Dana Prewitt, MD — your physician');
  // And it falls back when there is no structured value.
  assert.equal(
    reminders.visitClinicianLabel({ name: 'Dana Prewitt', licenseLevel: 'FNP-BC' }),
    'Dana Prewitt, FNP-BC — your nurse practitioner');
});

test('B1: ONE formatter — booking, reschedule, cancel AND the reminder all use it', () => {
  // Four copies of "how a clinician is described to a patient" is four copies
  // that drift, and the drift is silent: the booking email and the reminder
  // would describe the same person differently.
  assert.match(SERVER_CODE, /const clinicianNameForProviderId = async[\s\S]{0,400}visitReminders\.visitClinicianLabel\(u\)/);
  // The old hand-built join must be gone, or there are two answers again.
  assert.ok(!/\[u\.name, u\.licenseLevel \|\| u\.credential\]\.filter\(Boolean\)\.join\(', '\)/.test(SERVER_CODE),
    'the hand-built label must be gone, not left beside the formatter');
  // And the reminder renders the clinician string the BOOKING captured, so the
  // two cannot disagree even in principle.
  assert.match(SERVER_CODE, /clinician: bookedClinician/);
});

test('B2: a clinician with no credential is FLAGGED, and the server answers it', () => {
  const users = [
    { id: 'a', name: 'No Credential', openEmrProviderId: '1' },
    { id: 'b', name: 'Has One', openEmrProviderId: '2', licenseLevel: 'FNP' },
    { id: 'c', name: 'Structured', openEmrProviderId: '3', prescriberCredential: 'MD' },
    { id: 'd', name: 'Not A Clinician' },                                   // no provider id: not patient-facing
    { id: 'e', name: 'Blank', openEmrProviderId: '4', licenseLevel: '  ' }   // whitespace is blank
  ];
  assert.deepEqual(reminders.cliniciansWithoutCredential(users).map(u => u.id), ['a', 'e']);
  // An unrecognised credential is a DIFFERENT gap and is reported separately: the
  // patient gets the name and the credential, just no plain-English role.
  const odd = reminders.cliniciansWithUnrecognisedCredential([
    ...users, { id: 'f', name: 'Doula', openEmrProviderId: '5', licenseLevel: 'Doula' }
  ]);
  assert.deepEqual(odd.map(u => u.id), ['f']);
  // Answered by the SERVER so the page cannot drift from the formatter.
  assert.match(SERVER_CODE, /patientFacingCredentialMissing: !!u\.openEmrProviderId/);
  assert.match(SERVER_CODE, /patientFacingLabel: visitReminders\.visitClinicianLabel\(u\)/);
  const hub = CODE(read('public/admin-hub.html'));
  assert.match(hub, /patientFacingCredentialMissing/);
  assert.match(hub, /name with no title/);
  // The page must not decide it itself.
  assert.ok(!/rolePhraseFor|your nurse practitioner/.test(hub), 'the page states no role phrase of its own');
});

// ══════════════════════════════════════════════════════════════════════════
// The constraint, and the non-goals
// ══════════════════════════════════════════════════════════════════════════

test('NO SERVICE IDENTITY WAS ADDED TO READ THE CALENDAR', () => {
  // Per-clinician auth is a HIPAA-gate decision (Session 5.2). A background job
  // cannot read the OpenEMR calendar, and the reminder does not try: it renders
  // from strings snapshot at write time.
  const src = CODE(read('visitReminders.js'));
  // The pattern names EMR ACCESS, not the string "openemr". My first draft used
  // the bare word and matched `u.openEmrProviderId` — reading a FIELD on a user
  // record, which is exactly what this module is supposed to do. A guard that
  // fires on the thing it is meant to permit is a guard somebody deletes.
  assert.ok(!/require\(['"]\.\/openemr|client_credentials|serviceAccount|\bforActor\(|rawRequest|getAppointmentRow/i.test(src),
    'the reminder module must not reach for the EMR at all');
  assert.ok(!/client_credentials/.test(SERVER_CODE), 'no client_credentials client anywhere');
  const sweep = SERVER_CODE.slice(SERVER_CODE.indexOf('const sendDueVisitReminders'));
  const body = sweep.slice(0, sweep.indexOf('\n};') + 3);
  assert.ok(!/openemr|getAppointmentRow|forActor/.test(body),
    'the send sweep must never read the calendar — that is the whole design');
  // And the operating rule it creates is written down where a future session
  // will read it, rather than being discovered.
  assert.match(read('visitReminders.js'), /booked and changed\s*\n?\/\/ through the app/);
  assert.match(read('CLAUDE.md'), /directly in OpenEMR/i);
});

test('non-goals: no SMS, no first-visit prep email, no facility contacts, no shift reminders', () => {
  const src = CODE(read('visitReminders.js'));
  assert.ok(!/sms|twilio|sendText/i.test(src), 'email only');
  assert.ok(!/firstVisit|preparation|prepEmail/i.test(src));
  assert.ok(!/facilityContact|facilityStaff/i.test(src));
  // PHCP caregiver shifts are a separate system by design — this must not couple
  // to the app-side shift store.
  assert.ok(!/schedulingRepository|caregiver/i.test(src));
  assert.deepEqual(reminders.VOID_REASONS, ['rescheduled', 'cancelled', 'missed_window']);
});

test('build: the collection is claimed in the migration registry, as PHI', () => {
  // It carries a visit date and a clinician for a named client.
  assert.match(read('dataMigration.js'), /key: 'visit_reminders', phi: true/);
});
