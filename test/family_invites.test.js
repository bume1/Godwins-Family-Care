// Family & Caregivers invites (portal redesign, owner 2026-10-12).
// The patient or their POA asks; an admin approves; approving never makes a POA.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('../familyInvites');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `anchor missing: ${a}`); const j = s.indexOf(b, i + a.length); assert.ok(j > i, `end anchor missing: ${b}`); return s.slice(i, j); };

test('an invite needs a name, a real-looking email and a listed relationship', () => {
  assert.equal(F.normalizeInvite({ email: 'a@b.co', relationship: 'Child' }).code, 'INVITE_NAME_REQUIRED');
  assert.equal(F.normalizeInvite({ name: 'A', email: 'nope', relationship: 'Child' }).code, 'INVITE_EMAIL_INVALID');
  assert.equal(F.normalizeInvite({ name: 'A', email: 'a@b.co', relationship: 'Neighbour' }).code, 'INVITE_RELATIONSHIP_INVALID');
  const ok = F.normalizeInvite({ name: '  Dana   Daughter ', email: ' Dana@Example.CO ', relationship: 'Child', saysPoa: true });
  assert.deepEqual(ok.value, { name: 'Dana Daughter', email: 'dana@example.co', relationship: 'Child', saysPoa: true });
  // saysPoa is a strict true, never a truthy string from a form.
  assert.equal(F.normalizeInvite({ name: 'A', email: 'a@b.co', relationship: 'Child', saysPoa: 'yes' }).value.saysPoa, false);
});

test('an invite that collides with an account or an open invite is refused, case-blind', () => {
  const v = F.normalizeInvite({ name: 'A', email: 'a@b.co', relationship: 'Child' }).value;
  assert.equal(F.checkInvite(v, { users: [{ email: 'A@B.CO' }], invites: [], clientId: 'c1' }).code, 'INVITE_EMAIL_IN_USE');
  assert.equal(F.checkInvite(v, { users: [], invites: [{ clientId: 'c1', status: 'pending', email: 'a@b.co' }], clientId: 'c1' }).code, 'INVITE_DUPLICATE');
  assert.equal(F.checkInvite(v, { users: [], invites: [{ clientId: 'c1', status: 'declined', email: 'a@b.co' }], clientId: 'c1' }), null, 'a declined invite can be asked again');
  assert.equal(F.checkInvite(v, { users: [], invites: [{ clientId: 'c2', status: 'pending', email: 'a@b.co' }], clientId: 'c1' }), null, 'another client\'s invite is not a duplicate');
});

test('a decision is applied once, and a decline carries a reason', () => {
  const row = { id: 'i1', status: 'pending' };
  const by = { id: 'a1', name: 'Admin' };
  assert.equal(F.decide(row, { decision: 'declined', by, at: 't' }).code, 'INVITE_DECLINE_REASON_REQUIRED');
  assert.equal(F.decide(row, { decision: 'declined', by, at: 't', reason: '   ' }).code, 'INVITE_DECLINE_REASON_REQUIRED');
  const d = F.decide(row, { decision: 'declined', by, at: 't', reason: 'Could not reach them.' });
  assert.equal(d.row.status, 'declined');
  assert.equal(F.decide(d.row, { decision: 'approved', by, at: 't' }).code, 'INVITE_NOT_PENDING');
  assert.equal(F.decide(row, { decision: 'whatever', by, at: 't' }).code, 'INVITE_BAD_DECISION');
});

test('what the patient is shown about an invite never names the staff member who decided', () => {
  const pub = F.publicInvite({ id: 'i', name: 'N', email: 'e', relationship: 'Child', status: 'declined', requestedAt: 't', decidedAt: 't2', decidedBy: { id: 'a1', name: 'Fam Admin' }, declineReason: 'r', requestedBy: { id: 'c' } });
  assert.ok(!('decidedBy' in pub) && !('requestedBy' in pub));
  assert.equal(pub.declineReason, 'r');
  assert.equal(F.publicInvite({ id: 'i', status: 'pending', declineReason: 'leftover' }).declineReason, null);
});

test('access is described from the client\'s sharing settings; a POA reads as full access', () => {
  assert.equal(F.accessSummary({ familyIsPoa: true }, {}), 'Full access (Power of Attorney)');
  assert.equal(F.accessSummary({}, {}), 'Messages only');
  assert.match(F.accessSummary({}, { carePlan: true, appointments: true, visitSummaries: 'summary' }), /^Can see care plan, appointments, visit dates · messages$/);
});

test('build guard: only the patient or a POA invites, an admin, manager or coordinator decides, and approving never makes a POA', () => {
  const invite = between(server, "app.post('/api/gfc/family/invites', ", "app.post('/api/gfc/family/invites/:inviteId/cancel'");
  assert.match(invite, /if \(req\.user\.role !== config\.ROLES\.CLIENT && !acting\.isPoa\)/);
  const decideRoute = between(server, "app.post('/api/gfc/admin/enrollment/:clientId/family-invites/:inviteId/decide', ", "app.get('/api/gfc/admin/enrollment/:clientId', ");
  assert.match(server, /family-invites\/:inviteId\/decide', authenticateToken, requireEnrollmentManager, /);
  assert.match(decideRoute, /familyIsPoa: false,/);
  assert.ok(!/familyIsPoa:\s*(!!)?row\.saysPoa/.test(decideRoute), 'what the patient said is never copied into familyIsPoa');
  // invites are scoped to the client in the URL / the session
  assert.match(decideRoute, /x\.id === req\.params\.inviteId && x\.clientId === req\.params\.clientId/);
  // the audit row never carries the invited person's email
  const auditLines = (invite + decideRoute).split('\n').filter(l => /logActivity\(/.test(l) || /\{ role: req\.user\.role, actingFor/.test(l) || /\{ inviteId:/.test(l));
  assert.ok(auditLines.length >= 2);
  // (The acting user's own email is the app-wide fallback for their name.)
  assert.ok(auditLines.every(l => !/email/.test(l.replace(/req\.user\.email/g, ''))), 'the invited person\'s email never reaches the activity log');
});
