# Session 4.6 — Claude Code Prompt
## Enrollment consent set: lane separation, real consent text, signed-copy generation, and one-pass intake

**Prerequisite:** Sessions 4.1–4.5 merged (4.4 clinical completeness P0, 4.5 OpenEMR 8.4 wiring).
**Status:** Ready to run. **Blocks live enrollment** — do not onboard a real home care or clinical client into the app until this ships.
**Model:** Opus.
**Purpose:** The consent registry in `server.js` is structurally sound but its content is not. Every one of the thirteen `CONSENT_BODY` entries in `public/portal.html` is a one- or two-paragraph acknowledgment stub written as a placeholder. Several of them have a client acknowledging a document they were never shown, and one takes a consent the home care agency is not licensed to take. Separately, the single shared `serviceAgreement` cannot correctly serve both service lines. This session fixes the content, splits the lane, and makes the app able to hand a client a copy of what they signed.

**Reference documents.** Two paper packets were built 09/2026 and are the source text for this session. They are the approved wording; port them, do not rewrite them.
- `GFC/GFC_PrivateHomeCare_Service_Packet_TrackA2.pdf` — nine documents, Private Home Care
- `GFC/GFC_InHomePrimaryCare_Service_Packet.pdf` — four documents, In-Home Primary Care

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Stack: Express (server.js),
CDN React, Replit KV, JWT. TEST DATA ONLY until HIPAA-live.

Branch: session/04.6-consent-content

Read first, in full:
- CLAUDE.md (repo root — running status)
- docs/GFC_Intake_and_Packet_Spec_v1.md (§4 consent fixes — this session
  finishes what §4.1 and §4.2 started)
- server.js: GFC_CONSENT_DEFS (~line 2155), consentDefsForServiceLine(),
  isConsentSatisfied(), and the consent-label map (~line 5401)
- public/portal.html: CONSENT_BODY (~line 3808)
- public/admin-enrollment.html: the two consent arrays (~lines 475, 483)
- pdf-generator.js: generateEnrollmentPacketPDF, generateProviderROIPDF,
  generateCarePlanPDF

The two PDF packets named in the session doc are the approved source text.
Extract their wording and port it verbatim. Do not compose new legal language.

===============================================================================
SCOPE A — SPLIT THE SERVICE AGREEMENT BY LANE  (product decision, already made)
===============================================================================

TODAY: one `serviceAgreement` entry, scope 'both', whose body describes BOTH
service lines in a single paragraph (the Intake Spec v1.1 §4.1 rewrite).

WHY THAT IS WRONG:
  1. A home-care-only client signs an agreement describing medical visits,
     prescribing, and chronic disease management they are not receiving and
     have not been offered.
  2. A client who later adds In-Home Primary Care passes the enrollment gate
     for the clinical lane WITHOUT EVER SIGNING A CLINICAL AGREEMENT, because
     `serviceAgreement` is already satisfied from home care. There is no
     document anywhere that establishes the provider-patient relationship,
     names the collaborating physician, or sets clinical termination terms.
  3. Home care and primary care are delivered under different licenses by
     different people and billed differently. One agreement cannot carry both.

DO THIS:
  - Re-scope the existing `serviceAgreement` from 'both' to 'phc'. Its body
    becomes the Home Care Service Agreement (paper packet 1, Document 1).
  - ADD `ihpcServiceAgreement`, scope 'ihpc', required: true, title
    "In-Home Primary Care Services Agreement". Body from paper packet 2,
    Document 1.
  - Migration: existing records carrying `serviceAgreement` were signed against
    the combined text. Do NOT silently re-scope them. Write a one-shot
    migration that flags any client with `serviceAgreement` signed AND
    serviceLine IHPC or BOTH into a `consent_reaffirm_required` list, and
    surface that list in admin. Those clients re-sign the clinical agreement.
    Log every record touched. No data loss, no silent satisfaction.
  - `consentDefsForServiceLine('BOTH')` must now return BOTH agreements. A
    dual-lane client signs two agreements, which is correct.

===============================================================================
SCOPE B — REPLACE THE THIRTEEN CONSENT BODIES WITH REAL TEXT
===============================================================================

Every CONSENT_BODY entry is a placeholder. The comment above it already says
"working draft — counsel/licensure review pending". Replace each with the
corresponding text from the paper packets. Specific defects to fix, in
priority order:

