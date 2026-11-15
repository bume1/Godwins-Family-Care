// ============================================================================
// WHAT EACH ONBOARDING ITEM IS, IN WORDS (owner, 2026-11-09)
// ============================================================================
// A title alone is not enough to act on. Every item in every chapter carries a
// short description, shown under its title in the checklist and the side
// panel, to the office and to the person onboarding alike.
//
// Where the text came from is recorded, and only the office sees it:
//   PLAYBOOK          Onboarding Playbook v3.0's own paragraph for the item,
//                     verbatim (sometimes trimmed to its first sentences).
//   PLAYBOOK_ADAPTED  Playbook v3.0 text from a table row, a paragraph the
//                     repo splits or merges, or the chapter the Playbook
//                     itself points to (D.5 → C.6), lightly edited to fit.
//   DRAFTED           No Playbook text exists (owner additions). Drafted for
//                     the owner's review.
//
// The Playbook itself stays in Drive and is not copied into this repository;
// only these short per-item lines are, and the app shows them anyway.
// ============================================================================

'use strict';

const P = (text) => Object.freeze({ text, source: 'PLAYBOOK' });
const A = (text) => Object.freeze({ text, source: 'PLAYBOOK_ADAPTED' });
const D = (text) => Object.freeze({ text, source: 'DRAFTED' });

const SOURCES = Object.freeze(['PLAYBOOK', 'PLAYBOOK_ADAPTED', 'DRAFTED']);

