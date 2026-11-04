// ============================================================================
// imeCases.js — the IME record analyzer's rules (spec GFC_IME_Record_Analyzer_Spec_v1.md).
//
// A contract examiner has to read a claim file of hundreds or thousands of
// pages before a VA C&P exam. This module holds every rule about an exam case
// and about what the model's reading of that file may say. It does no I/O:
// imeService.js gathers and stores, this decides. Same split as chartPacket.js,
// for the same reason: the rules have to be testable without Drive or Gemini.
//
// WHAT IT IS NOT. It never gives a medical opinion: no nexus, no rating, no
// diagnosis of its own, no DBQ answers. It finds and cites what the records say.
// The examiner forms the opinion. Three things here enforce that rather than
// describe it:
//   • every item must cite a document and a page that exist, or it is DROPPED
//     AND COUNTED (an uncited item is one the examiner cannot check);
//   • an item whose own words use opinion language the record it quotes does
//     not contain is dropped and counted (a prior examiner's opinion QUOTED
//     from the file is a record; the model's own is not);
//   • a claimed condition with nothing cited for it is listed in notFound,
//     DERIVED HERE from what survived, never taken on the model's word.
//
// THE CASE IS NOT A PATIENT. It never links to a client record or OpenEMR and
// never appears in the clinical workspace. `referenceId` is the contractor's
// anonymized id, never a name, SSN or VA file number.
// ============================================================================
'use strict';

const CASE_TYPES = Object.freeze({ VA_CP: 'va_cp' });
// IME-AI.3 adds `private_ime`. It is deliberately NOT accepted yet: it needs a
// referring-party record and that party's retention terms, and a case type the
// app accepts without them is one whose deletion clock nobody set.

const CONTRACTING_ENTITIES = Object.freeze({
  lsgs: 'LSGS',
  leidos_qtc: 'Leidos QTC',
  ves: 'VES'
});

const STATUSES = Object.freeze({ OPEN: 'open', REPORT_SUBMITTED: 'report_submitted', PURGED: 'purged' });

// Spec §6. The owner sets N ("Before building", item 2); 30 until then.
const DEFAULT_RETENTION_DAYS = 30;
const retentionDays = (env) => {
  const n = Number((env || process.env).GFC_IME_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
};

// 38 U.S.C. 7332 ("Before building", item 3). Until counsel confirms that
// examining for the claim is a permitted use, those records are EXCLUDED, not
// read. Fail closed: the setting has to be affirmatively true to lift it.
const RESTRICTED_7332_LABEL = '38 U.S.C. 7332 record (drug or alcohol abuse treatment, HIV, or sickle cell anemia), excluded pending counsel review';
const usc7332Cleared = (env) => ['1', 'true', 'yes', 'on'].includes(String((env || process.env).GFC_IME_7332_CLEARED || '').trim().toLowerCase());
// A BACKSTOP, not the control. The instruction tells the model to leave these
// records out; this catches the item that slipped through. It errs toward
// dropping, which is the safe direction while the question is open.
const RESTRICTED_7332_RE = /\b(hiv|aids\b|human immunodeficiency|sickle[- ]cell|alcohol(?:ism| abuse| use disorder| dependence| treatment| rehab)|substance (?:abuse|use)|drug (?:abuse|dependence|treatment|rehab)|opioid use disorder|detox|methadone|buprenorphine|suboxone|aa meeting|sarrtp|sardp)/i;

const REFERENCE_MAX = 60;
const CONDITION_MAX = 120;
const CONDITIONS_MAX = 40;

// ── who may do what ────────────────────────────────────────────────────────
// Spec §5: the capability `imeRecordReview` is held by the ASSIGNED examiner
// and by admin. Not case managers, clinical staff, managers or billing. The
// examiner is a licensed provider (FNP contractor); the role is read from the
// fresh user record by the caller, never from a stale token.
const isAdmin = (u) => !!u && u.role === 'admin';
const isExaminer = (u, resolveClinicalRole) =>
  !!u && !isAdmin(u) && u.accountStatus !== 'inactive' &&
  typeof resolveClinicalRole === 'function' && resolveClinicalRole(u) === 'provider';

const canSeeCase = (user, c, resolveClinicalRole) => {
  if (!user || !c) return false;
  if (isAdmin(user)) return true;
  return isExaminer(user, resolveClinicalRole) && String(c.examinerId) === String(user.id);
};
// Anybody who could ever hold the capability. Used to gate the surface itself.
const mayUseAnalyzer = (user, resolveClinicalRole) => isAdmin(user) || isExaminer(user, resolveClinicalRole);

// ── validating what a person types ─────────────────────────────────────────
const isoDate = (s) => {
  const t = String(s == null ? '' : s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : '';
};

// A reference id is the contractor's anonymized id. Two shapes are refused by
// name because they are the two most likely to be typed in by mistake: an SSN,
// and a VA file number (an 8–9 digit C-number). A name cannot be detected
// reliably, so the form says what belongs here.
const SSN_RE = /^\d{3}-?\d{2}-?\d{4}$/;
const VA_FILE_RE = /^c?\s?\d{8,9}$/i;
const cleanReference = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, REFERENCE_MAX);

const cleanConditions = (list) => {
  const arr = Array.isArray(list) ? list : String(list || '').split(/\n|;/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, CONDITION_MAX);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= CONDITIONS_MAX) break;
  }
  return out;
};

