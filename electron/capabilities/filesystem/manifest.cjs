module.exports = Object.freeze([
  {
id: 'studio-filesystem-tools',
    tier: 'system',
    name: 'Studio 文件搜索',
    version: '1.0.0',
    description: 'Studio 提供的 ls、find、grep 只读工作区工具。',
    runtimeName: 'studio-filesystem-tools',
    runtimeNames: ['studio-filesystem-tools'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: ['ls', 'find', 'grep'].map((name) => ({ name })),
    }
  },
]);
