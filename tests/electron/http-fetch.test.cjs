const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { systemFetch, resetSystemFetch } = require('../../electron/core/http-fetch.cjs');

function withElectronMock(mock, run) {
  const load = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return mock;
    return load.call(this, request, parent, isMain);
  };
  resetSystemFetch();
  try {
    return run();
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
