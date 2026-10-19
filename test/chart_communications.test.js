// Calls and messages into the patient chart (owner, 2026-10-19).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cc = require('../chartCommunications');
const inbox = require('../clinicalInbox');
const gfcTime = require('../public/gfc-time.js');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(root, 'routes/messaging.js'), 'utf8');

const completed = (o) => ({ type: 'call.completed', data: { object: { id: 'AC1', direction: 'incoming', from: '+14045550200', to: '+14049136705', status: 'completed',
  answeredAt: '2026-10-19T14:10:00Z', completedAt: '2026-10-19T14:21:05Z', ...o } } });

test('a completed call is read with its duration, its direction and the two numbers', () => {
  const ev = cc.readCallEvent(completed({}));
  assert.equal(ev.callId, 'AC1');
  assert.equal(ev.patientPhone, '+14045550200');
  assert.equal(ev.officePhone, '+14049136705');
  assert.equal(ev.durationSec, 665);
  assert.equal(ev.answered, true);
  assert.equal(cc.callMinutes(ev.durationSec), 12, 'rounded UP: care management is billed on time');
  assert.equal(cc.callMinutes(61), 2);
  const out = cc.readCallEvent(completed({ direction: 'outgoing', from: '+14049136705', to: ['+14045550100'] }));
  assert.equal(out.patientPhone, '+14045550100', 'an outgoing call is matched on the number it went to');
  assert.equal(out.officePhone, '+14049136705');
  assert.equal(cc.readCallEvent(completed({ duration: 90 })).durationSec, 90, "Quo's own duration wins when it sends one");
});

test('a missed, unanswered or voicemail call is not a conversation to document', () => {
  assert.equal(cc.readCallEvent(completed({ answeredAt: null })).answered, false);
  for (const status of ['missed', 'no-answer', 'busy', 'failed', 'canceled']) {
    assert.equal(cc.readCallEvent(completed({ status })).answered, false, status);
  }
  assert.equal(cc.readCallEvent(completed({ duration: 0 })).answered, false, 'answered and hung up at once');
  assert.equal(cc.readCallEvent({ type: 'call.ringing', data: { object: { id: 'x' } } }), null);
  assert.equal(cc.readCallEvent({ type: 'message.received', data: { object: { id: 'x' } } }), null);
});

test('the summary is read as text items, capped, and Quo text never becomes a format in the note', () => {
  const s = cc.readCallEvent({ type: 'call.summary.completed', data: { object: { callId: 'AC1', summary: ['BP *150*', '', '  spaced   out  '], nextSteps: 'Call Friday' } } });
  assert.deepEqual(s.summary, ['BP *150*', 'spaced out']);
  assert.deepEqual(s.nextSteps, ['Call Friday']);
  const row = cc.mergeSummary(cc.buildCallRow({ id: 'r1', ev: cc.readCallEvent(completed({})), at: 'x',
    hit: { client: { id: 'c1' }, user: { id: 'p1', name: 'Luka Agent' }, isPoa: true } }), s);
  const pre = cc.callNotePrefill(row, { clientName: 'Juanita Guess' });
  assert.match(pre, /Luka Agent \(POA for Juanita Guess\)/);
  assert.match(pre, /12 minutes/);
  assert.match(pre, /Summary from the phone system \(check before signing\)/, 'labelled as the phone system\'s, never the clinician\'s own words');
  assert.match(pre, /BP \\\*150\\\*/, 'a star from Quo is escaped');
  const nf = require('../public/note-format.js');
  assert.ok(!/<strong>150<\/strong>|<em>150/.test(nf.renderHtml(pre)));
  assert.match(cc.callDetail(row, 'Juanita Guess'), /^Incoming call with Luka Agent \(POA for Juanita Guess\), 12 min\. Phone system summary attached\.$/);
  assert.ok(!/150/.test(cc.callDetail(row, 'Juanita Guess')), 'the inbox line carries no summary words');
});

