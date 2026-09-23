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

// THE LANGUAGE DATA SHIPS WITH THE APP AND IS NEVER FETCHED AT RUNTIME.
// tesseract.js downloads `eng.traineddata` from a CDN on first use unless it is
// told where to find it. That is a 5MB outbound request from inside the BAA
// boundary, on the first document anybody reads, against a network policy that
// may well refuse it — and a feature that works in testing and fails on the
// first real fax is worse than one that never worked. The file is committed to
// vendor/tesseract and pointed at explicitly, so OCR runs offline.
const LANG_PATH = path.join(__dirname, 'vendor', 'tesseract');

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
    y: w.bbox.y0,
    size: Math.max(4, (w.bbox.y1 - w.bbox.y0) || 9),
    page: page || 0
  }))
  .filter(r => r.text.length > 0);

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

// How many pages of a document to OCR. A fifty-page fax would hold a request
// open for a minute; the fields being looked for are on the face sheet.
const MAX_OCR_PAGES = 4;

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
  const slice = images.slice(0, MAX_OCR_PAGES);
  for (let i = 0; i < slice.length; i++) {
    try {
      const page = await ocrImageRuns({ bytes: slice[i].bytes, page: i, createWorker });
      runs.push(...page.runs);
      if (page.confidence != null) best = best == null ? page.confidence : Math.max(best, page.confidence);
    } catch (e) {
      // One unreadable page does not discard the pages that did read.
      continue;
    }
  }
  return {
    runs, pages: slice.length, confidence: best, undecodable,
    notice: images.length > MAX_OCR_PAGES
      ? `Only the first ${MAX_OCR_PAGES} pages were read.`
      : null
  };
};

module.exports = {
  LANG_PATH,
  MIN_WORD_CONFIDENCE, OCR_TIMEOUT_MS, MAX_OCR_PAGES, SUPPORTED_IMAGE_FILTERS,
  isImageMime, wordsFrom, runsFromWords, ocrImageRuns, embeddedImages, ocrDocumentRuns
};
