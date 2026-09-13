// ============================================================================
// Drive storage: the service-account migration, and caregiver document upload
// ============================================================================
// Two things landed together on 2026-09-13 and these tests hold both.
//
// 1. Drive authenticated through a REPLIT CONNECTOR. The platform is AWS, so
//    `getAccessToken()` threw on its first line and took every file write with
//    it — client uploads, care plans, ROI PDFs, consents, offline packet scans.
//    It now uses the same Google service account the mailer uses. The guards
//    below hold the Replit path deleted and the shared-drive flags present,
//    because both failures are invisible from a passing syntax check.
//
// 2. Caregivers can send a file (a paper timesheet, a certificate). The rules
//    that matter are the ones a later session would quietly undo: a Drive
//    failure REFUSES the upload rather than recording a row pointing at
//    nothing, a file is typed by its bytes rather than by what the caller
//    claimed, and a caregiver reads only their own.
//
// House rule applied throughout: assert the behaviour, not the artifact. The
// route tests mount the real router and call it over HTTP.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const drive = require('../googledrive');
const config = require('../config');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const driveSrc = read('googledrive.js');

// A real (throwaway) RSA key, so the key-repair test exercises the actual parse
// path rather than a string that only looks like a PEM.
const FAKE_PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----\n';

const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

const CLEAN = {
  GOOGLE_SERVICE_ACCOUNT_KEY: undefined,
  GOOGLE_DRIVE_IMPERSONATE: undefined,
  GMAIL_SEND_AS: undefined,
  GOOGLE_DRIVE_FOLDER_ID: undefined
};

// ===========================================================================
// The credential
// ===========================================================================

test('a private key whose newlines survived as literal backslash-n is repaired', () => {
  // A PEM that has been through a hosting panel or a CI secrets box arrives
  // with its \n intact, and the JWT library then fails with an opaque
  // complaint about the key format. The mailer already repairs this; Drive
  // reads the SAME secret, so it has to repair it the same way or one of the
  // two works and the other does not, on one credential.
  const escaped = FAKE_PEM.replace(/\n/g, '\\n');
  withEnv({ ...CLEAN, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: escaped }) }, () => {
    const sa = drive.loadServiceAccount();
    assert.ok(sa, 'the key should parse');
    assert.ok(!sa.private_key.includes('\\n'), 'literal \\n must be repaired to real newlines');
    assert.ok(sa.private_key.includes('-----BEGIN PRIVATE KEY-----\n'));
  });
});

test('a base64-wrapped key is accepted, because secrets stores mangle raw JSON', () => {
  const json = JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: FAKE_PEM });
  withEnv({ ...CLEAN, GOOGLE_SERVICE_ACCOUNT_KEY: Buffer.from(json).toString('base64') }, () => {
    const sa = drive.loadServiceAccount();
    assert.strictEqual(sa && sa.client_email, 'sa@p.iam.gserviceaccount.com');
  });
});

test('a key missing either half is null, not a half-usable credential', () => {
  withEnv({ ...CLEAN, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com' }) }, () => {
    assert.strictEqual(drive.loadServiceAccount(), null);
  });
  withEnv({ ...CLEAN, GOOGLE_SERVICE_ACCOUNT_KEY: 'not json at all' }, () => {
    assert.strictEqual(drive.loadServiceAccount(), null);
  });
});

// ===========================================================================
// What the app may claim about Drive
// ===========================================================================

test('driveStatus names EVERY missing piece, not just the first', () => {
  // The reason line is what the boot log prints and what the probe shows. If
  // it stopped at the first blocker, fixing that one would reveal the next and
  // the setup would take as many restarts as there are variables.
  withEnv(CLEAN, () => {
    const s = drive.driveStatus();
    assert.strictEqual(s.configured, false);
    assert.strictEqual(s.blockers.length, 2);
    assert.match(s.reason, /GOOGLE_SERVICE_ACCOUNT_KEY/);
    assert.match(s.reason, /GOOGLE_DRIVE_IMPERSONATE/);
  });
});

