const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { envNameOf, normalizeKey, normalizeAuth, parseShellEnvironment, loadCredentialEnvironment, prepareKey } = require('../electron/credential-env.cjs');

test('literal secrets stay literal; bare names and explicit references normalize', () => {
  for (const value of ['ZAI_CODING_CN_API_KEY', '$ZAI_CODING_CN_API_KEY', '${ZAI_CODING_CN_API_KEY}']) {
    assert.equal(normalizeKey(value, {}), '$ZAI_CODING_CN_API_KEY');
  }
  assert.equal(normalizeKey('sk-example-secret', {}), 'sk-example-secret');
  assert.equal(normalizeKey('ABC123SECRET', {}), 'ABC123SECRET');
  assert.equal(envNameOf('CUSTOM_CREDENTIAL', { CUSTOM_CREDENTIAL: 'test' }), 'CUSTOM_CREDENTIAL');
  assert.equal(envNameOf('$(echo test)', {}), undefined);
});

test('shell output is parsed after its marker, including equals and newlines in values', () => {
  const env = parseShellEnvironment('startup text\nWRONG_KEY=ignored\0\0PI_STUDIO_CREDENTIAL_ENV\0EXAMPLE_KEY=a=b\nvalue\0PATH=/bin\0');
  assert.equal(env.WRONG_KEY, undefined);
  assert.equal(env.EXAMPLE_KEY, 'a=b\nvalue');
  assert.deepEqual(Object.keys(parseShellEnvironment('EXAMPLE_KEY=not-framed')), []);
});

test('Finder-style empty environment imports only requested credentials', async () => {
  const env = { EXISTING_KEY: 'inherited' };
  const missing = await loadCredentialEnvironment(['$EXAMPLE_KEY', '$EXISTING_KEY', '$ABSENT_KEY'], {
    env, platform: 'darwin', readShell: async () => ({ EXAMPLE_KEY: 'shell-test-secret', EXISTING_KEY: 'override', PATH: '/unwanted', ELECTRON_RUN_AS_NODE: '1' }),
  });
  assert.deepEqual(env, { EXISTING_KEY: 'inherited', EXAMPLE_KEY: 'shell-test-secret' });
  assert.deepEqual(missing, ['ABSENT_KEY']);
});

test('saving rejects missing references and shell failures without leaking secret values', async () => {
  const options = { env: {}, platform: 'darwin', readShell: async () => { throw new Error('private output'); } };
  await assert.rejects(prepareKey('MISSING_API_KEY', options), /无法读取环境变量 MISSING_API_KEY/);
  await assert.rejects(prepareKey('$INVALID-NAME', options), /环境变量格式/);
  assert.equal(await prepareKey('literal-example', options), 'literal-example');
  assert.equal(await prepareKey('EXAMPLE_KEY', { ...options, readShell: async () => ({ EXAMPLE_KEY: 'secret' }) }), '$EXAMPLE_KEY');
});

test('credential migration preserves OAuth, inline env, and unrelated metadata', () => {
  const auth = { one: { type: 'api_key', key: 'EXAMPLE_API_KEY', env: { EXAMPLE_API_KEY: 'fixture-secret' } }, two: { type: 'oauth', access: 'fixture', refresh: 'fixture-refresh', expires: 123 }, three: { type: 'api_key', key: '!read-existing-secret' } };
  const result = normalizeAuth(auth, {});
  assert.equal(result.one.key, '$EXAMPLE_API_KEY');
  assert.deepEqual(result.one.env, auth.one.env);
  assert.deepEqual(result.two, auth.two);
  assert.deepEqual(result.three, auth.three);
  assert.equal(auth.one.key, 'EXAMPLE_API_KEY');
  assert.deepEqual(normalizeAuth(result, {}), result);
});

test('installed Pi SDK resolves migrated credentials to a value, not a variable name', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-test-'));
  try {
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify(normalizeAuth({ 'fixture-provider': { type: 'api_key', key: 'EXAMPLE_API_KEY', env: { EXAMPLE_API_KEY: 'fixture-secret-value' } } }, {})));
    const modelsPath = path.join(dir, 'models.json');
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: { 'fixture-provider': { baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{ id: 'fixture-model', name: 'Fixture model' }] } } }));
    const rt = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    const result = await rt.getAuth('fixture-provider');
    assert.equal(result.auth.apiKey, 'fixture-secret-value');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
