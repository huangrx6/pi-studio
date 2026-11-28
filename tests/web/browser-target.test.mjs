import assert from 'node:assert/strict';
import test from 'node:test';

const { normalizeBrowserTarget } = await import('../../web/src/features/browser/browser-target.ts');

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

test('accepts absolute HTML paths and file:// HTML URLs', () => {
  assert.equal(
    normalizeBrowserTarget('file:///tmp/demo/index.html'),
    'file:///tmp/demo/index.html',
  );
  assert.equal(
    normalizeBrowserTarget('/tmp/demo/index.html'),
    'file:///tmp/demo/index.html',
  );
  assert.equal(
    normalizeBrowserTarget('/tmp/知识问答/index.html'),
    'file:///tmp/%E7%9F%A5%E8%AF%86%E9%97%AE%E7%AD%94/index.html',
  );
  assert.equal(normalizeBrowserTarget('/tmp/demo/notes.md'), '');
});