// Returns { value } or { error, fieldErrors }. `partial` validates only the
// keys present (an update).
const normalizeCaseInput = (body, { partial = false } = {}) => {
  const b = body || {};
  const has = (k) => !partial || Object.prototype.hasOwnProperty.call(b, k);
  const fieldErrors = {};
  const value = {};

  if (has('caseType')) {
    const t = b.caseType == null || b.caseType === '' ? CASE_TYPES.VA_CP : String(b.caseType);
    if (!Object.values(CASE_TYPES).includes(t)) {
      fieldErrors.caseType = t === 'private_ime'
        ? 'Private IME cases are not available yet. They need a referring-party record and its retention terms first.'
        : 'Unknown case type.';
    } else value.caseType = t;
  }
  if (has('referenceId')) {
    const r = cleanReference(b.referenceId);
    if (!r) fieldErrors.referenceId = 'The contractor\'s reference ID is required.';
    else if (SSN_RE.test(r)) fieldErrors.referenceId = 'That looks like a Social Security number. Use the contractor\'s anonymized reference ID instead.';
    else if (VA_FILE_RE.test(r)) fieldErrors.referenceId = 'That looks like a VA file number. Use the contractor\'s anonymized reference ID instead.';
    else value.referenceId = r;
  }
  if (has('contractingEntity')) {
    const e = String(b.contractingEntity || '');
    if (!CONTRACTING_ENTITIES[e]) fieldErrors.contractingEntity = `Choose the contracting entity: ${Object.values(CONTRACTING_ENTITIES).join(', ')}.`;
    else value.contractingEntity = e;
  }
  if (has('claimedConditions')) {
    const c = cleanConditions(b.claimedConditions);
    if (!c.length) fieldErrors.claimedConditions = 'List at least one claimed condition. The summary is organised by them.';
    else value.claimedConditions = c;
  }
  if (has('examDate')) {
    if (b.examDate === '' || b.examDate == null) value.examDate = null;
    else {
      const d = isoDate(b.examDate);
      if (!d) fieldErrors.examDate = 'Exam date must be a real date.';
      else value.examDate = d;
    }
  }
  if (Object.keys(fieldErrors).length) {
    return { error: Object.values(fieldErrors)[0], fieldErrors };
  }
  return { value };
};

// When the deletion clock runs out. Null until the report is submitted.
const purgeDueAt = (c, env) => {
  const t = Date.parse(c && c.reportSubmittedAt);
  if (Number.isNaN(t)) return null;
  return new Date(t + retentionDays(env) * 24 * 60 * 60 * 1000).toISOString();
};
const isPurgeDue = (c, nowMs, env) => {
  if (!c || c.status !== STATUSES.REPORT_SUBMITTED) return false;
  const due = purgeDueAt(c, env);
  return !!due && Date.parse(due) <= nowMs;
};

