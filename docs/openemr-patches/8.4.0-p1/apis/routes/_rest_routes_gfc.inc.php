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
 * the API either. NO NEW OAUTH SCOPE: standard /api/ routes on 8.4 are gated by
 * RestConfig::request_authorization_check(), not by a per-route scope, and the
 * server's API scope list is a hardcoded array. Introducing a scope name would
 * force a re-registration of the OAuth client, so these routes introduce none.
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
use OpenEMR\RestControllers\RestControllerHelper;

return [
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
