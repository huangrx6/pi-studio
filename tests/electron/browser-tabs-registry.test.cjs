const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const Module = require('node:module');

const electronPath = require.resolve('electron');
const original = Module._cache[electronPath];
const fakeContents = new Map();
const studioSession = {};

Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    webContents: {
      fromId(id) {
        return fakeContents.get(id) || null;
      },
    },
    session: {
      fromPartition: () => studioSession,
    },
  },
};

test.after(() => {
  if (original) Module._cache[electronPath] = original;
  else delete Module._cache[electronPath];
});

const {
  installBrowserTabWatchers,
  listBrowserTabs,
  resolveBrowserTab,
  withBrowserOwner,
  registerBrowserTab,
  setActiveBrowserTab,
  unregisterBrowserTab,
  updateBrowserTab,
} = require('../../electron/main/services/browser/tabs.cjs');
const { getBrowserSession } = require('../../electron/main/services/browser/session.cjs');
const { readConsoleEntries } = require('../../electron/main/services/browser/telemetry.cjs');

test('the Studio guest captures its current document console before tab registration', () => {
  const app = new EventEmitter();
  const session = getBrowserSession();
  const mainFrame = { origin: 'https://project.example' };
  installBrowserTabWatchers(app);
  function createContents(id, type, browserSession) {
    const contents = Object.assign(new EventEmitter(), { id, getType: () => type, session: browserSession, mainFrame });
    app.emit('web-contents-created', {}, contents);
    return contents;
  }
  assert.equal(createContents(21, 'window', session).listenerCount('console-message'), 0);
  assert.equal(createContents(22, 'webview', {}).listenerCount('console-message'), 0);
  const guest = createContents(23, 'webview', session);
  guest.emit('console-message', { frame: mainFrame, level: 'error', message: 'startup failed' });
  guest.emit('console-message', { frame: { origin: mainFrame.origin }, level: 'warning', message: 'same origin' });
  guest.emit('console-message', { frame: { origin: 'https://other.example' }, level: 'info', message: 'other origin' });
  guest.emit('did-fail-load', {}, -105, 'unreachable', 'https://other.example/frame', false);
  guest.emit('did-navigate-in-page');
  assert.deepEqual(readConsoleEntries(23).entries.map(entry => entry.message), ['startup failed', 'same origin']);
  guest.emit('did-navigate');
  assert.equal(readConsoleEntries(23).summary.total, 0);
  guest.emit('did-fail-load', {}, -105, 'unreachable', 'https://project.example/frame', false);
  assert.equal(readConsoleEntries(23).entries[0].kind, 'load-error');
  guest.emit('destroyed');
  assert.equal(readConsoleEntries(23).summary.total, 0);
});

test('register and list browser tabs with active selection', () => {
  // Isolate by clearing via unregister of known ids if re-run in same process.
  for (const tab of listBrowserTabs()) unregisterBrowserTab(tab.id);

  const first = registerBrowserTab({
    id: 'guest:a',
    webContentsId: 101,
    url: 'https://a.example',
    title: 'A',
    active: true,
  });
  const second = registerBrowserTab({
    id: 'guest:b',
    webContentsId: 102,
    url: 'https://b.example',
    title: 'B',
  });
  assert.equal(first.active, true);
  assert.equal(second.id, 'guest:b');
  const listed = listBrowserTabs();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((tab) => tab.id === 'guest:a')?.active, true);

  setActiveBrowserTab('guest:b');
  assert.equal(listBrowserTabs().find((tab) => tab.id === 'guest:b')?.active, true);

  updateBrowserTab('guest:b', { title: 'Bee', url: 'https://b.example/path' });
  assert.equal(listBrowserTabs().find((tab) => tab.id === 'guest:b')?.title, 'Bee');

  unregisterBrowserTab('guest:a');
  unregisterBrowserTab('guest:b');
  assert.equal(listBrowserTabs().length, 0);
});

test('background conversations list and operate only on their own browser guests', async () => {
  registerBrowserTab({ id: 'scope:a', ownerKey: 'conversation:a', webContentsId: 111 });
  registerBrowserTab({ id: 'scope:b', ownerKey: 'temporary:b', webContentsId: 112, active: true });
  try {
    await Promise.all([['conversation:a', 'scope:a', 'scope:b'], ['temporary:b', 'scope:b', 'scope:a']].map(
      ([key, own, other]) => withBrowserOwner({ key }, async () => {
        await Promise.resolve();
        assert.deepEqual(listBrowserTabs().map(tab => tab.id), [own]);
        assert.equal(resolveBrowserTab().id, own);
        assert.throws(() => resolveBrowserTab(other), /找不到/);
      }),
    ));
  } finally {
    unregisterBrowserTab('scope:a');
    unregisterBrowserTab('scope:b');
  }
});
