// ============================================================================
// Order detail, notes and files (owner, 2026-09-29) + the stale "Resume draft"
// banner. What this pins:
//   1. A note and a file are APPEND-ONLY records beside the order; neither one
//      touches the order's status or clinical content.
//   2. Attachments are typed by their bytes, refused when storage fails, and a
//      browser never sees the storage id.
//   3. The same people who may edit a destination may annotate (case managers
//      included) and nobody else; the audit rows carry no note text.
//   4. The Orders tab lists EVERY order type.
//   5. The banner cannot outlive the note: a stale scratch row never masks the
//      shared draft, and the page refreshes the chart after an encounter action.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const orderReq = require('../orderRequisitions');
const roles = require('../clinicalRoles');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');

const ACTOR = { id: 'u1', name: 'Courtney Hale' };
const AT = '2026-09-29T15:00:00.000Z';
const baseOrder = () => ({ id: 'o1', clientId: 'c1', orderType: 'referral', status: 'ordered', orderReference: 'GFC-ORD-ABC234', sends: [] });

// ── pure module ────────────────────────────────────────────────────────────

test('a note is appended with who and when, and nothing else on the order moves', () => {
  const o = baseOrder();
  const r = orderReq.buildOrderNote({ order: o, text: '  Spoke to intake  ', actor: ACTOR, at: AT, id: 'n1' });
  assert.equal(r.order.orderNotes.length, 1);
  assert.equal(r.order.orderNotes[0].text, 'Spoke to intake');
  assert.equal(r.order.orderNotes[0].by.name, 'Courtney Hale');
  assert.equal(r.order.status, 'ordered');
  const r2 = orderReq.buildOrderNote({ order: r.order, text: 'Second', actor: ACTOR, at: AT, id: 'n2' });
  assert.deepEqual(r2.order.orderNotes.map(n => n.id), ['n1', 'n2'], 'append-only, in order');
  assert.equal(o.orderNotes, undefined, 'the input order is not mutated');
});

test('a blank note and an over-long note are refused by code', () => {
  assert.equal(orderReq.buildOrderNote({ order: baseOrder(), text: '   ', actor: ACTOR, at: AT, id: 'n' }).code, 'ORDER_NOTE_EMPTY');
  const big = 'x'.repeat(orderReq.ORDER_NOTE_MAX + 1);
  assert.equal(orderReq.buildOrderNote({ order: baseOrder(), text: big, actor: ACTOR, at: AT, id: 'n' }).code, 'ORDER_NOTE_TOO_LONG');
  assert.ok(orderReq.buildOrderNote({ order: baseOrder(), text: 'x'.repeat(orderReq.ORDER_NOTE_MAX), actor: ACTOR, at: AT, id: 'n' }).note);
});

test('a file is appended and the browser copy has no storage id', () => {
  const r = orderReq.buildOrderFile({
    order: baseOrder(), label: 'Face-to-face note', fileName: 'f2f.pdf', mimeType: 'application/pdf', byteLength: 10,
    stored: { fileId: 'DRIVE-SECRET' }, emrFiled: true, actor: ACTOR, at: AT, id: 'f1'
  });
  assert.equal(r.order.orderFiles[0].driveFileId, 'DRIVE-SECRET', 'the server keeps it to open the file');
  assert.equal(r.order.status, 'ordered');
  const pub = orderReq.publicOrder(r.order);
  assert.equal(JSON.stringify(pub).includes('DRIVE-SECRET'), false);
  assert.equal(pub.orderFiles[0].fileName, 'f2f.pdf');
  assert.equal(orderReq.publicOrder({ id: 'x' }).id, 'x', 'an order with no files passes through');
});

// ── the routes, run rather than read ───────────────────────────────────────

