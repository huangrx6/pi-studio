const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shellIntegrationEnvironment, SUPPORTED_SHELLS } = require('../../electron/services/shell-integration.cjs');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-shell-'));
}

test('zsh 会写出 ZDOTDIR 启动文件并返回环境补丁', () => {
  const dataDirectory = sandbox();
  try {
    const env = shellIntegrationEnvironment({ dataDirectory, shell: '/bin/zsh', environment: {} });
    assert.deepEqual(SUPPORTED_SHELLS.has('zsh'), true);
    assert.equal(env.ZDOTDIR, path.join(dataDirectory, 'shell', 'zsh'));
    assert.equal(env.PI_STUDIO_SHELL_INTEGRATION, path.join(env.ZDOTDIR, 'integration.zsh'));
    assert.equal(env.PI_STUDIO_USER_ZDOTDIR, '');
    for (const file of ['.zshenv', '.zprofile', '.zshrc', 'integration.zsh']) {
      assert.ok(fs.existsSync(path.join(env.ZDOTDIR, file)), `${file} 应该已写出`);
    }
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('启动文件回源用户配置，钩子用 add-zsh-hook 叠加', () => {
  const dataDirectory = sandbox();
  try {
    const env = shellIntegrationEnvironment({ dataDirectory, shell: 'zsh', environment: { ZDOTDIR: '/Users/me/.config/zsh' } });
    assert.equal(env.PI_STUDIO_USER_ZDOTDIR, '/Users/me/.config/zsh');
    const zshrc = fs.readFileSync(path.join(env.ZDOTDIR, '.zshrc'), 'utf8');
    assert.match(zshrc, /PI_STUDIO_SHELL_INTEGRATION/);
    assert.match(zshrc, /PI_STUDIO_USER_ZDOTDIR/);
    // 钩子必须在用户 .zshrc 之后还能重新挂一次（用户配置可能重置 precmd 链）
    const hooks = zshrc.split('\n').filter((line) => line.includes('PI_STUDIO_SHELL_INTEGRATION') && line.trim().startsWith('source'));
    assert.equal(hooks.length, 2);
    const integration = fs.readFileSync(path.join(env.ZDOTDIR, 'integration.zsh'), 'utf8');
    assert.match(integration, /add-zsh-hook preexec/);
    assert.match(integration, /add-zsh-hook precmd/);
    assert.match(integration, /\\033\]133;D;%s\\007/);
    assert.doesNotMatch(integration, /^\s*exec\s/mu, '不能接管用户的 shell');
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('非 zsh 与写盘失败都不影响终端启动', () => {
  const dataDirectory = sandbox();
  try {
    assert.deepEqual(shellIntegrationEnvironment({ dataDirectory, shell: '/bin/bash', environment: {} }), {});
    assert.deepEqual(shellIntegrationEnvironment({ dataDirectory, shell: '/usr/local/bin/fish', environment: {} }), {});
    // 把数据目录做成一个文件，mkdtemp 里的子路径无法创建
    const blocked = path.join(dataDirectory, 'blocked');
    fs.writeFileSync(blocked, '');
    assert.deepEqual(shellIntegrationEnvironment({ dataDirectory: blocked, shell: 'zsh', environment: {} }), {});
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
