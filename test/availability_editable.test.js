// Availability is editable after submission.
//
// Owner report, 2026-10-27: "allow for availability to be able to be edited
// after submission ... currently our care coordinator nor can the client edit
// availability after submission. Caregivers cannot edit more than 3 days after
// original submission."
//
// What was actually true, established by driving the real routes: a caregiver
// COULD already update availability (it is append-only, so a resubmission is
// the edit) but only for dates 30+ days out, so changing next week was refused;
// and nobody on staff could touch it at all — admin, manager and the care
// coordinator were each 403. There was no 3-day rule anywhere; the number was
// 30. Clients have no availability record and never did.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sched = require('../schedulingRepository');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const W = [{ day: 'Mon', start: '09:00', end: '17:00' }];
const check = (days, isChange) =>
  sched.validateAvailability({ effectiveFrom: plus(days), windows: W }, new Date(), { isChange });

test('a FIRST submission starts at least two weeks ahead', () => {
  assert.equal(sched.AVAILABILITY_LEAD_DAYS, 14, 'owner decision, 2026-10-27');
  assert.ok(check(14, false).valid);
  assert.ok(check(30, false).valid, 'further out is still fine');
  assert.ok(!check(13, false).valid);
});

test('CHANGING availability already on file works at short notice', () => {
  // This is the whole report: a caregiver could not change next week.
  assert.ok(!check(7, false).valid, 'a first submission that near is still refused');
  assert.ok(check(7, true).valid, 'but changing what is on file is allowed');
  assert.ok(check(sched.AVAILABILITY_CHANGE_LEAD_DAYS, true).valid);
  assert.ok(!check(sched.AVAILABILITY_CHANGE_LEAD_DAYS - 1, true).valid,
    'the short-notice floor is still a floor');
  assert.ok(sched.AVAILABILITY_CHANGE_LEAD_DAYS < sched.AVAILABILITY_LEAD_DAYS);
});

test('the refusal names the floor that was actually applied', () => {
  // One message for both would send a caregiver changing next week to read a
  // rule about new submissions and conclude the app is simply wrong.
  const asNew = check(2, false).errors.find(e => e.code === 'AVAILABILITY_LEAD_TIME');
  const asChange = check(0, true).errors.find(e => e.code === 'AVAILABILITY_LEAD_TIME');
  assert.equal(asNew.required, sched.AVAILABILITY_LEAD_DAYS);
  assert.equal(asChange.required, sched.AVAILABILITY_CHANGE_LEAD_DAYS);
  assert.notEqual(asNew.message, asChange.message);
  assert.match(asChange.message, /change/i);
  assert.equal(asChange.isChange, true);
});

test('validateAvailability defaults to the strict floor when nothing is said', () => {
  // A caller that forgets the option must not silently buy the short notice.
  const r = sched.validateAvailability({ effectiveFrom: plus(7), windows: W }, new Date());
  assert.ok(!r.valid, 'no options means a first submission');
});

// ---- Build enforcement ----------------------------------------------------

test('the route asks the STORE whether this is a change, never the body', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf("router.post('/api/scheduling/availability'");
  const block = src.slice(i, i + 4200);
  assert.match(block, /const isChange = rows\.some\(/,
    'derived from stored rows, so a body claiming to be a change cannot buy a nearer date');
  assert.ok(!/isChange\s*=\s*(!!)?\s*(body|req\.body)/.test(block),
    'the caller must never declare its own floor');
  assert.match(block, /\{ isChange \}/, 'and it must be passed to the validator');
});

test('only an admin or a care coordinator records for somebody else', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf('const isAvailabilityRecorder');
  assert.ok(i > 0, 'the predicate must exist');
  const pred = src.slice(i, i + 220);
  assert.match(pred, /ROLES\.ADMIN/);
  assert.match(pred, /ROLES\.CASE_MANAGER/);
  // The owner chose the coordinator-and-admin option over the wider one that
  // included managers. One predicate to widen if that changes.
  assert.ok(!/isManager/.test(pred), 'managers were deliberately not included');
});

