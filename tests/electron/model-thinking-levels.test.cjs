const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  effectiveThinkingLevels,
  normalizeThinkingLevels,
  thinkingLevelMapForLevels,
  thinkingLevelsFromMap,
} = require('../../electron/core/thinking-levels.cjs');
const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');

test('thinking levels normalize vendor aliases into Pi order', () => {
  assert.deepEqual(
    normalizeThinkingLevels(['maximum', 'none', 'HIGH', 'extra-high', 'medium', 'invalid']),
    ['off', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(
    normalizeThinkingLevels(['normal', 'extra_high', 'very-high', 'x-high']),
    ['medium', 'xhigh'],
  );
  assert.deepEqual(effectiveThinkingLevels([], true), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(effectiveThinkingLevels(['high'], false), []);
});

test('thinking level objects tolerate capability flags and effort keys', () => {
  // OpenAI-compatible catalogs (e.g. opencode) declare `{ supported: true }`,
  // a boolean flag that must never be iterated as a level list.
  assert.deepEqual(normalizeThinkingLevels({ supported: true }), []);
  assert.deepEqual(normalizeThinkingLevels({ supported: true, effort: ['low', 'high', 'max'] }), [
    'low',
    'high',
    'max',
  ]);
  assert.deepEqual(normalizeThinkingLevels({ effort: 'none, medium' }), ['off', 'medium']);
  assert.deepEqual(normalizeThinkingLevels({ supported: ['low', 'high'] }), ['low', 'high']);
  assert.deepEqual(normalizeThinkingLevels({ levels: 5 }), []);
  assert.deepEqual(normalizeThinkingLevels(3), []);
  assert.deepEqual(normalizeThinkingLevels(true), []);
  assert.deepEqual(
    effectiveThinkingLevels({ supported: true }, true),
    ['off', 'minimal', 'low', 'medium', 'high'],
  );
});

test('thinking capability maps preserve provider values and expose only selected levels', async () => {
  const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
  const map = thinkingLevelMapForLevels(['off', 'low', 'high', 'max'], {
    off: 'none',
    low: 'low',
    high: 'high',
  });
  assert.deepEqual(thinkingLevelsFromMap(map), ['off', 'low', 'high', 'max']);
  assert.deepEqual(getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: map }), [
    'off',
    'low',
    'high',
    'max',
  ]);
});

test('model capability levels survive a v5 database migration and reopen', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-thinking-levels-'));
  const filename = path.join(temporary, 'studio.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE model_catalog (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      api TEXT NOT NULL,
      context_window INTEGER,
      max_tokens INTEGER,
      supports_images INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, model_id)
    );
    PRAGMA user_version = 5;
  `);
  legacy.close();

  const db = createStudioDatabase(filename);
  db.upsertProvider({
    id: 'fixture',
    name: 'Fixture',
    baseUrl: 'https://fixture.test/v1',
    api: 'openai-completions',
    enabled: true,
  });
  db.upsertModel({
    providerId: 'fixture',
    modelId: 'reasoner',
    name: 'Reasoner',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevels: ['off', 'low', 'high', 'max'],
    source: 'custom',
  });
  assert.deepEqual(db.getModel('fixture', 'reasoner').thinkingLevels, [
    'off',
    'low',
    'high',
    'max',
  ]);
  assert.equal(db.getModel('fixture', 'reasoner').metadataSource, 'manual');
  db.close();

  const reopened = createStudioDatabase(filename);
  assert.deepEqual(reopened.getModel('fixture', 'reasoner').thinkingLevels, [
    'off',
    'low',
    'high',
    'max',
  ]);
  assert.equal(reopened.getModel('fixture', 'reasoner').metadataSource, 'manual');
  reopened.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});
