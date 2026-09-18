// The signed-consent downloads on the enrollment page answered
// {"error":"Access denied","code":"AUTH_MISSING"} — reported live from a phone,
// 2026-09-17.
//
// They were plain <a href> links. A browser navigating to a link sends no
// Authorization header, so the request arrived anonymous and the server refused
// it. The screen showed raw JSON where a consent PDF should have been.
//
// Three links were affected, all of them the ones that matter: the signed copy,
// the enrollment-packet ZIP, and the blank copy printed for a home visit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.resolve(__dirname, '..', 'public', 'admin-enrollment.html');
const SRC = fs.readFileSync(PAGE, 'utf8');

// Lift the real functions out of the page and RUN them. Reading the source only
// proves the text is present; the question is what the browser actually sends.
function loadDownloader(fakes) {
  // Sliced between anchors rather than by counting braces: openDocument takes a
  // DESTRUCTURED parameter, so the first { in the declaration closes before the
  // body even opens. If either anchor moves this fails loudly, which is the
  // point — a guard that silently grabs the wrong slice proves nothing.
  const grab = (name, endsBefore) => {
    const start = SRC.indexOf(`const ${name} = `);
    assert.notStrictEqual(start, -1, `${name} is gone from the page`);
    const end = SRC.indexOf(endsBefore, start);
    assert.notStrictEqual(end, -1, `could not find the end of ${name}`);
    return SRC.slice(start, end);
  };
  const body = `
    ${grab('filenameFromResponse', '\n    const handleResponse')}
    ${grab('openDocument', '\n    // The server already sends a proper filename')}
    return { openDocument, filenameFromResponse };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('fetch', 'getToken', 'API_URL', 'URL', 'document', 'setTimeout', body)(
    fakes.fetch, fakes.getToken, 'https://app.example.test', fakes.URL, fakes.document, fakes.setTimeout
  );
}

function harness({ token = 'tok-123', status = 200, headers = {}, json = null } = {}) {
  const calls = [];
  const clicked = [];
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
    blob: async () => ({ fake: 'bytes' }),
    json: async () => { if (json === null) throw new Error('not json'); return json; }
  };
  const fakes = {
    fetch: async (url, opts) => { calls.push({ url, opts }); return res; },
    getToken: () => token,
    URL: { createObjectURL: () => 'blob:xyz', revokeObjectURL: () => {} },
    document: {
      createElement: () => {
        const a = { click() { clicked.push({ href: a.href, download: a.download }); }, remove() {} };
        return a;
      },
      body: { appendChild: () => {} }
    },
    setTimeout: () => {}
  };
  return { ...loadDownloader(fakes), calls, clicked };
}

// ── What the browser actually sends ─────────────────────────────────

test('the download carries the token in the HEADER', async () => {
  const h = harness({ headers: { 'Content-Disposition': 'attachment; filename="c.pdf"' } });
  await h.openDocument('/api/gfc/admin/enrollment/abc/consent/npp.pdf');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].opts.headers.Authorization, 'Bearer tok-123');
});

test('and NEVER in the URL — these are PHI documents', async () => {
  // The routes do accept ?token=, which is the shorter fix and the wrong one: a
  // token in a URL lands in browser history, the access log and the Referer.
  const h = harness({ headers: { 'Content-Disposition': 'attachment; filename="c.pdf"' } });
  await h.openDocument('/api/gfc/admin/enrollment/abc/consent/npp.pdf');
  assert.ok(!/token=/.test(h.calls[0].url), `token leaked into the URL: ${h.calls[0].url}`);
  assert.ok(!h.calls[0].url.includes('tok-123'));
});

test('a relative path is resolved against the app, an absolute one is left alone', async () => {
  const h = harness({ headers: { 'Content-Disposition': 'attachment; filename="c.pdf"' } });
  await h.openDocument('/api/gfc/admin/enrollment/abc/enrollment-packet.zip');
  assert.equal(h.calls[0].url, 'https://app.example.test/api/gfc/admin/enrollment/abc/enrollment-packet.zip');
  await h.openDocument('https://drive.google.com/file/d/xyz');
  assert.equal(h.calls[1].url, 'https://drive.google.com/file/d/xyz');
});

test('signed out is caught before a request is made', async () => {
  const h = harness({ token: null });
  await assert.rejects(() => h.openDocument('/api/x.pdf'), /signed out/i);
  assert.equal(h.calls.length, 0, 'no anonymous request may be sent');
});

// ── The failure says which failure it was ───────────────────────────

test("the server's own message survives", async () => {
  // "Could not download" covers an expired session, a consent nobody signed and
  // a client that no longer exists. Those are three different next steps.
  const h = harness({ status: 404, json: { error: 'Consent not found', code: 'CONSENT_NOT_FOUND' } });
  await assert.rejects(() => h.openDocument('/api/x.pdf'), /Consent not found/);
});

test('a 401 is named as an expired session, which the person can act on', async () => {
  const h = harness({ status: 401, json: { error: 'Access denied', code: 'AUTH_MISSING' } });
  await assert.rejects(() => h.openDocument('/api/x.pdf'), /session has expired/i);
});

test('a non-JSON failure still reports its status rather than "undefined"', async () => {
  const h = harness({ status: 502 });
  await assert.rejects(() => h.openDocument('/api/x.pdf'), /502/);
});

// ── The file arrives named ──────────────────────────────────────────

test('the filename comes from the server, including the UTF-8 form', async () => {
  // contentDisposition.js sends an ASCII-safe filename= plus filename*=UTF-8''…
  // carrying the real one. Read it back, or a client called O'Brien downloads
  // something called "document".
  const h = harness({
    headers: { 'Content-Disposition': "inline; filename=\"Consent_OBrien.pdf\"; filename*=UTF-8''Consent_O%E2%80%99Brien.pdf" }
  });
  await h.openDocument('/api/x.pdf');
  assert.equal(h.clicked[0].download, 'Consent_O’Brien.pdf');
});

test('a response with no filename falls back rather than downloading "undefined"', async () => {
  const h = harness({ headers: {} });
  await h.openDocument('/api/gfc/admin/enrollment/abc/enrollment-packet.zip', { asDownload: 'enrollment-packet.zip' });
  assert.equal(h.clicked[0].download, 'enrollment-packet.zip');
});

// ── Build enforcement: the links cannot go back to being links ──────

test('no download on the enrollment page is a bare link to our API', () => {
  // The bug in one line: <a href={c.signedCopyUrl}>. Anything pointing at an
  // API-backed document must go through openDocument.
  for (const field of ['signedCopyUrl', 'blankCopyUrl', 'packetZipUrl']) {
    const asHref = new RegExp(`href=\\{[^}]*${field}`);
    assert.ok(!asHref.test(SRC), `${field} is a bare href again — it will send no token`);
    assert.ok(SRC.includes(`openDocument(`), 'openDocument is gone');
    assert.ok(new RegExp(`openDocument\\([^)]*${field}`).test(SRC),
      `${field} is not routed through openDocument`);
  }
});

test('a failed download does not blank the whole client record', () => {
  // DetailView's `err` is an early return that REPLACES the record with the
  // message, so a download failure must never be reported through it.
  const at = SRC.indexOf('const DetailView =');
  const view = SRC.slice(at, SRC.indexOf('const App =', at) > -1 ? SRC.indexOf('const App =', at) : SRC.length);
  assert.match(view, /const \[downloadErr, setDownloadErr\] = useState\(''\)/);
  assert.ok(!/openDocument\([^)]*\)\.catch\(e => setErr\(/.test(view),
    'a download failure is being routed through the page-replacing error state');
  assert.match(view, /\{downloadErr && <div/, 'the download error has nowhere to render');
});

test('the Drive-hosted links are deliberately left as links', () => {
  // A packet scan and the advance directive live in Google Drive, not behind
  // our API. They need no token and must not be dragged through openDocument.
  assert.match(SRC, /href=\{c\.scanUrl\}/);
  assert.match(SRC, /href=\{client\.files\.advanceDirective\}/);
});
