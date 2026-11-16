// ============================================================================
// A POLICY, DRAWN AS A PDF TO SIGN OR ACKNOWLEDGE (owner, 2026-11-15)
// ============================================================================
// The policies staff sign (Code of Conduct, Handbook, HIPAA, the manuals) live
// in Drive as Word files, in Policies / Current. The signing screen and the
// signed copy need a PDF, so the policy's text is drawn into one here: every
// paragraph and table row, in order, headings in bold. A part that is already
// a PDF is copied in page for page. The signature page signedDocument.js adds
// then carries the SHA-256 of the exact source files, so the copy can always
// be tied back to the version that was signed.
//
// Dependency-free beyond pdf-lib, which the signing already uses: the Word
// file is read with documentText.js, the same reader the onboarding sources use.
// ============================================================================

'use strict';

const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { readZipEntry, paragraphText } = require('./documentText');

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';
// The standard font draws Latin-1 only; anything else becomes '?' rather than
// throwing halfway through a policy. Curly quotes and dashes are kept readable.
const safe = (s) => String(s == null ? '' : s)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/•/g, '-').replace(/…/g, '...')
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

// The policy's blocks, in order: { text, heading }.
function docxBlocks(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw Object.assign(new Error('No word/document.xml in the file'), { code: 'DOC_NOT_DOCX' });
  const body = xml.toString('utf8');
  const out = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body))) {
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl>')) {
      for (const row of chunk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(c =>
          (c.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).map(paragraphText).filter(Boolean).join(' '));
        const t = cells.filter(Boolean).join('  |  ');
        if (t) out.push({ text: t.replace(/\*/g, ''), heading: false, row: true });
      }
    } else {
      const t = paragraphText(chunk).replace(/\*/g, '');
      if (!t) continue;
      const style = (chunk.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
      const bulleted = /<w:numPr>/.test(chunk);
      out.push({ text: bulleted ? `-  ${t}` : t, heading: /heading|title/i.test(style) });
    }
  }
  return out;
}

function wrap(text, font, size, width) {
  const words = safe(text).split(/\s+/).filter(Boolean); const lines = []; let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * parts: [{ name, buf }] (a .docx or a PDF each, in order).
 * Returns { bytes: Buffer, sourceSha256 } — the hash of the source files
 * themselves, so a policy updated in Drive reads as a different version.
 */
async function buildPolicyPdf({ title, version, parts }) {
  if (!Array.isArray(parts) || !parts.length) throw Object.assign(new Error('No file for this policy'), { code: 'POLICY_NO_FILE' });
  const hash = crypto.createHash('sha256');
  parts.forEach(p => hash.update(p.buf));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(3 / 255, 61 / 255, 80 / 255);
  const ink = rgb(0.1, 0.12, 0.16);
  const W = 612; const H = 792; const M = 60; const width = W - 2 * M;
  let page = null; let y = 0;
  const newPage = () => {
    page = doc.addPage([W, H]); y = H - M;
    page.drawText(safe(`Godwins Family Care  ·  ${title}${version && version !== 'Current' ? `  ·  Version ${version}` : ''}`),
      { x: M, y: H - 36, size: 8.5, font, color: rgb(0.45, 0.45, 0.45) });
  };
  const draw = (text, { f = font, size = 10.5, color = ink, gapAfter = 5 } = {}) => {
    for (const l of wrap(text, f, size, width)) {
      if (!page || y - size < M) newPage();
      page.drawText(l, { x: M, y: y - size, size, font: f, color });
      y -= size + 4;
    }
    y -= gapAfter;
  };
  for (const part of parts) {
    if (isPdf(part.buf)) {
      const src = await PDFDocument.load(part.buf, { ignoreEncryption: true });
      (await doc.copyPages(src, src.getPageIndices())).forEach(p => doc.addPage(p));
      page = null;
      continue;
    }
    if (!page || parts.length > 1) newPage();
    const blocks = docxBlocks(part.buf);
    if (!blocks.length) draw('(This file has no text.)', { color: rgb(0.5, 0.5, 0.5) });
    blocks.forEach((b, i) => {
      if (b.heading || (i === 0 && !b.row)) draw(b.text, { f: bold, size: i === 0 ? 15 : 12, color: navy, gapAfter: 8 });
      else draw(b.text, { size: b.row ? 9.5 : 10.5 });
    });
  }
  return { bytes: Buffer.from(await doc.save()), sourceSha256: hash.digest('hex') };
}

module.exports = { buildPolicyPdf, docxBlocks, isPdf };
