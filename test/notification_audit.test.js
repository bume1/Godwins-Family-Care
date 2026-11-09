// The gaps the 2026-11-09 notification audit found: events the app recorded
// and told nobody about.
//
// Every assertion reads the QUEUED NOTIFICATION back — subject, body,
// recipient, PHI marking — rather than checking that a function returned
// without throwing. That matters more here than anywhere else in this repo,
// because the defect being fixed was a notice that looked wired, had a test,
// and had never once sent: the harness's fake queue took a single object,
// which is exactly the shape the buggy call site used, so the fake and the
// bug agreed with each other.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createNotifier } = require('../notifications');

const CLIENT = { id: 'c1', role: 'client', name: 'Ada Bell', email: 'ada@example.com', slug: 'ada-bell' };
const POA = { id: 'p1', role: 'family', name: 'Ruth Bell', email: 'ruth@example.com', familyIsPoa: true, familyOfClientId: 'c1' };
const PLAIN_FAMILY = { id: 'f1', role: 'family', name: 'Ken Bell', email: 'ken@example.com', familyOfClientId: 'c1' };
const ADMIN = { id: 'a1', role: 'admin', name: 'GFC Admin', email: 'admin@godwinsfamilycarellc.com' };
const ADMIN2 = { id: 'a2', role: 'admin', name: 'Bianca Ume', email: 'bianca@godwinsfamilycarellc.com' };
const RN = { id: 'rn1', role: 'user', name: 'Bethel Godwins', email: 'bethel@godwinsfamilycarellc.com' };
const CASE_MGR = { id: 'cm1', role: 'caseManager', name: 'Courtney Hale', email: 'courtney@godwinsfamilycarellc.com' };
const CAREGIVER = { id: 'cg1', role: 'vendor', name: 'Mo Diallo', email: 'mo@example.com', licenseLevel: 'cna' };
const INACTIVE_ADMIN = { id: 'a3', role: 'admin', name: 'Gone', email: 'gone@godwinsfamilycarellc.com', accountStatus: 'inactive' };

function harness({ baaCovered = true, users = null } = {}) {
  const queued = [];
  const notifier = createNotifier({
    getUsers: async () => users || [CLIENT, POA, PLAIN_FAMILY, ADMIN, ADMIN2, RN, CASE_MGR, CAREGIVER, INACTIVE_ADMIN],
    queueNotification: async (type, userId, email, name, templateData, options) => {
      // The REAL queue refuses a row with no address, which is what made the
      // broken welcome-packet call invisible. The fake refuses it too.
      if (!email) return { skipped: true, reason: 'no email address on file' };
      queued.push({ type, userId, email, name, ...templateData, ...options });
      return { id: `n${queued.length}` };
    },
    getAppBaseUrl: async () => 'https://app.godwinsfamilycarellc.com',
    emailTransport: { transportStatus: () => ({ baaCovered }) },
    staffRoles: ['admin', 'user', 'caseManager'],
    clientRole: 'client',
    familyRole: 'family'
  });
  return { notifier, queued, to: (e) => queued.filter(q => q.email === e) };
}

const bothHalves = (q) => `${q.subject}\n${q.body}\n${q.htmlBody}`;

// ===========================================================================
// A1. A caregiver finished their welcome packet — THE NOTICE THAT NEVER SENT
// ===========================================================================

test('A1 the office is told a packet landed, with a real recipient on every row', async () => {
  const h = harness();
  const out = await h.notifier.caregiverPacketSubmitted({
    caregiverName: 'Mo Diallo', packetId: 'pk1', outstandingCount: 3,
    ctaUrl: 'https://app.godwinsfamilycarellc.com/admin'
  });
  assert.ok(out.notified >= 1, 'somebody is told');
  // The bug was a row with no recipient. Every row must resolve to an account.
  assert.ok(h.queued.length >= 1);
  assert.ok(h.queued.every(q => q.email && q.userId), 'every row carries an address and an account id');
  assert.ok(h.to('admin@godwinsfamilycarellc.com').length === 1);
  assert.match(h.queued[0].subject, /Mo Diallo/);
  assert.match(h.queued[0].body, /3 documents are still outstanding/);
  assert.strictEqual(h.queued[0].phi, false, 'employment data about staff, not a patient record');
});

test('A1 a complete checklist is said to be complete, not reported as zero outstanding', async () => {
  const h = harness();
  await h.notifier.caregiverPacketSubmitted({ caregiverName: 'Mo Diallo', packetId: 'pk1', outstandingCount: 0, ctaUrl: 'https://x.test/admin' });
  assert.match(h.queued[0].body, /nothing outstanding/i);
  assert.ok(!/0 documents/.test(h.queued[0].body), 'never "0 documents are outstanding"');
});

test('A1 a caregiver is never told about their own packet landing', async () => {
  const h = harness();
  await h.notifier.caregiverPacketSubmitted({ caregiverName: 'Mo Diallo', packetId: 'pk1', ctaUrl: 'https://x.test/admin' });
  assert.strictEqual(h.to('mo@example.com').length, 0);
  assert.strictEqual(h.to('ada@example.com').length, 0, 'and no client');
});

// ===========================================================================
// A2. A caregiver document was sent back — THE REASON IS THE WHOLE POINT
// ===========================================================================

