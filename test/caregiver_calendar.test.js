// The caregiver's Schedule is a calendar (owner, 2026-11-27): "caregivers see
// the same calendar view (scoped to their shifts) in their schedule view in My
// GFC ... confirmed vs completed vs open ... they should not be able to see
// cancelled shifts."
//
// These tests RENDER the shipped component against a stub DOM and a stub
// fetch, rather than reading its source, so they check what a caregiver would
// actually see.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMPONENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'components', 'caregiver-schedule.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
const GFC_TIME = require('../public/gfc-time');

// A shift on the given Eastern date at the given Eastern hour.
const at = (ymd, hh) => GFC_TIME.instantFromZoned(ymd, `${String(hh).padStart(2, '0')}:00`);
const shift = (id, status, ymd, extra) => Object.assign({
  id, status, clientName: `Client ${id}`, start: at(ymd, 9), end: at(ymd, 13),
  changeRequestable: false, changeRequestKinds: [], openChangeRequest: null
}, extra || {});

function harness({ mine, open }) {
  const root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const head = { appendChild: () => {} };
  const responses = {
    '/api/scheduling/shifts': { shifts: mine },
    '/api/scheduling/shifts/open': { shifts: open },
    '/api/scheduling/availability': { availability: [] },
    '/api/scheduling/time-logs': { timeLogs: [] },
    '/api/scheduling/change-requests': { requests: [] }
  };
  const win = {
    location: { origin: 'http://x' },
    GFC_TIME,
    navigator: {}
  };
  win.window = win;
  const ctx = vm.createContext({
    window: win, document: {
      getElementById: (id) => (id === 'mnt' ? root : null),
      createElement: () => ({}), head
    },
    fetch: (url) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(responses[url.replace('http://x', '')] || {})
    }),
    setTimeout, Promise, Date, Math, String, Number, Object, Array, JSON, Intl
  });
  // The component wraps itself in (function (global) {...})(window).
  vm.runInContext(COMPONENT, ctx);
  return { root, lib: win.GFCCaregiverSchedule };
}

const settle = () => new Promise(r => setTimeout(r, 20));
const today = GFC_TIME.zonedParts(new Date().toISOString()).isoDate;

test('the Schedule tab opens on a month calendar', async () => {
  const { root, lib } = harness({ mine: [shift('a', 'confirmed', today)], open: [] });
  lib.mount('mnt', { authToken: 't' });
  await settle();
  assert.match(root.innerHTML, /class="gcal"/, 'a month grid is drawn');
  assert.match(root.innerHTML, /data-view="list"/, 'and the list is still one tap away');
  assert.match(root.innerHTML, /gview on" data-act="cal-view" data-view="calendar"/, 'calendar is the default');
});

test('confirmed, completed and open shifts each show, each in its own colour', async () => {
  const { root, lib } = harness({
    mine: [shift('c1', 'confirmed', today), shift('d1', 'completed', today),
           shift('o1', 'assigned', today), shift('k1', 'claimed', today)],
    open: [shift('p1', 'open', today, { claimable: true })]
  });
  lib.mount('mnt', { authToken: 't' });
  await settle();
  const html = root.innerHTML;
  for (const kind of ['confirmed', 'completed', 'offered', 'claimed', 'open']) {
    assert.match(html, new RegExp(`class="gshift ${kind}"`), `a ${kind} shift is on the grid`);
  }
  // The day panel names each status in words, not only in colour.
  assert.match(html, /Completed/);
  assert.match(html, /Open, you can claim/);
  assert.match(html, /data-act="claim" data-id="p1"/, 'an open shift can be claimed from the day');
  assert.match(html, /data-act="accept" data-id="o1"/, 'an offer can be accepted from the day');
});

test('SAFETY: a cancelled shift never renders, even if the server sent one', async () => {
  const { root, lib } = harness({
    mine: [shift('x1', 'cancelled', today, { clientName: 'Cancelled Person' }), shift('c1', 'confirmed', today)],
    open: [shift('x2', 'cancelled', today, { clientName: 'Also Cancelled' })]
  });
  lib.mount('mnt', { authToken: 't' });
  await settle();
  assert.ok(!/Cancelled Person|Also Cancelled/.test(root.innerHTML), 'no cancelled shift reaches the screen');
  assert.ok(!/gshift cancelled/.test(root.innerHTML));
  assert.match(root.innerHTML, /Client c1/, 'while the confirmed one still does');
});

test('an open shift the caregiver cannot claim stays off the calendar', async () => {
  const { root, lib } = harness({
    mine: [],
    open: [shift('p1', 'open', today, { claimable: false, clientName: 'Not For You' }),
           shift('p2', 'open', today, { claimable: true, clientName: 'Yours To Claim' })]
  });
  lib.mount('mnt', { authToken: 't' });
  await settle();
  assert.ok(!/Not For You/.test(root.innerHTML));
  assert.match(root.innerHTML, /Yours To Claim/);
});

test('SAFETY: the shift list never hands a caregiver a cancelled shift or anyone else\'s', () => {
  const i = ROUTES.indexOf("router.get('/api/scheduling/shifts'");
  const handler = ROUTES.slice(i, ROUTES.indexOf('router.get(', i + 10));
  assert.match(handler,
    /isScheduleManager\(req\.user\) \? rows\s*:\s*rows\.filter\(r => r && r\.caregiver_id === req\.user\.id && r\.status !== 'cancelled'\)/,
    'a non-manager reads only their own shifts, and none cancelled');
});
