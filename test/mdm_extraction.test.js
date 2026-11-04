'use strict';
// Clinical fact extraction (AI coding pipeline, Phase 2, 2026-11-04).
// The model extracts facts from one note and names no code. Every item carries
// a quote that is really in the note, or it is dropped and counted. Nothing is
// written to the chart. The background job is lifted out of server.js and RUN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('../mdmExtraction');
const M = require('../modelEngine');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---- the schema (spec §2.3) ----
test('the output schema is exactly the spec\'s, key for key, enum for enum', () => {
  const f = X.MDM_SCHEMA.fields;
  assert.deepEqual(Object.keys(f), ['problemsAddressed', 'dataReviewed', 'risk', 'time', 'unreadable']);
  assert.deepEqual(Object.keys(f.problemsAddressed.items), ['description', 'status', 'management', 'quote']);
  assert.deepEqual(f.problemsAddressed.items.status.enum, ['stable', 'worsening', 'new', 'resolved', 'unclear']);
  assert.deepEqual(f.problemsAddressed.items.management.enum, ['observation', 'medication', 'referral', 'testing', 'procedure', 'other']);
  assert.deepEqual(Object.keys(f.dataReviewed.items), ['kind', 'detail', 'quote']);
  assert.deepEqual(f.dataReviewed.items.kind.enum, ['lab', 'imaging', 'outside_record', 'prior_note', 'independent_historian', 'discussion_with_clinician', 'test_interpretation']);
  assert.deepEqual(Object.keys(f.risk.items), ['factor', 'detail', 'quote']);
  assert.deepEqual(f.risk.items.factor.enum, ['prescription_management', 'decision_re_hospitalization', 'decision_re_surgery', 'drug_therapy_monitoring', 'social_determinants', 'otc_management', 'other']);
  assert.deepEqual(Object.keys(f.time.items), ['totalMinutes', 'statementPresent', 'quote']);
  assert.equal(M.validateSchemaShape(X.MDM_SCHEMA, 'schema'), null, 'the engine accepts the schema');
});
test('the schema carries NO code field of any kind', () => {
  const blob = JSON.stringify(X.MDM_SCHEMA);
  for (const forbidden of ['icd', 'cpt', 'hcpcs', 'code', 'level', '99']) {
    assert.ok(!new RegExp(forbidden, 'i').test(blob), `no "${forbidden}" anywhere in the schema`);
  }
});
test('a key the model adds that is not declared is dropped before storage', () => {
  const r = M.validateAgainstSchema({
    problemsAddressed: [{ description: 'HTN', status: 'stable', management: 'medication', quote: 'x', icd10: 'I10', emLevel: '99214' }],
    suggestedCode: '99214'
  }, X.MDM_SCHEMA);
  assert.ok(!r.error);
  assert.deepEqual(Object.keys(r.value), ['problemsAddressed']);
  assert.deepEqual(Object.keys(r.value.problemsAddressed[0]), ['description', 'status', 'management', 'quote']);
});
test('quote is NOT schema-required, so one quoteless item cannot sink the whole extraction', () => {
  const r = M.validateAgainstSchema({ problemsAddressed: [{ description: 'HTN', status: 'stable', management: 'medication' }] }, X.MDM_SCHEMA);
  assert.ok(!r.error, r.error);
});

