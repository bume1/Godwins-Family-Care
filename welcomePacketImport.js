// ============================================================================
// READING A RETURNED WELCOME PACKET
// ============================================================================
// A caregiver who filled the packet on their computer and emailed it back should
// not have to type it all again. This module reads one and hands the wizard
// what it found; the wizard shows every value, marked as coming from the
// packet, and the caregiver confirms or corrects it before signing.
//
// TWO WAYS IN, and the difference matters because one is exact and one is not:
//
//   'form'  — the PDF still has the named fields we put in it. Every answer is
//             read by NAME. Nothing is inferred, so nothing can be wrong.
//
//   'text'  — the fields are gone (flattened, printed-and-re-made, or a PDF we
//             did not generate) but the text is still in there. Labels are
//             matched and the text beside them is taken.
//
// THE TEXT PATH FILLS TEXT AND NEVER CHOICES, deliberately. Reading "30 min"
// off a page tells you the words are present, not which box was ticked — the
// option labels all sit next to each other on the printed form, so a match is
// evidence of the QUESTION being there, not of the ANSWER. A wrongly inferred
// "willing to drive clients" is worse than a blank one: blank gets asked, wrong
// gets acted on. Choices are left for the person to confirm on screen.
//
// An image-only scan yields nothing, and says so plainly rather than reporting
// an empty read as a successful one. *An empty result is not a diagnosis* — the
// house rule, and here it is the difference between "your packet had nothing in
// it" and "we cannot read this kind of file".
// ============================================================================

'use strict';

const zlib = require('zlib');
const { PDFDocument, PDFRawStream, PDFName, PDFArray, PDFString, PDFHexString, decodePDFRawStream } = require('pdf-lib');
const wp = require('./welcomePacketRepository');
const pdfNames = require('./welcomePacketPdf');

const SOURCE = Object.freeze({ FORM: 'form', TEXT: 'text', NONE: 'none' });

// ---------------------------------------------------------------------------
// The exact path: named AcroForm fields.
// ---------------------------------------------------------------------------
function readFormFields(pdf) {
  let form;
  try { form = pdf.getForm(); } catch (e) { return null; }
  const fields = form.getFields();
  if (!fields.length) return null;
  const names = new Set(fields.map(f => f.getName()));

  // Is this OUR packet? A PDF can carry a form and have nothing to do with us —
  // a tax form, a lease — and this says plainly that such a file is not read as
  // one.
  //
  // BELT AND BRACES, and recorded as such rather than claimed as a guard: every
  // field is looked up by its full `gfc.`-prefixed name below, so a foreign
  // form yields nothing either way and removing this line changes no behaviour
  // (mutation-checked — it is the one mutation in this file's set that no test
  // can catch). It stays because it states the intent, and because it is what
  // would still hold the line if a later session ever read a field by a bare
  // name. Do not add such a read on the strength of this check alone.
  const ours = [...names].some(n => n.startsWith(`${pdfNames.PREFIX}.`));
  if (!ours) return null;

  const values = {};
  const found = [];

  const textOf = (name) => {
    if (!names.has(name)) return null;
    try {
      const v = form.getTextField(name).getText();
      return v == null ? null : String(v).trim();
    } catch (e) { return null; }
  };

  for (const section of wp.PACKET_SECTIONS) {
    for (const field of section.fields) {
      switch (field.type) {
        case 'single': {
          const name = pdfNames.fieldName(field.id);
          if (!names.has(name)) break;
          let selected = null;
          try { selected = form.getRadioGroup(name).getSelected(); } catch (e) { selected = null; }
          if (selected && field.options.some(o => o.value === selected)) {
            values[field.id] = selected;
            found.push(field.id);
          }
          break;
        }
        case 'multi': {
          const picked = [];
          let present = false;
          for (const option of field.options) {
            const name = pdfNames.optionName(field.id, option.value);
            if (!names.has(name)) continue;
            present = true;
            try { if (form.getCheckBox(name).isChecked()) picked.push(option.value); } catch (e) { /* not a checkbox */ }
          }
          if (present) {
            values[field.id] = picked;
            if (picked.length) found.push(field.id);
          }
          break;
        }
        case 'grid': {
          const grid = {};
          let present = false;
          for (const row of field.rows) {
            for (const col of field.columns) {
              const name = pdfNames.gridName(field.id, row.value, col.value);
              if (!names.has(name)) continue;
              present = true;
              try {
                if (form.getCheckBox(name).isChecked()) {
                  grid[row.value] = grid[row.value] || [];
                  grid[row.value].push(col.value);
                }
              } catch (e) { /* not a checkbox */ }
            }
          }
          if (present) {
            values[field.id] = grid;
            if (Object.keys(grid).length) found.push(field.id);
          }
          break;
        }
        case 'rows': {
          const rows = [];
          let any = false;
          for (let i = 0; i < field.rowCount; i++) {
            const row = {};
            for (const rf of field.rowFields) {
              const v = textOf(pdfNames.rowFieldName(field.id, i, rf.id));
              if (v) { row[rf.id] = v; any = true; }
            }
            rows.push(row);
          }
          values[field.id] = rows;
          if (any) found.push(field.id);
          break;
        }
        default: {
          const v = textOf(pdfNames.fieldName(field.id));
          if (v) { values[field.id] = v; found.push(field.id); }
          break;
        }
      }
    }
  }

  const version = textOf(pdfNames.fieldName('packetVersion'));
  return { values, found, packetVersion: version || null };
}

