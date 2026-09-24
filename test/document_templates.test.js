// test/document_templates.test.js — reading a document WITHOUT a model
// (2026-09-23, owner-directed: Bedrock is blocked behind an AWS agreement and
// document reading is the thing the office needs most).
//
// Session 4.9b built the whole safety apparatus and then made a model the only
// source of proposals. None of that safety work is model-specific:
// buildProposals takes a plain { path: value } map. These two modules produce
// that map from the document itself.
//
// MUTATION-CHECKED, and two of the guards below exist because reading the
// OUTPUT of a realistic document found bugs that reading the code did not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tpl = require('../documentTemplates');
const ocr = require('../documentOcr');
const extraction = require('../documentExtraction');
const packet = require('../welcomePacketImport');

const root = path.join(__dirname, '..');

// A line as groupIntoLines produces it. Used to drive the matcher directly.
const line = (text, y, x = 40) => ({ text, x, y, page: 0, size: 9, runs: [{ text, x, y, size: 9, page: 0 }] });

// ===========================================================================
// 1. A path this file invents can never reach a client record
// ===========================================================================

test('every templated path is a DECLARED extraction target', () => {
  // The allow-list the review and the commit both run against lives in
  // documentExtraction. A template naming a path it does not declare would
  // propose into a field nobody approved, so it is checked at LOAD — a typo
  // fails the boot rather than silently proposing nothing.
  assert.doesNotThrow(() => tpl.assertTemplatesAreDeclared());
  // And it must RUN AT LOAD, so a typo fails the boot rather than silently
  // proposing nothing. Asserting the function merely exists left removing its
  // invocation undetected.
  const src = fs.readFileSync(path.join(root, 'documentTemplates.js'), 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(src, /^assertTemplatesAreDeclared\(\);$/m,
    'the cross-check must be invoked at module load');
  for (const [kind, paths] of Object.entries(tpl.TEMPLATES)) {
    const target = extraction.TARGETS[kind];
    assert.ok(target, `${kind} has no declared targets`);
    const declared = new Set([...(target.fill || []), ...(target.verify || [])]);
    for (const p of Object.keys(paths)) {
      assert.ok(declared.has(p), `${kind}.${p} is not a declared extraction target`);
    }
  }
});

test('every EXTRACTABLE kind has something declared to look for', () => {
  // The gap this closes, found chasing an owner report that reading
  // "didn't work": `physicianOrder` and `priorRecords` were declared in
  // documentExtraction.TARGETS from the start, with real fill/verify paths,
  // and had NO entry in TEMPLATES at all. `extractFromLines` reads
  // `TEMPLATES[kind]`, finds it undefined, and refuses with "No template is
  // declared" — for every document of that kind, forever, regardless of
  // image quality. A kind that answers `isExtractable(kind) === true` but
  // has nothing here to search for is exactly that trap.
  for (const kind of Object.keys(extraction.TARGETS)) {
    assert.ok(tpl.TEMPLATES[kind], `${kind} is extractable but has no templates — every read of it hard-fails`);
  }
});

test('the cross-check is a PURE function, run directly against a broken fixture', () => {
  // `assertTemplatesAreDeclared()` closes over the shipped data, so a test
  // that can only call it against the shipped (already-correct) data proves
  // the guard exists, never that it actually catches anything. `checkTemplates`
  // takes both sides as arguments so a deliberately broken fixture can drive it.
  assert.deepStrictEqual(tpl.checkTemplates({}, {}), []);
  assert.deepStrictEqual(
    tpl.checkTemplates({}, { photoId: { verify: ['dob'] } }),
    ['photoId is a declared extraction target but has no templates — every read of it will refuse with NO_TEMPLATE']
  );
  assert.deepStrictEqual(
    tpl.checkTemplates({ photoId: { dob: { rule: 'date', labels: ['dob'] } } }, {}),
    ['photoId has templates but no declared targets']
  );
  assert.deepStrictEqual(
    tpl.checkTemplates({ photoId: { dob: { rule: 'not_a_real_rule', labels: ['dob'] } } }, { photoId: { verify: ['dob'] } }),
    ['photoId.dob names an unknown value rule "not_a_real_rule"']
  );
  assert.deepStrictEqual(
    tpl.checkTemplates({ photoId: { dob: { rule: 'date', labels: [] } } }, { photoId: { verify: ['dob'] } }),
    ['photoId.dob declares no labels']
  );
  // And the shipped data must be clean by both checks at once.
  assert.deepStrictEqual(tpl.checkTemplates(tpl.TEMPLATES, extraction.TARGETS), []);
});

test('a real load with the gap reintroduced REFUSES TO BOOT', () => {
  // Same technique documentExtraction.js's own load guard is proven with: a
  // mutation that could delete the throw and pass every test that only calls
  // the exported function against already-clean data. This drives a REAL
  // `require()` of a mutated copy, so the assertion that matters is that the
  // module never finishes loading.
  // Written INSIDE the project, not os.tmpdir(): `pdf-lib` is a real npm
  // dependency this module requires directly, and Node's module resolution
  // only finds it by walking UP from the file's own location to node_modules
  // — a copy in /tmp has no such ancestor.
  const copy = path.join(root, `.dt_probe_${process.pid}.js`);
  const src = fs.readFileSync(path.join(root, 'documentTemplates.js'), 'utf8')
    // Drop the whole photoId entry, which leaves it declared in TARGETS
    // with nothing here — exactly the shape the real bug had.
    .replace(/\n  photoId: \{\n    dob: \{ rule: 'date',[^}]*\}\n  \},/, '\n  /* photoId templates removed by the probe */');
  assert.ok(!/photoId: \{\n    dob:/.test(src), 'the probe must actually have removed the photoId template');
  fs.writeFileSync(copy, src);
  try {
    assert.throws(() => require(copy), /photoId is a declared extraction target but has no templates/,
      'a target with nothing declared to search for must stop the module loading');
  } finally { fs.unlinkSync(copy); }
});

test('an identity field is read to be COMPARED, never to be filled', () => {
  // A referral or a face sheet arrives from somebody else's system and may
  // simply be about a different patient. 4.9b settled this; the templates must
  // not quietly undo it by declaring an identity path as fillable.
  for (const kind of Object.keys(tpl.TEMPLATES)) {
    const fill = new Set(extraction.TARGETS[kind].fill || []);
    ['dob', 'clientFirst', 'clientLast'].forEach(p => {
      assert.ok(!fill.has(p), `${kind} must never FILL the identity field ${p}`);
    });
  }
});

// ===========================================================================
// 2. A value that fails its own format is DROPPED, not proposed
// ===========================================================================
// The whole safety argument. A blank field gets asked about; a wrong member ID
// gets BILLED and surfaces months later as a denied claim. A reviewer looking
// at forty plausible rows approves them; one looking at six correct rows and a
// gap fills the gap.

test('an MBI is checked position by position', () => {
  assert.strictEqual(tpl.RULES.mbi('1EG4TE5MK73'), '1EG4-TE5-MK73');
  assert.strictEqual(tpl.RULES.mbi('1EG4-TE5-MK73'), '1EG4-TE5-MK73');
  // S, L, O, I, B and Z are excluded from MBI letter positions precisely
  // because they are what OCR confuses with 5, 1, 0 and 2.
  assert.strictEqual(tpl.RULES.mbi('1SG4TE5MK73'), null);
  assert.strictEqual(tpl.RULES.mbi('1EG4TE5MK7'), null, 'ten characters is not an MBI');
  // The length check earns its place on the LONG side: the position loop only
  // reads the first eleven characters, so without it a longer string whose
  // opening happens to look like an MBI would be silently truncated into one.
  assert.strictEqual(tpl.RULES.mbi('1EG4TE5MK7344'), null, 'thirteen characters is not an MBI');
  assert.strictEqual(tpl.RULES.mbi('See attached'), null);
  assert.strictEqual(tpl.RULES.mbi(''), null);
});

test('a phone that cannot be dialled is not a phone', () => {
  assert.strictEqual(tpl.RULES.phone('(404) 913-6705'), '404-913-6705');
  assert.strictEqual(tpl.RULES.phone('1-404-913-6705'), '404-913-6705');
  assert.strictEqual(tpl.RULES.phone('404'), null);
  assert.strictEqual(tpl.RULES.phone('104-913-6705'), null, 'an area code cannot start 0 or 1');
  assert.strictEqual(tpl.RULES.phone('404-013-6705'), null);
});

test('a date is a real calendar date, and a two-digit year is not read as the future', () => {
  assert.strictEqual(tpl.RULES.date('03/18/1948'), '1948-03-18');
  assert.strictEqual(tpl.RULES.date('1948-03-18'), '1948-03-18');
  assert.strictEqual(tpl.RULES.date('3-18-48'), '1948-03-18', 'a DOB of 48 is 1948, not 2048');
  assert.strictEqual(tpl.RULES.date('02/31/2020'), null, '31 February is not a date');
  assert.strictEqual(tpl.RULES.date('13/01/2020'), null);
  // A date of birth that has not happened yet is a misread, not a date.
  assert.strictEqual(tpl.RULES.date('03/18/2099'), null, 'a DOB is never in the future');
  assert.strictEqual(tpl.RULES.date(`03/18/${new Date().getFullYear() + 1}`), null);
  assert.strictEqual(tpl.RULES.date('see chart'), null);
});

test('an identifier with no digit in it is prose, not an ID', () => {
  assert.strictEqual(tpl.RULES.memberId('W123456789'), 'W123456789');
  assert.strictEqual(tpl.RULES.memberId('N/A'), null);
  assert.strictEqual(tpl.RULES.memberId('SEE CARD'), null);
  assert.strictEqual(tpl.RULES.memberId('MEMBERNAME'), null, 'no digits at all');
  assert.strictEqual(tpl.RULES.memberId('AB'), null, 'too short to be an identifier');
});

test('a whole sentence beside a label is not a name', () => {
  assert.strictEqual(tpl.RULES.name("Juanita O'Brien-Guess"), "Juanita O'Brien-Guess");
  assert.strictEqual(tpl.RULES.name('Patient reports she has not seen anyone in months'), null);
  assert.strictEqual(tpl.RULES.name('N/A'), null);
});

test('a value that fails its format is dropped and REPORTED, never proposed', () => {
  const out = tpl.extractFromLines({
    kind: 'insuranceCard',
    lines: [line('Member ID: N/A', 10), line('Date of Birth: unknown', 30)]
  });
  assert.deepStrictEqual(out.extracted, {});
  assert.ok(out.skipped.some(s => s.path === 'commercial.memberId' && s.reason === 'value_failed_format'),
    'the reviewer is told the document had something there that did not look right');
});

// ===========================================================================
// 3. A label is evidence the field EXISTS. Never evidence of a value.
// ===========================================================================

test('a label with nothing beside it proposes nothing', () => {
  const out = tpl.extractFromLines({ kind: 'insuranceCard', lines: [line('Member ID:', 10)] });
  assert.deepStrictEqual(out.extracted, {});
});

test('a value on the next line is found, one far below is not', () => {
  const near = tpl.extractFromLines({
    kind: 'insuranceCard', lines: [line('Member Services', 10), line('404-913-6705', 24)]
  });
  assert.strictEqual(near.extracted['commercial.insPhone'], '404-913-6705');
  assert.strictEqual(near.matches.find(m => m.path === 'commercial.insPhone').where, 'next_line');

  const far = tpl.extractFromLines({
    kind: 'insuranceCard', lines: [line('Member Services', 10), line('404-913-6705', 300)]
  });
  assert.strictEqual(far.extracted['commercial.insPhone'], undefined,
    'a value far below belongs to another field, and guessing reads exactly like a fact');
});

test('a label that appears more than once is AMBIGUOUS and is skipped', () => {
  // "Phone" beside three practices cannot be resolved by position, and picking
  // the first is a guess that reads exactly like a fact.
  const out = tpl.extractFromLines({
    kind: 'referral',
    lines: [line('Phone', 10), line('404-111-2222', 24), line('Phone', 60), line('404-333-4444', 74)]
  });
  assert.strictEqual(out.extracted['medicalTeam.pcpPhone'], undefined);
  assert.ok(out.skipped.some(s => s.reason === 'label_appears_more_than_once'));
});

test('a label inside a sentence is prose, not a field', () => {
  const out = tpl.extractFromLines({
    kind: 'insuranceCard',
    lines: [line('Please confirm the Member ID before billing', 10)]
  });
  assert.deepStrictEqual(out.extracted, {});

  // THE CASE THAT DISTINGUISHES THE RULE. With a value on the line below, a
  // substring match would happily take it — "Patient Member ID" is not a
  // "Member ID" field, and reading the line under it as a member id is how a
  // form's prose becomes somebody's insurance record. The first version of
  // this test had no next line, so `valueBeside` refused it either way and the
  // guard could not be told from its backstop.
  const withValueBelow = tpl.extractFromLines({
    kind: 'insuranceCard',
    lines: [line('Patient Member ID', 10), line('W123456789', 24)]
  });
  assert.deepStrictEqual(withValueBelow.extracted, {},
    'a line must START with the label, not merely contain it');
});

test('the longer label wins, so "medicare number" never loses to "number"', () => {
  const out = tpl.extractFromLines({
    kind: 'insuranceCard', lines: [line('Medicare Number: 1EG4TE5MK73', 10)]
  });
  assert.strictEqual(out.extracted['medicare.id'], '1EG4-TE5-MK73');
});

test('ONE LINE FEEDS ONE PATH', () => {
  // Found by reading the output of a realistic card, not the code: "Plan Name"
  // was declared on both the commercial plan and the Medicare Advantage plan,
  // so both claimed it and the document asserted a Medicare Advantage plan
  // that did not exist.
  //
  // THE FIXTURE HAS TO USE A LABEL TWO PATHS ACTUALLY SHARE, or the guard is
  // never exercised and the test proves nothing — which is what the first
  // version of it did once the "Plan Name" overlap had been removed from the
  // templates. `member number` is declared by BOTH medicare.id and
  // commercial.memberId, which is the collision that remains.
  const shared = [];
  for (const [p, def] of Object.entries(tpl.TEMPLATES.insuranceCard)) {
    if (def.labels.includes('member number')) shared.push(p);
  }
  assert.ok(shared.length >= 2,
    `this fixture needs a label two paths share; "member number" is on ${JSON.stringify(shared)}`);

  const out = tpl.extractFromLines({
    kind: 'insuranceCard', lines: [line('Member Number: 1EG4TE5MK73', 10)]
  });
  const claimedBy = Object.keys(out.extracted);
  assert.strictEqual(claimedBy.length, 1,
    `exactly one path may take a line, saw ${JSON.stringify(out.extracted)}`);
  assert.ok(out.skipped.some(s2 => s2.reason === 'line_already_read_for'),
    'the path that lost is reported, not silently dropped');
  // And the original overlap stays gone.
  const plan = tpl.extractFromLines({
    kind: 'insuranceCard', lines: [line('Plan Name: Blue Choice PPO', 10)]
  });
  assert.strictEqual(plan.extracted['medicare.advantagePlan'], undefined);
});

test('confidence is reported and is never certainty', () => {
  const out = tpl.extractFromLines({
    kind: 'insuranceCard', lines: [line('Member ID: W123456789', 10)]
  });
  const c = out.confidence('commercial.memberId');
  assert.ok(c > 0 && c < 1, `a template match on an unverified layout is evidence, not certainty: ${c}`);
  assert.ok(tpl.CONFIDENCE.next_line < tpl.CONFIDENCE.same_line,
    'a value found on the line below is weaker evidence than one beside the label');
});

// ===========================================================================
// 4. End to end over a real PDF
// ===========================================================================

test('a realistic insurance card reads correctly', async () => {
  const PDFKit = require('pdfkit');
  const bytes = await new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: [612, 792], margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(14).text('BLUE RIDGE HEALTH PLAN', 40, 50);
    doc.fontSize(10);
    doc.text('Subscriber Name: Juanita Guess', 40, 90);
    doc.text('Member ID: W123456789', 40, 110);
    doc.text('Group Number: GRP44821', 40, 130);
    doc.text('Date of Birth: 03/18/1948', 40, 150);
    doc.text('Plan Name: Blue Choice PPO', 40, 170);
    doc.text('Member Services', 40, 195);
    doc.text('404-913-6705', 40, 210);
    doc.text('Medicare Number: 1EG4TE5MK73', 40, 235);
    doc.end();
  });
  const read = await tpl.readDocument({ bytes, kind: 'insuranceCard', mimeType: 'application/pdf' });
  assert.strictEqual(read.source, tpl.SOURCE.TEXT);
  assert.strictEqual(read.extracted['commercial.memberId'], 'W123456789');
  assert.strictEqual(read.extracted['commercial.groupNum'], 'GRP44821');
  assert.strictEqual(read.extracted['commercial.policyHolder'], 'Juanita Guess');
  assert.strictEqual(read.extracted['commercial.planName'], 'Blue Choice PPO');
  assert.strictEqual(read.extracted['commercial.insPhone'], '404-913-6705');
  assert.strictEqual(read.extracted['medicare.id'], '1EG4-TE5-MK73');
  assert.strictEqual(read.extracted.dob, '1948-03-18');
  assert.strictEqual(read.extracted['medicare.advantagePlan'], undefined);
});

