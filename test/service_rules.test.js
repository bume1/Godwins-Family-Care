'use strict';
// Phase 3b: service selection for the codes that are not level-based (AI
// coding pipeline spec, 2026-11-04). Each threshold is tested at the minute it
// starts and the minute before. The cross-family rules block on the scrub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SR = require('../serviceRules');
const S = require('../claimScrub');

const ROOT = path.join(__dirname, '..');
const codesOf = (r) => r.codes.map(c => (c.units > 1 ? `${c.code}x${c.units}` : c.code)).join(',');
const sel = (family, input) => codesOf(SR.select(family, input));

// ---- 3b.1, 3b.2, 3b.6: one file per family, verified, sourced, dated ----
test('every family file is verified, dated for the January review, and cites its sources', () => {
  const urls = {
    psychotherapy: ['https://www.apaservices.org/practice/reimbursement/health-codes/psychotherapy', 'https://www.apaservices.org/practice/reimbursement/health-codes/psychotherapy-services-faq'],
    chronic_care: ['https://www.cms.gov/files/document/chroniccaremanagement.pdf'],
    behavioral_integration: ['https://www.hhs.gov/guidance/sites/default/files/hhs-guidance-documents/CMS/mln909432_bhi_services_2025_508_final.pdf'],
    transitional_care: ['https://med.noridianmedicare.com/web/jeb/specialties/care-coordination/transitional-care-management-tcm'],
    advance_care_planning: ['https://coalitionccc.org/common/Uploaded%20files/PDFs/ACP%20CodesFAQs_CCCC_Oct2023c.pdf'],
    health_behavior: ['https://www.ndbh.com/Docs/PCP/6-22-2020/Health%20Behavior%20Intervention%20codes.pdf'],
    remote_monitoring: ['https://www.federalregister.gov/documents/2025/11/05/2025-19787/medicare-and-medicaid-programs-cy-2026-payment-policies-under-the-physician-fee-schedule-and-other']
  };
  const files = fs.readdirSync(path.join(ROOT, 'serviceRules')).filter(f => !['common.js', 'index.js'].includes(f));
  assert.equal(files.length, SR.FAMILIES.length, 'one file per family');
  for (const f of SR.FAMILIES) {
    assert.equal(f.verified, true, f.FAMILY);
    assert.equal(f.verifiedOn, '2026-11-04');
    assert.equal(f.nextReviewDue, '2027-01-01');
    assert.ok(f.verifiedAgainst.includes('CMS PPRRVU2026 October non-QPP'), `${f.FAMILY} cites the 2026 code validity file`);
    for (const u of urls[f.FAMILY] || []) assert.ok(f.verifiedAgainst.includes(u), `${f.FAMILY} cites ${u}`);
  }
  const reviews = SR.reviewStatus('2027-01-01');
  assert.ok(reviews.every(r => r.overdue));
  assert.ok(SR.reviewStatus('2026-12-31').every(r => !r.overdue));
});
test('a family\'s codes appear in no other source file (the credential list in clinicalRoles.js excepted)', () => {
  const sources = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test', 'docs', 'vendor', 'attached_assets'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      const rel = path.relative(ROOT, p);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(ent.name) && !/^scripts[\\/]verify_/.test(rel)) sources.push(rel);
    }
  };
  walk(ROOT);
  for (const f of SR.FAMILIES) {
    const own = path.join('serviceRules', fs.readdirSync(path.join(ROOT, 'serviceRules')).find(x => require(path.join(ROOT, 'serviceRules', x)).FAMILY === f.FAMILY));
    for (const file of sources) {
      if (file === own || file === 'clinicalRoles.js') continue;
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
      for (const c of f.CODES) assert.ok(!new RegExp(`['"\`]${c}['"\`]`).test(src), `${file} holds ${c}, which belongs to serviceRules/${f.FAMILY}`);
    }
  }
});

