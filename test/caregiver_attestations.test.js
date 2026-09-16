// ============================================================================
// THE FOUR FORMS A CAREGIVER SIGNS IN THE APP
// ============================================================================
// Owner change, 2026-09-14. The background check authorization, the registry
// attestation, the physical ability acknowledgement and the mandatory reporter
// acknowledgement were upload slots for documents WE wrote — a caregiver
// waited on a PDF from us, printed it, signed it, photographed it and sent it
// back. They are signed here now, like a client's consent in the intake wizard.
//
// The three things held hardest:
//
// 1. A SIGNATURE IS STAMPED WITH THE VERSION IT WAS GIVEN, and a signature
//    against superseded wording does not tick the box. The document changed,
//    so the signature is on a different document. It is kept, it still renders
//    its own text, and the row says which of the two states it is in — because
//    "never signed" and "signed the old one" are different sentences to read.
//
// 2. ELECTIONS ARE CHECKED BEFORE THE SIGNATURE IS TAKEN, and a refusal writes
//    NOTHING. The alternative is somebody signing a form we then tell them is
//    unfinished — the ordering the packet's own submit route settled.
//
// 3. THE PAGE NAMES NO CLAUSE OF ITS OWN. Every word is served, so the signed
//    copy reproduces what was on the screen and the page cannot drift from the
//    validator that refuses an answer the form never offered.
//
// House rule throughout: assert the behaviour, called the way the caller calls
// it. The route tests mount the shipped router and go over HTTP, and read the
// stored row back rather than trusting a status code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const attest = require('../caregiverAttestations');
const wp = require('../welcomePacketRepository');
const packetPdf = require('../welcomePacketPdf');
const packetImport = require('../welcomePacketImport');
const { PDFDocument } = require('pdf-lib');

/**
 * The text of a generated PDF, read back with the repo's own extractor.
 *
 * The first version of the two tests below searched the raw bytes for a name
 * and found nothing, because pdf-lib encodes the text — an assertion that
 * cannot distinguish the two states proves nothing about either. This reads
 * the document the way the importer reads a returned packet.
 */
