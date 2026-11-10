import type { ChatMessage, RequestTrace } from '../../types/chat-types';
import type { RequestTracePlacement } from './request-trace-turns';

export type ConversationTraceItem = {
  id: string;
  kind: 'input' | 'model' | 'decision' | 'assistant' | 'tool';
  label: string;
  preview: string;
  detail?: string;
  result?: string;
  schema?: RequestTrace['tools'];
  request?: RequestTrace;
  status: 'done' | 'running' | 'error' | 'unknown';
  at?: number;
  endedAt?: number;
  durationMs?: number;
  round?: number;
  step?: number;
};
export type ConversationTraceSummary = {
  steps: number;
  requests: number;
  tools: number;
  errors: number;
  state: 'idle' | 'running' | 'done' | 'error';
  items: ConversationTraceItem[];
};
type Turn = { kind: 'user'; message: ChatMessage } | { kind: 'assistant'; messages: ChatMessage[] };
const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 500);
function messageText(message: ChatMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : block.type === 'image' ? `[图片 · ${block.mimeType}]` : '').filter(Boolean).join('\n');
}

export function buildTraceSummary({ turns, toolResults, requestPlacement, turnActive }: {
  turns: Turn[];
  toolResults: Map<string, ChatMessage>;
  requestPlacement: RequestTracePlacement;
  turnActive: boolean;
}): ConversationTraceSummary {
  const items: ConversationTraceItem[] = [];
  const requests = [...new Map([...requestPlacement.byAssistantTurn.values(), ...requestPlacement.unansweredByUserTurn.values(), requestPlacement.pending].flat().map(trace => [trace.id, trace])).values()].sort((a, b) => a.createdAt - b.createdAt);
  const rounds = new Map<number, number>();
  let round = 0;
  turns.forEach((turn, index) => { if (turn.kind === 'user') round++; rounds.set(index, round); });
  const requestRounds = new Map<string, number>();
  for (const [index, traces] of [...requestPlacement.byAssistantTurn, ...requestPlacement.unansweredByUserTurn]) {
    traces.forEach(trace => requestRounds.set(trace.id, rounds.get(index) || 1));
  }
  requests.forEach(trace => items.push({
    id: `request:${trace.id}`, kind: 'model', label: '模型调用',
    preview: trace.model ? `${trace.model.provider}/${trace.model.modelId}` : '模型请求',
    detail: `消息 ${trace.stats.messageCount} 条 · ${trace.stats.estimatedChars} 字符 · 工具定义 ${trace.stats.toolDefinitionCount} 个`,
    request: trace, status: turnActive && trace.id === requests.at(-1)?.id ? 'running' : 'done',
    at: trace.createdAt, round: requestRounds.get(trace.id) || round || 1,
  }));
  turns.forEach((turn, turnIndex) => {
    const round = rounds.get(turnIndex) || 1;
    if (turn.kind === 'user') {
      const text = messageText(turn.message);
      items.push({ id: `input:${turn.message.sourceIndex ?? turn.message.timestamp ?? turnIndex}`, kind: 'input', label: '用户', preview: preview(text), detail: text, status: 'done', at: turn.message.timestamp, round });
      return;
    }
    turn.messages.forEach((message, messageIndex) => {
      const messageId = message.sourceIndex ?? message.timestamp ?? `${turnIndex}:${messageIndex}`;
      const status = message.errorMessage ? 'error' : message.streaming ? 'running' : 'done';
      const request = requests.filter(trace => trace.createdAt <= (message.timestamp ?? 0)).at(-1);
      message.content.forEach((block, blockIndex) => {
        if (block.type === 'thinking' || block.type === 'text') {
          const text = block.type === 'thinking' ? block.redacted ? '模型未提供推理正文。' : block.thinking : block.text;
          if (!text.trim()) return;
          items.push({ id: `${block.type}:${messageId}:${blockIndex}`, kind: block.type === 'thinking' ? 'decision' : 'assistant', label: block.type === 'thinking' ? '思考' : '助手', preview: preview(text), detail: text, status, at: message.timestamp, round, request });
        }
        if (block.type === 'toolCall') {
          const result = toolResults.get(block.id);
          const durationMs = result?.durationMs;
          const endedAt = result?.timestamp;
          const detail = JSON.stringify(block.arguments ?? {}, null, 2);
          items.push({
            id: `tool:${block.id}`, kind: 'tool', label: block.namespace ? `${block.namespace}/${block.name}` : block.name,
            preview: preview(JSON.stringify(block.arguments ?? {})), detail,
            result: result ? messageText(result) || (result.details ? JSON.stringify(result.details, null, 2) : '工具已返回，无文本内容。') : undefined,
            request, schema: request?.tools?.filter(tool => tool.name === block.name),
            status: result?.isError ? 'error' : result ? 'done' : turnActive ? 'running' : 'unknown',
            at: endedAt !== undefined && durationMs !== undefined ? endedAt - durationMs : message.timestamp,
            endedAt, durationMs, round,
          });
        }
      });
    });
  });
  items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const steps = new Map<number, number>();
  items.forEach(item => { const round = item.round || 1; item.step = (steps.get(round) || 0) + 1; steps.set(round, item.step); });
  const errors = items.filter(item => item.status === 'error').length;
  return { steps: items.length, requests: requests.length, tools: items.filter(item => item.kind === 'tool').length, errors, state: !items.length ? 'idle' : turnActive ? 'running' : errors ? 'error' : 'done', items };
}
