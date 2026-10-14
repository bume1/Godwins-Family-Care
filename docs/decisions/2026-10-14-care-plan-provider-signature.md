# The provider co-signature prints on the signed care plan PDF (owner request, 2026-10-14)

Owner ask: "add the provider co-signature to the printed pdf."

- **The gap:** `POST …/care-plan/provider-cosign` stored the provider's (or LCSW's) drawn signature on the `care_plan_versions` row, and no PDF builder ever read it. A plan an RN or LMSW authored for a clinical patient printed two signatures when it carried three. The signed-PDF rule says every captured signature prints.
- **Now:** `generateCarePlanPDF` takes `providerSignature` and draws a third block, "Provider co-signature", between the author and the client, with the image, name, time, IP hash and a line naming the credential and NPI it was signed under. A plan that needs it and does not have it yet shows the block as pending and a "PENDING PROVIDER CO-SIGNATURE" banner. A plan that never needed one (`providerCoSignStatus: 'not_required'`) prints no third block.
- **Both builders pass it:** the emission at the client's co-signature (`emitSignedCarePlanPdf`) and the rebuild from app records (`buildCarePlanPdfForVersion`, which the patient download and the chart filing use).
- **Order does not matter.** If the client co-signs first, the signed PDF shows the provider as pending. When the provider then signs, the route issues the signed PDF again with all three signatures (Drive copy and, for a clinical patient, OpenEMR). The signature is stored before that PDF is built. Best-effort, like every PDF emission: a storage failure never voids the signature.
- **Must not undo:** a test renders the PDF and reads the text back for the signed, pending and not-required cases, and checks both builders and the re-issue.
- **Verified:** `test/care_plan_provider_signature.test.js` (5 tests); 8 of 8 deliberate breaks caught. Full suite 2434 pass, 0 fail. The PDF was rendered to an image and checked by eye.
- **Note:** a re-issued PDF is a second file in Drive and, for a clinical patient, a second document in OpenEMR. The client record points at the newest. OpenEMR's API cannot delete the earlier one.
