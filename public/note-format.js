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
//   **bold**   __underline__   _italic_   ~~strikethrough~~
//   \ escapes a literal * _ ~ or \
//
// Strikethrough (2026-10-16, messaging) is produced only where a caller asks
// for it (domToMarkup's `strike` option); the clinical note editor does not,
// because OpenEMR's plain-text copy cannot show a line through words and a
// struck-out phrase would read there as if it were still meant.
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
  const INLINE_ESCAPES = ['\\', '*', '_', '~'];
  const LINE_PREFIX = /^(## |- |\d+\. )/;

  // ---- Parsing ----------------------------------------------------------
  // One line of inline markup → runs of { text, b, i, u }.
  const parseInline = (line) => {
    const runs = [];
    const state = { b: false, i: false, u: false, s: false };
    let buf = '';
    const flush = () => {
      if (buf) runs.push({ text: buf, b: state.b, i: state.i, u: state.u, s: state.s });
      buf = '';
    };
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '\\' && k + 1 < line.length && INLINE_ESCAPES.includes(line[k + 1])) {
        buf += line[k + 1]; k++; continue;
      }
      if (ch === '*' && line[k + 1] === '*') { flush(); state.b = !state.b; k++; continue; }
      if (ch === '_' && line[k + 1] === '_') { flush(); state.u = !state.u; k++; continue; }
      if (ch === '~' && line[k + 1] === '~') { flush(); state.s = !state.s; k++; continue; }
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
  const escapeInline = (s) => String(s).replace(/[\\*_~]/g, (c) => '\\' + c);

  // Runs → one line of markup, emitting a toggle only where a format changes.
  const serializeRuns = (runs) => {
    const cur = { b: false, u: false, i: false, s: false };
    let out = '';
    // Closes innermost-first and opens outermost-first, so "**__x__**" reads
    // as nested. Order does not change the meaning — toggles commute.
    const toggleTo = (next) => {
      if (cur.i && !next.i) { out += '_'; cur.i = false; }
      if (cur.u && !next.u) { out += '__'; cur.u = false; }
      if (cur.s && !next.s) { out += '~~'; cur.s = false; }
      if (cur.b && !next.b) { out += '**'; cur.b = false; }
      if (!cur.b && next.b) { out += '**'; cur.b = true; }
      if (!cur.s && next.s) { out += '~~'; cur.s = true; }
      if (!cur.u && next.u) { out += '__'; cur.u = true; }
      if (!cur.i && next.i) { out += '_'; cur.i = true; }
    };
    for (const r of runs) {
      if (!r || !r.text) continue;
      toggleTo({ b: !!r.b, u: !!r.u, i: !!r.i, s: !!r.s });
      out += escapeInline(r.text);
    }
    toggleTo({ b: false, u: false, i: false, s: false });
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

  // Inline style, for pastes from Google Docs and Word: they mark bold as
  // <span style="font-weight:700"> and wrap a whole paste in
  // <b style="font-weight:normal">, so the tag alone says the wrong thing.
  const styleOf = (node) => {
    const raw = typeof node.getAttribute === 'function' ? node.getAttribute('style') : node.style;
    return typeof raw === 'string' ? raw.toLowerCase() : '';
  };
  const styledFormat = (style, fmt, strike) => {
    if (!style) return fmt;
    const out = { ...fmt };
    const w = style.match(/font-weight\s*:\s*([a-z0-9]+)/);
    if (w) out.b = w[1] === 'bold' || w[1] === 'bolder' || Number(w[1]) >= 600;
    const st = style.match(/font-style\s*:\s*([a-z]+)/);
    if (st) out.i = st[1] === 'italic' || st[1] === 'oblique';
    const deco = style.match(/text-decoration(?:-line)?\s*:\s*([^;]+)/);
    if (deco) {
      out.u = /underline/.test(deco[1]);
      if (strike) out.s = /line-through/.test(deco[1]);
    }
    return out;
  };

  // `opts.strike`: keep strikethrough (messaging). `opts.newlines`: a line
  // break typed in the editor (Shift+Enter, which the browser stores as a bare
  // newline in a pre-wrap box) is a real line break, not a space. Leave it off
  // for HTML from elsewhere, where a newline in the source is only spacing.
  const domToMarkup = (rootNode, opts) => {
    const strike = !!(opts && opts.strike);
    const newlines = !!(opts && opts.newlines);
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
        const raw = String(node.nodeValue || '').replace(/\r\n?/g, '\n');
        const parts = newlines ? raw.split('\n') : [raw];
        parts.forEach((part, idx) => {
          if (idx > 0) push(true);
          const t = part.replace(/[\n\t]+/g, ' ').replace(/\u00a0/g, ' ');
          if (t) cur.runs.push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u, s: !!fmt.s });
        });
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
      const name = String(node.nodeName || '').toUpperCase();
      if (SKIP.has(name)) return;
      const kids = Array.from(node.childNodes || []);
      const walkKids = (f, l) => kids.forEach(k => walk(k, f, l));
      if (name === 'BR') { push(true); return; }
      const style = styleOf(node);
      // Word's own list bullets ("·", "1.") sit in a span it marks as ignorable.
      if (/mso-list\s*:\s*ignore/.test(style)) return;
      const INLINE_TAG = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's' };
      const tagFmt = INLINE_TAG[name];
      if (tagFmt && (tagFmt !== 's' || strike)) fmt = { ...fmt, [tagFmt]: true };
      fmt = styledFormat(style, fmt, strike);
      if (tagFmt) return walkKids(fmt, list);
      // A Word list paragraph is a bulleted line.
      if (name === 'P' && /mso-list\s*:/.test(style)) {
        push(false); cur.type = 'ul'; walkKids(fmt, null); push(false); return;
      }
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
      // A block opening at the very start of a list item or heading (Google
      // Docs wraps every <li> in a <p>) must not drop the line's type.
      if (BLOCK.has(name)) { if (hasContent()) push(false); walkKids(fmt, list); push(false); return; }
      walkKids(fmt, list);
    };
    walk(rootNode, { b: false, i: false, u: false, s: false }, null);
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
  // `linkify`: a web address in the text becomes a link that opens in a new
  // tab (messages). Only http(s); the address is escaped like any other text.
  const URL_RE = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;
  const textNodes = (text, linkify) => {
    if (!linkify) return [{ text }];
    const out = []; let last = 0; let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ tag: 'a', href: m[0], children: [{ text: m[0] }] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out.length ? out : [{ text }];
  };
  const runNode = (r, linkify) => {
    const parts = textNodes(r.text, linkify);
    let node = parts.length === 1 ? parts[0] : { tag: 'span', children: parts };
    if (r.s) node = { tag: 's', children: [node] };
    if (r.u) node = { tag: 'u', children: [node] };
    if (r.i) node = { tag: 'em', children: [node] };
    if (r.b) node = { tag: 'strong', children: [node] };
    return node;
  };
  const renderTree = (markup, opts) => {
    const linkify = !!(opts && opts.linkify);
    const out = [];
    let list = null;
    for (const bl of parse(markup)) {
      const kids = bl.runs.map(r => runNode(r, linkify));
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
    if (n.tag === 'a') {
      return `<a href="${escapeHtml(n.href)}" target="_blank" rel="noopener noreferrer">${treeToHtml(n.children || [])}</a>`;
    }
    return `<${n.tag}>${treeToHtml(n.children || [])}</${n.tag}>`;
  }).join('');
  const renderHtml = (markup, opts) => treeToHtml(renderTree(markup, opts));

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
