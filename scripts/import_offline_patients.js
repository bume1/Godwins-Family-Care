#!/usr/bin/env node
// ============================================================
// GODWINS FAMILY CARE — one-shot offline-patient CSV import
// Session 3.3, Scope B3
//
// Bulk-creates client records for the legacy paper-packet patients (source
// = legacy_offline, enrollmentStatus = intake_complete) from a CSV file.
// Does NOT run automatically — Bianca invokes it manually with the CSV in
// place. See scripts/README.md for usage.
//
// Idempotent: dedupes by firstName + lastName + dob (case-insensitive).
// An exact match already on file is skipped and logged, never duplicated.
//
// USAGE:
//   node scripts/import_offline_patients.js [path/to/file.csv]
//   (default path: scripts/offline_patients.csv)
//
// TEST DATA ONLY until HIPAA-live.
// ============================================================

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Database = require('@replit/database');
const config = require('../config');

const db = new Database();
const LOG_PATH = path.join(__dirname, 'import_offline_patients.log');

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// Minimal RFC-4180-ish CSV parser — handles quoted fields with embedded
// commas/newlines/escaped quotes. No external dependency required.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(c => (c || '').trim() !== '')).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

const CARE_TIER_VALUES = ['A1', 'A2', 'A3', 'A4', 'B'];
const normalizeCareTier = (v) => {
  const code = String(v || '').toUpperCase();
  return CARE_TIER_VALUES.includes(code) ? code : null;
};

const deriveAge = (dob) => {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
};

function rowToClient(row, users) {
  const serviceLine = (row.serviceLine || 'PHC').toUpperCase();
  const careTier = normalizeCareTier(row.careTier);
  const nowIso = new Date().toISOString();
  const clientId = uuidv4();

  let medications = [];
  if (row.medicationsJson) {
    try { medications = JSON.parse(row.medicationsJson); if (!Array.isArray(medications)) medications = []; }
    catch { medications = []; }
  }

  const signedOfflineKeys = (row.consentsSignedOffline || '').split('|').map(s => s.trim()).filter(Boolean);
  const pendingKeys = (row.consentsPending || '').split('|').map(s => s.trim()).filter(Boolean);
  const consents = {};
  const consentMeta = {};
  signedOfflineKeys.forEach(type => {
    consents[type] = 'signed_offline';
    consentMeta[type] = { signedAt: nowIso, provenance: 'signed_offline', recordedBy: 'import_offline_patients.js', recordedAt: nowIso };
  });
  pendingKeys.forEach(type => { if (!consents[type]) consents[type] = 'pending'; });

  const email = `offline+${clientId}@placeholder.local`;
  const name = `${row.firstName} ${row.lastName}`.trim();

  return {
    id: clientId,
    email,
    name,
    password: null, // filled by caller (async bcrypt hash)
    role: config.ROLES.CLIENT,
    source: 'legacy_offline',
    enrollmentStatus: 'intake_complete',
    serviceLine,
    careTier,
    dob: row.dob,
    phone: row.phone || '',
    medications,
    payer: {
      insuranceCarrier: row.insuranceCarrier || '',
      insuranceMemberId: row.insuranceMemberId || '',
      insuranceGroup: row.insuranceGroup || ''
    },
    consents,
    consentMeta,
    offlinePacketDriveUrls: row.driveFolderUrl ? [row.driveFolderUrl] : [],
    careTeam: { assignedFNPs: [], assignedCaseManager: null, primaryCaregiver: null, backupCaregiver: null },
    intake: {
      firstName: row.firstName, lastName: row.lastName,
      dob: row.dob, age: deriveAge(row.dob), gender: row.gender || '',
      address: { line1: row.addressLine1 || '', city: row.city || '', state: row.state || 'GA', zip: row.zip || '' },
      phone: row.phone || '', primaryLanguage: row.primaryLanguage || '', livesWith: row.livesWith || '',
      serviceLine, careTier,
      primaryContact: {
        name: row.primaryContactName || '', relationship: row.primaryContactRelationship || '',
        phone: row.primaryContactPhone || '', email: row.primaryContactEmail || ''
      },
      emergencyContacts: row.emergencyContactName ? [{ name: row.emergencyContactName, phone: row.emergencyContactPhone || '' }] : [],
      allergies: row.allergies || '',
      medications,
      payer: { insuranceCarrier: row.insuranceCarrier || '', insuranceMemberId: row.insuranceMemberId || '', insuranceGroup: row.insuranceGroup || '' },
      submittedAt: nowIso,
      source: 'legacy_offline'
    },
    accountStatus: 'active',
    requirePasswordChange: true,
    hasPortalLogin: false,
    createdAt: nowIso
  };
}

const dedupeKey = (firstName, lastName, dob) =>
  `${String(firstName || '').trim().toLowerCase()}|${String(lastName || '').trim().toLowerCase()}|${String(dob || '').trim()}`;

async function main() {
  const csvPath = process.argv[2] || path.join(__dirname, 'offline_patients.csv');
  if (!fs.existsSync(csvPath)) {
    logLine(`ERROR: CSV not found at ${csvPath}. Copy scripts/offline_patients.sample.csv to scripts/offline_patients.csv and fill it in, or pass a path.`);
    process.exit(1);
  }

  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (!rows.length) { logLine('CSV has no data rows. Nothing to do.'); process.exit(0); }

  const users = (await db.get('users')) || [];
  const existingKeys = new Set(
    users.filter(u => u.role === config.ROLES.CLIENT)
      .map(u => dedupeKey(u.intake && u.intake.firstName || (u.name || '').split(' ')[0], u.intake && u.intake.lastName || (u.name || '').split(' ').slice(1).join(' '), u.dob))
  );

  let created = 0, skipped = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // header is row 1
    try {
      if (!row.firstName || !row.lastName || !row.dob) {
        logLine(`row ${rowNum}: SKIPPED — missing firstName/lastName/dob`);
        failed++; continue;
      }
      const key = dedupeKey(row.firstName, row.lastName, row.dob);
      if (existingKeys.has(key)) {
        logLine(`row ${rowNum}: SKIPPED — exact match already on file (${row.firstName} ${row.lastName}, ${row.dob})`);
        skipped++; continue;
      }

      const client = rowToClient(row, users);
      const randomPw = uuidv4() + uuidv4();
      client.password = await bcrypt.hash(randomPw, config.BCRYPT_SALT_ROUNDS);

      users.push(client);
      existingKeys.add(key);
      created++;
      logLine(`row ${rowNum}: CREATED client ${client.id} (${client.name})`);
    } catch (e) {
      failed++;
      logLine(`row ${rowNum}: FAILED — ${e.message}`);
    }
  }

  if (created > 0) {
    await db.set('users', users);
    logLine(`Wrote ${created} new client record(s) to the users store.`);
  }
  logLine(`Done. created=${created} skipped(existing)=${skipped} failed=${failed}`);
  process.exit(0);
}

main().catch(e => { logLine(`FATAL: ${e.message}`); process.exit(1); });
