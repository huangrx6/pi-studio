const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeProviderQuota, previewQuota, quotaFieldPaths } = require('../../electron/main/core/provider-quota.cjs');
const { createProviderQuotaMonitor } = require('../../electron/main/services/provider-quota.cjs');
const { quotaExampleInput } = require('../../web/src/features/models/quota-example.ts');

const field = (label, path, format = 'number', options = {}) => ({ label, path, format, unit: '', translations: '', ...options });
const config = (fields = [field('余额', 'data.balance', 'number', { unit: '元' })]) =>
  ({ enabled: true, endpoint: 'https://quota.example.test/accounts?period=weekly', auth: 'bearer', fields });
const provider = () => ({ id: 'custom', enabled: true, baseUrl: 'https://models.example.test/v1', quota: config() });
const key = 'synthetic-private-key';
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (body, status = 200) => Response.json(body, { status });

test('quota auth modes reach an HTTP endpoint with the intended header or encoded query parameter', async t => {
  const { createServer } = require('node:http');
  const { once } = require('node:events');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: new URL(req.url, 'http://localhost'), headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { balance: 42 } }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const current = provider();
  const credential = 'synthetic +&=?/#%key';
  const monitor = createProviderQuotaMonitor({ getProvider: () => current, readKey: () => credential });
  const cases = [
    ['none'], ['bearer', 'authorization', `Bearer ${credential}`],
    ['authorization', 'authorization', credential], ['x-api-key', 'x-api-key', credential],
    ['api-key', 'api-key', credential], ['x-goog-api-key', 'x-goog-api-key', credential],
    ['custom-header', 'ocp-apim-subscription-key', credential], ['query'],
  ];
  for (const [auth, header, value] of cases) {
    current.quota = normalizeProviderQuota({ ...config(), auth,
      endpoint: `http://127.0.0.1:${server.address().port}/quota?period=weekly`,
      authName: auth === 'query' ? 'key' : 'Ocp-Apim-Subscription-Key',
      headers: [{ name: 'anthropic-version', value: '2023-06-01' }],
    });
    const result = await monitor.read('custom', true);
    assert.equal(result.status, 'ready', auth);
    assert.equal(result.metrics[0].value, '42 元');
    const request = requests.at(-1);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    if (header) assert.equal(request.headers[header], value);
    else assert.equal(request.headers.authorization, undefined);
    assert.equal(request.url.searchParams.get('period'), 'weekly');
    assert.equal(request.url.searchParams.get('key'), auth === 'query' ? credential : null);
    assert.ok(!JSON.stringify(current.quota).includes(credential));
    const paths = await monitor.inspect('custom', current.quota);
    assert.deepEqual(paths.map(item => item.path), ['data.balance']);
  }
});

test('auth configuration rejects request injection, credential headers and query collisions', () => {
  for (const authName of ['', 'bad\r\nInjected', 'Host', 'Cookie', 'Proxy-Authorization', 'Content-Type', 'sec-fetch-site']) {
    assert.throws(() => normalizeProviderQuota({ ...config(), auth: 'custom-header', authName }));
  }
  for (const authName of ['key&secret', 'key=value', '', 'key\n']) {
    assert.throws(() => normalizeProviderQuota({ ...config(), auth: 'query', authName }));
  }
  assert.throws(() => normalizeProviderQuota({ ...config(), auth: 'query', authName: 'period' }), /同名/);
  for (const headers of [
    [{ name: 'Authorization', value: key }], [{ name: 'cookie', value: key }],
    [{ name: 'anthropic-version', value: '2023-06-01\nInjected: key' }],
    [{ name: 'OpenAI-Project', value: 'one' }, { name: 'openai-project', value: 'two' }],
  ]) assert.throws(() => normalizeProviderQuota({ ...config(), headers }));
  assert.throws(() => normalizeProviderQuota({ ...config(), auth: 'custom-header', authName: 'New-Api-User', headers: [{ name: 'new-api-user', value: '123' }] }));
});

