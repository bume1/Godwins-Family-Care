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

// Module scope differs by page: the older pages indent their babel block by 4
// spaces, the newer ones write it flush left. The threshold is therefore
// per-page — one shared number would either miss real nesting on the flush-left
// pages or flag every component on the indented ones.
//
// caregiver.html and scheduling.html were ADDED 2026-09-13, when the caregiver
// document card put a form control on a page this guard had never covered. A
// protection that only covers the pages that happened to exist when it was
// written stops being a protection as the app grows.
const PAGES = [
  { page: 'clinical.html',         nestedAt: 6 },
  { page: 'portal.html',           nestedAt: 6 },
  { page: 'admin-hub.html',        nestedAt: 6 },
  { page: 'admin-enrollment.html', nestedAt: 6 },
  { page: 'caregiver.html',        nestedAt: 2 },
  { page: 'scheduling.html',       nestedAt: 2 }
];
const FORM_CONTROL = /<(input|textarea|select)\b/;

test('no component that renders a form control is defined inside another component', () => {
  const offenders = [];
  for (const { page, nestedAt } of PAGES) {
    const file = path.resolve(__dirname, '..', 'public', page);
    if (!fs.existsSync(file)) continue;
    const nested = new RegExp(`^(\\s{${nestedAt},})const ([A-Z][A-Za-z0-9]*)\\s*=\\s*\\(`);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(nested);
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