test('message notes: patient-facing conversations only, one per conversation per Eastern day, closed once the day is over', () => {
  const threads = [
    { id: 'cu', channel: 'care_update', client_id: 'c1', participant_ids: ['f1', 'c1'], patient_facing: true },
    { id: 'team', channel: 'care_team', client_id: 'c1', participant_ids: ['f1', 'cm'], audience_chosen: true, patient_facing: false },
    { id: 'other', channel: 'care_update', client_id: 'c2', participant_ids: ['f1', 'c2'], patient_facing: true }
  ];
  // 11:30pm Eastern on the 18th is the 19th in UTC: it belongs to the 18th.
  const late = '2026-10-19T03:30:00Z';
  const messages = [
    { id: 'a', thread_id: 'cu', sent_at: '2026-10-18T14:00:00Z', from_name: 'B', display_name: 'B', from_role: 'clinical', from_role_label: 'Provider', body: '**hi**', body_format: 'markup' },
    { id: 'b', thread_id: 'cu', sent_at: late, from_name: 'L', display_name: 'L as POA for J', from_role: 'POA', body: 'ok', body_format: 'plain', via: 'sms' },
    { id: 'c', thread_id: 'cu', sent_at: '2026-10-19T15:00:00Z', from_name: 'B', display_name: 'B', from_role: 'clinical', body: 'today', body_format: 'plain' },
    { id: 'd', thread_id: 'team', sent_at: '2026-10-18T14:00:00Z', from_name: 'B', display_name: 'B', from_role: 'clinical', body: 'INTERNAL', body_format: 'plain' },
    { id: 'e', thread_id: 'other', sent_at: '2026-10-18T14:00:00Z', from_name: 'B', display_name: 'B', from_role: 'clinical', body: 'other patient', body_format: 'plain' }
  ];
  const notes = cc.buildMessageNotes({ clientId: 'c1', threads, messages, today: '2026-10-19' });
  assert.deepEqual(notes.map(n => n.key).sort(), ['cu:2026-10-18', 'cu:2026-10-19']);
  const y = notes.find(n => n.key === 'cu:2026-10-18');
  assert.equal(y.count, 2, 'the 11:30pm Eastern message is on the 18th');
  assert.equal(y.closed, true);
  assert.equal(notes.find(n => n.key === 'cu:2026-10-19').closed, false);
  const text = cc.messageNoteText(y, { clientName: 'Juanita Guess' });
  assert.match(text, /^MESSAGE NOTE\n/);
  assert.match(text, /B \(Provider\)\nhi/, 'markup becomes plain text');
  assert.match(text, /L as POA for J · by text\nok/);
  assert.ok(!/INTERNAL|other patient/.test(JSON.stringify(notes)));
  assert.match(cc.messageNoteText(y, { corrected: true }), /^MESSAGE NOTE \(CORRECTED COPY\)/);
});

test('filing: closed days only, once, and again as a corrected copy when the day changed', () => {
  const n = (key, closed, hash, count = 1) => ({ key, closed, hash, count });
  const notes = [n('a', true, 'h1'), n('b', false, 'h2'), n('c', true, 'h3'), n('d', true, 'h4', 0)];
  const first = cc.notesToFile(notes, []);
  assert.deepEqual(first.map(x => x.note.key), ['a', 'c'], 'today is never filed, and an empty day is not a note');
  assert.ok(first.every(x => !x.corrected));
  const filings = [{ key: 'a', hash: 'h1', filed_at: '1' }, { key: 'c', hash: 'old', filed_at: '1' }];
  const again = cc.notesToFile(notes, filings);
  assert.deepEqual(again.map(x => x.note.key), ['c']);
  assert.equal(again[0].corrected, true);
  assert.equal(cc.filingState(n('a', true, 'h1'), filings), 'filed');
  assert.equal(cc.filingState(n('c', true, 'h3'), filings), 'changed');
  assert.equal(cc.filingState(n('x', true, 'h'), filings), 'waiting');
  assert.equal(cc.filingState(n('x', false, 'h'), filings), 'open');
  // The latest filing decides.
  assert.equal(cc.notesToFile([n('c', true, 'h3')], filings.concat([{ key: 'c', hash: 'h3', filed_at: '2' }])).length, 0);
});

