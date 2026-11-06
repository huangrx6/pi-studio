const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-preference-recovery-rest-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  DEFAULT_AGENT_TOOLS,
  readAgentToolSelection,
  saveInstalledToolSelection,
} = require('../../electron/runtime/tool-selection.cjs');
const {
  OfficialExtensionService,
} = require('../../electron/services/official-extensions.cjs');
const {
  rememberSessionExemptions,
  sessionExemptions,
} = require('../../electron/services/sensitive-input-guard.cjs');
const {
  defaultModelRef,
  modelInfoFor,
} = require('../../electron/services/models.cjs');

const MODEL_REF_KEY = 'studio.models.defaultModelRef';
const THINKING_BY_MODEL_KEY = 'studio.models.thinkingByModel';
const DEFAULT_THINKING_LEVEL_KEY = 'studio.models.defaultThinkingLevel';
const AGENT_TOOLS_KEY = 'studio.agent.tools';
const AGENT_TOOLS_VERSION_KEY = 'studio.agent.tools.version';
const OFFICIAL_EXTENSIONS_KEY = 'studio.officialExtensions';
const SENSITIVE_EXEMPTIONS_KEY = 'studio.sensitive-input-exemptions';
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const reasoningModel = {
  provider: 'fixture',
  id: 'reasoning-model',
  name: 'Reasoning Model',
  reasoning: true,
};
const plainModel = {
  provider: 'fixture',
  id: 'plain-model',
  name: 'Plain Model',
  reasoning: false,
};
const runtimeModels = new Map([
  [`${reasoningModel.provider}/${reasoningModel.id}`, reasoningModel],
  [`${plainModel.provider}/${plainModel.id}`, plainModel],
]);
const runtime = {
  models: {
    getModel: (provider, modelId) => runtimeModels.get(`${provider}/${modelId}`),
    getModels: () => [...runtimeModels.values()],
  },
  getSupportedThinkingLevels: (model) => (
    model.reasoning ? ['low', 'medium', 'high'] : []
  ),
};

function writeRawSetting(key, value) {
  getStudioDatabase().db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

function readRawSetting(key) {
  return getStudioDatabase().db.prepare(
    'SELECT value, updated_at FROM settings WHERE key = ?',
  ).get(key);
}

function readSetting(key) {
  const row = readRawSetting(key);
  return row ? { value: JSON.parse(row.value), updatedAt: row.updated_at } : undefined;
}

function assertNoReservedKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoReservedKeys);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(RESERVED_KEYS.has(key), false, `unexpected reserved key: ${key}`);
    assertNoReservedKeys(child);
  }
}

function assertJsonRoundTrip(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assertNoReservedKeys(value);
}

function officialService(database = getStudioDatabase()) {
  return new OfficialExtensionService({
    distribution: {},
    database,
    normalizeManifest: (value) => value,
  });
}

function ensureModelCatalog() {
  const db = getStudioDatabase();
  db.upsertProvider({
    id: 'fixture',
    name: 'Fixture',
    baseUrl: 'https://fixture.test/v1',
    api: 'openai-completions',
    enabled: true,
  });
  for (const model of runtimeModels.values()) {
    db.upsertModel({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      api: 'openai-completions',
      reasoning: model.reasoning,
      enabled: true,
      source: 'custom',
    });
  }
}

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('missing values use safe defaults without creating rows', () => {
  const db = getStudioDatabase();
  for (const key of [
    MODEL_REF_KEY,
    THINKING_BY_MODEL_KEY,
    DEFAULT_THINKING_LEVEL_KEY,
    AGENT_TOOLS_KEY,
    AGENT_TOOLS_VERSION_KEY,
    OFFICIAL_EXTENSIONS_KEY,
    SENSITIVE_EXEMPTIONS_KEY,
  ]) {
    db.deleteSetting(key);
  }

  assert.deepEqual(readAgentToolSelection(db), {
    enabled: [...DEFAULT_AGENT_TOOLS],
    sources: {},
  });
  assert.deepEqual(officialService(db).preferences(), {
    schemaVersion: 1,
    autoUpdate: {},
  });
  assert.deepEqual(sessionExemptions('session-a'), []);
  assert.equal(defaultModelRef(runtime), '');
  const selection = modelInfoFor(reasoningModel, temporary, undefined, undefined, runtime);
  assert.equal(selection.thinkingLevel, 'default');
  assert.equal(selection.effectiveThinkingLevel, 'medium');

  const count = db.db.prepare(`
    SELECT COUNT(*) AS count
    FROM settings
    WHERE key IN (?, ?, ?, ?, ?, ?, ?)
  `).get(
    MODEL_REF_KEY,
    THINKING_BY_MODEL_KEY,
    DEFAULT_THINKING_LEVEL_KEY,
    AGENT_TOOLS_KEY,
    AGENT_TOOLS_VERSION_KEY,
    OFFICIAL_EXTENSIONS_KEY,
    SENSITIVE_EXEMPTIONS_KEY,
  ).count;
  assert.equal(count, 0);
});

