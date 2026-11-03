'use strict';

/**
 * 主进程 Durable 服务层的加载冒烟测试。
 *
 * `electron-imports.test.cjs` 会跳过依赖 `electron` 的模块，因此这里用最小
 * 的 electron 桩把真正的服务模块加载一遍，覆盖：
 *   - 顶层 require 目标是否存在（新增/改名模块时会先炸）
 *   - 1.5.0 迁移后的模块级初始化是否还会访问已删除的 API
 *
 * 只做加载，不启动 Electron、不读写用户数据。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

function withElectronStub(load) {
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request !== 'electron') return original.call(this, request, parent, isMain);
    return {
      app: {
        getPath: () => path.join(require('node:os').tmpdir(), 'pi-studio-load-test'),
        getName: () => 'Pi Studio',
        isPackaged: false,
        on() {},
      },
      safeStorage: { isEncryptionAvailable: () => false },
      ipcMain: { handle() {}, on() {}, removeHandler() {} },
      BrowserWindow: class {},
      shell: {},
      Menu: { setApplicationMenu() {} },
      nativeTheme: { on() {}, shouldUseDarkColors: false },
      powerMonitor: { on() {} },
    };
  };
  try {
    return load();
  } finally {
    Module._load = original;
  }
}

test('Durable 会话服务能在 Electron 桩下完整加载', () => {
  withElectronStub(() => {
    const service = require('../../electron/runtime/conversations.cjs');
    assert.equal(typeof service.conversationSnapshot, 'function');
    assert.equal(typeof service.conversationPage, 'function');
    assert.equal(typeof service.taskGraph, 'function');
    assert.equal(typeof service.submitConversation, 'function');
  });
});

test('临时聊天与运行时服务能在 Electron 桩下完整加载', () => {
  withElectronStub(() => {
    const temporary = require('../../electron/services/temporary-chat.cjs');
    assert.equal(typeof temporary.temporaryPrompt, 'function');
    const runtime = require('../../electron/runtime/durable-runtime.cjs');
    assert.equal(typeof runtime.getDurableRuntime, 'function');
  });
});

test('投影层与工具 schema 构造器是纯模块', () => {
  // 两个模块不得 import 任何 @earendil-works/*：它们是版本无关的适配层。
  const projection = require('../../electron/runtime/view.cjs');
  assert.equal(typeof projection.liveFromView, 'function');
  assert.equal(typeof projection.diffLive, 'function');
  assert.equal(typeof projection.appendedEntries, 'function');

  const schema = require('../../electron/runtime/tool-schema.cjs');
  for (const name of ['Object', 'String', 'Number', 'Boolean', 'Array', 'Union', 'Literal', 'Optional', 'Unsafe']) {
    assert.equal(typeof schema[name], 'function', `tool-schema 缺少 ${name}`);
  }
});
