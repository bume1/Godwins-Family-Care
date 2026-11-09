// ============================================================================
// PAYROLL YEAR END: W-2, 1099-NEC, the SSA wage file, the IRIS upload, G-1003
// ============================================================================
// Pure. Every number is read from approved payroll runs and paid contractor
// invoices that already exist; nothing here is entered twice.
//
// Sources, checked 2026-11-09:
//   SSA Publication 42-007, EFW2 (tax year 2025, the latest posted): every
//     record is exactly 512 bytes and ends in CR/LF; money is cents, right
//     justified and zero filled; alpha fields are left justified, blank filled.
//   IRS Publication 1141 (2026), section 2.3: employee copies B, C and 2. Core
//     boxes 1-6 upper right; boxes 1 and 2 on Copy B outlined in bold; form
//     number, title and year together; "Department of the Treasury - Internal
//     Revenue Service" on every copy; the Copy C note; instructions like the
//     back of the official form, including the EITC notice; the SSN MAY be
//     truncated on employee copies, never on the copy filed. No logos beyond
//     the employer's name. Section 2.4: what an employee must be told before
//     consenting to electronic W-2s.
//   IRS Publication 1179: 1099 recipient statements may truncate the TIN on
//     the recipient's copy, never on the copy filed; "Federal income tax
//     withheld" in bold; OMB No. 1545-0116.
//   IRS IRIS Taxpayer Portal, 1099-NEC CSV formatting guidelines (columns A to
//     BB, tax year 2025).
//   2026 General Instructions for Forms W-2 and W-3: new box 12 code TT, the
//     total of qualified overtime (only the "half" of time-and-a-half), which
//     Georgia also requires on 2026 W-2s. Instructions for Forms 1099-MISC and
//     1099-NEC (Rev. December 2026): box 1a, and the $2,000 threshold for
//     payments after 2025, indexed from 2027 (P.L. 119-21).
//
// LAYOUT YEARS. A filing FILE is built only for a tax year whose exact layout
// is written here. Tax year 2026 changes the SSA RW record (TT and TP get
// fields) and the IRIS 1099-NEC columns (boxes 1a to 1d); neither 2026 layout
// was reachable when this was written, so for 2026 the office keys the
// numbers from the filing sheet into SSA W-2 Online and the IRIS portal. A
// guessed field position on a federal filing is worse than no file.
// ============================================================================

const FORM = Object.freeze({ W2: 'W-2', NEC: '1099-NEC' });
const OMB = Object.freeze({ W2: '1545-0029', NEC: '1545-0116' });
const GA_FIPS = '13';
const EFW2_LAYOUT_YEARS = Object.freeze([2025]);
const IRIS_NEC_LAYOUT_YEARS = Object.freeze([2025]);

