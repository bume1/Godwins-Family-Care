<?php
// Runs the REAL GfcChargeRestController::postCharge against stubbed OpenEMR
// tables (codes, prices, patient_data, list_options) and a stubbed
// BillingUtilities::addBilling that records the fee it was handed.
// Driven by test/charge_fee.test.js. Prints one JSON object per case.

namespace OpenEMR\Validators {
    class ProcessingResult {
        public $data = []; public $validation = []; public $internal = [];
        public function setValidationMessages($m) { $this->validation = $m; }
        public function addInternalError($e) { $this->internal[] = $e; }
        public function addData($d) { $this->data[] = $d; }
        public function setData($d) { $this->data = $d; }
    }
}
namespace OpenEMR\Common\Uuid { class UuidRegistry {} }
namespace OpenEMR\Billing {
    class BillingUtilities {
        public static $last = null;
        public static function addBilling($eid, $type, $code, $text, $pid, $auth, $prov, $mod, $units, $fee, ...$rest) {
            self::$last = ['code' => $code, 'modifier' => $mod, 'units' => $units, 'fee' => $fee, 'pricelevel' => $rest[4] ?? null];
            return 77;
        }
    }
}
namespace {
    // codes.id 10 = 99350 (no modifier). 11 = 99350 modifier 25 with NO price.
    // 12 = 99349, priced only at a "medicare" level.
    $GLOBALS['FIX'] = [
        'codes' => [
            ['id' => 10, 'ct' => 'CPT4', 'code' => '99350', 'modifier' => '', 'code_text' => 'Home visit est'],
            ['id' => 11, 'ct' => 'CPT4', 'code' => '99350', 'modifier' => '25', 'code_text' => 'Home visit est'],
            ['id' => 12, 'ct' => 'CPT4', 'code' => '99349', 'modifier' => '', 'code_text' => 'Home visit est'],
        ],
        'prices' => [
            ['pr_id' => 10, 'pr_selector' => '', 'pr_level' => 'standard', 'pr_price' => '245.50'],
            ['pr_id' => 10, 'pr_selector' => '', 'pr_level' => 'medicare', 'pr_price' => '199.00'],
            ['pr_id' => 12, 'pr_selector' => '', 'pr_level' => 'medicare', 'pr_price' => '150.00'],
        ],
        'patient_level' => [1 => '', 2 => 'medicare'],
    ];
    function sqlQuery($sql, $b = []) {
        $F = $GLOBALS['FIX'];
        if (strpos($sql, 'FROM form_encounter') !== false) return ['encounter' => $b[1]];
        if (strpos($sql, 'FROM users') !== false) return ['id' => $b[0]];
        if (strpos($sql, 'FROM patient_data') !== false) return ['pricelevel' => $F['patient_level'][$b[0]] ?? ''];
        if (strpos($sql, 'FROM list_options') !== false) return ['option_id' => 'standard'];
        if (strpos($sql, 'FROM codes c JOIN code_types') !== false) {
            foreach ($F['codes'] as $c) if ($c['ct'] === $b[0] && $c['code'] === $b[1] && $c['modifier'] === $b[2]) return ['id' => $c['id']];
            return false;
        }
        if (strpos($sql, 'FROM prices') !== false) {
            foreach ($F['prices'] as $p) if ($p['pr_id'] === $b[0] && $p['pr_level'] === $b[1]) return ['pr_price' => $p['pr_price']];
            return false;
        }
        if (strpos($sql, 'SELECT code_text FROM codes') !== false) return ['code_text' => 'Home visit est'];
        if (strpos($sql, 'FROM billing WHERE id') !== false) return ['id' => $b[0], 'fee' => \OpenEMR\Billing\BillingUtilities::$last['fee']];
        return false;
    }
    require __DIR__ . '/../../docs/openemr-patches/8.4.0-p1/src/RestControllers/GfcChargeRestController.php';
    $ctl = new \OpenEMR\RestControllers\GfcChargeRestController();
    $cases = [
        'no_fee_99350' => [1, ['code' => '99350', 'provider_id' => 5]],
        'mod25_99350' => [1, ['code' => '99350', 'modifier' => '25', 'provider_id' => 5]],
        'two_units_99350' => [1, ['code' => '99350', 'units' => 2, 'provider_id' => 5]],
        'medicare_level_99350' => [2, ['code' => '99350', 'provider_id' => 5]],
        'no_price_99349_standard' => [1, ['code' => '99349', 'provider_id' => 5]],
        'posted_fee_99350' => [1, ['code' => '99350', 'fee' => '10', 'provider_id' => 5]],
    ];
    $out = [];
    foreach ($cases as $name => [$pid, $data]) {
        \OpenEMR\Billing\BillingUtilities::$last = null;
        $r = $ctl->postCharge($pid, 900, $data);
        $out[$name] = ['written' => \OpenEMR\Billing\BillingUtilities::$last, 'row' => $r->data[0] ?? null, 'validation' => $r->validation];
    }
    echo json_encode($out);
}
