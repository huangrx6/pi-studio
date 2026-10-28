/**
 * electron/credential-env.cjs 的单元测试。
 *
 * 被测模块：electron/credential-env.cjs
 * 覆盖：环境变量引用规范化、login shell 输出解析、从 Finder 启动时补齐凭据、
 *       保存 API Key 前的校验，以及旧 auth.json 迁移后能被真实 Pi SDK 解析。
 *
 * 运行方式：
 *   pnpm test                                      # 跑 scripts/ 下全部单测
 *   node --test scripts/credential-env.test.cjs    # 只跑本文件
 *
 * 依赖：node:test / node:assert（Node 20+ 内置）、node:fs / os / path，
 *      以及 @earendil-works/pi-coding-agent（最后一个用例做 SDK 集成验证，
 *      只在临时目录写 auth.json / models.json，不访问网络）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  envNameOf,
  normalizeKey,
  normalizeAuth,
  parseShellEnvironment,
  loadCredentialEnvironment,
  prepareKey,
} = require('../electron/credential-env.cjs');

// 用户可能把 API Key 填成裸变量名、$NAME 或 ${NAME}：三种写法都应指向同一个
// 环境变量。真正的密钥值（含大小写字母和短横线）必须原样保留，不能被误判成
// 变量名；envNameOf 只把「已存在于 env 或 _API_KEY/_KEY/_TOKEN/_SECRET 结尾
// 的全大写名称」当作旧式裸变量名，命令替换 $(...) 则不是合法引用。
test('literal secrets stay literal; bare names and explicit references normalize', () => {
  for (const value of ['ZAI_CODING_CN_API_KEY', '$ZAI_CODING_CN_API_KEY', '${ZAI_CODING_CN_API_KEY}']) {
    assert.equal(normalizeKey(value, {}), '$ZAI_CODING_CN_API_KEY');
  }
  assert.equal(normalizeKey('sk-example-secret', {}), 'sk-example-secret');
  assert.equal(normalizeKey('ABC123SECRET', {}), 'ABC123SECRET');
  assert.equal(envNameOf('CUSTOM_CREDENTIAL', { CUSTOM_CREDENTIAL: 'test' }), 'CUSTOM_CREDENTIAL');
  assert.equal(envNameOf('$(echo test)', {}), undefined);
});

// login shell 会先输出 .zshrc 等的启动文本，所以解析必须从 NUL 标记之后开始，
// 标记之前的 KEY=VALUE 一律忽略（例如用户 shell 里同名但无关的变量）。
// 变量值本身允许包含 '=' 和换行；完全没有标记的输出说明调用失败，应返回空对象。
test('shell output is parsed after its marker, including equals and newlines in values', () => {
  const env = parseShellEnvironment('startup text\nWRONG_KEY=ignored\0\0PI_STUDIO_CREDENTIAL_ENV\0EXAMPLE_KEY=a=b\nvalue\0PATH=/bin\0');
  assert.equal(env.WRONG_KEY, undefined);
  assert.equal(env.EXAMPLE_KEY, 'a=b\nvalue');
  assert.deepEqual(Object.keys(parseShellEnvironment('EXAMPLE_KEY=not-framed')), []);
});

// Finder / Dock 启动的 GUI 进程拿不到 shell 里 export 的变量。本用例模拟这种
// “空环境”：loadCredentialEnvironment 只补齐调用方请求的凭据变量（EXAMPLE_KEY），
// 不覆盖已有值（EXISTING_KEY 保持 inherited），更不能把 PATH、
// ELECTRON_RUN_AS_NODE 等无关变量导入进程；返回值是仍然缺失的变量名列表。
test('Finder-style empty environment imports only requested credentials', async () => {
  const env = { EXISTING_KEY: 'inherited' };
  const missing = await loadCredentialEnvironment(['$EXAMPLE_KEY', '$EXISTING_KEY', '$ABSENT_KEY'], {
    env,
    platform: 'darwin',
    readShell: async () => ({
      EXAMPLE_KEY: 'shell-test-secret',
      EXISTING_KEY: 'override',
      PATH: '/unwanted',
      ELECTRON_RUN_AS_NODE: '1',
    }),
  });
  assert.deepEqual(env, { EXISTING_KEY: 'inherited', EXAMPLE_KEY: 'shell-test-secret' });
  assert.deepEqual(missing, ['ABSENT_KEY']);
});

// 保存 API Key 前必须确认引用真的能取到值：缺失的环境变量、非法的变量名都拒绝，
// 裸变量名会规范成 $NAME，字面密钥直接通过。错误信息只包含变量名或格式提示，
// 不能把 shell 输出、密钥值写进去，避免泄漏到日志或界面上。
test('saving rejects missing references and shell failures without leaking secret values', async () => {
  const options = {
    env: {},
    platform: 'darwin',
    readShell: async () => { throw new Error('private output'); },
  };
  await assert.rejects(prepareKey('MISSING_API_KEY', options), /无法读取环境变量 MISSING_API_KEY/);
  await assert.rejects(prepareKey('$INVALID-NAME', options), /环境变量格式/);
  assert.equal(await prepareKey('literal-example', options), 'literal-example');
  assert.equal(
    await prepareKey('EXAMPLE_KEY', { ...options, readShell: async () => ({ EXAMPLE_KEY: 'secret' }) }),
    '$EXAMPLE_KEY',
  );
});

// 旧版 auth.json 可能把 api_key 的 key 存成裸变量名。迁移时：
// - api_key 的 key 统一成 $NAME；
// - inline env、OAuth 凭据、'!command' 形式都保持原样（只迁移 api_key.key）；
// - 不修改传入对象；对已迁移结果再次迁移应幂等（可安全重复执行）。
test('credential migration preserves OAuth, inline env, and unrelated metadata', () => {
  const auth = {
    one: {
      type: 'api_key',
      key: 'EXAMPLE_API_KEY',
      env: { EXAMPLE_API_KEY: 'fixture-secret' },
    },
    two: {
      type: 'oauth',
      access: 'fixture',
      refresh: 'fixture-refresh',
      expires: 123,
    },
    three: { type: 'api_key', key: '!read-existing-secret' },
  };
  const result = normalizeAuth(auth, {});
  assert.equal(result.one.key, '$EXAMPLE_API_KEY');
  assert.deepEqual(result.one.env, auth.one.env);
  assert.deepEqual(result.two, auth.two);
  assert.deepEqual(result.three, auth.three);
  assert.equal(auth.one.key, 'EXAMPLE_API_KEY');
  assert.deepEqual(normalizeAuth(result, {}), result);
});

// 集成验证：把迁移后的 auth.json 交给真实 SDK 的 ModelRuntime，确认它会把
// $EXAMPLE_API_KEY 解析成 env 里的实际密钥值，而不是把变量名本身当密钥。
// auth.json / models.json 都放在临时目录，allowModelNetwork: false 表示不联网；
// finally 无论断言成败都清理临时目录。
test('installed Pi SDK resolves migrated credentials to a value, not a variable name', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-test-'));
  try {
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(
      authPath,
      JSON.stringify(normalizeAuth({
        'fixture-provider': {
          type: 'api_key',
          key: 'EXAMPLE_KEY',
          env: { EXAMPLE_KEY: 'fixture-secret-value' },
        },
      }, {})),
    );
    const modelsPath = path.join(dir, 'models.json');
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          'fixture-provider': {
            baseUrl: 'https://example.test/v1',
            api: 'openai-completions',
            models: [{ id: 'fixture-model', name: 'Fixture model' }],
          },
        },
      }),
    );
    const rt = await ModelRuntime.create({
      authPath,
      modelsPath,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const result = await rt.getAuth('fixture-provider');
    assert.equal(result.auth.apiKey, 'fixture-secret-value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
