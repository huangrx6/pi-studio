import type { ConversationTraceItem } from './trace-model';

export const kindLabels = { input: '用户', model: '模型', decision: '思考', assistant: '助手', tool: '工具' };
export const statusLabels = { done: '已完成', running: '执行中', error: '异常', unknown: '结果未记录' };
export const lane = (item: ConversationTraceItem) => item.kind === 'input' ? 'input' : item.kind === 'tool' ? 'tool' : 'model';
export function timeLabel(at?: number) {
  return at === undefined ? '未记录' : new Date(at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}
export function durationLabel(ms?: number) {
  if (ms === undefined) return '未记录';
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(2)} 秒`;
}
