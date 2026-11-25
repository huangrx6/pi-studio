const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CHROMIUM_ENTRIES,
  STUDIO_DATA_ENTRIES,
  cleanLegacyChromiumData,
  migrateStudioData,
  migrateStudioLayout,
  pruneEmptyManagedDirectories,
} = require('../../electron/main/core/user-data.cjs');
const { STUDIO_DATA_DIRECTORY, studioDataDirectory } = require('../../electron/main/core/studio-paths.cjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-data-'));
  return {
    root,
    legacy: path.join(root, 'Library/Application Support/pi-studio'),
    target: path.join(root, '.pi-studio'),
  };
}

function seedLegacy(legacy) {
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'pi-studio.sqlite'), 'db');
  fs.writeFileSync(path.join(legacy, 'pi-studio.sqlite-wal'), 'wal');
  fs.writeFileSync(path.join(legacy, 'AGENTS.md'), '# rules');
  fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'skills', 'demo.md'), '# demo');
  fs.mkdirSync(path.join(legacy, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cache', 'block'), 'junk');
  fs.writeFileSync(path.join(legacy, 'SingletonLock'), 'lock');
}

test('默认数据目录是家目录下的 .pi-studio，环境变量优先', () => {
  const saved = process.env.PI_STUDIO_USER_DATA;
  delete process.env.PI_STUDIO_USER_DATA;
  assert.equal(studioDataDirectory(), path.join(os.homedir(), STUDIO_DATA_DIRECTORY));
  process.env.PI_STUDIO_USER_DATA = '/tmp/qa-profile';
  assert.equal(studioDataDirectory(), '/tmp/qa-profile');
  if (saved === undefined) delete process.env.PI_STUDIO_USER_DATA;
  else process.env.PI_STUDIO_USER_DATA = saved;
});

test('只搬 Studio 自己的条目，Chromium 文件留在原处', () => {
  const { legacy, target } = sandbox();
  seedLegacy(legacy);
  const result = migrateStudioData({ legacy, target });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite-wal'), 'utf8'), 'wal');
  assert.equal(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), '# rules');
  assert.equal(fs.readFileSync(path.join(target, 'skills', 'demo.md'), 'utf8'), '# demo');
  assert.equal(fs.existsSync(path.join(target, 'Cache')), false);
  assert.equal(fs.existsSync(path.join(target, 'SingletonLock')), false);
  assert.equal(fs.existsSync(path.join(legacy, 'Cache', 'block')), true, '旧目录保持原样');
  assert.deepEqual(result.copied.sort(), ['AGENTS.md', 'extensions', 'pi-studio.sqlite', 'pi-studio.sqlite-wal', 'skills']);
});

test('目标已有数据库时不再重复迁移', () => {
  const { legacy, target } = sandbox();
  seedLegacy(legacy);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'pi-studio.sqlite'), 'newer');
  const result = migrateStudioData({ legacy, target });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'already-migrated');
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite'), 'utf8'), 'newer');
});

test('已存在的同名条目不会被覆盖，旧目录缺失时什么都不做', () => {
  const { legacy, target } = sandbox();
  seedLegacy(legacy);
  fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(target, 'skills', 'demo.md'), 'keep');
  migrateStudioData({ legacy, target });
  assert.equal(fs.readFileSync(path.join(target, 'skills', 'demo.md'), 'utf8'), 'keep');
  assert.equal(migrateStudioData({ legacy: path.join(target, 'nope'), target: path.join(target, 'x') }).reason, 'no-legacy');
});

