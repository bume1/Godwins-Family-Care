const crypto = require('crypto');
const { Resend } = require('resend');
const { google } = require('googleapis');
const config = require('./config');

// ===========================================================================
// EMAIL TRANSPORT
// ===========================================================================
// Two transports, and they are NOT interchangeable for compliance:
//
//   gmail   Google Workspace, sending as a mailbox on a GFC Workspace domain.
//           Covered by the Workspace BAA already in place (Drive + Gmail).
//           PHI may travel on it.
//
//   resend  A third-party relay with NO BAA. Useful, and it is what the app
//           shipped on, but nothing that is PHI may travel on it.
//
// The distinction is enforced, not documented: a message marked { phi: true }
// is REFUSED on a non-BAA transport rather than quietly downgraded. A silent
// downgrade is exactly how PHI leaves the boundary without anyone noticing,
// and this repo has already been bitten five times by a write that reported
// success and did nothing (soap_note, encounter PUT, documents, allergies,
// the 6B order name). The same rule applies here in the other direction: a
// send that cannot be made safely fails loudly instead of succeeding unsafely.
// ===========================================================================

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

let _resend = null;
let _gmail = null;
let _transportCache = null;

function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return null;
    _resend = new Resend(key);
  }
  return _resend;
}

// The Workspace service account, as JSON or base64-encoded JSON. Domain-wide
// delegation must be granted to it for the gmail.send scope, and GMAIL_SEND_AS
// must be a real mailbox it is allowed to impersonate.
function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw || !String(raw).trim()) return null;
  try {
    const text = String(raw).trim().startsWith('{')
      ? String(raw)
      : Buffer.from(String(raw).trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(text);
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch (e) {
    console.error('[EMAIL] GOOGLE_SERVICE_ACCOUNT_KEY is set but could not be parsed:', e.message);
    return null;
  }
}

function domainOf(address) {
  const at = String(address || '').lastIndexOf('@');
  return at === -1 ? '' : String(address).slice(at + 1).trim().toLowerCase();
}

// A BAA covers a Workspace DOMAIN, not "Google" in general. A personal
// @gmail.com mailbox is Google and is NOT under the GFC BAA, so it must never
// be accepted as a PHI-capable sender just because it is Gmail. This is the
// whole reason the check is on the domain rather than on the transport name.
function isBaaSender(address) {
  const d = domainOf(address);
  return !!d && config.EMAIL_BAA_DOMAINS.includes(d);
}

// Which transport is live, and whether PHI may ride on it. Every field here is
// observable — nothing reports a capability it cannot demonstrate.
function resolveTransport() {
  if (_transportCache) return _transportCache;

  const preference = config.EMAIL_TRANSPORT;      // 'auto' | 'gmail' | 'resend' | 'none'
  const sendAs = String(config.GMAIL_SEND_AS || '').trim();
  const serviceAccount = loadServiceAccount();
  const resendKey = !!process.env.RESEND_API_KEY;

  const gmailReasons = [];
  if (!serviceAccount) gmailReasons.push('GOOGLE_SERVICE_ACCOUNT_KEY is not set (or is not valid JSON)');
  if (!sendAs) gmailReasons.push('GMAIL_SEND_AS is not set');
  else if (!isBaaSender(sendAs)) {
    gmailReasons.push(
      `GMAIL_SEND_AS (${sendAs}) is not on a BAA-covered domain. ` +
      `Covered domains: ${config.EMAIL_BAA_DOMAINS.join(', ') || '(none configured)'}`
    );
  }
  const gmailReady = gmailReasons.length === 0;

  let name = 'none';
  let reason = '';
  if (preference === 'gmail') {
    name = gmailReady ? 'gmail' : 'none';
    if (!gmailReady) reason = `EMAIL_TRANSPORT=gmail but it is not configured: ${gmailReasons.join('; ')}`;
  } else if (preference === 'resend') {
    name = resendKey ? 'resend' : 'none';
    if (!resendKey) reason = 'EMAIL_TRANSPORT=resend but RESEND_API_KEY is not set';
  } else if (preference === 'none') {
    name = 'none';
    reason = 'EMAIL_TRANSPORT=none — sending is switched off';
  } else {
    // auto: prefer the BAA-covered transport whenever it is available.
    if (gmailReady) name = 'gmail';
    else if (resendKey) {
      name = 'resend';
      reason = `Gmail is not configured, so mail is going over Resend, which is NOT BAA-covered. ${gmailReasons.join('; ')}`;
    } else {
      name = 'none';
      reason = 'No email transport is configured (set GOOGLE_SERVICE_ACCOUNT_KEY + GMAIL_SEND_AS, or RESEND_API_KEY)';
    }
  }

  const fromAddress = name === 'gmail' ? sendAs : config.EMAIL_FROM_ADDRESS;

  _transportCache = Object.freeze({
    name,
    configured: name !== 'none',
    // PHI rides on a BAA-covered transport only. Resend is never one.
    baaCovered: name === 'gmail' && isBaaSender(fromAddress),
    fromAddress,
    fromName: config.EMAIL_FROM_NAME,
    reason,
    gmailReady,
    gmailBlockers: gmailReasons,
    resendConfigured: resendKey
  });
  return _transportCache;
}

// Exported so a boot log, an admin screen or a test can ask what is actually
// live rather than inferring it from a successful send.
function transportStatus() {
  const t = resolveTransport();
  return {
    transport: t.name,
    configured: t.configured,
    baaCovered: t.baaCovered,
    phiAllowed: t.baaCovered,
    from: t.configured ? `${t.fromName} <${t.fromAddress}>` : null,
    reason: t.reason || null,
    gmailBlockers: t.gmailBlockers
  };
}

// Tests and credential swaps need the next call to re-read the environment.
function resetTransportCache() {
  _transportCache = null;
  _gmail = null;
  _resend = null;
  _gmailOverride = null;
}

// Test seam. The Gmail dispatch path — MIME assembly, base64url encoding, the
// shape of the API call and the shape of the result — is provable without
// Workspace credentials only if a double can stand in for the client. Nothing
// in production calls this; `resetTransportCache()` clears it.
let _gmailOverride = null;
function _setGmailClientForTests(client) {
  _gmailOverride = client;
}

function getGmail() {
  if (_gmailOverride) return _gmailOverride;
  if (_gmail) return _gmail;
  const t = resolveTransport();
  if (t.name !== 'gmail') return null;
  const sa = loadServiceAccount();
  if (!sa) return null;
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: GMAIL_SCOPES,
    subject: t.fromAddress          // domain-wide delegation impersonates this mailbox
  });
  _gmail = google.gmail({ version: 'v1', auth });
  return _gmail;
}

