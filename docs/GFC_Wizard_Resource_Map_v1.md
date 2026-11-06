# GFC NP Onboarding Wizard · Resources and Drive Links

**Version 1.2 · November 6, 2026 (11:45 AM) · For the wizard build chat**
Replaces v1.1. Every link below was re-checked against GFC Drive at 11:45 AM on November 6, 2026.
Pairs with: GFC_Clinical_Onboarding_Playbook_v1.md (items and gates) and GFC_NP_Training_Library_v1.md (modules).
Source of truth for links going forward: **GFC Team README (Start Here)**, docs.google.com/document/d/1BrANo-fKoY2tW_8dDDjR9ykUddsp1spCQcrn3yFJrIk

---

## 1. Rules the wizard follows for documents

1. **The wizard stores the Drive link, never a copy of the file.** Edit the Google Doc and the wizard shows the new text the next time someone opens it.
2. **Signing happens in the app, not in the Google Doc.** The person opens the doc from the wizard, then signs or acknowledges on the wizard screen.
3. **Every signature records the version it was signed against**: the version label plus the Drive modified time at the moment of signing.
4. **Bumping a version label re-prompts everyone who signed the older version.** Typo fixes don't change the label, so nobody is re-prompted for those.
5. **Contractor-specific exam resources carry a `contractor` tag.** The wizard shows them only when that contractor is assigned to the clinician. Contractor names live in resource records and Drive, never in the playbook text.
6. **If a link fails to open** (no access, file moved), the wizard shows "Ask Bianca or Kate for access" and flags it on the Admin Hub. It never blocks the whole wizard.

### Resource record

| Field | Notes |
|---|---|
| `id` | `RES-` + number. Never renumbered |
| `title` | Display name |
| `url` | Drive link, view mode |
| `file_type` | `GDOC`, `PDF`, `DOCX`, `HTML`, `VIDEO`, `FOLDER` |
| `version` | Matches the version printed in the doc |
| `action` | `READ`, `ACKNOWLEDGE`, `SIGN`, `ATTEST_WITH_CHECKS`, `UPLOAD_CERTIFICATE`, `COMPLETE_EXTERNAL`, `REFERENCE` |
| `audience` | Role, relationship, lane, and contractor filters |
| `wizard_step` | `WELCOME`, `CORE_PAPERWORK`, `TRAINING`, `EXAMS`, `REFERENCE_SHELF` |
| `playbook_item` | ID from the playbook |
| `module` | ID from the training library |
| `countersign` | Role that countersigns, if any |
| `required` | `true` blocks the gate it feeds. `false` sits on the Reference shelf |

---

## 2. What Thanmayie sees, in wizard order

### Step 1 · WELCOME

| ID | Resource | Link | Type | Action | Feeds |
|---|---|---|---|---|---|
| RES-01 | Team Onboarding Deck | https://drive.google.com/file/d/1A2HQ4BlUUxjTkX7hVysT1iERuZv96jt1/view | HTML | READ | TRN-001 |
| RES-02 | Team Roles and Responsibilities v2 | https://drive.google.com/file/d/1Z6v89NQvbcY7yBmixo8hw-LIPQ3YE5yc/view | PDF | ACKNOWLEDGE | CORE-13, TRN-002 |

### Step 2 · CORE PAPERWORK

| ID | Resource | Link | Type | Action | Who | Feeds |
|---|---|---|---|---|---|---|
| RES-03 | Employee Handbook v2.0 | https://docs.google.com/document/d/1ZOdrECrlD1C7k5byIyE77K5XFT7fypz3bEnBbvHV-eU/view | GDOC | READ | W2, Hybrid | CORE-12 |
| RES-04 | Employee Handbook Acknowledgment v2.0 | https://docs.google.com/document/d/1ZAg8Ki1oRVHKLMp7dPyGM8rs41I_4slHZLLw1czoHVk/view | GDOC | SIGN | W2, Hybrid | CORE-12 |
| RES-05 | Staff Code of Conduct v2.0 | https://docs.google.com/document/d/1LPwApafMaKYwe37JVYV95GUo-QgOFkCv4vEFVQwPNnA/view | GDOC | SIGN | Everyone | CORE-11 |
| RES-06 | Field Addendum to the Staff Code of Conduct v1.0 | https://docs.google.com/document/d/1E_AbrZWagGWYyGgerji3Sf5-zEBXUf5G_Rbl9kRQ9Hs/view | GDOC | SIGN | Anyone entering a home or facility | CORE-11 |
| n/a | Employment and contractor agreements, NDA | Contracts, being cleaned up separately | | SIGN | | CORE-03, 04, 10 |

