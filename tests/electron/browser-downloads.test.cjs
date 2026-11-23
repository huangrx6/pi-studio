const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const electronPath = require.resolve('electron');
const original = Module._cache[electronPath];
const fakeSession = {
  webRequest: { onBeforeRequest() {} },
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  on() {},
  clearCache: async () => {},
  clearStorageData: async () => {},
};
Module._cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    session: { fromPartition: () => fakeSession },
    shell: {
      showItemInFolder() {},
      openPath: async () => '',
    },
  },
};

test.after(() => {
  if (original) Module._cache[electronPath] = original;
  else delete Module._cache[electronPath];
});

const {
  isRiskyFilename,
  uniqueSavePath,
} = require('../../electron/main/services/browser/downloads.cjs');

test('flags executable-looking downloads', () => {
  assert.equal(isRiskyFilename('Setup.dmg'), true);
  assert.equal(isRiskyFilename('notes.pdf'), false);
  assert.equal(isRiskyFilename('run.sh'), true);
});

test('uniqueSavePath avoids collisions without path traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-browser-dl-'));
  try {
    fs.writeFileSync(path.join(root, 'report.pdf'), '1');
    const first = uniqueSavePath(root, '../../report.pdf');
    assert.equal(path.basename(first), 'report (1).pdf');
    assert.equal(path.dirname(first), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
