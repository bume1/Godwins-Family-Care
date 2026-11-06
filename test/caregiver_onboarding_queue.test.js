// ============================================================
// The office can mark its own onboarding items (owner: "Fix all", 2026-11-06)
//
// All FOUR office items — fingerprinting, orientation, app training, skills
// check — are REQUIRED for shift clearance, and the only route that sets them
// (`PUT …/welcome-packets/:caregiverId/office-item`) had no screen, nor did the
// queue beside it. So NO CAREGIVER COULD BE CLEARED FOR A SHIFT the normal
// way: every assignment had to go through the admin override, with a reason,
// or not be made at all. A gate nobody could open.
//
// Same class as the standing-order authoring gap found the same day: the
// capability existed, the door did not.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'caregivers.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'welcomePacket.js'), 'utf8');
const wp = require('../welcomePacketRepository');
const gate = require('../caregiverOnboardingGate');
const strip = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('all four office items really are required for clearance', () => {
  // The premise of this whole PR. If any of these stops being required, the
  // urgency changes and this test should say so rather than quietly pass.
  const office = wp.DOCUMENT_ITEMS.filter(d => d.source === 'office');
  assert.deepEqual(office.map(d => d.kind).sort(), ['app_training', 'fingerprinting', 'orientation', 'skills_check']);
  for (const d of office) assert.equal(d.required, true, `${d.kind} must be required`);
  // And an unset office item does block clearance, which is why a screen was owed.
  const checklist = wp.buildChecklist({}, [], {}, []);
  const outstanding = gate.outstandingForClearance(checklist);
  const waitingOnUs = outstanding.filter(o => o.waitingOn === 'us').map(o => o.item);
  assert.ok(waitingOnUs.length >= 4, `office items must block clearance (blocked: ${waitingOnUs.length})`);
});

test('marking every office item done is what clears a caregiver', () => {
  // Run the real gate: with the four office items done, nothing is left
  // waiting on us. That is the outcome the screen exists to produce.
  const officeDone = {};
  for (const k of wp.OFFICE_ITEM_KINDS) officeDone[k] = { status: 'done', at: '2026-11-06T00:00:00.000Z', byName: 'Admin' };
  const after = gate.outstandingForClearance(wp.buildChecklist({}, [], officeDone, []));
  assert.equal(after.filter(o => o.waitingOn === 'us').length, 0,
    'with all four done, nothing should be waiting on the office');
  // The caregiver's own half is untouched — this screen does not clear that.
  assert.ok(after.some(o => o.waitingOn === 'you'), 'the caregiver still owes their own documents');
});

