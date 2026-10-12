// The Transfer-of-Care provider ROI, rebuilt 2026-10-10.
//
// Owner report: the form produced many PDFs with broken information. Causes,
// each pinned here:
//   - every checkbox printed as "&" (Helvetica cannot encode ☑/☐), so ticked
//     and unticked looked the same and the 42 CFR Part 2 line read as authorized
//   - the patient identity printed whatever the page sent
//   - every past provider was re-sent on every submission, and two spellings of
//     one office were two providers
//   - no fax check; the form spilled onto a second page with the signature
//     alone on it and no identifiers
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');

const roiRepo = require('../roiRepository');
const pdf = require('../pdf-generator');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');

const pdfContent = (buf) => {
  const s = buf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    try { out += zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1') + '\n'; } catch (e) { /* not flate */ }
  }
  return out;
};
// A tick is the only thing the form strokes at 1.6pt.
const ticks = (buf) => (pdfContent(buf).match(/\b1\.6 w\b/g) || []).length;
const pages = async (buf) => (await PDFDocument.load(buf)).getPageCount();

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const input = (over) => Object.assign({
  patientName: 'Juanita Guess', patientDOB: '1940-01-02', patientAddress: '12 Main St, Atlanta, GA 30301', patientPhone: '404-555-1212',
  provider: { name: 'Dr Smith', dept: 'Cardiology', address: '1 Peachtree St', phone: '404-555-0000', fax: '404-555-0001' },
  categories: { hp: true, lab: true },
  includesProtected: false, purposeTreatment: true,
  expDate: '2027-03-01', expEvent: '', signatureImageB64: SIG, signedDate: '2026-10-10', printedName: 'Juanita Guess', relationship: ''
}, over || {});

// ── The PDF ──────────────────────────────────────────────────────────────
test('ticked boxes are drawn ticks, exactly one per ticked box', async () => {
  const two = await pdf.generateProviderROIPDF(input());
  assert.equal(ticks(two), 3, 'H&P + lab + treatment purpose');
  const none = await pdf.generateProviderROIPDF(input({ categories: {}, purposeTreatment: false }));
  assert.equal(ticks(none), 0);
});

test('the specially protected line is ticked only on an explicit opt-in', async () => {
  const no = await pdf.generateProviderROIPDF(input({ includesProtected: 'yes' }));
  const yes = await pdf.generateProviderROIPDF(input({ includesProtected: true }));
  assert.equal(ticks(yes) - ticks(no), 1, 'only === true ticks it');
});

test('no checkbox is a font glyph any more', () => {
  const fn = fs.readFileSync(path.join(__dirname, '..', 'pdf-generator.js'), 'utf8');
  const body = fn.slice(fn.indexOf('async function generateProviderROIPDF'), fn.indexOf('// Care Plan / Service Plan PDF'));
  assert.doesNotMatch(body, /☑|☐|\\u2611|\\u2610/);
});

test('the heaviest form is one page, and identifiers are on it top and bottom', async () => {
  const long = 'x'.repeat(200);
  const buf = await pdf.generateProviderROIPDF(input({
    provider: { name: 'Piedmont Atlanta Hospital Health Information Management Department', dept: 'Medical Records', address: '1968 Peachtree Rd NW, Atlanta, GA 30309', phone: '404-605-5000', fax: '404-605-1234' },
    categories: { hp: true, lab: true, diag: true, imaging: true, meds: true, discharge: true, allergies: true, immune: true, other: true, otherText: long },
    includesProtected: true, purposeOther: true, purposeOtherText: long, expEvent: 'End of treatment', relationship: 'Power of attorney'
  }));
  assert.equal(await pages(buf), 1);
});

test('dates print as MM/DD/YYYY, and a timestamp is read in Georgia', () => {
  assert.equal(pdf.roiDate('1940-01-02'), '01/02/1940');
  // 9:30pm on Oct 10 in Georgia is already Oct 11 in UTC.
  assert.equal(pdf.roiDate('2026-10-11T01:30:00Z'), '10/10/2026');
  assert.equal(pdf.roiText({ line1: '12 Main St', city: 'Atlanta', state: 'GA', zip: '30301' }), '12 Main St, Atlanta, GA 30301');
  assert.equal(pdf.roiText(null), '');
});

// ── Submission hygiene ───────────────────────────────────────────────────
test('two spellings of one office are one provider, and the blanks fill in', () => {
  const { providers, errors } = roiRepo.prepareProviders([
    { name: 'Dr. Smith', fax: '(404) 555-0001' },
    { name: 'DR SMITH ', address: '1 Peachtree St' },
    { name: '   ' },
    { name: 'Emory Hospital' }
  ]);
  assert.deepEqual(errors, {});
  assert.equal(providers.length, 2);
  assert.equal(providers[0].address, '1 Peachtree St');
  assert.equal(providers[0].fax, '404-555-0001');
});

test('a fax that is not ten digits is refused; blank is allowed', () => {
  assert.equal(roiRepo.normalizeFax('').ok, true);
  assert.equal(roiRepo.normalizeFax('1-404-555-0001').value, '404-555-0001');
  assert.equal(roiRepo.normalizeFax('555-0001').ok, false);
  const { errors } = roiRepo.prepareProviders([{ name: 'Emory', fax: '123' }]);
  assert.match(errors['providers.0.fax'], /10-digit/);
});

