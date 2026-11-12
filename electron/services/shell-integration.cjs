/**
 * 终端 shell integration：让 zsh 用 OSC 133 标出「命令开始 / 命令结束 / 退出码」。
 *
 * 终端本身只看到字节流，分不清哪一行是命令、哪一段是输出。有了这些标记，
 * 渲染层才能做失败高亮、命令间跳转、复制单条命令输出。
 *
 * 不碰用户的 ~/.zshrc：把三个启动文件写进 Studio 自己的目录，用 ZDOTDIR 指向它，
 * 里面的每一层再 source 用户原来的同名文件。用户改自己的配置照常生效，卸载时
 * 关掉开关即可，不会留下任何痕迹在用户目录里。
 */

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_SHELLS = new Set(['zsh']);

/** hook 本体：用 add-zsh-hook 叠加，不覆盖用户自己的 preexec/precmd。 */
const INTEGRATION_SCRIPT = `# Pi Studio 终端集成（由 Pi Studio 生成，请勿手动修改）
# 通过 add-zsh-hook 叠加钩子，和 p10k、starship 这类 prompt 框架共存。
if [[ -o interactive ]]; then
  autoload -Uz add-zsh-hook 2>/dev/null

  _pi_studio_preexec() {
    printf '\\033]133;C\\007'
  }

  _pi_studio_precmd() {
    local exit_code=$?
    printf '\\033]133;D;%s\\007' "$exit_code"
    printf '\\033]133;A\\007'
  }

  add-zsh-hook preexec _pi_studio_preexec 2>/dev/null
  add-zsh-hook precmd _pi_studio_precmd 2>/dev/null
fi
`;

const ZSHENV = `# Pi Studio 生成：先加载用户自己的 .zshenv，保持原有环境变量语义
if [[ -n "\${PI_STUDIO_USER_ZDOTDIR:-}" && -f "\${PI_STUDIO_USER_ZDOTDIR}/.zshenv" ]]; then
  source "\${PI_STUDIO_USER_ZDOTDIR}/.zshenv"
elif [[ -f "$HOME/.zshenv" ]]; then
  source "$HOME/.zshenv"
fi
`;

const ZPROFILE = `# Pi Studio 生成：先加载用户自己的 .zprofile（brew shellenv 等）
if [[ -n "\${PI_STUDIO_USER_ZDOTDIR:-}" && -f "\${PI_STUDIO_USER_ZDOTDIR}/.zprofile" ]]; then
  source "\${PI_STUDIO_USER_ZDOTDIR}/.zprofile"
elif [[ -f "$HOME/.zprofile" ]]; then
  source "$HOME/.zprofile"
fi
`;

// hook 前后各挂一次：用户配置可能重置 precmd 链，add-zsh-hook 对同一函数是幂等的。
const ZSHRC = `# Pi Studio 生成：挂上集成钩子，再加载用户自己的 .zshrc
if [[ -f "\${PI_STUDIO_SHELL_INTEGRATION:-}" ]]; then
  source "\${PI_STUDIO_SHELL_INTEGRATION}"
fi
if [[ -n "\${PI_STUDIO_USER_ZDOTDIR:-}" && -f "\${PI_STUDIO_USER_ZDOTDIR}/.zshrc" ]]; then
  source "\${PI_STUDIO_USER_ZDOTDIR}/.zshrc"
elif [[ -f "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi
if [[ -f "\${PI_STUDIO_SHELL_INTEGRATION:-}" ]]; then
  source "\${PI_STUDIO_SHELL_INTEGRATION}"
fi
`;

/**
 * 写出（或更新）hook 文件，返回可合并进 PTY 环境变量的补丁。
 *
 * @param {{ dataDirectory: string, shell: string, environment?: NodeJS.ProcessEnv }} options
 * @returns {Record<string, string>} 需要并入子进程环境变量的键值；不支持时为空对象
 */
function shellIntegrationEnvironment({ dataDirectory, shell, environment = process.env }) {
  const executable = path.basename(shell || '').replace(/\.exe$/i, '').toLowerCase();
  if (!SUPPORTED_SHELLS.has(executable)) return {};

  const root = path.join(dataDirectory, 'shell', 'zsh');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'integration.zsh'), INTEGRATION_SCRIPT);
    fs.writeFileSync(path.join(root, '.zshenv'), ZSHENV);
    fs.writeFileSync(path.join(root, '.zprofile'), ZPROFILE);
    fs.writeFileSync(path.join(root, '.zshrc'), ZSHRC);
  } catch {
    // 写不进去就退回普通 shell，不让终端整体不可用。
    return {};
  }

  return {
    ZDOTDIR: root,
    PI_STUDIO_SHELL_INTEGRATION: path.join(root, 'integration.zsh'),
    PI_STUDIO_USER_ZDOTDIR: environment.ZDOTDIR || '',
  };
}

module.exports = {
  SUPPORTED_SHELLS,
  shellIntegrationEnvironment,
};
