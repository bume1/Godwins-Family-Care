// The IME record analyzer (spec GFC_IME_Record_Analyzer_Spec_v1.md).
// The rules are run directly; the storage and the analysis job are run end to
// end against fakes (store, Drive, model engine), asserting what was stored.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const rules = require('../imeCases');
const { createImeService } = require('../imeService');
const modelEngine = require('../modelEngine');
const clinicalRoles = require('../clinicalRoles');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── fakes ──────────────────────────────────────────────────────────────────
const memoryDb = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null), set: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, _m: m };
};
const fakeDrive = () => {
  const files = new Map();
  let n = 0;
  return {
    files,
    failUpload: false, failDelete: false,
    async uploadImeCaseFile(caseId, name, buf) { if (this.failUpload) throw new Error('drive down'); const id = `f${++n}`; files.set(id, { caseId, name, buf }); return { fileId: id, fileName: name }; },
    async downloadFileBuffer(id) { if (!files.has(id)) throw new Error('missing'); return files.get(id).buf; },
    async deleteFile(id) { if (this.failDelete) throw new Error('nope'); files.delete(id); return true; }
  };
};
const pdfBytes = async (pages) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200, 200]);
  return Buffer.from(await d.save());
};
const detectFileType = (buf) => (buf[0] === 0x25 && buf[1] === 0x50 ? 'application/pdf' : (buf[0] === 0x89 ? 'image/png' : null));

const ADMIN = { id: 'u_admin', role: 'admin', name: 'Admin' };
const FNP = { id: 'u_fnp', role: 'user', clinicalRole: 'provider', name: 'Fran NP' };
const FNP2 = { id: 'u_fnp2', role: 'user', clinicalRole: 'provider', name: 'Other NP' };
const RN = { id: 'u_rn', role: 'user', clinicalRole: 'rn', name: 'Rae RN' };
const CM = { id: 'u_cm', role: 'caseManager', name: 'Casey CM' };
const MANAGER = { id: 'u_mgr', role: 'vendor', isManager: true, name: 'Mo Manager' };

const build = ({ engine, env, texts } = {}) => {
  const db = memoryDb();
  const drive = fakeDrive();
  const logs = [];
  let clock = Date.parse('2026-11-04T15:00:00Z');
  const svc = createImeService({
    db, drive,
    engine: engine || { status: () => ({ configured: false, blockers: ['not set up'] }) },
    modelEngine,
    logActivity: async (...a) => { logs.push(a); },
    getUsers: async () => [ADMIN, FNP, FNP2, RN, CM, MANAGER],
    resolveClinicalRole: clinicalRoles.resolveClinicalRole,
    detectFileType,
    maxFileBytes: 10 * 1024 * 1024,
    env: env || {},
    now: () => new Date(clock).toISOString(),
    pdf: {
      load: (b) => PDFDocument.load(b),
      slice: async (bytes, from, to) => {
        const src = await PDFDocument.load(bytes); const out = await PDFDocument.create();
        (await out.copyPages(src, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i))).forEach(p => out.addPage(p));
        return Buffer.from(await out.save());
      },
      pageTexts: async (bytes) => {
        const n = (await PDFDocument.load(bytes)).getPageCount();
        return Array.from({ length: n }, (_, i) => (texts ? (texts[i] || '') : ''));
      }
    }
  });
  return { svc, db, drive, logs, advance: (days) => { clock += days * 86400000; } };
};

const newCase = async (svc, user = ADMIN, extra = {}) => {
  const r = await svc.createCase(user, { referenceId: 'LSGS-77812', contractingEntity: 'lsgs', claimedConditions: ['Tinnitus', 'Lumbar strain'], examinerId: FNP.id, ...extra });
  assert.strictEqual(r.status, 201, JSON.stringify(r));
  return svc.getCase(r.case.id);
};