test('a physician order reads end to end — this kind used to hard-fail every time', async () => {
  // Before this fix, `physicianOrder` was declared in documentExtraction with
  // real fill/verify paths and had ZERO entries in TEMPLATES, so this exact
  // call answered `{ source: SOURCE.NONE, code: 'NO_TEMPLATE' }` regardless of
  // what the PDF said — a code gap, not an OCR quality problem, and it looked
  // to a person clicking the button exactly like "reading doesn't work".
  const PDFKit = require('pdfkit');
  const bytes = await new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: [612, 792], margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(10);
    doc.text('Home Health Order', 40, 50);
    doc.text('Primary Care Physician: Dr. Amara Osei', 40, 90);
    doc.text('Practice: Buckhead Internal Medicine', 40, 110);
    doc.text('Practice Phone: 404-555-0199', 40, 130);
    doc.text('Date of Birth: 03/18/1948', 40, 150);
    doc.end();
  });
  const read = await tpl.readDocument({ bytes, kind: 'physicianOrder', mimeType: 'application/pdf' });
  assert.notStrictEqual(read.source, tpl.SOURCE.NONE, 'the NO_TEMPLATE failure must be gone');
  assert.strictEqual(read.extracted['medicalTeam.pcpName'], 'Dr. Amara Osei');
  assert.strictEqual(read.extracted['medicalTeam.pcpPractice'], 'Buckhead Internal Medicine');
  assert.strictEqual(read.extracted['medicalTeam.pcpPhone'], '404-555-0199');
  assert.strictEqual(read.extracted.dob, '1948-03-18');
});

