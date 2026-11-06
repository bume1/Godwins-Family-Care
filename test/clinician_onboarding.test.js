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
// ⚠️ A `/*` INSIDE A STRING IS NOT A COMMENT, and taking it for one is the
// same mistake as reading a comment as code — the stripper's own failure mode,
// pointed at itself. `public/admin-hub.html` carries
// accept="image/*,application/pdf"; the naive version read that `/*` as an
// opener and silently deleted 1,666 characters of real JSX up to the next
// `*/`, so an assertion about code inside that window could never pass however
// correct the code was. Found by a guard that failed against markup plainly
// present in the file.
//
// A real comment opener never follows a letter or a digit, so those are hidden
// from the comment pass and put back afterwards. Not a tokenizer; enough to
// tell an attribute value from a comment, and it changes nothing for every
// other file this helper reads.
const NOT_A_COMMENT = '\u0000*';
const stripComments = (src) => src
  .replace(/([A-Za-z0-9])\/\*/g, '$1' + NOT_A_COMMENT)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
  .split(NOT_A_COMMENT).join('/*');

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

// ===========================================================================
// WHAT A CLINICIAN READING HER OWN SCREEN IS NEVER SHOWN
//
// Every field below is the office's own working vocabulary — the item's
// playbook id, the evidence to file, the primary source it is checked
// against, the internal role that owns it, the gate codes, and the modules
// whose check questions WE have not written yet. None of it is a secret; all
// of it reads as somebody else's admin tool in the middle of her onboarding.
//
// The server strips them (forClinician) AND the page guards on the audience.
// Two layers on purpose: a field restored to her payload still must not
// render, and a pill added by a later session still has no field to read.
// ===========================================================================

test('the hidden-field list is applied to her payload and not to the office view', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));

  // The strip runs inside assemble, so it cannot be forgotten at a call site.
  assert.match(src, /return audience === 'office' \? payload : forClinician\(payload\)/,
    'assemble itself decides, or the sixteenth call site leaks');

  // Narrower by default: a route added later that forgets to say its audience
  // shows the office too little, which somebody notices, rather than showing a
  // clinician the credentialing file, which nobody notices.
  assert.match(src, /audience = 'clinician'/,
    'the default audience must be the narrow one');

  ['proof', 'verify', 'alsoVerify', 'ownerRole', 'ownerRoleLabel', 'gates']
    .forEach(f => assert.ok(
      new RegExp(`CLINICIAN_HIDDEN_ITEM_FIELDS = \\[[^\\]]*'${f}'`, 's').test(src),
      `${f} is office vocabulary and must be stripped from her payload`));

  ['checksMissing', 'feedsGate'].forEach(f => assert.ok(
    new RegExp(`CLINICIAN_HIDDEN_MODULE_FIELDS = \\[[^\\]]*'${f}'`, 's').test(src),
    `${f} is our own backlog and must be stripped from her payload`));

  // Each of the three places a row reaches her must be stripped. byPhase,
  // upNext and rows are the SAME objects in the builders' output, so the deep
  // copy is what makes stripping one not strip the others by luck.
  assert.match(src, /JSON\.parse\(JSON\.stringify\(payload\)\)/);
  ['p.track.rows', 'p.training.rows', 'p.training.upNext']
    .forEach(k => assert.ok(src.includes(k), `${k} must be stripped`));
  assert.match(src, /ph\.modules = stripEach\(ph\.modules, CLINICIAN_HIDDEN_MODULE_FIELDS\)/);
  assert.match(src, /delete p\.training\.counts\.checksMissing/,
    'the count of modules missing questions is our backlog figure, not her progress');
});

test('"Questions not written yet" is the office\'s own gap and never reaches her screen', () => {
  const page = stripComments(read('public/clinician-onboarding.html'));

  // ModuleCard is her card. The office reads training as a table in
  // OfficeDetail, which is where the backlog belongs — and still has it.
  const card = page.slice(page.indexOf('const ModuleCard'), page.indexOf('const RecheckCard'));
  assert.ok(card.length > 400, 'ModuleCard must be found, or this guard reads nothing');
  assert.ok(!/checksMissing/.test(card),
    'ModuleCard renders on her own screen: our unwritten questions have no place on it');
  assert.ok(!/feedsGate/.test(card), 'raw gate codes are not her vocabulary');
  assert.ok(!/not written yet|no questions yet/i.test(card),
    'a module with nothing to answer is not a module we have failed to finish');

  // Not deleted from the product — moved to the audience it belongs to.
  const office = page.slice(page.indexOf('const OfficeDetail'));
  assert.ok(/checksMissing/.test(office),
    'the office must still see which modules need their questions written');
});

