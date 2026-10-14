#!/usr/bin/env node
// scripts/verify_tasks_render.js — render the REAL public/clinical.html in a
// real browser and drive the patient to-dos and the daily digest (owner,
// 2026-10-13). The API is stubbed with the REAL clinicalTasks module, so the
// buckets, visibility and digest split are the shipped ones. CDN scripts are
// fetched once with curl and served locally.
//   node scripts/verify_tasks_render.js        (GFC_PROBE_SHOT=/path/x.png for pictures)
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
const T = require(path.join(root, 'clinicalTasks.js'));
let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const PROVIDER = { id: 'u-fnp', name: 'Bethel Godwins', role: 'user', clinicalRole: 'provider', hasClinicalAccess: true, licenseLevel: 'FNP' };
const RN = { id: 'u-rn', name: 'Rhea Nurse', role: 'user', clinicalRole: 'rn', hasClinicalAccess: true };
const PATIENT = { id: 'c-1', name: 'Juanita Guess', role: 'client' };
const today = '2026-10-14';
const findUser = (id) => [PROVIDER, RN, PATIENT].find(u => u.id === id) || null;
const mk = (o, actor = PROVIDER) => T.createTask({ input: o, actor, client: PATIENT, findUser });
const store = [
  mk({ title: 'Recheck potassium', dueDate: '2026-10-10', priority: 'urgent', category: 'clinical' }),
  mk({ title: 'Call daughter about PT', dueDate: today, category: 'call' }, RN),
  mk({ title: 'Fax records to cardiology', dueDate: '2026-10-17', category: 'paperwork' }),
  mk({ title: 'Ask RN to check wound', dueDate: '2026-10-16', assigneeId: RN.id })
];
store[1].assigneeId = PROVIDER.id; store[1].assigneeName = PROVIDER.name;
const posted = [];
const listFor = (qs) => {
  const q = new URLSearchParams(qs);
  const rows = T.listForViewer({ tasks: store, viewer: PROVIDER, scope: q.get('scope') || 'all', clientId: q.get('clientId'), includeClosed: q.get('includeClosed') === 'true' });
  return {
    today, tasks: T.sortTasks(rows, today).map(t => T.publicTask({ ...t, patientName: PATIENT.name }, PROVIDER, today)),
    team: [{ id: PROVIDER.id, name: PROVIDER.name }, { id: RN.id, name: RN.name }],
    categories: T.CATEGORIES, priorities: T.PRIORITIES
  };
};
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
  const page = await browser.newPage({ viewport: { width: Number(process.env.GFC_PROBE_WIDTH || 1440), height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url()); const p = u.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/clinical/tasks' && req.method() === 'POST') {
      const b = JSON.parse(req.postData() || '{}'); posted.push(b);
      const t = mk(b); store.push(t);
      return json({ task: T.publicTask({ ...t, patientName: PATIENT.name }, PROVIDER, today) }, 201);
    }
    if (p.startsWith('/api/clinical/tasks/') && req.method() === 'PUT') {
      const id = decodeURIComponent(p.split('/').pop()); const b = JSON.parse(req.postData() || '{}'); posted.push({ id, ...b });
      const i = store.findIndex(t => t.id === id);
      const r = T.applyTaskAction({ task: store[i], action: b.action, input: b, actor: PROVIDER, findUser });
      store[i] = r.task;
      return json({ task: T.publicTask({ ...r.task, patientName: PATIENT.name }, PROVIDER, today) });
    }
    if (p === '/api/clinical/tasks') return json(listFor(u.search.slice(1)));
    if (p === '/api/clinical/digest') return json(T.buildDigest({
      viewer: PROVIDER, today, tasks: store,
      inboxItems: [{ kind: 'encounter_unsigned', id: 'e1', clientId: 'c-1', patientName: PATIENT.name, label: 'Encounter documented but not signed', actionable: true }],
      results: [{ id: 'r1', clientId: 'c-1', interpretation: 'abnormal', routeTo: { userId: PROVIDER.id }, receivedAt: '2026-10-12T15:00:00Z' }],
      overdueOrders: [], orders: [],
      appointments: [{ eid: '7', clientId: 'c-1', patientName: PATIENT.name, date: '2026-10-15', startTime: '09:30', title: 'Follow-up' }],
      calendar: { ok: true }, nameOf: () => PATIENT.name
    }));
    if (p === '/api/clinical/status') return json({ configured: true, connected: true, emr: { connected: true },
      access: { canWrite: true, canManageTasks: true, clinicalRole: 'provider', capabilities: roles.capabilitiesFor(PROVIDER) } });
    if (p === '/api/clinical/patients') return json({ patients: [{ id: PATIENT.id, name: PATIENT.name }] });
    if (p === '/api/clinical/work-queues') return json({ today, overdueThresholds: { lab: 7 }, queues: { unsignedEncounters: [], unacknowledgedResults: [], openReferrals: [], overdueOrders: [] } });
    if (p.endsWith('/my-day')) return json({ date: today, visits: [], totals: { visits: 0, miles: null, openTasks: 0 }, calendar: { ok: true }, unsignedEarlier: [], openTasks: 0 });
    return json({});
  });
  await page.addInitScript((usr) => {
    try { localStorage.setItem('admin_token', 'probe'); localStorage.setItem('admin_user', JSON.stringify(usr)); } catch (e) { /* empty */ }
  }, PROVIDER);
  // Freeze the browser clock on the probe's "today" so My Day is today.
  await page.clock.setFixedTime(new Date('2026-10-14T14:00:00Z'));
  await page.goto(`${base}/clinical`, { waitUntil: 'networkidle' });
  await page.waitForSelector("text=Today's Digest", { timeout: 15000 });
  const dig = page.locator('.card', { hasText: "Today's Digest" }).first();
  const dt = await dig.innerText();
  ok('D1 My Day shows the digest with pending and coming up', /PENDING NOW/i.test(dt) && /COMING UP/i.test(dt), dt.slice(0, 300));
  ok('D2 pending carries the overdue to-do, the to-do due today, the unsigned note and the result',
    /Recheck potassium/.test(dt) && /Call daughter about PT/.test(dt) && /documented but not signed/.test(dt) && /Abnormal result to review/.test(dt));
  ok('D3 coming up carries next week\'s to-do and tomorrow\'s visit', /Fax records to cardiology/.test(dt) && /Follow-up/.test(dt));
  ok('D4 a to-do handed to someone else is not in my digest', !/Ask RN to check wound/.test(dt));
  if (process.env.GFC_PROBE_SHOT) await dig.screenshot({ path: process.env.GFC_PROBE_SHOT.replace(/\.png$/, '-digest.png') });

  await page.locator('button:has-text("Open Tasks")').first().click();
  await page.waitForSelector('text=My To-Dos');
  await page.waitForSelector('text=Recheck potassium');
  const main = async () => page.locator('main').first().innerText();
  let t = await main();
  ok('T1 Tasks opens on My To-Dos, grouped Overdue then Today then Next 7 Days',
    t.indexOf('Overdue (') >= 0 && t.indexOf('Overdue (') < t.indexOf('Today (') && t.indexOf('Today (') < t.indexOf('Next 7 Days ('), t.slice(0, 400));
  ok('T2 a handed-over to-do says who from', /From Rhea Nurse/.test(t));
  await page.locator('button:has-text("I Assigned")').click(); await page.waitForTimeout(300);
  t = await main();
  ok('T3 I Assigned shows the one I handed to the nurse', /Ask RN to check wound/.test(t) && /Assigned to Rhea Nurse/.test(t) && !/Recheck potassium/.test(t));
  await page.locator('button:has-text("Assigned to Me")').click(); await page.waitForTimeout(300);

  await page.locator('button:has-text("Add To-Do")').first().click();
  await page.locator('select').filter({ has: page.locator('option:text-is("Juanita Guess")') }).first().selectOption({ label: 'Juanita Guess' });
  await page.locator('input[placeholder^="e.g. Call daughter"]').fill('Order shower chair');
  await page.locator('input[type=date]').last().fill('2026-10-14');
  await page.locator('form button[type=submit]').click();
  await page.waitForSelector('text=Order shower chair');
  ok('T4 Add To-Do posts the patient, title and due date', posted.some(b => b.clientId === 'c-1' && b.title === 'Order shower chair' && b.dueDate === '2026-10-14'), JSON.stringify(posted));

  const row = page.locator('div.border-b', { hasText: 'Order shower chair' }).first();
  await row.locator('button[aria-label="Mark done"]').click();
  await page.waitForTimeout(400);
  ok('T5 ticking the box marks it done', posted.some(b => b.action === 'done'));
  ok('T6 a done to-do leaves the open list', !/Order shower chair/.test(await main()));
  if (process.env.GFC_PROBE_SHOT) await page.locator('main').first().screenshot({ path: process.env.GFC_PROBE_SHOT.replace(/\.png$/, '-tasks.png') });

  await page.locator('button:has-text("Work Queues")').first().click();
  await page.waitForTimeout(300);
  ok('T7 the work queues are still there', /Every documented encounter is signed/.test(await main()));
  ok('T8 no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
