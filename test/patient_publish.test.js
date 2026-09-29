// ============================================================
// Portal P1 (owner-directed, 2026-09-29) — the patient portal reads PUBLISHED
// copies, written when a clinician signs. Patients never read OpenEMR.
//
// Why: since Session 5.2 every OpenEMR read runs as the person asking, and a
// patient, POA or family user has no OpenEMR identity. Every patient Health
// read failed with EMR_NOT_CONNECTED and the portal said "try again in a few
// minutes" forever. Giving the app a system login would undo the Session 5
// decision that there is no shared credential.
//
// The helpers and routes are lifted out of server.js and RUN against fakes —
// not read — with a fake OpenEMR that THROWS if a patient route touches it.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
const clinicalPage = fs.readFileSync(path.join(root, 'public/clinical.html'), 'utf8');
const patientPublish = require('../patientPublish');
const patientRead = require('../patientReadRepository');
const clinicalNotes = require('../clinicalNotes');
const clinicalRepo = require('../clinicalRepository');
const clinicalResults = require('../clinicalResults');
const clinicalRoles = require('../clinicalRoles');
const practiceTime = require('../public/gfc-time');

const slice = (from, to) => {
  const a = server.indexOf(from); const b = server.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `anchors moved: ${from} … ${to}`);
  return server.slice(a, b);
};
// The body of one route, bounded to the ROUTE (its closing `});`), not to
// "whatever comes next" — a scan that runs on reads helpers between routes.
const routeBody = (start) => {
  const a = server.indexOf(start);
  assert.ok(a >= 0, `route moved: ${start}`);
  const b = server.indexOf('\n});\n', a);
  return server.slice(a, b + 5);
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---- The harness: real server code, fake world -----------------------------
const mkRes = () => {
  const r = { statusCode: 200, body: undefined, headers: {},
    status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; },
    send(b) { r.body = b; return r; }, setHeader(k, v) { r.headers[k] = v; } };
  return r;
};

const CLIENT = { id: 'c-1', role: 'client', name: 'Juanita Guess', preferredName: 'Juanita', slug: 'juanita-guess', serviceLine: 'IHPC',
  openEmrPatientId: 'puuid-1', consents: { roiFamily: 'signed', consentToTreat: 'signed' }, sharing: {} };
const CLIENT_USER = { id: 'c-1', role: 'client', name: 'Juanita Guess' };
const FAMILY_USER = { id: 'f-1', role: 'family', name: 'Sam Relative', familyOfClientId: 'c-1', familyIsPoa: false };
const POA_USER = { id: 'f-2', role: 'family', name: 'Luka Agent', familyOfClientId: 'c-1', familyIsPoa: true };
const PROVIDER = { id: 'u-1', role: 'user', name: 'Bethel Godwins', licenseLevel: 'FNP', npi: '1234567893', hasClinicalAccess: true, clinicalRole: 'provider' };
const NURSE = { id: 'u-2', role: 'user', name: 'Rita Nurse', hasClinicalAccess: true, clinicalRole: 'rn' };

const SHARED_NOTE = {
  kind: 'followup', visitDate: '2026-09-28', chiefConcern: 'Blood pressure follow-up',
  subjective: 'Feels **better** this week.\n- less dizzy', objective: 'Alert and comfortable.', assessment: 'Blood pressure improving.',
  plan: 'Continue the current medicine.', sections: {}, hp: {}, confirmedFields: [],
  vitals: { bpSys: '128', bpDia: '78', hr: '72' }
};
const ATTESTATION = {
  id: 'att-1', encounterUuid: 'e1', signedAt: '2026-09-28T15:00:00.000Z',
  signedBy: { id: 'u-1', name: 'Bethel Godwins', licenseLevel: 'FNP', npi: '1234567893' },
  signedByClinicalRole: 'provider', coSignStatus: 'not_required', portalHold: null
};
const RECORD = {
  encounterUuid: 'e1', clientId: 'c-1', date: '2026-09-28', reason: 'Follow-up — Bethel Godwins, FNP (NPI 1234567893)',
  diagnoses: [{ code: 'I10', description: 'Essential hypertension' }], patientSummary: 'We checked your blood pressure.',
  followUpInstructions: 'See you in 4 weeks.', renderingProvider: { name: 'Bethel Godwins' },
  note: SHARED_NOTE, noteStatus: 'signed', narrativeNoteSid: '9', structuredNoteSid: '10', coSignStatus: 'not_required'
};

