// Does the Workspace (Gmail) sender behave the way Resend did?
//
// That question has two halves and they need different kinds of proof:
//
//   1. Does it build a message a mail server will accept? Provable here, and
//      proved by DECODING the message back rather than by eyeballing it.
//   2. Does a real Google Workspace mailbox accept and deliver it? NOT provable
//      here — that needs Workspace credentials and a live API call. It is
//      `scripts/verify_email_transport.js`, run against the deployed app.
//
// Everything in this file is half 1, plus the guarantee that matters most
// while half 2 is unproven: with no Workspace credentials configured, the app
// keeps sending exactly as it does today, over Resend, unchanged.

const test = require('node:test');
const assert = require('node:assert');

const SA = JSON.stringify({
  client_email: 'gfc-mailer@example-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n'
});

// Every test drives the module through the environment, so the environment is
// restored between them and the module's caches are cleared.
function withEnv(vars, fn) {
  const saved = {};
  const keys = ['EMAIL_TRANSPORT', 'GMAIL_SEND_AS', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'RESEND_API_KEY', 'EMAIL_BAA_DOMAINS', 'EMAIL_FROM_ADDRESS'];
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);

  // config reads the environment at require time, so both modules are reloaded.
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../email')];
  const email = require('../email');

  const restore = () => {
    email.resetTransportCache();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../email')];
  };

  // An async test body must finish BEFORE the environment is torn down. A bare
  // try/finally around a promise-returning fn restores the env on the first
  // await, which pulls the transport out from under the code being tested.
  let result;
  try {
    result = fn(email);
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

const GMAIL_ENV = {
  GOOGLE_SERVICE_ACCOUNT_KEY: SA,
  GMAIL_SEND_AS: 'no-reply@godwinsfamilycarellc.com'
};

// ---- Parsing a built message back out ------------------------------------
// The point of decoding rather than string-matching: a message that merely
// CONTAINS the right text can still be malformed. These helpers reconstruct
// what a mail client would actually see.

function splitHeaders(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, idx);
  const body = raw.slice(idx + 4);
  const headers = {};
  for (const line of head.split('\r\n')) {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim();
  }
  return { headers, body };
}

function boundaryOf(contentType) {
  const m = /boundary="([^"]+)"/.exec(contentType || '');
  return m ? m[1] : null;
}

function partsOf(body, boundary) {
  return body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map(chunk => splitHeaders(chunk.replace(/^\r\n/, '')));
}

const decodePart = (part) => Buffer.from(part.body.replace(/\r\n/g, ''), 'base64');

// ===========================================================================
// 1. Transport selection — what actually happens for each configuration
// ===========================================================================

test('with no Workspace credentials the app sends over Resend, exactly as it does today', () => {
  withEnv({ RESEND_API_KEY: 're_test_key' }, (email) => {
    const s = email.transportStatus();
    assert.strictEqual(s.transport, 'resend');
    assert.strictEqual(s.configured, true);
    // The behaviour is unchanged; what is new is that the app now SAYS the
    // transport is outside the BAA instead of leaving it to be inferred.
    assert.strictEqual(s.baaCovered, false);
    assert.strictEqual(s.phiAllowed, false);
    assert.match(s.reason, /not BAA-covered/i);
  });
});

test('Workspace credentials are preferred over Resend when both are present', () => {
  withEnv({ ...GMAIL_ENV, RESEND_API_KEY: 're_test_key' }, (email) => {
    const s = email.transportStatus();
    assert.strictEqual(s.transport, 'gmail');
    assert.strictEqual(s.baaCovered, true);
    assert.strictEqual(s.phiAllowed, true);
    assert.strictEqual(s.from, 'Godwins Family Care <no-reply@godwinsfamilycarellc.com>');
  });
});

test('a personal @gmail.com sender is Google but is NOT BAA-covered, and is refused as one', () => {
  withEnv({
    GOOGLE_SERVICE_ACCOUNT_KEY: SA,
    GMAIL_SEND_AS: 'godwinsfamilycare@gmail.com',
    RESEND_API_KEY: 're_test_key'
  }, (email) => {
    const s = email.transportStatus();
    // It falls back rather than sending PHI from a mailbox the BAA never covered.
    assert.strictEqual(s.transport, 'resend');
    assert.strictEqual(s.baaCovered, false);
    assert.ok(s.gmailBlockers.some(b => /not on a BAA-covered domain/.test(b)),
      `expected a domain blocker, got: ${JSON.stringify(s.gmailBlockers)}`);
  });
});