// ---------------------------------------------------------------------------
// The text path.
// ---------------------------------------------------------------------------

/** Parse a ToUnicode CMap into code → string. */
function parseCMap(text) {
  const map = new Map();
  let codeHexLength = 4;
  const hexToStr = (hex) => {
    let out = '';
    for (let i = 0; i + 3 < hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    if (hex.length === 2) out = String.fromCharCode(parseInt(hex, 16));
    return out;
  };

  const charBlocks = text.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
  for (const block of charBlocks) {
    const pairs = block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || [];
    for (const pair of pairs) {
      const m = pair.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (!m) continue;
      codeHexLength = m[1].length;
      map.set(parseInt(m[1], 16), hexToStr(m[2]));
    }
  }

  const rangeBlocks = text.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
  for (const block of rangeBlocks) {
    const simple = block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || [];
    for (const entry of simple) {
      const m = entry.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (!m) continue;
      codeHexLength = m[1].length;
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dst = parseInt(m[3], 16);
      // A runaway range would be a memory problem on a hostile file, so it is
      // bounded rather than trusted.
      for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
    const arrays = block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g) || [];
    for (const entry of arrays) {
      const m = entry.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/);
      if (!m) continue;
      codeHexLength = m[1].length;
      const lo = parseInt(m[1], 16);
      const items = m[3].match(/<([0-9A-Fa-f]+)>/g) || [];
      items.forEach((item, i) => map.set(lo + i, hexToStr(item.slice(1, -1))));
    }
  }

  return { map, bytesPerCode: codeHexLength >= 4 ? 2 : 1 };
}

function decodeStream(context, ref) {
  try {
    const obj = context.lookup(ref);
    if (!(obj instanceof PDFRawStream)) return null;
    return Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
  } catch (e) {
    try {
      const obj = context.lookup(ref);
      const raw = obj && obj.contents ? Buffer.from(obj.contents) : null;
      return raw ? zlib.inflateSync(raw).toString('latin1') : null;
    } catch (e2) { return null; }
  }
}

function fontMapsFor(pageNode, context) {
  let resources = null;
  try { resources = pageNode.Resources(); } catch (e) { resources = null; }
  return fontMapsForResources(resources, context);
}

function fontMapsForResources(resources, context) {
  const maps = new Map();
  try {
    if (!resources || !resources.lookup) return maps;
    const fonts = resources.lookup(PDFName.of('Font'));
    if (!fonts || !fonts.entries) return maps;
    for (const [name, ref] of fonts.entries()) {
      const fontDict = context.lookup(ref);
      if (!fontDict || !fontDict.get) continue;
      let toUnicode = fontDict.get(PDFName.of('ToUnicode'));
      if (!toUnicode) {
        // A Type0 font keeps its descendant's mapping; either way we only need
        // a code→text table, so the first one found wins.
        const descendants = fontDict.get(PDFName.of('DescendantFonts'));
        if (descendants) {
          const list = context.lookup(descendants);
          if (list instanceof PDFArray && list.size()) {
            const child = context.lookup(list.get(0));
            if (child && child.get) toUnicode = child.get(PDFName.of('ToUnicode'));
          }
        }
      }
      if (!toUnicode) continue;
      const text = decodeStream(context, toUnicode);
      if (text) maps.set(name.asString(), parseCMap(text));
    }
  } catch (e) { /* a font table we cannot read just means that font's text is skipped */ }
  return maps;
}

