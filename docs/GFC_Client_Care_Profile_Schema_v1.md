# GFC Client Care-Profile Schema — v1

The client side of the match, and the core of the client record. Built to compare cleanly against `GFC_Caregiver_Profile_Schema_v1.md`: matching fields use the **same enums** on both sides so comparison is exact, not fuzzy.

**Principles**
- **Shared vocabularies.** Skilled tasks, conditions, shift types, and languages use identical enums on the client and caregiver. Lift need maps to a required caregiver capacity. Temperament is the one exception, compared through a rule map, not equality.
- **Populated from intake.** Most fields come from the Stage 1–2 digital intake; clinician-verified values (the RN packet) overwrite self-reported ones on the first visit.
- **PHC vs clinical split.** This record holds the care profile and light clinical context. Full clinical data for the In-Home Primary Care arm lives in OpenEMR, referenced here, not duplicated.

---

## 1. Schema

```jsonc
{
  // — Identity & enrollment —
  "id": "uuid",
  "firstName": "string", "lastName": "string", "preferredName": "string",
  "dob": "date", "gender": "female|male|nonbinary",
  "primaryLanguage": "string",
  "address": { "line1": "string", "city": "string", "state": "GA", "zip": "string", "lat": 0, "lng": 0 },
  "phone": "string",
  "livesWith": "alone|spouse|adult_child|other_family|assisted_living",
  "serviceLine": "PHC | IHPC | both",
  "careTier": "1|2|3",                 // Essential ADL | Comprehensive | Behavioral
  "enrollmentStatus": "intake_pending|intake_complete|enrolled",
  "monitoringOptIn": false,

  // — Contacts & authority —
  "primaryContact": { "name": "string", "relationship": "string", "phone": "string", "email": "string",
                      "preferredChannel": "phone|text|email" },
  "decisionAuthority": "client|shared|surrogate|poa_guardian",
  "emergencyContacts": [ { "name": "string", "relationship": "string", "phone": "string" } ],

  // — Care team (drives escalation routing + access scoping) —
  "careTeam": { "assignedFNPs": ["userId"], "assignedCaseManager": "userId|null",
                "primaryCaregiver": "caregiverId|null", "backupCaregiver": "caregiverId|null" },

  // — MATCHING CARE PROFILE (mirrors caregiver) —
  "transferNeed": "independent|standby|one_person|two_person|mechanical_lift",
  "adl": { "bathing": "independent|cues|assist|dependent", "dressing": "...", "grooming": "...",
           "toileting": "...", "transfers": "...", "ambulation": "...", "eating": "..." },
  "fallRisk": "low|moderate|high",
  "skilledTasksNeeded": ["wound_care|catheter|ostomy|trach|g_tube|injections|blood_glucose|oxygen|med_administration|suctioning"],
  "conditions": ["dementia|post_stroke|behavioral|hospice|parkinsons|diabetes|copd|cardiac|..."],
  "cognitiveStatus": "intact|mild|moderate|severe",
  "dementiaStage": "none|early|moderate|late|undiagnosed",
  "behavioralFlags": ["wandering|aggression|sundowning|self_harm_risk|resistance_to_care"],
  "temperament": ["quiet|warm|likes_routine|prefers_independence|anxious|resistant_to_care"],
  "interests": ["gardening|gospel music|cooking|cards"],

  // — Requested service / schedule —
  "schedule": { "shiftTypes": ["days|evenings|overnight|weekends|live_in_24_7"],
                "preferredDays": ["Mon","Wed"], "hoursPerWeek": 0,
                "startDate": "date", "urgency": "immediate|week|month|exploring",
                "recurring": "recurring|one_time" },

  // — Caregiver preferences —
  "genderPreference": { "value": "female|male|none", "strength": "preferred|strong" },
  "languagePreference": "string|none",
  "caregiverExperienceRequired": "none|some|experienced|dementia_trained|behavioral_certified",

  // — Light clinical context (full clinical → OpenEMR) —
  "allergies": "string",
  "medications": [ { "name": "string", "dose": "string", "route": "string", "frequency": "string",
                     "prescriber": "string", "pharmacy": "string" } ],
  "advanceDirective": { "status": "dnr|living_will|healthcare_poa|none|unknown", "documentRef": "drive://..." },
  "medicalTeam": { "pcpName": "string", "pcpPhone": "string", "preferredHospital": "string", "preferredPharmacy": "string" },

  // — Prior providers (feeds the Transfer-of-Care ROI form; editable independently of any ROI signing event) —
  "priorProviders": [ { "name": "string", "dept": "string", "address": "string", "phone": "string", "fax": "string",
                        "roleLabel": "pcp|specialist|hospital|other",
                        "addedFrom": "intake_prefill|manual|roi_form",
                        "createdAt": "timestamp" } ],

  "homeSafetyFlags": ["smokers|pets|firearms|hoarding|pests|stairs|oxygen_tanks"],
  "twoPersonAssistRequired": "no|sometimes|routinely",
  "openEmrPatientId": "string|null",     // link to clinical record for IHPC

  // — Consents (status per type) —
  // Note: roiTransfer is the Transfer-of-Care ROI (multi-provider record release, Session 3.4).
  // Detailed rows for each signing event live in the consent_events + consent_provider_authorizations
  // + consent_records_categories tables. Status here is a rollup for the client profile.
  "consents": { "serviceAgreement": "signed|pending", "roiFamily": "signed|pending|na",
                "roiProvider": "signed|pending", "roiTransfer": "signed|pending|na",
                "npp": "signed|pending",
                "billOfRights": "signed|pending", "emergencyFinancial": "signed|pending",
                "crisisProtocol": "signed|pending", "monitoring": "signed|pending|na" },

  // — Payer —
  "payer": { "type": "private_pay|ltc_insurance|medicaid_waiver|va|medicare_b|combination",
             "insuranceIds": [ { "carrier": "string", "memberId": "string", "group": "string" } ] },

  "carePlanRef": "care_plan_id|null"     // versioned plan lives in care_plans
}
```

