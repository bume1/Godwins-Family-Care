// The four PHC events that changed something and told nobody, plus the house
// email template they render in.
//
// Every assertion here reads the QUEUED NOTIFICATION back — subject, body,
// recipient, PHI marking — rather than checking that a function returned
// without throwing. A notifier that silently queues nothing looks identical to
// one that works, from the caller's side.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createPhcNotifier } = require('../phcNotifications');
const templates = require('../emailTemplates');

const CLIENT = { id: 'c1', role: 'client', name: 'Ada Bell', email: 'ada@example.com', slug: 'ada-bell' };
const POA = { id: 'p1', role: 'family', name: 'Ruth Bell', email: 'ruth@example.com', familyIsPoa: true, familyOfClientId: 'c1' };
const PLAIN_FAMILY = { id: 'f1', role: 'family', name: 'Ken Bell', email: 'ken@example.com', familyOfClientId: 'c1' };
const ADMIN = { id: 'a1', role: 'admin', name: 'GFC Admin', email: 'admin@godwinsfamilycarellc.com' };
const RN = { id: 'rn1', role: 'user', name: 'Bethel Godwins', email: 'bethel@godwinsfamilycarellc.com' };
const CASE_MGR = { id: 'cm1', role: 'caseManager', name: 'Courtney Hale', email: 'courtney@godwinsfamilycarellc.com' };
const CAREGIVER = { id: 'cg1', role: 'vendor', name: 'Mo Diallo', email: 'mo@example.com', licenseLevel: 'cna' };

// A harness that captures what would be queued, so the assertions can read the
// actual message rather than a return code.
function harness({ baaCovered = false, users = null } = {}) {
  const queued = [];
  const notifier = createPhcNotifier({
    getUsers: async () => users || [CLIENT, POA, PLAIN_FAMILY, ADMIN, RN, CASE_MGR, CAREGIVER],
    queueNotification: async (type, userId, email, name, templateData, options) => {
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

// ===========================================================================
// 1. A client uploads a document
// ===========================================================================

test('a client upload notifies staff, and never the client back', async () => {
  const h = harness();
  await h.notifier.documentUploaded({ client: CLIENT, kind: 'insurance_card', label: 'Insurance card', uploadId: 'u1' });
  const emails = h.queued.map(q => q.email).sort();
  assert.deepStrictEqual(emails, [
    'admin@godwinsfamilycarellc.com', 'bethel@godwinsfamilycarellc.com', 'courtney@godwinsfamilycarellc.com'
  ]);
  // The caregiver and the family are not staff and must not be told.
  assert.strictEqual(h.to('mo@example.com').length, 0);
  assert.strictEqual(h.to('ruth@example.com').length, 0);
  assert.strictEqual(h.to('ada@example.com').length, 0);
});

test('on a non-BAA transport the upload notice names nobody and is not PHI-marked', async () => {
  const h = harness({ baaCovered: false });
  await h.notifier.documentUploaded({ client: CLIENT, kind: 'insurance_card', label: 'Insurance card', uploadId: 'u1' });
  const m = h.to('admin@godwinsfamilycarellc.com')[0];
  assert.ok(!/Ada Bell/.test(m.subject + m.body), 'the client was named on a non-BAA transport');
  assert.ok(!/Insurance card/.test(m.subject + m.body), 'the document was named on a non-BAA transport');
  assert.strictEqual(m.phi, false);
});

test('on Workspace the upload notice names the client and the document, and IS PHI-marked', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.documentUploaded({ client: CLIENT, kind: 'insurance_card', label: 'Insurance card', uploadId: 'u1' });
  const m = h.to('admin@godwinsfamilycarellc.com')[0];
  assert.match(m.subject, /Ada Bell/);
  assert.match(m.body, /Insurance card/);
  assert.strictEqual(m.phi, true);
});

// ===========================================================================
// 2. Staff accept or reject an upload  — the gap that mattered most
// ===========================================================================

test('a rejection reaches the client AND their POA, but never non-POA family', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.documentReviewed({
    clientId: 'c1', decision: 'rejected', label: 'Insurance card',
    reason: 'The photo was too blurry to read the member ID.', uploadId: 'u1'
  });
  assert.strictEqual(h.to('ada@example.com').length, 1);
  assert.strictEqual(h.to('ruth@example.com').length, 1, 'the POA should be told');
  assert.strictEqual(h.to('ken@example.com').length, 0, 'non-POA family must not be told');
});

test('the rejection REASON is delivered on Workspace — the whole point of the notice', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.documentReviewed({
    clientId: 'c1', decision: 'rejected', label: 'Insurance card',
    reason: 'The photo was too blurry to read the member ID.', uploadId: 'u1'
  });
  const m = h.to('ada@example.com')[0];
  assert.match(m.body, /too blurry to read the member ID/);
  assert.match(m.htmlBody, /too blurry to read the member ID/);
});

test('the rejection reason is WITHHELD on a non-BAA transport, and the email says where to find it', async () => {
  const h = harness({ baaCovered: false });
  await h.notifier.documentReviewed({
    clientId: 'c1', decision: 'rejected', label: 'Insurance card',
    reason: 'The photo was too blurry to read the member ID.', uploadId: 'u1'
  });
  const m = h.to('ada@example.com')[0];
  assert.ok(!/blurry/.test(m.body), 'the reason leaked onto a non-BAA transport');
  assert.ok(!/Insurance card/.test(m.body), 'the document was named on a non-BAA transport');
  // A dead end is worse than a redirection: it must still say what to do.
  assert.match(m.body, /portal/i);
  assert.strictEqual(m.phi, false);
});

test('an acceptance and a rejection are different notification types, so neither dedupes the other', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.documentReviewed({ clientId: 'c1', decision: 'accepted', label: 'Insurance card', uploadId: 'u1' });
  await h.notifier.documentReviewed({ clientId: 'c1', decision: 'rejected', label: 'Insurance card', reason: 'Expired.', uploadId: 'u1' });
  const types = h.to('ada@example.com').map(m => m.type);
  assert.deepStrictEqual(types, ['phc_document_accepted', 'phc_document_rejected']);
  const ids = h.to('ada@example.com').map(m => m.relatedEntityId);
  assert.notStrictEqual(ids[0], ids[1], 'the two reviews must not share a dedupe key');
});

