# GFC bounded patch for OpenEMR 8.4.0 — derived image
#
# Master Setup Guide v4 Phase 6B: "Prefer a build that survives pulls: a
# bind-mounted override of the two touched files, or a small derived image
# (FROM openemr/openemr:8.4.0 plus COPY of the patched files) tagged
# gfc/openemr:8.4.0-p1. The derived image is cleaner and the compose tag
# change is one line."
#
# Referenced from /opt/openemr/docker-compose.yml as a build context, so the
# stock image name never appears in the compose file and no stray
# `docker compose pull` can quietly put unpatched OpenEMR back (see INSTALL.md):
#     build:
#       context: /opt/openemr/gfc-patch
#     image: gfc/openemr:8.4.0-p1
#
# The monthly routine (control C-10) is then one command, which refreshes the
# base image and re-applies this patch on top of it:
#     docker compose build --pull && docker compose up -d
#
# NO DIFF, AND NO `patch` BINARY. The first version of this file applied a
# unified diff to OpenEMR's route map. That failed on this image (Alpine-based,
# ships no `patch`), and it was the wrong shape anyway: a diff against upstream's
# route map goes stale the moment upstream edits that file for any unrelated
# reason, which would break a monthly rebuild over a change that has nothing to
# do with us.
#
# Instead: OpenEMR's route map is a plain PHP file that RETURNS AN ARRAY
# (StandardRouteFinder does `$routes = include .../_rest_routes_standard.inc.php`).
# So the stock file is renamed aside, kept byte-for-byte, and a small wrapper
# takes its place that includes it and merges our routes in. Upstream can
# rewrite the contents of its route map freely and our routes still load. The
# only upstream change that breaks this is renaming or removing the route map
# file itself, which fails loudly at build time (step 2) and again at runtime.

FROM openemr/openemr:8.4.0

# The webroot inside the official image.
ARG OE=/var/www/localhost/htdocs/openemr

# 1. The controller. A new file: it overwrites nothing, and resolves through
#    composer's PSR-4 map (OpenEMR\ => src/), which this build does not dump as
#    classmap-authoritative, so no require_once or autoloader regeneration is
#    needed.
COPY src/RestControllers/GfcChargeRestController.php ${OE}/src/RestControllers/GfcChargeRestController.php

# 2. Move OpenEMR's route map aside, unmodified. Guarded so the build fails
#    loudly if the file is not where we expect, or if it is already one of ours
#    (which would mean this is being layered on a patched image rather than a
#    stock one, and would recurse at runtime).
RUN set -eu; \
    cd ${OE}/apis/routes; \
    if [ ! -f _rest_routes_standard.inc.php ]; then \
        echo "GFC 8.4.0-p1 BUILD FAILED: apis/routes/_rest_routes_standard.inc.php not found." >&2; \
        echo "OpenEMR has moved or renamed its route map. The patch needs regenerating." >&2; \
        exit 1; \
    fi; \
    if grep -q 'GFC patch 8.4.0-p1' _rest_routes_standard.inc.php; then \
        echo "GFC 8.4.0-p1 BUILD FAILED: the base image already carries this patch." >&2; \
        echo "Build FROM the stock openemr/openemr image, not from gfc/openemr." >&2; \
        exit 1; \
    fi; \
    mv _rest_routes_standard.inc.php _rest_routes_standard.upstream.inc.php

# 3. Our two route files: the wrapper that takes the stock file's place, and the
#    GFC route map it merges in.
COPY apis/routes/_rest_routes_standard.inc.php ${OE}/apis/routes/_rest_routes_standard.inc.php
COPY apis/routes/_rest_routes_gfc.inc.php ${OE}/apis/routes/_rest_routes_gfc.inc.php

# 4. Syntax-check everything we placed, plus the preserved upstream map, so a
#    broken file cannot reach a running container.
RUN set -eu; \
    cd ${OE}; \
    php -l src/RestControllers/GfcChargeRestController.php; \
    php -l apis/routes/_rest_routes_standard.inc.php; \
    php -l apis/routes/_rest_routes_gfc.inc.php; \
    php -l apis/routes/_rest_routes_standard.upstream.inc.php; \
    echo "GFC 8.4.0-p1: route map wrapped, all files syntax-clean."

LABEL org.godwinsfamilycare.patch="8.4.0-p1" \
      org.godwinsfamilycare.patch.routes="fee-sheet charge, procedure order, code search" \
      org.godwinsfamilycare.patch.method="route-map wrapper (no diff, no patch binary)" \
      org.godwinsfamilycare.patch.base="openemr/openemr:8.4.0"
