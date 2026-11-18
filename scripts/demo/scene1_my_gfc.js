// Part 1 — My GFC. Run: node scripts/demo/scene1_my_gfc.js <outDir>
const fs = require('fs'); const path = require('path');
const env = require('./demo_env');
const { open } = require('./browser');
const { director, OVERLAY } = require('./director');
const OUT = process.argv[2] || path.join(__dirname, 'out');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { call, login, BASE } = await env.boot();
  const a = await login('admin@godwinsfamilycarellc.com', 'gfcforever2026');
  await call('POST', '/api/users', a.token, { name: 'Maya Robinson', email: 'maya.robinson@example.com', password: 'DemoPass!2026', accountType: 'coordinator', sendWelcomeEmail: false });
  env.settleUsers();

  const vdir = path.join(OUT, 'raw1'); fs.rmSync(vdir, { recursive: true, force: true });
  const { browser, context, page } = await open({ video: vdir });
  await context.addInitScript(OVERLAY);
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  const d = director(page);

  await d.card({ kicker: 'Godwins Family Care', title: 'Your GFC App', sub: 'A quick tour for our team' }, 3500, BASE);
  await d.card({ kicker: 'Part 1', title: 'My GFC', sub: 'Your home base in the app' }, 3000, BASE);

  await page.goto(BASE + '/login'); await d.wait(1800);
  await d.caption('Everyone signs in on the same page with their <b>work email</b>.');
  await d.type('input[type=email]', 'maya.robinson@example.com', 55);
  await d.type('input[type=password]', 'DemoPass!2026', 45);
  await d.wait(500);
  await d.click('button[type=submit]');
  await page.waitForURL(/\/my/, { timeout: 15000 }); await d.wait(2500);

  await d.caption('A new team member lands on their <b>Welcome Packet</b> first. It takes about five minutes.', 4500);
  const nav = (label) => page.locator('aside.mg-side button', { hasText: label }).first();
  await d.click(nav('Home'));
  await d.wait(1500);
  await d.caption('<b>My GFC</b> is your home base. Whatever is waiting on you shows at the top.', 2500);
  await d.point(page.getByText(/documents waiting on you/).first(), 900); await d.wait(2200);
  await d.point(page.getByText('Finish your welcome packet').first(), 900); await d.wait(1800);
  await d.caption('Every tool you need is one tap away.', 1200);
  await d.point(page.locator('main').getByText('Onboarding', { exact: true }).first(), 700); await d.wait(500);
  await d.point(page.locator('main').getByText('My Documents', { exact: true }).first(), 700); await d.wait(500);
  await d.point(page.locator('main').getByText('Policies', { exact: true }).first(), 700); await d.wait(500);
  await d.point(page.locator('main').getByText('Hours & Pay', { exact: true }).first(), 700); await d.wait(1200);

  const visit = async (label, text, hold = 4200) => { await d.caption(''); await d.click(nav(label)); await d.wait(900); await d.caption(text, hold); };
  await visit('My Documents', '<b>My Documents</b>: what you have signed, and every file on record for you.');
  await visit('Policies', '<b>Policies</b>: always the latest version of every policy you work under.');
  await visit('Hours & Pay', '<b>Hours & Pay</b>: your time clock, pay stubs, pay setup and tax forms.');
  await visit('My Profile', '<b>My Profile</b>: your headshot, bio and sign-in settings.');
  await visit('Home', 'Next up: <b>Onboarding</b>, your checklist, uploads and training.', 3500);
  await d.caption('');
  await d.card({ kicker: 'Coming up', title: 'Part 2: Onboarding', sub: '' }, 2500, BASE);

  const video = page.video();
  await context.close(); await browser.close();
  const raw = await video.path();
  fs.copyFileSync(raw, path.join(OUT, 'part1_my_gfc.webm'));
  console.log('VIDEO', path.join(OUT, 'part1_my_gfc.webm'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
