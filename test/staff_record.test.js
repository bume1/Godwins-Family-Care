'use strict';
// One full record per employee in User Management (owner, 2026-11-09): the
// office reads everything on file for any staff member through ONE function,
// the caregiver office (not only the Super Admin) runs caregiver onboarding,
// Caregiver Management is a to-do list that opens records, and a caregiver
// sees everything they filed in full.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// ---- the office's read of one person's documents ----------------------------
const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'admin@gfc.test' };
const COORD = { id: 'k1', name: 'Coco Ordinator', role: 'user', accountType: 'coordinator', isManager: true };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const CLIENT = { id: 'p1', name: 'Pat Client', role: 'client', accountType: 'client' };

async function mountPortal(t) {
  const store = {
    caregiver_documents: [
      { id: 'd1', caregiver_id: 'c1', kind: 'timesheet', file_name: 'week.pdf', status: 'received', uploaded_at: '2026-11-02' },
      { id: 'd2', caregiver_id: 'r1', kind: 'clinician_onboarding', file_name: 'license.pdf', status: 'accepted', uploaded_at: '2026-11-01', uploaded_by_office: true },
      { id: 'd3', caregiver_id: 'c1', kind: 'w9', file_name: 'old.pdf', status: 'accepted', uploaded_at: '2026-10-01', deleted_at: '2026-10-05' }
    ],
    welcome_packets: [{ caregiver_id: 'c1', signed_at: '2026-10-20T12:00:00Z' }]
  };
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = v; } };
  let current = ADMIN;
  const logged = [];
  const app = express();
  app.use(express.json());
  app.use(require('../routes/staffPortal')({
    db, uuidv4: () => 'x', drive: {}, detectFileType: () => null,
    logActivity: async (...a) => { logged.push(a); },
    getUsers: async () => [ADMIN, COORD, RN, CG, CLIENT],
    enrollmentSummary: () => ({}),
    authenticateToken: (req, _res, next) => { req.user = current; next(); }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const res = await fetch(base + p); let data = null; try { data = await res.json(); } catch (e) { /* none */ } return { status: res.status, data }; };
  return { get, logged, as: (u) => { current = u; } };
}

test('the office reads exactly what each person sees on their own My Documents', async (t) => {
  const h = await mountPortal(t);
  for (const person of [CG, RN]) {
    h.as(person);
    const own = await h.get('/api/my/documents');
    for (const office of [ADMIN, COORD]) {
      h.as(office);
      const theirs = await h.get(`/api/my/admin/people/${person.id}/documents`);
      assert.strictEqual(theirs.status, 200, `${office.name} reads ${person.name}`);
      assert.deepStrictEqual(theirs.data, own.data, 'one function answers both, so they cannot drift');
    }
  }
  h.as(ADMIN);
  const cg = await h.get('/api/my/admin/people/c1/documents');
  assert.deepStrictEqual(cg.data.documents.map(d => d.id), ['d1'], 'a deleted file is not shown');
  assert.ok(cg.data.signed.some(s => s.id === 'packet'), 'a caregiver\'s signed welcome packet is listed');
  assert.ok(h.logged.some(a => a[2] === 'staff_record_documents_read' && a[4] === 'c1'), 'the read is logged');
});

test('only the office reads someone else\'s documents, and a client is not staff', async (t) => {
  const h = await mountPortal(t);
  for (const who of [CG, RN]) {
    h.as(who);
    assert.strictEqual((await h.get('/api/my/admin/people/c1/documents')).status, 403, who.name);
  }
  h.as(ADMIN);
  assert.strictEqual((await h.get('/api/my/admin/people/p1/documents')).status, 404, 'a client has no staff record');
  assert.strictEqual((await h.get('/api/my/admin/people/nobody/documents')).status, 404);
});

// ---- caregiver onboarding belongs to the caregiver office --------------------
const config = require('../config');
const MANAGER = { id: 'm1', name: 'Morgan Manager', role: 'user', accountType: 'manager', isManager: true };
const WP_CG = { id: 'cg1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'vendor', licenseLevel: 'cna' };

async function mountPackets(t, as) {
  const store = {};
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/welcomePacket')({
    db, config, logActivity: async () => {}, queueNotification: async () => {},
    getUsers: async () => [WP_CG, ADMIN, MANAGER, COORD],
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => 'x', drive: {}, detectFileType: () => null, hashIp: () => 'h'
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store,
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, data: await r.json().catch(() => null) }; },
    put: async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; }
  };
}

