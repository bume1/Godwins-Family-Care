// ============================================================
// config.js - Centralized Configuration (Single Source of Truth)
// ============================================================
// All configuration values are defined HERE and only here.
// Every module reads from this file. To change any setting,
// update it once here and it propagates everywhere.
//
// Priority: Environment Variable > DB Setting > Default Value
// ============================================================

// ---- Security & Auth ----
const JWT_SECRET = process.env.JWT_SECRET || 'thrive365-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const MIN_PASSWORD_LENGTH = parseInt(process.env.MIN_PASSWORD_LENGTH || '8', 10);
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)/; // uppercase + lowercase + number

// ---- Server ----
const PORT = parseInt(process.env.PORT || '3000', 10);
const BODY_PARSER_LIMIT = process.env.BODY_PARSER_LIMIT || '50mb';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(10 * 1024 * 1024), 10); // 10MB
const MAX_CONCURRENT_UPLOADS = parseInt(process.env.MAX_CONCURRENT_UPLOADS || '5', 10);

// ---- Cache & Performance ----
const USERS_CACHE_TTL = parseInt(process.env.USERS_CACHE_TTL || '5000', 10); // ms
const PROJECT_SLUG_CACHE_TTL = parseInt(process.env.PROJECT_SLUG_CACHE_TTL || '30000', 10); // ms

// ---- Business Logic ----
const ACTIVITY_LOG_MAX_ENTRIES = parseInt(process.env.ACTIVITY_LOG_MAX_ENTRIES || '500', 10);
const SERVICE_REPORT_EDIT_WINDOW_MINUTES = parseInt(process.env.SERVICE_REPORT_EDIT_WINDOW_MINUTES || '30', 10);
const INVENTORY_EXPIRY_WARNING_DAYS = parseInt(process.env.INVENTORY_EXPIRY_WARNING_DAYS || '30', 10);

// ---- HubSpot Integration ----
const HUBSPOT_POLL_INTERVAL_SECONDS = parseInt(process.env.HUBSPOT_POLL_INTERVAL_SECONDS || '60', 10);
const HUBSPOT_POLL_MIN_SECONDS = parseInt(process.env.HUBSPOT_POLL_MIN_SECONDS || '30', 10);
const HUBSPOT_POLL_MAX_SECONDS = parseInt(process.env.HUBSPOT_POLL_MAX_SECONDS || '3600', 10);
const HUBSPOT_TARGET_STAGES = (process.env.HUBSPOT_TARGET_STAGES || 'assigned,vendor escalation').split(',').map(s => s.trim());
const HUBSPOT_STAGE_CACHE_TTL = parseInt(process.env.HUBSPOT_STAGE_CACHE_TTL || '3600000', 10); // 1 hour

// ---- Service Type Mapping (HubSpot category → display name) ----
const SERVICE_TYPE_MAP = {
  'inventory': 'Inventory',
  'inspection': 'Service Inspection',
  'analyzer hardware': 'Analyzer Hardware',
  'analyzer software': 'Analyzer Software',
  'lis': 'LIS/EMR',
  'lis/emr': 'LIS/EMR',
  'emr': 'LIS/EMR',
  'billing & fees': 'Billing & Fees',
  'billing': 'Billing & Fees',
  'compliance': 'Compliance',
  'training': 'Training',
  'validations': 'Validations',
  'validation': 'Validations',
  'other': 'Other'
};

// ---- Roles & Permissions ----
const ROLES = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
  CLIENT: 'client',
  VENDOR: 'vendor'
});
const ALL_ROLES = Object.freeze([ROLES.ADMIN, ROLES.USER, ROLES.CLIENT, ROLES.VENDOR]);

// ---- Project & Task Statuses ----
const PROJECT_STATUSES = Object.freeze(['active', 'paused', 'completed']);
const SUBTASK_STATUSES = Object.freeze(['Pending', 'Complete', 'N/A']);
const SERVICE_REPORT_STATUSES = Object.freeze(['assigned', 'in_progress', 'validation_in_progress', 'signature_needed', 'submitted']);

