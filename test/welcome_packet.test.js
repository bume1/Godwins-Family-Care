// ============================================================================
// The caregiver welcome packet: the wizard, the import, and the two gates
// ============================================================================
// Ported from the printed packet at the owner's direction (2026-09). Three
// things here are worth more than the rest and are held hardest:
//
// 1. THE IMPORT NEVER GUESSES. Reading a returned PDF is exact when the fields
//    are still named (we generated them) and label-matched when they are not.
//    The label path fills TEXT and never CHOICES, because an option label
//    printed on a page is evidence the question is there, not evidence that box
//    was ticked. A wrongly inferred answer is worse than a blank one: blank
//    gets asked, wrong gets signed.
//
// 2. THE TWO GATES ARE DIFFERENT QUESTIONS. The packet opens the app; the
//    clearance opens scheduling. Collapsing them either locks a caregiver out
//    of the screen where they upload, or puts an uncleared one in a client's
//    home.
//
// 3. GATING NEVER REACHES WORK IN FLIGHT. Clock-out and the visit log are
//    ungated by design — care that was given gets documented and paid whatever
//    the paperwork says.
//
// House rule throughout: assert the behaviour, called the way the caller calls
// it. The route tests mount the shipped router and go over HTTP.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PDFDocument } = require('pdf-lib');

const wp = require('../welcomePacketRepository');
const gate = require('../caregiverOnboardingGate');
const packetPdf = require('../welcomePacketPdf');
const packetImport = require('../welcomePacketImport');
const config = require('../config');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CAREGIVER = { id: 'cg1', name: 'Ada Lovelace', email: 'ada@example.com', role: 'vendor', licenseLevel: 'cna' };
const OTHER_CG = { id: 'cg2', name: 'Grace Hopper', email: 'grace@example.com', role: 'vendor', licenseLevel: 'pca' };
const ADMIN = { id: 'ad1', name: 'GFC Admin', email: 'admin@example.com', role: 'admin' };

const PDF_BYTES = Buffer.from('%PDF-1.4\n%stub\n');

/** A profile with every required answer filled in. */
const completeProfile = (over = {}) => ({
  firstName: 'Ada', lastName: 'Lovelace', mobilePhone: '404-555-0111',
  email: 'ada@example.com', dateOfBirth: '1990-04-01',
  homeAddress: '42 Peachtree Rd NE, Atlanta', homeZip: '30339',
  maxCommute: '30', transportation: 'own_vehicle', licenseAndInsurance: 'both_current',
  willingToDriveClients: 'no',
  availability: { monday: ['morning'], tuesday: ['morning'] },
  hoursPerWeek: '30_40', earliestStartDate: '2026-10-01',
  yearsExperience: '3_7', careExperience: ['bathing', 'companionship'],
  liftingComfort: 'with_equipment',
  ownWords: 'I have looked after people at home for seven years and I like the quiet work.',
  references: [
    { name: 'Jane Doe', relationship: 'Supervisor', phone: '404-555-0122' },
    { name: 'John Roe', relationship: 'Client family', phone: '404-555-0133' }
  ],
  emergencyName: 'Mary Byron', emergencyRelationship: 'Sister', emergencyPhone: '404-555-0144',
  ...over
});

const acceptedDocsFor = (profile) =>
  wp.DOCUMENT_ITEMS
    .filter(d => d.upload && wp.itemRequired(d, profile))
    .map((d, i) => ({ id: `d${i}`, kind: d.kind, status: 'accepted', uploaded_at: '2026-09-10T00:00:00.000Z' }));

const officeAllDone = () => {
  const out = {};
  for (const kind of wp.OFFICE_ITEM_KINDS) out[kind] = { status: 'done', at: '2026-09-10T00:00:00.000Z' };
  return out;
};

// ===========================================================================
// The packet definition and the sanitizer
// ===========================================================================

test('the packet carries every section and every document item from the printed packet', () => {
  assert.strictEqual(wp.DOCUMENT_ITEMS.length, 23, 'the printed packet lists 23 items');
  const numbers = wp.DOCUMENT_ITEMS.map(d => d.item);
  assert.deepStrictEqual(numbers, numbers.slice().sort((a, b) => a - b), 'items stay in printed order');
  assert.deepStrictEqual([...new Set(numbers)].length, 23, 'no item number is used twice');
  // Every kind is unique, or two checklist rows would fight over one upload.
  const kinds = wp.DOCUMENT_ITEMS.map(d => d.kind);
  assert.strictEqual(new Set(kinds).size, kinds.length);
});

test('an answer the packet never offered is DROPPED and reported, not stored', () => {
  const { clean, dropped } = wp.sanitizePacket({
    firstName: 'Ada',
    salary: '100000',                 // no such question
    maxCommute: 'teleport',           // not one of the offered options
    careExperience: ['bathing', 'surgery']
  });
  assert.strictEqual(clean.firstName, 'Ada');
  assert.ok(!('salary' in clean), 'an unknown field is not stored');
  assert.ok(!('maxCommute' in clean), 'an option the packet never offered is not stored');
  assert.deepStrictEqual(clean.careExperience, ['bathing'], 'only offered options survive');
  assert.ok(dropped.includes('salary') && dropped.includes('maxCommute'),
    'what was refused is reported — a value that vanishes without a word is one they believe they gave us');
});

test('the grid keeps only real days and real blocks', () => {
  const { clean } = wp.sanitizePacket({
    availability: { monday: ['morning', 'lunchtime'], funday: ['morning'] }
  });
  assert.deepStrictEqual(clean.availability, { monday: ['morning'] });
});

