// "ALL emails need the same brand" — owner instruction, 2026-09-13.
//
// Saying it once is not enough, because the failure is silent: an email that
// carries its own HTML looks like ordinary code and arrives looking like a
// different company. Five did. This file is the guard that makes the rule
// hold — it fails the build the next time anyone hand-rolls email markup.
//
// The five found on 2026-09-13, all now rendering through emailTemplates:
//   welcome (fixed in PR #81), announcement, enrollment confirmation,
//   admin password reset, and the two ROI emails in legacySync.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Every file that builds or sends mail, DISCOVERED rather than listed.
// A hardcoded list is the wrong tool here: `phcNotifications.js` became
// `notifications.js` an hour after this guard was written, and a list either
// crashes on the missing path or — worse, if someone "fixes" it by deleting
// the entry — quietly stops checking a real sender. Anything that pulls in the
// mailer or the template is a sender by definition.
// emailTemplates.js is the one place allowed to contain markup, which is the
// whole point of it.
function discoverSenders() {
  const dirs = ['.', 'scripts', 'routes'];
  const found = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.js')) continue;
      const rel = dir === '.' ? f : `${dir}/${f}`;
      if (rel === 'emailTemplates.js') continue;
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      // TWO signals, and the second one is why this guard missed eleven notice
      // types until 2026-09-13. `routes/messaging.js`, `routes/scheduling.js`
      // and `routes/caregiver.js` require NEITHER the mailer nor the template —
      // they are handed an injected `queueNotification` by server.js. On the
      // require signal alone they were invisible to every sweep below, and all
      // three were sending bare text/plain. A sender is anything that can put
      // an email in front of a person, however it reaches the transport.
      const requiresMailer = /require\(['"]\.{1,2}\/(email|emailTemplates)['"]\)/.test(src);
      const queuesMail = /queueNotification\s*\(/.test(src);
      if (requiresMailer || queuesMail) found.push(rel);
    }
  }
  return found;
}
const SENDERS = discoverSenders();

// The house palette. Hardcoded anywhere but the template means someone is
// painting their own chrome instead of using it.
const HOUSE_HEXES = ['#033D50', '#F5CD85', '#FAF7F2'];

test('the sender sweep actually finds the senders', () => {
  // A guard that scans an empty list passes forever and proves nothing.
  assert.ok(SENDERS.length >= 4, `expected several senders, found ${SENDERS.length}: ${SENDERS.join(', ')}`);
  for (const must of ['server.js', 'legacySync.js', 'notifications.js']) {
    assert.ok(SENDERS.includes(must), `${must} sends mail and must be swept`);
  }
  // The three that the require-only signal missed. Named explicitly because
  // their absence is the exact hole this guard had, and a regression in the
  // discovery rule should fail here rather than pass quietly on a shorter list.
  for (const must of ['routes/messaging.js', 'routes/scheduling.js', 'routes/caregiver.js']) {
    assert.ok(SENDERS.includes(must), `${must} queues email and must be swept`);
  }
});

test('no sender hardcodes the house palette — emailTemplates owns it', () => {
  for (const file of SENDERS) {
    const src = read(file);
    for (const hex of HOUSE_HEXES) {
      assert.ok(
        !src.toUpperCase().includes(hex.toUpperCase()),
        `${file} hardcodes ${hex}. Email chrome belongs in emailTemplates.js — render through renderGfcEmail instead.`
      );
    }
  }
});

test('no sender builds an email-width wrapper of its own', () => {
  // A max-width in the 480-680 range is an email body wrapper; nothing else in
  // this codebase has a reason to declare one.
  const wrapper = /max-width:\s*(4[89]\d|5\d\d|6[0-8]\d)px/i;
  for (const file of SENDERS) {
    const src = read(file);
    const m = src.match(wrapper);
    assert.ok(!m, `${file} declares its own email wrapper (${m && m[0]}). Use renderGfcEmail.`);
  }
});

test('the lab-era chrome helpers are gone, not merely unused', () => {
  const src = read('server.js');
  for (const dead of ['emailHeaderHtml', 'emailFooterNote', 'BASE_HTML_EMAIL_WRAPPER', 'buildHtmlEmailLegacy']) {
    assert.ok(!src.includes(dead), `${dead} is still in server.js — it is the pre-house-template chrome and it will get used again`);
  }
});

test('no shipped email template carries its own htmlBody', () => {
  const src = read('server.js');
  const block = src.slice(src.indexOf('const DEFAULT_EMAIL_TEMPLATES'), src.indexOf('async function getEmailTemplates'));
  assert.ok(block.length > 500, 'could not locate DEFAULT_EMAIL_TEMPLATES');
  // Read each value rather than a lookahead: `\s*` backtracks to zero width,
  // so /htmlBody:\s*(?!null)/ passes on `htmlBody: null` and proves nothing.
  const values = [...block.matchAll(/htmlBody:[ \t]*([^\n]*)/g)].map(m => m[1].trim());
  assert.ok(values.length >= 8, `expected the shipped templates to declare htmlBody; found ${values.length}`);
  for (const v of values) {
    assert.ok(
      /^null\s*,?$/.test(v),
      `a shipped template defines htmlBody (${v.slice(0, 60)}). buildHtmlEmail returns a caller-supplied htmlBody untouched, so that template silently opts out of the house style.`
    );
  }
});

test('legacySync renders through the house template', () => {
  const src = read('legacySync.js');
  assert.ok(src.includes("require('./emailTemplates')"), 'legacySync must use the house template');
  assert.ok(!src.includes('<!DOCTYPE html>'), 'legacySync must not build its own email document');
});

// ---- the two legacySync emails, rendered for real -------------------------

const legacySync = require('../legacySync');

test('the ROI patient confirmation is in the house style and names no client', () => {
  const html = legacySync.buildPatientEmailHtml('Ada Bell');
  assert.match(html, /Godwins-llc-3\.png/, 'the header logo should be present');
  assert.match(html, /The Godwins Family Care Team/, 'the signature block should be present');
  // It reaches the patient, so it says support@ like every other client email.
  assert.ok(!html.includes('info@'), 'the retired info@ address must not appear');
  // Greeting only. Their surname adds nothing and email is a push channel.
  assert.ok(!html.includes('Bell'), 'the confirmation should not carry the full name');
});

test('the ROI admin email keeps the reference and every filename', () => {
  const html = legacySync.buildAdminEmailHtml(
    'Ada Bell', 'tok_abc123',
    ['ROI_Bell_Emory.pdf', 'ROI_Bell_Piedmont.pdf'],
    ['https://drive.google.com/a', 'https://drive.google.com/b']
  );
  assert.match(html, /tok_abc123/, 'the reference is what staff match the PDF against');
  assert.match(html, /ROI_Bell_Emory\.pdf/);
  assert.match(html, /ROI_Bell_Piedmont\.pdf/, 'every provider file must be listed, not just the first');
  assert.match(html, /Godwins-llc-3\.png/);
});

test('a single Drive link becomes the button; several are listed instead', () => {
  const one = legacySync.buildAdminEmailHtml('Ada Bell', 'tok', ['a.pdf'], ['https://drive.google.com/only']);
  assert.match(one, /View in Drive/, 'one link should be the call to action');

  const many = legacySync.buildAdminEmailHtml('Ada Bell', 'tok', ['a.pdf', 'b.pdf'],
    ['https://drive.google.com/a', 'https://drive.google.com/b']);
  assert.match(many, /drive\.google\.com\/a/);
  assert.match(many, /drive\.google\.com\/b/, 'both links must survive — picking one arbitrarily loses a file');
});

// ---- clearing the chrome that is already in the live store ----------------

test('the announcement migration exists and runs in the one boot chain', () => {
  const src = read('server.js');
  assert.ok(src.includes('async function migrateAnnouncementTemplateChrome()'), 'the migration must exist');
  assert.ok(
    src.includes('await migrateAnnouncementTemplateChrome();'),
    'it must run at boot, in the same sequential chain as the others — parallel read-modify-writes of one blob lose a write'
  );
});

test('the migration matches the chrome that is ACTUALLY in the live store', () => {
  // The strongest available check. Take the shipped default as it stood before
  // this change, EXPAND its template-literal interpolations the way Node did
  // when it seeded the store, and confirm the markers identify the result.
  // Matching the source text alone would prove nothing: the chrome reaches the
  // stored value through `${emailHeaderHtml()}`, so the marker strings appear
  // nowhere in the announcement block itself.
  const { execFileSync } = require('child_process');
  let previous;
  try {
    previous = execFileSync('git', ['show', 'HEAD:server.js'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return; // shallow checkout, no history; the other guards still hold
  }
  const i = previous.indexOf("id: 'announcement',");
  if (i === -1) return;
  const shipped = previous.slice(i, previous.indexOf('variables:', i));
  if (!shipped.includes('htmlBody: `')) return; // already cleared in an earlier commit

  // Rebuild the two helpers exactly as they were and expand the interpolations.
  const brand = require('../config').BRAND;
  const grab = (name) => {
    const at = previous.indexOf(`const ${name} = `);
    assert.notStrictEqual(at, -1, `${name} should exist in the previous revision`);
    return previous.slice(at, previous.indexOf('\n};', at) + 3)
      .replace(`const ${name} = `, '').replace(/;\s*$/, '');
  };
  const EMAIL_BRAND = () => ({ company: brand.COMPANY_NAME, primary: brand.PRIMARY_COLOR, accent: brand.ACCENT_COLOR });
  const emailHeaderHtml = eval(`(${grab('emailHeaderHtml')})`);
  const emailFooterNote = eval(`(${grab('emailFooterNote')})`);
  const expanded = shipped
    .replace('${emailHeaderHtml()}', emailHeaderHtml())
    .replace(/\$\{emailFooterNote\('[^']*'\)\}/, emailFooterNote('a client portal account'));

  const src = read('server.js');
  const markers = [...src.matchAll(/const LEGACY_CHROME_MARKERS = \[([^\]]*)\]/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  assert.ok(markers.length >= 2, 'the migration should identify the chrome by more than one marker');
  for (const marker of markers) {
    assert.ok(
      expanded.includes(marker),
      `marker ${JSON.stringify(marker)} does not appear in the chrome that was actually stored, so the migration would never fire`
    );
  }
});

test('the migration leaves HTML an admin wrote themselves alone', () => {
  const src = read('server.js');
  const fn = src.slice(
    src.indexOf('async function migrateAnnouncementTemplateChrome()'),
    src.indexOf('async function migrateConsentLaneSplit()')
  );
  assert.ok(fn.includes('.every('), 'every marker must match before anything is cleared');
  assert.ok(/kept\s*\+=\s*1/.test(fn), 'custom HTML must be counted and reported, not silently cleared');
  assert.ok(!/splice|delete |= \[\]/.test(fn), 'the migration clears one field; it never removes a template');
});

test('an announcement renders through the house template, with its structure intact', () => {
  const src = read('server.js');
  const site = src.slice(src.indexOf("const annTpl = getTemplateById"), src.indexOf('if (result) queued++'));
  assert.ok(site.includes('emailTemplates.renderGfcEmail'), 'the fallback must be the house template');
  // The pieces that make an announcement more than prose.
  assert.ok(site.includes('newAnnouncement.priority'), 'priority must reach the template');
  assert.ok(site.includes('newAnnouncement.attachmentUrl'), 'the attachment must reach the template');
  assert.ok(site.includes('annHtml\n            ? renderTemplate') || /annHtml\s*\n?\s*\?/.test(site),
    "an admin's own HTML still wins — the migration decides what is stored, not the send site");
});

test('the migration, RUN for real, clears the shipped chrome and keeps custom HTML', async () => {
  // Extracted and executed rather than read. Requiring server.js boots a
  // server, so the function is lifted out of the source and given a fake store
  // — the same technique the welcome-email guard uses. Reading the code and
  // believing it is exactly how the announcement chrome survived PR #76.
  const src = read('server.js');
  const from = src.indexOf('const LEGACY_CHROME_MARKERS');
  const to = src.indexOf('async function migrateConsentLaneSplit()');
  assert.ok(from !== -1 && to > from, 'could not lift the migration out of server.js');

  const rows = [
    { id: 'announcement', htmlBody: '<div style="border-bottom: 3px solid #033D50">x</div>' +
        '<p>You are receiving this because you have a client portal account.</p>' },
    { id: 'hand_written', htmlBody: '<div>something an admin wrote themselves</div>' },
    { id: 'already_clean', htmlBody: null }
  ];
  let written = null;
  const db = {
    get: async () => rows,
    set: async (_k, v) => { written = v; }
  };
  const logs = [];
  const console = { log: (m) => logs.push(String(m)) };

  const fn = new Function('db', 'console', `${src.slice(from, to)}\nreturn migrateAnnouncementTemplateChrome;`)(db, console);
  const result = await fn();

  assert.strictEqual(result.cleared, 1, 'exactly the shipped chrome should be cleared');
  assert.strictEqual(result.kept, 1, 'the hand-written template should be counted as kept');
  assert.strictEqual(rows[0].htmlBody, null, 'the announcement must end up on the house template');
  assert.strictEqual(rows[1].htmlBody, '<div>something an admin wrote themselves</div>',
    "an admin's own HTML must survive untouched");
  assert.ok(written, 'the change must be persisted, not just made in memory');
  assert.ok(logs.some(l => /hand_written/.test(l)), 'a template left alone must be reported, not silent');

  // Idempotent: nothing is left to match.
  written = null;
  const again = await fn();
  assert.strictEqual(again.cleared, 0, 'a second run must clear nothing');
  assert.strictEqual(written, null, 'a second run must not write');
});

test('the migration writes nothing when the store has no templates yet', async () => {
  const src = read('server.js');
  const from = src.indexOf('const LEGACY_CHROME_MARKERS');
  const to = src.indexOf('async function migrateConsentLaneSplit()');
  let written = false;
  const db = { get: async () => null, set: async () => { written = true; } };
  const fn = new Function('db', 'console', `${src.slice(from, to)}\nreturn migrateAnnouncementTemplateChrome;`)(db, { log: () => {} });
  const result = await fn();
  assert.deepStrictEqual(result, { cleared: 0, kept: 0 });
  assert.strictEqual(written, false, 'a fresh store must not be written to by the migration');
});

// ===========================================================================
// The queue drain — the last place a notice can pick up the house template,
// and until 2026-09-13 it did not try.
//
// Reported live: a message-received notification arrived as bare text/plain
// while every notice from `notifications.js` was branded. The drain forwarded
// `templateData.htmlBody` straight through, so a caller that queued a plain
// body and no HTML sent no HTML. ELEVEN notice types did exactly that.
//
// These guards RUN the real builder rather than reading it, the technique the
// welcome-email and appointment guards use: the functions are lifted out of
// server.js by source (requiring server.js boots a server) and executed.
// ===========================================================================

const emailTemplates = require('../emailTemplates');

const QUEUE_BUILDERS = (() => {
  const src = read('server.js');
  const from = src.indexOf('function buildHtmlEmail(');
  const to = src.indexOf('// ============================================================\n// VARIABLE POOLS', from);
  assert.ok(from !== -1 && to > from, 'could not locate the email builders in server.js');
  const block = src.slice(from, to);
  // eslint-disable-next-line no-new-func
  return new Function('emailTemplates', `${block}\nreturn { buildHtmlEmail, emailPiecesFromBody, absoluteEmailUrl, buildQueuedEmail };`)(emailTemplates);
})();

const BASE = 'https://app.godwinsfamilycarellc.com';
const houseMarkers = (html) => ({
  logo: /Godwins-llc-3\.png/.test(html),
  signature: /The Godwins Family Care Team/.test(html)
});

test('a queued notice with NO htmlBody is branded by the drain', () => {
  // This is the reported defect, stated as a behaviour. Before the fix this
  // returned no HTML at all and the email left as text/plain.
  const built = QUEUE_BUILDERS.buildQueuedEmail({
    body: 'Bethel Godwins sent you a message about a client. Open the portal to read it.',
    ctaUrl: '/portal',
    ctaLabel: 'Open messages'
  }, BASE);

  assert.ok(built.html, 'the drain must produce HTML for a caller that supplied none');
  const m = houseMarkers(built.html);
  assert.ok(m.logo, 'the house header logo is missing — this is not the house template');
  assert.ok(m.signature, 'the house signature is missing — this is not the house template');
});

test('a relative CTA is made absolute, so the button is not silently dropped', () => {
  // Every queued ctaUrl in this repo is an app PATH. `safeUrl` accepts only
  // http(s), so an unresolved path renders NO button and no link in the text
  // half either — the reader is told to open the portal and given no way in.
  const built = QUEUE_BUILDERS.buildQueuedEmail(
    { body: 'A shift was assigned to you.', ctaUrl: '/caregiver', ctaLabel: 'Open your schedule' }, BASE);

  assert.match(built.html, /href="https:\/\/app\.godwinsfamilycarellc\.com\/caregiver"/,
    'the CTA must resolve against the app base URL');
  assert.match(built.text, /https:\/\/app\.godwinsfamilycarellc\.com\/caregiver/,
    'the text half must carry the link too — a text-only client otherwise gets no address at all');
});

test('both halves come from ONE render and cannot disagree', () => {
  const built = QUEUE_BUILDERS.buildQueuedEmail(
    { body: 'Hi Ada,\n\nYour visit is confirmed.', ctaUrl: '/portal', ctaLabel: 'Open your portal' }, BASE);
  assert.match(built.text, /Your visit is confirmed\./);
  assert.match(built.html, /Your visit is confirmed\./);
  // The greeting is lifted out of the prose and rendered by the TEMPLATE. It
  // must therefore appear exactly once - the failure mode is it surviving as a
  // body paragraph as well, so the reader is greeted twice.
  assert.strictEqual((built.html.match(/Hi Ada,/g) || []).length, 1, 'the greeting should be rendered once, by the template');
  assert.strictEqual((built.text.match(/Hi Ada,/g) || []).length, 1, 'the text half should greet once too');
});

test('a link that cannot be made absolute is dropped, never printed broken', () => {
  // Asserted at the resolver FIRST. The end-to-end check below passes either
  // way, because the template's own `safeUrl` refuses a non-http href — so on
  // its own it cannot tell "we dropped it" from "we handed over a dead path
  // and something downstream saved us". Both layers are worth having; only
  // this line proves this layer works.
  assert.strictEqual(QUEUE_BUILDERS.absoluteEmailUrl('/caregiver', ''), null);
  assert.strictEqual(QUEUE_BUILDERS.absoluteEmailUrl('/caregiver', 'not-a-url'), null);

  const built = QUEUE_BUILDERS.buildQueuedEmail(
    { body: 'A shift was assigned to you.', ctaUrl: '/caregiver', ctaLabel: 'Open your schedule' }, '');
  assert.ok(!/href="\/caregiver"/.test(built.html), 'a relative href in an inbox is a dead link');
  assert.ok(!/Open your schedule/.test(built.html), 'the button must be dropped with its dead link');
  // The message itself still goes.
  assert.match(built.html, /A shift was assigned to you\./);
});

test('an absolute CTA passes through untouched', () => {
  assert.strictEqual(QUEUE_BUILDERS.absoluteEmailUrl('https://drive.google.com/x', BASE), 'https://drive.google.com/x');
  assert.strictEqual(QUEUE_BUILDERS.absoluteEmailUrl('mailto:support@godwinsfamilycarellc.com', BASE), 'mailto:support@godwinsfamilycarellc.com');
  assert.strictEqual(QUEUE_BUILDERS.absoluteEmailUrl('', BASE), null);
  // No double slash when the base carries a trailing one.
  assert.strictEqual(QUEUE_BUILDERS.absoluteEmailUrl('/portal', 'https://x.com/'), 'https://x.com/portal');
});

test('a caller that DOES supply HTML still wins — that contract is unchanged', () => {
  const built = QUEUE_BUILDERS.buildQueuedEmail(
    { body: 'text', htmlBody: '<p>caller markup</p>', ctaUrl: '/portal' }, BASE);
  assert.strictEqual(built.html, '<p>caller markup</p>');
  assert.strictEqual(built.text, 'text');
});

test('the drain actually calls the builder — the fix is wired, not merely present', () => {
  const src = read('server.js');
  const from = src.indexOf('const processNotificationQueue');
  const to = src.indexOf('const cancelProjectNotifications', from);
  assert.ok(from !== -1 && to > from, 'could not locate processNotificationQueue');
  const drain = src.slice(from, to);
  assert.ok(drain.includes('buildQueuedEmail('), 'the drain must brand through buildQueuedEmail');
  assert.ok(!/html:\s*notification\.templateData\.htmlBody/.test(drain),
    'the drain must not forward a caller htmlBody raw — that is the bypass that shipped eleven plain-text notices');
});

test('EVERY queued notice in the repo renders to house HTML with a live link', () => {
  // Discovered, not listed. A new notice type is covered the day it is added.
  const dirs = ['.', 'routes'];
  const sites = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (!f.endsWith('.js')) continue;
      const rel = dir === '.' ? f : `${dir}/${f}`;
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      const re = /queueNotification\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        let i = m.index + m[0].length, depth = 1;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '(') depth++; else if (c === ')') depth--;
          i++;
        }
        const call = src.slice(m.index, i);
        if (call.length > 8000) continue;
        const type = (call.match(/queueNotification\(\s*['"`]([a-z_]+)/) || [])[1] || 'unknown';
        const cta = (call.match(/ctaUrl:\s*'([^']+)'/) || [])[1] || null;
        sites.push({ rel, type, cta, suppliesHtml: /htmlBody/.test(call) });
      }
    }
  }
  assert.ok(sites.length >= 10, `expected the repo to queue many notices; found ${sites.length}`);

  for (const s of sites) {
    if (s.suppliesHtml) continue; // its own HTML, covered by the contract test above
    const built = QUEUE_BUILDERS.buildQueuedEmail(
      { body: 'A notice body.', ctaUrl: s.cta, ctaLabel: 'Open' }, BASE);
    const m = houseMarkers(built.html);
    assert.ok(m.logo && m.signature, `${s.rel} (${s.type}) would send unbranded mail`);
    if (s.cta) {
      assert.ok(built.html.includes(`href="${BASE}${s.cta}"`),
        `${s.rel} (${s.type}) CTA ${s.cta} did not resolve to an absolute link`);
    }
  }
});

// ---- the address itself ---------------------------------------------------

test('no GFC address anywhere is on a domain other than godwinsfamilycarellc.com', () => {
  // A one-character typo in `config.DEFAULT_ADMIN.EMAIL` (the domain a letter
  // short) seeded the live admin account at an address that does not exist, so
  // every staff notification addressed to admin bounced. Nothing failed loudly:
  // the send succeeded and the bounce went to a mailbox nobody watches. This is
  // the durable guard, and it catches the class rather than the one instance.
  // The misspelling is deliberately not written out here: this file is inside
  // its own sweep, and a guard that trips on its own explanation is no guard.
  const dirs = ['.', 'routes', 'scripts', 'public', 'test'];
  const bad = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!/\.(js|json|md|example|html)$/.test(f) && f !== '.env.example') continue;
      const rel = dir === '.' ? f : `${dir}/${f}`;
      const full = path.join(root, rel);
      if (!fs.statSync(full).isFile()) continue;
      // Read raw. A regex literal in a test spells the domain with an escaped
      // dot, which this pattern simply does not match — so it is skipped, not
      // misread as a typo. Stripping the backslashes first was worse: it turned
      // a domain at the end of a line into `...com` plus the `n` of `\n`.
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/@(godwins[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
        if (m[1].toLowerCase() !== 'godwinsfamilycarellc.com') bad.push(`${rel}: @${m[1]}`);
      }
    }
  }
  assert.deepStrictEqual(bad, [], `misspelled GFC domain(s) found:\n  ${bad.join('\n  ')}`);
});

test('the default admin address is the real mailbox', () => {
  const cfg = require('../config');
  assert.strictEqual(cfg.DEFAULT_ADMIN.EMAIL, 'admin@godwinsfamilycarellc.com');
});
