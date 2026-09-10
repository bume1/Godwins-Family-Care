<?php

/**
 * GFC bounded patch 8.4.0-p1 — additional standard-API routes.
 *
 * Entirely GFC-owned. Nothing upstream is edited to add these; the wrapper at
 * _rest_routes_standard.inc.php merges this array with OpenEMR's own.
 *
 * The write paths OpenEMR 8.4 exposes on its own screens but not on the REST
 * API: a fee-sheet charge for an encounter, and a procedure order. Plus a code
 * search over the loaded ICD-10 / CPT tables.
 *
 * Keyed by NUMERIC pid and encounter id, matching soap_note and vital on this
 * instance — the standard API coerces uuids to 0, which is the defect that
 * orphaned every Session 4.1 note at patient zero.
 *
 * Guarded by the SAME ACL the corresponding screens use (encounters/coding_a),
 * so a token that cannot code an encounter in the UI cannot code one through
 * the API either.
 *
 * SCOPES. An earlier version of this header claimed these routes needed none.
 * That was wrong and it cost an install cycle. OpenEMR derives the required
 * OAuth scope FROM THE ROUTE PATH — the resource is the last non-parameter
 * segment — so `POST .../billing` demands `user/billing.c`. The build registers
 * the five scopes the charge and order routes need (gfc-add-scopes.php), and a
 * client carrying them had to be registered fresh, because scopes bind at
 * registration and an existing client cannot be widened.
 *
 * That is precisely why the document routes below are SINGULAR. A plural
 * `/documents` would derive `user/documents.*`, a scope OpenEMR does not have —
 * which would mean a sixth registered scope, a new OAuth client, and another
 * credential swap in the deployed environment. `/document` reuses
 * `user/document.read`, which the app already requests and the deployed v4
 * client already carries.
 *
 * GfcChargeRestController resolves through composer's PSR-4 map (OpenEMR\ =>
 * src/), which this OpenEMR build does not dump as classmap-authoritative, so
 * no require_once is needed.
 *
 * @package   OpenEMR
 * @author    Godwins Family Care (GFC Care Platform)
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

use OpenEMR\Common\Http\HttpRestRequest;
use OpenEMR\RestControllers\Config\RestConfig;
use OpenEMR\RestControllers\GfcChargeRestController;
use OpenEMR\RestControllers\GfcDocumentRestController;
use OpenEMR\RestControllers\RestControllerHelper;

$gfcAddedRoutes = [
    "POST /api/patient/:pid/encounter/:eid/billing" => function ($pid, $eid, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $data = (array) (json_decode(file_get_contents("php://input"), true));
        $result = (new GfcChargeRestController())->postCharge($pid, $eid, $data);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 201);
    },

    "GET /api/patient/:pid/encounter/:eid/billing" => function ($pid, $eid, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $result = (new GfcChargeRestController())->getCharges($pid, $eid);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200, true);
    },

    "DELETE /api/patient/:pid/encounter/:eid/billing/:id" => function ($pid, $eid, $id, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $result = (new GfcChargeRestController())->voidCharge($pid, $eid, $id);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200);
    },

    "POST /api/patient/:pid/encounter/:eid/order" => function ($pid, $eid, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $data = (array) (json_decode(file_get_contents("php://input"), true));
        $result = (new GfcChargeRestController())->postOrder($pid, $eid, $data);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 201);
    },

    "GET /api/patient/:pid/encounter/:eid/order" => function ($pid, $eid, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $result = (new GfcChargeRestController())->getOrders($pid, $eid);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200, true);
    },

    "PUT /api/patient/:pid/encounter/:eid/order/:orderId" => function ($pid, $eid, $orderId, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $data = (array) (json_decode(file_get_contents("php://input"), true));
        $result = (new GfcChargeRestController())->putOrderStatus($pid, $eid, $orderId, $data);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200);
    },

    "GET /api/codes" => function (HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "encounters", "coding_a");
        $result = (new GfcChargeRestController())->searchCodes($request->query->all());
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200, true);
    },

];

/**
 * OVERRIDES — the ONE place an upstream route key is deliberately taken over.
 *
 * The wrapper's default is "upstream wins": a future OpenEMR shipping its own
 * route at one of our keys is canonical and ours is redundant. That default
 * stays. This array is the narrow, listed exception, applied last, and every
 * entry has to justify itself here.
 *
 * DOCUMENT READS. OpenEMR 8.4 takes documents and gives none back on this
 * instance. Probed live 2026-09-09, immediately after a successful upload:
 *
 *   POST /api/patient/1/document       200, body literally `true`
 *   GET  /fhir/DocumentReference       200, total 0 — INSTANCE-WIDE
 *   GET  /api/patient/1/document       404 — no list route exists
 *   GET  /api/patient/1/document/{id}  500 "CSRF key is empty"
 *
 * Without a read, a clinician reviewing a chart cannot see a single filed
 * document — every consent, care plan and returned record is write-only.
 *
 * The list route collides with nothing (upstream's key is POST, ours is GET).
 * The read-by-id DOES collide, and takes over a route that is dead: a 500
 * naming a CSRF key is a session-token check running on a bearer-token API
 * request, which no configuration can fix. Shadowing a working upstream route
 * would be wrong; shadowing this one restores the only thing it was for.
 *
 * WHEN UPSTREAM FIXES IT, DELETE THIS BLOCK. The rebuild does not notice on its
 * own — that is the cost of an override, and the reason there is exactly one.
 *
 * Both are guarded by patients/docs, the ACL the patient-documents screen uses,
 * and both reuse `user/document.read` (see the scope note at the top).
 */
$gfcOverrideRoutes = [
    "GET /api/patient/:pid/document" => function ($pid, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "patients", "docs");
        $result = (new GfcDocumentRestController())->listForPatient($pid);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200, true);
    },

    "GET /api/patient/:pid/document/:id" => function ($pid, $id, HttpRestRequest $request) {
        RestConfig::request_authorization_check($request, "patients", "docs");
        $result = (new GfcDocumentRestController())->getForPatient($pid, $id);
        return RestControllerHelper::createProcessingResultResponse($request, $result, 200, true);
    },
];

// Two maps, because they are merged at different points: additions lose a key
// collision to upstream, overrides win one. The wrapper requires exactly this
// shape and fails loudly on anything else.
return ['routes' => $gfcAddedRoutes, 'overrides' => $gfcOverrideRoutes];