test('the inbox lists a call for whoever may document it, by name otherwise, and an opened one only for its opener', () => {
  const viewer = { id: 'f1', clinicalRole: 'provider' };
  const calls = [
    { id: 'k1', client_id: 'c1', status: 'waiting', started_at: '2026-10-19T14:00:00Z', detail: 'Incoming call' },
    { id: 'k2', client_id: 'c1', status: 'started', started_by_id: 'f2', started_by_name: 'Other Provider', started_at: '2026-10-19T13:00:00Z' },
    { id: 'k3', client_id: 'c1', status: 'documented' },
    { id: 'k4', client_id: 'c1', status: 'dismissed' },
    { id: 'k5', pending_summary: true, status: undefined }
  ];
  const names = () => ['Bethel Godwins'];
  const mine = inbox.buildInbox({ viewer, calls, canDocumentCall: true, clinicianNamesFor: names, patientNames: { c1: 'Juanita' } });
  const got = mine.items.filter(i => i.kind === 'phone_call');
  assert.deepEqual(got.map(i => i.id).sort(), ['k1', 'k2'], 'documented, dismissed and summary-only rows are not listed');
  assert.equal(got.find(i => i.id === 'k1').actionable, true);
  assert.equal(got.find(i => i.id === 'k2').actionable, false, 'opened by someone else');
  assert.equal(got.find(i => i.id === 'k2').waitingOn, 'Other Provider');
  const lmsw = inbox.buildInbox({ viewer: { id: 'l1', clinicalRole: 'lmsw' }, calls, canDocumentCall: false, clinicianNamesFor: names });
  const k1 = lmsw.items.find(i => i.id === 'k1');
  assert.equal(k1.actionable, false);
  assert.equal(k1.waitingOn, 'Bethel Godwins');
  assert.equal(inbox.KIND_LABELS.phone_call, 'Phone call to document');
  const opener = inbox.buildInbox({ viewer: { id: 'f2' }, calls, canDocumentCall: false });
  assert.equal(opener.items.find(i => i.id === 'k2').actionable, true, 'the opener resumes their own note');
});

test('build: calls arrive through the signed Quo webhook and nothing on that path writes to OpenEMR', () => {
  assert.match(routeSrc, /if \(evt && \/\^call\\\.\/\.test\(String\(evt\.type \|\| ''\)\)\) return handleQuoCall\(evt\);/);
  const fn = routeSrc.slice(routeSrc.indexOf('async function handleQuoCall('), routeSrc.indexOf('async function handleQuoEvent('));
  assert.ok(fn.length > 200);
  assert.ok(!/openemr|forActor/i.test(fn), 'a call never reaches OpenEMR without a clinician');
  assert.match(fn, /if \(!ev\.answered\) return record\('not_answered'\)/);
  assert.match(fn, /if \(ev\.officePhone !== quoSms\.fromNumber\(\)\) return record\('other_line'\)/);
  assert.match(fn, /resolveTexter\(ev\.patientPhone/, 'the same number matching the texts use: an ambiguous number is never guessed');
});

test('build: who may document a call is the same answer the note routes give', () => {
  assert.match(serverSrc, /apptTypes\.canDocumentType\(chartComms\.PHONE_NOTE_TYPE, clinicalRoles\.resolveClinicalRole\(user\)\)\.ok/);
  assert.match(serverSrc, /calls, canDocumentCall: canDocumentCall\(req\.user\), clinicianNamesFor/);
  assert.match(serverSrc, /app\.post\('\/api\/clinical\/calls\/:callId\/document', authenticateToken, requireClinicalDocumenter, requireNoteWriter,/);
  assert.match(serverSrc, /app\.post\('\/api\/clinical\/calls\/:callId\/dismiss', authenticateToken, requireClinicalWrite,/);
  // Message notes are read through the ONE visibility rule.
  assert.match(serverSrc, /messagingRepo\.threadVisibility\(viewer, t, \{ client \}\)/);
  // Filed with the clinician's own sign-in, never a system login.
  const filing = serverSrc.slice(serverSrc.indexOf('const fileMessageNotes = '), serverSrc.indexOf("app.get('/api/clinical/encounters/queue'"));
  assert.match(filing, /emrAuth\.statusFor\(user\.id\)/);
  assert.match(filing, /openemr\.forActor\(user\)\.uploadPatientDocument/);
  assert.match(filing, /clinicalRoles\.canClinicalWrite\(user\)/);
});

test('build: both new collections are registered as PHI', () => {
  const mig = require('../dataMigration');
  const reg = mig.COLLECTION_REGISTRY || mig.REGISTRY || [];
  for (const key of ['phone_calls', 'message_note_filings']) {
    const e = reg.find(x => x.key === key);
    assert.ok(e, key);
    assert.equal(e.phi, true, key);
  }
});

test('build: the Eastern date is used, never the UTC date', () => {
  const src = fs.readFileSync(path.join(root, 'chartCommunications.js'), 'utf8');
  assert.match(src, /gfcTime\.zonedParts\(new Date\(v\)\)/);
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(src));
  assert.equal(cc.easternDate('2026-10-19T03:30:00Z'), '2026-10-18');
  assert.equal(gfcTime.zonedParts(new Date('2026-10-19T03:30:00Z')).isoDate, '2026-10-18');
});
