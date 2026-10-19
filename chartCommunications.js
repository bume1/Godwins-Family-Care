// ============================================================================
// GODWINS FAMILY CARE — calls and messages in the patient's chart.
//
// Owner, 2026-10-19: "calls and messages being automatically added to the
// patient chart as a message note and call note." Agreed the same day:
//
//  - MESSAGE NOTES. Only conversations the patient or their family are on
//    (messagingRepository.isPatientFacing): a Care Update, a Care Team message
//    with the patient on it, a clinical escalation. Internal team notes stay
//    out of the record. ONE note per conversation (owner, 2026-10-19: "one
//    note updated with messaging details per convo"), kept up to date as the
//    conversation goes on, not one note per message or per day.
//
//    A message note is DERIVED from the messages, never a second copy kept in
//    step by hand: an edit or a super admin's delete shows in it at once. What
//    is stored is only the FILING — that the conversation was filed to
//    OpenEMR, by whom, and a hash of what was filed. OpenEMR cannot replace a
//    document, so a conversation that grew or changed after it was filed is
//    filed again as an UPDATED copy holding the whole conversation: the newest
//    copy in the chart is always complete.
//
//  - CALL NOTES. A call on the office line (Quo) with a patient's or a
//    designated POA's phone becomes a call waiting to be documented. The
//    clinician opens it as a Phone Call note already filled in with who, when,
//    how long and Quo's own summary, edits it and signs it. Nothing is filed to
//    OpenEMR without that signature: a signed note is what bills and what is
//    the legal record. A call that was not about care (a scheduling call) is
//    dismissed with a reason.
//
//  - CALL NOTES (the record). Every answered call with a patient or POA also
//    becomes a call note on the chart by itself (owner, 2026-10-19: "all call
//    summary / transcript for patient or poa becomes a note"): who, when, how
//    long, Quo's summary and next steps, and the full transcript. It is a
//    record of the conversation, like a message note, and files to OpenEMR
//    the same way. The billable Phone Call note above stays the clinician's.
//
// This file is pure: no I/O. The webhook, the routes and the chart call it.
// ============================================================================
'use strict';

const crypto = require('crypto');
const nf = require('./public/note-format.js');
const gfcTime = require('./public/gfc-time.js');
const quoSms = require('./quoSms');
const msg = require('./messagingRepository');

// ---- Calls -------------------------------------------------------------------

const CALL_STATUS = Object.freeze({
  WAITING: 'waiting',        // answered, not yet written up
  STARTED: 'started',        // a clinician opened it as a note, not yet saved
  DOCUMENTED: 'documented',  // the note was saved (its encounter is named)
  DISMISSED: 'dismissed'     // not about care; a reason is kept
});
const PHONE_NOTE_TYPE = 'pc_phone_ccm';
const MAX_SUMMARY_ITEMS = 20;
const MAX_ITEM_CHARS = 600;
const MAX_TRANSCRIPT_LINES = 600;
const MAX_TRANSCRIPT_LINE = 2000;
// A call note files once the transcript is in, or this long after the call
// if none comes (Quo transcripts off, or a very short call).
const CALL_NOTE_WAIT_MS = 2 * 60 * 60 * 1000;

const iso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const firstOf = (v) => (Array.isArray(v) ? v[0] : v);
const cleanList = (v) => (Array.isArray(v) ? v : (v ? [v] : []))
  .map(x => String((x && (x.text || x.content)) || x || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS))
  .filter(Boolean).slice(0, MAX_SUMMARY_ITEMS);