// ── access ─────────────────────────────────────────────────────────────────
test('only the assigned examiner and admin can see a case', () => {
  const c = { id: 'c1', examinerId: FNP.id };
  const R = clinicalRoles.resolveClinicalRole;
  assert.ok(rules.canSeeCase(ADMIN, c, R));
  assert.ok(rules.canSeeCase(FNP, c, R));
  for (const u of [FNP2, RN, CM, MANAGER]) assert.ok(!rules.canSeeCase(u, c, R), u.name);
  assert.ok(!rules.mayUseAnalyzer(CM, R) && !rules.mayUseAnalyzer(RN, R) && !rules.mayUseAnalyzer(MANAGER, R));
  assert.ok(!rules.canSeeCase({ ...FNP, accountStatus: 'inactive' }, c, R), 'a deactivated examiner loses the case');
});

test('an examiner opens cases only for themselves; admin assigns only an eligible examiner', async () => {
  const { svc } = build();
  const own = await svc.createCase(FNP, { referenceId: 'Q-1', contractingEntity: 'ves', claimedConditions: ['PTSD'], examinerId: FNP2.id });
  assert.strictEqual(own.case.examinerId, FNP.id);
  const bad = await svc.createCase(ADMIN, { referenceId: 'Q-2', contractingEntity: 'ves', claimedConditions: ['PTSD'], examinerId: RN.id });
  assert.strictEqual(bad.code, 'IME_EXAMINER_NOT_ELIGIBLE');
  const c = await svc.getCase(own.case.id);
  const r = await svc.updateCase(FNP, c, { examinerId: FNP2.id });
  assert.strictEqual(r.code, 'IME_ADMIN_ONLY');
});

// ── input ─────────────────────────────────────────────────────────────────
test('a reference id that looks like an SSN or a VA file number is refused by name', () => {
  assert.match(rules.normalizeCaseInput({ referenceId: '123-45-6789', contractingEntity: 'lsgs', claimedConditions: ['x'] }).error, /Social Security/);
  assert.match(rules.normalizeCaseInput({ referenceId: 'C12345678', contractingEntity: 'lsgs', claimedConditions: ['x'] }).error, /VA file number/);
  assert.ok(rules.normalizeCaseInput({ referenceId: 'LSGS-2026-0091', contractingEntity: 'lsgs', claimedConditions: ['x'] }).value);
});

test('private IME is not accepted yet, and every contracting entity is named', () => {
  assert.match(rules.normalizeCaseInput({ caseType: 'private_ime', referenceId: 'A', contractingEntity: 'lsgs', claimedConditions: ['x'] }).error, /not available yet/);
  assert.deepStrictEqual(Object.keys(rules.CONTRACTING_ENTITIES).sort(), ['leidos_qtc', 'lsgs', 'ves']);
  assert.match(rules.normalizeCaseInput({ referenceId: 'A', contractingEntity: 'acme', claimedConditions: ['x'] }).error, /contracting entity/);
});

test('claimed conditions are required, trimmed and de-duplicated', () => {
  assert.deepStrictEqual(rules.cleanConditions(['  Tinnitus ', 'tinnitus', '', 'PTSD']), ['Tinnitus', 'PTSD']);
  assert.ok(rules.normalizeCaseInput({ referenceId: 'A', contractingEntity: 'lsgs', claimedConditions: ['  '] }).fieldErrors.claimedConditions);
});

