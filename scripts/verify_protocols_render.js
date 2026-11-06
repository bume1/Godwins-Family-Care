#!/usr/bin/env node
// ============================================================================
// scripts/verify_protocols_render.js — drive the standing-order authoring
// screen in a real browser.
//
// Why a probe and not only unit tests: esbuild compiling the page proves the
// JSX parses, NOT that every identifier resolves. This repo has shipped a page
// that compiled and threw at render because a component referenced one that had
// been deleted (`ShiftCard`, Session 9). The new view uses `Field`, `fmtDate`,
// `fmtTs` (from window.GFC_CLAIM_SHARED), `SignaturePad` and `AccessContext` —
// five identifiers from four different places — so running it is the only way
// to know.
//
// It also asserts the REQUEST BODY the form sends, because the server silently
// drops an order type or executor role outside its own lists: a wrong body
// would save and authorise nothing.
//
// Needs Playwright + a Chromium. The CDN scripts are fetched once with curl and
// served locally, so certificate checking is never switched off.
//   node scripts/verify_protocols_render.js
// ============================================================================
const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const pwPath = process.env.PLAYWRIGHT_MODULE || 'playwright';
let chromium;
try { ({ chromium } = require(pwPath)); } catch (e) {
  try { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed (npm i -g playwright).'); process.exit(0); }
}
const CDN = process.env.GFC_CDN_DIR || path.join(os.tmpdir(), 'gfc-portal-render-cdn');
fs.mkdirSync(CDN, { recursive: true });
for (const [file, url] of [
  ['react.js', 'https://unpkg.com/react@18/umd/react.production.min.js'],
  ['react-dom.js', 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js'],
  ['babel.js', 'https://unpkg.com/@babel/standalone@7/babel.min.js']
]) {
  const f = path.join(CDN, file);
  if (!fs.existsSync(f) || fs.statSync(f).size < 1000) execFileSync('curl', ['-sSL', '-m', '90', '-o', f, url]);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok:   ' + l); } else { fail++; console.log('  FAIL: ' + l); } };

const PROTOCOLS = [
  { id: 'p1', lineageId: 'p1', title: 'Annual diabetic monitoring', version: 2, status: 'active', effectiveStatus: 'active',
    permittedOrderTypes: ['lab'], permittedExecutorRoles: ['rn'], permittedTests: ['HbA1c', 'Lipid panel'],
    indications: ['E11.9'], patientScope: 'panel', namedClientIds: [],
    effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
    requiresCoSign: true, coSignWithinDays: 14, signedAt: '2026-01-01T00:00:00.000Z',
    authorizingProvider: { name: 'Bethel Godwins', npi: '1902310568' }, notes: '' },
  { id: 'p2', lineageId: 'p2', title: 'Depression screening', version: 1, status: 'draft', effectiveStatus: 'draft',
    permittedOrderTypes: ['screening'], permittedExecutorRoles: ['lmsw'], permittedTests: ['PHQ-9'],
    indications: ['F32.9'], patientScope: 'panel', namedClientIds: [],
    effectiveAt: '2026-02-01T00:00:00.000Z', expiresAt: '2027-02-01T00:00:00.000Z',
    requiresCoSign: false, signedAt: null, authorizingProvider: { name: 'Bethel Godwins' }, notes: '' }
];
const META = {
  orderTypes: ['lab', 'imaging', 'procedure', 'screening'],
  executorRoles: ['rn', 'lcsw', 'lmsw'],
  roleLabels: { rn: 'Registered Nurse', lcsw: 'LCSW (clinical social worker)', lmsw: 'LMSW (case manager / counselor)' },
  patientScopes: ['panel', 'named'],
  authorRefusal: 'Only a provider may author, sign or revise a standing order.',
  myClinicalRole: 'provider', myCeiling: ['lab', 'imaging', 'procedure', 'screening']
};

const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jsx': 'application/javascript' };
const srv = http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u === '/clinical') u = '/clinical.html';
  const f = path.join(root, 'public', u);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('nf');
});