// Quo's call webhooks (formerly OpenPhone): `call.completed` when a call ends,
// and `call.summary.completed` later with its AI summary. Read leniently — a
// field Quo renames must not turn a real call into nothing — but a call is
// only ever matched on the office line and a number we can read.
function readCallEvent(evt) {
  const type = evt && evt.type;
  const o = evt && evt.data && evt.data.object;
  if (!o) return null;
  if (type === 'call.summary.completed') {
    const callId = o.callId || o.call_id || o.id || null;
    if (!callId) return null;
    return { type, callId: String(callId), summary: cleanList(o.summary), nextSteps: cleanList(o.nextSteps || o.next_steps) };
  }
  if (type === 'call.transcript.completed') {
    const callId = o.callId || o.call_id || o.id || null;
    if (!callId) return null;
    const lines = (Array.isArray(o.dialogue) ? o.dialogue : [])
      .map(d => ({
        speaker: quoSms.toE164(d && (d.identifier || d.from)) || null,
        quoUserId: (d && d.userId) || null,
        start: Number.isFinite(Number(d && d.start)) ? Number(d.start) : null,
        text: String((d && (d.content || d.text)) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPT_LINE)
      }))
      .filter(l => l.text)
      .slice(0, MAX_TRANSCRIPT_LINES);
    return { type, callId: String(callId), transcript: lines };
  }
  if (type !== 'call.completed') return null;
  if (!o.id) return null;
  const incoming = o.direction === 'incoming';
  const from = firstOf(o.from);
  const to = firstOf(o.to);
  const answeredAt = iso(o.answeredAt);
  const completedAt = iso(o.completedAt) || iso(evt.createdAt);
  let durationSec = Number.isFinite(Number(o.duration)) && o.duration !== null && o.duration !== '' ? Math.max(0, Math.round(Number(o.duration))) : null;
  if (durationSec === null && answeredAt && completedAt) {
    durationSec = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(answeredAt)) / 1000));
  }
  const status = String(o.status || '').toLowerCase();
  return {
    type,
    callId: String(o.id),
    direction: incoming ? 'incoming' : 'outgoing',
    patientPhone: quoSms.toE164(incoming ? from : to),
    officePhone: quoSms.toE164(incoming ? to : from),
    // A call nobody picked up, a voicemail or a missed call is not a
    // conversation to document. Answered means someone was on the line.
    answered: !!answeredAt && (durationSec === null || durationSec > 0) && !['missed', 'no-answer', 'busy', 'failed', 'canceled'].includes(status),
    startedAt: answeredAt || iso(o.createdAt) || completedAt,
    completedAt,
    durationSec,
    quoUserId: o.userId || null
  };
}

// Minutes for the note, rounded UP: a 61-second call is two minutes on the
// phone, and care management is billed on time.
const callMinutes = (sec) => (Number.isFinite(sec) && sec > 0 ? Math.ceil(sec / 60) : null);

// A new call row from a matched call.completed. `hit` is matchPhone's answer:
// the patient or POA whose number it was, and the patient it belongs to.
function buildCallRow({ id, ev, hit, at }) {
  return {
    id,
    quo_call_id: ev.callId,
    client_id: hit.client.id,
    with_user_id: hit.user.id,
    with_name: hit.user.name || null,
    with_poa: !!hit.isPoa,
    direction: ev.direction,
    patient_phone: ev.patientPhone,
    started_at: ev.startedAt,
    completed_at: ev.completedAt,
    duration_sec: ev.durationSec,
    quo_user_id: ev.quoUserId,
    summary: [],
    next_steps: [],
    status: CALL_STATUS.WAITING,
    created_at: at,
    updated_at: at
  };
}

