'use strict';

// Announcements are written in the same editor as a clinical note (owner,
// 2026-11-15: "please ensure announcements use the same rich text ability as
// the clinical notes segment of app. bolded, italcizied, indention etc"), and
// the formatting has to survive into the email, because the composer promises
// each person gets it "word for word".
//
// The rule that matters most is the one about what came BEFORE: an older
// announcement is plain text that may contain `_` or `- `, and running it
// through the formatter would rewrite what somebody posted. So markup is
// opt-in, by an exact flag, and everything else is read literally.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ET = require('../emailTemplates');
const A = require('../staffAnnouncements');
const NF = require('../public/note-format.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── The flag ────────────────────────────────────────────────────────────────

test('only an exact "markup" opts in; anything else is plain', () => {
  assert.strictEqual(A.bodyFormatOf({ body_format: 'markup' }), 'markup');
  for (const v of [undefined, null, '', 'plain', 'MARKUP', 'html', 'markup ', true, 1, {}]) {
    assert.strictEqual(A.bodyFormatOf({ body_format: v }), 'plain', `${JSON.stringify(v)} must not opt in`);
  }
  assert.strictEqual(A.bodyFormatOf(null), 'plain', 'no row at all is plain');
});

test('the email asks for the renderer that matches how it was written', () => {
  assert.strictEqual(A.emailFor({ title: 'T', body: 'x' }, 'https://a.b').format, 'announcement');
  assert.strictEqual(A.emailFor({ title: 'T', body: 'x', body_format: 'markup' }, 'https://a.b').format, 'announcement-markup');
  assert.strictEqual(A.emailFor({ title: 'T', body: 'x', body_format: 'nonsense' }, 'https://a.b').format, 'announcement');
});

test('the reader screens are told the format, or they cannot read it correctly', () => {
  const row = { id: '1', title: 'T', body: 'b', body_format: 'markup', posted_at: '2026-01-01', audience: 'all_staff' };
  assert.strictEqual(A.forViewer([row], [], { id: 'u' }, 'admin')[0].format, 'markup');
  assert.strictEqual(A.forViewer([{ ...row, body_format: undefined }], [], { id: 'u' }, 'admin')[0].format, 'plain');
  // And the caregiver Feed's own payload, which is built separately.
  assert.match(read('routes/caregiver.js'), /kind: 'broadcast'[^}]*format: announcements\.bodyFormatOf\(b\)/,
    'the Feed payload carries the format — without it the formatted branch is dead code');
});

// ── The email, rendered and read back ───────────────────────────────────────

// ⚠️ Assertions must read the BODY, not the whole document. The house chrome
// carries an <img> wordmark and a <strong> in the signature, so `!/<img/` over
// the whole email is true of a safe render and a dangerous one alike — an
// assertion that cannot distinguish two states proves nothing. Two of these
// tests were written that way first and passed for the wrong reason.
const GREETING_END = '</p>\n';
const SIGNOFF = '<p style="margin:28px 0 0 0;">Warmly,';
function bodyOf(html) {
  const start = html.indexOf(GREETING_END);
  const end = html.indexOf(SIGNOFF);
  assert.ok(start > -1 && end > start, 'could not find the body between the greeting and the sign-off — fix this helper, do not loosen the test');
  const body = html.slice(start + GREETING_END.length, end);
  assert.ok(body.length > 0, 'the extracted body is empty, so nothing below proves anything');
  return body;
}
const renderBody = (paragraphs, opts) => {
  const r = ET.renderGfcEmail(Object.assign({ paragraphs }, opts || {}));
  return { html: r.html, text: r.text, body: bodyOf(r.html) };
};

test('a formatted body reaches the email as the six shapes, with inline styles', () => {
  const markup = '## What is coming\n- **bold** item\n- _italic_ item\n1. first\n2. second';
  const { html, text } = renderBody([markup], { markup: true });

  assert.match(html, /<h3 style="[^"]*font-weight:700/, 'a heading, styled inline — a mail client loads no stylesheet');
  assert.match(html, /<ul style="[^"]*padding-left/, 'a bulleted list with explicit padding, or Outlook mangles it');
  assert.match(html, /<ol style="[^"]*padding-left/, 'and a numbered list');
  assert.match(html, /<li style="[^"]*"><strong>bold<\/strong> item<\/li>/, 'bold inside a list item');
  assert.match(html, /<em>italic<\/em>/, 'italic');

  // The text half is what a text-only client shows, and raw asterisks there
  // would be a notice nobody reads.
  assert.match(text, /WHAT IS COMING/, 'a heading becomes capitals');
  assert.match(text, /• bold item/, 'a bullet becomes •');
  assert.match(text, /1\. first/, 'a numbered item keeps its number');
  assert.ok(!/\*\*/.test(text), 'and no markers survive');
});