// ── upload ─────────────────────────────────────────────────────────────────
test('upload types files by their bytes, refuses duplicates, and writes no row when storage fails', async () => {
  const { svc, drive, db } = build();
  const c = await newCase(svc);
  const pdf = await pdfBytes(3);
  const r = await svc.addDocuments(FNP, c, [
    { originalname: 'STRs.pdf', buffer: pdf },
    { originalname: 'renamed.pdf', buffer: Buffer.from('not a pdf at all') },
    { originalname: 'again.pdf', buffer: pdf }
  ]);
  assert.deepStrictEqual(r.results.map(x => x.ok), [true, false, false]);
  assert.strictEqual(r.results[1].code, 'IME_FILE_TYPE');
  assert.strictEqual(r.results[2].code, 'IME_FILE_DUPLICATE');
  const rows = await db.get('ime_case_documents');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].pageCount, 3);
  assert.match(rows[0].sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(rows[0].uploadedBy.id, FNP.id);
  // The stored name never carries the original filename.
  assert.ok(![...drive.files.values()].some(f => /STRs/.test(f.name)));

  drive.failUpload = true;
  const r2 = await svc.addDocuments(FNP, c, [{ originalname: 'more.pdf', buffer: await pdfBytes(1) }]);
  assert.strictEqual(r2.results[0].code, 'IME_STORAGE_UNAVAILABLE');
  assert.strictEqual((await db.get('ime_case_documents')).length, 1);
});

test('every document read is audited', async () => {
  const { svc, logs } = build();
  const c = await newCase(svc);
  const up = await svc.addDocuments(FNP, c, [{ originalname: 'a.pdf', buffer: await pdfBytes(1) }]);
  const r = await svc.readDocument(FNP, c, up.results[0].documentId);
  assert.strictEqual(r.status, 200);
  assert.ok(logs.some(l => l[2] === 'ime_document_read' && l[5].documentId === up.results[0].documentId));
});

// ── planning ───────────────────────────────────────────────────────────────
test('passes are packed by page count and a large file is split into cited page ranges', () => {
  const plan = rules.planPasses([{ id: 'a', pageCount: 250 }, { id: 'b', pageCount: 120 }, { id: 'c', pageCount: 700 }], 300);
  assert.deepStrictEqual(plan.map(p => p.pages), [300, 300, 300, 170]);
  assert.deepStrictEqual(plan[0].parts.map(x => x.sourceId), ['doc:a', 'doc:b#p1-50']);
  assert.deepStrictEqual(plan[1].parts.map(x => x.sourceId), ['doc:b#p51-120', 'doc:c#p1-230']);
  // Every page of every file lands in exactly one part.
  const covered = {};
  for (const p of plan) for (const x of p.parts) covered[x.documentId] = (covered[x.documentId] || 0) + x.pages;
  assert.deepStrictEqual(covered, { a: 250, b: 120, c: 700 });
});

// ── citations ──────────────────────────────────────────────────────────────
test('a citation resolves to the page in the ORIGINAL file, including a transport split', () => {
  const parts = new Map([
    ['doc:a', { documentId: 'a', from: 1, to: 50, sourceId: 'doc:a' }],
    ['doc:c#p301-600', { documentId: 'c', from: 301, to: 600, sourceId: 'doc:c#p301-600' }]
  ]);
  assert.deepStrictEqual(rules.resolveCitation({ sourceId: 'doc:a', page: 7 }, parts), { documentId: 'a', page: 7 });
  assert.deepStrictEqual(rules.resolveCitation({ sourceId: 'doc:c#p301-600', page: 5 }, parts), { documentId: 'c', page: 305 });
  assert.deepStrictEqual(rules.resolveCitation({ sourceId: 'doc:c#p301-600#p41-80', page: 2 }, parts), { documentId: 'c', page: 342 });
  assert.deepStrictEqual(rules.resolveCitation({ sourceId: 'doc:a#p41-50', page: 1 }, parts), { documentId: 'a', page: 41 });
  // Outside the part, or a part this pass never sent, does not resolve.
  assert.strictEqual(rules.resolveCitation({ sourceId: 'doc:a', page: 51 }, parts), null);
  assert.strictEqual(rules.resolveCitation({ sourceId: 'doc:c#p301-600', page: 301 }, parts), null);
  assert.strictEqual(rules.resolveCitation({ sourceId: 'doc:zzz', page: 1 }, parts), null);
  assert.strictEqual(rules.resolveCitation({ sourceId: 'doc:a', page: 0 }, parts), null);
  // A page past the end of a transport-split piece is not quietly moved into the next piece.
  assert.strictEqual(rules.resolveCitation({ sourceId: 'doc:c#p301-600#p41-80', page: 50 }, parts), null);
});