const DESCRIPTIONS = Object.freeze({
  // ---- A · Caregiver --------------------------------------------------------
  'A.4.01': P('Confirm the role applied for, the qualifying route the candidate will rely on under A.6, availability, and compensation expectations. The application signature captures authorization for the background investigation, which is therefore not collected a second time.'),
  'A.4.02': P('Contact a minimum of two references directly, including the most recent direct supervisor. Document the date of each call, the person contacted, and the substance of the response.'),
  'A.4.03': P('Verify prior caregiving employment, dates of service, and roles held. Document any gap in employment and the explanation provided.'),
  'A.5.01': P('State the role, pay rate, classification as non-exempt and hourly, at-will employment status, and the service line to which the caregiver is assigned. The agreement is signed before the start date, and the start date is contingent on completion of Phase 3.'),
  'A.5.02': P('Form I-9 with supporting work authorization, Form W-4, direct deposit authorization, and emergency contact information are submitted through the Godwins Family Care application. Form I-9 must be completed within three business days of the start date.'),
  'A.5.03': P('The caregiver acknowledges the Employee Handbook, the Staff Code of Conduct, the Field Addendum to the Staff Code of Conduct, the HIPAA and Confidentiality Acknowledgment, the Private Home Care Policies and Procedures, and the job description for the role.'),
  'A.5.04': P('Drug testing consent and the abuse, neglect, and exploitation attestation required under Rule 111-8-65-.09(5)(a)1 are obtained at application or offer. The attestation is a condition of employment and is retained in the personnel record.'),
  'A.6.01': P('Initiate the records check through the Georgia Criminal History Check System. The applicant separately registers with the Georgia Applicant Processing System and is fingerprinted. The Department of Community Health issues the determination.'),
  'A.6.02': P('Verify the candidate against the OIG List of Excluded Individuals and Entities, the System for Award Management exclusions records, and the Georgia Medicaid excluded provider list. Record the date and result of each verification.'),
  'A.6.03': P('Obtain a satisfactory tuberculosis screening result and file it in the personnel record. Screening is repeated annually.'),
  'A.6.04': P('Obtain the completed drug screening result. This is a Godwins Family Care requirement rather than a requirement of the private home care rules.'),
  'A.6.05': P('Where the caregiver will transport clients or drive to assignments, verify a valid driver\'s license and current automobile liability insurance.'),
  'A.6.06': A('Determine which qualifying route applies to the caregiver (companion, personal care assistant, or licensed nursing), verify it at its source, and record both the route relied upon and the verification in the personnel record.'),
  'A.6.07': A('Where a personal care assistant qualifies through the forty-hour training route, twenty hours are completed before the caregiver serves any client and the remaining twenty within six months of the date training began, under a named registered nurse.'),
  'A.6.08': D('The caregiver confirms they can safely perform the physical demands of the role, such as lifting, transfers and standing for long periods, with or without reasonable accommodation. Signed in the welcome packet.'),
  'A.7.01': A('Orientation is completed before the caregiver works with clients, over a minimum of eight hours: scope of services and the clients served, assigned duties, how to report client progress and problems, reporting known exposure to tuberculosis and hepatitis, HIPAA, infection control, safety, body mechanics, abuse and neglect reporting, and documentation.'),
  'A.7.04': A('Module training in HIPAA and confidentiality, and in dementia and behavioral support: cognitive care, behavioral de-escalation, and the specialized support the service line provides. A certificate is filed for each module.'),
  'A.7.02': P('Scheduling, electronic visit verification and clock-in, visit documentation, and secure communication, all within the Godwins Family Care application. Time is recorded contemporaneously at the point of service.'),
  'A.7.03': P('A supervisor personally observes the caregiver performing the required tasks and completes a written evaluation documenting that the performance was competent. It is completed before the caregiver is assigned to work without supervision.'),
  'A.8.01': P('Pair the caregiver with an experienced caregiver for the initial assignments. Pairing supports both competency confirmation in the client\'s home and caregiver retention during the period when turnover is most likely.'),
  'A.8.02': P('The supervisor contacts the caregiver within the first week of assignment and conducts a structured debriefing after the first unsupervised visit. Document both, including any concerns raised and the resolution.'),
  'A.9.01': A('A dated review of assignment fit, workload, and any operational obstacles, conducted by the supervisor.'),
  'A.9.02': A('A coaching review addressing performance and documentation practice, conducted by the supervisor.'),
  'A.9.03': A('A performance review and confirmation of continued assignment, conducted by the supervisor with the Executive Director notified.'),

  // ---- B · Registered nurse -------------------------------------------------
  'B.4.01': P('Verify Georgia registered nurse licensure through Nursys before investing interview time. A restricted, suspended, surrendered, or lapsed license ends the process.'),
  'B.4.02': P('Contact a minimum of two references, including the most recent direct supervisor or clinical lead. Document the date, the person contacted, and the substance of each call. Where the candidate has supervised caregiving staff, address supervisory practice specifically.'),
  'B.4.03': P('Verify prior nursing employment, dates, and roles. Document any gap and the explanation provided.'),
  'B.5.01': P('State the role, pay rate, classification, at-will employment status, and the service line. Where team lead responsibilities apply, the job description attached to the agreement states them explicitly, including any supervisory authority delegated by the Clinical Director.'),
  'B.5.02': P('Form I-9, Form W-4, direct deposit authorization, and emergency contact information submitted through the Godwins Family Care application, which is the system of record. Form I-9 is completed within three business days of the start date.'),
  'B.5.03': P('Employee Handbook, Staff Code of Conduct, Field Addendum, HIPAA and Confidentiality Acknowledgment, Private Home Care Policies and Procedures, and the job description.'),
  'B.6.01': P('Confirm current, unrestricted Georgia registered nurse licensure through Nursys and enroll the nurse in Nursys e-Notify so that status and expiration changes generate an automatic alert rather than depending on a manual recheck.'),
  'B.6.02': P('Initiated through GCHEXS with fingerprinting through GAPS and a determination from the Department of Community Health. Disqualifying offenses are at O.C.G.A. § 31-7-351.'),
  'B.6.03': P('OIG List of Excluded Individuals and Entities, System for Award Management exclusions, Georgia Medicaid excluded provider list, and the disciplinary records of every state board where the nurse has held licensure. Record the date and result of each.'),
  'B.6.04': A('Tuberculosis screening on employment and annually.'),
  'B.6.05': A('Current basic life support certification verified and the expiration recorded.'),
  'B.6.06': A('The completed drug screening result, filed in the personnel record.'),
  'B.6.07': A('The abuse, neglect, and exploitation attestation, filed in the personnel record.'),
  'B.7.01': P('The Private Home Care Policies and Procedures in full: assessment and care planning, the supervisory visit standard and its documentation, infection control, incident identification and reporting, client rights, and the escalation chain.'),
  'B.7.02': P('Assessment and care plan documentation, scheduling, visit verification, and secure communication within the Godwins Family Care application.'),
  'B.7.03': P('A written evaluation documenting personally observed performance of the nursing tasks the role requires, together with demonstrated competence on any equipment used in the client\'s home. Repeated at least annually.'),
  'B.7.04': A('Where the Clinical Director delegates supervisory responsibility, it is recorded in the job description: supervisory visits (every 92 days for personal care, 122 days for companion tasks), caregiver competency evaluations, and care plan oversight. Clinical standards remain with the Clinical Director.'),
  'B.7.05': A('Where a personal care assistant qualifies through the training route, the forty-hour program is conducted under the nurse\'s direction and the training records identify the nurse by name.'),

  // ---- C · Clinician, employed ----------------------------------------------
  'C.4.01': P('Verify Georgia registered nurse licensure and advanced practice authorization, and search the Composite Medical Board record for any current or prior nurse protocol agreement and the physician named on it. A restricted, suspended, surrendered, or non-renewed license ends the process.'),
  'C.4.02': P('Obtain the candidate\'s National Practitioner Data Bank self-query and review it for malpractice payments and adverse actions. Any finding is disclosed and explained in writing.'),
  'C.4.03': P('Review a de-identified clinical note representative of the work the clinician will perform. Documentation quality is the single most predictive element of the file.'),
  'C.4.04': P('A minimum of two references, including the most recent supervising physician or clinical lead and, where the candidate has practiced under a prior protocol agreement, the prior delegating physician. Address record review experience, responsiveness to consultation, and any occasion requiring intervention.'),
  'C.4.05': P('Collect a continuous history and obtain a written explanation for any gap exceeding thirty days. Verify the current and most recent positions directly.'),
  'C.5.01': P('State the role, rate, classification under the Fair Labor Standards Act, at-will employment status, and the service lines the clinician will cover. The start date is contingent on credential clearance and an executed protocol agreement.'),
  'C.5.02': P('Determine exempt or non-exempt status before the first time record is submitted and record the determination and its reasoning in the personnel file. Confirm the determination with counsel where the compensation structure is mixed.'),
  'C.5.03': P('Form I-9 within three business days of the start date, Form W-4, direct deposit authorization, and personal details, all submitted through the Godwins Family Care application.'),
  'C.5.04': P('Employee Handbook, Staff Code of Conduct, Field Addendum, HIPAA and Confidentiality Acknowledgment, and the Clinical Policies and Procedures. The handbook governs the clinician as an employee and the clinical manual governs clinical practice; both are acknowledged.'),
  'C.5.05': P('Availability is submitted through the application on the cadence set in the Employee Handbook. Submitting availability does not constitute being scheduled, and schedule changes are processed through the application rather than by message.'),
  'C.5.06': D('The clinician acknowledges the duty to report to Godwins Family Care within twenty-four hours any change in licensure, certification, controlled substance registration or malpractice coverage, and any arrest, board action, exclusion or malpractice claim.'),
  'C.6.01': P('Issue the document request with a five business day return and perform primary source verification on each element as it is received.'),
  'C.6.02': P('Confirm the individual national provider identifier lists every taxonomy under which the clinician will bill, with the primary taxonomy designated deliberately. A dual-certified clinician whose identifier omits the psychiatric taxonomy cannot bill a behavioral health code.'),
  'C.6.03': P('Execute a new agreement naming this clinician and the delegating physician. Confirm the physician\'s remaining delegation capacity before execution. The delegating physician files the agreement with the Composite Medical Board, and the clinician does not prescribe until the agreement is in force.'),
  'C.6.04': A('Name a designated alternate physician when the protocol agreement is executed: in writing, attached to the agreement, with the same scope of practice. Naming one in advance prevents an interruption in prescriptive authority if the delegating physician departs.'),
  'C.6.05': P('Where the scope includes controlled substances, obtain federal registration tied to the Georgia practice address and register with the Georgia prescription drug monitoring program. Document the referral pathway for Schedule II medications.'),
  'C.6.06': P('Godwins Family Care carries coverage for employed clinicians. Confirm that the policy responds across every service line the clinician will practice, including behavioral health where applicable, and that limits are sized accordingly.'),
  'C.6.07': P('Where any service line bills a payer, file the individual Medicare enrollment together with the reassignment of benefits to the Godwins Family Care group, and build and attest the CAQH profile before any commercial application is submitted.'),
  'C.6.08': P('Baseline verification against the OIG list, the System for Award Management, the Georgia Medicaid excluded provider list, and board disciplinary records in every state of licensure. Enroll the clinician in continuous license monitoring and assign the recurring owner.'),
  'C.6.09': P('Where the clinician holds another clinical position, review that agreement for exclusivity and outside activity provisions before filing any document naming the clinician.'),
  'C.6.10': D('A satisfactory tuberculosis screening result on file before home visits begin, repeated annually.'),
  'C.6.11': D('Immunization records on file, including any required for home visits under the Clinical Policies and Procedures.'),
  'C.6.12': D('A valid driver\'s license and current personal automobile insurance on file, because the clinician drives to patients\' homes.'),
  'C.6.13': D('For telehealth, the clinician holds licensure in the state where each patient is physically located at the time of the visit.'),
  'C.6.14': D('Controlled substances are prescribed by telehealth only as the federal DEA telemedicine rule in effect at the time allows.'),
  'C.7.01': P('Provision a distinct user account with the appropriate provider authorization, the individual national provider identifier, every applicable taxonomy, an electronic signature, and multi-factor authentication. Shared credentials are not permitted under any circumstance.'),
  'C.7.02': P('The Clinical Policies and Procedures in full: scope under the protocol agreement, documentation content and timeliness, prescribing, the diagnostic result loop, infection control and clinical bag technique, field safety, the escalation chain, and privacy in the home setting.'),
  'C.7.03': P('Note types and required content by visit type, charge capture at the point of care, and the rules governing corrections and late entries. Conducted against a live record rather than by reference to a written standard alone.'),
  'C.7.04': P('For independent medical examinations, the contracting organization\'s examination and documentation requirements. For primary care, the visit and documentation standards of the service line. For behavioral health, the psychiatric note set, with psychotherapy time documented separately.'),
  'C.7.05': P('Documented demonstration on point-of-care testing and any equipment used in the home, completed before independent use and repeated at least annually.'),
  'C.7.06': D('Annual pharmacology continuing education documented in the personnel record, as required to keep prescriptive authority current.'),
  'C.9.01': A('The first encounters in each setting are observed or paired, with a structured debriefing the same day. The home is not a controlled environment, and the first visits are where that becomes material.'),
  'C.9.02': A('Early records are reviewed against the documentation standard and against the delegating physician\'s review obligations under Chapter 360-32, with feedback returned in writing.'),

  // ---- D · Clinician, contracted --------------------------------------------
  'D.4.01': P('Confirm in writing which service lines the clinician will cover: independent medical examinations, private pay primary care, insured primary care, behavioral health, or a combination. The service lines determine the credentialing path and are established before any other step.'),
  'D.4.02': P('Execute the agreement with the insurance obligation and the quality, documentation, and client experience standards written in as contractual deliverables. Commencement is contingent on credential clearance and an executed protocol agreement. Counsel reviews the agreement before execution.'),
  'D.4.03': P('Form W-9 and vendor payment setup. Neither Form I-9 nor Form W-4 is collected. Confidentiality and the twelve-month non-solicitation covenant are established by the independent contractor agreement.'),
  'D.4.04': A('Execute a business associate agreement where the clinician\'s access or role requires one.'),
  'D.5.01': A('The credentialing requirements are those in C.2. Issue the document request with a five business day return and perform primary source verification on each element as it is received.'),
  'D.5.02': A('As for an employed clinician: the individual national provider identifier lists every taxonomy under which the clinician will bill, with the primary taxonomy designated deliberately.'),
  'D.5.03': A('A new agreement naming this clinician and the delegating physician, filed with the Composite Medical Board, applies exactly as for an employed clinician. A prior agreement with another organization does not transfer.'),
  'D.5.04': A('Name a designated alternate physician when the protocol agreement is executed: in writing, attached to the agreement, with the same scope of practice.'),
  'D.5.05': A('Where the scope includes controlled substances, federal registration tied to the Georgia practice address and registration with the Georgia prescription drug monitoring program, as for an employed clinician.'),
  'D.5.06': P('Obtain a certificate of insurance issued by the carrier, not a copy supplied by the clinician. Confirm carrier, policy number, limits, policy period, and claims-made or occurrence basis, and request that the carrier name Godwins Family Care LLC as an additional insured.'),
  'D.5.07': P('Where the engagement includes independent medical examinations, submit the clinician to the contracting organization for examiner credentialing and required certification at the outset. That organization\'s timeline governs the opening of the examination line.'),
  'D.5.08': P('Contractor-paid examination work and private pay work require no payer enrollment. Where an insured line is in scope, enrollment proceeds as for an employed clinician and remains the longest element of the activation.'),
  'D.5.09': A('Baseline verification against the OIG list, the System for Award Management, the Georgia Medicaid excluded provider list, and board disciplinary records, with continuous license monitoring enrolled.'),
  'D.6.01': P('A distinct clinical record account with appropriate provider authorization, the individual national provider identifier, applicable taxonomies, an electronic signature, and multi-factor authentication. Confirm the clinician can operate each system independently.'),
  'D.6.02': P('Documentation standards, client experience standards, the escalation and physician consultation pathway, and care coordination handoffs. Presented as the contractual standard the clinician has agreed to meet rather than as instruction in clinical practice.'),
  'D.6.03': P('For examinations, the contracting organization\'s documentation requirements. For primary care, the visit and documentation standards. Provided as reference materials and templates.'),
  'D.6.04': D('The contracted clinician completes Godwins Family Care\'s HIPAA and confidentiality module on Care Courses and files the certificate.'),

  // ---- E · Clinician, hybrid ------------------------------------------------
  'E.2.01': A('A separate, complete independent contractor agreement for the examination work, neither conditioned on the employment agreement. Counsel reviews the two agreements together.'),
  'E.2.02': A('Form W-9 and vendor payment setup for the contracted examination engagement, kept separate from the payroll records of the employed engagement.'),
  'E.2.03': A('The records must show two genuinely separate relationships: the clinician may decline an examination, timing follows the contracting organization and the clinician\'s availability, and time records, payment runs and remittances are kept separately.'),

  // ---- F · Non-clinical -----------------------------------------------------
  'F.4.01': P('Confirm the role, availability, and compensation expectations. For a remote position, establish the state from which the employee will physically work, because that determines the registration obligations in F.6.'),
  'F.4.02': P('Contact a minimum of two prior employers directly and document each call. Verify employment dates and roles, and document any gap and its explanation.'),
  'F.5.01': P('State the role, compensation, classification as exempt or non-exempt, and at-will employment status. Any commission or bonus structure is set out in the agreement itself.'),
  'F.5.02': A('Exempt or non-exempt status determined and documented before the first time record is submitted.'),
  'F.5.03': P('Form I-9 within three business days of the start date, Form W-4, direct deposit authorization, and emergency contact information, submitted through the Godwins Family Care application.'),
  'F.5.04': P('Conducted on conditional offer. Systems access is not provisioned until the result is received.'),
  'F.5.05': P('Employee Handbook, Staff Code of Conduct, HIPAA and Confidentiality Acknowledgment, the Administrative and Business Operations Policies and Procedures, and the job description.'),
  'F.5.06': A('The Field Addendum to the Staff Code of Conduct applies only where the role involves entering a client residence.'),
  'F.5.07': A('Verification against the exclusion lists at hire, and monthly after that, where the role supports a federally reimbursed service line.'),
  'F.6.01': P('Open the state unemployment tax account, record the work state for withholding purposes, and address the workers\' compensation election under that state\'s law. Requirements vary materially by state.'),
  'F.6.02': P('The employee does not record hours until payroll is able to compensate lawfully in the work state. Resolve this before the start date rather than after.'),
  'F.6.03': P('Time recording activated in the Godwins Family Care application and tested with the employee before the first shift.'),
  'F.7.01': P('Google Workspace account with the issued signature block, and an extension on the main line for any role involving telephone contact. System access is provisioned at the minimum level the role requires.'),
  'F.7.02': P('Approved materials for the role from the current library. Materials are not modified or improvised.'),
  'F.7.03': P('Every non-clinical role has a written training plan. Where the role is the Community Care Liaison, the Community Care Liaison Training Plan is that curriculum.'),
  'F.7.04': P('First live calls, correspondence, or tasks are performed with the supervisor present, after which supervision is withdrawn.'),
  'F.7.05': P('Recording in the system of record begins in the first week of work.'),
  'F.CC.01': D('What each kind of clinician at Godwins Family Care may do, so you know which provider to support with what. Built from the permissions the app itself enforces.'),
  'F.CC.02': D('The work a care coordinator does for a licensed clinician, and the clinical acts a coordinator never performs.'),
  'F.CC.03': D('A supervisor watches you support each kind of clinician in the app, from a prepared note to a co-signed care plan, and signs off.'),
  'F.8.01': A('Counsel reviews the compensation plan in writing before the first commission is paid. Prospecting may proceed in the interim.'),
  'F.9.01': A('A structured review at day thirty addressing performance, obstacles, and whether ramp expectations are being met.'),
  'F.9.02': A('A structured review at day sixty addressing performance, obstacles, and whether ramp expectations are being met.'),
  'F.9.03': A('A structured review at day ninety addressing performance, obstacles, and whether ramp expectations are being met.'),

  // ---- G · Community Care Liaison -------------------------------------------
  'G.2.01': A('Google Workspace account for email, calendar and files. All external correspondence originates from this account with the issued signature block.'),
  'G.2.02': A('An extension on the main line for outbound and return calls. All prospect and family calls are conducted through the extension, tested in both directions before first use.'),
  'G.2.03': A('Access to the sales portal for call scripts, the compensation schedule and the targeting map. Credentials are not shared and materials are not forwarded outside the organization.'),
  'G.2.04': A('The customer relationship system is the system of record for partners, contacts, pipeline and tasks. Activity not recorded there cannot be used to calculate variable compensation.'),
  'G.2.05': A('The approved collateral: the facility brochure, the Continuous Care Program flyer, the records release, and the service differentiation explainer.'),
  'G.2.06': A('The Community Care Liaison Playbook (daily workflow, system rules, weekly structure and check-in agenda) and the Training Plan (the four-week curriculum) are issued during systems provisioning.'),
  'G.3.01': A('The role is scheduled for six to twelve pre-approved hours per week. Availability is submitted at least two weeks in advance, and each client placed on service adds two approved hours per week, to a maximum of twelve.'),
  'G.5.01': A('Commission is calculated from recorded system activity and submitted time records and reviewed each period. Counsel reviews the compensation plan in writing before the first commission is paid.'),
  'G.6.01': A('On-site activity and service concerns go to the Executive Director. Clinical questions go to the Clinical Director; the liaison does not provide clinical guidance. A suspected privacy incident goes to the Executive Director immediately.'),
  'G.4.01': A('All systems provisioned and tested, documents executed, availability submitted, portal training delivered, same-day activity recording established, and initial meetings scheduled with facility decision-makers.'),
  'G.4.02': A('Pipeline training delivered, stages and follow-up tasks managed without prompting, demonstrations and facility education sessions delivered with the Georgia team, and initial family consultations conducted.'),
  'G.4.03': A('Prospecting cadence, pipeline stages, and activity recording operating without supervision, accounts correctly attributed, and each active account meeting the documented activity standard.'),

  // ---- H · Student and extern -----------------------------------------------
  'H.3.01': A('Settled before the placement begins: the placement primarily benefits the student\'s education, does not displace a paid employee, is supervised, and its hours are not billable. Where that is uncertain, the student is onboarded as an employee instead.'),
  'H.3.02': P('The agreement defines supervision responsibilities, the permitted scope of student activity, professional liability coverage and which party carries it, privacy obligations, and the duration of the placement. Confirm the coverage position and its limits specifically.'),
  'H.3.03': A('The student executes the Staff Code of Conduct and the HIPAA and Confidentiality Acknowledgment.'),
  'H.3.04': A('The student executes the Field Addendum to the Staff Code of Conduct where the placement involves entering a client residence.'),
  'H.4.01': A('Background check at the standard required by the affiliation agreement or by Godwins Family Care, whichever is higher. A student who has not cleared does not enter a client residence.'),
  'H.4.02': A('Tuberculosis screening and immunization records at the standard required by the affiliation agreement or by Godwins Family Care, whichever is higher.'),
  'H.4.03': P('Current basic life support certification verified and the expiration recorded.'),
  'H.5.01': P('Privacy and security obligations, infection control, safety, the escalation chain, and the limits of the student\'s permitted activity.'),
  'H.5.02': P('All student activity is supervised. A student does not have independent patient contact, does not sign documentation as the responsible clinician, and does not carry an independent caseload. Student documentation is countersigned by the supervising clinician.'),
  'H.5.03': P('The Clinical Rotation Curriculum governs weeks three through eight of the placement.'),

  // ---- R1 · Supervising physician (Georgia) ---------------------------------
  'R1.2.01': P('Current unrestricted licensure in the state of practice, board certification, controlled substance registration, current malpractice coverage, and verification against the National Practitioner Data Bank, the OIG exclusion list, the System for Award Management, and state board disciplinary records.'),
  'R1.1.01': A('The physician engagement is an independent contractor relationship. Compensation should reflect the recurring review work; a rate below fair market value creates self-referral and anti-kickback exposure where the physician also refers, so the basis for the rate is documented.'),
  'R1.2.02': P('Count the physician\'s existing agreements against the applicable limit before execution. In Georgia the limit is the combined equivalent of eight advanced practice registered nurses or physician assistants.'),
  'R1.2.03': P('Name a designated physician at the time the agreement is executed. In Georgia the designation must be in writing, attached to the agreement, and made to a physician with the same scope of practice.'),
  'R1.2.04': P('One agreement per clinician, stating the delegated medical acts, the scope of prescriptive authority, and the practice locations. The delegating physician files the agreement with the Georgia Composite Medical Board. The clinician does not prescribe until the agreement is in force.'),
  'R1.2.05': P('Assign an owner and a calendar entry to each recurring review obligation at the time of execution. These obligations lapse without producing an alert.'),
  'R1.2.06': P('Retain the agreement and all review records. Confirm the notice obligations on termination and the arrangements that apply on the physician\'s departure.'),

  // ---- Every chapter but A: the staff welcome packet ------------------------
  WELCOME: D('Your welcome packet in My GFC: how to reach you, your emergency contact, your availability, and how you like to learn. It is complete once you sign it.')
});

const descriptionFor = (id) => DESCRIPTIONS[String(id || '')] || null;

module.exports = { DESCRIPTIONS, SOURCES, descriptionFor };
