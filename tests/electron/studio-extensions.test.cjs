const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-user-extensions-'));
process.env.PI_STUDIO_DB = path.join(userRoot, 'studio.sqlite');
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => userRoot } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const studioExtensions = require('../../electron/services/studio-extensions.cjs');
Module._load = originalLoad;

const {
  assertSymlinkTreeContained,
  composerCommandsFromSnapshot,
  dependencyGraph,
  dependencyOrder,
  ensureStudioExtensionIntegrity,
  extensionHealthForRows,
  importStudioExtension,
  loadRuntimeExtension,
  managementState,
  normalizeCommandResult,
  normalizeManifest,
  scanStudioExtensions,
  setStudioExtensionTrusted,
  syncStudioExtensions,
  toolConflictDiagnostics,
} = studioExtensions;
const { openChildConversation } = require('../../electron/services/durable-subagents.cjs');

after(() => fs.rmSync(userRoot, { recursive: true, force: true }));

function manifest(overrides = {}) {
  return {
    format: 1,
    id: 'demo.extension',
    name: 'Demo',
    version: '1.0.0',
    permissions: [],
    runtime: { durableEntry: '' },
    contributes: {},
    ...overrides,
  };
}

function writeEntry(directory, source) {
  fs.writeFileSync(path.join(directory, 'extension.mjs'), source);
}

function runtimeRow(directory, contributionCommands) {
  return {
    id: 'user:demo.extension',
    scope: 'user',
    source: path.join(directory, 'pi-studio.extension.json'),
    updatedAt: 1,
    manifest: {
      id: 'demo.extension',
      permissions: ['agent.tools', 'ui.commands'],
      runtime: { durableEntry: 'extension.mjs' },
      contributes: {
        commands: contributionCommands,
      },
    },
  };
}

test('manifest rejects duplicate contribution identities within one extension', () => {
  const cases = [
    {
      name: 'tools',
      permissions: ['agent.tools'],
      runtime: { durableEntry: './extension.mjs' },
      contributes: { tools: [{ name: 'search' }, { name: 'search' }] },
      message: /tools 贡献重复：search/,
    },
    {
      name: 'commands',
      permissions: ['ui.commands'],
      contributes: {
        commands: [
          { id: 'open', title: 'Open', action: { kind: 'openSettings' } },
          { id: 'open', title: 'Open again', action: { kind: 'openSettings' } },
        ],
      },
      message: /commands 贡献重复：open/,
    },
    {
      name: 'panels',
      permissions: ['ui.panels'],
      contributes: {
        panels: [
          { id: 'main', title: 'Main', slot: 'panel.side', content: [] },
          { id: 'main', title: 'Main again', slot: 'panel.side', content: [] },
        ],
      },
      message: /panels 贡献重复：main/,
    },
    {
      name: 'settings',
      permissions: ['ui.settings'],
      contributes: {
        settings: [
          { id: 'prefs', title: 'Prefs', content: [] },
          { id: 'prefs', title: 'Prefs again', content: [] },
        ],
      },
      message: /settings 贡献重复：prefs/,
    },
    {
      name: 'composer',
      permissions: ['ui.commands'],
      contributes: {
        commands: [
          { id: 'run', title: 'Run', action: { kind: 'openSettings' } },
        ],
        composer: [
          { id: 'run-action', title: 'Run', action: 'run' },
          { id: 'run-action', title: 'Run again', action: 'run' },
        ],
      },
      message: /composer 贡献重复：run-action/,
    },
  ];

  for (const item of cases) {
    assert.throws(
      () => normalizeManifest(manifest({
        permissions: item.permissions,
        runtime: item.runtime || { durableEntry: '' },
        contributes: item.contributes,
      }), '/tmp/demo', 'user'),
      item.message,
      item.name,
    );
  }
});

test('manifest rejects unknown contribution, action and non-builtin tier fields', () => {
  assert.throws(() => normalizeManifest(manifest({
    tier: 'core',
  }), '/tmp/demo', 'user'), /只有内置扩展可以声明 tier/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'open',
        title: 'Open',
        action: { kind: 'openSettings', panel: 'extensions' },
        style: 'color: red',
      }],
    },
  }), '/tmp/demo', 'user'), /commands\[0\].*未知字段：style/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'open',
        title: 'Open',
        action: {
          kind: 'openSettings',
          panel: 'extensions',
          onClick: 'alert(1)',
        },
      }],
    },
  }), '/tmp/demo', 'user'), /UI action.*未知字段：onClick/);
});

test('manifest rejects contribution ids reused across UI contribution kinds', () => {
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands', 'ui.panels'],
    contributes: {
      commands: [{ id: 'inspect', title: 'Inspect', action: { kind: 'openSettings' } }],
      panels: [{ id: 'inspect', title: 'Inspect panel', slot: 'panel.side', content: [] }],
    },
  }), '/tmp/demo', 'user'), /贡献 ID 跨类型重复：inspect/);
});

test('manifest reports invalid UI contributions instead of silently dropping them', () => {
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.panels'],
    contributes: {
      panels: [{ id: 'floating', title: 'Floating', slot: 'made.up', content: [] }],
    },
  }), '/tmp/demo', 'user'), /panels\[0\] 未知 slot：made\.up/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'unsafe',
        title: 'Unsafe',
        action: { kind: 'runJavaScript', source: 'alert(1)' },
      }],
    },
  }), '/tmp/demo', 'user'), /commands\[0\] action 无效/);

  assert.throws(() => normalizeManifest(manifest({
    contributes: { typo: [] },
  }), '/tmp/demo', 'user'), /未知 contribution 类型：typo/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.settings'],
    contributes: {
      settings: [{
        id: 'broken',
        title: 'Broken content',
        content: [{ kind: 'html', text: '<script />' }],
      }],
    },
  }), '/tmp/demo', 'user'), /UI list\.items\[0\]\.kind 不支持 kind html/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'typo-page',
        title: 'Typo page',
        action: { kind: 'openSettings', panel: 'modelz' },
      }],
    },
  }), '/tmp/demo', 'user'), /openSettings\.panel 无效：modelz/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'bad-icon',
        title: 'Bad icon',
        icon: '<svg>',
        action: { kind: 'openSettings' },
      }],
    },
  }), '/tmp/demo', 'user'), /commands\[0\]\.icon 无效/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.settings'],
    contributes: {
      settings: [{
        id: 'partial-list',
        title: 'Partial list',
        content: [{
          kind: 'list',
          items: [{ text: 'valid' }, { text: '' }],
        }],
      }],
    },
  }), '/tmp/demo', 'user'), /UI list\.items\[0\]\.items\[1\]\.text 不能为空/);
});

