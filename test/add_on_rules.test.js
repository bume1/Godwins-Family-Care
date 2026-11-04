'use strict';
// Phase 4: add-on rules (4.2) and diagnosis suggestions (4.1), AI coding
// pipeline spec 2026-11-04. Each rule is shown to fire, and a clean case to
// pass. The suggestion job is lifted out of server.js and RUN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../addOnRules');
const DX = require('../dxSuggestion');
const M = require('../modelEngine');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const L = (code, extra = {}) => ({ code, units: 1, dxLinks: ['I10'], modifiers: [], ...extra });
const run = (input) => A.evaluate({ dos: '2026-11-04', ...input });
const codes = (r, sev) => r.findings.filter(f => !sev || f.severity === sev).map(f => f.code);
const offered = (r) => r.offers.map(o => o.code);
const JUST = (k) => ({ [k]: { text: 'A separately identifiable problem was managed.' } });

test('every rule names its source in the file header (4.3)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'addOnRules.js'), 'utf8');
  for (const u of [
    'https://www.cms.gov/outreach-and-education/medicare-learning-network-mln/mlnproducts/downloads/eval-mgmt-serv-guide-icn006764.pdf',
    'https://www.cms.gov/files/document/mm13473-how-use-office-and-outpatient-evaluation-and-management-visit-complexity-add-code-g2211.pdf',
    'https://www.cms.gov/files/document/mln901705-telehealth-services.pdf',
    'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-policy-manual',
    'https://www.cms.gov/outreach-and-education/medicare-learning-network-mln/mlnproducts/preventive-services/medicare-wellness-visits.html'
  ]) assert.ok(src.includes(u), u);
});

// ---- G2211 ----
test('G2211 is OFFERED on a home or office E/M for a continuing-care patient, never added', () => {
  const r = run({ lines: [L('99349')], continuingCare: true });
  assert.deepEqual(offered(r), ['G2211']);
  assert.deepEqual(codes(r), []);
  assert.deepEqual(offered(run({ lines: [L('99349')], continuingCare: false })), [], 'not a continuing source of care');
  assert.deepEqual(offered(run({ lines: [L('99349'), L('G2211')], continuingCare: true })), [], 'already billed');
});
test('G2211 with no E/M base blocks; with a modifier 25 base it blocks, except beside an AWV on an office visit', () => {
  assert.deepEqual(codes(run({ lines: [L('G2211')] })), ['G2211_WITHOUT_BASE']);
  const m25 = [L('99349', { modifiers: ['25'] }), L('G2211')];
  assert.ok(codes(run({ lines: m25, justifications: JUST('99349-25') })).includes('G2211_WITH_MODIFIER_25'));
  const officeAwv = [L('99214', { modifiers: ['25'] }), L('G2211'), L('G0439')];
  assert.ok(!codes(run({ lines: officeAwv, justifications: JUST('99214-25'), priorAwvDates: ['2025-01-01'] })).includes('G2211_WITH_MODIFIER_25'));
  const homeAwv = [L('99349', { modifiers: ['25'] }), L('G2211'), L('G0439')];
  assert.ok(codes(run({ lines: homeAwv, justifications: JUST('99349-25'), priorAwvDates: ['2025-01-01'] })).includes('G2211_WITH_MODIFIER_25'), 'the exception is the office codes only');
});

