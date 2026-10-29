const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createZipArchive,
  inspectZipEntries,
  sha256,
} = require('../../electron/core/extension-archive.cjs');
const {
  createExtensionPackage,
  INTEGRITY_NAME,
  MANIFEST_NAME,
} = require('../../electron/core/extension-package.cjs');
const {
  publicKeyFingerprint,
  signExtensionDirectory,
} = require('../../electron/core/extension-signature.cjs');
const {
  createExtensionDistributionService,
} = require('../../electron/services/extension-distribution.cjs');
const {
  normalizeManifest: normalizeCoreManifest,
} = require('../../electron/core/extension-manifest.cjs');
const {
  normalizeManifest: normalizeRuntimeManifest,
} = require('../../electron/services/studio-extensions.cjs');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-distribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createDirectorySymlink(t, target, link) {
  try {
    fs.symlinkSync(target, link, 'dir');
    return true;
  } catch (error) {
    if (process.platform === 'win32') {
      t.skip(`无法创建 Windows 测试符号链接：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    throw error;
  }
}

function manifest(overrides = {}) {
  return {
    format: 1,
    id: 'demo.extension',
    name: 'Demo Extension',
    version: '1.0.0',
    publisher: 'tester',
    license: 'MIT',
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'hello',
        title: 'Hello',
        action: { kind: 'openSettings', panel: 'extensions' },
      }],
    },
    ...overrides,
  };
}

function writeExtension(root, overrides = {}, extraFiles = {}) {
  fs.mkdirSync(root, { recursive: true });
  const value = manifest(overrides);
  fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(value, null, 2));
  for (const [name, content] of Object.entries(extraFiles)) {
    const target = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { root, manifest: value };
}

function service(root, options = {}) {
  return createExtensionDistributionService({
    userDataPath: path.join(root, 'user-data'),
    appVersion: '0.0.3',
    requestTimeoutMs: 2_000,
    ...options,
  });
}

function archiveResponse(archive, url = 'https://downloads.example/demo.pi-extension.zip') {
  return new Response(archive, {
    status: 200,
    headers: {
      'content-length': String(archive.length),
      'content-type': 'application/zip',
    },
  });
}

function writePackedArchive(root, source, name = 'demo.pi-extension.zip') {
  const packed = createExtensionPackage(source);
  const file = path.join(root, name);
  fs.writeFileSync(file, packed.archive);
  return { ...packed, file };
}

function replaceAscii(buffer, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const result = Buffer.from(buffer);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(from, offset)) !== -1) {
    result.write(to, offset);
    offset += to.length;
    replacements += 1;
  }
  assert.ok(replacements >= 2, '应同时修改本地文件头与中央目录');
  return result;
}

function signedRegistryFixture(t, root, overrides = {}) {
  const source = writeExtension(path.join(root, 'signed-source'), overrides);
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicPem = keys.publicKey.export({ format: 'pem', type: 'spki' });
  signExtensionDirectory(source.root, { privateKey: keys.privateKey });
  const packed = writePackedArchive(root, source.root, 'signed-demo.pi-extension.zip');
  const registryFile = path.join(root, 'registry.json');
  fs.writeFileSync(registryFile, `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: source.manifest.id,
      name: source.manifest.name,
      publisher: source.manifest.publisher,
      publisherKey: publicPem,
      publisherKeyId: publicKeyFingerprint(publicPem),
      versions: [{
        version: source.manifest.version,
        piStudio: '^0.0.3',
        download: 'https://downloads.example/signed-demo.pi-extension.zip',
        sha256: packed.archiveSha256,
        size: packed.archive.length,
        permissions: source.manifest.permissions,
      }],
    }],
  }, null, 2)}\n`);
  return {
    ...packed,
    source,
    registryFile,
    publicPem,
    keyId: publicKeyFingerprint(publicPem),
  };
}

test('local directory install separates code and data and is idempotent', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);

  const preview = await distribution.prepare(source);
  assert.equal(preview.id, 'demo.extension');
  assert.equal(preview.sourceKind, 'local-directory');
  assert.equal(preview.requiresPermissionConsent, true);

  const installed = await distribution.installPrepared(preview.token, {
    acceptedPermissions: preview.permissions,
  });
  assert.ok(fs.existsSync(path.join(installed.activeCodePath, MANIFEST_NAME)));
  assert.ok(fs.existsSync(installed.dataPath));
  assert.equal(fs.existsSync(path.join(installed.activeCodePath, '.data')), false);
  assert.equal(installed.version, '1.0.0');
  assert.equal(installed.permissions[0], 'ui.commands');
  assert.equal(
    distribution.resolveActiveDirectory('demo.extension')?.endsWith(path.join('demo.extension', '1.0.0')),
    true,
  );
});

test('signed registry extension requires explicit publisher-key trust and persists it', async (t) => {
  const root = temporaryRoot(t);
  const fixture = signedRegistryFixture(t, root);
  const fetchImpl = async () => archiveResponse(fixture.archive);
  const firstService = service(root, { fetchImpl });
  const preview = await firstService.prepare('registry:demo.extension', {
    registryUrl: fixture.registryFile,
  });

  assert.equal(preview.signatureStatus, 'valid');
  assert.equal(preview.publisherTrust, 'untrusted');
  assert.equal(preview.signatureKeyId, fixture.keyId);
  assert.equal(preview.requiresPublisherTrust, true);
  assert.equal(preview.requiresCapabilityConsent, true);
  await assert.rejects(
    firstService.installPrepared(preview.token, {
      acceptedPermissions: preview.permissions,
    }),
    (error) => error?.code === 'PUBLISHER_TRUST_REQUIRED',
  );

  const installed = await firstService.installPrepared(preview.token, {
    acceptedPermissions: preview.permissions,
    acceptedPublisherKey: true,
  });
  assert.equal(installed.signatureStatus, 'trusted');
  assert.equal(installed.signatureKeyId, fixture.keyId);
  assert.equal(
    firstService.publisherTrustSnapshot().publishers[0].keys[0].status,
    'trusted',
  );

  const secondService = service(root, { fetchImpl });
  const repeated = await secondService.prepare('registry:demo.extension', {
    registryUrl: fixture.registryFile,
  });
  assert.equal(repeated.signatureStatus, 'trusted');
  assert.equal(repeated.publisherTrust, 'trusted');
  assert.equal(repeated.requiresPublisherTrust, false);
});

test('registry publisher key mismatch and revoked keys block installation', async (t) => {
  const root = temporaryRoot(t);
  const fixture = signedRegistryFixture(t, root);
  const wrong = crypto.generateKeyPairSync('ed25519').publicKey.export({
    format: 'pem',
    type: 'spki',
  });
  const registry = JSON.parse(fs.readFileSync(fixture.registryFile, 'utf8'));
  registry.extensions[0].publisherKey = wrong;
  registry.extensions[0].publisherKeyId = publicKeyFingerprint(wrong);
  fs.writeFileSync(fixture.registryFile, JSON.stringify(registry, null, 2));
  await assert.rejects(
    service(root, { fetchImpl: async () => archiveResponse(fixture.archive) })
      .prepare('registry:demo.extension', { registryUrl: fixture.registryFile }),
    /受信任发布者公钥不一致/,
  );

  registry.extensions[0].publisherKey = fixture.publicPem;
  registry.extensions[0].publisherKeyId = fixture.keyId;
  fs.writeFileSync(fixture.registryFile, JSON.stringify(registry, null, 2));
  const distribution = service(root, {
    fetchImpl: async () => archiveResponse(fixture.archive),
  });
  const preview = await distribution.prepare('registry:demo.extension', {
    registryUrl: fixture.registryFile,
  });
  await distribution.installPrepared(preview.token, {
    acceptedPermissions: preview.permissions,
    acceptedPublisherKey: true,
  });
  distribution.revokePublisherKey({
    publisher: preview.signaturePublisher,
    keyId: preview.signatureKeyId,
  });
  await assert.rejects(
    distribution.prepare('registry:demo.extension', {
      registryUrl: fixture.registryFile,
    }),
    (error) => error?.code === 'REVOKED_PUBLISHER_KEY',
  );
});

test('a prepared install token can only be claimed by one operation', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source);

  assert.equal(distribution.takePrepared(preview.token).summary.id, 'demo.extension');
  assert.throws(
    () => distribution.takePrepared(preview.token),
    (error) => error?.code === 'PREPARED_CLAIMED',
  );

  const other = await distribution.prepare(source);
  const results = await Promise.allSettled([
    distribution.installPrepared(other.token, {
      acceptedPermissions: other.permissions,
    }),
    distribution.installPrepared(other.token, {
      acceptedPermissions: other.permissions,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('an install preview is bound to its reviewed scope and workspace', async (t) => {
  const root = temporaryRoot(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const userPreview = await distribution.prepare(source, { scope: 'user' });

  await assert.rejects(
    distribution.installPrepared(userPreview.token, {
      scope: 'project',
      cwd: workspace,
      acceptedPermissions: userPreview.permissions,
    }),
    (error) => error?.code === 'TARGET_MISMATCH',
  );

  const installed = await distribution.installPrepared(userPreview.token, {
    scope: 'user',
    acceptedPermissions: userPreview.permissions,
  });
  assert.equal(installed.scope, 'user');
});

test('disposing a claimed preview cannot delete quarantine during installation', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source);
  const claimed = distribution.takePrepared(preview.token);

  assert.equal(distribution.disposePrepared(preview.token), false);
  assert.equal(fs.existsSync(claimed.packageDirectory), true);
  assert.equal(
    distribution.disposePrepared(preview.token, { allowClaimed: true }),
    true,
  );
  assert.equal(fs.existsSync(path.dirname(claimed.packageDirectory)), false);
});

test('packed archive installs only with its integrity manifest', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {
    permissions: ['ui.panels'],
    contributes: {
      panels: [{
        id: 'main',
        title: 'Main',
        slot: 'panel.side',
        content: [{ kind: 'text', text: 'ready' }],
      }],
    },
  }).root;
  const packed = writePackedArchive(root, source);
  const distribution = service(root);
  const preview = await distribution.prepare(packed.file, { expectedSha256: packed.archiveSha256 });
  const installed = await distribution.installPrepared(preview.token, {
    acceptedPermissions: preview.permissions,
  });
  assert.ok(fs.existsSync(path.join(installed.activeCodePath, INTEGRITY_NAME)));
});

test('archive without integrity.json is rejected', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const packageArchive = createZipArchive([
    { path: MANIFEST_NAME, content: fs.readFileSync(path.join(source, MANIFEST_NAME)) },
  ]);
  const file = path.join(root, 'unsigned.pi-extension.zip');
  fs.writeFileSync(file, packageArchive);
  const distribution = service(root);
  await assert.rejects(
    distribution.prepare(file),
    /缺少 integrity\.json/,
  );
});

test('tree content that does not match integrity.json is rejected', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {}, {
    'extension.mjs': 'export const value = "one";\n',
  }).root;
  const packed = createExtensionPackage(source);
  const entries = inspectZipEntries(packed.archive);
  const changed = [...entries].map(([name, file]) => ({
    path: name,
    content: name === 'extension.mjs' ? Buffer.from('export const value = "two";\n') : file.content,
  }));
  const tampered = createZipArchive(changed);
  const file = path.join(root, 'tampered.pi-extension.zip');
  fs.writeFileSync(file, tampered);
  const distribution = service(root);
  await assert.rejects(
    distribution.prepare(file),
    /SHA-256 不一致/,
  );
});

test('install rechecks the reviewed tree digest even if quarantine integrity is rewritten', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {}, { 'a.txt': 'reviewed' }).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source);
  const prepared = distribution.prepared.get(preview.token);
  fs.writeFileSync(path.join(prepared.packageDirectory, 'a.txt'), 'changed!\n');
  distribution.writeGeneratedIntegrity(prepared.packageDirectory);

  await assert.rejects(
    distribution.installPrepared(preview.token, {
      acceptedPermissions: preview.permissions,
    }),
    (error) => error?.code === 'PACKAGE_CHANGED',
  );
  assert.deepEqual(distribution.listInstalled(), []);
  distribution.disposePrepared(preview.token);
});

test('path traversal and Windows absolute paths are rejected before extraction', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {}, {
    'aa/evil.txt': 'safe',
  }).root;
  const packed = createExtensionPackage(source);
  const traversal = replaceAscii(packed.archive, 'aa/evil.txt', '../evil.txt');
  const traversalFile = path.join(root, 'traversal.pi-extension.zip');
  fs.writeFileSync(traversalFile, traversal);
  await assert.rejects(
    service(root).prepare(traversalFile),
    /越界路径/,
  );

  const windows = replaceAscii(packed.archive, 'aa/evil.txt', 'aa\\evil.txt');
  const windowsFile = path.join(root, 'windows.pi-extension.zip');
  fs.writeFileSync(windowsFile, windows);
  await assert.rejects(
    service(root).prepare(windowsFile),
    /反斜杠/,
  );
});

test('local source rejects symlinks and unsupported Pi Studio versions', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {
    engines: { piStudio: '>=9.0.0 <10.0.0' },
  }).root;
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(source, 'linked.txt'));
  const distribution = service(root);
  await assert.rejects(distribution.prepare(source), /不能包含符号链接/);

  fs.rmSync(path.join(source, 'linked.txt'));
  await assert.rejects(
    distribution.prepare(source),
    /要求 Pi Studio >=9\.0\.0 <10\.0\.0/,
  );
});

test('version and publisher must be safe distribution metadata', async (t) => {
  const root = temporaryRoot(t);
  const badVersion = writeExtension(path.join(root, 'bad-version'), { version: '1' }).root;
  await assert.rejects(service(root).prepare(badVersion), /必须是语义化版本/);

  const noPublisher = writeExtension(path.join(root, 'no-publisher'), {
    publisher: undefined,
    author: undefined,
  }).root;
  await assert.rejects(service(root).prepare(noPublisher), /publisher/);
});

test('permission expansion requires fresh consent and preserves data through upgrade and rollback', async (t) => {
  const root = temporaryRoot(t);
  const first = writeExtension(path.join(root, 'v1')).root;
  const distribution = service(root);
  const firstPreview = await distribution.prepare(first);
  const initial = await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });
  fs.writeFileSync(path.join(initial.dataPath, 'state.json'), '{"kept":true}');

  const second = writeExtension(path.join(root, 'v2'), {
    version: '1.1.0',
    permissions: ['ui.commands', 'ui.panels'],
    contributes: {
      commands: [{
        id: 'hello',
        title: 'Hello',
        action: { kind: 'openSettings', panel: 'extensions' },
      }],
      panels: [{
        id: 'summary',
        title: 'Summary',
        slot: 'panel.side',
        content: [{ kind: 'text', text: 'v2' }],
      }],
    },
  }).root;
  const secondPreview = await distribution.prepare(second);
  assert.deepEqual(secondPreview.addedPermissions, ['ui.panels']);
  assert.equal(secondPreview.upgrade, true);
  assert.equal(secondPreview.alreadyInstalled, false);
  await assert.rejects(
    distribution.installPrepared(secondPreview.token, {
      acceptedPermissions: ['ui.commands'],
    }),
    /ui\.panels/,
  );
  const upgraded = await distribution.installPrepared(secondPreview.token, {
    acceptedPermissions: ['ui.panels'],
  });
  assert.equal(upgraded.version, '1.1.0');
  assert.equal(upgraded.contentChanged, true);
  assert.equal(fs.readFileSync(path.join(upgraded.dataPath, 'state.json'), 'utf8'), '{"kept":true}');
  await assert.rejects(
    distribution.prepare(first),
    (error) => error?.code === 'VERSION_DOWNGRADE',
  );

  const rolledBack = await distribution.rollback('demo.extension');
  assert.equal(rolledBack.version, '1.0.0');
  assert.equal(rolledBack.contentChanged, true);
  assert.equal(rolledBack.activeCodePath, initial.activeCodePath);
  assert.equal(fs.readFileSync(path.join(rolledBack.dataPath, 'state.json'), 'utf8'), '{"kept":true}');

  const reactivationPreview = await distribution.prepare(second);
  assert.equal(reactivationPreview.upgrade, true);
  await distribution.installPrepared(reactivationPreview.token, {
    acceptedPermissions: reactivationPreview.addedPermissions,
  });
  const state = JSON.parse(fs.readFileSync(
    distribution.stateFile('user', undefined, 'demo.extension'),
    'utf8',
  ));
  assert.deepEqual(state.history.map((entry) => entry.version), ['1.0.0', '1.1.0']);
  assert.equal(state.history[state.activeHistoryIndex].version, '1.1.0');
});

test('uninstall preserves data by default and can explicitly remove it', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root);
  for (let index = 0; index < 2; index += 1) {
    const source = writeExtension(path.join(root, `source-${index}`), {
      id: index === 0 ? 'preserve.extension' : 'remove.extension',
    }).root;
    const preview = await distribution.prepare(source);
    const installed = await distribution.installPrepared(preview.token, {
      acceptedPermissions: preview.permissions,
    });
    fs.writeFileSync(path.join(installed.dataPath, 'marker'), 'data');
  }
  const preserved = await distribution.uninstall('preserve.extension');
  assert.equal(preserved.dataPreserved, true);
  assert.ok(fs.existsSync(preserved.dataPath));

  const removedData = await distribution.uninstall('remove.extension', { preserveData: false });
  assert.equal(removedData.dataPreserved, false);
  assert.equal(fs.existsSync(removedData.dataPath), false);
});

test('tampered install state cannot redirect code or data outside managed roots', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source);
  await distribution.installPrepared(preview.token, {
    acceptedPermissions: preview.permissions,
  });

  const stateFile = distribution.stateFile('user', undefined, 'demo.extension');
  const original = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'must remain');

  fs.writeFileSync(stateFile, JSON.stringify({ ...original, dataPath: outside }, null, 2));
  assert.throws(() => distribution.getInstalled('demo.extension'), /数据目录/);
  await assert.rejects(
    distribution.uninstall('demo.extension', { preserveData: false }),
    /数据目录/,
  );
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));

  fs.writeFileSync(stateFile, JSON.stringify({
    ...original,
    history: original.history.map((entry) => ({ ...entry, codePath: outside })),
  }, null, 2));
  assert.throws(() => distribution.getInstalled('demo.extension'), /代码目录/);
  await assert.rejects(distribution.uninstall('demo.extension'), /代码目录/);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
});

test('same version with different bytes is rejected without disturbing active version', async (t) => {
  const root = temporaryRoot(t);
  const first = writeExtension(path.join(root, 'v1'), {}, { 'a.txt': 'one' }).root;
  const distribution = service(root);
  const firstPreview = await distribution.prepare(first);
  const installed = await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });

  const replacement = writeExtension(path.join(root, 'replacement'), {}, { 'a.txt': 'two' }).root;
  await assert.rejects(
    distribution.prepare(replacement),
    (error) => error?.code === 'VERSION_COLLISION',
  );
  assert.equal(distribution.getInstalled('demo.extension').version, installed.version);
  assert.equal(fs.readFileSync(path.join(installed.activeCodePath, 'a.txt'), 'utf8'), 'one');
});

test('reinstalling identical active content is idempotent and releases both quarantines', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {}, { 'a.txt': 'stable' }).root;
  const distribution = service(root);
  const first = await distribution.prepare(source);
  const firstQuarantine = path.dirname(distribution.prepared.get(first.token).packageDirectory);
  const initial = await distribution.installPrepared(first.token, {
    acceptedPermissions: first.permissions,
  });
  assert.equal(initial.contentChanged, true);
  assert.equal(fs.existsSync(firstQuarantine), false);

  const second = await distribution.prepare(source);
  assert.equal(second.alreadyInstalled, true);
  assert.equal(second.upgrade, false);
  const secondQuarantine = path.dirname(distribution.prepared.get(second.token).packageDirectory);
  const repeated = await distribution.installPrepared(second.token, {
    acceptedPermissions: second.addedPermissions,
  });
  assert.equal(repeated.contentChanged, false);
  assert.equal(fs.existsSync(secondQuarantine), false);

  const state = JSON.parse(fs.readFileSync(
    distribution.stateFile('user', undefined, 'demo.extension'),
    'utf8',
  ));
  assert.deepEqual(state.history.map((entry) => entry.version), ['1.0.0']);
});

test('a failed rollback pointer update restores the previously active version', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root);
  const first = writeExtension(path.join(root, 'v1')).root;
  const firstPreview = await distribution.prepare(first);
  await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });
  const second = writeExtension(path.join(root, 'v2'), { version: '1.1.0' }).root;
  const secondPreview = await distribution.prepare(second);
  const installed = await distribution.installPrepared(secondPreview.token, {
    acceptedPermissions: secondPreview.addedPermissions,
  });
  const currentFile = path.join(path.dirname(installed.activeCodePath), 'current.json');
  const originalRename = fs.renameSync;

  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(currentFile)) {
      throw Object.assign(new Error('injected pointer failure'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(
      distribution.rollback('demo.extension'),
      (error) => error?.code === 'EIO',
    );
  } finally {
    fs.renameSync = originalRename;
  }

  const active = distribution.getInstalled('demo.extension');
  assert.equal(active.version, '1.1.0');
  const pointer = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  assert.equal(pointer.version, '1.1.0');
  const state = JSON.parse(fs.readFileSync(
    distribution.stateFile('user', undefined, 'demo.extension'),
    'utf8',
  ));
  assert.equal(state.history[state.activeHistoryIndex].version, '1.1.0');
});

test('a failed upgrade pointer update is atomic and the same preview can be retried', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root);
  const first = writeExtension(path.join(root, 'v1')).root;
  const firstPreview = await distribution.prepare(first);
  await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });
  const second = writeExtension(path.join(root, 'v2'), { version: '1.1.0' }).root;
  const secondPreview = await distribution.prepare(second);
  const currentFile = path.join(
    path.dirname(distribution.getInstalled('demo.extension').activeCodePath),
    'current.json',
  );
  const originalRename = fs.renameSync;

  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(currentFile)) {
      throw Object.assign(new Error('injected pointer failure'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(
      distribution.installPrepared(secondPreview.token, {
        acceptedPermissions: secondPreview.addedPermissions,
      }),
      (error) => error?.code === 'EIO',
    );
  } finally {
    fs.renameSync = originalRename;
  }

  const active = distribution.getInstalled('demo.extension');
  assert.equal(active.version, '1.0.0');
  const pointer = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  assert.equal(pointer.version, '1.0.0');
  assert.equal(fs.existsSync(path.join(path.dirname(currentFile), '1.1.0')), false);
  assert.equal(distribution.claimedPrepared.has(secondPreview.token), false);

  const retried = await distribution.installPrepared(secondPreview.token, {
    acceptedPermissions: secondPreview.addedPermissions,
  });
  assert.equal(retried.version, '1.1.0');
});

test('HTTPS sources require and verify an external SHA-256', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const packed = createExtensionPackage(source);
  let requestedUrl = '';
  const distribution = service(root, {
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return archiveResponse(packed.archive);
    },
  });
  await assert.rejects(
    distribution.prepare('https://downloads.example/demo.pi-extension.zip'),
    /必须通过 expectedSha256/,
  );
  const preview = await distribution.prepare(
    `https://downloads.example/demo.pi-extension.zip#sha256=${packed.archiveSha256}`,
  );
  assert.equal(preview.sourceKind, 'https');
  assert.equal(requestedUrl, 'https://downloads.example/demo.pi-extension.zip');

  await assert.rejects(
    distribution.prepare(
      'https://downloads.example/demo.pi-extension.zip',
      { expectedSha256: '0'.repeat(64) },
    ),
    /SHA-256 不一致/,
  );
});

