// The website's free assessment, moved into the app (11/2026). It used to post
// to Apps Script and land in a Google Sheet; it lands in `assessment_requests`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../assessmentRequests');
const IF = require('../public/intake-fields.js');

const root = path.join(__dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
// Raw source: a '/*' inside a string in server.js defeats a regex comment strip.
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'assessment.html'), 'utf8');
const staffPage = fs.readFileSync(path.join(root, 'public', 'admin-enrollment.html'), 'utf8');
const TODAY = '2026-11-25';
const pick = (k) => A.OPTIONS[k][0];
const base = (o) => Object.assign({
  who: 'family', clientFirst: 'Ann', clientLast: 'Lee', dob: '1940-03-02', addressLine1: '1 Main St', city: 'Marietta', state: 'GA', zip: '30060',
  submitterFirst: 'Bo', submitterLast: 'Lee', relationship: pick('relationship'), phone: '(404) 555-0100',
  servicePath: 'Home Care', insuranceTypes: ['Long-term care insurance'], ambulation: 'Uses walker / cane', twoPersonAssist: 'No', cognitionLevel: 'Mild'
}, o || {});
const norm = (o) => A.normalizeAssessment(base(o), { today: TODAY });

test('the form stays short: nine option questions, all from the intake catalogs', () => {
  assert.ok(Object.keys(A.OPTIONS).length <= 9, 'the owner asked for only what is absolutely necessary');
  for (const [k, list] of Object.entries(A.OPTIONS)) {
    assert.ok(Array.isArray(list) && list.length, k);
    assert.ok(Object.values(IF.OPTIONS).includes(list), `${k} must be the intake-fields catalog itself`);
  }
  assert.ok(!/const\s+OPTIONS\s*=/.test(strip(page)), 'the public page names no option list of its own');
  assert.ok(page.includes('/intake-fields.js'));
  // The screening answers the owner named must be on offer.
  assert.ok(A.OPTIONS.ambulation.includes('Bed-bound'));
  assert.ok(A.OPTIONS.twoPersonAssist.includes('Yes routinely'));
  for (const t of ['Medicare Part A & B', 'Medicaid', 'Long-term care insurance', 'Private pay only']) assert.ok(A.OPTIONS.insuranceTypes.includes(t), t);
});

test('the required answers, each refused naming its field', () => {
  assert.ok(norm().value);
  const cases = [[{ who: '' }, 'who'], [{ clientFirst: '' }, 'clientFirst'], [{ clientLast: ' ' }, 'clientLast'], [{ dob: '' }, 'dob'],
    [{ dob: '2027-01-01' }, 'dob'], [{ dob: '1940-13-40' }, 'dob'], [{ addressLine1: '' }, 'addressLine1'], [{ city: '' }, 'city'], [{ state: '' }, 'state'],
    [{ zip: '300' }, 'zip'], [{ submitterFirst: '' }, 'submitterFirst'], [{ relationship: '' }, 'relationship'], [{ phone: '' }, 'phone'],
    [{ phone: '555' }, 'phone'], [{ email: 'nope' }, 'email'], [{ servicePath: '' }, 'servicePath'], [{ insuranceTypes: [] }, 'insuranceTypes'],
    [{ ambulation: '' }, 'ambulation'], [{ twoPersonAssist: '' }, 'twoPersonAssist'], [{ cognitionLevel: '' }, 'cognitionLevel']];
  for (const [over, field] of cases) assert.equal(norm(over).field, field, JSON.stringify(over));
  assert.ok(norm({ phone: '', email: 'bo@example.test' }).value, 'an email alone is a way to reach them');
  assert.ok(norm({ urgency: '' }).value, 'how soon is optional');
});

test('a client filling it in for themselves is not asked their name twice', () => {
  const v = norm({ who: 'client', submitterFirst: '', submitterLast: '', relationship: '' }).value;
  assert.equal(v.submitter.isClient, true);
  assert.equal(v.submitter.firstName, 'Ann'); assert.equal(v.submitter.relationship, '');
  assert.equal(norm().value.submitter.firstName, 'Bo');
});

test('an answer that was never on the list is refused by name, never dropped', () => {
  const r = norm({ urgency: 'Yesterday' });
  assert.equal(r.code, 'ASSESSMENT_BAD_OPTION'); assert.equal(r.field, 'urgency');
  assert.equal(norm({ insuranceTypes: ['Medicaid', 'Lottery'] }).field, 'insuranceTypes');
  assert.equal(norm({ state: 'ZZ' }).field, 'state');
  assert.deepEqual(norm({ insuranceTypes: ['Medicaid', 'Medicaid'] }).value.coverage.insuranceTypes, ['Medicaid']);
});