const lift = () => {
  const start = SERVER.indexOf('const requireOrderAnnotator');
  const end = SERVER.indexOf('// ── UNMATCHED INBOUND');
  assert.ok(start > 0 && end > start, 'the block must be findable');
  const src = SERVER.slice(start, end);
  const routes = {};
  const reg = (m) => (p, ...h) => { routes[`${m} ${p}`] = h; };
  const app = { post: reg('POST'), get: reg('GET') };
  const st = { rows: [baseOrder()], client: { id: 'c1', name: 'Juanita Guess', openEmrPatientId: 'p1' }, audit: [], drive: [], emr: [], driveFails: false };
  const googledrive = {
    uploadClientDocumentFile: async (...a) => { if (st.driveFails) throw new Error('boom'); st.drive.push(a); return { fileId: 'DRV1' }; },
    downloadFileBuffer: async () => Buffer.from('%PDF-bytes')
  };
  const openemr = { isConfigured: () => true, forActor: () => ({ uploadPatientDocument: async (...a) => { st.emr.push(a); } }) };
  const fn = new Function('app', 'authenticateToken', 'clinicalRoles', 'orderReq', 'loadOrderForActor', 'db', 'logActivity', 'actorFromReq',
    'uploadLimiter', 'upload', 'googledrive', 'openemr', 'detectFileType', 'contentDisposition', 'requireClinicalRead',
    `${src}; return { requireOrderAnnotator };`);
  const built = fn(app, 'AUTH', roles, orderReq,
    async (id, res) => {
      const idx = st.rows.findIndex(o => o.id === id);
      if (idx === -1) { res.status(404).json({ code: 'ORDER_NOT_FOUND' }); return null; }
      return { rows: st.rows, idx, order: st.rows[idx], client: st.client };
    },
    { set: async () => {} }, async (...a) => { st.audit.push(a); },
    (req) => ({ id: req.user.id, name: req.user.name }),
    'LIMIT', { single: () => 'MULTER' }, googledrive, openemr,
    (buf) => (String(buf).startsWith('%PDF') ? 'application/pdf' : null), (d, n) => `${d}; ${n}`, 'READ');
  return { routes, st, ...built };
};
const mkRes = () => { const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.send = (b) => { r.sent = b; return r; }; return r; };
const call = async (handlers, req) => { const res = mkRes(); await handlers[handlers.length - 1](req, res); return res; };
const CM = { id: 'u-cm', name: 'Courtney Hale', role: 'caseManager', clinicalRole: 'readOnly' };

test('POST notes appends, saves and audits WITHOUT the note text', async () => {
  const h = lift();
  const res = await call(h.routes['POST /api/clinical/orders/:orderId/notes'], { params: { orderId: 'o1' }, body: { text: 'Agency confirmed: Kindred' }, user: CM });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(h.st.rows[0].orderNotes[0].text, 'Agency confirmed: Kindred');
  assert.equal(JSON.stringify(h.st.audit).includes('Kindred'), false, 'audit carries no note text');
  assert.equal(h.st.audit[0][2], 'order_note_added');
  const bad = await call(h.routes['POST /api/clinical/orders/:orderId/notes'], { params: { orderId: 'o1' }, body: { text: '' }, user: CM });
  assert.equal(bad.code, 400);
  assert.equal(h.st.rows[0].orderNotes.length, 1, 'a refused note writes nothing');
});

test('POST files: typed by bytes, stored, filed to the chart, browser copy has no drive id', async () => {
  const h = lift();
  const req = { params: { orderId: 'o1' }, body: { label: 'Face-to-face' }, user: CM,
    file: { buffer: Buffer.from('%PDF-1.4 x'), originalname: 'f2f note.pdf' } };
  const res = await call(h.routes['POST /api/clinical/orders/:orderId/files'], req);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(h.st.drive.length, 1);
  assert.equal(h.st.emr.length, 1, 'filed to the chart automatically');
  assert.equal(h.st.rows[0].orderFiles[0].emrFiled, true);
  assert.equal(JSON.stringify(res.body).includes('DRV1'), false);
  assert.equal(h.st.rows[0].status, 'ordered', 'attaching a file never moves the order');
});

