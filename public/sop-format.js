// ============================================================================
// SOP TEXT, LAID OUT TO READ (owner, 2026-11-10: "horrible formatting and
// hard to read"). The reader hands the page the SOP as plain lines; the
// document's headings and bullets are gone. This puts them back by shape:
//
//   "Manual: 14, 23.5 · Module: …"     → a small grey line
//   "Before the examination"           → a heading (short, no full stop)
//   "Purpose. Conduct each …"          → a bold lead-in, then the sentence
//   lines under a heading              → bullets
//   "| a | b |"                        → a table row, as is
//   ""                                 → a gap
//
// Pure and display-only: the stored lines are never changed (check questions
// and manual fingerprints read them).
// ============================================================================
(function (root) {
  'use strict';
  const isTable = (l) => l.startsWith('|');
  const isMeta = (l) => /^(Manual|Module|Modules|Applies to|Owner|Version)\s*:/i.test(l);
  // A heading: short, no closing punctuation, starts with a capital.
  const isHeading = (l) => l.length <= 70 && /^[A-Z]/.test(l) && !/[.:;,?!)]$/.test(l) && !isTable(l);
  // A lead-in: up to six words ending in a full stop, then more text.
  const LEAD = /^([A-Z][^.]{0,60}?\.)\s+(\S.*)$/;

  /** → [{ kind: 'gap'|'meta'|'table'|'heading'|'para'|'bullet', text, lead? }] */
  function sopBlocks(lines) {
    const out = [];
    let underHeading = false;
    for (const raw of lines || []) {
      const l = String(raw || '').trim();
      if (!l) { out.push({ kind: 'gap' }); continue; }
      if (isTable(l)) { out.push({ kind: 'table', text: l }); continue; }
      if (isMeta(l)) { out.push({ kind: 'meta', text: l }); continue; }
      if (isHeading(l)) { out.push({ kind: 'heading', text: l }); underHeading = true; continue; }
      const m = LEAD.exec(l);
      if (m && m[1].split(/\s+/).length <= 6) { out.push({ kind: underHeading ? 'bullet' : 'para', lead: m[1], text: m[2] }); continue; }
      out.push({ kind: underHeading ? 'bullet' : 'para', text: l });
    }
    return out;
  }

  const api = { sopBlocks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GFCSopFormat = api;
})(typeof window !== 'undefined' ? window : this);
