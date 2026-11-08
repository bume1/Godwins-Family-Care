# Onboarding wizard v3 — the rebuild, decided

**2026-11-08. Decided against GFC-WIZ-PROMPT v1.0 and Onboarding Playbook v3.0,
both read from Drive.** Nothing is built yet. This records what was decided and
what was found, to be corrected before any merged code moves.

**No document in this repository governs this work.** The Drive documents are
the specification; a repository document describes how the app implements
something and never establishes an onboarding requirement. Where the two
differ, Drive is right and the repository is the defect. This file is a
decision record, not a specification.

> **Corrected in place:** this started life as `docs/GFC_Onboarding_Wizard_v3_Rebuild_Plan.md`.
> The updated prompt forbids adding a new specification file to `docs/` for
> this work, so it moved here. The rule is right: a plan sitting in `docs/`
> beside the real specifications is the next thing somebody builds against.

Owner decisions already taken, 2026-11-08:

- **Two full surfaces, not one.** The hiring manager's side is the robust one
  and drives the chapter. The person being onboarded keeps a view that is **as
  workable for input as the caregiver welcome packet is today** — uploading,
  signing, marking their own items done, adding notes. **For every role, not
  just clinicians.** Core edit and activity functions on the staff side do not
  change.
- **Plan first, build nothing.** This document is that plan.

---

## 1. Where the documents actually are

Every source was read from Drive, not from a copy. Versions checked against
§2 of the prompt on 2026-11-08:

| Document | In Drive | §2 expects | |
|---|---|---|---|
| GFC Onboarding Playbook | v3.0 | v3.0 | ✅ |
| Clinical Policies and Procedures | v2.2 | GFC-CLIN-v2.2 | ✅ |
| Clinical SOPs Set 1 | v1.2 | GFC-CLIN-SOP-S1 v1.2 | ✅ |
| Administrative and Business Operations P&P | v2.2 | — | ✅ |
| **Clinician Training Library** | **not in Current** | "to be added" | ⛔ |

**⛔ The Training Library is the one blocker.** §5 says to take the module
record schema from it. It is not in `01 Company / Policies & Procedures /
Current`, and §2 says to say so rather than build against something else. So
everything in this plan that touches module records stops at the schema and
waits. Nothing else is blocked by it.

**⚠️ The playbook's own document table is behind Drive.** R3.3 lists the
Clinical P&P at 2.0, the Private Home Care P&P at 3.0 and the Admin P&P at
2.0. Drive holds 2.2, 3.1 and 2.2. **So the wizard must read versions from
Drive, not from R3.3.** A table of versions inside a document is a copy, and
this one has already drifted. This is the canonical copy rule (§7) proving
itself on the playbook that states it.

---

## 2. What the wizard is

A hiring manager opens a new hire, picks their role chapter, and the wizard
walks that chapter from pre-hire screening to independent practice, holding
what was done, by whom, and when.

The person being onboarded works their own half of it from their own screen,
the way a caregiver completes the welcome packet today. Both sides write to
one record. §3.8 sets out how they divide.

The playbook is the specification. Where the two disagree, **the playbook is
right and the wizard is the defect.** That sentence is worth building a test
around, not just quoting.

---

## 3. The data model

### 3.1 Chapter

Eight, each a distinct path. They are not variants of one flow.

| | Chapter | Phases |
|---|---|---|
| A | Caregiver | 6 |
| B | Registered Nurse | 4 |
| C | Clinician, Employed | 5 |
| D | Clinician, Contracted | 3 |
| E | Clinician, Hybrid | **none — composes C and D** |
| F | Non-Clinical | 4 |
| G | Community Care Liaison | **none — four unnumbered sections** |
| H | Student and Extern | 3 |

**E and G having no numbered phases is not an omission to tidy up.** E is a
composition: shared credentialing spine, two relationships, with separation
tests resolved before either engagement begins. G is provisioning, scheduling,
training and compensation, with no clearance sequence. Forcing phase numbers
onto either would invent structure the playbook does not have.

### 3.2 Phase

Scoped by chapter, never global. A phase carries:

| Field | What it is |
|---|---|
| `chapter` | A–H |
| `number` | 1..n within that chapter |
| `title` | "Credentialing and Compliance Activation" |
| `trigger` | the condition in the heading: *before an offer is extended*, *at offer*, *before assignment to a client*, *begins on the date of signature*, *after clearance before independent practice*, *by service line* |
| `evidenceOfCompletion` | the playbook's own "Evidence of completion" sentence, held as a reference to the section, not retyped |

The trigger is a real field because it answers "can this start yet", which is
the question a hiring manager actually has.

### 3.3 Item

What I already have, re-parented from gates to phases. An item gains
`chapter` and `phase`, loses `gates`.

### 3.4 Readiness determination

**This is where the gates go.** C.8 is not a gate list; it is a determination
per service line, recorded by a named owner, carrying who reviewed the file,
what was verified, the approved scope and the date. The playbook says that
written determination *is* the credentialing decision and the audit record.

Four service lines, each with its own opening conditions:

| Service line | Opens on |
|---|---|
| Independent medical examinations | Examiner credentialing with the contracting organization, protocol on file, templates assigned. No prescriptive authority, no payer enrolment, so it usually opens first |
| Private pay primary care | Protocol agreement in force and filed, malpractice confirmed for scope, record system and e-prescribing provisioned |
| Insured billing | All of the above, plus individual enrolment and reassignment approved, active group enrolment, written network confirmation. **Payer by payer, never collectively** |
| Behavioral health | Both certifications verified, psychiatric taxonomy active on the NPI, behavioral health scope written expressly into the protocol agreement, controlled substance registration and PDMP active, psychiatric code set enabled |

The eligible-versus-opened rule survives unchanged, because the playbook
states it independently: a determination is recorded by a person, and what
cleared is frozen onto it rather than recomputed later.

### 3.5 Shared references

R1, R2 and R3 are services the chapters call, not steps copied into each.

- **R1 Supervising Physician.** Six-step engagement sequence, Georgia capacity
  limit of eight APRNs and PAs combined, designated alternate required in
  writing at execution, recurring obligations that *lapse without producing an
  alert* — so the wizard assigns an owner and a date at execution.
- **R2 Credential Verification.** Primary source, pass criteria and recurrence
  per credential. Two intervals: primary source verification within 120 days
  of the credentialing decision, and the recurring elements reverified every
  30 days. **Both come from payer accreditation standards, not Georgia law**,
  and the wizard must label them that way (§6).
- **R3 Documents and Designations.** Role designations, the document set by
  role, and physician capacity. Maintained independently of the playbook, so
  the wizard reads it rather than embedding it.

### 3.6 Module

Schema comes from the Training Library, **blocked** (§1). Two changes are
already known: `feeds_gate` is dropped and replaced by `feeds_phase`, scoped
by chapter; and `manual_version` drives the flagging in §6 below.

### 3.7 Sign-off and evidence

Every completion records who, when, and against which primary source. This
already exists and does not change.

### 3.8 Two surfaces over one record

**The split follows the item's owner, which the item library already carries.**
Nothing new has to be invented to decide who does what: an item owned by the
person is theirs, an item owned by GFC or an outside body is the office's.
Both sides see the whole track, so neither is guessing about the other.

| | The person being onboarded | The hiring manager |
|---|---|---|
| Sees | Their whole chapter, their own items first | The whole chapter, plus the roster across everyone |
| Does | Uploads, signs, marks their own items done, writes notes, answers module checks | Everything above for items the office owns, plus verification against primary source, recording readiness determinations, and moving a phase on |
| Cannot | Verify their own credential, record a determination, open a phase | Sign in somebody else's name |

**This is the rule that already holds and must keep holding:** a person marking
their own item done makes it *submitted*, never *complete*, on anything with a
primary source behind it. They cannot verify their own licence, and recording
their say-so as a verification would put an unchecked fact behind a readiness
determination.

**What already exists.** Chapter A's person-facing surface is the caregiver
welcome packet. Chapter C's is the clinician wizard. The work is the manager
side done properly, plus the chapters with no person-facing surface yet: B, D,
E, F, G and H.

