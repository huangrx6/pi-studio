const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DATA_DIRECTORY_NAME,
  SKIPPED_ENTRIES,
  migrateLegacyUserData,
  resolveUserDataDirectory,
} = require('../../electron/core/user-data.cjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-userdata-'));
  return { root, legacy: path.join(root, 'Library/Application Support/pi-studio'), target: path.join(root, '.pi-studio') };
}

function seedLegacy(legacy) {
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'pi-studio.sqlite'), 'db');
  fs.writeFileSync(path.join(legacy, 'pi-studio.sqlite-wal'), 'wal');
  fs.mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'skills', 'demo.md'), '# demo');
  fs.mkdirSync(path.join(legacy, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'GPUCache', 'block'), 'junk');
  fs.writeFileSync(path.join(legacy, 'SingletonLock'), 'lock');
  fs.mkdirSync(path.join(legacy, 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Local Storage', 'prefs'), 'value');
}

test('默认目录是家目录下的 .pi-studio，覆盖变量优先', () => {
  assert.equal(resolveUserDataDirectory({ home: '/Users/demo' }), path.join('/Users/demo', DATA_DIRECTORY_NAME));
  assert.equal(resolveUserDataDirectory({ home: '/Users/demo', override: '/tmp/qa' }), '/tmp/qa');
  assert.equal(resolveUserDataDirectory({ home: '/Users/demo', override: '  ' }), path.join('/Users/demo', DATA_DIRECTORY_NAME));
});

test('首次启动把旧目录复制过来，跳过缓存与运行期锁', () => {
  const { legacy, target } = sandbox();
  seedLegacy(legacy);
  const result = migrateLegacyUserData({ legacy, target });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite-wal'), 'utf8'), 'wal');
  assert.equal(fs.readFileSync(path.join(target, 'skills', 'demo.md'), 'utf8'), '# demo');
  // Local Storage 保存的是偏好设置，必须一起搬。
  assert.equal(fs.readFileSync(path.join(target, 'Local Storage', 'prefs'), 'utf8'), 'value');
  for (const skipped of ['GPUCache', 'SingletonLock']) {
    assert.equal(fs.existsSync(path.join(target, skipped)), false, `${skipped} 不应被复制`);
    assert.equal(fs.existsSync(path.join(legacy, skipped)), true, '旧目录保持原样');
  }
  assert.equal(SKIPPED_ENTRIES.has('GPUCache'), true);
  const marker = JSON.parse(fs.readFileSync(path.join(target, 'user-data-migration.json'), 'utf8'));
  assert.equal(marker.from, path.resolve(legacy));
});

test('目标目录已有数据库时不再重复迁移', () => {
  const { legacy, target } = sandbox();
  seedLegacy(legacy);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'pi-studio.sqlite'), 'newer');
  const result = migrateLegacyUserData({ legacy, target });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'already-migrated');
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite'), 'utf8'), 'newer');
});

test('旧目录不存在、或目标与旧目录相同时什么都不做', () => {
  const { legacy, target } = sandbox();
  assert.equal(migrateLegacyUserData({ legacy, target }).reason, 'no-legacy');
  seedLegacy(legacy);
  assert.equal(migrateLegacyUserData({ legacy, target: legacy }).reason, 'same-directory');
  assert.equal(fs.existsSync(target), false);
});

test('目标目录里已有其它文件时合并复制，不覆盖已有文件', () => {
  const { legacy, target } = sandbox();
  seedLegacy(legacy);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'pi-studio.sqlite-wal'), 'keep');
  const result = migrateLegacyUserData({ legacy, target });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite-wal'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(target, 'pi-studio.sqlite'), 'utf8'), 'db');
});
