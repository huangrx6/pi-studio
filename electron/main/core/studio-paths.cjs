/**
 * Studio 自有的数据目录与路径。
 *
 * 业务数据（SQLite、技能、扩展、背景、附件）放在 `~/.pi-studio`，与 Chromium
 * 自己的缓存、Cookies、单实例锁分开：Electron 的 `userData` 仍留在系统默认的
 * `~/Library/Application Support/pi-studio`，用户打开 `~/.pi-studio` 只会看到
 * 自己关心的内容。
 *
 * `PI_STUDIO_USER_DATA` 覆盖时两者合一，测试与 QA 才能用一次性目录跑完整应用。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_DATA_DIRECTORY = '.pi-studio';
const PLUGIN_INSTALL_DIRECTORY = 'plugins';
const PLUGIN_DATA_DIRECTORY = 'plugin-data';

/** Studio 业务数据根目录。 */
function studioDataDirectory() {
  if (process.env.PI_STUDIO_USER_DATA) {
    return path.resolve(process.env.PI_STUDIO_USER_DATA);
  }
  return path.join(os.homedir(), STUDIO_DATA_DIRECTORY);
}

function pluginDataDirectory(pluginId, extensionId, { root = studioDataDirectory(), create = false } = {}) {
  if (typeof pluginId !== 'string' || typeof extensionId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(pluginId)
    || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(extensionId)) {
    throw new Error('插件或扩展 ID 无效');
  }
  return managedDataSubdirectory(root, [PLUGIN_DATA_DIRECTORY, pluginId, extensionId], { create });
}

// Inside the Studio profile, a replaced directory must not redirect cleanup or
// writes into another plugin, a project, or a different user data location.
function managedDataSubdirectory(root, parts, { create = false } = {}) {
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const part of parts) {
    if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[/\\:]/.test(part)) {
      throw new Error('Studio 数据目录名称无效');
    }
    current = path.join(current, part);
    if (create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && !create) return undefined;
    if (!stat?.isDirectory()) throw new Error('Studio 数据目录需要是普通目录');
  }
  return fs.realpathSync(current);
}

function globalInstructionFile() {
  return path.join(studioDataDirectory(), 'AGENTS.md');
}

function globalInstructionStatus() {
  try {
    return fs.statSync(globalInstructionFile()).isFile() ? 'present' : 'missing';
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      ? 'missing'
      : 'unreadable';
  }
}

module.exports = {
  PLUGIN_DATA_DIRECTORY,
  PLUGIN_INSTALL_DIRECTORY,
  STUDIO_DATA_DIRECTORY,
  globalInstructionFile,
  globalInstructionStatus,
  managedDataSubdirectory,
  pluginDataDirectory,
  studioDataDirectory,
};