B1. `emergencyFinancial` — HIGHEST PRIORITY, LICENSURE EXPOSURE.
    Current text opens "In a medical emergency, I authorize emergency
    treatment and transport as needed." A private home care provider is not
    licensed to obtain consent to medical treatment, and this consent is
    REQUIRED for home-care-only clients. Replace with the packet 1 Document 7
    wording, which authorizes only (a) summoning 911, (b) admitting responders,
    (c) sharing health information with responders, and states explicitly that
    consent to any actual treatment is given to the responders or hospital,
    not to Godwins Family Care. Retitle to "Emergency Response and Financial
    Responsibility". Keep the financial-responsibility paragraph.

B2. `financialAgreement` — client can sign without ever seeing a price.
    Current text: "I understand the rates, billing cycle, and cancellation
    policy ... as set out in my care plan and service schedule." The app never
    renders a rate. Render the actual rate table from the client record inside
    the consent body before the acknowledgment: hourly rate, daily minimum,
    what is included, holiday treatment, errand fuel, invoice cadence,
    cancellation window, notice period for rate changes. If the client record
    has no rate set, the consent MUST NOT be presentable — block it and show
    admin an actionable error. Source: packet 1 Document 2.

B3. `npp` and `practiceNpp` — acknowledgment without the notice.
    Both bodies acknowledge receipt of a notice the app never displays. 45 CFR
    164.520 requires the notice itself be provided. Render the full notice
    text (packet 1 Document 4; packet 2 Document 4) above the acknowledgment,
    scrollable, with a "download a copy" control wired to Scope C.

B4. `billOfRights` — missing the state complaint line.
    Intake Spec §2B requires the state licensing and complaint number be
    DISPLAYED, not merely referenced. Current text says only "Georgia
    residents may contact the state licensing and complaint line." Add the
    verified numbers from packet 1 Document 3:
      Healthcare Facility Regulation Division, complaint intake
        1-800-878-6442, Mon-Fri 8:00-17:00 ET, fax 404-657-8935
      Adult Protective Services  1-866-552-4464, press 3
    Also port the full rights and responsibilities lists; the current body is
    a single run-on sentence covering perhaps a third of them.

B5. `crisisProtocol` — one paragraph standing in for a protocol.
    Expand to the packet 1 Document 8 protocol: medical emergency, urgent but
    not emergency, mental health crisis (988 and 988 press 1 for veterans),
    fire/weather/power/evacuation, no-answer-at-the-door welfare check, and the
    notification order. Capture the per-client notify-first contact.

B6. `consentToTreat` — too thin for a clinical consent.
    Current text is one sentence. Replace with packet 2 Document 2: separate
    initialed sections for evaluation and treatment, procedures and in-home
    testing, prescribing and medication management, telehealth (opt-in),
    students and trainees (opt-in), plus the no-guaranteed-outcome and
    right-to-refuse acknowledgments. Store the two opt-ins as their own
    booleans on the consent record, not buried in the signature.

B7. `assignmentOfBenefits` — missing patient financial responsibility.
    Current text assigns benefits but never states what the patient owes.
    Add from packet 2 Document 3: deductible, coinsurance/copay, non-covered
    services, and the advance-written-notice rule (no balance billing for a
    non-covered service the patient was not warned about in writing first).

B8. `serviceAgreement` / `ihpcServiceAgreement` — port both in full per
    Scope A. The home care body must carry the scope clause stating no
    provider-patient relationship is created, that clinical services are
    separate, and that neither service is a condition of the other. That
    tying language is the anti-kickback protection for a commonly-owned
    home care agency and medical practice; do not drop or paraphrase it.

B9. `roiFamily`, `roiProvider`, `pcaScope`, `monitoring` — content is
    acceptable. Leave the substance alone. `roiFamily` continues to gate the
    family portal with no manual override.

===============================================================================
SCOPE C — GENERATE THE SIGNED COPY
===============================================================================

`pdf-generator.js` produces an enrollment summary, the provider ROI, and the
care plan. There is no generator for any of the thirteen consents, so a client
cannot be given a copy of what they signed. For the NPP that is a regulatory
requirement, not a nicety.

