module.exports = Object.freeze([
  {
    id: 'durable-coding-tools',
    tier: 'system',
    name: 'Durable 编码工具',
    version: '1.0.0',
    description: 'Pi Durable 官方 read、write、edit、bash 工具；可由用户扩展补充或覆盖。',
    runtimeName: 'coding-tools',
    runtimeNames: ['coding-tools'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: ['read', 'write', 'edit', 'bash'].map((name) => ({ name })),
    }
  },
]);
