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
          id: 'metrics-chip',
          title: '实时指标',
          description: '生成速率、首包耗时和运行阶段。',
          slots: ['status.chip', 'composer.above', 'composer.below'],
          icon: 'activity',
          color: 'info',
          size: 'compact',
          priority: 20,
          details: 'metrics-detail',
          // 固定在会话上的摘要随回合显示，弹框卡片也显示最近请求的读数。
          visibility: 'while-active',
          content: [{
            kind: 'dataView',
            sourceId: METRICS_FOOTER_SOURCE_ID,
            emptyText: '等待首次模型请求',
          }],
        },
        {
          id: 'metrics-detail',
          title: '实时指标',
          description: '当前会话的模型请求和 Durable 任务指标。',
          slot: 'panel.side',
          icon: 'activity',
          color: 'info',
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
          description: '扩展卡片和会话摘要使用的紧凑指标。',
        },
      ],
    },
  },
]);
