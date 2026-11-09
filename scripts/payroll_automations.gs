/**
 * GFC payroll automations (Google Apps Script) — spec v2 item 14, rev 2
 *
 * Add this file to the SAME Apps Script project as payroll_paystubs.gs. It
 * uses the same two script properties, so there is one key:
 *   GFC_APP_URL       https://app.godwinsfamilycarellc.com
 *   GFC_PAYROLL_KEY   the same value as PAYROLL_INGEST_KEY on the app
 *
 * Every job only READS and DRAFTS. None of them approves a run, pays anyone,
 * or switches on a tax rate: those stay the owner's clicks in the app.
 *
 * SETUP (once):
 *   1. Project Settings: time zone America/New_York.
 *   2. Run installPayrollTriggers() from the editor and approve the
 *      permissions. Running it again is safe.
 *   3. Triggers page (clock icon): for each trigger set "Failure notification
 *      settings" to "Notify me immediately" so a broken job is never silent.
 *
 * WHAT RUNS WHEN
 *   payrollPeriodClose     daily 7 AM   drafts the run the day after a period ends
 *   payrollMissingTime     daily 6 PM   reminds anyone clocked in over 12 hours
 *   payrollPaymentReminder daily 8 AM   approved runs past send-by date
 *   payrollTaxReminders    daily 9 AM   deposits and filings inside lead time
 *   payrollQuickBooksSync  nightly 2 AM retries failed QuickBooks posts
 *   payrollTaxSourceWatch  Mon 6 AM (daily Dec 1 to Jan 31)
 *   payrollYearEnd         daily 7 AM, acts Jan 2 and Jan 20 only
 *
 * CHANGES FROM REV 1
 *   - Tax sources come from the app when it serves them (one row per state,
 *     so a new state is watched automatically). The list below is the fallback.
 *   - Web pages are hashed on their visible text only, so rotating page
 *     scripts, tokens and banners stop causing false "rate changed" emails.
 *   - One source failing no longer stops the others; failures are reported
 *     together at the end.
 *   - A non-JSON error page from the server (502, 504) gives a clear error.
 *   - Year-end W-2 / 1099 build (Jan 2) and unopened-form reminder (Jan 20).
 *   - installPayrollTriggers also removes rev 1's payrollTaxFormReminders
 *     trigger, whose function this file no longer has.
 */

var FALLBACK_TAX_SOURCES = [
  { name: 'IRS Publication 15-T', url: 'https://www.irs.gov/pub/irs-pdf/p15t.pdf' },
  { name: 'IRS Publication 15', url: 'https://www.irs.gov/pub/irs-pdf/p15.pdf' },
  { name: 'Georgia Employer\'s Tax Guide', url: 'https://dor.georgia.gov/withholding-tax' },
  { name: 'Georgia Form G-4', url: 'https://dor.georgia.gov/document/form/tsdemployeeswithholdingallowancecertificateg-4pdf/download' },
  { name: 'Georgia DOL employer tax', url: 'https://dol.georgia.gov/employers' }
];

function appRequest_(method, path, body) {
  var props = PropertiesService.getScriptProperties();
  var opts = {
    method: method,
    headers: { 'X-GFC-Payroll-Key': props.getProperty('GFC_PAYROLL_KEY') },
    muteHttpExceptions: true
  };
  if (method === 'post') {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body || {});
  }
  var res = UrlFetchApp.fetch(props.getProperty('GFC_APP_URL') + path, opts);
  var code = res.getResponseCode();
  var text = res.getContentText() || '';
  var out;
  try { out = text ? JSON.parse(text) : {}; }
  catch (e) { throw new Error(path + ' answered HTTP ' + code + ' with a non-JSON page (server down or restarting?)'); }
  if (code !== 200) throw new Error(path + ' failed: ' + (out.error || ('HTTP ' + code)));
  return { code: code, body: out };
}

function callPayrollJob_(job, body) {
  var out = appRequest_('post', '/api/payroll/automation/' + job, body).body;
  Logger.log(job + ': ' + JSON.stringify(out));
  return out;
}

