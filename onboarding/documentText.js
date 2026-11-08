// ============================================================================
// SOURCE DOCUMENT TEXT — a .docx or the Playbook's HTML, read into lines
// ============================================================================
// The source documents are read FROM DRIVE at runtime (store the reference,
// never the content). This turns the bytes Drive returns into plain lines in
// one shape, whatever the format:
//   * a paragraph is a line;
//   * italic text is wrapped in *asterisks*, which is how the SOP and Library
//     documents mark a check question;
//   * a table row is "| cell | cell |", which is how every document's control
//     table and classification table is read.
//
// Dependency-free on purpose (zlib does the inflating), the same reason the
// repo's zipWriter.js is. A .docx is a zip; only word/document.xml is read.
// ============================================================================

'use strict';

const zlib = require('zlib');

// ---- zip ---------------------------------------------------------------------
function readZipEntry(buf, wanted) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // End of central directory: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('Not a zip archive'), { code: 'DOC_NOT_ZIP' });
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const lNameLen = b.readUInt16LE(local + 26);
      const lExtraLen = b.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = b.slice(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw Object.assign(new Error(`Unsupported zip method ${method}`), { code: 'DOC_ZIP_METHOD' });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

// ---- docx --------------------------------------------------------------------
function paragraphText(pXml) {
  let out = '';
  const runs = pXml.match(/<w:r\b[\s\S]*?<\/w:r>/g) || [];
  for (const r of runs) {
    const rPr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    const italic = /<w:i\/>|<w:i w:val="(?:1|true|on)"\/>/.test(rPr);
    let t = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let m;
    while ((m = re.exec(r))) t += m[1] !== undefined ? decodeEntities(m[1]) : ' ';
    if (!t) continue;
    out += italic && t.trim() ? `*${t}*` : t;
  }
  // Adjacent italic runs ("*a**b*") read as one italic span.
  return out.replace(/\*\*/g, '').trim();
}

function docxToLines(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw Object.assign(new Error('No word/document.xml in the file'), { code: 'DOC_NOT_DOCX' });
  const body = xml.toString('utf8');
  const lines = [];
  // Walk top-level tables and paragraphs in order.
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body))) {
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl>')) {
      const rows = chunk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
      for (const row of rows) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(c =>
          (c.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).map(paragraphText).filter(Boolean).join(' '));
        lines.push(`| ${cells.join(' | ')} |`);
      }
    } else {
      const t = paragraphText(chunk);
      if (t) lines.push(t);
    }
  }
  return lines;
}

// ---- html (the Playbook) ---------------------------------------------------
function htmlToLines(buf) {
  const html = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return `\n| ${cells.join(' | ')} |\n`;
  });
  s = s.replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/section)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s).split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

function toLines(buf, mimeType) {
  if (/html/.test(String(mimeType || ''))) return htmlToLines(buf);
  return docxToLines(buf);
}

module.exports = { readZipEntry, docxToLines, htmlToLines, toLines };
