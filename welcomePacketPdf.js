// ============================================================================
// THE WELCOME PACKET AS A PDF — the fillable one we hand out, and the signed
// copy we keep.
// ============================================================================
// The fillable packet is generated from the SAME section definitions the wizard
// renders, and every form field carries a name derived from the field id. That
// is the whole reason a returned packet can be read back exactly: we control
// both ends, so importing one is reading named values, not guessing at a
// picture. `fieldName()` and friends below are the single copy of that naming —
// the importer requires them rather than restating the convention, because two
// copies of a naming rule is how a packet stops importing after a rename.
//
// A flattened or hand-annotated PDF carries no named fields; that case is the
// importer's problem, not this file's.
// ============================================================================

'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const wp = require('./welcomePacketRepository');

const NAVY = rgb(0.012, 0.239, 0.314);
const GOLD = rgb(0.784, 0.663, 0.318);
const INK = rgb(0.10, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.48);
const RULE = rgb(0.80, 0.82, 0.84);

const PAGE_W = 612, PAGE_H = 792, MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ---------------------------------------------------------------------------
// FIELD NAMING — one copy, shared with the importer.
// ---------------------------------------------------------------------------
const PREFIX = 'gfc';
const fieldName = (id) => `${PREFIX}.${id}`;
const optionName = (id, value) => `${PREFIX}.${id}.${value}`;
const gridName = (id, row, col) => `${PREFIX}.${id}.${row}.${col}`;
const rowFieldName = (id, index, sub) => `${PREFIX}.${id}.${index}.${sub}`;

/**
 * pdf-lib writes with WinAnsi, which refuses anything outside latin-1 and
 * throws when it meets one. A caregiver's name, a city, a sentence pasted out
 * of a phone keyboard can all carry a character outside it, and a throw here
 * would be a 500 on a document somebody is waiting for — the same shape as the
 * narrow no-break space that 500'd every download. So the text is folded to
 * something writable rather than allowed to take the page down.
 */
const ASCII_FOLD = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', ' ': ' ', ' ': ' ',
  '•': '-', '·': '-'
};
function pdfSafe(value) {
  let s = String(value == null ? '' : value);
  s = s.replace(/[‘’“”–—…  •·]/g, c => ASCII_FOLD[c]);
  // Anything still outside latin-1 is dropped rather than guessed at.
  return s.replace(/[^\x09\x0A\x20-\xFF]/g, '');
}

// The attestation bodies mark emphasis the way the consent bodies do, with
// **double asterisks**. pdf-lib draws one font per run, so the markers are
// removed rather than rendered as literal asterisks in the signed copy.
const stripEmphasis = (text) => String(text == null ? '' : text).replace(/\*\*/g, '');

