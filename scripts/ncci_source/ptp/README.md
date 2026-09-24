# Drop the CMS PTP zip files here

Place the four "Practitioner PTP Edits" `.zip` files you download from CMS
directly in this folder. See `../README.md` for where to get them.

This file exists only so the folder itself is tracked in git and therefore
present in the Docker image on every build — an empty folder is not
committed by git, so without this file `scripts/ncci_source/ptp/` would not
exist inside the container and you'd have to create it by hand after every
deploy.