test('GitHub Release resolution verifies the asset digest', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const packed = createExtensionPackage(source);
  const calls = [];
  const distribution = service(root, {
    githubApiBase: 'https://api.github.test',
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/releases/tags/v1.0.0')) {
        return Response.json({
          tag_name: 'v1.0.0',
          author: { login: 'tester' },
          assets: [{
            name: 'demo-1.0.0.pi-extension.zip',
            browser_download_url: 'https://github.test/download/demo.zip',
            digest: `sha256:${packed.archiveSha256}`,
          }],
        });
      }
      return archiveResponse(packed.archive, String(url));
    },
  });
  const preview = await distribution.prepare('github:owner/repo@v1.0.0');
  assert.equal(preview.sourceKind, 'github-release');
  assert.equal(preview.resolvedRef, 'v1.0.0');
  assert.ok(calls.includes('https://api.github.test/repos/owner/repo/releases/tags/v1.0.0'));
});

test('GitHub tag resolves to a fixed commit and creates tree integrity', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'repository-root')).root;
  const commit = 'a'.repeat(40);
  const wrapped = createZipArchive([{
    path: `repository-${commit}/${MANIFEST_NAME}`,
    content: fs.readFileSync(path.join(source, MANIFEST_NAME)),
  }]);
  const distribution = service(root, {
    githubApiBase: 'https://api.github.test',
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('/releases/tags/')) return new Response('{}', { status: 404 });
      if (target.includes('/commits/')) return Response.json({ sha: commit });
      if (target.includes('codeload.github.com')) return archiveResponse(wrapped, target);
      throw new Error(`unexpected ${target}`);
    },
  });
  const preview = await distribution.prepare('github:owner/repo@v1.0.0');
  assert.equal(preview.sourceKind, 'github-commit');
  assert.equal(preview.resolvedRef, commit);
  assert.match(preview.treeSha256, /^[a-f0-9]{64}$/);
});

