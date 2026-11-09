#!/usr/bin/env node
// scripts/verify_staff_record_render.js — render the REAL staff record in
// User Management and the caregiver app's filings in a real browser (owner,
// 2026-11-09). The API is stubbed in the shapes the routes return.
//   node scripts/verify_staff_record_render.js     (GFC_PROBE_SHOT=/dir for pictures)
const http = require('http'); const fs = require('fs'); const path = require('path');
const os = require('os'); const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed.'); process.exit(0);
}
const CDN = process.env.GFC_CDN_DIR || path.join(os.tmpdir(), 'gfc-clinical-render-cdn');
fs.mkdirSync(path.join(CDN, 'fonts'), { recursive: true });
const CDN_FILES = [
  ['react.js', 'https://unpkg.com/react@18/umd/react.production.min.js', /https:\/\/unpkg\.com\/react@18[^"]*/g],
  ['react-dom.js', 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js', /https:\/\/unpkg\.com\/react-dom@18[^"]*/g],
  ['babel.js', 'https://unpkg.com/@babel/standalone@7/babel.min.js', /https:\/\/unpkg\.com\/@babel[^"]*/g],
  ['tailwind.js', 'https://cdn.tailwindcss.com', /https:\/\/cdn\.tailwindcss\.com[^"]*/g],
  ['tabler.css', 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.1.0/dist/tabler-icons.min.css', /https:\/\/cdn\.jsdelivr\.net\/npm\/@tabler[^"]*/g],
  ['fonts/tabler-icons.woff2', 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.1.0/dist/fonts/tabler-icons.woff2', null]
];
for (const [file, url] of CDN_FILES) {
  const f = path.join(CDN, file);
  if (!fs.existsSync(f) || fs.statSync(f).size < 1000) execFileSync('curl', ['-sSL', '-m', '90', '-o', f, url]);
}

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ADMIN = { id: 'a1', name: 'Bianca Ume', email: 'admin@example.test', role: 'admin', accountType: 'admin' };
const CG = { id: 'c1', name: 'Cara Giver', email: 'cara@example.test', role: 'vendor', accountType: 'caregiver', licenseLevel: 'cna', skilledCompetencies: [] };
const RN = { id: 'r1', name: 'Rae Nurse', email: 'rae@example.test', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
let viewer = ADMIN;

const visitLog = { id: 'v1', caregiverId: 'c1', clientName: 'Ada Bell', visitType: 'PCA visit', visitDate: '2026-11-07', status: 'submitted',
  submittedAt: '2026-11-07T18:00:00Z', reviews: [{ id: 'rv1', note: 'Thanks, all clear.', byName: 'Rae Nurse' }],
  detail: { tasks: [{ label: 'Bathing', done: true }, { label: 'Meal prep', done: false, note: 'Client declined' }], measurements: [], narratives: [{ label: 'Notes', value: 'Client in good spirits.' }], patientCondition: ['Alert'], satisfaction: 'Satisfied' } };
const escalation = { id: 'e1', caregiverId: 'c1', clientName: 'Ada Bell', concernType: 'clinical', status: 'resolved', description: 'Swelling in left ankle.',
  raisedAt: '2026-11-05T15:00:00Z', notified: [{ name: 'Rae Nurse', role: 'RN' }],
  trail: [{ status: 'acknowledged', at: '2026-11-05T16:00:00Z', byName: 'Rae Nurse' }, { status: 'resolved', at: '2026-11-06T10:00:00Z', byName: 'Rae Nurse', note: 'Seen at visit; elevated.' }] };

const json = (res, body, status) => { res.writeHead(status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const API = {
  '/api/users': () => [ADMIN, CG, RN],
  '/api/my/admin/people/c1/documents': () => ({ documents: [{ id: 'd1', kind: 'timesheet', fileName: 'week.pdf', status: 'received', uploadedAt: '2026-11-02' }],
    signed: [{ id: 'packet', title: 'Caregiver welcome packet', signedAt: '2026-10-20T12:00:00Z', pdf: 'packet' }] }),
  '/api/my/admin/people/r1/documents': () => ({ documents: [], signed: [{ id: 'ack:x', title: 'Field Addendum', version: '2', signedAt: '2026-10-01', current: true, links: [] }] }),
  '/api/onboarding/admin/people/c1': () => ({ track: { counts: { items: 20, complete: 15, waitingOnHer: 2 } }, events: [] }),
  '/api/onboarding/admin/people/r1': () => ({ track: { counts: { items: 30, complete: 30 } }, events: [] }),
  '/api/caregiver/admin/welcome-packets/c1': () => ({ caregiver: { caregiverId: 'c1', name: 'Cara Giver', cleared: false, clearanceMessage: 'Fingerprinting is still outstanding.',
    outstanding: [{ title: 'Fingerprinting', waitingOn: 'us' }], office: [{ kind: 'fingerprinting', title: 'Fingerprinting', required: true, officeStatus: 'scheduled' }] },
    officeItems: [{ kind: 'fingerprinting' }], officeStatuses: ['not_started', 'scheduled', 'done'] }),
  '/api/caregiver/documents': () => ({ documents: [{ id: 'd1', caregiverId: 'c1', kindLabel: 'Timesheet', fileName: 'week.pdf', status: 'received', uploadedAt: '2026-11-02' }] }),
  // The Welcome Packet section (#276) reads this; a packet not started yet.
  '/api/my/admin/welcome/c1': () => ({ status: 'not_started', kind: 'caregiver', sections: [] }),
  '/api/my/admin/welcome/r1': () => ({ status: 'not_started', kind: 'staff', sections: [] }),
  '/api/caregiver/documents/kinds': () => ({ kinds: [{ kind: 'timesheet', label: 'Timesheet' }] }),
  '/api/caregiver/visit-logs': () => ({ visitLogs: [visitLog] }),
  '/api/caregiver/escalations': () => ({ escalations: [escalation] }),
  '/api/caregiver/incidents': () => ({ incidents: [] }),
  '/api/caregiver/me': () => ({ id: 'c1', name: 'Cara Giver', licenseLevel: 'cna', licenseLabel: 'CNA', onboarding: { appAccess: true, cleared: true } }),
  '/api/caregiver/clients': () => ({ clients: [] }),
  '/api/caregiver/feed': () => ({ items: [] }),
  '/api/scheduling/shifts': () => ({ shifts: [] }),
  '/api/my/profile': () => ({ id: 'c1', name: 'Cara Giver', type: 'caregiver', typeLabel: 'Caregiver', isCaregiver: true }),
  '/api/staff/hub': () => ({ areas: require('../accountTypes').hubAreasFor(viewer), landing: require('../accountTypes').landingFor(viewer) })
};
const MIME = { '.js': 'application/javascript', '.jsx': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const PAGES = { '/admin': 'admin-hub.html', '/caregiver': 'caregiver.html' };

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (PAGES[url]) {
      let html = fs.readFileSync(path.join(root, 'public', PAGES[url]), 'utf8');
      for (const [file, , re] of CDN_FILES) if (re) html = html.replace(re, `/cdn/${file}`);
      html = html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '').replace(/<script src="https:\/\/cdn\.sheetjs\.com[^"]*"><\/script>/, '');
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    if (url.startsWith('/cdn/')) {
      const f = path.join(CDN, url.slice(5));
      if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f)); }
    }
    if (API[url]) return json(res, API[url]());
    if (url.startsWith('/api/')) return json(res, url.includes('users') || url.includes('list') ? [] : {});
    const f = path.join(root, 'public', url);
    if (f.startsWith(path.join(root, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f));
    }
    res.writeHead(404); res.end('');
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const shot = process.env.GFC_PROBE_SHOT;

  async function open(pathname, user, size) {
    viewer = user;
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: shot ? 2 : 1 });
    await ctx.addInitScript(([u]) => {
      for (const k of ['unified_token', 'admin_token', 'portal_token']) localStorage.setItem(k, 't');
      for (const k of ['unified_user', 'admin_user', 'portal_user']) localStorage.setItem(k, JSON.stringify(u));
    }, [user]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (process.env.PROBE_CONSOLE && m.type() === 'error') console.log('CONSOLE', m.text()); });
    await page.goto(base + pathname, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    return { page, ctx, errors };
  }
  const text = (page) => page.evaluate(() => document.body.innerText);

  for (const [label, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    // 1. A caregiver's record.
    let { page, ctx, errors } = await open('/admin?view=users&person=c1', ADMIN, size);
    let t = await text(page);
    ok(`${label}: caregiver record opens as a page`, !!(await page.$('.staff-record')) && !(await page.$('.fixed.inset-0 form')));
    ok(`${label}: header names the person`, t.includes('Cara Giver') && t.includes('← User Management'));
    ok(`${label}: glance chips`, t.includes('Onboarding 75%') && t.includes('Not cleared for shifts') && t.includes('1 document to review'), t.slice(0, 400));
    const menu = await page.$$eval('.sr-menu button', bs => bs.map(b => b.textContent));
    ok(`${label}: caregiver sections`, JSON.stringify(menu) === JSON.stringify(['Account & Role', 'Credentials', 'Bio & Headshot', 'Pay', 'Documents', 'Onboarding & Clearance', 'Welcome Packet', 'Activity', 'Account Recovery']), JSON.stringify(menu));
    for (const id of ['sr-account', 'sr-credentials', 'sr-bio', 'sr-pay', 'sr-documents', 'sr-onboarding', 'sr-welcome', 'sr-activity', 'sr-recovery']) {
      ok(`${label}: #${id} is on the page`, !!(await page.$(`#${id}`)));
    }
    ok(`${label}: documents and what they signed`, t.includes('week.pdf') && t.includes('Caregiver welcome packet'));
    ok(`${label}: a document waiting on review can be accepted on the record`, t.includes('Waiting on review') && !!(await page.$('#sr-documents button:has-text("Accept")')));
    ok(`${label}: onboarding and clearance`, t.includes('15 of 20 onboarding items') && t.includes('Fingerprinting is still outstanding') && t.includes('Office-Checked Items'));
    ok(`${label}: activity`, t.includes('visit logs filed') && t.includes('concerns raised'));
    ok(`${label}: the user list is hidden`, !(await page.isVisible('input[placeholder="Search users..."]').catch(() => false)));
    ok(`${label}: no page errors (caregiver record)`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `record-caregiver-${label}.png`), fullPage: true });
    await ctx.close();

    // 2. A nurse's record.
    ({ page, ctx, errors } = await open('/admin?view=users&person=r1', ADMIN, size));
    t = await text(page);
    const rnMenu = await page.$$eval('.sr-menu button', bs => bs.map(b => b.textContent));
    ok(`${label}: nurse sections`, JSON.stringify(rnMenu) === JSON.stringify(['Account & Role', 'Credentials', 'Bio & Headshot', 'Documents', 'Onboarding & Clearance', 'Welcome Packet', 'Account Recovery']), JSON.stringify(rnMenu));
    ok(`${label}: nurse record has no caregiver-only parts`, !t.includes('Welcome Packet & Clearance') && !t.includes('Cleared for shifts'));
    ok(`${label}: nurse's signed policy`, t.includes('Field Addendum'));
    ok(`${label}: no page errors (nurse record)`, errors.length === 0, errors.join(' | '));
    await ctx.close();

    // 3. The caregiver's own filings.
    ({ page, ctx, errors } = await open('/caregiver#more', CG, size));
    if (label === 'phone') { const more = await page.$('.mg-tabs button:last-child'); if (more) await more.click(); await page.waitForTimeout(400); }
    else { const btn = await page.$('.mg-side button:has-text("Logs & Messages")'); if (btn) await btn.click(); await page.waitForTimeout(400); }
    t = await text(page);
    ok(`${label}: caregiver sees Concerns I Raised, resolved included`, t.includes('Concerns I Raised') && t.includes('Clinical — Ada Bell'), t.slice(0, 300));
    const viewLog = await page.$('button:has-text("View Full Log")');
    ok(`${label}: a visit log opens in full`, !!viewLog);
    if (viewLog) { await viewLog.click(); await page.waitForTimeout(200); t = await text(page); }
    ok(`${label}: the full log shows what was filed`, t.includes('Meal prep (not done) — Client declined') && t.includes('Client in good spirits.'));
    const viewEsc = await page.$('button:has-text("View Details")');
    if (viewEsc) { await viewEsc.click(); await page.waitForTimeout(200); t = await text(page); }
    ok(`${label}: a concern shows what was reported and done`, t.includes('Swelling in left ankle.') && t.includes('Seen at visit; elevated.'));
    ok(`${label}: no page errors (caregiver app)`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `filings-${label}.png`), fullPage: true });
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
