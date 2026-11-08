// ============================================================================
// ONBOARDING SOURCE DOCUMENTS — references only, never content
// ============================================================================
// The onboarding wizard is the GFC Onboarding Playbook executed in software.
// Every requirement it shows is READ FROM one of the documents below, which
// live in the company Drive and are revised in place (Admin P&P §17.2, Drive's
// Manage versions), so the file ids here survive every revision.
//
// This file holds the POINTER to each document and the version the catalog was
// transcribed against. It never holds a document's text. Where the catalog
// carries a short label or a classification, that label was transcribed from
// the document named here at the version named here, and the version flag
// (onboarding/versionFlags.js) reopens it when that document is reissued.
//
// No document in docs/ governs this work (owner, GFC-WIZ-PROMPT v2.0 §2).
//
// The version is read from each document's own control table at runtime,
// NEVER from the Drive filename: the filenames carry a version
// ("..._v2.2.docx") that becomes wrong the first time the file is revised in
// place.
// ============================================================================

'use strict';

const SOURCES = Object.freeze({
  PLAYBOOK: Object.freeze({
    key: 'PLAYBOOK',
    title: 'GFC Onboarding Playbook',
    // Two copies sit in the Onboarding folder (HTML and PDF). The HTML is the
    // one the catalog was transcribed from, because its tables are machine-
    // readable; the PDF's text layer misaligns table rows. Which copy is
    // canonical is an open owner item (Admin P&P §17.2 allows one).
    driveFileId: '1bjeBX-gBbEizC9FWEWUputiJ-qM-qS9_',
    alternateDriveFileIds: Object.freeze(['1OJCv9l-DqTEFDvEjAIbrpCzlgG-Pkgg4']),
    mimeType: 'text/html',
    folder: '06 People / Onboarding',
    transcribedFromVersion: '3.0'
  }),
  CLINICAL_MANUAL: Object.freeze({
    key: 'CLINICAL_MANUAL',
    title: 'Clinical Policies and Procedures Manual',
    docNumber: 'GFC-CLIN',
    driveFileId: '1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '2.2'
  }),
  CLINICAL_SOPS_SET1: Object.freeze({
    key: 'CLINICAL_SOPS_SET1',
    title: 'Clinical Standard Operating Procedures, Set 1',
    docNumber: 'GFC-CLIN-SOP-S1',
    driveFileId: '1ZR_5otWCF0Se1MsmKByh57K69YX6UgLh',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.2'
  }),
  TRAINING_LIBRARY: Object.freeze({
    key: 'TRAINING_LIBRARY',
    title: 'Clinician Training Library',
    docNumber: 'GFC-CLIN-TRN',
    driveFileId: '1N4QxQjkwZ3-7FoL-j60clR75NeCwdCE5',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '06 People / Onboarding / Training',
    transcribedFromVersion: '1.2'
  }),
  // The private home care line's manual. The canonical copy in Policies /
  // Current is 3.1; the Playbook (B.10) names 3.0.
  PHC_MANUAL: Object.freeze({
    key: 'PHC_MANUAL',
    title: 'Private Home Care Policies and Procedures',
    docNumber: 'GFC-PHC',
    driveFileId: '11tYIh4bWvwCCtQQ5skFANzGURJoBOg4g',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '3.1'
  }),
  ADMIN_MANUAL: Object.freeze({
    key: 'ADMIN_MANUAL',
    title: 'Administrative and Business Operations Policies and Procedures',
    docNumber: 'GFC-ADMIN',
    driveFileId: '1E-1J1l86cyC0sfdlcmOQDeHJExjwIBlr',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '2.3'
  })
});

// The link a person clicks. Always the canonical copy, never a stored one.
function driveViewUrl(sourceKey) {
  const s = SOURCES[sourceKey];
  if (!s) throw new Error(`Unknown onboarding source: ${sourceKey}`);
  return `https://drive.google.com/file/d/${s.driveFileId}/view`;
}

// A reference to a place inside a source document. `section` is the
// document's own numbering ("C.6", "12.4", "SOP-RX-01", "TRN-208").
function ref(source, section, extra) {
  if (!SOURCES[source]) throw new Error(`Unknown onboarding source: ${source}`);
  if (!section) throw new Error(`A reference into ${source} needs a section`);
  return Object.freeze(Object.assign({ source, section: String(section) }, extra || {}));
}

module.exports = { SOURCES, driveViewUrl, ref };
