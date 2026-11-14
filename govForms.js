'use strict';
// ============================================================================
// govForms.js — the official government forms, filled from Pay Setup
// (owner, 2026-11-13: "they input the information in these form fields that
// save it to the govt pdf for them")
//
// The employee answers in the app. Sign and Save stores the answers (sealed
// where they are secret), and this module puts them on the REAL form: the
// IRS Form W-4 (2026) and Form W-9 (Rev. March 2024), Georgia Form G-4
// (Rev. 06/03/26), and USCIS Form I-9 (Edition 01/20/25). The blank forms
// live in govforms/ and are the agencies' own files.
//
// The typed signature, its date and time, and an electronic-signature line
// (who, when, the record it came from) are drawn on the form. The filled form
// is flattened, so what was signed cannot be edited afterwards.
//
// A state other than Georgia has no official template here yet: its
// certificate is produced as a GFC page with the same answers, and a state
// template is one entry in STATE_FORMS when it is added. Texas has no state
// income tax, so no state form is asked for.
//
// PURE apart from reading the templates. The route gathers the data.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const DIR = path.join(__dirname, 'govforms');
const FORMS = Object.freeze({
  w4: { file: 'fw4-2026.pdf', title: 'Form W-4 (2026)', agency: 'IRS' },
  w9: { file: 'fw9-2024-03.pdf', title: 'Form W-9 (Rev. March 2024)', agency: 'IRS' },
  w8ben: { file: 'fw8ben-2021-10.pdf', title: 'Form W-8BEN (Rev. October 2021)', agency: 'IRS' },
  g4: { file: 'g4-2026-06-03.pdf', title: 'Georgia Form G-4 (Rev. 06/03/26)', agency: 'Georgia Department of Revenue' },
  // Flattening the USCIS file leaves broken empty boxes, so its fields are
  // locked read-only instead (checked: a viewer reports no errors either way).
  i9: { file: 'i9-2025-01-20.pdf', title: 'Form I-9 (Edition 01/20/25)', agency: 'USCIS', lock: true }
});
// Official state certificates by work state. Georgia's is the G-4 above.
const STATE_FORMS = Object.freeze({ GA: 'g4' });

const TZ = 'America/New_York';
const mdy = (iso) => {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', year: 'numeric' });
};
const stamp = (iso) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
};
const dollars = (c) => (c ? (Number(c) / 100).toFixed(2).replace(/\.00$/, '') : '');
const ssnFmt = (d) => (/^\d{9}$/.test(String(d || '')) ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : '');
const einFmt = (d) => { const x = String(d || '').replace(/\D/g, ''); return x.length === 9 ? `${x.slice(0, 2)}-${x.slice(2)}` : ''; };
const cityLine = (a) => (a ? [a.city, [a.state, [a.zip, a.zip4].filter(Boolean).join('-')].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '');
const streetLine = (a) => (a ? [a.line1, a.line2].filter(Boolean).join(' ') : '');

// Set a text field if the form has it. A field the form lacks is skipped:
// a new edition that renames a box leaves it blank rather than failing.
function setText(form, name, value) {
  if (value === undefined || value === null || value === '') return;
  let f; try { f = form.getTextField(name); } catch (e) { return; }
  try { f.setMaxLength(undefined); } catch (e) { /* fine */ }
  f.setText(String(value));
}
// A ticked box is drawn as a plain X over the box. Some agency forms carry a
// check glyph that viewers render as a stray mark, and an X reads the same
// everywhere, on screen and on paper.
const marks = new WeakMap();
function check(form, name, on) {
  if (!on) return;
  let box; try { box = form.getCheckBox(name); } catch (e) { return; }
  const doc = form.doc;
  const list = marks.get(doc) || []; marks.set(doc, list);
  for (const w of box.acroField.getWidgets()) {
    const r = w.getRectangle();
    const pi = doc.getPages().findIndex(pg => pg.ref === w.P());
    list.push({ page: pi < 0 ? 0 : pi, r });
  }
}
async function drawMarks(doc) {
  const list = marks.get(doc) || [];
  if (!list.length) return;
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const { page, r } of list) {
    const size = Math.max(7, Math.min(r.width, r.height) * 0.95);
    const w = font.widthOfTextAtSize('X', size);
    doc.getPages()[page].drawText('X', { x: r.x + (r.width - w) / 2, y: r.y + (r.height - size * 0.72) / 2, size, font, color: rgb(0, 0, 0) });
  }
}
function select(form, name, value) {
  if (!value) return;
  try { form.getDropdown(name).select(value); } catch (e) { /* not an option */ }
}