test('HTTP 200 quota authentication failures clear cached values without exposing response secrets', async () => {
  const current = provider();
  current.quota.auth = 'authorization';
  let body = { data: { balance: 8 } };
  const monitor = createProviderQuotaMonitor({ getProvider: () => current, readKey: () => key, fetcher: async () => json(body) });
  assert.equal((await monitor.read('custom')).status, 'ready');
  for (const code of [401, '403', 1000, 500]) {
    body = { success: false, code, msg: key, data: { balance: 100 } };
    const result = await monitor.read('custom', true);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.metrics, []);
    assert.ok(!JSON.stringify(result).includes(key));
    await assert.rejects(monitor.inspect('custom', current.quota), error => !error.message.includes(key));
  }
});

test('a window shared by different allowance types can be addressed by type and period in either order', () => {
  const limits = [
    { type: 'requests', unit: 6, remaining: 0 },
    { type: 'tokens', unit: 3, remaining: 19 },
    { type: 'tokens', unit: 6, remaining: 42 },
  ];
  const fields = [field('本周剩余 Token', 'limits[type=tokens&unit=6].remaining')];
  for (const items of [limits, [...limits].reverse()]) {
    assert.equal(previewQuota({ fields, sample: JSON.stringify({ limits: items }) })[0].value, '42');
  }
});

test('quota examples use the JSON preview contract and format every configured metric', () => {
  const fields = [
    field('5 小时已用', 'data.limits[unit=3&number=5].percentage', 'percent'),
    field('本周已用', 'data.limits[unit=6&number=1].percentage', 'percent'),
    field('本月已用', 'usage.monthly.percent', 'percent'),
    field('5 小时重置时间', 'usage.rolling.resetsAt', 'time'),
    field('本周重置时间', 'usage.weekly.resetsAt', 'time'),
    field('本月重置时间', 'usage.monthly.resetsAt', 'time'),
    field('次数', 'windows[period=week].remaining', 'number', { unit: '次' }),
    field('小时用量', 'daily[0].used', 'fraction'),
    field('状态', 'plan.state', 'enum', { translations: 'active=可用\noff=暂停' }),
  ];
  const input = quotaExampleInput(fields);
  assert.equal(typeof input.sample, 'string');
  const metrics = previewQuota(input);
  assert.deepEqual(metrics.map(metric => metric.label), fields.map(item => item.label));
  assert.deepEqual(metrics.filter(metric => metric.summary).map(metric => metric.label), ['5 小时已用', '本周已用']);
  assert.ok(metrics.every(metric => metric.value !== null && !metric.issue));
  for (const i of [0, 1, 2, 7]) {
    assert.ok(metrics[i].percent > 0 && metrics[i].percent < 100);
    assert.match(metrics[i].value, /%$/);
  }
  for (const i of [3, 4, 5]) assert.match(metrics[i].value, /\d{4}.*\d{2}:\d{2}/);
  assert.match(metrics[6].value, / 次$/);
  assert.equal(metrics[8].value, '可用');
  const sample = JSON.stringify({ data: { limits: [
    { unit: 6, number: 1, percentage: 73 }, { unit: 3, number: 5, percentage: 9 },
  ] } });
  assert.deepEqual(previewQuota({ fields: fields.slice(0, 2), sample }).map(metric => metric.value), ['9%', '73%']);
  const unrelated = previewQuota({ fields, sample: '{"usage":{"week":{"remaining":120}}}' });
  assert.ok(unrelated.every(metric => metric.value === null && metric.issue === '未返回此字段'));
});