test('the waiver question only counts for Medicaid', () => {
  assert.equal(norm({ insuranceTypes: ['Medicaid'], medicaidWaiver: 'CCSP' }).value.coverage.medicaidWaiver, 'CCSP');
  assert.equal(norm({ insuranceTypes: ['Medicare Part A & B'], medicaidWaiver: 'CCSP' }).value.coverage.medicaidWaiver, '');
  assert.equal(norm({ insuranceTypes: ['Medicaid'], medicaidWaiver: 'Made up' }).field, 'medicaidWaiver');
});

test('fit flags point the office at a hard case, and never decline anyone', () => {
  const row = (o) => A.buildRow({ id: 'x', value: norm(o).value, at: 't' });
  assert.deepEqual(A.fitFlags(row()), []);
  assert.deepEqual(A.fitFlags(row({ ambulation: 'Bed-bound', twoPersonAssist: 'Yes routinely', cognitionLevel: 'Significant' })),
    ['Bed-bound', 'Needs two-person assist', 'Significant memory concerns']);
  const r = row({ ambulation: 'Bed-bound' });
  assert.equal(r.status, 'new', 'a flag does not change the status');
  assert.deepEqual(A.staffRow(r).fitFlags, ['Bed-bound']);
});

test('a stored row starts new, keeps a history, and staff never see the hashed address', () => {
  const row = A.buildRow({ id: 'a1', value: norm().value, at: '2026-11-25T15:00:00Z', ipHash: 'HASH' });
  assert.equal(row.status, 'new'); assert.equal(row.statusHistory.length, 1); assert.deepEqual(row.notes, []);
  const staff = A.staffRow(row);
  assert.ok(!('ipHash' in staff)); assert.equal(staff.clientName, 'Ann Lee'); assert.equal(staff.statusLabel, 'New');
});

test('the queue puts urgent open requests first, then newest; closed ones last', () => {
  const mk = (id, status, urgency, createdAt) => ({ id, status, schedule: { urgency }, createdAt });
  const order = A.sortForQueue([
    mk('old-explore', 'new', 'Just exploring', '2026-11-20'), mk('converted', 'converted', 'Immediately', '2026-11-25'),
    mk('urgent', 'contacted', 'Immediately', '2026-11-01'), mk('new-explore', 'new', 'Just exploring', '2026-11-24')
  ]).map(r => r.id);
  assert.deepEqual(order, ['urgent', 'new-explore', 'old-explore', 'converted']);
});

test('working a request: status or note, a reason for "not a fit", nothing after conversion', () => {
  const row = { id: 'a', status: 'new', statusHistory: [], notes: [] };
  assert.equal(A.checkUpdate(null, { status: 'contacted' }).code, 'ASSESSMENT_NOT_FOUND');
  assert.equal(A.checkUpdate(row, {}).code, 'ASSESSMENT_UPDATE_EMPTY');
  assert.equal(A.checkUpdate(row, { status: 'converted' }).code, 'ASSESSMENT_BAD_STATUS', 'converting is its own action');
  assert.equal(A.checkUpdate(row, { status: 'not_a_fit' }).code, 'ASSESSMENT_REASON_REQUIRED');
  assert.equal(A.checkUpdate(row, { status: 'not_a_fit', note: 'out of area' }), null);
  assert.equal(A.checkUpdate({ ...row, status: 'converted' }, { note: 'hi' }).code, 'ASSESSMENT_CONVERTED');
  const by = { id: 'u', name: 'Marjorie' };
  const next = A.applyUpdate(row, { status: 'contacted', note: 'Left voicemail' }, { at: 't1', by });
  assert.equal(next.status, 'contacted'); assert.equal(next.statusHistory.length, 1); assert.equal(next.notes[0].text, 'Left voicemail');
  assert.equal(row.notes.length, 0, 'the stored row is not mutated');
  const noteOnly = A.applyUpdate(next, { status: 'contacted', note: 'Called again' }, { at: 't2', by });
  assert.equal(noteOnly.statusHistory.length, 1, 'the same status is not a second history entry');
});

