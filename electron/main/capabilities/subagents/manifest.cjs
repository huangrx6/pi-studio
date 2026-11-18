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
      tools: [
        { name: 'subagent', description: '运行、启动、发消息或查看拥有独立上下文的子智能体。' },
        { name: 'subagent_stop', description: '停止指定后台子智能体的当前运行。' },
        { name: 'bg_wait', description: '等待自己的后台 reporter，超时不会停止子智能体。' },
        { name: 'subagent_supervisor', description: '查看或回复子智能体发来的监督请求。' },
      ],
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
    permissions: ['agent.tools', 'agent.tasks', 'agent.hooks'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{ name: 'contact_supervisor', description: '向创建此子智能体的主智能体发起异步确认请求。' }],
    }
  },
]);
