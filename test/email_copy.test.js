// emailCopy.js — the editable wording of every email.
//
// Three kinds of test here, and the third is the one that matters most:
//   1. the resolver, as a pure function
//   2. the safety invariants, proven by RENDERING a real email and reading it
//      back rather than by reading the validator
//   3. SWEEPS over the whole registry, discovered rather than listed, so a
//      notice added next month is covered the day it lands. That is what the
//      lab-era library never had, which is how it ended up with six dead rows
//      and six ids the sender skipped in silence.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const copy = require('../emailCopy');
const { renderGfcEmail } = require('../emailTemplates');
const { createNotifier } = require('../notifications');

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const stripLineComments = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// ===========================================================================
// 1. The resolver
// ===========================================================================

test('C1 the built-in wording resolves with the values filled in', () => {
  const out = copy.resolve('appointment_booked', { data: { when: 'Tuesday at 2:00 PM', whoseVisit: 'Your visit' } });
  assert.strictEqual(out.subject, 'Your visit is scheduled — Tuesday at 2:00 PM');
  assert.match(out.paragraphs[0], /^Your visit is booked/);
  assert.strictEqual(out.usedFallback, false);
  assert.deepStrictEqual(out.problems, []);
});

test('C2 an override replaces FIELD BY FIELD, so an unedited body keeps later improvements', () => {
  const overrides = { appointment_booked: { detailed: { subject: 'See you {{when}}' } } };
  const out = copy.resolve('appointment_booked', { data: { when: 'Tuesday', whoseVisit: 'Your visit' }, overrides });
  assert.strictEqual(out.subject, 'See you Tuesday');
  assert.match(out.paragraphs[0], /is booked/, 'the body is still the built-in');
  assert.strictEqual(out.usedFallback, false);
});

test('C3 a missing value renders as nothing, and a paragraph that empties is dropped', () => {
  const overrides = { appointment_booked: { detailed: { paragraphs: ['Booked.', '{{when}}', 'See you then.'] } } };
  const out = copy.resolve('appointment_booked', { data: {}, overrides });
  assert.deepStrictEqual(out.paragraphs, ['Booked.', 'See you then.'],
    'a line that was only a value this event does not have is dropped, not sent blank');
});

test('C4 a callout with no text loses its label too', () => {
  const out = copy.resolve('appointment_cancelled', { data: { when: 'Tuesday', reason: '', whoseVisit: 'Your visit' } });
  assert.strictEqual(out.callout, null);
  assert.strictEqual(out.calloutLabel, null, 'a heading over nothing is worse than no heading');
});

test('C5 a garbled override falls back to the built-in for the WHOLE variant', () => {
  const broken = [
    { subject: 'Hello {{nonsense}}' },
    { paragraphs: 'not a list' },
    { subject: 'x'.repeat(copy.MAX_FIELD + 1) },
    { subject: 'Hi <b>there</b>' },
    { recipients: ['evil@example.com'] }
  ];
  for (const patch of broken) {
    const out = copy.resolve('appointment_booked', {
      data: { when: 'Tuesday', whoseVisit: 'Your visit' },
      overrides: { appointment_booked: { detailed: patch } }
    });
    assert.strictEqual(out.usedFallback, true, JSON.stringify(patch));
    assert.ok(out.problems.length >= 1, 'it says what was wrong');
    assert.strictEqual(out.subject, 'Your visit is scheduled — Tuesday',
      'a subject and a body from two generations of the wording is worse than either alone');
    assert.match(out.paragraphs[0], /is booked/);
  }
});

test('C6 an unknown notice is reported, never rendered as a blank email', () => {
  const out = copy.resolve('no_such_notice', { data: {} });
  assert.strictEqual(out.missing, true);
  assert.strictEqual(out.usedFallback, true);
});

test('C7 a notice with no vague wording falls back to the detailed one', () => {
  const out = copy.resolve('caregiver_document_returned', { variant: 'vague', data: { label: 'W-9', reviewedByName: 'GFC Admin', reason: 'r' } });
  assert.strictEqual(out.variant, 'detailed',
    'employment data is not PHI, so this notice has one wording and it sends on any transport');
});

// ===========================================================================
// 2. Validating an edit
// ===========================================================================

test('C8 a field nobody may edit is refused BY NAME', () => {
  const r = copy.validateOverride('appointment_booked', 'detailed', { recipients: ['x@y.z'], ctaUrl: 'http://evil' });
  assert.strictEqual(r.ok, false);
  const fields = r.errors.map(e => e.field).sort();
  assert.deepStrictEqual(fields, ['ctaUrl', 'recipients']);
  for (const e of r.errors) {
    assert.strictEqual(e.code, 'FIELD_NOT_EDITABLE');
    assert.match(e.message, /not something you can edit/i, 'a silent drop is the worst of the three answers');
  }
});