test('manifest canonicalizes external HTTP URLs and rejects unsafe schemes or credentials', () => {
  const normalized = normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'docs',
        title: 'Docs',
        action: { kind: 'openUrl', url: '  https://example.com/docs?q=pi  ' },
      }],
    },
  }), '/tmp/demo', 'user');
  assert.equal(
    normalized.contributes.commands[0].action.url,
    'https://example.com/docs?q=pi',
  );

  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/secret',
    'https://user:secret@example.com/',
    'https://example.com/\nnext',
  ]) {
    assert.throws(() => normalizeManifest(manifest({
      permissions: ['ui.commands'],
      contributes: {
        commands: [{
          id: 'unsafe',
          title: 'Unsafe URL',
          action: { kind: 'openUrl', url },
        }],
      },
    }), '/tmp/demo', 'user'));
  }
});

test('manifest UI actions stay inside the declaring extension and required permissions', () => {
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands', 'ui.panels'],
    contributes: {
      commands: [{ id: 'known', title: 'Known', action: { kind: 'openSettings' } }],
      panels: [{
        id: 'main',
        title: 'Main',
        slot: 'panel.side',
        content: [{
          kind: 'actions',
          buttons: [{
            id: 'other-command',
            label: 'Other',
            action: { kind: 'runCommand', commandId: 'user:other/run' },
          }],
        }],
      }],
    },
  }), '/tmp/demo', 'user'), /action 无效/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands', 'ui.panels'],
    contributes: {
      commands: [{ id: 'known', title: 'Known', action: { kind: 'openSettings' } }],
      panels: [{
        id: 'main',
        title: 'Main',
        slot: 'panel.side',
        content: [{
          kind: 'actions',
          buttons: [{
            id: 'other-panel',
            label: 'Other',
            action: { kind: 'openPanel', panelId: 'user:other/detail' },
          }],
        }],
      }],
    },
  }), '/tmp/demo', 'user'), /action 无效/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.panels'],
    contributes: {
      panels: [{
        id: 'main',
        title: 'Main',
        slot: 'panel.side',
        content: [{
          kind: 'actions',
          buttons: [{
            id: 'run-without-permission',
            label: 'Run',
            action: { kind: 'runCommand', commandId: 'main' },
          }],
        }],
      }],
    },
  }), '/tmp/demo', 'user'), /runCommand action 需要 ui\.commands 权限/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    runtime: { durableEntry: './extension.mjs' },
    contributes: {
      commands: [
        { id: 'delegated', title: 'Delegated' },
        {
          id: 'static-action',
          title: 'Static action',
          action: { kind: 'openSettings' },
        },
        {
          id: 'loop',
          title: 'Loop',
          action: { kind: 'runCommand', commandId: 'static-action' },
        },
      ],
    },
  }), '/tmp/demo', 'user'), /只能调用带 runtime handler 的命令/);
});

test('composer must reference a command declared by the same extension', () => {
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    contributes: {
      commands: [{ id: 'known', title: 'Known', action: { kind: 'openSettings' } }],
      composer: [{ id: 'unknown-action', title: 'Unknown', action: 'missing' }],
    },
  }), '/tmp/demo', 'user'), /引用了未声明的 command：missing/);
});

test('a command-only runtime may declare ui.commands without agent permissions', () => {
  const normalized = normalizeManifest(manifest({
    permissions: ['ui.commands'],
    runtime: { durableEntry: './extension.mjs' },
    contributes: {
      commands: [{ id: 'hello', title: 'Hello' }],
    },
  }), '/tmp/demo', 'user');
  assert.equal(normalized.runtime.durableEntry, './extension.mjs');
  assert.deepEqual(normalized.permissions, ['ui.commands']);
});

test('conversation detail and footer use separate layouts', () => {
  const normalized = normalizeManifest(manifest({
    permissions: ['ui.panels'],
    contributes: {
      panels: [
        {
          id: 'detail',
          title: '详情',
          slot: 'conversation.detail',
          content: [{
            kind: 'metricGrid',
            metrics: [{
              id: 'weekly',
              label: '本周',
              value: 11,
              unit: '%',
            }],
          }],
        },
        {
          id: 'footer',
          title: '摘要',
          slot: 'conversation.footer',
          content: [
            { kind: 'text', text: '额度 11%' },
            { kind: 'badge', label: '正常', tone: 'success' },
          ],
        },
      ],
    },
  }), '/tmp/demo', 'user');

  assert.deepEqual(
    normalized.contributes.panels.map((panel) => panel.slot),
    ['conversation.detail', 'conversation.footer'],
  );
  assert.equal(normalized.contributes.panels[0].content[0].kind, 'metricGrid');
  assert.equal(normalized.contributes.panels[1].content.length, 2);

  for (const content of [
    [{ kind: 'heading', text: '完整详情' }],
    [{ kind: 'list', items: [{ text: '第一项' }] }],
    [{ kind: 'metricGrid', metrics: [{ id: 'x', label: 'X', value: 1 }] }],
    [{
      kind: 'actions',
      buttons: [{
        id: 'refresh',
        label: '刷新',
        action: { kind: 'openSettings', panel: 'extensions' },
      }],
    }],
  ]) {
    assert.throws(() => normalizeManifest(manifest({
      permissions: ['ui.panels'],
      contributes: {
        panels: [{
          id: 'footer',
          title: '摘要',
          slot: 'conversation.footer',
          content,
        }],
      },
    }), '/tmp/demo', 'user'), /conversation\.footer 不支持/);
  }

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.panels'],
    contributes: {
      panels: [{
        id: 'footer',
        title: '摘要',
        slot: 'conversation.footer',
        content: [
          { kind: 'text', text: '一' },
          { kind: 'text', text: '二' },
          { kind: 'text', text: '三' },
        ],
      }],
    },
  }), '/tmp/demo', 'user'), /一至两个单行摘要/);
});

