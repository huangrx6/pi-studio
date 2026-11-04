const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createZipArchive, sha256 } = require('../../electron/core/extension-archive.cjs');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

installElectronSafeStorage(test);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-skill-hub-'));
process.env.PI_STUDIO_USER_DATA = path.join(temporary, 'user-data');
process.env.PI_STUDIO_DB = path.join(temporary, 'studio.sqlite');

const {
  closeStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  addSkillSource,
  listSkillSources,
  removeSkillSource,
  installPreparedSkill,
  prepareSkillInstall,
  refreshSkillCatalog,
  saveSkillSource,
  skillHubSnapshot,
  setSkillSourceEnabled,
  __test,
} = require('../../electron/capabilities/skills/index.cjs');

test.after(() => {
  closeStudioDatabase();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('GitHub sources discover nested and root skills and install the catalog commit', async (t) => {
  const original = global.fetch;
  const added = [];
  t.after(() => { global.fetch = original; added.forEach(removeSkillSource); });
  const commit = 'a'.repeat(40);
  const skill = (name) => Buffer.from(`---\nname: ${name}\ndescription: GitHub fixture\n---\nUse this skill.\n`);
  const archive = createZipArchive([
    { path: 'repo/skills/nested/SKILL.md', content: skill('nested') },
    { path: 'repo/skills/nested/scripts/run.sh', content: Buffer.from('echo fixture') },
    { path: 'repo/top-level/SKILL.md', content: skill('top-level') },
    { path: 'repo/broken/SKILL.md', content: Buffer.from('no metadata') },
    { path: 'repo/README.md', content: Buffer.from('[External skill](https://example.com/SKILL.md)') },
  ]);
  const requests = [];
  global.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith('/commits/HEAD')) return Response.json({ sha: commit });
    assert.ok(url.endsWith(`/zip/${commit}`));
    return new Response(archive);
  };
  for (const location of ['https://github.com/anthropics/skills.git/', 'https://github.com/ComposioHQ/awesome-claude-skills']) {
    // Wrong form type must not turn a repository into a JSON registry.
    const source = await addSkillSource({ type: 'registry', location });
    added.push(source.id);
    assert.equal(source.type, 'github');
    assert.equal(source.itemCount, 2);
    assert.equal(source.lastError, '');
    const snapshot = await skillHubSnapshot();
    const catalog = snapshot.catalogs.find((row) => row.source.id === source.id);
    assert.deepEqual(catalog.items.map((item) => item.name).sort(), ['nested', 'top-level']);
    assert.equal(catalog.diagnostics.length, 1);
    assert.ok(!catalog.diagnostics[0].path.includes(temporary));
    const preview = await prepareSkillInstall({ sourceId: source.id, listingId: 'github:skills/nested', scope: 'user' });
    assert.deepEqual(preview.files.map((file) => file.path).sort(), ['SKILL.md', 'scripts/run.sh']);
    assert.match(preview.version, /^0\.0\.0\+[a-f0-9]{12}$/);
    assert.ok(requests.at(-1).endsWith(`/zip/${commit}`));
    const installed = installPreparedSkill({ token: preview.token });
    assert.ok(fs.existsSync(path.join(installed.baseDir, 'scripts/run.sh')));
    fs.rmSync(installed.baseDir, { recursive: true });
    require('../../electron/core/studio-db.cjs').getStudioDatabase().removeSkillInstallation(installed.baseDir);
    await assert.rejects(addSkillSource({ type: 'github', location: source.location.toUpperCase() }), /已经添加/);
  }
});

test('failed source additions do not persist and can be retried', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const before = listSkillSources();
  const location = 'https://github.com/example/unavailable';
  global.fetch = async () => new Response('', { status: 404 });
  await assert.rejects(addSkillSource({ type: 'github', location }), /公开可访问/);
  global.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(addSkillSource({ type: 'github', location }), /请求受限/);
  global.fetch = async (url) => url.endsWith('/commits/HEAD')
    ? Response.json({ sha: 'b'.repeat(40) })
    : new Response(createZipArchive([{ path: 'repo/README.md', content: Buffer.from('Only links') }]));
  await assert.rejects(addSkillSource({ type: 'github', location }), /没有可安装/);
  assert.deepEqual(listSkillSources(), before);
  global.fetch = async () => new Response('<html>not JSON</html>');
  await assert.rejects(addSkillSource({ type: 'registry', location: 'https://example.com/catalog.json' }), /不是有效 JSON/);
  assert.deepEqual(listSkillSources(), before);
});

