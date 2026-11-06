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

test('persisted OAuth tokens survive synchronous and asynchronous cleanup failures', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../../electron/integrations/mcp/oauth.cjs'), 'utf8')
    .replaceAll("await import('@earendil-works/pi-mcp/oauth')", 'await loadOAuth()')
    .replaceAll("await import('@earendil-works/pi-mcp')", 'await loadMcp()');
  const cleanup = [], opened = [], module = { exports: {} };
  let provider;
  const oauth = {
    OAuthCallbackServer: { listen: async () => ({
      redirectUrl: 'http://127.0.0.1/synthetic-callback',
      waitForCallback: async () => ({ code: 'synthetic-code' }),
      close() { cleanup.push('callback'); throw new Error('synthetic synchronous cleanup failure'); },
    }) },
    McpOAuthProvider: class {
      constructor(options) { this.options = options; provider = this; }
      async state() { return 'synthetic-state'; }
    },
    adaptOAuthProvider: value => value,
    authorizeMcp: async (current, options) => {
      assert.equal(options.authorizationCode, 'synthetic-code');
      current.options.store.save({ serverUrl: options.serverUrl, tokens: { access_token: 'synthetic-committed-token', token_type: 'Bearer' } });
      return 'AUTHORIZED';
    },
  };
  const mcp = {
    McpClient: class {
      async connect() { provider.options.onRedirect(new URL('https://mcp.example.test/synthetic-authorize')); }
      async close() { cleanup.push('client'); throw new Error('synthetic asynchronous cleanup failure'); }
    },
    StreamableHttpTransport: class {
      close() { cleanup.push('transport'); throw new Error('synthetic synchronous cleanup failure'); }
    },
  };
  vm.runInNewContext(source, {
    module, exports: module.exports, URL,
    loadOAuth: async () => oauth, loadMcp: async () => mcp,
    require(id) {
      if (id === '../../core/studio-db.cjs') return require('../../electron/core/studio-db.cjs');
      if (id === 'electron') return { app: { getVersion: () => '0.0.0-test' } };
      throw new Error(`Unexpected test dependency ${id}`);
    },
  });
  const url = 'https://mcp.example.test/cleanup-fixture';
  const result = await module.exports.authorizeMcpServer({ transport: 'http', url }, async target => opened.push(target));
  assert.equal(result.ok, true); assert.equal(opened.length, 1);
  assert.deepEqual(cleanup.sort(), ['callback', 'client', 'transport']);
  assert.equal(stateStore(url).load().tokens.access_token, 'synthetic-committed-token');
  clearMcpOAuth(url);
});
