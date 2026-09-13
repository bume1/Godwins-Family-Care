// The welcome email carries a new user's sign-in credentials, and it is the
// first thing anyone ever receives from the platform. It spent PR #76 looking
// like a different company from every other notification, because it shipped
// its own hand-rolled HTML and `buildHtmlEmail` hands back any HTML a caller
// supplies without wrapping it. Reported live on 2026-09-13.
//
// These guards are in two halves. The render tests exercise the shared fields
// block for real. The source guards watch the welcome email specifically,
// because it is not exported (requiring server.js boots a server) and because
// the failure mode is silent: an opt-out of the house style looks like
// perfectly good code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { renderGfcEmail, fieldsBlock, PALETTE } = require('../emailTemplates');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The whole `const WELCOME_HTML_BODY = ...` declaration, up to the next
// top-level declaration.
function welcomeSource() {
  const i = SERVER_SRC.indexOf('const WELCOME_HTML_BODY');
  assert.notStrictEqual(i, -1, 'WELCOME_HTML_BODY has been renamed or removed');
  const rest = SERVER_SRC.slice(i);
  const end = rest.indexOf('\n\n');
  return rest.slice(0, end === -1 ? rest.length : end);
}

// ---- the shared fields block ------------------------------------------------

test('fieldsBlock renders each label and value', () => {
  const html = fieldsBlock([
    { label: 'Username', value: 'ada@example.com' },
    { label: 'Temporary password', value: 'Temp1a2b3c4d!', mono: true }
  ]);
  assert.match(html, /Username/);
  assert.match(html, /ada@example\.com/);
  assert.match(html, /Temporary password/);
  assert.match(html, /Temp1a2b3c4d!/);
});

test('fieldsBlock uses the house cream panel and gold rule, not its own styling', () => {
  const html = fieldsBlock([{ label: 'Username', value: 'ada@example.com' }]);
  assert.ok(html.includes(PALETTE.cream), 'fields block should sit on the house cream panel');
  assert.ok(html.includes(PALETTE.gold), 'fields block should carry the gold rule');
});

test('fieldsBlock renders nothing at all when there is nothing to show', () => {
  assert.strictEqual(fieldsBlock([]), '');
  assert.strictEqual(fieldsBlock(undefined), '');
  // A row with no value is dropped rather than printed as an empty line: a
  // blank "Temporary password" reads as though the password is blank.
  assert.strictEqual(fieldsBlock([{ label: 'Temporary password', value: '' }]), '');
});

test('fieldsBlock escapes values rather than trusting them as markup', () => {
  const html = fieldsBlock([{ label: 'Username', value: '<img src=x onerror=alert(1)>' }]);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the value should be escaped');
  assert.ok(!/<img\s/i.test(html), 'no real img tag may reach the message');
});

test('a rendered email carries its fields in BOTH halves', () => {
  const { html, text } = renderGfcEmail({
    greeting: 'Ada',
    headline: 'Welcome',
    paragraphs: ['Your account is ready.'],
    fields: [{ label: 'Temporary password', value: 'Temp1a2b3c4d!', mono: true }],
    ctaUrl: 'https://app.godwinsfamilycarellc.com/login',
    ctaLabel: 'Sign in'
  });
  assert.ok(html.includes('Temp1a2b3c4d!'), 'html must carry the credentials');
  // A text-only client that cannot see the table must still get the password,
  // or the recipient cannot sign in at all.
  assert.match(text, /Temporary password: Temp1a2b3c4d!/);
});

// ---- the welcome email itself ----------------------------------------------

test('the welcome email renders through the house template', () => {
  const src = welcomeSource();
  assert.ok(
    /emailTemplates\.renderGfcEmail\(/.test(src),
    'the welcome email must render through emailTemplates, not its own HTML'
  );
});

test('the welcome email does not reach for the old plain chrome', () => {
  const src = welcomeSource();
  assert.ok(
    !src.includes('emailHeaderHtml'),
    'emailHeaderHtml is the pre-PR-#76 wrapper — the welcome email must not use it'
  );
  assert.ok(
    !/<div style=/.test(src),
    'hand-rolled markup in the welcome email is how it opted out of the branding before'
  );
});

test('the welcome email takes its values in, rather than being substituted after rendering', () => {
  // renderTemplate() runs AFTER the template has escaped everything, so a value
  // substituted at that point lands in the markup unescaped. Passing the vars
  // in means the house template escapes the real values.
  assert.ok(
    !SERVER_SRC.includes('renderTemplate(WELCOME_HTML_BODY('),
    'the welcome HTML must not be post-processed by renderTemplate'
  );
  const calls = SERVER_SRC.match(/WELCOME_HTML_BODY\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3, `expected the welcome builder to be called; found ${calls.length}`);
  for (const call of calls) {
    if (call.startsWith('WELCOME_HTML_BODY(vars')) continue;
    assert.fail(`every call must pass the vars: saw ${call}`);
  }
});

test('the welcome email still presents the credentials it exists to deliver', () => {
  const src = welcomeSource();
  assert.ok(src.includes('vars.recipientEmail'), 'the username must be in the email');
  assert.ok(src.includes('vars.temporaryPassword'), 'the temporary password must be in the email');
  assert.ok(src.includes('vars.loginUrl'), 'the sign-in link must be in the email');
});
