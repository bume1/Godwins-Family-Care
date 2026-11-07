'use strict';

/**
 * WHAT A VALID STAFF DOCUMENT UPLOAD IS — declared once.
 *
 * A caregiver's timesheet, a W-9 the office files for them, and a clinician's
 * licence scan are all the same act: a person sends us a file about a member
 * of staff, and it is kept. They arrived as three separate code paths, and the
 * third one was broken from the day it shipped — it read `.ext` off a function
 * that returns a mime STRING, so every clinician upload was refused and nobody
 * found out until somebody posted a real PNG through it.
 *
 * That is the failure this module exists to stop: two copies of "what a valid
 * upload is" is how one door starts accepting what the other refuses, and the
 * drift is silent in both directions. Same rule as `prepareClientDocument` on
 * the client side, which this deliberately mirrors.
 *
 * ⚠️ THE LAUNCH-BOARD TASK UPLOAD (`POST /api/projects/:id/tasks/:id/files`)
 * IS THE SAME SHAPE AND IS DELIBERATELY NOT FOLDED IN HERE. It is the lab-era
 * ancestor of this pattern and it is dormant, not dead — it validates on the
 * mimetype the UPLOADER CLAIMS rather than on the bytes, and hands the browser
 * a direct Drive link rather than reading back through the app. Both are fine
 * for a project plan and neither is fine for a record that decides whether
 * somebody may see patients. Collapsing them would have to level that path UP
 * to these rules, which is a decision about the launch module, not a tidy-up.
 */

// PDF, JPEG and PNG. Anything a phone camera or a scanner produces, and
// nothing that executes.
const EXT_FOR_MIME = Object.freeze({
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg'
});

const ACCEPTED_LABEL = 'Only PDF, JPG and PNG files are accepted.';

/**
 * Decide whether a buffer may be stored, and what it actually is.
 *
 * `detectFileType` is passed in rather than required, because the one that
 * runs in production is built in `server.js` and reads magic bytes. It answers
 * a MIME STRING or null — never an object, which is precisely the shape the
 * clinician route got wrong.
 */