// ---- MIME assembly --------------------------------------------------------
// The Gmail API takes a complete RFC 2822 message, so the app builds one. No
// nodemailer dependency is added for this: googleapis is already here.

// A header value can never carry a bare CR/LF. Subjects are rendered from
// templates that may contain client-supplied text, and a newline in a header
// is a header-injection primitive (an attacker-chosen Bcc, for instance).
function sanitizeHeader(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeaderValue(value) {
  const s = sanitizeHeader(value);
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function b64Lines(buf) {
  return Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(String(content || ''), 'base64');
}

function singlePart(contentType, buf, extraHeaders) {
  return {
    headers: [`Content-Type: ${contentType}`, 'Content-Transfer-Encoding: base64'].concat(extraHeaders || []),
    body: b64Lines(buf)
  };
}

function multipart(subtype, parts) {
  const boundary = `${subtype}_${crypto.randomBytes(12).toString('hex')}`;
  const body = parts
    .map(p => `--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body}\r\n`)
    .join('') + `--${boundary}--\r\n`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

function buildMimeMessage({ from, to, subject, text, html, attachments }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const atts = (Array.isArray(attachments) ? attachments : []).filter(a => a && a.filename && a.content);

  let root = singlePart('text/plain; charset="UTF-8"', Buffer.from(String(text || ''), 'utf8'));
  if (html) {
    root = multipart('alternative', [
      root,
      singlePart('text/html; charset="UTF-8"', Buffer.from(String(html), 'utf8'))
    ]);
  }
  if (atts.length) {
    root = multipart('mixed', [root].concat(atts.map(a => singlePart(
      a.contentType || 'application/octet-stream',
      toBuffer(a.content),
      [`Content-Disposition: attachment; filename="${sanitizeHeader(a.filename).replace(/"/g, '')}"`]
    ))));
  }

  const headers = [
    `From: ${sanitizeHeader(from)}`,
    `To: ${recipients.map(sanitizeHeader).join(', ')}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0'
  ].concat(root.headers);

  return `${headers.join('\r\n')}\r\n\r\n${root.body}`;
}

// ---- The send paths -------------------------------------------------------

async function sendViaGmail(payload) {
  const gmail = getGmail();
  if (!gmail) return { success: false, error: 'Gmail transport is not configured', transport: 'gmail' };
  const t = resolveTransport();
  const raw = buildMimeMessage({
    from: `${t.fromName} <${t.fromAddress}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: payload.attachments
  });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') }
  });
  return { success: true, id: (res && res.data && res.data.id) || null, transport: 'gmail' };
}