async function load(key) {
  const def = FORMS[key];
  const bytes = fs.readFileSync(path.join(DIR, def.file));
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

// The typed signature, drawn where the person signs, and the date beside it.
async function signHere(doc, { page = 0, x, y, dateX, dateY, sig }) {
  if (!sig || !sig.signedName) return;
  const p = doc.getPages()[page];
  const font = await doc.embedFont(StandardFonts.HelveticaOblique);
  p.drawText(`/s/ ${sig.signedName}`, { x, y, size: 11, font, color: rgb(0.05, 0.1, 0.35) });
  if (dateX) p.drawText(mdy(sig.signedAt), { x: dateX, y: dateY === undefined ? y : dateY, size: 10, font, color: rgb(0.05, 0.1, 0.35) });
}
// Who signed, when, and the record it came from: a line at the foot of page 1,
// or at the top where the form's own footer fills the bottom (the I-9).
async function footer(doc, lines, { top = false } = {}) {
  const p = doc.getPages()[0];
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Wrap each line to the page width, so nothing runs off the edge.
  const maxW = p.getWidth() - 72;
  const shown = [];
  for (const t of lines.filter(Boolean)) {
    let cur = '';
    for (const word of t.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, 6.5) > maxW && cur) { shown.push(cur); cur = word; } else cur = next;
    }
    if (cur) shown.push(cur);
  }
  const h = p.getHeight();
  shown.forEach((t, i) => p.drawText(t, { x: 36, y: top ? h - 10 - i * 8 : 14 + (shown.length - 1 - i) * 8, size: 6.5, font, color: rgb(0.25, 0.25, 0.25) }));
}
const esigLine = (sig, what) => (sig && sig.signedName
  ? `Signed electronically by ${sig.signedName} on ${stamp(sig.signedAt)} in the Godwins Family Care app (${what}). The signer agreed to the statement under penalties of perjury.`
  : null);

async function finish(doc, { lock = false } = {}) {
  await drawMarks(doc);
  const form = doc.getForm();
  // A digital-signature box (the W-8BEN has one) cannot be flattened and is
  // not used: the typed signature is drawn on the page instead.
  // It has no drawn appearance, which stops a flatten, so it gets an empty one.
  for (const fld of form.getFields()) {
    if (!fld.constructor || fld.constructor.name !== 'PDFSignature') continue;
    for (const w of fld.acroField.getWidgets()) {
      try { w.setNormalAppearance(doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 1, 1] }))); } catch (e) { /* fine */ }
    }
  }
  const lockAll = () => { for (const fld of form.getFields()) { try { fld.enableReadOnly(); } catch (e) { /* fine */ } } };
  if (lock) lockAll();
  else { try { form.flatten(); } catch (e) { lockAll(); } }
  return Buffer.from(await doc.save());
}

// ---- Form W-4 -----------------------------------------------------------------
async function fillW4({ person, ssn, w4, employer, firstDay }) {
  const doc = await load('w4'); const f = doc.getForm();
  const P = 'topmostSubform[0].Page1[0].';
  const a = person.address || {};
  setText(f, `${P}Step1a[0].f1_01[0]`, [a.firstName, a.middle].filter(Boolean).join(' '));
  setText(f, `${P}Step1a[0].f1_02[0]`, [a.lastName, a.suffix].filter(Boolean).join(' '));
  setText(f, `${P}Step1a[0].f1_03[0]`, streetLine(a));
  setText(f, `${P}Step1a[0].f1_04[0]`, cityLine(a));
  setText(f, `${P}f1_05[0]`, ssnFmt(ssn));
  check(f, `${P}c1_1[0]`, w4.filingStatus === 'single');
  check(f, `${P}c1_1[1]`, w4.filingStatus === 'mfj');
  check(f, `${P}c1_1[2]`, w4.filingStatus === 'hoh');
  check(f, `${P}c1_2[0]`, w4.multipleJobs);
  // The app asks for the Step 3 total; it is entered on line 3.
  setText(f, `${P}f1_08[0]`, dollars(w4.dependentsCents));
  setText(f, `${P}f1_09[0]`, dollars(w4.otherIncomeCents));
  setText(f, `${P}f1_10[0]`, dollars(w4.deductionsCents));
  setText(f, `${P}f1_11[0]`, dollars(w4.extraWithholdingCents));
  check(f, `${P}c1_3[0]`, w4.exempt);
  setText(f, `${P}f1_12[0]`, [employer.name, employer.address].filter(Boolean).join(', '));
  setText(f, `${P}f1_13[0]`, mdy(firstDay));
  setText(f, `${P}f1_14[0]`, einFmt(employer.ein));
  await signHere(doc, { x: 106, y: 95, dateX: 465, sig: w4 });
  await footer(doc, [esigLine(w4, 'Pay Setup, Form W-4')]);
  return finish(doc);
}

