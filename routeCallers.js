// ============================================================================
// routeCallers.js — does anything in the front end actually call this route?
//
// THE DEFECT CLASS THIS EXISTS FOR. This repo keeps shipping a route that is
// gated, tested, documented and UNREACHABLE: the facility assignment, the MFA
// reset, `acknowledgeAbnormalResult`, the veteran roster edit, and the
// provider picker. Every one looked finished. Route tests proved the endpoint
// worked, page tests proved the component rendered, and nothing asserted the
// two were connected — so the capability silently did not exist and every
// signal in the repo read green.
//
// So this module answers one question, mechanically, and `test/no_orphan_routes`
// fails the build on a route nobody calls and nobody has justified.
//
// WHAT IT IS NOT. It proves a path APPEARS in a page, never that the button is
// reachable or that the condition around it is ever true. The care-coordinator
// bug (2026-11-05) would have PASSED this: the route was called, behind a flag
// that was false for that role. That class needs a browser probe, and saying so
// here is cheaper than someone later trusting this for more than it does.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROUTE_RE = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]+)\2/g;

// ---- Reading a path out of source ---------------------------------------
// A path reaches a page in four shapes and all four must be read, because a
// shape we cannot read is a false "nobody calls this" and a false alarm is how
// a guard gets switched off.

// `${...}` with NESTED braces and backticks. A naive /\$\{[^}]*\}/ stops at the
// first `}` inside `${q ? `?q=${x}` : ''}` and mangles the rest of the path —
// that single bug reported `/api/clinical/patients` (called four times) as an
// orphan.
const stripInterpolations = (s) => {
  let out = '', i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
        j++;
      }
      out += '\u0001';
      i = j;
    } else { out += s[i]; i++; }
  }
  return out;
};

const readLiteral = (src, i) => {
  const q = src[i];
  let j = i + 1, out = '';
  while (j < src.length) {
    if (src[j] === '\\') { out += src[j + 1]; j += 2; continue; }
    if (src[j] === q) return { text: out, end: j + 1 };
    out += src[j]; j++;
  }
  return null;
};

// Walk past one operand of a `+` chain. Character-level rather than a regex,
// because `encodeURIComponent(a, b)` carries its own commas and quotes and a
// regex ends the chain on the first one.
const skipOperand = (src, i) => {
  let depth = 0, j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0) return j; depth--; }
    else if (c === "'" || c === '"' || c === '`') {
      const lit = readLiteral(src, j);
      if (!lit) return j;
      j = lit.end; continue;
    } else if (depth === 0 && (c === '+' || c === ',' || c === ';' || c === '\n' || c === '}')) return j;
    j++;
  }
  return j;
};

// `'/api/x/' + encodeURIComponent(id) + '/documents'` → /api/x/<param>/documents
const concatChainFrom = (src, i) => {
  const first = readLiteral(src, i);
  if (!first) return null;
  const parts = [first.text];
  let j = first.end;
  for (;;) {
    let k = j;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== '+') break;
    k++;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] === "'" || src[k] === '"' || src[k] === '`') {
      const lit = readLiteral(src, k);
      if (!lit) break;
      parts.push(lit.text); j = lit.end;
    } else {
      parts.push('\u0001'); j = skipOperand(src, k);
    }
  }
  return { text: parts.join(''), end: j };
};

// One caller string yields SEVERAL candidate paths, because an interpolation
// may be a path parameter, a query string, or nothing at all.
const callerVariants = (raw) => {
  const at = raw.indexOf('/api/');
  if (at < 0) return [];
  const s = stripInterpolations(raw.slice(at)).split('?')[0].split('#')[0];
  const out = new Set();
  const add = (x) => {
    const t = x.replace(/\/+$/, '');
    if (t.startsWith('/api/')) out.add(t);
  };
  add(s.replace(/\u0001/g, ':p'));                        // each interp is a param
  add(s.replace(/\u0001/g, ''));                          // each interp is empty
  add(s.replace(/\u0001$/, '').replace(/\u0001/g, ':p')); // the trailing one is a query
  return [...out];
};

