// test/extraction_review_wiring.test.js — the extraction review panel is wired
// to the server's own answer (2026-10-12, spec section G).
//
// FOUR BUGS, ALL THE SAME SHAPE: the screen and the server disagreed about a
// name, and nothing failed loudly. A read stored a correct row and the
// reviewer saw nothing; a comparison rendered "nothing on file" for a value
// that was plainly on file; a kind was advertised as readable with no schema
// behind it. None of these throw — they just quietly tell a clinician
// something untrue, which is the failure mode this whole feature exists to
// avoid.
//
// MUTATION-CHECKED. Comments are stripped before every source scan — a scan
// that cannot tell live code from prose about that code proves nothing.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('../documentExtraction.js');

const root = path.join(__dirname, '..');
const stripComments = (src) => src
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = (f) => {
  const raw = fs.readFileSync(path.join(root, f), 'utf8');
  const out = stripComments(raw);
  assert.ok(1 - out.length / raw.length < 0.45, `stripComments swallowed code in ${f}`);
  return out;
};

// ── G1: the response the review panel is keyed on ─────────────────────────

test('G1: a fresh read returns docId, or the review panel never opens', () => {
  const server = read('server.js');
  const i = server.indexOf("message: 'Read — nothing has been saved yet.");
  assert.ok(i > 0, 'the extract response must still be findable');
  const body = server.slice(i, server.indexOf('});', i));
  assert.match(body, /docId: row\.docId/,
    'both pages render the panel only when reviewing.docId matches, so a response without docId stores a row nobody can see');
  // The identity of the row, so a decision can be posted against it.
  assert.match(body, /id: row\.id/);
  assert.match(body, /rows: row\.rows/);
  assert.match(body, /identityConflicts: row\.identityConflicts/);
});

test('G1: a fresh read says WHICH reader produced it, and warns when it was a picture', () => {
  const server = read('server.js');
  const i = server.indexOf("message: 'Read — nothing has been saved yet.");
  const body = server.slice(i, server.indexOf('});', i));
  for (const field of ['reader', 'source', 'readNotice', 'pagesRead', 'pagesTotal', 'stoppedBecause']) {
    assert.ok(new RegExp(`${field}: row\\.${field}`).test(body),
      `${field} must come back with the read — telling a reviewer late that a value came out of a picture is telling them late`);
  }
});

test('G1: the fresh response and the stored pending row carry the same names', () => {
  // The panel is rendered from whichever of the two it was handed. If they
  // disagree on a name, the panel works on one path and silently degrades on
  // the other — which is exactly how this bug survived.
  const server = read('server.js');
  const fresh = server.slice(server.indexOf("message: 'Read — nothing has been saved yet."));
  const freshBody = fresh.slice(0, fresh.indexOf('});'));
  const statusI = server.indexOf('const extractionStatusHandler');
  const pending = server.slice(statusI, server.indexOf('};', statusI));
  for (const field of ['docId', 'kind', 'rows', 'identityConflicts', 'reviewCount', 'reader', 'source', 'readNotice', 'pagesRead', 'pagesTotal', 'stoppedBecause']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(freshBody), `${field} missing from the fresh response`);
    assert.ok(new RegExp(`\\b${field}\\b`).test(pending), `${field} missing from the stored pending list`);
  }
});

// ── G2: the chart read the server's values by the wrong names ─────────────

test('G2: the chart compares against `snapshot`, the name the server actually sends', () => {
  const page = read('public/clinical.html');
  assert.match(page, /row\.snapshot/, 'the chart must read the value the server sends');
  assert.doesNotMatch(page, /row\.current/,
    '`current` is not a field buildProposals produces — it rendered "nothing on file" for every value that WAS on file');
});

test('G2: an identity conflict names both sides, using the server\'s own keys', () => {
  const page = read('public/clinical.html');
  const i = page.indexOf('identityConflicts');
  const body = page.slice(i, i + 700);
  assert.match(body, /c\.onDocument/, 'what the document says');
  assert.match(body, /c\.onFile/, 'what the record says');
  assert.doesNotMatch(body, /c\.value|c\.current/,
    'a conflict warning with both values blank is a warning nobody can act on');
});

test('G2: both screens agree, because they read one server answer', () => {
  // The enrollment screen was already right. The point of pinning both is
  // that the next change cannot fix one and leave the other behind.
  for (const f of ['public/clinical.html', 'public/admin-enrollment.html']) {
    const page = read(f);
    assert.match(page, /row\.snapshot/, `${f} must use snapshot`);
    assert.doesNotMatch(page, /row\.current/, `${f} must not invent a name`);
  }
});

// ── G3: a kind is only readable if something can be read out of it ────────

test('G3: consentPacket is not advertised as readable while it has no schema', () => {
  assert.strictEqual(X.isExtractable('consentPacket'), false,
    'it was offered as readable and had no schema at all, so the button could never work');
  assert.ok(!X.extractableKinds().includes(X.CONSENT_PACKET_KIND));
});

test('G3: EVERY advertised kind has a schema behind it', () => {
  // The general rule, not the one instance. A kind added to the catalog
  // without a schema is the same bug with a different name.
  const kinds = X.extractableKinds();
  assert.ok(kinds.length > 5, 'the catalog must still be populated');
  for (const kind of kinds) {
    const schema = X.schemaFor(kind);
    assert.ok(schema && schema.fields && Object.keys(schema.fields).length,
      `"${kind}" is advertised as readable but has no schema — a button that cannot work`);
  }
});

// ── G4: the chip says what is actually true ───────────────────────────────

test('G4: availability is answered from status(), never hardcoded true', () => {
  const server = read('server.js');
  const i = server.indexOf('const extractionStatusHandler');
  const body = server.slice(i, server.indexOf('};', i));
  assert.doesNotMatch(body, /available: true/,
    'a chip that is always green cannot distinguish a working reader from a refused one');
  assert.match(body, /available: st\.configured \|\| templateKinds\.length > 0/,
    'reading works without the model, so availability is the template reader OR the model');
  // And the two facts stay separate: "reading is on" and "the MODEL is on"
  // are different, because only one of them needs an owner to fix it.
  assert.match(body, /modelAvailable: st\.configured/);
  assert.match(body, /blockers: st\.blockers/);
});
