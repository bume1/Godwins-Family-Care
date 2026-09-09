// ============================================================
// GODWINS FAMILY CARE — CONSENT SOURCE TEXT (single source of truth)
// Session 4.6, Scope B.
//
// Every consent body in the app lives here, ported VERBATIM from the two
// approved paper packets:
//   packet 1 — GFC_PrivateHomeCare_Service_Packet_TrackA2.pdf
//   packet 2 — GFC_InHomePrimaryCare_Service_Packet.pdf
// (transcribed into docs/GFC_Consent_Source_Text_v2.md, which is the literal
// source this file was ported from). This is approved legal wording — do not
// rewrite, improve, paraphrase, or summarize it. Corrections come from counsel
// and land here as a NEW body version, never as an edit to a shipped one.
//
// WHY ONE FILE. Before 4.6 the bodies lived only in public/portal.html, so the
// PDF generator could not reproduce what a client actually signed and the admin
// form kept its own hardcoded copy of the registry. This module is loaded by
// the browser (window.GFC_CONSENT_TEXT, served statically from /consent-text.js)
// AND required by Node (server.js, pdf-generator.js). One text, three readers.
//
// VERSIONING (Scope C). A consent copy must reproduce the body AS PRESENTED AT
// SIGNING, not whatever the current text says after a later revision. Each
// consent therefore carries a `version` id which is stamped onto the consent
// record at signature time, and every superseded version stays reachable in
// ARCHIVE so an old signature still renders its own text. Bump the version and
// archive the outgoing body whenever wording changes.
//
// BLOCK VOCABULARY — a body is an array of blocks, rendered by both the portal
// (JSX) and pdf-generator (pdfkit) from the same data:
//   { t:'p',      text }                      paragraph ( **bold** supported )
//   { t:'h',      text }                      numbered section heading
//   { t:'sub',    text }                      italic sub-heading
//   { t:'ul',     items:[] }                  bullet list
//   { t:'note',   text }                      muted aside
//   { t:'choice', key, label, options:[], required }
//                                             a recorded election — stored as
//                                             its own field on the consent
//                                             record, never buried in the
//                                             signature
//   { t:'data',   source, label }             renders values already on the
//                                             client record. The one-pass rule
//                                             (Scope G4): a consent that needs a
//                                             value RENDERS it for confirmation,
//                                             it never re-collects it.
//
// TEST DATA ONLY until HIPAA-live.
// ============================================================
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GFC_CONSENT_TEXT = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Current body version for every consent ported in this session. One id for
  // the whole 4.6 port keeps the audit trail legible: "signed against the
  // 2026-09 packet text".
  const V2 = '2026-09-packet-v2';
  // The pre-4.6 placeholder bodies. Kept ONLY so a consent signed before this
  // session still renders the stub it was actually signed against.
  const V1 = 'draft-1';

  const ORG = {
    name: 'Godwins Family Care LLC',
    address: '4300 Paces Ferry Rd SE, Suite 500, Atlanta, GA 30339',
    phone: '404-913-6705',
    fax: '678-692-7445',
    email: 'admin@godwinsfamilycarellc.com',
    // Open decision 2 for the owner: whether this renders in-app. It is carried
    // here so the answer is a one-line change, not a text rewrite.
    phcpLicense: 'PHCP013073'
  };

  // Verified state contacts, packet 1 Document 3. Intake Spec §2B requires these
  // be DISPLAYED, not merely referenced.
  const STATE_CONTACTS = [
    'Georgia Department of Community Health, Healthcare Facility Regulation Division — complaint intake 1-800-878-6442, Monday to Friday 8:00 to 17:00 ET, fax 404-657-8935.',
    'Adult Protective Services — 1-866-552-4464, press 3.'
  ];

  const p = (text) => ({ t: 'p', text });
  const h = (text) => ({ t: 'h', text });
  const sub = (text) => ({ t: 'sub', text });
  const ul = (items) => ({ t: 'ul', items });
  const note = (text) => ({ t: 'note', text });
  const data = (source, label) => ({ t: 'data', source, label });
  const choice = (key, label, options, required) =>
    ({ t: 'choice', key, label, options, required: required !== false });


  // ==========================================================
  // PACKET 1 — PRIVATE HOME CARE
  // ==========================================================

  // Document 1 of packet 1 (the Home Care Service Agreement).
  // Re-scoped 'both' -> 'phc' in Scope A: a home-care-only client must not sign
  // an agreement describing medical visits they are not receiving, and a client
  // who later adds primary care must not arrive in the clinical lane already
  // "satisfied" on the only agreement in the file.
  const SERVICE_AGREEMENT = [
    p('This agreement sets out the **non-medical** personal home care services Godwins Family Care LLC will provide, what they cost, and how either of us may change or end them. It is not an agreement for medical care. Please read it and ask about anything that is not clear before signing.'),

    h('1. Parties'),
    data('parties', 'Client and representative'),
    p('**Provider.** Godwins Family Care LLC, a Georgia limited liability company licensed by the Georgia Department of Community Health, Healthcare Facility Regulation Division, as a Private Home Care Provider under license number **' + ORG.phcpLicense + '**, in effect as of the date of this agreement.'),

    h('2. What Your Caregiver Will Do'),
    p('**Track A2, Comprehensive Home Care.** Non-medical personal care and companion services delivered in the client’s residence. This is the full scope of what a Godwins Family Care caregiver is trained and authorized to do for you. Your plan of care records which of these you have asked for.'),

    sub('Bathing and hygiene — Personal care'),
    p('Bathing and showering, standby assistance while you bathe so you do not fall, bed and sponge bathing, washing and styling hair, shaving, skin care and lotion, nail filing and hand and foot care, oral care and denture care, perineal care.'),

    sub('Dressing and grooming — Personal care'),
    p('Choosing clothing, dressing and undressing, fastening buttons and zippers, putting on and removing compression stockings, applying braces, splints, or a prosthesis, and help with glasses, hearing aids, and dentures.'),

    sub('Toileting and continence — Personal care'),
    p('Getting to and from the toilet, bedside commode, bedpan and urinal, changing incontinence briefs and pads, cleaning and changing after an accident, and emptying an external urinary drainage bag where your plan of care includes it.'),

    sub('Mobility and transfers — Personal care'),
    p('Walking assistance, gait belt use, help with a cane, walker, or wheelchair, transfers between bed, chair, toilet, and car, turning and repositioning to protect the skin, range of motion movement as instructed, and fall prevention throughout the home.'),

    sub('Eating and nutrition — Personal care'),
    p('Planning and preparing meals and snacks, following a special diet, cutting food, feeding assistance, encouraging fluids, watching what you are actually eating and drinking, and cleaning up afterward.'),

    sub('Medication support — Reminders only'),
    p('Reminding you when a dose is due, reading a label aloud, opening a container, bringing you your pre-filled pill organizer and a glass of water, picking up refills, and reporting a missed or doubled dose to Godwins Family Care the same day.'),

    sub('Home and housekeeping — Daily living'),
    p('Light housekeeping, vacuuming, sweeping and mopping, dusting, cleaning the kitchen and bathroom, washing dishes, making the bed and changing linens, laundry and folding, taking out trash, tidying, and clearing trip hazards from walkways.'),

    sub('Errands and transportation — Daily living'),
    p('Grocery shopping with you or for you, pharmacy pickup, post office and bank trips, driving you to appointments, staying with you at the appointment, and helping you in and out of the car.'),

    sub('Companionship — Engagement'),
    p('Conversation, reading aloud, sorting and answering mail, games, hobbies, walks, attending church or community activities with you, setting up video calls with family, and gentle cues for the day, date, and routine.'),

    sub('Household support — Daily living'),
    p('Feeding and letting out pets, watering plants, answering the door and phone as you direct, checking that smoke and carbon monoxide detectors are working, and reporting anything in the home that needs repair.'),

    sub('Observation and reporting — Every visit'),
    p('A written note at every visit, and same-day reporting to Godwins Family Care of any change in your condition, mood, appetite, sleep, skin, mobility, or safety, and of any fall. Changes are escalated to you, your responsible party, and, where you have authorized it, your medical providers.'),

    sub('Supervision — Ongoing'),
    p('Care is delivered under the supervision of Godwins Family Care. A supervisory visit is conducted at the outset and at regular intervals thereafter, and your plan of care is reviewed and updated as your needs change.'),

    sub('What a caregiver does not do'),
    p('These services are non-medical. A caregiver does not administer or fill medication, give injections, test blood sugar or give insulin, perform wound or ostomy care, insert or change a catheter, manage tube feeding, take clinical measurements as a medical assessment, provide physical or occupational therapy, or make any clinical decision or diagnosis. A caregiver also does not perform heavy cleaning such as moving furniture, washing exterior windows, or yard work, does not lift alone beyond what is safe, does not care for other members of the household, and does not manage your money, accounts, or bill paying. If you need any of these, tell us and we will help you arrange it with a licensed clinician or the right provider under a separate agreement.'),

    h('3. Rates and Minimums'),
    data('rateTable', 'Your agreed rates'),
    p('**Caregiver travel.** Travel between the caregiver’s home and the client’s residence is not billed to the client and is not the client’s responsibility.'),
    p('**Rate changes.** Godwins Family Care will give at least thirty days written notice before any rate change. The client may end this agreement without penalty if a rate change is not acceptable.'),

    h('4. Schedule'),
    p('The schedule below is agreed at the start of service and may be adjusted in writing by mutual agreement. Hours and days are being finalized separately and will be attached as Schedule A. Service is scheduled in blocks of at least four hours on any day care is provided.'),
    data('schedule', 'Your schedule'),

    h('5. Billing and Payment'),
    sub('Invoicing'),
    p('Godwins Family Care invoices every two weeks for hours worked. Invoices are due within fourteen days of the invoice date.'),
    sub('Long term care insurance'),
    p('Where the client holds a long term care insurance policy, Godwins Family Care will provide the documentation the carrier requires, including invoices, visit records, and caregiver time verification, and will assist with the claim. The client remains responsible for payment of all invoices. Amounts the carrier declines, delays, or pays below the invoiced total remain the client’s responsibility.'),
    data('ltcPolicy', 'Your long term care policy'),
    sub('Late payment'),
    p('Accounts more than thirty days past due may result in suspension of service after written notice. Godwins Family Care will give reasonable notice and will not suspend care without first attempting to reach the client and the responsible party.'),

    h('6. Scheduling, Cancellation, and Coverage'),
    sub('Cancellation by the client'),
    p('Please give at least twenty four hours notice to cancel or change a scheduled visit. Visits cancelled with less than twenty four hours notice may be billed at the four hour daily minimum.'),
    sub('Coverage and continuity'),
    p('Godwins Family Care is responsible for staffing every scheduled visit. If the assigned caregiver is unavailable, Godwins Family Care will arrange a qualified substitute and notify the client in advance whenever possible.'),
    sub('Caregiver matching'),
    p('The client will meet a proposed caregiver before service begins and may decline the match at any time and request a different caregiver. Godwins Family Care will make reasonable efforts to maintain caregiver continuity.'),
    sub('Access to the home'),
    p('The client agrees to provide safe access to the residence and a safe working environment, including working smoke detectors, and to disclose any known hazard, firearm in the home, or animal that could affect caregiver safety.'),

    h('7. Our Caregivers'),
    sub('Employment and screening'),
    p('All caregivers are W2 employees of Godwins Family Care, not independent contractors. Each completes a criminal background check including fingerprint-based screening, abuse registry screening, exclusion list screening, reference and work history verification, tuberculosis screening, drug screening, and orientation and competency validation before providing care.'),
    sub('Insurance'),
    p('Godwins Family Care carries general liability, professional liability, and workers compensation coverage on its caregivers. The client is not the employer of the caregiver and has no payroll, tax, or workers compensation obligation.'),
    sub('Direct hiring'),
    p('The client agrees not to employ or engage, directly or through any other agency, any caregiver introduced by Godwins Family Care, during service and for twelve months after service ends. Recruiting, screening, training, and insuring caregivers is a substantial cost, and this provision protects that investment. If the client wishes to hire a caregiver directly, please raise it with Godwins Family Care and a release may be arranged.'),
    sub('Gifts, money, and property'),
    p('Caregivers may not accept gifts, loans, tips, or money from clients or families, may not be named in a client’s will or given power of attorney, and may not use a client’s vehicle, credit card, or accounts except as expressly authorized in writing for approved errands.'),
    sub('Concerns'),
    p('Any concern about a caregiver or the care provided should be reported to Godwins Family Care at ' + ORG.phone + ' or ' + ORG.email + '. Concerns are investigated promptly and the client will receive a response.'),

    h('8. Term and Termination'),
    sub('Term'),
    p('This agreement begins on the start date of service and continues until ended by either party.'),
    sub('Ending service'),
    p('The client may end this agreement at any time, for any reason, with fourteen days written notice. The client is responsible for services provided through the end date.'),
    p('Godwins Family Care may end this agreement with fourteen days written notice. Godwins Family Care may end service immediately, without the notice period, where a caregiver’s safety is at risk, where care needs exceed what may lawfully be provided under a private home care provider license, or where the account is materially past due after written notice.'),
    p('Where Godwins Family Care ends service, it will provide reasonable assistance in identifying alternative care resources.'),

    h('9. General Terms'),
    sub('Scope of the agreement, and what it is not'),
    // ANTI-KICKBACK. This is the tying language for a commonly-owned home care
    // agency and medical practice (Scope B8). It is never dropped or paraphrased.
    p('This agreement covers non-medical private home care only. It is not an agreement for medical or clinical care and creates no provider-patient relationship.'),
    p('It does not include and does not obligate the client to accept in-home primary care, nursing visits, medical treatment, prescribing, care coordination or chronic care management billed to Medicare or any other health plan, or any other clinical service. Each of those is a separate service under a separate written agreement with its own consents, and the client is free to choose any provider for any of them. Declining medical care from Godwins Family Care has no effect on the home care provided under this agreement, and accepting home care is never a condition of receiving medical care.'),
    sub('Records and privacy'),
    p('Godwins Family Care maintains a record of services provided. Client information is handled in accordance with the Notice of Privacy Practices provided with this agreement.'),
    sub('Governing law and entire agreement'),
    p('This agreement is governed by the laws of the State of Georgia. It is the entire agreement between the parties on this subject and replaces any prior understanding. Changes must be in writing and signed by both parties. If any provision is held unenforceable, the rest remains in effect.'),
    sub('Non-discrimination'),
    p('Godwins Family Care provides services without regard to race, color, religion, sex, sexual orientation, gender identity, national origin, age, disability, or veteran status.')
  ];

  // Document 2 of packet 1. The rate table is rendered from the client's own
  // record; without one this consent is not presentable at all (Scope B2) —
  // a client must never be able to sign a financial agreement with no price in it.
  const FINANCIAL_AGREEMENT = [
    p('Rates, billing, and cancellation, stated plainly and on one page. This repeats the money terms from your Service Agreement so nothing about cost is buried.'),
    h('1. What You Pay'),
    data('rateTable', 'Your agreed rates'),
    h('2. How You Are Billed'),
    sub('Invoices'),
    p('Every two weeks, for hours actually worked. Payment is due within fourteen days of the invoice date.'),
    sub('Cancellations'),
    p('Please give at least twenty four hours notice to cancel or change a visit. A visit cancelled with less notice may be billed at the four hour daily minimum.'),
    sub('Rate changes'),
    p('At least thirty days written notice before any change. If a new rate does not work for you, you may end service without penalty.'),
    sub('Past due accounts'),
    p('An account more than thirty days past due may result in suspension of service after written notice. We will try to reach you and your responsible party before any service is suspended.'),
    h('3. Long Term Care Insurance'),
    p('If you hold a long term care policy, we will give your carrier everything it asks for: invoices, visit records, caregiver time verification, and your plan of care. We will help you with the claim.'),
    p('What we cannot do is guarantee what the carrier pays. You remain responsible for every invoice. Anything the carrier declines, delays, or pays below the invoiced amount is still yours to pay.'),
    data('ltcPolicy', 'Your long term care policy')
  ];

  // Document 3 of packet 1. Intake Spec §2B: the state complaint numbers are
  // DISPLAYED here, not referenced.
  const BILL_OF_RIGHTS = [
    p('These rights belong to you. Nothing in any agreement with Godwins Family Care limits them.'),
    h('Your Rights'),
    ul([
      'To be treated with dignity, respect, and consideration, and to have your property treated with respect.',
      'To receive care without discrimination of any kind.',
      'To be free from verbal, physical, sexual, mental, and financial abuse, neglect, and exploitation.',
      'To be told, before care begins, what services will be provided, who will provide them, and what they will cost.',
      'To take part in planning your care, and to be told in advance of any change to your plan of care.',
      'To refuse any service, treatment, or caregiver, and to be told what refusing may mean for your care.',
      'To request a different caregiver at any time, for any reason.',
      'To privacy in your home and confidentiality of your personal and health information.',
      'To voice a complaint or concern without fear of retaliation, discrimination, or loss of service.',
      'To be told the name and qualifications of anyone providing your care.',
      'To have your property and residence respected, and to be free from solicitation for money, gifts, or loans.',
      'To reasonable notice before services are reduced or ended.',
      'To choose any provider you wish. Accepting home care from Godwins Family Care does not require you to use Godwins Family Care for any medical service.',
      'To formulate an advance directive and to have it honored to the extent permitted by law.',
      'To review your service record on request.'
    ]),
    h('Your Responsibilities'),
    ul([
      'To give accurate information about your health, medications, and living situation, and to tell us when things change.',
      'To take part in your plan of care and tell us when something is not working.',
      'To provide a safe home environment for your caregiver, including disclosing hazards, firearms, and animals.',
      'To treat your caregiver with respect and to refrain from asking a caregiver to perform tasks outside the plan of care.',
      'To give at least twenty four hours notice when cancelling or changing a scheduled visit.',
      'To meet the financial obligations set out in your service agreement.',
      'To tell us promptly about any concern with your care.'
    ]),
    h('How to Raise a Concern'),
    p('Call Godwins Family Care at **' + ORG.phone + '** or email **' + ORG.email + '**. We will acknowledge your concern, look into it, and respond. Raising a concern will never affect the care you receive.'),
    p('You also have the right to contact the State of Georgia directly at any time, without first contacting us.'),
    ul(STATE_CONTACTS)
  ];

  // Document 4 of packet 1 — the HOME CARE AGENCY notice. Rendered in full;
  // an acknowledgment of a notice the client was never shown does not satisfy
  // 45 CFR 164.520 (Scope B3).
  const NPP = [
    p('This notice describes how information about you may be used and disclosed, and how you can get access to this information. Please review it carefully.'),
    sub('This notice covers the home care agency'),
    p('It describes the privacy practices of the Godwins Family Care **private home care** agency. If you also receive In-Home Primary Care from our nurse practitioner, that medical practice issues its own separate Notice of Privacy Practices, which you would receive and acknowledge separately.'),
    h('Our Commitment'),
    p('Godwins Family Care LLC is required by law to protect the privacy of your health information, to give you this notice describing our legal duties and privacy practices, and to follow the terms of the notice currently in effect.'),
    h('How We May Use and Disclose Your Information'),
    sub('For your treatment and care'),
    p('We share your information with the caregivers and staff involved in your care, and with your physicians, nurse practitioners, pharmacies, and other providers, so that your care is coordinated and safe.'),
    sub('For payment'),
    p('We use your information to bill and receive payment, including submitting documentation to your long term care insurance carrier or another payer you have authorized.'),
    sub('For our operations'),
    p('We use your information to supervise caregivers, review quality of care, train staff, and run the business of the agency.'),
    sub('To family and others involved in your care'),
    p('Unless you object, we may share information relevant to your care with a family member, representative, or other person you have identified.'),
    sub('As required by law'),
    p('We may disclose information when required by law, including to health oversight agencies, for public health activities, in response to a court order, and to report suspected abuse, neglect, or exploitation. Georgia law requires our staff to report suspected abuse, neglect, or exploitation of an adult.'),
    sub('To prevent a serious threat'),
    p('We may disclose information when necessary to prevent a serious threat to your health or safety or to the health or safety of another person.'),
    sub('Uses that require your written authorization'),
    p('Most uses and disclosures not described above require your written authorization, including any marketing use and any sale of your information. We do not sell your information. You may revoke an authorization at any time in writing, and the revocation applies going forward.'),
    h('Your Rights Regarding Your Information'),
    ul([
      'To inspect and receive a copy of your record, in paper or electronic form.',
      'To ask us to correct information you believe is incorrect or incomplete.',
      'To receive a list of certain disclosures we have made of your information.',
      'To request that we limit how we use or share your information. We will consider every request and will accommodate reasonable ones.',
      'To ask that we contact you in a specific way or at a specific address.',
      'To receive a paper copy of this notice at any time, even if you agreed to receive it electronically.',
      'To be notified if a breach occurs that compromises the privacy or security of your information.',
      'To file a complaint if you believe your privacy rights have been violated. You will not be penalized or retaliated against for filing a complaint.'
    ]),
    h('Complaints and Contact'),
    p('To exercise any right above, or to file a complaint, contact the Privacy Officer at ' + ORG.name + ', ' + ORG.address + ', telephone ' + ORG.phone + ', email ' + ORG.email + '.'),
    p('You may also file a complaint with the Secretary of the U.S. Department of Health and Human Services, Office for Civil Rights. We will not retaliate against you for filing a complaint.'),
    p('We reserve the right to change this notice and to make the revised notice effective for information we already hold as well as information we receive in the future. A current copy will be provided on request.')
  ];

  // Document 6 of packet 1 (sections A, B, D–G; section C is roiFamily below).
  const PCA_SCOPE = [
    p('Please initial each section that applies and sign at the bottom.'),
    h('A. Consent to Personal Home Care'),
    p('I consent to receive **non-medical** personal home care services from Godwins Family Care LLC as described in the Home Care Service Agreement and my plan of care. I understand this is not consent to medical treatment and that no medical service is being provided under this packet. I understand these services are non-medical, that caregivers do not administer medication or perform skilled nursing tasks, and that I may refuse any service at any time.'),
    h('B. Personal Care Aide Scope'),
    p('I understand that a personal care aide provides reminders and support and observes and reports changes in my condition. An aide does not administer medication, perform any skilled nursing task, or make clinical decisions. If I need a service outside this scope, Godwins Family Care will tell me and will help me arrange it with a licensed clinician.'),
    h('C. Authorization to Share Information for Care Coordination'),
    p('I authorize Godwins Family Care to exchange information about my care with the people and organizations I list below, for the purpose of coordinating my care. This authorization remains in effect until I revoke it in writing.'),
    data('careCoordinationContacts', 'People and organizations you have authorized'),
    p('To authorize release of medical records from a specific provider or facility, complete the Authorization to Obtain Medical Records.'),
    h('D. Long Term Care Insurance Claim Assistance'),
    p('I authorize Godwins Family Care to communicate with my long term care insurance carrier and to provide the invoices, visit records, caregiver time verification, and plan of care documentation the carrier requires to process my claim. I understand that I remain responsible for payment of all invoices regardless of what the carrier pays.'),
    h('E. Photograph and Likeness'),
    p('Optional and entirely voluntary. Declining has no effect on your care. I consent to Godwins Family Care using my photograph, likeness, or story in its materials.'),
    choice('photoLikeness', 'Photograph and likeness', [
      { value: 'consent', label: 'I consent' },
      { value: 'decline', label: 'I do not consent' }
    ]),
    h('F. Advance Directive'),
    p('You have the right to make decisions about your medical care, including the right to accept or refuse treatment and to create an advance directive. Godwins Family Care does not require you to have one.'),
    data('advanceDirective', 'Your advance directive on file'),
    h('G. Emergency Information'),
    p('Emergency contacts, primary care provider, preferred hospital, pharmacy, and allergies are recorded on your Client Information Face Sheet, which forms part of this consent. Confirm they are correct rather than writing them again.'),
    data('faceSheetEmergency', 'Your emergency information')
  ];

  // Section C of the same source document. Scope B9: the substance is
  // acceptable as it stands, so the pre-4.6 wording is carried forward
  // unchanged. This consent continues to gate the family portal with no
  // manual override.
  const ROI_FAMILY = [
    p('I authorize Godwins Family Care LLC to share relevant health and care information with the family members and authorized contacts I designate, for the purpose of coordinating care and ensuring client safety. **This authorization is what unlocks the family portal**; it may be revoked in writing at any time.'),
    data('roiFamilyDetail', 'Who you have authorized')
  ];

  // Document 5 of packet 1. THE ONE-PASS EXCEPTION (Scope G4): this form leaves
  // the building and reaches an outside provider, so it must carry the client's
  // name and date of birth on its own rather than pointing at a face sheet the
  // recipient will never see.
  const ROI_PROVIDER = [
    p('This form authorizes one provider or facility to release your records to Godwins Family Care. Complete one page for each provider. This authorization is voluntary and is not a condition of receiving care.'),
    sub('Why the home care agency asks for records'),
    p('Records requested under this form are used to build a safe **home care** plan: to know your diagnoses, allergies, mobility limits, fall risk, and diet so your caregiver supports you correctly. This is not a request for medical treatment and does not enroll you in medical care.'),
    h('1. Client'),
    data('clientIdentity', 'Client name and date of birth'),
    h('2. Release From'),
    data('priorProviders', 'The provider or facility releasing records'),
    h('3. Release To'),
    p('**' + ORG.name + '**, ' + ORG.address + '. Telephone ' + ORG.phone + ', fax ' + ORG.fax + '.'),
    h('4. Information to Be Released'),
    p('History and physical · Progress and office notes · Discharge summary · Medication list · Laboratory results · Imaging reports · Immunization record · Consultation reports · Therapy notes, PT / OT / speech · Functional or ADL assessment · Advance directive or POLST · Face sheet and demographics · Entire record.'),
    h('5. Specially Protected Records'),
    p('Mental or behavioral health · Substance use treatment, 42 CFR Part 2 · HIV / AIDS related · Genetic testing · Sexually transmitted infection. These categories are released only where you have separately opted in; the opt-in defaults to off and is enforced when records are requested, not only on this page.'),
    h('6. Purpose, Expiration, and Your Rights'),
    sub('Purpose'),
    p('To coordinate my home care and plan of care with Godwins Family Care, and to support a long term care insurance claim where applicable.'),
    sub('Expiration'),
    p('This authorization expires one year from the date signed, unless I write a different date or event on the provider-specific authorization.'),
    sub('Right to revoke'),
    p('I may revoke this authorization at any time by writing to Godwins Family Care at the address above. Revoking it does not undo anything already done in reliance on it.'),
    sub('Redisclosure'),
    p('Information released under this authorization may no longer be protected by federal privacy law once received, and could be redisclosed by the recipient. Records protected under 42 CFR Part 2 may not be redisclosed without my further written permission.'),
    sub('Voluntary'),
    p('Signing this form is voluntary. Godwins Family Care will not condition my treatment, payment, enrollment, or eligibility for benefits on whether I sign it.'),
    sub('Copy'),
    p('I am entitled to a copy of this signed authorization.'),
    note('Each named provider gets its own signed authorization PDF. Complete the Transfer-of-Care Provider ROI in your portal to name providers and capture the signature that goes to them.')
  ];

  // Document 7 of packet 1. SCOPE B1 — HIGHEST PRIORITY, LICENSURE EXPOSURE.
  // The pre-4.6 body opened "In a medical emergency, I authorize emergency
  // treatment and transport as needed" — a consent to medical treatment, which
  // a private home care provider is not licensed to take, on a consent that is
  // REQUIRED for home-care-only clients. This body authorizes only summoning
  // 911, admitting responders, and sharing health information with them, and
  // says plainly that consent to treatment is given to the responders or the
  // hospital, never to Godwins Family Care.
  const EMERGENCY_FINANCIAL = [
    p('This document covers two things: what your caregiver does in an emergency, and who pays for what.'),
    sub('This is not a consent to medical treatment'),
    p('Signing this does not authorize Godwins Family Care to examine, diagnose, or treat you. Our caregivers are **not** clinicians and provide no medical care. This form authorizes one thing only: that in an emergency your caregiver may call 911 and give responders the information they need to help you.'),
    h('1. Authorization to Summon Emergency Help'),
    p('If I appear to be experiencing a medical emergency and I am unable to make or communicate a decision, I authorize Godwins Family Care staff to call 911, to allow emergency responders access to my home, and to give responders the health information they need to treat me safely, including my medications, allergies, conditions, and any advance directive on file.'),
    p('I understand that Godwins Family Care caregivers are not emergency responders and do not provide medical treatment of any kind. Their role is to summon help, keep me safe until help arrives, and notify my emergency contacts. Any treatment I receive is provided by the emergency responders, the hospital, or my own medical providers, and my consent to that treatment is given to them, not to Godwins Family Care.'),
    h('2. Advance Directive and Resuscitation Status'),
    p('Godwins Family Care caregivers follow emergency responder direction. A do-not-resuscitate order is honored by emergency responders only where a valid Georgia order is present in the home and produced at the time.'),
    data('advanceDirective', 'Your advance directive on file'),
    choice('codeStatus', 'Resuscitation status', [
      { value: 'full_code', label: 'Full code, no directive limiting treatment' },
      { value: 'directive_on_file', label: 'Advance directive on file with GFC' },
      { value: 'ga_dnr_in_home', label: 'Georgia DNR order in the home' },
      { value: 'polst_in_home', label: 'POLST or similar order in the home' }
    ]),
    h('3. Financial Responsibility for Emergency Care'),
    p('I understand that ambulance transport, emergency department care, hospital care, and any treatment provided by emergency responders or a hospital are billed by those providers, not by Godwins Family Care, and that I or my insurance am responsible for those charges. Godwins Family Care does not bill for, collect for, or control the cost of emergency services.'),
    h('4. Financial Responsibility for Home Care Services'),
    p('I am responsible for payment of all Godwins Family Care invoices at the rates set out in the Home Care Service Agreement. Where a long term care insurance carrier or other payer is involved, I understand that Godwins Family Care will assist with the claim but that the carrier’s decision is between the carrier and me. Amounts a carrier declines, delays, or pays below the invoiced total remain my responsibility.'),
    h('5. Responsible Party Guarantee, If Applicable'),
    p('Complete only if someone other than the client is accepting financial responsibility. A responsible party who signs below agrees to pay Godwins Family Care invoices that the client does not pay when due.'),
    data('responsibleParty', 'Responsible party on file')
  ];

  // Document 8 of packet 1. The pre-4.6 body was a single paragraph standing in
  // for a protocol (Scope B5).
  const CRISIS_PROTOCOL = [
    p('What your caregiver will do, and who they will call. Keep this page where you can find it.'),
    h('1. Medical Emergency'),
    p('Signs include chest pain, difficulty breathing, sudden weakness or trouble speaking, a fall with injury or a head strike, uncontrolled bleeding, seizure, or loss of consciousness.'),
    ul([
      'The caregiver calls **911** first and stays with the client.',
      'The caregiver calls Godwins Family Care at **' + ORG.phone + '**.',
      'Godwins Family Care notifies the emergency contact and, where authorized, the client’s medical providers.',
      'The caregiver does not move a client after a fall with suspected injury and does not administer medication.'
    ]),
    h('2. Urgent but Not an Emergency'),
    p('A change in condition that needs attention today but is not life threatening: new confusion, fever, refusal to eat or drink, a fall without apparent injury, a medication the client cannot locate, or a sudden change in mood or behavior.'),
    ul([
      'The caregiver calls Godwins Family Care at **' + ORG.phone + '** the same day.',
      'Godwins Family Care contacts the client’s primary care provider and the emergency contact.'
    ]),
    h('3. Mental Health or Emotional Crisis'),
    p('Thoughts of self-harm, severe distress, or a crisis affecting the client’s safety.'),
    p('The caregiver stays with the client where it is safe to do so, calls 988 or 911 as the situation requires, and notifies Godwins Family Care. Veterans and their families reach the Veterans Crisis Line by calling 988 and pressing 1.'),
    h('4. Fire, Weather, Power Loss, or Evacuation'),
    ul([
      'The caregiver gets the client to safety first, then calls 911 if needed.',
      'The caregiver calls Godwins Family Care so the family can be notified and coverage arranged.',
      'The client is asked to keep a two-day supply of essential medication and a working flashlight in a known place.'
    ]),
    h('5. No Answer at the Door'),
    p('If the caregiver arrives and cannot reach the client, the caregiver calls the client, then the emergency contact, then Godwins Family Care. Where there is reason to believe the client is inside and in distress, the caregiver calls 911 for a welfare check.'),
    h('6. Who We Call, and In What Order'),
    p('The call order, preferred hospital, primary care provider, entry instructions for responders, and pets in the home are recorded on your Client Information Face Sheet. Your caregiver carries that order. Confirm it is correct today, and tell us whenever it changes.'),
    data('callOrder', 'Your call order')
  ];

  // No paper source. Scope B9 / E1: the text stands, but while the consent is
  // flagged inactive it must not be signable at all.
  const MONITORING = [
    p('Optional. In a future release, Godwins Family Care may offer consent-gated in-home remote monitoring (activity and, where shared, video) viewable by your care team and, where you allow it, your family. This option is **inactive** today — recording your preference here does not start any monitoring.'),
    note('Because this service is not live, no signature is taken and no consent is executed. Your preference is recorded so we know whom to contact when it launches.')
  ];

  // ==========================================================
  // PACKET 2 — IN-HOME PRIMARY CARE
  // ==========================================================

  // Document 1 of packet 2. NEW in Scope A. Before this entry existed there was
  // no document anywhere that established the provider-patient relationship,
  // named the collaborating physician, or set clinical termination terms — a
  // clinical patient signed the home care agreement and nothing else.
  const IHPC_SERVICE_AGREEMENT = [
    p('This agreement sets out the **medical** care Godwins Family Care will provide in your home, who provides it, and what it costs. It is separate from your home care agreement and does not replace it.'),
    h('1. Parties'),
    data('parties', 'Patient and representative'),
    h('2. Who Provides Your Care'),
    p('Your care is delivered by a board-certified family nurse practitioner licensed in Georgia, working with a collaborating physician as Georgia law requires. You will be told the name and credentials of anyone who comes to your home before the visit.'),
    h('3. What In-Home Primary Care Includes'),
    sub('Medical visits in your home — Core service'),
    p('History and physical examination, vital signs, review of your conditions, and a written assessment and plan at every visit. Visits are scheduled; you are not seen on demand.'),
    sub('Diagnosis and treatment — Core service'),
    p('Evaluating new symptoms, diagnosing acute and chronic conditions, ordering and interpreting laboratory work and imaging, and treating what can safely be treated at home.'),
    sub('Prescribing and medication management — Core service'),
    p('Writing and renewing prescriptions, reviewing everything you take for interactions and duplication, simplifying a complicated regimen, and coordinating with your pharmacy.'),
    sub('Chronic disease management — Ongoing'),
    p('Regular management of conditions such as high blood pressure, diabetes, heart failure, COPD, arthritis, and cognitive change, with a schedule of follow-up matched to how you are doing.'),
    sub('Preventive care — Ongoing'),
    p('Vaccinations, screening recommendations appropriate to your age and health, fall risk assessment, and advance care planning conversations if you want them.'),
    sub('Referrals and coordination — Ongoing'),
    p('Referrals to specialists, coordination with your cardiologist or other physicians, hospital follow-up after a discharge, and orders for home health, therapy, or equipment where you qualify.'),
    sub('What this service is not'),
    p('It is not emergency care and not a substitute for 911. It is not twenty four hour coverage; the practice keeps business hours with an on-call line after hours. It is not Medicare home health, which is a separate benefit requiring a separate order and agency. It is not personal care, bathing, housekeeping, or companionship, which is your home care service under a separate agreement. And it does not require you to keep home care with Godwins Family Care, or to use us at all.'),
    h('4. Visits, Scheduling, and After Hours'),
    sub('Visit frequency'),
    p('Set with you based on your conditions and reviewed at each visit. Most patients are seen monthly to quarterly, with additional visits when something changes.'),
    sub('Between visits'),
    p('Call ' + ORG.phone + ' during business hours for questions, medication problems, or a new symptom. After hours the line reaches on-call. If the problem is urgent and you cannot reach us, call 911 or go to the emergency department. Do not wait for a return call.'),
    sub('Missed visits'),
    p('Please give twenty four hours notice if you need to reschedule. Repeated missed visits without notice may end this agreement.'),
    h('5. Cost'),
    p('Visits are billed to Medicare or your health plan. What you owe depends on your coverage: a deductible that has not been met, a coinsurance or copay amount, and anything your plan does not cover. The Assignment of Benefits and Financial Responsibility document sets this out in full and assigns your benefits to Godwins Family Care.'),
    p('You will be told in advance, in writing, before any service that your plan is not expected to cover. You are never billed for a service you were not warned about.'),
    data('coverage', 'Your coverage on file'),
    h('6. Records and Communication'),
    p('Your medical record is kept in the practice’s electronic health record. You may request a copy at any time. How the practice uses and protects your information is described in the medical practice Notice of Privacy Practices, which is separate from the home care agency notice you already received.'),
    h('7. Ending This Agreement'),
    p('You may end medical care at any time, for any reason, with no effect on your home care. Godwins Family Care may end this agreement with thirty days written notice, during which urgent needs are still covered, and will provide your records and reasonable help finding another provider.'),
    p('Ending this agreement does not end your home care. Ending your home care does not end this agreement. They are independent.')
  ];

  // Document 2 of packet 2. The pre-4.6 body was a single sentence for a
  // clinical treatment consent (Scope B6). The telehealth and student elections
  // are stored as their own fields on the consent record — never buried in the
  // signature, where nobody could later tell what the patient actually chose.
  const CONSENT_TO_TREAT = [
    p('Please initial each section and sign at the bottom. You may refuse any part of this and still receive care.'),
    h('A. Consent to Evaluation and Treatment'),
    p('I consent to medical evaluation and treatment by the Godwins Family Care nurse practitioner and collaborating physician, in my home. I understand this includes taking my history, physical examination, vital signs, and developing and carrying out a plan of care with me.'),
    h('B. Procedures and Testing'),
    p('I consent to routine services performed in the home as part of my care: drawing blood and collecting specimens, point of care testing such as blood sugar or urine testing, electrocardiogram, wound assessment and dressing, vaccinations and injections that are ordered for me, and ordering laboratory work and imaging performed elsewhere.'),
    p('Anything beyond routine will be explained to me first, including why it is recommended, what it involves, the risks, and what happens if I decline.'),
    h('C. Prescribing and Medication Management'),
    p('I consent to the nurse practitioner prescribing, adjusting, and discontinuing my medications, reviewing everything I take, and communicating with my pharmacy and my other prescribers. I agree to tell the practice about every medication and supplement I take, including anything prescribed by another provider.'),
    h('D. Telehealth'),
    p('Optional. I consent to some visits being conducted by video or telephone where clinically appropriate. I understand a telehealth visit has limits, that the provider may require an in-person visit instead, and that I may ask for an in-person visit at any time.'),
    choice('telehealth', 'Telehealth', [
      { value: 'consent', label: 'I consent to telehealth visits' },
      { value: 'decline', label: 'In-person visits only' }
    ]),
    h('E. Students and Trainees'),
    p('Optional and entirely voluntary. Declining has no effect on your care. Godwins Family Care hosts nursing and medical students under direct supervision. I consent to a supervised student being present and taking part in my care.'),
    choice('students', 'Students and trainees', [
      { value: 'consent', label: 'I consent' },
      { value: 'decline', label: 'I do not consent' }
    ]),
    h('F. What I Understand'),
    ul([
      'No one has guaranteed me any particular result. Medicine involves judgment, and outcomes cannot be promised.',
      'I may refuse any examination, test, treatment, or medication, at any time, and I will be told what refusing may mean for my health.',
      'I may ask for a second opinion or transfer my care to another provider at any time.',
      'This consent stays in effect for my ongoing care until I revoke it in writing.',
      'This is not emergency care. In an emergency I call 911.'
    ])
  ];

  // Document 3 of packet 2. Scope B7: the pre-4.6 body assigned benefits and
  // never said what the patient owes.
  const ASSIGNMENT_OF_BENEFITS = [
    p('This lets Godwins Family Care bill Medicare or your health plan directly, and sets out what you owe.'),
    h('1. Your Coverage'),
    data('coverage', 'Your coverage on file'),
    h('2. Assignment of Benefits'),
    p('I assign to ' + ORG.name + ' all benefits payable to me under Medicare and any other health plan for services the practice provides, and I direct that payment be made directly to Godwins Family Care rather than to me. This assignment applies to current and future claims until I revoke it in writing.'),
    h('3. Authorization to Release Information for Claims'),
    p('I authorize Godwins Family Care to release the medical information necessary to determine benefits and process claims to the Centers for Medicare and Medicaid Services, my health plan, and their agents. This includes the diagnosis and service records a claim requires.'),
    h('4. What You Owe'),
    p('Assigning your benefits does not mean nothing is owed. You remain responsible for:'),
    ul([
      'Any deductible you have not yet met for the year.',
      'Your coinsurance or copay, which for Medicare Part B is typically twenty percent of the approved amount unless a supplemental plan covers it.',
      'Services your plan does not cover, but only where you were told in advance and in writing and chose to proceed.',
      'Charges your plan denies because coverage lapsed, information was not provided, or the plan’s requirements were not met.'
    ]),
    p('Statements are sent after your plan processes the claim. Balances are due within thirty days of the statement date. If a balance is difficult, call the office before it goes past due and a payment arrangement can usually be made.'),
    h('5. Advance Notice of Non-Covered Services'),
    p('If the practice believes Medicare will not pay for something recommended, you will be given a written notice before it is provided, explaining what it is, why it may not be covered, and the estimated cost. You then decide whether to proceed. You are never held responsible for a non-covered service you were not warned about in advance.'),
    h('6. Responsible Party, If Applicable'),
    p('Complete only if someone other than the patient is accepting financial responsibility for balances after insurance.'),
    data('responsibleParty', 'Responsible party on file')
  ];

  // Document 4 of packet 2 — the MEDICAL PRACTICE notice, separate from the
  // home care agency notice. Rendered in full (Scope B3).
  const PRACTICE_NPP = [
    p('This notice describes how medical information about you may be used and disclosed by the In-Home Primary Care practice, and how you can get access to it. Please review it carefully.'),
    sub('Why you are receiving a second privacy notice'),
    p('You already received a Notice of Privacy Practices from the Godwins Family Care **home care agency**. This one is different. It covers the **medical practice**, which keeps a clinical record, bills health plans, and exchanges information with other treating providers. Both notices apply to you, each to its own service.'),
    h('Our Commitment'),
    p('The practice is required by law to protect the privacy of your protected health information, to give you this notice of our legal duties and privacy practices, and to follow the terms of the notice currently in effect.'),
    h('How We Use and Disclose Your Information'),
    sub('Treatment'),
    p('We share your information with the clinicians involved in your care and with specialists, hospitals, laboratories, imaging centers, pharmacies, home health agencies, and other providers treating you, so that your care is coordinated and safe. This includes sharing with the Godwins Family Care home care agency where it affects your safety at home.'),
    sub('Payment'),
    p('We use and disclose your information to bill and receive payment from Medicare, your health plan, and any secondary payer, including submitting diagnoses, service records, and documentation supporting a claim.'),
    sub('Health care operations'),
    p('We use your information to review quality of care, evaluate clinician performance, train students and staff, conduct audits, and run the practice.'),
    sub('Appointment reminders and health information'),
    p('We may contact you to remind you of a visit, to follow up on a result, or to tell you about a treatment alternative or health service that may benefit you.'),
    sub('Family and others involved in your care'),
    p('Unless you object, we may share information relevant to your care with a family member, representative, or other person you have identified, and with anyone you have authorized on a release of information.'),
    sub('As required by law'),
    p('We disclose information when the law requires it, including to public health authorities, health oversight agencies, in response to a court order or subpoena, for reporting suspected abuse, neglect, or exploitation of an adult as Georgia law requires, and to report certain communicable diseases and vital events.'),
    sub('To prevent a serious threat'),
    p('We may disclose information when necessary to prevent a serious threat to your health or safety or that of another person.'),
    sub('Uses requiring your written authorization'),
    p('Psychotherapy notes, any marketing use, and any sale of your information require your written authorization. We do not sell your information. You may revoke an authorization in writing at any time, effective going forward.'),
    h('Your Rights'),
    ul([
      'To inspect and receive a copy of your medical record, in paper or electronic form.',
      'To ask us to amend information you believe is incorrect or incomplete.',
      'To receive an accounting of certain disclosures we have made.',
      'To request a restriction on how we use or share your information. We must honor a request to withhold information from your health plan about a service you paid for in full yourself.',
      'To ask that we contact you in a specific way or at a specific address.',
      'To receive a paper copy of this notice at any time.',
      'To be notified if a breach compromises the privacy or security of your information.',
      'To file a complaint without any penalty or retaliation.'
    ]),
    h('Complaints and Contact'),
    p('To exercise any right above, or to file a complaint, contact the Privacy Officer at ' + ORG.name + ', ' + ORG.address + ', telephone ' + ORG.phone + ', email ' + ORG.email + '.'),
    p('You may also file a complaint with the Secretary of the U.S. Department of Health and Human Services, Office for Civil Rights. We will not retaliate against you for filing a complaint.'),
    p('We reserve the right to change this notice and to make the revised notice effective for information we already hold as well as information we receive in the future. A current copy will be provided on request.')
  ];

  // ==========================================================
  // THE REGISTRY OF BODIES
  //
  // `paperSource` names the paper document each entry maps to, so a reviewer
  // can put the app text and the packet side by side.
  // ==========================================================
  const BODIES = {
    // Both lanes
    npp:                  { title: 'HIPAA Notice of Privacy Practices',                 paperSource: 'Packet 1, Document 4',  blocks: NPP },
    roiFamily:            { title: 'Release of Information — Family',                   paperSource: 'Packet 1, Document 6 §C', blocks: ROI_FAMILY },
    roiProvider:          { title: 'Release of Information — Providers',                paperSource: 'Packet 1, Document 5',  blocks: ROI_PROVIDER },
    billOfRights:         { title: 'Patient Bill of Rights & Self-Determination',       paperSource: 'Packet 1, Document 3',  blocks: BILL_OF_RIGHTS },
    emergencyFinancial:   { title: 'Emergency Response and Financial Responsibility',   paperSource: 'Packet 1, Document 7',  blocks: EMERGENCY_FINANCIAL },
    crisisProtocol:       { title: 'Emergency & Crisis Protocol (911/988)',             paperSource: 'Packet 1, Document 8',  blocks: CRISIS_PROTOCOL },
    monitoring:           { title: 'Continuous Monitoring Opt-In',                      paperSource: 'No paper source',      blocks: MONITORING },
    // Private Home Care
    serviceAgreement:     { title: 'Service Agreement',                                 paperSource: 'Packet 1, Document 1',  blocks: SERVICE_AGREEMENT },
    financialAgreement:   { title: 'Financial Agreement (rates, billing, cancellation)', paperSource: 'Packet 1, Document 2', blocks: FINANCIAL_AGREEMENT },
    pcaScope:             { title: 'Personal Care Aide Scope Acknowledgment',           paperSource: 'Packet 1, Document 6',  blocks: PCA_SCOPE },
    // In-Home Primary Care
    ihpcServiceAgreement: { title: 'In-Home Primary Care Services Agreement',           paperSource: 'Packet 2, Document 1',  blocks: IHPC_SERVICE_AGREEMENT },
    consentToTreat:       { title: 'Consent to Medical Treatment',                      paperSource: 'Packet 2, Document 2',  blocks: CONSENT_TO_TREAT },
    assignmentOfBenefits: { title: 'Assignment of Benefits and Financial Responsibility', paperSource: 'Packet 2, Document 3', blocks: ASSIGNMENT_OF_BENEFITS },
    practiceNpp:          { title: 'Medical Practice Notice of Privacy Practices',      paperSource: 'Packet 2, Document 4',  blocks: PRACTICE_NPP }
  };

  // ==========================================================
  // ARCHIVE — superseded body versions.
  //
  // A signed consent renders the text it was signed against, forever. These are
  // the pre-4.6 placeholder stubs; anything already carrying version 'draft-1'
  // reproduces its own stub rather than borrowing the packet text it never saw.
  // Never delete an archived version while a signature still points at it.
  // ==========================================================
  const ARCHIVE = {};
  ARCHIVE[V1] = {
    npp: [p('This notice describes how medical information about you may be used and disclosed and how you can get access to this information. We are required by law to maintain the privacy of your protected health information and to provide you with this notice of our legal duties and privacy practices.'), p('By acknowledging below, you confirm you have received and had the opportunity to review our HIPAA Notice of Privacy Practices.')],
    roiFamily: [p('I authorize Godwins Family Care LLC to share relevant health and care information with the family members and authorized contacts I designate, for the purpose of coordinating care and ensuring client safety. **This authorization is what unlocks the family portal**; it may be revoked in writing at any time.')],
    roiProvider: [p('I authorize Godwins Family Care LLC to exchange relevant health information with the client’s medical providers, pharmacies, and other treating clinicians for the purpose of coordinating care. This authorization does not extend to any party not involved in the client’s care.')],
    serviceAgreement: [p('**Godwins Family Care LLC** delivers care through two service lines. **Private Home Care** provides non-medical personal care and companionship, including assistance with activities of daily living and medication reminders, and, where ordered, skilled nursing delivered by licensed nurses under the oversight of our family nurse practitioner or supervising physician. **In-Home Primary Care** provides medical visits, assessment, prescribing, and chronic disease management led by a nurse practitioner.'), p('Personal care aides provide reminders and support and observe and report changes in condition. They do not administer medication or make clinical decisions. Skilled nursing and medical services are provided only by appropriately licensed clinicians and only as set out in your care plan.'), p('Your care plan is developed with you, your family, and your care team, and is reviewed periodically. Please report any change in condition or care needs promptly so the plan can be updated.')],
    billOfRights: [p('You have the right to be treated with dignity and respect; to participate in your care planning; to be informed of your care and any changes; to voice grievances without retaliation; and to make decisions about your care, including the right to accept or refuse treatment. Georgia residents may contact the state licensing and complaint line for concerns about care.')],
    emergencyFinancial: [p('In a medical emergency, I authorize emergency treatment and transport as needed. I understand that I (or the responsible party) am financially responsible for the cost of emergency transport and treatment that is not otherwise covered by insurance or other benefits.')],
    crisisProtocol: [p('In the event of a medical or behavioral emergency, Godwins Family Care caregivers are authorized to call 911 or 988 (Suicide & Crisis Lifeline) as appropriate, and will immediately notify the primary family contact. Caregivers follow established safety protocols and document all incidents.')],
    monitoring: MONITORING,
    financialAgreement: [p('I understand the rates, billing cycle, and cancellation policy for personal care services as provided by Godwins Family Care, and I agree to be responsible for charges as set out in my care plan and service schedule.')],
    pcaScope: [p('I understand that personal care aides provide reminders, support, and observation, and that they do **not** administer medication or make clinical decisions. Skilled and medical tasks are performed only by appropriately licensed clinicians as ordered in the care plan.')],
    consentToTreat: [p('I consent to medical evaluation and treatment provided by the nurse practitioner and clinical team of Godwins Family Care’s In-Home Primary Care service, consistent with the plan of care.')],
    assignmentOfBenefits: [p('I assign to Godwins Family Care LLC the right to receive payment of Medicare and/or insurance benefits otherwise payable to me for services rendered, and authorize the release of information necessary to process these claims.')],
    practiceNpp: [p('I acknowledge receipt of the In-Home Primary Care practice’s Notice of Privacy Practices, describing how my medical information may be used and disclosed by the medical practice.')]
  };

  // ---------- read API (identical in Node and the browser) ----------

  const types = () => Object.keys(BODIES);

  const titleFor = (type) => (BODIES[type] && BODIES[type].title) || type;

  const paperSourceFor = (type) => (BODIES[type] && BODIES[type].paperSource) || null;

  // The version a NEW signature is stamped with. Every ported consent shares V2.
  const currentVersion = (type) => (BODIES[type] ? V2 : null);

  // The body a consent record should render. Pass the version stored on the
  // record; omit it to get the current text. An unknown version falls back to
  // the current body and is reported by `isArchived` so a reader is never shown
  // text silently attributed to the wrong version.
  const bodyFor = (type, version) => {
    if (!BODIES[type]) return [];
    if (!version || version === V2) return BODIES[type].blocks;
    const archived = ARCHIVE[version] && ARCHIVE[version][type];
    return archived || BODIES[type].blocks;
  };

  const hasArchivedBody = (type, version) =>
    !!(version && version !== V2 && ARCHIVE[version] && ARCHIVE[version][type]);

  // The elections a consent records as their own fields. A consent whose choice
  // is unanswered cannot be signed — see the sign endpoint in server.js.
  const choicesFor = (type) =>
    bodyFor(type).filter(b => b.t === 'choice');

  // The client-record values a consent renders (one-pass rule, Scope G4).
  const dataSourcesFor = (type) =>
    bodyFor(type).filter(b => b.t === 'data').map(b => b.source);

  return {
    ORG, STATE_CONTACTS,
    CURRENT_VERSION: V2,
    LEGACY_VERSION: V1,
    BODIES, ARCHIVE,
    types, titleFor, paperSourceFor, currentVersion,
    bodyFor, hasArchivedBody, choicesFor, dataSourcesFor
  };
});
