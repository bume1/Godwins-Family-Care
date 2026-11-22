// ============================================================================
// THE OFFER LETTER, FIRST (owner, 2026-11-19). staffOffers.js holds the rules;
// this file holds the routes.
//
//   Office (admin, or anyone holding the onboarding module):
//     GET  /api/onboarding/admin/people/:userId/offer              where it stands
//     POST /api/onboarding/admin/people/:userId/offer              send (or a new version)
//     POST /api/onboarding/admin/people/:userId/offer/resend-link  email the link again
//   The new hire:
//     GET  /api/my/offer                                            their offer
//     POST /api/my/offer/decline                                    decline, with a note
//
// SENDING REUSES WHAT EXISTS. The PDF becomes an ordinary document send to one
// person (staff_document_sends), attached to the chapter's offer item exactly
// as "Upload the Document They Sign" attaches one, so they sign it in the same
// viewer and the signing completes the item and files the signed copy through
// the existing sign route. Nothing here signs anything.
// ============================================================================
'use strict';

const express = require('express');
const multer = require('multer');
const accountTypes = require('../accountTypes');
const T = require('../onboarding/track');
const SO = require('../staffOffers');
const signedDocument = require('../onboarding/signedDocument');
const staffDocs = require('../staffDocuments');
const links = require('../appLinks');

const SENDS = 'staff_document_sends';
const RECORDS = 'onboarding_records';
const EVENTS = 'onboarding_events';
const STAFF_TYPES = Object.freeze(['admin', 'manager', 'coordinator', 'provider', 'rn', 'lcsw', 'lmsw', 'caregiver', 'liaison']);

// Attaching a document to an item is the office issuing it: the office steps
// before hers are recorded now, the same rule the attach route follows.
function attachToItem(rec, item, send, officeActor, now) {
  rec.items = rec.items || {};
  const st = rec.items[item.id] = rec.items[item.id] || {};
  st.document = { sendId: send.id, action: send.action, title: send.title };
  const hersAt = item.steps.findIndex(x => x.actor === 'NEW_HIRE');
  for (let i = 0; i < hersAt; i++) {
    if ((st.steps || {})[i]) continue;
    try { Object.assign(st, T.recordStep(item, st, i, officeActor, { source: 'Document sent in the app', verifiedOn: now.slice(0, 10) }, now)); } catch (_) { break; }
  }
  return st;
}

