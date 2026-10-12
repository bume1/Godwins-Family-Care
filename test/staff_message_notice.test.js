// ============================================================================
// The STAFF half of the message notice (2026-10-12, owner-directed)
//
// The patient half follows the PHI-free rule. The staff half did not: it put
// `"<channel> — <client name>"` in the subject and the name again in the body,
// and it was NOT marked as PHI — so a transport outside the BAA would have
// sent "Clinical Escalation — Ada Bell" regardless. Every other staff notice
// in `notifications.js` gates its detail on the live transport; this one was
// the exception, and an exception nobody chose is a drift, not a decision.
//
// Driven through the SHIPPED messaging router on both transports. The wording
// is only ever visible in the delivered message: the first version of this
// change read "Ada Bell sent you a message about Ada Bell" on every
// client-written thread, which is most of them, and no amount of reading the
// diff showed it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { createNotifier } = require('../notifications');

const root = path.join(__dirname, '..');
const CLIENT = { id: 'c1', role: config.ROLES.CLIENT, name: 'Ada Bell', email: 'ada@test.local', slug: 'ada',
                 careTeam: { assignedFNPs: ['u1'], assignedCaseManager: 'm1' } };
const CLIN = { id: 'u1', role: config.ROLES.USER, name: 'Bethel Godwins', email: 'b@test.local',
               clinicalRole: 'provider', hasClinicalAccess: true };
const ADMIN = { id: 'a1', role: config.ROLES.ADMIN, name: 'GFC Admin', email: 'ad@test.local' };
const CM = { id: 'm1', role: config.ROLES.CASE_MANAGER, name: 'Courtney Hale', email: 'cm@test.local', assignedClients: ['c1'] };
const USERS = [CLIENT, CLIN, ADMIN, CM];

