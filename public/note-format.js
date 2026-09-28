// ============================================================
// GODWINS FAMILY CARE — NOTE FORMATTING (one source for all three readers)
//
// A clinical note field can carry bold, italic, underline, bulleted and
// numbered lists and section headings (owner, 2026-09-27). The editor, the
// OpenEMR note text and the signed-note PDF all read the SAME six rules from
// this file, so what a clinician formats is what every copy shows.
//
// WHAT IS STORED IS NOT HTML. A note is a small line-based markup:
//
//   ## Heading          - bullet            1. numbered
//   **bold**   __underline__   _italic_     \ escapes a literal * _ or \
//
// Only these shapes are ever produced. The editor's DOM is WALKED into them
// (domToMarkup) and nothing else survives — a paste from Word or a web page is
// reduced to its text plus these six shapes, so no foreign markup can reach a
// record. Rendering ESCAPES every character of text before applying a shape,
// so nothing a person types can become live HTML.
//
// Formatting markers are TOGGLES, emitted only where a format changes between
// two runs of text. Toggles commute, so "___" means "underline and italic
// changed here" whichever way it is split — that is what makes a round trip
// through the editor exact.
//
// OpenEMR's note field is plain text. toPlainText keeps the STRUCTURE (bullets,
// numbers, headings in capitals) and drops bold/italic/underline rather than
// leaving asterisks through a note, which reads worse than no emphasis.
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GFC_NOTE_FORMAT = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const INLINE_ESCAPES = ['\\', '*', '_'];
  const LINE_PREFIX = /^(## |- |\d+\. )/;

  // ---- Parsing ----------------------------------------------------------
  // One line of inline markup → runs of { text, b, i, u }.
  const parseInline = (line) => {
    const runs = [];
    const state = { b: false, i: false, u: false };
    let buf = '';
    const flush = () => {
      if (buf) runs.push({ text: buf, b: state.b, i: state.i, u: state.u });
      buf = '';
    };
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '\\' && k + 1 < line.length && INLINE_ESCAPES.includes(line[k + 1])) {
        buf += line[k + 1]; k++; continue;
      }
      if (ch === '*' && line[k + 1] === '*') { flush(); state.b = !state.b; k++; continue; }
      if (ch === '_' && line[k + 1] === '_') { flush(); state.u = !state.u; k++; continue; }
      if (ch === '_') { flush(); state.i = !state.i; continue; }
      buf += ch;
    }
    flush();
    return runs;
  };

  // Markup → blocks: { type: 'h' | 'ul' | 'ol' | 'p' | 'blank', n?, runs }
  const parse = (markup) => {
    const text = String(markup == null ? '' : markup).replace(/\r\n?/g, '\n');
    if (!text) return [];
    return text.split('\n').map((raw) => {
      if (raw.startsWith('## ')) return { type: 'h', runs: parseInline(raw.slice(3)) };
      if (raw.startsWith('- ')) return { type: 'ul', runs: parseInline(raw.slice(2)) };
      const num = raw.match(/^(\d+)\. /);
      if (num) return { type: 'ol', n: Number(num[1]), runs: parseInline(raw.slice(num[0].length)) };
      // A literal line that merely LOOKS like a prefix was escaped by the
      // serializer with one leading backslash.
      const body = /^\\(## |- |\d+\. )/.test(raw) ? raw.slice(1) : raw;
      const runs = parseInline(body);
      return runs.length ? { type: 'p', runs } : { type: 'blank', runs: [] };
    });
  };

  // ---- Serializing ------------------------------------------------------
  const escapeInline = (s) => String(s).replace(/[\\*_]/g, (c) => '\\' + c);

  // Runs → one line of markup, emitting a toggle only where a format changes.
  const serializeRuns = (runs) => {
    const cur = { b: false, u: false, i: false };
    let out = '';
    // Closes innermost-first and opens outermost-first, so "**__x__**" reads
    // as nested. Order does not change the meaning — toggles commute.
    const toggleTo = (next) => {
      if (cur.i && !next.i) { out += '_'; cur.i = false; }
      if (cur.u && !next.u) { out += '__'; cur.u = false; }
      if (cur.b && !next.b) { out += '**'; cur.b = false; }
      if (!cur.b && next.b) { out += '**'; cur.b = true; }
      if (!cur.u && next.u) { out += '__'; cur.u = true; }
      if (!cur.i && next.i) { out += '_'; cur.i = true; }
    };
    for (const r of runs) {
      if (!r || !r.text) continue;
      toggleTo({ b: !!r.b, u: !!r.u, i: !!r.i });
      out += escapeInline(r.text);
    }
    toggleTo({ b: false, u: false, i: false });
    return out;
  };

  const serializeBlocks = (blocks) => blocks.map((bl) => {
    const body = serializeRuns(bl.runs || []);
    if (bl.type === 'h') return '## ' + body;
    if (bl.type === 'ul') return '- ' + body;
    if (bl.type === 'ol') return `${bl.n || 1}. ` + body;
    if (bl.type === 'blank') return '';
    return LINE_PREFIX.test(body) ? '\\' + body : body;
  }).join('\n');

  // Legacy plain text (a note written before formatting existed, or text read
  // back from OpenEMR) becomes markup with every literal preserved — an
  // underscore in an old note must not turn the rest of the line italic.
  const fromPlainText = (text) => serializeBlocks(
    String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
      .map((line) => line ? { type: 'p', runs: [{ text: line }] } : { type: 'blank', runs: [] })
  );

  // ---- The editor's DOM → markup ----------------------------------------
  // Works on anything shaped like a DOM node ({ nodeType, nodeName, nodeValue,
  // childNodes }) so the same function is exercised in Node tests. Unknown
  // elements contribute their TEXT only; styles, classes, links, images and
  // scripts are never carried.
  const BLOCK = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR']);
  const HEADING = /^H[1-6]$/;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK']);

  const domToMarkup = (rootNode) => {
    const lines = [];
    let cur = { type: 'p', runs: [] };
    const hasContent = () => cur.runs.some(r => r.text);
    const push = (force) => {
      if (force || hasContent()) lines.push(cur);
      cur = { type: 'p', runs: [] };
    };
    const walk = (node, fmt, list) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const t = String(node.nodeValue || '').replace(/[\r\n\t]+/g, ' ').replace(/ /g, ' ');
        if (t) cur.runs.push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u });
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
      const name = String(node.nodeName || '').toUpperCase();
      if (SKIP.has(name)) return;
      const kids = Array.from(node.childNodes || []);
      const walkKids = (f, l) => kids.forEach(k => walk(k, f, l));
      if (name === 'BR') { push(true); return; }
      if (name === 'B' || name === 'STRONG') return walkKids({ ...fmt, b: true }, list);
      if (name === 'I' || name === 'EM') return walkKids({ ...fmt, i: true }, list);
      if (name === 'U' || name === 'INS') return walkKids({ ...fmt, u: true }, list);
      if (HEADING.test(name)) {
        push(false); cur.type = 'h'; walkKids(fmt, list); push(false); return;
      }
      if (name === 'UL' || name === 'OL') {
        push(false);
        walkKids(fmt, { type: name === 'OL' ? 'ol' : 'ul', count: 0 });
        push(false); return;
      }
      if (name === 'LI') {
        push(false);
        const l = list || { type: 'ul', count: 0 };
        l.count += 1;
        cur.type = l.type; if (l.type === 'ol') cur.n = l.count;
        walkKids(fmt, null);
        push(false); return;
      }
      if (BLOCK.has(name)) { push(false); walkKids(fmt, list); push(false); return; }
      walkKids(fmt, list);
    };
    walk(rootNode, { b: false, i: false, u: false }, null);
    push(false);
    // A <div><br></div> is one blank line; trim blanks at either end.
    const blocks = lines.map(bl => (bl.runs.some(r => r.text.trim()) ? bl : { type: 'blank', runs: [] }));
    while (blocks.length && blocks[0].type === 'blank') blocks.shift();
    while (blocks.length && blocks[blocks.length - 1].type === 'blank') blocks.pop();
    return serializeBlocks(blocks);
  };

  // ---- Rendering --------------------------------------------------------
  // A neutral tree { tag, children } | { text } — escaped HTML is produced from
  // it by renderHtml, and the tests turn the same tree into DOM-shaped nodes to
  // prove the round trip. Text is only ever a text node: never markup.
  const runNode = (r) => {
    let node = { text: r.text };
    if (r.u) node = { tag: 'u', children: [node] };
    if (r.i) node = { tag: 'em', children: [node] };
    if (r.b) node = { tag: 'strong', children: [node] };
    return node;
  };
  const renderTree = (markup) => {
    const out = [];
    let list = null;
    for (const bl of parse(markup)) {
      const kids = bl.runs.map(runNode);
      if (bl.type === 'ul' || bl.type === 'ol') {
        const tag = bl.type;
        if (!list || list.tag !== tag) { list = { tag, children: [] }; out.push(list); }
        list.children.push({ tag: 'li', children: kids });
        continue;
      }
      list = null;
      if (bl.type === 'h') out.push({ tag: 'h3', children: kids });
      else if (bl.type === 'blank') out.push({ tag: 'div', children: [{ tag: 'br', children: [] }] });
      else out.push({ tag: 'div', children: kids });
    }
    return out;
  };
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const treeToHtml = (nodes) => nodes.map((n) => {
    if (n.text !== undefined) return escapeHtml(n.text);
    if (n.tag === 'br') return '<br>';
    return `<${n.tag}>${treeToHtml(n.children || [])}</${n.tag}>`;
  }).join('');
  const renderHtml = (markup) => treeToHtml(renderTree(markup));

  // ---- Plain text for OpenEMR -------------------------------------------
  const runsText = (runs) => runs.map(r => r.text).join('');
  const toPlainText = (markup) => parse(markup).map((bl) => {
    const t = runsText(bl.runs);
    if (bl.type === 'h') return t.toUpperCase();
    if (bl.type === 'ul') return '• ' + t;
    if (bl.type === 'ol') return `${bl.n}. ` + t;
    return t;
  }).join('\n');

  // Blocks for a PDF renderer: each block's runs keep their b/i/u flags.
  const toBlocks = (markup) => parse(markup);

  // Blank means no WORDS — not "no characters". A list the editor opened and
  // nobody typed into is "- ", and counting that as written would let an empty
  // required section satisfy the sign gate.
  const isBlank = (markup) => !parse(markup).some(bl => runsText(bl.runs).trim());

  return {
    parse, parseInline, serializeRuns, serializeBlocks, fromPlainText,
    domToMarkup, renderTree, renderHtml, escapeHtml, toPlainText, toBlocks, isBlank
  };
});
