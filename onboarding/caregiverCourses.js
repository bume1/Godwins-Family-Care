// ============================================================================
// CAREGIVER TRAINING COURSES — Care Courses (care-courses.com), owner 2026-11-09
// ============================================================================
// Two collections GFC uses for Rule 111-8-65-.09 training:
//   * PCA_40   the 40-hour initial PCA program: 36 courses, 40 hours. Twenty
//              hours before serving any client, the rest within six months of
//              the start of training (Playbook A.6).
//   * ANNUAL_8 the 8-hour annual training: 7 courses, renewed every year
//              after the first (Playbook A.10).
//
// Care Courses has no direct link to a single course, so every course links
// the COLLECTION page. Each completed course is proven by its certificate of
// completion, uploaded per course. Course titles and hours are copied from the
// collection pages as printed on 2026-11-08; a course list that changes there
// is updated here by hand, never guessed.
// ============================================================================

'use strict';

const c = (id, title, hours) => Object.freeze({ id, title, hours });

const HIPAA_URL = 'https://www.care-courses.com/company/qj5dz/module-detail';
const DEMENTIA_URL = 'https://www.care-courses.com/company/q38w4/module-detail';

const COLLECTIONS = Object.freeze({
  // Owner, 2026-11-09: two GFC-assigned modules every caregiver takes, each
  // with its own Care Courses link (these two do have direct links). Hours
  // are not published on the module pages, so none are claimed.
  GFC_CORE: Object.freeze({
    id: 'GFC_CORE',
    title: 'GFC Required Modules',
    url: null,
    totalHours: null,
    cycle: 'initial',
    courses: Object.freeze([
      Object.freeze({ id: 'CORE-HIPAA', title: 'HIPAA and Confidentiality', hours: null, url: HIPAA_URL }),
      Object.freeze({ id: 'CORE-DEMENTIA', title: 'Introduction to Dementia Care', hours: null, url: DEMENTIA_URL })
    ])
  }),
  PCA_40: Object.freeze({
    id: 'PCA_40',
    title: 'Georgia Personal Care Assistant: 40-Hour Initial Training',
    url: 'https://www.care-courses.com/collections/georgia-personal-care-assistant-40-hours-initial-training',
    totalHours: 40,
    beforeClientHours: 20,
    withinMonths: 6,
    cycle: 'initial',
    courses: Object.freeze([
      c('PCA-01', 'The Role and Functions of Personal Care Staff', 1),
      c('PCA-02', "Patients' Rights", 1),
      c('PCA-03', 'Physical, Emotional, and Developmental Characteristics of the Populations Served by the Agency', 1),
      c('PCA-04', 'Communication', 1.5),
      c('PCA-05', 'Confidentiality', 1),
      c('PCA-06', 'Observation, Reporting, and Documentation', 1),
      c('PCA-07', 'Basic Elements of Body Functions that Must be Reported to the Registered Nurse Supervisor', 1),
      c('PCA-08', 'Incident Reporting', 1),
      c('PCA-09', 'Responding to and Reporting Elder Abuse', 1),
      c('PCA-10', 'Ambulation and Transfers', 1),
      c('PCA-11', 'Normal Range of Motion and Positioning', 1),
      c('PCA-12', 'Assisting with ADLs', 1.5),
      c('PCA-13', 'Assisting with ADLs (Part 2)', 2),
      c('PCA-14', 'Assisting with iADLs', 1),
      c('PCA-15', 'Assisting with Medication Self-Administration (Part 2)', 1),
      c('PCA-16', 'Basic First Aid', 1),
      c('PCA-17', 'Care of the Person Confined to Bed', 1),
      c('PCA-18', 'Caring for Patients with Arthritis', 1),
      c('PCA-19', 'Caring for Clients with Diabetes Mellitus', 1),
      c('PCA-20', 'An Overview of Mental Illness Care', 1),
      c('PCA-21', 'An Overview of HIV/AIDS', 1),
      c('PCA-22', 'Intellectual Developmental Disabilities', 1),
      c('PCA-23', 'Pain Management', 1.5),
      c('PCA-24', 'Home Management', 1),
      c('PCA-25', 'Basic Housekeeping', 1),
      c('PCA-26', 'Control of Contagious and Infectious Diseases', 1.5),
      c('PCA-27', 'Emergency Response Measures', 1.5),
      c('PCA-28', 'Falls Prevention', 1),
      c('PCA-29', 'Measuring Vital Signs', 1),
      c('PCA-30', 'Nutrition and Hydration', 1),
      c('PCA-31', 'Meal Preparation for Clients', 1),
      c('PCA-32', 'Feeding Patients with Swallowing Difficulties', 1),
      c('PCA-33', 'Introduction to Dementia Care', 1),
      c('PCA-34', 'Psychological, Social, and Physical Needs of People with Dementia', 1.5),
      c('PCA-35', "Reducing Safety Risks for Clients with Alzheimer's Disease", 1),
      c('PCA-36', 'Managing Challenging Behaviors in Dementia', 1)
    ])
  }),
  ANNUAL_8: Object.freeze({
    id: 'ANNUAL_8',
    title: 'Georgia Personal Care Assistant: Annual Training (8 hours)',
    url: 'https://www.care-courses.com/collections/georgia-personal-care-assistant-annual-training',
    totalHours: 8,
    cycle: 'yearly',
    courses: Object.freeze([
      c('ANN-01', "Patients' Rights", 1),
      c('ANN-02', 'Communication', 1.5),
      c('ANN-03', 'Basic Elements of Body Functions that Must be Reported to the Registered Nurse Supervisor', 1),
      c('ANN-04', 'Incident Reporting', 1),
      c('ANN-05', 'Control of Contagious and Infectious Diseases', 1.5),
      c('ANN-06', 'Responding to and Reporting Elder Abuse', 1),
      c('ANN-07', 'Gentle Approach to Dementia Care', 1)
    ])
  })
});

