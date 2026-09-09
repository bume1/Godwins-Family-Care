// ============================================================
// Session 4.6 — consent registry, lane separation, and one-pass intake
//
// The invariants this session exists to hold. Each one maps to a defect found
// in a live enrollment packet or in the code that produced it:
//   1. Lane separation — a home-care client never signs a clinical agreement,
//      an IHPC patient signs one that actually exists, a BOTH client signs two.
//   2. The PHC -> BOTH transition writes the newly required consents as pending
//      and flags the client, instead of changing lane in silence.
//   3. An inactive consent cannot be signed, and nothing is ever recorded as
//      'signed' without a timestamp and a client IP.
//   4. The IP stored is the CLIENT's, not the whole X-Forwarded-For chain.
//   5. careTier is not counted against an IHPC-only patient.
//   6. financialAgreement is not presentable until a rate exists.
//   7. signed_offline satisfies every requirement, including the new one.
//   8. ONE PASS — every value a consent needs is rendered from the client
//      record, never re-collected, with exactly one documented exception.
//   9. A consent copy reproduces the body AS SIGNED, not the current text.
//
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../consentRegistry');
const T = require('../public/consent-text');
const RENDER = require('../consentRender');
const { createZip } = require('../zipWriter');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'public', 'admin-enrollment.html'), 'utf8');

const hashIp = (raw) => (raw ? 'hash:' + raw : null);

const baseClient = (over = {}) => ({
  id: 'c-1',
  name: 'Testcase Client',
  serviceLine: 'PHC',
  role: 'client',
  consents: {},
  consentMeta: {},
  intake: {
    firstName: 'Testcase', lastName: 'Client', dob: '1948-03-02',
    address: { line1: '1 Test St', city: 'Atlanta', state: 'GA', zip: '30339' },
    phone: '404-555-0100',
    primaryContact: { name: 'Testcase Contact', relationship: 'Daughter', phone: '404-555-0101' },
    emergencyContacts: [{ name: 'Testcase Emergency', relationship: 'Son', phone: '404-555-0102' }],
    crisisNotify: 'Testcase Contact 404-555-0101',
    medicalTeam: { pcpName: 'Dr Testcase', preferredHospital: 'Test General', preferredPharmacy: 'Test Pharmacy' },
    allergies: 'None known',
    advanceDirective: { status: 'No' }
  },
  ...over
});

// ── 1. Lane separation (Scope A) ─────────────────────────────────────

test('the registry carries fourteen consents and the two service agreements are separate keys', () => {
  assert.equal(R.GFC_CONSENT_DEFS.length, 14);
  const sa = R.GFC_CONSENT_DEFS.find(d => d.type === 'serviceAgreement');
  const ihpc = R.GFC_CONSENT_DEFS.find(d => d.type === 'ihpcServiceAgreement');
  assert.ok(sa, 'serviceAgreement is still in the registry');
  assert.ok(ihpc, 'ihpcServiceAgreement was added');
  // The whole point of Scope A: serviceAgreement is no longer scope 'both'.
  assert.equal(sa.scope, 'phc');
  assert.equal(ihpc.scope, 'ihpc');
  assert.equal(ihpc.required, true);
});

test('a PHC-only client is never presented a clinical consent', () => {
  const types = R.consentDefsForServiceLine('PHC').map(d => d.type);
  ['consentToTreat', 'assignmentOfBenefits', 'practiceNpp', 'ihpcServiceAgreement'].forEach(t => {
    assert.equal(types.includes(t), false, `${t} must not reach a home-care-only client`);
  });
  assert.ok(types.includes('serviceAgreement'));
  assert.ok(types.includes('financialAgreement'));
  assert.ok(types.includes('pcaScope'));
});

test('an IHPC-only patient signs the clinical agreement and never the home care one', () => {
  const types = R.consentDefsForServiceLine('IHPC').map(d => d.type);
  assert.equal(types.includes('serviceAgreement'), false);
  assert.equal(types.includes('financialAgreement'), false);
  assert.equal(types.includes('pcaScope'), false);
  assert.ok(types.includes('ihpcServiceAgreement'));
  assert.ok(types.includes('consentToTreat'));
});