function wrap(text, font, size, width) {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** A tiny layout cursor. Pages are added as the content runs past the bottom. */
function createWriter(pdf, fonts) {
  const state = { page: null, y: 0, pageIndex: -1 };

  const newPage = () => {
    state.page = pdf.addPage([PAGE_W, PAGE_H]);
    state.pageIndex += 1;
    state.y = PAGE_H - MARGIN;
    return state.page;
  };

  const space = (h) => {
    if (!state.page || state.y - h < MARGIN + 28) newPage();
  };

  const text = (str, { size = 10, font = fonts.regular, color = INK, indent = 0, gap = 3, width } = {}) => {
    const w = width || (CONTENT_W - indent);
    const lines = wrap(str, font, size, w);
    for (const line of lines) {
      space(size + gap);
      state.page.drawText(line, { x: MARGIN + indent, y: state.y - size, size, font, color });
      state.y -= size + gap;
    }
  };

  return { state, newPage, space, text };
}

function drawHeader(page, fonts, title, subtitle) {
  page.drawRectangle({ x: 0, y: PAGE_H - 92, width: PAGE_W, height: 92, color: NAVY });
  page.drawText('Godwins Family Care', {
    x: MARGIN, y: PAGE_H - 46, size: 17, font: fonts.bold, color: rgb(1, 1, 1)
  });
  page.drawText(pdfSafe(subtitle || 'PHYSICIAN AND FNP OWNED'), {
    x: MARGIN, y: PAGE_H - 64, size: 7.5, font: fonts.regular, color: GOLD
  });
  page.drawText(pdfSafe(title), {
    x: MARGIN, y: PAGE_H - 82, size: 11, font: fonts.bold, color: rgb(1, 1, 1)
  });
  page.drawRectangle({ x: 0, y: PAGE_H - 95, width: PAGE_W, height: 3, color: GOLD });
}

function drawFooter(page, fonts, pageNumber) {
  page.drawLine({
    start: { x: MARGIN, y: MARGIN - 14 }, end: { x: PAGE_W - MARGIN, y: MARGIN - 14 },
    thickness: 0.5, color: RULE
  });
  page.drawText(pdfSafe('Care That Sees You.  Godwins Family Care LLC - 404-913-6705 - admin@godwinsfamilycarellc.com'), {
    x: MARGIN, y: MARGIN - 26, size: 7, font: fonts.regular, color: MUTED
  });
  page.drawText(String(pageNumber), {
    x: PAGE_W - MARGIN - 10, y: MARGIN - 26, size: 7, font: fonts.regular, color: MUTED
  });
}

const sectionHeading = (w, fonts, number, title) => {
  w.space(34);
  w.state.y -= 8;
  w.state.page.drawRectangle({ x: MARGIN, y: w.state.y - 16, width: CONTENT_W, height: 20, color: rgb(0.96, 0.95, 0.91) });
  w.state.page.drawText(pdfSafe(`${number}  ${title}`), {
    x: MARGIN + 8, y: w.state.y - 11, size: 11, font: fonts.bold, color: NAVY
  });
  w.state.y -= 24;
};

/**
 * The fillable caregiver packet.
 *
 * @param prefill  values to seed the form with (what we already know), keyed by
 *                 field id — so a caregiver we already have a phone number for
 *                 is not asked for it again.
 */
async function generateFillableWelcomePacketPDF(prefill = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Godwins Family Care - Caregiver Welcome Packet');
  pdf.setSubject(`Welcome packet ${wp.PACKET_VERSION}`);
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold)
  };
  const form = pdf.getForm();
  const w = createWriter(pdf, fonts);

  w.newPage();
  drawHeader(w.state.page, fonts, 'WELCOME - Your Next Steps');
  w.state.y = PAGE_H - 112;

  w.text('We are glad you are here. This packet has two parts. Part One is your caregiver profile, which is how we match you with the right clients close to where you live. Part Two is the list of documents we need from you before your first shift. Take your time with both. If anything on here is a problem, call us. Most of it we can help you sort out.', { size: 9.5, gap: 4 });
  w.state.y -= 6;
  w.text('PART ONE - Caregiver Profile', { size: 12, font: fonts.bold, color: NAVY, gap: 5 });
  w.text('The more we know about your experience, your schedule, and how you like to work, the better we can place you with clients you will actually enjoy.', { size: 9, color: MUTED, gap: 4 });

  const addText = (field, opts = {}) => {
    const lines = opts.multiline ? 4 : 1;
    const h = opts.multiline ? 46 : 18;
    w.space(h + 16);
    w.state.page.drawText(pdfSafe(field.label.toUpperCase()), {
      x: MARGIN, y: w.state.y - 8, size: 7, font: fonts.bold, color: MUTED
    });
    w.state.y -= 12;
    const tf = form.createTextField(fieldName(field.id));
    if (opts.multiline) tf.enableMultiline();
    const seed = prefill[field.id];
    if (seed) tf.setText(pdfSafe(seed));
    tf.addToPage(w.state.page, {
      x: MARGIN, y: w.state.y - h, width: opts.width || CONTENT_W, height: h,
      borderColor: RULE, borderWidth: 0.75, backgroundColor: rgb(0.99, 0.99, 0.98)
    });
    w.state.y -= h + 10;
    void lines;
  };

  const addSingle = (field) => {
    w.space(40);
    w.state.page.drawText(pdfSafe(field.label.toUpperCase()), {
      x: MARGIN, y: w.state.y - 8, size: 7, font: fonts.bold, color: MUTED
    });
    w.state.y -= 16;
    const group = form.createRadioGroup(fieldName(field.id));
    let x = MARGIN;
    for (const option of field.options) {
      const labelWidth = fonts.regular.widthOfTextAtSize(pdfSafe(option.label), 8.5);
      const cell = 14 + labelWidth + 16;
      if (x + cell > MARGIN + CONTENT_W) { w.state.y -= 18; w.space(24); x = MARGIN; }
      group.addOptionToPage(option.value, w.state.page, {
        x, y: w.state.y - 11, width: 10, height: 10, borderColor: RULE, borderWidth: 0.75
      });
      w.state.page.drawText(pdfSafe(option.label), {
        x: x + 14, y: w.state.y - 9, size: 8.5, font: fonts.regular, color: INK
      });
      x += cell;
    }
    if (prefill[field.id] && field.options.some(o => o.value === prefill[field.id])) {
      group.select(prefill[field.id]);
    }
    w.state.y -= 24;
  };

  const addMulti = (field) => {
    w.space(40);
    w.state.page.drawText(pdfSafe(field.label.toUpperCase()), {
      x: MARGIN, y: w.state.y - 8, size: 7, font: fonts.bold, color: MUTED
    });
    w.state.y -= 12;
    if (field.hint) {
      w.text(field.hint, { size: 7.5, color: MUTED, gap: 3 });
      w.state.y -= 2;
    }
    const seeded = Array.isArray(prefill[field.id]) ? prefill[field.id] : [];
    const columns = 3;
    const colWidth = CONTENT_W / columns;
    let col = 0;
    for (const option of field.options) {
      if (col === 0) w.space(18);
      const x = MARGIN + col * colWidth;
      const cb = form.createCheckBox(optionName(field.id, option.value));
      cb.addToPage(w.state.page, {
        x, y: w.state.y - 11, width: 10, height: 10, borderColor: RULE, borderWidth: 0.75
      });
      if (seeded.includes(option.value)) cb.check();
      const label = wrap(option.label, fonts.regular, 8, colWidth - 18)[0];
      w.state.page.drawText(pdfSafe(label), {
        x: x + 14, y: w.state.y - 9, size: 8, font: fonts.regular, color: INK
      });
      col += 1;
      if (col === columns) { col = 0; w.state.y -= 16; }
    }
    if (col !== 0) w.state.y -= 16;
    w.state.y -= 8;
  };

  const addGrid = (field) => {
    w.space(24 + field.rows.length * 16);
    const labelCol = 92;
    const cellW = (CONTENT_W - labelCol) / field.columns.length;
    field.columns.forEach((c, i) => {
      const label = wrap(c.label, fonts.bold, 6.5, cellW - 4)[0];
      w.state.page.drawText(pdfSafe(label), {
        x: MARGIN + labelCol + i * cellW, y: w.state.y - 8, size: 6.5, font: fonts.bold, color: MUTED
      });
    });
    w.state.y -= 14;
    const seeded = (prefill[field.id] && typeof prefill[field.id] === 'object') ? prefill[field.id] : {};
    for (const row of field.rows) {
      w.state.page.drawText(pdfSafe(row.label), {
        x: MARGIN, y: w.state.y - 9, size: 8.5, font: fonts.regular, color: INK
      });
      field.columns.forEach((c, i) => {
        const cb = form.createCheckBox(gridName(field.id, row.value, c.value));
        cb.addToPage(w.state.page, {
          x: MARGIN + labelCol + i * cellW, y: w.state.y - 11, width: 10, height: 10,
          borderColor: RULE, borderWidth: 0.75
        });
        if ((seeded[row.value] || []).includes(c.value)) cb.check();
      });
      w.state.y -= 16;
    }
    w.state.y -= 8;
  };

  const addRows = (field) => {
    const seeded = Array.isArray(prefill[field.id]) ? prefill[field.id] : [];
    for (let i = 0; i < field.rowCount; i++) {
      w.space(46);
      w.state.page.drawText(pdfSafe(`${i + 1}.`), {
        x: MARGIN, y: w.state.y - 12, size: 9, font: fonts.bold, color: NAVY
      });
      const usable = CONTENT_W - 16;
      const each = usable / field.rowFields.length;
      field.rowFields.forEach((rf, idx) => {
        const x = MARGIN + 16 + idx * each;
        w.state.page.drawText(pdfSafe(rf.label.toUpperCase()), {
          x, y: w.state.y - 4, size: 6.5, font: fonts.bold, color: MUTED
        });
        const tf = form.createTextField(rowFieldName(field.id, i, rf.id));
        const seedRow = seeded[i] || {};
        if (seedRow[rf.id]) tf.setText(pdfSafe(seedRow[rf.id]));
        tf.addToPage(w.state.page, {
          x, y: w.state.y - 24, width: each - 10, height: 17,
          borderColor: RULE, borderWidth: 0.75, backgroundColor: rgb(0.99, 0.99, 0.98)
        });
      });
      w.state.y -= 34;
    }
    w.state.y -= 4;
  };

  for (const section of wp.PACKET_SECTIONS) {
    sectionHeading(w, fonts, section.number, section.title);
    if (section.intro) {
      w.text(section.intro, { size: 8.5, color: MUTED, gap: 4 });
      w.state.y -= 4;
    }
    for (const field of section.fields) {
      if (field.type === 'single') addSingle(field);
      else if (field.type === 'multi') addMulti(field);
      else if (field.type === 'grid') addGrid(field);
      else if (field.type === 'rows') addRows(field);
      else if (field.type === 'textarea') {
        if (field.hint) { w.space(20); w.text(field.hint, { size: 7.5, color: MUTED, gap: 3 }); }
        addText(field, { multiline: true });
      } else {
        addText(field, { width: field.type === 'date' ? 180 : CONTENT_W });
      }
    }
  }

  // --- Part Two: the checklist, as a reference copy. The uploads happen in the
  // app; this page exists so the printed packet still says what to gather.
  w.newPage();
  drawHeader(w.state.page, fonts, 'PART TWO - What To Send Us');
  w.state.y = PAGE_H - 112;
  w.text('Georgia requires every caregiver to be fully cleared before working in a client\'s home. Here is everything we need from you. If you are missing something, call us before you worry about it. We help with most of these.', { size: 9, gap: 4 });
  w.text('Upload each one in the app under Documents. Clear phone photos are fine as long as all four corners and every word are readable.', { size: 9, gap: 4 });
  w.state.y -= 6;

  let currentGroup = null;
  for (const item of wp.DOCUMENT_ITEMS) {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      w.space(34);
      w.state.y -= 6;
      w.text(`${item.group}  ${wp.GROUP_TITLES[item.group]}`, { size: 10.5, font: fonts.bold, color: NAVY, gap: 4 });
      if (wp.GROUP_INTROS[item.group]) {
        w.text(wp.GROUP_INTROS[item.group], { size: 8, color: MUTED, gap: 3 });
      }
      w.state.y -= 4;
    }
    w.space(28);
    w.text(`${item.item}. ${item.title}`, { size: 9, font: fonts.bold, gap: 3, indent: 10 });
    if (item.detail) w.text(item.detail, { size: 8, color: MUTED, gap: 3, indent: 10 });
    if (item.help) w.text(item.help, { size: 8, color: NAVY, gap: 3, indent: 10 });
  }

  w.space(60);
  w.state.y -= 10;
  w.text(wp.PAY_PROMISE, { size: 8.5, font: fonts.bold, color: NAVY, gap: 4 });
  w.state.y -= 10;

  // Signature block. A packet returned on paper is signed here; one completed
  // in the app is signed on the screen. Both end up on the stored copy.
  w.space(70);
  const sigW = (CONTENT_W - 24) / 3;
  ['signature', 'printedName', 'signatureDate'].forEach((id, i) => {
    const labels = { signature: 'SIGNATURE', printedName: 'PRINTED NAME', signatureDate: 'DATE' };
    const x = MARGIN + i * (sigW + 12);
    w.state.page.drawText(labels[id], { x, y: w.state.y - 6, size: 7, font: fonts.bold, color: MUTED });
    const tf = form.createTextField(fieldName(id));
    tf.addToPage(w.state.page, {
      x, y: w.state.y - 30, width: sigW, height: 20,
      borderColor: RULE, borderWidth: 0.75, backgroundColor: rgb(0.99, 0.99, 0.98)
    });
  });
  w.state.y -= 40;

  pdf.getPages().forEach((page, i) => drawFooter(page, fonts, i + 1));
  // The packet version travels INSIDE the document, so an import can tell which
  // set of questions a returned packet was actually answering.
  const stamp = form.createTextField(fieldName('packetVersion'));
  stamp.setText(wp.PACKET_VERSION);
  stamp.enableReadOnly();
  const last = pdf.getPages()[pdf.getPageCount() - 1];
  stamp.addToPage(last, { x: MARGIN, y: MARGIN - 40, width: 160, height: 10, borderWidth: 0 });

  return Buffer.from(await pdf.save());
}

