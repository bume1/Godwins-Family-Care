'use strict';

// My GFC, the staff portal, through the real router over HTTP with a fake
// store and a fake Drive. Assertions read what was stored or returned.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const portal = require('../routes/staffPortal');

const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin', email: 'admin@gfc.test' };
const COORD = { id: 'k1', name: 'Coco Ordinator', role: 'user', accountType: 'coordinator', email: 'coco@gfc.test' };
const NP = { id: 'n1', name: 'Bethel Godwins', email: 'Bethel@GFC.test', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const CLIENT = { id: 'p1', name: 'Pat Client', role: 'client', accountType: 'client' };
const CLIENT2 = { id: 'p2', name: 'Quinn Other', role: 'client', accountType: 'client', intake: { medications: ['secret'] } };
const LIAISON = { id: 'l1', name: 'Lia Ison', role: 'liaison', accountType: 'liaison', email: 'lia@gfc.test', assignedClients: ['p1'] };

// A tiny Drive: ROOT holds a subfolder SUB and a file; OTHER is a folder
// nobody assigned.
const TREE = {
  ROOT: [{ id: 'SUB', name: 'Forms', isFolder: true }, { id: 'F1', name: 'Protocol.pdf', isFolder: false, webViewLink: 'https://drive.google.com/file/d/F1/view' }],
  SUB: [{ id: 'F2', name: 'Intake form.docx', isFolder: false, webViewLink: 'https://drive.google.com/file/d/F2/view' }],
  OTHER: [{ id: 'SECRET', name: 'Payroll.xlsx', isFolder: false, webViewLink: 'x' }]
};

async function mount(t, opts = {}) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = ADMIN;
  const logged = [];
  const uploads = [];
  const drive = {
    listFolderChildren: async (id) => { if (!TREE[id]) throw new Error('File not found'); return TREE[id]; },
    getFileFingerprint: async (id) => ({ mimeType: TREE[id] ? 'application/vnd.google-apps.folder' : 'application/pdf' }),
    downloadFileBuffer: async () => Buffer.from('%PDF-1.4 test'),
    uploadStaffDocumentFile: async (role, person, name) => { uploads.push({ role, person, name }); return { fileId: `DRV_${uploads.length}_xxxxxx` }; },
    describeDriveError: (e) => ({ reason: e.message })
  };
  const app = express();
  app.use(express.json());
  app.use(portal({
    db, uuidv4: () => Math.random().toString(36).slice(2), drive, payrollIngestKey: opts.key === undefined ? 'k3y-payroll' : opts.key,
    detectFileType: (buf) => (buf.slice(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : buf.slice(0, 4).toString() === '%PDF' ? 'application/pdf' : null),
    logActivity: async (...a) => { logged.push(a); },
    getUsers: async () => [ADMIN, COORD, NP, RN, CG, CLIENT, LIAISON, CLIENT2],
    enrollmentSummary: (c) => ({ id: c.id, name: c.name, reviewState: 'intake_pending', completionPct: 40, stillNeeded: { consents: ['Service Agreement'], details: [] } }),
    authenticateToken: (req, _res, next) => { req.user = current; next(); }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers) => {
    const res = await fetch(base + p, { method, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* binary */ }
    return { status: res.status, data };
  };
  return { store, logged, uploads, call, base, as: (u) => { current = u; } };
}

const addFolder = async (h, body) => {
  h.as(ADMIN);
  const r = await h.call('POST', '/api/my/admin/folders', Object.assign({ link: 'https://drive.google.com/drive/folders/ROOTROOTROOT', label: 'Clinical Forms' }, body));
  return r;
};

test('a folder assigned to clinicians reaches a clinician, not a caregiver or a client', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  const r = await addFolder(h, { types: ['provider'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(h.store.staff_portal_folders[0].folderId, 'ROOTROOTROOT');
  h.as(NP);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders.map(f => f.label), ['Clinical Forms']);
  h.as(RN);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders, []);
  h.as(CG);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders, []);
  h.as(CLIENT);
  assert.strictEqual((await h.call('GET', '/api/my/folders')).data.code, 'STAFF_PORTAL_STAFF_ONLY');
});

test('a folder assigned to one person by name reaches only that person', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  await addFolder(h, { userIds: [RN.id] });
  h.as(RN);
  assert.strictEqual((await h.call('GET', '/api/my/folders')).data.folders.length, 1);
  h.as(NP);
  assert.strictEqual((await h.call('GET', '/api/my/folders')).data.folders.length, 0);
});

test('she browses down into a subfolder, and never outside the folder assigned to her', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  await addFolder(h, { types: ['provider'] });
  const id = h.store.staff_portal_folders[0].id;
  h.as(NP);
  const top = await h.call('GET', `/api/my/folders/${id}/items`);
  assert.deepStrictEqual(top.data.items.map(i => i.name), ['Forms', 'Protocol.pdf']);
  assert.strictEqual(top.data.items[1].url, 'https://drive.google.com/file/d/F1/view');
  const sub = await h.call('GET', `/api/my/folders/${id}/items?path=SUB`);
  assert.deepStrictEqual(sub.data.items.map(i => i.name), ['Intake form.docx']);
  assert.deepStrictEqual(sub.data.crumbs, [{ id: 'SUB', name: 'Forms' }]);
  const escape = await h.call('GET', `/api/my/folders/${id}/items?path=OTHER`);
  assert.strictEqual(escape.status, 404);
  assert.strictEqual(escape.data.code, 'FOLDER_OUTSIDE_SCOPE');
  assert.ok(!JSON.stringify(escape.data).includes('Payroll'));
  // A file id is not a folder to step into either.
  assert.strictEqual((await h.call('GET', `/api/my/folders/${id}/items?path=F1`)).data.code, 'FOLDER_OUTSIDE_SCOPE');
  // Someone the folder is not assigned to cannot list it by id.
  h.as(CG);
  assert.strictEqual((await h.call('GET', `/api/my/folders/${id}/items`)).status, 404);
});

test('only an administrator adds folders, and a bad link or a file is refused before anything is stored', async (t) => {
  const h = await mount(t);
  h.as(NP);
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'ROOTROOTROOT', label: 'x', types: ['provider'] })).data.code, 'STAFF_PORTAL_ADMIN_ONLY');
  h.as(ADMIN);
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'not a link', label: 'x', types: ['provider'] })).data.code, 'FOLDER_LINK_INVALID');
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'https://drive.google.com/drive/folders/ROOTROOTROOT', label: 'x' })).data.code, 'FOLDER_AUDIENCE_REQUIRED');
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'https://drive.google.com/file/d/APDFFILE1234/view', label: 'x', types: ['provider'] })).data.code, 'FOLDER_LINK_INVALID');
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'APDFFILE1234', label: 'x', types: ['provider'] })).data.code, 'FOLDER_NOT_A_FOLDER');
  assert.strictEqual(h.store.staff_portal_folders, undefined);
});