const pdfText = async (buffer) => {
  const doc = await PDFDocument.load(buffer);
  const runs = await packetImport.extractRuns(doc);
  return runs.map(r => r.text).join(' ');
};
const config = require('../config');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const CAREGIVER = { id: 'cg1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'vendor', licenseLevel: 'cna' };
const OTHER_CG = { id: 'cg2', name: 'Grace Hopper', email: 'grace@example.com', role: 'vendor', licenseLevel: 'pca' };
const ADMIN = { id: 'ad1', name: 'GFC Admin', email: 'admin@example.com', role: 'admin' };

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

const mount = async (t, { as = CAREGIVER, store = {} } = {}) => {
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const activity = [];
  const router = require('../routes/welcomePacket')({
    db, config,
    logActivity: async (...a) => { activity.push(a); },
    queueNotification: async () => {},
    getUsers: async () => [CAREGIVER, OTHER_CG, ADMIN],
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => 'x',
    drive: { async uploadCaregiverDocument() { return { id: 'f1' }; } },
    detectFileType: () => 'application/pdf',
    hashIp: () => 'hashed-ip'
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const call = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return {
    store, activity, call,
    get: (p) => call(p),
    send: (p, body, method = 'POST') => call(p, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
  };
};

const rowsFor = (h, kind) => (h.store.caregiver_attestations || []).find(r => r.kind === kind) || null;

// ===========================================================================
// The documents themselves
// ===========================================================================

test('the signable checklist items and the documents are ONE list, derived not restated', () => {
  const signable = wp.DOCUMENT_ITEMS.filter(d => d.sign).map(d => d.kind).sort();
  assert.deepStrictEqual(signable, [...attest.KINDS].sort(),
    'an item that opens a form nobody wrote, or a form no item opens, is a dead end either way');

  for (const item of wp.DOCUMENT_ITEMS.filter(d => d.sign)) {
    assert.strictEqual(item.upload, false, 'a form signed here is not also an upload slot');
    assert.strictEqual(item.source, 'gfc_sign');
    // And its kind must NOT be in the document catalog, or the office would
    // chase a file for a form that was signed.
    assert.ok(!wp.PACKET_DOCUMENT_KINDS.some(k => k.kind === item.kind),
      `${item.kind} is signed, so it must not appear as an uploadable kind`);
  }
});

test('every document carries a body, a title and the version a signature is stamped with', () => {
  for (const kind of attest.KINDS) {
    const doc = attest.servedDocument(kind);
    assert.ok(doc.title && doc.title.length > 3);
    assert.ok(doc.blocks.length > 2, `${kind} has a body`);
    assert.strictEqual(doc.version, attest.CURRENT_VERSION);
    for (const block of doc.blocks) {
      assert.ok(['p', 'h', 'ul', 'note', 'choice'].includes(block.t), `${kind} uses a known block type`);
    }
  }
});

test('the background check authorization is a STANDALONE document', () => {
  // The FCRA requires the disclosure to appear in a document consisting solely
  // of it. Folding it into the packet's own signature would defeat that, which
  // is the whole reason this flag exists rather than being implied.
  assert.strictEqual(attest.ATTESTATIONS.background_check_auth.standalone, true);
  const others = attest.KINDS.filter(k => k !== 'background_check_auth');
  for (const kind of others) assert.strictEqual(attest.ATTESTATIONS[kind].standalone, false);
});

test('an ARCHIVED version renders its own text, in the module and in the PDF', async () => {
  // THE ARCHIVE IS EMPTY TODAY, so `bodyFor(kind, version)` and
  // `bodyFor(kind)` return the same thing and a test comparing them proves
  // nothing — dropping the version argument passed under mutation. Registering
  // a superseded body is what makes the difference observable, and it is the
  // whole premise of the design: a signed copy reproduces what was signed.
  const OLD = 'a-superseded-draft';
  attest.ARCHIVE[OLD] = {
    physical_ability: [{ t: 'p', text: 'Wording that was in force under the superseded draft.' }]
  };
  try {
    assert.strictEqual(attest.hasArchivedBody('physical_ability', OLD), true);
    assert.strictEqual(attest.bodyFor('physical_ability', OLD)[0].text,
      'Wording that was in force under the superseded draft.');
    assert.notStrictEqual(attest.bodyFor('physical_ability')[0].text,
      attest.bodyFor('physical_ability', OLD)[0].text);

    const pdf = await packetPdf.generateSignedAttestationPDF({
      kind: 'physical_ability', version: OLD, printed_name: 'Ada',
      signed_at: '2026-01-01T00:00:00Z', elections: {}
    }, CAREGIVER);
    const text = await pdfText(pdf);
    assert.match(text, /in force under the superseded draft/,
      'the copy must reproduce the text that was signed, not the text that replaced it');
  } finally {
    delete attest.ARCHIVE[OLD];
  }
});

test('an unknown version renders the current body AND says it is not the archived one', () => {
  // A reader must never be shown text silently attributed to a version it is
  // not. An empty result is not a diagnosis; neither is a body.
  const current = attest.bodyFor('physical_ability');
  assert.deepStrictEqual(attest.bodyFor('physical_ability', 'no-such-version'), current);
  assert.strictEqual(attest.hasArchivedBody('physical_ability', 'no-such-version'), false);
  assert.strictEqual(attest.bodyFor('not-a-kind').length, 0);
});

// ===========================================================================
// Elections
// ===========================================================================

test('an unanswered required election is refused, and an invented option is refused', () => {
  const kind = 'registry_attestation';
  const key = attest.choicesFor(kind)[0].key;

  const nothing = attest.validateElections(kind, {});
  assert.strictEqual(nothing.ok, false);
  assert.strictEqual(nothing.missing.length, 1);

  const invented = attest.validateElections(kind, { [key]: 'definitely_not_an_option' });
  assert.strictEqual(invented.ok, false);
  assert.strictEqual(invented.invalid.length, 1,
    'the page renders served options, so anything else was posted straight at the API');

  const good = attest.validateElections(kind, { [key]: 'all_clear' });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.elections[key], 'all_clear');
});

test('a document with no choices is satisfiable with none', () => {
  assert.strictEqual(attest.choicesFor('background_check_auth').length, 0);
  assert.strictEqual(attest.validateElections('background_check_auth', {}).ok, true);
});

// ===========================================================================
// The checklist
// ===========================================================================

test('a signable item is ticked by a SIGNATURE at the current version, and nothing else', () => {
  const row = (attestations) =>
    wp.buildChecklist({}, [], {}, attestations).find(r => r.kind === 'mandatory_reporter');

  assert.strictEqual(row([]).status, 'missing', 'no signature, not done');
  assert.strictEqual(row(undefined).status, 'missing', 'omitting the argument fails CLOSED');

  // An upload of that kind must not tick it either: the item is not an upload.
  const withUpload = wp.buildChecklist({}, [{ kind: 'mandatory_reporter', status: 'accepted' }], {}, [])
    .find(r => r.kind === 'mandatory_reporter');
  assert.strictEqual(withUpload.status, 'missing',
    'a file cannot satisfy a signature — that is the point of the change');

  const signed = row([{ kind: 'mandatory_reporter', signed_at: '2026-09-14T00:00:00Z', version: attest.CURRENT_VERSION }]);
  assert.strictEqual(signed.status, 'complete');
  assert.strictEqual(signed.signedAt, '2026-09-14T00:00:00Z');
  assert.strictEqual(signed.supersededSignature, false);
});

test('a signature against superseded wording does not tick, and says so', () => {
  const stale = wp.buildChecklist({}, [], {},
    [{ kind: 'physical_ability', signed_at: '2026-01-01T00:00:00Z', version: 'some-older-draft' }])
    .find(r => r.kind === 'physical_ability');

  assert.strictEqual(stale.status, 'missing', 'the document changed, so the signature is on a different document');
  assert.strictEqual(stale.supersededSignature, true,
    '"never signed" and "signed the old one" are different sentences to read on a phone');
  assert.strictEqual(stale.signedVersion, 'some-older-draft');
});

test('the checklist reads the version from the attestation module, never its own copy', () => {
  const src = read('welcomePacketRepository.js');
  assert.match(src, /require\('\.\/caregiverAttestations'\)\.CURRENT_VERSION/,
    'a second copy of "which version counts" ticks an item the signing route would refuse');
  assert.ok(!/2026-09-draft/.test(src), 'the repository must not restate a version literal');
});

// ===========================================================================
// Signing, over the real routes
// ===========================================================================

test('the forms are SERVED whole, and the page is handed the version it must post against', async (t) => {
  const h = await mount(t);
  const body = await (await h.get('/api/caregiver/welcome-packet')).json();
  assert.strictEqual(body.attestations.length, attest.KINDS.length);
  for (const doc of body.attestations) {
    assert.ok(Array.isArray(doc.blocks) && doc.blocks.length > 2);
    assert.strictEqual(doc.version, attest.CURRENT_VERSION);
  }
  assert.deepStrictEqual(body.attestationsSigned, []);
});

test('signing stores the record, ticks the item, and stamps the version and the IP', async (t) => {
  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/attestations/registry_attestation', {
    elections: { attestation: 'all_clear' }, printedName: 'Ada Lovelace', signaturePng: PNG
  });
  assert.strictEqual(res.status, 200);
  const payload = await res.json();
  assert.strictEqual(payload.signed, true);

  const row = rowsFor(h, 'registry_attestation');
  assert.ok(row, 'the row is read back, not inferred from a 200');
  assert.strictEqual(row.caregiver_id, CAREGIVER.id);
  assert.strictEqual(row.version, attest.CURRENT_VERSION);
  assert.strictEqual(row.printed_name, 'Ada Lovelace');
  assert.strictEqual(row.signature_png, PNG);
  assert.strictEqual(row.elections.attestation, 'all_clear');
  assert.strictEqual(row.signer_ip_hash, 'hashed-ip');
  assert.ok(row.signed_at);

  const item = payload.checklist.find(r => r.kind === 'registry_attestation');
  assert.strictEqual(item.status, 'complete', 'the response carries the checklist the caregiver will see next');
  assert.ok(h.activity.some(a => a[2] === 'caregiver_attestation_signed'));
});

test('the version is taken from the SERVER, never from the caller', async (t) => {
  const h = await mount(t);
  await h.send('/api/caregiver/welcome-packet/attestations/mandatory_reporter', {
    printedName: 'Ada', signaturePng: PNG, version: 'a-version-nobody-was-shown'
  });
  assert.strictEqual(rowsFor(h, 'mandatory_reporter').version, attest.CURRENT_VERSION,
    'a page posting a version it was not given would stamp a signature onto text nobody saw');
});

test('an unanswered election is refused and NOTHING is written', async (t) => {
  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/attestations/physical_ability', {
    printedName: 'Ada', signaturePng: PNG
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'ELECTION_REQUIRED');
  assert.strictEqual(rowsFor(h, 'physical_ability'), null,
    'a refusal that half-wrote a signature is worse than the refusal');
});