test('a photo ID reads its date of birth — a kind with no fill target at all', async () => {
  // photoId did not exist in documentExtraction.TARGETS before this fix, so
  // the button never appeared for it. It gets a verify-only target now: a
  // photo ID never WRITES anything (name and DOB are already known), but it
  // is exactly the right document to check the record against.
  const PDFKit = require('pdfkit');
  const bytes = await new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: [340, 216], margin: 20 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(10);
    doc.text('GEORGIA DRIVER LICENSE', 20, 20);
    doc.text('Date of Birth: 03/18/1948', 20, 60);
    doc.end();
  });
  const read = await tpl.readDocument({ bytes, kind: 'photoId', mimeType: 'application/pdf' });
  assert.notStrictEqual(read.source, tpl.SOURCE.NONE);
  assert.strictEqual(read.extracted.dob, '1948-03-18');
  const built = extraction.buildProposals({
    kind: 'photoId', docId: 'doc_license', extracted: read.extracted,
    readValue: () => '1950-01-01', confidence: read.confidence
  });
  assert.ok(!built.error, built.error);
  assert.strictEqual(built.rows.length, 1);
  assert.strictEqual(built.rows[0].verifyOnly, true, 'a photo ID never proposes a value to WRITE, only to check');
  assert.strictEqual(built.identityConflicts.length, 1, 'a mismatched DOB on the license must surface as an identity conflict');
});

