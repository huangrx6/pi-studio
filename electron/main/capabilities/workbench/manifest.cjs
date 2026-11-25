const { builtinToolContributions } = require('../../core/builtin-tool-contributions.cjs');

module.exports = Object.freeze([
  {
    id: 'studio-workbench-tools',
    tier: 'system',
    name: 'Studio 工作台刷新',
    version: '1.0.0',
    description: '通知 Pi Studio 工作台重新读取已打开的插件视图、文件树、预览、Git 与会话列表。',
    runtimeName: 'studio-workbench-tools',
    runtimeNames: ['studio-workbench-tools'],
    permissions: ['agent.tools'],
    contributes: {
      tools: builtinToolContributions(['workbench_refresh']),
    },
  },
]);
