<?php
/**
 * Template Name: GFC Provider ROI
 *
 * Patient link: /gfc-upload/?token=XXXXXXXX
 *
 * SETUP — fill in after deployment:
 *   GFC_ROI_SCRIPT_URL  → your new ROI GAS Web App URL
 *   GFC_ROI_PDF_URL     → URL to blank ROI PDF in Media Library
 */

define( 'GFC_INTAKE_SCRIPT_URL', 'https://script.google.com/macros/s/AKfycbyEt_q31daQRFFyBhirobxUR6ztn24bNivKa9E8cT96C65OgofX5P0OKbfxyXk84AjP/exec' );
define( 'GFC_ROI_SCRIPT_URL',    'https://script.google.com/macros/s/AKfycbwWHmfspx2YN3FUNqCi-520A-lbQzfKgFcWNMaJ7ov_wqKAMu_DqurIekZ4oC9H1_r7kg/exec' );
define( 'GFC_ROI_PDF_URL',       'https://godwinsfamilycarellc.com/wp-content/uploads/2026/06/GFC_ROI_Obtain_Records.pdf' );


// ── POST: File upload ─────────────────────────────────────────
if ( $_SERVER['REQUEST_METHOD'] === 'POST' && isset( $_FILES['roi_file'] ) ) {

	$token = isset( $_POST['token'] ) ? sanitize_text_field( wp_unslash( $_POST['token'] ) ) : '';
	$file  = $_FILES['roi_file'];

	if ( ! $token || ! $file || $file['error'] !== UPLOAD_ERR_OK ) {
		wp_send_json( array( 'success' => false, 'message' => 'Missing file or token.' ) );
	}
	if ( $file['size'] > 10 * 1024 * 1024 ) {
		wp_send_json( array( 'success' => false, 'message' => 'File exceeds 10 MB limit.' ) );
	}
	if ( ! in_array( $file['type'], array( 'application/pdf', 'image/jpeg', 'image/jpg', 'image/png' ), true ) ) {
		wp_send_json( array( 'success' => false, 'message' => 'Only PDF, JPG, and PNG files are accepted.' ) );
	}

	$response = wp_remote_post( GFC_ROI_SCRIPT_URL, array(
		'headers' => array( 'Content-Type' => 'text/plain' ),
		'body'    => wp_json_encode( array(
			'action'   => 'uploadROI',
			'token'    => $token,
			'fileName' => sanitize_file_name( $file['name'] ),
			'fileData' => base64_encode( file_get_contents( $file['tmp_name'] ) ), // phpcs:ignore
			'mimeType' => $file['type'],
		) ),
		'timeout' => 45,
	) );

	if ( is_wp_error( $response ) ) {
		wp_send_json( array( 'success' => false, 'message' => 'Upload failed. Please call (404) 913-6705.' ) );
	}
	$result = json_decode( wp_remote_retrieve_body( $response ), true );
	wp_send_json( is_array( $result ) ? $result : array( 'success' => true ) );
}


// ── POST: Online form submission ──────────────────────────────
if ( $_SERVER['REQUEST_METHOD'] === 'POST' && isset( $_POST['action'] ) && $_POST['action'] === 'generate' ) {

	$s = function( $k ) { return sanitize_text_field( wp_unslash( $_POST[ $k ] ?? '' ) ); };
	$b = function( $k ) { return ! empty( $_POST[ $k ] ); };

	// Decode the providers JSON array submitted by the form JS
	$providers_raw = wp_unslash( $_POST['providers'] ?? '[]' );
	$providers     = json_decode( $providers_raw, true );
	if ( ! is_array( $providers ) ) {
		$providers = array();
	}
	// Sanitize each provider's fields
	$providers_clean = array();
	foreach ( $providers as $p ) {
		if ( ! empty( $p['name'] ) ) { // skip blank entries
			$providers_clean[] = array(
				'name'    => sanitize_text_field( $p['name']    ?? '' ),
				'dept'    => sanitize_text_field( $p['dept']    ?? '' ),
				'address' => sanitize_text_field( $p['address'] ?? '' ),
				'phone'   => sanitize_text_field( $p['phone']   ?? '' ),
				'fax'     => sanitize_text_field( $p['fax']     ?? '' ),
			);
		}
	}

	if ( empty( $providers_clean ) ) {
		wp_send_json( array( 'success' => false, 'message' => 'Please add at least one provider before submitting.' ) );
	}

	$response = wp_remote_post( GFC_ROI_SCRIPT_URL, array(
		'headers' => array( 'Content-Type' => 'text/plain' ),
		'body'    => wp_json_encode( array(
			'action'           => 'generateROIPDF',
			'token'            => $s( 'token' ),
			'providers'        => $providers_clean,
			'patientName'      => $s( 'patientName' ),
			'patientDOB'       => $s( 'patientDOB' ),
			'patientAddress'   => $s( 'patientAddress' ),
			'patientPhone'     => $s( 'patientPhone' ),
			'recHP'            => $b( 'recHP' ),
			'recLab'           => $b( 'recLab' ),
			'recDiag'          => $b( 'recDiag' ),
			'recImaging'       => $b( 'recImaging' ),
			'recMeds'          => $b( 'recMeds' ),
			'recDischarge'     => $b( 'recDischarge' ),
			'recAllergies'     => $b( 'recAllergies' ),
			'recImmune'        => $b( 'recImmune' ),
			'recOther'         => $b( 'recOther' ),
			'recOtherText'     => $s( 'recOtherText' ),
			'recProtected'     => $b( 'recProtected' ),
			'purposeTreatment' => $b( 'purposeTreatment' ),
			'purposeOther'     => $b( 'purposeOther' ),
			'purposeOtherText' => $s( 'purposeOtherText' ),
			'expDate'          => $s( 'expDate' ),
			'expEvent'         => $s( 'expEvent' ),
			'sigImage'         => wp_unslash( $_POST['sigImage'] ?? '' ),
			'sigDate'          => $s( 'sigDate' ),
			'sigPrintedName'   => $s( 'sigPrintedName' ),
			'sigRelationship'  => $s( 'sigRelationship' ),
		) ),
		'timeout' => 90,
	) );

	if ( is_wp_error( $response ) ) {
		wp_send_json( array( 'success' => false, 'message' => 'Submission failed. Please call (404) 913-6705.' ) );
	}
	$result = json_decode( wp_remote_retrieve_body( $response ), true );
	wp_send_json( is_array( $result ) ? $result : array( 'success' => true ) );
}


