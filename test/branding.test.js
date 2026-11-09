'use strict';
// The My GFC look across the staff pages (owner, 2026-11-09): cream pages,
// white cards, white sidebars, a gold selected item. These guards keep a page
// from drifting back to the older navy-and-grey look.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const THEMED = ['account', 'audit', 'ime', 'messages', 'caregivers', 'scheduling'];

test('the older staff pages load the shared theme after their own styles', () => {
  for (const p of THEMED) {
    const html = read(`public/${p}.html`);
    const link = html.indexOf('<link rel="stylesheet" href="/css/gfc-theme.css">');
    assert.ok(link > html.indexOf('</style>'), `${p} loads gfc-theme.css after its own <style>`);
  }
});

test('the theme lines the title up with the content, and a page can widen both together', () => {
  const css = stripCss(read('public/css/gfc-theme.css'));
  assert.match(css, /\.hdr\{[^}]*max-width:var\(--page-w,1180px\)/);
  assert.match(css, /\.wrap\{[^}]*max-width:var\(--page-w,1180px\)/);
  assert.match(css, /\.tabs button\.on\{[^}]*#C9A44A/);
  assert.match(read('public/audit.html'), /--page-w:1320px/);
});

test('Clinical, Onboarding and Billing are white with a gold selected item, not navy', () => {
  const clin = stripCss(read('public/clinical.html'));
  assert.match(clin, /\.cw-side \{ background:#fff;/);
  assert.match(clin, /\.cw-nav button\.on \{ background:#C9A44A;/);
  assert.ok(!clin.includes('logo-full-white-trimmed.png'), 'the white logo does not sit on a white sidebar');
  const ob = stripCss(read('public/onboarding.html'));
  assert.match(ob, /\.side\{background:#fff;/);
  assert.match(ob, /\.nav button\.on\{background:#C9A44A/);
  const bill = read('public/billing.html');
  assert.ok(!/bg-primary text-white sticky top-0/.test(bill), 'no second navy bar under the staff bar');
  assert.match(stripCss(bill), /\.tabbtn\.on \{[^}]*background:var\(--goldd\)/);
});

test('the pale watermark mark is never a page icon or the staff bar mark', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public/brand/logo-mark-color-transparent.png')));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter(f => f.endsWith('.html'))) {
    const html = read(`public/${f}`);
    assert.ok(!/rel="icon"[^>]*logo-mark-transparent/.test(html), `${f} favicon is the color mark`);
  }
  assert.ok(!read('public/staff-nav.js').includes('logo-mark-transparent'));
});

test('the public password-reset and upload-link pages use the cream page and the color logo', () => {
  for (const p of ['password-reset', 'upload-link']) {
    const html = read(`public/${p}.html`);
    assert.match(html, /<body style="background:#FAF7F2"/, p);
    assert.ok(html.includes('logo-full-color-transparent.png'), p);
    assert.ok(!html.includes('<header className="bg-primary'), p);
  }
});
