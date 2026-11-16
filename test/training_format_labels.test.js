'use strict';

// A training's label says what is actually attached (owner, 2026-11-16: "fix
// the video vs in app vs etc"). One rule on the server; every screen prints it.

const test = require('node:test');
const assert = require('node:assert');
const TM = require('../onboarding/trainingMaterial');
const { findModule } = require('../onboarding/modules');

const sop = { ready: true, sops: ['SOP-RX-01'], links: [], files: [] };
const doc = { ready: true, sops: [], links: [{ kind: 'document', label: 'Team Roles', url: 'https://x' }], files: [] };
const vid = { ready: true, sops: [], links: [{ kind: 'video', label: 'Walkthrough', url: 'https://x' }], files: [] };
const both = { ready: true, sops: [], links: [{ kind: 'video', label: 'V', url: 'https://x' }, { kind: 'document', label: 'D', url: 'https://y' }], files: [] };
const vidFile = { ready: true, sops: [], links: [], files: [{ mime: 'video/mp4' }] };
const none = { ready: false };

test('a "video" or "in the app" training reads as what is attached', () => {
  assert.deepStrictEqual(TM.shownFormat('VIDEO', sop), { format: 'READ', planned: false }, 'an SOP is read, not watched');
  assert.deepStrictEqual(TM.shownFormat('VIDEO', doc), { format: 'READ', planned: false });
  assert.deepStrictEqual(TM.shownFormat('IN_APP', doc), { format: 'READ', planned: false }, 'documents to read are not "in the app"');
  assert.deepStrictEqual(TM.shownFormat('VIDEO', vid), { format: 'VIDEO', planned: false });
  assert.deepStrictEqual(TM.shownFormat('VIDEO', vidFile), { format: 'VIDEO', planned: false });
  assert.deepStrictEqual(TM.shownFormat('VIDEO', both), { format: 'VIDEO + READ', planned: false });
  assert.deepStrictEqual(TM.shownFormat('READ', vid), { format: 'VIDEO', planned: false }, 'a read with a video attached says so');
  assert.deepStrictEqual(TM.shownFormat('VIDEO + OBSERVED', sop), { format: 'READ + OBSERVED', planned: false });
  assert.deepStrictEqual(TM.shownFormat('VIDEO + OBSERVED', vid), { format: 'VIDEO + OBSERVED', planned: false });
});

test('how a training is done keeps its label; nothing attached yet shows the plan, marked planned', () => {
  for (const f of ['LIVE', 'OBSERVED', 'SHADOW', 'EXTERNAL']) {
    assert.deepStrictEqual(TM.shownFormat(f, sop), { format: f, planned: false });
    assert.deepStrictEqual(TM.shownFormat(f, none), { format: f, planned: false });
  }
  assert.deepStrictEqual(TM.shownFormat('VIDEO', none), { format: 'VIDEO', planned: true });
  assert.deepStrictEqual(TM.shownFormat('VIDEO', undefined), { format: 'VIDEO', planned: true });
});

test('the catalog as seeded: TRN-001 is a document to read, TRN-501 a video, TRN-004 reading', () => {
  const seeded = TM.seedDefaults({}, 'T1').all;
  const label = (id) => TM.shownFormat(findModule(id).format, TM.materialFor(findModule(id), seeded[id] || null, new Set())).format;
  assert.strictEqual(label('TRN-001'), 'READ');
  assert.strictEqual(label('TRN-004'), 'READ');
  assert.strictEqual(label('TRN-501'), 'VIDEO');
  assert.strictEqual(label('TRN-503'), 'VIDEO + READ');
});
