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
    await gitWrite(repo, { branch, head, indexVersion, kind, ...params });
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
  assert.deepEqual(await read('history'), { rows: [], more: false });
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
