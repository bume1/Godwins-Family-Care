# GFC bounded patch for OpenEMR 8.4.0 — derived image
#
# Master Setup Guide v4 Phase 6B: "Prefer a build that survives pulls: a
# bind-mounted override of the two touched files, or a small derived image
# (FROM openemr/openemr:8.4.0 plus COPY of the patched files) tagged
# gfc/openemr:8.4.0-p1. The derived image is cleaner and the compose tag
# change is one line."
#
# Build on the EC2 box (see INSTALL.md), then change one line in
# /opt/openemr/docker-compose.yml:
#     image: gfc/openemr:8.4.0-p1
#
# Re-run the build after every `docker compose pull` of a new upstream 8.4.x
# (control C-10, monthly). If the upstream route file changes, apply.sh will
# say so instead of silently producing a broken image.

FROM openemr/openemr:8.4.0

# The webroot inside the official image.
ARG OE=/var/www/localhost/htdocs/openemr

# 1. The new controller (a new file — touches nothing that already exists).
COPY src/RestControllers/GfcChargeRestController.php ${OE}/src/RestControllers/GfcChargeRestController.php

# 2. The route registration lines, applied as a diff so a changed upstream file
#    fails the build loudly rather than being overwritten.
COPY apis/routes/_rest_routes_standard.inc.php.patch /tmp/gfc-routes.patch
RUN cd ${OE} \
 && patch -p1 --forward --no-backup-if-mismatch < /tmp/gfc-routes.patch \
 && rm -f /tmp/gfc-routes.patch \
 && php -l apis/routes/_rest_routes_standard.inc.php \
 && php -l src/RestControllers/GfcChargeRestController.php

LABEL org.godwinsfamilycare.patch="8.4.0-p1" \
      org.godwinsfamilycare.patch.routes="fee-sheet charge, procedure order, code search" \
      org.godwinsfamilycare.patch.base="openemr/openemr:8.4.0"
