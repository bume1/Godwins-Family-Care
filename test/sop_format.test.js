'use strict';

// SOP text laid out to read (owner, 2026-11-10).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { sopBlocks } = require('../public/sop-format');

test('headings, lead-ins and bullets come back from plain lines', () => {
  const b = sopBlocks([
    'Manual: 14, 23.5 · Module: TRN-104',
    'Purpose. Conduct each examination to a consistent standard.',
    '',
    'Before the examination',
    'Accept or decline the case. For contracted examiners, it is their decision.',
    'Confirm the time, the location, and any accommodations required.',
    '| Step | Who |'
  ]);
  assert.deepStrictEqual(b.map(x => x.kind), ['meta', 'para', 'gap', 'heading', 'bullet', 'bullet', 'table']);
  assert.strictEqual(b[1].lead, 'Purpose.');
  assert.strictEqual(b[4].lead, 'Accept or decline the case.');
  assert.strictEqual(b[5].lead, undefined, 'a plain sentence has no lead-in');
});

test('a long sentence is never mistaken for a heading or a lead-in', () => {
  const b = sopBlocks(['Do not diagnose for treatment purposes, prescribe, direct care, or provide medical advice, beyond what the procedure requires.']);
  assert.strictEqual(b[0].kind, 'para');
  assert.strictEqual(b[0].lead, undefined);
});

test('the training view uses it, and a text-only "video" reads as Read', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /<script src="\/sop-format\.js"><\/script>/);
  assert.match(page, /window\.GFCSopFormat\.sopBlocks\(sec\.lines\)/);
  assert.match(page, /'VIDEO' : 'READ'/);
  assert.strictEqual((page.match(/FORMAT\[shownFormat\(m\)\]/g) || []).length, 2);
});
