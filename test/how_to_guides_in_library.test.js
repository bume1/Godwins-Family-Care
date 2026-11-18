'use strict';

// The how-to guides reach the Training Library (owner, 2026-11-18: "it doesn't
// appear all of our how to guides are reflected in the training library").

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SOURCES, driveViewUrl } = require('../onboarding/sources');
const TM = require('../onboarding/trainingMaterial');
const LC = require('../onboarding/libraryCatalog');

test('the staff guide to app updates is in the app training, and swappable from Policy & SOP Files', () => {
  assert.strictEqual(SOURCES.STAFF_APP_UPDATES_GUIDE.driveFileId, '1Q8YLuHuxhZoSdYJSZw-gErD1cQmjSgSau81J44L_YDY');
  const links = TM.seedDefaults({}, 'T1').all['TRN-004'].links;
  const g = links.find(l => /Staff Guide to App Updates/.test(l.label));
  assert.ok(g, 'on TRN-004');
  assert.strictEqual(g.url, driveViewUrl('STAFF_APP_UPDATES_GUIDE'));
});

test('a live TRN-004 seeded before the guide existed gets it, once', () => {
  const all = TM.seedDefaults({}, 'T1').all;
  all['TRN-004'] = Object.assign({}, all['TRN-004'], {
    links: all['TRN-004'].links.filter(l => !/App Updates/.test(l.label)),
    defaultKeysSeeded: all['TRN-004'].defaultKeysSeeded.filter(k => k !== 'app-updates')
  });
  const again = TM.seedDefaults(all, 'T2');
  assert.ok(again.seeded.includes('TRN-004'));
  assert.strictEqual(again.all['TRN-004'].links.filter(l => /App Updates/.test(l.label)).length, 1);
  assert.deepStrictEqual(TM.seedDefaults(again.all, 'T3').seeded, []);
});

test('the Gusto records how-to sits on the office SOP Set 3 row, never a staff training', () => {
  const row = LC.referenceRows().find(r => r.id === 'SOP Set 3');
  assert.strictEqual(row.guide.url, driveViewUrl('GUSTO_RECORDS_GUIDE'));
  const all = TM.seedDefaults({}, 'T1').all;
  for (const e of Object.values(all)) assert.ok(!e.links.some(l => /1FrWwUksOxQ1LivUbSZ/.test(l.url)), 'not in staff material');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /\{r\.guide && <div style=\{\{ marginTop: 4 \}\}><a href=\{r\.guide\.url\}/);
});
