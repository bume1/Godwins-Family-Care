<?php

/**
 * GFC bounded patch 8.4.0-p1 — standard route map wrapper.
 *
 * This file sits at the path StandardRouteFinder includes:
 *     $routes = include __DIR__ . '/../../../apis/routes/_rest_routes_standard.inc.php';
 *
 * OpenEMR's own route map is preserved BYTE-FOR-BYTE alongside it as
 * _rest_routes_standard.upstream.inc.php and is included here unchanged, so
 * every upstream route addition, removal, or edit flows straight through. No
 * upstream line is ever edited, discarded, or hand-merged.
 *
 * This is deliberately not a diff. A diff against upstream's route map goes
 * stale the moment upstream touches that file for any reason, and a stale diff
 * fails a rebuild that has nothing to do with our change. Wrapping the file
 * instead means upstream can rewrite its contents freely and our routes still
 * load. The only upstream change that breaks this is renaming or removing the
 * route map file itself, which is caught below and fails loudly.
 *
 * On collision, UPSTREAM WINS: if a future OpenEMR ships its own route at one
 * of our keys, theirs is canonical and ours is redundant, so array_merge puts
 * the upstream map second.
 *
 * The GFC map returns TWO sets, because that default is right for almost
 * everything and wrong for one case. `routes` are additions and lose a
 * collision to upstream, as above. `overrides` are the listed exceptions and
 * win one — today that is the document read, a route upstream ships broken on
 * this instance (500 "CSRF key is empty", a session check running on a
 * bearer-token request). Each override justifies itself in the GFC map, and
 * there is exactly one reason to add another: upstream ships it dead.
 *
 * @package   OpenEMR
 * @author    Godwins Family Care (GFC Care Platform)
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

$gfcUpstreamRouteMap = __DIR__ . '/_rest_routes_standard.upstream.inc.php';
$gfcRouteMap = __DIR__ . '/_rest_routes_gfc.inc.php';

if (!is_file($gfcUpstreamRouteMap)) {
    throw new \RuntimeException(
        'GFC patch 8.4.0-p1: the stock OpenEMR route map is missing at '
        . $gfcUpstreamRouteMap . '. The derived image gfc/openemr:8.4.0-p1 was not '
        . 'built correctly. Rebuild it, or roll back to the stock image by restoring '
        . 'docker-compose.yml.pre-6b.'
    );
}

if (!is_file($gfcRouteMap)) {
    throw new \RuntimeException(
        'GFC patch 8.4.0-p1: the GFC route map is missing at ' . $gfcRouteMap
        . '. The derived image was not built correctly.'
    );
}

$gfcStandardRoutes = include $gfcUpstreamRouteMap;
$gfcOurRoutes = include $gfcRouteMap;

if (!is_array($gfcStandardRoutes)) {
    throw new \RuntimeException(
        'GFC patch 8.4.0-p1: the upstream route map did not return an array. OpenEMR '
        . 'may have changed how apis/routes/*.inc.php files are consumed; the patch '
        . 'needs regenerating against this version.'
    );
}

if (
    !is_array($gfcOurRoutes)
    || !isset($gfcOurRoutes['routes']) || !is_array($gfcOurRoutes['routes'])
    || !isset($gfcOurRoutes['overrides']) || !is_array($gfcOurRoutes['overrides'])
) {
    throw new \RuntimeException(
        'GFC patch 8.4.0-p1: the GFC route map must return '
        . "['routes' => [...], 'overrides' => [...]]. The derived image was not built "
        . 'correctly, or the two patch files are from different versions.'
    );
}

// Additions first (upstream wins a collision), then the listed overrides last
// (ours wins, deliberately, for the keys named in the GFC map).
return array_merge($gfcOurRoutes['routes'], $gfcStandardRoutes, $gfcOurRoutes['overrides']);
