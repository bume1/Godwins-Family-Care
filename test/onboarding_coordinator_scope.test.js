'use strict';
// A care coordinator's onboarding carries clinical scope awareness (owner,
// 2026-11-09): what each clinician may do, and what the coordinator never
// does, built from the capability list the app enforces.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../onboarding/track');
const CS = require('../onboarding/coordinatorScope');
const CR = require('../clinicalRoles');

const ids = (inputs) => T.buildTrack({ inputs: Object.assign({ chapter: 'F' }, inputs), record: {}, today: '2026-11-09' }).items.map(i => i.id);

test('a care coordinator gets the three clinical-scope items in Systems & Role Training; a manager does not', () => {
  const t = T.buildTrack({ inputs: { chapter: 'F', careCoordinator: true }, record: {}, today: '2026-11-09' });
  const cc = t.items.filter(i => /^F\.CC\./.test(i.id));
  assert.deepStrictEqual(cc.map(i => [i.id, i.phase]), [['F.CC.01', 'F.7'], ['F.CC.02', 'F.7'], ['F.CC.03', 'F.7']]);
  assert.ok(!ids({}).some(id => /^F\.CC\./.test(id)), 'not for anyone else on Chapter F');
  assert.match(cc[0].classificationNote, /not a Playbook row/);
  // The item shows the lines built from the capability list, not its own copy.
  assert.deepStrictEqual(cc[0].elements.map(e => e.row), CS.scopeLines());
});

test('the scope lines come from the capability list the app enforces', () => {
  const lines = CS.scopeLines();
  assert.strictEqual(lines.length, 4);
  assert.match(lines[0], /^Provider \(FNP, MD, PA\): prescribes/);
  assert.ok(!/prescribes/.test(lines[1]), 'an RN does not prescribe');
  assert.match(lines[1], /Their signature authors a note/);
  assert.match(lines[2], /adds mental health diagnoses/);
  // Every capability a role has in clinicalRoles shows in its line, and no other.
  for (const [role] of CS.ROLES) {
    const line = lines[CS.ROLES.findIndex(([r]) => r === role)];
    for (const [cap, words] of CS.WORDS) assert.strictEqual(line.includes(words), CR.ROLE_CAPABILITIES[role].includes(cap), `${role} ${cap}`);
  }
  for (const [cap, words] of CS.WORDS) {
    assert.strictEqual(CS.coordinatorDoes().includes(words), CR.ROLE_CAPABILITIES.coordinator.includes(cap), `coordinator ${cap}`);
  }
  assert.ok(CS.coordinatorNever().includes('prescribes'));
  assert.ok(CS.coordinatorNever().includes('signs billable visits'));
});

test('the coordinator acknowledges; only the office records the review and the observation', () => {
  const item = T.findItem('F.CC.01') || T.composeChecklist({ chapter: 'F', careCoordinator: true }).find(i => i.id === 'F.CC.01');
  const me = { id: 'cc', name: 'Cora', isOffice: false };
  const st = T.recordStep(item, {}, 0, me, {}, '2026-11-09');
  assert.throws(() => T.recordStep(item, st, 1, me, {}, '2026-11-09'), (e) => e.code === 'STEP_NOT_YOURS');
  const obs = T.composeChecklist({ chapter: 'F', careCoordinator: true }).find(i => i.id === 'F.CC.03');
  assert.throws(() => T.recordStep(obs, {}, 0, me, {}, '2026-11-09'), (e) => e.code === 'STEP_NOT_YOURS');
});

test('the server reads the coordinator fact from the account, and Setup never stores it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(src, /careCoordinator: accountTypes\.accountTypeOf\(who\) === 'coordinator'/);
  assert.match(src, /careCoordinator: !!\(pk && pk\.careCoordinator\)/);
  assert.strictEqual(T.normalizeInputs({ careCoordinator: 'yes' }).careCoordinator, false);
});
