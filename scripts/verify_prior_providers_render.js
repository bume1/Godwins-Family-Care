#!/usr/bin/env node
// ============================================================================
// scripts/verify_prior_providers_render.js — drive the client's own provider
// editor in a real browser and assert THE REQUEST IT SENDS.
//
// Why a probe: the thing that can silently cost a client their correction is
// not whether the screen renders, it is the `addedFrom` on each row of the PUT
// body. `resolvePriorProviders` on the server rebuilds every `intake_prefill`
// entry from the medical team on the next intake save and preserves only
// `manual` and `roi_form`. So a row the client CHANGED must arrive without
// `addedFrom` (the route stamps it `manual`, making it durable) and a row they
// did not touch must keep its own, so it still follows the medical team.
//
// A unit test can pin the page's logic. Only a browser proves the card opens,
// the fields prefill from the saved list, and the body that leaves the page is
// the one that logic intended.
//
// The API is stubbed; nothing here touches a database, Drive or OpenEMR.
// Needs Playwright + a Chromium, same as verify_portal_render.js. The three CDN
// scripts are fetched once with curl and served locally, so certificate
// checking is never switched off.
//   node scripts/verify_prior_providers_render.js
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
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok:   ' + label); } else { fail++; console.log('  FAIL: ' + label); } };

// The saved list the server would return: two intake-derived rows and one the
// client added by hand, so both sides of the addedFrom rule are exercised.
const SAVED = [
  { name: 'Northside Hospital', dept: 'Medical Records', address: '1 Main St', phone: '4045550001', fax: '4045550002', roleLabel: 'hospital', addedFrom: 'intake_prefill', activeAuthorization: null },
  { name: 'Dr Patel', dept: '', address: '', phone: '4045550003', fax: '4045559999', roleLabel: 'pcp', addedFrom: 'intake_prefill', activeAuthorization: { id: 'a1' } },
  { name: 'Dr Okafor', dept: '', address: '', phone: '', fax: '4045550004', roleLabel: 'specialist', addedFrom: 'manual', activeAuthorization: null }
];

const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jsx': 'application/javascript' };
const srv = http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u.startsWith('/portal')) u = '/portal.html';
  const f = path.join(root, 'public', u);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('nf');
});

