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
const familyLinks = require('./familyLinks');   // POA is per patient; one family account can cover several

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

  // A POA can be linked to several patients and opens one at a time
  // (familyLinks.js), so their button names WHICH patient: /portal?for=<id>
  // switches to that patient on arrival. The id is an opaque record id, not
  // a name. The patient's own button is unchanged.
  const ctaForRecipient = (url, client, actingFor) => {
    if (!actingFor || !client) return url;
    const base = String(url).replace(/\/portal(\/.*)?$/, '');
    return `${base}/portal?for=${encodeURIComponent(client.id)}`;
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
    // A patient with no login of their own (placeholder email) has no inbox;
    // their POA below hears about it instead.
    if (client.email && !familyLinks.isPlaceholderEmail(client.email)) recipients.push({ user: client, actingFor: null });
    // POA is per patient (familyLinks.js): a family account linked to several
    // patients hears only about the ones it is POA for. A placeholder login
    // has no inbox.
    for (const { user: u } of familyLinks.familyFor(users, clientId, { poaOnly: true, activeOnly: false })) {
      if (u.role === familyRole && u.email && !familyLinks.isPlaceholderEmail(u.email)) {
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
          ctaUrl: ctaForRecipient(url, client, actingFor), ctaLabel: 'Open your portal',
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
        ctaUrl: (cta && cta.url) || ctaForRecipient(url, client, actingFor),
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
          ctaUrl: ctaForRecipient(url, client, actingFor), ctaLabel: 'Open your portal',
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
          ctaUrl: ctaForRecipient(url, client, actingFor), ctaLabel: 'Open your portal',
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
          ctaUrl: ctaForRecipient(url, client, actingFor), ctaLabel: 'Open your portal',
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

  // ---- Clinical to-dos, 2026-10-14 -----------------------------------------
  //
  // Owner: "email every time a task is assigned, due, overdue (one email about
  // task a day) and then marked completed." Until now a to-do was written to
  // the record and nothing was sent: the assignee found out by opening the
  // workspace, and the person who wrote it had no way to know it had landed.
  //
  // WHO MAY BE TOLD IS THE `canSee` RULE AND NOTHING WIDER (owner, 2026-10-13:
  // a to-do is seen only by the person it is assigned to and the person who
  // wrote it). So these four notices only ever address one of those two, and a
  // notice is never copied to admin or to the rest of the team. Emailing
  // someone a to-do they cannot open in the app would hand out by push what
  // the read gate refuses.
  //
  // A TO-DO'S TITLE IS PHI. It is free text a clinician wrote about a named
  // patient's healthcare — the to-do's own history already refuses to store
  // it for that reason. So the detailed wording names the patient and the
  // title, is marked { phi: true }, and is sent only when the live transport
  // is inside the BAA; otherwise the notice says a to-do is waiting and
  // nothing else.
  //
  // THE TITLE STAYS OUT OF THE SUBJECT LINE even when detail is allowed. A
  // subject is what shows on a lock screen and in a notification preview, so
  // it carries at most the patient's name, which is the precedent the staff
  // message notice set; what the to-do actually says waits inside.
  const taskNotice = async ({
    type, user, task, patientName, subjectDetail, subjectVague,
    headline, detailParagraphs, vagueParagraphs, ctaUrl, ctaLabel, dedupeId, actorId
  }) => {
    const detail = transportAllowsDetail();
    const named = !!(detail && patientName);
    return await send({
      type, user,
      subject: named ? `${subjectDetail} — ${patientName}` : subjectVague,
      headline,
      paragraphs: named ? detailParagraphs(patientName) : vagueParagraphs,
      ctaUrl, ctaLabel: ctaLabel || 'Open to-dos',
      // The dedupe id is the task for an event and `<task>:<kind>:<date>` for
      // a reminder, which is what holds the daily sweep to one email a day.
      relatedEntityId: dedupeId || (task && task.id), relatedEntityType: 'clinical_task',
      actorId, phi: named
    }) ? 1 : 0;
  };

  // A due date in words. Bare calendar dates are read at midday UTC: parsed as
  // UTC midnight a date renders as the evening before in Georgia.
  const dueLine = (ymd) => {
    if (!ymd) return null;
    const d = new Date(`${ymd}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null
      : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  };

  // A due TIME in words. Formatted from its own digits rather than through a
  // Date, which is the rule `fmtClock` already sets: a wall-clock time carries
  // no date and no zone, so running it through `Date` renders an invention.
  const timeLine = (hm) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hm || ''))) return null;
    const h = Number(String(hm).slice(0, 2)), m = String(hm).slice(3, 5);
    return `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  };

  // "Friday, October 16 at 2:00 PM", or just the day when no time was given.
  const dueWhen = (task) => {
    const day = dueLine(task && task.dueDate);
    if (!day) return null;
    const at = timeLine(task && task.dueTime);
    return at ? `${day} at ${at}` : day;
  };

  // ---- 1. Somebody handed you a to-do --------------------------------------
  // Sent to the ASSIGNEE, and only when somebody else assigned it: an email
  // telling you about the to-do you just wrote for yourself is noise.
  async function taskAssigned({ user, task, patientName, assignedByName, ctaUrl, actorId }) {
    try {
      const who = assignedByName || 'Someone';
      const due = dueWhen(task);
      return {
        notified: await taskNotice({
          type: 'clinical_task_assigned', user, task, patientName, ctaUrl, actorId,
          subjectDetail: 'New to-do', subjectVague: 'A to-do was assigned to you',
          headline: 'A to-do was assigned to you',
          detailParagraphs: (name) => [
            `${who} assigned you a to-do for ${name}: "${task.title}".`,
            due ? `It is due ${due}.` : 'It has no due date.',
            'Open the workspace to see it in full, or to mark it done.'
          ],
          vagueParagraphs: [
            'Someone assigned you a to-do for a patient.',
            'Open the workspace to read it. For privacy we do not name the patient or the to-do in email.'
          ]
        }),
        detailed: transportAllowsDetail()
      };
    } catch (e) {
      console.error('[TASK] assigned notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 2. A to-do is due today ---------------------------------------------
  async function taskDueToday({ user, task, patientName, ctaUrl, dedupeId }) {
    try {
      const at = timeLine(task && task.dueTime);
      return {
        notified: await taskNotice({
          type: 'clinical_task_due', user, task, patientName, ctaUrl, dedupeId,
          subjectDetail: 'To-do due today', subjectVague: 'You have a to-do due today',
          headline: 'A to-do is due today',
          detailParagraphs: (name) => [
            at ? `Your to-do for ${name} is due now, at ${at}: "${task.title}".`
               : `Your to-do for ${name} is due today: "${task.title}".`,
            'Open the workspace to mark it done, or move the date if it needs longer.'
          ],
          vagueParagraphs: [
            at ? `One of your to-dos is due now, at ${at}.` : 'One of your to-dos is due today.',
            'Open the workspace to see it. For privacy we do not name the patient or the to-do in email.'
          ]
        }),
        detailed: transportAllowsDetail()
      };
    } catch (e) {
      console.error('[TASK] due notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 3. A to-do is overdue -----------------------------------------------
  // Sent once a day for as long as it stays open, which is the point: the
  // to-do nobody has answered is the one most likely to have been forgotten.
  async function taskOverdue({ user, task, patientName, daysLate, ctaUrl, dedupeId }) {
    try {
      const n = Number(daysLate) > 0 ? Number(daysLate) : 1;
      const at = timeLine(task && task.dueTime);
      const late = `${n === 1 ? 'yesterday' : `${n} days ago`}${at ? ` at ${at}` : ''}`;
      return {
        notified: await taskNotice({
          type: 'clinical_task_overdue', user, task, patientName, ctaUrl, dedupeId,
          subjectDetail: 'To-do overdue', subjectVague: 'You have an overdue to-do',
          headline: 'A to-do is overdue',
          detailParagraphs: (name) => [
            `Your to-do for ${name} was due ${late}: "${task.title}".`,
            'Open the workspace to mark it done, move the date, or cancel it with a reason.'
          ],
          vagueParagraphs: [
            `One of your to-dos was due ${late} and is still open.`,
            'Open the workspace to see it. For privacy we do not name the patient or the to-do in email.'
          ]
        }),
        detailed: transportAllowsDetail()
      };
    } catch (e) {
      console.error('[TASK] overdue notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 4. A to-do you handed out is finished -------------------------------
  // Sent to the AUTHOR, and only when somebody else finished it. The author is
  // the person waiting on it; the assignee just ticked the box and does not
  // need telling what they themselves did.
  async function taskCompleted({ user, task, patientName, completedByName, ctaUrl, actorId }) {
    try {
      const who = completedByName || 'Someone';
      const note = task && task.completionNote ? task.completionNote : null;
      return {
        notified: await taskNotice({
          type: 'clinical_task_completed', user, task, patientName, ctaUrl, actorId,
          subjectDetail: 'To-do finished', subjectVague: 'A to-do you assigned is finished',
          headline: 'A to-do you assigned is finished',
          detailParagraphs: (name) => [
            `${who} marked your to-do for ${name} done: "${task.title}".`,
            ...(note ? [`They added: "${note}"`] : []),
            'Open the workspace to see it.'
          ],
          vagueParagraphs: [
            'A to-do you assigned to somebody has been marked done.',
            'Open the workspace to see it. For privacy we do not name the patient or the to-do in email.'
          ]
        }),
        detailed: transportAllowsDetail()
      };
    } catch (e) {
      console.error('[TASK] completed notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 8. A manager or coordinator asked for a service line or rate change --
  // Owner, 2026-10-19: those changes wait for the Super Admin, so the Super
  // Admin is told. Never the client: nothing has changed for them yet. The
  // client's name stays out of the SUBJECT always (a subject is shown in
  // places the body is not), and in the body only on a covered transport.
  async function enrollmentChangeRequested({ client, request, actorId }) {
    try {
      const detail = transportAllowsDetail();
      const owners = await adminRecipients();
      if (!owners.length) return { notified: 0, reason: 'no admin with an email address' };
      const base = await getAppBaseUrl();
      const url = `${base}/admin/enrollment?client=${encodeURIComponent(client.id)}`;
      let n = 0;
      for (const u of owners) {
        const ok = await send({
          type: 'enrollment_change_requested',
          user: u,
          subject: 'A change is waiting for your approval',
          headline: 'A change is waiting for your approval',
          paragraphs: detail
            ? [`${request.requestedBy.name} asked for this change on ${client.name}'s record: ${request.summary}.`,
               request.note ? `Their note: "${request.note}"` : null,
               'Nothing changes until you approve it.'].filter(Boolean)
            : [`${request.requestedBy.name} asked for a service line or rate change on a client's enrollment record. Nothing changes until you approve it.`],
          ctaUrl: url, ctaLabel: 'Review the request',
          relatedEntityId: request.id, relatedEntityType: 'enrollment_change',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] change-request notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 9. The owner answered it ---------------------------------------------
  // The person who asked is told, with the reason on a decline, so they know
  // what to do next without checking the record.
  async function enrollmentChangeDecided({ client, request, actorId }) {
    try {
      const users = await getUsers();
      const asker = users.find(u => u && u.id === request.requestedBy.id && u.email && u.accountStatus !== 'inactive');
      if (!asker) return { notified: 0, reason: 'requester has no email address' };
      const detail = transportAllowsDetail();
      const base = await getAppBaseUrl();
      const approved = request.status === 'approved';
      const ok = await send({
        type: 'enrollment_change_decided',
        user: asker,
        subject: approved ? 'Your change was approved' : 'Your change was declined',
        headline: approved ? 'Your change was approved' : 'Your change was declined',
        paragraphs: [
          detail ? `${request.summary}, for ${client.name}.` : 'Your service line or rate change on a client\'s enrollment record has an answer.',
          approved ? 'It is now in effect.' : null,
          !approved && request.decisionNote ? `Reason: "${request.decisionNote}"` : null
        ].filter(Boolean),
        ctaUrl: `${base}/admin/enrollment?client=${encodeURIComponent(client.id)}`, ctaLabel: 'Open the record',
        relatedEntityId: `${request.id}:decided`, relatedEntityType: 'enrollment_change',
        actorId, phi: detail
      });
      return { notified: ok ? 1 : 0, detailed: detail };
    } catch (e) {
      console.error('[PHC] change-decision notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- Staff onboarding and credentialing, 2026-11-09 ----------------------
  //
  // Owner: "make sure email notifications updates accordingly. Esp for new
  // employees who need onboarding or credentialing reminders."
  //
  // A whole onboarding and credentialing system shipped between 2026-11-06 and
  // 2026-11-08 — chapters A to H, renewals, recurring duties, spaced
  // re-checks, a staff portal — and NOT ONE of it sent an email. A new hire
  // found out what she owed by opening the app; a licence sixty days from
  // lapsing was a number on a screen nobody was obliged to look at. Worst of
  // it: the office returning an item REQUIRES a reason, stored it, and told
  // her nothing — the same defect the client document rejection had, where a
  // client told nothing sends the same blurry photo again.
  //
  // WHAT GOES IN THESE EMAILS IS NOT PHI, and that is a fact about the data,
  // not a shortcut: an onboarding item is employment and credentialing data
  // about a member of staff. So the detail sends on any transport, and
  // `transportAllowsDetail` is deliberately not consulted — a notice that
  // went vague here would say "something is waiting" about a licence that
  // lapses on Friday. The other side of that coin is enforced, not trusted:
  // A PATIENT NEVER APPEARS IN ONE. An onboarding track holds no client, and
  // a build test asserts these notices reach for none.
  //
  // WHO IS TOLD: the person themselves, and the office (an admin or a
  // manager) — never the rest of the team, and never a patient or family.
  // The caller resolves the recipients; these builders take one user each.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // A list for the body, capped so a forty-item first week is readable; the
  // count is stated whether or not every line is shown.
  const listLines = (rows, render, cap = 8) => {
    const shown = rows.slice(0, cap).map(render);
    return rows.length > cap ? shown.concat([`…and ${rows.length - cap} more.`]) : shown;
  };
  const byWhen = (daysLeft, on) => {
    if (!Number.isFinite(daysLeft)) return on ? `due ${on}` : 'no date recorded';
    if (daysLeft < 0) return `EXPIRED ${plural(-daysLeft, 'day', 'days')} ago`;
    if (daysLeft === 0) return 'expires today';
    return `expires in ${plural(daysLeft, 'day', 'days')} (${on})`;
  };

  // ---- 1. Her onboarding has been opened -----------------------------------
  async function staffOnboardingStarted({ user, chapterLabel, waitingCount, ctaUrl, actorId }) {
    try {
      return { notified: await send({
        type: 'staff_onboarding_started', user,
        subject: 'Your GFC onboarding is ready',
        headline: 'Welcome — your onboarding is ready',
        paragraphs: [
          `Your onboarding has been set up${chapterLabel ? ` as ${chapterLabel}` : ''}. It lists what we need from you and what the office takes care of.`,
          waitingCount > 0
            ? `${plural(waitingCount, 'item is', 'items are')} waiting on you to start.`
            : 'Nothing is waiting on you just yet — we will email you when something is.',
          'You can upload documents and sign what needs signing from the portal. We will email you once a day while anything is outstanding, and whenever the office sends something back.'
        ],
        ctaUrl, ctaLabel: 'Open my onboarding',
        relatedEntityId: `onbstart:${user.id}`, relatedEntityType: 'onboarding',
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ONB] start notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 2. The office sent an item back -------------------------------------
  // THE REASON IS THE WHOLE POINT OF THIS NOTICE. The route requires one and
  // was storing it where only a screen could show it.
  async function staffOnboardingReturned({ user, itemTitle, reason, returnedByName, ctaUrl, actorId }) {
    try {
      return { notified: await send({
        type: 'staff_onboarding_returned', user,
        subject: `Needs another look — ${itemTitle}`,
        headline: 'One of your onboarding items came back',
        paragraphs: [
          `${returnedByName || 'The office'} sent back "${itemTitle}".`,
          reason ? `Reason given: "${reason}"` : 'No reason was recorded — ask the office what is needed.',
          'Open your onboarding to put it right and send it again.'
        ],
        ctaUrl, ctaLabel: 'Open my onboarding',
        // Keyed on the item AND the time, so a second return of the same item
        // after she resubmits is its own email rather than a swallowed one.
        relatedEntityId: `onbreturn:${user.id}:${itemTitle}:${distinctMoment()}`, relatedEntityType: 'onboarding',
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ONB] return notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 3. She submitted something for the office to verify -----------------
  async function staffItemSubmitted({ user, staffName, itemTitle, ctaUrl, actorId }) {
    try {
      return { notified: await send({
        type: 'staff_item_submitted', user,
        subject: `Ready to verify — ${staffName}`,
        headline: 'An onboarding item is ready to verify',
        paragraphs: [
          `${staffName} submitted "${itemTitle}".`,
          'Open Staff Onboarding to verify it or send it back with a reason.'
        ],
        ctaUrl, ctaLabel: 'Open staff onboarding',
        relatedEntityId: `onbsubmit:${staffName}:${itemTitle}`, relatedEntityType: 'onboarding',
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ONB] submit notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 4. Her daily digest -------------------------------------------------
  // ONE EMAIL A DAY, EVERYTHING IN IT (owner, 2026-11-09). Her expiring
  // credentials ride here rather than arriving as a second email the same
  // morning. Returned items lead, because they are what she can act on today.
  async function staffOnboardingDigest({ user, digest, ctaUrl, dedupeId }) {
    try {
      const d = digest || {};
      const paras = [];
      if ((d.returned || []).length) {
        paras.push(`SENT BACK TO YOU — ${plural(d.returned.length, 'item', 'items')}:`);
        paras.push(...listLines(d.returned, r => `• ${r.title}${r.reason ? ` — "${r.reason}"` : ''}`));
      }
      if ((d.expiring || []).length) {
        paras.push(`CREDENTIALS — ${plural(d.expiring.length, 'needs', 'need')} renewing:`);
        paras.push(...listLines(d.expiring, x => `• ${x.what} — ${byWhen(x.daysLeft, x.on)}`));
      }
      if ((d.outstanding || []).length) {
        paras.push(`WAITING ON YOU — ${plural(d.outstanding.length, 'item', 'items')}:`);
        paras.push(...listLines(d.outstanding, i => `• ${i.title}`));
      }
      if ((d.recurring || []).length) {
        paras.push('RECURRING DUTIES due:');
        paras.push(...listLines(d.recurring, r => `• ${r.requirement}${r.nextDue ? ` — due ${r.nextDue}` : ''}${r.overdue ? ' (overdue)' : ''}`));
      }
      if ((d.rechecks || []).length) {
        paras.push('TRAINING RE-CHECKS open now:');
        paras.push(...listLines(d.rechecks, m => `• ${m.title}`));
      }
      paras.push('Open your onboarding to work through these. This is one email a day while anything is outstanding.');
      const urgent = (d.returned || []).length || (d.expiring || []).some(x => x.expired);
      return { notified: await send({
        type: 'staff_onboarding_digest', user,
        subject: urgent ? 'Your onboarding needs attention' : 'Your onboarding — what is outstanding',
        headline: 'What is waiting on you',
        paragraphs: paras,
        ctaUrl, ctaLabel: 'Open my onboarding',
        relatedEntityId: dedupeId, relatedEntityType: 'onboarding',
        phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ONB] digest failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 5. A credential is expiring, to the OFFICE --------------------------
  // At 30, 14, 7 and 1 days, and every day once it has lapsed: a lapsed
  // licence is a stop-work condition, not a note for the next roll-up.
  async function staffCredentialExpiring({ user, staffName, staffUserId, credential, milestone, ctaUrl, dedupeId }) {
    try {
      const lapsed = milestone === 0;
      return { notified: await send({
        type: 'staff_credential_expiring', user,
        subject: lapsed ? `EXPIRED — ${credential.what}, ${staffName}` : `Expiring in ${plural(milestone, 'day', 'days')} — ${credential.what}, ${staffName}`,
        headline: lapsed ? 'A credential has expired' : 'A credential is expiring',
        paragraphs: [
          lapsed
            ? `${staffName}'s ${credential.what} ${byWhen(credential.daysLeft, credential.on)}. Check whether this stops them working until it is renewed and verified.`
            : `${staffName}'s ${credential.what} ${byWhen(credential.daysLeft, credential.on)}.`,
          `${staffName} has been told as well, in their daily onboarding email.`,
          'Open Staff Onboarding to record the renewal once the new document arrives.'
        ],
        ctaUrl, ctaLabel: 'Open staff onboarding',
        relatedEntityId: dedupeId, relatedEntityType: 'onboarding',
        phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ONB] credential notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- 6. The office's weekly roll-up --------------------------------------
  async function staffOnboardingWeekly({ user, rollup, ctaUrl, dedupeId }) {
    try {
      const r = rollup || {};
      const paras = [];
      if ((r.waitingOnOffice || []).length) {
        paras.push('WAITING ON THE OFFICE to verify:');
        paras.push(...listLines(r.waitingOnOffice, p => `• ${p.name} — ${plural(p.count, 'item', 'items')}`));
      }
      if ((r.expiring || []).length) {
        paras.push('CREDENTIALS expiring or expired:');
        paras.push(...listLines(r.expiring, p => `• ${p.name} — ${p.expired ? `${plural(p.expired, 'expired', 'expired')}, ` : ''}${plural(p.due, 'due', 'due')}`));
      }
      if ((r.stalled || []).length) {
        paras.push('NOT MOVING — started a while ago, still waiting on them:');
        paras.push(...listLines(r.stalled, p => `• ${p.name} — ${plural(p.count, 'item', 'items')}, started ${p.since}`));
      }
      if ((r.notYetStarted || []).length) {
        paras.push('NO ONBOARDING STARTED YET:');
        paras.push(...listLines(r.notYetStarted, p => `• ${p.name}`));
      }
      paras.push('Open Staff Onboarding to work through these. This goes out once a week.');
      return { notified: await send({
        type: 'staff_onboarding_weekly', user,
        subject: 'Staff onboarding — this week',
        headline: 'Staff onboarding and credentialing',
        paragraphs: paras,
        ctaUrl, ctaLabel: 'Open staff onboarding',
        relatedEntityId: dedupeId, relatedEntityType: 'onboarding',
        phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ONB] weekly roll-up failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ==========================================================================
  // GAPS CLOSED BY THE 2026-11-09 NOTIFICATION AUDIT
  //
  // Every notice below is a state change the app already recorded and told
  // nobody about. Five of them are the SAME DEFECT this file describes twice
  // already (lines 23-27 and the onboarding return above): a route refuses to
  // let somebody proceed without typing an explanation, stores it, and then
  // shows it to nobody. It was fixed for client documents and for onboarding
  // returns and left unfixed in five other places.
  //
  // Nothing here invents a recipient rule. Office notices resolve through
  // staffRecipients/adminRecipients, client notices through sendToClientSide,
  // and a notice aimed at one person is handed that person by the caller.
  // ==========================================================================

  // Admins only, active, with an inbox. For a request or a report that only
  // the Super Admin can action. Was inlined in enrollmentChangeRequested;
  // three more notices need it, and two copies of "who is an admin" is how
  // the two start disagreeing.
  // A monotonic tick for the dedupe keys that must never collide: two returns
  // of the same item inside one millisecond share a Date.now() and the second
  // email is swallowed as a duplicate. Found by a test, not by reading.
  let uniqueTick = 0;
  const distinctMoment = () => `${Date.now()}-${++uniqueTick}`;

  const adminRecipients = async () => {
    const users = await getUsers();
    return users.filter(u => u && u.email && u.role === 'admin' && u.accountStatus !== 'inactive');
  };

  // ---- A1. A caregiver finished their welcome packet -----------------------
  // THIS NOTICE HAS NEVER SENT. routes/welcomePacket.js called
  // queueNotification with a single OBJECT where the signature is positional,
  // so the recipient address was never set, the eligibility gate refused it,
  // and the refusal was logged as a skip rather than an error. The comment
  // above that call promised the house template and an unsubscribe honour;
  // this is the first time either is true.
  async function caregiverPacketSubmitted({ caregiverName, packetId, outstandingCount, ctaUrl, actorId }) {
    try {
      const office = await staffRecipients();
      if (!office.length) return { notified: 0, reason: 'no office recipient with an email address' };
      const name = caregiverName || 'A caregiver';
      let n = 0;
      for (const u of office) {
        const ok = await send({
          type: 'caregiver_packet_submitted', user: u,
          subject: `Welcome packet submitted — ${name}`,
          headline: 'A caregiver finished their welcome packet',
          paragraphs: [
            `${name} has completed and signed their caregiver welcome packet.`,
            Number.isFinite(outstandingCount) && outstandingCount > 0
              ? `${plural(outstandingCount, 'document is', 'documents are')} still outstanding on their checklist.`
              : 'Their document checklist has nothing outstanding.',
            'Their packet and checklist are in the admin hub.'
          ],
          ctaUrl, ctaLabel: 'Open the caregiver queue',
          relatedEntityId: `packet:${packetId || name}`, relatedEntityType: 'welcome_packet',
          // Employment and credentialing data about staff, not a patient's.
          actorId, phi: false
        });
        if (ok) n += 1;
      }
      return { notified: n };
    } catch (e) {
      console.error('[PACKET] submitted notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A2. A caregiver document was sent back ------------------------------
  // The route's own comment says "the caregiver is told what it was". It was
  // not: the reason was stored on the row and shown on a screen. A caregiver
  // told only "not accepted" re-sends the same blurry photo, which is the
  // exact failure the client-side version of this notice was written for.
  async function caregiverDocumentReturned({ user, documentLabel, reason, reviewedByName, ctaUrl, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const label = documentLabel || 'A document';
      return { notified: await send({
        type: 'caregiver_document_returned', user,
        subject: `Needs another look — ${label}`,
        headline: 'One of your documents came back',
        paragraphs: [
          `${reviewedByName || 'The office'} sent back "${label}".`,
          'Open the app to send a clearer copy.'
        ],
        callout: reason || null,
        calloutLabel: reason ? 'Why we need it again' : null,
        ctaUrl, ctaLabel: 'Open my documents',
        // Keyed on the document AND the moment, so a second return after they
        // re-send is its own email rather than one the dedupe swallows.
        relatedEntityId: `cgdoc:${(user && user.id) || 'unknown'}:${label}:${distinctMoment()}`,
        relatedEntityType: 'caregiver_document',
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[CAREGIVER] document return notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A3. An incident the caregiver reported has been closed --------------
  // Closing REQUIRES a follow-up note saying what was done. The person who
  // raised the concern is the one who most needs to know it was dealt with,
  // and was the only person not told.
  async function incidentClosed({ user, incidentId, kindLabel, occurredAt, note, closedByName, ctaUrl, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const detail = transportAllowsDetail();
      // The process clock is pinned to Georgia (server.js line 23), so a
      // bare toLocaleDateString is Eastern. Formatting here rather than at the
      // call site keeps the wording in one place.
      const occurredOn = occurredAt && !Number.isNaN(new Date(occurredAt).getTime())
        ? new Date(occurredAt).toLocaleDateString('en-US', { dateStyle: 'long' })
        : null;
      return { notified: await send({
        type: 'incident_closed', user,
        // The client is never named in a subject line, covered transport or
        // not: a subject shows in places the body does not.
        subject: 'An incident you reported has been closed',
        headline: 'Thank you — that has been dealt with',
        paragraphs: detail
          ? [`${closedByName || 'The office'} has closed the ${kindLabel || 'incident'} you reported${occurredOn ? ` on ${occurredOn}` : ''}.`,
             'What was done is below. Nothing further is needed from you.']
          : ['The office has closed an incident you reported. What was done is recorded in the app.',
             'For privacy we do not put the detail in email.'],
        callout: detail ? (note || null) : null,
        calloutLabel: detail && note ? 'What was done' : null,
        ctaUrl, ctaLabel: 'Open the app',
        relatedEntityId: `incident:${incidentId}:closed`, relatedEntityType: 'incident_report',
        // An incident is about a patient, so the follow-up note is PHI even
        // though the caregiver is staff.
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[CAREGIVER] incident close notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A4. A document was removed from a client's file ---------------------
  // Removal requires a reason. The client could suddenly no longer see a
  // document they had sent us, with no explanation anywhere.
  async function clientDocumentRemoved({ client, label, reason, removedByName, uploadId, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId: client.id,
        type: 'client_document_removed',
        subject: 'A document has been removed from your file',
        headline: 'A document has been removed from your file',
        paragraphs: detail
          ? [`${removedByName || 'Our office'} removed "${label || 'a document'}" from your file.`,
             'If you still need it on file, send it again from your portal and we will file it.']
          : ['A document has been removed from your file. Sign in to your portal to see which one and why.',
             'For privacy we do not name documents in email.'],
        callout: detail ? (reason || null) : null,
        calloutLabel: detail && reason ? 'Why it was removed' : null,
        actorId, entityId: `upload:${uploadId}:removed`, entityType: 'client_document'
      });
    } catch (e) {
      console.error('[PHC] document removal notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A5. A contractor invoice was answered ------------------------------
  // One builder, two types, the way documentReviewed does it: a rejection
  // carries the note the route already REQUIRES "so they can resubmit", and
  // being paid is the other thing a contractor is waiting to hear.
  async function contractorInvoiceDecided({ user, decision, invoiceId, periodLabel, note, decidedByName, ctaUrl, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const paid = decision === 'paid';
      const rejected = decision === 'rejected';
      if (!paid && !rejected) return { notified: 0, reason: `no notice for decision "${decision}"` };
      const forPeriod = periodLabel ? ` for ${periodLabel}` : '';
      return { notified: await send({
        type: paid ? 'contractor_invoice_paid' : 'contractor_invoice_rejected', user,
        subject: paid ? `Your invoice${forPeriod} has been paid` : `Your invoice${forPeriod} needs another look`,
        headline: paid ? 'Your invoice has been paid' : 'Your invoice came back',
        paragraphs: paid
          ? [`Your invoice${forPeriod} has been paid.`,
             // Never an amount or a bank reference in email. The portal holds both.
             'The payment details are on your pay screen.']
          : [`${decidedByName || 'The office'} sent your invoice${forPeriod} back so it can be corrected.`,
             'Put it right and submit it again.'],
        callout: note || null,
        calloutLabel: note ? (paid ? 'Note from the office' : 'What needs changing') : null,
        ctaUrl, ctaLabel: 'Open my pay',
        relatedEntityId: `cinv:${invoiceId}:${decision}`, relatedEntityType: 'contractor_invoice',
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[PAYROLL] contractor invoice notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A6. Somebody asked for a password reset ----------------------------
  // The person is told "an administrator will reach out to you shortly" and
  // no administrator was told anything. A console line was the only signal,
  // which made self-service reset a dead end.
  async function passwordResetRequested({ requesterName, requesterEmail, requestId, ctaUrl, actorId }) {
    try {
      const admins = await adminRecipients();
      if (!admins.length) return { notified: 0, reason: 'no admin with an email address' };
      const detail = transportAllowsDetail();
      let n = 0;
      for (const u of admins) {
        const ok = await send({
          type: 'password_reset_requested', user: u,
          subject: 'Someone is locked out and waiting',
          headline: 'A password reset is waiting',
          paragraphs: detail
            ? [`${requesterName || 'Someone'} (${requesterEmail || 'no address recorded'}) has asked for a password reset.`,
               'They have been told an administrator will reach out, so this one is on the clock.']
            : ['Somebody has asked for a password reset and is waiting to be let back in.',
               'Open the admin hub to see who.'],
          ctaUrl, ctaLabel: 'Open the reset requests',
          relatedEntityId: `pwreset:${requestId || requesterEmail || 'unknown'}`, relatedEntityType: 'password_reset_request',
          // The requester may be a patient, so their name and address are
          // treated as PHI rather than assumed to be a staff address.
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[AUTH] reset-request notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A7. A self sign-up confirmed their email ---------------------------
  // The signer is told "our office will review your account and email you
  // when it is ready". Nothing told the office, so nothing happened next.
  async function selfSignupVerified({ name, email, accountTypeLabel, signupId, ctaUrl, actorId }) {
    try {
      const office = await staffRecipients();
      if (!office.length) return { notified: 0, reason: 'no office recipient with an email address' };
      const detail = transportAllowsDetail();
      let n = 0;
      for (const u of office) {
        const ok = await send({
          type: 'self_signup_verified', user: u,
          subject: 'A new sign-up is waiting for review',
          headline: 'A new sign-up is waiting for review',
          paragraphs: detail
            ? [`${name || 'Someone'} (${email || 'no address recorded'}) has confirmed their email address${accountTypeLabel ? ` and asked for ${accountTypeLabel} access` : ''}.`,
               'They have been told the office will review it and email them when the account is ready, so nothing reaches them until somebody does.']
            : ['Somebody has confirmed their email address and is waiting for their account to be approved.',
               'Open the admin hub to review it.'],
          ctaUrl, ctaLabel: 'Review the sign-up',
          relatedEntityId: `signup:${signupId || email || 'unknown'}`, relatedEntityType: 'signup',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[AUTH] signup notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A8. A family member has been asked for ----------------------------
  // The response says "We will confirm it and email them their sign-in
  // details". The approval leg does email. Nothing told the office there was
  // anything to approve.
  async function familyInviteRequested({ client, inviteeName, inviteeEmail, relationship, requestedByName, inviteId, ctaUrl, actorId }) {
    try {
      const office = await staffRecipients();
      if (!office.length) return { notified: 0, reason: 'no office recipient with an email address' };
      const detail = transportAllowsDetail();
      let n = 0;
      for (const u of office) {
        const ok = await send({
          type: 'family_invite_requested', user: u,
          subject: 'A family invite is waiting for approval',
          headline: 'A family invite is waiting for approval',
          paragraphs: detail
            ? [`${requestedByName || 'A client'} asked us to give ${inviteeName || 'a family member'}${relationship ? ` (${relationship})` : ''} access to ${client && client.name ? `${client.name}'s` : 'their'} portal.`,
               inviteeEmail ? `Their address is ${inviteeEmail}.` : 'No address was given, so one is needed before they can be set up.',
               'They have been told we will confirm it and email their sign-in details, so nobody hears anything until this is approved.']
            : ['A client has asked for a family member to be given portal access.',
               'Open the admin hub to review it. For privacy we do not put names in email.'],
          ctaUrl, ctaLabel: 'Review the request',
          relatedEntityId: `familyinvite:${inviteId || inviteeEmail || 'unknown'}`, relatedEntityType: 'family_invite',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[PHC] family invite notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- A9. Somebody reported a problem -----------------------------------
  // Feedback and bug reports landed in a collection with an admin-only screen
  // in front of it and nothing to say a report had arrived.
  async function feedbackSubmitted({ fromName, fromEmail, category, message, feedbackId, ctaUrl, actorId }) {
    try {
      const admins = await adminRecipients();
      if (!admins.length) return { notified: 0, reason: 'no admin with an email address' };
      const detail = transportAllowsDetail();
      const kind = category === 'bug' ? 'a problem' : 'feedback';
      let n = 0;
      for (const u of admins) {
        const ok = await send({
          type: 'feedback_submitted', user: u,
          subject: category === 'bug' ? 'Somebody reported a problem' : 'New feedback has come in',
          headline: category === 'bug' ? 'Somebody reported a problem' : 'New feedback has come in',
          paragraphs: detail
            ? [`${fromName || 'Someone'}${fromEmail ? ` (${fromEmail})` : ''} reported ${kind}.`]
            : [`Somebody reported ${kind}. Open the admin hub to read it.`,
               'For privacy we do not put the report in email.'],
          // Free text somebody typed. It can name a patient, so it rides only
          // where the transport can carry it.
          callout: detail ? (message || null) : null,
          calloutLabel: detail && message ? 'What they said' : null,
          ctaUrl, ctaLabel: 'Open the inbox',
          relatedEntityId: `feedback:${feedbackId || Date.now()}`, relatedEntityType: 'feedback',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[FEEDBACK] notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ==========================================================================
  // TIER 2 OF THE 2026-11-09 AUDIT — somebody is blocked, or affected, and
  // was not told. Each of these had a suitable notice already built beside it
  // and simply was not wired to the event.
  // ==========================================================================

  // ---- B1. A future shift is cancelled -------------------------------------
  // The largest gap in the app. Bulk-remove emailed; cancelling ONE shift told
  // the holder only when it was already in progress, and told the client
  // nothing at all, ever.
  async function shiftCancelled({ user, when, clientName, reason, ctaUrl, actorId, shiftId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const detail = transportAllowsDetail();
      return { notified: await send({
        type: 'shift_cancelled', user,
        subject: detail ? `Shift cancelled — ${when}` : 'A shift has been cancelled',
        headline: 'A shift has been cancelled',
        paragraphs: detail
          ? [`Your ${when} shift${clientName ? ` for ${clientName}` : ''} has been cancelled. You do not need to go.`,
             'Your schedule in the app is up to date.']
          : ['One of your shifts has been cancelled. Open the app to see which one.',
             'For privacy we do not put visit details in email.'],
        callout: detail ? (reason || null) : null,
        calloutLabel: detail && reason ? 'Why it was cancelled' : null,
        ctaUrl, ctaLabel: 'Open my schedule',
        relatedEntityId: `${shiftId}:cancelled`, relatedEntityType: 'shift',
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[SHIFT] cancel notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // The client's half. Opens with "Your caregiver visit" so the POA rewrite
  // reaches it — the alternation is ordered and the longer phrases come first,
  // which is the bug this wording exists to stay on the right side of.
  async function caregiverVisitCancelled({ clientId, when, shiftId, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId,
        type: 'caregiver_visit_cancelled',
        subject: detail ? `Your caregiver visit on ${when} is cancelled` : 'A caregiver visit has been cancelled',
        headline: 'A caregiver visit has been cancelled',
        paragraphs: detail
          ? [`Your caregiver visit on ${when} has been cancelled.`,
             'Call the office if you need somebody that day and we will arrange cover.']
          : ['One of your caregiver visits has been cancelled. Sign in to your portal to see which one.',
             'For privacy we do not put visit details in email.'],
        // The office's reason for cancelling is internal and is deliberately
        // not forwarded: it can name staffing, illness or a payment question.
        actorId, entityId: `${shiftId}:cancelled-client`, entityType: 'shift'
      });
    } catch (e) {
      console.error('[SHIFT] client cancel notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B2. The office declined a caregiver's claim -------------------------
  // They put their hand up for work and heard nothing back.
  async function shiftClaimDeclined({ user, when, clientName, reason, ctaUrl, actorId, shiftId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const detail = transportAllowsDetail();
      return { notified: await send({
        type: 'shift_claim_declined', user,
        subject: 'A shift you asked for went to somebody else',
        headline: 'That shift went to somebody else',
        paragraphs: detail
          ? [`The ${when} shift${clientName ? ` for ${clientName}` : ''} has gone to another caregiver.`,
             'It is nothing against you. Open the app for the shifts still going.']
          : ['A shift you asked for has gone to another caregiver. Open the app for the ones still going.'],
        callout: detail ? (reason || null) : null,
        calloutLabel: detail && reason ? 'What the office said' : null,
        ctaUrl, ctaLabel: 'See open shifts',
        relatedEntityId: `${shiftId}:claim-declined`, relatedEntityType: 'shift',
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[SHIFT] claim-declined notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B3. A client or POA asked for cover ---------------------------------
  // The request wrote a row and the admin queue was poll-only, so asking for
  // care depended on somebody opening a screen.
  async function coverageRequested({ client, requestedByName, when, note, requestId, ctaUrl, actorId }) {
    try {
      const office = await staffRecipients();
      if (!office.length) return { notified: 0, reason: 'no office recipient with an email address' };
      const detail = transportAllowsDetail();
      let n = 0;
      for (const u of office) {
        const ok = await send({
          type: 'coverage_requested', user: u,
          subject: 'A family has asked for cover',
          headline: 'A family has asked for cover',
          paragraphs: detail
            ? [`${requestedByName || 'A client'} asked for a caregiver${client && client.name ? ` for ${client.name}` : ''}${when ? ` on ${when}` : ''}.`,
               'Nothing is scheduled until somebody posts or assigns a shift.']
            : ['A client has asked for a caregiver visit. Open the board to post or assign it.',
               'Nothing is scheduled until somebody does.'],
          callout: detail ? (note || null) : null,
          calloutLabel: detail && note ? 'What they asked for' : null,
          ctaUrl, ctaLabel: 'Open the shift board',
          relatedEntityId: `shiftreq:${requestId}`, relatedEntityType: 'shift_request',
          actorId, phi: detail
        });
        if (ok) n += 1;
      }
      return { notified: n, detailed: detail };
    } catch (e) {
      console.error('[SHIFT] coverage-request notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B4. An admin typed in or corrected somebody's hours ----------------
  // The approval path emails both ways. A direct edit changed what a person's
  // timesheet says about a day they worked and told them nothing.
  async function timeLogChanged({ user, when, clientName, reason, created, ctaUrl, actorId, logId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const detail = transportAllowsDetail();
      return { notified: await send({
        type: 'time_log_changed', user,
        subject: created ? 'Hours have been added to your timesheet' : 'Your recorded hours have been corrected',
        headline: created ? 'Hours have been added for you' : 'Your recorded hours have been corrected',
        paragraphs: detail
          ? [created
              ? `The office has recorded hours for your ${when} visit${clientName ? ` with ${clientName}` : ''}.`
              : `The office has corrected the hours recorded for your ${when} visit${clientName ? ` with ${clientName}` : ''}.`,
             'Check your pay screen, and tell the office straight away if that does not match the time you worked.']
          : [created
              ? 'The office has recorded hours on your timesheet. Open your pay screen to check them.'
              : 'The office has corrected hours on your timesheet. Open your pay screen to check them.',
             'Tell the office straight away if they do not match the time you worked.'],
        callout: detail ? (reason || null) : null,
        calloutLabel: detail && reason ? 'Reason given' : null,
        ctaUrl, ctaLabel: 'Open my hours',
        relatedEntityId: `tlog:${logId}:${created ? 'created' : 'edited'}`, relatedEntityType: 'time_log',
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[SHIFT] time-log notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B5. A care plan is waiting on a signature --------------------------
  async function carePlanAwaitingCoSign({ client, version, authorName, actorId }) {
    try {
      return await sendToClientSide({
        clientId: client.id,
        type: 'care_plan_awaiting_cosign',
        subject: 'Your care plan is ready to sign',
        headline: 'Your care plan is ready for your signature',
        paragraphs: [
          `${authorName || 'Your nurse'} has written your plan of care. It sets out what we will do, how often, and what we are working towards.`,
          'Read it in your portal and sign it there. Tell us if anything in it is wrong before you sign.'
        ],
        actorId, entityId: `${client.id}:careplan:v${version}:await`, entityType: 'care_plan'
      });
    } catch (e) {
      console.error('[PLAN] awaiting-cosign notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // The provider whose signature the plan is held for. An IHPC plan is not
  // complete without it, and nothing told them it existed.
  async function carePlanAwaitingProviderCoSign({ provider, client, version, authorName, ctaUrl, actorId }) {
    try {
      if (!provider || !provider.email) return { notified: 0, reason: 'no provider with an email address' };
      const detail = transportAllowsDetail();
      return { notified: await send({
        type: 'care_plan_awaiting_provider', user: provider,
        subject: 'A care plan is waiting for your signature',
        headline: 'A care plan is waiting for your signature',
        paragraphs: detail
          ? [`${authorName || 'A nurse'} has authored a plan of care for ${client && client.name ? client.name : 'a patient'} and it is held for your co-signature.`,
             'The plan is not complete until you sign it.']
          : ['A plan of care is held for your co-signature. Open the workspace to sign it.',
             'For privacy we do not name the patient in email.'],
        ctaUrl, ctaLabel: 'Open the care plan',
        relatedEntityId: `careplan:${client && client.id}:v${version}:provider`, relatedEntityType: 'care_plan',
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[PLAN] provider-cosign notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B6. The provider signed it, so the author is unblocked -------------
  async function carePlanProviderCoSigned({ user, client, version, providerName, ctaUrl, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const detail = transportAllowsDetail();
      return { notified: await send({
        type: 'care_plan_provider_cosigned', user,
        subject: 'A care plan you wrote has been signed off',
        headline: 'Your care plan has been signed off',
        paragraphs: detail
          ? [`${providerName || 'The provider'} has co-signed the plan of care you wrote for ${client && client.name ? client.name : 'your patient'}.`,
             'It is complete and filed.']
          : ['A plan of care you wrote has been co-signed and is complete.',
             'For privacy we do not name the patient in email.'],
        ctaUrl, ctaLabel: 'Open the care plan',
        relatedEntityId: `careplan:${client && client.id}:v${version}:cosigned`, relatedEntityType: 'care_plan',
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[PLAN] cosigned notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B7. An internal referral moved ------------------------------------
  // The route's own reply said the referrer "can read your note on the order",
  // which is to say they find out by looking.
  async function referralStepTaken({ user, step, colleagueName, specialty, orderId, ctaUrl, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      if (!['accepted', 'completed'].includes(step)) return { notified: 0, reason: `no notice for step "${step}"` };
      const detail = transportAllowsDetail();
      const done = step === 'completed';
      return { notified: await send({
        type: done ? 'referral_completed' : 'referral_accepted', user,
        // No patient in the subject, and none in the body either: an order
        // reference is enough to find it, and this is a hand-off between
        // colleagues rather than a clinical summary.
        subject: done ? 'A referral you placed has been completed' : 'A referral you placed has been accepted',
        headline: done ? 'Your referral has been completed' : 'Your referral has been accepted',
        paragraphs: detail
          ? [`${colleagueName || 'A colleague'} has ${done ? 'completed' : 'accepted'} the${specialty ? ` ${specialty}` : ''} referral you placed.`,
             done ? 'Their note is on the order in the workspace.' : 'You will hear again when it is completed.']
          : [`A referral you placed has been ${done ? 'completed' : 'accepted'}. Open the workspace to read it.`,
             'For privacy we do not put patient details in email.'],
        ctaUrl, ctaLabel: 'Open the order',
        relatedEntityId: `order:${orderId}:${step}`, relatedEntityType: 'clinical_order',
        actorId, phi: detail
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ORDER] referral-step notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B8. An abnormal result is waiting ---------------------------------
  // Only a CRITICAL result paged anybody. An abnormal one sat in the inbox.
  // Like the critical notice, this builder is handed NO patient and no result:
  // a notice that cannot be given one cannot leak one, which is the strongest
  // guarantee available and the reason the critical notice is shaped this way.
  // Takes a PATH and builds the absolute link from the base URL it already
  // has, rather than being handed a finished one. The route that files a
  // result is lifted out of server.js and run by test/patient_publish.test.js,
  // where `getAppBaseUrl` is not in scope; appLinks is. So the path crosses
  // the boundary and the URL is built here.
  async function abnormalResultWaiting({ user, ctaPath, resultId, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const ctaUrl = `${await getAppBaseUrl()}${ctaPath || '/clinical'}`;
      return { notified: await send({
        type: 'abnormal_result_waiting', user,
        subject: 'An abnormal result is waiting for you',
        headline: 'An abnormal result is waiting for you',
        paragraphs: [
          'A result marked abnormal has been filed against an order of yours and is waiting in your Results inbox.',
          'It needs acknowledging with a note saying what is being done. The office is told if it is still unanswered after two business days.'
        ],
        ctaUrl, ctaLabel: 'Open my results',
        relatedEntityId: `result:${resultId}:abnormal`, relatedEntityType: 'clinical_result',
        // No patient, no value, no interpretation reaches this email.
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[RESULT] abnormal notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B9. A payment went through ----------------------------------------
  // Somebody paid money and got nothing back. The amount rides only where the
  // transport can carry it, because what a patient was charged is theirs.
  async function paymentReceived({ client, invoiceId, amountLabel, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId: client.id,
        type: 'payment_received',
        subject: 'Thank you — your payment has gone through',
        headline: 'Your payment has gone through',
        paragraphs: detail
          ? [`We have received your payment${amountLabel ? ` of ${amountLabel}` : ''}. Your statement is settled.`,
             'Your statements and payment history are in your portal.']
          : ['We have received your payment and your statement is settled.',
             'Your statements are in your portal.'],
        actorId, entityId: `invoice:${invoiceId}:paid`, entityType: 'patient_invoice'
      });
    } catch (e) {
      console.error('[BILLING] payment notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B10. Clinical enrollment was activated ----------------------------
  // The PHC arm emails on approval. The clinical arm said "IHPC enrollment
  // ACTIVATED" to a screen and nobody else.
  async function clinicalEnrollmentActivated({ client, actorId }) {
    try {
      return await sendToClientSide({
        clientId: client.id,
        type: 'clinical_enrollment_activated',
        subject: 'You are enrolled for in-home medical care',
        headline: 'You are enrolled for in-home medical care',
        paragraphs: [
          'Everything we needed is on file and your in-home primary care is active. Your clinician will be in touch about your visits.',
          'Your visits, your plan of care and your records are in your portal.'
        ],
        actorId, entityId: `${client.id}:ihpc-enrolled`, entityType: 'client'
      });
    } catch (e) {
      console.error('[ENROLL] clinical activation notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B11. An admin changed somebody's access ---------------------------
  // The precedent is the password-changed confirmation: a change to how
  // somebody signs in, or to what they may do, is theirs to know about.
  const ACCESS_CHANGES = Object.freeze({
    mfa_reset: {
      subject: 'Your authenticator has been reset',
      headline: 'Your authenticator has been reset',
      lines: ['An administrator has reset the authenticator app on your account, so you will set it up again the next time you sign in.',
              'You have also been signed out everywhere. If you did not ask for this, call the office right away.']
    },
    sessions_revoked: {
      subject: 'You have been signed out everywhere',
      headline: 'You have been signed out everywhere',
      lines: ['An administrator has signed your account out on every device. Signing in again is all that is needed.',
              'If you did not ask for this, call the office right away.']
    },
    deactivated: {
      subject: 'Your GFC account has been turned off',
      headline: 'Your account has been turned off',
      lines: ['An administrator has deactivated your GFC account, so you will not be able to sign in.',
              'If that is not what you expected, call the office.']
    },
    role_changed: {
      subject: 'What you can do in the GFC app has changed',
      headline: 'Your access has changed',
      lines: ['An administrator has changed your role, so what you can see and do in the app has changed.',
              'Sign in to see your screens as they are now. Call the office if something you need has gone.']
    }
  });
  async function accountAccessChanged({ user, change, byName, ctaUrl, actorId }) {
    try {
      if (!user || !user.email) return { notified: 0, reason: 'no email address on file' };
      const copy = ACCESS_CHANGES[change];
      if (!copy) return { notified: 0, reason: `no notice for change "${change}"` };
      return { notified: await send({
        type: `account_${change}`, user,
        subject: copy.subject, headline: copy.headline,
        paragraphs: copy.lines,
        callout: byName ? `Changed by ${byName}.` : null,
        calloutLabel: byName ? 'Who changed it' : null,
        ctaUrl, ctaLabel: 'Open the app',
        relatedEntityId: `access:${user.id}:${change}:${distinctMoment()}`, relatedEntityType: 'account',
        // About the recipient's own account, not a patient's record.
        actorId, phi: false
      }) ? 1 : 0 };
    } catch (e) {
      console.error('[ACCOUNT] access-change notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  // ---- B12. A document was shared to the portal --------------------------
  // Sharing makes a document readable by the patient. They were never told it
  // was there, so it sat unread behind a tab.
  async function documentSharedToPortal({ client, label, sharedByName, uploadId, actorId }) {
    try {
      const detail = transportAllowsDetail();
      return await sendToClientSide({
        clientId: client.id,
        type: 'document_shared',
        subject: 'A document has been added to your portal',
        headline: 'A new document is in your portal',
        paragraphs: detail
          ? [`${sharedByName || 'Our office'} has put "${label || 'a document'}" in your portal for you to read.`,
             'You can open it any time from Documents.']
          : ['A new document is in your portal for you to read. Sign in to open it.',
             'For privacy we do not name documents in email.'],
        actorId, entityId: `upload:${uploadId}:shared`, entityType: 'client_document'
      });
    } catch (e) {
      console.error('[PHC] document-shared notice failed (non-fatal):', e.message);
      return { notified: 0, reason: e.message };
    }
  }

  return {
    // who hears about a client: the client and the POA of THAT client
    clientSideRecipients, ctaForRecipient,
    // private home care
    documentUploaded, documentReviewed, consentSigned, carePlanCoSigned,
    documentsRequested, enrollmentFollowUp, enrollmentApproved,
    // enrollment changes that wait for the owner (2026-10-19)
    enrollmentChangeRequested, enrollmentChangeDecided,
    // clinical visits
    appointmentBooked, appointmentRescheduled, appointmentCancelled, visitReminder, videoReminder,
    // patient portal (P1)
    visitSummaryReady, resultReviewed,
    // caregiver visits (PHCP)
    caregiverVisitConfirmed, caregiverVisitMoved,
    // messaging
    staffMessageWaiting,
    // clinical to-dos
    taskAssigned, taskDueToday, taskOverdue, taskCompleted,
    // staff onboarding and credentialing (2026-11-09)
    staffOnboardingStarted, staffOnboardingReturned, staffItemSubmitted,
    staffOnboardingDigest, staffCredentialExpiring, staffOnboardingWeekly,
    // gaps closed by the 2026-11-09 notification audit
    caregiverPacketSubmitted, caregiverDocumentReturned, incidentClosed,
    clientDocumentRemoved, contractorInvoiceDecided,
    passwordResetRequested, selfSignupVerified, familyInviteRequested, feedbackSubmitted,
    // tier 2 of the same audit: somebody blocked or affected and not told
    shiftCancelled, caregiverVisitCancelled, shiftClaimDeclined, coverageRequested,
    timeLogChanged, carePlanAwaitingCoSign, carePlanAwaitingProviderCoSign,
    carePlanProviderCoSigned, referralStepTaken, abnormalResultWaiting,
    paymentReceived, clinicalEnrollmentActivated, accountAccessChanged, documentSharedToPortal
  };
}

module.exports = { createNotifier };
