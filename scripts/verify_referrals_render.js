#!/usr/bin/env node
// ============================================================================
// scripts/verify_referrals_render.js — render the REAL public/clinical.html in
// a real browser and use the referral screens (owner, 2026-10-12: "a dropdown
// for providers ... a running list of providers we have referred externally
// AND other clinical care team members ... an option for 'new' ... a social
// worker would get a notification in their clinical view of a new order").
//
// What it checks:
//   A. /clinical#inbox opens on the inbox; a referral from the team shows with
//      Accept and Mark Complete for the colleague it went to, and completing
//      waits for a note.
//   B. The chart's Referrals tab lists an internal referral by who it went to,
//      an outside referral opens to its consult note and its send record, and
//      Cancel Order waits for a reason and sends it.
//   C. In an encounter, a provider's "Refer to" list groups the care team, the
//      providers referred before, and + New Provider; each choice draws its own
//      fields, and Send Referral posts an internal referral.
//   D. An LMSW sees "+ Record Order" for a referral only, with no outside
//      providers and no New Provider.
//
// The API is stubbed; orders are built by the REAL orderRequisitions module and
// what each viewer may do comes from the REAL clinicalRoles module, the way the
// server's orderForViewer answers it.
//   node scripts/verify_referrals_render.js
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

const roles = require(path.join(root, 'clinicalRoles.js'));
const orderReq = require(path.join(root, 'orderRequisitions.js'));
const clinicalRepo = require(path.join(root, 'clinicalRepository.js'));

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const PROVIDER = { id: 'u-fnp', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true, licenseLevel: 'FNP', npi: '1902310568' };
const CASE_MANAGER = { id: 'u-cm', name: 'Courtney Hale', role: 'caseManager', clinicalRole: 'lmsw', hasClinicalAccess: true };
const PATIENT = { id: 'c-1', name: 'Juanita Guess', serviceLine: 'ihpc', openEmrPatientId: 'p-1', initialVisitAt: '2026-09-01' };
const DX = [{ code: 'F32.9', description: 'Depression, unspecified' }];
const AT = '2026-10-12T14:00:00.000Z';