test('live data sources require ui.data, a runtime entry and same-extension dataViews', () => {
  const normalized = normalizeManifest(manifest({
    permissions: ['ui.panels', 'ui.data'],
    runtime: { durableEntry: './extension.mjs' },
    contributes: {
      dataSources: [{ id: 'live', title: 'Live data' }],
      panels: [{
        id: 'metrics',
        title: 'Metrics',
        slot: 'conversation.footer',
        content: [{
          kind: 'dataView',
          sourceId: 'user:demo.extension/live',
          fallback: [{ kind: 'text', text: 'Waiting' }],
        }],
      }],
    },
  }), '/tmp/demo', 'user');
  assert.deepEqual(normalized.contributes.dataSources, [{
    id: 'live',
    title: 'Live data',
    description: '',
  }]);
  assert.equal(
    normalized.contributes.panels[0].content[0].sourceId,
    'user:demo.extension/live',
  );

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.panels', 'ui.data'],
    contributes: {
      dataSources: [{ id: 'live', title: 'Live data' }],
      panels: [{
        id: 'metrics',
        title: 'Metrics',
        slot: 'conversation.footer',
        content: [{ kind: 'dataView', sourceId: 'user:demo.extension/live' }],
      }],
    },
  }), '/tmp/demo', 'user'), /dataSources contribution 需要 runtime\.durableEntry/);

  assert.throws(() => normalizeManifest(manifest({
    runtime: { durableEntry: './extension.mjs' },
    contributes: {
      dataSources: [{ id: 'live', title: 'Live data' }],
    },
  }), '/tmp/demo', 'user'), /dataSources contribution 需要 ui\.data 权限/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.data'],
    runtime: { durableEntry: './extension.mjs' },
  }), '/tmp/demo', 'user'), /声明 ui\.data 权限时必须提供 contributes\.dataSources/);

  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.panels', 'ui.data'],
    runtime: { durableEntry: './extension.mjs' },
    contributes: {
      dataSources: [{ id: 'live', title: 'Live data' }],
      panels: [{
        id: 'metrics',
        title: 'Metrics',
        slot: 'conversation.footer',
        content: [{ kind: 'dataView', sourceId: 'user:other/live' }],
      }],
    },
  }), '/tmp/demo', 'user'), /dataView 引用了未声明或跨扩展的数据源/);
});

test('project extensions are reported as untrusted by default', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-project-extensions-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const directory = path.join(cwd, '.pi-studio', 'extensions', 'demo.extension');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'pi-studio.extension.json'),
    JSON.stringify(manifest()),
  );

  const snapshot = scanStudioExtensions(cwd);
  assert.equal(snapshot.errors.length, 0);
  assert.equal(snapshot.manifests.length, 1);
  assert.equal(snapshot.manifests[0].scope, 'project');
  assert.equal(snapshot.manifests[0].trustedDefault, false);
});

test('project extension trust is invalidated when code changes without a version bump', (t) => {
  const { getStudioDatabase } = require('../../electron/core/studio-db.cjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-project-trust-'));
  const directory = path.join(cwd, '.pi-studio', 'extensions', 'trust-fingerprint');
  const id = 'project:trust-fingerprint';
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'pi-studio.extension.json'),
    JSON.stringify(manifest({
      id: 'trust-fingerprint',
    })),
  );
  fs.writeFileSync(path.join(directory, 'extension.mjs'), 'export const version = 1;\n');
  t.after(() => {
    getStudioDatabase().removeExtension(id);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const initial = syncStudioExtensions(cwd).rows.find((row) => row.id === id);
  assert.equal(initial.trusted, false);
  assert.match(initial.contentHash, /^[a-f0-9]{64}$/);

  const trusted = setStudioExtensionTrusted(id, true, cwd);
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.contentHash, initial.contentHash);
  assert.equal(syncStudioExtensions(cwd).rows.find((row) => row.id === id).trusted, true);

  fs.writeFileSync(path.join(directory, 'extension.mjs'), 'export const version = 2;\n');
  const changed = syncStudioExtensions(cwd).rows.find((row) => row.id === id);
  assert.equal(changed.trusted, false);
  assert.notEqual(changed.contentHash, initial.contentHash);
});

