# NCCI PTP source files (human-downloaded, quarterly)

`scripts/load_ncci_tables.js` cannot fetch the Practitioner PTP Edits itself —
CMS puts them behind an AMA license click-through (`cms.gov/license/ama?file=...`)
because the file lists actual CPT codes, and a script cannot accept that
agreement on anyone's behalf.

**Each quarter, a human:**

1. Downloads the four "Practitioner PTP Edits" ZIP files (split by CPT/HCPCS
   code range) from:
   https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits
   Confirm the file names say **"Practitioner,"** not "Outpatient Hospital" or
   "DME" — those are different edit sets for different claim types.
2. Places all four `.zip` files, unmodified, in `scripts/ncci_source/ptp/`
   (this directory).
3. Runs `node scripts/load_ncci_tables.js`.

The MUE table needs no manual step — the script fetches it directly every run.

The zip files themselves are gitignored (`scripts/ncci_source/*.zip`): they
are CMS's own large binary files, not something this repo tracks. If the
script reports it found none, it names this same page again.