test('an option the form never offered is refused even posted straight at the API', async (t) => {
  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/attestations/physical_ability', {
    elections: { ability: 'superhuman' }, printedName: 'Ada', signaturePng: PNG
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'ELECTION_INVALID');
  assert.strictEqual(rowsFor(h, 'physical_ability'), null);
});

test('a missing signature and a missing name are each refused, with their own code', async (t) => {
  const h = await mount(t);
  const noSig = await h.send('/api/caregiver/welcome-packet/attestations/background_check_auth',
    { printedName: 'Ada' });
  assert.strictEqual((await noSig.json()).code, 'SIGNATURE_REQUIRED');

  const noName = await h.send('/api/caregiver/welcome-packet/attestations/background_check_auth',
    { printedName: '   ', signaturePng: PNG });
  assert.strictEqual((await noName.json()).code, 'PRINTED_NAME_REQUIRED');
  assert.strictEqual(rowsFor(h, 'background_check_auth'), null);
});

test('signing twice is refused — a correction is a NEW signature on a CHANGED document', async (t) => {
  const h = await mount(t);
  await h.send('/api/caregiver/welcome-packet/attestations/background_check_auth',
    { printedName: 'Ada', signaturePng: PNG });
  const again = await h.send('/api/caregiver/welcome-packet/attestations/background_check_auth',
    { printedName: 'Someone Else', signaturePng: PNG });
  assert.strictEqual(again.status, 409);
  assert.strictEqual((await again.json()).code, 'ATTESTATION_SIGNED');
  assert.strictEqual(rowsFor(h, 'background_check_auth').printed_name, 'Ada',
    'the refused second attempt must not overwrite the first');
});