test('EMAIL_TRANSPORT=gmail with nothing configured refuses to send rather than silently using Resend', () => {
  withEnv({ EMAIL_TRANSPORT: 'gmail', RESEND_API_KEY: 're_test_key' }, (email) => {
    const s = email.transportStatus();
    assert.strictEqual(s.transport, 'none');
    assert.strictEqual(s.configured, false);
    assert.match(s.reason, /not configured/i);
  });
});

test('a malformed service account key is reported, not treated as Workspace being ready', () => {
  withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: 'not-json-at-all', GMAIL_SEND_AS: 'no-reply@godwinsfamilycarellc.com' }, (email) => {
    const s = email.transportStatus();
    assert.strictEqual(s.transport, 'none');
    assert.ok(s.gmailBlockers.some(b => /GOOGLE_SERVICE_ACCOUNT_KEY/.test(b)));
  });
});

test('the service account key is accepted base64-encoded, which is how it survives an env var', () => {
  withEnv({
    GOOGLE_SERVICE_ACCOUNT_KEY: Buffer.from(SA, 'utf8').toString('base64'),
    GMAIL_SEND_AS: 'no-reply@godwinsfamilycarellc.com'
  }, (email) => {
    assert.strictEqual(email.transportStatus().transport, 'gmail');
  });
});

test('EMAIL_BAA_DOMAINS governs which senders count as covered', () => {
  withEnv({
    ...GMAIL_ENV,
    GMAIL_SEND_AS: 'care@gfc-clinical.com',
    EMAIL_BAA_DOMAINS: 'godwinsfamilycarellc.com, gfc-clinical.com'
  }, (email) => {
    assert.strictEqual(email.transportStatus().baaCovered, true);
  });
});

// ===========================================================================
// 2. The message itself — decoded back, not string-matched
// ===========================================================================

test('a plain-text message decodes back to exactly what was passed in', () => {
  withEnv(GMAIL_ENV, (email) => {
    const raw = email.buildMimeMessage({
      from: 'Godwins Family Care <no-reply@godwinsfamilycarellc.com>',
      to: 'client@example.com',
      subject: 'A visit has been scheduled',
      text: 'Hi Ada,\n\nYour visit is scheduled.\n\n— Godwins Family Care'
    });
    const { headers, body } = splitHeaders(raw);
    assert.strictEqual(headers.to, 'client@example.com');
    assert.strictEqual(headers.subject, 'A visit has been scheduled');
    assert.strictEqual(headers.from, 'Godwins Family Care <no-reply@godwinsfamilycarellc.com>');
    assert.strictEqual(headers['mime-version'], '1.0');
    assert.match(headers['content-type'], /^text\/plain; charset="UTF-8"$/);
    assert.strictEqual(
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
      'Hi Ada,\n\nYour visit is scheduled.\n\n— Godwins Family Care'
    );
  });
});

test('an HTML message is multipart/alternative and BOTH parts decode correctly', () => {
  withEnv(GMAIL_ENV, (email) => {
    const raw = email.buildMimeMessage({
      from: 'GFC <no-reply@godwinsfamilycarellc.com>',
      to: 'client@example.com',
      subject: 'Your visit has been moved',
      text: 'plain version',
      html: '<p>html version</p>'
    });
    const { headers, body } = splitHeaders(raw);
    assert.match(headers['content-type'], /^multipart\/alternative;/);
    const parts = partsOf(body, boundaryOf(headers['content-type']));
    assert.strictEqual(parts.length, 2);
    // Order matters: text/plain first, so a client that cannot render HTML
    // shows the fallback rather than markup.
    assert.match(parts[0].headers['content-type'], /text\/plain/);
    assert.match(parts[1].headers['content-type'], /text\/html/);
    assert.strictEqual(decodePart(parts[0]).toString('utf8'), 'plain version');
    assert.strictEqual(decodePart(parts[1]).toString('utf8'), '<p>html version</p>');
  });
});

