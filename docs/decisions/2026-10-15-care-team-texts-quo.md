# Care Team messages by text, both ways, through Quo

**Date:** 2026-10-15 · **Owner-directed** ("quo has baa we signed. I want the messages bi
directional", "make sure both patient and POA phone numbers are recognized as being
connected to the patient"). Line: (404) 913-6705, Quo inbox "Godwins Family Care Main".
10DLC approved (owner).

## What it does
- **Out:** a Care Team message goes by text to the patient and their POA, to each person
  who turned texts on. The text carries the message itself (the BAA covers it), the
  sender's name and the portal link. A file is never texted, only "1 file is waiting in your
  portal". The first text says "Reply STOP to stop texts." Email still goes as before.
  Other channels (Support, escalations) are not texted.
- **In:** a text to the office line from the **patient's phone** (their profile phone) or a
  **designated POA's phone** lands in that patient's most recent Care Team thread, as that
  person (a POA reads "<name> as POA for <patient>"), marked "By text". If they have no
  Care Team thread one is started with the whole care team. Plain family numbers are not
  recognised.
- **Quo app:** a text typed in the Quo app on that line to a known patient or POA is
  recorded in the thread as "GFC office (by text …)". The care team is told; the patient is
  not texted it twice. Our own sends echoed back by Quo are recognised and skipped.

## Must not undo
- **Off until the person turns it on** (Profile → Texts from your care team). The client's
  texts go to the phone on their profile; a POA sets their own mobile there.
- **STOP** (and the carrier words) turns it off for that number; START turns it back on only
  for someone who had opted in before. A keyword is the whole text, never a word inside one.
- **No text 9pm to 8am Eastern**; it waits in `sms_outbox` until 8am. A waiting text is
  cancelled if the person turns texts off first. A failed send retries every 5 minutes, 5 times.
- **A number two patients share, or no patient has, is never guessed.** It stays in the Quo
  app only (`ambiguous_number`, `unknown_number` in `sms_events`).
- **The webhook is refused unless Quo's signature checks** over the exact bytes, within 10
  minutes. Each Quo message id is handled once (`sms_events`).
- Pictures sent by text are not fetched; the message says one is in the Quo inbox.

## Setup (owner)
- `QUO_API_KEY` (Quo → Settings → API) and `QUO_WEBHOOK_SECRET` in AWS Secrets Manager.
  `QUO_FROM_NUMBER` is optional; it defaults to the ORG phone.
- In Quo, add a webhook to `https://app.godwinsfamilycarellc.com/api/webhooks/quo` for
  **message.received** and **message.delivered** on the Main number, and copy its signing
  secret into `QUO_WEBHOOK_SECRET`. The boot log says whether sending and replies are on.
- Not proven against live Quo: the probes stub the API. Send yourself a test after deploy.

## Verified
- `test/quo_sms.test.js` (12), 9 of 9 deliberate breaks caught (one survived first; the test
  was fixed to have the office write to the patient on Support).
- `scripts/verify_quo_sms.js` 16/16 through the real server.
- Two mount guards repointed: messaging is now built once as `messagingRouter` and mounted
  once, so the every-minute text sweep can reach it. Full suite 0 failing.
