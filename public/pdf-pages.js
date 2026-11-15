// ============================================================================
// A PDF DRAWN AS PAGE IMAGES (shared, 2026-11-15)
// ============================================================================
// The one place a page turns a PDF into pictures it can show beside a form.
// Used by the tax form workspace (/my-pay.js) and the Documents to Sign
// workspace (/document-sign-ui.js), so the two signing screens cannot drift.
// pdf.js loads from cdnjs only when a workspace first opens.
//
//   window.GFCPdfPages.load()        resolves to pdfjsLib
//   window.GFCPdfPages.pages(buf, { lastOnly })
//                                    resolves to [{ src, width, height }]
//                                    (width/height in PDF points); lastOnly
//                                    draws just the final page
// ============================================================================
(function () {
  if (window.GFCPdfPages) return;
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var pending = null;
  function load() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pending) return pending;
    pending = new Promise(function (ok, bad) {
      var el = document.createElement('script');
      el.src = PDFJS + 'pdf.min.js';
      el.onload = function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
      el.onerror = function () { pending = null; bad(new Error('The document viewer could not load.')); };
      document.head.appendChild(el);
    });
    return pending;
  }
  async function pages(buf, opts) {
    var lib = await load();
    var doc = await lib.getDocument({ data: buf }).promise;
    var out = [];
    for (var i = (opts && opts.lastOnly) ? doc.numPages : 1; i <= doc.numPages; i++) {
      var pg = await doc.getPage(i);
      var base = pg.getViewport({ scale: 1 });
      var vp = pg.getViewport({ scale: 1.6 });
      var c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out.push({ src: c.toDataURL('image/png'), width: base.width, height: base.height });
    }
    doc.destroy();
    return out;
  }
  window.GFCPdfPages = { load: load, pages: pages };
})();