test('missing required answers are named with the section they live in', () => {
  const missing = wp.missingProfileFields({ firstName: 'Ada' });
  const ids = missing.map(m => m.id);
  assert.ok(ids.includes('lastName'));
  assert.ok(ids.includes('references'), 'two references are required');
  assert.ok(ids.includes('emergencyName'));
  assert.ok(!ids.includes('firstName'));
  const lastName = missing.find(m => m.id === 'lastName');
  assert.strictEqual(lastName.section, 'about', 'the wizard needs to know WHICH step to send them back to');
  assert.strictEqual(wp.missingProfileFields(completeProfile()).length, 0);
});

test('a half-filled reference row does not count as a reference', () => {
  const profile = completeProfile({ references: [{ name: 'Jane Doe' }, {}] });
  assert.ok(wp.missingProfileFields(profile).some(m => m.id === 'references'));
});

// ===========================================================================
// The checklist
// ===========================================================================

test('the CNA certificate is asked for only when they said they hold one', () => {
  const item = wp.DOCUMENT_ITEMS.find(d => d.item === 14);
  assert.strictEqual(wp.itemRequired(item, { certifications: ['none_yet'] }), false);
  assert.strictEqual(wp.itemRequired(item, { certifications: ['cna'] }), true);
});

test("the driver's licence is asked for only when they will be driving clients", () => {
  const item = wp.DOCUMENT_ITEMS.find(d => d.item === 15);
  assert.strictEqual(wp.itemRequired(item, { willingToDriveClients: 'no' }), false);
  assert.strictEqual(wp.itemRequired(item, { willingToDriveClients: 'yes_my_car' }), true);
  assert.strictEqual(wp.itemRequired(item, { willingToDriveClients: 'clients_car_only' }), true);
});

test('a REJECTED upload reads as rejected, never as missing, and carries its reason', () => {
  // The difference is the whole point: a caregiver told a rejected document is
  // "missing" photographs the same page again.
  const checklist = wp.buildChecklist(completeProfile(), [
    { id: 'd1', kind: 'tb_test', status: 'rejected', review_note: 'The date is cut off.', uploaded_at: '2026-09-10T00:00:00.000Z' }
  ], {});
  const row = checklist.find(r => r.kind === 'tb_test');
  assert.strictEqual(row.status, 'rejected');
  assert.strictEqual(row.uploads[0].reviewNote, 'The date is cut off.');
});

test('an accepted upload completes its item; one still in review says so', () => {
  const checklist = wp.buildChecklist(completeProfile(), [
    { id: 'd1', kind: 'tb_test', status: 'accepted', uploaded_at: '2026-09-10T00:00:00.000Z' },
    { id: 'd2', kind: 'drug_screen', status: 'received', uploaded_at: '2026-09-10T00:00:00.000Z' }
  ], {});
  assert.strictEqual(checklist.find(r => r.kind === 'tb_test').status, 'complete');
  assert.strictEqual(checklist.find(r => r.kind === 'drug_screen').status, 'in_review');
});

test('the emergency contact is satisfied by the profile, never by a file', () => {
  const item = wp.DOCUMENT_ITEMS.find(d => d.item === 5);
  assert.strictEqual(item.upload, false, 'item 5 is data, not a document');
  const withIt = wp.buildChecklist(completeProfile(), [], {}).find(r => r.kind === 'emergency_contact');
  const without = wp.buildChecklist(completeProfile({ emergencyPhone: '' }), [], {}).find(r => r.kind === 'emergency_contact');
  assert.strictEqual(withIt.status, 'complete');
  assert.strictEqual(without.status, 'missing');
});

test('an office item is tracked by status and cannot be uploaded past', () => {
  for (const kind of wp.OFFICE_ITEM_KINDS) {
    const item = wp.DOCUMENT_ITEMS.find(d => d.kind === kind);
    assert.strictEqual(item.upload, false, `${kind} takes no upload — the caregiver cannot do it`);
  }
  const scheduled = wp.buildChecklist(completeProfile(), [], { fingerprinting: { status: 'scheduled' } });
  assert.strictEqual(scheduled.find(r => r.kind === 'fingerprinting').status, 'in_progress');
  const done = wp.buildChecklist(completeProfile(), [], { fingerprinting: { status: 'done' } });
  assert.strictEqual(done.find(r => r.kind === 'fingerprinting').status, 'complete');
});

test('the Gusto group points at Gusto and does not say we will email them', () => {
  // OWNER CHANGE: the printed packet said "You do not need to find these. We
  // email them and you sign and return." They live in Gusto now, and somebody
  // told to wait for an email would wait forever.
  const intro = wp.GROUP_INTROS.E;
  assert.match(intro, /Gusto/);
  assert.doesNotMatch(intro, /do not need to find these/i);
  assert.doesNotMatch(intro, /we email them/i);
  // And it says plainly that the two do not talk to each other.
  assert.match(intro, /does not file it in Gusto|does not send it here/i);
  const gustoItems = wp.DOCUMENT_ITEMS.filter(d => d.group === 'E');
  assert.strictEqual(gustoItems.length, 5, 'items 16-20');
  for (const item of gustoItems) {
    assert.strictEqual(item.source, 'gusto');
    assert.strictEqual(item.upload, true, 'each signed copy comes back here one by one');
  }
});

// ===========================================================================
// The two gates
// ===========================================================================

