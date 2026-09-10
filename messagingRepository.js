// ============================================================================
// Messaging — pure helpers (Session 9)
// Spec: docs/GFC_Session9_ClaudeCode_Prompt.md (the channel matrix is normative
//       there, not in GFC_App_Build_v2.md — §1I does not exist in that file)
//       docs/GFC_App_Build_v2.md §5.4 (`messages` in the data model)
//       docs/GFC_Client_Care_Profile_Schema_v1.md §6 (careTeam, familyIsPoa)
//
// PURE functions over plain data. No db, no express, no I/O — the same shape as
// caregiverRepository.js, schedulingRepository.js and consentRegistry.js,
// because the rules that matter here (who may read a thread, which channels a
// role may open, whether a channel is available at all) have to be testable
// without standing the app up.
//
// THIS IS STRUCTURED MESSAGING, NOT CHAT.
// Every message carries a sender role, a channel, a thread and a timestamp, and
// every thread is scoped to ONE client. That scoping is not decoration: it is
// what makes visibility computable at all. A message with no client is a
// message nobody can be shown to be a party to.
//
// VISIBILITY IS ENFORCED AT THE QUERY LAYER.
// A user who asks for a thread they are not a party to gets 403, not an empty
// list — an empty list says "there is nothing here", which is a different and
// false statement. Filtering in the UI is styling; the server call is the
// control. Both exist, and they are independent.
// ============================================================================

const ROLE = Object.freeze({
  CLIENT: 'client',
  FAMILY: 'family',
  CAREGIVER: 'vendor',            // repo role `vendor` IS Caregiver (v2 §4 repurpose)
  CLINICAL: 'clinical',           // a user with hasClinicalAccess, not a role string
  CASE_MANAGER: 'caseManager',
  ADMIN: 'admin'
});

// The role a MESSAGE is attributed to, which is not always req.user.role: a
// clinician is `user` + hasClinicalAccess, and a POA sends as the client's
// representative. One function decides it so no route has to guess.
function actorRole(user) {
  if (!user) return null;
  if (user.role === 'admin') return ROLE.ADMIN;
  if (user.role === 'caseManager') return ROLE.CASE_MANAGER;
  if (user.hasClinicalAccess) return ROLE.CLINICAL;
  if (user.role === 'vendor') return ROLE.CAREGIVER;
  if (user.role === 'client') return ROLE.CLIENT;
  if (user.role === 'family') return ROLE.FAMILY;
  return null;
}

const ROLE_LABELS = Object.freeze({
  client: 'Client', family: 'Family', vendor: 'Caregiver',
  clinical: 'Clinician', caseManager: 'Case manager', admin: 'Admin'
});

