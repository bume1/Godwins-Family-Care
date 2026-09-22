// ============================================================================
// Session 4.10 Scope C — from the Doximity inbox to an acknowledged result
//
// Before this session "resulted" was a status label a human clicked. No value
// was stored, there was no inbox, and `acknowledgeAbnormalResult` had existed as
// a capability since 4.8 WITH NO ROUTE BEHIND IT.
//
// With results arriving by fax to one person's phone, the two realistic harms
// are AN ABNORMAL RESULT NOBODY WITH AUTHORITY EVER SAW and A RESULT THAT NEVER
// ARRIVED THAT NOBODY NOTICED WAS MISSING. What this file pins:
//
//   1. An interpretation is required — it is what decides who this reaches.
//   2. Status follows EVIDENCE: attaching a result is the only way to 'resulted',
//      and a referral goes to 'completed' instead.
//   3. The inbox routes to the ORDERING clinician; under a standing order that is
//      the AUTHORIZING provider, not the nurse who executed it.
//   4. Abnormal and critical need the capability AND a follow-up note. Normal
//      does not, or the inbox is one nobody but a provider can ever empty.
//   5. A critical result notifies immediately and the notice carries NO PHI.
//   6. Escalation: 4 hours for critical, 2 BUSINESS days for abnormal.
//   7. An unmatched inbound document attaches to the patient and lands in the
//      SAME inbox — a second place for documents is a place nobody opens.
//   8. THE PATIENT SEES NOTHING NEW.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.TZ = require('../public/gfc-time').PRACTICE_TIMEZONE;

const results = require('../clinicalResults');
const roles = require('../clinicalRoles');
const orderReq = require('../orderRequisitions');
const clinicalRepo = require('../clinicalRepository');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CODE = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const SERVER_CODE = CODE(read('server.js'));

const PROVIDER = { id: 'p1', name: 'Bethel Godwins', clinicalRole: 'provider', npi: '1234567893' };
const OTHER_PROVIDER = { id: 'p2', name: 'Dana Prewitt', clinicalRole: 'provider', npi: '1234567893' };
const RN = { id: 'rn1', name: 'Ruth Nightingale', clinicalRole: 'rn' };
const LCSW = { id: 'lc1', name: 'Lee Carter', clinicalRole: 'lcsw' };
const LMSW = { id: 'lm1', name: 'Morgan Shaw', clinicalRole: 'lmsw' };
const READ_ONLY = { id: 'ro1', name: 'Case Manager', clinicalRole: 'readOnly' };
const ADMIN = { id: 'ad1', name: 'GFC Admin', role: 'admin' };

const AT = '2026-09-22T14:00:00.000Z';
const DX = [{ code: 'E11.9', description: 'Type 2 diabetes' }];

const LAB_ORDER = (extra = {}) => ({
  ...clinicalRepo.buildOrder({
    id: 'o-lab', clientId: 'c1', puuid: 'pu1', encounterUuid: 'e1', actor: PROVIDER,
    encounterDiagnoses: DX, at: AT,
    input: { orderType: 'lab', tests: ['A1c'], diagnosisCodes: ['E11.9'] }
  }).order,
  authority: 'direct', ...extra
});
const REFERRAL_ORDER = () => orderReq.buildReferral({
  id: 'o-ref', clientId: 'c1', encounterUuid: 'e1', actor: PROVIDER, encounterDiagnoses: DX, at: AT,
  input: {
    specialty: 'Cardiology', receivingFax: '4045550123', reason: 'AF',
    clinicalSummary: 'Rate control?', diagnosisCodes: ['E11.9']
  }
}).order;

const FILE = { fileName: 'result.pdf', mimeType: 'application/pdf', byteLength: 1024, emrFiled: true };
const resultInput = (extra = {}) => ({
  interpretation: 'normal', resultDate: '2026-09-21', performedBy: 'Quest Diagnostics',
  summary: 'A1c 6.8%, at goal.', ...extra
});
const mk = (order, extra = {}, actor = RN) => results.buildResult({
  id: 'r1', clientId: 'c1', puuid: 'pu1', order, input: resultInput(extra), actor, file: FILE, at: AT
});