test('v17 migration preserves source metadata and installation ownership', () => {
  const { createStudioDatabase } = require('../../electron/core/studio-db.cjs');
  const { DatabaseSync } = require('node:sqlite');
  const filename = path.join(temporary, 'migration.sqlite');
  const previous = createStudioDatabase(filename);
  const source = previous.upsertSkillSource({ id: 'existing', type: 'registry', name: 'Existing', location: '/catalog.json', enabled: false, lastSyncedAt: 123, itemCount: 7, lastError: 'offline' });
  previous.upsertSkillInstallation({ path: '/installed/demo', sourceId: source.id, listingId: 'registry:demo', name: 'demo', version: '1.0.0', sha256: 'a'.repeat(64) });
  const installation = previous.getSkillInstallation('/installed/demo');
  previous.close();
  const old = new DatabaseSync(filename);
  old.exec(`
    ALTER TABLE skill_sources RENAME TO source_copy;
    CREATE TABLE skill_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('directory', 'registry')),
      location TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at INTEGER, item_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO skill_sources SELECT * FROM source_copy;
    DROP TABLE source_copy;
    PRAGMA user_version = 17;
  `);
  old.close();
  const migrated = createStudioDatabase(filename);
  try {
    assert.deepEqual(migrated.listSkillSources(), [source]);
    assert.deepEqual(migrated.getSkillInstallation('/installed/demo'), installation);
    assert.equal(migrated.upsertSkillSource({ id: 'github', name: 'GitHub', type: 'github', location: 'https://github.com/anthropics/skills' }).type, 'github');
  } finally { migrated.close(); }
});

test('catalog refresh removes vanished entries and disabled sources cannot be installed', async () => {
  const root = path.join(temporary, 'cache-source');
  const skill = path.join(root, 'cache-demo');
  writeSkill(skill, 'cache-demo', '1.0.0', 'Cache fixture.');
  const source = saveSkillSource({ type: 'directory', location: root });
  await refreshSkillCatalog();
  fs.rmSync(skill, { recursive: true });
  await refreshSkillCatalog();
  const cached = await skillHubSnapshot();
  assert.equal(cached.catalogs.find((catalog) => catalog.source.id === source.id).items.length, 0);
  await assert.rejects(prepareSkillInstall({ sourceId: source.id, listingId: 'directory:cache-demo', scope: 'user' }), /刷新/);
  writeSkill(skill, 'cache-demo', '1.0.0', 'Cache fixture.');
  await refreshSkillCatalog();
  setSkillSourceEnabled(source.id, false);
  assert.equal((await skillHubSnapshot()).catalogs.find((catalog) => catalog.source.id === source.id).items.length, 0);
  await assert.rejects(prepareSkillInstall({ sourceId: source.id, listingId: 'directory:cache-demo', scope: 'user' }), /停用/);
});

test('prepared project installs stay bound to the reviewed workspace', async () => {
  const root = path.join(temporary, 'bound-source');
  writeSkill(path.join(root, 'bound-demo'), 'bound-demo', '1.0.0', 'Bound fixture.');
  const source = saveSkillSource({ type: 'directory', location: root });
  await refreshSkillCatalog();
  const cwd = path.join(temporary, 'bound-workspace');
  const other = path.join(temporary, 'other-workspace');
  fs.mkdirSync(cwd); fs.mkdirSync(other);
  const preview = await prepareSkillInstall({ sourceId: source.id, listingId: 'directory:bound-demo', scope: 'project', cwd });
  assert.throws(() => installPreparedSkill({ token: preview.token, cwd: other }), /预览不一致/);
  assert.equal(fs.existsSync(path.join(other, '.pi-studio')), false);
  assert.ok(installPreparedSkill({ token: preview.token }).baseDir.startsWith(cwd));
});

test('downloads enforce the byte limit while streaming even without Content-Length', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(__test.readLimitedResponse(response, 'fixture', 12), /超过 12/);
  assert.equal(cancelled, true);
});

test('HTTP loopback registries resolve relative packages against the final redirect URL', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async (url) => url.endsWith('/start')
    ? new Response(null, { status: 302, headers: { location: '/catalog/skills.json' } })
    : Response.json({ schemaVersion: 1, skills: [{
        name: 'remote-demo', description: 'remote', version: '1.0.0',
        download: './package.zip', sha256: 'a'.repeat(64),
      }] });
  const source = saveSkillSource({ type: 'registry', location: 'http://127.0.0.1:12345/start' });
  const { entries } = await __test.readRegistry(source);
  assert.equal(entries[0].download, 'http://127.0.0.1:12345/catalog/package.zip');
  setSkillSourceEnabled(source.id, false);
});

function writeSkill(root, name, version, description) {
  fs.mkdirSync(path.join(root, 'references'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    `  version: ${version}`,
    '---',
    '',
    `Use the ${name} workflow.`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'references', 'guide.md'), `${version}\n`);
}