// What an employee is told before they agree to electronic W-2s and 1099s
// (Pub 1141 section 2.4; Treas. Reg. 31.6051-1(j)). Versioned: a consent
// records the version it was given against.
const E_DELIVERY_VERSION = '2026-11-v1';
const E_DELIVERY_DISCLOSURE = Object.freeze([
  'If you do not agree, you will get a paper W-2 or 1099 by mail.',
  'This consent covers every W-2 and 1099 Godwins Family Care issues you, this year and later years, until you withdraw it.',
  'You can ask for a paper copy at any time by calling or emailing the office. Asking for one paper copy does not withdraw your consent.',
  'You can withdraw your consent at any time, here or in writing to the office. We confirm the withdrawal in writing with the date it takes effect. A withdrawal does not apply to forms already issued.',
  'We stop furnishing forms electronically if your GFC sign-in ends, for example when you leave. You will then get paper forms by mail.',
  'Keep your email address current in My GFC → My Profile so we can tell you when a form is ready. We tell you if our contact details change.',
  'You need a device with a web browser and a PDF reader to open and print the form. Each form stays available here from January 31 through October 15 of that year, and longer.',
  'You may need to print the form and attach it to a federal, state or local tax return.'
]);

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n, ' ');
const money = (cents, n) => {
  const v = Math.max(0, Math.round(Number(cents) || 0));
  return String(v).padStart(n, '0').slice(-n);
};
const digits = (s) => String(s || '').replace(/\D/g, '');
const up = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
// SSA names: letters, hyphen, apostrophe, space. Addresses: letters, digits,
// space and a little punctuation.
const ssaName = (s) => collapse(up(s).replace(/[^A-Z\-' ]/g, ' '));
const ssaAddr = (s) => collapse(up(s).replace(/[^A-Z0-9\-#/., ]/g, ' '));

/** The SSN or TIN as an employee or recipient copy may show it (Pub 1141, 1179). */
function truncateTin(raw, type) {
  const d = digits(raw);
  if (d.length !== 9) return null;
  return type === 'ein' ? `XX-XXX${d.slice(5)}` : `XXX-XX-${d.slice(5)}`;
}
const formatTin = (raw, type) => {
  const d = digits(raw);
  if (d.length !== 9) return null;
  return type === 'ein' ? `${d.slice(0, 2)}-${d.slice(2)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
};

/** "4300 Paces Ferry Rd SE, Suite 500, Atlanta, GA 30339" → parts. */
function parseAddress(s) {
  const parts = String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const m = parts.length >= 3 && /^([A-Z]{2})\s+(\d{5})(?:-?(\d{4}))?$/.exec(parts[parts.length - 1]);
  if (!m) return null;
  return { line1: parts[0], line2: parts.length > 3 ? parts.slice(1, -2).join(', ') : '', city: parts[parts.length - 2], state: m[1], zip: m[2], zip4: m[3] || '' };
}

// ---- the year-end settings (the employer side) -----------------------------------
const YEAR_END_FIELDS = ['employerName', 'employerAddress', 'gaWithholdingId', 'ssaUserId', 'contactName', 'contactPhone', 'contactEmail'];
function normalizeYearEnd(b, current) {
  const s = { ...(current || {}) };
  b = b || {};
  const str = (v, n) => collapse(String(v == null ? '' : v)).slice(0, n);
  if (b.employerName !== undefined) s.employerName = str(b.employerName, 57) || null;
  if (b.employerAddress !== undefined) {
    const a = b.employerAddress || {};
    const st = str(a.state, 2).toUpperCase(), zip = digits(a.zip);
    if (!str(a.line1, 22) || !str(a.city, 22) || !/^[A-Z]{2}$/.test(st) || !(zip.length === 5 || zip.length === 9)) return { error: 'Give the employer address: street, city, two-letter state and ZIP.', code: 'YE_EMPLOYER_ADDRESS' };
    s.employerAddress = { line1: str(a.line1, 40), line2: str(a.line2, 40), city: str(a.city, 40), state: st, zip: zip.slice(0, 5), zip4: zip.slice(5) };
  }
  if (b.gaWithholdingId !== undefined) {
    const v = String(b.gaWithholdingId || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (v && !/^\d{7}-?[A-Z]{2}$/.test(v)) return { error: 'The Georgia withholding number looks like 1234567-AB.', code: 'YE_GA_ID' };
    s.gaWithholdingId = v ? v.replace(/^(\d{7})-?([A-Z]{2})$/, '$1-$2') : null;
  }
  if (b.ssaUserId !== undefined) {
    const v = String(b.ssaUserId || '').toUpperCase().replace(/\s/g, '');
    if (v && !/^[A-Z0-9]{8}$/.test(v)) return { error: 'The SSA Business Services Online user ID is 8 letters and numbers.', code: 'YE_SSA_USER' };
    s.ssaUserId = v || null;
  }
  if (b.contactName !== undefined) s.contactName = str(b.contactName, 27) || null;
  if (b.contactPhone !== undefined) {
    const v = digits(b.contactPhone);
    if (v && v.length !== 10) return { error: 'The contact phone is 10 digits.', code: 'YE_PHONE' };
    s.contactPhone = v || null;
  }
  if (b.contactEmail !== undefined) {
    const v = String(b.contactEmail || '').trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: 'Give a valid contact email.', code: 'YE_EMAIL' };
    s.contactEmail = v || null;
  }
  return { value: s };
}

/** What the employer side still needs before W-2s and the SSA file. */
function employerMissing(employer) {
  const e = employer || {};
  const out = [];
  if (!e.ein) out.push('Employer EIN (Payroll → Settings)');
  if (!e.name) out.push('Employer legal name');
  if (!e.address) out.push('Employer address');
  if (!e.gaWithholdingId) out.push('Georgia withholding number');
  return out;
}
function fileMissing(employer) {
  const e = employer || {};
  const out = employerMissing(e);
  if (!e.ssaUserId) out.push('SSA Business Services Online user ID');
  if (!e.contactName) out.push('Contact name for the SSA file');
  if (!e.contactPhone) out.push('Contact phone for the SSA file');
  if (!e.contactEmail) out.push('Contact email for the SSA file');
  return out;
}

// ---- the person's side ------------------------------------------------------------
/** Legal name and mailing address for a W-2 or 1099 (My GFC → Pay Setup). */
function normalizeTaxAddress(b) {
  b = b || {};
  const str = (v, n) => collapse(String(v == null ? '' : v)).slice(0, n);
  const firstName = str(b.firstName, 40), lastName = str(b.lastName, 40);
  if (!firstName || !lastName) return { error: 'Give your first and last name as they appear on your Social Security card.', code: 'TAX_NAME' };
  const st = str(b.state, 2).toUpperCase(), zip = digits(b.zip);
  if (!str(b.line1, 60) || !str(b.city, 40) || !/^[A-Z]{2}$/.test(st) || !(zip.length === 5 || zip.length === 9)) return { error: 'Give your street, city, two-letter state and ZIP.', code: 'TAX_ADDRESS' };
  return { value: { firstName, middle: str(b.middle, 40), lastName, suffix: str(b.suffix, 4), line1: str(b.line1, 60), line2: str(b.line2, 60), city: str(b.city, 40), state: st, zip: zip.slice(0, 5), zip4: zip.slice(5) } };
}

// ---- the numbers ------------------------------------------------------------------
// The box figures themselves come from payrollCalendar.yearEnd (one source).
/** Runs paid this year that are not yet final (a W-2 cannot be released over them). */
const openRunsIn = (runs, year) => (runs || []).filter(r => r && r.status === 'draft' && r.period && String(r.period.payDate).startsWith(String(year)));
/** Approved runs not yet paid: their wages are on the W-2, so they must be paid first. */
const unpaidRunsIn = (runs, year) => (runs || []).filter(r => r && r.status === 'approved' && r.period && String(r.period.payDate).startsWith(String(year)));

// ---- the SSA wage file (EFW2) -------------------------------------------------------
const record = (fields) => {
  // fields: [[startPos (1-based), length, value]]
  const buf = Array(512).fill(' ');
  for (const [start, len, val] of fields) {
    const v = String(val);
    if (v.length !== len) throw new Error(`EFW2 field at ${start} is ${v.length} long, wants ${len}`);
    for (let i = 0; i < len; i++) buf[start - 1 + i] = v[i];
  }
  return buf.join('');
};

/**
 * One file for one employer and one tax year: RA, RE, one RW per employee,
 * RT, RF. Every SSN here is the full number; the caller decrypts and the file
 * goes only to the owner's download, never stored.
 *   employer: { ein, name, address:{line1,line2,city,state,zip,zip4}, ssaUserId,
 *               contactName, contactPhone, contactEmail }
 *   employees: [{ ssn, firstName, middle, lastName, suffix, address, boxes }]
 */
function efw2File({ year, employer, employees }) {
  if (!EFW2_LAYOUT_YEARS.includes(Number(year))) {
    const err = new Error(`SSA's ${year} file layout is not built into the app yet. Key the W-2s into SSA W-2 Online from the filing sheet.`);
    err.code = 'EFW2_LAYOUT_UNKNOWN';
    throw err;
  }
  const e = employer, a = e.address;
  const ein = digits(e.ein);
  if (ein.length !== 9) throw new Error('EFW2: employer EIN must be 9 digits');
  const ra = record([
    [1, 2, 'RA'], [3, 9, ein], [12, 8, pad(e.ssaUserId, 8)], [20, 4, pad('', 4)], [24, 5, pad('', 5)],
    [29, 1, '0'], [30, 6, pad('', 6)], [36, 2, '98'],
    [38, 57, pad(ssaAddr(e.name), 57)], [95, 22, pad(ssaAddr(a.line2), 22)], [117, 22, pad(ssaAddr(a.line1), 22)],
    [139, 22, pad(ssaAddr(a.city), 22)], [161, 2, pad(a.state, 2)], [163, 5, pad(a.zip, 5)], [168, 4, pad(a.zip4, 4)],
    [217, 57, pad(ssaAddr(e.name), 57)], [274, 22, pad(ssaAddr(a.line2), 22)], [296, 22, pad(ssaAddr(a.line1), 22)],
    [318, 22, pad(ssaAddr(a.city), 22)], [340, 2, pad(a.state, 2)], [342, 5, pad(a.zip, 5)], [347, 4, pad(a.zip4, 4)],
    [396, 27, pad(ssaName(e.contactName), 27)], [423, 15, pad(digits(e.contactPhone), 15)], [438, 5, pad('', 5)],
    [446, 40, pad(String(e.contactEmail || '').toUpperCase(), 40)], [500, 1, 'L']
  ]);
  const re = record([
    [1, 2, 'RE'], [3, 4, String(year)], [7, 1, ' '], [8, 9, ein], [17, 9, pad('', 9)], [26, 1, '0'], [27, 4, pad('', 4)], [31, 9, pad('', 9)],
    [40, 57, pad(ssaAddr(e.name), 57)], [97, 22, pad(ssaAddr(a.line2), 22)], [119, 22, pad(ssaAddr(a.line1), 22)],
    [141, 22, pad(ssaAddr(a.city), 22)], [163, 2, pad(a.state, 2)], [165, 5, pad(a.zip, 5)], [170, 4, pad(a.zip4, 4)],
    [174, 1, 'N'], [219, 1, 'R'], [220, 1, ' '], [221, 1, '0'],
    [222, 27, pad(ssaName(e.contactName), 27)], [249, 15, pad(digits(e.contactPhone), 15)], [264, 5, pad('', 5)],
    [279, 40, pad(String(e.contactEmail || '').toUpperCase(), 40)]
  ]);
  const tot = { n: 0, box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0 };
  const rws = [];
  for (const m of employees) {
    const ssn = digits(m.ssn);
    if (ssn.length !== 9) throw new Error('EFW2: every employee needs a 9-digit SSN');
    const b = m.boxes, ad = m.address || {};
    rws.push(record([
      [1, 2, 'RW'], [3, 9, ssn], [12, 15, pad(ssaName(m.firstName), 15)], [27, 15, pad(ssaName(m.middle), 15)],
      [42, 20, pad(ssaName(m.lastName), 20)], [62, 4, pad(ssaName(m.suffix), 4)],
      [66, 22, pad(ssaAddr(ad.line2), 22)], [88, 22, pad(ssaAddr(ad.line1), 22)], [110, 22, pad(ssaAddr(ad.city), 22)],
      [132, 2, pad(ad.state, 2)], [134, 5, pad(ad.zip, 5)], [139, 4, pad(ad.zip4, 4)],
      [188, 11, money(b.box1, 11)], [199, 11, money(b.box2, 11)], [210, 11, money(b.box3, 11)], [221, 11, money(b.box4, 11)],
      [232, 11, money(b.box5, 11)], [243, 11, money(b.box6, 11)], [254, 11, money(0, 11)],
      ...[276, 287, 298, 309, 320, 331, 353, 364, 375, 386, 408, 419, 430, 441, 452, 463, 474].map(p => [p, 11, money(0, 11)]),
      [486, 1, '0'], [488, 1, '0'], [489, 1, '0']
    ]));
    tot.n++;
    for (const k of ['box1', 'box2', 'box3', 'box4', 'box5', 'box6']) tot[k] += b[k] || 0;
  }
  const rt = record([
    [1, 2, 'RT'], [3, 7, String(tot.n).padStart(7, '0')],
    [10, 15, money(tot.box1, 15)], [25, 15, money(tot.box2, 15)], [40, 15, money(tot.box3, 15)], [55, 15, money(tot.box4, 15)],
    [70, 15, money(tot.box5, 15)], [85, 15, money(tot.box6, 15)], [100, 15, money(0, 15)],
    ...[130, 145, 160, 175, 190, 205, 235, 250, 265, 280, 295, 310, 325, 340, 355, 370, 385, 400].map(p => [p, 15, money(0, 15)])
  ]);
  const rf = record([[1, 2, 'RF'], [8, 9, String(tot.n).padStart(9, '0')]]);
  return [ra, re, ...rws, rt, rf].map(r => `${r}\r\n`).join('');
}

// ---- the IRIS 1099-NEC CSV ----------------------------------------------------------
// Column order A to BB of the IRS's 1099-NEC CSV guidelines (tax year 2025).
const IRIS_NEC_COLUMNS = Object.freeze([
  'Form Type', 'Tax Year', 'Payer TIN Type', 'Payer Taxpayer ID Number', 'Payer Name Type', 'Payer Business or Entity Name Line 1',
  'Payer Business or Entity Name Line 2', 'Payer First Name', 'Payer Middle Name', 'Payer Last Name (Surname)', 'Payer Suffix',
  'Payer Country', 'Payer Address Line 1', 'Payer Address Line 2', 'Payer City/Town', 'Payer State/Province/Territory',
  'Payer ZIP/Postal Code', 'Payer Phone Type', 'Payer Phone', 'Recipient TIN Type', 'Recipient Taxpayer ID Number',
  'Recipient Name Type', 'Recipient Business or Entity Name Line 1', 'Recipient Business or Entity Name Line 2',
  'Recipient First Name', 'Recipient Middle Name', 'Recipient Last Name (Surname)', 'Recipient Suffix', 'Recipient Country',
  'Recipient Address Line 1', 'Recipient Address Line 2', 'Recipient City/Town', 'Recipient State/Province/Territory',
  'Recipient ZIP/Postal Code', 'Office Code', 'Form Account Number', '2nd TIN Notice', 'Box 1 - Nonemployee Compensation',
  'Box 2 - Payer made direct sales totaling $5,000 or more of consumer products to a recipient for resale',
  'Box 3 - Excess golden parachute payments', 'Box 4 - Federal income tax withheld', 'Combined Federal/State Filing (CF/SF)',
  'State 1', 'State 1 - State Tax Withheld', 'State 1 - State/Payer state number', 'State 1 - State income',
  'State 1 - Local income tax withheld', 'State 1 - Special Data Entries', 'State 2', 'State 2 - State Tax Withheld',
  'State 2 - State/Payer state number', 'State 2 - State income', 'State 2 - Local income tax withheld', 'State 2 - Special Data Entries'
]);
const irisName = (s, n) => collapse(up(s).replace(/[^A-Z0-9\-#()&' ]/g, ' ')).slice(0, n).trim();
const irisPerson = (s) => collapse(up(s).replace(/[^A-Z\- ]/g, ' ')).slice(0, 20).trim();
const irisAddr = (s) => collapse(up(s).replace(/[^A-Z0-9\-/ ]/g, ' ')).slice(0, 35).trim();
const irisCity = (s) => collapse(up(s).replace(/[^A-Z ]/g, ' ')).slice(0, 40).trim();
const dollars = (c) => (Math.round(Number(c) || 0) / 100).toFixed(2);
const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/**
 * recipients: [{ tin, tinType: 'ssn'|'ein', isBusiness, businessName,
 *   firstName, middle, lastName, suffix, address, box1Cents, account }]
 */
function irisNecCsv({ year, payer, recipients }) {
  if (!IRIS_NEC_LAYOUT_YEARS.includes(Number(year))) {
    const err = new Error(`The IRS ${year} 1099-NEC upload template is not built into the app yet. Key the 1099s into the IRIS portal from the filing sheet.`);
    err.code = 'IRIS_LAYOUT_UNKNOWN';
    throw err;
  }
  const pa = payer.address;
  const rows = recipients.map(r => {
    const ad = r.address || {};
    const row = {
      'Form Type': '1099-NEC', 'Tax Year': String(year), 'Payer TIN Type': 'EIN', 'Payer Taxpayer ID Number': formatTin(payer.ein, 'ein'),
      'Payer Name Type': 'B', 'Payer Business or Entity Name Line 1': irisName(payer.name, 40), 'Payer Country': 'US',
      'Payer Address Line 1': irisAddr(pa.line1), 'Payer Address Line 2': irisAddr(pa.line2), 'Payer City/Town': irisCity(pa.city),
      'Payer State/Province/Territory': pa.state, 'Payer ZIP/Postal Code': `${pa.zip}${pa.zip4 || ''}`,
      'Payer Phone Type': payer.phone ? 'D' : '', 'Payer Phone': digits(payer.phone),
      'Recipient TIN Type': r.tinType === 'ein' ? 'EIN' : 'SSN', 'Recipient Taxpayer ID Number': formatTin(r.tin, r.tinType),
      'Recipient Name Type': r.isBusiness ? 'B' : 'I',
      'Recipient Business or Entity Name Line 1': r.isBusiness ? irisName(r.businessName, 40) : '',
      'Recipient First Name': r.isBusiness ? '' : irisPerson(r.firstName), 'Recipient Middle Name': r.isBusiness ? '' : irisPerson(r.middle),
      'Recipient Last Name (Surname)': r.isBusiness ? '' : irisPerson(r.lastName), 'Recipient Suffix': r.isBusiness ? '' : irisPerson(r.suffix),
      'Recipient Country': 'US', 'Recipient Address Line 1': irisAddr(ad.line1), 'Recipient Address Line 2': irisAddr(ad.line2),
      'Recipient City/Town': irisCity(ad.city), 'Recipient State/Province/Territory': ad.state, 'Recipient ZIP/Postal Code': `${ad.zip || ''}${ad.zip4 || ''}`,
      'Form Account Number': r.account || '', '2nd TIN Notice': 'N', 'Box 1 - Nonemployee Compensation': dollars(r.box1Cents),
      'Box 2 - Payer made direct sales totaling $5,000 or more of consumer products to a recipient for resale': 'N',
      'Box 4 - Federal income tax withheld': '0.00'
    };
    return IRIS_NEC_COLUMNS.map(c => csvCell(row[c] == null ? '' : row[c])).join(',');
  });
  return [IRIS_NEC_COLUMNS.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}

/**
 * The filing sheet: one row per form with every box, for keying into SSA W-2
 * Online, the IRIS portal and the Georgia Tax Center. Carries FULL SSNs and
 * TINs, so it is built only at the owner's download and never stored.
 */
const FILING_SHEET_COLUMNS = Object.freeze(['Form', 'Tax year', 'Name', 'SSN or TIN', 'Street', 'Line 2', 'City', 'State', 'ZIP',
  'Box 1 / 1a', 'Box 2', 'Box 3', 'Box 4', 'Box 5', 'Box 6', 'Box 12 TT', 'Box 15 state ID', 'Box 16', 'Box 17']);
function filingSheetCsv({ year, gaWithholdingId, w2s, necs }) {
  const d = (c) => (c == null ? '' : dollars(c));
  const addr = (a) => [a.line1, a.line2, a.city, a.state, `${a.zip || ''}${a.zip4 ? '-' + a.zip4 : ''}`];
  const rows = [
    ...w2s.map(w => ['W-2', year, w.name, formatTin(w.ssn, 'ssn'), ...addr(w.address || {}), d(w.boxes.box1), d(w.boxes.box2), d(w.boxes.box3), d(w.boxes.box4), d(w.boxes.box5), d(w.boxes.box6), d(w.boxes.box12TT), `GA ${gaWithholdingId || ''}`.trim(), d(w.boxes.box16), d(w.boxes.box17)]),
    ...necs.map(n => ['1099-NEC', year, n.name, formatTin(n.tin, n.tinType), ...addr(n.address || {}), d(n.boxes.box1a), '', '', d(n.boxes.box4 || 0), '', '', '', '', '', ''])
  ];
  return [FILING_SHEET_COLUMNS, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Georgia G-1003 (annual withholding reconciliation) totals, filed on GTC. */
function g1003Totals(w2s) {
  return {
    w2Count: w2s.length,
    gaWagesCents: w2s.reduce((a, w) => a + (w.boxes.box16 || 0), 0),
    gaWithheldCents: w2s.reduce((a, w) => a + (w.boxes.box17 || 0), 0),
    form1099WithGaWithholding: 0
  };
}

module.exports = {
  FORM, OMB, GA_FIPS, EFW2_LAYOUT_YEARS, IRIS_NEC_LAYOUT_YEARS, FILING_SHEET_COLUMNS, filingSheetCsv, E_DELIVERY_VERSION, E_DELIVERY_DISCLOSURE, YEAR_END_FIELDS, IRIS_NEC_COLUMNS,
  truncateTin, formatTin, parseAddress, normalizeYearEnd, employerMissing, fileMissing, normalizeTaxAddress,
  openRunsIn, unpaidRunsIn, efw2File, irisNecCsv, g1003Totals
};