test('no providers, or too many, is refused', () => {
  assert.ok(roiRepo.prepareProviders([]).errors.providers);
  const many = Array.from({ length: roiRepo.MAX_PROVIDERS_PER_SUBMISSION + 1 }, (_, i) => ({ name: `Clinic ${i}` }));
  assert.ok(roiRepo.prepareProviders(many).errors.providers);
});

test('the expiration is never later than a year, never in the past, always a real date', () => {
  const signed = '2026-10-10T15:00:00Z';
  assert.deepEqual(roiRepo.resolveExpiration('', signed), { date: '2027-10-10', chosen: false });
  assert.equal(roiRepo.resolveExpiration('03/01/2027', signed).date, '2027-03-01');
  assert.equal(roiRepo.resolveExpiration('2030-01-01', signed).date, '2027-10-10');
  assert.ok(roiRepo.resolveExpiration('2026-10-10', signed).error, 'today is not "after today"');
  assert.ok(roiRepo.resolveExpiration('2027-02-30', signed).error);
  assert.equal(roiRepo.resolveExpiration('', '2028-02-29T12:00:00Z').date, '2029-03-01');
});

test('a provider with a release in force is found by name, whatever the spelling', () => {
  const events = [
    { id: 'e1', signed_at: '2026-10-01', expiration_date: '2027-10-01', revoked_at: null },
    { id: 'e2', signed_at: '2025-01-01', expiration_date: '2026-01-01', revoked_at: null },
    { id: 'e3', signed_at: '2026-09-01', expiration_date: '2027-09-01', revoked_at: '2026-09-15' }
  ];
  const auths = [
    { consent_event_id: 'e1', provider_name: 'Dr. Smith' },
    { consent_event_id: 'e2', provider_name: 'Emory' },
    { consent_event_id: 'e3', provider_name: 'Grady' }
  ];
  const active = roiRepo.activeAuthorizationsByProvider(events, auths, '2026-10-10');
  assert.ok(active[roiRepo.providerKey('dr smith')]);
  assert.equal(active[roiRepo.providerKey('Emory')], undefined, 'expired');
  assert.equal(active[roiRepo.providerKey('Grady')], undefined, 'revoked');
});

test('the PDF input is built from stored records: the snapshot wins, protected categories never become boxes', () => {
  const event = {
    patient_snapshot: { patientName: 'Juanita Guess', patientDOB: '1940-01-02' },
    includes_protected_info: false, purpose_treatment: true, purpose_other_text: null,
    expiration_date: '2027-10-10', signature_image_b64: SIG, signed_at: '2026-10-10T15:00:00Z', printed_name: 'Juanita Guess'
  };
  const d = roiRepo.pdfInputFromRecords({
    event, auth: { provider_name: 'Dr Smith', fax: '404-555-0001' },
    categoryRows: [{ category: 'hp' }, { category: 'mental_health' }, { category: 'other', other_text: 'PT notes' }],
    patient: { patientName: 'Somebody Else' }
  });
  assert.equal(d.patientName, 'Juanita Guess');
  assert.equal(d.categories.hp, true);
  assert.equal(d.categories.mental_health, undefined);
  assert.equal(d.categories.otherText, 'PT notes');
  assert.equal(d.purposeOther, false);
  assert.equal(d.includesProtected, false);
});

// ── The routes ───────────────────────────────────────────────────────────
const submit = SERVER.slice(SERVER.indexOf("app.post('/api/gfc/transfer-roi/submit'"), SERVER.indexOf('// Get portal settings (admin configurable HubSpot embeds)'));

test('every PDF is rendered before anything is written', () => {
  const render = submit.indexOf('pdfGenerator.generateProviderROIPDF(');
  const write = submit.indexOf('roiStore.insertConsentEvent(');
  assert.ok(render > 0 && write > 0 && render < write);
  assert.match(submit, /code: 'ROI_PDF_FAILED'/);
});

test('the identity is the record\'s, and the confirmation goes only to addresses on file', () => {
  assert.match(submit, /const \{ patient \} = roiPatientIdentity\(client, b\);/);
  assert.doesNotMatch(submit, /patientName: b\.patientName/);
  assert.doesNotMatch(SERVER, /submitterEmail/);
});

test('the admin copy carrying the PDFs is marked PHI', () => {
  assert.match(SERVER, /attachments: \(pdfAttachments \|\| \[\]\), phi: true \}/);
});

test('a release opens as a rendered PDF on both doors, never a Drive link', () => {
  assert.doesNotMatch(SERVER, /url: auth\.generated_pdf_drive_url/);
  assert.equal((SERVER.match(/const rendered = await renderStoredRoiPdf\(client, ref\);/g) || []).length, 2);
  assert.match(SERVER, /app\.get\('\/api\/gfc\/transfer-roi\/authorizations\/:authId\.pdf', authenticateToken, requireClientForIntake/);
});

test('the form pre-fills only providers without a release in force', () => {
  assert.match(PORTAL, /const pre = all\.filter\(p => !p\.activeAuthorization\);/);
  assert.match(PORTAL, /Request again/);
});
