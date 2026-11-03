const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installElectronSafeStorage } = require('./helpers/electron-safe-storage.cjs');
const {
  SCHEMA_VERSION,
  createStudioDatabase,
} = require('../../electron/core/studio-db.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-studio-worktrees-'));
installElectronSafeStorage(test);

test.after(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('schema 16 persists managed worktree lifecycle metadata', () => {
  const database = createStudioDatabase(path.join(temporary, 'studio.sqlite'));
  try {
    assert.equal(
      database.db.prepare('PRAGMA user_version').get().user_version,
      SCHEMA_VERSION,
    );
    const created = database.insertManagedWorktree({
      id: 'worktree-1',
      parentConversationId: 'parent-1',
      childConversationId: 'child-1',
      name: 'fix-parser',
      workspace: '/workspace/project',
      repositoryRoot: '/workspace/project',
      path: '/user-data/worktrees/project/fix-parser',
      baseCommit: 'abc123',
      status: 'active',
    });
    assert.equal(created.status, 'active');
    assert.equal(created.childConversationId, 'child-1');

    const finished = database.updateManagedWorktree('worktree-1', {
      status: 'finished',
      finishedAt: 1234,
      error: '',
    });
    assert.equal(finished.status, 'finished');
    assert.equal(finished.finishedAt, 1234);
    assert.equal(database.listManagedWorktrees().length, 1);

    database.updateManagedWorktree('worktree-1', { status: 'discarded' });
    assert.equal(database.listManagedWorktrees().length, 0);
    assert.equal(
      database.listManagedWorktrees({ includeTerminal: true })[0].status,
      'discarded',
    );
  } finally {
    database.close();
  }
});