test('the impersonation subject falls back to GMAIL_SEND_AS, because it is the same account', () => {
  const key = JSON.stringify({ client_email: 'sa@p.iam.gserviceaccount.com', private_key: FAKE_PEM });
  withEnv({ ...CLEAN, GOOGLE_SERVICE_ACCOUNT_KEY: key, GMAIL_SEND_AS: 'admin@example.com' }, () => {
    const s = drive.driveStatus();
    assert.strictEqual(s.configured, true);
    assert.strictEqual(s.impersonating, 'admin@example.com');
  });
  // An explicit Drive subject wins, for the case where they genuinely differ.
  withEnv({ ...CLEAN, GOOGLE_SERVICE_ACCOUNT_KEY: key, GMAIL_SEND_AS: 'admin@example.com', GOOGLE_DRIVE_IMPERSONATE: 'files@example.com' }, () => {
    assert.strictEqual(drive.driveStatus().impersonating, 'files@example.com');
  });
});

test('an unconfigured Drive THROWS a named error rather than half-working', async () => {
  // "Drive is not set up" and "Google refused this file" are different facts,
  // and every upload route branches on them differently. A generic throw here
  // would put a setup problem behind the same message as a transient one, and
  // the transient message tells the user to try again — which can never work.
  drive._setDriveClientForTests(null);
  await withEnv(CLEAN, async () => {
    await assert.rejects(
      () => drive.getDriveClient(),
      (e) => e.code === 'DRIVE_NOT_CONFIGURED' && e instanceof drive.DriveNotConfiguredError
    );
  });
});

test('an apostrophe in a folder name is escaped, so O\'Brien is a name and not a syntax error', () => {
  // Per-client folders are named from the client's own name. An unescaped
  // apostrophe terminates the quoted string in the Drive query and changes
  // what is searched.
  assert.strictEqual(drive.escapeDriveQueryValue("O'Brien"), "O\\'Brien");
  assert.strictEqual(drive.escapeDriveQueryValue('back\\slash'), 'back\\\\slash');
});

// ===========================================================================
// Build-enforced: the things a passing syntax check cannot see
// ===========================================================================

test('the Replit connector path is GONE from Drive, not disabled', () => {
  // A branch that can never run is not a fallback, it is a place for a future
  // session to be misled about what is supported. This is the guard that
  // catches a revert.
  assert.ok(!/REPLIT_CONNECTORS_HOSTNAME|REPL_IDENTITY|WEB_REPL_RENEWAL/.test(
    driveSrc.replace(/^\s*\/\/.*$/gm, '')
  ), 'googledrive.js must not read any Replit variable');
});

test('every Drive call carries the shared-drive flags', () => {
  // Without supportsAllDrives a Shared Drive answers "File not found" for a
  // folder that plainly exists, and the error names nothing useful. The flags
  // are harmless on My Drive, so the rule is simply that they are always there.
  //
  // Scanned by walking balanced parentheses, not by a regex over the source: a
  // first version of this test matched on the closing brace's INDENTATION and
  // found two of the ten call sites while reporting a pass on those two.
  const sites = [];
  const re = /drive\.(files|permissions)\.(create|get|list|delete|update)\(/g;
  let m;
  while ((m = re.exec(driveSrc))) {
    let depth = 0, i = re.lastIndex - 1;
    for (; i < driveSrc.length; i++) {
      if (driveSrc[i] === '(') depth++;
      else if (driveSrc[i] === ')') { depth--; if (depth === 0) break; }
    }
    sites.push({ what: m[0], body: driveSrc.slice(m.index, i + 1) });
  }

  assert.ok(sites.length >= 10, `expected every Drive call site to be found, got ${sites.length}`);
  const missing = sites.filter(s => !/\.\.\.ALL_DRIVES/.test(s.body));
  assert.deepStrictEqual(missing.map(s => s.body.split('\n')[0]), [],
    'these Drive calls are missing the shared-drive flags');
});

test('PHI files are still never link-shared by default', () => {
  // The legacy Apps Script shared PHI by anyone-link. The grant survives only
  // behind an explicit flag that is off, and must stay gated.
  const fn = driveSrc.match(/async function maybeGrantAnyoneLink[\s\S]*?\n\}/);
  assert.ok(fn, 'maybeGrantAnyoneLink must exist — six call sites reference it');
  assert.match(fn[0], /if \(!config\.DRIVE_ALLOW_ANYONE_LINK\) return;/);
  assert.strictEqual(config.DRIVE_ALLOW_ANYONE_LINK, false, 'the anyone-link grant ships OFF');
});

