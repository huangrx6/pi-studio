/**
 * 凭据环境变量。
 *
 * 用户可以把 API Key 写成 `$NAME` 引用环境变量。GUI 应用从 Finder / Dock 启动时
 * 拿不到 shell 里 export 的变量，所以这里在 macOS 上会启动一次 login shell，
 * 只把需要的凭据变量导入当前进程（不导入 PATH、Electron 标志等其它变量）。
 *
 * 另外负责把旧格式（裸变量名）统一成 `$NAME`。
 */

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

/** 从 `$NAME` / `${NAME}` / 旧式裸变量名里取出变量名。 */
function envNameOf(value, env = process.env) {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  const explicit = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(key);
  if (explicit) return explicit[1] || explicit[2];
  // Compatibility with older Pi configurations that used bare variable names.
  if (/^[A-Z_][A-Z0-9_]*$/.test(key) && (Object.hasOwn(env, key) || /_(?:API_KEY|KEY|TOKEN|SECRET)$/.test(key))) return key;
  return undefined;
}

/** 把密钥值规范成 `$NAME` 或原样返回。 */
function normalizeKey(value, env = process.env) {
  const key = value.trim();
  const name = envNameOf(key, env);
  return name ? `$${name}` : key;
}

// 用 NUL 分隔的标记，避免和 shell 启动脚本的输出混在一起
const MARKER = '\0PI_STUDIO_CREDENTIAL_ENV\0';

/** 从 login shell 的 `env -0` 输出里只解析出 KEY=VALUE。 */
function parseShellEnvironment(stdout) {
  const start = stdout.indexOf(MARKER);
  const result = Object.create(null);
  if (start < 0) return result;
  for (const entry of stdout.slice(start + MARKER.length).split('\0')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(entry);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

/** 启动 login shell 读取环境变量（失败返回空对象）。 */
function readShellEnvironment() {
  const configured = process.env.SHELL || '/bin/zsh';
  const shell = ['zsh', 'bash'].includes(path.basename(configured)) ? configured : '/bin/zsh';
  return new Promise((resolve) => {
    // Login + interactive loads .zprofile and .zshrc, including exported keys.
    // No credential or user input is interpolated into the command.
    execFile(shell, ['-ilc', "printf '\\0PI_STUDIO_CREDENTIAL_ENV\\0'; /usr/bin/env -0"], {
      cwd: os.homedir(), timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => resolve(error ? {} : parseShellEnvironment(stdout)));
  });
}

/**
 * 把缺失的凭据变量从 shell 环境补齐。
 * @returns 仍然缺失的变量名列表
 */
async function loadCredentialEnvironment(values, { env = process.env, platform = process.platform, readShell = readShellEnvironment } = {}) {
  const names = [...new Set(values.map(value => envNameOf(value, env)).filter(Boolean))];
  const missing = names.filter(name => !env[name]);
  if (missing.length && platform === 'darwin') {
    let exported;
    try { exported = await readShell(); } catch { exported = {}; }
    // Import only requested credential variables, never PATH or Electron flags.
    for (const name of missing) if (exported[name]) env[name] = exported[name];
  }
  return names.filter(name => !env[name]);
}

/**
 * 保存 API Key 之前调用：规范化格式，并确认环境变量确实可用。
 */
async function prepareKey(value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入 API Key 或环境变量引用');
  const key = normalizeKey(value, options.env);
  if (key.startsWith('$') && !envNameOf(key, options.env)) throw new Error('环境变量格式应为 $NAME 或 ${NAME}');
  const missing = await loadCredentialEnvironment([key], options);
  if (missing.length) throw new Error(`无法读取环境变量 ${missing[0]}。请在 .zshrc 中使用 export 设置后重试，或直接填写密钥值。`);
  return key;
}

/** 批量规范化 auth.json 里所有 api_key 的写法。 */
function normalizeAuth(auth, env = process.env) {
  return Object.fromEntries(Object.entries(auth).map(([id, credential]) => [id,
    credential?.type === 'api_key' && typeof credential.key === 'string'
      ? { ...credential, key: normalizeKey(credential.key, env) }
      : credential,
  ]));
}

module.exports = { envNameOf, normalizeKey, normalizeAuth, parseShellEnvironment, loadCredentialEnvironment, prepareKey };