// ---- Form W-9 -----------------------------------------------------------------
const W9_BOX = { individual: 0, c_corp: 1, s_corp: 2, partnership: 3, llc_single: 0, llc_c: 5, llc_s: 5, llc_p: 5 };
const W9_LLC = { llc_c: 'C', llc_s: 'S', llc_p: 'P' };
async function fillW9({ w9, tin }) {
  const doc = await load('w9'); const f = doc.getForm();
  const P = 'topmostSubform[0].Page1[0].';
  setText(f, `${P}f1_01[0]`, w9.name);
  setText(f, `${P}f1_02[0]`, w9.businessName);
  if (W9_BOX[w9.taxClass] !== undefined) check(f, `${P}Boxes3a-b_ReadOrder[0].c1_1[${W9_BOX[w9.taxClass]}]`, true);
  setText(f, `${P}Boxes3a-b_ReadOrder[0].f1_03[0]`, W9_LLC[w9.taxClass]);
  // The address is one free line in the app: street, then city, state, ZIP.
  const addr = String(w9.address || '');
  const cut = addr.indexOf(',');
  setText(f, `${P}Address_ReadOrder[0].f1_07[0]`, cut > 0 ? addr.slice(0, cut).trim() : addr);
  setText(f, `${P}Address_ReadOrder[0].f1_08[0]`, cut > 0 ? addr.slice(cut + 1).trim() : '');
  const d = String(tin || '');
  if (w9.tinType === 'ein' && d.length === 9) { setText(f, `${P}f1_14[0]`, d.slice(0, 2)); setText(f, `${P}f1_15[0]`, d.slice(2)); }
  else if (d.length === 9) { setText(f, `${P}f1_11[0]`, d.slice(0, 3)); setText(f, `${P}f1_12[0]`, d.slice(3, 5)); setText(f, `${P}f1_13[0]`, d.slice(5)); }
  await signHere(doc, { x: 125, y: 200, dateX: 405, sig: w9 });
  await footer(doc, [esigLine(w9, 'Pay Setup, Form W-9')]);
  return finish(doc);
}