test('submission-time integrity verification unloads changed project extensions and dependents once', async (t) => {
  const { getStudioDatabase } = require('../../electron/core/studio-db.cjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-project-runtime-integrity-'));
  const root = path.join(cwd, '.pi-studio', 'extensions');
  const baseDirectory = path.join(root, 'runtime-base');
  const consumerDirectory = path.join(root, 'runtime-consumer');
  const baseId = 'project:runtime-base';
  const consumerId = 'project:runtime-consumer';
  fs.mkdirSync(baseDirectory, { recursive: true });
  fs.mkdirSync(consumerDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(baseDirectory, 'pi-studio.extension.json'),
    JSON.stringify(manifest({
      id: 'runtime-base',
      name: 'Runtime Base',
      permissions: ['agent.tools'],
      runtime: { durableEntry: 'extension.mjs' },
    })),
  );
  fs.writeFileSync(
    path.join(baseDirectory, 'extension.mjs'),
    "export const durableExtension = { name: 'runtime-base', tools: [] };\n",
  );
  fs.writeFileSync(
    path.join(consumerDirectory, 'pi-studio.extension.json'),
    JSON.stringify(manifest({
      id: 'runtime-consumer',
      name: 'Runtime Consumer',
      permissions: ['agent.tools'],
      requires: [baseId],
      runtime: { durableEntry: 'extension.mjs' },
    })),
  );
  fs.writeFileSync(
    path.join(consumerDirectory, 'extension.mjs'),
    "export const durableExtension = { name: 'runtime-consumer', tools: [] };\n",
  );

  const installed = new Map();
  const runtime = {
    registry: {
      install(extension) {
        installed.set(extension.name, extension);
      },
      uninstall(extension) {
        installed.delete(extension.name);
      },
    },
    builtinExtensions: new Map(),
  };
  t.after(async () => {
    await studioExtensions.uninstallStudioExtensions();
    getStudioDatabase().removeExtension(baseId);
    getStudioDatabase().removeExtension(consumerId);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  syncStudioExtensions(cwd);
  setStudioExtensionTrusted(baseId, true, cwd);
  setStudioExtensionTrusted(consumerId, true, cwd);
  await studioExtensions.reloadStudioExtensions(runtime, cwd);
  assert.deepEqual(
    [...installed.keys()].sort(),
    ['studio-extension:project:runtime-base', 'studio-extension:project:runtime-consumer'],
  );

  fs.writeFileSync(
    path.join(baseDirectory, 'extension.mjs'),
    "export const durableExtension = { name: 'runtime-base', tools: [], version: 2 };\n",
  );
  const results = await Promise.all([
    ensureStudioExtensionIntegrity(runtime, cwd),
    ensureStudioExtensionIntegrity(runtime, cwd),
  ]);
  assert.equal(results.filter((item) => item.reloaded).length, 1);
  assert.equal(installed.size, 0);
  assert.equal(getStudioDatabase().getExtension(baseId).trusted, false);
  const snapshot = studioExtensions.extensionHostSnapshot();
  const consumer = snapshot.extensions.find((item) => item.id === consumerId);
  assert.equal(consumer.available, false);
  assert.deepEqual(consumer.untrustedDependencies, [baseId]);
});

test('submission-time integrity verification rejects tampered managed project code', async (t) => {
  const { getStudioDatabase } = require('../../electron/core/studio-db.cjs');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-managed-integrity-'));
  const source = path.join(cwd, 'source-package');
  const extensionId = 'managed.integrity';
  const stableId = `project:${extensionId}`;
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'pi-studio.extension.json'),
    JSON.stringify(manifest({
      id: extensionId,
      name: 'Managed Integrity',
      publisher: 'pi-studio-tests',
      permissions: ['agent.tools'],
      runtime: { durableEntry: 'extension.mjs' },
    })),
  );
  fs.writeFileSync(
    path.join(source, 'extension.mjs'),
    "export const durableExtension = { name: 'managed-integrity', tools: [] };\n",
  );

  const installs = studioExtensions.extensionDistributionService();
  const preview = await installs.prepare(source, { scope: 'project', cwd });
  const installed = await installs.installPrepared(preview.token, {
    scope: 'project',
    cwd,
    acceptedPermissions: ['agent.tools'],
  });
  const registryItems = new Map();
  const runtime = {
    registry: {
      install(extension) {
        registryItems.set(extension.name, extension);
      },
      uninstall(extension) {
        registryItems.delete(extension.name);
      },
    },
    builtinExtensions: new Map(),
  };
  t.after(async () => {
    await studioExtensions.uninstallStudioExtensions();
    try {
      await installs.uninstall(extensionId, {
        scope: 'project',
        cwd,
        preserveData: false,
        force: true,
      });
    } finally {
      getStudioDatabase().removeExtension(stableId);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  const synced = syncStudioExtensions(cwd);
  assert.deepEqual(synced.errors, []);
  assert.ok(synced.rows.some((row) => row.id === stableId));
  setStudioExtensionTrusted(stableId, true, cwd);
  await studioExtensions.reloadStudioExtensions(runtime, cwd);
  assert.equal(registryItems.size, 1);

  fs.appendFileSync(
    path.join(installed.activeCodePath, 'extension.mjs'),
    '\nexport const tampered = true;\n',
  );
  const result = await ensureStudioExtensionIntegrity(runtime, cwd);
  assert.equal(result.reloaded, true);
  assert.equal(registryItems.size, 0);
  assert.equal(getStudioDatabase().getExtension(stableId).trusted, false);
  const snapshot = studioExtensions.extensionHostSnapshot();
  assert.equal(snapshot.extensions.find((item) => item.id === stableId).available, false);
  assert.ok(
    snapshot.errors.some((error) => (
      error.id === stableId && /长度|摘要|SHA-256/.test(error.message)
    )),
    JSON.stringify(snapshot.errors),
  );
});

test('module exports can keep command handlers outside the Durable extension', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    export const durableExtension = { name: 'demo', tools: [], commands: { stray: () => 'stray' } };
    export const commands = new Map([['hello', () => 'ok']]);
  `);

  const loaded = await loadRuntimeExtension(runtimeRow(directory, [
    { id: 'hello', title: 'Hello' },
  ]));
  assert.equal(loaded.extension.name, 'studio-extension:user:demo.extension');
  assert.equal(Object.hasOwn(loaded.extension, 'commands'), false);
  assert.equal(loaded.handlers.get('hello')(), 'ok');
  assert.equal(loaded.handlers.has('stray'), false);
});

test('a live-data provider can load without a Durable extension', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-data-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    export const dataSources = {
      live: {
        async read(context) {
          return [{ kind: 'text', text: 'session:' + context.sessionId }];
        },
        subscribe(_context, emit) {
          emit([{ kind: 'text', text: 'updated' }]);
          return () => {};
        },
      },
    };
  `);

  const row = runtimeRow(directory, []);
  row.manifest.permissions = ['ui.data'];
  row.manifest.contributes.dataSources = [{ id: 'live', title: 'Live data' }];
  const loaded = await loadRuntimeExtension(row);
  assert.equal(loaded.extension, undefined);
  assert.equal(loaded.handlers.size, 0);
  assert.deepEqual(
    await loaded.dataSources.get('live').read({ sessionId: '12' }),
    [{ kind: 'text', text: 'session:12' }],
  );
});

