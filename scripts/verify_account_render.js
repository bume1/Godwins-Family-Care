#!/usr/bin/env node
// scripts/verify_account_render.js — render the REAL public/account.html in a
// real browser and drive every card.
//
// The five routes are stubbed with the shapes the server actually returns.
// What is being proven is what a person SEES and what the page SENDS, which
// no source scan can establish: that a clinician gets the OpenEMR card and a
// caregiver does not, that regenerating codes sends the live code and shows
// the new set once, and that nothing offers to sign out one device.
//   node scripts/verify_account_render.js     (GFC_PROBE_SHOT=/path/x.png)
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
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let pass = 0; const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const SESSIONS = [
  { id: 's1', current: true, createdAt: '2026-11-06T13:00:00.000Z', lastSeenAt: '2026-11-06T14:02:00.000Z',
    surface: 'clinical', mfaVerified: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
  { id: 's2', current: false, createdAt: '2026-11-04T18:00:00.000Z', lastSeenAt: '2026-11-05T01:10:00.000Z',
    surface: 'clinical', mfaVerified: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 's3', current: false, revokedAt: '2026-11-01T00:00:00.000Z', revokedReason: 'logout',
    createdAt: '2026-10-30T00:00:00.000Z', lastSeenAt: '2026-10-31T00:00:00.000Z', surface: 'clinical', userAgent: '' }
];

(async () => {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/account') {
      let html = fs.readFileSync(path.join(root, 'public', 'account.html'), 'utf8');
      for (const [file, , re] of CDN_FILES) html = html.replace(re, `/cdn/${file}`);
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

  // `who` decides which person the stub answers as, so one probe covers a
  // clinician, a caregiver and somebody with no two-step set up.
  const open = async (who) => {
    const page = await browser.newPage({ viewport: { width: Number(process.env.GFC_PROBE_WIDTH || 1100), height: 1300 } });
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    const sent = [];
    await page.route('**/api/**', async (route) => {
      const r = route.request(); const u = new URL(r.url()); const p = u.pathname;
      sent.push({ path: p, method: r.method(), body: r.postData() ? JSON.parse(r.postData()) : null });
      const json = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (p === '/api/auth/mfa/status') return json({
        enforced: true, required: who.required, enrolled: who.enrolled,
        enrolledAt: who.enrolled ? '2026-09-20T14:00:00.000Z' : null,
        recoveryRemaining: who.remaining, sessionMfaVerified: true,
        account: { id: 'u-1', name: who.name, email: who.email, role: who.role,
          emailUnsubscribed: !!who.unsub, accountStatus: 'active',
          lastPasswordChange: '2026-10-01T15:30:00.000Z', requirePasswordChange: false }
      });
      if (p === '/api/auth/sessions') return json({ sessions: SESSIONS });
      if (p === '/api/clinical/status') {
        if (!who.clinical) return json({ error: 'Clinical access required' }, 403);
        return json({ configured: true, connected: who.emrConnected, connectedAt: '2026-11-02T16:00:00.000Z',
          emrUser: who.emrConnected ? { username: 'bgodwins' } : null });
      }
      if (p === '/api/auth/mfa/recovery-codes/regenerate') {
        const b = JSON.parse(r.postData() || '{}');
        if (!b.code) return json({ error: 'That code is not right.', code: 'MFA_INVALID_CODE' }, 400);
        return json({ recoveryCodes: ['AAAA-1111', 'BBBB-2222', 'CCCC-3333', 'DDDD-4444'] });
      }
      if (p === '/api/auth/change-password') {
        const b = JSON.parse(r.postData() || '{}');
        if (b.currentPassword !== 'right') return json({ error: 'Current password is incorrect' }, 400);
        return json({ message: 'Password changed successfully' });
      }
      if (p === '/api/emr/disconnect') return json({ ok: true, disconnected: true });
      return json({});
    });
    await page.goto(base + '/account', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card', { timeout: 20000 });
    await page.waitForFunction(() => document.body.innerText.includes('Two-step'), { timeout: 20000 });
    return { page, errs, sent, text: () => page.$eval('body', b => b.innerText) };
  };

  // ---- a clinician, two-step on, OpenEMR connected --------------------------
  const CLIN = { name: 'Bethel Godwins', email: 'bethel@godwinsfamilycarellc.com', role: 'user',
    enrolled: true, required: true, remaining: 7, clinical: true, emrConnected: true };
  let v = await open(CLIN);
  let t = await v.text();
  ok('the page names the person from the server, not from storage', /Bethel Godwins/.test(t));
  ok('the account email is shown', /bethel@godwinsfamilycarellc\.com/.test(t));
  ok('two-step reads as set up', /Yes, since Sep 20, 2026/.test(t), t.slice(0, 600));
  ok('the backup-code count is shown', /Backup codes left[\s\S]{0,40}7/.test(t));
  ok('a clinician gets the OpenEMR card', /Your OpenEMR sign-in/.test(t));
  ok('it names the OpenEMR account they are signed in as', /bgodwins/.test(t));
  ok('the sessions list shows this device', /This device/i.test(t));
  ok('a revoked session is not listed as live',
    (await v.page.$$eval('table tbody tr', r => r.length)) === 2,
    `${await v.page.$$eval('table tbody tr', r => r.length)} rows`);
  ok('a device name is read from the user agent', /Chrome on Mac/.test(t) && /Safari on iPhone/.test(t));
  ok('the other device is counted and the real control is named',
    /One other device is signed in as you/.test(t) && /change your password above/.test(t));
  ok('no per-device sign-out is offered',
    !/Sign out this device|Sign out that device|Revoke/i.test(t));

  // Times in Eastern: 14:02Z is 9:02 AM in Georgia.
  if (/New_York/.test(String(HOST_TZ))) {
    console.log('  --  Eastern clock check skipped: this host is already ' + HOST_TZ);
  } else {
    ok('times render in Eastern, not in the container zone', /9:02\s*AM/.test(t), t.slice(0, 900));
  }

  // Regenerating codes: the live code must go with it, and the set shows once.
  await v.page.fill('input[inputMode="numeric"]', '123456');
  v.sent.length = 0;
  await v.page.$$eval('button.btn', bs => {
    const b = bs.find(x => /Make New Backup Codes/i.test(x.innerText)); b.click();
  });
  await v.page.waitForFunction(() => /AAAA-1111/.test(document.body.innerText), { timeout: 15000 });
  const regen = v.sent.find(x => x.path.endsWith('/regenerate'));
  ok('the live authenticator code is sent with the request', regen && regen.body && regen.body.code === '123456',
    JSON.stringify(regen && regen.body));
  t = await v.text();
  ok('the new codes are shown', /AAAA-1111[\s\S]*DDDD-4444/.test(t));
  ok('and the page says they are shown only once', /only time they are shown/i.test(t));
  ok('a download is offered for them', /Download Codes/.test(t));

  // Password: the server's own sentence on a bad current password.
  await v.page.fill('input[autocomplete="current-password"]', 'wrong');
  await v.page.fill('input[autocomplete="new-password"] >> nth=0', 'newpassword1');
  await v.page.fill('input[autocomplete="new-password"] >> nth=1', 'newpassword1');
  await v.page.$$eval('button.btn', bs => bs.find(x => /Change Password/i.test(x.innerText)).click());
  await v.page.waitForFunction(() => /Current password is incorrect/.test(document.body.innerText), { timeout: 15000 });
  ok('a refused password change shows the server\'s own reason', true);
  // Mismatched new passwords are refused before anything is sent.
  await v.page.fill('input[autocomplete="new-password"] >> nth=1', 'different1');
  v.sent.length = 0;
  await v.page.$$eval('button.btn', bs => bs.find(x => /Change Password/i.test(x.innerText)).click());
  await v.page.waitForFunction(() => /do not match/.test(document.body.innerText), { timeout: 15000 });
  ok('two different new passwords are caught before anything is sent',
    !v.sent.some(x => x.path.endsWith('change-password')));
  // And a good one says what it did to the other devices.
  await v.page.fill('input[autocomplete="current-password"]', 'right');
  await v.page.fill('input[autocomplete="new-password"] >> nth=1', 'newpassword1');
  await v.page.$$eval('button.btn', bs => bs.find(x => /Change Password/i.test(x.innerText)).click());
  await v.page.waitForFunction(() => /Every other device/.test(document.body.innerText), { timeout: 15000 });
  ok('a successful change says every other device was signed out', true);

  // Disconnecting OpenEMR.
  v.page.on('dialog', d => d.accept());
  v.sent.length = 0;
  await v.page.$$eval('button.btn.warn', bs => bs[0].click());
  await v.page.waitForFunction(() => /sign in to OpenEMR again/.test(document.body.innerText), { timeout: 15000 });
  const dis = v.sent.find(x => x.path === '/api/emr/disconnect');
  ok('disconnect posts to the self-service route and takes no user id',
    dis && dis.method === 'POST' && !/\/users\//.test(dis.path));
  if (process.env.GFC_PROBE_SHOT) { await v.page.screenshot({ path: process.env.GFC_PROBE_SHOT, fullPage: true }); console.log(`  shot ${process.env.GFC_PROBE_SHOT}`); }
  ok('no page errors (clinician)', v.errs.length === 0, v.errs.join(' | '));
  await v.page.close();

  // ---- a caregiver: no OpenEMR card, two-step not set up --------------------
  v = await open({ name: 'Rosa Pine', email: 'rosa@example.com', role: 'vendor',
    enrolled: false, required: false, remaining: 0, clinical: false, emrConnected: false });
  t = await v.text();
  ok('a caregiver is NOT offered the OpenEMR card', !/Your OpenEMR sign-in/.test(t));
  ok('they still get password, two-step and devices',
    /Password/.test(t) && /Two-step/.test(t) && /Where you are signed in/.test(t));
  ok('two-step reads as not set up', /Not set up/.test(t));
  ok('and the page says where it is actually set up', /You set this up at sign-in, not here/.test(t));
  ok('no backup-code form is offered to somebody not enrolled',
    (await v.page.$$('input[inputMode="numeric"]')).length === 0);
  ok('no page errors (caregiver)', v.errs.length === 0, v.errs.join(' | '));
  await v.page.close();

  // ---- somebody nearly out of codes, and unsubscribed -----------------------
  v = await open({ name: 'Carla Coordinator', email: 'carla@example.com', role: 'user',
    enrolled: true, required: true, remaining: 1, clinical: false, emrConnected: false, unsub: true });
  t = await v.text();
  ok('running out of backup codes is called out before it bites', /nearly out of backup codes/i.test(t));
  ok('an unsubscribed account is told its email is off', /Turned off/.test(t));
  ok('and told how it is turned back on', /Ask an admin to turn it back on/.test(t));
  ok('no email toggle is offered, because no route honours one',
    !/Stop reminders|Turn (on|off) email/i.test(t));
  ok('no page errors (coordinator)', v.errs.length === 0, v.errs.join(' | '));
  await v.page.close();

  await browser.close(); srv.close();
  console.log(`\n${pass}/${pass + fails.length} checks passed`);
  if (fails.length) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