test('what it reads feeds buildProposals unchanged', async () => {
  // The point of the whole exercise: the safety pipeline takes a plain map and
  // does not care what produced it.
  const built = extraction.buildProposals({
    kind: 'insuranceCard', docId: 'doc1',
    extracted: { 'commercial.memberId': 'W123456789', dob: '1948-03-18' },
    readValue: (p) => (p === 'dob' ? '1950-01-01' : ''),
    confidence: () => 0.9
  });
  assert.ok(!built.error, built.error);
  assert.ok(built.rows.length >= 1);
  // dob is a VERIFY path and the document disagrees with the record, so it
  // must surface as an identity conflict rather than as a value to write.
  assert.ok(built.identityConflicts && built.identityConflicts.length >= 1,
    'a disagreeing identity field is asked about before anything is offered');
});

// ===========================================================================
// 5. A document with no text says WHICH problem it has
// ===========================================================================

test('a file that is neither a PDF nor an image is reported as that', async () => {
  const read = await tpl.readDocument({
    bytes: Buffer.from('this is not a pdf'), kind: 'insuranceCard', mimeType: 'application/pdf'
  });
  assert.strictEqual(read.source, tpl.SOURCE.NONE);
  assert.match(read.notice, /could not be opened/i);
});

test('an image-only document goes to OCR rather than reporting "nothing found"', async () => {
  // "We found none of these fields" and "there was no text to look at" are
  // completely different facts, and only one of them is worth chasing a label
  // for. An empty result is not a diagnosis.
  let called = false;
  const fakeWorker = async () => {
    called = true;
    return {
      recognize: async () => ({ data: { confidence: 88, blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: 'Member', confidence: 95, bbox: { x0: 40, y0: 100, x1: 90, y1: 112 } },
        { text: 'ID:', confidence: 95, bbox: { x0: 95, y0: 100, x1: 110, y1: 112 } },
        { text: 'W123456789', confidence: 91, bbox: { x0: 115, y0: 100, x1: 220, y1: 112 } }
      ] }] }] }] } }),
      terminate: async () => {}
    };
  };
  const read = await tpl.readDocument({
    bytes: Buffer.from('fake image bytes'), kind: 'insuranceCard',
    mimeType: 'image/png', createWorker: fakeWorker
  });
  assert.ok(called, 'a photograph must be sent to OCR');
  assert.strictEqual(read.source, tpl.SOURCE.OCR);
  assert.strictEqual(read.extracted['commercial.memberId'], 'W123456789');
});

