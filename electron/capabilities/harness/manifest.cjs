module.exports = Object.freeze([
  {
id: 'studio-harness',
    tier: 'system',
    name: 'Studio 编码 Harness',
    version: '1.0.0',
    description: '可检查、可覆盖的编码 Agent 系统提示词、AGENTS.md、项目文档和附加指令。',
    runtimeName: 'studio-harness',
    runtimeNames: ['studio-harness'],
    permissions: ['agent.sections'],
    requires: ['builtin:durable-coding-tools'],
    contributes: {}
  },
]);