test('configurable quota windows, array selectors, units, translations and timestamps project the same way in previews', () => {
  const fields = [
    field('5 小时已用', 'windows[period=five_hours].used', 'fraction'),
    field('本周剩余', 'windows[period=week].remaining', 'percent', { summary: false }),
    field('次数', 'daily[0].remaining', 'number', { unit: '次' }),
    field('套餐状态', 'state', 'enum', { translations: 'active=可用\nexhausted=已用尽', summary: true }),
    field('可用', 'available', 'enum', { translations: 'false=不可用' }),
    field('下次重置', 'reset', 'time'), field('本月', 'windows[period=month].used'),
  ];
  const sample = JSON.stringify({ state: 'active', available: false, reset: '2026-11-16T08:00:00Z', daily: [{ remaining: '0' }],
    windows: [{ period: 'week', remaining: '23.5' }, { period: 'five_hours', used: 0.125 }] });
  const metrics = previewQuota({ fields, sample });
  assert.deepEqual(metrics.filter(item => item.summary).map(item => item.label), ['5 小时已用', '套餐状态']);
  assert.deepEqual(metrics.map(item => item.value).slice(0, 5), ['12.5%', '23.5%', '0 次', '可用', '不可用']);
  assert.equal(metrics[0].percent, 12.5); assert.match(metrics[5].value, /2026/);
  assert.equal(metrics[6].value, null); assert.match(metrics[6].issue, /未返回/);
  for (const raw of [null, '', false, 'not numeric', {}]) {
    assert.equal(previewQuota({ fields: [field('读数', 'v')], sample: JSON.stringify({ v: raw }) })[0].value, null);
  }
  assert.match(previewQuota({ fields: [field('短期', '[0]', 'percent')], sample: '[101]' })[0].issue, /范围/);
});

test('validation rejects unsafe paths, invalid and duplicate translations, oversized samples, credential-bearing URLs and remote HTTP', () => {
  for (const path of ['__proto__.key', 'items[constructor=x]', 'one..two', 'one[0]bad', 'a()', 'a[x]']) {
    assert.throws(() => normalizeProviderQuota(config([field('测试', path)])), /路径/);
  }
  for (const endpoint of ['file:///tmp/test', 'http://remote.test', 'https://key@quota.test/path', 'https://quota.test/path?api_key=secret']) {
    assert.throws(() => normalizeProviderQuota({ ...config(), endpoint }));
  }
  assert.doesNotThrow(() => normalizeProviderQuota({ ...config(), endpoint: 'http://127.0.0.1:8731/test' }));
  assert.doesNotThrow(() => normalizeProviderQuota({ ...config(), endpoint: 'https://quota.test/usage?token_type=output&groupByKey=week' }));
  assert.throws(() => normalizeProviderQuota(config([field('状态', 'v', 'enum', { translations: 'on=启用\non=有效' })])));
  assert.throws(() => previewQuota({ fields: config().fields, sample: 'x'.repeat(70000) }), /64 KB/);
  assert.throws(() => previewQuota({ fields: config().fields, sample: '{' }), /JSON/);
  assert.throws(() => normalizeProviderQuota(config(['a', 'b', 'c'].map(s => field(s, s, 'number', { summary: true })))), /最多显示两个/);
  const paths = quotaFieldPaths({ data: { balance: 0, usage_tokens: 1, keyState: 'enabled' }, apiKey: key, nested: [{ limit: 12 }] });
  assert.deepEqual(paths.map(s => s.path), ['data.balance', 'data.usage_tokens', 'data.keyState', 'nested[0].limit']);
  assert.ok(!JSON.stringify(paths).includes('enabled'));
});

test('monitor shares in-flight requests by source, caches, recovers, and clears stale balances on authentication failures', async () => {
  let now = 1_000; let count = 0; let respond; let current = provider();
  const monitor = createProviderQuotaMonitor({ getProvider: id => id === 'custom' ? current : undefined, clock: () => now,
    readKey: async id => { assert.equal(id, 'custom'); return key; },
    fetcher: (url, request) => {
      assert.equal(url, current.quota.endpoint); assert.equal(request.headers.Authorization, 'Bearer ' + key);
      assert.equal(request.redirect, 'error'); assert.equal(request.method, 'GET');
      count++; return new Promise(resolve => { respond = resolve; });
    },
  });
  const calls = [monitor.read('custom'), monitor.read('custom', true)];
  await tick(); assert.equal(count, 1); respond(json({ data: { balance: 0 }, echo: key }));
  const [a, b] = await Promise.all(calls); assert.deepEqual(a, b); assert.equal(a.metrics[0].value, '0 元');
  assert.ok(!JSON.stringify(a).includes(key)); assert.deepEqual(await monitor.read('custom'), a); assert.equal(count, 1);
  now += 61_000;
  let result = monitor.read('custom'); await tick(); respond(json({ raw: key }, 503));
  const stale = await result; assert.equal(stale.status, 'stale'); assert.equal(stale.updatedAt, a.updatedAt);
  result = monitor.read('custom', true); await tick(); respond(json({ raw: key }, 401));
  const denied = await result; assert.equal(denied.status, 'error'); assert.deepEqual(denied.metrics, []); assert.doesNotMatch(JSON.stringify(denied), new RegExp(key));
  result = monitor.read('custom', true); await tick(); respond(json({ data: { balance: 8 } }));
  assert.equal((await result).metrics[0].value, '8 元');
  result = monitor.read('custom', true); await tick(); current.enabled = false; monitor.invalidate('custom'); respond(json({ data: { balance: 99 } }));
  assert.equal((await result).status, 'disabled'); assert.equal((await monitor.read('custom')).status, 'disabled');
  assert.equal((await monitor.read('other')).status, 'disabled');
});