test('removing a folder takes it off everyone\'s list', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  await addFolder(h, { types: ['provider'] });
  const id = h.store.staff_portal_folders[0].id;
  await h.call('DELETE', `/api/my/admin/folders/${id}`);
  assert.deepStrictEqual(h.store.staff_portal_folders, []);
  h.as(NP);
  assert.strictEqual((await h.call('GET', `/api/my/folders/${id}/items`)).status, 404);
});

test('my documents are mine: another person\'s reads as absent and no Drive id leaves the server', async (t) => {
  const h = await mount(t);
  h.store.caregiver_documents = [
    { id: 'd1', caregiver_id: NP.id, kind: 'clinician_onboarding', file_name: 'license.pdf', drive_file_id: 'DRIVE_SECRET', status: 'accepted', uploaded_at: '2026-11-01', uploaded_by_office: true, uploaded_by_name: 'Office Admin' },
    { id: 'd2', caregiver_id: CG.id, kind: 'timesheet', file_name: 'week.pdf', drive_file_id: 'DRIVE_OTHER', status: 'received', uploaded_at: '2026-11-02' }
  ];
  h.as(NP);
  const list = await h.call('GET', '/api/my/documents');
  assert.deepStrictEqual(list.data.documents.map(d => d.id), ['d1']);
  assert.strictEqual(list.data.documents[0].filedByOffice, true);
  assert.ok(!JSON.stringify(list.data).includes('DRIVE_SECRET'));
  assert.strictEqual((await h.call('GET', '/api/my/documents/d2/file')).status, 404);
  const own = await h.call('GET', '/api/my/documents/d1/file');
  assert.strictEqual(own.status, 200);
  assert.ok(h.logged.some(a => a[2] === 'staff_portal_document_read'));
});

