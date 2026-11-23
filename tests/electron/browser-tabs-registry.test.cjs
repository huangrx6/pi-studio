const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

const electronPath = require.resolve('electron');
const original = Module._cache[electronPath];
const fakeContents = new Map();

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
      fromPartition: () => ({ partition: 'persist:pi-browser' }),
    },
  },
};

test.after(() => {
  if (original) Module._cache[electronPath] = original;
  else delete Module._cache[electronPath];
});

const {
  listBrowserTabs,
  registerBrowserTab,
  setActiveBrowserTab,
  unregisterBrowserTab,
  updateBrowserTab,
} = require('../../electron/main/services/browser/tabs.cjs');

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
