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
} = require('../../electron/core/user-data.cjs');
const { STUDIO_DATA_DIRECTORY, studioDataDirectory } = require('../../electron/core/studio-paths.cjs');

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
});