test('an acceptance does not carry a reason callout', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.documentReviewed({ clientId: 'c1', decision: 'accepted', label: 'Insurance card', reason: 'n/a', uploadId: 'u1' });
  assert.ok(!/n\/a/.test(h.to('ada@example.com')[0].body));
});

// ===========================================================================
// 3. A client signs a consent
// ===========================================================================

test('a signed consent notifies staff and NOT the client — fourteen consents is not fourteen emails', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.consentSigned({ client: CLIENT, consentType: 'hipaaNpp', consentTitle: 'Notice of Privacy Practices' });
  assert.strictEqual(h.to('ada@example.com').length, 0);
  assert.strictEqual(h.to('admin@godwinsfamilycarellc.com').length, 1);
  assert.match(h.to('admin@godwinsfamilycarellc.com')[0].body, /Notice of Privacy Practices/);
});

test('each consent gets its own dedupe key, so signing several in a sitting sends several notices', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.consentSigned({ client: CLIENT, consentType: 'hipaaNpp', consentTitle: 'NPP' });
  await h.notifier.consentSigned({ client: CLIENT, consentType: 'serviceAgreement', consentTitle: 'Service Agreement' });
  const ids = h.to('admin@godwinsfamilycarellc.com').map(m => m.relatedEntityId);
  assert.strictEqual(new Set(ids).size, 2);
});

// ===========================================================================
// 4. A client co-signs the care plan
// ===========================================================================

test('a co-signature reaches the AUTHORING RN, who is the person actually waiting', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.carePlanCoSigned({ client: CLIENT, version: 2, signerName: 'Ada Bell', authoredById: 'rn1' });
  assert.strictEqual(h.to('bethel@godwinsfamilycarellc.com').length, 1);
  assert.match(h.to('bethel@godwinsfamilycarellc.com')[0].body, /version 2/);
});