test('activate can return a Durable extension plus command handlers', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-activate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    export async function activate(context) {
      return {
        durableExtension: { name: 'demo', tools: [] },
        commands: { hello: async () => context.extensionId },
      };
    }
  `);

  const loaded = await loadRuntimeExtension(runtimeRow(directory, [
    { id: 'hello', title: 'Hello' },
  ]));
  assert.equal(await loaded.handlers.get('hello')(), 'user:demo.extension');
  assert.equal(Object.hasOwn(loaded.extension, 'commands'), false);
});

test('provider credentials are exact, read-only and hot after credential changes', async (t) => {
  const { getStudioDatabase } = require('../../electron/core/studio-db.cjs');
  const database = getStudioDatabase();
  const allowedProvider = 'quota-capability-allowed';
  const deniedProvider = 'quota-capability-denied';
  database.upsertProvider({
    id: allowedProvider,
    name: 'Allowed provider',
    baseUrl: 'https://allowed.example/v1',
    api: 'openai-completions',
  });
  database.upsertProvider({
    id: deniedProvider,
    name: 'Denied provider',
    baseUrl: 'https://denied.example/v1',
    api: 'openai-completions',
  });
  database.writeCredential(allowedProvider, { type: 'api_key', key: 'allowed-key-v1' });
  database.writeCredential(deniedProvider, { type: 'api_key', key: 'denied-key' });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-provider-credentials-'));
  let capability;
  writeEntry(directory, `
    export async function activate(context) {
      globalThis.__piStudioCredentialCapability = context.providerCredentials;
      return {
        commands: {
          read: async () => context.providerCredentials.read('${allowedProvider}'),
        },
      };
    }
  `);
  const row = runtimeRow(directory, [{ id: 'read', title: 'Read' }]);
  row.manifest.permissions = ['ui.commands', 'provider.credentials'];
  row.manifest.providerAccess = [allowedProvider];
  row.id = 'user:quota-capability';
  row.manifest.id = 'quota-capability';

  const loaded = await loadRuntimeExtension(row);
  capability = globalThis.__piStudioCredentialCapability;
  delete globalThis.__piStudioCredentialCapability;
  t.after(async () => {
    await loaded.cleanup();
    database.deleteCredential(allowedProvider);
    database.deleteCredential(deniedProvider);
    database.deleteProvider(allowedProvider);
    database.deleteProvider(deniedProvider);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const first = await loaded.handlers.get('read')();
  assert.deepEqual(first, {
    providerId: allowedProvider,
    type: 'api_key',
    apiKey: 'allowed-key-v1',
    baseUrl: 'https://allowed.example/v1',
  });
  database.writeCredential(allowedProvider, { type: 'api_key', key: 'allowed-key-v2' });
  assert.equal((await loaded.handlers.get('read')()).apiKey, 'allowed-key-v2');
  await assert.rejects(
    capability.read(deniedProvider),
    /没有被授权读取模型来源凭证/,
  );
  assert.equal(typeof capability.list, 'undefined');
  assert.equal(typeof capability.write, 'undefined');
  assert.equal(typeof capability.delete, 'undefined');
  assert.deepEqual(capability.allowedProviderIds, [allowedProvider]);
});

test('credential capability requires activate and an exact provider allowlist', async (t) => {
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['provider.credentials'],
    runtime: { durableEntry: 'extension.mjs' },
  }), '/tmp/demo', 'user'), /providerAccess/);
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['ui.commands'],
    providerAccess: ['deepseek'],
    runtime: { durableEntry: 'extension.mjs' },
  }), '/tmp/demo', 'user'), /providerAccess 需要 provider\.credentials/);
  assert.throws(() => normalizeManifest(manifest({
    permissions: ['provider.credentials'],
    providerAccess: ['deepseek'],
  }), '/tmp/demo', 'user'), /runtime\.durableEntry/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-provider-activate-'));
  writeEntry(directory, "export const commands = { read: () => 'unsafe' };\n");
  const row = runtimeRow(directory, [{ id: 'read', title: 'Read' }]);
  row.manifest.permissions = ['ui.commands', 'provider.credentials'];
  row.manifest.providerAccess = ['deepseek'];
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    loadRuntimeExtension(row),
    /只能通过 activate\(context\) 获取/,
  );
});

test('activation cleanup runs before module deactivation exactly once, even after a failure', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    import fs from 'node:fs';
    import path from 'node:path';
    const append = (context, value) => {
      fs.appendFileSync(path.join(context.dataDirectory, 'cleanup.log'), value + '\\n');
    };
    export async function activate(context) {
      return {
        durableExtension: { name: 'demo', tools: [] },
        cleanup() {
          append(context, 'activation');
          throw new Error('expected cleanup failure');
        },
      };
    }
    export function deactivate(context) {
      append(context, 'deactivate');
    }
  `);

  const loaded = await loadRuntimeExtension(runtimeRow(directory, []));
  await Promise.all([loaded.cleanup(), loaded.cleanup()]);
  await loaded.cleanup();
  assert.deepEqual(
    fs.readFileSync(path.join(directory, '.data', 'cleanup.log'), 'utf8').trim().split('\n'),
    ['activation', 'deactivate'],
  );
});

test('failed runtime validation still releases resources acquired by activate', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-cleanup-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    import fs from 'node:fs';
    import path from 'node:path';
    export async function activate(context) {
      return {
        durableExtension: { name: 'demo', tools: [{ name: 'undeclared' }] },
        cleanup() {
          fs.writeFileSync(path.join(context.dataDirectory, 'cleaned'), 'yes');
        },
      };
    }
  `);
  const row = runtimeRow(directory, []);
  row.manifest.permissions = ['agent.tools'];
  row.manifest.contributes.tools = [];
  await assert.rejects(loadRuntimeExtension(row), /未在 manifest\.contributes\.tools 中声明/);
  assert.equal(fs.readFileSync(path.join(directory, '.data', 'cleaned'), 'utf8'), 'yes');
});

test('a command without an action must have a registered handler', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-extension-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    export const durableExtension = { name: 'demo', tools: [] };
  `);
  await assert.rejects(
    loadRuntimeExtension(runtimeRow(directory, [{ id: 'missing', title: 'Missing' }])),
    /扩展命令缺少处理器：missing/,
  );
});

