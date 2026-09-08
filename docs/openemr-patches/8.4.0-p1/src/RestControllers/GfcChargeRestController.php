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
        // X12 diagnosis pointers, the format Claim::diagIndexArray() parses:
        //     ICD10|E11.9:ICD10|I10:
        // Note this is NOT the format procedure_order_code.diagnoses uses; see
        // normalizeDiagnoses(), which both callers share so the two formats
        // cannot drift apart in how they read their input.
        $justify = '';
        $dxList = self::normalizeDiagnoses($data['diagnoses'] ?? null);
        if (!empty($dxList)) {
            $parts = [];
            foreach ($dxList as $dxEntry) {
                $parts[] = $dxEntry['type'] . '|' . $dxEntry['code'];
            }
            $justify = implode(':', $parts) . ':';
        } elseif (!empty($data['justify'])) {
            $justify = is_scalar($data['justify']) ? (string)$data['justify'] : '';
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
            // procedure_order_code.diagnoses is "ICD10:E11.9;ICD10:I10" —
            // a different separator set from the charge's X12 justify, but the
            // same input shapes, so it reads them through the same helper.
            $dx = '';
            $orderDxList = self::normalizeDiagnoses($entry['diagnoses'] ?? null);
            if (!empty($orderDxList)) {
                $parts = [];
                foreach ($orderDxList as $dxEntry) {
                    $parts[] = $dxEntry['type'] . ':' . $dxEntry['code'];
                }
                $dx = implode(';', $parts);
            } elseif (!empty($entry['diagnoses']) && is_scalar($entry['diagnoses'])) {
                $dx = trim((string)$entry['diagnoses']);
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
     *
     * Searches through OpenEMR's own main_code_set_search(), which is what the
     * Fee Sheet itself calls (interface/forms/fee_sheet/new.php). That matters:
     * an earlier version of this method ran its own
     * `FROM codes c JOIN code_types ct` query, which reads ONLY the manually
     * entered `codes` table. OpenEMR's External Data Loads writes ICD-10 into a
     * separate external table (icd10_dx_order_code), so that query returned an
     * empty list whether or not the code set had been loaded — and the empty
     * list was read as "the load has not run" when in fact it had. A search
     * result can never be evidence about a load; only a resolved code is.
     *
     * Deferring to main_code_set_search() also means every external code set
     * OpenEMR supports works here for free, and the query keeps working when
     * upstream changes the table layout.
     */
    public function searchCodes(array $query): ProcessingResult
    {
        require_once(__DIR__ . '/../../custom/code_types.inc.php');
        global $code_types;

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

        // Resolve the code type(s) to search. An unknown type is rejected here
        // rather than passed through: code_set_search() calls HelpfulDie() when
        // a type maps to an external table that is not installed, which would
        // take down the request instead of returning an error.
        $type = strtoupper(trim((string)($query['type'] ?? '')));
        if ($type !== '') {
            if (empty($code_types[$type]) || empty($code_types[$type]['active'])) {
                $result->setValidationMessages(['type' => [
                    'Unknown or inactive code type. Active types: '
                    . implode(', ', collect_codetypes('active', 'array'))
                ]]);
                return $result;
            }
            $searchTypes = $type;
        } else {
            // No type given: the diagnosis and procedure sets, which are the
            // only ones this route exists to serve. Deliberately NOT every
            // active type — multiple_code_set_search() UNIONs one subquery per
            // type, and code_set_search() adds an extra column for valueset
            // tables, so a mixed set can produce a UNION with mismatched
            // columns. Both callers pass an explicit type anyway.
            $searchTypes = array_values(array_unique(array_merge(
                collect_codetypes('diagnosis', 'array'),
                collect_codetypes('procedure', 'array')
            )));
            if (empty($searchTypes)) {
                $result->setData([]);
                return $result;
            }
        }

        $rows = [];
        $res = main_code_set_search($searchTypes, $search, $limit);
        if (!empty($res)) {
            while ($row = sqlFetchArray($res)) {
                // An external code with no row in `codes` has NULL modifier and
                // NULL active — that is a code the practice has never edited,
                // not an inactive one, so it normalises to an active code with
                // no modifier. code_type_name is the ct_key string ('ICD10'),
                // which is what this route has always returned as code_type.
                $rows[] = [
                    'code' => $row['code'],
                    'code_text' => $row['code_text'] ?? '',
                    'code_type' => $row['code_type_name'] ?? $type,
                    'modifier' => $row['modifier'] ?? '',
                    'active' => isset($row['active']) ? (int)$row['active'] : 1,
                ];
            }
        }

        // Float an exact code match to the top, as the previous hand-written
        // ORDER BY did. main_code_set_search() has its own ordering, so this is
        // applied after the fetch rather than in the query.
        $needle = strtoupper($search);
        usort($rows, static function ($a, $b) use ($needle) {
            $ax = strtoupper((string)$a['code']) === $needle ? 0 : 1;
            $bx = strtoupper((string)$b['code']) === $needle ? 0 : 1;
            return $ax <=> $bx;
        });

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

    /**
     * Normalise a diagnosis list to [['type' => 'ICD10', 'code' => 'E11.9'], ...].
     *
     * Callers accept two shapes, because the app sends objects and a hand-rolled
     * call may send bare codes:
     *
     *     ["E11.9", "I10"]
     *     [{"code_type": "ICD10", "code": "E11.9"}, {"code": "I10"}]
     *
     * Casting an entry straight to string turns an object into the literal
     * "Array". On the charge that produced justify "ICD10|Array:" — a row that
     * looks correct in Billing Manager and carries broken diagnosis pointers
     * onto the claim, so it surfaces as a denial rather than an error. The order
     * path had the same defect against procedure_order_code.diagnoses. Both were
     * found by the Phase 6B acceptance test on 2026-09-06; this helper exists so
     * there is one place to get it right rather than two to keep in step.
     *
     * Deliberately NOT named $code/$type internally: the charge path holds the
     * CPT being billed in $code, and the first fix reused that name in its loop
     * and billed the last diagnosis instead of the E/M code.
     *
     * Entries that are empty or non-scalar are dropped rather than coerced.
     *
     * @param mixed $raw
     * @return array<int, array{type: string, code: string}>
     */
    private static function normalizeDiagnoses($raw): array
    {
        if (empty($raw) || !is_array($raw)) {
            return [];
        }

        $out = [];
        foreach ($raw as $dx) {
            if (is_array($dx)) {
                $dxCode = $dx['code'] ?? '';
                $dxType = $dx['code_type'] ?? 'ICD10';
            } else {
                $dxCode = $dx;
                $dxType = 'ICD10';
            }
            if (!is_scalar($dxCode) || !is_scalar($dxType)) {
                continue;
            }
            $dxCode = trim((string)$dxCode);
            $dxType = strtoupper(trim((string)$dxType));
            if ($dxCode === '') {
                continue;
            }
            $out[] = [
                'type' => $dxType !== '' ? $dxType : 'ICD10',
                'code' => $dxCode,
            ];
        }

        return $out;
    }
}
