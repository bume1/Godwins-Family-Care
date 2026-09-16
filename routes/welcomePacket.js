// ============================================================================
// THE CAREGIVER WELCOME PACKET — routes
// ============================================================================
// The first thing a new caregiver sees after setting their password, and the
// thing that opens the app. Part One is the profile wizard; Part Two is the
// document checklist, which rides the caregiver document store that already
// exists rather than a second one.
//
// KV collection owned here:
//   welcome_packets   one row per caregiver — the draft, the submitted answers,
//                     the signature, and the office's own checklist state
//
// The signature image lives on THAT row, never on the user record: the users
// blob is read on nearly every request and rewritten whole on every write, and
// a PNG per caregiver in it is the care-plan signature mistake repeated.
//
// Every route enforces its own access at the API layer. A caregiver only ever
// reads and writes their OWN packet — the id is resolved from the token and no
// route takes one from the caller, so there is nothing to widen.
// ============================================================================

const express = require('express');
const cg = require('../caregiverRepository');
const wp = require('../welcomePacketRepository');
const gate = require('../caregiverOnboardingGate');
const packetPdf = require('../welcomePacketPdf');
const packetImport = require('../welcomePacketImport');
const attest = require('../caregiverAttestations');
const { contentDisposition } = require('../contentDisposition');