const internal = orderReq.buildReferral({
  id: 'o-int', clientId: PATIENT.id, encounterUuid: 'e-1', actor: PROVIDER, encounterDiagnoses: DX, at: AT,
  assignee: { id: CASE_MANAGER.id, name: CASE_MANAGER.name, clinicalRole: 'lmsw', roleLabel: 'Case management' },
  input: { destination: 'internal', reason: 'Housing instability', clinicalSummary: 'Can you connect her with housing support?', diagnosisCodes: ['F32.9'] }
}).order;
const external = orderReq.applySend({
  order: orderReq.buildReferral({
    id: 'o-ext', clientId: PATIENT.id, encounterUuid: 'e-1', actor: PROVIDER, encounterDiagnoses: DX, at: AT,
    input: { destination: 'external', specialty: 'Psychiatry', receivingPractice: 'Midtown Psychiatry', receivingFax: '4045550123', reason: 'Medication management', clinicalSummary: 'Is an SSRI change needed?', diagnosisCodes: ['F32.9'] }
  }).order,
  actor: PROVIDER, at: AT, input: { channel: 'doximity' }
}).order;
const forViewer = (o, viewer) => {
  const isInt = orderReq.isInternalReferral(o);
  const to = isInt ? o.referral.assignedTo : null;
  return {
    ...o,
    can: {
      coordinate: !isInt && roles.canCoordinateOrder(viewer, o),
      cancel: roles.canCoordinateOrder(viewer, o) && (clinicalRepo.transitionsFor(o)[o.status] || []).includes('cancelled'),
      acceptOrComplete: !!to && String(to.id) === String(viewer.id) && ['ordered', 'accepted'].includes(o.status)
    }
  };
};
const RESULT = {
  id: 'r-1', clientId: PATIENT.id, orderId: 'o-ext', interpretation: 'normal', resultDate: '2026-10-11',
  performedBy: 'Midtown Psychiatry', summary: 'Consult: continue sertraline, follow up in 6 weeks', receivedAt: AT,
  acknowledgedAt: null, document: { fileName: 'consult.pdf', emrFiled: true }
};
const TARGETS = (viewer) => ({
  internal: [
    { userId: CASE_MANAGER.id, name: CASE_MANAGER.name, clinicalRole: 'lmsw', credential: 'LMSW', discipline: 'Case management', onCareTeam: false },
    { userId: 'u-lcsw', name: 'Lee Carter', clinicalRole: 'lcsw', credential: 'LCSW', discipline: 'Clinical social work', onCareTeam: true }
  ].filter(t => t.userId !== viewer.id),
  external: [
    { id: 'sp-1', name: null, practice: 'Midtown Psychiatry', specialty: 'Psychiatry', fax: '4045550123', faxFormatted: '(404) 555-0123', phone: null, label: 'Midtown Psychiatry', useCount: 2 }
  ],
  canReferInternal: roles.canRefer(viewer, 'internal'),
  canReferExternal: roles.canRefer(viewer, 'external'),
  canEditProviders: roles.canEditOrderDestination(viewer)
});
const ENCOUNTER = (viewer) => ({
  record: { encounterUuid: 'e-1', clientId: PATIENT.id, date: '2026-10-12', reason: 'Follow-up', diagnoses: DX.map(d => ({ ...d, primary: true, source: 'manual' })), services: [], codingStatus: 'not_coded', note: {} },
  encounter: { id: 'e-1', start: '2026-10-12T14:00:00Z' },
  state: 'open', closed: false, attestation: null, addenda: [], prescriptions: [],
  orders: [internal, external].map(o => forViewer(o, viewer)),
  narrativeNotes: [], noteSections: [], candidates: [], favorites: { icd10: [], services: [], practiceServices: [] },
  me: { name: viewer.name }, warnings: [], signReadiness: { ready: false, missing: [] }, billingReadiness: {}, addendumReadiness: {},
  billingStatus: null, billingActions: {}, noteState: { status: 'draft', note: {}, revisions: [] }, noteActions: { canEdit: true },
  orderTypes: clinicalRepo.ORDER_TYPES, orderPriorities: clinicalRepo.ORDER_PRIORITIES, orderStatuses: clinicalRepo.ORDER_STATUSES,
  orderTransitions: clinicalRepo.ORDER_TRANSITIONS, referralTransitions: orderReq.REFERRAL_TRANSITIONS,
  documentOrderTypes: orderReq.DOCUMENT_ORDER_TYPES, sendChannels: orderReq.SEND_CHANNELS, sendChannelLabels: orderReq.SEND_CHANNEL_LABELS,
  defaultSendChannel: orderReq.DEFAULT_SEND_CHANNEL, faxSendChannels: orderReq.FAX_SEND_CHANNELS,
  destinationFields: orderReq.destinationFormFields(), destinationEditableStatuses: orderReq.DESTINATION_EDITABLE_STATUSES,
  rxRoutes: [], rxKinds: [], rxKindLabels: {}, rxSchedules: [], rxScheduleLabels: {}, resultInterpretations: ['normal', 'abnormal', 'critical'],
  prescriber: null, billingNpiUsed: null, sectionsOnly: false
});

