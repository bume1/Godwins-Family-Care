// The offer letter as the first onboarding step (owner, 2026-11-19).
// scripts/verify_offer_flow.js drives the whole flow through the real routes;
// these pin the rules it rests on.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SO = require('../staffOffers');
const PSL = require('../passwordSetLinks');
const T = require('../onboarding/track');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Line comments only: a block-comment strip would eat from a '/api/*' string to the next '*/'.
const noComments = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const sent = (extra) => ({ offer: Object.assign(SO.sentState(null, { sendId: 'send_a', itemId: 'B.5.01', title: 'Offer letter', actor: { id: 'adm', name: 'Admin' } }), extra || {}) });

test('no offer field means no gate: everyone already working is untouched', () => {
  assert.strictEqual(SO.offerPending({ id: 'x' }), false);
  assert.strictEqual(SO.offerPending(null), false);
});

test('a sent, never-signed offer gates; signed and declined do not', () => {
  const u = sent();
  assert.strictEqual(SO.offerPending(u), true);
  const s = SO.signedState(u.offer, { sendId: 'send_a' });
  assert.strictEqual(SO.offerPending({ offer: s }), false);
  assert.strictEqual(s.everSigned, true);
  const d = SO.declinedState(u.offer, { note: 'No thanks' });
  assert.strictEqual(SO.offerPending({ offer: d }), false);
  assert.strictEqual(d.declineNote, 'No thanks');
});

test('signing a different document never settles the offer', () => {
  const u = sent();
  assert.strictEqual(SO.signedState(u.offer, { sendId: 'send_other' }), null);
});

test('a new version after a signed offer never locks the person out', () => {
  const signed = SO.signedState(sent().offer, { sendId: 'send_a' });
  const again = SO.sentState(signed, { sendId: 'send_b', itemId: 'B.5.01', title: 'Offer letter v2' });
  assert.strictEqual(again.status, 'sent');
  assert.strictEqual(again.everSigned, true);
  assert.strictEqual(SO.offerPending({ offer: again }), false);
  assert.deepStrictEqual(again.history.map(h => h.event), ['sent', 'signed', 'new_version']);
});

test('only an unanswered offer can be declined, and the note is capped', () => {
  assert.strictEqual(SO.declinedState(SO.signedState(sent().offer, { sendId: 'send_a' }), { note: 'x' }), null);
  const d = SO.declinedState(sent().offer, { note: 'y'.repeat(900) });
  assert.strictEqual(d.declineNote.length, SO.DECLINE_NOTE_MAX);
  assert.strictEqual(SO.declinedState(sent().offer, { note: '   ' }).declineNote, null);
});

test('the gate allows signing in and out, the offer routes and the offer document, and nothing else', () => {
  const u = sent();
  for (const p of ['/api/auth/logout', '/api/auth/heartbeat', '/api/my/offer', '/api/my/offer/decline',
    '/api/my/document-sends/send_a/file', '/api/my/document-sends/send_a/preview', '/api/my/document-sends/send_a/sign?x=1', '/offer', '/my-gfc.js']) {
    assert.strictEqual(SO.pathAllowedWhilePending(p, u), true, p);
  }
  for (const p of ['/api/my/document-sends', '/api/my/document-sends/send_other/sign', '/api/my/welcome-packet', '/api/onboarding/me',
    '/api/caregiver/me', '/api/my/offerings', '/api/users', '/api/clinical/patients', '/api/my/document-sends/send_a/file/extra']) {
    assert.strictEqual(SO.pathAllowedWhilePending(p, u), false, p);
  }
});

test('every staff chapter but the student placement has an offer item, and each is signable by the new hire', () => {
  for (const ch of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'R1']) {
    const id = SO.offerItemFor(ch);
    const item = T.findItem(id);
    assert.ok(item, `${ch} → ${id}`);
    assert.ok(item.steps.some(s => s.actor === 'NEW_HIRE' && s.action === 'SIGN'), `${id} must have a NEW_HIRE SIGN step`);
  }
  assert.strictEqual(SO.offerItemFor('H'), null);
});

test('after signing: caregivers to the caregiver app, everyone else to the welcome packet', () => {
  assert.strictEqual(SO.nextAfterSigning('caregiver'), '/caregiver');
  assert.strictEqual(SO.nextAfterSigning('rn'), '/my#welcome');
});

