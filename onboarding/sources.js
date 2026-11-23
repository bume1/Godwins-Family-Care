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

// The file ids below are DEFAULTS (owner, 2026-11-16: "not hardcoded; in the
// field I can also swap out links"). A Super Admin can point any document at a
// different Drive file from the Training Library's Document Links list; that
// choice is stored in `document_links` and read back through the getters below,
// so every caller that reads `driveFileId` sees it on its next request.
const overrides = Object.create(null);

const RAW_SOURCES = Object.freeze({
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
  // Playbook G.1: issued during systems provisioning; holds the daily
  // workflow, weekly structure and check-in agenda. Not duplicated here.
  LIAISON_PLAYBOOK: Object.freeze({
    key: 'LIAISON_PLAYBOOK',
    title: 'Community Care Liaison Playbook',
    docNumber: 'GFC-CCL',
    driveFileId: '1bwdUxRntw89l0RlKgHkCkYGqWqQb-7XS',
    mimeType: 'application/pdf',
    folder: 'Liaison',
    transcribedFromVersion: '2.5'
  }),
  // Training material sources (owner, 2026-11-10, Training Material Tracker).
  TEAM_ROLES: Object.freeze({
    key: 'TEAM_ROLES',
    title: 'Team Roles and Responsibilities',
    docNumber: 'GFC-ROLES',
    driveFileId: '1Z6v89NQvbcY7yBmixo8hw-LIPQ3YE5yc',
    mimeType: 'application/pdf',
    folder: 'Onboarding Library / 00 All Employees',
    transcribedFromVersion: '2.0'
  }),
  ADMIN_MANUAL: Object.freeze({
    key: 'ADMIN_MANUAL',
    title: 'Administrative and Business Operations Policies and Procedures',
    docNumber: 'GFC-ADMIN',
    driveFileId: '1E-1J1l86cyC0sfdlcmOQDeHJExjwIBlr',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '2.3'
  }),
  // The app SOP sets and the staff pay guide (owner, 2026-11-11). One .docx
  // per set, each with its own document number; the bundled admin SOP v1 they
  // replace is retired.
  ADMIN_SOPS_SET1: Object.freeze({
    key: 'ADMIN_SOPS_SET1',
    title: 'Administrative SOPs Set 1: Signing In, Onboarding and Training',
    docNumber: 'GFC-ADMIN-SOP-S1',
    driveFileId: '1Rm4Q9Qk0C6nRh_G4uvM8uWCGF3sB7FQD',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '2.1'
  }),
  ADMIN_SOPS_SET2: Object.freeze({
    key: 'ADMIN_SOPS_SET2',
    title: 'Administrative SOPs Set 2: Documents to Sign',
    docNumber: 'GFC-ADMIN-SOP-S2',
    driveFileId: '1fLC9VWBJ3uzzjMgKUUtRThtF3M3m4P5j',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.2'
  }),
  ADMIN_SOPS_SET3: Object.freeze({
    key: 'ADMIN_SOPS_SET3',
    title: 'Administrative SOPs Set 3: Payroll Records, Gusto to the App',
    docNumber: 'GFC-ADMIN-SOP-S3',
    driveFileId: '15I0r9-OCLSQIdsLQwBFb4PuR1wTJ4QKY',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.2'
  }),
  ADMIN_SOPS_SET4: Object.freeze({
    key: 'ADMIN_SOPS_SET4',
    title: 'Administrative SOPs Set 4: Your Pay Stub',
    docNumber: 'GFC-ADMIN-SOP-S4',
    driveFileId: '1UHVLazg9Wd7m_Z9R1_A397KJOhjLQp7l',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.0'
  }),
  ADMIN_SOPS_SET5: Object.freeze({
    key: 'ADMIN_SOPS_SET5',
    title: 'Administrative SOPs Set 5: Issuing Pay Stubs',
    docNumber: 'GFC-ADMIN-SOP-S5',
    driveFileId: '13o8fuJTDawlELW3xRRs6ymlihNIYpg3F',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.0'
  }),
  ADMIN_SOPS_SET6: Object.freeze({
    key: 'ADMIN_SOPS_SET6',
    title: 'Administrative SOPs Set 6: Running Payroll',
    docNumber: 'GFC-ADMIN-SOP-S6',
    driveFileId: '1LVhRjbMxc70g18tEvhLrUCy2nx-Kqt1-',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.0'
  }),
  // Running staff onboarding, for the office (owner, 2026-11-19).
  ADMIN_SOPS_SET7: Object.freeze({
    key: 'ADMIN_SOPS_SET7',
    title: 'Administrative SOPs Set 7: Running Staff Onboarding',
    docNumber: 'GFC-ADMIN-SOP-S7',
    driveFileId: '1uRHBtPz6EmQyRBx8siBpIr-zi_qC4WSA',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '01 Company / Policies & Procedures / Current',
    transcribedFromVersion: '1.0'
  }),
  STAFF_PAY_GUIDE: Object.freeze({
    key: 'STAFF_PAY_GUIDE',
    title: 'Staff Guide: Setting Up Your Pay',
    docNumber: 'GFC-STAFF-GUIDE-PAY',
    driveFileId: '1pdgksZaDfczISVC6uTV20bMT0MKaHWVv',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    folder: '06 People / Training',
    transcribedFromVersion: '1.0'
  }),
  // The staff how-to for what changed in the app (owner, 2026-11-18): in the
  // app training. Each new edition is swapped in from Policy & SOP Files.
  STAFF_APP_UPDATES_GUIDE: Object.freeze({
    key: 'STAFF_APP_UPDATES_GUIDE',
    title: 'Staff Guide to App Updates',
    docNumber: 'GFC-STAFF-GUIDE-APP',
    driveFileId: '1Q8YLuHuxhZoSdYJSZw-gErD1cQmjSgSau81J44L_YDY',
    mimeType: 'application/vnd.google-apps.document',
    folder: 'EMR & App Guides',
    transcribedFromVersion: '1.0'
  }),
  // The office's how-to for moving records off Gusto: on the SOP Set 3 row.
  GUSTO_RECORDS_GUIDE: Object.freeze({
    key: 'GUSTO_RECORDS_GUIDE',
    title: 'Moving Employee Records from Gusto into the GFC App',
    docNumber: 'GFC-OFFICE-GUIDE-GUSTO',
    driveFileId: '1FrWwUksOxQ1LivUbSZ-KbaRxPh2ZYNpgK8gieEJumDg',
    mimeType: 'application/vnd.google-apps.document',
    folder: 'EMR & App Guides',
    transcribedFromVersion: '1.0'
  })
});