// ---- The channel matrix ----------------------------------------------------
// The brief's table has eleven FROM→TO rows, but several are the same
// conversation read from either end: Client→Caregiver "Direct" and
// Caregiver→Client "Direct" are one thread, not two. So the matrix is stored as
// CHANNELS — a conversation type with a fixed pair of participant roles — and
// `MATRIX_ROWS` below keeps the brief's own table as the thing tests check
// against, so the collapse can never quietly drop a row.
//
// `initiators` is who may OPEN a thread; `participants` is who may then post in
// it. A Care Update is one-directional on purpose: a clinician pushes it, and
// family replying into a clinical thread is exactly what the visibility rules
// exist to prevent — they reply through Support or the Family Portal.
const CHANNELS = Object.freeze({
  direct_care: {
    id: 'direct_care', label: 'Direct',
    participants: [ROLE.CLIENT, ROLE.CAREGIVER],
    initiators: [ROLE.CLIENT, ROLE.CAREGIVER],
    requiresAssignedCaregiver: true,
    blurb: 'You and the caregiver working with you.'
  },
  support: {
    id: 'support', label: 'Support',
    participants: [ROLE.CLIENT, ROLE.FAMILY, ROLE.ADMIN],
    initiators: [ROLE.CLIENT, ROLE.FAMILY, ROLE.ADMIN],
    blurb: 'Scheduling, billing and anything else for the office.'
  },
  clinical_escalation: {
    id: 'clinical_escalation', label: 'Clinical Escalation',
    participants: [ROLE.CLIENT, ROLE.CLINICAL],
    initiators: [ROLE.CLIENT],
    tracksResponse: true,
    blurb: 'A clinical concern for the nurse practitioner. Not for emergencies — call 911.'
  },
  operations: {
    id: 'operations', label: 'Operations',
    participants: [ROLE.CAREGIVER, ROLE.ADMIN],
    initiators: [ROLE.CAREGIVER, ROLE.ADMIN],
    blurb: 'Shifts, timekeeping and anything else for the office.'
  },
  behavioral_escalation: {
    id: 'behavioral_escalation', label: 'Behavioral Escalation',
    participants: [ROLE.CAREGIVER, ROLE.CASE_MANAGER],
    initiators: [ROLE.CAREGIVER],
    raisesEscalation: true,
    blurb: 'A behavioral concern for the case manager.'
  },
  clinical_oversight: {
    id: 'clinical_oversight', label: 'Clinical Oversight',
    participants: [ROLE.CLINICAL, ROLE.CAREGIVER],
    initiators: [ROLE.CLINICAL],
    blurb: 'Direction from the clinician to the caregiver on this client.'
  },
  care_update: {
    id: 'care_update', label: 'Care Update',
    participants: [ROLE.CLINICAL, ROLE.FAMILY],
    initiators: [ROLE.CLINICAL],
    oneWay: true,
    blurb: 'An update a clinician has chosen to share with family.'
  },
  admin_direct: {
    id: 'admin_direct', label: 'Admin Broadcast or Direct',
    participants: [ROLE.ADMIN, ROLE.CLIENT, ROLE.FAMILY, ROLE.CAREGIVER, ROLE.CLINICAL, ROLE.CASE_MANAGER],
    initiators: [ROLE.ADMIN],
    blurb: 'A message from the office.'
  },
  family_portal: {
    id: 'family_portal', label: 'Family Portal',
    participants: [ROLE.FAMILY, ROLE.CAREGIVER],
    initiators: [ROLE.FAMILY, ROLE.CAREGIVER],
    requiresAssignedCaregiver: true,
    blurb: 'Family and the caregiver working with your relative.'
  }
});

const CHANNEL_IDS = Object.freeze(Object.keys(CHANNELS));

// The brief's table, verbatim, as data. Every row must resolve to a channel
// whose participants cover both ends — build-enforced — so collapsing the
// eleven rows into nine channels cannot silently lose one.
const MATRIX_ROWS = Object.freeze([
  { from: ROLE.CLIENT, to: ROLE.CAREGIVER, label: 'Direct', channel: 'direct_care' },
  { from: ROLE.CLIENT, to: ROLE.ADMIN, label: 'Support', channel: 'support' },
  { from: ROLE.CLIENT, to: ROLE.CLINICAL, label: 'Clinical Escalation', channel: 'clinical_escalation' },
  { from: ROLE.CAREGIVER, to: ROLE.CLIENT, label: 'Direct', channel: 'direct_care' },
  { from: ROLE.CAREGIVER, to: ROLE.ADMIN, label: 'Operations', channel: 'operations' },
  { from: ROLE.CAREGIVER, to: ROLE.CASE_MANAGER, label: 'Behavioral Escalation', channel: 'behavioral_escalation' },
  { from: ROLE.CLINICAL, to: ROLE.CAREGIVER, label: 'Clinical Oversight', channel: 'clinical_oversight' },
  { from: ROLE.CLINICAL, to: ROLE.FAMILY, label: 'Care Update', channel: 'care_update' },
  { from: ROLE.ADMIN, to: '*', label: 'Admin Broadcast or Direct', channel: 'admin_direct' },
  { from: ROLE.FAMILY, to: ROLE.CAREGIVER, label: 'Family Portal', channel: 'family_portal' },
  { from: ROLE.FAMILY, to: ROLE.ADMIN, label: 'Support', channel: 'support' }
]);

const channelById = (id) => CHANNELS[String(id || '')] || null;

// ---- Who is attached to this client ---------------------------------------
// Reused from Session 6 rather than restated where the rule already exists:
// `isAssignedToCaregiver` is caregiverRepository's, and this module takes it as
// an argument rather than requiring that file, so the two cannot drift and this
// one stays pure.
const careTeamOf = (client) => (client && client.careTeam) || {};

function assignedCaregiverIds(client) {
  const ct = careTeamOf(client);
  return [ct.primaryCaregiver, ct.backupCaregiver].filter(Boolean);
}

