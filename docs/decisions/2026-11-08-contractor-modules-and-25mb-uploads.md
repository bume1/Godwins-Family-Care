# Contractor training modules and 25 MB onboarding uploads

**Date:** 2026-11-08 · **Owner-directed**

## Non-clinical modules for contracted clinicians (Chapter D)
- **What she takes:** a contractor now takes eight Training Library modules, chosen by id and never copied:
  - TRN-002 role card and escalation contacts
  - TRN-003 systems
  - TRN-004 app tour
  - TRN-005 privacy and security
  - TRN-008 AI policy
  - TRN-205 the documentation standard
  - TRN-101 and TRN-103, for IME scope only
- **Where they sit:** all in the Systems & Standards step (D.6). The Training tab now shows for Chapter D.
- **D.2 still holds.** Each module signs off as an attestation, a certificate or nothing, never "observed" or "countersigned". A test fails the build if a clinical-evaluation module is added to the list. Readiness (C.8) still requires no modules for a contractor.

## 25 MB onboarding uploads
- **The bug:** onboarding uploads said 15 MB at the door, but the shared document check behind it used the app-wide 10 MB. So files between 10 and 15 MB were already being refused.
- **The fix:** `config.STAFF_DOCUMENT_MAX_SIZE` = 25 MB (override with the env var of the same name). It is read by:
  - clinician, nurse, admin and liaison onboarding uploads
  - caregiver documents
  - the welcome packet import
  - the caregiver app's file checks
- **What stays the same:** patient and client uploads keep the 10 MB `MAX_FILE_SIZE`.
- **Clear errors:** an oversized onboarding upload now answers 400 "File exceeds the 25 MB limit" rather than a server error.
- **Fits the request cap:** a 25 MB file sent as base64 is about 34 MB, under the 50 MB JSON body limit.

## Verified
- 6 mutations, all caught.
- Full suite 3338 pass, 0 fail.