test('what she signed at onboarding shows in My Documents, not only in onboarding', async (t) => {
  const h = await mount(t);
  h.store.onboarding_records = [{ userId: NP.id, items: { 'C.5.04': { acknowledgments: {
    CLINICAL_MANUAL: { version: '2.2', at: '2026-11-05T15:00:00Z', byName: 'Bethel Godwins', filedBy: 'SELF' },
    EMPLOYEE_HANDBOOK: { version: '1.0', at: '2026-11-04T15:00:00Z', byName: 'Office Admin', filedBy: 'OFFICE_ON_BEHALF' }
  } } } }];
  h.as(NP);
  const d = (await h.call('GET', '/api/my/documents')).data;
  const clin = d.signed.find(x => x.id === 'ack:CLINICAL_MANUAL');
  assert.strictEqual(clin.version, '2.2');
  assert.strictEqual(clin.current, true);
  assert.ok(clin.links[0].includes('1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6'), 'the canonical copy');
  const hb = d.signed.find(x => x.id === 'ack:EMPLOYEE_HANDBOOK');
  assert.strictEqual(hb.current, false, 'an older version reads as not current');
  assert.strictEqual(hb.filedByOffice, true);
  h.as(RN);
  assert.deepStrictEqual((await h.call('GET', '/api/my/documents')).data.signed, [], 'never another person\'s');
});

test('policies are the live library: canonical copy, scoped by role, flagged when updated since she signed', async (t) => {
  const ids = (ty) => portal.policiesFor(ty).map(p => p.id);
  assert.ok(ids('provider').includes('CLINICAL_MANUAL') && !ids('provider').includes('ADMIN_MANUAL'));
  for (const ty of ['admin', 'manager', 'coordinator']) {
    assert.ok(ids(ty).includes('ADMIN_MANUAL'), ty);
    assert.ok(!ids(ty).includes('CLINICAL_MANUAL') && !ids(ty).includes('FIELD_ADDENDUM'), ty);
  }
  assert.ok(ids('caregiver').includes('FIELD_ADDENDUM') && !ids('caregiver').includes('CLINICAL_MANUAL'));
  const h = await mount(t);
  h.store.onboarding_records = [{ userId: NP.id, items: { 'C.5.04': { acknowledgments: {
    CLINICAL_MANUAL: { version: '2.2', at: '2026-11-05T15:00:00Z' }, EMPLOYEE_HANDBOOK: { version: '1.0', at: '2026-11-04T15:00:00Z' } } } } }];
  h.as(NP);
  const pol = (await h.call('GET', '/api/my/policies')).data.policies;
  const clin = pol.find(p => p.id === 'CLINICAL_MANUAL');
  assert.ok(clin.url.includes('1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6') && clin.previewUrl.endsWith('/preview'), 'the canonical copy');
  assert.strictEqual(clin.signed.current, true);
  assert.strictEqual(pol.find(p => p.id === 'EMPLOYEE_HANDBOOK').signed.current, false, 'updated since she signed');
  assert.strictEqual(pol.find(p => p.id === 'CODE_OF_CONDUCT').signed, null);
});

test('a caregiver\'s signed welcome packet and attestations are in her documents', async (t) => {
  const h = await mount(t);
  h.store.welcome_packets = [{ caregiver_id: CG.id, signed_at: '2026-10-01T12:00:00Z' }];
  h.store.caregiver_attestations = [{ caregiver_id: CG.id, kind: 'mandatory_reporter', version: '1', signed_at: '2026-10-01T12:05:00Z' }];
  h.as(CG);
  const d = (await h.call('GET', '/api/my/documents')).data;
  assert.deepStrictEqual(d.signed.map(x => x.id).sort(), ['attestation:mandatory_reporter', 'packet']);
  assert.ok(d.signed.find(x => x.pdf === 'attestation').title.length > 3);
});

const STUB = { email: 'bethel@gfc.test', payDate: '2026-11-14', periodStart: '2026-11-01', periodEnd: '2026-11-14', gross: 1520, net: 1268.42, hours: 76, reference: 'RUN-1' };
const PAY = (h, body, key) => h.call('POST', '/api/payroll/paystubs', body, key === null ? {} : { 'X-GFC-Payroll-Key': key || 'k3y-payroll' });

