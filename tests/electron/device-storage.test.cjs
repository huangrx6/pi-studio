const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDeviceStorageService, storageLocations, updateCacheDirectory } = require('../../electron/main/services/device-storage.cjs');

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-storage-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const studio = path.join(home, '.pi-studio');
  const appData = path.join(home, 'Application Support');
  const client = path.join(appData, 'Pi Studio');
  const sources = { home, appData, studio, client, session: client, database: path.join(studio, 'studio.sqlite'), projects: [], worktrees: [] };
  await Promise.all([studio, client].map(dir => fs.mkdir(dir, { recursive: true })));
  async function file(folder, name, bytes) {
    const dest = path.join(folder, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.alloc(bytes));
    return dest;
  }
  const actions = [];
  const service = createDeviceStorageService({
    getSources: () => sources,
    clipboard: { writeText: dest => actions.push(['copy', dest]) },
    shell: {
      openPath: async dest => { actions.push(['open', dest]); return ''; },
      showItemInFolder: dest => { actions.push(['show', dest]); },
    },
  });
  return { base, sources, file, actions, service };
}

test('counts application data by category, with nested client data, project settings and hard-linked uploads counted once', async t => {
  const { base, sources, file, service } = await fixture(t);
  const { studio, home, database } = sources;
  sources.session = path.join(sources.client, 'session');
  const project = path.join(base, 'project');
  sources.projects = [project, project, home, path.join(base, 'no-settings')];
  const files = await Promise.all([
    file(studio, path.basename(database), 11), file(studio, 'studio.sqlite-wal', 3),
    file(studio, 'backups/sqlite/studio.sqlite.migration-backup-v1-to-v2.sqlite', 17),
    file(studio, 'attachments/image.png', 13), file(studio, 'worktrees/check/file', 7),
    file(studio, 'plugins/extension/tool', 5), file(studio, 'background-media/image.jpg', 9),
    file(studio, 'browser-downloads/report.pdf', 1), file(studio, 'shell/data', 2),
    file(sources.client, 'Local State', 19), file(sources.session, 'Cache/index', 23),
    file(project, '.pi-studio/skills/SKILL.md', 29), file(project, 'source.ts', 500),
    file(studio, 'plugin-data/extension/data/scene.json', 4),
  ]);
  await fs.link(files[3], path.join(studio, 'attachments', 'second-name'));
  await fs.link(files[3], path.join(studio, 'duplicate-of-upload'));
  await fs.symlink(project, path.join(studio, 'attachments', 'linked-project'), 'junction');
  const first = service.snapshot();
  assert.equal(service.snapshot(), first);
  const result = await first;
  assert.deepEqual(result.categories, { database: 31, attachments: 13, worktrees: 7, resources: 38, media: 10, client: 42, other: 2 });
  assert.equal(result.totalBytes, 143);
  assert.deepEqual(result.locations.map(row => [row.kind, row.bytes, row.status]), [
    ['studio', 72, 'ready'], ['client', 19, 'ready'], ['session', 23, 'ready'], ['project', 29, 'ready'],
  ]);
  assert.equal(JSON.stringify(result).includes(base), false);
  await file(studio, 'attachments/next.txt', 37);
  assert.equal((await service.snapshot()).totalBytes, 180);
});

test('counts only the external SQLite family, matching backups and managed external worktree folders', async t => {
  const { base, sources, file, service, actions } = await fixture(t);
  const external = path.join(base, 'external');
  sources.database = await file(external, 'other.sqlite', 13);
  const tree = path.join(external, 'Pi-Studio-worktrees');
  sources.worktrees = [tree, tree, path.join(base, 'offline', 'Pi-Studio-worktrees')];
  await Promise.all([
    file(external, 'other.sqlite-shm', 3), file(external, 'other.sqlite-wal', 4), file(external, 'other.sqlite-journal', 2),
    file(external, 'unrelated.zip', 1000), file(tree, 'abc/checkout/index.ts', 23),
    file(external, 'backups/sqlite/other.sqlite.migration-backup-v1-to-v2-copy-1.sqlite', 19),
    file(external, 'backups/sqlite/personal.sqlite.migration-backup-v1-to-v2.sqlite', 100),
  ]);
  const result = await service.snapshot();
  assert.equal(result.totalBytes, 64);
  assert.equal(result.categories.database, 41);
  assert.equal(result.categories.worktrees, 23);
  const offline = result.locations.find(item => item.status === 'unavailable');
  assert.equal(offline.canOpen, false);
  await assert.rejects(service.useLocation(offline.id, 'open'));
  await assert.rejects(service.useLocation(external, 'open'));
  await assert.rejects(service.useLocation('studio', 'delete'));
  await service.useLocation('studio', 'open');
  await service.useLocation('database', 'open');
  await service.useLocation('database', 'copy');
  assert.deepEqual(actions, [['open', sources.studio], ['show', sources.database], ['copy', sources.database]]);
  await fs.rename(sources.database, sources.database + '.moved');
  await assert.rejects(service.useLocation('database', 'open'), /刷新/);
});

