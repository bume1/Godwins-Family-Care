// ============================================================================
// GODWINS FAMILY CARE — Care Team messages by text, through Quo.
//
// Owner, 2026-10-15: "quo has baa we signed. I want the messages bi
// directional." The office line (Quo inbox "Godwins Family Care Main",
// the ORG phone) sends a Care Team message to the patient and their POA as a
// text, and a text back lands in the patient's Care Team thread. A reply typed
// in the Quo app on that line is recorded in the thread too, so the record is
// whole whichever app someone answered in.
//
// This file is the pure half (phone numbers, wording, quiet hours, keywords,
// the webhook signature) plus a small Quo API client. Who is texted and where
// a reply lands live in routes/messaging.js, beside the thread rules.
//
// Rules:
//  - Nothing is sent until QUO_API_KEY is set. Nothing inbound is accepted
//    until QUO_WEBHOOK_SECRET is set and the signature checks.
//  - A person is texted only after they turn texts on themselves (opt-in on
//    their own record), and STOP turns it off.
//  - No text leaves between 9pm and 8am Eastern; it waits until 8am.
//  - Attachments are never sent by text, only a note that one is waiting.
// ============================================================================
'use strict';

const crypto = require('crypto');
const gfcTime = require('./public/gfc-time.js');
const { ORG } = require('./public/consent-text.js');
const nf = require('./public/note-format.js');

const QUIET_START = 21 * 60;   // 9pm Eastern
const QUIET_END = 8 * 60;      // 8am Eastern
const MAX_TEXT_BODY = 1200;    // the message part; long messages say "continued in your portal"
const SIGNATURE_TOLERANCE_MS = 10 * 60 * 1000;

// ---- Phone numbers ---------------------------------------------------------
// US numbers only, as Quo sends them: +1XXXXXXXXXX. Anything that is not ten
// digits (after a leading 1) is not a number we can text, and returns null
// rather than a guess.
function toE164(raw) {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d)) return null;
  return '+1' + d;
}
const prettyPhone = (e164) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(e164 || '');
};

// The office line the texts come from. ORG.phone is the number already printed
// on every consent, so a patient sees the same number they were given.
const fromNumber = () => toE164(process.env.QUO_FROM_NUMBER || ORG.phone);

function status() {
  const missing = [];
  if (!process.env.QUO_API_KEY) missing.push('QUO_API_KEY');
  if (!fromNumber()) missing.push('QUO_FROM_NUMBER');
  return {
    sending: missing.length === 0,
    receiving: !!process.env.QUO_WEBHOOK_SECRET,
    from: fromNumber(),
    missing: missing.concat(process.env.QUO_WEBHOOK_SECRET ? [] : ['QUO_WEBHOOK_SECRET'])
  };
}

// ---- Who a number belongs to -----------------------------------------------
// The patient's own number (their intake phone, or the one on their record) and
// the number of each designated POA (owner, 2026-10-15: "make sure both patient
// and POA phone numbers are recognized as being connected to the patient").
// Plain family are not: they are not on Care Team messages.
const phonesForClient = (client) => [client && client.intake && client.intake.phone, client && client.phone]
  .map(toE164).filter(Boolean);
const phoneForUser = (user, client) => {
  if (!user) return null;
  if (user.role === 'client') return phonesForClient(client || user)[0] || null;
  return toE164(user.phone);
};

// Every patient-side person a number names: [{ user, client, isPoa }].
// Inactive accounts never match. Two people can share one number (a couple on
// one landline), so the caller decides what to do with more than one.
function matchPhone(e164, users) {
  const want = toE164(e164);
  if (!want) return [];
  const list = (Array.isArray(users) ? users : []).filter(u => u && (u.accountStatus || 'active') !== 'inactive');
  const clients = new Map(list.filter(u => u.role === 'client').map(u => [u.id, u]));
  const out = [];
  for (const c of clients.values()) {
    if (phonesForClient(c).includes(want)) out.push({ user: c, client: c, isPoa: false });
  }
  for (const u of list) {
    if (u.role !== 'family' || !u.familyIsPoa) continue;
    const c = clients.get(u.familyOfClientId);
    if (c && toE164(u.phone) === want) out.push({ user: u, client: c, isPoa: true });
  }
  return out;
}

// ---- Opt-in ------------------------------------------------------------------
const textsOn = (user) => !!(user && user.smsOptIn && user.smsOptIn.enabled);

