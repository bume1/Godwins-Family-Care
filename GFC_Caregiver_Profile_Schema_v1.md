# GFC Caregiver Profile Schema — v1

The data the matching engine reads. Every field exists to feed a hard filter or a weighted factor, mirrored to the client care-profile so the two sides compare cleanly.

**Principles**
- **Verified gates safety.** Fields behind hard filters (license, lift capacity, clearances) carry a `verified` flag and an expiry. An unverified or expired credential fails the filter, it does not just lower a score.
- **Some fields are derived, not entered.** Continuity and reliability come from operations (assignments, attendance), not from onboarding forms.
- **Mirror the client.** Each matching field pairs with a client field (see §3).

---

## 1. Schema

```jsonc
{
  // — Identity & employment —
  "id": "uuid",
  "firstName": "string",
  "lastName": "string",
  "photoUrl": "string|null",
  "role": "PCA | CNA | LPN | RN",          // license level — drives skilled-task scope
  "employmentType": "W-2",
  "status": "onboarding | active | inactive",
  "hireDate": "date",

  // — Credentials & clearances (HARD-FILTER critical) —
  "licenses": [
    { "type": "LPN|RN|CNA|PCA", "number": "string", "state": "GA",
      "expiry": "date", "verified": true }
  ],
  "clearances": {
    "backgroundCheck": { "date": "date", "status": "clear|pending|flagged", "verified": true },
    "tbTest":          { "date": "date", "result": "negative|positive", "verified": true },
    "healthClearance": { "date": "date", "verified": true },
    "cprBls":          { "expiry": "date", "verified": true },
    "driversLicense":  { "expiry": "date", "verified": true },     // if transporting
    "autoInsurance":   { "expiry": "date", "verified": true }
  },

  // — Capability & skills (HARD-FILTER critical) —
  "liftCapacity": "none | one_person | two_person | mechanical_lift_trained",
  "skilledCompetencies": [        // each verified; only counts if license permits
    { "task": "wound_care|catheter|ostomy|trach|g_tube|injections|blood_glucose|oxygen|med_administration|suctioning",
      "verified": true }
  ],
  "trainings": [                  // certifications beyond license
    { "type": "dementia|behavioral_support|hospice_eol|first_aid|hipaa",
      "issuer": "string", "expiry": "date|null", "verified": true }
  ],

  // — Experience & matching attributes (WEIGHTED) —
  "yearsExperience": 0,
  "experienceTags": ["dementia","post_stroke","behavioral","hospice","parkinsons","diabetes","copd"],
  "temperamentTags": ["calm","patient","warm","chatty","structured","quiet","energetic"],
  "languages": ["English","Spanish"],
  "culturalBackground": "string|null",
  "interests": ["gardening","gospel music","cooking","cards"],
  "gender": "female | male | nonbinary",

  // — Availability (HARD-FILTER + WEIGHTED) —
  "availability": {
    "shiftTypes": ["days","evenings","overnight","weekends","live_in_24_7"],
    "recurringWindows": [ { "day": "Mon", "start": "07:00", "end": "15:00" } ],
    "maxHoursPerWeek": 0,
    "blackoutDates": ["date"],
    "advanceCommitmentDays": 30
  },

  // — Location & logistics (HARD-FILTER + WEIGHTED) —
  "homeBase": { "zip": "string", "lat": 0, "lng": 0 },
  "serviceRadiusMiles": 0,
  "hasReliableTransport": true,
  "willingToTransportClients": true,

  // — Performance & history (DERIVED from operations) —
  "assignments": [ { "clientId": "uuid", "start": "date", "end": "date|null",
                     "status": "active|ended", "outcome": "retained|early_termination|reassigned" } ],
  "performance": {
    "attendanceRate": 0.0,        // 0–1
    "lateArrivals90d": 0,
    "earlyTerminations": 0,
    "avgFamilyRating": 0.0,       // 1–5
    "totalClientsServed": 0
  },
  "currentActiveAssignments": 0,
  "capacityRemainingHours": 0
}
```

---

## 2. Field → matching use

| Field | Used by | Filter or factor |
|---|---|---|
| `role`, `licenses`, `skilledCompetencies` | skilled-task scope | HARD |
| `liftCapacity` | lift/transfer | HARD |
| `clearances`, license `expiry`/`verified` | credentials current | HARD |
| `trainings` (dementia/behavioral) | behavioral clearance | HARD |
| `homeBase`, `serviceRadiusMiles` | geography | HARD; also proximity (weighted) |
| `availability` | availability | HARD; also schedule fit (weighted) |
| `gender`, `languages` | hard preference (when "strong") | HARD; else weighted |
| `assignments` (this client) | continuity | weighted |
| `experienceTags`, `yearsExperience` | condition-specific experience | weighted |
| `temperamentTags` | personality fit | weighted |
| `interests` | interests / rapport | weighted |
| `performance` | reliability history | weighted |

---

## 3. Client ↔ caregiver mirror

| Client care-profile field | Caregiver field | Comparison |
|---|---|---|
| Lift / transfer need | `liftCapacity` | capacity ≥ need |
| Skilled tasks needed | `skilledCompetencies` + `role` | all needed ⊆ competent |
| Behavioral / cognitive risk | `trainings` | required cert present |
| Diagnoses / conditions | `experienceTags` | overlap |
| Temperament | `temperamentTags` | rule map |
| Language preference | `languages` | match |
| Gender preference | `gender` | match |
| Requested schedule | `availability` | coverage |
| Address | `homeBase` + `serviceRadiusMiles` | in range + distance |

---

## 4. Capture & verification
- **Onboarding (HR-entered, then verified):** identity, licenses, clearances, lift capacity, skilled competencies, trainings.
- **Caregiver self-reported:** temperament, interests, languages, experience tags, availability, home base, transport.
- **Derived from operations (never entered):** assignments, continuity, performance, capacity.
- A hard-filter field with `verified: false` or past `expiry` is treated as **not present** — fails safe.

---

## 5. Minimal v1 subset (to run matching in the prototype)
To rank caregivers in the first build, you need at least: `role`, `licenses`, `liftCapacity`, `skilledCompetencies`, `trainings`, `availability`, `homeBase` + `serviceRadiusMiles`, `experienceTags`, `temperamentTags`, `languages`, `gender`. Performance and continuity can start empty and fill in as assignments accrue.
