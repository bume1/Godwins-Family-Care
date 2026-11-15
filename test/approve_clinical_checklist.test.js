'use strict';
// Approve enrollment waits on the pre-visit half of the clinical enrollment
// checklist for a clinical client (owner, 2026-11-09). The H&P and the
// co-signed care plan are deliberately NOT asked for: they need a visit, and a
// visit cannot be booked until the client is enrolled.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const repo = require('../clinicalRepository');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-enrollment.html'), 'utf8');

const satisfied = (c) => !!c && (c.status === 'signed' || c.status === 'signed_offline');
const signed = { status: 'signed' };
const checklistFor = (client, roiEvents = []) => repo.deriveClinicalChecklist({
  client, manualState: (client.clinicalEnrollment || {}).steps, roiEvents, isConsentSatisfied: satisfied
});
const readyClient = () => ({
  id: 'c1', serviceLine: 'IHPC',
  consents: { consentToTreat: signed, assignmentOfBenefits: signed, practiceNpp: signed, roiTransfer: signed },
  clinicalEnrollment: { steps: { payerVerification: { done: true }, npaConfirmation: { done: true } } }
});

test('the pre-approval steps are the four that need no visit', () => {
  assert.deepStrictEqual([...repo.PRE_APPROVAL_CHECKLIST_STEPS].sort(),
    ['consents', 'npaConfirmation', 'payerVerification', 'recordsRoi']);
  for (const k of repo.PRE_APPROVAL_CHECKLIST_STEPS) {
    assert.ok(repo.CLINICAL_ENROLLMENT_STEPS.some(s => s.key === k), `${k} is a real checklist step`);
  }
});

test('a client with the four pre-visit steps done and no visit yet can be approved', () => {
  const c = checklistFor(readyClient());
  assert.strictEqual(c.allDone, false, 'H&P and care plan are still open');
  assert.deepStrictEqual(repo.missingPreApprovalSteps(c), []);
});

test('each pre-visit step, when open, is named', () => {
  const noPayer = readyClient(); delete noPayer.clinicalEnrollment.steps.payerVerification;
  assert.deepStrictEqual(repo.missingPreApprovalSteps(checklistFor(noPayer)), ['Payer verification']);

  const noNpa = readyClient(); noNpa.clinicalEnrollment.steps.npaConfirmation = { done: false };
  assert.deepStrictEqual(repo.missingPreApprovalSteps(checklistFor(noNpa)), ['NPA / prescriptive authority confirmed']);

  const noRoi = readyClient(); delete noRoi.consents.roiTransfer;
  assert.deepStrictEqual(repo.missingPreApprovalSteps(checklistFor(noRoi)), ['Records / Transfer-of-Care ROI']);
  assert.deepStrictEqual(repo.missingPreApprovalSteps(checklistFor(noRoi, [{ id: 'e1' }])), [], 'a signed ROI event satisfies it');

  const noConsent = readyClient(); delete noConsent.consents.practiceNpp;
  assert.deepStrictEqual(repo.missingPreApprovalSteps(checklistFor(noConsent)), ['IHPC consents (treat / AOB / practice NPP)']);
});

test('the approve route checks the steps for a clinical client only, and the override records them', () => {
  const start = SERVER.indexOf("app.post('/api/gfc/admin/enrollment/:clientId/approve'");
  const end = SERVER.indexOf('app.post(', start + 10);
  assert.ok(start > 0 && end > start);
  const route = SERVER.slice(start, end);
  assert.match(route, /if \(isClinicalServiceLine\(client\.serviceLine\)\) \{[\s\S]*?missingPreApprovalSteps\(/);
  assert.match(route, /const incomplete = [^;]*missingClinicalSteps\.length/);
  assert.match(route, /missingClinicalSteps,\s*\/\/ Named so the UI/);
  assert.match(route, /missingFields: comp\.missingFieldLabels,\s*missingClinicalSteps\s*\}\s*: null/, 'frozen on the override record');
});

test('the page lists the missing clinical steps on the refusal and on the override banner', () => {
  assert.match(PAGE, /approveErr\.missingClinicalSteps \|\| \[\]\)\.map/);
  assert.match(PAGE, /enrollmentApproval\.override\.missingClinicalSteps \|\| \[\]\)\.map/);
});