### Step 3 · TRAINING

| ID | Resource | Link | Type | Action | Countersign | Feeds |
|---|---|---|---|---|---|---|
| RES-07 | HIPAA and Confidentiality Training Acknowledgment v2.0 | https://docs.google.com/document/d/1hHrVZalxuGVqmM53yL0aV8sS2MGkt4fMNp0qyLYhCGY/view | GDOC | SIGN, after TRN-005 | | CORE-14 |
| RES-08 | Clinical Policies and Procedures (IHPPC) v2.0 | https://drive.google.com/file/d/1R9PhvBNaqmebOKKm_i6kPbGd5DK0OAVU/view | DOCX, convert to GDOC | ATTEST_WITH_CHECKS | Clinical Director | CLIN-16, CLIN-17, TRN-006 |
| RES-09 | Clinical SOPs, Set 1 v1.0 | Add after upload | GDOC | ATTEST_WITH_CHECKS, one SOP per module | Clinical Director | CLIN-16, TRN-003 to TRN-209 |

**The Home-Based Clinical Care SOP requirement is met by RES-08 plus RES-09.** No separate document by that name exists anywhere in Drive. The v2.0 manual (Section 28) supersedes the earlier clinical policy documents. The playbook's CLIN-16 item now points to these two resources.

### Step 4 · EXAMS (exams lane only, filtered by assigned contractor)

| ID | Resource | Link | Type | Action | Contractor tag | Feeds |
|---|---|---|---|---|---|---|
| RES-20 | Provider screening application (blank) | https://drive.google.com/file/d/1T6KdyfsHwEqClVwG8hc1v3__LntRdYt2/view | PDF | COMPLETE_EXTERNAL, then upload the signed copy | `VES` | EXM-02 |
| RES-21 | Network Examiner Handbook | https://drive.google.com/file/d/1QGB8dvQdJaZS7EJcSBakYVJjEpWoBhfn/view | PDF | READ | `LSGS` | EXM-05 |
| RES-22 | SOP: Abnormal Findings | https://drive.google.com/file/d/1iONq4GwTKaMBxPffVSqhWOBWw3T4pu53/view | PDF | ATTEST_WITH_CHECKS | all | TRN-105, SOP-EXM-01 |
| RES-23 | Attachment M: Rules for Diagnostic and Ancillary Tests | https://drive.google.com/file/d/1EW0mTsLcuITnoAwxHfK7Vt8X0Npkn2Ow/view | PDF | READ | all | TRN-104 |
| RES-24 | Ancillary Item Purchase Links | https://drive.google.com/file/d/1Q8cWNBRMXow3oPI2qvvuP68PgIVMSyeb/view | PDF | REFERENCE | all | TRN-104 |
| n/a | VA disability examination training (about 20 hours) | Link comes from the contractor after screening clears | External | UPLOAD_CERTIFICATE per module | all | EXM-04, TRN-102 |
| n/a | Contractor's own training | Link comes from the contractor | External | UPLOAD_CERTIFICATE | per contractor | EXM-05, TRN-103 |

The exams step stays locked until EXM-01 (exam scope set) is done. Resources tagged with a contractor only show when that contractor is assigned.

### Reference shelf (always available, nothing to sign)

