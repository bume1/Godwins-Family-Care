# GFC Consent Registry — v2

_Session 4.6, 2026-09-08. Supersedes the thirteen placeholder entries that shipped from Session 3.2._

**Where the registry actually lives:** `consentRegistry.js` (lanes, statuses, provenance rules) and
`public/consent-text.js` (titles, approved body text, version ids). Nothing else in the app keeps a
copy. `public/admin-enrollment.html` used to hold a second one — `CONSENT_DEFS_BY_LINE` — and the two
had already drifted apart; it is deleted, and the admin form now renders whatever
`GET /api/gfc/admin/enrollment/meta/consent-registry` returns.

---

## The fourteen consents

| Key | Title | Lane | Flag | Paper document | Body version |
|---|---|---|---|---|---|
| `npp` | HIPAA Notice of Privacy Practices | Both | required | Packet 1, Document 4 | `2026-09-packet-v2` |
| `roiFamily` | Release of Information — Family | Both | required | Packet 1, Document 6 §C | `2026-09-packet-v2` |
| `roiProvider` | Release of Information — Providers | Both | required | Packet 1, Document 5 | `2026-09-packet-v2` |
| `billOfRights` | Patient Bill of Rights & Self-Determination | Both | required | Packet 1, Document 3 | `2026-09-packet-v2` |
| `emergencyFinancial` | Emergency Response and Financial Responsibility | Both | required | Packet 1, Document 7 | `2026-09-packet-v2` |
| `crisisProtocol` | Emergency & Crisis Protocol (911/988) | Both | required | Packet 1, Document 8 | `2026-09-packet-v2` |
| `monitoring` | Continuous Monitoring Opt-In | Both | optional · **inactive** | No paper source | `2026-09-packet-v2` |
| `serviceAgreement` | Service Agreement | **PHC** | required | Packet 1, Document 1 | `2026-09-packet-v2` |
| `financialAgreement` | Financial Agreement (rates, billing, cancellation) | PHC | required | Packet 1, Document 2 | `2026-09-packet-v2` |
| `pcaScope` | Personal Care Aide Scope Acknowledgment | PHC | required | Packet 1, Document 6 | `2026-09-packet-v2` |
| `ihpcServiceAgreement` | In-Home Primary Care Services Agreement | **IHPC** | required | Packet 2, Document 1 | `2026-09-packet-v2` |
| `consentToTreat` | Consent to Medical Treatment | IHPC | required | Packet 2, Document 2 | `2026-09-packet-v2` |
| `assignmentOfBenefits` | Assignment of Benefits and Financial Responsibility | IHPC | required | Packet 2, Document 3 | `2026-09-packet-v2` |
| `practiceNpp` | Medical Practice Notice of Privacy Practices | IHPC | required | Packet 2, Document 4 | `2026-09-packet-v2` |

Packet 1 = `GFC_PrivateHomeCare_Service_Packet_TrackA2.pdf`. Packet 2 = `GFC_InHomePrimaryCare_Service_Packet.pdf`.
Both transcribed in `docs/GFC_Consent_Source_Text_v2.md`, which is what `public/consent-text.js` was ported from.

**Required counts by lane:** PHC 9 · IHPC 10 · BOTH 13. A dual-lane client signs two service
agreements. That is correct, not duplication.

---

## The lane split

`serviceAgreement` was scope `both` until this session. Three things were wrong with that:

1. A home-care-only client signed an agreement describing medical visits, prescribing and chronic
   disease management they were not receiving and had not been offered.
2. A client who later added In-Home Primary Care passed into the clinical lane with
   `serviceAgreement` already satisfied from home care — so nothing in their file established the
   provider-patient relationship, named the collaborating physician, or set clinical termination
   terms. A live IHPC packet reviewed on 09/08 is exactly that case.
3. The two services run under different licences, are delivered by different people, and are billed
   differently. One agreement cannot carry both.

**Migration, not re-scoping.** `migrateConsentLaneSplit()` in `server.js` flags every client with a
satisfied `serviceAgreement` and a service line of IHPC or BOTH into `client.consentReaffirmRequired`,
writes `ihpcServiceAgreement: 'pending'`, and logs every record it touched to
`scripts/consent_lane_split_migration.log`. No signature is erased and nothing is silently marked
satisfied — the enrollment gate does the enforcing. Gated by
`CONSENT_LANE_SPLIT_MIGRATION_APPLIED` (default false) so it runs once.

---

## Status vocabulary

| Status | Meaning | Satisfies a requirement |
|---|---|---|
| `signed` | E-signed in app: typed name, acknowledgment, server timestamp, hashed client IP, body version. Never written without all of them. | yes |
| `signed_offline` | Signed on paper. Kept distinct only so the audit trail preserves how it was captured. | yes |
| `optin_recorded` | A preference recorded for an **inactive** consent. Nothing was executed and no signature was taken. | **no** |
| `pending` | Required, not yet satisfied. | no |
| `na` | Declined, or not applicable. | no |