const run = async (viewer, startPath, scenario) => {
  const posted = [];
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => { if (process.env.GFC_PROBE_DEBUG) console.log('   [console]', m.type(), m.text()); });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') {
      try { posted.push({ path: p, method: req.method(), body: JSON.parse(req.postData() || '{}') }); } catch (e) { posted.push({ path: p, method: req.method() }); }
      return json({ message: 'Saved', warnings: [] });
    }
    if (p === '/api/clinical/status') return json({ configured: true, connected: true, emr: { connected: true },
      access: { canWrite: true, clinicalRole: roles.resolveClinicalRole(viewer), capabilities: roles.capabilitiesFor(viewer),
        credentialCeiling: roles.ceilingFor(viewer), canEditOrderDestination: roles.canEditOrderDestination(viewer) } });
    if (p === '/api/clinical/patients') return json({ patients: [PATIENT] });
    if (p.endsWith('/chart')) return json({ banner: { name: PATIENT.name }, intakePrefill: {}, problems: [], medications: [], allergies: [], encounters: [], vitals: [], documents: [] });
    if (p.endsWith('/referral-targets')) return json(TARGETS(viewer));
    if (p === `/api/clinical/patients/${PATIENT.id}/orders`) return json({
      orders: [internal, external].map(o => forViewer(o, viewer)), destinationFields: orderReq.destinationFormFields(),
      destinationEditableStatuses: orderReq.DESTINATION_EDITABLE_STATUSES, noteMax: 2000,
      sendChannels: orderReq.SEND_CHANNELS, sendChannelLabels: orderReq.SEND_CHANNEL_LABELS, defaultSendChannel: orderReq.DEFAULT_SEND_CHANNEL,
      faxSendChannels: orderReq.FAX_SEND_CHANNELS, resultInterpretations: ['normal', 'abnormal', 'critical']
    });
    if (p.endsWith('/results')) return json({ results: [RESULT] });
    if (p.endsWith('/encounters/e-1')) return json(ENCOUNTER(viewer));
    if (p.endsWith('/encounters')) return json({ linked: true, encounters: [{ encounterUuid: 'e-1', date: '2026-10-12', reason: 'Follow-up', state: 'open' }] });
    if (p === '/api/clinical/inbox') return json({
      items: [
        { kind: 'internal_referral', status: 'ordered', label: 'Referral from the team', id: 'o-int', clientId: PATIENT.id, patientName: PATIENT.name,
          encounterUuid: null, at: AT, dueAt: null, overdue: false, actionable: viewer.id === CASE_MANAGER.id,
          waitingOn: viewer.id === CASE_MANAGER.id ? 'you' : CASE_MANAGER.name, detail: 'From Bethel Godwins: Housing instability' },
        { kind: 'encounter_unsigned', label: 'Encounter documented but not signed', id: 'e-1', clientId: PATIENT.id, patientName: PATIENT.name,
          encounterUuid: 'e-1', at: AT, actionable: true, waitingOn: 'you', detail: '1 diagnosis code(s), 0 service code(s) recorded.' }
      ],
      counts: { total: 2, actionable: viewer.id === CASE_MANAGER.id ? 2 : 1, overdue: 0 }
    });
    if (p.endsWith('/my-day')) return json({ date: '2026-10-12', visits: [], totals: { visits: 0, miles: null }, calendar: { ok: true }, unsignedEarlier: [], openTasks: [] });
    return json({});
  });
  await page.addInitScript((u) => {
    try { localStorage.setItem('admin_token', 'probe'); localStorage.setItem('admin_user', JSON.stringify(u)); } catch (e) { /* empty */ }
  }, viewer);
  try {
    await page.goto(`${base}${startPath}`, { waitUntil: 'networkidle' });
    await scenario(page, posted);
  } catch (e) {
    console.log('   body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 2500));
    fails.push(`scenario threw: ${e.message.split('\n')[0]}`);
    console.log(`FAIL  scenario threw: ${e.message}`);
  }
  ok(`no page errors (${viewer.name})`, pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close(); srv.close();
};

(async () => {
  // ── A. The colleague's inbox ─────────────────────────────────────────────
  console.log('\nA. a case manager opens the referral email link');
  await run(CASE_MANAGER, '/clinical#inbox', async (page, posted) => {
    await page.waitForSelector('text=Referral from the team', { timeout: 20000 });
    ok('A1 /clinical#inbox lands on the inbox with the referral in it', true);
    const row = page.locator('div', { has: page.locator('text=Referral from the team') }).filter({ has: page.locator('button:text-is("Accept")') }).last();
    ok('A2 it is waiting on them, with Accept and Mark Complete', await row.locator('button:text-is("Accept")').count() === 1 && await row.locator('button:text-is("Mark Complete")').count() === 1);
    await row.locator('button:text-is("Accept")').click();
    await page.waitForTimeout(300);
    ok('A3 Accept posts to the accept route', posted.some(x => x.path === '/api/clinical/orders/o-int/accept'), JSON.stringify(posted));
    await page.locator('button:text-is("Mark Complete")').first().click();
    const done = page.locator('button:text-is("Complete Referral")').first();
    ok('A4 Complete Referral waits for a note', await done.isDisabled());
    await page.locator('textarea[placeholder^="What did you do?"]').fill('Referred to the county housing program; intake booked.');
    ok('A5 …and enables once there is one', !(await done.isDisabled()));
    await done.click();
    await page.waitForTimeout(300);
    const c = posted.find(x => x.path === '/api/clinical/orders/o-int/complete');
    ok('A6 the note is what gets sent', !!c && /county housing/.test(c.body.note), JSON.stringify(c));
  });

  // ── B. The chart's Referrals tab ──────────────────────────────────────────
  console.log('\nB. a provider reads the Referrals tab');
  await run(PROVIDER, '/clinical', async (page, posted) => {
    await page.locator('button:has-text("Patients"), a:has-text("Patients")').first().click();
    await page.waitForTimeout(300);
    await page.locator(`text=${PATIENT.name}`).first().click();
    await page.waitForTimeout(500);
    // Chart tabs are .tabbtn divs, not buttons.
    await page.locator('.tabbtn:text-is("Referrals")').first().click();
    await page.waitForSelector('text=Referred to Courtney Hale inside the team', { timeout: 15000 });
    ok('B1 the internal referral says who it went to', true);
    await page.locator('button', { hasText: 'Psychiatry' }).first().click();
    await page.waitForSelector('text=Consult Notes', { timeout: 10000 });
    const body = await page.locator('body').innerText();
    ok('B2 the outside referral shows its consult note', /continue sertraline/.test(body));
    ok('B3 the Sent card reads the real send record (recipient and fax)', /Doximity fax · Midtown Psychiatry · \(404\) 555-0123 · Bethel Godwins/.test(body), body.match(/Sent[\s\S]{0,160}/) && body.match(/Sent[\s\S]{0,160}/)[0]);
    await page.locator('button:has-text("Cancel Order")').first().click();
    const confirm = page.locator('button:text-is("Confirm Cancel")').first();
    ok('B4 Confirm Cancel waits for a reason', await confirm.isDisabled());
    await page.locator('input[placeholder^="e.g. Done at the hospital"]').fill('Patient chose a different psychiatrist');
    await confirm.click();
    await page.waitForTimeout(300);
    const c = posted.find(x => x.path === '/api/clinical/orders/o-ext/status');
    ok('B5 the cancel sends the reason', !!c && c.body.status === 'cancelled' && c.body.note === 'Patient chose a different psychiatrist', JSON.stringify(c));
  });

  // ── C. A provider's "Refer to" list in an encounter ───────────────────────
  console.log('\nC. a provider refers from an encounter');
  await run(PROVIDER, '/clinical#inbox', async (page, posted) => {
    await page.waitForSelector('text=Encounter documented but not signed', { timeout: 20000 });
    await page.locator('button:has-text("Open Encounter")').first().click();
    await page.waitForSelector('button:has-text("+ Record Order")', { timeout: 20000 });
    await page.locator('button:has-text("+ Record Order")').first().click();
    await page.locator('select').filter({ has: page.locator('option[value="referral"]') }).first().selectOption('referral');
    const referTo = page.locator('select').filter({ has: page.locator('option:has-text("Choose who this referral is for")') }).first();
    await page.waitForFunction(() => [...document.querySelectorAll('optgroup')].some(g => g.label === 'Our care team'), null, { timeout: 10000 });
    const groups = await referTo.locator('optgroup').evaluateAll(gs => gs.map(g => g.label));
    ok('C1 the list groups the care team and the providers referred before', JSON.stringify(groups) === JSON.stringify(['Our care team', 'Referred before']), JSON.stringify(groups));
    ok('C2 and ends with + New Provider', await referTo.locator('option[value="new"]').count() === 1);
    await referTo.selectOption(`team:${CASE_MANAGER.id}`);
    let text = await page.locator('body').innerText();
    ok('C3 a colleague: lands in their inbox, nothing faxed, and they join the care team',
      /Lands in Courtney Hale's clinical inbox\. Nothing is faxed\./.test(text) && /They will be added to this patient.s care team/.test(text));
    const send = page.locator('button:text-is("Send Referral")').first();
    ok('C4 Send Referral waits for a reason and a question', await send.isDisabled());
    await page.locator('label:has-text("Reason for referral") input, :text("Reason for referral") + input').first().fill('Housing instability');
    await page.locator('label:has-text("What do you need from them?") textarea, :text("What do you need from them?") + textarea').first().fill('Can you connect her with housing support?');
    ok('C5 …then enables', !(await send.isDisabled()));
    await send.click();
    await page.waitForTimeout(300);
    const placed = posted.find(x => /\/encounters\/e-1\/orders$/.test(x.path));
    ok('C6 it posts an internal referral to that colleague', !!placed && placed.body.destination === 'internal' && placed.body.assigneeId === CASE_MANAGER.id && placed.body.orderType === 'referral', JSON.stringify(placed && placed.body));
    // A saved outside provider fills in its details.
    await page.locator('button:has-text("+ Record Order")').first().click().catch(() => {});
    await page.locator('select').filter({ has: page.locator('option[value="referral"]') }).first().selectOption('referral');
    const referTo2 = page.locator('select').filter({ has: page.locator('option:has-text("Choose who this referral is for")') }).first();
    await referTo2.selectOption('saved:sp-1');
    text = await page.locator('body').innerText();
    ok('C7 a saved provider: its fax is shown and Edit Saved Provider is offered', /Saved fax \(404\) 555-0123/.test(text) && /Edit Saved Provider/.test(text));
    ok('C8 the fax box is filled from it', await page.locator('label:has-text("Receiving fax") input, :text("Receiving fax") + input').first().inputValue() === '4045550123');
    await referTo2.selectOption('new');
    ok('C9 a new provider: Save to the provider list is ticked', await page.locator('text=Save to the provider list').count() === 1);
    await page.locator('label:has-text("Receiving fax") input, :text("Receiving fax") + input').first().fill('(404) 555-0123');
    await page.waitForTimeout(150);
    ok('C10 a fax already on the list offers the saved provider instead', await page.locator('button:text-is("Use Saved Provider")').count() === 1);
  });

  // ── D. An LMSW refers within the team only ───────────────────────────────
  console.log('\nD. an LMSW case manager refers from an encounter');
  await run(CASE_MANAGER, '/clinical#inbox', async (page) => {
    await page.waitForSelector('text=Encounter documented but not signed', { timeout: 20000 });
    await page.locator('button:has-text("Open Encounter")').first().click();
    await page.waitForSelector('button:has-text("+ Record Order")', { timeout: 20000 });
    ok('D1 an LMSW is offered + Record Order', true);
    await page.locator('button:has-text("+ Record Order")').first().click();
    const typeSel = page.locator('select').filter({ has: page.locator('option[value="referral"]') }).first();
    const types = await typeSel.locator('option').evaluateAll(os => os.map(o => o.value));
    ok('D2 a referral is the only order type offered', JSON.stringify(types) === JSON.stringify(['referral']), JSON.stringify(types));
    await page.waitForFunction(() => [...document.querySelectorAll('optgroup')].some(g => g.label === 'Our care team'), null, { timeout: 10000 });
    const referTo = page.locator('select').filter({ has: page.locator('option:has-text("Choose who this referral is for")') }).first();
    const groups = await referTo.locator('optgroup').evaluateAll(gs => gs.map(g => g.label));
    ok('D3 only the care team, with no outside providers', JSON.stringify(groups) === JSON.stringify(['Our care team']), JSON.stringify(groups));
    ok('D4 and no + New Provider', await referTo.locator('option[value="new"]').count() === 0);
    ok('D5 they are told who refers out', /You refer within the team\. A provider or an LCSW refers to outside practices\./.test(await page.locator('body').innerText()));
    const vals = await referTo.locator('option').evaluateAll(os => os.map(o => o.value));
    ok('D6 they are not offered themselves', !vals.includes(`team:${CASE_MANAGER.id}`), JSON.stringify(vals));
  });

  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
