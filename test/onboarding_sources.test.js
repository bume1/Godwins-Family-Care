'use strict';

// Reading the source documents from Drive: .docx and HTML into lines, the
// version, the check questions, the Playbook drift check, and the loader.

const test = require('node:test');
const assert = require('node:assert');
const { createZip } = require('../zipWriter');
const D = require('../onboarding/documentText');
const P = require('../onboarding/sourceParsers');
const { createSourceLoader, VERSIONS_COLLECTION } = require('../onboarding/sourceLoader');
const { SOURCES } = require('../onboarding/sources');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const para = (text, italic) => `<w:p><w:r>${italic ? '<w:rPr><w:i/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const tableRow = (cells) => `<w:tr>${cells.map(c => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`;
function docx(bodyXml) {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${bodyXml}</w:body></w:document>`;
  return createZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf8') }]);
}

test('a .docx reads into lines: paragraphs, italic marked, tables as rows', () => {
  const buf = docx(para('12.4 Refills') + para('A refill is authorized by a licensed clinician.') +
    para('A patient asks why?', true) + `<w:tbl>${tableRow(['Version', '2.2'])}</w:tbl>`);
  const lines = D.docxToLines(buf);
  assert.deepStrictEqual(lines, ['12.4 Refills', 'A refill is authorized by a licensed clinician.', '*A patient asks why?*', '| Version | 2.2 |']);
  assert.strictEqual(P.documentVersion(lines), '2.2');
});

test('a file that is not a .docx is refused by name', () => {
  assert.throws(() => D.docxToLines(Buffer.from('not a zip at all, just text padding padding')), (e) => e.code === 'DOC_NOT_ZIP');
});

test('HTML tables read as rows and the Playbook banner gives its version', () => {
  const lines = D.htmlToLines('<p>v3.0 · November 2026</p><table><tr><td>Malpractice coverage</td><td>x</td><td>Internal policy</td></tr></table>');
  assert.ok(lines.includes('| Malpractice coverage | x | Internal policy |'));
  assert.strictEqual(P.documentVersion(lines, { banner: true }), '3.0');
  assert.strictEqual(P.documentVersion(lines), null, 'the banner is only read for the Playbook');
});

test('SOP check questions are read as prompt, answer and citation', () => {
  const lines = ['SOP-RX-01 · Prescribing, Refills, and Controlled Substances', 'Purpose. Prescribe.', 'Check questions',
    '*A patient on long-term oxycodone requires a refill. What do you do?*',
    'Answer: Oxycodone is Schedule II. Route the matter to the Supervising Physician and document the referral. *(Manual 12.3, 2.5)*',
    '*What is required before prescribing any controlled substance?*', 'Answer: Check the Georgia PDMP and document the check. *(Manual 12.3)*',
    'SOP-EXM-01 · Independent Medical Examination Workflow', 'Check questions', '*An italic note that is not a question*', 'Some ordinary text.', '*Q?*', 'Answer: A.'];
  const c = P.sopChecks(lines);
  assert.strictEqual(c['SOP-RX-01'].length, 2);
  assert.strictEqual(c['SOP-RX-01'][0].source, 'Manual 12.3, 2.5');
  assert.match(c['SOP-RX-01'][0].answer, /^Oxycodone is Schedule II\. Route .* referral\.$/);
  assert.deepStrictEqual(c['SOP-EXM-01'], [{ prompt: 'Q?', answer: 'A.', source: null }]);
});

test('Library checks belong to their module, with nested citations kept whole', () => {
  const lines = ['TRN-206 · Orders and results', 'Added check', '*What does an imaging order carry?*',
    'Answer: The indication and the physician\'s details. *(Rule 360-32-.02(5)(g); Manual 11.4)*',
    'TRN-207 · Prescribing and refills', 'Checks', '*Why three months?*', 'Answer: Policy. *(Manual 12.4)*', '4 WHAT EACH PARTY SEES'];
  const c = P.libraryChecks(lines);
  assert.strictEqual(c['TRN-206'][0].source, 'Rule 360-32-.02(5)(g); Manual 11.4');
  assert.strictEqual(c['TRN-207'].length, 1);
  const mod = { id: 'TRN-207', sopRefs: ['SOP-RX-01'] };
  const all = P.checksForModule(mod, { library: c, sops: { 'SOP-RX-01': [{ prompt: 'p', answer: 'a', source: null }] } });
  assert.deepStrictEqual(all.map(x => x.from), ['LIBRARY', 'SOP']);
});

test('the Playbook drift check reads the section\'s own table, never the role index', () => {
  const items = [{ id: 'C.6.06', classifications: [{ phrase: 'Internal policy', row: 'Malpractice coverage', from: { source: 'PLAYBOOK', section: 'C.2' } }] }];
  // A "C.20" table BEFORE the real C.2: a loose marker would read it instead.
  const lines = ['Clinician, Employed', 'C.20Something', '| Malpractice coverage | x | y | Statutory |', 'C.21Other',
    'C.2Applicable Requirements', '| Malpractice coverage | GFC carries it | GFC policy | Internal policy |', 'C.3Roles'];
  assert.deepStrictEqual(P.verifyChapterClassifications(lines, items, { section: 'C.2', next: 'C.3' }), []);
  const drifted = lines.slice(); drifted[5] = '| Malpractice coverage | GFC carries it | GFC policy | Regulatory |';
  assert.deepStrictEqual(P.verifyChapterClassifications(drifted, items, { section: 'C.2', next: 'C.3' })[0].found, 'Regulatory');
  assert.throws(() => P.verifyChapterClassifications(['nothing'], items, { section: 'C.2', next: 'C.3' }), (e) => e.code === 'SECTION_NOT_FOUND');
});

function fakeWorld(files) {
  const store = {};
  let downloads = 0;
  const drive = {
    async getFileFingerprint(id) { const f = files[id]; if (!f) throw new Error('File not found'); return { id, md5Checksum: f.md5, mimeType: f.mime }; },
    async downloadFileBuffer(id) { downloads++; return files[id].buf; },
    describeDriveError: (e) => ({ reason: e.message })
  };
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  return { drive, db, store, downloads: () => downloads };
}

const manualDocx = (version, refills) => docx(
  para('12 MEDICATION') + para('12.3 Controlled Substances') + para('Schedule III through V.') +
  para('12.4 Refills') + para(refills) + `<w:tbl>${tableRow(['Version', version])}</w:tbl>`);

test('the loader caches by Drive checksum, so a revision in place is never served stale', async () => {
  const id = SOURCES.CLINICAL_MANUAL.driveFileId;
  const w = fakeWorld({ [id]: { md5: 'a', mime: SOURCES.CLINICAL_MANUAL.mimeType, buf: manualDocx('2.2', 'Three months.') } });
  const L = createSourceLoader({ drive: w.drive, db: w.db });
  const first = await L.load('CLINICAL_MANUAL');
  assert.strictEqual(first.version, '2.2');
  assert.strictEqual((await L.load('CLINICAL_MANUAL')).cached, true);
  assert.strictEqual(w.downloads(), 1);
});

test('a document Drive will not give us is reported with the reason, never as empty', async () => {
  const w = fakeWorld({});
  const r = await createSourceLoader({ drive: w.drive, db: w.db }).load('CLINICAL_MANUAL');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'SOURCE_UNREACHABLE');
  assert.match(r.reason, /File not found/);
});

