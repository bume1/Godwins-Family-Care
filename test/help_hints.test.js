'use strict';
// Owner, 2026-10-12: the "how this works" notes under key buttons in the
// clinical workspace show in full only to a super admin; everyone else gets a
// "?" bubble that shows the same words on hover, focus or tap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const hintSrc = (() => {
  const start = html.indexOf('const Hint = (');
  assert.ok(start > 0, 'Hint component must exist');
  return html.slice(start, html.indexOf('\n    };', start));
})();

test('Hint shows the full note only to a super admin', () => {
  assert.match(hintSrc, /useContext\(AccessContext\)\.role === 'admin'/);
  assert.match(hintSrc, /if \(isSuperAdmin\) return <p/);
});

test('everyone else gets a ? bubble that opens on hover, focus and tap', () => {
  for (const h of ['onMouseEnter', 'onFocus', 'onClick', 'role="tooltip"', 'tabIndex={0}']) {
    assert.ok(hintSrc.includes(h), `bubble must handle ${h}`);
  }
  assert.match(hintSrc, />\s*\?\s*\n/);
});

test('the save-draft notes are Hints, not always-on paragraphs', () => {
  const phrases = [
    'stamped with your name and the time — it is <b>not</b> signed',
    'stamped with your name and the time — it does <b>not</b> sign',
    'The original slot stays on the calendar',
    'Saving writes the versioned plan to the client record',
    'Unmarked rows default to "keep"',
  ];
  for (const ph of phrases) {
    let i = html.indexOf(ph);
    assert.ok(i > 0, `missing: ${ph}`);
    while (i > 0) {
      const open = html.lastIndexOf('<Hint', i);
      const para = html.lastIndexOf('<p ', i);
      assert.ok(open > para, `"${ph}" must sit inside a <Hint>`);
      i = html.indexOf(ph, i + 1);
    }
  }
});
