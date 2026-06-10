<?php
/**
 * Template Name: GFC Assessment & Intake Form
 */
$token = isset( $_GET['token'] ) ? sanitize_text_field( wp_unslash( $_GET['token'] ) ) : '';
get_header();
?>

<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">

<style>

  :root {
    --navy: #033D50;
    --navy-mid: #054f67;
    --gold: #F5CD85;
    --gold-muted: #f5e9cc;
    --cream: #FAF7F2;
    --white: #ffffff;
    --text: #1a2a32;
    --text-muted: #2d3e48;
    --border: #d8dfe3;
    --border-light: #eef1f3;
    --green: #2a7d5a;
    --green-light: #e8f5ef;
    --red: #9b2626;
    --red-light: #fdeaea;
  }

  .gfc-intake * { box-sizing: border-box; margin: 0; padding: 0; }

  .gfc-intake {
    font-family: 'DM Sans', sans-serif;
    background: var(--white);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
  }

  .gfc-intake .page { max-width: 100%; }

  /* HEADER */
  .gfc-intake .header {
    background: var(--navy);
    padding: 32px 48px 28px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 16px;
  }

  .gfc-intake .header-eyebrow {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.4px;
    color: var(--gold);
    margin-bottom: 8px;
  }

  .gfc-intake .header h1 {
    font-family: 'Cormorant Garamond', serif;
    font-size: 26px;
    font-weight: 600;
    color: var(--white);
    line-height: 1.2;
  }

  .gfc-intake .header-sub {
    font-size: 13px;
    color: rgba(255,255,255,0.5);
    margin-top: 6px;
    line-height: 1.5;
  }

  .gfc-intake .header-badge {
    background: var(--gold);
    color: var(--navy);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 5px 14px;
    border-radius: 2px;
    white-space: nowrap;
    align-self: flex-start;
  }

  /* PROGRESS BAR */
  .gfc-intake .progress-bar {
    background: var(--navy-mid);
    padding: 0 48px;
    display: flex;
    border-bottom: 1px solid rgba(245,205,133,0.15);
    overflow-x: auto;
  }

  .gfc-intake .progress-step {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px 12px 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: rgba(255,255,255,0.35);
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .gfc-intake .progress-step.active {
    color: var(--gold);
    border-bottom-color: var(--gold);
  }

  .gfc-intake .progress-step.done { color: rgba(255,255,255,0.6); }

  .gfc-intake .step-num {
    width: 20px; height: 20px;
    border-radius: 50%;
    background: rgba(255,255,255,0.1);
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .gfc-intake .progress-step.active .step-num { background: var(--gold); color: var(--navy); }
  .gfc-intake .progress-step.done .step-num { background: var(--green); color: white; }

  /* BODY */
  .gfc-intake .body { padding: 36px 48px 48px; }

  /* SECTION PAGES */
  .gfc-intake .intake-page { display: none !important; flex-direction: column; gap: 28px; }
  .gfc-intake .intake-page.active { display: flex !important; }

  /* SECTION */
  .gfc-intake .section {
    border: 1px solid var(--border-light);
    border-radius: 6px;
    overflow: hidden;
  }

  .gfc-intake .section-head {
    background: var(--navy);
    padding: 11px 20px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .gfc-intake .section-num {
    font-family: 'Cormorant Garamond', serif;
    font-size: 13px;
    color: rgba(245,205,133,0.45);
  }

  .gfc-intake .section-head h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--gold);
  }

  .gfc-intake .section-body {
    padding: 22px 20px;
    background: var(--white);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* FIELD */
  .gfc-intake .field { display: flex; flex-direction: column; gap: 6px; }

  .gfc-intake .field label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--text);
  }

  .gfc-intake .field-hint {
    font-size: 12px;
    color: #3a4a52;
    font-style: italic;
    margin-top: -3px;
  }

  .gfc-intake .field input[type="text"], .gfc-intake .field input[type="date"], .gfc-intake .field input[type="tel"], .gfc-intake .field input[type="email"], .gfc-intake .field select, .gfc-intake .field textarea {
    font-family: 'DM Sans', sans-serif;
    font-size: 13.5px;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 9px 12px;
    background: var(--cream);
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
  }

  .gfc-intake .field input:focus, .gfc-intake .field select:focus, .gfc-intake .field textarea:focus {
    border-color: var(--navy);
    background: var(--white);
  }

  .gfc-intake .field textarea { resize: vertical; min-height: 72px; line-height: 1.6; }

  /* GRIDS */
  .gfc-intake .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px; }
  .gfc-intake .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px 20px; }
  .gfc-intake .span-2 { grid-column: span 2; }
  .gfc-intake .span-3 { grid-column: span 3; }

  /* CHECKBOX GROUP */
  .gfc-intake .check-group { display: flex; flex-wrap: wrap; gap: 8px; }

  .gfc-intake .check-item {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--cream);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 7px 11px;
    cursor: pointer;
    font-size: 13px;
    user-select: none;
    transition: all 0.15s;
  }

  .gfc-intake .check-item:has(input:checked) {
    background: var(--navy);
    border-color: var(--navy);
    color: var(--white);
  }

  .gfc-intake .check-item input { width: 13px; height: 13px; accent-color: var(--gold); cursor: pointer; }

  /* DIVIDER */
  .gfc-intake .divider { height: 1px; background: var(--border-light); }

  /* MEDICATION ROW */
  .gfc-intake .med-row {
    display: grid;
    grid-template-columns: 2fr 1fr 2fr;
    gap: 10px;
    align-items: end;
    padding: 12px;
    background: var(--cream);
    border-radius: 6px;
    border: 1px solid var(--border-light);
    margin-bottom: 8px;
  }

  .gfc-intake .med-row:last-child { margin-bottom: 0; }

  .gfc-intake .add-row-btn {
    background: transparent;
    border: 1.5px dashed var(--border);
    border-radius: 4px;
    padding: 9px 16px;
    font-family: 'DM Sans', sans-serif;
    font-size: 12.5px;
    color: var(--text-muted);
    cursor: pointer;
    width: 100%;
    text-align: center;
    transition: all 0.15s;
    margin-top: 4px;
  }

  .gfc-intake .add-row-btn:hover { border-color: var(--navy); color: var(--navy); }

  /* CONSENT BLOCK */
  .gfc-intake .consent-block {
    background: var(--cream);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 18px 20px;
    font-size: 13px;
    color: var(--text);
    line-height: 1.7;
  }

  .gfc-intake .consent-block h3 {
    font-family: 'Cormorant Garamond', serif;
    font-size: 16px;
    font-weight: 600;
    color: var(--navy);
    margin-bottom: 10px;
  }

  .gfc-intake .consent-block p { margin-bottom: 10px; }
  .gfc-intake .consent-block p:last-child { margin-bottom: 0; }

  /* SIGNATURE LINE */
  .gfc-intake .sig-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 24px;
    align-items: end;
    margin-top: 8px;
  }

  .gfc-intake .sig-line {
    border-bottom: 1.5px solid var(--text);
    padding-bottom: 4px;
    min-height: 40px;
    background: transparent;
  }

  .gfc-intake .sig-label {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.7px;
    color: var(--text-muted);
    margin-top: 6px;
  }

  /* NAV BUTTONS */
  .gfc-intake .nav-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px 48px;
    background: var(--cream);
    border-top: 1px solid var(--border-light);
  }

  .gfc-intake .btn {
    font-family: 'DM Sans', sans-serif;
    font-size: 13px;
    font-weight: 600;
    border-radius: 4px;
    padding: 11px 28px;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .gfc-intake .btn-primary { background: var(--navy); color: var(--white); }
  .gfc-intake .btn-primary:hover { background: var(--navy-mid); }
  .gfc-intake .btn-secondary { background: transparent; color: var(--navy); border: 1.5px solid var(--navy); }
  .gfc-intake .btn-secondary:hover { background: var(--white); }
  .gfc-intake .btn-ghost { background: transparent; color: var(--text-muted); border: none; font-size: 13px; padding: 11px 0; }

  .gfc-intake .page-indicator {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
  }

  /* SUCCESS SCREEN */
  .gfc-intake .success-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 80px 40px;
    min-height: 400px;
  }


  .gfc-intake .success-icon {
    width: 64px; height: 64px;
    border-radius: 50%;
    background: var(--navy);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 24px;
  }

  .gfc-intake .success-screen h2 {
    font-family: 'Cormorant Garamond', serif;
    font-size: 28px;
    font-weight: 600;
    color: var(--navy);
    margin-bottom: 12px;
  }

  .gfc-intake .success-screen p {
    font-size: 14px;
    color: var(--text-muted);
    max-width: 440px;
    line-height: 1.6;
    margin-bottom: 8px;
  }

  .gfc-intake .success-contact {
    font-size: 13px;
    color: var(--navy);
    font-weight: 500;
    margin-top: 8px;
  }






  /* SIGNATURE — typed name + acknowledgment */
  .gfc-intake .sig-block {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px 18px;
    background: var(--cream);
  }
  .gfc-intake .sig-input {
    width: 100%;
    border: 1px solid var(--border);
    background: var(--white);
    padding: 14px 16px;
    font-family: 'Cormorant Garamond', serif;
    font-size: 22px;
    font-style: italic;
    color: var(--navy);
    border-radius: 4px;
  }
  .gfc-intake .sig-input:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
  .gfc-intake .sig-ack {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 12px;
    padding: 10px 12px;
    background: var(--white);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 13px;
    color: var(--text);
    line-height: 1.5;
  }
  .gfc-intake .sig-ack input[type="checkbox"] {
    margin-top: 3px;
    width: 16px;
    height: 16px;
    accent-color: var(--gold);
    flex-shrink: 0;
  }
  .gfc-intake .sig-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin-top: 10px;
  }


  /* Hide locked banners when in full intake mode (token or unlock code) */
  body.intake-mode .locked-banner,
  body.intake-unlocked .locked-banner { display: none !important; }

  /* LOCKED PREVIEW STEPS — assessment-mode progress bar */
  .gfc-intake .progress-step.locked-preview {
    opacity: 0.45;
    cursor: not-allowed;
    pointer-events: none;
  }
  .gfc-intake .progress-step.locked-preview .step-num {
    background: rgba(3,61,80,0.25);
    color: var(--white);
  }
  .gfc-intake .progress-step.locked-preview .lock-glyph {
    display: inline-block;
    width: 9px;
    height: 7px;
    background: rgba(255,255,255,0.4);
    border-radius: 1px;
    position: relative;
    margin: 0 4px -1px 2px;
    vertical-align: middle;
  }
  .gfc-intake .progress-step.locked-preview .lock-glyph::before {
    content: '';
    position: absolute;
    top: -4px;
    left: 1.5px;
    width: 6px;
    height: 5px;
    border: 1.5px solid rgba(255,255,255,0.4);
    border-bottom: none;
    border-radius: 2px 2px 0 0;
  }


  /* SECTION SUBHEADINGS — within a section */
  .gfc-intake .section-subhead {
    font-family: 'DM Sans', sans-serif;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--navy);
    padding: 12px 0 8px;
    border-bottom: 1px solid var(--border);
    margin: 16px 0 12px;
  }


  /* UNLOCK CODE INPUT — success screen */
  .gfc-intake #unlock-code-input:focus {
    border-color: var(--gold) !important;
    outline: 2px solid rgba(245,205,133,0.4) !important;
  }
  .gfc-intake #unlock-code-input::placeholder { color: #9aabb3; }

  /* PRIVACY GATE — first page client sees on returning with token */
  .gfc-intake .privacy-gate-intro {
    background: var(--navy);
    color: var(--white);
    padding: 28px 32px;
    border-radius: 8px;
    margin-bottom: 24px;
  }
  .gfc-intake .privacy-gate-intro h2 {
    font-family: 'Cormorant Garamond', serif;
    font-size: 22px;
    color: var(--gold);
    margin: 0 0 10px 0;
  }
  .gfc-intake .privacy-gate-intro p {
    color: rgba(255,255,255,0.92);
    font-size: 14px;
    line-height: 1.65;
    margin: 0 0 10px 0;
  }
  .gfc-intake .privacy-gate-intro p:last-child { margin-bottom: 0; }
  .gfc-intake .privacy-gate-intro a {
    color: var(--gold);
    text-decoration: underline;
    font-weight: 500;
  }
  .gfc-intake .privacy-link {
    color: var(--navy);
    text-decoration: underline;
    font-weight: 500;
  }
  .gfc-intake .privacy-notice a.privacy-link { color: var(--navy); }

  /* PRIVACY NOTICE — appears at top of pages that collect sensitive info */
  .gfc-intake .privacy-notice {
    display: flex !important;
    gap: 16px;
    align-items: flex-start;
    background: #fdf4dc;
    border: 1px solid var(--gold);
    border-left: 5px solid var(--gold);
    border-radius: 8px;
    padding: 18px 22px;
    margin-bottom: 4px;
    box-shadow: 0 2px 6px rgba(3,61,80,0.06);
  }
  .gfc-intake .privacy-icon {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    background: var(--navy);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .gfc-intake .privacy-icon svg { stroke: var(--gold) !important; }
  .gfc-intake .privacy-title {
    font-family: 'Cormorant Garamond', serif;
    font-size: 17px;
    font-weight: 600;
    color: var(--navy);
    margin: 0 0 6px 0;
    line-height: 1.3;
  }
  .gfc-intake .privacy-body {
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.65;
    margin: 0;
  }
  .gfc-intake .privacy-body a.privacy-link {
    color: var(--navy);
    text-decoration: underline;
    font-weight: 600;
  }


  /* HEADER STAGE BADGES — Assessment / Intake */
  .gfc-intake .header-stages {
    display: flex;
    gap: 6px;
    align-self: flex-start;
  }
  .gfc-intake .stage-badge {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 5px 14px;
    border-radius: 2px;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: all 0.2s;
  }
  .gfc-intake .stage-badge.active {
    background: var(--gold);
    color: var(--navy);
  }
  .gfc-intake .stage-badge.inactive {
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.5);
  }
  .gfc-intake .stage-badge.done {
    background: rgba(245,205,133,0.2);
    color: rgba(245,205,133,0.7);
  }
  .gfc-intake .stage-badge.done::before {
    content: '✓';
    font-size: 11px;
    font-weight: 800;
  }

  @media print {
    .gfc-intake .progress-bar, .gfc-intake .nav-row { display: none; }
    .gfc-intake .intake-page { display: flex !important; }
    .gfc-intake { background: white; }
  }

  @media (max-width: 680px) {
    .gfc-intake .grid-2, .gfc-intake .grid-3 { grid-template-columns: 1fr; }
    .gfc-intake .span-2, .gfc-intake .span-3 { grid-column: span 1; }
    .gfc-intake .body, .gfc-intake .header, .gfc-intake .nav-row { padding-left: 20px; padding-right: 20px; }
    .gfc-intake .sig-row { grid-template-columns: 1fr; }
    .gfc-intake .med-row { grid-template-columns: 1fr; }
  }

