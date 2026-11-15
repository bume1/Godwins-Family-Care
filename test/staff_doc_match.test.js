'use strict';
// Documents on file fulfil their requirements (owner, 2026-11-15): a paper
// form the office uploads is read two ways (the printed title and an AI
// check), the office confirms it, and it counts in Pay Setup, payroll and
// onboarding. TEST DATA only: the forms read here are the blank government
// forms the app already fills.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../staffDocMatch');
const pp = require('../payrollProfiles');
const T = require('../onboarding/track');

const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '');
const src = (f) => strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
const blank = (f) => fs.readFileSync(path.join(__dirname, '..', 'govforms', f));

// ── the smart match ─────────────────────────────────────────────────────────────
test('the printed title reads each blank government form as itself', async () => {
  const want = { 'fw9-2024-03.pdf': 'w9', 'fw4-2026.pdf': 'w4', 'i9-2025-01-20.pdf': 'i9', 'g4-2026-06-03.pdf': 'g4', 'fw8ben-2021-10.pdf': 'w8ben' };
  for (const [file, kind] of Object.entries(want)) {
    const t = await M.textOf({ bytes: blank(file), mimeType: 'application/pdf' });
    assert.equal(t.source, 'text', file);
    const m = M.smartMatch(t.text);
    assert.ok(m, `${file} was not recognised`);
    assert.equal(m.kind, kind, file);
    assert.match(m.evidence, /^Reads "/);
  }
});

test('a number alone is not a form: "give us your W-9" is not a W-9', () => {
  assert.equal(M.smartMatch('Please return your W-9 to the office by Friday.'), null);
  assert.equal(M.smartMatch('Bring a List A document for your I-9.'), null);
  assert.equal(M.smartMatch(''), null);
  assert.equal(M.smartMatch('Mileage log for October'), null);
});

test('a G-4 that mentions the W-4 still reads as a G-4', () => {
  const t = 'STATE OF GEORGIA EMPLOYEE\'S WITHHOLDING ALLOWANCE CERTIFICATE G-4 ... see your federal Form W-4 Employee\'s Withholding Certificate';
  assert.equal(M.smartMatch(t).kind, 'g4');
});

// ── the AI scan and the verdict ───────────────────────────────────────────────
test('the AI scan reports "not run" when the model is off, and never guesses', async () => {
  const off = await M.aiScan({ bytes: Buffer.from('x'), mimeType: 'application/pdf', aiRead: async () => { const e = new Error('no'); e.code = 'MODEL_BOUNDARY_REFUSED'; throw e; } });
  assert.deepEqual(off, { status: 'not_run', reason: 'The AI check is not switched on yet (Vertex setup).' });
  assert.equal((await M.aiScan({ bytes: Buffer.from('x'), mimeType: 'x' })).status, 'not_run');
  const odd = await M.aiScan({ bytes: Buffer.from('x'), mimeType: 'x', aiRead: async () => ({ proposal: { kind: 'tax_return' } }) });
  assert.equal(odd.status, 'not_run', 'a kind outside the closed list is not an answer');
  const ok = await M.aiScan({ bytes: Buffer.from('x'), mimeType: 'x', aiRead: async () => ({ proposal: { kind: 'w9', confidence: 0.97 } }) });
  assert.deepEqual([ok.status, ok.kind, ok.confidence], ['ok', 'w9', 0.97]);
  // It is never asked for a number.
  assert.deepEqual(Object.keys(M.AI_SCHEMA.fields).sort(), ['confidence', 'formRevision', 'kind', 'nameOnForm']);
});

test('the verdict: agree, disagree, one read, unknown; "not run" never counts as agreement', () => {
  const s = { kind: 'w9' }, aiW9 = { status: 'ok', kind: 'w9' }, aiW4 = { status: 'ok', kind: 'w4' }, off = { status: 'not_run' };
  assert.equal(M.verdict(s, aiW9, 'w9').verdict, 'agree');
  assert.equal(M.verdict(s, aiW4, 'w9').verdict, 'disagree');
  assert.equal(M.verdict(s, off, 'w9').verdict, 'one_read');
  assert.equal(M.verdict(null, off, 'w9').verdict, 'unknown');
  assert.equal(M.verdict(null, { status: 'ok', kind: 'other' }, 'w9').verdict, 'unknown');
  // Filed as one thing, reads as another.
  const v = M.verdict(s, off, 'other');
  assert.deepEqual([v.readsAs, v.filedAsDiffers], ['w9', true]);
  assert.equal(M.verdict(s, aiW4, 'w9').filedAsDiffers, true, 'a disagreement is flagged too');
  assert.match(M.summary({ ...M.verdict(s, off, 'w9'), smart: s, ai: { status: 'not_run', reason: 'off' } }, 'w9'), /printed title only\). AI check not run: off/);
});

