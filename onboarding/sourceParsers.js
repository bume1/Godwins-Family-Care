// ============================================================================
// READING THE SOURCE DOCUMENTS — version, section fingerprints, check questions
// ============================================================================
// Pure functions over the lines documentText.js produces. The check questions
// a module asks are READ FROM the SOP or Library document at runtime, never
// copied into source: a copy drifts from the document silently and the drift
// surfaces in an audit, not a revision.
//
// A check is { prompt, answer, source }:
//   prompt  the italic scenario line
//   answer  the line that follows it, starting "Answer:"
//   source  the trailing "(Manual 12.4)" citation, when present
// ============================================================================

'use strict';

const VF = require('./versionFlags');

const unescapeMd = (s) => String(s).replace(/\\\*/g, '*').replace(/\\_/g, '_');

/** The version in a document's control table, or the Playbook's "vX.Y" banner. */
function documentVersion(lines, { banner = false } = {}) {
  const text = lines.map(unescapeMd).join('\n');
  const fromTable = VF.readControlVersion(text);
  if (fromTable) return fromTable;
  if (banner) {
    const m = /\bv\s?(\d+\.\d+)\b/i.exec(text);
    if (m) return m[1];
  }
  return null;
}

function manualFingerprint(lines) {
  return VF.fingerprintSections(lines.map(unescapeMd).join('\n'));
}

const ITALIC_LINE = /^\*(.+)\*$/;
const CITATION = /\s*\*?\((?:[^()]|\([^()]*\))+\)\*?\s*$/;

function readPairs(lines, start, stop) {
  const checks = [];
  for (let i = start; i < lines.length; i++) {
    const line = unescapeMd(lines[i]).trim();
    if (stop(line)) break;
    const q = ITALIC_LINE.exec(line);
    if (!q) continue;
    const next = unescapeMd(lines[i + 1] || '').trim();
    if (!/^Answer:/i.test(next)) continue;
    const citeMatch = next.match(/\*?\(((?:[^()]|\([^()]*\))+)\)\*?\s*$/);
    checks.push({
      prompt: q[1].trim(),
      answer: next.replace(/^Answer:\s*/i, '').replace(CITATION, '').trim(),
      source: citeMatch ? citeMatch[1].trim() : null
    });
    i += 1;
  }
  return checks;
}

const SOP_HEADING = /^(SOP-[A-Z]+-\d{2})\s*·/;
const TRN_HEADING = /^(TRN-\d{3})\s*·/;
const NUMBERED_SECTION = /^\d+(?:\.\d+)?\s+[A-Z]/;

/** Every SOP's check questions, keyed by procedure id. */
function sopChecks(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const h = SOP_HEADING.exec(unescapeMd(lines[i]).trim());
    if (!h) continue;
    const id = h[1];
    let j = i + 1;
    while (j < lines.length && !SOP_HEADING.exec(unescapeMd(lines[j]).trim())
      && !/^Check questions$/i.test(unescapeMd(lines[j]).trim())) j++;
    if (j < lines.length && /^Check questions$/i.test(unescapeMd(lines[j]).trim())) {
      out[id] = readPairs(lines, j + 1, (l) => SOP_HEADING.test(l) || /^Set \d+ · /.test(l));
    } else if (!out[id]) {
      out[id] = [];
    }
  }
  return out;
}

/**
 * Each SOP's own text, keyed by procedure id: its heading, then every line up
 * to its check questions. The questions and their answers are left out on
 * purpose, because they are the module's check and are switched on
 * separately. A procedure that stops at the next heading or at "Set 2 ·
 * Planned" without a "Check questions" line is returned whole.
 */
function sopSections(lines) {
  const out = {};
  const text = lines.map(l => unescapeMd(l).trim());
  for (let i = 0; i < text.length; i++) {
    const h = SOP_HEADING.exec(text[i]);
    if (!h) continue;
    const id = h[1];
    const body = [];
    let j = i + 1;
    for (; j < text.length; j++) {
      const l = text[j];
      if (SOP_HEADING.test(l) || /^Set \d+ · /.test(l) || /^Document Control$/i.test(l) || /^Check questions$/i.test(l)) break;
      body.push(l);
    }
    // Trim leading and trailing blank lines; keep the single blanks between
    // paragraphs so the page can render them as breaks.
    while (body.length && !body[0]) body.shift();
    while (body.length && !body[body.length - 1]) body.pop();
    if (!out[id]) out[id] = { id, title: text[i].replace(SOP_HEADING, '').trim(), lines: body };
  }
  return out;
}

/** Module-specific checks in the Training Library, keyed by module id. */
function libraryChecks(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const h = TRN_HEADING.exec(unescapeMd(lines[i]).trim());
    if (!h) continue;
    const id = h[1];
    out[id] = (out[id] || []).concat(readPairs(lines, i + 1,
      (l) => TRN_HEADING.test(l) || NUMBERED_SECTION.test(l)));
  }
  return out;
}

/**
 * The checks one module asks: its own Library checks first, then each SOP it
 * teaches. A module with neither has no checks yet, which the office view
 * reports as a gap rather than as a module that happens to be easy.
 */
function checksForModule(module, { library, sops }) {
  const own = (library && library[module.id]) || [];
  const fromSops = (module.sopRefs || []).flatMap(s => ((sops && sops[s]) || []).map(c => Object.assign({ sop: s }, c)));
  return own.map(c => Object.assign({ from: 'LIBRARY' }, c)).concat(fromSops.map(c => Object.assign({ from: 'SOP' }, c)));
}

/**
 * Compares the catalog's Playbook classifications against the Playbook as it
 * stands in Drive. Each row is looked up in the section's own table, bounded by
 * the Playbook's section markers ("C.2" up to "C.3"), never by a chapter title,
 * which also appears in the role index at the top. The row's last cell must
 * read the phrase the catalog carries. Returns the mismatches; an empty list
 * means the catalog still says what the document says.
 */
function verifyChapterClassifications(lines, items, { section, next }) {
  const text = lines.map(unescapeMd);
  // The HTML renders the section number beside its heading ("C.2Applicable
  // Requirements"), so a marker is a line that STARTS with the number and is
  // not followed by another digit: "C.2" must never match "C.20".
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = (id) => new RegExp(`^${esc(id)}(?![\\d.])`);
  const a = text.findIndex(l => marker(section).test(l));
  const b = text.findIndex((l, i) => i > a && marker(next).test(l));
  if (a < 0 || b < 0) {
    const e = new Error(`Section ${section} was not found in the document`);
    e.code = 'SECTION_NOT_FOUND';
    throw e;
  }
  const block = text.slice(a, b);
  const out = [];
  for (const it of items) {
    for (const c of it.classifications || []) {
      if (c.from.source !== 'PLAYBOOK' || c.from.section !== section) continue;
      const row = block.find(l => l.startsWith(`| ${c.row} |`));
      if (!row) { out.push({ item: it.id, row: c.row, expected: c.phrase, found: null }); continue; }
      const cells = row.split('|').map(x => x.trim()).filter(Boolean);
      const found = cells[cells.length - 1];
      if (found !== c.phrase) out.push({ item: it.id, row: c.row, expected: c.phrase, found });
    }
  }
  return out;
}

module.exports = { documentVersion, manualFingerprint, sopChecks, sopSections, libraryChecks, checksForModule, verifyChapterClassifications };