**⚠️ But the caregiver packet does not meet Chapter A, and that is exactly what
the rule in §2 predicts.** The packet was built against
`docs/GFC_Caregiver_Welcome_Packet_v1.md`, a repository document that describes
an implementation and never established a requirement. Read against Chapter A
of the Playbook, checked item by item on 2026-11-08:

| Chapter A Phase 3 requires | Shipped |
|---|---|
| Criminal records check: **GCHEXS initiates, GAPS fingerprints, DCH determines**. Employment stays conditional until the determination arrives | One office checkbox, `fingerprinting`. It covers the middle step only and holds no determination |
| Exclusion screening against OIG LEIE, the System for Award Management, and the Georgia Medicaid excluded provider list, dated, repeated on the A.10 schedule | **Absent.** Not in the packet, not in the office items |
| **Qualifying route**: which of companion/sitter, personal care assistant or licensed nursing applies; for a PCA which of four routes under Rule 111-8-65-.09(5)(c)1; verified at its own source; route and verification both recorded | **Absent.** One flat "CNA, HHA, PCA or LPN certificate" upload. A companion needs no certificate at all, and three of the four PCA routes are not certificates |
| Driving record and licence where the caregiver transports clients | Auto insurance only |
| TB screening, annually | ✅ |
| Drug screening, **a GFC requirement rather than a private home care rule** | Present, but not labelled by source (§6) |

The forty-hour PCA route carries its own rule the packet cannot express:
**twenty hours before the caregiver serves any client**, the rest within six
months, under a named directing nurse.

**None of this is a defect in the packet's code.** It is a gap between what was
specified in the repository and what Chapter A requires, which is the reason
§2 now says no repository document governs this work. Chapter A's rebuild is
therefore larger than "add phases to the existing packet", and step 4 of the
sequence should be sized accordingly.

---

## 4. Gates to phases: what happens to each one

| Shipped | Becomes |
|---|---|
| `G0` App and EHR access | Chapter C Phase 4 · Systems Access and Clinical Orientation |
| `G_MD` Physician ready | R1 Supervising Physician, as a shared service the chapter calls |
| `G1` Exams | Readiness determination, independent medical examinations |
| `G2` Patient visits | Readiness determination, private pay primary care |
| `G3` Controlled prescribing | A condition inside the behavioral health and primary care determinations, not a line of its own |
| `G4` Psychiatric care | Readiness determination, behavioral health |
| `G5` Billing a payer | Readiness determination, insured billing, payer by payer |
| `ROLE_READY` | Dropped. It was a reserved placeholder |

**The cross-person dependency survives.** C's protocol agreement depends on a
physician engaged through R1, which is still a link between two people rather
than a field on one.

---

## 5. What happens to each merged file

| File | What happens |
|---|---|
| `clinicianOnboarding.js` | Gate vocabulary removed, chapter and phase vocabulary added. Owners, actions, verify sources and cadences survive |
| `clinicianItems.js` | 118 items re-parented to chapter and phase. Most are Chapter C; the W2, C99 and HYB blocks become Chapters C, D and E |
| `clinicianTrack.js` | `gateStatus` and `payerGates` become `phaseStatus` and `readinessDetermination`. `composeChecklist` survives |
| `clinicianTraining.js` | **38 check questions copied from the SOPs come out** (§6) and become references. Blocked on the Training Library for the rest |
| `clinicianResources.js` | **RES-31 comes off the shelf** (§9, below) |
| `clinicianPrivileges.js` | Unchanged |
| `routes/clinicianOnboarding.js` | Gate routes become phase and determination routes. Document, note and upload routes unchanged |
| `public/clinician-onboarding.html` | "What unlocks when" becomes the phase track. The manager's side gets the chapter driving, verification and determinations. **Her own input half stays as workable as it is now** |
| `public/caregiver.html` | The welcome packet IS Chapter A's person-facing surface. Not rebuilt; it gains a chapter and phase parenting underneath |
| `staffDocuments.js`, Drive routing | Unchanged |
| `docs/GFC_NP_Training_Library_v1.md`, `docs/GFC_Wizard_Resource_Map_v1.md`, `docs/GFC_Clinical_SOPs_Set1_v1.docx` | **Deleted** (§2, §7). They are copies of source documents and must be Drive references |