// ---- 3b.3, family by family, at each threshold and the minute before ----
test('psychotherapy: 16-37, 38-52, 53+; nothing under 16; the add-on bands mirror the base', () => {
  assert.equal(sel('psychotherapy', { minutes: 15 }), '');
  assert.equal(sel('psychotherapy', { minutes: 16 }), '90832');
  assert.equal(sel('psychotherapy', { minutes: 37 }), '90832');
  assert.equal(sel('psychotherapy', { minutes: 38 }), '90834');
  assert.equal(sel('psychotherapy', { minutes: 52 }), '90834');
  assert.equal(sel('psychotherapy', { minutes: 53 }), '90837');
  assert.equal(sel('psychotherapy', { minutes: 16, withEm: true }), '90833');
  assert.equal(sel('psychotherapy', { minutes: 38, withEm: true }), '90836');
  assert.equal(sel('psychotherapy', { minutes: 53, withEm: true }), '90838');
  assert.equal(sel('psychotherapy', { minutes: 40, interactiveComplexity: true }), '90834,90785');
});
test('crisis: 90839 from 30; 90840 from 75 and each further 30', () => {
  assert.equal(sel('psychotherapy', { kind: 'crisis', minutes: 29 }), '');
  assert.equal(sel('psychotherapy', { kind: 'crisis', minutes: 30 }), '90839');
  assert.equal(sel('psychotherapy', { kind: 'crisis', minutes: 74 }), '90839');
  assert.equal(sel('psychotherapy', { kind: 'crisis', minutes: 75 }), '90839,90840');
  assert.equal(sel('psychotherapy', { kind: 'crisis', minutes: 105 }), '90839,90840x2');
});
test('diagnostic evaluation: 90791 without medical services; 90792 only for a prescriber', () => {
  assert.equal(sel('psychotherapy', { kind: 'diagnostic' }), '90791');
  assert.equal(sel('psychotherapy', { kind: 'diagnostic', medicalServices: true }), '');
  assert.equal(sel('psychotherapy', { kind: 'diagnostic', medicalServices: true, prescriber: true }), '90792');
});
test('family and group', () => {
  assert.equal(sel('psychotherapy', { kind: 'family_group', type: 'family_without_patient' }), '90846');
  assert.equal(sel('psychotherapy', { kind: 'family_group', type: 'family_with_patient' }), '90847');
  assert.equal(sel('psychotherapy', { kind: 'family_group', type: 'group' }), '90853');
});
test('health behavior: assessment untimed; interventions from 16, add-ons from 38 by 15', () => {
  assert.equal(sel('health_behavior', { kind: 'assessment' }), '96156');
  assert.equal(sel('health_behavior', { kind: 'individual', minutes: 15 }), '');
  assert.equal(sel('health_behavior', { kind: 'individual', minutes: 16 }), '96158');
  assert.equal(sel('health_behavior', { kind: 'individual', minutes: 37 }), '96158');
  assert.equal(sel('health_behavior', { kind: 'individual', minutes: 38 }), '96158,96159');
  assert.equal(sel('health_behavior', { kind: 'individual', minutes: 53 }), '96158,96159x2');
  assert.equal(sel('health_behavior', { kind: 'group', minutes: 40 }), '96164,96165');
  assert.equal(sel('health_behavior', { kind: 'family', minutes: 20 }), '96167');
  assert.equal(sel('health_behavior', { kind: 'neurobehavioral', minutes: 30 }), '');
  assert.equal(sel('health_behavior', { kind: 'neurobehavioral', minutes: 31 }), '96116');
});
test('advance care planning: not under 16; 99497 first; 99498 from 46 and each further 30', () => {
  assert.equal(sel('advance_care_planning', { minutes: 15 }), '');
  assert.equal(sel('advance_care_planning', { minutes: 16 }), '99497');
  assert.equal(sel('advance_care_planning', { minutes: 45 }), '99497');
  assert.equal(sel('advance_care_planning', { minutes: 46 }), '99497,99498');
  assert.equal(sel('advance_care_planning', { minutes: 76 }), '99497,99498x2');
});
test('annual wellness: G0438 first, G0439 at 12 months, none inside; always says another practice\'s claim is not seen', () => {
  const first = SR.select('annual_wellness', { dos: '2026-11-04', priorAwvDates: [] });
  assert.equal(codesOf(first), 'G0438');
  assert.match(first.notes[0], /Another practice's AWV will not appear in GFC's records\. Check Palmetto eServices/);
  assert.equal(sel('annual_wellness', { dos: '2026-11-04', priorAwvDates: ['2025-11-04'] }), 'G0439');
  assert.equal(sel('annual_wellness', { dos: '2026-11-03', priorAwvDates: ['2025-11-04'] }), '');
});
test('TCM: contact within 2 business days (weekends skipped); 99496 high inside 7; 99495 inside 14', () => {
  const T = require('../serviceRules/transitionalCare');
  assert.equal(T.contactDeadline('2026-10-30'), '2026-11-03', 'a Friday discharge: Monday is day one, Tuesday day two');
  const base = { dischargeDate: '2026-10-30', contactDate: '2026-11-03' };
  assert.equal(sel('transitional_care', { ...base, faceToFaceDate: '2026-11-06', complexity: 'high' }), '99496');
  assert.equal(sel('transitional_care', { ...base, faceToFaceDate: '2026-11-07', complexity: 'high' }), '99495', 'day 8: high complexity falls to 99495');
  assert.equal(sel('transitional_care', { ...base, faceToFaceDate: '2026-11-13', complexity: 'moderate' }), '99495');
  assert.equal(sel('transitional_care', { ...base, faceToFaceDate: '2026-11-14', complexity: 'moderate' }), '', 'day 15');
  assert.equal(sel('transitional_care', { ...base, contactDate: '2026-11-04', faceToFaceDate: '2026-11-05', complexity: 'high' }), '', 'contact on business day three');
  assert.equal(sel('transitional_care', { ...base, faceToFaceDate: '2026-11-05', complexity: 'low' }), '');
});
test('CCM: whose time it is decides; staff time never counts toward the practitioner\'s codes', () => {
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 19 }), '');
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 20 }), '99490');
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 40 }), '99490,99439');
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 59, complex: true }), '');
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 60, complex: true }), '99487');
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 90, complex: true }), '99487,99489');
  assert.equal(sel('chronic_care', { kind: 'ccm', practitionerMinutes: 29 }), '');
  assert.equal(sel('chronic_care', { kind: 'ccm', practitionerMinutes: 30 }), '99491');
  assert.equal(sel('chronic_care', { kind: 'ccm', practitionerMinutes: 60 }), '99491,99437');
  assert.equal(sel('chronic_care', { kind: 'ccm', staffMinutes: 25 }), '99490', '25 staff minutes is never 99491');
});
test('APCM: by chronic conditions and QMB, no minute count', () => {
  assert.equal(sel('chronic_care', { kind: 'apcm', chronicConditions: 1 }), 'G0556');
  assert.equal(sel('chronic_care', { kind: 'apcm', chronicConditions: 2 }), 'G0557');
  assert.equal(sel('chronic_care', { kind: 'apcm', chronicConditions: 3, qmb: true }), 'G0558');
  assert.equal(sel('chronic_care', { kind: 'apcm', chronicConditions: 1, qmb: true }), 'G0556', 'QMB matters only with two or more');
});
test('BHI and collaborative care', () => {
  assert.equal(sel('behavioral_integration', { kind: 'bhi', staffMinutes: 19 }), '');
  assert.equal(sel('behavioral_integration', { kind: 'bhi', staffMinutes: 20 }), '99484');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 29, initialMonth: true }), '');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 30, initialMonth: true }), 'G2214');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 69, initialMonth: true }), 'G2214');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 70, initialMonth: true }), '99492');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 100, initialMonth: true }), '99492,99494');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 60 }), '99493');
  assert.equal(sel('behavioral_integration', { kind: 'cocm', managerMinutes: 90 }), '99493,99494');
});
test('RPM: setup once; supply by days; management 10-19, then 20 and each further 20', () => {
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'setup' }), '99453');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'supply', days: 1 }), '');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'supply', days: 2 }), '99445');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'supply', days: 15 }), '99445');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'supply', days: 16 }), '99454');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'supply', days: 30 }), '99454');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'management', minutes: 9 }), '');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'management', minutes: 10 }), '99470');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'management', minutes: 19 }), '99470');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'management', minutes: 20 }), '99457');
  assert.equal(sel('remote_monitoring', { kind: 'rpm', part: 'management', minutes: 40 }), '99457,99458');
});
test('RTM: the same shape, by device, and labelled inactive', () => {
  const r = SR.select('remote_monitoring', { kind: 'rtm', part: 'supply', device: 'musculoskeletal', days: 10 });
  assert.equal(codesOf(r), '98985');
  assert.match(r.explanation, /inactive in OpenEMR/);
  assert.equal(sel('remote_monitoring', { kind: 'rtm', part: 'supply', device: 'musculoskeletal', days: 20 }), '98977');
  assert.equal(sel('remote_monitoring', { kind: 'rtm', part: 'supply', device: 'respiratory', days: 20 }), '98976');
  assert.equal(sel('remote_monitoring', { kind: 'rtm', part: 'supply', device: 'respiratory', days: 10 }), '', 'no short-period respiratory code');
  assert.equal(sel('remote_monitoring', { kind: 'rtm', part: 'supply', device: 'cbt', days: 20 }), '98978');
  assert.equal(sel('remote_monitoring', { kind: 'rtm', part: 'management', minutes: 12 }), '98979');
  assert.equal(sel('remote_monitoring', { kind: 'rtm', part: 'management', minutes: 45 }), '98980,98981');
});