// ---- Phases ----
const STANDARD_PHASES = Object.freeze({
  'Phase 1': { name: 'Phase 1: Contract & Initial Setup', stages: ['Tasks'] },
  'Phase 2': { name: 'Phase 2: Financials, CLIA & Hiring', stages: ['Tasks'] },
  'Phase 3': { name: 'Phase 3: Tech Infrastructure & LIS Integration', stages: ['Tasks'] },
  'Phase 4': { name: 'Phase 4: Inventory Forecasting & Procurement', stages: ['Tasks'] },
  'Phase 5': { name: 'Phase 5: Supply Orders & Logistics', stages: ['Tasks'] },
  'Phase 6': { name: 'Phase 6: Onboarding & Welcome Calls', stages: ['Tasks'] },
  'Phase 7': { name: 'Phase 7: Virtual Soft Pilot & Prep', stages: ['Tasks'] },
  'Phase 8': { name: 'Phase 8: Training & Full Validation', stages: ['Tasks'] },
  'Phase 9': { name: 'Phase 9: Go-Live', stages: ['Tasks'] },
  'Phase 10': { name: 'Phase 10: Post-Launch Support & Optimization', stages: ['Tasks'] }
});
const PHASE_ORDER = Object.freeze(['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'Phase 6', 'Phase 7', 'Phase 8', 'Phase 9', 'Phase 10']);

// ---- Legacy Stage-to-Phase Migration Map ----
// Maps old stage names (pre-phase system) to current phase keys
const LEGACY_STAGE_TO_PHASE = Object.freeze({
  'contract & initial setup': 'Phase 1',
  'billing, clia & hiring': 'Phase 2',
  'tech infrastructure & lis integration': 'Phase 3',
  'tech infrastructure': 'Phase 3',
  'inventory forecasting & procurement': 'Phase 4',
  'inventory forecasting': 'Phase 4',
  'supply orders & logistics': 'Phase 5',
  'supply orders': 'Phase 5',
  'onboarding & welcome calls': 'Phase 6',
  'onboarding': 'Phase 6',
  'virtual soft pilot & prep': 'Phase 7',
  'virtual soft pilot': 'Phase 7',
  'soft pilot': 'Phase 7',
  'training & full validation': 'Phase 8',
  'training & validation': 'Phase 8',
  'training/validation': 'Phase 8',
  'go-live': 'Phase 9',
  'go live': 'Phase 9',
  'golive': 'Phase 9',
  'post-launch support & optimization': 'Phase 10',
  'post-launch': 'Phase 10',
  'post launch': 'Phase 10'
});

// ---- Brand / Display ----
const BRAND = Object.freeze({
  COMPANY_NAME: process.env.BRAND_COMPANY_NAME || 'Thrive 365 Labs',
  PRIMARY_COLOR: process.env.BRAND_PRIMARY_COLOR || '#045E9F',
  ACCENT_COLOR: process.env.BRAND_ACCENT_COLOR || '#00205A',
  FONT_FAMILY: process.env.BRAND_FONT_FAMILY || 'Inter',
  SUCCESS_COLOR: '#10B981',
  WARNING_COLOR: '#F59E0B',
  DANGER_COLOR: '#EF4444'
});

// ---- Default Inventory Items ----
const DEFAULT_INVENTORY_ITEMS = Object.freeze([
  { category: 'Ancillary Supplies', items: ['Acid Wash Solution', 'Alkaline Wash Solution'] },
  { category: 'Calibrators', items: ['BHB - L1 - Cal', 'Creatinine - L1', 'Creatinine - L2', 'Glucose - L1', 'Hemo - L1', 'HS Nitrite - L1 - Cal', 'HS Nitrite - L2 - Cal', 'HS Nitrite - L3 - Cal', 'Leukocyte Esterase - L1 - Cal', 'Leukocyte Esterase - L2 - Cal', 'Leukocyte Esterase - L3 - Cal', 'Microalbumin - L1', 'Microalbumin - L2', 'Microalbumin - L3', 'Microalbumin - L4', 'Microalbumin - L5', 'Microalbumin - L6', 'Microprotein - L1', 'pH - L1', 'pH - L2', 'SG - L1', 'SG - L2', 'Urobilinogen - L1', 'Urobilinogen - L2', 'Urobilinogen - L3', 'Urobilinogen - L4', 'Urobilinogen - L5'] },
  { category: 'Controls', items: ['A-Level - L4', 'A-Level - L5', 'A-Level - L6', 'BHB - L1', 'BHB - L2', 'Bilirubin Stock 30', 'Bilirubin Zero', 'Biorad - L1', 'Biorad - L2', 'Hemoglobin 500 - L1', 'Hemoglobin 5000 - L2', 'HS Nitrite - L1', 'HS Nitrite - L2', 'Leukocyte Esterase - L1', 'Leukocyte Esterase - L2', 'Leukocyte Esterase - L3', 'Urobilinogen - Control 1', 'Urobilinogen - Control 2'] },
  { category: 'Reagent', items: ['BHB - R1', 'BHB - R2', 'Bilirubin - R1', 'Bilirubin - R2', 'Creatinine - R1', 'Creatinine - R2', 'Glucose - R1', 'Hemoglobin - R1', 'HS Nitrite - R1', 'HS Nitrite - R2', 'Leukocyte Esterase - R1', 'Leukocyte Esterase - R2', 'Microalbumin - R1', 'Microalbumin - R2', 'Microprotein - R1', 'pH - R1', 'SG - R1', 'Urobilinogen - R1', 'Urobilinogen - R2'] }
]);

// ---- Cache Headers ----
const NO_CACHE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Surrogate-Control': 'no-store'
});

