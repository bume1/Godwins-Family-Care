'use strict';
// mdmExtraction.js — clinical fact extraction (AI coding pipeline spec,
// 2026-11-04, Phase 2).
//
// THE MODEL EXTRACTS FACTS. IT NAMES NO CODE. Rules decide a level later
// (Phase 3), and a clinician confirms the facts about her own visit first. So:
//   - the schema below has no code field of any kind (build-enforced);
//   - the model is never shown the encounter's service codes or any ICD-10
//     code: diagnoses go in as descriptions only, so nothing in the prompt
//     invites it to support a code already chosen;
//   - the output is a DRAFT attached to the coding workflow. It is never
//     written to the chart.
//
// PURE. The server gathers, the engine calls, this file arranges and checks.
//
// EVERY ITEM CARRIES A QUOTE, AND THE QUOTE MUST COME FROM THIS VISIT'S OWN
// DOCUMENTATION (spec §2.4, tightened 2026-11-04). Only what the clinician
// documented at this visit counts toward the level: the note and the
// encounter's own fields. The problem and medication lists are sent as
// context, but a quote found only there is dropped and counted
// (`notFromNote`): a problem on the list that nobody addressed today must not
// raise the level. A quote found nowhere is dropped as invented.
//
// DOCUMENTS ARE NOT SENT (2026-11-04). A document attached to the visit is the
// one place a 42 CFR Part 2 record received for treatment can sit, and coding
// is payment, not treatment. Its words could not be verified anyway, so it
// could never have supplied a counted fact. If the note says an outside record
// was reviewed, the note's own sentence is the quote.
//
// `quote` is deliberately NOT a required schema field. In the shared engine one
// item failing the schema fails the whole answer, so a single quoteless item
// would sink the extraction instead of being dropped and counted.

const noteFormat = require('./public/note-format');

const PROBLEM_STATUS = Object.freeze(['stable', 'worsening', 'new', 'resolved', 'unclear']);
const PROBLEM_MANAGEMENT = Object.freeze(['observation', 'medication', 'referral', 'testing', 'procedure', 'other']);
const DATA_KINDS = Object.freeze(['lab', 'imaging', 'outside_record', 'prior_note', 'independent_historian',
  'discussion_with_clinician', 'test_interpretation']);
const RISK_FACTORS = Object.freeze(['prescription_management', 'decision_re_hospitalization', 'decision_re_surgery',
  'drug_therapy_monitoring', 'social_determinants', 'otc_management', 'other']);

const QUOTE_MAX = 300;

// Spec §2.3, in the engine's schema vocabulary. The engine drops any key not
// declared here, at every level, so nothing undeclared reaches storage.
const MDM_SCHEMA = Object.freeze({
  fields: {
    problemsAddressed: {
      type: 'array',
      items: {
        description: { type: 'string', maxLength: 300, required: true },
        status: { type: 'string', required: true, enum: PROBLEM_STATUS },
        management: { type: 'string', required: true, enum: PROBLEM_MANAGEMENT },
        quote: { type: 'string', maxLength: QUOTE_MAX }
      }
    },
    dataReviewed: {
      type: 'array',
      items: {
        kind: { type: 'string', required: true, enum: DATA_KINDS },
        detail: { type: 'string', maxLength: 300, required: true },
        quote: { type: 'string', maxLength: QUOTE_MAX }
      }
    },
    risk: {
      type: 'array',
      items: {
        factor: { type: 'string', required: true, enum: RISK_FACTORS },
        detail: { type: 'string', maxLength: 300, required: true },
        quote: { type: 'string', maxLength: QUOTE_MAX }
      }
    },
    time: {
      type: 'object',
      items: {
        totalMinutes: { type: 'number' },
        statementPresent: { type: 'boolean', required: true },
        quote: { type: 'string', maxLength: QUOTE_MAX }
      }
    },
    unreadable: { type: 'array', itemType: 'string', maxLength: 300 }
  }
});

const LIST_KEYS = Object.freeze(['problemsAddressed', 'dataReviewed', 'risk']);

// ---- The note, as plain text, labelled by where each line came from ----------
// Every string in the shared note, through the one formatter the app, OpenEMR
// and the PDF already use. Bookkeeping keys are not text a clinician wrote.
const NOTE_SKIP_KEYS = new Set(['visit', 'kind', 'carriedForward', 'version', 'updatedAt', 'updatedBy', 'confirmedFields']);
const humanize = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase());
const noteToText = (note) => {
  const lines = [];
  const walk = (v, label) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const t = noteFormat.toPlainText(v).trim();
      if (t) lines.push(`${label}: ${t}`);
      return;
    }
    if (typeof v === 'number') { lines.push(`${label}: ${v}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${label} ${i + 1}`)); return; }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (NOTE_SKIP_KEYS.has(k)) continue;
        walk(x, label ? `${label} / ${humanize(k)}` : humanize(k));
      }
    }
  };
  walk(note || {}, '');
  return lines.join('\n');
};