test('registry source selects the newest compatible version and pins its digest', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), { version: '1.2.0' }).root;
  const packed = createExtensionPackage(source);
  const registryFile = path.join(root, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    name: 'Test Registry',
    extensions: [{
      id: 'demo.extension',
      name: 'Demo',
      publisher: 'tester',
      versions: [{
        version: '1.2.0',
        piStudio: '>=0.0.3 <0.1.0',
        download: 'https://downloads.example/demo-1.2.0.pi-extension.zip',
        sha256: packed.archiveSha256,
        size: packed.archive.length,
      }],
    }],
  }));
  const distribution = service(root, {
    registryUrl: registryFile,
    fetchImpl: async () => archiveResponse(packed.archive),
  });
  const preview = await distribution.prepare('registry:demo.extension');
  assert.equal(preview.version, '1.2.0');
  assert.equal(preview.sourceKind, 'registry');
  assert.equal(preview.resolvedRef, 'demo.extension@1.2.0');
});

test('registry publisher cannot be confused with a different manifest publisher', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source'), {
    publisher: 'manifest-publisher',
  }).root;
  const packed = createExtensionPackage(source);
  const registryFile = path.join(root, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: 'demo.extension',
      name: 'Demo',
      publisher: 'registry-publisher',
      versions: [{
        version: '1.0.0',
        piStudio: '*',
        download: 'https://downloads.example/demo.pi-extension.zip',
        sha256: packed.archiveSha256,
      }],
    }],
  }));
  const distribution = service(root, {
    registryUrl: registryFile,
    fetchImpl: async () => archiveResponse(packed.archive),
  });
  await assert.rejects(
    distribution.prepare('registry:demo.extension'),
    (error) => error?.code === 'PUBLISHER_MISMATCH',
  );
});