test('uncited items, model opinion language and 7332 items are dropped and counted; quotes are checked', () => {
  const parts = [{ documentId: 'a', from: 1, to: 3, sourceId: 'doc:a' }];
  const texts = { a: ['Audiology 2011: patient reports constant ringing in both ears.', '', 'Lumbar strain after a fall from a truck.'] };
  const pageText = (d, p) => (texts[d] || [])[p - 1];
  const cite = (page) => ({ sourceId: 'doc:a', page });
  const r = rules.cleanPass({
    chronology: [
      { eventType: 'visit', summary: 'Audiology visit', date: '2011-04-02', citation: cite(1), quote: 'constant ringing in both ears' },
      { eventType: 'visit', summary: 'Made-up visit', citation: { sourceId: 'doc:a', page: 9 } },
      { eventType: 'other', summary: 'Tinnitus is at least as likely as not due to service', citation: cite(1), quote: 'constant ringing' },
      { eventType: 'lab', summary: 'HIV test negative', citation: cite(2), quote: 'HIV' }
    ],
    byCondition: [{ claimedCondition: 'Lumbar strain', treatment: [
      { text: 'Fall from a truck', citation: cite(3), quote: 'fall from a truck' },
      { text: 'Physical therapy', citation: cite(2), quote: 'PT x6' },
      { text: 'Seen for back pain', citation: cite(3), quote: 'invented words' }
    ] }]
  }, { parts, pageText, cleared7332: false });
  assert.deepStrictEqual(r.dropped, { uncited: 1, opinion: 1, restricted7332: 1 });
  assert.strictEqual(r.pass.chronology.length, 1);
  assert.strictEqual(r.pass.chronology[0].quoteVerified, true);
  const t = r.pass.byCondition[0].treatment;
  assert.deepStrictEqual(t.map(x => x.quoteCheck), ['matched', 'no_text_layer', 'not_on_page']);
  assert.ok(t.every(x => x.quoteVerified === (x.quoteCheck === 'matched')));
});

test('an opinion QUOTED from the record is a record, not the model\'s opinion', () => {
  assert.strictEqual(rules.opinionNotInQuote('Prior examiner: at least as likely as not', 'opinion: at least as likely as not related'), false);
  assert.strictEqual(rules.opinionNotInQuote('At least as likely as not related', 'ringing in ears'), true);
});

test('with 7332 cleared by the owner, those records are read', () => {
  const parts = [{ documentId: 'a', from: 1, to: 1, sourceId: 'doc:a' }];
  const r = rules.cleanPass({ chronology: [{ eventType: 'lab', summary: 'HIV test negative', citation: { sourceId: 'doc:a', page: 1 } }] }, { parts, pageText: () => null, cleared7332: true });
  assert.strictEqual(r.pass.chronology.length, 1);
  assert.strictEqual(rules.usc7332Cleared({}), false, 'fails closed');
  assert.strictEqual(rules.usc7332Cleared({ GFC_IME_7332_CLEARED: 'true' }), true);
});

