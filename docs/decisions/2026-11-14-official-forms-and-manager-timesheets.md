# The official W-4, W-9, G-4 and I-9, filled from Pay Setup; managers approve timesheets

Owner-directed, 2026-11-13 and 2026-11-14.

## Official forms

- The employee answers in My GFC → Pay Setup. **Sign and Save fills the agencies' own PDF**: IRS Form W-4 (2026), IRS Form W-9 (Rev. March 2024), Georgia Form G-4 (Rev. 06/03/26), USCIS Form I-9 (Edition 01/20/25). The blanks are in `govforms/`. `govForms.js` does the filling.
- The typed signature (`/s/ name`), its date, and a line naming who signed, when and where are drawn on the form. A ticked box is drawn as a plain X, because the IRS check glyph shows as a stray mark in some viewers.
- W-4, W-9 and G-4 are flattened. **The I-9 is not**: flattening the USCIS file leaves broken empty boxes that viewers report as errors. Its fields are locked read-only instead.
- The signed copy is filed to the person's Staff Record folder in Drive on save (best-effort; a Drive failure never undoes a signature) and noted as `formsFiled` on the profile. A copy can be downloaded at any time: the person their own, the Super Admin anyone's. Each download is logged, because the forms carry the full SSN.
- **The I-9 now asks what the official form asks**: date of birth, other last names, phone, and for a permanent resident the A-Number, or for an authorized worker one of A-Number, Form I-94 or foreign passport. Those numbers, and Section 2 document numbers, are **sealed** (`i9Ids`, `i9DocNumbers`) and never sent to a browser. Section 2 also takes the issuing authority and the reviewer's title. This reverses the earlier "document numbers are not stored": the official form needs them.
- The employer block comes from Settings → Year End (name, address, Georgia withholding ID) and the EIN from Settings, so the forms and the W-2 name GFC the same way.
- **Other states:** a state other than Georgia gets a GFC page with the same answers until its official form is added (`STATE_FORMS` in `govForms.js`). Texas has no state income tax and asks for no form.

## Timesheets: managers approve too

Managers and care coordinators (the Staff Scheduling module) now approve or send back timesheets, through the same route the Super Admin uses. Approving the payroll run stays the Super Admin's. A manager's change to a shift's times is still a time adjustment request, the same route and queue as Request Correction on Staff Scheduling, so there is one path, not two.
