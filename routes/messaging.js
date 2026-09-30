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

module.exports = function createMessagingRoutes(deps) {
  const { db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4,
    upload, uploadLimiter, googledrive, detectFileType, contentDisposition } = deps;
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
    return !!(fresh && fresh.familyIsPoa && fresh.familyOfClientId === client.id);
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
    if (wants.includes(msg.ROLE.CASE_MANAGER)) add(msg.assignedCaseManagerId(client));
    if (wants.includes(msg.ROLE.FAMILY) && client) {
      users.filter(u => u.role === ROLES.FAMILY && u.familyOfClientId === client.id).forEach(u => add(u.id));
    }
    if (wants.includes(msg.ROLE.ADMIN)) {
      users.filter(u => u.role === ROLES.ADMIN).forEach(u => add(u.id));
    }
    // A POA is client-equivalent, so on a channel that names the client they are
    // on it too — otherwise they could read it and never be told it existed.
    if (channel && channel.includesPoa && client) poaIdsFor(users, client).forEach(add);
    return [...ids];
  };

  // The client's designated POAs, from the FRESH user list.
  const poaIdsFor = (users, client) => users
    .filter(u => u && u.role === ROLES.FAMILY && u.familyIsPoa && u.familyOfClientId === client.id)
    .map(u => u.id);

  const publicThread = (t, me) => ({
    id: t.id,
    channel: t.channel,
    channelLabel: msg.threadTitle(t),
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
    fromRoleLabel: msg.ROLE_LABELS[m.from_role] || m.from_role,
    isPoa: m.from_role === 'POA',
    actingFor: m.acting_for || null,
    body: m.body,
    // Absent on a message written before formatting existed: that one is PLAIN
    // TEXT and must never be run through the formatter.
    format: m.body_format === 'markup' ? 'markup' : 'plain',
    attachments: (m.attachments || []).map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
    sentAt: m.sent_at,
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
        const up = await googledrive.uploadMessageAttachmentFile(client.name || 'Client', `msg_${Date.now()}_${uuidv4().slice(0, 8)}_${name}`, f.buffer, f.__mime);
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
      res.json({ threads: visible.slice(0, 200) });
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

      const post = msg.canPostToThread(req.user, thread, { client, isPoa });

      await logActivity(req.user.id, req.user.name || req.user.email, 'message_thread_read', 'message_thread', thread.id,
        { role: msg.actorRole(req.user), channel: thread.channel, clientId: thread.client_id });

      res.json({
        thread: publicThread(thread, 0),
        messages: rows.map(m => ({ ...publicMessage(m), mine: m.from_user_id === req.user.id })),
        canPost: post.allowed,
        cannotPostReason: post.allowed ? null : post.reason,
        cannotPostCode: post.allowed ? null : post.code
      });
    } catch (error) {
      console.error('Messaging thread read error:', error);
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
        client_id: client.id,
        client_name: client.name,
        subject: String(body.subject || channel.label).trim().slice(0, 140),
        participant_ids: await participantsFor(channelId, { user: req.user, client }),
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

      const message = {
        id: uuidv4(),
        thread_id: threadId,
        client_id: client.id,
        channel: channelId,
        from_user_id: sender.fromUserId,
        from_role: sender.fromRole,
        from_name: sender.fromName,
        display_name: sender.displayName,
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
        { channel: channelId, clientId: client.id, role: sender.fromRole, actingFor: sender.actingFor });

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

      const post = msg.canPostToThread(req.user, thread, { client, isPoa });
      if (!post.allowed) return res.status(403).json({ error: post.reason, code: post.code });

      const files = req.files || [];
      const { valid, errors, clean } = msg.validateMessage(req.body, { attachmentCount: files.length });
      if (!valid) return res.status(400).json({ error: errors[0].message, code: errors[0].code, errors });
      const stored = await storeAttachments(client, files);
      if (stored.error) return res.status(stored.error.status).json(stored.error.body);
      const attachments = stored.attachments;
      filed = attachments;

      const sender = msg.senderIdentity(req.user, { client, isPoa });
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
  // Notification — the EXISTING queue, never a second one
  // ==========================================================================
  async function notifyThread(thread, message, senderId) {
    const users = await getUsers();
    const label = msg.threadTitle(thread);
    const channel = msg.channelById(thread.channel);
    const recipients = new Set(thread.participant_ids || []);
    // A POA designated AFTER the thread began, or a clinician's own POA
    // recipients, are read fresh: the participant list on the row is a snapshot.
    if (channel && channel.includesPoa) {
      const client = users.find(x => x && x.id === thread.client_id && x.role === ROLES.CLIENT);
      if (client) poaIdsFor(users, client).forEach(id => recipients.add(id));
    }
    for (const id of recipients) {
      if (id === senderId) continue;
      const u = users.find(x => x && x.id === id);
      if (!u || !u.email) continue;
      // A family member who is no longer the client's designated POA was on the
      // row when it began; the gate that hides the thread from them must also
      // stop the email.
      if (thread.channel === 'care_team' && u.role === ROLES.FAMILY) {
        const owner = users.find(x => x && x.id === thread.client_id && x.role === ROLES.CLIENT);
        if (!owner || !poaIdsFor(users, owner).includes(u.id)) continue;
      }
      // The patient side of a Care Team conversation is told in a PHI-free
      // sentence that points at the Messages tab of their portal: no client
      // name, no clinician name, no words from the message.
      const fromCareTeam = ![msg.ROLE.CLIENT, msg.ROLE.FAMILY, 'POA'].includes(message.from_role);
      const clientSide = thread.channel === 'care_team' && (u.role === ROLES.CLIENT || u.role === ROLES.FAMILY);
      if (clientSide) {
        await queueNotification('message_received', u.id, u.email, u.name,
          {
            subject: fromCareTeam ? 'You have a new message from your care team' : 'There is a new message in your care team conversation',
            body: (fromCareTeam ? 'You have a new message from your care team.' : 'There is a new message in your care team conversation.')
              + ' Sign in to your portal to read it. For privacy we do not put messages in email.',
            ctaUrl: links.PATHS.PORTAL_MESSAGES, ctaLabel: 'Open your messages'
          },
          { relatedEntityId: message.id, relatedEntityType: 'message', createdBy: senderId });
        continue;
      }
      await queueNotification('message_received', u.id, u.email, u.name,
        {
          subject: `${label} — ${thread.client_name}`,
          // The BODY is deliberately not in the email. A notification that
          // carries the message carries PHI into an inbox; one that says a
          // message is waiting does not.
          // WHERE THIS PERSON READS MESSAGES, not where a client does.
          // Messaging mounts on four surfaces; this notice goes to whoever is
          // on the thread, so a single `/portal` sent caregivers, clinicians,
          // case managers and admins to the CLIENT's portal.
          body: `${message.display_name} sent you a message about ${thread.client_name}. Open the app to read it.`,
          ctaUrl: links.messagesFor(u), ctaLabel: 'Open messages'
        },
        { relatedEntityId: message.id, relatedEntityType: 'message', createdBy: senderId });
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

  return router;
};