test('the page draws office vocabulary only for the office', () => {
  const page = stripComments(read('public/clinician-onboarding.html'));
  const itemRow = page.slice(page.indexOf('const ItemRow'), page.indexOf('const Checklist'));
  assert.ok(itemRow.length > 400, 'ItemRow must be found');

  assert.match(itemRow, /\{office && <span className="sub"[^>]*>\{row\.id\}/,
    'the playbook id is a credentialing reference, not a thing she reads');
  assert.match(itemRow, /\{office && row\.proof && !done/,
    '"Proof: dated screenshot" is what the office files');
  assert.match(itemRow, /\{office && \(row\.gates \|\| \[\]\)\.length > 0/,
    '"Blocks G0" is a sentence about our data model');
  assert.match(itemRow, /\{office && row\.verify &&/,
    'the primary source an item is verified against is the office\'s own step');
  assert.match(itemRow, /const office = mode === 'office'/,
    'the audience comes from mode, which the call sites already pass');

  // A gate card shows her the gate's TITLE for what it waits on; the office
  // works in codes. `office` and `canOpen` stay separate props: one is the
  // audience, the other a capability.
  const gate = page.slice(page.indexOf('const GateCard'), page.indexOf('const PayerGateCard') + 1
    || page.indexOf('const MyWizard'));
  assert.match(gate, /office\s*\n?\s*\?\s*\(gate\.blockedByGates \|\| \[\]\)/,
    'the office reads gate codes');
  assert.match(gate, /gate\.blockedByGateTitles/, 'she reads gate titles');
  assert.match(gate, /\{office && <strong>\{b\.id\} <\/strong>\}/,
    'the ids of the things a gate waits on are the office\'s reference');
});

test('every gate says what it opens without talking about the reader in the third person', () => {
  // Same class as the gendered-pronoun sweep: "Their app and EHR accounts" is
  // a sentence written about her, shown to her. The strings are shared by both
  // audiences, so they are written to work in either.
  Object.values(T.GATES).forEach(g => {
    assert.ok(!/\b(their|theirs|her|hers|his|she|he)\b/i.test(g.opens),
      `gate ${g.id} describes the reader in the third person: "${g.opens}"`);
  });
});

test('a gate names its unmet prerequisites in words as well as codes', () => {
  const gates = T.gateStatus({
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] },
    record: {}
  });
  assert.deepStrictEqual(gates.G2.blockedByGates, ['G0']);
  assert.deepStrictEqual(gates.G2.blockedByGateTitles, [T.GATES.G0.title]);
  assert.ok(!/^G\d/.test(gates.G2.blockedByGateTitles[0]),
    'a title is what a person reads, never the code');
});

test('her own onboarding opens with the same welcome the caregiver packet gives', () => {
  const page = stripComments(read('public/clinician-onboarding.html'));
  assert.match(page, /const OnboardingHero/);
  assert.match(page, /url\(\/banners\/banner-clinician\.jpg\)/,
    'one file is the photo; replacing it changes the hero with no code moving');
  assert.ok(fs.existsSync(path.join(root, 'public/banners/banner-clinician.jpg')),
    'the banner file must exist, or the front door is a broken image');

  // The hero renders on HER view, both when her track is set up and when it is
  // not — day one, before the office has built it, is exactly when somebody
  // needs welcoming — and never over the office looking at someone else.
  const wiz = page.slice(page.indexOf('const MyWizard'), page.indexOf('const InputsForm'));
  assert.strictEqual((wiz.match(/<OnboardingHero/g) || []).length, 2,
    'the hero belongs on both of her states');
  const officeDetail = page.slice(page.indexOf('const OfficeDetail'));
  assert.ok(!/<OnboardingHero/.test(officeDetail),
    'credentialing somebody else is not being welcomed to the company');

  // The same mechanism as caregiver.html's packet hero, so the two front doors
  // into this company do not look like two different companies.
  ['.whero{', '.whero .img{', '.whero .scrim{', '.whero .rule{'].forEach(sel => {
    assert.ok(page.includes(sel), `${sel} must carry the shared hero styling`);
    assert.ok(read('public/caregiver.html').includes(sel),
      `${sel} must still match the caregiver packet it was taken from`);
  });
});

test('the supervisor block does not describe the reader to herself', () => {
  // She reads this on her own gate card. Same class as the gate `opens` text
  // and the gendered pronouns: one string, both audiences, so it is written
  // to work in either rather than branched — a branch is two strings that
  // drift, and only one of them gets re-read.
  const gates = T.gateStatus({
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] },
    record: {}, supervisor: null
  });
  const reason = gates.G2.waitingOnSupervisor.reason;
  assert.ok(!/this clinician|their|her|his|she|he\b/i.test(reason), reason);
  assert.match(reason, /supervising physician/i, 'it must still say what is missing');
});