// Each source exposes `driveFileId` as a getter: the override when one is set,
// else the default written here (`defaultDriveFileId`).
const SOURCES = Object.freeze(Object.fromEntries(Object.entries(RAW_SOURCES).map(([key, s]) => {
  const o = Object.assign({}, s, { defaultDriveFileId: s.driveFileId });
  delete o.driveFileId;
  Object.defineProperty(o, 'driveFileId', { enumerable: true, get: () => overrides['source:' + key] || s.driveFileId });
  return [key, Object.freeze(o)];
})));

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

// The staff pay guide, on the pay setup step of every onboarding list
// (owner, 2026-11-11): the guide sits where the work is done, not in a training.
const PAY_GUIDE = Object.freeze(Object.defineProperty({ label: 'Read the Staff Pay Guide' }, 'url',
  { enumerable: true, get: () => driveViewUrl('STAFF_PAY_GUIDE') }));

// A policy acknowledgment's files, overridable the same way. A policy whose
// files ARE a source document (the PHC manual, say) follows that source, so one
// change moves both; a policy with its own files is keyed `policy:<id>`.
const LINKED = Symbol('linkedAck');
function linkedAck(ack) {
  if (!ack || ack[LINKED]) return ack;
  const own = (ack.driveFileIds || []).slice();
  const src = ack.source && SOURCES[ack.source];
  const followsSource = !!(src && own.length === 1 && own[0] === src.defaultDriveFileId);
  const o = Object.assign({}, ack);
  delete o.driveFileIds;
  Object.defineProperty(o, 'driveFileIds', { enumerable: true, get: () => {
    const set = overrides['policy:' + ack.id];
    if (set) return [set];
    if (followsSource) return [src.driveFileId];
    return own.slice();
  } });
  Object.defineProperty(o, 'defaultDriveFileIds', { enumerable: false, value: Object.freeze(own) });
  Object.defineProperty(o, 'linkKey', { enumerable: false, value: followsSource ? 'source:' + ack.source : 'policy:' + ack.id });
  Object.defineProperty(o, LINKED, { value: true });
  return Object.freeze(o);
}

// The stored choices, loaded at boot and after every change.
function setOverrides(map) {
  Object.keys(overrides).forEach(k => { delete overrides[k]; });
  Object.entries(map || {}).forEach(([k, v]) => {
    const id = v && typeof v === 'object' ? v.fileId : v;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(id)) overrides[k] = id;
  });
}
const overrideFor = (key) => overrides[key] || null;
const linkAll = (list) => Object.freeze((list || []).map(linkedAck));

module.exports = { SOURCES, driveViewUrl, ref, PAY_GUIDE, linkedAck, linkAll, setOverrides, overrideFor };
