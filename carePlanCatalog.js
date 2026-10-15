// ============================================================
// Care plan catalog: standard interventions, pick-lists and pathway
// templates (owner, 2026-10-14)
//
// Pure data plus two helpers. Served to the care plan form so a clinician
// picks rather than types, and every intervention carries a stable `code`
// that reporting and decision support can target (a free-text description
// cannot be counted). "Other" stays available: a code of `custom` keeps the
// clinician's own words.
//
// Clinical content here is a STARTING POINT a clinician edits, never a
// protocol. A template adds rows to the form; nothing is saved until the
// author signs, and every row can be changed or removed first.
//
// EVIDENCE (owner, 2026-10-14: "use evidence based suggestion lists"):
//   - Every pathway names the guideline it follows (`source`), shown on the
//     form. Thresholds and targets follow those guidelines and are written
//     to be individualized, never as a fixed order.
//   - Every intervention carries its Omaha System intervention category
//     (`omaha`): the public-domain home health terminology (omahasystem.org,
//     distributed in the NLM UMLS as source OMS). Teaching, Guidance and
//     Counseling · Treatments and Procedures · Case Management · Surveillance.
//   - OpenEMR is NOT the source today: this instance has ICD-10 loaded and no
//     care plan code set (SNOMED CT is not loaded), and the app cannot read
//     OpenEMR outside a clinician's own session. No terminology code is
//     written here that nothing could check; a SNOMED or Omaha target code
//     can be added per row once that code set is loaded.
// ============================================================

