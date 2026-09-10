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
// NOT A CHAT SERVER. No attachments, no read receipts beyond a per-user read
// mark, no typing indicators, no realtime push — out of scope by the brief. It
// rides the EXISTING notification queue; there is not a second one.
// ============================================================================

const express = require('express');
const msg = require('../messagingRepository');

module.exports = function createMessagingRoutes(deps) {
  const { db, config, logActivity, queueNotification, getUsers, authenticateToken, uuidv4 } = deps;
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
    return [...ids];
  };

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
    sentAt: m.sent_at,
    mine: false
  });

  // ==========================================================================
  // Channels a user may open, for a given client
  // ==========================================================================
  router.get('/api/messaging/channels', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const client = await resolveClient(req.user, req.query.clientId);
      const users = await getUsers();
      res.json({
        role: msg.actorRole(req.user),
        client: client ? { id: client.id, name: client.name } : null,
        channels: msg.channelsFor({ user: req.user, client, users })
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
  router.post('/api/messaging/threads', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const body = req.body || {};
      const channelId = String(body.channel || '');
      const channel = msg.channelById(channelId);
      if (!channel) {
        return res.status(400).json({ error: `"${channelId}" is not a channel.`, code: 'UNKNOWN_CHANNEL', channels: msg.CHANNEL_IDS });
      }

      const client = await resolveClient(req.user, body.clientId);
      const users = await getUsers();
      const availability = msg.channelAvailability(channelId, { user: req.user, client, users });
      if (!availability.available) {
        return res.status(403).json({ error: availability.reason, code: availability.code });
      }

      const { valid, errors, clean } = msg.validateMessage(body);
      if (!valid) return res.status(400).json({ error: errors[0].message, code: errors[0].code, errors });

      const isPoa = await isActingPoa(req.user, client);
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
        response_status: channel.tracksResponse ? 'awaiting_response' : null,
        escalation_event_id: null,
        created_at: at,
        last_message_at: at,
        last_message_preview: clean.body.slice(0, 120)
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
        sent_at: at,
        read_by: [req.user.id]
      };

      // A behavioral escalation becomes an event in SESSION 6'S store, in
      // Session 6's shape, so the case manager has one inbox rather than two.
      if (channel.raisesEscalation) {
        thread.escalation_event_id = await raiseBehavioralEscalation({
          actor: req.user, sender, client, text: clean.body, threadId, at
        });
      }

      const threads = await readRows('message_threads');
      threads.push(thread);
      await db.set('message_threads', threads);
      const all = await readRows('messages');
      all.push(message);
      await db.set('messages', all);

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
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Reply
  // ==========================================================================
  router.post('/api/messaging/threads/:id/messages', authenticateToken, requireMessagingRole, async (req, res) => {
    try {
      const opened = await openThread(req, req.params.id);
      if (opened.error) return res.status(opened.error.status).json(opened.error.body);
      const { thread, client, isPoa } = opened;

      const post = msg.canPostToThread(req.user, thread, { client, isPoa });
      if (!post.allowed) return res.status(403).json({ error: post.reason, code: post.code });

      const { valid, errors, clean } = msg.validateMessage(req.body);
      if (!valid) return res.status(400).json({ error: errors[0].message, code: errors[0].code, errors });

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
        sent_at: at,
        read_by: [req.user.id]
      };

      const all = await readRows('messages');
      all.push(message);
      await db.set('messages', all);

      const threads = await readRows('message_threads');
      const idx = threads.findIndex(t => t && t.id === thread.id);
      threads[idx].last_message_at = at;
      threads[idx].last_message_preview = clean.body.slice(0, 120);
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
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Clinical escalation response status — clinician or admin, forward-only
  // ==========================================================================
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
    for (const id of thread.participant_ids || []) {
      if (id === senderId) continue;
      const u = users.find(x => x && x.id === id);
      if (!u || !u.email) continue;
      await queueNotification('message_received', u.id, u.email, u.name,
        {
          subject: `${label} — ${thread.client_name}`,
          // The BODY is deliberately not in the email. A notification that
          // carries the message carries PHI into an inbox; one that says a
          // message is waiting does not.
          body: `${message.display_name} sent you a message about ${thread.client_name}. Open the portal to read it.`,
          ctaUrl: '/portal', ctaLabel: 'Open messages'
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
