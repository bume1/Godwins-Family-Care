'use strict';

// The onboarding page: built from the server's answers, never internal codes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
const code = page.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('no Playbook code is written into the page; phases show their number and plain label', () => {
  assert.doesNotMatch(code, /['"`]C\.\d/, 'a Playbook code literal');
  assert.match(code, /Phase \{ph\.number\} · \{ph\.label\}/);
});

test('whose turn reads "Waiting on You" only on her own screen; the office reads her name', () => {
  assert.match(code, /viewerIsSubject \? 'Waiting on You' : `Waiting on \$\{/);
});

test('the page decides office or new-hire view from the server\'s viewer, not a stored role', () => {
  assert.match(code, /d\.viewer\.isOffice/);
  assert.doesNotMatch(code, /localStorage\.getItem\('(?:admin_user|portal_user|unified_user)'\)/);
});

test('every route is spelled out in full, so the orphan-route guard can see it', () => {
  assert.doesNotMatch(code, /\$\{base\}/);
  assert.match(code, /\/api\/onboarding\/admin\/people\/\$\{w\.userId\}\/items\/\$\{i\}\/steps\/\$\{n\}/);
});

test('a classification chip shows the document\'s phrase and nothing else', () => {
  assert.match(code, /item\.classifications\.map\(c => c\.phrase\)/);
});