/**
 * The signed copy we keep and the caregiver can download: their answers as
 * submitted, their signature, and the checklist as it stood at signing.
 *
 * Flat — no form fields. A signed record is not something anyone should be able
 * to reopen and retype; a correction is a new signature on a changed document,
 * which is the rule the consent copies already follow.
 */
async function generateSignedWelcomePacketPDF(packet, caregiver = {}, checklist = []) {
  const data = (packet && packet.data) || {};
  const pdf = await PDFDocument.create();
  pdf.setTitle('Godwins Family Care - Completed Caregiver Welcome Packet');
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold)
  };
  const w = createWriter(pdf, fonts);

  w.newPage();
  drawHeader(w.state.page, fonts, 'COMPLETED CAREGIVER WELCOME PACKET');
  w.state.y = PAGE_H - 112;

  const who = [data.firstName, data.lastName].filter(Boolean).join(' ') || caregiver.name || 'Caregiver';
  w.text(who, { size: 14, font: fonts.bold, color: NAVY, gap: 4 });
  w.text(`Packet version ${(packet && packet.version) || wp.PACKET_VERSION}`, { size: 8, color: MUTED, gap: 3 });
  if (packet && packet.signed_at) {
    w.text(`Signed ${new Date(packet.signed_at).toLocaleString('en-US')}`, { size: 8, color: MUTED, gap: 3 });
  }
  if (packet && packet.imported_from) {
    w.text(`Imported from an uploaded packet: ${packet.imported_from}`, { size: 8, color: MUTED, gap: 3 });
  }
  w.state.y -= 8;

  const describe = (field, value) => {
    if (wp.isBlank(value)) return '—';
    switch (field.type) {
      case 'single': {
        const found = field.options.find(o => o.value === value);
        return found ? found.label : String(value);
      }
      case 'multi': {
        const labels = (value || []).map(v => (field.options.find(o => o.value === v) || {}).label || v);
        return labels.length ? labels.join(', ') : '—';
      }
      case 'grid': {
        const parts = [];
        for (const row of field.rows) {
          const picked = (value || {})[row.value] || [];
          if (!picked.length) continue;
          const cols = picked.map(c => (field.columns.find(x => x.value === c) || {}).label || c);
          parts.push(`${row.label}: ${cols.join(', ')}`);
        }
        return parts.length ? parts.join('  |  ') : '—';
      }
      case 'rows': {
        const rows = (value || []).map((r, i) =>
          `${i + 1}. ${field.rowFields.map(rf => r[rf.id] || '—').join(' · ')}`);
        return rows.length ? rows.join('   ') : '—';
      }
      default:
        return String(value);
    }
  };

  for (const section of wp.PACKET_SECTIONS) {
    sectionHeading(w, fonts, section.number, section.title);
    for (const field of section.fields) {
      w.space(22);
      w.text(field.label.toUpperCase(), { size: 7, font: fonts.bold, color: MUTED, gap: 2 });
      w.text(describe(field, data[field.id]), { size: 9, gap: 3, indent: 6 });
      w.state.y -= 3;
    }
  }

  // The checklist AS IT STOOD at signing. It is a snapshot, not a live state —
  // labelled as one, because a document that looks current and is not is worse
  // than one that says when it was true.
  if (checklist.length) {
    sectionHeading(w, fonts, '', 'Document checklist at signing');
    for (const row of checklist) {
      w.space(16);
      const mark = row.status === 'complete' ? '[x]' : (row.status === 'in_review' ? '[~]' : '[ ]');
      const tail = row.required ? '' : ' (not required for you)';
      w.text(`${mark} ${row.item}. ${row.title}${tail}`, { size: 8.5, gap: 3 });
    }
  }

  // Signature.
  w.space(120);
  w.state.y -= 10;
  w.text('SIGNATURE', { size: 7, font: fonts.bold, color: MUTED, gap: 4 });
  const sig = packet && packet.signature_png;
  if (sig && /^data:image\/png;base64,/.test(sig)) {
    try {
      const png = await pdf.embedPng(Buffer.from(sig.split(',')[1], 'base64'));
      const scale = Math.min(220 / png.width, 70 / png.height, 1);
      w.space(png.height * scale + 12);
      w.state.page.drawImage(png, {
        x: MARGIN, y: w.state.y - png.height * scale,
        width: png.width * scale, height: png.height * scale
      });
      w.state.y -= png.height * scale + 8;
    } catch (e) {
      // A signature that will not embed is reported on the document rather than
      // silently omitted: a signature block that is simply blank reads as an
      // unsigned packet.
      w.text('[signature image could not be rendered — the stored record holds it]', { size: 8, color: MUTED, gap: 3 });
    }
  } else if (packet && packet.signed_offline) {
    w.text('Signed on paper. The scanned packet is on file.', { size: 9, gap: 3 });
  }
  w.state.page.drawLine({
    start: { x: MARGIN, y: w.state.y }, end: { x: MARGIN + 240, y: w.state.y },
    thickness: 0.75, color: RULE
  });
  w.state.y -= 12;
  w.text(`Printed name: ${(packet && packet.printed_name) || who}`, { size: 9, gap: 3 });
  if (packet && packet.signed_at) {
    w.text(`Date: ${new Date(packet.signed_at).toLocaleDateString('en-US')}`, { size: 9, gap: 3 });
  }
  if (packet && packet.signer_ip_hash) {
    w.text(`Verification: ${packet.signer_ip_hash.slice(0, 16)}`, { size: 7, color: MUTED, gap: 3 });
  }

  pdf.getPages().forEach((page, i) => drawFooter(page, fonts, i + 1));
  return Buffer.from(await pdf.save());
}

