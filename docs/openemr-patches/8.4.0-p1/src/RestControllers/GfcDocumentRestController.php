<?php

/**
 * GfcDocumentRestController — Godwins Family Care bounded patch for OpenEMR 8.4.0
 *
 * Adds the document READ paths OpenEMR 8.4 exposes on its own screens but not on
 * the REST API. Probed live on this instance 2026-09-09, immediately after a
 * successful upload:
 *
 *   POST /api/patient/{pid}/document      200, response body literally `true`
 *   GET  /fhir/DocumentReference          200, total 0 — INSTANCE-WIDE
 *   GET  /api/patient/{pid}/document      404, no list route exists
 *   GET  /api/patient/{pid}/document/{id} 500 "CSRF key is empty"
 *
 * The 404 and the 500 are different failures. "Route not found" means no route;
 * a 500 naming a CSRF key means the route resolved and the controller called a
 * session-token check that has no business running on a bearer-token API
 * request. Neither is fixable by configuration, so the read is added here.
 *
 * Wraps what OpenEMR's own patient-documents screen uses — the `documents`
 * table joined through `categories_to_documents`, and the \Document model for
 * the bytes. No storage logic is written from scratch.
 *
 * Guarded by the SAME ACL the documents screen uses (patients/docs), so a token
 * that cannot view a patient's documents in the UI cannot read them here.
 *
 * NO NEW OAUTH SCOPE — by route naming, not by luck. OpenEMR derives the
 * required scope from the last non-parameter path segment, so the routes that
 * reach this controller are SINGULAR (`/api/patient/{pid}/document`). A plural
 * path would demand `user/documents.read`, which the server does not define:
 * a sixth registered scope, a new OAuth client, and another credential swap in
 * the deployed environment. The singular path reuses `user/document.read`,
 * which the app already requests and the deployed v4 client already carries.
 *
 * The list route is an addition (upstream has no GET there). The read-by-id
 * deliberately OVERRIDES upstream's, which is dead on this instance — see the
 * override block in _rest_routes_gfc.inc.php.
 *
 * @package   OpenEMR
 * @author    Godwins Family Care (GFC Care Platform)
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\RestControllers;

use OpenEMR\Validators\ProcessingResult;

class GfcDocumentRestController
{
    /** Refuse anything larger than this rather than exhausting memory on a
     *  base64 encode. The app's own uploads are capped at 10 MB. */
    private const MAX_INLINE_BYTES = 20971520; // 20 MB

    /**
     * GET /api/patient/:pid/document
     *
     * Every non-deleted document on the patient, newest first, with the category
     * name OpenEMR's own tree shows. Keyed by NUMERIC pid, matching soap_note,
     * vital and the upload route on this instance — the standard API coerces a
     * uuid to 0, which is the defect that orphaned Session 4.1's notes at
     * patient zero.
     */
    public function listForPatient($pid): ProcessingResult
    {
        $result = new ProcessingResult();
        $pid = (int)$pid;
        if ($pid <= 0) {
            $result->setValidationMessages(['pid' => ['A numeric pid is required']]);
            return $result;
        }

        // LEFT JOIN on the category: a document filed with no category is still
        // the patient's document and must not vanish from their chart.
        $sql = "SELECT d.id, d.name, d.date, d.docdate, d.mimetype, d.size, d.url,
                       d.encounter_id, c.name AS category
                  FROM documents d
             LEFT JOIN categories_to_documents ctd ON ctd.document_id = d.id
             LEFT JOIN categories c ON c.id = ctd.category_id
                 WHERE d.foreign_id = ?
                   AND (d.deleted IS NULL OR d.deleted = 0)
              ORDER BY COALESCE(d.docdate, d.date) DESC, d.id DESC";

        $rows = [];
        $statement = sqlStatement($sql, [$pid]);
        while ($row = sqlFetchArray($statement)) {
            $rows[] = [
                'id' => (int)$row['id'],
                // `name` is the stored filename; it is what the UI shows.
                'name' => $row['name'],
                'category' => $row['category'] ?: null,
                // docdate is the clinical date of the document; date is when it
                // was filed. Both are returned because they answer different
                // questions and conflating them loses one.
                'docdate' => $row['docdate'] ?: null,
                'filed_at' => $row['date'] ?: null,
                'mimetype' => $row['mimetype'] ?: null,
                'size' => $row['size'] !== null ? (int)$row['size'] : null,
                'encounter_id' => $row['encounter_id'] !== null ? (int)$row['encounter_id'] : null,
            ];
        }
        $result->setData($rows);
        return $result;
    }

    /**
     * GET /api/patient/:pid/document/:id
     *
     * One document's bytes, base64 in the JSON envelope. Deliberately NOT a raw
     * binary stream: every other route on this API returns the standard
     * ProcessingResult envelope, and a route that breaks that pattern has to
     * hand-manage headers and bypass the response helper — more surface, for a
     * transport the caller decodes in one line either way.
     *
     * The pid is part of the lookup, not decoration. Without it,
     * /patient/1/document/999 would happily return another patient's document.
     */
    public function getForPatient($pid, $id): ProcessingResult
    {
        $result = new ProcessingResult();
        $pid = (int)$pid;
        $id = (int)$id;
        if ($pid <= 0 || $id <= 0) {
            $result->setValidationMessages(['id' => ['A numeric pid and document id are required']]);
            return $result;
        }

        $row = sqlQuery(
            "SELECT id, name, mimetype, size, url, encrypted
               FROM documents
              WHERE id = ? AND foreign_id = ? AND (deleted IS NULL OR deleted = 0)",
            [$id, $pid]
        );
        if (empty($row)) {
            // Not found and not-yours are answered identically on purpose: a
            // distinguishable "exists but not yours" leaks that it exists.
            $result->setValidationMessages(['id' => ['No such document for this patient']]);
            return $result;
        }

        $size = (int)($row['size'] ?? 0);
        if ($size > self::MAX_INLINE_BYTES) {
            $result->setValidationMessages(['id' => [
                'That document is too large to return inline (' . $size . ' bytes). Open it in OpenEMR.'
            ]]);
            return $result;
        }

        $bytes = $this->readBytes((int)$row['id']);
        if ($bytes === null) {
            // Reported, never returned as an empty document. A zero-byte PDF in
            // a chart is worse than an error: it looks like the record is blank.
            $result->setValidationMessages(['id' => [
                'The stored file for that document could not be read on the server.'
            ]]);
            return $result;
        }

        $result->setData([[
            'id' => (int)$row['id'],
            'name' => $row['name'],
            'mimetype' => $row['mimetype'] ?: 'application/octet-stream',
            'size' => strlen($bytes),
            'encoding' => 'base64',
            'data' => base64_encode($bytes),
        ]]);
        return $result;
    }

    /**
     * Read a document's bytes through OpenEMR's own model.
     *
     * \Document is the class the patient-documents screen uses, and it is what
     * knows about the storage backends (filesystem, and CouchDB where that is
     * configured). Which accessors exist has moved between releases, so each is
     * tried in turn and the last resort is the resolved filesystem path.
     *
     * Returns null rather than '' when nothing can be read, so the caller can
     * tell "unreadable" from "an empty file" — they are different facts.
     */
    private function readBytes(int $id): ?string
    {
        try {
            $doc = new \Document($id);
        } catch (\Throwable $e) {
            return null;
        }

        // Preferred: the model hands back the bytes, backend and all.
        foreach (['get_data', 'get_document_data'] as $method) {
            if (method_exists($doc, $method)) {
                try {
                    $data = $doc->{$method}();
                    if (is_string($data) && $data !== '') {
                        return $data;
                    }
                } catch (\Throwable $e) {
                    // fall through to the next strategy
                }
            }
        }

        // Fallback: resolve the path the model reports and read it directly.
        foreach (['get_url_filepath', 'get_url_filename', 'get_url'] as $method) {
            if (!method_exists($doc, $method)) {
                continue;
            }
            try {
                $path = (string)$doc->{$method}();
            } catch (\Throwable $e) {
                continue;
            }
            if ($path === '') {
                continue;
            }
            // Stored urls carry a file:// prefix on this instance.
            $path = preg_replace('#^file://#', '', $path);
            if (!str_starts_with($path, '/')) {
                $path = rtrim((string)($GLOBALS['OE_SITE_DIR'] ?? ''), '/') . '/documents/' . ltrim($path, '/');
            }
            if (is_readable($path) && !is_dir($path)) {
                $data = file_get_contents($path);
                if (is_string($data) && $data !== '') {
                    return $data;
                }
            }
        }

        return null;
    }
}