// ---- the input (spec §2.2) ----
const RECORD = {
  date: '2026-11-03', reason: 'BP follow-up',
  visit: { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' },
  diagnoses: [{ code: 'I10', description: 'Essential (primary) hypertension' }],
  services: [{ code: '99349', modifiers: ['25'] }],
  note: {
    kind: 'followup', visit: { appointmentType: 'pc_follow_up' },
    chiefConcern: 'BP check', subjective: '**Dizzy** when standing for two days.',
    assessment: 'Orthostatic hypotension, worsening.', plan: '1. Stop lisinopril\n2. Recheck BP in 48h',
    sections: { timeSpent: 'Total time 40 minutes on this date.' }
  }
};
test('the packet holds the note, the structured fields, the problem and medication lists', () => {
  const p = X.buildMdmInput({ encounterUuid: 'e1', record: RECORD, narrativeText: '', problems: [{ title: 'Hypertension', status: 'active' }], medications: [{ title: 'Lisinopril 10 mg', status: 'active' }] });
  assert.deepEqual(p.sections.map(s => s.sourceId), ['enc:e1:note', 'enc:e1:fields', 'emr:problems', 'emr:medications']);
  const note = p.sections[0].text;
  assert.match(note, /Dizzy when standing/, 'formatting is reduced to plain text');
  assert.doesNotMatch(note, /\*\*/);
  assert.match(note, /Stop lisinopril/);
  assert.match(p.sections[1].text, /Diagnosis recorded: Essential \(primary\) hypertension/);
});
test('THE MODEL IS SHOWN NO CODE: not the service codes, not the ICD-10 codes, not a modifier', () => {
  const p = X.buildMdmInput({ encounterUuid: 'e1', record: RECORD, problems: [], medications: [] });
  const all = p.sections.map(s => s.text).join('\n');
  for (const c of ['99349', 'I10', 'modifier', '25']) assert.ok(!all.includes(c), `"${c}" must not reach the prompt`);
});
test('a section that could not be read is listed, never filled another way', () => {
  const p = X.buildMdmInput({ encounterUuid: 'e1', record: RECORD, problems: null, medications: null, notRead: [{ sourceId: 'emr:problems', why: 'x' }] });
  assert.ok(!p.sections.some(s => s.sourceId === 'emr:problems'));
  assert.equal(p.notRead.length, 1);
});

// ---- quotes (spec §2.4) ----
const TEXT = [X.buildMdmInput({ encounterUuid: 'e1', record: RECORD }).sections[0].text];
test('an item with a quote that is really in the note is kept and marked verified', () => {
  const { output, dropped } = X.enforceQuotes({ problemsAddressed: [{ description: 'Orthostatic hypotension', status: 'worsening', management: 'medication', quote: 'Orthostatic hypotension, worsening.' }] }, { noteTexts: TEXT });
  assert.equal(dropped, 0);
  assert.equal(output.problemsAddressed[0].quoteVerified, true);
});
test('an item with no quote is dropped and counted', () => {
  const { output, counts } = X.enforceQuotes({ risk: [{ factor: 'prescription_management', detail: 'Stopped lisinopril' }] }, { noteTexts: TEXT });
  assert.deepEqual(output.risk, []);
  assert.equal(counts.noQuote, 1);
});
test('A QUOTE THE NOTE DOES NOT CONTAIN IS DROPPED: an invented quote is an inference wearing a citation', () => {
  const { output, counts } = X.enforceQuotes({
    risk: [{ factor: 'decision_re_hospitalization', detail: 'Considered admission', quote: 'Discussed hospital admission with daughter.' }]
  }, { noteTexts: TEXT });
  assert.deepEqual(output.risk, []);
  assert.equal(counts.quoteNotFound, 1);
});
test('quote matching tolerates case, curly quotes and spacing, not different words', () => {
  const ok = X.enforceQuotes({ risk: [{ factor: 'prescription_management', detail: 'Stop', quote: '1.  STOP   Lisinopril' }] }, { noteTexts: TEXT });
  assert.equal(ok.output.risk.length, 1);
  const no = X.enforceQuotes({ risk: [{ factor: 'prescription_management', detail: 'Stop', quote: 'Stop metoprolol' }] }, { noteTexts: TEXT });
  assert.equal(no.output.risk.length, 0);
});
test('a quote from the problem or medication list COUNTS, and is labelled as coming from a list', () => {
  const CONTEXT = ['Diabetes mellitus type 2 — active', 'Metformin 500 mg — active'];
  const { output, counts, dropped } = X.enforceQuotes({
    problemsAddressed: [
      { description: 'Diabetes', status: 'stable', management: 'medication', quote: 'Diabetes mellitus type 2' },
      { description: 'Orthostatic hypotension', status: 'worsening', management: 'medication', quote: 'Orthostatic hypotension, worsening.' }
    ],
    risk: [{ factor: 'prescription_management', detail: 'Metformin', quote: 'Metformin 500 mg' }]
  }, { noteTexts: TEXT, contextTexts: CONTEXT });
  assert.deepEqual(output.problemsAddressed.map(p => [p.description, p.quoteSource]), [['Diabetes', 'list'], ['Orthostatic hypotension', 'note']]);
  assert.deepEqual(output.risk.map(r => r.quoteSource), ['list']);
  assert.equal(dropped, 0);
  assert.deepEqual(counts, { noQuote: 0, quoteNotFound: 0 });
});
test('the encounter fields count as this visit\'s documentation; the lists do not', () => {
  const p = X.buildMdmInput({ encounterUuid: 'e1', record: RECORD, problems: [{ title: 'Hypertension' }], medications: [{ title: 'Lisinopril' }] });
  assert.deepEqual(X.documentationTexts(p.sections).length, 2);
  assert.deepEqual(p.sections.filter(s => s.documentation).map(s => s.sourceId), ['enc:e1:note', 'enc:e1:fields']);
  assert.deepEqual(X.contextTexts(p.sections).length, 2);
});
test('no quote is ever kept unverified: every kept item was found in the note', () => {
  const { output } = X.enforceQuotes({ dataReviewed: [{ kind: 'outside_record', detail: 'Discharge summary', quote: 'Discharged home on 10/30 in stable condition.' }] }, { noteTexts: TEXT });
  assert.equal(output.dataReviewed.length, 0);
});
test('documents are not part of the coding packet (42 CFR Part 2: coding is payment, not treatment)', () => {
  const p = X.buildMdmInput({ encounterUuid: 'e1', record: RECORD, documents: [{ sourceId: 'doc:1' }] });
  assert.ok(!('documents' in p));
});
test('time: a stated total needs its quote; no statement is a fact that needs none', () => {
  const t = X.enforceQuotes({ time: { totalMinutes: 40, statementPresent: true, quote: 'Total time 40 minutes on this date.' } }, { noteTexts: TEXT });
  assert.deepEqual(t.output.time, { totalMinutes: 40, statementPresent: true, quote: 'Total time 40 minutes on this date.', quoteVerified: true, quoteSource: 'note' });
  const invented = X.enforceQuotes({ time: { totalMinutes: 60, statementPresent: true, quote: 'Total time 60 minutes.' } }, { noteTexts: TEXT });
  assert.deepEqual(invented.output.time, { totalMinutes: null, statementPresent: false, quote: null, quoteVerified: false }, 'an invented minute count is not a fact the note states');
  assert.equal(invented.counts.quoteNotFound, 1);
  const unquoted = X.enforceQuotes({ time: { totalMinutes: 40, statementPresent: true } }, { noteTexts: TEXT });
  assert.equal(unquoted.output.time.totalMinutes, null);
  assert.equal(unquoted.counts.noQuote, 1);
  const none = X.enforceQuotes({ time: { statementPresent: false } }, { noteTexts: TEXT });
  assert.equal(none.dropped, 0);
  assert.equal(none.output.time.statementPresent, false);
});

// ---- the engine and the transport ----
test('the purpose is declared, and its instruction forbids codes and inference', () => {
  assert.equal(M.PURPOSES.MDM_EXTRACTION, 'mdm_extraction');
  const vt = fs.readFileSync(path.join(__dirname, '..', 'vertexTransport.js'), 'utf8');
  const i = vt.indexOf('mdm_extraction: [');
  assert.ok(i > 0);
  const instr = vt.slice(i, vt.indexOf('].join', i));
  assert.match(instr, /Do NOT provide any billing code, E\/M level, CPT, ICD-10/);
  assert.match(instr, /Do NOT infer/);
  assert.match(instr, /MUST carry a quote/);
});

// ---- the route ----
test('the route is a clinical WRITE, and reads come through the existing poll', () => {
  const line = serverSrc.split('\n').find(l => l.startsWith('app.post(') && l.includes('/ai/extract-mdm'));
  assert.match(line, /'\/api\/clinical\/patients\/:clientId\/encounters\/:euuid\/ai\/extract-mdm', authenticateToken, requireClinicalWrite/);
});
test('it is refused before anything is gathered when the model is off or there is no note', () => {
  const start = serverSrc.slice(serverSrc.indexOf('const startMdmExtraction = async'), serverSrc.indexOf('const autoStartMdmExtraction = async'));
  assert.match(start, /MDM_NO_NOTE/);
  assert.match(start, /MODEL_BOUNDARY_REFUSED/);
  assert.ok(start.indexOf('MODEL_BOUNDARY_REFUSED') < start.indexOf("db.set('ai_reviews'"), 'the refusal comes before a row is written');
  assert.ok(start.indexOf("db.set('ai_reviews'") < start.indexOf('runMdmExtraction({'));
  const route = serverSrc.slice(serverSrc.indexOf("/ai/extract-mdm', authenticateToken"));
  assert.match(route.slice(0, 1200), /startMdmExtraction\(/, 'the button goes through the same starter');
});
test('a BILLABLE signature starts the extraction as the signing clinician; an author signature does not', () => {
  const sign = serverSrc.slice(serverSrc.indexOf("/encounters/:euuid/sign', authenticateToken"), serverSrc.indexOf("/encounters/:euuid/co-sign', authenticateToken"));
  assert.match(sign, /\n {4}if \(!authorSignature\) await autoStartMdmExtraction\(\{ req, /);
  const addendum = serverSrc.slice(serverSrc.indexOf("/encounters/:euuid/co-sign', authenticateToken"));
  const end = addendum.indexOf("res.json({ message: 'Clinician addendum added");
  assert.match(addendum.slice(0, end), /\n {4}await autoStartMdmExtraction\(\{ req, /);
  assert.ok(addendum.slice(0, end).lastIndexOf('saveBillingRecord(') < addendum.slice(0, end).indexOf('autoStartMdmExtraction('), 'the signature is saved before extraction starts');
});
test('auto-start never throws into the signature and is silent when the model is off', () => {
  const auto = serverSrc.slice(serverSrc.indexOf('const autoStartMdmExtraction = async'), serverSrc.indexOf('// POST …/encounters/:euuid/ai/extract-mdm'));
  assert.match(auto, /try \{/);
  assert.match(auto, /catch \(e\)/);
  assert.match(auto, /'MODEL_BOUNDARY_REFUSED'/);
  assert.doesNotMatch(auto, /res\.|warnings\.push/, 'nothing reaches the clinician\'s screen');
});
test('it is stored in ai_reviews, purged on the same schedule as the chart review', () => {
  const job = serverSrc.slice(serverSrc.indexOf('const runMdmExtraction = async'), serverSrc.indexOf('// One way to start an extraction'));
  assert.match(job, /saveAiReview\(/);
  const purge = serverSrc.slice(serverSrc.indexOf('const purgeAiReviews = async'), serverSrc.indexOf('setInterval(purgeAiReviews'));
  assert.match(purge, /loadAiReviews\(\)/, 'the purge covers every ai_reviews row, this purpose included');
});

// ---- RUN the job: what reaches the model, and what is stored ----
const liftJob = (deps) => {
  const start = serverSrc.indexOf('const runMdmExtraction = async');
  const end = serverSrc.indexOf('// One way to start an extraction');
  assert.ok(start > 0 && end > start);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), `${serverSrc.slice(start, end)}\nreturn runMdmExtraction;`)(...Object.values(deps));
};
const runJob = async ({ proposal, soap, fail }) => {
  const saved = {}; const sent = []; const writes = []; const audit = [];
  const emr = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'getSoapNote') return async () => soap;
      if (prop === 'getProblems') return async () => [{ code: { text: 'Hypertension' } }];
      if (prop === 'getMedicationRequests') return async () => [{ medicationCodeableConcept: { text: 'Lisinopril 10 mg' } }];
      return async (...a) => { writes.push(String(prop)); throw new Error(`${String(prop)} must not be called`); };
    }
  });
  const job = liftJob({
    openemr: { isConfigured: () => true, forActor: () => emr },
    clinicalRepo: require('../clinicalRepository'),
    docRules: require('../clientDocuments'),
    db: { get: async () => [] },
    chartPacket: require('../chartPacket'),
    googledrive: { downloadFileBuffer: async () => Buffer.from('x') },
    mdmExtraction: X,
    saveAiReview: async (id, patch) => { Object.assign(saved, patch); },
    appendCodingAuditEvent: async (e) => { audit.push(e); },
    gfcModelEngine: { invoke: async (args) => { sent.push(args); if (fail) throw Object.assign(new Error('boom'), { code: 'X' }); return { invocationId: 'inv1', modelId: 'gemini-test', proposal }; } },
    modelEngine: M,
    AI_REVIEW_STATUS: { RUNNING: 'running', DONE: 'done', FAILED: 'failed' },
    console: { error: () => {}, warn: () => {}, log: () => {} }
  });
  await job({ reviewId: 'r1', req: { user: { id: 'u1' } }, client: { id: 'c1', openEmrPatientId: 'p1' }, encounterUuid: 'e1', record: { ...RECORD, narrativeNoteSid: '9' } });
  return { saved, sent, writes, audit };
};

test('RUN: the model is sent the note and lists with NO code in any of it, under the MDM purpose and schema', async () => {
  const { sent, saved } = await runJob({ proposal: {}, soap: { subjective: 'Narrative copy', plan: 'Recheck' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].purpose, 'mdm_extraction');
  assert.equal(sent[0].schema, X.MDM_SCHEMA);
  const prompt = JSON.stringify(sent[0].input);
  for (const c of ['99349', 'I10', '"25"']) assert.ok(!prompt.includes(c), `${c} must not be sent`);
  assert.match(prompt, /Narrative copy/, 'the OpenEMR copy of the note is read by its sid');
  assert.deepEqual(sent[0].input.documents, [], 'no document is sent for coding');
  const job = serverSrc.slice(serverSrc.indexOf('const runMdmExtraction = async'), serverSrc.indexOf('// One way to start an extraction'));
  assert.ok(!job.includes('downloadFileBuffer') && !job.includes('client_document_uploads'), 'the job does not even fetch attached documents');
  assert.equal(saved.status, 'done');
});
test('RUN: unquoted and invented items are dropped, counted, and the rest stored as a draft', async () => {
  const { saved, writes } = await runJob({
    soap: null,
    proposal: {
      problemsAddressed: [
        { description: 'Orthostatic hypotension', status: 'worsening', management: 'medication', quote: 'Orthostatic hypotension, worsening.' },
        { description: 'Diabetes', status: 'stable', management: 'observation', quote: 'A1c stable at 6.8.' }
      ],
      risk: [{ factor: 'prescription_management', detail: 'Lisinopril stopped' }],
      time: { totalMinutes: 40, statementPresent: true, quote: 'Total time 40 minutes on this date.' }
    }
  });
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.output.problemsAddressed.map(p => p.description), ['Orthostatic hypotension']);
  assert.deepEqual(saved.output.risk, []);
  assert.equal(saved.output.time.totalMinutes, 40);
  assert.equal(saved.droppedUncited, 2);
  assert.deepEqual(saved.quoteCounts, { noQuote: 1, quoteNotFound: 1 });
  assert.deepEqual(writes, [], 'nothing is written to OpenEMR');
});
test('RUN: the FULL proposal, dropped items included, goes to the permanent coding audit', async () => {
  const proposal = {
    problemsAddressed: [{ description: 'Orthostatic hypotension', status: 'worsening', management: 'medication', quote: 'Orthostatic hypotension, worsening.' }],
    risk: [{ factor: 'prescription_management', detail: 'Lisinopril stopped' }]
  };
  const { audit, saved } = await runJob({ soap: null, proposal });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].type, 'mdm_extraction_proposed');
  assert.deepEqual(audit[0].proposal, proposal, 'what the model proposed, unfiltered');
  assert.equal(audit[0].dropped, 1);
  assert.equal(audit[0].invocationId, 'inv1');
  assert.equal(audit[0].model, 'gemini-test');
  assert.equal(saved.status, 'done');
});
test('the coding audit is append-only and outside the AI purge', () => {
  const purge = serverSrc.slice(serverSrc.indexOf('const purgeAiReviews = async'), serverSrc.indexOf('setInterval(purgeAiReviews'));
  assert.ok(!purge.includes('coding_audit_events'), 'the 180-day purge never touches it');
  const writes = serverSrc.match(/db\.set\('coding_audit_events'/g) || [];
  assert.equal(writes.length, 1, 'exactly one writer');
  const fn = serverSrc.slice(serverSrc.indexOf('const appendCodingAuditEvent = async'), serverSrc.indexOf('const runMdmExtraction = async'));
  assert.match(fn, /\[\.\.\.\(await loadRows\('coding_audit_events'\)\), row\]/, 'it only ever appends');
  const job = serverSrc.slice(serverSrc.indexOf('const runMdmExtraction = async'), serverSrc.indexOf('// One way to start an extraction'));
  assert.ok(job.indexOf('appendCodingAuditEvent(') < job.indexOf('status: AI_REVIEW_STATUS.DONE'), 'the audit is written before the draft is marked done');
});
test('RUN: a failed call is recorded as failed, scrubbed, never as an empty success', async () => {
  const { saved } = await runJob({ proposal: null, soap: null, fail: true });
  assert.equal(saved.status, 'failed');
  assert.equal(saved.code, 'X');
});
test('the job never touches the chart: no OpenEMR write, no note save, no record write', () => {
  const job = serverSrc.slice(serverSrc.indexOf('const runMdmExtraction = async'), serverSrc.indexOf('// One way to start an extraction'));
  for (const w of ['updateSoapNote', 'addSoapNote', 'postCharge', 'updateEncounter', 'addProblem', 'addMedication', 'saveBillingRecord', "db.set('encounter_billing'"]) {
    assert.ok(!job.includes(w), `${w} must not appear in the extraction job`);
  }
});