test('a signature against superseded wording CAN be replaced, and the old one is carried', async (t) => {
  const store = {
    caregiver_attestations: [{
      id: 'catt_cg1_mandatory_reporter', caregiver_id: 'cg1', kind: 'mandatory_reporter',
      version: 'an-older-draft', signed_at: '2026-01-01T00:00:00Z',
      elections: {}, printed_name: 'Ada', created_at: '2026-01-01T00:00:00Z'
    }]
  };
  const h = await mount(t, { store });
  const res = await h.send('/api/caregiver/welcome-packet/attestations/mandatory_reporter',
    { printedName: 'Ada Lovelace', signaturePng: PNG });
  assert.strictEqual(res.status, 200);

  const row = rowsFor(h, 'mandatory_reporter');
  assert.strictEqual(row.version, attest.CURRENT_VERSION);
  assert.strictEqual(row.supersedes.version, 'an-older-draft',
    'what they signed before, and when, stays readable');
  assert.strictEqual(row.supersedes.signedAt, '2026-01-01T00:00:00Z');
  assert.strictEqual((h.store.caregiver_attestations || []).length, 1, 'one row per form, not a pile');
});

test('an unknown form is a 404 with its own code, never a silent no-op', async (t) => {
  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/attestations/not_a_real_form',
    { printedName: 'Ada', signaturePng: PNG });
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await res.json()).code, 'ATTESTATION_UNKNOWN');
});

// ===========================================================================
// The signed copy
// ===========================================================================

test('the signed copy is real bytes, and it is refused before the form is signed', async (t) => {
  const h = await mount(t);
  const before = await h.get('/api/caregiver/welcome-packet/attestations/physical_ability.pdf');
  assert.strictEqual(before.status, 404);
  assert.strictEqual((await before.json()).code, 'ATTESTATION_NOT_SIGNED');

  await h.send('/api/caregiver/welcome-packet/attestations/physical_ability',
    { elections: { ability: 'able' }, printedName: 'Ada', signaturePng: PNG });

  const after = await h.get('/api/caregiver/welcome-packet/attestations/physical_ability.pdf');
  assert.strictEqual(after.status, 200);
  const bytes = Buffer.from(await after.arrayBuffer());
  assert.strictEqual(bytes.subarray(0, 5).toString(), '%PDF-', 'bytes read back, not a status code');
  assert.ok(bytes.length > 1000);
});