test('attachment bytes survive the round trip byte for byte', () => {
  withEnv(GMAIL_ENV, (email) => {
    // Deliberately binary, and long enough to cross the base64 line-wrap.
    const original = Buffer.from(Array.from({ length: 500 }, (_, i) => i % 256));
    const raw = email.buildMimeMessage({
      from: 'GFC <no-reply@godwinsfamilycarellc.com>',
      to: 'admin@godwinsfamilycarellc.com',
      subject: 'Provider ROI Submitted',
      text: 'See attached.',
      html: '<p>See attached.</p>',
      attachments: [{ filename: 'ROI_Doe_20260910_1.pdf', content: original, contentType: 'application/pdf' }]
    });
    const { headers, body } = splitHeaders(raw);
    assert.match(headers['content-type'], /^multipart\/mixed;/);
    const parts = partsOf(body, boundaryOf(headers['content-type']));
    assert.strictEqual(parts.length, 2);
    assert.match(parts[0].headers['content-type'], /multipart\/alternative/);
    assert.match(parts[1].headers['content-disposition'], /filename="ROI_Doe_20260910_1\.pdf"/);
    assert.ok(decodePart(parts[1]).equals(original), 'attachment bytes differ after the round trip');
  });
});

test('an attachment supplied as base64 (the shape Resend took) still round-trips', () => {
  withEnv(GMAIL_ENV, (email) => {
    const original = Buffer.from('%PDF-1.4 fake pdf bytes');
    const raw = email.buildMimeMessage({
      from: 'GFC <no-reply@godwinsfamilycarellc.com>',
      to: 'admin@godwinsfamilycarellc.com',
      subject: 'x',
      text: 'x',
      attachments: [{ filename: 'a.pdf', content: original.toString('base64') }]
    });
    const { headers, body } = splitHeaders(raw);
    const parts = partsOf(body, boundaryOf(headers['content-type']));
    assert.ok(decodePart(parts[1]).equals(original));
  });
});

test('a non-ASCII subject is RFC 2047 encoded and decodes back to the original', () => {
  withEnv(GMAIL_ENV, (email) => {
    const subject = 'Su visita — José Ramírez';
    const raw = email.buildMimeMessage({
      from: 'GFC <no-reply@godwinsfamilycarellc.com>', to: 'c@example.com', subject, text: 'x'
    });
    const { headers } = splitHeaders(raw);
    const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(headers.subject);
    assert.ok(m, `subject was not encoded: ${headers.subject}`);
    assert.strictEqual(Buffer.from(m[1], 'base64').toString('utf8'), subject);
  });
});

test('a newline in a subject cannot inject a header', () => {
  withEnv(GMAIL_ENV, (email) => {
    const raw = email.buildMimeMessage({
      from: 'GFC <no-reply@godwinsfamilycarellc.com>',
      to: 'c@example.com',
      subject: 'Visit scheduled\r\nBcc: attacker@evil.example',
      text: 'x'
    });
    const { headers } = splitHeaders(raw);
    assert.strictEqual(headers.bcc, undefined, 'a Bcc header was injected through the subject');
    assert.match(headers.subject, /Visit scheduled Bcc: attacker@evil\.example/);
  });
});

test('multiple recipients render as one comma-separated To header', () => {
  withEnv(GMAIL_ENV, (email) => {
    const raw = email.buildMimeMessage({
      from: 'GFC <no-reply@godwinsfamilycarellc.com>',
      to: ['a@example.com', 'b@example.com'],
      subject: 'x', text: 'x'
    });
    assert.strictEqual(splitHeaders(raw).headers.to, 'a@example.com, b@example.com');
  });
});

// ===========================================================================
// 3. The dispatch path — same inputs, same outputs as the Resend path
// ===========================================================================

function fakeGmail(capture) {
  return {
    users: {
      messages: {
        send: async (req) => {
          capture.push(req);
          return { data: { id: 'gmail-msg-1' } };
        }
      }
    }
  };
}

test('sendEmail over Workspace returns the same result shape callers already handle', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    const sent = [];
    email._setGmailClientForTests(fakeGmail(sent));

    const result = await email.sendEmail(
      'client@example.com',
      'A visit has been scheduled',
      'Hi Ada, your visit is scheduled.',
      { htmlBody: '<p>Hi Ada</p>' }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.id, 'gmail-msg-1');
    assert.strictEqual(result.transport, 'gmail');

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].userId, 'me');
    // The API takes base64url; a plain base64 payload with + or / in it is
    // rejected, so this is decoded back rather than assumed.
    const raw = Buffer.from(sent[0].requestBody.raw, 'base64url').toString('utf8');
    const { headers } = splitHeaders(raw);
    assert.strictEqual(headers.to, 'client@example.com');
    assert.strictEqual(headers.subject, 'A visit has been scheduled');
    assert.strictEqual(headers.from, 'Godwins Family Care <no-reply@godwinsfamilycarellc.com>');
  });
});