// A summary-route call needs the publish helpers, the summary route and the
// documents routes: they share loadPublished*/resolvePatientClinicalContext.
const build = (opts = {}) => {
  const store = new Map(Object.entries(opts.seed || {}));
  const db = { get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const loadRows = async (k) => (await db.get(k)) || [];
  const notices = [];
  const notify = {
    visitSummaryReady: async (a) => { notices.push({ type: 'visit_summary_ready', ...a }); return { notified: 1 }; },
    resultReviewed: async (a) => { notices.push({ type: 'result_reviewed', ...a }); return { notified: 1 }; }
  };
  const activity = [];
  const logActivity = async (...a) => { activity.push(a); };
  // A patient route must NEVER touch OpenEMR: any access throws.
  // (The clinician's results-filing route legitimately asks whether OpenEMR is
  // configured; the harness answers "no" only while THAT route runs.)
  const openemrTouched = [];
  const mode = { clinician: false };
  const openemr = new Proxy({}, { get: (_, k) => {
    if (mode.clinician && k === 'isConfigured') return () => false;
    openemrTouched.push(String(k)); throw new Error(`patient route touched openemr.${String(k)}`);
  } });
  const handlers = {};
  const app = { get: (p, ...h) => { handlers[`GET ${p}`] = h[h.length - 1]; }, post: (p, ...h) => { handlers[`POST ${p}`] = h[h.length - 1]; } };
  const users = [CLIENT, FAMILY_USER, POA_USER];
  const drive = { downloads: [], uploads: [] };
  const googledrive = {
    downloadFileBuffer: async (id) => { drive.downloads.push(id); return Buffer.from('%PDF-1.4 fake'); },
    uploadClientDocumentFile: async (name, file) => { drive.uploads.push(file); if (opts.driveFails) throw new Error('drive down'); return { fileId: 'drv-1' }; }
  };
  const publishSrc = slice('const loadPublishedVisits', 'const refuseIfClosed');
  const patientSrc = slice('const resolvePatientClinicalContext', '// GET /api/gfc/clinical/care-plan.pdf — the SIGNED');
  const resultsSrc = slice('const receiveClinicalResult', '// Attach a result to an order.');
  const ackSrc = slice("app.post('/api/clinical/results/:resultId/acknowledge'", '// ── GET /api/clinical/orders/overdue');
  // The REAL actorFromReq, lifted. A fake that dropped clinicalRole made every
  // provider look unlicensed — the trap Session 4.8 recorded.
  const actorSrc = slice('const actorFromReq =', 'const forEncounter =');
  const names = ['db', 'loadRows', 'notify', 'logActivity', 'openemr', 'app', 'patientPublish', 'patientRead', 'clinicalNotes', 'clinicalRepo',
    'clinicalResults', 'practiceTime', 'authenticateToken', 'requireEnrolledClient', 'requireClinicalWrite', 'resolveGfcClientRecord',
    'isConsentSatisfied', 'isClinicalServiceLine', 'getUsers', 'googledrive', 'contentDisposition', 'detectFileType', 'uuidv4',
    'queueNotification', 'appLinks', 'clinicalRoles', 'roiStore', 'consentDefsForServiceLine', 'buildCarePlanPdfForVersion', 'renderConsentPdf', 'serveStoredDocument', 'console'];
  // eslint-disable-next-line no-new-func
  const mk = new Function(...names, `
    ${actorSrc}
    ${publishSrc}
    ${patientSrc}
    ${resultsSrc}
    ${ackSrc}
    return { loadPublishedVisits, upsertPublishedVisit, holdPublishedVisit, dropPublishedForClient, patchPortalOutcome, loadPublishedChart, upsertPublishedChart, publishChartFromEmr, publishEncounterToPortal, applyPublishOutcome, receiveClinicalResult };`);
  const fns = mk(db, loadRows, notify, logActivity, openemr, app, patientPublish, patientRead, clinicalNotes, clinicalRepo,
    clinicalResults, practiceTime, (q, s, n) => n(), (q, s, n) => n(), (q, s, n) => n(),
    async (u) => (u.role === 'client' ? CLIENT_LIVE(opts, u) : (u.familyOfClientId ? CLIENT_LIVE(opts, { id: u.familyOfClientId }) : null)),
    (v) => ['signed', 'signed_offline'].includes(v), (l) => ['IHPC', 'BOTH'].includes(String(l || '').toUpperCase()),
    async () => users, googledrive, (d, n) => `${d}; filename="${n}"`, () => 'application/pdf', () => 'res-1',
    async () => ({ queued: true }), { PATHS: { CLINICAL: '/clinical' } }, clinicalRoles, { listProviderAuthorizations: async () => [] }, () => [],
    async () => ({ buffer: Buffer.from('x'), source: 'x' }), async () => ({ error: 'n/a' }), async () => {},
    { log() {}, error() {}, warn() {} });
  const clinician = (fn) => async (...args) => { mode.clinician = true; try { return await fn(...args); } finally { mode.clinician = false; } };
  return { store, db, loadRows, notices, activity, openemr, openemrTouched, handlers, drive, ...fns,
    receiveClinicalResult: clinician(fns.receiveClinicalResult) };
};
const CLIENT_LIVE = (opts, u) => ({ ...CLIENT, ...(opts.client || {}), id: u.id === 'c-1' || u.familyOfClientId ? 'c-1' : u.id });

const call = async (h, key, user, extra = {}) => {
  const res = mkRes();
  await h.handlers[key]({ user, params: {}, body: {}, query: {}, ...extra }, res);
  return res;
};
const signedCtx = (h, over = {}) => ({
  client: CLIENT, encounterUuid: 'e1', record: { ...RECORD }, attestation: { ...ATTESTATION }, prescriptions: [], orders: [], addenda: [],
  actor: { id: 'u-1', name: 'Bethel Godwins', npi: '1234567893' },
  emr: { getProblems: async () => [], getAllergies: async () => [], getMedicationRequests: async () => [],
    getSoapNote: async () => null },
  ...over
});
const readSummary = async (h, user) => (await call(h, 'GET /api/gfc/clinical/summary', user)).body;
const publish = async (h, over) => h.publishEncounterToPortal(signedCtx(h, over), over && over.opts || {});

// ============================================================
// 1. THE RULE: patients never read OpenEMR (build-enforced)
// ============================================================
test('1. no patient-facing /api/gfc/ route calls openemr.forActor( — patients never read OpenEMR', () => {
  const re = /\napp\.(get|post|put|delete|patch)\('(\/api\/gfc[^']*)'/g;
  const starts = []; let m;
  while ((m = re.exec(server))) starts.push({ at: m.index, path: m[2] });
  const boundaries = [...server.matchAll(/\napp\.(get|post|put|delete|patch|use)\(/g)].map(x => x.index);
  let checked = 0; const offenders = [];
  for (const st of starts) {
    // STAFF routes under /api/gfc/admin/ act as the staff member signed in and
    // are not patient reads; every other /api/gfc/ route is a client/family one.
    if (st.path.startsWith('/api/gfc/admin/')) continue;
    const end = boundaries.find(x => x > st.at + 5) || server.length;
    const body = stripComments(server.slice(st.at, end));
    checked += 1;
    if (/\bopenemr\.forActor\(|\bforActor\(/.test(body)) offenders.push(st.path);
  }
  assert.ok(checked > 15, `the sweep must actually cover the patient routes (${checked})`);
  assert.deepEqual(offenders, []);
});

test('1b. the summary route is served from the published copies and constructs no OpenEMR actor', () => {
  const body = stripComments(routeBody("app.get('/api/gfc/clinical/summary'"));
  assert.ok(!/openemr/.test(body), 'the summary route never references openemr');
  assert.match(body, /loadPublishedChart\(client\.id\)/);
  assert.match(body, /loadPublishedVisits\(\)/);
  assert.ok(!/degraded/.test(body), 'there is no degraded list: nothing is read live');
});

// ============================================================
// 2. The summary is served with NO OpenEMR token, from published rows
// ============================================================
test('2. a client with no OpenEMR token gets their published chart, visits and no `degraded`', async () => {
  const h = build();
  const out = await publish(h);
  assert.equal(out.published, true);
  const s = await readSummary(h, CLIENT_USER);
  assert.equal(h.openemrTouched.length, 0, 'OpenEMR was never touched');
  assert.equal(s.degraded, undefined);
  assert.equal(s.visits.length, 1);
  assert.equal(s.visits[0].date, '2026-09-28');
  assert.equal(s.visits[0].summary.startsWith('We checked your blood pressure.'), true);
  assert.equal(s.publishedFromVisitDate, '2026-09-28');
  assert.ok(s.publishedAt);
});
test('2b. a section never published says so; it is never reported as "empty"', async () => {
  const h = build();
  const s = await readSummary(h, CLIENT_USER);
  assert.deepEqual(s.published, { problems: false, allergies: false, medications: false, vitals: false });
  assert.equal(s.problems, undefined, 'an unpublished section is absent, not []');
  assert.deepEqual(s.visits, []);
});

// ============================================================
// 3. Soft-fail: a publish failure never voids a signature
// ============================================================
test('3. a publish failure returns a warning and portalPublished=false; the republish fixes it', async () => {
  const h = build();
  const boom = signedCtx(h, { emr: { getProblems: async () => { throw new Error('OpenEMR down'); }, getAllergies: async () => [], getMedicationRequests: async () => [], getSoapNote: async () => null } });
  // Chart reads soft-fail per section: the visit still publishes.
  const partial = await h.publishEncounterToPortal(boom);
  assert.equal(partial.published, true);
  assert.match(partial.warning, /problems could not be read/);
  // A throw inside the publish itself is caught and reported, never thrown.
  const broken = signedCtx(h, { record: { ...RECORD, note: undefined, narrativeNoteSid: '9' }, emr: { getSoapNote: async () => { throw new Error('EMR_NOT_CONNECTED'); } } });
  const failed = await h.publishEncounterToPortal(broken);
  assert.equal(failed.published, false);
  assert.match(failed.warning, /signed, but it did not publish/);
  const warnings = []; const rec = { ...RECORD };
  h.applyPublishOutcome(rec, failed, warnings);
  assert.equal(rec.portalPublished, false);
  assert.match(rec.portalPublishError, /EMR_NOT_CONNECTED/);
  assert.equal(warnings.length, 1);
  // The retry (same helper the Publish button calls) succeeds and clears the error.
  const ok = await h.publishEncounterToPortal(signedCtx(h));
  h.applyPublishOutcome(rec, ok, warnings);
  assert.equal(rec.portalPublished, true);
  assert.equal(rec.portalPublishError, null);
});
test('3b. the sign route persists the attestation BEFORE it publishes, and publish cannot throw out of it', () => {
  const body = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/sign'");
  const persisted = body.indexOf("await db.set('encounter_attestations', atts)");
  const published = body.indexOf('publishEncounterToPortal(');
  assert.ok(persisted > 0 && published > persisted, 'publish comes after the attestation is saved');
  assert.match(body, /applyPublishOutcome\(record, await publishEncounterToPortal\(ctx, \{ record, attestation \}\), warnings\)/);
  // The hold is checked, and refused, before ANYTHING is written.
  const hold = body.indexOf('patientPublish.validateHold(');
  assert.ok(hold > 0 && hold < persisted, 'a hold without a reason is refused before the signature is written');
  assert.match(body, /PORTAL_HOLD_REASON_REQUIRED|holdCheck\.code/);
});
test('3c. the Publish button and Refresh portal chart are real, write-gated routes', () => {
  const pub = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/publish'");
  assert.match(pub, /requireClinicalWrite/);
  assert.match(server, /app\.post\('\/api\/clinical\/patients\/:clientId\/portal\/refresh-chart', authenticateToken, requireClinicalWrite/);
  assert.match(pub, /ENCOUNTER_NOT_CLOSED/, 'drafts never publish');
  assert.match(pub, /ENCOUNTER_PENDING_CO_SIGN/, 'an author note publishes from the addendum route');
});

// ============================================================
// 4. Pending co-sign: nothing at sign, published at the addendum
// ============================================================
test('4. an author-signed note (pending clinician addendum) is not published; the addendum publishes it', async () => {
  const h = build();
  const pending = await h.publishEncounterToPortal(signedCtx(h, { record: { ...RECORD, coSignStatus: 'pending' } }));
  assert.equal(pending.published, false);
  assert.equal(pending.skipped, 'PENDING_CO_SIGN');
  assert.deepEqual(await h.loadPublishedVisits(), [], 'nothing was stored');
  // The clinician addendum clears it, and THAT is where it first publishes.
  const cleared = await h.publishEncounterToPortal(signedCtx(h, {
    record: { ...RECORD, coSignStatus: 'cleared', coSignedAt: '2026-09-28T18:00:00.000Z', coSignedBy: { id: 'u-1', name: 'Bethel Godwins', licenseLevel: 'FNP' } },
    attestation: { ...ATTESTATION, signedBy: { id: 'u-2', name: 'Rita Nurse', licenseLevel: 'RN' }, coSignStatus: 'pending' },
    addenda: [{ text: 'I agree with the plan.', by: { name: 'Bethel Godwins', licenseLevel: 'FNP' }, at: '2026-09-28T18:00:00.000Z', kind: 'clinician_addendum' }]
  }));
  assert.equal(cleared.published, true);
  const rows = await h.loadPublishedVisits();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note.addenda[0].kind, 'clinician_addendum');
});
test('4b. the co-sign route publishes; the sign route skips a pending note through the same helper', () => {
  const cosign = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/co-sign'");
  assert.match(cosign, /applyPublishOutcome\(record, await publishEncounterToPortal\(ctx, \{ record, addenda:/);
  const publishFn = slice('const publishEncounterToPortal', 'const applyPublishOutcome');
  assert.match(publishFn, /rec\.coSignStatus === 'pending'\) return \{ published: false, skipped: 'PENDING_CO_SIGN' \}/);
});

// ============================================================
// 5. Addenda are part of the signed record
// ============================================================
test('5. an addendum republishes the visit with the addendum on it', async () => {
  const h = build();
  await publish(h);
  const before = (await h.loadPublishedVisits())[0];
  assert.deepEqual(before.note.addenda, []);
  await h.publishEncounterToPortal(signedCtx(h), { addenda: [{ text: 'Blood pressure log reviewed.', by: { name: 'Bethel Godwins', licenseLevel: 'FNP' }, at: '2026-09-29T10:00:00.000Z' }] });
  const after = (await h.loadPublishedVisits())[0];
  assert.equal(after.note.addenda.length, 1);
  assert.equal(after.note.addenda[0].text, 'Blood pressure log reviewed.');
  assert.equal((await h.loadPublishedVisits()).length, 1, 'one row per encounter, updated in place');
  const s = await readSummary(h, CLIENT_USER);
  assert.equal(s.visits[0].note.addenda.length, 1);
});
test('5b. the addendum and co-signature routes republish an already-published visit', () => {
  const addenda = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/addenda'");
  assert.match(addenda, /if \(ctx\.record\.portalPublished\) \{\s*portalOut = await publishEncounterToPortal\(ctx, \{ addenda:/);
  assert.match(addenda, /await patchPortalOutcome\(ctx\.encounterUuid, portalOut\)/, 'the portal fields are written fresh, not from the stale copy');
  const cosigs = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/co-signatures'");
  assert.match(cosigs, /if \(record\.portalPublished\) \{\s*portalOut = await publishEncounterToPortal\(/);
  assert.match(cosigs, /await patchPortalOutcome\(ctx\.encounterUuid, portalOut\)/);
});

// ============================================================
// 6. The billing-plumbing note is never a patient's note
// ============================================================
test('6. the structured-record note never appears in any payload', async () => {
  const legacyRecord = { ...RECORD, note: undefined };
  for (const soap of [
    { id: '10', subjective: 'anything', objective: 'x', assessment: 'x', plan: 'x' },                        // by sid
    { id: '77', subjective: '[GFC STRUCTURED RECORD v1]\nservices: 99349', objective: 'x', assessment: 'x', plan: 'x' } // by content
  ]) {
    const h = build();
    const out = await h.publishEncounterToPortal(signedCtx(h, { record: legacyRecord, emr: { getProblems: async () => [], getAllergies: async () => [], getMedicationRequests: async () => [], getSoapNote: async () => soap } }));
    assert.equal(out.published, true);
    const row = (await h.loadPublishedVisits())[0];
    assert.equal(row.note, null, 'no note is published from the structured record');
    for (const user of [CLIENT_USER, POA_USER]) {
      const s = JSON.stringify(await readSummary(h, user));
      assert.ok(!/STRUCTURED RECORD|services: 99349/.test(s));
    }
  }
});
test('6b. a legacy OpenEMR-only note is published without its attribution header, NPI or signature block', async () => {
  const h = build();
  const soap = {
    id: '9', subjective: '[GFC CLINICIAN] Bethel Godwins, FNP (NPI 1234567893)\nDocumented by Bethel Godwins\nPatient reports feeling better.',
    objective: 'VITALS — BP 128/78; HR 72; Temp —; RR —; SpO2 97; Wt —; Ht —\nLungs clear.', assessment: 'Stable.',
    plan: 'Continue medicine.\n========================================\nELECTRONICALLY SIGNED\nSigned by Bethel Godwins, FNP (NPI 1234567893)'
  };
  await h.publishEncounterToPortal(signedCtx(h, { record: { ...RECORD, note: undefined }, emr: { getProblems: async () => [], getAllergies: async () => [], getMedicationRequests: async () => [], getSoapNote: async () => soap } }));
  const s = JSON.stringify(await readSummary(h, CLIENT_USER));
  assert.match(s, /Patient reports feeling better/);
  assert.ok(!/1234567893|GFC CLINICIAN|ELECTRONICALLY SIGNED|Documented by/.test(s), 'no NPI, header or signature block from the legacy text');
});
test('6c. no NPI, billing field or attestation text reaches any audience, in any section', async () => {
  const h = build();
  await publish(h);
  for (const user of [CLIENT_USER, POA_USER, FAMILY_USER]) {
    h.store.set('users', []);
    const s = JSON.stringify(await readSummary(h, user));
    assert.ok(!/1234567893|npi|billing|attestation|structuredNote|narrativeNote/i.test(s), `leak for ${user.id}`);
  }
});

// ============================================================
// 7. Holding a note from the portal
// ============================================================
test('7. a held note publishes the summary WITHOUT `note`, for every audience', async () => {
  const h = build();
  const att = { ...ATTESTATION, portalHold: { reason: 'risk_of_harm', by: { name: 'Bethel Godwins' }, at: ATTESTATION.signedAt } };
  await h.publishEncounterToPortal(signedCtx(h, { attestation: att }), { attestation: att });
  const row = (await h.loadPublishedVisits())[0];
  assert.equal(row.note, null);
  assert.deepEqual(row.noteHeld, { reason: 'risk_of_harm' });
  h.store.set('users', []);
  for (const user of [CLIENT_USER, POA_USER]) {
    const s = await readSummary(h, user);
    assert.equal(s.visits.length, 1, 'the summary still publishes');
    assert.equal('note' in s.visits[0], false, `no note for ${user.id}`);
    assert.equal(s.visits[0].noteHeld, true, 'the portal is told the note is available on request');
  }
  // Family whose client shares full visit summaries: still no note.
  const hf = build({ client: { sharing: { visitSummaries: 'full' } } });
  await hf.publishEncounterToPortal(signedCtx(hf, { attestation: att }), { attestation: att });
  assert.equal('note' in (await readSummary(hf, FAMILY_USER)).visits[0], false);
});
test('7b. a hold needs a reason from the fixed list; releasing it is a republish', async () => {
  assert.deepEqual(patientPublish.validateHold(undefined), { hold: null });
  assert.deepEqual(patientPublish.validateHold(false), { hold: null });
  assert.deepEqual(patientPublish.validateHold({ reason: 'patient_request' }), { hold: { reason: 'patient_request' } });
  for (const bad of [{}, { reason: '' }, { reason: 'because' }, true, 'yes', { reason: null }]) {
    const r = patientPublish.validateHold(bad);
    assert.equal(r.code, 'PORTAL_HOLD_REASON_REQUIRED', JSON.stringify(bad));
    assert.equal(r.hold, undefined, 'a bad hold is refused, not read as "no hold"');
  }
  const h = build();
  const held = { ...ATTESTATION, portalHold: { reason: 'patient_request' } };
  await h.publishEncounterToPortal(signedCtx(h, { attestation: held }), { attestation: held });
  assert.equal((await h.loadPublishedVisits())[0].note, null);
  await h.publishEncounterToPortal(signedCtx(h), {});
  assert.ok((await h.loadPublishedVisits())[0].note, 'releasing the hold publishes the note');
});
test('7c. the publish route answers 400 for a hold with no reason and writes nothing', () => {
  const pub = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/publish'");
  const check = pub.indexOf('patientPublish.validateHold(holdInput)');
  const write = pub.indexOf("db.set('encounter_attestations'");
  assert.ok(check > 0 && write > check, 'validated before it writes');
  assert.match(pub, /status\(400\)\.json\(\{ error: check\.error, code: check\.code/);
});

// ============================================================
// 8. Audiences: note and results follow the sharing rules
// ============================================================
test('8. patient and POA get the note; non-POA family only at visitSummaries "full"', async () => {
  const h = build();
  await publish(h);
  h.store.set('users', []);
  for (const user of [CLIENT_USER, POA_USER]) {
    const v = (await readSummary(h, user)).visits[0];
    assert.ok(v.note, `note for ${user.id}`);
    assert.match(JSON.stringify(v.note), /Feels/);
  }
  const summaryOnly = (await readSummary(h, FAMILY_USER)).visits[0];   // default sharing: summary level
  assert.equal('note' in summaryOnly, false);
  assert.equal('summary' in summaryOnly, false, 'the family summary level carries no visit text either');
  const full = build({ client: { sharing: { visitSummaries: 'full' } } });
  await publish(full);
  assert.ok((await readSummary(full, FAMILY_USER)).visits[0].note, 'family with full visit summaries gets the note');
  const none = build({ client: { sharing: { visitSummaries: 'none' } } });
  await publish(none);
  assert.equal((await readSummary(none, FAMILY_USER)).visits, undefined, 'visit summaries off: the section is omitted entirely');
});
test('8b. signatures shown to a patient carry names and dates, never an NPI or billing capacity', async () => {
  const h = build();
  await publish(h);
  const sig = (await readSummary(h, CLIENT_USER)).visits[0].note.signatures;
  assert.equal(sig[0].name, 'Bethel Godwins, FNP');
  assert.deepEqual(Object.keys(sig[0]).sort(), ['at', 'name', 'role']);
});

// ============================================================
// 9. Results: visible on filing, ONE notice on review
// ============================================================
const ORDER = () => ({ id: 'o1', clientId: 'c-1', orderType: 'lab', orderReference: 'GFC-ORD-ABCDEF', encounterUuid: 'e1', status: 'sent',
  orderingClinician: { id: 'u-1', name: 'Bethel Godwins' }, sends: [] });
// `order: null` files an UNMATCHED document (no order, no reference).
const fileResult = async (h, over = {}, { order = ORDER() } = {}) => {
  const req = { user: PROVIDER, params: {}, body: { interpretation: 'abnormal', resultDate: '2026-09-27', performedBy: 'Quest Diagnostics', summary: 'A1c 8.1 — INTERNAL SHORTHAND', ...over }, file: { buffer: Buffer.from('%PDF-1.4 x'), originalname: 'a1c.pdf' } };
  const res = mkRes();
  await h.receiveClinicalResult(req, res, { order, rows: order ? [order] : null, idx: order ? 0 : -1, client: CLIENT });
  return res;
};
const ackReq = (id, body = {}, user = PROVIDER) => ({ user, params: { resultId: id }, body });
test('9. a filed result is on the portal at once, with ZERO notices, and says it is not yet reviewed', async () => {
  const h = build();
  const res = await fileResult(h);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.notices, [], 'nothing is sent at filing');
  const row = (await h.loadRows('clinical_results'))[0];
  assert.ok(row.releasedToPatientAt, 'released at filing');
  assert.equal(row.patientNotifiedAt, null);
  assert.equal(row.patientCopy.storageRef, 'drv-1', 'the patient copy is stored the way a client upload is');
  h.store.set('users', []);
  const s = await readSummary(h, CLIENT_USER);
  assert.equal(s.results.length, 1);
  assert.equal(s.results[0].reviewStatus, 'not_reviewed');
  assert.equal(s.results[0].reviewedBy, null);
  assert.equal(s.results[0].hasFile, true);
});
test('9b. acknowledging sends exactly ONE notice; re-acknowledging sends none', async () => {
  const h = build();
  await fileResult(h);
  const id = (await h.loadRows('clinical_results'))[0].id;
  const res = mkRes();
  await h.handlers['POST /api/clinical/results/:resultId/acknowledge'](ackReq(id, { followUpNote: 'Repeat A1c in 3 months.', patientNote: 'Your sugar is a little high; we will adjust your plan.' }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(h.notices.map(n => n.type), ['result_reviewed']);
  assert.equal(h.notices[0].clientId, 'c-1');
  const again = mkRes();
  await h.handlers['POST /api/clinical/results/:resultId/acknowledge'](ackReq(id, { followUpNote: 'again' }), again);
  assert.equal(again.statusCode, 409);
  assert.equal(h.notices.length, 1, 'still exactly one');
  const row = (await h.loadRows('clinical_results'))[0];
  assert.ok(row.patientNotifiedAt);
  const s = await readSummary(h, CLIENT_USER);
  assert.equal(s.results[0].reviewStatus, 'reviewed');
  assert.equal(s.results[0].reviewedBy, 'Bethel Godwins');
  assert.equal(s.results[0].patientNote, 'Your sugar is a little high; we will adjust your plan.');
});
test('9c. the app\'s interpretation, the inbox summary and the follow-up note NEVER reach a patient payload', async () => {
  const h = build();
  await fileResult(h);
  const id = (await h.loadRows('clinical_results'))[0].id;
  await h.handlers['POST /api/clinical/results/:resultId/acknowledge'](ackReq(id, { followUpNote: 'SECRET-FOLLOWUP-PLAN', patientNote: 'friendly' }), mkRes());
  h.store.set('users', []);
  for (const user of [CLIENT_USER, POA_USER]) {
    const s = JSON.stringify(await readSummary(h, user));
    assert.ok(!/INTERNAL SHORTHAND|SECRET-FOLLOWUP-PLAN|"interpretation"|abnormal|routeTo|patientCopy|storageRef|drv-1/.test(s), `leak for ${user.id}: ${s}`);
  }
  const docs = JSON.stringify((await call(h, 'GET /api/gfc/clinical/documents', CLIENT_USER)).body);
  assert.ok(!/INTERNAL SHORTHAND|SECRET-FOLLOWUP|drv-1/.test(docs));
  for (const f of ['interpretation', 'followUpNote', 'routeTo', 'patientCopy', 'storageRef']) assert.ok(patientRead.CLINICIAN_ONLY_FIELDS.includes(f), f);
  for (const f of patientRead.RESULT_CLINICIAN_ONLY_FIELDS) assert.ok(!patientRead.FILTER_MAP.result.full.includes(f), f);
});
test('9d. a patientNote is optional and is not shown before review', async () => {
  const h = build();
  await fileResult(h, { interpretation: 'normal' });
  const id = (await h.loadRows('clinical_results'))[0].id;
  const rows = await h.loadRows('clinical_results');
  rows[0].patientNote = 'stale text set before review';
  await h.db.set('clinical_results', rows);
  assert.equal((await readSummary(h, CLIENT_USER)).results[0].patientNote, null, 'not shown until reviewed');
  await h.handlers['POST /api/clinical/results/:resultId/acknowledge'](ackReq(id, {}), mkRes());
  assert.equal((await readSummary(h, CLIENT_USER)).results[0].patientNote, null, 'and empty when the clinician wrote none');
});
test('9e. the result notice reaches a POA by name and says nothing about the result', () => {
  const src = fs.readFileSync(path.join(root, 'notifications.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function resultReviewed'), src.indexOf('// ---- 5. Staff asked the client for documents'));
  assert.match(fn, /paragraphs: \['Your test result has been reviewed/, 'opens with "Your test result" so a POA is told whose it is');
  assert.ok(!/resultDate|performedBy|label|interpretation|patientNote|summary/.test(fn.replace(/relatedEntityType|entityType/g, '')), 'no result detail in the notice');
  assert.match(src, /replace\(\/\^Your \(visit\|test result\)\//);
  assert.match(fn, /entityId: `\$\{resultId\}:reviewed`/);
});
test('9f. a result filed while Drive is down is still filed, listed, and warned about', async () => {
  const h = build({ driveFails: true });
  const res = await fileResult(h);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.warnings.join(' '), /portal copy could not be stored/);
  h.store.set('users', []);
  const r = (await readSummary(h, CLIENT_USER)).results[0];
  assert.equal(r.hasFile, false, 'listed without a document to open, never a broken link');
});
test('9j. an UNMATCHED outside record is not on the portal until a clinician reviews it, then it is released with one notice', async () => {
  const h = build();
  const res = await fileResult(h, { interpretation: 'normal' }, { order: null });
  assert.equal(res.statusCode, 200);
  const filed = (await h.loadRows('clinical_results'))[0];
  assert.equal(filed.unmatched, true);
  assert.equal(filed.releasedToPatientAt, null, 'nothing confirms whose it is, so it is not released on filing');
  h.store.set('users', []);
  assert.deepEqual((await readSummary(h, CLIENT_USER)).results, [], 'not listed');
  assert.equal((await call(h, 'GET /api/gfc/clinical/documents/:docId/file', CLIENT_USER, { params: { docId: `result:${filed.id}` } })).statusCode, 404, 'and not openable');
  await h.handlers['POST /api/clinical/results/:resultId/acknowledge'](ackReq(filed.id, {}), mkRes());
  const after = (await h.loadRows('clinical_results'))[0];
  assert.ok(after.releasedToPatientAt, 'released by the review');
  assert.equal(h.notices.length, 1, 'and the patient is told once');
  assert.equal((await readSummary(h, CLIENT_USER)).results.length, 1);
});
test('9k. a result for a CANCELLED order is refused before anything is uploaded or stored', async () => {
  const h = build();
  const res = await fileResult(h, {}, { order: { ...ORDER(), status: 'cancelled' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ORDER_CANCELLED');
  assert.deepEqual(h.drive.uploads, [], 'no Drive copy');
  assert.deepEqual(await h.loadRows('clinical_results'), [], 'no row, so nothing for the patient to see');
});
test('9l. the acknowledgement is saved BEFORE the patient is told, and a result filed meanwhile is not lost', async () => {
  const body = routeBody("app.post('/api/clinical/results/:resultId/acknowledge'");
  const saved = body.indexOf("await db.set('clinical_results', fresh)");
  const told = body.indexOf('notify.resultReviewed(');
  assert.ok(saved > 0 && told > saved, 'persist first, then notify');
  assert.match(body, /const fresh = await loadRows\('clinical_results'\)/, 'the write is onto a copy read just now');
  // Behaviour: a second result filed while the notice is in flight survives.
  const h = build();
  await fileResult(h);
  const id = (await h.loadRows('clinical_results'))[0].id;
  const realNotify = h.notices.push.bind(h.notices);
  h.notices.push = (n) => { const rows = h.store.get('clinical_results'); rows.push({ id: 'filed-meanwhile', clientId: 'c-1', releasedToPatientAt: 'x' }); h.store.set('clinical_results', rows); return realNotify(n); };
  await h.handlers['POST /api/clinical/results/:resultId/acknowledge'](ackReq(id, { followUpNote: 'plan' }), mkRes());
  const ids = (await h.loadRows('clinical_results')).map(r => r.id);
  assert.ok(ids.includes('filed-meanwhile'), 'the result filed during the notice is still there');
  const row = (await h.loadRows('clinical_results')).find(r => r.id === id);
  assert.ok(row.acknowledgedAt && row.patientNotifiedAt);
});
test('9g. a result released BEFORE this feature existed sends no notice at review (it is not on the portal)', () => {
  const ack = routeBody("app.post('/api/clinical/results/:resultId/acknowledge'");
  assert.match(ack, /applied\.result\.releasedToPatientAt && !applied\.result\.patientNotifiedAt/);
});
test('9h. results reach non-POA family only when sharing.results is on; the document follows the same rule', async () => {
  const closed = build();
  await fileResult(closed);
  closed.store.set('users', []);
  assert.equal((await readSummary(closed, FAMILY_USER)).results, undefined, 'default: closed to non-POA family');
  assert.equal(patientRead.SHARING_DEFAULTS.results, false);
  const id = (await closed.loadRows('clinical_results'))[0].id;
  const denied = await call(closed, 'GET /api/gfc/clinical/documents/:docId/file', FAMILY_USER, { params: { docId: `result:${id}` } });
  assert.equal(denied.statusCode, 403);
  const open = build({ client: { sharing: { results: true } } });
  await fileResult(open);
  const oid = (await open.loadRows('clinical_results'))[0].id;
  assert.equal((await readSummary(open, FAMILY_USER)).results.length, 1);
  const got = await call(open, 'GET /api/gfc/clinical/documents/:docId/file', FAMILY_USER, { params: { docId: `result:${oid}` } });
  assert.equal(got.statusCode, 200);
  assert.deepEqual(open.drive.downloads, ['drv-1']);
  // The patient can open their own; another client's result id is a 404.
  const mine = await call(open, 'GET /api/gfc/clinical/documents/:docId/file', CLIENT_USER, { params: { docId: `result:${oid}` } });
  assert.equal(mine.statusCode, 200);
  const rows = await open.loadRows('clinical_results');
  rows.push({ ...rows[0], id: 'other', clientId: 'c-OTHER' });
  await open.db.set('clinical_results', rows);
  const foreign = await call(open, 'GET /api/gfc/clinical/documents/:docId/file', CLIENT_USER, { params: { docId: 'result:other' } });
  assert.equal(foreign.statusCode, 404, 'another client\'s result is never served');
});
test('9i. the patient document index lists result copies and never an OpenEMR-only document', async () => {
  const h = build();
  await fileResult(h);
  const id = (await h.loadRows('clinical_results'))[0].id;
  const docs = (await call(h, 'GET /api/gfc/clinical/documents', CLIENT_USER)).body.documents;
  const row = docs.find(d => d.id === `result:${id}`);
  assert.ok(row && row.openable);
  assert.equal(row.note, 'Not yet reviewed by your care team');
  assert.equal(h.openemrTouched.length, 0);
  const emr = await call(h, 'GET /api/gfc/clinical/documents/:docId/file', CLIENT_USER, { params: { docId: 'emr:5' } });
  assert.equal(emr.statusCode, 404);
  assert.equal(emr.body.code, 'EMR_DOCUMENT_NOT_IN_PORTAL');
});

// ============================================================
// 10. A sharing change takes effect on the next read, with no republish
// ============================================================
test('10. changing the client\'s sharing changes the very next read — nothing is republished', async () => {
  const h = build();
  const chartEmr = { getProblems: async () => [{ id: 'p1', code: { text: 'Hypertension' }, clinicalStatus: { text: 'active' } }],
    getAllergies: async () => [{ id: 'a1', code: { text: 'Penicillin' }, criticality: 'high' }],
    getMedicationRequests: async () => [{ id: 'm1', medicationCodeableConcept: { text: 'Lisinopril 10 mg' }, status: 'active', dosageInstruction: [{ text: 'daily' }] },
      { id: 'm2', medicationCodeableConcept: { text: 'Old drug' }, status: 'stopped' }], getSoapNote: async () => null };
  await h.publishEncounterToPortal(signedCtx(h, { emr: chartEmr }));
  const publishedAt = (await h.loadPublishedChart('c-1')).publishedAt;
  const before = await readSummary(h, FAMILY_USER);
  assert.equal(before.medications, undefined, 'default sharing: medications closed to non-POA family');
  assert.equal(before.allergies, undefined);
  const clientRow = { ...CLIENT, sharing: { medications: true, allergies: true } };
  const h2 = build({ client: { sharing: clientRow.sharing }, seed: Object.fromEntries(h.store) });
  const after = await readSummary(h2, FAMILY_USER);
  assert.deepEqual(after.medications.map(m => m.name), ['Lisinopril 10 mg'], 'stopped medications are not published');
  assert.deepEqual(after.allergies.map(a => a.name), ['Penicillin']);
  assert.equal((await h2.loadPublishedChart('c-1')).publishedAt, publishedAt, 'no republish happened');
  // And the patient always sees the published chart.
  assert.equal((await readSummary(h2, CLIENT_USER)).problems[0].name, 'Hypertension');
});

// ============================================================
// Chart publishing: a failed section keeps the previous copy
// ============================================================
test('a section that fails to read is left as it was published — never overwritten with an empty list', async () => {
  const h = build();
  const good = { getProblems: async () => [{ id: 'p1', code: { text: 'Hypertension' }, clinicalStatus: { text: 'active' } }], getAllergies: async () => [{ id: 'a1', code: { text: 'Penicillin' } }], getMedicationRequests: async () => [], getSoapNote: async () => null };
  await h.publishEncounterToPortal(signedCtx(h, { emr: good }));
  const failing = { ...good, getAllergies: async () => { throw new Error('403'); } };
  const out = await h.publishEncounterToPortal(signedCtx(h, { emr: failing }));
  assert.equal(out.published, true);
  assert.match(out.warning, /allergies could not be read/);
  const chart = await h.loadPublishedChart('c-1');
  assert.equal(chart.allergies.length, 1, 'the earlier allergy list stands');
  assert.equal(chart.history.length >= 1 && chart.history.length <= patientPublish.CHART_HISTORY_MAX, true);
});
test('mergeChart keeps a prior section even when the caller passes an explicit undefined for it', () => {
  // buildPublishedChart leaves a failed section's key OUT, which a spread
  // already handles; this is the other way a failed read can arrive, and the
  // only one the explicit loop in mergeChart exists for.
  const prior = patientPublish.buildPublishedChart({ clientId: 'c', allergies: [{ id: 'a1', code: { text: 'Penicillin' } }], at: '2026-09-01T00:00:00Z' });
  const merged = patientPublish.mergeChart(prior, { clientId: 'c', allergies: undefined, publishedAt: '2026-09-02T00:00:00Z' });
  assert.equal(merged.allergies.length, 1);
  assert.equal(merged.publishedAt, '2026-09-02T00:00:00Z');
});
test('a telehealth visit\'s patient-reported vitals still reach the portal', () => {
  const tele = { ...SHARED_NOTE, visit: { modality: 'telehealth' } };
  const v = patientPublish.vitalsFromNote(tele, '2026-09-28');
  assert.equal(v.bloodPressure, '128/78');
  assert.equal(v.heartRate, '72');
  const two = patientPublish.vitalsFromNote({ ...SHARED_NOTE, vitals: { bpRightSys: '130', bpRightDia: '80', bpLeftSys: '126', bpLeftDia: '78' } }, '2026-09-28');
  assert.equal(two.bloodPressure, '130/80', 'the higher arm, as everywhere else');
  assert.match(two.bloodPressureNote, /left arm 126\/78/);
  assert.equal(patientPublish.vitalsFromNote({ ...SHARED_NOTE, vitals: {} }, 'x'), null, 'nothing recorded: omitted, never an empty panel');
});
test('the chart history is capped and never nests', () => {
  let prior = null;
  for (let i = 0; i < 30; i += 1) prior = patientPublish.mergeChart(prior, patientPublish.buildPublishedChart({ clientId: 'c', problems: [], at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }));
  assert.equal(prior.history.length, patientPublish.CHART_HISTORY_MAX);
  assert.ok(prior.history.every(h => !('history' in h)), 'a snapshot carries no history of its own');
});

// ============================================================
// Republishing tells the patient only what is new
// ============================================================
test('the visit-summary notice goes out on publish, not again for an unchanged republish, and again when the note changes', async () => {
  const h = build();
  await publish(h);
  assert.equal(h.notices.filter(n => n.type === 'visit_summary_ready').length, 1);
  await publish(h);
  assert.equal(h.notices.length, 1, 'unchanged: no second notice');
  const changed = signedCtx(h, { record: { ...RECORD, note: { ...SHARED_NOTE, plan: 'Increase the dose.' } } });
  await h.publishEncounterToPortal(changed);
  assert.equal(h.notices.length, 2, 'the note text changed: the patient is told');
  assert.match(h.notices[0].contentHash, /^[0-9a-f]{16}$/);
  assert.notEqual(h.notices[0].contentHash, h.notices[1].contentHash);
});
test('a co-signature changes no text, so it notifies nobody', () => {
  const a = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: RECORD, attestation: ATTESTATION, addenda: [] });
  const b = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: { ...RECORD, coSignatures: [{ id: 'u-9', name: 'Dr. Co', at: '2026-09-29T00:00:00Z' }] }, attestation: ATTESTATION, addenda: [] });
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(JSON.stringify(a.note.signatures), JSON.stringify(b.note.signatures));
});
test('a draft, a voided note and an unsigned encounter never publish', async () => {
  const h = build();
  assert.equal((await h.publishEncounterToPortal(signedCtx(h, { attestation: null }))).skipped, 'NOT_SIGNED');
  assert.equal((await h.publishEncounterToPortal(signedCtx(h, { record: { ...RECORD, noteStatus: 'voided' } }))).skipped, 'VOIDED');
  assert.deepEqual(await h.loadPublishedVisits(), []);
  assert.deepEqual(h.notices, []);
});

// ============================================================
// Latest visit card content rules
// ============================================================
test('the visit overview is the clinician\'s own words, without the prescription and test sentences the page lists separately', () => {
  const rx = [{ drug: 'Lisinopril', dose: '10 mg', transmission: 'none' }];
  const orders = [{ orderType: 'lab', status: 'ordered', tests: ['A1c'] }];
  const row = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: RECORD, attestation: ATTESTATION, prescriptions: rx, orders, addenda: [] });
  assert.equal(row.visit.overview, 'We checked your blood pressure.');
  assert.match(row.visit.summary, /prescription was recorded/i, 'the long summary still carries them (older readers)');
  assert.ok(!/prescription|Lab work/i.test(row.visit.overview));
  // With no patient summary the overview falls back to the diagnoses, then to a plain sentence.
  const dx = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: { ...RECORD, patientSummary: null }, attestation: ATTESTATION, prescriptions: rx, orders, addenda: [] });
  assert.equal(dx.visit.overview, 'This visit addressed: Essential hypertension.');
  const bare = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: { ...RECORD, patientSummary: null, diagnoses: [] }, attestation: ATTESTATION, prescriptions: rx, orders, addenda: [] });
  assert.match(bare.visit.overview, /completed and signed the note/);
  // Full level carries it; the family summary level still carries no visit text.
  assert.equal(patientRead.filterRow('visit', 'full', row.visit).overview, 'We checked your blood pressure.');
  assert.equal('overview' in patientRead.filterRow('visit', 'summary', row.visit), false);
  assert.match(portal, /\{visit\.overview \|\| visit\.summary\}/);
  assert.match(portal, /<div>\{v\.overview \|\| v\.summary\}<\/div>/);
});
test('the published note carries no raw VITALS shorthand, and the vitals are published on their own', () => {
  const row = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: RECORD, attestation: ATTESTATION, addenda: [] });
  const text = JSON.stringify(row.note);
  assert.ok(!/VITALS|Temp —|RR —/.test(text), 'no clinician shorthand in the note a patient reads');
  assert.match(text, /Alert and comfortable/, 'the rest of the objective section is still there');
  assert.equal(row.vitals.bloodPressure, '128/78');
});
test('the sharing screen says that "full" for family includes the clinician\'s note', () => {
  assert.match(portal, /<option value="full">Full summary and your clinician's note<\/option>/);
});
test('medication changes on the visit are prescriptions that actually went out; today every recorded one shows', () => {
  const rx = [{ drug: 'Lisinopril', dose: '10 mg', transmission: 'none' }, { drug: 'Pending drug', dose: '5 mg', transmission: 'pending' }, { drug: 'Unsent drug', transmission: 'not_sent' }];
  const row = patientPublish.buildPublishedVisit({ clientId: 'c', encounterUuid: 'e1', record: RECORD, attestation: ATTESTATION, prescriptions: rx, addenda: [] });
  assert.deepEqual(row.visit.newPrescriptions.map(r => r.name), ['Lisinopril 10 mg'], 'legacy "none" is recorded and shown; pending and not_sent are not');
});

// ============================================================
// Adversarial review, 2026-09-29: every confirmed finding has a test
// ============================================================
const HP_SOAP = () => ({
  id: '9',
  subjective: '[GFC CLINICIAN] Bethel Godwins, FNP (NPI 1234567893)\nDocumented by Bethel Godwins\nSeen at home, feeling better.',
  objective: `VITALS — BP right arm 130/80; BP left arm 128/78; HR 72; Temp —; RR —; SpO2 97; Wt —; Ht —\n\n${clinicalRepo.HP_SECTION_LABELS.triage.toUpperCase()}:\nTrack: B\nRationale: Complex, high utilisation, likely to exceed the home care budget\n\nLungs clear.`,
  assessment: 'See encounter diagnoses (GFC structured note).',
  plan: 'Continue current medicines.\nRN Track assignment: B — Complex, high utilisation, likely to exceed the home care budget'
});
const legacyCtx = (h, over = {}) => signedCtx(h, { record: { ...RECORD, note: undefined }, emr: { getProblems: async () => [], getAllergies: async () => [], getMedicationRequests: async () => [], getSoapNote: async () => HP_SOAP() }, ...over });

test('R1. an old OpenEMR-only note never shows a patient the RN triage track, its rationale or the writers\' placeholder text', async () => {
  const h = build();
  await h.publishEncounterToPortal(legacyCtx(h));
  h.store.set('users', []);
  const s = JSON.stringify(await readSummary(h, CLIENT_USER));
  assert.match(s, /feeling better/, 'the real note is there');
  assert.ok(!/Track|Rationale|utilisation|home care budget|TRIAGE/i.test(s), 'no staffing decision');
  assert.ok(!/See encounter diagnoses|No objective findings|GFC structured note/.test(s), 'no placeholder text');
  assert.ok(!/1234567893|GFC CLINICIAN|Documented by|VITALS/.test(s));
});

test('R2. A HOLD FAILS CLOSED: it reaches the copy the patient can already read, and needs no OpenEMR read', async () => {
  const h = build();
  await publish(h);
  h.store.set('users', []);
  assert.ok((await readSummary(h, CLIENT_USER)).visits[0].note, 'the note is readable before the hold');
  assert.equal(await h.holdPublishedVisit('c-1', 'e1', { reason: 'risk_of_harm' }), true);
  const v = (await readSummary(h, CLIENT_USER)).visits[0];
  assert.equal('note' in v, false, 'stopped being readable at once');
  assert.equal(v.noteHeld, true);
  // And a held LEGACY note is republished without reading OpenEMR at all, so a
  // lapsed sign-in cannot leave the old text live.
  const legacy = build();
  const held = { ...ATTESTATION, portalHold: { reason: 'patient_request' } };
  let read = false;
  const ctx = legacyCtx(legacy, { attestation: held });
  ctx.emr.getSoapNote = async () => { read = true; throw new Error('EMR_NOT_CONNECTED'); };
  const out = await legacy.publishEncounterToPortal(ctx, { attestation: held });
  assert.equal(out.published, true);
  assert.equal(read, false, 'a held note is never read from OpenEMR');
  assert.equal((await legacy.loadPublishedVisits())[0].note, null);
  // The route applies the hold BEFORE the republish that can fail.
  const body = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/publish'");
  assert.ok(body.indexOf('holdPublishedVisit(') > 0 && body.indexOf('holdPublishedVisit(') < body.indexOf('await publishEncounterToPortal('));
  assert.match(body, /The hold is in force/);
  const holdHelper = slice('const holdPublishedVisit', 'const dropPublishedForClient');
  assert.match(holdHelper, /note: null, noteHeld/);
});

test('R3. only the word "release" releases a hold — null and false are refused', () => {
  const body = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/publish'");
  assert.match(body, /holdInput === null \|\| holdInput === false\) \{\s*return res\.status\(400\)[\s\S]{0,220}PORTAL_HOLD_INVALID/);
  assert.ok(body.indexOf('PORTAL_HOLD_INVALID') < body.indexOf("db.set('encounter_attestations'"), 'refused before anything is written');
});

test('R4. a mismatched client and encounter publish nothing, and a row is only replaced by the same client', async () => {
  const h = build();
  const out = await h.publishEncounterToPortal(signedCtx(h, { record: { ...RECORD, clientId: 'c-OTHER' } }));
  assert.equal(out.published, false);
  assert.equal(out.skipped, 'CLIENT_MISMATCH');
  assert.deepEqual(await h.loadPublishedVisits(), []);
  assert.deepEqual(h.notices, []);
  // Keyed on client AND encounter: the same encounter id under another client is a different row.
  await h.upsertPublishedVisit({ clientId: 'c-1', encounterUuid: 'eX', visit: { date: '2026-01-01' } });
  await h.upsertPublishedVisit({ clientId: 'c-2', encounterUuid: 'eX', visit: { date: '2026-02-02' } });
  const rows = await h.loadPublishedVisits();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.clientId === 'c-1').visit.date, '2026-01-01', 'c-1\'s row was not replaced by c-2\'s publish');
  const pub = routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/publish'");
  assert.match(pub, /ctx\.record\.clientId && ctx\.record\.clientId !== ctx\.client\.id\) \{\s*return res\.status\(404\)/);
});

test('R5. relinking to a different OpenEMR patient removes what was published from the old one', async () => {
  const h = build();
  await publish(h);
  await h.upsertPublishedVisit({ clientId: 'c-2', encounterUuid: 'eY', visit: { date: '2026-01-01' } });
  await h.dropPublishedForClient('c-1');
  assert.equal(await h.loadPublishedChart('c-1'), null);
  assert.deepEqual((await h.loadPublishedVisits()).map(r => r.clientId), ['c-2'], 'only that client\'s rows go');
  const link = routeBody("app.post('/api/clinical/patients/:clientId/link'");
  assert.match(link, /relinkedAway = !!\(client\.openEmrPatientId && String\(client\.openEmrPatientId\) !== String\(puuid\)\)/);
  assert.match(link, /if \(relinkedAway\) await dropPublishedForClient\(client\.id\)/);
  // And nothing carries forward from a chart read from a different patient.
  const prior = patientPublish.buildPublishedChart({ clientId: 'c', allergies: [{ id: 'a1', code: { text: 'Penicillin' } }], sourcePuuid: 'X', at: '2026-01-01T00:00:00Z' });
  const next = patientPublish.buildPublishedChart({ clientId: 'c', medications: [], sourcePuuid: 'Y', at: '2026-02-01T00:00:00Z' });
  const merged = patientPublish.mergeChart(prior, next);
  assert.equal(merged.allergies, undefined, 'the wrong patient\'s allergies are not carried into the right patient\'s chart');
  assert.deepEqual(merged.history, []);
});

test('R6. publishing an OLDER visit never rolls the latest vitals or "updated after your visit" back', () => {
  const mk = (date, bp, uuid) => patientPublish.buildPublishedChart({ clientId: 'c', problems: [], vitals: { date, bloodPressure: bp }, sourceEncounterUuid: uuid, sourceVisitDate: date, sourcePuuid: 'P', at: `${date}T12:00:00Z` });
  const b = patientPublish.mergeChart(null, mk('2026-09-20', '120/80', 'B'));
  const a = patientPublish.mergeChart(b, mk('2026-09-01', '150/90', 'A'));   // visit A's addendum, days later
  assert.equal(a.vitals.bloodPressure, '120/80');
  assert.equal(a.publishedFromVisitDate, '2026-09-20');
  assert.equal(a.sourceEncounterUuid, 'B');
  const c = patientPublish.mergeChart(b, mk('2026-09-25', '118/76', 'C'));   // a newer visit still moves it forward
  assert.equal(c.vitals.bloodPressure, '118/76');
  assert.equal(c.publishedFromVisitDate, '2026-09-25');
});

test('R7. a chart read that fails changes nothing; a partial read keeps its stamps', async () => {
  const h = build();
  const allFail = { getProblems: async () => { throw new Error('x'); }, getAllergies: async () => { throw new Error('x'); }, getMedicationRequests: async () => { throw new Error('x'); } };
  const none = await h.publishChartFromEmr(allFail, CLIENT, { id: 'u-1', name: 'B' }, {});
  assert.equal(none.wrote, false);
  assert.equal(await h.loadPublishedChart('c-1'), null, 'no row, so the "summary is coming" state stays');
  await h.publishEncounterToPortal(signedCtx(h));
  const before = await h.loadPublishedChart('c-1');
  const partial = await h.publishChartFromEmr({ getProblems: async () => [], getAllergies: async () => { throw new Error('x'); }, getMedicationRequests: async () => [] }, CLIENT, { id: 'u-1', name: 'B' },
    { sourceEncounterUuid: 'e-later', sourceVisitDate: '2026-12-31' });
  assert.deepEqual(partial.failed, ['allergies']);
  const after = await h.loadPublishedChart('c-1');
  assert.equal(after.publishedFromVisitDate, before.publishedFromVisitDate, 'a partial read does not claim the chart is as fresh as the new visit');
  assert.equal(after.publishedAt, before.publishedAt);
});

test('R8. the publish date is only shown to an audience that has a published section open', async () => {
  const h = build({ client: { sharing: { visitSummaries: 'none', carePlan: true, appointments: true } } });
  await publish(h);
  const s = await readSummary(h, FAMILY_USER);
  assert.equal(s.publishedAt, null);
  assert.equal(s.publishedFromVisitDate, null, 'family with everything closed learns nothing about the last visit');
  const open = await readSummary(build({ client: { sharing: { visitSummaries: 'summary' } }, seed: Object.fromEntries(h.store) }), FAMILY_USER);
  assert.ok(open.publishedFromVisitDate, 'with visits open it is shown');
});

test('R9. the patient is told only when there is something new to read', async () => {
  const h = build();
  await publish(h);                                                    // first publish: 1 notice
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].hasNote, true);
  // An order moving on (status embedded in the derived summary) is not news.
  await h.publishEncounterToPortal(signedCtx(h, { orders: [{ orderType: 'lab', status: 'sent', tests: ['A1c'] }] }));
  assert.equal(h.notices.length, 1, 'no second email because an order advanced');
  // Placing a hold is not news either.
  const held = { ...ATTESTATION, portalHold: { reason: 'risk_of_harm' } };
  await h.publishEncounterToPortal(signedCtx(h, { attestation: held }), { attestation: held });
  assert.equal(h.notices.length, 1, 'a hold sends no "your note is ready" email');
  // Text changing WHILE the note is held is not news either: the patient cannot read it.
  const heldEdit = signedCtx(h, { attestation: held, record: { ...RECORD, note: { ...SHARED_NOTE, plan: 'Changed while held.' } } });
  await h.publishEncounterToPortal(heldEdit, { attestation: held });
  assert.equal(h.notices.length, 1, 'no email for an edit to a note the patient cannot see');
  // Releasing it IS news, and its notice cannot be swallowed as a duplicate of the first.
  await h.publishEncounterToPortal(signedCtx(h), {});
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[1].contentHash, /:released$/);
  assert.equal(h.notices[1].hasNote, true);
  // A first publish made WITH a hold never mentions a note.
  const first = build();
  await first.publishEncounterToPortal(signedCtx(first, { attestation: held }), { attestation: held });
  assert.equal(first.notices[0].hasNote, false);
  const src = fs.readFileSync(path.join(root, 'notifications.js'), 'utf8');
  assert.match(src, /\$\{hasNote \? ", along with your clinician's note" : ''\}/);
});

test('R10. the portal fields are written onto a record read fresh, never the copy loaded before the OpenEMR reads', async () => {
  const h = build({ seed: { encounter_billing: [{ id: 'r1', encounterUuid: 'e1', billingStatus: 'awaiting_billing', postedCharges: [] }] } });
  // Billing submits while the publish is waiting on OpenEMR.
  const rows = h.store.get('encounter_billing'); rows[0].billingStatus = 'billed'; rows[0].postedCharges = [{ id: 'c1' }]; h.store.set('encounter_billing', rows);
  await h.patchPortalOutcome('e1', { published: true, publishedAt: '2026-09-29T00:00:00Z' });
  const row = h.store.get('encounter_billing')[0];
  assert.equal(row.billingStatus, 'billed', 'billing\'s change is not reverted');
  assert.deepEqual(row.postedCharges, [{ id: 'c1' }]);
  assert.equal(row.portalPublished, true);
  await h.patchPortalOutcome('e1', { published: false, error: 'boom' });
  assert.equal(h.store.get('encounter_billing')[0].portalPublishError, 'boom');
  const body = stripComments(routeBody("app.post('/api/clinical/patients/:clientId/encounters/:euuid/publish'"));
  assert.ok(!/saveBillingRecord/.test(body), 'the publish route no longer saves the whole collection');
});

test('R11. screens: evening timestamps keep their Eastern date, state does not follow a clinician to the next patient, and no button promises what family cannot read', () => {
  assert.ok(!/prettyDate\(String\([^)]*\)\.slice\(0, 10\)\)/.test(portal), 'a timestamp is never sliced to its UTC day before prettyDate');
  for (const expr of ['prettyDate(a.at)', 'prettyDate(sg.at)', 'prettyDate(r.reviewedAt)', 'prettyDate(clinical.publishedAt)']) assert.ok(portal.includes(expr), expr);
  assert.match(clinicalPage, /<RefreshPortalChart key=\{patient\.id\} clientId=\{patient\.id\} \/>/);
  assert.match(clinicalPage, /<PortalPublishCard key=\{`hold:\$\{!!\(d\.attestation && d\.attestation\.portalHold\)\}`\}/);
  assert.match(portal, /\{\('summary' in visit\) && <button className="btn" onClick=\{\(\) => onNavigate\('health'\)\}>/);
  assert.match(portal, /const openPdfSecurely = async \(url, token, kind, filename\)/);
  assert.match(portal, /a\.download = filename \|\| /);
  assert.match(portal, /token, undefined, `\$\{r\.label\}\$\{r\.resultDate \? ` \$\{r\.resultDate\}` : ''\}\.pdf`\)/, 'a result opens under a real file name on iPhone');
});

// ============================================================
// Portal + clinician screens
// ============================================================
test('portal: the live-read wording is gone, the note renders escaped, and a hold reads "available on request"', () => {
  assert.ok(!/couldn't load from your clinical record|Please try again in a few minutes|degraded/.test(portal));
  assert.match(portal, /Updated after your visit on/);
  assert.match(portal, /Your care team will share your health summary after your first visit/);
  assert.match(portal, /is available on request/);
  assert.match(portal, /NF\.renderHtml\(item\.markup\)/, 'the note goes through the shared renderer, which escapes before it formats');
  assert.match(portal, /<script src="\/note-format\.js"><\/script>/);
  assert.match(portal, /Not yet reviewed by your care team/);
  assert.match(portal, /const LatestVisitCard =/);
  assert.match(portal, /<LatestVisitCard visit=\{clinical\.visits\[0\]\}/);
  assert.match(portal, /Message the care team/);
  assert.match(portal, /k="results" label="Test results"/, 'the sharing screen offers results');
  // Module scope (input-focus rule): none of these is declared inside another component.
  for (const name of ['PublishedNote', 'LatestVisitCard', 'ResultRow']) {
    assert.match(portal, new RegExp(`\\n    const ${name} = `));
  }
});
test('clinician page: hold at signing, Publish card, Refresh portal chart, patient note at review', () => {
  assert.match(clinicalPage, /const PortalHoldControl =/);
  assert.match(clinicalPage, /portalHold: portalHold \|\| false/);
  assert.match(clinicalPage, /const PortalPublishCard =/);
  assert.match(clinicalPage, /publishToPortal: \(id, euuid, hold\)/);
  assert.match(clinicalPage, /const RefreshPortalChart =/);
  assert.match(clinicalPage, /refreshPortalChart: \(id\)/);
  assert.match(clinicalPage, /acknowledgeResult: \(resultId, followUpNote, patientNote\)/);
  assert.ok(!/The narrative note is never shown to patients/.test(clinicalPage), 'the old rule\'s copy is gone');
  assert.match(clinicalPage, /Since 2026-09-29 \(owner decision\) the signed note itself is also shown/);
  // A hold with no reason cannot be submitted from either sign surface.
  assert.equal((clinicalPage.match(/\(hold\.on && !hold\.reason\)|\(portalHold\.on && !portalHold\.reason\)/g) || []).length, 2);
});
test('the two published collections are claimed for migration as PHI', () => {
  const reg = require('../dataMigration');
  const find = (k) => (reg.COLLECTION_REGISTRY || []).find(c => c.key === k);
  for (const k of ['patient_published_chart', 'patient_published_visits']) {
    assert.ok(find(k), `${k} is registered`);
    assert.equal(find(k).phi, true);
  }
});