test('只有迁移标记存在时才清理误搬的 Chromium 文件', () => {
  const { target } = sandbox();
  fs.mkdirSync(path.join(target, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(target, 'pi-studio.sqlite'), 'db');
  assert.deepEqual(cleanLegacyChromiumData({ target }), [], '没有标记就不动');
  fs.writeFileSync(path.join(target, 'user-data-migration.json'), '{}');
  const removed = cleanLegacyChromiumData({ target });
  assert.ok(removed.includes('Cache'));
  assert.equal(fs.existsSync(path.join(target, 'Cache')), false);
  assert.equal(fs.existsSync(path.join(target, 'pi-studio.sqlite')), true, '业务数据不动');
  assert.ok(STUDIO_DATA_ENTRIES.includes('skills'));
  assert.ok(CHROMIUM_ENTRIES.includes('Local Storage'));
  assert.ok(CHROMIUM_ENTRIES.includes('WebStorage'));
  assert.ok(CHROMIUM_ENTRIES.includes('TransportSecurity'));
  assert.ok(CHROMIUM_ENTRIES.includes('Trust Tokens'));
  assert.ok(CHROMIUM_ENTRIES.includes('.updaterId'));
  // Second pass is an O(1) no-op once the marker stamps chromiumCleanedVersion.
  fs.mkdirSync(path.join(target, 'Cache'), { recursive: true });
  assert.deepEqual(cleanLegacyChromiumData({ target }), []);
});

test('修剪空托管目录只移除空目录，保留非空目录、隐藏目录和软链接', () => {
  const { target } = sandbox();
  const emptyState = path.join(target, 'extension-state', 'project-aaa111');
  const filledState = path.join(target, 'extension-state', 'user');
  const journal = path.join(target, 'extension-state', '.uninstall-journal');
  const emptyData = path.join(target, 'extension-data', 'project-bbb222');
  const emptyQuarantine = path.join(target, 'plugin-quarantine');
  const filledQuarantine = path.join(target, 'skill-quarantine');
  for (const dir of [emptyState, filledState, journal, emptyData, emptyQuarantine, filledQuarantine]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(filledState, 'demo.json'), '{}');
  fs.writeFileSync(path.join(filledQuarantine, 'pending.zip'), 'zip');

  const removed = pruneEmptyManagedDirectories({ target });
  assert.ok(removed.includes(path.join('extension-state', 'project-aaa111')));
  assert.ok(removed.includes(path.join('extension-data', 'project-bbb222')));
  assert.ok(removed.includes('plugin-quarantine'));
  assert.equal(fs.existsSync(emptyState), false);
  assert.equal(fs.existsSync(emptyData), false);
  assert.equal(fs.existsSync(emptyQuarantine), false);
  assert.equal(fs.existsSync(filledState), true);
  assert.equal(fs.existsSync(journal), true);
  assert.equal(fs.existsSync(filledQuarantine), true);
});

test('v1 到 v2 目录结构迁移幂等收敛托管数据与缓存，保留用户顶层资源且不误删小写 cache', () => {
  const { target } = sandbox();
  fs.mkdirSync(path.join(target, 'attachments', 'draft'), { recursive: true });
  fs.writeFileSync(path.join(target, 'attachments', 'draft', 'doc.txt'), 'hello');
  fs.mkdirSync(path.join(target, 'background-media'), { recursive: true });
  fs.writeFileSync(path.join(target, 'background-media', 'bg.png'), 'png');
  fs.mkdirSync(path.join(target, 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(target, 'worktrees', '.DS_Store'), '');
  fs.mkdirSync(path.join(target, 'plugin-data', 'studio.task-board'), { recursive: true });
  fs.writeFileSync(path.join(target, 'plugin-data', 'studio.task-board', 'tasks.sqlite'), 'db');
  fs.mkdirSync(path.join(target, 'extension-data', 'user', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(target, 'extension-data', 'user', 'demo', 'state.json'), '{}');
  fs.mkdirSync(path.join(target, 'extension-state', 'user'), { recursive: true });
  fs.writeFileSync(path.join(target, 'extension-state', 'user', 'demo.json'), '{}');
  fs.mkdirSync(path.join(target, 'model-catalogs'), { recursive: true });
  fs.writeFileSync(path.join(target, 'model-catalogs', 'models.dev.json'), '{}');
  fs.mkdirSync(path.join(target, 'extension-cache', 'quarantine'), { recursive: true });
  fs.mkdirSync(path.join(target, 'browser-downloads'), { recursive: true });
  fs.mkdirSync(path.join(target, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(target, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(target, 'user-data-migration.json'), '{"migrated":true}\n');
  fs.writeFileSync(path.join(target, 'pi-studio.sqlite'), 'sqlite');

  const first = migrateStudioLayout({ target });
  assert.ok(first.moved.length >= 6);
  assert.equal(fs.readFileSync(path.join(target, 'data', 'attachments', 'draft', 'doc.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'background-media', 'bg.png'), 'utf8'), 'png');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'plugin-data', 'studio.task-board', 'tasks.sqlite'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'extension-data', 'user', 'demo', 'state.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'extension-state', 'user', 'demo.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(target, 'cache', 'model-catalogs', 'models.dev.json'), 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(target, 'data', 'user-data-migration.json')), true);
  // Empty legacy directories (including .DS_Store-only) are removed rather than creating empty shells.
  assert.equal(fs.existsSync(path.join(target, 'worktrees')), false);
  assert.equal(fs.existsSync(path.join(target, 'data', 'worktrees')), false);
  assert.equal(fs.existsSync(path.join(target, 'browser-downloads')), false);
  assert.equal(fs.existsSync(path.join(target, 'downloads')), false);
  assert.equal(fs.existsSync(path.join(target, 'extension-cache')), false);
  // Top-level user resources remain untouched.
  assert.equal(fs.existsSync(path.join(target, 'plugins')), true);
  assert.equal(fs.existsSync(path.join(target, 'skills')), true);
  assert.equal(fs.existsSync(path.join(target, 'extensions')), true);
  assert.equal(fs.existsSync(path.join(target, 'pi-studio.sqlite')), true);

  // Case-insensitive macOS safety: Chromium cleanup ('Cache') must never delete Studio's lowercase 'cache'.
  assert.deepEqual(cleanLegacyChromiumData({ target }), []);
  assert.equal(fs.existsSync(path.join(target, 'cache', 'model-catalogs', 'models.dev.json')), true);

  // Second pass is a strict no-op.
  assert.deepEqual(migrateStudioLayout({ target }).moved, []);
});
