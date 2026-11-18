// scripts/demo/director.js — what makes a recording read as a walkthrough:
// a visible pointer (Playwright's video shows none), a caption bar along the
// bottom, title cards, and human-paced moves and typing.
const OVERLAY = `
(() => {
  if (window.__demoReady) return; window.__demoReady = true;
  const css = \`
    #demo-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .12s}
    #demo-cursor.down{transform:scale(.8)}
    #demo-ring{position:fixed;z-index:2147483646;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:3px solid #C9A24A;pointer-events:none;opacity:0}
    #demo-ring.go{animation:demoRing .5s ease-out}
    @keyframes demoRing{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
    #demo-cap{position:fixed;z-index:2147483645;left:50%;bottom:36px;transform:translateX(-50%) translateY(20px);max-width:1000px;
      background:rgba(4,59,79,.96);color:#fff;border-left:5px solid #C9A24A;border-radius:12px;padding:16px 26px;
      font:500 22px/1.4 'DM Sans',system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;transition:opacity .35s,transform .35s;pointer-events:none}
    #demo-cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
    #demo-cap b{color:#E9C77B;font-weight:700}\`;
  const add = () => {
    if (!document.body || !document.head || document.getElementById('demo-cursor')) return;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#043B4F" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const r = document.createElement('div'); r.id = 'demo-ring';
    const cap = document.createElement('div'); cap.id = 'demo-cap';
    document.body.append(c, r, cap);
    const p = window.__demoPos || { x: 720, y: 450 }; c.style.left = p.x + 'px'; c.style.top = p.y + 'px';
    if (window.__demoCapText) { cap.innerHTML = window.__demoCapText; cap.classList.add('on'); }
  };
  document.addEventListener('mousemove', e => { window.__demoPos = { x: e.clientX, y: e.clientY }; const c = document.getElementById('demo-cursor'); if (c) { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; } }, true);
  document.addEventListener('mousedown', e => { const c = document.getElementById('demo-cursor'), r = document.getElementById('demo-ring'); if (c) c.classList.add('down'); if (r) { r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); } }, true);
  document.addEventListener('mouseup', () => { const c = document.getElementById('demo-cursor'); if (c) c.classList.remove('down'); }, true);
  window.__demoCaption = (html) => { window.__demoCapText = html; add(); const cap = document.getElementById('demo-cap'); if (!html) { cap.classList.remove('on'); return; } cap.innerHTML = html; cap.classList.add('on'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  const watch = () => { if (document.body) new MutationObserver(add).observe(document.body, { childList: true }); else setTimeout(watch, 50); }; watch();
})();`;

function director(page) {
  let pos = { x: 720, y: 450 };
  const wait = (ms) => page.waitForTimeout(ms);
  async function moveTo(x, y, ms = 700) {
    const steps = Math.max(8, Math.round(ms / 16));
    await page.mouse.move(x, y, { steps }); pos = { x, y };
  }
  async function point(target, ms) {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox();
    if (!b) throw new Error('nothing to point at: ' + target);
    await moveTo(b.x + Math.min(b.width / 2, 60), b.y + b.height / 2, ms);
    return loc;
  }
  async function click(target, { pause = 350 } = {}) {
    await point(target); await wait(pause);
    await page.mouse.down(); await wait(90); await page.mouse.up();
  }
  async function type(target, text, delay = 70) {
    await click(target); await page.keyboard.type(text, { delay });
  }
  async function caption(html, hold = 0) {
    await page.evaluate(h => window.__demoCaption && window.__demoCaption(h), html);
    if (hold) await wait(hold);
  }
  async function scrollBy(dy, ms = 1200) {
    const steps = 30;
    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await wait(ms / steps); }
  }
  async function card({ kicker = '', title, sub = '' }, hold = 3500, base = '') {
    await page.setContent(`<!doctype html><html><head>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
      <style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;flex-direction:column;
      background:radial-gradient(circle at 30% 20%,#0b5470,#043B4F 60%,#022a39);color:#fff;font-family:'DM Sans',sans-serif;text-align:center}
      img{width:120px;margin-bottom:28px}.k{color:#E9C77B;letter-spacing:.22em;text-transform:uppercase;font-size:18px;font-weight:700}
      h1{font-family:'Cormorant Garamond',serif;font-size:76px;margin:14px 0 10px;font-weight:700}
      .rule{width:90px;height:4px;background:#C9A24A;border-radius:2px;margin:6px auto 22px}p{font-size:26px;color:#d9e6ea;margin:0;max-width:900px}
      .fade{animation:f .8s ease-out both}@keyframes f{from{opacity:0;transform:translateY(12px)}to{opacity:1}}</style></head>
      <body><div class="fade"><img src="${base}/brand/logo-mark-color-transparent.png" onerror="this.remove()"><div class="k">${kicker}</div>
      <h1>${title}</h1><div class="rule"></div><p>${sub}</p></div></body></html>`, { waitUntil: 'networkidle' }).catch(() => {});
    await wait(hold);
  }
  return { wait, moveTo, point, click, type, caption, scrollBy, card };
}
module.exports = { director, OVERLAY };