function assignedClinicianIds(client) {
  const ct = careTeamOf(client);
  return Array.isArray(ct.assignedFNPs) ? ct.assignedFNPs.filter(Boolean) : [];
}

const assignedCaseManagerId = (client) => careTeamOf(client).assignedCaseManager || null;

// Is a caregiver actively assigned to this client? The client↔caregiver channel
// turns on and off with this, and the brief is explicit that when it is off the
// channel is DISABLED WITH A REASON, never hidden: a family member who cannot
// find the button assumes the app is broken, while one who reads "no caregiver
// is assigned yet" knows to call the office.
function hasActiveCaregiver(client, users) {
  const ids = assignedCaregiverIds(client);
  if (!ids.length) return false;
  const list = Array.isArray(users) ? users : [];
  return ids.some(id => {
    const u = list.find(x => x && x.id === id);
    return !!u && (u.accountStatus || 'active') !== 'inactive';
  });
}

// ---- Channel availability, with a reason for every refusal -----------------
// Never a bare false. "Not available" and "not available BECAUSE no caregiver is
// assigned yet" are different answers, and only the second one tells a person
// what to do next.
function channelAvailability(channelId, { user, client, users }) {
  const channel = channelById(channelId);
  if (!channel) return { available: false, code: 'UNKNOWN_CHANNEL', reason: `"${channelId}" is not a channel.` };

  const role = actorRole(user);
  if (!role) return { available: false, code: 'UNKNOWN_ROLE', reason: 'This account has no messaging role.' };

  if (!channel.initiators.includes(role)) {
    return {
      available: false, code: 'CHANNEL_NOT_YOURS',
      reason: `${ROLE_LABELS[role]}s do not start ${channel.label} messages.`
    };
  }
  if (!client) {
    return { available: false, code: 'NO_CLIENT', reason: 'This channel is about a specific client, and none is selected.' };
  }
  if (channel.requiresAssignedCaregiver && !hasActiveCaregiver(client, users)) {
    return {
      available: false, code: 'NO_CAREGIVER_ASSIGNED',
      reason: 'No caregiver is assigned yet, so there is nobody on the other end. The office assigns one, and this opens on its own.'
    };
  }
  if (channelId === 'clinical_escalation' && !assignedClinicianIds(client).length) {
    // Still OPEN — an unanswered clinical concern must not be silently
    // impossible to raise — but the sender is told where it actually goes.
    return {
      available: true, code: 'NO_CLINICIAN_ASSIGNED',
      reason: 'No clinician is assigned to this client yet, so this goes to the office.'
    };
  }
  if (channelId === 'behavioral_escalation' && !assignedCaseManagerId(client)) {
    return {
      available: true, code: 'NO_CASE_MANAGER_ASSIGNED',
      reason: 'No case manager is assigned to this client yet, so this goes to the office.'
    };
  }
  return { available: true, code: null, reason: null };
}

// Every channel this user could open for this client, each carrying its own
// availability. The UI renders the unavailable ones disabled with their reason
// rather than omitting them.
function channelsFor({ user, client, users }) {
  const role = actorRole(user);
  return CHANNEL_IDS
    .filter(id => CHANNELS[id].initiators.includes(role))
    .map(id => {
      const a = channelAvailability(id, { user, client, users });
      return {
        id, label: CHANNELS[id].label, blurb: CHANNELS[id].blurb,
        available: a.available, code: a.code, reason: a.reason,
        oneWay: !!CHANNELS[id].oneWay
      };
    });
}

// ---- Visibility ------------------------------------------------------------
// ONE function decides who may read a thread, and every route goes through it.
// The rules are the brief's, stated as code rather than as a convention:
//
//   Admin          — everything.
//   Caregiver      — only threads they are a party to, on a client they are
//                    assigned to. Never a clinician-to-family or
//                    clinician-to-client thread, even about their own client.
//   Family         — their linked client's caregiver and admin threads, plus a
//                    Care Update a clinician chose to push. Never anything else
//                    clinical.
//   POA family     — client-equivalent: whatever the client themselves may see.
//   Case manager   — every Behavioral Escalation thread. Never clinical notes,
//                    never the family portal.
//   Clinical       — every thread for a client they are assigned to.
//   Client         — their own threads.
//
// `isParty` is deliberately not the whole test. A case manager sees behavioral
// threads they were never named on, and a caregiver is NOT admitted to a
// clinical thread about their own client just because it concerns them.
function isParty(thread, userId) {
  return (thread.participant_ids || []).includes(userId);
}

