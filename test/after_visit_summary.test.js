// ============================================================================
// After-visit summary (owner, 2026-09-29). What this pins:
//   1. Follow-up instructions and the summary keep their line breaks.
//   2. The medication section says what was STARTED, REFILLED, CHANGED and
//      STOPPED at the visit and lists the full current medicines.
//   3. Allergies, the next visit, GFC's number (incl. after hours) and when to
//      call 911 are always on the page, and a list that could not be read is
//      never printed as "none".
//   4. Nothing clinician-only (codes, NPI, fax, order reference) reaches it.
//   5. A family member only gets the sections the client shares.
//   6. Signed notes only; the patient route refuses another patient's visit.
//   7. A reconciled medication list is not overwritten by an intake edit.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const avs = require('../afterVisitSummary');
const patientRead = require('../patientReadRepository');
const repo = require('../clinicalRepository');
const pdf = require('../pdf-generator');
const packetImport = require('../welcomePacketImport');
const consentText = require('../public/consent-text');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');
const CLINICAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');

const pdfText = async (buffer) => {
  const doc = await PDFDocument.load(buffer);
  return (await packetImport.extractRuns(doc)).map(r => r.text).join(' ').replace(/\s+/g, ' ');
};

// ── 1. line breaks ──────────────────────────────────────────────────────────
test('follow-up instructions keep their line breaks (a numbered list stays a list)', () => {
  const f = patientRead.buildPatientFacingFields({
    patientSummary: 'We checked your   blood pressure.\r\n\r\n\r\n\r\nWe changed your water pill.',
    followUpInstructions: '1. Take the new dose each morning.\n2. Call if you feel dizzy.\n   3. Weigh yourself daily.  '
  });
  assert.equal(f.followUpInstructions, '1. Take the new dose each morning.\n2. Call if you feel dizzy.\n3. Weigh yourself daily.');
  assert.equal(f.patientSummary, 'We checked your blood pressure.\n\nWe changed your water pill.', 'CRLF normalised, spaces squeezed, blank runs capped');
  assert.equal(patientRead.buildPatientFacingFields({ patientSummary: '  \n \n ' }).patientSummary, null);
});

test('the portal renders the summary and follow-up with their line breaks', () => {
  assert.match(PORTAL, /<div style=\{\{ whiteSpace: 'pre-wrap' \}\}>\{v\.overview \|\| v\.summary\}<\/div>/);
  assert.match(PORTAL, /whiteSpace: 'pre-wrap' \}\}><b style=\{\{ color: 'var\(--navy\)' \}\}>What happens next:<\/b> \{v\.followUp\}/);
});

// ── 2. medication changes ───────────────────────────────────────────────────
test('changes at the visit: started, refilled and changed from prescriptions; stopped and changed from reconciliation', () => {
  const rows = avs.buildMedicationChanges({
    prescriptions: [
      { kind: 'new', drug: 'Metformin', dose: '500 mg', route: 'oral', frequency: 'twice daily' },
      { kind: 'refill', drug: 'Lisinopril', dose: '10 mg', route: 'oral', frequency: 'daily' },
      { kind: 'change', drug: 'Furosemide', dose: '40 mg', route: 'oral', frequency: 'daily' }
    ],
    medChanges: [
      { action: 'stopped', name: 'Ibuprofen', dose: '400 mg' },
      { action: 'changed', name: 'Amlodipine', dose: '10 mg', frequency: 'daily', previous: { dose: '5 mg', frequency: 'daily' } },
      { action: 'started', name: 'Metformin' } // already listed from the Rx
    ]
  });
  const byTag = Object.fromEntries(rows.map(r => [r.text, r.tag]));
  assert.deepEqual(byTag, { Metformin: 'STARTED', Lisinopril: 'REFILLED', Furosemide: 'CHANGED', Ibuprofen: 'STOPPED', Amlodipine: 'CHANGED' });
  assert.match(rows.find(r => r.text === 'Ibuprofen').detail, /stop taking this/);
  assert.match(rows.find(r => r.text === 'Amlodipine').detail, /now 10 mg daily \(was 5 mg daily\)/);
  assert.equal(rows.filter(r => r.text === 'Metformin').length, 1, 'one line per medicine, not two');
});

