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
const { beginTurn, endTurn } = require('../../electron/services/turn-diff.cjs');

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

test('full historical diff uses saved trees, supports whitespace filtering, and rejects missing records', async () => {
  const vm = require('node:vm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-full-'));
  const turns = new Map();
  const database = {
    saveTurnDiff(sessionId, diff) {
      const list = turns.get(sessionId) || [];
      const next = list.filter((item) => item.at !== diff.at);
      next.push(structuredClone(diff));
      turns.set(sessionId, next);
    },
    readTurnDiffs(sessionId) {
      return structuredClone(turns.get(sessionId) || []);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/services/turn-diff.cjs'), 'utf8'), {
    module,
    exports: module.exports,
    process,
    require: name => name === '../core/studio-db.cjs'
      ? { getStudioDatabase: () => database }
      : name === './workspace.cjs'
        ? require('../../electron/services/workspace.cjs')
        : require(name),
  });
  const api = module.exports;
  try {
    git(dir, ['init','-q']);
    const target = path.join(dir,'long.txt');
    const before = Array.from({length:30},(_,i)=>`line ${i}`).join('\n')+'\n';
    fs.writeFileSync(target,before);
    const token = await api.beginTurn(dir);
    fs.writeFileSync(target,before.replace('line 15','changed 15'));
    fs.writeFileSync(path.join(dir,'new.txt'),'new\n');
    const diff = await api.endTurn(token);
    api.saveTurnDiff('test', { at:1,...diff });
    fs.writeFileSync(target,'UNRELATED CURRENT CONTENT');
    const file = diff.files.find(f=>f.label === 'long.txt');
    const full = await api.readTurnDiffFile({sessionId:'test',at:1,path:file.path,full:true});
    assert.match(full.patch,/line 0/); assert.match(full.patch,/line 29/);
    assert.match(full.patch,/\+changed 15/); assert.doesNotMatch(full.patch,/UNRELATED/);
    await assert.rejects(api.readTurnDiffFile({sessionId:'test',at:1,path:'/not-in-turn'}),/找不到/);
    api.saveTurnDiff('legacy',{ at:2, files:diff.files });
    await assert.rejects(api.readTurnDiffFile({sessionId:'legacy',at:2,path:file.path,full:true}),/没有保存完整快照/);
    fs.writeFileSync(target,'hello world\n');
    const whitespace = await api.beginTurn(dir);
    fs.writeFileSync(target,'hello    world\n');
    const whitespaceDiff = await api.endTurn(whitespace);
    api.saveTurnDiff('white',{at:3,...whitespaceDiff});
    const filtered = await api.readTurnDiffFile({sessionId:'white',at:3,path:whitespaceDiff.files[0].path,ignoreWhitespace:true});
    assert.equal(filtered.patch,'');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('absolute file preview is limited to files recorded by that session', async () => {
  const vm = require('node:vm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-preview-'));
  const allowed = path.join(dir, 'allowed.txt');
  const unrelated = path.join(dir, 'unrelated.txt');
  fs.writeFileSync(allowed, 'allowed content\n');
  fs.writeFileSync(unrelated, 'private content\n');
  const turns = new Map([['session-a', [{
    at: 1,
    files: [{ path: fs.realpathSync(allowed), label: 'allowed.txt' }],
  }]]]);
  const database = {
    readTurnDiffs(sessionId) {
      return structuredClone(turns.get(sessionId) || []);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/services/turn-diff.cjs'), 'utf8'), {
    module,
    exports: module.exports,
    process,
    Buffer,
    require: name => name === '../core/studio-db.cjs'
      ? { getStudioDatabase: () => database }
      : name === './workspace.cjs'
        ? require('../../electron/services/workspace.cjs')
        : require(name),
  });
  try {
    const preview = module.exports.readTurnDiffAbsoluteFile({
      sessionId: 'session-a',
      path: allowed,
    });
    assert.equal(preview.text, 'allowed content\n');
    assert.throws(
      () => module.exports.readTurnDiffAbsoluteFile({ sessionId: 'session-a', path: unrelated }),
      /不在当前会话的变更记录中/,
    );
    assert.throws(
      () => module.exports.readTurnDiffAbsoluteFile({ sessionId: 'session-b', path: allowed }),
      /不在当前会话的变更记录中/,
    );
    assert.throws(
      () => module.exports.readTurnDiffAbsoluteFile({ path: allowed }),
      /缺少会话标识/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
