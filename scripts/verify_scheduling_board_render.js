#!/usr/bin/env node
// ============================================================================
// scripts/verify_scheduling_board_render.js — render the REAL public/scheduling.html
// in a real browser and drive the master-calendar bar (owner report, 2026-10-05:
// "There is no multiselector ... just add the multiselect and delete to the same
// group time entry bar ... selects all shifts between x and y date range ...
// Additionally we should be able to filter out those completed, confirmed and
// pending.").
//
// Why a probe and not only unit tests: every one of those asks is behaviour in
// the browser. esbuild compiling the page proves the JSX parses, not that a tick
// box exists, that "select all" selects what the filter left, or that a shift
// ticked and then filtered out stays out of the request body. The last of those
// is the one that matters — acting on a row nobody can see is the hazard a
// selection outliving its filter creates — and it is only observable by reading
// the POST the page actually sends.
//
// The API is stubbed; nothing here touches a database, OpenEMR or Drive. The
// three CDN scripts the page loads are fetched once with curl into $GFC_CDN_DIR
// and served locally, so the browser is never asked to trust a proxy CA and
// certificate checking is never switched off.
//   node scripts/verify_scheduling_board_render.js
// Exit code 0 = every assertion held.
// ============================================================================
const http = require('http'); const fs = require('fs'); const path = require('path');
const os = require('os'); const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const pwPath = process.env.PLAYWRIGHT_MODULE || 'playwright';
let chromium;
try { ({ chromium } = require(pwPath)); } catch (e) {
  try { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright'))); }
  catch (e2) { console.log('SKIP: Playwright is not installed (npm i -g playwright).'); process.exit(0); }
}
const CDN = process.env.GFC_CDN_DIR || path.join(os.tmpdir(), 'gfc-sched-render-cdn');
fs.mkdirSync(CDN, { recursive: true });
for (const [file, url] of [
  ['react.js', 'https://unpkg.com/react@18/umd/react.production.min.js'],
  ['react-dom.js', 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js'],
  ['babel.js', 'https://unpkg.com/@babel/standalone@7/babel.min.js']
]) {
  const f = path.join(CDN, file);
  if (!fs.existsSync(f) || fs.statSync(f).size < 1000) execFileSync('curl', ['-sSL', '-m', '90', '-o', f, url]);
}

const T = require(path.join(root, 'public', 'gfc-time.js'));
let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Every fixture time is built from a Georgia calendar date, never by slicing a
// UTC string: the whole point of the range filter is that it buckets by the day
// it is in Georgia.
const at = (isoDate, hhmm) => T.instantFromZoned(isoDate, hhmm);
const shift = (id, isoDate, status, clientName) => ({
  id, status, clientName,
  start: at(isoDate, '09:00'), end: at(isoDate, '13:00'),
  requiredLicenseLevel: null, levelRequirementLabel: 'Open to all license levels',
  poolVisibility: 'all_eligible', caregiverName: status === 'open' ? null : 'Tasha Green'
});
const SHIFTS = [
  shift('s-open-0901', '2026-09-01', 'open', 'Dorothy Martuscello'),
  shift('s-conf-1002', '2026-10-02', 'confirmed', 'Juanita Guess'),
  shift('s-done-1003', '2026-10-03', 'completed', 'Dorothy Martuscello'),
  shift('s-clam-1004', '2026-10-04', 'claimed', 'Juanita Guess'),
  shift('s-canc-1005', '2026-10-05', 'cancelled', 'Dorothy Martuscello'),
  shift('s-open-1106', '2026-11-06', 'open', 'Juanita Guess')
];
const IN_OCT = ['s-conf-1002', 's-done-1003', 's-clam-1004', 's-canc-1005'];

const posted = [];   // every POST body the page sends

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const serve = (file, type) => {
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(file));
    };
    if (url === '/' || url === '/scheduling') {
      let html = fs.readFileSync(path.join(root, 'public', 'scheduling.html'), 'utf8')
        .replace(/https:\/\/unpkg\.com\/react@18[^"]*/, '/cdn/react.js')
        .replace(/https:\/\/unpkg\.com\/react-dom@18[^"]*/, '/cdn/react-dom.js')
        .replace(/https:\/\/unpkg\.com\/@babel[^"]*/, '/cdn/babel.js');
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    if (url.startsWith('/cdn/')) return serve(path.join(CDN, path.basename(url)), 'application/javascript');
    if (url === '/gfc-time.js') return serve(path.join(root, 'public', 'gfc-time.js'), 'application/javascript');
    if (url === '/session-guard.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end('// stubbed'); return; }
    res.writeHead(404); res.end('');
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = { json: {} };
    if (req.method() === 'POST') {
      try { posted.push({ path: url.pathname, body: JSON.parse(req.postData() || '{}') }); } catch (e) { /* empty */ }
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ message: 'Done.', updated: ['x'], unchanged: [], refused: [], cancelled: [], deleted: [] }) });
    }
    if (url.pathname.endsWith('/caregivers')) // `clients` is NOT optional: the tab strip counts the ones with no
      // coordinates. A fake missing what production supplies exercises a
      // different function — the probe's first run proved it by crashing here.
      body.json = { caregivers: [], clients: [], access: { manageSchedule: true, managePay: true, manageLocations: true } };
    else if (url.pathname.endsWith('/shifts')) body.json = { shifts: SHIFTS };
    else if (url.pathname.endsWith('/shift-requests')) body.json = { shiftRequests: [] };
    else if (url.pathname.endsWith('/availability')) body.json = { availability: [] };
    else if (url.pathname.includes('time-logs')) body.json = { timeLogs: [], totalHours: 0 };
    else if (url.pathname.endsWith('/change-requests')) body.json = { requests: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.json) });
  });

  await page.addInitScript(() => { try { localStorage.setItem('admin_token', 'probe'); } catch (e) { /* empty */ } });
  page.on('console', m => { if (process.env.GFC_PROBE_DEBUG) console.log('   [console]', m.type(), m.text()); });
  await page.goto(`${base}/scheduling`, { waitUntil: 'networkidle' });
  try { await page.waitForSelector('.calhdr', { timeout: 15000 }); }
  catch (e) {
    console.log('   url:', page.url());
    console.log('   body:', (await page.content()).slice(0, 1200));
    console.log('   pageErrors:', pageErrors.join(' | '));
    throw e;
  }

  // --- A. The board is a multiselect with no mode to switch into -----------
  await page.click('button:has-text("List")');
  await page.waitForTimeout(150);
  const boxes = await page.locator('.row input[type="checkbox"]').count();
  ok('A1 every listed shift carries a tick box with no "Select shifts" step first', boxes === SHIFTS.length, `found ${boxes} of ${SHIFTS.length}`);
  ok('A2 the old mode switch is gone', (await page.locator('button:has-text("Done selecting")').count()) === 0
    && (await page.locator('button:has-text("Edit together")').count()) === 0);

  // --- B. Select all takes exactly what the board is showing ---------------
  const selectAll = page.locator('input[aria-label="Select every shift the board is showing"]');
  ok('B1 the bar carries a select-all', await selectAll.count() === 1);
  await selectAll.check();
  await page.waitForTimeout(120);
  ok('B2 select-all ticks every shift', (await page.locator('.bulkbar .mu').first().innerText()).startsWith(`${SHIFTS.length} selected`),
    await page.locator('.bulkbar .mu').first().innerText());

  // --- C. The date range IS the selector ----------------------------------
  await selectAll.uncheck();
  await page.fill('input[type="date"] >> nth=0', '2026-10-01');
  await page.fill('input[type="date"] >> nth=1', '2026-10-31');
  await page.waitForTimeout(150);
  const shownInOct = await page.locator('.row input[type="checkbox"]').count();
  ok('C1 the range narrows the board to October', shownInOct === IN_OCT.length, `showed ${shownInOct}`);
  await selectAll.check();
  await page.waitForTimeout(120);
  ok('C2 select-all over a range takes only that range',
    (await page.locator('.bulkbar .mu').first().innerText()).startsWith(`${IN_OCT.length} selected`));

  // --- D. Status filters ---------------------------------------------------
  await page.click('.fbar label:has-text("Completed") input');
  await page.click('.fbar label:has-text("Cancelled") input');
  await page.waitForTimeout(150);
  const afterStatus = await page.locator('.row input[type="checkbox"]').count();
  ok('D1 unticking Completed and Cancelled removes them', afterStatus === IN_OCT.length - 2, `showed ${afterStatus}`);
  const counted = await page.locator('.bulkbar .mu').first().innerText();
  ok('D2 the bar says the filtered-out ticks are left alone', /ticked but filtered out, and left alone/.test(counted), counted);

  // --- E. Edit and remove are one bar -------------------------------------
  // THE WHOLE POINT OF THE OWNER'S INSTRUCTION: filter, select, edit and remove
  // are ONE bar. Anchoring on the master-calendar card is what makes this an
  // assertion about that rather than about a panel that happens to exist.
  const card = page.locator('.card', { hasText: 'Master calendar' }).first();
  ok('E1 filter, select-all, the time boxes and Remove are all in the one card',
    (await card.locator('input[type="time"]').count()) === 2
    && (await card.locator('button.danger').count()) === 1
    && (await card.locator('button.gold:has-text("Update")').count()) === 1
    && (await card.locator('input[type="date"]').count()) === 2
    && (await card.locator('input[aria-label="Select every shift the board is showing"]').count()) === 1);
  ok('E2 Remove will not fire without a reason', await card.locator('button.danger').isDisabled());

  // --- F. THE ONE THAT MATTERS: a filtered-out tick is never sent ----------
  await card.locator('button.gold:has-text("Update")').click();
  await page.waitForTimeout(400);
  const edit = posted.find(p => p.path.endsWith('/bulk-edit'));
  ok('F1 the update posts', !!edit);
  const sent = (edit && edit.body.shiftIds) || [];
  ok('F2 it sends only what is on screen — never the two filtered out',
    sent.length === IN_OCT.length - 2 && !sent.includes('s-done-1003') && !sent.includes('s-canc-1005'),
    JSON.stringify(sent));
  ok('F3 and never a shift outside the date range',
    !sent.includes('s-open-0901') && !sent.includes('s-open-1106'), JSON.stringify(sent));

  ok('G1 no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // A picture of the bar, for whoever reported it. Off unless asked for, so an
  // ordinary run writes nothing.
  if (process.env.GFC_PROBE_SHOT) {
    await page.locator('.fbar label:has-text("Completed") input').check();
    await page.locator('.fbar label:has-text("Cancelled") input').check();
    await selectAll.check();
    await page.waitForTimeout(200);
    await page.screenshot({ path: process.env.GFC_PROBE_SHOT, fullPage: !!process.env.GFC_PROBE_SHOT_FULL });
    console.log(`  shot  ${process.env.GFC_PROBE_SHOT}`);
  }

  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { fails.forEach(f => console.log(`  - ${f}`)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