test('C9 a misspelt placeholder is refused and the valid ones are listed', () => {
  const r = copy.validateOverride('appointment_booked', 'detailed', { subject: 'Your visit on {{whenn}}' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].code, 'UNKNOWN_PLACEHOLDER');
  assert.strictEqual(r.errors[0].placeholder, 'whenn');
  assert.match(r.errors[0].message, /\{\{when\}\}/, 'it names what they can use instead');
});

test('C10 a PHI placeholder is refused in the vague wording, with the reason', () => {
  const r = copy.validateOverride('appointment_cancelled', 'vague', { paragraphs: ['Your visit on {{when}} is off.'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].code, 'PHI_IN_VAGUE');
  assert.match(r.errors[0].message, /not covered by a BAA/i,
    'the refusal has to say WHY, or it reads as the app being awkward');
  // The same edit on the detailed side is fine.
  assert.strictEqual(copy.validateOverride('appointment_cancelled', 'detailed', { paragraphs: ['Your visit on {{when}} is off.'] }).ok, true);
});

test('C11 markup is refused, and the message says where the look comes from', () => {
  const r = copy.validateOverride('appointment_booked', 'detailed', { headline: '<h1>Booked</h1>' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].code, 'NO_MARKUP');
  assert.match(r.errors[0].message, /house template/i);
});

test('C12 a notice with no vague wording cannot have one edited into it', () => {
  const r = copy.validateOverride('caregiver_document_returned', 'vague', { subject: 'x' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].code, 'VARIANT_NOT_USED');
});

test('C13 clearing an optional field with null is allowed; a number is not', () => {
  assert.strictEqual(copy.validateOverride('appointment_cancelled', 'detailed', { callout: null }).ok, true);
  assert.strictEqual(copy.validateOverride('appointment_cancelled', 'detailed', { callout: 42 }).ok, false);
});

// ===========================================================================
// 3. The safety invariants, proven by rendering
// ===========================================================================

test('C14 markup in an override is escaped END TO END, in both halves', () => {
  // The real guarantee is esc() in emailTemplates.js, not the save-time
  // refusal, so this is proven by rendering rather than by reading a check.
  const resolved = copy.resolve('appointment_booked', {
    // In a value the BODY renders, so the assertions below are about the
    // paragraphs they actually read.
    data: { when: 'Tuesday', whoseVisit: '<script>alert(1)</script>' }
  });
  const rendered = renderGfcEmail({
    greeting: 'Ada', headline: resolved.headline, paragraphs: resolved.paragraphs,
    ctaUrl: 'https://app.test/portal', ctaLabel: resolved.ctaLabel
  });
  assert.ok(rendered.html.includes('&lt;script&gt;'), 'the HTML half escapes it');
  assert.ok(!rendered.html.includes('<script>'), 'and never emits it live');
  assert.ok(rendered.text.includes('<script>'), 'the text half carries it as the text it is');
});

test('C15 the wording never carries a link of its own: the destination is not editable', () => {
  const s = stripLineComments(src('emailCopy.js'));
  assert.ok(!/https?:\/\//.test(s.replace(/^\/\/.*$/gm, '')),
    'appLinks.js owns destinations; a link edited into the wording is the /admin-hub 404 in prose');
  assert.ok(!copy.EDITABLE_FIELDS.includes('ctaUrl'));
  assert.ok(copy.EDITABLE_FIELDS.includes('ctaLabel'), 'the label IS editable');
});

test('C16 emailCopy.js holds no markup and no brand colours', () => {
  const s = src('emailCopy.js');
  for (const hex of ['#033D50', '#F5CD85', '#FAF7F2']) {
    assert.ok(!s.includes(hex), `${hex} belongs to emailTemplates.js`);
  }
  assert.ok(!/<\s*[a-zA-Z]+[^>]*>/.test(stripLineComments(s).replace(/\{\{[^}]*\}\}/g, '')),
    'the one file allowed to contain email markup is emailTemplates.js');
});