test('the app is shut until the packet is signed, and the two shut states differ', () => {
  const never = gate.appAccessEligibility(null);
  assert.strictEqual(never.allowed, false);
  assert.strictEqual(never.code, 'WELCOME_PACKET_REQUIRED');

  const started = gate.appAccessEligibility({ status: 'in_progress' });
  assert.strictEqual(started.allowed, false);
  assert.strictEqual(started.code, 'WELCOME_PACKET_INCOMPLETE',
    'an invitation and a resumption are different sentences to read on a phone');

  assert.strictEqual(gate.appAccessEligibility({ status: 'submitted' }).allowed, true);
});

test('clearance needs the documents too, and names who each item waits on', () => {
  const profile = completeProfile();
  const packet = { status: 'submitted', data: profile };

  const nothing = gate.shiftClearanceEligibility(CAREGIVER, packet, wp.buildChecklist(profile, [], {}));
  assert.strictEqual(nothing.allowed, false);
  assert.strictEqual(nothing.code, 'CAREGIVER_NOT_CLEARED');
  assert.ok(nothing.outstanding.some(o => o.waitingOn === 'you'));
  assert.ok(nothing.outstanding.some(o => o.waitingOn === 'us'),
    'a caregiver staring at one list has to be able to tell which half is theirs');

  const all = wp.buildChecklist(profile, acceptedDocsFor(profile), officeAllDone());
  assert.strictEqual(gate.shiftClearanceEligibility(CAREGIVER, packet, all).allowed, true);
});

test('an OPTIONAL item left undone does not block clearance', () => {
  const profile = completeProfile();
  const packet = { status: 'submitted', data: profile };
  const optional = wp.DOCUMENT_ITEMS.find(d => d.item === 11);   // immunization record
  assert.strictEqual(wp.itemRequired(optional, profile), false);
  const checklist = wp.buildChecklist(profile, acceptedDocsFor(profile), officeAllDone());
  assert.strictEqual(checklist.find(r => r.kind === 'immunization_record').status, 'missing');
  assert.strictEqual(gate.shiftClearanceEligibility(CAREGIVER, packet, checklist).allowed, true);
});

test('an unsigned packet blocks scheduling with its own code, not the checklist one', () => {
  const result = gate.shiftClearanceEligibility(CAREGIVER, { status: 'in_progress' }, []);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.code, 'CAREGIVER_PACKET_INCOMPLETE');
});

test('the clearance override is admin-only, needs a reason, and freezes what it overrode', () => {
  const profile = completeProfile();
  const packet = { status: 'submitted', data: profile };
  const checklist = wp.buildChecklist(profile, [], {});

  const caregiverTry = gate.checkClearanceAllowed(CAREGIVER, packet, checklist, { override: true }, CAREGIVER, false);
  assert.strictEqual(caregiverTry.ok, false);
  assert.strictEqual(caregiverTry.status, 403);
  assert.strictEqual(caregiverTry.code, 'OVERRIDE_ADMIN_ONLY');

  const noReason = gate.checkClearanceAllowed(CAREGIVER, packet, checklist, { override: true }, ADMIN, true);
  assert.strictEqual(noReason.ok, false);
  assert.strictEqual(noReason.status, 400);
  assert.strictEqual(noReason.code, 'OVERRIDE_REASON_REQUIRED',
    'a permission answer and a completeness answer are different facts');

  const applied = gate.checkClearanceAllowed(CAREGIVER, packet, checklist,
    { override: true, overrideReason: 'Client needs cover tonight; TB result is in hand on paper.' }, ADMIN, true);
  assert.strictEqual(applied.ok, true);
  assert.match(applied.override.reason, /Client needs cover tonight/);
  assert.strictEqual(applied.override.byName, 'GFC Admin');
  assert.strictEqual(applied.override.code, 'CAREGIVER_NOT_CLEARED');
  assert.ok(applied.override.outstanding.length > 0,
    'WHAT was overridden is frozen — recomputing it later erases the override the moment the document lands');

  const plain = gate.checkClearanceAllowed(CAREGIVER, packet, checklist, {}, ADMIN, true);
  assert.strictEqual(plain.ok, false);
  assert.strictEqual(plain.status, 409);
  assert.strictEqual(plain.overridable, true, 'the board offers the override rather than hiding it');
});

// ===========================================================================
// The PDF, and reading one back
// ===========================================================================

test('the fillable packet carries a named field for every question it asks', async () => {
  const bytes = await packetPdf.generateFillableWelcomePacketPDF({});
  const pdf = await PDFDocument.load(bytes);
  const names = new Set(pdf.getForm().getFields().map(f => f.getName()));

  for (const section of wp.PACKET_SECTIONS) {
    for (const field of section.fields) {
      if (field.type === 'multi') {
        for (const o of field.options) {
          assert.ok(names.has(packetPdf.optionName(field.id, o.value)), `${field.id}.${o.value} is on the PDF`);
        }
      } else if (field.type === 'grid') {
        assert.ok(names.has(packetPdf.gridName(field.id, field.rows[0].value, field.columns[0].value)));
      } else if (field.type === 'rows') {
        assert.ok(names.has(packetPdf.rowFieldName(field.id, 0, field.rowFields[0].id)));
      } else {
        assert.ok(names.has(packetPdf.fieldName(field.id)), `${field.id} is on the PDF`);
      }
    }
  }
});