test('a manager and a care coordinator run caregiver onboarding, not only the Super Admin', async (t) => {
  for (const office of [ADMIN, MANAGER, COORD]) {
    const h = await mountPackets(t, office);
    const q = await h.get('/api/caregiver/admin/welcome-packets');
    assert.strictEqual(q.status, 200, `${office.name} reads the queue`);
    const one = await h.get('/api/caregiver/admin/welcome-packets/cg1');
    assert.strictEqual(one.status, 200, `${office.name} reads one caregiver`);
    assert.strictEqual(one.data.caregiver.caregiverId, 'cg1');
    assert.deepStrictEqual(one.data.caregiver, q.data.caregivers.find(c => c.caregiverId === 'cg1'),
      'the one-person read and the queue are built by the same function');
    const kind = one.data.officeItems[0].kind;
    const set = await h.put('/api/caregiver/admin/welcome-packets/cg1/office-item', { kind, status: 'done' });
    assert.strictEqual(set.status, 200, `${office.name} sets an office item`);
  }
  const h = await mountPackets(t, ADMIN);
  assert.strictEqual((await h.get('/api/caregiver/admin/welcome-packets/nobody')).status, 404);
});

test('a caregiver cannot read the queue or another caregiver\'s onboarding', async (t) => {
  const h = await mountPackets(t, WP_CG);
  assert.strictEqual((await h.get('/api/caregiver/admin/welcome-packets')).status, 403);
  assert.strictEqual((await h.get('/api/caregiver/admin/welcome-packets/cg1')).status, 403);
  const kind = require('../welcomePacketRepository').OFFICE_ITEM_KINDS[0];
  assert.strictEqual((await h.put('/api/caregiver/admin/welcome-packets/cg1/office-item', { kind, status: 'done' })).status, 403,
    'a caregiver cannot mark their own fingerprinting done');
});

// ---- the record page ----------------------------------------------------------
const HUB = read('public/admin-hub.html');

// The section list is plain JS inside the page; lift it out and run it.
function sectionsFn() {
  const a = HUB.indexOf('const srIsCaregiver = ');
  const b = HUB.indexOf('const srJump = ');
  assert.ok(a > 0 && b > a, 'the section list moved');
  // eslint-disable-next-line no-new-func
  return new Function(`${HUB.slice(a, b)}; return staffRecordSections;`)();
}

test('every staff member gets a full record; caregivers and clinicians get their own sections', () => {
  const sections = sectionsFn();
  const ids = (u, sa) => sections(u, sa).map(s => s.id);
  assert.deepStrictEqual(ids({ role: 'vendor', licenseLevel: 'cna' }, true),
    ['sr-account', 'sr-credentials', 'sr-pay', 'sr-documents', 'sr-onboarding', 'sr-welcome', 'sr-bio', 'sr-activity', 'sr-recovery']);
  assert.deepStrictEqual(ids({ role: 'user', hasClinicalAccess: true }, false),
    ['sr-account', 'sr-credentials', 'sr-documents', 'sr-onboarding', 'sr-welcome', 'sr-bio'], 'no pay or activity for a clinician; recovery is the Super Admin\'s');
  assert.deepStrictEqual(ids({ role: 'liaison' }, false), ['sr-account', 'sr-documents', 'sr-onboarding', 'sr-welcome', 'sr-bio']);
  // Every anchor the menu jumps to exists on the page.
  for (const id of ['sr-account', 'sr-credentials', 'sr-pay', 'sr-documents', 'sr-onboarding', 'sr-welcome', 'sr-bio', 'sr-activity', 'sr-recovery']) {
    assert.ok(HUB.includes(`id="${id}"`) || HUB.includes(`'${id}' : undefined`), `nothing on the page carries ${id}`);
  }
});

