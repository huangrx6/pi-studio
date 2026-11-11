/**
 * 把聊天输出里出现的各种合法路径写法收敛成一个可读的绝对路径。
 *
 * 模型可能给出 `/Users/x/a.xlsx`、`~/Downloads/a.xlsx`、`./out/a.xlsx`、
 * `out/a.xlsx` 甚至 `file:///...`；渲染层不该自己猜，也不能把聊天里的任意
 * 字符串当成可信路径。统一在这里展开、归一化，并在 realpath 之后做一次
 * 保护性检查，越权与凭据类文件一律拒绝。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 相对主目录的敏感目录：即使文件存在也不允许预览。 */
const PROTECTED_HOME_DIRECTORIES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gh',
  '.config/gcloud',
  'Library/Keychains',
  'Library/Application Support/pi-studio',
  'Library/Application Support/pi',
];

/** 系统目录：只读系统文件没有预览价值，直接拒绝。 */
const PROTECTED_SYSTEM_DIRECTORIES = ['/etc', '/private/etc', '/System', '/Library/Keychains'];

/** 文件名命中即拒绝：凭据与密钥。 */
const PROTECTED_FILE_NAMES = new Set([
  '.netrc',
  '.pgpass',
  'auth.json',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ed25519',
  'id_rsa',
  'models.json',
]);

/** 展开 `~`、`file://` 前缀并去掉首尾空白。 */
function expandUserPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('缺少文件路径');
  if (raw.includes('\0')) throw new Error('文件路径包含非法字符');
  let value = raw;
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/\//i, ''));
    } catch {
      throw new Error('文件路径无法解码');
    }
  }
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function assertNotProtected(target) {
  for (const directory of PROTECTED_SYSTEM_DIRECTORIES) {
    if (target === directory || target.startsWith(`${directory}/`)) {
      throw new Error('这个位置的文件不在预览范围内');
    }
  }
  const relative = path.relative(os.homedir(), target).split(path.sep).join('/');
  if (!relative.startsWith('..')) {
    for (const directory of PROTECTED_HOME_DIRECTORIES) {
      if (relative === directory || relative.startsWith(`${directory}/`)) {
        throw new Error('这个位置的文件不在预览范围内');
      }
    }
  }
  if (PROTECTED_FILE_NAMES.has(path.basename(target))) {
    throw new Error('这个文件可能包含凭据，不能在预览中打开');
  }
}

/**
 * 解析一条用户可见的文件引用。
 * 相对路径以当前会话工作目录为基准，工作目录缺失时退回主目录。
 */
function resolveUserTarget(input, { cwd } = {}) {
  const expanded = expandUserPath(input);
  const base = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : os.homedir();
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
  let target;
  try {
    target = fs.realpathSync(absolute);
  } catch {
    throw new Error('文件不存在或无法访问');
  }
  assertNotProtected(target);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error('文件不存在或无法访问');
  }
  if (!stat.isFile()) throw new Error('不是文件');
  return target;
}

module.exports = {
  PROTECTED_FILE_NAMES,
  PROTECTED_HOME_DIRECTORIES,
  assertNotProtected,
  expandUserPath,
  resolveUserTarget,
};
