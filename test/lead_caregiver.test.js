// A lead caregiver sees what was shared with the patient (owner, 2026-11-11).
// The full path runs in scripts/verify_lead_caregiver.js; this pins the rule
// and the things a caregiver must never be served.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cg = require('../caregiverRepository');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Comments are stripped before a source scan: a comment naming a function is not a call to it.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

const LEAD = { id: 'lead', role: 'vendor', licenseLevel: 'cna' };
const client = (team) => ({ id: 'pat', role: 'client', careTeam: team });

test('lead access needs BOTH the tick and an assignment to the client', () => {
  assert.strictEqual(cg.isLeadCaregiver(LEAD, client({ primaryCaregiver: 'lead', leadCaregivers: ['lead'] })), true);
  assert.strictEqual(cg.isLeadCaregiver(LEAD, client({ primaryCaregiver: 'lead', leadCaregivers: [] })), false, 'assigned but not ticked');
  assert.strictEqual(cg.isLeadCaregiver(LEAD, client({ primaryCaregiver: 'someone', leadCaregivers: ['lead'] })), false, 'ticked but not assigned');
  assert.strictEqual(cg.isLeadCaregiver({ id: 'lead', role: 'vendor' }, client({ primaryCaregiver: 'lead', leadCaregivers: ['lead'] })), false, 'no licence level is not a caregiver');
  assert.strictEqual(cg.isLeadCaregiver({ id: 'lead', role: 'family' }, client({ primaryCaregiver: 'lead', leadCaregivers: ['lead'] })), false);
});

test('build guard: the shared record never carries the note, diagnoses, tests or problems', () => {
  const server = read('server.js');
  const fn = code(server.slice(server.indexOf('const sharedForLeadCaregiver'), server.indexOf('const serveSharedDocument')));
  assert.match(fn, /patientRead\.filterRow\('visit', 'full', r\.visit\)/, 'visits come from the patient-facing summary, not visitForAudience (which adds the note)');
  assert.doesNotMatch(fn, /visitForAudience/);
  assert.match(fn, /delete v\.diagnosesAddressed; delete v\.testsOrdered; delete v\.summary;/);
  assert.doesNotMatch(fn, /problems|vitals|clinical_results/, 'no problems, vitals or results');
  assert.match(fn, /docRules\.patientCanSee\(u\)/, 'only documents the patient can see');
  const routes = read('routes/caregiver.js');
  assert.match(routes, /if \(!cg\.isLeadCaregiver\(caregiver, client\)\) \{/, 'the route checks the lead tick');
  assert.ok((routes.match(/const ctx = await loadLeadClient\(req, res\);/g) || []).length === 2, 'both shared routes go through the one check');
});
