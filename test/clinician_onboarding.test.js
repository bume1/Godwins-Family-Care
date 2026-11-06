'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const T = require('../clinicianTrack');
const TR = require('../clinicianTraining');
const RES = require('../clinicianResources');
const PRV = require('../clinicianPrivileges');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Comments are stripped before any source scan. A guard that reads a comment as
// code proves nothing, and this repo has paid for that five times — including
// once where a comment NAMED the function it had replaced.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

const NP_HYBRID = {
  roles: ['NP'], relationship: 'HYBRID', lanes: ['CLINICAL', 'EXAMS'],
  addons: ['FNP', 'PMHNP', 'PRESCRIBES', 'CONTROLLED', 'TELEHEALTH', 'INSURED_BILLING'],
  contractors: ['VES'], payers: [{ id: 'medicare', name: 'Original Medicare' }]
};

// ===========================================================================
// COMPOSITION
// ===========================================================================
test('the checklist is the union of the applicable blocks, each item once', () => {
  const rows = T.composeChecklist(NP_HYBRID);
  assert.ok(rows.length > 80, `expected a full track, got ${rows.length}`);
  assert.strictEqual(new Set(rows.map(r => r.id)).size, rows.length,
    'an item named by two blocks must appear once');
});

test('a hybrid NP gets ONE licence verification, not two', () => {
  const rows = T.composeChecklist(NP_HYBRID);
  assert.strictEqual(rows.filter(r => r.id === 'NP-01').length, 1);
});

