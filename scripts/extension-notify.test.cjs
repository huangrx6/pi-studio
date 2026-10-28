const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('desktop mode changes are silent while warnings, errors and unrelated notifications survive', () => {
  const file = path.join(__dirname, '../electron/services/extensions.cjs');
  const localRequire = createRequire(file), sent = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    require(name) {
      if (name === 'electron') return { dialog: {} };
      if (name === '../core/state.cjs') return { getWindow: () => ({ webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }) };
      return localRequire(name);
    },
  });
  const ui = module.exports.createExtensionUI('test');
  for (const mode of ['请求批准', '帮我批准', '完全权限', '完全访问权限']) ui.notify(`权限模式 · ${mode}`);
  assert.equal(sent.length, 0);
  ui.notify('权限模式 · 帮我批准', 'error');
  ui.notify('权限模式未应用', 'warning');
  ui.notify('Footer · 配置已重载');
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map(event => event.payload.type), ['error', 'warning', 'info']);
  assert.ok(sent.every(event => event.payload.sessionId === 'test'));
});