test('malformed JSON is repaired once and leaves unrelated settings untouched', () => {
  const db = getStudioDatabase();
  for (const key of [
    MODEL_REF_KEY,
    THINKING_BY_MODEL_KEY,
    DEFAULT_THINKING_LEVEL_KEY,
    AGENT_TOOLS_KEY,
    OFFICIAL_EXTENSIONS_KEY,
    SENSITIVE_EXEMPTIONS_KEY,
  ]) {
    writeRawSetting(key, '{broken');
  }
  db.setSetting(AGENT_TOOLS_VERSION_KEY, 3);
  db.setSetting('studio.test.sentinel', { keep: true });

  const toolSelection = readAgentToolSelection(db);
  const preferences = officialService(db).preferences();
  const exemptions = sessionExemptions('session-a');
  const model = defaultModelRef(runtime);
  const thinking = modelInfoFor(reasoningModel, temporary, undefined, undefined, runtime);

  assert.deepEqual(toolSelection.enabled, [...DEFAULT_AGENT_TOOLS]);
  assert.deepEqual(preferences, { schemaVersion: 1, autoUpdate: {} });
  assert.deepEqual(exemptions, []);
  assert.equal(model, '');
  assert.equal(thinking.thinkingLevel, 'default');
  assert.equal(thinking.effectiveThinkingLevel, 'medium');
  for (const key of [
    MODEL_REF_KEY,
    THINKING_BY_MODEL_KEY,
    DEFAULT_THINKING_LEVEL_KEY,
    AGENT_TOOLS_KEY,
    OFFICIAL_EXTENSIONS_KEY,
    SENSITIVE_EXEMPTIONS_KEY,
  ]) {
    assert.doesNotThrow(() => JSON.parse(readRawSetting(key).value));
  }
  assert.deepEqual(readSetting('studio.test.sentinel').value, { keep: true });

  const timestamps = new Map(
    [
      AGENT_TOOLS_KEY,
      OFFICIAL_EXTENSIONS_KEY,
      SENSITIVE_EXEMPTIONS_KEY,
      THINKING_BY_MODEL_KEY,
      DEFAULT_THINKING_LEVEL_KEY,
    ].map((key) => [key, readRawSetting(key).updated_at]),
  );
  readAgentToolSelection(db);
  officialService(db).preferences();
  sessionExemptions('session-a');
  modelInfoFor(reasoningModel, temporary, undefined, undefined, runtime);
  for (const [key, updatedAt] of timestamps) {
    assert.equal(readRawSetting(key).updated_at, updatedAt);
  }
});

