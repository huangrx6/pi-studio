const assert = require('node:assert/strict');
const test = require('node:test');

const extensionUrl = new URL(
  '../../extensions/pi-quota-status/extension.mjs',
  `file://${__filename}`,
);
const adaptersUrl = new URL(
  '../../extensions/pi-quota-status/quota/adapters.mjs',
  `file://${__filename}`,
);
const monitorUrl = new URL(
  '../../extensions/pi-quota-status/quota/monitor.mjs',
  `file://${__filename}`,
);

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function credential(key = 'test-key') {
  return {
    async read() {
      return { type: 'api_key', apiKey: key };
    },
  };
}

function textOf(content) {
  return JSON.stringify(content);
}

test('quota adapters map supported provider aliases to one fixed endpoint', async () => {
  const { adapterForProvider, adapterMatchesBaseUrl } = await import(adaptersUrl.href);
  assert.equal(adapterForProvider('opencode-go').display, 'OpenCode Go');
  assert.equal(adapterForProvider('zai-coding-cn').display, 'GLM Coding Plan');
  assert.equal(adapterForProvider('zhipu').display, 'GLM Coding Plan');
  assert.equal(adapterForProvider('zhipuai').display, 'GLM Coding Plan');
  assert.equal(adapterForProvider('minimax-cn').display, 'MiniMax Token Plan');
  assert.equal(adapterForProvider('kimi-coding').display, 'Kimi Code');
  assert.equal(adapterForProvider('moonshot-cn').display, 'Kimi API');
  assert.equal(adapterForProvider('siliconflow-cn').display, 'SiliconFlow');
  assert.equal(adapterForProvider('unknown-provider'), undefined);
  assert.equal(
    adapterMatchesBaseUrl(
      adapterForProvider('deepseek'),
      'https://api.deepseek.com/v1',
    ),
    true,
  );
  assert.equal(
    adapterMatchesBaseUrl(
      adapterForProvider('deepseek'),
      'https://proxy.example/v1',
    ),
    false,
  );
  assert.equal(
    adapterMatchesBaseUrl(
      adapterForProvider('minimax'),
      'http://www.minimaxi.com/v1',
    ),
    false,
  );
});

test('quota extension routes the current model provider and reads credentials by exact id', async (t) => {
  const originalFetch = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async () => jsonResponse({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '12.34',
    }],
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const extension = await import(`${extensionUrl.href}?provider-routing`);
  const activated = await extension.activate({
    providerCredentials: {
      async read(providerId) {
        reads.push(providerId);
        return {
          providerId,
          type: 'api_key',
          apiKey: 'deepseek-key',
        };
      },
    },
  });
  t.after(() => activated.cleanup());

  const content = await activated.dataSources.live.read({
    model: { modelRef: 'deepseek/deepseek-chat' },
  });
  assert.deepEqual(reads, ['deepseek']);
  assert.match(textOf(content), /12\.34/);
  assert.doesNotMatch(textOf(content), /DeepSeek API|refresh-quota/);

  const zhipu = await activated.dataSources.live.read({
    model: { modelRef: 'zhipu/glm-5.3-flash' },
  });
  assert.doesNotMatch(textOf(zhipu), /当前来源没有额度适配器/);
  const summary = await activated.dataSources.summary.read({
    model: { modelRef: 'zhipu/glm-5.3-flash' },
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].kind, 'text');

  const unsupported = await activated.dataSources.live.read({
    model: { modelRef: 'unknown/model' },
  });
  assert.match(textOf(unsupported), /当前来源没有额度适配器/);
});

