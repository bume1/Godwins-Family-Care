'use strict';
// Two pages crashed live (2026-11-04) on a name that did not exist where it
// was used: `gfcTime` (the helper is window.GFC_TIME) on the AI setup panel and
// the chart's earlier-reviews list, and `financialPending` read by UsersPage
// while its state lived in InboxPage. These pin both.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('no page calls a lowercase gfcTime helper; the time module is window.GFC_TIME', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter(n => n.endsWith('.html'))) {
    assert.ok(!/\bgfcTime\./.test(read(f)), `${f} uses gfcTime, which is never defined`);
  }
});

test('the pay-change list is declared in UsersPage, the component that reads it', () => {
  const s = read('admin-hub.html');
  const start = s.indexOf('const UsersPage = (');
  const end = s.indexOf('\n    const ', start + 30);
  assert.ok(start > 0 && end > start);
  const users = s.slice(start, s.indexOf('\n    };\n', start));
  assert.match(users, /const \[financialPending, setFinancialPending\] = useState\(\[\]\)/);
  assert.match(users, /loadFinancial\(\);/, 'and loads it');
  const inbox = s.slice(s.indexOf('const InboxPage = ('), start);
  assert.ok(!inbox.includes('financialPending'), 'not left behind in InboxPage');
});