(async () => {
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    args: ['--no-sandbox']
  });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const user = { role: 'client', name: 'Juanita Guess', slug: 'juanita-guess' };
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('portal_token', t);
    localStorage.setItem('portal_user', JSON.stringify(u));
  }, ['tok', user]);

  await page.route(/^https:\/\/(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)\//, route => {
    const u = route.request().url(); const cdn = CDN + '/';
    const file = /react-dom/.test(u) ? 'react-dom.js' : /unpkg\.com\/react@/.test(u) ? 'react.js' : /babel/.test(u) ? 'babel.js' : null;
    if (file) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(cdn + file) });
    if (/tailwindcss/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.tailwind = { config: {} };' });
    return route.fulfill({ status: 200, contentType: /\.css|css2/.test(u) ? 'text/css' : 'application/javascript', body: '' });
  });

  let putBody = null;
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url()).pathname;
    const j = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u === '/api/gfc/me') return j({
      role: 'client', name: user.name, clientName: 'Juanita', clientFullName: 'Juanita Guess',
      slug: 'juanita-guess', enrollmentStatus: 'enrolled', intakeComplete: true,
      clinicalRead: { available: false }
    });
    if (u === '/api/gfc/care-plan') return j({ greetingName: 'Juanita', carePlan: null, upcomingVisits: [], recentVisits: [] });
    if (u === '/api/gfc/transfer-roi') return j({
      patient: { patientName: 'Juanita Guess' }, patientFromRecord: {},
      priorProviders: SAVED, status: 'pending', events: [], authorizations: [], maxProviders: 10
    });
    if (u === '/api/gfc/prior-providers' && route.request().method() === 'PUT') {
      putBody = JSON.parse(route.request().postData() || '{}');
      // Echo back normalized, the way the route does.
      return j({ message: 'Prior providers saved', priorProviders: (putBody.priorProviders || []).map(p => ({ ...p, addedFrom: p.addedFrom || 'manual' })) });
    }
    if (u === '/api/gfc/documents') return j({ signedConsents: [], checklist: [], documents: [] });
    return j({});
  });

  await page.goto(`http://localhost:${port}/portal/juanita-guess`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForFunction(() => !/Loading your care portal/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);

  // Open the ROI flow. The portal mounts it from the Documents area; rather
  // than depend on that navigation, drive the component's own entry the way a
  // client reaches it: find the Documents tab, then the record-release tile.
  const docsTab = page.locator('.gfc-tabs').getByText(/Documents|Records/i).first();
  if (await docsTab.count()) { await docsTab.click(); await page.waitForTimeout(500); }
  const roiTile = page.getByText(/Authorize record release|record release|Transfer of Care/i).first();
  ok(await roiTile.count() > 0, 'the record-release entry is on the Documents screen');
  if (await roiTile.count()) { await roiTile.click(); await page.waitForTimeout(700); }

  const bodyText = () => page.locator('body').innerText();
  ok(/Update your providers/i.test(await bodyText()), 'the "Update your providers" card is on the choice screen');
  ok(/3 on file/.test(await bodyText()), 'the card says how many providers are on file');

  const card = page.getByText('Update your providers', { exact: false }).first();
  await card.click();
  await page.waitForTimeout(600);

  const t = await bodyText();
  ok(/Your providers/i.test(t), 'the editor opened');
  ok(/only updates your list/i.test(t), 'it says saving only updates the list');
  ok(/does not request any records and does not authorize anything/i.test(t), 'it says it sends and authorizes nothing');
  // Read the INPUT VALUES, not innerText: a prefilled field's value is not
  // page text, so matching innerText here failed a correct form — the same
  // class of assertion that cannot tell two states apart.
  const nameInputs = await page.locator('.fld input[type="text"]').evaluateAll(
    els => els.map(e => e.value));
  ok(['Northside Hospital', 'Dr Patel', 'Dr Okafor'].every(n => nameInputs.includes(n)),
    `all three saved providers are prefilled into their fields (saw ${JSON.stringify(nameInputs.slice(0, 6))})`);
  ok(/does not re-send it/i.test(t), 'the provider with a release in force carries the no-re-send note');

  // Change ONE field on the first (intake-derived) row and nothing else.
  const faxes = page.locator('.fld input[type="tel"]');
  const faxCount = await faxes.count();
  ok(faxCount >= 6, `the rows rendered their phone and fax inputs (found ${faxCount})`);
  const firstFax = faxes.nth(1); // row 1: phone is nth(0), fax is nth(1)
  await firstFax.fill('4045551111');
  await page.waitForTimeout(200);

  const saveBtn = page.getByText(/Save Providers/i).first();
  ok(await saveBtn.count() > 0, 'the Save Providers button is present');
  await saveBtn.click();
  await page.waitForTimeout(900);

  ok(!!putBody, 'saving sent a PUT to /api/gfc/prior-providers');
  const rows = (putBody && putBody.priorProviders) || [];
  ok(rows.length === 3, `all three rows were sent (got ${rows.length})`);

  const sent = (name) => rows.find(r => r.name === name) || {};
  // THE ASSERTION THIS PROBE EXISTS FOR.
  ok(sent('Northside Hospital').fax === '4045551111', 'the edited fax reached the request');
  ok(!('addedFrom' in sent('Northside Hospital')),
    'the CHANGED row carries NO addedFrom, so the route stamps it manual and the edit survives the next intake save');
  ok(sent('Dr Patel').addedFrom === 'intake_prefill',
    'an UNTOUCHED intake-derived row keeps its addedFrom, so it still follows the medical team');
  ok(sent('Dr Okafor').addedFrom === 'manual', 'an untouched manual row keeps manual');
  // The role must travel as the code, or the server coerces it to 'other'.
  ok(sent('Northside Hospital').roleLabel === 'hospital' && sent('Dr Patel').roleLabel === 'pcp',
    'roleLabel is sent as the code, not the display label');

  ok(/Saved/i.test(await bodyText()), 'the screen confirms the save');
  ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);

  if (process.env.GFC_PROBE_SHOT) {
    await page.screenshot({ path: `${process.env.GFC_PROBE_SHOT}/prior-providers.png`, fullPage: true });
  }
  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