| ID | Resource | Link | Type | Notes |
|---|---|---|---|---|
| RES-30 | GFC Team README (Start Here) | https://docs.google.com/document/d/1BrANo-fKoY2tW_8dDDjR9ykUddsp1spCQcrn3yFJrIk/view | GDOC | Pin at the top of the shelf |
| RES-31 | Regulatory Compliance Reference | https://docs.google.com/document/d/1jJQSsrs1rEoEcNRNghINouwAZGct2hrjLM-betf7Du8/view | GDOC | Last updated Aug 1, 2026. Check it against v2.0 before relying on it |
| RES-32 | Clinical Billing Plan: Enrollment to Claims | https://docs.google.com/document/d/16zJq__jdYeVje8D96pJfc-Wblc_VmDk_fUqVTgku7rM/view | GDOC | Background for SOP-BIL-01 |
| RES-33 | Quo Phone Tree Setup | https://drive.google.com/file/d/1actG1vaO5IKWgHd5AqjMnjmR2gcX_Z5E/view | PDF | Shows the clinical line and who picks up |
| RES-34 | Lab Test Menu | https://drive.google.com/file/d/1Rl--cdg0MjwafV_lobT5-kNJjqw6MYLA/view | PDF | What we can draw and send. Pairs with TRN-206 and SOP-ORD-01 |
| RES-35 | Continuous Care Program (CCM) | https://drive.google.com/file/d/1t39l8PijHMepC83zVUOY6U21vgQOdP8b/view | PDF | What patients are told about care management. Pairs with TRN-213 |
| RES-36 | Patient Journey Infographic | https://drive.google.com/file/d/1kxXTqyLO3b_equPW1vkd3ar0NxoEY3iF/view | PDF | How a patient moves from referral to care. Pairs with TRN-201 |

### Not shown to NPs

| Resource | Why |
|---|---|
| Administrative and Business Operations P&P v2.0 | The manuals say each person follows the manual for their own work. This one is for admin, coordination, and outreach roles |
| Private Home Care P&P v3.0, home care videos, Client Service Packet | Caregiver and home care track |
| Billing Setup Guide v4.1 | Billing staff tool |
| OpenEMR Master Setup Guide v4.1 | Server build document. Clinicians never use OpenEMR directly. Keep it in 09 Systems & Tech, restricted |
| Hiring and Screening Protocol, PCA Job Posting | Hiring staff tools |

---

## 3. Seed data for the build