test('the base64url payload contains no characters the Gmail API rejects', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    const sent = [];
    email._setGmailClientForTests(fakeGmail(sent));
    // The payload matters. Standard base64 only emits + and / for particular
    // byte triples, and a plain "subject"/"body" message happens to produce
    // neither — so a naive payload lets a base64 regression pass. This subject
    // is chosen because its encoded form does contain them, and the assertion
    // below FAILS THE TEST if that ever stops being true, rather than quietly
    // going back to proving nothing.
    await email.sendEmail(
      'c@example.com',
      'Visit moved: 9/16 @ 10:30 — Godwins Family Care (rescheduled)',
      'Hi Ada,\n\nYour visit has been moved.\n\n— Godwins Family Care',
      { htmlBody: '<p>Hi Ada,</p><p>Your visit has been moved.</p>' }
    );

    const plainBase64 = Buffer.from(sent[0].requestBody.raw, 'base64url').toString('base64');
    assert.ok(/[+/]/.test(plainBase64),
      'this payload no longer exercises base64url — pick one whose base64 form contains + or /');
    assert.match(sent[0].requestBody.raw, /^[A-Za-z0-9_-]+$/);
  });
});

test('a Workspace API failure is reported as a failure, never as a success', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    email._setGmailClientForTests({
      users: { messages: { send: async () => { throw new Error('Precondition check failed.'); } } }
    });
    const result = await email.sendEmail('c@example.com', 's', 'b');
    assert.strictEqual(result.success, false);
    assert.match(result.error, /Precondition check failed/);
    assert.strictEqual(result.transport, 'gmail');
  });
});

test('sendBatchEmails over Workspace returns the counted shape the queue expects', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    const sent = [];
    email._setGmailClientForTests(fakeGmail(sent));
    const out = await email.sendBatchEmails([
      { to: 'a@example.com', subject: 's1', text: 't1' },
      { to: 'b@example.com', subject: 's2', text: 't2' },
      { to: 'c@example.com', subject: 's3', text: 't3' }
    ]);
    assert.deepStrictEqual(
      { sent: out.sent, failed: out.failed, total: out.total },
      { sent: 3, failed: 0, total: 3 }
    );
    assert.strictEqual(out.results.length, 3);
    assert.strictEqual(out.results[0].email, 'a@example.com');
    assert.strictEqual(out.results[0].success, true);
    // Gmail has no batch endpoint, so this is three sends, not one.
    assert.strictEqual(sent.length, 3);
  });
});

test('one failure inside a batch is counted without taking the others down', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    let n = 0;
    email._setGmailClientForTests({
      users: { messages: { send: async () => {
        n += 1;
        if (n === 2) throw new Error('rate limit exceeded');
        return { data: { id: `id-${n}` } };
      } } }
    });
    const out = await email.sendBatchEmails([
      { to: 'a@example.com', subject: 's', text: 't' },
      { to: 'b@example.com', subject: 's', text: 't' },
      { to: 'c@example.com', subject: 's', text: 't' }
    ]);
    assert.strictEqual(out.sent, 2);
    assert.strictEqual(out.failed, 1);
    assert.strictEqual(out.results[1].success, false);
    assert.match(out.results[1].error, /rate limit/);
  });
});

test('with no transport configured every send reports failure and nothing is queued as sent', async () => {
  await withEnv({}, async (email) => {
    const one = await email.sendEmail('c@example.com', 's', 'b');
    assert.strictEqual(one.success, false);
    assert.strictEqual(one.transport, 'none');

    const many = await email.sendBatchEmails([{ to: 'a@example.com', subject: 's', text: 't' }]);
    assert.strictEqual(many.sent, 0);
    assert.strictEqual(many.failed, 1);
    assert.strictEqual(many.total, 1);
  });
});

// ===========================================================================
// 3b. The two setup failures that eat an afternoon
// ===========================================================================