</style>

<script>
var PHP_INJECTED_TOKEN = '<?php echo esc_js( $token ); ?>';
</script>

<div class="gfc-intake">

<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div>
      <p class="header-eyebrow">Godwins Family Care LLC</p>
      <h1>Assessment &amp; Intake Form</h1>
      <p class="header-sub">Pages 1–4 are your free assessment — submit to start the conversation. Once our team connects with you, we'll send a personalized link to complete your full clinical intake and enrollment before care begins.</p>
    </div>
    <div class="header-stages">
      <span class="stage-badge" id="stage-assessment">Assessment</span>
      <span class="stage-badge" id="stage-intake">Intake</span>
    </div>
  </div>

  <!-- PROGRESS -->
  <div class="progress-bar" id="progress-bar">
    <!-- progress steps injected by buildProgressBar() -->
    </div>
  </div>

  <div class="body">

<!-- PAGE PRIV: PRIVACY POLICY + HIPAA ROI (intake mode only) -->
    <div class="intake-page" id="page-priv">

      <div class="privacy-gate-intro">
        <h2>Welcome back. One thing first.</h2>
        <p>Before we proceed with your full intake, please review and sign the privacy and HIPAA Release of Information below. This authorizes us to coordinate your loved one's care with the people you trust.</p>
        <p>Your previously submitted information is already saved and will populate automatically. You can also update or expand on what you shared earlier. <a href="/privacy-policy/" target="_blank">Read our full privacy policy</a>.</p>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">PR</span>
          <h2>HIPAA Release of Information (ROI)</h2>
        </div>
        <div class="section-body">
          <div class="consent-block">
            <h3>Authorization to Share Information</h3>
            <p>I authorize Godwins Family Care LLC to share relevant health and care information with the family members, emergency contacts, and medical providers listed in this intake form for the purpose of coordinating care and ensuring client safety.</p>
            <p>This authorization may be revoked in writing at any time and does not extend to any parties not listed in this document.</p>
          </div>
          <div class="field" style="margin-top:12px;">
            <label>Who is authorized to receive information about this client?</label>
            <p class="field-hint">List names and relationships of anyone we are authorized to speak with beyond the primary contact.</p>
            <textarea id="roiAuthorized" placeholder="e.g. Sarah Johnson (daughter), Marcus Williams (son), Dr. Patricia Lee (PCP)…"></textarea>
          </div>
          <div class="field">
            <label>Any restrictions on information sharing?</label>
            <textarea id="roiRestrictions" style="min-height:56px;" placeholder="e.g. Do not share information with [name], list any specific exclusions or limitations…"></textarea>
          </div>
          <div class="sig-block" style="margin-top: 16px;">
            <input type="text" class="sig-input" id="sig-roi-typed" placeholder="Type your full name to sign" autocomplete="off">
            <label class="sig-ack">
              <input type="checkbox" id="sig-roi-ack">
              <span>By typing my name above and checking this box, I am providing my electronic signature on this HIPAA Release of Information.</span>
            </label>
            <p class="sig-label">Client or Authorized Representative Signature, HIPAA ROI</p>
          </div>
          <div class="grid-2" style="margin-top:12px;">
            <div class="field">
              <label>Date</label>
              <input type="date" id="sigROIDate">
            </div>
            <div class="field">
              <label>Printed Name</label>
              <input type="text" id="sigROIName" placeholder="Print full name">
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- PAGE 1: ABOUT YOUR LOVED ONE -->
    <div class="intake-page active" id="page-0">
      <div class="privacy-notice">
        <div class="privacy-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="22" height="22"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div>
          <p class="privacy-title">Your information is confidential.</p>
          <p class="privacy-body">Anything you share is used only to match your loved one with the right care team. We never sell or disclose your information without your written consent. A formal HIPAA Release of Information will be reviewed and signed before any care begins. <a href="/privacy-policy/" target="_blank" class="privacy-link">Read our full privacy policy</a>.</p>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">01</span><h2>Client Demographics</h2>
        </div>
        <div class="section-body">
          <div class="grid-3">
            <div class="field">
              <label>Client First Name</label>
              <input type="text" id="clientFirst" placeholder="First name">
            </div>
            <div class="field">
              <label>Client Last Name</label>
              <input type="text" id="clientLast" placeholder="Last name">
            </div>
            <div class="field">
              <label>Preferred Name / Nickname</label>
              <input type="text" id="clientNickname" placeholder="What they like to be called">
            </div>
            
            <div class="field">
              <label>Age</label>
              <input type="text" id="age" placeholder="Years">
            </div>
            <div class="field">
              <label>Gender</label>
              <select id="gender">
                <option value="">Select</option>
                <option>Female</option>
                <option>Male</option>
                <option>Non-binary</option>
                <option>Prefer not to say</option>
              </select>
            </div>
            <div class="field span-3">
              <label>Home Address</label>
              <input type="text" id="clientAddress" placeholder="Street address, city, state, zip">
            </div>
            <div class="field">
              <label>Home Phone</label>
              <input type="tel" id="clientPhone" placeholder="Phone number">
            </div>
            <div class="field">
              <label>Lives With</label>
              <select id="livesWith">
                <option value="">Select</option>
                <option>Lives alone</option>
                <option>Spouse / partner</option>
                <option>Adult child</option>
                <option>Other family member</option>
                <option>Assisted living / memory care</option>
              </select>
            </div>
            <div class="field">
              <label>Primary Language</label>
              <input type="text" id="primaryLanguage" placeholder="e.g. English, Spanish">
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PAGE 2: YOUR INFO -->
    <div class="intake-page" id="page-1">

      <div class="section">
        <div class="section-head">
          <span class="section-num">02</span><h2>About You (Form Submitter)</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">Who is filling out this form today? This is who will receive a copy of the assessment and any follow-up from our team.</p>
          <div class="grid-2">
            <div class="field">
              <label>First Name</label>
              <input type="text" id="submitterFirst" placeholder="First name">
            </div>
            <div class="field">
              <label>Last Name</label>
              <input type="text" id="submitterLast" placeholder="Last name">
            </div>
            <div class="field">
              <label>Email Address</label>
              <input type="email" id="submitterEmail" placeholder="Your email">
            </div>
            <div class="field">
              <label>Phone Number</label>
              <input type="tel" id="submitterPhone" placeholder="Your phone number">
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">03</span><h2>Primary Family Contact</h2>
        </div>
        <div class="section-body">
          <div class="grid-3">
            <div class="field">
              <label>Full Name</label>
              <input type="text" id="contactName" placeholder="Full name">
            </div>
            <div class="field">
              <label>Relationship to Client</label>
              <select id="contactRelationship">
                <option value="">Select</option>
                <option>Spouse / Partner</option>
                <option>Adult child</option>
                <option>Sibling</option>
                <option>Legal guardian</option>
                <option>Other family member</option>
              </select>
            </div>
            <div class="field">
              <label>Phone (Cell preferred)</label>
              <input type="tel" id="contactPhone" placeholder="Best number">
            </div>
            <div class="field">
              <label>Email Address</label>
              <input type="email" id="contactEmail" placeholder="Best email">
            </div>
            
            <div class="field">
              <label>Best Way to Reach</label>
              <select id="contactPreference">
                <option value="">Select</option>
                <option>Phone call</option>
                <option>Text message</option>
                <option>Email</option>
              </select>
            </div>
            <div class="field span-3">
              <label>Is this person authorized to make care decisions on the client's behalf?</label>
              <select id="decisionAuthority">
                <option value="">Select</option>
                <option>Yes — has legal authority (POA / guardianship)</option>
                <option>Yes — family decision-maker, informal</option>
                <option>No — client makes their own decisions</option>
                <option>Shared — client and family decide together</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>

        <!-- PAGE 3: CARE SITUATION -->
    <div class="intake-page" id="page-2">

      <div class="privacy-notice">
        <div class="privacy-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="22" height="22"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div>
          <p class="privacy-title">Your information is confidential.</p>
          <p class="privacy-body">Anything you share is used only to match your loved one with the right care team. We never sell or disclose your information without your written consent. <a href="/privacy-policy/" target="_blank" class="privacy-link">Read our full privacy policy</a>.</p>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">05</span>
          <h2>Care Situation</h2>
        </div>
        <div class="section-body">

          <!-- SERVICE PATH SELECTOR -->
          <div class="field">
            <label>What kind of support are you looking for?</label>
            <p class="field-hint">Select the option that best describes what you need. We offer both and can help you figure it out.</p>
            <select id="servicePath">
              <option value="">Select...</option>
              <option value="Home Care">Home Care — daily living help, personal care, companionship, skilled nursing in the home</option>
              <option value="In-Home Primary Care">In-Home Primary Care — a nurse practitioner who provides medical visits, chronic disease and medication management at home</option>
              <option value="Both">Both home care and in-home primary care</option>
              <option value="Not sure">Not sure yet — help me figure out what fits</option>
            </select>
          </div>

          <!-- HOME CARE SCREENING -->
          <div class="section-subhead">Home Care Needs</div>
          <div class="field">
            <label>Level of help needed with daily activities</label>
            <select id="adlLevel">
              <option value="">Select...</option>
              <option value="Independent">Mostly independent</option>
              <option value="Some help">Needs help with a few things</option>
              <option value="A lot of help">Needs help with most things</option>
              <option value="Total assistance">Needs total assistance</option>
            </select>
          </div>
          <div class="field">
            <label>Types of personal care and home support needed</label>
            <p class="field-hint">Check all that apply.</p>
            <div class="check-grid">
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Companionship & socialization"> Companionship &amp; socialization</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Personal care / bathing / dressing"> Personal care / bathing / dressing</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Medication reminders"> Medication reminders</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Mobility & transfer assistance"> Mobility &amp; transfer assistance</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Meal preparation"> Meal preparation</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Transportation to appointments"> Transportation to appointments</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Overnight or 24/7 care"> Overnight or 24/7 care</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Memory care / dementia support"> Memory care / dementia support</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Skilled nursing at home"> Skilled nursing at home</label>
              <label class="check-item"><input type="checkbox" name="helpNeeded" value="Hospice or end-of-life support"> Hospice or end-of-life support</label>
            </div>
          </div>

          <!-- PRIMARY CARE SCREENING (equal weight) -->
          <div class="section-subhead">In-Home Primary Care Needs</div>
          <div class="field">
            <label>How difficult is it to get to in-office medical appointments?</label>
            <select id="appointmentAccessLite">
              <option value="">Select...</option>
              <option value="No difficulty">No difficulty</option>
              <option value="Somewhat difficult">Somewhat difficult but manages</option>
              <option value="Very difficult">Very difficult, often misses appointments</option>
              <option value="Cannot attend">Cannot attend in-office appointments</option>
            </select>
          </div>
          <div class="field">
            <label>Ongoing health conditions being managed</label>
            <p class="field-hint">Check all that apply. This is a general snapshot — full detail comes later.</p>
            <div class="check-grid">
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="Diabetes"> Diabetes</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="Heart condition / CHF"> Heart condition / CHF</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="COPD / breathing issues"> COPD / breathing issues</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="Dementia / Alzheimers"> Dementia / Alzheimer's</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="Stroke / neurological"> Stroke / neurological</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="Recent hospitalization"> Recent hospitalization</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="Multiple chronic conditions"> Multiple chronic conditions</label>
              <label class="check-item"><input type="checkbox" name="ongoingConditionsLite" value="None / generally healthy"> None / generally healthy</label>
            </div>
          </div>
          <div class="field">
            <label>Does the client currently have a primary care provider?</label>
            <select id="hasPCP">
              <option value="">Select...</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
              <option value="Unsure">Unsure</option>
            </select>
          </div>

          <!-- SHARED QUESTIONS -->
          <div class="section-subhead">About the Client</div>
          <div class="field">
            <label>Memory or cognition concerns</label>
            <select id="cognitionLevel">
              <option value="">Select...</option>
              <option value="None">No concerns</option>
              <option value="Mild">Mild forgetfulness</option>
              <option value="Moderate">Moderate memory issues / confusion</option>
              <option value="Significant">Significant cognitive decline / diagnosed dementia</option>
            </select>
          </div>
          <div class="field">
            <label>What&rsquo;s prompting you to reach out now?</label>
            <p class="field-hint">A recent fall, hospital stay, caregiver burnout, planning ahead. Whatever&rsquo;s on your mind.</p>
            <textarea id="mainReason" placeholder="Tell us what&rsquo;s going on..."></textarea>
          </div>

        </div>
      </div>

    </div>



        <!-- PAGE 4: SCHEDULE, PAYMENT & URGENCY -->
    <div class="intake-page" id="page-3">

      <div class="section">
        <div class="section-head">
          <span class="section-num">06</span>
          <h2>Schedule &amp; Service Level</h2>
        </div>
        <div class="section-body">
          <div class="grid-2">
            <div class="field">
              <label>Requested Start Date</label>
              <input type="date" id="freeStartDate">
            </div>
            <div class="field">
              <label>Hours Per Week (approx.)</label>
              <input type="number" id="freeHoursPerWeek" placeholder="e.g. 20" min="0">
            </div>
          </div>
          <div class="field">
            <label>How soon do you need care?</label>
            <select id="freeUrgency">
              <option value="">Select...</option>
              <option value="Immediately">Immediately (within days)</option>
              <option value="Within a week">Within a week</option>
              <option value="Within a month">Within a month</option>
              <option value="Just exploring">Just exploring options</option>
            </select>
          </div>
          <div class="field">
            <label>Preferred Days</label>
            <div class="check-grid">
              <label class="check-item"><input type="checkbox" name="freeShiftTime" value="Weekday mornings"> Weekday mornings</label>
              <label class="check-item"><input type="checkbox" name="freeShiftTime" value="Weekday afternoons"> Weekday afternoons</label>
              <label class="check-item"><input type="checkbox" name="freeShiftTime" value="Weekday evenings"> Weekday evenings</label>
              <label class="check-item"><input type="checkbox" name="freeShiftTime" value="Weekends"> Weekends</label>
              <label class="check-item"><input type="checkbox" name="freeShiftTime" value="Overnight"> Overnight</label>
              <label class="check-item"><input type="checkbox" name="freeShiftTime" value="24/7 continuous"> 24/7 continuous</label>
            </div>
          </div>
          <div class="field">
            <label>Recurring or One-Time?</label>
            <select id="freeRecurring">
              <option value="">Select...</option>
              <option value="Recurring">Recurring (ongoing schedule)</option>
              <option value="One-time">One-time or short-term</option>
              <option value="Not sure">Not sure yet</option>
            </select>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">07</span>
          <h2>Payment Expectation</h2>
        </div>
        <div class="section-body">
          <div class="field">
            <label>How do you expect to pay for care?</label>
            <p class="field-hint">A best guess is fine. We&rsquo;ll work through specifics together.</p>
            <select id="paymentExpectation">
              <option value="">Select...</option>
              <option value="Private pay">Private pay (out of pocket)</option>
              <option value="Insurance">Insurance</option>
              <option value="Medicaid">Medicaid</option>
              <option value="Medicare">Medicare</option>
              <option value="Combination">Combination</option>
              <option value="Not sure">Not sure yet</option>
            </select>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">08</span>
          <h2>Support Services of Interest</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">Beyond hands-on caregiving and primary care, which add-on services would be helpful? No commitment.</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="serviceInterests" value="Case management"> <span><strong>Case management</strong><br><span style="font-size:12px;color:#5a7080;">Help navigating doctors, services, paperwork, and family coordination</span></span></label>
            <label class="check-item"><input type="checkbox" name="serviceInterests" value="Behavioral health support"> <span><strong>Behavioral health support</strong><br><span style="font-size:12px;color:#5a7080;">Counseling, mental health support, mood and behavior care</span></span></label>
            <label class="check-item"><input type="checkbox" name="serviceInterests" value="Continuous Care Program"> <span><strong>Continuous Care Program</strong><br><span style="font-size:12px;color:#5a7080;">In-home video check-ins and a family communication portal</span></span></label>
            <label class="check-item"><input type="checkbox" name="serviceInterests" value="Not interested in add-on services"> Not interested in add-on services right now</label>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">09</span>
          <h2>How You&rsquo;re Doing</h2>
        </div>
        <div class="section-body">
          <div class="field">
            <label>How are you holding up right now?</label>
            <p class="field-hint">There&rsquo;s no wrong answer. This helps us understand how urgently you need support.</p>
            <select id="caregiverStress">
              <option value="">Select...</option>
              <option value="Managing fine">Managing fine, just planning ahead</option>
              <option value="Stretched thin">Stretched thin but coping</option>
              <option value="Overwhelmed">Overwhelmed, need help soon</option>
              <option value="Breaking point">At a breaking point</option>
            </select>
          </div>
          <div class="field">
            <label>Anything else we should know?</label>
            <textarea id="stressNotes" style="min-height:60px;" placeholder="Optional. Burnout, family disagreements, looming decisions, anything that gives us context."></textarea>
          </div>
        </div>
      </div>

    </div>



    <!-- PAGE 5: HOMEBOUND & MEDICAL STATUS -->
    <div class="intake-page" id="page-4">
      <div class="locked-banner">
        <div class="lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="20" height="20"><path d="M19 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <div class="lock-title">Section Locked</div>
          <div class="lock-body">Complete your free assessment to unlock this section. Once our team connects with you, we'll send a personalized link.</div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">08</span>
          <h2>Homebound Status</h2>
        </div>
        <div class="section-body">
          <div class="field">
            <label>Homebound status</label>
            <p class="field-hint">"Homebound" generally means leaving home requires considerable effort or assistance.</p>
            <select id="homebound">
              <option value="">Select...</option>
              <option value="Completely homebound">Completely homebound, rarely or never leaves</option>
              <option value="Leaves with assistance">Leaves home only with significant assistance</option>
              <option value="Leaves occasionally">Leaves occasionally with some difficulty</option>
              <option value="Independent">Leaves home independently</option>
            </select>
          </div>
          <div class="field">
            <label>How difficult is it to attend in-office medical appointments?</label>
            <select id="appointmentDifficulty">
              <option value="">Select...</option>
              <option value="Cannot attend">Cannot attend in-office appointments</option>
              <option value="Very difficult">Very difficult, often misses appointments</option>
              <option value="Somewhat difficult">Somewhat difficult but manages</option>
              <option value="No difficulty">No difficulty</option>
            </select>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">09</span>
          <h2>Recent Medical Activity</h2>
        </div>
        <div class="section-body">
          <div class="grid-2">
            <div class="field">
              <label>Last PCP Visit</label>
              <input type="text" id="lastPCPVisit" placeholder="e.g. Last month, March 2026">
            </div>
            <div class="field">
              <label>Last Hospitalization</label>
              <input type="text" id="lastHospitalization" placeholder="e.g. None in past year, Dec 2025">
            </div>
          </div>
          <div class="field">
            <label>ER Visits in Past 6 Months</label>
            <input type="number" id="erVisits6mo" placeholder="0" min="0">
          </div>
          <div class="field">
            <label>Currently Receiving</label>
            <p class="field-hint">Check all that apply.</p>
            <div class="check-grid">
              <label class="check-item"><input type="checkbox" name="currentServices" value="Home health"> Home health (Medicare-certified)</label>
              <label class="check-item"><input type="checkbox" name="currentServices" value="Hospice"> Hospice</label>
              <label class="check-item"><input type="checkbox" name="currentServices" value="Palliative care"> Palliative care</label>
              <label class="check-item"><input type="checkbox" name="currentServices" value="Skilled nursing (private)"> Skilled nursing (private)</label>
              <label class="check-item"><input type="checkbox" name="currentServices" value="Outpatient PT/OT"> Outpatient PT/OT</label>
              <label class="check-item"><input type="checkbox" name="currentServices" value="None"> None of the above</label>
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">10</span><h2>Medical Team</h2>
        </div>
        <div class="section-body">
          <div class="grid-3">
            <div class="field">
              <label>Primary Care Physician</label>
              <input type="text" id="pcpName" placeholder="Full name">
            </div>
            <div class="field">
              <label>Practice / Clinic Name</label>
              <input type="text" id="pcpPractice" placeholder="Practice or clinic">
            </div>
            <div class="field">
              <label>PCP Phone</label>
              <input type="tel" id="pcpPhone" placeholder="Office number">
            </div>
            <div class="field">
              <label>Specialist 1 (if applicable)</label>
              <input type="text" id="spec1Name" placeholder="Name and specialty">
            </div>
            <div class="field">
              <label>Specialist 1 Phone</label>
              <input type="tel" id="spec1Phone" placeholder="Office number">
            </div>
            <div class="field">
              <label>Specialist 2 (if applicable)</label>
              <input type="text" id="spec2Name" placeholder="Name and specialty">
            </div>
            <div class="field">
              <label>Preferred Hospital / ER</label>
              <input type="text" id="preferredHospital" placeholder="Hospital name and location">
            </div>
            <div class="field">
              <label>Preferred Pharmacy</label>
              <input type="text" id="preferredPharmacy" placeholder="Pharmacy name and location">
            </div>
            <div class="field">
              <label>Pharmacy Phone</label>
              <input type="tel" id="pharmacyPhone" placeholder="Phone number">
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">11</span>
          <h2>Home-Based Primary Care Interest</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">Which in-home medical services would interest the client and family?</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="In-home primary care visits"> In-home primary care visits</label>
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="Telehealth visits"> Telehealth visits</label>
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="Medication management"> Medication management</label>
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="Chronic disease management"> Chronic disease management</label>
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="Labs drawn at home"> Labs drawn at home</label>
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="Mobile imaging"> Mobile imaging</label>
            <label class="check-item"><input type="checkbox" name="hbpcInterests" value="Care coordination across providers"> Care coordination across providers</label>
          </div>
        </div>
      </div>
    </div>

    <!-- PAGE 6: CLINICAL COMPLEXITY & SKILLED NEEDS -->
    <div class="intake-page" id="page-5">
      <div class="locked-banner">
        <div class="lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="20" height="20"><path d="M19 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <div class="lock-title">Section Locked</div>
          <div class="lock-body">Complete your free assessment to unlock this section. Once our team connects with you, we'll send a personalized link.</div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">12</span><h2>Medical History & Diagnoses</h2>
        </div>
        <div class="section-body">
          <div class="field">
            <label>Primary Diagnoses</label>
            <p class="field-hint">List conditions that affect daily life or care needs.</p>
            <div class="check-group">
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Dementia / Alzheimer's"> Dementia / Alzheimer's</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Parkinson's disease"> Parkinson's disease</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Stroke / TIA"> Stroke / TIA</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Depression"> Depression</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Anxiety"> Anxiety</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="COPD / respiratory"> COPD / respiratory</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Heart failure / cardiac"> Heart failure / cardiac</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Diabetes"> Diabetes</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Cancer"> Cancer</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Arthritis"> Arthritis</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Osteoporosis"> Osteoporosis</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Renal disease"> Renal disease</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Bipolar disorder"> Bipolar disorder</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Schizophrenia"> Schizophrenia</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="PTSD"> PTSD</label>
              <label class="check-item"><input type="checkbox" name="diagnoses" value="Substance use history"> Substance use history</label>
            </div>
          </div>
          <div class="field">
            <label>Additional diagnoses or medical history</label>
            <textarea id="additionalDiagnoses" placeholder="Any other conditions, recent hospitalizations, surgeries, or relevant medical history…"></textarea>
          </div>
          <div class="divider"></div>
          <div class="grid-2">
            <div class="field">
              <label>Known Allergies</label>
              <textarea id="allergies" style="min-height:56px;" placeholder="Medications, foods, environmental — list all known allergies and reactions…"></textarea>
            </div>
            <div class="field">
              <label>DNR / Advance Directive on File?</label>
              <select id="dnr">
                <option value="">Select</option>
                <option>Yes — DNR in place</option>
                <option>Yes — advance directive / living will</option>
                <option>Yes — healthcare proxy / POA for healthcare</option>
                <option>No — none in place</option>
                <option>Unknown</option>
              </select>
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">13</span><h2>Current Medications</h2>
        </div>
        <div class="section-body">
          <p style="font-size:13px; color:var(--text-muted); margin-bottom:4px;">List all current medications. Caregivers provide reminders only — not administration.</p>
          <div id="med-list">
            <div class="med-row">
              <div class="field"><label>Medication Name</label><input type="text" placeholder="Name"></div>
              <div class="field"><label>Dosage</label><input type="text" placeholder="e.g. 10mg"></div>
              <div class="field"><label>Frequency / Time</label><input type="text" placeholder="e.g. Once daily, morning"></div>
            </div>
            <div class="med-row">
              <div class="field"><label>Medication Name</label><input type="text" placeholder="Name"></div>
              <div class="field"><label>Dosage</label><input type="text" placeholder="e.g. 10mg"></div>
              <div class="field"><label>Frequency / Time</label><input type="text" placeholder="e.g. Twice daily"></div>
            </div>
            <div class="med-row">
              <div class="field"><label>Medication Name</label><input type="text" placeholder="Name"></div>
              <div class="field"><label>Dosage</label><input type="text" placeholder="e.g. 10mg"></div>
              <div class="field"><label>Frequency / Time</label><input type="text" placeholder="e.g. As needed"></div>
            </div>
          </div>
          <button class="add-row-btn" onclick="addMedRow()">+ Add another medication</button>
          <div class="field" style="margin-top:8px;">
            <label>Additional medication notes</label>
            <textarea id="medNotes" style="min-height:56px;" placeholder="Self-administers vs. needs reminders, refill frequency, special instructions…"></textarea>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">14</span>
          <h2>Skilled Care Needs</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">Does the client currently require or receive any of these? Check all that apply.</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Wound care"> Wound care</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Injections"> Injections</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Catheter care"> Catheter care</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Ostomy care"> Ostomy care</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Tube feeding"> Tube feeding</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Oxygen management"> Oxygen management</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Suctioning"> Suctioning</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Tracheostomy care"> Tracheostomy care</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="IV therapy"> IV therapy</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Blood glucose monitoring"> Blood glucose monitoring</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Blood pressure monitoring"> Blood pressure monitoring</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Medication administration"> Medication administration</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Behavioral supervision"> Behavioral supervision</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="Seizure monitoring"> Seizure monitoring</label>
            <label class="check-item"><input type="checkbox" name="skilledTasks" value="None"> None of the above</label>
          </div>
          <div class="field" style="margin-top:14px;">
            <label>Who currently performs these tasks?</label>
            <textarea id="skilledTasksProvider" style="min-height:60px;" placeholder="Family member, current home health agency, self, hospice nurse..."></textarea>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">15</span>
          <h2>Recent Clinical Events</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">Check all that apply in the past 30-90 days.</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="recentEvents" value="Hospitalized in past 30 days"> Hospitalized in past 30 days</label>
            <label class="check-item"><input type="checkbox" name="recentEvents" value="SNF or rehab stay in past 90 days"> SNF or rehab stay in past 90 days</label>
            <label class="check-item"><input type="checkbox" name="recentEvents" value="Recent falls"> Recent falls</label>
            <label class="check-item"><input type="checkbox" name="recentEvents" value="Recent infections"> Recent infections (UTI, pneumonia, etc.)</label>
            <label class="check-item"><input type="checkbox" name="recentEvents" value="New medications since discharge"> New medications since discharge</label>
            <label class="check-item"><input type="checkbox" name="recentEvents" value="Difficulty following discharge instructions"> Difficulty following discharge instructions</label>
            <label class="check-item"><input type="checkbox" name="recentEvents" value="Concern for readmission"> Concern for readmission</label>
          </div>
        </div>
      </div>
    </div>

    <!-- PAGE 7: FUNCTION, SAFETY & HOME ENVIRONMENT -->
    <div class="intake-page" id="page-6">
      <div class="locked-banner">
        <div class="lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="20" height="20"><path d="M19 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <div class="lock-title">Section Locked</div>
          <div class="lock-body">Complete your free assessment to unlock this section. Once our team connects with you, we'll send a personalized link.</div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">16</span><h2>Activities of Daily Living (ADL)</h2>
        </div>
        <div class="section-body">
          <p style="font-size:13px; color:var(--text-muted);">For each area, indicate the level of assistance needed.</p>
          <div class="grid-2" style="margin-top:8px;">
            <div class="field"><label>Bathing / Showering</label>
              <select id="adlBathing"><option value="">Select</option><option>Independent</option><option>Needs verbal cues</option><option>Needs physical assistance</option><option>Fully dependent</option></select>
            </div>
            <div class="field"><label>Dressing</label>
              <select id="adlDressing"><option value="">Select</option><option>Independent</option><option>Needs verbal cues</option><option>Needs physical assistance</option><option>Fully dependent</option></select>
            </div>
            <div class="field"><label>Grooming (hair, teeth, nails)</label>
              <select id="adlGrooming"><option value="">Select</option><option>Independent</option><option>Needs verbal cues</option><option>Needs physical assistance</option><option>Fully dependent</option></select>
            </div>
            <div class="field"><label>Toileting</label>
              <select id="adlToileting"><option value="">Select</option><option>Independent</option><option>Needs verbal cues</option><option>Needs physical assistance</option><option>Incontinent — needs full care</option></select>
            </div>
            <div class="field"><label>Transferring (bed, chair, car)</label>
              <select id="adlTransfers"><option value="">Select</option><option>Independent</option><option>Standby assist</option><option>Hands-on assist</option><option>Two-person assist / mechanical lift</option></select>
            </div>
            <div class="field"><label>Ambulation / Walking</label>
              <select id="adlWalking"><option value="">Select</option><option>Independent</option><option>Uses walker / cane</option><option>Needs physical assistance</option><option>Wheelchair — self-propels</option><option>Wheelchair — pushed by caregiver</option><option>Bed-bound</option></select>
            </div>
            <div class="field"><label>Eating / Feeding</label>
              <select id="adlEating"><option value="">Select</option><option>Independent</option><option>Needs setup / cues</option><option>Needs physical assistance</option><option>Fully dependent</option></select>
            </div>
            <div class="field"><label>Fall Risk</label>
              <select id="fallRisk"><option value="">Select</option><option>Low — no recent falls</option><option>Moderate — one fall in past year</option><option>High — multiple falls or near-falls</option></select>
            </div>
          </div>
          <div class="field">
            <label>Mobility equipment at home</label>
            <div class="check-group">
              <label class="check-item"><input type="checkbox" name="equipment" value="Walker"> Walker</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Cane"> Cane</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Wheelchair"> Wheelchair</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Hoyer lift"> Hoyer lift</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Hospital bed"> Hospital bed</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Grab bars"> Grab bars</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Shower chair"> Shower chair</label>
              <label class="check-item"><input type="checkbox" name="equipment" value="Stair lift"> Stair lift</label>
            </div>
          </div>
          <div class="field">
            <label>Additional ADL notes</label>
            <textarea id="adlNotes" placeholder="Anything caregivers need to know — weight, strength, specific techniques, behavioral responses to care…"></textarea>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">17</span><h2>Instrumental ADLs & Home Support</h2>
        </div>
        <div class="section-body">
          <div class="field">
            <label>Which tasks does your loved one need help with?</label>
            <div class="check-group">
              <label class="check-item"><input type="checkbox" name="iadl" value="Meal preparation"> Meal preparation</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Grocery shopping"> Grocery shopping</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Light housekeeping"> Light housekeeping</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Laundry"> Laundry</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Medication reminders"> Medication reminders</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Transportation to appointments"> Transportation to appointments</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Errands"> Errands</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Companionship"> Companionship</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Phone / technology help"> Phone / technology help</label>
              <label class="check-item"><input type="checkbox" name="iadl" value="Managing mail / paperwork"> Managing mail / paperwork</label>
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>Dietary needs or restrictions</label>
              <input type="text" id="dietary" placeholder="e.g. diabetic diet, low sodium, soft foods, texture modified">
            </div>
            <div class="field">
              <label>Food allergies</label>
              <input type="text" id="foodAllergies" placeholder="e.g. nuts, shellfish, dairy">
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">18</span><h2>Behavioral & Cognitive Status</h2>
        </div>
        <div class="section-body">
          <div class="grid-2">
            <div class="field">
              <label>Cognitive Status</label>
              <select id="cognitiveStatus">
                <option value="">Select</option>
                <option>Intact — no known concerns</option>
                <option>Mild impairment — occasional forgetfulness</option>
                <option>Moderate dementia — needs redirection</option>
                <option>Severe dementia — requires full support</option>
                <option>Mental health diagnosis affecting cognition</option>
              </select>
            </div>
            <div class="field">
              <label>Dementia Stage (if applicable)</label>
              <select id="dementiaStage">
                <option value="">Not applicable</option>
                <option>Early / mild</option>
                <option>Moderate</option>
                <option>Late / severe</option>
                <option>Unknown / undiagnosed</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Behavioral concerns</label>
            <div class="check-group">
              <label class="check-item"><input type="checkbox" name="behavioral" value="Wandering"> Wandering</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Agitation / aggression"> Agitation / aggression</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Sundowning"> Sundowning</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Sleep disturbances"> Sleep disturbances</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Hallucinations"> Hallucinations</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Mood swings"> Mood swings</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Resistance to care"> Resistance to care</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Self-harm risk"> Self-harm risk</label>
              <label class="check-item"><input type="checkbox" name="behavioral" value="Suicidal ideation history"> Suicidal ideation history</label>
            </div>
          </div>
          <div class="field">
            <label>Behavioral notes — triggers, patterns, what helps</label>
            <textarea id="behavioralNotes" placeholder="What tends to cause distress? What calms them down? Any known triggers we should know before sending a caregiver in…"></textarea>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">19</span>
          <h2>Six-Month Functional Risk</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">In the past 6 months, has the client experienced any of these? Check all that apply.</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Fallen"> Fallen</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Wandered from home"> Wandered from home</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Been hospitalized"> Been hospitalized</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Significant weight loss"> Significant weight loss</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Missed medications"> Missed medications</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Left stove or appliances running"> Left stove or appliances running</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Become aggressive"> Become aggressive</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Missed important appointments"> Missed important appointments</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="Experienced dehydration"> Experienced dehydration</label>
            <label class="check-item"><input type="checkbox" name="functionalRisk6mo" value="None of the above"> None of the above</label>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">20</span>
          <h2>Home Environment & Staff Safety</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">These help us plan staffing safely. Check all that apply.</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Smokers in home"> Smokers in home</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Pets in home"> Pets in home</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Firearms in home"> Firearms in home</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Hoarding or clutter concerns"> Hoarding or clutter concerns</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Pest issues"> Pest issues (bed bugs, roaches, mice)</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Stairs required to access living areas"> Stairs required to access living areas</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Oxygen tanks in home"> Oxygen tanks in home</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Working utilities"> Working utilities (heat, water, power)</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="Other household members with substance use"> Other household members with substance use</label>
            <label class="check-item"><input type="checkbox" name="homeSafety" value="None of the above"> None of the above</label>
          </div>
          <div class="field" style="margin-top:14px;">
            <label>Does any task require a two-person assist?</label>
            <select id="twoPersonAssist">
              <option value="">Select...</option>
              <option value="No">No</option>
              <option value="Sometimes">Sometimes (transfers, bathing)</option>
              <option value="Yes routinely">Yes, routinely</option>
            </select>
          </div>
          <div class="field">
            <label>Anything else that could affect staff safety in this home?</label>
            <textarea id="staffSafetyConcerns" style="min-height:60px;" placeholder="Aggressive family members, neighborhood concerns, anything to know before our team enters."></textarea>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">21</span>
          <h2>Decision-Making & Legal Status</h2>
        </div>
        <div class="section-body">
          <div class="field">
            <label>Who makes healthcare and care decisions for the client?</label>
            <select id="decisionMaking">
              <option value="">Select...</option>
              <option value="Client independently">Client makes own decisions independently</option>
              <option value="Shared with family">Shared between client and family</option>
              <option value="Surrogate decision-maker">A surrogate decision-maker is needed</option>
              <option value="Capacity concerns">Capacity concerns, decisions made by family/POA</option>
            </select>
          </div>
          <div class="field">
            <label>Legal Status</label>
            <p class="field-hint">Check all that apply. We'll request documentation later.</p>
            <div class="check-grid">
              <label class="check-item"><input type="checkbox" name="legalDocs" value="Healthcare POA activated"> Healthcare POA activated</label>
              <label class="check-item"><input type="checkbox" name="legalDocs" value="Financial POA activated"> Financial POA activated</label>
              <label class="check-item"><input type="checkbox" name="legalDocs" value="Guardianship"> Guardianship (court-appointed)</label>
              <label class="check-item"><input type="checkbox" name="legalDocs" value="Healthcare surrogate designated"> Healthcare surrogate designated</label>
              <label class="check-item"><input type="checkbox" name="legalDocs" value="Advance directive"> Advance directive on file</label>
              <label class="check-item"><input type="checkbox" name="legalDocs" value="None"> None in place</label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PAGE 8: EMERGENCY CONTACTS & CAREGIVER MATCH -->
    <div class="intake-page" id="page-7">
      <div class="locked-banner">
        <div class="lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="20" height="20"><path d="M19 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <div class="lock-title">Section Locked</div>
          <div class="lock-body">Complete your free assessment to unlock this section. Once our team connects with you, we'll send a personalized link.</div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">22</span><h2>Emergency Contact 1</h2>
        </div>
        <div class="section-body">
          <div class="grid-3">
            <div class="field">
              <label>Full Name</label>
              <input type="text" id="ec1Name" placeholder="Full name">
            </div>
            <div class="field">
              <label>Relationship to Client</label>
              <input type="text" id="ec1Relationship" placeholder="e.g. Daughter, Son, Neighbor">
            </div>
            <div class="field">
              <label>Phone</label>
              <input type="tel" id="ec1Phone" placeholder="Best number">
            </div>
            <div class="field">
              <label>Email</label>
              <input type="email" id="ec1Email" placeholder="Email (optional)">
            </div>
            <div class="field">
              <label>Address</label>
              <input type="text" id="ec1Address" placeholder="City, state at minimum">
            </div>
            <div class="field">
              <label>Alternate Phone</label>
              <input type="tel" id="ec1AltPhone" placeholder="Secondary number">
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">23</span><h2>Emergency Contact 2</h2>
        </div>
        <div class="section-body">
          <div class="grid-3">
            <div class="field">
              <label>Full Name</label>
              <input type="text" id="ec2Name" placeholder="Full name">
            </div>
            <div class="field">
              <label>Relationship to Client</label>
              <input type="text" id="ec2Relationship" placeholder="e.g. Son, Friend, Neighbor">
            </div>
            <div class="field">
              <label>Phone</label>
              <input type="tel" id="ec2Phone" placeholder="Best number">
            </div>
            <div class="field">
              <label>Email</label>
              <input type="email" id="ec2Email" placeholder="Email (optional)">
            </div>
            <div class="field">
              <label>Address</label>
              <input type="text" id="ec2Address" placeholder="City, state at minimum">
            </div>
            <div class="field">
              <label>Alternate Phone</label>
              <input type="tel" id="ec2AltPhone" placeholder="Secondary number">
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">24</span><h2>Caregiver Matching Preferences</h2>
        </div>
        <div class="section-body">
          <div class="grid-2">
            <div class="field">
              <label>Client's personality</label>
              <div class="check-group">
                <label class="check-item"><input type="checkbox" name="personality" value="Quiet and reserved"> Quiet and reserved</label>
                <label class="check-item"><input type="checkbox" name="personality" value="Warm and chatty"> Warm and chatty</label>
                <label class="check-item"><input type="checkbox" name="personality" value="Likes structure and routine"> Likes structure and routine</label>
                <label class="check-item"><input type="checkbox" name="personality" value="Prefers independence"> Prefers independence</label>
                <label class="check-item"><input type="checkbox" name="personality" value="Can get anxious"> Can get anxious</label>
                <label class="check-item"><input type="checkbox" name="personality" value="Resistant to care"> Resistant to care</label>
              </div>
            </div>
            <div class="field">
              <label>Gender preference for caregiver</label>
              <select id="genderPref">
                <option value="">No preference</option>
                <option>Female caregiver preferred</option>
                <option>Male caregiver preferred</option>
                <option>Female — strong preference</option>
                <option>Male — strong preference</option>
              </select>
            </div>
            <div class="field">
              <label>Language / cultural preferences</label>
              <input type="text" id="languagePref" placeholder="e.g. English only, Spanish preferred">
            </div>
            <div class="field">
              <label>Caregiver experience required</label>
              <select id="caregiverExp">
                <option value="">No specific requirement</option>
                <option>Entry-level OK — straightforward care</option>
                <option>Some experience preferred</option>
                <option>Experienced — complex ADL / transfers</option>
                <option>Dementia-trained required</option>
                <option>Behavioral support certified required</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Interests, hobbies, and things that bring comfort</label>
              <textarea id="clientInterests" placeholder="Music, TV shows, hobbies, foods they love, routines that matter — this helps us find a caregiver who connects with them as a person…"></textarea>
            </div>
            <div class="field span-2">
              <label>Past caregiver experience — what worked, what didn't</label>
              <textarea id="pastCaregiver" placeholder="Any prior home care, facility care, or family caregiving experiences worth noting…"></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PAGE 9: INSURANCE & PAYMENT DETAIL -->
    <div class="intake-page" id="page-8">
      <div class="locked-banner">
        <div class="lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="20" height="20"><path d="M19 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <div class="lock-title">Section Locked</div>
          <div class="lock-body">Complete your free assessment to unlock this section. Once our team connects with you, we'll send a personalized link.</div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">25</span>
          <h2>Date of Birth & Identification</h2>
        </div>
        <div class="section-body">
          <div class="grid-2">
            <div class="field">
              <label>Client Date of Birth</label>
              <input type="date" id="dob">
            </div>
            <div class="field">
              <label>Client Social Security Number (last 4 only)</label>
              <p class="field-hint">Optional. Used only for insurance verification.</p>
              <input type="text" id="ssnLast4" maxlength="4" placeholder="Last 4 digits">
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span class="section-num">26</span>
          <h2>Insurance Coverage Detail</h2>
        </div>
        <div class="section-body">
          <p class="field-hint" style="margin-top:0;">Check all that apply, then fill in the detail fields below for each active coverage. We'll collect card images separately during enrollment.</p>
          <div class="check-grid">
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Medicare Part A & B"> Medicare Part A &amp; B</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Medicare Advantage"> Medicare Advantage</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Medicaid"> Medicaid</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Dual eligible (Medicare + Medicaid)"> Dual eligible (Medicare + Medicaid)</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="VA benefits"> VA benefits</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Commercial insurance"> Commercial insurance</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Managed care organization"> Managed care organization</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Long-term care insurance"> Long-term care insurance</label>
            <label class="check-item"><input type="checkbox" name="insuranceTypes" value="Private pay only"> Private pay only</label>
          </div>

          <div class="section-subhead" style="margin-top:20px;">Medicare</div>
          <div class="grid-3">
            <div class="field">
              <label>Medicare ID / Beneficiary Number</label>
              <input type="text" id="medicareId" placeholder="e.g. 1EG4-TE5-MK72">
            </div>
            <div class="field">
              <label>Medicare Type</label>
              <select id="medicareType">
                <option value="">Select</option>
                <option>Part A &amp; B (Original Medicare)</option>
                <option>Medicare Advantage (Part C)</option>
                <option>Dual eligible (Medicare + Medicaid)</option>
                <option>Not applicable</option>
              </select>
            </div>
            <div class="field">
              <label>Medicare Advantage Plan Name</label>
              <input type="text" id="medicareAdvantagePlan" placeholder="e.g. Humana Gold Plus, AARP UnitedHealthcare">
            </div>
            <div class="field">
              <label>Medicare Advantage Member ID</label>
              <input type="text" id="medicareAdvMemberId" placeholder="Member ID on plan card">
            </div>
            <div class="field">
              <label>Medicare Advantage Group Number</label>
              <input type="text" id="medicareAdvGroupNum" placeholder="Group number on plan card">
            </div>
            <div class="field">
              <label>Medicare Part D (Prescription) Plan</label>
              <input type="text" id="medicarePartD" placeholder="Plan name if separate from Advantage">
            </div>
          </div>

          <div class="section-subhead" style="margin-top:20px;">Medicaid</div>
          <div class="grid-3">
            <div class="field">
              <label>Medicaid Member ID</label>
              <input type="text" id="medicaidMemberId" placeholder="Medicaid ID number">
            </div>
            <div class="field">
              <label>Medicaid Managed Care Plan</label>
              <input type="text" id="medicaidPlan" placeholder="e.g. Peach State, Amerigroup, WellCare">
            </div>
            <div class="field">
              <label>Medicaid Waiver Program</label>
              <select id="medicaidWaiver">
                <option value="">Select if applicable</option>
                <option>CCSP (Community Care Services Program)</option>
                <option>ICWP (Independent Care Waiver Program)</option>
                <option>SOURCE</option>
                <option>Katie Beckett</option>
                <option>Other waiver</option>
                <option>Not on a waiver</option>
              </select>
            </div>
            <div class="field">
              <label>Medicaid Case Manager Name</label>
              <input type="text" id="medicaidCaseManager" placeholder="Name and agency if known">
            </div>
            <div class="field">
              <label>Medicaid Case Manager Phone</label>
              <input type="tel" id="medicaidCaseManagerPhone" placeholder="Phone number">
            </div>
          </div>

          <div class="section-subhead" style="margin-top:20px;">Commercial Insurance</div>
          <div class="grid-3">
            <div class="field">
              <label>Insurance Carrier</label>
              <input type="text" id="commercialCarrier" placeholder="e.g. Blue Cross, Aetna, Cigna, UnitedHealthcare">
            </div>
            <div class="field">
              <label>Plan Name</label>
              <input type="text" id="commercialPlanName" placeholder="Plan or product name">
            </div>
            <div class="field">
              <label>Member ID</label>
              <input type="text" id="commercialMemberId" placeholder="Member ID on insurance card">
            </div>
            <div class="field">
              <label>Group Number</label>
              <input type="text" id="commercialGroupNum" placeholder="Group number on insurance card">
            </div>
            <div class="field">
              <label>Policy Holder Name</label>
              <input type="text" id="commercialPolicyHolder" placeholder="Name on the policy">
            </div>
            <div class="field">
              <label>Policy Holder Date of Birth</label>
              <input type="date" id="commercialPolicyHolderDob">
            </div>
            <div class="field">
              <label>Policy Holder Relationship to Client</label>
              <select id="commercialPolicyHolderRel">
                <option value="">Select</option>
                <option>Self</option>
                <option>Spouse</option>
                <option>Parent</option>
                <option>Child</option>
                <option>Other</option>
              </select>
            </div>
            <div class="field">
              <label>Insurance Phone (Member Services)</label>
              <input type="tel" id="commercialInsPhone" placeholder="Number on back of card">
            </div>
            <div class="field">
              <label>Home Health / Personal Care Benefit</label>
              <select id="commercialHomeBenefit">
                <option value="">Select</option>
                <option>Covered — verified</option>
                <option>Covered — unverified</option>
                <option>Not covered</option>
                <option>Unknown</option>
              </select>
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">27</span><h2>Payment Method</h2>
        </div>
        <div class="section-body">
          <div class="grid-2">
            <div class="field">
              <label>Primary Payment Method</label>
              <input type="text" id="paymentMethod" placeholder="e.g. Private pay, Medicaid, LTC insurance, VA benefits, Combination…">
            </div>
            <div class="field">
              <label>Billing Contact (if different from family contact)</label>
              <input type="text" id="billingContact" placeholder="Name and phone or email">
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">28</span><h2>Long-Term Care Insurance</h2>
        </div>
        <div class="section-body">
          <div class="grid-3">
            <div class="field">
              <label>LTC Insurance Carrier</label>
              <select id="ltcCarrier">
                <option value="">Select or type below</option>
                <option>Genworth</option>
                <option>Mutual of Omaha</option>
                <option>Northwestern Mutual</option>
                <option>John Hancock</option>
                <option>Transamerica</option>
                <option>Other</option>
                <option>Not applicable</option>
              </select>
            </div>
            <div class="field">
              <label>Other Carrier Name</label>
              <input type="text" id="ltcCarrierOther" placeholder="If not listed above">
            </div>
            <div class="field">
              <label>Policy Number</label>
              <input type="text" id="ltcPolicyNum" placeholder="Policy number">
            </div>
            <div class="field">
              <label>Policy Holder Name</label>
              <input type="text" id="ltcPolicyHolder" placeholder="Name on the policy">
            </div>
            <div class="field">
              <label>Daily / Monthly Benefit Amount</label>
              <input type="text" id="ltcBenefit" placeholder="e.g. $150/day or $4,500/month">
            </div>
            <div class="field">
              <label>Elimination Period</label>
              <input type="text" id="ltcElimination" placeholder="e.g. 90 days">
            </div>
            <div class="field span-3">
              <label>LTC Insurance Notes</label>
              <textarea id="ltcNotes" style="min-height:56px;" placeholder="Benefit status, prior authorizations, anything relevant to claims processing…"></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- PAGE 10: CONSENT & AUTHORIZATION -->
    <div class="intake-page" id="page-9">
      <div class="locked-banner">
        <div class="lock-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2" width="20" height="20"><path d="M19 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <div class="lock-title">Section Locked</div>
          <div class="lock-body">Complete your free assessment to unlock this section. Once our team connects with you, we'll send a personalized link.</div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">29</span><h2>Service Agreement Acknowledgment</h2>
        </div>
        <div class="section-body">
          <div class="consent-block">
            <h3>Scope of Services</h3>
            <p>Godwins Family Care LLC provides non-medical personal care services only. Our caregivers are trained to observe and report health changes to the family and medical team but do not provide skilled nursing, medication administration, clinical assessments, or therapeutic services.</p>
            <p>Care plans are developed in collaboration with the family and reviewed periodically. Changes to the client's condition or care needs should be reported to Godwins Family Care promptly so that the care plan can be updated accordingly.</p>
          </div>
          <div class="sig-block" style="margin-top: 16px;">
            <input type="text" class="sig-input" id="sig-service-typed" placeholder="Type your full name to sign" autocomplete="off">
            <label class="sig-ack">
              <input type="checkbox" id="sig-service-ack">
              <span>By typing my name above and checking this box, I am providing my electronic signature on this Service Agreement.</span>
            </label>
            <p class="sig-label">Client or Authorized Representative Signature, Service Agreement</p>
          </div>
          <div class="grid-2" style="margin-top:12px;">
            <div class="field">
              <label>Date</label>
              <input type="date" id="sigServiceDate">
            </div>
            <div class="field">
              <label>Printed Name</label>
              <input type="text" id="sigServiceName" placeholder="Print full name">
            </div>
          </div>
        </div>
      </div>

