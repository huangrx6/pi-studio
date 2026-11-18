/**
 * 用户数据：把 Studio 业务数据从旧位置搬到 `~/.pi-studio`。
 *
 * 早期版本整个 `userData` 都在 `~/Library/Application Support/pi-studio`。
 * 现在 Electron 仍用系统默认的 userData（缓存、Cookies、单实例锁），
 * 只有 Studio 自己的条目搬到 `~/.pi-studio`，用户打开那个目录只会看到
 * 数据库、技能、扩展这些他关心的东西。
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER_FILE = 'user-data-migration.json';
const DATABASE_FILE = 'pi-studio.sqlite';

/** 需要搬到 `~/.pi-studio` 的条目：SQLite、用户资源与 Studio 自管的运行数据。 */
const STUDIO_DATA_ENTRIES = [
  'AGENTS.md',
  'attachments',
  'background-media',
  'extension-cache',
  'extension-data',
  'extension-publishers.json',
  'extension-state',
  'extensions',
  'model-catalogs',
  'pi-studio.sqlite',
  'pi-studio.sqlite-shm',
  'pi-studio.sqlite-wal',
  'skill-quarantine',
  'skills',
];

/**
 * Chromium 自己的条目。旧版本曾整体搬进 `~/.pi-studio`，现在它们该回到
 * Electron 的 userData；这些名字只用于清理历史残留，不会碰其它文件。
 */
const CHROMIUM_ENTRIES = [
  'Cache',
  'Code Cache',
  'Cookies',
  'Cookies-journal',
  'DIPS',
  'DIPS-wal',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DevToolsActivePort',
  'GPUCache',
  'GPUPersistentCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'IndexedDB',
  'Local State',
  'Local Storage',
  'Network Persistent State',
  'Partitions',
  'Preferences',
  'Session Storage',
  'ShaderCache',
  'Shared Dictionary',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'blob_storage',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal',
  'shared_proto_db',
];

function hasDatabase(directory) {
  try {
    return fs.statSync(path.join(directory, DATABASE_FILE)).isFile();
  } catch {
    return false;
  }
}

function copyEntry(from, to, entry) {
  const source = path.join(from, entry);
  const target = path.join(to, entry);
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  return true;
}

/**
 * 把旧 `userData` 里的 Studio 条目复制到新目录。
 *
 * 幂等：目标已有数据库就直接返回；已存在的同名条目不会被覆盖；旧目录保持原样。
 */
function migrateStudioData({ legacy, target, now = () => new Date() } = {}) {
  if (typeof legacy !== 'string' || typeof target !== 'string') return { migrated: false, reason: 'invalid' };
  const from = path.resolve(legacy);
  const to = path.resolve(target);
  if (from === to) return { migrated: false, reason: 'same-directory' };
  if (!fs.existsSync(from)) return { migrated: false, reason: 'no-legacy' };
  if (hasDatabase(to)) return { migrated: false, reason: 'already-migrated' };

  fs.mkdirSync(to, { recursive: true });
  const copied = STUDIO_DATA_ENTRIES.filter((entry) => copyEntry(from, to, entry));

  const result = {
    migrated: hasDatabase(to),
    reason: hasDatabase(to) ? 'copied' : 'no-database',
    from,
    copied,
    at: now().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(to, MARKER_FILE), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // 标记写不进去不影响启动。
  }
  return result;
}

/**
 * 删掉早期版本误搬进 `~/.pi-studio` 的 Chromium 文件。
 * 只在迁移标记存在（说明这个目录是旧版本建过的）时执行，避免动到别的东西。
 */
function cleanLegacyChromiumData({ target } = {}) {
  if (typeof target !== 'string') return [];
  const root = path.resolve(target);
  if (!fs.existsSync(path.join(root, MARKER_FILE))) return [];
  const removed = [];
  for (const entry of CHROMIUM_ENTRIES) {
    const candidate = path.join(root, entry);
    if (!fs.existsSync(candidate)) continue;
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // 正在使用的文件删不掉就留着，下次启动再试。
    }
  }
  return removed;
}

module.exports = {
  CHROMIUM_ENTRIES,
  MARKER_FILE,
  STUDIO_DATA_ENTRIES,
  cleanLegacyChromiumData,
  hasDatabase,
  migrateStudioData,
};