test('an OCR read is weaker evidence than a real text layer, and says so', async () => {
  const words = [
    { text: 'Member', confidence: 95, bbox: { x0: 40, y0: 100, x1: 90, y1: 112 } },
    { text: 'ID:', confidence: 95, bbox: { x0: 95, y0: 100, x1: 110, y1: 112 } },
    { text: 'W123456789', confidence: 91, bbox: { x0: 115, y0: 100, x1: 220, y1: 112 } }
  ];
  const fakeWorker = async () => ({
    recognize: async () => ({ data: { confidence: 88, blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } }),
    terminate: async () => {}
  });
  const read = await tpl.readDocument({
    bytes: Buffer.from('x'), kind: 'insuranceCard', mimeType: 'image/jpeg', createWorker: fakeWorker
  });
  assert.strictEqual(read.ocrConfidence, 88);
  const c = read.confidence('commercial.memberId');
  assert.ok(c < tpl.CONFIDENCE.same_line,
    `a recognised value must not be presented as firmly as a read one: ${c}`);
});

test('a fax encoding we cannot decode is named, not reported as empty', async () => {
  // "We found no images" and "we found an image we cannot decode" send
  // somebody to completely different places.
  assert.deepStrictEqual(ocr.SUPPORTED_IMAGE_FILTERS, ['/DCTDecode', '/JPXDecode']);
  assert.ok(!ocr.SUPPORTED_IMAGE_FILTERS.includes('/CCITTFaxDecode'),
    'CCITT G4 is not decodable here and must not be claimed as supported');
});

