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

/** 搜索裸文件名时跳过的目录：依赖与版本库比产物多得多。 */
const SEARCH_SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo',
]);

function isRegularFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 只有文件名、没有目录的引用（模型常说“文件：报告.docx”）。
 * 依次在会话目录、家目录的 Downloads / Desktop / Documents，以及会话目录的
 * 一级子目录里找同名文件；找不到返回 null。
 */
function findByName(name, { cwd } = {}) {
  const roots = [];
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) roots.push(cwd);
  roots.push(
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
  );
  for (const root of roots) {
    const candidate = path.join(root, name);
    if (isRegularFile(candidate)) return candidate;
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SEARCH_SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const candidate = path.join(cwd, entry.name, name);
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 解析一条用户可见的文件引用。
 * 相对路径以当前会话工作目录为基准，工作目录缺失时退回主目录。
 */
function resolveUserTarget(input, { cwd } = {}) {
  const expanded = expandUserPath(input);
  const base = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : os.homedir();
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
  // 先按请求路径判定保护范围：受保护的位置即使文件不存在也报同一句，
  // 不泄露这些路径是否存在。realpath 之后再校验一次，防止符号链接换向。
  assertNotProtected(absolute);
  let target;
  try {
    target = fs.realpathSync(absolute);
  } catch {
    // 只有文件名（没有目录）时再按名字找一轮：模型经常只写产物名。
    const bare = !expanded.includes('/') && !expanded.includes('\\');
    const found = bare ? findByName(expanded, { cwd }) : null;
    if (!found) throw new Error('文件不存在或无法访问');
    target = fs.realpathSync(found);
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
  SEARCH_SKIPPED_DIRECTORIES,
  assertNotProtected,
  expandUserPath,
  findByName,
  resolveUserTarget,
};
