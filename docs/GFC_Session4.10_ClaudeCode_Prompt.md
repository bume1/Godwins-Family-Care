# Session 4.10 — Claude Code Prompt
## Orders that leave the building: requisitions, referrals and DME, the Schedule II guard, and a results path

**Prerequisite:** Session 4.8 merged (clinical roles, standing orders, credential ceiling).
**Status:** Ready to run. **Blocks live clinical ordering** — today an order is a record of intent with nothing to send and nowhere for the answer to land.
**Model:** Opus.

**Purpose.** An order placed in the app today is documentation plus an OpenEMR copy. Nothing is produced that can be sent, nothing records that it was sent, referrals and DME do not exist, nothing stops an APRN from charting a Schedule II prescription, and a result has nowhere to go. This session fixes those four, in the owner's priority order: **referrals and DME (A), the Schedule II guard (B), the results path (C).** Requisitioning is built inside Scope A because referrals and DME are, by nature, documents that get faxed.

**The transmission model — owner decision, do not relitigate it in code.** GFC has no e-fax integration. **Faxing is done by a human, from the Doximity app on a phone.** Doximity sends and receives, accepts PDF uploads from a phone, and supplies its own cover sheet. So:
- **The app generates. A person transmits.** The app never sends a fax, never calls a fax API, and never claims it did.
- The app's job is to produce a **fax-ready PDF** a clinician can open on a phone and hand to Doximity through the share sheet, and then to **record the send with provenance** when they confirm it.
- Inbound results arrive in the same Doximity inbox. The app's job there is to take the PDF in, attach it to the order, and put it in front of the ordering provider until they acknowledge it.

Build the send channel as an enum so an e-fax integration can slot in later without a data migration. Do not build that integration now.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Stack: Express (server.js),
CDN React, dataStore (kv dev / postgres prod), JWT + server-side sessions,
OpenEMR 8.4 over REST (FHIR is read-only for clinical writes on this
instance). TEST DATA ONLY until HIPAA-live.

Branch: session/04.10-orders-requisitions-results

