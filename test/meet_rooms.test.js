// test/meet_rooms.test.js — the one place Google Meet is called (Session T1).
//
// What is pinned here is the room's CONFIGURATION, because that is the whole
// safety surface: a room created with recording on, or open to anyone holding
// the link, is a privacy failure that looks exactly like a working video visit
// from the clinician's side. And that nothing identifying can reach a space,
// which is structural rather than careful: the create function takes an email
// and nothing else.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../meetRooms.js');

const root = path.join(__dirname, '..');
const stripComments = (s) => s
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const src = (f) => {
  const raw = fs.readFileSync(path.join(root, f), 'utf8');
  const out = stripComments(raw);
  assert.ok(1 - out.length / raw.length < 0.6, `stripComments swallowed code in ${f}`);
  return out;
};

// A fake Meet API that records every request.
const fakeMeet = (respond) => {
  const calls = [];
  const auth = () => ({
    request: async (req) => { calls.push(req); return { data: respond ? respond(req) : {} }; }
  });
  return { calls, transport: M.createTransport({ getAuth: auth }) };
};
const ROOM = { name: 'spaces/abc123', meetingUri: 'https://meet.google.com/aaa-bbbb-ccc', meetingCode: 'aaa-bbbb-ccc' };

// ── the room's configuration ────────────────────────────────────────────────

test('recording, transcription and smart notes are OFF on every room', () => {
  const a = M.SPACE_CONFIG.artifactConfig;
  assert.strictEqual(a.recordingConfig.autoRecordingGeneration, 'OFF',
    'a recording of a medical visit is a new record with its own consent and retention questions');
  assert.strictEqual(a.transcriptionConfig.autoTranscriptionGeneration, 'OFF');
  assert.strictEqual(a.smartNotesConfig.autoSmartNotesGeneration, 'OFF',
    'owner decision 10: Gemini note-taking is off for these rooms');
});

test('the room is TRUSTED, never OPEN — the patient knocks', () => {
  assert.strictEqual(M.SPACE_CONFIG.accessType, 'TRUSTED',
    'OPEN would mean anyone holding the link walks into a medical visit');
  assert.notStrictEqual(M.SPACE_CONFIG.accessType, 'OPEN');
  assert.strictEqual(M.SPACE_CONFIG.entryPointAccess, 'ALL', 'phone, browser or dial-in');
});

test('no attendance report is generated for a patient visit', () => {
  assert.strictEqual(M.SPACE_CONFIG.attendanceReportGenerationType, 'DO_NOT_GENERATE',
    'a list of who was in a patient\'s visit, held by Google, for no clinical purpose');
});

test('chat and reactions are host-only; presenting is NOT restricted', () => {
  const r = M.SPACE_CONFIG.moderationRestrictions;
  assert.strictEqual(M.SPACE_CONFIG.moderation, 'ON');
  assert.strictEqual(r.chatRestriction, 'HOSTS_ONLY');
  assert.strictEqual(r.reactionRestriction, 'HOSTS_ONLY');
  assert.strictEqual(r.presentRestriction, 'NO_RESTRICTION',
    'a patient showing a clinician a wound or a pill bottle is the point of a video visit');
});

test('the config is sent at CREATION, not left to a Workspace default', async () => {
  const { calls, transport } = fakeMeet(() => ROOM);
  await transport.createSpace('b.godwins@godwinsfamilycarellc.com');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/v2\/spaces$/);
  assert.deepStrictEqual(calls[0].data.config.artifactConfig, M.SPACE_CONFIG.artifactConfig,
    'a default somebody changes later must not switch recording on for visits already booked');
  assert.strictEqual(calls[0].data.config.accessType, 'TRUSTED');
});

// ── nothing identifying can reach a space ───────────────────────────────────

test('createSpace takes an email and NOTHING else — it cannot be handed a patient', () => {
  // The strongest available guarantee, same as the critical-result notice
  // builder taking no arguments: a function with nowhere to put a patient
  // cannot leak one.
  assert.strictEqual(M.createTransport().createSpace.length, 1,
    'one parameter: the clinician\'s email');
  const code = src('meetRooms.js');
  for (const forbidden of ['clientId', 'patient', 'displayName', 'firstName', 'lastName', 'dob']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(code),
      `meetRooms.js must not name ${forbidden} — nothing identifying goes into a space`);
  }
});

test('a patient name cannot ride along even if a caller tries', async () => {
  const { calls, transport } = fakeMeet(() => ROOM);
  // Extra arguments are simply not read.
  await transport.createSpace('b.godwins@godwinsfamilycarellc.com', { patientName: 'Juanita Guess', clientId: 'client_1' });
  const blob = JSON.stringify(calls[0]);
  assert.ok(!blob.includes('Juanita'), 'nothing a caller adds reaches the request');
  assert.ok(!blob.includes('client_1'));
  assert.deepStrictEqual(Object.keys(calls[0].data), ['config'], 'the body is the config and nothing else');
});

// ── who may host ────────────────────────────────────────────────────────────

test('only a clinician on the GFC Workspace domain can host', () => {
  assert.strictEqual(M.clinicianWorkspaceEmail({ email: 'b.godwins@godwinsfamilycarellc.com' }, {}), 'b.godwins@godwinsfamilycarellc.com');
  // Case and surrounding space do not decide a domain.
  assert.strictEqual(M.clinicianWorkspaceEmail({ email: '  B.Godwins@GodwinsFamilyCareLLC.com ' }, {}), 'b.godwins@godwinsfamilycarellc.com');
  for (const outside of ['b.godwins@gmail.com', 'b@godwinsfamilycare.com', 'notanemail', '', null]) {
    assert.strictEqual(M.clinicianWorkspaceEmail({ email: outside }, {}), null, `${outside} must not host`);
  }
  assert.strictEqual(M.clinicianWorkspaceEmail(null, {}), null);
});

