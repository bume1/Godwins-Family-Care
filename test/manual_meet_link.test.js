// The fallback when the app cannot make a Meet room: staff paste a Meet link
// they made, and it becomes the patient's Join button (owner, 2026-11-18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseManualMeetLink } = require('../meetRooms');

test('a real Meet link is accepted and normalized', () => {
  for (const input of ['https://meet.google.com/abc-defg-hij', 'meet.google.com/ABC-DEFG-HIJ', ' https://meet.google.com/abc-defg-hij?authuser=0 ']) {
    const r = parseManualMeetLink(input);
    assert.strictEqual(r.ok, true, input);
    assert.strictEqual(r.meetingUri, 'https://meet.google.com/abc-defg-hij');
    assert.strictEqual(r.meetingCode, 'abc-defg-hij');
  }
});

test('anything else is refused', () => {
  for (const input of ['', 'https://zoom.us/j/123', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.com/abc-defg-hij',
    'https://meet.google.com/', 'https://meet.google.com/lookup/abc', 'javascript:alert(1)', 'https://evil.com/?u=meet.google.com/abc-defg-hij']) {
    assert.strictEqual(parseManualMeetLink(input).ok, false, input);
  }
});

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const route = server.slice(server.indexOf("app.post('/api/clinical/appointments/:eid/video-link'"), server.indexOf("// CLINICAL COMPLETENESS P0 (Session 4.4)"));

test('the paste route is gated like Create Video Room and validates the link', () => {
  assert.match(route, /requireClinicalDocumenter, requireCapability\(clinicalRoles\.CAPABILITIES\.SCHEDULING\)/);
  assert.match(route, /meetRooms\.parseManualMeetLink\(/);
  assert.match(route, /loadVideoVisitContext\(req, eid\)/);
  assert.match(route, /manual: true/);
  assert.match(route, /afterVideoRoomReady\(req, ctx, eid\)/);
});

test('a pasted link never replaces a room the app made', () => {
  assert.match(route, /existing\.meetingUri && !existing\.manual[\s\S]{0,200}VIDEO_ROOM_EXISTS/);
});

test('the activity log names the visit, never the link', () => {
  const log = route.slice(route.indexOf("'video_link_pasted'"), route.indexOf("'video_link_pasted'") + 200);
  assert.doesNotMatch(log, /meetingUri|parsed\./);
});

test('closing a pasted room does not ask Google to shut a space the app never made', () => {
  const close = server.slice(server.indexOf('const closeVideoRoomFor'), server.indexOf('const migrateVideoLink'));
  assert.match(close, /if \(row\.manual\)[\s\S]{0,300}else if \(meetRooms\.meetStatus\(\)\.configured\)/);
});

test('the video card offers the paste box and calls the route', () => {
  assert.match(page, /pasteMeetLink: \(eid, url\) => authedFetch\(`\/api\/clinical\/appointments\/\$\{eid\}\/video-link`/);
  assert.match(page, /onPasteLink=\{\(url\) => \{[\s\S]{0,120}api\.pasteMeetLink\(d\.linkedAppointmentEid, url\)/);
  assert.match(page, /Save Meet Link/);
});
