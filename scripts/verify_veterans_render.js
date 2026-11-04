#!/usr/bin/env node
// ============================================================================
// scripts/verify_veterans_render.js — render the REAL public/clinical.html in a
// real browser and use the Veterans (IME) screens (owner, 2026-11-04: the IME
// line keeps its own lane, and a provider needs a forward view of their exam
// days rather than one day at a time).
//
// What it checks:
//   A. #veterans opens on the EXAM DAY view: today's rows, with the day-of
//      buttons (Mark Seen / No Show) present.
//   B. Upcoming asks the server for a WINDOW, groups it by exam day with a
//      count per day, and carries NO day-of buttons — those belong on the day.
//   C. "Open day" on a group header carries you to that day, where the buttons
//      are, which is the one place a status is changed.
//   D. An over-long window is reported as shortened rather than silently cut.
//
// The roster responses are built by the REAL veteranRoster module, the way the
// server's route builds them, so the probe exercises the shipped contract.
//   node scripts/verify_veterans_render.js
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
const vet = require(path.join(root, 'veteranRoster.js'));
const myDay = require(path.join(root, 'myDay.js'));
const T = require(path.join(root, 'public', 'gfc-time.js'));

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const DOC = { id: 'u-fnp', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', clinicalRoleConfirmed: true, hasClinicalAccess: true, licenseLevel: 'FNP', phone: '(912) 555-0101' };
const TODAY = T.zonedParts(new Date()).isoDate;
const D7 = T.addDays(TODAY, 7);
const D21 = T.addDays(TODAY, 21);

// Surnames fight the dates on purpose, so a surname-only ordering would show.
const ROWS = [
  { id: 'r-today', firstName: 'James', lastName: "O'Brien", dob: '1970-05-04', examDate: TODAY, site: 'savannah', providerUserId: DOC.id, status: 'arrived', arrivedAt: new Date().toISOString(), arrivalPhone: '(912) 555-7777', createdAt: new Date().toISOString() },
  { id: 'r-d7-z', firstName: 'Zoe', lastName: 'Zane', dob: '1960-03-03', examDate: D7, site: 'savannah', providerUserId: DOC.id, status: 'expected', createdAt: new Date().toISOString() },
  { id: 'r-d7-b', firstName: 'Bo', lastName: 'Baker', dob: '1961-01-01', examDate: D7, site: 'savannah', providerUserId: DOC.id, status: 'expected', createdAt: new Date().toISOString() },
  { id: 'r-d21-a', firstName: 'Abe', lastName: 'Adams', dob: '1962-02-02', examDate: D21, site: 'savannah', providerUserId: DOC.id, status: 'expected', createdAt: new Date().toISOString() }
];

const run = async (scenario) => {
  const asked = [];
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
    const u = new URL(req.url());
    const p = u.pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') return json({ message: 'Saved' });
    if (p === '/api/clinical/status') return json({ configured: true, connected: true, emr: { connected: true },
      access: { canWrite: true, clinicalRole: roles.resolveClinicalRole(DOC), capabilities: roles.capabilitiesFor(DOC), credentialCeiling: roles.ceilingFor(DOC) } });
    if (p === '/api/veterans/roster') {
      // The REAL route's own shape, built by the REAL module.
      const q = Object.fromEntries(u.searchParams.entries());
      asked.push(q);
      const range = vet.rosterRange(q, TODAY);
      const rows = vet.rowsInRange(ROWS, range, { providerUserId: DOC.id }).map(r => vet.publicRow(r, DOC.name));
      return json({
        date: range.from, from: range.from, to: range.to, capped: range.capped,
        today: TODAY, office: false, rows,
        providers: [{ id: DOC.id, name: DOC.name, hasPhone: true, hasEmail: true }],
        statuses: vet.STATUS_LABELS, settable: vet.SETTABLE_STATUSES,
        maxRangeDays: vet.RANGE_MAX_DAYS, defaultRangeDays: vet.RANGE_DEFAULT_DAYS
      });
    }
    if (p === '/api/clinical/patients') return json({ patients: [] });
    if (p.endsWith('/my-day')) {
      // The `ime` block is built by the REAL modules the way the route builds
      // it, so this exercises the shipped contract rather than a hand-written
      // shape the server never produces.
      const d = myDay.buildMyDay({
        date: TODAY, appointments: [], clientsById: new Map(), timingsByEid: new Map(),
        signedEids: new Set(), unsignedEarlier: [], openTasks: 0, blocks: [], homeVisitFields: [],
        imeExams: vet.rowsInRange(ROWS, vet.rosterRange({ date: TODAY }, TODAY), { providerUserIds: [DOC.id] })
          .map(r => vet.examDayRow(r, DOC.name))
      });
      return json({ ...d, plot: myDay.plotStops({ stops: d.visits }), calendar: { ok: true }, providerId: null, locked: false });
    }
    if (p === '/api/clinical/inbox') return json({ items: [], counts: { total: 0, actionable: 0, overdue: 0 } });
    return json({});
  });
  await page.addInitScript((user) => {
    try { localStorage.setItem('admin_token', 'probe'); localStorage.setItem('admin_user', JSON.stringify(user)); } catch (e) { /* empty */ }
  }, DOC);
  try {
    await page.goto(`${base}/clinical#veterans`, { waitUntil: 'networkidle' });
    await scenario(page, asked);
  } catch (e) {
    console.log('   body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 2000));
    fails.push(`scenario threw: ${e.message.split('\n')[0]}`);
    console.log(`FAIL  scenario threw: ${e.message}`);
  }
  ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close(); srv.close();
};

