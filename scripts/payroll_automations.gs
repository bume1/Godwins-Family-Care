/**
 * GFC payroll automations (Google Apps Script) — spec v2 item 14
 *
 * Add this file to the SAME Apps Script project as payroll_paystubs.gs. It
 * uses the same two script properties, so there is one key:
 *   GFC_APP_URL       https://app.godwinsfamilycarellc.com
 *   GFC_PAYROLL_KEY   the same value as PAYROLL_INGEST_KEY on the app
 *
 * Every job only READS and DRAFTS. None of them approves a run, pays anyone,
 * or switches on a tax rate: those stay the owner's clicks in the app.
 *
 * SETUP (once): run installPayrollTriggers() from the editor and approve the
 * permissions it asks for. It replaces any triggers it made before, so
 * running it twice is safe. Times are the project's time zone: set it to
 * America/New_York under Project Settings.
 *
 * WHAT RUNS WHEN
 *   payrollPeriodClose     daily 7 AM. The day after a pay period ends, the app
 *                          drafts that period's run and emails the owner a
 *                          review link. On other days it reports "already".
 *   payrollMissingTime     daily 6 PM. Anyone clocked in for more than 12
 *                          hours gets a reminder to clock out.
 *   payrollPaymentReminder daily 8 AM. Approved runs past their send-by date
 *                          remind the owner to send the PNC payments.
 *   payrollTaxReminders    daily 9 AM. Deposits and filings due within the
 *                          lead time set in the app.
 *   payrollQuickBooksSync  nightly 2 AM. Retries any QuickBooks sync that failed.
 *   payrollTaxSourceWatch  weekly, Monday 6 AM (daily Dec 1 to Jan 31). Hashes
 *                          each tax source below; when one changes, the app
 *                          emails the owner to review and stage new rates.
 */

var TAX_SOURCES = [
  { name: 'IRS Publication 15-T', url: 'https://www.irs.gov/pub/irs-pdf/p15t.pdf' },
  { name: 'IRS Publication 15', url: 'https://www.irs.gov/pub/irs-pdf/p15.pdf' },
  { name: 'Georgia Employer\'s Tax Guide', url: 'https://dor.georgia.gov/withholding-tax' },
  { name: 'Georgia Form G-4', url: 'https://dor.georgia.gov/document/form/tsdemployeeswithholdingallowancecertificateg-4pdf/download' },
  { name: 'Georgia DOL employer tax', url: 'https://dol.georgia.gov/employers' }
];

function callPayrollJob_(job, body) {
  var props = PropertiesService.getScriptProperties();
  var res = UrlFetchApp.fetch(props.getProperty('GFC_APP_URL') + '/api/payroll/automation/' + job, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-GFC-Payroll-Key': props.getProperty('GFC_PAYROLL_KEY') },
    payload: JSON.stringify(body || {}),
    muteHttpExceptions: true
  });
  var out = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Payroll job ' + job + ' failed: ' + (out.error || res.getResponseCode()));
  Logger.log(job + ': ' + JSON.stringify(out));
  return out;
}

function payrollPeriodClose() { return callPayrollJob_('period-close'); }
function payrollMissingTime() { return callPayrollJob_('missing-time'); }
function payrollPaymentReminder() { return callPayrollJob_('payment-reminder'); }
function payrollTaxReminders() { return callPayrollJob_('tax-reminders'); }
function payrollQuickBooksSync() { return callPayrollJob_('qbo-sync'); }

// Weekly, and daily in December and January when the new year's tables land.
function payrollTaxSourceWatch() {
  var month = new Date().getMonth();   // 0 = Jan, 11 = Dec
  var isMonday = new Date().getDay() === 1;
  if (!(isMonday || month === 11 || month === 0)) return;
  var props = PropertiesService.getScriptProperties();
  TAX_SOURCES.forEach(function (src) {
    var res = UrlFetchApp.fetch(src.url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) { Logger.log(src.name + ': HTTP ' + res.getResponseCode()); return; }
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, res.getContent());
    var hash = digest.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
    var keyName = 'TAX_SOURCE_HASH_' + src.name.replace(/[^A-Za-z0-9]/g, '_');
    var last = props.getProperty(keyName);
    if (last && last !== hash) callPayrollJob_('tax-source-changed', { source: src.name, url: src.url, hash: hash });
    props.setProperty(keyName, hash);
  });
}

function installPayrollTriggers() {
  var mine = ['payrollPeriodClose', 'payrollMissingTime', 'payrollPaymentReminder', 'payrollTaxReminders', 'payrollQuickBooksSync', 'payrollTaxSourceWatch'];
  ScriptApp.getProjectTriggers().forEach(function (t) { if (mine.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('payrollPeriodClose').timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger('payrollMissingTime').timeBased().everyDays(1).atHour(18).create();
  ScriptApp.newTrigger('payrollPaymentReminder').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('payrollTaxReminders').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('payrollQuickBooksSync').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('payrollTaxSourceWatch').timeBased().everyDays(1).atHour(6).create();
  Logger.log('Payroll triggers installed.');
}