// ---- The wording -------------------------------------------------------------
// The message itself (the BAA covers it), as plain text, from the person who
// wrote it. A file is named as waiting, never sent. The first text a person
// gets says how to stop, as carriers require.
function outgoingText({ senderName, body, format, attachmentCount = 0, portalUrl, first = false }) {
  let text = format === 'markup' ? nf.toPlainText(String(body || '')) : String(body || '');
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let cut = false;
  if (text.length > MAX_TEXT_BODY) { text = text.slice(0, MAX_TEXT_BODY).replace(/\s+\S*$/, '') + '…'; cut = true; }
  const lines = [`Godwins Family Care, from ${senderName || 'your care team'}:`];
  if (text) lines.push(text);
  if (cut) lines.push('(The rest is in your portal.)');
  if (attachmentCount > 0) lines.push(attachmentCount === 1 ? '(1 file is waiting in your portal.)' : `(${attachmentCount} files are waiting in your portal.)`);
  lines.push(`Reply to this text, or open your portal: ${portalUrl}`);
  if (first) lines.push('Reply STOP to stop texts.');
  return lines.join('\n');
}

// ---- Quiet hours ---------------------------------------------------------------
// Returns null when a text may go now, else the ISO instant it may go (8am
// Eastern, today or tomorrow). Eastern is measured, not assumed (daylight time).
function quietUntil(now = new Date()) {
  const p = gfcTime.zonedParts(now);
  if (!p) return null;
  const m = p.minutesOfDay;
  if (m >= QUIET_END && m < QUIET_START) return null;
  let day = p.isoDate;
  if (m >= QUIET_START) {
    const next = new Date(Date.parse(`${p.isoDate}T12:00:00Z`) + 24 * 3600 * 1000);
    day = next.toISOString().slice(0, 10);
  }
  return gfcTime.instantFromZoned(day, '08:00');
}

// ---- Keywords ------------------------------------------------------------------
// Carrier-standard words. A keyword is the whole text, never a word inside one:
// "please stop the evening visits" is a message, not an opt-out.
function keyword(body) {
  const w = String(body || '').trim().toUpperCase().replace(/[.!]+$/, '');
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'].includes(w)) return 'stop';
  if (['START', 'UNSTOP', 'YES'].includes(w)) return 'start';
  if (w === 'HELP' || w === 'INFO') return 'help';
  return null;
}

// ---- Webhook signature -----------------------------------------------------------
// Quo (formerly OpenPhone) signs each webhook: header
//   openphone-signature: hmac;1;<timestamp ms>;<base64 HMAC-SHA256>
// over `${timestamp}.${raw body}`, keyed with the base64-decoded signing secret.
// A stale timestamp is refused so a captured request cannot be replayed later.
function verifySignature(rawBody, header, secret, now = Date.now()) {
  if (!secret || !header || rawBody === undefined || rawBody === null) return false;
  const parts = String(header).split(';');
  if (parts.length !== 4 || parts[0] !== 'hmac' || parts[1] !== '1') return false;
  const ts = parts[2];
  const given = parts[3];
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > SIGNATURE_TOLERANCE_MS) return false;
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const key = Buffer.from(String(secret), 'base64');
  const want = crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(ts + '.', 'utf8'), raw])).digest('base64');
  const a = Buffer.from(want);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- The Quo API -------------------------------------------------------------------
// One call: send a text from the office line. The key is sent as Quo expects
// (the bare key in Authorization). Returns Quo's message id, which is how the
// webhook for our own send is recognised and not recorded twice.
function createClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const base = () => (process.env.QUO_API_BASE || 'https://api.openphone.com/v1').replace(/\/+$/, '');
  async function sendText({ to, content }) {
    const key = process.env.QUO_API_KEY;
    const from = fromNumber();
    if (!key || !from) { const e = new Error('Texting is not set up (QUO_API_KEY).'); e.code = 'SMS_NOT_CONFIGURED'; throw e; }
    const res = await doFetch(`${base()}/messages`, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], content })
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const e = new Error(`Quo refused the text (${res.status})${data && data.message ? ': ' + data.message : ''}`);
      e.status = res.status;
      throw e;
    }
    return { id: (data && data.data && data.data.id) || (data && data.id) || null };
  }
  return { sendText };
}

// ---- Reading a webhook ---------------------------------------------------------------
// Only text messages on the office line. `direction` says who sent it.
function readEvent(evt) {
  const type = evt && evt.type;
  const m = evt && evt.data && evt.data.object;
  if (!m || (type !== 'message.received' && type !== 'message.delivered')) return null;
  const to = Array.isArray(m.to) ? m.to : [m.to];
  const incoming = m.direction === 'incoming' || type === 'message.received';
  return {
    type,
    id: m.id || null,
    direction: incoming ? 'incoming' : 'outgoing',
    patientPhone: toE164(incoming ? m.from : to[0]),
    officePhone: toE164(incoming ? to[0] : m.from),
    body: String(m.body || m.text || m.content || ''),
    mediaCount: Array.isArray(m.media) ? m.media.length : 0,
    quoUserId: m.userId || null,
    at: m.createdAt || evt.createdAt || new Date().toISOString()
  };
}

module.exports = {
  QUIET_START, QUIET_END, MAX_TEXT_BODY,
  toE164, prettyPhone, fromNumber, status,
  phonesForClient, phoneForUser, matchPhone, textsOn,
  outgoingText, quietUntil, keyword, verifySignature, createClient, readEvent
};
