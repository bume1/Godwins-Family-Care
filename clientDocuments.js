'use strict';

// Who may see and remove a document on a client's file (owner, 2026-09-29).
//
// Owner report: the patient's "Your clinical record" listed every upload on
// their file — including what staff filed — and everything in OpenEMR's
// Documents: lab and imaging results before a clinician had reviewed them,
// signed clinical note PDFs carrying the full narrative, and fax requisitions.
// A POA saw the same list. Nobody could delete a document at all.
//
// The rules, decided by the owner:
//   - A patient (or POA) sees what they sent us, plus anything staff filed
//     that a staff member deliberately SHARED with them. Nothing else.
//   - Nothing that lives only in OpenEMR is listed to a patient. Results,
//     signed notes and faxes are released by a person, not by being filed.
//   - Admin or manager can REMOVE an uploaded file, with a reason. It leaves
//     every screen in the app; who removed it, when and why stay on the row.
//     The Drive file is kept. Generated legal documents (consents, care plans,
//     signed notes) are not uploads and are never removable here.
//
// One module, so the patient's lists, the patient's file routes and the staff
// screens all answer "can this be seen" the same way.

const REMOVE_REASON_MIN = 3;
const REMOVE_REASON_MAX = 500;

const isRemoved = (u) => !!(u && u.removed);

// Every read that shows or serves an upload goes through this. Writes keep the
// whole array — a removed row stays in the store as the record of its removal.
const liveUploads = (rows) => (rows || []).filter(u => u && !isRemoved(u));

const isStaffFiled = (u) => !!u && u.source === 'staff';

// A patient sees their own uploads (they sent them), and a staff-filed one
// only once someone has deliberately shared it. Removed never; a rejected
// upload of their own stays visible on the checklist with its reason, which is
// how they learn to send a better photo.
const patientCanSee = (u) => !!u && !isRemoved(u) && (!isStaffFiled(u) || u.sharedWithPatient === true);

// Removing is an office decision, the same weight as rejecting a document.
// `isManager` is the legacy flag the scheduling board already reads as manager.
const canRemoveDocuments = (user) => !!user && (user.role === 'admin' || user.isManager === true);

const checkRemoval = (row, reason) => {
  if (!row) return { ok: false, status: 404, code: 'DOCUMENT_NOT_FOUND', error: 'Document not found' };
  if (isRemoved(row)) return { ok: false, status: 409, code: 'DOCUMENT_ALREADY_REMOVED', error: 'That document was already removed.' };
  const why = String(reason || '').trim();
  if (why.length < REMOVE_REASON_MIN) {
    return { ok: false, status: 400, code: 'REMOVE_REASON_REQUIRED', error: 'Say why this document is being removed. The reason is kept on record.' };
  }
  return { ok: true, reason: why.slice(0, REMOVE_REASON_MAX) };
};

const buildRemoval = ({ actor, reason, at }) => ({
  at: at || new Date().toISOString(),
  byId: (actor && actor.id) || null,
  byName: (actor && actor.name) || null,
  reason
});

// Sharing only means something for a staff-filed document: a client's own
// upload is theirs already, and hiding it from them would hide what they sent.
const checkShare = (row) => {
  if (!row || isRemoved(row)) return { ok: false, status: 404, code: 'DOCUMENT_NOT_FOUND', error: 'Document not found' };
  if (!isStaffFiled(row)) {
    return { ok: false, status: 409, code: 'CLIENT_OWN_DOCUMENT', error: 'The client sent this document, so they can already see it.' };
  }
  if (row.status === 'rejected') {
    return { ok: false, status: 409, code: 'DOCUMENT_REJECTED', error: 'A rejected document cannot be shared.' };
  }
  return { ok: true };
};

module.exports = {
  REMOVE_REASON_MIN,
  isRemoved,
  liveUploads,
  isStaffFiled,
  patientCanSee,
  canRemoveDocuments,
  checkRemoval,
  buildRemoval,
  checkShare
};
