#!/usr/bin/env node
// ============================================================================
// Clinician onboarding — render probe. Drives the REAL page in Chromium.
// ============================================================================
// esbuild compiling the JSX proves it parses, not that a row draws. This probe
// found a real defect nothing else could: an office account landed on its own
// empty track with the roster one click away and no sign of it.
//
// It also seeds a clinician with NO track on purpose, because the no-track
// banner correctly stays hidden when everybody has one — an assertion that
// cannot tell those two states apart is not evidence about either.
//
// Needs Playwright, so it is not part of `npm test`.
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=t PORT=3601 node server.js
//   node scripts/verify_clinician_onboarding_render.js
// ============================================================================
const { chromium } = require('playwright');
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3601';
(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' — ' + x : '')); } };
  const login = async (email, password) => {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const d = await r.json(); return d.token || (d.data && d.data.token);
  };
  const adminToken = await login('admin@godwinsfamilycarellc.com', 'gfcforever2026');
  ok('admin token', !!adminToken);

  const stamp = Date.now();
  const mk = async (name, email) => {
    const r = await fetch(BASE + '/api/users', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
      body: JSON.stringify({ name, email, password: 'RenderPass123!', role: 'user',
        accountType: 'provider', hasClinicalAccess: true }) });
    const d = await r.json(); return (d.user || d);
  };
  const np = await mk('Render NP', `render.np.${stamp}@example.com`);
  await fetch(`${BASE}/api/clinician-onboarding/admin/${np.id}/inputs`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ roles: ['NP'], relationship: 'HYBRID', lanes: ['CLINICAL', 'EXAMS'],
      addons: ['FNP', 'PMHNP', 'PRESCRIBES', 'CONTROLLED', 'TELEHEALTH', 'INSURED_BILLING'],
      contractors: ['VES'], payers: [{ id: 'medicare', name: 'Original Medicare' }] }) });
  const npToken = await login(`render.np.${stamp}@example.com`, 'RenderPass123!');
  // A clinician with NO track, so the banner has something to name. Without one
  // the banner correctly stays hidden and the assertion could not tell the two
  // states apart.
  await mk('Render Untracked', `render.untracked.${stamp}@example.com`);

  const browser = await chromium.launch();
  for (const [who, token, w] of [['clinician', npToken, 1440], ['office', adminToken, 1440], ['clinician-phone', npToken, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.addInitScript(t => localStorage.setItem('unified_token', t), token);
    await page.goto(BASE + '/onboarding', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const text = await page.innerText('body');
    ok(`${who} @${w}px renders with no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
    if (who.startsWith('clinician')) {
      ok(`${who} sees their own onboarding`, /Your onboarding/i.test(text));
      ok(`${who} sees what unlocks when`, /What unlocks when/i.test(text));
      ok(`${who} sees a real checklist item`, /Upload licence|Accepted offer|Non-Disclosure/i.test(text));
      ok(`${who} is told the physician is not signed off`,
        /not signed off|No supervising physician/i.test(text), text.slice(0, 200));
      ok(`${who} is NOT shown a place of service or patient data`,
        !/place of service|patient/i.test(text.replace(/patient visits/gi, '')));
    } else {
      await page.waitForTimeout(500);
      ok('office sees the roster', /Clinicians/i.test(text));
      ok('office sees the no-track banner', /no onboarding track set up/i.test(text), text.slice(0, 300));
      ok('office sees Render NP on the roster', /Render NP/.test(text));
    }
    await page.screenshot({ path: `${process.env.TMPDIR || '/tmp'}/clinician-onboarding-${who}.png`, fullPage: false });
    await ctx.close();
  }
  await browser.close();
  console.log(`\n${pass}/${pass + fail} render checks passed${fail ? ` — ${fail} FAILED` : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('render crashed:', e.message); process.exit(1); });
