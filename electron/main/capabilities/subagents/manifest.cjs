const { builtinToolContributions } = require('../../core/builtin-tool-contributions.cjs');

module.exports = Object.freeze([
  {
id: 'studio-subagents',
    tier: 'system',
    name: 'Studio 子智能体',
    version: '2.0.0',
    description: '使用 Durable owned conversation、background anchor 与 reporter 管理前台和后台子智能体。',
    runtimeName: 'studio-subagents',
    runtimeNames: ['studio-subagents'],
    permissions: ['agent.tools', 'agent.sections', 'agent.tasks'],
    requires: ['builtin:studio-permissions', 'builtin:studio-subagent-channel'],
    contributes: {
      tools: builtinToolContributions(['subagent', 'subagent_stop', 'bg_wait', 'subagent_supervisor']),
    }
  },
  {
id: 'studio-subagent-channel',
    tier: 'system',
    name: 'Studio 子智能体监督通道',
    version: '1.0.0',
    description: '仅由 Studio 子智能体使用的父级联系通道；父智能体默认看不到这个 child 工具。',
    runtimeName: 'studio-subagent-channel',
    runtimeNames: ['studio-subagent-channel'],
    permissions: ['agent.tools', 'agent.tasks', 'agent.hooks', 'agent.sections'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: builtinToolContributions(['contact_supervisor']),
    }
  },
]);