function contentStringFor(pageNode, context) {
  const parts = [];
  try {
    const contents = pageNode.Contents();
    if (!contents) return '';
    const refs = (contents instanceof PDFArray) ? contents.asArray() : [contents];
    for (const ref of refs) {
      const decoded = decodeStream(context, ref);
      if (decoded) parts.push(decoded);
      else if (ref && ref.getContentsString) parts.push(ref.getContentsString());
    }
  } catch (e) { /* unreadable content is an empty page, not a crash */ }
  return parts.join('\n');
}

const OCTAL = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
function decodeLiteral(body) {
  return body
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, (_, c) => (OCTAL[c] !== undefined ? OCTAL[c] : c));
}

function decodeHex(hex, cmap) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  if (cmap && cmap.map.size) {
    const step = cmap.bytesPerCode * 2;
    for (let i = 0; i < clean.length; i += step) {
      const code = parseInt(clean.slice(i, i + step).padEnd(step, '0'), 16);
      out += cmap.map.has(code) ? cmap.map.get(code) : '';
    }
    return out;
  }
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

// --- 2D matrices, because position is the whole point ----------------------
// Text that is merely NEAR a label in the byte stream is not evidence that it
// answers that label: a heading drawn immediately afterwards sits next in the
// stream and nowhere near it on the page. Reading the geometry is what makes
// the difference between "the words that follow" and "the words in the box".
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
];
const IDENTITY = [1, 0, 0, 1, 0, 0];
const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];

/**
 * Content stream → positioned text runs: { text, x, y, size }.
 * Coordinates are in device space, y counted DOWN the page, so a run with a
 * smaller y is higher up whichever way the page transform is flipped.
 */
