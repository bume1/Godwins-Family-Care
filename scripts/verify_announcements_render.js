#!/usr/bin/env node
// scripts/verify_announcements_render.js — render the REAL public/my.html in a
// browser and drive My GFC → Announcements (2026-11-10).
//
// Routes are stubbed with the shapes routes/staffPortal.js returns. Proves what
// a person SEES and what the page SENDS: an unread card on Home, the
// "I've Reviewed This" receipt, the admin team's composer posting an audience,
// and a nurse getting no composer.
//   node scripts/verify_announcements_render.js     (GFC_PROBE_SHOT=/path/x.png)
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

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const state = { reviewed: false, posted: [], who: 'coordinator' };
const profile = () => state.who === 'coordinator'
  ? { id: 'k1', name: 'Coco Ordinator', type: 'coordinator', typeLabel: 'Care Coordinator', isAdmin: true, isCaregiver: false, welcomeDone: true }
  : { id: 'r1', name: 'Rae Nurse', type: 'rn', typeLabel: 'Registered Nurse', isAdmin: false, isCaregiver: false, isClinician: true, welcomeDone: true };
const item = () => ({ id: 'b1', title: 'App update: what is new', body: 'Sign-in now opens your Welcome Packet.', link: 'https://docs.google.com/document/d/x',
  at: '2026-11-10T14:00:00.000Z', byName: 'Office Admin', reviewedAt: state.reviewed ? '2026-11-10T15:00:00.000Z' : null });

const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/my') {
      let html = fs.readFileSync(path.join(root, 'public', 'my.html'), 'utf8');
      for (const [file, , re] of CDN_FILES) html = html.replace(re, `/cdn/${file}`);
      html = html.replace(/<link[^>]*(fonts\.googleapis|fonts\.gstatic|tabler-icons)[^>]*>/g, '');
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return;
    }
    if (url.startsWith('/cdn/')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(fs.readFileSync(path.join(CDN, path.basename(url)))); return; }
    if (url === '/api/my/profile') return json(res, profile());
    if (url === '/api/onboarding/me') return json(res, { started: false });
    if (url === '/api/my/documents') return json(res, { documents: [], signed: [] });
    if (url === '/api/my/policies') return json(res, { policies: [] });
    if (url === '/api/my/paystubs') return json(res, { paystubs: [] });
    if (url === '/api/my/folders') return json(res, { folders: [] });
    if (url === '/api/my/announcements') return json(res, { announcements: [item()] });
    if (url === '/api/my/announcements/b1/reviewed') { state.reviewed = true; return json(res, { reviewedAt: 'x' }); }
    if (url === '/api/my/admin/announcements') {
      return json(res, { announcements: [{ ...item(), active: true, audience: 'all_staff', reviewed: state.reviewed ? ['Coco Ordinator'] : [], notReviewed: ['Rae Nurse', 'Cara Giver'] }],
        roles: [{ value: 'rn', label: 'Registered Nurse' }, { value: 'caregiver', label: 'Caregiver' }] });
    }
    if (url === '/api/caregiver/broadcasts' && req.method === 'POST') {
      let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { state.posted.push(JSON.parse(b || '{}')); json(res, { broadcast: { id: 'b2' } }); }); return;
    }
    const pub = path.join(root, 'public', url);
    if (pub.startsWith(path.join(root, 'public')) && fs.existsSync(pub) && fs.statSync(pub).isFile()) {
      res.writeHead(200, { 'Content-Type': url.endsWith('.js') ? 'application/javascript' : 'text/plain' }); res.end(fs.readFileSync(pub)); return;
    }
    json(res, {}, 200);
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const open = async (who, width) => {
    state.who = who;
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.addInitScript(() => { localStorage.setItem('unified_token', 't'); });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/my`);
    await page.waitForSelector('.mygfc', { timeout: 20000 });
    await page.waitForTimeout(800);
    return { page, ctx };
  };

  // Coordinator (admin team) at desktop width.
  let { page, ctx } = await open('coordinator', 1280);
  let text = await page.innerText('body');
  ok('Home shows the unread announcement', /New: App update: what is new/.test(text));
  ok('Announcements is in the sidebar', /Announcements/.test(text));
  await page.click('text=Read It');
  await page.waitForTimeout(500);
  text = await page.innerText('body');
  ok('the section lists the post and its guide link', /Sign-in now opens your Welcome Packet/.test(text) && /Open the guide/.test(text));
  ok('the admin team gets the composer', /Post an Announcement/.test(text) && /no client names/i.test(text));
  ok('the report shows who has not reviewed', /2 not yet/.test(text));
  await page.click("text=I've Reviewed This");
  await page.waitForTimeout(500);
  ok('reviewing records it and shows Reviewed', state.reviewed && /Reviewed/.test(await page.innerText('body')));
  await page.fill('input[placeholder^="App update"]', 'Holiday hours');
  await page.click('text=Everyone on the team');
  await page.click('text=Registered Nurse');
  await page.click('text=Post Announcement');
  await page.waitForTimeout(500);
  const p = state.posted[0] || {};
  ok('posting sends the chosen roles', p.title === 'Holiday hours' && Array.isArray(p.audience) && p.audience.join() === 'rn', JSON.stringify(p));
  if (process.env.GFC_PROBE_SHOT) await page.screenshot({ path: process.env.GFC_PROBE_SHOT, fullPage: true });
  await ctx.close();

  // A nurse at phone width: reads, no composer.
  state.reviewed = false;
  ({ page, ctx } = await open('rn', 390));
  text = await page.innerText('body');
  ok('a nurse sees the unread card on Home at phone width', /New: App update/.test(text));
  await page.click('text=Read It');
  await page.waitForTimeout(500);
  text = await page.innerText('body');
  ok('a nurse gets no composer', !/Post an Announcement/.test(text));
  await ctx.close();

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
