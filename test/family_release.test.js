// A family contact's own HIPAA release, with an expiry that pauses access on
// its own (owner, 2026-11-18). For a caregiver or contact acting for the
// patient with no legal authority. familyLinks.js is pure, so the rules run
// directly; the gates that must ask it are checked by calling them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fl = require('../familyLinks');
const patientRead = require('../patientReadRepository');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const MOM = { id: 'mom', role: 'client', name: 'Mae Mom', email: 'mom@x.test' };
const users = [MOM];
const NOW = () => '2026-11-18T15:00:00.000Z';

test('normalizeRelease: needs a real signed date, and an expiry after it', () => {
  assert.deepStrictEqual(fl.normalizeRelease(null), { release: null });
  assert.deepStrictEqual(fl.normalizeRelease({ signedOn: '', expiresOn: '' }), { release: null });
  assert.strictEqual(fl.normalizeRelease({ expiresOn: '2027-01-01', signedOn: '' }).code, 'FAMILY_RELEASE_SIGNED_ON_REQUIRED');
  assert.strictEqual(fl.normalizeRelease({ signedOn: '2026-02-30' }).code, 'FAMILY_RELEASE_SIGNED_ON_REQUIRED');
  assert.strictEqual(fl.normalizeRelease({ signedOn: '2026-11-01', expiresOn: '2026-13-01' }).code, 'FAMILY_RELEASE_EXPIRY_INVALID');
  assert.strictEqual(fl.normalizeRelease({ signedOn: '2026-11-01', expiresOn: '2026-11-01' }).code, 'FAMILY_RELEASE_EXPIRY_BEFORE_SIGNED');
  const ok = fl.normalizeRelease({ signedOn: '2026-11-01', expiresOn: '2027-11-01' }, { actorId: 'admin1', now: NOW });
  assert.deepStrictEqual(ok.release, { signedOn: '2026-11-01', expiresOn: '2027-11-01', note: null, recordedBy: 'admin1', recordedAt: NOW() });
  // "Until revoked" is allowed.
  assert.strictEqual(fl.normalizeRelease({ signedOn: '2026-11-01' }).release.expiresOn, null);
});

test('a link saved WITHOUT a release keeps the one on file; null clears it', () => {
  const previous = [{ clientId: 'mom', isPoa: false, release: { signedOn: '2026-01-01', expiresOn: '2027-01-01', recordedBy: 'a', recordedAt: 'x' } }];
  const kept = fl.normalizeLinksInput([{ clientId: 'mom', relationship: 'Aide' }], { users, previous, now: NOW });
  assert.strictEqual(kept.links[0].release.expiresOn, '2027-01-01');
  const cleared = fl.normalizeLinksInput([{ clientId: 'mom', release: null }], { users, previous, now: NOW });
  assert.strictEqual(cleared.links[0].release, null);
  const bad = fl.normalizeLinksInput([{ clientId: 'mom', release: { signedOn: '2026-05-01', expiresOn: '2026-04-01' } }], { users, previous, now: NOW });
  assert.strictEqual(bad.code, 'FAMILY_RELEASE_EXPIRY_BEFORE_SIGNED');
  // An unchanged release keeps who recorded it, rather than restamping.
  const same = fl.normalizeLinksInput([{ clientId: 'mom', release: { signedOn: '2026-01-01', expiresOn: '2027-01-01' } }], { users, previous, actorId: 'b', now: NOW });
  assert.strictEqual(same.links[0].release.recordedBy, 'a');
});

test('applyLinks and linksOf carry the release through', () => {
  const u = fl.applyLinks({ role: 'family' }, [{ clientId: 'mom', release: { signedOn: '2026-01-01', expiresOn: null } }]);
  assert.strictEqual(fl.linksOf(u)[0].release.signedOn, '2026-01-01');
  const none = fl.applyLinks({ role: 'family' }, [{ clientId: 'mom' }]);
  assert.strictEqual(fl.linksOf(none)[0].release, null);
});

test('releaseState: expired the day AFTER the expiry date, in Georgia', () => {
  const link = (expiresOn, isPoa = false) => ({ clientId: 'mom', isPoa, release: { signedOn: '2026-01-01', expiresOn } });
  assert.strictEqual(fl.releaseState(link('2026-11-18'), { today: '2026-11-18' }).status, 'expiring');
  assert.strictEqual(fl.releaseState(link('2026-11-17'), { today: '2026-11-18' }).status, 'expired');
  assert.strictEqual(fl.releaseState(link('2027-06-01'), { today: '2026-11-18' }).status, 'active');
  assert.strictEqual(fl.releaseState(link(null), { today: '2026-11-18' }).status, 'active');
  assert.strictEqual(fl.releaseState({ clientId: 'mom', isPoa: false, release: null }).status, 'none');
  // A POA is the personal representative: never gated on it.
  assert.strictEqual(fl.releaseState(link('2020-01-01', true), { today: '2026-11-18' }).status, 'poa');
  assert.strictEqual(fl.releaseExpired(link('2020-01-01', true)), false);
  assert.strictEqual(fl.releaseExpired(link('2020-01-01')), true);
  // 9 pm Eastern on the 18th is already the 19th in UTC; Georgia's date wins.
  assert.strictEqual(fl.todayInGeorgia(new Date('2026-11-19T02:00:00Z')), '2026-11-18');
});

test('the clinical read refuses a family contact whose release expired', () => {
  const client = { id: 'mom', serviceLine: 'clinical', openEmrPatientId: '1', consents: { roiFamily: 'signed', consentToTreat: 'signed' } };
  const args = (reqUser) => ({ reqUser, client, isConsentSatisfied: (s) => s === 'signed', isClinicalServiceLine: () => true });
  const ok = patientRead.evaluateClinicalReadAccess(args({ role: 'family', familyIsPoa: false, familyReleaseExpired: false }));
  assert.strictEqual(ok.ok, true);
  const no = patientRead.evaluateClinicalReadAccess(args({ role: 'family', familyIsPoa: false, familyReleaseExpired: true }));
  assert.strictEqual(no.code, 'FAMILY_RELEASE_EXPIRED');
  const poa = patientRead.evaluateClinicalReadAccess(args({ role: 'family', familyIsPoa: true, familyReleaseExpired: false }));
  assert.strictEqual(poa.ok, true);
});

test('the portal gate, the session and messaging all ask about the release', () => {
  const server = strip(read('server.js'));
  assert.match(server, /familyReleaseExpired:\s*familyActive\.link\s*\?\s*familyLinks\.releaseExpired\(familyActive\.link\)/);
  const gate = server.slice(server.indexOf('const requireEnrolledClient'), server.indexOf('const requireEnrolledClient') + 4000);
  assert.ok(gate.indexOf('familyReleaseExpired') > gate.indexOf('familyIsPoa'), 'checked for non-POA family only');
  assert.match(gate, /FAMILY_RELEASE_EXPIRED/);
  const messaging = strip(read('routes/messaging.js'));
  const role = messaging.slice(messaging.indexOf('const requireMessagingRole'), messaging.indexOf('const requireMessagingRole') + 600);
  assert.match(role, /familyReleaseExpired[\s\S]*FAMILY_RELEASE_EXPIRED/);
});