test('A2 a returned document carries the reason, labelled, in both halves', async () => {
  const h = harness();
  await h.notifier.caregiverDocumentReturned({
    user: CAREGIVER, documentLabel: 'TB test result',
    reason: 'The photo is too blurry to read the expiry date.',
    reviewedByName: 'GFC Admin', ctaUrl: 'https://x.test/caregiver#more'
  });
  const q = h.to('mo@example.com')[0];
  assert.ok(q, 'the caregiver is emailed');
  assert.match(q.subject, /TB test result/);
  assert.match(q.body, /too blurry/, 'the reason reaches the text half');
  assert.match(q.htmlBody, /too blurry/, 'and the HTML half');
  assert.match(q.body, /Why we need it again/i, 'labelled, because the text half has no panel to set it apart');
});

test('A2 with no reason recorded it says so rather than leaving a blank', async () => {
  const h = harness();
  await h.notifier.caregiverDocumentReturned({ user: CAREGIVER, documentLabel: 'Driver licence', reason: '', ctaUrl: 'https://x.test/c' });
  const q = h.to('mo@example.com')[0];
  assert.ok(!/Why we need it again/i.test(q.body), 'no empty labelled panel');
  assert.match(q.body, /sent back/i);
});

test('A2 two returns of the same document are two emails, not one swallowed by dedupe', async () => {
  const h = harness();
  const a = await h.notifier.caregiverDocumentReturned({ user: CAREGIVER, documentLabel: 'TB test result', reason: 'blurry', ctaUrl: 'https://x.test/c' });
  const b = await h.notifier.caregiverDocumentReturned({ user: CAREGIVER, documentLabel: 'TB test result', reason: 'still blurry', ctaUrl: 'https://x.test/c' });
  assert.strictEqual(a.notified, 1);
  assert.strictEqual(b.notified, 1);
  assert.notStrictEqual(h.queued[0].relatedEntityId, h.queued[1].relatedEntityId,
    'keyed on the moment as well as the document, so a second return after they re-send still sends');
});

test('A2 a caregiver with no address on file is a skip, not a crash', async () => {
  const h = harness();
  const out = await h.notifier.caregiverDocumentReturned({ user: { id: 'x', name: 'No Inbox' }, documentLabel: 'W-9', reason: 'r' });
  assert.strictEqual(out.notified, 0);
  assert.match(out.reason, /no email address/);
});

// ===========================================================================
// A3. An incident was closed
// ===========================================================================

test('A3 the caregiver who reported it is told what was done', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.incidentClosed({
    user: CAREGIVER, incidentId: 'i1', kindLabel: 'Fall',
    occurredAt: '2026-11-02T15:00:00Z', note: 'Family called, PCP notified, bed rail fitted.',
    closedByName: 'GFC Admin', ctaUrl: 'https://x.test/caregiver'
  });
  const q = h.to('mo@example.com')[0];
  assert.match(q.body, /Family called/, 'the follow-up note is the news');
  assert.match(q.body, /What was done/i, 'and it is labelled');
  assert.match(q.body, /November 2, 2026/, 'the date is formatted, not an ISO string');
  assert.strictEqual(q.phi, true, 'an incident is about a patient');
});

test('A3 on an uncovered transport it names neither the incident nor the note', async () => {
  const h = harness({ baaCovered: false });
  await h.notifier.incidentClosed({
    user: CAREGIVER, incidentId: 'i1', kindLabel: 'Fall',
    occurredAt: '2026-11-02T15:00:00Z', note: 'Family called, PCP notified.', ctaUrl: 'https://x.test/c'
  });
  const q = h.to('mo@example.com')[0];
  const all = bothHalves(q);
  assert.ok(!/Family called/.test(all), 'the note does not ride an uncovered transport');
  assert.ok(!/Fall/.test(all), 'nor the kind of incident');
  assert.strictEqual(q.phi, false);
});

test('A3 the subject never names a client, covered transport or not', async () => {
  for (const baaCovered of [true, false]) {
    const h = harness({ baaCovered });
    await h.notifier.incidentClosed({ user: CAREGIVER, incidentId: 'i1', kindLabel: 'Fall', note: 'n', ctaUrl: 'https://x.test/c' });
    assert.ok(!/Ada/.test(h.to('mo@example.com')[0].subject), 'a subject shows where the body does not');
  }
});

// ===========================================================================
// A4. A document was removed from a client's file
// ===========================================================================

test('A4 the client and their POA are told, with the reason, and plain family are not', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.clientDocumentRemoved({
    client: CLIENT, uploadId: 'u9', label: 'Insurance card',
    reason: 'It was the wrong card — this is the dental plan.', removedByName: 'GFC Admin'
  });
  assert.strictEqual(h.to('ada@example.com').length, 1);
  assert.strictEqual(h.to('ruth@example.com').length, 1, 'a designated POA is client-equivalent');
  assert.strictEqual(h.to('ken@example.com').length, 0, 'non-POA family are never emailed');
  const q = h.to('ada@example.com')[0];
  assert.match(q.body, /wrong card/);
  assert.match(q.body, /Why it was removed/i);
  assert.strictEqual(q.phi, true);
});

test('A4 on an uncovered transport it names neither the document nor the reason', async () => {
  const h = harness({ baaCovered: false });
  await h.notifier.clientDocumentRemoved({ client: CLIENT, uploadId: 'u9', label: 'Insurance card', reason: 'wrong card' });
  const all = bothHalves(h.to('ada@example.com')[0]);
  assert.ok(!/Insurance card/.test(all));
  assert.ok(!/wrong card/.test(all));
  assert.match(all, /portal/i, 'it still says where to look');
});