test('the header bar is not padded for the page body', () => {
  // `.wrap` carries 72px of bottom padding so the last card clears the fold.
  // The header reuses it, so without the override the navy bar renders 72px
  // taller than its own content — a band of dead colour under the brand that
  // reads fine in CSS and wrong on screen.
  const page = read('public/clinician-onboarding.html');
  assert.match(page, /header\.top \.wrap\{[^}]*padding-bottom:0/);
});

test('an item tells her what to do, not why we designed it that way', () => {
  // `detail` is read on her own checklist. Our reasoning about why two
  // agreements are kept apart, or why a field is shaped as it is, belongs in a
  // code comment: it is true, it is not secret, and it is not an instruction.
  // Caught by READING the rendered checklist, which is the only way this class
  // of thing ever shows up.
  const rationale = /\bdeliberately\b|\bis the exact thing\b|\bwhich is why\b|\bthe whole point\b|\bwe do not\b|\bthis app\b|\bis what makes\b/i;
  T.ITEM_LIBRARY.forEach(i => {
    if (!i.detail) return;
    assert.ok(!rationale.test(i.detail),
      `${i.id} explains our design decision where it should say what to do: "${i.detail.slice(0, 90)}"`);
  });
});

// ===========================================================================
// HER DOCUMENTS, AND THE NOTES EITHER SIDE CAN SEND
// ===========================================================================

test('a proof upload writes the SAME store User Management already reads', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  const block = src.slice(src.indexOf('items/:itemId/proof'), src.indexOf('items/:itemId/proof/:fileId'));

  assert.match(block, /db\.set\('caregiver_documents', docRows\)/,
    'one store, two doors: the office should not have to know which door a file came through');
  assert.match(block, /kind: 'clinician_onboarding'/);
  assert.match(block, /caregiver_id: String\(req\.user\.id\)/,
    'filed under the person, which is what the documents card lists by');
  assert.match(block, /note: `Onboarding: \$\{item\.title\}`/,
    'or every one of her uploads reads "Clinician onboarding document"');
  assert.match(block, /status: needsOfficeCheck \? 'received' : 'accepted'/,
    'the row mirrors the item rather than inventing a second rule');
  assert.match(block, /documentId: docId/,
    'the two must point at one file, or the wizard and User Management can disagree');

  // The kind has to be in the served catalog, or the document lists as a raw
  // slug and the office cannot tell what it is.
  const cg = stripComments(read('routes/caregiver.js'));
  assert.match(cg, /kind: 'clinician_onboarding', label: 'Clinician onboarding document'/);
});