// ---- G0318: CMS's thresholds, 140 new and 110 established ----
const byTime = (code, minutes) => ({ finalBasis: 'time', finalCode: code, time: { minutes } });
test('G0318 is offered only with the top home level selected by time, from CMS\'s threshold, each further 15', () => {
  assert.deepEqual(A.G0318.thresholdByBase, { 99345: 140, 99350: 110 });
  assert.deepEqual(run({ lines: [L('99350')], emDerivation: byTime('99350', 110), totalMinutes: 109 }).offers, []);
  const one = run({ lines: [L('99350')], emDerivation: byTime('99350', 110), totalMinutes: 110 });
  assert.match(one.offers[0].message, /G0318 × 1/);
  assert.match(run({ lines: [L('99350')], emDerivation: byTime('99350', 125), totalMinutes: 125 }).offers[0].message, /G0318 × 2/);
  assert.match(run({ lines: [L('99345')], emDerivation: byTime('99345', 140), totalMinutes: 140 }).offers[0].message, /G0318 × 1/);
  assert.deepEqual(run({ lines: [L('99345')], emDerivation: byTime('99345', 139), totalMinutes: 139 }).offers, []);
  assert.deepEqual(run({ lines: [L('99350')], emDerivation: { finalBasis: 'mdm', finalCode: '99350' }, totalMinutes: 200 }).offers, [], 'not when selected by MDM');
  assert.deepEqual(run({ lines: [L('99349')], emDerivation: byTime('99349', 200), totalMinutes: 200 }).offers, [], 'not with a lower level');
});
test('G0318 billed otherwise blocks, each case by name', () => {
  assert.deepEqual(codes(run({ lines: [L('99349'), L('G0318')] })), ['G0318_WRONG_BASE']);
  assert.deepEqual(codes(run({ lines: [L('99350'), L('G0318')], emDerivation: { finalBasis: 'mdm', finalCode: '99350' }, totalMinutes: 200 })), ['G0318_NOT_BY_TIME']);
  assert.deepEqual(codes(run({ lines: [L('99350'), L('G0318')], emDerivation: byTime('99350', 100), totalMinutes: 100 })), ['G0318_UNDER_THRESHOLD']);
  assert.deepEqual(codes(run({ lines: [L('99350'), L('G0318', { units: 3 })], emDerivation: byTime('99350', 125), totalMinutes: 125 })), ['G0318_TOO_MANY_UNITS']);
  assert.deepEqual(codes(run({ lines: [L('99350'), L('G0318', { units: 2 })], emDerivation: byTime('99350', 125), totalMinutes: 125 })), []);
});

