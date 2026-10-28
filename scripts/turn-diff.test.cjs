/**
 * Git 回合快照的单元测试。
 *
 * 覆盖用户反馈的核心场景：只统计 write/edit 会漏掉 bash 生成的文件；
 * 快照需要同时覆盖命令写入、新建与删除，并给出可展示的 patch。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { beginTurn, endTurn } = require('../electron/services/turn-diff.cjs');

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

test('git snapshot includes bash writes, new files, and deletions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-diff-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'changed.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'deleted.txt'), 'bye\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'init']);

    const token = await beginTurn(dir, 'test-request');
    assert.ok(token);

    fs.writeFileSync(path.join(dir, 'changed.txt'), 'one\ntwo changed\nthree\n');
    fs.writeFileSync(path.join(dir, 'created.txt'), 'created by tool\n');
    fs.rmSync(path.join(dir, 'deleted.txt'));
    // 模拟 bash / 脚本写文件：不经过 write/edit 工具。
    execFileSync('bash', ['-c', `cd '${dir}' && printf 'from bash\\n' > bash.txt`]);

    const diff = await endTurn(token);
    assert.ok(diff);
    const byLabel = new Map(diff.files.map((file) => [file.label, file]));
    assert.deepEqual([...byLabel.keys()].sort(), ['bash.txt', 'changed.txt', 'created.txt', 'deleted.txt']);
    assert.equal(byLabel.get('bash.txt').status, 'added');
    assert.equal(byLabel.get('bash.txt').added, 1);
    assert.equal(byLabel.get('deleted.txt').status, 'deleted');
    assert.equal(byLabel.get('deleted.txt').removed, 1);
    assert.equal(byLabel.get('changed.txt').added, 2);
    assert.equal(byLabel.get('changed.txt').removed, 1);
    assert.match(byLabel.get('bash.txt').patch, /\+from bash/);
    assert.equal(diff.totalAdded, 4);
    assert.equal(diff.totalRemoved, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged turn produces an empty diff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-diff-'));
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'init']);

    const token = await beginTurn(dir, 'no-change');
    const diff = await endTurn(token);
    assert.deepEqual(diff.files, []);
    assert.equal(diff.totalAdded, 0);
    assert.equal(diff.totalRemoved, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
