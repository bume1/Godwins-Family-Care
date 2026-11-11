# Announcement emails keep line breaks and section headings

**Date:** 2026-11-10 · **Owner-directed** ("particularly for announcement email")

## What changed
- An office announcement's email (`staffAnnouncements.emailFor`) carries `format: 'announcement'`.
  - The queue now keeps that field.
  - `buildQueuedEmail` turns it into two template options.
- **`lineBreaks`:** single line breaks inside a paragraph stay, for example "With gratitude," and the name below it. The text is escaped first, then each line break becomes `<br>`.
- **`capsHeadings`:** a short line written in capitals ("WHAT'S COMING") is drawn as a navy Georgia heading.
- Every other notice renders exactly as before.

## Verified
- `test/announcement_email_format.test.js` (3 tests).
- Full suite 3676, 0 failing.
- The owner's announcement was rendered through the template and checked.
