// ============================================================
// Portal + clinician bug sweep (owner-directed, 2026-09-29: "screen for any
// other app bugs for the patient and clinician areas").
//
// Every guard here pins a defect that was live and verified by reading both
// sides of the code. Where the code can be RUN (date helpers, the timeline,
// the upcoming-visit list) it is run; the rest are anchored on shapes only the
// fixed code has.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const portal = read('public/portal.html');
const clinical = read('public/clinical.html');
const time = require('../public/gfc-time');

const between = (src, from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `anchors moved: ${from} … ${to}`);
  return src.slice(a, b);
};

// ---- Dates ----
test('portal: a bare calendar date reads as that day in Georgia, not the day before', () => {
  const src = between(portal, 'function prettyDate(iso) {', 'function ageFromDob');
  // eslint-disable-next-line no-new-func
  const prettyDate = new Function('window', `${src.replace(/\n\s*\/\/[^\n]*/g, '')} return prettyDate;`)({ GFC_TIME: time });
  assert.equal(prettyDate('2026-10-01'), '10/1', 'Oct 1 must not read Sep 30');
  assert.equal(prettyDate('2026-10-01T02:00:00Z'), '9/30', 'a real instant is still read in Georgia');
});

test('clinician: fmtDate reads a bare date at midday, so it is the same calendar day', () => {
  assert.match(clinical, /const fmtDate = \(iso\) => iso\s*\n\s*\? new Date\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(String\(iso\)\) \? `\$\{iso\}T12:00:00Z` : iso\)/);
});

test('upcoming visits use Georgia\'s date, so tonight\'s visits do not vanish after 8pm', () => {
  const R = require('../patientReadRepository');
  const rows = [{ state: 'scheduled', status: '-', date: '2026-10-01', startTime: '21:00' }];
  // 01:30Z on Oct 2 is 9:30 PM on Oct 1 in Georgia.
  assert.equal(R.selectUpcomingAppointments(rows, new Date('2026-10-02T01:30:00Z')).length, 1);
  assert.equal(R.selectUpcomingAppointments(rows, new Date('2026-10-02T14:00:00Z')).length, 0);
});

