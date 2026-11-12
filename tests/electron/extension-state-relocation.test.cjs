const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');

// studio-extensions 在模块加载时读 Electron 的 userData；这里只需要一个稳定目录。
const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-relocate-'));
process.env.PI_STUDIO_DB = path.join(userRoot, 'studio.sqlite');
installElectronSafeStorage({ after });
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => userRoot } };
  return originalLoad.call(this, request, parent, isMain);
};
const { ExtensionDistributionService } = require('../../electron/services/extension-distribution.cjs');
Module._load = originalLoad;

const ID = 'relocate.fixture';

/** 造一个受管安装：代码、数据与状态文件都写在给定根下。 */
function realpath(value) {
  return fs.realpathSync(value);
}

function seed(root, { withCode = true, withData = true } = {}) {
  const code = path.join(root, 'extensions', ID, '1.0.0');
  const data = path.join(root, 'extension-data', 'user', ID);
  const stateDirectory = path.join(root, 'extension-state', 'user');
  const stateFile = path.join(stateDirectory, `${ID}.json`);
  fs.mkdirSync(code, { recursive: true });
  fs.mkdirSync(stateDirectory, { recursive: true });
  if (withData) fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(code, 'pi-studio.extension.json'), JSON.stringify({
    format: 1, id: ID, version: '1.0.0', name: 'Relocate fixture',
  }));
  return { code, data, stateFile, stateDirectory };
}

function writeState(file, { dataPath, codePath }) {
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    id: ID,
    scope: 'user',
    dataPath,
    activeHistoryIndex: 0,
    history: [{ version: '1.0.0', codePath, sha256: '0'.repeat(64) }],
  }, null, 2));
}

test('旧数据根的绝对路径会自愈到当前受管目录并落盘', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-relocate-case-'));
  const legacy = path.join(root, 'legacy-root');
  const current = path.join(root, 'current-root');
  try {
    // 旧根里有完整安装；新根里代码与数据已复制，只是状态文件还指向旧根
    const oldLayout = seed(legacy);
    const newLayout = seed(current);
    writeState(newLayout.stateFile, { dataPath: oldLayout.data, codePath: oldLayout.code });

    const service = new ExtensionDistributionService({ userDataPath: realpath(current) });
    const installed = service.getInstalled(ID, 'user');
    assert.equal(realpath(installed.dataPath), realpath(newLayout.data));
    assert.equal(realpath(installed.activeCodePath), realpath(newLayout.code));

    // 修正写回磁盘，下次启动不用再算一遍
    const persisted = JSON.parse(fs.readFileSync(newLayout.stateFile, 'utf8'));
    assert.equal(realpath(persisted.dataPath), realpath(newLayout.data));
    assert.equal(realpath(persisted.history[0].codePath), realpath(newLayout.code));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('目标目录不存在时不猜路径，仍然报不受管', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-relocate-missing-'));
  const legacy = path.join(root, 'legacy-root');
  const current = path.join(root, 'current-root');
  try {
    const oldLayout = seed(legacy);
    // 新根只复制了状态，没有代码与数据目录
    const newLayout = seed(current, { withCode: false, withData: false });
    writeState(newLayout.stateFile, { dataPath: oldLayout.data, codePath: oldLayout.code });

    const service = new ExtensionDistributionService({ userDataPath: realpath(current) });
    assert.throws(
      () => service.getInstalled(ID, 'user'),
      /扩展数据目录不在受管位置/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