test('quota inspection returns field names, respects credential destinations, and handles anonymous and x-api-key endpoints', async () => {
  let current = provider(); let keys = 0; const requests = [];
  const monitor = createProviderQuotaMonitor({ getProvider: () => current, readKey: async () => { keys++; return key; },
    fetcher: async (url, request) => {
      requests.push({ url, headers: request.headers });
      return json({ usage: { hour: 3, week: 7, api_key: key }, status: key });
    },
  });
  let draft = { endpoint: 'https://other.example.test/quota', auth: 'bearer' };
  await assert.rejects(monitor.inspect('custom', draft), /新域名/);
  assert.equal(keys, 0); assert.equal(requests.length, 0);
  const paths = await monitor.inspect('custom', { ...draft, auth: 'none' });
  assert.equal(keys, 0); assert.deepEqual(Object.keys(requests[0].headers), ['Accept']);
  assert.deepEqual(paths.map(p => p.path), ['usage.hour', 'usage.week', 'status']);
  assert.ok(!JSON.stringify(paths).includes(key));
  await monitor.inspect('custom', { ...draft, auth: 'x-api-key', apiKey: 'entered' });
  assert.equal(keys, 0); assert.equal(requests.at(-1).headers['x-api-key'], 'entered');
  await monitor.inspect('custom', { ...draft, endpoint: current.quota.endpoint }); assert.equal(keys, 1);
  current.quota = { ...config([field('已用', 'usage.week')]), endpoint: draft.endpoint, auth: 'x-api-key' };
  const live = await monitor.read('custom'); assert.equal(live.metrics[0].value, '7');
  assert.equal(requests.at(-1).headers['x-api-key'], key);
  current.quota.enabled = false;
  const count = requests.length; assert.equal((await monitor.read('custom')).status, 'disabled'); assert.equal(requests.length, count);
});

test('incomplete metrics stay distinct from zero and invalid or oversized responses never leak their bodies', async () => {
  const current = provider(); let response;
  const monitor = createProviderQuotaMonitor({ getProvider: () => current, readKey: async () => key, fetcher: async () => response });
  response = json({ data: { balance: key } });
  let result = await monitor.read('custom'); assert.equal(result.status, 'unmapped'); assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  for (const body of ['<html>' + key, 'x'.repeat(520 * 1024)]) {
    response = new Response(body);
    result = await monitor.read('custom', true);
    assert.equal(result.status, 'error'); assert.ok(result.message); assert.doesNotMatch(result.message, new RegExp(key));
  }
});

test('disabling the extension suppresses in-flight balances, cached reads and credential inspection', async () => {
  let available = true;
  let requests = 0;
  let finish;
  const monitor = createProviderQuotaMonitor({
    getProvider: provider,
    readKey: () => key,
    isAvailable: () => available,
    fetcher: () => { requests++; return new Promise(resolve => { finish = resolve; }); },
  });
  const pending = monitor.read('custom');
  await tick();
  available = false;
  finish(json({ data: { balance: 31.86 } }));
  const disabled = { status: 'disabled', metrics: [] };
  assert.deepEqual(await pending, disabled);
  assert.deepEqual(await monitor.read('custom'), disabled);
  assert.throws(() => monitor.inspect('custom', config()), /启用额度状态扩展/);
  assert.equal(requests, 1);
});
