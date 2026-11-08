#!/usr/bin/env node
// ============================================================================
// Run on the deployment: reads every onboarding source document from Drive
// through the app's own loader and prints what it found. This is the proof the
// sandbox cannot give: the readers were built against generated .docx files
// and the Playbook's HTML, never against the live Word files.
//
//   node scripts/verify_onboarding_sources.js
//
// Read-only. Writes the manual's section fingerprints to the data store only
// with --record, which is what the app itself does the first time it reads a
// manual version.
// ============================================================================

'use strict';

const drive = require('../googledrive');
const { SOURCES } = require('../onboarding/sources');
const C = require('../onboarding/chapterC');
const { MODULES } = require('../onboarding/modules');
const P = require('../onboarding/sourceParsers');
const VF = require('../onboarding/versionFlags');
const { createSourceLoader } = require('../onboarding/sourceLoader');

const memoryDb = () => { const s = {}; return { get: async (k) => s[k] || null, set: async (k, v) => { s[k] = v; } }; };

(async () => {
  let db = memoryDb();
  if (process.argv.includes('--record')) db = require('../dataStore').createStore();
  const L = createSourceLoader({ drive, db });
  let failures = 0;
  const say = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

  for (const key of Object.keys(SOURCES)) {
    const r = await L.load(key);
    if (!r.ok) { say(false, `${key}: ${r.code} — ${r.reason}`); continue; }
    say(!!r.version, `${key}: read ${r.lines.length} lines, version ${r.version || 'NOT FOUND'}` +
      (r.versionDiffers ? ` (catalog transcribed from ${r.transcribedFromVersion} — review the catalog)` : ''));
  }

  const pb = await L.load('PLAYBOOK');
  if (pb.ok) {
    const drift = P.verifyChapterClassifications(pb.lines, C.ITEMS, { section: 'C.2', next: 'C.3' });
    say(drift.length === 0, `Playbook C.2 classifications match the catalog${drift.length ? `: ${JSON.stringify(drift)}` : ''}`);
  }

  const m = await L.manualState();
  if (m.ok) {
    const flags = VF.evaluateAll(MODULES, { currentVersion: m.currentVersion, changeLog: m.changeLog });
    const flagged = flags.filter(f => f.status === VF.STATUS.FLAGGED).map(f => `${f.moduleId}[${f.hits}]`);
    say(true, `Manual ${m.currentVersion}: flagged ${flagged.join(', ') || 'none'}`);
  } else {
    say(false, `Manual state: ${m.code} — ${m.reason}`);
  }

  const ch = await L.checks();
  if (ch.ok) {
    for (const [sop, list] of Object.entries(ch.sops)) say(list.length > 0, `${sop}: ${list.length} check questions`);
    const withOwn = Object.entries(ch.library).filter(([, l]) => l.length).map(([id, l]) => `${id}(${l.length})`);
    say(withOwn.length > 0, `Library module checks: ${withOwn.join(', ')}`);
  } else {
    say(false, `Checks: ${JSON.stringify(ch.errors)}`);
  }

  console.log(failures ? `\n${failures} failed.` : '\nAll passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