// The summary can arrive before or after the call itself; whichever lands
// second fills in the other half.
function mergeSummary(row, ev) {
  return { ...row, summary: ev.summary, next_steps: ev.nextSteps, summary_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

function mergeTranscript(row, ev) {
  return { ...row, transcript: ev.transcript, transcript_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

// Who the call was with, in words: "Juanita Guess" or "Luka Agent (POA for
// Juanita Guess)".
const withWhom = (row, clientName) => (row.with_poa
  ? `${row.with_name || 'the POA'} (POA for ${clientName || 'the patient'})`
  : (row.with_name || clientName || 'the patient'));

// The Phone Call note, filled in. It is the CLINICIAN's note: everything here
// is a starting point they read and change before signing, and the summary is
// labelled as the phone system's, never presented as their own words.
function callNotePrefill(row, { clientName } = {}) {
  const mins = callMinutes(row.duration_sec);
  const when = row.started_at ? gfcTime.fmtDateTime(row.started_at) : 'time not recorded';
  const lines = [
    `**Phone call** ${row.direction === 'incoming' ? 'from' : 'to'} ${withWhom(row, clientName)} on ${when}.`,
    mins ? `**Time on the call:** ${mins} minute${mins === 1 ? '' : 's'} (from the phone system).` : '**Time on the call:** not recorded by the phone system.'
  ];
  if ((row.summary || []).length) {
    lines.push('', '## Summary from the phone system (check before signing)');
    row.summary.forEach(s => lines.push('- ' + escapeMarkup(s)));
  }
  if ((row.next_steps || []).length) {
    lines.push('', '## Next steps from the phone system');
    row.next_steps.forEach(s => lines.push('- ' + escapeMarkup(s)));
  }
  lines.push('', '_The full call note, with the transcript, is on the chart Timeline._');
  lines.push('', '## Assessment and plan', '');
  return lines.join('\n');
}
// Text from Quo goes in as TEXT: a "*" or "_" in it is never a format.
const escapeMarkup = (s) => nf.serializeRuns([{ text: String(s) }]);

// What a call row says about itself on the chart and in the inbox. No summary
// text here: the inbox is a list of things to do, not a second copy of the call.
function callDetail(row, clientName) {
  const mins = callMinutes(row.duration_sec);
  return `${row.direction === 'incoming' ? 'Incoming' : 'Outgoing'} call with ${withWhom(row, clientName)}` +
    (mins ? `, ${mins} min` : '') + ((row.summary || []).length ? '. Phone system summary attached.' : '.');
}

// Public shape of a call row for the clinical pages.
const publicCall = (row, clientName) => ({
  id: row.id,
  clientId: row.client_id,
  direction: row.direction,
  withName: withWhom(row, clientName),
  withPoa: !!row.with_poa,
  startedAt: row.started_at,
  minutes: callMinutes(row.duration_sec),
  hasSummary: (row.summary || []).length > 0,
  status: row.status,
  encounterUuid: row.encounter_uuid || null,
  startedBy: row.started_by_name || null,
  dismissedReason: row.dismissed_reason || null,
  detail: callDetail(row, clientName)
});

// ---- Call notes (the record) ------------------------------------------------------

// A speaker in the transcript: the patient-side person when it is their number,
// otherwise the office.
const speakerName = (row, line, clientName) => {
  if (line.speaker && row.patient_phone && line.speaker === row.patient_phone) return withWhom(row, clientName);
  if (line.quoUserId || (line.speaker && line.speaker !== row.patient_phone)) return 'GFC staff';
  return 'Speaker';
};
const mmss = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '');

function callNoteText(row, { clientName, updated = false } = {}) {
  const mins = callMinutes(row.duration_sec);
  const lines = [
    `CALL NOTE${updated ? ' (UPDATED COPY)' : ''}`,
    `Patient: ${clientName || ''}`,
    `${row.direction === 'incoming' ? 'Incoming call from' : 'Outgoing call to'} ${withWhom(row, clientName)}`,
    `When: ${row.started_at ? gfcTime.fmtDateTime(row.started_at) : 'not recorded'}`,
    `Length: ${mins ? `${mins} minute${mins === 1 ? '' : 's'}` : 'not recorded'}`,
    ''
  ];
  lines.push('SUMMARY (from the phone system)');
  if ((row.summary || []).length) row.summary.forEach(s => lines.push('• ' + s));
  else lines.push('No summary from the phone system.');
  if ((row.next_steps || []).length) { lines.push('', 'NEXT STEPS (from the phone system)'); row.next_steps.forEach(s => lines.push('• ' + s)); }
  lines.push('', 'TRANSCRIPT (from the phone system)');
  if ((row.transcript || []).length) {
    row.transcript.forEach(l => lines.push(`${Number.isFinite(l.start) ? `[${mmss(l.start)}] ` : ''}${speakerName(row, l, clientName)}: ${l.text}`));
  } else lines.push('No transcript from the phone system.');
  if (row.status === CALL_STATUS.DOCUMENTED) lines.push('', 'A clinician documented this call in a Phone Call note on the chart.');
  if (row.status === CALL_STATUS.DISMISSED) lines.push('', 'Marked as not needing a clinical note.');
  lines.push('', 'Recorded automatically from the GFC office phone line.');
  return lines.join('\n');
}

// What a call note's filing hash covers: what the phone system said, never the
// workflow state, so documenting the call does not refile it.
const callNoteHash = (row) => crypto.createHash('sha256')
  .update(JSON.stringify([row.summary || [], row.next_steps || [], row.transcript || [], row.duration_sec || null])).digest('hex');

// A call note is ready to file once the transcript is in, or once enough time
// has passed that none is coming.
const callNoteReady = (row, now = Date.now()) => !!row && !row.pending_summary &&
  (((row.transcript || []).length > 0) || (Date.parse(row.completed_at || row.created_at || 0) + CALL_NOTE_WAIT_MS < now));

function callNotesToFile(rows, filings, now = Date.now()) {
  const last = new Map();
  for (const f of (filings || [])) {
    if (!f || !f.key) continue;
    const prev = last.get(f.key);
    if (!prev || String(f.filed_at) > String(prev.filed_at)) last.set(f.key, f);
  }
  return (rows || []).filter(r => callNoteReady(r, now))
    .map(r => ({ row: r, key: `call:${r.id}`, hash: callNoteHash(r), previous: last.get(`call:${r.id}`) || null }))
    .filter(x => !x.previous || x.previous.hash !== x.hash)
    .map(x => ({ ...x, updated: !!x.previous }));
}

// ---- Message notes ---------------------------------------------------------------

const easternDate = (v) => {
  const p = v ? gfcTime.zonedParts(new Date(v)) : null;
  return p ? p.isoDate : null;
};
const noteKey = (threadId) => `msg:${threadId}`;

const plainBody = (m) => {
  const t = m.body_format === 'markup' ? nf.toPlainText(String(m.body || '')) : String(m.body || '');
  return t.replace(/\r\n?/g, '\n').trim();
};
const fromLine = (m) => {
  const who = m.display_name || m.from_name || 'Unknown';
  if (m.from_role === 'POA') return who;   // already "<name> as POA for <client>"
  const label = m.from_role_label || msg.ROLE_LABELS[m.from_role] || null;
  return label ? `${who} (${label})` : who;
};

// Every message note for one patient: ONE per patient-facing conversation,
// holding every message in it. `today` is the Eastern date. A conversation
// with a message today is still OPEN and waits; once a day has passed with no
// new message it is filed, and filed again (updated) if it grows or changes.
function buildMessageNotes({ clientId, threads, messages, today }) {
  const mine = (threads || []).filter(t => t && String(t.client_id) === String(clientId) && msg.isPatientFacing(t));
  const byThread = new Map(mine.map(t => [t.id, t]));
  const groups = new Map();
  for (const m of (messages || [])) {
    if (!m || !byThread.has(m.thread_id) || !easternDate(m.sent_at)) continue;
    if (!groups.has(m.thread_id)) groups.set(m.thread_id, []);
    groups.get(m.thread_id).push(m);
  }
  const notes = [];
  for (const [threadId, list] of groups) {
    list.sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
    const t = byThread.get(threadId);
    const entries = list.map(m => ({
      id: m.id,
      at: m.sent_at,
      from: fromLine(m),
      via: m.via === 'sms' ? 'text' : (m.quo_message_id ? 'text' : 'portal'),
      text: plainBody(m),
      files: (m.attachments || []).map(a => a && a.name).filter(Boolean),
      edited: !!m.edited_at || (Array.isArray(m.edits) && m.edits.length > 0)
    }));
    const firstDate = easternDate(list[0].sent_at);
    const date = easternDate(list[list.length - 1].sent_at);
    notes.push({
      key: noteKey(threadId),
      clientId: String(clientId),
      threadId: t.id,
      channel: t.channel,
      channelLabel: (msg.channelById(t.channel) || {}).label || t.channel,
      title: msg.threadTitle(t),
      firstDate,
      date,
      closed: !!today && date < today,
      count: entries.length,
      entries,
      hash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    });
  }
  notes.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return notes;
}

// The note as a document: what is filed to OpenEMR and shown on the chart.
function messageNoteText(note, { clientName, updated = false } = {}) {
  const span = note.firstDate && note.firstDate !== note.date
    ? `${gfcTime.fmtDate(`${note.firstDate}T12:00:00Z`)} to ${gfcTime.fmtDate(`${note.date}T12:00:00Z`)}`
    : gfcTime.fmtDate(`${note.date}T12:00:00Z`);
  const lines = [
    `MESSAGE NOTE${updated ? ' (UPDATED COPY, replaces earlier copies)' : ''}`,
    `Patient: ${clientName || ''}`,
    `Conversation: ${note.channelLabel}${note.title && note.title !== note.channelLabel ? ` (${note.title})` : ''}`,
    `Dates: ${span}`,
    `Messages: ${note.count}`,
    ''
  ];
  for (const e of note.entries) {
    lines.push(`${gfcTime.fmtDateTime(e.at)} · ${e.from}${e.via === 'text' ? ' · by text' : ''}${e.edited ? ' · edited' : ''}`);
    if (e.text) lines.push(e.text);
    if (e.files.length) lines.push(`[Attached: ${e.files.join(', ')}]`);
    lines.push('');
  }
  lines.push('Recorded automatically from the GFC care platform messages.');
  return lines.join('\n');
}

// Which conversations still need filing: never filed, or grown or changed since
// the last filing, which files again as an updated copy.
function notesToFile(notes, filings) {
  const last = new Map();
  for (const f of (filings || [])) {
    if (!f || !f.key) continue;
    const prev = last.get(f.key);
    if (!prev || String(f.filed_at) > String(prev.filed_at)) last.set(f.key, f);
  }
  return (notes || []).filter(n => n.closed && n.count > 0)
    .map(n => ({ note: n, previous: last.get(n.key) || null }))
    .filter(x => !x.previous || x.previous.hash !== x.note.hash)
    .map(x => ({ ...x, updated: !!x.previous }));
}

const filingState = (note, filings) => {
  const mine = (filings || []).filter(f => f && f.key === note.key)
    .sort((a, b) => String(b.filed_at).localeCompare(String(a.filed_at)));
  if (!mine.length) return note.closed ? 'waiting' : 'open';
  return mine[0].hash === note.hash ? 'filed' : 'changed';
};

module.exports = {
  CALL_STATUS, PHONE_NOTE_TYPE,
  readCallEvent, callMinutes, buildCallRow, mergeSummary, mergeTranscript, callNotePrefill, callDetail, publicCall, withWhom,
  callNoteText, callNoteHash, callNoteReady, callNotesToFile, CALL_NOTE_WAIT_MS,
  easternDate, noteKey, buildMessageNotes, messageNoteText, notesToFile, filingState
};
