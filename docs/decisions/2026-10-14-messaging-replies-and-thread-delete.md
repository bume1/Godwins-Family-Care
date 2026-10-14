# Replies open where people can read, and the super admin can delete a thread (owner, 2026-10-14)

Owner: "no one can respond to any messages unless they use the support pipeline. That is an absolutely not. Open the response channel appropriately and allow super admin to delete message threads only." Clarified: in a thread one person started to clinical, that person could keep posting while the patient and the rest of the care team could not answer.

**What was blocking:** a test of every role against every channel through the real server found exactly two refusals. **Care Update** (a clinician's message) was one-way: the patient, the POA, family and the case manager each read "You cannot reply here. A Care Update is an update, not a conversation. Reply through Support." And a **client could not answer in their family's Family Portal thread**. Every other visible thread already took replies, and the shared component in the browser sent them for every role.

**Fixed:**
- **Care Update is a conversation.** A clinician still starts it; the patient, their POA, family and the care team can answer it. Visibility is unchanged, so **a caregiver still never reads it**. No channel now tells people to reply somewhere else (build-enforced).
- **A client can reply in their family's Family Portal thread.** They still don't start one.
- **Delete Thread, super admin only** (`role: 'admin'`; a manager is refused, and nobody can do it while viewing as another user, because the request carries that user). `DELETE /api/messaging/threads/:id` needs a reason. The page shows the button only when the server answers `canDelete`.

**Must not undo:**
- **Deleted means gone from every screen, never erased.** The thread and its messages move to `deleted_message_threads` (PHI, registered) with who, when and why, the same rule as `quarantined_messages`. Archive first, then remove, so a failure leaves a copy, never a gap. Attachments stay where they are stored.
- The audit row names the thread, its channel and the message count; **never the words or the reason**.

**Verification:** 3 new tests over HTTP through the real router, 2 repointed (the one-way Care Update test, and the component's draft-clear count). 9 of 9 mutations caught; one survived first because the test harness dropped `isManager`, so "a manager cannot delete" was never tested as a manager; the harness now carries it. Real server, every role × every channel: 149 replies, 0 refused. Browser: clinician sees no delete button, super admin deletes, thread 404s for everyone after. Full suite 2446, 0 failing.

**If it still fails after deploy:** that is the deployment, not this code. The image must be rebuilt for any of this to be live.