```json
[
  {"id":"RES-01","title":"Team Onboarding Deck","url":"https://drive.google.com/file/d/1A2HQ4BlUUxjTkX7hVysT1iERuZv96jt1/view","file_type":"HTML","version":"2026-11","action":"READ","audience":{"roles":["*"]},"wizard_step":"WELCOME","module":"TRN-001","required":true},
  {"id":"RES-02","title":"Team Roles and Responsibilities","url":"https://drive.google.com/file/d/1Z6v89NQvbcY7yBmixo8hw-LIPQ3YE5yc/view","file_type":"PDF","version":"v2","action":"ACKNOWLEDGE","audience":{"roles":["*"]},"wizard_step":"WELCOME","playbook_item":"CORE-13","module":"TRN-002","required":true},
  {"id":"RES-03","title":"Employee Handbook","url":"https://docs.google.com/document/d/1ZOdrECrlD1C7k5byIyE77K5XFT7fypz3bEnBbvHV-eU/view","file_type":"GDOC","version":"v2.0","action":"READ","audience":{"relationship":["W2","HYBRID"]},"wizard_step":"CORE_PAPERWORK","playbook_item":"CORE-12","required":true},
  {"id":"RES-04","title":"Employee Handbook Acknowledgment","url":"https://docs.google.com/document/d/1ZAg8Ki1oRVHKLMp7dPyGM8rs41I_4slHZLLw1czoHVk/view","file_type":"GDOC","version":"v2.0","action":"SIGN","audience":{"relationship":["W2","HYBRID"]},"wizard_step":"CORE_PAPERWORK","playbook_item":"CORE-12","pairs_with":"RES-03","required":true},
  {"id":"RES-05","title":"Staff Code of Conduct","url":"https://docs.google.com/document/d/1LPwApafMaKYwe37JVYV95GUo-QgOFkCv4vEFVQwPNnA/view","file_type":"GDOC","version":"v2.0","action":"SIGN","audience":{"roles":["*"]},"wizard_step":"CORE_PAPERWORK","playbook_item":"CORE-11","required":true},
  {"id":"RES-06","title":"Field Addendum to the Staff Code of Conduct","url":"https://docs.google.com/document/d/1E_AbrZWagGWYyGgerji3Sf5-zEBXUf5G_Rbl9kRQ9Hs/view","file_type":"GDOC","version":"v1.0","action":"SIGN","audience":{"field_staff":true},"wizard_step":"CORE_PAPERWORK","playbook_item":"CORE-11","required":true},
  {"id":"RES-07","title":"HIPAA and Confidentiality Training Acknowledgment","url":"https://docs.google.com/document/d/1hHrVZalxuGVqmM53yL0aV8sS2MGkt4fMNp0qyLYhCGY/view","file_type":"GDOC","version":"v2.0","action":"SIGN","audience":{"roles":["*"]},"wizard_step":"TRAINING","playbook_item":"CORE-14","module":"TRN-005","unlocks_after":["TRN-005"],"required":true},
  {"id":"RES-08","title":"Clinical Policies and Procedures (IHPPC)","url":"https://drive.google.com/file/d/1R9PhvBNaqmebOKKm_i6kPbGd5DK0OAVU/view","file_type":"DOCX","version":"v2.0","action":"ATTEST_WITH_CHECKS","countersign":"CLINICAL_DIRECTOR","audience":{"family":["LICENSED_CLINICAL"]},"wizard_step":"TRAINING","playbook_item":"CLIN-17","module":"TRN-006","required":true},
  {"id":"RES-09","title":"Clinical SOPs, Set 1","url":"","file_type":"GDOC","version":"v1.0","action":"ATTEST_WITH_CHECKS","countersign":"CLINICAL_DIRECTOR","audience":{"family":["LICENSED_CLINICAL"]},"wizard_step":"TRAINING","playbook_item":"CLIN-16","required":true},
  {"id":"RES-20","title":"Provider Screening Application","url":"https://drive.google.com/file/d/1T6KdyfsHwEqClVwG8hc1v3__LntRdYt2/view","file_type":"PDF","version":"blank","action":"COMPLETE_EXTERNAL","audience":{"lanes":["EXAMS"],"contractor":["VES"]},"wizard_step":"EXAMS","playbook_item":"EXM-02","required":true},
  {"id":"RES-21","title":"Network Examiner Handbook","url":"https://drive.google.com/file/d/1QGB8dvQdJaZS7EJcSBakYVJjEpWoBhfn/view","file_type":"PDF","version":"current","action":"READ","audience":{"lanes":["EXAMS"],"contractor":["LSGS"]},"wizard_step":"EXAMS","playbook_item":"EXM-05","required":true},
  {"id":"RES-22","title":"SOP: Abnormal Findings","url":"https://drive.google.com/file/d/1iONq4GwTKaMBxPffVSqhWOBWw3T4pu53/view","file_type":"PDF","version":"current","action":"ATTEST_WITH_CHECKS","audience":{"lanes":["EXAMS"]},"wizard_step":"EXAMS","module":"TRN-105","required":true},
  {"id":"RES-23","title":"Attachment M: Rules for Diagnostic and Ancillary Tests","url":"https://drive.google.com/file/d/1EW0mTsLcuITnoAwxHfK7Vt8X0Npkn2Ow/view","file_type":"PDF","version":"current","action":"READ","audience":{"lanes":["EXAMS"]},"wizard_step":"EXAMS","module":"TRN-104","required":true},
  {"id":"RES-24","title":"Ancillary Item Purchase Links","url":"https://drive.google.com/file/d/1Q8cWNBRMXow3oPI2qvvuP68PgIVMSyeb/view","file_type":"PDF","version":"current","action":"REFERENCE","audience":{"lanes":["EXAMS"]},"wizard_step":"EXAMS","module":"TRN-104","required":false},
  {"id":"RES-30","title":"GFC Team README (Start Here)","url":"https://docs.google.com/document/d/1BrANo-fKoY2tW_8dDDjR9ykUddsp1spCQcrn3yFJrIk/view","file_type":"GDOC","version":"2026-11-06","action":"REFERENCE","audience":{"roles":["*"]},"wizard_step":"REFERENCE_SHELF","required":false},
  {"id":"RES-31","title":"Regulatory Compliance Reference","url":"https://docs.google.com/document/d/1jJQSsrs1rEoEcNRNghINouwAZGct2hrjLM-betf7Du8/view","file_type":"GDOC","version":"2026-08","action":"REFERENCE","audience":{"roles":["*"]},"wizard_step":"REFERENCE_SHELF","required":false},
  {"id":"RES-32","title":"Clinical Billing Plan: Enrollment to Claims","url":"https://docs.google.com/document/d/16zJq__jdYeVje8D96pJfc-Wblc_VmDk_fUqVTgku7rM/view","file_type":"GDOC","version":"current","action":"REFERENCE","audience":{"family":["LICENSED_CLINICAL"]},"wizard_step":"REFERENCE_SHELF","required":false},
  {"id":"RES-34","title":"Lab Test Menu","url":"https://drive.google.com/file/d/1Rl--cdg0MjwafV_lobT5-kNJjqw6MYLA/view","file_type":"PDF","version":"current","action":"REFERENCE","audience":{"family":["LICENSED_CLINICAL"]},"wizard_step":"REFERENCE_SHELF","module":"TRN-206","required":false},
  {"id":"RES-35","title":"Continuous Care Program (CCM)","url":"https://drive.google.com/file/d/1t39l8PijHMepC83zVUOY6U21vgQOdP8b/view","file_type":"PDF","version":"current","action":"REFERENCE","audience":{"family":["LICENSED_CLINICAL"]},"wizard_step":"REFERENCE_SHELF","module":"TRN-213","required":false},
  {"id":"RES-36","title":"Patient Journey Infographic","url":"https://drive.google.com/file/d/1kxXTqyLO3b_equPW1vkd3ar0NxoEY3iF/view","file_type":"PDF","version":"current","action":"REFERENCE","audience":{"roles":["*"]},"wizard_step":"REFERENCE_SHELF","module":"TRN-201","required":false},
  {"id":"RES-33","title":"Quo Phone Tree Setup","url":"https://drive.google.com/file/d/1actG1vaO5IKWgHd5AqjMnjmR2gcX_Z5E/view","file_type":"PDF","version":"2026-11-05","action":"REFERENCE","audience":{"roles":["*"]},"wizard_step":"REFERENCE_SHELF","required":false}
]
```