// ---- Form W-8BEN (a contractor living outside the U.S.) ---------------------------
async function fillW8BEN({ w8, tins }) {
  const doc = await load('w8ben'); const f = doc.getForm();
  const P = 'topmostSubform[0].Page1[0].';
  const t = tins || {};
  const perm = w8.permanentAddress || {}, mail = w8.mailingAddress || {};
  setText(f, `${P}f_1[0]`, w8.name);
  setText(f, `${P}f_2[0]`, w8.citizenship);
  setText(f, `${P}f_3[0]`, perm.line);
  setText(f, `${P}f_4[0]`, perm.city);
  setText(f, `${P}f_5[0]`, perm.country);
  setText(f, `${P}f_6[0]`, mail.line);
  setText(f, `${P}f_7[0]`, mail.city);
  setText(f, `${P}f_8[0]`, mail.country);
  setText(f, `${P}f_9[0]`, t.usTin ? ssnFmt(t.usTin) : '');
  setText(f, `${P}f_10[0]`, t.foreignTin);
  check(f, `${P}c1_01[0]`, w8.ftinNotRequired && !t.foreignTin);
  setText(f, `${P}f_12[0]`, mdy(w8.dob).replace(/\//g, '-'));
  if (w8.treaty) {
    setText(f, `${P}f_13[0]`, w8.treaty.country);
    setText(f, `${P}f_14[0]`, w8.treaty.article);
    setText(f, `${P}f_15[0]`, w8.treaty.rate);
    setText(f, `${P}f_16[0]`, w8.treaty.incomeType);
    setText(f, `${P}f_17[0]`, w8.treaty.conditions);
  }
  setText(f, `${P}Date[0]`, mdy(w8.signedAt));
  setText(f, `${P}f_21[0]`, w8.signedName);
  await signHere(doc, { x: 112, y: 77, sig: w8 });
  await footer(doc, [esigLine(w8, 'Pay Setup, Form W-8BEN')], { top: true });
  return finish(doc);
}

// ---- Georgia Form G-4 -----------------------------------------------------------
async function fillG4({ person, ssn, g4, employer }) {
  const doc = await load('g4'); const f = doc.getForm();
  const a = person.address || {};
  setText(f, '1a YOUR FULL NAME', [a.firstName, a.middle, a.lastName, a.suffix].filter(Boolean).join(' '));
  setText(f, '1b YOUR SOCIAL SECURITY NUMBER', ssnFmt(ssn));
  setText(f, '2a HOME ADDRESS Number Street or Rural Route', streetLine(a));
  setText(f, '2b CITY STATE AND ZIP CODE', cityLine(a));
  if (g4.exempt) {
    // Line 8a. Lines 4 to 7 stay empty when claiming exempt (the form says so).
    check(f, 'Check Box5', true);
  } else {
    setText(f, 'LETTER USED Marital Status A B C or D', g4.filingStatus);
    setText(f, 'Dependent Allowances', String(g4.dependentAllowances || 0));
    setText(f, 'Georgia Adjustment Allowance', String(g4.additionalAllowances || 0));
    setText(f, 'TOTAL ALLOWANCES: Total of Lines 4 and  5', String((g4.dependentAllowances || 0) + (g4.additionalAllowances || 0)));
  }
  setText(f, 'ADDITIONAL WITHHOLDING', dollars(g4.extraWithholdingCents));
  setText(f, 'Date', mdy(g4.signedAt));
  setText(f, "Employer's name and address", [employer.name, employer.address].filter(Boolean).join(', '));
  setText(f, 'EMPLOYERS FEIN', einFmt(employer.ein));
  setText(f, 'EMPLOYERS WH', employer.gaWithholdingNumber);
  await signHere(doc, { x: 135, y: 123, sig: g4 });
  await footer(doc, [esigLine(g4, 'Pay Setup, Form G-4')]);
  // The form's own Print and Clear buttons do nothing on a signed copy.
  for (const n of ['PRINT', 'CLEAR']) { try { f.removeField(f.getButton(n)); } catch (e) { /* absent */ } }
  return finish(doc);
}

// ---- Form I-9 -------------------------------------------------------------------
const I9_BOX = { citizen: 'CB_1', noncitizen_national: 'CB_2', lpr: 'CB_3', authorized: 'CB_4' };
const LIST_A = [
  ['Document Title 1', 'Issuing Authority 1', 'Document Number 0 (if any)', 'Expiration Date if any'],
  ['Document Title 2 If any', 'Issuing Authority_2', 'Document Number If any_2', 'List A.  Document 2. Expiration Date (if any)'],
  ['List A.   Document Title 3.  If any', 'List A. Document 3.  Enter Issuing Authority', 'List A.  Document 3 Number.  If any', 'Document Number if any_3']
];
const LIST_B = ['List B Document 1 Title', 'List B Issuing Authority 1', 'List B Document Number 1', 'List B Expiration Date 1'];
const LIST_C = ['List C Document Title 1', 'List C Issuing Authority 1', 'List C Document Number 1', 'List C Expiration Date 1'];
async function fillI9({ person, ssn, i9, employer, immigration, docNumbers }) {
  const doc = await load('i9'); const f = doc.getForm();
  const a = person.address || {};
  const s1 = (i9 && i9.section1) || {};
  setText(f, 'Last Name (Family Name)', a.lastName);
  setText(f, 'First Name Given Name', a.firstName);
  setText(f, 'Employee Middle Initial (if any)', a.middle ? a.middle[0] : '');
  setText(f, 'Employee Other Last Names Used (if any)', s1.otherLastNames || 'N/A');
  setText(f, 'Address Street Number and Name', a.line1);
  setText(f, 'Apt Number (if any)', a.line2);
  setText(f, 'City or Town', a.city);
  select(f, 'State', a.state);
  setText(f, 'ZIP Code', a.zip);
  setText(f, 'Date of Birth mmddyyyy', mdy(s1.dob));
  setText(f, 'US Social Security Number', ssn && /^\d{9}$/.test(ssn) ? ssn : '');
  setText(f, 'Employees E-mail Address', person.email);
  setText(f, 'Telephone Number', s1.phone || person.phone);
  check(f, I9_BOX[s1.status], !!I9_BOX[s1.status]);
  const imm = immigration || {};
  if (s1.status === 'lpr') setText(f, '3 A lawful permanent resident Enter USCIS or ANumber', imm.alienNumber);
  if (s1.status === 'authorized') {
    setText(f, 'Exp Date mmddyyyy', s1.workAuthExpires ? mdy(s1.workAuthExpires) : 'N/A');
    setText(f, 'USCIS ANumber', imm.alienNumber);
    setText(f, 'Form I94 Admission Number', imm.i94Number);
    setText(f, 'Foreign Passport Number and Country of IssuanceRow1', imm.passport);
  }
  setText(f, 'Signature of Employee', s1.signedName ? `/s/ ${s1.signedName}` : '');
  setText(f, "Today's Date mmddyyy", mdy(s1.signedAt));

  const s2 = i9 && i9.section2;
  if (s2) {
    const nums = docNumbers || [];
    const docs = (s2.documents || []).map((d, i) => ({ ...d, number: nums[i] || '' }));
    docs.filter(d => d.list === 'A').slice(0, 3).forEach((d, i) => {
      const [t, auth, num, exp] = LIST_A[i];
      setText(f, t, d.title); setText(f, auth, d.issuer); setText(f, num, d.number); setText(f, exp, d.expires ? mdy(d.expires) : 'N/A');
    });
    for (const [list, names] of [['B', LIST_B], ['C', LIST_C]]) {
      const d = docs.find(x => x.list === list);
      if (!d) continue;
      setText(f, names[0], d.title); setText(f, names[1], d.issuer); setText(f, names[2], d.number); setText(f, names[3], d.expires ? mdy(d.expires) : 'N/A');
    }
    setText(f, 'FirstDayEmployed mmddyyyy', mdy(s2.firstDay));
    setText(f, 'Last Name First Name and Title of Employer or Authorized Representative', [s2.reviewedBy, s2.reviewerTitle].filter(Boolean).join(', '));
    setText(f, 'Signature of Employer or AR', s2.reviewedBy ? `/s/ ${s2.reviewedBy}` : '');
    setText(f, 'S2 Todays Date mmddyyyy', mdy(s2.reviewedAt));
    setText(f, 'Employers Business or Org Name', employer.name);
    setText(f, 'Employers Business or Org Address', employer.address);
  }
  await footer(doc, [esigLine(s1, 'Pay Setup, Form I-9 Section 1'),
    s2 ? `Section 2 completed electronically by ${s2.reviewedBy} on ${stamp(s2.reviewedAt)}, who examined the documents listed.` : null], { top: true });
  return finish(doc, { lock: true });
}

// ---- A state certificate with no official template yet ---------------------------
async function fillStateCert({ person, stateCert, stateName, employer }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const a = person.address || {};
  let y = 740;
  const line = (t, f = font, size = 11) => { page.drawText(String(t), { x: 54, y, size, font: f }); y -= size + 8; };
  line(`${stateName} Employee Withholding Certificate`, bold, 16);
  line(`Recorded in the Godwins Family Care app for ${employer.name}. Where ${stateName} requires its own form, file that form as well.`, font, 9);
  y -= 6;
  line(`Employee: ${[a.firstName, a.middle, a.lastName].filter(Boolean).join(' ')}`);
  line(`Address: ${streetLine(a)}, ${cityLine(a)}`);
  line(`Filing status: ${stateCert.filingStatus === 'married' ? 'Married' : 'Single'}`);
  line(`Allowances: ${stateCert.allowances || 0}`);
  line(`Additional withholding per pay period: $${dollars(stateCert.extraWithholdingCents) || '0'}`);
  line(`Exempt: ${stateCert.exempt ? 'Yes' : 'No'}`);
  y -= 10;
  line('Under penalties of perjury, I declare that the information above is correct.', font, 10);
  line(`Signature: /s/ ${stateCert.signedName}     Date: ${mdy(stateCert.signedAt)}`);
  await footer(doc, [esigLine(stateCert, `Pay Setup, ${stateName} certificate`)]);
  return Buffer.from(await doc.save());
}

const formsFor = (p) => {
  const out = [];
  if (p.w4) out.push('w4');
  if (p.g4) out.push('g4');
  if (p.stateCert) out.push('state');
  if (p.i9 && p.i9.section1) out.push('i9');
  if (p.w9) out.push('w9');
  if (p.w8ben) out.push('w8ben');
  return out;
};
const FILE_NAMES = Object.freeze({ w4: 'Form W-4', w9: 'Form W-9', w8ben: 'Form W-8BEN', g4: 'Georgia Form G-4', i9: 'Form I-9', state: 'State withholding certificate' });

module.exports = { FORMS, STATE_FORMS, FILE_NAMES, fillW4, fillW9, fillW8BEN, fillG4, fillI9, fillStateCert, formsFor, mdy };