test('reconciliation records started, stopped and changed against the list as it was', () => {
  let n = 0;
  const rows = repo.buildMedicationChangeRows({
    decisions: [
      { action: 'add', med: { name: 'Metformin', dose: '500 mg' } },
      { action: 'discontinue', med: { name: 'Ibuprofen', dose: '400 mg' } },
      { action: 'keep', med: { name: 'Amlodipine', dose: '10 mg', frequency: 'daily' } },
      { action: 'keep', med: { name: 'Aspirin', dose: '81 mg', frequency: 'daily' } }
    ],
    previous: [{ name: 'Amlodipine', dose: '5 mg', frequency: 'daily' }, { name: 'Aspirin', dose: '81 mg', frequency: 'daily' }],
    clientId: 'c1', encounterUuid: null, day: '2026-09-29', at: 'T', actor: { id: 'u', name: 'N' }, newId: () => `m${++n}`
  });
  assert.deepEqual(rows.map(r => `${r.action}:${r.name}`), ['started:Metformin', 'stopped:Ibuprofen', 'changed:Amlodipine']);
  assert.deepEqual(rows[2].previous, { dose: '5 mg', frequency: 'daily' });
  assert.ok(rows.every(r => r.day === '2026-09-29' && r.clientId === 'c1'));
});

test('a visit picks up its own reconciliation rows: by encounter, else by the visit date', () => {
  const rows = [
    { clientId: 'c1', encounterUuid: 'e1', day: '2026-09-01', action: 'stopped', name: 'A' },
    { clientId: 'c1', encounterUuid: null, day: '2026-09-29', action: 'stopped', name: 'B' },
    { clientId: 'c1', encounterUuid: null, day: '2026-09-28', action: 'stopped', name: 'C' },
    { clientId: 'c2', encounterUuid: 'e1', day: '2026-09-29', action: 'stopped', name: 'D' },
    { clientId: 'c1', encounterUuid: 'e9', day: '2026-09-29', action: 'stopped', name: 'E' }
  ];
  const got = avs.changesForVisit(rows, { clientId: 'c1', encounterUuid: 'e1', visitDate: '2026-09-29' }).map(r => r.name);
  assert.deepEqual(got, ['A', 'B']);
});

test('the reconciliation route logs the changes, against the list BEFORE the save', () => {
  const code = stripComments(SERVER);
  const i = code.indexOf("app.post('/api/clinical/patients/:clientId/medrec'");
  const block = code.slice(i, code.indexOf('app.', i + 40));
  const log = block.indexOf("db.set('medication_changes'");
  const overwrite = block.indexOf('users[idx].medications = resolved.rows');
  assert.ok(log > 0 && overwrite > log, 'the change log is written from the old list, before the list is replaced');
  assert.match(block, /previous: client\.medications/);
});

test('a reconciled list is not overwritten by an intake or enrollment edit', () => {
  assert.match(SERVER, /if \(Array\.isArray\(meds\) && !client\.medRecLast\) set\('medications', meds\);/);
});

test('a dose change is its own prescription kind, served to the form', () => {
  assert.ok(repo.RX_KINDS.includes('change'));
  assert.match(SERVER, /rxKinds: clinicalRepo\.RX_KINDS/);
  assert.match(CLINICAL, /\(kinds \|\| \['new', 'refill'\]\)\.map/);
});

