const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mergeSubagentSettings,
  normalizeConfig,
} = require('../electron/services/subagent-settings.cjs');

test('subagent settings preserve unrelated Pi and extension fields', () => {
  const source = {
    theme: 'light',
    enabledModels: ['demo/model'],
    subagents: {
      defaultModel: 'old/model',
      maxThinking: 'max',
      disableBuiltins: true,
      agentOverrides: {
        worker: {
          model: 'old/worker',
          thinking: 'low',
          tools: ['read', 'edit'],
          systemPrompt: 'Keep this',
        },
        reviewer: { thinking: 'max', skills: ['security'] },
      },
    },
  };
  const result = mergeSubagentSettings(source, {
    defaultModel: 'new/model',
    defaultThinking: 'medium',
    maxThinking: '',
    agentOverrides: {
      worker: { model: 'new/worker', thinking: 'high' },
      reviewer: { model: '', thinking: '' },
    },
  });
  assert.equal(result.theme, 'light');
  assert.deepEqual(result.enabledModels, ['demo/model']);
  assert.equal(result.subagents.disableBuiltins, true);
  assert.equal(result.subagents.defaultModel, 'new/model');
  assert.equal(result.subagents.defaultThinking, 'medium');
  assert.equal(result.subagents.maxThinking, undefined);
  assert.deepEqual(result.subagents.agentOverrides.worker.tools, ['read', 'edit']);
  assert.equal(result.subagents.agentOverrides.worker.systemPrompt, 'Keep this');
  assert.equal(result.subagents.agentOverrides.worker.model, 'new/worker');
  assert.equal(result.subagents.agentOverrides.worker.thinking, 'high');
  assert.deepEqual(result.subagents.agentOverrides.reviewer, { skills: ['security'] });
  assert.equal(source.subagents.defaultModel, 'old/model');
  assert.equal(
    mergeSubagentSettings({}, { agentOverrides: { scout: { thinking: 'off' } } }).subagents.agentOverrides.scout.thinking,
    false,
  );
});

test('subagent config normalization rejects unsupported thinking and preserves inherit', () => {
  assert.deepEqual(normalizeConfig({
    defaultModel: ' inherit ',
    defaultThinking: 'turbo',
    maxThinking: 'high',
    agentOverrides: {
      scout: { model: 'fast/model', thinking: false },
      empty: { disabled: true },
    },
  }), {
    defaultModel: 'inherit',
    defaultProvider: '',
    defaultThinking: '',
    maxThinking: 'high',
    agentOverrides: { scout: { model: 'fast/model', thinking: 'off' } },
  });
});

test('subagent config normalization ignores prototype-sensitive role names', () => {
  const input = JSON.parse('{"agentOverrides":{"__proto__":{"model":"bad/model"},"safe":{"thinking":false}}}');
  const normalized = normalizeConfig(input);
  assert.deepEqual(normalized.agentOverrides, { safe: { thinking: 'off' } });
  assert.equal(Object.hasOwn(normalized.agentOverrides, '__proto__'), false);
});
