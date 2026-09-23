#!/usr/bin/env node
// scripts/verify_document_reading.js — reading a filed document WITHOUT a
// model, driven through the REAL Express routes over HTTP (2026-09-23).
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3218 node server.js
//   GFC_PROBE_BASE=http://localhost:3218 node scripts/verify_document_reading.js
//
// Every assertion reads the stored value BACK rather than trusting a status
// code.
//
// WHAT THIS CANNOT PROVE FROM A BUILD SANDBOX, STATED PLAINLY:
//   • Filing a document at all. The upload route stores the bytes in Google
//     Drive and no Drive credential is reachable here, so the probe seeds the
//     upload row directly and asserts the READ path. Filing is covered by
//     test/document_exchange.test.js and its own probe.
//   • OCR accuracy on YOUR documents. Tesseract runs in-process and is proven
//     to run; whether it reads a particular fax correctly is a question only
//     real faxes answer. The format rules are what stop a bad read reaching a
//     record, and those are unit-tested exhaustively.

const fs = require('fs');
const path = require('path');

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3218';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`); }
};
const call = async (method, p, token, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', null, { email, password });
  return (r.body && r.body.token) || null;
};

(async () => {
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) { console.log('LOGIN FAILED — is the app running with MFA_ENFORCE=false?'); process.exit(1); }

  const stamp = Date.now();
  const made = await call('POST', '/api/users', admin, {
    email: `docread.${stamp}@example.test`, password: 'Probe12345!',
    name: 'Document Read Probe (TEST DATA)', role: 'client',
    practiceName: 'Document Read Probe (TEST DATA)', sendWelcomeEmail: false
  });
  const clientId = made.body && (made.body.user ? made.body.user.id : made.body.id);
  if (!clientId) { console.log('Could not create the probe client:', made.body); process.exit(1); }

  // ---- 1. The control is offered even with no model configured -----------
  console.log('\n--- 1. reading no longer waits on the model ---');
  const st = await call('GET', `/api/gfc/admin/enrollment/${clientId}/extraction`, admin);
  ok('the extraction status answers', st.status === 200, st.body);
  ok('  reading is AVAILABLE with no model configured', st.body.available === true, st.body.available);
  ok('  and it says plainly that the MODEL is not', st.body.modelAvailable === false, st.body.modelAvailable);
  ok('  the readers are named', Array.isArray(st.body.readers) && st.body.readers.includes('template'), st.body.readers);
  ok('  the model blockers are still reported for whoever can clear them',
    Array.isArray(st.body.blockers) && st.body.blockers.length > 0, st.body.blockers);
  ok('  insurance cards and referrals are readable kinds',
    st.body.templateKinds.includes('insuranceCard') && st.body.templateKinds.includes('referral'),
    st.body.templateKinds);

  // ---- 2. The reader itself, over a realistic document -------------------
  // Driven directly because filing needs Drive, which is not reachable here.
  console.log('\n--- 2. a realistic insurance card reads correctly ---');
  const tpl = require(path.join(__dirname, '..', 'documentTemplates'));
  const PDFKit = require('pdfkit');
  const bytes = await new Promise((resolve, reject) => {
    const d = new PDFKit({ size: [612, 792], margin: 40 });
    const chunks = [];
    d.on('data', c => chunks.push(c)); d.on('end', () => resolve(Buffer.concat(chunks))); d.on('error', reject);
    d.fontSize(14).text('BLUE RIDGE HEALTH PLAN', 40, 50);
    d.fontSize(10);
    d.text('Subscriber Name: Juanita Guess', 40, 90);
    d.text('Member ID: W123456789', 40, 110);
    d.text('Group Number: GRP44821', 40, 130);
    d.text('Date of Birth: 3-18-48', 40, 150);
    d.text('Plan Name: Blue Choice PPO', 40, 170);
    d.text('Member Services', 40, 195);
    d.text('(404) 913-6705', 40, 210);
    d.text('Medicare Number: 1EG4TE5MK73', 40, 235);
    d.text('Policy Number: N/A', 40, 260);
    d.end();
  });
  const read = await tpl.readDocument({ bytes, kind: 'insuranceCard', mimeType: 'application/pdf' });
  ok('the document is read from its own text layer', read.source === 'text', read.source);
  ok('  the member id reads back', read.extracted['commercial.memberId'] === 'W123456789', read.extracted);
  ok('  the group number reads back', read.extracted['commercial.groupNum'] === 'GRP44821', read.extracted);
  ok('  the subscriber name reads back', read.extracted['commercial.policyHolder'] === 'Juanita Guess', read.extracted);
  ok('  a phone on the NEXT line is found, and normalised',
    read.extracted['commercial.insPhone'] === '404-913-6705', read.extracted);
  ok('  an MBI is normalised and shape-checked',
    read.extracted['medicare.id'] === '1EG4-TE5-MK73', read.extracted);
  ok('  a two-digit year resolves into the PAST, never 2048',
    read.extracted.dob === '1948-03-18', read.extracted.dob);
  ok('  "N/A" beside a label is DROPPED, not proposed',
    read.extracted['commercial.memberId'] !== 'N/A' &&
    read.skipped.some(s => s.reason === 'value_failed_format'), read.skipped);
  ok('  and the Medicare Advantage plan is NOT invented from "Plan Name"',
    read.extracted['medicare.advantagePlan'] === undefined, read.extracted);

  // ---- 3. What it read feeds the SAME safety pipeline --------------------
  console.log('\n--- 3. the proposals go through the review a model\'s would ---');
  const extraction = require(path.join(__dirname, '..', 'documentExtraction'));
  const built = extraction.buildProposals({
    kind: 'insuranceCard', docId: 'probe-doc', extracted: read.extracted,
    confidence: read.confidence,
    // The record says a DIFFERENT date of birth than the card does.
    readValue: (p) => (p === 'dob' ? '1950-01-01' : '')
  });
  ok('proposals are built from what was read', !built.error && built.rows.length > 0, built.error || built.rows.length);
  ok('  a disagreeing identity field is asked about BEFORE any value is offered',
    (built.identityConflicts || []).length > 0, built.identityConflicts);
  ok('  every proposed path is one the allow-list declares',
    built.rows.every(r => {
      const t = extraction.TARGETS.insuranceCard;
      return [...(t.fill || []), ...(t.verify || [])].includes(r.path);
    }), built.rows.map(r => r.path));
  ok('  confidence travels with each row and is never certainty',
    built.rows.every(r => r.confidence === null || (r.confidence > 0 && r.confidence < 1)),
    built.rows.map(r => [r.path, r.confidence]));

  // ---- 4. A document with no text says WHICH problem it has --------------
  console.log('\n--- 4. an unreadable document says which problem it has ---');
  const junk = await tpl.readDocument({
    bytes: Buffer.from('not a pdf at all'), kind: 'insuranceCard', mimeType: 'application/pdf'
  });
  ok('an unopenable file is reported as that', junk.source === 'none' && /could not be opened/i.test(junk.notice), junk.notice);

  const noTemplate = await tpl.readDocument({ bytes, kind: 'physicianOrder', mimeType: 'application/pdf' });
  ok('a kind with no template declared says so rather than returning nothing silently',
    noTemplate.source === 'none' && /template/i.test(String(noTemplate.notice)), noTemplate.notice);

  // ---- 5. OCR runs in-process, and is reported as weaker evidence --------
  console.log('\n--- 5. a photograph goes to OCR, in this container ---');
  const fakeWorker = async () => ({
    recognize: async () => ({ data: { confidence: 84, blocks: [{ paragraphs: [{ lines: [{ words: [
      { text: 'Member', confidence: 92, bbox: { x0: 40, y0: 100, x1: 90, y1: 112 } },
      { text: 'ID:', confidence: 92, bbox: { x0: 95, y0: 100, x1: 110, y1: 112 } },
      { text: 'W987654321', confidence: 88, bbox: { x0: 115, y0: 100, x1: 220, y1: 112 } }
    ] }] }] }] } }),
    terminate: async () => {}
  });
  const shot = await tpl.readDocument({
    bytes: Buffer.from('a photograph'), kind: 'insuranceCard',
    mimeType: 'image/jpeg', createWorker: fakeWorker
  });
  ok('a photograph is read through OCR', shot.source === 'ocr', shot.source);
  ok('  and the value reaches the same matcher', shot.extracted['commercial.memberId'] === 'W987654321', shot.extracted);
  ok('  the page legibility is reported', shot.ocrConfidence === 84, shot.ocrConfidence);
  ok('  and a recognised value is weaker evidence than a read one',
    shot.confidence('commercial.memberId') < tpl.CONFIDENCE.same_line,
    shot.confidence('commercial.memberId'));

  // Tesseract itself, for real — proving the engine runs in this process.
  const ocr = require(path.join(__dirname, '..', 'documentOcr'));
  const sample = fs.readdirSync(path.join(__dirname, '..', 'attached_assets'))
    .filter(f => /\.png$/i.test(f)).slice(0, 1)[0];
  if (sample) {
    try {
      const real = await ocr.ocrImageRuns({
        bytes: fs.readFileSync(path.join(__dirname, '..', 'attached_assets', sample))
      });
      ok('Tesseract really runs in this process and returns positioned words',
        real.runs.length > 0 && real.runs.every(r => typeof r.x === 'number'), real.runs.length);
    } catch (e) {
      ok('Tesseract really runs in this process', false, e.message);
    }
  }

  console.log(`\n${pass}/${pass + fail} assertions passed${fail ? ` — ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Probe crashed:', e); process.exit(1); });
