'use strict';

// ============================================================================
// ONE TASK, NOT TWO (owner, 2026-11-18: "we don't need duplicate ones so go
// ahead and delete the old ones"). Credentialing tasks the office first added
// by hand for one clinician are now built in on every clinician's checklist.
// Once, at boot: a hand-added task that copies a built-in one is removed, and
// what was recorded on it (files, notes, her step) moves to the built-in task
// first, so nothing is lost. A task carrying a document to sign is left alone.
// ============================================================================

// Hand-added title → the built-in task it copies.
const MATCHES = Object.freeze([
  [/\bcaqh\b/i, 'C.6.16'],
  [/medicare/i, 'C.6.15'],
  [/\bpdmp\b|prescription drug monitoring/i, 'C.6.17'],
  [/\bbls\b|basic life support/i, 'C.6.18'],
  [/diploma|transcript|\beducation\b/i, 'C.6.19'],
  [/i-?9 identity|identity document/i, 'C.5.07'],
  [/\bnpi\b|taxonomy/i, 'C.6.02'],
  [/\bdea\b/i, 'C.6.05'],
  [/outside employment/i, 'C.6.09'],
  [/tuberculosis|\btb\b/i, 'C.6.10'],
  [/immuni[sz]ation/i, 'C.6.11'],
  [/driver'?s license|auto insurance/i, 'C.6.12'],
  [/data bank|npdb/i, 'C.4.02'],
  [/pay setup/i, 'C.5.03']
]);
const builtInFor = (title) => (MATCHES.find(([re]) => re.test(String(title || ''))) || [])[1] || null;

const MARKER = 'onboarding_custom_dedupe';

/**
 * → { removed: [{ taskId, title, builtIn, people }], kept: [{ taskId, title, reason }] }
 */
async function dedupeOnce(db, { T, now }) {
  const done = await db.get(MARKER);
  if (done && done.version === 1) return { skipped: true };
  const rows = (await db.get('onboarding_custom_tasks')) || [];
  const recs = (await db.get('onboarding_records')) || [];
  const out = { removed: [], kept: [] };
  for (const task of rows) {
    if (!task || task.removedAt) continue;
    const target = builtInFor(task.title);
    if (!target) continue;
    if (task.documentSendId) { out.kept.push({ taskId: task.id, title: task.title, reason: 'carries a document to sign' }); continue; }
    // Whose checklists it is on.
    const mine = recs.filter(r => r && r.inputs && (task.scope.userId ? String(r.userId) === String(task.scope.userId) : r.inputs.chapter === task.scope.chapter));
    if (!mine.length) continue;
    // Only where the built-in task really is on that person's checklist.
    const onAll = mine.every(r => T.buildTrack({ inputs: r.inputs, record: { userId: r.userId } }).items.some(i => i.id === target));
    if (!onAll) { out.kept.push({ taskId: task.id, title: task.title, reason: `${target} is not on every checklist it reaches` }); continue; }
    const item = T.findItem(target);
    for (const r of mine) {
      const from = (r.items || {})[task.id];
      if (!from) continue;
      r.items = r.items || {};
      const to = Object.assign({}, r.items[target] || {});
      to.files = (to.files || []).concat(from.files || []);
      to.notes = (to.notes || []).concat((from.notes || []).concat([{ id: `moved-${task.id}`, at: now, byName: 'GFC', text: `Moved from the hand-added task "${task.title}".` }]));
      const hersDone = (from.steps || {})[0];
      const k = item.steps.findIndex(s => s.actor === 'NEW_HIRE');
      if (hersDone && k !== -1 && !((to.steps || {})[k])) to.steps = Object.assign({}, to.steps || {}, { [k]: hersDone });
      r.items[target] = to;
    }
    Object.assign(task, { removedAt: now, removedByName: 'GFC (duplicate of a built-in task)', duplicateOf: target });
    out.removed.push({ taskId: task.id, title: task.title, builtIn: target, people: mine.length });
  }
  await db.set('onboarding_custom_tasks', rows);
  await db.set('onboarding_records', recs);
  await db.set(MARKER, { version: 1, at: now, removed: out.removed, kept: out.kept });
  return out;
}

module.exports = { dedupeOnce, builtInFor, MARKER };