test('a reissued manual is fingerprinted and its changed sections are computed, not typed', async () => {
  const id = SOURCES.CLINICAL_MANUAL.driveFileId;
  const files = { [id]: { md5: 'a', mime: SOURCES.CLINICAL_MANUAL.mimeType, buf: manualDocx('2.2', 'Three months.') } };
  const w = fakeWorld(files);
  const L = createSourceLoader({ drive: w.drive, db: w.db });
  const s1 = await L.manualState();
  assert.strictEqual(s1.currentVersion, '2.2');
  assert.strictEqual(s1.changeLog.length, 1, 'only the seeded 2.1 to 2.2 entry');
  files[id] = { md5: 'b', mime: files[id].mime, buf: manualDocx('2.3', 'Twelve months.') };
  const s2 = await L.manualState();
  assert.strictEqual(s2.currentVersion, '2.3');
  assert.strictEqual(s2.versionDiffers, true);
  const hop = s2.changeLog.find(c => c.from === '2.2');
  assert.deepStrictEqual(hop.changedSections, ['12.4']);
  assert.strictEqual(hop.basis, 'COMPUTED_FROM_FINGERPRINTS');
  const stored = w.store[VERSIONS_COLLECTION];
  assert.strictEqual(stored.length, 2);
  assert.ok(!JSON.stringify(stored).includes('Twelve months'), 'fingerprints, never text');
});
