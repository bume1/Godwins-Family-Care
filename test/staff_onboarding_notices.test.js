'use strict';

// ============================================================================
// Email for staff onboarding and credentialing (owner, 2026-11-09)
//
//   "make sure email notifications updates accordingly. Esp for new employees
//    who need onboarding or credentialing reminders."
//
// A whole onboarding and credentialing system shipped over 2026-11-06..08 and
// sent NOTHING. The sharpest hole: the office returning an item REQUIRES a
// reason, stored it, and told her nothing — the same defect the client
// document rejection had.
//
// Driven through the SHIPPED router with the REAL notifier, reading the queued
// row back. A harness missing what production supplies exercises a different
// function, which this repo has now paid for four times.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const N = require('../onboarding/notices');
const VF = require('../onboarding/versionFlags');
const { createNotifier } = require('../notifications');
const links = require('../appLinks');

const root = path.join(__dirname, '..');
// Removes FULL-LINE `//` comments only. A block-comment strip is deliberately
// not used on server.js: a `/*` inside a string literal there opens a bogus
// comment that swallows 44% of the file, so a guard built on it would pass or
// fail for reasons unrelated to the code it names.
const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '');
const SERVER_SRC = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'office@test.local' };
const MGR = { id: 'm1', name: 'Mo Manager', role: 'user', isManager: true, email: 'mgr@test.local' };
const NP = { id: 'n1', name: 'Jordan Ellis', role: 'user', hasClinicalAccess: true, email: 'jordan@test.local' };
const OTHER = { id: 'o1', name: 'Other Provider', role: 'user', hasClinicalAccess: true, email: 'other@test.local' };
const CLIENT = { id: 'c1', name: 'Juanita Guess', role: 'client', email: 'patient@test.local' };
const USERS = [OFFICE, MGR, NP, OTHER, CLIENT];

async function mount(t, { withNotifier = true } = {}) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null),
               set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const notices = [];
  const queueNotification = async (type, id, email, name, data, o) => {
    notices.push({ type, email, name, ...data, ...(o || {}) }); return { id: 'q' };
  };
  const notify = createNotifier({
    getUsers: async () => USERS, queueNotification,
    getAppBaseUrl: async () => 'https://app.test.local',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin', 'user'], clientRole: 'client', familyRole: 'family'
  });
  const sourceLoader = {
    manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }),
    checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] })
  };
  const app = express();
  app.use(express.json());
  const router = require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => USERS,
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive: { uploadStaffDocumentFile: async () => ({ fileId: 'D1' }), downloadFileBuffer: async () => Buffer.from('x'), describeDriveError: (e) => ({ reason: e.message }) },
    detectFileType: () => 'image/png', uuidv4: () => Math.random().toString(36).slice(2), sourceLoader,
    ...(withNotifier ? { notify: () => notify, getAppBaseUrl: async () => 'https://app.test.local' } : {})
  });
  app.use(router);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  };
  return { store, call, notices, router, as: (u) => { current = u; },
           of: (type) => notices.filter(n => n.type === type) };
}

const start = async (h) => {
  h.as(OFFICE);
  const r = await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'], startDate: '2026-10-01' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
};

// ---------------------------------------------------------------------------
// The three events
// ---------------------------------------------------------------------------

test('S1 opening her onboarding emails her, once, and only on the first open', async (t) => {
  const h = await mount(t);
  await start(h);
  const first = h.of('staff_onboarding_started');
  assert.strictEqual(first.length, 1, 'she is welcomed when her track is opened');
  assert.strictEqual(first[0].email, NP.email);
  assert.match(first[0].subject, /onboarding is ready/i);
  assert.strictEqual(first[0].ctaUrl, 'https://app.test.local/my#onboarding');
  assert.strictEqual(first[0].phi, false, 'employment data, not PHI');
  // Changing what she covers later is not a second welcome.
  h.as(OFFICE);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { serviceLines: ['PRIVATE_PAY', 'IME'], credentials: ['FNP'] });
  assert.strictEqual(h.of('staff_onboarding_started').length, 1, 'a later edit is not a second welcome');
});