test('medication reconciliation stamps OpenEMR with Georgia\'s date', () => {
  const medrec = between(server, "app.post('/api/clinical/patients/:clientId/medrec'", '\n});');
  assert.match(medrec, /const today = practiceToday\(\)/);
  assert.doesNotMatch(medrec, /const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

// ---- Patient portal ----
// Portal P1 (2026-09-29) replaced the old rule's mechanism, not its point. The
// portal used to read OpenEMR live and could say a section "failed to load";
// it now reads published copies, so the equivalent lie is "No allergies
// recorded" over a section that was simply never published. An empty statement
// is a claim about the patient's record and may only show once that section
// HAS been published; before that it says the care team will add it.
test('portal Health tab: "none recorded" only over a section that was actually published', () => {
  // A section with nothing published may show what the app holds (a reconciled
  // list, or what the family reported), labelled; "none" is only ever said over
  // a section that was published or that the app actually holds.
  for (const [key, empty, list] of [['allergies', 'No allergies recorded', 'allergies'], ['medications', 'No medications on your record', 'meds'],
    ['problems', 'No conditions listed yet', 'problems']]) {
    const start = portal.indexOf(`{has('${key}') && (`);
    const block = portal.slice(start, portal.indexOf('</React.Fragment>', start));
    assert.ok(start > 0 && block.includes(`<HealthEmpty title="${empty}"`), empty);
    assert.match(block, new RegExp(`\\{shown\\('${key}'\\) && ${list}\\.length === 0 &&`), `"${empty}" must not show over an unpublished, unheld ${key} section`);
    assert.match(block, new RegExp(`\\{!shown\\('${key}'\\) && <NotYet />\\}`), `an unpublished ${key} section with nothing held says the care team will add it`);
    assert.match(block, new RegExp(`<FromAppNote section="${key}" />`), `app-held ${key} are labelled with their source`);
  }
  assert.match(portal, /const shown = \(k\) => pub\[k\] \|\| !!fromApp\[k\];/);
  assert.doesNotMatch(portal, /degraded\.includes|Please try again in a few minutes/, 'the old "try again in a few minutes" copy is gone with the live read');
});

test('portal signed-consents list: only executed consents, and a copy link only where one opens', () => {
  const route = between(server, "app.get('/api/gfc/documents',", 'const offlinePacketFiles');
  assert.match(route, /\.filter\(k => \['signed', 'signed_offline', 'optin_recorded'\]\.includes\(consents\[k\]\)\)/);
  assert.match(route, /copyUrl: canOpenCopy && registryTypes\.has\(k\) \?/);
  // The client or their POA (client-equivalent): plain family get no copy link.
  assert.match(route, /const canOpenCopy = await isClientOrPoa\(req\.user\);/);
  const gate = between(server, 'const isClientOrPoa = async', 'const requireClientForOwnConsents');
  assert.match(gate, /user\.role === config\.ROLES\.CLIENT\) return true/);
  assert.match(gate, /buildActingIdentity\(user, client\)\.isPoa/);
  assert.match(portal, /onClick=\{s\.copyUrl \? openConsentPdf : undefined\}/);
});

test('portal documents: family and POA get no client-only upload controls', () => {
  assert.match(portal, /view === 'documents' && <GfcDocuments docs=\{docs\} readOnly=\{!!isFamily\}/);
});

test('portal: files stored on this app are fetched with the login token', () => {
  assert.match(portal, /onClick=\{local \? \(e\) => \{ e\.preventDefault\(\); openPdfSecurely\(`\$\{API_URL\}\$\{f\.url\}`, token\); \} : undefined\}/);
  assert.match(server, /allDocs\.filter\(d => \(!d\.slug \|\| d\.slug === client\.slug\) && d\.active !== false\)/);
});

test('portal: a blocked pop-up falls back to a download, and a failure says why', () => {
  const opener = between(portal, 'const openPdfSecurely = async', 'const api = {');
  assert.match(opener, /const opened = kind === 'zip' \? null : window\.open\(blobUrl, '_blank'\);\s*if \(!opened\) \{/);
  assert.match(opener, /alert\(`That document didn't open: \$\{err\.message\}`\)/);
});

test('portal: a failed care-plan load shows an error, not an endless spinner', () => {
  assert.match(portal, /if \(!cp\.error\) \{ setData\(cp\); setDataErr\(''\); \} else setDataErr\(cp\.error\);/);
  assert.match(portal, /\{!data && !dataErr && view !== 'messages'/);
});

test('record release: a structured address is printed as a line, never "[object Object]"', () => {
  assert.match(server, /patientAddress: \(v => \(v && typeof v === 'object'\) \? consentRender\.addressLine\(v\) : String\(v \|\| ''\)\)\(intake\.address \|\| client\.address\)/);
});

// ---- Clinician workspace ----
test('a refused action keeps the form open and what was typed', () => {
  const panel = between(clinical, '    const EncounterPanel = (', '    const App = () =>');
  assert.match(panel, /; return null; \}\)\.finally\(\(\) => setBusy\(''\)\);/, 'run() resolves null on a refusal');
  assert.match(panel, /const onOk = \(fn\) => \(r\) => \{ if \(r\) fn\(r\); return r; \};/);
  for (const closer of ['setShowRx(false)', 'setShowOrder(false)', "setAddendum('')", "setClinAddendum('')"]) {
    const i = panel.indexOf(closer);
    assert.ok(i > 0, closer);
    assert.match(panel.slice(Math.max(0, i - 40), i), /onOk\(\(\) => \{? ?$/, `${closer} only runs on success`);
  }
  assert.doesNotMatch(clinical, /onSent\(send\)\.then\(\(\) => setMode\(''\)\)/);
});

test('coding typed on the encounter survives a reload, and signing waits for it to be saved', () => {
  assert.match(clinical, /if \(!unsaved\) \{\s*setDiagnoses\(r\.record\.diagnoses \|\| \[\]\)/);
  assert.match(clinical, /<FollowUpNoteEditor patient=\{patient\} euuid=\{euuid\} noteSections=\{d\.noteSections\} codingDirty=\{!locked && dirty\}/);
  assert.match(clinical, /disabled=\{!!busy \|\| showSign \|\| codingDirty\}/);
  assert.match(clinical, /if \(codingDirty\) \{ setMsg\(\{ ok: false, text: 'Save your diagnoses and coding on this encounter before signing\.' \}\); return; \}/);
});

test('a Medicare order can carry the 42 CFR 424.507 acknowledgment the server asks for', () => {
  assert.match(clinical, /enrollmentAcknowledgment: \{ acknowledged: ack\.acknowledged, reason: ack\.reason\.trim\(\) \}/);
  assert.match(clinical, /if \(e && e\.data && e\.data\.needsReason\) setOrderEnrollmentWarning\(e\.data\);/);
  // And a protocol that does not permit 'lab' no longer sends 'lab'.
  assert.match(clinical, /setF\(\{ \.\.\.f, standingOrderId: e\.target\.value, tests: '', orderType: first \|\| 'lab' \}\)/);
});

test('co-sign actions exist on the page for orders and IHPC care plans', () => {
  assert.match(clinical, /providerCoSignCarePlan: \(id, signatureImageB64\) => authedFetch\(`\/api\/clinical\/patients\/\$\{id\}\/care-plan\/provider-cosign`/);
  assert.match(clinical, /coSignOrder: \(orderId\) => authedFetch\(`\/api\/clinical\/orders\/\$\{encodeURIComponent\(orderId\)\}\/co-sign`/);
  assert.match(clinical, /\{i\.kind === 'order_co_sign' && i\.actionable && \(/);
  assert.match(clinical, /\{providerPending \? 'Awaiting provider signature'/);
});

test('result, referral and DME titles read the fields the records actually carry', () => {
  assert.doesNotMatch(server, /r\.label \|\| r\.documentName/);
  assert.doesNotMatch(clinical, /r\.label \|\| r\.documentName/);
  assert.match(server, /specialty: \(o\.referral && o\.referral\.specialty\) \|\| o\.specialty \|\| null/);
  assert.match(clinical, /\(o\.referral && o\.referral\.specialty\) \|\| o\.specialty \|\| 'Referral'/);
  assert.match(clinical, /r\.ageDays != null \? `\$\{r\.ageDays\} days since sent` : null,\s*r\.recipientName, r\.recipientFax/);
  const repo = require('../clinicalRepository');
  const t = repo.buildTimeline({
    orders: [{ createdAt: '2026-09-20T15:00:00Z', orderType: 'referral', referral: { specialty: 'Cardiology' }, id: 'o1' }],
    results: [{ receivedAt: '2026-09-21T15:00:00Z', summary: 'BMP normal', id: 'r1' }]
  });
  const titles = t.rows.map(r => r.title || r.label || r.text || JSON.stringify(r));
  assert.ok(titles.some(x => /Cardiology referral/.test(x)), `a referral names its specialty: ${titles}`);
  assert.ok(titles.some(x => /BMP normal/.test(x)), `a result names itself: ${titles}`);
});

test('My Day counts a clinician\'s own orders and results', () => {
  const md = between(server, "app.get('/api/clinical/my-day'", '\n});');
  assert.doesNotMatch(md, /r\.orderingClinicianProviderId/);
  assert.match(md, /isScopeUser\(o\.orderingClinician && o\.orderingClinician\.id,/);
  assert.match(md, /isScopeUser\(r\.routeTo && r\.routeTo\.userId, null\)/);
});

test('a deleted encounter is out of the coding queue and the analytics', () => {
  const q = between(server, "app.get('/api/clinical/encounters/queue'", '\n});');
  assert.match(q, /rows\.filter\(r => !voided\.has\(String\(r\.encounterUuid\)\)\)/);
  const an = between(server, "app.get('/api/clinical/analytics'", '\n});');
  assert.match(an, /!signed\.has\(String\(r\.encounterUuid\)\) && r\.noteStatus !== 'voided'/);
});

test('Save draft retries a note OpenEMR refused, and the editor says it was refused', () => {
  assert.match(server, /sameVisit\(next\.visit, before && before\.visit\) && !ctx\.record\.narrativeSyncError\)/);
  assert.match(clinical, /narrativeSyncError: r\.narrativeSyncError \|\| null,/);
  assert.match(clinical, /\{sn\.meta\.narrativeSyncError\s*\n\s*\? <span className="text-red-700">Saved in the app, but OpenEMR did not take the latest version/);
});

test('medication reconciliation clears its decisions after a save and shows a load error', () => {
  assert.match(clinical, /\.then\(r => \{ setDecisions\(\{\}\); setMsg\(/);
  assert.match(clinical, /if \(!data\) return msg && !msg\.ok \? <p className="text-sm text-red-600 p-4">\{msg\.text\}<\/p>/);
});

test('Start visit resumes a saved shared draft instead of creating a second encounter', () => {
  const chart = between(server, 'const ownDraft = (await loadNoteDrafts())', 'res.json({');
  assert.match(chart, /r\.noteStatus === clinicalNotes\.NOTE_STATUS\.DRAFT && !signedUuids\.has/);
  assert.match(chart, /encounterUuid: sharedDraft \? String\(sharedDraft\.encounterUuid\) : null/);
});

test('Open chart works with a search typed in the patient box, and a stale chart answer is dropped', () => {
  assert.match(clinical, /api\.patients\(''\)\.then\(r => \{\s*const q = \(\(r && r\.patients\) \|\| \[\]\)\.find\(x => x\.id === clientId\);\s*openPatient\(q \|\| \{ id: clientId \}, opts\);/);
  assert.match(clinical, /api\.chart\(p\.id\)\.then\(c => \{ if \(selIdRef\.current === p\.id\) setChart\(c\); \}\)/);
});

test('the enrollment-packet Drive copy checks the key testConnection actually returns', () => {
  assert.doesNotMatch(server, /testConnection\(\)\.then\(r => r && r\.success\)/);
});
