const { builtinToolContributions } = require('../../core/builtin-tool-contributions.cjs');

module.exports = Object.freeze([
  {
id: 'studio-todo',
    tier: 'system',
    name: 'Studio 任务计划',
    version: '1.0.0',
    description: '为多步骤工作创建可恢复的任务计划，并在对话输入框上方持续显示进度。',
    runtimeName: 'studio-todo',
    runtimeNames: ['studio-todo'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: builtinToolContributions(['todo']),
    }
  },
]);