---

## 2. Shared vocabularies (must match the caregiver schema exactly)

| Concept | Client field | Caregiver field | Enum shared? |
|---|---|---|---|
| Skilled tasks | `skilledTasksNeeded` | `skilledCompetencies[].task` | yes, identical |
| Conditions | `conditions` | `experienceTags` | yes, identical |
| Shift types | `schedule.shiftTypes` | `availability.shiftTypes` | yes, identical |
| Language | `primaryLanguage`, `languagePreference` | `languages` | yes, identical |
| Gender | `genderPreference.value` | `gender` | yes |
| Transfer / lift | `transferNeed` | `liftCapacity` | mapped, see §3 |
| Temperament | `temperament` | `temperamentTags` | no, rule map §4 |

---

## 3. Lift need → required caregiver capacity

| `transferNeed` | Requires `liftCapacity` ≥ |
|---|---|
| independent / standby | none |
| one_person | one_person |
| two_person | two_person |
| mechanical_lift | mechanical_lift_trained |

Hard filter: caregiver capacity must meet or exceed the client's need.

---

## 4. Personality fit rule map (client temperament → preferred caregiver)
Not an equality check. Examples:
- `anxious` → favor `calm`, `patient`
- `quiet` / `prefers_independence` → favor `quiet`, `structured`
- `warm` → favor `warm`, `chatty`
- `resistant_to_care` → favor `patient`, experienced (also raises `caregiverExperienceRequired`)
- `likes_routine` → favor `structured`

The map is admin-editable. Scores 0–1 by strength of the favored-trait overlap.

---

## 5. Field → matching use
Same as the caregiver doc's table, from the client side: `transferNeed`, `skilledTasksNeeded`, `behavioralFlags`, geography, `schedule`, and strong `genderPreference`/`languagePreference` drive the hard filters; `conditions`, `temperament`, `interests`, soft preferences, and `careTier` drive the weighted score and select the tier weight profile.
