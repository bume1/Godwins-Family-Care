// ============================================================================
// Reading a document that has no text in it (2026-09-23, owner-directed)
// ============================================================================
// "Some photos, some fax." A faxed or photographed page carries no text layer
// at all, so the deterministic reader in documentTemplates.js has nothing to
// match against — and that is most of what arrives at a home-care office.
//
// OCR RUNS INSIDE THIS CONTAINER AND NOTHING LEAVES THE BOUNDARY. tesseract.js
// is a WASM build of Tesseract executing in this process, on this host. No
// image is uploaded anywhere, no API is called, and there is therefore no BAA
// question to answer — which is the whole reason it is this and not a cloud
// OCR service. §10.3's boundary rule is satisfied by there being no boundary
// crossing at all.
//
// THE OUTPUT IS DELIBERATELY THE SAME SHAPE THE PDF EXTRACTOR PRODUCES.
// Tesseract reports a bounding box per word, so the words are mapped into the
// {text, x, y, page, size} runs that welcomePacketImport.groupIntoLines already
// groups — and then the SAME label matcher runs over them. One matcher, one set
// of rules, one place where "a label is evidence the field exists, never
// evidence of a value" is enforced. A second matcher for OCR'd text is a second
// matcher that drifts.
//
// ACCURACY IS REPORTED, NEVER ASSUMED. Tesseract returns a confidence per word;
// a page that reads badly says so, and the format rules in documentTemplates
// drop anything that does not look like what it claims to be. An OCR'd "1" that
// should be an "l" fails the MBI shape check and is not proposed — which is the
// point of checking shapes rather than trusting the read.

const path = require('path');
const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
const { groupIntoLines: packetLines } = require('./welcomePacketImport');

// THE LANGUAGE DATA SHIPS WITH THE APP AND IS NEVER FETCHED AT RUNTIME.
// tesseract.js downloads `eng.traineddata` from a CDN on first use unless it is
// told where to find it. That is a 5MB outbound request from inside the BAA
// boundary, on the first document anybody reads, against a network policy that
// may well refuse it — and a feature that works in testing and fails on the
// first real fax is worse than one that never worked. The file is committed to
// vendor/tesseract and pointed at explicitly, so OCR runs offline.
const LANG_PATH = path.join(__dirname, 'vendor', 'tesseract');

// WHICH LANGUAGE SET, AND WHY THE SMALL ONE — measured, not assumed.
// Tesseract ships three: `tessdata_fast` (5MB, what is committed here),
// `tessdata` (23MB) and `tessdata_best` (15MB). Benchmarked on a clean
// screenshot and on a phone photograph, `fast` and the 23MB standard set
// produced IDENTICAL text on the photograph and differed by one word on the
// screenshot, at the same confidence and the same speed. `tessdata_best`
// cannot be used at all with the WASM core tesseract.js ships — it needs a
// SIMD build and aborts on `DotProductSSE`.
//
// The argument that settles it: the format rules in documentTemplates REJECT a
// value that does not look like what it claims to be, so a worse read costs
// COMPLETENESS, not CORRECTNESS. A misread MBI never becomes a claim; it
// becomes a blank somebody fills in. Starting small is therefore safe.
//
// TO SWAP: replace vendor/tesseract/eng.traineddata with the file from
// github.com/tesseract-ocr/tessdata and change nothing else. The first real
// fax that reads badly is the test that should decide it — not a screenshot.

// Below this, a word is more likely to be noise than text. It is not a hard
// gate on the page — a single bad word should not discard a good document — but
// such words are dropped from the runs so they cannot become a value.
const MIN_WORD_CONFIDENCE = 40;

// Tesseract is slow on a large page and this runs inside a request. A ceiling
// stops one enormous scan holding a worker open indefinitely.
const OCR_TIMEOUT_MS = 45000;

const IMAGE_MIME = /^image\/(png|jpe?g|tiff?|bmp|webp)$/i;
const isImageMime = (m) => IMAGE_MIME.test(String(m || '').trim());

// The words, and only the words. Tesseract's block tree nests
// blocks → paragraphs → lines → words → symbols, and walking to the bottom
// collects every letter as its own "word" — which produced 471 entries for a
// page with about 90 on it the first time this was written.
const wordsFrom = (blocks) => {
  const out = [];
  const walk = (node, depth) => {
    if (!node) return;
    if (Array.isArray(node.words) && node.words.length) {
      node.words.forEach(w => {
        if (w && w.text && w.bbox) out.push(w);
      });
      return; // STOP at words. Descending into symbols is the bug above.
    }
    ['paragraphs', 'lines'].forEach(k => (node[k] || []).forEach(n => walk(n, depth + 1)));
  };
  (blocks || []).forEach(b => walk(b, 0));
  return out;
};