test('archive, extracted, and per-file limits are enforced', async (t) => {
  const root = temporaryRoot(t);
  const source = writeExtension(path.join(root, 'source')).root;
  const packed = writePackedArchive(root, source);
  const distribution = service(root, {
    limits: {
      maxArchiveBytes: packed.archive.length - 1,
      maxExtractedBytes: 1024,
      maxFileBytes: 512,
    },
  });
  await assert.rejects(distribution.prepare(packed.file), /超过/);
});

test('project installs keep code in the workspace and state/data outside it', async (t) => {
  const root = temporaryRoot(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source, { scope: 'project', cwd: workspace });
  const installed = await distribution.installPrepared(preview.token, {
    scope: 'project',
    cwd: workspace,
    acceptedPermissions: preview.permissions,
    trusted: false,
  });
  assert.ok(installed.activeCodePath.startsWith(path.join(fs.realpathSync(workspace), '.pi-studio', 'extensions')));
  assert.ok(installed.dataPath.startsWith(
    path.join(fs.realpathSync(path.join(root, 'user-data')), 'extension-data'),
  ));
  assert.equal(installed.workspace, fs.realpathSync(workspace));
  assert.equal(distribution.listInstalled('project', workspace).length, 1);
});

test('project installs reject a managed extension root symlink that escapes the workspace', async (t) => {
  const root = temporaryRoot(t);
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(workspace, '.pi-studio'), { recursive: true });
  fs.mkdirSync(outside);
  if (!createDirectorySymlink(t, outside, path.join(workspace, '.pi-studio', 'extensions'))) return;

  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source, { scope: 'project', cwd: workspace });
  await assert.rejects(
    distribution.installPrepared(preview.token, {
      scope: 'project',
      cwd: workspace,
      acceptedPermissions: preview.permissions,
    }),
    (error) => error?.code === 'UNSAFE_MANAGED_PATH',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('prepare rejects a quarantine root symlink that escapes application data', async (t) => {
  const root = temporaryRoot(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(root, 'user-data', 'extension-cache'), { recursive: true });
  fs.mkdirSync(outside);
  if (!createDirectorySymlink(t, outside, path.join(root, 'user-data', 'extension-cache', 'quarantine'))) return;

  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  await assert.rejects(
    distribution.prepare(source),
    (error) => error?.code === 'UNSAFE_MANAGED_PATH',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('prepare rejects an install state symlink that escapes application data', async (t) => {
  const root = temporaryRoot(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(root, 'user-data'), { recursive: true });
  fs.mkdirSync(outside);
  if (!createDirectorySymlink(t, outside, path.join(root, 'user-data', 'extension-state'))) return;

  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  await assert.rejects(
    distribution.prepare(source),
    (error) => error?.code === 'UNSAFE_MANAGED_PATH',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('install rejects an extension data symlink that escapes application data', async (t) => {
  const root = temporaryRoot(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(root, 'user-data', 'extension-data'), { recursive: true });
  fs.mkdirSync(outside);
  if (!createDirectorySymlink(t, outside, path.join(root, 'user-data', 'extension-data', 'user'))) return;

  const source = writeExtension(path.join(root, 'source')).root;
  const distribution = service(root);
  const preview = await distribution.prepare(source);
  await assert.rejects(
    distribution.installPrepared(preview.token, {
      acceptedPermissions: preview.permissions,
    }),
    (error) => error?.code === 'UNSAFE_MANAGED_PATH',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('dependencies block install, detect cycles, and prevent unsafe uninstall', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root, {
    dependencyResolver: (requirement) => requirement === 'builtin:studio-core',
  });
  const dependencySource = writeExtension(path.join(root, 'dependency'), {
    id: 'dependency.extension',
    name: 'Dependency',
  }).root;
  const dependencyPreview = await distribution.prepare(dependencySource);
  await distribution.installPrepared(dependencyPreview.token, {
    acceptedPermissions: dependencyPreview.permissions,
  });

  const dependentSource = writeExtension(path.join(root, 'dependent'), {
    id: 'dependent.extension',
    requires: ['user:dependency.extension', 'builtin:studio-core'],
  }).root;
  const dependentPreview = await distribution.prepare(dependentSource);
  assert.deepEqual(dependentPreview.missingDependencies, []);
  await distribution.installPrepared(dependentPreview.token, {
    acceptedPermissions: dependentPreview.permissions,
    acceptedRequirements: true,
  });

  const missingSource = writeExtension(path.join(root, 'missing'), {
    id: 'missing.extension',
    requires: ['user:not-installed'],
  }).root;
  const missingPreview = await distribution.prepare(missingSource);
  assert.deepEqual(missingPreview.missingDependencies, ['user:not-installed']);
  await assert.rejects(
    distribution.installPrepared(missingPreview.token, {
      acceptedPermissions: missingPreview.permissions,
      acceptedRequirements: true,
    }),
    /请先安装依赖扩展/,
  );

  const cycleSource = writeExtension(path.join(root, 'cycle'), {
    id: 'dependency.extension',
    version: '1.1.0',
    requires: ['user:dependent.extension'],
  }).root;
  await assert.rejects(distribution.prepare(cycleSource), /依赖形成循环/);

  await assert.rejects(
    distribution.uninstall('dependency.extension'),
    /仍被依赖/,
  );
  const forced = await distribution.uninstall('dependency.extension', { force: true });
  assert.equal(forced.removed, true);
});

test('new dependencies require explicit consent at install time', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root);
  const dependencySource = writeExtension(path.join(root, 'dependency'), {
    id: 'dependency.extension',
    name: 'Dependency',
  }).root;
  const dependencyPreview = await distribution.prepare(dependencySource);
  await distribution.installPrepared(dependencyPreview.token, {
    acceptedPermissions: dependencyPreview.permissions,
  });

  const firstSource = writeExtension(path.join(root, 'dependent-v1'), {
    id: 'dependent.extension',
    name: 'Dependent',
  }).root;
  const firstPreview = await distribution.prepare(firstSource);
  await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });

  const secondSource = writeExtension(path.join(root, 'dependent-v2'), {
    id: 'dependent.extension',
    name: 'Dependent',
    version: '1.1.0',
    requires: ['user:dependency.extension'],
  }).root;
  const secondPreview = await distribution.prepare(secondSource);
  assert.deepEqual(secondPreview.addedRequirements, ['user:dependency.extension']);
  assert.equal(secondPreview.requiresCapabilityConsent, true);

  await assert.rejects(
    distribution.installPrepared(secondPreview.token, {
      acceptedPermissions: secondPreview.addedPermissions,
    }),
    (error) => error?.code === 'REQUIREMENTS_CONSENT_REQUIRED',
  );
  assert.equal(distribution.getInstalled('dependent.extension').version, '1.0.0');

  const installed = await distribution.installPrepared(secondPreview.token, {
    acceptedPermissions: secondPreview.addedPermissions,
    acceptedRequirements: true,
  });
  assert.equal(installed.version, '1.1.0');
});

test('provider access and executable expansion each require their own consent', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root);
  const firstSource = writeExtension(path.join(root, 'first'), {
    id: 'capability.extension',
    name: 'Capability',
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'hello',
        title: 'Hello',
        action: { kind: 'openSettings', panel: 'extensions' },
      }],
    },
  }).root;
  const firstPreview = await distribution.prepare(firstSource);
  await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });

  const executableSource = writeExtension(path.join(root, 'executable'), {
    id: 'capability.extension',
    name: 'Capability',
    version: '1.1.0',
    permissions: ['ui.commands'],
    runtime: { durableEntry: 'extension.mjs' },
    contributes: {
      commands: [{ id: 'hello', title: 'Hello' }],
    },
  }, {
    'extension.mjs': "export const commands = { hello: () => 'ok' };\n",
  }).root;
  const executablePreview = await distribution.prepare(executableSource);
  assert.equal(executablePreview.executableExpansion, true);
  await assert.rejects(
    distribution.installPrepared(executablePreview.token, {
      acceptedPermissions: executablePreview.addedPermissions,
    }),
    (error) => error?.code === 'EXECUTION_CONSENT_REQUIRED',
  );
  await distribution.installPrepared(executablePreview.token, {
    acceptedPermissions: executablePreview.addedPermissions,
    acceptedExecution: true,
  });

  const credentialSource = writeExtension(path.join(root, 'credential'), {
    id: 'capability.extension',
    name: 'Capability',
    version: '1.2.0',
    permissions: ['ui.commands', 'provider.credentials'],
    providerAccess: ['deepseek'],
    runtime: { durableEntry: 'extension.mjs' },
    contributes: {
      commands: [{ id: 'hello', title: 'Hello' }],
    },
  }, {
    'extension.mjs': "export const commands = { hello: () => 'ok' };\n",
  }).root;
  const credentialPreview = await distribution.prepare(credentialSource);
  assert.deepEqual(credentialPreview.addedPermissions, ['provider.credentials']);
  assert.deepEqual(credentialPreview.addedProviderAccess, ['deepseek']);
  await assert.rejects(
    distribution.installPrepared(credentialPreview.token, {
      acceptedPermissions: credentialPreview.addedPermissions,
    }),
    (error) => error?.code === 'PROVIDER_ACCESS_CONSENT_REQUIRED',
  );
  const installed = await distribution.installPrepared(credentialPreview.token, {
    acceptedPermissions: credentialPreview.addedPermissions,
    acceptedProviderAccess: ['deepseek'],
  });
  assert.equal(installed.version, '1.2.0');
});

