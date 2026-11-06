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
      // NO CHART DATA ON AN ONBOARDING SCREEN. This deliberately does NOT
      // match the word "patient": the page says "Patient visits" (a gate's own
      // title) and "seeing patients" (the welcome), both legitimate English,
      // and an earlier version of this guard had already carved out the first
      // and was about to carve out the second. A guard that needs a growing
      // exception list is testing the wrong thing. The real risk is a patient
      // RECORD reaching this surface, so the vocabulary of one is the assertion.
      const chartWords = text.match(
        /place of service|\bPOS\b|\bMRN\b|date of birth|\bDOB\b|diagnos\w*|\bICD\b|\bCPT\b|chief complaint/gi
      ) || [];
      ok(`${who} is NOT shown anything out of a patient's chart`,
        chartWords.length === 0, chartWords.slice(0, 5).join(' | '));

      // THE WELCOME, same front door as the caregiver packet.
      ok(`${who} is welcomed by name`, /Welcome to Godwins Family Care/i.test(text)
        && /glad you are here, Render/i.test(text), text.slice(0, 160));
      const heroShown = await page.evaluate(() => {
        const el = document.querySelector('.whero .img');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { h: Math.round(r.height), bg: getComputedStyle(el).backgroundImage };
      });
      // Measured, not read off the CSS: `display:none` on a grid child and a
      // zero-height hero both read fine in a stylesheet.
      ok(`${who} hero actually occupies the page`, heroShown && heroShown.h >= 170,
        JSON.stringify(heroShown));
      ok(`${who} hero points at the clinician banner`,
        heroShown && /banner-clinician\.jpg/.test(heroShown.bg), String(heroShown && heroShown.bg));

      // AND NOT THE OFFICE'S OWN WORKING NOTES. Read off the rendered text,
      // because the whole class of bug here is a label that only appears once
      // a real payload meets a real component.
      ok(`${who} is never told our check questions are unwritten`,
        !/not written|no questions yet/i.test(text));
      ok(`${who} sees no playbook item codes`, !/\b(CORE|CLIN|NP|MD|W2|HYB|LCL|EXM|PRV|RX|CS|TH|INS|NC|AL|FNP|PMH|DIR|C99)-\d\d\b/.test(text),
        (text.match(/\b[A-Z0-9]{2,4}-\d\d\b/g) || []).slice(0, 6).join(' '));
      ok(`${who} sees no training module codes`, !/\bTRN-\d{3}\b/.test(text),
        (text.match(/\bTRN-\d{3}\b/g) || []).slice(0, 4).join(' '));
      ok(`${who} sees no raw gate codes`, !/\bG[0-9]\b|\bG_MD\b|Blocks G|Counts toward G/.test(text),
        (text.match(/\bG[0-9]\b|\bG_MD\b/g) || []).slice(0, 6).join(' '));
      ok(`${who} sees no "Proof:" filing line`, !/Proof:/i.test(text));
      ok(`${who} sees no internal owner role`,
        !/Credentialing Owner|Executive Director|Clinical Director/i.test(text),
        (text.match(/Credentialing Owner|Executive Director/g) || []).join(' '));
      ok(`${who} is told plainly when something is ours`, /The office/i.test(text));
    } else {
      await page.waitForTimeout(500);
      ok('office sees the roster', /Clinicians/i.test(text));
      ok('office sees the no-track banner', /no onboarding track set up/i.test(text), text.slice(0, 300));
      ok('office sees Render NP on the roster', /Render NP/.test(text));
      // The office is NOT welcomed to the company on a credentialing screen.
      ok('office gets no welcome hero', !/glad you are here/i.test(text));
    }
    await page.screenshot({ path: `${process.env.TMPDIR || '/tmp'}/clinician-onboarding-${who}.png`, fullPage: false });
    await ctx.close();
  }
  await browser.close();
  console.log(`\n${pass}/${pass + fail} render checks passed${fail ? ` — ${fail} FAILED` : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('render crashed:', e.message); process.exit(1); });