test('C17 an edited notice actually sends the edited wording', async () => {
  const queued = [];
  const notifier = createNotifier({
    getUsers: async () => [{ id: 'c1', role: 'client', name: 'Ada Bell', email: 'ada@example.com', slug: 'ada' }],
    queueNotification: async (type, userId, email, name, content) => { queued.push({ type, email, ...content }); return { id: 'n1' }; },
    getAppBaseUrl: async () => 'https://app.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family',
    getCopyOverrides: async () => ({
      appointment_booked: { detailed: { subject: 'Nurse coming {{when}}', paragraphs: ['We will see you {{when}}.'] } }
    })
  });
  const out = await notifier.appointmentBooked({ client: { id: 'c1' }, eid: '1', when: 'Tuesday', clinician: 'B', place: 'Home' });
  assert.strictEqual(out.notified, 1);
  assert.strictEqual(queued[0].subject, 'Nurse coming Tuesday');
  assert.match(queued[0].body, /We will see you Tuesday\./);
  assert.ok(!/is booked/.test(queued[0].body), 'the built-in sentence is gone');
  assert.match(queued[0].htmlBody, /Godwins/, 'and it still renders in the house template');
});

test('C18 an unreadable override store sends the BUILT-IN, never a blank email', async () => {
  const queued = [];
  const notifier = createNotifier({
    getUsers: async () => [{ id: 'c1', role: 'client', name: 'Ada', email: 'ada@example.com', slug: 'ada' }],
    queueNotification: async (t, u, e, n, content) => { queued.push(content); return { id: 'n1' }; },
    getAppBaseUrl: async () => 'https://app.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family',
    getCopyOverrides: async () => { throw new Error('store down'); }
  });
  const out = await notifier.appointmentBooked({ client: { id: 'c1' }, eid: '1', when: 'Tuesday', clinician: 'B', place: 'Home' });
  assert.strictEqual(out.notified, 1);
  assert.strictEqual(queued[0].subject, 'Your visit is scheduled — Tuesday');
});

test('C19 a POA is told whose visit it is through the placeholder, not a regex on the opening words', async () => {
  const CLIENT = { id: 'c1', role: 'client', name: 'Ada Bell', email: 'ada@example.com', slug: 'ada' };
  const POA = { id: 'f1', role: 'family', name: 'Joe Bell', email: 'joe@example.com', familyOfClientId: 'c1', familyIsPoa: true };
  const queued = [];
  const notifier = createNotifier({
    getUsers: async () => [CLIENT, POA],
    queueNotification: async (t, u, email, n, content) => { queued.push({ email, ...content }); return { id: 'n1' }; },
    getAppBaseUrl: async () => 'https://app.test',
    emailTransport: { transportStatus: () => ({ baaCovered: true }) },
    staffRoles: ['admin'], clientRole: 'client', familyRole: 'family',
    // The sentence is REWORDED so the placeholder is no longer the opening
    // words. The old regex matched the opening and would have silently
    // stopped working here, which is the whole reason it was replaced.
    getCopyOverrides: async () => ({
      appointment_booked: { detailed: { paragraphs: ['Good news — {{whoseVisit}} is confirmed.'] } }
    })
  });
  await notifier.appointmentBooked({ client: { id: 'c1' }, eid: '1', when: 'Tuesday', clinician: 'B', place: 'Home' });
  const toClient = queued.find(q => q.email === 'ada@example.com');
  const toPoa = queued.find(q => q.email === 'joe@example.com');
  assert.match(toClient.body, /Good news — Your visit is confirmed\./);
  assert.match(toPoa.body, /Good news — Ada Bell's visit is confirmed\./,
    'the attribution survives the sentence being rewritten');
});

// ===========================================================================
// 4. Sweeps over the whole registry — discovered, never listed
// ===========================================================================