test('a POA co-signature is attributed to the POA, never presented as the client signing', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.carePlanCoSigned({
    client: CLIENT, version: 3, signerName: 'Ruth Bell', signedByPoa: true, authoredById: 'rn1'
  });
  const m = h.to('bethel@godwinsfamilycarellc.com')[0];
  assert.match(m.body, /Ruth Bell, as Power of Attorney for Ada Bell/);
});

test('the author is not notified twice when they are also an admin', async () => {
  const authorIsAdmin = { id: 'a1', role: 'admin', name: 'GFC Admin', email: 'admin@godwinsfamilycarellc.com' };
  const h = harness({ baaCovered: true, users: [CLIENT, authorIsAdmin] });
  await h.notifier.carePlanCoSigned({ client: CLIENT, version: 1, signerName: 'Ada Bell', authoredById: 'a1' });
  assert.strictEqual(h.to('admin@godwinsfamilycarellc.com').length, 1);
});

test('a co-signature still reaches admin when the author has left and has no account', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.carePlanCoSigned({ client: CLIENT, version: 1, signerName: 'Ada Bell', authoredById: 'gone' });
  assert.strictEqual(h.to('admin@godwinsfamilycarellc.com').length, 1);
});

// ===========================================================================
// Failure behaviour — a notice must never take a completed action down
// ===========================================================================