// ---- modifiers ----
test('modifier 25 is offered when an AWV or another service shares the date, never applied', () => {
  assert.deepEqual(offered(run({ lines: [L('99349'), L('99497')] })), ['25']);
  assert.deepEqual(offered(run({ lines: [L('99349')], sameDayOtherCodes: ['G0439'], priorAwvDates: ['2025-01-01'] })), ['25']);
  assert.deepEqual(offered(run({ lines: [L('99349'), L('G2211')] })), [], 'an add-on is not a separate service');
  const r = run({ lines: [L('99349'), L('99497')] });
  assert.equal(r.findings.length, 0, 'an offer changes nothing');
});
test('25, 59 and the X modifiers block without the rendering clinician\'s recorded reason', () => {
  for (const m of ['25', '59', 'XE', 'XS', 'XP', 'XU']) {
    const r = run({ lines: [L('99349', { modifiers: [m] }), L('99497')] });
    assert.deepEqual(codes(r, 'block'), ['MODIFIER_NOT_JUSTIFIED'], m);
    assert.deepEqual(codes(run({ lines: [L('99349', { modifiers: [m] }), L('99497')], justifications: JUST(`99349-${m}`) }), 'block'), [], `${m} with a reason`);
  }
});
test('59, XE, XS, XP and XU are NEVER offered', () => {
  const cases = [{ lines: [L('99349'), L('99497')] }, { lines: [L('99349'), L('G0439')], priorAwvDates: [] }, { lines: [L('99349')], visit: { modality: 'phone' } }];
  for (const c of cases) for (const o of run(c).offers) assert.ok(!A.DISTINCT_PROCEDURAL.includes(o.code), o.code);
  const src = fs.readFileSync(path.join(ROOT, 'addOnRules.js'), 'utf8');
  assert.ok(!/offer\(\s*(MOD\.)?['"]?(59|XE|XS|XP|XU)/.test(src));
});
test('modifier 93 is offered for audio-only, never applied; 95 stays automatic for audio-video', () => {
  assert.deepEqual(offered(run({ lines: [L('99490')], visit: { modality: 'phone' } })), ['93']);
  assert.deepEqual(offered(run({ lines: [L('99490', { modifiers: ['93'] })], visit: { modality: 'phone' } })), []);
  const R = require('../clinicalRepository');
  assert.match(R.modifiersForCharge({ code: '99214', modifiers: [] }, { modality: 'telehealth' }), /95/);
  assert.doesNotMatch(R.modifiersForCharge({ code: '99214', modifiers: [] }, { modality: 'phone' }), /93/, '93 is never derived');
});

// ---- TCM and AWV ----
test('TCM blocks when the dates on record do not support the code billed', () => {
  const tcm = { dischargeDate: '2026-10-30', contactDate: '2026-11-03', faceToFaceDate: '2026-11-05', complexity: 'high' };
  assert.deepEqual(codes(run({ lines: [L('99496')], tcm })), []);
  assert.deepEqual(codes(run({ lines: [L('99496')], tcm: { ...tcm, faceToFaceDate: '2026-11-10' } })), ['TCM_DATES_DO_NOT_SUPPORT']);
  assert.match(run({ lines: [L('99496')], tcm: { ...tcm, faceToFaceDate: '2026-11-10' } }).findings[0].message, /support 99495/);
  assert.deepEqual(codes(run({ lines: [L('99495')] })), ['TCM_DATES_DO_NOT_SUPPORT'], 'no dates on record');
  const der = { mdm: { level: 'high' } };
  assert.deepEqual(codes(run({ lines: [L('99496')], tcm: { ...tcm, complexity: null }, emDerivation: der })), [], 'complexity from the derived level');
  assert.deepEqual(codes(run({ lines: [L('99496')], tcm: { ...tcm, faceToFaceDate: null }, dos: '2026-11-05' })), [], 'the face-to-face defaults to the visit date');
});
test('AWV warns when GFC\'s history does not support the code, and points at Palmetto', () => {
  const r = run({ lines: [L('G0438')], priorAwvDates: ['2025-06-01'] });
  assert.deepEqual(codes(r, 'warn'), ['AWV_HISTORY']);
  assert.match(r.findings[0].message, /support G0439.*Palmetto eServices/);
  assert.deepEqual(codes(run({ lines: [L('G0439')], priorAwvDates: ['2026-06-01'] }), 'warn'), ['AWV_HISTORY'], 'inside 12 months');
  assert.deepEqual(codes(run({ lines: [L('G0438')], priorAwvDates: [] })), []);
});

// ---- the scrub carries them ----
test('the claim scrub returns the add-on findings and the offers beside them', () => {
  const src = fs.readFileSync(path.join(ROOT, 'claimScrub.js'), 'utf8');
  assert.match(src, /const addOn = addOnRules\.evaluate\(/);
  assert.match(src, /offers: addOn\.offers/);
  const sv = serverSrc.slice(serverSrc.indexOf('const runClaimScrub = ('), serverSrc.indexOf('const liveClaimScrub ='));
  for (const k of ['continuingCare: continuingCareFor(', 'modifierJustifications: record.modifierJustifications', 'tcm: record.tcm', 'priorAwvDates: priorAwvDatesFor(']) assert.ok(sv.includes(k), k);
});
const routeLine = (frag) => serverSrc.split('\n').find(l => l.startsWith('app.') && l.includes(frag)) || '';
test('the clinician records a modifier reason; TCM dates are clinical or billing; suggestions are a clinical write', () => {
  assert.match(routeLine('/modifier-justification'), /requireClinicalWrite/);
  assert.match(routeLine('/tcm-dates'), /requireClinicalWriteOrBilling/);
  assert.match(routeLine('/ai/suggest-diagnoses'), /requireClinicalWrite/);
  const route = serverSrc.slice(serverSrc.indexOf("/modifier-justification', authenticateToken"), serverSrc.indexOf('// The dates a TCM code rests on'));
  assert.match(route, /rp\.id !== req\.user\.id/, 'only the rendering clinician');
  assert.match(route, /line: key \}\)/, 'the log carries the line, never the reason text');
  assert.doesNotMatch(route.slice(route.indexOf('logActivity')), /text/, 'no reason text in the activity log');
});

// ---- 4.1 diagnosis suggestions, in the owner's wording-first design ----
// (2026-11-04-coding-pipeline-gemini-alignment.md item 5: the model never
// names a code; the app looks the wording up in OpenEMR; the clinician picks.)
const NOTE = ['Assessment: Type 2 diabetes, A1c 8.4, uncontrolled. Essential hypertension, stable.'];
const LIST = ['Problem list: Chronic kidney disease stage 3a'];
const Q = (diagnoses) => DX.enforceQuotes({ diagnoses }, { noteTexts: NOTE, contextTexts: LIST });
test('the schema has NO code field, and the instruction forbids every kind of code', () => {
  assert.deepEqual(Object.keys(DX.DX_SCHEMA.fields.diagnoses.items), ['wording', 'quote']);
  const blob = JSON.stringify(DX.DX_SCHEMA);
  for (const f of ['code', 'icd', 'cpt', 'hcpcs']) assert.ok(!new RegExp(f, 'i').test(blob), f);
  assert.equal(M.validateSchemaShape(DX.DX_SCHEMA, 'schema'), null);
  const r = M.validateAgainstSchema({ diagnoses: [{ wording: 'HTN', quote: 'q', code: 'I10' }], icd10: 'I10' }, DX.DX_SCHEMA);
  assert.deepEqual(Object.keys(r.value.diagnoses[0]), ['wording', 'quote'], 'a code the model adds anyway is dropped');
  const vt = fs.readFileSync(path.join(ROOT, 'vertexTransport.js'), 'utf8');
  const instr = vt.slice(vt.indexOf('dx_suggestion: ['), vt.indexOf('].join', vt.indexOf('dx_suggestion: [')));
  assert.match(instr, /Do NOT give any code: no ICD-10, CPT, HCPCS, modifier or E\/M level\./);
  assert.match(instr, /MUST carry a quote/);
});
test('quotes: from the note kept as note, from a list kept as list, none or invented dropped and counted', () => {
  const r = Q([
    { wording: 'Type 2 diabetes mellitus with hyperglycemia', quote: 'Type 2 diabetes, A1c 8.4, uncontrolled.' },
    { wording: 'Chronic kidney disease, stage 3a', quote: 'Chronic kidney disease stage 3a' },
    { wording: 'Essential hypertension' },
    { wording: 'Heart failure', quote: 'CHF exacerbation' },
    { wording: 'type 2 diabetes mellitus with hyperglycemia', quote: 'Type 2 diabetes, A1c 8.4, uncontrolled.' }
  ]);
  assert.deepEqual(r.wordings.map(w => w.quoteSource), ['note', 'list']);
  assert.deepEqual(r.counts, { noQuote: 1, quoteNotFound: 1, duplicate: 1 });
});
test('resolution: OpenEMR\'s rows become candidates; nothing found or a failed search drops the wording', () => {
  const wordings = [{ wording: 'A' }, { wording: 'B' }, { wording: 'C' }];
  const r = DX.resolve(wordings, {
    A: [{ code: 'E11.65', code_text: 'Type 2 diabetes mellitus with hyperglycemia' }, { code: 'E11.65', code_text: 'dup' }, { code: 'NOTACODE' }],
    B: [], C: { error: 'timeout' }
  }, { existingCodes: ['E11.65'] });
  assert.deepEqual(r.suggestions.map(x => x.wording), ['A']);
  assert.deepEqual(r.suggestions[0].candidates.map(c => c.code), ['E11.65'], 'ICD-10 in shape, each once');
  assert.equal(r.suggestions[0].candidates[0].alreadyOnEncounter, true);
  assert.deepEqual(r.counts, { notInTable: 1, notChecked: 1 });
});
test('an unspecified candidate is flagged when OpenEMR returned a more specific one beside it', () => {
  const c = DX.candidatesFrom([{ code: 'R51.9', code_text: 'Headache, unspecified' }, { code: 'R51.0', code_text: 'Headache with orthostatic component' }]);
  assert.equal(c[0].moreSpecificListed, true);
  assert.equal(c[1].moreSpecificListed, false);
  assert.equal(DX.candidatesFrom([{ code: 'R51.9', code_text: 'Headache, unspecified' }])[0].moreSpecificListed, false);
});
test('an accepted suggestion must name a code OpenEMR returned for it, and the decision goes to the permanent audit', () => {
  const d = serverSrc.slice(serverSrc.indexOf("app.post('/api/clinical/ai/reviews/:id/decisions'"));
  const body = d.slice(0, 4000);
  assert.match(body, /const allowedDecisions = isDx \? \['accepted', 'dismissed'\]/);
  assert.match(body, /if \(!chosen \|\| !\(sug\.candidates \|\| \[\]\)\.some\(c => c\.code === chosen\)\) \{\s*return res\.status\(400\)\.json\(\{ error: 'Pick one of the codes OpenEMR returned for that diagnosis\.', code: 'AI_DX_NOT_A_CANDIDATE'/, 'the code must be one OpenEMR returned for that wording');
  assert.match(body, /type: 'dx_suggestion_decided'/);
  assert.ok(require('../clinicalRepository').buildEncounterDiagnoses([{ code: 'I10', source: 'ai_suggestion' }]).diagnoses[0].source === 'ai_suggestion', 'an added suggestion keeps its provenance');
});

// RUN the job with a fake engine and a fake OpenEMR search.
const liftDx = (deps) => {
  const a = serverSrc.indexOf('const gatherCodingPacket = async'); const aEnd = serverSrc.indexOf('const runMdmExtraction = async');
  const b = serverSrc.indexOf('const runDxSuggestion = async'); const bEnd = serverSrc.indexOf('// POST …/encounters/:euuid/ai/suggest-diagnoses');
  assert.ok(a > 0 && b > 0);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), `${serverSrc.slice(a, aEnd)}\n${serverSrc.slice(b, bEnd)}\nreturn runDxSuggestion;`)(...Object.values(deps));
};
const runDx = async (proposal) => {
  const saved = {}; const writes = []; const searched = []; const audit = []; const sent = [];
  const emr = new Proxy({}, { get(_t, p) {
    if (p === 'getSoapNote') return async () => ({ assessment: 'Essential hypertension, stable.' });
    if (p === 'getProblems' || p === 'getMedicationRequests') return async () => [];
    if (p === 'searchCodes') return async ({ type, search }) => { searched.push(`${type}:${search}`); return /hypertension/i.test(search) ? [{ code: 'I10', code_text: 'Essential (primary) hypertension' }] : []; };
    return async () => { writes.push(String(p)); throw new Error('no'); };
  } });
  const job = liftDx({
    openemr: { isConfigured: () => true, forActor: () => emr }, clinicalRepo: require('../clinicalRepository'),
    chartPacket: require('../chartPacket'), mdmExtraction: require('../mdmExtraction'),
    saveAiReview: async (id, p) => Object.assign(saved, p),
    gfcModelEngine: { invoke: async (args) => { sent.push(args); return { invocationId: 'i', modelId: 'm', proposal }; } },
    appendCodingAuditEvent: async (e) => { audit.push(e); },
    dxSuggestion: DX, modelEngine: M, AI_REVIEW_STATUS: { DONE: 'done', FAILED: 'failed' }, console: { error() {} }
  });
  await job({ reviewId: 'r', req: { user: { id: 'u', name: 'B' } }, client: { id: 'c', openEmrPatientId: 'p' }, encounterUuid: 'e',
    record: { narrativeNoteSid: '1', diagnoses: [{ code: 'E11.9', description: 'Type 2 diabetes' }], services: [{ code: '99349' }], note: { assessment: 'Essential hypertension, stable.' } } });
  return { saved, writes, searched, audit, sent };
};
test('RUN: the model is sent no code and no document; the wording is searched in OpenEMR; nothing is written to the chart', async () => {
  const { saved, writes, searched, audit, sent } = await runDx({ diagnoses: [
    { wording: 'Essential hypertension', quote: 'Essential hypertension, stable.' },
    { wording: 'Gout', quote: 'Essential hypertension, stable.' },
    { wording: 'Asthma', quote: 'Wheezing at night.' }
  ] });
  const prompt = JSON.stringify(sent[0].input);
  for (const c of ['E11.9', '99349']) assert.ok(!prompt.includes(c), `${c} must not be sent`);
  assert.deepEqual(sent[0].input.documents, []);
  assert.equal(saved.status, 'done');
  assert.deepEqual(searched, ['ICD10:Essential hypertension', 'ICD10:Gout'], 'only quoted wordings are searched, by wording, in the ICD-10 table');
  assert.deepEqual(saved.output.diagnoses.map(d => d.wording), ['Essential hypertension']);
  assert.deepEqual(saved.output.diagnoses[0].candidates.map(c => c.code), ['I10']);
  assert.deepEqual(saved.quoteCounts, { noQuote: 0, quoteNotFound: 1, duplicate: 0, notInTable: 1, notChecked: 0 });
  assert.deepEqual(writes, []);
  assert.equal(audit.length, 1, 'the full proposal goes to the permanent audit');
  assert.equal(audit[0].type, 'dx_wording_proposed');
  assert.equal(audit[0].proposal.diagnoses.length, 3, 'dropped items included');
});
