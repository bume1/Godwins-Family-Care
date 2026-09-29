#!/usr/bin/env node
// ============================================================================
// scripts/verify_portal_render.js — render the REAL public/portal.html in a real
// browser (Portal P1, 2026-09-29) and assert what each audience actually sees.
//
// Why a probe and not a unit test: the portal is React-in-the-browser, and the
// failures that matter are the ones no source scan can see — an undefined
// identifier, a section that renders for the wrong audience, a note injected as
// HTML. esbuild compiling the page proves none of that; running it does. (This
// probe's first run found two problems no test had: the visit summary repeating
// the prescription and test lines, and the clinician's raw VITALS shorthand in
// the patient's note.)
//
// The fixtures are built from the REAL publish and filter modules, composed as
// the summary route composes them, so the browser shows what the server sends.
// The API is stubbed; nothing here touches OpenEMR, Drive or a database.
//
// Needs: Playwright (npm i -g playwright, or PLAYWRIGHT_MODULE=/path) and a
// Chromium (PLAYWRIGHT_CHROMIUM=/path/to/chrome, else Playwright's own). The
// three CDN scripts the page loads (react, react-dom, babel) are fetched once
// with curl into $GFC_CDN_DIR (default: the OS temp dir) and served locally, so
// the browser is never asked to trust a proxy CA and certificate checking is
// never switched off. Exit code 0 = every assertion held.
//   node scripts/verify_portal_render.js
// ============================================================================
// Render the REAL portal.html in Chromium with the API stubbed. Fixtures are
// built from the real publish/filter modules, composed as the summary route does.
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = require('path').join(__dirname, '..');
const { execFileSync } = require('child_process'); const os = require('os');
const pwPath = process.env.PLAYWRIGHT_MODULE || 'playwright';
let chromium; try { ({ chromium } = require(pwPath)); } catch (e) { try { ({ chromium } = require(require('path').join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright'))); } catch (e2) { console.log('SKIP: Playwright is not installed (npm i -g playwright).'); process.exit(0); } }
const CDN = process.env.GFC_CDN_DIR || require('path').join(os.tmpdir(), 'gfc-portal-render-cdn');
fs.mkdirSync(CDN, { recursive: true });
for (const [file, url] of [['react.js', 'https://unpkg.com/react@18/umd/react.production.min.js'], ['react-dom.js', 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js'], ['babel.js', 'https://unpkg.com/@babel/standalone@7/babel.min.js']]) {
  const f = require('path').join(CDN, file);
  if (!fs.existsSync(f) || fs.statSync(f).size < 1000) execFileSync('curl', ['-sSL', '-m', '90', '-o', f, url]);
}
const P = require(root + '/patientPublish'); const R = require(root + '/patientReadRepository');

const NOTE = { kind: 'followup', visitDate: '2026-09-28', chiefConcern: 'Blood pressure follow-up',
  subjective: 'Feels **better** this week.\n- less dizzy\n- sleeping well\n<script>window.__pwned=1</script>',
  objective: 'Alert and comfortable.', assessment: 'Blood pressure improving.', plan: '## Plan\n1. Continue the current medicine\n2. Recheck in 4 weeks',
  sections: {}, hp: {}, confirmedFields: [], vitals: { bpSys: '128', bpDia: '78', hr: '72' } };
const ATT = { id: 'a', encounterUuid: 'e1', signedAt: '2026-09-28T15:00:00.000Z', signedBy: { id: 'u', name: 'Bethel Godwins', licenseLevel: 'FNP', npi: '1234567893' }, signedByClinicalRole: 'provider', coSignStatus: 'not_required' };
const REC = { encounterUuid: 'e1', clientId: 'c-1', date: '2026-09-28', reason: 'Blood pressure follow-up', diagnoses: [{ code: 'I10', description: 'Essential hypertension' }],
  patientSummary: 'We checked your blood pressure and it is coming down. We kept your water pill the same.', followUpInstructions: 'We will see you again in 4 weeks. Call us if you feel dizzy.', renderingProvider: { name: 'Bethel Godwins' }, note: NOTE };
const RX = [{ drug: 'Lisinopril', dose: '10 mg', frequency: 'once a day', transmission: 'none' }];
const ORDERS = [{ orderType: 'lab', status: 'ordered', tests: ['A1c'] }];
const chart = P.buildPublishedChart({ clientId: 'c-1', at: '2026-09-28T15:01:00Z', by: { name: 'Bethel Godwins' }, sourceVisitDate: '2026-09-28',
  problems: [{ id: 'p1', code: { text: 'Essential hypertension' }, clinicalStatus: { text: 'active' }, onsetDateTime: '2024-03-01' }],
  allergies: [{ id: 'a1', code: { text: 'Penicillin' }, criticality: 'high' }],
  medications: [{ id: 'm1', medicationCodeableConcept: { text: 'Lisinopril 10 mg' }, status: 'active', dosageInstruction: [{ text: 'once a day' }] }],
  vitals: P.vitalsFromNote(NOTE, '2026-09-28') });
const visit = (hold, over) => P.buildPublishedVisit({ clientId: 'c-1', encounterUuid: 'e1', record: { ...REC, ...(over || {}) }, attestation: ATT, prescriptions: RX, orders: ORDERS,
  addenda: [{ text: 'Reviewed her blood pressure log.', by: { name: 'Bethel Godwins', licenseLevel: 'FNP' }, at: '2026-09-29T10:00:00Z' }], hold, at: '2026-09-28T15:01:00Z' });
const RESULTS = [
  { id: 'r1', orderType: 'lab', resultDate: '2026-09-27', performedBy: 'Quest Diagnostics', releasedToPatientAt: '2026-09-27T20:00:00Z', patientCopy: { storageRef: 'x' }, acknowledgedAt: null },
  { id: 'r2', orderType: 'imaging', resultDate: '2026-09-20', performedBy: 'Peachtree Imaging', releasedToPatientAt: '2026-09-20T20:00:00Z', patientCopy: { storageRef: 'x' }, acknowledgedAt: '2026-09-21T14:00:00Z', acknowledgedBy: { name: 'Bethel Godwins' }, patientNote: 'Your X-ray looks fine. No changes needed.' }
].map(P.resultForPatient);

const payload = (audience, sharing, opts = {}) => {
  const sections = R.sectionsFor(audience, sharing);
  const level = sections.visits;
  const out = { audience, sections, isPoa: audience === 'poa', actingAs: audience === 'poa' ? 'Luka Agent as POA for Juanita Guess' : null, clientName: 'Juanita' };
  if (opts.empty) { out.published = { problems: false, allergies: false, medications: false, vitals: false }; out.publishedAt = null; out.visits = level !== 'none' ? [] : undefined; return out; }
  out.publishedAt = chart.publishedAt; out.publishedFromVisitDate = '2026-09-28';
  out.published = { problems: true, allergies: true, medications: true, vitals: true };
  const want = (k) => sections[k] && sections[k] !== 'none';
  if (want('problems')) out.problems = R.filterRows('problem', sections.problems, chart.problems);
  if (want('allergies')) out.allergies = R.filterRows('allergy', sections.allergies, chart.allergies);
  if (want('medications')) out.medications = R.filterRows('medication', sections.medications, chart.medications);
  if (want('vitals')) out.vitals = R.filterRow('vital', sections.vitals, chart.vitals);
  if (want('visits')) out.visits = [P.visitForAudience(visit(opts.hold), level)];
  if (want('results')) out.results = R.filterRows('result', sections.results, RESULTS);
  return out;
};

const SCENARIOS = {
  patient:      { user: { id: 'c-1', role: 'client', name: 'Juanita Guess', slug: 'juanita-guess' }, audience: 'patient', sharing: {} },
  held:         { user: { id: 'c-1', role: 'client', name: 'Juanita Guess', slug: 'juanita-guess' }, audience: 'patient', sharing: {}, hold: { reason: 'risk_of_harm' } },
  poa:          { user: { id: 'f-2', role: 'family', name: 'Luka Agent', familyOfClientId: 'c-1', familyIsPoa: true }, audience: 'poa', sharing: {} },
  familySummary:{ user: { id: 'f-1', role: 'family', name: 'Sam Relative', familyOfClientId: 'c-1' }, audience: 'family', sharing: {} },
  unpublished:  { user: { id: 'c-1', role: 'client', name: 'Juanita Guess', slug: 'juanita-guess' }, audience: 'patient', sharing: {}, empty: true },
};

const OUT = {};
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u.startsWith('/portal')) u = '/portal.html';
  const f = path.join(root, 'public', u);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f)); }
  res.writeHead(404); res.end('nf');
});

