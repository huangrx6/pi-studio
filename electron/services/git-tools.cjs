'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
const locks = new Set();
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short'];
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const pageSize = 60;

function gitError(err, remote) {
  const detail = String(err.stderr || '');
  if (/authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|access denied|returned error: (401|403)|publickey/i.test(detail)) {
    return new Error('远程认证失败。请检查此远程的 Git 凭据或 SSH 密钥，然后重试。');
  }
  if (/CONFLICT|automatic merge failed|unmerged files/i.test(detail + err.stdout)) return new Error('存在合并冲突。请在工作区解决冲突文件，暂存后提交合并。');
  if (/would be overwritten|would be lost/i.test(detail)) return new Error('本地修改会被覆盖。请先提交这些修改，或在终端中暂存到 stash，再重试。');
  if (/already (checked out|used by worktree)/i.test(detail)) return new Error('该分支已由另一工作树使用。');
  if (/non-fast-forward|fetch first|not possible to fast-forward/i.test(detail)) return new Error('本地与远程历史已分叉。请先获取并审阅远程提交。');
  if (/couldn't find remote ref/i.test(detail)) return new Error('远程尚无该分支。首次发布请先推送。');
  if (err.killed) return new Error('Git 操作超时，请刷新仓库状态后再试。');
  if (remote) return new Error('远程操作失败。请检查网络、远程地址及访问权限，再刷新仓库状态。');
  // Never include the spawned command or arbitrary hook output in the renderer.
  if (/author identity unknown|please tell me who you are/i.test(detail)) return new Error('请先配置 Git 提交者姓名和邮箱。');
  if (/index\.lock/i.test(detail)) return new Error('另一个 Git 操作正在使用暂存区，请稍后重试。');
  if (/nothing to commit/i.test(detail + err.stdout)) return new Error('没有可提交的暂存修改。');
  if (/already exists/i.test(detail)) return new Error('同名分支已存在。');
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error('结果过大，请缩小查询范围。');
  return new Error('Git 操作未完成。请刷新状态，并检查仓库配置及 Git 钩子。');
}

async function run(cwd, args, { allowed = [], remote = false, patch = false, paths } = {}) {
  try {
    const processResult = exec('git', ['--no-pager', '--literal-pathspecs', ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: remote ? 120_000 : 30_000,
      maxBuffer: patch ? 256 * 1024 : 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' },
    });
    processResult.child.stdin.on('error', () => { /* Git reports command failures through its exit status. */ });
    processResult.child.stdin.end(paths ? paths.join('\0') + '\0' : undefined);
    return (await processResult).stdout;
  } catch (err) {
    if (allowed.includes(err.code) || (patch && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) return err.stdout || '';
    throw gitError(err, remote);
  }
}

function lines(output) { return output.split(/\r?\n/).filter(Boolean); }
function fields(output) { const values = output.split('\0'); values.pop(); return values; }
function requireOid(hash) {
  if (typeof hash !== 'string' || !oidPattern.test(hash)) throw new Error('提交标识无效。');
  return hash;
}
async function repository(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('没有选定工作区。');
  return fs.realpath((await run(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''));
}
async function head(cwd) {
  const [ref, oid] = await Promise.all([
    run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowed: [1] }),
    run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowed: [1] }),
  ]);
  return { branch: ref.trimEnd(), head: oid.trimEnd() };
}