---

## 3a. Where training videos live

Each video module's `video_url` points into **06 People / Training**. Record once, drop the file in the right folder, paste the link into the module.

| Folder | Link | Modules |
|---|---|---|
| Training / GFC App | https://drive.google.com/drive/folders/1n_qjk1Qasxj1mxKsCLckDbJs2KxfnZTQ | TRN-003, TRN-004 |
| Training / Clinician (create it) | Add after creating | TRN-001, TRN-005, TRN-101 to TRN-218 |
| Training / Clinical Rotation | https://drive.google.com/drive/folders/1Hozbfh2PsxYuWu8zUytN-oyPHxIWKRzL | Students and externs, not the NP track |

The caregiver app videos (accepting shifts, clocking in and out, visit reports) already exist and are linked in the README. NPs use the same clock-in and check-out, so RES-37 reuses one of them:

| ID | Resource | Link | Action | Feeds |
|---|---|---|---|---|
| RES-37 | GFC App: Accepting Shifts, Clocking In (video) | https://drive.google.com/file/d/1YcwdwNhYIa1NKqmEdibsAYKlhekcQgHA/view | READ | TRN-202, SOP-VIS-01 check-in step. Replace with a clinician version when recorded |

## 4. Drive check results (re-checked 11:45 AM, November 6, 2026)

| Check | Result |
|---|---|
| New README (1BrANo...) | Live. The old one is renamed "v1 (replaced)". **Still shared as anyone with the link, so it's public** |
| Onboarding Library and 01 Company / Current folders | **Still shared with admin only.** Staff can't open any onboarding link yet |
| Clinician (W2), (1099), (Hybrid) folders | Still empty |
| Clinical P&P v2.0 | Still a .docx. RES-08 uses the current link until it's converted |
| Clinical SOPs Set 1 | Not in Drive yet. RES-09 link is blank |
| Caregiver document uploads (GFC Caregiver Documents folder) | Admin only. Good, that's where ID and SSN images land |
| Every onboarding link in the wizard | Resolves to a real file |

## 5. Still open before go-live

1. Share **06 People / Onboarding Library** and **01 Company / Current** with Godwins Family Care as Viewer.
2. Switch the new README to Godwins Family Care only.
3. Convert the Clinical P&P to a Google Doc (File, then Save as Google Docs). Update RES-08 and the README.
4. Upload Clinical SOPs Set 1 as a Google Doc. Fill in RES-09 and add it to the README clinician section.
5. Create **06 People / Training / Clinician** for the module videos.
6. README clinician section: remove the Billing Setup Guide and the OpenEMR Master Setup Guide, and add the SOPs. Move the Admin P&P out of "everyone."
7. Export the onboarding deck to PDF, or host it as an app page.