test('directory and registry skill sources share preview, install, and update flow', async () => {
  const directorySource = path.join(temporary, 'directory-source');
  writeSkill(path.join(directorySource, 'directory-demo'), 'directory-demo', '1.0.0', 'A directory skill.');
  const source = saveSkillSource({
    name: 'Team skills',
    type: 'directory',
    location: directorySource,
  });
  let hub = await refreshSkillCatalog();
  let item = hub.catalogs.find((catalog) => catalog.source.id === source.id).items.find((entry) => entry.name === 'directory-demo');
  assert.equal(item.sourceName, 'Team skills');
  assert.equal(item.version, '1.0.0');
  assert.equal(item.promptTokens > 0, true);
  assert.equal(item.resourceCount, 1);

  let preview = await prepareSkillInstall({
    sourceId: source.id,
    listingId: item.listingId,
    scope: 'user',
  });
  assert.equal(preview.canUpdate, false);
  assert.deepEqual(
    preview.files.map((file) => file.path).sort(),
    ['SKILL.md', 'references/guide.md'].sort(),
  );
  const installed = installPreparedSkill({ token: preview.token });
  assert.equal(installed.version, '1.0.0');
  assert.match(fs.readFileSync(installed.path, 'utf8'), /Use the directory-demo workflow/);

  writeSkill(path.join(directorySource, 'directory-demo'), 'directory-demo', '1.1.0', 'An updated directory skill.');
  hub = await refreshSkillCatalog();
  item = hub.catalogs.find((catalog) => catalog.source.id === source.id).items.find((entry) => entry.name === 'directory-demo');
  assert.equal(item.updateAvailable, true);
  preview = await prepareSkillInstall({
    sourceId: source.id,
    listingId: item.listingId,
    scope: 'user',
  });
  assert.equal(preview.canUpdate, true);
  const updated = installPreparedSkill({ token: preview.token });
  assert.equal(updated.version, '1.1.0');
  assert.match(fs.readFileSync(updated.path, 'utf8'), /An updated directory skill/);

  const registryArchive = createZipArchive([
    {
      path: 'registry-demo/SKILL.md',
      content: [
        '---',
        'name: registry-demo',
        'description: A registry skill.',
        'metadata:',
        '  version: 2.0.0',
        '---',
        '',
        'Use the registry workflow.',
        '',
      ].join('\n'),
    },
    {
      path: 'registry-demo/references/guide.md',
      content: 'registry reference\n',
    },
  ]);
  const registryDirectory = path.join(temporary, 'registry');
  fs.mkdirSync(registryDirectory, { recursive: true });
  fs.writeFileSync(path.join(registryDirectory, 'registry-demo.zip'), registryArchive);
  fs.writeFileSync(path.join(registryDirectory, 'skills.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'Fixture registry',
    skills: [{
      name: 'registry-demo',
      description: 'A registry skill.',
      version: '2.0.0',
      invocation: 'automatic',
      download: 'registry-demo.zip',
      sha256: sha256(registryArchive),
      resourceCount: 1,
    }],
  }));
  saveSkillSource({
    name: 'Fixture registry',
    type: 'registry',
    location: path.join(registryDirectory, 'skills.json'),
  });
  hub = await skillHubSnapshot({ refresh: true });
  const registryCatalog = hub.catalogs.find((catalog) => catalog.source.name === 'Fixture registry');
  const registryItem = registryCatalog.items[0];
  preview = await prepareSkillInstall({
    sourceId: registryItem.sourceId,
    listingId: registryItem.listingId,
    scope: 'user',
  });
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  const registryInstalled = installPreparedSkill({ token: preview.token });
  assert.equal(registryInstalled.version, '2.0.0');
  assert.match(fs.readFileSync(registryInstalled.path, 'utf8'), /Use the registry workflow/);
});

test('project skill installation requires and uses an explicit workspace', async () => {
  const sourceRoot = path.join(temporary, 'project-source');
  writeSkill(path.join(sourceRoot, 'project-demo'), 'project-demo', '1.0.0', 'A project skill.');
  const source = saveSkillSource({
    name: 'Project source',
    type: 'directory',
    location: sourceRoot,
  });
  const hub = await refreshSkillCatalog();
  const item = hub.catalogs
    .find((catalog) => catalog.source.id === source.id)
    .items.find((entry) => entry.name === 'project-demo');
  await assert.rejects(
    prepareSkillInstall({ sourceId: source.id, listingId: item.listingId, scope: 'project' }),
    /选择工作区/,
  );
  const workspace = path.join(temporary, 'selected-workspace');
  fs.mkdirSync(workspace);
  const preview = await prepareSkillInstall({
    sourceId: source.id,
    listingId: item.listingId,
    scope: 'project',
    cwd: workspace,
  });
  assert.equal(preview.requiresTrust, true);
  const installed = installPreparedSkill({ token: preview.token, cwd: workspace });
  assert.equal(
    installed.baseDir,
    path.join(workspace, '.pi-studio', 'skills', 'project-demo'),
  );
});

