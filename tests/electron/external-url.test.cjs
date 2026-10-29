const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isLoopbackHostname,
  normalizeSecureHttpUrl,
} = require('../../electron/core/external-url.cjs');

test('remote service URLs require HTTPS while loopback development may use HTTP', () => {
  assert.equal(
    normalizeSecureHttpUrl('https://example.com/mcp#ignored'),
    'https://example.com/mcp',
  );
  assert.equal(
    normalizeSecureHttpUrl('http://localhost:3000/mcp'),
    'http://localhost:3000/mcp',
  );
  assert.equal(
    normalizeSecureHttpUrl('http://127.0.0.1:3000/mcp'),
    'http://127.0.0.1:3000/mcp',
  );
  assert.equal(
    normalizeSecureHttpUrl('http://[::1]:3000/mcp'),
    'http://[::1]:3000/mcp',
  );
  assert.throws(
    () => normalizeSecureHttpUrl('http://example.com/mcp'),
    /必须使用 HTTPS/,
  );
});

test('service URLs reject embedded credentials and invalid loopback lookalikes', () => {
  assert.throws(
    () => normalizeSecureHttpUrl('https://user:secret@example.com/mcp'),
    /不能包含用户名或密码/,
  );
  assert.equal(isLoopbackHostname('localhost.evil.example'), false);
  assert.throws(
    () => normalizeSecureHttpUrl('http://localhost.evil.example/mcp'),
    /必须使用 HTTPS/,
  );
});
