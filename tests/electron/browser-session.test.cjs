const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const electronPath = require.resolve('electron');
const original = Module._cache[electronPath];
Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    session: {
      fromPartition: () => ({
        webRequest: { onBeforeRequest() {} },
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      }),
    },
  },
};

test.after(() => {
  if (original) Module._cache[electronPath] = original;
  else delete Module._cache[electronPath];
});

const { isAllowedRequest } = require('../../electron/main/services/browser/session.cjs');

test('allows http(s) and about:blank, refuses odd schemes', () => {
  assert.equal(isAllowedRequest('https://example.com', 'mainFrame', 1), true);
  assert.equal(isAllowedRequest('http://localhost:3000', 'mainFrame', 1), true);
  assert.equal(isAllowedRequest('about:blank', 'mainFrame', 1), true);
  assert.equal(isAllowedRequest('javascript:alert(1)', 'mainFrame', 1), false);
  assert.equal(isAllowedRequest('file:///etc/passwd', 'mainFrame', 1), false);
});
