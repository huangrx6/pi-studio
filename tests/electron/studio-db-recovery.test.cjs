const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-db-recovery-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  closeStudioModelsRuntime,
  getStudioModelsRuntime,
} = require('../../electron/core/studio-models.cjs');

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => path.join(temporary, 'app'),
        getPath: () => path.join(temporary, 'electron-user-data'),
        getVersion: () => '0.0.0-test',
        isPackaged: false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { settingsSnapshot } = require('../../electron/services/settings.cjs');
Module._load = originalLoad;

test.after(() => {
  closeStudioModelsRuntime();
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('Studio database and model runtime recover after a closed connection is encountered', async () => {
  const firstRuntime = await getStudioModelsRuntime();
  const firstDatabase = getStudioDatabase();
  assert.equal(firstDatabase.isOpen(), true);

  // Simulate a connection being closed outside the singleton helper. The next
  // access must replace both the connection and every runtime that captured it.
  firstDatabase.db.close();

  const reopened = getStudioDatabase();
  assert.notEqual(reopened, firstDatabase);
  assert.equal(reopened.isOpen(), true);

  const secondRuntime = await getStudioModelsRuntime();
  assert.notEqual(secondRuntime, firstRuntime);
  assert.deepEqual(await secondRuntime.credentials.list(), []);
});

test('settings snapshot recovers after the database is closed', async () => {
  await getStudioModelsRuntime();
  closeStudioDatabase();

  const snapshot = await settingsSnapshot(temporary);

  assert.equal(getStudioDatabase().isOpen(), true);
  assert.deepEqual(snapshot.providers, []);
  assert.deepEqual(snapshot.customModels, []);
  assert.equal(snapshot.databasePath, process.env.PI_STUDIO_DB);
});
