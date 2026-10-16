const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const nf = require('../public/note-format.js');

// DOM-shaped nodes from the render tree — the same structure the browser
// builds when the editor loads a note — so the round trip below exercises the
// real converter, not a hand-written approximation of it.
const toDom = (nodes) => nodes.map((n) => (n.text !== undefined
  ? { nodeType: 3, nodeName: '#text', nodeValue: n.text, childNodes: [] }
  : { nodeType: 1, nodeName: n.tag.toUpperCase(), childNodes: toDom(n.children || []) }));
const frag = (children) => ({ nodeType: 11, nodeName: '#document-fragment', childNodes: children });
const el = (tag, ...children) => ({ nodeType: 1, nodeName: tag, childNodes: children });
const txt = (value) => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
const roundTrip = (markup) => nf.domToMarkup(frag(toDom(nf.renderTree(markup))));

test('a round trip through the editor preserves all six shapes exactly', () => {
  const markup = [
    '## Assessment',
    'Patient **reports** _improved_ __sleep__ and **__both__** things.',
    '- first bullet',
    '- second **bold** bullet',
    '',
    '1. step one',
    '2. step _two_',
    'Plain line with a literal \\* star and a snake\\_case word.'
  ].join('\n');
  assert.equal(roundTrip(markup), markup);
});

test('toggles commute, so stacked formats survive any split', () => {
  for (const m of ['**__x__**', '_a___b__', '**_**b**_**', '__**_x_**__ tail']) {
    const once = roundTrip(m);
    assert.equal(roundTrip(once), once, `${m} must be stable after one round trip`);
    assert.equal(nf.toPlainText(once), nf.toPlainText(m), `${m} keeps its text`);
  }
});

test('a line that merely LOOKS like a list or heading stays a paragraph', () => {
  const dom = frag([el('DIV', txt('- not a bullet')), el('DIV', txt('2. not numbered')), el('DIV', txt('## not a heading'))]);
  const markup = nf.domToMarkup(dom);
  const blocks = nf.parse(markup);
  assert.deepEqual(blocks.map(b => b.type), ['p', 'p', 'p']);
  assert.equal(nf.toPlainText(markup), '- not a bullet\n2. not numbered\n## not a heading');
});

test('HTML typed or pasted into a note renders as TEXT, never as markup', () => {
  const hostile = '<script>alert(1)</script> <img src=x onerror=alert(2)> "quoted" & \'single\'';
  const markup = nf.domToMarkup(frag([el('DIV', txt(hostile))]));
  const html = nf.renderHtml(markup);
  assert.ok(!/<script/i.test(html), 'no live script tag');
  assert.ok(!/<img/i.test(html), 'no live img tag');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; &#39;single&#39;/);
});

test('a pasted script ELEMENT, style, link or image contributes nothing', () => {
  const dom = frag([
    el('DIV', txt('kept')),
    el('SCRIPT', txt('alert(1)')),
    el('STYLE', txt('body{}')),
    el('DIV', el('SPAN', txt('span text kept')), el('A', txt('link text kept')))
  ]);
  const markup = nf.domToMarkup(dom);
  assert.equal(markup, 'kept\nspan text keptlink text kept');
  assert.ok(!/alert|body\{\}/.test(markup));
});

test('the renderer escapes BEFORE it formats (build-enforced)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/note-format.js'), 'utf8');
  const fn = src.slice(src.indexOf('const treeToHtml'), src.indexOf('const renderHtml'));
  assert.match(fn, /n\.text !== undefined\) return escapeHtml\(n\.text\)/, 'every text node goes through escapeHtml');
  assert.ok(!/innerHTML/.test(src), 'the module never writes innerHTML itself');
});

test('the OpenEMR text keeps structure and drops emphasis markers', () => {
  const markup = '## Plan\n**Bold** _italic_ __under__\n- bullet\n1. numbered\nescaped \\* star';
  const plain = nf.toPlainText(markup);
  assert.equal(plain, 'PLAN\nBold italic under\n• bullet\n1. numbered\nescaped * star');
  assert.ok(!/\*\*|__|(^|[^a-z])_[a-z]/i.test(plain), 'no ** __ or _ markers reach OpenEMR');
});

test('legacy plain text is carried in with every literal preserved', () => {
  const legacy = 'dose_mg 5 * 2\n- dash line\n\nsecond para';
  const markup = nf.fromPlainText(legacy);
  assert.equal(nf.toPlainText(markup), legacy);
  assert.deepEqual(nf.parse(markup).map(b => b.type), ['p', 'p', 'blank', 'p']);
});

test('the editor\'s own elements map to the six shapes', () => {
  const dom = frag([
    el('H2', txt('History')),
    el('DIV', el('B', txt('bold')), txt(' '), el('I', txt('ital')), txt(' '), el('U', txt('und'))),
    el('UL', el('LI', txt('a')), el('LI', txt('b'))),
    el('OL', el('LI', txt('one')), el('LI', txt('two'))),
    el('DIV', el('BR')),
    el('DIV', txt('after'))
  ]);
  assert.equal(nf.domToMarkup(dom), '## History\n**bold** _ital_ __und__\n- a\n- b\n1. one\n2. two\n\nafter');
});

