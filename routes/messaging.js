// ============================================================================
// Messaging routes (Session 9)
// Spec: docs/GFC_Session9_ClaudeCode_Prompt.md — the channel matrix and the
//       visibility rules are normative there.
//
// Mounted from server.js with ONE require + ONE app.use, the same parallel-build
// protocol Sessions 6 and 7 followed. Dependencies are injected, so server.js
// holds no messaging state and this module stays probe-drivable.
//
// KV collections owned here (snake_case rows, id + *_id keys, keyed for the RDS
// migration — the convention roiRepository.js set and Sessions 6 and 7 kept):
//   message_threads   one row per conversation, scoped to ONE client
//   messages          one row per message, pointing at its thread
//
// It also APPENDS to `escalation_events` and `escalation_status_events`, which
// Session 6 owns. That is deliberate and the brief asks for it: a behavioral
// concern raised in a message and one raised from a visit log are the same
// event to the person who has to act on it, and two stores would mean two
// inboxes and one of them going unread. Session 6's shape is used exactly as
// merged, with `source` added to say which door it came through.
//
// NOT A CHAT SERVER. No read receipts beyond a per-user read mark, no typing
// indicators, no realtime push — out of scope by the brief. It rides the
// EXISTING notification queue; there is not a second one.
//
// Owner, 2026-09-29: messages carry FORMATTED TEXT (the six shapes in
// public/note-format.js, stored as `body_format: 'markup'`; an older message has
// no format and is plain) and up to five ATTACHMENTS (PDF, JPEG, PNG, typed by
// their bytes, stored privately in Drive, read back only through the route below
// after the thread's visibility rule, and audited). A Drive failure REFUSES the
// send: a message pointing at a file that does not exist is worse than none.
// ============================================================================

const express = require('express');
const links = require('../appLinks');   // where each person actually goes
const msg = require('../messagingRepository');
const caregiverRepo = require('../caregiverRepository');
const nf = require('../public/note-format.js');   // the message formatting: plain text for escalations and previews
const familyLinks = require('../familyLinks');   // POA is per patient; one family account can cover several
const quoSms = require('../quoSms');   // Care Team messages by text (owner, 2026-10-15)
const chartComms = require('../chartCommunications');   // calls into the chart (owner, 2026-10-19)

