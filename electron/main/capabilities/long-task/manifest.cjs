module.exports = Object.freeze([
  {
id: 'studio-long-task',
    tier: 'core',
    name: 'Studio 长期目标',
    version: '1.0.0',
    description: '持久保存长期目标、完成条件与执行状态，并由 Durable GenerationTask 在目标完成或阻塞前持续执行。',
    runtimeName: 'studio-long-task',
    runtimeNames: ['studio-long-task'],
    permissions: ['agent.tools', 'agent.sections', 'agent.hooks'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{
        name: 'long_task',
        description: '记录长期目标的实质进展、已验证完成或阻塞原因。',
      }],
    }
  },
]);
