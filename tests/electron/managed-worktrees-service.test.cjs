const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
const {
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');
const {
  applyManagedWorktree,
  cleanupManagedWorktrees,
  completeManagedWorktree,
  createManagedWorktree,
  discardManagedWorktree,
  discardManagedWorktreesForConversations,
  inspectManagedWorktree,
  listManagedWorktrees,
  reactivateManagedWorktree,
} = require('../../electron/capabilities/subagents/index.cjs');

installElectronSafeStorage(test);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-managed-worktrees-'));

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepository(name) {
  const repository = path.join(temporary, name);
  fs.mkdirSync(repository, { recursive: true });
  runGit(repository, ['init']);
  runGit(repository, ['config', 'user.name', 'Pi Studio Test']);
  runGit(repository, ['config', 'user.email', 'test@pi-studio.invalid']);
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(repository, 'untouched.txt'), 'untouched\n');
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '-m', 'initial']);
  return repository;
}

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('concurrent creation respects capacity and repeated IDs reuse one tree', async () => {
  const repository = createRepository('concurrent');
  const userDataPath = path.join(temporary, 'user-data-concurrent');
  const database = createStudioDatabase(path.join(userDataPath, 'studio.sqlite'));
  const options = { database, userDataPath };
  const input = { id: 'concurrent-a', parentConversationId: '1', workspace: repository, limit: 1 };
  try {
    const [a, b] = await Promise.all([createManagedWorktree(input, options), createManagedWorktree(input, options)]);
    assert.equal(a.path, b.path);
    const results = await Promise.allSettled([
      createManagedWorktree({ ...input, id: 'concurrent-b' }, options),
      createManagedWorktree({ ...input, id: 'concurrent-c' }, options),
    ]);
    assert.ok(results.every((result) => result.status === 'rejected' && /待处理工作树/.test(result.reason.message)));
    assert.equal(database.listManagedWorktrees().length, 1);
  } finally { database.close(); }
});

test('public conversation ownership cleans up correctly and unusual filenames stay intact', async () => {
  const repository = createRepository('public-owner');
  const userDataPath = path.join(temporary, 'user-data-owner');
  const database = createStudioDatabase(path.join(userDataPath, 'studio.sqlite'));
  const options = { database, userDataPath };
  try {
    const owner = database.insertConversation({ id: '200', kind: 'conversation', workspace: repository });
    const record = await createManagedWorktree({ id: 'public-owned', parentConversationId: owner.publicId, workspace: repository }, options);
    const filename = '中文\twith\nnewline.txt';
    fs.writeFileSync(path.join(record.path, filename), 'content\n');
    const detail = await inspectManagedWorktree(record.id, options);
    assert.equal(detail.files[0].path, filename);
    assert.equal(detail.files[0].status, 'added');
    const cleaned = await discardManagedWorktreesForConversations([200], { force: true }, options);
    assert.equal(cleaned.removed, 1);
    assert.equal(fs.existsSync(record.path), false);
    assert.equal(database.getManagedWorktree(record.id), undefined);
  } finally { database.close(); }
});

test('worktree lifecycle uses a temporary index and applies without staging user files', async () => {
  const repository = createRepository('apply');
  const userDataPath = path.join(temporary, 'user-data-apply');
  const database = createStudioDatabase(path.join(userDataPath, 'studio.sqlite'));
  const serviceOptions = { database, userDataPath };
  try {
    const created = await createManagedWorktree({
      id: 'parent-1:task-1',
      parentConversationId: 'parent-1',
      childConversationId: 'child-1',
      name: 'fix parser',
      workspace: repository,
    }, serviceOptions);
    assert.equal(created.status, 'active');
    assert.equal(created.repositoryRoot, fs.realpathSync(repository));
    assert.ok(fs.existsSync(path.join(created.path, 'tracked.txt')));

    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'isolated\n');
    fs.writeFileSync(path.join(created.path, 'new-file.txt'), 'created by child\n');
    const finished = await completeManagedWorktree(created.id, {
      status: 'finished',
    }, serviceOptions);
    assert.equal(finished.status, 'finished');

    const detail = await inspectManagedWorktree(created.id, serviceOptions);
    assert.equal(detail.changed, true);
    assert.equal(detail.changedFiles, 2);
    assert.match(detail.patch, /new-file\.txt/);

    const applied = await applyManagedWorktree(created.id, serviceOptions);
    assert.equal(applied.changedFiles, 2);
    assert.equal(fs.readFileSync(path.join(repository, 'tracked.txt'), 'utf8'), 'isolated\n');
    assert.equal(fs.readFileSync(path.join(repository, 'new-file.txt'), 'utf8'), 'created by child\n');
    assert.equal(runGit(repository, ['diff', '--cached', '--name-only']), '');
    assert.equal(database.getManagedWorktree(created.id).status, 'applied');
    assert.equal(fs.existsSync(created.path), false);
    await assert.rejects(reactivateManagedWorktree(created.id, serviceOptions), /已被处理/);
  } finally {
    database.close();
  }
});