// ── 3/4. the document itself ────────────────────────────────────────────────
const CLIENT = { id: 'c1', name: 'Juanita Guess', intake: { dob: '1948-03-11' }, allergies: 'Penicillin - rash', medications: [{ name: 'Aspirin', dose: '81 mg', frequency: 'daily' }] };
const RECORD = {
  encounterUuid: 'e1', date: '2026-09-29', reason: 'Follow-up',
  patientSummary: 'We checked your blood pressure.\nWe adjusted your water pill.',
  followUpInstructions: '1. Take the new dose each morning.\n2. Call if you feel dizzy.',
  diagnoses: [{ code: 'I10', description: 'High blood pressure' }], services: [{ code: '99349' }],
  renderingProvider: { name: 'Bethel Godwins', npi: '1234567893' }
};
const SNAP = {
  takenAt: '2026-09-29T15:00:00Z',
  medications: { source: 'chart', rows: [{ name: 'Furosemide 40 mg', detail: 'once daily' }, { name: 'Aspirin 81 mg', detail: 'daily' }] },
  allergies: { source: 'chart', rows: [{ text: 'Penicillin', detail: 'high risk' }], intakeText: 'Penicillin - rash' },
  nextVisit: { state: 'found', when: 'Thursday, October 15 at 10:00 AM', who: 'Bethel Godwins, FNP', where: 'Your home', asOfLabel: '9/29/2026, 11:00 AM ET' }
};
const build = (over = {}) => {
  const visit = patientRead.buildVisitSummary({
    encounterUuid: 'e1', encounter: null, record: RECORD, attestation: { signedAt: 'x' },
    prescriptions: [{ kind: 'change', drug: 'Furosemide', dose: '40 mg', route: 'oral', frequency: 'daily', prescriber: { npi: '1234567893' } }],
    orders: [{ orderType: 'referral', status: 'ordered', orderReference: 'GFC-ORD-ABC234', referral: { specialty: 'Home health', agencyPending: true, receivingFax: null } }]
  });
  return avs.assemble({
    client: CLIENT, record: RECORD, visit, sections: null,
    prescriptions: [{ kind: 'change', drug: 'Furosemide', dose: '40 mg', route: 'oral', frequency: 'daily' }],
    medChanges: [{ action: 'stopped', name: 'Ibuprofen' }], snapshot: SNAP, fallbackMeds: CLIENT.medications,
    intakeAllergies: CLIENT.allergies, org: consentText.ORG, dob: '1948-03-11',
    visitDateLabel: '9/29/2026', preparedLabel: 'now', ...over
  });
};

test('the rendered PDF carries every standard part of an after-visit summary', async () => {
  const text = await pdfText(await pdf.generateAfterVisitSummaryPDF(build()));
  for (const want of ['Visit Summary', 'What we did today', 'We adjusted your water pill', 'High blood pressure',
    'Your medications', 'Changes at this visit', 'CHANGED', 'Furosemide', 'STOPPED', 'Ibuprofen', 'Your current medications', 'Aspirin 81 mg',
    'Allergies', 'Penicillin', 'Home health', 'being arranged',
    'Follow-up instructions', '2. Call if you feel dizzy', 'Your next visit', 'Thursday, October 15', 'call us to confirm',
    consentText.ORG.phone, 'After hours', 'on-call', 'When to call 911', 'trouble breathing']) {
    assert.ok(text.toLowerCase().includes(want.toLowerCase()), `the summary must include "${want}"`);
  }
});

test('nothing clinician-only reaches the patient copy', async () => {
  const text = await pdfText(await pdf.generateAfterVisitSummaryPDF(build()));
  for (const bad of ['I10', '99349', '1234567893', 'GFC-ORD', consentText.ORG.fax, 'NPI']) {
    assert.ok(!text.includes(bad), `"${bad}" must not be on the patient's summary`);
  }
});

test('a list that could not be read is never printed as "none"', async () => {
  const d = build({ snapshot: { medications: { source: 'unavailable', rows: [] }, allergies: { source: 'unavailable', rows: [] }, nextVisit: { state: 'unavailable' } }, fallbackMeds: [], intakeAllergies: null, prescriptions: [], medChanges: [] });
  assert.equal(d.allergies, null);
  const text = await pdfText(await pdf.generateAfterVisitSummaryPDF(d));
  assert.match(text, /allergy list was not available/i);
  assert.doesNotMatch(text, /No allergies are recorded/i);
  assert.match(text, /medication list was not available/i);
  assert.match(text, /has not been scheduled yet/i);
});

