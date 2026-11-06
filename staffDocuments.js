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

module.exports = {
  EXT_FOR_MIME, ACCEPTED_LABEL,
  prepareStaffDocument, buildStaffDocumentRow
};
