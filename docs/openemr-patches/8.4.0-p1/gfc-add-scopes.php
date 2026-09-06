<?php

/**
 * GFC bounded patch 8.4.0-p1 — register the standard-API scopes the 6B routes need.
 *
 * WHY THIS IS NEEDED
 *
 * OpenEMR's standard API derives the required OAuth scope from the route path.
 * HttpRestRouteHandler::checkSecurity() takes the resource from
 * HttpRestParsedRoute (the last path segment) and the permission from the HTTP
 * method (POST => c, PUT => u, DELETE => d, GET => r or s), then
 * AuthorizationListener::onRestApiSecurityCheck() requires
 * "<scopeType>/<resource>.<permission>" to be present on the access token.
 *
 * So `POST /api/patient/:pid/encounter/:eid/billing` demands `user/billing.c`.
 * That is why `.../soap_note` works for the app (it holds `user/soap_note.write`)
 * and the 6B routes returned 401 "Unauthorized" — refused at the scope layer,
 * before the ACL check ever ran. The server confirmed this directly: a client
 * registration carrying `user/billing.read` is rejected with
 * `invalid_scope … Check the user/billing.read scope`.
 *
 * ScopePermissionObject::createFromString maps 'write' => c,u,d and
 * 'read' => r,s, so the .read/.write pair below covers every method these
 * routes serve.
 *
 * WHY EDIT THIS FILE
 *
 * The list is a private array built inside ServerScopeListEntity::apiScopes(),
 * not a returned file, so it cannot be wrapped the way the route map is.
 * OpenEMR does expose RestApiScopeEvent as an official extension point, but
 * listening to it requires a registered module, which is a database change and
 * a much larger surface than this. This inserts into the array instead,
 * anchored on a single stable line rather than a context diff, and refuses to
 * run if anything about that anchor has changed.
 *
 * Run from the Dockerfile. Idempotent: a second run is a no-op.
 *
 * @package   OpenEMR
 * @author    Godwins Family Care (GFC Care Platform)
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

$file = $argv[1] ?? null;
if (!$file || !is_file($file)) {
    fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: ServerScopeListEntity.php not found at " . var_export($file, true) . "\n");
    fwrite(STDERR, "OpenEMR has moved it. The patch needs regenerating against this version.\n");
    exit(1);
}

$scopes = [
    'user/billing.read',    // GET  .../encounter/{eid}/billing        (r/s)
    'user/billing.write',   // POST .../billing, DELETE .../billing/{id} (c/d)
    'user/order.read',      // GET  .../encounter/{eid}/order          (r/s)
    'user/order.write',     // POST .../order, PUT .../order/{id}      (c/u)
    'user/codes.read',      // GET  /api/codes                         (s)
];

$src = file_get_contents($file);
if ($src === false) {
    fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: could not read $file\n");
    exit(1);
}

// Already applied? Then this is a rebuild on a patched base, or a second run.
$already = 0;
foreach ($scopes as $s) {
    if (str_contains($src, '"' . $s . '"') || str_contains($src, "'" . $s . "'")) {
        $already++;
    }
}
if ($already === count($scopes)) {
    echo "GFC 8.4.0-p1: scopes already present, nothing to do.\n";
    exit(0);
}
if ($already !== 0) {
    fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: $already of " . count($scopes) . " scopes already present.\n");
    fwrite(STDERR, "The file is in a half-patched state. Rebuild from the stock image.\n");
    exit(1);
}

// Anchor on the populated array assignment. The empty initialisers elsewhere in
// the class are written "= [];" and do not match this pattern.
$anchor = '/(\$this->v1ApiScopes\s*=\s*\[\r?\n)/';
$count = preg_match_all($anchor, $src);
if ($count !== 1) {
    fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: expected exactly 1 populated \$this->v1ApiScopes array, found $count.\n");
    fwrite(STDERR, "OpenEMR has restructured its scope list. The patch needs regenerating against this version.\n");
    exit(1);
}

$insert = '';
foreach ($scopes as $s) {
    $insert .= '                "' . $s . '", // GFC bounded patch 8.4.0-p1' . "\n";
}

$out = preg_replace($anchor, '$1' . $insert, $src, 1);
if ($out === null || $out === $src) {
    fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: insertion produced no change.\n");
    exit(1);
}

if (file_put_contents($file, $out) === false) {
    fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: could not write $file\n");
    exit(1);
}

// Prove every scope landed.
$check = file_get_contents($file);
foreach ($scopes as $s) {
    if (!str_contains($check, '"' . $s . '"')) {
        fwrite(STDERR, "GFC 8.4.0-p1 SCOPE PATCH FAILED: $s missing after write.\n");
        exit(1);
    }
}

echo "GFC 8.4.0-p1: added " . count($scopes) . " standard-API scopes (" . implode(', ', $scopes) . ").\n";
exit(0);