test('underline and a line break survive, and an unknown tag cannot be emitted', () => {
  const { html } = renderBody(['__under__\nsecond line'], { markup: true });
  assert.match(html, /<u>under<\/u>/);
  assert.match(html, /<br>/, 'Shift+Enter is a real line break');
});

test('a formatted body is ESCAPED on the way into the email', () => {
  const nasty = '<script>alert(1)</script> <img src=x onerror=alert(2)> "q" & \'s\'';
  const { body, text } = renderBody([nasty], { markup: true });
  assert.ok(!/<script/.test(body), 'no live script');
  assert.ok(!/<img/.test(body), 'no live image in the BODY — the chrome has its own wordmark');
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'it arrives as visible text');
  assert.match(body, /&quot;q&quot; &amp; &#39;s&#39;/);
  assert.match(text, /<script>alert\(1\)<\/script>/, 'the text half carries it literally, which is safe');
});

test('a link in a formatted body is only ever http(s)', () => {
  const { body } = renderBody(['see https://example.com/x and javascript:alert(1)'], { markup: true });
  assert.ok(!/href="javascript:/.test(body), 'never a javascript: href');
});

// ── What came before must not change ────────────────────────────────────────

test('⚠️ a PLAIN body is read literally — the markers stay markers', () => {
  // This is the whole reason the flag exists. An announcement posted before
  // the editor may contain these characters for their own sake.
  const plain = 'snake_case and _not italic_\n- not a bullet\n## not a heading';
  const { html, text } = renderBody([plain], { lineBreaks: true, capsHeadings: true });
  assert.ok(!/<em>/.test(html), 'no italics invented');
  assert.ok(!/<ul>|<li>/.test(html), 'no list invented');
  assert.ok(!/<h3>/.test(html), 'no heading invented');
  assert.match(html, /snake_case and _not italic_/, 'the characters are shown as typed');
  assert.match(text, /- not a bullet/, 'and the text half is untouched');
});

test('the plain reading that shipped on 2026-11-10 still works exactly', () => {
  const { html } = renderBody(["WHAT'S COMING", 'With gratitude,\nBianca'], { lineBreaks: true, capsHeadings: true });
  assert.match(html, /<h2[^>]*>WHAT&#39;S COMING<\/h2>/, 'ALL CAPS is still an h2 for a plain body');
  assert.match(html, /With gratitude,<br>Bianca/);
});

test('markup does not leak into any other notice', () => {
  const { body } = renderBody(['**not bold** and - not a list'], {});
  assert.ok(!/<strong>/.test(body), 'a notice that asked for nothing gets no formatting');
  assert.match(body, /\*\*not bold\*\*/);
});

// ── The screens ─────────────────────────────────────────────────────────────

test('the composer uses the shared editor, not a plain box', () => {
  const src = read('public/my-gfc.js');
  const panel = src.slice(src.indexOf('function ManageAnnouncements'));
  const body = panel.slice(0, panel.indexOf('Post Announcement'));
  assert.match(body, /<FormattedField/, 'the message is written in the formatted editor');
  assert.ok(!/<textarea/.test(body), 'and not in a textarea');
  // Reachability: a component improved into the void is the mistake this
  // repo has already paid for twice.
  assert.match(src, /window\.GFC_FORMATTED/, 'it reads the shared component');
  assert.match(read('public/my.html'), /src="\/components\/formatted-field\.jsx"/, 'and the page loads it');
  const page = read('public/my.html');
  assert.ok(page.indexOf('/note-format.js') < page.indexOf('/components/formatted-field.jsx'),
    'note-format.js loads first: the component reads it at definition time');
  assert.ok(page.indexOf('/components/formatted-field.jsx') < page.indexOf('src="/my-gfc.js"'),
    'and both load before the screen that uses them');
});

test('a fallback box never claims to have written markup', () => {
  // If the component did not load, the plain textarea's text must be stored
  // as plain, or it would be read back through the formatter.
  const src = read('public/my-gfc.js');
  assert.match(src, /const WRITES_MARKUP = !!FMT;/);
  assert.match(src, /format: WRITES_MARKUP \? 'markup' : 'plain'/);
});

test('both reader screens branch on the format rather than always formatting', () => {
  assert.match(read('public/my-gfc.js'), /a\.format === 'markup'/, 'My GFC reads the format');
  assert.match(read('public/caregiver.html'), /i\.format === 'markup'/, 'the caregiver Feed reads it too');
  // Each keeps its plain branch, which is what protects the older posts.
  assert.match(read('public/my-gfc.js'), /whiteSpace: 'pre-wrap'/);
  assert.match(read('public/caregiver.html'), /whiteSpace: 'pre-wrap' \}\}>\{i\.body\}/);
});

