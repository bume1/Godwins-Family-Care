'use strict';
// Pre-filled claim lines (owner decision, 2026-11-04): the derived E/M and
// every add-on code and modifier the rules offer, marked suggested, for a
// human biller to review. Runs the real add-on rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { prefillClaimLines, SUGGESTED_BY } = require('../claimPrefill');
const addOnRules = require('../addOnRules');
const emLevels = require('../emLevels');
const clinicalRepo = require('../clinicalRepository');

const DX = [{ code: 'M16.11' }, { code: 'M48.062' }, { code: 'R26.81' }, { code: 'Z91.81' }, { code: 'I10' }];
const run = ({ services = [], finalCode = '99350', finalBasis = 'mdm', minutes = null, continuingCare = true, modality = 'in_person', sameDay = [] } = {}) => {
  const der = { finalCode, finalBasis, mdm: { level: 'moderate' } };
  return prefillClaimLines({
    services, emDerivation: der, diagnoses: DX,
    isEmCode: (c) => emLevels.isEmCode(String(c).toUpperCase()),
    classify: clinicalRepo.classifyServiceCode,
    evaluateOffers: (lines) => addOnRules.evaluate({ lines, visit: { modality }, emDerivation: der, totalMinutes: minutes, continuingCare, justifications: {}, dos: '2026-11-03', sameDayOtherCodes: sameDay }).offers
  });
};

test('the derived E/M is added as a suggested line, linked to up to four of the visit\'s diagnoses', () => {
  const r = run();
  const em = r.services.find(s => s.code === '99350');
  assert.ok(em && em.suggested && em.suggestedBy === SUGGESTED_BY.EM);
  assert.deepEqual(em.dxLinks, ['M16.11', 'M48.062', 'R26.81', 'Z91.81']);
});

test('every add-on the rules offer is added too: G2211 for continuing care', () => {
  const r = run();
  assert.ok(r.services.some(s => s.code === 'G2211' && s.suggested && s.suggestedBy === SUGGESTED_BY.ADD_ON));
  assert.ok(!run({ continuingCare: false }).services.some(s => s.code === 'G2211'));
});

test('G0318 is added with the units the documented time supports', () => {
  const r = run({ finalBasis: 'time', minutes: 140 });
  const g = r.services.find(s => s.code === 'G0318');
  assert.ok(g, 'offered by time at 99350 past 110 minutes');
  assert.equal(g.units, 3, '110 → 1 unit, then 1 per 15: 140 minutes = 3');
});

test('modifiers are applied before add-ons, so G2211 is not added beside a modifier-25 E/M', () => {
  const r = run({ sameDay: ['99497'] });
  const em = r.services.find(s => s.code === '99350');
  assert.ok(em.modifiers.includes('25'), 'modifier 25 applied: another service shares the date');
  assert.deepEqual(em.suggestedModifiers, ['25']);
  assert.ok(!r.services.some(s => s.code === 'G2211'), 'G2211 is not paid beside -25 on a home visit');
});

test('audio-only: modifier 93 is applied to the suggested line', () => {
  const r = run({ modality: 'phone' });
  assert.ok(r.services.find(s => s.code === '99350').modifiers.includes('93'));
});

test('a person\'s lines are never touched, and a person\'s E/M is never replaced', () => {
  const human = [{ code: '99349', codeType: 'CPT4', units: 1, modifiers: [], dxLinks: ['I10'] }];
  const r = run({ services: human });
  assert.ok(!r.services.some(s => s.code === '99350'), 'no second E/M');
  const kept = r.services.find(s => s.code === '99349');
  assert.ok(kept && !kept.suggested);
  assert.deepEqual(kept.modifiers, []);
});

test('a re-confirmation replaces earlier suggestions instead of stacking them', () => {
  const first = run();
  const second = run({ services: first.services, finalCode: '99349' });
  assert.equal(second.services.filter(s => emLevels.isEmCode(s.code)).length, 1);
  assert.ok(second.services.some(s => s.code === '99349'));
  assert.equal(second.services.filter(s => s.code === 'G2211').length, 1);
});

test('saving the coding is the biller\'s acceptance: the normalizer keeps no suggested flag', () => {
  const r = run();
  const saved = clinicalRepo.buildEncounterServices(r.services, DX);
  assert.ok(!saved.error, saved.error);
  assert.ok(saved.services.every(s => !('suggested' in s)));
});

test('the confirm route writes the pre-fill, and nothing submits it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/em-derivation',");
  const body = src.slice(i, src.indexOf('\napp.', i + 10));
  assert.match(body, /claimPrefill\.prefillClaimLines\(/);
  assert.match(body, /services: fill\.services/);
  assert.ok(!/postEncounterCharges|billing-submit|claimRelease/.test(body), 'pre-filling never posts, submits or releases');
});

test('the scrub warns once per suggested line, so a biller reviews each; a saved line carries no warning', () => {
  const claimScrub = require('../claimScrub');
  const base = { phase: 'pre_post', today: '2026-11-04', encounter: { date: '2026-11-03', facts: {} }, diagnoses: DX, icd10: {}, catalog: null };
  const withS = claimScrub.scrubClaim({ ...base, lines: [{ code: '99350', modifiers: [], units: 1, dxLinks: ['I10'], suggested: true }] });
  assert.equal(withS.findings.filter(f => f.code === 'LINE_SUGGESTED').length, 1);
  const saved = claimScrub.scrubClaim({ ...base, lines: [{ code: '99350', modifiers: [], units: 1, dxLinks: ['I10'] }] });
  assert.equal(saved.findings.filter(f => f.code === 'LINE_SUGGESTED').length, 0);
});
