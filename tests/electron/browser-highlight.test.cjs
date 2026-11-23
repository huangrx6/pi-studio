const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('highlight script builder is present in actions module source', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../electron/main/services/browser/actions.cjs'),
    'utf8',
  );
  assert.match(source, /data-pi-highlight/);
  assert.match(source, /pi-browser-highlight-label/);
  assert.match(source, /function highlightBrowserRef/);
  assert.match(source, /function clearBrowserHighlights/);
  assert.match(source, /function evaluateBrowserScript/);
});
