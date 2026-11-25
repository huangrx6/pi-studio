import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTurnContent } from '../../web/src/features/conversation/turn-content.ts';
import { buildTurnProgress, progressEntryLabel } from '../../web/src/features/conversation/turn-progress.ts';

const text = value => ({ type: 'text', text: value });
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const result = (id, content, isError = false) => [id, { role: 'toolResult', toolCallId: id, content, isError }];
function turn(content, results = new Map(), live = true, retry) {
  const built = buildTurnContent([{ role: 'assistant', content }], results, live);
  return buildTurnProgress(built, results, live, retry);
}

test('one current action follows outstanding parallel calls even if they finish out of order', () => {
  const content = [text('已经复现。'), call('a', 'read', { path: 'src/layout.css' }), call('b', 'bash', { command: 'pnpm test' })];
  const results = new Map();
  assert.equal(turn(content, results).action, '正在读取 layout.css（另有 1 项进行中）');
  results.set(...result('b', [text('done')]));
  assert.equal(turn(content, results).action, '正在读取 layout.css');
  assert.match(turn(content, results, true, { attempt: 2, maxAttempts: 4 }).action, /重试请求（2\/4）/);
  results.set(...result('a', [text('content')]));
  assert.doesNotMatch(turn(content, results).action, /正在|测试通过/);
  assert.equal(turn([...content, text('我找到了原因。')], results).action, '');
});

test('keeps output images and failures attached to their own calls after completion', () => {
  const shot = { type: 'image', mimeType: 'image/png', data: 'AQID' };
  const content = [call('first', 'bash', { command: 'pnpm test' }), text('换一种方式验证。'),
    call('shot', 'browser_screenshot', {}), call('missing', 'read', { path: 'pending.ts' })];
  const results = new Map([result('shot', [shot]), result('first', [text('error')], true)]);
  const { entries, images, failed, action } = turn(content, results, false);
  assert.deepEqual(entries.map(entry => entry.call.id), ['first', 'shot', 'missing']);
  assert.deepEqual([...images.keys()], ['shot']);
  assert.equal(images.get('shot')[0].src, 'data:image/png;base64,AQID');
  assert.equal(failed, 1);
  assert.equal(action, '');
});

test('ordinary prose and hidden thinking never turn into fabricated milestones', () => {
  assert.equal(turn([text('回答正文')]).action, '');
  assert.equal(turn([]).action, '正在准备回复');
  const progress = turn([{ type: 'thinking', thinking: 'hidden', redacted: true }]);
  assert.equal(progress.action, '正在思考');
  assert.equal(progressEntryLabel(progress.entries[0]), '思考');
  assert.equal(turn([call('input', 'browser_type', { text: 'private value' })]).action, '正在填写网页表单');
});