<div class="section">
        <div class="section-head">
          <span class="section-num">30</span><h2>Emergency & Crisis Protocol Authorization</h2>
        </div>
        <div class="section-body">
          <div class="consent-block">
            <p>In the event of a medical or behavioral emergency, Godwins Family Care caregivers are authorized to call 911 or 988 (Suicide & Crisis Lifeline) as appropriate, and will immediately notify the primary family contact. Caregivers will follow established safety protocols and document all incidents.</p>
          </div>
          <div class="grid-2" style="margin-top:12px;">
            <div class="field">
              <label>Call 911 in a medical emergency?</label>
              <select id="auth911">
                <option value="">Select</option>
                <option>Yes — authorized</option>
                <option>Yes — call family first if time allows</option>
                <option>No — always call family first</option>
              </select>
            </div>
            <div class="field">
              <label>Who to notify first in a crisis?</label>
              <input type="text" id="crisisNotify" placeholder="Name and phone number">
            </div>
          </div>
          <div class="sig-block" style="margin-top: 16px;">
            <input type="text" class="sig-input" id="sig-crisis-typed" placeholder="Type your full name to sign" autocomplete="off">
            <label class="sig-ack">
              <input type="checkbox" id="sig-crisis-ack">
              <span>By typing my name above and checking this box, I am providing my electronic signature authorizing the Emergency and Crisis Protocol.</span>
            </label>
            <p class="sig-label">Client or Authorized Representative Signature, Crisis Protocol</p>
          </div>
          <div class="field" style="margin-top:12px;">
            <label>Intake Completed By (Staff)</label>
            <input type="text" id="staffName" placeholder="Staff member completing this form">
          </div>
        </div>
      </div>
    </div>

            <!-- SUCCESS SCREEN -->
    <div class="intake-page" id="page-success">
    <div class="success-screen" id="success-screen">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="#F5CD85" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="30" height="30">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <h2 id="success-title">Submitted</h2>
      <p id="success-msg">Your submission has been received.</p>

      <!-- UNLOCK SECTION — only shown after free assessment submit -->
      <div id="unlock-section" style="display:none; width:100%; max-width:420px; margin-top:28px; border-top:1px solid var(--border); padding-top:24px; text-align:left;">
        <p style="font-family:'DM Sans',sans-serif; font-size:13px; color:var(--text-muted); margin:0 0 14px 0; line-height:1.6;">
          <strong style="color:var(--navy); display:block; margin-bottom:4px; font-size:14px;">Have a continuation code?</strong>
          Enter it below to complete your clinical intake and enrollment now.
        </p>
        <div style="display:flex; gap:8px; align-items:stretch;">
          <input type="text" id="unlock-code-input"
            placeholder="Enter code"
            style="flex:1; padding:11px 14px; border:1px solid var(--border); border-radius:4px; background:#ffffff; color:var(--navy); font-family:'DM Sans',sans-serif; font-size:14px; outline:none;">
          <button onclick="handleUnlockCode()"
            style="padding:11px 20px; background:var(--gold); color:var(--navy); border:none; border-radius:4px; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:700; cursor:pointer; white-space:nowrap;">
            Unlock
          </button>
        </div>
        <p id="unlock-msg" style="font-size:12px; color:var(--text-muted); margin:8px 0 0 0; min-height:16px;"></p>
      </div>

      <span class="success-contact" style="margin-top:20px;">404-913-6705 &nbsp;&middot;&nbsp; info@godwinsfamilycarellc.com</span>
    </div>
    </div><!-- /page-success -->

  </div><!-- /body -->

  <!-- NAV ROW -->
  <div class="nav-row" id="nav-row">
    <button class="btn btn-ghost" id="btn-back">← Back</button>
    <span class="page-indicator" id="page-indicator">Page 1 of 7</span>
    <button class="btn btn-primary" id="btn-submit">Continue →</button>
  </div>


