#!/usr/bin/env node
// scripts/verify_email_library.js — the editable email library, through the
// REAL Express routes over HTTP.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3246 node server.js
//   GFC_PROBE_BASE=http://localhost:3246 node scripts/verify_email_library.js
//
// The thing worth proving is not that a PUT returns 200. It is that an edit
// saved here is the wording that actually goes out, and that the refusals are
// refusals: the store is read back after every one.

const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3246';
const ADMIN_EMAIL = process.env.GFC_PROBE_ADMIN || 'admin@godwinsfamilycarellc.com';
const ADMIN_PASSWORD = process.env.GFC_PROBE_PASSWORD || 'gfcforever2026';

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n         ${JSON.stringify(detail).slice(0, 500)}` : ''}`); }
};
const call = async (method, path, token, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};
const STAMP = Date.now();

(async () => {
  console.log(`\nThe email library — ${BASE}\n`);
  const admin = (await call('POST', '/api/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body?.token;
  if (!admin) { console.log('  FAIL could not sign in as admin'); process.exit(1); }

  const lib = await call('GET', '/api/admin/email-copy', admin);
  ok('the library lists the notices, grouped by who gets them', lib.status === 200 && Array.isArray(lib.body.audiences), lib.body);
  const all = (lib.body.audiences || []).flatMap(g => g.notices);
  ok('every row names an email and says when it sends',
    all.length > 0 && all.every(n => n.name && n.when && n.variants.length), all.length);
  ok('every row carries the built-in wording so the screen can show it',
    all.every(n => n.builtIn && n.builtIn.detailed && n.builtIn.detailed.subject), 'a row has no built-in');
  ok('no row offers a destination to edit',
    !(lib.body.editableFields || []).includes('ctaUrl') && (lib.body.editableFields || []).includes('ctaLabel'),
    lib.body.editableFields);

  // ── Saving an edit ──────────────────────────────────────────────────────
  console.log('\nSaving an edit');
  const put = await call('PUT', '/api/admin/email-copy/appointment_booked/detailed', admin, {
    copy: { subject: `Nurse coming {{when}} [${STAMP}]`, paragraphs: ['{{whoseVisit}} is confirmed.', 'Call us if that does not suit.'] }
  });
  ok('the edit saves', put.status === 200, put.body);
  ok('it comes back marked as edited, with who and when',
    put.body && put.body.edited === true && put.body.updatedBy, put.body && { edited: put.body.edited, by: put.body.updatedBy });
  const reread = await call('GET', '/api/admin/email-copy/appointment_booked', admin);
  ok('and it is in the store, not just in the response',
    ((reread.body.saved || {}).detailed || {}).subject === `Nurse coming {{when}} [${STAMP}]`, reread.body.saved);
  ok('only the fields that were changed are stored',
    Object.keys(((reread.body.saved || {}).detailed) || {}).sort().join(',') === 'paragraphs,subject',
    Object.keys(((reread.body.saved || {}).detailed) || {}));

  // ── The refusals ────────────────────────────────────────────────────────
  console.log('\nThe refusals, each read back to prove nothing was stored');
  const before = JSON.stringify((await call('GET', '/api/admin/email-copy/appointment_cancelled', admin)).body.saved || {});

  const phi = await call('PUT', '/api/admin/email-copy/appointment_cancelled/vague', admin, {
    copy: { paragraphs: ['Your visit on {{when}} is off.'] }
  });
  ok('a value naming the patient is refused in the brief wording', phi.status === 400 && phi.body.code === 'PHI_IN_VAGUE', phi.body);
  ok('and the refusal says why', /BAA/i.test((phi.body || {}).error || ''), phi.body && phi.body.error);

  const bad = await call('PUT', '/api/admin/email-copy/appointment_cancelled/detailed', admin, {
    copy: { subject: 'Your visit {{whenn}}' }
  });
  ok('a misspelt value is refused and the real ones listed',
    bad.status === 400 && bad.body.code === 'UNKNOWN_PLACEHOLDER' && /\{\{when\}\}/.test(bad.body.error), bad.body);

  const markup = await call('PUT', '/api/admin/email-copy/appointment_cancelled/detailed', admin, {
    copy: { headline: '<h1>Cancelled</h1>' }
  });
  ok('HTML is refused', markup.status === 400 && markup.body.code === 'NO_MARKUP', markup.body);

  const smuggle = await call('PUT', '/api/admin/email-copy/appointment_cancelled/detailed', admin, {
    copy: { ctaUrl: 'https://evil.example.com', recipients: ['evil@example.com'] }
  });
  ok('a destination and a recipient list are refused BY NAME',
    smuggle.status === 400 && smuggle.body.code === 'FIELD_NOT_EDITABLE', smuggle.body);

  const after = JSON.stringify((await call('GET', '/api/admin/email-copy/appointment_cancelled', admin)).body.saved || {});
  ok('the store is untouched by all four refusals', before === after, { before, after });

  // ── Preview writes nothing ──────────────────────────────────────────────
  console.log('\nPreview and test send take the DRAFT and write nothing');
  const draft = { subject: `A draft nobody saved ${STAMP}`, paragraphs: ['Draft only.'] };
  const prev = await call('POST', '/api/admin/email-copy/appointment_cancelled/preview', admin, { variant: 'detailed', copy: draft });
  ok('the draft previews', prev.status === 200 && prev.body.subject === draft.subject, prev.body && prev.body.subject);
  ok('the preview is rendered in the house template', /Godwins/.test((prev.body || {}).html || ''), 'no house chrome');
  const stillClean = JSON.stringify((await call('GET', '/api/admin/email-copy/appointment_cancelled', admin)).body.saved || {});
  ok('previewing stored NOTHING — the old screen saved first and sent half-finished wording',
    stillClean === before, { before, stillClean });

  const test = await call('POST', '/api/admin/email-copy/appointment_cancelled/test-send', admin, { variant: 'detailed', copy: draft });
  ok('the test send is accepted and goes only to the person editing',
    test.status === 200 && test.body.to === ADMIN_EMAIL, test.body);

  // ── An edit is what actually sends ──────────────────────────────────────
  console.log('\nThe edit is what actually goes out');
  const pw = 'Probe12345!';
  const email = `lib.client.${STAMP}@example.test`;
  await call('POST', '/api/users', admin, {
    email, password: pw, name: `Lib Probe (TEST DATA)`, role: 'client',
    practiceName: `Lib Probe ${STAMP} (TEST DATA)`, sendWelcomeEmail: false
  });
  const forgot = await call('POST', '/api/auth/forgot-password', null, { email });
  ok('an event that uses an edited notice fires', forgot.status === 200, forgot.body);

  const edit = await call('PUT', '/api/admin/email-copy/password_reset_requested/vague', admin, {
    copy: { subject: `Locked out [${STAMP}]`, paragraphs: ['Somebody needs letting back in.'] }
  });
  ok('the brief wording of the reset notice is edited', edit.status === 200, edit.body);
  // A fresh requester, so the queue's dedupe does not swallow the second one.
  const email2 = `lib.client2.${STAMP}@example.test`;
  await call('POST', '/api/users', admin, { email: email2, password: pw, name: 'Lib Probe Two (TEST DATA)', role: 'client', practiceName: `Lib Probe Two ${STAMP} (TEST DATA)`, sendWelcomeEmail: false });
  // The notifier caches the overrides for 30 seconds, so give it a beat.
  await new Promise(r => setTimeout(r, 31000));
  await call('POST', '/api/auth/forgot-password', null, { email: email2 });
  const q = (await call('GET', '/api/admin/notifications/queue', admin)).body;
  const rows = (q && (q.queue || q.notifications || q)) || [];
  const resetNotices = (Array.isArray(rows) ? rows : []).filter(n => n && n.type === 'password_reset_requested');
  const edited = resetNotices.filter(n => String((n.templateData || n).subject || '').includes(`Locked out [${STAMP}]`));
  ok('the edited subject is what the queue holds', edited.length >= 1,
    resetNotices.map(n => (n.templateData || n).subject));
  ok('and the edited paragraph is in the body',
    edited.some(n => /letting back in/.test(String((n.templateData || n).body || ''))), 'edited body not found');
  ok('still rendered in the house template',
    edited.every(n => /Godwins/.test(String((n.templateData || n).htmlBody || ''))), 'house chrome missing');

  // ── Reset is a delete ───────────────────────────────────────────────────
  console.log('\nReset is a delete, not a copy of the built-in');
  const del = await call('DELETE', '/api/admin/email-copy/appointment_booked?variant=detailed', admin);
  ok('the reset is accepted', del.status === 200, del.body);
  const afterReset = await call('GET', '/api/admin/email-copy/appointment_booked', admin);
  ok('the id is GONE from the store, not blanked',
    !((afterReset.body.saved || {}).detailed), afterReset.body.saved);
  ok('and the built-in wording is back',
    afterReset.body.builtIn.detailed.subject === 'Your visit is scheduled — {{when}}', afterReset.body.builtIn.detailed.subject);

  // ── Who may edit ────────────────────────────────────────────────────────
  console.log('\nWho may edit');
  const client = (await call('POST', '/api/auth/login', null, { email, password: pw })).body?.token;
  if (client) {
    const nope = await call('GET', '/api/admin/email-copy', client);
    ok('a client cannot read the library', nope.status === 403 || nope.status === 401, nope.status);
    const nopePut = await call('PUT', '/api/admin/email-copy/appointment_booked/detailed', client, { copy: { subject: 'x' } });
    ok('nor edit it', nopePut.status === 403 || nopePut.status === 401, nopePut.status);
  } else {
    ok('a client account was created to test the gate', false, 'could not sign in as the client');
  }
  const anon = await call('GET', '/api/admin/email-copy', null);
  ok('and it is not readable with no sign-in at all', anon.status === 401 || anon.status === 403, anon.status);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED', e); process.exit(1); });