test('relationship narrows: an employee never sees the contractor block', () => {
  const w2 = T.composeChecklist({ roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'] });
  assert.ok(!w2.some(r => r.block === 'C99'), 'W2 must not carry C99 items');
  assert.ok(w2.some(r => r.block === 'W2'), 'W2 must carry its own block');
  const c99 = T.composeChecklist({ roles: ['NP'], relationship: '1099', lanes: ['EXAMS'] });
  assert.ok(!c99.some(r => r.block === 'W2'), '1099 must not carry W2 items');
  assert.ok(!c99.some(r => r.id === 'CORE-12'),
    'the handbook acknowledgment is never 1099-only');
});

test('a hybrid carries BOTH relationship blocks plus the separation tests', () => {
  const h = T.composeChecklist(NP_HYBRID).map(r => r.id);
  assert.ok(h.includes('W2-01') && h.includes('C99-01') && h.includes('HYB-01'));
});

test('lanes are NPs only: a physician record never generates lane items', () => {
  const md = T.buildTrack({
    inputs: { roles: ['MD_DELEGATING'], relationship: '1099', lanes: ['CLINICAL', 'EXAMS'] },
    record: { items: {} }
  });
  assert.deepStrictEqual(md.inputs.lanes, [], 'a physician has no lane');
  assert.ok(!md.rows.some(r => r.block === 'LCL' || r.block === 'EXM'));
});

test('an unknown role or add-on is DROPPED, not stored', () => {
  const i = T.normalizeInputs({ roles: ['NP', 'WIZARD'], relationship: 'CASH', addons: ['FNP', 'MAGIC'] });
  assert.deepStrictEqual(i.roles, ['NP']);
  assert.strictEqual(i.relationship, null);
  assert.deepStrictEqual(i.addons, ['FNP']);
});

test('a reserved role reads "track not yet defined" and does not error', () => {
  const d = T.trackDefined({ roles: ['RN'], relationship: 'W2' });
  assert.strictEqual(d.defined, false);
  assert.ok(/not yet defined|No clinical role/i.test(d.message));
  assert.deepStrictEqual(T.composeChecklist({ roles: ['RN'], relationship: 'W2' }), []);
});

test('a compound add-on item needs EVERY add-on, not any of them', () => {
  const th = T.findItem('TH-02');
  assert.strictEqual(th.when.addonsAll, true);
  assert.ok(!T.itemApplies(th, { roles: ['NP'], lanes: ['CLINICAL'], addons: ['TELEHEALTH'] }),
    'telehealth alone must not pull in the controlled-by-telehealth rule');
  assert.ok(T.itemApplies(th, { roles: ['NP'], lanes: ['CLINICAL'], addons: ['TELEHEALTH', 'CONTROLLED'] }));
});

test('field and driving items narrow, and default from the lanes', () => {
  const office = T.normalizeInputs({ roles: ['MD_DELEGATING'], relationship: '1099' });
  assert.strictEqual(office.field, false, 'a physician with no lane is not in the field');
  assert.strictEqual(office.driving, false);
  const exams = T.normalizeInputs({ roles: ['NP'], relationship: '1099', lanes: ['EXAMS'] });
  assert.strictEqual(exams.field, true, 'an examiner enters sites');
  assert.strictEqual(exams.driving, false, 'but is not driving to patients');
  const ids = T.composeChecklist(exams).map(r => r.id);
  assert.ok(ids.includes('CLIN-12'), 'TB screening applies to anyone in the field');
  assert.ok(!ids.includes('CLIN-14'), 'auto insurance does not apply to a non-driver');
});

// ===========================================================================
// GATES
// ===========================================================================
test('a gate the inputs do not call for is ABSENT, never open', () => {
  const g = T.gateStatus({ inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'] }, record: {} });
  assert.ok(!g.G_MD, 'an NP never sees the physician’s own gate');
  assert.ok(!g.G3, 'no controlled add-on means no controlled gate');
  assert.ok(!g.G4, 'no psych certification means no psych gate');
  assert.ok(g.G2, 'but the patient-visit gate exists');
});

test('a gate with no items left is ELIGIBLE but not OPEN until a person signs it', () => {
  const inputs = { roles: ['MD_DELEGATING'], relationship: '1099' };
  const items = {};
  T.composeChecklist(inputs).forEach(it => { items[it.id] = { status: 'complete' }; });
  const g = T.gateStatus({ inputs, record: { items } });
  assert.strictEqual(g.G_MD.eligible, true);
  assert.strictEqual(g.G_MD.opened, false,
    'eligibility is not approval: the signature is what opens a gate');
  const signed = T.gateStatus({
    inputs, record: { items, gates: { G_MD: { openedAt: '2026-11-06T10:00:00Z', openedByName: 'Kate' } } }
  });
  assert.strictEqual(signed.G_MD.opened, true);
  assert.strictEqual(signed.G_MD.openedBy, 'Kate');
});

test('G2 depends on a DIFFERENT person’s G-MD', () => {
  const items = {};
  T.composeChecklist(NP_HYBRID).forEach(it => { items[it.id] = { status: 'complete' }; });
  const noDoc = T.gateStatus({ inputs: NP_HYBRID, record: { items, gates: { G0: { openedAt: 'x' } } } });
  assert.ok(noDoc.G2.waitingOnSupervisor, 'with no physician linked, G2 is blocked by that');
  assert.strictEqual(noDoc.G2.eligible, false);
  const withDoc = T.gateStatus({
    inputs: NP_HYBRID, record: { items, gates: { G0: { openedAt: 'x' } } },
    supervisor: { name: 'Dr Who', gates: { G_MD: { opened: true } } }
  });
  assert.strictEqual(withDoc.G2.waitingOnSupervisor, null);
  assert.strictEqual(withDoc.G2.eligible, true);
});

test('a physician whose own gate closes blocks his NP again', () => {
  const items = {};
  T.composeChecklist(NP_HYBRID).forEach(it => { items[it.id] = { status: 'complete' }; });
  const g = T.gateStatus({
    inputs: NP_HYBRID, record: { items, gates: { G0: { openedAt: 'x' } } },
    supervisor: { name: 'Dr Who', gates: { G_MD: { opened: false } } }
  });
  assert.strictEqual(g.G2.eligible, false);
  assert.ok(/Dr Who/.test(g.G2.waitingOnSupervisor.reason), 'and names him');
});

test('a gate’s requirements are the items that name it — there is no second list', () => {
  const src = stripComments(read('clinicianOnboarding.js'));
  // Each gate declares which gates precede it and who it applies to, never
  // which items it needs: those come from the item library.
  assert.ok(/requiresGates/.test(src));
  assert.ok(!/requiresItems|itemsRequired/.test(src),
    'a gate must not carry its own list of required items');
  const g = T.gateStatus({ inputs: NP_HYBRID, record: {} });
  const declared = T.composeChecklist(NP_HYBRID).filter(i => (i.gates || []).includes('G3')).map(i => i.id);
  assert.deepStrictEqual(g.G3.blockedBy.map(b => b.id).sort(), declared.sort());
});

// ===========================================================================
// ITEM STATE AND CADENCE
// ===========================================================================
test('a completed item expires on its own cadence, and nothing else does', () => {
  const bls = T.findItem('CLIN-09');              // every 2 years
  const rec = { items: { 'CLIN-09': { status: 'complete', verifiedAt: '2024-01-01' } } };
  assert.strictEqual(T.itemStatus(bls, rec, '2026-11-06').status, 'expired');
  const fresh = { items: { 'CLIN-09': { status: 'complete', verifiedAt: '2026-10-01' } } };
  assert.strictEqual(T.itemStatus(bls, fresh, '2026-11-06').status, 'complete');

  const onChange = T.findItem('CORE-07');          // "on change"
  const old = { items: { 'CORE-07': { status: 'complete', completedAt: '2015-01-01' } } };
  assert.strictEqual(T.itemStatus(onChange, old, '2026-11-06').status, 'complete',
    '"on change" is an event, never a 365-day timer');
  assert.strictEqual(T.dueAgain(onChange, old.items['CORE-07']), null);
});

test('an item whose prerequisite is open reads WAITING, not NOT STARTED', () => {
  const bg = T.findItem('CLIN-11');                // started by CORE-16
  assert.strictEqual(T.itemStatus(bg, { items: {} }).status, 'waiting');
  assert.strictEqual(
    T.itemStatus(bg, { items: { 'CORE-16': { status: 'complete' } } }).status, 'not_started');
});

test('an item the office verifies waits on the office once she has submitted', () => {
  const npdb = T.findItem('CLIN-03');
  const st = T.itemStatus(npdb, { items: { 'CLIN-03': { status: 'submitted' } } });
  assert.strictEqual(st.status, 'submitted');
  assert.strictEqual(st.waitingOn, 'gfc', 'whoever uploaded it, the check is ours');
});

test('"waiting on you" is true only for the person who owes it', () => {
  const rec = { userId: 'u1', items: {} };
  const hers = T.buildTrack({ inputs: NP_HYBRID, record: rec, viewer: { id: 'u1' } });
  assert.ok(hers.rows.some(r => r.waitingOnYou === true));
  const office = T.buildTrack({ inputs: NP_HYBRID, record: rec, viewer: { id: 'admin' } });
  assert.ok(!office.rows.some(r => r.waitingOnYou === true),
    'a count that names the wrong owner is a number nobody can act on');
});

test('the recurring schedule starts only once a gate is open', () => {
  const items = { 'CLIN-09': { status: 'complete', verifiedAt: '2026-01-01' } };
  assert.strictEqual(T.ongoingSchedule({ inputs: NP_HYBRID, record: { items } }).active, false);
  const on = T.ongoingSchedule({
    inputs: NP_HYBRID, record: { items, gates: { G0: { openedAt: 'x' } } }, today: '2026-11-06'
  });
  assert.strictEqual(on.active, true);
  assert.ok(on.items.some(i => i.id === 'CLIN-09'));
});

test('a date is read in Georgia, not in the container’s zone', () => {
  // 2026-11-06T02:00:00Z is still 2026-11-05 in Georgia.
  assert.strictEqual(T.todayYmd(new Date('2026-11-06T02:00:00Z')), '2026-11-05');
});

// ===========================================================================
// THE APP VERIFIES NOTHING — the rule this module exists under
// ===========================================================================
test('no module ever calls a verification source', () => {
  for (const f of ['clinicianOnboarding.js', 'clinicianItems.js', 'clinicianTrack.js',
    'clinicianTraining.js', 'clinicianResources.js', 'clinicianPrivileges.js',
    'routes/clinicianOnboarding.js']) {
    const src = stripComments(read(f));
    assert.ok(!/\bfetch\s*\(|axios|https?\.request|node-fetch/.test(src),
      `${f} must not call out to a primary source: the app records and reminds, a person verifies`);
    for (const host of ['nursys.com', 'npiregistry', 'npdb.hrsa', 'exclusions.oig',
      'sam.gov', 'caqh', 'pecos', 'deadiversion']) {
      assert.ok(!new RegExp(`${host}[^'"\\s]*['"]\\s*\\)`, 'i').test(src),
        `${f} must not request ${host}`);
    }
  }
});

test('a verified item names a source, and the office cannot record one without a date', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  assert.ok(/VERIFY_DATE_REQUIRED/.test(src));
  assert.ok(/VERIFY_SOURCE_REQUIRED/.test(src));
  // Every item with a primary source declares which one.
  T.ITEM_LIBRARY.filter(i => i.verify).forEach(i => {
    assert.ok(T.VERIFY_SOURCES[i.verify], `${i.id} names an unknown source ${i.verify}`);
  });
});

// ===========================================================================
// THE ITEM LIBRARY'S OWN INTEGRITY
// ===========================================================================
test('every item id is unique, its block is ordered, and its prefix is live', () => {
  const ids = T.ITEM_LIBRARY.map(i => i.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate item id');
  T.ITEM_LIBRARY.forEach(i => {
    assert.ok(T.BLOCK_ORDER.includes(i.block), `${i.id} is in unordered block ${i.block}`);
    assert.ok(T.BLOCK_TITLES[i.block], `${i.block} has no title`);
    const prefix = i.id.split('-')[0];
    assert.ok(T.LIVE_PREFIXES.includes(prefix), `${i.id} uses a prefix that is not live`);
    assert.ok(!T.RESERVED_PREFIXES.includes(prefix),
      `${i.id} uses a RESERVED prefix — adding a role must never renumber an existing item`);
  });
});

test('every item names a real gate, resource, module and owner', () => {
  T.ITEM_LIBRARY.forEach(i => {
    (i.gates || []).forEach(g => assert.ok(T.GATES[g], `${i.id} names unknown gate ${g}`));
    (i.resources || []).forEach(r => assert.ok(RES.findResource(r), `${i.id} names unknown resource ${r}`));
    if (i.module) {
      assert.ok(TR.MODULE_LIBRARY.some(m => m.id === i.module), `${i.id} names unknown module ${i.module}`);
    }
    assert.ok(Object.values(T.OWNERS).includes(i.owner), `${i.id} has owner ${i.owner}`);
    if (i.ownerRole) assert.ok(T.OWNER_ROLES[i.ownerRole], `${i.id} names owner role ${i.ownerRole}`);
    assert.ok(T.CADENCES[i.repeats], `${i.id} repeats as ${i.repeats}`);
    assert.ok(Object.values(T.ACTIONS).includes(i.action), `${i.id} has action ${i.action}`);
  });
});

test('no contractor is named in the item library — the contractor is a field', () => {
  const src = stripComments(read('clinicianItems.js'));
  for (const name of ['VES', 'LSGS', 'Veterans Evaluation', 'Logistics Health', 'QTC', 'Optum']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src),
      `clinicianItems.js names the contractor ${name}; it belongs in a resource record`);
  }
  // It is a field on the inputs, and a resource can be tagged with it.
  assert.ok(T.normalizeInputs({ contractors: ['VES'] }).contractors.includes('VES'));
});

test('no item a person reads assumes their gender', () => {
  // These items are generic: the same row is read by the clinician it is about
  // and by the office, and the physician's track uses the same library. The
  // playbook is written about one named clinician, so the wording arrived
  // gendered and "Malpractice cover confirmed for HER actual scope" was shown
  // to that clinician on her own screen, about herself.
  const fields = ['title', 'detail', 'proof', 'requiresWhen'];
  const gendered = /\b(her|hers|she|his|him|he)\b/i;
  T.ITEM_LIBRARY.forEach(i => fields.forEach(f => {
    const v = i[f];
    if (typeof v !== 'string') return;
    assert.ok(!gendered.test(v),
      `${i.id}.${f} assumes a gender: "${v.slice(0, 80)}"`);
  }));
  // The same for anything the training library and the privilege list show.
  TR.MODULE_LIBRARY.forEach(m => ['title', 'detail'].forEach(f => {
    if (typeof m[f] === 'string') {
      assert.ok(!gendered.test(m[f]), `${m.id}.${f} assumes a gender: "${m[f]}"`);
    }
  }));
  PRV.ALL_PRIVILEGES.forEach(p => {
    assert.ok(!gendered.test(p.title), `privilege ${p.id} assumes a gender`);
  });
});

test('nothing transmits to Gusto, and no screen may imply it does', () => {
  for (const f of ['clinicianItems.js', 'routes/clinicianOnboarding.js',
    'public/clinician-onboarding.html']) {
    const src = stripComments(read(f));
    assert.ok(!/gusto\.com|api\.gusto|gustoApi/i.test(src),
      `${f} must not reach Gusto: it is the system of record and nothing here transmits to it`);
  }
});

// ===========================================================================
// TRAINING
// ===========================================================================
test('every check question carries a manual reference — none is invented', () => {
  let n = 0;
  TR.MODULE_LIBRARY.forEach(m => (m.checks || []).forEach(c => {
    n++;
    assert.ok(c.prompt && c.answer, `${m.id} has an incomplete check`);
    assert.ok(/Manual \d/.test(String(c.source || '')),
      `${m.id} has a check with no manual reference: "${c.prompt}". Clinical questions come from a written SOP, never from this file's imagination.`);
  }));
  assert.ok(n >= 20, `expected the SOP questions to be seeded, found ${n}`);
});

test('a module with no questions is flagged as a gap, never as an easy module', () => {
  const t = TR.buildTraining({ inputs: NP_HYBRID, progress: {} });
  assert.ok(t.counts.checksMissing > 0, 'the gaps exist and must be visible');
  const missing = t.rows.filter(r => r.checksMissing);
  assert.ok(missing.every(r => r.checkCount === 0));
});

test('a missed check-back sends her back to the module', () => {
  const mod = TR.MODULE_LIBRARY.find(m => m.id === 'TRN-003');
  const hit = TR.moduleStatus(mod,
    { 'TRN-003': { completedAt: '2026-11-01', rechecks: { 3: { at: 'x', correct: true } } } }, '2026-11-06');
  assert.strictEqual(hit.status, 'complete');
  const miss = TR.moduleStatus(mod,
    { 'TRN-003': { completedAt: '2026-11-01', rechecks: { 3: { at: 'x', correct: false } } } }, '2026-11-06');
  assert.strictEqual(miss.needsRedo, true);
});

test('check-backs fall on day 3, 10, 30 and 90 from completion', () => {
  const mod = TR.MODULE_LIBRARY.find(m => m.id === 'TRN-003');
  const st = TR.moduleStatus(mod, { 'TRN-003': { completedAt: '2026-11-01' } }, '2026-11-06');
  assert.deepStrictEqual(st.rechecks.map(r => r.dueAt),
    ['2026-11-04', '2026-11-11', '2026-12-01', '2027-01-30']);
  assert.deepStrictEqual(st.rechecks.filter(r => r.due).map(r => r.day), [3]);
});

test('a module narrows on the same inputs an item does', () => {
  const psych = TR.MODULE_LIBRARY.find(m => m.id === 'TRN-211');
  assert.ok(!TR.moduleApplies(psych, { lanes: ['CLINICAL'], addons: ['FNP'] }));
  assert.ok(TR.moduleApplies(psych, { lanes: ['CLINICAL'], addons: ['PMHNP'] }));
});

// ===========================================================================
// RESOURCES
// ===========================================================================
test('a signature records the document version, and a bumped label re-prompts', () => {
  const res = RES.findResource('RES-05');
  assert.strictEqual(RES.signatureStale(res, { version: res.version }), false);
  assert.strictEqual(RES.signatureStale(res, { version: 'v1.0' }), true,
    'a newer version label must re-prompt');
  assert.strictEqual(RES.signatureStale(res, {}), true, 'no version recorded is unknown');
});

test('a typo fix does not re-prompt: staleness reads the LABEL, not the modified time', () => {
  const res = RES.findResource('RES-05');
  assert.strictEqual(
    RES.signatureStale(res, { version: res.version, driveModifiedTime: '2030-01-01T00:00:00Z' }),
    false, 'a changed modified time with the same label must not re-prompt a whole team');
  const src = stripComments(read('clinicianResources.js'));
  const fn = src.slice(src.indexOf('function signatureStale'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/driveModifiedTime/.test(body),
    'signatureStale must not compare the modified time');
});

test('a contractor-tagged document shows only for that contractor', () => {
  const ves = RES.resourcesFor({ lanes: ['EXAMS'], contractors: ['VES'] }).map(r => r.id);
  assert.ok(ves.includes('RES-20') && !ves.includes('RES-21'));
  const lsgs = RES.resourcesFor({ lanes: ['EXAMS'], contractors: ['LSGS'] }).map(r => r.id);
  assert.ok(lsgs.includes('RES-21') && !lsgs.includes('RES-20'));
});

test('a document with no link is declared and unavailable, never omitted', () => {
  const b = RES.buildResources({ inputs: { lanes: ['CLINICAL'] } });
  const sops = b.rows.find(r => r.id === 'RES-09');
  assert.ok(sops, 'the Clinical SOPs row must exist even with no link: hiding it hides the gap');
  assert.strictEqual(sops.available, false);
  assert.strictEqual(sops.unavailableReason, 'not_uploaded');
});

test('an unreachable document never blocks: it is flagged and says who to ask', () => {
  const b = RES.buildResources({
    inputs: { lanes: ['CLINICAL'] }, accessFailures: { 'RES-08': { at: 'x' } }
  });
  const r = b.rows.find(x => x.id === 'RES-08');
  assert.strictEqual(r.available, false);
  assert.ok(/Ask .* for access/i.test(r.unavailableMessage));
});

test('every resource names a real step and action, and a real playbook item', () => {
  RES.RESOURCES.forEach(r => {
    assert.ok(RES.STEP_TITLES[r.step], `${r.id} is in unknown step ${r.step}`);
    assert.ok(RES.ACTION_LABELS[r.action], `${r.id} has unknown action ${r.action}`);
    if (r.playbookItem) {
      assert.ok(T.findItem(r.playbookItem), `${r.id} names unknown item ${r.playbookItem}`);
    }
    if (r.module) {
      assert.ok(TR.MODULE_LIBRARY.some(m => m.id === r.module), `${r.id} names unknown module ${r.module}`);
    }
  });
});

// ===========================================================================
// PRIVILEGING
// ===========================================================================
test('a privilege outside the agreement cannot be granted, and the refusal says so', () => {
  const inputs = { lanes: ['CLINICAL'], addons: ['PRESCRIBES'] };
  const list = PRV.generateList({ inputs, allowances: ['asmt_hp'], agreement: { version: 'v1' } });
  const out = PRV.applyDecision(list, { privilegeId: 'rx_noncontrolled', status: 'granted' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'PRIVILEGE_NOT_IN_AGREEMENT');
  assert.ok(/Amend the agreement/i.test(out.error), 'it must say what to do instead');
});

test('narrowing needs a reason; granting back inside the agreement does not', () => {
  const inputs = { lanes: ['CLINICAL'] };
  const list = PRV.generateList({ inputs, allowances: ['asmt_hp'], agreement: { version: 'v1' } });
  assert.strictEqual(
    PRV.applyDecision(list, { privilegeId: 'asmt_hp', status: 'narrowed' }).code,
    'PRIVILEGE_REASON_REQUIRED');
  const ok = PRV.applyDecision(list, { privilegeId: 'asmt_hp', status: 'narrowed', reason: 'why' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(PRV.applyDecision(ok.list, { privilegeId: 'asmt_hp', status: 'granted' }).ok, true);
});

test('the default is the FULL scope of the agreement, bar what the playbook withholds', () => {
  const inputs = { lanes: ['CLINICAL'] };
  const all = PRV.applicablePrivileges(inputs).map(p => p.id);
  const list = PRV.generateList({ inputs, allowances: all, agreement: { version: 'v1' } });
  const joint = list.rows.find(r => r.id === 'proc_joint_injection');
  assert.strictEqual(joint.status, 'narrowed', 'joint injections are listed and withheld by default');
  assert.ok(joint.reason, 'and carry a reason');
  const others = list.rows.filter(r => r.id !== 'proc_joint_injection');
  assert.ok(others.every(r => r.status === 'granted'), 'everything else defaults to granted');
});

test('a privilege the inputs cannot reach is not applicable, not a narrowing decision', () => {
  const noPsych = PRV.applicablePrivileges({ lanes: ['CLINICAL'], addons: [] }).map(p => p.id);
  assert.ok(!noPsych.includes('psy_eval'));
  assert.ok(!noPsych.includes('rx_controlled_3_5'));
  const psych = PRV.applicablePrivileges({ lanes: ['CLINICAL'], addons: ['PMHNP'] }).map(p => p.id);
  assert.ok(psych.includes('psy_eval'));
});

test('an amended agreement flags the list for review automatically', () => {
  const inputs = { lanes: ['CLINICAL'] };
  const list = Object.assign(
    PRV.generateList({ inputs, allowances: ['asmt_hp'], agreement: { version: 'v1' } }),
    { coSignedAt: '2026-01-01T00:00:00Z' });
  assert.strictEqual(PRV.needsReview(list, { agreementVersion: 'v1', today: '2026-11-06' }).review, false);
  const amended = PRV.needsReview(list, { agreementVersion: 'v2', today: '2026-11-06' });
  assert.strictEqual(amended.review, true);
  assert.strictEqual(amended.reason, 'agreement_amended');
});

test('re-privileging falls due at three years', () => {
  const inputs = { lanes: ['CLINICAL'] };
  const list = Object.assign(
    PRV.generateList({ inputs, allowances: ['asmt_hp'], agreement: { version: 'v1' } }),
    { coSignedAt: '2020-01-01T00:00:00Z' });
  const r = PRV.needsReview(list, { agreementVersion: 'v1', today: '2026-11-06' });
  assert.strictEqual(r.review, true);
  assert.strictEqual(r.reason, 'three_years_elapsed');
});

test('enforcement is deliberately NOT wired, and the file says why', () => {
  const src = read('clinicianPrivileges.js');
  assert.ok(/ENFORCEMENT IS NOT WIRED IN THIS CHANGE, DELIBERATELY/.test(src),
    'the reason must stay recorded, or a later session reads it as an oversight');
  // Nothing consults the privilege list for a permission decision yet.
  const roles = stripComments(read('clinicalRoles.js'));
  assert.ok(!/clinicianPrivileges/.test(roles),
    'clinicalRoles.js must not read the privilege list until the owner has decided the default');
});

// ===========================================================================
// THE ROUTES AND THE PAGE
// ===========================================================================
test('credentialing is office work: a clinician cannot verify or sign a gate open', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  // Read from each admin route's declaration to the start of its handler, so a
  // route whose middleware wraps onto the next line is judged the same as one
  // that fits on a single line. A line-only check could not tell a wrapped
  // route from an ungated one, which is a guard that proves nothing.
  const decl = /router\.(?:get|put|post)\((['"])\/api\/clinician-onboarding\/admin[^'"]*\1/g;
  const admin = [];
  let m;
  while ((m = decl.exec(src)) !== null) {
    const window = src.slice(m.index, m.index + 400);
    const handlerAt = window.indexOf('=>');
    admin.push({ route: m[0], head: window.slice(0, handlerAt < 0 ? 400 : handlerAt) });
  }
  assert.ok(admin.length >= 8, `expected the admin half, found ${admin.length} routes`);
  admin.forEach(a => assert.ok(/requireOffice/.test(a.head),
    `an admin route is not behind requireOffice: ${a.route}`));
  // The gate check is admin-or-manager, never the clinical write gate: a
  // provider must not be able to sign their own gate open.
  assert.ok(/const isOffice = \(u\) =>[^\n]*'admin'/.test(src));
  assert.ok(!/requireClinicalWrite/.test(src));
});

test('no /me route takes a user id', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  const me = src.match(/router\.(get|put|post)\(['"]\/api\/clinician-onboarding\/me[^'"]*['"]/g) || [];
  assert.ok(me.length >= 6, `expected her own routes, found ${me.length}`);
  me.forEach(r => assert.ok(!/:userId/.test(r),
    `a /me route must resolve the clinician from the session: ${r}`));
});

test('the page restates no vocabulary of its own', () => {
  const page = stripComments(read('public/clinician-onboarding.html'));
  const body = page.slice(page.indexOf('text/babel'));
  // Every role, relationship, lane, add-on, item, module, resource and
  // privilege comes from the server. A screen that keeps its own copy drifts
  // from the validator that refuses an answer it did not offer.
  for (const token of ['MD_DELEGATING', 'INSURED_BILLING', 'PMHNP', 'STATE_NC',
    'CORE-01', 'CLIN-01', 'TRN-001', 'RES-01', 'proc_joint_injection']) {
    assert.ok(!new RegExp(token).test(body),
      `the page names ${token} itself; it must come from /meta`);
  }
  // RES-05 and RES-09 appear only in the probe, never in the page.
  assert.ok(/clinician-onboarding\/meta/.test(body), 'the page must read the served vocabulary');
});

test('the page takes its bearer token from the helper, never an inline read', () => {
  const page = read('public/clinician-onboarding.html');
  const body = page.slice(page.indexOf('text/babel'));
  const bearers = body.match(/Bearer \$\{[^}]+\}/g) || [];
  assert.ok(bearers.length > 0);
  bearers.forEach(b => assert.ok(/getToken\(\)/.test(b),
    `a Bearer header must go through getToken(): ${b}`));
  assert.ok(!/localStorage\.getItem\(['"]token['"]\)/.test(body),
    'the retired lab-era token key must not be read');
});

test('every component is at module scope (a nested one remounts on each keystroke)', () => {
  const page = read('public/clinician-onboarding.html');
  const body = page.slice(page.indexOf('text/babel'));
  const lines = body.split('\n');
  lines.forEach((l, i) => {
    // A component declaration (capitalised, arrow returning JSX) must start at
    // column 0. Indented means it sits inside another component.
    if (/^\s+const [A-Z][A-Za-z0-9]* = \(\{?[^)]*\}?\) => \(?$/.test(l)
      && /^\s+/.test(l)) {
      assert.fail(`component declared inside another at line ${i + 1}: ${l.trim()}`);
    }
  });
});

test('the two collections are claimed in the registry', () => {
  const { COLLECTION_REGISTRY } = require('../dataMigration');
  ['clinician_onboarding', 'clinician_onboarding_events'].forEach(k => {
    const row = COLLECTION_REGISTRY.find(r => r.key === k);
    assert.ok(row, `${k} must be claimed or the build fails on an unhandled collection`);
    assert.strictEqual(row.phi, false,
      'employment and credentialing data about staff, not patient PHI');
  });
});

test('the audit trail never carries a reason text or a signature image', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  const logs = src.match(/logActivity\([^;]*\)/g) || [];
  assert.ok(logs.length >= 8);
  logs.forEach(l => {
    assert.ok(!/\breason\b|signaturePng|typedName/.test(l),
      `an activity row must not carry free text or a signature: ${l.slice(0, 110)}`);
  });
});