function payrollPeriodClose() { return callPayrollJob_('period-close'); }
function payrollMissingTime() { return callPayrollJob_('missing-time'); }
function payrollPaymentReminder() { return callPayrollJob_('payment-reminder'); }
function payrollTaxReminders() { return callPayrollJob_('tax-reminders'); }
function payrollQuickBooksSync() { return callPayrollJob_('qbo-sync'); }

// Jan 2: build W-2s and 1099-NECs as drafts for owner review.
// Jan 20: remind anyone who has not opened their form.
function payrollYearEnd() {
  var now = new Date();
  if (now.getMonth() !== 0) return;
  if (now.getDate() === 2) return callPayrollJob_('year-end-build', { taxYear: now.getFullYear() - 1 });
  if (now.getDate() === 20) return callPayrollJob_('year-end-reminders', { taxYear: now.getFullYear() - 1 });
}

// Sources from the app's tax_sources table when the endpoint exists;
// otherwise the fallback list above.
function taxSources_() {
  try {
    var out = appRequest_('get', '/api/payroll/automation/tax-sources').body;
    if (out && out.sources && out.sources.length) return out.sources;
  } catch (e) {
    Logger.log('Using fallback tax sources: ' + e.message);
  }
  return FALLBACK_TAX_SOURCES;
}

// PDFs: hash the bytes. Web pages: hash visible text only.
function sourceFingerprint_(res) {
  var type = String(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');
  var bytes;
  if (type.indexOf('html') !== -1) {
    var text = res.getContentText()
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(header|footer|nav)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    bytes = Utilities.newBlob(text).getBytes();
  } else {
    bytes = res.getContent();
  }
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return digest.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// Weekly, and daily in December and January when the new year's tables land.
function payrollTaxSourceWatch() {
  var now = new Date();
  var month = now.getMonth();          // 0 = Jan, 11 = Dec
  var isMonday = now.getDay() === 1;
  if (!(isMonday || month === 11 || month === 0)) return;

  var props = PropertiesService.getScriptProperties();
  var failures = [];

  taxSources_().forEach(function (src) {
    try {
      var res = UrlFetchApp.fetch(src.url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) { failures.push(src.name + ': HTTP ' + res.getResponseCode()); return; }
      var hash = sourceFingerprint_(res);
      var keyName = 'TAX_SOURCE_HASH_' + src.name.replace(/[^A-Za-z0-9]/g, '_');
      var last = props.getProperty(keyName);
      if (last && last !== hash) {
        callPayrollJob_('tax-source-changed', { source: src.name, url: src.url, hash: hash, jurisdiction: src.jurisdiction || null });
      }
      // Saved only after the app accepted the change, so a failed call retries next run.
      props.setProperty(keyName, hash);
    } catch (e) {
      failures.push(src.name + ': ' + e.message);
    }
  });

  if (failures.length) {
    // Throwing makes Apps Script send its failure email (see setup step 3).
    throw new Error('Tax source watch could not check ' + failures.length + ' source(s): ' + failures.join(' | '));
  }
}

function installPayrollTriggers() {
  // payrollTaxFormReminders is rev 1's; listed so its trigger is removed.
  var mine = ['payrollPeriodClose', 'payrollMissingTime', 'payrollPaymentReminder', 'payrollTaxReminders',
              'payrollQuickBooksSync', 'payrollTaxSourceWatch', 'payrollYearEnd', 'payrollTaxFormReminders'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (mine.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('payrollPeriodClose').timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger('payrollMissingTime').timeBased().everyDays(1).atHour(18).create();
  ScriptApp.newTrigger('payrollPaymentReminder').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('payrollTaxReminders').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('payrollQuickBooksSync').timeBased().everyDays(1).atHour(2).create();
  ScriptApp.newTrigger('payrollTaxSourceWatch').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('payrollYearEnd').timeBased().everyDays(1).atHour(7).create();
  Logger.log('Payroll triggers installed.');
}