test('a notifier failure is swallowed and reported, never thrown at the route', async () => {
  const notifier = createPhcNotifier({
    getUsers: async () => { throw new Error('store unreachable'); },
    queueNotification: async () => ({ id: 'x' }),
    getAppBaseUrl: async () => 'https://app.example.com',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  const r = await notifier.documentUploaded({ client: CLIENT, kind: 'x', uploadId: 'u1' });
  assert.strictEqual(r.notified, 0);
  assert.match(r.reason, /store unreachable/);
});

test('an unreadable transport is treated as NOT BAA-covered, not as covered', async () => {
  const queued = [];
  const notifier = createPhcNotifier({
    getUsers: async () => [CLIENT, ADMIN],
    queueNotification: async (t, id, email, n, td, o) => { queued.push({ email, ...td, ...o }); return { id: 'x' }; },
    getAppBaseUrl: async () => 'https://app.example.com',
    emailTransport: { transportStatus: () => { throw new Error('not configured'); } },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  await notifier.documentUploaded({ client: CLIENT, kind: 'insurance_card', label: 'Insurance card', uploadId: 'u1' });
  assert.strictEqual(queued[0].phi, false);
  assert.ok(!/Ada Bell/.test(queued[0].body), 'a failed transport read must not unlock detail');
});

test('a skipped queue entry (unsubscribed) is not counted as notified', async () => {
  const notifier = createPhcNotifier({
    getUsers: async () => [CLIENT, ADMIN],
    queueNotification: async () => ({ skipped: true, reason: 'recipient unsubscribed from email' }),
    getAppBaseUrl: async () => 'https://app.example.com',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  const r = await notifier.documentUploaded({ client: CLIENT, kind: 'x', uploadId: 'u1' });
  assert.strictEqual(r.notified, 0);
});

// ===========================================================================
// The house template
// ===========================================================================

test('every notice renders BOTH html and a real plain-text alternative', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.documentReviewed({ clientId: 'c1', decision: 'rejected', label: 'ID', reason: 'Expired.', uploadId: 'u1' });
  const m = h.to('ada@example.com')[0];
  assert.match(m.htmlBody, /^<!DOCTYPE html>/);
  assert.ok(m.body.length > 0);
  assert.ok(!/</.test(m.body), 'the text alternative still contains markup');
});

test('the template carries the GFC house chrome from the marketing engine', () => {
  const r = templates.renderGfcEmail({ greeting: 'Ada', paragraphs: ['Body copy.'] });
  assert.match(r.html, /Godwins-llc-3\.png/, 'header wordmark missing');
  assert.match(r.html, /#033D50/, 'navy missing');
  assert.match(r.html, /#F5CD85/, 'gold rule missing');
  assert.match(r.html, /4300 Paces Ferry Road SE/, 'address footer missing');
  assert.match(r.html, /Warmly,/);
});

test('a transactional email carries NO tracking pixel and NO utm parameters', () => {
  const r = templates.renderGfcEmail({
    greeting: 'Ada', paragraphs: ['Body.'], ctaUrl: 'https://app.example.com/portal', ctaLabel: 'Open'
  });
  assert.ok(!/width="1"\s+height="1"/.test(r.html), 'a tracking pixel reached a patient email');
  assert.ok(!/utm_/.test(r.html), 'a campaign parameter reached a patient email');
});

test('the reply-to address shown to clients is support@, never the admin inbox', () => {
  const r = templates.renderGfcEmail({ greeting: 'Ada', paragraphs: ['Body.'] });
  // A client replying to a care notification should reach the support queue.
  // admin@ is an internal inbox (it is where ROI submissions land) and is a
  // different thing from the address a patient is invited to write back to.
  assert.match(r.html, /support@godwinsfamilycarellc\.com/);
  assert.match(r.text, /support@godwinsfamilycarellc\.com/);
  assert.ok(!/admin@godwinsfamilycarellc\.com/.test(r.html), 'the internal admin inbox was shown to a client');
  assert.ok(!/admin@godwinsfamilycarellc\.com/.test(r.text), 'the internal admin inbox was shown to a client');
});

test('an automated notice signs off as the practice, not as a named clinician', () => {
  const r = templates.renderGfcEmail({ greeting: 'Ada', paragraphs: ['Body.'] });
  assert.match(r.html, /The Godwins Family Care Team/);
  assert.ok(!/Bianca/.test(r.html), 'an automated notice was signed by a person who did not write it');
});

test('html-bearing content is escaped, so a document label cannot inject markup', () => {
  const r = templates.renderGfcEmail({
    greeting: '<script>x</script>',
    paragraphs: ['<img src=x onerror=alert(1)>'],
    callout: '</td></tr></table><b>escaped</b>'
  });
  // The strings survive as inert TEXT — that is correct. What must not exist
  // is a real tag or attribute, so the check is on the escaped form rather
  // than on the substring, which appears either way.
  assert.ok(!/<script>/.test(r.html), 'a script tag rendered');
  assert.match(r.html, /&lt;script&gt;x&lt;\/script&gt;/, 'the script tag was not escaped');
  assert.ok(!/<img\s+src=x/.test(r.html), 'an img tag rendered');
  assert.match(r.html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the img tag was not escaped');
  assert.ok(!/<b>escaped<\/b>/.test(r.html), 'the callout broke out of its cell');
});

test('a non-http CTA url is dropped rather than rendered as a link', () => {
  const r = templates.renderGfcEmail({
    greeting: 'Ada', paragraphs: ['Body.'],
    ctaUrl: 'javascript:alert(1)', ctaLabel: 'Click'
  });
  assert.ok(!/javascript:/i.test(r.html));
  assert.ok(!/Click<\/a>/.test(r.html));
});

// ===========================================================================
// Build-enforced invariants
// ===========================================================================

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the notifier does NOT restate the staff role list — it is passed in', () => {
  const src = read('phcNotifications.js');
  assert.ok(!/caseManager|'admin'/.test(src.replace(/u\.role === 'admin'/g, '')),
    'a second copy of the role vocabulary will drift from the one in server.js');
});

test('all four routes are wired, exactly once each', () => {
  const src = read('server.js');
  for (const fn of ['documentUploaded', 'documentReviewed', 'consentSigned', 'carePlanCoSigned']) {
    const n = (src.match(new RegExp(`phcNotify\\.${fn}\\(`, 'g')) || []).length;
    assert.strictEqual(n, 1, `phcNotify.${fn} should be called exactly once, found ${n}`);
  }
});

test('the PHI flag is carried from queueNotification through to the mailer', () => {
  const src = read('server.js');
  assert.match(src, /phi: !!options\.phi/, 'queueNotification does not store the phi marking');
  assert.match(src, /phi: !!notification\.phi/, 'the queue processor does not pass phi to the mailer');
});

test('the template module never imports the marketing tracking url', () => {
  const src = read('emailTemplates.js');
  assert.ok(!/TRACKING_URL|script\.google\.com/.test(src));
});

// ===========================================================================
// 5-7. The three enrollment notices moved off raw sendEmail (2026-09-13)
//
// Document requests and enrollment follow-up were emailing through a direct
// sendEmail call, which meant they reached people who had unsubscribed, arrived
// as unbranded plain text, and were neither retried nor logged on failure.
// Approval told the client nothing at all. These assertions read the QUEUED
// message, because the whole defect was that the old path never touched it.
// ===========================================================================

test('a document request reaches the client and their POA, and no other family', () => {
  return (async () => {
    const h = harness();
    const rows = [{ id: 'r1', label: 'Insurance card' }, { id: 'r2', label: 'Photo ID' }];
    await h.notifier.documentsRequested({ clientId: 'c1', rows, isReminder: false });
    const emails = h.queued.map(q => q.email).sort();
    assert.deepStrictEqual(emails, ['ada@example.com', 'ruth@example.com']);
    assert.strictEqual(h.to('ken@example.com').length, 0, 'non-POA family are never on a push channel');
  })();
});

test('on Resend a document request names no document; on Workspace it names them', async () => {
  const vague = harness({ baaCovered: false });
  const rows = [{ id: 'r1', label: 'Guardianship order' }];
  await vague.notifier.documentsRequested({ clientId: 'c1', rows, isReminder: false });
  const v = vague.to('ada@example.com')[0];
  assert.ok(!/Guardianship/.test(v.body), 'the document name must not ride an uncovered transport');
  // And it still says something useful, rather than being vague by being empty.
  assert.match(v.body, /1 document/);
  assert.match(v.body, /secure portal/);
  assert.strictEqual(v.phi, false);

  const full = harness({ baaCovered: true });
  await full.notifier.documentsRequested({ clientId: 'c1', rows, isReminder: false });
  const f = full.to('ada@example.com')[0];
  assert.match(f.body, /Guardianship order/);
  assert.strictEqual(f.phi, true);
});

test('a reminder is a distinct message and cannot be collapsed into the original request', async () => {
  // They share a recipient and a subject shape. If both carried the same
  // relatedEntityId the queue's duplicate check would swallow the chase, which
  // is the one message that exists to be sent twice.
  const h = harness({ baaCovered: true });
  const rows = [{ id: 'r1', label: 'Insurance card' }];
  await h.notifier.documentsRequested({ clientId: 'c1', rows, isReminder: false });
  await h.notifier.documentsRequested({ clientId: 'c1', rows, isReminder: true });
  const mine = h.to('ada@example.com');
  assert.strictEqual(mine.length, 2);
  assert.notStrictEqual(mine[0].relatedEntityId, mine[1].relatedEntityId);
  assert.notStrictEqual(mine[0].type, mine[1].type);
  assert.match(mine[1].body, /reminder/i);
});

test('a document request renders in the house template, both halves', async () => {
  const h = harness();
  await h.notifier.documentsRequested({ clientId: 'c1', rows: [{ id: 'r1', label: 'Photo ID' }] });
  const m = h.to('ada@example.com')[0];
  assert.match(m.htmlBody, new RegExp(templates.PALETTE.navy.replace('#', '#?'), 'i'));
  assert.ok(m.body && m.body.length, 'a text half exists for clients that strip HTML');
  assert.ok(!/<table/.test(m.body), 'the text half is not markup');
});

test('enrollment follow-up lists the outstanding items only on a covered transport', async () => {
  const vague = harness({ baaCovered: false });
  await vague.notifier.enrollmentFollowUp({ clientId: 'c1', itemLabels: ['Advance directive status', 'Allergies (or "none")'] });
  const v = vague.to('ada@example.com')[0];
  assert.ok(!/Advance directive|Allergies/.test(v.body),
    'a list naming one person\'s directive and allergies is the same class of detail as a document name');
  assert.match(v.body, /2 items/);

  const full = harness({ baaCovered: true });
  await full.notifier.enrollmentFollowUp({ clientId: 'c1', itemLabels: ['Advance directive status'] });
  assert.match(full.to('ada@example.com')[0].body, /Advance directive status/);
});

test('follow-up counts read naturally for one item', async () => {
  const h = harness({ baaCovered: true });
  await h.notifier.enrollmentFollowUp({ clientId: 'c1', itemLabels: ['Allergies'] });
  assert.match(h.to('ada@example.com')[0].body, /1 item still/);
});

test('approval finally tells the client, and says so plainly', async () => {
  const h = harness();
  await h.notifier.enrollmentApproved({ clientId: 'c1' });
  const m = h.to('ada@example.com')[0];
  assert.ok(m, 'the client is told their enrollment is approved');
  assert.match(m.subject, /enrollment is complete/i);
  // Nothing here is PHI: that a person is enrolled with us is what the welcome
  // email already established.
  assert.strictEqual(m.phi, false);
  assert.ok(!/outstanding/i.test(m.body), 'a clean approval does not mention outstanding items');
});

test('an OVERRIDDEN approval tells the client their file is not actually complete', async () => {
  // Saying nothing would leave them believing everything is on file while
  // staff know it is not.
  const h = harness();
  await h.notifier.enrollmentApproved({ clientId: 'c1', overridden: true });
  assert.match(h.to('ada@example.com')[0].body, /still outstanding/i);
});

test('every one of the three goes through the QUEUE, so an unsubscribe is honoured', async () => {
  // The queue is where the opt-out and the deactivated-account check live. A
  // notifier that reached sendEmail directly would skip both, which is exactly
  // what the old path did.
  let checked = 0;
  const notifier = createPhcNotifier({
    getUsers: async () => [CLIENT],
    queueNotification: async () => { checked += 1; return { id: 'n' }; },
    getAppBaseUrl: async () => 'https://app.example.com',
    emailTransport: { transportStatus: () => ({ baaCovered: false }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  await notifier.documentsRequested({ clientId: 'c1', rows: [{ id: 'r1', label: 'X' }] });
  await notifier.enrollmentFollowUp({ clientId: 'c1', itemLabels: ['X'] });
  await notifier.enrollmentApproved({ clientId: 'c1' });
  assert.strictEqual(checked, 3);
});

test('a queue SKIP is reported as not-notified, never as a send', async () => {
  const notifier = createPhcNotifier({
    getUsers: async () => [CLIENT],
    queueNotification: async () => ({ skipped: true, reason: 'unsubscribed' }),
    getAppBaseUrl: async () => 'https://app.example.com',
    emailTransport: { transportStatus: () => ({ baaCovered: false }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family'
  });
  const r = await notifier.documentsRequested({ clientId: 'c1', rows: [{ id: 'r1', label: 'X' }] });
  assert.strictEqual(r.notified, 0);
});

test('the raw sendEmail paths these replaced are GONE from server.js', () => {
  const src = read('server.js');
  for (const dead of ['notifyDocumentRequest', 'sendFollowUpNotification']) {
    assert.ok(!src.includes(dead), `${dead} still exists — the old unbranded path is back`);
  }
});

test('the three new routes are wired, exactly once each', () => {
  const src = read('server.js');
  assert.strictEqual((src.match(/phcNotify\.enrollmentFollowUp\(/g) || []).length, 1);
  assert.strictEqual((src.match(/phcNotify\.enrollmentApproved\(/g) || []).length, 1);
  // Request and reminder are two call sites of one notifier, by design.
  assert.strictEqual((src.match(/phcNotify\.documentsRequested\(/g) || []).length, 2);
});
