// ============================================================================
// meetRooms.js — the ONE place the Google Meet REST API is called
// (Session T1, owner-directed 2026-10-12)
//
// Owner decision 10: telehealth runs on Google Meet under the Workspace BAA,
// which GFC already holds for Drive and Gmail. So this module uses the SAME
// service account and the SAME domain-wide delegation those two use — there is
// no second credential, and `googledrive.loadServiceAccount` is required here
// rather than copied, because two readers of one key file is how one of them
// starts accepting a shape the other refuses.
//
// IT IMPERSONATES THE VISIT'S CLINICIAN, NOT A SHARED ACCOUNT. A Meet space is
// owned by whoever created it, and the host controls who is admitted. A space
// created as some generic office account would make every clinician a guest in
// their own visit, and would put the patient's waiting-room knock in front of
// an account nobody is watching. A clinician with no Workspace account on the
// GFC domain is REFUSED by name — the alternative is a room hosted by the
// wrong person.
//
// ⚠️ NOTHING IDENTIFYING EVER GOES INTO A SPACE, AND THAT IS STRUCTURAL.
// `createSpace` takes the clinician's email and nothing else — no patient, no
// client id, no appointment, no display name. A function that cannot be handed
// a patient cannot leak one, which is the same guarantee the critical-result
// notice builder gets from taking no arguments at all. Google's own logs, the
// space's name and any error it returns therefore carry no patient data.
//
// RECORDING, TRANSCRIPTION AND GEMINI NOTE-TAKING ARE OFF ON EVERY ROOM
// (owner decision 10), set at creation rather than left to a Workspace default
// somebody could change in the Admin console. An attendance report is not
// generated either: it is a list of who was in a patient's medical visit, held
// by Google, for no clinical purpose.
//
// This module is the transport and the policy. `server.js` owns the routes and
// the pointer store — the same split `uploadLinks.js` and `clinicalRoles.js`
// keep.
// ============================================================================
'use strict';

const { google } = require('googleapis');
const googledrive = require('./googledrive');

// ── scope ───────────────────────────────────────────────────────────────────
// ONE SCOPE, AND IT IS THE NARROWEST THAT DOES THE JOB.
// `meetings.space.created` is Google's "create, modify and delete meeting
// spaces and conference artifacts CREATED BY THIS APP". Every space this module
// touches is one it created, so the create, the config PATCH that restricts a
// cancelled room, and ending an active conference are all inside it.
//
// `meetings.space.settings` is deliberately NOT requested: that scope is for
// reading and writing settings on spaces the app did NOT create, which is
// exactly the access this feature has no business holding. If a later change
// genuinely needs it, adding it is an Admin-console edit AND a line here, not
// a silent widening.
const MEET_SCOPES = Object.freeze(['https://www.googleapis.com/auth/meetings.space.created']);

const MEET_API = 'https://meet.googleapis.com/v2';

// ── the room's configuration (A2) ───────────────────────────────────────────
// Every value here is a decision, so each one says why.
const SPACE_CONFIG = Object.freeze({
  // TRUSTED, never OPEN. GFC staff signed in on the domain join without
  // knocking; the patient and their family KNOCK and the clinician admits
  // them. OPEN would mean anyone holding the link walks straight into a
  // medical visit, and a Meet link is a short code that is forwarded, screen-
  // shotted and mistyped into.
  accessType: 'TRUSTED',
  // The patient is on a phone, in a browser, or dialling in. Narrowing the
  // entry points would turn "my camera will not work" into "I could not get
  // in at all".
  entryPointAccess: 'ALL',
  moderation: 'ON',
  moderationRestrictions: {
    // Chat and reactions are host-only: a patient's family member typing into
    // the chat of a clinical visit is writing into something nobody files and
    // nobody reads back.
    chatRestriction: 'HOSTS_ONLY',
    reactionRestriction: 'HOSTS_ONLY',
    // Presenting is NOT restricted. A patient showing a clinician a wound, a
    // pill bottle or a meter reading is the point of a video visit, and a
    // host can still restrict it mid-call if they need to.
    presentRestriction: 'NO_RESTRICTION',
    defaultJoinAsViewerType: 'OFF'
  },
  artifactConfig: {
    // All three OFF (owner decision 10). A recording of a medical visit is a
    // new record with its own retention, consent and disclosure questions,
    // none of which this build answers; a transcript and an AI note are the
    // same thing in text. Off at creation, so a Workspace default that gets
    // changed later cannot switch them on for visits already booked.
    recordingConfig: { autoRecordingGeneration: 'OFF' },
    transcriptionConfig: { autoTranscriptionGeneration: 'OFF' },
    smartNotesConfig: { autoSmartNotesGeneration: 'OFF' }
  },
  // A list of who attended a patient's medical visit, retained by Google, for
  // no clinical purpose.
  attendanceReportGenerationType: 'DO_NOT_GENERATE'
});

// ── configuration ───────────────────────────────────────────────────────────
class MeetNotConfiguredError extends Error {
  constructor(reason, blockers) {
    super(`Google Meet is not configured: ${reason}`);
    this.name = 'MeetNotConfiguredError';
    this.code = 'MEET_NOT_CONFIGURED';
    this.blockers = blockers || [];
  }
}

const truthy = (v) => v === true || ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

// Which email domains count as GFC's own Workspace. Defaults to the BAA-covered
// list config already keeps for email, because "may this account host a patient
// video visit" and "may this account carry PHI" are the same question asked
// twice, and answering it from two lists is how the two drift.
const workspaceDomains = (env) => String(
  (env || process.env).MEET_WORKSPACE_DOMAINS ||
  (env || process.env).EMAIL_BAA_DOMAINS ||
  'godwinsfamilycarellc.com'
).split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

