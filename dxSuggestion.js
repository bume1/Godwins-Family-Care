'use strict';
// dxSuggestion.js — diagnosis suggestions (AI coding pipeline spec, Phase 4.1,
// in the design the owner settled on 2026-11-04: see
// docs/decisions/2026-11-04-coding-pipeline-gemini-alignment.md, item 5).
//
// THE MODEL NAMES NO CODE, HERE EITHER. Gemini extracts the diagnosis WORDING
// the note documents, each with its quote. The app then looks that wording up
// in OpenEMR's ICD-10 table, with no model, and the clinician picks the code
// from what OpenEMR returns. So this purpose needs no decision change, and
// decision 9 holds for it exactly as written.
//
// PURE. The server runs the model and the OpenEMR searches; this file decides
// what survives:
//   - a wording with no quote, or a quote found in no text section sent, is
//     dropped and counted. A quote from the problem or medication list is kept
//     and labelled 'list' (owner decision), a quote from the visit's own words
//     'note' (mdmExtraction.js holds the rule);
//   - a wording OpenEMR's ICD-10 table matches nothing for is dropped and
//     counted ("a proposal that does not resolve to a real code is dropped");
//     so is one whose search failed, because a suggestion nobody could check
//     is not offered;
//   - an unspecified candidate is flagged when OpenEMR returned a more specific
//     one beside it.
// Never written to the chart. The clinician picks a candidate, which adds it
// to the encounter's diagnoses; it is saved only when she saves the coding.

const clinicalRepo = require('./clinicalRepository');
const mdmExtraction = require('./mdmExtraction');

// No code field. Build-enforced.
const DX_SCHEMA = Object.freeze({
  fields: {
    diagnoses: {
      type: 'array', maxItems: 20,
      items: {
        wording: { type: 'string', maxLength: 250, required: true },
        // Not required, on purpose: one quoteless item is dropped and counted,
        // it does not fail the whole answer (see mdmExtraction.js).
        quote: { type: 'string', maxLength: 300 }
      }
    },
    unreadable: { type: 'array', itemType: 'string', maxLength: 300 }
  }
});

const CANDIDATE_LIMIT = 8;

// Step 1: quotes. Returns the wordings that survive, each with quoteSource.
const enforceQuotes = (proposal, { noteTexts, contextTexts }) => {
  const asMdm = { problemsAddressed: (proposal && Array.isArray(proposal.diagnoses) ? proposal.diagnoses : []).map(d => ({ ...d })) };
  const r = mdmExtraction.enforceQuotes(asMdm, { noteTexts, contextTexts });
  const seen = new Set(); let duplicate = 0;
  const wordings = [];
  for (const d of r.output.problemsAddressed) {
    const key = mdmExtraction.normalize(d.wording);
    if (!key) continue;
    if (seen.has(key)) { duplicate++; continue; }
    seen.add(key);
    wordings.push({ wording: String(d.wording).trim(), quote: d.quote, quoteSource: d.quoteSource });
  }
  return { wordings, counts: { noQuote: r.counts.noQuote, quoteNotFound: r.counts.quoteNotFound, duplicate } };
};

// OpenEMR search rows → candidates, ICD-10 in shape, de-duplicated.
const candidatesFrom = (rows) => {
  const seen = new Set(); const out = [];
  for (const x of Array.isArray(rows) ? rows : []) {
    const code = clinicalRepo.normalizeIcd10(x && x.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, description: String((x && (x.code_text || x.description)) || '').trim() });
    if (out.length >= CANDIDATE_LIMIT) break;
  }
  const unspecified = (c) => /\bunspecified\b/i.test(c.description);
  const anySpecific = out.some(c => !unspecified(c));
  return out.map(c => ({ ...c, unspecified: unspecified(c), moreSpecificListed: unspecified(c) && anySpecific }));
};

// Step 2: resolution. `searches` is { [wording]: rows | { error } } from
// OpenEMR's own code search.
const resolve = (wordings, searches, { existingCodes } = {}) => {
  const have = new Set((existingCodes || []).map(c => clinicalRepo.normalizeIcd10(c)).filter(Boolean));
  const counts = { notInTable: 0, notChecked: 0 };
  const out = [];
  for (const w of wordings || []) {
    const s = (searches || {})[w.wording];
    if (!s || s.error) { counts.notChecked++; continue; }
    const candidates = candidatesFrom(s).map(c => ({ ...c, alreadyOnEncounter: have.has(c.code) }));
    if (!candidates.length) { counts.notInTable++; continue; }
    out.push({ ...w, candidates });
  }
  return { suggestions: out, counts };
};

module.exports = { DX_SCHEMA, CANDIDATE_LIMIT, enforceQuotes, candidatesFrom, resolve };
