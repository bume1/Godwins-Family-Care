// The client-creation form, and correcting prefilled data from inside a consent.
//
// Two changes with one thing in common: the lab app treated a client as a
// PRACTICE, and the leftovers of that were still on screen. A practice logo
// painted across a person's portal, HubSpot deal-id boxes on an enrollment
// form, and consent data that could be read but never corrected.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CONSENT_TEXT = require('../public/consent-text.js');

// Pull the CONSENT_DATA_FIELDS literal out of the page and evaluate just that
// object. Parsing the whole React file is not possible here, and asserting on
// the raw text would pass on a commented-out copy.
function consentDataFields() {
  const src = read('public/portal.html');
  const start = src.indexOf('const CONSENT_DATA_FIELDS = {');
  assert.notStrictEqual(start, -1, 'CONSENT_DATA_FIELDS is gone');
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notStrictEqual(end, -1, 'CONSENT_DATA_FIELDS literal is unbalanced');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src.slice(open, end)};`)();
}

// ===========================================================================
// The client-creation form
// ===========================================================================

test('the HubSpot id boxes are gone from the client form', () => {
  const src = read('public/admin-hub.html');
  assert.ok(!/placeholder="HubSpot Company ID"/.test(src), 'the Company ID input is still rendered');
  assert.ok(!/placeholder="HubSpot Deal ID"/.test(src));
  assert.ok(!/placeholder="HubSpot Contact ID"/.test(src));
  assert.ok(!/>HubSpot Integration</.test(src), 'the section heading is still rendered');
});

test('but the HubSpot FIELDS still round-trip — the connector is dormant, not deleted', () => {
  // CLAUDE.md is explicit that the lab CRM connector is retained for a future
  // reactivation. Removing the inputs must not remove the data path, or the
  // values already on existing records would be wiped on the next user save.
  const hub = read('public/admin-hub.html');
  assert.match(hub, /hubspotCompanyId: user\.hubspotCompanyId/, 'the edit form no longer loads the stored value');
  assert.match(hub, /hubspotCompanyId: ''/, 'formData no longer carries the field');
  const server = read('server.js');
  assert.match(server, /newUser\.hubspotCompanyId = hubspotCompanyId/);
});

test('the client name field is labelled Name, and still writes practiceName', () => {
  const src = read('public/admin-hub.html');
  assert.match(src, /className="block text-sm font-medium text-gray-700 mb-1">Name \{!formData\.existingPortalSlug/);
  assert.ok(!/>Practice Name /.test(src), 'the old label is still on screen');
  // The key is what generates the portal slug. Renaming it would change the
  // URL of every portal already issued.
  assert.match(src, /setFormData\(\{ \.\.\.formData, practiceName: e\.target\.value \}\)/);
  assert.match(read('server.js'), /newUser\.slug = await generateClientUserSlug\(practiceName\)/);
});

test('the image upload asks for a headshot, not a logo', () => {
  const src = read('public/admin-hub.html');
  assert.match(src, />Client Photo</);
  assert.ok(!/>Practice Logo</.test(src));
  assert.match(src, /Upload Photo/);
  assert.ok(!/\{Icons\.upload\} Upload Logo/.test(src));
});

test('the client photo renders as an avatar, and never as the portal branding', () => {
  const src = read('public/portal.html');
  // The sidebar brand is GFC's wordmark unconditionally. A client's face where
  // the provider's logo belongs reads as their site, not ours.
  const sidebar = src.slice(src.indexOf('<aside className='), src.indexOf('<aside className=') + 1200);
  assert.ok(!/user\?\.logo/.test(sidebar), 'the client image is still used as the sidebar brand');
  assert.match(sidebar, /logo-full-color-transparent\.png/);
  // And the hero uses it round and small, not stretched across the banner.
  assert.ok(!/max-w-\[200px\]/.test(src), 'the banner-sized render is still there');
  assert.match(src, /data\.user\.logo[\s\S]{0,200}rounded-full/);
});

// ===========================================================================
// Correcting prefilled consent data
// ===========================================================================

test('a client can correct prefilled data without leaving the consent', () => {
  const fields = consentDataFields();
  // The blocks that actually carry face-sheet detail are editable in place.
  for (const source of ['parties', 'careCoordinationContacts', 'faceSheetEmergency', 'callOrder', 'advanceDirective']) {
    assert.ok(fields[source] && Array.isArray(fields[source].fields) && fields[source].fields.length,
      `${source} should be correctable from inside the consent`);
  }
});

test('the RATE is the one value a client may never edit inside the document that prints it', () => {
  const fields = consentDataFields();
  assert.ok(fields.rateTable, 'rateTable should still be described');
  assert.ok(!fields.rateTable.fields, 'a client editing their own agreed rate is the edit this must never allow');
  assert.match(fields.rateTable.note, /office/i, 'and it says who to ask instead');
});

test('every data source a consent renders is either editable or says where to edit it', () => {
  // A source with no entry at all renders as silently read-only, which is the
  // state this change exists to remove.
  const fields = consentDataFields();
  const used = new Set();
  CONSENT_TEXT.types().forEach(t => CONSENT_TEXT.dataSourcesFor(t).forEach(s => used.add(s)));
  assert.ok(used.size > 5, 'sanity: the consent bodies do render data blocks');
  for (const source of used) {
    const spec = fields[source];
    assert.ok(spec, `${source} has no entry in CONSENT_DATA_FIELDS`);
    const usable = (spec.fields && spec.fields.length) || spec.note || spec.step;
    assert.ok(usable, `${source} neither edits nor explains where to edit`);
  }
});

test('the editor writes STRUCTURED fields, never the rendered line', () => {
  // "CVS Main St · 770-555-1234" is two fields joined for display. Editing the
  // string would have no way back to the pair, and the matching and billing
  // engines read the pair.
  const fields = consentDataFields();
  for (const [source, spec] of Object.entries(fields)) {
    for (const f of spec.fields || []) {
      assert.ok(f.path && f.label, `${source} field is missing a path or a label`);
      assert.ok(!/\s/.test(f.path), `${source}.${f.path} looks like a label, not a field path`);
    }
  }
});

test('a correction saves through the SAME intake endpoint every wizard step uses', () => {
  const src = read('public/portal.html');
  const at = src.indexOf('const handleConsentDataEdit');
  assert.notStrictEqual(at, -1);
  const body = src.slice(at, at + 1400);
  assert.match(body, /api\.saveGfcIntake\(/,
    'a second write path here would be a second set of validation and mirroring rules');
  // And it re-reads, because the rendered values are resolved on the SERVER.
  assert.match(body, /api\.getGfcIntake\(/,
    'local state alone would show a correction the signed copy would not carry');
});

test('the correction is persisted BEFORE a signature can be taken', () => {
  const src = read('public/portal.html');
  const at = src.indexOf('const save = async () => {');
  const body = src.slice(at, at + 600);
  const saveAt = body.indexOf('await onSaveEdits(');
  const closeAt = body.indexOf('setEditing(false)');
  assert.ok(saveAt !== -1 && closeAt !== -1 && saveAt < closeAt,
    'the editor closes only after the save resolves — otherwise the old value prints on the signed copy');
});

test('a signed consent cannot be edited underneath its own signature', () => {
  // A correction after signing is not an edit, it is a new signature on a
  // changed document.
  const src = read('public/portal.html');
  assert.match(src, /form=\{form\} onSaveEdits=\{onSaveEdits\} locked=\{readOnly\}/);
  assert.match(src, /const canEdit = !locked &&/);
});