// ---- Standard interventions ---------------------------------------------
// type: clinical | medication | caregiver_task | education | equipment | referral
// responsible / frequency: the default the form fills in.
const OMAHA = Object.freeze({
  TGC: 'Teaching, Guidance and Counseling', TP: 'Treatments and Procedures', CM: 'Case Management', S: 'Surveillance'
});
const INTERVENTIONS_RAW = [
  // Monitoring
  { code: 'daily_weight', label: 'Daily weight, logged before breakfast', type: 'caregiver_task', responsible: 'gfc_caregiver', frequency: 'daily' },
  { code: 'bp_check', label: 'Blood pressure check', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'glucose_check', label: 'Blood glucose check', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'edema_check', label: 'Check ankles and legs for swelling', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'oxygen_sat', label: 'Oxygen saturation check', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'foot_check', label: 'Foot and skin check', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'skin_check', label: 'Skin integrity check and repositioning plan', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'cognition_check', label: 'Cognition and mood check', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  // Medication
  { code: 'med_review', label: 'Medication review, adjust to trend', type: 'medication', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'med_reconcile', label: 'Medication reconciliation', type: 'medication', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'med_reminder', label: 'Medication reminders', type: 'caregiver_task', responsible: 'gfc_caregiver', frequency: 'each_visit' },
  { code: 'pharmacy_pack', label: 'Set up pharmacy blister packs', type: 'medication', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'inhaler_technique', label: 'Check inhaler technique', type: 'medication', responsible: 'gfc_clinician', frequency: 'each_visit' },
  // Education
  { code: 'edu_low_sodium', label: 'Low-sodium diet and fluid education', type: 'education', responsible: 'gfc_clinician', frequency: 'ongoing' },
  { code: 'edu_diabetes', label: 'Diabetes self-management education', type: 'education', responsible: 'gfc_clinician', frequency: 'ongoing' },
  { code: 'edu_hypoglycemia', label: 'Low blood sugar signs and what to do', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'edu_warning_signs', label: 'Teach the warning signs and when to call', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'edu_fall_prevention', label: 'Fall prevention education', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'edu_breathing', label: 'Breathing and energy-saving techniques', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'edu_family_dementia', label: 'Family education on dementia care', type: 'education', responsible: 'gfc_clinician', frequency: 'ongoing' },
  { code: 'advance_care_planning', label: 'Advance care planning discussion', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  // Safety and equipment
  { code: 'home_safety_eval', label: 'Home safety evaluation', type: 'clinical', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'remove_trip_hazards', label: 'Remove trip hazards (rugs, cords)', type: 'caregiver_task', responsible: 'gfc_caregiver', frequency: 'one_time' },
  { code: 'grab_bars', label: 'Install grab bars in the bathroom', type: 'equipment', responsible: 'family', frequency: 'one_time' },
  { code: 'walker_cane', label: 'Walker or cane, fitted and in use', type: 'equipment', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'bed_alarm', label: 'Bed or chair alarm', type: 'equipment', responsible: 'family', frequency: 'one_time' },
  { code: 'oxygen_safety', label: 'Oxygen equipment safety check', type: 'equipment', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'supervised_walk', label: 'Supervised walking each visit', type: 'caregiver_task', responsible: 'gfc_caregiver', frequency: 'each_visit' },
  { code: 'routine_structure', label: 'Keep a consistent daily routine', type: 'caregiver_task', responsible: 'gfc_caregiver', frequency: 'each_visit' },
  // Referral
  { code: 'ref_pt', label: 'Physical therapy evaluation', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'ref_ot', label: 'Occupational therapy evaluation', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'ref_cardiology', label: 'Cardiology follow-up', type: 'referral', responsible: 'outside_agency', frequency: 'as_needed' },
  { code: 'ref_podiatry', label: 'Podiatry referral', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'ref_eye_exam', label: 'Annual diabetic eye exam', type: 'referral', responsible: 'outside_agency', frequency: 'one_time' },
  { code: 'ref_nutrition', label: 'Dietitian referral', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'ref_social_work', label: 'Social work referral', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'ref_meals', label: 'Meals on Wheels referral', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  // CDC STEADI (fall risk): orthostatic blood pressure, vision, feet and footwear
  { code: 'orthostatic_bp', label: 'Orthostatic blood pressure (lying, then standing)', type: 'clinical', responsible: 'gfc_clinician', frequency: 'each_visit' },
  { code: 'fall_risk_med_review', label: 'Review medications that raise fall risk', type: 'medication', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'ref_vision', label: 'Vision check / eye specialist referral', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'footwear_check', label: 'Check feet and footwear (fit, grip, heel support)', type: 'clinical', responsible: 'gfc_clinician', frequency: 'one_time' },
  // GOLD (COPD)
  { code: 'ref_pulm_rehab', label: 'Pulmonary rehabilitation referral', type: 'referral', responsible: 'gfc_clinician', frequency: 'one_time' },
  { code: 'copd_action_plan', label: 'Written flare-up (action) plan', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  // AHA/ACC (heart failure, blood pressure)
  { code: 'edu_home_bp', label: 'Teach home blood pressure monitoring', type: 'education', responsible: 'gfc_clinician', frequency: 'one_time' },
  // Caregiver support (Alzheimer's Association; CMS GUIDE model)
  { code: 'caregiver_support', label: 'Family caregiver support and respite planning', type: 'referral', responsible: 'gfc_clinician', frequency: 'ongoing' }
];
// Omaha System category by intervention type, with the exceptions named.
const OMAHA_BY_TYPE = { clinical: 'S', medication: 'TP', caregiver_task: 'TP', education: 'TGC', equipment: 'CM', referral: 'CM' };
const OMAHA_EXCEPTIONS = { med_reconcile: 'CM', pharmacy_pack: 'CM', home_safety_eval: 'S', fall_risk_med_review: 'S', daily_weight: 'S', inhaler_technique: 'TGC', med_reminder: 'TP' };
const INTERVENTIONS = Object.freeze(INTERVENTIONS_RAW.map(i => Object.freeze({
  ...i, omaha: OMAHA[OMAHA_EXCEPTIONS[i.code] || OMAHA_BY_TYPE[i.type]]
})));
const CUSTOM_INTERVENTION = 'custom';
const interventionByCode = new Map(INTERVENTIONS.map(i => [i.code, i]));

// ---- Pick-lists ------------------------------------------------------------
// Suggestions, not closed lists: the form offers them and a clinician may
// still type their own.
const PROGNOSIS_OPTIONS = Object.freeze([
  'Good', 'Fair', 'Guarded', 'Poor',
  'Stable with adherence', 'Expected to improve', 'Progressive; focus on comfort and function'
]);
const EXPECTED_OUTCOME_OPTIONS = Object.freeze([
  'No hospitalization or ER visit this plan period',
  'No falls this plan period',
  'Readings stay within the target range',
  'Symptoms managed at home',
  'Independent with self-management',
  'Remains safely at home',
  'Family confident with care at home'
]);

// ---- Pathway templates -------------------------------------------------------
// One click adds the usual problem, goals, interventions, caregiver tasks and
// warning signs for a common pathway. The save drops whatever the client's
// service line does not have (carePlanFormat.SECTIONS_BY_LINE), and the form
// only shows those sections, so a template works for any line.
const PATHWAYS = Object.freeze([
  {
    key: 'chf', label: 'Heart failure (CHF)',
    source: 'AHA/ACC/HFSA 2022 heart failure guideline; AHA "Rise Above Heart Failure" self-check plan',
    problem: { text: 'Heart failure', prognosis: 'Stable with adherence', expectedOutcome: 'No hospitalization or ER visit this plan period' },
    goals: [
      { statement: 'Stay out of the hospital', measure: 'Daily weight', target: 'Within 2-3 lb of dry weight', priority: 'high' },
      { statement: 'Breathe comfortably doing daily activities', measure: 'Shortness of breath at rest', target: 'None', priority: 'medium' }
    ],
    interventions: ['daily_weight', 'edema_check', 'med_review', 'edu_low_sodium', 'edu_warning_signs', 'ref_cardiology'],
    eachVisit: ['Weight before breakfast', 'Check ankles for swelling', 'Confirm medications taken'],
    callGfcWhen: ['Weight up more than 2-3 lb in a day or 5 lb in a week', 'More short of breath than usual, or needs more pillows to sleep', 'New swelling in legs or belly'],
    call911When: ['Chest pain', 'Struggling to breathe at rest', 'Fainting']
  },
  {
    key: 'falls', label: 'Fall risk',
    source: 'CDC STEADI (Stopping Elderly Accidents, Deaths and Injuries); USPSTF 2024 falls prevention (exercise)',
    problem: { text: 'Fall risk', prognosis: 'Fair', expectedOutcome: 'No falls this plan period' },
    goals: [
      { statement: 'No falls', measure: 'Falls per month', target: '0', priority: 'high' },
      { statement: 'Walk safely around the home', measure: 'Uses walking aid every time', target: 'Yes', priority: 'medium' }
    ],
    interventions: ['fall_risk_med_review', 'orthostatic_bp', 'ref_pt', 'home_safety_eval', 'ref_vision', 'footwear_check', 'remove_trip_hazards', 'grab_bars', 'edu_fall_prevention'],
    eachVisit: ['Clear walkways', 'Supervised walk if steady', 'Shoes on and walking aid within reach'],
    callGfcWhen: ['Any fall, even without injury', 'New dizziness when standing up'],
    call911When: ['Fall with injury or cannot get up', 'Hit head in a fall']
  },
  {
    key: 'diabetes', label: 'Type 2 diabetes',
    source: 'ADA Standards of Care in Diabetes, Older Adults section (A1C goals individualized by health status; hypoglycemia below 70 mg/dL)',
    problem: { text: 'Type 2 diabetes', prognosis: 'Stable with adherence', expectedOutcome: 'Readings stay within the target range' },
    goals: [
      { statement: 'Keep blood sugar in a safe range', measure: 'A1C', target: 'Individualized: under 7.0-7.5% if healthy, under 8.0% if complex health', priority: 'high' },
      { statement: 'No low blood sugar episodes', measure: 'Readings under 70 mg/dL per month', target: '0', priority: 'high' }
    ],
    interventions: ['glucose_check', 'med_review', 'foot_check', 'edu_diabetes', 'edu_hypoglycemia', 'ref_eye_exam', 'ref_podiatry'],
    eachVisit: ['Offer meals and snacks on schedule', 'Confirm medications taken', 'Check feet for sores'],
    callGfcWhen: ['Blood sugar under 70 mg/dL', 'A sore on the foot that is not healing', 'Not eating or drinking'],
    call911When: ['Confused, very drowsy or cannot be woken', 'Blood sugar under 70 and cannot eat or drink']
  },
  {
    key: 'copd', label: 'COPD',
    source: 'GOLD (Global Initiative for Chronic Obstructive Lung Disease) report',
    problem: { text: 'COPD', prognosis: 'Guarded', expectedOutcome: 'Symptoms managed at home' },
    goals: [
      { statement: 'Breathe easier day to day', measure: 'Oxygen saturation', target: 'The target the prescriber set', priority: 'high' },
      { statement: 'Avoid flare-ups needing the hospital', measure: 'Flare-ups this period', target: '0', priority: 'medium' }
    ],
    interventions: ['inhaler_technique', 'oxygen_sat', 'copd_action_plan', 'ref_pulm_rehab', 'oxygen_safety', 'edu_breathing'],
    eachVisit: ['Check oxygen tubing and supply', 'Encourage rest breaks', 'No smoking or open flame near oxygen'],
    callGfcWhen: ['More cough, mucus or breathlessness than usual', 'Needing the rescue inhaler more often'],
    call911When: ['Lips or fingertips turning blue', 'Cannot catch breath at rest']
  },
  {
    key: 'hypertension', label: 'High blood pressure',
    source: '2025 AHA/ACC high blood pressure guideline (goal under 130/80, individualized for frailty)',
    problem: { text: 'Hypertension', prognosis: 'Good', expectedOutcome: 'Readings stay within the target range' },
    goals: [
      { statement: 'Keep blood pressure in range', measure: 'Blood pressure', target: 'Under 130/80, or the individualized goal', priority: 'high' }
    ],
    interventions: ['bp_check', 'med_review', 'edu_home_bp', 'edu_low_sodium', 'orthostatic_bp'],
    eachVisit: ['Confirm medications taken'],
    callGfcWhen: ['Blood pressure 180/120 or higher', 'Dizzy or lightheaded when standing'],
    call911When: ['Chest pain', 'Sudden weakness, face drooping or trouble speaking']
  },
  {
    key: 'dementia', label: 'Dementia / memory loss',
    source: "Alzheimer's Association Dementia Care Practice Recommendations; CMS GUIDE dementia care model",
    problem: { text: 'Dementia', prognosis: 'Progressive; focus on comfort and function', expectedOutcome: 'Remains safely at home' },
    goals: [
      { statement: 'Stay safe and settled at home', measure: 'Wandering or distress episodes', target: 'Fewer each month', priority: 'high' },
      { statement: 'Family feels supported', measure: 'Family confidence with care', target: 'Confident', priority: 'medium' }
    ],
    interventions: ['cognition_check', 'routine_structure', 'home_safety_eval', 'edu_family_dementia', 'caregiver_support', 'advance_care_planning'],
    eachVisit: ['Keep a consistent routine', 'Gentle redirection when upset', 'Check doors and stove are safe'],
    callGfcWhen: ['New or sudden worse confusion', 'Not eating or drinking', 'Wandering out of the home'],
    call911When: ['Missing and cannot be found', 'Sudden change in alertness']
  }
]);

// The form's starting values for a new plan (smart defaults). Review every
// 90 days from today; effective today.
const addDays = (isoDay, n) => {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const newPlanDefaults = (todayIso) => ({
  effectiveDate: todayIso,
  review: { cadence: '90_days', nextReviewDate: addDays(todayIso, 90) }
});
const REVIEW_CADENCE_DAYS = Object.freeze({ '30_days': 30, '60_days': 60, '90_days': 90, '6_months': 182, '12_months': 365 });

// What the form receives.
const catalog = () => ({
  interventions: INTERVENTIONS,
  prognosisOptions: PROGNOSIS_OPTIONS,
  expectedOutcomeOptions: EXPECTED_OUTCOME_OPTIONS,
  omahaCategories: Object.values(OMAHA),
  pathways: PATHWAYS.map(p => ({
    ...p,
    // Resolved so the page never looks up a code itself.
    interventions: p.interventions.map(code => interventionByCode.get(code)).filter(Boolean)
  })),
  reviewCadenceDays: REVIEW_CADENCE_DAYS
});

module.exports = {
  OMAHA, INTERVENTIONS, CUSTOM_INTERVENTION, interventionByCode, PROGNOSIS_OPTIONS, EXPECTED_OUTCOME_OPTIONS,
  PATHWAYS, REVIEW_CADENCE_DAYS, newPlanDefaults, addDays, catalog
};