test('the payroll script\'s door is shut without the key, and with no key configured', async (t) => {
  const h = await mount(t);
  assert.strictEqual((await PAY(h, { stubs: [STUB] }, null)).data.code, 'PAYROLL_KEY_INVALID');
  assert.strictEqual((await PAY(h, { stubs: [STUB] }, 'wrong-key-xx')).data.code, 'PAYROLL_KEY_INVALID');
  assert.strictEqual(h.store.staff_paystubs, undefined);
  const off = await mount(t, { key: '' });
  const r = await PAY(off, { stubs: [STUB] });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.data.code, 'PAYROLL_INGEST_NOT_CONFIGURED');
});

test('pay stubs land on the right person by email, a re-run replaces, and bad rows are reported', async (t) => {
  const h = await mount(t);
  const pdf = Buffer.from('%PDF-1.4 stub').toString('base64');
  const r = await PAY(h, { stubs: [Object.assign({ pdfBase64: pdf }, STUB),
    Object.assign({}, STUB, { email: 'nobody@gfc.test' }),
    Object.assign({}, STUB, { payDate: '11/14/2026' }),
    Object.assign({}, STUB, { email: 'pat@gfc.test', pdfBase64: Buffer.from('not a pdf').toString('base64') })] });
  assert.strictEqual(r.data.stored, 1);
  assert.deepStrictEqual(r.data.skipped.map(x => x.row), [1, 2, 3]);
  assert.strictEqual(h.uploads[0].role, 'GFC Clinician Documents');
  assert.strictEqual(h.store.staff_paystubs[0].userId, NP.id);
  const again = await PAY(h, { stubs: [Object.assign({}, STUB, { net: 1300 })] });
  assert.strictEqual(again.data.updated, 1);
  assert.strictEqual(h.store.staff_paystubs.length, 1);
  assert.strictEqual(h.store.staff_paystubs[0].net, 1300);
  h.as(NP);
  const mine = (await h.call('GET', '/api/my/paystubs')).data.paystubs;
  assert.strictEqual(mine.length, 1);
  assert.ok(!JSON.stringify(mine).includes('DRV_'), 'no Drive id to the browser');
  h.as(RN);
  assert.deepStrictEqual((await h.call('GET', '/api/my/paystubs')).data.paystubs, []);
  assert.strictEqual((await h.call('GET', `/api/my/paystubs/${mine[0].id}/file`)).status, 404, 'another person\'s stub reads as absent');
});

test('her headshot and bio: she keeps her own, the admin team (coordinators included) reads them', async (t) => {
  const h = await mount(t);
  h.as(NP);
  const long = await h.call('PUT', '/api/my/bio', { bio: 'x'.repeat(3001) });
  assert.strictEqual(long.data.code, 'BIO_TOO_LONG');
  await h.call('PUT', '/api/my/bio', { title: 'Family Nurse Practitioner', bio: 'Bethel has cared for families for twenty years.' });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('ffd8ffe000104a464946', 'hex')], { type: 'image/jpeg' }), 'me.jpg');
  const up = await fetch(`${h.base}/api/my/bio/headshot`, { method: 'POST', body: fd });
  assert.strictEqual(up.status, 200);
  assert.strictEqual((await up.json()).hasHeadshot, true);
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'image/jpeg' }), 'x.jpg');
  assert.strictEqual((await (await fetch(`${h.base}/api/my/bio/headshot`, { method: 'POST', body: bad })).json()).code, 'HEADSHOT_TYPE');
  assert.strictEqual((await h.call('GET', '/api/my/admin/bios')).data.code, 'STAFF_PORTAL_ADMIN_ONLY');
  h.as(COORD);
  const team = (await h.call('GET', '/api/my/admin/bios')).data.team;
  const her = team.find(p => p.id === NP.id);
  assert.strictEqual(her.title, 'Family Nurse Practitioner');
  assert.strictEqual(her.hasHeadshot, true);
  assert.ok(!team.some(p => p.id === CLIENT.id), 'clients are not on the team');
  assert.strictEqual((await h.call('GET', `/api/my/admin/bios/${NP.id}/headshot`)).status, 200);
});

