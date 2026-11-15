#!/usr/bin/env node
// ============================================================================
// scripts/verify_client_announcements.js — the CLIENT announcement board, over
// the REAL HTTP routes (owner, 2026-11-15: announcements get the same rich
// text as a clinical note, on both boards).
//
// This board had NO tests of any kind before this file: nothing in test/ would
// have failed if its four routes had been renamed or deleted.
//
// What it proves, by reading back what would actually be DELIVERED rather than
// a status code:
//   - a formatted announcement reaches the email as headings, lists, bold and
//     italic, inside the house template;
//   - the queue carries a FORMAT and no pre-rendered htmlBody — that
//     short-circuit is what used to skip the house template entirely;
//   - a plain announcement invents nothing from its underscores and dashes;
//   - a client cannot post one.
//
// Every reading asserts its own precondition first and ABORTS rather than
// report a vacuous pass on an empty result.
//
//   DATA_STORE=memory MFA_ENFORCE=false JWT_SECRET=probe PORT=3271 node server.js
//   node scripts/verify_client_announcements.js
const BASE = process.env.GFC_PROBE_BASE || 'http://localhost:3271';
const S = Date.now();
const call = async (m, p, tok, body) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
};

// The preview endpoint serves text/html, not JSON, so it needs its own read.
const getHtml = async (p, tok) => {
  const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${tok}` } });
  return r.ok ? await r.text() : null;
};

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? '\n         ' + JSON.stringify(detail).slice(0, 400) : '')); }
};

(async () => {
  const admin = (await call('POST', '/api/auth/login', null, {
    email: 'admin@godwinsfamilycarellc.com', password: 'gfcforever2026'
  })).body?.token;
  if (!admin) { console.log('  FAIL could not sign in'); process.exit(1); }

  // A client who will receive it.
  const email = `ann.client.${S}@example.test`;
  await call('POST', '/api/users', admin, {
    email, password: 'Probe12345!', name: `Ann Client ${S} (TEST DATA)`, role: 'client',
    practiceName: `Ann Probe ${S} (TEST DATA)`, sendWelcomeEmail: false
  });

  console.log('\nA FORMATTED client announcement');
  const markup = '## This month\n- **Flu shots** are available\n- _Call us_ to book\n1. Ring the office';
  const post = await call('POST', '/api/announcements', admin, {
    title: `Clinic news ${S}`, content: markup, format: 'markup'
  });
  ok('it posts', post.status === 200, post.body);
  ok('and the row records that it was written in the editor', post.body && post.body.body_format === 'markup', post.body && post.body.body_format);

  await new Promise(r => setTimeout(r, 1200));
  const q = (await call('GET', '/api/admin/notifications/queue', admin)).body;
  const rows = (Array.isArray(q) ? q : []).filter(n => n && n.type === 'announcement' && String(n.templateData?.subject || '').includes(String(S)));
  ok('PRECONDITION — it reached the queue', rows.length >= 1, rows.length);
  if (!rows.length) { console.log('  ABORT: nothing queued, nothing below would prove anything.'); process.exit(1); }

  const row = rows[0];
  ok('the queue carries the markup format, not a pre-rendered body',
    row.templateData.format === 'announcement-markup', row.templateData.format);
  ok('⚠️ and NO htmlBody — that short-circuit is what used to skip the house template',
    !row.templateData.htmlBody, row.templateData.htmlBody ? 'htmlBody present' : 'absent');

  // What would actually be delivered.
  const html = await getHtml(`/api/admin/notifications/preview/${row.id}`, admin);
  ok('PRECONDITION — a preview rendered', !!html && html.length > 200, html && html.length);
  ok('the delivered email is in the HOUSE template', /Godwins/.test(html || ''));
  ok('a heading arrives as a styled heading', /<h3 style="[^"]*font-weight:700/.test(html || ''));
  ok('a bulleted list arrives as a list with padding', /<ul style="[^"]*padding-left/.test(html || ''));
  ok('bold and italic arrive as bold and italic', /<strong>Flu shots<\/strong>/.test(html || '') && /<em>Call us<\/em>/.test(html || ''));
  ok('a numbered list arrives numbered', /<ol style="[^"]*padding-left/.test(html || ''));

  console.log('\nA PLAIN client announcement is still read literally');
  const plain = await call('POST', '/api/announcements', admin, {
    title: `Plain news ${S}`, content: 'snake_case stays\n- not a bullet'
  });
  ok('it posts with no format', plain.status === 200 && plain.body.body_format === 'plain', plain.body && plain.body.body_format);
  await new Promise(r => setTimeout(r, 1200));
  const q2 = (await call('GET', '/api/admin/notifications/queue', admin)).body;
  const prow = (Array.isArray(q2) ? q2 : []).find(n => n && String(n.templateData?.subject || '').includes('Plain news'));
  ok('PRECONDITION — the plain one queued', !!prow, !!prow);
  if (prow) {
    ok('it asks for the plain reading', prow.templateData.format === 'announcement', prow.templateData.format);
    const h2 = await getHtml(`/api/admin/notifications/preview/${prow.id}`, admin);
    ok('and no formatting is invented from its underscores or dashes',
      !!h2 && !/<em>/.test(h2) && !/<ul/.test(h2) && /snake_case stays/.test(h2));
  }

  console.log('\nWho may post');
  const client = (await call('POST', '/api/auth/login', null, { email, password: 'Probe12345!' })).body?.token;
  if (client) {
    const nope = await call('POST', '/api/announcements', client, { title: 'x', content: 'y' });
    ok('a client cannot post one', nope.status === 403, nope.status);
  } else { ok('a client account signed in for the gate check', false, 'no token'); }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE CRASHED', e.message); process.exit(1); });
