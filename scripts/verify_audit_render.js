#!/usr/bin/env node
// scripts/verify_audit_render.js — render the REAL public/audit.html in a real
// browser and read the audit log the way a Super Admin would.
//
// WHY A BROWSER AND NOT ONLY UNIT TESTS. The unit tests read the page's
// source; a source scan cannot prove a row reaches the screen, that a
// timestamp renders in Eastern rather than in the container's zone, or that
// the cap warning appears when the log is actually full. Both of this page's
// real defects so far were found by running it, not by reading it.
//
// The route is stubbed. Rows are shaped exactly as auditLog.js builds them,
// including the impersonation fields, so what renders is the real row shape.
//   node scripts/verify_audit_render.js        (GFC_PROBE_SHOT=/path/x.png for pictures)
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
  ['babel.js', 'https://unpkg.com/@babel/standalone@7/babel.min.js', /https:\/\/unpkg\.com\/@babel[^"]*/]
];
for (const [file, url] of CDN_FILES) {
  const f = path.join(CDN, file);
  if (!fs.existsSync(f) || fs.statSync(f).size < 1000) execFileSync('curl', ['-sSL', '-m', '90', '-o', f, url]);
}

// THE PROBE'S OWN PRECONDITION. The Eastern assertion below only
// distinguishes two states while this process is NOT already in Eastern:
// run it in New York and a page that formats in the viewer's own zone passes
// it. Production containers are UTC, which is the case worth testing.
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (/New_York/.test(String(HOST_TZ))) {
  console.log(`SKIP: this host is already ${HOST_TZ}, so the Eastern checks would pass either way. Re-run with TZ=UTC.`);
  process.exit(0);
}

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Rows in the shape auditLog.js's `record` builds. 14:00Z on 2026-11-06 is
// 09:00 in Georgia (EST, UTC-5) — the whole point of the Eastern assertion.
const ROWS = [
  { auditId: '9', id: 'r9', timestamp: '2026-11-06T14:00:07.000Z', userId: 'u-fnp', userName: 'Bethel Godwins',
    role: 'user', action: 'emr_read', entityType: 'encounter', entityId: '481',
    patientId: 'p-uuid-juanita', actingFor: null, resource: '/api/clinical/patients/c-1/chart',
    method: 'GET', ipHash: 'abc', requestId: 'rq-9', details: { sections: ['problems', 'medications'] } },
  { auditId: '8', id: 'r8', timestamp: '2026-11-06T13:31:00.000Z', userId: 'u-coord', userName: 'Carla Coordinator',
    role: 'user', action: 'appointment_created', entityType: 'appointment', entityId: '77',
    patientId: 'p-uuid-juanita', actingFor: null, resource: '/api/clinical/patients/c-1/appointments',
    method: 'POST', ipHash: 'abc', requestId: 'rq-8', details: null },
  { auditId: '7', id: 'r7', timestamp: '2026-11-06T12:05:00.000Z', userId: 'u-poa', userName: 'Marcus Guess',
    role: 'family', action: 'care_plan_cosign', entityType: 'care_plan', entityId: '2',
    patientId: 'p-uuid-juanita', actingFor: 'c-1', resource: '/api/gfc/care-plan/cosign',
    method: 'POST', ipHash: 'abc', requestId: 'rq-7', details: { version: 2 } },
  { auditId: '6', id: 'r6', timestamp: '2026-11-05T20:00:00.000Z', userId: 'u-fnp', userName: 'Bethel Godwins',
    role: 'user', action: 'portal_publish', entityType: 'encounter', entityId: '480',
    patientId: 'p-uuid-juanita', actingFor: null, resource: '/api/clinical/encounters/x/publish',
    method: 'POST', ipHash: 'abc', requestId: 'rq-6',
    impersonatorId: 'u-admin', impersonatorName: 'GFC Admin',
    details: { actingAsBy: 'u-admin', actingAsByName: 'GFC Admin' } }
];

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/audit') {
      let html = fs.readFileSync(path.join(root, 'public', 'audit.html'), 'utf8');
      for (const [file, , re] of CDN_FILES) html = html.replace(re, `/cdn/${file}`);
      // Fonts and the icon font are decoration and are not reachable here.
      html = html.replace(/<link[^>]*(fonts\.googleapis|fonts\.gstatic|tabler-icons)[^>]*>/g, '');
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
  const page = await browser.newPage({ viewport: { width: Number(process.env.GFC_PROBE_WIDTH || 1440), height: 1100 } });
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(String(e)));

  // What the page asked for, so the Eastern resolution of the date filters is
  // read off the real request rather than off the input box.
  const queries = [];
  let mode = 'rows';           // rows | capped | empty | forbidden
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    queries.push(u.search);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname !== '/api/admin/audit-log') return json({});
    if (mode === 'forbidden') return json({ error: 'Super Admin access required' }, 403);
    const limit = parseInt(u.searchParams.get('limit') || '200', 10);
    if (mode === 'empty') return json({ rows: [], count: 0, total: 48213 });
    if (mode === 'capped') {
      const rows = Array.from({ length: limit }, (_, i) => ({ ...ROWS[0], auditId: String(1000 - i), id: `c${i}` }));
      return json({ rows, count: rows.length, total: 48213 });
    }
    const uid = u.searchParams.get('userId');
    const rows = uid ? ROWS.filter(r => r.userId === uid) : ROWS;
    return json({ rows, count: rows.length, total: 48213 });
  });

  await page.addInitScript(() => {
    localStorage.setItem('admin_token', 'probe-token');
    localStorage.setItem('admin_user', JSON.stringify({ id: 'u-admin', name: 'GFC Admin', role: 'admin' }));
  });
  await page.goto(base + '/audit', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr', { timeout: 20000 });

  // ---- 1. the log reaches the screen ----------------------------------------
  const bodyRows = () => page.$$eval('table tbody tr', trs =>
    trs.filter(tr => tr.children.length > 1).length);
  ok('the log renders one row per entry', await bodyRows() === 4, `saw ${await bodyRows()}`);
  const text = () => page.$eval('body', b => b.innerText);
  let t = await text();
  ok('the token went in the header, so the read succeeded', !/cannot read it|Request failed/.test(t));
  ok('the total recorded count is shown', /48,213 recorded in total/.test(t), t.slice(0, 300));

  // ---- 2. the clock ---------------------------------------------------------
  const first = await page.$eval('table tbody tr td', td => td.innerText.trim());
  ok('a 14:00Z entry renders as 9am, not 2pm (Eastern, not the container)',
    /09:00:07\s*AM/.test(first), first);
  ok('seconds are shown, because a burst inside one minute is what an auditor reads',
    /:07/.test(first), first);
  // Case-insensitive on purpose: the header is `text-transform: uppercase`,
  // so innerText comes back "WHEN (EASTERN)". Matching the source casing
  // failed here while the page was perfectly correct — the same trap as
  // locating a .chip by its accessible name.
  ok('the column header says the times are Eastern', /when \(eastern\)/i.test(t),
    (await page.$$eval('th', ths => ths.map(x => x.innerText))).join(' | '));

  // ---- 3. who, including the parts that are easy to miss --------------------
  ok('the acting staff member is named', /Bethel Godwins/.test(t));
  ok('an impersonated action says whose session carried it',
    /via GFC Admin/.test(t), 'the "View as" row did not declare its impersonator');
  ok('a POA action says who it was for', /acting for c-1/.test(t));
  ok('the request verb is shown', (await page.$$eval('.chip', els => els.map(e => e.innerText.trim()))).includes('GET'));
  ok('the resource path is shown', /\/api\/clinical\/patients\/c-1\/chart/.test(t));
  ok('the patient the row is about is shown', /p-uuid-juanita/.test(t));

  // ---- 4. detail is there when there is detail, and not when there is not ---
  const detailButtons = await page.$$('button.lnk');
  ok('only the rows that carry detail offer it', detailButtons.length === 3, `saw ${detailButtons.length}`);
  await detailButtons[0].click();
  t = await text();
  ok('opening detail shows what was recorded', /"medications"/.test(t));
  await page.$eval('button.lnk', b => b.click());
  t = await text();
  ok('detail closes again', !/"medications"/.test(t));

  // ---- 5. the cap, which is the honest part ---------------------------------
  ok('a short page does not warn about a cap it never reached', !/newest 200 in the window/.test(t));
  ok('nothing on the page offers to page through the log', !/load more/i.test(t));

  mode = 'capped';
  await page.$eval('button.btn', b => b.click());
  await page.waitForFunction(() => /newest/i.test(document.body.innerText), { timeout: 15000 });
  t = await text();
  ok('a full page says it is only the newest in the window', /newest 200 in the window, not all of them/i.test(t));
  ok('it says narrowing the dates is how to reach older entries', /narrowing the From and To dates/.test(t));
  ok('it says a bigger row count does not reach further back', /only moves the cap/.test(t));
  ok('even at the cap there is no paging control', !/load more/i.test(t));

  // ---- 6. the filters, read off the real request ----------------------------
  mode = 'rows';
  queries.length = 0;
  await page.fill('input[type="datetime-local"] >> nth=0', '2026-11-06T09:00');
  await page.fill('input[type="datetime-local"] >> nth=1', '2026-11-06T17:00');
  await page.$eval('button.btn', b => b.click());
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, { timeout: 15000 });
  const q = new URLSearchParams(queries[queries.length - 1]);
  ok('a 9am Eastern "from" is sent as 14:00Z, not as a zoneless local string',
    q.get('since') === '2026-11-06T14:00:00.000Z', q.get('since'));
  ok('the "to" box is resolved the same way',
    q.get('until') === '2026-11-06T22:00:00.000Z', q.get('until'));

  queries.length = 0;
  await page.fill('input[placeholder="exact id"]', 'u-coord');
  await page.$eval('button.btn', b => b.click());
  await page.waitForFunction(() => document.body.innerText.includes('Showing 1 entry'), { timeout: 15000 });
  t = await text();
  ok('a staff filter narrows to that person', /Carla Coordinator/.test(t) && !/Bethel Godwins/.test(t));
  ok('one row reads "entry", not "entrys"', /Showing 1 entry\b/.test(t));

  // Clear puts every box back and re-reads with no filters at all.
  queries.length = 0;
  await page.$eval('button.btn.ghost', b => b.click());
  await page.waitForFunction(() => document.body.innerText.includes('Showing 4 entries'), { timeout: 15000 });
  const cleared = new URLSearchParams(queries[queries.length - 1]);
  ok('Clear drops every filter and keeps only the row count',
    [...cleared.keys()].join(',') === 'limit', [...cleared.keys()].join(','));

  // ---- 7. an empty result is not a diagnosis --------------------------------
  mode = 'empty';
  await page.$eval('button.btn', b => b.click());
  await page.waitForFunction(() => document.body.innerText.includes('No entries match'), { timeout: 15000 });
  t = await text();
  ok('an empty result is reported as a statement about the filters, not the log',
    /not the same as nothing having happened/.test(t));

  // ---- 8. a 403 says what is actually wrong ---------------------------------
  mode = 'forbidden';
  await page.$eval('button.btn', b => b.click());
  await page.waitForFunction(() => /cannot read it/.test(document.body.innerText), { timeout: 15000 });
  t = await text();
  ok('a refused read names the permission, not an empty log',
    /Super Admin/.test(t) && !/No entries match/.test(t));

  if (process.env.GFC_PROBE_SHOT) {
    mode = 'rows';
    await page.$eval('button.btn', b => b.click());
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.GFC_PROBE_SHOT, fullPage: true });
    console.log(`  shot ${process.env.GFC_PROBE_SHOT}`);
  }

  ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close(); srv.close();
  console.log(`\n${pass}/${pass + fails.length} checks passed`);
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
