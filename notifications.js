// ============================================================================
// NOTIFICATIONS TO A CLIENT AND THEIR CARE CIRCLE
// ============================================================================
// Named for what it is rather than for the arm it started in. It began as the
// four private-home-care notices below and now carries the clinical
// appointment ones too, because BOTH need the same two rules and a second
// copy of either is how they drift:
//
//   * WHO may be emailed about a client — the client and a designated POA,
//     never non-POA family (their access is ROI- and sharing-gated at READ
//     time, and email is a push channel where neither gate can be re-checked
//     once the message is out).
//   * HOW MUCH the message may say — read from whether the LIVE transport is
//     inside the BAA, never from a vendor's name, and re-evaluated on every
//     send.
//
// ---------------------------------------------------------------------------
// The private-home-care events
// ---------------------------------------------------------------------------
// The PHC arm had events that changed something a person was waiting on and
// told nobody, or told them over plumbing that ignored their own preferences:
//
//   1. A client uploads a document        → staff found out by looking
//   2. Staff accept or reject an upload   → the client was never told, so a
//      rejection reason that the code REQUIRES was captured and then never
//      delivered. A client told nothing sends the same blurry photo again.
//   3. A client signs a consent           → nobody
//   4. A client co-signs the care plan    → the RN who authored it and is
//      waiting on that signature had to check by hand
//   5. Staff request or chase documents   → emailed, but on raw plumbing that
//      ignored an unsubscribe and sent unbranded plain text
//   6. Staff request enrollment follow-up → same raw plumbing
//   7. An admin approves the enrollment   → nobody, including the client who
//      had been waiting for exactly that
//
// HOW MUCH EACH EMAIL MAY SAY DEPENDS ON WHETHER THE LIVE TRANSPORT IS INSIDE
// THE BAA, and that is the point rather than an inconvenience. "Ada Bell's care
// plan is signed" is protected health information. On a transport that carries
// no BAA these notices say only that something is waiting; on a covered one
// they say what it is, and the detailed version is marked { phi: true } so the
// mailer refuses it outright if the transport changes underneath us.
//
// Coverage is read from the SENDING ADDRESS at send time, never from a
// transport's name, and an unreadable transport counts as NOT covered — which
// is why none of this names a vendor. Whichever one is configured today, the
// rule is the same and it is re-evaluated on every send.
//
// Every function here is best-effort. A notification failure must never undo
// an upload, a review, a signature or a co-signature that already succeeded.
// ============================================================================

const { renderGfcEmail } = require('./emailTemplates');
// The reminder's copy lives with the rest of the reminder rules, not here: the
// "Your visit" opening is load-bearing (see sendToClientSide) and it is tested
// where the rule is declared.
const reminders = require('./visitReminders');

