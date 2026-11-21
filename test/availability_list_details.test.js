'use strict';
// The submitted-availability list names who submitted it, and when (owner
// report, 2026-11-20: a submission showed no caregiver name and no detail).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('node:http');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function harness(users) {
  const store = new Map();
  const db = {
    get: async k => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }
  };
  const app = express();
  app.use(bodyParser.json());
  app.use(require('../routes/scheduling')({
    db, config: require('../config'),
    logActivity: async () => {}, queueNotification: async () => ({ id: 'n' }),
    getUsers: async () => JSON.parse(JSON.stringify(users)),
    invalidateUsersCache: () => {},
    authenticateToken: (req, res, next) => {
      const u = users.find(x => x.id === req.headers['x-as']);
      if (!u) return res.status(401).json({ error: 'no' });
      req.user = { id: u.id, email: u.email, name: u.name, role: u.role, isManager: u.isManager || false,
        accountType: null, clinicalRole: null, hasClinicalAccess: false, licenseLevel: u.licenseLevel || null,
        assignedClients: [], careTeam: null, familyOfClientId: null };
      next();
    },
    uuidv4: () => `id-${Math.random().toString(36).slice(2, 10)}`
  }));
  return { app, db };
}

const call = (app, url, as) => new Promise((resolve, reject) => {
  const srv = http.createServer(app).listen(0, () => {
    http.get({ port: srv.address().port, path: url, headers: { 'x-as': as } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(b) }); });
    }).on('error', e => { srv.close(); reject(e); });
  });
});

test('the office list names the caregiver from the roster when the row carries no name', async () => {
  const users = [
    { id: 'adm', email: 'a@g.test', name: 'GFC Admin', role: 'admin' },
    { id: 'tg', email: 't@g.test', name: 'Tasha Green', role: 'vendor', licenseLevel: 'cna' }
  ];
  const h = harness(users);
  await h.db.set('caregiver_availability', [{
    id: 'r1', caregiver_id: 'tg', caregiver_name: null, license_level: null,
    effective_from: '2026-12-01', windows: [{ day: 'Mon', start: '09:00', end: '17:00' }],
    blackout_dates: ['2026-12-25'], note: 'No weekends', status: 'submitted',
    submitted_at: '2026-11-20T15:00:00.000Z'
  }]);
  const r = await call(h.app, '/api/scheduling/availability?scope=all', 'adm');
  assert.equal(r.status, 200);
  const a = r.body.availability[0];
  assert.equal(a.caregiverName, 'Tasha Green');
  assert.equal(a.licenseLevel, 'cna');
  assert.equal(a.submittedAt, '2026-11-20T15:00:00.000Z');
  assert.equal(a.note, 'No weekends');
});

test('a person no longer on the roster still reads with the name stored on the row', async () => {
  const users = [{ id: 'adm', email: 'a@g.test', name: 'GFC Admin', role: 'admin' }];
  const h = harness(users);
  await h.db.set('caregiver_availability', [{
    id: 'r1', caregiver_id: 'gone', caregiver_name: 'Former Caregiver', effective_from: '2026-12-01',
    windows: [], status: 'submitted', submitted_at: '2026-11-20T15:00:00.000Z'
  }]);
  const r = await call(h.app, '/api/scheduling/availability?scope=all', 'adm');
  assert.equal(r.body.availability[0].caregiverName, 'Former Caregiver');
});

test('both lists show the submitted time, the note and the days off', () => {
  const office = read('public/scheduling.html');
  assert.match(office, /Submitted \{a\.submittedAt/);
  assert.match(office, /Note: \{a\.note\}/);
  assert.match(office, /a\.licenseLevel &&/);
  const own = read('public/components/caregiver-schedule.js');
  assert.match(own, /esc\(a\.caregiverName\)/);
  assert.match(own, /'<div class="gmu">Submitted '/);
  assert.match(own, /'<div class="gmu">Note: '/);
  assert.match(own, /'<div class="gmu">Unavailable: '/);
});