test('combined runtime, provider and dependency expansion requires every consent', async (t) => {
  const root = temporaryRoot(t);
  const distribution = service(root);
  const dependencySource = writeExtension(path.join(root, 'dependency'), {
    id: 'dependency.extension',
    name: 'Dependency',
  }).root;
  const dependencyPreview = await distribution.prepare(dependencySource);
  await distribution.installPrepared(dependencyPreview.token, {
    acceptedPermissions: dependencyPreview.permissions,
  });

  const firstSource = writeExtension(path.join(root, 'combined-v1'), {
    id: 'combined.extension',
    name: 'Combined',
    permissions: ['ui.commands'],
    contributes: {
      commands: [{
        id: 'hello',
        title: 'Hello',
        action: { kind: 'openSettings', panel: 'extensions' },
      }],
    },
  }).root;
  const firstPreview = await distribution.prepare(firstSource);
  await distribution.installPrepared(firstPreview.token, {
    acceptedPermissions: firstPreview.permissions,
  });

  const secondSource = writeExtension(path.join(root, 'combined-v2'), {
    id: 'combined.extension',
    name: 'Combined',
    version: '1.1.0',
    permissions: ['ui.commands', 'provider.credentials'],
    providerAccess: ['deepseek'],
    requires: ['user:dependency.extension'],
    runtime: { durableEntry: 'extension.mjs' },
    contributes: {
      commands: [{ id: 'hello', title: 'Hello' }],
    },
  }, {
    'extension.mjs': "export const commands = { hello: () => 'ok' };\n",
  }).root;
  const preview = await distribution.prepare(secondSource);
  assert.deepEqual(preview.addedPermissions, ['provider.credentials']);
  assert.deepEqual(preview.addedProviderAccess, ['deepseek']);
  assert.deepEqual(preview.addedRequirements, ['user:dependency.extension']);
  assert.equal(preview.executableExpansion, true);

  await assert.rejects(
    distribution.installPrepared(preview.token, {
      acceptedPermissions: preview.addedPermissions,
    }),
    (error) => error?.code === 'REQUIREMENTS_CONSENT_REQUIRED',
  );
  await assert.rejects(
    distribution.installPrepared(preview.token, {
      acceptedPermissions: preview.addedPermissions,
      acceptedRequirements: true,
    }),
    (error) => error?.code === 'PROVIDER_ACCESS_CONSENT_REQUIRED',
  );
  await assert.rejects(
    distribution.installPrepared(preview.token, {
      acceptedPermissions: preview.addedPermissions,
      acceptedRequirements: true,
      acceptedProviderAccess: preview.addedProviderAccess,
    }),
    (error) => error?.code === 'EXECUTION_CONSENT_REQUIRED',
  );
  const installed = await distribution.installPrepared(preview.token, {
    acceptedPermissions: preview.addedPermissions,
    acceptedRequirements: true,
    acceptedProviderAccess: preview.addedProviderAccess,
    acceptedExecution: true,
  });
  assert.equal(installed.version, '1.1.0');
});

test('distribution manifest normalizer matches the runtime host contract', () => {
  const samples = [
    manifest(),
    manifest({
      permissions: ['ui.commands', 'ui.panels'],
      requires: ['builtin:studio-core'],
      contributes: {
        commands: [{
          id: 'open',
          title: 'Open',
          action: { kind: 'openPanel', panelId: 'user:demo.extension/main' },
        }],
        panels: [{
          id: 'main',
          title: 'Main',
          slot: 'panel.side',
          content: [
            { kind: 'text', text: 'hello' },
            { kind: 'notice', tone: 'success', text: 'ready' },
          ],
        }],
      },
    }),
  ];
  for (const sample of samples) {
    assert.deepEqual(
      normalizeCoreManifest(sample, '/tmp/demo', 'user'),
      normalizeRuntimeManifest(sample, '/tmp/demo', 'user'),
    );
  }
});