test('the documents card renders for a clinician, not only a caregiver', () => {
  const hub = stripComments(read('public/admin-hub.html'));
  assert.match(hub, /\{\(formData\.role === 'vendor' \|\| formData\.hasClinicalAccess\) && editingUser && \(/,
    'it sat inside the vendor-only block, so a clinician\'s paperwork was reachable from nowhere here');
  assert.strictEqual((hub.match(/<CaregiverDocsSection/g) || []).length, 1,
    'one card, or the two copies drift');
  assert.match(hub, /\{d\.note && \(/,
    'the note is what names which checklist item a clinician\'s file answers');
});

test('an attached file can actually be opened, by her and by the office', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  // Her own, by her own session: no userId in the path, so there is nothing
  // to widen. Build-enforced alongside the other /me routes.
  assert.match(src, /router\.get\('\/api\/clinician-onboarding\/me\/items\/:itemId\/proof\/:fileId'/);
  assert.match(src, /logActivity\('clinician_onboarding_proof_read'/,
    'through the app, never a Drive link, so every read is audited');
  // A missing row and Google refusing a file are different facts.
  assert.match(src, /PROOF_FILE_MISSING/);
  assert.match(src, /PROOF_STORAGE_UNAVAILABLE/);
  assert.match(src, /contentDisposition\('inline', file\.name/,
    'the header is built by the one helper, or a filename with a narrow no-break space 500s');

  const page = stripComments(read('public/clinician-onboarding.html'));
  const itemRow = page.slice(page.indexOf('const ItemRow'), page.indexOf('const Checklist'));
  assert.ok(!/files? attached\s*$/m.test(itemRow),
    'a count with nothing to click is a capability nobody can reach');
  assert.match(itemRow, /onClick=\{\(\) => openProof\(row\.id, f\)\}/);
  // A plain <a href> is a navigation and carries no Authorization header.
  assert.ok(!/<a[^>]+href=\{[^}]*proof/.test(itemRow),
    'a download is a request like any other and needs the token, in the HEADER');
  assert.match(page, /Authorization: `Bearer \$\{getToken\(\)\}` \}\s*\}\);\s*\n\s*if \(!res\.ok\)/,
    'fetched with the token, handed over as a blob');
});

test('notes are append-only and two-sided, so neither side overwrites the other', () => {
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  assert.match(src, /notes: \(prev\.notes \|\| \[\]\)\.concat/,
    'APPEND. One shared `note` string meant whoever saved last silently won');
  assert.match(src, /router\.post\('\/api\/clinician-onboarding\/me\/items\/:itemId\/notes'/);
  assert.match(src, /router\.post\('\/api\/clinician-onboarding\/admin\/:userId\/items\/:itemId\/notes'/);
  assert.match(src, /const addNote = async \(req, res, \{ userId, fromOffice \}\)/,
    'one handler, two gates: a note that reads differently by sender is two features');
  const noteObj = src.slice(src.indexOf('notes: (prev.notes || []).concat'),
    src.indexOf('notes: (prev.notes || []).concat') + 260);
  assert.match(noteObj, /fromOffice: !!fromOffice/,
    `each NOTE says which side wrote it: ${noteObj.slice(0, 180)}`);
  assert.match(noteObj, /byName: req\.user\.name/, 'and who, by name');
  assert.match(noteObj, /at: nowIso\(\)/, 'and when');

  // THAT a note was written, never what it said.
  const ev = src.slice(src.indexOf("type: 'note_added'"), src.indexOf("type: 'note_added'") + 400);
  assert.ok(!/\btext\b/.test(ev), `an audit row is not a second copy of the conversation: ${ev.slice(0, 120)}`);

  // Both audiences render the thread; `notes` is NOT in the hidden list.
  assert.ok(!/CLINICIAN_HIDDEN_ITEM_FIELDS = \[[^\]]*'notes'/s.test(src),
    'she must read what the office wrote to her');
  const page = stripComments(read('public/clinician-onboarding.html'));
  assert.match(page, /const NoteThread = /);
  assert.match(page, /<NoteThread row=\{row\} office=\{office\} onAdd=\{onAddNote\} \/>/);
});

test('a note reaches the checklist row both sides read', () => {
  const rows = T.buildTrack({
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] },
    record: { items: { 'CORE-01': { notes: [{ id: 'n1', text: 'Sent Tuesday', fromOffice: false }] } } }
  }).rows;
  const r = rows.find(x => x.id === 'CORE-01');
  assert.strictEqual(r.notes.length, 1);
  assert.strictEqual(r.notes[0].text, 'Sent Tuesday');
  // An item nobody has written on carries an empty list, never undefined, or
  // the page has to guard every read.
  assert.deepStrictEqual(rows.find(x => x.id === 'CORE-03').notes, []);
});

test('a document to complete outside the app says where to send it back', () => {
  // The resources list had no file input at all, so "complete it outside the
  // app, then upload it" was a dead end. It points at the checklist item that
  // owns it rather than growing a second upload path with its own copy of the
  // byte-typing and the Drive failure rule.
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  assert.match(src, /r\.uploadItem = owner \? \{ id: owner\.id, title: owner\.title \} : null/);
  const page = stripComments(read('public/clinician-onboarding.html'));
  assert.match(page, /!signable && res\.uploadItem/);

  // Every resource that needs a file back must have an item that can take one,
  // or the pointer points nowhere.
  const needsFile = RES.RESOURCES.filter(r =>
    ['COMPLETE_EXTERNAL', 'UPLOAD_CERTIFICATE'].includes(r.action));
  assert.ok(needsFile.length > 0, 'or this guard reads nothing');
  needsFile.forEach(r => {
    const owner = T.ITEM_LIBRARY.find(it => (it.resources || []).includes(r.id));
    assert.ok(owner, `${r.id} asks for a file back and no checklist item owns it`);
  });
});

test('the comment stripper does not eat code hiding behind a string', () => {
  // The guard's own failure mode. `image/*` in an accept attribute opened a
  // fake block comment and 1,666 characters of real JSX in admin-hub.html went
  // with it — so a correct assertion failed against markup plainly in the file.
  // A source scan that silently loses code proves as little as one that reads a
  // comment as code.
  const sample = [
    '<input accept="image/*,application/pdf" />',
    'const keep = 1;',
    '/* a real comment */',
    'const alsoKeep = 2;'
  ].join('\n');
  const out = stripComments(sample);
  assert.ok(out.includes('const keep = 1;'), out);
  assert.ok(out.includes('const alsoKeep = 2;'), 'the real comment must not swallow what follows');
  assert.ok(!out.includes('a real comment'), 'a real comment must still go');
  assert.ok(out.includes('image/*'), 'and the attribute must survive unchanged');

  // Proven against the file that actually broke, not only a fixture.
  const hub = stripComments(read('public/admin-hub.html'));
  assert.ok(hub.length > read('public/admin-hub.html').length * 0.9,
    'losing a tenth of the file is the symptom this exists to catch');
});

test('a proof upload types the file by its bytes and does not refuse every one', () => {
  // ⚠️ REGRESSION. `detectFileType` returns a MIME STRING, and this route read
  // `sniffed.ext` — undefined on a string — so `ext` was always null and every
  // single upload came back PROOF_TYPE_UNSUPPORTED. The attach-a-file
  // capability had never worked. Reading the route could not show it; posting
  // a real PNG through it did.
  const src = stripComments(read('routes/clinicianOnboarding.js'));
  const block = src.slice(src.indexOf('items/:itemId/proof'), src.indexOf('db.set(\'caregiver_documents\''));
  assert.match(block, /const mime = detectFileType \? detectFileType\(req\.file\.buffer\) : null/);
  assert.match(block, /EXT_FOR_MIME\[mime\]/,
    'the sniffer answers a mime type; an extension has to be derived from it');
  assert.ok(!/sniffed\.ext/.test(block),
    'reading .ext off a string is how every upload got refused');

  // The server's own sniffer must still answer what this map expects, or the
  // two drift and uploads start being refused again in silence.
  const server = read('server.js');
  ['application/pdf', 'image/png', 'image/jpeg'].forEach(m => {
    assert.ok(server.includes(`return '${m}'`), `detectFileType must still answer ${m}`);
    assert.ok(block.includes(`'${m}'`), `and the route must still map ${m}`);
  });
});

// ===========================================================================
// THE DOCUMENT PATH, DRIVEN. Drive is unreachable from a sandbox, so the live
// probe can only prove the upload is REFUSED when it is unconfigured (which is
// the designed behaviour). The route is mounted here with a fake Drive and
// driven over real HTTP, so what is asserted is the row that was stored — the
// `sniffed.ext` bug was invisible to every source scan and showed itself the
// first time a real PNG went through.
// ===========================================================================

const express = require('express');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const mountOnboarding = async (t, { user, inputs }) => {
  const store = {};
  const db = {
    get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null),
    set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); }
  };
  const driveStub = {
    uploadCaregiverDocumentFile: async (folder, name, buf, mime) => {
      driveStub.last = { folder, name, bytes: buf.length, mime };
      return { fileId: 'drv_1', id: 'drv_1' };
    },
    downloadFileBuffer: async () => PNG,
    describeDriveError: (e) => ({ reason: e.message, hint: null })
  };
  const router = require('../routes/clinicianOnboarding')({
    db, config: {}, logActivity: async () => {},
    getUsers: async () => [user],
    authenticateToken: (req, _res, next) => { req.user = user; next(); },
    drive: driveStub,
    // The SERVER's own sniffer, copied, so the route is held to what production
    // actually hands it — a mime STRING, not an object.
    detectFileType: (buf) => {
      if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
      return null;
    },
    hashIp: () => 'hashed',
    uuidv4: () => `id_${Math.random().toString(36).slice(2, 10)}`
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  if (inputs) {
    await fetch(`${base}/api/clinician-onboarding/admin/${user.id}/inputs`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inputs)
    });
  }
  return { store, drive: driveStub, base };
};