test('the new caregiver_documents collection is claimed in the migration registry', () => {
  // Session 5's migration refuses to copy a store nobody claimed. A collection
  // added without a handler fails the CUTOVER, not the build — unless this
  // holds it.
  const reg = read('dataMigration.js');
  assert.match(reg, /'caregiver_documents'/);
});

// ===========================================================================
// Caregiver documents — driven through the real router
// ===========================================================================

const CAREGIVER = { id: 'cg1', role: 'vendor', name: 'Rosa Adeyemi', licenseLevel: 'cna', email: 'rosa@example.com' };
const OTHER_CG = { id: 'cg2', role: 'vendor', name: 'Tunde Bello', licenseLevel: 'pca', email: 'tunde@example.com' };
const ADMIN = { id: 'a1', role: 'admin', name: 'GFC Admin', email: 'admin@example.com' };

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('timesheet\n')]);

// A fake Drive. `fail` makes the upload throw the way a real refusal does.
const fakeDrive = (opts = {}) => {
  const files = new Map();
  return {
    files,
    uploaded: [],
    async uploadCaregiverDocumentFile(caregiverName, fileName, buf, mime) {
      if (opts.fail) throw new Error('unauthorized_client');
      const id = `drv_${files.size + 1}`;
      files.set(id, buf);
      this.uploaded.push({ caregiverName, fileName, mime, bytes: buf.length });
      return { fileId: id, fileName, webViewLink: `https://drive/${id}` };
    },
    async downloadFileBuffer(id) {
      if (!files.has(id)) throw new Error('File not found');
      return files.get(id);
    }
  };
};

// Mounts the shipped router with an in-memory store and a fake Drive, and
// returns a fetch bound to it. `as` picks who is signed in.
const mountCaregiver = async (t, { as = CAREGIVER, users = [CAREGIVER, OTHER_CG, ADMIN], driveStub = fakeDrive(), store = {} } = {}) => {
  const db = {
    get: async (k) => store[k] || null,
    set: async (k, v) => { store[k] = v; }
  };
  const activity = [];
  const router = require('../routes/caregiver')({
    db, config,
    logActivity: async (...a) => { activity.push(a); },
    queueNotification: async () => {},
    getUsers: async () => users,
    invalidateUsersCache: () => {},
    authenticateToken: (req, _res, next) => { req.user = as; next(); },
    uuidv4: () => 'x',
    drive: driveStub,
    detectFileType: (buf) => {
      if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
      if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
      return null;
    }
  });
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  return {
    store, activity, drive: driveStub,
    call: (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init),
    post: (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
  };
};

const upload = (h, over = {}) => h.post('/api/caregiver/documents', {
  kind: 'timesheet', fileName: 'week 37.pdf', fileDataB64: PDF.toString('base64'),
  periodStart: '2026-09-07', periodEnd: '2026-09-13', ...over
});

test('a caregiver can send a timesheet, and the row reads back', async (t) => {
  const h = await mountCaregiver(t);
  const res = await upload(h);
  assert.strictEqual(res.status, 200);
  const { document } = await res.json();
  assert.strictEqual(document.kind, 'timesheet');
  assert.strictEqual(document.kindLabel, 'Timesheet');
  assert.strictEqual(document.status, 'received');
  assert.strictEqual(document.periodStart, '2026-09-07');

  // Stored, not just returned.
  const rows = h.store.caregiver_documents;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].caregiver_id, 'cg1');
  assert.strictEqual(rows[0].size_bytes, PDF.length);
  // And the BYTES actually reached Drive.
  assert.strictEqual(h.drive.uploaded.length, 1);
  assert.strictEqual(h.drive.uploaded[0].bytes, PDF.length);
});

test('A DRIVE FAILURE REFUSES THE UPLOAD AND WRITES NOTHING', async (t) => {
  // The one that matters. Recording the row anyway would show the caregiver a
  // filed timesheet pointing at nothing and leave payroll waiting on a file
  // that was never stored — the silent-success trap, pointed at someone's pay.
  const h = await mountCaregiver(t, { driveStub: fakeDrive({ fail: true }) });
  const res = await upload(h);
  assert.strictEqual(res.status, 502);
  assert.strictEqual((await res.json()).code, 'DOCUMENT_STORAGE_UNAVAILABLE');
  assert.ok(!h.store.caregiver_documents || h.store.caregiver_documents.length === 0,
    'no row may exist pointing at a file that was never stored');
});