test('a staff member opens as a page; a new account, a client and a family contact keep the pop-up', () => {
  const code = strip(HUB);
  assert.match(code, /const recordUser = showForm && editingUser && !\['client', 'family'\]\.includes\(editingUser\.role\) \? editingUser : null;/);
  assert.match(code, /className=\{recordUser \? 'staff-record' : 'fixed inset-0/);
  assert.match(code, /<div className=\{recordUser \? 'space-y-6 sr-open' : 'space-y-6'\}>/);
  assert.match(HUB, /\.sr-open > \*:not\(\.staff-record\) \{ display: none !important; \}/, 'the list steps aside while a record is open');
  assert.match(code, /\{recordUser && <StaffRecordPanels token=\{token\} user=\{recordUser\} \/>\}/);
  // The documents card moved into the record's Documents section, not shown twice.
  assert.match(code, /editingUser && !recordUser && \(\s*<CaregiverDocsSection/);
  assert.match(code, /<CaregiverDocsSection token=\{token\} caregiverId=\{user\.id\} caregiverName=\{user\.name\} inRecord \/>/);
  // A document waiting on review is accepted or sent back on the record itself.
  assert.match(code, /\{d\.status === 'received' && \(/);
  assert.match(code, /\/api\/caregiver\/documents\/\$\{encodeURIComponent\(d\.id\)\}\/review`/);
  // It has an address the queues can link to.
  assert.match(code, /get\('person'\)/);
});

test('the record reads each part from the route that owns it', () => {
  const code = strip(HUB);
  for (const route of ['/api/my/admin/people/', '/api/onboarding/admin/people/', '/api/caregiver/admin/welcome-packets/',
    '/api/caregiver/welcome-packet/signed.pdf?caregiverId=', '/api/caregiver/welcome-packet/attestations/']) {
    assert.ok(code.includes(route), route);
  }
  assert.match(code, /\/office-item`, \{ method: 'PUT'/, 'office items are set from the record');
  assert.match(code, /href=\{`\/onboarding\?person=\$\{encodeURIComponent\(user\.id\)\}`\}/, 'the full checklist is one click away');
  assert.match(read('public/onboarding.html'), /get\('person'\)/, 'and onboarding opens to that person');
  // Components at module scope, never inside another (the file input would reset).
  for (const c of ['StaffRecordTop', 'StaffRecordMenu', 'StaffSignedList', 'StaffOnboardingPanel', 'StaffActivityPanel', 'StaffRecordSec', 'StaffRecordPanels']) {
    assert.match(HUB, new RegExp(`\\n    const ${c} = `), `${c} is declared at the page's top level`);
  }
});

// ---- Caregiver Management is a to-do list -------------------------------------
test('Caregiver Management lists only what is waiting, and every row opens the person\'s record', () => {
  const code = strip(read('public/caregivers.html'));
  assert.match(code, /const recordHref = \(userId, section\) => `\/admin\?view=users&person=\$\{encodeURIComponent\(userId\)\}#\$\{section\}`;/);
  assert.match(code, /const waiting = rows\.filter\(d => d\.status === 'received'\);/, 'only documents waiting on review');
  assert.match(code, /recordHref\(d\.caregiverId, 'sr-documents'\)/);
  assert.match(code, /const notCleared = all\.filter\(c => !c\.cleared\);/, 'only caregivers not yet cleared');
  assert.match(code, /recordHref\(c\.caregiverId, 'sr-onboarding'\)/);
  assert.match(code, /label: 'Documents to Review'/);
  assert.match(code, /label: 'Not Yet Cleared'/);
});

// ---- the caregiver sees what they filed, in full ------------------------------
test('a caregiver opens every visit log and concern they filed, in full', () => {
  const code = strip(read('public/caregiver.html'));
  assert.match(code, /visitLogs\.slice\(0, 50\)\.map\(v => <MyVisitLogRow key=\{v\.id\} v=\{v\} \/>\)/);
  assert.match(code, /\{open && <FiledVisitLog d=\{v\.detail\} \/>\}/, 'the full log is the server\'s labelled sections');
  assert.match(code, /escalations\.map\(e => <MyConcernRow key=\{e\.id\} e=\{e\} \/>\)/, 'every concern, open or resolved');
  assert.match(code, /<MoreTab visitLogs=\{visitLogs\} escalations=\{escalations\}/);
  for (const c of ['FiledBlock', 'FiledVisitLog', 'MyVisitLogRow', 'MyConcernRow']) {
    assert.match(read('public/caregiver.html'), new RegExp(`\\nconst ${c} = `), `${c} at module scope`);
  }
  // Read-only: nothing in the view posts or edits a filed log.
  const a = code.indexOf('const FiledBlock'); const b = code.indexOf('const MoreTab');
  assert.ok(!/method: '(POST|PUT|DELETE)'/.test(code.slice(a, b)));
});

test('the escalation list says who raised each one, so a record can list a caregiver\'s own', () => {
  assert.match(read('routes/caregiver.js'), /caregiverId: e\.caregiver_id,/);
});
