/**
 * Changelog Generator
 * Automatically generates changelog from git commits
 *
 * Commit message conventions:
 * - feat: or feature: for new features
 * - fix: or bugfix: for bug fixes
 * - refactor: for code refactoring
 * - ui: or style: for UI/styling changes
 * - docs: for documentation changes
 * - perf: for performance improvements
 *
 * Version tagging:
 * - Commits with "v1.2.3" pattern in message are treated as version releases
 * - Or use git tags for versions
 */

const { execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// Category definitions
const CATEGORIES = {
  feat: { label: 'New Features', color: 'primary', priority: 1 },
  feature: { label: 'New Features', color: 'primary', priority: 1 },
  fix: { label: 'Bug Fixes', color: 'success', priority: 2 },
  bugfix: { label: 'Bug Fixes', color: 'success', priority: 2 },
  ui: { label: 'UI Improvements', color: 'purple', priority: 3 },
  style: { label: 'UI Improvements', color: 'purple', priority: 3 },
  refactor: { label: 'Improvements', color: 'blue', priority: 4 },
  perf: { label: 'Performance', color: 'orange', priority: 5 },
  docs: { label: 'Documentation', color: 'gray', priority: 6 }
};

// Parse a single commit message
function parseCommitMessage(message) {
  // Check for conventional commit format: type(scope): description
  const conventionalMatch = message.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);

  if (conventionalMatch) {
    const [, type, scope, description] = conventionalMatch;
    const category = CATEGORIES[type.toLowerCase()];

    if (category) {
      return {
        type: type.toLowerCase(),
        scope: scope || null,
        description: description.trim(),
        category: category.label,
        color: category.color,
        priority: category.priority
      };
    }
  }

  // Fallback: Check for keywords anywhere in message
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('add ') || lowerMessage.includes('new ') || lowerMessage.includes('implement')) {
    return {
      type: 'feat',
      scope: null,
      description: message.trim(),
      category: 'New Features',
      color: 'primary',
      priority: 1
    };
  }

  if (lowerMessage.includes('fix ') || lowerMessage.includes('fixed ') || lowerMessage.includes('resolve')) {
    return {
      type: 'fix',
      scope: null,
      description: message.trim(),
      category: 'Bug Fixes',
      color: 'success',
      priority: 2
    };
  }

  if (lowerMessage.includes('update ') || lowerMessage.includes('improve') || lowerMessage.includes('enhance')) {
    return {
      type: 'refactor',
      scope: null,
      description: message.trim(),
      category: 'Improvements',
      color: 'blue',
      priority: 4
    };
  }

  // Default: treat as improvement
  return {
    type: 'misc',
    scope: null,
    description: message.trim(),
    category: 'Changes',
    color: 'gray',
    priority: 7
  };
}

// Get commits since last tag or last N commits
function getRecentCommits(since = null, maxCount = 50) {
  try {
    let command = 'git log --pretty=format:"%H|%s|%ai" ';

    if (since) {
      command += `${since}..HEAD `;
    }

    command += `-n ${maxCount}`;

    const output = execSync(command, { encoding: 'utf-8' });

    if (!output.trim()) return [];

    return output.trim().split('\n').map(line => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date: new Date(date) };
    });
  } catch (error) {
    console.error('Error getting commits:', error.message);
    return [];
  }
}

