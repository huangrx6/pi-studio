const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  isTrustedRendererUrl,
  rendererContentSecurityPolicy,
} = require('../../electron/core/web-security.cjs');

test('production renderer CSP enables only the capabilities Pi Studio uses', () => {
  const policy = rendererContentSecurityPolicy();
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /img-src [^;]*pi-media:[^;]*https:[^;]*http:/);
});

test('renderer navigation is limited to the app URL', () => {
  const productionUrl = pathToFileURL('/Applications/Pi Studio.app/web-dist/index.html').href;
  assert.equal(isTrustedRendererUrl(productionUrl, { productionUrl }), true);
  assert.equal(isTrustedRendererUrl('https://example.com', { productionUrl }), false);
  assert.equal(isTrustedRendererUrl(`${productionUrl}?x=1`, { productionUrl }), false);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5180/settings', {
    dev: true,
    devUrl: 'http://127.0.0.1:5180/',
  }), true);
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:9999/', {
    dev: true,
    devUrl: 'http://127.0.0.1:5180/',
  }), false);
});
