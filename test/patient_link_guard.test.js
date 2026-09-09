// Patient-link duplicate guard (identity safety).
//
// The link step used to POST a new OpenEMR Patient unconditionally, so every
// retry minted another chart for the same person. These tests pin the matching
// rules the guard relies on — above all the two that are patient-safety
// invariants: a KNOWN and DIFFERENT date of birth is never a match, and a
// surname never matches across different surnames.

const test = require('node:test');
const assert = require('node:assert');
const repo = require('../clinicalRepository');

const patient = (family, given, birthDate, id = 'uuid-1') => ({
  resourceType: 'Patient', id,
  name: [{ use: 'official', family, given: Array.isArray(given) ? given : [given] }],
  birthDate
});

test('patientMatchKey derives the same identity clientToFhirPatient would create', () => {
  const fromIntake = repo.patientMatchKey({
    name: 'ignored Name', intake: { firstName: 'Ada', lastName: 'Lovelace', dob: '1815-12-10' }
  });
  assert.deepStrictEqual(fromIntake, { family: 'lovelace', given: 'ada', birthDate: '1815-12-10' });

  // Falls back to the display name when there is no intake block.
  const fromName = repo.patientMatchKey({ name: 'Ada Byron Lovelace', dob: '1815-12-10' });
  assert.strictEqual(fromName.family, 'lovelace');
  assert.strictEqual(fromName.given, 'adabyron');
});

test('a single-word client name is treated as the surname, not dropped', () => {
  const key = repo.patientMatchKey({ name: 'Prince' });
  assert.strictEqual(key.family, 'prince');
  assert.strictEqual(key.given, 'prince');
});

test('name normalization folds case, accents and punctuation', () => {
  const key = repo.patientMatchKey({ intake: { firstName: 'José', lastName: "O'Brien-Smith" } });
  assert.strictEqual(key.family, 'obriensmith');
  assert.strictEqual(key.given, 'jose');
  assert.strictEqual(repo.scorePatientMatch(
    repo.fhirPatientIdentity(patient('OBrien Smith', 'Jose')), key), 'possible');
});

test('an unparseable date of birth is ignored rather than matched as a string', () => {
  assert.strictEqual(repo.patientMatchKey({ intake: { lastName: 'X', dob: 'unknown' } }).birthDate, '');
  assert.strictEqual(repo.patientMatchKey({ intake: { lastName: 'X', dob: '12/10/1815' } }).birthDate, '');
  assert.strictEqual(repo.patientMatchKey({ intake: { lastName: 'X', dob: '1815-12-10T00:00:00Z' } }).birthDate, '1815-12-10');
});

test('SAFETY: a known but different date of birth is never a match', () => {
  const key = repo.patientMatchKey({ intake: { firstName: 'Ada', lastName: 'Lovelace', dob: '1815-12-10' } });
  const other = repo.fhirPatientIdentity(patient('Lovelace', 'Ada', '1990-04-02'));
  assert.strictEqual(repo.scorePatientMatch(other, key), null,
    'same name + different DOB is a different person and must not be offered');
});

test('SAFETY: a different surname is never a match, however close the rest', () => {
  const key = repo.patientMatchKey({ intake: { firstName: 'Ada', lastName: 'Lovelace', dob: '1815-12-10' } });
  assert.strictEqual(repo.scorePatientMatch(
    repo.fhirPatientIdentity(patient('Babbage', 'Ada', '1815-12-10')), key), null);
});

test('confidence grades: exact, probable (nickname), possible (no DOB either side)', () => {
  const key = repo.patientMatchKey({ intake: { firstName: 'Margaret', lastName: 'Hamilton', dob: '1936-08-17' } });
  assert.strictEqual(repo.scorePatientMatch(
    repo.fhirPatientIdentity(patient('Hamilton', 'Margaret', '1936-08-17')), key), 'exact');
  assert.strictEqual(repo.scorePatientMatch(
    repo.fhirPatientIdentity(patient('Hamilton', 'Peggy', '1936-08-17')), key), 'probable');

  const noDob = repo.patientMatchKey({ intake: { firstName: 'Margaret', lastName: 'Hamilton' } });
  assert.strictEqual(repo.scorePatientMatch(
    repo.fhirPatientIdentity(patient('Hamilton', 'Margaret', undefined)), noDob), 'possible');
  // Surname alone, with no given-name agreement and no DOB, is not a candidate.
  assert.strictEqual(repo.scorePatientMatch(
    repo.fhirPatientIdentity(patient('Hamilton', 'Alice', undefined)), noDob), null);
});

test('findExistingPatientMatches ranks strongest first and flags claimed charts', () => {
  const key = repo.patientMatchKey({ intake: { firstName: 'Grace', lastName: 'Hopper', dob: '1906-12-09' } });
  const found = repo.findExistingPatientMatches([
    patient('Hopper', 'Amazing', '1906-12-09', 'uuid-probable'),
    patient('Hopper', 'Grace', '1906-12-09', 'uuid-exact'),
    patient('Nobody', 'Grace', '1906-12-09', 'uuid-nomatch')
  ], key, ['uuid-probable']);

  assert.deepStrictEqual(found.map(c => c.openEmrPatientId), ['uuid-exact', 'uuid-probable']);
  assert.strictEqual(found[0].confidence, 'exact');
  assert.strictEqual(found[0].alreadyLinkedToAnotherClient, false);
  assert.strictEqual(found[1].alreadyLinkedToAnotherClient, true,
    'a chart another client already owns must be surfaced but not linkable');
});

test('findExistingPatientMatches tolerates junk bundles and unnamed resources', () => {
  const key = repo.patientMatchKey({ intake: { firstName: 'A', lastName: 'B', dob: '2000-01-01' } });
  assert.deepStrictEqual(repo.findExistingPatientMatches(null, key), []);
  assert.deepStrictEqual(repo.findExistingPatientMatches([null, {}, { name: [] }], key), []);
  // A match with no id cannot be linked, so it is not offered.
  assert.deepStrictEqual(
    repo.findExistingPatientMatches([{ name: [{ family: 'B', given: ['A'] }], birthDate: '2000-01-01' }], key), []);
});

test('patientSearchParams searches on surname, adding birthdate only when known', () => {
  assert.deepStrictEqual(
    repo.patientSearchParams({ family: 'hopper', given: 'grace', birthDate: '1906-12-09' }),
    { family: 'hopper', birthdate: '1906-12-09' });
  assert.deepStrictEqual(
    repo.patientSearchParams({ family: 'hopper', given: 'grace', birthDate: '' }), { family: 'hopper' });
  // No surname means no safe search — the route turns this into a 409, and
  // must never fall through to creating a chart.
  assert.strictEqual(repo.patientSearchParams({ family: '', given: 'grace', birthDate: '' }), null);
  assert.strictEqual(repo.patientSearchParams(null), null);
});

test('the FHIR official name wins over other name entries', () => {
  const identity = repo.fhirPatientIdentity({
    id: 'u1',
    name: [{ use: 'nickname', family: 'Wrong', given: ['Nope'] }, { use: 'official', family: 'Right', given: ['Yes'] }],
    birthDate: '1970-01-01'
  });
  assert.strictEqual(identity.family, 'right');
  assert.strictEqual(identity.displayName, 'Yes Right');
});
