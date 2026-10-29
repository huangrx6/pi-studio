const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createExtensionDistributionService,
} = require('../../electron/services/extension-distribution.cjs');
const {
  createOfficialExtensionService,
} = require('../../electron/services/official-extensions.cjs');
const {
  normalizeManifest,
} = require('../../electron/core/extension-manifest.cjs');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-official-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function memoryDatabase() {
  const values = new Map();
  return {
    getSetting(key, fallback) {
      return values.has(key) ? structuredClone(values.get(key)) : fallback;
    },
    setSetting(key, value) {
      values.set(key, structuredClone(value));
      return value;
    },
  };
}

function manifest(overrides = {}) {
  return {
    format: 1,
    id: 'official.demo',
    name: 'Official Demo',
    version: '1.0.0',
    description: 'Official extension test fixture',
    publisher: 'Pi Studio',
    author: 'Pi Studio',
    license: 'MIT',
    engines: { piStudio: '>=0.0.3 <0.1.0' },
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'open',
        title: 'Open',
        action: { kind: 'openSettings', panel: 'extensions' },
      }],
    },
    ...overrides,
  };
}

function writeExtension(directory, value, files = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'pi-studio.extension.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function setup(t) {
  const root = temporaryRoot(t);
  const officialRoot = path.join(root, 'official');
  fs.mkdirSync(officialRoot, { recursive: true });
  const distribution = createExtensionDistributionService({
    userDataPath: path.join(root, 'user-data'),
    appVersion: '0.0.3',
    officialRoot,
    normalizeManifest,
  });
  const database = memoryDatabase();
  const official = createOfficialExtensionService({
    root: officialRoot,
    distribution,
    database,
    normalizeManifest,
  });
  return { root, officialRoot, distribution, database, official };
}

function writeOfficial(context, overrides = {}, files = {}) {
  const value = manifest(overrides);
  const directory = path.join(context.officialRoot, value.id);
  writeExtension(directory, value, files);
  context.distribution.writeGeneratedIntegrity(directory);
  return directory;
}

test('official catalog discovers, installs, auto-updates and rolls back safely', async (t) => {
  const context = setup(t);
  writeOfficial(context);
  assert.deepEqual(context.official.snapshot().errors, []);
  const initialItem = context.official.snapshot().extensions[0];
  assert.equal(initialItem.installed, false);
  assert.equal(initialItem.executable, false);

  const preview = await context.official.prepare('official.demo');
  await context.distribution.installPrepared(preview.token, {
    scope: 'user',
    acceptedPermissions: preview.permissions,
    trusted: true,
  });
  assert.equal(context.distribution.getInstalled('official.demo').version, '1.0.0');

  writeOfficial(context, { version: '1.1.0' });
  const updateItem = context.official.snapshot().extensions[0];
  assert.equal(updateItem.updateAvailable, true);
  assert.equal(updateItem.requiresCapabilityConsent, false);
  const update = await context.official.autoUpdate();
  assert.deepEqual(update.updated, ['official.demo']);
  assert.equal(context.distribution.getInstalled('official.demo').version, '1.1.0');

  const rolledBack = await context.distribution.rollback('official.demo', {
    scope: 'user',
  });
  assert.equal(rolledBack.version, '1.0.0');
  assert.equal(context.distribution.getInstalled('official.demo').sourceKind, 'official');
});

test('official auto-update pauses for newly expanded capabilities', async (t) => {
  const context = setup(t);
  writeOfficial(context);
  const preview = await context.official.prepare('official.demo');
  await context.distribution.installPrepared(preview.token, {
    scope: 'user',
    acceptedPermissions: preview.permissions,
    trusted: true,
  });

  writeOfficial(context, {
    version: '1.1.0',
    permissions: ['ui.commands', 'provider.credentials'],
    providerAccess: ['deepseek'],
    runtime: { durableEntry: 'extension.mjs' },
    contributes: {
      commands: [{ id: 'open', title: 'Open' }],
    },
  }, {
    'extension.mjs': "export const commands = { open: () => 'ok' };\n",
  });

  const snapshot = context.official.snapshot();
  assert.deepEqual(snapshot.extensions[0].addedPermissions, ['provider.credentials']);
  assert.deepEqual(snapshot.extensions[0].addedProviderAccess, ['deepseek']);
  assert.equal(snapshot.extensions[0].executableExpansion, true);
  const update = await context.official.autoUpdate();
  assert.equal(update.results[0].status, 'consent-required');
  assert.deepEqual(update.updated, []);
  assert.equal(context.distribution.getInstalled('official.demo').version, '1.0.0');

  const expansion = await context.official.prepare('official.demo');
  await assert.rejects(
    context.distribution.installPrepared(expansion.token, {
      scope: 'user',
      acceptedPermissions: expansion.addedPermissions,
      acceptedExecution: true,
      trusted: true,
    }),
    (error) => error?.code === 'PROVIDER_ACCESS_CONSENT_REQUIRED',
  );
  const installed = await context.distribution.installPrepared(expansion.token, {
    scope: 'user',
    acceptedPermissions: expansion.addedPermissions,
    acceptedProviderAccess: ['deepseek'],
    acceptedExecution: true,
    trusted: true,
  });
  assert.equal(installed.version, '1.1.0');
});

