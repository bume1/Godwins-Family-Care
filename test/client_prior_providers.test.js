// ============================================================
// A client can edit their own provider list (owner: "Fix all", 2026-11-06)
//
// `PUT /api/gfc/prior-providers` has existed since Session 3.4 — the notes
// say `priorProviders` is "normalized at intake and editable independently" —
// and NOTHING in the app ever called it. A client whose doctor changed, or
// whose provider's fax was mistyped, could only fix it by signing a release.
//
// The trap this file mostly exists for: `resolvePriorProviders` rebuilds every
// `intake_prefill` entry from the medical team on each intake save, preserving
// only `manual` and `roi_form`. So an edit sent back with its original
// `addedFrom` is silently discarded the next time anyone saves intake. A row
// the client CHANGED must therefore become `manual`; a row they did not touch
// must keep syncing.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// The page's own change-detector and payload builder, lifted and run rather
// than read: this is the logic a client's lost correction would come from.
const liftSaveLogic = () => {
  const code = stripComments(PAGE);
  const a = code.indexOf('const myProviderRowChanged = ');
  assert.ok(a > 0, 'myProviderRowChanged not found');
  const b = code.indexOf('const setMyProvider = ', a);
  assert.ok(b > a, 'anchor moved');
  const body = code.slice(a, b);
  assert.ok(body.includes('addedFrom') === false, 'the detector must not read addedFrom');
  // eslint-disable-next-line no-new-func
  return new Function('myProvidersOriginal', `${body}; return myProviderRowChanged;`);
};

const ORIGINAL = [
  { name: 'Northside Hospital', dept: 'Medical Records', address: '1 Main St', phone: '4045550001', fax: '4045550002', roleLabel: 'hospital', addedFrom: 'intake_prefill' },
  { name: 'Dr Patel', dept: '', address: '', phone: '4045550003', fax: '', roleLabel: 'pcp', addedFrom: 'intake_prefill' },
  { name: 'Dr Okafor', dept: '', address: '', phone: '', fax: '4045550004', roleLabel: 'specialist', addedFrom: 'manual' }
];

test('an untouched row is reported unchanged; any edited field is reported changed', () => {
  const changed = liftSaveLogic()(ORIGINAL);
  assert.equal(changed({ ...ORIGINAL[0] }, 0), false, 'an identical row is unchanged');
  // Every field the client can edit must count, not just the name.
  for (const k of ['name', 'dept', 'address', 'phone', 'fax', 'roleLabel']) {
    assert.equal(changed({ ...ORIGINAL[0], [k]: 'something else' }, 0), true, `${k} must count as a change`);
  }
  // Whitespace alone is not a change — otherwise a stray space makes an entry
  // `manual` and quietly stops it following the medical team.
  assert.equal(changed({ ...ORIGINAL[0], name: '  Northside Hospital  ' }, 0), false);
  // A row with no original is one they added.
  assert.equal(changed({ name: 'New Clinic', roleLabel: 'other' }, 9), true);
});

test('the page sends addedFrom ONLY for rows the client did not change', () => {
  const code = stripComments(PAGE);
  const a = code.indexOf('const saveMyProviders = ');
  assert.ok(a > 0);
  const body = code.slice(a, code.indexOf("if (screen === 'providers')", a));
  // The conditional is the whole protection. Pin its shape, not its presence:
  // an unconditional assignment would make every edit fragile.
  assert.match(body, /if \(!myProviderRowChanged\(p, idx\)\) row\.addedFrom = p\.addedFrom;/,
    'addedFrom must be attached only when the row is unchanged');
  assert.doesNotMatch(body, /addedFrom: p\.addedFrom/,
    'addedFrom must not be set unconditionally in the row literal');
});

test('a nameless row is dropped before sending, so the list shown is the list saved', () => {
  const code = stripComments(PAGE);
  const body = code.slice(code.indexOf('const saveMyProviders = '), code.indexOf("if (screen === 'providers')"));
  assert.match(body, /myProviders\.filter\(p => String\(p\.name \|\| ''\)\.trim\(\)\)/,
    'nameless rows must be filtered client-side (the server drops them regardless)');
  // And the form says so, rather than letting the row vanish silently.
  assert.match(stripComments(PAGE), /A provider with no name is not kept/);
});

test('a malformed fax is refused before the request, and a blank one is allowed', () => {
  const code = stripComments(PAGE);
  const body = code.slice(code.indexOf('const saveMyProviders = '), code.indexOf("if (screen === 'providers')"));
  // 'bad' only — a list entry with no fax yet is a normal state; the fax
  // matters when a release is actually sent.
  assert.match(body, /roiFaxState\(p\.fax\) === 'bad'/);
  assert.doesNotMatch(body, /roiFaxState\(p\.fax\) === 'blank'/,
    'a blank fax must not block saving the list');
});

test('the save reads back what was STORED, not what was typed', () => {
  const code = stripComments(PAGE);
  const body = code.slice(code.indexOf('const saveMyProviders = '), code.indexOf("if (screen === 'providers')"));
  assert.match(body, /r\.priorProviders \|\| \[\]/, 'must re-seed state from the response');
  assert.match(body, /setMyProvidersOriginal\(saved\)/,
    'the baseline must move to what was stored, or the next edit is compared against stale values');
});

test('the role select sends the CODE, never the label', () => {
  const code = stripComments(PAGE);
  const i = code.indexOf('const ROLES = [');
  assert.ok(i > 0, 'ROLES not found');
  const block = code.slice(i, code.indexOf('];', i));
  // The server coerces any roleLabel outside this set to 'other'.
  for (const v of ['pcp', 'specialist', 'hospital', 'other']) {
    assert.ok(block.includes(`v: '${v}'`), `${v} must be an option value`);
  }
  assert.match(code, /<option key=\{r\.v\} value=\{r\.v\}>\{r\.l\}<\/option>/,
    'the option value must be the code and the text the label');
  // SelectField stores the label as the value, so it must not be used here.
  const screen = code.slice(code.indexOf("if (screen === 'providers')"), code.indexOf("if (screen === 'choice')"));
  assert.doesNotMatch(screen, /<SelectField/, 'SelectField would store the label and lose the role');
});

test('the screen says plainly that saving sends and authorizes nothing', () => {
  const code = stripComments(PAGE);
  const screen = code.slice(code.indexOf("if (screen === 'providers')"), code.indexOf("if (screen === 'choice')"));
  assert.match(screen, /only updates your list/i);
  assert.match(screen, /does not request any records and does not authorize anything/i);
  // And a provider with a release already in force is told the edit does not
  // re-send it, because that is the reasonable thing to assume otherwise.
  assert.match(screen, /does not re-send it/i);
});

test('the editor is reachable: a card on the choice screen opens it', () => {
  const code = stripComments(PAGE);
  const choice = code.slice(code.indexOf("if (screen === 'choice')"), code.indexOf("if (screen === 'upload')"));
  assert.match(choice, /setScreen\('providers'\)/, 'nothing opens the editor');
  assert.match(choice, /Update your providers/, 'the card needs a label; an unlabelled control is invisible');
});

test('the route this screen calls is the one that already existed', () => {
  // No new route was added: the capability was there, the screen was not.
  assert.match(SERVER, /app\.put\('\/api\/gfc\/prior-providers', authenticateToken, requireClientForIntake/);
  assert.match(stripComments(PAGE), /method: 'PUT'[\s\S]{0,200}prior-providers|prior-providers[\s\S]{0,200}method: 'PUT'/);
});