// ══════════════════════════════════════════════════════════════════════════
// C1 / C2 — receiving and capturing
// ══════════════════════════════════════════════════════════════════════════

test('C2: an interpretation is REQUIRED — it decides who this reaches and how fast', () => {
  assert.equal(mk(LAB_ORDER(), { interpretation: '' }).code, 'RESULT_NO_INTERPRETATION');
  assert.equal(mk(LAB_ORDER(), { interpretation: 'weird' }).code, 'RESULT_NO_INTERPRETATION');
  assert.deepEqual(results.INTERPRETATIONS, ['normal', 'abnormal', 'critical']);
});

test('C2: the result date, the performing facility, a summary and the file are all required', () => {
  assert.equal(mk(LAB_ORDER(), { resultDate: '' }).code, 'RESULT_NO_DATE');
  assert.equal(mk(LAB_ORDER(), { resultDate: '2026-12-01' }).code, 'RESULT_DATE_FUTURE');
  assert.equal(mk(LAB_ORDER(), { performedBy: '' }).code, 'RESULT_NO_PERFORMER');
  assert.equal(mk(LAB_ORDER(), { summary: '' }).code, 'RESULT_NO_SUMMARY');
  const noFile = results.buildResult({ id: 'r', clientId: 'c1', order: LAB_ORDER(), input: resultInput(), actor: RN, file: null, at: AT });
  assert.equal(noFile.code, 'RESULT_NO_FILE');
});