function runsFromContent(content, fontMaps, pageHeight, options = {}) {
  const runs = [];
  const resolveXObject = options.resolveXObject || null;
  const depth = options.depth || 0;
  let ctm = (options.ctm || IDENTITY).slice();
  const stack = [];
  let tm = IDENTITY.slice(), tlm = IDENTITY.slice();
  let leading = 0, fontSize = 0, cmap = null;
  let pending = '';
  let pendingAt = null;

  const flush = () => {
    const text = pending.replace(/\s+/g, ' ').trim();
    pending = '';
    if (!text || !pendingAt) { pendingAt = null; return; }
    runs.push({ text, x: pendingAt.x, y: pendingAt.y, size: pendingAt.size });
    pendingAt = null;
  };

  const mark = () => {
    if (pendingAt) return;
    const m = mul(tm, ctm);
    const scale = Math.hypot(m[2], m[3]) || 1;
    // Device y grows upward in PDF space; flip it so "above" is a smaller
    // number and a page-flipping transform cannot invert the reading order.
    const deviceY = m[5];
    const flipped = m[3] < 0;
    runs.flipped = flipped;
    pendingAt = {
      x: m[4],
      y: flipped ? deviceY : (pageHeight - deviceY),
      size: fontSize * scale
    };
  };

  const token = /\bq\b|\bQ\b|([-\d.]+(?:\s+[-\d.]+){5})\s+cm|\bBT\b|\bET\b|([-\d.]+(?:\s+[-\d.]+){5})\s+Tm|([-\d.]+)\s+([-\d.]+)\s+(Td|TD)|([-\d.]+)\s+TL|\bT\*|\/([A-Za-z0-9._-]+)\s+([\d.]+)\s+Tf|\((?:\\.|[^\\()])*\)\s*Tj|<([0-9A-Fa-f\s]*)>\s*Tj|\[((?:[^\[\]\\]|\\.)*)\]\s*TJ|\/([A-Za-z0-9._-]+)\s+Do/g;

  let m;
  while ((m = token.exec(content)) !== null) {
    const tok = m[0];
    if (tok === 'q') { stack.push(ctm.slice()); continue; }
    if (tok === 'Q') { ctm = stack.pop() || IDENTITY.slice(); continue; }
    if (m[1]) { ctm = mul(m[1].trim().split(/\s+/).map(Number), ctm); continue; }
    if (tok === 'BT') { flush(); tm = IDENTITY.slice(); tlm = IDENTITY.slice(); continue; }
    if (tok === 'ET') { flush(); continue; }
    if (m[2]) { flush(); tlm = m[2].trim().split(/\s+/).map(Number); tm = tlm.slice(); continue; }
    if (m[3] !== undefined && m[5]) {
      flush();
      const tx = Number(m[3]), ty = Number(m[4]);
      if (m[5] === 'TD') leading = -ty;
      tlm = mul(translate(tx, ty), tlm);
      tm = tlm.slice();
      continue;
    }
    if (m[6] !== undefined) { leading = Number(m[6]); continue; }
    if (tok === 'T*') { flush(); tlm = mul(translate(0, -leading), tlm); tm = tlm.slice(); continue; }
    if (m[7] !== undefined) { cmap = fontMaps.get(m[7]) || null; fontSize = Number(m[8]) || fontSize; continue; }

    if (m[9] !== undefined) { mark(); pending += decodeHex(m[9], cmap); continue; }
    if (m[10] !== undefined) {
      mark();
      const pieces = m[10].match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>/g) || [];
      for (const piece of pieces) {
        if (piece.startsWith('(')) pending += decodeLiteral(piece.slice(1, -1));
        else pending += decodeHex(piece.slice(1, -1), cmap);
      }
      continue;
    }
    if (m[11] !== undefined) {
      // A form XObject carries its own content and its own matrix. Flattening a
      // filled PDF turns every field's appearance into one of these, so a
      // parser that does not descend reads a page with no answers on it and
      // reports it as empty — which is not the same fact at all.
      flush();
      if (resolveXObject && depth < 6) {
        const child = resolveXObject(m[11]);
        if (child) {
          const childCtm = child.matrix ? mul(child.matrix, ctm) : ctm;
          for (const run of runsFromContent(child.content, child.fontMaps, pageHeight, {
            resolveXObject: child.resolveXObject, depth: depth + 1, ctm: childCtm
          })) runs.push(run);
        }
      }
      continue;
    }
    if (/Tj$/.test(tok)) {
      mark();
      pending += decodeLiteral(tok.slice(tok.indexOf('(') + 1, tok.lastIndexOf(')')));
      continue;
    }
  }
  flush();
  return runs;
}

/** Resolve `/Name Do` against a resources dictionary, recursively. */
function xObjectResolver(resources, context) {
  return (name) => {
    try {
      if (!resources || !resources.lookup) return null;
      const xobjects = resources.lookup(PDFName.of('XObject'));
      if (!xobjects || !xobjects.get) return null;
      const ref = xobjects.get(PDFName.of(name));
      if (!ref) return null;
      const stream = context.lookup(ref);
      if (!stream || !stream.dict) return null;
      const subtype = stream.dict.get(PDFName.of('Subtype'));
      if (subtype && subtype.asString && subtype.asString() !== '/Form') return null;
      const content = decodeStream(context, ref);
      if (!content) return null;
      const own = stream.dict.get(PDFName.of('Resources'));
      const ownResources = own ? context.lookup(own) : resources;
      const matrixArray = stream.dict.get(PDFName.of('Matrix'));
      let matrix = null;
      if (matrixArray && matrixArray.asArray) {
        const nums = matrixArray.asArray().map(n => (n && n.asNumber ? n.asNumber() : Number(n)));
        if (nums.length === 6 && nums.every(n => Number.isFinite(n))) matrix = nums;
      }
      return {
        content,
        matrix,
        fontMaps: fontMapsForResources(ownResources, context),
        resolveXObject: xObjectResolver(ownResources, context)
      };
    } catch (e) { return null; }
  };
}