// ===========================================================================
// A5. A contractor invoice was answered
// ===========================================================================

test('A5 a rejected invoice carries the note the route demanded', async () => {
  const h = harness();
  await h.notifier.contractorInvoiceDecided({
    user: CAREGIVER, decision: 'rejected', invoiceId: 'ci1', periodLabel: 'IME-2026-10',
    note: 'Two exams are on last month\'s invoice already.', decidedByName: 'GFC Admin', ctaUrl: 'https://x.test/my#hours'
  });
  const q = h.to('mo@example.com')[0];
  assert.strictEqual(q.type, 'contractor_invoice_rejected');
  assert.match(q.body, /already/, 'the note is the point');
  assert.match(q.body, /What needs changing/i);
  assert.match(q.subject, /IME-2026-10/);
});

test('A5 a paid invoice says so and carries no amount or bank reference', async () => {
  const h = harness();
  await h.notifier.contractorInvoiceDecided({
    user: CAREGIVER, decision: 'paid', invoiceId: 'ci1', periodLabel: 'IME-2026-10',
    ctaUrl: 'https://x.test/my#hours'
  });
  const q = h.to('mo@example.com')[0];
  assert.strictEqual(q.type, 'contractor_invoice_paid');
  assert.ok(!/\$/.test(bothHalves(q)), 'no amount in email; the pay screen holds it');
  assert.match(q.body, /pay screen/i);
});

test('A5 approving sends nothing — it is a step on the way, not the news', async () => {
  const h = harness();
  const out = await h.notifier.contractorInvoiceDecided({ user: CAREGIVER, decision: 'approved', invoiceId: 'ci1' });
  assert.strictEqual(out.notified, 0);
  assert.strictEqual(h.queued.length, 0);
});

// ===========================================================================
// A6. Somebody asked for a password reset
// ===========================================================================

test('A6 every active admin is told, and nobody else', async () => {
  const h = harness();
  await h.notifier.passwordResetRequested({
    requesterName: 'Ada Bell', requesterEmail: 'ada@example.com', requestId: 'r1', ctaUrl: 'https://x.test/admin'
  });
  const got = h.queued.map(q => q.email).sort();
  assert.deepStrictEqual(got, ['admin@godwinsfamilycarellc.com', 'bianca@godwinsfamilycarellc.com']);
  assert.strictEqual(h.to('gone@godwinsfamilycarellc.com').length, 0, 'a deactivated admin has no inbox to fill');
  assert.strictEqual(h.to('courtney@godwinsfamilycarellc.com').length, 0, 'a case manager cannot reset a password');
  assert.strictEqual(h.to('bethel@godwinsfamilycarellc.com').length, 0, 'nor a clinician');
});

test('A6 the requester is named only where the transport can carry it', async () => {
  const covered = harness({ baaCovered: true });
  await covered.notifier.passwordResetRequested({ requesterName: 'Ada Bell', requesterEmail: 'ada@example.com', requestId: 'r1', ctaUrl: 'https://x.test/a' });
  assert.match(covered.queued[0].body, /Ada Bell/);
  assert.strictEqual(covered.queued[0].phi, true, 'the requester may be a patient');

  const open = harness({ baaCovered: false });
  await open.notifier.passwordResetRequested({ requesterName: 'Ada Bell', requesterEmail: 'ada@example.com', requestId: 'r1', ctaUrl: 'https://x.test/a' });
  const all = bothHalves(open.queued[0]);
  assert.ok(!/Ada Bell/.test(all));
  assert.ok(!/ada@example.com/.test(all));
  assert.strictEqual(open.queued[0].phi, false);
});

// ===========================================================================
// A7 / A8 / A9. Sign-ups, family invites, feedback
// ===========================================================================

test('A7 a verified sign-up reaches the office and says nobody hears until somebody acts', async () => {
  const h = harness();
  await h.notifier.selfSignupVerified({
    name: 'Ada Bell', email: 'ada@example.com', accountTypeLabel: 'care for a loved one',
    signupId: 's1', ctaUrl: 'https://x.test/admin'
  });
  assert.ok(h.queued.length >= 1);
  assert.match(h.queued[0].body, /nothing reaches them until somebody does/i,
    'the promise made to the signer is restated to the office');
});

test('A8 a family invite reaches the office and never names the client in the subject', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.familyInviteRequested({
    client: CLIENT, inviteeName: 'Ken Bell', inviteeEmail: 'ken@example.com',
    relationship: 'son', requestedByName: 'Ada Bell', inviteId: 'iv1', ctaUrl: 'https://x.test/e'
  });
  const q = h.queued[0];
  assert.ok(!/Ada|Ken/.test(q.subject), 'no names in a subject line');
  assert.match(q.body, /Ken Bell/, 'the body names them on a covered transport');
  assert.strictEqual(q.phi, true);
});

test('A8 a missing invitee address is called out rather than left blank', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.familyInviteRequested({ client: CLIENT, inviteeName: 'Ken Bell', inviteeEmail: '', requestedByName: 'Ada Bell', inviteId: 'iv1', ctaUrl: 'https://x.test/e' });
  assert.match(h.queued[0].body, /No address was given/i);
});