// What a screen is given about a case. An allow-list, so a field added to the
// row later does not reach a browser by default.
const publicCase = (c, { documents = [], analyses = [], examinerName = null, env } = {}) => ({
  id: c.id,
  caseType: c.caseType,
  referenceId: c.referenceId,
  contractingEntity: c.contractingEntity,
  contractingEntityLabel: CONTRACTING_ENTITIES[c.contractingEntity] || c.contractingEntity,
  examinerId: c.examinerId,
  examinerName,
  claimedConditions: c.claimedConditions || [],
  examDate: c.examDate || null,
  status: c.status,
  createdAt: c.createdAt,
  reportSubmittedAt: c.reportSubmittedAt || null,
  purgeDueAt: purgeDueAt(c, env),
  purgedAt: c.purgedAt || null,
  documentCount: documents.filter(d => !d.removedAt && !d.purgedAt).length,
  pageCount: documents.filter(d => !d.removedAt && !d.purgedAt).reduce((n, d) => n + (d.pageCount || 0), 0),
  lastAnalysis: (() => {
    const a = [...analyses].sort((x, y) => String(y.at).localeCompare(String(x.at)))[0];
    return a ? { id: a.id, status: a.status, at: a.at, finishedAt: a.finishedAt || null } : null;
  })()
});

const publicDocument = (d) => ({
  id: d.id,
  fileName: d.purgedAt ? null : d.fileName,
  mimeType: d.mimeType,
  size: d.size,
  pageCount: d.pageCount,
  sha256: d.sha256,
  uploadedBy: d.uploadedBy ? d.uploadedBy.name : null,
  uploadedAt: d.uploadedAt,
  hasTextLayer: d.hasTextLayer === true,
  removedAt: d.removedAt || null,
  purgedAt: d.purgedAt || null
});

// ── the model's output schema (spec §3) ────────────────────────────────────
// In modelEngine.js's vocabulary. The model cites `sourceId` (the label it is
// shown beside each document part) and the page WITHIN that part; the server
// turns that into { documentId, page } in the original file. Undeclared keys
// are dropped at every level by the engine's validator.
const EVENT_TYPES = Object.freeze(['visit', 'admission', 'procedure', 'imaging', 'lab',
  'prescription', 'injury', 'separation_exam', 'other']);

const CITATION = { type: 'object', required: true, items: {
  sourceId: { type: 'string', maxLength: 120, required: true },
  page: { type: 'number', required: true }
} };
const QUOTE = { type: 'string', maxLength: 400 };
const FINDING = {
  text: { type: 'string', maxLength: 600, required: true },
  date: { type: 'string', maxLength: 40 },
  citation: CITATION,
  quote: QUOTE
};
const MAX_ROWS = 1500;

const PASS_SCHEMA = Object.freeze({
  fields: {
    chronology: { type: 'array', maxItems: MAX_ROWS, items: {
      date: { type: 'string', maxLength: 40 },
      facility: { type: 'string', maxLength: 200 },
      provider: { type: 'string', maxLength: 200 },
      eventType: { type: 'string', required: true, enum: EVENT_TYPES },
      summary: { type: 'string', maxLength: 600, required: true },
      citation: CITATION,
      quote: QUOTE
    } },
    byCondition: { type: 'array', maxItems: CONDITIONS_MAX, items: {
      claimedCondition: { type: 'string', maxLength: CONDITION_MAX, required: true },
      diagnosesRecorded: { type: 'array', maxItems: MAX_ROWS, items: FINDING },
      firstDocumented: { type: 'object', items: { date: { type: 'string', maxLength: 40 }, citation: CITATION, quote: QUOTE } },
      inServiceEvents: { type: 'array', maxItems: MAX_ROWS, items: FINDING },
      treatment: { type: 'array', maxItems: MAX_ROWS, items: FINDING },
      currentSeverity: { type: 'array', maxItems: MAX_ROWS, items: FINDING },
      functionalImpact: { type: 'array', maxItems: MAX_ROWS, items: FINDING }
    } },
    medications: { type: 'array', maxItems: MAX_ROWS, items: {
      name: { type: 'string', maxLength: 200, required: true },
      dates: { type: 'string', maxLength: 120 },
      citation: CITATION,
      quote: QUOTE
    } },
    notFound: { type: 'array', maxItems: CONDITIONS_MAX, items: {
      claimedCondition: { type: 'string', maxLength: CONDITION_MAX, required: true },
      searchedFor: { type: 'string', maxLength: 400 }
    } },
    unreadable: { type: 'array', maxItems: 500, items: {
      sourceId: { type: 'string', maxLength: 120, required: true },
      pages: { type: 'string', maxLength: 120 },
      why: { type: 'string', maxLength: 300, required: true }
    } }
  }
});