test('both routes now have a caller, and the tab renders it', () => {
  const code = strip(PAGE);
  assert.match(code, /api\('\/api\/caregiver\/admin\/welcome-packets'\)/, 'nothing reads the queue');
  assert.match(code, /\/api\/caregiver\/admin\/welcome-packets\/\$\{encodeURIComponent\(caregiverId\)\}\/office-item/,
    'nothing sets an office item');
  assert.match(code, /method: 'PUT'/, 'the office-item call must be a PUT');
  // A component nothing renders is the same defect one layer in.
  assert.match(code, /\{ id: 'onboarding', label: 'Onboarding'/, 'no tab');
  assert.match(code, /\{tab === 'onboarding' && <Onboarding setErr=\{setErr\} setOk=\{setOk\} \/>\}/, 'the tab renders nothing');
});

test('the statuses and the item titles are SERVED, not named in the page', () => {
  // The route refuses a status outside its own list (OFFICE_STATUS_UNKNOWN), so
  // an option invented in the page is refused on save — or renders an empty
  // dropdown and looks broken.
  assert.match(ROUTE, /officeStatuses: wp\.OFFICE_STATUSES/, 'the queue must serve the statuses');
  assert.match(ROUTE, /office: state\.checklist/, 'the queue must serve each office item with its status');
  const code = strip(PAGE);
  assert.match(code, /\(rows\.officeStatuses \|\| \[\]\)\.map/, 'the dropdown must be built from the served list');
  // The page may LABEL them, but must not decide the set.
  assert.doesNotMatch(code, /\[['"]not_started['"], *['"]scheduled['"]/, 'the page must not name the status set');
  assert.doesNotMatch(code, /\[['"]fingerprinting['"]/, 'the page must not name the office items');
});

test('the office item is sent by KIND, which is what the route validates', () => {
  // The checklist row carries BOTH `item` (the printed packet's item number:
  // 6, 21, 22, 23) and `kind`. Sending the number is refused
  // (OFFICE_ITEM_UNKNOWN), and that was the first version of this.
  assert.match(ROUTE, /kind: r\.kind, title: r\.title/, 'the queue must serve kind, not the item number');
  const rows = wp.buildChecklist({}, [], {}, []).filter(r => r.source === 'office');
  for (const r of rows) {
    assert.ok(wp.OFFICE_ITEM_KINDS.includes(r.kind), `${r.kind} must be a valid kind`);
    assert.ok(!wp.OFFICE_ITEM_KINDS.includes(String(r.item)), 'the item number must not pass as a kind');
  }
});

test('the queue reports clearance in the gate\'s own words, and says when it changes', () => {
  const code = strip(PAGE);
  // The gate decides; the screen reports. A sentence written here would drift
  // from the rule.
  assert.match(code, /c\.clearanceMessage/, 'the row must show the gate\'s clearance message');
  assert.match(code, /r\.onboarding\.cleared/, 'the save must read clearance back from the response');
  assert.match(code, /now cleared for shifts/, 'becoming schedulable is the thing the office is waiting to hear');
  // The route does recompute it on save, so reading it back is meaningful.
  assert.match(ROUTE, /onboarding: gate\.onboardingSummary\(caregiver, packet, checklist\)/);
});

test('the queue defaults to what is OURS to act on, and can show everything', () => {
  const code = strip(PAGE);
  assert.match(code, /useState\(true\)/, 'the waiting-on-us filter should default on');
  assert.match(code, /c\.waitingOnUs > 0/, 'the filter must use the served count');
  // An empty filtered list must not read as "no caregivers".
  assert.match(code, /Nothing is waiting on the office/);
  assert.match(code, /Untick the box above to see every caregiver/);
  // And the caregiver's own outstanding items are named, not hidden, so the
  // office knows why someone is still not cleared after their four are done.
  assert.match(code, /Also waiting on the caregiver/);
});

test('a refusal shows the route\'s own sentence', () => {
  const code = strip(PAGE);
  // OFFICE_ITEM_UNKNOWN / OFFICE_STATUS_UNKNOWN name the field; a generic
  // failure sends somebody looking in the wrong place.
  assert.match(ROUTE, /code: 'OFFICE_ITEM_UNKNOWN'/);
  assert.match(ROUTE, /code: 'OFFICE_STATUS_UNKNOWN'/);
  const i = code.indexOf('const setItem = async');
  const body = code.slice(i, code.indexOf('return (', i));
  assert.ok(body.length > 200 && body.length < 2000, `setItem slice looks wrong (${body.length})`);
  assert.match(body, /setErr\(e\.message\)/, 'the route\'s message must reach the screen');
  assert.match(body, /setBusy\(''\)/, 'the control must be re-enabled whatever happened');
});

test('the queue carries no PHI: counts and onboarding state only', () => {
  const i = ROUTE.indexOf("router.get('/api/caregiver/admin/welcome-packets'");
  assert.ok(i > 0, 'the queue route moved');
  // Comments STRIPPED before the scan: the route's own comment says it serves
  // no address, and matching that prose failed a correct route. Sixth time
  // this repo has paid for a scan that cannot tell code from prose about it,
  // and this one was a test of mine.
  const route = strip(ROUTE.slice(i, ROUTE.indexOf('\n  });', i)));
  assert.ok(route.length > 300, `the queue slice looks wrong (${route.length} chars)`);
  // A queue is a glance. The packet holds a date of birth, a home address and
  // a signature image; none of it belongs on a list.
  for (const bad of ['dob', 'dateOfBirth', 'address', 'ssn', 'signature', 'emergencyContact']) {
    assert.ok(!new RegExp(`\\b${bad}\\b`, 'i').test(route), `the queue must not serve ${bad}`);
  }
  // It serves the name and email because the office has to know whose row it is.
  assert.match(route, /name: caregiver\.name/);
});
