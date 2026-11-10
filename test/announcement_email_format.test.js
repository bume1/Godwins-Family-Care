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