---

## 6. Version flagging

Build the mechanism, not the field.

A module records the manual version it was written against. When the manual is
reissued, every module whose `manual_refs` fall inside a changed section is
flagged and reviewed before the next learner begins.

The acceptance test is given: the manual moved 2.1 → 2.2 and sections 11.4,
12.3 and 12.4 changed, so **TRN-206, TRN-207 and TRN-208 flag on first run.**

Module IDs are never renumbered. A module whose SOP changes gets a version
bump, which re-checks anyone who already completed it.

---

## 7. Rules the build follows

**Store the reference, never the content.** A module points at a manual
section and version; an SOP step points at an SOP ID. The app resolves those
against Drive. Regulatory text copied into source diverges silently and the
divergence surfaces during an audit rather than during a revision.

**Never present a GFC standard as a legal requirement.** The manual classifies
every obligation by source at §1.6, and the playbook already labels its own,
marking A.9 *internal policy* and R2's intervals as payer accreditation rather
than Georgia law. The wizard takes the classification from the document.

**Chapter D language constraint.** A contracted clinician receives standards
and deliverables, never instruction on method, schedule or sequence. D.2 gives
the two columns. Practically this means the wizard must not use the employed
chapter's directive wording for D, and must not record a supervisory sign-off
that implies control of how the clinician practises. This wants a build guard,
not a style note.

**Canonical copy.** Link to `01 Company / Policies & Procedures /
Current`. Do not store a copy, and do not cache content in a way that survives
a revision. Drive's Manage versions keeps the file id stable, so a stored link
stays valid.

---

## 8. Open items the wizard surfaces rather than resolves

§9 says not to resolve these in code. Where a value is needed, show the
administrator the gap.

1. The non-prescribing protocol question under O.C.G.A. 43-34-23 needs counsel.
2. North Carolina and Alabama requirements are unverified. **Georgia only
   today** — which means the NC and AL blocks already in the item library need
   marking as unverified rather than presented as requirements.
3. The client record retention period is unconfirmed.
4. **⚠️ The Regulatory Compliance Reference must not be used as a source.**
   Three known errors: it states the bimonthly supervisory interval as a
   condition of licensure, it names the wrong agencies for background checks,
   and its retention figure is unverified.

   **This is live right now.** `RES-31` serves that document to clinicians on
   the reference shelf in merged `main`. It comes off, whatever else happens.

   The correct background check sequence is **GCHEXS to initiate, GAPS to
   fingerprint, DCH to determine.** The shipped build names only GAPS, so the
   sequence is incomplete rather than wrong.

---

## 9. Sequence

Following §8 of the prompt.

| | Step | Blocked? |
|---|---|---|
| 1 | Data model: chapters, phases scoped by chapter, items re-parented, document references, sign-off types, completion evidence | No |
| 2 | Chapter C end to end. Most complex path, and the first live hire enters through it | No |
| 3 | Version flagging | **Yes** — needs the Training Library |
| 4 | Chapters A and F, highest volume | No |
| 5 | Chapter D, with the classification constraint | No |
| 6 | Remaining chapters: B, E, G, H | No |

Two things worth doing before step 1, because they are live and cheap: take
RES-31 off the shelf, and delete the three source copies from `docs/`.

**Step 4 is bigger than it looks.** Chapter A is not "add phases to the
caregiver packet" — the clearance and qualifying-route gaps above are real
work, and a caregiver can currently be marked cleared without an exclusion
screening or a recorded qualifying route.

---

## 10. What this plan does not yet answer

- **Whether the two surfaces are one page or two.** The caregiver packet and
  the clinician wizard are separate pages today. One page that changes by who
  is looking is less code; two pages are harder to get wrong. Worth settling
  at step 2, when Chapter C makes it concrete.
- **The module schema**, blocked above.
- **Whether existing records migrate.** Nobody has completed a track yet, so
  the honest answer is probably that there is nothing to migrate. Worth
  confirming before step 1 rather than assuming.