// ---- Notification Queue (Feature 1) ----
const NOTIFICATION_CHECK_INTERVAL_MINUTES = parseInt(process.env.NOTIFICATION_CHECK_INTERVAL_MINUTES || '15', 10);
const NOTIFICATION_LOG_MAX_ENTRIES = parseInt(process.env.NOTIFICATION_LOG_MAX_ENTRIES || '2000', 10);
const NOTIFICATION_MAX_RETRIES = parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10);
const NOTIFICATION_DAILY_SEND_LIMIT = parseInt(process.env.NOTIFICATION_DAILY_SEND_LIMIT || '500', 10);
const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'no-reply@thrive365labs.live';

// ---- Automated Reminders (Feature 2) ----
const NOTIFICATION_SCAN_INTERVAL_MINUTES = parseInt(process.env.NOTIFICATION_SCAN_INTERVAL_MINUTES || '30', 10);
const TASK_DEADLINE_DAYS_BEFORE = (process.env.TASK_DEADLINE_DAYS_BEFORE || '1,3,7').split(',').map(Number);
const TASK_OVERDUE_ESCALATION_DAYS = parseInt(process.env.TASK_OVERDUE_ESCALATION_DAYS || '7', 10);
const INVENTORY_REMINDER_DAYS = parseInt(process.env.INVENTORY_REMINDER_DAYS || '7', 10);
const SERVICE_REPORT_FOLLOWUP_DAYS = parseInt(process.env.SERVICE_REPORT_FOLLOWUP_DAYS || '3', 10);
const MILESTONE_THRESHOLDS = (process.env.MILESTONE_THRESHOLDS || '25,50,75,100').split(',').map(Number);
const GOLIVE_REMINDER_DAYS_BEFORE = (process.env.GOLIVE_REMINDER_DAYS_BEFORE || '7,14,30').split(',').map(Number);
// Cooldown window (hours) per notification type.
// After a notification of a given type is sent to a recipient for the same entity,
// no further notification of that type will be queued until this window has elapsed.
// This prevents repeat-send storms when the queue drains and the scanner re-runs.
const NOTIFICATION_COOLDOWN_HOURS = Object.freeze({
  task_deadline:              20,   // at most once per day per task
  task_overdue:               20,   // at most once per day per task
  task_overdue_escalation:    20,   // at most once per day per task (admin escalation)
  inventory_reminder:         144,  // at most once per 6 days per client
  service_report_signature:   20,   // at most once per day per report
  service_report_review:      20,   // at most once per day per report
  golive_reminder:            20,   // at most once per day per project
  milestone_reached:          9999  // effectively one-time (also guarded by lastMilestoneNotified)
});

