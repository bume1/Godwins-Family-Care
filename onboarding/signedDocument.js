// ============================================================================
// A DOCUMENT THE OFFICE SENT, SIGNED OR ACKNOWLEDGED IN ONBOARDING
// (owner, 2026-11-09)
// ============================================================================
// The office attaches its own PDF (a contract, a policy) to an onboarding task.
// The employee reads it in the app and acknowledges it or signs it. The copy
// that files to their Documents is the ORIGINAL PDF, untouched, with one page
// appended that records what they did: who, when, how, and the SHA-256 of the
// exact document they were shown, so the copy can be tied to it later.
// The employee signs alone; anything GFC signs is already on the PDF.
// ============================================================================

'use strict';

const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const ACTIONS = Object.freeze(['acknowledge', 'sign']);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Plain text the standard font can draw: anything outside Latin-1 becomes '?'
// rather than throwing halfway through a signature page.
const safe = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

function wrap(text, font, size, width) {
  const words = safe(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * originalPdf: Buffer. Returns { bytes: Buffer, originalSha256 }.
 * record: { action, title, printedName, email, signedAt (ISO), signedAtLabel, ipHash, signaturePng (data URL, sign only) }
 */
async function buildSignedCopy(originalPdf, record) {
  if (!ACTIONS.includes(record.action)) throw new Error('Unknown document action.');
  const originalSha256 = sha256(originalPdf);
  const doc = await PDFDocument.load(originalPdf, { ignoreEncryption: true });
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(3 / 255, 61 / 255, 80 / 255);
  let y = 730;
  const line = (text, opts = {}) => {
    const f = opts.bold ? bold : font; const size = opts.size || 11;
    for (const l of wrap(text, f, size, 512)) { page.drawText(l, { x: 50, y, size, font: f, color: opts.color || rgb(0.1, 0.16, 0.2) }); y -= size + 6; }
    y -= opts.gap || 4;
  };
  line('Godwins Family Care', { bold: true, size: 13, color: navy });
  line(record.action === 'sign' ? 'Electronic Signature Record' : 'Acknowledgment Record', { bold: true, size: 18, color: navy, gap: 10 });
  line(`Document: ${record.title}`, { bold: true });
  line(record.action === 'sign'
    ? `${record.printedName} signed this document electronically in the Godwins Family Care app.`
    : `${record.printedName} confirmed in the Godwins Family Care app that they have read and understood this document.`, { gap: 12 });
  if (record.action === 'sign' && record.signaturePng) {
    const png = Buffer.from(String(record.signaturePng).replace(/^data:image\/png;base64,/, ''), 'base64');
    const img = await doc.embedPng(png);
    const w = Math.min(260, img.width); const h = img.height * (w / img.width);
    page.drawImage(img, { x: 50, y: y - h, width: w, height: h });
    y -= h + 6;
    page.drawLine({ start: { x: 50, y }, end: { x: 330, y }, thickness: 0.8, color: rgb(0.5, 0.5, 0.5) });
    y -= 16;
    line('Signature', { size: 9, color: rgb(0.4, 0.4, 0.4), gap: 10 });
  }
  line(`Printed name: ${record.printedName}`);
  line(`Account: ${record.email || 'not recorded'}`);
  line(`Date and time: ${record.signedAtLabel || record.signedAt}`);
  line(`Network (hashed): ${record.ipHash || 'not recorded'}`, { gap: 10 });
  line(`Original document SHA-256: ${originalSha256}`, { size: 9 });
  line('The pages before this one are the document exactly as it was shown. This page was added when it was ' + (record.action === 'sign' ? 'signed.' : 'acknowledged.'), { size: 9, color: rgb(0.4, 0.4, 0.4) });
  return { bytes: Buffer.from(await doc.save()), originalSha256 };
}

module.exports = { ACTIONS, sha256, buildSignedCopy };