test('import rejects a manifest symlink that escapes the source directory', (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-import-source-'));
  const outside = path.join(os.tmpdir(), `pi-studio-secret-${process.pid}-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });
  fs.writeFileSync(outside, JSON.stringify(manifest()));
  fs.symlinkSync(outside, path.join(source, 'pi-studio.extension.json'));

  assert.throws(
    () => importStudioExtension(source, 'user'),
    /包含越界符号链接/,
  );
});

test('scan reports a manifest symlink escape instead of loading it', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-scan-symlink-'));
  const outside = path.join(os.tmpdir(), `pi-studio-scan-secret-${process.pid}-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });
  const directory = path.join(cwd, '.pi-studio', 'extensions', 'demo.extension');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(outside, JSON.stringify(manifest()));
  fs.symlinkSync(outside, path.join(directory, 'pi-studio.extension.json'));

  const snapshot = scanStudioExtensions(cwd);
  assert.equal(snapshot.manifests.length, 0);
  assert.match(snapshot.errors[0]?.message || '', /不能通过符号链接越界/);
});

test('runtime entry symlinks are checked against the extension root when loading', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-entry-symlink-'));
  const outside = path.join(os.tmpdir(), `pi-studio-entry-secret-${process.pid}-${Date.now()}.mjs`);
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });
  fs.writeFileSync(outside, 'export const durableExtension = { name: "outside", tools: [] };');
  fs.symlinkSync(outside, path.join(directory, 'extension.mjs'));

  await assert.rejects(
    loadRuntimeExtension(runtimeRow(directory, [])),
    /扩展入口必须位于扩展目录内|包含越界符号链接/,
  );
});

test('symlink tree checks allow relative links that stay inside the extension', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-safe-symlink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'manifest.real.json'), JSON.stringify(manifest()));
  fs.symlinkSync('manifest.real.json', path.join(directory, 'pi-studio.extension.json'));
  assert.equal(assertSymlinkTreeContained(directory), fs.realpathSync(directory));
});

test('command result panelId is confined to a panel declared by that extension', () => {
  const row = {
    id: 'user:demo.extension',
    scope: 'user',
    manifest: {
      id: 'demo.extension',
      permissions: ['ui.panels'],
      contributes: { panels: [{ id: 'main' }] },
    },
  };
  assert.deepEqual(normalizeCommandResult({ panelId: 'user:demo.extension/main' }, row), {
    ok: true,
    panelId: 'user:demo.extension/main',
  });
  assert.throws(
    () => normalizeCommandResult({ panelId: 'user:other/main' }, row),
    /未在本扩展声明/,
  );
  assert.throws(
    () => normalizeCommandResult({ panelId: 'user:demo.extension/main' }, {
      ...row,
      manifest: { ...row.manifest, permissions: [] },
    }),
    /未在本扩展声明/,
  );
});

test('command results accept only whitelisted UI actions', () => {
  const row = {
    id: 'user:demo.extension',
    scope: 'user',
    manifest: {
      id: 'demo.extension',
      permissions: ['ui.commands', 'ui.panels'],
      contributes: {
        commands: [
          { id: 'runtime-command', title: 'Runtime' },
          { id: 'static-command', title: 'Static', action: { kind: 'openSettings' } },
        ],
        panels: [{ id: 'detail', title: 'Detail' }],
      },
    },
  };
  assert.deepEqual(normalizeCommandResult({
    action: { kind: 'openSettings', panel: 'tools' },
  }, row), {
    ok: true,
    action: { kind: 'openSettings', panel: 'tools' },
  });
  assert.throws(
    () => normalizeCommandResult({ action: { kind: 'runJavaScript', source: 'alert(1)' } }, row),
    /不受支持的 UI action/,
  );
  assert.throws(
    () => normalizeCommandResult({ action: { kind: 'openUrl', url: 'https://user:secret@example.com/' } }, row),
    /不能包含用户名或密码/,
  );
  assert.equal(
    normalizeCommandResult({ action: { kind: 'openUrl', url: '  https://example.com/docs  ' } }, row)
      .action.url,
    'https://example.com/docs',
  );
  assert.deepEqual(normalizeCommandResult({
    action: { kind: 'openPanel', panelId: 'user:demo.extension/detail' },
  }, row), {
    ok: true,
    action: { kind: 'openPanel', panelId: 'user:demo.extension/detail' },
  });
  assert.deepEqual(normalizeCommandResult({
    action: { kind: 'runCommand', commandId: 'runtime-command' },
  }, row), {
    ok: true,
    action: {
      kind: 'runCommand',
      commandId: 'user:demo.extension/runtime-command',
    },
  });
  assert.throws(
    () => normalizeCommandResult({
      action: { kind: 'runCommand', commandId: 'static-command' },
    }, row),
    /必须指向本扩展的 runtime 命令/,
  );
  assert.throws(
    () => normalizeCommandResult({
      action: { kind: 'openPanel', panelId: 'user:demo.extension/missing' },
    }, row),
    /未声明的 openPanel/,
  );
});

