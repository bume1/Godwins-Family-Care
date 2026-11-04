'use strict';
// claimPrefill.js — pre-filled claim lines (owner decision, 2026-11-04).
//
// When the clinician confirms the visit facts, the claim is pre-filled with
// the derived E/M code and every add-on code and modifier the add-on rules
// offer. Every line it writes is marked `suggested`. A human biller reviews:
// saving the coding (buildEncounterServices keeps no `suggested` key) is the
// acceptance, and nothing is submitted or released without a person.
//
// PURE. The caller supplies the add-on evaluation, so this file holds the
// order of operations and nothing else:
//   1. Lines a person entered are never touched or removed.
//   2. Earlier suggestions are replaced, so a re-confirmation cannot stack.
//   3. The E/M line is added only when no person has entered an E/M line.
//   4. Modifier offers are applied first, then the add-ons are re-evaluated,
//      so an add-on that a modifier rules out (G2211 beside -25) is never
//      added in the same breath.

const SUGGESTED_BY = Object.freeze({ EM: 'em_derivation', ADD_ON: 'add_on_rule' });

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

const prefillClaimLines = ({ services, emDerivation, diagnoses, isEmCode, classify, evaluateOffers }) => {
  const human = (Array.isArray(services) ? services : []).filter(s => s && !s.suggested);
  const dxLinks = (Array.isArray(diagnoses) ? diagnoses : []).map(d => d && d.code).filter(Boolean).slice(0, 4);
  const added = [];
  const mkLine = (code, by, units) => {
    const c = classify(code);
    if (!c) return null;
    return { ...c, label: '', units: Number.isInteger(units) && units > 0 ? units : 1, modifiers: [], dxLinks: dxLinks.slice(), suggested: true, suggestedBy: by };
  };

  let lines = human.map(s => ({ ...s, modifiers: Array.isArray(s.modifiers) ? s.modifiers.slice() : [] }));
  const finalCode = emDerivation && emDerivation.finalCode ? upper(emDerivation.finalCode) : null;
  if (finalCode && !lines.some(l => isEmCode(l.code))) {
    const line = mkLine(finalCode, SUGGESTED_BY.EM);
    if (line) { lines.push(line); added.push({ code: finalCode, kind: 'em' }); }
  }

  // Modifiers first (on suggested lines only: a person's line is theirs).
  for (const o of evaluateOffers(lines).filter(x => x.kind === 'modifier')) {
    const target = lines.find(l => l.suggested && upper(l.code) === upper(o.target));
    if (target && !target.modifiers.includes(upper(o.code)) && target.modifiers.length < 4) {
      target.modifiers.push(upper(o.code));
      target.suggestedModifiers = [...(target.suggestedModifiers || []), upper(o.code)];
      added.push({ code: upper(o.code), kind: 'modifier', target: upper(o.target) });
    }
  }
  // Then the add-on codes, re-evaluated against the lines as they now stand.
  for (const o of evaluateOffers(lines).filter(x => x.kind === 'add_on')) {
    if (lines.some(l => upper(l.code) === upper(o.code))) continue;
    const line = mkLine(o.code, SUGGESTED_BY.ADD_ON, o.units);
    if (line) { lines.push(line); added.push({ code: upper(o.code), kind: 'add_on', units: line.units }); }
  }
  return { services: lines, added };
};

module.exports = { SUGGESTED_BY, prefillClaimLines };