(async () => {
  await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}), args: ['--no-sandbox'] });
  const only = process.argv[2] ? [process.argv[2]] : Object.keys(SCENARIOS);
  let failures = 0;
  for (const name of only) {
    const sc = SCENARIOS[name];
    const ctx = await browser.newContext({ viewport: { width: 430, height: 1500 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.addInitScript(([t, u]) => { localStorage.setItem('portal_token', t); localStorage.setItem('portal_user', JSON.stringify(u)); }, ['tok', sc.user]);
    const me = { role: sc.user.role, isFamily: sc.user.role === 'family', isPoa: !!sc.user.familyIsPoa, name: sc.user.name, clientName: 'Juanita', clientFullName: 'Juanita Guess', slug: 'juanita-guess',
      clinicalRead: { available: true, audience: sc.audience, sections: R.sectionsFor(sc.audience, sc.sharing) }, sharing: sc.user.role === 'client' || sc.user.familyIsPoa ? R.normalizeSharing(sc.sharing) : undefined,
      enrollmentStatus: 'enrolled', intakeComplete: true, roiFamilySigned: true };
    // Third-party assets are served from local copies fetched with curl (which
    // trusts the sandbox proxy CA); certificate checking is left ON.
    await page.route(/^https:\/\/(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)\//, route => {
      const u = route.request().url(); const cdn = CDN + '/';
      const file = /react-dom/.test(u) ? 'react-dom.js' : /unpkg\.com\/react@/.test(u) ? 'react.js' : /babel/.test(u) ? 'babel.js' : null;
      if (file) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(cdn + file) });
      if (/tailwindcss/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.tailwind = { config: {} };' });
      return route.fulfill({ status: 200, contentType: /\.css|css2/.test(u) ? 'text/css' : 'application/javascript', body: '' });
    });
    await page.route('**/api/**', route => {
      const u = new URL(route.request().url()).pathname; const j = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (u === '/api/gfc/me') return j(me);
      if (u === '/api/gfc/care-plan') return j({ greetingName: 'Juanita', carePlan: null, careTierLabel: null, upcomingVisits: [], recentVisits: [] });
      if (u === '/api/gfc/clinical/summary') return j(payload(sc.audience, sc.sharing, sc));
      if (u === '/api/gfc/clinical/documents') return j({ documents: [] });
      if (u === '/api/gfc/documents') return j({ consents: [], files: [] });
      if (u === '/api/scheduling/my-upcoming-shifts') return j({ shifts: [] });
      return j({});
    });
    await page.goto(`http://localhost:${port}/portal/juanita-guess`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForFunction(() => !/Loading your care portal/.test(document.body.innerText) && /Good morning|Welcome|Lab results|My Health/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    const S = process.env.SHOTS_DIR || null;
    const out = { name };
    out.homeText = (await page.locator('body').innerText()).slice(0, 1800);
    if (S) await page.screenshot({ path: `${S}/${name}-home.png`, fullPage: true });
    // go to Health
    const health = page.getByText('Health', { exact: true }).first();
    if (await health.count()) { await health.click(); await page.waitForTimeout(600); }
    // expand the first visit
    const rs = page.getByText(/Read summary/).first();
    if (await rs.count()) { await rs.click(); await page.waitForTimeout(400); }
    out.healthText = (await page.locator('body').innerText()).slice(0, 4000);
    out.pwned = await page.evaluate(() => window.__pwned === undefined ? 'not run (escaped)' : 'EXECUTED');
    out.errors = errors;
    if (S) await page.screenshot({ path: `${S}/${name}-health.png`, fullPage: true });
    OUT[name] = out;
    console.log(`\n=== ${name}: errors=${errors.length} pwned=${out.pwned}`); if (errors.length) { failures++; console.log(errors.slice(0, 5).join('\n')); }
    await ctx.close();
  }

  // ---- What each audience must (and must not) see -----------------------------
  const has = (t, r) => r.test(t);
  const expect = (label, ok) => { if (!ok) { failures++; console.log('  FAIL: ' + label); } else console.log('  ok:   ' + label); };
  if (!process.argv[2]) {
    const P = OUT.patient, H = OUT.held, O = OUT.poa, F = OUT.familySummary, U = OUT.unpublished;
    console.log('\nAssertions');
    expect('patient: Home shows the Latest visit card with the note button and Message the care team', has(P.homeText, /your latest visit/i) && has(P.homeText, /read the full summary and note/i) && has(P.homeText, /message the care team/i));
    expect('patient: the visit overview does not repeat the prescription sentence', !has(P.homeText, /prescription was recorded/i) && !has(P.healthText, /prescription was recorded/i));
    expect('patient: the note is readable, with no raw VITALS shorthand', has(P.healthText, /what you told us/i) && !has(P.healthText, /VITALS —/));
    expect('patient: an unreviewed result says so, a reviewed one names who and shows the patient note', has(P.healthText, /not yet reviewed/i) && has(P.healthText, /reviewed by bethel godwins/i) && has(P.healthText, /your x-ray looks fine/i));
    // A <script> set through innerHTML never EXECUTES in a browser, so "it did not run" proves nothing;
    // what proves the note was escaped is that the tag is on screen as literal text.
    expect('patient: a <script> inside a note is shown as literal text (escaped), not swallowed as markup', has(P.healthText, /<script>window/) && P.pwned.startsWith('not run'));
    expect('patient: medications, allergies, conditions and the sharing card are present', has(P.healthText, /current medications/i) && has(P.healthText, /allergies/i) && has(P.healthText, /what family members can see/i));
    expect('held note: the note body is NOT shown and the held sentence is', !has(H.healthText, /what you told us/i) && has(H.healthText, /available on request/i) && has(H.homeText, /available on request/i));
    expect('held note: the Home button does not promise the note', has(H.homeText, /read the full summary(?! and)/i) && !has(H.homeText, /summary and note/i));
    expect('POA: reads the note like the patient, and is told who they are acting for', has(O.healthText, /what you told us/i) && has(O.healthText, /acting as luka agent/i));
    expect('family at summary level: date, provider and reason only — no note, no results, no sections, no sharing card', !has(F.healthText, /what you told us/i) && !has(F.healthText, /not yet reviewed/i) && !has(F.healthText, /current medications/i) && !has(F.healthText, /what family members can see/i));
    expect('family at summary level: the Home card does not offer a summary they cannot read', has(F.homeText, /your latest visit/i) && !has(F.homeText, /read the full summary/i));
    expect('nothing published: says the summary is coming, and each section says the care team will add it (never "none recorded")', has(U.healthText, /health summary is coming/i) && (U.healthText.match(/will add this after a visit/gi) || []).length === 3 && !has(U.healthText, /no allergies recorded|no conditions listed|no medications on your record/i));
    expect('nothing published: no Latest visit card on Home', !has(U.homeText, /your latest visit/i));
    expect('no page errors on any audience', Object.values(OUT).every(r => r.errors.length === 0));
  }
  await browser.close(); srv.close(); process.exit(failures ? 1 : 0);
})();