test('quota monitor maps authentication, rate and server failures without stale data', async (t) => {
  const { createMonitor } = await import(`${monitorUrl.href}?errors`);
  const baseAdapter = {
    display: 'Test Plan',
    category: '套餐用量',
    endpoint: 'https://quota.example.test/usage',
    note: 'fixture',
  };
  const cases = [
    ['HTTP 401', /Key 无效或已过期/],
    ['HTTP 403', /Key 无权限或产品不匹配/],
    ['HTTP 429', /请求过于频繁/],
    ['HTTP 503', /服务暂不可用/],
    [Object.assign(new Error('Request timed out'), { name: 'TimeoutError' }), /请求超时/],
    [new Error('百分比超出 0–100 范围'), /百分比超出/],
  ];
  for (const [failure, expected] of cases) {
    const monitor = createMonitor({
      provider: 'fixture',
      adapter: {
        ...baseAdapter,
        async fetch() {
          throw failure;
        },
      },
      credentials: credential(),
    });
    await monitor.refresh({});
    assert.match(monitor.state.errorText, expected);
    assert.equal(monitor.state.quotaData, null);
    assert.equal(monitor.state.loading, false);
    monitor.dispose();
  }
});

test('quota monitor shares one refresh across detail and footer consumers', async (t) => {
  const { createMonitor } = await import(`${monitorUrl.href}?concurrency`);
  let credentialReads = 0;
  let fetchCalls = 0;
  let resolveFetch;
  const monitor = createMonitor({
    provider: 'fixture',
    adapter: {
      display: 'Test Plan',
      category: '套餐用量',
      endpoint: 'https://quota.example.test/usage',
      note: 'fixture',
      fetch() {
        fetchCalls += 1;
        return new Promise((resolve) => {
          resolveFetch = () => resolve([{
            kind: 'percentage',
            label: '5 小时',
            percent: 42,
            resetsInMs: 60_000,
          }]);
        });
      },
    },
    credentials: {
      async read() {
        credentialReads += 1;
        return { type: 'api_key', apiKey: 'shared-key' };
      },
    },
  });
  t.after(() => monitor.dispose());

  const detailAbort = new AbortController();
  const footerAbort = new AbortController();
  const first = monitor.refresh({ sessionId: 'detail', signal: detailAbort.signal });
  const second = monitor.refresh({ sessionId: 'footer', signal: footerAbort.signal });
  while (!resolveFetch) await Promise.resolve();
  detailAbort.abort();
  resolveFetch();
  await Promise.all([first, second]);

  assert.equal(credentialReads, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(monitor.state.loading, false);
  assert.equal(monitor.state.errorText, '');
  assert.equal(monitor.state.quotaData.bars[0].percent, 42);

  await monitor.refresh({ sessionId: 'third' });
  assert.equal(fetchCalls, 1);
});

test('quota monitor refuses to query an account from a mismatched custom base URL', async (t) => {
  const { createMonitor } = await import(`${monitorUrl.href}?endpoint-guard`);
  let calls = 0;
  const monitor = createMonitor({
    provider: 'deepseek',
    adapter: {
      display: 'DeepSeek API',
      category: '账户余额',
      endpoint: 'https://api.deepseek.com/user/balance',
      endpointHosts: ['api.deepseek.com'],
      note: 'fixture',
      async fetch() {
        calls += 1;
        return [];
      },
    },
    credentials: {
      async read() {
        return {
          type: 'api_key',
          apiKey: 'key',
          baseUrl: 'https://proxy.example/v1',
        };
      },
    },
  });
  t.after(() => monitor.dispose());

  await monitor.refresh({});
  assert.equal(calls, 0);
  assert.match(monitor.state.errorText, /模型来源地址.*不匹配/);
});

test('quota subscriptions release timers and stale session context', async (t) => {
  const { createMonitor } = await import(`${monitorUrl.href}?cleanup`);
  const monitor = createMonitor({
    provider: 'fixture',
    adapter: {
      display: 'Test Plan',
      category: '套餐用量',
      endpoint: 'https://quota.example.test/usage',
      note: 'fixture',
      async fetch() {
        return [{
          kind: 'percentage',
          label: '5 小时',
          percent: 10,
        }];
      },
    },
    credentials: credential(),
  });
  t.after(() => monitor.dispose());

  const unsubscribe = monitor.subscribe(
    { sessionId: 'session-a' },
    () => {},
  );
  assert.equal(monitor.lastContext.sessionId, 'session-a');
  unsubscribe();
  assert.equal(monitor.lastContext, undefined);
  assert.equal(monitor.state.loading, false);
});
