const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-model-migration-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');
installElectronSafeStorage(test);

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  retireAutoSeededCatalog,
} = require('../../electron/core/studio-models.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function fixtureModels() {
  const pristine = {
    provider: 'fixture',
    id: 'fixture-model',
    name: 'Fixture Model',
  };
  const configured = {
    provider: 'configured',
    id: 'configured-model',
    name: 'Configured Model',
  };
  return {
    getProviders: () => [
      { id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.test/v1' },
      { id: 'configured', name: 'Configured', baseUrl: 'https://configured.test/v1' },
      { id: 'empty', name: 'Empty', baseUrl: '' },
    ],
    getModels: () => [pristine, configured],
  };
}

test('v1 cleanup removes only untouched auto-seeded providers', () => {
  const db = getStudioDatabase();
  for (const [id, name, baseUrl] of [
    ['fixture', 'Fixture', 'https://fixture.test/v1'],
    ['configured', 'Configured', 'https://configured.test/v1'],
    ['empty', 'Empty', ''],
  ]) {
    db.upsertProvider({ id, name, baseUrl, api: 'openai-completions', builtin: true, enabled: true });
    if (id === 'empty') continue;
    db.upsertModel({
      providerId: id,
      modelId: `${id}-model`,
      name: `${name} Model`,
      api: 'openai-completions',
      enabled: true,
      source: 'builtin',
    });
  }
  db.writeCredential('configured', { type: 'api_key', key: 'test-key' });
  db.setSetting('studio.models.defaultModelRef', 'fixture/fixture-model');
  db.setSetting('studio.models.catalogRevision', 1);

  retireAutoSeededCatalog(db, fixtureModels());

  assert.equal(db.getProvider('fixture'), undefined);
  assert.deepEqual(db.listModels('fixture'), []);
  assert.equal(db.getProvider('empty'), undefined);
  assert.ok(db.getProvider('configured'));
  assert.equal(db.listModels('configured').length, 1);
  assert.equal(db.getSetting('studio.models.defaultModelRef', ''), '');
  assert.equal(db.getSetting('studio.models.catalogRevision'), 2);
});
