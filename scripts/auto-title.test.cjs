const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAutoTitleGenerator, normalizeGeneratedTitle, temporaryTitle } = require('../electron/services/auto-title.cjs');
function fixture(timeoutMs) {
  const metadata = {};
  let notifications = 0;
  const generator = createAutoTitleGenerator({
    readMetadata: id => metadata[id] || {},
    updateMetadata: (id, patch) => metadata[id] = { ...metadata[id], ...patch },
    notify: () => notifications++, timeoutMs,
  });
  return { metadata, generate: generator.generate, notifications: () => notifications };
}
const input = { id: 'chat', firstMessage: '帮我优化轨迹的展示，正在思考的内容不要藏起来', reply: '已将当前输出单独展示，并简化历史步骤。', model: { id: 'selected-model' } };
const answer = title => ({ stopReason: 'stop', content: [{ type: 'text', text: title }] });
test('one short isolated request names a conversation, without tools or transcript mutation', async () => {
  const f = fixture(); let calls = 0;
  const complete = async (model, context, options) => {
    calls++; assert.equal(model.id, input.model.id); assert.equal(context.tools, undefined);
    assert.equal(context.messages.length, 1); assert.equal(options.maxTokens, 512);
    assert.ok(context.messages[0].content.includes(input.firstMessage));
    return answer('优化轨迹与实时思考展示');
  };
  await f.generate({ ...input, complete });
  await f.generate({ ...input, complete });
  assert.equal(calls, 1); assert.equal(f.metadata.chat.autoTitle, '优化轨迹与实时思考展示'); assert.equal(f.notifications(), 1);
});
test('manual names before or during generation always win, and duplicate work is coalesced', async () => {
  const f = fixture(); let finish;
  const complete = () => new Promise(resolve => finish = resolve);
  const first = f.generate({ ...input, complete });
  assert.equal(f.generate({ ...input, complete }), first);
  f.metadata.chat.name = '我的名字';
  finish(answer('模型的名字')); await first;
  assert.equal(f.metadata.chat.autoTitle, undefined); assert.equal(f.notifications(), 0);
  await f.generate({ ...input, complete: () => assert.fail('must not call') });
  await f.generate({ ...input, id: 'fork', hasExplicitName: () => true, complete: () => assert.fail('must not call') });
});
test('timeout aborts the request and keeps fallback; failed requests are not repeated', async () => {
  const f = fixture(10); let signal;
  await f.generate({ ...input, complete: (_model, _context, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(signal.aborted, true); assert.equal(f.metadata.chat.autoTitle, undefined);
  await f.generate({ ...input, complete: () => assert.fail('must not retry automatically') });
});
test('errors, thinking-only and malformed output never become a title', async () => {
  for (const result of [answer(''), answer('标题\n这是说明'), { ...answer('截断标题'), stopReason: 'length' }, {stopReason:'stop', content:[{type:'thinking',thinking:'private'}]}]) {
    const f = fixture(); await f.generate({ ...input, complete: async () => result });
    assert.equal(f.metadata.chat.autoTitle, undefined);
  }
  const f = fixture(); await f.generate({ ...input, complete: async () => {throw new Error('provider unavailable');} });
  assert.equal(f.metadata.chat.autoTitle, undefined);
});
test('fallback and generated titles have bounded readable lengths, preserving manual names elsewhere', () => {
  assert.equal(normalizeGeneratedTitle('标题：“优化会话命名”'), '优化会话命名');
  assert.equal(normalizeGeneratedTitle('x'.repeat(100)), '');
  assert.equal([...temporaryTitle('很长的首次消息'.repeat(20))].length, 24);
  assert.equal(temporaryTitle('<skill name="demo">hidden</skill>\n修复构建失败'), '修复构建失败');
});