test('unchanged child worktrees are reclaimed automatically', async () => {
  const repository = createRepository('unchanged');
  const userDataPath = path.join(temporary, 'user-data-unchanged');
  const database = createStudioDatabase(path.join(userDataPath, 'studio.sqlite'));
  const serviceOptions = { database, userDataPath };
  try {
    const created = await createManagedWorktree({
      id: 'parent-2:task-1',
      parentConversationId: 'parent-2',
      name: 'inspect',
      workspace: repository,
    }, serviceOptions);
    const completed = await completeManagedWorktree(created.id, {
      status: 'finished',
    }, serviceOptions);
    assert.equal(completed.status, 'removed');
    assert.equal(fs.existsSync(created.path), false);
    assert.equal((await listManagedWorktrees({}, serviceOptions)).length, 0);
  } finally {
    database.close();
  }
});

test('apply conflicts preserve the finished worktree for retry or discard', async () => {
  const repository = createRepository('conflict');
  const userDataPath = path.join(temporary, 'user-data-conflict');
  const database = createStudioDatabase(path.join(userDataPath, 'studio.sqlite'));
  const serviceOptions = { database, userDataPath };
  try {
    const created = await createManagedWorktree({
      id: 'parent-3:task-1',
      parentConversationId: 'parent-3',
      name: 'conflict',
      workspace: repository,
    }, serviceOptions);
    fs.writeFileSync(path.join(created.path, 'tracked.txt'), 'child version\n');
    await completeManagedWorktree(created.id, { status: 'finished' }, serviceOptions);
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'user version\n');

    await assert.rejects(
      () => applyManagedWorktree(created.id, serviceOptions),
      /无法应用工作树改动/,
    );
    assert.equal(database.getManagedWorktree(created.id).status, 'finished');
    assert.equal(fs.existsSync(created.path), true);

    const discarded = await discardManagedWorktree(created.id, {}, serviceOptions);
    assert.equal(discarded.ok, true);
    assert.equal(database.getManagedWorktree(created.id).status, 'discarded');
    assert.equal(fs.existsSync(created.path), false);
  } finally {
    database.close();
  }
});

test('startup cleanup removes orphan directories below the managed root', async () => {
  const repository = createRepository('cleanup');
  const userDataPath = path.join(temporary, 'user-data-cleanup');
  const database = createStudioDatabase(path.join(userDataPath, 'studio.sqlite'));
  const serviceOptions = { database, userDataPath };
  try {
    const created = await createManagedWorktree({
      id: 'parent-4:task-1',
      parentConversationId: 'parent-4',
      name: 'cleanup',
      workspace: repository,
    }, serviceOptions);
    const orphan = path.join(path.dirname(created.path), 'orphan-directory');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'orphan.txt'), 'orphan');
    fs.rmSync(created.path, { recursive: true, force: true });

    const result = await cleanupManagedWorktrees(serviceOptions);
    assert.ok(result.removed >= 1);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(runGit(repository, ['worktree', 'list', '--porcelain']).includes(created.path), false);
  } finally {
    database.close();
  }
});