test('a BOTH client is presented BOTH agreements — two entries, not one collapsed row', () => {
  const required = R.requiredConsentTypes('BOTH');
  assert.ok(required.includes('serviceAgreement'));
  assert.ok(required.includes('ihpcServiceAgreement'));
  // A dual-lane client signs two agreements. That is correct, not duplication.
  assert.equal(new Set(required).size, required.length, 'no duplicate keys');
});

test('required-consent counts per lane match the approved packets: 9 / 10 / 13', () => {
  assert.equal(R.requiredConsentTypes('PHC').length, 9);
  assert.equal(R.requiredConsentTypes('IHPC').length, 10);
  assert.equal(R.requiredConsentTypes('BOTH').length, 13);
});

// ── 2. The PHC -> BOTH transition (Scope F3) ─────────────────────────

test('PHC -> BOTH recomputes the consent set, writes the new ones pending, and flags the client', () => {
  const client = baseClient({
    serviceLine: 'PHC',
    enrollmentStatus: 'enrolled',
    consents: R.requiredConsentTypes('PHC').reduce((a, t) => { a[t] = 'signed'; return a; }, {})
  });
  const change = R.applyServiceLineChange(client, 'BOTH', { id: 'u-1', name: 'Admin' });

  assert.ok(change, 'a real lane change is reported');
  assert.equal(change.from, 'PHC');
  assert.equal(change.to, 'BOTH');
  // THE HOLE: before 4.6 the client passed into the clinical lane with
  // serviceAgreement already satisfied and no clinical agreement anywhere.
  assert.ok(change.newlyRequired.includes('ihpcServiceAgreement'));
  assert.equal(client.consents.ihpcServiceAgreement, 'pending');
  assert.equal(client.consents.consentToTreat, 'pending');
  // A signature is a fact: the home care agreement is still signed.
  assert.equal(client.consents.serviceAgreement, 'signed');
  // Nobody used to be told. Now they are.
  assert.ok(client.consentActionRequired);
  assert.equal(client.consentActionRequired.reason, 'service_line_changed');
  assert.ok(client.consentActionRequired.titles.includes('In-Home Primary Care Services Agreement'));
  assert.equal(client.reviewStatus, 'needs_followup');
  assert.equal(client.serviceLineHistory.length, 1);
});

test('a no-op service-line save changes nothing', () => {
  const client = baseClient({ serviceLine: 'PHC' });
  assert.equal(R.applyServiceLineChange(client, 'PHC', {}), null);
  assert.equal(client.serviceLineHistory, undefined);
});

test('PHC -> IHPC keeps the home care signature on file but stops counting it', () => {
  const client = baseClient({ serviceLine: 'PHC', consents: { serviceAgreement: 'signed' } });
  const change = R.applyServiceLineChange(client, 'IHPC', {});
  assert.ok(change.noLongerRequired.includes('serviceAgreement'));
  assert.equal(client.consents.serviceAgreement, 'signed', 'the record is kept, never erased');
  assert.equal(R.requiredConsentTypes('IHPC').includes('serviceAgreement'), false);
});

// ── 3. Provenance: an inactive consent cannot be signed (Scopes E1, F4) ──

test('the inactive consent is flagged inactive and is not required', () => {
  const m = R.GFC_CONSENT_DEFS.find(d => d.type === 'monitoring');
  assert.equal(m.inactive, true);
  assert.equal(m.required, false);
});

test("'signed' is never a satisfying status without a timestamp and an IP", () => {
  assert.equal(R.consentRecordHasProvenance('signed', { signedAt: '2026-09-08T00:00:00Z', ipHash: 'x' }), true);
  // The exact record Scope E1 found in a live packet: signed, no provenance.
  assert.equal(R.consentRecordHasProvenance('signed', {}), false);
  assert.equal(R.consentRecordHasProvenance('signed', { signedAt: '2026-09-08T00:00:00Z' }), false);
  assert.equal(R.consentRecordHasProvenance('signed', { ipHash: 'x' }), false);
  assert.equal(R.consentRecordHasProvenance('pending', null), true);
});

