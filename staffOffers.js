// ============================================================================
// staffOffers.js: the offer letter as the first onboarding step (owner,
// 2026-11-19).
//
// THE GAP. An offer letter could only reach someone after they were an active
// user and the office had opened their onboarding, and it sat in Phase 2
// behind pre-hire screening. A new hire's first contact was a temporary
// password. Owner: "add a step to the onboarding process for all staff and
// that is viewing and signing their offer letter document", seamless into My
// GFC and the rest of the app.
//
// THE FLOW. The office sends the offer PDF. The new hire gets ONE email: a
// link to choose their password, which signs them in and opens the offer in
// the same document viewer every signing uses. Until they sign, the offer is
// the only thing they can open (the gate below, enforced on the server). Once
// signed they go on to the welcome packet and My GFC (or the caregiver app).
// They may decline with a note: the office is told and the account switches
// off until the office sends a new version.
//
// PURE. No storage, no I/O: the routes load and save.
//
//   user.offer = { status: 'sent'|'signed'|'declined', sendId, itemId,
//                  title, sentAt, sentById, sentByName, signedAt,
//                  declinedAt, declineNote, everSigned, history[] }
//
// NO `offer` FIELD MEANS NO GATE. Everyone already working is untouched.
// ONCE AN OFFER HAS BEEN SIGNED (`everSigned`), a later new version (a
// promotion, a change of terms) never locks the person out of their work: it
// arrives as an ordinary document to sign in My Documents.
// ============================================================================
'use strict';

const STATUSES = Object.freeze(['sent', 'signed', 'declined']);
const DECLINE_NOTE_MAX = 500;

// The offer item on each chapter's checklist. G reuses F's items and E reuses
// C's; a contracted clinician (D) signs the contractor agreement instead; the
// supervising physician (R1) the physician agreement. A student (H) is on an
// unpaid placement and has no offer.
const OFFER_ITEM_BY_CHAPTER = Object.freeze({
  A: 'A.5.01', B: 'B.5.01', C: 'C.5.01', D: 'D.4.02', E: 'C.5.01', F: 'F.5.01', G: 'F.5.01', R1: 'R1.1.01'
});
const offerItemFor = (chapter) => OFFER_ITEM_BY_CHAPTER[String(chapter || '')] || null;

// The gate: an offer sent and not yet answered, to someone who has never
// signed one.
const offerPending = (user) => !!(user && user.offer && user.offer.status === 'sent' && !user.offer.everSigned);

// What a person with a pending offer may still reach: signing in and out, the
// offer's own routes, and the offer document itself. Everything else answers
// OFFER_PENDING. `path` is the request path without the query string.
function pathAllowedWhilePending(path, user) {
  const p = String(path || '').split('?')[0];
  if (!p.startsWith('/api/')) return true;
  if (p.startsWith('/api/auth/')) return true;
  if (p === '/api/my/offer' || p.startsWith('/api/my/offer/')) return true;
  const sendId = user && user.offer && user.offer.sendId;
  if (sendId) {
    const base = `/api/my/document-sends/${encodeURIComponent(sendId)}/`;
    if (['file', 'preview', 'sign'].some(x => p === base + x)) return true;
  }
  return false;
}

const historyOf = (prev) => (prev && Array.isArray(prev.history) ? prev.history.slice(-49) : []);

// The office sent (or re-sent) an offer.
function sentState(prev, { sendId, itemId, title, actor, now }) {
  const at = new Date(now || Date.now()).toISOString();
  return {
    status: 'sent', sendId: String(sendId), itemId: itemId || null, title: title || 'Offer letter',
    sentAt: at, sentById: actor ? String(actor.id) : null, sentByName: actor ? (actor.name || null) : null,
    signedAt: null, declinedAt: null, declineNote: null,
    everSigned: !!(prev && (prev.everSigned || prev.status === 'signed')),
    history: historyOf(prev).concat([{ at, event: prev ? 'new_version' : 'sent', sendId: String(sendId), byName: actor ? actor.name || null : null }])
  };
}

function signedState(prev, { sendId, now }) {
  if (!prev || String(prev.sendId) !== String(sendId)) return null; // not the offer
  const at = new Date(now || Date.now()).toISOString();
  return Object.assign({}, prev, { status: 'signed', signedAt: at, everSigned: true,
    history: historyOf(prev).concat([{ at, event: 'signed', sendId: String(sendId) }]) });
}

function declinedState(prev, { note, now }) {
  if (!prev || prev.status !== 'sent') return null;
  const at = new Date(now || Date.now()).toISOString();
  const clean = String(note || '').trim().slice(0, DECLINE_NOTE_MAX) || null;
  return Object.assign({}, prev, { status: 'declined', declinedAt: at, declineNote: clean,
    history: historyOf(prev).concat([{ at, event: 'declined', sendId: prev.sendId }]) });
}

// Where a person goes once their offer is signed: the welcome packet (the
// caregiver app opens on theirs).
const nextAfterSigning = (accountType) => (accountType === 'caregiver' ? '/caregiver' : '/my#welcome');

// What the office and the new hire are shown. Never the sender's id.
const publicOffer = (o) => (o ? {
  status: o.status, sendId: o.sendId, itemId: o.itemId, title: o.title, sentAt: o.sentAt, sentByName: o.sentByName,
  signedAt: o.signedAt || null, declinedAt: o.declinedAt || null, declineNote: o.declineNote || null,
  everSigned: !!o.everSigned, gated: offerPending({ offer: o })
} : null);

module.exports = {
  STATUSES, DECLINE_NOTE_MAX, OFFER_ITEM_BY_CHAPTER, offerItemFor, offerPending, pathAllowedWhilePending,
  sentState, signedState, declinedState, nextAfterSigning, publicOffer
};