test('the admin team manages shared folders: a care coordinator can, a clinician cannot', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  h.as(COORD);
  const r = await h.call('POST', '/api/my/admin/folders', { link: 'ROOTROOTROOT', label: 'Office Forms', types: ['admin', 'manager', 'coordinator'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders.map(f => f.label), ['Office Forms']);
});

test('a shared file is never streamed by the app: the folder route returns Drive links only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'staffPortal.js'), 'utf8');
  const at = src.indexOf("router.get('/api/my/folders/:id/items'");
  const body = src.slice(at, src.indexOf('// ---- pay stubs', at));
  assert.ok(at > 0 && body.length > 200);
  assert.ok(!/downloadFileBuffer|res\.send\(/.test(body));
});

test('a community care liaison lands in My GFC and sees only the enrollment summary of her own clients', async (t) => {
  const at = require('../accountTypes');
  const f = at.fieldsFor('liaison');
  assert.strictEqual(f.role, 'liaison');
  assert.strictEqual(f.hasClinicalAccess, false);
  assert.strictEqual(at.landingFor(f), '/my');
  assert.deepStrictEqual(at.hubTilesFor(f).map(x => x.id), ['myGfc'], 'the hub offers only My GFC, never the clinical workspace');
  assert.ok(require('../config').MFA_REQUIRED_ROLES.includes('liaison'), 'two-step sign-in: they read client names');
  const h = await mount(t);
  h.as(LIAISON);
  const p = (await h.call('GET', '/api/my/profile')).data;
  assert.strictEqual(p.isLiaison, true);
  const r = (await h.call('GET', '/api/my/clients')).data.clients;
  assert.deepStrictEqual(r.map(c => c.id), ['p1'], 'only the clients assigned to her');
  assert.ok(!JSON.stringify(r).includes('secret'));
  h.as(NP);
  assert.strictEqual((await h.call('GET', '/api/my/clients')).data.code, 'LIAISON_ONLY');
  h.as(COORD);
  assert.strictEqual((await h.call('GET', '/api/my/clients')).data.code, 'LIAISON_ONLY');
});

test('the server tells a liaison only status and what is still needed, never the intake', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('const liaisonEnrollmentView = (client) => {');
  const body = src.slice(at, src.indexOf('};', at));
  assert.ok(at > 0);
  assert.ok(!/intake|dob|careTier|consents\s*:/.test(body.replace(/stillNeeded: \{ consents: comp\.missingConsentLabels/, '')), 'nothing beyond the summary');
});

test('the portal page and the ways into it', () => {

  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  assert.match(read('clinical.html'), /\{ key: 'mygfc', tab: 'My GFC', icon: 'ti-id-badge-2', group: 'foot', href: '\/my' \}/, 'My GFC is in the clinical sidebar');
  assert.ok(!/href="\/onboarding"/.test(read('clinical.html')), 'clinicians reach onboarding through My GFC now');
  // The caregiver app IS a caregiver's My GFC: the shared frame and sections.
  const cg = read('caregiver.html');
  assert.match(cg, /<script type="text\/babel" src="\/my-gfc\.js"><\/script>/);
  assert.match(cg, /<window\.MyGFC\.Shell /);
  for (const id of ['documents', 'policies', 'folders', 'hours', 'account']) assert.ok(cg.includes(`'${id}'`), id);
  assert.match(read('my.html'), /profile\.isCaregiver\) \{ window\.location\.replace\(`\/caregiver/, 'a caregiver opening /my lands in their own My GFC');
  const at = require('../accountTypes');
  for (const t of ['admin', 'manager', 'coordinator']) assert.strictEqual(at.hubTilesFor(at.fieldsFor(t))[0].id, 'myGfc', t);
  const page = read('my.html');
  assert.match(page, /<script src="\/session-guard\.js"><\/script>/);
  for (const f of ['my.html', 'my-gfc.js']) assert.ok(!/drive_file_id|driveFileId/.test(read(f)), `${f} never handles a Drive id`);
});

test('the request user carries employmentType, or the W-2 clock refuses every W-2 person', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf('      req.user = {');
  const body = src.slice(at, src.indexOf('};', at));
  assert.ok(at > 0 && /employmentType: freshUser\.employmentType \|\| null/.test(body));
});

test('the private home care P&P is in the policies of RNs and caregivers, not clinicians or the office', () => {
  const ids = (ty) => portal.policiesFor(ty).map(p => p.id);
  assert.ok(ids('rn').includes('PHC_MANUAL') && ids('caregiver').includes('PHC_MANUAL'));
  assert.ok(!ids('provider').includes('PHC_MANUAL') && !ids('admin').includes('PHC_MANUAL'));
});
