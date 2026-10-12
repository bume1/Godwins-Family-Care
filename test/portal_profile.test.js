// The patient's Profile screen (portal redesign, 10/2026): coverage with
// member IDs to the last four, readable by the client and a POA only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../portalProfile');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('coverage lists what is on file, member IDs to the last four only', () => {
  const client = { payer: {
    medicare: { id: '1EG4TE5MK72', type: 'Original Medicare' },
    commercial: { carrier: 'Aetna', planName: 'Gold', memberId: 'W123456789', groupNum: 'G-9' },
    insuranceIds: [{ carrier: 'Aetna', memberId: 'W123456789' }, { carrier: 'Humana', memberId: 'H99887766' }]
  } };
  const c = P.coverageForPatient(client);
  assert.deepEqual(c.map(x => x.kind), ['Medicare', 'Aetna', 'Humana'], 'the Aetna card typed twice is listed once');
  assert.equal(c[0].memberIdLast4, 'MK72');
  const json = JSON.stringify(c);
  for (const full of ['1EG4TE5MK72', 'W123456789', 'H99887766']) assert.ok(!json.includes(full), `full ID ${full} must not leave the server`);
});

test('nothing is invented: an empty payer lists nothing, and a short ID shows no partial', () => {
  assert.deepEqual(P.coverageForPatient({}), []);
  assert.equal(P.last4('12'), null);
  assert.deepEqual(P.coverageForPatient({ intake: { medicaid: { memberId: '123456' } } }).map(x => x.kind), ['Medicaid'], 'falls back to the intake copy');
});

test('the profile reads the intake fields by their declared names', () => {
  const p = P.profileForPatient({ name: 'Juanita Guess', intake: { preferredName: 'Nita', dob: '1941-03-02', phone: '404-555-0100', address: { line1: '1 Main St', city: 'Marietta', state: 'GA', zip: '30060' }, primaryContact: { name: 'Kelvin Ume', relationship: 'Son', phone: '404-555-0101' } } }, { email: 'j@example.test' });
  assert.equal(p.address, '1 Main St, Marietta, GA 30060');
  assert.equal(p.primaryContact.name, 'Kelvin Ume');
  assert.equal(p.email, 'j@example.test');
});

test('build guard: the profile route is the client or a POA only', () => {
  const i = server.indexOf("app.get('/api/gfc/profile', ");
  const route = server.slice(i, server.indexOf('\n});', i));
  assert.match(route, /if \(req\.user\.role !== config\.ROLES\.CLIENT && !acting\.isPoa\)/);
  assert.match(route, /PROFILE_CLIENT_ONLY/);
  assert.match(route, /portalProfile\.profileForPatient\(/);
});