// Roles that receive staff-side PHC notices. Mirrors ENROLLMENT_STAFF_ROLES in
// server.js — passed in rather than restated, so the two cannot drift.
function createNotifier(deps) {
  const {
    getUsers, queueNotification, getAppBaseUrl, emailTransport,
    staffRoles, clientRole, familyRole
  } = deps;

  const transportAllowsDetail = () => {
    try {
      return !!emailTransport.transportStatus().baaCovered;
    } catch (e) {
      // Unknown transport is treated as not covered. Guessing the permissive
      // way here would put PHI in an inbox on the strength of a failed lookup.
      return false;
    }
  };

  const portalUrlFor = async (client) => {
    const base = await getAppBaseUrl();
    return `${base}/portal${client && client.slug ? `/${client.slug}` : ''}`;
  };

  const firstNameOf = (user) =>
    String((user && (user.preferredName || user.name)) || 'there').split(' ')[0];

  // Staff who should hear about a client-side event. Deactivated accounts and
  // people with no address are dropped here; the opt-out itself is enforced
  // inside queueNotification, which every path already passes through.
  const staffRecipients = async () => {
    const users = await getUsers();
    return users.filter(u =>
      u && u.email &&
      (staffRoles.includes(u.role) || u.isManager || u.hasClientPortalAdminAccess)
    );
  };

  // The client, plus a designated POA. A POA holds client-equivalent access by
  // the 08/2026 owner decision. Non-POA family are deliberately excluded:
  // their access is ROI-gated and sharing-gated at read time, and email is a
  // push channel where neither gate can be re-checked once the message is out.
  const clientSideRecipients = async (clientId) => {
    const users = await getUsers();
    const client = users.find(u => u && u.id === clientId && u.role === clientRole);
    if (!client) return { client: null, recipients: [] };
    const recipients = [];
    if (client.email) recipients.push({ user: client, actingFor: null });
    for (const u of users) {
      if (u && u.role === familyRole && u.familyIsPoa && u.familyOfClientId === clientId && u.email) {
        recipients.push({ user: u, actingFor: client });
      }
    }
    return { client, recipients };
  };

  const send = async ({ type, user, subject, headline, paragraphs, fields, callout, calloutLabel, ctaUrl, ctaLabel, relatedEntityId, relatedEntityType, actorId, phi }) => {
    const rendered = renderGfcEmail({
      greeting: firstNameOf(user), headline, paragraphs, fields, callout, calloutLabel, ctaUrl, ctaLabel
    });
    const queued = await queueNotification(
      type, user.id, user.email, user.name,
      { subject, body: rendered.text, htmlBody: rendered.html, ctaUrl, ctaLabel },
      { relatedEntityId, relatedEntityType, createdBy: actorId || 'system', phi: !!phi }
    );
    return !!(queued && !queued.skipped);
  };

  // ---- 1. A client uploaded a document -------------------------------------
  async function documentUploaded({ client, kind, label, uploadId, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const staff = await staffRecipients();
      if (!staff.length) return { notified: 0, reason: 'no staff with an email address' };
      const base = await getAppBaseUrl();
      const url = `${base}/admin/enrollment`;
      let n = 0;
      for (const u of staff) {
        const ok = await send({
          type: 'phc_document_uploaded',
          user: u,
          subject: detail ? `Document received — ${client.name}` : 'A client document is waiting for review',
          headline: 'A document is waiting for review',
          paragraphs: detail
            ? [`${client.name} uploaded ${label || kind || 'a document'}. It is waiting in the enrollment view for someone to accept or reject it.`]
            : ['A client uploaded a document. It is waiting in the enrollment view for review. Open the portal for the details.'],
          ctaUrl: url, ctaLabel: 'Open enrollment',
          relatedEntityId: uploadId, relatedEntityType: 'document',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] document-uploaded notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 2. Staff accepted or rejected an upload -----------------------------
  // The rejection reason is the whole reason this notice exists. It is
  // REQUIRED at the route and was being captured and never delivered, so a
  // client saw "we still need your insurance card" and sent the same photo.
  async function documentReviewed({ clientId, decision, label, reason, uploadId, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const { client, recipients } = await clientSideRecipients(clientId);
      if (!client) return { notified: 0, reason: 'no client record' };
      if (!recipients.length) return { notified: 0, reason: 'no email address on file' };
      const url = await portalUrlFor(client);
      const rejected = decision === 'rejected';
      const thing = label || 'a document';

      let n = 0;
      for (const { user, actingFor } of recipients) {
        const forWhom = actingFor ? ` for ${actingFor.name}` : '';
        const ok = await send({
          type: rejected ? 'phc_document_rejected' : 'phc_document_accepted',
          user,
          subject: rejected ? 'A document needs another look' : 'We received your document',
          headline: rejected ? 'A document needs another look' : 'Document received',
          paragraphs: rejected
            ? (detail
                ? [`We looked at ${thing}${forWhom} and need it sent again.`,
                   'Upload a replacement from the Documents tab in your portal. There is nothing else to do in the meantime.']
                : [`One of the documents${forWhom} needs to be sent again.`,
                   'The reason is in the secure portal, along with the button to upload a replacement. For privacy we do not put document details in email.'])
            : (detail
                ? [`We received ${thing}${forWhom} and it is accepted. Nothing further is needed from you.`]
                : [`A document${forWhom} was received and accepted. Nothing further is needed from you.`]),
          // The reason rides in the callout, and ONLY when the transport can
          // carry it. Staff type this field freely, so it is treated as PHI.
          callout: rejected && detail && reason ? reason : null,
          calloutLabel: 'Why we need it again',
          ctaUrl: url, ctaLabel: 'Open your portal',
          relatedEntityId: `${uploadId}:${decision}`, relatedEntityType: 'document',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] document-review notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 3. A client signed a consent ----------------------------------------
  // Staff only, deliberately. A client signs up to fourteen consents during
  // enrollment; a receipt for each would be fourteen emails in one sitting,
  // and the enrollment-complete confirmation already covers the client side.
  // Staff need each one because the enrollment gate advances on them.
  async function consentSigned({ client, consentType, consentTitle, offline, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const staff = await staffRecipients();
      if (!staff.length) return { notified: 0, reason: 'no staff with an email address' };
      const base = await getAppBaseUrl();
      const url = `${base}/admin/enrollment`;
      const how = offline ? 'on paper, recorded by staff' : 'in the portal';
      let n = 0;
      for (const u of staff) {
        const ok = await send({
          type: 'phc_consent_signed',
          user: u,
          subject: detail ? `Consent signed — ${client.name}` : 'A consent was signed',
          headline: 'A consent was signed',
          paragraphs: detail
            ? [`${client.name} signed ${consentTitle || consentType} ${how}.`,
               'The enrollment checklist has been updated. Open the enrollment view to see what is still outstanding.']
            : ['A client signed a consent and their enrollment checklist has moved. Open the enrollment view for the details.'],
          ctaUrl: url, ctaLabel: 'Open enrollment',
          relatedEntityId: `${client.id}:${consentType}`, relatedEntityType: 'consent',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] consent-signed notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 4. A client (or their POA) co-signed the care plan ------------------
  // The authoring RN is the person actually waiting on this. Before now they
  // had to check by hand, which meant a plan could sit signed for days.
  async function carePlanCoSigned({ client, version, signerName, signedByPoa, authoredById, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const users = await getUsers();
      const recipients = [];

      const author = authoredById ? users.find(u => u && u.id === authoredById && u.email) : null;
      if (author) recipients.push(author);
      // Admins too: the care plan is an enrollment gate, so somebody other
      // than the author needs to see it move. Never twice to one person.
      for (const u of users) {
        if (u && u.email && u.role === 'admin' && !recipients.some(r => r.id === u.id)) recipients.push(u);
      }
      if (!recipients.length) return { notified: 0, reason: 'no recipient with an email address' };

      const base = await getAppBaseUrl();
      const url = `${base}/clinical`;
      const who = signedByPoa && signerName
        ? `${signerName}, as Power of Attorney for ${client.name},`
        : `${client.name}`;

      let n = 0;
      for (const u of recipients) {
        const ok = await send({
          type: 'phc_care_plan_cosigned',
          user: u,
          subject: detail ? `Care plan co-signed — ${client.name}` : 'A care plan has been co-signed',
          headline: 'A care plan has been co-signed',
          paragraphs: detail
            ? [`${who} co-signed version ${version} of the care plan.`,
               'The signed copy carries both signatures and is filed. Nothing further is needed unless the plan changes.']
            : ['A client co-signed their care plan. The signed copy is filed and the details are in the workspace.'],
          ctaUrl: url, ctaLabel: 'Open the workspace',
          relatedEntityId: `${client.id}:careplan:v${version}`, relatedEntityType: 'care_plan',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] care-plan co-sign notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- Clinical appointments -----------------------------------------------
  // Booking, moving or cancelling a visit used to tell the patient NOTHING.
  // The whole point of a home-visit practice is that someone is coming to the
  // door; a change to that is the one thing a patient needs in writing.
  //
  // A no-show is deliberately NOT notified. "You missed your appointment" is a
  // conversation, not an automated email, and the patient may have been in
  // hospital. It stays a clinician action.
  //
  // The date, the clinician and the place are all PHI, so the detailed version
  // is marked and the vague one is what sends if the transport is not covered.

  const apptRecipients = (clientId) => clientSideRecipients(clientId);

  // `ctaFor` (T1 C4) lets ONE recipient get a different button from another:
  // the video nudge's one-tap link is minted per person and bound to them, so
  // a patient's link is not their POA's. It is a callback rather than a field
  // because minting touches the token store, and this module deliberately
  // knows nothing about it. Returning null falls back to the portal button,
  // which is what every other notice gets.
  const sendToClientSide = async ({ clientId, type, subject, headline, paragraphs, fields, callout, calloutLabel, actorId, entityId, entityType, ctaFor }) => {
    const { client, recipients } = await apptRecipients(clientId);
    if (!client) return { notified: 0, reason: 'no client record' };
    if (!recipients.length) return { notified: 0, reason: 'no email address on file' };
    const url = await portalUrlFor(client);
    let n = 0;
    for (const { user, actingFor } of recipients) {
      let cta = null;
      if (ctaFor) {
        // A link that cannot be minted must not stop the reminder: the patient
        // still gets the portal button, which is a working way in.
        try { cta = await ctaFor(user, actingFor); }
        catch (e) { console.error('[APPT] per-recipient link failed (non-fatal):', e.message); }
      }
      const ok = await send({
        type, user, subject, headline,
        // A POA is told whose visit (or result) it is; the client is not told
        // their own name. EVERY client-side paragraph must open with one of the
        // phrases below, and the longer ones come FIRST because alternation is
        // ordered — with `visit` leading, "Your caregiver visit" fell through
        // unrewritten and a POA read "Your caregiver visit has moved" about a
        // visit that was not theirs. Found by rendering the POA's copy.
        paragraphs: actingFor
          ? paragraphs.map(p => p.replace(
              /^Your (caregiver visit|clinician visit|visit|test result)/,
              (m, what) => `${actingFor.name}'s ${what}`))
          : paragraphs,
        fields, callout, calloutLabel,
        ctaUrl: (cta && cta.url) || url,
        ctaLabel: (cta && cta.label) || 'Open your portal',
        relatedEntityId: entityId, relatedEntityType: entityType || 'appointment',
        actorId, phi: true
      });
      if (ok) n += 1;
    }
    return { notified: n, detailed: transportAllowsDetail() };
  };

  // Detail is decided ONCE per notice and passed down, so the subject line and
  // the body can never disagree about what may be said.
  const visitFields = (detail, { when, clinician, place }) => (detail
    ? [
        { label: 'When', value: when },
        { label: 'Who', value: clinician },
        { label: 'Where', value: place }
      ].filter(f => f.value)
    : []);

  async function appointmentBooked({ client, eid, when, clinician, place, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId: client.id,
        type: 'appointment_booked',
        subject: detail ? `Your visit is scheduled — ${when}` : 'A visit has been scheduled',
        headline: 'Your visit is scheduled',
        paragraphs: detail
          ? ['Your visit is booked. The details are below and in your portal.',
             'If the time does not work, call the office and we will move it.',
             'A reminder will reach you the day before.']
          : ['A visit has been scheduled for you. The date and time are in your secure portal.',
             'For privacy we do not put visit details in email.'],
        fields: visitFields(detail, { when, clinician, place }),
        actorId, entityId: eid
      });
    } catch (e) {
      console.error('[APPT] booked notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 4d. The day-before reminder (Session 4.11) ---------------------------
  //
  // It goes out through THE SAME sendToClientSide path as the booking notice, so
  // the recipient rules (the client plus a designated POA, never non-POA family),
  // the unsubscribe honour, the house template and the transport-aware detail
  // rule all apply unchanged. A second path would be a second set of all four.
  //
  // Everything it renders was SNAPSHOT AT BOOKING TIME. Nothing here reads
  // OpenEMR, which is what makes a background send possible at all under
  // per-clinician auth.
  async function visitReminder({ reminder, orgPhone, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const copy = reminders.reminderCopy({
        detail, when: reminder.when, orgPhone,
        timeOfDay: reminders.timeOfDayFor(reminder.visitDate, reminder.startTime)
      });
      return await sendToClientSide({
        clientId: reminder.clientId,
        type: 'visit_reminder',
        subject: copy.subject,
        headline: copy.headline,
        paragraphs: copy.paragraphs,
        fields: visitFields(detail, { when: reminder.when, clinician: reminder.clinician, place: reminder.place }),
        actorId,
        // `${eid}:reminder` rather than the bare eid, for two reasons. It must not
        // collide with the BOOKING notice's dedupe key — that would make a
        // reminder look like a duplicate of the booking email and silently drop
        // it. And it makes a second scan a no-op even if marking the row 'sent'
        // failed, so a crash between the queue and the write cannot double-send.
        entityId: `${reminder.eid}:reminder`
      });
    } catch (e) {
      console.error('[APPT] reminder notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- T1 C4: the day-of video nudge --------------------------------------
  //
  // Half an hour before a video visit, with the one-tap link. It rides the
  // SAME reminder store, the same scanner and the same recipient rules as the
  // day-before reminder; what differs is the copy, the timing and the button.
  //
  // THE LINK ONLY GOES OUT WHERE THE TRANSPORT IS COVERED. `videoReminderCopy`
  // returns no joinUrl on the vague path, and `ctaFor` is only consulted when
  // detail is allowed — so a transport outside the BAA sends "sign in to your
  // portal" and nothing else.
  async function videoReminder({ reminder, orgPhone, actorId, ctaFor }) {
    try {
      const detail = transportAllowsDetail();
      const copy = reminders.videoReminderCopy({
        detail, when: reminder.when, orgPhone,
        timeOfDay: reminders.timeOfDayFor(reminder.visitDate, reminder.startTime)
      });
      return await sendToClientSide({
        clientId: reminder.clientId,
        type: 'visit_reminder',
        subject: copy.subject,
        headline: copy.headline,
        paragraphs: copy.paragraphs,
        fields: visitFields(detail, { when: reminder.when, clinician: reminder.clinician, place: reminder.place }),
        actorId,
        ctaFor: detail ? ctaFor : null,
        // Its own dedupe key: a bare `${eid}:reminder` would collide with the
        // day-before notice and the nudge would be swallowed as a duplicate of
        // it — the trap the document-request chase already paid for.
        entityId: `${reminder.eid}:video-join`
      });
    } catch (e) {
      console.error('[APPT] video reminder failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- Portal P1: a visit summary is ready (owner, 2026-09-29) --------------
  // Sent when a signed visit is PUBLISHED to the portal, and on a republish
  // only when the summary or note text changed (the caller decides that from
  // the content hash, which is also in the dedupe key). The visit date is PHI,
  // so it rides only where the transport is covered.
  async function visitSummaryReady({ clientId, encounterUuid, contentHash, visitDate, actorId, hasNote = true }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId,
        type: 'visit_summary_ready',
        subject: detail && visitDate ? `Your visit summary from ${visitDate} is ready` : 'A visit summary is ready in your portal',
        headline: 'Your visit summary is ready',
        paragraphs: detail && visitDate
          ? [`Your visit summary from ${visitDate} is ready to read in your portal${hasNote ? ", along with your clinician's note" : ''}.`,
             'If anything in it is unclear, message your care team from the portal.']
          : [`Your visit summary is ready to read in your secure portal${hasNote ? ', along with your clinician\'s note' : ''}.`,
             'For privacy we do not put visit details in email.'],
        actorId,
        entityId: `${encounterUuid}:summary:${contentHash}`,
        entityType: 'visit'
      });
    } catch (e) {
      console.error('[PORTAL] visit summary notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- Portal P1: a test result was reviewed (owner, 2026-09-29) -----------
  // Results are VISIBLE to the patient the moment they are filed, but nobody is
  // TOLD until a clinician has reviewed one — an email about a result nobody
  // has looked at yet invites a phone call the office cannot answer. Never the
  // value, the test name or the clinician's note: that is in the portal.
  async function resultReviewed({ clientId, resultId, actorId }) {
    try {
      return await sendToClientSide({
        clientId,
        type: 'result_reviewed',
        subject: 'A test result has been reviewed by your care team',
        headline: 'A test result has been reviewed',
        paragraphs: ['Your test result has been reviewed by your care team. You can read it, and any note they added, in your portal.',
          'For privacy we do not put results in email.'],
        actorId,
        entityId: `${resultId}:reviewed`,
        entityType: 'result'
      });
    } catch (e) {
      console.error('[PORTAL] result reviewed notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 5. Staff asked the client for documents (or chased them) ------------
  // This notice and the follow-up below used to go out through a raw sendEmail
  // call. Three things followed from that and none of them were intended: a
  // client who had unsubscribed or whose account was deactivated was emailed
  // anyway, the message arrived as unbranded plain text beside notices that
  // carry the house style, and a failed send was neither retried nor logged.
  // Routing them through the queue like everything else fixes all three at
  // once, and brings them under the same transport-aware detail rule.
  async function documentsRequested({ clientId, rows, isReminder, dueAt, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const { client, recipients } = await clientSideRecipients(clientId);
      if (!client) return { notified: 0, reason: 'no client record' };
      if (!recipients.length) return { notified: 0, reason: 'no email address on file' };
      const url = await portalUrlFor(client);
      const list = (rows || []).map(r => r && r.label).filter(Boolean);
      const count = list.length;
      const noun = count === 1 ? 'document' : 'documents';
      const due = dueAt || (rows || []).map(r => r && r.dueAt).find(Boolean);

      let n = 0;
      for (const { user, actingFor } of recipients) {
        const forWhom = actingFor ? ` for ${actingFor.name}` : '';
        const paragraphs = detail
          ? [isReminder
              ? `A quick reminder — we are still waiting on ${count} ${noun}${forWhom} to finish setting up care.`
              : `We need ${count} ${noun}${forWhom} to finish setting up care.`,
             'Upload them from the Documents tab in your portal. A clear phone photo is fine for most of them.']
          : [isReminder
              ? `A quick reminder — we are still waiting on ${count} ${noun}${forWhom}.`
              : `We need ${count} ${noun}${forWhom} to finish setting up care.`,
             'The list is in your secure portal, along with the button to upload each one. For privacy we do not name documents in email.'];
        if (detail && due) {
          paragraphs.push(`Please send these by ${new Date(due).toLocaleDateString('en-US', { dateStyle: 'long' })}.`);
        }
        const ok = await send({
          type: isReminder ? 'phc_documents_reminder' : 'phc_documents_requested',
          user,
          subject: isReminder ? 'A reminder about your documents' : `${count} ${noun} needed for your file`,
          headline: isReminder ? 'Still waiting on a few documents' : `We need a few ${noun}`,
          paragraphs,
          // The document NAMES are the detail. "Advance directive" and
          // "Guardianship order" say something about a named person's
          // circumstances, so they ride only on a transport that may carry it.
          callout: detail && count ? list.join(' · ') : null,
          calloutLabel: 'What we need',
          ctaUrl: url, ctaLabel: 'Open your portal',
          // A reminder is a deliberate second ask, so it must not be collapsed
          // into the original request by the queue's duplicate check.
          relatedEntityId: `${client.id}:docs:${isReminder ? 'remind' : 'request'}:${(rows || []).map(r => r && r.id).filter(Boolean).sort().join(',')}`,
          relatedEntityType: 'document',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] document-request notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  async function appointmentRescheduled({ client, eid, from, to, clinician, place, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId: client.id,
        type: 'appointment_rescheduled',
        // "Your visit" here is the CLINICIAN's visit. The caregiver-shift
        // notices say "your caregiver's visit", so a client reading either one
        // knows which kind of visit moved. Two notices reading "Your care visit
        // has been rescheduled" and "Your visit has moved to …" told them a
        // visit had changed and left them to guess which.
        subject: detail ? `Your clinician visit has moved to ${to}` : 'A clinician visit has been rescheduled',
        headline: 'Your clinician visit has moved',
        paragraphs: detail
          ? [`Your visit with the clinician has moved from ${from} to ${to}.`,
             'Nothing else about the visit has changed. Call the office if the new time does not work.']
          : ['A visit has been moved to a new time. The new details are in your secure portal.',
             'For privacy we do not put visit details in email.'],
        fields: visitFields(detail, { when: to, clinician, place }),
        actorId, entityId: eid
      });
    } catch (e) {
      console.error('[APPT] reschedule notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 6. Staff requested follow-up on the enrollment checklist ------------
  // The outstanding items are consent titles and face-sheet field labels. A
  // list naming "Advance directive status" and "Allergies" for one identified
  // person is the same class of detail as a document name, so it follows the
  // same rule rather than being treated as harmless because it is only labels.
  async function enrollmentFollowUp({ clientId, itemLabels, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const { client, recipients } = await clientSideRecipients(clientId);
      if (!client) return { notified: 0, reason: 'no client record' };
      if (!recipients.length) return { notified: 0, reason: 'no email address on file' };
      const url = await portalUrlFor(client);
      const list = (itemLabels || []).filter(Boolean);
      const count = list.length;
      const noun = count === 1 ? 'item' : 'items';

      let n = 0;
      for (const { user, actingFor } of recipients) {
        const forWhom = actingFor ? ` on ${actingFor.name}'s enrollment` : '';
        const ok = await send({
          type: 'phc_enrollment_follow_up',
          user,
          subject: 'Action needed to finish your enrollment',
          headline: 'A few things still need you',
          paragraphs: detail
            ? [`${count} ${noun}${forWhom} still need you before we can finish enrollment.`,
               'Sign in to your portal to complete them. Everything else is already on file.']
            : [`${count} ${noun}${forWhom} still need your attention before we can finish enrollment.`,
               'The list is waiting in your secure portal. For privacy we do not put the details in email.'],
          callout: detail && count ? list.join(' · ') : null,
          calloutLabel: 'What still needs you',
          ctaUrl: url, ctaLabel: 'Open your portal',
          relatedEntityId: `${client.id}:followup:${list.slice().sort().join(',')}`,
          relatedEntityType: 'enrollment',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] enrollment follow-up notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  async function appointmentCancelled({ client, eid, when, reason, clinician, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId: client.id,
        type: 'appointment_cancelled',
        subject: detail ? `Your visit on ${when} is cancelled` : 'A visit has been cancelled',
        headline: 'Your visit is cancelled',
        paragraphs: detail
          ? [`Your visit on ${when} has been cancelled.`,
             'Nothing else has changed about your care. Call the office when you are ready to rebook.']
          : ['A scheduled visit has been cancelled. The details are in your secure portal.',
             'Call the office when you are ready to rebook.'],
        fields: visitFields(detail, { when, clinician, place: null }),
        // The cancellation reason is staff free text. It rides only where the
        // transport can carry it, the same rule the document rejection follows.
        callout: detail && reason ? reason : null,
        calloutLabel: 'Why it was cancelled',
        actorId, entityId: eid
      });
    } catch (e) {
      console.error('[APPT] cancel notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A message is waiting, for a STAFF recipient (2026-10-12) ------------
  //
  // The patient half of this notice follows the PHI-free rule; the staff half
  // did not. It carried `"<channel> — <client name>"` in the subject and the
  // client's name again in the body, and it was NOT marked as PHI — so a
  // transport outside the BAA would have sent "Clinical Escalation — Ada Bell"
  // anyway. Every other staff notice in this file gates its detail on the live
  // transport; this one was the exception, and an exception nobody chose is a
  // drift rather than a decision.
  //
  // It lives here rather than in the messaging router for one reason: the
  // question "how much may this email say" is answered in ONE place, by
  // `transportAllowsDetail()`, re-read on every send. A second copy in a route
  // is how the two start disagreeing.
  //
  // The ROUTER still decides WHO is on the thread — that is thread visibility
  // and it belongs with the matrix, not here. This takes the recipient it is
  // given.
  async function staffMessageWaiting({ user, clientName, channelLabel, senderName, messageId, ctaUrl, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const who = senderName || 'Someone';
      return {
        notified: await send({
          type: 'message_received',
          user,
          // On a covered transport a staff member needs to know WHICH client
          // and which conversation, or the notice is not actionable. On an
          // uncovered one they are told a message is waiting and nothing else.
          subject: detail && clientName
            ? `${channelLabel ? `${channelLabel} — ` : ''}${clientName}`
            : 'A new message is waiting',
          headline: 'A new message is waiting',
          // THE MESSAGE ITSELF IS NEVER IN THE EMAIL, on either path. A
          // notification that carries the message carries PHI into an inbox;
          // one that says a message is waiting does not.
          // WHEN THE SENDER *IS* THE CLIENT, naming both reads "Ada Bell sent
          // you a message about Ada Bell." The old wording did exactly that on
          // every client-written thread, which is most of them — found by
          // rendering it, not by reading it.
          paragraphs: detail && clientName
            ? [who === clientName
                ? `${clientName} sent you a message.`
                : `${who} sent you a message about ${clientName}.`,
               'Open the app to read it. The message itself is not in this email.']
            : ['Someone sent you a message about a client.',
               'Open the app to read it. For privacy we do not name the client or the conversation in email.'],
          // WHERE THIS PERSON READS MESSAGES, not where a client does.
          // Messaging mounts on four surfaces, and the caller resolves it per
          // recipient.
          ctaUrl, ctaLabel: 'Open messages',
          relatedEntityId: messageId, relatedEntityType: 'message',
          actorId, phi: !!(detail && clientName)
        }) ? 1 : 0,
        detailed: detail
      };
    } catch (e) {
      console.error('[MSG] staff message notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- Caregiver visits (PHCP), 2026-10-12 ---------------------------------
  //
  // These two were hand-rolled inside routes/scheduling.js: one bare sentence
  // each, no headline, no When line, and sent to the CLIENT only. Beside the
  // fourteen notices in this file they read as though a different company had
  // sent them, and a designated POA managing someone's care was never told
  // their caregiver visit had moved.
  //
  // Routing them here gets all of it from one place: the client plus a POA and
  // never non-POA family, the unsubscribe honour, the house template, and the
  // transport-aware detail rule. They say "your caregiver's visit" rather than
  // "your visit", because the clinician notices above own that phrase and a
  // client who gets both has to be able to tell them apart.
  async function caregiverVisitConfirmed({ clientId, caregiverName, when, actorId, shiftId }) {
    try {
      const detail = transportAllowsDetail();
      const who = caregiverName || 'A caregiver';
      return await sendToClientSide({
        clientId,
        type: 'shift_confirmed_client',
        subject: detail ? 'Your caregiver visit is confirmed' : 'A caregiver visit is confirmed',
        headline: 'Your caregiver visit is confirmed',
        paragraphs: detail
          ? [`Your caregiver visit${when ? ` on ${when}` : ''} is confirmed. ${who} will be visiting.`,
             'Call the office if anything about the time needs to change.']
          : ['A caregiver visit has been confirmed. The time is in your secure portal.',
             'For privacy we do not put visit details in email.'],
        fields: detail
          ? [{ label: 'When', value: when }, { label: 'Who', value: caregiverName }].filter(f => f.value)
          : [],
        actorId,
        entityId: `${shiftId}:confirmed-client`,
        entityType: 'shift'
      });
    } catch (e) {
      console.error('[PHCP] caregiver visit confirmed notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // Only ever for a visit still to come. "Your visit has been rescheduled" is
  // false about one that already happened, and a client has nothing to do about
  // a correction to our own timesheet — that gate lives at the call site, which
  // is the only place that knows whether the shift is ahead of us.
  async function caregiverVisitMoved({ clientId, caregiverName, from, to, actorId, shiftId, editCount }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId,
        type: 'shift_time_changed_client',
        subject: detail && to ? `Your caregiver visit has moved to ${to}` : 'A caregiver visit has been rescheduled',
        headline: "Your caregiver's visit has moved",
        paragraphs: detail
          ? [`Your caregiver visit has moved${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}.`,
             'The same care is planned. Call the office if the new time does not work.']
          : ['A caregiver visit has been moved to a new time. The new time is in your secure portal.',
             'For privacy we do not put visit details in email.'],
        fields: detail
          ? [{ label: 'New time', value: to }, { label: 'Previous time', value: from },
             { label: 'Who', value: caregiverName }].filter(f => f.value)
          : [],
        actorId,
        entityId: `${shiftId}:edited-client:${editCount}`,
        entityType: 'shift'
      });
    } catch (e) {
      console.error('[PHCP] caregiver visit moved notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 7. An admin approved the enrollment ---------------------------------
  // Nobody told the client. They completed intake, signed everything, waited,
  // and the one event that says "you are done" was silent. It carries no
  // detail worth gating: that a person is enrolled with us is the same fact
  // the welcome email already established.
  async function enrollmentApproved({ clientId, overridden, actorId }) {
    try {
      const { client, recipients } = await clientSideRecipients(clientId);
      if (!client) return { notified: 0, reason: 'no client record' };
      if (!recipients.length) return { notified: 0, reason: 'no email address on file' };
      const url = await portalUrlFor(client);

      let n = 0;
      for (const { user, actingFor } of recipients) {
        const forWhom = actingFor ? ` for ${actingFor.name}` : '';
        // AN OVERRIDE AND A CLEAN APPROVAL ARE DIFFERENT NEWS, so they are
        // different emails rather than the same one with a caveat stapled on.
        // The earlier version opened "approved and complete, everything we
        // needed is on file" and then said two paragraphs later that items
        // were outstanding — both sentences in one message, the first of them
        // untrue. The opening line now changes with the facts.
        const paragraphs = overridden
          ? [`Enrollment${forWhom} is approved and we can start care.`,
             'A few items are still outstanding on your file. We have gone ahead so care is not delayed, and someone will follow up with you about them.',
             'Your portal has your plan, your documents and your signed paperwork whenever you want them.']
          : [`Enrollment${forWhom} is approved and complete. Everything we needed is on file.`,
             'We can start care now. Someone will be in touch about start dates.',
             'Your portal has your plan, your documents and your signed paperwork whenever you want them.'];
        const ok = await send({
          type: 'phc_enrollment_approved',
          user,
          subject: overridden ? 'Your enrollment is approved' : 'Your enrollment is complete',
          headline: overridden ? 'Your enrollment is approved' : 'Your enrollment is complete',
          paragraphs,
          ctaUrl: url, ctaLabel: 'Open your portal',
          relatedEntityId: `${client.id}:enrolled`,
          relatedEntityType: 'enrollment',
          actorId, phi: false
        });
        if (ok) n += 1;
      }
      return { notified: n };
    } catch (e) {
      console.error('[PHC] enrollment-approved notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  return {
    // private home care
    documentUploaded, documentReviewed, consentSigned, carePlanCoSigned,
    documentsRequested, enrollmentFollowUp, enrollmentApproved,
    // clinical visits
    appointmentBooked, appointmentRescheduled, appointmentCancelled, visitReminder, videoReminder,
    // patient portal (P1)
    visitSummaryReady, resultReviewed,
    // caregiver visits (PHCP)
    caregiverVisitConfirmed, caregiverVisitMoved,
    // messaging
    staffMessageWaiting
  };
}

module.exports = { createNotifier };
