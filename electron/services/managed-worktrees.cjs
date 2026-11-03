/**
 * Studio-owned Git worktrees used to isolate parallel child agents.
 *
 * Worktrees live below Electron userData, never inside the project. Git
 * operations that need an index use a temporary GIT_INDEX_FILE so Studio never
 * reads or rewrites the user's real staging area.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getStudioDatabase } = require('../core/studio-db.cjs');
const { userDataDirectory } = require('../core/studio-paths.cjs');

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;
const MAX_SCAN_ENTRIES = 200_000;
const TERMINAL_STATUSES = new Set(['applied', 'discarded', 'removed']);
const PRESERVED_STATUSES = new Set(['active', 'finished', 'failed']);
const DEFAULT_PENDING_LIMIT = 8;
const operations = new Map();

// Creation checks capacity before yielding to Git. Serialize managed mutations
// so another request cannot overbook capacity or clean up a half-created tree.
function serialized(operation, options) {
  const key = managedRoot(options);
  const pending = (operations.get(key) || Promise.resolve()).then(operation);
  const settled = pending.catch(() => {}).finally(() => {
    if (operations.get(key) === settled) operations.delete(key);
  });
  operations.set(key, settled);
  return pending;
}

function resolveOptions(options = {}) {
  return {
    database: options.database || getStudioDatabase(),
    userDataPath: path.resolve(options.userDataPath || userDataDirectory()),
  };
}

function managedRoot(options = {}) {
  return path.join(resolveOptions(options).userDataPath, 'worktrees');
}

async function git(cwd, args, { env, timeout = GIT_TIMEOUT, allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      env: { ...process.env, ...env },
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return '';
    const message = error?.stderr?.toString().trim()
      || error?.stdout?.toString().trim()
      || error?.message
      || 'Git 操作失败';
    throw new Error(message);
  }
}

function slug(value, fallback = 'agent') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

function workspaceKey(repositoryRoot) {
  return createHash('sha256')
    .update(String(repositoryRoot))
    .digest('hex')
    .slice(0, 12);
}

function assertContained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('托管工作树路径越界');
  }
}

function pendingCount(database, workspace) {
  return database.listManagedWorktrees()
    .filter((item) => item.workspace === workspace && PRESERVED_STATUSES.has(item.status))
    .length;
}

async function repositoryInfo(workspace) {
  if (typeof workspace !== 'string' || !workspace) throw new Error('缺少工作区路径');
  const requested = path.resolve(workspace);
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    throw new Error('工作区目录不存在');
  }
  const root = (await git(requested, ['rev-parse', '--show-toplevel'])).trim();
  if (!root) throw new Error('当前工作区不是 Git 仓库');
  const repositoryRoot = fs.realpathSync(root);
  const baseCommit = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) {
    throw new Error('Git 仓库还没有可用于创建隔离工作树的提交');
  }
  return { repositoryRoot, baseCommit };
}

async function isGitRepository(workspace) {
  try {
    await repositoryInfo(workspace);
    return true;
  } catch {
    return false;
  }
}

function safeWorktreePath(record, options = {}) {
  const root = managedRoot(options);
  assertContained(root, record.path);
  if (fs.existsSync(record.path)) {
    if (fs.lstatSync(record.path).isSymbolicLink()) throw new Error('托管工作树不能是符号链接');
    assertContained(fs.realpathSync(root), fs.realpathSync(record.path));
  }
  return path.resolve(record.path);
}

async function removeDirectory(record, options = {}) {
  const target = safeWorktreePath(record, options);
  if (fs.existsSync(target)) {
    try {
      await git(record.repositoryRoot, ['worktree', 'remove', '--force', target]);
    } catch {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('拒绝删除符号链接形式的工作树目录');
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  await git(record.repositoryRoot, ['worktree', 'prune'], { allowFailure: true });
}

function directorySize(root) {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length && entries < MAX_SCAN_ENTRIES) {
    const current = pending.pop();
    let children;
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      entries += 1;
      if (entries >= MAX_SCAN_ENTRIES) break;
      const target = path.join(current, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        pending.push(target);
        continue;
      }
      try {
        bytes += fs.statSync(target).size;
      } catch {
        // Files may disappear while the child is still running.
      }
    }
  }
  return { bytes, entries, truncated: entries >= MAX_SCAN_ENTRIES };
}

function parseNameStatus(text) {
  const fields = text.split('\0');
  const files = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const rawStatus = fields[index];
    files.push({
      status: rawStatus.startsWith('A')
        ? 'added'
        : rawStatus.startsWith('D')
          ? 'deleted'
          : 'modified',
      path: fields[index + 1],
    });
  }
  return files;
}

async function snapshotChanges(record, options = {}) {
  const worktreePath = safeWorktreePath(record, options);
  if (!fs.existsSync(worktreePath)) {
    throw new Error('托管工作树目录已经不存在');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-worktree-index-'));
  const index = path.join(temporary, 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(worktreePath, ['read-tree', record.baseCommit], { env });
    await git(worktreePath, ['add', '-A', '--', '.'], { env });
    const endTree = (await git(worktreePath, ['write-tree'], { env })).trim();
    const baseTree = (await git(worktreePath, ['rev-parse', `${record.baseCommit}^{tree}`])).trim();
    if (endTree === baseTree) {
      return {
        changed: false,
        changedFiles: 0,
        files: [],
        totalAdded: 0,
        totalRemoved: 0,
        patch: '',
      };
    }
    const [statText, statusText, patch] = await Promise.all([
      git(worktreePath, ['diff', '--numstat', '-z', '--no-renames', baseTree, endTree]),
      git(worktreePath, ['diff', '--name-status', '-z', '--no-renames', baseTree, endTree]),
      git(worktreePath, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-color', baseTree, endTree]),
    ]);
    const statuses = new Map(parseNameStatus(statusText).map((item) => [item.path, item.status]));
    const files = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const line of statText.split('\0')) {
      if (!line.trim()) continue;
      const [addedRaw, removedRaw, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      if (!filePath) continue;
      const binary = addedRaw === '-';
      const added = binary ? 0 : Number(addedRaw) || 0;
      const removed = binary ? 0 : Number(removedRaw) || 0;
      totalAdded += added;
      totalRemoved += removed;
      files.push({
        path: filePath,
        status: statuses.get(filePath) || 'modified',
        added,
        removed,
        binary,
      });
    }
    return {
      changed: true,
      changedFiles: files.length,
      files,
      totalAdded,
      totalRemoved,
      patch,
      baseTree,
      endTree,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function describeRecord(record, options = {}, { includePatch = false } = {}) {
  safeWorktreePath(record, options);
  let changes;
  let inspectionError = '';
  try {
    changes = await snapshotChanges(record, options);
  } catch (error) {
    inspectionError = error instanceof Error ? error.message : String(error);
  }
  const size = fs.existsSync(record.path)
    ? directorySize(record.path)
    : { bytes: 0, entries: 0, truncated: false };
  return {
    ...record,
    changed: changes?.changed,
    changedFiles: changes?.changedFiles,
    files: changes?.files || [],
    totalAdded: changes?.totalAdded,
    totalRemoved: changes?.totalRemoved,
    sizeBytes: size.bytes,
    fileEntries: size.entries,
    sizeTruncated: size.truncated,
    directoryExists: fs.existsSync(record.path),
    ...(includePatch ? { patch: changes?.patch || '' } : {}),
    ...(inspectionError ? { inspectionError } : {}),
  };
}

async function createManagedWorktree(input = {}, options = {}) {
  const resolved = resolveOptions(options);
  const database = resolved.database;
  const parentConversationId = String(input.parentConversationId || '').trim();
  if (!parentConversationId) throw new Error('托管工作树缺少父会话');
  const id = String(input.id || '').trim();
  if (!id) throw new Error('托管工作树缺少稳定标识');
  const existing = database.getManagedWorktree(id);
  if (existing) {
    if (fs.existsSync(existing.path)) return existing;
    database.removeManagedWorktree(id);
  }

  const info = await repositoryInfo(input.workspace);
  const limit = Math.max(1, Math.min(50, Number(input.limit) || DEFAULT_PENDING_LIMIT));
  if (pendingCount(database, info.repositoryRoot) >= limit) {
    throw new Error(`当前工作区已有 ${limit} 个待处理工作树，请先合并或丢弃其中一个`);
  }
  const name = slug(input.name, 'agent');
  const location = path.join(
    managedRoot(resolved),
    workspaceKey(info.repositoryRoot),
    `${Date.now().toString(36)}-${name}-${createHash('sha256').update(id).digest('hex').slice(0, 6)}`,
  );
  fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  try {
    await git(info.repositoryRoot, ['worktree', 'add', '--detach', location, info.baseCommit]);
  } catch (error) {
    fs.rmSync(location, { recursive: true, force: true });
    throw error;
  }
  try {
    return database.insertManagedWorktree({
      id,
      parentConversationId,
      childConversationId: input.childConversationId || '',
      name,
      workspace: info.repositoryRoot,
      repositoryRoot: info.repositoryRoot,
      path: location,
      baseCommit: info.baseCommit,
      status: 'active',
    });
  } catch (error) {
    await removeDirectory({
      repositoryRoot: info.repositoryRoot,
      path: location,
    }, resolved).catch(() => {});
    throw error;
  }
}

function bindManagedWorktree(id, childConversationId, options = {}) {
  const { database } = resolveOptions(options);
  const current = database.getManagedWorktree(id);
  if (!current) throw new Error('托管工作树不存在');
  return database.updateManagedWorktree(id, {
    childConversationId: String(childConversationId),
  });
}

function reactivateManagedWorktree(id, options = {}) {
  const { database } = resolveOptions(options);
  if (!id) return undefined;
  const record = database.getManagedWorktree(id);
  if (!record || TERMINAL_STATUSES.has(record.status)) {
    throw new Error('子智能体工作树已被处理，请重新发送任务以创建工作树');
  }
  return database.updateManagedWorktree(id, {
    status: 'active',
    finishedAt: null,
    error: '',
  });
}

async function completeManagedWorktree(id, {
  status = 'finished',
  error = '',
} = {}, options = {}) {
  const resolved = resolveOptions(options);
  if (!id) return undefined;
  const record = resolved.database.getManagedWorktree(id);
  if (!record || record.status !== 'active') return record;
  let changes;
  try {
    changes = await snapshotChanges(record, resolved);
  } catch (cause) {
    return resolved.database.updateManagedWorktree(id, {
      status: 'failed',
      error: [error, cause instanceof Error ? cause.message : String(cause)]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 4_000),
      finishedAt: Date.now(),
    });
  }
  if (!changes.changed) {
    await removeDirectory(record, resolved);
    return resolved.database.updateManagedWorktree(id, {
      status: 'removed',
      finishedAt: Date.now(),
      error: '',
    });
  }
  return resolved.database.updateManagedWorktree(id, {
    status: status === 'failed' ? 'failed' : 'finished',
    error: status === 'failed' ? String(error || '任务执行失败').slice(0, 4_000) : '',
    finishedAt: Date.now(),
  });
}

async function markManagedWorktreeFailed(id, error, options = {}) {
  const { database } = resolveOptions(options);
  const record = database.getManagedWorktree(id);
  if (!record) return undefined;
  return completeManagedWorktree(id, { status: 'failed', error }, options);
}

async function listManagedWorktrees({
  includeTerminal = false,
  workspace = '',
} = {}, options = {}) {
  const database = options.database || getStudioDatabase();
  const rows = database.listManagedWorktrees({ includeTerminal })
    .filter((row) => !workspace || row.workspace === path.resolve(workspace));
  if (rows.length === 0) return [];
  const resolved = resolveOptions({ ...options, database });
  return Promise.all(rows.map((row) => describeRecord(row, resolved)));
}

async function inspectManagedWorktree(id, options = {}) {
  const resolved = resolveOptions(options);
  const record = resolved.database.getManagedWorktree(id);
  if (!record) throw new Error('托管工作树不存在');
  return describeRecord(record, resolved, { includePatch: true });
}

async function applyManagedWorktree(id, options = {}) {
  const resolved = resolveOptions(options);
  const record = resolved.database.getManagedWorktree(id);
  if (!record) throw new Error('托管工作树不存在');
  if (record.status === 'active') throw new Error('任务仍在运行，结束后才能应用改动');
  if (TERMINAL_STATUSES.has(record.status)) throw new Error('这个托管工作树已经结束');
  const changes = await snapshotChanges(record, resolved);
  if (!changes.changed) {
    await removeDirectory(record, resolved);
    resolved.database.updateManagedWorktree(id, {
      status: 'removed',
      finishedAt: Date.now(),
    });
    return { ok: true, changedFiles: 0, removed: true };
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-worktree-apply-'));
  const patchFile = path.join(temporary, 'changes.patch');
  try {
    fs.writeFileSync(patchFile, changes.patch, { encoding: 'utf8', mode: 0o600 });
    await git(record.repositoryRoot, [
      'apply',
      '--check',
      '--whitespace=nowarn',
      patchFile,
    ]);
    await git(record.repositoryRoot, [
      'apply',
      '--whitespace=nowarn',
      patchFile,
    ]);
  } catch (error) {
    throw new Error(`无法应用工作树改动：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  try {
    await removeDirectory(record, resolved);
  } catch (error) {
    resolved.database.updateManagedWorktree(id, {
      status: 'applied',
      error: `改动已应用，但目录清理失败：${error instanceof Error ? error.message : String(error)}`,
      finishedAt: Date.now(),
    });
    return {
      ok: true,
      changedFiles: changes.changedFiles,
      cleanupError: error instanceof Error ? error.message : String(error),
    };
  }
  resolved.database.updateManagedWorktree(id, {
    status: 'applied',
    error: '',
    finishedAt: Date.now(),
  });
  return { ok: true, changedFiles: changes.changedFiles };
}

async function discardManagedWorktree(id, {
  force = false,
  missingOk = false,
} = {}, options = {}) {
  const resolved = resolveOptions(options);
  const record = resolved.database.getManagedWorktree(id);
  if (!record) {
    if (missingOk) return { ok: true, alreadyTerminal: true };
    throw new Error('托管工作树不存在');
  }
  if (record.status === 'active' && !force) {
    throw new Error('任务仍在运行，请先停止任务');
  }
  if (TERMINAL_STATUSES.has(record.status)) {
    await removeDirectory(record, resolved);
    return { ok: true, alreadyTerminal: true };
  }
  let cleanupError = '';
  try {
    await removeDirectory(record, resolved);
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  resolved.database.updateManagedWorktree(id, {
    status: 'discarded',
    error: cleanupError,
    finishedAt: Date.now(),
  });
  if (cleanupError) throw new Error(`工作树已标记丢弃，但目录清理失败：${cleanupError}`);
  return { ok: true };
}

async function reconcileManagedWorktreesForChildren(children = [], options = {}) {
  const statuses = new Map((children || []).map((child) => [
    Number(String(child.key || '').replace(/^conversation:/, '')),
    child.status,
  ]));
  const resolved = resolveOptions(options);
  const records = resolved.database.listManagedWorktrees()
    .filter((record) => record.childConversationId);
  const results = [];
  for (const record of records) {
    const status = statuses.get(Number(record.childConversationId));
    if (!['completed', 'failed', 'stopped'].includes(status)) continue;
    results.push(await completeManagedWorktree(record.id, {
      status: status === 'failed' ? 'failed' : 'finished',
      error: status === 'failed' ? '子智能体执行失败' : '',
    }, resolved));
  }
  return results.filter(Boolean);
}

async function discardManagedWorktreesForConversations(conversationIds = [], {
  force = true,
} = {}, options = {}) {
  const resolved = resolveOptions(options);
  const ids = new Set((conversationIds || []).map(String));
  for (const id of [...ids]) {
    const row = resolved.database.getConversation(id);
    if (row) { ids.add(String(row.id)); ids.add(row.publicId); }
  }
  const records = resolved.database.listManagedWorktrees({ includeTerminal: true })
    .filter((record) => (
      ids.has(String(record.parentConversationId))
      || ids.has(String(record.childConversationId))
    ));
  let removed = 0;
  const failures = [];
  for (const record of records) {
    if (TERMINAL_STATUSES.has(record.status)) {
      try {
        await removeDirectory(record, resolved);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      resolved.database.removeManagedWorktree(record.id);
      removed += 1;
      continue;
    }
    try {
      await discardManagedWorktree(record.id, { force }, resolved);
      resolved.database.removeManagedWorktree(record.id);
      removed += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length) {
    throw new Error(`部分托管工作树清理失败：${failures[0]}`);
  }
  return { removed };
}

async function cleanupManagedWorktrees(options = {}) {
  const resolved = resolveOptions(options);
  const root = managedRoot(resolved);
  const all = resolved.database.listManagedWorktrees({ includeTerminal: true });
  const registered = new Set(all.map((record) => path.resolve(record.path)));
  let removed = 0;
  const failures = [];
  for (const record of all) {
    if (TERMINAL_STATUSES.has(record.status) && fs.existsSync(record.path)) {
      try {
        await removeDirectory(record, resolved);
        removed += 1;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (PRESERVED_STATUSES.has(record.status) && !fs.existsSync(record.path)) {
      resolved.database.updateManagedWorktree(record.id, {
        status: 'failed',
        error: '托管工作树目录已丢失',
        finishedAt: record.finishedAt || Date.now(),
      });
      await git(record.repositoryRoot, ['worktree', 'prune'], { allowFailure: true });
    }
  }

  if (fs.existsSync(root)) {
    for (const workspaceDirectory of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspaceDirectory.isDirectory()) continue;
      const workspacePath = path.join(root, workspaceDirectory.name);
      for (const child of fs.readdirSync(workspacePath, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const target = path.join(workspacePath, child.name);
        if (!registered.has(path.resolve(target))) {
          assertContained(root, target);
          fs.rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      }
      try {
        fs.rmdirSync(workspacePath);
      } catch {
        // The directory still contains another valid managed worktree.
      }
    }
  }
  return { removed, failures };
}

module.exports = {
  DEFAULT_PENDING_LIMIT,
  applyManagedWorktree: (id, options) => serialized(() => applyManagedWorktree(id, options), options),
  bindManagedWorktree: (id, childId, options) => serialized(() => bindManagedWorktree(id, childId, options), options),
  cleanupManagedWorktrees: (options) => serialized(() => cleanupManagedWorktrees(options), options),
  completeManagedWorktree: (id, input, options) => serialized(() => completeManagedWorktree(id, input, options), options),
  createManagedWorktree: (input, options) => serialized(() => createManagedWorktree(input, options), options),
  discardManagedWorktree: (id, input, options) => serialized(() => discardManagedWorktree(id, input, options), options),
  discardManagedWorktreesForConversations: (ids, input, options) => serialized(() => discardManagedWorktreesForConversations(ids, input, options), options),
  inspectManagedWorktree,
  isGitRepository,
  listManagedWorktrees,
  managedRoot,
  markManagedWorktreeFailed: (id, error, options) => serialized(() => markManagedWorktreeFailed(id, error, options), options),
  reactivateManagedWorktree: (id, options) => id
    ? serialized(() => reactivateManagedWorktree(id, options), options)
    : Promise.resolve(),
  reconcileManagedWorktreesForChildren: (children, options) => serialized(() => reconcileManagedWorktreesForChildren(children, options), options),
  repositoryInfo,
};
