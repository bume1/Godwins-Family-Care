// ============================================================================
// logScrubber.js — PHI never reaches stdout/stderr (Session 5.4)
//
// Application logs leave the boundary: the platform ships them to a log
// service, an engineer pastes them into a ticket, a crash report carries
// them. So every console.* call is routed through scrub(), which redacts the
// identifiers a log line is most likely to carry — email addresses, phone
// numbers, SSNs, dates of birth, bearer tokens and JWTs, OpenEMR
// client secrets, passwords in key=value form — and truncates dumped objects
// so a whole user record cannot be printed by accident.
//
// This is a floor, not a guarantee against every free-text name; the second
// control is that route handlers log `err.message` and codes, never
// `req.body` or a record (build-enforced in test/audit_log.test.js).
// ============================================================================
'use strict';
const util = require('util');

const RULES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:Bearer|bearer)\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [token]'],
  [/\beyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}\b/g, '[jwt]'],
  [/\b(?:password|passwd|pwd|secret|client_secret|refresh_token|access_token|api[_-]?key)\s*[=:]\s*['"]?[^\s'",;]+/gi, (m) => `${m.split(/[=:]/)[0]}=[redacted]`],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
  [/\b(?:dob|date of birth|birthdate)\b[^\n]{0,4}(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/gi, (m, d) => m.replace(d, '[dob]')],
  [/\b(?:19|20)\d{2}-\d{2}-\d{2}(?=\D|$)(?![^"]*"timestamp")/g, (m) => m]  // ISO dates alone are kept (timestamps); DOB rule above handles labelled ones
];
const MAX_LINE = 2000;

const scrubString = (s) => {
  let out = String(s);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE)}… [truncated ${out.length - MAX_LINE} chars]` : out;
};
const scrubValue = (v) => {
  if (v instanceof Error) return scrubString(v.stack || v.message);
  if (typeof v === 'string') return scrubString(v);
  if (v && typeof v === 'object') return scrubString(util.inspect(v, { depth: 2, breakLength: 200, maxArrayLength: 20, maxStringLength: 300 }));
  return v;
};
const scrub = (...args) => args.map(scrubValue);

// install(console) — wraps log/info/warn/error/debug in place. Idempotent.
const install = (target = console) => {
  if (target.__gfcScrubbed) return target;
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = target[m].bind(target);
    target[m] = (...args) => orig(...scrub(...args));
  }
  target.__gfcScrubbed = true;
  return target;
};

module.exports = { scrub, scrubString, install, RULES };
