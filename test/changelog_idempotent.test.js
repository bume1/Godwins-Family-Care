// ============================================================================
// Regenerating the changelog replaces a version; it never stacks a copy
//
// `updateChangelogMd()` was `header + newEntry + existingEntries`,
// unconditionally. The generator runs on every app boot, so `public/changelog.md`
// — a page the app serves to people — accumulated SEVENTEEN copies of one
// version's heading and TWELVE of another's, and every session found the
// working tree dirty for a file nobody had edited.
//
// It also cost a wrong statement to the owner: a session looked at a fresh
// duplicate, checked whether the OTHER version was duplicated, and reported the
// new one as a genuinely new section. Checking a signal that cannot answer the
// question you are asking is the house rule this repo keeps paying for.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gen = require('../changelog-generator');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'changelog-generator.js'), 'utf8');

const section = (version, date, item) =>
  `\n### ${version} - ${date}\n\n#### Changes\n- ${item}\n\n`;

test("today's section is REPLACED, not prepended again", () => {
  const entries = section('Version 3.1.0', 'September 20, 2026', 'first write')
    + section('Version 3.0.1', 'September 18, 2026', 'an older release');

  const stripped = gen.stripVersionSections(entries, 'Version 3.1.0', 'September 20, 2026');
  assert.ok(!stripped.includes('first write'), "today's earlier copy is gone");
  assert.ok(stripped.includes('an older release'), 'and another version is untouched');

  const headings = stripped.split('\n').filter(l => l.startsWith('### '));
  assert.deepStrictEqual(headings, ['### Version 3.0.1 - September 18, 2026']);
});

// THE ONE THAT MATTERS. The first version of this fix keyed on the version
// alone, and `public/changelog.md` carries `### Version 3.1.0` under FIVE
// different dates — February, June, and three days in September — five real
// releases that were never given distinct version numbers. Stripping by version
// deleted four of them. It was caught by reading the diff before committing,
// not by a test, which is why there is now a test.
test('a DIFFERENT DATE under the same version is a release, not a duplicate', () => {
  const entries = section('Version 3.1.0', 'February 17, 2026', 'the February release')
    + section('Version 3.1.0', 'June 10, 2026', 'the June release')
    + section('Version 3.1.0', 'September 20, 2026', 'an earlier write today');

  const stripped = gen.stripVersionSections(entries, 'Version 3.1.0', 'September 20, 2026');
  assert.ok(stripped.includes('the February release'), 'February must survive');
  assert.ok(stripped.includes('the June release'), 'and June');
  assert.ok(!stripped.includes('an earlier write today'), "only today's copy goes");
});

test('EVERY copy from the same day goes, not just the first', () => {
  // One day in September left five identical sections, so removing only the
  // topmost would leave the mess exactly as deep as it already is.
  const entries = Array.from({ length: 5 }, (_, n) =>
    section('Version 3.1.0', 'September 10, 2026', `boot ${n}`)).join('')
    + section('Version 3.0.1', 'September 18, 2026', 'keep me');

  const stripped = gen.stripVersionSections(entries, 'Version 3.1.0', 'September 10, 2026');
  assert.strictEqual(stripped.split('\n').filter(l => l.startsWith('### Version 3.1.0')).length, 0);
  assert.ok(stripped.includes('keep me'));
});

test('with no date it removes NOTHING, rather than guessing', () => {
  // Falling back to version-only matching is the data loss this guards.
  const entries = section('Version 3.1.0', 'February 17, 2026', 'the February release')
    + section('Version 3.1.0', 'September 20, 2026', 'today');
  assert.strictEqual(gen.stripVersionSections(entries, 'Version 3.1.0', ''), entries);
  assert.strictEqual(gen.stripVersionSections(entries, 'Version 3.1.0', undefined), entries);
});

test('a body line that looks like a heading does not eat the next section', () => {
  // A greedy regex over the whole file is how a fix like this swallows the
  // entries either side of its target.
  const entries = '\n### Version 3.1.0 - September 20, 2026\n\n#### Changes\n'
    + '- Document the `### Version` heading format\n\n'
    + section('Version 3.0.1', 'September 18, 2026', 'survivor');

  const stripped = gen.stripVersionSections(entries, 'Version 3.1.0', 'September 20, 2026');
  assert.ok(!stripped.includes('Document the'), 'the target section goes with its body');
  assert.ok(stripped.includes('survivor'), 'and the one after it survives');
});