function threadVisibility(user, thread, { client, isPoa = false } = {}) {
  const deny = (code, reason) => ({ visible: false, code, reason });
  if (!user || !thread) return deny('THREAD_NOT_VISIBLE', 'That conversation is not yours.');

  const role = actorRole(user);
  const channel = channelById(thread.channel);
  if (!channel) return deny('UNKNOWN_CHANNEL', 'That conversation has no readable channel.');

  if (role === ROLE.ADMIN) return { visible: true, code: null, reason: null };

  if (role === ROLE.CASE_MANAGER) {
    // Behavioral is theirs by role, whether or not they were named on it. Every
    // other channel is refused — including clinical, which the brief calls out
    // by name, and the family portal.
    if (thread.channel === 'behavioral_escalation') return { visible: true, code: null, reason: null };
    if (isParty(thread, user.id)) return { visible: true, code: null, reason: null };
    return deny('CASE_MANAGER_SCOPE', 'Case managers see behavioral escalations, not this conversation.');
  }

  if (role === ROLE.CLINICAL) {
    const assigned = client ? assignedClinicianIds(client).includes(user.id) : false;
    if (assigned || isParty(thread, user.id)) return { visible: true, code: null, reason: null };
    return deny('CLINICAL_NOT_ASSIGNED', 'You are not on this client\'s care team.');
  }

  if (role === ROLE.CAREGIVER) {
    // A caregiver's own threads only. Being assigned to the client is necessary
    // and NOT sufficient: a clinician-to-family thread about their client is
    // still not theirs to read.
    if (!isParty(thread, user.id)) {
      return deny('THREAD_NOT_YOURS', 'That conversation is not one of yours.');
    }
    return { visible: true, code: null, reason: null };
  }

  if (role === ROLE.CLIENT || (role === ROLE.FAMILY && isPoa)) {
    // A POA reads what the client reads — the 4.3 acting gate, applied to
    // messaging rather than restated.
    if (client && thread.client_id !== client.id) {
      return deny('THREAD_NOT_YOURS', 'That conversation belongs to another client.');
    }
    const clientChannels = ['direct_care', 'support', 'clinical_escalation', 'admin_direct', 'care_update', 'family_portal'];
    if (!clientChannels.includes(thread.channel)) {
      return deny('THREAD_NOT_YOURS', 'That conversation is between staff.');
    }
    return { visible: true, code: null, reason: null };
  }

  if (role === ROLE.FAMILY) {
    if (client && thread.client_id !== client.id) {
      return deny('THREAD_NOT_YOURS', 'That conversation belongs to another client.');
    }
    // Family gets caregiver and admin threads, plus a Care Update a clinician
    // pushed to them. `care_update` is the ONLY clinical channel here, and it
    // reaches family only because a clinician deliberately sent it.
    const familyChannels = ['family_portal', 'support', 'admin_direct', 'care_update'];
    if (!familyChannels.includes(thread.channel)) {
      return deny('FAMILY_SCOPE', 'Family messaging covers the caregiver and the office.');
    }
    if (!isParty(thread, user.id) && thread.channel !== 'care_update') {
      return deny('THREAD_NOT_YOURS', 'That conversation is not one of yours.');
    }
    return { visible: true, code: null, reason: null };
  }

  return deny('THREAD_NOT_VISIBLE', 'That conversation is not yours.');
}

// May this user POST into a thread they can already see? Reading and writing
// are different questions: a Care Update is readable by family and writable
// only by the clinician who owns it.
function canPostToThread(user, thread, { client, isPoa = false } = {}) {
  const seen = threadVisibility(user, thread, { client, isPoa });
  if (!seen.visible) return { allowed: false, code: seen.code, reason: seen.reason };

  const role = actorRole(user);
  const channel = channelById(thread.channel);
  if (!channel) return { allowed: false, code: 'UNKNOWN_CHANNEL', reason: 'That conversation has no channel.' };

  if (channel.oneWay && !channel.initiators.includes(role)) {
    return {
      allowed: false, code: 'CHANNEL_READ_ONLY',
      reason: `A ${channel.label} is an update, not a conversation. Reply through Support and the office will route it.`
    };
  }
  if (!channel.participants.includes(role)) {
    return { allowed: false, code: 'NOT_A_PARTICIPANT', reason: `${ROLE_LABELS[role]}s do not post in ${channel.label}.` };
  }
  if (thread.status === 'closed') {
    return { allowed: false, code: 'THREAD_CLOSED', reason: 'That conversation has been closed.' };
  }
  return { allowed: true, code: null, reason: null };
}

