const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStudioDatabase } = require('../../electron/main/core/studio-db.cjs');
const { describeWorkspaceTrees } = require('../../electron/main/services/workspace-tree-directory.cjs');

test('only registered checkout roots are grouped; a removed checkout keeps its own identity after restart', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sidebar-projects-')));
  const dbPath = path.join(directory, 'studio.sqlite');
  let db = createStudioDatabase(dbPath);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const main = path.join(directory, 'project');
  const linked = path.join(directory, 'issue');
  const child = path.join(main, 'inside');
  const plain = path.join(directory, 'notes');
  for (const cwd of [main, child, plain]) fs.mkdirSync(cwd);
  function git(...args) { execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' }); }
  git('init', '-b', 'trunk');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
  git('worktree', 'add', '-b', 'fix/issue', linked);
  const workspaces = [main, linked, child, plain].map(cwd => db.upsertWorkspace({ cwd }));
  const rows = await describeWorkspaceTrees(workspaces, db);
  assert.deepEqual(rows[0].worktree, { projectRoot: main, main: true, branch: 'trunk', detached: false });
  assert.deepEqual(rows[1].worktree, { projectRoot: main, main: false, branch: 'fix/issue', detached: false });
  assert.equal(rows[2].worktree, undefined);
  assert.equal(rows[3].worktree, undefined);
  git('worktree', 'remove', linked);
  db.close();
  db = createStudioDatabase(dbPath);
  const removed = (await describeWorkspaceTrees(workspaces, db))[1];
  assert.deepEqual(removed.worktree, rows[1].worktree);
  assert.equal(removed.cwd, linked);
  assert.equal(removed.missing, true);
  assert.equal(db.listWorkspaces().length, workspaces.length);
});