// ---------------------------------------------------------------------------
// ANNOTATIONS — the third place a filled-in answer can hide.
// ---------------------------------------------------------------------------
// Somebody who types onto the packet with Preview's markup tools, or Acrobat's
// "Add text", does NOT write into the page. They add an annotation, which lives
// in its own list with its own position and its own little drawing. A parser
// that reads only the page content sees a blank form and reports it as one —
// which is the same wrong answer as reading a flattened PDF without descending
// into its XObjects, one layer along.
//
// Two ways to get the text out, and the cheap one is also the reliable one:
//
//   /Contents — the annotation's own plain text. This is what a markup tool
//               stores when somebody types, so it needs no parsing at all.
//   /AP /N    — the drawing the viewer actually shows. Parsed only when there
//               is no /Contents, for producers that write one and not the other.
//
// A LINK OR A POPUP IS NOT AN ANSWER and is skipped by subtype: a link's
// /Contents is its alt text, and a popup repeats its parent's note. Reading
// either would put the form's own furniture into somebody's profile.

const SKIP_ANNOT_SUBTYPES = new Set(['/Link', '/Popup', '/FileAttachment', '/Sound', '/Movie']);

const textOfPdfString = (obj) => {
  if (!obj) return '';
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try { return obj.decodeText(); } catch (e) { return ''; }
  }
  return '';
};

const rectOf = (dict, context) => {
  try {
    const raw = dict.get(PDFName.of('Rect'));
    const arr = context.lookup(raw);
    if (!(arr instanceof PDFArray) || arr.size() < 4) return null;
    const n = [0, 1, 2, 3].map(i => {
      const v = context.lookup(arr.get(i));
      return v && v.asNumber ? v.asNumber() : Number(v);
    });
    if (!n.every(Number.isFinite)) return null;
    return {
      x1: Math.min(n[0], n[2]), y1: Math.min(n[1], n[3]),
      x2: Math.max(n[0], n[2]), y2: Math.max(n[1], n[3])
    };
  } catch (e) { return null; }
};

/**
 * The transform that places an appearance stream inside its annotation's
 * rectangle (PDF 32000-1 §12.5.5): transform the stream's BBox by its Matrix,
 * then map that box onto Rect. Without it the stream draws at its own
 * coordinates, which for most producers is the bottom-left corner of the page —
 * so every typed answer would land in one pile and match nothing.
 */
