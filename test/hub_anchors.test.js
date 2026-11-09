'use strict';
// Coming back to the Portal Hub lands on the area you left, not the top of the
// page, and the hub has a link to jump to each area (owner, 2026-11-09).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('each hub area is an anchor, with jump links, and opening a tile remembers its area', () => {
  const hub = read('login.html');
  assert.match(hub, /<section key=\{area\.id\} id=\{`area-\$\{area\.id\}`\}/);
  assert.match(hub, /<nav aria-label="Areas"/);
  assert.match(hub, /onClick=\{\(\) => openPortal\(portal\.path, area\.id\)\}/);
  assert.match(hub, /sessionStorage\.setItem\(HUB_AREA_KEY, areaId\)/);
  assert.match(hub, /sessionStorage\.getItem\(HUB_AREA_KEY\)/);
});

test('the staff bar\'s Portal Hub link points at the area you are in', () => {
  const nav = read('staff-nav.js');
  assert.match(nav, /href: here \? HUB \+ '#area-' \+ here\.id : HUB/);
});
