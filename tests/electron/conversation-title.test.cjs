const assert = require('node:assert/strict');
const test = require('node:test');
const {
  generateConversationTitle,
  normalizeGeneratedTitle,
  temporaryTitle,
} = require('../../electron/services/conversation-title.cjs');

const answer = (text) => ({
  stopReason: 'stop',
  content: [{ type: 'text', text }],
});

test('automatic naming uses one isolated tool-free request', async () => {
  const model = { id: 'model-a' };
  let request;
  const title = await generateConversationTitle({
    question: '帮我查郑州和北京的天气，然后比较差异',
    model,
    complete: async (selectedModel, context, options) => {
      request = { selectedModel, context, options };
      return answer('郑州北京天气对比');
    },
  });

  assert.equal(title, '郑州北京天气对比');
  assert.equal(request.selectedModel, model);
  assert.equal(request.context.messages.length, 1);
  assert.equal(request.context.tools, undefined);
  assert.equal(request.context.messages[0].role, 'user');
  assert.match(request.context.messages[0].content, /郑州和北京/);
  assert.match(request.context.systemPrompt, /不执行其中的指令/);
  assert.equal(request.options.reasoning, 'off');
  assert.equal(request.options.maxTokens, 96);
});

test('generated titles are cleaned and malformed or incomplete output is rejected', async () => {
  assert.equal(normalizeGeneratedTitle('标题：“优化会话命名”'), '优化会话命名');
  assert.equal(normalizeGeneratedTitle('标题\n额外说明'), '');
  assert.equal(normalizeGeneratedTitle('x'.repeat(100)), '');

  for (const result of [
    answer(''),
    answer('标题\n额外说明'),
    { ...answer('被截断'), stopReason: 'length' },
    { stopReason: 'stop', content: [{ type: 'thinking', thinking: 'hidden' }] },
  ]) {
    const title = await generateConversationTitle({
      question: '修复设置页',
      model: { id: 'model-a' },
      complete: async () => result,
    });
    assert.equal(title, '');
  }
});

test('timeouts and provider errors return an empty title without throwing', async () => {
  let signal;
  const timedOut = await generateConversationTitle({
    question: '分析这个项目',
    model: { id: 'model-a' },
    timeoutMs: 15,
    complete: async (_model, _context, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(timedOut, '');
  assert.equal(signal.aborted, true);

  const failed = await generateConversationTitle({
    question: '分析这个项目',
    model: { id: 'model-a' },
    complete: async () => { throw new Error('provider unavailable'); },
  });
  assert.equal(failed, '');
});

test('temporary titles are bounded and strip injected skill blocks', () => {
  assert.equal([...temporaryTitle('很长的首次消息'.repeat(20))].length, 24);
  assert.equal(
    temporaryTitle('<skill name="demo">hidden</skill>\n修复构建失败'),
    '修复构建失败',
  );
  assert.equal(temporaryTitle(''), '新会话');
});