test('A9 a bug report reaches admins, and the report itself only on a covered transport', async () => {
  const covered = harness({ baaCovered: true });
  await covered.notifier.feedbackSubmitted({
    fromName: 'Mo Diallo', fromEmail: 'mo@example.com', category: 'bug',
    message: 'The schedule shows the wrong time for Ada Bell.', feedbackId: 'fb1', ctaUrl: 'https://x.test/admin'
  });
  assert.deepStrictEqual(covered.queued.map(q => q.email).sort(),
    ['admin@godwinsfamilycarellc.com', 'bianca@godwinsfamilycarellc.com']);
  assert.match(covered.queued[0].body, /wrong time for Ada Bell/);
  assert.match(covered.queued[0].body, /What they said/i);

  const open = harness({ baaCovered: false });
  await open.notifier.feedbackSubmitted({ fromName: 'Mo Diallo', category: 'bug', message: 'The schedule shows the wrong time for Ada Bell.', feedbackId: 'fb1', ctaUrl: 'https://x.test/admin' });
  const all = bothHalves(open.queued[0]);
  assert.ok(!/Ada Bell/.test(all), 'free text somebody typed can name a patient');
  assert.strictEqual(open.queued[0].phi, false);
});

// ===========================================================================
// Shared rules: every new notice obeys the house contract
// ===========================================================================

test('every notice added by the audit renders both halves through the house template', async () => {
  const calls = [
    ['caregiverPacketSubmitted', { caregiverName: 'Mo', packetId: 'p', ctaUrl: 'https://x.test/a' }],
    ['caregiverDocumentReturned', { user: CAREGIVER, documentLabel: 'W-9', reason: 'r', ctaUrl: 'https://x.test/a' }],
    ['incidentClosed', { user: CAREGIVER, incidentId: 'i', kindLabel: 'Fall', note: 'n', ctaUrl: 'https://x.test/a' }],
    ['clientDocumentRemoved', { client: CLIENT, uploadId: 'u', label: 'L', reason: 'r' }],
    ['contractorInvoiceDecided', { user: CAREGIVER, decision: 'paid', invoiceId: 'ci', ctaUrl: 'https://x.test/a' }],
    ['passwordResetRequested', { requesterName: 'A', requesterEmail: 'a@b.c', requestId: 'r', ctaUrl: 'https://x.test/a' }],
    ['selfSignupVerified', { name: 'A', email: 'a@b.c', signupId: 's', ctaUrl: 'https://x.test/a' }],
    ['familyInviteRequested', { client: CLIENT, inviteeName: 'K', inviteeEmail: 'k@b.c', requestedByName: 'A', inviteId: 'i', ctaUrl: 'https://x.test/a' }],
    ['feedbackSubmitted', { fromName: 'A', category: 'bug', message: 'm', feedbackId: 'f', ctaUrl: 'https://x.test/a' }]
  ];
  for (const [name, args] of calls) {
    const h = harness({ baaCovered: true });
    assert.strictEqual(typeof h.notifier[name], 'function', `${name} is exported`);
    await h.notifier[name](args);
    assert.ok(h.queued.length >= 1, `${name} queues something`);
    for (const q of h.queued) {
      assert.ok(q.subject && q.subject.length > 5, `${name} has a subject`);
      assert.ok(q.body && q.body.length > 20, `${name} has a text half`);
      assert.ok(q.htmlBody && /<html|<table|<div/i.test(q.htmlBody), `${name} has an HTML half`);
      assert.match(q.htmlBody, /Godwins/, `${name} carries the house chrome`);
      assert.strictEqual(typeof q.phi, 'boolean', `${name} declares whether it is PHI`);
      assert.ok(q.relatedEntityId, `${name} carries a dedupe key`);
    }
  }
});

test('a thrown dependency never propagates out of a notice', async () => {
  const notifier = createNotifier({
    getUsers: async () => { throw new Error('store down'); },
    queueNotification: async () => ({}),
    getAppBaseUrl: async () => 'https://x.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  for (const name of ['caregiverPacketSubmitted', 'passwordResetRequested', 'selfSignupVerified', 'familyInviteRequested', 'feedbackSubmitted']) {
    const out = await notifier[name]({ client: CLIENT, caregiverName: 'x', requesterEmail: 'a@b.c' });
    assert.strictEqual(out.notified, 0, `${name} reports a failure rather than throwing`);
    assert.ok(out.reason, `${name} says why`);
  }
});

// ===========================================================================
// TIER 2 — somebody blocked or affected and not told
// ===========================================================================

test('B1 a cancelled shift tells the holder, with the reason', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.shiftCancelled({
    user: CAREGIVER, when: 'Tue, Nov 11 at 9:00 AM', clientName: 'Ada Bell',
    reason: 'The family is away that week.', ctaUrl: 'https://x.test/caregiver#schedule', shiftId: 's1'
  });
  const q = h.to('mo@example.com')[0];
  assert.match(q.body, /You do not need to go/);
  assert.match(q.body, /family is away/);
  assert.match(q.body, /Why it was cancelled/i);
  assert.strictEqual(q.phi, true, 'it names the client');
});

test('B1 on an uncovered transport it names neither the client nor the reason', async () => {
  const h = harness({ baaCovered: false });
  await h.notifier.shiftCancelled({ user: CAREGIVER, when: 'Tue, Nov 11 at 9:00 AM', clientName: 'Ada Bell', reason: 'away', shiftId: 's1', ctaUrl: 'https://x.test/c' });
  const all = bothHalves(h.to('mo@example.com')[0]);
  assert.ok(!/Ada Bell/.test(all));
  assert.ok(!/away/.test(all));
});