test('merging is deterministic: nothing cited is lost, notFound is derived across all passes', () => {
  const cite = (d, p) => ({ documentId: d, page: p });
  const passA = { chronology: [{ date: '2015', summary: 'B', citation: cite('a', 2) }], medications: [], unreadable: [], notFound: [{ claimedCondition: 'tinnitus', searchedFor: 'ringing' }, { claimedCondition: 'PTSD', searchedFor: 'nightmares' }],
    byCondition: [{ claimedCondition: 'lumbar strain', firstDocumented: { date: '2012-05-01', citation: cite('a', 1) }, diagnosesRecorded: [], inServiceEvents: [], treatment: [], currentSeverity: [], functionalImpact: [] }] };
  const passB = { chronology: [{ date: '2010-01-03', summary: 'A', citation: cite('b', 1) }, { date: '2015', summary: 'B', citation: cite('a', 2) }], medications: [], unreadable: [], notFound: [],
    byCondition: [{ claimedCondition: 'Tinnitus', firstDocumented: null, diagnosesRecorded: [{ text: 'Tinnitus', date: '2011', citation: cite('b', 4) }], inServiceEvents: [], treatment: [], currentSeverity: [], functionalImpact: [] },
      { claimedCondition: 'Lumbar strain', firstDocumented: { date: '2009-11', citation: cite('b', 9) }, diagnosesRecorded: [], inServiceEvents: [], treatment: [], currentSeverity: [], functionalImpact: [] }] };
  const m = rules.mergePasses([passA, passB], ['Tinnitus', 'Lumbar strain', 'PTSD']);
  assert.deepStrictEqual(m.chronology.map(e => e.summary), ['A', 'B'], 'sorted by date, duplicate removed');
  assert.deepStrictEqual(m.byCondition.map(r => r.claimedCondition), ['Tinnitus', 'Lumbar strain', 'PTSD']);
  assert.strictEqual(m.byCondition[1].firstDocumented.date, '2009-11', 'the earliest across passes');
  // Pass A said tinnitus was not found; pass B found it. Only PTSD is absent.
  assert.deepStrictEqual(m.notFound.map(n => n.claimedCondition), ['PTSD']);
  assert.match(m.notFound[0].note, /absence/);
  assert.strictEqual(m.notFound[0].searchedFor, 'nightmares');
});

// ── the whole job, against a fake engine ──────────────────────────────────
const fakeEngine = (answer) => {
  const calls = [];
  return {
    calls,
    status: () => ({ configured: true, blockers: [] }),
    invoke: async (req) => {
      calls.push(req);
      // Validate exactly as the real engine does, so the schema is exercised.
      const raw = answer(req, calls.length);
      if (raw instanceof Error) throw raw;
      const checked = modelEngine.validateAgainstSchema(raw, req.schema);
      if (checked.error) { const e = new Error(checked.error); e.code = 'MODEL_OUTPUT_INVALID'; throw e; }
      return { invocationId: `mi_${calls.length}`, modelId: 'gemini-3.5-flash', proposal: checked.value, usage: { inputTokens: 1000, outputTokens: 200 } };
    }
  };
};

test('an analysis runs every pass, cites original pages, and writes a content-free audit', async () => {
  const engine = fakeEngine((req) => {
    const part = req.input.documents[req.input.documents.length - 1];
    return {
      chronology: [{ eventType: 'visit', summary: 'Audiology visit', date: '2011-04-02', citation: { sourceId: part.sourceId, page: 1 }, quote: 'constant ringing in both ears' }],
      byCondition: [{ claimedCondition: 'Tinnitus', diagnosesRecorded: [{ text: 'Tinnitus diagnosed', citation: { sourceId: part.sourceId, page: 1 }, quote: 'constant ringing' }] }],
      notFound: [{ claimedCondition: 'Lumbar strain', searchedFor: 'back pain, lumbar' }]
    };
  });
  const { svc, db } = build({ engine, env: { GFC_IME_PAGES_PER_PASS: '10' }, texts: ['Audiology: constant ringing in both ears.'] });
  const c = await newCase(svc);
  await svc.addDocuments(FNP, c, [{ originalname: 'big.pdf', buffer: await pdfBytes(15) }]);
  const start = await svc.startAnalysis(FNP, c, { background: false });
  assert.strictEqual(start.status, 202);
  assert.strictEqual(engine.calls.length, 2, '15 pages at 10 per pass is two passes');
  assert.strictEqual(engine.calls[0].purpose, modelEngine.PURPOSES.IME_RECORD_REVIEW);
  assert.match(engine.calls[0].input.instruction, /"Tinnitus", "Lumbar strain"/);
  assert.match(engine.calls[0].input.instruction, /7332/, 'excluded until cleared');
  const a = (await db.get('ime_analyses'))[0];
  assert.strictEqual(a.status, 'done');
  // Pass two's part is pages 11-15, so its page 1 is page 11 of the file.
  assert.deepStrictEqual(a.output.chronology.map(e => e.citation.page).sort((x, y) => x - y), [1, 11]);
  assert.deepStrictEqual(a.output.notFound.map(n => n.claimedCondition), ['Lumbar strain']);
  assert.strictEqual(a.usage.inputTokens, 2000);

  const audit = (await db.get('ime_analysis_audit'))[0];
  assert.deepStrictEqual(audit.invocationIds, ['mi_1', 'mi_2']);
  assert.strictEqual(audit.documents[0].pageCount, 15);
  // NO CONTENT: not a quote, not a summary, not a condition name, not a filename.
  const blob = JSON.stringify(audit);
  for (const s of ['ringing', 'Audiology', 'Tinnitus', 'Lumbar', 'big.pdf']) assert.ok(!blob.includes(s), `audit carries "${s}"`);
});