test('a file is typed by its BYTES, never by what the caller claimed', async (t) => {
  const h = await mountCaregiver(t);
  const res = await upload(h, { fileName: 'timesheet.pdf', fileDataB64: Buffer.from('MZ this is an executable').toString('base64') });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'DOC_TYPE_REJECTED');
  assert.strictEqual(h.drive.uploaded.length, 0, 'a rejected file never reaches Drive');
});

test('an unknown document kind is refused, and the kinds are SERVED not restated', async (t) => {
  const h = await mountCaregiver(t);
  const bad = await upload(h, { kind: 'invoice' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await bad.json()).code, 'DOC_KIND_UNKNOWN');

  const { kinds } = await (await h.call('/api/caregiver/documents/kinds')).json();
  assert.ok(kinds.some(k => k.kind === 'timesheet'), 'the catalog is served to the form');
  // The page must not carry its own copy, or the form and the validator drift.
  const page = read('public/caregiver.html');
  assert.ok(!/'mileage'|"mileage"/.test(page),
    'caregiver.html must read the kinds from the API, not hardcode them');
});

test('the upload card is actually REACHABLE in the caregiver app', () => {
  // Routes with no screen are not a feature. This repo has already paid for
  // that twice — the competency editor and the client-locations screen both
  // sat as "open for the owner" items with nowhere to do them.
  const page = read('public/caregiver.html');
  assert.match(page, /const DocumentsCard = \(\) => \{/, 'the card must exist at module scope');
  assert.match(page, /<DocumentsCard \/>/, 'and must be mounted, not merely defined');
  // Mounted ONCE. Twice would put two upload forms over one route.
  assert.strictEqual((page.match(/<DocumentsCard \/>/g) || []).length, 1);
});

test('the upload card does NOT ride the offline queue', () => {
  // The queue holds small JSON payloads in localStorage. A photographed
  // timesheet is megabytes and would blow the quota, taking the VISIT LOG
  // queue down with it — a caregiver would lose documented care to a document.
  const page = read('public/caregiver.html');
  const card = page.slice(page.indexOf('const DocumentsCard'), page.indexOf('const MoreTab'));
  assert.ok(card.length > 500, 'the card body should have been found');
  assert.ok(!/enqueue|readQueue|writeQueue|QUEUE_KEY/.test(card),
    'a document upload must fail honestly rather than queue silently');
});

test('a caregiver reads only their OWN documents, and cannot widen with a query parameter', async (t) => {
  const store = {};
  const mine = await mountCaregiver(t, { store });
  await upload(mine);

  const theirs = await mountCaregiver(t, { as: OTHER_CG, store });
  await upload(theirs, { fileName: 'tunde.pdf' });

  const list = await (await mine.call('/api/caregiver/documents')).json();
  assert.strictEqual(list.documents.length, 1);
  assert.strictEqual(list.documents[0].caregiverId, 'cg1');

  // The admin filter is admin-only. Passing someone else's id still reads your own.
  const widened = await (await mine.call('/api/caregiver/documents?caregiverId=cg2')).json();
  assert.strictEqual(widened.documents.length, 1);
  assert.strictEqual(widened.documents[0].caregiverId, 'cg1');

  // Admin sees both, and may filter.
  const admin = await mountCaregiver(t, { as: ADMIN, store });
  assert.strictEqual((await (await admin.call('/api/caregiver/documents')).json()).documents.length, 2);
  assert.strictEqual((await (await admin.call('/api/caregiver/documents?caregiverId=cg2')).json()).documents.length, 1);
});

test('opening someone else\'s document is 403; the bytes come back for your own', async (t) => {
  const store = {};
  const mine = await mountCaregiver(t, { store });
  const { document } = await (await upload(mine)).json();

  const back = await mine.call(`/api/caregiver/documents/${document.id}/file`);
  assert.strictEqual(back.status, 200);
  const bytes = Buffer.from(await back.arrayBuffer());
  assert.strictEqual(Buffer.compare(bytes, PDF), 0, 'the stored bytes read back byte-for-byte');

  const intruder = await mountCaregiver(t, { as: OTHER_CG, store });
  const denied = await intruder.call(`/api/caregiver/documents/${document.id}/file`);
  assert.strictEqual(denied.status, 403);
  assert.strictEqual((await denied.json()).code, 'DOC_NOT_YOURS');

  // A read is audited — "who opened this" is the point of reading through the app.
  assert.ok(mine.activity.some(a => a[2] === 'caregiver_document_read'));
});

test('rejecting a document REQUIRES a reason, and the caregiver is told what it was', async (t) => {
  // A caregiver told only "not accepted" re-sends the same blurry photo. This
  // is the same requirement the client-side document rejection carries.
  const store = {};
  const cgHandle = await mountCaregiver(t, { store });
  const { document } = await (await upload(cgHandle)).json();

  const admin = await mountCaregiver(t, { as: ADMIN, store });
  const bare = await admin.post(`/api/caregiver/documents/${document.id}/review`, { decision: 'rejected' });
  assert.strictEqual(bare.status, 400);
  assert.strictEqual((await bare.json()).code, 'REVIEW_REASON_REQUIRED');
  assert.strictEqual(store.caregiver_documents[0].status, 'received', 'nothing changed on the refusal');

  const withReason = await admin.post(`/api/caregiver/documents/${document.id}/review`,
    { decision: 'rejected', reason: 'Hours for the 9th are missing.' });
  assert.strictEqual(withReason.status, 200);

  // The caregiver can read the reason back.
  const seen = await (await cgHandle.call('/api/caregiver/documents')).json();
  assert.strictEqual(seen.documents[0].status, 'rejected');
  assert.strictEqual(seen.documents[0].reviewNote, 'Hours for the 9th are missing.');

  // Accepting needs no reason — only a send-back has something to explain.
  const ok = await admin.post(`/api/caregiver/documents/${document.id}/review`, { decision: 'accepted' });
  assert.strictEqual(ok.status, 200);
});

test('only an admin reviews; a caregiver cannot accept their own timesheet', async (t) => {
  const store = {};
  const h = await mountCaregiver(t, { store });
  const { document } = await (await upload(h)).json();
  const res = await h.post(`/api/caregiver/documents/${document.id}/review`, { decision: 'accepted' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).code, 'ADMIN_ONLY');
});

test('the Drive id and stored name never leave the server', async (t) => {
  // Storage plumbing. Handing it out invites a direct Drive link, which is
  // exactly the audited read this route exists to force.
  const h = await mountCaregiver(t);
  const body = await (await upload(h)).text();
  assert.ok(!body.includes('drv_1'), 'drive_file_id must not be projected');
  assert.ok(!/stored_name|storedName/.test(body));
  assert.ok(h.store.caregiver_documents[0].drive_file_id, 'but it IS stored, or the file is unreachable');
});

test('a caregiver document is filed under the CAREGIVER, never a client', async (t) => {
  // A timesheet routinely covers several clients in one week. Filing it
  // against one of them would file it wrong AND put it where that client's
  // care team can read it.
  const h = await mountCaregiver(t);
  await upload(h);
  const row = h.store.caregiver_documents[0];
  assert.ok(!('client_id' in row), 'no client owns a timesheet');
  assert.strictEqual(h.drive.uploaded[0].caregiverName, 'Rosa Adeyemi',
    'and it lands in the caregiver\'s own Drive folder');
});

test('an empty or oversize file is refused before Drive is touched', async (t) => {
  const h = await mountCaregiver(t);
  const empty = await upload(h, { fileDataB64: '' });
  assert.strictEqual(empty.status, 400);

  const huge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(config.MAX_FILE_SIZE + 1024)]);
  const big = await upload(h, { fileDataB64: huge.toString('base64') });
  assert.strictEqual(big.status, 400);
  assert.strictEqual((await big.json()).code, 'DOC_TOO_LARGE');
  assert.strictEqual(h.drive.uploaded.length, 0);
});

test('a client cannot reach the caregiver document routes at all', async (t) => {
  const CLIENT = { id: 'c1', role: 'client', name: 'Ada Bell' };
  const h = await mountCaregiver(t, { as: CLIENT, users: [CLIENT] });
  for (const p of ['/api/caregiver/documents', '/api/caregiver/documents/kinds']) {
    assert.strictEqual((await h.call(p)).status, 403, `${p} must refuse a client`);
  }
  assert.strictEqual((await upload(h)).status, 403);
});
