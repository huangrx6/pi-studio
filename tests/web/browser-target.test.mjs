import assert from 'node:assert/strict';
import test from 'node:test';

const { normalizeBrowserTarget } = await import('../../web/src/shell/right-panel/browser-target.mjs');

test('accepts full URLs and bare hosts, refuses other schemes', () => {
  assert.equal(normalizeBrowserTarget('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeBrowserTarget('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normalizeBrowserTarget('example.com'), 'https://example.com');
  assert.equal(normalizeBrowserTarget('localhost:5180'), 'https://localhost:5180');
  assert.equal(normalizeBrowserTarget('file:///etc/passwd'), '');
  assert.equal(normalizeBrowserTarget('javascript:alert(1)'), '');
  assert.equal(normalizeBrowserTarget(''), '');
  assert.equal(normalizeBrowserTarget('   '), '');
});
