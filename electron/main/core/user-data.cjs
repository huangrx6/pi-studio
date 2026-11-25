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
const {
  DOWNLOADS_DIRECTORY,
  PLUGIN_DATA_DIRECTORY,
  PLUGIN_INSTALL_DIRECTORY,
  STUDIO_CACHE_DIR,
  STUDIO_MANAGED_DATA_DIR,
} = require('./studio-paths.cjs');

const MARKER_FILE = 'user-data-migration.json';
const CHROMIUM_CLEANUP_VERSION = 2;
const DATABASE_FILE = 'pi-studio.sqlite';

/** 需要搬到 `~/.pi-studio` 的条目：SQLite、用户资源与 Studio 自管的运行数据。 */
const STUDIO_DATA_ENTRIES = [
  'AGENTS.md',
  'attachments',
  'background-media',
  'backups',
  'browser-downloads',
  STUDIO_CACHE_DIR,
  STUDIO_MANAGED_DATA_DIR,
  DOWNLOADS_DIRECTORY,
  'extension-cache',
  'extension-data',
  'extension-publishers.json',
  'extension-state',
  'extensions',
  'plugin-quarantine',
  PLUGIN_DATA_DIRECTORY,
  PLUGIN_INSTALL_DIRECTORY,
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
  '.updaterId',
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
  'TransportSecurity',
  'Trust Tokens',
  'Trust Tokens-journal',
  'VideoDecodeStats',
  'WebStorage',
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

function readDirectoryEntrySet(directory) {
  try {
    return new Set(fs.readdirSync(directory));
  } catch {
    return new Set();
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
  const legacyEntries = readDirectoryEntrySet(from);
  const targetEntries = readDirectoryEntrySet(to);
  const copied = STUDIO_DATA_ENTRIES.filter((entry) => (
    legacyEntries.has(entry) && !targetEntries.has(entry) && copyEntry(from, to, entry)
  ));

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

function resolveMarkerPath(root) {
  const v2 = path.join(root, STUDIO_MANAGED_DATA_DIR, MARKER_FILE);
  if (fs.existsSync(v2)) return v2;
  const legacy = path.join(root, MARKER_FILE);
  if (fs.existsSync(legacy)) return legacy;
  return undefined;
}

/**
 * 删掉早期版本误搬进 `~/.pi-studio` 的 Chromium 文件。
 * 只在迁移标记存在（说明这个目录是旧版本建过的）时执行，避免动到别的东西。
 */
function cleanLegacyChromiumData({ target } = {}) {
  if (typeof target !== 'string') return [];
  const root = path.resolve(target);
  const markerPath = resolveMarkerPath(root);
  if (!markerPath) return [];
  let marker = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) marker = parsed;
  } catch {
    // Unreadable marker still allows safe allowlisted cleanup.
  }
  if (Number(marker.chromiumCleanedVersion) >= CHROMIUM_CLEANUP_VERSION) return [];

  const existingEntries = readDirectoryEntrySet(root);
  const removed = [];
  let remaining = 0;
  for (const entry of CHROMIUM_ENTRIES) {
    if (!existingEntries.has(entry)) continue;
    const candidate = path.join(root, entry);
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      remaining += 1;
    }
  }
  if (remaining === 0) {
    try {
      fs.writeFileSync(
        markerPath,
        `${JSON.stringify({ ...marker, chromiumCleanedVersion: CHROMIUM_CLEANUP_VERSION }, null, 2)}\n`,
      );
    } catch {
      // Non-fatal; cleanup remains idempotent on next start.
    }
  }
  return removed;
}

function isEffectivelyEmptyDirectory(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.every(entry => entry.isFile() && entry.name === '.DS_Store');
}

function moveEntrySafely(source, destination) {
  const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat || sourceStat.isSymbolicLink()) return false;
  if (sourceStat.isDirectory() && isEffectivelyEmptyDirectory(source)) {
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const destStat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!destStat) {
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
      fs.rmSync(source, { recursive: true, force: true });
    }
    return true;
  }
  if (sourceStat.isDirectory() && destStat.isDirectory()) {
    let movedAny = false;
    for (const child of fs.readdirSync(source, { withFileTypes: true })) {
      if (child.isFile() && child.name === '.DS_Store') {
        try { fs.rmSync(path.join(source, child.name), { force: true }); } catch { /* ignore */ }
        continue;
      }
      if (moveEntrySafely(path.join(source, child.name), path.join(destination, child.name))) {
        movedAny = true;
      }
    }
    if (isEffectivelyEmptyDirectory(source)) {
      fs.rmSync(source, { recursive: true, force: true });
      return true;
    }
    return movedAny;
  }
  return false;
}

