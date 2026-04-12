# Changelog Automation Guide

This project includes an automated changelog generation system that creates release notes from git commits.

## 🤖 Automatic Updates

### Git Hook (Pre-Push)

A pre-push hook is installed that automatically generates changelog entries before pushing code to remote.

**How it works:**
1. When you run `git push`, the hook checks for unpushed commits
2. If new commits are found, it automatically generates a changelog entry
3. You'll be prompted to review and commit the changelog updates
4. The changelog is then included in your push

**To skip the hook:** Use `git push --no-verify`

**To disable automatic updates:** Edit `.git/hooks/pre-push` and set `AUTO_UPDATE_CHANGELOG=false`

## 📝 Manual Changelog Generation

### Using npm script:
```bash
npm run changelog
```

### Using Node directly:
```bash
node changelog-generator.js
```

### Generate specific version:
```bash
node changelog-generator.js "Version 2.8.0"
```

### Generate from specific git tag:
```bash
node changelog-generator.js "Version 2.8.0" "v2.7.0"
```

## 📋 Commit Message Best Practices

For best automatic categorization, use conventional commit formats:

### New Features
```bash
git commit -m "feat: Add user profile page"
git commit -m "feature: Implement dark mode toggle"
```

### Bug Fixes
```bash
git commit -m "fix: Resolve login redirect issue"
git commit -m "bugfix: Correct calculation error in reports"
```

### Improvements
```bash
git commit -m "refactor: Improve database query performance"
git commit -m "Update user interface styling"
```

### UI Changes
```bash
git commit -m "ui: Redesign dashboard layout"
git commit -m "style: Update button colors"
```

### Other Types
- `perf:` - Performance improvements
- `docs:` - Documentation changes

## 🚫 Excluded Commits

The following commits are **automatically excluded** from changelogs:
- "Published your App"
- Deployment messages
- Merge commits
- "WIP" or "Work in progress"
- Version bump commits
- Very short messages (< 10 characters)
- Test commits
- Formatting/whitespace changes

## 📂 Changelog Files

The system maintains three synchronized changelog files:

1. **`public/changelog.html`** - Interactive web viewer with admin features
2. **`public/changelog.md`** - Markdown version for documentation
3. **`README-active.md`** - Version highlights in main README

All three files are automatically updated when you generate a changelog.

## 🌐 Web Interface

Admin users can also manage changelogs through the web interface:

1. Visit `/changelog` in your browser
2. Log in as an admin user
3. Use the "Generate from Git" button to preview and create changelog entries
4. Or use the "Manual" button to create custom changelog entries

## 🔧 Configuration

### Customize Categories

Edit `changelog-generator.js` to modify the `CATEGORIES` object:

```javascript
const CATEGORIES = {
  feat: { label: 'New Features', color: 'primary', priority: 1 },
  fix: { label: 'Bug Fixes', color: 'success', priority: 2 },
  // Add your own categories...
};
```

### Customize Exclusions

Edit the `EXCLUDED_PATTERNS` array in `changelog-generator.js`:

```javascript
const EXCLUDED_PATTERNS = [
  /^published your app/i,
  /^deploy/i,
  // Add your own patterns...
];
```

## 💡 Tips

1. **Write descriptive commit messages** - They become your changelog entries
2. **Group related changes** - Use feature branches and meaningful commits
3. **Review before pushing** - The pre-push hook lets you review changelog updates
4. **Use semantic versioning** - Major.Minor.Patch (e.g., 2.7.3)

## 🔄 Workflow Example

```bash
# Make your changes
git add .
git commit -m "feat: Add collapsible phases to project board"
git commit -m "fix: Correct phase persistence issue"

# Push (hook will run automatically)
git push origin your-branch

# Hook will:
# 1. Detect 2 new commits
# 2. Generate changelog for next version (e.g., 2.7.4)
# 3. Show you the changes
# 4. Ask if you want to commit them
# 5. Include changelog in your push
```

## 📊 API Endpoints

The server also provides REST APIs for changelog management:

- `GET /api/changelog` - Retrieve all changelog entries
- `POST /api/changelog` - Create new changelog entry (admin only)
- `GET /api/changelog/preview` - Preview changelog from recent commits
- `POST /api/changelog/generate` - Generate and save changelog from commits

## 🎯 Version Numbering

- **Major** (X.0.0): Breaking changes, major features
- **Minor** (2.X.0): New features, non-breaking changes
- **Patch** (2.7.X): Bug fixes, small improvements

The system automatically increments the patch version by default.

---

**Last Updated:** January 26, 2026