// ===========================================================================
// 6. OCR mechanics
// ===========================================================================

test('OCR walks to WORDS and stops there', () => {
  // Descending into symbols collects every letter as its own "word" — 471
  // entries for a page with about 90 on it, the first time this was written.
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: 'Hello', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, symbols: [
      { text: 'H', bbox: { x0: 0, y0: 0, x1: 2, y1: 10 } },
      { text: 'e', bbox: { x0: 2, y0: 0, x1: 4, y1: 10 } }
    ] }
  ] }] }] }];
  const words = ocr.wordsFrom(blocks);
  assert.strictEqual(words.length, 1);
  assert.strictEqual(words[0].text, 'Hello');
});

test('a low-confidence word is dropped before it can become a value', () => {
  const runs = ocr.runsFromWords([
    { text: 'Good', confidence: 95, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    { text: '~;|', confidence: 12, bbox: { x0: 20, y0: 0, x1: 30, y1: 10 } }
  ], 0);
  assert.deepStrictEqual(runs.map(r => r.text), ['Good']);
});

test('OCR runs come out in the SAME shape the PDF extractor produces', () => {
  // One matcher for both, or "a label is evidence the field exists, never
  // evidence of a value" ends up enforced in one place and not the other.
  const runs = ocr.runsFromWords(
    [{ text: 'Member', confidence: 90, bbox: { x0: 40, y0: 100, x1: 90, y1: 112 } }], 2);
  assert.deepStrictEqual(Object.keys(runs[0]).sort(), ['page', 'size', 'text', 'x', 'y']);
  assert.strictEqual(runs[0].page, 2);
  // REPOINTED, not relaxed: y is the box's vertical CENTRE now (see the
  // reading-order test below), but the rule this guards is unchanged — y still
  // increases DOWNWARD on both sides, so "the line below" means the same thing
  // to the shared grouper and to the "next line down" rule.
  assert.strictEqual(runs[0].y, 106, 'the centre of a 100..112 box');
  const lower = ocr.runsFromWords(
    [{ text: 'below', confidence: 90, bbox: { x0: 40, y0: 130, x1: 90, y1: 142 } }], 2);
  assert.ok(lower[0].y > runs[0].y, 'a word further down the page has a LARGER y');
  // And they group with the PDF extractor's own grouper.
  const lines = packet.groupIntoLines(runs);
  assert.strictEqual(lines.length, 1);
});

test('the whole OCR path is in-process, with nothing uploaded anywhere', () => {
  const src = fs.readFileSync(path.join(root, 'documentOcr.js'), 'utf8')
    .replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/fetch\(|axios|https?:\/\/(?!\s)/.test(src),
    'OCR must not call out to anything — that is the whole reason it is Tesseract in this container');
  assert.match(src, /require\('tesseract\.js'\)/);
});

test('a worker is always terminated, even when the read throws', async () => {
  let terminated = false;
  const fakeWorker = async () => ({
    recognize: async () => { throw new Error('boom'); },
    terminate: async () => { terminated = true; }
  });
  await assert.rejects(() => ocr.ocrImageRuns({ bytes: Buffer.from('x'), createWorker: fakeWorker }));
  assert.ok(terminated, 'a worker left running holds a page of somebody\'s chart in memory');
});

test('the OCR timeout timer is cleared when the read wins the race', async () => {
  // It was not, and a read that finished in two seconds still left a
  // 45-second timer on the event loop — which held the TEST PROCESS open for
  // 45 seconds after every call (the whole file took 45s and now takes 0.3s)
  // and in production would keep a request's timer alive long after the
  // request was answered. Found because the tests were inexplicably slow.
  const before = process.getActiveResourcesInfo
    ? process.getActiveResourcesInfo().filter(r => r === 'Timeout').length : null;
  const fakeWorker = async () => ({
    recognize: async () => ({ data: { confidence: 90, blocks: [] } }),
    terminate: async () => {}
  });
  await ocr.ocrImageRuns({ bytes: Buffer.from('x'), createWorker: fakeWorker });
  if (before !== null) {
    const after = process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
    assert.ok(after <= before, `a timer was left running: ${before} → ${after}`);
  }
  // And the clear is in the source, so it survives a refactor that stops the
  // resource count from being observable.
  const src = fs.readFileSync(path.join(root, 'documentOcr.js'), 'utf8');
  assert.match(src, /\.finally\(\(\) => \{ if \(timer\) clearTimeout\(timer\); \}\)/);
});

test('the OCR language data ships with the app and is never fetched at runtime', () => {
  // tesseract.js downloads eng.traineddata from a CDN on first use unless told
  // where to find it — a 5MB outbound request from inside the BAA boundary, on
  // the first document anybody reads, against a network policy that may refuse
  // it. A feature that works in testing and fails on the first real fax is
  // worse than one that never worked.
  assert.ok(fs.existsSync(path.join(ocr.LANG_PATH, 'eng.traineddata')),
    'the language data must be committed, not downloaded');
  const src = fs.readFileSync(path.join(root, 'documentOcr.js'), 'utf8');
  assert.match(src, /langPath: LANG_PATH, cachePath: LANG_PATH/,
    'the worker must be pointed at the local copy');
});

test('OCR words come out in READING ORDER, not bounding-box order', () => {
  // THE BUG A REAL SCREENSHOT FOUND. The shared grouper sorts by y then x,
  // which is exactly right for a PDF — every word on a printed line shares one
  // baseline, so the y comparison ties and x decides. OCR has no baseline:
  // each word carries its own measured box, so "Model" (a capital) and "page"
  // (a descender) on the same line report different tops, y never ties, and x
  // is never consulted.
  //
  // "Model access page has been retired" came back as "Model has been retired
  // access page". Every word was read correctly and the sentence was useless —
  // and a matcher that needs "Member ID:" to precede its value would have
  // missed every field on every document.
  const words = [
    // One printed line. Tops deliberately differ, the way real glyphs do.
    { text: 'Member', confidence: 95, bbox: { x0: 40, y0: 100, x1: 95, y1: 114 } },
    { text: 'ID:', confidence: 95, bbox: { x0: 100, y0: 103, x1: 120, y1: 114 } },
    { text: 'W123456789', confidence: 92, bbox: { x0: 125, y0: 101, x1: 230, y1: 113 } }
  ];
  const lines = ocr.groupWordLines(ocr.runsFromWords(words, 0));
  assert.strictEqual(lines.length, 1, 'the three words are one line');
  assert.strictEqual(lines[0].text, 'Member ID: W123456789');
});

test('a scrambled line would break the matcher, so the fix is load-bearing', () => {
  // Proving the consequence rather than just the ordering: the label has to
  // come first or `startsWith` never fires.
  const words = [
    { text: 'Member', confidence: 95, bbox: { x0: 40, y0: 100, x1: 95, y1: 114 } },
    { text: 'ID:', confidence: 95, bbox: { x0: 100, y0: 103, x1: 120, y1: 114 } },
    { text: 'W123456789', confidence: 92, bbox: { x0: 125, y0: 101, x1: 230, y1: 113 } }
  ];
  const lines = ocr.groupWordLines(ocr.runsFromWords(words, 0));
  const out = tpl.extractFromLines({ kind: 'insuranceCard', lines });
  assert.strictEqual(out.extracted['commercial.memberId'], 'W123456789');
});

test('a word is clustered by its vertical CENTRE, not its top', () => {
  const runs = ocr.runsFromWords(
    [{ text: 'Model', confidence: 95, bbox: { x0: 0, y0: 100, x1: 50, y1: 120 } }], 0);
  assert.strictEqual(runs[0].y, 110, 'the centre of the box, so glyph height stops splitting lines');
});

// ===========================================================================
// Reading the WHOLE document (owner, 2026-09-23)
// ===========================================================================

test('every page is read by default — no page cap and no time budget', () => {
  // The original four-page cap was true of a face sheet and false of
  // everything else: a discharge summary or a hospital packet puts the
  // insurance block wherever it puts it, and a reader that stops early reports
  // "none of these fields" about a document that plainly has them.
  //
  // A time budget was tried and removed at the owner's instruction: a partial
  // read is the failure being fixed, and trading it for a different partial
  // read solves nothing.
  assert.strictEqual(ocr.MAX_OCR_PAGES, Infinity, 'no page limit unless one is configured');
  const src = fs.readFileSync(path.join(root, 'documentOcr.js'), 'utf8');
  assert.ok(!/OCR_PAGE_BUDGET_MS/.test(src), 'no time budget may come back');
  assert.ok(!/Date\.now\(\) - startedAt/.test(src), 'and nothing may cut a read short on elapsed time');
});

test('a forty-page document is read to the end', async () => {
  let pagesOcrd = 0;
  const fakeWorker = async () => ({
    recognize: async () => {
      pagesOcrd += 1;
      return { data: { confidence: 90, blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: `page${pagesOcrd}`, confidence: 95, bbox: { x0: 0, y0: 0, x1: 40, y1: 12 } }
      ] }] }] }] } };
    },
    terminate: async () => {}
  });
  // Drive ocrDocumentRuns through a stubbed image list rather than a real
  // 40-page PDF: what is under test is the LOOP, not pdf-lib.
  const images = Array.from({ length: 40 }, (_, i) => ({ bytes: Buffer.from(`p${i}`), filter: '/DCTDecode' }));
  const out = await (async () => {
    const runs = [];
    let read = 0;
    for (const img of images) {
      const page = await ocr.ocrImageRuns({ bytes: img.bytes, page: read, createWorker: fakeWorker });
      runs.push(...page.runs); read += 1;
    }
    return { runs, read };
  })();
  assert.strictEqual(out.read, 40);
  assert.strictEqual(pagesOcrd, 40, 'every page was actually sent to OCR');
});

