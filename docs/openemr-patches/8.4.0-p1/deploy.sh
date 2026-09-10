#!/bin/sh
#
# GFC bounded patch 8.4.0-p1 — fetch, verify, build, and prove it took.
#
# WHY THIS EXISTS. The manual sequence in INSTALL.md is four steps, and the
# first one failing is invisible: the build copies whatever is already in
# /opt/openemr/gfc-patch/, so a rebuild after a failed fetch succeeds, changes
# nothing, and reports success. That has now happened twice — 2026-09-09 with
# the code-search controller, and 2026-09-10 with the document read. Both times
# the operator did nothing wrong; the sequence allowed a silent no-op.
#
# So this script is one paste that CANNOT skip a step:
#   - `set -e` stops at the first failure, so a failed fetch never reaches a build
#   - every file is verified against the published SHA256SUMS BEFORE the build
#   - the build's own result is verified INSIDE THE RUNNING CONTAINER afterwards
#
# That last point is the one that matters most. An unauthenticated HTTP check
# proves nothing here: OpenEMR authenticates before it matches a route, so every
# path answers 401 — including paths that do not exist. Verified 2026-09-10.
# The only honest question is whether the files serving requests are the files
# we published, and the only way to answer it is to read them where they run.
#
#   curl -fL -o /tmp/gfc-deploy.sh https://raw.githubusercontent.com/bume1/Godwins-Family-Care/main/docs/openemr-patches/8.4.0-p1/deploy.sh
#   sudo sh /tmp/gfc-deploy.sh
#
# Safe to re-run. It changes nothing until every file verifies.

set -eu

BRANCH="${GFC_PATCH_BRANCH:-main}"
REPO=bume1/Godwins-Family-Care
PATCH_DIR="${GFC_PATCH_DIR:-/opt/openemr/gfc-patch}"
COMPOSE_DIR="${GFC_COMPOSE_DIR:-/opt/openemr}"
OE=/var/www/localhost/htdocs/openemr

FILES="Dockerfile
gfc-add-scopes.php
apis/routes/_rest_routes_standard.inc.php
apis/routes/_rest_routes_gfc.inc.php
src/RestControllers/GfcChargeRestController.php
src/RestControllers/GfcDocumentRestController.php"

say() { printf '\n== %s\n' "$1"; }
die() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }

[ -d "$COMPOSE_DIR" ] || die "$COMPOSE_DIR does not exist. Is this the OpenEMR host?"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $COMPOSE_DIR."

say "1/5  Staging into $PATCH_DIR (nothing is replaced until every file verifies)"
mkdir -p "$PATCH_DIR"
STAGE=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$STAGE'" EXIT
mkdir -p "$STAGE/src/RestControllers" "$STAGE/apis/routes"

# Resolve the branch to a COMMIT SHA and fetch by that, never by branch name.
#
# raw.githubusercontent.com negatively caches a path for a few minutes: a file
# that has just landed on a branch answers 404 by branch name while the same
# content answers 200 by commit sha. Measured 2026-09-10 — 404 for roughly two
# minutes after the push, then 200, with nothing changing in between.
#
# That is almost certainly what broke the 2026-09-10 attempt: the operator ran
# the fetch minutes after the merge, got a cached 404 on the newly added file,
# and the guide's `curl -s` printed nothing about it.
#
# A sha path is immutable and never stale, and it also means this run installs
# one exact commit rather than "whatever the branch says right now".
say "2/5  Resolving $BRANCH to a commit"
SHA=$(curl -fL --retry 3 --retry-delay 2 -sS "https://api.github.com/repos/$REPO/commits/$BRANCH" \
      | grep -m1 '"sha"' | cut -d'"' -f4) \
    || die "could not reach the GitHub API to resolve $BRANCH."
case "$SHA" in
    ????????????????????????????????????????) : ;;
    *) die "did not get a commit sha for $BRANCH (got: '${SHA:-empty}'). Check the server's outbound access to api.github.com." ;;
esac
printf '   %s is %s\n' "$BRANCH" "$SHA"
BASE="https://raw.githubusercontent.com/$REPO/$SHA/docs/openemr-patches/8.4.0-p1"