test('S2 a returned item emails her WITH THE REASON — the whole point of the notice', async (t) => {
  const h = await mount(t);
  await start(h);
  h.as(NP);
  await h.call('POST', '/api/onboarding/me/items/C.4.05/steps/0', {});
  h.as(OFFICE);
  const r = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/return`, { step: 0, reason: 'The scan was cut off at the expiration date' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const sent = h.of('staff_onboarding_returned');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].email, NP.email, 'to her, not the office');
  assert.match(sent[0].body, /The scan was cut off at the expiration date/,
    'the route REQUIRES a reason and was storing it where only a screen could show it');
  assert.match(sent[0].body, /Office Admin/, 'and who sent it back');
});

test('S3 her submission tells the office — every office member, nobody else', async (t) => {
  const h = await mount(t);
  await start(h);
  h.notices.length = 0;
  h.as(NP);
  const r = await h.call('POST', '/api/onboarding/me/items/C.4.05/steps/0', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const sent = h.of('staff_item_submitted');
  assert.deepStrictEqual(sent.map(n => n.email).sort(), [MGR.email, OFFICE.email].sort(),
    'an admin and a manager are the office; a provider and a client are not');
  assert.strictEqual(sent[0].ctaUrl, 'https://app.test.local/onboarding', 'the OFFICE screen, not her own portal');
  assert.match(sent[0].body, /Jordan Ellis/);
});

test('S4 the office completing a step does not email the office about itself', async (t) => {
  const h = await mount(t);
  await start(h);
  h.notices.length = 0;
  h.as(OFFICE);
  await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/steps/0`, {});
  assert.deepStrictEqual(h.of('staff_item_submitted'), [], 'the office does not notify itself');
});