module.exports = function createMessagingRoutes(deps) {
  const { db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4,
    upload, uploadLimiter, googledrive, detectFileType, contentDisposition } = deps;
  // Texting: the Quo client is injectable so a probe never reaches Quo.
  const smsClient = deps.smsClient || quoSms.createClient();
  const appBase = async () => {
    try { return String((deps.getAppBaseUrl ? await deps.getAppBaseUrl() : '') || '').replace(/\/+$/, ''); } catch (_) { return ''; }
  };
  // The STAFF message notice goes through the shared notifier, so "how much may
  // this email say" is answered once, by `transportAllowsDetail()`, rather than
  // restated here. A getter because the notifier is built further down
  // server.js than this router is registered; only ever called at request time.
  //
  // A MISSING NOTIFIER IS LOUD, NEVER SILENT. The notice is best-effort and must
  // not fail the send that triggered it, so this does not throw — but a wiring
  // slip that quietly stops telling staff a message is waiting is the exact
  // class of failure this repo keeps paying for.
  const notifier = () => {
    const n = typeof deps.notify === 'function' ? deps.notify() : null;
    if (!n) console.error('[MSG] no notifier injected — staff were NOT told a message is waiting');
    return n;
  };
  const router = express.Router();

  const ROLES = config.ROLES;
  const nowIso = () => new Date().toISOString();
  const readRows = async (key) => (await db.get(key)) || [];

  // ---- Identity ------------------------------------------------------------
  const freshUser = async (id) => (await getUsers()).find(u => u.id === id) || null;

  // The client a request is ABOUT. A client is their own; family resolve
  // through `familyOfClientId`; staff name one explicitly. Staff naming a
  // client they have no relationship to is caught by the visibility rules, not
  // here — this only answers "which client".
  const resolveClient = async (user, explicitClientId) => {
    const users = await getUsers();
    const byId = (id) => users.find(u => u.id === id && u.role === ROLES.CLIENT) || null;
    if (user.role === ROLES.CLIENT) return byId(user.id);
    if (user.role === ROLES.FAMILY) return byId(user.familyOfClientId);
    return explicitClientId ? byId(String(explicitClientId)) : null;
  };

  // A POA acts for the client (4.3). Read from the FRESH user record, never
  // from the token: a POA designation revoked this morning must not still be
  // acting this afternoon on a token minted last week.
  const isActingPoa = async (user, client) => {
    if (!user || user.role !== ROLES.FAMILY || !client) return false;
    const fresh = await freshUser(user.id);
    // POA is per patient (familyLinks.js), so it is asked of THIS client, never
    // read off the stored mirror fields, which describe only the first link.
    return familyLinks.isPoaFor(fresh, client.id);
  };

  // Is this client one the acting user may message about? Session 6 owns the
  // caregiver assignment rule, so it is called here rather than copied.
  const inScope = (user, client) => msg.clientInScope(user, client, {
    caregiverAssigned: caregiverRepo.isAssignedToCaregiver(user, client)
  });

  const requireMessagingRole = (req, res, next) => {
    if (msg.actorRole(req.user)) return next();
    return res.status(403).json({ error: 'This account cannot use messaging.', code: 'NO_MESSAGING_ROLE' });
  };

  // ---- Thread helpers ------------------------------------------------------
  const loadThread = async (id) => (await readRows('message_threads')).find(t => t && t.id === id) || null;

  const clientById = async (id) => (await getUsers()).find(u => u.id === id && u.role === ROLES.CLIENT) || null;

  // Every read of a single thread goes through this. It answers 404 for a
  // thread that does not exist and 403 for one that does and is not yours —
  // deliberately NOT an empty list, which would say "there is nothing here".
  const openThread = async (req, threadId) => {
    const thread = await loadThread(threadId);
    if (!thread) return { error: { status: 404, body: { error: 'Conversation not found.', code: 'THREAD_NOT_FOUND' } } };
    const client = await clientById(thread.client_id);
    const isPoa = await isActingPoa(req.user, client);
    const seen = msg.threadVisibility(req.user, thread, { client, isPoa });
    if (!seen.visible) {
      return { error: { status: 403, body: { error: seen.reason, code: seen.code } } };
    }
    return { thread, client, isPoa };
  };

  // Who should be on a new thread. Resolved from the client's care team at
  // creation and stored on the row, so a later care-team change does not
  // retroactively remove someone from a conversation they took part in.
  const participantsFor = async (channelId, { user, client }) => {
    const users = await getUsers();
    const ids = new Set([user.id]);
    const add = (id) => { if (id) ids.add(id); };

    const channel = msg.channelById(channelId);
    const wants = channel ? channel.participants : [];

    if (wants.includes(msg.ROLE.CLIENT) && client) add(client.id);
    if (wants.includes(msg.ROLE.CAREGIVER)) msg.assignedCaregiverIds(client).forEach(add);
    if (wants.includes(msg.ROLE.CLINICAL)) msg.assignedClinicianIds(client).forEach(add);
    // Every case manager on the care team: the assigned one, supporting case
    // managers and care coordinators (owner, 2026-10-15: "the entire clinical
    // team for that patient").
    if (wants.includes(msg.ROLE.CASE_MANAGER)) msg.caseManagerIds(client).forEach(add);
    if (wants.includes(msg.ROLE.FAMILY) && client) {
      familyLinks.familyFor(users, client.id, { activeOnly: false }).forEach(f => add(f.user.id));
    }
    if (wants.includes(msg.ROLE.ADMIN)) {
      users.filter(u => u.role === ROLES.ADMIN).forEach(u => add(u.id));
    }
    if (wants.includes(msg.ROLE.MANAGER)) {
      users.filter(u => u.isManager === true && (u.accountStatus || 'active') !== 'inactive').forEach(u => add(u.id));
    }
    // A POA is client-equivalent, so on a channel that names the client they are
    // on it too — otherwise they could read it and never be told it existed.
    if (channel && channel.includesPoa && client) poaIdsFor(users, client).forEach(add);
    return [...ids];
  };

  // The client's designated POAs, from the FRESH user list.
  const poaIdsFor = (users, client) => familyLinks.familyFor(users, client.id, { poaOnly: true, activeOnly: false }).map(f => f.user.id);

  const publicThread = (t, me) => ({
    id: t.id,
    channel: t.channel,
    channelLabel: msg.threadTitle(t),
    withPatient: msg.withPatient(t.channel),
    // The yellow "Patient sees this" badge on the thread list (owner, 2026-10-16).
    patientFacing: msg.isPatientFacing(t),
    clientId: t.client_id,
    clientName: t.client_name,
    subject: t.subject,
    status: t.status,
    responseStatus: t.response_status || null,
    escalationEventId: t.escalation_event_id || null,
    startedByName: t.started_by_name,
    startedByRole: t.started_by_role,
    createdAt: t.created_at,
    lastMessageAt: t.last_message_at,
    lastMessagePreview: t.last_message_preview || '',
    participantCount: (t.participant_ids || []).length,
    unread: typeof me === 'number' ? me : 0
  });

  const publicMessage = (m) => ({
    id: m.id,
    threadId: m.thread_id,
    from: m.display_name,
    fromRole: m.from_role,
    // What the sender IS, stored when it was sent (owner, 2026-10-16); an
    // older message falls back to its coarse messaging role.
    fromRoleLabel: m.from_role_label || msg.ROLE_LABELS[m.from_role] || m.from_role,
    isPoa: m.from_role === 'POA',
    actingFor: m.acting_for || null,
    body: m.body,
    // Absent on a message written before formatting existed: that one is PLAIN
    // TEXT and must never be run through the formatter.
    format: m.body_format === 'markup' ? 'markup' : 'plain',
    attachments: (m.attachments || []).map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
    sentAt: m.sent_at,
    // Everyone reading the thread is told a message was changed after it was
    // sent (owner, 2026-10-14). Who changed it and what it said before stay in
    // the office record (`m.edits`), never on the screen.
    edited: !!m.edited_at,
    editedAt: m.edited_at || null,
    // 'sms' when the words arrived or left as a text on the office line.
    via: m.via || null,
    mine: false
  });

  // ---- Attachments ---------------------------------------------------------
  // multer/busboy hands back the filename decoded as latin1 while browsers send
  // UTF-8, so "José" arrives as "JosÃ©". Re-read the bytes; if that is not valid
  // UTF-8 the name really was latin1 and is left as it came.
  const utf8Name = (n) => {
    const raw = String(n || '');
    if (!/[\u0080-\u00ff]/.test(raw)) return raw;
    const fixed = Buffer.from(raw, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? raw : fixed;
  };
  // Control characters and bidi/zero-width marks are removed: a right-to-left
  // override makes "fdp.exe" read as "exe.pdf" on a chip.
  const cleanName = (n) => utf8Name(n).replace(/[\\/\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '_').trim().slice(0, 120) || 'attachment';
  // The extension always says what the BYTES are, whatever the sender called it.
  const EXT_FOR_MIME = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
  const nameForMime = (name, mime) => {
    const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').slice(0, 110) || 'attachment';
    return base + (EXT_FOR_MIME[mime] || '');
  };
  // Files stored in Drive for a send that then fails AFTER storage (a write, the
  // audit row) would be orphaned: nothing points at them. Removed best-effort.
  const discardStored = async (attachments) => {
    for (const a of attachments || []) { try { await googledrive.deleteFile(a.drive_file_id); } catch (_) { /* best effort */ } }
  };
  const attachmentsEnabled = !!(upload && googledrive && detectFileType);

  // multipart/form-data carries files; a plain JSON post carries none. Multer
  // errors are turned into a sentence about the file, not a 500.
  const parseMessageBody = (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    if (!attachmentsEnabled) {
      return res.status(415).json({ error: 'Attachments are not available right now.', code: 'ATTACHMENTS_UNAVAILABLE' });
    }
    const run = () => upload.array('files', msg.MAX_ATTACHMENTS + 1)(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      const tooMany = err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT';
      return res.status(400).json({
        error: tooBig ? `Each attachment is up to ${Math.round(config.MAX_FILE_SIZE / 1048576)} MB.`
          : tooMany ? `A message carries up to ${msg.MAX_ATTACHMENTS} attachments.`
          : 'That attachment could not be read.',
        code: tooBig ? 'ATTACHMENT_TOO_LARGE' : tooMany ? 'TOO_MANY_ATTACHMENTS' : 'ATTACHMENT_UNREADABLE'
      });
    });
    return uploadLimiter ? uploadLimiter(req, res, run) : run();
  };

  // Every file is typed by its BYTES and refused BEFORE any is stored; then each
  // is stored privately. If storage fails part-way the ones already stored are
  // removed and the send is refused — nothing is written pointing at a file that
  // is not there.
  const storeAttachments = async (client, files) => {
    const list = files || [];
    for (const f of list) {
      const mime = detectFileType(f.buffer);
      if (!mime || !msg.ATTACHMENT_MIMES.includes(mime)) {
        return { error: { status: 400, body: { error: `"${cleanName(f.originalname)}" is not a PDF, JPEG or PNG.`, code: 'ATTACHMENT_BAD_TYPE' } } };
      }
      f.__mime = mime;
    }
    const stored = [];
    try {
      for (const f of list) {
        const name = nameForMime(cleanName(f.originalname), f.__mime);
        const up = await googledrive.uploadMessageAttachmentFile((client && client.name) || 'Office', `msg_${Date.now()}_${uuidv4().slice(0, 8)}_${name}`, f.buffer, f.__mime);
        stored.push({ id: uuidv4(), name, mime: f.__mime, size: f.buffer.length, drive_file_id: up.fileId });
      }
    } catch (e) {
      console.error('[MESSAGING] attachment storage failed:', e.message);
      for (const a of stored) { try { await googledrive.deleteFile(a.drive_file_id); } catch (_) { /* best effort */ } }
      return { error: { status: 502, body: { error: 'We could not store that attachment, so the message was not sent. Please try again.', code: 'ATTACHMENT_STORAGE_UNAVAILABLE' } } };
    }
    return { attachments: stored };
  };

  // ==========================================================================
  // Which clients this user may message about — the picker behind every staff
  // screen. Without it a staff member had no way to name a client, so every
  // channel answered NO_CLIENT and the whole surface read as broken.
  // Scoped by the SAME function the routes gate on, so a name that appears here
  // can always be opened and one that cannot be opened never appears.
  // ==========================================================================
  router.get('/api/messaging/clients', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const users = await getUsers();
      const clients = users
        .filter(u => u && u.role === ROLES.CLIENT && inScope(req.user, u))
        .map(u => ({ id: u.id, name: u.name || u.email || 'Client' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ role: msg.actorRole(req.user), scoped: !msg.isUnrestricted(req.user), clients });
    } catch (error) {
      console.error('Messaging client list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Channels a user may open, for a given client
  // ==========================================================================
  router.get('/api/messaging/channels', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const client = await resolveClient(req.user, req.query.clientId);
      const users = await getUsers();
      const isPoa = await isActingPoa(req.user, client);
      res.json({
        role: msg.actorRole(req.user),
        client: client ? { id: client.id, name: client.name } : null,
        channels: msg.channelsFor({ user: req.user, client, users, isPoa })
      });
    } catch (error) {
      console.error('Messaging channels error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Thread list — FILTERED AT THE QUERY LAYER
  // The same visibility function the single-thread read uses, applied to every
  // row. A list built one way and a read gated another way is how a thread
  // ends up visible in one place and refused in the other.
  // ==========================================================================
  router.get('/api/messaging/threads', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const threads = await readRows('message_threads');
      const allMessages = await readRows('messages');
      const users = await getUsers();
      const clientsById = new Map(users.filter(u => u.role === ROLES.CLIENT).map(u => [u.id, u]));

      const own = await resolveClient(req.user, null);
      const poaFor = own && await isActingPoa(req.user, own) ? own.id : null;

      const visible = [];
      for (const t of threads) {
        if (!t) continue;
        const client = clientsById.get(t.client_id) || null;
        const seen = msg.threadVisibility(req.user, t, { client, isPoa: poaFor === t.client_id });
        if (!seen.visible) continue;
        if (req.query.clientId && t.client_id !== String(req.query.clientId)) continue;
        if (req.query.channel && t.channel !== String(req.query.channel)) continue;
        const mine = allMessages.filter(m => m && m.thread_id === t.id);
        visible.push(publicThread(t, msg.unreadCount(mine, req.user.id)));
      }
      visible.sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
      // The yellow "Patient sees this" badges are for staff; a patient or
      // their family is the patient side and is not shown them.
      res.json({ threads: visible.slice(0, 200), staffView: !msg.CLIENT_SIDE_ROLES.includes(msg.actorRole(req.user)) });
    } catch (error) {
      console.error('Messaging thread list error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Open a thread — 403 when it is not yours, never an empty list
  // ==========================================================================
  router.get('/api/messaging/threads/:id', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const opened = await openThread(req, req.params.id);
      if (opened.error) return res.status(opened.error.status).json(opened.error.body);
      const { thread, client, isPoa } = opened;

      const rows = (await readRows('messages'))
        .filter(m => m && m.thread_id === thread.id)
        .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));

      // Mark read for THIS user only. Append-only per user: a read mark is
      // never removed and never speaks for anyone else.
      const all = await readRows('messages');
      let changed = false;
      for (const m of all) {
        if (m && m.thread_id === thread.id && m.from_user_id !== req.user.id && !(m.read_by || []).includes(req.user.id)) {
          m.read_by = (m.read_by || []).concat([req.user.id]);
          changed = true;
        }
      }
      if (changed) await db.set('messages', all);

      const responder = thread.channel === 'care_update' ? msg.staffResponder(thread, rows) : null;
      const everyone = await getUsers();
      const post = msg.canPostToThread(req.user, thread, { client, isPoa, responder });

      await logActivity(req.user.id, req.user.name || req.user.email, 'message_thread_read', 'message_thread', thread.id,
        { role: msg.actorRole(req.user), channel: thread.channel, clientId: thread.client_id });

      res.json({
        thread: publicThread(thread, 0),
        // A message sent before labels were stored reads the sender's account
        // now, rather than the coarse messaging role ("Office", "Clinician").
        messages: rows.map(m => {
          const out = { ...publicMessage(m), mine: m.from_user_id === req.user.id };
          if (!m.from_role_label && m.from_role !== 'POA') {
            const u = everyone.find(x => x && x.id === m.from_user_id);
            if (u) out.fromRoleLabel = msg.personLabel(u, thread.client_id);
          }
          return out;
        }),
        canPost: post.allowed,
        cannotPostReason: post.allowed ? null : post.reason,
        cannotPostCode: post.allowed ? null : post.code,
        // The page draws Delete Thread from this answer and decides nothing.
        canDelete: msg.canDeleteThread(req.user),
        // The same for Edit, on every message in the thread.
        canEdit: msg.canEditMessage(req.user),
        // And for deleting a single message (owner, 2026-10-16).
        canDeleteMessage: msg.canDeleteMessage(req.user),
        // WHO IS IN THIS CONVERSATION, from the thread's own participant list
        // (owner, 2026-10-16), so the screen cannot say something the thread
        // does not. Names and what each person is; nothing else.
        people: (thread.participant_ids || []).map(id => {
          const u = everyone.find(x => x && x.id === id);
          return u ? { id: u.id, name: u.name || u.email || 'Unknown', label: msg.personLabel(u, thread.client_id), you: u.id === req.user.id } : null;
        }).filter(Boolean),
        // The yellow "Patient sees this" badge, and on a Care Update who answers.
        patientFacing: msg.isPatientFacing(thread),
        staffResponderName: responder ? responder.name : null
      });
    } catch (error) {
      console.error('Messaging thread read error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Delete a thread — SUPER ADMIN ONLY (owner, 2026-10-14)
  // The thread and its messages leave every screen. They are moved, never
  // erased: a conversation about a patient is a record, so the whole thread is
  // kept in `deleted_message_threads` with who deleted it, when and why — the
  // same rule the cross-client repair follows with `quarantined_messages`.
  // Attachments stay where they are stored. The audit row names the thread,
  // never its words.
  // ==========================================================================
  router.delete('/api/messaging/threads/:id', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      if (!msg.canDeleteThread(req.user)) {
        return res.status(403).json({ error: 'Only the super admin can delete a message thread.', code: 'DELETE_SUPER_ADMIN_ONLY' });
      }
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Say why this thread is being deleted.', code: 'DELETE_REASON_REQUIRED' });
      const threads = await readRows('message_threads');
      const idx = threads.findIndex(t => t && t.id === req.params.id);
      if (idx < 0) return res.status(404).json({ error: 'That conversation was not found.', code: 'THREAD_NOT_FOUND' });
      const thread = threads[idx];
      const all = await readRows('messages');
      const removed = all.filter(m => m && m.thread_id === thread.id);
      const deletedAt = new Date().toISOString();
      const archive = await readRows('deleted_message_threads');
      archive.push({
        id: uuidv4(), thread, messages: removed, deletedAt,
        deletedById: req.user.id, deletedByName: req.user.name || req.user.email || null, reason
      });
      // Archive FIRST, so a failure part-way leaves a copy rather than a gap.
      await db.set('deleted_message_threads', archive);
      await db.set('messages', all.filter(m => !(m && m.thread_id === thread.id)));
      threads.splice(idx, 1);
      await db.set('message_threads', threads);
      await logActivity(req.user.id, req.user.name || req.user.email, 'message_thread_deleted', 'message_thread', thread.id,
        { channel: thread.channel, clientId: thread.client_id, messageCount: removed.length });
      res.json({ deleted: true, threadId: thread.id, messageCount: removed.length });
    } catch (error) {
      console.error('Messaging thread delete error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Delete ONE message — SUPER ADMIN ONLY (owner, 2026-10-16)
  // "Allow for super admin to DELETE individual messages within threads. Keep
  // an internal audit log like everything else." The message leaves every
  // screen; it is moved, never erased: kept in `deleted_messages` with who,
  // when and why, like a deleted thread. The thread's preview and last-message
  // time follow what is left. The audit row names the message, never its words.
  // ==========================================================================
  router.delete('/api/messaging/messages/:messageId', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      if (!msg.canDeleteMessage(req.user)) {
        return res.status(403).json({ error: 'Only the super admin can delete a message.', code: 'DELETE_SUPER_ADMIN_ONLY' });
      }
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Say why this message is being deleted.', code: 'DELETE_REASON_REQUIRED' });
      const all = await readRows('messages');
      const idx = all.findIndex(m => m && m.id === req.params.messageId);
      if (idx < 0) return res.status(404).json({ error: 'That message was not found.', code: 'MESSAGE_NOT_FOUND' });
      const removed = all[idx];
      const deletedAt = new Date().toISOString();
      const archive = await readRows('deleted_messages');
      archive.push({ id: uuidv4(), message: removed, deletedAt, deletedById: req.user.id, deletedByName: req.user.name || req.user.email || null, reason });
      // Archive FIRST, so a failure part-way leaves a copy rather than a gap.
      await db.set('deleted_messages', archive);
      all.splice(idx, 1);
      await db.set('messages', all);
      const threads = await readRows('message_threads');
      const t = threads.find(x => x && x.id === removed.thread_id);
      if (t) {
        const left = all.filter(m => m && m.thread_id === t.id).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
        const last = left[left.length - 1];
        t.last_message_at = last ? last.sent_at : t.created_at;
        t.last_message_preview = last ? msg.previewOf(last.body, last.body_format, last.attachments) : '';
        await db.set('message_threads', threads);
      }
      await logActivity(req.user.id, req.user.name || req.user.email, 'message_deleted', 'message', removed.id,
        { threadId: removed.thread_id, channel: t ? t.channel : null, clientId: t ? t.client_id : null });
      res.json({ deleted: true, messageId: removed.id, threadId: removed.thread_id });
    } catch (error) {
      console.error('Messaging message delete error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Edit a sent message — SUPER ADMIN ONLY, at any point (owner, 2026-10-14)
  // The new words replace the old on every screen, and the message is marked
  // Edited for everyone. The earlier words are never thrown away: each edit
  // appends what the message said before, who changed it, when and why, onto
  // the message's own row. A message to a patient is a record. Attachments and
  // the format (plain or formatted) stay as sent. No new email goes out: an
  // edit is a correction, not a new message. The audit row names the message,
  // never its words.
  // ==========================================================================
  router.put('/api/messaging/messages/:messageId', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      if (!msg.canEditMessage(req.user)) {
        return res.status(403).json({ error: 'Only the super admin can edit a sent message.', code: 'EDIT_SUPER_ADMIN_ONLY' });
      }
      const body = req.body || {};
      const reason = String(body.reason || '').trim().slice(0, 500);
      if (!reason) return res.status(400).json({ error: 'Say why this message is being edited.', code: 'EDIT_REASON_REQUIRED' });
      const all = await readRows('messages');
      const m = all.find(x => x && x.id === req.params.messageId);
      if (!m) return res.status(404).json({ error: 'That message was not found.', code: 'MESSAGE_NOT_FOUND' });
      const format = m.body_format === 'markup' ? 'markup' : 'plain';
      const v = msg.validateMessage({ body: body.body, format }, { attachmentCount: (m.attachments || []).length });
      if (!v.valid) return res.status(400).json({ error: v.errors[0].message, code: v.errors[0].code, errors: v.errors });
      if (v.clean.body === String(m.body || '')) {
        return res.status(400).json({ error: 'That is what the message already says.', code: 'EDIT_NO_CHANGE' });
      }
      const at = new Date().toISOString();
      m.edits = (m.edits || []).concat([{
        at, byId: req.user.id, byName: req.user.name || req.user.email || null, reason,
        previousBody: m.body, previousFormat: format
      }]);
      m.body = v.clean.body;
      m.edited_at = at;
      await db.set('messages', all);

      // The thread list shows the last message's preview; keep it true.
      const threads = await readRows('message_threads');
      const t = threads.find(x => x && x.id === m.thread_id);
      if (t) {
        const last = all.filter(x => x && x.thread_id === t.id).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at))).pop();
        if (last && last.id === m.id) {
          t.last_message_preview = msg.previewOf(m.body, format, m.attachments);
          await db.set('message_threads', threads);
        }
      }
      await logActivity(req.user.id, req.user.name || req.user.email, 'message_edited', 'message', m.id,
        { threadId: m.thread_id, channel: t ? t.channel : null, clientId: t ? t.client_id : null, editCount: m.edits.length });
      res.json({ message: { ...publicMessage(m), mine: m.from_user_id === req.user.id } });
    } catch (error) {
      console.error('Messaging message edit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Start a thread
  // ==========================================================================
  router.post('/api/messaging/threads', authenticateToken, requireMessagingRole, parseMessageBody, async (req, res) => {
    let filed = []; let written = false;
    try {
      const body = req.body || {};
      const channelId = String(body.channel || '');
      const channel = msg.channelById(channelId);
      if (!channel) {
        return res.status(400).json({ error: `"${channelId}" is not a channel.`, code: 'UNKNOWN_CHANNEL', channels: msg.CHANNEL_IDS });
      }

      const client = await resolveClient(req.user, body.clientId);
      // Refused HERE, not only at read time. Without this a case manager could
      // start a thread about a client they are not assigned to and then be
      // unable to see the thread they had just created — a message sent into a
      // room the sender cannot enter.
      if (client && !inScope(req.user, client)) {
        return res.status(403).json({
          error: 'You are not on this client\'s care team.', code: 'CLIENT_NOT_IN_SCOPE'
        });
      }
      const users = await getUsers();
      const isPoa = await isActingPoa(req.user, client);
      const availability = msg.channelAvailability(channelId, { user: req.user, client, users, isPoa });
      if (!availability.available) {
        return res.status(403).json({ error: availability.reason, code: availability.code });
      }

      // WHO IT GOES TO (owner, 2026-10-15). On Care Team the sender chooses
      // from the patient, their POA and the care team; on Support the OFFICE
      // chooses from the patient side and the care team. The list is the one
      // the composer showed (msg.audienceFor); the choice is checked against it
      // before anything is stored. Sent without a choice (an older page), it
      // goes to everyone on the list.
      let chosen = null;
      const audience = msg.audienceFor(channelId, { user: req.user, client, users, isPoa });
      if (audience) {
        let ids = body.recipientIds;
        // No choice sent (an older page): everyone on the list, except Support
        // from the office, which is one-to-one and so goes to the patient it is
        // about, or must be chosen.
        if (ids === undefined || ids === '') ids = channelId === 'support' ? (client ? [client.id] : []) : audience.map(m => m.id);
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (e) { ids = null; } }
        if (!Array.isArray(ids)) return res.status(400).json({ error: 'recipientIds must be a list.', code: 'RECIPIENTS_INVALID' });
        const allowed = new Set(audience.map(m => String(m.id)));
        const wanted = [...new Set(ids.map(String))];
        if (wanted.some(id => !allowed.has(id))) {
          return res.status(400).json({ error: 'Only people on this patient\'s care team, the patient and their family can be chosen.', code: 'RECIPIENT_NOT_ON_CARE_TEAM' });
        }
        if (!wanted.length) return res.status(400).json({ error: 'Choose at least one person to send this to.', code: 'RECIPIENTS_REQUIRED' });
        // Support from the office is one-to-one: ONE person (owner, 2026-10-15).
        if (channelId === 'support' && wanted.length !== 1) {
          return res.status(400).json({ error: 'A Support message goes to one person. Choose one.', code: 'SUPPORT_ONE_RECIPIENT' });
        }
        chosen = { ids: wanted, partial: channelId === 'support' || wanted.length < audience.length };
      }
      // SUPPORT IS ONE-TO-ONE WITH THE OFFICE (owner, 2026-10-15): anyone who
      // is not the office — a patient, a family member or POA, any team member —
      // and the office (admins and managers). Nobody else is on it.
      const staffToOffice = channelId === 'support' && !chosen;
      const officeIds = users.filter(u => u && (u.accountStatus || 'active') !== 'inactive' &&
        (u.role === ROLES.ADMIN || u.isManager === true)).map(u => u.id);

      const files = req.files || [];
      const { valid, errors, clean } = msg.validateMessage(body, { attachmentCount: files.length });
      if (!valid) return res.status(400).json({ error: errors[0].message, code: errors[0].code, errors });
      // Attachments are stored only once everything else about the send is
      // known to be allowed, and a failure here writes nothing.
      const stored = await storeAttachments(client, files);
      if (stored.error) return res.status(stored.error.status).json(stored.error.body);
      const attachments = stored.attachments;
      filed = attachments;

      const sender = msg.senderIdentity(req.user, { client, isPoa });
      const at = nowIso();
      const threadId = uuidv4();

      const thread = {
        id: threadId,
        channel: channelId,
        client_id: client ? client.id : null,          // null: a team member's Support with no patient
        client_name: client ? client.name : null,
        subject: String(body.subject || channel.label).trim().slice(0, 140),
        participant_ids: chosen
          ? [...new Set([req.user.id, ...chosen.ids, ...(channelId === 'support' ? officeIds : [])])]
          : staffToOffice
            ? [...new Set([req.user.id, ...officeIds])]
            : await participantsFor(channelId, { user: req.user, client }),
        // True when the sender's choice decides who reads it: then only the
        // people on it do, whatever their scope (threadVisibility). Admin still
        // sees everything.
        audience_chosen: !!((chosen && chosen.partial) || staffToOffice),
        started_by: req.user.id,
        started_by_name: sender.displayName,
        started_by_role: sender.fromRole,
        status: 'open',
        // A clinical escalation is a question waiting for an answer, so it
        // carries a status from the moment it exists. Every other channel has
        // none, rather than a meaningless "n/a".
        // A clinical escalation carries a status because someone is waiting on an
        // answer. When the CLINICIAN opens the conversation there is nobody
        // waiting, so it carries none rather than an 'awaiting_response' that
        // would sit on the clinician's own queue asking them to answer
        // themselves.
        response_status: (channel.tracksResponse && msg.actorRole(req.user) !== msg.ROLE.CLINICAL)
          ? 'awaiting_response' : null,
        escalation_event_id: null,
        created_at: at,
        last_message_at: at,
        last_message_preview: msg.previewOf(clean.body, clean.format, attachments)
      };

      // Is the patient side on it, and who answers them (owner, 2026-10-16)?
      const familyIds = client ? familyLinks.familyFor(users, client.id, { activeOnly: false }).map(f => f.user.id) : [];
      thread.patient_facing = !!client && thread.participant_ids.some(id => id === client.id || familyIds.includes(id));
      const starterRole = msg.actorRole(req.user);
      if (channelId === 'care_update' && !isPoa && starterRole && !msg.CLIENT_SIDE_ROLES.includes(starterRole) && starterRole !== msg.ROLE.ADMIN) {
        thread.staff_responder_id = req.user.id;
        thread.staff_responder_name = sender.displayName;
      }

      const message = {
        id: uuidv4(),
        thread_id: threadId,
        client_id: client ? client.id : null,
        channel: channelId,
        from_user_id: sender.fromUserId,
        from_role: sender.fromRole,
        from_name: sender.fromName,
        display_name: sender.displayName,
        from_role_label: isPoa ? 'POA' : msg.personLabel(users.find(u => u && u.id === req.user.id) || req.user),
        acting_for: sender.actingFor,
        body: clean.body,
        body_format: clean.format,
        attachments,
        sent_at: at,
        read_by: [req.user.id]
      };

      // A behavioral escalation becomes an event in SESSION 6'S store, in
      // Session 6's shape, so the case manager has one inbox rather than two.
      if (channel.raisesEscalation) {
        thread.escalation_event_id = await raiseBehavioralEscalation({
          actor: req.user, sender, client, text: clean.format === 'markup' ? nf.toPlainText(clean.body) : clean.body, threadId, at
        });
      }

      const threads = await readRows('message_threads');
      threads.push(thread);
      await db.set('message_threads', threads);
      const all = await readRows('messages');
      all.push(message);
      await db.set('messages', all);
      written = true;

      await logActivity(req.user.id, req.user.name || req.user.email, 'message_thread_started', 'message_thread', threadId,
        { channel: channelId, clientId: client ? client.id : null, role: sender.fromRole, actingFor: sender.actingFor });

      await notifyThread(thread, message, req.user.id);

      res.json({
        thread: publicThread(thread, 0),
        message: { ...publicMessage(message), mine: true },
        // A caveat that does not block the send still has to be SAID, or the
        // sender believes it reached someone it did not.
        notice: availability.code ? availability.reason : null
      });
    } catch (error) {
      console.error('Messaging thread create error:', error);
      if (!written) await discardStored(filed);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Reply
  // ==========================================================================
  router.post('/api/messaging/threads/:id/messages', authenticateToken, requireMessagingRole, parseMessageBody, async (req, res) => {
    let filed = []; let written = false;
    try {
      const opened = await openThread(req, req.params.id);
      if (opened.error) return res.status(opened.error.status).json(opened.error.body);
      const { thread, client, isPoa } = opened;

      const responder = thread.channel === 'care_update'
        ? msg.staffResponder(thread, (await readRows('messages')).filter(m => m && m.thread_id === thread.id))
        : null;
      const post = msg.canPostToThread(req.user, thread, { client, isPoa, responder });
      if (!post.allowed) return res.status(403).json({ error: post.reason, code: post.code });

      const files = req.files || [];
      const { valid, errors, clean } = msg.validateMessage(req.body, { attachmentCount: files.length });
      if (!valid) return res.status(400).json({ error: errors[0].message, code: errors[0].code, errors });
      const stored = await storeAttachments(client, files);
      if (stored.error) return res.status(stored.error.status).json(stored.error.body);
      const attachments = stored.attachments;
      filed = attachments;

      const sender = msg.senderIdentity(req.user, { client, isPoa });
      const senderRecord = (await freshUser(req.user.id)) || req.user;
      const at = nowIso();
      const message = {
        id: uuidv4(),
        thread_id: thread.id,
        client_id: thread.client_id,
        channel: thread.channel,
        from_user_id: sender.fromUserId,
        from_role: sender.fromRole,
        from_name: sender.fromName,
        display_name: sender.displayName,
        from_role_label: isPoa ? 'POA' : msg.personLabel(senderRecord),
        acting_for: sender.actingFor,
        body: clean.body,
        body_format: clean.format,
        attachments,
        sent_at: at,
        read_by: [req.user.id]
      };

      const all = await readRows('messages');
      all.push(message);
      await db.set('messages', all);
      written = true;

      const threads = await readRows('message_threads');
      const idx = threads.findIndex(t => t && t.id === thread.id);
      threads[idx].last_message_at = at;
      threads[idx].last_message_preview = msg.previewOf(clean.body, clean.format, attachments);
      // A clinician replying to a clinical escalation IS the response. Nobody
      // has to remember to also press a button, because a status that depends
      // on someone remembering is a status that goes stale.
      if (threads[idx].response_status && msg.actorRole(req.user) === msg.ROLE.CLINICAL &&
          msg.canTransitionResponse(threads[idx].response_status, 'responded')) {
        threads[idx].response_status = 'responded';
        threads[idx].responded_at = at;
        threads[idx].responded_by_name = sender.displayName;
      }
      // A participant who was not on the row (an admin stepping in) joins it,
      // so the thread records who actually took part.
      if (!threads[idx].participant_ids.includes(req.user.id)) threads[idx].participant_ids.push(req.user.id);
      // The first staff member to answer the patient becomes the one who
      // answers them on this thread (owner, 2026-10-16). Not the super admin,
      // who may always answer and must not lock out the clinician.
      const role = msg.actorRole(req.user);
      if (thread.channel === 'care_update' && !responder && !threads[idx].staff_responder_id &&
          role && !msg.CLIENT_SIDE_ROLES.includes(role) && role !== msg.ROLE.ADMIN && !isPoa) {
        threads[idx].staff_responder_id = req.user.id;
        threads[idx].staff_responder_name = sender.displayName;
      }
      await db.set('message_threads', threads);

      await logActivity(req.user.id, req.user.name || req.user.email, 'message_sent', 'message', message.id,
        { threadId: thread.id, channel: thread.channel, clientId: thread.client_id, role: sender.fromRole, actingFor: sender.actingFor });

      await notifyThread(threads[idx], message, req.user.id);

      res.json({ message: { ...publicMessage(message), mine: true }, thread: publicThread(threads[idx], 0) });
    } catch (error) {
      console.error('Messaging reply error:', error);
      if (!written) await discardStored(filed);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Clinical escalation response status — clinician or admin, forward-only
  // ==========================================================================
  // ==========================================================================
  // Read one attachment. It goes through the SAME visibility rule as reading the
  // thread (403 when the thread is not yours, 404 when nothing is there), the
  // bytes are served with the type they were SNIFFED to, and every read is
  // audited. Never a Drive link.
  // ==========================================================================
  router.get('/api/messaging/messages/:messageId/attachments/:attachmentId', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const m = (await readRows('messages')).find(x => x && x.id === req.params.messageId);
      if (!m) return res.status(404).json({ error: 'Attachment not found.', code: 'ATTACHMENT_NOT_FOUND' });
      const opened = await openThread(req, m.thread_id);
      if (opened.error) return res.status(opened.error.status).json(opened.error.body);
      const a = (m.attachments || []).find(x => x && x.id === req.params.attachmentId);
      if (!a || !a.drive_file_id) return res.status(404).json({ error: 'Attachment not found.', code: 'ATTACHMENT_NOT_FOUND' });
      if (!attachmentsEnabled) return res.status(501).json({ error: 'Attachments are not available right now.', code: 'ATTACHMENTS_UNAVAILABLE' });
      let bytes;
      try { bytes = await googledrive.downloadFileBuffer(a.drive_file_id); }
      catch (e) {
        console.error('[MESSAGING] attachment read failed:', e.message);
        return res.status(502).json({ error: 'That attachment could not be opened right now.', code: 'ATTACHMENT_READ_FAILED' });
      }
      await logActivity(req.user.id, req.user.name || req.user.email, 'message_attachment_read', 'message', m.id,
        { threadId: m.thread_id, attachmentId: a.id, channel: opened.thread.channel, clientId: opened.thread.client_id });
      res.setHeader('Content-Type', a.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', contentDisposition ? contentDisposition('inline', a.name) : `inline; filename="attachment"`);
      return res.send(bytes);
    } catch (error) {
      console.error('Messaging attachment error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/messaging/threads/:id/response-status', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const opened = await openThread(req, req.params.id);
      if (opened.error) return res.status(opened.error.status).json(opened.error.body);
      const { thread } = opened;

      const role = msg.actorRole(req.user);
      if (role !== msg.ROLE.CLINICAL && role !== msg.ROLE.ADMIN) {
        return res.status(403).json({ error: 'Only a clinician or an administrator moves an escalation along.', code: 'RESPONSE_STATUS_DENIED' });
      }
      if (!thread.response_status) {
        return res.status(409).json({ error: 'That conversation is not a tracked escalation.', code: 'NOT_AN_ESCALATION' });
      }
      const to = String((req.body || {}).status || '');
      const refusal = msg.responseRefusal(thread.response_status, to);
      if (refusal) return res.status(409).json({ ...refusal, error: refusal.message, from: thread.response_status, to });

      const threads = await readRows('message_threads');
      const idx = threads.findIndex(t => t && t.id === thread.id);
      threads[idx].response_status = to;
      threads[idx][`${to}_at`] = nowIso();
      if (to === 'closed') threads[idx].status = 'closed';
      await db.set('message_threads', threads);

      await logActivity(req.user.id, req.user.name || req.user.email, 'escalation_response_status', 'message_thread', thread.id,
        { from: thread.response_status, to, clientId: thread.client_id });

      res.json({ thread: publicThread(threads[idx], 0) });
    } catch (error) {
      console.error('Messaging response status error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Behavioral escalation → SESSION 6'S store, in Session 6's shape
  // ==========================================================================
  async function raiseBehavioralEscalation({ actor, sender, client, text, threadId, at }) {
    const users = await getUsers();
    const caseManagerId = msg.assignedCaseManagerId(client);
    const admins = users.filter(u => u.role === ROLES.ADMIN);
    const cm = caseManagerId ? users.find(u => u.id === caseManagerId) : null;

    // Session 6's rule, kept: when the care team has nobody for the type, it
    // goes to admin AND the sender is told so. An unrouted concern must never
    // read as though it reached the intended person.
    const notified = (cm ? [{ id: cm.id, name: cm.name, role: 'caseManager', reason: 'assigned case manager' }] : [])
      .concat(admins.map(a => ({ id: a.id, name: a.name, role: 'admin', reason: cm ? 'always has visibility' : 'no case manager is assigned' })));

    const id = uuidv4();
    const row = {
      id,
      client_id: client.id,
      client_name: client.name,
      caregiver_id: actor.id,
      caregiver_name: sender.displayName,
      visit_log_id: null,
      concern_type: 'behavioral',
      severity: 'standard',
      channels: ['in_app'],
      description: String(text).slice(0, 2000),
      notified,
      visibility: notified.map(r => r.id),
      fallback_to_admin: !cm,
      status: 'received',
      raised_at: at,
      received_at: at,
      acknowledged_at: null,
      resolved_at: null,
      // The one field Session 6's shape does not have. Additive, so Session 6's
      // readers (which read named fields) are unaffected, and it answers "did
      // this come from a visit log or a message" without inference.
      source: 'message',
      message_thread_id: threadId
    };

    const events = await readRows('escalation_events');
    events.push(row);
    await db.set('escalation_events', events);

    const trail = await readRows('escalation_status_events');
    trail.push(
      { id: uuidv4(), escalation_id: id, status: 'raised', by_user_id: actor.id, by_name: sender.displayName, note: '', at },
      { id: uuidv4(), escalation_id: id, status: 'received', by_user_id: null, by_name: 'system', note: 'Raised from a message.', at }
    );
    await db.set('escalation_status_events', trail);

    await logActivity(actor.id, sender.displayName, 'escalation_raised', 'escalation', id,
      { source: 'message', clientId: client.id, concernType: 'behavioral', threadId });
    return id;
  }

  // ==========================================================================
  // Care Team messages by text, on the office line through Quo (owner,
  // 2026-10-15: "I want the messages bi directional").
  //
  //   Out: a Care Team message goes to the patient and POA as a text, to each
  //        person who turned texts on. 9pm to 8am Eastern it waits for 8am.
  //   In:  a text from the patient's number or a POA's number lands in that
  //        patient's Care Team thread as them.
  //   Quo app: a reply typed in the Quo app on the office line is recorded in
  //        the thread too, as "GFC office (by text)".
  //
  // `sms_outbox` holds every text the app sends (waiting, sent, failed);
  // `sms_events` holds one row per webhook handled, by Quo message id, so a
  // retried webhook is never recorded twice. Neither copies the words twice:
  // the outbox keeps the text it sends, the thread keeps the message.
  // ==========================================================================
  const SMS_MAX_ATTEMPTS = 5;

  async function textMessageTo(u, thread, message) {
    if (!quoSms.textsOn(u)) return null;
    const client = await clientById(thread.client_id);
    const to = quoSms.phoneForUser(u, client);
    if (!to) return null;
    const base = await appBase();
    const content = quoSms.outgoingText({
      senderName: message.display_name,
      body: message.body,
      format: message.body_format,
      attachmentCount: (message.attachments || []).length,
      // A family member linked to several patients lands on this thread's.
      portalUrl: u.role === ROLES.FAMILY && thread.client_id
        ? `${base}${links.PATHS.PORTAL}?for=${encodeURIComponent(thread.client_id)}#messages`
        : `${base}${links.PATHS.PORTAL_MESSAGES}`,
      first: !(u.smsOptIn && u.smsOptIn.firstTextAt)
    });
    const row = {
      id: uuidv4(), to, user_id: u.id, client_id: thread.client_id, thread_id: thread.id, message_id: message.id,
      content, status: 'waiting', send_after: quoSms.quietUntil() || nowIso(), attempts: 0,
      quo_message_id: null, error: null, created_at: nowIso(), sent_at: null
    };
    const box = await readRows('sms_outbox');
    box.push(row);
    await db.set('sms_outbox', box);
    if (row.send_after <= nowIso()) await sendOutboxRow(row.id);
    return row.id;
  }

  async function sendOutboxRow(id) {
    const box = await readRows('sms_outbox');
    const row = box.find(r => r && r.id === id);
    if (!row || (row.status !== 'waiting' && row.status !== 'retry')) return null;
    // Re-read the person: a STOP or a turned-off switch since this was queued
    // means it never goes.
    const u = (await getUsers()).find(x => x && x.id === row.user_id);
    if (!quoSms.textsOn(u)) {
      row.status = 'cancelled'; row.error = 'Texts were turned off before this went.';
      await db.set('sms_outbox', box);
      return row;
    }
    if (!quoSms.status().sending) {
      row.status = 'failed'; row.error = 'Texting is not set up (QUO_API_KEY).';
      await db.set('sms_outbox', box);
      return row;
    }
    row.attempts += 1;
    try {
      const sent = await smsClient.sendText({ to: row.to, content: row.content });
      row.status = 'sent'; row.sent_at = nowIso(); row.quo_message_id = sent.id || null; row.error = null;
    } catch (e) {
      row.error = String(e.message || e).slice(0, 300);
      row.status = row.attempts >= SMS_MAX_ATTEMPTS ? 'failed' : 'retry';
      row.send_after = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      console.error('[SMS] send failed:', row.error);
    }
    await db.set('sms_outbox', box);
    if (row.status === 'sent' && u && !(u.smsOptIn && u.smsOptIn.firstTextAt)) {
      const users = await getUsers();
      const fresh = users.find(x => x && x.id === u.id);
      if (fresh) {
        fresh.smsOptIn = { ...(fresh.smsOptIn || {}), firstTextAt: row.sent_at };
        await db.set('users', users);
        if (typeof deps.invalidateUsersCache === 'function') deps.invalidateUsersCache();
      }
    }
    await logActivity(null, 'system', row.status === 'sent' ? 'sms_sent' : 'sms_send_failed', 'message', row.message_id,
      { threadId: row.thread_id, clientId: row.client_id, userId: row.user_id, attempts: row.attempts });
    return row;
  }

  // Run every minute from server.js: texts held for quiet hours, and retries.
  async function drainSmsOutbox() {
    const now = nowIso();
    const due = (await readRows('sms_outbox')).filter(r => r && (r.status === 'waiting' || r.status === 'retry') && r.send_after <= now);
    for (const r of due) {
      try { await sendOutboxRow(r.id); } catch (e) { console.error('[SMS] drain failed:', e.message); }
    }
    return due.length;
  }

  // The patient's most recent Care Team thread this person can read and answer.
  async function careTeamThreadFor(user, client, isPoa) {
    const threads = (await readRows('message_threads'))
      .filter(t => t && t.channel === 'care_team' && t.client_id === client.id)
      .filter(t => user
        ? (msg.threadVisibility(user, t, { client, isPoa }).visible && msg.canPostToThread(user, t, { client, isPoa }).allowed)
        : true)
      .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
    return threads[0] || null;
  }

  // A new Care Team thread when the patient has none: the patient, their POA
  // and the whole care team, as the composer does when nobody is unticked.
  async function newCareTeamThread({ user, client, isPoa, sender, startedByName, at }) {
    const users = await getUsers();
    if (user) {
      const availability = msg.channelAvailability('care_team', { user, client, users, isPoa });
      if (!availability.available) return { refused: availability.code };
    }
    const audience = msg.audienceFor('care_team', { user, client, users, isPoa }) || [];
    const thread = {
      id: uuidv4(), channel: 'care_team', client_id: client.id, client_name: client.name,
      subject: 'Care Team',
      participant_ids: [...new Set([...(user ? [user.id] : []), client.id, ...audience.map(m => m.id)])],
      audience_chosen: false,
      started_by: user ? user.id : null,
      started_by_name: startedByName || (sender && sender.displayName) || 'GFC office',
      started_by_role: sender ? sender.fromRole : msg.ROLE.ADMIN,
      status: 'open', response_status: null, escalation_event_id: null,
      created_at: at, last_message_at: at, last_message_preview: '',
      started_by_text: true
    };
    const threads = await readRows('message_threads');
    threads.push(thread);
    await db.set('message_threads', threads);
    return { thread };
  }

  async function appendTextMessage(thread, message) {
    const all = await readRows('messages');
    all.push(message);
    await db.set('messages', all);
    const threads = await readRows('message_threads');
    const t = threads.find(x => x && x.id === thread.id);
    if (t) {
      t.last_message_at = message.sent_at;
      t.last_message_preview = msg.previewOf(message.body, 'plain', []);
      if (message.from_user_id && !t.participant_ids.includes(message.from_user_id)) t.participant_ids.push(message.from_user_id);
      await db.set('message_threads', threads);
    }
    return t || thread;
  }

  const textBody = (ev) => {
    const words = String(ev.body || '').trim().slice(0, msg.MAX_BODY || 4000);
    const pics = ev.mediaCount > 0
      ? (ev.mediaCount === 1 ? '[A picture was sent by text. It is in the office line\'s Quo inbox.]' : `[${ev.mediaCount} pictures were sent by text. They are in the office line's Quo inbox.]`)
      : '';
    return [words, pics].filter(Boolean).join('\n');
  };

  // Which patient a number belongs to. One patient, or nothing: a number two
  // patients share is never guessed between.
  function resolveTexter(phone, users) {
    const hits = quoSms.matchPhone(phone, users);
    if (!hits.length) return { outcome: 'unknown_number' };
    const clientIds = [...new Set(hits.map(h => h.client.id))];
    if (clientIds.length > 1) return { outcome: 'ambiguous_number' };
    // Patient and POA on one number: it is the patient's phone.
    return { hit: hits.find(h => !h.isPoa) || hits[0] };
  }

  // A reply from a POA who is POA for SEVERAL patients (familyLinks.js) names
  // one person and more than one patient. It goes to the patient whose
  // conversation we last texted that person about, within a week: that is the
  // conversation they are answering. With no such text it stays ambiguous and
  // is never guessed. Two DIFFERENT people on one number are never resolved
  // this way.
  const REPLY_CONTEXT_MS = 7 * 24 * 3600 * 1000;
  async function resolveTextReply(phone, users) {
    const who = resolveTexter(phone, users);
    if (who.hit || who.outcome !== 'ambiguous_number') return who;
    const hits = quoSms.matchPhone(phone, users);
    const people = [...new Set(hits.map(h => h.user.id))];
    if (people.length !== 1) return who;
    const since = Date.now() - REPLY_CONTEXT_MS;
    const last = (await readRows('sms_outbox'))
      .filter(r => r && r.user_id === people[0] && r.status === 'sent' && Date.parse(r.sent_at || r.created_at) >= since && hits.some(h => h.client.id === r.client_id))
      .sort((a, b) => String(b.sent_at || b.created_at).localeCompare(String(a.sent_at || a.created_at)))[0];
    if (!last) return who;
    return { hit: hits.find(h => h.client.id === last.client_id) };
  }

  // ==========================================================================
  // Calls on the office line become calls waiting to be documented (owner,
  // 2026-10-19). Only an ANSWERED call with a number that belongs to one
  // patient (theirs, or a designated POA's); a missed call, a voicemail, a
  // number nobody has or two patients share is recorded as handled and goes
  // no further, never guessed. Quo sends the AI summary as a second event; it
  // fills in whichever half arrived first. Nothing reaches OpenEMR from here:
  // a clinician writes and signs the note (chartCommunications.js).
  // ==========================================================================
  async function handleQuoCall(evt) {
    const ev = chartComms.readCallEvent(evt);
    if (!ev) return { outcome: 'ignored' };
    const key = `call:${ev.type}:${ev.callId}`;
    const events = await readRows('sms_events');
    if (events.some(e => e && e.key === key)) return { outcome: 'duplicate' };
    const record = async (outcome, extra = {}) => {
      const list = await readRows('sms_events');
      list.push({ id: uuidv4(), key, quo_call_id: ev.callId, kind: 'call', outcome, at: nowIso(), ...extra });
      await db.set('sms_events', list);
      return { outcome, ...extra };
    };
    const calls = await readRows('phone_calls');
    const i = calls.findIndex(c => c && c.quo_call_id === ev.callId);
    // The summary and the transcript come as their own events, before or
    // after the call itself. One that comes first is kept on a placeholder
    // row (`pending_summary`) until the call arrives.
    if (ev.type === 'call.summary.completed' || ev.type === 'call.transcript.completed') {
      const isSummary = ev.type === 'call.summary.completed';
      const merge = (row) => (isSummary ? chartComms.mergeSummary(row, ev) : chartComms.mergeTranscript(row, ev));
      if (i === -1) {
        calls.push(merge({ id: uuidv4(), quo_call_id: ev.callId, pending_summary: true, summary: [], next_steps: [], transcript: [], created_at: nowIso(), updated_at: nowIso() }));
        await db.set('phone_calls', calls);
        return record(isSummary ? 'summary_waiting' : 'transcript_waiting');
      }
      calls[i] = merge(calls[i]);
      await db.set('phone_calls', calls);
      return record(isSummary ? 'summary_added' : 'transcript_added', { callRowId: calls[i].id });
    }
    if (ev.officePhone !== quoSms.fromNumber()) return record('other_line');
    if (!ev.answered) return record('not_answered');
    const who = resolveTexter(ev.patientPhone, await getUsers());
    if (!who.hit) {
      if (i !== -1 && calls[i].pending_summary) { calls.splice(i, 1); await db.set('phone_calls', calls); }
      return record(who.outcome);
    }
    const row = chartComms.buildCallRow({ id: i !== -1 ? calls[i].id : uuidv4(), ev, hit: who.hit, at: nowIso() });
    if (i !== -1 && calls[i].pending_summary) {
      row.summary = calls[i].summary || []; row.next_steps = calls[i].next_steps || []; row.transcript = calls[i].transcript || [];
      calls[i] = row;
    } else if (i !== -1) {
      return record('duplicate_call');
    } else {
      calls.push(row);
    }
    await db.set('phone_calls', calls);
    await logActivity('quo-webhook', 'Quo', 'phone_call_recorded', 'client', row.client_id,
      { callRowId: row.id, direction: row.direction, withPoa: row.with_poa, durationSec: row.duration_sec });
    return record('call_waiting', { clientId: row.client_id, callRowId: row.id });
  }

  async function handleQuoEvent(evt) {
    if (evt && /^call\./.test(String(evt.type || ''))) return handleQuoCall(evt);
    const ev = quoSms.readEvent(evt);
    if (!ev || !ev.id) return { outcome: 'ignored' };
    if (ev.officePhone !== quoSms.fromNumber()) return { outcome: 'other_line' };

    const events = await readRows('sms_events');
    const key = `${ev.direction}:${ev.id}`;
    if (events.some(e => e && e.key === key)) return { outcome: 'duplicate' };
    const record = async (outcome, extra = {}) => {
      const list = await readRows('sms_events');
      list.push({ id: uuidv4(), key, quo_message_id: ev.id, direction: ev.direction, outcome, at: nowIso(), ...extra });
      await db.set('sms_events', list);
      return { outcome, ...extra };
    };

    const users = await getUsers();
    if (ev.direction === 'incoming') {
      const kw = quoSms.keyword(ev.body);
      if (kw === 'stop' || kw === 'start') {
        // A POA for two patients matches twice; their opt-out is one setting.
        const hits = quoSms.matchPhone(ev.patientPhone, users).filter((h, i, all) => all.findIndex(x => x.user.id === h.user.id) === i);
        let changed = 0;
        for (const h of hits) {
          const u = users.find(x => x.id === h.user.id);
          if (!u) continue;
          if (kw === 'stop') { u.smsOptIn = { ...(u.smsOptIn || {}), enabled: false, stoppedAt: nowIso(), changedBy: 'text STOP' }; changed++; }
          // START turns texts back on only for someone who had turned them on
          // themselves before; it never opts in a number on its own.
          else if (u.smsOptIn && u.smsOptIn.optedInAt) { u.smsOptIn = { ...u.smsOptIn, enabled: true, stoppedAt: null, changedBy: 'text START' }; changed++; }
        }
        if (changed) {
          await db.set('users', users);
          if (typeof deps.invalidateUsersCache === 'function') deps.invalidateUsersCache();
          for (const h of hits) {
            await logActivity(h.user.id, h.user.name || 'texter', kw === 'stop' ? 'sms_opted_out' : 'sms_opted_in', 'user', h.user.id, { by: 'text', clientId: h.client.id });
          }
        }
        return record(kw === 'stop' ? 'opted_out' : 'opted_in', { changed });
      }
      const who = await resolveTextReply(ev.patientPhone, users);
      if (!who.hit) return record(who.outcome);
      const { user, client, isPoa } = who.hit;
      const sender = msg.senderIdentity(user, { client, isPoa });
      let thread = await careTeamThreadFor(user, client, isPoa);
      if (!thread) {
        const made = await newCareTeamThread({ user, client, isPoa, sender, at: ev.at });
        if (made.refused) return record('no_care_team', { clientId: client.id });
        thread = made.thread;
      }
      const message = {
        id: uuidv4(), thread_id: thread.id, client_id: client.id, channel: 'care_team',
        from_user_id: sender.fromUserId, from_role: sender.fromRole, from_name: sender.fromName,
        display_name: sender.displayName, acting_for: sender.actingFor,
        body: textBody(ev), body_format: 'plain', attachments: [],
        sent_at: ev.at, read_by: [user.id], via: 'sms', quo_message_id: ev.id
      };
      const saved = await appendTextMessage(thread, message);
      await logActivity(user.id, sender.fromName, 'message_sent', 'message', message.id,
        { threadId: thread.id, channel: 'care_team', clientId: client.id, role: sender.fromRole, actingFor: sender.actingFor, via: 'sms' });
      await notifyThread(saved, message, user.id);
      return record('recorded', { clientId: client.id, threadId: thread.id, messageId: message.id });
    }

    // Outgoing: one of our own sends, or a reply typed in the Quo app.
    const box = await readRows('sms_outbox');
    const tenMin = Date.now() - 10 * 60 * 1000;
    const ours = box.some(r => r && ((r.quo_message_id && r.quo_message_id === ev.id) ||
      (r.to === ev.patientPhone && r.content.trim() === ev.body.trim() && Date.parse(r.sent_at || r.created_at) >= tenMin)));
    if (ours) return record('own_send');
    const who = resolveTexter(ev.patientPhone, users);
    if (!who.hit) return record(who.outcome);
    const { user, client, isPoa } = who.hit;
    let thread = await careTeamThreadFor(user, client, isPoa);
    if (!thread) {
      const made = await newCareTeamThread({ user: null, client, isPoa, sender: null, startedByName: 'GFC office (by text)', at: ev.at });
      thread = made.thread;
    }
    const message = {
      id: uuidv4(), thread_id: thread.id, client_id: client.id, channel: 'care_team',
      from_user_id: null, from_role: msg.ROLE.ADMIN, from_name: 'GFC office',
      display_name: `GFC office (by text to ${user.name || 'the patient'})`, acting_for: null,
      body: textBody(ev), body_format: 'plain', attachments: [],
      sent_at: ev.at, read_by: [], via: 'sms', quo_message_id: ev.id, quo_user_id: ev.quoUserId
    };
    const saved = await appendTextMessage(thread, message);
    await logActivity(null, 'GFC office (Quo)', 'message_sent', 'message', message.id,
      { threadId: thread.id, channel: 'care_team', clientId: client.id, via: 'sms', quoUserId: ev.quoUserId });
    await notifyThread(saved, message, null, { skipClientSide: true });
    return record('recorded_office_text', { clientId: client.id, threadId: thread.id, messageId: message.id });
  }

  // Quo's webhook. The raw body is kept by express.raw() in server.js, because
  // the signature is over the exact bytes Quo sent. Anything unsigned or badly
  // signed is refused and nothing is read from it. Quo is answered 200 for
  // anything it signed, even an event we do not use, so it does not retry.
  router.post('/api/webhooks/quo', async (req, res) => {
    try {
      const secret = process.env.QUO_WEBHOOK_SECRET;
      const header = req.headers['openphone-signature'] || req.headers['quo-signature'];
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      if (!secret) return res.status(503).json({ error: 'Texting is not set up.', code: 'SMS_NOT_CONFIGURED' });
      if (!quoSms.verifySignature(raw, header, secret)) return res.status(401).json({ error: 'bad signature' });
      let evt;
      try { evt = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'bad body' }); }
      const result = await handleQuoEvent(evt);
      res.json({ received: true, outcome: result.outcome });
    } catch (error) {
      console.error('[SMS] webhook error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Notification — the EXISTING queue, never a second one
  // ==========================================================================
  async function notifyThread(thread, message, senderId, opts = {}) {
    const users = await getUsers();
    const label = msg.threadTitle(thread);
    const channel = msg.channelById(thread.channel);
    const recipients = new Set(thread.participant_ids || []);
    // A POA designated AFTER the thread began, or a clinician's own POA
    // recipients, are read fresh: the participant list on the row is a snapshot.
    if (channel && channel.includesPoa && !thread.audience_chosen) {
      const client = users.find(x => x && x.id === thread.client_id && x.role === ROLES.CLIENT);
      if (client) poaIdsFor(users, client).forEach(id => recipients.add(id));
    }
    for (const id of recipients) {
      if (id === senderId) continue;
      const u = users.find(x => x && x.id === id);
      if (!u || !u.email) continue;
      // Admin sees Direct threads but is not emailed about them (owner, 2026-10-15).
      if (thread.channel === 'direct_care' && u.role === ROLES.ADMIN) continue;
      // A family member who is no longer the client's designated POA was on the
      // row when it began; the gate that hides the thread from them must also
      // stop the email.
      if (thread.channel === 'care_team' && u.role === ROLES.FAMILY) {
        const owner = users.find(x => x && x.id === thread.client_id && x.role === ROLES.CLIENT);
        if (!owner || !poaIdsFor(users, owner).includes(u.id)) continue;
      }
      // A PATIENT OR THEIR FAMILY IS TOLD IN A PHI-FREE SENTENCE, ON EVERY
      // CHANNEL. This used to be wired to `care_team` alone, so on the other
      // four channels a client is a participant of — Support, Clinical
      // Escalation, Admin Direct, Care Coordination — the patient received the
      // STAFF notice instead: a subject reading "Clinical Escalation — Ada
      // Bell" and a body telling Ada that somebody "sent you a message about
      // Ada Bell". Three things wrong with that and the channel was only one:
      // it talks about the reader in the third person, it puts their name and
      // the nature of the conversation in a subject line anyone glancing at the
      // inbox can read, and it was not marked as PHI so it would send on a
      // transport outside the BAA.
      //
      // The wording names no channel either. "A clinical escalation about you"
      // is not news to break by email, and the portal is one click away.
      const fromStaff = ![msg.ROLE.CLIENT, msg.ROLE.FAMILY, 'POA'].includes(message.from_role);
      const clientSide = u.role === ROLES.CLIENT || u.role === ROLES.FAMILY;
      // A text typed in the Quo app already reached the patient; it is only
      // being recorded, so the patient side is not told again.
      if (clientSide && opts.skipClientSide) continue;
      if (clientSide) {
        // Care Team only: the message itself, by text, to a patient or POA who
        // turned texts on (owner, 2026-10-15). Best-effort: a texting failure
        // never fails the send, and the email below still goes.
        if (thread.channel === 'care_team') {
          try { await textMessageTo(u, thread, message); }
          catch (e) { console.error('[SMS] could not queue a text:', e.message); }
        }
        await queueNotification('message_received', u.id, u.email, u.name,
          {
            subject: fromStaff ? 'A new message from your care team' : 'A new message in your conversation',
            body: (fromStaff ? 'Your care team has sent you a message.' : 'There is a new message in your conversation.')
              + ' Sign in to your portal to read it. For privacy we do not put messages in email.',
            // A family member may be linked to several patients and opens one
            // at a time (familyLinks.js): their button names which, by record
            // id, so it lands on THIS conversation's patient.
            ctaUrl: u.role === ROLES.FAMILY && thread.client_id
              ? `${links.PATHS.PORTAL}?for=${encodeURIComponent(thread.client_id)}#messages`
              : links.PATHS.PORTAL_MESSAGES,
            ctaLabel: 'Open your messages'
          },
          { relatedEntityId: message.id, relatedEntityType: 'message', createdBy: senderId });
        continue;
      }
      // A STAFF RECIPIENT. The wording, the detail level and the PHI marking
      // are the notifier's; WHO is on the thread stays here, because that is
      // thread visibility and belongs with the matrix. `messagesFor(u)` is
      // resolved per recipient: messaging mounts on four surfaces, and a single
      // `/portal` once sent caregivers, clinicians, case managers and admins to
      // the CLIENT's portal.
      const notice = notifier();
      if (notice) {
        await notice.staffMessageWaiting({
          user: u,
          clientName: thread.client_name || null,
          channelLabel: label || null,
          senderName: message.display_name || null,
          messageId: message.id,
          ctaUrl: links.messagesFor(u),
          actorId: senderId
        });
      }
    }
  }

  // ==========================================================================
  // Migrate Session 3.5's interim store
  // 3.5 shipped a minimal client→admin send into `gfc_messages`. Those rows are
  // real messages real people sent, so they are MIGRATED, not dropped — one
  // Support thread per client, messages in order.
  //
  // Idempotent by marker: a second run is a no-op, because a migration that can
  // double-run will, and duplicated messages are worse than none. The interim
  // send itself is removed in a SEPARATE commit after this path is proven, per
  // the brief — never both at once, or a failure has nothing to fall back to.
  // ==========================================================================
  async function migrateInterimMessages() {
    const legacy = await readRows('gfc_messages');
    if (!legacy.length) return { migrated: 0, skipped: 'no legacy rows' };

    const threads = await readRows('message_threads');
    const all = await readRows('messages');
    const already = new Set(all.filter(m => m && m.migrated_from).map(m => m.migrated_from));

    const users = await getUsers();
    const byClient = new Map();
    let migrated = 0;

    for (const row of legacy.slice().sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)))) {
      if (!row || !row.client_id || already.has(row.id)) continue;
      const client = users.find(u => u.id === row.client_id && u.role === ROLES.CLIENT);
      if (!client) continue;

      let thread = byClient.get(client.id)
        || threads.find(t => t && t.client_id === client.id && t.channel === 'support' && t.migrated_from_interim);
      if (!thread) {
        thread = {
          id: uuidv4(), channel: 'support', client_id: client.id, client_name: client.name,
          subject: 'Support', participant_ids: [client.id].concat(users.filter(u => u.role === ROLES.ADMIN).map(u => u.id)),
          started_by: client.id, started_by_name: row.fromName || client.name, started_by_role: 'client',
          status: 'open', response_status: null, escalation_event_id: null,
          created_at: row.sentAt || nowIso(), last_message_at: row.sentAt || nowIso(),
          last_message_preview: String(row.body || '').slice(0, 120),
          migrated_from_interim: true
        };
        threads.push(thread);
      }
      byClient.set(client.id, thread);

      all.push({
        id: uuidv4(), thread_id: thread.id, client_id: client.id, channel: 'support',
        from_user_id: row.fromUserId || client.id,
        from_role: row.fromRole === 'POA' ? 'POA' : (row.direction === 'in' ? 'admin' : 'client'),
        from_name: row.fromName || client.name,
        display_name: row.fromRole === 'POA' && row.fromName
          ? `${row.fromName} as POA for ${client.name}`
          : (row.fromName || client.name),
        acting_for: row.actingFor || null,
        body: String(row.body || ''),
        sent_at: row.sentAt || nowIso(),
        read_by: row.readAt ? [client.id] : [],
        migrated_from: row.id
      });
      thread.last_message_at = row.sentAt || thread.last_message_at;
      thread.last_message_preview = String(row.body || '').slice(0, 120);
      migrated += 1;
    }

    if (migrated) {
      await db.set('message_threads', threads);
      await db.set('messages', all);
    }
    return { migrated, threads: byClient.size };
  }

  // Exposed so the probe and a boot hook can drive it; nothing calls it
  // implicitly on require, because a migration that runs itself on import runs
  // in every test too.
  router.migrateInterimMessages = migrateInterimMessages;

  router.post('/api/messaging/admin/migrate-interim', authenticateToken, async (req, res) => {
    try {
      if (req.user.role !== ROLES.ADMIN) {
        return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_ONLY' });
      }
      const result = await migrateInterimMessages();
      await logActivity(req.user.id, req.user.name || req.user.email, 'interim_messages_migrated', 'message', null, result);
      res.json(result);
    } catch (error) {
      console.error('Interim message migration error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // For server.js (the every-minute outbox sweep) and the probes.
  router.sms = { drainSmsOutbox, handleQuoEvent, sendOutboxRow };
  return router;
};
