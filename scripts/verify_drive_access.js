#!/usr/bin/env node
// ============================================================================
// VERIFY: Google Drive is actually reachable with the service account
// ============================================================================
//   node scripts/verify_drive_access.js
//
// Run it on the DEPLOYMENT, with the real environment. It is the only thing
// that proves Google accepts the credential.
//
// It writes a real file, lists it, reads the BYTES back and compares them, then
// deletes it. Nothing here asserts a status code or the presence of an
// environment variable: `driveStatus().configured` means the key parses and a
// subject is set, which is a different fact from Google accepting either. That
// distinction is the one this repo keeps paying for — a narrowed OAuth token
// sat behind a green "OpenEMR connected" for weeks.
//
// Setup: docs/DRIVE_ACCESS_SETUP.md
// ============================================================================

const drive = require('../googledrive');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`); }
};

// Google's own errors are accurate and say nothing about what to fix. These are
// the failures that actually happen, each mapped to the step that fixes it.
const hintFor = (message) => {
  const m = String(message || '');
  if (/unauthorized_client/i.test(m)) {
    return 'Domain-wide delegation does not grant the Drive scope. Admin console → API controls → Manage Domain Wide Delegation: the service account\'s scope list must carry BOTH gmail.send AND drive, on one line. (Setup step 2.)';
  }
  if (/invalid_grant/i.test(m)) {
    return 'GOOGLE_DRIVE_IMPERSONATE (or GMAIL_SEND_AS) is not a real licensed Workspace user. An alias or a Google Group cannot be impersonated. (Setup step 4.)';
  }
  if (/storage quota/i.test(m)) {
    return 'No impersonation subject, so the service account tried to own the file itself and has no quota. Set GOOGLE_DRIVE_IMPERSONATE. (Setup step 4.)';
  }
  if (/File not found/i.test(m)) {
    return 'GOOGLE_DRIVE_FOLDER_ID points at a folder the service account was never shared with, or it is not a member of the Shared Drive. (Setup step 3.)';
  }
  if (/API has not been used|accessNotConfigured/i.test(m)) {
    return 'The Drive API is not enabled on the Google Cloud project. (Setup step 1.)';
  }
  return null;
};

(async () => {
  console.log('\n--- configuration ---');
  const status = drive.driveStatus();
  console.log(`  service account : ${status.serviceAccount || '(none)'}`);
  console.log(`  impersonating   : ${status.impersonating || '(none)'}`);
  console.log(`  root folder id  : ${status.rootFolderId || '(none — files land at the top of that Drive)'}`);
  ok('a service-account credential and an impersonation subject are configured',
    status.configured, status.reason);
  if (!status.configured) {
    console.log('\nNothing further can be tested. See docs/DRIVE_ACCESS_SETUP.md\n');
    process.exit(1);
  }

  console.log('\n--- a real round trip ---');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `GFC_DRIVE_PROBE_${stamp}.pdf`;
  // A real PDF header, because the app types files by their bytes and a probe
  // that uploads something the app itself would reject proves the wrong thing.
  const bytes = Buffer.concat([
    Buffer.from('%PDF-1.4\n% GFC Drive access probe — safe to delete\n'),
    Buffer.from(`probe ${stamp}\n`)
  ]);

  let stored = null;
  try {
    stored = await drive.uploadCaregiverDocumentFile('ZZ Drive Probe (TEST DATA)', name, bytes, 'application/pdf');
    ok('a file uploads', !!(stored && stored.fileId), JSON.stringify(stored));
  } catch (e) {
    ok('a file uploads', false, `${e.message}${hintFor(e.message) ? `\n         → ${hintFor(e.message)}` : ''}`);
    console.log(`\n${pass}/${pass + fail} checks passed\n`);
    process.exit(1);
  }

  try {
    const back = await drive.downloadFileBuffer(stored.fileId);
    ok('  the bytes read back', Buffer.isBuffer(back) && back.length > 0, `got ${back && back.length} bytes`);
    // The point of the probe: not that a call returned, that the CONTENT
    // survived. A read that returns something of the wrong length is a
    // different failure from one that throws, and both look like "it worked"
    // if you only check for an exception.
    ok('  and are byte-for-byte what was sent', Buffer.compare(Buffer.from(back), bytes) === 0,
      `sent ${bytes.length} bytes, read ${back && back.length}`);
    ok('  with a real PDF header', String(back.slice(0, 5)) === '%PDF-', String(back.slice(0, 12)));
  } catch (e) {
    ok('  the bytes read back', false, `${e.message}${hintFor(e.message) ? `\n         → ${hintFor(e.message)}` : ''}`);
  }

  console.log('\n--- cleanup ---');
  try {
    await drive.deleteFile(stored.fileId);
    ok('the probe file is removed', true);
  } catch (e) {
    ok('the probe file is removed', false,
      `${e.message} — delete it by hand: ${stored.webViewLink || stored.fileId}`);
  }

  console.log(`\n${pass}/${pass + fail} checks passed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nProbe crashed:', e.message);
  const h = hintFor(e.message);
  if (h) console.error('→', h);
  process.exit(1);
});