test('C20 every placeholder used in a built-in wording is declared', () => {
  const offenders = [];
  for (const id of copy.ids()) {
    const declared = copy.declaredKeys(id);
    for (const v of copy.VARIANTS) {
      const block = copy.REGISTRY[id].variants[v];
      if (!block) continue;
      for (const key of copy.blockPlaceholders(block)) {
        if (!declared.has(key)) offenders.push(`${id}.${v}: {{${key}}}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'an undeclared placeholder cannot be inserted by an admin and cannot be checked for PHI');
});

test('C21 every declared placeholder is used by at least one wording', () => {
  const dead = [];
  for (const id of copy.ids()) {
    const used = new Set(copy.VARIANTS.flatMap(v => copy.blockPlaceholders(copy.REGISTRY[id].variants[v])));
    for (const p of copy.REGISTRY[id].placeholders) {
      if (!used.has(p.key)) dead.push(`${id}: {{${p.key}}}`);
    }
  }
  assert.deepStrictEqual(dead, [],
    'a declared-but-unused placeholder is an inert field offered on the editing screen');
});

test('C22 NO vague wording uses a PHI placeholder — the most important rule here', () => {
  const leaks = [];
  for (const id of copy.ids()) {
    const vague = copy.REGISTRY[id].variants.vague;
    if (!vague) continue;
    const phi = copy.phiKeys(id);
    for (const key of copy.blockPlaceholders(vague)) {
      if (phi.has(key)) leaks.push(`${id}.vague: {{${key}}}`);
    }
  }
  assert.deepStrictEqual(leaks, [],
    'the vague wording is what sends when our email is not covered by a BAA');
});

test('C23 every notice declares a name, a when, a known audience and a type', () => {
  for (const id of copy.ids()) {
    const e = copy.REGISTRY[id];
    assert.ok(e.name && e.name.length > 3, `${id} has a name a person can read`);
    assert.ok(e.when && e.when.length > 10, `${id} says when it sends`);
    assert.ok(copy.AUDIENCES[e.audience], `${id} has a known audience`);
    assert.ok(e.type, `${id} names the notification type it sends as`);
    assert.ok(e.variants.detailed, `${id} has a detailed wording`);
  }
});

test('C24 every registry id is reachable from a real call site', () => {
  const s = stripLineComments(src('notifications.js'));
  const unreachable = copy.ids().filter(id => !s.includes(`'${id}'`));
  assert.deepStrictEqual(unreachable, [],
    'a row on the editing screen that drives no email is the inert-field trap the lab library died of');
});

// The migration's own progress, written down rather than guessed at. This list
// SHRINKS; it must never grow without a reason beside the entry.
const NOT_YET_EDITABLE = Object.freeze([
  'phc_document_uploaded', 'phc_consent_signed', 'phc_care_plan_cosigned',
  'phc_documents_requested', 'phc_documents_reminder', 'phc_enrollment_follow_up',
  'phc_enrollment_approved', 'enrollment_change_requested', 'enrollment_change_decided',
  'visit_reminder', 'visit_summary_ready', 'result_reviewed',
  'shift_confirmed_client', 'shift_time_changed_client', 'caregiver_visit_cancelled',
  'message_received',
  'clinical_task_assigned', 'clinical_task_due', 'clinical_task_overdue', 'clinical_task_completed',
  'staff_onboarding_started', 'staff_onboarding_returned', 'staff_item_submitted',
  'staff_onboarding_digest', 'staff_credential_expiring', 'staff_onboarding_weekly',
  'incident_closed', 'client_document_removed',
  'contractor_invoice_paid', 'contractor_invoice_rejected',
  'self_signup_verified', 'family_invite_requested',
  'shift_claim_declined', 'coverage_requested', 'time_log_changed',
  'care_plan_awaiting_cosign', 'care_plan_awaiting_provider', 'care_plan_provider_cosigned',
  'care_plan_ready',
  'referral_accepted', 'referral_completed', 'abnormal_result_waiting',
  'payment_received', 'clinical_enrollment_activated', 'document_shared',
  'account_mfa_reset', 'account_sessions_revoked', 'account_deactivated', 'account_role_changed'
]);

test('C25 every notice type in notifications.js is either editable or on the list, with nothing stale', () => {
  const s = stripLineComments(src('notifications.js'));
  const literal = [...new Set([...s.matchAll(/type:\s*'([a-z0-9_]+)'/g)].map(m => m[1]))];
  // Four types are COMPOSED rather than written out: `type: \`account_${change}\``
  // over the keys of ACCESS_CHANGES. A scan for literals alone reports them as
  // gone, which is a false positive in this guard rather than a stale list.
  const accessBlock = s.slice(s.indexOf('const ACCESS_CHANGES'), s.indexOf('async function accountAccessChanged'));
  const accessKeys = [...accessBlock.matchAll(/^\s{4}([a-z_]+): \{/gm)].map(m => `account_${m[1]}`);
  const types = [...new Set([...literal, ...accessKeys])];
  assert.ok(accessKeys.length >= 4, 'the access-change kinds were found, or this guard proves nothing');
  const editable = new Set(copy.ids().map(id => copy.REGISTRY[id].type));
  const unaccounted = types.filter(t => !editable.has(t) && !NOT_YET_EDITABLE.includes(t));
  assert.deepStrictEqual(unaccounted, [],
    'a notice is either editable in the Admin hub or named here as not yet migrated');
  // And the list must not rot: an entry that IS editable now has to come off.
  const stale = NOT_YET_EDITABLE.filter(t => editable.has(t));
  assert.deepStrictEqual(stale, [], 'these are editable now and must come off the list');
  // Also: the list must not name a type that no longer exists anywhere.
  const gone = NOT_YET_EDITABLE.filter(t => !types.includes(t) && !s.includes(`'${t}'`));
  assert.deepStrictEqual(gone, [], 'these types are not in notifications.js at all any more');
});