$url_token = isset( $_GET['token'] ) ? sanitize_text_field( wp_unslash( $_GET['token'] ) ) : '';

get_header();
?>

<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">

<style>
  .gfc-roi *, .gfc-roi *::before, .gfc-roi *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .gfc-roi {
    font-family: 'DM Sans', system-ui, sans-serif;
    background: #FAF7F2;
    min-height: 100vh;
    color: #1a2a32;
  }

  /* ── HEADER ── */
  .gfc-roi .roi-header {
    background: #033D50;
    padding: 24px 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .gfc-roi .roi-header img { height: 42px; display: block; }
  .gfc-roi .roi-header-text { text-align: right; }
  .gfc-roi .roi-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #F5CD85; margin-bottom: 4px; }
  .gfc-roi .roi-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 19px; font-weight: 600; color: #fff; }
  .gfc-roi .gold-bar { background: #F5CD85; height: 4px; }

  /* ── BODY ── */
  .gfc-roi .roi-body { max-width: 660px; margin: 44px auto; padding: 0 24px 80px; }

  /* ── SECTION CARD (intake-form style) ── */
  .gfc-roi .sc { background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,.06); margin-bottom: 16px; }
  .gfc-roi .sc-head { background: #033D50; display: flex; align-items: center; gap: 12px; padding: 10px 18px; }
  .gfc-roi .sc-num {
    background: #F5CD85; color: #033D50;
    font-size: 11px; font-weight: 700;
    width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .gfc-roi .sc-label { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #fff; }
  .gfc-roi .sc-body { padding: 24px 22px; }

  /* ── FIELDS ── */
  .gfc-roi .field-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
  .gfc-roi .field { flex: 1 1 200px; }
  .gfc-roi .field.sm { flex: 0 0 160px; }
  .gfc-roi .field label {
    display: block; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .07em; color: #5a7080; margin-bottom: 6px;
  }
  .gfc-roi .field input[type="text"],
  .gfc-roi .field input[type="date"],
  .gfc-roi .field input[type="tel"] {
    width: 100%; border: none; border-bottom: 1px solid #cdd5db;
    background: transparent; padding: 7px 2px; font-family: 'DM Sans', sans-serif;
    font-size: 13.5px; color: #1a2a32; outline: none; transition: border-color .15s;
  }
  .gfc-roi .field input:focus { border-bottom-color: #033D50; }

  /* ── CHECKBOXES ── */
  .gfc-roi .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin: 6px 0; }
  .gfc-roi .chk-label {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 13px; line-height: 1.5; cursor: pointer;
  }
  .gfc-roi .chk-label input[type="checkbox"] {
    width: 15px; height: 15px; flex-shrink: 0; margin-top: 1px;
    accent-color: #033D50; cursor: pointer;
  }
  .gfc-roi .chk-label .other-text {
    border: none; border-bottom: 1px solid #cdd5db;
    font-family: 'DM Sans', sans-serif; font-size: 13px;
    width: 120px; background: transparent; outline: none; padding: 1px 2px;
  }
  .gfc-roi .field-note { font-size: 11.5px; color: #5a7080; font-style: italic; line-height: 1.5; margin: 8px 0; }

  /* ── STATIC RELEASE-TO BOX ── */
  .gfc-roi .to-box { background: #FAF7F2; border: 1px solid #dde3e7; border-radius: 4px; padding: 12px 14px; }
  .gfc-roi .to-box strong { color: #033D50; font-size: 14px; display: block; margin-bottom: 3px; }
  .gfc-roi .to-box span { font-size: 12.5px; color: #3a4a52; }

  /* ── RIGHTS TEXT ── */
  .gfc-roi .rights-text { font-size: 12.5px; line-height: 1.7; color: #3a4a52; }

  /* ── SIGNATURE CANVAS ── */
  .gfc-roi .sig-pad-wrap {
    border: 1px solid #cdd5db; border-radius: 4px;
    background: #fff; position: relative; cursor: crosshair;
  }
  .gfc-roi #sigCanvas { display: block; width: 100%; height: 120px; touch-action: none; }
  .gfc-roi .sig-pad-wrap.sig-error { border-color: #b33a3a; }
  .gfc-roi .sig-clear-btn {
    position: absolute; top: 6px; right: 8px;
    background: transparent; border: 1px solid #cdd5db; border-radius: 3px;
    font-size: 11px; color: #5a7080; padding: 2px 8px; cursor: pointer;
  }
  .gfc-roi .sig-clear-btn:hover { border-color: #033D50; color: #033D50; }
  .gfc-roi .sig-hint { font-size: 11.5px; color: #9aabb3; margin-top: 6px; font-style: italic; }

  /* ── NOTICE ── */
  .gfc-roi .notice {
    background: #fff; border: 1px solid #dde3e7; border-left: 5px solid #F5CD85;
    border-radius: 6px; padding: 16px 20px; font-size: 13.5px;
    line-height: 1.75; color: #2a3a44; margin-bottom: 20px;
  }
  .gfc-roi .notice strong { color: #033D50; }
  .gfc-roi .notice a { color: #033D50; font-weight: 600; }

  /* ── GATE CARD ── */
  .gfc-roi .gate-card {
    background: #fff; border-radius: 6px; border-top: 4px solid #033D50;
    box-shadow: 0 1px 6px rgba(0,0,0,.06); padding: 36px 32px;
  }
  .gfc-roi .gate-h { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 22px; font-weight: 600; color: #033D50; margin-bottom: 8px; }
  .gfc-roi .gate-sub { font-size: 13.5px; color: #5a7080; line-height: 1.65; margin-bottom: 28px; }
  .gfc-roi .fl { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #5a7080; margin-bottom: 8px; }
  .gfc-roi .token-input {
    width: 100%; border: 1px solid #cdd5db; border-radius: 4px;
    padding: 12px 14px; font-family: 'DM Sans', sans-serif; font-size: 15px;
    color: #1a2a32; letter-spacing: .04em; outline: none; transition: border-color .15s; margin-bottom: 6px;
  }
  .gfc-roi .token-input:focus { border-color: #033D50; }
  .gfc-roi .error-inline { font-size: 12.5px; color: #b33a3a; margin-bottom: 14px; display: none; }

  /* ── CHOICE CARDS ── */
  .gfc-roi .choice-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 8px; }
  .gfc-roi .choice-card {
    background: #fff; border: 2px solid #dde3e7; border-radius: 8px;
    padding: 28px 22px; cursor: pointer; text-align: center;
    transition: border-color .15s, box-shadow .15s;
  }
  .gfc-roi .choice-card:hover { border-color: #033D50; box-shadow: 0 2px 10px rgba(3,61,80,.1); }
  .gfc-roi .choice-icon {
    width: 48px; height: 48px; background: #033D50; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; margin: 0 auto 14px;
  }
  .gfc-roi .choice-card h3 { font-size: 14.5px; font-weight: 600; color: #033D50; margin-bottom: 6px; }
  .gfc-roi .choice-card p { font-size: 12.5px; color: #5a7080; line-height: 1.6; }

  /* ── UPLOAD ZONE ── */
  .gfc-roi .upload-zone {
    border: 2px dashed #cdd5db; border-radius: 8px; padding: 40px 24px;
    text-align: center; background: #fafafa; cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .gfc-roi .upload-zone:hover, .gfc-roi .upload-zone.dragover { border-color: #033D50; background: #f0f4f6; }
  .gfc-roi .upload-icon {
    width: 50px; height: 50px; background: #033D50; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; margin: 0 auto 14px;
  }
  .gfc-roi .upload-zone p { font-size: 14px; color: #3a4a52; line-height: 1.75; }
  .gfc-roi .upload-zone strong { color: #033D50; }
  .gfc-roi .file-note { display: block; font-size: 12px; color: #9aabb3; margin-top: 4px; }
  .gfc-roi .file-banner {
    display: none; background: #eaf5ef; border: 1px solid #2a7d5a; border-radius: 5px;
    padding: 10px 16px; margin-top: 12px; font-size: 13px; color: #1f6845; font-weight: 500;
  }

  /* ── BACK LINK ── */
  .gfc-roi .back-link {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12.5px; color: #5a7080; cursor: pointer; margin-bottom: 20px;
    text-decoration: none; border: none; background: none; padding: 0;
  }
  .gfc-roi .back-link:hover { color: #033D50; }

  /* ── PRIMARY BUTTON ── */
  .gfc-roi .btn-primary {
    display: block; width: 100%; margin-top: 18px; padding: 14px;
    background: #033D50; color: #fff; border: none; border-radius: 4px;
    font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 600;
    letter-spacing: .02em; cursor: pointer; transition: background .15s;
  }
  .gfc-roi .btn-primary:hover:not(:disabled) { background: #054f67; }
  .gfc-roi .btn-primary:disabled { background: #9aabb3; cursor: not-allowed; }

  /* ── STATUS ── */
  .gfc-roi .status-msg { margin-top: 10px; font-size: 13px; text-align: center; color: #b33a3a; min-height: 18px; }

  /* ── SUCCESS ── */
  .gfc-roi .success-screen { text-align: center; padding: 60px 0 40px; }
  .gfc-roi .success-icon {
    width: 64px; height: 64px; background: #033D50; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;
  }
  .gfc-roi .success-screen h2 { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 28px; font-weight: 600; color: #033D50; margin-bottom: 14px; }
  .gfc-roi .success-screen p { font-size: 14px; color: #5a7080; line-height: 1.8; max-width: 420px; margin: 0 auto 10px; }
  .gfc-roi .success-contact { display: block; margin-top: 20px; font-size: 13.5px; font-weight: 600; color: #033D50; }

  /* ── PROVIDER CARDS ── */
  .gfc-roi .provider-card {
    border: 1px solid #dde3e7; border-radius: 6px; padding: 16px 18px;
    margin-bottom: 12px; background: #fafafa; position: relative;
  }
  .gfc-roi .provider-card-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 14px;
  }
  .gfc-roi .provider-badge {
    font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
    color: #033D50; background: #EAF0F3; border-radius: 3px; padding: 3px 8px;
  }
  .gfc-roi .remove-provider-btn {
    background: none; border: none; cursor: pointer; font-size: 12px;
    color: #b33a3a; padding: 2px 6px; border-radius: 3px;
  }
  .gfc-roi .remove-provider-btn:hover { background: #fde8e8; }
  .gfc-roi .add-provider-btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: none; border: 1px dashed #aabbc3; border-radius: 4px;
    color: #033D50; font-family: 'DM Sans', sans-serif; font-size: 13px;
    font-weight: 600; padding: 10px 16px; cursor: pointer; width: 100%;
    justify-content: center; margin-top: 4px; transition: background .15s;
  }
  .gfc-roi .add-provider-btn:hover { background: #EAF0F3; border-color: #033D50; }

  /* ── FOOTER ── */
  .gfc-roi .roi-footer { text-align: center; padding: 28px; font-size: 11px; color: #9aabb3; line-height: 1.9; }

  @media (max-width: 600px) {
    .gfc-roi .roi-header { padding: 18px 20px; }
    .gfc-roi .roi-header-text { display: none; }
    .gfc-roi .choice-row { grid-template-columns: 1fr; }
    .gfc-roi .checks { grid-template-columns: 1fr; }
    .gfc-roi .gate-card { padding: 28px 20px; }
    .gfc-roi .field.sm { flex: 1 1 100%; }
  }
</style>


<div class="gfc-roi">

  <div class="roi-header">
    <img src="https://godwinsfamilycarellc.com/wp-content/uploads/2024/10/Godwins-llc-3.png" alt="Godwins Family Care">
    <div class="roi-header-text">
      <div class="roi-eyebrow">Godwins Family Care LLC</div>
      <div class="roi-title">Provider Authorization</div>
    </div>
  </div>
  <div class="gold-bar"></div>

  <div class="roi-body">

    <!-- ══ SCREEN 1: Token gate (shown when no ?token= in URL) ══ -->
    <div id="screen-gate" style="display:none;">
      <div class="gate-card">
        <div class="gate-h">Upload your authorization</div>
        <div class="gate-sub">Enter the access code from your intake confirmation to continue.</div>
        <label class="fl" for="token-input">Access code</label>
        <input class="token-input" type="text" id="token-input"
               placeholder="e.g. 5BD7U7bRzFy4" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="error-inline" id="gate-error"></div>
        <button class="btn-primary" id="token-submit">Continue</button>
      </div>
    </div>

    <!-- ══ SCREEN 2: Choose upload or fill form ══ -->
    <div id="screen-choice" style="display:none;">
      <div class="notice">
        <p>To request your records, we need a signed <strong>Authorization to Obtain Medical Records</strong> form.
        Choose how you'd like to complete it below.</p>
      </div>

      <div class="choice-row">
        <div class="choice-card" id="btn-choose-upload">
          <div class="choice-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <h3>Upload a signed form</h3>
          <p>Already printed, signed, and scanned your form? Upload it here.</p>
        </div>

        <div class="choice-card" id="btn-choose-form">
          <div class="choice-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </div>
          <h3>Complete the form online</h3>
          <p>Fill it out digitally right now. We'll generate and file your authorization.</p>
        </div>
      </div>

      <p style="font-size:12px;color:#8a9aa2;text-align:center;margin-top:14px;">
        Need a blank copy to print? <a href="<?php echo esc_url( GFC_ROI_PDF_URL ); ?>" target="_blank" style="color:#033D50;font-weight:600;">Download the PDF here.</a>
      </p>
    </div>

    <!-- ══ SCREEN 3: Upload ══ -->
    <div id="screen-upload" style="display:none;">
      <button class="back-link" id="back-from-upload">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>

      <div class="sc">
        <div class="sc-head"><span class="sc-num">1</span><span class="sc-label">Upload Signed Form</span></div>
        <div class="sc-body">
          <div class="upload-zone" id="drop-zone">
            <div class="upload-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </div>
            <p><strong>Click to select your file</strong><br>or drag and drop it here<br>
            <span class="file-note">PDF, JPG, or PNG &nbsp;·&nbsp; max 10 MB</span></p>
            <input type="file" id="roi-file-input" accept=".pdf,.jpg,.jpeg,.png" style="display:none;">
          </div>
          <div class="file-banner" id="file-banner">&#10003;&nbsp; <span id="file-name-display"></span></div>
          <button class="btn-primary" id="upload-btn" disabled>Upload Document</button>
          <div class="status-msg" id="upload-status"></div>
        </div>
      </div>
    </div>

    <!-- ══ SCREEN 4: Online form ══ -->
    <div id="screen-form" style="display:none;">
      <button class="back-link" id="back-from-form">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>

      <form id="roi-form">
        <input type="hidden" name="action" value="generate">
        <input type="hidden" name="token" id="form-token" value="">

        <!-- Section 1: Patient -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">1</span><span class="sc-label">Patient (Whose Records)</span></div>
          <div class="sc-body">
            <div class="field-row">
              <div class="field">
                <label for="patientName">Patient full name</label>
                <input type="text" id="patientName" name="patientName" placeholder="First Last">
              </div>
              <div class="field sm">
                <label for="patientDOB">Date of birth</label>
                <input type="text" id="patientDOB" name="patientDOB" placeholder="MM/DD/YYYY">
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="patientAddress">Address</label>
                <input type="text" id="patientAddress" name="patientAddress" placeholder="Street, City, State ZIP">
              </div>
              <div class="field sm">
                <label for="patientPhone">Phone</label>
                <input type="tel" id="patientPhone" name="patientPhone" placeholder="(___) ___-____">
              </div>
            </div>
          </div>
        </div>

        <!-- Section 2: Release From — dynamic provider cards -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">2</span><span class="sc-label">Release Records From (Provider or Facility)</span></div>
          <div class="sc-body">
            <div class="field-note" style="margin-bottom:16px;font-style:normal;">
              Providers from your intake are pre-filled below. Edit any field, add a phone number for specialists where missing, and add any additional providers. <strong>A separate authorization PDF will be generated for each entry.</strong>
            </div>
            <div id="provider-cards-container">
              <!-- Provider cards injected by JS -->
            </div>
            <button type="button" class="add-provider-btn" id="add-provider-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add another provider or facility
            </button>
            <!-- Providers serialized as JSON before submit -->
            <input type="hidden" name="providers" id="providers-json" value="[]">
          </div>
        </div>

        <!-- Section 3: Release To (static) -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">3</span><span class="sc-label">Release Records To</span></div>
          <div class="sc-body">
            <div class="to-box">
              <strong>Godwins Family Care LLC</strong>
              <span>4300 Paces Ferry Rd SE, Ste 500, Atlanta, GA 30339 &nbsp;&nbsp; Tel 404-913-6705 &nbsp;&nbsp; Fax 678-692-7445</span>
            </div>
          </div>
        </div>

        <!-- Section 4: Information Authorized -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">4</span><span class="sc-label">Information Authorized for Release</span></div>
          <div class="sc-body">
            <div class="checks">
              <label class="chk-label"><input type="checkbox" name="recHP"> History &amp; physical / progress notes</label>
              <label class="chk-label"><input type="checkbox" name="recLab"> Lab and pathology results</label>
              <label class="chk-label"><input type="checkbox" name="recDiag"> Problem &amp; diagnosis list</label>
              <label class="chk-label"><input type="checkbox" name="recImaging"> Imaging / radiology reports</label>
              <label class="chk-label"><input type="checkbox" name="recMeds"> Current medication list</label>
              <label class="chk-label"><input type="checkbox" name="recDischarge"> Discharge summaries</label>
              <label class="chk-label"><input type="checkbox" name="recAllergies"> Allergies</label>
              <label class="chk-label"><input type="checkbox" name="recImmune"> Immunization records</label>
              <label class="chk-label">
                <input type="checkbox" name="recOther"> Other:&nbsp;<input type="text" name="recOtherText" class="other-text" placeholder="specify">
              </label>
            </div>
            <div class="field-note" style="margin-top:12px;">
              <strong>Specially protected information:</strong> Records of mental health, substance use, HIV/AIDS, or genetic testing are released ONLY if authorized here.
            </div>
            <label class="chk-label" style="margin-top:8px;">
              <input type="checkbox" name="recProtected"> Yes, include specially protected information listed above
            </label>
          </div>
        </div>

        <!-- Section 5: Purpose -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">5</span><span class="sc-label">Purpose of Disclosure</span></div>
          <div class="sc-body">
            <label class="chk-label"><input type="checkbox" name="purposeTreatment" checked> Treatment, care coordination, and care planning</label>
            <label class="chk-label" style="margin-top:10px;">
              <input type="checkbox" name="purposeOther"> Other:&nbsp;<input type="text" name="purposeOtherText" class="other-text" placeholder="specify">
            </label>
          </div>
        </div>

        <!-- Section 6: Expiration -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">6</span><span class="sc-label">Expiration</span></div>
          <div class="sc-body">
            <div class="field-note" style="margin-bottom:14px;font-style:normal;">Unless revoked sooner, this authorization expires <strong>one year</strong> from the date signed, or on the earlier of:</div>
            <div class="field-row">
              <div class="field"><label for="expDate">Expiration date (optional)</label><input type="text" id="expDate" name="expDate" placeholder="MM/DD/YYYY"></div>
              <div class="field"><label for="expEvent">Expiration event (optional)</label><input type="text" id="expEvent" name="expEvent" placeholder="e.g. end of treatment"></div>
            </div>
          </div>
        </div>

        <!-- Section 7: Your Rights -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">7</span><span class="sc-label">Your Rights</span></div>
          <div class="sc-body">
            <p class="rights-text">I understand that: (1) I may revoke this authorization at any time by writing to Godwins Family Care LLC, except to the extent action has already been taken in reliance on it; (2) treatment, payment, enrollment, and eligibility for benefits may not be conditioned on signing, except where the law allows; (3) information disclosed under this authorization may be re-disclosed by the recipient and may no longer be protected by federal privacy law; and (4) I am entitled to a copy of this signed authorization.</p>
          </div>
        </div>

        <!-- Section 8: Signature -->
        <div class="sc">
          <div class="sc-head"><span class="sc-num">8</span><span class="sc-label">Signature</span></div>
          <div class="sc-body">
            <div class="field-note" style="margin-bottom:16px;font-style:normal;">Draw your signature below using your mouse or finger.</div>
            <div class="field-row">
              <div class="field">
                <label>Signature <span style="color:#b33a3a;">*</span></label>
                <div class="sig-pad-wrap" id="sig-pad-wrap">
                  <canvas id="sigCanvas"></canvas>
                  <button type="button" class="sig-clear-btn" id="sig-clear-btn">Clear</button>
                </div>
                <div class="sig-hint">Use mouse or touch to sign. Click Clear to start over.</div>
                <input type="hidden" name="sigImage" id="sigImage">
                <input type="hidden" name="sigName" id="sigName" value="">
              </div>
              <div class="field sm">
                <label for="sigDate">Date</label>
                <input type="text" id="sigDate" name="sigDate" readonly style="color:#5a7080;">
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="sigPrintedName">Printed name <span style="color:#b33a3a;">*</span></label>
                <input type="text" id="sigPrintedName" name="sigPrintedName" placeholder="Full name" required>
              </div>
              <div class="field">
                <label for="sigRelationship">Relationship / authority (if signing for patient)</label>
                <input type="text" id="sigRelationship" name="sigRelationship" placeholder="e.g. Power of attorney">
              </div>
            </div>

            <button type="submit" class="btn-primary" id="form-submit-btn">Submit Authorization</button>
            <div class="status-msg" id="form-status"></div>
          </div>
        </div>

      </form>
    </div>

    <!-- ══ SCREEN 5: Success ══ -->
    <div id="screen-success" style="display:none;">
      <div class="success-screen">
        <div class="success-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="28" height="28">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2>Authorization Received</h2>
        <p>Your form has been submitted to our care team. We'll use it to request your records from your provider and will be in touch with next steps.</p>
        <p>A confirmation email is on its way to you.</p>
        <span class="success-contact">(404) 913-6705 &nbsp;·&nbsp; info@godwinsfamilycarellc.com</span>
      </div>
    </div>

  </div><!-- /.roi-body -->

  <div class="roi-footer">
    Godwins Family Care LLC &nbsp;·&nbsp; (404) 913-6705 &nbsp;·&nbsp; info@godwinsfamilycarellc.com<br>
    4300 Paces Ferry Road SE, Suite 500, Atlanta, GA 30339
  </div>

</div><!-- /.gfc-roi -->


<script>
(function () {

  var URL_TOKEN      = '<?php echo esc_js( $url_token ); ?>';
  var PAGE_URL       = '<?php echo esc_js( get_permalink() ); ?>';
  var INTAKE_GAS_URL = '<?php echo esc_js( GFC_INTAKE_SCRIPT_URL ); ?>';

  var activeToken      = URL_TOKEN;
  var patientData      = null;
  var providerCardCount = 0; // tracks total cards added (for unique IDs)

  // ── Today's date ─────────────────────────────────────────────
  var today = (function () {
    var d = new Date();
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  })();
  document.getElementById('sigDate').value = today;


  // ── Canvas signature pad ──────────────────────────────────────
  var sigCanvas  = null;
  var sigCtx     = null;
  var sigPadWrap = null;
  var sigDrawing = false;
  var sigEmpty   = true;

  function initSigCanvas() {
    sigCanvas  = document.getElementById('sigCanvas');
    sigPadWrap = document.getElementById('sig-pad-wrap');
    if (!sigCanvas || !sigPadWrap) return;
    sigCtx    = sigCanvas.getContext('2d');
    sigEmpty  = true;
    sigDrawing = false;
    var ratio = window.devicePixelRatio || 1;
    var w     = sigCanvas.offsetWidth || sigCanvas.parentNode.offsetWidth || 400;
    sigCanvas.width  = w * ratio;
    sigCanvas.height = 120 * ratio;
    sigCanvas.style.height = '120px';
    sigCtx.scale(ratio, ratio);
    sigCtx.strokeStyle = '#033D50';
    sigCtx.lineWidth   = 2;
    sigCtx.lineCap     = 'round';
    sigCtx.lineJoin    = 'round';

    function getPos(e) {
      var rect = sigCanvas.getBoundingClientRect();
      var src  = e.touches ? e.touches[0] : e;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }
    sigCanvas.addEventListener('mousedown', function(e) {
      sigDrawing = true; var p = getPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y);
    });
    sigCanvas.addEventListener('mousemove', function(e) {
      if (!sigDrawing) return;
      var p = getPos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
      sigEmpty = false; sigPadWrap.classList.remove('sig-error');
    });
    sigCanvas.addEventListener('mouseup',    function() { sigDrawing = false; });
    sigCanvas.addEventListener('mouseleave', function() { sigDrawing = false; });
    sigCanvas.addEventListener('touchstart', function(e) {
      e.preventDefault(); sigDrawing = true;
      var p = getPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y);
    }, { passive: false });
    sigCanvas.addEventListener('touchmove', function(e) {
      e.preventDefault(); if (!sigDrawing) return;
      var p = getPos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
      sigEmpty = false; sigPadWrap.classList.remove('sig-error');
    }, { passive: false });
    sigCanvas.addEventListener('touchend', function() { sigDrawing = false; });
    document.getElementById('sig-clear-btn').addEventListener('click', function() {
      sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
      sigEmpty = true;
      document.getElementById('sigImage').value = '';
      sigPadWrap.classList.remove('sig-error');
    });
  }


  // ── Screen helper ─────────────────────────────────────────────
  var screens = ['screen-gate', 'screen-choice', 'screen-upload', 'screen-form', 'screen-success'];
  function show(id) {
    screens.forEach(function (s) {
      document.getElementById(s).style.display = (s === id) ? '' : 'none';
    });
    window.scrollTo(0, 0);
  }

  // ── Escape HTML for attribute values ─────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }


  // ── Provider card builder ─────────────────────────────────────
  function buildProviderCard(defaults, isRemovable) {
    defaults   = defaults   || {};
    var idx    = providerCardCount++;
    var badge  = defaults.label || 'Provider / Facility';
    var removeBtn = isRemovable
      ? '<button type="button" class="remove-provider-btn" onclick="removeProvider(this)">Remove</button>'
      : '';

    return '<div class="provider-card" data-card-idx="' + idx + '">'
      + '<div class="provider-card-head">'
      + '<span class="provider-badge">' + esc(badge) + '</span>'
      + removeBtn
      + '</div>'
      + '<div class="field-row">'
      + '<div class="field"><label>Provider / facility name <span style="color:#b33a3a;">*</span></label>'
      + '<input type="text" class="p-name" placeholder="e.g. Northside Hospital" value="' + esc(defaults.name) + '"></div>'
      + '<div class="field"><label>Department</label>'
      + '<input type="text" class="p-dept" placeholder="e.g. Medical Records" value="' + esc(defaults.dept) + '"></div>'
      + '</div>'
      + '<div class="field-row"><div class="field"><label>Address</label>'
      + '<input type="text" class="p-addr" placeholder="Street, City, State ZIP" value="' + esc(defaults.address) + '"></div></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>Phone</label>'
      + '<input type="tel" class="p-phone" placeholder="(___) ___-____" value="' + esc(defaults.phone) + '"></div>'
      + '<div class="field"><label>Fax</label>'
      + '<input type="tel" class="p-fax" placeholder="(___) ___-____" value="' + esc(defaults.fax) + '"></div>'
      + '</div>'
      + '</div>';
  }

  function addProviderCard(defaults, isRemovable) {
    var container = document.getElementById('provider-cards-container');
    var div = document.createElement('div');
    div.innerHTML = buildProviderCard(defaults, isRemovable !== false);
    container.appendChild(div.firstChild);
  }

  // Exposed globally for onclick handler
  window.removeProvider = function (btn) {
    var card = btn.closest('.provider-card');
    if (card) card.parentNode.removeChild(card);
  };

  // Collect all provider cards into a JSON array
  function collectProviders() {
    var cards = document.querySelectorAll('#provider-cards-container .provider-card');
    var providers = [];
    cards.forEach(function (card) {
      var name = (card.querySelector('.p-name') || {}).value || '';
      if (!name.trim()) return; // skip blank cards
      providers.push({
        name:    name.trim(),
        dept:    ((card.querySelector('.p-dept')  || {}).value || '').trim(),
        address: ((card.querySelector('.p-addr')  || {}).value || '').trim(),
        phone:   ((card.querySelector('.p-phone') || {}).value || '').trim(),
        fax:     ((card.querySelector('.p-fax')   || {}).value || '').trim()
      });
    });
    return providers;
  }

  // "Add another provider" button
  document.getElementById('add-provider-btn').addEventListener('click', function () {
    addProviderCard({ label: 'Additional Provider' }, true);
  });


  // ── Token gate helpers ────────────────────────────────────────
  function validateToken(token, onSuccess, onFail) {
    fetch(INTAKE_GAS_URL + '?action=getData&token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.found) {
          patientData = data.data || {};
          onSuccess();
        } else {
          onFail('That code doesn\'t match any record. Please double-check and try again.');
        }
      })
      .catch(function () { onFail('Something went wrong. Please try again or call (404) 913-6705.'); });
  }

  function prefillForm() {
    if (!patientData) {
      // No patient data — still need at least one blank provider card
      addProviderCard({ label: 'Provider / Facility' }, false);
      document.getElementById('form-token').value = activeToken;
      document.getElementById('sigDate').value    = today;
      return;
    }

    // ── Section 1: Patient ───────────────────────────────────────
    var first = patientData['Client First Name'] || '';
    var last  = patientData['Client Last Name']  || '';
    var name  = (first + ' ' + last).trim();
    if (name) document.getElementById('patientName').value = name;

    var dob = patientData['Date of Birth'] || '';
    if (dob) {
      // GAS may return a Date object serialized as ISO string (e.g. "1964-10-05T04:00:00.000Z")
      // If it's not already MM/DD/YYYY, parse and reformat using UTC to avoid timezone shifts
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
        var d = new Date(dob);
        if (!isNaN(d.getTime())) {
          dob = String(d.getUTCMonth() + 1).padStart(2, '0') + '/'
              + String(d.getUTCDate()).padStart(2, '0') + '/'
              + d.getUTCFullYear();
        }
      }
      document.getElementById('patientDOB').value = dob;
    }

    var addr = String(patientData['Client Address'] || '');
    if (addr) document.getElementById('patientAddress').value = addr;

    var phone = String(patientData['Client Phone'] || '');
    if (phone && phone.indexOf('@') < 0) document.getElementById('patientPhone').value = phone;

    document.getElementById('form-token').value = activeToken;
    document.getElementById('sigDate').value    = today;

    // ── Section 2: Build provider cards from intake data ─────────
    var container = document.getElementById('provider-cards-container');
    container.innerHTML = '';
    providerCardCount   = 0;

    var sources = [];

    var pcpName     = String(patientData['PCP Name']     || '').trim();
    var pcpPractice = String(patientData['PCP Practice'] || '').trim();
    var pcpPhone    = String(patientData['PCP Phone']    || '').trim();
    if (pcpName || pcpPractice) {
      sources.push({
        label:   'Primary Care Physician',
        name:    pcpName || pcpPractice,
        dept:    pcpName && pcpPractice ? pcpPractice : '',
        address: '',
        phone:   pcpPhone,
        fax:     ''
      });
    }

    var spec1Name  = String(patientData['Specialist 1']       || '').trim();
    var spec1Phone = String(patientData['Specialist 1 Phone'] || '').trim();
    if (spec1Name) {
      sources.push({
        label:   'Specialist',
        name:    spec1Name,
        dept:    '',
        address: '',
        phone:   spec1Phone,
        fax:     ''
      });
    }

    // Specialist 2 — phone not captured in intake; patient enters it here
    var spec2Name = String(patientData['Specialist 2'] || '').trim();
    if (spec2Name) {
      sources.push({
        label:   'Specialist',
        name:    spec2Name,
        dept:    '',
        address: '',
        phone:   '', // intentionally blank — user fills in
        fax:     ''
      });
    }

    var hospital = String(patientData['Preferred Hospital'] || '').trim();
    if (hospital) {
      sources.push({
        label:   'Hospital / Facility',
        name:    hospital,
        dept:    '',
        address: '',
        phone:   '',
        fax:     ''
      });
    }

    if (sources.length === 0) {
      // Nothing in intake — give one blank card
      addProviderCard({ label: 'Provider / Facility' }, false);
    } else {
      sources.forEach(function (src, i) {
        // First card is not individually removable if it's the only one; rest are
        addProviderCard(src, true);
      });
    }
  }


  // ── Initial screen ────────────────────────────────────────────
  if (URL_TOKEN) {
    document.getElementById('form-token').value = activeToken;
    validateToken(
      URL_TOKEN,
      function () { show('screen-choice'); },
      function () { show('screen-choice'); }
    );
  } else {
    show('screen-gate');
  }


  // ── Gate: submit ──────────────────────────────────────────────
  var tokenInput  = document.getElementById('token-input');
  var tokenSubmit = document.getElementById('token-submit');
  var gateError   = document.getElementById('gate-error');

  tokenSubmit.addEventListener('click', function () {
    var token = tokenInput.value.trim();
    if (!token) return;
    tokenSubmit.disabled    = true;
    tokenSubmit.textContent = 'Checking…';
    gateError.style.display = 'none';

    validateToken(
      token,
      function () {
        activeToken = token;
        document.getElementById('form-token').value = token;
        show('screen-choice');
        tokenSubmit.disabled    = false;
        tokenSubmit.textContent = 'Continue';
      },
      function (msg) {
        gateError.textContent   = msg;
        gateError.style.display = 'block';
        tokenSubmit.disabled    = false;
        tokenSubmit.textContent = 'Continue';
      }
    );
  });

  tokenInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tokenSubmit.click();
  });


  // ── Choice: pick path ─────────────────────────────────────────
  document.getElementById('btn-choose-upload').addEventListener('click', function () {
    show('screen-upload');
  });

  document.getElementById('btn-choose-form').addEventListener('click', function () {
    prefillForm();
    show('screen-form');
    initSigCanvas(); // called after show() so the canvas has real dimensions
  });

  document.getElementById('back-from-upload').addEventListener('click', function () { show('screen-choice'); });
  document.getElementById('back-from-form').addEventListener('click',   function () { show('screen-choice'); });


  // ── Upload: file handling ─────────────────────────────────────
  var dropZone     = document.getElementById('drop-zone');
  var fileInput    = document.getElementById('roi-file-input');
  var uploadBtn    = document.getElementById('upload-btn');
  var fileBanner   = document.getElementById('file-banner');
  var uploadStatus = document.getElementById('upload-status');
  var selectedFile = null;

  dropZone.addEventListener('click', function () { fileInput.click(); });
  dropZone.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', function () { dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault(); dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () { if (this.files[0]) handleFile(this.files[0]); });
  uploadBtn.addEventListener('click', submitUpload);

  function handleFile(file) {
    if (['application/pdf','image/jpeg','image/jpg','image/png'].indexOf(file.type) === -1) {
      alert('Only PDF, JPG, and PNG files are accepted.'); return;
    }
    if (file.size > 10 * 1024 * 1024) { alert('File must be under 10 MB.'); return; }
    selectedFile = file;
    document.getElementById('file-name-display').textContent = file.name;
    fileBanner.style.display  = 'block';
    uploadBtn.disabled        = false;
    uploadStatus.textContent  = '';
  }

  function submitUpload() {
    if (!selectedFile || !activeToken) return;
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading…'; uploadStatus.textContent = '';
    var fd = new FormData();
    fd.append('token', activeToken);
    fd.append('roi_file', selectedFile, selectedFile.name);
    fetch(PAGE_URL, { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result && result.success) { show('screen-success'); }
        else {
          uploadStatus.textContent = (result && result.message) || 'Upload failed. Please try again.';
          uploadBtn.disabled = false; uploadBtn.textContent = 'Upload Document';
        }
      })
      .catch(function () {
        uploadStatus.textContent = 'Something went wrong. Please call (404) 913-6705.';
        uploadBtn.disabled = false; uploadBtn.textContent = 'Upload Document';
      });
  }


  // ── Online form: submit ───────────────────────────────────────
  var roiForm    = document.getElementById('roi-form');
  var formSubmit = document.getElementById('form-submit-btn');
  var formStatus = document.getElementById('form-status');

  roiForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!activeToken) { formStatus.textContent = 'Session error. Please refresh the page.'; return; }

    // Collect and validate providers
    var providers = collectProviders();
    if (providers.length === 0) {
      formStatus.textContent = 'Please add at least one provider before submitting.';
      return;
    }

    // Validate drawn signature, then capture to hidden field
    if (sigEmpty) {
      if (sigPadWrap) sigPadWrap.classList.add('sig-error');
      formStatus.textContent = 'Please draw your signature before submitting.';
      if (sigCanvas) sigCanvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (sigPadWrap) sigPadWrap.classList.remove('sig-error');
    document.getElementById('sigImage').value = sigCanvas.toDataURL('image/png');
    document.getElementById('sigName').value  = (document.getElementById('sigPrintedName') || {}).value || '';

    // Serialize providers into hidden field
    document.getElementById('providers-json').value = JSON.stringify(providers);

    var providerLabel = providers.length === 1
      ? 'Submitting…'
      : 'Generating ' + providers.length + ' authorizations…';
    formSubmit.disabled    = true;
    formSubmit.textContent = providerLabel;
    formStatus.textContent = '';

    var fd = new FormData(roiForm);
    fetch(PAGE_URL, { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result && result.success) { show('screen-success'); }
        else {
          formStatus.textContent = (result && result.message) || 'Submission failed. Please try again.';
          formSubmit.disabled    = false;
          formSubmit.textContent = 'Submit Authorization';
        }
      })
      .catch(function () {
        formStatus.textContent = 'Something went wrong. Please call (404) 913-6705.';
        formSubmit.disabled    = false;
        formSubmit.textContent = 'Submit Authorization';
      });
  });

})();
</script>

<?php get_footer(); ?>
