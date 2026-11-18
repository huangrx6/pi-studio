module.exports = Object.freeze([
  {
id: 'studio-request-trace',
    tier: 'system',
    name: 'Studio 模型请求轨迹',
    version: '1.0.0',
    description: '捕获 Pi Durable 实际发送给模型的提示词、上下文消息、模型参数与工具定义，并显示在对话轨迹中。',
    runtimeName: 'studio-request-trace',
    runtimeNames: ['studio-request-trace'],
    permissions: ['agent.sections', 'agent.hooks'],
    requires: [],
    contributes: {}
  },
]);
