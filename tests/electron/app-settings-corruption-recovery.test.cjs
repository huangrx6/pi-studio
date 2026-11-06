const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-setting-recovery-'));
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  KEYS,
  getConversationExtensionUiPreferences,
  getExtensionRegistryUrl,
  getHarnessStore,
  getMenuBarEnabled,
  getPalette,
  getPermissionPolicyStore,
  getRadiusStyle,
  getRuntimePolicy,
  getSubagentConfig,
  getTheme,
  setSubagentConfig,
} = require('../../electron/core/app-settings.cjs');
const {
  closeStudioDatabase,
  getStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function writeRawSetting(key, value) {
  getStudioDatabase().db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

function readStoredSetting(key) {
  const row = getStudioDatabase().db.prepare(
    'SELECT value, updated_at FROM settings WHERE key = ?',
  ).get(key);
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

function permissionPolicy(tools = {}) {
  return {
    preset: 'ask',
    default: 'ask',
    tools,
    rules: [],
  };
}

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('missing preferences use defaults without creating rows or rewriting valid rows', () => {
  const db = getStudioDatabase();
  for (const key of Object.values(KEYS)) db.deleteSetting(key);

  assert.equal(getTheme(), 'light');
  assert.equal(getPalette(), 'lime');
  assert.equal(getRadiusStyle(), 'standard');
  assert.equal(getMenuBarEnabled(), true);
  assert.equal(getRuntimePolicy().toolExecution, 'parallel');
  assert.equal(getHarnessStore().activeProfileId, 'studio-coding');
  assert.deepEqual(getSubagentConfig(), {});
  assert.equal(getConversationExtensionUiPreferences().layout, 'grid');
  assert.equal(getExtensionRegistryUrl(), '');
  assert.equal(
    db.db.prepare('SELECT COUNT(*) AS count FROM settings').get().count,
    0,
  );

  db.setSetting('studio.test.sentinel', { keep: true });
  const sentinel = readStoredSetting('studio.test.sentinel');
  getTheme();
  assert.deepEqual(readStoredSetting('studio.test.sentinel'), sentinel);
});

test('malformed and wrong appearance values are repaired idempotently', () => {
  const db = getStudioDatabase();
  writeRawSetting(KEYS.theme, '{not-json');
  db.setSetting(KEYS.palette, 42);
  db.setSetting(KEYS.radiusStyle, 'pill');
  db.setSetting(KEYS.menuBarEnabled, 'false');
  db.setSetting('studio.test.sentinel', { untouched: true });

  assert.equal(getTheme(), 'light');
  assert.equal(getPalette(), 'lime');
  assert.equal(getRadiusStyle(), 'standard');
  assert.equal(getMenuBarEnabled(), true);
  assert.equal(readStoredSetting(KEYS.theme).value, 'light');
  assert.equal(readStoredSetting(KEYS.palette).value, 'lime');
  assert.equal(readStoredSetting(KEYS.radiusStyle).value, 'standard');
  assert.equal(readStoredSetting(KEYS.menuBarEnabled).value, true);
  assert.deepEqual(readStoredSetting('studio.test.sentinel').value, { untouched: true });

  db.db.prepare('UPDATE settings SET updated_at = 7 WHERE key = ?').run(KEYS.theme);
  assert.equal(getTheme(), 'light');
  assert.equal(readStoredSetting(KEYS.theme).updatedAt, 7);
});

test('valid permission policy synchronizes its preset while missing or invalid policy uses legacy mode', () => {
  const db = getStudioDatabase();
  db.setSetting(KEYS.permissionMode, 'full');
  db.setSetting(KEYS.permissionPolicy, {
    user: permissionPolicy({ grep: 'deny' }),
  });
  assert.deepEqual(
    readStoredSetting(KEYS.permissionPolicy).value,
    { user: permissionPolicy({ grep: 'deny' }) },
  );
  assert.equal(db.getSetting(KEYS.permissionMode), 'full');
  assert.equal(getPermissionPolicyStore().user.preset, 'ask');
  assert.equal(db.getSetting(KEYS.permissionMode), 'ask');

  db.setSetting(KEYS.permissionMode, 'full');
  writeRawSetting(KEYS.permissionPolicy, '{"user":');
  assert.equal(getPermissionPolicyStore().user.preset, 'full');
  assert.equal(readStoredSetting(KEYS.permissionPolicy).value.user.preset, 'full');

  db.setSetting(KEYS.permissionMode, 'ask');
  db.deleteSetting(KEYS.permissionPolicy);
  assert.equal(getPermissionPolicyStore().user.preset, 'ask');
  assert.equal(readStoredSetting(KEYS.permissionPolicy), undefined);
});

test('permission scope maps reject prototype-sensitive keys and remain JSON-safe', () => {
  const db = getStudioDatabase();
  const workspace = path.join(temporary, 'permission-workspace');
  const unsafeTools = Object.fromEntries([
    ['__proto__', 'deny'],
    ['prototype', 'deny'],
    ['constructor', 'allow'],
    ['read', 'allow'],
  ]);
  const unsafePolicy = permissionPolicy(unsafeTools);
  const policy = Object.fromEntries([
    ['version', 1],
    ['user', unsafePolicy],
    ['workspaces', Object.fromEntries([
      ['__proto__', unsafePolicy],
      ['prototype', unsafePolicy],
      ['constructor', unsafePolicy],
      [workspace, unsafePolicy],
    ])],
    ['sessions', Object.fromEntries([
      ['__proto__', unsafePolicy],
      ['prototype', unsafePolicy],
      ['constructor', unsafePolicy],
      ['session-a', unsafePolicy],
    ])],
  ]);
  writeRawSetting(KEYS.permissionPolicy, JSON.stringify(policy));

  const store = getPermissionPolicyStore();
  assert.deepEqual(store.user.tools, { read: 'allow' });
  assert.deepEqual(Object.keys(store.workspaces), [workspace]);
  assert.deepEqual(store.workspaces[workspace].tools, { read: 'allow' });
  assert.deepEqual(Object.keys(store.sessions), ['session-a']);
  assert.deepEqual(store.sessions['session-a'].tools, { read: 'allow' });
  assertJsonRoundTrip(readStoredSetting(KEYS.permissionPolicy).value);
});

test('Harness boolean sections use their own default for non-boolean values', () => {
  const db = getStudioDatabase();
  db.setSetting(KEYS.harness, {
    activeProfileId: 'missing-profile',
    profiles: {
      'studio-coding': {
        id: 'studio-coding',
        sections: {
          tools: false,
          rules: 'false',
          preamble: 0,
        },
        sectionOverrides: [],
        toolGuidance: Object.fromEntries([
          ['constructor', 'must be rejected'],
          ['bash', 'run the narrow test'],
        ]),
      },
      constructor: { id: 'constructor' },
    },
    workspaceProfiles: {
      relative: 'studio-coding',
      'missing-profile': 'missing-profile',
    },
  });

  const store = getHarnessStore();
  const profile = store.profiles['studio-coding'];
  assert.equal(store.activeProfileId, 'studio-coding');
  assert.equal(profile.sections.tools, false);
  assert.equal(profile.sections.rules, true);
  assert.equal(profile.sections.preamble, true);
  assert.deepEqual(profile.toolGuidance, { bash: 'run the narrow test' });
  assert.equal(Object.hasOwn(store.profiles, 'constructor'), false);
  assert.deepEqual(store.workspaceProfiles, {});
  assertJsonRoundTrip(readStoredSetting(KEYS.harness).value);
});

test('legacy subagent snapshots still clean inherited fields on first v2 save', () => {
  const db = getStudioDatabase();
  const workspace = path.join(temporary, 'legacy-workspace');
  const previousUser = {
    defaultModel: 'provider/fast',
    defaultThinking: 'medium',
    maxThinking: 'high',
    allowedTools: ['read'],
  };
  db.setSetting(KEYS.subagents, {
    version: 1,
    user: previousUser,
    projects: {
      [workspace]: {
        ...previousUser,
        defaultModel: 'provider/project',
        defaultThinking: 'low',
      },
    },
  });

  assert.equal(getSubagentConfig('project', workspace).defaultModel, 'provider/project');
  setSubagentConfig('user', '', {
    ...getSubagentConfig('user'),
    defaultThinking: 'xhigh',
    maxThinking: 'xhigh',
  });

  const repaired = readStoredSetting(KEYS.subagents).value;
  assert.equal(repaired.version, 2);
  assert.equal(repaired.projects[workspace].defaultModel, 'provider/project');
  assert.equal(repaired.projects[workspace].defaultThinking, 'low');
  assert.equal(Object.hasOwn(repaired.projects[workspace], 'maxThinking'), false);
  assert.equal(Object.hasOwn(repaired.projects[workspace], 'allowedTools'), false);
  assertJsonRoundTrip(repaired);
});

test('v2 subagent recovery drops invalid overrides and resolves thinking conflicts', () => {
  const db = getStudioDatabase();
  const invalidWorkspace = path.join(temporary, 'v2-invalid');
  const conflictWorkspace = path.join(temporary, 'v2-conflict');
  const validWorkspace = path.join(temporary, 'v2-valid');
  db.setSetting(KEYS.subagents, {
    version: 2,
    user: {
      defaultThinking: 'xhigh',
      maxThinking: 'xhigh',
      maxConcurrent: 8,
      maxSpawns: 32,
      allowedTools: ['read'],
    },
    projects: {
      relative: { maxConcurrent: 12 },
      [invalidWorkspace]: {
        maxConcurrent: null,
        maxSpawns: '30',
        waitTimeoutMs: -1,
        worktreeIsolation: 'unsafe',
        allowedTools: ['grep', 'bad tool', 42],
        defaultThinking: 'xhigh',
        maxThinking: 'low',
        budgetCostUsd: '1.5',
        unknown: 'drop',
      },
      [conflictWorkspace]: {
        maxThinking: 'low',
      },
      [validWorkspace]: {
        maxConcurrent: 6,
        budgetCostUsd: 2.5,
      },
    },
  });

  assert.deepEqual(getSubagentConfig('project', invalidWorkspace), {
    defaultThinking: 'low',
    maxThinking: 'low',
    allowedTools: ['grep'],
  });
  assert.deepEqual(getSubagentConfig('project', conflictWorkspace), {});
  assert.deepEqual(getSubagentConfig('project', validWorkspace), {
    maxConcurrent: 6,
    budgetCostUsd: 2.5,
  });

  const repaired = readStoredSetting(KEYS.subagents).value;
  assert.equal(repaired.version, 2);
  assert.equal(Object.hasOwn(repaired.projects, 'relative'), false);
  assert.equal(Object.hasOwn(repaired.projects[invalidWorkspace], 'maxConcurrent'), false);
  assert.equal(Object.hasOwn(repaired.projects[invalidWorkspace], 'maxSpawns'), false);
  assertJsonRoundTrip(repaired);

  db.setSetting(KEYS.subagents, {
    version: 2,
    user: {
      defaultThinking: 'xhigh',
      maxThinking: 'low',
    },
    projects: {},
  });
  const user = getSubagentConfig('user');
  assert.equal(user.defaultThinking, 'low');
  assert.equal(user.maxThinking, 'low');
  assertJsonRoundTrip(readStoredSetting(KEYS.subagents).value);
});

test('runtime policy distinguishes corrupt types from numeric out-of-range values', () => {
  const db = getStudioDatabase();
  db.setSetting(KEYS.runtimePolicy, {
    streamTimeoutMs: -1,
    retry: {
      enabled: 'false',
      maxRetries: '12',
      baseDelayMs: null,
    },
    compaction: {
      enabled: null,
      reserveTokens: null,
      keepRecentTokens: -1,
      backgroundTokens: '0',
      autoCompactPercent: null,
    },
    restartLimit: true,
    longTask: {
      maxContinuations: 999,
      maxStalledContinuations: '',
    },
    contextRetentionMs: null,
    documentRetentionMs: -1,
  });

  const policy = getRuntimePolicy();
  assert.equal(policy.streamTimeoutMs, 0);
  assert.deepEqual(policy.retry, {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
  });
  assert.deepEqual(policy.compaction, {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 0,
    backgroundTokens: 32_768,
    autoCompactPercent: 85,
  });
  assert.equal(policy.restartLimit, 5);
  assert.deepEqual(policy.longTask, {
    maxContinuations: 500,
    maxStalledContinuations: 3,
  });
  assert.equal(policy.contextRetentionMs, 90_000);
  assert.equal(policy.documentRetentionMs, 0);
  assertJsonRoundTrip(readStoredSetting(KEYS.runtimePolicy).value);
});

test('extension session order maps reject reserved keys and registry URLs canonicalize', () => {
  const db = getStudioDatabase();
  const sessionOrders = Object.fromEntries([
    ['session', ['project:beta', 'project:beta', 'invalid']],
    ['empty', []],
    ['__proto__', ['user:alpha']],
    ['prototype', ['user:alpha']],
    ['constructor', ['user:alpha']],
  ]);
  db.setSetting(KEYS.conversationExtensionUi, {
    layout: 'magazine',
    globalOrder: ['user:alpha', 'user:alpha', 42, 'bad'],
    sessionOrders,
  });
  db.setSetting(KEYS.extensionRegistryUrl, 'http://registry.example/catalog.json');

  const extensionUi = getConversationExtensionUiPreferences();
  assert.equal(extensionUi.layout, 'grid');
  assert.deepEqual(extensionUi.globalOrder, ['user:alpha']);
  assert.deepEqual(extensionUi.sessionOrders, {
    session: ['project:beta'],
  });
  assert.equal(getExtensionRegistryUrl(), '');
  assertJsonRoundTrip(readStoredSetting(KEYS.conversationExtensionUi).value);
  assert.equal(readStoredSetting(KEYS.extensionRegistryUrl).value, '');
});

test('a compare-and-set repair never overwrites a concurrently replaced value', () => {
  const db = getStudioDatabase();
  db.setSetting(KEYS.palette, 'amber');
  const result = db.getSettingWithRecovery(
    KEYS.palette,
    'lime',
    () => {
      db.setSetting(KEYS.palette, 'ocean');
      return 'lime';
    },
  );
  assert.equal(result, 'lime');
  assert.equal(readStoredSetting(KEYS.palette).value, 'ocean');
});

test('a failed repair still returns a safe preference value', () => {
  const db = getStudioDatabase();
  writeRawSetting(KEYS.theme, '{broken');
  db.db.exec(`
    CREATE TRIGGER fail_theme_recovery
    BEFORE UPDATE ON settings
    WHEN OLD.key = 'studio.app.theme'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic preference write failure');
    END
  `);
  try {
    assert.equal(getTheme(), 'light');
    assert.equal(
      db.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEYS.theme).value,
      '{broken',
    );
  } finally {
    db.db.exec('DROP TRIGGER fail_theme_recovery');
  }
});
