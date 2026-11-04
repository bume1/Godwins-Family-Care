'use strict';
// E/M level derivation from confirmed facts (AI coding pipeline, Phase 3,
// 2026-11-04). The level table, the AMA MDM framework element by element, the
// two candidates and the conservative default, the coder's flag, and the
// server pieces lifted out of server.js and RUN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../emLevels');
const E = require('../emMdm');
const S = require('../claimScrub');
const X = require('../mdmExtraction');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// ---- 3.1 the table ----
test('the level table is exactly the spec\'s sixteen rows', () => {
  const rows = L.FAMILIES.flatMap(f => f.levels.map(l => `${f.key} ${l.code} ${l.mdm} ${l.minutes}`));
  assert.deepEqual(rows, [
    'home_new 99341 straightforward 15', 'home_new 99342 low 30', 'home_new 99344 moderate 60', 'home_new 99345 high 75',
    'home_established 99347 straightforward 20', 'home_established 99348 low 30', 'home_established 99349 moderate 40', 'home_established 99350 high 60',
    'office_new 99202 straightforward 15', 'office_new 99203 low 30', 'office_new 99204 moderate 45', 'office_new 99205 high 60',
    'office_established 99212 straightforward 10', 'office_established 99213 low 20', 'office_established 99214 moderate 30', 'office_established 99215 high 40'
  ]);
  assert.equal(L.verified, true);
  assert.equal(L.verifiedAgainst.length, 3);
});
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test', 'docs', 'vendor', 'attached_assets'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      // The verify_ probes carry codes as fixtures, as code_catalog.test.js allows.
      else if (/\.(js|html)$/.test(ent.name) && !/^scripts[\\/]verify_/.test(path.relative(ROOT, p))) out.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  return out;
};
test('these sixteen codes and their thresholds appear in no other file', () => {
  const codes = L.FAMILIES.flatMap(f => f.levels.map(l => l.code));
  for (const f of sourceFiles()) {
    if (f === 'emLevels.js') continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
    for (const c of codes) assert.ok(!new RegExp(`['"\`]${c}['"\`]`).test(src), `${f} holds ${c} as a literal`);
    assert.ok(!/mdm:\s*['"A-Za-z.]+,\s*minutes:\s*\d+/.test(src), `${f} holds a level-to-minutes table`);
  }
});
test('time thresholds are met or exceeded, never ranges', () => {
  assert.equal(L.levelForMinutes('home_established', 39).code, '99348');
  assert.equal(L.levelForMinutes('home_established', 40).code, '99349');
  assert.equal(L.levelForMinutes('home_established', 600).code, '99350');
  assert.equal(L.levelForMinutes('home_established', 19), null, 'below the lowest threshold there is no time candidate');
  assert.equal(L.levelForMinutes('office_established', 10).code, '99212');
});

// ---- 3.2 the MDM engine, element by element (AMA Table 1) ----
const P = (status, d = 'x') => ({ description: d, status, management: 'observation', quote: 'q' });
test('problems: minimal, low, moderate as the AMA table reads; high is never reached from these facts', () => {
  assert.equal(E.scoreProblems([]).level, 'straightforward');
  assert.equal(E.scoreProblems([P('resolved')]).level, 'straightforward');
  assert.equal(E.scoreProblems([P('resolved'), P('resolved')]).level, 'low', '2 self-limited or minor problems');
  assert.equal(E.scoreProblems([P('stable')]).level, 'low', '1 stable chronic illness');
  assert.equal(E.scoreProblems([P('new')]).level, 'low', '1 acute uncomplicated problem');
  assert.equal(E.scoreProblems([P('stable'), P('stable')]).level, 'moderate', '2 stable chronic illnesses');
  assert.equal(E.scoreProblems([P('worsening')]).level, 'moderate', '1 chronic illness with exacerbation');
  assert.equal(E.scoreProblems([P('unclear'), P('unclear')]).level, 'straightforward', 'unclear is not counted');
  const w = E.scoreProblems([P('worsening', 'CHF')]);
  assert.equal(w.possible, 'high');
  assert.match(w.absent[0], /does not state whether the worsening of "CHF" is a severe exacerbation/);
});
const D = (kind, detail) => ({ kind, detail, quote: 'q' });
test('data: limited, moderate, extensive as the AMA categories read', () => {
  assert.equal(E.scoreData([D('lab', 'CBC')]).level, 'straightforward', 'one item is not limited');
  assert.equal(E.scoreData([D('lab', 'CBC'), D('imaging', 'CXR')]).level, 'low', 'Cat 1: two items');
  assert.equal(E.scoreData([D('independent_historian', 'daughter')]).level, 'low', 'Cat 2 of Limited: historian');
  assert.equal(E.scoreData([D('lab', 'CBC'), D('lab', 'BMP'), D('outside_record', 'discharge summary')]).level, 'moderate', 'Cat 1: three items');
  assert.equal(E.scoreData([D('lab', 'CBC'), D('lab', 'BMP'), D('independent_historian', 'daughter')]).level, 'moderate', 'Cat 1 of Moderate counts the historian');
  assert.equal(E.scoreData([D('test_interpretation', 'ECG')]).level, 'moderate');
  assert.equal(E.scoreData([D('discussion_with_clinician', 'cardiology')]).level, 'moderate');
  assert.equal(E.scoreData([D('test_interpretation', 'ECG'), D('discussion_with_clinician', 'cardiology')]).level, 'high', 'two of three categories');
  assert.equal(E.scoreData([D('lab', 'CBC'), D('lab', 'cbc ')]).level, 'straightforward', 'each UNIQUE test once');
  const pn = E.scoreData([D('lab', 'CBC'), D('prior_note', 'last visit')]);
  assert.equal(pn.level, 'straightforward', 'a GFC prior note is not an external note');
  assert.equal(pn.possible, 'low');
});
const R = (factor, detail = 'x') => ({ factor, detail, quote: 'q' });
test('risk: moderate and high as the AMA examples read', () => {
  assert.equal(E.scoreRisk([]).level, 'straightforward');
  assert.equal(E.scoreRisk([R('otc_management')]).level, 'low');
  assert.equal(E.scoreRisk([R('prescription_management')]).level, 'moderate');
  assert.equal(E.scoreRisk([R('social_determinants')]).level, 'moderate');
  assert.equal(E.scoreRisk([R('drug_therapy_monitoring')]).level, 'high');
  assert.equal(E.scoreRisk([R('decision_re_hospitalization')]).level, 'high');
  const s = E.scoreRisk([R('decision_re_surgery', 'knee replacement')]);
  assert.equal(s.level, 'moderate');
  assert.equal(s.possible, 'high');
});
test('MDM is the highest level met by at least two of the three elements', () => {
  assert.equal(E.mdmFromElements(['high', 'straightforward', 'straightforward']), 'straightforward');
  assert.equal(E.mdmFromElements(['high', 'moderate', 'straightforward']), 'moderate');
  assert.equal(E.mdmFromElements(['high', 'high', 'low']), 'high');
  assert.equal(E.mdmFromElements(['low', 'moderate', 'low']), 'low');
});
test('each element\'s scoring function cites the AMA PDF, not memory', () => {
  const src = fs.readFileSync(path.join(ROOT, 'emMdm.js'), 'utf8');
  const url = 'https://www.ama-assn.org/system/files/2023-e-m-descriptors-guidelines.pdf';
  for (const fn of ['const scoreProblems', 'const scoreData', 'const scoreRisk']) {
    const i = src.indexOf(fn);
    const comment = src.slice(src.lastIndexOf('// ----', i), i);
    assert.ok(comment.includes(url), `${fn} cites the AMA table`);
  }
});

// ---- 3.3 two candidates, a conservative default, a flag ----
const FACTS = (over = {}) => ({
  problemsAddressed: [P('worsening', 'Hypertension')], dataReviewed: [], risk: [R('prescription_management', 'Stopped lisinopril')],
  time: { statementPresent: false, totalMinutes: null }, ...over
});
const derive = (o = {}) => E.deriveLevel({ setting: 'home', patientStatus: 'established', facts: FACTS(), ...o });
test('an MDM-only visit: one candidate, no flag', () => {
  const r = derive();
  assert.equal(r.mdm.code, '99349');
  assert.equal(r.finalCode, '99349');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.flag, null);
});
test('time higher than MDM: both presented, the LOWER is the default, and the flag is raised', () => {
  const r = derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 65 } }) });
  assert.deepEqual(r.candidates.map(c => `${c.basis}:${c.code}`), ['mdm:99349', 'time:99350']);
  assert.equal(r.defaultCode, '99349');
  assert.equal(r.finalCode, '99349');
  assert.equal(r.flag.code, 'LEVEL_AMBIGUOUS');
  assert.ok(r.flag.reasons.includes('candidates_disagree'));
});
test('time lower than MDM: time is the default, because the lower wins', () => {
  const r = derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 25 } }) });
  assert.equal(r.defaultCode, '99347');
  assert.equal(r.finalCode, '99347');
});
test('the higher time level is chosen only when the note states it AND the clinician affirms it', () => {
  const facts = FACTS({ time: { statementPresent: true, totalMinutes: 65 } });
  assert.equal(derive({ facts, chooseTime: true }).code, 'EM_TIME_NOT_AFFIRMED');
  const ok = derive({ facts, chooseTime: true, affirmTime: true });
  assert.equal(ok.finalCode, '99350');
  assert.equal(ok.override, true);
  assert.equal(ok.flag.code, 'LEVEL_AMBIGUOUS', 'a chosen higher level still goes to the coder');
  const noStatement = derive({ facts: FACTS({ time: { statementPresent: false, totalMinutes: 65 } }), chooseTime: true, affirmTime: true });
  assert.equal(noStatement.code, 'EM_TIME_NOT_HIGHER', 'with no time statement there is no time candidate at all');
});
test('thin evidence flags only when what is missing could change the level', () => {
  // A new problem with uncertain prognosis would make problems moderate; with
  // risk moderate that moves MDM from low to moderate: flagged.
  const moves = derive({ facts: FACTS({ problemsAddressed: [P('new', 'Chest pain')] }) });
  assert.equal(moves.mdm.code, '99348');
  assert.ok(moves.flag && moves.flag.reasons.includes('thin_evidence'));
  assert.ok(moves.flag.absent.some(a => /does not state whether the new problem "Chest pain" has an uncertain prognosis/.test(a)));
  // Worsening could be high, but data is minimal and risk moderate: MDM stays
  // moderate either way, so nothing to flag.
  assert.equal(derive().flag, null);
});
test('the flag carries both candidates, the facts behind each element with their quotes, and the absences', () => {
  const r = derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 65 } }) });
  assert.equal(r.flag.candidates.length, 2);
  const probs = r.flag.elements.find(e => e.element === 'problems');
  assert.equal(probs.facts[0].quote, 'q');
  const none = derive({ facts: FACTS({ problemsAddressed: [P('new')] }) });
  assert.ok(none.flag.absent.includes('No total time is stated in the note.'));
});
test('a total entered at signing that disagrees with the note is stated for the coder', () => {
  const r = derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 45 } }), context: { enteredMinutes: 30 } });
  assert.ok(r.flag.reasons.includes('time_disagrees'));
  assert.ok(r.flag.absent.some(a => /30 minutes\) is not the time stated in the note \(45 minutes\)/.test(a)));
});
test('NO message coaches toward a code, and none carries a dollar amount', () => {
  const variants = [derive(), derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 65 } }) }), derive({ facts: FACTS({ problemsAddressed: [P('new')], risk: [R('decision_re_surgery')] }) })];
  for (const r of variants) {
    const text = [r.explanation, ...((r.flag && r.flag.absent) || [])].join(' ');
    assert.doesNotMatch(text, /\$|dollar|to reach|to bill|document \d+|add(ing)? \d+ minutes|would (have )?support/i, text);
  }
});
test('the family follows setting and patient status; an unknown one derives nothing', () => {
  assert.equal(E.deriveLevel({ setting: 'office', patientStatus: 'new', facts: FACTS() }).finalCode, '99204');
  assert.equal(E.deriveLevel({ setting: 'home', patientStatus: 'new', facts: FACTS() }).finalCode, '99344');
  assert.equal(E.deriveLevel({ setting: 'behavioral_health', patientStatus: 'new', facts: FACTS() }).code, 'EM_NO_FAMILY');
});
test('the explanation says how the code was reached, in plain words', () => {
  assert.match(derive().explanation, /^99349 was reached from medical decision making, which was moderate/);
  assert.match(derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 65 } }), chooseTime: true, affirmTime: true }).explanation, /^99350 was reached from total time: 65 minutes/);
});