test('POST files refuses a non-PDF/image by its bytes and a Drive failure, writing nothing', async () => {
  const h = lift();
  const exe = await call(h.routes['POST /api/clinical/orders/:orderId/files'], { params: { orderId: 'o1' }, body: {}, user: CM, file: { buffer: Buffer.from('MZ\u0090 exe'), originalname: 'a.pdf' } });
  assert.equal(exe.code, 400);
  assert.equal(exe.body.code, 'ORDER_FILE_BAD_TYPE');
  h.st.driveFails = true;
  const down = await call(h.routes['POST /api/clinical/orders/:orderId/files'], { params: { orderId: 'o1' }, body: {}, user: CM, file: { buffer: Buffer.from('%PDF-1'), originalname: 'a.pdf' } });
  assert.equal(down.code, 502);
  assert.equal((h.st.rows[0].orderFiles || []).length, 0, 'no row pointing at a file that does not exist');
  const none = await call(h.routes['POST /api/clinical/orders/:orderId/files'], { params: { orderId: 'o1' }, body: {}, user: CM });
  assert.equal(none.code, 400);
});

test('GET file opens through the app, audited; unknown id is 404', async () => {
  const h = lift();
  await call(h.routes['POST /api/clinical/orders/:orderId/files'], { params: { orderId: 'o1' }, body: {}, user: CM, file: { buffer: Buffer.from('%PDF-1'), originalname: 'a.pdf' } });
  const id = h.st.rows[0].orderFiles[0].id;
  const ok = await call(h.routes['GET /api/clinical/orders/:orderId/files/:fileId'], { params: { orderId: 'o1', fileId: id }, user: CM });
  assert.equal(ok.headers['Content-Type'], 'application/pdf');
  assert.ok(h.st.audit.some(a => a[2] === 'order_file_read'));
  const miss = await call(h.routes['GET /api/clinical/orders/:orderId/files/:fileId'], { params: { orderId: 'o1', fileId: 'nope' }, user: CM });
  assert.equal(miss.code, 404);
});

test('the gate admits the destination-edit people and refuses everyone else', () => {
  const h = lift();
  const run = (user) => { let nexted = false; const res = mkRes(); h.requireOrderAnnotator({ user }, res, () => { nexted = true; }); return { nexted, res }; };
  assert.equal(run(CM).nexted, true, 'case manager');
  assert.equal(run({ id: 'a', role: 'admin' }).nexted, true);
  assert.equal(run({ id: 'p', role: 'user', hasClinicalAccess: true, clinicalRole: 'provider' }).nexted, true);
  const denied = run({ id: 'c', role: 'client' });
  assert.equal(denied.nexted, false);
  assert.equal(denied.res.code, 403);
});

