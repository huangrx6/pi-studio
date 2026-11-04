const {
  METRICS_FOOTER_SOURCE_ID,
  METRICS_SOURCE_ID,
} = require('./runtime.cjs');

module.exports = Object.freeze([
  {
id: 'studio-metrics',
    tier: 'optional',
    name: 'Studio 指标',
    version: '1.0.0',
    description: '通过 Pi 官方遥测实时展示 TPS、TTFT、请求耗时、Token、缓存命中率、成本与任务阶段。',
    runtimeName: 'studio-metrics',
    runtimeNames: ['studio-metrics'],
    permissions: ['ui.panels', 'ui.data'],
    requires: [],
    contributes: {
      panels: [
        {
          id: 'metrics-detail',
          title: '实时指标',
          description: '当前会话的模型请求和 Durable 任务指标。',
          slot: 'conversation.detail',
          size: 'regular',
          content: [{
            kind: 'dataView',
            sourceId: METRICS_SOURCE_ID,
            emptyText: '暂无指标数据',
            fallback: [{
              kind: 'emptyState',
              title: '等待首次运行',
              text: '发送消息后显示 TPS、TTFT、Token、缓存命中率、成本与任务阶段。',
            }],
          }],
        },
        {
          id: 'metrics-footer',
          title: '实时指标摘要',
          description: '当前请求的紧凑状态、TPS、TTFT 与 Token。',
          slot: 'conversation.footer',
          size: 'compact',
          content: [{
            kind: 'dataView',
            sourceId: METRICS_FOOTER_SOURCE_ID,
            emptyText: '暂无指标',
            fallback: [{
              kind: 'text',
              text: '等待首次运行',
            }],
          }],
        },
      ],
      dataSources: [
        {
          id: 'live',
          title: '实时会话指标',
          description: '来自 Pi AI 与 Pi Durable 的无内容遥测。',
        },
        {
          id: 'summary',
          title: '实时会话指标摘要',
          description: '面向会话底部的紧凑实时指标。',
        },
      ],
    },
  },
]);