test('a caregiver asking for someone else\'s copy still gets their own', async (t) => {
  const store = {
    caregiver_attestations: [
      { id: 'a', caregiver_id: 'cg1', kind: 'mandatory_reporter', version: attest.CURRENT_VERSION,
        signed_at: '2026-09-14T00:00:00Z', printed_name: 'Ada', elections: {} },
      { id: 'b', caregiver_id: 'cg2', kind: 'mandatory_reporter', version: attest.CURRENT_VERSION,
        signed_at: '2026-09-14T00:00:00Z', printed_name: 'Grace', elections: {} }
    ]
  };
  const h = await mount(t, { store });
  // The filter is admin-only. Passing another caregiver's id widens nothing.
  const res = await h.get('/api/caregiver/welcome-packet/attestations/mandatory_reporter.pdf?caregiverId=cg2');
  assert.strictEqual(res.status, 200);
  const text = await pdfText(Buffer.from(await res.arrayBuffer()));
  assert.ok(text.includes('Ada'), 'their own');
  assert.ok(!text.includes('Grace'), 'never the other caregiver\'s');
  // The filename is the other observable half, and it must agree.
  assert.match(res.headers.get('content-disposition'), /Ada/);
});

test('the copy reproduces the body AT THE STORED VERSION and flags superseded wording', async () => {
  const stale = await packetPdf.generateSignedAttestationPDF({
    kind: 'physical_ability', version: 'an-older-draft', printed_name: 'Ada',
    signed_at: '2026-01-01T00:00:00Z', elections: { ability: 'able' }
  }, CAREGIVER);
  const text = await pdfText(stale);
  assert.match(text, /current version of this form differs/,
    'a reader has to be able to tell a current signature from one against wording we changed');
  // And the election they actually made is marked, not just listed.
  assert.ok(text.includes('[X]'), 'the copy shows which option was chosen');

  const current = await packetPdf.generateSignedAttestationPDF({
    kind: 'physical_ability', version: attest.CURRENT_VERSION, printed_name: 'Ada',
    signed_at: '2026-09-14T00:00:00Z', elections: { ability: 'able' }
  }, CAREGIVER);
  assert.doesNotMatch(await pdfText(current), /current version of this form differs/);
});

// ===========================================================================
// Build enforcement
// ===========================================================================

test('the caregiver page names no clause of any form', () => {
  const page = read('public/caregiver.html');
  for (const kind of attest.KINDS) {
    for (const block of attest.bodyFor(kind)) {
      const strings = block.t === 'ul' ? block.items
        : block.t === 'choice' ? [block.label, ...block.options.map(o => o.label)]
          : [block.text];
      for (const s of strings) {
        // A sample long enough to be unmistakable, short enough not to trip on
        // shared punctuation.
        const sample = String(s).replace(/\*\*/g, '').slice(0, 40);
        assert.ok(!page.includes(sample),
          `caregiver.html must not carry the wording of ${kind}: "${sample}"`);
      }
    }
  }
});

test('the page renders the OPTIONS it was served rather than listing its own', () => {
  const page = read('public/caregiver.html');
  const values = attest.KINDS
    .flatMap(k => attest.choicesFor(k))
    .flatMap(c => c.options.map(o => o.value));
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.ok(!page.includes(`'${value}'`) && !page.includes(`"${value}"`),
      `caregiver.html must not name the option "${value}"`);
  }
});

test('the signing route resolves the caregiver from the token and takes no id', () => {
  const src = read('routes/welcomePacket.js');
  const start = src.indexOf("router.post('/api/caregiver/welcome-packet/attestations/:kind'");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('router.get(', start));
  assert.ok(!/req\.body\s*\|\|\s*\{\}\)\.caregiverId|req\.query\.caregiverId/.test(body),
    'a caregiver signs their own forms; there is no id to widen');
  assert.match(body, /freshCaregiver\(req\)/);
});

test('every route that builds a checklist also reads the attestations', () => {
  // A surface that skipped them would tell a caregiver a form they signed is
  // still outstanding — and the scheduling one would refuse a cleared
  // caregiver a shift.
  //
  // The call is read to its CLOSING `);`, not to the first `)`. The first
  // version of this stopped at `buildChecklist((packet || {})` and reported a
  // correct call as missing its argument — a scan that reads the wrong span
  // is a guard that answers a different question.
  for (const file of ['routes/welcomePacket.js', 'routes/caregiver.js', 'routes/scheduling.js']) {
    const src = read(file);
    const calls = src.match(/buildChecklist\([\s\S]*?\);/g) || [];
    assert.ok(calls.length > 0, `${file} builds a checklist`);
    for (const call of calls) {
      assert.match(call, /attestation/i,
        `${file}: buildChecklist without the attestations reports a signed form as missing — ${call.slice(0, 90)}`);
    }
  }
});

