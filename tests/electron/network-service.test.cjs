const assert = require('node:assert/strict');
const test = require('node:test');
const { createNetworkService } = require('../../electron/main/services/network.cjs');
const system = { mode: 'system', proxyUrl: '', bypassRules: '' };
const manual = { mode: 'manual', proxyUrl: 'http://127.0.0.1:7897', bypassRules: '*.local' };
const direct = { ...system, mode: 'direct' };

function fixture(options = {}) {
  let persisted = system;
  const sessions = [], writes = [];
  const service = createNetworkService({
    readSettings: () => persisted,
    writeSettings: settings => { writes.push(settings); persisted = settings; },
    sessionForPartition(partition, options) {
      const session = {
        partition, options, calls: [],
        async setProxy(config) { this.config = config; },
        async forceReloadProxyConfig() { this.reloaded = true; },
        async resolveProxy() { return this.config.mode === 'direct' ? 'DIRECT' : 'PROXY 127.0.0.1:7897'; },
        async fetch(input, init) { this.calls.push({ input, init }); return new Response(this.config.mode); },
      };
      sessions.push(session);
      return session;
    },
    ...options,
  });
  return { service, sessions, writes };
}

test('new requests use saved routes while an old streaming response continues', async () => {
  const { service, sessions } = fixture();
  await service.initialize();
  let stream;
  sessions[0].fetch = async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  const old = await service.fetch('https://provider.test');
  const oldBody = old.text();
  await service.save(manual);
  const controller = new AbortController();
  const response = await service.fetch('https://provider.test', { method: 'POST', body: '{}', signal: controller.signal, headers: { authorization: 'Bearer test-only' } });
  assert.equal(await response.text(), 'fixed_servers');
  assert.equal(sessions[1].calls[0].init.signal, controller.signal);
  assert.equal(sessions[1].calls[0].init.credentials, 'omit');
  stream.enqueue(new TextEncoder().encode('still streaming')); stream.close();
  assert.equal(await oldBody, 'still streaming');
  await service.save(direct);
  assert.equal(await (await service.fetch('https://provider.test')).text(), 'direct');
  await service.save(manual);
  assert.equal(sessions.length, 3, 'existing configurations reuse their immutable session');
});

test('testing and identifying a draft never change the active proxy or saved settings', async () => {
  const { service, sessions, writes } = fixture();
  await service.initialize();
  const result = await service.inspect(manual, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.detectedProxyUrl, 'http://127.0.0.1:7897');
  assert.equal(sessions[1].calls[0].init.headers, undefined);
  assert.equal(sessions[1].calls[0].init.credentials, 'omit');
  assert.deepEqual(await service.snapshot(), system);
  assert.equal(writes.length, 0);
  await service.inspect(system);
  assert.equal(sessions[0].reloaded, true);
  assert.equal(sessions[0].calls.length, 0);
  assert.equal(await (await service.fetch('https://provider.test')).text(), 'system');
});

test('failed preparation or persistence leaves the current route intact and saves can retry', async () => {
  let failWrite = true;
  const { service } = fixture({ writeSettings: () => { if (failWrite) throw new Error('disk failure'); } });
  await service.initialize();
  await assert.rejects(service.save(manual), /disk failure/);
  assert.deepEqual(await service.snapshot(), system);
  assert.equal(await (await service.fetch('https://provider.test')).text(), 'system');
  failWrite = false;
  await service.save(manual);
  assert.deepEqual(await service.snapshot(), manual);

  const broken = fixture({ sessionForPartition: () => ({ setProxy: async () => { throw new Error('cannot prepare'); } }) });
  await assert.rejects(broken.service.save(manual), /cannot prepare/);
  assert.deepEqual(broken.writes, []);
});

test('concurrent writes publish in order without late results reverting the newer route', async () => {
  const { service, writes } = fixture();
  await service.initialize();
  const a = service.save(manual), b = service.save(direct);
  await Promise.all([a, b]);
  assert.deepEqual(writes, [manual, direct]);
  assert.deepEqual(await service.snapshot(), direct);
});

test('connection checks bound stalled proxy resolution and redact errors', async () => {
  const { service, sessions } = fixture({ timeoutMs: 15 });
  await service.initialize();
  sessions[0].resolveProxy = () => new Promise(() => {});
  // Keep the process alive while the service's unref'ed deadline expires.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(service.inspect(system, true), /连接超时/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(sessions[0].calls.length, 0);
  sessions[0].resolveProxy = async () => 'PROXY user:secret@proxy.test:80';
  const result = await service.inspect(system);
  assert.equal(result.detectedProxyUrl, '');
  assert.equal(result.route, '未知代理');
  sessions[0].resolveProxy = async () => 'SOCKS 127.0.0.1:1080';
  const socks4 = await service.inspect(system);
  assert.equal(socks4.detectedProxyUrl, '');
  assert.equal(socks4.route, 'socks4://127.0.0.1:1080');
  sessions[0].resolveProxy = async () => { throw new Error('private URL and credentials'); };
  await assert.rejects(service.inspect(system), error => !error.message.includes('credentials'));
});