// A clinician's Workspace address, or null. Their login email IS the account:
// GFC staff sign in to this app with their Workspace address, so a second
// stored field would be a second thing to keep in step.
const clinicianWorkspaceEmail = (user, env) => {
  const email = String((user && user.email) || '').trim().toLowerCase();
  if (!email.includes('@')) return null;
  const domain = email.split('@').pop();
  return workspaceDomains(env).includes(domain) ? email : null;
};

// Names EVERY blocker, not the first — the pattern `driveStatus()` settled.
const meetStatus = (env) => {
  const e = env || process.env;
  const sa = googledrive.loadServiceAccount();
  const blockers = [];
  if (!truthy(e.MEET_ENABLED)) {
    blockers.push('MEET_ENABLED is not set to true — video visits stay off until an administrator turns them on');
  }
  if (!sa) {
    blockers.push('GOOGLE_SERVICE_ACCOUNT_KEY is not set (or is not valid JSON) — Meet uses the same Workspace service account as Drive and Gmail');
  }
  return {
    // The settings parse. NOT a promise Google accepts the delegation — only
    // the admin test room proves that, and this never claims otherwise.
    configured: blockers.length === 0,
    enabled: truthy(e.MEET_ENABLED),
    serviceAccount: sa ? sa.client_email : null,
    domains: workspaceDomains(e),
    scopes: [...MEET_SCOPES],
    blockers,
    proof: 'configured means the settings parse and the key loads. Only creating a real test room proves the Meet scope is granted on the domain-wide delegation.'
  };
};

// ── the transport ───────────────────────────────────────────────────────────
// A JWT per impersonated clinician. Not cached across clinicians on purpose:
// the subject IS the identity, and a cache keyed wrongly would create one
// clinician's room as another.
const authFor = (email) => {
  const sa = googledrive.loadServiceAccount();
  const st = meetStatus();
  if (!st.configured) throw new MeetNotConfiguredError(st.blockers.join('; '), st.blockers);
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [...MEET_SCOPES],
    subject: email      // domain-wide delegation acts AS this clinician
  });
};

// Google's errors are quoted back as-is where they are safe: nothing sent to
// Meet carries a patient, so a Meet error cannot carry one either. What is
// stripped is the clinician's address, which is a staff identifier and has no
// business in a response a browser reads.
const meetError = (e, email) => {
  const raw = String((e && (e.message || e.toString())) || 'unknown error');
  const safe = email ? raw.split(email).join('[clinician]') : raw;
  const err = new Error(`Google Meet refused the request: ${safe.slice(0, 300)}`);
  err.code = 'MEET_CALL_FAILED';
  return err;
};

const createTransport = ({ getAuth = authFor } = {}) => {
  const call = async (email, { method, path, body, params }) => {
    const auth = getAuth(email);
    const client = await auth.getClient ? await auth.getClient() : auth;
    const res = await (client.request ? client : auth).request({
      url: `${MEET_API}${path}`,
      method,
      params: params || undefined,
      data: body || undefined
    });
    return (res && res.data) || {};
  };

  return {
    // A ROOM, FROM THE CLINICIAN'S EMAIL AND NOTHING ELSE.
    createSpace: async (clinicianEmail) => {
      try {
        const data = await call(clinicianEmail, {
          method: 'POST', path: '/spaces', body: { config: SPACE_CONFIG }
        });
        if (!data.name || !data.meetingUri) {
          const err = new Error('Google Meet created no usable room (no name or join link came back).');
          err.code = 'MEET_NO_ROOM';
          throw err;
        }
        return {
          spaceName: String(data.name),
          meetingUri: String(data.meetingUri),
          meetingCode: data.meetingCode ? String(data.meetingCode) : null
        };
      } catch (e) {
        if (e && (e.code === 'MEET_NOT_CONFIGURED' || e.code === 'MEET_NO_ROOM')) throw e;
        throw meetError(e, clinicianEmail);
      }
    },

    // SHUT A ROOM, both halves. RESTRICTED means only the host can join at
    // all, so a link already in somebody's inbox opens onto nothing; ending
    // the active conference turns out anyone standing in it right now.
    // Both are attempted and each failure is reported separately, because
    // "the room is closed but somebody is still in it" is a different state
    // from "the room is still open".
    closeSpace: async (clinicianEmail, spaceName) => {
      const failures = [];
      try {
        await call(clinicianEmail, {
          method: 'PATCH',
          path: `/${spaceName}`,
          params: { updateMask: 'config.accessType' },
          body: { config: { accessType: 'RESTRICTED' } }
        });
      } catch (e) {
        failures.push(`could not restrict the room: ${meetError(e, clinicianEmail).message}`);
      }
      try {
        await call(clinicianEmail, { method: 'POST', path: `/${spaceName}:endActiveConference` });
      } catch (e) {
        // A room with nobody in it answers 404/412 here, which is success in
        // the only sense that matters: there is no conference to end.
        const status = (e && (e.status || (e.response && e.response.status))) || 0;
        if (status !== 404 && status !== 400 && status !== 412) {
          failures.push(`could not end the active call: ${meetError(e, clinicianEmail).message}`);
        }
      }
      return { ok: failures.length === 0, failures };
    }
  };
};

module.exports = {
  MEET_SCOPES, MEET_API, SPACE_CONFIG,
  MeetNotConfiguredError,
  meetStatus, clinicianWorkspaceEmail, workspaceDomains,
  createTransport,
  // The live transport. Built once; it holds no per-clinician state.
  ...createTransport()
};
