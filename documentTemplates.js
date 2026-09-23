// ============================================================================
// Deterministic document reading (2026-09-23, owner-directed)
// ============================================================================
// Session 4.9b built the whole safety apparatus for reading a scanned document
// into PROPOSALS a person approves — the allow-list, the identity-conflict
// guard, the stale-field refusal, the staff-verified provenance, the review
// screen and the ledger. It then made the only source of those proposals a
// model on Bedrock, which is not reachable until an AWS agreement lands.
//
// NONE OF THAT SAFETY WORK IS MODEL-SPECIFIC. `documentExtraction.buildProposals`
// takes a plain `{ path: value }` map and has no idea where the values came
// from. So this module produces that map WITHOUT a model, out of the text the
// document already carries — and every proposal it makes goes through exactly
// the same review a model's would.
//
// THIS IS NOT A STOPGAP AND SHOULD NOT BE REMOVED WHEN BEDROCK ARRIVES. For a
// form the office receives a hundred times — the same referring practice's
// face sheet, the same carrier's insurance card — a declared label beats a
// model: it is cheaper, it is auditable, it is reproducible, and it cannot
// invent a member ID. The model earns its place on the documents nobody has
// seen before, which is the smaller pile.
//
// WHAT IT CANNOT DO, STATED PLAINLY: read a photograph. A scan with no text
// layer carries nothing to match against, and this reports that as its own
// outcome rather than as "nothing found" — an empty result is not a diagnosis.
// OCR is the separate piece that closes it.

const { PDFDocument } = require('pdf-lib');
const packet = require('./welcomePacketImport');
const ocr = require('./documentOcr');
const extraction = require('./documentExtraction');

// ---- How a value is recognised --------------------------------------------
// EVERY DECLARED PATH CARRIES A FORMAT RULE, AND A VALUE THAT FAILS IT IS NOT
// PROPOSED AT ALL. Not proposed with low confidence — dropped.
//
// That is the whole safety argument for reading documents without a person in
// the loop on the extraction itself: a blank field gets asked about, and a
// wrong member ID gets BILLED and surfaces months later as a denied claim. A
// reviewer looking at forty plausible-looking rows will approve them; a
// reviewer looking at six correct ones and a gap will fill the gap.
const digits = (s) => String(s || '').replace(/\D+/g, '');

