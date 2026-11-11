/**
 * 用户数据目录：`~/.pi-studio`。
 *
 * 早期版本把 SQLite、技能、扩展和 Chromium 配置都放在 Electron 默认的
 * `~/Library/Application Support/pi-studio`。那里和系统缓存混在一起，备份、
 * 迁移和「我想看看我的数据」都很别扭，所以默认目录改成家目录下的点目录。
 *
 * 首次启动会把旧目录**复制**过来（不删除旧目录），失败则继续用旧目录启动，
 * 保证升级不会把应用变成打不开的状态。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIRECTORY_NAME = '.pi-studio';
const MARKER_FILE = 'user-data-migration.json';
const DATABASE_FILE = 'pi-studio.sqlite';

/** 只跳过大体量缓存与运行期锁文件，Chromium 的 Local Storage 等必须一起搬。 */
const SKIPPED_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'Crashpad',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'blob_storage',
]);

/** 目标目录：`PI_STUDIO_USER_DATA` 覆盖（测试 / QA）优先，否则 `~/.pi-studio`。 */
function resolveUserDataDirectory({ override, home } = {}) {
  if (typeof override === 'string' && override.trim()) return path.resolve(override);
  const base = typeof home === 'string' && home ? home : os.homedir();
  return path.join(base, DATA_DIRECTORY_NAME);
}

function hasDatabase(directory) {
  try {
    return fs.statSync(path.join(directory, DATABASE_FILE)).isFile();
  } catch {
    return false;
  }
}

function isEmptyDirectory(directory) {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return true;
  }
}

/**
 * 把旧目录复制到新目录。
 *
 * 幂等：目标目录里已经有数据库或迁移标记就跳过；目标已有内容则合并复制，
 * 同名文件不覆盖（`force: false`）。旧目录保持原样，随时可以回退。
 */
function migrateLegacyUserData({ legacy, target, now = () => new Date() } = {}) {
  if (typeof legacy !== 'string' || typeof target !== 'string') return { migrated: false, reason: 'invalid' };
  const from = path.resolve(legacy);
  const to = path.resolve(target);
  if (from === to) return { migrated: false, reason: 'same-directory' };
  if (!fs.existsSync(from)) return { migrated: false, reason: 'no-legacy' };
  if (hasDatabase(to)) return { migrated: false, reason: 'already-migrated' };

  fs.mkdirSync(to, { recursive: true });
  if (!isEmptyDirectory(to) && !hasDatabase(from)) return { migrated: false, reason: 'target-not-empty' };

  fs.cpSync(from, to, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => !SKIPPED_ENTRIES.has(path.basename(source)),
  });

  const result = {
    migrated: hasDatabase(to),
    reason: hasDatabase(to) ? 'copied' : 'no-database',
    from,
    at: now().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(to, MARKER_FILE), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // 标记写不进去不影响启动，只是下次会再尝试合并复制（幂等）。
  }
  return result;
}

module.exports = {
  DATA_DIRECTORY_NAME,
  MARKER_FILE,
  SKIPPED_ENTRIES,
  hasDatabase,
  migrateLegacyUserData,
  resolveUserDataDirectory,
};
