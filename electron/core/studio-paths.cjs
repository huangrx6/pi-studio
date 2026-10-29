/**
 * Studio-owned application paths shared by settings and runtime services.
 *
 * PI_STUDIO_USER_DATA keeps Node tests independent from Electron. Production
 * reads Electron's userData directory lazily so requiring this module is safe
 * before the app is ready.
 */

const fs = require('node:fs');
const path = require('node:path');

function userDataDirectory() {
  if (process.env.PI_STUDIO_USER_DATA) {
    return path.resolve(process.env.PI_STUDIO_USER_DATA);
  }
  const { app } = require('electron');
  return app.getPath('userData');
}

function globalInstructionFile() {
  return path.join(userDataDirectory(), 'AGENTS.md');
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
  globalInstructionFile,
  globalInstructionStatus,
  userDataDirectory,
};