test('the row stays the CAREGIVER\'s, with the recorder named beside it', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf("router.post('/api/scheduling/availability'");
  const block = src.slice(i, i + 4200);
  // Identity comes from the subject's user record, never from the body.
  assert.match(block, /caregiver_id: subject\.id/);
  assert.match(block, /caregiver_name: subject\.name/);
  assert.match(block, /license_level: subject\.licenseLevel/);
  // ...and who keyed it in rides alongside, null when they posted their own.
  assert.match(block, /entered_by_id: onBehalf \?/);
  assert.match(block, /entered_on_behalf: onBehalf/);
});

test('both availability gates are MIDDLEWARE, where the route sweep can see them', () => {
  // The sweep in test/scheduling.test.js proves every /api/scheduling route
  // carries a role guard by reading the route signature. Gating inside the
  // handler is invisible to it, and it caught exactly that here. The right fix
  // was to make the guards real middleware, not to add an exception.
  const src = stripComments(read('routes/scheduling.js'));
  assert.match(src, /router\.post\('\/api\/scheduling\/availability',\s*authenticateToken,\s*requireAvailabilityWriter/);
  assert.match(src, /router\.get\('\/api\/scheduling\/availability\/caregivers',\s*authenticateToken,\s*requireAvailabilityOffice/);
});

test('the narrow roster carries no client data', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const i = src.indexOf("router.get('/api/scheduling/availability/caregivers'");
  assert.ok(i > 0);
  const block = src.slice(i, i + 1400);
  assert.ok(!/clients:/.test(block), 'widening the manager roster would have leaked the client list');
  assert.ok(!/geofence|Coordinates|careTier/.test(block));
  assert.match(block, /requireAvailabilityOffice/,
    'gated in MIDDLEWARE, so the route sweep in scheduling.test.js can see the guard');
});

test('availability stays APPEND-ONLY — no edit or delete route exists', () => {
  const src = stripComments(read('routes/scheduling.js'));
  const routes = src.match(/router\.(get|post|put|patch|delete)\('\/api\/scheduling\/availability[^']*'/g) || [];
  assert.ok(routes.length > 0);
  assert.ok(!routes.some(r => /\.(put|patch|delete)\(/.test(r)),
    'a change is a new row; what somebody said in August must still be readable in October');
});

test('neither screen restates the floors as a literal', () => {
  // Both printed "at least 30 days" beside a server rule they could not see,
  // and the rule has two values now.
  // ⚠️ STRIP COMMENTS FIRST. The first version of this guard matched the
  // comment that EXPLAINS the fix ("printed 'at least 30 days' as a literal
  // for a month after the rule moved") and failed on prose about the very bug
  // it was written to prevent. A scan that cannot tell live code from writing
  // about that code proves nothing — the house rule, for the sixth time.
  const page = stripComments(read('public/scheduling.html'));
  assert.ok(!/at least 30 days/.test(page), 'the page must read the served rule');
  assert.match(page, /availRules\.leadDays/);
  assert.match(page, /availRules\.changeLeadDays/);

  const comp = read('public/components/caregiver-schedule.js');
  assert.match(comp, /state\.availabilityRules/, 'the app reads the served rule');
  assert.match(comp, /rules \|\| null/, 'and stores what the list returned');
});

test('the caregiver app says a change does not touch shifts already accepted', () => {
  // The safety that makes short notice safe at all: changing availability
  // releases nothing, so somebody must not read it as having handed a shift back.
  const comp = read('public/components/caregiver-schedule.js');
  assert.match(comp, /Shifts you have already accepted do not change/);
  assert.match(comp, /Request a change on the shift itself/i);
});

test('both screens show when the office recorded it, not the caregiver', () => {
  assert.match(read('public/components/caregiver-schedule.js'), /Recorded for you by/);
  assert.match(read('public/scheduling.html'), /Recorded by \{a\.enteredByName/);
});

// ---- Driven through the real router ---------------------------------------
// ⚠️ EVERY TEST ABOVE IS A SOURCE SCAN OR A PURE FUNCTION, AND A MUTATION PROVED
// THAT IS NOT ENOUGH: neutralising the writer gate's own branch — so a
// coordinator falls through to the caregiver path and is refused — broke the
// whole feature with all of them still green. A scan cannot prove a request
// gets through. These mount the shipped router and post.
const express = require('express');
const bodyParser = require('body-parser');
const http = require('node:http');

function harness() {
  const store = new Map();
  const db = {
    get: async k => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const users = [
    { id: 'adm', email: 'a@g.test', name: 'GFC Admin', role: 'admin' },
    { id: 'coord', email: 'c@g.test', name: 'Care Coordinator', role: 'caseManager' },
    { id: 'mgr', email: 'm@g.test', name: 'Manager', role: 'user', isManager: true },
    { id: 'cg1', email: 'g@g.test', name: 'Danielle Carter', role: 'vendor', licenseLevel: 'cna' },
    { id: 'cg2', email: 'h@g.test', name: 'New Starter', role: 'vendor', licenseLevel: 'cna' },
    { id: 'client-1', email: 'cl@g.test', name: 'Margaret Whitfield', role: 'client', enrollmentStatus: 'enrolled' }
  ];
  const app = express();
  app.use(bodyParser.json());
  app.use(require('../routes/scheduling')({
    db,
    // The REAL config: a harness missing what production supplies exercises a
    // different function.
    config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => ({ id: 'n' }),
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === req.headers['x-as']);
      if (!u) return res.status(401).json({ error: 'no' });
      req.user = {
        id: u.id, email: u.email, name: u.name, role: u.role, isManager: u.isManager || false,
        hasClinicalAccess: false, licenseLevel: u.licenseLevel || null,
        assignedClients: [], careTeam: null, familyOfClientId: null
      };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  }));
  return { app, db };
}

const call = (app, method, url, body, as) => new Promise((resolve, reject) => {
  const srv = http.createServer(app).listen(0, () => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port: srv.address().port, path: url, method,
      headers: Object.assign({ 'x-as': as },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { srv.close(); let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', e => { srv.close(); reject(e); });
    if (data) req.write(data); req.end();
  });
});

test('ROUTE: a care coordinator records a change for a caregiver', async () => {
  const h = harness();
  await h.db.set('caregiver_availability', []);
  // The caregiver has availability on file, so a change gets the near floor.
  let r = await call(h.app, 'POST', '/api/scheduling/availability',
    { effectiveFrom: plus(20), windows: W }, 'cg1');
  assert.equal(r.status, 200, 'caregiver posts their own');

  r = await call(h.app, 'POST', '/api/scheduling/availability',
    { caregiverId: 'cg1', effectiveFrom: plus(3), windows: [{ day: 'Wed', start: '08:00', end: '12:00' }],
      entryNote: 'Rang in: no longer free Tuesdays' }, 'coord');
  assert.equal(r.status, 200, `coordinator must get through, got ${JSON.stringify(r.body)}`);
  const a = r.body.availability;
  assert.equal(a.caregiverId, 'cg1', 'the row is the CAREGIVER\'s');
  assert.equal(a.caregiverName, 'Danielle Carter');
  assert.equal(a.enteredOnBehalf, true);
  assert.equal(a.enteredByName, 'Care Coordinator');
  assert.match(a.entryNote, /no longer free Tuesdays/);
});

test('ROUTE: a caregiver changes next week, which the old rule refused', async () => {
  const h = harness();
  await h.db.set('caregiver_availability', []);
  let r = await call(h.app, 'POST', '/api/scheduling/availability', { effectiveFrom: plus(20), windows: W }, 'cg1');
  assert.equal(r.status, 200);
  r = await call(h.app, 'POST', '/api/scheduling/availability', { effectiveFrom: plus(7), windows: W }, 'cg1');
  assert.equal(r.status, 200, 'the whole point of the report');
  // ...but a brand-new caregiver still owes the full lead time.
  r = await call(h.app, 'POST', '/api/scheduling/availability', { effectiveFrom: plus(7), windows: W }, 'cg2');
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'AVAILABILITY_LEAD_TIME');
});

test('ROUTE: who is refused recording for somebody else', async () => {
  const h = harness();
  await h.db.set('caregiver_availability', []);
  for (const [who, why] of [['mgr', 'managers were not included'], ['cg2', 'another caregiver'], ['client-1', 'a client']]) {
    const r = await call(h.app, 'POST', '/api/scheduling/availability',
      { caregiverId: 'cg1', effectiveFrom: plus(20), windows: W }, who);
    assert.equal(r.status, 403, why);
    assert.equal(r.body.code, 'AVAILABILITY_RECORDER_ONLY');
  }
  // A coordinator has no availability of their OWN to post.
  const own = await call(h.app, 'POST', '/api/scheduling/availability', { effectiveFrom: plus(20), windows: W }, 'coord');
  assert.equal(own.status, 403);
  assert.equal(own.body.code, 'SCHEDULING_STAFF_ONLY');
  // And nobody records availability for a client, who has none.
  const cl = await call(h.app, 'POST', '/api/scheduling/availability',
    { caregiverId: 'client-1', effectiveFrom: plus(20), windows: W }, 'coord');
  assert.equal(cl.status, 400);
  assert.equal(cl.body.code, 'CAREGIVER_NOT_SCHEDULABLE');
});

test('ROUTE: the office can read availability; a client still cannot', async () => {
  const h = harness();
  await h.db.set('caregiver_availability', []);
  await call(h.app, 'POST', '/api/scheduling/availability', { effectiveFrom: plus(20), windows: W }, 'cg1');
  for (const who of ['adm', 'mgr', 'coord']) {
    const r = await call(h.app, 'GET', '/api/scheduling/availability', null, who);
    assert.equal(r.status, 200, `${who} must be able to read what they may correct`);
  }
  const mine = await call(h.app, 'GET', '/api/scheduling/availability', null, 'cg1');
  assert.equal(mine.status, 200);
  const cl = await call(h.app, 'GET', '/api/scheduling/availability', null, 'client-1');
  assert.equal(cl.status, 403);

  // The floors are served, so no screen has to restate them.
  assert.equal(mine.body.rules.leadDays, sched.AVAILABILITY_LEAD_DAYS);
  assert.equal(mine.body.rules.changeLeadDays, sched.AVAILABILITY_CHANGE_LEAD_DAYS);
  assert.equal(mine.body.access.recordForOthers, false);
  const office = await call(h.app, 'GET', '/api/scheduling/availability', null, 'coord');
  assert.equal(office.body.access.recordForOthers, true);
});

test('ROUTE: append-only survives — the newest row is the one in force', async () => {
  const h = harness();
  await h.db.set('caregiver_availability', []);
  await call(h.app, 'POST', '/api/scheduling/availability', { effectiveFrom: plus(20), windows: W }, 'cg1');
  await call(h.app, 'POST', '/api/scheduling/availability',
    { effectiveFrom: plus(5), windows: [{ day: 'Fri', start: '12:00', end: '16:00' }] }, 'cg1');
  const r = await call(h.app, 'GET', '/api/scheduling/availability?caregiverId=cg1', null, 'adm');
  const rows = r.body.availability;
  assert.equal(rows.length, 2, 'nothing was overwritten');
  assert.equal(rows.filter(x => x.current).length, 1, 'exactly one is in force');
  assert.equal(rows.find(x => x.current).windows[0].day, 'Fri', 'and it is the newest');
});
