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
//   window.GFCPdfPages.useZoom(paneRef) { zoom, bar, pageStyle }: zoom for
//                                    the document pane. "Fit" fills the pane;
//                                    + and - step up to 300%. A trackpad pinch
//                                    or Ctrl/Cmd+scroll over the pane zooms
//                                    the document only. Phones and tablets
//                                    also keep their own pinch-zoom.
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
      // Drawn sharp enough to stay crisp when zoomed in.
      var vp = pg.getViewport({ scale: 2.4 });
      var c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out.push({ src: c.toDataURL('image/png'), width: base.width, height: base.height });
    }
    doc.destroy();
    return out;
  }
  var STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
  var clamp = function (z) { return Math.min(3, Math.max(1, Math.round(z * 100) / 100)); };
  function useZoom(paneRef) {
    var R = window.React;
    var st = R.useState(1); var zoom = st[0]; var setZoom = st[1];
    R.useEffect(function () {
      var el = paneRef && paneRef.current;
      if (!el) return undefined;
      // A trackpad pinch arrives as a wheel event with ctrlKey set.
      var onWheel = function (e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom(function (z) { return clamp(z * Math.exp(-e.deltaY / 300)); });
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return function () { el.removeEventListener('wheel', onWheel); };
    }, [paneRef && paneRef.current]);
    var up = function () { setZoom(function (z) { return STEPS.find(function (x) { return x > z + 0.01; }) || 3; }); };
    var down = function () { setZoom(function (z) { return STEPS.slice().reverse().find(function (x) { return x < z - 0.01; }) || 1; }); };
    var h = R.createElement;
    var btn = function (label, onClick, disabled, title) {
      return h('button', { type: 'button', className: 'gfc-zoom-btn', onClick: onClick, disabled: disabled, title: title, 'aria-label': title }, label);
    };
    var bar = h('div', { className: 'gfc-zoom', role: 'group', 'aria-label': 'Zoom the document' },
      btn('\u2212', down, zoom <= 1, 'Zoom out'),
      h('span', { className: 'gfc-zoom-pct', 'aria-live': 'polite' }, Math.round(zoom * 100) + '%'),
      btn('+', up, zoom >= 3, 'Zoom in'),
      btn('Fit', function () { setZoom(1); }, zoom === 1, 'Fit to width'));
    // Fit is the pane's width (capped at 820px); zoom widens the page past it
    // and the pane scrolls both ways.
    var pageStyle = zoom === 1 ? null : { width: (zoom * 100) + '%', maxWidth: (820 * zoom) + 'px' };
    return { zoom: zoom, bar: bar, pageStyle: pageStyle };
  }
  (function styles() {
    if (document.getElementById('gfc-zoom-styles')) return;
    var el = document.createElement('style'); el.id = 'gfc-zoom-styles';
    el.textContent = '.gfc-zoom{position:sticky;top:0;left:0;z-index:2;display:flex;align-items:center;gap:6px;width:max-content;margin:0 0 10px auto;padding:5px 7px;background:#fff;border:1px solid #E1D7C5;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.12)}'
      + '.gfc-zoom-btn{min-width:34px;height:32px;padding:0 9px;border-radius:8px;border:1.5px solid #E1D7C5;background:#fff;color:#033D50;font:600 15px/1 system-ui,sans-serif;cursor:pointer;width:auto;margin:0}'
      + '.gfc-zoom-btn[disabled]{opacity:.4;cursor:default}'
      + '.gfc-zoom-pct{min-width:46px;text-align:center;font:600 13px/1 system-ui,sans-serif;color:#41555f}';
    document.head.appendChild(el);
  })();
  window.GFCPdfPages = { load: load, pages: pages, useZoom: useZoom };
})();