test('C1: the document files into the CHART, by what it is — never Google Drive', () => {
  // A record RECEIVED FOR CARE belongs in the chart by the document-routing rule
  // in the OpenEMR setup guide. Drive is not configured either way.
  assert.equal(results.categoryFor('lab'), '/Lab Report');
  assert.equal(results.categoryFor('imaging'), '/Imaging');
  assert.equal(results.categoryFor('referral'), '/Consult');
  assert.equal(results.categoryFor(null), '/Medical Record', 'an unmatched inbound document is still a received record');
  const src = CODE(read('clinicalResults.js'));
  assert.ok(!/drive|googledrive/i.test(src), 'results must not go to Drive');
  assert.match(SERVER_CODE, /uploadPatientDocument\(\s*client\.openEmrPatientId, result\.document\.fileName/);
});

test('C1: the file is typed by its BYTES, reusing the sniffer the ROI upload uses', () => {
  // A declared mime type is what the uploader claims; the bytes are what it is.
  assert.match(SERVER_CODE, /const mime = detectFileType\(req\.file\.buffer\);/);
  assert.match(SERVER_CODE, /code: 'RESULT_BAD_FILE_TYPE'/);
  // ONE sniffer in the tree, not a second copy in this session.
  const sniffers = (SERVER_CODE.match(/const detectFileType = /g) || []).length;
  assert.equal(sniffers, 1, 'exactly one magic-byte sniffer');
});

test('C1: a filing failure still records the arrival, and says so', () => {
  // A result that arrived and could not be filed is a FILING problem. Losing the
  // record of its arrival would be worse, and the inbox puts it in front of a
  // clinician either way.
  assert.match(SERVER_CODE, /result\.document\.emrError = e\.message/);
  assert.match(SERVER_CODE, /recorded and in the inbox but did not file into the chart/);
  // The row is written AFTER the filing attempt and regardless of it.
  const handler = SERVER_CODE.slice(SERVER_CODE.indexOf('const receiveClinicalResult'));
  const filePos = handler.indexOf('uploadPatientDocument');
  const savePos = handler.indexOf("db.set('clinical_results'");
  assert.ok(filePos > 0 && savePos > filePos, 'the row is saved after the filing attempt, not conditionally on it');
});

// ══════════════════════════════════════════════════════════════════════════
// C3 — status follows evidence
// ══════════════════════════════════════════════════════════════════════════

test("C3: 'resulted' is unreachable from the generic status route", () => {
  const out = clinicalRepo.advanceOrderStatus(LAB_ORDER(), 'resulted', PROVIDER);
  assert.equal(out.code, 'ORDER_STATUS_NEEDS_EVIDENCE');
  assert.match(out.error, /Attach the result/, 'the refusal names the route that carries the evidence');
  // And the page does not offer the button either — it filters the transitions
  // down to the ones that carry nothing.
  assert.match(CODE(read('public/clinical.html')), /\.filter\(n => n === 'cancelled'\)/);
});

test("C3: attaching a result moves a lab to 'resulted' and a referral to 'completed'", () => {
  // A referral is finished when the consult note comes back; there is no
  // 'resulted' in its lifecycle at all.
  assert.equal(results.resultedStatusFor(LAB_ORDER()), 'resulted');
  assert.equal(results.resultedStatusFor(REFERRAL_ORDER()), 'completed');
  assert.ok(!orderReq.REFERRAL_TRANSITIONS.sent.includes('resulted'));

  const r = mk(LAB_ORDER()).result;
  const moved = results.applyResultToOrder({ order: LAB_ORDER(), result: r, actor: RN, at: AT });
  assert.equal(moved.order.status, 'resulted');
  assert.deepEqual(moved.order.resultIds, ['r1']);
  assert.match(moved.order.statusHistory.slice(-1)[0].note, /Normal result from Quest Diagnostics filed/);

  const refMoved = results.applyResultToOrder({ order: REFERRAL_ORDER(), result: r, actor: RN, at: AT });
  assert.equal(refMoved.order.status, 'completed');
});

test('C3: a cancelled order cannot receive a result', () => {
  const r = mk(LAB_ORDER()).result;
  const out = results.applyResultToOrder({ order: { ...LAB_ORDER(), status: 'cancelled' }, result: r, actor: RN });
  assert.equal(out.code, 'ORDER_CANCELLED');
});

// ══════════════════════════════════════════════════════════════════════════
// C5 — routing, and who may acknowledge
// ══════════════════════════════════════════════════════════════════════════

test('C5: a result routes to the ORDERING clinician', () => {
  const { result } = mk(LAB_ORDER());
  assert.equal(result.routeTo.userId, 'p1');
  assert.equal(result.routeTo.via, 'ordering_clinician');
});

test('C5: under a standing order it routes to the AUTHORIZING PROVIDER, not the executing nurse', () => {
  // This is the whole point. A nurse who executed a protocol cannot act on an
  // abnormal result; the provider whose authority it was under can.
  const executed = LAB_ORDER({
    authority: 'standing_order',
    standingOrder: { id: 'so1', version: 2, title: 'Diabetes monitoring' },
    orderingClinician: { id: 'p1', name: 'Bethel Godwins', npi: '1234567893' },
    executedBy: { id: 'rn1', name: 'Ruth Nightingale', clinicalRole: 'rn' }
  });
  const { result } = mk(executed, { interpretation: 'critical' });
  assert.equal(result.routeTo.userId, 'p1', 'the authorizing provider');
  assert.notEqual(result.routeTo.userId, 'rn1');
  assert.equal(result.routeTo.via, 'authorizing_provider');
  assert.equal(result.routeTo.standingOrderId, 'so1');
  // It reads the ORDER's own orderingClinician rather than re-deriving the rule
  // — 4.8 already files the order that way, and a second derivation would drift.
  assert.match(CODE(read('clinicalResults.js')), /const oc = \(order && order\.orderingClinician\) \|\| \{\};/);
});

test('C5: abnormal and critical need the ACKNOWLEDGE_ABNORMAL_RESULT capability', () => {
  for (const i of ['abnormal', 'critical']) {
    assert.equal(results.canAcknowledge(PROVIDER, i), true, i);
    for (const u of [RN, LCSW, LMSW, READ_ONLY, null, undefined, {}]) {
      assert.equal(results.canAcknowledge(u, i), false, `${(u && u.clinicalRole) || 'nobody'} / ${i}`);
    }
  }
  // The decision goes through the capability matrix, never a hand-rolled role list.
  assert.match(CODE(read('clinicalResults.js')), /roles\.can\(user, roles\.CAPABILITIES\.ACKNOWLEDGE_ABNORMAL_RESULT\)/);
});

test('C5: ANY licensed clinician may acknowledge a NORMAL result — or the inbox never empties', () => {
  // Gating a normal result on the provider capability would leave an inbox
  // nobody but a provider could ever clear, and an inbox that does not empty is
  // one nobody reads.
  for (const u of [PROVIDER, RN, LCSW, LMSW]) {
    assert.equal(results.canAcknowledge(u, 'normal'), true, (u && u.clinicalRole));
  }
  // `readOnly` is still refused: it is chart access, not a licence.
  assert.equal(results.canAcknowledge(READ_ONLY, 'normal'), false);
  assert.equal(results.canAcknowledge(null, 'normal'), false);
});

test('C5: abnormal and critical require a follow-up note saying what is being done', () => {
  // "Acknowledged" on an abnormal result with no plan is a record that somebody
  // SAW it, which is not a record that it was handled.
  for (const i of ['abnormal', 'critical']) {
    const { result } = mk(LAB_ORDER(), { interpretation: i });
    const bare = results.applyAcknowledgement({ result, actor: PROVIDER, input: {}, at: AT });
    assert.equal(bare.code, 'RESULT_NO_FOLLOW_UP', i);
    const withNote = results.applyAcknowledgement({ result, actor: PROVIDER, input: { followUpNote: 'Repeat in two weeks; patient called.' }, at: AT });
    assert.equal(withNote.result.acknowledgedAt, AT);
    assert.equal(withNote.result.followUpNote, 'Repeat in two weeks; patient called.');
    assert.equal(withNote.result.acknowledgedBy.id, 'p1');
    assert.equal(withNote.result.acknowledgedBy.clinicalRole, 'provider');
  }
  // A normal result needs no note.
  const { result: normal } = mk(LAB_ORDER());
  assert.ok(results.applyAcknowledgement({ result: normal, actor: RN, input: {}, at: AT }).result);
});

test('C5: a result cannot be acknowledged twice, and the refusal names who did', () => {
  const { result } = mk(LAB_ORDER());
  const once = results.applyAcknowledgement({ result, actor: RN, input: {}, at: AT }).result;
  const twice = results.applyAcknowledgement({ result: once, actor: PROVIDER, input: {}, at: AT });
  assert.equal(twice.code, 'RESULT_ALREADY_ACKNOWLEDGED');
  assert.match(twice.error, /Ruth Nightingale/);
  assert.equal(twice.status, 409);
});

test('C5: a refused acknowledgement carries the capability and the role, not just "forbidden"', () => {
  const { result } = mk(LAB_ORDER(), { interpretation: 'critical' });
  const out = results.applyAcknowledgement({ result, actor: RN, input: { followUpNote: 'x' }, at: AT });
  assert.equal(out.status, 403);
  assert.equal(out.code, 'CLINICAL_CREDENTIAL');
  assert.equal(out.capability, 'acknowledgeAbnormalResult');
  assert.equal(out.clinicalRole, 'rn');
  assert.match(out.error, /provider/i);
});

// ══════════════════════════════════════════════════════════════════════════
// C5 — the inbox
// ══════════════════════════════════════════════════════════════════════════

const row = (over) => ({
  id: 'x', clientId: 'c1', interpretation: 'normal', receivedAt: AT, createdAt: AT,
  acknowledgedAt: null, routeTo: { userId: 'p1', name: 'Bethel Godwins', via: 'ordering_clinician' },
  summary: 's', performedBy: 'Quest', resultDate: '2026-09-21', unmatched: false, ...over
});

test('C5: critical pinned first, then abnormal, then normal; oldest first within each', () => {
  const rows = [
    row({ id: 'n-new', interpretation: 'normal', receivedAt: '2026-09-22T10:00:00.000Z' }),
    row({ id: 'c-new', interpretation: 'critical', receivedAt: '2026-09-22T10:00:00.000Z' }),
    row({ id: 'a-old', interpretation: 'abnormal', receivedAt: '2026-09-01T10:00:00.000Z' }),
    row({ id: 'c-old', interpretation: 'critical', receivedAt: '2026-09-01T10:00:00.000Z' }),
    row({ id: 'a-new', interpretation: 'abnormal', receivedAt: '2026-09-22T10:00:00.000Z' })
  ];
  const inbox = results.buildInbox(rows, { user: PROVIDER, now: '2026-09-22T11:00:00.000Z' });
  assert.deepEqual(inbox.map(r => r.id), ['c-old', 'c-new', 'a-old', 'a-new', 'n-new'],
    'the oldest unanswered result is the one most likely to have been forgotten');
});

test('C5: an acknowledged result leaves the inbox', () => {
  const rows = [row({ id: 'done', acknowledgedAt: AT }), row({ id: 'open' })];
  assert.deepEqual(results.buildInbox(rows, { user: PROVIDER }).map(r => r.id), ['open']);
});

test('C5: a clinician sees their OWN results; an admin sees every one', () => {
  const rows = [row({ id: 'mine', routeTo: { userId: 'p1' } }), row({ id: 'theirs', routeTo: { userId: 'p2' } })];
  assert.deepEqual(results.buildInbox(rows, { user: PROVIDER }).map(r => r.id), ['mine']);
  assert.deepEqual(results.buildInbox(rows, { user: OTHER_PROVIDER }).map(r => r.id), ['theirs']);
  // Admin is the escalation target, and a result routed to somebody who has left
  // has to be reachable by somebody.
  assert.deepEqual(results.buildInbox(rows, { user: ADMIN, isAdmin: true }).map(r => r.id).sort(), ['mine', 'theirs']);
});

test('C5: an ESCALATED result surfaces to everyone who can act, not only the person who ignored it', () => {
  // That is the point of escalating.
  const stale = row({ id: 'stale', interpretation: 'critical', routeTo: { userId: 'p1' }, receivedAt: '2026-09-22T00:00:00.000Z' });
  const seen = results.buildInbox([stale], { user: OTHER_PROVIDER, now: '2026-09-22T14:00:00.000Z' });
  assert.deepEqual(seen.map(r => r.id), ['stale']);
  assert.equal(seen[0].escalated, true);
  // Before the threshold it is only the routed clinician's.
  assert.deepEqual(results.buildInbox([stale], { user: OTHER_PROVIDER, now: '2026-09-22T02:00:00.000Z' }).map(r => r.id), []);
});

test('C5: an unmatched result is visible to every clinician — routed to nobody is not shown to nobody', () => {
  const orphan = row({ id: 'orphan', unmatched: true, routeTo: { userId: null, via: 'ordering_clinician' } });
  assert.deepEqual(results.buildInbox([orphan], { user: OTHER_PROVIDER }).map(r => r.id), ['orphan']);
  assert.deepEqual(results.buildInbox([orphan], { user: RN }).map(r => r.id), ['orphan']);
});

test('C5: the inbox tells the VIEWER what they may do with each row', () => {
  // The page must not offer an Acknowledge button the API will refuse — the rule
  // `visitLogFiled` set on the caregiver board.
  assert.match(SERVER_CODE, /canAcknowledge: clinicalResults\.canAcknowledge\(req\.user, r\.interpretation\)/);
  assert.match(SERVER_CODE, /followUpRequired: clinicalResults\.needsClinicalJudgement\(r\.interpretation\)/);
  const page = CODE(read('public/clinical.html'));
  assert.match(page, /r\.canAcknowledge \?/);
  assert.match(page, /r\.followUpRequired &&/);
  assert.ok(!/acknowledgeAbnormalResult|clinicalRole === 'provider'/.test(page), 'the page decides no credential rule of its own');
});

// ══════════════════════════════════════════════════════════════════════════
// C5 — the notice, and escalation
// ══════════════════════════════════════════════════════════════════════════

test('C5: the critical notice carries NO PHI — not the value, not the name, not the test', () => {
  const n = results.buildCriticalNotice();
  const all = `${n.subject} ${n.heading} ${n.body} ${n.ctaLabel}`;
  assert.match(n.subject, /A critical result is waiting for your review/);
  // It must not be able to carry anything patient-specific: the builder takes no
  // arguments at all, which is the strongest available guarantee.
  assert.equal(results.buildCriticalNotice.length, 0, 'the notice builder takes no patient data');
  for (const leak of ['Juanita', 'A1c', 'Quest', 'mg/dL', 'E11.9']) {
    assert.ok(!all.includes(leak), `the notice must not carry ${leak}`);
  }
  assert.match(n.body, /no patient or clinical detail/);
  // And the DESTINATION comes from appLinks, never a literal.
  assert.match(SERVER_CODE, /ctaUrl: appLinks\.PATHS\.CLINICAL/);
  assert.match(SERVER_CODE, /queueNotification\('critical_result_waiting'/);
});

test('C5: only a CRITICAL result sends a notice', () => {
  // An abnormal result is chased by the inbox and the escalation, not by paging
  // somebody at every arrival — that is how notifications stop being read.
  const notice = SERVER_CODE.slice(SERVER_CODE.indexOf("critical_result_waiting") - 900, SERVER_CODE.indexOf("critical_result_waiting"));
  assert.match(notice, /result\.interpretation === 'critical'/);
});

test('C5: escalation — 4 hours for critical, 2 BUSINESS days for abnormal', () => {
  assert.equal(results.CRITICAL_ESCALATION_HOURS, 4);
  assert.equal(results.ABNORMAL_ESCALATION_BUSINESS_DAYS, 2);
  const crit = row({ interpretation: 'critical', receivedAt: '2026-09-22T10:00:00.000Z' });
  assert.equal(results.isEscalated(crit, '2026-09-22T13:59:00.000Z'), false, '3h59 is not yet');
  assert.equal(results.isEscalated(crit, '2026-09-22T14:00:00.000Z'), true, '4h is');
  // An ACKNOWLEDGED result never escalates.
  assert.equal(results.isEscalated({ ...crit, acknowledgedAt: AT }, '2026-12-01T00:00:00.000Z'), false);
  // A NORMAL result is not an emergency that nobody has looked at it yet.
  assert.equal(results.isEscalated(row({ interpretation: 'normal' }), '2026-12-01T00:00:00.000Z'), false);
});

test('C5: business days SKIP THE WEEKEND — a Friday result is not two days old on Sunday', () => {
  // An escalation that fires over a weekend teaches people to ignore
  // escalations. 2026-09-18 is a Friday.
  const friday = row({ interpretation: 'abnormal', receivedAt: '2026-09-18T19:00:00.000Z' }); // 3pm ET Friday
  assert.equal(results.isEscalated(friday, '2026-09-20T19:00:00.000Z'), false, 'Sunday: nobody was in the office');
  assert.equal(results.isEscalated(friday, '2026-09-21T19:00:00.000Z'), false, 'Monday is one business day');
  assert.equal(results.isEscalated(friday, '2026-09-22T19:00:00.000Z'), true, 'Tuesday is two');
  // And a mid-week result counts plainly.
  const tuesday = row({ interpretation: 'abnormal', receivedAt: '2026-09-15T19:00:00.000Z' });
  assert.equal(results.isEscalated(tuesday, '2026-09-17T19:00:00.000Z'), true);
  assert.equal(results.businessDaysBetween('2026-09-18T19:00:00.000Z', '2026-09-21T19:00:00.000Z'), 1);
  assert.equal(results.businessDaysBetween('2026-09-18T19:00:00.000Z', '2026-09-22T19:00:00.000Z'), 2);
  // Degenerate inputs are 0, not NaN or a crash.
  assert.equal(results.businessDaysBetween('bad', AT), 0);
  assert.equal(results.businessDaysBetween(AT, AT), 0);
  assert.equal(results.businessDaysBetween(AT, '2026-01-01T00:00:00.000Z'), 0, 'backwards is 0');
});

test('C5: the escalation list names the threshold it passed, and only an admin gets it', () => {
  const rows = [
    row({ id: 'c', interpretation: 'critical', receivedAt: '2026-09-22T00:00:00.000Z' }),
    row({ id: 'a', interpretation: 'abnormal', receivedAt: '2026-09-15T00:00:00.000Z' }),
    row({ id: 'n', interpretation: 'normal', receivedAt: '2026-01-01T00:00:00.000Z' })
  ];
  const esc = results.buildEscalations(rows, '2026-09-22T14:00:00.000Z');
  assert.deepEqual(esc.map(r => r.id), ['c', 'a'], 'a normal result is not escalated');
  assert.equal(esc[0].thresholdDescription, '4 hours');
  assert.equal(esc[1].thresholdDescription, '2 business days');
  assert.match(SERVER_CODE, /escalations: isAdmin \? clinicalResults\.buildEscalations\(results\) : \[\]/);
});

// ══════════════════════════════════════════════════════════════════════════
// C4 — unmatched inbound
// ══════════════════════════════════════════════════════════════════════════

test('C4: a document with no order attaches to the PATIENT and lands in the same inbox', () => {
  const { result } = results.buildResult({
    id: 'r9', clientId: 'c1', puuid: 'pu1', order: null, input: resultInput({ interpretation: 'abnormal' }),
    actor: RN, file: FILE, at: AT
  });
  assert.equal(result.unmatched, true);
  assert.equal(result.orderId, null);
  assert.equal(result.orderReference, null);
  assert.equal(result.document.emrCategory, '/Medical Record');
  assert.equal(result.routeTo.userId, null);
  // One handler behind both routes, so the sniff, the chart filing and the inbox
  // row cannot drift between them.
  assert.equal((SERVER_CODE.match(/const receiveClinicalResult = async/g) || []).length, 1);
  // A BOUNDED SLICE, anchored at both ends, rather than one long regex window —
  // a window that is simply too short fails on the slice boundary and says
  // nothing about the code, which is a trap this repo has already paid for.
  const start = SERVER_CODE.indexOf("patients/:clientId/results'");
  assert.ok(start > 0, 'the unmatched-inbound route must exist');
  const end = SERVER_CODE.indexOf('app.get(', start);
  assert.ok(end > start, 'and the slice must terminate at the next route');
  assert.match(SERVER_CODE.slice(start, end), /receiveClinicalResult\(req, res, found\)/,
    'the unmatched route goes through the SAME handler as the order route');
});

test('C4: the GFC-ORD reference is matched FIRST, and a wrong-patient reference is REFUSED', () => {
  assert.match(SERVER_CODE, /const ref = orderReq\.parseOrderReference\(\(req\.body \|\| \{\}\)\.orderReference\);/);
  // Matching another patient's order would put one patient's result on another's
  // order — the cross-client failure this repo has already paid for once.
  assert.match(SERVER_CODE, /code: 'ORDER_REFERENCE_WRONG_PATIENT'/);
  assert.match(SERVER_CODE, /rows\[idx\]\.clientId !== client\.id/);
  // A reference that matches nothing says so, rather than silently filing it
  // unmatched — the person typed it for a reason.
  assert.match(SERVER_CODE, /code: 'ORDER_REFERENCE_NOT_FOUND'/);
});

// ══════════════════════════════════════════════════════════════════════════
// C7 — the patient sees nothing new
// ══════════════════════════════════════════════════════════════════════════

test('C7: results reach no client or family surface in this session', () => {
  // Releasing a result to a patient is a separate decision about release timing,
  // and it has not been made.
  const patientRead = read('patientReadRepository.js');
  assert.ok(!/clinical_results/.test(patientRead), 'the patient filter map must not carry results');
  // No GFC (client-facing) route reads the collection.
  const gfcRoutes = SERVER_CODE.split('\n').filter(l => /app\.(get|post|put)\('\/api\/gfc\//.test(l));
  for (const l of gfcRoutes) assert.ok(!/results/.test(l), `no client route serves results: ${l.trim()}`);
  // Every results route is under /api/clinical, which is clinical-gated.
  const routeLines = SERVER_CODE.split('\n').filter(l => /app\.(get|post)\('[^']*results?/.test(l));
  assert.ok(routeLines.length >= 3);
  for (const l of routeLines) {
    assert.match(l, /\/api\/clinical\//, `a results route must live under /api/clinical: ${l.trim()}`);
    assert.match(l, /requireClinical(Read|Write)/, `and be clinically gated: ${l.trim()}`);
  }
  // And the portal page does not mention them.
  assert.ok(!/clinical_results|resultsInbox/.test(read('public/portal.html')));
});

// ══════════════════════════════════════════════════════════════════════════
// Non-goals — kept out deliberately, so a later session does not "add them back"
// ══════════════════════════════════════════════════════════════════════════

test('non-goals: no structured lab values, no LOINC, no reference ranges, no trending', () => {
  const src = CODE(read('clinicalResults.js'));
  assert.ok(!/LOINC|referenceRange|trend|analyte|units:/i.test(src),
    'the PDF is the record; a half-parsed lab value is worse than an unparsed PDF because somebody trends it');
  // The result row carries a SUMMARY and a FLAG, not values.
  const { result } = mk(LAB_ORDER());
  assert.ok(!('values' in result));
  assert.ok(!('loinc' in result));
  assert.equal(typeof result.summary, 'string');
  assert.ok(results.INTERPRETATIONS.includes(result.interpretation));
});

test('non-goals: the SCREENING standing-order defect is untouched and still OPEN', () => {
  // The owner deferred it: buildOrder rejects orderType 'screening' before
  // authorizeExecution runs, so screening protocols can be signed but not
  // executed. 4.10 must not add 'screening' to ORDER_TYPES or touch that path.
  assert.ok(!clinicalRepo.ORDER_TYPES.includes('screening'),
    "'screening' must not be added to ORDER_TYPES in this session");
  assert.ok(roles.STANDING_ORDER_TYPES.includes('screening'), 'the protocol side is unchanged');
  assert.match(read('CLAUDE.md'), /screening/i, 'and it is recorded as OPEN');
});

test('the audit trail records the workflow facts and NOT the clinical content', () => {
  // An audit trail is not a second copy of the medical record.
  const audit = SERVER_CODE.slice(SERVER_CODE.indexOf("'result_received'"), SERVER_CODE.indexOf("'result_received'") + 700);
  assert.match(audit, /interpretation: result\.interpretation/);
  assert.match(audit, /performedBy: result\.performedBy/);
  assert.ok(!/summary: result\.summary/.test(audit), 'the summary is clinical content and stays out of the audit row');
  const ackAudit = SERVER_CODE.slice(SERVER_CODE.indexOf("'result_acknowledged'"), SERVER_CODE.indexOf("'result_acknowledged'") + 600);
  assert.match(ackAudit, /followUpRecorded: !!applied\.result\.followUpNote/);
  assert.ok(!/followUpNote: applied\.result\.followUpNote/.test(ackAudit), 'THAT a plan was recorded, never the plan');
});
