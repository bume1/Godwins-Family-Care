#!/usr/bin/env node
// scripts/verify_care_records_render.js — render the REAL client record's Care
// History, the Incident Log and Home Care Oversight's Waiting list in a real
// browser (owner, 2026-11-09). The API is stubbed in the shapes the routes return.
//   node scripts/verify_care_records_render.js     (GFC_PROBE_SHOT=/dir for pictures)
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
const at = require('../accountTypes');
const MANAGER = { id: 'm1', name: 'Morgan Manager', email: 'm@example.test', role: 'user', accountType: 'manager', isManager: true };
// The client record is read as a nurse: clinical staff open client records
// too, and the admin-or-manager billing cards are not what this probe is about.
const NURSE = { id: 'r1', name: 'Rae Nurse', email: 'r@example.test', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
let viewer = MANAGER;
let closed = false;
const incident = () => ({ id: 'i1', client_id: 'c1', client_name: 'Ada Bell', caregiver_id: 'cg1', caregiver_name: 'Cara Giver', kind: 'falls', label: 'Falls',
  detail: 'Slipped in the bathroom; no injury seen.', status: closed ? 'closed' : 'open', reported_at: '2026-11-07T18:00:00Z',
  trail: closed ? [{ action: 'closed', at: '2026-11-08T14:00:00Z', byName: 'Morgan Manager', note: 'RN visit next day; grab bar ordered.', stateReport: { reportedAt: '2026-11-08', agency: 'GA HFRD', reference: 'R-9' } }] : [] });
const visitLog = { id: 'v1', clientId: 'c1', clientName: 'Ada Bell', caregiverId: 'cg1', caregiverName: 'Cara Giver', visitType: 'PCA visit', visitDate: '2026-11-07', status: 'pending_review',
  submittedAt: '2026-11-07T18:00:00Z', reviews: [], detail: { tasks: [{ label: 'Bathing', done: true }], narratives: [{ label: 'Notes', value: 'Client in good spirits.' }] } };
const escalation = { id: 'e1', clientId: 'c1', clientName: 'Ada Bell', caregiverId: 'cg1', caregiverName: 'Cara Giver', concernType: 'clinical', status: 'acknowledged',
  description: 'Swelling in left ankle.', raisedAt: '2026-11-05T15:00:00Z', trail: [{ status: 'acknowledged', at: '2026-11-05T16:00:00Z', byName: 'Rae Nurse' }] };
const json = (res, body, status) => { res.writeHead(status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const API = {
  'GET /api/gfc/admin/enrollment/c1': () => ({ client: { id: 'c1', name: 'Ada Bell', email: 'ada@example.test', serviceLineResolved: 'phc', reviewState: 'intake_complete',
    intake: {}, consents: [], files: { offlinePacketUrls: [] }, payer: {}, medications: [], missing: { consents: [], fields: [] }, canEdit: true, canEditSubmission: true } }),
  // The record's other cards, in the shapes they read, so they render quietly.
  'GET /api/clinical/patients/c1/insurance': () => ({ payers: [], checks: [] }),
  'GET /api/caregiver/clients/c1/care-history': () => ({ clientId: 'c1', visitLogs: [visitLog], escalations: [escalation], incidents: [incident()] }),
  'GET /api/caregiver/incidents': () => ({ incidents: [incident()] }),
  'POST /api/caregiver/incidents/i1/close': (body) => {
    if (!String((body && body.note) || '').trim()) return [400, { error: 'Say what was done before closing the incident.', code: 'INCIDENT_NOTE_REQUIRED' }];
    closed = true; return { incident: incident() };
  },
  'GET /api/caregiver/escalations': () => ({ escalations: [escalation] }),
  'GET /api/caregiver/visit-logs': () => ({ visitLogs: [visitLog] }),
  'GET /api/caregiver/documents': () => ({ documents: [{ id: 'd1', caregiverId: 'cg2', caregiverName: 'New Hire', kindLabel: 'Photo ID', fileName: 'id.jpg', status: 'received', uploadedAt: '2026-11-04T12:00:00Z' }] }),
  'GET /api/caregiver/admin/welcome-packets': () => ({ caregivers: [{ caregiverId: 'cg2', name: 'New Hire', cleared: false, clearanceMessage: 'Fingerprinting is still outstanding.', outstanding: [], office: [] }], officeItems: [], officeStatuses: [] }),
  'GET /api/staff/hub': () => ({ areas: at.hubAreasFor(viewer), landing: null })
};
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const PAGES = { '/admin/enrollment': 'admin-enrollment.html', '/incidents': 'incidents.html', '/caregivers': 'caregivers.html' };

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (PAGES[url]) {
      let html = fs.readFileSync(path.join(root, 'public', PAGES[url]), 'utf8');
      for (const [file, , re] of CDN_FILES) if (re) html = html.replace(re, `/cdn/${file}`);
      html = html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '');
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    if (url.startsWith('/cdn/')) {
      const f = path.join(CDN, url.slice(5));
      if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f)); }
    }
    const k = `${req.method} ${url}`;
    if (API[k]) {
      let raw = ''; req.on('data', c => { raw += c; });
      return req.on('end', () => { let body = null; try { body = JSON.parse(raw); } catch (e) { /* none */ }
        const out = API[k](body); return Array.isArray(out) ? json(res, out[1], out[0]) : json(res, out); });
    }
    if (url.startsWith('/api/')) return json(res, {});
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
  async function open(pathname, size, who = MANAGER) {
    viewer = who;
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: shot ? 2 : 1 });
    await ctx.addInitScript(([u]) => {
      for (const k of ['unified_token', 'admin_token', 'portal_token']) localStorage.setItem(k, 't');
      for (const k of ['unified_user', 'admin_user', 'portal_user']) localStorage.setItem(k, JSON.stringify(u));
    }, [who]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(process.env.PROBE_STACK ? e.stack : e.message));
    await page.goto(base + pathname, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    return { page, ctx, errors };
  }
  const text = (page) => page.evaluate(() => document.body.innerText);

  for (const [label, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    closed = false;
    // 1. The client record's Care History.
    let { page, ctx, errors } = await open('/admin/enrollment?client=c1', size, NURSE);
    let t = await text(page);
    ok(`${label}: client record has Care History`, /care history/i.test(t) && t.includes('Visit Logs (1)') && t.includes('Concerns Raised (1)') && t.includes('Incidents (1, 1 open)'), t.slice(0, 300));
    const view = await page.$('button:has-text("View Full Log")');
    if (view) { await view.click(); await page.waitForTimeout(200); t = await text(page); }
    ok(`${label}: a visit log opens in full`, t.includes('Client in good spirits.'));
    ok(`${label}: the concern shows what was reported`, t.includes('Swelling in left ankle.'));
    ok(`${label}: rows link to the caregiver's record and the Incident Log`, !!(await page.$('a[href="/admin?view=users&person=cg1"]')) && !!(await page.$('a[href="/incidents#i1"]')));
    ok(`${label}: no page errors (client record)`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `care-history-${label}.png`), fullPage: true });
    await ctx.close();

    // 2. The Incident Log, closing an incident.
    ({ page, ctx, errors } = await open('/incidents', size));
    t = await text(page);
    ok(`${label}: Incident Log lists the open incident`, t.includes('Falls · Ada Bell') && t.includes('Slipped in the bathroom'));
    await page.click('button:has-text("Close Incident")');
    await page.waitForTimeout(300);
    t = await text(page);
    ok(`${label}: closing without a note is refused, and says why`, t.includes('Say what was done before closing the incident.'));
    await page.fill('textarea', 'RN visit next day; grab bar ordered.');
    await page.click('button:has-text("Close Incident")');
    await page.waitForTimeout(500);
    t = await text(page);
    ok(`${label}: the closed incident shows its follow-up and state report`, t.includes('RN visit next day; grab bar ordered.') && t.includes('Reported to GA HFRD'), t.slice(0, 400));
    ok(`${label}: Incident Log has the staff bar`, !!(await page.$('nav.gfc-sn')));
    ok(`${label}: no page errors (Incident Log)`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `incidents-${label}.png`), fullPage: true });
    await ctx.close();

    // 3. Home Care Oversight's Waiting list.
    closed = false;
    ({ page, ctx, errors } = await open('/caregivers', size));
    t = await text(page);
    ok(`${label}: Oversight opens on Waiting`, t.includes('Home Care Oversight') && t.includes('Waiting on the Office'));
    ok(`${label}: every kind of waiting item is listed`, ['Concern', 'Visit log to review', 'Incident', 'Document to review', 'Not yet cleared'].every(k => t.includes(k)), t.slice(0, 500));
    ok(`${label}: rows open their records`, !!(await page.$('a[href="/admin/enrollment?client=c1"]')) && !!(await page.$('a[href="/incidents#i1"]')) && !!(await page.$('a[href="/admin?view=users&person=cg2#sr-onboarding"]')));
    ok(`${label}: no page errors (Oversight)`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `oversight-${label}.png`), fullPage: true });
    await ctx.close();
  }
  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