// ---- Default Admin (initial setup only) ----
const DEFAULT_ADMIN = Object.freeze({
  EMAIL: process.env.DEFAULT_ADMIN_EMAIL || 'bianca@thrive365labs.live',
  NAME: process.env.DEFAULT_ADMIN_NAME || 'Bianca Ume',
  PASSWORD: process.env.DEFAULT_ADMIN_PASSWORD || 'Thrive2025!'
});

// ---- API endpoint for frontend config ----
// Returns non-sensitive config values that frontend portals need
function getPublicConfig() {
  return {
    brand: { ...BRAND },
    phases: STANDARD_PHASES,
    phaseOrder: PHASE_ORDER,
    projectStatuses: PROJECT_STATUSES,
    subtaskStatuses: SUBTASK_STATUSES,
    roles: ALL_ROLES,
    serviceTypes: Object.values(SERVICE_TYPE_MAP).filter((v, i, a) => a.indexOf(v) === i),
    inventoryExpiryWarningDays: INVENTORY_EXPIRY_WARNING_DAYS
  };
}

module.exports = {
  // Security
  JWT_SECRET,
  JWT_EXPIRY,
  BCRYPT_SALT_ROUNDS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_REGEX,
  // Server
  PORT,
  BODY_PARSER_LIMIT,
  MAX_FILE_SIZE,
  MAX_CONCURRENT_UPLOADS,
  // Cache
  USERS_CACHE_TTL,
  PROJECT_SLUG_CACHE_TTL,
  // Business logic
  ACTIVITY_LOG_MAX_ENTRIES,
  SERVICE_REPORT_EDIT_WINDOW_MINUTES,
  INVENTORY_EXPIRY_WARNING_DAYS,
  // HubSpot
  HUBSPOT_POLL_INTERVAL_SECONDS,
  HUBSPOT_POLL_MIN_SECONDS,
  HUBSPOT_POLL_MAX_SECONDS,
  HUBSPOT_TARGET_STAGES,
  HUBSPOT_STAGE_CACHE_TTL,
  SERVICE_TYPE_MAP,
  // Roles
  ROLES,
  ALL_ROLES,
  // Statuses
  PROJECT_STATUSES,
  SUBTASK_STATUSES,
  SERVICE_REPORT_STATUSES,
  // Phases
  STANDARD_PHASES,
  PHASE_ORDER,
  LEGACY_STAGE_TO_PHASE,
  // Brand
  BRAND,
  // Inventory
  DEFAULT_INVENTORY_ITEMS,
  // Headers
  NO_CACHE_HEADERS,
  // Admin
  DEFAULT_ADMIN,
  // Notification Queue (Feature 1)
  NOTIFICATION_CHECK_INTERVAL_MINUTES,
  NOTIFICATION_LOG_MAX_ENTRIES,
  NOTIFICATION_MAX_RETRIES,
  NOTIFICATION_DAILY_SEND_LIMIT,
  EMAIL_FROM_ADDRESS,
  // Automated Reminders (Feature 2)
  NOTIFICATION_SCAN_INTERVAL_MINUTES,
  TASK_DEADLINE_DAYS_BEFORE,
  TASK_OVERDUE_ESCALATION_DAYS,
  INVENTORY_REMINDER_DAYS,
  SERVICE_REPORT_FOLLOWUP_DAYS,
  MILESTONE_THRESHOLDS,
  GOLIVE_REMINDER_DAYS_BEFORE,
  NOTIFICATION_COOLDOWN_HOURS,
  // Public config
  getPublicConfig
};
