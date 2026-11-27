# Secrets and a patient's details removed from the public repo (2026-11-25)

**Owner:** "you can remove any passwords and stuff that's seen in code."

This repository is public. Four things in it should never have been there:
- `.replit` held the OpenEMR client id, **client secret**, API username and **API password**. Removed.
- `docs/source-forms/gfc_roi_upload.gs` held a one-time Apps Script data fix. It named a real patient and family member, gave the family member's email, and included her ROI upload token. The whole function is removed.
- `docs/source-forms/template-gfc-intake-3.php` held the website intake's **master unlock code**. Replaced with a placeholder.
- `docs/source-forms/template-gfc-roi-upload.php` used that real token as a sample placeholder. Replaced.

## This does not undo the exposure
Git history and any forks still hold every value. **Removing them from the files is the smaller half of the fix.**
- **Rotate the OpenEMR API password and the client secret.** The 2026-09-08 finding still stands: the password grant does not check the secret. So the password alone was the EMR's whole perimeter.
- **Change the intake unlock code** in the live WordPress page and its Apps Script.
- **Make the repository private.**
- Consider whether the patient's name and email in a public file is a reportable disclosure. Raise it with counsel alongside the earlier items.
