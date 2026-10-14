// ============================================================
// The provider co-signature on the signed care plan PDF (owner, 2026-10-14)
// docs/decisions/2026-10-14-care-plan-provider-signature.md
//
// The provider (or LCSW) signature that completes an RN- or LMSW-authored
// plan was captured and stored, and never printed. A signed document must
// carry every signature captured on it.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const pdf = require('../pdf-generator');
const packetImport = require('../welcomePacketImport');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const pdfText = async (buffer) => {
  const doc = await PDFDocument.load(buffer);
  return (await packetImport.extractRuns(doc)).map(r => r.text).join(' ').replace(/\s+/g, ' ');
};
const render = (planExtra, extra = {}) => pdf.generateCarePlanPDF({
  state: 'signed', patientName: 'Mary J', patientDOB: '1948-01-01', serviceLine: 'IHPC',
  plan: { version: 1, problems: ['CHF'], goals: ['Stay home'], ...planExtra },
  rnSignature: { name: 'Ruth Nurse', at: '2026-10-14T12:00:00Z', signatureImage: PNG, ipHash: 'aaaa' },
  clientSignature: { name: 'Mary J', at: '2026-10-14T13:00:00Z', signatureImage: PNG, ipHash: 'bbbb' },
  ...extra
});

test('a signed provider co-signature is printed, with name, credential and NPI', async () => {
  const text = await pdfText(await render({ providerCoSignStatus: 'pending' }, {
    providerSignature: { name: 'Bethel Godwins', at: '2026-10-15T09:00:00Z', signatureImage: PNG, ipHash: 'cccc', clinicalRole: 'provider', npi: '1234567890' }
  }));
  assert.ok(/CLINICIAN CO-SIGNATURE/i.test(text), text);
  assert.ok(text.includes('Bethel Godwins'));
  assert.ok(text.includes('Signed as Provider') && text.includes('NPI 1234567890'));
  assert.ok(!text.includes('PENDING CLINICIAN CO-SIGNATURE'), 'no pending banner once signed');
});

test('a plan waiting on the provider says so, on the banner and in the block', async () => {
  const text = await pdfText(await render({ providerCoSignStatus: 'pending' }));
  assert.ok(text.includes('PENDING CLINICIAN CO-SIGNATURE'));
  assert.ok(/CLINICIAN CO-SIGNATURE.*Pending signature/i.test(text), text);
});

test('a plan that never needed a provider prints no provider block', async () => {
  const text = await pdfText(await render({ providerCoSignStatus: 'not_required' }));
  assert.ok(!/CLINICIAN CO-SIGNATURE/i.test(text), text);
});

test('every PDF builder passes the stored provider signature', () => {
  const emit = SERVER.slice(SERVER.indexOf('const emitSignedCarePlanPdf = async'), SERVER.indexOf('const dateStr', SERVER.indexOf('const emitSignedCarePlanPdf = async')));
  assert.ok(emit.includes('row.providerSignature') && /generateCarePlanPDF\(\{[\s\S]*providerSignature,/.test(emit), 'the emission at co-sign');
  const rebuild = SERVER.slice(SERVER.indexOf('const buildCarePlanPdfForVersion = async'), SERVER.indexOf("return { buffer, source: 'regenerated' }"));
  assert.ok(rebuild.includes('providerSignature: vrow ? vrow.providerSignature'), 'the rebuild from app records');
});

test('a provider signing after the client issues the signed PDF again', () => {
  const start = SERVER.indexOf("app.post('/api/clinical/patients/:clientId/care-plan/provider-cosign'");
  const route = SERVER.slice(start, SERVER.indexOf('\n});', start));
  const reemit = route.indexOf('emitSignedCarePlanPdf(client.id, plan.version');
  assert.ok(reemit > 0, 'the route re-emits');
  assert.ok(route.lastIndexOf("db.set('care_plan_versions'", reemit) > 0 && route.lastIndexOf("db.set('care_plan_versions'", reemit) < reemit,
    'the signature is stored before the PDF is built, or the new PDF would still show it pending');
  assert.ok(/if \(\(client\.carePlanCoSign \|\| \{\}\)\[`v\$\{plan\.version\}`\]\)/.test(route), 'only when the client has already co-signed');
});