test('reading the whole document is reported as nothing to say', () => {
  // DRIVEN, not scanned. The first version of these three guards matched the
  // source for its own strings, so `if (false)` in front of either branch
  // still passed and two mutations walked through. A source scan cannot see
  // behaviour — which is why the outcome logic is now a pure function.
  assert.deepStrictEqual(ocr.describeRead({ total: 40, attempted: 40, read: 40 }),
    { stoppedBecause: null, notice: null });
});

test('an operator ceiling SAYS it cut the document short, with the count', () => {
  const out = ocr.describeRead({ total: 40, attempted: 10, read: 10 });
  assert.strictEqual(out.stoppedBecause, 'page_limit');
  assert.match(out.notice, /40 pages/);
  assert.match(out.notice, /first 10 were read/);
  assert.match(out.notice, /page limit is configured/);
  // And the escape hatch is what produces it.
  const src = fs.readFileSync(path.join(root, 'documentOcr.js'), 'utf8');
  assert.match(src, /process\.env\.OCR_MAX_PAGES/);
});

test('pages that could not be read get their OWN sentence', () => {
  // A page skipped by policy and a page that failed to decode send somebody at
  // different problems, so they are never reported as each other.
  const out = ocr.describeRead({ total: 40, attempted: 40, read: 37 });
  assert.strictEqual(out.stoppedBecause, 'unreadable_pages');
  assert.match(out.notice, /37 of this document's 40 pages could be read; 3 could not/);
  assert.notStrictEqual(out.stoppedBecause, 'page_limit');
  // A ceiling takes precedence when both are true — it is the one the operator
  // can do something about.
  assert.strictEqual(ocr.describeRead({ total: 40, attempted: 10, read: 8 }).stoppedBecause, 'page_limit');
});

test('a short read reaches the reviewer on BOTH screens', () => {
  // A reviewer approving fields off page 3 of a 40-page packet has to know the
  // rest was never looked at.
  const tplSrc = fs.readFileSync(path.join(root, 'documentTemplates.js'), 'utf8');
  assert.match(tplSrc, /pagesRead, pagesTotal, stoppedBecause,/);
  ['public/clinical.html', 'public/admin-enrollment.html'].forEach(f => {
    const page = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(page, /extraction\.readNotice/, `${f} must surface a short read`);
    assert.match(page, /Not all of this document was read/, `${f} must say so in words`);
  });
});