// Get all git tags (versions)
function getVersionTags() {
  try {
    const output = execSync('git tag -l "v*" --sort=-v:refname', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    return [];
  }
}

// Get the latest version tag
function getLatestVersionTag() {
  const tags = getVersionTags();
  return tags.length > 0 ? tags[0] : null;
}

// Commits to exclude from changelog (deployment, generic, noise)
const EXCLUDED_PATTERNS = [
  /^published your app/i,
  /^published\s+app/i,
  /^deploy/i,
  /^deployment/i,
  /^merge (branch|pull request)/i,
  /^initial commit$/i,
  /^wip\b/i,
  /^work in progress/i,
  /^\[skip ci\]/i,
  /^\[ci skip\]/i,
  /^update dependencies$/i,
  /^bump version/i,
  /^release\s+v?\d+\.\d+\.\d+$/i,
  /^version\s+v?\d+\.\d+\.\d+$/i,
  /^revert/i,
  /^formatting$/i,
  /^whitespace$/i,
  /^typo$/i,
  /^test$/i,
  /^testing$/i
];

// Check if commit should be excluded
function shouldExcludeCommit(message) {
  const trimmed = message.trim();

  // Check against exclusion patterns
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Exclude very short commits (likely meaningless)
  if (trimmed.length < 10) {
    return true;
  }

  return false;
}

// Group commits by category
function groupCommitsByCategory(commits) {
  const grouped = {};

  commits.forEach(commit => {
    const parsed = parseCommitMessage(commit.message);

    // Skip merge commits and generic commits
    if (commit.message.toLowerCase().startsWith('merge ')) return;
    if (commit.message.toLowerCase() === 'initial commit') return;

    // Skip excluded patterns (deployment, published app, etc.)
    if (shouldExcludeCommit(commit.message)) return;

    if (!grouped[parsed.category]) {
      grouped[parsed.category] = {
        label: parsed.category,
        color: parsed.color,
        priority: parsed.priority,
        items: []
      };
    }

    grouped[parsed.category].items.push({
      message: parsed.description,
      hash: commit.hash.substring(0, 7),
      date: commit.date
    });
  });

  // Sort by priority
  return Object.values(grouped).sort((a, b) => a.priority - b.priority);
}

// Generate markdown changelog
function generateMarkdownChangelog(version, date, sections) {
  let md = `\n### ${version} - ${date}\n\n`;

  sections.forEach(section => {
    md += `#### ${section.label}\n`;
    section.items.forEach(item => {
      md += `- ${item.message}\n`;
    });
    md += '\n';
  });

  return md;
}

// Update changelog.md file
async function updateChangelogMd(version, date, sections) {
  const changelogPath = path.join(__dirname, 'public', 'changelog.md');

  try {
    let existingContent = await fs.readFile(changelogPath, 'utf-8');

    // Find the position after the header (after "---" separator)
    const headerEndIndex = existingContent.indexOf('---\n', 50);

    if (headerEndIndex !== -1) {
      const header = existingContent.substring(0, headerEndIndex + 4);
      const existingEntries = existingContent.substring(headerEndIndex + 4);

      // Generate new entry
      const newEntry = generateMarkdownChangelog(version, date, sections);

      // Combine: header + new entry + existing entries
      const updatedContent = header + newEntry + existingEntries;

      await fs.writeFile(changelogPath, updatedContent, 'utf-8');
      console.log(`✅ Updated changelog.md with version ${version}`);
      return true;
    }
  } catch (error) {
    console.error('Error updating changelog.md:', error.message);
  }

  return false;
}

// Update README-active.md Version History section
async function updateReadmeVersion(version, date, sections) {
  const readmePath = path.join(__dirname, 'README-active.md');

  try {
    let content = await fs.readFile(readmePath, 'utf-8');

    // Extract version number (remove "Version " prefix if present)
    const versionNum = version.replace(/^Version\s+/i, '');
    const dateStr = date || new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Generate highlights from sections (top 3-5 items)
    const highlights = [];
    sections.forEach(section => {
      section.items.slice(0, 2).forEach(item => {
        if (highlights.length < 6) {
          highlights.push(item.message || item);
        }
      });
    });

    // Build the new Version History section
    const newVersionSection = `## Version History

### Current Version: ${versionNum} (${dateStr})

#### Highlights
${highlights.map(h => `- ${h}`).join('\n')}

See [CHANGELOG](/changelog) for complete version history.

### Previous Versions`;

    // Replace the Version History section using regex
    // Match from "## Version History" to just before the next major section or end
    const versionHistoryRegex = /## Version History[\s\S]*?### Previous Versions/;

    if (versionHistoryRegex.test(content)) {
      content = content.replace(versionHistoryRegex, newVersionSection);
      await fs.writeFile(readmePath, content, 'utf-8');
      console.log(`✅ Updated README-active.md with version ${versionNum}`);
      return true;
    } else {
      console.log('⚠️ Could not find Version History section in README-active.md');
      return false;
    }
  } catch (error) {
    console.error('Error updating README-active.md:', error.message);
    return false;
  }
}

// Sync all changelog files (changelog.md, changelog.html static data, and README-active.md)
async function syncAllChangelogFiles(version, date, sections) {
  const results = {
    changelogMd: false,
    readme: false
  };

  // Update changelog.md
  results.changelogMd = await updateChangelogMd(version, date, sections);

  // Update README-active.md
  results.readme = await updateReadmeVersion(version, date, sections);

  console.log('\n📊 Sync Results:');
  console.log(`   changelog.md: ${results.changelogMd ? '✅' : '❌'}`);
  console.log(`   README-active.md: ${results.readme ? '✅' : '❌'}`);

  return results;
}

// Generate changelog entry for database storage
function generateChangelogEntry(version, sections) {
  return {
    id: Date.now().toString(),
    version,
    date: new Date().toISOString().split('T')[0],
    sections: sections.map(section => ({
      title: section.label,
      color: section.color,
      items: section.items.map(item => item.message)
    })),
    isCurrent: true,
    createdAt: new Date().toISOString()
  };
}

// Main function to generate changelog from recent commits
async function generateChangelogFromCommits(version = null, sinceTag = null) {
  console.log('📋 Generating changelog from git commits...\n');

  // Determine version
  if (!version) {
    const latestTag = getLatestVersionTag();
    const tagVersion = latestTag ? latestTag.replace('v', '') : '2.5.0';
    const parts = tagVersion.split('.');
    parts[2] = (parseInt(parts[2] || 0) + 1).toString();
    version = `Version ${parts.join('.')}`;
  }

  // Get commits
  const commits = getRecentCommits(sinceTag);

  if (commits.length === 0) {
    console.log('No commits found');
    return null;
  }

  console.log(`Found ${commits.length} commits\n`);

  // Group by category
  const sections = groupCommitsByCategory(commits);

  if (sections.length === 0) {
    console.log('No categorizable changes found');
    return null;
  }

  // Display grouped changes
  console.log('Grouped changes:');
  sections.forEach(section => {
    console.log(`\n${section.label}:`);
    section.items.forEach(item => {
      console.log(`  - ${item.message}`);
    });
  });

  // Generate date string
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Sync all changelog files (changelog.md and README-active.md)
  await syncAllChangelogFiles(version, dateStr, sections);

  // Return entry for database
  return generateChangelogEntry(version, sections);
}

// Compare two semver version strings, return >0 if a > b, <0 if a < b, 0 if equal
function compareVersions(a, b) {
  const pa = (a || '0').replace(/^Version\s+/i, '').split('.').map(n => parseInt(n) || 0);
  const pb = (b || '0').replace(/^Version\s+/i, '').split('.').map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Auto-update changelog on server startup
// Checks for new git commits since last processed, generates a new entry if needed
async function autoUpdateChangelog(db) {
  try {
    // Get current HEAD commit hash
    let currentHash;
    try {
      currentHash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    } catch (e) {
      console.log('Auto-changelog: Not a git repository, skipping');
      return;
    }

    // Check if we've already processed this commit
    const lastHash = await db.get('changelog_last_commit_hash');
    if (lastHash === currentHash) {
      return; // No new commits since last check
    }

    // Get existing changelog entries
    let changelog = (await db.get('changelog')) || [];

    // Clean up: strip "Version " prefix from any existing entries
    let cleaned = false;
    for (const entry of changelog) {
      if (entry.version && /^Version\s+/i.test(entry.version)) {
        entry.version = entry.version.replace(/^Version\s+/i, '');
        cleaned = true;
      }
    }
    if (cleaned) {
      await db.set('changelog', changelog);
    }

    // Get commits since last processed hash
    let commits = [];
    if (lastHash) {
      commits = getRecentCommits(lastHash, 200);
      // If hash is invalid (force push, rebase), fall back to recent commits
      if (commits.length === 0) {
        commits = getRecentCommits(null, 50);
      }
    } else {
      commits = getRecentCommits(null, 50);
    }

    if (commits.length === 0) {
      await db.set('changelog_last_commit_hash', currentHash);
      return;
    }

    // Group by category (filters out excluded commits)
    const sections = groupCommitsByCategory(commits);

    if (sections.length === 0) {
      // No meaningful commits to log
      await db.set('changelog_last_commit_hash', currentHash);
      return;
    }

    // Determine next version number
    // Collect all known versions from DB entries and static baseline
    const allVersions = changelog.map(e => e.version);
    allVersions.push('3.0.0'); // Known static max as baseline

    // Find the highest version
    let maxParts = [0, 0, 0];
    for (const v of allVersions) {
      const parts = (v || '').replace(/^Version\s+/i, '').split('.').map(n => parseInt(n) || 0);
      while (parts.length < 3) parts.push(0);
      if (compareVersions(parts.join('.'), maxParts.join('.')) > 0) {
        maxParts = [parts[0], parts[1], parts[2]];
      }
    }

    // Check if any commit is a feature (for minor vs patch bump)
    const hasFeature = sections.some(s => s.label === 'New Features');
    if (hasFeature) {
      maxParts[1] = (maxParts[1] || 0) + 1;
      maxParts[2] = 0;
    } else {
      maxParts[2] = (maxParts[2] || 0) + 1;
    }
    const nextVersion = maxParts.join('.');

    // Create new changelog entry
    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const newEntry = {
      id: Date.now().toString(),
      version: nextVersion,
      date: dateStr,
      sections: sections.map(s => ({
        title: s.label,
        color: s.color,
        items: s.items.map(i => i.message)
      })),
      isCurrent: true,
      createdAt: new Date().toISOString(),
      autoGenerated: true,
      commitHash: currentHash
    };

    // Mark all existing as not current
    changelog.forEach(e => e.isCurrent = false);

    // Add new entry at beginning
    changelog.unshift(newEntry);
    await db.set('changelog', changelog);
    await db.set('changelog_last_commit_hash', currentHash);

    // Also update changelog.md (non-critical)
    try {
      await updateChangelogMd(`Version ${nextVersion}`, dateStr, sections);
    } catch (e) {
      // Non-critical, just log
      console.log('Auto-changelog: Could not update changelog.md:', e.message);
    }

    const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
    console.log(`✅ Auto-changelog: Generated v${nextVersion} with ${totalItems} items from ${commits.length} commits`);
  } catch (error) {
    console.error('Auto-changelog error (non-blocking):', error.message);
  }
}

// Export for use in server
module.exports = {
  generateChangelogFromCommits,
  autoUpdateChangelog,
  parseCommitMessage,
  groupCommitsByCategory,
  getRecentCommits,
  generateChangelogEntry,
  compareVersions,
  updateReadmeVersion,
  syncAllChangelogFiles,
  shouldExcludeCommit
};