test('matchDocument reads, scans and keeps both, without throwing on a bad file', async () => {
  const m = await M.matchDocument({ bytes: blank('fw9-2024-03.pdf'), mimeType: 'application/pdf', filedAs: 'w9', textOf: M.textOf, at: 'T' });
  assert.deepEqual([m.verdict, m.readsAs, m.text, m.ai.status], ['one_read', 'w9', 'text', 'not_run']);
  const bad = await M.matchDocument({ bytes: Buffer.from('nope'), mimeType: 'application/pdf', filedAs: 'w9', textOf: async () => { throw new Error('boom'); } });
  assert.equal(bad.verdict, 'unknown');
});

// ── on file in Pay Setup ──────────────────────────────────────────────────────
const at = '2026-11-15T15:00:00.000Z';
const w9Body = { name: 'Test Person', taxClass: Object.keys(pp.W9_CLASS)[0], tin: '123-45-6789', signedName: 'Test Person', signedOn: '2026-10-01' };

test('a paper W-9 needs the taxpayer ID, the name signed and the date signed', () => {
  const ctx = { at, by: 'Office', documentId: 'cgdoc_1' };
  assert.equal(pp.normalizeFormOnFile('w9', { ...w9Body, tin: '' }, ctx).code, 'W9_TIN');
  assert.equal(pp.normalizeFormOnFile('w9', { ...w9Body, signedName: '' }, ctx).code, 'ON_FILE_SIGNED_NAME');
  assert.equal(pp.normalizeFormOnFile('w9', { ...w9Body, signedOn: '2027-01-01' }, ctx).code, 'ON_FILE_SIGNED_ON', 'not a future date');
  assert.equal(pp.normalizeFormOnFile('w9', w9Body, { ...ctx, documentId: '' }).code, 'ON_FILE_DOCUMENT');
  const n = pp.normalizeFormOnFile('w9', w9Body, ctx);
  assert.equal(n.tin, '123456789');
  assert.equal(n.value.signedAt, '2026-10-01T12:00:00.000Z', 'the paper\'s date, not today');
  assert.deepEqual([n.value.onFile.documentId, n.value.onFile.source], ['cgdoc_1', 'paper']);
  assert.equal(n.value.ipHash, null);
});

test('a W-4 on paper carries what payroll computes tax from', () => {
  const n = pp.normalizeFormOnFile('w4', { filingStatus: Object.keys(pp.W4_FILING)[0], extraWithholding: '25', signedName: 'T', signedOn: '2026-09-01' }, { at, by: 'O', documentId: 'd' });
  assert.equal(n.value.extraWithholdingCents, 2500);
  assert.ok(n.value.onFile);
  assert.equal(pp.normalizeFormOnFile('w4', { signedName: 'T', signedOn: '2026-09-01' }, { at, by: 'O', documentId: 'd' }).code, 'W4_FILING_STATUS');
});

test('on file counts as done in Pay Setup and clears what stops pay; the copy is the uploaded one', () => {
  const p = { workerType: '1099', taxAddress: {}, payMethod: { method: 'check' } };
  assert.deepEqual(pp.missingForPay(p, { asContractor: true }), ['W-9']);
  p.w9 = pp.normalizeFormOnFile('w9', w9Body, { at, by: 'O', documentId: 'cgdoc_9' }).value;
  assert.deepEqual(pp.missingForPay(p, { asContractor: true }), []);
  const row = pp.checklist(p).find(r => r.key === 'w9');
  assert.equal(row.done, true);
  assert.equal(row.onFileDocumentId, 'cgdoc_9');
  assert.match(row.note, /signed on paper and filed by the office/);
  // A W-9 signed in the app has no on-file copy.
  const app = pp.checklist({ workerType: '1099', w9: { signedAt: at } }).find(r => r.key === 'w9');
  assert.equal(app.onFileDocumentId, undefined);
});

test('an I-9 on file names its document, and the document replaces the old tick box', () => {
  assert.equal(pp.normalizeI9OnFile({ firstDay: '2026-01-05' }, { at, by: 'O' }).code, 'I9_COPY_NOT_FILED');
  const n = pp.normalizeI9OnFile({ firstDay: '2026-01-05', documentId: 'cgdoc_i9' }, { at, by: 'O' });
  assert.equal(n.value.documentId, 'cgdoc_i9');
  const row = pp.checklist({ workerType: 'W2', i9: { onFile: n.value } }).find(r => r.key === 'i9');
  assert.deepEqual([row.done, row.onFileDocumentId], [true, 'cgdoc_i9']);
});