test('a returned packet reads back EXACTLY — every answer type, by name', async () => {
  const blank = await packetPdf.generateFillableWelcomePacketPDF({});
  const pdf = await PDFDocument.load(blank);
  const form = pdf.getForm();
  form.getTextField('gfc.firstName').setText('Ada');
  form.getTextField('gfc.homeZip').setText('30339');
  form.getRadioGroup('gfc.maxCommute').select('45');
  form.getCheckBox('gfc.certifications.cna').check();
  form.getCheckBox('gfc.certifications.hha').check();
  form.getCheckBox('gfc.availability.tuesday.evening').check();
  form.getTextField('gfc.references.1.name').setText('John Roe');

  const result = await packetImport.extractPacket(Buffer.from(await pdf.save()));
  assert.strictEqual(result.source, 'form');
  assert.strictEqual(result.needsConfirmation, false, 'read by name, not interpreted');
  assert.strictEqual(result.values.firstName, 'Ada');
  assert.strictEqual(result.values.homeZip, '30339');
  assert.strictEqual(result.values.maxCommute, '45');
  assert.deepStrictEqual(result.values.certifications, ['cna', 'hha']);
  assert.deepStrictEqual(result.values.availability, { tuesday: ['evening'] });
  assert.strictEqual(result.values.references[1].name, 'John Roe');
  assert.strictEqual(result.packetVersion, wp.PACKET_VERSION,
    'the version travels inside the document, so an import knows which questions were answered');
});

test('an import is held to the same rules a typed answer is', async () => {
  // A PDF is a file somebody sent us. It does not get to write a value the
  // form itself would refuse.
  const blank = await packetPdf.generateFillableWelcomePacketPDF({});
  const pdf = await PDFDocument.load(blank);
  const form = pdf.getForm();
  form.getTextField('gfc.firstName').setText('x'.repeat(400));
  const result = await packetImport.extractPacket(Buffer.from(await pdf.save()));
  assert.ok(result.values.firstName.length <= 80, 'the sanitizer runs on imported values too');
});

test("someone else's form is not read as a packet", async () => {
  // A PDF can carry a form and have nothing to do with us. Reading one field
  // name that happens to collide would seed a profile from a lease.
  const other = await PDFDocument.create();
  other.addPage();
  other.getForm().createTextField('firstName').addToPage(other.getPages()[0], { x: 10, y: 10, width: 80, height: 12 });
  const result = await packetImport.extractPacket(Buffer.from(await other.save()));
  assert.notStrictEqual(result.source, 'form');
  assert.deepStrictEqual(result.values, {});
});

test('a FLATTENED packet is read by label — text only, and never a tick box', async () => {
  const blank = await packetPdf.generateFillableWelcomePacketPDF({});
  const pdf = await PDFDocument.load(blank);
  const form = pdf.getForm();
  form.getTextField('gfc.firstName').setText('Ada');
  form.getTextField('gfc.lastName').setText('Lovelace');
  form.getTextField('gfc.homeZip').setText('30339');
  form.getRadioGroup('gfc.maxCommute').select('45');
  form.getCheckBox('gfc.certifications.cna').check();
  form.flatten();

  const result = await packetImport.extractPacket(Buffer.from(await pdf.save()));
  assert.strictEqual(result.source, 'text');
  assert.strictEqual(result.needsConfirmation, true, 'matched off the page, so it wants checking');
  assert.strictEqual(result.values.firstName, 'Ada');
  assert.strictEqual(result.values.lastName, 'Lovelace');
  assert.strictEqual(result.values.homeZip, '30339');

  // THE ONE THAT MATTERS. "45 min" is printed on the page next to every other
  // option, so reading it proves the QUESTION is there, never which box was
  // ticked. A wrongly inferred answer gets signed; a blank one gets asked.
  assert.strictEqual(result.values.maxCommute, undefined);
  assert.strictEqual(result.values.certifications, undefined);
});

test('the label reader never mistakes the form\'s own furniture for an answer', async () => {
  // The blank printed packet: every label and every option is on the page and
  // not one answer. Anything at all coming back would be an invention.
  const template = path.join(__dirname, 'fixtures', 'welcome_packet_blank.pdf');
  const bytes = fs.existsSync(template)
    ? fs.readFileSync(template)
    : await (async () => {
      const b = await packetPdf.generateFillableWelcomePacketPDF({});
      const d = await PDFDocument.load(b);
      d.getForm().flatten();
      return Buffer.from(await d.save());
    })();
  const result = await packetImport.extractPacket(bytes);
  assert.deepStrictEqual(result.values, {}, 'a blank packet yields nothing');
  assert.strictEqual(result.source, 'none');
  assert.match(result.reason, /fill the form in here/,
    'and it says what to do rather than reporting an empty read as a successful one');
});

test('an unreadable file says WHICH kind of unreadable it is', async () => {
  const notPdf = await packetImport.extractPacket(Buffer.from('this is not a pdf'));
  assert.strictEqual(notPdf.source, 'none');
  assert.match(notPdf.reason, /could not be opened as a PDF/);

  const imageOnly = await PDFDocument.create();
  imageOnly.addPage();
  const scan = await packetImport.extractPacket(Buffer.from(await imageOnly.save()));
  assert.strictEqual(scan.source, 'none');
  assert.match(scan.reason, /scan or a photo/,
    '"we cannot read this kind of file" and "your packet was empty" are different facts');
});

test('the signed copy carries the answers, the signature and the checklist', async () => {
  const profile = completeProfile();
  const bytes = await packetPdf.generateSignedWelcomePacketPDF({
    version: wp.PACKET_VERSION,
    data: profile,
    printed_name: 'Ada Lovelace',
    signed_at: '2026-09-13T12:00:00.000Z',
    signer_ip_hash: 'abcdef0123456789',
    signature_png: null
  }, CAREGIVER, wp.buildChecklist(profile, [], {}));
  assert.ok(bytes.length > 1000);
  const pdf = await PDFDocument.load(bytes);
  assert.strictEqual(pdf.getForm().getFields().length, 0,
    'a signed record is flat — a correction is a new signature, not a retype');
  const text = (await packetImport.extractLines(pdf)).join(' ');
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /42 Peachtree/);
});

