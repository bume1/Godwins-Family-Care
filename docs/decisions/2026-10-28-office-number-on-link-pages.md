# The upload link and password reset pages show the office main line

Owner, 2026-10-28: "fix to main line."

- The no-login upload link page showed (888) 365-8378 in the header and on its error screens and (404) 913-4582 in its footer; the password reset page showed (888) 365-8378. Neither was GFC's main line.
- Both pages now show **404-913-6705**, `ORG.phone` in `public/consent-text.js`, the number the consents print. Each is a `tel:` link.
- The upload link page writes it once (`OFFICE_PHONE`), because it also shows the number on a dead or turned-off link, where the server sends nothing back.
- A test in `test/upload_links.test.js` fails if the link page's number drifts from `ORG.phone`, or if either old number comes back on either page.
