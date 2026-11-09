#!/usr/bin/env node
// ============================================================================
// scripts/verify_billing_render.js — render the REAL public/billing.html and
// public/clinical.html in a real browser (owner, 2026-11-04: "billing needs to
// be its own page ... two coding areas in the encounter chart need to be
// resolved to one ... ensure our billing area is properly connected to open
// EMR").
//
// What it checks:
//   - the billing page opens on the OpenEMR connection check, built by the
//     REAL billingConnection module, with Sign In to OpenEMR when needed;
//   - the worklist shows billing's stages only, and a claim opens beside it
//     with the scrub's to-do list first, each finding linking to its fix;
//   - Save Codes sends the clinician's diagnoses unchanged with billing's
//     service lines, and Submit carries the attestation;
//   - a submitted claim shows the lines OpenEMR holds, read from /charges;
//   - Settings carries the billing NPI;
//   - in the clinical workspace a signed encounter has no billing tools, only
//     a link to the billing page; the sidebar shows Billing only to billing;
//     Results and Overdue are tabs in the Inbox.
//
// The API is stubbed; nothing here touches OpenEMR. The CDN scripts are
// fetched once with curl and served locally.
//   node scripts/verify_billing_render.js
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
const { buildBillingConnection } = require(path.join(root, 'billingConnection.js'));
const roles = require(path.join(root, 'clinicalRoles.js'));

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const MANAGER = { id: 'u-mgr', name: 'Morgan Biller', role: 'user', isManager: true };
const PROVIDER = { id: 'u-fnp', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true, licenseLevel: 'FNP', npi: '1234567893' };
const CLIENT = 'c-1'; const ENC = 'e-7';
const DX = [{ code: 'I10', description: 'Essential (primary) hypertension', primary: true }];
let status = 'awaiting_billing';
const detail = () => ({
  encounter: { uuid: ENC, eid: '77', date: '2026-11-03', reason: 'Follow-up', posCode: '12', facility: 'Private Residence' },
  record: { encounterUuid: ENC, clientId: CLIENT, date: '2026-11-03', reason: 'Follow-up', diagnoses: DX,
    services: [{ code: '99349', codeType: 'CPT4', label: 'Home visit, est', units: 1, dxLinks: ['I10'], modifiers: [] }],
    renderingProvider: { id: PROVIDER.id, name: PROVIDER.name, licenseLevel: 'FNP', npi: PROVIDER.npi }, patientSummary: 'We checked your BP.', followUpInstructions: '' },
  state: 'signed', closed: true, billingStatus: status,
  prescriptions: [], orders: [], candidates: [], narrativeNotes: [], orderTypes: [], orderPriorities: [], documentOrderTypes: [], screenings: [], warnings: [],
  billingActions: { canBill: true, canEditCoding: status === 'awaiting_billing', canSubmit: status === 'awaiting_billing', canRefreshPos: status === 'awaiting_billing' },
  billingReadiness: { ok: true, missing: [], message: '' }, billingNpiUsed: '1538078357',
  attestation: { signedAt: '2026-11-03T20:00:00Z', signedBy: { id: PROVIDER.id, name: PROVIDER.name } }, addenda: [],
  emDerivation: { finalCode: '99349', defaultCode: '99349', explanation: 'Moderate MDM.', candidates: [{ code: '99349', basis: 'mdm', mdm: 'moderate' }] },
  modifierJustifications: [], favorites: { practiceServices: [{ code: '99350', label: 'Home visit, est, high' }], services: [] },
  noteState: { status: 'signed', note: { kind: 'followup', chiefConcern: 'BP check', subjective: 'Feels **better**.', assessment: 'HTN improving.', plan: 'Continue.' },
    signature: { signer: { name: PROVIDER.name, licenseLevel: 'FNP', npi: PROVIDER.npi, at: '2026-11-03T20:00:00Z' } }, revisions: [] },
  noteSections: [], totalTime: { minutes: 40, source: 'entered' }, noteActions: {}, signReadiness: { ok: true, missing: [] }, me: MANAGER
});
const posted = [];

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/billing' || url === '/clinical') {
      let html = fs.readFileSync(path.join(root, 'public', `${url.slice(1)}.html`), 'utf8');
      for (const [file, , re] of CDN_FILES) html = html.replace(re, `/cdn/${file}`);
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    if (url.startsWith('/cdn/')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(fs.readFileSync(path.join(CDN, path.basename(url)))); return; }
    const pub = path.join(root, 'public', url);
    if (pub.startsWith(path.join(root, 'public')) && fs.existsSync(pub) && fs.statSync(pub).isFile()) {
      res.writeHead(200, { 'Content-Type': /\.jsx?$/.test(url) ? 'application/javascript' : 'application/octet-stream' });
      res.end(url === '/session-guard.js' ? '// stubbed' : fs.readFileSync(pub)); return;
    }
    res.writeHead(404); res.end('');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });

  const pageFor = async (user, access) => {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const q = new URL(req.url()).searchParams;
      const json = (body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
      if (req.method() !== 'GET') {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* empty */ }
        posted.push({ path: p, method: req.method(), body });
        if (p.endsWith('/billing-submit')) status = 'billed';
        return json({ message: 'Done' });
      }
      if (p === '/api/clinical/billing/connection') {
        return json(buildBillingConnection({
          emr: { configured: true, reachable: true, connected: false },
          payer: { billing_npi_used: '1538078357' },
          facilityInfo: { facilityListKnown: true, billingFacility: { id: '3', name: 'Vinings', fieldsRead: true, npi: '1538078357', ein: '', taxonomy: '207Q00000X' } },
          catalog: { loaded: true, stale: false, fetchedAt: '2026-11-04' }, ncci: { ncciSourceVersion: { ptp: { quarter: '2026Q4' }, mue: { quarter: '2026Q4' } } }
        }));
      }
      if (p === '/api/gfc/admin/billing-statements') return json({ clients: [{ id: CLIENT, name: 'Juanita Guess' }], invoices: [], stripe: { configured: false } });
      if (p === '/api/clinical/settings') return json({ billingNpiUsed: '1538078357', billingNpiSource: 'record', billingProviderName: 'GFC', serviceCodeFavorites: [], isAdmin: false });
      if (p === '/api/clinical/encounters/queue') {
        const st = q.get('state');
        const row = { encounterUuid: ENC, clientId: CLIENT, patientName: 'Juanita Guess', date: '2026-11-03', reason: 'Follow-up', diagnosisCount: 1, serviceCount: 1, renderingProvider: detail().record.renderingProvider };
        return json({ filter: st, encounters: st === 'awaiting_billing' ? [row] : [], zeroFee: [], counts: { awaiting_billing: 1, held: 0, level_flags: 0, released: 0, no_charge: 0 } });
      }
      if (p.endsWith(`/encounters/${ENC}/claim-scrub`)) {
        return json({ phase: 'pre_post', holdState: status === 'billed' ? 'held' : 'awaiting_billing', findings: [
          { severity: 'block', code: 'FACILITY_EIN', field: 'billingFacility.ein', fieldLabel: 'Billing facility', message: 'has no federal EIN in OpenEMR' },
          { severity: 'warn', code: 'DX_UNSPEC', field: 'diagnoses.I10', fieldLabel: 'Diagnosis I10', message: 'OpenEMR lists a more specific code' }
        ], offers: [] });
      }
      if (p.endsWith(`/encounters/${ENC}/charges`)) return json({ charges: [{ id: 'b1', code_type: 'CPT4', code: '99349', modifier: '', units: 1, fee: '150.00', justify: 'ICD10|I10:' }], chargesPosted: true });
      if (p.endsWith(`/encounters/${ENC}`)) return json(detail());
      if (p === '/api/clinical/service-selection/families') return json({ families: [] });
      if (p === '/api/clinical/codes/search') return json({ results: [] });
      if (p === '/api/clinical/reports/em-distribution') return json({ month: '2026-11', priorMonth: '2026-10', clinicians: [] });
      // The clinical workspace
      if (p === '/api/clinical/status') return json({ configured: true, connected: true, reachable: true, access });
      if (p === '/api/clinical/patients') return json({ patients: [{ id: CLIENT, name: 'Juanita Guess', serviceLine: 'ihpc', openEmrPatientId: 'p-1', initialVisitAt: '2026-09-01' }] });
      if (p.endsWith('/chart')) return json({ linked: true, banner: { name: 'Juanita Guess' }, intakePrefill: {}, problems: [], medications: [], allergies: [], encounters: [], vitals: [], documents: [] });
      if (p.endsWith('/encounters')) return json({ linked: true, encounters: [{ id: ENC, start: '2026-11-03', reason: 'Follow-up', state: 'signed', signedAt: '2026-11-03T20:00:00Z', diagnosisCount: 1, serviceCount: 1, prescriptionCount: 0, orderCount: 0, portalPublished: true }] });
      if (p.endsWith('/appointments')) return json({ linked: true, appointments: [] });
      if (p === '/api/clinical/inbox') return json({ items: [], counts: { actionable: 0 } });
      if (p === '/api/clinical/results/inbox') return json({ results: [] });
      if (p.endsWith('/my-day')) return json({ date: '2026-11-04', visits: [], totals: { visits: 0 }, calendar: { ok: true }, unsignedEarlier: [], openTasks: [] });
      return json({});
    });
    await page.addInitScript((u) => {
      try { localStorage.setItem('admin_token', 'probe'); localStorage.setItem('admin_user', JSON.stringify(u)); } catch (e) { /* empty */ }
    }, user);
    return page;
  };

  // --- A. The billing page ---------------------------------------------------
  const page = await pageFor(MANAGER, {});
  await page.goto(`${base}/billing#claims`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=OpenEMR Connection', { timeout: 20000 }).catch(() => {});
  let body = await page.locator('body').innerText();
  ok('A1 the billing page opens on the OpenEMR connection check', /OpenEMR Connection/.test(body), body.slice(0, 300));
  ok('A2 it names what is wrong: the sign-in and the missing EIN', /not signed in to OpenEMR/i.test(body) && /no federal EIN/.test(body));
  ok('A3 and offers Sign In to OpenEMR', await page.locator('button:has-text("Sign In to OpenEMR")').count() === 1);
  ok('A4 the clearinghouse is stated as OpenEMR\'s, never as connected', /Clearinghouse/.test(body) && /Billing Manager/.test(body));
  ok('A5 the worklist shows billing\'s stages only', /Awaiting Billing/.test(body) && /Hold Queue/.test(body) && /Released/.test(body) && !/Not Coded|Coded, Unsigned/.test(body));

  // --- B. A claim ------------------------------------------------------------
  await page.locator('button', { hasText: 'Juanita Guess · Follow-up' }).first().click();
  await page.waitForSelector('text=Before This Claim Goes', { timeout: 15000 });
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  const at = (t) => body.indexOf(t);
  ok('B1 the claim reads: scrub, codes, level, place of service, submit, note',
    [at('Before This Claim Goes'), at('Codes'), at('E/M Level'), at('Place of Service'), at('Submit to Billing'), at('Signed Note')].every((x, i, a) => x >= 0 && (i === 0 || x > a[i - 1])),
    JSON.stringify(['Before This Claim Goes', 'Codes', 'E/M Level', 'Place of Service', 'Submit to Billing', 'Signed Note'].map(at)));
  ok('B2 each scrub finding links to where it is fixed', await page.locator('button:has-text("Go to OpenEMR connection")').count() === 1 && await page.locator('button:has-text("Go to codes")').count() === 1);
  ok('B3 the clinician\'s diagnosis is shown, read-only', /I10/.test(body) && /as the clinician signed them/i.test(body));
  ok('B4 the signed note is readable on the claim, signature and all', /Feels better/.test(body) && /ELECTRONICALLY SIGNED/.test(body));
  await page.locator('button:has-text("+ 99350")').first().click();
  await page.waitForTimeout(200);
  await page.locator('button:has-text("Save Codes")').click();
  await page.waitForTimeout(500);
  const save = posted.find(x => x.path.endsWith(`/encounters/${ENC}/coding`));
  ok('B5 Save Codes sends billing\'s service lines with the clinician\'s diagnoses unchanged',
    !!save && JSON.stringify(save.body.diagnoses) === JSON.stringify(DX) && save.body.services.some(s => s.code === '99350'), save ? JSON.stringify(save.body).slice(0, 200) : 'nothing posted');
  await page.locator('#sec-submit input[type="checkbox"]').check();
  await page.locator('button:has-text("Submit to Billing")').click();
  await page.waitForTimeout(800);
  const sub = posted.find(x => x.path.endsWith('/billing-submit'));
  ok('B6 Submit carries the attestation', !!sub && sub.body.attest === true);
  await page.waitForSelector('text=Charge Lines in OpenEMR', { timeout: 10000 }).catch(() => {});
  body = await page.locator('body').innerText();
  ok('B7 once submitted, the claim shows the lines OpenEMR holds', /Charge Lines in OpenEMR/.test(body) && /99349/.test(body) && /\$150\.00/.test(body), body.slice(-600));

  // --- C. Settings -----------------------------------------------------------
  await page.locator('button.tabbtn:has-text("Settings")').click();
  await page.waitForTimeout(400);
  body = await page.locator('body').innerText();
  ok('C1 Settings carries the billing provider NPI', /Billing Settings/.test(body) && (await page.locator('input.font-mono').first().inputValue()) === '1538078357');
  ok('C2 no page errors on the billing page', page.errors.length === 0, page.errors.join(' | '));

  // --- D. The clinical workspace ---------------------------------------------
  status = 'awaiting_billing';
  const billingAccess = { canWrite: true, canDocument: false, canSubmitBilling: true, clinicalRole: 'readOnly', capabilities: {} };
  const cp = await pageFor(MANAGER, billingAccess);
  await cp.goto(`${base}/clinical`, { waitUntil: 'networkidle' });
  await cp.waitForTimeout(500);
  const side = await cp.locator('aside').innerText();
  ok('D1 billing sees Billing in the sidebar, and no Results, Overdue or Coding item', /Billing/.test(side) && !/\bResults\b/.test(side) && !/Overdue/.test(side) && !/\bCoding\b/.test(side), side.replace(/\n/g, ' · '));
  await cp.locator('aside button:has-text("Inbox")').click();
  await cp.waitForTimeout(500);
  const ib = await cp.locator('main').innerText();
  ok('D2 the Inbox carries Results and Overdue Orders as tabs', /To Do/.test(ib) && /Results/.test(ib) && /Overdue Orders/.test(ib));
  await cp.locator('aside button[title="Patients"]').click();
  await cp.waitForTimeout(300);
  await cp.locator('text=Juanita Guess').first().click();
  await cp.waitForTimeout(500);
  await cp.locator('.tabbtn:text-is("Visits")').first().click();
  await cp.waitForTimeout(500);
  await cp.locator('div.cursor-pointer', { hasText: 'Follow-up' }).first().click();
  try { await cp.locator('button[data-step="sign"]').first().waitFor({ timeout: 15000 }); }
  catch (e) { console.log('   errors:', cp.errors.join(' | ')); console.log('   body:', (await cp.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 800)); throw e; }
  await cp.locator('button[data-step="sign"]').first().click();
  await cp.waitForTimeout(400);
  const enc = await cp.locator('main').innerText();
  ok('D3 a signed encounter links to the billing page and carries no billing tools',
    /Open in Billing/.test(enc) && !/Submit to Billing/.test(enc) && !/Claim scrub/.test(enc) && !/Code helper/.test(enc), enc.slice(0, 400));
  const href = await cp.locator('a:has-text("Open in Billing")').getAttribute('href');
  ok('D4 the link opens this claim on the billing page', href === `/billing?client=${CLIENT}&encounter=${ENC}#claims`, href);
  ok('D5 no page errors in the clinical workspace (billing)', cp.errors.length === 0, cp.errors.join(' | '));

  const pp = await pageFor(PROVIDER, { canWrite: true, canDocument: true, canSubmitBilling: false, clinicalRole: 'provider', capabilities: roles.capabilitiesFor(PROVIDER) });
  await pp.goto(`${base}/clinical`, { waitUntil: 'networkidle' });
  await pp.waitForTimeout(500);
  const pside = await pp.locator('aside').innerText();
  ok('D6 a clinician sees no Billing item', !/Billing/.test(pside), pside.replace(/\n/g, ' · '));
  ok('D7 no page errors in the clinical workspace (clinician)', pp.errors.length === 0, pp.errors.join(' | '));

  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