// ---- The input packet (spec §2.2) ------------------------------------------------
// The note, the encounter's structured fields, the problem list, the medication
// list. Documents are not sent (see the header). Each section has a sourceId.
// A section that could not be read is listed in `notRead`, never filled another
// way.
const buildMdmInput = ({ encounterUuid, record, narrativeText, problems, medications, notRead }) => {
  const sections = [];
  const rec = record || {};
  const noteText = [noteToText(rec.note), String(narrativeText || '').trim()].filter(Boolean).join('\n\n');
  if (noteText) sections.push({ sourceId: `enc:${encounterUuid}:note`, kind: 'encounter note', title: 'The encounter note', text: noteText, documentation: true });
  const visit = rec.visit || {};
  const fields = [
    rec.date ? `Date of service: ${rec.date}` : null,
    visit.appointmentType ? `Visit type: ${visit.appointmentType}` : null,
    visit.modality ? `Modality: ${visit.modality}` : null,
    visit.location ? `Location: ${visit.location}` : null,
    rec.reason ? `Reason for visit: ${rec.reason}` : null,
    // Descriptions only. A code in the prompt invites the model to support it.
    ...(rec.diagnoses || []).map(d => (d && d.description ? `Diagnosis recorded: ${d.description}` : null))
  ].filter(Boolean);
  if (fields.length) sections.push({ sourceId: `enc:${encounterUuid}:fields`, kind: 'encounter fields', title: 'The encounter\'s structured fields', text: fields.join('\n'), documentation: true });
  if (Array.isArray(problems)) {
    sections.push({ sourceId: 'emr:problems', kind: 'problem list', title: 'Problem list',
      text: problems.map(p => [p && (p.title || p.description), p && p.status].filter(Boolean).join(' — ')).filter(Boolean).join('\n') || 'None recorded.' });
  }
  if (Array.isArray(medications)) {
    sections.push({ sourceId: 'emr:medications', kind: 'medication list', title: 'Medication list',
      text: medications.map(m => [m && (m.title || m.name), m && m.dosage, m && m.status].filter(Boolean).join(' — ')).filter(Boolean).join('\n') || 'None recorded.' });
  }
  return {
    sections,
    notRead: Array.isArray(notRead) ? notRead : [],
    hasNote: !!noteText
  };
};

// ---- Quote enforcement (spec §2.4) ---------------------------------------------
const normalize = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[^a-z0-9%'".,/:;()-]+/g, ' ').replace(/\s+/g, ' ').trim();

// `noteTexts` is this visit's documentation (the note and the encounter's
// fields); `contextTexts` is everything else sent (the problem and medication
// lists). Only a quote found in the note counts.
const documentationTexts = (sections) => (sections || []).filter(s => s && s.documentation).map(s => s.text);
const contextTexts = (sections) => (sections || []).filter(s => s && !s.documentation).map(s => s.text);

const enforceQuotes = (proposal, { noteTexts, contextTexts: ctx }) => {
  const note = normalize((noteTexts || []).join('\n'));
  const context = normalize((ctx || []).join('\n'));
  const counts = { noQuote: 0, quoteNotFound: 0, notFromNote: 0 };
  const check = (quote) => {
    const q = normalize(quote);
    if (!q) return 'none';
    if (note.includes(q)) return 'verified';
    return context.includes(q) ? 'not_from_note' : 'not_found';
  };
  const tally = (state) => {
    if (state === 'none') counts.noQuote++;
    else if (state === 'not_found') counts.quoteNotFound++;
    else if (state === 'not_from_note') counts.notFromNote++;
  };
  const out = {};
  for (const key of LIST_KEYS) {
    out[key] = [];
    for (const item of (proposal && Array.isArray(proposal[key]) ? proposal[key] : [])) {
      const state = check(item && item.quote);
      if (state !== 'verified') { tally(state); continue; }
      out[key].push({ ...item, quoteVerified: true });
    }
  }
  // Time: a minute count needs a real quote, or it is not a fact the note
  // states. "No time statement" is itself a fact and needs no quote.
  const t = (proposal && proposal.time) || {};
  const minutes = typeof t.totalMinutes === 'number' && Number.isFinite(t.totalMinutes) && t.totalMinutes > 0 ? Math.round(t.totalMinutes) : null;
  let time = { totalMinutes: null, statementPresent: false, quote: null, quoteVerified: false };
  if (t.statementPresent || minutes != null) {
    const state = check(t.quote);
    if (state !== 'verified') tally(state);
    else time = { totalMinutes: minutes, statementPresent: true, quote: t.quote, quoteVerified: true };
  }
  out.time = time;
  out.unreadable = Array.isArray(proposal && proposal.unreadable) ? proposal.unreadable : [];
  return { output: out, dropped: counts.noQuote + counts.quoteNotFound + counts.notFromNote, counts };
};

module.exports = {
  PROBLEM_STATUS, PROBLEM_MANAGEMENT, DATA_KINDS, RISK_FACTORS, QUOTE_MAX, LIST_KEYS,
  MDM_SCHEMA, noteToText, buildMdmInput, normalize, enforceQuotes, documentationTexts, contextTexts
};