test('wrong model shapes keep valid entries, apply stable fallbacks, and persist a canonical ref', () => {
  const db = getStudioDatabase();
  ensureModelCatalog();
  writeRawSetting(THINKING_BY_MODEL_KEY, JSON.stringify(Object.fromEntries([
    ['fixture/reasoning-model ', 'high'],
    ['fixture/reasoning-model', 'low'],
    ['fixture/plain-model', 'xhigh'],
    ['not-a-ref', 'medium'],
    ['constructor', 'high'],
    ['__proto__', 'high'],
    ['fixture/invalid-level', 'ultra'],
    ['fixture/numeric-level', 3],
  ])));
  db.setSetting(DEFAULT_THINKING_LEVEL_KEY, 'ultra');
  writeRawSetting(MODEL_REF_KEY, JSON.stringify('  fixture/reasoning-model  '));
  db.setSetting('studio.test.model-sentinel', { untouched: true });

  const thinking = modelInfoFor(reasoningModel, temporary, undefined, undefined, runtime);
  assert.equal(thinking.thinkingLevel, 'low');
  assert.equal(thinking.defaultThinkingLevel, 'medium');
  assert.deepEqual(readSetting(THINKING_BY_MODEL_KEY).value, {
    'fixture/reasoning-model': 'low',
    'fixture/plain-model': 'xhigh',
  });
  assert.equal(readSetting(DEFAULT_THINKING_LEVEL_KEY).value, 'default');
  assert.equal(defaultModelRef(runtime), 'fixture/reasoning-model');
  assert.equal(readSetting(MODEL_REF_KEY).value, 'fixture/reasoning-model');
  assert.deepEqual(readSetting('studio.test.model-sentinel').value, { untouched: true });
  assertJsonRoundTrip(readSetting(THINKING_BY_MODEL_KEY).value);

  db.setSetting(MODEL_REF_KEY, { provider: 'fixture', modelId: 'reasoning-model' });
  assert.equal(defaultModelRef(runtime), 'fixture/plain-model');
  assert.equal(readSetting(MODEL_REF_KEY).value, 'fixture/plain-model');
  db.setSetting(THINKING_BY_MODEL_KEY, []);
  db.setSetting(DEFAULT_THINKING_LEVEL_KEY, 7);
  const fallbackThinking = modelInfoFor(
    reasoningModel,
    temporary,
    undefined,
    undefined,
    runtime,
  );
  assert.equal(fallbackThinking.thinkingLevel, 'default');
  assert.equal(fallbackThinking.effectiveThinkingLevel, 'medium');
  assert.deepEqual(readSetting(THINKING_BY_MODEL_KEY).value, {});
  assert.equal(readSetting(DEFAULT_THINKING_LEVEL_KEY).value, 'default');
});

test('tool-selection saves and migrations commit their value and version together', () => {
  const db = getStudioDatabase();
  const originalSelection = readSetting(AGENT_TOOLS_KEY)?.value;
  const originalVersion = readSetting(AGENT_TOOLS_VERSION_KEY)?.value;
  db.setSetting(AGENT_TOOLS_KEY, { enabled: ['read', 'write'], sources: {} });
  db.setSetting(AGENT_TOOLS_VERSION_KEY, 3);
  const failingVersionTrigger = `
    CREATE TRIGGER fail_agent_tool_version_write
    BEFORE UPDATE ON settings
    WHEN NEW.key = '${AGENT_TOOLS_VERSION_KEY}'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic tool version write failure');
    END
  `;
  db.db.exec(failingVersionTrigger);

  try {
    assert.throws(
      () => saveInstalledToolSelection({ enabled: ['read'], sources: {} }, db),
      /synthetic tool version write failure/,
    );
    assert.deepEqual(readSetting(AGENT_TOOLS_KEY).value, {
      enabled: ['read', 'write'],
      sources: {},
    });

    db.db.exec('DROP TRIGGER fail_agent_tool_version_write');
    db.setSetting(AGENT_TOOLS_VERSION_KEY, 1);
    db.db.exec(failingVersionTrigger);
    assert.deepEqual(readAgentToolSelection(db).enabled, ['read', 'write', 'mcp__*', 'todo']);
    assert.deepEqual(readSetting(AGENT_TOOLS_KEY).value, {
      enabled: ['read', 'write'],
      sources: {},
    });
    assert.equal(readSetting(AGENT_TOOLS_VERSION_KEY).value, 1);
  } finally {
    db.db.exec('DROP TRIGGER IF EXISTS fail_agent_tool_version_write');
    if (originalSelection === undefined) db.deleteSetting(AGENT_TOOLS_KEY);
    else db.setSetting(AGENT_TOOLS_KEY, originalSelection);
    if (originalVersion === undefined) db.deleteSetting(AGENT_TOOLS_VERSION_KEY);
    else db.setSetting(AGENT_TOOLS_VERSION_KEY, originalVersion);
  }
});