`optin_recorded` is new. Before 4.6 the sign handler wrote `'signed'` for an inactive consent and
skipped the signature, timestamp and IP block entirely — which is how a live packet came to show
"Continuous Monitoring Opt-In — Signed by Demo Client" with no provenance at all, indistinguishable
from an executed consent. An inactive consent can no longer be signed by any path.

---

## Body versions

The version a consent was signed against is stamped on the consent record
(`client.consentMeta[type].version`) and every superseded body stays reachable in
`ARCHIVE` in `public/consent-text.js`. `generateConsentPDF()` renders the archived text, so editing
the current wording never rewrites an old signature's document. **Never delete an archived version
while a signature still points at it.**

- `draft-1` — the pre-4.6 placeholder stubs. Archived, still rendered for anything signed against them.
- `2026-09-packet-v2` — the approved paper-packet wording ported in this session.

Bump the version and archive the outgoing body whenever the language changes.

---

## The one-pass rule

A consent that needs a value **renders** it from the client record for confirmation; it never
re-collects it. Body blocks of type `data` resolve through `consentRender.js`, which is the app's
Client Information Face Sheet. The only interactive block a body may carry is `choice`, and a choice
is a decision rather than a datum: `telehealth`, `students`, `photoLikeness`, `codeStatus`.

**One exception, mirrored from the paper packet and no other:** `roiProvider` carries the client's
name and date of birth on its own, because that authorization leaves the building and reaches an
outside provider who will never see the face sheet.

Enforced by `test/consent_registry.test.js`.

---

## Presentability

A consent whose body renders a value the client record does not have is **not presentable** and
cannot be signed. Today there is one such gate: the rate table on `financialAgreement` and
`serviceAgreement`. Both print §"What You Pay" / §3 "Rates and Minimums", so without
`client.rateAgreement` a client would be signing around an empty box. An admin sets the rate at
`PUT /api/gfc/admin/enrollment/:clientId/rate`; it also appears on the enrollment checklist so the
gap surfaces at intake rather than at the kitchen table.

---

## Open decisions for the owner

1. **Counsel review.** This session ports approved-by-the-owner wording into the app. It does not
   substitute for the attorney pass Intake Spec §6 still lists as open. Worth naming specifically:
   the pre-4.6 `emergencyFinancial` had a private home care provider taking consent to medical
   treatment.
2. **Private Home Care Provider licence number — DECIDED 2026-09-08: it renders.**
   `PHCP013073`, sourced from `ORG.phcpLicense` in `public/consent-text.js`, prints in the Home Care
   Service Agreement's Parties clause. No further action.

3. **Reaffirmation scope — DECIDED 2026-09-08: the seven legacy paper patients are grandfathered,
   by evidence rather than by exemption.** They are resolved by filing the packet they already
   signed — an upload that classifies each page into its consent bucket and records `signed_offline`
   per document — not by asking them to sign again and not by a blanket skip in the migration. The
   `consentReaffirmRequired` flag stays as the work queue for that filing and clears per consent as
   evidence lands.

   **The one thing paper cannot resolve.** The In-Home Primary Care Services Agreement did not
   exist in the pre-09/2026 packet, so a legacy IHPC or dual-lane patient has no paper copy of it to
   file. Parsing will correctly find nothing. That consent stays outstanding until it is signed —
   recording it as grandfathered would assert a signature that does not exist on any document.
   Everything they did sign is grandfathered by the filing.

   The upload-and-classify flow is its own build (proposed Session 4.7); see the note below.

---

## Session 4.7 — legacy packet filing (proposed, not built)

Grandfathering by evidence needs a path that does not exist yet: upload a scanned packet, split and
classify it into the fourteen consent buckets, let an admin confirm, then record `signed_offline`
with the signing date off the page.

**Two things gate it.**

**PHI and the model provider.** The repo has no LLM integration today, and no OCR. Classification by
a hosted model means scanned client packets — signatures, diagnoses, addresses — leave the BAA
boundary. That needs a signed BAA with the provider and zero-retention terms before a single real
packet is uploaded. Until then the flow runs on synthetic scans only, consistent with the standing
TEST DATA rule.

**A deterministic pass may be enough.** The packet is ten known documents with fixed titles. Title
matching over extracted text classifies a clean scan with no model call and no PHI leaving the
boundary. A model earns its place on the messy cases: a skewed phone photo, a handwritten margin
note, a page out of order. Recommended shape is deterministic first, model as the fallback that
handles what matching could not, so the common case never leaves the boundary.

**Never auto-record.** Classification proposes a bucket, a page range and a confidence; an admin
confirms in the offline-onboarding checklist that already exists; only then does the write happen,
with provenance recording that it was machine-proposed and human-confirmed. Same guardrail the
coding assist already runs under: the system proposes, the person disposes.