// ---- 3b.5 the near-threshold flag ----
test('within five minutes of the next threshold raises the review flag; six does not', () => {
  const near = SR.select('psychotherapy', { minutes: 33 });
  assert.equal(near.reviewFlag.code, 'LEVEL_AMBIGUOUS');
  assert.equal(near.reviewFlag.chosen, '90832');
  assert.equal(near.reviewFlag.next, '90834');
  assert.match(near.reviewFlag.absent[0], /documented psychotherapy time is 33 minutes\. 90834 begins at 38 minutes, and the record does not show more than 33/);
  assert.equal(SR.select('psychotherapy', { minutes: 32 }).reviewFlag, null);
  assert.equal(SR.select('psychotherapy', { minutes: 38 }).reviewFlag, null, 'at the threshold there is nothing to flag');
  assert.ok(SR.select('advance_care_planning', { minutes: 42 }).reviewFlag, 'ACP 42: 99498 at 46');
  assert.ok(SR.select('chronic_care', { kind: 'ccm', staffMinutes: 36 }).reviewFlag, 'CCM 36: 99439 at 40');
});
test('no selection message coaches toward a code', () => {
  const all = [
    SR.select('psychotherapy', { minutes: 35 }), SR.select('advance_care_planning', { minutes: 44 }),
    SR.select('remote_monitoring', { kind: 'rpm', part: 'management', minutes: 18 }), SR.select('chronic_care', { kind: 'ccm', staffMinutes: 17 })
  ];
  for (const r of all) {
    const text = [r.explanation, ...((r.reviewFlag && r.reviewFlag.absent) || [])].join(' ');
    assert.doesNotMatch(text, /\bdocument (more|another|\d+)|add \d+|to reach|to bill|should|need \d+ more/i, text);
  }
});