async function changes(cwd) {
  const records = fields(await run(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--renames', '--untracked-files=all']));
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const code = records[i].slice(0, 2);
    const file = { path: records[i].slice(3), index: code[0], worktree: code[1], conflict: conflictCodes.has(code) };
    if (/[RC]/.test(code)) file.previousPath = records[++i];
    files.push(file);
  }
  return files;
}
async function branches(cwd, currentBranch) {
  const format = '%(refname)%00%(worktreepath)%00%(symref)%00%(upstream:remotename)%00%(upstream:remoteref)';
  const fields = currentBranch ? format + '%00%(upstream:track,nobracket)' : format;
  const refs = currentBranch ? ['refs/heads/' + currentBranch] : ['refs/heads', 'refs/remotes'];
  const rows = lines(await run(cwd, ['for-each-ref', '--sort=refname', '--format=' + fields, ...refs]));
  return rows.flatMap(row => {
    const [ref, worktree, symbolic, upstreamRemote, upstreamRef, track] = row.split('\0');
    if (symbolic) return [];
    const remote = ref.startsWith('refs/remotes/');
    return [{ name: ref.slice(remote ? 13 : 11), remote, worktree, upstreamRemote, upstreamBranch: upstreamRef.replace(/^refs\/heads\//, ''),
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] || 0), behind: Number(/behind (\d+)/.exec(track)?.[1] || 0), gone: track === 'gone' }];
  });
}
async function stagedVersion(cwd) {
  const entries = await run(cwd, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--']);
  return createHash('sha256').update(entries).digest('hex');
}
async function state(cwd) {
  const [position, files, remotes, merge, indexVersion] = await Promise.all([
    head(cwd), changes(cwd), run(cwd, ['remote']),
    run(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { allowed: [1] }),
    stagedVersion(cwd),
  ]);
  const current = position.branch && (await branches(cwd, position.branch)).find(ref => ref.name === position.branch);
  return { ...position, root: cwd, files, indexVersion, remotes: lines(remotes), merging: Boolean(merge), upstreamRemote: current?.upstreamRemote || '', upstreamBranch: current?.upstreamBranch || '',
    ahead: current?.ahead || 0, behind: current?.behind || 0, gone: current?.gone || false };
}

async function history(cwd, input) {
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('历史分页无效。');
  const query = String(input.query || '').trim().slice(0, 300);
  const args = ['log', '--graph', '--no-color', '--no-show-signature', '--no-notes', '--decorate=short', '--format=%x00%H%x00%an%x00%aI%x00%D%x00%s', '--max-count=' + (pageSize + 1), '--skip=' + offset];
  const match = /^[a-f0-9]{4,64}$/i.test(query) && (await run(cwd, ['rev-parse', '--verify', '--quiet', query + '^{commit}'], { allowed: [1] })).trim();
  if (match && oidPattern.test(match)) args.push('--max-count=1', match);
  else {
    if (query) args.push('--fixed-strings', '--regexp-ignore-case', '--grep=' + query);
    args.push('--branches', '--remotes', '--tags');
    const { head: current } = await head(cwd);
    if (current) args.push(current);
  }
  const rows = [];
  for (const line of lines(await run(cwd, [...args, '--']))) {
    const [graph, hash, author, date, refs, ...subject] = line.split('\0');
    if (hash) rows.push({ graph, hash, author, date, refs, subject: subject.join(' '), connectors: [] });
    else if (rows.length) rows.at(-1).connectors.push(graph);
  }
  return { rows: rows.slice(0, pageSize), more: rows.length > pageSize };
}

async function commitInfo(cwd, hash) {
  requireOid(hash);
  const [oid, parents, author, email, date, message] = (await run(cwd, ['show', '--no-patch', '--no-notes', '--no-show-signature', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', hash, '--'])).split('\0');
  const parent = parents.split(' ')[0];
  const entries = fields(await run(cwd, ['diff-tree', '--no-commit-id', '--name-status', '-z', '-r', '-M', '--root', ...(parent ? [parent] : []), hash, '--']));
  const files = [];
  for (let i = 0; i < entries.length;) {
    const code = entries[i++], first = entries[i++];
    files.push(/^[RC]/.test(code) ? { code, previousPath: first, path: entries[i++] } : { code, path: first });
  }
  return { hash: oid, parents: parents.split(' ').filter(Boolean), author, email, date, message: message.trimEnd(), files };
}

function forLayer(file, layer) {
  return layer === 'index' ? !file.conflict && ![' ', '?'].includes(file.index) : file.conflict || file.worktree !== ' ';
}
function filePaths(file, code) { return file.previousPath && /[RC]/.test(code) ? [file.previousPath, file.path] : [file.path]; }
async function diff(cwd, input) {
  let args, code;
  if (input.layer === 'commit') {
    const commit = await commitInfo(cwd, input.hash);
    const file = commit.files.find(f => f.path === input.path);
    if (!file) throw new Error('该提交没有此文件。');
    code = file.code;
    args = commit.parents.length ? ['diff', ...diffFlags, '-M', commit.parents[0], commit.hash] : ['show', '--format=', '--root', ...diffFlags, commit.hash];
    args.push('--', ...filePaths(file, code));
  } else {
    if (!['index', 'worktree'].includes(input.layer)) throw new Error('差异来源无效。');
    const file = (await changes(cwd)).find(f => f.path === input.path && forLayer(f, input.layer));
    if (!file) throw new Error('文件状态已变化，请刷新。');
    code = input.layer === 'index' ? file.index : file.worktree;
    if (code === '?') {
      const stat = await fs.lstat(path.join(cwd, file.path));
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('此项没有可展示的文本差异。');
    }
    let comparison = [];
    if (input.layer === 'index') comparison = ['--cached'];
    else if (file.conflict) comparison = [['UA', 'DU'].includes(file.index + file.worktree) ? '--theirs' : '--ours'];
    args = code === '?' ? ['diff', '--no-index', ...diffFlags, '--', '/dev/null', file.path]
      : ['diff', ...diffFlags, ...comparison, '--', ...filePaths(file, code)];
  }
  const raw = await run(cwd, args, { allowed: code === '?' ? [1] : [], patch: true });
  const limit = 80_000;
  const patch = raw.slice(0, limit);
  const binary = /^Binary files .* differ$/m.test(patch);
  const changedLines = patch.split('\n');
  const hunk = changedLines.findIndex(line => line.startsWith('@@ '));
  const content = hunk < 0 ? [] : changedLines.slice(hunk);
  return { path: input.path, label: input.path, status: ['A','?'].includes(code) ? 'added' : code === 'D' ? 'deleted' : 'modified',
    binary, patch, truncated: raw.length > limit, completeCounts: !binary && raw.length <= limit,
    added: content.filter(l => l.startsWith('+')).length, removed: content.filter(l => l.startsWith('-')).length };
}

async function gitRead(cwd, input) {
  const root = await repository(cwd);
  switch (input?.kind) {
    case 'state': return state(root);
    case 'branches': return { ...await head(root), branches: await branches(root), root };
    case 'history': return history(root, input);
    case 'detail': return commitInfo(root, input.hash);
    case 'diff': return diff(root, input);
    default: throw new Error('未知的 Git 查询。');
  }
}

async function validateBranch(root, name) {
  if (typeof name !== 'string' || !name || name.length > 1024 || name.startsWith('-') || /[\x00-\x1f]/.test(name)) throw new Error('分支名称无效。');
  const checked = await run(root, ['check-ref-format', '--branch', name], { allowed: [128, 1] });
  if (checked.trimEnd() !== name) throw new Error('分支名称无效。');
}

async function changeBranch(root, input) {
  const name = input.name;
  await validateBranch(root, name);
  if (input.kind === 'create') {
    await run(root, ['switch', '-c', name]);
  } else {
    const refs = await branches(root);
    let ref = refs.find(b => b.name === name && b.remote === (input.remoteBranch === true));
    if (!ref) throw new Error('分支已不存在，请刷新。');
    if (ref.remote) {
      const tracking = refs.filter(b => !b.remote && b.upstreamRemote + '/' + b.upstreamBranch === name);
      if (tracking.length > 1) throw new Error('多个本地分支跟踪此远程分支，请从本地分支列表中选择。');
      if (tracking.length) ref = tracking[0];
    }
    if (ref.worktree && path.resolve(ref.worktree) !== root) throw new Error('分支已由另一工作树使用：' + ref.worktree);
    await run(root, ref.remote ? ['switch', '--track', 'refs/remotes/' + ref.name] : ['switch', '--no-guess', '--', ref.name]);
  }
}

async function write(root, input) {
  const position = await head(root);
  if (position.head !== input.head || position.branch !== input.branch) throw new Error('当前分支或提交已变化，请刷新后重试。');
  switch (input.kind) {
    case 'create': case 'switch': return changeBranch(root, input);
    case 'stage': case 'unstage': {
      const stage = input.kind === 'stage';
      const available = (await changes(root)).filter(file => forLayer(file, stage ? 'worktree' : 'index'));
      if (!Array.isArray(input.paths) || !input.paths.length) throw new Error('请选择文件。');
      const wanted = new Set(input.paths);
      const selected = available.filter(file => wanted.has(file.path));
      if (selected.length !== wanted.size) throw new Error('文件状态已变化，请刷新。');
      const paths = selected.flatMap(file => filePaths(file, stage ? file.worktree : file.index));
      const args = stage ? ['add', '-A'] : position.head ? ['reset', '-q', 'HEAD'] : ['rm', '--cached', '-q', '-f'];
      return run(root, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { paths });
    }
    case 'commit': {
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 32_000) throw new Error('请输入有效的提交说明。');
      if (input.indexVersion !== await stagedVersion(root)) throw new Error('暂存内容已变化，请重新审阅后提交。');
      await run(root, ['commit', '-m', input.message]);
      return;
    }
    case 'fetch': case 'pull': case 'push': {
      const remote = input.remote;
      if (!lines(await run(root, ['remote'])).includes(remote) || remote.startsWith('-')) throw new Error('请选择已配置的远程仓库。');
      if (input.kind === 'fetch') return run(root, ['fetch', '--', remote], { remote: true });
      if (!position.branch) throw new Error('请先创建或切换到本地分支。');
      const current = (await branches(root)).find(b => !b.remote && b.name === position.branch);
      const upstream = current?.upstreamRemote === remote && current.upstreamBranch;
      const destination = 'refs/heads/' + (upstream || position.branch);
      if (input.kind === 'pull') return run(root, ['pull', '--no-rebase', '--no-autostash', '--no-edit', '--', remote, destination], { remote: true });
      if (!position.head) throw new Error('请先创建首次提交。');
      return run(root, ['push', ...(!current?.upstreamRemote ? ['--set-upstream'] : []), '--', remote, 'refs/heads/' + position.branch + ':' + destination], { remote: true });
    }
    default: throw new Error('未知的 Git 操作。');
  }
}

async function withGitLock(key, operation) {
  if (locks.has(key)) throw new Error('已有 Git 操作正在进行，请稍后重试。');
  locks.add(key);
  try { return await operation(); }
  finally { locks.delete(key); }
}
async function withRepositoryWrite(cwd, operation) {
  const root = await repository(cwd);
  const common = await fs.realpath(path.resolve(root, (await run(root, ['rev-parse', '--git-common-dir'])).trimEnd()));
  return withGitLock(common, () => operation(root));
}
async function gitWrite(cwd, input) {
  const root = await repository(cwd);
  return withGitLock(root, () => write(root, input));
}
module.exports = { gitRead, gitWrite, withRepositoryWrite, withGitLock, runGitCommand: run, validateBranch };