(async () => {
  await run(async (page, asked) => {
    const body = () => page.locator('body').innerText();

    // ── A. the exam-day view ────────────────────────────────────────────────
    console.log('\nA. #veterans opens on the exam day');
    await page.waitForSelector('text=Veterans', { timeout: 20000 });
    let txt = await body();
    ok('today\'s veteran is listed', /O'Brien/.test(txt), txt.slice(0, 400));
    ok('a veteran on a later exam day is NOT on the day view', !/Zane/.test(txt));
    ok('the day-of buttons are on the day view', await page.locator('button:has-text("Mark Seen")').count() > 0);
    ok('the first read asked for one day', asked.length > 0 && asked[0].date === TODAY && !asked[0].from, JSON.stringify(asked[0]));

    // ── B. the forward schedule ─────────────────────────────────────────────
    console.log('\nB. Upcoming is a window, grouped by exam day');
    await page.locator('button:has-text("Upcoming")').click();
    await page.waitForFunction(() => /Open day/.test(document.body.innerText), null, { timeout: 15000 });
    txt = await body();
    const ranged = asked.filter(q => q.from && q.to);
    ok('Upcoming asked for a window, not a day', ranged.length > 0 && ranged[0].from === TODAY, JSON.stringify(ranged[0]));
    ok('every booked exam in the window is listed', /Zane/.test(txt) && /Baker/.test(txt) && /Adams/.test(txt));
    ok('the window is summarised with a count of exams and days', /4 exams across 3 days/.test(txt), txt.slice(0, 500));
    ok('each exam day is its own group with its own count', (await page.locator('button:has-text("Open day")').count()) === 3);
    // The whole reason the forward view is read-only.
    ok('the day-of buttons are NOT on the forward view', (await page.locator('button:has-text("Mark Seen")').count()) === 0);
    ok('the day a group covers is named', new RegExp(String(Number(D7.slice(5, 7)))).test(txt));

    // Date order must beat surname order: Baker and Zane (the nearer day)
    // both precede Adams, who sorts first alphabetically.
    const iBaker = txt.indexOf('Baker'), iZane = txt.indexOf('Zane'), iAdams = txt.indexOf('Adams');
    ok('the nearer exam day comes first even when surnames disagree', iBaker < iAdams && iZane < iAdams, `baker=${iBaker} zane=${iZane} adams=${iAdams}`);

    // ── C. Open day carries you to where the buttons are ───────────────────
    console.log('\nC. Open day goes to that exam day');
    await page.locator('button:has-text("Open day")').nth(1).click();
    await page.waitForFunction(() => /Mark Seen/.test(document.body.innerText), null, { timeout: 15000 });
    txt = await body();
    ok('the day view opened on the chosen day', /Zane/.test(txt) && /Baker/.test(txt) && !/Adams/.test(txt), txt.slice(0, 400));
    ok('the day-of buttons are back', await page.locator('button:has-text("Mark Seen")').count() > 0);
    ok('and it asked for that one day', asked[asked.length - 1].date === D7, JSON.stringify(asked[asked.length - 1]));

    // ── D. an over-long window says it was shortened ───────────────────────
    console.log('\nD. an over-long window is reported, not silently cut');
    const shortened = vet.rosterRange({ from: TODAY, to: T.addDays(TODAY, 400) }, TODAY);
    ok('the module reports the cap so the screen can say it', shortened.capped === true && shortened.to === T.addDays(TODAY, vet.RANGE_MAX_DAYS));
  });

  // ── E. My Day shows the exam day beside the clinical day ─────────────────
  // Owner, 2026-11-04: one screen, two lines, labelled — and the exam half is
  // read-only, because status is marked on the Veterans board and nowhere else.
  await run(async (page) => {
    console.log('\nE. My Day carries the day\'s IME exams, read-only');
    await page.locator('a:has-text("My Day"), button:has-text("My Day")').first().click().catch(() => {});
    await page.waitForFunction(() => /IME Exams/i.test(document.body.innerText), null, { timeout: 20000 });
    const txt = await page.locator('body').innerText();
    ok('the exam block is labelled as IME, not mixed into the visits', /IME Exams/i.test(txt));
    ok("today's veteran is on My Day", /O'Brien/.test(txt), txt.slice(0, 600));
    ok('a veteran booked for a later exam day is NOT on today', !/Zane/.test(txt) && !/Adams/.test(txt));
    ok('the site is named', /Savannah clinic/.test(txt));
    ok('the status is shown', /Arrived/.test(txt));
    // The whole point of holding the two lines apart.
    ok('no status buttons on My Day — status is marked on the board',
      (await page.locator('button:has-text("Mark Seen")').count()) === 0 &&
      (await page.locator('button:has-text("No Show")').count()) === 0);
    ok('the exam count is in the day footer', /1 IME exam\b/.test(txt), txt.slice(-700));
    ok('an exam day with no clinical visits says so without claiming an empty day',
      /No clinical visits scheduled/.test(txt), txt.slice(0, 900));
    // GFC_PROBE_SHOT=<dir> writes the rendered screen out, for a human to look
    // at. Off by default: a probe's job is the assertions above.
    if (process.env.GFC_PROBE_SHOT) {
      await page.screenshot({ path: path.join(process.env.GFC_PROBE_SHOT, 'my-day-ime.png'), fullPage: true });
    }
    // It links to the one place a status IS changed.
    await page.locator('button:has-text("Open Board")').first().click();
    await page.waitForFunction(() => /Mark Seen/.test(document.body.innerText), null, { timeout: 15000 });
    ok('Open Board carries you to the Veterans board, where status is marked',
      (await page.locator('button:has-text("Mark Seen")').count()) > 0);
  });

  console.log(`\n${pass}/${pass + fails.length} checks passed.`);
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