function prepareStaffDocument({ buffer, fileName, detectFileType, maxBytes, keyPrefix }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, status: 400, code: 'DOC_EMPTY', error: 'File is empty.' };
  }
  // The ceiling is PASSED IN from config, never a literal here. The clinician
  // route had multer's own 15 MB limit while the caregiver route had the app's
  // configured 10 MB, so one door already accepted what the other refused.
  if (maxBytes && buffer.length > maxBytes) {
    return {
      ok: false, status: 400, code: 'DOC_TOO_LARGE',
      error: `File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`
    };
  }
  // Typed by its BYTES, never by what the caller claimed. A declared mime is
  // caller-controlled and this is the only thing standing between the Drive
  // folder and an arbitrary file.
  const mime = detectFileType ? detectFileType(buffer) : null;
  const ext = mime ? EXT_FOR_MIME[mime] : null;
  if (!ext) {
    return { ok: false, status: 400, code: 'DOC_TYPE_REJECTED', error: ACCEPTED_LABEL };
  }
  const base = String(fileName || `document.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  return {
    ok: true, mime, ext,
    // Prefixed and timestamped so two people uploading "scan.pdf" do not
    // collide in one Drive folder.
    safeName: `${keyPrefix || 'doc'}_${Date.now()}_${base}`.slice(0, 180)
  };
}

/**
 * The stored row. ONE SHAPE, so the documents card, the download route and the
 * review flow read the same fields whichever door the file came through.
 *
 * `status` is the caller's, not this module's: who may accept a document on
 * sight is a policy question each door answers for itself (the office IS the
 * reviewer; a licence is checked against a primary source). What is shared is
 * the shape, not the judgement.
 */
function buildStaffDocumentRow({
  id, ownerId, ownerName, kind, fileName, storedName, mime, sizeBytes,
  driveFileId, driveUrl, note, status, uploadedById, uploadedByName,
  uploadedByOffice, periodStart, periodEnd, shiftId, extra
}) {
  return Object.assign({
    id,
    caregiver_id: ownerId == null ? null : String(ownerId),
    caregiver_name: ownerName || null,
    kind,
    file_name: String(fileName || '').slice(0, 200),
    stored_name: storedName || null,
    mime_type: mime || null,
    size_bytes: sizeBytes || 0,
    drive_file_id: driveFileId || null,
    drive_url: driveUrl || null,
    note: String(note || '').trim().slice(0, 1000),
    period_start: periodStart || null,
    period_end: periodEnd || null,
    shift_id: shiftId ? String(shiftId) : null,
    status,
    uploaded_at: new Date().toISOString(),
    // "They sent this" and "the office filed it for them" are different facts,
    // and for a W-9 or a licence the difference is the whole point.
    uploaded_by_id: uploadedById,
    uploaded_by_name: uploadedByName || null,
    uploaded_by_office: !!uploadedByOffice,
    reviewed_at: null, reviewed_by_name: null, review_note: null
  }, extra || {});
}

/**
 * WHERE A CLINICIAN'S DOCUMENT GOES IN DRIVE.
 *
 * `06 People` is not one folder. It is sorted by what a document IS, and the
 * office's own folder names say how:
 *
 *   Contracts & Offer Letters   the offer, the agreements, the scope letter
 *   Personnel Files             I-9, W-4, direct deposit, handbook, HIPAA
 *   Credentialing & Licensure   licence, DEA, board certification, NPI,
 *                               malpractice, background check — anything that
 *                               decides whether this person may see patients
 *
 * Both of the first two already carry per-person subfolders somebody made by
 * hand ("Kathryn Strickland", "Bethel Godwins, FNP"), so the app files the
 * same way rather than inventing a shape beside it.
 *
 * ⚠️ `Onboarding Library / Clinician (W2) | (1099) | (Hybrid)` is deliberately
 * NOT a destination. That is the READING library — the pack a new clinician
 * opens — and dropping her licence scan into it would put a personal document
 * in the folder the whole team reads from.
 *
 * ROUTED BY BLOCK, with named exceptions, because `CORE` mixes the two: the
 * offer and the agreements are contracts, the I-9 and the W-4 are personnel.
 * Anything not named here goes to Credentialing & Licensure, which is the safe
 * default: it is the most restricted of the three, so a document whose home we
 * have not decided lands somewhere narrower than it needs rather than wider.
 */
const SECTIONS = Object.freeze({
  CONTRACTS: 'contracts',
  PERSONNEL: 'personnel',
  CREDENTIALING: 'credentialing'
});

const SECTION_LABELS = Object.freeze({
  [SECTIONS.CONTRACTS]: 'Contracts & Offer Letters',
  [SECTIONS.PERSONNEL]: 'Personnel Files',
  [SECTIONS.CREDENTIALING]: 'Credentialing & Licensure'
});

// The employment arrangement is personnel, not a credential.
const PERSONNEL_BLOCKS = Object.freeze(['W2', 'C99', 'HYB']);

// `CORE` is the only block that splits, so it is the only one listed item by
// item. Everything else follows its block.
const CONTRACT_ITEMS = Object.freeze([
  'CORE-01', // accepted offer
  'CORE-02', // engagement letter
  'CORE-03', // employment agreement
  'CORE-04', // independent contractor agreement
  'CORE-05', // scope letter
  'CORE-10'  // NDA and non-solicitation
]);

const PERSONNEL_ITEMS = Object.freeze([
  'CORE-06', // Form I-9
  'CORE-07', // Form W-4
  'CORE-08', // direct deposit
  'CORE-09', // Form W-9 and vendor payment setup
  'CORE-11', // code of conduct and field addendum
  'CORE-12', // handbook acknowledgment
  'CORE-13', // team roles and responsibilities
  'CORE-14', // HIPAA privacy and security training
  'CORE-15'  // emergency contact and personal details
]);
// CORE-16, the FCRA background check authorization, is deliberately NOT here:
// the office already files its FCRA forms under Credentialing & Licensure, so
// the default sends it where they are.

function sectionForItem(item) {
  if (!item || !item.id) return SECTIONS.CREDENTIALING;
  if (CONTRACT_ITEMS.includes(item.id)) return SECTIONS.CONTRACTS;
  if (PERSONNEL_ITEMS.includes(item.id)) return SECTIONS.PERSONNEL;
  if (PERSONNEL_BLOCKS.includes(item.block)) return SECTIONS.PERSONNEL;
  return SECTIONS.CREDENTIALING;
}

/**
 * The person's own folder, named as the office already names them.
 *
 * The credential is appended where we hold one ("Bethel Godwins, FNP"), which
 * is the convention the Credentialing folder already uses. A name with nothing
 * in it would make one folder every unnamed person shares, so that is refused
 * rather than guessed at.
 */
function personFolderName({ name, credential }) {
  const clean = String(name || '').replace(/[\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const cred = String(credential || '').trim();
  return cred ? `${clean}, ${cred}`.slice(0, 120) : clean.slice(0, 120);
}

module.exports = {
  EXT_FOR_MIME, ACCEPTED_LABEL,
  prepareStaffDocument, buildStaffDocumentRow,
  SECTIONS, SECTION_LABELS, PERSONNEL_BLOCKS, CONTRACT_ITEMS, PERSONNEL_ITEMS,
  sectionForItem, personFolderName
};
