const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { gitRead, gitWrite } = require('../../electron/services/git-tools.cjs');

process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
function cli(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-git-tools-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'workspace');
  cli(base, 'init', '-b', 'main', repo);
  identity(repo);
  return { repo, base, read: (kind, params) => gitRead(repo, { kind, ...params }), write: async (kind, params) => {
    const { branch, head, indexVersion } = await gitRead(repo, { kind: 'state' });
    const review = ['pull', 'push'].includes(kind) ? await gitRead(repo, { kind: 'syncPreview', operation: kind, remote: params.remote }) : {};
    await gitWrite(repo, { branch, head, indexVersion, kind, version: review.version, ...params });
  } };
}
function identity(repo) {
  cli(repo, 'config', 'user.name', 'Studio QA');
  cli(repo, 'config', 'user.email', 'qa@example.invalid');
}
function seed(repo) {
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  cli(repo, 'add', '--', 'tracked.txt');
  cli(repo, 'commit', '-m', 'initial');
}

test('unborn branch, literal names, partial staging, first push and searchable history with root and rename diffs', async t => {
  const { base, repo, read, write } = fixture(t);
  assert.deepEqual(await read('history'), { rows: [], more: false, total: 0, offset: 0, pageSize: 60 });
  const a = '-file[1].txt', b = process.platform === 'win32' ? 'two spaces.txt' : 'two\nlines';
  fs.writeFileSync(path.join(repo, a), 'one\n');
  fs.writeFileSync(path.join(repo, b), 'two\n');
  const stage = (...paths) => write('stage', { paths });
  const unstage = (...paths) => write('unstage', { paths });
  assert.match((await read('diff', { layer: 'worktree', path: a })).patch, /\+one/);
  await stage(a, b);
  await unstage(a);
  assert.equal((await read('state')).files.find(f => f.path === a).index, '?');
  await stage(a);
  await write('commit', { message: 'initial source\n\nfirst body' });
  const hash = cli(repo, 'rev-parse', 'HEAD');
  assert.equal((await read('history', { query: hash.slice(0, 10) })).rows[0].hash, hash);
  assert.equal((await read('detail', { hash })).files.length, 2);
  assert.match((await read('diff', { layer: 'commit', hash, path: a })).patch, /\+one/);
  fs.writeFileSync(path.join(repo, a), 'second\n');
  await stage(a);
  fs.writeFileSync(path.join(repo, a), 'third\n');
  assert.match((await read('diff', { layer: 'index', path: a })).patch, /\+second/);
  assert.match((await read('diff', { layer: 'worktree', path: a })).patch, /\+third/);
  await unstage(a);
  await stage(a);
  const reviewed = await read('state');
  cli(repo, 'mv', '--', b, 'renamed');
  await assert.rejects(gitWrite(repo, { ...reviewed, kind: 'commit', message: 'outdated index' }), /暂存内容已变化/);
  await write('commit', { message: 'publish checkpoint' });
  const published = cli(repo, 'rev-parse', 'HEAD');
  const revision = (await read('history', { query: 'CHECKPOINT' })).rows[0];
  assert.equal(revision.hash, published);
  assert.ok(revision.graph.includes('*'));
  const info = await read('detail', { hash: published });
  assert.ok(info.files.some(f => f.previousPath === b && f.path === 'renamed'));
  assert.match((await read('diff', { layer: 'commit', hash: published, path: 'renamed' })).patch, /rename to renamed/);
  cli(base, 'init', '--bare', '-b', 'main', 'remote.git');
  cli(repo, 'remote', 'add', 'origin', path.join(base, 'remote.git'));
  await write('push', { remote: 'origin' });
  assert.equal(cli(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  assert.equal(cli(path.join(base, 'remote.git'), 'rev-parse', 'refs/heads/main'), published);
  await write('fetch', { remote: 'origin' });
  await write('pull', { remote: 'origin' });
});

test('dirty checkout keeps work intact, rejects occupied branches and stale actions, and switches tracked remote branches', async t => {
  const { repo, base, read, write } = fixture(t);
  seed(repo);
  await write('create', { name: 'topic' });
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'topic\n');
  cli(repo, 'commit', '-am', 'topic');
  await write('switch', { name: 'main' });
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'unsaved\n');
  await assert.rejects(write('switch', { name: 'topic' }), /覆盖/);
  assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'unsaved\n');
  cli(repo, 'worktree', 'add', path.join(base, 'linked'), 'topic');
  const branches = await read('branches');
  assert.equal(branches.branches.find(b => b.name === 'topic').worktree, path.join(base, 'linked'));
  await assert.rejects(write('switch', { name: 'topic' }), /另一工作树/);
  await assert.rejects(gitWrite(repo, { kind: 'stage', branch: 'old', head: branches.head, paths: ['tracked.txt'] }), /已变化/);
  await assert.rejects(write('stage', { paths: ['../outside'] }), /已变化/);
  cli(base, 'clone', '--bare', repo, 'origin.git');
  cli(repo, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  cli(path.join(base, 'origin.git'), 'branch', 'remote-only', 'main');
  await write('fetch', { remote: 'origin' });
  await write('switch', { name: 'origin/remote-only', remoteBranch: true });
  assert.equal(cli(repo, 'branch', '--show-current'), 'remote-only');
  assert.equal(cli(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/remote-only');
  assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'unsaved\n');
});

test('divergent pull exposes conflicts, resolved files can be staged and the merge pushed', async t => {
  const { repo, base, read, write } = fixture(t);
  seed(repo);
  cli(base, 'init', '--bare', '-b', 'main', 'upstream.git');
  cli(repo, 'remote', 'add', 'origin', path.join(base, 'upstream.git'));
  await write('push', { remote: 'origin' });
  cli(base, 'clone', path.join(base, 'upstream.git'), 'peer');
  const peer = path.join(base, 'peer');
  identity(peer);
  fs.writeFileSync(path.join(peer, 'tracked.txt'), 'remote\n');
  cli(peer, 'commit', '-am', 'remote change');
  cli(peer, 'push');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'local\n');
  cli(repo, 'commit', '-am', 'local change');
  await assert.rejects(write('pull', { remote: 'origin' }), /冲突/);
  const conflict = await read('state');
  assert.ok(conflict.merging && conflict.files[0].conflict);
  await assert.rejects(write('abortMerge', { mergeHead: 'outdated' }), /合并已变化/);
  await write('abortMerge', { mergeHead: conflict.mergeHead });
  assert.equal(cli(repo, 'status', '--porcelain'), '');
  assert.equal((await read('state')).head, conflict.head);
  await assert.rejects(write('pull', { remote: 'origin' }), /冲突/);
  assert.match((await read('diff', { layer: 'worktree', path: 'tracked.txt' })).patch, /<<<<<<< HEAD/);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'resolved\n');
  await write('stage', { paths: ['tracked.txt'] });
  await write('commit', { message: 'resolve merge' });
  await write('push', { remote: 'origin' });
  const history = await read('history');
  assert.ok(history.rows.some(row => row.connectors.some(line => line.includes('\\'))));
  assert.equal((await read('detail', { hash: history.rows[0].hash })).parents.length, 2);
  assert.equal((await read('state')).merging, false);
});

