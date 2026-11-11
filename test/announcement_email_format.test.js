'use strict';

// Office announcement emails keep their line breaks and draw ALL CAPS lines
// as headings (owner, 2026-11-10). Every other notice renders as before.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ET = require('../emailTemplates');
const A = require('../staffAnnouncements');

test('an announcement carries the announcement format through the queue to the render', () => {
  assert.strictEqual(A.emailFor({ title: 'T', body: 'x' }, 'https://a.b').format, 'announcement');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /format: templateData\.format \|\| null/, 'the queue keeps the format');
  assert.match(src, /if \(t\.format === 'announcement'\) \{ pieces\.lineBreaks = true; pieces\.capsHeadings = true; \}/);
});

test('with the announcement format: headings, line breaks, and the text still escaped', () => {
  const html = ET.renderGfcEmail({ paragraphs: ["WHAT'S COMING", 'With gratitude,\nBianca', 'a <b>x</b>\ny'], lineBreaks: true, capsHeadings: true }).html;
  assert.match(html, /<h2[^>]*>WHAT&#39;S COMING<\/h2>/);
  assert.match(html, /With gratitude,<br>Bianca/);
  assert.match(html, /a &lt;b&gt;x&lt;\/b&gt;<br>y/, 'escaped before the line break is added');
});

test('without it, nothing changes for other notices', () => {
  const html = ET.renderGfcEmail({ paragraphs: ['HELLO THERE', 'x\ny'] }).html;
  assert.doesNotMatch(html, /<h2/);
  assert.ok(!html.includes('x<br>y'));
});

test('an announcement message is never cut short (owner, 2026-11-10)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'caregiver.js'), 'utf8');
  assert.match(src, /body: String\(body \|\| ''\)\.trim\(\),/);
  assert.doesNotMatch(src, /BODY_MAX/);
  const long = 'x'.repeat(9000);
  assert.strictEqual(A.emailFor({ title: 'T', body: long }, null).body.length, 9000, 'the email carries all of it');
});

test('a caregiver\'s Home shows new announcements, like everyone else\'s My GFC Home', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'caregiver.html'), 'utf8');
  assert.match(page, /\(announcements \|\| \[\]\)\.filter\(a => !a\.reviewedAt\)/);
  assert.match(page, /New announcement: \$\{news\[0\]\.title\}/);
  assert.match(page, /<button onClick=\{onOpenFeed\}/, 'the banner itself opens the Feed');
  assert.match(page, /announcements=\{announcements\} onOpenFeed=\{\(\) => setTab\('feed'\)\}/);
});
