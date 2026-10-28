/**
 * 权限模式（pi-mode-switcher 扩展）的读取、持久化与运行时切换。
 *
 * 这个扩展不控制「哪些工具可用」，而是在 tool_call 阶段按模式决定是否弹窗确认：
 *   ask   请求批准 —— 写文件 / 风险命令都先问
 *   smart 帮我批准 —— 只对高风险操作询问
 *   full  完全权限 —— 不再询问
 *
 * 桌面端只负责两件事：
 *  1. 读写扩展自己的配置文件，让新会话拿到正确模式；
 *  2. 对已绑定的会话发送 `/mode <mode>` 命令，立即更新扩展内存里的状态。
 *
 * 如果用户还没选过模式（扩展未安装），available 为 false，界面不显示入口。
 */

const fs = require('node:fs');
const path = require('node:path');
const { agentDir, readJson, settingsFile } = require('../core/state.cjs');

/** 扩展支持的三种模式。 */
const MODES = ['ask', 'smart', 'full'];
/** 与扩展 loadPersistedMode 的默认值保持一致。 */
const DEFAULT_MODE = 'smart';

/** 扩展自身的配置文件。 */
function modeDir() {
  return path.join(agentDir(), 'extensions-data', 'pi-mode-switcher');
}

function modeFile() {
  return path.join(modeDir(), 'config.json');
}

/** 读取持久化模式；配置缺失或损坏时回落到 smart。 */
function readMode() {
  const value = readJson(modeFile(), {});
  return MODES.includes(value?.mode) ? value.mode : DEFAULT_MODE;
}

/** 写入模式；扩展下次加载时会读取它。 */
function writeMode(mode) {
  if (!MODES.includes(mode)) throw new Error('无效的权限模式');
  fs.mkdirSync(modeDir(), { recursive: true });
  fs.writeFileSync(modeFile(), `${JSON.stringify({ mode }, null, 2)}\n`, 'utf8');
  return mode;
}

/**
 * 把 `settings.json` 里的包来源解析成本机安装目录。
 *  - git:github.com/owner/repo → ~/.pi/agent/git/github.com/owner/repo
 *  - npm:package-name          → ~/.pi/agent/npm/node_modules/package-name
 */
function packageDir(source) {
  if (typeof source !== 'string') return undefined;
  if (source.startsWith('git:')) {
    const url = source.slice(4).replace(/\.git$/, '').replace(/^https?:\/\//, '');
    return path.join(agentDir(), 'git', url);
  }
  if (source.startsWith('npm:')) {
    return path.join(agentDir(), 'npm', 'node_modules', source.slice(4));
  }
  return undefined;
}

/** 判断 pi-mode-switcher 是否可用：用户级目录、配置目录或已安装的包里有它。 */
function modeAvailable() {
  if (fs.existsSync(modeDir())) return true;
  if (fs.existsSync(path.join(agentDir(), 'extensions', 'pi-mode-switcher'))) return true;
  const packages = readJson(settingsFile(), {}).packages;
  if (!Array.isArray(packages)) return false;
  return packages.some((source) => {
    const dir = packageDir(source);
    return Boolean(dir && fs.existsSync(path.join(dir, 'extensions', 'pi-mode-switcher')));
  });
}

/**
 * 还没有会话时切换的模式：等第一次 ensureAgent 建好会话后补发 `/mode`，
 * 否则扩展内存里仍是它加载时的旧模式。
 */
let pendingMode = null;

function rememberPendingMode(mode) {
  pendingMode = mode;
}

function consumePendingMode() {
  const next = pendingMode;
  pendingMode = null;
  return next;
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  readMode,
  writeMode,
  modeAvailable,
  rememberPendingMode,
  consumePendingMode,
};