const findCourse = (collectionId, courseId) => {
  const col = COLLECTIONS[collectionId];
  return col ? col.courses.find(x => x.id === courseId) || null : null;
};

/** The cycle a certificate belongs to: 'initial', or the calendar year. */
function cycleFor(collectionId, onDate) {
  const col = COLLECTIONS[collectionId];
  if (!col) return null;
  return col.cycle === 'yearly' ? String(onDate || '').slice(0, 4) : 'initial';
}

/**
 * Progress through one collection in one cycle. `certs` is
 * record.courseCerts[collectionId][cycle] = { [courseId]: { files, at } }.
 * A course counts once a certificate is on file and not returned.
 */
function progress(collectionId, certs, cycle) {
  const col = COLLECTIONS[collectionId];
  const got = certs || {};
  const list = col.courses.map(x => {
    const r = got[x.id] || null;
    const done = !!(r && (r.files || []).length && !r.returned);
    return {
      id: x.id, title: x.title, hours: x.hours, url: x.url || null, done,
      at: done ? r.at : null,
      returned: r && r.returned ? r.returned : null,
      files: r ? (r.files || []).map(f => ({ id: f.id, name: f.name, uploadedAt: f.uploadedAt, filedBy: f.filedBy })) : []
    };
  });
  const hoursDone = Math.round(list.filter(x => x.done).reduce((s, x) => s + (x.hours || 0), 0) * 10) / 10;
  const lastAt = list.filter(x => x.done).map(x => x.at).sort().pop() || null;
  return {
    id: col.id, title: col.title, url: col.url, cycle,
    totalHours: col.totalHours, beforeClientHours: col.beforeClientHours || null, withinMonths: col.withinMonths || null,
    hoursDone, coursesDone: list.filter(x => x.done).length, coursesTotal: list.length,
    complete: list.every(x => x.done), completedOn: list.every(x => x.done) ? String(lastAt || '').slice(0, 10) : null,
    readyForClients: col.beforeClientHours ? hoursDone >= col.beforeClientHours : null,
    courses: list
  };
}

module.exports = { COLLECTIONS, HIPAA_URL, DEMENTIA_URL, findCourse, cycleFor, progress };