test('service line follows what they asked for, and "not sure" leaves it for the intake to ask', () => {
  assert.equal(A.serviceLineFor('Home Care'), 'PHC');
  assert.equal(A.serviceLineFor('In-Home Primary Care'), 'IHPC');
  assert.equal(A.serviceLineFor('Both'), 'BOTH');
  assert.equal(A.serviceLineFor('Not sure'), null);
  assert.equal(A.serviceLineFor(''), null);
  for (const v of ['Home Care', 'In-Home Primary Care', 'Both']) assert.ok(A.OPTIONS.servicePath.includes(v), `${v} is still a servicePath option`);
});

test('converting pre-fills only paths the intake declares, so the family is not asked twice', () => {
  const v = norm({ insuranceTypes: ['Medicaid'], medicaidWaiver: 'CCSP', urgency: 'Immediately', notes: 'Falls at night' }).value;
  const intake = A.intakeFor(A.buildRow({ id: 'a9', value: v, at: 't' }));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, x]) => (x && typeof x === 'object' && !Array.isArray(x) ? flat(x, `${p}${k}.`) : [`${p}${k}`]));
  // The name pair and the provenance markers are written the way a self
  // sign-up writes them; everything else must be an answer the intake owns.
  const notAnswers = new Set(['firstName', 'lastName', 'source', 'assessmentRequestId']);
  assert.deepEqual(flat(intake).filter(p => !notAnswers.has(p) && !IF.isEditablePath(p)), []);
  assert.equal(intake.dob, '1940-03-02'); assert.equal(intake.address.zip, '30060');
  assert.equal(intake.primaryContact.name, 'Bo Lee'); assert.equal(intake.medicaid.waiver, 'CCSP');
  assert.equal(intake.adl.ambulation, 'Uses walker / cane'); assert.equal(intake.situation.mainReason, 'Falls at night');
  const self = A.intakeFor(A.buildRow({ id: 'a10', value: norm({ who: 'client' }).value, at: 't' }));
  assert.ok(!('primaryContact' in self), 'a client asking for themselves is not their own family contact');
  assert.equal(self.phone, '4045550100');
});

test('server wiring: public route is rate limited with a honeypot, collection and audit prefix are claimed', () => {
  const pub = server.slice(server.indexOf("app.post('/api/assessment'"), server.indexOf("app.post('/api/assessment'") + 2500);
  assert.ok(pub.length > 100 && /b\.website/.test(pub), 'honeypot');
  assert.ok(/assessmentLimited/.test(pub), 'rate limit');
  assert.ok(pub.indexOf('normalizeAssessment') > -1 && pub.indexOf('normalizeAssessment') < pub.indexOf("db.set('assessment_requests'"), 'checked before it is stored');
  const reg = require('../dataMigration').COLLECTION_REGISTRY.find(c => c.key === 'assessment_requests');
  assert.ok(reg && reg.phi === true, 'claimed as PHI');
  assert.ok(require('../auditLog').PHI_PREFIXES.includes('/api/assessment'));
  assert.ok(/app\.get\('\/api\/gfc\/admin\/assessments', authenticateToken, requireEnrollmentStaff/.test(server), 'staff read');
  assert.ok(/app\.put\('\/api\/gfc\/admin\/assessments\/:id', authenticateToken, requireEnrollmentManager/.test(server), 'working one is a manager write');
  assert.ok(/app\.post\('\/api\/gfc\/admin\/assessments\/:id\/convert', authenticateToken, requireEnrollmentManager/.test(server), 'converting is a manager write');
  assert.ok(/app\.get\('\/assessment'/.test(server), 'the public page is served');
});

test('the update audit records that it moved, never the note text', () => {
  const put = server.slice(server.indexOf("app.put('/api/gfc/admin/assessments/:id'"), server.indexOf("app.post('/api/gfc/admin/assessments/:id/convert'"));
  const log = put.slice(put.indexOf('logActivity('), put.indexOf(';', put.indexOf('logActivity(')));
  assert.ok(log.includes('noteAdded'));
  assert.ok(!/note\s*[,}]/.test(log.replace(/noteAdded:[^,}]+/, '')), 'no raw note in the audit row');
});

test('the staff tab calls all three routes and the notice links to it', () => {
  for (const r of ["'/api/gfc/admin/assessments'", '/api/gfc/admin/assessments/${id}`', '/api/gfc/admin/assessments/${id}/convert']) assert.ok(staffPage.includes(r), r);
  assert.ok(/\['assessments', 'Free Assessments'\]/.test(staffPage));
  assert.equal(require('../appLinks').PATHS.ASSESSMENTS, '/clients?tab=assessments');
});
