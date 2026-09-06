<?php

/**
 * GfcChargeRestController — Godwins Family Care bounded patch for OpenEMR 8.4.0
 *
 * Adds the two write paths OpenEMR 8.4 exposes on its own screens but not on the
 * REST API: a fee-sheet charge for an encounter, and a procedure order. Both wrap
 * business logic that already exists and is what OpenEMR's own screens call —
 * BillingUtilities::addBilling() (the exact function the Fee Sheet uses) and the
 * procedure_order / procedure_order_code inserts the Procedure Order form makes.
 * No billing logic is written from scratch here.
 *
 * Guarded by the SAME ACL the corresponding screens use, so a token that cannot
 * code an encounter in the UI cannot code one through the API either:
 *   - charges and orders: encounters / coding_a  (Fee Sheet + diagnosis coding)
 *   - code search:        encounters / coding_a
 *
 * NO NEW OAUTH SCOPE. Standard /api/ routes on 8.4 are gated by the ACL check in
 * RestConfig::request_authorization_check(), not by a per-route scope, and the
 * server's API scope list (ServerScopeListEntity::apiScopes()) is a hardcoded
 * array. Introducing a new scope name would require re-registering the OAuth
 * client, so these routes deliberately introduce none.
 *
 * @package   OpenEMR
 * @author    Godwins Family Care (GFC Care Platform)
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

namespace OpenEMR\RestControllers;

use OpenEMR\Billing\BillingUtilities;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Validators\ProcessingResult;

class GfcChargeRestController
{
    /** Code types accepted on a charge line. ICD10 is allowed because OpenEMR
     *  stores encounter diagnoses in the same billing table as the services. */
    private const ALLOWED_CODE_TYPES = ['CPT4', 'HCPCS', 'ICD10'];

    private const ALLOWED_ORDER_STATUS = ['pending', 'routed', 'complete', 'canceled'];

    private const ALLOWED_ORDER_PRIORITY = ['normal', 'high', 'renewal'];

    /**
     * POST /api/patient/:pid/encounter/:eid/billing
     *
     * Writes one fee-sheet charge line onto the encounter. Keyed by NUMERIC pid
     * and encounter id, matching soap_note and vital on this instance (uuids are
     * silently coerced to 0 by the standard API, which is the defect that
     * orphaned notes at patient zero).
     */
    public function postCharge($pid, $eid, array $data): ProcessingResult
    {
        $result = new ProcessingResult();

        $pid = (int)$pid;
        $eid = (int)$eid;

        // addBilling() calls die() when the encounter is missing, which would
        // emit a bare HTML page instead of a response. Pre-validate so the API
        // returns a 400 the caller can act on.
        if ($pid <= 0 || $eid <= 0) {
            $result->setValidationMessages(['pid' => ['A numeric pid and encounter id are required']]);
            return $result;
        }
        $encounter = sqlQuery(
            "SELECT encounter FROM form_encounter WHERE pid = ? AND encounter = ?",
            [$pid, $eid]
        );
        if (empty($encounter)) {
            $result->setValidationMessages(['encounter' => ['No such encounter for this patient']]);
            return $result;
        }

        $codeType = strtoupper(trim((string)($data['code_type'] ?? 'CPT4')));
        if (!in_array($codeType, self::ALLOWED_CODE_TYPES, true)) {
            $result->setValidationMessages(['code_type' => ['Must be one of ' . implode(', ', self::ALLOWED_CODE_TYPES)]]);
            return $result;
        }

        $code = trim((string)($data['code'] ?? ''));
        if ($code === '' || strlen($code) > 64) {
            $result->setValidationMessages(['code' => ['A code of 1 to 64 characters is required']]);
            return $result;
        }

        $providerId = (int)($data['provider_id'] ?? 0);
        if ($providerId <= 0) {
            $result->setValidationMessages(['provider_id' => ['A numeric provider_id (users.id) is required — this is the rendering provider']]);
            return $result;
        }
        $provider = sqlQuery("SELECT id FROM users WHERE id = ? AND active = 1", [$providerId]);
        if (empty($provider)) {
            $result->setValidationMessages(['provider_id' => ['No active user with that id']]);
            return $result;
        }

        $units = (int)($data['units'] ?? 1);
        if ($units < 1) {
            $units = 1;
        }

        $fee = $data['fee'] ?? '0.00';
        if (!is_numeric($fee)) {
            $result->setValidationMessages(['fee' => ['fee must be numeric']]);
            return $result;
        }
        $fee = sprintf('%01.2f', (float)$fee);

        // Diagnosis pointers. OpenEMR stores billing.justify as colon-separated
        // entries, each optionally "TYPE|CODE" — Claim::diagIndexArray() splits
        // on ":" then on "|" and strips the type label. Accept a diagnoses array
        // (preferred) or a pre-built justify string.
        $justify = '';
        if (!empty($data['diagnoses']) && is_array($data['diagnoses'])) {
            $parts = [];
            foreach ($data['diagnoses'] as $dx) {
                $dx = trim((string)$dx);
                if ($dx !== '') {
                    $parts[] = 'ICD10|' . $dx;
                }
            }
            if (!empty($parts)) {
                $justify = implode(':', $parts) . ':';
            }
        } elseif (!empty($data['justify'])) {
            $justify = (string)$data['justify'];
        }

        $codeText = trim((string)($data['code_text'] ?? ''));
        if ($codeText === '') {
            // Mirror the Fee Sheet: look the description up rather than storing blank.
            $lookup = sqlQuery(
                "SELECT code_text FROM codes WHERE code = ? AND code_text != '' LIMIT 1",
                [$code]
            );
            $codeText = $lookup['code_text'] ?? '';
        }

        $billingId = BillingUtilities::addBilling(
            $eid,
            $codeType,
            $code,
            $codeText,
            $pid,
            (string)((int)($data['authorized'] ?? 1)),
            $providerId,
            trim((string)($data['modifier'] ?? '')),
            $units,
            $fee,
            (string)($data['ndc_info'] ?? ''),
            $justify,
            0,
            (string)($data['notecodes'] ?? ''),
            (string)($data['pricelevel'] ?? ''),
            (string)($data['revenue_code'] ?? ''),
            (string)($data['payer_id'] ?? '0')
        );

        if (empty($billingId)) {
            $result->addInternalError('The charge could not be written to the billing table');
            return $result;
        }

        $row = sqlQuery("SELECT * FROM billing WHERE id = ?", [$billingId]);
        $result->addData($row ?: ['id' => $billingId]);
        return $result;
    }

    /**
     * GET /api/patient/:pid/encounter/:eid/billing
     * Read the charge lines back — this is how the app proves a sign-and-close
     * landed in Billing Manager.
     */
    public function getCharges($pid, $eid): ProcessingResult
    {
        $result = new ProcessingResult();
        $rows = [];
        $statement = sqlStatement(
            "SELECT id, date, code_type, code, code_text, modifier, units, fee, justify, provider_id, "
            . "authorized, billed, activity, payer_id, notecodes, revenue_code "
            . "FROM billing WHERE pid = ? AND encounter = ? AND activity = 1 ORDER BY id",
            [(int)$pid, (int)$eid]
        );
        while ($row = sqlFetchArray($statement)) {
            $rows[] = $row;
        }
        $result->setData($rows);
        return $result;
    }

    /**
     * DELETE /api/patient/:pid/encounter/:eid/billing/:id
     * Voids a charge line the way OpenEMR's own screens do: activity = 0, never
     * a hard delete, so the audit trail survives.
     */
    public function voidCharge($pid, $eid, $id): ProcessingResult
    {
        $result = new ProcessingResult();
        $row = sqlQuery(
            "SELECT id, billed FROM billing WHERE id = ? AND pid = ? AND encounter = ? AND activity = 1",
            [(int)$id, (int)$pid, (int)$eid]
        );
        if (empty($row)) {
            $result->setValidationMessages(['id' => ['No such active charge on this encounter']]);
            return $result;
        }
        if (!empty($row['billed'])) {
            $result->setValidationMessages(['id' => ['That charge has already been billed and cannot be voided through the API']]);
            return $result;
        }
        sqlStatement("UPDATE billing SET activity = 0 WHERE id = ?", [(int)$id]);
        $result->addData(['id' => (int)$id, 'activity' => 0]);
        return $result;
    }

    /**
     * POST /api/patient/:pid/encounter/:eid/order
     *
     * Creates a procedure order and its order-code rows, then registers the form
     * on the encounter — the same three steps interface/forms/procedure_order/
     * common.php performs when a user saves the Procedure Order form.
     */
    public function postOrder($pid, $eid, array $data): ProcessingResult
    {
        $result = new ProcessingResult();

        $pid = (int)$pid;
        $eid = (int)$eid;
        if ($pid <= 0 || $eid <= 0) {
            $result->setValidationMessages(['pid' => ['A numeric pid and encounter id are required']]);
            return $result;
        }
        $encounter = sqlQuery(
            "SELECT encounter FROM form_encounter WHERE pid = ? AND encounter = ?",
            [$pid, $eid]
        );
        if (empty($encounter)) {
            $result->setValidationMessages(['encounter' => ['No such encounter for this patient']]);
            return $result;
        }

        $providerId = (int)($data['provider_id'] ?? 0);
        if ($providerId <= 0) {
            $result->setValidationMessages(['provider_id' => ['A numeric provider_id (users.id) is required — this is the ordering provider']]);
            return $result;
        }

        $codes = $data['codes'] ?? [];
        if (empty($codes) || !is_array($codes)) {
            $result->setValidationMessages(['codes' => ['At least one order code is required, as [{"code":"…","name":"…","diagnoses":["…"]}]']]);
            return $result;
        }

        $priority = strtolower(trim((string)($data['order_priority'] ?? 'normal')));
        if (!in_array($priority, self::ALLOWED_ORDER_PRIORITY, true)) {
            $priority = 'normal';
        }
        $status = strtolower(trim((string)($data['order_status'] ?? 'pending')));
        if (!in_array($status, self::ALLOWED_ORDER_STATUS, true)) {
            $status = 'pending';
        }

        $orderType = trim((string)($data['procedure_order_type'] ?? 'laboratory_test'));
        $dateOrdered = trim((string)($data['date_ordered'] ?? ''));
        if ($dateOrdered === '') {
            $dateOrdered = date('Y-m-d H:i:s');
        }

        $orderId = sqlInsert(
            "INSERT INTO procedure_order SET "
            . "provider_id = ?, patient_id = ?, encounter_id = ?, date_ordered = ?, order_priority = ?, "
            . "order_status = ?, activity = 1, clinical_hx = ?, order_diagnosis = ?, "
            . "patient_instructions = ?, procedure_order_type = ?, lab_id = ?",
            [
                $providerId,
                $pid,
                $eid,
                $dateOrdered,
                $priority,
                $status,
                substr(trim((string)($data['clinical_hx'] ?? '')), 0, 255),
                substr(trim((string)($data['order_diagnosis'] ?? '')), 0, 255),
                trim((string)($data['patient_instructions'] ?? '')),
                $orderType,
                (int)($data['lab_id'] ?? 0),
            ]
        );

        if (empty($orderId)) {
            $result->addInternalError('The order could not be written to procedure_order');
            return $result;
        }

        UuidRegistry::createMissingUuidsForTables(['procedure_order']);

        $seq = 0;
        foreach ($codes as $entry) {
            $seq++;
            $entry = (array)$entry;
            $dx = '';
            if (!empty($entry['diagnoses']) && is_array($entry['diagnoses'])) {
                $parts = [];
                foreach ($entry['diagnoses'] as $one) {
                    $one = trim((string)$one);
                    if ($one !== '') {
                        $parts[] = 'ICD10:' . $one;
                    }
                }
                $dx = implode(';', $parts);
            } elseif (!empty($entry['diagnoses'])) {
                $dx = (string)$entry['diagnoses'];
            }

            sqlStatement(
                "INSERT INTO procedure_order_code SET "
                . "procedure_order_id = ?, procedure_order_seq = ?, procedure_code = ?, procedure_name = ?, "
                . "procedure_source = '1', diagnoses = ?, procedure_order_title = ?",
                [
                    $orderId,
                    $seq,
                    substr(trim((string)($entry['code'] ?? '')), 0, 64),
                    substr(trim((string)($entry['name'] ?? '')), 0, 255),
                    $dx,
                    substr(trim((string)($entry['title'] ?? ($entry['name'] ?? ''))), 0, 255),
                ]
            );
        }

        // Register the order on the encounter so it appears in the chart, exactly
        // as the Procedure Order form does.
        if (function_exists('addForm')) {
            $title = trim((string)($data['title'] ?? ''));
            if ($title === '') {
                $title = 'Procedure Order ' . $orderId;
            }
            addForm($eid, $title, $orderId, 'procedure_order', $pid, (string)((int)($data['authorized'] ?? 1)));
        }

        $result->addData($this->readOrder($orderId));
        return $result;
    }

    /**
     * GET /api/patient/:pid/encounter/:eid/order
     */
    public function getOrders($pid, $eid): ProcessingResult
    {
        $result = new ProcessingResult();
        $rows = [];
        $statement = sqlStatement(
            "SELECT procedure_order_id FROM procedure_order "
            . "WHERE patient_id = ? AND encounter_id = ? AND activity = 1 ORDER BY procedure_order_id",
            [(int)$pid, (int)$eid]
        );
        while ($row = sqlFetchArray($statement)) {
            $rows[] = $this->readOrder((int)$row['procedure_order_id']);
        }
        $result->setData($rows);
        return $result;
    }

    /**
     * PUT /api/patient/:pid/encounter/:eid/order/:orderId
     * Advances the order status. The app owns the ordered → sent → resulted
     * workflow; this keeps OpenEMR's copy in step.
     */
    public function putOrderStatus($pid, $eid, $orderId, array $data): ProcessingResult
    {
        $result = new ProcessingResult();
        $order = sqlQuery(
            "SELECT procedure_order_id FROM procedure_order "
            . "WHERE procedure_order_id = ? AND patient_id = ? AND encounter_id = ? AND activity = 1",
            [(int)$orderId, (int)$pid, (int)$eid]
        );
        if (empty($order)) {
            $result->setValidationMessages(['orderId' => ['No such active order on this encounter']]);
            return $result;
        }
        $status = strtolower(trim((string)($data['order_status'] ?? '')));
        if (!in_array($status, self::ALLOWED_ORDER_STATUS, true)) {
            $result->setValidationMessages(['order_status' => ['Must be one of ' . implode(', ', self::ALLOWED_ORDER_STATUS)]]);
            return $result;
        }
        sqlStatement(
            "UPDATE procedure_order SET order_status = ? WHERE procedure_order_id = ?",
            [$status, (int)$orderId]
        );
        $result->addData($this->readOrder((int)$orderId));
        return $result;
    }

    /**
     * GET /api/codes?type=ICD10&search=…
     * Search the loaded code tables. Removes the app's last coding workaround —
     * until the ICD-10-CM load runs this returns an empty list, which is the
     * correct answer for an empty table.
     */
    public function searchCodes(array $query): ProcessingResult
    {
        $result = new ProcessingResult();
        $search = trim((string)($query['search'] ?? ''));
        if (strlen($search) < 2) {
            $result->setValidationMessages(['search' => ['A search term of at least 2 characters is required']]);
            return $result;
        }
        $limit = (int)($query['limit'] ?? 25);
        if ($limit < 1 || $limit > 100) {
            $limit = 25;
        }

        $params = [];
        $typeClause = '';
        $type = strtoupper(trim((string)($query['type'] ?? '')));
        if ($type !== '') {
            $typeClause = " AND ct.ct_key = ? ";
            $params[] = $type;
        }

        $like = '%' . $search . '%';
        $sql = "SELECT c.code, c.code_text, ct.ct_key AS code_type, c.modifier, c.active "
            . "FROM codes c JOIN code_types ct ON ct.ct_id = c.code_type "
            . "WHERE c.active = 1 AND (c.code LIKE ? OR c.code_text LIKE ?) " . $typeClause
            . "ORDER BY (c.code = ?) DESC, c.code LIMIT " . $limit;
        array_unshift($params, $like, $like);
        $params[] = $search;

        $rows = [];
        $statement = sqlStatement($sql, $params);
        while ($row = sqlFetchArray($statement)) {
            $rows[] = $row;
        }
        $result->setData($rows);
        return $result;
    }

    private function readOrder(int $orderId): array
    {
        $order = sqlQuery(
            "SELECT procedure_order_id, uuid, provider_id, patient_id, encounter_id, date_ordered, "
            . "order_priority, order_status, order_diagnosis, procedure_order_type, activity "
            . "FROM procedure_order WHERE procedure_order_id = ?",
            [$orderId]
        ) ?: [];
        if (!empty($order['uuid'])) {
            $order['uuid'] = UuidRegistry::uuidToString($order['uuid']);
        }
        $codes = [];
        $statement = sqlStatement(
            "SELECT procedure_order_seq, procedure_code, procedure_name, procedure_order_title, diagnoses "
            . "FROM procedure_order_code WHERE procedure_order_id = ? ORDER BY procedure_order_seq",
            [$orderId]
        );
        while ($row = sqlFetchArray($statement)) {
            $codes[] = $row;
        }
        $order['codes'] = $codes;
        return $order;
    }
}
