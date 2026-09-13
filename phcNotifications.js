// ============================================================================
// PRIVATE HOME CARE NOTIFICATIONS
// ============================================================================
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
// HOW MUCH EACH EMAIL MAY SAY DEPENDS ON THE LIVE TRANSPORT, and that is the
// point rather than an inconvenience. "Ada Bell's care plan is signed" is
// protected health information. On Resend, which carries no BAA, these notices
// say only that something is waiting; on Google Workspace they say what it is,
// and the detailed version is marked { phi: true } so the mailer refuses it
// outright if the transport changes underneath us.
//
// Every function here is best-effort. A notification failure must never undo
// an upload, a review, a signature or a co-signature that already succeeded.
// ============================================================================

const { renderGfcEmail } = require('./emailTemplates');

// Roles that receive staff-side PHC notices. Mirrors ENROLLMENT_STAFF_ROLES in
// server.js — passed in rather than restated, so the two cannot drift.
function createPhcNotifier(deps) {
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

  const send = async ({ type, user, subject, headline, paragraphs, callout, ctaUrl, ctaLabel, relatedEntityId, relatedEntityType, actorId, phi }) => {
    const rendered = renderGfcEmail({
      greeting: firstNameOf(user), headline, paragraphs, callout, ctaUrl, ctaLabel
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
                   'You can upload a replacement from the Documents tab in the portal. There is nothing else to do in the meantime.']
                : [`One of the documents${forWhom} needs to be sent again.`,
                   'The reason is in the secure portal, along with the button to upload a replacement. For privacy we do not put document details in email.'])
            : (detail
                ? [`We received ${thing}${forWhom} and it has been accepted. Nothing further is needed.`]
                : [`A document${forWhom} was received and accepted. Nothing further is needed.`]),
          // The reason rides in the callout, and ONLY when the transport can
          // carry it. Staff type this field freely, so it is treated as PHI.
          callout: rejected && detail && reason ? reason : null,
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
             'You can upload them from the Documents tab in your portal. A clear phone photo is fine for most of them.']
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
            ? [`${count} ${noun}${forWhom} still need your attention before we can finish enrollment.`,
               'Sign in to your portal to complete them. Everything else is already on file.']
            : [`${count} ${noun}${forWhom} still need your attention before we can finish enrollment.`,
               'The list is waiting in your secure portal. For privacy we do not put the details in email.'],
          callout: detail && count ? list.join(' · ') : null,
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
        const paragraphs = [
          `Enrollment${forWhom} is approved and complete. Everything we needed is on file.`,
          'We can now schedule care. Someone from our team will be in touch about start dates, and your portal has your plan, your documents and your signed paperwork whenever you want them.'
        ];
        // An override means enrollment was approved with items outstanding.
        // Saying nothing would leave the client believing their file is
        // complete when staff know it is not.
        if (overridden) {
          paragraphs.push('A few items are still outstanding on your file. We have gone ahead so care is not delayed, and we will follow up with you about them.');
        }
        const ok = await send({
          type: 'phc_enrollment_approved',
          user,
          subject: 'Your enrollment is complete',
          headline: 'Your enrollment is complete',
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

  return { documentUploaded, documentReviewed, consentSigned, carePlanCoSigned,
           documentsRequested, enrollmentFollowUp, enrollmentApproved };
}

module.exports = { createPhcNotifier };
