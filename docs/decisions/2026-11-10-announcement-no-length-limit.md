# Announcements have no message length limit

**Date:** 2026-11-10 · **Owner-directed** ("It cut off a subset of my email announcement")

The announcement route quietly cut the message at 4,000 characters (`announcements.BODY_MAX`), so a long announcement posted and emailed with its ending missing and no warning. The cap is removed. The title keeps its 200-character limit.

Verified: a 9,000-character message carries through to the email in full (`test/announcement_email_format.test.js`); full suite 3677, 0 failing.