test('B1 the client is told, and a POA is told WHOSE visit it was', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.caregiverVisitCancelled({ clientId: 'c1', when: 'Tue, Nov 11 at 9:00 AM', shiftId: 's1' });
  assert.match(h.to('ada@example.com')[0].body, /^Hi Ada[\s\S]*Your caregiver visit on Tue/m,
    'the client reads "Your caregiver visit"');
  assert.match(h.to('ruth@example.com')[0].body, /Ada Bell's caregiver visit on Tue/,
    'the POA is told whose visit it is — the opening phrase has to be one the rewrite reaches');
  assert.strictEqual(h.to('ken@example.com').length, 0, 'non-POA family are never emailed');
});

test('B1 the office reason is never forwarded to the client', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.caregiverVisitCancelled({ clientId: 'c1', when: 'Tue, Nov 11', shiftId: 's1' });
  const all = bothHalves(h.to('ada@example.com')[0]);
  assert.ok(!/staffing|illness|payment/i.test(all),
    'why the office cancelled is internal; the notice offers to arrange cover instead');
  assert.match(all, /arrange cover/i);
});

test('B2 a declined claim tells the caregiver it went elsewhere', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.shiftClaimDeclined({
    user: CAREGIVER, when: 'Wed, Nov 12 at 1:00 PM', clientName: 'Ada Bell',
    reason: 'Someone closer took it.', ctaUrl: 'https://x.test/c', shiftId: 's2'
  });
  const q = h.to('mo@example.com')[0];
  assert.match(q.body, /gone to another caregiver/i);
  assert.match(q.body, /nothing against you/i, 'a decline that reads as a judgement stops people asking');
  assert.match(q.body, /Someone closer/);
});

test('B3 a coverage request reaches the office and says nothing is scheduled yet', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.coverageRequested({
    client: CLIENT, requestedByName: 'Ruth Bell', when: '2026-11-11 09:00–13:00',
    note: 'Ada needs help with breakfast.', requestId: 'r1', ctaUrl: 'https://x.test/scheduling'
  });
  assert.ok(h.queued.length >= 1);
  assert.match(h.queued[0].body, /Nothing is scheduled until/i,
    'asking is not the same as having cover, and the office should not read it as booked');
  assert.match(h.queued[0].body, /breakfast/);
  assert.strictEqual(h.to('ada@example.com').length, 0, 'the client is not emailed their own request back');
});

test('B4 typed-in hours and a correction are different sentences', async () => {
  const added = harness({ baaCovered: true });
  await added.notifier.timeLogChanged({ user: CAREGIVER, when: 'Mon, Nov 10', clientName: 'Ada Bell', reason: 'Phone died', created: true, ctaUrl: 'https://x.test/p', logId: 't1' });
  assert.match(added.to('mo@example.com')[0].subject, /added/i);

  const fixed = harness({ baaCovered: true });
  await fixed.notifier.timeLogChanged({ user: CAREGIVER, when: 'Mon, Nov 10', clientName: 'Ada Bell', reason: 'Clocked out late', created: false, ctaUrl: 'https://x.test/p', logId: 't1' });
  assert.match(fixed.to('mo@example.com')[0].subject, /corrected/i);
  assert.match(fixed.to('mo@example.com')[0].body, /tell the office/i,
    'their pay record changed, so the notice has to give them a way to dispute it');
});

test('B5 the client and POA are told a care plan is waiting on them', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.carePlanAwaitingCoSign({ client: CLIENT, version: 2, authorName: 'Bethel Godwins' });
  assert.strictEqual(h.to('ada@example.com').length, 1);
  assert.strictEqual(h.to('ruth@example.com').length, 1);
  assert.strictEqual(h.to('ken@example.com').length, 0);
  assert.match(h.to('ada@example.com')[0].body, /Bethel Godwins/);
  assert.match(h.to('ada@example.com')[0].body, /Tell us if anything in it is wrong before you sign/i,
    'signing is consent, so the notice says they can object first');
});

test('B5 the provider holding the co-signature is told, and named no patient on an open transport', async () => {
  const covered = harness({ baaCovered: true });
  await covered.notifier.carePlanAwaitingProviderCoSign({ provider: RN, client: CLIENT, version: 2, authorName: 'Nia Hall', ctaUrl: 'https://x.test/clinical' });
  assert.match(covered.to('bethel@godwinsfamilycarellc.com')[0].body, /Ada Bell/);
  assert.match(covered.to('bethel@godwinsfamilycarellc.com')[0].body, /not complete until you sign/i);

  const open = harness({ baaCovered: false });
  await open.notifier.carePlanAwaitingProviderCoSign({ provider: RN, client: CLIENT, version: 2, authorName: 'Nia Hall', ctaUrl: 'https://x.test/clinical' });
  assert.ok(!/Ada Bell/.test(bothHalves(open.to('bethel@godwinsfamilycarellc.com')[0])));
});

test('B6 the author who was blocked on a co-signature is told it landed', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.carePlanProviderCoSigned({ user: RN, client: CLIENT, version: 2, providerName: 'Dr Okafor', ctaUrl: 'https://x.test/clinical' });
  const q = h.to('bethel@godwinsfamilycarellc.com')[0];
  assert.match(q.body, /Dr Okafor/);
  assert.match(q.body, /complete and filed/i);
});