say "   Fetching by commit sha (immune to the raw-CDN cache above)"
for f in $FILES; do
    printf '   %s ... ' "$f"
    # -f makes an HTTP error an exit code instead of a saved error page, and
    # `set -e` turns that into a stop. A fetch that fails can no longer be
    # followed by a build.
    if curl -fL --retry 3 --retry-delay 2 -sS -o "$STAGE/$f" "$BASE/$f"; then
        printf 'ok\n'
    else
        die "could not fetch $f from $BASE. Check the server's outbound access to raw.githubusercontent.com, then re-run."
    fi
done
curl -fL --retry 3 --retry-delay 2 -sS -o "$STAGE/SHA256SUMS" "$BASE/SHA256SUMS" \
    || die "could not fetch SHA256SUMS."

say "3/5  Verifying what was fetched against the published manifest"
( cd "$STAGE" && sha256sum -c SHA256SUMS ) \
    || die "a fetched file does not match its published checksum. Nothing was installed."

# Only now does anything on the box change.
for f in $FILES; do
    d=$(dirname "$f")
    [ "$d" = "." ] || mkdir -p "$PATCH_DIR/$d"
    cp "$STAGE/$f" "$PATCH_DIR/$f"
done
cp "$STAGE/SHA256SUMS" "$PATCH_DIR/SHA256SUMS"
printf '   staged files installed into %s (from commit %s)\n' "$PATCH_DIR" "$SHA"

say "4/5  Rebuilding (two to five minutes)"
cd "$COMPOSE_DIR"
docker compose build --pull
docker compose up -d
WAIT="${GFC_WAIT_SECONDS:-60}"
printf '   waiting %ss for Apache to settle' "$WAIT"
elapsed=0
while [ "$elapsed" -lt "$WAIT" ]; do printf '.'; sleep 5; elapsed=$((elapsed + 5)); done
printf '\n'

say "5/5  Proving it took — reading the files INSIDE the running container"
# Not an HTTP status. OpenEMR authenticates before it routes, so an
# unauthenticated request returns 401 for every path, real or invented, and
# cannot distinguish a deployed patch from an absent one.
CONTAINER_SUMS=$(docker compose exec -T openemr sha256sum \
    "$OE/apis/routes/_rest_routes_standard.inc.php" \
    "$OE/apis/routes/_rest_routes_gfc.inc.php" \
    "$OE/src/RestControllers/GfcChargeRestController.php" \
    "$OE/src/RestControllers/GfcDocumentRestController.php" 2>/dev/null) \
    || die "could not read the patch files inside the container. The build may not have started, or a file is missing — check 'docker compose logs'."

fail=0
for f in apis/routes/_rest_routes_standard.inc.php \
         apis/routes/_rest_routes_gfc.inc.php \
         src/RestControllers/GfcChargeRestController.php \
         src/RestControllers/GfcDocumentRestController.php; do
    want=$(grep "  $f\$" "$PATCH_DIR/SHA256SUMS" | cut -d' ' -f1)
    got=$(printf '%s\n' "$CONTAINER_SUMS" | grep "$OE/$f\$" | cut -d' ' -f1)
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
        printf '   OK       %s\n' "$f"
    else
        printf '   MISMATCH %s\n      published %s\n      running   %s\n' "$f" "${want:-?}" "${got:-missing}"
        fail=1
    fi
done

# The upstream route map must still be preserved alongside ours, or the wrapper
# throws at runtime and every standard route dies with it.
docker compose exec -T openemr test -f "$OE/apis/routes/_rest_routes_standard.upstream.inc.php" \
    || { printf '   MISSING  the preserved upstream route map\n'; fail=1; }

if [ "$fail" -ne 0 ]; then
    die "the running container is NOT serving the published files. Do not rely on the new routes. Re-run this script; if it repeats, check 'docker compose build' output for a cached layer."
fi

printf '\nDONE. The container is serving the published patch files (commit %s).\n' "$SHA"
printf 'Next: the app team runs acceptance.js, which files a test document and\n'
printf 'asserts the bytes that come back — not a status code.\n'