Read first, in full:
- CLAUDE.md (repo root — running status; note the "write the assertion the
  way the caller calls it" rule and the five times it was earned)
- clinicalRepository.js: ORDER_TYPES / ORDER_STATUSES / ORDER_TRANSITIONS
  (~1262), buildOrder (~1272), buildPrescription (~973), actorRecord (~730),
  buildChargePayloads (~1192)
- clinicalRoles.js (whole file — capability matrix, STANDING_ORDER_TYPES
  ~327, CREDENTIAL_CEILING ~328)
- standingOrders.js (whole file — authorizeExecution ~200)
- server.js: the order route (~9561), prescription route (~9531), order
  status route (~9685), order list (~9724), standing-order routes
  (~9916–10038), and the clinical bootstrap that exposes orderTypes (~9449)
- openemr.js: the patched order write (~621), prescription write (~544),
  and the document upload (~670–707) — Scope C files results there
- pdf-generator.js — house patterns for server-side PDFs
- contentDisposition.js — every download goes through it (a macOS
  screenshot filename once 500'd every document download)
- appLinks.js — every URL in every notice goes through it
- public/clinical.html — where orders are placed today

HOUSE RULES THAT APPLY TO EVERY SCOPE BELOW
- Every date and time on screen or on paper is EASTERN. The server is pinned
  to America/New_York; format through the shared formatter. A requisition
  stamped in UTC is a requisition dated wrong.
- Every write is logActivity'd with the real acting user and lands in the
  durable audit_log. No service-account attribution.
- Fail closed. A principal, prescriber, or order whose authority cannot be
  established is refused, never defaulted.
- Mutation-check every guard test: restore the old behaviour, the test must
  fail. A guard test that passes with the guard removed proves nothing.

===============================================================================
SCOPE A — REFERRALS, DME, AND THE REQUISITION THEY RIDE ON   (owner item 2)
===============================================================================

A1. TWO NEW ORDER TYPES, PROVIDER-DIRECT ONLY.
    Add 'referral' and 'dme' to ORDER_TYPES.
    Do NOT add either to STANDING_ORDER_TYPES or to CREDENTIAL_CEILING. They
    are placed on a provider's own authority only. An RN or LMSW cannot place
    one directly (ORDER_DIRECT is provider-only) or under a protocol (the
    ceiling and the protocol's permittedOrderTypes both exclude them).
    That is safe BY CONSTRUCTION today — prove it with a test that posts each
    type as an rn, an lcsw and an lmsw, with and without a standingOrderId,
    and gets refused every time. Mutation-check it.

A2. THEIR OWN BUILDERS. buildOrder requires a non-empty `tests` array
    (ORDER_NO_TESTS). Do not contort that. Write buildReferral and
    buildDmeOrder that share the order envelope (id, client, encounter,
    ordering clinician, diagnoses, priority, status, audit fields) and carry
    a type-specific payload. Every order still anchors to an encounter and
    to at least one encounter diagnosis, exactly like today.

A3. REFERRAL payload:
    - specialty (free text, required) and receiving practice / provider name
    - receiving fax number (required — this is what gets faxed) and phone
    - reason for referral (required) and urgency (routine / urgent / stat)
    - clinical summary (required, the question you want answered)
    - attachments: pick from this patient's existing chart items (recent
      encounter notes, recent results from Scope C). Selected items are
      appended to the requisition PDF, in order, after the letter.
    - prior-authorization flag and auth number. Medicare Advantage plans
      frequently require one; the flag is how that stops being forgotten.
    Referral lifecycle is NOT the lab lifecycle. Give it its own transitions:
      ordered -> sent -> scheduled (with appointment date) -> completed
      (consult note received, via Scope C) ; ordered|sent|scheduled -> cancelled

A4. DME payload — must satisfy CMS's Standard Written Order. The six
    required SWO elements, all server-enforced before the order can be
    finalized:
      1. beneficiary name or MBI      4. quantity to be dispensed
      2. order date                   5. treating practitioner name or NPI
      3. general description of item  6. treating practitioner signature
         (narrative, HCPCS, or brand/model)
    Plus: supplier name, supplier fax (required), length of need, and two
    flags the provider sets from CMS's current Required List:
    - `requiresF2F` — when set, a face-to-face encounter date is required
      and must fall within the 6 months before the order date. Link it to
      the encounter it came from when one exists.
    - `requiresWOPD` — when set, the requisition prints WRITTEN ORDER PRIOR
      TO DELIVERY prominently, because the supplier may not deliver before
      they hold it (power mobility devices are the statutory case).
    Do not embed CMS's Required List in code. It changes. The provider sets
    the flags; the UI links to the current list.

A5. THE MEDICARE ORDERING RULE. Under 42 CFR 424.507, when the practitioner
    who ORDERED a clinical lab test, imaging, or DMEPOS is not enrolled in
    Medicare in approved status, the lab's, imaging center's or supplier's
    claim is DENIED. This is not GFC's claim, but it is GFC's problem.
    - Add a structured field to clinician user records:
      medicareEnrollment: { status: 'approved'|'pending'|'none'|'opted_out',
                            effectiveDate, verifiedAt, verifiedBy }
      Admin-maintained on the user form. Nothing infers it.
    - On a lab, imaging, or dme order for a Medicare patient (primary payer
      Medicare or MA), if the ORDERING clinician's status is not 'approved'
      or 'opted_out': refuse finalization with code
      ORDERING_PROVIDER_NOT_ENROLLED unless the clinician acknowledges the
      warning and gives a reason. Record the acknowledgment on the order.
      Warn and record, do not hard-block: commercial patients and urgent care
      exist.
    - Under a standing order, the ORDERING clinician is the AUTHORIZING
      provider (4.8 already files it that way). Check that person's
      enrollment, not the executing nurse's.
    - Referrals to specialists are outside 424.507. Do not warn on them.

A6. THE REQUISITION — one generator, every order type.
    generateRequisitionPDF(order, client, orderingClinician, opts) in
    pdf-generator.js, with a layout per type: lab/imaging/procedure
    requisition, referral letter, DME Standard Written Order.

    FAX-SAFE RENDERING. This document will be faxed, and faxing destroys
    anything subtle. So:
    - Black on white. No brand colour carrying meaning, no light greys (they
      drop out), no background fills behind text.
    - Minimum 10pt body, 12pt for identifiers. High contrast rules only.
    - Target ONE page. When attachments push it longer, number every page
      "Page N of M".
    - PATIENT NAME, DOB and MBI ON EVERY PAGE, top and bottom. Fax pages
      separate. A page without identifiers is a page that ends up in the
      wrong chart.
    - An ORDER REFERENCE printed large on every page, e.g. GFC-ORD-7K2Q9X,
      with the line "Please include this reference when returning results."
      Short, unambiguous characters only (no 0/O, 1/I/L). This is how an
      inbound fax gets matched back to its order in Scope C.
    - NO COVER SHEET. Doximity supplies one. Two cover sheets is noise.

    CONTENT on every requisition:
    - Patient: name, DOB, sex, address, phone, MBI, primary payer and ID,
      secondary payer and ID
    - Ordering clinician: name, credential, NPI, and the signature block
      below. Under a standing order: the AUTHORIZING provider is the
      ordering clinician, and a line reads "Executed under standing order
      [title] v[version] by [name, credential]"
    - Diagnoses as ICD-10 code plus description
    - The order itself, per type
    - Priority, printed large when urgent or stat
    - "Return results to:" — the RETURN FAX NUMBER from settings (A8), the
      GFC phone, and the ordering clinician's name
    - Date and time generated, Eastern

    SIGNATURE. An electronic signature statement: "Electronically signed by
    [name, credential], NPI [npi], on [date time ET]." For DME the SWO
    requires the treating practitioner's signature, and the electronic
    statement satisfies it. A requisition cannot be generated for an order
    whose ordering clinician has no NPI on file — refuse with a named reason.

A7. THE HAND-OFF TO DOXIMITY.
    - GET .../orders/:orderId/requisition.pdf streams the PDF through
      contentDisposition.js with a clean filename
      (GFC_[type]_[lastname]_[yyyymmdd]_[ref].pdf).
    - On a phone this must open in the browser's PDF viewer so the SHARE
      SHEET is one tap away. Test it on a mobile viewport. This is the whole
      workflow: generate, share to Doximity, send.
    - File a copy of every generated requisition into the patient's OpenEMR
      document area (openemr.js upload, category '/Orders'). The chart must
      hold EXACTLY what was sent. Regenerating after an edit files a new
      copy; the old one is kept.

    RECORDING THE SEND. The order moves to 'sent' ONLY through a
    "Mark as faxed" action that captures:
      recipient name, recipient fax number, channel, sentAt, sentBy
    `channel` is an enum: 'doximity' | 'efax' | 'portal' | 'phone' | 'hand'.
    Default 'doximity'. A bare status click to 'sent' is no longer
    permitted — remove 'sent' from what the generic status route accepts and
    route it through this action. An order can be re-sent; each send is its
    own row, never an overwrite.

A8. SETTINGS, SEEDED — NOT LITERALS.
    Add to org settings, admin-editable: return fax number, return fax
    label, GFC phone for requisitions.
    SEED the return fax number into the settings store with the owner-
    confirmed value:  678-692-7445
    - Do it in an idempotent migration that writes the value ONLY IF the
      setting is unset. A re-run, or a boot after an admin has changed it,
      must never overwrite the admin's value. Log what it did.
    - Store it as 10 digits ("6786927445"). Render it on the requisition as
      (678) 692-7445.
    - The number lives in the DATABASE, not in code. No source file, test
      fixture aside, may contain it as a literal. Add a test that greps the
      source tree for it and fails if it appears outside the migration and
      its test. It will change when an org fax line exists, and that must be
      a settings edit, not a deploy.
    - Validate every fax number field in this session (return fax, referral
      recipient, DME supplier, Mark as faxed) as a 10-digit US number. A
      mistyped fax number is a misdirected PHI disclosure.

A9. EXTEND TO WHAT EXISTS. Lab, imaging and procedure orders get the same
    requisition, the same send record, and the same 424.507 check. The
    existing four order records in test data must still load.

===============================================================================
SCOPE B — THE SCHEDULE II GUARD                              (owner item 5)
===============================================================================

WHY. Georgia APRNs may not prescribe Schedule I or II substances. The sole
statutory exception is hydrocodone, oxycodone or compounds thereof, in an
emergency, capped at a 5-day initial supply, with authority written into the
protocol agreement and a DEA registration updated for it. Today
buildPrescription takes the drug as free text and checks nothing, and the
PRESCRIBE capability is 'provider', which covers an MD and an NP alike.
There is no eRx, so the app is not the prescription. It IS the chart saying a
prescription was written. That is the same exposure Session 4.8 closed for
RNs: the app producing a record asserting someone acted outside their scope.

B1. KNOW WHAT THE PRESCRIBER IS. clinicalRole 'provider' cannot tell an NP
    from an MD, and licenseLevel is free text that gates nothing (CLAUDE.md).
    Do not parse it. Add a structured field on provider users:
      prescriberCredential: 'MD' | 'DO' | 'NP' | 'PA'
    Required for any provider who prescribes. Absent -> the prescription
    route refuses with PRESCRIBER_CREDENTIAL_UNKNOWN. Fail closed.
    Also add: deaNumber, deaSchedules (the schedules the registration
    covers), deaExpiresAt. Admin-maintained.

B2. EVERY PRESCRIPTION DECLARES ITS SCHEDULE. Add a required field
      schedule: 'non_controlled' | 'CII' | 'CIII' | 'CIV' | 'CV'
    No default. The clinician chooses.

B3. DON'T TRUST THE DECLARATION ALONE. Maintain a short, reviewed list of
    common Schedule II agents in its own module (controlledSubstances.js):
    amphetamine and its salts, dextroamphetamine, lisdexamfetamine,
    methylphenidate, dexmethylphenidate, oxycodone, hydrocodone, morphine,
    hydromorphone, fentanyl, methadone, oxymorphone, tapentadol, codeine as
    a single agent, and their common brand names. Match case-insensitively
    on word boundaries.
    If the drug text matches the list and the declared schedule is anything
    other than 'CII', REFUSE with SCHEDULE_MISMATCH and name the matched
    term. This catches the realistic failure: "Adderall", declared
    non-controlled.
    The list is a backstop, not a formulary. It will never be complete. Say
    so in the module header.

B4. THE RULE.
    - prescriberCredential 'NP' or 'PA' + schedule 'CII' -> REFUSE with
      APRN_SCHEDULE_II_PROHIBITED. The message tells them to route it to the
      collaborating physician.
    - DO NOT BUILD THE EMERGENCY OPIOID EXCEPTION IN THE APP. It is narrow,
      it is rare in home-based primary care, and a wrongly granted exception
      is worse than routing to a physician. Record it in CLAUDE.md as a
      deliberate non-build with this reasoning.
    - Any controlled schedule (CII–CV) requires: a DEA number on file, not
      expired, covering that schedule. Otherwise refuse with
      DEA_NOT_ON_FILE / DEA_EXPIRED / DEA_SCHEDULE_NOT_COVERED.
    - Any controlled schedule requires a PDMP attestation on the
      prescription: checked the Georgia PDMP, date checked. Record it.
    - MD/DO + CII is permitted, subject to the DEA checks above.

B5. Record `schedule`, `prescriberCredential`, and the PDMP attestation on
    the prescription row and in the OpenEMR note stamp.

B6. EXISTING PRESCRIPTIONS. A migration flags every existing prescription
    with no schedule as 'unclassified' and lists them in admin. Do not guess
    their schedule. Do not block reading them.

===============================================================================
SCOPE C — RESULTS: FROM THE DOXIMITY INBOX TO AN ACKNOWLEDGED RESULT
===============================================================================
                                                            (owner item 6)
WHY. "resulted" is a status label a human clicks. No value is stored, there
is no inbox, and the acknowledgeAbnormalResult capability has existed since
4.8 with no route behind it. With results arriving by fax to one person's
phone, the realistic harm is an abnormal result that nobody with authority
ever saw, and a result that never arrived that nobody noticed was missing.

C1. RECEIVE. "Attach result" on an order: upload the PDF or image the
    clinician saved from Doximity. Magic-byte sniff the file type (the ROI
    upload already does this — reuse it). Store it into the patient's
    OpenEMR document area, category '/Lab Report' for lab, '/Imaging' for
    imaging, '/Consult' for referrals. NOT Google Drive: Drive is not
    configured, and received-for-care records belong in the chart by the
    document routing rule in the OpenEMR setup guide.

C2. CAPTURE. With the file: result date, performing lab or facility, a
    short summary, and an interpretation flag:
      'normal' | 'abnormal' | 'critical'
    Structured values and LOINC are out of scope. The PDF is the record; the
    flag drives routing.

C3. STATUS FOLLOWS EVIDENCE. Attaching a result moves the order to
    'resulted' (a referral to 'completed'). Remove 'resulted' from the
    generic status route: an order can no longer be marked resulted without
    a result attached. The existing transitions otherwise hold.

C4. UNMATCHED INBOUND. A fax arrives that matches no order — a hospital
    discharge summary, a result from an outside provider. Allow attaching it
    to the PATIENT with no order. It lands in the same inbox for review.
    Match by the GFC-ORD reference first; the reference is on every
    requisition for exactly this.

C5. THE RESULTS INBOX — this is where acknowledgeAbnormalResult finally gets
    its route.
    - Each unacknowledged result routes to its ORDERING clinician. Under a
      standing order, that is the AUTHORIZING provider, not the nurse who
      executed it.
    - Inbox lists unacknowledged results: critical pinned first, then
      abnormal, then normal; oldest first within each.
    - Acknowledge requires the ACKNOWLEDGE_ABNORMAL_RESULT capability for
      abnormal and critical; any provider may acknowledge normal. Capture
      acknowledgedBy, acknowledgedAt, and a follow-up note (required for
      abnormal and critical: what you are doing about it).
    - A 'critical' result sends an immediate notice to the ordering clinician
      through the notification queue. NON-PHI wording: "A critical result is
      waiting for your review," with an appLinks destination. Never the
      value, never the name.
    - Unacknowledged abnormal results older than 2 business days, and
      critical older than 4 hours, escalate to admin. Named constants.

C6. OVERDUE. The lost fax is the failure mode of a manual workflow. An
    order that is 'sent' with no result after 7 days (lab), 14 days
    (imaging), or 30 days (referral) appears in an Overdue list with the
    recipient and fax number it went to, so someone can call. Named
    constants. This is the single most useful screen in this session.

C7. THE PATIENT SEES NOTHING NEW. Do not expose results to the client or
    family portal in this session. That is a separate decision about
    release timing, and it is not made.

===============================================================================
NON-GOALS — do not build these
===============================================================================
- Any fax API or e-fax integration. The channel enum is the seam for later.
- eRx, EPCS, or a drug database.
- The APRN emergency-opioid exception (B4 — deliberate non-build).
- Structured lab values, LOINC, reference ranges, or trending.
- Linking orders to billing charges.
- The SCREENING standing-order defect: buildOrder rejects
  orderType 'screening' before authorizeExecution runs, so screening
  protocols can be signed but not executed. The owner has deferred it. Do
  NOT add 'screening' to ORDER_TYPES in this session and do not touch that
  path. Keep it listed as OPEN in CLAUDE.md.
- Results in the client or family portal.

===============================================================================
VERIFICATION — what "done" means
===============================================================================
1. Referral and DME: rn / lcsw / lmsw refused with and without a
   standingOrderId, provider permitted. Mutation-checked.
2. DME: each of the six SWO elements missing -> refused, one test each.
   F2F date older than 6 months -> refused.
3. 424.507: Medicare patient + unenrolled ordering clinician -> refused
   without acknowledgment, permitted with it and recorded. Standing order
   checks the AUTHORIZING provider's enrollment, not the executor's.
4. Schedule II: NP + CII refused; PA + CII refused; MD + CII with valid DEA
   permitted; "Adderall" declared non_controlled refused as
   SCHEDULE_MISMATCH; controlled Rx with no DEA / expired DEA / uncovered
   schedule refused; missing prescriberCredential refused.
   Mutation-check every one.
5. Requisition PDF rendered for each type and inspected: patient identifiers
   and the order reference on EVERY page, no cover sheet, Eastern
   timestamps, no grey text, and a copy filed to OpenEMR.
6. 'sent' unreachable except through Mark as faxed; 'resulted' unreachable
   except through Attach result. Assert the generic status route refuses both.
7. A critical result routes to the authorizing provider of a standing-order
   execution, sends a notice containing no PHI, and escalates on schedule.
8. Overdue list shows a 'sent' lab order at day 8 and not at day 6.
9. Live HTTP run through the real Express router, values read back from the
   store: place a referral, generate its requisition, mark faxed via
   doximity, attach a consult note, acknowledge it.
10. Drive the shipped pages in Chromium on a MOBILE viewport: open a
    requisition and confirm it renders in the viewer where the share sheet
    is reachable.
11. Return fax seed: a fresh store gets 6786927445 after the migration; a
    store where an admin already set a different number keeps it; a second
    run changes nothing. The requisition prints (678) 692-7445. The
    source-tree grep test fails if the number is added as a literal anywhere
    else. A 9-digit or 11-digit fax number is refused on every fax field.
12. Report the suite figure for THIS PR.
```

---

## Owner decisions — resolved 2026-09-22

1. **Doximity BAA** — confirmed by the owner.
2. **Return fax number** — **678-692-7445**. Seeded into the settings store by migration (A8), printed on every requisition as the return line, editable in admin when an org fax line exists.
3. **Overdue thresholds** — confirmed: 7 days lab, 14 imaging, 30 referral.
4. **Escalation thresholds** — confirmed: 2 business days for unacknowledged abnormal, 4 hours for critical.
5. **Medicare enrollment status per clinician** — confirmed. Scope A adds the field and an admin fills it in. Until a clinician's enrollment is approved, their lab, imaging and DME orders for Medicare patients carry the 424.507 warning.
