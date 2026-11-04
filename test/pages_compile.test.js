'use strict';
// Every page's in-browser script must compile the way the browser compiles it
// (@babel/standalone, preset react). On 2026-11-04 two PRs each fixed the same
// bug by declaring `financialPending` in UsersPage. Each passed on its own, the
// merge declared it twice, and Babel refused the whole admin hub: a blank
// screen. This compiles every page so that becomes a failed test instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Babel = require('@babel/standalone');

const dir = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(dir).filter(n => n.endsWith('.html'));

for (const f of pages) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const scripts = [...src.matchAll(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!scripts.length) continue;
  test(`${f}: every in-browser script compiles`, () => {
    scripts.forEach((code, i) => {
      try {
        Babel.transform(code, { presets: ['react'], compact: true });
      } catch (e) {
        assert.fail(`${f} script #${i + 1}: ${String(e.message).split('\n')[0]}`);
      }
    });
  });
}

test('the compile check actually catches a duplicate declaration', () => {
  assert.throws(() => Babel.transform('const A = () => { const [x] = [1]; const [x] = [2]; return <div/>; };', { presets: ['react'] }), /already been declared/);
});