test('a failed pass lists its pages as not read and the other passes still count', async () => {
  const engine = fakeEngine((req, n) => (n === 1 ? new Error('quota') : { notFound: [] }));
  const { svc, db } = build({ engine, env: { GFC_IME_PAGES_PER_PASS: '10' } });
  const c = await newCase(svc);
  await svc.addDocuments(FNP, c, [{ originalname: 'x.pdf', buffer: await pdfBytes(15) }]);
  await svc.startAnalysis(FNP, c, { background: false });
  const a = (await db.get('ime_analyses'))[0];
  assert.strictEqual(a.status, 'done');
  assert.ok(a.output.unreadable.some(u => u.pages === '1-10' && /pass 1 failed/.test(u.why)));
});

test('an analysis is refused before anything is read when the boundary is not satisfied', async () => {
  const { svc, db } = build();
  const c = await newCase(svc);
  await svc.addDocuments(FNP, c, [{ originalname: 'x.pdf', buffer: await pdfBytes(1) }]);
  const r = await svc.startAnalysis(FNP, c);
  assert.strictEqual(r.code, 'MODEL_BOUNDARY_REFUSED');
  assert.strictEqual(r.blockers, undefined, 'only admin is shown the settings');
  assert.strictEqual(await db.get('ime_analyses'), null);
});

// ── retention ──────────────────────────────────────────────────────────────
test('N days after the report, the files and results are deleted and only metadata stays', async () => {
  const engine = fakeEngine((req) => ({ chronology: [{ eventType: 'visit', summary: 'x', citation: { sourceId: req.input.documents[0].sourceId, page: 1 } }] }));
  const { svc, db, drive, advance } = build({ engine, env: { GFC_IME_RETENTION_DAYS: '30' } });
  const c = await newCase(svc);
  await svc.addDocuments(FNP, c, [{ originalname: 'Smith STRs.pdf', buffer: await pdfBytes(2) }]);
  await svc.startAnalysis(FNP, c, { background: false });
  // No new uploads or runs once the report is in.
  await svc.submitReport(FNP, await svc.getCase(c.id));
  const sub = await svc.getCase(c.id);
  assert.strictEqual((await svc.addDocuments(FNP, sub, [{ originalname: 'y.pdf', buffer: await pdfBytes(1) }])).code, 'IME_CASE_NOT_OPEN');

  advance(29);
  assert.strictEqual(await svc.purgeDue(), 0, 'not before day 30');
  advance(1);
  drive.failDelete = true;
  assert.strictEqual(await svc.purgeDue(), 0, 'a file that could not be deleted keeps the case un-purged');
  assert.strictEqual((await svc.getCase(c.id)).status, 'report_submitted');
  drive.failDelete = false;
  assert.strictEqual(await svc.purgeDue(), 1);

  assert.strictEqual(drive.files.size, 0);
  const after = await svc.getCase(c.id);
  assert.strictEqual(after.status, 'purged');
  assert.deepStrictEqual(after.claimedConditions, []);
  assert.strictEqual(after.conditionCount, 2);
  const doc = (await db.get('ime_case_documents'))[0];
  assert.strictEqual(doc.fileName, null);
  assert.ok(doc.sha256 && doc.pageCount === 2, 'the hash and page count stay');
  assert.strictEqual((await db.get('ime_analyses'))[0].output, null);
  const del = (await db.get('ime_deletion_log'))[0];
  assert.strictEqual(del.filesDeleted, 1);
  assert.strictEqual(del.retentionDays, 30);
});