Build `generateConsentPDF(clientId, consentType)` that renders the executed
consent: the full body text AS PRESENTED AT SIGNING, the typed name, the
server-side timestamp and IP already stored per §4.3, and the consent status.
Store the body text version on the consent record at signing time — a consent
copy must reproduce what the client actually saw, not whatever the current
CONSENT_BODY happens to say after a later edit. Add a body-version identifier
to the consent record and set it on every signature going forward.

Then add `generateEnrollmentPacketZIP(clientId)` returning every executed
consent for that client, and expose a download control in both the client
portal and admin.

===============================================================================
SCOPE D — OFFLINE ENROLLMENT PARITY
===============================================================================

The paper packets exist because clients are being enrolled in person, on
paper, off-app. Verify and fix:
  - `scripts/import_offline_patients.js` accepts a per-type consent status,
    not a blanket one. A client may have signed eight of nine documents.
  - Admin offline-onboarding flow can set `signed_offline` per consent type
    and records who entered it and when.
  - `isConsentSatisfied()` continues to treat `signed_offline` identically to
    `signed` — confirm the new `ihpcServiceAgreement` inherits that.
  - Admin shows, per client, which consents are outstanding and which lane
    each belongs to.

===============================================================================
SCOPE E — DEFECTS FOUND IN A LIVE ENROLLMENT PACKET RENDER  (09/08/2026)
===============================================================================

A generated packet for a serviceLine=IHPC demo client was reviewed. Lane
filtering is CORRECT — the client received the eight 'both' consents plus the
three 'ihpc' consents, and was correctly not shown financialAgreement or
pcaScope. Do not change consentDefsForServiceLine(). These are the defects:

E1. `monitoring` is recorded as signed with NO audit trail.
    The packet shows "Continuous Monitoring Opt-In — Signed by Demo Client"
    with no timestamp and no IP, while every other consent carries both.
    Two problems: (a) `monitoring` is flagged inactive:true and required:false,
    so it should not be presentable or recordable as signed at all; (b) a
    consent record exists with no provenance, which violates Intake Spec §4.3
    (timestamp + IP required on every consent). Block signing of any consent
    flagged inactive, and reject any consent write missing timestamp or IP.
    Audit existing records for others in this state.

E2. Client-facing packet carries an internal working-draft banner.
    The generated packet header reads "Working draft — consent language
    pending counsel/licensure review. Test data until HIPAA-live." This
    document is the client's copy of what they signed. Internal review status
    does not belong on it. Move that banner to the admin view only. Keep a
    non-client-facing environment marker for test data if one is needed, but
    it renders in admin, not on the client's packet.

E3. IP capture is storing the whole forwarded chain.
    Recorded values look like "104.179.178.191, 10.48.13.42, 127.0.0.1" — the
    public IP plus an internal hop plus loopback. As an audit identifier this
    is noise, and 127.0.0.1 is meaningless. Parse X-Forwarded-For and store
    the client IP only; keep the raw chain in a separate field if you want it
    for debugging.

E4. Test record quality (non-blocking, but fix the seed).
    The demo client shows date of birth 2026-07-01 rendering as "age 0" and a
    primary contact of "test (n)" where the relationship rendered as a single
    character. Clean the seed data so demo renders are reviewable.

E5. Confirms Scope A concretely.
    This IHPC client signed "Service Agreement" — the combined body describing
    both service lines — and there is no clinical services agreement anywhere
    in their file. A purely clinical patient has signed a document half about
    housekeeping and companionship, and nothing that establishes the
    provider-patient relationship. This is the live case Scope A fixes.

===============================================================================
SCOPE F — ONE SOURCE OF TRUTH FOR THE LANE PATHWAY
===============================================================================

The lane pathway IS implemented, in four places, and the server side is
correct. Do not rebuild it. Fix the duplication and the two holes.

WHAT ALREADY WORKS (leave alone):
  - server.js:2217 consentDefsForServiceLine() filters defs by scope.
  - server.js:2226 requiredConsentTypes() derives the required set per lane.
  - server.js:8294 the consent-sign endpoint REJECTS a consent that does not
    apply to the client's lane ("Consent X does not apply to this service
    line"). An IHPC patient cannot sign pcaScope. Correct.
  - server.js:8386 the enrollment gate computes the required set per lane and
    returns CONSENTS_INCOMPLETE with the exact missing list. Correct.

