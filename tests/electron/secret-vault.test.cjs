const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
const {
  expandSecretReferences,
  redactSecretValues,
  secretReferences,
  createSecretRedactor,
} = require('../../electron/core/secret-vault.cjs');
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-secret-vault-'));
installElectronSafeStorage(test);

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('redaction handles short values, keys, overlapping values and split output chunks', () => {
  const secrets = { SHORT: 'ab', LONG: 'abc.def[ghi]', TOKEN: 'TOKEN' };
  const redactor = createSecretRedactor(secrets);
  const result = redactor.push('prefix abc.') + redactor.push('def[ghi] and ab') + redactor.push('', true);
  assert.equal(result, 'prefix {{secret:LONG}} and {{secret:SHORT}}');
  assert.deepEqual(redactor.redact({ ab: 'TOKEN {{secret:TOKEN}}' }), {
    '{{secret:SHORT}}': '{{secret:TOKEN}} {{secret:TOKEN}}',
  });
  assert.deepEqual(secretReferences(undefined), []);
});

test('secret placeholders expand only in tool arguments and redact exact values', () => {
  const input = {
    command: 'curl -H "Authorization: Bearer {{secret:TEST_TOKEN}}"',
    nested: ['prefix {{secret:TEST_TOKEN}} suffix'],
  };
  assert.deepEqual(secretReferences(input), ['TEST_TOKEN']);
  const expanded = expandSecretReferences(input, { TEST_TOKEN: 'secret-value-123' });
  assert.equal(expanded.names[0], 'TEST_TOKEN');
  assert.match(expanded.value.command, /secret-value-123/);
  assert.doesNotMatch(expanded.value.command, /\{\{secret:/);
  assert.deepEqual(redactSecretValues(expanded.value, {
    TEST_TOKEN: 'secret-value-123',
  }), input);
});

test('missing placeholders fail closed without exposing sibling secrets', () => {
  assert.throws(
    () => expandSecretReferences({ command: '{{secret:MISSING}}' }, {}),
    /未找到测试凭据：MISSING/,
  );
});

test('Studio database encrypts secret values and OAuth state at rest', () => {
  const database = createStudioDatabase(path.join(temporary, 'studio.sqlite'));
  try {
    database.writeSecretValue('TEST_TOKEN', 'secret-value-123');
    database.writeMcpOAuthState('https://mcp.example.test', {
      serverUrl: 'https://mcp.example.test',
      tokens: { access_token: 'oauth-access', token_type: 'Bearer' },
    });
    assert.deepEqual(database.readSecretValues(), {
      TEST_TOKEN: 'secret-value-123',
    });
    assert.equal(
      database.readMcpOAuthState('https://mcp.example.test').tokens.access_token,
      'oauth-access',
    );
    const secretRow = database.db.prepare(
      'SELECT value FROM secret_values WHERE name = ?',
    ).get('TEST_TOKEN');
    const oauthRow = database.db.prepare(
      'SELECT value FROM mcp_oauth_states WHERE server_url = ?',
    ).get('https://mcp.example.test');
    assert.doesNotMatch(secretRow.value, /secret-value-123/);
    assert.doesNotMatch(oauthRow.value, /oauth-access/);
  } finally {
    database.close();
  }
});
