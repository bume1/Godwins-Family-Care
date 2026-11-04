'use strict';
// dxSuggestion.js — ICD-10 diagnosis suggestions from the note (AI coding
// pipeline spec, 2026-11-04, Phase 4.1).
//
// Gemini proposes ICD-10-CM codes from one encounter note, each with the quote
// it rests on. PURE: the server runs the model and the OpenEMR lookups; this
// file decides what survives:
//   - a proposal with no quote, or a quote the note does not contain, is
//     dropped and counted (as in Phase 2);
//   - a code that is not ICD-10-CM in shape is dropped and counted;
//   - a code that does not resolve in OpenEMR's ICD-10 table is dropped and
//     counted, and so is one that could not be checked: a suggestion nobody
//     can verify is not offered;
//   - an unspecified code is flagged when OpenEMR lists a more specific code
//     in the same category.
// Never written to the chart. The clinician adds a suggestion to the
// encounter's diagnoses herself, links it to the charge lines it supports, and
// saves; until then it is a draft on the coding workflow.
//
// ICD-10 only. This purpose proposes no CPT, HCPCS, modifier or E/M level
// (build-enforced: the schema has one code field and the server validates it
// as ICD-10-CM).

const clinicalRepo = require('./clinicalRepository');
const mdmExtraction = require('./mdmExtraction');

const DX_SCHEMA = Object.freeze({
  fields: {
    diagnoses: {
      type: 'array', maxItems: 20,
      items: {
        code: { type: 'string', maxLength: 10, required: true },
        description: { type: 'string', maxLength: 250, required: true },
        // Not required, on purpose: one quoteless item must be dropped and
        // counted, not fail the whole answer (see mdmExtraction.js).
        quote: { type: 'string', maxLength: 300 }
      }
    },
    unreadable: { type: 'array', itemType: 'string', maxLength: 300 }
  }
});

// lookups: { [code]: { exists, description, unspecified, moreSpecific } } from
// OpenEMR's own code search (server.js verifyIcd10Codes).
const enforce = (proposal, { sourceTexts, hasDocuments, lookups, existingCodes }) => {
  const haystack = mdmExtraction.normalize((sourceTexts || []).join('\n'));
  const counts = { noQuote: 0, quoteNotFound: 0, badCode: 0, notInTable: 0, notChecked: 0, duplicate: 0, unverifiedQuote: 0 };
  const have = new Set((existingCodes || []).map(c => clinicalRepo.normalizeIcd10(c)).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const d of (proposal && Array.isArray(proposal.diagnoses) ? proposal.diagnoses : [])) {
    const q = mdmExtraction.normalize(d && d.quote);
    if (!q) { counts.noQuote++; continue; }
    const inText = haystack.includes(q);
    if (!inText && !hasDocuments) { counts.quoteNotFound++; continue; }
    const code = clinicalRepo.normalizeIcd10(d.code);
    if (!code) { counts.badCode++; continue; }
    if (seen.has(code)) { counts.duplicate++; continue; }
    const look = (lookups || {})[code];
    if (!look) { counts.notChecked++; continue; }
    if (!look.exists) { counts.notInTable++; continue; }
    if (!inText) counts.unverifiedQuote++;
    seen.add(code);
    out.push({
      code,
      // OpenEMR's description, not the model's: the table is the authority.
      description: look.description || d.description,
      modelDescription: d.description,
      quote: d.quote, quoteVerified: inText,
      unspecified: !!look.unspecified,
      moreSpecific: look.unspecified ? (look.moreSpecific || []).slice(0, 5) : [],
      alreadyOnEncounter: have.has(code)
    });
  }
  const dropped = counts.noQuote + counts.quoteNotFound + counts.badCode + counts.notInTable + counts.notChecked + counts.duplicate;
  return { output: { diagnoses: out, unreadable: Array.isArray(proposal && proposal.unreadable) ? proposal.unreadable : [] }, dropped, counts };
};

// Every code the model proposed that is ICD-10 in shape, for the server to
// look up before enforce() runs.
const proposedCodes = (proposal) => [...new Set((proposal && Array.isArray(proposal.diagnoses) ? proposal.diagnoses : [])
  .map(d => clinicalRepo.normalizeIcd10(d && d.code)).filter(Boolean))];

module.exports = { DX_SCHEMA, enforce, proposedCodes };