const LAYOUT_V2_MOVES = [
  [['attachments'], [STUDIO_MANAGED_DATA_DIR, 'attachments']],
  [['background-media'], [STUDIO_MANAGED_DATA_DIR, 'background-media']],
  [['worktrees'], [STUDIO_MANAGED_DATA_DIR, 'worktrees']],
  [[PLUGIN_DATA_DIRECTORY], [STUDIO_MANAGED_DATA_DIR, PLUGIN_DATA_DIRECTORY]],
  [['extension-data'], [STUDIO_MANAGED_DATA_DIR, 'extension-data']],
  [['extension-state'], [STUDIO_MANAGED_DATA_DIR, 'extension-state']],
  [['shell'], [STUDIO_MANAGED_DATA_DIR, 'shell']],
  [[MARKER_FILE], [STUDIO_MANAGED_DATA_DIR, MARKER_FILE]],
  [['browser-downloads'], [DOWNLOADS_DIRECTORY]],
  [['model-catalogs'], [STUDIO_CACHE_DIR, 'model-catalogs']],
  [['extension-cache', 'quarantine'], [STUDIO_CACHE_DIR, 'quarantine', 'extensions']],
  [['plugin-quarantine'], [STUDIO_CACHE_DIR, 'quarantine', 'plugins']],
  [['skill-quarantine'], [STUDIO_CACHE_DIR, 'quarantine', 'skills']],
];

/**
 * 将 v1 平铺在 `~/.pi-studio/` 根层的应用托管数据与缓存目录幂等收敛到 v2 结构：
 * - `data/`：应用托管数据（attachments、background-media、worktrees、plugin-data、extension-data、extension-state、shell）
 * - `cache/`：可安全清空的缓存与临时隔离区（model-catalogs、quarantine）
 * - `downloads/`：浏览器下载目录（非空时保留，空目录不占根层）
 */
function migrateStudioLayout({ target } = {}) {
  if (typeof target !== 'string') return { moved: [] };
  const root = path.resolve(target);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) return { moved: [] };

  const moved = [];
  for (const [fromParts, toParts] of LAYOUT_V2_MOVES) {
    const source = path.join(root, ...fromParts);
    const destination = path.join(root, ...toParts);
    if (!fs.existsSync(source)) continue;
    try {
      if (moveEntrySafely(source, destination)) {
        moved.push(`${fromParts.join('/')} -> ${toParts.join('/')}`);
      }
    } catch {
      // 并发占用时下次启动再续迁。
    }
  }

  // extension-cache/ 搬空 quarantine/ 后如果只剩空目录或 .DS_Store，一并清理。
  const legacyExtCache = path.join(root, 'extension-cache');
  const legacyExtCacheStat = fs.lstatSync(legacyExtCache, { throwIfNoEntry: false });
  if (legacyExtCacheStat?.isDirectory() && isEffectivelyEmptyDirectory(legacyExtCache)) {
    try {
      fs.rmSync(legacyExtCache, { recursive: true, force: true });
      moved.push('extension-cache -> (removed empty)');
    } catch {
      // ignore
    }
  }

  return { moved };
}

const PRUNABLE_SUBDIR_PARENTS = [
  [STUDIO_MANAGED_DATA_DIR, 'extension-state'],
  [STUDIO_MANAGED_DATA_DIR, 'extension-data'],
  ['extension-state'],
  ['extension-data'],
];
const PRUNABLE_EMPTY_TRANSIENT_DIRS = [
  [STUDIO_CACHE_DIR, 'quarantine', 'extensions'],
  [STUDIO_CACHE_DIR, 'quarantine', 'plugins'],
  [STUDIO_CACHE_DIR, 'quarantine', 'skills'],
  [STUDIO_CACHE_DIR, 'quarantine'],
  [STUDIO_CACHE_DIR],
  ['plugin-quarantine'],
  ['skill-quarantine'],
];

/**
 * 清理 Studio 数据目录下由历史版本或已移除工作区留下的空托管目录。
 * 只删除确认为空的普通目录，绝不跟随软链接，也绝不删除含任何文件的目录。
 */
function pruneEmptyManagedDirectories({ target } = {}) {
  if (typeof target !== 'string') return [];
  const root = path.resolve(target);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) return [];

  const removed = [];

  for (const parentParts of PRUNABLE_SUBDIR_PARENTS) {
    const parent = path.join(root, ...parentParts);
    const parentStat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!parentStat?.isDirectory()) continue;
    let children;
    try { children = fs.readdirSync(parent, { withFileTypes: true }); }
    catch { continue; }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      const candidate = path.join(parent, child.name);
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) continue;
      try {
        if (fs.readdirSync(candidate).length === 0) {
          fs.rmdirSync(candidate);
          removed.push(path.join(...parentParts, child.name));
        }
      } catch {
        // 并发写入或非空时跳过。
      }
    }
  }

  for (const dirParts of PRUNABLE_EMPTY_TRANSIENT_DIRS) {
    const candidate = path.join(root, ...dirParts);
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    try {
      if (fs.readdirSync(candidate).length === 0) {
        fs.rmdirSync(candidate);
        removed.push(path.join(...dirParts));
      }
    } catch {
      // 正在使用或非空时跳过。
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
  migrateStudioLayout,
  pruneEmptyManagedDirectories,
};