// ---- the claim scrub reads the derivation ----
const SCRUB_BASE = {
  phase: 'pre_post', today: '2026-11-04',
  encounter: { date: '2026-11-02', facts: { checked: true, facilityId: '5', posCode: '12' } },
  encounterFacility: { id: '5', pos_code: '12' }, facilityListKnown: true,
  billingFacility: { id: '3', fieldsRead: true, npi: '1538078357', ein: '123456789', taxonomy: '363LF0000X' },
  renderingProvider: { name: 'B', npi: '1902310568' }, diagnoses: [{ code: 'I10' }],
  icd10: { I10: { exists: true } }, catalog: { fetchedAt: new Date().toISOString(), codes: [{ code: '99349' }, { code: '99350' }], inactive: [] },
  ncci: { ptpEdits: [], mueByCode: {}, sourceVersion: { ptp: { quarter: 'Q', loadedAt: new Date().toISOString() }, mue: { quarter: 'Q', loadedAt: new Date().toISOString() } } },
  payer: { kind: 'commercial', payerName: 'Aetna', memberId: 'W1' }
};
test('an open level flag is a coder warning stating both candidates and the absences; a resolved one is not', () => {
  const r = derive({ facts: FACTS({ time: { statementPresent: true, totalMinutes: 65 } }) });
  const der = { finalCode: r.finalCode, flag: r.flag };
  const lines = [{ code: '99349', units: 1, dxLinks: ['I10'] }];
  const open = S.scrubClaim({ ...SCRUB_BASE, lines, emDerivation: der });
  const f = open.findings.find(x => x.code === 'LEVEL_AMBIGUOUS');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /99349 by medical decision making \(moderate\); 99350 by time \(65 minutes\)/);
  const resolved = S.scrubClaim({ ...SCRUB_BASE, lines, emDerivation: { ...der, flag: { ...der.flag, resolvedAt: 'x' } } });
  assert.ok(!resolved.findings.some(x => x.code === 'LEVEL_AMBIGUOUS'));
});
test('a billed E/M that is not the confirmed level is surfaced', () => {
  const lines = [{ code: '99350', units: 1, dxLinks: ['I10'] }];
  const r = S.scrubClaim({ ...SCRUB_BASE, lines, emDerivation: { finalCode: '99349', flag: null } });
  assert.ok(r.findings.some(x => x.code === 'EM_DIFFERS_FROM_DERIVED' && /99350.*99349/.test(x.message)));
  const same = S.scrubClaim({ ...SCRUB_BASE, lines: [{ code: '99349', units: 1, dxLinks: ['I10'] }], emDerivation: { finalCode: '99349', flag: null } });
  assert.ok(!same.findings.some(x => x.code === 'EM_DIFFERS_FROM_DERIVED'));
});

