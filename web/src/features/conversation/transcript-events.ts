import type { ChatMessage, RequestTrace } from '../../types/chat-types';

export type StreamMessageType = 'message_start' | 'message_update' | 'message_end';

/**
 * 把一条流式消息合并进列表。
 * 同角色 + 同 timestamp 视为同一条消息；message_start 会先结束上一段
 * 仍在流式的助手消息，避免多个气泡同时出现。
 */
export function mergeStreamMessage(current: ChatMessage[], incoming: ChatMessage, type: StreamMessageType): ChatMessage[] {
  const copy = [...current];
  if (incoming.role === 'assistant' && type === 'message_start') {
    for (let index = 0; index < copy.length; index += 1) {
      if (copy[index].streaming) copy[index] = { ...copy[index], streaming: false };
    }
  }
  const streaming = incoming.role === 'assistant' && type !== 'message_end';
  const next = { ...incoming, ...(streaming ? { streaming: true } : { streaming: false }) };
  // 并行工具结果会共享同一个时间戳；toolResult 必须按 toolCallId 合并，
  // 否则后一个结果会覆盖前一个，另一条工具调用永远停在「执行中」。
  let index = copy.findIndex((message) => incoming.role === 'toolResult' && incoming.toolCallId
    ? message.role === 'toolResult' && message.toolCallId === incoming.toolCallId
    : message.role === incoming.role && message.timestamp === incoming.timestamp);
  if (index < 0 && incoming.role === 'assistant' && type !== 'message_start') {
    index = copy.findIndex((message) => message.role === 'assistant' && message.streaming);
  }
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return copy;
}

export function mergeRequestTrace(current: RequestTrace[], incoming: RequestTrace): RequestTrace[] {
  const next = current.filter((trace) => trace.requestId !== incoming.requestId);
  next.push(incoming);
  next.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  return next.slice(-48);
}