</div>

</div>

<script>

  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyEt_q31daQRFFyBhirobxUR6ztn24bNivKa9E8cT96C65OgofX5P0OKbfxyXk84AjP/exec';

  // Token-based mode detection
  // Read token from query string (?token=xxx) or hash (#token=xxx)
  // WordPress can strip query strings on some permalink configs — hash is never stripped
  var _qs = new URLSearchParams(window.location.search);
  var _hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  // Also check PHP_INJECTED_TOKEN set by the WordPress template
  var _phpToken = (typeof PHP_INJECTED_TOKEN !== 'undefined') ? PHP_INJECTED_TOKEN : '';
  const ACCESS_TOKEN = _qs.get('token') || _hash.get('token') || _phpToken || '';
  const IS_FULL_INTAKE = !!ACCESS_TOKEN;

  // Page order differs by mode
  // Assessment: Demographics, Medical (light), Care (light), Caregiver Prefs
  // Intake: Privacy gate, Demographics, Medical (full), Care (full), Caregiver Prefs, Emergency, Payment, Consent
  const PAGES_ASSESSMENT = ['page-0', 'page-1', 'page-2', 'page-3'];
  const PAGES_INTAKE = ['page-priv', 'page-0', 'page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6', 'page-7', 'page-8', 'page-9'];
  const PAGES = IS_FULL_INTAKE ? PAGES_INTAKE : PAGES_ASSESSMENT;
  const STEP_LABELS_ASSESSMENT = ['About', 'Your Info', 'Care Situation', 'Schedule & Urgency'];
  const STEP_LABELS_INTAKE = ['Privacy & HIPAA', 'About', 'Your Info', 'Care Situation', 'Schedule & Urgency', 'Homebound & Medical', 'Clinical Complexity', 'Function & Safety', 'Contacts & Match', 'Insurance & Payment', 'Consent'];
  const STEP_LABELS = IS_FULL_INTAKE ? STEP_LABELS_INTAKE : STEP_LABELS_ASSESSMENT;
  // Locked preview steps shown in assessment-mode progress bar only
  const LOCKED_PREVIEW_LABELS = ['Homebound & Medical', 'Clinical Complexity', 'Function & Safety', 'Contacts & Match', 'Insurance & Payment', 'Consent'];

  let currentIndex = 0;

  // Tracks whether the HIPAA gate has been completed in intake mode
  let _hipaaCompleted = false;

  document.addEventListener('DOMContentLoaded', () => {
    if (IS_FULL_INTAKE) {
      document.body.classList.add('intake-mode');
    }

    // Build progress bar
    buildProgressBar();

    // Event delegation on document — catches nav clicks regardless of
    // how WordPress/Elementor wraps or duplicates the DOM
    document.addEventListener('click', function(e) {
      var t = e.target;
      while (t && t !== document.body) {
        if (t.id === 'btn-submit') {
          e.preventDefault();
          // In unlock-code mode, goToUnlockedPage sets btn.onclick directly and
          // updates _currentUnlockedIndex — delegation must not call handleNextOrSubmit
          // which uses stale currentIndex/PAGES from assessment mode.
          if (!window._intakeUnlocked) { handleNextOrSubmit(); }
          return;
        }
        if (t.id === 'btn-back') {
          e.preventDefault();
          if (!window._intakeUnlocked) { prevPage(); }
          return;
        }
        t = t.parentElement;
      }
    });
    // Strip any stale inline onclick from the buttons
    var sb = document.getElementById('btn-submit');
    if (sb) sb.removeAttribute('onclick');
    var bb = document.getElementById('btn-back');
    if (bb) bb.removeAttribute('onclick');

    if (IS_FULL_INTAKE) {
// Show page-priv immediately — don't wait for fetch
      goToIndex(0);
      // Fetch saved data in background; populate fields only, no navigation
      fetch(SCRIPT_URL + '?action=getData&token=' + ACCESS_TOKEN)
        .then(res => res.json())
        .then(result => {
          if (result.found && result.data) populateForm(result.data);
        })
        .catch(() => {});
    } else {
      goToIndex(0);
    }
  });

  function buildProgressBar() {
    const bar = document.getElementById('progress-bar');
    if (!bar) return;
    var html = STEP_LABELS.map(function(label, i) {
      return '<div class="progress-step" data-idx="' + i + '" onclick="goToIndex(' + i + ')"><div class="step-num">' + (i + 1) + '</div> ' + label + '</div>';
    }).join('');
    // In assessment mode, append locked-preview steps
    if (!IS_FULL_INTAKE) {
      var offset = STEP_LABELS.length;
      html += LOCKED_PREVIEW_LABELS.map(function(label, i) {
        var num = offset + i + 1;
        return '<div class="progress-step locked-preview" title="Unlocks after your free assessment"><div class="step-num">' + num + '</div> <span class="lock-glyph"></span> ' + label + '</div>';
      }).join('');
    }
    bar.innerHTML = html;
  }

  // Map of column-name → field-id for form repopulation from saved data
  const FIELD_MAP = {
    'Client First Name': 'clientFirst', 'Client Last Name': 'clientLast',
    'Client Nickname': 'clientNickname', 'Date of Birth': 'dob', 'Age': 'age',
    'Gender': 'gender', 'Client Address': 'clientAddress',
    'Client Phone': 'clientPhone', 'Lives With': 'livesWith',
    'Primary Language': 'primaryLanguage',
    'Contact Name': 'contactName', 'Contact Relationship': 'contactRelationship',
    'Contact Phone': 'contactPhone', 'Contact Email': 'contactEmail',
    'Contact Address': 'contactAddress',
    'Contact Preference': 'contactPreference', 'Decision Authority': 'decisionAuthority',
    'EC1 Name': 'ec1Name', 'EC1 Relationship': 'ec1Relationship',
    'EC1 Phone': 'ec1Phone', 'EC1 Email': 'ec1Email', 'EC1 Address': 'ec1Address',
    'EC2 Name': 'ec2Name', 'EC2 Relationship': 'ec2Relationship',
    'EC2 Phone': 'ec2Phone', 'EC2 Email': 'ec2Email', 'EC2 Address': 'ec2Address',
    'PCP Name': 'pcpName', 'PCP Practice': 'pcpPractice', 'PCP Phone': 'pcpPhone',
    'Specialist 1': 'spec1Name', 'Specialist 1 Phone': 'spec1Phone',
    'Specialist 2': 'spec2Name',
    'Preferred Hospital': 'preferredHospital',
    'Preferred Pharmacy': 'preferredPharmacy', 'Pharmacy Phone': 'pharmacyPhone',
    'Additional Diagnoses': 'additionalDiagnoses',
    'Allergies': 'allergies', 'DNR Status': 'dnr',
    'Medication Notes': 'medNotes',
    'ADL - Bathing': 'adlBathing', 'ADL - Dressing': 'adlDressing',
    'ADL - Grooming': 'adlGrooming', 'ADL - Toileting': 'adlToileting',
    'ADL - Transfers': 'adlTransfers', 'ADL - Walking': 'adlWalking',
    'ADL - Eating': 'adlEating', 'Fall Risk': 'fallRisk', 'ADL Notes': 'adlNotes',
    'Dietary Restrictions': 'dietary', 'Food Allergies': 'foodAllergies',
    'Cognitive Status': 'cognitiveStatus', 'Dementia Stage': 'dementiaStage',
    'Behavioral Notes': 'behavioralNotes',
    'Requested Start Date': 'freeStartDate', 'Hours Per Week': 'freeHoursPerWeek',
    'Preferred Days': 'freeDays', 'Recurring or One-Time': 'freeRecurring',
    'Urgency': 'freeUrgency',
        'Service Path': 'servicePath',
    'Appointment Access Lite': 'appointmentAccessLite',
    'Has PCP': 'hasPCP',
    'Ongoing Conditions Lite': 'ongoingConditionsLite',
    'ROI Authorized': 'roiAuthorized', 'ROI Restrictions': 'roiRestrictions',
    'Help Needed': 'helpNeeded',
    'Ongoing Conditions Lite': 'ongoingConditionsLite',
    'ADL Level': 'adlLevel',
    'Cognition Level': 'cognitionLevel',
    'Main Reason': 'mainReason',
    'Payment Expectation': 'paymentExpectation',
    'Service Interests': 'serviceInterests',
    'Caregiver Stress': 'caregiverStress',
    'Stress Notes': 'stressNotes',
    'Homebound': 'homebound',
    'Appointment Difficulty': 'appointmentDifficulty',
    'Last PCP Visit': 'lastPCPVisit',
    'Last Hospitalization': 'lastHospitalization',
    'ER Visits 6mo': 'erVisits6mo',
    'Current Services': 'currentServices',
    'HBPC Interests': 'hbpcInterests',
    'Skilled Tasks': 'skilledTasks',
    'Skilled Tasks Provider': 'skilledTasksProvider',
    'Recent Events': 'recentEvents',
    'Functional Risk 6mo': 'functionalRisk6mo',
    'Home Safety': 'homeSafety',
    'Two Person Assist': 'twoPersonAssist',
    'Staff Safety Concerns': 'staffSafetyConcerns',
    'Decision Making': 'decisionMaking',
    'Legal Docs': 'legalDocs',
    'Insurance Types': 'insuranceTypes',
    'Medicare Advantage Plan': 'medicareAdvantagePlan',
    'SSN Last 4': 'ssnLast4'
  };

  const CHECKBOX_MAP = {
    'Diagnoses': 'diagnoses', 'Equipment Needed': 'equipment',
    'IADL Needs': 'iadl', 'Behavioral Concerns': 'behavioral',
    'Shift Times': 'freeShiftTime',
    'Help Needed': 'helpNeeded',
    'Ongoing Conditions Lite': 'ongoingConditionsLite',
    'Service Interests': 'serviceInterests',
    'Current Services': 'currentServices',
    'HBPC Interests': 'hbpcInterests',
    'Skilled Tasks': 'skilledTasks',
    'Recent Events': 'recentEvents',
    'Functional Risk 6mo': 'functionalRisk6mo',
    'Home Safety': 'homeSafety',
    'Legal Docs': 'legalDocs',
    'Insurance Types': 'insuranceTypes'
  };

  function populateForm(data) {
    Object.entries(FIELD_MAP).forEach(([col, id]) => {
      if (!data[col]) return;
      const el = document.getElementById(id);
      if (el) el.value = data[col];
    });
    Object.entries(CHECKBOX_MAP).forEach(([col, name]) => {
      if (!data[col]) return;
      const saved = data[col].split(',').map(v => v.trim());
      document.querySelectorAll('input[name="' + name + '"]').forEach(cb => {
        cb.checked = saved.includes(cb.value);
      });
    });
  }

  function goToIndex(idx) {
    if (idx < 0 || idx >= PAGES.length) {
return; }

    // In intake mode, block progress past index 0 until HIPAA gate is signed
    if (IS_FULL_INTAKE && idx > 0 && !_hipaaCompleted) {
// Snap back to privacy gate and flash it
      const privPage = document.getElementById('page-priv');
      if (privPage) {
        privPage.style.animation = 'none';
        setTimeout(() => { privPage.style.animation = ''; }, 10);
      }
      goToIndex(0);
      return;
    }

    // Show only the active page
    document.querySelectorAll('.intake-page').forEach(p => p.classList.remove('active'));
    const activePage = document.getElementById(PAGES[idx]);
    if (activePage) activePage.classList.add('active');

    // Update progress bar
    document.querySelectorAll('.progress-step').forEach((s, i) => {
      s.classList.remove('active', 'done');
      if (i === idx) s.classList.add('active');
      if (i < idx) s.classList.add('done');
    });

    currentIndex = idx;
    const indicator = document.getElementById('page-indicator');
    if (indicator) indicator.textContent = 'Page ' + (idx + 1) + ' of ' + PAGES.length;
    const back = document.getElementById('btn-back');
    if (back) back.style.visibility = idx === 0 ? 'hidden' : 'visible';
    updateSubmitButton(idx);
    updateHeaderStages();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateSubmitButton(idx) {
    const btn = document.getElementById('btn-submit');
    if (!btn) return;
    const isLast = idx === PAGES.length - 1;
    const onPrivacyGate = PAGES[idx] === 'page-priv';

    if (onPrivacyGate) {
      btn.textContent = 'Continue to Intake \u2192';
    } else if (isLast) {
      btn.textContent = IS_FULL_INTAKE ? 'Submit Intake' : 'Submit Assessment';
    } else {
      btn.textContent = 'Continue \u2192';
    }
  }

  function updateHeaderStages() {
    const sa = document.getElementById('stage-assessment');
    const si = document.getElementById('stage-intake');
    if (!sa || !si) return;
    if (!IS_FULL_INTAKE) {
      sa.className = 'stage-badge active';
      si.className = 'stage-badge inactive';
    } else {
      sa.className = 'stage-badge done';
      si.className = 'stage-badge active';
    }
  }

  function handleNextOrSubmit() {
    try {
if (PAGES[currentIndex] === 'page-priv') {
        var typed = document.getElementById('sig-roi-typed');
        var ack = document.getElementById('sig-roi-ack');
        if (!typed || typed.value.trim() === '') {
          alert('Please type your full name to sign the HIPAA Release of Information.');
          return;
        }
        if (!ack || !ack.checked) {
          alert('Please check the box to confirm your electronic signature.');
          return;
        }
        _hipaaCompleted = true;
        goToIndex(currentIndex + 1);
return;
      }

      var isLast = currentIndex === PAGES.length - 1;
if (isLast) handleSubmit(); else goToIndex(currentIndex + 1);
    } catch (err) {
alert('JS error: ' + err.message);
    }
  }

  function nextPage() { handleNextOrSubmit(); }
  function prevPage() { if (currentIndex > 0) goToIndex(currentIndex - 1); }
  function goToPage(num) {
    // Backwards compat for any inline onclick handlers
    const targetId = 'page-' + num;
    const idx = PAGES.indexOf(targetId);
    if (idx >= 0) goToIndex(idx);
  }

  // Signature — typed name + checkbox acknowledgment
  function getSig(id) {
    const typed = document.getElementById(id + '-typed');
    const ack = document.getElementById(id + '-ack');
    if (!typed || !ack) return '';
    if (typed.value.trim() === '' || !ack.checked) return '';
    return typed.value.trim();
  }

  function addMedRow() {
    const list = document.getElementById('med-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'med-row';
    row.innerHTML = '<div class="field"><label>Medication Name</label><input type="text" placeholder="Name"></div><div class="field"><label>Dosage</label><input type="text" placeholder="e.g. 10mg"></div><div class="field"><label>Frequency / Time</label><input type="text" placeholder="e.g. Once daily"></div>';
    list.appendChild(row);
  }

  function getChecked(name) {
    return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map(el => el.value).join(', ');
  }

  function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

  function getMedications() {
    return Array.from(document.querySelectorAll('.med-row')).map(row => {
      const inputs = row.querySelectorAll('input');
      return inputs[0].value + ' ' + inputs[1].value + ' \u2014 ' + inputs[2].value;
    }).filter(m => m.trim() !== ' \u2014 ').join(' | ');
  }

  function handleSubmit() {
    const btn = document.getElementById('btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting\u2026'; }

    const data = {
      formType: 'care-match',
      accessToken: ACCESS_TOKEN || window._unlockAccessToken || '',
      clientFirst: val('clientFirst'), clientLast: val('clientLast'),
      clientNickname: val('clientNickname'), dob: val('dob'), age: val('age'),
      gender: val('gender'), clientAddress: val('clientAddress'),
      clientPhone: val('clientPhone'), livesWith: val('livesWith'),
      primaryLanguage: val('primaryLanguage'),
      submitterFirst: val('submitterFirst'), submitterLast: val('submitterLast'),
      submitterEmail: val('submitterEmail'), submitterPhone: val('submitterPhone'),
      contactName: val('contactName'), contactRelationship: val('contactRelationship'),
      contactPhone: val('contactPhone'), contactEmail: val('contactEmail'),
      contactAddress: val('contactAddress'), contactPreference: val('contactPreference'),
      decisionAuthority: val('decisionAuthority'),
      ec1Name: val('ec1Name'), ec1Relationship: val('ec1Relationship'),
      ec1Phone: val('ec1Phone'), ec1Email: val('ec1Email'), ec1Address: val('ec1Address'),
      ec2Name: val('ec2Name'), ec2Relationship: val('ec2Relationship'),
      ec2Phone: val('ec2Phone'), ec2Email: val('ec2Email'), ec2Address: val('ec2Address'),
      pcpName: val('pcpName'), pcpPractice: val('pcpPractice'), pcpPhone: val('pcpPhone'),
      spec1Name: val('spec1Name'), spec1Phone: val('spec1Phone'), spec2Name: val('spec2Name'),
      preferredHospital: val('preferredHospital'), preferredPharmacy: val('preferredPharmacy'),
      pharmacyPhone: val('pharmacyPhone'),
      diagnoses: getChecked('diagnoses'), additionalDiagnoses: val('additionalDiagnoses'),
      allergies: val('allergies'), dnr: val('dnr'),
      medications: getMedications(), medNotes: val('medNotes'),
      adlBathing: val('adlBathing'), adlDressing: val('adlDressing'),
      adlGrooming: val('adlGrooming'), adlToileting: val('adlToileting'),
      adlTransfers: val('adlTransfers'), adlWalking: val('adlWalking'),
      adlEating: val('adlEating'), fallRisk: val('fallRisk'),
      equipment: getChecked('equipment'), adlNotes: val('adlNotes'),
      iadl: getChecked('iadl'), dietary: val('dietary'), foodAllergies: val('foodAllergies'),
      cognitiveStatus: val('cognitiveStatus'), dementiaStage: val('dementiaStage'),
      behavioral: getChecked('behavioral'), behavioralNotes: val('behavioralNotes'),
      serviceStartDate: val('freeStartDate'), hoursPerWeek: val('freeHoursPerWeek'),
      days: val('freeDays'), shiftTime: getChecked('freeShiftTime'),
      recurringOrOneTime: val('freeRecurring'), urgency: val('freeUrgency'),
      serviceTier: val('serviceTier'), startDate: val('startDate'),
      requestedDays: val('requestedDays'), shiftTimeFull: getChecked('shiftTime'),
      personality: getChecked('personality'), genderPref: val('genderPref'),
      languagePref: val('languagePref'), caregiverExp: val('caregiverExp'),
      clientInterests: val('clientInterests'), pastCaregiver: val('pastCaregiver'),
      paymentMethod: val('paymentMethod'), billingContact: val('billingContact'),
      ltcCarrier: val('ltcCarrier'), ltcCarrierOther: val('ltcCarrierOther'),
      ltcPolicyNum: val('ltcPolicyNum'), ltcPolicyHolder: val('ltcPolicyHolder'),
      ltcBenefit: val('ltcBenefit'), ltcElimination: val('ltcElimination'),
      ltcNotes: val('ltcNotes'),
      sigServiceName: val('sigServiceName'), sigServiceDate: val('sigServiceDate'),
      sigService: getSig('sig-service'),
      sigROIName: val('sigROIName'), sigROIDate: val('sigROIDate'),
      sigROI: getSig('sig-roi'),
      sigCrisis: getSig('sig-crisis'),
      auth911: val('auth911'), crisisNotify: val('crisisNotify'),
      staffName: val('staffName'),
            helpNeeded: getChecked('helpNeeded'),
      servicePath: val('servicePath'),
      appointmentAccessLite: val('appointmentAccessLite'),
      hasPCP: val('hasPCP'),
      ongoingConditionsLite: getChecked('ongoingConditionsLite'),
      adlLevel: val('adlLevel'),
      cognitionLevel: val('cognitionLevel'),
      mainReason: val('mainReason'),
      paymentExpectation: val('paymentExpectation'),
      serviceInterests: getChecked('serviceInterests'),
      caregiverStress: val('caregiverStress'),
      stressNotes: val('stressNotes'),
      homebound: val('homebound'),
      appointmentDifficulty: val('appointmentDifficulty'),
      lastPCPVisit: val('lastPCPVisit'),
      lastHospitalization: val('lastHospitalization'),
      erVisits6mo: val('erVisits6mo'),
      currentServices: getChecked('currentServices'),
      hbpcInterests: getChecked('hbpcInterests'),
      skilledTasks: getChecked('skilledTasks'),
      skilledTasksProvider: val('skilledTasksProvider'),
      recentEvents: getChecked('recentEvents'),
      functionalRisk6mo: getChecked('functionalRisk6mo'),
      homeSafety: getChecked('homeSafety'),
      twoPersonAssist: val('twoPersonAssist'),
      staffSafetyConcerns: val('staffSafetyConcerns'),
      decisionMaking: val('decisionMaking'),
      legalDocs: getChecked('legalDocs'),
      insuranceTypes: getChecked('insuranceTypes'),
      medicareId: val('medicareId'), medicareType: val('medicareType'),
      medicareAdvantagePlan: val('medicareAdvantagePlan'),
      medicareAdvMemberId: val('medicareAdvMemberId'), medicareAdvGroupNum: val('medicareAdvGroupNum'),
      medicarePartD: val('medicarePartD'),
      medicaidMemberId: val('medicaidMemberId'), medicaidPlan: val('medicaidPlan'),
      medicaidWaiver: val('medicaidWaiver'), medicaidCaseManager: val('medicaidCaseManager'),
      medicaidCaseManagerPhone: val('medicaidCaseManagerPhone'),
      commercialCarrier: val('commercialCarrier'), commercialPlanName: val('commercialPlanName'),
      commercialMemberId: val('commercialMemberId'), commercialGroupNum: val('commercialGroupNum'),
      commercialPolicyHolder: val('commercialPolicyHolder'), commercialPolicyHolderDob: val('commercialPolicyHolderDob'),
      commercialPolicyHolderRel: val('commercialPolicyHolderRel'), commercialInsPhone: val('commercialInsPhone'),
      commercialHomeBenefit: val('commercialHomeBenefit'),
      ssnLast4: val('ssnLast4'),
      roiAuthorized: val('roiAuthorized'), roiRestrictions: val('roiRestrictions')
    };

    fetch(SCRIPT_URL, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(data)
    })
    .then(() => {
      const title = document.getElementById('success-title');
      const msg = document.getElementById('success-msg');
      const unlockSection = document.getElementById('unlock-section');
      const isFullMode = IS_FULL_INTAKE || window._intakeUnlocked;
      if (isFullMode) {
        if (title) title.textContent = 'Intake Complete';
        if (msg) msg.innerHTML = 'Your intake has been submitted and saved.<br>Next step: we will schedule the caregiver match and first visit.';
        if (unlockSection) unlockSection.style.display = 'none';
      } else {
        if (title) title.textContent = 'We\u2019ve Got It \u2014 Thank You';
        if (msg) msg.textContent = 'Your free assessment has been submitted. Someone from our team will follow up within one business day to discuss your loved one\u2019s care needs and next steps.';
        if (unlockSection) unlockSection.style.display = 'block';
      }
      document.querySelectorAll('.intake-page').forEach(p => p.classList.remove('active'));
      const successPage = document.getElementById('page-success');
      if (successPage) successPage.classList.add('active');
      const navRow = document.getElementById('nav-row');
      if (navRow) navRow.style.display = 'none';
    })
    .catch(() => {
      if (btn) { btn.disabled = false; updateSubmitButton(currentIndex); }
      alert('Something went wrong. Please try again or call 404-913-6705.');
    });
  }

  // ── GENERAL UNLOCK TOKEN (server-side validation) ──────────────────────
  // Works two ways:
  //   1. URL param: ?token=gfcie2026 (uses existing IS_FULL_INTAKE flow)
  //   2. Success-page input: user types code, validateToken called via doGet
  //
  // On success: flip to full intake mode in place, no reload,
  // assessment answers persist, route to privacy/HIPAA gate first.

  function handleUnlockCode() {
    const input = document.getElementById('unlock-code-input');
    const msgEl = document.getElementById('unlock-msg');
    if (!input || !msgEl) return;

    const code = input.value.trim();
    if (!code) {
      msgEl.textContent = 'Please enter your continuation code.';
      msgEl.style.color = '#c0392b';
      return;
    }

    input.disabled = true;
    msgEl.textContent = 'Verifying...';
    msgEl.style.color = 'rgba(255,255,255,0.6)';

    // Validate server-side via Apps Script doGet
    fetch(SCRIPT_URL + '?action=validateToken&code=' + encodeURIComponent(code))
      .then(res => res.json())
      .then(result => {
        if (result.valid) {
          msgEl.textContent = 'Code accepted. Loading your intake...';
          msgEl.style.color = '#c0392b';
          setTimeout(() => activateFullIntakeInPlace(), 600);
        } else {
          msgEl.textContent = 'Code not recognized. Please check and try again.';
          msgEl.style.color = '#c0392b';
          input.disabled = false;
          input.focus();
        }
      })
      .catch(() => {
        msgEl.textContent = 'Could not verify. Please try again or call 404-913-6705.';
        msgEl.style.color = '#c0392b';
        input.disabled = false;
      });
  }

  function activateFullIntakeInPlace() {
    // Flip to full intake mode without reloading the page
    window._intakeUnlocked = true;
    window._unlockAccessToken = 'gfcie2026';
    document.body.classList.add('intake-unlocked');

    // Re-enable submit button (was disabled during assessment submit)
    const btn = document.getElementById('btn-submit');
    if (btn) btn.disabled = false;
    // Privacy gate will be shown first via goToUnlockedPage(0) below
    // _hipaaCompleted stays false until they sign it

    // Hide success page, restore nav, show pages via active class
    document.querySelectorAll('.intake-page').forEach(p => p.classList.remove('active'));
    const navRow = document.getElementById('nav-row');
    if (navRow) navRow.style.display = '';

    // Rebuild progress bar for full intake (11 steps: priv + 10 pages)
    const FULL_LABELS = ['Privacy & HIPAA', 'About', 'Your Info', 'Care Situation',
      'Schedule & Urgency', 'Homebound & Medical', 'Clinical Complexity',
      'Function & Safety', 'Contacts & Match', 'Insurance & Payment', 'Consent'];
    const FULL_PAGES = ['page-priv', 'page-0', 'page-1', 'page-2', 'page-3',
      'page-4', 'page-5', 'page-6', 'page-7', 'page-8', 'page-9'];

    const bar = document.getElementById('progress-bar');
    if (bar) {
      bar.innerHTML = FULL_LABELS.map(function(label, i) {
        return '<div class="progress-step" onclick="goToUnlockedPage(' + i + ', FULL_PAGES_GLOBAL)">'
          + '<div class="step-num">' + (i + 1) + '</div> ' + label + '</div>';
      }).join('');
    }

    // Store full pages array globally for navigation
    window.FULL_PAGES_GLOBAL = FULL_PAGES;

    // Update header stage badges
    const sa = document.getElementById('stage-assessment');
    const si = document.getElementById('stage-intake');
    if (sa) sa.className = 'stage-badge done';
    if (si) si.className = 'stage-badge active';

    // Override goToIndex to use full pages array, go to privacy gate first
    window._fullPagesActive = true;
    goToUnlockedPage(0, FULL_PAGES);
  }

  // Navigation function for unlocked full intake mode
  function goToUnlockedPage(idx, pages) {
    pages = pages || window.FULL_PAGES_GLOBAL;
    if (!pages) return;

    // Block navigation past privacy gate until HIPAA is signed
    if (idx > 0 && !_hipaaCompleted) {
      goToUnlockedPage(0, pages);
      return;
    }

    document.querySelectorAll('.intake-page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(pages[idx]);
    if (target) target.classList.add('active');

    document.querySelectorAll('.progress-step').forEach((s, i) => {
      s.classList.remove('active', 'done');
      if (i === idx) s.classList.add('active');
      if (i < idx) s.classList.add('done');
    });

    window._currentUnlockedIndex = idx;
    const indicator = document.getElementById('page-indicator');
    if (indicator) indicator.textContent = 'Page ' + (idx + 1) + ' of ' + pages.length;
    const back = document.getElementById('btn-back');
    if (back) {
      back.style.visibility = idx === 0 ? 'hidden' : 'visible';
      back.onclick = function() { if (idx > 0) goToUnlockedPage(idx - 1, pages); };
    }

    // Update submit button
    const btn = document.getElementById('btn-submit');
    if (btn) {
      const isPrivGate = pages[idx] === 'page-priv';
      const isLast = idx === pages.length - 1;
      if (isPrivGate) btn.textContent = 'Continue to Intake →';
      else if (isLast) btn.textContent = 'Submit Intake';
      else btn.textContent = 'Continue →';
      btn.onclick = function() {
        if (isPrivGate) {
          // Validate HIPAA ROI signature
          const sig = getSig('sig-roi');
          const ack = document.getElementById('sig-roi-ack');
          if (!sig || sig.trim() === '') {
            alert('Please sign the HIPAA Release of Information to continue.');
            return;
          }
          if (!ack || !ack.checked) {
            alert('Please check the box to confirm your electronic signature.');
            return;
          }
          _hipaaCompleted = true;
          goToUnlockedPage(idx + 1, pages);
        } else if (isLast) {
          handleSubmit();
        } else {
          goToUnlockedPage(idx + 1, pages);
        }
      };
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }


</script>

<?php get_footer(); ?>
