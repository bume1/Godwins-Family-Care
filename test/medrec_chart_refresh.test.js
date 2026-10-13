// The chart's Medications list and the reconciliation under it read the same
// OpenEMR list, but the list comes from the chart, which loads once. Resolving
// writes to OpenEMR, so it must reload the chart, or the list keeps reading
// "Nothing on file in OpenEMR" while every row below reads "Both"
// (owner screenshot, 2026-10-12).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

test('a successful reconciliation calls back to reload the chart', () => {
  assert.match(src, /const MedRecTab = \(\{ patient, onSaved \}\) =>/);
  assert.match(src, /load\(\); onSaved && onSaved\(\); \}\)/);
});

test('the Medications place hands the chart reload to the reconciliation', () => {
  assert.match(src, /const MedicationsTab = \(\{ chart, patient, onChartChanged \}\) =>/);
  assert.match(src, /<MedRecTab patient=\{patient\} onSaved=\{onChartChanged\} \/>/);
});

test('every place that renders the Medications tab passes a chart reload', () => {
  const uses = src.match(/<MedicationsTab [^\n]*/g) || [];
  assert.ok(uses.length >= 2, 'expected the chart tab and the in-encounter lookup');
  for (const u of uses) assert.match(u, /onChartChanged=\{/, u);
});