// ---- server pieces, lifted and RUN ----
const lift = (startMarker, endMarker, names, deps) => {
  const start = serverSrc.indexOf(startMarker); const end = serverSrc.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `${startMarker} found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(deps), `${serverSrc.slice(start, end)}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
};
const P3 = lift('const EM_DERIVATIONS = ', "app.post('/api/clinical/patients/:clientId/encounters/:euuid/em-derivation',",
  ['sanitizeConfirmedFacts', 'patientStatusFor', 'emDerivationView'], { modelEngine: require('../modelEngine'), mdmExtraction: X });
test('RUN: a clinician never receives the flag; billing does', () => {
  const rec = { emDerivation: { finalCode: '99349', explanation: 'e', flag: { code: 'LEVEL_AMBIGUOUS' } } };
  assert.ok(!('flag' in P3.emDerivationView(rec, false)));
  assert.equal(P3.emDerivationView(rec, true).flag.code, 'LEVEL_AMBIGUOUS');
});
test('RUN: the source of each confirmed fact is decided by the server, and the page cannot smuggle a quote', () => {
  const extracted = { problemsAddressed: [{ description: 'HTN', status: 'stable', management: 'medication', quote: 'BP stable on lisinopril' }] };
  const out = P3.sanitizeConfirmedFacts({
    problemsAddressed: [
      { description: 'HTN', status: 'stable', management: 'medication', quote: 'BP stable on lisinopril' },
      { description: 'HTN', status: 'worsening', management: 'medication', quote: 'BP stable on lisinopril' },
      { description: 'Fall risk', status: 'new', management: 'referral', quote: 'Invented words' }
    ]
  }, extracted);
  assert.deepEqual(out.facts.problemsAddressed.map(p => p.source), ['extracted', 'edited', 'added']);
  assert.equal(out.facts.problemsAddressed[2].quote, null, 'a quote not from the extraction is not kept');
  assert.ok(P3.sanitizeConfirmedFacts({ problemsAddressed: [{ description: 'x', status: 'invented', management: 'other' }] }, extracted).error);
});
test('RUN: a new-patient visit with a signed GFC visit inside three years uses the established family, and says so', () => {
  const rec = { encounterUuid: 'e2', clientId: 'c1', date: '2026-11-02', visit: { appointmentType: 'pc_new_patient' } };
  const prior = { encounterUuid: 'e1', clientId: 'c1', date: '2025-01-10' };
  const r = P3.patientStatusFor(rec, [rec, prior], [{ encounterUuid: 'e1', signedAt: 'x' }]);
  assert.equal(r.status, 'established');
  assert.match(r.conflict, /2025-01-10/);
  assert.equal(P3.patientStatusFor(rec, [rec, { ...prior, date: '2023-01-10' }], [{ encounterUuid: 'e1', signedAt: 'x' }]).status, 'new', 'over three years ago is new again');
  assert.equal(P3.patientStatusFor({ ...rec, visit: { appointmentType: 'pc_follow_up' } }, [rec], []).status, 'established');
});
const DIST = lift('const monthOf = ', "app.get('/api/clinical/reports/em-distribution'", ['emDistribution'], { emLevels: L });
test('RUN: the distribution counts each clinician\'s E/M lines this month and last, and the flag rate', () => {
  const recs = [
    { date: '2026-11-02', renderingProvider: { id: 'b', name: 'Bethel' }, services: [{ code: '99350' }], emDerivation: { flag: {} } },
    { date: '2026-11-03', renderingProvider: { id: 'b', name: 'Bethel' }, services: [{ code: '99349' }] },
    { date: '2026-10-20', renderingProvider: { id: 'b', name: 'Bethel' }, services: [{ code: '99349' }] },
    { date: '2026-11-04', renderingProvider: { id: 'b', name: 'Bethel' }, services: [{ code: '99349' }], noteStatus: 'voided' },
    { date: '2026-11-04', renderingProvider: { id: 'b', name: 'Bethel' }, services: [{ code: '90834' }] }
  ];
  const r = DIST.emDistribution(recs, '2026-11');
  const b = r.clinicians[0];
  assert.equal(r.priorMonth, '2026-10');
  assert.deepEqual(b.months['2026-11'], { 99350: 1, 99349: 1 });
  assert.deepEqual(b.months['2026-10'], { 99349: 1 });
  assert.equal(b.flagRate['2026-11'], 0.5);
  assert.equal(b.highestShare['2026-11'], 0.5);
  assert.equal(DIST.emDistribution([], '2026-01').priorMonth, '2025-12');
});

