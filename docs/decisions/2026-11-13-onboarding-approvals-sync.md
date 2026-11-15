# One approval, every view (caregiver onboarding)

**Date:** 2026-11-13 · **Owner report:** "we have reviewed and approved most of these items for a caregiver, yet it did not automatically check off on their onboarding list."

## Why it happened
- **/onboarding wrote only to `onboarding_records`.** That covers Verify, Mark Done and uploads.
- **The Staff Record clearance list, the caregiver's own checklist and the scheduling gate read only the welcome packet stores:**
  - `caregiver_documents` (by kind, accepted)
  - `welcome_packets.office`
  - `caregiver_attestations`
- **A file uploaded in /onboarding was saved as `clinician_onboarding`.** That kind matches no packet item, so even accepting it ticked nothing.

## What changed
- **An office step in /onboarding writes to the packet** (`onboarding/packetSync.js` `syncApproval`). It applies to Chapter A items only:
  - the item's files that are waiting on review are accepted
  - the item's office documents (fingerprinting, orientation, app training, skills check) are marked done
  - marking her own step done for her is not an approval
- **The /onboarding drawer gained three controls:**
  - **Mark Done** on an office document
  - **Accept** or **Send Back** on a file waiting on review, using the same route the Staff Record uses
  - **Upload**, filed under the packet document it answers. It asks which document when there are several.
- **Who uploads decides the status.** A file the office uploads lands accepted; hers waits on review.
- **One writer for an office item.** The Staff Record dropdown and onboarding both call `packetSync.setOfficeItem`.
- **A file waiting on review counts as "waiting on the office"** on the clearance list, not "waiting on them".
- **The Staff Record keeps itself current:**
  - it reloads Onboarding & Clearance after a document is reviewed, filed or removed
  - the Documents upload no longer defaults to Photo ID, which put files on the wrong item
- **A one-time boot step** (`repairOnce`, marker `onboarding_packet_sync_repair`) carries earlier approvals over:
  - office steps already recorded accept their waiting files and mark office documents done
  - onboarding uploads against a one-document item are refiled under that document
  - an upload against an item with several documents is left alone and counted in the boot log

## Must not undo
- **The forms she signs still need her own signature.** An office approval never signs for her. This covers the handbook, privacy, code of conduct, registry and the other forms.
- **The repair runs once.** If it ran on every boot, a replacement file she sends after a step was verified would be accepted without anyone looking at it.

## Verified
- `test/onboarding_packet_sync.test.js`: 6 tests through the real onboarding and welcome packet routers on one shared store.
- 10 mutations; 8 caught.
- Two guards had no effect on any item that exists today:
  - the "every office step done" check: every item that names an office document has one office step, so the check was removed
  - the "not her step" guard: it is kept as defensive and labeled as such
- Full suite 3695 passing, 0 failing.
- Chromium on a real server: the office opened Credentials in /onboarding and clicked Accept on her CPR card. Her own welcome packet checklist went from `in_review` to `complete`.

## Open for the owner
- A file sent through onboarding against an item with several documents (for example Employment and tax documentation) is left as-is by the repair. Re-file it from Staff Record → Documents with the right type.