/**
 * A SIGNED ATTESTATION, as its own document.
 *
 * The body is rendered AT THE VERSION STORED ON THE RECORD, never at whatever
 * the current wording says. That is the whole reason the version is stamped at
 * signature time: a copy of what somebody signed has to be what they signed.
 */
async function generateSignedAttestationPDF(record, caregiver) {
  const attest = require('./caregiverAttestations');
  const kind = (record && record.kind) || '';
  const version = (record && record.version) || null;
  const title = attest.titleFor(kind) || (record && record.title) || 'Attestation';
  const blocks = attest.bodyFor(kind, version);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Godwins Family Care - ${title}`);
  pdf.setSubject(`${title} ${version || ''}`.trim());
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold)
  };

  const w = createWriter(pdf, fonts);
  drawHeader(w.newPage(), fonts, title.toUpperCase());
  w.state.y = PAGE_H - 118;

  const who = (caregiver && caregiver.name) || (record && record.printed_name) || 'Caregiver';
  w.text(who, { size: 13, font: fonts.bold, color: NAVY, gap: 4 });
  if (version) w.text(`Document version ${version}`, { size: 8, color: MUTED, gap: 3 });
  // Named on the copy rather than left to be inferred: a reader has to be able
  // to tell a current signature from one against wording we have since changed.
  if (version && version !== attest.CURRENT_VERSION) {
    w.text('This copy reproduces the wording in force when it was signed. The current version of this form differs.',
      { size: 8, color: MUTED, gap: 4 });
  }
  w.state.y -= 6;

  for (const block of blocks) {
    if (block.t === 'h') {
      w.state.y -= 6;
      w.text(block.text, { size: 10.5, font: fonts.bold, color: NAVY, gap: 4 });
    } else if (block.t === 'ul') {
      for (const entry of block.items) w.text(`-  ${stripEmphasis(entry)}`, { size: 9, gap: 3.5, indent: 12 });
    } else if (block.t === 'note') {
      w.text(stripEmphasis(block.text), { size: 8.5, color: MUTED, gap: 3.5 });
    } else if (block.t === 'choice') {
      w.state.y -= 4;
      w.text(block.label, { size: 9.5, font: fonts.bold, gap: 4 });
      const chosen = ((record && record.elections) || {})[block.key];
      for (const option of block.options) {
        const mark = option.value === chosen ? '[X]' : '[ ]';
        w.text(`${mark}  ${stripEmphasis(option.label)}`, { size: 9, gap: 3.5, indent: 12 });
      }
      w.state.y -= 2;
    } else {
      w.text(stripEmphasis(block.text), { size: 9.5, gap: 4 });
    }
  }

  w.state.y -= 12;
  w.text('SIGNATURE', { size: 7, font: fonts.bold, color: MUTED, gap: 4 });

  if (record && record.signature_png) {
    try {
      const bytes = Buffer.from(String(record.signature_png).split(',')[1] || '', 'base64');
      const image = await pdf.embedPng(bytes);
      const drawW = Math.min(220, image.width);
      const drawH = (image.height / image.width) * drawW;
      w.space(drawH + 10);
      w.state.page.drawImage(image, { x: MARGIN, y: w.state.y - drawH, width: drawW, height: drawH });
      w.state.y -= drawH + 6;
    } catch (_) {
      // A copy that says the image would not render still proves the signature
      // exists in the record. Failing the whole document would not.
      w.text('[signature image could not be rendered - the stored record holds it]', { size: 8, color: MUTED, gap: 3 });
    }
  }

  w.state.page.drawLine({
    start: { x: MARGIN, y: w.state.y }, end: { x: MARGIN + 240, y: w.state.y },
    thickness: 0.75, color: RULE
  });
  w.state.y -= 12;
  w.text(`Printed name: ${(record && record.printed_name) || who}`, { size: 9, gap: 3 });
  if (record && record.signed_at) {
    w.text(`Signed: ${new Date(record.signed_at).toLocaleString('en-US')}`, { size: 9, gap: 3 });
  }
  if (record && record.signer_ip_hash) {
    w.text(`Verification: ${String(record.signer_ip_hash).slice(0, 16)}`, { size: 7, color: MUTED, gap: 3 });
  }
  if (record && record.supersedes && record.supersedes.signedAt) {
    w.text(`Replaces a signature of ${new Date(record.supersedes.signedAt).toLocaleDateString('en-US')} against version ${record.supersedes.version}.`,
      { size: 7, color: MUTED, gap: 3 });
  }

  pdf.getPages().forEach((page, i) => drawFooter(page, fonts, i + 1));
  return Buffer.from(await pdf.save());
}

module.exports = {
  PREFIX,
  fieldName,
  optionName,
  gridName,
  rowFieldName,
  pdfSafe,
  generateFillableWelcomePacketPDF,
  generateSignedWelcomePacketPDF,
  generateSignedAttestationPDF
};