// ---- routes and wiring ----
const routeLine = (frag) => serverSrc.split('\n').find(l => l.startsWith('app.') && l.includes(frag)) || '';
test('confirming facts is a clinical write; resolving the flag and the report are billing\'s', () => {
  assert.match(routeLine("/em-derivation', authenticateToken"), /requireClinicalWrite/);
  assert.match(routeLine('/em-derivation/flag/resolve'), /requireBilling/);
  assert.match(routeLine('/reports/em-distribution'), /^app\.get\(.*requireBilling/);
});
test('every confirmation is an append-only audit row with both levels and the override', () => {
  const route = serverSrc.slice(serverSrc.indexOf("/em-derivation', authenticateToken"), serverSrc.indexOf('/em-derivation/flag/resolve'));
  assert.match(route, /extractedFacts: extraction\.output, confirmedFacts: sane\.facts/);
  assert.match(route, /derivedCode: out\.defaultCode, finalCode: out\.finalCode, override: out\.override/);
  assert.match(route, /db\.set\(EM_DERIVATIONS, \[\.\.\.\(await loadRows\(EM_DERIVATIONS\)\), event\]\)/);
  assert.match(route, /emDerivationView\(\{ emDerivation: summary \}, false\)/, 'the clinician\'s response carries no flag');
});
test('the confirmation screen shows the AI draft notice, and no dollar amount', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'clinical.html'), 'utf8');
  const panel = page.slice(page.indexOf('const VisitFactsPanel = ('), page.indexOf('const BillingLevelPanel = ('));
  assert.match(panel, /Drafted by AI from your note\.<\/b> Unverified and not saved to the chart\./);
  assert.doesNotMatch(panel, /\$\{?fee|fmtUsd|\bprice\b|dollar/i);
  assert.doesNotMatch(panel, /\.flag\b/, 'the clinician panel never reads the flag');
});