test('an inactive opt-in is not a satisfying status — it must never look like an executed consent', () => {
  assert.equal(R.isConsentSatisfied('optin_recorded'), false);
  assert.equal(R.isConsentSatisfied('na'), false);
  assert.ok(R.CONSENT_STATUSES.includes('optin_recorded'));
});

test('the sign endpoint refuses to sign an inactive consent and records a preference instead', () => {
  // Build-enforced: the handler must branch on def.inactive and must not write
  // 'signed' on that branch (server.js:8298 used to do exactly that).
  const handler = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/gfc/consents'"),
    serverSrc.indexOf("// Confirmation email on enrollment")
  );
  assert.ok(handler.length > 100, 'found the consent-sign handler');
  const inactiveBranch = handler.slice(handler.indexOf('if (def.inactive)'), handler.indexOf('const pres = consentRender.presentability'));
  assert.ok(inactiveBranch.includes("optin_recorded"), 'the inactive branch records a preference');
  assert.equal(/\[type\]:\s*optOut\s*\?\s*'na'\s*:\s*'signed'/.test(inactiveBranch), false,
    "the inactive branch must never write 'signed'");
  assert.ok(inactiveBranch.includes('recordedAt'), 'even a preference carries provenance');
  assert.ok(inactiveBranch.includes('ipHash'), 'even a preference carries a client IP');
});

test('buildConsentSignature refuses to produce a record with no client IP', () => {
  const req = { headers: {}, socket: {} };
  assert.throws(
    () => R.buildConsentSignature({ type: 'npp', typedName: 'A B', req, hashIp: () => null }),
    /timestamp and a client IP/
  );
});

test('buildConsentSignature stamps the body version, the elections, and both IP hashes', () => {
  const req = { headers: { 'x-forwarded-for': '104.179.178.191, 10.48.13.42, 127.0.0.1' }, socket: {} };
  const sig = R.buildConsentSignature({
    type: 'consentToTreat', typedName: '  Testcase Client  ', req,
    bodyVersion: T.CURRENT_VERSION, choices: { telehealth: 'consent' }, hashIp
  });
  assert.equal(sig.typedName, 'Testcase Client');
  assert.equal(sig.acknowledged, true);
  assert.ok(sig.signedAt);
  assert.equal(sig.version, T.CURRENT_VERSION);
  assert.deepEqual(sig.choices, { telehealth: 'consent' });
  assert.ok(sig.ipChainHash && sig.ipChainHash !== sig.ipHash);
});

// ── 4. IP capture (Scope E3) ─────────────────────────────────────────

