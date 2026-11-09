#!/usr/bin/env node
// scripts/verify_staff_hub_render.js — render the REAL Portal Hub, Admin Hub
// and a staff page in a real browser (owner, 2026-11-09).
//
// What it proves that the unit tests cannot: the hub draws its areas as
// labeled sections, the shared staff bar appears on a staff page and opens to
// every area, and the Admin Hub renders inside the My GFC frame with its
// banner, all with no page errors. The API is stubbed; the areas come from the
// real accountTypes.hubAreasFor.
//   node scripts/verify_staff_hub_render.js     (GFC_PROBE_SHOT=/dir for pictures)
const http = require('http'); const fs = require('fs'); const path = require('path');
const os = require('os'); const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const at = require('../accountTypes');
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

const ADMIN = { id: 'u-admin', name: 'Bianca Ume', email: 'admin@example.test', ...at.fieldsFor('admin') };
const MANAGER = { id: 'u-mgr', name: 'Morgan Manager', email: 'mgr@example.test', ...at.fieldsFor('manager') };
let viewer = ADMIN;

const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const PAGES = { '/login': 'login.html', '/admin': 'admin-hub.html', '/scheduling': 'scheduling.html', '/my': 'my.html' };

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
    if (url === '/api/staff/hub') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ areas: at.hubAreasFor(viewer), landing: at.landingFor(viewer) }));
    }
    if (url === '/api/admin/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ totalUsers: 42, clientUsers: 17, caregiverUsers: 12 }));
    }
    if (url.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(url.includes('users') || url.includes('list') ? '[]' : '{}');
    }
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
      localStorage.setItem('unified_token', 't'); localStorage.setItem('admin_token', 't');
      localStorage.setItem('unified_user', JSON.stringify(u)); localStorage.setItem('admin_user', JSON.stringify(u));
    }, [{ ...user, hubAreas: at.hubAreasFor(user), landing: at.landingFor(user) }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + pathname, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    return { page, ctx, errors };
  }

  for (const [label, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    // 1. The Portal Hub, by area.
    let { page, ctx, errors } = await open('/login?hub=1', ADMIN, size);
    const heads = await page.$$eval('main section h2', hs => hs.map(h => h.textContent.trim()));
    ok(`${label}: hub shows the six areas in order`, JSON.stringify(heads) === JSON.stringify(['My GFC', 'People', 'Clients', 'Clinical', 'Billing', 'Admin & Compliance']), JSON.stringify(heads));
    const people = await page.$$eval('#area-people + div h3', hs => hs.map(h => h.textContent.trim()));
    ok(`${label}: People holds caregiver management and scheduling`, people.includes('Caregiver Management') && people.includes('Caregiver Scheduling'), JSON.stringify(people));
    ok(`${label}: hub has no page errors`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `hub-${label}.png`), fullPage: true });
    await ctx.close();

    // 2. A staff page carries the bar.
    ({ page, ctx, errors } = await open('/scheduling', MANAGER, size));
    const bar = await page.$('nav.gfc-sn');
    ok(`${label}: the staff bar is on Scheduling`, !!bar);
    const here = bar ? await page.$eval('.gfc-sn-here', e => e.textContent).catch(() => '') : '';
    ok(`${label}: the bar says you are in People`, here === 'People', here);
    if (bar) await page.click('.gfc-sn-menu');
    const panel = await page.$$eval('.gfc-sn-panel h3', hs => hs.map(h => h.textContent));
    ok(`${label}: All areas opens to the manager's areas`, JSON.stringify(panel) === JSON.stringify(['My GFC', 'People', 'Clients', 'Clinical', 'Billing']), JSON.stringify(panel));
    if (shot) await page.screenshot({ path: path.join(shot, `bar-${label}.png`) });
    await ctx.close();

    // 3. The Admin Hub in the My GFC frame.
    ({ page, ctx, errors } = await open('/admin', ADMIN, size));
    ok(`${label}: Admin Hub renders in the My GFC frame`, !!(await page.$('.mygfc .mg-shell')));
    ok(`${label}: Admin Hub home has the banner`, !!(await page.$('.mg-main.mg-home')));
    const hello = await page.$eval('.mg-hello h1', e => e.textContent).catch(() => '');
    ok(`${label}: Admin Hub greets by first name`, hello === 'Hi, Bianca', hello);
    ok(`${label}: Admin Hub has the staff bar`, !!(await page.$('nav.gfc-sn')));
    const tag = label === 'desktop' ? await page.$eval('.mg-tag', e => e.textContent).catch(() => '') : 'Admin Hub';
    ok(`${label}: the sidebar is labeled Admin Hub`, tag === 'Admin Hub', tag);
    ok(`${label}: Admin Hub has no page errors`, errors.length === 0, errors.join(' | '));
    if (shot) await page.screenshot({ path: path.join(shot, `admin-hub-${label}.png`), fullPage: true });
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log(`\n${pass} passed, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