// Map OCR words into the run shape the PDF extractor produces. Both are
// TOP-DOWN in y (tesseract's y0 is from the top of the image; the PDF extractor
// already flips PDF's bottom-up space), so `groupIntoLines` and the "next line
// down" rule work on either without a second convention to remember.
const runsFromWords = (words, page) => words
  .filter(w => (w.confidence == null ? true : w.confidence >= MIN_WORD_CONFIDENCE))
  .map(w => ({
    text: String(w.text).trim(),
    x: w.bbox.x0,
    // THE VERTICAL CENTRE, NOT THE TOP. A word's bounding box starts where its
    // tallest letter starts, so "Model" and "page" on the same printed line
    // report different tops — by the height of a capital against a descender.
    // Grouping on the top scattered same-line words into different lines.
    y: (w.bbox.y0 + w.bbox.y1) / 2,
    size: Math.max(4, (w.bbox.y1 - w.bbox.y0) || 9),
    page: page || 0
  }))
  .filter(r => r.text.length > 0);

// LINES OF OCR'd WORDS, IN READING ORDER.
//
// The shared grouper sorts runs by y and then x, which is exactly right for a
// PDF: every word on a printed line shares one baseline, so the y comparison
// ties and x decides. OCR has no baseline — each word carries its own measured
// box — so the y values differ slightly across a line, y never ties, and x
// never gets consulted. The words land in the right LINE and the wrong ORDER.
//
// Found by running a real screenshot through it: "Model access page has been
// retired" came back as "Model has been retired access page". Every word was
// read correctly and the sentence was still useless — and a label matcher that
// needs "Member ID:" to precede its value would have missed every field.
//
// So the grouper's clustering is reused, and each line is then re-sorted by x
// and its text rebuilt. The shared function is left alone: the PDF path does
// not have this problem and does not need the extra pass.
const groupWordLines = (runs) => packetLines(runs).map(line => {
  const ordered = line.runs.slice().sort((a, b) => a.x - b.x);
  return { ...line, runs: ordered, text: ordered.map(r => r.text).join(' ').replace(/\s+/g, ' ').trim() };
});