test('merged profiles keep browser data separate in the breakdown, and links and broad or legacy roots are never walked', async t => {
  const { base, sources, file, service } = await fixture(t);
  sources.client = sources.studio;
  sources.session = sources.studio;
  await file(sources.studio, 'Local Storage/leveldb/value', 53);
  await file(sources.studio, 'worktrees/one/data', 7);
  await file(sources.studio, 'Cache/index', 5);
  const legacy = path.join(sources.home, '.pi');
  await file(legacy, 'placeholder', 100);
  const unsafeProject = path.join(base, 'unsafe-project');
  await fs.mkdir(unsafeProject);
  await fs.symlink(legacy, path.join(unsafeProject, '.pi-studio'), 'junction');
  sources.projects = [unsafeProject, legacy];
  sources.worktrees = [sources.home, sources.appData, path.parse(base).root];
  const result = await service.snapshot();
  assert.equal(result.totalBytes, 65);
  assert.equal(result.categories.client, 58);
  assert.equal(result.locations[0].shared, true);
  assert.deepEqual(result.locations.filter(row => row.canOpen).map(row => row.id), ['studio']);
});

test('Windows profiles preserve native names, merge case variants and distinguish redirected profiles, drives and UNC locations', () => {
  const p = path.win32;
  const home = p.join('C:\\', 'Users', '小林');
  const appData = p.join('Z:\\', 'Roaming 配置');
  const client = p.join(appData, 'Pi Studio');
  const studio = p.join(home, '.pi-studio');
  const share = '\\\\nas\\studio share';
  const roots = [p.join(share, 'Pi-Studio-worktrees'), p.join('E:\\', 'Pi-Studio-worktrees')];
  const specs = storageLocations({ home, appData, studio, client, session: client.toUpperCase(),
    database: p.join('D:\\', '数据', 'studio.sqlite'), projects: [home, p.join('D:\\', '研发')], worktrees: roots }, p);
  assert.deepEqual(specs.map(({ kind, name, place }) => [kind, name, place]), [
    ['studio', '.pi-studio', '个人文件夹'], ['client', 'Pi Studio', '应用数据文件夹'],
    ['worktrees', 'Pi-Studio-worktrees', '网络位置'], ['worktrees', 'Pi-Studio-worktrees', 'E:'],
    ['project', '.pi-studio', '研发'], ['database', 'studio.sqlite', 'D:'],
  ]);
  assert.equal(new Set(specs.map(row => row.id)).size, specs.length);
});

test('handles relocated profiles, skips inaccessible children and allows a fresh measurement after recovery', async t => {
  const { base, sources, file, service, actions } = await fixture(t);
  const alias = path.join(base, 'relocated');
  await fs.symlink(sources.studio, alias, 'junction');
  sources.client = alias;
  sources.session = alias;
  await file(sources.studio, 'attachments/one', 5);
  await file(sources.studio, 'attachments/locked/two', 11);
  const original = fs.readdir;
  const lock = t.mock.method(fs, 'readdir', async (dir, ...options) => {
    if (dir === path.join(sources.studio, 'attachments', 'locked')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original(dir, ...options);
  });
  const partial = await service.snapshot();
  assert.equal(partial.locations.length, 1);
  assert.equal(partial.locations[0].shared, true);
  assert.equal(partial.locations[0].status, 'partial');
  assert.equal(partial.totalBytes, 5);
  lock.mock.restore();
  sources.studio = alias;
  const complete = await service.snapshot();
  assert.equal(complete.locations[0].status, 'ready');
  assert.equal(complete.totalBytes, 16);
  await service.useLocation('studio', 'open');
  assert.deepEqual(actions, [['open', await fs.realpath(alias)]]);
});

test('uses the packaged updater cache name and counts only that application cache', async t => {
  const { base, sources, file, service } = await fixture(t);
  const cacheBase = path.join(base, 'system-cache');
  assert.equal(await updateCacheDirectory(base, cacheBase), undefined);
  const config = path.join(base, 'app-update.yml');
  await fs.writeFile(config, 'updaterCacheDirName: ../other-app\n');
  assert.equal(await updateCacheDirectory(base, cacheBase), undefined);
  await fs.writeFile(config, 'updaterCacheDirName: studio-release-cache\n');
  sources.updates = await updateCacheDirectory(base, cacheBase);
  assert.equal(sources.updates, path.join(cacheBase, 'studio-release-cache'));
  await file(sources.updates, 'pending/update.zip', 43);
  await file(cacheBase, 'other-app/package.zip', 500);
  const result = await service.snapshot();
  assert.equal(result.totalBytes, 43);
  assert.equal(result.categories.client, 43);
  assert.equal(result.locations.find(row => row.kind === 'updates').bytes, 43);
});
