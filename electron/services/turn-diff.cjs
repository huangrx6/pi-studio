/**
 * 每轮对话的 Git 变更快照。
 *
 * 只靠 write/edit 工具参数会漏掉 bash 生成的文件，所以这里在回合开始/结束时
 * 用临时 index 各拍一张工作树快照（`git add -A` 到临时 index + `write-tree`），
 * 再对比两棵树，得到本轮真实变更：
 *   - 包含 bash、脚本、cp、git 操作等任何方式改动的文件；
 *   - 包含新增与删除文件；
 *   - 不触碰用户真实的 index / HEAD。
 *
 * 非 Git 仓库直接返回 null，渲染层回退到工具参数统计。
 * 快照生成在回合开始前同步完成；结束统计异步执行，不阻塞流式输出。
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 100;
const MAX_PATCH_CHARS = 80_000;
const MAX_STORED_TURNS = 30;
const GIT_TIMEOUT = 20_000;
/** 开始快照会阻塞发送，限制得更短；超时就放弃本轮 Git 统计。 */
const SNAPSHOT_TIMEOUT = 5_000;

/** requestId → 回合开始时的快照。 */
const snapshots = new Map();

async function git(cwd, args, env, timeout = GIT_TIMEOUT) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...env },
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** 应用数据里的回合 diff 存储（按会话分组，保留最近若干轮）。 */
function storeFile() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'turn-diffs.json');
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

/** 读取某会话已持久化的回合 diff，供打开历史会话时展示。 */
function readTurnDiffs(sessionId) {
  const list = readStore()[sessionId];
  return Array.isArray(list) ? list : [];
}

/** 保存一轮 diff；同一时间戳重复保存时覆盖，避免重试产生重复项。 */
function saveTurnDiff(sessionId, diff) {
  const store = readStore();
  const list = (Array.isArray(store[sessionId]) ? store[sessionId] : []).filter((item) => item.at !== diff.at);
  list.push(diff);
  store[sessionId] = list.slice(-MAX_STORED_TURNS);
  writeStore(store);
}

/**
 * 开始一轮：记录工作树快照。
 * @returns 快照令牌；非 Git 仓库或失败时返回 null
 */
async function beginTurn(cwd, key = randomUUID()) {
  if (!cwd) return null;
  const requestId = key;
  let dir;
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'], undefined, SNAPSHOT_TIMEOUT)).trim();
    if (!root) return null;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-diff-'));
    const index = path.join(dir, 'index');
    const env = { GIT_INDEX_FILE: index };
    // 没有提交的仓库用空树作为基线。
    try {
      const head = (await git(cwd, ['rev-parse', 'HEAD'], undefined, SNAPSHOT_TIMEOUT)).trim();
      await git(cwd, ['read-tree', head || EMPTY_TREE], env, SNAPSHOT_TIMEOUT);
    } catch {
      await git(cwd, ['read-tree', EMPTY_TREE], env, SNAPSHOT_TIMEOUT);
    }
    await git(cwd, ['add', '-A', '--', '.'], env, SNAPSHOT_TIMEOUT);
    const tree = (await git(cwd, ['write-tree'], env, SNAPSHOT_TIMEOUT)).trim();
    snapshots.set(requestId, { cwd, root, dir, index, env, startTree: tree });
    return requestId;
  } catch {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/** 解析 `git diff --name-status` 输出为 path → 状态。 */
function parseStatus(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    map.set(file, code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified');
  }
  return map;
}

/**
 * 结束一轮：生成快照并计算差异。
 * @returns { files, totalAdded, totalRemoved } 或 null
 */
async function endTurn(requestId) {
  const snap = snapshots.get(requestId);
  if (!snap) return null;
  snapshots.delete(requestId);
  try {
    await git(snap.cwd, ['add', '-A', '--', '.'], snap.env);
    const endTree = (await git(snap.cwd, ['write-tree'], snap.env)).trim();
    if (endTree === snap.startTree) return { files: [], totalAdded: 0, totalRemoved: 0 };

    const numstat = await git(snap.cwd, ['diff', '--numstat', '--no-renames', snap.startTree, endTree]);
    const status = parseStatus(await git(snap.cwd, ['diff', '--name-status', '--no-renames', snap.startTree, endTree]));
    const files = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const line of numstat.split('\n')) {
      if (!line.trim()) continue;
      const [addedRaw, removedRaw, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (!file) continue;
      const binary = addedRaw === '-';
      const added = binary ? 0 : Number(addedRaw) || 0;
      const removed = binary ? 0 : Number(removedRaw) || 0;
      totalAdded += added;
      totalRemoved += removed;
      // 用 realpath 对齐 /var → /private/var 这类符号链接，避免展示路径变成 ../..。
      let absolute = path.resolve(snap.root, file);
      let label = path.relative(snap.cwd, absolute) || file;
      try {
        absolute = path.join(fs.realpathSync(snap.root), file);
        label = path.relative(fs.realpathSync(snap.cwd), absolute) || file;
      } catch { /* 路径不存在时保留原始值 */ }
      if (!label || label.startsWith('..') || path.isAbsolute(label)) label = file;
      let patch = '';
      if (!binary) {
        try {
          patch = await git(snap.cwd, ['diff', '--no-color', '--unified=3', snap.startTree, endTree, '--', file]);
        } catch { /* 单个文件 diff 失败不影响汇总 */ }
      }
      files.push({
        path: absolute,
        label,
        status: status.get(file) || 'modified',
        added,
        removed,
        binary,
        truncated: patch.length > MAX_PATCH_CHARS,
        patch: patch.slice(0, MAX_PATCH_CHARS),
        completeCounts: !binary,
      });
      if (files.length >= MAX_FILES) break;
    }
    return { files, totalAdded, totalRemoved, truncated: files.length >= MAX_FILES, snapshot: { root: fs.realpathSync(snap.root), before: snap.startTree, after: endTree } };
  } finally {
    fs.rmSync(snap.dir, { recursive: true, force: true });
  }
}

/** Re-read immutable trees, never compare historical patches against today's working tree. */
async function readTurnDiffFile({ sessionId, at, path: requested, full = false, ignoreWhitespace = false }) {
  const turn = readTurnDiffs(sessionId).find(item => item.at === at);
  const file = turn?.files.find(item => item.path === requested);
  if (!file) throw new Error('找不到该轮文件变更');
  if (!turn.snapshot) throw new Error('这条历史记录没有保存完整快照，只能查看已保存的差异');
  const { root, before, after } = turn.snapshot;
  if (![before, after].every(value => /^[a-f0-9]{40,64}$/.test(value))) throw new Error('快照标识无效');
  const relative = path.relative(root, requested);
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('文件不在快照中');
  const patch = file.binary ? '' : await git(root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', full ? '--unified=100000' : '--unified=3', ...(ignoreWhitespace ? ['--ignore-all-space'] : []), before, after, '--', relative]);
  const limit = full ? 2_000_000 : MAX_PATCH_CHARS;
  return { ...file, patch: patch.slice(0, limit), truncated: patch.length > limit };
}
module.exports = { beginTurn, endTurn, readTurnDiffs, saveTurnDiff, readTurnDiffFile };