test('registry integrity, archive format, traversal and same-name ownership fail safely', async () => {
  const registryDirectory = path.join(temporary, 'hostile-registry');
  fs.mkdirSync(registryDirectory, { recursive: true });
  const skillMarkdown = (name) => [
    '---',
    `name: ${name}`,
    'description: Hostile fixture.',
    '---',
    '',
    'Never execute untrusted content during install.',
    '',
  ].join('\n');
  const notZip = Buffer.from('this is not a zip archive');
  fs.writeFileSync(path.join(registryDirectory, 'not-zip.zip'), notZip);
  const validArchive = createZipArchive([{
    path: 'integrity-demo/SKILL.md',
    content: skillMarkdown('integrity-demo'),
  }]);
  fs.writeFileSync(path.join(registryDirectory, 'integrity-demo.zip'), validArchive);

  const safePrefix = createZipArchive([{
    path: 'safe/..x/SKILL.md',
    content: skillMarkdown('traversal-demo'),
  }]);
  const hostileArchive = Buffer.from(safePrefix);
  const hostileName = Buffer.from('safe/..x/SKILL.md');
  const traversalName = Buffer.from('safe/../SKILL.md');
  let offset = 0;
  while ((offset = hostileArchive.indexOf(hostileName, offset)) >= 0) {
    traversalName.copy(hostileArchive, offset);
    offset += traversalName.length;
  }
  fs.writeFileSync(path.join(registryDirectory, 'traversal.zip'), hostileArchive);

  fs.writeFileSync(path.join(registryDirectory, 'skills.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'Hostile fixture',
    skills: [
      {
        name: 'integrity-demo',
        description: 'Integrity mismatch.',
        version: '1.0.0',
        download: 'integrity-demo.zip',
        sha256: '0'.repeat(64),
      },
      {
        name: 'not-zip',
        description: 'Not a zip.',
        version: '1.0.0',
        download: 'not-zip.zip',
        sha256: sha256(notZip),
      },
      {
        name: 'traversal-demo',
        description: 'Traversal attempt.',
        version: '1.0.0',
        download: 'traversal.zip',
        sha256: sha256(hostileArchive),
      },
    ],
  }));
  const registrySource = saveSkillSource({
    name: 'Hostile registry',
    type: 'registry',
    location: path.join(registryDirectory, 'skills.json'),
  });
  const hub = await refreshSkillCatalog();
  const items = hub.catalogs
    .find((catalog) => catalog.source.id === registrySource.id)
    .items;
  const byName = new Map(items.map((item) => [item.name, item]));
  await assert.rejects(
    prepareSkillInstall({
      sourceId: registrySource.id,
      listingId: byName.get('integrity-demo').listingId,
      scope: 'user',
    }),
    /完整性校验失败/,
  );
  await assert.rejects(
    prepareSkillInstall({
      sourceId: registrySource.id,
      listingId: byName.get('not-zip').listingId,
      scope: 'user',
    }),
    /ZIP|压缩包|zip/i,
  );
  await assert.rejects(
    prepareSkillInstall({
      sourceId: registrySource.id,
      listingId: byName.get('traversal-demo').listingId,
      scope: 'user',
    }),
    /\.\.|越界|路径/,
  );
  assert.throws(
    () => saveSkillSource({
      name: 'Duplicate registry',
      type: 'registry',
      location: path.join(registryDirectory, 'skills.json'),
    }),
    /已经添加/,
  );

  const firstSource = path.join(temporary, 'same-name-a');
  const secondSource = path.join(temporary, 'same-name-b');
  writeSkill(path.join(firstSource, 'shared-name'), 'shared-name', '1.0.0', 'First owner.');
  writeSkill(path.join(secondSource, 'shared-name'), 'shared-name', '2.0.0', 'Second owner.');
  const first = saveSkillSource({
    name: 'Same-name A',
    type: 'directory',
    location: firstSource,
  });
  const second = saveSkillSource({
    name: 'Same-name B',
    type: 'directory',
    location: secondSource,
  });
  const next = await refreshSkillCatalog();
  const firstItem = next.catalogs
    .find((catalog) => catalog.source.id === first.id)
    .items[0];
  const secondItem = next.catalogs
    .find((catalog) => catalog.source.id === second.id)
    .items[0];
  const firstPreview = await prepareSkillInstall({
    sourceId: first.id,
    listingId: firstItem.listingId,
    scope: 'user',
  });
  installPreparedSkill({ token: firstPreview.token });
  const secondPreview = await prepareSkillInstall({
    sourceId: second.id,
    listingId: secondItem.listingId,
    scope: 'user',
  });
  assert.throws(
    () => installPreparedSkill({ token: secondPreview.token }),
    /另一个技能源管理/,
  );
});