const OFFICE_NP = {
  id: 'u1', name: 'Thanmayie Rao', email: 't@gfc.test',
  role: 'admin', hasClinicalAccess: true, clinicalRole: 'provider'
};

test('a file she attaches lands in the store User Management reads', async (t) => {
  const h = await mountOnboarding(t, {
    user: OFFICE_NP,
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] }
  });

  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'licence-scan.png');
  const res = await fetch(`${h.base}/api/clinician-onboarding/me/items/NP-01/proof`,
    { method: 'POST', body: fd });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body).slice(0, 200));

  // THE ACTUAL ASK: one person's paperwork in one place.
  const docs = h.store.caregiver_documents || [];
  assert.strictEqual(docs.length, 1, 'the upload must write the shared row');
  const d = docs[0];
  assert.strictEqual(d.kind, 'clinician_onboarding');
  assert.strictEqual(String(d.caregiver_id), 'u1', 'filed under the person');
  assert.strictEqual(d.file_name, 'licence-scan.png', 'her own filename, kept');
  assert.strictEqual(d.mime_type, 'image/png', 'typed by its bytes');
  assert.strictEqual(d.size_bytes, PNG.length);
  assert.strictEqual(d.drive_file_id, 'drv_1');
  assert.match(d.note, /^Onboarding: /, 'named by the item it answers');
  assert.strictEqual(d.clinician_item_id, 'NP-01');
  // A licence is verified against a primary source, so it is still waiting on
  // the office — the row mirrors the item rather than inventing a second rule.
  assert.strictEqual(d.status, 'received');

  // And the wizard points at that same row.
  const row = body.track.rows.find(r => r.id === 'NP-01');
  assert.strictEqual(row.proofFiles.length, 1);
  assert.strictEqual(row.proofFiles[0].documentId, d.id,
    'one file, two screens — never two copies that can disagree');

  // She can open it, and gets back the bytes she sent.
  const open = await fetch(
    `${h.base}/api/clinician-onboarding/me/items/NP-01/proof/${row.proofFiles[0].id}`);
  assert.strictEqual(open.status, 200);
  assert.ok(Buffer.from(await open.arrayBuffer()).equals(PNG), 'the same bytes come back');
});