test('SSH authentication failure has actionable feedback without credentials or network access', async t => {
  const { repo, base, write } = fixture(t);
  seed(repo);
  const transport = path.join(base, 'denied.cjs');
  fs.writeFileSync(transport, "process.stderr.write('Permission denied (publickey).'); process.exitCode = 255;");
  cli(repo, 'config', 'core.sshCommand', '"' + process.execPath.split(path.sep).join('/') + '" "' + transport.split(path.sep).join('/') + '"');
  cli(repo, 'config', 'ssh.variant', 'ssh');
  cli(repo, 'remote', 'add', 'private', 'ssh://fixture@private.invalid/repository');
  await assert.rejects(write('fetch', { remote: 'private' }), error => /认证失败/.test(error.message) && !error.message.includes('private.invalid'));
});

test('history counts the same filtered range as each page and clamps a stale offset', async t => {
  const { repo, read } = fixture(t);
  const input = Array.from({ length: 125 }, (_, i) => {
    const message = (i % 2 ? 'odd' : 'even') + '-' + i;
    return 'commit refs/heads/main\ncommitter QA <qa@example.invalid> ' + (1600000000 + i) + ' +0000\ndata ' + message.length + '\n' + message + '\n\n';
  }).join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input });
  cli(repo, 'tag', 'also-main');
  const first = await read('history'), last = await read('history', { offset: 120 });
  assert.equal(first.total, 125);
  assert.equal(first.rows.length, 60);
  assert.deepEqual(last.rows.map(row => row.subject), ['even-4', 'odd-3', 'even-2', 'odd-1', 'even-0']);
  const filtered = await read('history', { query: 'ODD-', offset: 600 });
  assert.equal(filtered.offset, 60);
  assert.equal(filtered.total, 62);
  assert.deepEqual(filtered.rows.map(row => row.subject), ['odd-3', 'odd-1']);
  const exact = await read('history', { query: first.rows[0].hash.slice(0, 10), offset: 60 });
  assert.equal(exact.total, 1);
  assert.equal(exact.rows[0].hash, first.rows[0].hash);
});