test('a name the PDF font cannot write does not take the document down', () => {
  // The narrow no-break space that 500'd every document download, one layer
  // over: pdf-lib writes WinAnsi and THROWS on anything outside it, so a name
  // it cannot encode would be a 500 on a document somebody is waiting for.
  // Nguy\u1EC5n is the case that matters — \u1EC5 is outside latin-1 altogether, so the
  // fold map cannot rescue it and the final filter has to.
  const profile = completeProfile({
    firstName: 'Nguy\u1EC5n', lastName: '\u0110\u1ED7', preferredName: 'Jos\u202Fe \u2014 "Joe"',
    homeAddress: '12 \u0110\u01B0\u1EDDng L\u00E1ng \u00B7 \u5317\u4EAC\u8DEF'
  });
  return (async () => {
    const bytes = await packetPdf.generateSignedWelcomePacketPDF(
      { version: wp.PACKET_VERSION, data: profile, printed_name: 'Nguy\u1EC5n', signed_at: '2026-09-13T12:00:00.000Z' },
      CAREGIVER, wp.buildChecklist(profile, [], {}));
    assert.ok(bytes.length > 1000);
    // And the fillable one, which seeds the same values into form fields.
    const fillable = await packetPdf.generateFillableWelcomePacketPDF(profile);
    assert.ok(fillable.length > 1000);
  })();
});

test('a repeated line is never read as an answer', () => {
  // An answer appears once; the form's own furniture repeats. This is what
  // catches a running header or a page number that is not in the packet's own
  // string list and so slips past the first filter.
  const runs = [
    { text: 'Weekly Roster', x: 48, y: 20, size: 9, page: 0 },
    { text: 'Home ZIP code', x: 48, y: 60, size: 9, page: 0 },
    { text: 'Weekly Roster', x: 48, y: 76, size: 9, page: 0 },
    { text: 'Preferred name', x: 48, y: 200, size: 9, page: 0 },
    { text: 'Addie', x: 48, y: 216, size: 9, page: 0 }
  ];
  const { values } = packetImport.matchLabels(runs);
  assert.strictEqual(values.homeZip, undefined,
    'a line that appears twice on the page is chrome, not somebody\'s ZIP code');
  assert.strictEqual(values.preferredName, 'Addie', 'a line that appears once still reads');
});

// ===========================================================================
// The routes
// ===========================================================================

const fakeDrive = (opts = {}) => {
  const files = new Map();
  return {
    uploaded: [],
    async uploadCaregiverDocumentFile(caregiverName, fileName, buf, mime) {
      if (opts.fail) throw new Error('unauthorized_client');
      const id = `drv_${files.size + 1}`;
      files.set(id, buf);
      this.uploaded.push({ caregiverName, fileName, mime, bytes: buf.length });
      return { fileId: id, fileName, webViewLink: `https://drive/${id}` };
    },
    async downloadFileBuffer(id) { return files.get(id); },
    describeDriveError: (e) => ({ reason: e.message, hint: null })
  };
};

const detectFileType = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  return null;
};