function appearancePlacement(bbox, matrix, rect) {
  const m = matrix || IDENTITY;
  const corners = [
    [bbox.x1, bbox.y1], [bbox.x2, bbox.y1], [bbox.x2, bbox.y2], [bbox.x1, bbox.y2]
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
  const bx1 = Math.min(...xs), bx2 = Math.max(...xs);
  const by1 = Math.min(...ys), by2 = Math.max(...ys);
  const sx = (bx2 - bx1) > 1e-6 ? (rect.x2 - rect.x1) / (bx2 - bx1) : 1;
  const sy = (by2 - by1) > 1e-6 ? (rect.y2 - rect.y1) / (by2 - by1) : 1;
  return [sx, 0, 0, sy, rect.x1 - bx1 * sx, rect.y1 - by1 * sy];
}

/** The appearance stream a viewer would actually draw, if there is one. */
function appearanceStreamRef(dict, context) {
  try {
    const ap = context.lookup(dict.get(PDFName.of('AP')));
    if (!ap || !ap.get) return null;
    let normal = ap.get(PDFName.of('N'));
    if (!normal) return null;
    let resolved = context.lookup(normal);
    // A checkbox's /N is a dictionary of appearance states keyed by /On, /Off.
    // The one to draw is named by /AS; without that there is nothing to pick.
    if (resolved && !(resolved instanceof PDFRawStream) && resolved.get) {
      const stateName = dict.get(PDFName.of('AS'));
      if (!stateName || !stateName.asString) return null;
      normal = resolved.get(PDFName.of(stateName.asString().replace(/^\//, '')));
      if (!normal) return null;
      resolved = context.lookup(normal);
    }
    return (resolved instanceof PDFRawStream) ? { ref: normal, stream: resolved } : null;
  } catch (e) { return null; }
}

function annotationRuns(pageNode, context, pageHeight) {
  const runs = [];
  let annots;
  try {
    annots = context.lookup(pageNode.get(PDFName.of('Annots')));
  } catch (e) { return runs; }
  if (!(annots instanceof PDFArray)) return runs;

  for (let i = 0; i < annots.size(); i++) {
    try {
      const dict = context.lookup(annots.get(i));
      if (!dict || !dict.get) continue;
      const subtype = dict.get(PDFName.of('Subtype'));
      const subtypeName = subtype && subtype.asString ? subtype.asString() : '';
      if (SKIP_ANNOT_SUBTYPES.has(subtypeName)) continue;

      const rect = rectOf(dict, context);
      if (!rect) continue;

      // The typed text itself, where the producer stored it.
      const typed = textOfPdfString(context.lookup(dict.get(PDFName.of('Contents'))));
      if (typed.trim()) {
        runs.push({
          text: typed.replace(/\s+/g, ' ').trim(),
          x: rect.x1,
          // Flipped into the page-down space every other run uses, measured at
          // the TOP of the box: a text annotation's first line starts there, and
          // matching against a label is a question about where the line sits.
          y: pageHeight - rect.y2,
          size: Math.max(6, Math.min(24, rect.y2 - rect.y1))
        });
        continue;
      }

      // Otherwise, whatever the viewer draws.
      const appearance = appearanceStreamRef(dict, context);
      if (!appearance) continue;
      const content = decodeStream(context, appearance.ref);
      if (!content) continue;

      const dictOf = appearance.stream.dict;
      const bboxArr = context.lookup(dictOf.get(PDFName.of('BBox')));
      let bbox = { x1: 0, y1: 0, x2: rect.x2 - rect.x1, y2: rect.y2 - rect.y1 };
      if (bboxArr instanceof PDFArray && bboxArr.size() >= 4) {
        const n = [0, 1, 2, 3].map(k => {
          const v = context.lookup(bboxArr.get(k));
          return v && v.asNumber ? v.asNumber() : Number(v);
        });
        if (n.every(Number.isFinite)) {
          bbox = { x1: Math.min(n[0], n[2]), y1: Math.min(n[1], n[3]), x2: Math.max(n[0], n[2]), y2: Math.max(n[1], n[3]) };
        }
      }
      let matrix = null;
      const matrixArr = context.lookup(dictOf.get(PDFName.of('Matrix')));
      if (matrixArr instanceof PDFArray && matrixArr.size() === 6) {
        const n = [0, 1, 2, 3, 4, 5].map(k => {
          const v = context.lookup(matrixArr.get(k));
          return v && v.asNumber ? v.asNumber() : Number(v);
        });
        if (n.every(Number.isFinite)) matrix = n;
      }

      const own = context.lookup(dictOf.get(PDFName.of('Resources')));
      const placement = appearancePlacement(bbox, matrix, rect);
      const ctm = matrix ? mul(matrix, placement) : placement;
      for (const run of runsFromContent(content, fontMapsForResources(own, context), pageHeight, {
        resolveXObject: xObjectResolver(own, context), ctm, depth: 1
      })) runs.push(run);
    } catch (e) { /* one unreadable annotation is not the whole page */ }
  }
  return runs;
}

async function extractRuns(pdf) {
  const runs = [];
  pdf.getPages().forEach((page, pageIndex) => {
    let resources = null;
    try { resources = page.node.Resources(); } catch (e) { resources = null; }
    const maps = fontMapsFor(page.node, pdf.context);
    const content = contentStringFor(page.node, pdf.context);
    const height = page.getHeight();
    const found = runsFromContent(content, maps, height, {
      resolveXObject: xObjectResolver(resources, pdf.context)
    });
    for (const run of found) runs.push({ ...run, page: pageIndex });
    // Annotations come AFTER the page content, so a typed answer sorts below
    // its printed label when the two share a baseline.
    for (const run of annotationRuns(page.node, pdf.context, height)) {
      runs.push({ ...run, page: pageIndex });
    }
  });
  return runs;
}

/** Backwards-compatible plain-text view, in reading order. */
async function extractLines(pdf) {
  const runs = await extractRuns(pdf);
  return groupIntoLines(runs).map(l => l.text);
}

/** Runs whose baselines are within a line of each other, left to right. */
function groupIntoLines(runs) {
  const sorted = runs.slice().sort((a, b) =>
    a.page - b.page || a.y - b.y || a.x - b.x);
  const lines = [];
  for (const run of sorted) {
    const last = lines[lines.length - 1];
    const tolerance = Math.max(2, (run.size || 9) * 0.4);
    if (last && last.page === run.page && Math.abs(last.y - run.y) <= tolerance) {
      last.runs.push(run);
      last.text = `${last.text} ${run.text}`.replace(/\s+/g, ' ').trim();
      last.y = (last.y * (last.runs.length - 1) + run.y) / last.runs.length;
    } else {
      lines.push({ page: run.page, y: run.y, x: run.x, size: run.size, text: run.text, runs: [run] });
    }
  }
  return lines;
}

const normalizeLabel = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Every string the packet PRINTS: section titles, field labels, hints, every
 * option label, every document item. Anything on this list read back off a page
 * is the form's own furniture, never somebody's answer.
 */
function printedStrings() {
  const set = new Set();
  const add = (v) => { const n = normalizeLabel(v); if (n) set.add(n); };
  for (const section of wp.PACKET_SECTIONS) {
    add(section.title);
    add(`${section.number} ${section.title}`);
    add(section.intro);
    for (const field of section.fields) {
      add(field.label);
      add(field.hint);
      for (const o of (field.options || [])) add(o.label);
      for (const r of (field.rows || [])) add(r.label);
      for (const c of (field.columns || [])) add(c.label);
      for (const rf of (field.rowFields || [])) add(rf.label);
    }
  }
  for (const item of wp.DOCUMENT_ITEMS) {
    add(item.title); add(item.detail); add(item.help);
    add(`${item.item} ${item.title}`);
  }
  for (const g of Object.keys(wp.GROUP_TITLES)) { add(wp.GROUP_TITLES[g]); add(wp.GROUP_INTROS[g]); }
  add(wp.PAY_PROMISE);
  add('Godwins Family Care');
  add('Care That Sees You');
  return set;
}

const TEXT_TYPES = ['text', 'tel', 'email', 'date', 'textarea'];

/**
 * Match printed labels to the text that actually sits with them on the page.
 *
 * TEXT-TYPE FIELDS ONLY — see the note at the top of this file. A tick is a
 * mark, not a word, so reading "30 min" off a page is evidence the QUESTION is
 * printed there, never evidence that box was the one ticked.
 *
 * Three rules decide whether a candidate is an answer, and all three have to
 * hold. Each one on its own lets something through that is not one:
 *
 *   1. GEOMETRY. The candidate is on the label's own line to its right, or on
 *      the next line down, left-aligned with the label and close to it. Text
 *      that merely follows in the byte stream is not near it on the page.
 *   2. IT IS NOT SOMETHING THE FORM PRINTS. Section headings, option labels
 *      and the footer are all things the packet says itself.
 *   3. IT DOES NOT REPEAT. An answer appears once; furniture repeats. This is
 *      what catches a heading or a running footer that the first two rules
 *      happen to let through.
 *
 * When a candidate fails any of them the field is left BLANK and the caregiver
 * is asked. A blank field gets filled in; a wrong one gets signed.
 */
function matchLabels(input) {
  const lines = Array.isArray(input) && input.length && typeof input[0] === 'string'
    ? input.map((text, i) => ({ text, x: 0, y: i * 12, page: 0, size: 9 }))
    : groupIntoLines(Array.isArray(input) ? input : []);

  const printed = printedStrings();
  const wanted = new Map();
  for (const section of wp.PACKET_SECTIONS) {
    for (const field of section.fields) {
      if (TEXT_TYPES.includes(field.type)) wanted.set(normalizeLabel(field.label), field);
    }
  }

  // How often each piece of text appears anywhere in the document. Rule 3.
  const frequency = new Map();
  for (const line of lines) {
    const key = normalizeLabel(line.text);
    if (key) frequency.set(key, (frequency.get(key) || 0) + 1);
  }

  const acceptable = (text) => {
    const norm = normalizeLabel(text);
    if (!norm || norm.length < 2) return false;
    if (printed.has(norm)) return false;
    if ((frequency.get(norm) || 0) > 1) return false;
    // A line that opens with a section number ("2 Credentials") is a heading
    // whatever else it says.
    if (/^\d+\s/.test(text.trim()) && printed.has(normalizeLabel(text.trim().replace(/^\d+\s+/, '')))) return false;
    if (wanted.has(norm)) return false;
    return true;
  };

  const values = {};
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const norm = normalizeLabel(line.text);
    const field = wanted.get(norm);
    if (!field || values[field.id] !== undefined) continue;

    // Rule 1a — the same line, to the right of the label. The label occupies
    // the line's leading runs; anything after them is the answer.
    const labelWords = norm.split(' ').length;
    const tail = line.runs.slice(labelWords >= line.runs.length ? line.runs.length : 0);
    let candidate = null;
    if (line.runs.length > 1) {
      const joined = line.runs.map(r => r.text).join(' ');
      const stripped = joined.replace(new RegExp('^' + field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '').trim();
      if (stripped && stripped !== joined && acceptable(stripped)) candidate = stripped;
    }
    void tail;

    // Rule 1b — the next line down, starting at roughly the label's x, within
    // about three lines' height of it.
    if (!candidate) {
      const parts = [];
      for (let j = i + 1; j < lines.length && parts.length < 4; j++) {
        const next = lines[j];
        if (next.page !== line.page) break;
        const gap = next.y - line.y;
        if (gap <= 0 || gap > Math.max(48, (line.size || 9) * 5)) break;
        if (Math.abs(next.x - line.x) > 24) break;
        if (!acceptable(next.text)) break;
        parts.push(next.text);
        if (field.type !== 'textarea') break;
      }
      if (parts.length) candidate = parts.join(' ').trim();
    }

    if (!candidate) continue;
    values[field.id] = candidate.slice(0, field.max || 500);
    found.push(field.id);
  }

  return { values, found };
}

/**
 * Read a returned packet.
 * → { source, values, found, needsConfirmation, packetVersion, reason }
 *
 * `values` is always run through the packet's own sanitizer, so an imported
 * answer is held to exactly the rules a typed one is. A PDF is a file somebody
 * sent us; it does not get to write a value the form would refuse.
 */
async function extractPacket(buffer) {
  let pdf;
  try {
    pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    return {
      source: SOURCE.NONE, values: {}, found: [], needsConfirmation: false, packetVersion: null,
      reason: 'That file could not be opened as a PDF. If it is a photo of the packet, upload it under Documents and fill the form in here instead.'
    };
  }

  const form = readFormFields(pdf);
  if (form && form.found.length) {
    const { clean } = wp.sanitizePacket(form.values);
    return {
      source: SOURCE.FORM,
      values: clean,
      found: Object.keys(clean),
      // Read by name off the fields we put there. There is nothing to confirm
      // beyond what the caregiver would check on their own answers anyway.
      needsConfirmation: false,
      packetVersion: form.packetVersion,
      reason: null
    };
  }

  let runs = [];
  try { runs = await extractRuns(pdf); } catch (e) { runs = []; }
  if (runs.length) {
    const text = matchLabels(runs);
    if (text.found.length) {
      const { clean } = wp.sanitizePacket(text.values);
      return {
        source: SOURCE.TEXT,
        values: clean,
        found: Object.keys(clean),
        // Matched by label, not read by name. Every value is shown for
        // confirmation, and the choices were never guessed at.
        needsConfirmation: true,
        packetVersion: null,
        reason: 'We read the typed text out of your packet. The tick-box answers are not readable this way, so please go through and set those yourself.'
      };
    }
  }

  return {
    source: SOURCE.NONE,
    values: {},
    found: [],
    needsConfirmation: false,
    packetVersion: null,
    reason: runs.length
      ? 'We opened your packet but could not match anything in it to the questions. Your file is saved for the office — please fill the form in here.'
      : 'This looks like a scan or a photo rather than a filled-in PDF, so there is no text in it to read. Your file is saved for the office — please fill the form in here.'
  };
}

module.exports = {
  SOURCE,
  extractPacket,
  // Exported for the tests, which drive the halves independently.
  readFormFields,
  annotationRuns,
  appearancePlacement,
  extractRuns,
  extractLines,
  groupIntoLines,
  runsFromContent,
  parseCMap,
  printedStrings,
  matchLabels
};