F1. TWO SOURCES OF TRUTH — admin UI duplicates the registry.
    public/admin-enrollment.html hardcodes CONSENT_DEFS_BY_LINE (PHC / IHPC /
    BOTH) instead of reading the server registry. They have ALREADY DRIFTED:
    `monitoring` exists in GFC_CONSENT_DEFS with scope 'both' but appears in
    NEITHER client array, so offline onboarding cannot record the monitoring
    choice at all. Adding ihpcServiceAgreement in Scope A would drift them
    further — the server would require a consent the admin form never offers.
    FIX: delete CONSENT_DEFS_BY_LINE. Serve the registry from the server
    (the enrollment status endpoint at ~8198 already returns consentDefs and
    requiredConsents) and render the admin form from that response.

F2. THE `BOTH` MERGE COLLAPSES THE SERVICE AGREEMENT.
      CONSENT_DEFS_BY_LINE.BOTH = [...new Map([...PHC, ...IHPC]).entries()]
    new Map() dedupes by key, so `serviceAgreement` — present in both arrays —
    collapses to one entry. A dual-lane client is shown ONE service agreement.
    This is the client-side mirror of the scope:'both' problem in Scope A.
    Once ihpcServiceAgreement exists as its own key the merge behaves, but
    F1 should land first so there is only one list to be right.

F3. THE PHC-THEN-IHPC PATH IS THE LIVE CASE AND IT HAS A HOLE.
    A client enrolls Private Home Care, then later elects primary care. This
    is the real sequence for the September 2026 client. Today:
      - server.js:8264 `if (serviceLine) users[idx].serviceLine = serviceLine;`
        changes the lane on an intake save.
      - NOTHING re-evaluates the consent set on that change. The consents
        object keeps whatever it held.
      - The gate then correctly blocks on the three new clinical consents,
        which is right — BUT `serviceAgreement` is already 'signed' from home
        care, stays satisfied, and the client passes into the clinical lane
        having never signed a clinical agreement. Same hole as Scope A,
        reached by a different route.
      - No one is told the lane changed and new consents are now pending. It
        is silent until someone opens the enrollment screen.
    FIX: on any serviceLine transition, recompute the required set, write the
    newly-required consents as 'pending', flag the client for admin, and log a
    `service_line_changed` activity event with the before and after values.
    Add a test for PHC -> BOTH specifically.

F4. THE INACTIVE-CONSENT DEFECT HAS A NAMED CAUSE.
    Scope E1 reported `monitoring` recorded as signed with no timestamp and no
    IP. The cause is server.js:8298 — for `def.inactive` the handler writes
    status 'signed' deliberately and skips the signature, timestamp, and IP
    block. Recording an inactive opt-in as 'signed' makes it indistinguishable
    from an executed consent. Use a distinct status (e.g. 'optin_recorded' or
    'na') that isConsentSatisfied() treats appropriately, and never write
    'signed' without provenance.

===============================================================================
SCOPE G — ONBOARDING AND INTAKE: ONE PASS, NO RE-ASKING
===============================================================================

The paper packet was consolidated in 09/2026 behind a single Client
Information Face Sheet (packet 1, Document 1) because the same data was being
asked for up to twelve times across the documents. The app has the same shape
of problem in a different place. Goal for this scope: a client's information
is collected once, and every consent and document reads from that one record.

WHAT IS ALREADY RIGHT — DO NOT REBUILD IT:
  - server.js:~8231 the intake save is well built. DOB is collected once and
    age derived (§3.4). Medications are stored as structured rows, not a
    pipe-delimited string (§3.1). priorProviders are derived from the
    medical-team fields and feed the Transfer-of-Care ROI, with manual and
    roi_form entries preserved. The schema mirror maps intake up onto the
    client profile in the v1 Client Care Profile shape.
  - Leave all of that alone. The data-shape fixes in Intake Spec §3 are done.

G1. THE OFFLINE FORM SHOULD MIRROR THE PAPER FACE SHEET, IN ORDER.
    Clients are being enrolled in person on paper. Someone then keys it in.
    Today the admin offline onboarding form's field order does not match the
    face sheet, so the person typing hunts up and down a PDF.
    FIX: reorder the offline onboarding form to match the face sheet exactly,
    section for section — Client, Representative, Emergency Contacts, Medical
    Contacts, Advance Directive, Payment and Insurance, Access and Safety.
    One pass, top to bottom, no jumping. Source: packet 1, Document 1.