test('a lookalike domain is not the GFC domain', () => {
  // The guard is an exact domain match, not a substring: a suffix check would
  // admit `godwinsfamilycarellc.com.example.net`.
  assert.strictEqual(M.clinicianWorkspaceEmail({ email: 'x@godwinsfamilycarellc.com.evil.net' }, {}), null);
  assert.strictEqual(M.clinicianWorkspaceEmail({ email: 'x@notgodwinsfamilycarellc.com' }, {}), null);
});

// ── one scope, the narrowest ────────────────────────────────────────────────

test('ONE scope is requested, and it is the created-by-this-app one', () => {
  assert.deepStrictEqual(M.MEET_SCOPES, ['https://www.googleapis.com/auth/meetings.space.created']);
  assert.ok(!M.MEET_SCOPES.some(s => s.includes('settings')),
    'meetings.space.settings would grant access to spaces this app did not create');
});

test('Meet uses the SAME Workspace service account as Drive and Gmail', () => {
  const code = src('meetRooms.js');
  assert.match(code, /require\('\.\/googledrive'\)/, 'one reader of the key file, not two');
  assert.match(code, /loadServiceAccount/);
  assert.ok(!/GOOGLE_SERVICE_ACCOUNT_KEY/.test(code.replace(/MEET_ENABLED[\s\S]{0,400}?Gmail/, '')),
    'the key is read through googledrive, never parsed again here');
});

// ── configuration status ────────────────────────────────────────────────────

test('status names EVERY blocker, and MEET_ENABLED off is one of them', () => {
  const st = M.meetStatus({});
  assert.strictEqual(st.configured, false);
  assert.match(st.blockers.join(' '), /MEET_ENABLED/);
  assert.match(st.blockers.join(' '), /GOOGLE_SERVICE_ACCOUNT_KEY/);
  assert.ok(st.blockers.length >= 2, 'not just the first');
  assert.strictEqual(M.meetStatus({ MEET_ENABLED: 'true' }).enabled, true);
  assert.match(st.proof, /Only creating a real test room proves/,
    'configured is not a promise Google accepts the delegation');
});

test('a room cannot be created while Meet is switched off', async () => {
  // No getAuth override: the real one checks status first.
  await assert.rejects(
    () => M.createSpace('b.godwins@godwinsfamilycarellc.com'),
    (e) => e.code === 'MEET_NOT_CONFIGURED' && Array.isArray(e.blockers) && e.blockers.length > 0
  );
});

// ── closing a room ──────────────────────────────────────────────────────────

test('closing a room RESTRICTS it and ends any active call', async () => {
  const { calls, transport } = fakeMeet(() => ({}));
  const r = await transport.closeSpace('b.godwins@godwinsfamilycarellc.com', 'spaces/abc123');
  assert.strictEqual(r.ok, true);
  const patch = calls.find(c => c.method === 'PATCH');
  assert.ok(patch, 'the room must be restricted');
  assert.strictEqual(patch.data.config.accessType, 'RESTRICTED',
    'a link already in somebody\'s inbox must open onto nothing');
  assert.strictEqual(patch.params.updateMask, 'config.accessType');
  assert.ok(calls.some(c => /:endActiveConference$/.test(c.url)),
    'and anyone standing in it right now is turned out');
});

test('an empty room is not a failure to close', async () => {
  // Ending a conference that does not exist answers 404, which is success in
  // the only sense that matters.
  const auth = () => ({
    request: async (req) => {
      if (/endActiveConference/.test(req.url)) { const e = new Error('not found'); e.status = 404; throw e; }
      return { data: {} };
    }
  });
  const t = M.createTransport({ getAuth: auth });
  assert.deepStrictEqual(await t.closeSpace('b@godwinsfamilycarellc.com', 'spaces/x'), { ok: true, failures: [] });
});

test('a failed restrict and a failed end are reported separately', async () => {
  const auth = () => ({ request: async () => { const e = new Error('boom'); e.status = 500; throw e; } });
  const t = M.createTransport({ getAuth: auth });
  const r = await t.closeSpace('b@godwinsfamilycarellc.com', 'spaces/x');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failures.length, 2,
    '"closed but somebody is still in it" is a different state from "still open"');
});

// ── errors ──────────────────────────────────────────────────────────────────

test('a Meet error never carries the clinician\'s address back out', async () => {
  const auth = () => ({ request: async () => { throw new Error('delegation denied for b.godwins@godwinsfamilycarellc.com'); } });
  const t = M.createTransport({ getAuth: auth });
  await assert.rejects(
    () => t.createSpace('b.godwins@godwinsfamilycarellc.com'),
    (e) => e.code === 'MEET_CALL_FAILED' && !/b\.godwins@/.test(e.message) && /\[clinician\]/.test(e.message)
  );
});

test('a room with no join link is a failure, not a room', async () => {
  const { transport } = fakeMeet(() => ({ name: 'spaces/x' }));   // no meetingUri
  await assert.rejects(
    () => transport.createSpace('b@godwinsfamilycarellc.com'),
    (e) => e.code === 'MEET_NO_ROOM'
  );
});