async function sendViaResend(payload) {
  const resend = getResend();
  if (!resend) return { success: false, error: 'Resend transport is not configured', transport: 'resend' };
  const t = resolveTransport();
  const body = {
    from: `${t.fromName} <${t.fromAddress}>`,
    to: Array.isArray(payload.to) ? payload.to : [payload.to],
    subject: payload.subject,
    text: payload.text
  };
  if (payload.html) body.html = payload.html;
  if (payload.attachments && payload.attachments.length) {
    body.attachments = payload.attachments.map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
    }));
  }
  const result = await resend.emails.send(body);
  return { success: true, id: (result && result.id) || null, transport: 'resend' };
}

// The one gate every send passes through. Returns null when the message may go.
function phiRefusal(options) {
  if (!options || !options.phi) return null;
  const t = resolveTransport();
  if (t.baaCovered) return null;
  return {
    success: false,
    blocked: true,
    code: 'EMAIL_PHI_TRANSPORT_BLOCKED',
    transport: t.name,
    error:
      `Refused to send protected health information over the "${t.name}" transport, which is not BAA-covered. ` +
      `Configure Google Workspace sending (GOOGLE_SERVICE_ACCOUNT_KEY + GMAIL_SEND_AS on ` +
      `${config.EMAIL_BAA_DOMAINS.join(' or ') || 'a BAA-covered domain'}), or send this message without PHI.`
  };
}

/**
 * Send one message.
 *
 * options.phi === true marks the message as carrying protected health
 * information. Such a message is sent ONLY over a BAA-covered transport and is
 * refused outright otherwise — it is never downgraded to a non-PHI version
 * silently, because the caller is the only place that knows what to cut.
 */
async function sendEmail(to, subject, body, options = {}) {
  const t = resolveTransport();
  if (!t.configured) {
    return { success: false, error: `Email not configured: ${t.reason}`, transport: 'none' };
  }

  const refusal = phiRefusal(options);
  if (refusal) {
    console.error('[EMAIL] PHI send refused —', refusal.error);
    return refusal;
  }

  const payload = {
    to,
    subject,
    text: body,
    html: options.htmlBody || null,
    attachments: Array.isArray(options.attachments) ? options.attachments : []
  };

  try {
    const result = t.name === 'gmail' ? await sendViaGmail(payload) : await sendViaResend(payload);
    console.log(`[EMAIL] Sent via ${result.transport}${result.id ? ` (${result.id})` : ''}`);
    return result;
  } catch (error) {
    console.error(`[EMAIL] Send failed on ${t.name}:`, error.message);
    return { success: false, error: error.message, transport: t.name };
  }
}