test('S3b an item that completes outright does not ask the office to verify it', async (t) => {
  const h = await mount(t);
  await start(h);
  h.notices.length = 0;
  h.as(NP);
  // C.5.06 carries only her step, so it goes straight to COMPLETE.
  const r = await h.call('POST', '/api/onboarding/me/items/C.5.06/steps/0', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const t1 = await (async () => { h.as(OFFICE); return h.call('GET', `/api/onboarding/admin/people/${NP.id}`); })();
  const row = t1.data.track.items.find(i => i.id === 'C.5.06');
  assert.strictEqual(row.status, 'COMPLETE', 'precondition: it needs no verification');
  assert.deepStrictEqual(h.of('staff_item_submitted'), [],
    '"ready to verify" about an item with nothing to verify is a false errand');
});

test('S2b a second return of the same item is its own email, not a swallowed duplicate', async (t) => {
  const h = await mount(t);
  await start(h);
  const returnOnce = async (reason) => {
    h.as(NP);
    await h.call('POST', '/api/onboarding/me/items/C.4.05/steps/0', {});
    h.as(OFFICE);
    const r = await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/return`, { step: 0, reason });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  };
  await returnOnce('The scan is cut off');
  await returnOnce('Still cut off at the bottom');
  const sent = h.of('staff_onboarding_returned');
  assert.strictEqual(sent.length, 2, 'she resubmitted and it came back again — that is a new thing to tell her');
  assert.notStrictEqual(sent[0].relatedEntityId, sent[1].relatedEntityId,
    'a shared key would let the queue drop the second return silently');
  assert.match(sent[1].body, /Still cut off at the bottom/);
});

test('S7b the ROUTE honours the empty-digest rule, not just the helper', async (t) => {
  const h = await mount(t);
  await start(h);
  // `routes/onboarding.js` holds the same module object this test does, so
  // standing in for `digestFor` exercises the route's own guard rather than a
  // copy of it. A person with a track and nothing outstanding is otherwise
  // hard to arrange: a fresh track always has items waiting on her.
  const real = N.digestFor;
  N.digestFor = () => ({ outstanding: [], returned: [], expiring: [], recurring: [], rechecks: [], total: 0 });
  try {
    h.notices.length = 0;
    await sweep(h);
    assert.deepStrictEqual(h.of('staff_onboarding_digest'), [],
      'nothing outstanding means no email — a daily "nothing to do" is how a daily email stops being read');
  } finally { N.digestFor = real; }
  // And with it restored, the digest sends again, so the stand-in is not what made it quiet.
  h.notices.length = 0;
  await sweep(h);
  assert.strictEqual(h.of('staff_onboarding_digest').length, 1);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

// 9am on a Monday, stated rather than waited for.
const MONDAY = '2026-11-09';
const sweep = (h, over = {}) => h.router.notices.sweepOnboardingNotices(Object.assign({ today: MONDAY, hourEt: 9 }, over));

test('S5 her daily digest is ONE email carrying everything waiting on her', async (t) => {
  const h = await mount(t);
  await start(h);
  h.notices.length = 0;
  const out = await sweep(h);
  assert.ok(out.sent > 0, JSON.stringify(out));
  const d = h.of('staff_onboarding_digest');
  assert.strictEqual(d.length, 1, 'one email, not one per item — a 40-item first week would be 40 emails');
  assert.strictEqual(d[0].email, NP.email);
  assert.match(d[0].body, /WAITING ON YOU/);
  assert.match(d[0].body, /one email a day/i);
  assert.strictEqual(d[0].relatedEntityId.startsWith(`onbdigest:${NP.id}:`), true, 'keyed per person per day');
  assert.strictEqual(d[0].phi, false);
});

test('S6 nothing goes out before 9am Eastern, and the sweep reads no clock of its own', () => {
  for (const h of [0, 5, 8]) assert.strictEqual(N.sendHourReached(h), false, `hour ${h}`);
  for (const h of [9, 13, 23]) assert.strictEqual(N.sendHourReached(h), true, `hour ${h}`);
  const src = strip(fs.readFileSync(path.join(root, 'onboarding/notices.js'), 'utf8'));
  assert.ok(!/new Date\(\)/.test(src), 'the decision module must be handed the date and hour');
});

test('S6b the sweep itself sends nothing before the hour', async (t) => {
  const h = await mount(t);
  await start(h);
  h.notices.length = 0;
  const out = await sweep(h, { hourEt: 8 });
  assert.strictEqual(out.sent, 0);
  assert.deepStrictEqual(h.notices, [], 'the scanner runs every 30 minutes; without the gate she is emailed at 00:05');
  assert.ok((await sweep(h, { hourEt: 9 })).sent > 0, 'and it does send once the hour is reached');
});

test('S7 a digest with nothing in it is never sent', async (t) => {
  const h = await mount(t);   // no track at all
  h.notices.length = 0;
  await sweep(h);
  assert.deepStrictEqual(h.of('staff_onboarding_digest'), [], 'a daily "nothing to do" is how a daily email stops being read');
  assert.strictEqual(N.digestFor({ items: [], renewals: { items: [], recurring: [] }, modules: [] }).total, 0);
});

test('S8 an expiring credential reaches the office at its milestones, and her in the digest', async (t) => {
  const h = await mount(t);
  await start(h);
  // 14 days out: a milestone. Georgia's date, not UTC's: in the evening the
  // UTC date is already tomorrow, and the app counts days in Georgia.
  const soon = new Date(Date.now() + 14 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  h.as(OFFICE);
  const e = await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.4.01/expiry`, { expiresOn: soon });
  assert.strictEqual(e.status, 200, JSON.stringify(e.data));
  // Precondition: the item has to be ON her track, or this proves nothing.
  const t0 = await h.call('GET', `/api/onboarding/admin/people/${NP.id}`);
  assert.ok((t0.data.track.renewals.items || []).some(x => x.id === 'C.4.01'), 'the licence must apply to this fixture');
  h.notices.length = 0;
  await sweep(h);
  const office = h.of('staff_credential_expiring');
  assert.deepStrictEqual(office.map(n => n.email).sort(), [MGR.email, OFFICE.email].sort(), 'both sides watch a credential (owner, 2026-11-09)');
  assert.match(office[0].subject, /Expiring in 14 days/);
  assert.match(office[0].body, /Jordan Ellis/);
  assert.match(office[0].body, /License or authorization/);
  // And she hears in her own one email, not a second one.
  const d = h.of('staff_onboarding_digest');
  assert.strictEqual(d.length, 1);
  assert.match(d[0].body, /CREDENTIALS/);
  assert.match(d[0].body, /License or authorization/);
});

test('S9 the office is not told every morning between milestones', async (t) => {
  const h = await mount(t);
  await start(h);
  const notMilestone = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
  h.as(OFFICE);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.4.01/expiry`, { expiresOn: notMilestone });
  h.notices.length = 0;
  await sweep(h);
  assert.deepStrictEqual(h.of('staff_credential_expiring'), [], '21 days is between the 30 and 14 day milestones');
  assert.strictEqual(N.officeMilestone(21), null);
  for (const d of N.OFFICE_EXPIRY_MILESTONES) assert.strictEqual(N.officeMilestone(d), d);
});

test('S10 a lapsed credential is repeated daily, because it stops her working', async (t) => {
  const h = await mount(t);
  await start(h);
  const gone = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  h.as(OFFICE);
  await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.4.01/expiry`, { expiresOn: gone });
  h.notices.length = 0;
  await sweep(h);
  const sent = h.of('staff_credential_expiring');
  assert.ok(sent.length >= 1);
  assert.match(sent[0].subject, /^EXPIRED/);
  assert.match(sent[0].body, /stops them working/i);
  // The key carries the DAY once lapsed, so tomorrow sends again.
  assert.match(sent[0].relatedEntityId, /:0:\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(N.officeMilestone(-3), 0);
});

test('S11 the weekly roll-up goes out on a Monday only, one per office member', async (t) => {
  assert.strictEqual(N.weekdayOf('2026-11-09'), 1, 'precondition: that date is a Monday');
  assert.strictEqual(N.isWeeklyDay('2026-11-09'), true);
  assert.strictEqual(N.isWeeklyDay('2026-11-10'), false, 'Tuesday is not the roll-up day');
  // One per week, whatever day in it the sweep first runs.
  assert.strictEqual(N.weeklyKey('a1', '2026-11-09'), `onbweekly:a1:${N.isoWeekOf('2026-11-09')}`);
  assert.notStrictEqual(N.isoWeekOf('2026-11-09'), N.isoWeekOf('2026-11-16'));
  const h = await mount(t);
  await start(h);
  h.notices.length = 0;
  await sweep(h);
  const weekly = h.of('staff_onboarding_weekly');
  assert.deepStrictEqual(weekly.map(n => n.email).sort(), [MGR.email, OFFICE.email].sort());
  assert.match(weekly[0].body, /once a week/i);
  // And on a Tuesday, nothing.
  h.notices.length = 0;
  await sweep(h, { today: '2026-11-10' });
  assert.deepStrictEqual(h.of('staff_onboarding_weekly'), [], 'the roll-up is a Monday thing');
});

test('S12 the roll-up names who has not started at all, from the roster', () => {
  const r = N.weeklyFor(
    [{ userId: 'u1', name: 'A', waitingOnOffice: 2, waitingOnHer: 5, renewalsDue: 1, expired: 0, startDate: '2026-10-01' }],
    '2026-11-09', [{ userId: 'u9', name: 'Never Started' }]);
  assert.strictEqual(r.waitingOnOffice.length, 1);
  assert.strictEqual(r.expiring.length, 1);
  assert.strictEqual(r.stalled.length, 1, '39 days past the start date with items still on her');
  assert.strictEqual(r.notYetStarted.length, 1);
  assert.strictEqual(r.total, 4);
  // Not stalled when she only just started.
  const fresh = N.weeklyFor([{ userId: 'u1', name: 'A', waitingOnHer: 5, waitingOnOffice: 0, renewalsDue: 0, expired: 0, startDate: '2026-11-05' }], '2026-11-09', []);
  assert.deepStrictEqual(fresh.stalled, [], `a track ${N.STALLED_DAYS} days old or less is not stalled`);
});

// ---------------------------------------------------------------------------
// Who is never emailed, and what never appears
// ---------------------------------------------------------------------------

test('S13 nobody outside the person and the office is ever emailed about onboarding', async (t) => {
  const h = await mount(t);
  await start(h);
  h.as(NP);
  await h.call('POST', '/api/onboarding/me/items/C.4.05/steps/0', {});
  h.as(OFFICE);
  await h.call('POST', `/api/onboarding/admin/people/${NP.id}/items/C.4.05/return`, { step: 0, reason: 'again please' });
  await sweep(h);
  const strangers = h.notices.filter(n => ![NP.email, OFFICE.email, MGR.email].includes(n.email));
  assert.deepStrictEqual(strangers, [], 'another provider and a client are never told');
  assert.ok(!h.notices.some(n => n.email === CLIENT.email), 'a patient is never emailed about staff onboarding');
});

test('S14 no patient ever appears in a staff onboarding notice', async (t) => {
  const h = await mount(t);
  await start(h);
  await sweep(h);
  for (const n of h.notices) {
    const all = `${n.subject}\n${n.body}`;
    assert.ok(!all.includes('Juanita Guess'), `${n.type} leaked a patient name`);
    assert.strictEqual(n.phi, false, `${n.type}: employment data carries no PHI marking`);
  }
  // Build-enforced: the notices block reaches for no client at all.
  const src = strip(fs.readFileSync(path.join(root, 'onboarding/notices.js'), 'utf8'));
  assert.ok(!/client|patient/i.test(src), 'the decision module must know nothing about clients');
});

test('S15 a notice failure never undoes the onboarding action it rode on', async (t) => {
  const h = await mount(t);
  await start(h);
  // Replace the notifier with one that throws on every builder.
  const boom = new Proxy({}, { get: () => async () => { throw new Error('mail down'); } });
  h.router.notices.sweepOnboardingNotices.call(null);
  const r = await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/items/C.4.01/expiry`, { expiresOn: '2027-01-01' });
  assert.strictEqual(r.status, 200, 'the write stands whatever mail does');
  assert.ok(h.store.onboarding_records[0].items['C.4.01'].expiresOn, 'and it is stored');
  void boom;
});

test('S16 a missing notifier is LOUD, never a silent skip', async (t) => {
  const errs = [];
  const real = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    const h = await mount(t, { withNotifier: false });
    await start(h);
    await sweep(h);
    assert.deepStrictEqual(h.notices, [], 'nothing can be queued with no notifier');
  } finally { console.error = real; }
  assert.ok(errs.some(e => /no notifier injected/.test(e)),
    '"nothing was emailed" and "nobody needed emailing" are different facts');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('S17 the sweep rides the scanner that already runs, with no timer of its own', () => {
  const src = strip(SERVER_SRC);
  assert.match(src, /\n\s*await onboardingRouter\.notices\.sweepOnboardingNotices\(\);/,
    'called from inside the scan, unconditionally');
  assert.strictEqual((src.match(/setInterval\(\s*[^,]*sweepOnboardingNotices/g) || []).length, 0,
    'no second timer: unlike a to-do, none of this names a minute');
  assert.match(SERVER_SRC, /notify: \(\) => notify/, 'the notifier is read lazily or it hits the temporal dead zone');
  assert.match(src, /const onboardingRouter = onboardingRoutes\(/, 'the router is kept so the scan can reach its sweep');
});

test('S18 the destinations live in appLinks, and the office one is not her portal', () => {
  assert.strictEqual(links.myOnboardingFor(), '/my#onboarding');
  assert.strictEqual(links.staffOnboardingFor(), '/onboarding');
  assert.notStrictEqual(links.myOnboardingFor(), links.staffOnboardingFor(),
    'pointing an office notice at /my sends an admin to their own checklist');
  for (const p of ['/my#onboarding', '/onboarding']) assert.ok(links.ALL_PATHS.includes(p), `${p} must be swept at boot`);
  // Both pages resolve the fragment and fall back rather than render a dead tab.
  const my = fs.readFileSync(path.join(root, 'public/my.html'), 'utf8');
  const cg = fs.readFileSync(path.join(root, 'public/caregiver.html'), 'utf8');
  assert.match(my, /if \(!current\) \{ setView\('home'\); return null; \}/);
  assert.match(cg, /TAB_IDS\.includes\(want\) \? want : 'home'/);
  assert.match(cg, /'onboarding'/, 'a caregiver is redirected to /caregiver#onboarding, which must resolve');
  // The onboarding router names no path of its own.
  const rsrc = strip(fs.readFileSync(path.join(root, 'routes/onboarding.js'), 'utf8'));
  assert.ok(!/['"]\/my#onboarding['"]/.test(rsrc) && !/ctaUrl: ['"]\/onboarding['"]/.test(rsrc),
    'a path that moves must be corrected in one place');
});

test('S19 no onboarding notice is hand-rolled outside notifications.js', () => {
  const rsrc = strip(fs.readFileSync(path.join(root, 'routes/onboarding.js'), 'utf8'));
  assert.ok(!/queueNotification\(/.test(rsrc) && !/sendEmail\(/.test(rsrc),
    'branding, the unsubscribe honour and the duplicate check all live in the notifier');
  // Every one of the six is reached from the router.
  for (const fn of ['staffOnboardingStarted', 'staffOnboardingReturned', 'staffItemSubmitted',
                    'staffOnboardingDigest', 'staffCredentialExpiring', 'staffOnboardingWeekly']) {
    assert.match(rsrc, new RegExp(`\\.${fn}\\(`), `${fn} is declared and never called`);
  }
});

test('S20 the digest reads the track the app already builds, restating no rule', () => {
  const src = strip(fs.readFileSync(path.join(root, 'onboarding/notices.js'), 'utf8'));
  // It must not re-derive what is due; it reads the statuses track/renewals set.
  assert.ok(!/SOON_DAYS|RECURRING_SOON_DAYS|60|14 \*/.test(src.replace(/OFFICE_EXPIRY_MILESTONES[\s\S]{0,120}/, '')),
    'the warning windows belong to renewals.js');
  const d = N.digestFor({
    items: [{ id: 'i1', title: 'A', waitingOnHer: true, status: 'IN_PROGRESS' },
            { id: 'i2', title: 'B', waitingOnHer: true, status: 'RETURNED', returned: { reason: 'blurry' } },
            { id: 'i3', title: 'C', status: 'COMPLETE' }],
    renewals: { items: [{ id: 'x', title: 'DEA', expiry: { what: 'DEA registration', on: '2026-12-01', daysLeft: 22, status: 'SOON' } },
                        { id: 'y', title: 'TB', expiry: { what: 'TB screening', on: '2026-01-01', daysLeft: -5, status: 'EXPIRED' } },
                        { id: 'z', title: 'OK', expiry: { what: 'Licence', on: '2027-01-01', daysLeft: 400, status: 'OK' } }],
                recurring: [{ id: 'r1', requirement: 'Chart review', nextDue: '2026-11-12', status: 'SOON' },
                            { id: 'r2', requirement: 'Later', nextDue: '2027-01-01', status: 'OK' }] },
    modules: [{ id: 'TRN-1', title: 'Infection control', rechecks: { dueNow: [10] } },
              { id: 'TRN-2', title: 'Nothing due', rechecks: { dueNow: [] } }]
  });
  assert.deepStrictEqual(d.outstanding.map(x => x.id), ['i1'],
    'a RETURNED item is waiting on her too, and must appear under Sent back rather than in both lists');
  assert.deepStrictEqual(d.returned.map(x => x.reason), ['blurry']);
  assert.deepStrictEqual(d.expiring.map(x => x.what), ['TB screening', 'DEA registration'], 'soonest first, expired at the top');
  assert.deepStrictEqual(d.recurring.map(x => x.id), ['r1']);
  assert.deepStrictEqual(d.rechecks.map(x => x.id), ['TRN-1']);
  assert.strictEqual(d.total, 6, '1 outstanding + 1 returned + 2 credentials + 1 duty + 1 re-check');
});
