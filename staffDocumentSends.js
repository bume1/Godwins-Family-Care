// ============================================================================
// DOCUMENTS SENT TO STAFF TO REVIEW OR SIGN (owner, 2026-11-09)
// ============================================================================
// The office sends its own PDF (a contract, a policy, an updated agreement) to
// one staff member or to everyone of a type, at any time: during onboarding or
// long after. Each recipient opens it in the app and acknowledges it or signs
// it alone; the copy that files to their Documents is the original with a
// signature-record page appended (onboarding/signedDocument.js).
//
// PURE. The routes load the rows and pass them in.
//
//   send:    { id, title, note, action: 'acknowledge'|'sign', fileName,
//              driveFileId, sha256, scope, createdById, createdByName,
//              createdAt, removedAt }
//   scope:   { userId }              one person
//            { types: [audience…] }  everyone of those account types, now
//                                     and later ('all' covers every type)
//            { chapter }             everyone onboarding under a chapter (an
//                                     onboarding task carrying a document)
//   signing: { id, sendId, userId, action, printedName, signedAt, ipHash,
//              documentId, originalSha256 }
// ============================================================================

'use strict';

const ACTIONS = Object.freeze(['acknowledge', 'sign']);

// Does this send reach this person? `audience` is their staff type, `chapter`
// their onboarding chapter (null when they have no onboarding record).
function reaches(send, { userId, audience, chapter }) {
  if (!send || send.removedAt || !send.scope || !audience) return false;
  const s = send.scope;
  if (s.userId) return String(s.userId) === String(userId);
  if (Array.isArray(s.types)) return s.types.includes('all') || s.types.includes(audience);
  if (s.chapter) return !!chapter && s.chapter === chapter;
  return false;
}

const signingFor = (signings, sendId, userId) =>
  (signings || []).find(r => r && r.sendId === sendId && String(r.userId) === String(userId)) || null;

// This person's documents: what is waiting on them, and what they have done.
function forPerson(sends, signings, person) {
  const mine = (sends || []).filter(s => reaches(s, person));
  const view = (s) => {
    const done = signingFor(signings, s.id, person.userId);
    return { id: s.id, title: s.title, note: s.note || null, action: s.action, fileName: s.fileName,
      sentAt: s.createdAt, sentByName: s.createdByName || null,
      done: !!done, doneAt: done ? done.signedAt : null, documentId: done ? done.documentId : null };
  };
  return {
    waiting: mine.filter(s => !signingFor(signings, s.id, person.userId)).map(view),
    done: mine.filter(s => !!signingFor(signings, s.id, person.userId)).map(view)
  };
}

// Who a send reaches, and where each of them stands: the office's view.
function recipients(send, people, signings) {
  return (people || []).filter(p => reaches(send, p)).map(p => {
    const done = signingFor(signings, send.id, p.userId);
    return { userId: p.userId, name: p.name, done: !!done, doneAt: done ? done.signedAt : null, documentId: done ? done.documentId : null };
  });
}

// A send's scope from what the office chose, or null when it names nobody.
function scopeFrom(raw, { staffTypes, chapters, userExists }) {
  const s = raw || {};
  if (s.userId) return userExists(String(s.userId)) ? { userId: String(s.userId) } : null;
  if (Array.isArray(s.types)) {
    const t = s.types.map(String).filter(x => x === 'all' || staffTypes.includes(x));
    return t.length ? { types: Array.from(new Set(t)) } : null;
  }
  if (s.chapter) return chapters.includes(String(s.chapter)) ? { chapter: String(s.chapter) } : null;
  return null;
}

module.exports = { ACTIONS, reaches, signingFor, forPerson, recipients, scopeFrom };
