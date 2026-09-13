#!/usr/bin/env node
// ============================================================================
// repair_cross_client_messages.js
//
// Cleans up after the cross-client messaging leak found on 2026-09-13.
//
// WHAT WENT WRONG. `threadVisibility()` guarded a client against reading
// another client's conversation with `client && thread.client_id !== client.id`
// — but the routes pass the THREAD's client, so it compared a thread to its own
// client. Always false. The guard never once fired, and for as long as it was
// deployed every client could open, read and REPLY TO every other client's
// threads on every client-reachable channel. The code is fixed. This script
// deals with what the defect already wrote: messages sitting in the wrong
// client's thread, visible to that client and to their caregiver.
//
// WHAT IT DOES. A message is MISFILED when its sender is a client or a family
// member whose own client record is not the one the thread belongs to. Staff
// messages are never misfiled — a clinician, case manager, caregiver or admin
// has no own-client, and posting across clients is their job.
//
// Misfiled rows are MOVED to `quarantined_messages`, not deleted. The house
// rule on this repo is that a record is tombstoned, never dropped: these rows
// are evidence of a PHI exposure and may be needed for a breach assessment, so
// they leave the reader's view and stay readable to an operator. Each carries
// why it was pulled, when, and which thread it was in.
//
// IDEMPOTENT. Re-running finds nothing the second time, because the rows are
// gone from `messages`. Safe to run more than once.
//
// USAGE
//   node scripts/repair_cross_client_messages.js            # report only
//   node scripts/repair_cross_client_messages.js --apply    # move them
//
// Run the report first and read it. It names every affected client pair, which
// is the list a breach assessment starts from.
// ============================================================================
'use strict';

const path = require('path');
const APPLY = process.argv.includes('--apply');

// The same resolution the fixed repository uses: a client IS their client
// record; a family member resolves through familyOfClientId. Anyone else has
// no own-client and is out of scope here. Deliberately a COPY rather than an
// import of messagingRepository: this script has to be able to repair a store
// written by the buggy code, so it must not depend on the module it is
// cleaning up after.
const ownClientId = (u) => {
  if (!u) return null;
  if (u.role === 'client') return u.id || null;
  if (u.role === 'family') return u.familyOfClientId || null;
  return null;
};

// A message is MISFILED when its sender is a client or family member whose own
// client is not the one the thread belongs to. Exported so a test can drive it
// against a fixture rather than a live store.
function findMisfiled({ users, threads, messages }) {
  const byId = new Map((users || []).map(u => [u.id, u]));
  const threadById = new Map((threads || []).map(t => [t.id, t]));
  const misfiled = [];
  for (const m of messages || []) {
    if (!m) continue;
    const sender = byId.get(m.from_user_id);
    const mine = ownClientId(sender);
    if (!mine) continue;                       // staff — never misfiled
    const thread = threadById.get(m.thread_id);
    const threadClient = thread ? thread.client_id : m.client_id;
    if (!threadClient) continue;
    if (String(mine) !== String(threadClient)) {
      misfiled.push({ message: m, sender, senderClientId: mine, threadClientId: threadClient, thread });
    }
  }
  return misfiled;
}

// Refresh each thread's cached preview from the messages that REMAIN. A preview
// is a copy of the last message, so a quarantined one would keep showing in the
// list after it is gone from the body.
function refreshPreviews(threads, remaining) {
  let touched = 0;
  for (const t of threads || []) {
    if (!t) continue;
    const own = remaining.filter(m => m && m.thread_id === t.id)
      .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
    const last = own[own.length - 1];
    const prevAt = t.last_message_at;
    t.last_message_at = last ? last.sent_at : t.created_at;
    t.last_message_preview = last ? String(last.body || '').slice(0, 120) : '';
    if (t.last_message_at !== prevAt) touched++;
  }
  return touched;
}

async function main() {
  // Built the same way server.js builds it (`dataStore.createStore()`), so this
  // reads and writes exactly the store the app is running on — dev or the
  // production Postgres inside the boundary. Do NOT require the module and call
  // get/set on it: `dataStore` exports the FACTORY, not a store.
  const dataStore = require(path.join(__dirname, '..', 'dataStore'));
  const db = dataStore.createStore();

  const get = async (k) => (await db.get(k)) || [];
  const users = await get('users');
  const threads = await get('message_threads');
  const messages = await get('messages');

  const byId = new Map(users.map(u => [u.id, u]));
  const misfiled = findMisfiled({ users, threads, messages });
  const name = (id) => (byId.get(id) || {}).name || id;

  console.log(`\nScanned ${messages.length} messages across ${threads.length} threads.`);
  if (!misfiled.length) {
    console.log('No misfiled messages. Nothing to repair.\n');
    return;
  }

  console.log(`\n${misfiled.length} MISFILED MESSAGE(S) — each written by one client into another client's thread:\n`);
  const pairs = new Map();
  for (const r of misfiled) {
    const key = `${r.senderClientId}→${r.threadClientId}`;
    pairs.set(key, (pairs.get(key) || 0) + 1);
    const channel = (r.thread && r.thread.channel) || r.message.channel || 'unknown';
    console.log(`  [${r.message.sent_at}] ${name(r.senderClientId)} wrote into ${name(r.threadClientId)}'s ${channel} thread`);
    console.log(`      thread ${r.message.thread_id}  message ${r.message.id}`);
  }
  console.log('\nEXPOSURE PAIRS (who could see whose messages):');
  for (const [k, n] of pairs) {
    const [a, b] = k.split('→');
    console.log(`  ${name(a)} → ${name(b)}: ${n} message(s). Everyone who can read ${name(b)}'s thread saw them.`);
  }

  if (!APPLY) {
    console.log('\nREPORT ONLY. Re-run with --apply to move these into quarantined_messages.\n');
    return;
  }

  const quarantine = await get('quarantined_messages');
  const at = new Date().toISOString();
  const ids = new Set(misfiled.map(r => r.message.id));
  for (const r of misfiled) {
    quarantine.push({
      ...r.message,
      quarantined_at: at,
      quarantined_reason: 'cross_client_leak_2026_09_13',
      quarantined_detail: `Written by a user whose client is ${r.senderClientId} into a thread belonging to ${r.threadClientId}.`,
      original_thread_id: r.message.thread_id,
      original_thread_client_id: r.threadClientId
    });
  }
  const kept = messages.filter(m => m && !ids.has(m.id));
  await db.set('quarantined_messages', quarantine);
  await db.set('messages', kept);

  const touched = refreshPreviews(threads, kept);
  await db.set('message_threads', threads);

  console.log(`\nMoved ${misfiled.length} message(s) into quarantined_messages.`);
  console.log(`Refreshed the preview on ${touched} thread(s).`);
  console.log('Read them back with the KV snapshot script if a breach assessment needs them.\n');
}

module.exports = { findMisfiled, refreshPreviews, ownClientId };

// Only run when invoked directly, so requiring it from a test does not repair
// anything.
if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('\nrepair_cross_client_messages failed:', err.message);
    process.exit(1);
  });
}
