const { Resend } = require('resend');

let _resend = null;
function getResend() {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.warn('[EMAIL] RESEND_API_KEY not set — email sending is disabled.');
      return null;
    }
    _resend = new Resend(key);
  }
  return _resend;
}

const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || 'no-reply@godwinsfamilycarellc.com';
const FROM_NAME = 'Godwins Family Care';

async function sendEmail(to, subject, body, options = {}) {
  const resend = getResend();
  if (!resend) {
    return { success: false, error: 'Email not configured (missing RESEND_API_KEY)' };
  }
  try {
    const payload = {
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      text: body,
    };

    if (options.htmlBody) {
      payload.html = options.htmlBody;
    }

    // Attachments: [{ filename, content: Buffer|base64 }]. Used by the admin
    // Transfer-of-Care ROI notification (Session 3.4). Client/patient receipts
    // are NEVER sent attachments — compliance keeps PHI out of patient email.
    if (Array.isArray(options.attachments) && options.attachments.length) {
      payload.attachments = options.attachments.map(a => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content
      }));
    }

    const result = await resend.emails.send(payload);
    console.log('Email sent:', result);
    return { success: true, id: result.id };
  } catch (error) {
    console.error('Email send failed:', error);
    return { success: false, error: error.message };
  }
}

async function sendBulkEmail(recipients, subject, body, options = {}) {
  if (!recipients || recipients.length === 0) {
    return { sent: 0, failed: 0, total: 0, results: [] };
  }

  if (recipients.length === 1) {
    const to = typeof recipients[0] === 'string' ? recipients[0] : recipients[0].email;
    const result = await sendEmail(to, subject, body, options);
    const results = [{ email: to, ...result }];
    return { sent: result.success ? 1 : 0, failed: result.success ? 0 : 1, total: 1, results };
  }

  const resend = getResend();
  if (!resend) {
    const results = recipients.map(r => ({
      email: typeof r === 'string' ? r : r.email,
      success: false,
      error: 'Email not configured (missing RESEND_API_KEY)'
    }));
    return { sent: 0, failed: recipients.length, total: recipients.length, results };
  }

  const fromAddress = `${FROM_NAME} <${FROM_EMAIL}>`;
  const allResults = [];

  const chunks = [];
  for (let i = 0; i < recipients.length; i += 100) {
    chunks.push(recipients.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const batchPayload = chunk.map(recipient => {
      const to = typeof recipient === 'string' ? recipient : recipient.email;
      const payload = {
        from: fromAddress,
        to: [to],
        subject,
        text: body,
      };
      if (options.htmlBody) {
        payload.html = options.htmlBody;
      }
      return payload;
    });

    try {
      const { data, error } = await resend.batch.send(batchPayload);

      if (error) {
        console.error('[BATCH EMAIL] Batch API error:', error);
        for (const recipient of chunk) {
          const to = typeof recipient === 'string' ? recipient : recipient.email;
          allResults.push({ email: to, success: false, error: error.message || 'Batch send failed' });
        }
      } else {
        const ids = data?.data || data || [];
        chunk.forEach((recipient, idx) => {
          const to = typeof recipient === 'string' ? recipient : recipient.email;
          const emailId = ids[idx]?.id || null;
          allResults.push({ email: to, success: true, id: emailId });
        });
      }
    } catch (err) {
      console.error('[BATCH EMAIL] Batch request failed:', err.message);
      for (const recipient of chunk) {
        const to = typeof recipient === 'string' ? recipient : recipient.email;
        allResults.push({ email: to, success: false, error: err.message });
      }
    }
  }

  const sent = allResults.filter(r => r.success).length;
  const failed = allResults.filter(r => !r.success).length;
  console.log(`[BATCH EMAIL] Sent ${sent}/${recipients.length}, ${failed} failed`);
  return { sent, failed, total: recipients.length, results: allResults };
}

async function sendBatchEmails(emailPayloads) {
  if (!emailPayloads || emailPayloads.length === 0) {
    return { sent: 0, failed: 0, total: 0, results: [] };
  }

  if (emailPayloads.length === 1) {
    const p = emailPayloads[0];
    const result = await sendEmail(p.to, p.subject, p.text || p.body || '', { htmlBody: p.html || p.htmlBody });
    return { sent: result.success ? 1 : 0, failed: result.success ? 0 : 1, total: 1, results: [{ email: p.to, ...result }] };
  }

  const resend = getResend();
  if (!resend) {
    const results = emailPayloads.map(p => ({
      email: p.to,
      success: false,
      error: 'Email not configured (missing RESEND_API_KEY)'
    }));
    return { sent: 0, failed: emailPayloads.length, total: emailPayloads.length, results };
  }

  const fromAddress = `${FROM_NAME} <${FROM_EMAIL}>`;
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
        text: p.text || p.body || '',
      };
      if (p.html || p.htmlBody) {
        payload.html = p.html || p.htmlBody;
      }
      return payload;
    });

    try {
      const { data, error } = await resend.batch.send(batchPayload);

      if (error) {
        console.error('[BATCH EMAIL] Batch API error:', error);
        for (const p of chunk) {
          allResults.push({ email: p.to, success: false, error: error.message || 'Batch send failed' });
        }
      } else {
        const ids = data?.data || data || [];
        chunk.forEach((p, idx) => {
          const emailId = ids[idx]?.id || null;
          allResults.push({ email: p.to, success: true, id: emailId });
        });
      }
    } catch (err) {
      console.error('[BATCH EMAIL] Batch request failed:', err.message);
      for (const p of chunk) {
        allResults.push({ email: p.to, success: false, error: err.message });
      }
    }
  }

  const sent = allResults.filter(r => r.success).length;
  const failed = allResults.filter(r => !r.success).length;
  console.log(`[BATCH EMAIL] Sent ${sent}/${emailPayloads.length}, ${failed} failed`);
  return { sent, failed, total: emailPayloads.length, results: allResults };
}

module.exports = { sendEmail, sendBulkEmail, sendBatchEmails };
