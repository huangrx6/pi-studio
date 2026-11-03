const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-mcp-oauth-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
installElectronSafeStorage(test);

const {
  clearMcpOAuth,
  expandOAuthHeaders,
  stateStore,
} = require('../../electron/integrations/mcp/index.cjs');
const { closeStudioDatabase } = require('../../electron/core/studio-db.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('OAuth MCP headers expand explicit environment references', () => {
  const previous = process.env.PI_STUDIO_OAUTH_TEST_TOKEN;
  process.env.PI_STUDIO_OAUTH_TEST_TOKEN = 'oauth-header-value';
  try {
    assert.deepEqual(expandOAuthHeaders({
      Authorization: 'Bearer ${PI_STUDIO_OAUTH_TEST_TOKEN}',
      'X-Static': 'unchanged',
    }), {
      Authorization: 'Bearer oauth-header-value',
      'X-Static': 'unchanged',
    });
  } finally {
    if (previous === undefined) delete process.env.PI_STUDIO_OAUTH_TEST_TOKEN;
    else process.env.PI_STUDIO_OAUTH_TEST_TOKEN = previous;
  }
});

test('OAuth MCP headers fail before transport creation when an environment reference is missing', () => {
  delete process.env.PI_STUDIO_OAUTH_MISSING_TOKEN;
  assert.throws(
    () => expandOAuthHeaders({
      Authorization: 'Bearer ${PI_STUDIO_OAUTH_MISSING_TOKEN}',
    }),
    /Header Authorization.*PI_STUDIO_OAUTH_MISSING_TOKEN.*未设置/,
  );
});

test('OAuth state survives a database reopen and logout removes it', () => {
  const serverUrl = 'https://mcp.example.test/oauth';
  const state = {
    serverUrl,
    tokens: {
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      token_type: 'Bearer',
    },
  };
  stateStore(serverUrl).save(state);
  assert.deepEqual(stateStore(serverUrl).load(), state);

  closeStudioDatabase();
  assert.deepEqual(stateStore(serverUrl).load(), state);

  clearMcpOAuth(serverUrl);
  assert.equal(stateStore(serverUrl).load(), undefined);
});
