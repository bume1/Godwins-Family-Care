// ============================================================================
// imeService.js — the IME record analyzer's storage and its background job.
//
// Every rule lives in imeCases.js. This module does the I/O those rules need,
// with every dependency PASSED IN (the store, Drive, the model engine, the
// activity log, the clock), so the whole flow from upload to a cited result
// can be driven in a test with fakes and no Google account.
//
// Collections (all PHI, all registered in dataMigration.js):
//   ime_cases            one row per exam case
//   ime_case_documents   one row per uploaded file: name, size, SHA-256,
//                        page count, uploader, Drive pointer. Never the bytes.
//   ime_analyses         one row per run: progress, the cited result, counts
//   ime_analysis_audit   append-only, and CONTENT-FREE (spec §6)
//   ime_deletion_log     append-only: what the retention sweep removed, when
// ============================================================================
'use strict';

const crypto = require('crypto');
const rules = require('./imeCases');

const ANALYSIS_STATUS = Object.freeze({ RUNNING: 'running', DONE: 'done', FAILED: 'failed' });
const MAX_FILES_PER_UPLOAD = 50;

const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const createImeService = ({
  db, drive, engine, modelEngine, logActivity, getUsers, resolveClinicalRole,
  detectFileType, pdf, env, now, maxFileBytes
}) => {
  const E = env || process.env;
  const at = () => (now ? now() : new Date().toISOString());
  const nowMs = () => Date.parse(at());
  const load = async (k) => (await db.get(k)) || [];
  const save = (k, rows) => db.set(k, rows);
  const log = async (actor, action, entityId, details) => {
    if (typeof logActivity !== 'function') return;
    await logActivity(actor ? actor.id : 'system', actor ? (actor.name || actor.email) : 'IME retention sweep', action, 'ime_case', entityId, details || {});
  };
  const actorOf = (u) => (u ? { id: u.id, name: u.name || u.email || null } : null);

  // ── cases ────────────────────────────────────────────────────────────────
  const getCase = async (id) => (await load('ime_cases')).find(c => c && c.id === id) || null;
  const docsFor = async (caseId) => (await load('ime_case_documents')).filter(d => d && d.caseId === caseId);
  const analysesFor = async (caseId) => (await load('ime_analyses')).filter(a => a && a.caseId === caseId);

  const examiners = async () => (await getUsers()).filter(u => rules.isExaminer(u, resolveClinicalRole));
  const examinerName = async (id) => {
    const u = (await getUsers()).find(x => x && String(x.id) === String(id));
    return u ? (u.name || u.email) : null;
  };

  const view = async (c) => rules.publicCase(c, {
    documents: await docsFor(c.id), analyses: await analysesFor(c.id),
    examinerName: await examinerName(c.examinerId), env: E
  });

  const listCases = async (user) => {
    const rows = (await load('ime_cases')).filter(c => rules.canSeeCase(user, c, resolveClinicalRole));
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return Promise.all(rows.map(view));
  };

  // An examiner may open a case only for themselves; an admin assigns anyone
  // who could hold the capability. The same rule the veteran roster follows.
  const resolveExaminer = async (user, requested) => {
    if (!rules.isAdmin(user)) return { examinerId: user.id };
    const id = String(requested || '');
    if (!id) return { error: 'Choose the examiner this case is assigned to.', code: 'IME_EXAMINER_REQUIRED' };
    if (!(await examiners()).some(u => String(u.id) === id)) {
      return { error: 'That person cannot be assigned an IME case. An examiner must be an active licensed provider.', code: 'IME_EXAMINER_NOT_ELIGIBLE' };
    }
    return { examinerId: id };
  };

  const createCase = async (user, body) => {
    const v = rules.normalizeCaseInput(body);
    if (v.error) return { status: 400, error: v.error, code: 'IME_CASE_INVALID', fieldErrors: v.fieldErrors };
    const ex = await resolveExaminer(user, body && body.examinerId);
    if (ex.error) return { status: 400, error: ex.error, code: ex.code };
    const rows = await load('ime_cases');
    // Two open cases for one reference id is how a claim file ends up split
    // across two analyses that each miss half of it.
    if (rows.some(c => c.status !== rules.STATUSES.PURGED && c.referenceId.toLowerCase() === v.value.referenceId.toLowerCase() && c.contractingEntity === v.value.contractingEntity)) {
      return { status: 409, error: 'A case with that reference ID is already open for this contracting entity.', code: 'IME_CASE_DUPLICATE' };
    }
    const row = {
      id: newId('ime'), ...v.value, examinerId: ex.examinerId,
      status: rules.STATUSES.OPEN, createdAt: at(), createdBy: actorOf(user),
      reportSubmittedAt: null, purgedAt: null
    };
    await save('ime_cases', [...rows, row]);
    await log(user, 'ime_case_created', row.id, { contractingEntity: row.contractingEntity, examinerId: row.examinerId, conditionCount: row.claimedConditions.length });
    return { status: 201, case: await view(row) };
  };

  const updateCase = async (user, c, body) => {
    if (c.status === rules.STATUSES.PURGED) return { status: 409, error: 'This case has been purged.', code: 'IME_CASE_PURGED' };
    const b = { ...(body || {}) };
    delete b.caseType;
    const v = rules.normalizeCaseInput(b, { partial: true });
    if (v.error) return { status: 400, error: v.error, code: 'IME_CASE_INVALID', fieldErrors: v.fieldErrors };
    const patch = { ...v.value };
    if (Object.prototype.hasOwnProperty.call(b, 'examinerId')) {
      if (!rules.isAdmin(user)) return { status: 403, error: 'Only an admin reassigns a case.', code: 'IME_ADMIN_ONLY' };
      const ex = await resolveExaminer(user, b.examinerId);
      if (ex.error) return { status: 400, error: ex.error, code: ex.code };
      patch.examinerId = ex.examinerId;
    }
    const rows = await load('ime_cases');
    const i = rows.findIndex(r => r.id === c.id);
    rows[i] = { ...rows[i], ...patch, updatedAt: at() };
    await save('ime_cases', rows);
    // Which fields changed, never what they changed to.
    await log(user, 'ime_case_updated', c.id, { fields: Object.keys(patch) });
    return { status: 200, case: await view(rows[i]) };
  };

  // The report going in starts the deletion clock (spec §1, §6).
  const submitReport = async (user, c) => {
    if (c.status !== rules.STATUSES.OPEN) return { status: 409, error: 'The report has already been recorded as submitted.', code: 'IME_REPORT_ALREADY_SUBMITTED' };
    const running = (await analysesFor(c.id)).some(a => a.status === ANALYSIS_STATUS.RUNNING);
    if (running) return { status: 409, error: 'An analysis is still running on this case. Wait for it to finish first.', code: 'IME_ANALYSIS_RUNNING' };
    const rows = await load('ime_cases');
    const i = rows.findIndex(r => r.id === c.id);
    rows[i] = { ...rows[i], status: rules.STATUSES.REPORT_SUBMITTED, reportSubmittedAt: at(), reportSubmittedBy: actorOf(user) };
    await save('ime_cases', rows);
    await log(user, 'ime_report_submitted', c.id, { retentionDays: rules.retentionDays(E) });
    return { status: 200, case: await view(rows[i]) };
  };

  // A mis-click on "report submitted" would start a deletion clock for a file
  // still being worked. Admin only, and only before the sweep has run.
  const reopenCase = async (user, c, body) => {
    if (!rules.isAdmin(user)) return { status: 403, error: 'Only an admin reopens a case.', code: 'IME_ADMIN_ONLY' };
    if (c.status !== rules.STATUSES.REPORT_SUBMITTED) return { status: 409, error: 'Only a case marked report submitted can be reopened.', code: 'IME_NOT_SUBMITTED' };
    const reason = String((body && body.reason) || '').trim().slice(0, 300);
    if (!reason) return { status: 400, error: 'Say why the case is being reopened.', code: 'IME_REASON_REQUIRED' };
    const rows = await load('ime_cases');
    const i = rows.findIndex(r => r.id === c.id);
    rows[i] = { ...rows[i], status: rules.STATUSES.OPEN, reportSubmittedAt: null, reportSubmittedBy: null };
    await save('ime_cases', rows);
    await log(user, 'ime_case_reopened', c.id, { reason });
    return { status: 200, case: await view(rows[i]) };
  };

  // ── documents ────────────────────────────────────────────────────────────
  const pageCountOf = async (buffer, mime) => {
    if (mime !== 'application/pdf') return 1;
    const doc = await pdf.load(buffer);
    return doc.getPageCount();
  };

  // files: [{ originalname, buffer }]. Each file gets its own outcome: one bad
  // file in fifty does not refuse the other forty-nine.
  const addDocuments = async (user, c, files) => {
    if (c.status !== rules.STATUSES.OPEN) return { status: 409, error: 'Documents can only be added while the case is open.', code: 'IME_CASE_NOT_OPEN' };
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return { status: 400, error: 'Choose at least one file.', code: 'IME_NO_FILES' };
    if (list.length > MAX_FILES_PER_UPLOAD) return { status: 400, error: `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`, code: 'IME_TOO_MANY_FILES' };
    const existing = (await docsFor(c.id)).filter(d => !d.removedAt && !d.purgedAt);
    const hashes = new Set(existing.map(d => d.sha256));
    const results = [];
    const added = [];
    for (const f of list) {
      const name = String((f && f.originalname) || 'document').replace(/[\r\n]/g, ' ').slice(0, 200);
      const buf = f && f.buffer;
      const refuse = (why, code) => results.push({ fileName: name, ok: false, error: why, code });
      if (!Buffer.isBuffer(buf) || !buf.length) { refuse('The file is empty.', 'IME_FILE_EMPTY'); continue; }
      if (maxFileBytes && buf.length > maxFileBytes) { refuse(`The file is over the ${Math.round(maxFileBytes / 1048576)} MB limit.`, 'IME_FILE_TOO_LARGE'); continue; }
      // Typed by its BYTES, never by its name or the browser's claim.
      const mime = detectFileType(buf);
      if (!mime) { refuse('Only PDF, JPG and PNG files are accepted.', 'IME_FILE_TYPE'); continue; }
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (hashes.has(sha256)) { refuse('This exact file is already on the case.', 'IME_FILE_DUPLICATE'); continue; }
      let pageCount;
      try { pageCount = await pageCountOf(buf, mime); } catch (e) { refuse('The file could not be opened as a PDF.', 'IME_FILE_UNREADABLE'); continue; }
      let stored;
      try {
        // The stored name carries the case id and a random suffix, never the
        // original filename, which can carry a veteran's name.
        stored = await drive.uploadImeCaseFile(c.id, `${c.id}_${crypto.randomBytes(6).toString('hex')}${mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg'}`, buf, mime);
      } catch (e) {
        // NO ROW WITHOUT A FILE. A row pointing at nothing would be read as
        // part of the claim file and then reported unreadable.
        refuse('The file could not be stored. Nothing was saved for it.', 'IME_STORAGE_UNAVAILABLE');
        continue;
      }
      const row = {
        id: newId('imedoc'), caseId: c.id, fileName: name, mimeType: mime, size: buf.length,
        sha256, pageCount, driveFileId: stored.fileId, uploadedBy: actorOf(user), uploadedAt: at(),
        hasTextLayer: null, removedAt: null, purgedAt: null
      };
      hashes.add(sha256);
      added.push(row);
      results.push({ fileName: name, ok: true, documentId: row.id, pageCount });
    }
    if (added.length) await save('ime_case_documents', [...(await load('ime_case_documents')), ...added]);
    await log(user, 'ime_documents_uploaded', c.id, {
      added: added.length, refused: results.length - added.length,
      pages: added.reduce((n, d) => n + d.pageCount, 0)
    });
    return { status: added.length ? 201 : 400, results, documents: (await docsFor(c.id)).map(rules.publicDocument) };
  };

  // Opened only through the app, and every read is audited (spec §2).
  const readDocument = async (user, c, docId) => {
    const d = (await docsFor(c.id)).find(x => x.id === docId);
    if (!d || d.removedAt || d.purgedAt || !d.driveFileId) return { status: 404, error: 'Document not found.', code: 'IME_DOCUMENT_NOT_FOUND' };
    let bytes;
    try { bytes = await drive.downloadFileBuffer(d.driveFileId); } catch (e) {
      return { status: 502, error: 'The stored file could not be retrieved.', code: 'IME_STORAGE_UNAVAILABLE' };
    }
    await log(user, 'ime_document_read', c.id, { documentId: d.id });
    return { status: 200, bytes, mimeType: d.mimeType, fileName: d.fileName };
  };

  const removeDocument = async (user, c, docId) => {
    if (c.status !== rules.STATUSES.OPEN) return { status: 409, error: 'Documents can only be removed while the case is open.', code: 'IME_CASE_NOT_OPEN' };
    const rows = await load('ime_case_documents');
    const i = rows.findIndex(x => x.caseId === c.id && x.id === docId && !x.removedAt);
    if (i < 0) return { status: 404, error: 'Document not found.', code: 'IME_DOCUMENT_NOT_FOUND' };
    try { await drive.deleteFile(rows[i].driveFileId); } catch (e) {
      if (!(e && (e.code === 404 || e.status === 404))) {
        return { status: 502, error: 'The stored file could not be deleted, so the document was left in place.', code: 'IME_STORAGE_UNAVAILABLE' };
      }
    }
    // The row stays, with its hash and page count, so an earlier analysis can
    // still say which file it read. The name and the pointer go.
    rows[i] = { ...rows[i], removedAt: at(), removedBy: actorOf(user), driveFileId: null, fileName: null };
    await save('ime_case_documents', rows);
    await log(user, 'ime_document_removed', c.id, { documentId: docId });
    return { status: 200, documents: (await docsFor(c.id)).map(rules.publicDocument) };
  };

  // ── analysis ─────────────────────────────────────────────────────────────
  const saveAnalysis = async (id, patch) => {
    const rows = await load('ime_analyses');
    const i = rows.findIndex(r => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch };
    await save('ime_analyses', rows);
    return rows[i];
  };
  const appendAudit = async (row) => save('ime_analysis_audit', [...(await load('ime_analysis_audit')), row]);

  // Per-page text for quote checking. Best effort: a PDF whose text cannot be
  // extracted is treated as having no text layer, so its quotes read as
  // unverified rather than wrong.
  const pageTextsOf = async (bytes, mime) => {
    if (mime !== 'application/pdf' || !pdf.pageTexts) return null;
    try { return await pdf.pageTexts(bytes); } catch (e) { return null; }
  };

  const partBytes = async (bytes, part, doc) => {
    if (part.from === 1 && part.to === doc.pageCount) return bytes;
    return pdf.slice(bytes, part.from, part.to);
  };

  const runAnalysis = async ({ analysisId, user, caseRow }) => {
    const actor = actorOf(user);
    const cleared7332 = rules.usc7332Cleared(E);
    const docs = (await docsFor(caseRow.id)).filter(d => !d.removedAt && !d.purgedAt);
    const plan = rules.planPasses(docs, rules.pagesPerPass(E));
    const docById = new Map(docs.map(d => [d.id, d]));
    const texts = new Map(); // documentId → [page text]
    const pageText = (documentId, page) => {
      const t = texts.get(documentId);
      return t ? (t[page - 1] || '') : null;
    };
    const cleaned = [];
    const unreadable = [];
    const dropped = { uncited: 0, opinion: 0, restricted7332: 0 };
    const quoteCounts = { matched: 0, not_on_page: 0, no_text_layer: 0, no_quote: 0 };
    const invocationIds = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const failedFetch = new Set();
    let model = null;
    let passesRun = 0;

    try {
      await saveAnalysis(analysisId, { passes: plan.length });
      for (const p of plan) {
        await saveAnalysis(analysisId, { currentPass: p.pass });
        // Bytes for this pass only, then released.
        const bytesById = new Map();
        const documents = [];
        const parts = [];
        for (const part of p.parts) {
          const d = docById.get(part.documentId);
          if (failedFetch.has(d.id)) continue;
          if (!bytesById.has(d.id)) {
            try { bytesById.set(d.id, await drive.downloadFileBuffer(d.driveFileId)); } catch (e) {
              failedFetch.add(d.id);
              unreadable.push({ documentId: d.id, sourceId: `doc:${d.id}`, pages: 'all', why: 'the stored file could not be retrieved' });
              continue;
            }
            if (!texts.has(d.id)) texts.set(d.id, await pageTextsOf(bytesById.get(d.id), d.mimeType));
          }
          let bytes;
          try { bytes = await partBytes(bytesById.get(d.id), part, d); } catch (e) {
            unreadable.push({ documentId: d.id, sourceId: part.sourceId, pages: `${part.from}-${part.to}`, why: 'those pages could not be separated from the file' });
            continue;
          }
          parts.push(part);
          documents.push({ sourceId: part.sourceId, mimeType: d.mimeType, bytes, title: `uploaded file, pages ${part.from}-${part.to} of ${d.pageCount}` });
        }
        if (!documents.length) continue;
        let r;
        try {
          r = await engine.invoke({
            purpose: modelEngine.PURPOSES.IME_RECORD_REVIEW,
            input: {
              documents,
              instruction: rules.buildInstruction({ claimedConditions: caseRow.claimedConditions, pass: p.pass, of: plan.length, cleared7332 }),
              maxOutputTokens: 65535
            },
            schema: rules.PASS_SCHEMA,
            actor: user, patientId: caseRow.id,
            feature: 'ime_record_review', pass: p.pass,
            sourceIds: parts.map(x => x.sourceId)
          });
        } catch (e) {
          // A boundary refusal stops everything: nothing else will be allowed
          // either. Any other failure costs this pass's pages, which are
          // LISTED as not read, and the next pass still runs.
          if (e && e.code === 'MODEL_BOUNDARY_REFUSED') throw e;
          for (const part of parts) {
            unreadable.push({ documentId: part.documentId, sourceId: part.sourceId, pages: `${part.from}-${part.to}`,
              why: `pass ${p.pass} failed: ${modelEngine.scrubForLog(String((e && e.message) || e)).slice(0, 200)}` });
          }
          continue;
        }
        passesRun++;
        model = r.modelId || model;
        invocationIds.push(r.invocationId);
        if (r.usage) {
          usage.inputTokens += r.usage.inputTokens || 0;
          usage.outputTokens += r.usage.outputTokens || 0;
        }
        const c = rules.cleanPass(r.proposal, { parts, pageText, cleared7332 });
        cleaned.push(c.pass);
        for (const k of Object.keys(dropped)) dropped[k] += c.dropped[k];
        for (const k of Object.keys(quoteCounts)) quoteCounts[k] += c.quoteCounts[k];
      }

      if (!passesRun) {
        const err = new Error('No part of the claim file could be read.');
        err.code = 'IME_NOTHING_READ';
        throw err;
      }
      const merged = rules.mergePasses(cleaned, caseRow.claimedConditions);
      merged.unreadable = [...unreadable, ...merged.unreadable];
      const counts = rules.countItems(merged);

      // Which documents had a text layer, so the screen can say why a quote
      // is unverified.
      const docRows = await load('ime_case_documents');
      for (const d of docRows) {
        if (d.caseId === caseRow.id && texts.has(d.id)) {
          const t = texts.get(d.id);
          d.hasTextLayer = !!(t && t.some(x => rules.normText(x)));
        }
      }
      await save('ime_case_documents', docRows);

      const finishedAt = at();
      await saveAnalysis(analysisId, {
        status: ANALYSIS_STATUS.DONE, finishedAt, currentPass: null, passesRun,
        model, invocationIds, output: merged, counts, dropped, quoteChecks: quoteCounts,
        usage, estimatedCost: rules.estimateCost(usage, E), cleared7332
      });
      await appendAudit(rules.auditRow({
        caseId: caseRow.id, analysisId, actor, at: finishedAt, model, invocationIds,
        documents: docs, counts, dropped, quoteCounts, passes: plan.length, result: 'ok', usage
      }));
    } catch (e) {
      const finishedAt = at();
      await saveAnalysis(analysisId, {
        status: ANALYSIS_STATUS.FAILED, finishedAt, currentPass: null,
        error: modelEngine.scrubForLog(String((e && e.message) || e)).slice(0, 400),
        code: (e && e.code) || null, blockers: (e && e.blockers) || null,
        invocationIds, usage
      });
      await appendAudit(rules.auditRow({
        caseId: caseRow.id, analysisId, actor, at: finishedAt, model, invocationIds,
        documents: docs, counts: null, dropped, quoteCounts, passes: plan.length,
        result: 'failed', usage
      }));
    }
  };

  const startAnalysis = async (user, c, { background = true } = {}) => {
    if (c.status !== rules.STATUSES.OPEN) return { status: 409, error: 'An analysis can only be run while the case is open.', code: 'IME_CASE_NOT_OPEN' };
    if (!(c.claimedConditions || []).length) return { status: 409, error: 'Add the claimed conditions first. The summary is organised by them.', code: 'IME_NO_CONDITIONS' };
    const docs = (await docsFor(c.id)).filter(d => !d.removedAt && !d.purgedAt);
    if (!docs.length) return { status: 409, error: 'Upload the claim file first.', code: 'IME_NO_DOCUMENTS' };
    // Refused BEFORE anything is downloaded, so a claim file is not pulled
    // into memory for a call that was never going to be allowed.
    const st = engine.status();
    if (!st.configured) return { status: 503, error: 'AI analysis is not switched on yet.', code: 'MODEL_BOUNDARY_REFUSED', blockers: rules.isAdmin(user) ? st.blockers : undefined };
    if ((await analysesFor(c.id)).some(a => a.status === ANALYSIS_STATUS.RUNNING)) {
      return { status: 409, error: 'An analysis is already running on this case.', code: 'IME_ANALYSIS_RUNNING' };
    }
    const row = {
      id: newId('imea'), caseId: c.id, status: ANALYSIS_STATUS.RUNNING,
      requestedBy: actorOf(user), at: at(), passes: null, currentPass: null,
      documentIds: docs.map(d => d.id), pageCount: docs.reduce((n, d) => n + d.pageCount, 0),
      output: null
    };
    await save('ime_analyses', [...(await load('ime_analyses')), row]);
    await log(user, 'ime_analysis_started', c.id, { analysisId: row.id, documents: docs.length, pages: row.pageCount });
    const job = runAnalysis({ analysisId: row.id, user, caseRow: c });
    if (!background) await job;
    return { status: 202, analysis: { id: row.id, status: row.status } };
  };

  const getAnalysis = async (c, analysisId) => (await analysesFor(c.id)).find(a => a.id === analysisId) || null;

  // ── retention ────────────────────────────────────────────────────────────
  // Spec §6. N days after the report: the Drive files go, the AI output goes,
  // and the case keeps only its metadata. A file that could not be deleted
  // leaves the case un-purged so the next sweep tries again — marking it
  // purged with a file still in Drive would be a deletion record that lies.
  const purgeDue = async () => {
    const cases = await load('ime_cases');
    const due = cases.filter(c => rules.isPurgeDue(c, nowMs(), E));
    let purged = 0;
    for (const c of due) {
      const docRows = await load('ime_case_documents');
      let failed = 0;
      let filesDeleted = 0;
      for (const d of docRows) {
        if (d.caseId !== c.id || d.purgedAt) continue;
        if (d.driveFileId) {
          try { await drive.deleteFile(d.driveFileId); filesDeleted++; } catch (e) {
            if (!(e && (e.code === 404 || e.status === 404))) { failed++; continue; }
          }
        }
        d.purgedAt = at(); d.driveFileId = null; d.fileName = null;
      }
      await save('ime_case_documents', docRows);
      if (failed) {
        console.warn(`[IME] retention sweep could not delete ${failed} file(s) on a case; it will retry.`);
        continue;
      }
      const aRows = await load('ime_analyses');
      let analysesCleared = 0;
      for (const a of aRows) {
        if (a.caseId !== c.id || a.purgedAt) continue;
        a.output = null; a.error = null; a.purgedAt = at(); analysesCleared++;
      }
      await save('ime_analyses', aRows);
      const fresh = await load('ime_cases');
      const i = fresh.findIndex(r => r.id === c.id);
      fresh[i] = {
        ...fresh[i], status: rules.STATUSES.PURGED, purgedAt: at(),
        // The claimed conditions are health information about the veteran,
        // so they go with the file. Their count stays.
        conditionCount: (fresh[i].claimedConditions || []).length, claimedConditions: []
      };
      await save('ime_cases', fresh);
      await save('ime_deletion_log', [...(await load('ime_deletion_log')), {
        id: newId('imedel'), caseId: c.id, referenceId: c.referenceId, contractingEntity: c.contractingEntity,
        reportSubmittedAt: c.reportSubmittedAt, purgedAt: at(), retentionDays: rules.retentionDays(E),
        filesDeleted, analysesCleared
      }]);
      await log(null, 'ime_case_purged', c.id, { filesDeleted, analysesCleared });
      purged++;
    }
    return purged;
  };

  const deletionLog = async () => (await load('ime_deletion_log')).slice().sort((a, b) => String(b.purgedAt).localeCompare(String(a.purgedAt)));

  // Spend per case (spec §7), for the admin screen.
  const spend = async () => {
    const rows = await load('ime_analyses');
    const byCase = new Map();
    for (const a of rows) {
      const s = byCase.get(a.caseId) || { caseId: a.caseId, runs: 0, inputTokens: 0, outputTokens: 0, estimatedCost: null };
      s.runs++;
      s.inputTokens += (a.usage && a.usage.inputTokens) || 0;
      s.outputTokens += (a.usage && a.usage.outputTokens) || 0;
      byCase.set(a.caseId, s);
    }
    for (const s of byCase.values()) s.estimatedCost = rules.estimateCost(s, E);
    return [...byCase.values()];
  };

  return {
    ANALYSIS_STATUS, MAX_FILES_PER_UPLOAD,
    getCase, docsFor, analysesFor, examiners, view,
    listCases, createCase, updateCase, submitReport, reopenCase,
    addDocuments, readDocument, removeDocument,
    startAnalysis, runAnalysis, getAnalysis,
    purgeDue, deletionLog, spend
  };
};

module.exports = { createImeService, ANALYSIS_STATUS, MAX_FILES_PER_UPLOAD };