module.exports = function createStaffOfferRoutes(deps) {
  const { db, getUsers, invalidateUsersCache, logActivity, authenticateToken, uuidv4, drive, detectFileType, sessions } = deps;
  const router = express.Router();
  const nowIso = () => new Date().toISOString();
  const MAX = (deps.config && deps.config.STAFF_DOCUMENT_MAX_SIZE) || 25 * 1024 * 1024;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX } });
  const notifier = () => {
    const n = typeof deps.notify === 'function' ? deps.notify() : deps.notify;
    if (!n) console.error('[OFFER] no notifier injected: the office was NOT emailed');
    return n || null;
  };
  const baseUrl = async () => (deps.getAppBaseUrl ? deps.getAppBaseUrl() : '');
  const isOffice = (u) => !!u && (u.role === 'admin' || accountTypes.hasModule(u, 'onboarding'));
  const requireOffice = (req, res, next) => (isOffice(req.user) ? next()
    : res.status(403).json({ error: 'This is the office\'s onboarding view.', code: 'ONBOARDING_OFFICE_ONLY' }));
  const isStaff = (u) => STAFF_TYPES.includes(accountTypes.accountTypeOf(u));

  async function saveUser(userId, mutate) {
    const users = await getUsers();
    const i = users.findIndex(u => String(u.id) === String(userId));
    if (i === -1) return null;
    mutate(users[i]);
    await db.set('users', users);
    if (invalidateUsersCache) invalidateUsersCache();
    return users[i];
  }
  async function event(row) {
    const rows = (await db.get(EVENTS)) || [];
    rows.push(Object.assign({ id: uuidv4(), at: nowIso() }, row));
    await db.set(EVENTS, rows);
  }
  // The office: an admin or an onboarding module holder, and the sender.
  async function tellOffice(kind, user, offer, actorId) {
    try {
      const n = notifier(); if (!n || !n[kind]) return 0;
      const cta = `${await baseUrl()}${links.staffOnboardingFor()}`;
      const all = await getUsers();
      const to = all.filter(u => u && u.email && u.accountStatus !== 'inactive' && (isOffice(u) || String(u.id) === String(offer.sentById)));
      let count = 0;
      for (const u of to) {
        const out = await n[kind]({ user: u, staffName: user.name || user.email, title: offer.title, note: offer.declineNote || null, ctaUrl: cta, actorId });
        count += (out && out.notified) || 0;
      }
      return count;
    } catch (e) { console.error(`[OFFER] ${kind} notice failed (non-fatal):`, e.message); return 0; }
  }

  // ---- the office ----------------------------------------------------------
  router.get('/api/onboarding/admin/people/:userId/offer', authenticateToken, requireOffice, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId));
    if (!u) return res.status(404).json({ error: 'No such person.', code: 'PERSON_UNKNOWN' });
    return res.json({ offer: SO.publicOffer(u.offer) });
  });

  router.post('/api/onboarding/admin/people/:userId/offer', authenticateToken, requireOffice, (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File exceeds the ${Math.round(MAX / (1024 * 1024))} MB limit.`, code: 'DOC_TOO_LARGE' });
    return next(err);
  }), async (req, res) => {
    try {
      const users = await getUsers();
      const u = users.find(x => String(x.id) === String(req.params.userId));
      if (!u) return res.status(404).json({ error: 'No such person.', code: 'PERSON_UNKNOWN' });
      if (!isStaff(u)) return res.status(400).json({ error: 'Offer letters go to staff accounts.', code: 'OFFER_NOT_STAFF' });
      if (!u.email || /@placeholder\./i.test(u.email)) return res.status(400).json({ error: 'Add their email first: the offer link is emailed.', code: 'OFFER_NO_EMAIL' });
      if (u.offer && u.offer.status === 'signed' && !(req.body && req.body.newVersion === 'true')) {
        return res.status(409).json({ error: 'They have already signed their offer. Send a new version only if the terms changed.', code: 'OFFER_ALREADY_SIGNED' });
      }
      if (!req.file) return res.status(400).json({ error: 'Attach the offer letter as a PDF.', code: 'NO_FILE' });
      const isPdf = (detectFileType ? detectFileType(req.file.buffer) : null) === 'application/pdf' || String(req.file.buffer.slice(0, 5)) === '%PDF-';
      if (!isPdf) return res.status(400).json({ error: 'Send the offer as a PDF, so it can be signed and filed as one document.', code: 'DOC_NOT_PDF' });
      const title = String((req.body && req.body.title) || '').trim().slice(0, 200) || 'Offer letter';

      // Their checklist: opened now if it was not, without the "your
      // onboarding is ready" email (the offer email is their first contact).
      const recs = (await db.get(RECORDS)) || [];
      let rec = recs.find(r => String(r.userId) === String(u.id));
      const created = !rec;
      if (!rec) {
        rec = { id: uuidv4(), userId: String(u.id), userName: u.name || u.email, createdAt: nowIso(),
          inputs: T.normalizeInputs({ chapter: deps.defaultChapterFor(u) }), items: {}, training: {}, determinations: {} };
        rec.inputs.relationship = (T.CHAPTERS[rec.inputs.chapter] && T.CHAPTERS[rec.inputs.chapter].CHAPTER.relationship) || 'W2';
      }
      const itemId = SO.offerItemFor(rec.inputs && rec.inputs.chapter);
      const item = itemId ? T.findItem(itemId) : null;
      if (!item) return res.status(409).json({ error: 'This checklist has no offer letter (a student placement, for example).', code: 'OFFER_NO_ITEM' });

      const prepared = staffDocs.prepareStaffDocument({ buffer: req.file.buffer, fileName: req.file.originalname, detectFileType, maxBytes: MAX, keyPrefix: 'offer' });
      if (!prepared.ok) return res.status(prepared.status).json({ error: prepared.error, code: prepared.code });
      let stored;
      try {
        stored = await drive.uploadStaffDocumentFile('GFC Documents to Sign', 'Sent', prepared.safeName, req.file.buffer, 'application/pdf');
      } catch (err) {
        return res.status(502).json({ error: 'We could not store that offer letter. Please try again.', code: 'FILE_STORAGE_UNAVAILABLE' });
      }
      const now = nowIso();
      const sends = (await db.get(SENDS)) || [];
      // A new version replaces the old one: the old send is withdrawn, so it
      // can never be signed by mistake. A signed copy already filed stays filed.
      if (u.offer && u.offer.sendId && u.offer.status !== 'signed') {
        const old = sends.find(s => s.id === u.offer.sendId && !s.removedAt);
        if (old) Object.assign(old, { removedAt: now, removedByName: req.user.name || req.user.email, removedReason: 'new_offer_version' });
      }
      const send = { id: `send_${uuidv4().replace(/-/g, '').slice(0, 12)}`, title,
        note: String((req.body && req.body.note) || '').trim().slice(0, 1000) || null,
        action: 'sign', fileName: String(req.file.originalname || prepared.safeName).slice(0, 200), driveFileId: stored.fileId || stored.id || null,
        sha256: signedDocument.sha256(req.file.buffer), scope: { userId: String(u.id) }, offer: true,
        createdById: String(req.user.id), createdByName: req.user.name || req.user.email, createdAt: now, removedAt: null };
      sends.push(send);
      await db.set(SENDS, sends);

      const officeActor = { id: req.user.id, name: req.user.name || req.user.email, isOffice: true };
      attachToItem(rec, item, send, officeActor, now);
      // Re-sending clears her step on the item so the new version is what she signs.
      const st = rec.items[item.id];
      const hersAt = item.steps.findIndex(x => x.actor === 'NEW_HIRE');
      if (st.steps && st.steps[hersAt] && u.offer && u.offer.status !== 'signed') delete st.steps[hersAt];
      rec.updatedAt = now;
      if (created) recs.push(rec);
      await db.set(RECORDS, recs);

      const prevStatus = u.offer ? u.offer.status : null;
      const saved = await saveUser(u.id, (x) => {
        x.offer = SO.sentState(x.offer || null, { sendId: send.id, itemId: item.id, title, actor: officeActor, now });
        // A declined offer switched the account off; a new version switches it back on.
        if (prevStatus === 'declined') x.accountStatus = 'active';
      });
      await event({ userId: String(u.id), type: prevStatus ? 'offer_new_version' : 'offer_sent', itemId: item.id, sendId: send.id, byId: req.user.id, byName: req.user.name });
      await logActivity(req.user.id, req.user.name || req.user.email, prevStatus ? 'offer_new_version_sent' : 'offer_sent', 'user', String(u.id), { sendId: send.id, itemId: item.id });

      // Someone who already signed an offer once (a change of terms) gets it in
      // My Documents like any document; a new hire gets the set-password link.
      let delivered;
      if (SO.offerPending(saved)) {
        delivered = await deps.issueOfferLink(saved);
      } else {
        const n = notifier();
        const out = n && n.staffDocumentSent ? await n.staffDocumentSent({ user: saved, title, action: 'sign', sendId: send.id,
          ctaUrl: `${await baseUrl()}${links.documentsFor(saved)}`, actorId: req.user.id }) : null;
        delivered = { ok: !!(out && out.notified), channel: 'documents' };
      }
      return res.json({ ok: true, offer: SO.publicOffer(saved.offer), emailed: !!(delivered && delivered.ok), channel: delivered ? delivered.channel : null });
    } catch (e) {
      console.error('[OFFER] send failed:', e);
      return res.status(500).json({ error: 'The offer could not be sent. Please try again.', code: 'OFFER_SEND_FAILED' });
    }
  });

  router.post('/api/onboarding/admin/people/:userId/offer/resend-link', authenticateToken, requireOffice, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.params.userId));
    if (!u || !u.offer) return res.status(404).json({ error: 'No offer has been sent to this person.', code: 'OFFER_NONE' });
    if (!SO.offerPending(u)) return res.status(409).json({ error: 'There is no unsigned offer waiting on them.', code: 'OFFER_NOT_PENDING' });
    const out = await deps.issueOfferLink(u);
    await logActivity(req.user.id, req.user.name || req.user.email, 'offer_link_resent', 'user', String(u.id), {});
    return res.json({ ok: true, emailed: !!(out && out.ok) });
  });

  // ---- the new hire ----------------------------------------------------------
  router.get('/api/my/offer', authenticateToken, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.user.id));
    const o = u && u.offer;
    if (!o) return res.json({ offer: null, next: SO.nextAfterSigning(accountTypes.accountTypeOf(u)) });
    const send = ((await db.get(SENDS)) || []).find(s => s.id === o.sendId) || null;
    return res.json({
      offer: SO.publicOffer(o),
      doc: send ? { id: send.id, title: send.title, note: send.note || null, action: 'sign', fileName: send.fileName, sentAt: send.createdAt, sentByName: send.createdByName || null } : null,
      firstName: String(u.preferredName || u.name || '').split(' ')[0] || null,
      next: SO.nextAfterSigning(accountTypes.accountTypeOf(u))
    });
  });

  router.post('/api/my/offer/decline', authenticateToken, async (req, res) => {
    const u = (await getUsers()).find(x => String(x.id) === String(req.user.id));
    if (!u || !u.offer || u.offer.status !== 'sent') return res.status(409).json({ error: 'There is no offer waiting on you.', code: 'OFFER_NOT_PENDING' });
    if (u.offer.everSigned) return res.status(409).json({ error: 'Talk to the office about a change to your terms.', code: 'OFFER_DECLINE_AFTER_SIGNED' });
    const note = String((req.body || {}).note || '');
    if (note.trim().length > SO.DECLINE_NOTE_MAX) return res.status(400).json({ error: `Keep the note under ${SO.DECLINE_NOTE_MAX} characters.`, code: 'OFFER_NOTE_TOO_LONG' });
    const saved = await saveUser(u.id, (x) => {
      x.offer = SO.declinedState(x.offer, { note });
      // Declining switches the account off. The office can send a new version.
      x.accountStatus = 'inactive';
    });
    // The offer is withdrawn so it cannot be signed after a decline.
    const sends = (await db.get(SENDS)) || [];
    const s = sends.find(x => x.id === saved.offer.sendId && !x.removedAt);
    if (s) { Object.assign(s, { removedAt: nowIso(), removedByName: saved.name || saved.email, removedReason: 'offer_declined' }); await db.set(SENDS, sends); }
    await event({ userId: String(u.id), type: 'offer_declined', sendId: saved.offer.sendId, byId: u.id, byName: u.name });
    // The note is theirs to the office: it goes in the email, not the activity log.
    await logActivity(u.id, u.name || u.email, 'offer_declined', 'user', String(u.id), { withNote: !!saved.offer.declineNote });
    await tellOffice('staffOfferDeclined', saved, saved.offer, u.id);
    if (sessions && sessions.revokeAllForUser) await sessions.revokeAllForUser(u.id, 'offer_declined');
    return res.json({ ok: true });
  });

  return router;
};

// Called by the sign route (routes/staffPortal.js) after any signing: settles
// the offer when the signed document is it. Returns where to go next, or null.
module.exports.settleOfferOnSign = async function settleOfferOnSign(deps, { userId, sendId, actorId }) {
  const { db, getUsers, invalidateUsersCache } = deps;
  const users = await getUsers();
  const i = users.findIndex(u => String(u.id) === String(userId));
  if (i === -1 || !users[i].offer) return null;
  const next = SO.signedState(users[i].offer, { sendId });
  if (!next) return null;
  users[i].offer = next;
  await db.set('users', users);
  if (invalidateUsersCache) invalidateUsersCache();
  const u = users[i];
  try {
    const n = typeof deps.notify === 'function' ? deps.notify() : deps.notify;
    if (n && n.staffOfferSigned) {
      const cta = `${deps.getAppBaseUrl ? await deps.getAppBaseUrl() : ''}${links.staffOnboardingFor()}`;
      const isOffice = (x) => !!x && (x.role === 'admin' || accountTypes.hasModule(x, 'onboarding'));
      for (const o of users.filter(x => x && x.email && x.accountStatus !== 'inactive' && (isOffice(x) || String(x.id) === String(next.sentById)))) {
        await n.staffOfferSigned({ user: o, staffName: u.name || u.email, title: next.title, ctaUrl: cta, actorId });
      }
    }
  } catch (e) { console.error('[OFFER] signed notice failed (non-fatal):', e.message); }
  return SO.nextAfterSigning(accountTypes.accountTypeOf(u));
};
module.exports.attachToItem = attachToItem;