test('B7 a referral accepted and a referral completed are different news', async () => {
  const a = harness({ baaCovered: true });
  await a.notifier.referralStepTaken({ user: RN, step: 'accepted', colleagueName: 'Courtney Hale', specialty: 'behavioral health', orderId: 'o1', ctaUrl: 'https://x.test/c' });
  assert.strictEqual(a.queued[0].type, 'referral_accepted');
  assert.match(a.queued[0].body, /hear again when it is completed/i);

  const c = harness({ baaCovered: true });
  await c.notifier.referralStepTaken({ user: RN, step: 'completed', colleagueName: 'Courtney Hale', specialty: 'behavioral health', orderId: 'o1', ctaUrl: 'https://x.test/c' });
  assert.strictEqual(c.queued[0].type, 'referral_completed');
  assert.match(c.queued[0].body, /note is on the order/i);
});

test('B7 no other referral step sends anything, and no patient is ever named', async () => {
  const h = harness({ baaCovered: true });
  for (const step of ['ordered', 'cancelled', 'sent', undefined]) {
    const out = await h.notifier.referralStepTaken({ user: RN, step, orderId: 'o1' });
    assert.strictEqual(out.notified, 0, `no notice for "${step}"`);
  }
  assert.strictEqual(h.queued.length, 0);
  const named = harness({ baaCovered: true });
  await named.notifier.referralStepTaken({ user: RN, step: 'completed', colleagueName: 'Courtney Hale', orderId: 'o1', ctaUrl: 'https://x.test/c' });
  assert.ok(!/Ada/.test(bothHalves(named.queued[0])), 'a hand-off between colleagues is not a clinical summary');
});

test('B8 an abnormal result pages the clinician and is handed no patient at all', async () => {
  const h = harness({ baaCovered: false });
  await h.notifier.abnormalResultWaiting({ user: RN, resultId: 'r1', ctaPath: '/clinical' });
  const q = h.to('bethel@godwinsfamilycarellc.com')[0];
  assert.match(q.subject, /abnormal result is waiting/i);
  assert.match(q.body, /two business days/i, 'it says what happens if it is left');
  assert.strictEqual(q.phi, false, 'nothing about a patient reaches it, so it sends on any transport');
  assert.match(q.ctaUrl, /^https?:\/\//, 'it builds an absolute link from the base URL itself');
});

test('B9 a payment receipt carries the amount only where the transport can take it', async () => {
  const covered = harness({ baaCovered: true });
  await covered.notifier.paymentReceived({ client: CLIENT, invoiceId: 'i1', amountLabel: '$40.00' });
  assert.match(covered.to('ada@example.com')[0].body, /\$40\.00/);
  assert.strictEqual(covered.to('ruth@example.com').length, 1, 'a POA manages the money');

  const open = harness({ baaCovered: false });
  await open.notifier.paymentReceived({ client: CLIENT, invoiceId: 'i1', amountLabel: '$40.00' });
  assert.ok(!/\$40\.00/.test(bothHalves(open.to('ada@example.com')[0])));
  assert.match(bothHalves(open.to('ada@example.com')[0]), /settled/i, 'it still says the statement is settled');
});

test('B10 clinical enrollment activation reaches the patient and their POA', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.clinicalEnrollmentActivated({ client: CLIENT });
  assert.strictEqual(h.to('ada@example.com').length, 1);
  assert.strictEqual(h.to('ruth@example.com').length, 1);
  assert.strictEqual(h.to('ken@example.com').length, 0);
  assert.match(h.to('ada@example.com')[0].body, /clinician will be in touch/i);
});

test('B11 each kind of access change has its own wording, and an unknown kind sends nothing', async () => {
  const seen = new Set();
  for (const change of ['mfa_reset', 'sessions_revoked', 'deactivated', 'role_changed']) {
    const h = harness();
    const out = await h.notifier.accountAccessChanged({ user: CAREGIVER, change, byName: 'GFC Admin', ctaUrl: 'https://x.test/login' });
    assert.strictEqual(out.notified, 1, change);
    const q = h.to('mo@example.com')[0];
    assert.ok(!seen.has(q.subject), `${change} has wording of its own`);
    seen.add(q.subject);
    assert.match(q.body, /Changed by GFC Admin|GFC Admin/, `${change} says who did it`);
    assert.strictEqual(q.phi, false, 'about their own account, not a patient record');
  }
  const h = harness();
  const out = await h.notifier.accountAccessChanged({ user: CAREGIVER, change: 'promoted', byName: 'x' });
  assert.strictEqual(out.notified, 0);
  assert.strictEqual(h.queued.length, 0, 'an unknown change invents no wording');
});

test('B11 the two that lock somebody out tell them to call the office', async () => {
  for (const change of ['mfa_reset', 'sessions_revoked', 'deactivated']) {
    const h = harness();
    await h.notifier.accountAccessChanged({ user: CAREGIVER, change, ctaUrl: 'https://x.test/login' });
    assert.match(h.to('mo@example.com')[0].body, /call the office/i, `${change} gives them a way back in`);
  }
});

test('B12 a shared document is announced, named only on a covered transport', async () => {
  const covered = harness({ baaCovered: true });
  await covered.notifier.documentSharedToPortal({ client: CLIENT, label: 'Visit summary', sharedByName: 'GFC Admin', uploadId: 'u1' });
  assert.match(covered.to('ada@example.com')[0].body, /Visit summary/);
  assert.strictEqual(covered.to('ruth@example.com').length, 1);

  const open = harness({ baaCovered: false });
  await open.notifier.documentSharedToPortal({ client: CLIENT, label: 'Visit summary', uploadId: 'u1' });
  assert.ok(!/Visit summary/.test(bothHalves(open.to('ada@example.com')[0])));
});