const mount = async (t, { as = CAREGIVER, users = [CAREGIVER, OTHER_CG, ADMIN], store = {}, driveStub = fakeDrive() } = {}) => {
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const activity = [];
  const notifications = [];
  const router = require('../routes/welcomePacket')({
    db, config,
    logActivity: async (...a) => { activity.push(a); },
    queueNotification: async (n) => { notifications.push(n); },
    getUsers: async () => users,
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => 'x',
    drive: driveStub,
    detectFileType,
    hashIp: () => 'hashed-ip'
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  const call = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return {
    store, activity, notifications, drive: driveStub, call,
    get: (p) => call(p),
    send: (p, body, method = 'POST') => call(p, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
  };
};

test('the questions are SERVED, and a draft merges rather than replaces', async (t) => {
  const h = await mount(t);
  const first = await (await h.get('/api/caregiver/welcome-packet')).json();
  assert.strictEqual(first.sections.length, wp.PACKET_SECTIONS.length);
  assert.strictEqual(first.status, 'not_started');
  assert.ok(first.checklist.length === 23);

  await h.send('/api/caregiver/welcome-packet', { data: { firstName: 'Ada' } }, 'PUT');
  const second = await (await h.send('/api/caregiver/welcome-packet', { data: { lastName: 'Lovelace' } }, 'PUT')).json();
  assert.strictEqual(second.data.firstName, 'Ada',
    'the wizard saves a step at a time — a replacing save would wipe the other eight sections');
  assert.strictEqual(second.data.lastName, 'Lovelace');
  assert.strictEqual(h.store.welcome_packets[0].status, 'in_progress');
});

test('signing is refused while an answer is missing, and no signature is taken', async (t) => {
  // Completeness is checked BEFORE the signature. Refusing afterwards would
  // have somebody sign a document we then told them was not finished.
  const h = await mount(t);
  // The wizard saved its steps on the way here, so there is a real draft.
  await h.send('/api/caregiver/welcome-packet', { data: { firstName: 'Ada' } }, 'PUT');

  const res = await h.send('/api/caregiver/welcome-packet/submit', {
    data: { lastName: 'Lovelace' },
    signaturePng: 'data:image/png;base64,aGVsbG8=',
    printedName: 'Ada Lovelace'
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.code, 'PACKET_INCOMPLETE');
  assert.ok(body.missing.length > 0);
  assert.ok(body.missing[0].section, 'each gap names its step, so the wizard can go back to it');

  const row = h.store.welcome_packets[0];
  assert.strictEqual(row.status, 'in_progress');
  assert.strictEqual(row.signature_png, null, 'no signature was taken on a refused submit');
  assert.strictEqual(row.signed_at, null);
});

test('submitting cannot smuggle in an answer the packet never offered', async (t) => {
  // The submit route takes a final `data` payload, and it is held to exactly
  // the rules every other write is. A value no question produced is one nobody
  // can read back, and on a matching profile it would steer placements off an
  // answer nobody chose.
  const h = await mount(t);
  // The wizard saved the real answers on the way here.
  await h.send('/api/caregiver/welcome-packet', { data: completeProfile() }, 'PUT');
  const res = await h.send('/api/caregiver/welcome-packet/submit', {
    data: { salary: '100000', maxCommute: 'teleport' },
    signaturePng: 'data:image/png;base64,aGVsbG8=',
    printedName: 'Ada Lovelace'
  });
  assert.strictEqual(res.status, 200);
  const row = h.store.welcome_packets[0];
  assert.ok(!('salary' in row.data), 'an unknown field never reaches the stored packet');
  assert.strictEqual(row.data.maxCommute, '30',
    'and an invalid option is refused rather than overwriting the answer they actually gave');
});

test('a packet cannot be signed without a signature or a printed name', async (t) => {
  const h = await mount(t);
  const noSig = await h.send('/api/caregiver/welcome-packet/submit',
    { data: completeProfile(), printedName: 'Ada' });
  assert.strictEqual((await noSig.json()).code, 'SIGNATURE_REQUIRED');

  const noName = await h.send('/api/caregiver/welcome-packet/submit',
    { data: completeProfile(), signaturePng: 'data:image/png;base64,aGVsbG8=' });
  assert.strictEqual((await noName.json()).code, 'PRINTED_NAME_REQUIRED');
});

test('a signed packet opens the app, and cannot then be edited', async (t) => {
  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/submit', {
    data: completeProfile(),
    signaturePng: 'data:image/png;base64,aGVsbG8=',
    printedName: 'Ada Lovelace'
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.submitted, true);
  assert.strictEqual(body.onboarding.appAccess, true);
  assert.strictEqual(body.onboarding.cleared, false, 'the app opens; the shift board does not');

  const row = h.store.welcome_packets[0];
  assert.strictEqual(row.status, 'submitted');
  assert.strictEqual(row.signer_ip_hash, 'hashed-ip');
  assert.ok(row.signed_at);

  const edit = await h.send('/api/caregiver/welcome-packet', { data: { firstName: 'Someone' } }, 'PUT');
  assert.strictEqual(edit.status, 409);
  assert.strictEqual((await edit.json()).code, 'PACKET_SIGNED',
    'a correction after signing is a new signature on a changed document');

  assert.ok(h.notifications.some(n => n.type === 'caregiver_packet_submitted'),
    'the office is told, and through the queue so an unsubscribe is honoured');
});

test('importing a packet stores the file FIRST and prefills what it could read', async (t) => {
  const blank = await packetPdf.generateFillableWelcomePacketPDF({});
  const pdf = await PDFDocument.load(blank);
  pdf.getForm().getTextField('gfc.firstName').setText('Ada');
  pdf.getForm().getTextField('gfc.homeZip').setText('30339');
  const filled = Buffer.from(await pdf.save());

  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/import', {
    fileName: 'my packet.pdf', fileDataB64: filled.toString('base64')
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.source, 'form');
  assert.strictEqual(body.data.firstName, 'Ada');
  assert.ok(body.missing.length > 0, 'and it says what is still needed');

  // The file they actually sent is the record, whatever the read produced.
  assert.strictEqual(h.store.caregiver_documents.length, 1);
  assert.strictEqual(h.store.caregiver_documents[0].kind, 'welcome_packet');
  assert.strictEqual(h.drive.uploaded.length, 1);
  assert.strictEqual(h.store.welcome_packets[0].import_source, 'form');
});

test('an import never overwrites an answer already typed into the app', async (t) => {
  const blank = await packetPdf.generateFillableWelcomePacketPDF({});
  const pdf = await PDFDocument.load(blank);
  pdf.getForm().getTextField('gfc.mobilePhone').setText('404-555-0000');
  const filled = Buffer.from(await pdf.save());

  const h = await mount(t);
  await h.send('/api/caregiver/welcome-packet', { data: { mobilePhone: '404-555-9999' } }, 'PUT');
  const body = await (await h.send('/api/caregiver/welcome-packet/import', {
    fileName: 'p.pdf', fileDataB64: filled.toString('base64')
  })).json();
  assert.strictEqual(body.data.mobilePhone, '404-555-9999',
    'they were sitting in front of this screen; the PDF was filled some other time');
});

test('a Drive failure refuses the import and records nothing', async (t) => {
  const h = await mount(t, { driveStub: fakeDrive({ fail: true }) });
  const res = await h.send('/api/caregiver/welcome-packet/import', {
    fileName: 'p.pdf', fileDataB64: PDF_BYTES.toString('base64')
  });
  assert.strictEqual(res.status, 502);
  assert.strictEqual((await res.json()).code, 'DOCUMENT_STORAGE_UNAVAILABLE');
  assert.ok(!h.store.caregiver_documents || h.store.caregiver_documents.length === 0);
});

test('a file is typed by its bytes, never by what the caller claimed', async (t) => {
  const h = await mount(t);
  const res = await h.send('/api/caregiver/welcome-packet/import', {
    fileName: 'packet.pdf', fileDataB64: Buffer.from('MZ not a pdf at all').toString('base64')
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'DOC_TYPE_REJECTED');
});

test('a caregiver cannot read another caregiver\'s signed packet', async (t) => {
  const store = {
    welcome_packets: [{
      caregiver_id: 'cg2', status: 'submitted', version: wp.PACKET_VERSION,
      data: completeProfile(), printed_name: 'Grace Hopper', signed_at: '2026-09-13T00:00:00.000Z', office: {}
    }]
  };
  const asCaregiver = await mount(t, { as: CAREGIVER, store });
  const mine = await asCaregiver.get('/api/caregiver/welcome-packet/signed.pdf?caregiverId=cg2');
  assert.strictEqual(mine.status, 404,
    'the filter is admin-only — passing someone else\'s id still reads your own');

  const asAdmin = await mount(t, { as: ADMIN, store });
  const theirs = await asAdmin.get('/api/caregiver/welcome-packet/signed.pdf?caregiverId=cg2');
  assert.strictEqual(theirs.status, 200);
  assert.strictEqual(theirs.headers.get('content-type'), 'application/pdf');
});

test('only an admin sets an office item, and only a real one', async (t) => {
  const asCaregiver = await mount(t, { as: CAREGIVER });
  const refused = await asCaregiver.send('/api/caregiver/admin/welcome-packets/cg1/office-item',
    { kind: 'orientation', status: 'done' }, 'PUT');
  assert.strictEqual(refused.status, 403);

  const h = await mount(t, { as: ADMIN });
  const bogus = await h.send('/api/caregiver/admin/welcome-packets/cg1/office-item',
    { kind: 'tb_test', status: 'done' }, 'PUT');
  assert.strictEqual(bogus.status, 400);
  assert.strictEqual((await bogus.json()).code, 'OFFICE_ITEM_UNKNOWN',
    'a caregiver-supplied document is not an office item and cannot be ticked from here');

  const ok = await h.send('/api/caregiver/admin/welcome-packets/cg1/office-item',
    { kind: 'orientation', status: 'done', note: 'Attended 09/12' }, 'PUT');
  assert.strictEqual(ok.status, 200);
  const row = h.store.welcome_packets[0];
  assert.strictEqual(row.office.orientation.status, 'done');
  assert.strictEqual(row.office.orientation.byName, 'GFC Admin', 'who ticked it is part of the record');
});

test('the admin queue reports counts, never the answers', async (t) => {
  const h = await mount(t, {
    as: ADMIN,
    store: {
      welcome_packets: [{ caregiver_id: 'cg1', status: 'submitted', data: completeProfile(), office: {} }]
    }
  });
  const body = await (await h.get('/api/caregiver/admin/welcome-packets')).json();
  const row = body.caregivers.find(c => c.caregiverId === 'cg1');
  assert.strictEqual(row.appAccess, true);
  assert.strictEqual(typeof row.outstandingCount, 'number');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('1990-04-01'), 'a queue is a glance — a date of birth has no business on one');
  assert.ok(!serialized.includes('42 Peachtree'), 'nor a home address');
});

// ===========================================================================
// Build enforcement — the rules a later session would undo without noticing
// ===========================================================================

test('the caregiver page names no question of its own', () => {
  const page = read('public/caregiver.html');
  // The page renders whatever the server serves. If it starts hardcoding
  // section titles or option values it will drift from the validator that
  // refuses an answer they did not offer, and the drift is silent.
  for (const section of wp.PACKET_SECTIONS) {
    assert.ok(!page.includes(`'${section.title}'`) && !page.includes(`"${section.title}"`),
      `caregiver.html must not name the section "${section.title}"`);
  }
  const options = wp.PACKET_SECTIONS
    .flatMap(s => s.fields)
    .flatMap(f => (f.options || []).map(o => o.value))
    .filter(v => v.length > 5);
  for (const value of options) {
    assert.ok(!page.includes(`'${value}'`), `caregiver.html must not name the option "${value}"`);
  }
});

test('no screen may imply that uploading here files anything in Gusto', () => {
  // GUSTO IS THE SYSTEM OF RECORD and nothing here transmits to it. A screen
  // that stays quiet about that lets someone believe their handbook signature
  // was filed because they uploaded a copy.
  const page = read('public/caregiver.html');
  assert.ok(!/send (it |them )?to Gusto|files? (it|them) (in|to) Gusto|sync(ed)? (with|to) Gusto/i.test(page),
    'the app does not transmit to Gusto and must not say it does');
  assert.match(wp.GROUP_INTROS.E, /Uploading here does not file it in Gusto/i);
});

/** The caregiver router, mounted the way server.js mounts it. */
const mountCaregiverApp = async (t, { as = CAREGIVER, store = {} } = {}) => {
  const db = { get: async (k) => store[k] || null, set: async (k, v) => { store[k] = v; } };
  const router = require('../routes/caregiver')({
    db, config,
    logActivity: async () => {},
    queueNotification: async () => {},
    getUsers: async () => [CAREGIVER, OTHER_CG, ADMIN],
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => 'x',
    drive: fakeDrive(),
    detectFileType
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  return { store, call: (p) => fetch(`http://127.0.0.1:${port}${p}`) };
};

test('THE GATE ACTUALLY FIRES — an unsigned packet closes the app for real', async (t) => {
  // The source check below holds the wiring; this holds the behaviour. A
  // middleware that is present and does nothing reads identically in a grep.
  const shut = await mountCaregiverApp(t);
  const refused = await shut.call('/api/caregiver/clients');
  assert.strictEqual(refused.status, 403);
  assert.strictEqual((await refused.json()).code, 'WELCOME_PACKET_REQUIRED');

  // And /me stays open, because the shell reads it to know to show the wizard.
  const me = await shut.call('/api/caregiver/me');
  assert.strictEqual(me.status, 200);
  const body = await me.json();
  assert.strictEqual(body.onboarding.appAccess, false);
  assert.strictEqual(body.checklist.length, 23, 'and it carries the checklist the wizard renders');

  const open = await mountCaregiverApp(t, {
    store: {
      welcome_packets: [{ caregiver_id: 'cg1', status: 'submitted', data: completeProfile(), office: {} }]
    }
  });
  assert.strictEqual((await open.call('/api/caregiver/clients')).status, 200);
  const openMe = await (await open.call('/api/caregiver/me')).json();
  assert.strictEqual(openMe.onboarding.appAccess, true);
  assert.strictEqual(openMe.onboarding.cleared, false,
    'the app opens on their half of the packet; the shift board waits on the clearances');
});

test('the welcome packet gate is enforced at the API, not only on the screen', () => {
  const src = read('routes/caregiver.js');
  for (const route of ['/api/caregiver/clients', '/api/caregiver/feed', '/api/caregiver/visit-log/schema']) {
    const line = src.split('\n').find(l => l.includes(`'${route}'`) && l.includes('router.'));
    assert.ok(line && line.includes('requireOnboarded'), `${route} is behind the packet gate`);
  }
});

test('WORK IN FLIGHT IS NEVER GATED', () => {
  // Care that was given gets documented and paid whatever the paperwork says.
  // Refusing the record would lose the visit and the caregiver's pay without
  // un-giving the care.
  const caregiverSrc = read('routes/caregiver.js');
  const submitLine = caregiverSrc.split('\n').find(l => l.includes("router.post('/api/caregiver/visit-logs'"));
  assert.ok(submitLine && !submitLine.includes('requireOnboarded'),
    'filing a visit log for a visit that happened is never gated');

  const docLine = caregiverSrc.split('\n').find(l => l.includes("router.post('/api/caregiver/documents'"));
  assert.ok(docLine && !docLine.includes('requireOnboarded'),
    'uploading is how the checklist gets done — gating it locks them out of the screen they were sent to');

  const schedulingSrc = read('routes/scheduling.js');
  for (const route of ['clock-in', 'clock-out']) {
    const block = schedulingSrc.slice(schedulingSrc.indexOf(`/${route}'`));
    const upToHandlerEnd = block.slice(0, block.indexOf('res.json'));
    assert.ok(!upToHandlerEnd.includes('checkCaregiverCleared'),
      `${route} must not check clearance — a shift underway is finished, not re-authorised`);
  }
});

test('committing a caregiver to a shift checks their clearance BEFORE the write', () => {
  const src = read('routes/scheduling.js');
  for (const route of ['claim', 'assign']) {
    const start = src.indexOf(`/api/scheduling/shifts/:id/${route}'`);
    assert.ok(start > 0, `${route} route exists`);
    const body = src.slice(start, src.indexOf('router.', start + 50));
    const gateAt = body.indexOf('checkCaregiverCleared');
    const writeAt = body.indexOf("db.set('shifts'");
    assert.ok(gateAt > 0, `${route} checks clearance`);
    assert.ok(writeAt > gateAt, `${route} checks before it writes — a refused commit leaves nothing behind`);
  }
});

test('an override that is stored is also shown', () => {
  // An override that lives only in the store is barely better than a silent
  // one — the defect the enrollment gate shipped with and had to fix.
  const src = read('routes/scheduling.js');
  assert.match(src, /clearanceOverride: r\.clearance_override/,
    'the shift projection carries the override so the board can say it');
  assert.match(src, /rows\[idx\]\.clearance_override = cleared\.override/,
    'and the row it created carries it');
});

test('the packet vocabulary lives in ONE module', () => {
  // The wizard, the validator, the PDF writer and the importer all read one
  // definition. A second copy is how a question stops matching its answer.
  const pdfSrc = read('welcomePacketPdf.js');
  const importSrc = read('welcomePacketImport.js');
  const routeSrc = read('routes/welcomePacket.js');
  for (const [name, src] of [['welcomePacketPdf.js', pdfSrc], ['welcomePacketImport.js', importSrc], ['routes/welcomePacket.js', routeSrc]]) {
    assert.match(src, /require\('\.\.?\/?welcomePacketRepository'\)/, `${name} reads the one definition`);
  }
  // And the importer does not restate the PDF's field-naming convention.
  assert.match(importSrc, /require\('\.\/welcomePacketPdf'\)/,
    'two copies of a naming rule is how a packet stops importing after a rename');
  assert.ok(!/['"]gfc\.\w/.test(importSrc.replace(/^.*welcomePacketPdf.*$/gm, '')),
    'the importer builds field names through the shared helpers, never by hand');
});

test('the caregiver document catalog carries the packet items exactly once', () => {
  const src = read('routes/caregiver.js');
  assert.match(src, /wp\.PACKET_DOCUMENT_KINDS/, 'the kinds come from the packet, not a second list');
  // `id_document` and `certification` already existed. Two buckets for one
  // document is how the office chases a file it already has.
  const duplicated = wp.PACKET_DOCUMENT_KINDS.filter(k => ['id_document', 'certification'].includes(k.kind));
  assert.strictEqual(duplicated.length, 2, 'the packet does name them');
  assert.match(src, /!BASE_DOC_KINDS\.some\(b => b\.kind === k\.kind\)/,
    'and the catalog de-duplicates rather than listing them twice');
});