const normalizeRoutePath = (p) => p.replace(/:[A-Za-z0-9_]+/g, ':p').replace(/\/+$/, '');

// ---- Collecting ----------------------------------------------------------
const collectFrontEndFiles = (root, dir = 'public') => {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${d}/${e.name}`);
      else if (/\.(html|js|jsx)$/.test(e.name)) found.push(`${d}/${e.name}`);
    }
  };
  walk(dir);
  return found;
};

const collectRoutes = (root) => {
  const files = ['server.js'];
  for (const f of fs.readdirSync(path.join(root, 'routes'))) {
    if (f.endsWith('.js')) files.push(`routes/${f}`);
  }
  const routes = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src)) !== null) {
      if (!m[3].startsWith('/api/')) continue;
      routes.push({
        method: m[1].toUpperCase(),
        path: m[3],
        file,
        line: src.slice(0, m.index).split('\n').length
      });
    }
  }
  return routes;
};

const collectCallerPaths = (root) => {
  const files = collectFrontEndFiles(root);
  const paths = new Set();
  const helpers = {};

  // A page may build a base once and append to it:
  //   const visit = (id, e) => `/api/clinical/patients/${id}/encounters/${e}`
  // then call `${visit(a, b)}/charges`.
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    let m;
    const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*`([^`]*\/api\/[^`]*)`/g;
    while ((m = re.exec(src)) !== null) helpers[m[1]] = m[2];
  }

  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');

    // Every quoted string carrying /api/. Deliberately does NOT skip ahead
    // past what it reads: an earlier version advanced to the end of each
    // concat chain and swallowed nested literals, losing real callers.
    const lit = /(['"`])((?:[^'"`\\]|\\.)*\/api\/(?:[^'"`\\]|\\.)*)\1/g;
    let m;
    while ((m = lit.exec(src)) !== null) for (const v of callerVariants(m[2])) paths.add(v);

    // Concat chains, started only from a literal that already carries /api/.
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c !== "'" && c !== '"' && c !== '`') continue;
      if (!src.slice(i, i + 300).includes('/api/')) continue;
      const chain = concatChainFrom(src, i);
      if (chain && chain.text.includes('/api/')) {
        for (const v of callerVariants(chain.text)) paths.add(v);
      }
    }

    // `${helper(...)}/suffix`
    const viaHelper = /`\$\{([A-Za-z_$][\w$]*)\([^)]*\)\}([^`]*)`/g;
    while ((m = viaHelper.exec(src)) !== null) {
      if (helpers[m[1]]) for (const v of callerVariants(helpers[m[1]] + m[2])) paths.add(v);
    }
  }
  return paths;
};

// ---- The verdict --------------------------------------------------------
// A caller path ending in a parameter also satisfies a route that differs only
// in that last segment being a literal, because the action name is often a
// variable: `'/api/scheduling/shifts/' + id + '/' + act` is a real caller of
// clock-in, clock-out, approve and the rest. Permissive by intent — the
// question here is whether ANYTHING calls the route.
const buildMatcher = (callerPaths) => {
  const dynamicBases = new Set();
  for (const c of callerPaths) {
    const seg = c.split('/');
    if (seg[seg.length - 1] === ':p') dynamicBases.add(seg.slice(0, -1).join('/'));
  }
  return (routePath) => {
    const n = normalizeRoutePath(routePath);
    if (callerPaths.has(n)) return 'literal';
    const seg = n.split('/');
    if (seg.length > 2 && dynamicBases.has(seg.slice(0, -1).join('/'))) return 'dynamic-segment';
    return null;
  };
};

module.exports = {
  collectRoutes,
  collectCallerPaths,
  buildMatcher,
  normalizeRoutePath,
  callerVariants,
  stripInterpolations,
  concatChainFrom
};
