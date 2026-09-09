// ============================================================
// Consent registry + body text invariants (build-fail guards)
//
// The consent set is the enrollment gate and the signed legal record, so the
// failures worth guarding here are the SILENT ones: a consent that renders blank
// and is still signable, a home care agency taking a medical consent it cannot
// take, and paper-packet instructions ported into an app where they are false.
//
// Source of truth: docs/GFC_Consent_Source_Text_v2_1.md
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8');

const REGISTRY = SERVER.match(/const GFC_CONSENT_DEFS = \[([\s\S]*?)\n\];/)[1];
const ENTRIES = [...REGISTRY.matchAll(
  /type: '(\w+)',\s*scope: '(\w+)',\s*stage: '(\w+)',\s*required: (true|false)(?:,\s*title: '([^']*)')?(,\s*inactive: true)?/g
)].map(m => ({ type: m[1], scope: m[2], stage: m[3], required: m[4] === 'true', inactive: !!m[6] }));

const BODY_BLOCK = PORTAL.match(/const CONSENT_BODY = \{([\s\S]*?)\n    \};/)[1];
const BODY_KEYS = [...BODY_BLOCK.matchAll(/^      (\w+): \(<React\.Fragment>/gm)].map(m => m[1]);
const bodyOf = (key) => {
  const i = BODY_BLOCK.indexOf(`      ${key}: (<React.Fragment>`);
  if (i < 0) return '';
  const next = BODY_KEYS.map(k => BODY_BLOCK.indexOf(`      ${k}: (<React.Fragment>`)).filter(x => x > i).sort((a, b) => a - b)[0];
  return BODY_BLOCK.slice(i, next === undefined ? BODY_BLOCK.length : next);
};

test('every consent in the registry has a body, and every body is in the registry', () => {
  assert.equal(ENTRIES.length, 14, 'the approved source text defines fourteen records');
  const types = ENTRIES.map(e => e.type);
  for (const t of types) {
    assert.ok(BODY_KEYS.includes(t), `${t} is offered for signature with no text to read`);
  }
  for (const k of BODY_KEYS) {
    assert.ok(types.includes(k), `${k} has body text but no registry entry — it can never be shown`);
  }
});

test('the signature block is gated on the body existing', () => {
  // Without this a missing body renders an empty box with a live signature block
  // under it: the client signs nothing and the enrollment gate counts it done.
  assert.match(PORTAL, /const hasBody = !!CONSENT_BODY\[def\.type\];/);
  assert.match(PORTAL, /\{!signed && hasBody && \(/,
    'the signature block must require hasBody, not just !signed');
});

test('scope math matches the approved source: 9 home care, 10 medical, 13 both', () => {
  const active = ENTRIES.filter(e => !e.inactive);
  const sees = (line) => active.filter(e => e.scope === 'both' || e.scope === line).length;
  assert.equal(sees('phc'), 9);
  assert.equal(sees('ihpc'), 10);
  assert.equal(active.length, 13);

  // serviceAgreement is home care only; an IHPC patient signs ihpcServiceAgreement.
  assert.equal(ENTRIES.find(e => e.type === 'serviceAgreement').scope, 'phc');
  assert.equal(ENTRIES.find(e => e.type === 'ihpcServiceAgreement').scope, 'ihpc');
});

test('the medical packet is a separate stage from home care', () => {
  // The paper instruction "do not sign this on the same visit as home care" is
  // not ported as a sentence; it is this split. Every IHPC-only record is staged
  // `medical`, everything else `homecare`.
  for (const e of ENTRIES) {
    assert.equal(e.stage, e.scope === 'ihpc' ? 'medical' : 'homecare', `${e.type} is staged wrong`);
  }
  assert.ok(ENTRIES.some(e => e.stage === 'medical'), 'a medical stage must exist');
});

test('the home care agency does not take a consent to medical treatment', () => {
  // The pre-2026-09 text read "In a medical emergency, I authorize emergency
  // treatment and transport as needed" on a PRIVATE HOME CARE consent. A home
  // care provider licensed under PHCP013073 cannot take that consent. This is
  // the highest-priority correction in the approved source text.
  const body = bodyOf('emergencyFinancial');
  assert.ok(body, 'emergencyFinancial must have a body');
  assert.match(body, /not a consent to medical treatment/i,
    'emergencyFinancial must disclaim that it authorizes treatment');
  assert.match(body, /caregivers are[\s\S]{0,40}not[\s\S]{0,20}clinicians/i);
  assert.doesNotMatch(body, /I authorize emergency treatment/i,
    'a home care agency must never take a consent to treat');
});

test('paper-packet mechanics are not ported into the app', () => {
  // These are instructions for handling a stack of paper. In an app that knows
  // what is signed they are false, and "sign this in one sitting" is the exact
  // opposite of the staged flow.
  const PAPER_ONLY = [
    /packet \d of \d/i,
    /signed in one sitting/i,
    /take this packet away/i,
    /do not sign again/i,
    /nothing here requires a computer/i
  ];
  for (const key of BODY_KEYS) {
    const body = bodyOf(key);
    for (const re of PAPER_ONLY) {
      assert.doesNotMatch(body, re, `${key} carries a paper-packet instruction (${re})`);
    }
  }
});

test('the anti-tying language survives, in both agreements', () => {
  // This reads like packet chrome and is not: it is what separates a licensed
  // home care agency from a medical practice, and it must stay in the record.
  assert.match(bodyOf('ihpcServiceAgreement'), /under no obligation to sign/i);
  assert.match(bodyOf('ihpcServiceAgreement'), /home care does not change/i);
  assert.match(bodyOf('serviceAgreement'), /never a condition of receiving medical care/i);
});

test('cross-references are by name, never by document number', () => {
  // The packet renumbered from ten documents to nine, and both the source text
  // and the packet PDF still carry stale numbers. A client in the app sees
  // titled consents, so a number can only ever be wrong.
  for (const key of BODY_KEYS) {
    assert.doesNotMatch(bodyOf(key), /\bDocument \d/,
      `${key} refers to a document by number; use its name`);
  }
});

test('an inactive consent cannot be signed', () => {
  const monitoring = ENTRIES.find(e => e.type === 'monitoring');
  assert.ok(monitoring.inactive);
  assert.equal(monitoring.required, false);
  assert.match(PORTAL, /Not available to sign while this service is inactive/);
  assert.doesNotMatch(PORTAL, /onClick=\{\(\) => handleSign\(true\)\}/,
    'the inactive opt-in/out buttons wrote a consent record for a service that does not run');
});

test('the counsel-review disclaimer is gone now that the real text is in', () => {
  assert.doesNotMatch(PORTAL, /Working draft — pending counsel/);
});
