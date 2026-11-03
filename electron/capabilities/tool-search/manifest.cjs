module.exports = Object.freeze([
  {
id: 'studio-tool-search',
    tier: 'system',
    name: 'MCP 工具发现',
    version: '1.0.0',
    description: '使用 Pi 官方 tool_search 按需发现 deferred MCP 工具；加载结果从下一次模型请求起可用。',
    runtimeName: 'tool-search',
    runtimeNames: ['tool-search'],
    permissions: ['agent.tools'],
    requires: ['builtin:studio-permissions'],
    contributes: {
      tools: [{ name: 'tool_search', description: '搜索并按需加载 deferred 工具。' }],
    }
  },
]);