test('summary and repeated status avoid transferring the same files; selected rename keeps its two paths', async t => {
  const { repo, read } = fixture(t);
  seed(repo);
  cli(repo, 'mv', 'tracked.txt', 'new.txt');
  fs.writeFileSync(path.join(repo, 'new-file'), 'untracked\n');
  const full = await read('state');
  assert.equal(full.files.length, 2);
  const same = await read('state', { knownFilesVersion: full.filesVersion });
  assert.ok(same.filesUnchanged);
  assert.deepEqual(same.files, []);
  assert.deepEqual((await read('state', { summaryOnly: true })).files, []);
  assert.match((await read('diff', { layer: 'index', path: 'new.txt', previousPath: 'tracked.txt' })).patch, /rename from tracked.txt/);
  assert.match((await read('diff', { layer: 'index', path: 'new.txt' })).patch, /rename to new.txt/);
  fs.unlinkSync(path.join(repo, 'new-file'));
  assert.equal((await read('state', { knownFilesVersion: full.filesVersion })).files.length, 1);
});

test('remote management distinguishes push and fetch, redacts credentials and guards concurrent edits', async t => {
  const { base, repo, read, write } = fixture(t);
  const fetch = path.join(base, 'upstream.git'), push = path.join(base, 'publish.git');
  cli(base, 'init', '--bare', fetch); cli(base, 'init', '--bare', push);
  await write('remoteAdd', { name: 'origin', url: fetch });
  const info = () => read('remoteInfo', { remote: 'origin' });
  const initial = await info();
  await write('remoteEdit', { remote: 'origin', field: 'push', url: push, version: initial.version });
  assert.deepEqual((await info()).pushUrls, [push]);
  assert.deepEqual((await info()).fetchUrls, [fetch]);
  await assert.rejects(write('remoteRemove', { remote: 'origin', version: initial.version }), /配置已更改/);
  seed(repo);
  const preview = await read('syncPreview', { operation: 'push', remote: 'origin' });
  assert.equal(preview.address, push);
  await write('push', { remote: 'origin', version: preview.version });
  assert.equal(cli(push, 'rev-parse', 'refs/heads/main'), preview.head);
  assert.equal(cli(fetch, 'for-each-ref', 'refs/heads'), '');
  await write('remoteEdit', { remote: 'origin', field: 'push', url: '', version: (await info()).version });
  assert.deepEqual((await info()).pushUrls, [fetch]);
  cli(repo, 'remote', 'set-url', 'origin', 'https://user:do-not-display@example.invalid/project.git?token=secret');
  const safe = await info();
  assert.deepEqual(safe.fetchUrls, ['https://example.invalid/project.git']);
  assert.doesNotMatch(JSON.stringify(safe), /do-not-display|token=secret/);
  await write('remoteEdit', { remote: 'origin', field: 'fetch', url: fetch, version: safe.version });
  await write('remoteRename', { remote: 'origin', name: 'central', version: (await info()).version });
  await write('remoteRemove', { remote: 'central', version: (await read('remoteInfo', { remote: 'central' })).version });
  assert.equal(cli(repo, 'remote'), '');
});

