// ============================================================================
// WHERE A HIRE'S ONBOARDING DOCUMENTS LAND IN DRIVE — one folder per role
// ============================================================================
// Owner, 2026-11-08: like "GFC Caregiver Documents", each role gets its own
// top-level folder, created the first time a document is uploaded for it,
// with one subfolder per person inside.
//
// The roles are the Playbook's role chapters. Chapters C, D and E share one
// folder: they are one clinician with one credentialing record (Playbook E.1),
// so splitting her files by engagement would put half her credentials in each.
//
// The caregiver folder keeps the name it already has in Drive; renaming it
// would start a second folder beside the one holding every file so far.
// ============================================================================

'use strict';

const ROLE_FOLDERS = Object.freeze({
  A: 'GFC Caregiver Documents',
  B: 'GFC Registered Nurse Documents',
  C: 'GFC Clinician Documents',
  D: 'GFC Clinician Documents',
  E: 'GFC Clinician Documents',
  F: 'GFC Non-Clinical Staff Documents',
  G: 'GFC Community Care Liaison Documents',
  H: 'GFC Student and Extern Documents'
});

function folderForChapter(chapter) {
  const f = ROLE_FOLDERS[String(chapter || '').toUpperCase()];
  if (!f) {
    const e = new Error(`No onboarding document folder for chapter "${chapter}"`);
    e.code = 'NO_ROLE_FOLDER';
    throw e;
  }
  return f;
}

// The person's own subfolder. Their name, as the caregiver folders already
// are; never a role prefix, since the parent folder already says the role.
function personFolderName(name, fallbackId) {
  const n = String(name || '').trim();
  return n || `Unnamed (${fallbackId || 'no id'})`;
}

module.exports = { ROLE_FOLDERS, folderForChapter, personFolderName };