G2. THE COMPLETION CHECKLIST OMITS THE FIELDS THE CONSENTS RENDER.
    ENROLLMENT_STEPS (server.js:~8455) counts ten fields: name, dob, gender,
    address, phone, primaryLanguage, serviceLine, careTier, primaryContact,
    emergencyContact.
    But Scope B requires several consents to RENDER client data:
      - financialAgreement renders the rate table  -> needs the agreed rate
        and daily minimum, which are on NO checklist today
      - crisisProtocol renders the call order      -> needs notify-first
      - emergencyFinancial renders directive status-> needs advance directive
      - the care plan and caregiver instructions   -> need allergies, pharmacy,
        PCP, preferred hospital
      - LTC claim support                          -> needs carrier and policy
    Result: enrollment can read complete while the data a consent depends on
    is still missing, and B2 then blocks at signing time instead of at intake.
    FIX: add these to ENROLLMENT_STEPS, each scoped to the lane that needs it,
    so the gap surfaces during intake rather than at the kitchen table.

G3. `careTier` IS COUNTED AGAINST EVERY LANE.
    ENROLLMENT_STEPS has `careTier` with no lane condition. Care tier is the
    Track A/B home care enum. An IHPC-only patient will never legitimately
    have one, so their enrollment completion can never reach 100% and the
    checklist shows a permanent false gap. This is lane bleed in the opposite
    direction from Scope A.
    FIX: make careTier count only for PHC and BOTH. While you are there, make
    every ENROLLMENT_STEPS entry lane-aware rather than global.

G4. ONE-PASS RULE — apply it as the acceptance test for this scope.
    No field is asked for twice anywhere in the enrollment journey: not across
    the intake wizard steps, not between intake and a consent body, not
    between a consent body and the care plan. A consent that needs a value
    RENDERS it from the client record for confirmation; it never re-collects
    it. The single exception is roiProvider, which leaves the building and
    must carry the client's name and date of birth on its own — mirror that
    exception from the paper packet and no other.

===============================================================================
DELIVERABLES
===============================================================================

1. PR on session/04.4-consent-content.
2. docs/CONSENT_REGISTRY_v2.md (and delete CONSENT_DEFS_BY_LINE) — the fourteen consent types (thirteen plus
   `ihpcServiceAgreement`), lane scope, required flag, the paper document each
   maps to, and the body-version identifier in effect.
3. Migration log listing every client flagged `consent_reaffirm_required`.
4. Tests: that no field is collected twice across intake and consents (G4);
   that careTier is not counted for IHPC-only; that an inactive consent cannot be signed; that a consent write
   missing timestamp or IP is rejected; gate behavior per lane for PHC-only, IHPC-only, and BOTH; that a
   PHC-only client is never presented a clinical consent; that a BOTH client
   is presented both agreements; that `financialAgreement` blocks when no rate
   is set; that `signed_offline` satisfies the gate for every type.

CONSTRAINTS
- No PHI in dev or test. Synthetic data only.
- Do not weaken the family-portal gate on `roiFamily`.
- The paper packet wording is approved text. Port it; do not improve it.
- Anything you believe needs a product decision, stop and report rather than
  choosing. Flag it in the PR description under OPEN DECISIONS.
```

---

## Open decisions for Bianca

1. **Counsel review.** Intake Spec §6 still lists "confirm counsel/licensure review of the rewritten Service Agreement and the IHPC medical consents before launch" as open. The paper packets carry the same status. This session ports approved-by-you wording into the app; it does not substitute for the attorney pass, and B1 in particular (a home care agency taking consent to medical treatment) is worth naming specifically when you send it.

2. **Private Home Care Provider license number.** The paper agreement asserts DCH licensure and has a field for the number. The app asserts nothing. Decide whether the license number renders on the in-app service agreement.

3. **Reaffirmation scope.** Scope A flags existing dual-lane clients to re-sign the clinical agreement. Confirm that is the behavior you want versus grandfathering the seven legacy paper patients.
