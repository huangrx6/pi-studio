const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { systemFetch, installSystemFetch, resetSystemFetch } = require('../../electron/main/core/http-fetch.cjs');

async function withElectronMock(mock, run) {
  const load = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return mock;
    return load.call(this, request, parent, isMain);
  };
  resetSystemFetch();
  try {
    return await run();
  } finally {
    Module._load = load;
    resetSystemFetch();
  }
}

test('remote downloads use the Chromium stack so the system proxy applies', async () => {
  const calls = [];
  const mock = {
    app: { isReady: () => true },
    net: { fetch: async (url, init) => { calls.push({ url, init }); return new Response('ok', { status: 200 }); } },
  };
  await withElectronMock(mock, async () => {
    const response = await systemFetch('https://github.com/openclaw/skills', { redirect: 'manual' });
    assert.equal(await response.text(), 'ok');
  });
  assert.deepEqual(calls, [{ url: 'https://github.com/openclaw/skills', init: { redirect: 'manual' } }]);
});

test('provider SDK default fetch and resource fetch share the configured transport', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const controller = new AbortController();
  installSystemFetch(async (input, init) => {
    calls.push({ input, init });
    return new Response('data: test\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const capturedSdkFetch = globalThis.fetch;
    const init = { method: 'POST', headers: { authorization: 'Bearer test-only' }, body: '{}', signal: controller.signal };
    const response = await capturedSdkFetch('https://provider.test/v1/chat/completions', init);
    assert.equal(await response.text(), 'data: test\n\n');
    await systemFetch('https://provider.test/v1/models');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init, init);
    // Saved changes replace the transport even for a fetch reference captured
    // by an SDK when the previous configuration was active.
    installSystemFetch(async () => new Response('new route'));
    assert.equal(await (await capturedSdkFetch('https://provider.test')).text(), 'new route');
  } finally {
    resetSystemFetch();
  }
  assert.equal(globalThis.fetch, original);
});

test('fetch called before Electron readiness upgrades to Chromium after readiness', async () => {
  const original = globalThis.fetch;
  let ready = false;
  globalThis.fetch = async () => new Response('runtime');
  try {
    await withElectronMock({ app: { isReady: () => ready }, net: { fetch: async () => new Response('chromium') } }, async () => {
      assert.equal(await (await systemFetch('https://example.com')).text(), 'runtime');
      ready = true;
      assert.equal(await (await systemFetch('https://example.com')).text(), 'chromium');
    });
  } finally { globalThis.fetch = original; }
});

test('the transport falls back to the runtime fetch outside Electron', async () => {
  const original = global.fetch;
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return new Response('fallback', { status: 200 }); };
  try {
    // 测试环境里 require('electron') 只有可执行文件路径，没有 net。
    const response = await systemFetch('https://example.com/catalog.json');
    assert.equal(await response.text(), 'fallback');
  } finally {
    global.fetch = original;
  }
  assert.deepEqual(urls, ['https://example.com/catalog.json']);
});

test('an Electron main process that is not ready keeps using the runtime fetch', async () => {
  const original = global.fetch;
  global.fetch = async () => new Response('runtime', { status: 200 });
  try {
    await withElectronMock(
      { app: { isReady: () => false }, net: { fetch: async () => new Response('chromium', { status: 200 }) } },
      async () => assert.equal(await (await systemFetch('https://example.com')).text(), 'runtime'),
    );
  } finally {
    global.fetch = original;
  }
});
