# GFC Caregiver Welcome Packet — v1

_Ported from the printed packet "GFC Welcome Packet — Caregivers" (2026-09) at the owner's direction, 2026-09-13._

The packet was a PDF that travelled by email. Whether a caregiver had ever filled one in was a
thing you found out by looking in an inbox. It is now the first screen of the caregiver app, and
it is what opens the app.

---

## The two gates

They are different questions and they are deliberately not collapsed into one.

| | **App access** | **Shift clearance** |
|---|---|---|
| **Asks** | Has the caregiver done *their* part? | Is this caregiver cleared to be in a client's home? |
| **Made of** | The nine profile sections, their emergency contact, their signature | The required documents accepted + the office's own checks done |
| **Refusal** | `WELCOME_PACKET_REQUIRED` / `WELCOME_PACKET_INCOMPLETE` | `CAREGIVER_NOT_CLEARED` |
| **Override** | None. It is their own paperwork. | Admin-only, reason required, stamped on the shift |

**Why the split.** Gating app access on the uploads would lock a caregiver out of the only screen
where uploading happens. Gating it on the office's clearances would lock them out for days over
work that is not theirs. So their half opens the app, and the rest opens the shift board.

**Neither gate ever reaches work already in flight.** Clock-in, clock-out and the visit log are
ungated and build-enforced to stay that way. Care that was given gets documented and paid whatever
the paperwork says; refusing the record would lose the visit and the caregiver's pay without
un-giving the care. It is the client enrollment gate's rule pointed at the other side of the
relationship.

---

## Part One — the profile

Nine sections, rendered from `PACKET_SECTIONS` in `welcomePacketRepository.js`. Eight are the
printed packet's own; the ninth is the emergency contact, which the printed document lists under
the documents and which is data rather than a file.

The page names no section, no field and no option of its own — it renders what
`GET /api/caregiver/welcome-packet` serves. Build-enforced, the same rule the competency catalog
and the document kinds follow: a screen that restates the questions drifts from the validator that
refuses an answer they did not offer, and the drift is silent.

An answer the packet never offered is **dropped and reported**, never stored.

---

## Part Two — what to send us

23 items in six groups, `DOCUMENT_ITEMS`. Each carries who produces it:

- **`caregiver`** — they have it or they get it
- **`gfc`** — a form we send them to sign and return
- **`gusto`** — group E: it is in their Gusto HR onboarding portal to read and sign, and the
  signed copy comes back here
- **`office`** — we do it (fingerprinting, orientation, app training, skills check). Tracked by
  status; there is nothing for the caregiver to attach.

**The group E wording is the one place the printed packet was replaced rather than ported.** It
said *"You do not need to find these. We email them and you sign and return."* Both halves are now
wrong: they live in Gusto, and somebody told to wait for an email would wait forever. The screen
also says plainly that **uploading here does not file anything in Gusto and signing in Gusto does
not send anything here** — Gusto is the system of record and what the app holds is the office's
copy. Build-enforced in both directions.

**Two items are conditional**, because the printed packet says so and a checklist that ignores the
condition teaches people to ignore the checklist:

- the CNA/HHA/PCA/LPN certificate, only if they said they hold one
- the licence and insurance, only if they said they will drive clients

The checklist is **derived, never stored** — the item list filtered by their answers, plus what is
in the document store. A stored checklist goes stale the moment a document is accepted.

A **rejected** upload reads as rejected and carries its reason, never as missing. A caregiver told
a rejected document is "missing" photographs the same page again.

---

## Reading a returned packet

`welcomePacketImport.js`. Three outcomes, and telling them apart is the point.

**`form`** — the PDF still carries the named fields we put in it, so every answer is read **by
name**. Exact. This is the path a caregiver takes when they fill the PDF we hand out
(`GET /api/caregiver/welcome-packet/blank.pdf`, seeded with what we already know).

**`text`** — the fields are gone (flattened, or a PDF we did not generate) but the text is still
there. Labels are matched against text **by position on the page**, and three rules all have to
hold before a candidate is accepted as an answer: it sits with the label geometrically, it is not
something the form itself prints, and it does not repeat. Anything that fails is left blank and
asked.

**The text path fills text and never choices.** An option label printed on the page is evidence
the *question* is there, never evidence that box was the one ticked — every option sits next to
every other one on a printed form. A wrongly inferred "willing to drive clients" is worse than a
blank one: blank gets asked, wrong gets signed.

**`none`** — an image-only scan, or nothing matched. The file is kept for the office either way,
and the message says which kind of unreadable it was. *An empty result is not a diagnosis.*

An imported value **never overwrites** something already typed in the app, and every imported
value runs through the packet's own sanitizer. A PDF is a file somebody sent us; it does not get
to write a value the form itself would refuse.

---

## Where things live

| | |
|---|---|
| `welcomePacketRepository.js` | the questions, the document items, the sanitizer, the checklist |
| `caregiverOnboardingGate.js` | both gates and the override, pure functions |
| `welcomePacketPdf.js` | the fillable packet and the signed copy; **the one copy of the field-naming convention** |
| `welcomePacketImport.js` | reading one back |
| `routes/welcomePacket.js` | `/api/caregiver/welcome-packet*` and the admin queue |
| `welcome_packets` (KV) | one row per caregiver: draft, answers, signature, office checklist |
| `caregiver_documents` (KV) | the uploads — the store that already existed, not a second one |

The signature image lives on the packet row, never on the user record: the users blob is read on
nearly every request and rewritten whole on every write.

---

## Verifying it

- `node --test test/welcome_packet.test.js` — 49 tests, 19 of 20 mutations confirmed to fail them
  (the twentieth is recorded in the code as behaviour-neutral rather than claimed as a catch)
- `node scripts/verify_welcome_packet.js` — 42 assertions through the real routers over HTTP,
  reading stored values back: shut app → import → sign → app opens → claim refused → override with
  a reason → checklist worked → claim goes through

---

## Open for the owner

1. **Drive has to be finished before any of the uploads work.** The boot log currently says
   *"Drive: NOT CONFIGURED — every document upload will fail"*. Every item in Part Two is an
   upload, so the checklist cannot move until `docs/DRIVE_ACCESS_SETUP.md` is done.
2. **Whether existing caregivers are made to complete a packet.** Today they are: the gate reads
   the stored packet, so a caregiver on file with none gets the wizard on their next sign-in. If
   the seven existing caregivers should be let through instead, that is an admin action to record
   their packets as complete, not a change to the gate.
3. **Whether `fingerprinting` blocking clearance is right for a new hire's first week**, given it
   has the longest wait of anything on the list.