test('Content-Disposition is built with the disposition FIRST, everywhere', () => {
  // FOUND BY THE TEST ABOVE, 2026-09-14: the welcome packet's own PDF routes
  // called contentDisposition(filename, 'attachment'). The helper reads
  // (disposition, filename), so every packet PDF had been going out as
  // `inline; filename="attachment"` — downloaded with no name and no
  // extension. Two of the three were shipped, not new.
  const files = ['server.js', 'routes/welcomePacket.js', 'routes/caregiver.js', 'routes/scheduling.js'];
  for (const file of files) {
    const src = read(file);
    for (const call of src.match(/contentDisposition\([\s\S]{0,160}?\)/g) || []) {
      const firstArg = call.slice('contentDisposition('.length).split(',')[0].trim();
      assert.ok(/^'(inline|attachment)'$|^disposition$/.test(firstArg),
        `${file}: the first argument must be the disposition, not a filename — ${call.slice(0, 80)}`);
    }
  }
});

// ===========================================================================
// Office-filed documents and the checklist they tick
// ===========================================================================
// OWNER REPORT, 2026-09-14: "if photo id is uploaded by admin, this should
// automatically mark complete in the enrollment form and then in documents, it
// should show as a downloadable option."

const mountCaregiverRoutes = async (t, { as = ADMIN, store = {} } = {}) => {
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const router = require('../routes/caregiver')({
    db, config,
    logActivity: async () => {},
    queueNotification: async () => {},
    getUsers: async () => [CAREGIVER, OTHER_CG, ADMIN],
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => 'x',
    drive: {
      async uploadCaregiverDocumentFile() { return { fileId: 'drive1', webViewLink: 'https://drive/1' }; },
      async downloadFileBuffer() { return Buffer.from('%PDF-1.4 test'); },
      describeDriveError: (e) => ({ reason: e.message, hint: null })
    },
    detectFileType: () => 'image/png'
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const call = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return {
    store, call,
    get: (p) => call(p),
    send: (p, body) => call(p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
  };
};

test('a document the OFFICE files is accepted, so the checklist item ticks itself', async (t) => {
  const h = await mountCaregiverRoutes(t);
  const res = await h.send('/api/caregiver/documents', {
    caregiverId: CAREGIVER.id, kind: 'id_document',
    fileName: 'photo-id.png', fileDataB64: Buffer.from('x').toString('base64')
  });
  assert.strictEqual(res.status, 200);

  const row = h.store.caregiver_documents[0];
  assert.strictEqual(row.caregiver_id, CAREGIVER.id);
  assert.strictEqual(row.status, 'accepted',
    'the office is the reviewer — a document it filed waiting on its own review is a dead end');
  assert.strictEqual(row.uploaded_by_office, true);

  const item = wp.buildChecklist({}, [row], {}, []).find(r => r.kind === 'id_document');
  assert.strictEqual(item.status, 'complete', 'uploaded by admin, complete on the enrollment form');
  assert.strictEqual(item.uploads[0].uploadedByOffice, true,
    'a caregiver looking at a ticked item they do not remember ticking has to be told who filed it');
});

test('an office-filed NON-payroll onboarding document is accepted too', async (t) => {
  // This is the half that was broken: the status check read `payroll`, so an
  // office-filed TB result sat on "With the office" forever and the office
  // chased a caregiver for a document the office had itself uploaded.
  const h = await mountCaregiverRoutes(t);
  await h.send('/api/caregiver/documents', {
    caregiverId: CAREGIVER.id, kind: 'tb_test',
    fileName: 'tb.png', fileDataB64: Buffer.from('x').toString('base64')
  });
  assert.strictEqual(h.store.caregiver_documents[0].status, 'accepted');
  assert.strictEqual(
    wp.buildChecklist({}, h.store.caregiver_documents, {}, []).find(r => r.kind === 'tb_test').status,
    'complete');
});

test('a caregiver-sent document still needs a review — it is NOT auto-accepted', async (t) => {
  const h = await mountCaregiverRoutes(t, { as: CAREGIVER });
  await h.send('/api/caregiver/documents', {
    kind: 'tb_test', fileName: 'tb.png', fileDataB64: Buffer.from('x').toString('base64')
  });
  const row = h.store.caregiver_documents[0];
  assert.strictEqual(row.status, 'received', 'the office has not looked at this one yet');
  assert.strictEqual(row.uploaded_by_office, false);
});

test('a document filed for one caregiver never appears on another', async (t) => {
  const store = {
    caregiver_documents: [
      { id: 'd1', caregiver_id: 'cg1', kind: 'id_document', file_name: 'ada.png', status: 'accepted', uploaded_at: 'now' },
      { id: 'd2', caregiver_id: 'cg2', kind: 'id_document', file_name: 'grace.png', status: 'accepted', uploaded_at: 'now' }
    ]
  };
  const h = await mountCaregiverRoutes(t, { store });
  const one = await (await h.get('/api/caregiver/documents?caregiverId=cg1')).json();
  assert.deepStrictEqual(one.documents.map(d => d.fileName), ['ada.png']);

  const two = await (await h.get('/api/caregiver/documents?caregiverId=cg2')).json();
  assert.deepStrictEqual(two.documents.map(d => d.fileName), ['grace.png']);

  // And the checklist is built per caregiver from the filtered rows, so one
  // caregiver's photo ID can never tick another's item.
  const forTwo = wp.buildChecklist({}, store.caregiver_documents.filter(r => r.caregiver_id === 'cg2'), {}, []);
  assert.strictEqual(forTwo.find(r => r.kind === 'id_document').uploads[0].fileName, 'grace.png');
});

test('the admin form clears the previous caregiver\'s documents before it fetches', () => {
  // OWNER REPORT: paperwork uploaded for one caregiver showed on every other
  // caregiver's form. The component is not remounted when the admin opens a
  // different user, so the previous rows stayed in state — permanently, if the
  // new fetch failed, because a failed fetch resolves to { error } and never
  // calls setDocs.
  const page = read('public/admin-hub.html');
  const start = page.indexOf('const CaregiverDocsSection =');
  assert.ok(start > 0);
  const body = page.slice(start, page.indexOf('\n    const ', start + 10));
  const loadAt = body.indexOf('const load = React.useCallback');
  assert.ok(loadAt > 0, 'the loader exists');
  const loader = body.slice(loadAt, body.indexOf('}, [token, caregiverId]);', loadAt));
  const clearAt = loader.indexOf('setDocs([])');
  const guardAt = loader.indexOf('if (!caregiverId) return');
  const fetchAt = loader.indexOf('api.listCaregiverDocs');
  assert.ok(clearAt > 0, 'the list is cleared on every caregiver change');
  assert.ok(clearAt < fetchAt,
    'clearing AFTER the fetch would still show the previous caregiver while it is in flight');
  // And BEFORE the early return, or opening the Add User form — which has no
  // caregiver id — leaves the last caregiver's paperwork on screen under a
  // blank name. Asserting only "before the fetch" passed under that mutation.
  assert.ok(clearAt < guardAt,
    'a screen with no caregiver selected must not still be showing one');
  assert.match(loader, /d\.error/, 'a failed load says so rather than leaving stale rows on screen');
});

test('a caregiver can open a document, including one the office filed for them', async (t) => {
  const store = {
    caregiver_documents: [{
      id: 'd1', caregiver_id: 'cg1', kind: 'id_document', file_name: 'ada.png',
      status: 'accepted', uploaded_at: 'now', drive_file_id: 'drive1',
      mime_type: 'image/png', uploaded_by_office: true
    }]
  };
  const h = await mountCaregiverRoutes(t, { as: CAREGIVER, store });
  const res = await h.get('/api/caregiver/documents/d1/file');
  assert.strictEqual(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 0, 'bytes read back, not a status code');

  // And the page offers it.
  const page = read('public/caregiver.html');
  assert.match(page, /openCaregiverDocument/, 'the caregiver app can open a stored file');
  assert.match(page, /documents\/\$\{encodeURIComponent\(id\)\}\/file/,
    'through the app, so every read is audited — never a Drive link');
});

test('the caregiver app never receives a Drive id or a stored name', () => {
  const src = read('routes/caregiver.js');
  const start = src.indexOf('const publicCaregiverDoc');
  const body = src.slice(start, src.indexOf('});', start));
  for (const leak of ['drive_file_id', 'drive_url', 'stored_name']) {
    assert.ok(!body.includes(leak), `${leak} must not be projected to a client`);
  }
});