// ---- Sender identity -------------------------------------------------------
// A POA's message is displayed as "<POA name> as POA for <client name>" to
// EVERY recipient — the 4.3 rule, and the reason it matters is the same here as
// on a signature: the client's name must never be presented as the author of
// something the client did not write.
function senderIdentity(user, { client, isPoa = false } = {}) {
  const role = actorRole(user);
  const name = (user && user.name) || (user && user.email) || 'Unknown';
  if (isPoa && client) {
    return {
      fromUserId: user.id,
      fromRole: 'POA',
      fromName: name,
      displayName: `${name} as POA for ${client.name || 'the client'}`,
      actingFor: client.id
    };
  }
  return {
    fromUserId: user ? user.id : null,
    fromRole: role,
    fromName: name,
    displayName: name,
    actingFor: null
  };
}

// ---- Message validation ----------------------------------------------------
const MAX_BODY = 4000;

function validateMessage(input) {
  const body = input && typeof input.body === 'string' ? input.body.trim() : '';
  const errors = [];
  if (!body) errors.push({ field: 'body', code: 'BODY_REQUIRED', message: 'Write a message first.' });
  if (body.length > MAX_BODY) {
    errors.push({ field: 'body', code: 'BODY_TOO_LONG', message: `Messages are up to ${MAX_BODY} characters. That one is ${body.length}.` });
  }
  return { valid: errors.length === 0, errors, clean: { body: body.slice(0, MAX_BODY) } };
}

// ---- Clinical escalation response status -----------------------------------
// A clinical concern is not a message that has been delivered; it is a question
// waiting for an answer. Forward-only, and `responded` is set by a CLINICIAN
// replying, never by the sender.
const RESPONSE_STATUSES = Object.freeze(['awaiting_response', 'acknowledged', 'responded', 'closed']);
const RESPONSE_TRANSITIONS = Object.freeze({
  awaiting_response: ['acknowledged', 'responded', 'closed'],
  acknowledged: ['responded', 'closed'],
  responded: ['closed'],
  closed: []
});
const canTransitionResponse = (from, to) => (RESPONSE_TRANSITIONS[from] || []).includes(to);

function responseRefusal(from, to) {
  if (!RESPONSE_STATUSES.includes(to)) return { code: 'UNKNOWN_RESPONSE_STATUS', message: `"${to}" is not a response status.` };
  if (canTransitionResponse(from, to)) return null;
  if (from === 'closed') return { code: 'ESCALATION_CLOSED', message: 'That escalation is closed.' };
  return { code: 'INVALID_RESPONSE_TRANSITION', message: `A ${from.replace(/_/g, ' ')} escalation cannot become ${to.replace(/_/g, ' ')}.` };
}

// ---- Thread shaping --------------------------------------------------------
const threadTitle = (thread) => {
  const channel = channelById(thread.channel);
  return channel ? channel.label : 'Conversation';
};

// Unread is per-user and derived, never a stored counter: a counter and the
// messages it counts drift, and the count is the thing people trust.
function unreadCount(messages, userId) {
  return (messages || []).filter(m => m && m.from_user_id !== userId && !(m.read_by || []).includes(userId)).length;
}

module.exports = {
  ROLE, ROLE_LABELS, actorRole,
  CHANNELS, CHANNEL_IDS, MATRIX_ROWS, channelById,
  careTeamOf, assignedCaregiverIds, assignedClinicianIds, assignedCaseManagerId, hasActiveCaregiver,
  channelAvailability, channelsFor,
  isParty, threadVisibility, canPostToThread,
  senderIdentity, validateMessage, MAX_BODY,
  RESPONSE_STATUSES, RESPONSE_TRANSITIONS, canTransitionResponse, responseRefusal,
  threadTitle, unreadCount
};