test('a private key whose newlines survived as literal backslash-n is repaired, not rejected', () => {
  // A service-account PEM arrives escaped inside the JSON. JSON.parse normally
  // turns those into real newlines, but a value that has been through a shell
  // or a hosting panel's secrets box can keep the backslash. The JWT library
  // then complains about the key format, which reads like a bad key rather
  // than a mangled one.
  const mangled = JSON.stringify({
    client_email: 'gfc-mailer@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n'
  });
  withEnv({ GOOGLE_SERVICE_ACCOUNT_KEY: mangled, GMAIL_SEND_AS: 'no-reply@godwinsfamilycarellc.com' }, (email) => {
    assert.strictEqual(email.transportStatus().transport, 'gmail');
    // The key itself is what has to be right. Transport status alone does not
    // touch it, so asserting only on that proves nothing about the repair.
    const sa = email.loadServiceAccount();
    assert.ok(!sa.private_key.includes('\\n'), 'literal backslash-n survived into the key');
    assert.strictEqual((sa.private_key.match(/\n/g) || []).length, 3,
      'the key should have three real newlines after repair');
  });
});

test('a delegation failure explains that delegation is missing', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    email._setGmailClientForTests({
      users: { messages: { send: async () => { throw new Error('unauthorized_client: Client is unauthorized to retrieve access tokens using this method.'); } } }
    });
    const r = await email.sendEmail('c@example.com', 's', 'b');
    assert.strictEqual(r.success, false);
    assert.match(r.hint, /Domain-wide delegation/);
    assert.match(r.hint, /gmail\.send/);
  });
});

test('a bad send-as mailbox explains that the mailbox must be real', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    email._setGmailClientForTests({
      users: { messages: { send: async () => { throw new Error('invalid_grant: Invalid email or User ID'); } } }
    });
    const r = await email.sendEmail('c@example.com', 's', 'b');
    assert.strictEqual(r.success, false);
    assert.match(r.hint, /real, active mailbox/);
    // The hint names the address actually configured, so it can be compared.
    assert.match(r.hint, /no-reply@godwinsfamilycarellc\.com/);
  });
});

test('an ordinary send failure gets no invented hint', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    email._setGmailClientForTests({
      users: { messages: { send: async () => { throw new Error('Backend Error'); } } }
    });
    const r = await email.sendEmail('c@example.com', 's', 'b');
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.hint, undefined);
  });
});

// ===========================================================================
// 4. The PHI gate
// ===========================================================================

test('PHI is refused on Resend and NOTHING is sent', async () => {
  await withEnv({ RESEND_API_KEY: 're_test_key' }, async (email) => {
    const result = await email.sendEmail(
      'client@example.com',
      'A visit has been scheduled',
      'Your visit with Bethel Godwins, FNP is on Tuesday at 10:00 AM.',
      { phi: true }
    );
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.code, 'EMAIL_PHI_TRANSPORT_BLOCKED');
    // The refusal names the fix rather than just failing.
    assert.match(result.error, /GMAIL_SEND_AS/);
  });
});

test('the same PHI message sends once Workspace is the transport', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    const sent = [];
    email._setGmailClientForTests(fakeGmail(sent));
    const result = await email.sendEmail(
      'client@example.com',
      'A visit has been scheduled',
      'Your visit with Bethel Godwins, FNP is on Tuesday at 10:00 AM.',
      { phi: true }
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(sent.length, 1);
  });
});

test('a PHI message inside a Resend batch is refused per message, not smuggled through the batch API', async () => {
  await withEnv({ RESEND_API_KEY: 're_test_key' }, async (email) => {
    const out = await email.sendBatchEmails([
      { to: 'a@example.com', subject: 's', text: 'no phi here' },
      { to: 'b@example.com', subject: 's', text: 'visit Tuesday 10am', phi: true }
    ]);
    const phiRow = out.results.find(r => r.email === 'b@example.com');
    assert.strictEqual(phiRow.success, false);
    assert.strictEqual(phiRow.code, 'EMAIL_PHI_TRANSPORT_BLOCKED');
  });
});

test('non-PHI mail is unaffected by the gate', async () => {
  await withEnv(GMAIL_ENV, async (email) => {
    const sent = [];
    email._setGmailClientForTests(fakeGmail(sent));
    const result = await email.sendEmail('c@example.com', 'Documents needed for your file', 'Please upload your insurance card.');
    assert.strictEqual(result.success, true);
    assert.strictEqual(sent.length, 1);
  });
});