test('an offer link lasts 7 days; the other links are unchanged', () => {
  const at = new Date('2026-11-19T12:00:00Z');
  const span = (purpose) => { const r = PSL.buildLink({ userId: 'u', purpose, now: at }).record; return new Date(r.expiresAt) - new Date(r.createdAt); };
  assert.strictEqual(span('offer'), 7 * 24 * 3600 * 1000);
  assert.strictEqual(span('admin'), 24 * 3600 * 1000);
  assert.strictEqual(span('self_service'), 3600 * 1000);
  assert.strictEqual(PSL.buildLink({ userId: 'u', purpose: 'offer' }).record.purpose, 'offer');
});

test('the gate is in authenticateToken, server-side, after the inactive check', () => {
  const src = noComments(read('server.js'));
  const at = src.indexOf('const authenticateToken = async');
  const body = src.slice(at, src.indexOf('req.user = {', at));
  const gate = body.indexOf('staffOffers.offerPending(freshUser)');
  assert.ok(gate > 0, 'the offer gate must sit in authenticateToken');
  assert.ok(body.indexOf("code: 'AUTH_INACTIVE'") < gate, 'after the inactive check');
  assert.ok(/staffOffers\.pathAllowedWhilePending\(req\.originalUrl, freshUser\)/.test(body.slice(gate, gate + 300)));
  assert.ok(/code: 'OFFER_PENDING'/.test(body.slice(gate, gate + 500)));
});

test('sign-in lands on /offer before the welcome packet', () => {
  const src = noComments(read('server.js'));
  const login = src.slice(src.indexOf("app.post('/api/auth/login'"), src.indexOf("app.post('/api/auth/client-login'"));
  const w = login.indexOf('staffWelcomePending(user)'); const o = login.indexOf('staffOffers.offerPending(user)');
  assert.ok(w > 0 && o > w, 'the offer landing must be set after (so it wins over) the welcome packet');
  const page = read('public/login.html');
  const d = page.slice(page.indexOf('const directDestination'));
  assert.ok(d.indexOf("u.landing === '/offer'") < d.indexOf("get('hub') === '1'"), 'the offer outranks the hub button');
});

test('only an OFFER link signs the person in; other links still send them to sign in', () => {
  const src = noComments(read('server.js'));
  const route = src.slice(src.indexOf("app.post('/api/auth/reset-password'"), src.indexOf("app.get('/api/auth/password-reset-link/:token'"));
  assert.ok(/if \(found\.record\.purpose === 'offer'\) \{[\s\S]*?finishLogin\(/.test(route));
  assert.strictEqual((route.match(/finishLogin\(/g) || []).length, 1);
});

test('the sign route settles the offer, and a caregiver\'s signed offer files as their offer letter', () => {
  const src = noComments(read('routes/staffPortal.js'));
  const sign = src.slice(src.indexOf("router.post('/api/my/document-sends/:id/sign'"));
  assert.ok(/settleOfferOnSign\(deps, \{ userId: me\.userId, sendId: s\.id/.test(sign));
  assert.ok(/kind: \(s\.offer && me\.audience === 'caregiver'\) \? 'offer_letter' : 'signed_document'/.test(sign));
  // Only in the document sign route: the policy sign route has no send.
  assert.strictEqual((src.match(/'offer_letter'/g) || []).length, 1);
});

test('the offer page uses the shared document viewer and My GFC\'s frame', () => {
  const page = read('public/offer.html');
  assert.ok(/window\.GFCDocSign\.SignWorkspace/.test(page), 'the same signing viewer');
  assert.ok(/<script type="text\/babel" src="\/document-sign-ui\.js"><\/script>/.test(page));
  assert.ok(/const \{ Shell, Section, call \} = window\.MyGFC/.test(page), 'My GFC\'s Shell');
  assert.ok(/hideHub/.test(page), 'no way out to the hub');
  assert.ok(/<script src="\/session-guard\.js"><\/script>/.test(page));
});

test('every signed-in page is sent to /offer on OFFER_PENDING', () => {
  const g = read('public/session-guard.js');
  assert.ok(/data\.code === 'OFFER_PENDING'\) window\.location\.replace\('\/offer'\)/.test(g));
});

test('the decline note goes to the office email, never the activity log', () => {
  const src = noComments(read('routes/staffOffers.js'));
  const route = src.slice(src.indexOf("router.post('/api/my/offer/decline'"));
  const log = route.slice(route.indexOf("logActivity(u.id"), route.indexOf(';', route.indexOf("logActivity(u.id")));
  // Only whether there was a note, never the note.
  assert.match(log, /\{ withNote: !!saved\.offer\.declineNote \}\)$/);
  assert.strictEqual((log.match(/declineNote/g) || []).length, 1, log);
  assert.ok(/accountStatus = 'inactive'/.test(route) && /revokeAllForUser/.test(route));
});
