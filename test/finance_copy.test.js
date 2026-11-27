// Finance is copied on payroll and billing mail and takes the replies (owner, 2026-11-27).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const email = require('../email');
const fin = require('../financeMail');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('a Cc header is written, and a copy never repeats a To address or goes to a placeholder', () => {
  const raw = email.buildMimeMessage({ from: 'A <a@x.com>', to: ['p@x.com'], cc: ['finance@x.com'], replyTo: 'finance@x.com', subject: 's', text: 't' });
  assert.match(raw, /\r\nCc: finance@x\.com\r\n/);
  assert.match(raw, /\r\nReply-To: finance@x\.com\r\n/);
  assert.ok(!/\r\nCc:/.test(email.buildMimeMessage({ from: 'a', to: 'p@x.com', subject: 's', text: 't' })), 'no Cc when there is none');
  assert.deepEqual(email.copyList(['Finance@x.com'], ['finance@x.com', 'b@placeholder.local', 'c@x.com', 'C@x.com']), ['c@x.com']);
});

test('payroll and billing notice types are finance mail; scheduling and clinical are not', () => {
  for (const t of ['paystub_ready', 'tax_form_ready', 'payroll_period_close', 'contractor_invoice_paid', 'payment_received', 'financial_change_requested']) {
    assert.ok(fin.isFinanceType(t), t);
  }
  for (const t of ['shift_assigned', 'staff_clock_open', 'time_adjustment_requested', 'visit_reminder', 'message_received']) {
    assert.ok(!fin.isFinanceType(t), t);
  }
  assert.deepEqual(fin.financeOptions(), { cc: ['finance@godwinsfamilycarellc.com'], replyTo: 'finance@godwinsfamilycarellc.com' });
});

test('every type the finance list names is one the app actually sends', () => {
  const src = ['server.js', 'notifications.js', 'routes/payroll.js'].map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  for (const t of fin.FINANCE_TYPES) assert.ok(src.includes(`'${t}'`), `${t} is not sent anywhere; a typo would silently skip finance`);
});

test('the drain copies finance on finance types, once per notice in a batch, and the billing sends copy it too', () => {
  assert.match(SERVER, /financeMail\.isFinanceType\(notification\.type\)/);
  assert.match(SERVER, /financeCopied\.has\(key\)\) finance = \{ replyTo: finance\.replyTo \}/);
  assert.match(SERVER, /\.\.\.finance\n\s*\}\);/);
  const statement = SERVER.slice(SERVER.indexOf('const notifyStatement'), SERVER.indexOf('const notifyStatement') + 2500);
  assert.match(statement, /\{ htmlBody, \.\.\.financeMail\.financeOptions\(\) \}/);
});