test('the stored IP is the client address, not the whole forwarded chain', () => {
  const req = { headers: { 'x-forwarded-for': '104.179.178.191, 10.48.13.42, 127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  // The live packet recorded the entire chain — public IP plus an internal hop
  // plus loopback — which is noise as an audit identifier.
  assert.equal(R.clientIpFrom(req), '104.179.178.191');
  assert.equal(R.ipChainFrom(req), '104.179.178.191, 10.48.13.42, 127.0.0.1');
  assert.equal(R.clientIpFrom({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }), '10.0.0.5');
  assert.equal(R.clientIpFrom({ headers: {}, socket: {} }), null);
});

test('no signature path hashes the raw forwarded chain any more', () => {
  assert.equal(serverSrc.includes("hashIp(req.headers['x-forwarded-for']"), false,
    'every hashIp call must go through clientIpFrom()');
});

// ── 5. careTier is a home care concept (Scope G3) ────────────────────

test('careTier is counted for PHC and BOTH only, never for an IHPC-only patient', () => {
  const list = serverSrc.slice(
    serverSrc.indexOf('const ENROLLMENT_REQUIRED_FIELDS = ['),
    serverSrc.indexOf('const enrollmentFieldsFor =')
  );
  assert.ok(list.length > 100, 'found the checklist');
  const careTierRow = list.split('\n').find(l => l.includes("key: 'careTier'"));
  assert.ok(careTierRow, 'careTier is still on the checklist');
  // An IHPC-only patient will never legitimately have a Track A/B placement, so
  // counting it made their completion permanently short of 100%.
  assert.ok(careTierRow.includes('PHC_LANES'), 'careTier must be lane-scoped to home care');
  // And every entry must declare its lanes — no global entries left.
  const entryLines = list.split('\n').filter(l => /^\s*\{\s*key: '/.test(l));
  entryLines.forEach(l => assert.ok(/lanes:/.test(l), `checklist entry has no lanes: ${l.trim().slice(0, 60)}`));
});

test('the checklist covers the fields the consent bodies render (Scope G2)', () => {
  const list = serverSrc.slice(
    serverSrc.indexOf('const ENROLLMENT_REQUIRED_FIELDS = ['),
    serverSrc.indexOf('const enrollmentFieldsFor =')
  );
  // Enrollment used to read complete while the data a consent depends on was
  // still missing, so the gap surfaced at the kitchen table instead of at intake.
  ['agreedRate', 'crisisNotify', 'advanceDirective', 'allergies', 'pharmacy', 'pcp', 'preferredHospital', 'ltcPolicy', 'coverage']
    .forEach(k => assert.ok(list.includes(`key: '${k}'`), `${k} is on the checklist`));
});

// ── 6. The rate gate (Scope B2) ──────────────────────────────────────

test('financialAgreement is not presentable until an agreed rate exists', () => {
  const client = baseClient();
  const before = RENDER.presentability(T, 'financialAgreement', client);
  assert.equal(before.presentable, false);
  assert.equal(before.code, 'RATE_NOT_SET');
  assert.match(before.message, /rate/i);

  client.rateAgreement = { hourlyRate: 32, dailyMinimumHours: 4 };
  const after = RENDER.presentability(T, 'financialAgreement', client);
  assert.equal(after.presentable, true);
});

test('the rate table renders real figures from the client record, never a default', () => {
  const client = baseClient({ rateAgreement: { hourlyRate: 32.5, dailyMinimumHours: 4 } });
  const table = RENDER.resolveDataSource('rateTable', client);
  assert.equal(table.blocked, false);
  const hourly = table.rows.find(r => r.label === 'Hourly rate');
  assert.equal(hourly.value, '$32.50 per hour');
  assert.ok(table.rows.find(r => r.label === 'Daily minimum').value.startsWith('4 hours'));
  assert.ok(table.rows.some(r => r.label === 'Cancellation window'));
  assert.ok(table.rows.some(r => r.label === 'Notice before a rate change'));
});

test('a partial rate does not count as a rate', () => {
  assert.equal(RENDER.hasRateAgreement({ rateAgreement: { hourlyRate: 32 } }), false);
  assert.equal(RENDER.hasRateAgreement({ rateAgreement: { hourlyRate: 0, dailyMinimumHours: 4 } }), false);
  assert.equal(RENDER.hasRateAgreement({}), false);
});

// ── 7. signed_offline (Scope D) ──────────────────────────────────────

test('signed_offline satisfies the gate for every consent type, including the new one', () => {
  T.types().forEach(type => {
    assert.equal(R.isConsentSatisfied('signed_offline'), true, `${type}: paper signature satisfies`);
  });
  ['PHC', 'IHPC', 'BOTH'].forEach(line => {
    const consents = R.requiredConsentTypes(line).reduce((a, t) => { a[t] = 'signed_offline'; return a; }, {});
    const missing = R.requiredConsentTypes(line).filter(t => !R.isConsentSatisfied(consents[t]));
    assert.deepEqual(missing, [], `${line}: a fully paper-signed client passes the gate`);
  });
});

test('a paper-signed record is only valid with a date and a recorder', () => {
  assert.equal(R.consentRecordHasProvenance('signed_offline', { signedAt: '2026-09-02', recordedBy: 'u-1' }), true);
  assert.equal(R.consentRecordHasProvenance('signed_offline', {}), false);
});

// ── 8. ONE PASS (Scope G4) ───────────────────────────────────────────

test('every value a consent body needs resolves from the client record', () => {
  // A consent RENDERS a value for confirmation; it never re-collects it. If a
  // body references a source nothing implements, someone would have to be asked
  // for it again.
  T.types().forEach(type => {
    T.dataSourcesFor(type).forEach(src => {
      assert.ok(RENDER.SOURCES[src], `${type} renders "${src}" but consentRender implements no such source`);
    });
  });
});

test('no consent body collects anything except a genuine election', () => {
  // The only interactive block a body may carry is `choice`, and a choice is a
  // DECISION (telehealth yes/no) rather than a datum already on the record.
  const ELECTIONS = ['telehealth', 'students', 'photoLikeness', 'codeStatus'];
  const seen = [];
  T.types().forEach(type => {
    T.bodyFor(type).forEach(b => {
      assert.ok(['p', 'h', 'sub', 'ul', 'note', 'data', 'choice'].includes(b.t), `${type}: unknown block type ${b.t}`);
      if (b.t === 'choice') {
        assert.ok(ELECTIONS.includes(b.key), `${type}: "${b.key}" is not a recognised election — is it a datum that should be rendered instead?`);
        assert.ok(Array.isArray(b.options) && b.options.length >= 2, `${type}: ${b.key} needs options`);
        seen.push(b.key);
      }
    });
  });
  assert.ok(seen.includes('telehealth') && seen.includes('students'), 'the IHPC opt-ins are their own fields');
});

test('the identity re-statement exception belongs to roiProvider and to nothing else', () => {
  // The paper packet makes exactly one exception to the face-sheet rule,
  // because that document leaves the building and reaches an outside provider.
  const carriers = T.types().filter(t => T.dataSourcesFor(t).includes('clientIdentity'));
  assert.deepEqual(carriers, ['roiProvider']);
});

test('a client record that is complete on the checklist renders every consent it needs', () => {
  const client = baseClient({
    serviceLine: 'BOTH',
    rateAgreement: { hourlyRate: 32, dailyMinimumHours: 4 },
    payer: { type: 'medicare_b', insuranceIds: [{ carrier: 'Medicare', memberId: '1EG4TE5MK72' }] }
  });
  R.consentDefsForServiceLine('BOTH').forEach(def => {
    const pres = RENDER.presentability(T, def.type, client);
    assert.equal(pres.presentable, true, `${def.type} should be presentable: ${pres.message}`);
  });
});

// ── 9. Body versions and the signed copy (Scope C) ───────────────────

test('every registry entry has a body, a title and a paper source', () => {
  R.GFC_CONSENT_DEFS.forEach(def => {
    assert.ok(T.bodyFor(def.type).length > 0, `${def.type} has a body`);
    assert.ok(def.title && def.title !== def.type, `${def.type} has a real title`);
    assert.ok(def.paperSource, `${def.type} names the paper document it maps to`);
    assert.equal(def.bodyVersion, T.CURRENT_VERSION);
  });
});

test('a consent signed against an older version renders that version, not the current text', () => {
  // A copy must reproduce what the client actually saw. The pre-4.6 placeholder
  // for emergencyFinancial opened by authorizing emergency TREATMENT — a consent
  // a home care agency cannot take — and that is what an old signature's copy
  // has to show, not the corrected wording.
  const old = T.bodyFor('emergencyFinancial', T.LEGACY_VERSION);
  const now = T.bodyFor('emergencyFinancial', T.CURRENT_VERSION);
  assert.notDeepEqual(old, now);
  assert.ok(T.hasArchivedBody('emergencyFinancial', T.LEGACY_VERSION));
  assert.match(old[0].text, /authorize emergency treatment/i);
  assert.match(now.map(b => b.text || '').join(' '), /not a consent to medical treatment/i);
});

test('the corrected emergency consent authorizes summoning help, not treatment (Scope B1)', () => {
  const text = T.bodyFor('emergencyFinancial').map(b => b.text || (b.items || []).join(' ')).join(' ');
  assert.match(text, /call 911/i);
  assert.match(text, /consent to that treatment is given to them, not to Godwins Family Care/i);
  assert.equal(/I authorize emergency treatment and transport as needed/i.test(text), false);
  assert.equal(T.titleFor('emergencyFinancial'), 'Emergency Response and Financial Responsibility');
  // The financial-responsibility half is kept.
  assert.match(text, /responsible for payment of all Godwins Family Care invoices/i);
});

test('the bill of rights DISPLAYS the state complaint numbers (Intake Spec §2B)', () => {
  const text = T.bodyFor('billOfRights').map(b => b.text || (b.items || []).join(' ')).join(' ');
  assert.match(text, /1-800-878-6442/);
  assert.match(text, /404-657-8935/);
  assert.match(text, /1-866-552-4464/);
});

test('the home care agreement keeps the anti-kickback tying language verbatim (Scope B8)', () => {
  const text = T.bodyFor('serviceAgreement').map(b => b.text || '').join(' ');
  assert.match(text, /creates no provider-patient relationship/i);
  assert.match(text, /Declining medical care from Godwins Family Care has no effect on the home care/i);
  assert.match(text, /accepting home care is never a condition of receiving medical care/i);
});

test('the crisis protocol is a protocol, not a paragraph (Scope B5)', () => {
  const blocks = T.bodyFor('crisisProtocol');
  const headings = blocks.filter(b => b.t === 'h').map(b => b.text);
  assert.ok(headings.length >= 6, 'medical, urgent, mental health, fire/weather, no-answer, call order');
  const text = blocks.map(b => b.text || (b.items || []).join(' ')).join(' ');
  assert.match(text, /988/);
  assert.match(text, /pressing 1/i, 'the veterans line');
  assert.match(text, /welfare check/i);
  assert.ok(T.dataSourcesFor('crisisProtocol').includes('callOrder'), 'the per-client call order is rendered');
});

test('the ZIP the consent packet is built with is a real archive', () => {
  const zip = createZip([{ name: 'a.pdf', data: Buffer.from('%PDF-1.4 test') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local file header signature');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'end of central directory signature');
  assert.equal(zip.readUInt16LE(zip.length - 14), 1, 'one entry');
  assert.throws(() => createZip([]), /at least one entry/);
});

// ── One registry, one place (Scope F1) ───────────────────────────────

test('the admin form no longer keeps its own copy of the registry', () => {
  // Two sources of truth that had ALREADY drifted: `monitoring` existed
  // server-side and in neither client array, and the BOTH lane was built with
  // new Map(), which deduped the service agreement down to a single row.
  assert.equal(/const CONSENT_DEFS_BY_LINE = \{/.test(adminSrc), false);
  assert.equal(adminSrc.includes('new Map([...CONSENT_DEFS_BY_LINE.PHC'), false);
  assert.ok(adminSrc.includes('api.consentRegistry('), 'the admin form fetches the registry');
});

test('the consent registry endpoint is staff-gated and serves the whole list', () => {
  const route = serverSrc.slice(serverSrc.indexOf("'/api/gfc/admin/enrollment/meta/consent-registry'"), serverSrc.indexOf("// PUT /api/gfc/admin/enrollment/:clientId/rate"));
  assert.ok(route.includes('requireEnrollmentStaff'));
  assert.ok(route.includes('consentDefs'));
  assert.ok(route.includes('requiredConsents'));
});

// ── The client's copy is the client's (Scope E2) ─────────────────────

test('the internal review banner never renders on a client-facing packet', () => {
  const pdfSrc = fs.readFileSync(path.join(root, 'pdf-generator.js'), 'utf8');
  const banner = pdfSrc.split('\n').filter(l => l.includes('counsel'));
  // Every mention must be inside an `options.internal` branch or a comment.
  const rendered = banner.filter(l => l.includes('.text(') );
  rendered.forEach(l => {
    assert.ok(l.includes('INTERNAL COPY'), `client-facing banner still present: ${l.trim().slice(0, 80)}`);
  });
  assert.ok(pdfSrc.includes('if (options && options.internal)'), 'the packet banner is gated on the staff audience');
  const portalSrc = fs.readFileSync(path.join(root, 'public', 'portal.html'), 'utf8');
  assert.equal(/Working draft — pending counsel/.test(portalSrc), false, 'and off the client portal too');
});

// ── The paper path for a client who already exists ───────────────────

test('a blank copy renders the body unsigned, with no election pre-marked', async () => {
  // The seven legacy patients are homebound and on the clinical line. Printing
  // the agreement, signing it at the visit and scanning it back is the path
  // that completes for them; e-signing in a portal is not.
  const pdf = require('../pdf-generator');
  const client = baseClient({ serviceLine: 'IHPC' });
  const buf = await pdf.generateConsentPDF(client, 'ihpcServiceAgreement', {
    status: 'pending', meta: {}, blank: true
  });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');

  // A blank copy must never carry an election as chosen — the client ticks it
  // by hand — so a meta.choices left on the record cannot leak into the print.
  const withChoices = await pdf.generateConsentPDF(client, 'consentToTreat', {
    status: 'pending', meta: { choices: { telehealth: 'consent', students: 'consent' } }, blank: true
  });
  const unmarked = await pdf.generateConsentPDF(client, 'consentToTreat', {
    status: 'pending', meta: {}, blank: true
  });
  assert.equal(withChoices.length, unmarked.length,
    'a blank copy renders identically whether or not elections are on the record');
});

test('recording a paper signature requires the scan, a real past date, and an active consent', () => {
  // Build-enforced: the route is what the seven legacy patients depend on, and
  // a paper consent recorded with nothing behind it is the same
  // provenance-free record Scope E1 found, entered by a different hand.
  const route = serverSrc.slice(
    serverSrc.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/consent/:type/offline'"),
    serverSrc.indexOf("// GET /api/gfc/admin/enrollment/:clientId/enrollment-packet.zip")
  );
  assert.ok(route.length > 500, 'found the record-paper-signature route');
  assert.ok(route.includes('requireEnrollmentStaff'), 'staff-gated at the API layer');
  assert.ok(route.includes('CONSENT_SCAN_REQUIRED'), 'the scan is the evidence and is required');
  assert.ok(route.includes('CONSENT_SIGNED_DATE_REQUIRED'));
  assert.ok(route.includes('CONSENT_SIGNED_DATE_INVALID'), 'a future signing date is refused');
  assert.ok(route.includes('CONSENT_INACTIVE'), 'an inactive consent cannot be signed on paper either');
  assert.ok(route.includes('CONSENT_NOT_IN_LANE'), 'lane separation holds on the paper path too');
  assert.ok(route.includes('recordedByName') && route.includes('recordedAt'),
    'who keyed it and when is part of the record');
  assert.ok(route.includes("consentReaffirmRequired"),
    'grandfathering clears its flag as evidence lands, one consent at a time');
});

test('signed_offline can now be written for a client who already exists', () => {
  // Before this, the ONLY site writing signed_offline was the endpoint that
  // CREATES a client through offline onboarding — useless for seven patients
  // who are already on file.
  const createPath = serverSrc.indexOf("app.post('/api/gfc/admin/enrollment/offline'");
  const existingPath = serverSrc.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/consent/:type/offline'");
  assert.ok(createPath > 0 && existingPath > 0, 'both paths exist');
  assert.notEqual(createPath, existingPath);
});