const CONDITION_LISTS = Object.freeze(['diagnosesRecorded', 'inServiceEvents', 'treatment', 'currentSeverity', 'functionalImpact']);

// The per-call instruction. The system instruction (vertexTransport.js) carries
// the standing rules; this carries what is specific to this case and pass.
const buildInstruction = ({ claimedConditions, pass, of, cleared7332 }) => [
  `This is pass ${pass} of ${of} over one veteran's claim file for a VA Compensation and Pension exam.`,
  `The claimed conditions are: ${claimedConditions.map(c => `"${c}"`).join(', ')}. Use these names exactly in byCondition and notFound.`,
  'Each document part below is labelled with a SOURCE id. Cite that id and the page number within that part (1 is the first page of the part).',
  'Write dates as YYYY-MM-DD, or YYYY-MM or YYYY when that is all the record gives.',
  cleared7332 ? null
    : 'Do NOT summarize, quote or list anything from a record of treatment for drug abuse, alcoholism or alcohol abuse, HIV infection, or sickle cell anemia. List those pages in unreadable with why "38 U.S.C. 7332 record, excluded".'
].filter(Boolean).join(' ');

// ── planning the passes ────────────────────────────────────────────────────
// Documents are packed into passes by PAGE COUNT, in upload order. A document
// bigger than one pass is split into page ranges, and each range is its own
// source id (`doc:<id>#p<from>-<to>`) so a citation still names exactly which
// pages it came from. Pure: the service turns each part into bytes.
const DEFAULT_PAGES_PER_PASS = 300;
const pagesPerPass = (env) => {
  const n = Number((env || process.env).GFC_IME_PAGES_PER_PASS);
  return Number.isFinite(n) && n >= 10 && n <= 1000 ? Math.floor(n) : DEFAULT_PAGES_PER_PASS;
};

const sourceIdFor = (documentId, from, to, total) =>
  (from === 1 && to === total) ? `doc:${documentId}` : `doc:${documentId}#p${from}-${to}`;

const planPasses = (documents, budget) => {
  const per = Math.max(1, Math.floor(budget || DEFAULT_PAGES_PER_PASS));
  const passes = [];
  let current = { parts: [], pages: 0 };
  const flush = () => { if (current.parts.length) passes.push(current); current = { parts: [], pages: 0 }; };
  for (const d of documents || []) {
    const total = Math.max(1, Number(d.pageCount) || 1);
    let from = 1;
    while (from <= total) {
      const room = per - current.pages;
      if (room <= 0) { flush(); continue; }
      const to = Math.min(total, from + room - 1);
      current.parts.push({ documentId: d.id, from, to, pages: to - from + 1, sourceId: sourceIdFor(d.id, from, to, total) });
      current.pages += to - from + 1;
      from = to + 1;
      if (current.pages >= per) flush();
    }
  }
  flush();
  return passes.map((p, i) => ({ pass: i + 1, of: passes.length, parts: p.parts, pages: p.pages }));
};

