#!/usr/bin/env node
/**
 * Database Inspector Tool
 * Quick tool for inspecting Replit Database contents
 *
 * Usage:
 *   node debug-db.js                    # List all keys
 *   node debug-db.js users              # Inspect users collection
 *   node debug-db.js service_reports    # Inspect service reports
 *   node debug-db.js --search email@example.com  # Search for value
 */

const Database = require('@replit/database');
const db = new Database();

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function colorize(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

async function listAllKeys() {
  console.log(colorize('cyan', '\n=== Available Database Keys ===\n'));
  const keys = await db.list();

  if (keys.length === 0) {
    console.log(colorize('yellow', 'No keys found in database'));
    return;
  }

  for (const key of keys) {
    const data = await db.get(key);
    const type = Array.isArray(data) ? 'Array' : typeof data;
    const length = Array.isArray(data) ? `(${data.length} items)` : '';
    console.log(`  ${colorize('green', '●')} ${colorize('bright', key)} ${colorize('dim', `[${type}] ${length}`)}`);
  }

  console.log(colorize('dim', '\nUsage: node debug-db.js <key> to inspect\n'));
}

async function inspectKey(key) {
  console.log(colorize('cyan', `\n=== Inspecting: ${key} ===\n`));
  const data = await db.get(key);

  if (data === null || data === undefined) {
    console.log(colorize('yellow', 'Key not found or empty'));
    return;
  }

  // Display metadata
  const type = Array.isArray(data) ? 'Array' : typeof data;
  console.log(colorize('bright', 'Type:'), type);

  if (Array.isArray(data)) {
    console.log(colorize('bright', 'Length:'), data.length);

    if (data.length === 0) {
      console.log(colorize('yellow', 'Array is empty'));
      return;
    }

    // Show first item structure
    console.log(colorize('bright', '\nFirst Item:'));
    console.log(JSON.stringify(data[0], null, 2));

    if (data.length > 1) {
      console.log(colorize('bright', '\nLast Item:'));
      console.log(JSON.stringify(data[data.length - 1], null, 2));
    }

    // Show summary
    if (data.length > 5) {
      console.log(colorize('dim', `\n... and ${data.length - 2} more items`));
    }

    // Special handling for common collections
    if (key === 'users') {
      console.log(colorize('bright', '\nUser Summary:'));
      const roles = {};
      data.forEach(u => {
        roles[u.role] = (roles[u.role] || 0) + 1;
      });
      Object.entries(roles).forEach(([role, count]) => {
        console.log(`  ${role}: ${count}`);
      });
    }

    if (key === 'service_reports') {
      console.log(colorize('bright', '\nService Report Summary:'));
      const statuses = {};
      const withPhotos = data.filter(r => r.photos && r.photos.length > 0).length;
      data.forEach(r => {
        statuses[r.status] = (statuses[r.status] || 0) + 1;
      });
      console.log(`  Total: ${data.length}`);
      console.log(`  With Photos: ${withPhotos}`);
      console.log(colorize('bright', '  By Status:'));
      Object.entries(statuses).forEach(([status, count]) => {
        console.log(`    ${status}: ${count}`);
      });
    }

    if (key === 'projects') {
      console.log(colorize('bright', '\nProject Summary:'));
      data.forEach(p => {
        console.log(`  ${colorize('green', '●')} ${p.name} (${p.id})`);
      });
    }

  } else if (typeof data === 'object') {
    console.log(colorize('bright', 'Keys:'), Object.keys(data).join(', '));
    console.log(colorize('bright', '\nData:'));
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(colorize('bright', 'Value:'), data);
  }

  console.log(); // Empty line at end
}

async function searchValue(searchTerm) {
  console.log(colorize('cyan', `\n=== Searching for: "${searchTerm}" ===\n`));

  const keys = await db.list();
  let found = false;

  for (const key of keys) {
    const data = await db.get(key);
    const dataStr = JSON.stringify(data);

    if (dataStr.includes(searchTerm)) {
      console.log(colorize('green', `Found in: ${key}`));

      if (Array.isArray(data)) {
        const matches = data.filter(item =>
          JSON.stringify(item).includes(searchTerm)
        );
        console.log(colorize('dim', `  ${matches.length} matching items`));
        matches.slice(0, 3).forEach(item => {
          console.log('  ', JSON.stringify(item, null, 2));
        });
        if (matches.length > 3) {
          console.log(colorize('dim', `  ... and ${matches.length - 3} more`));
        }
      }
      console.log(); // Empty line
      found = true;
    }
  }

  if (!found) {
    console.log(colorize('yellow', 'No matches found'));
  }
}

async function exportData(keys) {
  console.log(colorize('cyan', '\n=== Exporting Data ===\n'));

  const exportData = {};

  for (const key of keys) {
    exportData[key] = await db.get(key);
    console.log(colorize('green', `Exported: ${key}`));
  }

  const filename = `db-export-${Date.now()}.json`;
  const fs = require('fs');
  fs.writeFileSync(filename, JSON.stringify(exportData, null, 2));

  console.log(colorize('bright', `\nData exported to: ${filename}`));
}

async function stats() {
  console.log(colorize('cyan', '\n=== Database Statistics ===\n'));

  const keys = await db.list();
  console.log(colorize('bright', 'Total Keys:'), keys.length);
  console.log();

  for (const key of keys) {
    const data = await db.get(key);
    const type = Array.isArray(data) ? 'Array' : typeof data;
    const size = JSON.stringify(data).length;
    const sizeKB = (size / 1024).toFixed(2);

    let info = '';
    if (Array.isArray(data)) {
      info = `${data.length} items`;
    } else if (typeof data === 'object') {
      info = `${Object.keys(data).length} keys`;
    }

    console.log(`${colorize('bright', key)}`);
    console.log(`  Type: ${type}`);
    console.log(`  Size: ${sizeKB} KB`);
    if (info) console.log(`  Info: ${info}`);
    console.log();
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await listAllKeys();
    return;
  }

  const command = args[0];

  // Commands
  if (command === '--search' || command === '-s') {
    if (args.length < 2) {
      console.log(colorize('red', 'Error: Search term required'));
      console.log('Usage: node debug-db.js --search <term>');
      return;
    }
    await searchValue(args[1]);
  } else if (command === '--export' || command === '-e') {
    const keys = args.slice(1);
    if (keys.length === 0) {
      const allKeys = await db.list();
      await exportData(allKeys);
    } else {
      await exportData(keys);
    }
  } else if (command === '--stats' || command === '-S') {
    await stats();
  } else if (command === '--help' || command === '-h') {
    console.log(colorize('cyan', '\nDatabase Inspector Tool'));
    console.log(colorize('dim', '========================\n'));
    console.log('Usage:');
    console.log('  node debug-db.js                      List all database keys');
    console.log('  node debug-db.js <key>                Inspect a specific key');
    console.log('  node debug-db.js --search <term>      Search for a value');
    console.log('  node debug-db.js --export [keys...]   Export data to JSON file');
    console.log('  node debug-db.js --stats              Show database statistics');
    console.log('  node debug-db.js --help               Show this help\n');
    console.log('Examples:');
    console.log('  node debug-db.js users');
    console.log('  node debug-db.js service_reports');
    console.log('  node debug-db.js --search "admin@example.com"');
    console.log('  node debug-db.js --export users projects');
    console.log();
  } else {
    // Inspect specific keys
    for (const key of args) {
      await inspectKey(key);
    }
  }
}

// Run
main().catch(err => {
  console.error(colorize('red', '\nError:'), err.message);
  console.error(colorize('dim', err.stack));
  process.exit(1);
});
