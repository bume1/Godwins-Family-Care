# Finance email: invoice signature, Reply-To and a finance copy (owner, 2026-11-27)

**Ask.** Add "Kelvin Ume, BSN, RN" to the invoice email signature and use
finance@godwinsfamilycarellc.com there. Replies go to finance, and finance is
copied on every outgoing payroll and billing email.

**What changed**
- `config.ORG_FINANCE_EMAIL` (env `ORG_FINANCE_EMAIL`, default finance@).
- `emailTemplates.FINANCE_SIGNOFF`: signs as **Kelvin Ume, BSN, RN**, and its
  `email` replaces support@ in that email's signature, text half and footer.
  Every other notice still signs "The Godwins Family Care Team" with support@.
- `email.js` supports `cc` on every path (Gmail MIME `Cc:` header, Resend single
  and batch). `copyList` drops a copy that repeats a To address or is a placeholder.
- `financeMail.js` holds the one list of payroll and billing notice types. The
  queue drain copies finance and sets Reply-To for those types, once per notice
  per batch so a reminder sent to several payroll runners reaches finance once.
- Direct sends: the billing-run invoice email (Kelvin signature, finance copy and
  Reply-To) and the "you have a new statement" notice (finance copy and Reply-To).

**Not included, on purpose:** shift, time-clock and time-adjustment notices.
They are scheduling even though hours feed pay. Add a type to `FINANCE_TYPES` to change that.

**Sending address is unchanged.** Mail still goes FROM `GMAIL_SEND_AS`; only
Reply-To and Cc point at finance, so no new Workspace delegation is needed.
finance@ must be a real mailbox, group or alias that receives mail.