test('a version that is not there changes nothing at all', () => {
  const entries = section('Version 3.0.1', 'September 18, 2026', 'only release');
  assert.strictEqual(gen.stripVersionSections(entries, 'Version 9.9.9', 'January 1, 2026'), entries);
});

test('empty and absent inputs are answered, not thrown on', () => {
  assert.strictEqual(gen.stripVersionSections('', 'Version 1.0.0', 'January 1, 2026'), '');
  assert.strictEqual(gen.stripVersionSections(undefined, 'Version 1.0.0', 'January 1, 2026'), '');
});

test('THE REAL FILE: regenerating today removes no historical release', () => {
  // Driven against the shipped changelog rather than a fixture, because the
  // fixture is what a version-only stripper would have passed.
  const real = fs.readFileSync(path.join(__dirname, '..', 'public', 'changelog.md'), 'utf8');
  const after = gen.stripVersionSections(real, 'Version 3.1.0', 'September 20, 2026');
  for (const heading of ['### Version 3.1.0 - February 17, 2026',
                         '### Version 3.1.0 - June 10, 2026',
                         '### Version 3.1.0 - September 10, 2026',
                         '### Version 3.0.1 - April 12, 2026']) {
    assert.ok(after.includes(heading), `${heading} must survive a regeneration`);
  }
});

test('the writer actually calls the stripper — the fix is in the write path', () => {
  // Exporting a correct helper that the writer never calls is the shape of a
  // fix that passes its own tests and changes nothing in production.
  assert.ok(
    /const updatedContent = header \+ newEntry \+ stripVersionSections\(existingEntries, version, date\);/.test(SRC),
    'updateChangelogMd must strip the version AND DATE it is about to write');
  assert.ok(
    !/const updatedContent = header \+ newEntry \+ existingEntries;/.test(SRC),
    'the unconditional prepend must not come back');
});

test('running the writer twice leaves one section, not two', async () => {
  // The whole claim, end to end, against a real file.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gfc-changelog-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  // The header is the real file's, byte for byte: updateChangelogMd finds the
  // separator with `indexOf('---\n', 50)`, so a shorter header than the real
  // one is never found and the function returns without writing — which would
  // make this test pass or fail for a reason that has nothing to do with the
  // rule it is guarding.
  const HEADER = '# Thrive 365 Labs - App Changelog\n\n## Release Notes & Update Log\n\n---\n';
  assert.ok(HEADER.indexOf('---\n', 50) !== -1,
    'the fixture header must be long enough for the writer to find its separator');
  fs.writeFileSync(path.join(pub, 'changelog.md'),
    HEADER + section('Version 3.0.1', 'September 18, 2026', 'an older release'), 'utf8');

  // updateChangelogMd resolves its path from __dirname, so the real function is
  // exercised through the module loaded from a copy of the generator placed
  // beside this temporary public/ directory.
  fs.writeFileSync(path.join(dir, 'changelog-generator.js'), SRC, 'utf8');
  const local = require(path.join(dir, 'changelog-generator.js'));
  assert.strictEqual(typeof local.updateChangelogMd, 'function',
    'updateChangelogMd must be exported for this to be provable rather than assumed');

  const sections = [{ label: 'Changes', items: [{ message: 'one write' }] }];
  // Each write is asserted to have HAPPENED. updateChangelogMd returns false
  // when it cannot find the header, and a pair of silent no-ops would leave one
  // section by doing nothing at all.
  assert.strictEqual(await local.updateChangelogMd('Version 3.1.0', 'September 20, 2026', sections), true);
  assert.strictEqual(await local.updateChangelogMd('Version 3.1.0', 'September 20, 2026', sections), true);

  const after = fs.readFileSync(path.join(pub, 'changelog.md'), 'utf8');
  const copies = after.split('\n').filter(l => l.startsWith('### Version 3.1.0')).length;
  assert.strictEqual(copies, 1, `two writes must leave one section, found ${copies}`);
  assert.ok(after.includes('an older release'), 'and the older release is still there');
  fs.rmSync(dir, { recursive: true, force: true });
});