test('every tier-2 notice renders both halves and declares its PHI marking', async () => {
  const calls = [
    ['shiftCancelled', { user: CAREGIVER, when: 'W', clientName: 'A', reason: 'r', shiftId: 's', ctaUrl: 'https://x.test/a' }],
    ['caregiverVisitCancelled', { clientId: 'c1', when: 'W', shiftId: 's' }],
    ['shiftClaimDeclined', { user: CAREGIVER, when: 'W', clientName: 'A', shiftId: 's', ctaUrl: 'https://x.test/a' }],
    ['coverageRequested', { client: CLIENT, requestedByName: 'R', when: 'W', requestId: 'r', ctaUrl: 'https://x.test/a' }],
    ['timeLogChanged', { user: CAREGIVER, when: 'W', reason: 'r', created: true, logId: 't', ctaUrl: 'https://x.test/a' }],
    ['carePlanAwaitingCoSign', { client: CLIENT, version: 1, authorName: 'N' }],
    ['carePlanAwaitingProviderCoSign', { provider: RN, client: CLIENT, version: 1, ctaUrl: 'https://x.test/a' }],
    ['carePlanProviderCoSigned', { user: RN, client: CLIENT, version: 1, ctaUrl: 'https://x.test/a' }],
    ['referralStepTaken', { user: RN, step: 'completed', orderId: 'o', ctaUrl: 'https://x.test/a' }],
    ['abnormalResultWaiting', { user: RN, resultId: 'r', ctaPath: '/clinical' }],
    ['paymentReceived', { client: CLIENT, invoiceId: 'i' }],
    ['clinicalEnrollmentActivated', { client: CLIENT }],
    ['accountAccessChanged', { user: CAREGIVER, change: 'role_changed', ctaUrl: 'https://x.test/a' }],
    ['documentSharedToPortal', { client: CLIENT, label: 'L', uploadId: 'u' }]
  ];
  for (const [name, args] of calls) {
    const h = harness({ baaCovered: true });
    assert.strictEqual(typeof h.notifier[name], 'function', `${name} is exported`);
    await h.notifier[name](args);
    assert.ok(h.queued.length >= 1, `${name} queues something`);
    for (const q of h.queued) {
      assert.ok(q.subject && q.body && q.htmlBody, `${name} renders both halves`);
      assert.match(q.htmlBody, /Godwins/, `${name} carries the house chrome`);
      assert.strictEqual(typeof q.phi, 'boolean', `${name} declares whether it is PHI`);
      assert.ok(q.relatedEntityId, `${name} carries a dedupe key`);
    }
  }
});

// ---- wiring guards for tier 2 ---------------------------------------------