test('official auto-update repairs a legacy manifest rejected by the current schema', async (t) => {
  const root = temporaryRoot(t);
  const officialRoot = path.join(root, 'official');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(officialRoot, { recursive: true });

  const legacyManifest = manifest({
    version: '0.5.2',
    permissions: ['ui.commands', 'ui.panels', 'provider.credentials'],
    providerAccess: ['deepseek'],
    runtime: { durableEntry: 'extension.mjs' },
    contributes: {
      commands: [{ id: 'open', title: 'Open' }],
      panels: [{
        id: 'legacy-footer',
        title: 'Legacy footer',
        slot: 'conversation.footer',
        size: 'compact',
        content: [
          { kind: 'text', text: 'legacy' },
          {
            kind: 'actions',
            buttons: [{ id: 'refresh', label: 'Refresh' }],
          },
        ],
      }],
    },
  });
  const legacySource = path.join(officialRoot, legacyManifest.id);
  writeExtension(legacySource, legacyManifest, {
    'extension.mjs': "export const commands = { open: () => 'ok' };\n",
  });

  const permissiveDistribution = createExtensionDistributionService({
    userDataPath,
    appVersion: '0.0.3',
    officialRoot,
    normalizeManifest: (raw) => raw,
  });
  const legacyPreview = await permissiveDistribution.prepare(
    `official:${legacyManifest.id}`,
    { scope: 'user' },
  );
  await permissiveDistribution.installPrepared(legacyPreview.token, {
    scope: 'user',
    acceptedPermissions: legacyPreview.permissions,
    acceptedProviderAccess: legacyPreview.providerAccess,
    acceptedExecution: true,
    trusted: true,
  });

  const nextManifest = manifest({
    version: '0.6.0',
    permissions: legacyManifest.permissions,
    providerAccess: legacyManifest.providerAccess,
    runtime: { durableEntry: 'extension.mjs' },
    contributes: {
      commands: [{ id: 'open', title: 'Open' }],
      panels: [{
        id: 'footer',
        title: 'Footer',
        slot: 'conversation.footer',
        size: 'compact',
        content: [{ kind: 'text', text: '0.6.0' }],
      }],
    },
  });
  writeExtension(legacySource, nextManifest, {
    'extension.mjs': "export const commands = { open: () => '0.6.0' };\n",
  });
  const distribution = createExtensionDistributionService({
    userDataPath,
    appVersion: '0.0.3',
    officialRoot,
    normalizeManifest,
  });
  distribution.writeGeneratedIntegrity(legacySource);
  const official = createOfficialExtensionService({
    root: officialRoot,
    distribution,
    database: memoryDatabase(),
    normalizeManifest,
  });

  const catalog = official.snapshot();
  assert.deepEqual(catalog.errors, []);
  const current = catalog.extensions[0];
  assert.equal(current.updateAvailable, true);
  assert.equal(current.requiresCapabilityConsent, false);
  const update = await official.autoUpdate();
  assert.deepEqual(update.updated, [legacyManifest.id]);
  assert.equal(distribution.getInstalled(legacyManifest.id).version, '0.6.0');
  assert.deepEqual(
    distribution.getInstalledCapabilityManifest(legacyManifest.id).providerAccess,
    ['deepseek'],
  );
});

test('official installation rechecks source ownership after preview', async (t) => {
  const context = setup(t);
  writeOfficial(context);
  const officialPreview = await context.official.prepare('official.demo');

  const localSource = path.join(context.root, 'local-source');
  writeExtension(localSource, manifest());
  const localPreview = await context.distribution.prepare(localSource, {
    scope: 'user',
  });
  await context.distribution.installPrepared(localPreview.token, {
    scope: 'user',
    acceptedPermissions: localPreview.permissions,
    trusted: true,
  });

  await assert.rejects(
    context.distribution.installPrepared(officialPreview.token, {
      scope: 'user',
      acceptedPermissions: officialPreview.addedPermissions,
      trusted: true,
    }),
    (error) => error?.code === 'OFFICIAL_SOURCE_CONFLICT',
  );
  assert.equal(context.distribution.getInstalled('official.demo').sourceKind, 'local-directory');
});