module.exports = function createWelcomePacketRoutes(deps) {
  const {
    db, config, logActivity, queueNotification, getUsers, authenticateToken,
    drive, detectFileType, hashIp
  } = deps;
  const router = express.Router();
  const ROLES = config.ROLES;
  const nowIso = () => new Date().toISOString();

  const requireCaregiver = (req, res, next) => {
    if (cg.isCaregiver(req.user)) return next();
    if (req.user.role === ROLES.VENDOR) {
      return res.status(403).json({
        error: 'No license level is on file for this account. An administrator sets it before the caregiver app opens.',
        code: 'CAREGIVER_NO_LICENSE_LEVEL'
      });
    }
    return res.status(403).json({ error: 'Caregiver access required.', code: 'CAREGIVER_ONLY' });
  };

  const requireAdmin = (req, res, next) => {
    if (req.user.role === ROLES.ADMIN) return next();
    return res.status(403).json({ error: 'Administrator access required.', code: 'ADMIN_ONLY' });
  };

  const freshCaregiver = async (req) => {
    const users = await getUsers();
    return users.find(u => u.id === req.user.id) || null;
  };

  // ---- The packet row -----------------------------------------------------

  const blankPacket = (caregiverId) => ({
    id: `wpkt_${caregiverId}`,
    caregiver_id: caregiverId,
    version: wp.PACKET_VERSION,
    status: 'not_started',
    data: {},
    signature_png: null,
    printed_name: null,
    signed_at: null,
    signer_ip_hash: null,
    signed_offline: false,
    imported_from: null,
    import_source: null,
    imported_at: null,
    office: {},
    created_at: nowIso(),
    updated_at: nowIso()
  });

  const loadPacket = async (caregiverId) => {
    const rows = (await db.get('welcome_packets')) || [];
    return rows.find(r => r && r.caregiver_id === caregiverId) || null;
  };

  const savePacket = async (packet) => {
    const rows = (await db.get('welcome_packets')) || [];
    const idx = rows.findIndex(r => r && r.caregiver_id === packet.caregiver_id);
    packet.updated_at = nowIso();
    if (idx === -1) rows.push(packet); else rows[idx] = packet;
    await db.set('welcome_packets', rows);
    return packet;
  };

  const documentsFor = async (caregiverId) => {
    const rows = (await db.get('caregiver_documents')) || [];
    return rows.filter(r => r && r.caregiver_id === caregiverId);
  };

  const attestationsFor = async (caregiverId) => {
    const rows = (await db.get('caregiver_attestations')) || [];
    return rows.filter(r => r && r.caregiver_id === caregiverId);
  };

  const saveAttestation = async (record) => {
    const rows = (await db.get('caregiver_attestations')) || [];
    const idx = rows.findIndex(r => r && r.caregiver_id === record.caregiver_id && r.kind === record.kind);
    if (idx === -1) rows.push(record); else rows[idx] = record;
    await db.set('caregiver_attestations', rows);
    return record;
  };

  /**
   * Everything the app needs about one caregiver's onboarding, assembled the
   * same way for the caregiver, the admin queue and the scheduling gate. One
   * assembler, because a checklist built one way and gated another is how a
   * caregiver is told they are cleared on a screen that cannot schedule them.
   */
  const stateFor = async (caregiver) => {
    const packet = (await loadPacket(caregiver.id)) || blankPacket(caregiver.id);
    const documents = await documentsFor(caregiver.id);
    const attestations = await attestationsFor(caregiver.id);
    const checklist = wp.buildChecklist(packet.data, documents, packet.office, attestations);
    return { packet, documents, attestations, checklist, summary: gate.onboardingSummary(caregiver, packet, checklist) };
  };

  // Shared with the caregiver route module through the same injection, so the
  // scheduling gate and the app gate read one function.
  router.gateState = stateFor;

  // ==========================================================================
  // GET /api/caregiver/welcome-packet — the form, the draft, the checklist.
  // ==========================================================================
  // The SECTIONS AND THE CHECKLIST ARE SERVED, never restated in the page. The
  // wizard, the validator that refuses an answer the packet did not offer, the
  // PDF and the importer all read one definition; a page that keeps its own
  // copy drifts from the validator and the drift is silent.
  router.get('/api/caregiver/welcome-packet', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      const state = await stateFor(caregiver);
      res.json({
        version: wp.PACKET_VERSION,
        sections: wp.PACKET_SECTIONS,
        groupTitles: wp.GROUP_TITLES,
        groupIntros: wp.GROUP_INTROS,
        payPromise: wp.PAY_PROMISE,
        // THE FOUR SIGNABLE FORMS, SERVED WHOLE. The page renders these blocks
        // and names no clause of its own — the same rule the sections follow,
        // and the reason a signed copy can reproduce exactly what was on screen.
        attestations: attest.servedDocuments(),
        attestationsSigned: state.attestations.map(r => ({
          kind: r.kind, version: r.version, signedAt: r.signed_at,
          printedName: r.printed_name, elections: r.elections || {}
        })),
        status: state.packet.status,
        data: state.packet.data,
        signedAt: state.packet.signed_at,
        importedFrom: state.packet.imported_from,
        importSource: state.packet.import_source,
        checklist: state.checklist,
        onboarding: state.summary
      });
    } catch (error) {
      console.error('Welcome packet read error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // PUT /api/caregiver/welcome-packet — save a draft, one step at a time.
  // ==========================================================================
  // MERGED, not replaced. The wizard saves a step at a time, and a save that
  // replaced the row would wipe the seven sections that step did not carry.
  router.put('/api/caregiver/welcome-packet', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      const packet = (await loadPacket(caregiver.id)) || blankPacket(caregiver.id);

      // A SIGNED packet does not accept edits. A correction after signing is a
      // new signature on a changed document, the rule the consents follow.
      if (packet.status === 'submitted') {
        return res.status(409).json({
          error: 'Your packet is signed. Contact the office to change anything on it.',
          code: 'PACKET_SIGNED'
        });
      }

      const { clean, dropped } = wp.sanitizePacket(req.body && req.body.data);
      packet.data = { ...packet.data, ...clean };
      packet.status = 'in_progress';
      await savePacket(packet);

      const documents = await documentsFor(caregiver.id);
      const attestations = await attestationsFor(caregiver.id);
      const checklist = wp.buildChecklist(packet.data, documents, packet.office, attestations);
      res.json({
        saved: true,
        data: packet.data,
        // What was refused is REPORTED, not silently dropped — a value that
        // vanishes without a word is one the caregiver believes they gave us.
        dropped,
        missing: wp.missingProfileFields(packet.data),
        checklist
      });
    } catch (error) {
      console.error('Welcome packet save error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // POST /api/caregiver/welcome-packet/import — they already filled the PDF.
  // ==========================================================================
  // The file is STORED FIRST and kept whatever the read produces. What we could
  // extract is a convenience; the packet they actually sent is the record, and
  // the office may need to read it by eye when the extraction found nothing.
  router.post('/api/caregiver/welcome-packet/import', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      const packet = (await loadPacket(caregiver.id)) || blankPacket(caregiver.id);
      if (packet.status === 'submitted') {
        return res.status(409).json({ error: 'Your packet is already signed.', code: 'PACKET_SIGNED' });
      }

      const { fileName, fileDataB64 } = req.body || {};
      if (!fileName || !fileDataB64) {
        return res.status(400).json({ error: 'fileName and fileDataB64 are required', code: 'DOC_FIELDS_REQUIRED' });
      }
      let buffer;
      try {
        const raw = String(fileDataB64);
        buffer = Buffer.from(raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64');
      } catch (e) {
        return res.status(400).json({ error: 'File data is not valid base64.', code: 'DOC_NOT_BASE64' });
      }
      if (!buffer.length) return res.status(400).json({ error: 'That file is empty.', code: 'DOC_EMPTY' });
      if (buffer.length > config.MAX_FILE_SIZE) {
        return res.status(400).json({ error: 'File exceeds 10 MB limit.', code: 'DOC_TOO_LARGE' });
      }
      // Typed by its BYTES, never by what the caller declared.
      const sniffed = detectFileType(buffer);
      if (!sniffed) {
        return res.status(400).json({ error: 'Only PDF, JPG, and PNG files are accepted.', code: 'DOC_TYPE_REJECTED' });
      }

      const safeName = `welcome_packet_${caregiver.id}_${Date.now()}_${String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      let stored;
      try {
        stored = await drive.uploadCaregiverDocumentFile(caregiver.name || 'Caregiver', safeName, buffer, sniffed);
      } catch (e) {
        // A Drive failure FAILS the upload rather than recording a row that
        // points at nothing — the rule every upload in this app follows.
        const d = drive.describeDriveError ? drive.describeDriveError(e) : { reason: e.message, hint: null };
        console.error('[WELCOME PACKET] Drive upload failed:', d.reason, '| hint:', d.hint || 'none');
        return res.status(502).json({
          error: 'We could not store that file. Please try again, or fill the form in here instead.',
          code: 'DOCUMENT_STORAGE_UNAVAILABLE'
        });
      }

      const rows = (await db.get('caregiver_documents')) || [];
      const docRow = {
        id: `cgdoc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        caregiver_id: caregiver.id,
        caregiver_name: caregiver.name || null,
        kind: 'welcome_packet',
        file_name: String(fileName).slice(0, 200),
        stored_name: safeName,
        mime_type: sniffed,
        size_bytes: buffer.length,
        drive_file_id: stored.fileId,
        drive_url: stored.webViewLink || null,
        note: 'Uploaded during onboarding',
        period_start: null, period_end: null, shift_id: null,
        status: 'received',
        uploaded_at: nowIso(),
        uploaded_by_id: req.user.id,
        uploaded_by_name: req.user.name || req.user.email || null,
        uploaded_by_office: false,
        reviewed_at: null, reviewed_by_name: null, review_note: null
      };
      rows.push(docRow);
      await db.set('caregiver_documents', rows);

      // Only now do we try to read it. An extraction failure is not an upload
      // failure: the file is on file either way.
      let extraction;
      try {
        extraction = await packetImport.extractPacket(buffer);
      } catch (e) {
        console.error('[WELCOME PACKET] extraction failed:', e.message);
        extraction = {
          source: packetImport.SOURCE.NONE, values: {}, found: [], needsConfirmation: false,
          reason: 'We saved your packet but could not read it. Please fill the form in here.'
        };
      }

      // An imported value NEVER overwrites something the caregiver has already
      // typed in here. They were sitting in front of this screen; the PDF was
      // filled at some other time, and the newer answer is the one on screen.
      const merged = { ...extraction.values, ...packet.data };
      packet.data = merged;
      packet.status = 'in_progress';
      packet.imported_from = docRow.file_name;
      packet.import_source = extraction.source;
      packet.imported_at = nowIso();
      await savePacket(packet);

      await logActivity(caregiver.id, caregiver.name, 'welcome_packet_imported', 'welcome_packet', packet.id,
        { source: extraction.source, fields: extraction.found.length });

      const documents = await documentsFor(caregiver.id);
      res.json({
        // WHICH READ HAPPENED, named. 'form' was read field by field off the
        // packet we handed out; 'text' was matched off the page and wants
        // checking; 'none' read nothing at all. Telling them apart is the
        // difference between a caregiver who scrolls past their answers and one
        // who proofreads them.
        source: extraction.source,
        filled: extraction.found.filter(id => merged[id] === extraction.values[id]),
        needsConfirmation: extraction.needsConfirmation,
        reason: extraction.reason,
        data: packet.data,
        missing: wp.missingProfileFields(packet.data),
        checklist: wp.buildChecklist(packet.data, documents, packet.office, await attestationsFor(caregiver.id)),
        document: { id: docRow.id, fileName: docRow.file_name }
      });
    } catch (error) {
      console.error('Welcome packet import error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // POST /api/caregiver/welcome-packet/submit — sign it, and open the app.
  // ==========================================================================
  router.post('/api/caregiver/welcome-packet/submit', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      const packet = (await loadPacket(caregiver.id)) || blankPacket(caregiver.id);
      if (packet.status === 'submitted') {
        return res.status(409).json({ error: 'Your packet is already signed.', code: 'PACKET_SIGNED' });
      }

      const { data, signaturePng, printedName } = req.body || {};
      if (data) {
        const { clean } = wp.sanitizePacket(data);
        packet.data = { ...packet.data, ...clean };
      }

      // Completeness first, signature second. Refusing for a missing answer
      // AFTER taking a signature would have somebody sign a document we then
      // said was not finished.
      const missing = wp.missingProfileFields(packet.data);
      if (missing.length) {
        return res.status(400).json({
          error: 'Some answers are still needed before you can sign.',
          code: 'PACKET_INCOMPLETE',
          missing
        });
      }

      const sig = String(signaturePng || '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) {
        return res.status(400).json({ error: 'Please sign in the box before submitting.', code: 'SIGNATURE_REQUIRED' });
      }
      if (sig.length > 400000) {
        return res.status(413).json({ error: 'That signature is too large to store.', code: 'SIGNATURE_TOO_LARGE' });
      }
      const printed = String(printedName || '').trim();
      if (!printed) {
        return res.status(400).json({ error: 'Type your name as it should appear on the packet.', code: 'PRINTED_NAME_REQUIRED' });
      }

      packet.signature_png = sig;
      packet.printed_name = printed.slice(0, 160);
      packet.signed_at = nowIso();
      packet.signer_ip_hash = hashIp ? hashIp(req) : null;
      packet.status = 'submitted';
      packet.version = wp.PACKET_VERSION;
      await savePacket(packet);

      await logActivity(caregiver.id, caregiver.name, 'welcome_packet_submitted', 'welcome_packet', packet.id,
        { version: packet.version, imported: !!packet.imported_from });

      const documents = await documentsFor(caregiver.id);
      const checklist = wp.buildChecklist(packet.data, documents, packet.office,
        await attestationsFor(caregiver.id));

      // The office is told a packet landed. Queued like every other notice, so
      // an unsubscribe is honoured and the mail carries the house template.
      if (queueNotification) {
        queueNotification({
          type: 'caregiver_packet_submitted',
          recipientRole: ROLES.ADMIN,
          subject: `Welcome packet submitted — ${caregiver.name || printed}`,
          body: `${caregiver.name || printed} has completed their caregiver welcome packet. Their document checklist is in the admin hub.`,
          relatedEntityId: packet.id,
          ctaLabel: 'Open the caregiver queue',
          ctaUrl: '/admin-hub'
        }).catch(e => console.error('[WELCOME PACKET] notify failed (non-fatal):', e.message));
      }

      res.json({
        submitted: true,
        signedAt: packet.signed_at,
        checklist,
        onboarding: gate.onboardingSummary(caregiver, packet, checklist)
      });
    } catch (error) {
      console.error('Welcome packet submit error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // THE SIGNABLE FORMS — signed here, at this stage, not printed and posted.
  // ==========================================================================
  // OWNER, 2026-09-14. Four Part Two items were upload slots for forms WE
  // wrote: the caregiver waited on a PDF from us, printed it, signed it,
  // photographed it and sent it back. Four steps and a printer, for a document
  // we already had. They are signed in the app now, the way a client signs a
  // consent in the intake wizard.
  //
  // A signature is stamped with the BODY VERSION it was given, so the signed
  // copy reproduces what was actually on the screen rather than whatever the
  // wording says after a later revision.
  router.post('/api/caregiver/welcome-packet/attestations/:kind',
    authenticateToken, requireCaregiver, async (req, res) => {
      try {
        const caregiver = await freshCaregiver(req);
        if (!caregiver) return res.status(404).json({ error: 'Account not found.' });

        const kind = String(req.params.kind || '');
        if (!attest.isAttestationKind(kind)) {
          return res.status(404).json({ error: 'That is not a form we hold.', code: 'ATTESTATION_UNKNOWN' });
        }

        const existing = (await attestationsFor(caregiver.id)).find(r => r.kind === kind) || null;
        if (attest.isSigned(existing)) {
          // Already signed, at the current wording. A correction is a NEW
          // signature on a changed document, never an edit to this one — the
          // rule the consents and the packet itself follow.
          return res.status(409).json({
            error: 'You have already signed this form.',
            code: 'ATTESTATION_SIGNED',
            signedAt: existing.signed_at
          });
        }

        // ELECTIONS BEFORE SIGNATURE. Refusing for an unanswered question after
        // taking a signature would have somebody sign a form we then say is
        // unfinished — the ordering the packet's own submit route settled.
        const check = attest.validateElections(kind, (req.body || {}).elections);
        if (!check.ok) {
          return res.status(400).json({
            error: check.missing.length
              ? 'Answer every question on the form before you sign it.'
              : 'That answer is not one of the choices on this form.',
            code: check.missing.length ? 'ELECTION_REQUIRED' : 'ELECTION_INVALID',
            missing: check.missing,
            invalid: check.invalid
          });
        }

        const sig = String((req.body || {}).signaturePng || '');
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig)) {
          return res.status(400).json({ error: 'Please sign in the box before submitting.', code: 'SIGNATURE_REQUIRED' });
        }
        if (sig.length > 400000) {
          return res.status(413).json({ error: 'That signature is too large to store.', code: 'SIGNATURE_TOO_LARGE' });
        }
        const printed = String((req.body || {}).printedName || '').trim();
        if (!printed) {
          return res.status(400).json({ error: 'Type your name as it should appear on the form.', code: 'PRINTED_NAME_REQUIRED' });
        }

        const record = {
          id: `catt_${caregiver.id}_${kind}`,
          caregiver_id: caregiver.id,
          kind,
          // The version the body was SERVED at, read here rather than taken
          // from the caller: a page posting a version it was not given would
          // stamp a signature onto text nobody saw.
          version: attest.currentVersion(kind),
          title: attest.titleFor(kind),
          elections: check.elections,
          printed_name: printed.slice(0, 160),
          signature_png: sig,
          signed_at: nowIso(),
          signer_ip_hash: hashIp ? hashIp(req) : null,
          // A superseded signature is REPLACED here but never lost: what they
          // signed before, and when, is carried on the new record.
          supersedes: existing && existing.signed_at
            ? { version: existing.version, signedAt: existing.signed_at, elections: existing.elections || {} }
            : null,
          created_at: (existing && existing.created_at) || nowIso(),
          updated_at: nowIso()
        };
        await saveAttestation(record);

        await logActivity(caregiver.id, caregiver.name, 'caregiver_attestation_signed',
          'caregiver_attestation', record.id, { kind, version: record.version });

        const state = await stateFor(caregiver);
        res.json({
          signed: true,
          kind,
          signedAt: record.signed_at,
          version: record.version,
          checklist: state.checklist,
          onboarding: state.summary
        });
      } catch (error) {
        console.error('Attestation sign error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    });

  // The signed copy. Renders the body AT THE STORED VERSION, so an old
  // signature reproduces the document it was actually given.
  router.get('/api/caregiver/welcome-packet/attestations/:kind.pdf',
    authenticateToken, async (req, res) => {
      try {
        const isAdmin = req.user.role === ROLES.ADMIN;
        if (!isAdmin && !cg.isCaregiver(req.user)) {
          return res.status(403).json({ error: 'Caregiver or administrator access required.', code: 'CAREGIVER_ONLY' });
        }
        const kind = String(req.params.kind || '');
        if (!attest.isAttestationKind(kind)) {
          return res.status(404).json({ error: 'That is not a form we hold.', code: 'ATTESTATION_UNKNOWN' });
        }
        // ADMIN-ONLY filter: a caregiver passing someone else's id still gets
        // their own, the same rule every other caregiver read follows.
        const caregiverId = isAdmin && req.query.caregiverId ? String(req.query.caregiverId) : req.user.id;
        const users = await getUsers();
        const caregiver = users.find(u => u.id === caregiverId) || null;
        if (!caregiver) return res.status(404).json({ error: 'Caregiver not found.' });

        const record = (await attestationsFor(caregiverId)).find(r => r.kind === kind) || null;
        if (!record || !record.signed_at) {
          return res.status(404).json({ error: 'That form is not signed yet.', code: 'ATTESTATION_NOT_SIGNED' });
        }

        const buffer = await packetPdf.generateSignedAttestationPDF(record, caregiver);
        await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_attestation_read',
          'caregiver_attestation', record.id, { caregiverId, kind });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition',
          contentDisposition('attachment', `GFC_${attest.titleFor(kind)}_${caregiver.name || caregiverId}.pdf`));
        res.send(buffer);
      } catch (error) {
        console.error('Attestation PDF error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    });

  // ==========================================================================
  // The PDFs.
  // ==========================================================================
  // The blank one is SEEDED with what we already know, so a caregiver who
  // prefers paper is not asked their own phone number back.
  router.get('/api/caregiver/welcome-packet/blank.pdf', authenticateToken, requireCaregiver, async (req, res) => {
    try {
      const caregiver = await freshCaregiver(req);
      if (!caregiver) return res.status(404).json({ error: 'Account not found.' });
      const packet = (await loadPacket(caregiver.id)) || blankPacket(caregiver.id);
      const seed = { ...packet.data };
      if (!seed.firstName && caregiver.name) seed.firstName = String(caregiver.name).split(' ')[0];
      if (!seed.lastName && caregiver.name) seed.lastName = String(caregiver.name).split(' ').slice(1).join(' ');
      if (!seed.email && caregiver.email) seed.email = caregiver.email;
      if (!seed.mobilePhone && caregiver.phone) seed.mobilePhone = caregiver.phone;

      const buffer = await packetPdf.generateFillableWelcomePacketPDF(seed);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition('attachment', 'GFC_Welcome_Packet.pdf'));
      res.send(buffer);
    } catch (error) {
      console.error('Welcome packet blank PDF error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/caregiver/welcome-packet/signed.pdf', authenticateToken, async (req, res) => {
    try {
      const isAdmin = req.user.role === ROLES.ADMIN;
      if (!isAdmin && !cg.isCaregiver(req.user)) {
        return res.status(403).json({ error: 'Caregiver or administrator access required.', code: 'CAREGIVER_ONLY' });
      }
      // The filter is ADMIN-ONLY: a caregiver passing someone else's id still
      // gets their own, the same rule the document list follows.
      const caregiverId = isAdmin && req.query.caregiverId ? String(req.query.caregiverId) : req.user.id;
      const users = await getUsers();
      const caregiver = users.find(u => u.id === caregiverId) || null;
      if (!caregiver) return res.status(404).json({ error: 'Caregiver not found.' });

      const packet = await loadPacket(caregiverId);
      if (!packet || packet.status !== 'submitted') {
        return res.status(404).json({ error: 'No signed packet is on file.', code: 'PACKET_NOT_SIGNED' });
      }
      const documents = await documentsFor(caregiverId);
      const checklist = wp.buildChecklist(packet.data, documents, packet.office,
        await attestationsFor(caregiverId));
      const buffer = await packetPdf.generateSignedWelcomePacketPDF(packet, caregiver, checklist);

      await logActivity(req.user.id, req.user.name || req.user.email, 'welcome_packet_read', 'welcome_packet', packet.id,
        { caregiverId });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        contentDisposition('attachment', `GFC_Welcome_Packet_${caregiver.name || caregiverId}.pdf`));
      res.send(buffer);
    } catch (error) {
      console.error('Welcome packet signed PDF error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ==========================================================================
  // Admin — the onboarding queue and the office's own checklist items.
  // ==========================================================================
  router.get('/api/caregiver/admin/welcome-packets', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const users = await getUsers();
      const caregivers = users.filter(cg.isCaregiver);
      const out = [];
      for (const caregiver of caregivers) {
        const state = await stateFor(caregiver);
        out.push({
          caregiverId: caregiver.id,
          name: caregiver.name,
          email: caregiver.email,
          licenseLevel: caregiver.licenseLevel || null,
          ...state.summary,
          // Counts, not the answers. A queue is a glance, and a caregiver's
          // date of birth has no business on one.
          outstandingCount: state.summary.outstanding.length,
          waitingOnUs: state.summary.outstanding.filter(o => o.waitingOn === 'us').length
        });
      }
      res.json({ caregivers: out, officeItems: wp.DOCUMENT_ITEMS.filter(d => d.source === 'office') });
    } catch (error) {
      console.error('Welcome packet queue error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The office's own items — fingerprinting, orientation, app training, skills
  // check. A caregiver cannot upload their way past any of them, which is why
  // they are tracked by status and set here.
  router.put('/api/caregiver/admin/welcome-packets/:caregiverId/office-item',
    authenticateToken, requireAdmin, async (req, res) => {
      try {
        const { kind, status, note } = req.body || {};
        if (!wp.OFFICE_ITEM_KINDS.includes(kind)) {
          return res.status(400).json({ error: 'Unknown onboarding item.', code: 'OFFICE_ITEM_UNKNOWN' });
        }
        if (!wp.OFFICE_STATUSES.includes(status)) {
          return res.status(400).json({ error: 'Unknown status.', code: 'OFFICE_STATUS_UNKNOWN' });
        }
        const users = await getUsers();
        const caregiver = users.find(u => u.id === req.params.caregiverId && cg.isCaregiver(u));
        if (!caregiver) return res.status(404).json({ error: 'Caregiver not found.' });

        const packet = (await loadPacket(caregiver.id)) || blankPacket(caregiver.id);
        packet.office = { ...(packet.office || {}) };
        packet.office[kind] = {
          status,
          note: String(note || '').trim().slice(0, 500) || null,
          at: nowIso(),
          byId: req.user.id,
          byName: req.user.name || req.user.email || null
        };
        await savePacket(packet);

        await logActivity(req.user.id, req.user.name || req.user.email, 'caregiver_onboarding_item_set',
          'welcome_packet', packet.id, { caregiverId: caregiver.id, kind, status });

        const documents = await documentsFor(caregiver.id);
        const checklist = wp.buildChecklist(packet.data, documents, packet.office,
          await attestationsFor(caregiver.id));
        res.json({ saved: true, checklist, onboarding: gate.onboardingSummary(caregiver, packet, checklist) });
      } catch (error) {
        console.error('Welcome packet office item error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    });

  return router;
};