// ── onboarding follows ──────────────────────────────────────────────────────────
test('onboarding: a Pay Setup form done fulfils her SUBMIT; on file by the office fulfils VERIFY; it never reopens an item', () => {
  const item = { id: 'X', steps: [{ actor: 'NEW_HIRE', action: 'SUBMIT' }, { actor: 'PAYROLL_FINANCE_OFFICER', action: 'VERIFY' }], packet: ['payform:w9', 'payform:pay'] };
  const rows = (w9, pay, office) => [{ kind: 'payform:w9', required: true, status: w9, source: office ? 'office' : 'caregiver' }, { kind: 'payform:pay', required: true, status: pay, source: 'caregiver' }];
  const run = (r, state) => T.itemStatus(item, state, '2026-11-15', r);
  assert.equal(run(rows('missing', 'missing'), {}), 'NOT_STARTED');
  assert.equal(run(rows('complete', 'complete', false), {}), 'SUBMITTED', 'done in Pay Setup by her: the office still verifies');
  // On file by the office: W-9 office, but pay is hers, so VERIFY waits until all are office.
  const allOffice = [{ kind: 'payform:w9', required: true, status: 'complete', source: 'office' }, { kind: 'payform:pay', required: true, status: 'complete', source: 'office' }];
  assert.equal(run(allOffice, {}), 'COMPLETE');
  // Already finished by its steps: missing Pay Setup rows do not reopen it.
  assert.equal(run(rows('missing', 'missing'), { steps: { 0: { at }, 1: { at } } }), 'COMPLETE');
});

// ── the routes ───────────────────────────────────────────────────────────────────
test('SAFETY: on-file checks whose document it is, its type, that it was accepted, and what the reads said', () => {
  const r = src('routes/payroll.js');
  const i = r.indexOf("'/api/payroll/admin/people/:userId/forms/:form/on-file', authenticateToken, requirePayrollPreparer");
  assert.ok(i > 0);
  const body = r.slice(i, r.indexOf('router.', i + 80));
  assert.match(body, /String\(doc\.caregiver_id\) !== String\(user\.id\)/, 'only their own document');
  assert.match(body, /ON_FILE_KIND/, 'only a document filed as that form');
  assert.match(body, /doc\.status !== 'accepted'/, 'only an accepted document');
  assert.match(body, /readsOther && b\.confirmDifferent !== true/, 'the reads must not contradict it unless the office confirms');
  assert.match(body, /p\.tin = \{ enc: pc\.seal\(n\.tin, env\)/, 'the TIN is sealed, never stored plain');
  // The copy that opens is the uploaded one.
  assert.match(r, /const paper = await onFileDocFor\(user, p, key\);\s*if \(paper\)/);
});

test('reading runs after the upload is answered, and a broken image cannot crash the server', () => {
  const c = src('routes/caregiver.js');
  assert.match(c, /if \(shouldMatch\(kind\)\) setImmediate\(\(\) => matchAndKeep\(.*\)\.catch\(/);
  assert.match(src('staffDocMatch.js'), /errorHandler: \(\) => \{\}/);
  // The AI read goes only through the model engine's declared purpose.
  assert.match(src('server.js'), /staffDocAiRead: \(\{ input, schema, actor \}\) => gfcModelEngine\.invoke\(\{\s*purpose: modelEngine\.PURPOSES\.DOCUMENT_CLASSIFICATION/);
});

// ── the phone ──────────────────────────────────────────────────────────────────
test('nothing on My GFC is wider than a phone: the availability row and the form workspace shrink', () => {
  const sch = src('public/components/caregiver-schedule.js');
  assert.match(sch, /\.gfcs \.g3\{display:grid;grid-template-columns:minmax\(0,1\.2fr\) minmax\(0,1fr\) minmax\(0,1fr\) auto/, 'plain fr columns let the time boxes push the page wider than the screen');
  const pay = src('public/my-pay.js');
  assert.match(pay, /\.mp-ws-body\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(pay, /\.mp-ws-fields input\[type=text\][^{]*\{[^}]*box-sizing:border-box[^}]*font-size:16px/, '16px so iPhone does not zoom into a box');
  assert.match(src('public/document-sign-ui.js'), /\.ds-ws-body\{grid-template-columns:minmax\(0,1fr\)/);
});