test('agent tool recovery repairs the latest payload and keeps explicit empty selections', () => {
  const db = getStudioDatabase();
  db.setSetting(AGENT_TOOLS_VERSION_KEY, 1);
  writeRawSetting(AGENT_TOOLS_KEY, JSON.stringify({
    enabled: ['read', 'read', 42, '__proto__', 'constructor', 'mcp__*'],
    sources: {
      read: {
        source: 'core',
        label: 'Core',
        scope: 'builtin',
        path: '/core',
        baseDir: '/',
        ignored: { nested: true },
      },
      constructor: { source: 'unsafe' },
    },
  }));
  const migrated = readAgentToolSelection(db);
  assert.deepEqual(migrated.enabled, ['read', 'mcp__*', 'todo']);
  assert.deepEqual(Object.keys(migrated.sources), ['read']);
  assert.deepEqual(readSetting(AGENT_TOOLS_KEY).value, migrated);
  assert.equal(readSetting(AGENT_TOOLS_VERSION_KEY).value, 3);

  db.setSetting(AGENT_TOOLS_KEY, { enabled: [], sources: {} });
  db.setSetting(AGENT_TOOLS_VERSION_KEY, 3);
  assert.deepEqual(readAgentToolSelection(db), { enabled: [], sources: {} });
  assert.deepEqual(readSetting(AGENT_TOOLS_KEY).value, { enabled: [], sources: {} });

  db.setSetting(AGENT_TOOLS_VERSION_KEY, 'invalid-version');
  db.setSetting(AGENT_TOOLS_KEY, { enabled: ['read'], sources: {} });
  assert.deepEqual(readAgentToolSelection(db).enabled, ['read', 'mcp__*', 'todo']);
  assert.equal(readSetting(AGENT_TOOLS_VERSION_KEY).value, 3);
  const updatedAt = readRawSetting(AGENT_TOOLS_KEY).updated_at;
  readAgentToolSelection(db);
  assert.equal(readRawSetting(AGENT_TOOLS_KEY).updated_at, updatedAt);

  const oversized = Array.from({ length: 300 }, (_, index) => `tool_${index}`);
  db.setSetting(AGENT_TOOLS_KEY, { enabled: oversized, sources: {} });
  db.setSetting(AGENT_TOOLS_VERSION_KEY, 3);
  assert.equal(readAgentToolSelection(db).enabled.length, 256);
  assertJsonRoundTrip(readSetting(AGENT_TOOLS_KEY).value);
});

test('official extension preferences repair invalid schema and nested maps', () => {
  const db = getStudioDatabase();
  writeRawSetting(OFFICIAL_EXTENSIONS_KEY, JSON.stringify({
    schemaVersion: 99,
    autoUpdate: Object.fromEntries([
      ['official.alpha', true],
      ['official.beta', false],
      ['constructor', false],
      ['__proto__', true],
      ['bad id', true],
      ['official.invalid', 'true'],
      ['a', false],
    ]),
  }));
  db.setSetting('studio.test.official-sentinel', 7);

  assert.deepEqual(officialService(db).preferences(), {
    schemaVersion: 1,
    autoUpdate: {
      'official.alpha': true,
      'official.beta': false,
    },
  });
  assert.deepEqual(readSetting(OFFICIAL_EXTENSIONS_KEY).value, {
    schemaVersion: 1,
    autoUpdate: {
      'official.alpha': true,
      'official.beta': false,
    },
  });
  db.setSetting(OFFICIAL_EXTENSIONS_KEY, { schemaVersion: 1, autoUpdate: [] });
  assert.deepEqual(officialService(db).preferences(), {
    schemaVersion: 1,
    autoUpdate: {},
  });
  assert.equal(readSetting('studio.test.official-sentinel').value, 7);
  assertJsonRoundTrip(readSetting(OFFICIAL_EXTENSIONS_KEY).value);
});