test('cancelling one shift tells the holder and the client', () => {
  const s = stripLineComments(src('routes/scheduling.js'));
  assert.match(s, /const notifyCancelled = async/, 'the pair lives in one helper');
  assert.match(s, /notice\.shiftCancelled\(/);
  assert.match(s, /notice\.caregiverVisitCancelled\(/);
  assert.match(s, /\n\s+await notifyCancelled\(beforeRow, rows\[idx\], reason, req\.user\);/,
    'called unconditionally on the not-in-progress branch, not behind a further condition');
  assert.match(s, /new Date\(shift\.start\)\.getTime\(\) > Date\.now\(\)[\s\S]{0,200}caregiverVisitCancelled/,
    'the CLIENT hears only about a visit still to come');
});

test('a declined claim reads the claimant BEFORE the release clears them', () => {
  const s = stripLineComments(src('routes/scheduling.js'));
  const claim = s.indexOf('const claimant = result.shift && result.shift.caregiver_id;');
  const release = s.indexOf('await releaseCaregiver(result.rows, req.params.id, declineReason);');
  assert.ok(claim !== -1 && release !== -1);
  assert.ok(claim < release, 'reading it afterwards would leave nobody to tell');
});

test('the time-log notice is NOT in the shared writer, which would double-send', () => {
  const s = stripLineComments(src('routes/scheduling.js'));
  const writer = s.indexOf('const applyTimeLogEdit');
  const writerEnd = s.indexOf('router.put(\'/api/scheduling/time-logs/:id\'');
  assert.ok(writer !== -1 && writerEnd > writer);
  assert.ok(!/timeLogChanged/.test(s.slice(writer, writerEnd)),
    'an APPROVED adjustment request comes through the same writer and already emails');
  assert.strictEqual((s.match(/notice\.timeLogChanged\(/g) || []).length, 2,
    'exactly two call sites: the typed entry and the direct admin correction');
});

test('a document share notifies only when it is being shared', () => {
  const s = stripLineComments(src('server.js'));
  assert.match(s, /if \(shared\) \{[\s\S]{0,400}?notify\.documentSharedToPortal/,
    'unsharing is silent: there is nothing for the patient to do about it');
});

test('the access-change notice reads a snapshot taken before the write', () => {
  const s = stripLineComments(src('server.js'));
  const snap = s.indexOf('const accessBefore = {');
  const write = s.indexOf("await db.set('users', users);", snap);
  const notice = s.indexOf('change: \'role_changed\'', snap);
  assert.ok(snap !== -1 && write > snap && notice > write,
    'a shallow read after the write would compare the row to itself');
  assert.match(s, /users\[idx\]\.id !== req\.user\.id/, 'and nobody is emailed about editing their own account');
});

test('an abnormal result pages the ordering clinician from the filing route', () => {
  const s = stripLineComments(src('server.js'));
  assert.match(s, /result\.interpretation === 'abnormal'[\s\S]{0,400}?notify\.abnormalResultWaiting/);
  assert.match(s, /ctaPath: appLinks\.PATHS\.CLINICAL/,
    'a PATH, because this route is lifted out of server.js by a test where getAppBaseUrl is not in scope');
});

test('the care-plan provider set is resolved in server.js, not in the notifier', () => {
  const s = stripLineComments(src('server.js'));
  assert.match(s, /clinicalRoles\.resolveClinicalRole\(u\) === 'provider'[\s\S]{0,400}?carePlanAwaitingProviderCoSign/);
  assert.ok(!/'provider'/.test(stripLineComments(src('notifications.js')).split('carePlanAwaitingProviderCoSign')[1] || ''),
    'notifications.js must not restate the clinical role vocabulary');
});

test('a co-signature notice is never sent to the person who signed', () => {
  const s = stripLineComments(src('server.js'));
  assert.match(s, /plan\.authoredById !== req\.user\.id[\s\S]{0,400}?carePlanProviderCoSigned/);
  assert.match(s, /referrerId !== req\.user\.id[\s\S]{0,400}?referralStepTaken/,
    'nor to a clinician who accepted their own referral');
});

// ===========================================================================
// Build enforcement — the wiring, not the wording
// ===========================================================================

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// Line-based, because a block strip on a file this size can open a bogus
// comment from a `/*` inside a string literal and silently eat half of it.
const stripLineComments = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

test('the welcome packet notice no longer calls the queue with an object', () => {
  // Comments stripped FIRST. The explanation of this fix names `recipientRole`
  // in prose, and a scan that cannot tell code from prose about that code
  // proves nothing — the house rule, pointed at my own test.
  const s = stripLineComments(src('routes/welcomePacket.js'));
  assert.ok(!/queueNotification\(\{/.test(s),
    'the positional queue was being handed a single object, which is why it never sent');
  assert.match(stripLineComments(s), /n\.caregiverPacketSubmitted\(/,
    'it goes through the notifier, which resolves the office itself');
  assert.ok(!/recipientRole/.test(s),
    'the queue has no recipientRole fan-out; resolving recipients is the notifier\'s job');
});

test('no route anywhere calls queueNotification with a single object', () => {
  const dirs = ['.', 'routes'];
  const offenders = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', d))) {
      if (!f.endsWith('.js')) continue;
      const rel = d === '.' ? f : `${d}/${f}`;
      if (/^node_modules/.test(rel)) continue;
      let s;
      try { s = src(rel); } catch (e) { continue; }
      if (/queueNotification\(\s*\{/.test(stripLineComments(s))) offenders.push(rel);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'the signature is positional; an object lands in `type` and the recipient is never set');
});

test('each route that demands a reason now also delivers it', () => {
  const cases = [
    ['routes/caregiver.js', /caregiverDocumentReturned\(/, 'a rejected caregiver document'],
    ['routes/caregiver.js', /incidentClosed\(/, 'a closed incident'],
    ['routes/onboarding.js', /notifyReturned\(rec, \{ title: `\$\{c\.course\.title\}/, 'a returned training certificate'],
    ['routes/payroll.js', /contractorInvoiceDecided\(/, 'a rejected contractor invoice'],
    ['server.js', /notify\.clientDocumentRemoved\(/, 'a removed client document']
  ];
  for (const [file, re, what] of cases) {
    assert.match(stripLineComments(src(file)), re, `${what} tells the person why`);
  }
});

test('the four promises the app makes on screen are now kept', () => {
  const s = stripLineComments(src('server.js'));
  for (const [re, what] of [
    [/notify\.passwordResetRequested\(/, '"an administrator will reach out to you shortly"'],
    [/notify\.selfSignupVerified\(/, '"our office will review your account and email you"'],
    [/notify\.familyInviteRequested\(/, '"we will confirm it and email them their sign-in details"'],
    [/notify\.feedbackSubmitted\(/, 'a report that only an admin screen showed']
  ]) {
    assert.match(s, re, `kept: ${what}`);
  }
});

test('a removal notice goes only to a client who could see the document', () => {
  const s = stripLineComments(src('server.js'));
  assert.match(s, /docRules\.patientCanSee\(row\)[\s\S]{0,200}?notify\.clientDocumentRemoved/,
    'an office-filed document nobody shared would be news of a file they never knew existed');
});

test('the three routers that gained the notifier take it as a getter', () => {
  const s = src('server.js');
  for (const router of ['caregiverRoutes', 'welcomePacketRoutes', 'payrollRoutes']) {
    const at = s.indexOf(`app.use(${router}(`);
    assert.ok(at !== -1, `${router} is mounted`);
    const block = s.slice(at, at + 1400);
    assert.match(block, /notify: \(\) => notify/,
      `${router} must take the notifier lazily: it is built far below this mount`);
  }
});

test('a missing notifier is loud in every router that gained one', () => {
  for (const f of ['routes/caregiver.js', 'routes/welcomePacket.js', 'routes/payroll.js']) {
    assert.match(src(f), /no notifier injected/,
      `${f} must say so rather than skipping in silence`);
  }
});

test('there is one definition of who counts as an admin recipient', () => {
  const s = stripLineComments(src('notifications.js'));
  const inline = (s.match(/u\.role === 'admin' && u\.accountStatus !== 'inactive'/g) || []).length;
  assert.strictEqual(inline, 1, 'exactly one: inside adminRecipients');
  assert.match(s, /const adminRecipients = async/);
});
