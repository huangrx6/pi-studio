import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFileChanges } from '../../web/src/features/conversation/file-changes.ts';
const call = (id, name, path) => ({ type: 'toolCall', id, name, arguments: { path } });
const message = content => ({ role: 'assistant', content });
const result = (id, details, isError = false) => [id, { role: 'toolResult', toolCallId: id, content: [], details, isError }];
test('only confirmed successful mutations enter the file summary', () => {
  const messages = [message([call('read', 'read', 'a.ts'), call('ls', 'ls', '.'), call('pending', 'edit', 'b.ts'), call('failed', 'write', 'c.ts'), call('ok', 'edit', 'd.ts')])];
  const results = new Map([result('read'), result('ls'), result('failed', undefined, true), result('ok', { patch: '--- a/d.ts\n+++ b/d.ts\n@@ -1 +1 @@\n-old\n+new' })]);
  const files = collectFileChanges(messages, results, '/project');
  assert.equal(files.length, 1); assert.equal(files[0].label, 'd.ts');
  assert.equal(files[0].added, 1); assert.equal(files[0].removed, 1);
});
test('same file is grouped, duplicate calls excluded, and unknown write deltas stay unknown', () => {
  const edit = call('edit', 'edit', './src/a.ts');
  const write = call('write', 'write', '/project/src/a.ts'); write.arguments.content = 'replacement\n';
  const files = collectFileChanges([message([edit, edit, write])], new Map([result('edit', {diff:'-1 old\n+1 new'}), result('write')]), '/project');
  assert.equal(files.length, 1); assert.equal(files[0].operations.length, 2);
  assert.equal(files[0].completeCounts, false); assert.equal(files[0].operations[1].content, 'replacement\n');
});
test('unified diff headers are excluded but plus-prefixed source lines still count', () => {
  const files = collectFileChanges([message([call('a','edit','a.ts')])],new Map([result('a',{patch:'--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n---value\n+++value'})]));
  assert.equal(files[0].added,1); assert.equal(files[0].removed,1);
});

test('turn diffs match by answer timestamp, and legacy end-of-run stamps fall back to the turn window', async () => {
  const { findTurnDiff } = await import('../../web/src/features/conversation/file-changes.ts');
  const diff = (at) => ({ at, files: [], totalAdded: 0, totalRemoved: 0 });

  // 新数据：diff.at 就是本轮最后一条助手消息的 timestamp。
  assert.equal(findTurnDiff([diff(500)], { from: 500, until: 900 })?.at, 500);
  // 旧数据：at 比消息晚几十秒，但仍在「下一条用户消息」之前。
  assert.equal(findTurnDiff([diff(530)], { from: 500, until: 900 })?.at, 530);
  // 下一轮的 diff 不能挂到这一轮上。
  assert.equal(findTurnDiff([diff(950)], { from: 500, until: 900 }), undefined);
  // 同一窗口内取最早的一条。
  assert.equal(findTurnDiff([diff(560), diff(520)], { from: 500, until: 900 })?.at, 520);
  // 缺少时间戳或没有 diff 时不匹配。
  assert.equal(findTurnDiff([diff(520)], {}), undefined);
  assert.equal(findTurnDiff(undefined, { from: 500, until: 900 }), undefined);
});
