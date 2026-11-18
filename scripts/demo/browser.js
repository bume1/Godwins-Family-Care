// scripts/demo/browser.js — a Chromium page for the demo video. Every outside
// file the pages load (React, Babel, fonts, icons) is fetched once with curl
// and served from a local cache, so the browser never has to trust the proxy
// and certificate checking is never switched off.
const fs = require('fs'); const path = require('path'); const os = require('os'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const CACHE = process.env.GFC_DEMO_CDN || path.join(os.tmpdir(), 'gfc-demo-cdn');
fs.mkdirSync(CACHE, { recursive: true });
function cached(url) {
  const f = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex'));
  if (!fs.existsSync(f)) {
    try { execFileSync('curl', ['-sSL', '-m', '60', '-A', 'Mozilla/5.0 Chrome/120', '-D', f + '.h', '-o', f, url]); } catch (_) { return null; }
  }
  let type = 'application/octet-stream';
  try { const m = fs.readFileSync(f + '.h', 'utf8').match(/content-type:\s*([^\r\n;]+)/gi); if (m) type = m[m.length - 1].split(':')[1].trim(); } catch (_) {}
  return { body: fs.readFileSync(f), contentType: type };
}
async function open({ video, width = 1440, height = 900 } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1,
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {})
  });
  await context.route(/^https:\/\//, async route => {
    const got = cached(route.request().url());
    if (!got) return route.abort();
    route.fulfill({ status: 200, body: got.body, contentType: got.contentType, headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await context.newPage();
  return { browser, context, page };
}
module.exports = { open };
