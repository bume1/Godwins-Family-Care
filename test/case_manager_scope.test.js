'use strict';
// Owner report, 2026-10-14: "Courtney can't see Juanita's name" in messaging.
// A social worker may be set up as a Case Manager account OR as a clinician
// account carrying an LMSW/LCSW clinical role. The second kind could never be
// picked as a client's case manager, and their messaging scope read only the
// assigned-FNP list, so their client never appeared.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const msg = require('../messagingRepository');

const juanita = { id: 'c1', role: 'client', name: 'Juanita Guess',
  careTeam: { assignedFNPs: ['fnp1'], assignedCaseManager: 'sw1', primaryCaregiver: null } };
const other = { id: 'c2', role: 'client', name: 'Other Client',
  careTeam: { assignedFNPs: ['fnp1'], assignedCaseManager: null } };

const swClinician = { id: 'sw1', role: 'user', clinicalRole: 'lmsw', hasClinicalAccess: true };
const swCaseManager = { id: 'sw1', role: 'caseManager', clinicalRole: 'lmsw', hasClinicalAccess: true };
const unrelatedClinician = { id: 'rn9', role: 'user', clinicalRole: 'rn', hasClinicalAccess: true };

test('a social worker set up as a clinician account reaches the client they are case manager for', () => {
  assert.equal(msg.clientInScope(swClinician, juanita), true);
  assert.equal(msg.clientInScope(swClinician, other), false, 'and nobody else');
  assert.equal(msg.clientInScope(unrelatedClinician, juanita), false);
  const thread = { id: 't1', client_id: 'c1', channel: 'care_team', participants: [] };
  assert.equal(msg.threadVisibility(swClinician, thread, { client: juanita }).visible, true);
  assert.equal(msg.threadVisibility(unrelatedClinician, thread, { client: juanita }).visible, false);
});

test('a Case Manager account still reaches its assigned client, and only that one', () => {
  assert.equal(msg.clientInScope(swCaseManager, juanita), true);
  assert.equal(msg.clientInScope(swCaseManager, other), false);
});

test('the Assigned Case Manager picker offers LMSW/LCSW clinician accounts too', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  // A care coordinator is a case-management account but never the assigned
  // case manager (2026-10-14): they have their own Care Coordinators slot.
  assert.match(page, /users\.filter\(u => \(u\.role === 'caseManager' && u\.clinicalRole !== 'coordinator'\) \|\| \(u\.role === 'user' && \['lmsw', 'lcsw'\]\.includes\(u\.clinicalRole\)\)\)/);
});
