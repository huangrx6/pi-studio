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

/** Studio 业务数据根目录。 */
function studioDataDirectory() {
  if (process.env.PI_STUDIO_USER_DATA) {
    return path.resolve(process.env.PI_STUDIO_USER_DATA);
  }
  return path.join(os.homedir(), STUDIO_DATA_DIRECTORY);
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
  STUDIO_DATA_DIRECTORY,
  globalInstructionFile,
  globalInstructionStatus,
  studioDataDirectory,
};