test('blank lines at either end are trimmed; empty input is blank', () => {
  assert.equal(nf.domToMarkup(frag([el('DIV', el('BR')), el('DIV', txt('x')), el('DIV', el('BR'))])), 'x');
  assert.equal(nf.isBlank(''), true);
  assert.equal(nf.isBlank('**  **'), true);
  assert.equal(nf.isBlank('- a'), false);
});

test('the page loads the module and never restates the rules', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/clinical.html'), 'utf8');
  assert.match(page, /<script src="\/note-format\.js"><\/script>/);
});

// ============================================================
// Owner, 2026-10-16: messaging formatting "needs to be richer... it shows
// oddly when saved, the formatting goes or when copied it leaves".
// ============================================================
const styled = (tag, style, ...children) => ({ nodeType: 1, nodeName: tag, childNodes: children, getAttribute: (a) => (a === 'style' ? style : null) });
const STRIKE = { strike: true };

test('strikethrough round-trips where it is asked for, and is ignored where it is not (clinical notes)', () => {
  const m = 'Kept ~~struck out~~ and **~~both~~**';
  assert.equal(nf.domToMarkup(frag(toDom(nf.renderTree(m))), STRIKE), m);
  assert.match(nf.renderHtml(m), /<s>struck out<\/s>/);
  assert.equal(nf.toPlainText(m), 'Kept struck out and both', 'the plain copy carries the words, not the marks');
  // The clinical editor does not ask for strike: an <s> pasted there is plain text.
  assert.equal(nf.domToMarkup(frag([el('S', txt('gone'))])), 'gone');
  assert.equal(nf.domToMarkup(frag([styled('SPAN', 'text-decoration:line-through', txt('gone'))])), 'gone');
  // A literal tilde typed or carried in is escaped, never a format.
  const lit = nf.fromPlainText('approx ~5 mg, not ~~ a format');
  assert.equal(nf.toPlainText(lit), 'approx ~5 mg, not ~~ a format');
  assert.ok(!/<s>/.test(nf.renderHtml(lit)));
});

test('a Shift+Enter line break typed in the editor is kept as a line, not turned into a space', () => {
  const box = frag([txt('Second paragraph\nsoft line')]);
  assert.equal(nf.domToMarkup(box, { newlines: true }), 'Second paragraph\nsoft line');
  assert.equal(nf.domToMarkup(box), 'Second paragraph soft line', 'HTML from elsewhere: a source newline is only spacing');
});

test('a Google Docs paste keeps its bold, italic and bullets (inline styles, the font-weight:normal wrapper, <li><p>)', () => {
  const docs = frag([styled('B', 'font-weight:normal;',
    el('P', styled('SPAN', 'font-weight:700;', txt('Docs bold')), styled('SPAN', 'font-weight:400', txt(' and ')),
      styled('SPAN', 'font-style:italic;font-weight:400', txt('italic'))),
    el('UL', el('LI', el('P', styled('SPAN', '', txt('doc bullet'))))),
    el('P', styled('SPAN', 'text-decoration:underline', txt('under')), styled('SPAN', 'text-decoration:line-through', txt(' struck'))))]);
  assert.equal(nf.domToMarkup(docs, STRIKE), '**Docs bold** and _italic_\n- doc bullet\n__under__~~ struck~~');
});

test('a Word paste: a list paragraph is a bullet and Word\'s own bullet character is dropped', () => {
  const word = frag([
    styled('P', 'mso-list:l0 level1 lfo1', styled('SPAN', 'mso-list:Ignore', txt('·  ')), el('B', txt('Word item'))),
    el('P', txt('Word para '), el('U', txt('under')))
  ]);
  assert.equal(nf.domToMarkup(word, STRIKE), '- **Word item**\nWord para __under__');
});

test('links: a web address in a message opens in a new tab; nothing else becomes a link and nothing is unescaped', () => {
  const html = nf.renderHtml('See https://example.com/a?b=1. and javascript:alert(1) or <b>x</b>', { linkify: true });
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/a\?b=1<\/a>\./,
    'the trailing full stop is not part of the link');
  assert.ok(!/href="javascript/.test(html), 'only http(s) is ever a link');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  const quoted = nf.renderHtml('https://a.com/"onmouseover="x', { linkify: true });
  assert.ok(!/"onmouseover/.test(quoted), 'a quote cannot break out of the href');
  assert.ok(!/<a /.test(nf.renderHtml('https://example.com')), 'notes are not linkified unless asked');
  assert.match(nf.renderHtml('https://a.com/?x=1&y=2', { linkify: true }), /href="https:\/\/a\.com\/\?x=1&amp;y=2"/, 'the address is escaped inside the href');
});