test('a review with multiple push addresses publishes only to the chosen repository', async t => {
  const { base, repo, read } = fixture(t);
  seed(repo);
  const primary = path.join(base, 'primary.git'), mirror = path.join(base, 'mirror.git');
  for (const destination of [primary, mirror]) cli(base, 'init', '--bare', destination);
  cli(repo, 'remote', 'add', 'origin', primary);
  const old = await read('remoteInfo', { remote: 'origin' });
  for (const destination of [primary, mirror]) cli(repo, 'config', '--add', 'remote.origin.pushurl', destination);
  const info = await read('remoteInfo', { remote: 'origin' });
  assert.deepEqual(info.pushUrls, [primary, mirror]);
  const preview = (targetIndex, remoteVersion = info.version) => read('syncPreview', { operation: 'push', remote: 'origin', targetIndex, remoteVersion });
  const publish = (plan, targetIndex) => gitWrite(repo, { branch: plan.branch, head: plan.head, kind: 'push', remote: 'origin', version: plan.version, targetIndex });
  await assert.rejects(preview(0, old.version), /远程地址已变化/);
  await assert.rejects(preview(), /目标地址/);
  const second = await preview(1);
  assert.equal(second.address, mirror);
  assert.equal(second.setUpstream, false);
  await assert.rejects(publish(second, 0), /重新预览/);
  await publish(second, 1);
  assert.equal(cli(primary, 'for-each-ref', 'refs/heads'), '');
  assert.equal(cli(mirror, 'rev-parse', 'main'), second.head);
  const first = await preview(0);
  assert.equal(first.setUpstream, true);
  await publish(first, 0);
  assert.equal(cli(primary, 'rev-parse', 'main'), first.head);
  assert.equal(cli(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
  assert.deepEqual((await read('remoteInfo', { remote: 'origin' })).pushUrls, [primary, mirror]);
});

test('review binds push and pull to the actual destination and rejects stale or unapproved overwrites', async t => {
  const { base, repo, read, write } = fixture(t);
  seed(repo);
  const remote = path.join(base, 'shared.git'), peer = path.join(base, 'peer');
  cli(base, 'clone', '--bare', repo, remote);
  cli(repo, 'remote', 'add', 'origin', remote);
  cli(remote, 'branch', 'publish', 'main');
  cli(repo, 'fetch', 'origin');
  cli(repo, 'branch', '--set-upstream-to=origin/publish', 'main');
  cli(base, 'clone', '-b', 'publish', remote, peer); identity(peer);
  cli(peer, 'commit', '--allow-empty', '-m', 'peer only'); cli(peer, 'push');
  cli(repo, 'commit', '--allow-empty', '-m', 'local only');
  const review = operation => read('syncPreview', { operation, remote: 'origin' });
  const first = await review('push');
  assert.equal(first.target, 'publish');
  assert.equal(first.incoming, 1); assert.equal(first.outgoing, 1);
  const commits = await read('syncCommits', { tip: first.head, exclude: first.remoteHead });
  assert.deepEqual(commits.map(row => row.subject), ['local only']);
  const apply = (kind, version, force) => gitWrite(repo, { kind, branch: first.branch, head: first.head, remote: 'origin', version, force });
  await assert.rejects(apply('push', first.version), /确认覆盖/);
  const incoming = await review('pull');
  cli(repo, 'config', 'pull.ff', 'only');
  const ffOnly = await review('pull');
  assert.equal(ffOnly.mergeMode, 'ff-only');
  await assert.rejects(apply('pull', ffOnly.version), /分叉/);
  assert.equal(cli(repo, 'rev-parse', 'HEAD'), first.head);
  cli(repo, 'config', '--unset', 'pull.ff');
  cli(peer, 'commit', '--allow-empty', '-m', 'newer peer'); cli(peer, 'push');
  await assert.rejects(apply('push', first.version, true), /重新预览/);
  await assert.rejects(apply('pull', incoming.version), /重新预览/);
  assert.equal(cli(repo, 'rev-parse', 'HEAD'), first.head);
  assert.equal(cli(remote, 'rev-parse', 'publish'), cli(peer, 'rev-parse', 'HEAD'));
  const fresh = await review('push');
  assert.equal(fresh.incoming, 2);
  await apply('push', fresh.version, true);
  assert.equal(cli(remote, 'rev-parse', 'publish'), first.head);
  assert.notEqual(cli(remote, 'rev-parse', 'main'), first.head);
});

test('first pull previews an existing branch and preserves an overlapping untracked file', async t => {
  const { base, repo, read, write } = fixture(t);
  const source = path.join(base, 'source');
  cli(base, 'init', '-b', 'main', source);
  identity(source); seed(source);
  cli(repo, 'remote', 'add', 'origin', source);
  const local = path.join(repo, 'tracked.txt');
  fs.writeFileSync(local, 'local work\n');
  const plan = await read('syncPreview', { operation: 'pull', remote: 'origin' });
  assert.equal(plan.dirty, true);
  assert.equal(plan.incoming, 1);
  await assert.rejects(write('pull', { remote: 'origin', version: plan.version }), /覆盖|未完成/);
  assert.equal(fs.readFileSync(local, 'utf8'), 'local work\n');
  fs.renameSync(local, path.join(repo, 'saved.txt'));
  await write('pull', { remote: 'origin' });
  assert.equal(cli(repo, 'rev-parse', 'HEAD'), cli(source, 'rev-parse', 'HEAD'));
});