// ── citations ──────────────────────────────────────────────────────────────
// A part's id is `doc:<id>` or `doc:<id>#p<from>-<to>`. The transport may split
// a part again (a file over Vertex's size ceiling), appending its own
// `#p<a>-<b>` relative to what it was given, so both levels are resolved.
const parsePartId = (sourceId) => {
  const s = String(sourceId || '');
  const m = /^doc:([^#\s]+)((?:#p\d+-\d+)*)$/.exec(s);
  if (!m) return null;
  const ranges = [...m[2].matchAll(/#p(\d+)-(\d+)/g)].map(r => [Number(r[1]), Number(r[2])]);
  let offset = 0;
  let span = null;
  for (const [a, b] of ranges) {
    if (a < 1 || b < a) return null;
    if (span !== null && b > span) return null;
    offset += a - 1;
    span = b - a + 1;
  }
  return { documentId: m[1], offset, span };
};

// { documentId, page } in the ORIGINAL file, or null when the citation does
// not resolve to a part this pass was given and a page inside it.
const resolveCitation = (citation, partsById) => {
  if (!citation || typeof citation !== 'object') return null;
  const sid = String(citation.sourceId || '');
  const page = Number(citation.page);
  if (!Number.isInteger(page) || page < 1) return null;
  const parsed = parsePartId(sid);
  if (!parsed) return null;
  // The base part (before any transport split) must be one this pass sent:
  // strip trailing ranges until the id is one we sent.
  let part = null;
  for (let id = sid; id; ) {
    if (partsById.has(id)) { part = partsById.get(id); break; }
    const cut = id.replace(/#p\d+-\d+$/, '');
    if (cut === id) break;
    id = cut;
  }
  if (!part) return null;
  const span = parsed.span !== null ? parsed.span : (part.to - part.from + 1);
  if (page > span) return null;
  const original = parsed.offset + page;
  if (original < part.from || original > part.to) return null;
  return { documentId: part.documentId, page: original };
};

// ── quote checking ─────────────────────────────────────────────────────────
const normText = (s) => String(s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// `pageText(documentId, page)` returns the page's text layer, or '' / null
// when the page has none (an image-only scan).
const checkQuote = (quote, documentId, page, pageText) => {
  if (!quote || !String(quote).trim()) return { quoteVerified: false, quoteCheck: 'no_quote' };
  const text = typeof pageText === 'function' ? pageText(documentId, page) : null;
  if (!text || !normText(text)) return { quoteVerified: false, quoteCheck: 'no_text_layer' };
  const q = normText(quote);
  if (!q) return { quoteVerified: false, quoteCheck: 'no_quote' };
  return normText(text).includes(q)
    ? { quoteVerified: true, quoteCheck: 'matched' }
    : { quoteVerified: false, quoteCheck: 'not_on_page' };
};

// Opinion language in the MODEL'S OWN words. Allowed only when the record it
// quotes says it too.
const OPINION_RE = /(at least as likely as not|more likely than not|less likely than not|as likely as not|\bnexus\b|service[- ]connect|\bdbq\b|\b\d{1,3}\s?%\s*(?:rating|disab)|\brating of\b|\bshould be rated\b|\bwarrants? (?:a|an) (?:rating|evaluation))/i;
const opinionNotInQuote = (ownText, quote) => {
  const m = OPINION_RE.exec(String(ownText || ''));
  if (!m) return false;
  return !normText(quote).includes(normText(m[0]));
};

const isRestricted7332 = (...texts) => texts.some(t => RESTRICTED_7332_RE.test(String(t || '')));

// One pass's validated output → items in the spec's shape, with every rule
// above applied. Returns the cleaned pass and what was dropped, by reason.
const cleanPass = (proposal, { parts, pageText, cleared7332 }) => {
  const partsById = new Map((parts || []).map(p => [p.sourceId, p]));
  const dropped = { uncited: 0, opinion: 0, restricted7332: 0 };
  const quoteCounts = { matched: 0, not_on_page: 0, no_text_layer: 0, no_quote: 0 };

  const keep = (row, ownText) => {
    const citation = resolveCitation(row && row.citation, partsById);
    if (!citation) { dropped.uncited++; return null; }
    if (opinionNotInQuote(ownText, row.quote)) { dropped.opinion++; return null; }
    if (!cleared7332 && isRestricted7332(ownText, row.quote)) { dropped.restricted7332++; return null; }
    const q = checkQuote(row.quote, citation.documentId, citation.page, pageText);
    quoteCounts[q.quoteCheck]++;
    return { citation, quote: row.quote ? String(row.quote) : null, ...q };
  };

  const out = { chronology: [], byCondition: [], medications: [], notFound: [], unreadable: [] };
  const p = proposal || {};

  for (const r of p.chronology || []) {
    const k = keep(r, `${r.summary} ${r.facility || ''} ${r.provider || ''}`);
    if (!k) continue;
    out.chronology.push({ date: r.date || null, facility: r.facility || null, provider: r.provider || null,
      eventType: r.eventType, summary: r.summary, ...k });
  }
  for (const c of p.byCondition || []) {
    const row = { claimedCondition: c.claimedCondition, firstDocumented: null };
    for (const list of CONDITION_LISTS) {
      row[list] = [];
      for (const it of c[list] || []) {
        const k = keep(it, it.text);
        if (k) row[list].push({ text: it.text, date: it.date || null, ...k });
      }
    }
    if (c.firstDocumented) {
      const k = keep(c.firstDocumented, '');
      if (k) row.firstDocumented = { date: c.firstDocumented.date || null, ...k };
    }
    out.byCondition.push(row);
  }
  for (const m of p.medications || []) {
    const k = keep(m, m.name);
    if (k) out.medications.push({ name: m.name, dates: m.dates || null, ...k });
  }
  out.notFound = (p.notFound || []).map(n => ({ claimedCondition: n.claimedCondition, searchedFor: n.searchedFor || null }));
  for (const u of p.unreadable || []) {
    const parsed = parsePartId(u.sourceId);
    const part = partsById.get(String(u.sourceId)) || (parsed && [...partsById.values()].find(x => x.documentId === parsed.documentId));
    out.unreadable.push({ documentId: part ? part.documentId : null, sourceId: u.sourceId, pages: u.pages || null, why: u.why });
  }
  return { pass: out, dropped, quoteCounts };
};

// ── merging passes ─────────────────────────────────────────────────────────
// DETERMINISTIC, on the server, rather than a second model call. The chart
// review merges with the model because its findings are prose that has to be
// de-duplicated by meaning; this output is citations, and a model merge is a
// place a citation can be lost or a new item invented. Concatenating and
// sorting loses nothing and costs nothing.
const dateKey = (d) => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(d || '').trim());
  return m ? `${m[1]}-${m[2] || '00'}-${m[3] || '00'}` : null;
};
const byDate = (a, b) => {
  const x = dateKey(a.date), y = dateKey(b.date);
  if (x && y) return x < y ? -1 : (x > y ? 1 : 0);
  if (x) return -1;
  if (y) return 1;
  return 0;
};
const citeKey = (r) => `${r.citation.documentId}:${r.citation.page}`;
const dedupe = (rows, keyOf) => {
  const seen = new Set();
  return rows.filter(r => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
};

const mergePasses = (cleaned, claimedConditions) => {
  const conditions = claimedConditions || [];
  const canonical = new Map(conditions.map(c => [c.toLowerCase(), c]));
  const chronology = dedupe(cleaned.flatMap(p => p.chronology),
    r => `${dateKey(r.date)}|${normText(r.summary)}|${citeKey(r)}`).sort(byDate);
  const medications = dedupe(cleaned.flatMap(p => p.medications),
    r => `${normText(r.name)}|${citeKey(r)}`).sort((a, b) => a.name.localeCompare(b.name));

  // One row per claimed condition, in the order the examiner typed them. A
  // condition the model named that is not on the case is kept under its own
  // name rather than dropped, so nothing cited disappears.
  const rows = new Map(conditions.map(c => [c, {
    claimedCondition: c, firstDocumented: null,
    ...Object.fromEntries(CONDITION_LISTS.map(l => [l, []]))
  }]));
  for (const p of cleaned) {
    for (const c of p.byCondition) {
      const name = canonical.get(String(c.claimedCondition).toLowerCase()) || c.claimedCondition;
      if (!rows.has(name)) rows.set(name, { claimedCondition: name, firstDocumented: null, ...Object.fromEntries(CONDITION_LISTS.map(l => [l, []])) });
      const row = rows.get(name);
      for (const l of CONDITION_LISTS) row[l].push(...c[l]);
      // The EARLIEST documented date across passes. An undated one only wins
      // when nothing dated was found.
      if (c.firstDocumented) {
        const cur = row.firstDocumented;
        if (!cur || (dateKey(c.firstDocumented.date) && (!dateKey(cur.date) || dateKey(c.firstDocumented.date) < dateKey(cur.date)))) {
          row.firstDocumented = c.firstDocumented;
        }
      }
    }
  }
  for (const row of rows.values()) {
    for (const l of CONDITION_LISTS) row[l] = dedupe(row[l], r => `${normText(r.text)}|${citeKey(r)}`).sort(byDate);
  }
  const byCondition = [...rows.values()];

  // notFound IS DERIVED, NOT REPORTED. A condition is "not found" only when
  // nothing cited survived for it across every pass. One pass saying "not
  // found" is about the pages that pass saw.
  const hasAnything = (row) => !!row.firstDocumented || CONDITION_LISTS.some(l => row[l].length);
  const searched = new Map();
  for (const p of cleaned) for (const n of p.notFound) {
    const name = canonical.get(String(n.claimedCondition).toLowerCase()) || n.claimedCondition;
    if (n.searchedFor) searched.set(name, [...(searched.get(name) || []), n.searchedFor]);
  }
  const notFound = byCondition.filter(r => conditions.includes(r.claimedCondition) && !hasAnything(r))
    .map(r => ({
      claimedCondition: r.claimedCondition,
      searchedFor: [...new Set(searched.get(r.claimedCondition) || [])].join('; ') || null,
      // Said on the row so nobody reads an absence as a finding.
      note: 'No record of this condition was found in the pages that were read. This states an absence in the file, not a conclusion.'
    }));

  const unreadable = dedupe(cleaned.flatMap(p => p.unreadable), u => `${u.sourceId}|${u.pages}|${u.why}`);
  return { chronology, byCondition, medications, notFound, unreadable };
};

const countItems = (output) => ({
  chronology: output.chronology.length,
  medications: output.medications.length,
  conditionItems: output.byCondition.reduce((n, r) => n + CONDITION_LISTS.reduce((m, l) => m + r[l].length, 0) + (r.firstDocumented ? 1 : 0), 0),
  notFound: output.notFound.length,
  unreadable: output.unreadable.length
});

// Spec §6: the IME audit keeps who, when, model, invocation ids, document
// hashes, page counts and item counts, AND NO CONTENT. The claim file is
// deleted after the report; a copy of its content here would defeat that.
// Built from an allow-list so a content field cannot ride in.
const auditRow = ({ caseId, analysisId, actor, at, model, invocationIds, documents, counts, dropped, quoteCounts, passes, result, usage }) => ({
  id: `imeaud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  caseId, analysisId,
  actorId: actor ? actor.id : null,
  actorName: actor ? (actor.name || actor.email || null) : null,
  at, model: model || null, result,
  invocationIds: Array.isArray(invocationIds) ? invocationIds.slice() : [],
  documents: (documents || []).map(d => ({ documentId: d.id, sha256: d.sha256, pageCount: d.pageCount })),
  passes: passes || null,
  counts: counts || null,
  dropped: dropped || null,
  quoteChecks: quoteCounts || null,
  inputTokens: usage ? usage.inputTokens : null,
  outputTokens: usage ? usage.outputTokens : null
});

// Spend per case (spec §7). An ESTIMATE from token counts and the per-million
// prices the owner sets; null when no price is set rather than a made-up one.
const estimateCost = (usage, env) => {
  const e = env || process.env;
  const pin = Number(e.GFC_IME_PRICE_PER_MTOK_INPUT);
  const pout = Number(e.GFC_IME_PRICE_PER_MTOK_OUTPUT);
  if (!usage || !Number.isFinite(pin) || !Number.isFinite(pout) || pin <= 0 || pout <= 0) return null;
  const cost = ((usage.inputTokens || 0) * pin + (usage.outputTokens || 0) * pout) / 1e6;
  return Math.round(cost * 100) / 100;
};

module.exports = {
  CASE_TYPES, CONTRACTING_ENTITIES, STATUSES, EVENT_TYPES, CONDITION_LISTS,
  DEFAULT_RETENTION_DAYS, DEFAULT_PAGES_PER_PASS, RESTRICTED_7332_LABEL,
  retentionDays, usc7332Cleared, pagesPerPass,
  isAdmin, isExaminer, canSeeCase, mayUseAnalyzer,
  normalizeCaseInput, cleanConditions, isoDate,
  purgeDueAt, isPurgeDue, publicCase, publicDocument,
  PASS_SCHEMA, buildInstruction,
  planPasses, sourceIdFor, parsePartId, resolveCitation,
  normText, checkQuote, opinionNotInQuote, isRestricted7332,
  cleanPass, mergePasses, countItems, auditRow, estimateCost, dateKey
};