test('retention defaults to 30 days until the owner sets it', () => {
  assert.strictEqual(rules.retentionDays({}), 30);
  assert.strictEqual(rules.retentionDays({ GFC_IME_RETENTION_DAYS: '60' }), 60);
  assert.strictEqual(rules.retentionDays({ GFC_IME_RETENTION_DAYS: 'soon' }), 30);
});

test('a mis-clicked report can be reopened by admin, with a reason', async () => {
  const { svc } = build();
  const c = await newCase(svc);
  await svc.submitReport(FNP, c);
  const s = await svc.getCase(c.id);
  assert.strictEqual((await svc.reopenCase(FNP, s, { reason: 'x' })).code, 'IME_ADMIN_ONLY');
  assert.strictEqual((await svc.reopenCase(ADMIN, s, {})).code, 'IME_REASON_REQUIRED');
  const r = await svc.reopenCase(ADMIN, s, { reason: 'clicked too early' });
  assert.strictEqual(r.case.status, 'open');
  assert.strictEqual(r.case.purgeDueAt, null);
});

// ── build guards ───────────────────────────────────────────────────────────
test('the purpose is declared in the one engine, with its own instruction', () => {
  assert.strictEqual(modelEngine.PURPOSES.IME_RECORD_REVIEW, 'ime_record_review');
  const vt = read('vertexTransport.js');
  assert.match(vt, /ime_record_review: \[/);
  assert.match(vt, /no nexus or causation statement/);
  // imeService never builds its own model client.
  const svcSrc = read('imeService.js');
  assert.ok(!/@google\/genai|vertexTransport|GoogleGenAI/.test(svcSrc));
});

test('the case is not a patient: no client record, OpenEMR or clinical page', () => {
  for (const f of ['imeCases.js', 'imeService.js']) {
    const src = read(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/openemr|forActor|clientId|familyOfClientId/i.test(src), f);
  }
  assert.ok(!/\/api\/ime/.test(read('public/clinical.html')), 'the clinical workspace does not read IME cases');
});

test('every IME route is under the PHI audit prefix and gated', () => {
  const audit = require('../auditLog');
  assert.ok(audit.PHI_PREFIXES.includes('/api/ime'));
  const src = read('server.js');
  const routes = [...src.matchAll(/app\.(get|post|put|delete)\('(\/api\/ime[^']*)'([^\n]*)/g)];
  assert.ok(routes.length >= 12, `found ${routes.length}`);
  for (const r of routes) assert.match(r[3], /authenticateToken, requireImeUser/, r[2]);
  for (const r of routes.filter(x => x[2].includes('/admin/') || x[2].endsWith('/reopen'))) assert.match(r[3], /requireImeAdmin/, r[2]);
});

test('the collections are registered as PHI', () => {
  const { COLLECTION_REGISTRY } = require('../dataMigration');
  for (const k of ['ime_cases', 'ime_case_documents', 'ime_analyses', 'ime_analysis_audit', 'ime_deletion_log']) {
    const e = COLLECTION_REGISTRY.find(x => x.key === k);
    assert.ok(e && e.phi === true, k);
  }
});

test('the screen builds text with textContent and carries the AI-draft banner from the server', () => {
  const page = read('public/ime.html');
  assert.ok(!/innerHTML/.test(page), 'nothing read from a claim file is parsed as HTML');
  assert.match(read('server.js'), /banner: 'AI draft\. Unverified\. Not part of the exam report\./);
  assert.match(page, /className: 'banner'/);
});