// Mounts the shipped router with the REAL notifier, exactly as server.js wires
// it. A harness that left `notify` out would exercise a different function.
const mount = async (t, { baaCovered = true, withNotifier = true } = {}) => {
  const store = new Map([['users', USERS]]);
  const db = { get: async k => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
               set: async (k, v) => store.set(k, JSON.parse(JSON.stringify(v))) };
  const notices = [];
  const queueNotification = async (type, id, email, name, data, o) => { notices.push({ type, email, data, o: o || {} }); return { id: 'q' }; };
  const notify = createNotifier({
    getUsers: async () => await db.get('users'), queueNotification,
    getAppBaseUrl: async () => 'https://app.test.local',
    emailTransport: { transportStatus: () => ({ baaCovered }) },
    staffRoles: [config.ROLES.ADMIN, config.ROLES.USER, config.ROLES.CASE_MANAGER],
    clientRole: config.ROLES.CLIENT, familyRole: config.ROLES.FAMILY
  });
  const app = express();
  app.use(express.json());
  app.use(require('../routes/messaging')({
    db, config, logActivity: async () => {}, queueNotification,
    getUsers: async () => await db.get('users'),
    authenticateToken: (req, _r, next) => { req.user = USERS.find(u => u.id === req.headers['x-as']); next(); },
    uuidv4: () => 'id-' + Math.random().toString(36).slice(2, 9),
    upload: { array: () => (q, r, n) => n() }, uploadLimiter: (q, r, n) => n(),
    googledrive: {}, detectFileType: () => null, contentDisposition: () => 'inline',
    ...(withNotifier ? { notify: () => notify } : {})
  }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const port = server.address().port;
  return {
    notices,
    open: async (as, channel, body = 'Please call me.') => {
      const res = await fetch(`http://127.0.0.1:${port}/api/messaging/threads`, {
        method: 'POST', headers: { 'x-as': as, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'c1', channel, subject: 'Subj', body })
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    },
    staff: () => notices.filter(n => n.email !== CLIENT.email)
  };
};

test('S1. on a covered transport a staff member is told which client and which conversation', async (t) => {
  const h = await mount(t, { baaCovered: true });
  assert.strictEqual((await h.open('c1', 'clinical_escalation')).status, 200);
  const m = h.staff()[0];
  assert.match(m.data.subject, /Clinical Escalation — Ada Bell/,
    'a notice that does not say which client is not actionable');
  assert.strictEqual(m.o.phi, true, 'it names a client, so it is marked as PHI');
  assert.ok(m.data.htmlBody, 'and it goes through the house template');
  assert.match(m.data.body, /not in this email/, 'the message itself is never carried');
});

test('S2. on an UNCOVERED transport it names no client and no conversation, and is not PHI', async (t) => {
  const h = await mount(t, { baaCovered: false });
  assert.strictEqual((await h.open('c1', 'clinical_escalation')).status, 200);
  const m = h.staff()[0];
  assert.ok(!/Ada Bell|Clinical Escalation/.test(m.data.subject + m.data.body),
    'no client name and no channel where the transport is not covered');
  assert.strictEqual(m.o.phi, false,
    'it carries nothing, so it is not refused outright — a staff member still learns something is waiting');
  assert.match(m.data.body, /Open the app to read it/, 'it still says what to do');
});

test('S3. "X sent you a message about X" never happens', async (t) => {
  const h = await mount(t, { baaCovered: true });
  assert.strictEqual((await h.open('c1', 'clinical_escalation')).status, 200);
  const m = h.staff()[0];
  assert.match(m.data.body, /Ada Bell sent you a message\./, 'said once when the sender is the client');
  assert.ok(!/about Ada Bell/.test(m.data.body), 'and never twice');
});

test('S4. a different sender IS named alongside the client, because they are two people', async (t) => {
  const h = await mount(t, { baaCovered: true });
  // Admin Direct carries every role, so an admin writing it reaches staff
  // recipients while the sender is somebody other than the client. (A clinician
  // on care_coordination is a 403: that channel is client + case manager only,
  // which is what the first version of this test got wrong.)
  assert.strictEqual((await h.open('a1', 'admin_direct')).status, 200);
  const staff = h.staff();
  assert.ok(staff.length > 0, 'a staff recipient must exist, or this proves nothing');
  for (const m of staff) {
    assert.match(m.data.body, /GFC Admin sent you a message about Ada Bell\./,
      'both names, because the sender and the subject are different people');
  }
});

test('S5. the CTA is resolved per recipient, never a single /portal', async (t) => {
  const h = await mount(t, { baaCovered: true });
  assert.strictEqual((await h.open('c1', 'clinical_escalation')).status, 200);
  const m = h.staff()[0];
  assert.strictEqual(m.data.ctaUrl, '/clinical',
    'a clinician reads messages in the workspace, not in the client portal');
});

test('S6. the patient half is untouched by this change', async (t) => {
  const h = await mount(t, { baaCovered: true });
  assert.strictEqual((await h.open('u1', 'care_team')).status, 200);
  const toPatient = h.notices.filter(n => n.email === CLIENT.email);
  assert.strictEqual(toPatient.length, 1);
  assert.ok(!/Ada Bell|Care Team/.test(toPatient[0].data.subject + toPatient[0].data.body),
    'still PHI-free, still names no channel');
});

test('S7. the detail rule lives in ONE place, and a missing notifier is loud', () => {
  const route = fs.readFileSync(path.join(root, 'routes', 'messaging.js'), 'utf8');
  assert.ok(!/transportStatus|baaCovered/.test(route),
    'the router must not re-derive how much an email may say');
  assert.match(route, /staff were NOT told a message is waiting/,
    'a missing notifier is reported, never a silent skip');
  assert.ok(!/subject: `\$\{label\} — \$\{thread\.client_name\}`/.test(route),
    'the hand-rolled staff subject is gone');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /messagingRoutes\(\{[\s\S]{0,700}?notify: \(\) => notify/,
    'server.js must inject the notifier, or staff stop being told');
});

test('S8. no notifier means nothing is sent to staff, and it is reported', async (t) => {
  const h = await mount(t, { baaCovered: true, withNotifier: false });
  assert.strictEqual((await h.open('c1', 'clinical_escalation')).status, 200,
    'the message still sends — the notice is best-effort and must not fail it');
  assert.strictEqual(h.staff().length, 0, 'and no staff notice goes out');
});
