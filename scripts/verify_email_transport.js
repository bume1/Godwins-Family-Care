#!/usr/bin/env node
/**
 * verify_email_transport.js — prove the mailer against the REAL provider.
 *
 * The unit suite (test/email_transport.test.js) proves the app builds a valid
 * message and picks the right transport. It cannot prove that Google Workspace
 * accepts and delivers that message, because that needs live credentials. This
 * script is that missing half. Run it on the deployed app.
 *
 *   node scripts/verify_email_transport.js you@godwinsfamilycarellc.com
 *
 * It sends real mail. Nothing it sends contains PHI — the content is fixed
 * test copy — so it is safe to run before the BAA question is settled.
 */

const email = require('../email');
const config = require('../config');

const recipient = process.argv[2];
let pass = 0;
let fail = 0;

const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

async function main() {
  console.log('\n=== 1. What transport is actually live? ===\n');
  const status = email.transportStatus();
  console.log(JSON.stringify(status, null, 2));
  console.log('');

  check('a transport is configured', status.configured, status.reason || '');

  if (!status.configured) {
    console.log('\nNothing is configured, so there is nothing to send. Set either:');
    console.log('  GOOGLE_SERVICE_ACCOUNT_KEY + GMAIL_SEND_AS   (Workspace, BAA-covered)');
    console.log('  RESEND_API_KEY                               (Resend, NOT BAA-covered)');
    process.exit(1);
  }

  if (status.baaCovered) {
    check('the transport is BAA-covered, so PHI may travel on it', true, `sending as ${status.from}`);
  } else {
    console.log(`  NOTE  the live transport is "${status.transport}", which is NOT BAA-covered.`);
    console.log('        Non-PHI mail sends normally; anything marked PHI is refused by design.');
  }

  console.log('\n=== 2. Does the PHI gate agree with that? ===\n');
  if (status.baaCovered) {
    // Nothing is sent to prove this. The gate is a refusal, and a transport
    // that does not refuse has nothing to demonstrate beyond the live sends in
    // step 3 — firing an extra probe at a placeholder address would just bounce.
    check('the PHI gate reports PHI is allowed on this transport', status.phiAllowed === true);
  } else {
    const refused = await email.sendEmail(
      recipient || 'phi-gate-probe@invalid.test',
      'GFC transport probe — PHI gate',
      'This message is marked as PHI. On a non-BAA transport it must be refused before any send is attempted.',
      { phi: true }
    );
    check('a PHI-marked message is REFUSED before it reaches the provider',
      refused.success === false && refused.code === 'EMAIL_PHI_TRANSPORT_BLOCKED',
      refused.code || 'no refusal code — the message may have been sent');
  }

  if (!recipient) {
    console.log('\nNo recipient given, so no live send was attempted.');
    console.log('Re-run with an address to complete the check:');
    console.log('  node scripts/verify_email_transport.js you@godwinsfamilycarellc.com\n');
    process.exit(fail ? 1 : 0);
  }

  console.log(`\n=== 3. Live send to ${recipient} ===\n`);

  const stamp = new Date().toISOString();
  const plain = await email.sendEmail(
    recipient,
    `${config.BRAND.COMPANY_NAME} — transport check (plain + HTML)`,
    `This is a transport check sent at ${stamp}.\n\nIf you can read this, plain text works.\n\n— ${config.BRAND.COMPANY_NAME}`,
    { htmlBody: `<div style="font-family:sans-serif"><h2 style="color:${config.BRAND.PRIMARY_COLOR}">Transport check</h2><p>Sent at ${stamp}.</p><p>If this is styled, the HTML part works.</p></div>` }
  );
  check('plain + HTML message accepted by the provider', plain.success === true, plain.error || `id ${plain.id}`);

  const pdfBytes = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n'
  );
  const withAttachment = await email.sendEmail(
    recipient,
    `${config.BRAND.COMPANY_NAME} — transport check (attachment)`,
    'This transport check carries a small PDF attachment. Open it to confirm attachments survive.',
    { attachments: [{ filename: 'transport-check.pdf', content: pdfBytes, contentType: 'application/pdf' }] }
  );
  check('message with an attachment accepted by the provider', withAttachment.success === true,
    withAttachment.error || `id ${withAttachment.id}`);

  const batch = await email.sendBatchEmails([
    { to: recipient, subject: `${config.BRAND.COMPANY_NAME} — batch check 1 of 2`, text: `Batch message 1, ${stamp}` },
    { to: recipient, subject: `${config.BRAND.COMPANY_NAME} — batch check 2 of 2`, text: `Batch message 2, ${stamp}` }
  ]);
  check('batch send reports both messages sent', batch.sent === 2 && batch.failed === 0,
    `sent ${batch.sent}, failed ${batch.failed}${batch.results.filter(r => !r.success).map(r => ` (${r.error})`).join('')}`);

  console.log('\n=== Result ===\n');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('');
  console.log('  A pass here means the PROVIDER ACCEPTED the message.');
  console.log(`  Now open ${recipient} and confirm all four actually arrived:`);
  console.log('    1. plain + HTML   (should be styled, not raw markup)');
  console.log('    2. attachment     (the PDF should open)');
  console.log('    3. batch 1 of 2');
  console.log('    4. batch 2 of 2');
  console.log('  Check the spam folder too — that is a deliverability answer, not a code one.\n');

  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('\nProbe crashed:', err);
  process.exit(1);
});