test('sensitive exemptions keep only bounded safe session hashes and validate writes', () => {
  const db = getStudioDatabase();
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const third = 'c'.repeat(64);
  const manyHashes = Array.from(
    { length: 70 },
    (_, index) => index.toString(16).padStart(64, '0'),
  );
  const manySessions = Object.fromEntries(
    Array.from({ length: 70 }, (_, index) => [`session-${index}`, [first]]),
  );
  writeRawSetting(SENSITIVE_EXEMPTIONS_KEY, JSON.stringify(Object.fromEntries([
    ...Object.entries(manySessions),
    ['safe-session', [
      first,
      first.toUpperCase(),
      'not-a-hash',
      42,
      ...manyHashes,
      second,
    ]],
    ['bad/session', [third]],
    ['constructor', [third]],
    ['prototype', [third]],
    ['__proto__', [third]],
  ])));

  const safe = sessionExemptions('safe-session');
  assert.equal(safe.at(-1), second);
  assert.equal(safe.length, 64);
  assert.equal(new Set(safe).size, safe.length);
  assert.ok(safe.every((value) => /^[a-f0-9]{64}$/.test(value)));
  assert.deepEqual(sessionExemptions('bad/session'), []);
  assert.deepEqual(sessionExemptions('constructor'), []);
  const stored = readSetting(SENSITIVE_EXEMPTIONS_KEY).value;
  assert.equal(Object.keys(stored).length, 64);
  assert.equal(Object.hasOwn(stored, 'safe-session'), true);
  assert.equal(Object.hasOwn(stored, 'bad/session'), false);
  assertJsonRoundTrip(stored);

  const updated = [
    ...safe.slice(1),
    third,
  ];
  assert.deepEqual(rememberSessionExemptions('safe-session', [third, third.toUpperCase()]), updated);
  assert.throws(
    () => rememberSessionExemptions('__proto__', [third]),
    /有效会话 ID/,
  );
  assert.deepEqual(rememberSessionExemptions('safe-session', ['invalid']), updated);
  assertJsonRoundTrip(readSetting(SENSITIVE_EXEMPTIONS_KEY).value);
});

test('repair write failures still return safe preferences', () => {
  const db = getStudioDatabase();
  const keys = [
    MODEL_REF_KEY,
    THINKING_BY_MODEL_KEY,
    DEFAULT_THINKING_LEVEL_KEY,
    AGENT_TOOLS_KEY,
    OFFICIAL_EXTENSIONS_KEY,
    SENSITIVE_EXEMPTIONS_KEY,
  ];
  for (const key of keys) writeRawSetting(key, '{broken');
  db.setSetting(AGENT_TOOLS_VERSION_KEY, 'invalid-version');
  const triggerNames = keys.map((_key, index) => `fail_rest_preference_repair_${index}`);
  for (const [index, key] of keys.entries()) {
    db.db.exec(`
      CREATE TRIGGER ${triggerNames[index]}
      BEFORE UPDATE ON settings
      WHEN OLD.key = '${key}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic preference write failure');
      END
    `);
  }

  try {
    assert.deepEqual(readAgentToolSelection(db).enabled, [...DEFAULT_AGENT_TOOLS]);
    assert.deepEqual(officialService(db).preferences(), {
      schemaVersion: 1,
      autoUpdate: {},
    });
    assert.deepEqual(sessionExemptions('session-a'), []);
    assert.equal(defaultModelRef(runtime), 'fixture/plain-model');
    const selection = modelInfoFor(reasoningModel, temporary, undefined, undefined, runtime);
    assert.equal(selection.thinkingLevel, 'default');
    assert.equal(selection.effectiveThinkingLevel, 'medium');
    for (const key of keys) assert.equal(readRawSetting(key).value, '{broken');
  } finally {
    for (const trigger of triggerNames) db.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
});
