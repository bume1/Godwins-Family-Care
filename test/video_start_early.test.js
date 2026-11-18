'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = (() => {
  const s = SERVER.slice(SERVER.indexOf("app.post('/api/clinical/visits/:eid/video/start'"));
  return s.slice(0, s.indexOf('\n  });'));
})();

test('opening the room before the visit window does not stamp a start', () => {
  assert.match(route, /const sched = await videoVisitOpensAt\(req, eid\)/);
  assert.match(route, /const early = sched && Date\.now\(\) < sched\.opensAt/);
  // Early: no call to the writer at all.
  assert.match(route, /const out = early\s*\?\s*\{ ok: false, code: 'VIDEO_OPENED_EARLY'/);
});

test('a start stamped too early is reset, with a reason, inside the window', () => {
  assert.match(route, /const priorEarly = !early && sched && prior && prior\.startedAt && !prior\.endedAt &&\s*Date\.parse\(prior\.startedAt\) < sched\.opensAt/);
  assert.match(route, /reason: priorEarly \? '[^']+' : undefined/);
});

test('the window is the patient\'s: 15 minutes before the scheduled start, read in Georgia', () => {
  const s = SERVER.slice(SERVER.indexOf('const videoVisitOpensAt'));
  const body = s.slice(0, s.indexOf('\n};'));
  assert.match(body, /joinInstant\(date, time\)/);
  assert.match(body, /patientPublish\.JOIN_OPENS_MINUTES_BEFORE \* 60000/);
  // An unreadable calendar falls back to stamping as before.
  assert.match(body, /catch \(_\) \{ return null; \}/);
});