// ---- 3b.4 cross-family rules on the scrub ----
const BASE = {
  phase: 'pre_post', today: '2026-11-04',
  encounter: { date: '2026-11-02', facts: { checked: true, facilityId: '5', posCode: '12' } },
  encounterFacility: { id: '5', pos_code: '12' }, facilityListKnown: true,
  billingFacility: { id: '3', fieldsRead: true, npi: '1538078357', ein: '123456789', taxonomy: '363LF0000X' },
  renderingProvider: { name: 'B', npi: '1902310568' }, renderingProviderId: 'b', diagnoses: [{ code: 'I10' }],
  icd10: { I10: { exists: true } },
  catalog: { fetchedAt: new Date().toISOString(), codes: ['99490', 'G0557', 'G0568', '99495', '99454', '99445', '99470', '99457', '99349', '90833'].map(code => ({ code })), inactive: [] },
  ncci: { ptpEdits: [], mueByCode: {}, sourceVersion: { ptp: { quarter: 'Q', loadedAt: new Date().toISOString() }, mue: { quarter: 'Q', loadedAt: new Date().toISOString() } } },
  payer: { kind: 'commercial', payerName: 'Aetna', memberId: 'W1' }
};
const L = (...codes) => codes.map(code => ({ code, units: 1, dxLinks: ['I10'] }));
const blocks = (r) => r.findings.filter(f => f.severity === 'block').map(f => f.code);
test('APCM, CCM and TCM cannot be billed by the same practitioner for the same patient in the same month', () => {
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines: L('99490'), sameMonthOtherLines: [{ code: 'G0557', renderingProviderId: 'b' }] })).includes('CARE_MANAGEMENT_SAME_MONTH'));
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines: L('99495'), sameMonthOtherLines: [{ code: '99490', renderingProviderId: 'b' }] })).includes('CARE_MANAGEMENT_SAME_MONTH'));
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines: L('99490'), sameMonthOtherLines: [{ code: 'G0557', renderingProviderId: 'other' }] })).includes('CARE_MANAGEMENT_SAME_MONTH'), 'a different practitioner');
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines: L('99490') })).includes('CARE_MANAGEMENT_SAME_MONTH'));
});
test('an APCM behavioral add-on needs a base APCM code that month', () => {
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines: L('G0568') })).includes('APCM_ADD_ON_WITHOUT_BASE'));
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines: L('G0568'), sameMonthOtherLines: [{ code: 'G0557', renderingProviderId: 'x' }] })).includes('APCM_ADD_ON_WITHOUT_BASE'));
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines: L('G0557', 'G0568') })).includes('APCM_ADD_ON_WITHOUT_BASE'));
});
test('99445 and 99454, and 99470 and 99457, are mutually exclusive', () => {
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines: L('99445'), sameMonthOtherLines: [{ code: '99454' }] })).includes('MUTUALLY_EXCLUSIVE_SAME_PERIOD'));
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines: L('99470', '99457') })).includes('MUTUALLY_EXCLUSIVE_SAME_PERIOD'));
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines: L('99457') })).includes('MUTUALLY_EXCLUSIVE_SAME_PERIOD'));
});
test('a psychotherapy add-on plus an E/M may not claim more minutes than the documented total', () => {
  const lines = L('99349', '90833');
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines, totalMinutes: 60 })).includes('PSYCHOTHERAPY_TIME_NOT_RECORDED'), 'unrecorded is NOT CHECKED and blocks');
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines, totalMinutes: 60, psychotherapyMinutes: 20 })).includes('TIME_COUNTED_TWICE'));
  const byTime = { finalCode: '99349', finalBasis: 'time', time: { minutes: 45 } };
  assert.ok(blocks(S.scrubClaim({ ...BASE, lines, totalMinutes: 60, psychotherapyMinutes: 20, emDerivation: byTime })).includes('TIME_COUNTED_TWICE'));
  assert.ok(!blocks(S.scrubClaim({ ...BASE, lines, totalMinutes: 70, psychotherapyMinutes: 20, emDerivation: byTime })).includes('TIME_COUNTED_TWICE'));
});

// ---- routes ----
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
test('selection is billing\'s tool; the families and their fields are served, so the page names none', () => {
  const lines = serverSrc.split('\n').filter(l => l.startsWith('app.') && l.includes('/api/clinical/service-selection'));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, /requireBilling/);
  const page = fs.readFileSync(path.join(ROOT, 'public', 'clinical.html'), 'utf8');
  const panel = page.slice(page.indexOf('const CodeHelperPanel = ('), page.indexOf('// ── The claim scrub, billing\'s review surface'));
  assert.ok(!/['"`]\d{4}[0-9A-Z]['"`]|['"`][A-V]\d{4}['"`]/.test(panel), 'no code literal in the helper');
  for (const f of SR.FAMILIES) assert.ok(Array.isArray(f.FIELDS), `${f.FAMILY} declares its fields`);
});
test('the AWV history is read from GFC\'s own records on the server, never typed in', () => {
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/clinical/service-selection'"));
  assert.match(route.slice(0, 1500), /input\.priorAwvDates = \(await loadRows\('encounter_billing'\)\)/);
  assert.deepEqual(require('../serviceRules/annualWellness').FIELDS, []);
});