test('a file that is not a PDF, JPEG or PNG is refused by its bytes', async (t) => {
  const h = await mountOnboarding(t, {
    user: OFFICE_NP,
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] }
  });
  const fd = new FormData();
  // Claims to be a PNG; the bytes say otherwise. Never trust the claim.
  fd.append('file', new Blob([Buffer.from('MZ\x90\x00 not a png')], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${h.base}/api/clinician-onboarding/me/items/NP-01/proof`,
    { method: 'POST', body: fd });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'PROOF_TYPE_UNSUPPORTED');
  assert.strictEqual((h.store.caregiver_documents || []).length, 0,
    'nothing may be recorded for a file that was refused');
});

test('a Drive failure refuses the upload rather than recording a row with no file', async (t) => {
  const h = await mountOnboarding(t, {
    user: OFFICE_NP,
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] }
  });
  h.drive.uploadCaregiverDocumentFile = async () => { throw new Error('Drive is down'); };
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'licence.png');
  const res = await fetch(`${h.base}/api/clinician-onboarding/me/items/NP-01/proof`,
    { method: 'POST', body: fd });
  assert.strictEqual(res.status, 502);
  // A row pointing at a file that does not exist would tick a credentialing
  // item with no proof behind it, and she would believe she had sent it.
  assert.strictEqual((h.store.caregiver_documents || []).length, 0);
  const rec = (h.store.clinician_onboarding || [])[0];
  assert.ok(!rec || !rec.items['NP-01'] || !(rec.items['NP-01'].proofFiles || []).length);
});

test('a Drive id never leaves the server', () => {
  // Both readers go through a route that audits. A Drive id in the browser is
  // a file reachable without one — the rule the caregiver document store and
  // the client document exchange both already follow.
  const rows = T.buildTrack({
    inputs: { roles: ['NP'], relationship: 'W2', lanes: ['CLINICAL'], addons: [] },
    record: { items: { 'NP-01': { proofFiles: [{
      id: 'f1', name: 'licence.png', documentId: 'cgdoc_1',
      driveFileId: 'SECRET_DRIVE_ID', uploadedAt: '2026-11-06T00:00:00Z'
    }] } } }
  }).rows;
  const f = rows.find(r => r.id === 'NP-01').proofFiles[0];
  assert.strictEqual(f.documentId, 'cgdoc_1', 'the office needs our own row id to open it');
  assert.ok(!('driveFileId' in f), 'but never Google\'s');
  assert.ok(!JSON.stringify(rows).includes('SECRET_DRIVE_ID'));
});
