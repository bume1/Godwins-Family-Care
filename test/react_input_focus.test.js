// A component declared INSIDE another component's body is a new function
// identity on every render. React compares element types by identity, so it
// unmounts the old subtree and mounts a fresh one — which destroys the <input>
// DOM node and the caret with it.
//
// The symptom is unmistakable and was reported from the workspace: you type one
// character into a field and it stops accepting input. It reproduced in the H&P
// form, the follow-up modal and the portal's sharing card.
//
// This test fails if anyone reintroduces the pattern. Components that render a
// form control must live at module scope and take their value and handler as
// props.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = ['clinical.html', 'portal.html', 'admin-hub.html', 'admin-enrollment.html'];
// Module scope in these files is 4 spaces (inside the babel <script> block).
// 6+ means it is nested inside another component.
const NESTED_COMPONENT = /^(\s{6,})const ([A-Z][A-Za-z0-9]*)\s*=\s*\(/;
const FORM_CONTROL = /<(input|textarea|select)\b/;

test('no component that renders a form control is defined inside another component', () => {
  const offenders = [];
  for (const page of PAGES) {
    const file = path.resolve(__dirname, '..', 'public', page);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(NESTED_COMPONENT);
      if (!m) return;
      // Look at the component's body — bounded, since these are small helpers.
      const body = lines.slice(i, i + 40).join('\n');
      if (FORM_CONTROL.test(body)) {
        offenders.push(`${page}:${i + 1} — ${m[2]} (indent ${m[1].length}) renders a form control`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'These remount on every keystroke and drop the caret after one character. ' +
    'Hoist them to module scope and pass value/onChange as props:\n  ' + offenders.join('\n  '));
});
