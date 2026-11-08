'use strict';

// One Drive folder per Playbook role (owner, 2026-11-08).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('../onboarding/staffFolders');

test('every Playbook role chapter has a folder, and the clinician chapters share one', () => {
  for (const ch of 'ABCDEFGH') assert.match(F.folderForChapter(ch), /^GFC .+ Documents$/, ch);
  assert.strictEqual(F.folderForChapter('C'), F.folderForChapter('D'));
  assert.strictEqual(F.folderForChapter('C'), F.folderForChapter('E'));
  assert.notStrictEqual(F.folderForChapter('C'), F.folderForChapter('A'));
  assert.throws(() => F.folderForChapter('Z'), (e) => e.code === 'NO_ROLE_FOLDER');
});

test('the caregiver folder keeps the name it already has in Drive', () => {
  assert.strictEqual(F.folderForChapter('A'), 'GFC Caregiver Documents');
  const g = fs.readFileSync(path.join(__dirname, '..', 'googledrive.js'), 'utf8');
  assert.ok(g.includes("findOrCreateFolder('GFC Caregiver Documents', null)"));
});

test('a person folder is their name, never a role prefix', () => {
  assert.strictEqual(F.personFolderName('Thanmayie Bethi', 'u1'), 'Thanmayie Bethi');
  assert.strictEqual(F.personFolderName('  ', 'u1'), 'Unnamed (u1)');
});

test('clinician onboarding uploads no longer go to the caregiver folder', () => {
  const r = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.doesNotMatch(r, /uploadCaregiverDocumentFile\s*\(/);
  // The folder follows the person's chapter: clinicians to the clinician
  // folder, the admin team to the non-clinical staff folder.
  assert.match(r, /uploadStaffDocumentFile\(staffFolders\.folderForChapter\(\(rec\.inputs && rec\.inputs\.chapter\) \|\| 'C'\)/);
});
