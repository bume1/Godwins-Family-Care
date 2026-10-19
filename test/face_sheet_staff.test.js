// The Client Information Face Sheet is staff-only (owner, 2026-10-19): "move it
// from the patient to the staff side … the downloadable face sheet for all
// clinical EHR users". The shipped route is lifted out of server.js and RUN
// against fakes, and the PDF it returns is read back as text.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const pdfGenerator = require('../pdf-generator');
const packetImport = require('../welcomePacketImport');
const { contentDisposition } = require('../contentDisposition');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const files = fs.readFileSync(path.join(__dirname, '..', 'public', 'patient-files.js'), 'utf8');
const textOf = async (buf) => (await packetImport.extractRuns(await PDFDocument.load(buf))).map(r => r.text).join(' ').replace(/\s+/g, ' ');

const ROUTE = "app.get('/api/clinical/patients/:clientId/face-sheet.pdf'";
const CLIENT = {
  id: 'c-1', role: 'client', name: 'Juanita Guess', slug: 'juanita-guess', serviceLine: 'IHPC',
  intake: { firstName: 'Juanita', lastName: 'Guess', dob: '1941-03-02', phone: '404-555-0101',
    address: { street: '12 Peachtree Ln', city: 'Atlanta', state: 'GA', zip: '30301' } }
};

// The handler exactly as shipped, with its collaborators handed in.
const liftHandler = (deps) => {
  const start = server.indexOf(ROUTE);
  assert.ok(start > 0, 'the staff route exists');
  const body = server.slice(start, server.indexOf('\n});\n', start) + 4);
  let handler = null;
  const app = { get: (p, ...fns) => { handler = fns[fns.length - 1]; } };
  new Function('app', 'authenticateToken', 'requireClinicalRead', 'loadClinicalClient', 'pdfGenerator', 'logActivity', 'contentDisposition', body)(
    app, null, null, deps.loadClinicalClient, pdfGenerator, deps.logActivity, contentDisposition);
  return handler;
};
const run = async (handler, clientId) => {
  const res = { statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, send(b) { this.body = b; return this; } };
  await handler({ params: { clientId }, user: { id: 'u-cm', name: 'Courtney Hale', role: 'caseManager' } }, res);
  return res;
};

test('staff open the face sheet from the clinical read gate; the patient route is gone', () => {
  assert.match(server, /app\.get\('\/api\/clinical\/patients\/:clientId\/face-sheet\.pdf', authenticateToken, requireClinicalRead, async/);
  assert.ok(!server.includes("app.get('/api/gfc/face-sheet.pdf'"), 'no patient route');
  const docs = server.slice(server.indexOf("app.get('/api/gfc/documents'"), server.indexOf("app.get('/api/gfc/documents'") + 8000);
  assert.ok(!/faceSheet/.test(docs), 'the patient documents list does not offer it');
  assert.ok(!/faceSheet|face-sheet/.test(files), 'the portal Documents screen has no face sheet row');
});

test('the route returns a real face sheet built from the record, and audits without PHI', async () => {
  const activity = [];
  const h = liftHandler({
    loadClinicalClient: async (id) => (id === CLIENT.id ? { client: CLIENT } : { client: null }),
    logActivity: async (...a) => { activity.push(a); }
  });
  const res = await run(h, 'c-1');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /face-sheet-juanita-guess\.pdf/);
  assert.strictEqual(Buffer.from(res.body).subarray(0, 5).toString(), '%PDF-');
  const text = await textOf(res.body);
  assert.match(text, /Juanita/);
  assert.strictEqual(activity.length, 1);
  assert.strictEqual(activity[0][2], 'face_sheet_downloaded');
  assert.strictEqual(activity[0][4], 'c-1');
  assert.ok(!/Juanita|Peachtree|1941|404-555/.test(JSON.stringify(activity[0])), 'the audit row carries no PHI');
});

test('an unknown patient is 404 and a home-care-only client is 409, with nothing generated', async () => {
  let made = 0;
  const h = liftHandler({
    loadClinicalClient: async (id) => (id === 'phc' ? { client: null, wrongLine: true } : { client: null }),
    logActivity: async () => { made++; }
  });
  assert.strictEqual((await run(h, 'nobody')).statusCode, 404);
  assert.strictEqual((await run(h, 'phc')).statusCode, 409);
  assert.strictEqual(made, 0);
});

test('the patient banner offers Face Sheet to every chart viewer, fetched with the token', () => {
  const banner = page.slice(page.indexOf('const PatientBanner = ('), page.indexOf('<AllergyStrip', page.indexOf('const PatientBanner = (')));
  assert.match(banner, /\{patient && patient\.id && <FaceSheetItem clientId=\{patient\.id\}/);
  assert.ok(!/canWrite && <FaceSheetItem/.test(banner), 'a read, not behind canWrite');
  const item = page.slice(page.indexOf('const FaceSheetItem = ('), page.indexOf('const PatientBanner = ('));
  assert.match(item, /\/api\/clinical\/patients\/\$\{encodeURIComponent\(clientId\)\}\/face-sheet\.pdf/);
  assert.match(item, /Authorization: `Bearer \$\{getToken\(\)\}`/);
  assert.ok(!/\?token=/.test(item), 'the token never rides in the URL');
});
