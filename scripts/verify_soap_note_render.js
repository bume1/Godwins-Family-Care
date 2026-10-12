#!/usr/bin/env node
// ============================================================================
// scripts/verify_soap_note_render.js — render the REAL public/clinical.html in
// a real browser and look at the visit note a clinician sees (owner,
// 2026-10-12: "the note breakdown for visits is confusing ... adjust the
// follow-up note layouts to reflect a SOAP style ... and allow for telehealth
// notes to remain reflective of standard visits in person").
//
// What it checks, on the Visit tab (Start visit):
//   - a Follow-up reads Chief Complaint, Subjective, Objective (med rec, vitals,
//     physical exam), Assessment, Plan — with ONE blood pressure and none of
//     the H&P's two-arm BP, systems grid or home-visit assessment;
//   - by video it is the same note, with vitals and exam marked patient-reported;
//   - Acute and Psych Follow-up add their own questions after the core;
//   - New Patient is still the H&P, unchanged;
//   - saving a follow-up POSTs kind 'followup';
//   - the "Document a visit" popup is a short starter with no S/O/A/P form.
//   - on a saved encounter, the Sign & Submit card says "save first" while the
//     note has unsaved typing, instead of listing typed sections as missing.
//
// The API is stubbed; the visit-type catalog is built from the REAL
// appointmentTypes/clinicalNotes modules the server serves it from. The CDN
// scripts are fetched once with curl and served locally, so the browser is
// never asked to trust a proxy CA.
//   node scripts/verify_soap_note_render.js
// Exit code 0 = every assertion held.
// ============================================================================
const http = require('http'); const fs = require('fs'); const path = require('path');
const os = require('os'); const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch (e) {
  try { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed (npm i -g playwright).'); process.exit(0); }
}
const CDN = process.env.GFC_CDN_DIR || path.join(os.tmpdir(), 'gfc-clinical-render-cdn');
fs.mkdirSync(CDN, { recursive: true });
const CDN_FILES = [
  ['react.js', 'https://unpkg.com/react@18/umd/react.production.min.js', /https:\/\/unpkg\.com\/react@18[^"]*/],
  ['react-dom.js', 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js', /https:\/\/unpkg\.com\/react-dom@18[^"]*/],
  ['babel.js', 'https://unpkg.com/@babel/standalone@7/babel.min.js', /https:\/\/unpkg\.com\/@babel[^"]*/],
  ['tailwind.js', 'https://cdn.tailwindcss.com', /https:\/\/cdn\.tailwindcss\.com/]
];
for (const [file, url] of CDN_FILES) {
  const f = path.join(CDN, file);
  if (!fs.existsSync(f) || fs.statSync(f).size < 1000) execFileSync('curl', ['-sSL', '-m', '90', '-o', f, url]);
}

const A = require(path.join(root, 'appointmentTypes.js'));
const N = require(path.join(root, 'clinicalNotes.js'));
const roles = require(path.join(root, 'clinicalRoles.js'));

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const PROVIDER = { id: 'u-fnp', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true, licenseLevel: 'FNP' };
const PATIENT = { id: 'c-1', name: 'Juanita Guess', serviceLine: 'ihpc', openEmrPatientId: 'p-1', initialVisitAt: '2026-09-01' };
// The catalog, built the way the place-of-service route builds it.
const catalog = () => {
  const noteTemplates = {};
  for (const t of A.APPOINTMENT_TYPES) {
    noteTemplates[t.key] = [];
    for (const m of A.MODALITIES) {
      for (const sec of A.sectionsFor(t.key, { modality: m.key })) {
        noteTemplates[t.key].push({ ...sec, modality: m.key, ownField: N.sectionHasOwnField(sec.key) });
      }
    }
  }
  return {
    canEdit: false, usualLocation: 'home', usualLocationLabel: 'Private Home',
    locations: A.LOCATIONS.map(l => ({ key: l.key, label: l.label })),
    services: A.SERVICES.map(s => ({ key: s.key, label: s.label })),
    modalities: A.MODALITIES.map(m => ({ key: m.key, label: m.label })),
    appointmentTypes: A.APPOINTMENT_TYPES.map(t => ({
      key: t.key, label: t.label, service: t.service, telehealthAllowed: !!t.telehealthAllowed,
      telehealthPayerCaveat: !!t.telehealthPayerCaveat, modalities: A.modalitiesForType(t.key),
      noteShape: t.noteShape || null, noteForm: A.noteFormFor(t.key), layout: A.isSoapLayout(t.key) ? 'soap' : null,
      canDocument: A.canDocumentType(t.key, 'provider').ok
    })),
    noteTemplates
  };
};
const posted = [];
// Section H: a saved follow-up encounter, opened from the Encounters tab.
let encRows = [];
let readyCheck = false;
const ENC = 'e-9';
const followUpSections = () => catalog().noteTemplates.pc_follow_up.filter(s => s.modality === 'in_person');
const encounterDetail = () => ({
  encounter: { uuid: ENC, eid: '42', date: '2026-10-12', reason: 'Follow-up' },
  record: { diagnoses: [], services: [], noteKind: 'followup', patientSummary: '', followUpInstructions: '', renderingProvider: null },
  state: 'draft', closed: false, prescriptions: [], orders: [], attestation: null, addenda: [], candidates: [],
  narrativeNotes: [], orderTypes: [], orderPriorities: [], documentOrderTypes: [],
  favorites: { practiceServices: [], services: [], diagnoses: [] }, billingActions: {},
  signReadiness: readyCheck ? { ok: true, missing: [], message: '' } : { ok: false, missing: ['SIGN_SECTIONS'], message: 'Cannot sign: this Follow-up note still needs Subjective, Assessment / Diagnoses, Plan.' },
  noteActions: { canEdit: true }, noteState: { status: 'draft', note: { kind: 'followup', chiefConcern: 'BP check' } },
  noteSections: followUpSections(), noteTypeLabel: 'Follow-up', me: PROVIDER, access: { canWrite: true }
});

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/clinical') {
      let html = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
      for (const [file, , re] of CDN_FILES) html = html.replace(re, `/cdn/${file}`);
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    if (url.startsWith('/cdn/')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(fs.readFileSync(path.join(CDN, path.basename(url)))); return; }
    const pub = path.join(root, 'public', url);
    if (pub.startsWith(path.join(root, 'public')) && fs.existsSync(pub) && fs.statSync(pub).isFile()) {
      res.writeHead(200, { 'Content-Type': url.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' });
      res.end(url === '/session-guard.js' ? '// stubbed' : fs.readFileSync(pub)); return;
    }
    res.writeHead(404); res.end('');
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (process.env.GFC_PROBE_DEBUG) console.log('   [console]', m.type(), m.text()); });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') {
      try { posted.push({ path: p, method: req.method(), body: JSON.parse(req.postData() || '{}') }); } catch (e) { /* empty */ }
      return json({ message: 'Saved', encounterUuid: 'e-1', version: 1, warnings: [] });
    }
    if (p === '/api/clinical/status') return json({ configured: true, connected: true, emr: { connected: true },
      access: { canWrite: true, clinicalRole: 'provider', capabilities: roles.capabilitiesFor(PROVIDER) } });
    if (p === '/api/clinical/patients') return json({ patients: [PATIENT] });
    if (p.endsWith('/chart')) return json({ banner: { name: PATIENT.name }, intakePrefill: {}, problems: [], medications: [], allergies: [], encounters: [], vitals: [], documents: [] });
    if (p.endsWith('/place-of-service')) return json(catalog());
    if (p.endsWith('/encounters')) return json({ linked: true, encounters: encRows });
    if (p.endsWith(`/encounters/${ENC}/note`)) return json({ version: 1, status: 'draft', revisions: [], note: { kind: 'followup', chiefConcern: 'BP check', subjective: '', assessment: '', plan: '', sections: {}, vitals: {} } });
    if (p.endsWith(`/encounters/${ENC}`)) return json(encounterDetail());
    if (p.endsWith('/my-day')) return json({ date: '2026-10-12', visits: [], totals: { visits: 0, miles: null }, calendar: { ok: true }, unsignedEarlier: [], openTasks: [] });
    return json({});
  });

  await page.addInitScript((u) => {
    try { localStorage.setItem('admin_token', 'probe'); localStorage.setItem('admin_user', JSON.stringify(u)); } catch (e) { /* empty */ }
  }, PROVIDER);
  await page.goto(`${base}/clinical`, { waitUntil: 'networkidle' });

  // Open the patient and the Visit tab (the banner's Start visit lands here).
  const openVisit = async () => {
    // The workspace opens on My Day; the patient list is under Patients.
    await page.locator('button:has-text("Patients"), a:has-text("Patients")').first().click();
    await page.waitForTimeout(300);
    await page.locator(`text=${PATIENT.name}`).first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Start Visit")').first().click();
    await page.waitForSelector('text=Visit Type', { timeout: 15000 });
  };
  try { await openVisit(); }
  catch (e) {
    console.log('   body:', (await page.locator('body').innerText()).slice(0, 1500));
    console.log('   pageErrors:', pageErrors.join(' | '));
    throw e;
  }
  const typeSel = page.locator('label:has-text("Appointment type") select, :text("Appointment type") + select').first();
  const pick = async (label) => {
    const sel = page.locator('select').filter({ has: page.locator(`option:text-is("${label}")`) }).first();
    await sel.selectOption({ label }); await page.waitForTimeout(250);
  };
  const noteCard = page.locator('.card', { hasText: '· Note' }).first();
  const noteText = async () => (await noteCard.innerText()).toUpperCase();
  const order = (text, labels) => labels.map(l => text.indexOf(l.toUpperCase()));
  const ascending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

  // --- A. Follow-up in person: the SOAP note --------------------------------
  await pick('Follow-up');
  let t = await noteText();
  if (process.env.GFC_PROBE_DEBUG) console.log(t);
  ok('A1 Follow-up reads Chief Complaint, Subjective, Objective, Medication Reconciliation, Vitals, Physical Exam, Assessment, Plan in that order',
    ascending(order(t, ['Chief Complaint', 'Subjective', 'OBJECTIVE', 'Medication Reconciliation', 'Vitals', 'Physical Exam', 'Assessment', 'Plan'])),
    JSON.stringify(order(t, ['Chief Complaint', 'Subjective', 'OBJECTIVE', 'Medication Reconciliation', 'Vitals', 'Physical Exam', 'Assessment', 'Plan'])));
  ok('A2 one blood pressure, not two arms', /BP SYS/.test(t) && !/both arms/i.test(t) && !/right arm|left arm/i.test(t));
  ok('A3 no systems grid and no home-visit assessment', !/CARDIOVASCULAR/.test(t) && !/HOME VISIT ASSESSMENT/i.test(t) && !/Skin & wound/i.test(t) && !/Home-hazard/i.test(t));
  ok('A4 no "additional" heading on a plain follow-up', !/— ADDITIONAL/i.test(t));
  // A picture of the note, for whoever asked. Off unless requested, so an
  // ordinary run writes nothing.
  if (process.env.GFC_PROBE_SHOT) await noteCard.screenshot({ path: process.env.GFC_PROBE_SHOT });

  // --- B. The same follow-up by video -------------------------------------
  await page.locator('select').filter({ has: page.locator('option:text-is("Telehealth")') }).first().selectOption({ label: 'Telehealth' });
  await page.waitForTimeout(250);
  const tv = await noteText();
  ok('B1 by video it is the same note, in the same order',
    ascending(order(tv, ['Chief Complaint', 'Subjective', 'OBJECTIVE', 'Medication Reconciliation', 'Vitals', 'Physical Exam', 'Assessment', 'Plan'])));
  ok('B2 vitals say patient-reported, the exam says observed by video', /PATIENT-REPORTED ON A VIDEO VISIT/.test(tv) && /OBSERVED BY VIDEO/.test(tv));
  await page.locator('select').filter({ has: page.locator('option:text-is("In-Person")') }).first().selectOption({ label: 'In-Person' });

  // --- C. Acute and Psych follow-up: core, then their own questions -------
  await pick('Acute / Sick');
  t = await noteText();
  ok('C1 Acute: core first, then "Acute / Sick — additional" with its own questions',
    ascending(order(t, ['Chief Complaint', 'Plan', 'ACUTE / SICK — ADDITIONAL', 'Pertinent ROS', 'Return / ER Precautions'])),
    JSON.stringify(order(t, ['Chief Complaint', 'Plan', 'ACUTE / SICK — ADDITIONAL', 'Pertinent ROS', 'Return / ER Precautions'])));
  await pick('Psych Follow-up / Med Mgmt');
  t = await noteText();
  ok('C2 Psych follow-up: core first, then adherence, MSE and risk',
    ascending(order(t, ['Chief Complaint', 'Subjective', 'Assessment', 'PSYCH FOLLOW-UP / MED MGMT — ADDITIONAL', 'Medication Adherence', 'Mental Status Exam', 'Risk Assessment'])));

  // --- D. New Patient is still the H&P --------------------------------------
  await pick('New Patient');
  t = await noteText();
  ok('D1 New Patient keeps the two-arm BP and the home-visit assessment', /both arms/i.test(t) && /HOME VISIT ASSESSMENT/i.test(t));

  // --- E. Saving a follow-up sends a follow-up ------------------------------
  await pick('Follow-up');
  await noteCard.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type('Blood pressure follow-up');
  await page.locator('button:has-text("Save Draft")').first().click();
  await page.waitForTimeout(500);
  const save = posted.find(x => /\/notes$|\/note$/.test(x.path));
  ok('E1 the saved note is a follow-up of type Follow-up', !!save && save.body.note && save.body.note.kind === 'followup' && save.body.note.visit.appointmentType === 'pc_follow_up',
    save ? JSON.stringify({ kind: save.body.note && save.body.note.kind, path: save.path }) : 'nothing posted');
  ok('E2 and carries no H&P blocks', !!save && !(save.body.note || {}).hp);

  // --- G. The popup is a short starter -------------------------------------
  await page.locator('button:has-text("Back to Chart")').first().click();
  await page.waitForTimeout(300);
  await page.locator('.tabbtn:text-is("Encounters")').first().click();
  await page.waitForTimeout(400);
  await page.locator('button:has-text("Document Follow-Up")').first().click();
  const modal = page.locator('.card', { hasText: 'Document a visit' }).first();
  await modal.waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  const mt = (await modal.innerText()).toUpperCase();
  const typeValue = await modal.locator('select').first().inputValue();
  ok('G1 the popup defaults to the Follow-up visit type', typeValue === 'pc_follow_up', typeValue);
  ok('G2 it asks for the chief complaint and where the visit happened', /CHIEF COMPLAINT/.test(mt) && /LOCATION/.test(mt));
  // Field LABELS, not loose words: the popup's own sentence mentions S/O/A/P.
  const labels = (await modal.locator('.lblu').allInnerTexts()).map(x => x.trim().toUpperCase());
  ok('G3 it carries no S/O/A/P boxes, vitals or coding',
    !labels.some(l => ['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'BP SYS'].includes(l)) && !/ICD-10/.test(mt) && labels.includes('CHIEF COMPLAINT'),
    JSON.stringify(labels));

  // --- H. The encounter's Sign & Submit card while the note is unsaved -------
  // (owner report, 2026-10-12): it read the SAVED note, so it listed
  // Subjective, Assessment and Plan as missing while they were typed.
  encRows = [{ id: ENC, date: '2026-10-12', reason: 'Follow-up', state: 'draft' }];
  await page.goto(`${base}/clinical`, { waitUntil: 'networkidle' });
  await page.locator('button:has-text("Patients"), a:has-text("Patients")').first().click();
  await page.waitForTimeout(300);
  await page.locator(`text=${PATIENT.name}`).first().click();
  await page.waitForTimeout(400);
  await page.locator('.tabbtn:text-is("Encounters")').first().click();
  await page.waitForTimeout(400);
  await page.locator('div.cursor-pointer', { hasText: 'Not coded' }).first().click();
  const signCard = page.locator('.card', { has: page.locator('h2:text-is("Sign & Submit")') }).first();
  try { await signCard.waitFor({ timeout: 15000 }); } catch (e) { console.log('   pageErrors:', pageErrors.join(' | ')); throw e; }
  await page.waitForTimeout(400);
  let sc = await signCard.innerText();
  ok('H1 a saved note shows what signing still needs', /still needs Subjective/.test(sc) && !/unsaved changes/i.test(sc), sc.slice(0, 200));
  const subj = page.locator('.card', { hasText: 'Subjective' }).locator('[contenteditable="true"]').nth(1);
  await subj.click(); await page.keyboard.type('Feels better, no dizziness');
  await page.waitForTimeout(300);
  sc = await signCard.innerText();
  ok('H2 typing in the note: the card says save first and no longer lists the sections', /unsaved changes/i.test(sc) && !/still needs Subjective/.test(sc), sc.slice(0, 200));
  ok('H3 and the card cannot sign while the note is unsaved', await signCard.locator('button:has-text("Sign & Submit")').isDisabled());
  const before = posted.length;
  await signCard.locator('button:has-text("Save Note")').click();
  await page.waitForTimeout(600);
  const put = posted.slice(before).find(x => x.path.endsWith(`/encounters/${ENC}/note`));
  ok('H4 Save Note saves the typed note', !!put && /Feels better/.test(JSON.stringify(put.body)), put ? put.path : 'nothing posted');
  sc = await signCard.innerText();
  ok('H5 after the save the card reads the saved note again', !/unsaved changes/i.test(sc) && /still needs Subjective/.test(sc), sc.slice(0, 200));

  // --- I. A ready note with unsaved coding says why it cannot sign ---------
  // (owner report, 2026-10-12: a call note read "Ready to sign" with the
  // button grey and no reason). No appointment is involved anywhere.
  readyCheck = true;
  await page.goto(`${base}/clinical`, { waitUntil: 'networkidle' });
  await page.locator('button:has-text("Patients"), a:has-text("Patients")').first().click();
  await page.waitForTimeout(300);
  await page.locator(`text=${PATIENT.name}`).first().click();
  await page.waitForTimeout(400);
  await page.locator('.tabbtn:text-is("Encounters")').first().click();
  await page.waitForTimeout(400);
  await page.locator('div.cursor-pointer', { hasText: 'Not coded' }).first().click();
  const card2 = page.locator('.card', { has: page.locator('h2:text-is("Sign & Submit")') }).first();
  await card2.waitFor({ timeout: 15000 });
  await card2.locator('input[type="checkbox"]').first().check();
  const signBtn = card2.locator('button:has-text("Sign & Submit")');
  ok('I1 a ready, clean note with no appointment can be signed', !(await signBtn.isDisabled()));
  await page.locator('textarea[placeholder^="e.g. We checked"]').fill('We talked about your blood pressure.');
  await page.waitForTimeout(300);
  let c2 = await card2.innerText();
  ok('I2 unsaved coding: the button is grey and the card says why', (await signBtn.isDisabled()) && /Save your coding changes first/.test(c2), c2.slice(0, 200));
  await page.locator('button', { hasText: /^Save Coding$/ }).first().click();
  await page.waitForTimeout(600);
  c2 = await card2.innerText();
  ok('I3 after saving coding the line goes and the button enables', !(await signBtn.isDisabled()) && !/Save your coding changes first/.test(c2), c2.slice(0, 200));

  ok('F1 no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