const run = async (browser, port, { canAuthor }) => {
  console.log(`\n--- canAuthor = ${canAuthor} ---`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  // `pageerror` is the one that matters: an uncaught ReferenceError is how a
  // page that COMPILES still throws at render (the ShiftCard defect, Session
  // 9). Console errors are kept as well, which is stricter than the other
  // clinical probes, minus one known-benign note: Babel warns that it cannot
  // pretty-print an inline script over 500KB, and this page's script block is
  // 678KB. It says nothing about the code and predates this view.
  const BENIGN = /The code generator has deoptimised the styling/;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (BENIGN.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  // The keys the page actually reads: getToken() is
  // `admin_token || unified_token` and the user comes from `admin_user`
  // (clinical.html:210, :9976). Setting the wrong pair left the probe looking
  // at the LOGIN screen while one assertion passed vacuously.
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('admin_token', t);
    localStorage.setItem('admin_user', JSON.stringify(u));
    localStorage.setItem('unified_token', t);
    localStorage.setItem('unified_user', JSON.stringify(u));
  }, ['tok', { id: 'u1', role: 'user', name: 'Bethel Godwins', hasClinicalAccess: true, clinicalRole: canAuthor ? 'provider' : 'rn' }]);

  await page.route(/^https:\/\/(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)\//, route => {
    const u = route.request().url(); const cdn = CDN + '/';
    const file = /react-dom/.test(u) ? 'react-dom.js' : /unpkg\.com\/react@/.test(u) ? 'react.js' : /babel/.test(u) ? 'babel.js' : null;
    if (file) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(cdn + file) });
    if (/tailwindcss/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.tailwind = { config: {} };' });
    return route.fulfill({ status: 200, contentType: /\.css|css2/.test(u) ? 'text/css' : 'application/javascript', body: '' });
  });

  let created = null;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const u = url.pathname;
    const j = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u === '/api/clinical/status') return j({
      access: {
        canRead: true, canWrite: true, canDocument: true, role: 'user',
        clinicalRole: canAuthor ? 'provider' : 'rn',
        clinicalRoleLabel: canAuthor ? 'Provider (FNP / MD / PA)' : 'Registered Nurse',
        capabilities: { chartRead: true, authorStandingOrder: canAuthor },
        credentialCeiling: META.myCeiling, canSubmitBilling: false, canManageTasks: true
      },
      connected: true, billingNpiConfigured: true, homeVisitFields: []
    });
    if (u === '/api/clinical/standing-orders' && route.request().method() === 'GET') {
      return j({ standingOrders: PROTOCOLS, ...META, canAuthor });
    }
    if (u === '/api/clinical/standing-orders' && route.request().method() === 'POST') {
      created = JSON.parse(route.request().postData() || '{}');
      return j({ message: 'created', standingOrder: { ...PROTOCOLS[1], id: 'p3', title: created.title, version: 1 } });
    }
    if (u.startsWith('/api/clinical/standing-orders/')) {
      const id = u.split('/')[4];
      const o = PROTOCOLS.find(x => x.id === id) || PROTOCOLS[0];
      return j({ standingOrder: o, versions: [{ id: 'p0', version: 1, status: 'retired', signedAt: '2025-06-01T00:00:00.000Z' }, { id: o.id, version: o.version, status: o.status, signedAt: o.signedAt }], executionCount: 7 });
    }
    return j({});
  });

  await page.goto(`http://localhost:${port}/clinical#protocols`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForFunction(() => /Standing orders|Protocols/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
  const txt = () => page.locator('body').innerText();

  let t = await txt();
  if (!/Standing orders/.test(t)) {
    console.log('  --- PAGE TEXT (first 600 chars) ---');
    console.log('  ' + t.slice(0, 600).replace(/\n/g, '\n  '));
    console.log('  --- ERRORS ---');
    console.log('  ' + (errors.slice(0, 4).join('\n  ') || '(none)'));
  }
  ok(/Standing orders/.test(t), 'the protocols view rendered');
  ok(/Annual diabetic monitoring/.test(t) && /Depression screening/.test(t), 'both protocols are listed');
  ok(/active/.test(t) && /draft/.test(t), 'each row shows its effective status');

  if (canAuthor) {
    ok(/New Protocol/.test(t), 'an author is offered New Protocol');
    ok(!/Only a provider may author/.test(t), 'and is not shown the refusal');
  } else {
    ok(!/New Protocol/.test(t), 'a non-author is not offered New Protocol');
    ok(/Only a provider may author/.test(t), 'and is TOLD why, in the server\'s words');
  }

  // Open the active protocol.
  await page.getByText('Annual diabetic monitoring', { exact: false }).first().click();
  await page.waitForTimeout(600);
  t = await txt();
  ok(/HbA1c/.test(t) && /Lipid panel/.test(t), 'the detail lists the permitted tests');
  ok(/Registered Nurse/.test(t), 'and who may act, by label not code');
  ok(/Executed/.test(t) && /7 times/.test(t), 'and how often it has been executed');
  ok(/Version history/.test(t) && /you are reading this one/.test(t), 'the version lineage is shown');
  ok(canAuthor ? /Retire/.test(t) : !/Retire/.test(t), `Retire is ${canAuthor ? 'offered' : 'withheld'}`);
  ok(canAuthor ? /Revise/.test(t) : !/Revise/.test(t), `Revise is ${canAuthor ? 'offered' : 'withheld'}`);

  if (canAuthor) {
    // The form, and the body it sends.
    // Back to the list via the detail's own back button, then wait for the
    // list to actually be on screen before looking for its button. Clicking
    // by the word "Protocols" alone also matches the sidebar nav item.
    // The detail's own back button, not the sidebar item of the same name:
    // clicking the nav entry for the view you are already on is a no-op in
    // this page (true of every view, not just this one).
    await page.locator('button.btn.ghost', { hasText: 'Protocols' }).first().click();
    await page.waitForFunction(() => /Standing orders/.test(document.body.innerText), null, { timeout: 10000 });
    await page.getByRole('button', { name: /New Protocol/ }).first().click();
    await page.waitForFunction(() => /New standing order/.test(document.body.innerText), null, { timeout: 10000 });
    t = await txt();
    ok(/New standing order/.test(t), 'the authoring form opened');
    ok(/A provider needs no protocol/.test(t), 'it explains why a provider is not an executor option');
    ok(/authorises nothing/.test(t), 'and that an empty test list authorises nothing');

    await page.locator('input.inp').first().fill('Probe protocol');
    // Located by class, case-insensitively: `.chip` renders uppercase, and a
    // CSS text-transform changes the accessible name, so getByRole with the
    // lowercase code never matched.
    await page.locator('button.chip', { hasText: /^lab$/i }).first().click();
    await page.locator('button.chip', { hasText: /registered nurse/i }).first().click();
    await page.locator('textarea.inp').first().fill('HbA1c\n\n  \nLipid panel');
    await page.locator('input.inp').nth(1).fill('E11.9, I10');
    const dates = page.locator('input[type="date"]');
    await dates.nth(1).fill('2027-06-30');
    await page.waitForTimeout(200);

    // Activating with no signature must be refused BEFORE any request.
    await page.getByText('Sign and Activate', { exact: false }).first().click();
    await page.waitForTimeout(500);
    t = await txt();
    ok(/Sign the protocol to activate it/.test(t), 'activating unsigned is refused with a sentence');
    ok(created === null, 'and nothing was sent');

    // Save as a draft instead.
    await page.getByText('Save as Draft', { exact: false }).first().click();
    await page.waitForTimeout(800);
    ok(!!created, 'saving a draft sent a POST');
    if (created) {
      ok(created.title === 'Probe protocol', 'the title reached the request');
      ok(created.status === 'draft', 'and it was sent as a draft');
      ok(JSON.stringify(created.permittedOrderTypes) === '["lab"]', 'the order type is the CODE, not a label');
      ok(JSON.stringify(created.permittedExecutorRoles) === '["rn"]', 'the executor role is the CODE, not its label');
      ok(JSON.stringify(created.permittedTests) === '["HbA1c","Lipid panel"]',
        `blank test lines were dropped (got ${JSON.stringify(created.permittedTests)})`);
      ok(JSON.stringify(created.indications) === '["E11.9","I10"]',
        `indications split and trimmed (got ${JSON.stringify(created.indications)})`);
      ok(created.expiresAt === '2027-06-30', 'the expiry reached the request');
      ok(!('signatureImage' in created), 'an unsigned draft sends no signature key');
    }
  }
  ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
  if (process.env.GFC_PROBE_SHOT) await page.screenshot({ path: `${process.env.GFC_PROBE_SHOT}/protocols-${canAuthor ? 'provider' : 'rn'}.png`, fullPage: true });
  await ctx.close();
};

(async () => {
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    args: ['--no-sandbox']
  });
  await run(browser, port, { canAuthor: true });
  await run(browser, port, { canAuthor: false });
  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