test('the routes are wired behind the right middleware', () => {
  const code = stripComments(SERVER);
  assert.match(code, /app\.post\('\/api\/clinical\/orders\/:orderId\/notes', authenticateToken, requireOrderAnnotator,/);
  assert.match(code, /app\.post\('\/api\/clinical\/orders\/:orderId\/files', authenticateToken, requireOrderAnnotator, uploadLimiter,/);
  assert.match(code, /app\.get\('\/api\/clinical\/orders\/:orderId\/files\/:fileId', authenticateToken, requireClinicalRead,/);
  assert.match(code, /\.map\(orderReq\.publicOrder\)/, 'the chart order list strips storage ids');
  assert.match(code, /orders: \(ctx\.orders \|\| \[\]\)\.map\(orderReq\.publicOrder\)/, 'the encounter detail strips them too');
});

// ── the page ───────────────────────────────────────────────────────────────

test('the Orders tab lists every order type; Referrals stays a filtered view', () => {
  const code = stripComments(PAGE);
  const orders = code.slice(code.indexOf('const OrdersTab'), code.indexOf('const ReferralsTab'));
  assert.match(orders, /keep=\{\(\) => true\}/);
  assert.equal(/referral/.test(orders.replace(/Referrals and DME/g, '')), false, 'no referral filter on the Orders tab');
  assert.match(code, /const ReferralsTab[\s\S]{0,200}o\.orderType === 'referral'/);
});

test('an order row opens a detail that can add notes and files', () => {
  const code = stripComments(PAGE);
  assert.match(code, /onClick=\{\(\) => onOpen && onOpen\(o\.id\)\}/);
  assert.match(code, /api\.addOrderNote\(order\.id, note\)/);
  assert.match(code, /api\.addOrderFile\(order\.id, fd\)/);
  assert.match(code, /const canAnnotate = useCanEditOrderDestination\(\)/);
});

// ── the stale banner ───────────────────────────────────────────────────────

test('a scratch draft never masks the shared draft on the chart route', () => {
  const code = stripComments(SERVER);
  const i = code.search(/const sharedDraft = \(\(await loadRows\('encounter_billing'\)\)/);
  assert.ok(i > 0, 'shared draft is computed unconditionally');
  assert.equal(/if \(!ownDraft\) \{\s*const signedUuids/.test(code), false);
  assert.match(code, /savedAt: \(sharedDraft && sharedDraft\.updatedAt\) \|\| \(ownDraft/);
  assert.match(code, /!signedUuids\.has\(String\(r\.encounterUuid\)\)/, 'a signed note is never a draft');
});

test('the page refreshes the chart when an encounter changes or closes', () => {
  const code = stripComments(PAGE);
  assert.match(code, /onBack=\{\(\) => \{ setOpen\(null\); load\(\); onChartChanged && onChartChanged\(\); \}\} onChanged=\{\(\) => \{ load\(\); onChartChanged && onChartChanged\(\); \}\}/);
});

// ── the signed-note download ───────────────────────────────────────────────

const liftNotePdf = () => {
  const i = SERVER.indexOf("app.get('/api/clinical/patients/:clientId/encounters/:euuid/note.pdf'");
  const j = SERVER.indexOf("app.put('/api/clinical/patients/:clientId/encounters/:euuid/note'", i);
  assert.ok(i > 0 && j > i);
  const src = SERVER.slice(i, j);
  const routes = {};
  const st = { ctx: null, audit: [], built: 0 };
  const fn = new Function('app', 'authenticateToken', 'requireClinicalRead', 'loadEncounterContext', 'clinicalNotes', 'buildSignedNotePdf', 'logActivity', 'contentDisposition', src);
  fn({ get: (p, ...h) => { routes[p] = h; } }, 'A', 'R', async (req, res) => st.ctx,
    { NOTE_STATUS: { VOIDED: 'voided' } }, async () => { st.built++; return Buffer.from('%PDF-x'); },
    async (...a) => { st.audit.push(a); }, (d, n) => `${d}; ${n}`);
  const h = Object.values(routes)[0];
  return { st, run: async (ctx) => { st.ctx = ctx; const res = mkRes(); await h[h.length - 1]({ user: { id: 'u', name: 'N' }, params: {} }, res); return res; } };
};
const NOTE_CTX = { client: { id: 'c1' }, encounterUuid: 'e1', record: { date: '2026-09-28', encounterEid: '9', noteStatus: 'signed' }, attestation: { signedAt: 'x' }, addenda: [], emr: {} };

test('a signed note downloads as an inline PDF and the read is audited', async () => {
  const t = liftNotePdf();
  const res = await t.run({ ...NOTE_CTX, closed: true });
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(res.headers['Content-Disposition'], /Clinical_Note_20260928_9\.pdf/);
  assert.ok(t.st.audit.some(a => a[2] === 'signed_note_pdf_downloaded'));
});

test('an unsigned or deleted note is refused, and no PDF is built', async () => {
  const t = liftNotePdf();
  const un = await t.run({ ...NOTE_CTX, closed: false, attestation: null });
  assert.equal(un.code, 409);
  assert.equal(un.body.code, 'NOTE_NOT_SIGNED');
  const gone = await t.run({ ...NOTE_CTX, closed: true, record: { ...NOTE_CTX.record, noteStatus: 'voided' } });
  assert.equal(gone.code, 404);
  assert.equal(t.st.built, 0);
});

test('the signed-note download reuses the filing builder and the page offers it', () => {
  const code = stripComments(SERVER);
  assert.match(code, /const buffer = await buildSignedNotePdf\(emr, client, record, attestation, addenda\);/, 'filing and download share one builder');
  assert.match(code, /app\.get\('\/api\/clinical\/patients\/:clientId\/encounters\/:euuid\/note\.pdf', authenticateToken, requireClinicalRead,/);
  assert.match(stripComments(PAGE), /api\.signedNoteUrl\(patient\.id, euuid\)/);
});

test('a requisition greyed out while the agency is pending has a visible disabled chip', () => {
  assert.match(stripComments(PAGE), /\{agencyPending && <span className="chip[^"]*cursor-not-allowed"[^>]*> ?<i className="ti ti-file-text" \/> Open requisition<\/span>\}/);
});