// The worker is created per call and terminated in a finally. A long-lived
// worker would be faster, and it would also hold a page of somebody's chart in
// WASM memory between requests for no good reason.
const ocrImageRuns = async ({ bytes, page = 0, createWorker }) => {
  const make = createWorker || require('tesseract.js').createWorker;
  let worker = null;
  try {
    worker = await make('eng', undefined, { langPath: LANG_PATH, cachePath: LANG_PATH, gzip: false });
    // THE TIMER IS CLEARED WHEN THE RACE SETTLES. Without that a read that
    // finishes in two seconds still leaves a 45-second timer on the event
    // loop — which held the test process open for 45 seconds after every call,
    // and in production would keep a request's timer alive long after the
    // request was answered. Found because the tests were inexplicably slow.
    let timer = null;
    const recognised = await Promise.race([
      worker.recognize(bytes, {}, { blocks: true, text: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR timed out')), OCR_TIMEOUT_MS); })
    ]).finally(() => { if (timer) clearTimeout(timer); });
    const data = (recognised && recognised.data) || {};
    const words = wordsFrom(data.blocks);
    return {
      runs: runsFromWords(words, page),
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      wordCount: words.length
    };
  } finally {
    if (worker) { try { await worker.terminate(); } catch (e) { /* the read already happened */ } }
  }
};

// ---- Pulling the picture out of a PDF -------------------------------------
// A faxed page is an image wrapped in a PDF. JPEG (DCTDecode) streams are
// already a complete JPEG file and can be handed to Tesseract as they are.
//
// CCITT G4 and JBIG2 — the classic fax encodings — are NOT decodable here, and
// this says so by name rather than returning an empty list. "We found no
// images" and "we found an image we cannot decode" send somebody to completely
// different places.
const SUPPORTED_IMAGE_FILTERS = ['/DCTDecode', '/JPXDecode'];

const embeddedImages = async (pdf) => {
  const found = [];
  const undecodable = new Set();
  const context = pdf.context;
  const entries = context.enumerateIndirectObjects ? context.enumerateIndirectObjects() : [];
  for (const [, obj] of entries) {
    if (!(obj instanceof PDFRawStream)) continue;
    let dict;
    try { dict = obj.dict; } catch (e) { continue; }
    const subtype = dict.get(PDFName.of('Subtype'));
    if (!subtype || String(subtype) !== '/Image') continue;
    const filter = dict.get(PDFName.of('Filter'));
    const names = filter == null ? [] : String(filter).split(/[\s[\]]+/).filter(Boolean);
    const supported = names.find(n => SUPPORTED_IMAGE_FILTERS.includes(n));
    if (!supported) {
      names.forEach(n => undecodable.add(n));
      continue;
    }
    found.push({ bytes: Buffer.from(obj.getContents()), filter: supported });
  }
  return { images: found, undecodable: [...undecodable] };
};

// HOW FAR TO READ INTO A DOCUMENT: ALL OF IT (owner, 2026-09-23).
//
// The original cap was four pages, on the reasoning that the fields being
// looked for sit on a face sheet. That is true of a face sheet and false of
// everything else: a discharge summary, a hospital packet or a multi-page
// referral puts the insurance block wherever it puts it, and a reader that
// stops early reports "none of these fields" about a document that plainly has
// them — the exact wrong diagnosis this module exists to avoid.
//
// A time budget was tried and REMOVED at the owner's instruction: a partial
// read is the failure mode being fixed, and trading it for a different partial
// read solves nothing. Every page is read.
//
// THE CONSEQUENCE, STATED PLAINLY: a long document holds the request open for
// roughly a second a page (measured: half a second for a clean page, ~1.6s for
// a dense one). A forty-page packet is therefore a request of about a minute.
// `OCR_MAX_PAGES` exists as an operator escape hatch if that ever needs
// bounding in production; it is UNSET by default, which means no limit.
const MAX_OCR_PAGES = Number(process.env.OCR_MAX_PAGES) > 0
  ? Number(process.env.OCR_MAX_PAGES)
  : Infinity;

// WHAT HAPPENED TO THE PAGES, as a pure function.
//
// It is lifted out so it can be DRIVEN. The first version of this lived inline
// and was guarded by scanning the source for its own strings — which meant
// `if (false)` in front of either branch still matched, and two mutations
// walked straight through. A source scan cannot see behaviour.
//
//   total     — pages found in the document
//   attempted — pages we were willing to read (an operator ceiling may cut it)
//   read      — pages that actually produced text
//
// Three outcomes, and they are three different sentences. A page skipped by
// policy and a page that failed to decode send somebody at different problems,
// and "we read all of it" must not be reported as either.
const describeRead = ({ total, attempted, read }) => {
  if (total > attempted) {
    return {
      stoppedBecause: 'page_limit',
      notice: `This document has ${total} pages and the first ${attempted} were read, because a page limit is configured. Anything after page ${attempted} was not looked at.`
    };
  }
  if (read < attempted) {
    return {
      stoppedBecause: 'unreadable_pages',
      notice: `${read} of this document's ${total} pages could be read; ${total - read} could not.`
    };
  }
  return { stoppedBecause: null, notice: null };
};

const ocrDocumentRuns = async ({ bytes, mimeType, createWorker }) => {
  if (isImageMime(mimeType)) {
    const one = await ocrImageRuns({ bytes, page: 0, createWorker });
    return { runs: one.runs, pages: 1, confidence: one.confidence, undecodable: [], notice: null };
  }
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    return { runs: [], pages: 0, confidence: null, undecodable: [], notice: 'That file is neither an image nor a readable PDF.' };
  }
  const { images, undecodable } = await embeddedImages(pdf);
  if (!images.length) {
    return {
      runs: [], pages: 0, confidence: null, undecodable,
      notice: undecodable.length
        ? `This document's pages are stored as ${undecodable.join(', ')}, a fax encoding this app cannot decode yet. It is filed and readable by a person.`
        : 'This document carries no text and no image that could be read.'
    };
  }
  const runs = [];
  let best = null;
  const slice = Number.isFinite(MAX_OCR_PAGES) ? images.slice(0, MAX_OCR_PAGES) : images;
  let read = 0;
  let stoppedBecause = null;
  for (let i = 0; i < slice.length; i++) {
    try {
      const page = await ocrImageRuns({ bytes: slice[i].bytes, page: i, createWorker });
      runs.push(...page.runs);
      read += 1;
      if (page.confidence != null) best = best == null ? page.confidence : Math.max(best, page.confidence);
    } catch (e) {
      // One unreadable page does not discard the pages that did read.
      continue;
    }
  }
  const { stoppedBecause: why, notice } = describeRead({
    total: images.length, attempted: slice.length, read
  });
  stoppedBecause = why;
  return {
    runs, pages: read, pagesTotal: images.length, stoppedBecause,
    confidence: best, undecodable, notice
  };
};

module.exports = {
  LANG_PATH,
  describeRead,
  groupWordLines,
  MIN_WORD_CONFIDENCE, OCR_TIMEOUT_MS, MAX_OCR_PAGES, SUPPORTED_IMAGE_FILTERS,
  isImageMime, wordsFrom, runsFromWords, ocrImageRuns, embeddedImages, ocrDocumentRuns
};
