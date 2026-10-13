# Referrals to the care team or to saved outside providers (owner, 2026-10-12)

Owner asked for a "Refer to" dropdown on the referral: a running list of outside providers we have referred to, plus our own clinical team, plus "New". A referral to a team member should land in their clinical view as something to address. Also: case managers and counselors are LMSW, a clinical social worker is LCSW, set permissions by scope of practice, and add a cancel button for orders.

- **One "Refer to" list:** Our care team, then Referred before, then + New Provider. The server builds it (`GET …/patients/:id/referral-targets`). A colleague must be active and licensed. The viewer is never offered themselves, and an office admin account is skipped unless it has an NPI.
- **An internal referral is never faxed.** It has no requisition, no send, no outside appointment and no OpenEMR procedure_order copy (that would record it as a lab test). It lands in the colleague's Clinical Inbox ("Referral from the team"). Only they can Accept and Mark Complete, and completing needs a note. The referring clinician reads the note on the order. Lifecycle: ordered → accepted → completed, or cancelled.
- **The colleague joins the care team.** A clinician joins the clinician list. A case manager fills the case manager slot if it is empty; if someone already holds it, they join as a supporting case manager and nobody is replaced. Messaging scope reads supporting case managers. Escalation routing still goes to the assigned case manager.
- **They get a PHI-free email** that links to `/clinical#inbox`. The page reads that fragment once, at mount. The notice builder takes no arguments.
- **Saved providers (`referral_providers`, not PHI):** a new provider is saved when "Save to the provider list" is ticked. Placing a referral never changes a saved entry: typing over the fax changes that referral only. Editing a saved provider is its own step, and a fax change needs a reason, kept in its history. Duplicates are caught by fax: a second name on a saved fax is shown the match and saved only with "Save as a separate provider". The list is seeded at boot from past outside referrals, one entry per fax, and the seed is idempotent.
- **Scope of practice (owner's LMSW/LCSW summary):**
  - Any licensed role refers within the team.
  - A provider or an LCSW refers out. An LMSW or RN does not.
  - DME and test orders are still provider-direct, and a referral is never placed under a standing order.
  - Social work (LCSW, LMSW) works a referral through: fax, schedule, consult note, cancel. A lab, imaging, procedure or DME order stays with the RN and provider.
  - An LCSW adds mental health (ICD-10 F) diagnoses to the problem list and nothing else. Allergies stay with the RN and provider.
  - An LMSW adds no diagnoses and bills nothing (unchanged).
- **Case managers are LMSW.** The default for a case manager with no stored role is now `lmsw`. A one-time boot step moves case managers stored as `readOnly` to `lmsw`, with a marker so a later deliberate readOnly is not undone. **This widens them:** they can now write notes within LMSW scope, author care plans (held for co-sign), and correct enrollment submissions (intake is LMSW scope). A case manager an admin sets to readOnly stays read-only. Labels: "LMSW (case manager / counselor)" and "LCSW (clinical social worker)".
- **Cancel Order needs a reason**, recorded as `cancelReason`, `cancelledBy` and `cancelledAt`. It shows in the encounter and on the chart's order detail, only where the server says this viewer may cancel (`order.can.cancel`). The old lowercase "mark cancelled" chip is gone.
- **The server answers what each viewer may do with each order** (`orderForViewer` → `order.can.coordinate / cancel / acceptOrComplete`). The page draws from that and never decides it.
- **Fixed on the way:**
  - the chart order detail's Sent and Destination lines read fields the records don't have (`at`, `recipient`, `field`), so they printed blanks;
  - an outside referral's detail now shows its consult notes and results.
- **Verified:**
  - `test/referrals.test.js`: 23 tests, 32 of 32 mutations caught. One survived on the first pass (a source check that `if (false)` still satisfied) and was tightened.
  - The after-save step is lifted out of `server.js` and run against a fake store.
  - 13 existing tests repointed, not deleted, because they pinned "case managers are read-only", provider-only referrals or reason-less cancels.
  - Full suite 2321, 0 failing.
  - `scripts/verify_referrals.js` 40/40 over real HTTP.
  - `scripts/verify_orders_requisitions.js` 92/92 (repointed the same way, plus a new check that a read-only case manager is still refused).
  - `scripts/verify_clinical_roles.js` 57/57.
  - `scripts/verify_referrals_render.js`: 31/31 in a real browser (inbox, Referrals tab, encounter form as provider and as LMSW).
- **Not proven from the sandbox:** placing a referral end to end, because it needs an OpenEMR encounter. Run the two probes against the deployment.
- **Open for the owner:**
  1. Should an LMSW also refer out to community resources (food banks, housing)? Today the referral form is clinical (diagnosis, clinical summary), so LMSW refers within the team only.
  2. Should a colleague be able to decline or hand back a referral? Today the referrer cancels and re-refers.
  3. Outside referrals are still copied to OpenEMR's procedure_order as a lab type. That was already the case and is unchanged here.