// ---- Bulk paths -----------------------------------------------------------
// Resend has a batch API; Gmail does not. Both return the same shape, so the
// caller never has to know which transport carried the mail.

async function sendPerRecipient(payloads) {
  const results = [];
  for (const p of payloads) {
    const r = await sendEmail(p.to, p.subject, p.text || p.body || '', {
      htmlBody: p.html || p.htmlBody,
      attachments: p.attachments,
      phi: p.phi
    });
    results.push({ email: p.to, ...r });
  }
  const sent = results.filter(r => r.success).length;
  return { sent, failed: results.length - sent, total: results.length, results };
}

async function sendBulkEmail(recipients, subject, body, options = {}) {
  if (!recipients || recipients.length === 0) {
    return { sent: 0, failed: 0, total: 0, results: [] };
  }
  const payloads = recipients.map(r => ({
    to: typeof r === 'string' ? r : r.email,
    subject,
    text: body,
    html: options.htmlBody,
    phi: options.phi
  }));
  return sendBatchEmails(payloads);
}

async function sendBatchEmails(emailPayloads) {
  if (!emailPayloads || emailPayloads.length === 0) {
    return { sent: 0, failed: 0, total: 0, results: [] };
  }

  const t = resolveTransport();
  if (!t.configured) {
    const results = emailPayloads.map(p => ({
      email: p.to, success: false, transport: 'none',
      error: `Email not configured: ${t.reason}`
    }));
    return { sent: 0, failed: results.length, total: results.length, results };
  }

  // Gmail sends one at a time, and a single message goes down the same path
  // either way.
  if (t.name !== 'resend' || emailPayloads.length === 1) {
    return sendPerRecipient(emailPayloads);
  }

  const blocked = emailPayloads.filter(p => p.phi);
  if (blocked.length) {
    // Batching a PHI message over Resend is the same refusal as sending one.
    return sendPerRecipient(emailPayloads);
  }

  const resend = getResend();
  const fromAddress = `${t.fromName} <${t.fromAddress}>`;
  const allResults = [];

  const chunks = [];
  for (let i = 0; i < emailPayloads.length; i += 100) {
    chunks.push(emailPayloads.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const batchPayload = chunk.map(p => {
      const payload = {
        from: fromAddress,
        to: Array.isArray(p.to) ? p.to : [p.to],
        subject: p.subject,
        text: p.text || p.body || ''
      };
      if (p.html || p.htmlBody) payload.html = p.html || p.htmlBody;
      return payload;
    });

    try {
      const { data, error } = await resend.batch.send(batchPayload);
      if (error) {
        console.error('[BATCH EMAIL] Batch API error:', error);
        for (const p of chunk) {
          allResults.push({ email: p.to, success: false, transport: 'resend', error: error.message || 'Batch send failed' });
        }
      } else {
        const ids = (data && data.data) || data || [];
        chunk.forEach((p, idx) => {
          allResults.push({ email: p.to, success: true, transport: 'resend', id: (ids[idx] && ids[idx].id) || null });
        });
      }
    } catch (err) {
      console.error('[BATCH EMAIL] Batch request failed:', err.message);
      for (const p of chunk) {
        allResults.push({ email: p.to, success: false, transport: 'resend', error: err.message });
      }
    }
  }

  const sent = allResults.filter(r => r.success).length;
  const failed = allResults.filter(r => !r.success).length;
  console.log(`[BATCH EMAIL] Sent ${sent}/${emailPayloads.length}, ${failed} failed`);
  return { sent, failed, total: emailPayloads.length, results: allResults };
}

module.exports = {
  sendEmail, sendBulkEmail, sendBatchEmails,
  transportStatus, resetTransportCache,
  // exported for tests
  buildMimeMessage, isBaaSender, sanitizeHeader, encodeHeaderValue, _setGmailClientForTests
};
