/**
 * GFC payroll → My GFC pay stubs (Google Apps Script)
 *
 * Paste into the Apps Script project that builds payroll results. Your script
 * produces one row per person per pay date; this sends those rows to the app,
 * and each person sees theirs under My GFC → Hours & Pay.
 *
 * SETUP (once):
 *   1. In the app's environment set PAYROLL_INGEST_KEY to a long random string
 *      and restart. Until it is set the app answers 503 and stores nothing.
 *   2. In this Apps Script project: Project Settings → Script properties:
 *        GFC_APP_URL         https://app.godwinsfamilycarellc.com
 *        GFC_PAYROLL_KEY     the same value as PAYROLL_INGEST_KEY
 *
 * EACH STUB the app accepts:
 *   email        the person's sign-in email in the app (how they are matched)
 *   payDate      YYYY-MM-DD
 *   periodStart  YYYY-MM-DD
 *   periodEnd    YYYY-MM-DD
 *   gross, net   numbers (dollars)
 *   hours        number, optional
 *   reference    optional, e.g. the payroll provider's check or run number
 *   and ONE of, optional:
 *     pdfBase64    the stub PDF itself (the app files it in that person's
 *                  staff folder in Drive)
 *     driveFileId  a PDF already in Drive. The app's service account must be
 *                  able to read it (a Shared Drive it belongs to).
 *
 * Sending the same person + payDate + reference again REPLACES that stub, so
 * a re-run never doubles. The reply lists every row it skipped and why.
 */

function sendPayStubsToApp(stubs) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('GFC_APP_URL') + '/api/payroll/paystubs';
  var key = props.getProperty('GFC_PAYROLL_KEY');
  var results = { stored: 0, updated: 0, skipped: [] };
  // 100 per call keeps each request well under the app's size limit when PDFs
  // ride along.
  for (var i = 0; i < stubs.length; i += 100) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-GFC-Payroll-Key': key },
      payload: JSON.stringify({ stubs: stubs.slice(i, i + 100) }),
      muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200) throw new Error('App refused the pay stubs: ' + (body.error || res.getResponseCode()));
    results.stored += body.stored; results.updated += body.updated;
    results.skipped = results.skipped.concat(body.skipped || []);
  }
  Logger.log(JSON.stringify(results));
  return results;
}

// Example: a PDF your script already made, sent as bytes.
function exampleStub_(email, pdfBlob) {
  return {
    email: email,
    payDate: '2026-11-14', periodStart: '2026-11-01', periodEnd: '2026-11-14',
    gross: 1520.00, net: 1268.42, hours: 76,
    reference: 'RUN-2026-11-14',
    pdfBase64: pdfBlob ? Utilities.base64Encode(pdfBlob.getBytes()) : undefined
  };
}
