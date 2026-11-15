'use strict';

// An onboarding item done in the app takes the person straight there
// (owner, 2026-11-10).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../onboarding/track');

const LINKS = {
  '/my#hours/pay': ['B.5.02', 'C.5.03', 'F.5.03', 'D.4.03', 'E.2.02'],
  '/my#hours/clock': ['F.6.03'],
  '/my#hours/availability': ['G.3.01'],
  '/clinical#settings': ['C.7.01', 'D.6.01'],
  '/caregiver#onboarding': ['A.5.02', 'A.5.04', 'A.6.03', 'A.6.04', 'A.6.05', 'A.6.06', 'A.6.08']
};

test('each in-app item links to where it is done', () => {
  for (const [url, ids] of Object.entries(LINKS)) {
    for (const id of ids) assert.strictEqual((T.findItem(id).link || {}).url, url, id);
  }
});

test('the link reaches the person\'s checklist', () => {
  const t = T.buildTrack({ inputs: { chapter: 'B' }, record: { userId: 'r1' }, accountType: 'rn' });
  assert.strictEqual(t.items.find(i => i.id === 'B.5.02').link.url, '/my#hours/pay');
});

test('each target block exists, and /my lands on it', () => {
  const my = fs.readFileSync(path.join(__dirname, '..', 'public', 'my-gfc.js'), 'utf8');
  for (const id of ['mg-pay', 'mg-clock', 'mg-availability']) assert.ok(my.includes(`id="${id}"`), id);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'my.html'), 'utf8');
  assert.match(page, /slice\(1\)\.split\('\/'\)\[0\]/, 'the view is the part before the slash');
  assert.match(page, /getElementById\(id\)/);
});

test('the office never gets an in-app link, and it opens in the same tab', () => {
  const ob = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(ob, /item\.link && !\(office && item\.link\.url\.startsWith\('\/'\)\)/);
  assert.match(ob, /\? <a className="btn gold sm" href=\{item\.link\.url\}><i/);
});