test('with no chart read, the intake allergies and the app list are used and labelled', () => {
  const d = build({ snapshot: null });
  assert.deepEqual(d.allergies, [{ text: 'Penicillin - rash', detail: 'as reported when you enrolled' }]);
  assert.equal(d.medications.source, 'app');
  assert.equal(d.medications.current[0].text, 'Aspirin');
});

test('the after-hours line uses its own number once GFC has one', () => {
  assert.match(avs.contactLines({ phone: '404-000-0000' }).join(' '), /After hours, the same number \(404-000-0000\) reaches our on-call clinician/);
  assert.match(avs.contactLines({ phone: '404-000-0000', afterHoursPhone: '404-111-1111' }).join(' '), /After hours, call 404-111-1111/);
});

// ── 5. family sharing ───────────────────────────────────────────────────────
test('a family member only gets the sections the client shares', () => {
  const d = build({ sections: { visits: 'full', medications: 'none', allergies: 'none', appointments: 'none' } });
  assert.equal(d.allergies, undefined, 'allergies left out, not printed as empty');
  assert.deepEqual(d.medications.current, []);
  assert.equal(d.medications.hiddenCurrent, true);
  assert.equal(d.nextVisit, null);
});

// ── 6. routes ───────────────────────────────────────────────────────────────
test('both downloads are for SIGNED notes only; the patient route checks the visit is theirs', () => {
  const code = stripComments(SERVER);
  const staff = code.slice(code.indexOf("app.get('/api/clinical/patients/:clientId/encounters/:euuid/visit-summary.pdf'"), code.indexOf('const AVS_RECIPIENT_TYPES'));
  assert.match(staff, /authenticateToken, requireClinicalRead/);
  assert.match(staff, /if \(!ctx\.closed \|\| !ctx\.attestation\)/);
  const pat = code.slice(code.indexOf("app.get('/api/gfc/clinical/visits/:visitId/summary.pdf'"), code.indexOf("app.get('/api/gfc/clinical/care-plan.pdf'"));
  assert.match(pat, /authenticateToken, requireEnrolledClient/);
  assert.match(pat, /resolvePatientClinicalContext/);
  assert.match(pat, /r\.clientId === client\.id && String\(r\.encounterUuid\) === euuid/);
  assert.match(pat, /if \(!attestation\)/);
  assert.match(pat, /sections\.visits !== 'full'/);
  assert.doesNotMatch(pat, /openemr\.forActor/, 'the patient copy never reads OpenEMR');
});

test('the chart-derived parts are snapshotted at signing, and signing warns when "What we did today" is empty', () => {
  const code = stripComments(SERVER);
  const sign = code.slice(code.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/sign'"), code.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/co-sign'"));
  assert.match(sign, /record\.avsSnapshot = await buildAvsSnapshot/);
  assert.match(sign, /if \(!String\(record\.patientSummary \|\| ''\)\.trim\(\)\) \{\s*warnings\.push/);
  assert.match(CLINICAL, /"What we did today, in plain words" is empty\. You can still sign/);
});

test('"given to" is recorded with who, how and when, and the log carries no summary content', () => {
  const code = stripComments(SERVER);
  const g = code.slice(code.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/visit-summary/given'"), code.indexOf("app.put('/api/clinical/patients/:clientId/encounters/:euuid/note'"));
  assert.match(g, /authenticateToken, requireAvsRecorder/);
  assert.match(g, /orderReq\.SEND_CHANNELS\.includes\(channel\)/);
  assert.match(g, /db\.set\('after_visit_summary_disclosures'/);
  assert.doesNotMatch(g.slice(g.indexOf('logActivity')), /patientSummary|followUp/);
});

test('the portal offers the download only on a complete, fully shared visit', () => {
  assert.match(PORTAL, /\{v\.status === 'complete' && \(/);
  assert.match(PORTAL, /\/api\/gfc\/clinical\/visits\/\$\{encodeURIComponent\(v\.id\)\}\/summary\.pdf/);
});