test('runtime tools and task primitives must match declared permissions and contributions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-runtime-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeEntry(directory, `
    export const durableExtension = {
      name: 'demo',
      tools: [{ name: 'undeclared_tool' }],
      sections: [{ key: 'hidden', render: () => 'hidden' }],
    };
  `);
  const row = runtimeRow(directory, []);
  row.manifest.permissions = ['agent.tools'];
  row.manifest.contributes.tools = [];
  await assert.rejects(
    loadRuntimeExtension(row),
    /未在 manifest\.contributes\.tools 中声明/,
  );

  row.manifest.contributes.tools = [{ name: 'undeclared_tool' }];
  await assert.rejects(
    loadRuntimeExtension(row),
    /未声明 agent\.sections 权限/,
  );
});

test('composer projection deduplicates identities that point at the same command', () => {
  const row = {
    id: 'user:demo.extension',
    scope: 'user',
    name: 'Demo',
    available: true,
    manifest: {
      id: 'demo.extension',
      permissions: ['ui.commands'],
      contributes: {
        commands: [{
          id: 'deploy',
          title: 'Deploy',
          description: '',
          placement: 'command-menu',
        }],
        composer: [{
          id: 'deploy-shortcut',
          title: 'Deploy shortcut',
          description: '',
          action: 'deploy',
        }],
      },
    },
  };
  const projected = composerCommandsFromSnapshot({ extensions: [row] });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].commandId, 'user:demo.extension/deploy');
});

test('manifest dependencies use stable IDs and tiers derive from trusted ownership', () => {
  const user = normalizeManifest(manifest({
    requires: ['builtin:studio-permissions', 'user:base.extension'],
  }), '/tmp/demo', 'user');
  assert.equal(user.tier, 'user');
  assert.deepEqual(user.requires, [
    'builtin:studio-permissions',
    'user:base.extension',
  ]);

  const project = normalizeManifest(manifest(), '/tmp/demo', 'project');
  assert.equal(project.tier, 'project');
  assert.deepEqual(project.requires, []);

  const builtin = normalizeManifest({
    ...manifest({
      id: 'system.extension',
      tier: 'system',
      permissions: ['agent.hooks'],
      requires: ['builtin:studio-permissions'],
    }),
  }, 'builtin:system.extension', 'builtin');
  assert.equal(builtin.tier, 'system');
  assert.deepEqual(builtin.requires, ['builtin:studio-permissions']);

  assert.throws(
    () => normalizeManifest(manifest({ requires: ['project:local.extension'] }), '/tmp/demo', 'user'),
    /用户扩展不能依赖项目扩展/,
  );
  assert.throws(
    () => normalizeManifest(manifest({ requires: ['user:demo.extension'] }), '/tmp/demo', 'user'),
    /扩展不能依赖自身/,
  );
});

function healthRow(id, options = {}) {
  return {
    id,
    scope: options.scope || id.slice(0, id.indexOf(':')),
    enabled: options.enabled !== false,
    trusted: options.trusted !== false,
    source: `builtin:${id}`,
    manifest: {
      id: id.slice(id.indexOf(':') + 1),
      tier: options.tier || id.slice(0, id.indexOf(':')),
      requires: options.requires || [],
      contributes: {},
    },
  };
}

test('dependency health reports missing, disabled, and cyclic extensions without silent failure', () => {
  const rows = [
    healthRow('builtin:studio-permissions', { tier: 'core' }),
    healthRow('builtin:durable-coding-tools', {
      tier: 'system',
      requires: ['builtin:studio-permissions'],
    }),
    healthRow('user:review-extension', {
      requires: ['builtin:durable-coding-tools', 'user:missing'],
    }),
    healthRow('user:cycle-a', { requires: ['user:cycle-b'] }),
    healthRow('user:cycle-b', { requires: ['user:cycle-a'] }),
    healthRow('project:base-extension', { trusted: false }),
    healthRow('project:consumer-extension', {
      requires: ['project:base-extension'],
    }),
  ];
  const graph = dependencyGraph(rows);
  const health = extensionHealthForRows(rows, graph);

  assert.equal(health.get('builtin:studio-permissions').available, true);
  assert.deepEqual(
    health.get('user:review-extension').missingDependencies,
    ['user:missing'],
  );
  assert.equal(health.get('user:cycle-a').health, 'cycle');
  assert.equal(health.get('user:cycle-b').available, false);
  assert.deepEqual(
    health.get('project:consumer-extension').untrustedDependencies,
    ['project:base-extension'],
  );

  const dependent = rows[1];
  const beforeDisable = managementState(dependent, graph);
  assert.equal(beforeDisable.canDisable, false);
  assert.deepEqual(beforeDisable.activeDependents, ['user:review-extension']);

  dependent.enabled = false;
  rows[2].enabled = false;
  const disabledGraph = dependencyGraph(rows);
  const disabledHealth = extensionHealthForRows(rows, disabledGraph);
  assert.equal(disabledHealth.get('builtin:durable-coding-tools').health, 'disabled');
  assert.deepEqual(
    disabledHealth.get('user:review-extension').disabledDependencies,
    ['builtin:durable-coding-tools'],
  );
  assert.equal(disabledHealth.get('user:review-extension').available, false);
  assert.equal(managementState(dependent, disabledGraph).canDisable, true);
});

test('dependency order installs prerequisites before dependents', () => {
  const rows = [
    healthRow('user:consumer', {
      requires: ['builtin:studio-harness', 'builtin:studio-permissions'],
    }),
    healthRow('builtin:studio-harness', {
      tier: 'system',
      requires: ['builtin:durable-coding-tools'],
    }),
    healthRow('builtin:durable-coding-tools', {
      tier: 'system',
      requires: ['builtin:studio-permissions'],
    }),
    healthRow('builtin:studio-permissions', { tier: 'core' }),
  ];
  const ordered = dependencyOrder(rows).map((row) => row.id);
  assert.ok(ordered.indexOf('builtin:studio-permissions') < ordered.indexOf('builtin:durable-coding-tools'));
  assert.ok(ordered.indexOf('builtin:durable-coding-tools') < ordered.indexOf('builtin:studio-harness'));
  assert.ok(ordered.indexOf('builtin:studio-harness') < ordered.indexOf('user:consumer'));
});

test('protected core and optional tools cannot be shadowed while system overrides stay visible', () => {
  const core = healthRow('builtin:core-tools', { tier: 'core' });
  core.manifest.contributes.tools = [{ name: 'protected_tool' }];
  const system = healthRow('builtin:system-tools', { tier: 'system' });
  system.manifest.contributes.tools = [{ name: 'extensible_tool' }];
  const optional = healthRow('builtin:optional-tools', { tier: 'optional' });
  optional.manifest.contributes.tools = [{ name: 'optional_protected_tool' }];
  const user = healthRow('user:replacement');
  user.manifest.contributes.tools = [
    { name: 'protected_tool' },
    { name: 'extensible_tool' },
    { name: 'optional_protected_tool' },
  ];
  const rows = [core, system, optional, user];
  const diagnostics = [];
  toolConflictDiagnostics(rows, diagnostics);

  assert.deepEqual(
    diagnostics.map((item) => [item.id, item.severity]),
    [
      ['user:replacement', 'error'],
      ['user:replacement', 'warning'],
      ['user:replacement', 'error'],
    ],
  );
  const graph = dependencyGraph(rows);
  const health = extensionHealthForRows(rows, graph, diagnostics);
  assert.equal(health.get(user.id).available, false);
  assert.equal(health.get(core.id).available, true);
  assert.equal(health.get(optional.id).available, true);
  assert.equal(managementState(core, graph).canDisable, false);
  assert.equal(managementState(core, graph).canRemove, false);
  assert.equal(managementState(system, graph).canDisable, true);
  assert.equal(managementState(system, graph).canRemove, false);
  assert.equal(managementState(optional, graph).canDisable, true);
  assert.equal(managementState(optional, graph).canRemove, false);
});

test('an earlier system collision cannot mask a protected optional tool from a later user override', () => {
  const system = healthRow('builtin:system-tools', { tier: 'system' });
  system.manifest.contributes.tools = [{ name: 'protected_optional_tool' }];
  const optional = healthRow('builtin:optional-tools', { tier: 'optional' });
  optional.manifest.contributes.tools = [{ name: 'protected_optional_tool' }];
  const user = healthRow('user:replacement');
  user.manifest.contributes.tools = [{ name: 'protected_optional_tool' }];
  const rows = [system, optional, user];
  const diagnostics = [];
  toolConflictDiagnostics(rows, diagnostics);

  assert.deepEqual(
    diagnostics.map((item) => [item.id, item.severity]),
    [
      ['builtin:system-tools', 'error'],
      ['user:replacement', 'error'],
    ],
  );
  const graph = dependencyGraph(rows);
  const health = extensionHealthForRows(rows, graph, diagnostics);
  assert.equal(health.get(system.id).available, false);
  assert.equal(health.get(optional.id).available, true);
  assert.equal(health.get(user.id).available, false);
});

test('built-in enablement controls the live registry, allows optional disable, and protects core', async (t) => {
  const { getStudioDatabase } = require('../../electron/core/studio-db.cjs');
  const db = getStudioDatabase();
  const install = (id, tier, requires = []) => studioExtensions.installBuiltinExtension(db, {
    id,
    name: id,
    version: '1.0.0',
    manifest: {
      format: 1,
      id,
      name: id,
      version: '1.0.0',
      description: '',
      author: '',
      tier,
      requires,
      permissions: [],
      runtime: { durableEntry: '' },
      contributes: { tools: [], commands: [], panels: [], settings: [], composer: [] },
    },
  });
  install('test.core', 'core');
  install('test.optional', 'optional', ['builtin:test.core']);
  install('test.dependent', 'system', ['builtin:test.optional']);
  t.after(async () => {
    db.removeExtension('builtin:test.dependent');
    db.removeExtension('builtin:test.optional');
    db.removeExtension('builtin:test.core');
    await studioExtensions.uninstallStudioExtensions();
  });

  const installed = new Map();
  const registry = {
    install(extension) {
      installed.set(extension.name, extension);
    },
    uninstall(extension) {
      installed.delete(extension.name);
    },
  };
  const runtime = {
    registry,
    builtinExtensions: new Map([
      ['builtin:test.core', { name: 'test-core', tools: [] }],
      ['builtin:test.optional', { name: 'test-optional', tools: [] }],
      ['builtin:test.dependent', { name: 'test-dependent', tools: [] }],
    ]),
  };

  await studioExtensions.reloadStudioExtensions(runtime, '');
  assert.deepEqual(
    [...installed.keys()].sort(),
    ['test-core', 'test-dependent', 'test-optional'],
  );

  assert.throws(
    () => studioExtensions.setStudioExtensionEnabled('builtin:test.core', false, ''),
    /核心扩展不能停用/,
  );
  await assert.rejects(
    studioExtensions.removeStudioExtension('builtin:test.core', ''),
    /内置扩展不能删除/,
  );
  await assert.rejects(
    studioExtensions.removeStudioExtension('builtin:test.optional', ''),
    /内置扩展不能删除/,
  );
  assert.throws(
    () => studioExtensions.setStudioExtensionEnabled('builtin:test.optional', false, ''),
    /仍有启用的扩展依赖它：builtin:test.dependent/,
  );
  studioExtensions.setStudioExtensionEnabled('builtin:test.dependent', false, '');
  studioExtensions.setStudioExtensionEnabled('builtin:test.optional', false, '');
  await studioExtensions.reloadStudioExtensions(runtime, '');
  assert.deepEqual([...installed.keys()], ['test-core']);

  studioExtensions.setStudioExtensionEnabled('builtin:test.optional', true, '');
  studioExtensions.setStudioExtensionEnabled('builtin:test.dependent', true, '');
  await studioExtensions.reloadStudioExtensions(runtime, '');
  assert.deepEqual(
    [...installed.keys()].sort(),
    ['test-core', 'test-dependent', 'test-optional'],
  );
});

test('child conversations open through the Durable harness without a Studio row lookup', async () => {
  const context = Symbol('context');
  const handle = { id: 42 };
  const calls = [];
  const runtime = {
    context,
    harness: {
      async conversation(id, receivedContext) {
        calls.push([id, receivedContext]);
        return handle;
      },
    },
  };
  assert.equal(await openChildConversation('42', runtime), handle);
  assert.deepEqual(calls, [[42, context]]);
  assert.equal(await openChildConversation('invalid', runtime), undefined);
  assert.equal(calls.length, 1);
});