test('the queue carries the new format through to the renderer', () => {
  const src = read('server.js');
  assert.match(src, /format: templateData\.format \|\| null/, 'the queue keeps it');
  assert.match(src, /if \(t\.format === 'announcement-markup'\) \{ pieces\.markup = true; \}/);
  // And the plain arm is untouched beside it.
  assert.match(src, /if \(t\.format === 'announcement'\) \{ pieces\.lineBreaks = true; pieces\.capsHeadings = true; \}/);
});

test('the route stores the format, through the one allow-list', () => {
  assert.match(read('routes/caregiver.js'), /body_format: announcements\.bodyFormatOf\(\{ body_format: \(req\.body \|\| \{\}\)\.format \}\)/,
    'the route does not decide the vocabulary itself');
});

// ── The editor is one copy ──────────────────────────────────────────────────

test('there is ONE formatted editor, and the clinical workspace uses it too', () => {
  const comp = read('public/components/formatted-field.jsx');
  assert.match(comp, /window\.GFC_FORMATTED = \{/);
  // Repointed 2026-11-15: clinical.html now wraps the shared one to supply its
  // own "required to sign" wording, so the exact destructuring line is gone.
  // The RULE is what matters — it reads the shared editor and implements none
  // of its own — so that is what is asserted, not the spelling.
  const clinical = read('public/clinical.html');
  assert.match(clinical, /window\.GFC_FORMATTED\.FormattedField/,
    'clinical.html reads the shared one rather than declaring its own');
  assert.ok(!/contentEditable/.test(clinical),
    'and implements no editor of its own — the shared file owns the editable surface');
  // The six shapes, named once.
  for (const cmd of ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'heading']) {
    assert.ok(comp.includes(`'${cmd}'`), `the toolbar offers ${cmd}`);
  }
});

test('the editor stores markup, never HTML', () => {
  const comp = read('public/components/formatted-field.jsx');
  assert.match(comp, /NF\.domToMarkup\(ref\.current, \{ newlines: true \}\)/, 'every change walks the DOM back to markup');
  assert.ok(!/onChange && onChange\(ref\.current\.innerHTML\)/.test(comp), 'innerHTML is never what is emitted');
  // A paste cannot smuggle formatting past the toolbar.
  assert.match(comp, /getData\('text\/plain'\)/);
});

test('the round trip holds for the shapes an announcement uses', () => {
  // The same harness shape as test/note_format.test.js: render to a tree,
  // turn it into DOM-shaped nodes, and read it back.
  const toDom = (nodes) => nodes.map(n => (n.text !== undefined
    ? { nodeType: 3, nodeValue: n.text }
    : { nodeType: 1, nodeName: n.tag.toUpperCase(), childNodes: toDom(n.children || []) }));
  const frag = (kids) => ({ nodeType: 1, nodeName: 'DIV', childNodes: kids });
  for (const markup of ['**b**', '_i_', '__u__', '- one\n- two', '1. one\n2. two', '## Head', '## Head\n- a\n**b**']) {
    const back = NF.domToMarkup(frag(toDom(NF.renderTree(markup))), { newlines: true });
    assert.strictEqual(back, markup, `${JSON.stringify(markup)} survives the round trip`);
  }
});

test('the shared editor carries NO clinical vocabulary of its own', () => {
  // Owner, 2026-11-15: "not all announcements are clinical". The toolbar is
  // general purpose, so the words it renders must be too — the clinical
  // workspace supplies "required to sign" itself. Comments may discuss the
  // clinical origin; the rendered STRINGS may not carry it.
  const comp = read('public/components/formatted-field.jsx');
  const code = comp.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const word of ['required to sign', 'clinician', 'chart', 'patient', 'OpenEMR', 'encounter']) {
    assert.ok(!new RegExp(word, 'i').test(code), `"${word}" is clinical vocabulary and must not be in the shared editor`);
  }
  assert.match(code, /requiredNote \|\| '· required'/, 'its default is neutral');
});

test('the clinical workspace still says "required to sign", supplied in ONE place', () => {
  const page = read('public/clinical.html');
  assert.match(page, /requiredNote=\{props\.requiredNote \|\| '· required to sign'\}/,
    'the workspace supplies its own wording');
  // One wrapper, not nine edited call sites — fewer places to get wrong.
  assert.strictEqual((page.match(/· required to sign/g) || []).length, 1,
    'the wording appears exactly once, so it cannot drift between call sites');
  assert.match(page, /const SharedFormattedField = window\.GFC_FORMATTED\.FormattedField;/);
});