const RULES = {
  // A Medicare Beneficiary Identifier: 11 characters, position-by-position.
  // C = a letter excluding S, L, O, I, B, Z. N = a digit. A = either.
  // Checking the SHAPE is what stops "See attached" landing in the MBI field.
  mbi: (v) => {
    const s = String(v || '').toUpperCase().replace(/[\s-]+/g, '');
    if (s.length !== 11) return null;
    const C = /[ACDEFGHJKMNPQRTUVWXY]/, N = /[0-9]/, AN = /[0-9ACDEFGHJKMNPQRTUVWXY]/;
    const pattern = [N, C, AN, N, C, AN, N, C, C, N, N];
    for (let i = 0; i < 11; i++) if (!pattern[i].test(s[i])) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 7)}-${s.slice(7)}`;
  },
  phone: (v) => {
    const d = digits(v);
    const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    if (ten.length !== 10) return null;
    // A number that starts 0 or 1 in either block is not dialable.
    if (/^[01]/.test(ten) || /^[01]/.test(ten.slice(3))) return null;
    return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  },
  // Returned as YYYY-MM-DD, which is what every intake date field stores.
  //
  // A TWO-DIGIT YEAR IS RESOLVED INTO THE PAST, ALWAYS. The first version of
  // this used the usual 50-99/00-49 pivot, which turned "3-18-48" — a
  // perfectly ordinary way to print a 1948 date of birth — into 2048. Every
  // date this rule reads is a date of birth, and a date of birth is never in
  // the future, so the two candidates are tried newest-first and the first one
  // that is not in the future wins. Caught by its own test.
  date: (v, today) => {
    const s = String(v || '').trim();
    const nowYear = Number(String(today || new Date().toISOString()).slice(0, 4));
    let y, m, d;
    let mm = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
    if (mm) {
      m = Number(mm[1]); d = Number(mm[2]); y = Number(mm[3]);
      if (mm[3].length === 2) {
        const twoThousand = 2000 + y;
        y = twoThousand <= nowYear ? twoThousand : 1900 + y;
      }
    } else {
      mm = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!mm) return null;
      y = Number(mm[1]); m = Number(mm[2]); d = Number(mm[3]);
    }
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900) return null;
    // Even a four-digit year is refused when it is in the future: a date of
    // birth that has not happened is a misread, not a date.
    if (y > nowYear) return null;
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  },
  // An identifier: letters, digits and dashes, long enough to be one and short
  // enough not to be a sentence. "See card" and "N/A" fail it, which is the point.
  memberId: (v) => {
    const s = String(v || '').toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9][A-Z0-9-]{3,19}$/.test(s)) return null;
    if (!/\d/.test(s)) return null;           // an ID with no digit at all is prose
    if (/^(N\/?A|NONE|SEE|UNKNOWN)/.test(s)) return null;
    return s;
  },
  // A person's or organisation's name. Deliberately permissive about
  // punctuation (O'Brien, St. Joseph's) and deliberately NOT about length: a
  // whole sentence next to a label is not a name.
  name: (v) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 60) return null;
    if (!/[A-Za-z]/.test(s)) return null;
    if (s.split(' ').length > 6) return null;
    if (/^(N\/?A|NONE|UNKNOWN)$/i.test(s)) return null;
    return s;
  },
  // Free-ish text where the value genuinely varies (a plan name).
  text: (v) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s.length < 2 || s.length > 80) return null;
    if (/^(N\/?A|NONE|UNKNOWN)$/i.test(s)) return null;
    return s;
  }
};

// ---- What a label looks like on a real document ---------------------------
// Declared per intake path, longest-first at match time so "Medicare Number"
// never loses to "Number". EVERY PATH HERE MUST BE DECLARED IN
// documentExtraction.TARGETS FOR ITS KIND — checked at load, below, so a path
// this file invents can never reach a client record.
//
// This list is the thing that wants tuning against real documents. Adding a
// label variant is a one-line edit and needs no other change.
//
// ORDER MATTERS WITHIN A KIND. One line feeds one path, and paths are tried in
// declaration order, so the path with the MORE SPECIFIC label goes first —
// `medicare.advantagePlan` before `commercial.planName`, or a card's "Plan
// Name" ends up asserting a Medicare Advantage plan that does not exist.
const TEMPLATES = Object.freeze({
  insuranceCard: {
    'medicare.id': { rule: 'mbi', labels: ['medicare beneficiary identifier', 'medicare number', 'medicare id', 'mbi', 'member number', 'medicare claim number'] },
    'medicare.advantagePlan': { rule: 'text', labels: ['medicare advantage plan', 'advantage plan', 'ma plan'] },
    'medicare.advMemberId': { rule: 'memberId', labels: ['advantage member id', 'ma member id'] },
    'medicare.advGroupNum': { rule: 'memberId', labels: ['advantage group', 'ma group'] },
    'medicaid.memberId': { rule: 'memberId', labels: ['medicaid id', 'medicaid number', 'medicaid member id'] },
    'medicaid.plan': { rule: 'text', labels: ['medicaid plan', 'managed care plan', 'cmo'] },
    'commercial.carrier': { rule: 'text', labels: ['carrier', 'insurance carrier', 'insurer', 'payer', 'plan administrator'] },
    'commercial.planName': { rule: 'text', labels: ['plan name', 'plan', 'benefit plan', 'product'] },
    'commercial.memberId': { rule: 'memberId', labels: ['member id', 'member number', 'subscriber id', 'subscriber number', 'id number', 'policy number', 'policy'] },
    'commercial.groupNum': { rule: 'memberId', labels: ['group number', 'group no', 'group'] },
    'commercial.insPhone': { rule: 'phone', labels: ['member services', 'customer service', 'provider services', 'phone'] },
    'commercial.policyHolder': { rule: 'name', labels: ['policy holder', 'subscriber', 'subscriber name', 'insured', 'member name', 'name'] },
    // VERIFY, never fill — an identity field read off a document that may be
    // about a different patient is compared, never written. TARGETS enforces it.
    dob: { rule: 'date', labels: ['date of birth', 'dob', 'birth date', 'birthdate'] }
  },
  referral: {
    'medicalTeam.pcpName': { rule: 'name', labels: ['primary care physician', 'primary care provider', 'pcp', 'referring physician', 'referring provider', 'referred by'] },
    'medicalTeam.pcpPractice': { rule: 'text', labels: ['practice', 'clinic', 'referring practice', 'group name', 'facility'] },
    'medicalTeam.pcpPhone': { rule: 'phone', labels: ['practice phone', 'office phone', 'referring phone', 'phone', 'tel', 'telephone'] },
    'medicalTeam.specialist1Name': { rule: 'name', labels: ['specialist', 'consulting physician', 'refer to', 'referred to'] },
    'medicalTeam.specialist1Phone': { rule: 'phone', labels: ['specialist phone', 'consultant phone'] },
    'medicalTeam.preferredHospital': { rule: 'text', labels: ['preferred hospital', 'hospital', 'admitting hospital'] },
    'medicalTeam.preferredPharmacy': { rule: 'text', labels: ['preferred pharmacy', 'pharmacy'] },
    'medicalTeam.pharmacyPhone': { rule: 'phone', labels: ['pharmacy phone'] },
    dob: { rule: 'date', labels: ['date of birth', 'dob', 'birth date', 'birthdate'] },
    phone: { rule: 'phone', labels: ['patient phone', 'home phone', 'patient contact'] }
  }
});

// A path this file invents can never reach a client record: it must already be
// declared for its kind in documentExtraction.TARGETS, which is the allow-list
// the review and the commit both run against. Checked AT LOAD so a typo fails
// the boot rather than silently proposing nothing.
const assertTemplatesAreDeclared = () => {
  const problems = [];
  for (const [kind, paths] of Object.entries(TEMPLATES)) {
    const target = extraction.TARGETS[kind];
    if (!target) { problems.push(`${kind} has templates but no declared targets`); continue; }
    const declared = new Set([...(target.fill || []), ...(target.verify || [])]);
    for (const [path, def] of Object.entries(paths)) {
      if (!declared.has(path)) problems.push(`${kind}.${path} is not a declared extraction target`);
      if (!RULES[def.rule]) problems.push(`${kind}.${path} names an unknown value rule "${def.rule}"`);
      if (!Array.isArray(def.labels) || !def.labels.length) problems.push(`${kind}.${path} declares no labels`);
    }
  }
  if (problems.length) throw new Error(`documentTemplates is out of step with documentExtraction:\n  ${problems.join('\n  ')}`);
};
assertTemplatesAreDeclared();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---- Finding a value beside its label -------------------------------------
// Three rules, in order, and the same ones the packet importer earned:
//   1. The rest of the line, after the label.
//   2. The next line down, if it starts at roughly the label's x.
//   3. Nothing. A label with no value beside it means the field is EMPTY, not
//      that the value is somewhere else on the page worth guessing at.
//
// A LABEL IS EVIDENCE THE FIELD EXISTS. IT IS NEVER EVIDENCE OF A VALUE.
const MAX_LINE_GAP = 26;   // points; a value further below belongs to another field

const valueBeside = ({ lines, index, labelText }) => {
  const line = lines[index];
  const stripped = String(line.text)
    .replace(new RegExp('^\\s*' + labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:\\-–]?\\s*', 'i'), '')
    .trim();
  if (stripped && norm(stripped) !== norm(line.text)) return { value: stripped, where: 'same_line' };

  const next = lines[index + 1];
  if (next && next.page === line.page) {
    const gap = next.y - line.y;
    if (gap > 0 && gap <= MAX_LINE_GAP && Math.abs(next.x - line.x) <= 24) {
      return { value: String(next.text).trim(), where: 'next_line' };
    }
  }
  return null;
};

// Confidence is REPORTED AND IS NEVER 1. A template match on a layout nobody
// has verified is strong evidence, not certainty, and the review screen shows
// the figure. Claiming certainty would invite a reviewer to stop reading.
const CONFIDENCE = Object.freeze({ same_line: 0.9, next_line: 0.72 });

const extractFromLines = ({ lines, kind }) => {
  const template = TEMPLATES[String(kind || '')];
  if (!template) return { error: `No template is declared for "${kind}"`, code: 'NO_TEMPLATE' };
  const rows = Array.isArray(lines) ? lines : [];

  // A label that appears more than once on a page is AMBIGUOUS and is skipped.
  // "Phone" beside three different practices cannot be resolved by position,
  // and picking the first is a guess that reads exactly like a fact.
  const seen = new Map();
  rows.forEach(l => {
    const n = norm(l.text);
    if (n) seen.set(n, (seen.get(n) || 0) + 1);
  });

  const extracted = {};
  const matches = [];
  const skipped = [];
  // ONE LINE FEEDS ONE PATH. Two paths declaring an overlapping label — "plan
  // name" on both the commercial plan and the Medicare Advantage plan — both
  // claimed the same line and the document then asserted a Medicare Advantage
  // plan that did not exist. Found by reading the output of a realistic card,
  // not by reading the code. Whichever path matches the more SPECIFIC label
  // wins, and the other is reported as skipped rather than silently filled.
  const claimed = new Map(); // line index → the path that took it

  for (const [path, def] of Object.entries(template)) {
    // Longest label first: "medicare number" must win over "number".
    const labels = def.labels.slice().sort((a, b) => b.length - a.length);
    let done = false;
    for (const label of labels) {
      if (done) break;
      for (let i = 0; i < rows.length; i++) {
        const text = String(rows[i].text || '');
        const n = norm(text);
        if (!n.startsWith(norm(label))) continue;
        // The label alone on its own line is fine; the label inside a sentence
        // is prose, so require the line to START with it.
        if (claimed.has(i)) {
          skipped.push({ path, label, reason: 'line_already_read_for', takenBy: claimed.get(i) });
          continue;
        }
        const beside = valueBeside({ lines: rows, index: i, labelText: label });
        if (!beside) continue;
        // AMBIGUITY CHECK on the label line, not the value: a form that prints
        // "Phone" three times cannot tell us which phone this is.
        const labelOnly = norm(text.slice(0, label.length));
        if (labelOnly === n && (seen.get(n) || 0) > 1) {
          skipped.push({ path, label, reason: 'label_appears_more_than_once' });
          continue;
        }
        const clean = RULES[def.rule](beside.value);
        if (clean === null) {
          // DROPPED, NOT PROPOSED. A blank gets asked about; a wrong member ID
          // gets billed. The skip is reported so a person can see the document
          // had something there that did not look right.
          skipped.push({ path, label, reason: 'value_failed_format', rule: def.rule });
          continue;
        }
        extracted[path] = clean;
        claimed.set(i, path);
        matches.push({ path, label, where: beside.where, confidence: CONFIDENCE[beside.where] });
        done = true;
        break;
      }
    }
  }
  return { extracted, matches, skipped, confidence: (path) => {
    const m = matches.find(x => x.path === path);
    return m ? m.confidence : null;
  } };
};

// ---- Reading the document itself ------------------------------------------
// The geometry comes from welcomePacketImport's extractor, which already
// descends into form XObjects (a flattened PDF draws its values in one) and
// into annotations (where a markup tool puts typed text). Those are the hard
// parts and they are already written and tested — a second copy is a second
// copy that drifts.
// WHERE THE TEXT CAME FROM, and it is reported on every read. `text` is the
// document's own text layer and is exact; `ocr` was recognised from a picture
// and can be wrong in ways a person should know about before approving a
// member ID. Collapsing the two would hide the difference at the moment it
// matters.
const SOURCE = Object.freeze({ TEXT: 'text', OCR: 'ocr', NONE: 'none' });

const readDocument = async ({ bytes, kind, mimeType, createWorker, allowOcr = true }) => {
  const nothing = (notice, extra) => ({
    source: SOURCE.NONE, extracted: {}, matches: [], skipped: [], notice, ...(extra || {})
  });

  // A photograph uploaded as a photograph has no PDF to open at all — go
  // straight to OCR rather than reporting it as an unreadable PDF.
  const directImage = ocr.isImageMime(mimeType);
  let lines = [];
  let source = SOURCE.TEXT;
  let ocrConfidence = null;
  let notice = null;
  let pagesRead = null;
  let pagesTotal = null;
  let stoppedBecause = null;

  if (!directImage) {
    let pdf;
    try {
      pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (e) {
      return nothing('That file could not be opened as a PDF or an image, so there is nothing to read.');
    }
    const runs = await packet.extractRuns(pdf);
    lines = packet.groupIntoLines(runs);
  }

  if (!lines.length) {
    // THE BRANCH THAT MATTERS MOST. A photographed page or a faxed one carries
    // no text at all, which is a completely different fact from "the document
    // had none of these fields" — reporting it as "nothing found" would send
    // somebody hunting for a label that was never readable. An empty result is
    // not a diagnosis.
    //
    // OCR runs IN THIS CONTAINER. No image is uploaded anywhere, so there is no
    // boundary crossing and no BAA question to answer.
    if (!allowOcr) return nothing('This document has no text layer, and reading pictures is switched off.');
    let read;
    try {
      read = await ocr.ocrDocumentRuns({ bytes, mimeType, createWorker });
    } catch (e) {
      return nothing(`This document has no text layer and could not be read as a picture: ${e.message}`);
    }
    if (!read.runs.length) {
      return nothing(read.notice || 'This document has no text and nothing could be recognised in it.',
        { undecodable: read.undecodable || [] });
    }
    // The OCR-aware grouper: same clustering, then re-sorted by x so the
    // words come out in reading order. See documentOcr.groupWordLines.
    lines = ocr.groupWordLines(read.runs);
    source = SOURCE.OCR;
    ocrConfidence = read.confidence;
    notice = read.notice;
    pagesRead = read.pages;
    pagesTotal = read.pagesTotal || read.pages;
    stoppedBecause = read.stoppedBecause || null;
    if (!lines.length) return nothing('Nothing legible could be recognised in that picture.');
  }

  const out = extractFromLines({ lines, kind });
  if (out.error) return nothing(out.error);
  return {
    ...out, source, lineCount: lines.length, ocrConfidence,
    pagesRead, pagesTotal, stoppedBecause,
    // An OCR'd read is evidence, not transcription. The confidence a reviewer
    // sees is scaled down for it so a recognised member ID is never presented
    // as firmly as one read out of a real text layer.
    confidence: source === SOURCE.OCR
      ? (path) => { const c = out.confidence(path); return c == null ? null : Math.round(c * 0.75 * 100) / 100; }
      : out.confidence,
    notice
  };
};

module.exports = {
  TEMPLATES, RULES, CONFIDENCE, SOURCE, MAX_LINE_GAP,
  extractFromLines, readDocument, assertTemplatesAreDeclared, valueBeside
};
